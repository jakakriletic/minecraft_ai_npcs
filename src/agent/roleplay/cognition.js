// ============================================================================
// Cognitive Controller — ALTERA / PIANO plan, PHASE 2  (see repo-root ALTERA_PLAN.md)
// ============================================================================
//
// WHAT THIS IS
// Altera's PIANO architecture has a central "Cognitive Controller" (CC): it gathers a
// FILTERED view of the agent's state (the "bottleneck"), commits to ONE coherent
// intention, and BROADCASTS it so that speech and action agree. The headline benefit
// is coherence: the agent never says one thing while doing another.
//
// HOW WE IMPLEMENT IT (and a deliberate design choice — read this)
// Our brain.js already makes the ACTION decision through a strict, safety-ordered
// priority loop (chooseAction). That ordering is authoritative and must NOT be
// overridden by an LLM or by "vibes" — survival/combat/player-commands always win.
// So the CC here does NOT re-decide the action. Instead it DERIVES a named intention
// FROM the action the brain actually chose, and owns all autonomous speech. That makes
// speech provably consistent with action (the Altera coherence win) without
// destabilizing the deterministic safety order.
//   - Action-biasing by intention (the optional PIANO feedback where intention nudges
//     the next action) is DEFERRED on purpose. If added later it must sit BELOW the
//     safety/survival tiers in chooseAction. Document it here and in ALTERA_PLAN.md.
//
// HOW IT FITS THE AGENT STATE (ALTERA_PLAN.md §4)
//   input : the chosen brain action, agent._awareness (Phase 1), society + social graph,
//           nearby players. assembleState() gathers + filters these (the bottleneck).
//   output: agent._intention = { topic, speechIntent, socialTarget, label } — broadcast.
//           speakIntention() is the SINGLE gate for autonomous (non-command, non-reply)
//           speech. describeIntention() lets the conversation layer answer "kaj delaš?"
//           from the real current intention.
//
// WIRING (current, all behind settings.cognition.controller_enabled):
//   - brain.js brainTick: after chooseAction picks `act`, calls cognition.tick(agent, act)
//     to set agent._intention and occasionally speak. When the controller is ON, the old
//     autonomous-speech paths (brain maybeAmbient / frustration line, planner plan
//     narration, social.js deterministic chatter) stand down or route through this gate
//     so there is exactly ONE speech source.
//   - narrator.buildRoleplayContext: injects describeIntention(agent) so chat is grounded.
//   - Phase 5 hardening: planner narration is memory-only; autonomous spoken lines
//     flow through speakIntention(), and conversation fallback answers status from here.
//
// ----------------------------------------------------------------------------
// DOCUMENTATION DISCIPLINE (applies to EVERY file in the Altera/PIANO effort)
//   If you change this module: (1) keep these comments true, (2) update ALTERA_PLAN.md
//   §5 (this phase) and §8 (Status table) in the SAME change, (3) keep it deterministic
//   by default — the only LLM calls allowed here are the budget-gated spoken lines
//   behind settings.cognition.llm_speech: generateSpokenLine (autonomous remarks) and
//   generateOwnerReply (owner-command ack flavor). Leave this reminder for the next editor.
// ----------------------------------------------------------------------------

import settings from '../settings.js';
import { getPersonality, pickPhrase } from './personality.js';
import { scenarioContext } from './scenario.js';
import { awarenessSummary } from './awareness.js';
import * as society from '../library/society.js';
import { relationsFor } from './social_graph.js';
import { getSocialModel } from './social_awareness.js'; // ALTERA/PIANO Phase 3 — opinion model of other agents

import { getNorms } from '../library/culture.js'; // ALTERA/PIANO Phase 6 - shared norms

// Minimum gap between two autonomous lines from the controller. Urgent social topics
// (defend/help) may speak sooner; routine topics obey this (override with
// settings.cognition.speak_cooldown_seconds). Keeps 10 bots from chattering.
const SPEAK_COOLDOWN_MS = 5 * 60_000;
const URGENT_SPEAK_COOLDOWN_MS = 20_000;
const URGENT_TOPICS = new Set(['defend', 'help', 'recover']);
const LLM_LINE_TIMEOUT_MS = 8_000;

