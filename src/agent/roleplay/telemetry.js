// ============================================================================
// Debug Telemetry — "Sloj A" observability for the Altera/PIANO kingdom layer
// ============================================================================
//
// WHY THIS EXISTS
// The interesting cognitive state of a kingdom bot (its plan, intention, action
// awareness, social opinions, relations, norms, and which actions are currently
// cooling down) lives only IN the bot's node process and is never written out. The
// only persistent observables today are kingdom.json + the social graph + memory, and
// the console is noisy. That makes it hard for a human OR an AI assistant to see what a
// bot believes/intends and to debug "why is this bot stuck / flailing".
//
// WHAT THIS DOES (deterministic, LLM-FREE, cheap, flag-gated)
//   For each bot it writes two per-bot files (single writer = the bot's own process, so
//   NO cross-process lock is needed — never funnel telemetry through kingdom-state):
//     bots/<name>/debug-state.json  — the latest Agent State snapshot (overwritten,
//                                     atomic write; does not grow). This is the §4
//                                     AgentState from ALTERA_PLAN.md, enriched with
//                                     awareness/intention/plan/backoff/norms.
//     bots/<name>/trace.ndjson      — one JSON line per executed/blocked decision, with
//                                     the chosen action, result, intention topic, plan
//                                     focus, awareness flags, and which actions are on
//                                     cooldown ("vetoed this tick"). Rotated by size.
//
// Read them directly (an AI can just Read/Grep the files) or via tools/kingdom-status.js.
//
// WIRING (all behind settings.telemetry.enabled):
//   - brain.js socialTimer (4s): writeSnapshot(agent) — internally throttled.
//   - brain.js brainTick: recordDecision(agent, act, ctx) on the chosen action (and on a
//     blocked/cooling action that won't run this tick).
//
// DESIGN RULES (keep these true if you edit this file):
//   1. Debug I/O must NEVER break a bot. Everything is wrapped in try/catch and degrades
//      to a no-op. A snapshot/trace failure logs a warning at most; it never throws up.
//   2. Cheap: reuse already-cached sources (assembleState, world.getInventoryCounts,
//      agent._awareness/_intention/_plan). No block scans, no pathfinding, no lock.
//   3. Per-bot files only. Snapshots overwrite (bounded), traces rotate (bounded).
//   4. Flag-gated, default behavior identical when settings.telemetry.enabled !== true.
// ----------------------------------------------------------------------------

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import settings from '../settings.js';
import * as world from '../library/world.js';
import * as progression from '../library/progression.js';
import { socialStructure } from './social_graph.js';
import { assembleState } from './cognition.js';      // PIANO bottleneck — most of the Agent State
import { awarenessSummary } from './awareness.js';    // Phase 1 self-model summary
import { getNorms } from '../library/culture.js';     // Phase 6 effective norms (defaults when culture off)

const BOTS_DIR = './bots';
const DEFAULT_SNAPSHOT_MS = 5000;
const DEFAULT_TRACE_MAX_KB = 512;

// Inventory buckets — mirror society.summarizeInventory so the snapshot reads the same
// aggregate keys the kingdom state uses (society.summarizeInventory is not exported).
const FOOD = new Set([
    'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    'baked_potato', 'apple', 'carrot', 'golden_carrot', 'cooked_cod',
    'cooked_salmon', 'cooked_rabbit',
]);
const LOGS = new Set([
    'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log',
    'dark_oak_log', 'cherry_log', 'mangrove_log',
]);

function telemetrySettings() {
    return settings.telemetry ?? {};
}

export function enabled() {
    return telemetrySettings().enabled === true;
}

function traceEnabled() {
    return enabled() && telemetrySettings().trace_enabled !== false;
}

const snapshotPath = (name) => `${BOTS_DIR}/${name}/debug-state.json`;
const tracePath = (name) => `${BOTS_DIR}/${name}/trace.ndjson`;

const round1 = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);
const round2 = (value) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : null);

function safeCall(fn, fallback = null) {
    try { return fn(); } catch { return fallback; }
}

// Atomic overwrite via tmp + rename, so a reader never catches a half-written file.
function atomicWrite(file, text) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(tmp, text);
    let replaced = false;
    try {
        renameSync(tmp, file);
        replaced = true;
    } finally {
        if (!replaced && existsSync(tmp)) {
            try { unlinkSync(tmp); } catch { /* cleanup best effort */ }
        }
    }
}

