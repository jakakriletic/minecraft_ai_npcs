// ============================================================================
// Action Awareness — ALTERA / PIANO plan, PHASE 1  (see repo-root ALTERA_PLAN.md)
// ============================================================================
//
// WHAT THIS IS
// In Altera's PIANO architecture every agent runs an "Action Awareness" module: a
// cheap, moment-to-moment self-assessment of its own state and performance ("am I
// making progress? am I stuck? is this plan going nowhere?"). That self-model feeds
// the Cognitive Controller (Phase 2), goal generation, and speech.
//
// This file is the deterministic, LLM-FREE version of that module. It does NOT decide
// what to do — it only OBSERVES the bot and produces a compact assessment object that
// other code reads. It must stay cheap: no block scans, no pathfinding, no I/O.
//
// HOW IT FITS THE AGENT STATE (ALTERA_PLAN.md §4)
//   input : agent._plan, agent._brain.actionBackoff, agent.actions.currentActionLabel,
//           bot inventory + position + progression (all already in memory).
//   private store : agent._aware  (rolling samples; owned by THIS module only)
//   output: the `awareness` slice of Agent State — assign it to agent._awareness so
//           other modules (brain, future cognition.js) can read it.
//
// WIRING (current): brain.js calls assessAwareness() on the 4s social timer (it runs
// even mid-action, like the stuck detector) behind settings.cognition.awareness_enabled.
// Two reactions, both in brain.js: (a) flags.planStalled -> abandon the stuck focus so
// the planner picks a new one; (b) high frustration + a player nearby -> a free
// templated ambient line.
//
// ----------------------------------------------------------------------------
// DOCUMENTATION DISCIPLINE (read before editing — applies to EVERY file in this effort)
//   This module is part of the Altera/PIANO roadmap. If you change its behavior:
//     1. Update the JSDoc/comments here so the contract stays true.
//     2. Update ALTERA_PLAN.md (§5 the phase, §8 the Status table) in the SAME change.
//     3. Keep it deterministic and cheap; never add an un-budgeted LLM call here.
//   Leave the same reminder for whoever edits after you. Undocumented changes to this
//   layer are how it rots — don't be the one who skips it.
// ----------------------------------------------------------------------------

import settings from '../settings.js';
import * as world from '../library/world.js';