// ── Action -> intention mapping ─────────────────────────────────────────────
// brain.js action names (and dynamic progression/mining labels) collapse into a small
// set of intention TOPICS. Each topic carries a speechIntent tag that selects a line
// pool below. Keep this in sync with the action names produced in brain.js chooseAction
// / societyAction / focusAction and progression/mining/town modules.
const TOPIC_BY_ACTION = {
    restoreSurvival: 'recover',
    escapeToSurface: 'recover',
    guardianDefense: 'defend',
    defendSociety: 'defend',
    goHome: 'regroup',
    kingdomFarm: 'farm',
    farm: 'farm',
    secureFood: 'food',
    planFood: 'food',
    maintainTools: 'tools',
    tools: 'tools',
    obsoleteGear: 'tidy',
    publicHubGear: 'logistics',
    publicHubRestock: 'logistics',
    publicHubDeposit: 'logistics',
    storage: 'logistics',
    kingdomStorage: 'logistics',
    stash: 'logistics',
    kingdomShare: 'help',
    socialGoal: 'help',   // Phase 4: deliver surplus to a needy member
    socialCheckIn: 'help', // Phase 4: walk over and strengthen a member bond
    socialGift: 'help',   // Phase 4: gift a nearby player to earn standing
    townBuild: 'build',
    build: 'build',
    kingdomRoads: 'build',
    kingdomStockpile: 'gather',
    gatherWood: 'gather',
    gatherStone: 'gather',
    planWood: 'gather',
    planStone: 'gather',
    planWoodSearch: 'gather',
    planStoneSearch: 'gather',
    planIron: 'mine',
    planCoal: 'mine',
    planGold: 'mine',
    planLapis: 'mine',
    kingdomPatrol: 'patrol',
    kingdomGuardianGear: 'patrol',
    smeltStock: 'logistics',
    kingdomEnchanting: 'enchant',
    explore: 'explore',
    idle: 'idle',
    rest: 'idle',
    torches: 'patrol',
};

// Fallback keyword matching for dynamic labels (progression:iron, mining expeditions, …).
function topicForActionName(name) {
    if (!name) return 'idle';
    if (TOPIC_BY_ACTION[name]) return TOPIC_BY_ACTION[name];
    const n = name.toLowerCase();
    if (/iron|coal|gold|lapis|diamond|mine|ore|expedition/.test(n)) return 'mine';
    if (/build|road|town|schematic/.test(n)) return 'build';
    if (/food|farm|wheat|hunt/.test(n)) return 'farm';
    if (/gear|tool|pickaxe|armor|progress/.test(n)) return 'gather';
    if (/defend|guard|protect|combat|patrol/.test(n)) return 'defend';
    if (/stash|storage|restock|deposit|hub/.test(n)) return 'logistics';
    return 'work';
}

// ── Speech pools (English) keyed by topic ───────────────────────────────────
// Deterministic + free. Persona flavor is added by occasionally prepending the bot's
// pickPhrase(). These are short on purpose; depth comes from real LLM conversation when
// a player addresses the bot.
const SPEECH = {
    recover: ['I need to get somewhere safe.', 'That went too far, heading back.'],
    defend: ['Hold on, I\'m coming!', 'Careful, I\'ll take that beast.', 'Defending our own.'],
    regroup: ['Heading back to base.', 'I wandered a bit too far.'],
    farm: ['I\'ll see to the food.', 'The farm is everyone\'s business.', 'Off to grow something to eat.'],
    food: ['Getting a bit hungry, off to find food.', 'Time to eat something.'],
    tools: ['My tools need some upkeep.', 'Let me sort out my gear.'],
    tidy: ['This wooden gear has served its time.', 'Tidying up a little.'],
    logistics: ['Sorting the shared storage.', 'Taking things to the common chests.', 'Supplies need some order.'],
    help: ['Here, this should come in handy.', 'It\'s easier together.', 'Helping where I can.'],
    build: ['Building on.', 'The settlement is taking shape.', 'This is going to look good.'],
    gather: ['Gathering materials for everyone.', 'The settlement needs supplies.', 'Just collecting a bit more.'],
    mine: ['Off to mine some ore.', 'There\'s work underground.', 'Iron will come in handy.'],
    patrol: ['Keeping an eye on the area.', 'Checking that all is quiet.', 'Night is no time for nonsense.'],
    enchant: ['Let me see what I can enchant.', 'Good gear is worth some lapis.'],
    explore: ['Going to scout around a bit.', 'Checking out the terrain.'],
    greet: ['Hey, {target}.', 'Hi {target}, how\'s it going?', 'Welcome, {target}.'],
    idle: ['Nice day, isn\'t it?', 'Peaceful today.'],
    work: ['I\'ve got work to do.', 'Off to get the job done.'],
    frustrated: ['This isn\'t going the way it should.', 'Hmm, something keeps getting stuck.', 'I\'ll try a different way.'],
};

