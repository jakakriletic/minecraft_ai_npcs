// Deterministic "brain" for Mindcraft agents — drives all PLAY without the LLM.
// This flips Mindcraft's expensive paradigm (1 LLM call per action via self-prompting)
// into a hybrid one: AI sets bounded goals, while a priority loop in CODE picks and
// runs the next safe action. The LLM never drives pathfinding/combat/inventory.
//
// ALTERA / PIANO ROADMAP: this is the "motor/skill execution" loop. The plan to make
// these NPCs behave like Altera (Project Sid) — Cognitive Controller, Action Awareness,
// social goal generation — lives in ../../../ALTERA_PLAN.md. New cognition modules hook
// in here behind `settings.cognition.*` flags; READ THAT DOC before adding behavior.
//
// Selection model:
//   hard safety/command preemption -> dynamic goal graph (environment, milestone,
//   AI and society utility) -> bounded deterministic action execution.
// Survival reflexes (flee/fight mobs, eat, look around, pick up drops) are already
// handled for free by Mindcraft's non-LLM "modes" + auto-eat.
import * as skills from './skills.js';
import * as base from './base.js';
import * as world from './world.js';
import * as survival from './survival.js';
import * as build from './build.js';
import * as planner from './planner.js';
import * as social from './social.js';
import * as progression from './progression.js';
import * as decisionGraph from './decision_graph.js';
import { actionOutcome, captureActionProgress, nextActionBackoff, verifyActionOutcome } from './action_outcome.js';
import * as storage from './storage.js';
import * as society from './society.js';
import * as roads from './roads.js';
import * as enchanting from './enchanting.js';
import * as guardian from './guardian.js';
import * as magic from './magic.js';
import * as combat from './combat.js';
import * as mining from './mining.js';
import * as town from './town.js';
import * as tidy from './tidy.js';
import * as culture from './culture.js'; // ALTERA/PIANO Phase 6 - shared norm transmission (see ALTERA_PLAN.md)
import * as homeLife from './home_life.js';
import { isNaturalResourceCandidate } from './resource_guard.js';
import settings from '../../../settings.js';
import runtimeSettings from '../settings.js';
import { serverProxy } from '../mindserver_proxy.js';
import { Vec3 } from 'vec3';
import * as rpEvents from '../roleplay/events.js';
import * as awareness from '../roleplay/awareness.js'; // ALTERA/PIANO Phase 1 — Action Awareness (see ALTERA_PLAN.md)
import * as cognition from '../roleplay/cognition.js'; // ALTERA/PIANO Phase 2 — Cognitive Controller (see ALTERA_PLAN.md)
import * as socialAwareness from '../roleplay/social_awareness.js'; // ALTERA/PIANO Phase 3 — Social Awareness perception (see ALTERA_PLAN.md)
import * as socialGoals from '../roleplay/social_goals.js'; // ALTERA/PIANO Phase 4 — recursive social goal generation (see ALTERA_PLAN.md)
import * as telemetry from '../roleplay/telemetry.js'; // Debug telemetry ("Sloj A") — per-bot Agent State snapshot + decision trace

import * as reflection from '../roleplay/reflection.js'; // ALTERA/PIANO Phase 7 - long-timescale belief consolidation

const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log'];
const WOOD_STOCK = 32;
const STONE_STOCK = 32;
const PLAYER_YIELD_MS = 8000;       // pause brain briefly after a player talks (LLM may act)
const AMBIENT_COOLDOWN_MS = 6 * 60_000; // at most one ambient line per 6 min per bot
const SOCIETY_PLAN_CHECK_MS = Math.max(15, settings.society_planner_check_seconds ?? 60) * 1000;
const LOCAL_PLAN_INTERVAL_MS = Math.max(1, settings.local_planner_interval_minutes ?? 3) * 60_000;
const LOCAL_PLAN_JITTER_MS = Math.max(0, settings.local_planner_jitter_minutes ?? 1) * 60_000;
const SOCIAL_GOAL_STAGES = new Set([
    'iron_tools', 'iron_utility', 'iron_armor', 'established',
    'diamond_tools', 'diamond_armor', 'advanced_utility', 'late_game',
]);
const HARD_SAFETY_ACTIONS = new Set([
    'restoreSurvival', 'escapeToSurface', 'recoverHealth', 'healerSupport',
    'magicRecharge', 'magicianFireball', 'guardianDefense', 'defendSociety',
    'emergencyFood', 'miningExpedition',
]);

function cognitionSettings() {
    return runtimeSettings.cognition ?? settings.cognition ?? {};
}

function nameHash(name) {
    let hash = 0;
    for (const char of String(name))
        hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    return hash;
}

function initialSocietyPlanDelay(name) {
    return 30_000 + (nameHash(name) % 60_000);
}

function nextSocietyPlanCheckDelay() {
    return Math.max(15_000,
        SOCIETY_PLAN_CHECK_MS + Math.floor(Math.random() * Math.min(30_000, SOCIETY_PLAN_CHECK_MS)));
}

function initialLocalPlanDelay(name) {
    const spread = Math.max(30_000, LOCAL_PLAN_INTERVAL_MS);
    return 45_000 + ((nameHash(`${name}:local`) % spread));
}

function nextLocalPlanDelay() {
    return Math.max(60_000,
        LOCAL_PLAN_INTERVAL_MS + (Math.random() * 2 - 1) * LOCAL_PLAN_JITTER_MS);
}

function socialGoalReady(progressStatus) {
    return progressStatus?.milestones?.ironTools === true
        || SOCIAL_GOAL_STAGES.has(progressStatus?.stage);
}

export function attachBrain(agent, opts = {}) {
    const bot = agent.bot;
    skills.installSafeMovements(bot);
    bot._combatStyle = combat.getCombatStyle(agent);
    agent._brain = {
        lastPlayer: 0,
        lastAmbient: 0,
        nextSocietyPlanCheckAt: Date.now() + initialSocietyPlanDelay(agent.name),
        nextLocalPlanAt: Date.now() + initialLocalPlanDelay(agent.name),
    };
    if (!['creative', 'god_mode'].includes(settings.base_profile) && bot.game?.gameMode === 'creative')
        bot._mustReturnToSurvival = true;
    bot._creativeBuildFlying = false;
    if (build.repairBotPhysics(bot))
        console.warn(`[brain ${agent.name}] repaired invalid gravity after spawn`);
    // The deterministic stuck detector understands brain action labels and applies
    // backoff. Disable the generic mode to avoid two recovery systems interrupting
    // each other and causing repeated leave/rejoin cycles.
    bot.modes.setOn('unstuck', false);

    // local lifecycle flags, tied to THIS bot instance (robust across reconnects —
    // a fresh attachBrain gets its own flags, the old loop stops on its own bot's 'end')
    let running = true;
    let timer = null;

    // Only a REAL player talking should pause the brain (the LLM may act on it).
    // Fellow bots chatting must NOT — ten bots greeting each other would otherwise
    // keep every brain perpetually yielded, so nobody ever gathers or works.
    const isFellowBot = (username) => {
        try {
            return serverProxy.getAgents()
                .map(a => (typeof a === 'string' ? a : a?.name))
                .filter(Boolean)
                .includes(username);
        } catch { return false; }
    };
    bot.on('chat', (username) => {
        if (username !== bot.username && !isFellowBot(username)) agent._brain.lastPlayer = Date.now();
    });
    social.attachSocial(agent); // free reactions/banter (weather event listener)
    society.attachSociety(agent);
    const onEntityHurt = entity => {
        if (settings.kingdom_guardians === false
            || entity?.type !== 'player'
            || entity.username === bot.username
            || !agent.actions.currentActionLabel.startsWith('brain:')
            || Date.now() - (agent._brain.lastGuardAlert ?? 0) < 3000)
            return;
        const threat = social.findGuardianThreat(bot);
        if (!threat) return;
        agent._brain.lastGuardAlert = Date.now();
        agent._brain.guardThreat = threat;
        decisionGraph.queueSafetyAction(agent, {
            key: 'guardian-alert',
            goalKey: 'combat',
            priority: 55,
            reason: 'a settlement member was hurt while a nearby hostile remained visible',
            createAction: () => {
                const queued = agent._brain.guardThreat;
                agent._brain.guardThreat = null;
                if (!queued?.entity?.position || queued.entity.isValid === false) return null;
                return {
                    name: 'guardianDefense',
                    timeout: 1,
                    fn: async () => await guardian.protectSociety(agent, queued),
                };
            },
        });
    };
    bot.on('entityHurt', onEntityHurt);
    const onDeath = () => {
        void rpEvents.recordDeath(agent)
            .catch(error => console.warn(`[rp ${agent.name}] death memory failed: ${error.message}`));
    };
    bot.on('death', onDeath);

    // Social/greet + STUCK DETECTOR on a light timer (runs even mid-action). The stuck
    // detector is the real fix for hangs: mineflayer's goto has no overall movement
    // timeout, so a physically-stuck bot can freeze until the action's minute-long
    // timeout. Here we break it in ~15s and let the brain pick a new target.
    const socialTimer = setInterval(() => {
        if (!bot?.entity) return;
        try { greetNearby(agent); checkStuck(agent); reflectAwareness(agent); socialAwareness.perceive(agent); telemetry.writeSnapshot(agent); } catch { /* */ }
        void culture.tickCulture(agent).catch((err) => {
            console.warn(`[culture ${agent.name}] ${err.message}`);
        });
        void reflection.tickReflection(agent).catch((err) => {
            console.warn(`[reflect ${agent.name}] ${err.message}`);
        });
        void social.tickSocial(agent).catch((err) => {
            console.warn(`[social ${agent.name}] ${err.message}`);
        });
    }, 4000);

    // Action loop SELF-SCHEDULES: after a productive action it re-decides almost
    // immediately (smooth continuous play), and paces itself when idle. Single chain,
    // so no overlapping ticks — no re-entrancy guard needed.
    let ticking = false;
    let wakeRequested = false;
    const loop = async () => {
        if (!running) return;
        if (ticking) {
            wakeRequested = true;
            return;
        }
        ticking = true;
        let delay = 2500;
        try { delay = await brainTick(agent); }
        catch (e) { console.log(`[brain ${agent.name}] ${e.message}`); }
        finally { ticking = false; }
        if (running) {
            const nextDelay = wakeRequested ? 0 : delay;
            wakeRequested = false;
            timer = setTimeout(loop, nextDelay);
        }
    };
    agent._brain.wake = () => {
        if (!running) return;
        if (ticking) {
            wakeRequested = true;
            return;
        }
        clearTimeout(timer);
        timer = setTimeout(loop, 0);
    };
    timer = setTimeout(loop, 1500); // small settle after spawn

    // Auto-claim a home base if the player hasn't set one. OFF by default since
    // 2026-07: home is opt-in (!setHome / !storage). Without one there is no base
    // leash and each bot claims only a personal camp (its own chest corner) the
    // first time it needs storage — see base.goPersonalAnchor / camp.js.
    if (settings.auto_claim_home === true) {
        // The ~30s delay lets bots drift apart first, spreading the bases.
        setTimeout(() => {
            if (running && bot?.entity && !base.getBase(bot)) {
                const p = bot.entity.position;
                base.setHome(bot, p.x, p.y, p.z, 14);
                console.log(`[brain ${agent.name}] auto-claimed base at ${Math.floor(p.x)},${Math.floor(p.z)}`);
            }
        }, 30000);
    }

    bot.once('end', () => {
        running = false;
        clearTimeout(timer);
        clearInterval(socialTimer);
        delete agent._brain?.wake;
        bot.removeListener('entityHurt', onEntityHurt);
        bot.removeListener('death', onDeath);
    });
    console.log(`[brain ${agent.name}] hybrid brain active (AI plans goals; code executes actions)`);
}