// Append a trace line, rotating the file (keep one .1 backup) once it passes the cap.
function appendTrace(name, line) {
    const file = tracePath(name);
    mkdirSync(dirname(file), { recursive: true });
    const maxKb = Math.max(16, Number(telemetrySettings().trace_max_kb ?? DEFAULT_TRACE_MAX_KB));
    try {
        if (existsSync(file) && statSync(file).size > maxKb * 1024) {
            const backup = `${file}.1`;
            try { if (existsSync(backup)) unlinkSync(backup); } catch { /* */ }
            renameSync(file, backup);
        }
    } catch { /* rotation is best-effort; never block the write */ }
    appendFileSync(file, line);
}

// Compact aggregate inventory (same keys as society.summarizeInventory).
function compactInventory(bot) {
    const counts = world.getInventoryCounts(bot);
    const sum = (predicate) => Object.entries(counts)
        .filter(([item]) => predicate(item))
        .reduce((total, [, amount]) => total + amount, 0);
    return {
        food: sum((item) => FOOD.has(item)),
        wood: sum((item) => LOGS.has(item)),
        stone: counts.cobblestone ?? 0,
        iron: (counts.iron_ingot ?? 0) + (counts.raw_iron ?? 0),
        coal: (counts.coal ?? 0) + (counts.charcoal ?? 0),
        gold: (counts.gold_ingot ?? 0) + (counts.raw_gold ?? 0),
        lapis: counts.lapis_lazuli ?? 0,
        diamonds: counts.diamond ?? 0,
        torches: counts.torch ?? 0,
        pickaxes: sum((item) => item.endsWith('_pickaxe')),
        axes: sum((item) => item.endsWith('_axe') && !item.endsWith('_pickaxe')),
        swords: sum((item) => item.endsWith('_sword')),
        emptySlots: bot.inventory?.emptySlotCount?.() ?? null,
    };
}

// Actions whose backoff cooldown is still active = effectively "vetoed this tick".
function activeBackoff(agent, now) {
    const backoff = agent._brain?.actionBackoff;
    if (!backoff) return {};
    const out = {};
    for (const [name, entry] of Object.entries(backoff)) {
        if (entry && (entry.retryAt ?? 0) > now)
            out[name] = { failures: entry.failures ?? 0, retryInMs: Math.max(0, (entry.retryAt ?? 0) - now) };
    }
    return out;
}

function navigationSnapshot(bot) {
    const nav = bot?._navigationDiagnostics;
    if (!nav) return null;
    const startedAt = Date.parse(nav.startedAt ?? '');
    return {
        status: nav.status ?? null,
        goal: nav.goal ?? null,
        attempt: nav.attempt ?? null,
        elapsedMs: nav.elapsedMs ?? (Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null),
        lastProgressAt: nav.lastProgressAt ?? null,
        endedAt: nav.endedAt ?? null,
        reason: nav.reason ?? null,
    };
}

const currentActionLabel = (agent) =>
    String(agent.actions?.currentActionLabel ?? '').replace(/^brain:/, '') || 'idle';

/**
 * Build the Agent State snapshot for one bot. Pure read; tolerant of any sub-source that
 * is still loading (each section is guarded). Shape follows ALTERA_PLAN.md §4.
 */
export function buildSnapshot(agent) {
    const bot = agent.bot;
    const now = Date.now();
    const cog = settings.cognition ?? {};

    let state = null;
    try { state = assembleState(agent); } catch { /* state loading */ }

    let stage = null;
    let label = null;
    try { const status = progression.getStatus(bot); stage = status?.stage ?? null; label = status?.label ?? null; }
    catch { /* progression state loading */ }

    const pos = bot.entity?.position ?? null;

    return {
        t: new Date(now).toISOString(),
        name: agent.name,
        // self-describing: which cognition phases were live when this snapshot was taken
        flags: {
            awareness: cog.awareness_enabled === true,
            controller: cog.controller_enabled === true,
            socialPerception: cog.social_perception_enabled === true,
            socialGoals: cog.social_goals_enabled === true,
            culture: cog.culture_enabled === true,
        },
        self: {
            role: state?.self?.role ?? null,
            stage,
            label,
            health: round1(bot.health),
            food: round1(bot.food),
            pos: pos ? { x: round1(pos.x), y: round1(pos.y), z: round1(pos.z) } : null,
            currentAction: currentActionLabel(agent),
            navigation: navigationSnapshot(bot),
            inventory: safeCall(() => compactInventory(bot)),
        },
        plan: agent._plan ?? null,
        planning: agent._plannerStatus ?? null,
        intention: agent._intention ?? null,
        awareness: agent._awareness ?? null,
        awarenessSummary: safeCall(() => awarenessSummary(agent), ''),
        backoff: activeBackoff(agent, now),
        society: {
            resourceNeed: state?.society?.resourceNeed ?? null,
            memberCount: state?.society?.members?.length ?? 0,
            members: (state?.society?.members ?? []).slice(0, 12).map((member) => ({
                name: member.name,
                role: member.role ?? null,
                action: String(member.action ?? '').replace(/^brain:/, '') || 'idle',
                progression: member.progression ?? null,
            })),
        },
        relations: (state?.relations ?? []).map((relation) => ({
            to: relation.to,
            trust: round2(relation.trust),
            respect: round2(relation.respect),
            friendship: round2(relation.friendship),
            annoyance: round2(relation.annoyance),
            rivalry: round2(relation.rivalry),
            debt: round2(relation.debt),
        })),
        socialStructure: safeCall(() => socialStructure(4), { bonds: [], tensions: [], hubs: [] }),
        socialOpinions: state?.socialOpinions ?? {},
        nearbyPlayers: state?.nearbyPlayers ?? [],
        norms: cog.culture_enabled === true ? safeCall(() => getNorms(agent)) : null,
    };
}