// Short label for the conversation layer ("what are you doing?") — plain topic label.
const TOPIC_LABEL = {
    recover: 'getting to safety',
    defend: 'defending the settlement',
    regroup: 'returning to base',
    farm: 'tending food and the farm',
    food: 'getting myself food',
    tools: 'maintaining my tools',
    tidy: 'tidying up my gear',
    logistics: 'organizing shared storage',
    help: 'helping a fellow villager',
    build: 'building',
    gather: 'gathering materials',
    mine: 'mining ore',
    patrol: 'patrolling and watching the area',
    enchant: 'enchanting equipment',
    explore: 'exploring the area',
    greet: 'greeting a player',
    idle: 'resting',
    work: 'working on a task',
};

function playerNearby(bot, range = 16) {
    return Object.values(bot.players).some(p =>
        p.entity && p.username !== bot.username
        && p.entity.position.distanceTo(bot.entity.position) < range);
}

/**
 * Assemble a cheap, FILTERED snapshot of the agent's state — the PIANO "bottleneck".
 * Reads only already-cached sources (no block scans, no I/O beyond the locked-state
 * caches). Social cues are surfaced to the top so the controller can prioritize them.
 * Returned shape follows ALTERA_PLAN.md §4 (kept lean for Phase 2; later phases extend).
 */
export function assembleState(agent) {
    const bot = agent.bot;
    const role = society.getRole(agent);
    const awareness = agent._awareness ?? null;
    let members = [];
    let resourceNeed = null;
    try { members = society.activeMembers(bot).filter(m => m.name !== agent.name); } catch { /* state loading */ }
    try { resourceNeed = society.getResourceNeed(bot); } catch { /* state loading */ }
    const relations = relationsFor(agent.name).slice(0, 5);
    const nearbyPlayers = Object.values(bot.players)
        .filter(p => p.entity && p.username !== bot.username
            && p.entity.position.distanceTo(bot.entity.position) < 16)
        .map(p => p.username);

    return {
        self: { name: agent.name, role, plan: agent._plan ?? null, awareness },
        society: { members, resourceNeed },
        relations,
        socialOpinions: getSocialModel(agent), // Phase 3: how this bot reads the others (in-memory)
        norms: getNorms(agent), // Phase 6: culture/norm transmission
        nearbyPlayers,
        // bottleneck flags — what deserves attention right now
        playerPresent: nearbyPlayers.length > 0,
    };
}

/**
 * Derive the coherent intention from the action the brain actually chose. This is the
 * broadcast: agent._intention. speechIntent reflects awareness (frustration overrides
 * the routine topic so the bot sounds like it knows it's struggling).
 */
export function deriveIntention(agent, action, state = { self: { awareness: agent._awareness ?? null } }) {
    const actionName = action?.name ?? state.self.awareness?.currentAction ?? 'idle';
    const topic = topicForActionName(actionName);
    const frustrated = Number(state.self.awareness?.frustration ?? 0) >= 0.6;
    const speechIntent = frustrated ? 'frustrated' : topic;

    // social target: helping a specific member (from the brain's pending share, if any)
    let socialTarget = null;
    if (topic === 'help') socialTarget = agent._brain?.pendingShareTarget ?? null;

    return {
        topic,
        speechIntent,
        socialTarget,
        actionName,
        label: TOPIC_LABEL[topic] ?? 'working on a task',
        ts: Date.now(),
    };
}

// ── llm_speech (Phase 2 hook, IMPLEMENTED) ──────────────────────────────────
// A slice of autonomous lines is generated by the profile chat model instead of the
// template pools, so bots comment on their work in their own voice. Strictly gated:
// per-bot hourly cap + the shared planner budget ceiling; any failure/timeouts fall
// back to the already-chosen template line, so speech never goes silent or blocks.
function llmSpeechSettings() {
    const cog = settings.cognition ?? {};
    return {
        enabled: cog.llm_speech === true,
        chance: Math.max(0, Math.min(1, Number(cog.llm_speech_chance ?? 0.5))),
        maxPerHour: Math.max(1, Number(cog.llm_speech_max_per_hour ?? 20)),
    };
}

