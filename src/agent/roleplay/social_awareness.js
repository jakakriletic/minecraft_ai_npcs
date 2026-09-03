// ============================================================================
// Social Awareness — ALTERA / PIANO plan, PHASE 3  (see repo-root ALTERA_PLAN.md)
// ============================================================================
//
// WHAT THIS IS
// In PIANO each agent runs a "Social Awareness" module: it interprets social cues and
// forms opinions of the OTHER agents (what they need, how capable they are, what they
// were last seen doing). Those opinions are the raw material the goal generator (Phase 4)
// turns into recursive social goals — the mechanism behind Altera's emergent
// specialization ("I keep supplying Rok because Rok keeps running out of food").
//
// WHAT IT DOES HERE (deterministic, LLM-FREE, cheap — runs on the 4s social timer)
//   1. Builds a per-bot OPINION MODEL of every active member from the shared society
//      state (kingdom.json): needs (what they lack), competence (rough scalar), and
//      lastSeenDoing. Kept IN MEMORY on agent._socialAware.model — it is re-derived from
//      observation every cycle, so it is NOT persisted (no 4s × 10-bot disk writes).
//   2. Occasionally NUDGES the persistent social graph (bots/rp-social-graph.json, which
//      has its own lock) from OBSERVED behavior — not just from direct interactions that
//      events.js already covers. Examples: saw a member helping -> small +respect (if I'm
//      altruistic); a member idling while the settlement is short -> small +annoyance (if
//      I'm orderly). Nudges are throttled HARD so relations drift slowly and writes stay rare.
//
// HOW IT FITS THE AGENT STATE (ALTERA_PLAN.md §4)
//   input : society.activeMembers + getResourceNeed + my personality traits.
//   output: agent._socialAware.model  -> exposed via getSocialModel() (assembleState reads it
//           as `socialOpinions`) and socialContext() (compact string for chat + Phase-4 planner).
//
// WIRING (current, all behind settings.cognition.social_perception_enabled):
//   - brain.js socialTimer (4s): calls perceive(agent).
//   - cognition.assembleState: includes getSocialModel(agent) as socialOpinions.
//   - narrator.buildRoleplayContext: injects socialContext(agent) so chat reflects how the
//     bot sees the others.
//
// ----------------------------------------------------------------------------
// DOCUMENTATION DISCIPLINE (applies to EVERY file in the Altera/PIANO effort)
//   If you change this module: (1) keep these comments true, (2) update ALTERA_PLAN.md
//   §5 (this phase) and §8 (Status table) in the SAME change, (3) keep it deterministic
//   and the social-graph writes RARE (respect the throttles below). Leave this reminder
//   for the next editor.
// ----------------------------------------------------------------------------

import settings from '../settings.js';
import * as society from '../library/society.js';
import { updateMutual, updateRelation } from './social_graph.js';
import { getPersonality } from './personality.js';

// Social-graph nudge throttles. Observed-behavior nudges are frequent triggers, so we
// keep the actual writes rare: at most one nudge per agent per GLOBAL window, and the
// same (target, signal) at most once per PER_KEY window. Relations should drift slowly.
const NUDGE_GLOBAL_COOLDOWN_MS = 20_000;
const NUDGE_PER_KEY_COOLDOWN_MS = 90_000;