// Runs one decision and returns the ms delay until the next — short after a real
// action (smooth), longer when there's nothing to do (stands still, no jitter).
async function brainTick(agent) {
    const bot = agent.bot;
    if (!bot?.entity) return 2500;
    if (build.repairBotPhysics(bot))
        console.warn(`[brain ${agent.name}] repaired invalid gravity during play`);
    if (!agent.isIdle()) return 700;                          // a player command / prior action is running
    // A pending owner duty owns the bot: runOwnerAction is between resume attempts
    // (an emergency mode interrupted it), so routine work must not steal the slot.
    const ownerDuty = bot._ownerDuty;
    if (ownerDuty && (ownerDuty.until === null || Date.now() < ownerDuty.until)) return 1000;
    const queuedSafetyPending = decisionGraph.hasPendingSafetyAction(agent);
    const recoveryPending = queuedSafetyPending
        || bot._miningRecoveryRequested
        || agent._brain.needsSurfaceRecovery
        || bot._mustReturnToSurvival
        || bot._creativeBuildActive
        || bot._creativeBuildFlying
        || (!['creative', 'god_mode'].includes(settings.base_profile) && bot.game.gameMode === 'creative');
    if (!recoveryPending && agent.self_prompter?.isActive?.()) return 1500; // safety: never double-drive
    if (!recoveryPending && Date.now() - agent._brain.lastPlayer < PLAYER_YIELD_MS) return 1500;

    const progressStatus = progression.getStatus(bot);
    // Hybrid planning: a rare shared cloud strategy assigns the whole society,
    // while cheap local micro-plans fill gaps. Code still executes every action.
    // Planning is useful before a player sets a home. The planner limits home-only
    // focuses per member, while survival and scouting remain available anywhere.
    if (!recoveryPending) {
        planner.applySocietyPlan(agent);
        if (settings.society_planner_enabled !== false
            && Date.now() >= (agent._brain.nextSocietyPlanCheckAt ?? 0)) {
            agent._brain.nextSocietyPlanCheckAt = Date.now() + nextSocietyPlanCheckDelay();
            await planner.planSociety(agent);
            planner.applySocietyPlan(agent);
        }
        if (settings.local_planner_enabled !== false
            && Date.now() >= (agent._brain.nextLocalPlanAt ?? 0)) {
            agent._brain.nextLocalPlanAt = Date.now() + nextLocalPlanDelay();
            await planner.planLocal(agent);
        }
    }

    const act = chooseAction(agent, progressStatus);
    if (!act) return 2500;                                    // nothing to do -> relaxed pace
    if (!act.decision) {
        const policy = describePolicyDecision(agent, act);
        decisionGraph.recordPolicyDecision(agent, act, policy);
    }

    const blocked = agent._brain.actionBackoff?.[act.name];
    if (blocked && Date.now() < blocked.retryAt) {
        // A failed high-priority action remains the selected action throughout
        // its backoff. Recording it every 2.5 s created thousands of duplicate
        // trace writes and needless decision churn without making the bot more
        // responsive. Record once per backoff window and recheck at a light pace.
        const blockedKey = `${act.name}:${blocked.retryAt}`;
        if (agent._brain.lastBlockedTrace !== blockedKey) {
            agent._brain.lastBlockedTrace = blockedKey;
            telemetry.recordDecision(agent, act, { blocked: true, stage: progressStatus?.stage });
        }
        return Math.min(5000, blocked.retryAt - Date.now());
    }
    agent._brain.lastBlockedTrace = null;

    // Planning is asynchronous. A player command or safety mode may have started
    // after the first idle check, so the brain must yield instead of preempting it.
    if (!agent.isIdle()) return 700;

    // Candidate-local cooldowns begin only when the selected action is actually
    // eligible to start. Merely materializing a provider must not consume them.
    try { act.onStart?.(); }
    catch (error) { console.warn(`[decision ${agent.name}] ${act.name} onStart: ${error.message}`); }

    // ALTERA/PIANO Phase 2: broadcast the coherent intention only once this action is
    // actually eligible to run. Backoff/cooldown decisions must not produce speech for
    // work the bot is about to skip.
    // No-op unless settings.cognition.controller_enabled. chooseAction stays authoritative.
    cognition.tick(agent, act);

    const progressBefore = captureActionProgress(agent);
    act.decision.goalKey ??= semanticActionGoal(act);
    agent._brain.activeDecision = act.decision;
    let rawResult;
    try {
        rawResult = await agent.actions.runAction('brain:' + act.name, act.fn, {
            timeout: act.timeout ?? 1,
            preempt: false,
        });
    } finally {
        if (agent._brain.activeDecision === act.decision)
            agent._brain.activeDecision = null;
        agent._brain.pendingPreemption = null;
    }
    if (rawResult.busy) return 700;
    const result = verifyActionOutcome(act, rawResult, progressBefore, captureActionProgress(agent));
    void rpEvents.recordActionResult(agent, act.name, result)
        .catch(error => console.warn(`[rp ${agent.name}] action memory failed: ${error.message}`));
    const outcome = decisionGraph.recordDecisionOutcome(agent, act, result);
    const nextBackoff = nextActionBackoff(agent._brain.actionBackoff?.[act.name], result);
    if (nextBackoff) {
        agent._brain.actionBackoff ??= {};
        agent._brain.actionBackoff[act.name] = nextBackoff;
    } else {
        if (agent._brain.actionBackoff) delete agent._brain.actionBackoff[act.name];
        maybeAmbient(agent, act.name);
    }
    if (act.decision?.source === 'ai'
        && outcome?.consecutiveFailures >= 3
        && agent._plan
        && !agent._plan.completed
        && !isFoodSupplyPlan(agent._plan)) {
        agent._plan.completed = true;
        agent._plan.completedReason = `abandoned after ${outcome.consecutiveFailures} failed action attempts`;
        console.warn(`[decision ${agent.name}] ${act.decision.key}: ${agent._plan.completedReason}`);
    }
    telemetry.recordDecision(agent, act, {
        result: result.interrupted ? 'interrupted' : (result.actionStatus ?? (result.success ? 'ok' : 'fail')),
        stage: progressStatus?.stage,
        reason: !result.success ? result.message : null,
    });
    if (act.name === 'rest' || act.name === 'idle') return 1500;
    // Mining macros already process 12-16 blocks per action. A short yield keeps
    // group operations responsive without the 4+ decisions/second spin visible
    // in old traces when a phase cannot advance.
    return act.name === 'miningExpedition' ? 650 : 200;
}