// Resource buckets — kept in sync with brain.js / planner.js so a plan's `resource`
// maps to the same item counts the executor is actually filling.
const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log'];
const FOOD = ['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'baked_potato', 'apple', 'carrot', 'golden_carrot', 'cooked_cod', 'cooked_salmon', 'cooked_rabbit'];
const RESOURCE_ITEMS = {
    wood: LOGS,
    stone: ['cobblestone'],
    food: FOOD,
    iron: ['iron_ingot', 'raw_iron'],
    coal: ['coal', 'charcoal'],
    gold: ['gold_ingot', 'raw_gold'],
    lapis: ['lapis_lazuli'],
};

// A focus only has a countable "am I filling it?" target for these. Build/base/explore/
// relax progress is not measured here, so we never declare THOSE plans stalled (avoids
// false abandons of legitimately slow work like construction).
const COUNTABLE_FOCUSES = new Set(['stockpile', 'farm']);

const PROGRESS_WINDOW_MS = 12_000; // "making progress" = some inv/position change within this window
const MOVE_EPSILON = 1.5;          // blocks of movement that count as "still doing something"
const IDLE_TOO_LONG_MS = 60_000;   // standing idle longer than this is flagged (not yet acted on in P1)

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function inventoryTotal(counts) {
    let total = 0;
    for (const amount of Object.values(counts)) total += amount;
    return total;
}

function resourceCount(counts, resource) {
    const names = RESOURCE_ITEMS[resource];
    if (!names) return null;
    return names.reduce((sum, name) => sum + (counts[name] ?? 0), 0);
}

// Sum of failure pressure from the brain's exponential backoff table: an action that
// has failed repeatedly and is still cooling down is the clearest "this isn't working"
// signal we already track. Returns the worst current failure streak (0 if none).
function activeFailureStreak(agent, now) {
    const backoff = agent._brain?.actionBackoff;
    if (!backoff) return 0;
    let worst = 0;
    for (const entry of Object.values(backoff)) {
        if (!entry) continue;
        if ((entry.retryAt ?? 0) > now) worst = Math.max(worst, Number(entry.failures ?? 0));
    }
    return worst;
}

/**
 * Assess the bot's current self-state. Cheap + deterministic. Updates the private
 * rolling sample store on agent._aware and returns the assessment object described in
 * ALTERA_PLAN.md §4 (the `awareness` slice). Safe to call every few seconds.
 *
 * @returns {{
 *   currentAction: string, msOnAction: number, makingProgress: boolean,
 *   planTargetRatio: (number|null), idleMs: number, frustration: number,
 *   flags: { stuck: boolean, planStalled: boolean, idleTooLong: boolean }
 * }}
 */
export function assessAwareness(agent) {
    const bot = agent?.bot;
    const aware = (agent._aware ??= {});
    const now = Date.now();

    // Disconnected / not spawned — return a neutral assessment and reset samples.
    if (!bot?.entity) {
        aware.lastLabel = null;
        return neutral();
    }

    const label = String(agent.actions?.currentActionLabel ?? 'idle').replace(/^brain:/, '') || 'idle';
    const executing = Boolean(agent.actions?.executing);
    const counts = world.getInventoryCounts(bot);
    const invTotal = inventoryTotal(counts);
    const pos = bot.entity.position;

    // --- action timing: when did the CURRENT action label start? ---
    if (aware.lastLabel !== label) {
        aware.lastLabel = label;
        aware.actionStartedAt = now;
    }
    const msOnAction = now - (aware.actionStartedAt ?? now);

    // --- liveness: did inventory grow, did we move, or did the action change recently? ---
    const moved = aware.lastPos
        ? Math.hypot(pos.x - aware.lastPos.x, pos.y - aware.lastPos.y, pos.z - aware.lastPos.z) > MOVE_EPSILON
        : false;
    const gained = aware.lastInvTotal != null && invTotal > aware.lastInvTotal;
    if (gained || moved) aware.lastProgressAt = now;
    aware.lastPos = { x: pos.x, y: pos.y, z: pos.z };
    aware.lastInvTotal = invTotal;
    const makingProgress = now - (aware.lastProgressAt ?? 0) < PROGRESS_WINDOW_MS;

    // --- idle tracking ---
    const idle = !executing && (label === 'idle' || label === 'rest' || label === 'relax');
    if (idle) aware.idleSince ??= now; else aware.idleSince = null;
    const idleMs = aware.idleSince ? now - aware.idleSince : 0;

    // --- plan-target progress + stall detection ---
    const plan = agent._plan;
    let planTargetRatio = null;
    let planStalled = false;
    const stallMs = Math.max(20_000, Number(settings.cognition?.plan_stall_seconds ?? 90) * 1000);
    if (plan && !plan.completed && COUNTABLE_FOCUSES.has(plan.focus)) {
        const resource = plan.resource ?? 'wood';
        const have = resourceCount(counts, resource);
        const target = Math.max(1, Number(plan.amount ?? 0));
        if (have != null) {
            planTargetRatio = clamp01(have / target);
            // Reset the stall baseline whenever the plan changes OR the count climbs.
            const baseline = aware.planBaseline;
            if (!baseline || baseline.planId !== plan.planId || have > baseline.count)
                aware.planBaseline = { planId: plan.planId, count: have, since: now };
            const sinceProgress = now - (aware.planBaseline?.since ?? now);
            planStalled = planTargetRatio < 1 && sinceProgress > stallMs;
        }
    } else {
        aware.planBaseline = null;
    }

    // --- stuck flag: reuse both the brain sample and the navigation watchdog ---
    // The old flag usually stayed false because the brain cleared its sample as soon
    // as it interrupted the path. Keep a watchdog stall visible for 15 s so telemetry
    // captures where and why the NPC needed a replan.
    const navigation = agent.bot?._navigationDiagnostics;
    const navigationEndedAt = Date.parse(navigation?.endedAt ?? '');
    const recentNavigationStall = navigation?.status === 'stalled'
        && Number.isFinite(navigationEndedAt)
        && now - navigationEndedAt < 15_000;
    const stuck = recentNavigationStall || Boolean(agent._brain?.stuckSample
        && now - (agent._brain.stuckSample.since ?? now) > 15_000);

    // --- frustration 0..1: blend failure streak, stall, and no-progress-while-busy ---
    const failureStreak = activeFailureStreak(agent, now);
    const failComponent = clamp01(failureStreak / 4);
    const frustration = clamp01(
        failComponent * 0.7
        + (planStalled ? 0.45 : 0)
        + (executing && !makingProgress && msOnAction > PROGRESS_WINDOW_MS ? 0.2 : 0),
    );

    const assessment = {
        currentAction: label,
        msOnAction,
        makingProgress,
        planTargetRatio,
        idleMs,
        frustration,
        flags: {
            stuck,
            planStalled,
            idleTooLong: idleMs > IDLE_TOO_LONG_MS,
        },
    };
    aware.assessment = assessment;
    return assessment;
}

function neutral() {
    return {
        currentAction: 'idle',
        msOnAction: 0,
        makingProgress: false,
        planTargetRatio: null,
        idleMs: 0,
        frustration: 0,
        flags: { stuck: false, planStalled: false, idleTooLong: false },
    };
}

/**
 * Compact human-readable summary of the current assessment. Used later by the
 * Cognitive Controller / conversation layer (Phase 2/5) so a bot can answer
 * "how is it going?" from its real self-state. Reads agent._awareness if present,
 * else computes a fresh assessment.
 */
export function awarenessSummary(agent) {
    const a = agent?._awareness ?? assessAwareness(agent);
    const bits = [`doing ${a.currentAction}`];
    if (a.planTargetRatio != null) bits.push(`plan ${Math.round(a.planTargetRatio * 100)}% there`);
    bits.push(a.makingProgress ? 'making progress' : 'not progressing');
    if (a.flags.planStalled) bits.push('plan stalled');
    if (a.flags.stuck) bits.push('stuck');
    if (a.frustration >= 0.6) bits.push('frustrated');
    return bits.join(', ');
}
