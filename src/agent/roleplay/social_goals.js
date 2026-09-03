// ============================================================================
// Social Goal Generation — ALTERA / PIANO plan, PHASE 4  (see repo-root ALTERA_PLAN.md)
// ============================================================================
//
// WHAT THIS IS
// This is the Altera "specialization driver". In Project Sid emergent role
// differentiation comes from agents generating goals out of MODELS OF OTHER AGENTS —
// not from fixed role slots. "I keep supplying Rok because Rok keeps running out of
// food" is a recursive social goal: it is grounded in what THIS bot believes about
// ANOTHER bot. Repeated, that turns one bot into the de-facto supplier of another
// (specialization) without anyone scripting it.
//
// WHAT IT DOES HERE (deterministic, LLM-FREE, cheap)
//   generateSocialGoals(agent, state) proposes 0..N candidate social goals, each with a
//   priority SCORE derived from (a) the Phase-3 opinion model of others (what they need /
//   how capable they are), (b) the directed social graph (friendship/debt/rivalry), and
//   (c) THIS bot's personality traits (altruism -> help, ambition+rivalry -> out-produce,
//   ambition -> impress the player, orderliness -> cover the unfilled gap).
//
//   Goal kinds:
//     help:<member>        deliver a surplus item the member visibly lacks  (DELIVERABLE)
//     impress_player       gift a nearby player a useful surplus item        (DELIVERABLE)
//     outproduce:<member>  beat a rival on the settlement's needed resource  (context bias)
//     cover_gap:<resource> stockpile what the settlement lacks + nobody works (context bias)
//
//   Only the DELIVERABLE kinds have a concrete deterministic action (give an item to a
//   specific recipient) — that is the genuinely NEW social behavior (ranged, unprompted
//   gifting). The two "bias" kinds are surfaced to the planner prompt so the LLM can lean
//   into them via its resource/say choices; the existing role/stockpile machinery already
//   executes resource work, so we do NOT add a duplicate gather here.
//
// HOW IT FITS THE AGENT STATE (ALTERA_PLAN.md §4)
//   input : cognition.assembleState(agent) — society.members, socialOpinions (Phase 3),
//           relations (social graph), nearbyPlayers, society.resourceNeed; + my inventory.
//   output: a ranked goal list. topSocialGoal() picks the best DELIVERABLE one;
//           planSocialAction() turns it into a bounded brain action (execution stays
//           deterministic: society.shareSupplies / skills.giveToPlayer + goto).
//           socialGoalContext() is a compact string fed into the planner prompt.
//
// WIRING (current, all behind settings.cognition.social_goals_enabled):
//   - brain.js chooseAction: a deterministic step (below society role work, above the
//     optional AI focus) calls planSocialAction(agent, home) so help/gifting happens even
//     with the LLM off — the fallback the plan requires.
//   - brain.js focusAction: a `social` plan focus (when the planner picks it) delegates
//     here so the LLM-chosen social goal executes through the SAME deterministic path.
//   - planner.js: socialGoalContext(agent) + Phase-3 socialContext(agent) enrich BOTH the
//     society and local planner prompts; `social` is an allowed focus when the flag is on.
//   - cognition.js: the resulting action name maps to the `help` intention topic, and
//     agent._brain.pendingShareTarget lets speakIntention name the recipient.
//
// ----------------------------------------------------------------------------
// DOCUMENTATION DISCIPLINE (applies to EVERY file in the Altera/PIANO effort)
//   If you change this module: (1) keep these comments true, (2) update ALTERA_PLAN.md
//   §5 (this phase) and §8 (Status table) in the SAME change, (3) keep it deterministic —
//   no cloud call belongs here; goal generation is pure scoring. Leave this reminder.
// ----------------------------------------------------------------------------

import settings from '../settings.js';
import * as world from '../library/world.js';
import * as society from '../library/society.js';
import * as skills from '../library/skills.js';
import * as culture from '../library/culture.js';
import * as mc from '../../utils/mcdata.js';
import { getPersonality } from './personality.js';
import { relationsFor, updateMutual } from './social_graph.js';
import { getSocialModel } from './social_awareness.js'; // Phase 3 opinion model of the other agents