/**
 * Write the latest Agent State snapshot for this bot (throttled, atomic). No-op unless
 * settings.telemetry.enabled. Safe to call on the 4s social timer.
 */
export function writeSnapshot(agent) {
    if (!enabled()) return false;
    const bot = agent?.bot;
    if (!bot?.entity) return false;

    const local = (agent._telemetry ??= { lastSnapshotAt: 0 });
    const interval = Math.max(1000, Number(telemetrySettings().snapshot_seconds ?? 5) * 1000 || DEFAULT_SNAPSHOT_MS);
    if (Date.now() - (local.lastSnapshotAt ?? 0) < interval) return false;
    local.lastSnapshotAt = Date.now();

    try {
        atomicWrite(snapshotPath(agent.name), `${JSON.stringify(buildSnapshot(agent), null, 2)}\n`);
        return true;
    } catch (error) {
        console.warn(`[telemetry ${agent.name}] snapshot failed: ${error.message}`);
        return false;
    }
}

/**
 * Append one decision line to the bot's trace. Cheap; no-op unless trace is enabled.
 * @param {object} ctx { blocked?:bool, result?:'ok'|'fail'|'interrupted', stage?:string }
 */
export function recordDecision(agent, action, ctx = {}) {
    if (!traceEnabled()) return;
    const bot = agent?.bot;
    if (!bot?.entity) return;

    const now = Date.now();
    const aware = agent._awareness ?? null;
    const intention = agent._intention ?? null;
    const runnerUp = action?.decision?.source !== 'safety'
        ? (agent._decisionState?.candidates ?? [])
            .find(candidate => candidate.key !== action?.decision?.key)
        : null;
    const line = {
        t: new Date(now).toISOString(),
        action: action?.name ?? null,
        blocked: ctx.blocked === true,
        result: ctx.result ?? null,
        topic: intention?.topic ?? null,
        target: intention?.socialTarget ?? null,
        focus: agent._plan?.focus ?? null,
        resource: agent._plan?.resource ?? null,
        stage: ctx.stage ?? null,
        decision: action?.decision
            ? {
                key: action.decision.key,
                source: action.decision.source,
                score: action.decision.score,
                baseScore: action.decision.baseScore ?? null,
                commitmentBonus: action.decision.commitmentBonus ?? 0,
                agingBonus: action.decision.agingBonus ?? 0,
                waitedMs: action.decision.waitedMs ?? 0,
                reason: action.decision.reason || null,
                goalKey: action.decision.goalKey ?? null,
                preemptedBy: action.decision.preemptedBy ?? null,
                preemptedAction: action.decision.preemptedAction ?? null,
                runnerUp: runnerUp
                    ? {
                        key: runnerUp.key,
                        score: runnerUp.score,
                        scoreGap: Number(action.decision.score ?? 0) - Number(runnerUp.score ?? 0),
                    }
                    : null,
            }
            : null,
        frustration: aware ? round2(aware.frustration) : null,
        flags: aware
            ? {
                stuck: aware.flags?.stuck === true,
                stalled: aware.flags?.planStalled === true,
                idle: aware.flags?.idleTooLong === true,
                progressing: aware.makingProgress === true,
            }
            : null,
        cooling: Object.keys(activeBackoff(agent, now)),
    };
    // Why an action failed (bot.output tail) — without this, every fail in the
    // trace needs a live repro to diagnose.
    if (ctx.reason) line.reason = String(ctx.reason).replace(/\s+/g, ' ').trim().slice(0, 160);
    try { appendTrace(agent.name, `${JSON.stringify(line)}\n`); }
    catch { /* debug I/O must never break the bot */ }
}