function semanticActionGoal(action) {
    if (action?.safetyGoal) return action.safetyGoal;
    if (['emergencyFood', 'secureFood'].includes(action?.name)) return 'foodRecovery';
    if (['guardianDefense', 'defendSociety', 'magicianFireball', 'magicRecharge'].includes(action?.name))
        return 'combat';
    if (['restoreSurvival', 'escapeToSurface'].includes(action?.name)) return 'escapeHazard';
    if (action?.name === 'recoverHealth') return 'healthRecovery';
    return action?.decision?.key ?? action?.name ?? 'unknown';
}

function describePolicyDecision(agent, action) {
    const bot = agent.bot;
    const details = {
        restoreSurvival: 'builder state or game mode must be restored before other work',
        escapeToSurface: 'the mining recovery watchdog requires a safe return to the surface',
        recoverHealth: `health ${Number(bot.health ?? 0).toFixed(1)}/20 requires recovery`,
        healerSupport: 'a nearby settlement member needs healing',
        magicRecharge: 'a nearby threat remains while the magician spell is cooling down',
        magicianFireball: 'the magician has a visible hostile target',
        guardianDefense: 'a settlement member is under immediate threat',
        defendSociety: 'a hostile is within immediate defense range',
        emergencyFood: `food ${Number(bot.food ?? 0)}/20 with no carried meal`,
        miningExpedition: 'an active shared expedition must finish, retreat, or reach a safe checkpoint',
        goHome: 'the NPC is beyond the configured home leash',
        secureFood: `food ${Number(bot.food ?? 0)}/20 requires a bounded food-rescue action`,
        maintainTools: 'a required core tool is missing',
        obsoleteGear: 'obsolete wooden equipment should be removed after the stone baseline',
        publicHubGear: 'the public hub equipment check is due',
        publicHubRestock: 'everyday supplies are missing and public storage is available',
        kingdomShare: 'a nearby member has an urgent supply shortage',
        publicHubDeposit: 'shared-storage contribution is due',
        stash: 'inventory has two or fewer empty slots',
        storage: 'public storage needs repair or expansion',
    };
    const safety = HARD_SAFETY_ACTIONS.has(action.name)
        || /defen[cs]e|retreat|escape|recover/i.test(action.name);
    return {
        source: safety ? 'safety' : (action.name === 'maintainTools' ? 'maintenance' : 'environment'),
        reason: action.reason ?? details[action.name]
            ?? `deterministic hard-priority precondition selected ${action.name}`,
    };
}

function invCount(bot, names) {
    const inv = world.getInventoryCounts(bot);
    return (Array.isArray(names) ? names : [names]).reduce((s, n) => s + (inv[n] ?? 0), 0);
}
function findTarget(bot, names, range = 32) {
    // use the block-ID fast path (array matching) — NOT a function predicate, which
    // forces mineflayer to build a Block object for every candidate (very slow at range).
    const blocks = world.getNearestBlocks(bot, names, range, 24);
    return blocks.find(block => isNaturalResourceCandidate(bot, block, block.name))?.name ?? null;
}
// stand still briefly (used for relax / paced idle so bots don't constantly re-path)
const restAction = (bot) => ({ name: 'rest', timeout: 1, fn: async () => {
    try { return await skills.wait(bot, 3000); } catch { return false; }
} });

const cooling = (agent, key, ms) => Date.now() - (agent._brain[key] ?? 0) < ms;
const mark = (agent, key) => { agent._brain[key] = Date.now(); };
function markOnStart(agent, keys, action) {
    if (!action) return action;
    const previous = action.onStart;
    action.onStart = () => {
        for (const key of keys) mark(agent, key);
        if (typeof previous === 'function') previous();
    };
    return action;
}
function isCoordinator(agent, bot) {
    const names = new Set(society.activeMembers(bot).map(member => member.name));
    names.add(agent.name);
    return [...names].sort((a, b) => a.localeCompare(b))[0] === agent.name;
}

function isSettlementFoodForager(agent, bot) {
    const names = new Set(society.activeMembers(bot).map(member => member.name));
    names.add(agent.name);
    return [...names]
        .sort((a, b) => a.localeCompare(b))
        .slice(0, Math.min(2, names.size))
        .includes(agent.name);
}

function isFoodSupplyPlan(plan) {
    return plan?.resource === 'food' && ['farm', 'stockpile'].includes(plan.focus);
}

// Turn the planner's high-level focus into a concrete next action (deterministic).
// Each is cooldown-gated so a focus doesn't thrash every tick. null -> use background.
function focusAction(agent, home) {
    const bot = agent.bot;
    const plan = agent._plan;
    if (!plan || plan.completed || Date.now() > plan.expiresAt) return null;
    const focus = plan.focus;
    switch (focus) {
        case 'farm':
            if (invCount(bot, survival.FOOD) >= plan.amount) {
                plan.completed = true;
                return null;
            }
            if (home && !cooling(agent, 'farm', 60_000)) {
                return markOnStart(agent, ['farm'], { name: 'farm', timeout: 5, fn: async () => {
                    return (await survival.tendFarm(bot)) || (await survival.secureFood(bot, { forceHunt: true }));
                } });
            }
            return null;
        case 'explore':
            if (!cooling(agent, 'explore', 120_000)) {
                return markOnStart(agent, ['explore'], { name: 'explore', timeout: 2, fn: async () => {
                    const result = await survival.explore(bot, home);
                    plan.completed = result;
                    return result;
                } });
            }
            return null;
        case 'build': {
            if (settings.allow_building !== false && home && !cooling(agent, 'build', 30_000)) {
                const name = plan.schematic ?? build.listSchematics()[0];
                if (!name) { plan.completed = true; return null; }
                return markOnStart(agent, ['build'], { name: 'build', timeout: 4, fn: async () => {
                    if (storage.getPublicStorageAnchor(bot)) {
                        await storage.setupPublicStorage(bot, 500);
                        const queued = await town.queueBuild(bot, name);
                        plan.completed = Boolean(queued);
                        return Boolean(queued);
                    }
                    const origin = projectOrigin(home, name);
                    await build.prepareSchematic(bot, name, origin);
                    const result = await build.buildSchematicStep(bot, name, origin, settings.build_step_blocks ?? 24);
                    plan.completed = result.complete;
                    return result.complete || result.placed > 0;
                } });
            }
            return null;
        }
        case 'base':
            if (home && !cooling(agent, 'basePlan', 90_000)) {
                return markOnStart(agent, ['basePlan'], { name: 'basePlan', timeout: 3, fn: async () => {
                    const setup = await base.setupBase(bot);
                    const stashed = bot.inventory.emptySlotCount() <= 6 ? await base.stash(bot) : true;
                    plan.completed = setup && stashed;
                    return plan.completed;
                } });
            }
            return null;
        case 'stockpile': {
            const resource = plan.resource ?? 'wood';
            const counts = {
                wood: invCount(bot, LOGS),
                stone: invCount(bot, 'cobblestone'),
                food: invCount(bot, survival.FOOD),
                iron: invCount(bot, ['iron_ingot', 'raw_iron']),
                coal: invCount(bot, ['coal', 'charcoal']),
                gold: invCount(bot, ['gold_ingot', 'raw_gold']),
                lapis: invCount(bot, 'lapis_lazuli'),
                diamond: invCount(bot, 'diamond'),
            };
            if ((counts[resource] ?? 0) >= plan.amount) {
                plan.completed = true;
                return null;
            }
            if (resource === 'food')
                return { name: 'planFood', timeout: 5, fn: async () => await survival.secureFood(bot, { forceHunt: true }) };
            if (resource === 'iron')
                return { name: 'planIron', timeout: 4, fn: async () =>
                    (await mining.requestResourceExpedition(agent, 'iron', Math.min(8, plan.amount - counts.iron))).active };
            if (resource === 'coal')
                return { name: 'planCoal', timeout: 3, fn: async () =>
                    (await mining.requestResourceExpedition(agent, 'coal', Math.min(8, plan.amount - counts.coal))).active };
            if (resource === 'gold')
                return { name: 'planGold', timeout: 4, fn: async () =>
                    (await mining.requestResourceExpedition(agent, 'gold', Math.min(8, plan.amount - counts.gold))).active };
            if (resource === 'lapis')
                return { name: 'planLapis', timeout: 4, fn: async () =>
                    (await mining.requestResourceExpedition(agent, 'lapis', Math.min(12, plan.amount - counts.lapis))).active };
            if (resource === 'diamond')
                return { name: 'planDiamond', timeout: 6, fn: async () =>
                    (await mining.requestResourceExpedition(agent, 'diamond', Math.min(5, plan.amount - counts.diamond))).active };
            if (resource === 'stone') {
                const target = findTarget(bot, ['stone']);
                return target
                    ? { name: 'planStone', timeout: 2, fn: async () => await skills.collectBlock(bot, target, Math.min(8, plan.amount - counts.stone)) }
                    : { name: 'planStoneSearch', timeout: 1, fn: async () => await skills.moveAway(bot, 8) };
            }
            const target = findTarget(bot, LOGS);
            return target
                ? { name: 'planWood', timeout: 2, fn: async () => await skills.collectBlock(bot, target, Math.min(8, plan.amount - counts.wood)) }
                : { name: 'planWoodSearch', timeout: 1, fn: async () => await skills.moveAway(bot, 8) };
        }
        case 'social': {
            // ALTERA/PIANO Phase 4: the planner chose to prioritize a social goal. Execute
            // it through the SAME deterministic generator (it re-derives the concrete target
            // + gift), so an LLM-chosen `social` focus never invents an unfeasible delivery.
            const socialAction = socialGoals.planSocialAction(agent, home);
            if (socialAction) return socialAction;
            plan.completed = true; // nothing deliverable right now — let the planner move on
            return null;
        }
        case 'relax':
            if (!cooling(agent, 'idle', 20_000))
                return markOnStart(agent, ['idle'], { name: 'idle', timeout: 1, fn: async () => await idleWander(bot, home) });
            return restAction(bot);
        default:
            return null;
    }
}