const FOOD = new Set([
    'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    'baked_potato', 'apple', 'carrot', 'golden_carrot', 'cooked_cod',
    'cooked_salmon', 'cooked_rabbit',
]);

// A goal must clear this to be worth acting on, so bots don't gift on a whim.
const MIN_DELIVER_SCORE = 0.42;
// Cooldowns for the deterministic brain step (keyed on agent._brain).
const HELP_COOLDOWN_MS = 90_000;
const CHECK_IN_COOLDOWN_MS = 150_000;
const GIFT_COOLDOWN_MS = 6 * 60_000;

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function normalizeNeed(need) {
    return String(need ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

function normalizeNeeds(needs = []) {
    return [...new Set(needs.map(normalizeNeed).filter(Boolean))];
}

function cognitionSettings() {
    return settings.cognition ?? {};
}

export function socialGoalsEnabled() {
    return cognitionSettings().social_goals_enabled === true;
}

// What does a member visibly lack? Mirrors society.findSupplyShare / social_awareness so
// the goal generator, the deterministic sharer, and the opinion model all agree on "needs".
function deriveNeeds(inv = {}) {
    const needs = [];
    if ((inv.food ?? 0) < 2) needs.push('hrana');
    if ((inv.pickaxes ?? 0) < 1) needs.push('kramp');
    if ((inv.swords ?? 0) < 1) needs.push('orozje');
    if ((inv.torches ?? 0) < 2) needs.push('bakle');
    return needs;
}

// My own surplus, from cached inventory counts (no block scan).
function mySupply(bot) {
    const counts = world.getInventoryCounts(bot);
    const sum = predicate => Object.entries(counts)
        .filter(([name]) => predicate(name))
        .reduce((total, [, amount]) => total + amount, 0);
    return {
        counts,
        food: sum(name => FOOD.has(name)),
        torches: counts.torch ?? 0,
        pickaxes: sum(name => name.endsWith('_pickaxe')),
        swords: sum(name => name.endsWith('_sword')),
    };
}

function spareToolName(bot, suffix) {
    const matching = bot.inventory.items().filter(item => item.name.endsWith(suffix));
    return matching.length > 1 ? matching.at(-1)?.name : null;
}

// Concrete gift I can hand over for a given list of needs, or null. Keeps a buffer for
// myself (give food only when I have >= 6, torches only when >= 12, tools only spares).
function pickGift(bot, needs, supply = mySupply(bot)) {
    const normalizedNeeds = normalizeNeeds(needs);
    if (normalizedNeeds.includes('hrana') && supply.food >= 6) {
        const item = bot.inventory.items().find(stack => mc.stackMatchesAnyName(stack, [...FOOD], bot));
        if (item) return { item: item.name, count: Math.min(2, item.count), reason: 'hrana' };
    }
    if (normalizedNeeds.includes('bakle') && supply.torches >= 12)
        return { item: 'torch', count: 4, reason: 'bakle' };
    if (normalizedNeeds.includes('kramp')) {
        const item = spareToolName(bot, '_pickaxe');
        if (item) return { item, count: 1, reason: 'kramp' };
    }
    if (normalizedNeeds.includes('orozje')) {
        const item = spareToolName(bot, '_sword');
        if (item) return { item, count: 1, reason: 'orozje' };
    }
    return null;
}

// Directed relation metrics from me toward `name` (defaults when none recorded yet).
function relationTo(relations, name) {
    const relation = relations.find(r => r.to === name);
    return {
        friendship: relation?.friendship ?? 0.2,
        trust: relation?.trust ?? 0.5,
        respect: relation?.respect ?? 0.5,
        debt: relation?.debt ?? 0,
        rivalry: relation?.rivalry ?? 0,
        annoyance: relation?.annoyance ?? 0,
    };
}

const NEED_LABEL = { hrana: 'hrano', kramp: 'kramp', orozje: 'orozje', bakle: 'bakle' };

// Nearby loaded usernames within hearing range, excluding self and known fellow bots.
function nearbyPlayerNames(bot, exclude = new Set(), range = 16) {
    return Object.values(bot.players)
        .filter(p => p.entity && p.username !== bot.username && !exclude.has(p.username)
            && p.entity.position.distanceTo(bot.entity.position) < range)
        .map(p => p.username);
}

/**
 * Propose ranked social goals from the assembled Agent State. Pure + deterministic.
 * Returns [] when disabled. Each goal: { kind, target, item, count, resource, score,
 * reason, label }. Deliverable goals (help / impress_player) carry item/count.
 */
export function generateSocialGoals(agent, state) {
    if (!socialGoalsEnabled()) return [];
    const bot = agent?.bot;
    if (!bot?.entity) return [];

    const me = agent.personality ?? getPersonality(agent.prompter?.profile ?? agent.name);
    const relations = state?.relations ?? relationsFor(agent.name);
    const opinions = state?.socialOpinions ?? getSocialModel(agent);
    // When no assembled state is passed (planner / standalone brain step), source the same
    // facts directly from the live society so the generator works on its own.
    let members = state?.society?.members;
    if (!members) {
        try { members = society.activeMembers(bot); } catch { members = []; }
    }
    members = members.filter(m => m.name !== agent.name);
    let need = state?.society?.resourceNeed;
    if (need === undefined) {
        try { need = society.getResourceNeed(bot); } catch { need = null; }
    }
    const supply = mySupply(bot);
    const norms = culture.getNorms(agent); // Phase 6: shared culture softly biases social goals
    const sharingNorm = Number(norms.sharing_expectation ?? 0.5);
    const goals = [];

    for (const member of members) {
        const inv = member.inventory ?? {};
        const needs = normalizeNeeds(opinions[member.name]?.needs ?? deriveNeeds(inv));
        const rel = relationTo(relations, member.name);

        // help: I can hand over something this member lacks. The altruism trait, plus the
        // debt I owe them and our friendship, raise the priority; rivalry/annoyance lower it.
        if (needs.length) {
            const gift = pickGift(bot, needs, supply);
            if (gift) {
                const urgent = gift.reason === 'hrana' || gift.reason === 'orozje' ? 0.1 : 0;
                const score = clamp01(0.45 + me.altruism * 0.35 + rel.debt * 0.25
                    + rel.friendship * 0.15 + urgent - rel.rivalry * 0.25 - rel.annoyance * 0.15);
                const culturallyBiasedScore = clamp01(score + (sharingNorm - 0.5) * 0.28);
                goals.push({
                    kind: 'help',
                    target: member.name,
                    item: gift.item,
                    count: gift.count,
                    resource: null,
                    score: culturallyBiasedScore,
                    reason: `${member.name} rabi ${NEED_LABEL[gift.reason] ?? gift.reason}`,
                    label: `pomagam ${member.name}`,
                });
            }
        }

        const concern = Number(member.health ?? 20) < 18 || Number(member.hunger ?? 20) < 12;
        const familiar = rel.friendship > 0.24 || rel.trust > 0.55 || rel.debt > 0.05;
        const checkScore = clamp01(0.28 + me.altruism * 0.22 + rel.friendship * 0.22
            + rel.trust * 0.08 + (concern ? 0.18 : 0) + (familiar ? 0.08 : 0)
            + (sharingNorm - 0.5) * 0.18 - rel.annoyance * 0.12);
        if (checkScore >= 0.38) {
            goals.push({
                kind: 'check_in',
                target: member.name,
                item: null,
                count: 0,
                resource: null,
                score: checkScore,
                reason: concern ? `${member.name} rabi socialno preverjanje` : `okrepiti vez z ${member.name}`,
                label: `preverim ${member.name}`,
            });
        }

        // out-produce a rival: pure motivation, no deliverable. Surfaced to the planner so
        // an ambitious bot can choose to out-gather the contested resource.
        if (rel.rivalry > 0.25 && me.ambition > 0.5 && need) {
            const score = clamp01(me.ambition * 0.4 + rel.rivalry * 0.5);
            goals.push({
                kind: 'outproduce',
                target: member.name,
                item: null,
                count: 0,
                resource: need.resource,
                score,
                reason: `prekositi ${member.name} pri ${need.resource}`,
                label: `tekmujem z ${member.name}`,
            });
        }
    }

    // impress the player: an ambitious bot gifts a nearby player a useful surplus to earn
    // standing. Heavily down-weighted + throttled so it never becomes spam.
    const memberNames = new Set(members.map(m => m.name));
    const player = (state?.nearbyPlayers ?? nearbyPlayerNames(bot, memberNames))
        .find(name => !memberNames.has(name)) ?? null;
    if (player && me.ambition > 0.45) {
        const gift = pickGift(bot, ['hrana', 'kramp'], supply);
        if (gift) {
            const score = clamp01(0.3 + me.ambition * 0.4 - me.caution * 0.1
                + (sharingNorm - 0.5) * 0.16);
            goals.push({
                kind: 'impress_player',
                target: player,
                item: gift.item,
                count: gift.count,
                resource: null,
                score,
                reason: `pridobiti naklonjenost igralca ${player}`,
                label: `obdarim ${player}`,
            });
        }
    }

    // cover the gap nobody is filling: the settlement is short on a resource and no active
    // member is currently working it. Orderly bots feel the pull to plug the hole.
    if (need && need.ratio < 1) {
        const someoneOnIt = members.some(m => {
            const doing = String(opinions[m.name]?.lastSeenDoing ?? m.action ?? '').toLowerCase();
            return doing.includes(need.resource);
        });
        if (!someoneOnIt) {
            const densityNorm = Number(norms.build_density_preference ?? 0.5);
            const score = clamp01(me.orderliness * 0.4 + (1 - need.ratio) * 0.5
                + (densityNorm - 0.5) * 0.12);
            goals.push({
                kind: 'cover_gap',
                target: null,
                item: null,
                count: 0,
                resource: need.resource,
                score,
                reason: `nihce ne pokriva ${need.resource}, naselje primanjkuje`,
                label: `pokrivam vrzel: ${need.resource}`,
            });
        }
    }

    return goals.sort((a, b) => b.score - a.score);
}

const DELIVERABLE = new Set(['help', 'check_in', 'impress_player']);

/** The best DELIVERABLE social goal above the action threshold, or null. */
export function topSocialGoal(agent, state) {
    return generateSocialGoals(agent, state)
        .find(goal => DELIVERABLE.has(goal.kind) && goal.score >= MIN_DELIVER_SCORE) ?? null;
}

/**
 * Compact, human-readable goal list for the planner prompt (society + local). Includes
 * the bias kinds (out-produce / cover-gap) so the LLM can lean into them. '' when empty.
 */
export function socialGoalContext(agent, state, limit = 3) {
    if (!socialGoalsEnabled()) return '';
    const goals = generateSocialGoals(agent, state).slice(0, limit);
    if (goals.length === 0) return '';
    return 'Social goals (predlogi, prosto):\n'
        + goals.map(g => `- ${g.label} (${g.reason})`).join('\n');
}

/** One-line description for logs / speech. */
export function describeSocialGoal(goal) {
    return goal ? `${goal.label} — ${goal.reason}` : '';
}

const cooling = (agent, key, ms) => Date.now() - (agent._brain?.[key] ?? 0) < ms;
const mark = (agent, key) => { if (agent._brain) agent._brain[key] = Date.now(); };

// Is the recipient close enough that delivery can actually complete this tick? The entity
// must be loaded; giveToPlayer paths to them, but a target across the map just wastes time.
function recipientReachable(bot, name) {
    const entity = bot.players?.[name]?.entity;
    return Boolean(entity) && entity.position.distanceTo(bot.entity.position) <= 48;
}

function checkInLine(agent, target) {
    const p = agent.personality ?? getPersonality(agent.prompter?.profile ?? agent.name);
    if (p.altruism > 0.75) return `${target}, preverim, ce si v redu.`;
    if (p.orderliness > 0.75) return `${target}, samo preverjam stanje.`;
    if (p.ambition > 0.7) return `${target}, drziva tempo.`;
    return `${target}, kako gre?`;
}

/**
 * Deterministic brain action that executes the top social goal, or null. Cooldown-gated
 * so it never thrashes. This is the LLM-OFF fallback the plan requires + the executor for
 * an LLM-chosen `social` focus. Sets agent._brain.pendingShareTarget for coherent speech.
 */
export function planSocialAction(agent, _home) {
    if (!socialGoalsEnabled()) return null;
    const bot = agent?.bot;
    if (!bot?.entity) return null;
    // Respect both cooldowns up front: pick the highest goal whose cooldown is clear.
    const goals = generateSocialGoals(agent)
        .filter(goal => DELIVERABLE.has(goal.kind) && goal.score >= MIN_DELIVER_SCORE);

    for (const goal of goals) {
        if (!recipientReachable(bot, goal.target)) continue;

        if (goal.kind === 'help') {
            if (cooling(agent, 'socialGoal', HELP_COOLDOWN_MS)) continue;
            mark(agent, 'socialGoal');
            agent._brain.pendingShareTarget = goal.target;
            return {
                name: 'socialGoal',
                timeout: 3,
                fn: async () => {
                    try {
                        return await society.shareSupplies(agent, {
                            target: goal.target,
                            item: goal.item,
                            count: goal.count,
                            reason: goal.reason,
                        });
                    } finally {
                        if (agent._brain?.pendingShareTarget === goal.target)
                            agent._brain.pendingShareTarget = null;
                    }
                },
            };
        }

        if (goal.kind === 'check_in') {
            if (cooling(agent, 'socialCheckIn', CHECK_IN_COOLDOWN_MS)) continue;
            mark(agent, 'socialCheckIn');
            agent._brain.pendingShareTarget = goal.target;
            return {
                name: 'socialCheckIn',
                timeout: 3,
                fn: async () => {
                    try {
                        const entity = bot.players?.[goal.target]?.entity;
                        if (!entity) return false;
                        const reached = await skills.goToPosition(
                            bot,
                            entity.position.x,
                            entity.position.y,
                            entity.position.z,
                            3,
                        );
                        if (!reached) return false;
                        if (settings.cognition?.controller_enabled !== true)
                            bot.chat(checkInLine(agent, goal.target));
                        await updateMutual(agent, goal.target,
                            { trust: 0.016, friendship: 0.025, respect: 0.006 },
                            { trust: 0.014, friendship: 0.022, respect: 0.006 },
                            'social check-in');
                        void society.recordEvent(bot, 'cooperation', agent.name,
                            `${agent.name} je preveril ${goal.target} in okrepil socialno vez.`)
                            .catch(() => { /* lock contention */ });
                        return true;
                    } finally {
                        if (agent._brain?.pendingShareTarget === goal.target)
                            agent._brain.pendingShareTarget = null;
                    }
                },
            };
        }

        if (goal.kind === 'impress_player') {
            if (cooling(agent, 'socialGift', GIFT_COOLDOWN_MS)) continue;
            mark(agent, 'socialGift');
            agent._brain.pendingShareTarget = goal.target;
            return {
                name: 'socialGift',
                timeout: 3,
                fn: async () => {
                    try {
                        const given = await skills.giveToPlayer(bot, goal.item, goal.target, goal.count);
                        if (given)
                            void society.recordEvent(bot, 'cooperation', agent.name,
                                `${agent.name} je igralcu ${goal.target} podaril ${goal.count}x ${goal.item}.`)
                                .catch(() => { /* lock contention */ });
                        return given;
                    } finally {
                        if (agent._brain?.pendingShareTarget === goal.target)
                            agent._brain.pendingShareTarget = null;
                    }
                },
            };
        }
    }
    return null;
}