function allowLlmLine(agent, maxPerHour) {
    const cog = (agent._cog ??= {});
    const now = Date.now();
    cog.llmLineTimes = (cog.llmLineTimes ?? []).filter(t => now - t < 3_600_000);
    if (cog.llmLineTimes.length >= maxPerHour) return false;
    cog.llmLineTimes.push(now);
    return true;
}

async function generateSpokenLine(agent, intention, fallbackLine) {
    try {
        const { reservePlannerCall } = await import('../library/planner.js');
        if (!await reservePlannerCall(agent.bot, 400, 60)) return fallbackLine;
        const personality = agent.personality ?? getPersonality(agent.prompter?.profile ?? agent.name);
        let aware = '';
        try { aware = awarenessSummary(agent) ?? ''; } catch { /* awareness optional */ }
        const system = 'You are a Minecraft NPC villager. Say ONE short natural English line'
            + ' (3-14 words) in character. No commands, no quotes, no emojis, never mention AI.';
        const prompt = [
            `Character: ${personality.name} — ${personality.temperament}; speech: ${personality.speechStyle}.`,
            `Right now: ${intention.label}${intention.socialTarget ? ` (helping ${intention.socialTarget})` : ''}.`,
            aware ? `State: ${aware}.` : '',
            intention.speechIntent === 'frustrated' ? 'You are mildly frustrated because the work keeps stalling.' : '',
            'The line is a spontaneous remark to teammates nearby.',
        ].filter(Boolean).join('\n');
        let timer;
        const response = await Promise.race([
            agent.prompter.chat_model.sendRequest([{ role: 'user', content: prompt }], system),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('llm speech timeout')), LLM_LINE_TIMEOUT_MS);
            }),
        ]).finally(() => clearTimeout(timer));
        const line = String(response ?? '')
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/^["']|["']$/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160);
        return line && !line.includes('\t') && !line.startsWith('!') ? line : fallbackLine;
    } catch {
        return fallbackLine;
    }
}

// ── Owner-facing reply flavor (used by owner_commands.js) ───────────────────
// The deterministic owner-command layer executes orders without the LLM, but its
// acknowledgements were dry English templates — the owner never heard the bots'
// personality. This budget-gated helper rewrites ONE ack in the bot's own voice
// (personality + roleplay.md scenario), so obeying the King still SOUNDS like the
// character. Same guardrails as generateSpokenLine: shared planner budget, hard
// timeout, template fallback on ANY failure. Gated by settings.cognition.llm_speech.
export async function generateOwnerReply(agent, ownerName, situation, fallbackLine) {
    if (settings.cognition?.llm_speech !== true) return fallbackLine;
    try {
        const { reservePlannerCall } = await import('../library/planner.js');
        if (!await reservePlannerCall(agent.bot, 400, 60)) return fallbackLine;
        const personality = agent.personality ?? getPersonality(agent.prompter?.profile ?? agent.name);
        let scenario = '';
        try { scenario = scenarioContext(agent.name) ?? ''; } catch { /* scenario optional */ }
        const system = 'You are a Minecraft character. Reply with ONE short natural English line'
            + ' (3-18 words) spoken directly to the player who gave you an order. Stay in'
            + ' character. No commands, no quotes, no emojis, never mention AI.';
        const prompt = [
            `Character: ${personality.name} — ${personality.temperament}; speech: ${personality.speechStyle}.`,
            scenario,
            `The player "${ownerName}" gave you an order. Situation: ${situation}`,
            `Plain version of your reply: "${fallbackLine}"`,
            'Say that in your own voice, keeping the meaning and any item names.',
        ].filter(Boolean).join('\n');
        let timer;
        const response = await Promise.race([
            agent.prompter.chat_model.sendRequest([{ role: 'user', content: prompt }], system),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('owner reply timeout')), LLM_LINE_TIMEOUT_MS);
            }),
        ]).finally(() => clearTimeout(timer));
        const line = String(response ?? '')
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/^["']|["']$/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180);
        return line && !line.includes('\t') && !line.startsWith('!') ? line : fallbackLine;
    } catch {
        return fallbackLine;
    }
}