// Society work sits below personal survival/progression but above optional AI plans.
// Every member is a generalist; cooldowns and locks keep shared work from stampeding.
function societyAction(agent, home, progressStatus) {
    if (settings.kingdom_mode === false) return null;
    const bot = agent.bot;
    const combatStyle = combat.getCombatStyle(agent);
    const coordinator = isCoordinator(agent, bot);

    // Any member may claim donated defensive equipment even during early progression.
    if (!cooling(agent, 'kingdomGuardianGear',
        guardian.needsGuardianLoadout(bot) ? 4 * 60_000 : 12 * 60_000)) {
        return markOnStart(agent, ['kingdomGuardianGear'], {
            name: 'kingdomGuardianGear',
            timeout: 5,
            fn: async () => await guardian.improveLoadout(agent),
        });
    }

    // Every member keeps a bow + arrows (and defenders a shield) so anyone can
    // fight back. Cooldown-gated so it never flails for missing materials.
    if (combat.needsCombatKit(agent)
        && !cooling(agent, 'combatKit', combatStyle === 'archer' ? 2 * 60_000 : 5 * 60_000)) {
        return markOnStart(agent, ['combatKit'], {
            name: 'combatKit',
            timeout: 3,
            fn: async () => await combat.ensureCombatKit(agent, {
                gather: combatStyle === 'archer',
                arrowTarget: combatStyle === 'archer' ? 16 : 8,
            }),
        });
    }

    if (progressStatus.milestones?.stoneTools !== true) return null;

    if (coordinator) {
        if (!storage.getPublicStorage(bot) && home
            && society.activeMembers(bot).length >= 2
            && !cooling(agent, 'kingdomStorageCreate', 180_000)) {
            return markOnStart(agent, ['kingdomStorageCreate'], {
                name: 'kingdomStorage',
                timeout: 4,
                fn: async () => await storage.configurePublicStorage(
                    bot,
                    new Vec3(Math.floor(home.x), Math.floor(home.y), Math.floor(home.z)),
                    12,
                ),
            });
        }
        if (!cooling(agent, 'kingdomStorage', 120_000)
            && storage.publicStorageNeedsMaintenance(bot)) {
            return markOnStart(agent, ['kingdomStorage'], {
                name: 'kingdomStorage', timeout: 4, fn: async () => await storage.setupPublicStorage(bot),
            });
        }
        if (settings.kingdom_cleanup !== false
            && !cooling(agent, 'kingdomCleanup',
                Math.max(5, settings.kingdom_cleanup_interval_minutes ?? 10) * 60_000)) {
            mark(agent, 'kingdomCleanup');
            if (tidy.settlementNeedsCleanup(bot))
                return {
                    name: 'kingdomCleanup',
                    timeout: 4,
                    fn: async () => await tidy.cleanupSettlement(bot, false),
                };
        }
    }

    if (home && !cooling(agent, 'farm', 90_000)) {
        return {
            name: 'kingdomFarm',
            timeout: 6,
            onStart: () => {
                // Share the same gate as AI/environment farming so two providers
                // cannot schedule back-to-back farm busywork.
                mark(agent, 'kingdomFarm');
                mark(agent, 'farm');
            },
            fn: async () => await survival.tendFarm(bot),
        };
    }

    // Builders lay out planned streets/plaza first, then fill aligned plots, then
    // connect any legacy/freeform builds that still need paths.
    if (roads.needsTownPlanRoads(bot)
        && !cooling(agent, 'kingdomTownRoads',
            Math.max(0.5, settings.town_road_interval_minutes ?? 1) * 60_000)) {
        return markOnStart(agent, ['kingdomTownRoads'], {
            name: 'kingdomRoads', timeout: 9, fn: async () => await roads.maintainRoadNetwork(bot),
        });
    }

    if (!cooling(agent, 'townBuild', town.townBuildCooldownMs())) {
        const townAction = town.planBuildAction(agent);
        if (townAction) return markOnStart(agent, ['townBuild'], townAction);
    }

    if (roads.needsRoad(bot)
        && !cooling(agent, 'kingdomRoads',
            Math.max(2, settings.kingdom_road_interval_minutes ?? 4) * 60_000)) {
        return markOnStart(agent, ['kingdomRoads'], {
            name: 'kingdomRoads', timeout: 9, fn: async () => await roads.maintainRoadNetwork(bot),
        });
    }

    if (!cooling(agent, 'kingdomStockpile', 25_000)) {
        // Deep ore (iron/coal/gold/lapis) → join a cooperative staircase expedition;
        // surface stockpiling (food/stone/wood) stays solo below.
        const expedition = mining.planExpeditionAction(agent);
        if (expedition) return markOnStart(agent, ['kingdomStockpile'], expedition);
        const resource = society.getResourcePriority(bot);
        if (resource === 'food')
            return markOnStart(agent, ['kingdomStockpile'], { name: 'kingdomStockpile', timeout: 3, fn: async () => await survival.secureFood(bot) });
        if (resource === 'iron')
            return markOnStart(agent, ['kingdomStockpile'], { name: 'kingdomStockpile', timeout: 5, fn: async () =>
                (await mining.requestResourceExpedition(agent, 'iron', 6)).active });
        if (resource === 'coal')
            return markOnStart(agent, ['kingdomStockpile'], { name: 'kingdomStockpile', timeout: 4, fn: async () =>
                (await mining.requestResourceExpedition(agent, 'coal', 8)).active });
        if (resource === 'gold')
            return markOnStart(agent, ['kingdomStockpile'], { name: 'kingdomStockpile', timeout: 5, fn: async () =>
                (await mining.requestResourceExpedition(agent, 'gold', 6)).active });
        if (resource === 'lapis')
            return markOnStart(agent, ['kingdomStockpile'], { name: 'kingdomStockpile', timeout: 5, fn: async () =>
                (await mining.requestResourceExpedition(agent, 'lapis', 8)).active });
        const names = resource === 'stone' ? ['stone'] : LOGS;
        const target = findTarget(bot, names, 36);
        if (target)
            return markOnStart(agent, ['kingdomStockpile'], { name: 'kingdomStockpile', timeout: 3, fn: async () =>
                await skills.collectBlock(bot, target, resource === 'stone' ? 8 : 6) });
    }

    if (enchanting.canTryEnchanting(agent)
        && !cooling(agent, 'kingdomEnchanting',
            Math.max(3, settings.kingdom_enchant_interval_minutes ?? 5) * 60_000)) {
        return markOnStart(agent, ['kingdomEnchanting'], {
            name: 'kingdomEnchanting',
            timeout: 5,
            fn: async () => await enchanting.enchantFromPublicStorage(agent),
        });
    }
    if (invCount(bot, 'torch') < 8 && !cooling(agent, 'kingdomTorches', 180_000)) {
        return markOnStart(agent, ['kingdomTorches'], {
            name: 'kingdomTorches', timeout: 3, fn: async () => await survival.makeTorches(bot, 12, false),
        });
    }
    if (!cooling(agent, 'kingdomPatrol', 45_000)) {
        return markOnStart(agent, ['kingdomPatrol'], {
            name: 'kingdomPatrol',
            timeout: 2,
            fn: async () => await guardian.patrolSociety(agent, home),
        });
    }

    return null;
}

function projectOrigin(home, name) {
    if (name === 'koca') return new Vec3(home.x + 4, home.y, home.z - 2);
    if (name === 'hisa') return new Vec3(home.x - 9, home.y, home.z - 3);
    if (name === 'stolp') return new Vec3(home.x + 4, home.y, home.z + 4);
    return new Vec3(home.x + 3, home.y, home.z + 3);
}