// Progression stage -> rough capability rank (kept in sync with progression.getStatus()).
// The kingdom state stores the exact progression.getStatus().stage strings, not just the
// broad Altera-plan buckets, so include every deterministic stage here.
const STAGE_RANK = {
    bootstrap: 0,
    homestead: 0.5,
    starter_utility: 0.8,
    shelter: 1,
    iron_tools: 1.5,
    iron_utility: 1.7,
    iron_armor: 2,
    established: 2.25,
    diamond_tools: 2.6,
    diamond_armor: 2.85,
    advanced_utility: 2.95,
    late_game: 3,
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

// What does this member visibly LACK? Mirrors society.findSupplyShare thresholds so the
// Phase-4 goal generator and the deterministic sharer agree on "needs".
function deriveNeeds(inv = {}) {
    const needs = [];
    if ((inv.food ?? 0) < 2) needs.push('hrana');
    if ((inv.pickaxes ?? 0) < 1) needs.push('kramp');
    if ((inv.swords ?? 0) < 1) needs.push('orozje');
    if ((inv.torches ?? 0) < 2) needs.push('bakle');
    return needs;
}

// Rough 0..1 capability read from shared state: progression stage + core tools + diamonds.
function competenceOf(member) {
    const inv = member.inventory ?? {};
    const stage = clamp01((STAGE_RANK[member.progression] ?? 0) / 3);
    const tools = ((inv.pickaxes ?? 0) > 0 ? 0.5 : 0) + ((inv.swords ?? 0) > 0 ? 0.5 : 0);
    const diamonds = clamp01((inv.diamonds ?? 0) / 4);
    return clamp01(stage * 0.6 + tools * 0.2 + diamonds * 0.2);
}

function actionKind(action) {
    const doing = String(action ?? 'idle').replace(/^brain:/, '').toLowerCase();
    if (/share|social|help|give|contribute/.test(doing)) return 'help';
    if (/farm|food|bread|wheat|cook/.test(doing)) return 'food';
    if (/mine|iron|coal|gold|lapis|diamond|ore|stockpile/.test(doing)) return 'resources';
    if (/build|road|storage|base|town|schematic/.test(doing)) return 'build';
    if (/defend|guard|patrol|combat|self_defense/.test(doing)) return 'protect';
    if (/idle|rest/.test(doing)) return 'idle';
    return 'work';
}

function distanceToMember(bot, member) {
    const entity = bot.players?.[member.name]?.entity;
    if (entity?.position) return entity.position.distanceTo(bot.entity.position);
    const p = member.position;
    if (!p) return Infinity;
    const sameDimension = !p.dimension || String(p.dimension) === String(bot.game?.dimension ?? 'world');
    if (!sameDimension) return Infinity;
    const pos = bot.entity.position;
    return Math.hypot(pos.x - p.x, pos.y - p.y, pos.z - p.z);
}

/**
 * Observe the other members and update the in-memory opinion model + (rarely) the social
 * graph. Cheap + deterministic; safe to call every 4s. No-op unless the flag is on.
 */
export function perceive(agent) {
    if (settings.cognition?.social_perception_enabled !== true) return;
    const bot = agent?.bot;
    if (!bot?.entity) return;

    const sp = (agent._socialAware ??= { model: {}, lastNudge: {}, lastNudgeAt: 0, idleSeen: {} });
    sp.model ??= {};
    sp.lastNudge ??= {};
    sp.idleSeen ??= {};
    let members = [];
    try { members = society.activeMembers(bot).filter(m => m.name !== agent.name); }
    catch { return; }

    let need = null;
    try { need = society.getResourceNeed(bot); } catch { /* state loading */ }
    const settlementShort = Boolean(need && need.ratio < 1);
    const me = getPersonality(agent.prompter?.profile ?? agent.name);
    const now = Date.now();
    const activeNames = new Set(members.map(member => member.name));
    for (const knownName of Object.keys(sp.model)) {
        if (!activeNames.has(knownName)) delete sp.model[knownName];
    }
    for (const knownName of Object.keys(sp.idleSeen ?? {})) {
        if (!activeNames.has(knownName)) delete sp.idleSeen[knownName];
    }

    const candidates = []; // potential social-graph nudges; the most salient one may apply
    const myKind = actionKind(agent.actions?.currentActionLabel);
    for (const member of members) {
        const inv = member.inventory ?? {};
        const doing = String(member.action ?? 'idle').replace(/^brain:/, '') || 'idle';
        const kind = actionKind(doing);
        const distance = distanceToMember(bot, member);
        const competence = competenceOf(member);
        sp.model[member.name] = {
            needs: deriveNeeds(inv),
            competence,
            lastSeenDoing: doing,
            progression: member.progression ?? 'unknown',
            updatedAt: now,
        };

        const helping = /share|help|give|contribute/i.test(doing);
        const idle = kind === 'idle';
        sp.idleSeen[member.name] = idle ? (sp.idleSeen[member.name] ?? 0) + 1 : 0;
        if (helping && me.altruism > 0.5)
            candidates.push({ target: member.name, mutual: true, deltas: { trust: 0.012, respect: 0.02, friendship: 0.018 }, reason: 'videl pomoc naselju', salience: 0.75 });
        if (Number(member.health ?? 20) < 18 && me.altruism > 0.55)
            candidates.push({ target: member.name, mutual: true, deltas: { trust: 0.01, friendship: 0.014 }, reason: 'opazil poskodovanega clana', salience: 0.65 });
        if (distance <= 10 && kind !== 'idle')
            candidates.push({ target: member.name, mutual: true, deltas: { trust: 0.006, friendship: 0.01 }, reason: 'delala sva v blizini', salience: 0.5 });
        if (kind !== 'idle' && kind === myKind)
            candidates.push({ target: member.name, mutual: true, deltas: { respect: 0.008, friendship: 0.008 }, reason: `skupno delo: ${kind}`, salience: 0.48 });
        if (helping && me.altruism > 0.5)
            candidates.push({ target: member.name, deltas: { respect: 0.01, friendship: 0.008 }, reason: 'videl pomoč naselju', salience: 0.6 });
        if (competence >= 0.66)
            candidates.push({ target: member.name, deltas: { respect: 0.008 }, reason: 'zmožen član', salience: 0.4 });
        if (idle && settlementShort && me.orderliness > 0.7 && (sp.idleSeen[member.name] ?? 0) >= 3)
            candidates.push({ target: member.name, deltas: { annoyance: 0.01 }, reason: 'počiva, ko primanjkuje zalog', salience: 0.5 });
    }

    // Apply at most ONE nudge per global window, the most salient not recently applied.
    if (candidates.length && now - (sp.lastNudgeAt ?? 0) > NUDGE_GLOBAL_COOLDOWN_MS) {
        candidates.sort((a, b) => b.salience - a.salience);
        for (const c of candidates) {
            const key = `${c.target}:${Object.keys(c.deltas).sort().join('+')}`;
            if (now - (sp.lastNudge[key] ?? 0) < NUDGE_PER_KEY_COOLDOWN_MS) continue;
            sp.lastNudge[key] = now;
            sp.lastNudgeAt = now;
            const update = c.mutual
                ? updateMutual(agent, c.target, c.deltas, c.deltas, `perceive: ${c.reason}`)
                : updateRelation(agent, c.target, c.deltas, `perceive: ${c.reason}`);
            void update.catch(() => { /* lock contention */ });
            break;
        }
    }
}

/** The in-memory opinion model { name -> {needs, competence, lastSeenDoing, ...} }. */
export function getSocialModel(agent) {
    return agent?._socialAware?.model ?? {};
}

/**
 * Compact, human-readable read of how this bot currently sees the others. For the chat
 * prompt (so dialogue reflects social perception) and the Phase-4 goal generator.
 * Returns '' when disabled or empty.
 */
export function socialContext(agent, limit = 4) {
    if (settings.cognition?.social_perception_enabled !== true) return '';
    const model = getSocialModel(agent);
    const names = Object.keys(model);
    if (names.length === 0) return '';
    const label = (c) => (c > 0.66 ? 'zelo sposoben' : c > 0.4 ? 'spodoben' : 'se še uči');
    const lines = names
        .map(name => ({ name, ...model[name] }))
        .sort((a, b) => b.competence - a.competence)
        .slice(0, limit)
        .map(m => `- ${m.name}: ${m.needs.length ? 'rabi ' + m.needs.join('/') : 'preskrbljen'}, ${label(m.competence)}, dela ${m.lastSeenDoing}`);
    return `Social read (kako vidim ostale):\n${lines.join('\n')}`;
}