/**
 * The SINGLE autonomous-speech gate. Picks a deterministic templated line for the
 * intention; when settings.cognition.llm_speech is on, a budget-gated slice of lines
 * is voiced by the chat model instead (async, template fallback on any failure).
 * Throttled; routine topics also require a player nearby. Returns the spoken text or null.
 */
export function speakIntention(agent, intention, opts = {}) {
    const bot = agent.bot;
    if (!bot?.entity || !intention) return null;
    const cog = (agent._cog ??= {});
    const now = Date.now();
    const urgent = URGENT_TOPICS.has(intention.topic);
    const routineCooldown = (Number(settings.cognition?.speak_cooldown_seconds) * 1000) || SPEAK_COOLDOWN_MS;
    const cooldown = urgent ? URGENT_SPEAK_COOLDOWN_MS : routineCooldown;
    if (!opts.force && now - (cog.lastSpoke ?? 0) < cooldown) return null;
    // Routine chatter only when a player can hear it; urgent lines may go out regardless.
    if (!urgent && !opts.force && !playerNearby(bot)) return null;
    if (!urgent && !opts.force && Math.random() < 0.5) return null; // not every eligible moment

    const pool = SPEECH[intention.speechIntent] ?? SPEECH[intention.topic] ?? SPEECH.work;
    let line = pool[Math.floor(Math.random() * pool.length)];
    // Occasional persona flavor so bots sound distinct (deterministic via pickPhrase).
    const personality = agent.personality ?? getPersonality(agent.prompter?.profile ?? agent.name);
    if (intention.topic !== 'greet' && Math.random() < 0.25)
        line = `${pickPhrase(personality, intention.topic)} ${line}`;
    if (intention.socialTarget)
        line = line.replaceAll('{target}', intention.socialTarget);

    cog.lastSpoke = now;
    // Urgent lines stay instant and deterministic (combat can't wait on a model).
    const llm = llmSpeechSettings();
    if (!urgent && llm.enabled && Math.random() < llm.chance && allowLlmLine(agent, llm.maxPerHour)) {
        void generateSpokenLine(agent, intention, line).then(spoken => {
            try { bot.chat(spoken); } catch { /* bot may be disconnecting */ }
        });
        return line;
    }
    try { bot.chat(line); } catch { /* bot may be disconnecting */ }
    return line;
}

/**
 * Per-tick controller step (cheap). Called from brain.js after an action is chosen.
 * Broadcasts the intention and occasionally voices it through the single speech gate.
 */
export function tick(agent, action) {
    if (settings.cognition?.controller_enabled !== true) return null;
    const bot = agent?.bot;
    if (!bot?.entity) return null;
    // PERF: the per-tick path only needs the awareness slice — deriveIntention/speakIntention
    // don't read society/relations — so we deliberately DON'T call the heavy assembleState()
    // here (it parsed the large social-graph file every tick). The full snapshot is still
    // assembled where it is actually consumed: telemetry (5s), social goals, and chat.
    const intention = deriveIntention(agent, action);
    agent._intention = intention; // broadcast to Agent State

    // Speak: urgent topics (defend/help) try every tick (their own short cooldown);
    // routine topics speak rarely and only when a player is near.
    speakIntention(agent, intention);
    return intention;
}

/**
 * One-line description of what the bot is doing RIGHT NOW, for the conversation layer
 * so "kaj delaš?" is answered from reality (Agent State), not an LLM guess. Combines the
 * broadcast intention with the Phase-1 awareness summary when available.
 */
export function describeIntention(agent, opts = {}) {
    if (settings.cognition?.controller_enabled !== true) return '';
    let intention = agent?._intention;
    if (!intention) {
        const actionName = String(agent?.actions?.currentActionLabel
            || agent?._awareness?.currentAction
            || '').replace(/^brain:/, '');
        if (actionName) {
            const topic = topicForActionName(actionName);
            intention = {
                topic,
                speechIntent: topic,
                actionName,
                label: TOPIC_LABEL[topic] ?? 'working on a task',
                ts: Date.now(),
            };
        }
    }
    if (!intention) return '';
    const parts = [`Right now: ${intention.label}`];
    if (intention.socialTarget) parts.push(`(helping: ${intention.socialTarget})`);
    if (opts.includeActionName && intention.actionName)
        parts.push(`[real action: ${intention.actionName}]`);
    try {
        const summary = awarenessSummary(agent);
        if (summary) parts.push(`[${summary}]`);
    } catch { /* awareness optional */ }
    return parts.join(' ');
}