function dynamicDecisionCandidates(agent, home, progressStatus) {
    const bot = agent.bot;
    const candidates = [...progression.actionCandidates(agent, progressStatus)];
    const activePlan = agent._plan
        && !agent._plan.completed
        && Date.now() < Number(agent._plan.expiresAt ?? 0);

    if (activePlan && agent._plan.priority === 'high') {
        candidates.push({
            key: `ai:${agent._plan.planId ?? agent._plan.focus}:high`,
            source: 'ai',
            utility: 92,
            priority: 28,
            reason: agent._plan.project ?? `high-priority ${agent._plan.focus} plan`,
            commitmentBonus: 18,
            createAction: () => focusAction(agent, home),
        });
    }

    // These are important needs, but none justify bypassing recovery, combat, or
    // another materially more urgent goal. Publishing them here lets the arbiter
    // make that trade-off explicitly instead of source-code order deciding it.
    const carriedFood = invCount(bot, survival.FOOD);
    const foodLevel = Number(bot.food ?? 20);
    const foodNeed = society.getResourceNeed(bot);
    const settlementFoodEmpty = foodNeed.resource === 'food' && Number(foodNeed.ratio ?? 1) <= 0.25;
    if (settlementFoodEmpty && isSettlementFoodForager(agent, bot) && !cooling(agent, 'settlementFood', 20_000)) {
        candidates.push({
            key: 'environment:settlementFoodShortage',
            source: 'environment',
            actionName: 'secureFood',
            utility: 100,
            urgency: 45,
            reason: `shared food reserve is critically low (ratio ${Number(foodNeed.ratio ?? 0).toFixed(2)})`,
            onSelected: () => mark(agent, 'settlementFood'),
            createAction: () => ({
                name: 'secureFood',
                timeout: 5,
                fn: async () => await survival.secureFood(bot, { forceHunt: true }),
            }),
        });
    }
    if (foodLevel <= 14 && carriedFood < 3 && !cooling(agent, 'food', 60_000)) {
        candidates.push({
            key: 'environment:secureFood',
            source: 'environment',
            actionName: 'secureFood',
            utility: 94,
            urgency: Math.min(50, 22 + Math.max(0, (14 - foodLevel) * 4)),
            reason: `hunger ${foodLevel}/20 with only ${carriedFood} food`,
            onSelected: () => mark(agent, 'food'),
            createAction: () => ({
                name: 'secureFood', timeout: 5, fn: async () => await survival.secureFood(bot),
            }),
        });
    }

    const missingCoreTools = [
        !bot.inventory.items().some(item => item.name.endsWith('_pickaxe')),
        !bot.inventory.items().some(item => item.name.endsWith('_axe')),
        !bot.inventory.items().some(item => item.name.endsWith('_sword')),
    ].filter(Boolean).length;
    if (missingCoreTools && !cooling(agent, 'toolfix', 20_000)) {
        candidates.push({
            key: 'maintenance:coreTools',
            source: 'maintenance',
            actionName: 'maintainTools',
            utility: 100,
            urgency: missingCoreTools * 6,
            priority: 18,
            reason: `${missingCoreTools} core tool${missingCoreTools === 1 ? '' : 's'} missing`,
            onSelected: () => mark(agent, 'toolfix'),
            createAction: () => ({
                name: 'maintainTools', timeout: 2, fn: async () => await survival.maintainTools(bot),
            }),
        });
    }

    const stoneBaseline = society.hasSocietyStoneBaseline(bot);
    bot._societyStoneBaseline = stoneBaseline;
    const cleanPublicWoodenGear = isCoordinator(agent, bot)
        && !cooling(agent, 'publicWoodenCleanup', 30 * 60_000);
    if (stoneBaseline && (survival.hasObsoleteWoodenEquipment(bot) || cleanPublicWoodenGear)) {
        candidates.push({
            key: 'maintenance:obsoleteWoodenGear',
            source: 'maintenance',
            actionName: 'obsoleteGear',
            utility: 34,
            reason: 'stone baseline makes wooden equipment obsolete',
            createAction: () => ({
                name: 'obsoleteGear',
                timeout: 4,
                fn: async () => {
                    mark(agent, 'publicWoodenCleanup');
                    return await survival.discardObsoleteWoodenEquipment(bot, cleanPublicWoodenGear);
                },
            }),
        });
    }

    const publicStorage = storage.getPublicStorage(bot);
    if (publicStorage && !cooling(agent, 'publicHubGear', 10 * 60_000)) {
        candidates.push({
            key: 'environment:publicHubGear',
            source: 'environment',
            actionName: 'publicHubGear',
            utility: 52,
            reason: 'the periodic shared-equipment check is due',
            createAction: () => ({
                name: 'publicHubGear',
                timeout: 5,
                fn: async () => {
                    const success = await progression.claimSharedEquipment(bot);
                    mark(agent, 'publicHubGear');
                    return success;
                },
            }),
        });
    }

    if (base.needsPublicRestock(bot) && !cooling(agent, 'publicHubRestock', 3 * 60_000)) {
        candidates.push({
            key: 'environment:publicHubRestock',
            source: 'environment',
            actionName: 'publicHubRestock',
            utility: 70,
            reason: 'everyday supplies are missing and public storage is available',
            createAction: () => ({
                name: 'publicHubRestock',
                timeout: 3,
                fn: async () => {
                    const success = await base.restockFromPublic(bot);
                    agent._brain.publicHubRestock = success ? Date.now() : Date.now() - 60_000;
                    return success;
                },
            }),
        });
    }

    if (!cooling(agent, 'kingdomShare', 60_000)) {
        const transfer = society.findSupplyShare(agent);
        if (transfer) {
            candidates.push({
                key: 'society:shareSupplies',
                source: 'society',
                actionName: 'kingdomShare',
                utility: 82,
                urgency: 18,
                reason: 'a nearby member has an urgent supply shortage',
                onSelected: () => mark(agent, 'kingdomShare'),
                createAction: () => ({
                    name: 'kingdomShare', timeout: 2, fn: async () => await society.shareSupplies(agent, transfer),
                }),
            });
        }
    }

    if (publicStorage && base.shouldVisitPublicStorage(bot)
        && !cooling(agent, 'publicHubDeposit', 4 * 60_000)) {
        candidates.push({
            key: 'society:publicHubDeposit',
            source: 'society',
            actionName: 'publicHubDeposit',
            utility: 44,
            reason: 'surplus should be contributed to shared storage',
            createAction: () => ({
                name: 'publicHubDeposit',
                timeout: 3,
                fn: async () => {
                    const success = await base.stash(bot);
                    agent._brain.publicHubDeposit = success ? Date.now() : Date.now() - 60_000;
                    return success;
                },
            }),
        });
    }

    const emptySlots = bot.inventory.emptySlotCount();
    if (emptySlots <= 2) {
        const anchor = base.getPersonalAnchor(bot);
        const far = anchor && bot.entity
            && bot.entity.position.distanceTo(new Vec3(anchor.x, anchor.y, anchor.z)) > 100;
        candidates.push({
            key: 'environment:stashInventory',
            source: 'environment',
            actionName: 'stash',
            utility: 88,
            urgency: (3 - emptySlots) * 12,
            reason: `only ${emptySlots} inventory slot${emptySlots === 1 ? '' : 's'} remain`,
            createAction: () => ({
                name: 'stash', timeout: far ? 12 : 2, fn: async () => await base.stash(bot),
            }),
        });
    }

    // This probe is deliberately throttled even when no work is needed; otherwise
    // checking an already-healthy public hub would run on every idle brain tick.
    if (!cooling(agent, 'storageCheck', 300_000)) {
        if (storage.publicStorageNeedsMaintenance(bot)) {
            candidates.push({
                key: 'society:storageMaintenance',
                source: 'society',
                actionName: 'storage',
                utility: 46,
                reason: 'public storage needs repair or expansion',
                onSelected: () => mark(agent, 'storageCheck'),
                createAction: () => ({
                    name: 'storage', timeout: 4, fn: async () => await storage.setupPublicStorage(bot),
                }),
            });
        } else {
            mark(agent, 'storageCheck');
        }
    }

    const homeLifeAction = homeLife.planHomeLifeAction(agent, progressStatus);
    if (homeLifeAction) {
        const homeLifePriority = {
            homeSleep: { utility: 96, urgency: 25, reason: 'night-time rest is available at home' },
            morningPrep: { utility: 62, urgency: 8, reason: 'morning preparation is due' },
            setupHomeLife: { utility: 58, urgency: 6, reason: 'home utilities or lighting need attention' },
        }[homeLifeAction.name] ?? { utility: 50, urgency: 0, reason: 'home-life maintenance is due' };
        candidates.push({
            key: `environment:${homeLifeAction.name}`,
            source: 'environment',
            actionName: homeLifeAction.name,
            ...homeLifePriority,
            createAction: () => homeLifeAction,
        });
    }

    if (!cooling(agent, 'expeditionCheck', 8_000)) {
        candidates.push({
            key: 'environment:miningExpedition',
            source: 'environment',
            utility: mining.expeditionOpenOrDue() ? 82 : 58,
            urgency: bot._miningExpeditionActive ? 30 : 0,
            reason: 'shared ore shortage or scheduled expedition',
            commitmentBonus: 20,
            onSelected: () => mark(agent, 'expeditionCheck'),
            createAction: () => mining.planExpeditionAction(agent),
        });
    }

    if (!bot._miningExpeditionActive && progressStatus.milestones?.stoneTools === true) {
        const coordinatorSweep = isCoordinator(agent, bot) && Boolean(storage.getPublicStorage(bot));
        const carriedReady = survival.smeltableStock(bot) >= 4
            && !cooling(agent, 'smeltStock', 3 * 60_000);
        const sweepReady = coordinatorSweep && !cooling(agent, 'smeltStockSweep', 10 * 60_000);
        if (carriedReady || sweepReady) {
            candidates.push({
                key: 'environment:smeltStock',
                source: 'environment',
                utility: carriedReady ? 64 : 48,
                reason: carriedReady ? 'carried raw stock is ready to process' : 'public raw-stock sweep is due',
                onSelected: () => {
                    mark(agent, 'smeltStock');
                    mark(agent, 'smeltStockSweep');
                },
                createAction: () => ({ name: 'smeltStock', timeout: 6, fn: async () =>
                    await survival.smeltStockpile(bot, { pullFromStorage: coordinatorSweep }) }),
            });
        }
    }

    const socialReady = socialGoalReady(progressStatus);
    if (!socialReady && agent._plan?.focus === 'social') agent._plan.completed = true;
    if (socialReady) {
        candidates.push({
            key: 'society:socialGoal',
            source: 'society',
            utility: 64,
            reason: 'a concrete helping or gifting opportunity may be available',
            createAction: () => socialGoals.planSocialAction(agent, home),
        });
    }

    candidates.push({
        key: 'society:routine',
        source: 'society',
        utility: 54,
        reason: 'settlement role and shared infrastructure work',
        createAction: () => societyAction(agent, home, progressStatus),
    });

    if (activePlan && agent._plan.priority !== 'high') {
        candidates.push({
            key: `ai:${agent._plan.planId ?? agent._plan.focus}`,
            source: 'ai',
            utility: 60,
            reason: agent._plan.project ?? `${agent._plan.focus} plan`,
            commitmentBonus: 16,
            createAction: () => focusAction(agent, home),
        });
    }

    const torches = invCount(bot, 'torch');
    if (torches < 4 && !cooling(agent, 'torch', 180_000)) {
        candidates.push({
            key: 'environment:torches',
            source: 'environment',
            utility: 66 + (4 - torches) * 5,
            urgency: bot._miningExpeditionActive ? 18 : 0,
            reason: `only ${torches} torches remain`,
            onSelected: () => mark(agent, 'torch'),
            createAction: () => ({ name: 'torches', timeout: 2, fn: async () => await survival.makeTorches(bot, 8, false) }),
        });
    }

    const urgentRecoveryFarm = survival.needsFoodBeforeHealing(bot);
    const farmCooldown = urgentRecoveryFarm ? 30_000 : 120_000;
    if (home && !cooling(agent, 'farm', farmCooldown)) {
        candidates.push({
            key: 'environment:farm',
            source: 'environment',
            utility: urgentRecoveryFarm
                ? 100
                : 38 + Math.max(0, 16 - Number(bot.food ?? 20)) * 3,
            urgency: urgentRecoveryFarm ? 50 : 0,
            reason: urgentRecoveryFarm
                ? 'healing is blocked until the settlement produces food'
                : 'farm maintenance responds to food pressure',
            onSelected: () => mark(agent, 'farm'),
            createAction: () => ({ name: 'farm', timeout: 5, fn: async () => await survival.tendFarm(bot) }),
        });
    }

    if (!cooling(agent, 'tools', 300_000)) {
        candidates.push({
            key: 'maintenance:tools',
            source: 'maintenance',
            utility: 48,
            reason: 'periodic durability and tool check',
            onSelected: () => mark(agent, 'tools'),
            createAction: () => ({ name: 'maintainTools', timeout: 2, fn: async () => await survival.maintainTools(bot) }),
        });
    }

    const wood = invCount(bot, LOGS);
    if (wood < WOOD_STOCK) {
        candidates.push({
            key: 'environment:gatherWood',
            source: 'environment',
            utility: 30 + Math.min(32, WOOD_STOCK - wood),
            reason: `wood reserve ${wood}/${WOOD_STOCK}`,
            createAction: () => {
                const target = findTarget(bot, LOGS);
                if (target)
                    return { name: 'gatherWood', timeout: 2, fn: async () => await skills.collectBlock(bot, target, 4) };
                if (!cooling(agent, 'woodsearch', 12_000)) {
                    return {
                        name: 'gatherWood',
                        timeout: 1,
                        onStart: () => mark(agent, 'woodsearch'),
                        fn: async () => await skills.moveAway(bot, 8),
                    };
                }
                return null;
            },
        });
    }

    const stone = invCount(bot, 'cobblestone');
    if (stone < STONE_STOCK) {
        candidates.push({
            key: 'environment:gatherStone',
            source: 'environment',
            utility: 28 + Math.min(32, STONE_STOCK - stone),
            reason: `stone reserve ${stone}/${STONE_STOCK}`,
            createAction: () => {
                const target = findTarget(bot, ['stone']);
                if (target)
                    return { name: 'gatherStone', timeout: 2, fn: async () => await skills.collectBlock(bot, 'stone', 4) };
                if (!cooling(agent, 'stonesearch', 12_000)) {
                    return {
                        name: 'gatherStone',
                        timeout: 1,
                        onStart: () => mark(agent, 'stonesearch'),
                        fn: async () => await skills.moveAway(bot, 8),
                    };
                }
                return null;
            },
        });
    }

    candidates.push({
        key: 'ambient:idle',
        source: 'ambient',
        utility: 1,
        available: !cooling(agent, 'idle', 20_000),
        reason: 'no stronger goal is currently actionable',
        onSelected: () => mark(agent, 'idle'),
        createAction: () => ({ name: 'idle', timeout: 1, fn: async () => await idleWander(bot, home) }),
    });
    return candidates;
}

function chooseDynamicAction(agent, home, progressStatus) {
    return decisionGraph.chooseDecision(
        agent,
        dynamicDecisionCandidates(agent, home, progressStatus),
        { stage: progressStatus.stage },
    );
}

function chooseAction(agent, progressStatus) {
    const bot = agent.bot;
    const home = base.getBase(bot);

    // Recover even when a build was interrupted or the process restarted while
    // Minecraft persisted the player in creative.
    if (bot._mustReturnToSurvival
        || bot._creativeBuildActive
        || bot._creativeBuildFlying
        || (!['creative', 'god_mode'].includes(settings.base_profile) && bot.game.gameMode === 'creative')) {
        const landing = home ? new Vec3(home.x, home.y, home.z) : null;
        return {
            name: 'restoreSurvival',
            timeout: 1,
            fn: async () => await build.recoverBuilderState(bot, landing),
        };
    }

    if (bot._miningRecoveryRequested || agent._brain.needsSurfaceRecovery) {
        return {
            name: 'escapeToSurface',
            timeout: 2,
            fn: async () => {
                const attempted = await survival.recoverFromMiningTrap(bot) || await skills.goToSurface(bot);
                const escaped = attempted && survival.isSurfaceRecoveryComplete(bot);
                if (escaped) {
                    agent._brain.needsSurfaceRecovery = false;
                    bot._miningRecoveryRequested = false;
                }
                return escaped;
            },
        };
    }

    // Reactive modes and entity events publish into this queue. Consuming the
    // request here keeps one owner for ActionManager execution and prevents a mode
    // action from racing the decision selected by this same brain tick.
    const queuedSafety = decisionGraph.takeSafetyAction(agent);
    if (queuedSafety) return queuedSafety;

    const foodRescueCooling = cooling(agent, 'emergencyFood', 20_000);
    const recoveryAction = survival.recoveryActionKind(bot, foodRescueCooling);
    if (recoveryAction === 'food') {
        return markOnStart(agent, ['emergencyFood'], {
            name: 'emergencyFood', timeout: 2, fn: async () => await survival.secureFood(bot),
        });
    }

    // Only wait for passive healing when the bot can actually regenerate. If the
    // food rescue is cooling and no meal exists, fall through to the high-urgency
    // farm candidate above instead of livelocking in recoverHealth.
    if (recoveryAction === 'health') {
        return {
            name: 'recoverHealth',
            timeout: 1,
            fn: async () => await survival.recoverHealth(bot),
        };
    }

    const societyRole = society.getRole(agent);
    if (societyRole === 'healer'
        && !cooling(agent, 'healerSpell', magic.healerCooldownMs())) {
        const healingTarget = magic.findHealingTarget(agent);
        if (healingTarget) {
            return {
                name: 'healerSupport',
                timeout: 1,
                fn: async () => {
                    const healed = await magic.healMember(agent, healingTarget);
                    if (healed) mark(agent, 'healerSpell');
                    return healed;
                },
            };
        }
    }

    // The magician owns nearby hostile combat: a visible, non-explosive particle
    // projectile lands for exactly the configured magic damage instead of melee.
    if (societyRole === 'magician') {
        const magicThreat = social.findCoordinatedThreat(
            bot,
            Math.max(8, Number(settings.kingdom_magician_range ?? 24)),
        );
        if (magicThreat) {
            if (cooling(agent, 'magicianSpell', magic.magicianCastCooldownMs())) {
                const retryAt = Number(agent._brain.magicianSpell ?? Date.now())
                    + magic.magicianCastCooldownMs();
                return {
                    name: 'magicRecharge',
                    timeout: 1,
                    fn: async () => actionOutcome('waiting', {
                        blocker: 'magicianSpell',
                        retryAt,
                        message: 'hostile remains visible while the magician spell recharges',
                    }),
                };
            }
            return {
                name: 'magicianFireball',
                timeout: 1,
                fn: async () => {
                    const cast = await magic.castFireball(agent, magicThreat);
                    if (cast) mark(agent, 'magicianSpell');
                    return cast;
                },
            };
        }
    }

    // 0. Any member may respond across the settlement and prefer safe ranged combat.
    if (settings.kingdom_guardians !== false) {
        const queuedThreat = agent._brain.guardThreat;
        const guardianThreat = queuedThreat?.entity?.position
            && queuedThreat.entity.isValid !== false
            ? queuedThreat
            : social.findGuardianThreat(bot);
        agent._brain.guardThreat = null;
        if (guardianThreat) {
            return {
                name: 'guardianDefense',
                timeout: 1,
                fn: async () => await guardian.protectSociety(agent, guardianThreat),
            };
        }
    }

    // Other members still help with an immediate threat in arm's reach.
    // Prefer the coordinated focus-fire target so nearby members gang up on the
    // same mob; fall back to the plain nearest-threat picker.
    const threat = skills.canFightAtCurrentHealth(bot)
        ? (social.findCoordinatedThreat(bot) ?? social.findThreatToSociety(bot))
        : null;
    if (threat) return { name: 'defendSociety', timeout: 1, fn: async () => {
        if (cognitionSettings().controller_enabled !== true) {
            try { bot.chat('Hold on, I\'m coming!'); } catch { /* */ }
        }
        return await combat.engage(agent, threat);
    } };

    // Active expeditions are group operations. Once drafted, a member must keep
    // rallying/descending/retreating before routine home leash, farming, storage, or
    // cleanup can pull the party apart.
    const activeExpedition = mining.planExpeditionAction(agent, { startIfDue: false });
    if (activeExpedition) return activeExpedition;

    // 1. leash: keep close to base (tightened so they don't run off).
    // Escape hatch: if goHome itself keeps failing (no reachable path home, and the
    // /tp emergency recovery is silently refused on a non-OP server) it lands in
    // backoff. Returning it anyway would FREEZE the bot — brainTick short-circuits on a
    // blocked action — so it stands idle, neither working nor getting home (the Lara
    // livelock: 833 goHome picks, 2 successes over 3h). While goHome is backed off, fall
    // through to local survival/gather work; the leash retries once backoff clears.
    const homeBackoff = agent._brain.actionBackoff?.goHome;
    const goHomeBlocked = homeBackoff && Date.now() < homeBackoff.retryAt;
    if (home && !goHomeBlocked && base.distanceFromHome(bot) > home.radius + 20) {
        // A lost bot far beyond pathfinder range travels home in waypoint hops;
        // that is a multi-minute trip, so give it room before re-deciding.
        const timeout = base.distanceFromHome(bot) > 100 ? 12 : 2;
        return { name: 'goHome', timeout, fn: async () => await base.goHome(bot) };
    }

    // Only safety, immediate defense, active expedition membership and the home
    // leash stay above the arbiter. Routine survival, storage and home-life work
    // all compete in the graph below.
    return chooseDynamicAction(agent, home, progressStatus);
}

async function idleWander(bot, home) {
    const cx = home ? home.x : bot.entity.position.x;
    const cy = home ? home.y : bot.entity.position.y;
    const cz = home ? home.z : bot.entity.position.z;
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * (home ? home.radius : 6);
    return await skills.goToPosition(bot, Math.floor(cx + Math.cos(angle) * dist), cy, Math.floor(cz + Math.sin(angle) * dist), 2);
}

// Mineflayer's pathfinder can occasionally keep an unresolved goal alive without
// rejecting. Interrupt only real movement actions that made virtually no progress
// for 20 seconds; crafting/smelting/standing actions are deliberately ignored.
function checkStrandedBelowSettlement(agent) {
    const bot = agent.bot;
    const strandedDepth = Math.max(8, Number(settings.mining_stranded_depth ?? 16));
    if (!bot?.entity || !survival.isBelowSettlement(bot, strandedDepth) || bot._miningExpeditionActive) {
        agent._brain.strandedSample = null;
        return false;
    }

    const actionName = agent.actions.currentActionLabel.replace(/^brain:/, '');
    const activeMining = agent.actions.executing
        && /mining|mine|Iron|Coal|Gold|Lapis|Diamond|progress:iron|progress:diamond/i.test(actionName);

    const now = Date.now();
    const pos = bot.entity.position;
    const sample = agent._brain.strandedSample;
    if (!sample || pos.distanceTo(sample.pos) > 0.8) {
        agent._brain.strandedSample = { pos: pos.clone(), since: now };
        return false;
    }
    const configuredWaitMs = Math.max(5000, Number(settings.mining_stranded_seconds ?? 15) * 1000);
    // Legitimate mining can stand still while breaking a hard block, but it must
    // not disable recovery forever. The previous early return reset the sample on
    // every check, so a hung manual mine action could remain underground until its
    // multi-minute action timeout.
    const waitMs = activeMining ? Math.max(45_000, configuredWaitMs * 3) : configuredWaitMs;
    if (now - sample.since < waitMs) return false;
    if (now - (agent._brain.lastStrandedRecovery ?? 0) < waitMs) return false;

    agent._brain.lastStrandedRecovery = now;
    agent._brain.needsSurfaceRecovery = true;
    bot._miningRecoveryRequested = true;
    console.warn(`[brain ${agent.name}] stranded below settlement during ${actionName || 'idle'}; forcing surface recovery`);
    if (agent.actions.executing) {
        try { agent.requestInterrupt(); } catch { /* bot may be disconnecting */ }
    } else if (!bot._emergencySurfaceRescue) {
        bot._emergencySurfaceRescue = true;
        void survival.emergencyReturnHome(bot, 'stranded underground')
            .then(escaped => {
                if (escaped) {
                    agent._brain.needsSurfaceRecovery = false;
                    agent._brain.strandedSample = null;
                    bot._miningRecoveryRequested = false;
                }
            })
            .catch(error => console.warn(`[brain ${agent.name}] emergency surface return failed: ${error.message}`))
            .finally(() => { bot._emergencySurfaceRescue = false; });
    }
    return true;
}

function checkLongStuckAwayFromHome(agent) {
    const bot = agent.bot;
    const home = base.getBase(bot);
    if (!bot?.entity || !home || agent.actions.executing) {
        agent._brain.longStuckSample = null;
        return false;
    }

    const pos = bot.entity.position;
    const homePos = new Vec3(home.x, home.y, home.z);
    const minimumDistance = Math.max(
        Number(home.radius ?? 10) + 6,
        Number(settings.stuck_home_reset_distance ?? 18),
    );
    if (pos.distanceTo(homePos) <= minimumDistance) {
        agent._brain.longStuckSample = null;
        return false;
    }

    const now = Date.now();
    const sample = agent._brain.longStuckSample;
    if (!sample || pos.distanceTo(sample.pos) > 1.25) {
        agent._brain.longStuckSample = { pos: pos.clone(), since: now };
        return false;
    }

    const resetAfterMs = Math.max(30_000, Number(settings.stuck_home_reset_seconds ?? 90) * 1000);
    if (now - sample.since < resetAfterMs || bot._emergencyHomeReset) return false;

    bot._emergencyHomeReset = true;
    agent._brain.longStuckSample = { pos: pos.clone(), since: now };
    console.warn(`[brain ${agent.name}] idle and stuck ${Math.round(pos.distanceTo(homePos))} blocks from setHome; resetting home`);
    void survival.emergencyReturnHome(bot, 'long stuck watchdog')
        .then(reset => {
            if (reset) {
                agent._brain.longStuckSample = null;
                agent._brain.stuckSample = null;
                agent._brain.strandedSample = null;
                agent._brain.needsSurfaceRecovery = false;
                bot._miningRecoveryRequested = false;
            }
        })
        .catch(error => console.warn(`[brain ${agent.name}] setHome reset failed: ${error.message}`))
        .finally(() => { bot._emergencyHomeReset = false; });
    return true;
}

function checkStuck(agent) {
    const bot = agent.bot;
    if (checkStrandedBelowSettlement(agent)) return;
    if (checkLongStuckAwayFromHome(agent)) return;
    const moving = Boolean(bot.pathfinder?.isMoving?.());
    if (!agent.actions.executing || !moving || !bot.entity) {
        agent._brain.stuckSample = null;
        return;
    }

    const now = Date.now();
    const pos = bot.entity.position;
    const sample = agent._brain.stuckSample;
    if (!sample || pos.distanceTo(sample.pos) > 0.8) {
        agent._brain.stuckSample = { pos: pos.clone(), since: now };
        return;
    }
    if (now - sample.since < 20_000) return;
    if (now - (agent._brain.lastStuckBreak ?? 0) < 20_000) return;

    agent._brain.lastStuckBreak = now;
    agent._brain.stuckSample = { pos: pos.clone(), since: now };
    const actionName = agent.actions.currentActionLabel.replace(/^brain:/, '');
    agent._brain.actionBackoff ??= {};
    const failures = (agent._brain.actionBackoff[actionName]?.failures ?? 0) + 1;
    agent._brain.actionBackoff[actionName] = { failures, retryAt: now + 15000 };
    const home = base.getBase(bot);
    const miningAction = /mining|mine|Iron|Coal|Gold|Lapis|Diamond|Stockpile|progress:iron|progress:diamond/i.test(actionName);
    if (actionName === 'goHome' && home && pos.y < home.y - 3)
        agent._brain.needsSurfaceRecovery = true;
    if (miningAction && (survival.isOpenCaveTrap(bot) || (home && pos.y < home.y - 6)))
        agent._brain.needsSurfaceRecovery = true;
    console.warn(`[brain ${agent.name}] stuck during ${agent.actions.currentActionLabel}; interrupting path`);
    try { agent.requestInterrupt(); } catch { /* */ }
}

// Free, contextual ambient lines (no LLM). Throttled + only when a player is near to hear.
const AMBIENT = {
    gearUp: ['There, tools are ready.', 'Now I\'m properly equipped.', 'Axe and pickaxe, let\'s go.'],
    gatherWood: ['Just gathering a bit more wood.', 'Firewood always comes in handy.'],
    gatherStone: ['Off to dig a little.', 'Stone is always worth it.'],
    stash: ['There, everything stashed away.', 'The chest is full again.'],
    setupBase: ['The base is taking shape.', 'Home needs some sorting out.'],
    goHome: ['Heading back to base.', 'I wandered a bit too far.'],
    getIron: ['Going for iron.', 'Digging around for some ore.', 'Iron would come in handy.'],
    secureFood: ['Getting a bit hungry.', 'Off to find something to eat.'],
    farm: ['The farm needs tending.', 'The wheat is growing nicely.'],
    torches: ['I\'ll light up the area a bit.', 'Torches always come in handy.'],
    smeltStock: ['Off to smelt some ore.', 'Let the furnace work, ingots are useful.', 'Raw materials go in the furnace.'],
    maintainTools: ['My tools need some upkeep.', 'This pickaxe has seen better days.'],
    kingdomShare: ['Here, this should come in handy.', 'It\'s easier together.'],
    kingdomContribute: ['Taking supplies to the shared storage.', 'This one\'s for the common good.'],
    kingdomStorage: ['Organizing our shared storage.', 'Supplies need some order.'],
    kingdomFarm: ['I\'ll see to the settlement\'s food.', 'The farm is everyone\'s business.'],
    kingdomRoads: ['Connecting our buildings.', 'The path will be lit at night too.'],
    kingdomStockpile: ['Gathering supplies for everyone.', 'The settlement needs materials.'],
    kingdomEnchanting: ['Let me see what I can enchant.', 'Good gear is worth some lapis.'],
    kingdomTorches: ['Making torches for safer settlement work.', 'We need more light before nightfall.'],
    kingdomGuardianGear: ['Checking if we have better protective gear.', 'A guardian must be well equipped.'],
    guardianDefense: ['Hold on, I\'m coming!', 'Protecting our people.'],
    publicHubGear: ['There\'s better gear in the shared storage.', 'I can put this equipment to good use.'],
    publicHubDeposit: ['Taking my surplus to the shared chests.', 'This is more useful in public storage.'],
    publicHubRestock: ['Checking what\'s in the shared storage.', 'Picking up the things I need.'],
    obsoleteGear: ['This wooden gear has served its time.', 'Stone equipment is the standard now.'],
    kingdomPatrol: ['I\'ll check the surroundings.', 'Keeping an eye on our settlement.'],
    idle: ['Nice day, isn\'t it?', 'Peaceful today.'],
};
// Free, player-like: when a real player comes close, greet them by name (no LLM).
const GREETS = (n) => [`Oh, hey ${n}!`, `Hi ${n}, how's it going?`, `Welcome, ${n}.`, `Look who's here, ${n}!`, `Hello ${n}.`];
function botNames() {
    try { return serverProxy.getAgents().map(a => (typeof a === 'string' ? a : a?.name)).filter(Boolean).map(s => s.toLowerCase()); }
    catch { return []; }
}
function greetNearby(agent) {
    const bot = agent.bot;
    if (Date.now() - (agent._brain.lastGreet ?? 0) < 30_000) return; // global throttle
    const others = botNames();
    const greeted = (agent._brain.greeted ??= {});
    for (const p of Object.values(bot.players)) {
        if (!p.entity || p.username === bot.username) continue;
        if (others.includes(p.username.toLowerCase())) continue;     // skip fellow bots
        if (p.entity.position.distanceTo(bot.entity.position) > 5) continue;
        if (Date.now() - (greeted[p.username] ?? 0) < 5 * 60_000) continue; // once per player / 5 min
        if (Math.random() < 0.4) return;                              // not every time
        greeted[p.username] = Date.now();
        agent._brain.lastGreet = Date.now();
        try { bot.lookAt(p.entity.position.offset(0, 1.5, 0)); } catch { /* */ }
        const g = GREETS(p.username);
        if (cognitionSettings().controller_enabled === true) {
            cognition.speakIntention(agent, {
                topic: 'greet',
                speechIntent: 'greet',
                socialTarget: p.username,
                actionName: 'social:greet',
                label: `pozdravljam ${p.username}`,
                ts: Date.now(),
            }, { force: true });
            return;
        }
        bot.chat(g[Math.floor(Math.random() * g.length)]);
        return;
    }
}

// ── ALTERA/PIANO Phase 1 — Action Awareness reactions (see ALTERA_PLAN.md) ──────────
// Runs on the 4s social timer (even mid-action). Gated by settings.cognition.awareness_enabled.
// assessAwareness() is deterministic + cheap; here we only ACT on its two signals:
//   (a) planStalled  -> abandon a focus that's going nowhere so the planner picks a new one,
//   (b) high frustration + a player nearby -> a free templated "this isn't working" line.
// DOC DISCIPLINE: if you change this, update awareness.js + ALTERA_PLAN.md (§5/§8). Leave
// this same reminder for the next editor.
const FRUSTRATION_LINES = [
    'Tole pa ne gre, kot bi moralo.',
    'Hmm, nekaj se mi zatika.',
    'Ne najdem prave poti do tega.',
    'Tole mi danes ne gre od rok.',
    'Bom poskusil drugače.',
];

function playerWithin(bot, range) {
    return Object.values(bot.players).some(p =>
        p.entity && p.username !== bot.username && p.entity.position.distanceTo(bot.entity.position) < range);
}

function reflectAwareness(agent) {
    if (cognitionSettings().awareness_enabled !== true) return;
    const assessment = awareness.assessAwareness(agent);
    agent._awareness = assessment; // published to Agent State for later cognition phases

    // (a) A focus with a countable target that hasn't moved for plan_stall_seconds is
    // unreachable from here (e.g. stockpile wood with no trees around). Mark it done so
    // chooseAction stops driving it and the next local plan replaces it. Harmless if the
    // bot wasn't pursuing it anyway.
    if (assessment.flags.planStalled && agent._plan && !agent._plan.completed) {
        agent._plan.completed = true;
        console.log(`[aware ${agent.name}] plan '${agent._plan.focus}/${agent._plan.resource ?? '-'}' stalled; abandoning so the planner can replan`);
    }

    // (b) Voice frustration occasionally, only when a player is near to hear it. Shares the
    // ambient throttle so awareness + ambient lines together stay rare.
    maybeFrustrationAmbient(agent, assessment);
}

function maybeFrustrationAmbient(agent, assessment) {
    // Single speech gate: when the Phase 2 controller is on, it voices frustration itself
    // (via the 'frustrated' speechIntent), so this Phase 1 path stands down to avoid double talk.
    const cog = cognitionSettings();
    if (cog.controller_enabled === true) return;
    if (cog.frustration_ambient === false) return;
    if (assessment.frustration < 0.6) return;
    const bot = agent.bot;
    if (Date.now() - (agent._brain.lastAmbient ?? 0) < AMBIENT_COOLDOWN_MS) return;
    if (!playerWithin(bot, 16)) return;
    if (Math.random() < 0.5) return; // not every eligible moment
    agent._brain.lastAmbient = Date.now();
    try { bot.chat(FRUSTRATION_LINES[Math.floor(Math.random() * FRUSTRATION_LINES.length)]); } catch { /* */ }
}

function maybeAmbient(agent, actionName) {
    // Single speech gate (ALTERA/PIANO Phase 2): when the controller owns autonomous
    // speech, the legacy action-keyed ambient lines stand down to avoid two speech sources.
    if (cognitionSettings().controller_enabled === true) return;
    const bot = agent.bot;
    if (Date.now() - agent._brain.lastAmbient < AMBIENT_COOLDOWN_MS) return;
    const near = Object.values(bot.players).some(p =>
        p.entity && p.username !== bot.username && p.entity.position.distanceTo(bot.entity.position) < 16);
    if (!near) return;
    const pool = AMBIENT[actionName];
    if (!pool || Math.random() < 0.5) return; // not every eligible moment
    agent._brain.lastAmbient = Date.now();
    bot.chat(pool[Math.floor(Math.random() * pool.length)]);
}
