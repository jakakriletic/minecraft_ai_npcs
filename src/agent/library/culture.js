// ============================================================================
// Culture / Norm Transmission - ALTERA / PIANO plan, PHASE 6
// ============================================================================
//
// WHAT THIS IS
// Altera-like agents do not only keep private opinions; they gradually form shared
// norms. This module keeps a tiny deterministic culture model for the kingdom:
// scalar norms in [0,1] for each member plus a shared aggregate. Members nudge toward
// each other when they interact or observe each other, weighted by relationship trust.
//
// WHERE IT LIVES
// Stored under `culture` inside bots/kingdom.json and protected with the SAME
// `kingdom-state` lock as society.js. No new cross-process file is introduced.
//
// INPUT / OUTPUT IN AGENT STATE TERMS
//   input : active society members, personality seeds, social graph trust/respect.
//   output: effective norms for this agent, exposed through getNorms() and
//           cultureContext(); cognition.assembleState reads them as `norms`.
//
// DETERMINISM
// No LLM calls. Reflection (Phase 7) may later mutate settlement_value, but scalar
// convergence here stays pure arithmetic.
// ============================================================================

import { existsSync, readFileSync } from 'fs';
import settings from '../settings.js';
import { withNamedLock } from './container_lock.js';
import { writeJsonAtomic } from '../../utils/atomic_json.js';
import * as society from './society.js';
import { getPersonality } from '../roleplay/personality.js';
import { relationsFor } from '../roleplay/social_graph.js';

const STATE_FILE = './bots/kingdom.json';
const NORM_KEYS = ['sharing_expectation', 'night_caution', 'build_density_preference'];
const DEFAULT_VALUE = 'Shared supplies, safety, and a tidy settlement matter more than hoarding.';
const DEFAULT_TICK_MS = 60_000;

const clamp01 = value => Math.max(0, Math.min(1, Number(value)));
const round3 = value => Math.round(clamp01(value) * 1000) / 1000;

function enabled() {
    return settings.cognition?.culture_enabled === true;
}

function nowIso() {
    return new Date().toISOString();
}

function defaultNorms() {
    return {
        sharing_expectation: 0.62,
        night_caution: 0.58,
        build_density_preference: 0.55,
    };
}

function normalizeNorms(norms = defaultNorms()) {
    const base = defaultNorms();
    return Object.fromEntries(NORM_KEYS.map(key => [key, round3(norms[key] ?? base[key])]));
}

function seedNorms(personality) {
    return normalizeNorms({
        sharing_expectation: 0.28 + personality.altruism * 0.48 + personality.orderliness * 0.18 - personality.ambition * 0.08,
        night_caution: 0.22 + personality.caution * 0.58 + (1 - personality.courage) * 0.16,
        build_density_preference: 0.25 + personality.orderliness * 0.42 + personality.ambition * 0.18,
    });
}

function emptyState() {
    return {
        version: 1,
        name: settings.kingdom_name ?? 'Kingdom',
        members: {},
        events: [],
        transfers: {},
        metrics: { buildingCount: 0, roadCount: 0 },
    };
}

function readKingdomState() {
    let state = emptyState();
    try {
        if (existsSync(STATE_FILE))
            state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) };
    } catch (error) {
        console.warn(`[culture] could not read kingdom state: ${error.message}`);
    }
    state.members = state.members && typeof state.members === 'object' ? state.members : {};
    return state;
}

function writeKingdomState(state) {
    state.updatedAt = nowIso();
    writeJsonAtomic(STATE_FILE, state);
}

function ensureCulture(state) {
    const culture = state.culture && typeof state.culture === 'object' ? state.culture : {};
    culture.version = 1;
    culture.norms = normalizeNorms(culture.norms);
    culture.members = culture.members && typeof culture.members === 'object' ? culture.members : {};
    culture.settlement_value = String(culture.settlement_value ?? DEFAULT_VALUE).slice(0, 220);
    culture.updatedAt ??= nowIso();
    state.culture = culture;
    return culture;
}

function ensureMember(culture, name, personality = getPersonality(name)) {
    culture.members[name] ??= {};
    const member = culture.members[name];
    member.norms = normalizeNorms(member.norms ?? seedNorms(personality));
    member.seededFrom ??= personality.name ?? name;
    member.updatedAt ??= nowIso();
    return member;
}

function aggregateCulture(culture) {
    const members = Object.values(culture.members)
        .filter(member => member?.norms)
        .slice(-30);
    if (members.length === 0) {
        culture.norms = normalizeNorms(culture.norms);
        return;
    }
    const totals = Object.fromEntries(NORM_KEYS.map(key => [key, 0]));
    for (const member of members) {
        const norms = normalizeNorms(member.norms);
        for (const key of NORM_KEYS) totals[key] += norms[key];
    }
    culture.norms = normalizeNorms(Object.fromEntries(
        NORM_KEYS.map(key => [key, totals[key] / members.length]),
    ));
}

function relationWeight(from, to) {
    const relation = relationsFor(from).find(entry => entry.to === to);
    const trust = relation?.trust ?? 0.5;
    const respect = relation?.respect ?? 0.5;
    return clamp01((trust + respect) / 2);
}

function blendPair(a, b, rate) {
    const beforeA = normalizeNorms(a);
    const beforeB = normalizeNorms(b);
    for (const key of NORM_KEYS) {
        a[key] = round3(beforeA[key] + (beforeB[key] - beforeA[key]) * rate);
        b[key] = round3(beforeB[key] + (beforeA[key] - beforeB[key]) * rate * 0.75);
    }
}

function effectiveNormsFor(culture, name) {
    const globalNorms = normalizeNorms(culture.norms);
    const personalNorms = culture.members?.[name]?.norms
        ? normalizeNorms(culture.members[name].norms)
        : globalNorms;
    return normalizeNorms(Object.fromEntries(
        NORM_KEYS.map(key => [key, globalNorms[key] * 0.65 + personalNorms[key] * 0.35]),
    ));
}

function nearestMember(agent, members) {
    const bot = agent.bot;
    return members
        .filter(member => member.name !== agent.name && bot.players?.[member.name]?.entity)
        .map(member => ({
            ...member,
            distance: bot.players[member.name].entity.position.distanceTo(bot.entity.position),
        }))
        .filter(member => member.distance <= 14)
        .sort((a, b) => a.distance - b.distance)[0] ?? null;
}

/**
 * Read the effective norms for an agent: mostly global culture, lightly colored by the
 * member's own norms. Safe to call from prompts/scoring; returns defaults when disabled
 * or before culture has been initialized.
 */
export function getNorms(agentOrName = null) {
    const name = typeof agentOrName === 'string' ? agentOrName : agentOrName?.name;
    if (!enabled()) return defaultNorms();
    const state = readKingdomState();
    const culture = ensureCulture(state);
    return name ? effectiveNormsFor(culture, name) : normalizeNorms(culture.norms);
}

export function getCultureState() {
    const state = readKingdomState();
    return ensureCulture(state);
}

/**
 * Cheap convergence tick. Call from the existing 4s social timer; this function internally
 * throttles to ~once per minute per bot and writes under the kingdom-state lock.
 */
export async function tickCulture(agent) {
    if (!enabled()) return null;
    const bot = agent?.bot;
    if (!bot?.entity) return null;

    const local = (agent._culture ??= { lastTickAt: 0 });
    const interval = Math.max(10_000, Number(settings.cognition?.culture_tick_seconds ?? 60) * 1000 || DEFAULT_TICK_MS);
    if (Date.now() - (local.lastTickAt ?? 0) < interval) return null;
    local.lastTickAt = Date.now();

    let members = [];
    try { members = society.activeMembers(bot); } catch { members = []; }
    const partner = nearestMember(agent, members);
    const result = await withNamedLock(bot, 'kingdom-state', () => {
        const state = readKingdomState();
        const culture = ensureCulture(state);
        const me = ensureMember(culture, agent.name, agent.personality ?? getPersonality(agent.prompter?.profile ?? agent.name));

        if (partner) {
            const other = ensureMember(culture, partner.name, getPersonality(partner.name));
            const baseRate = clamp01(Number(settings.cognition?.culture_convergence_rate ?? 0.06));
            const trustWeight = relationWeight(agent.name, partner.name);
            const rate = Math.max(0.005, Math.min(0.18, baseRate * (0.6 + trustWeight)));
            blendPair(me.norms, other.norms, rate);

            const action = String(partner.action ?? '').toLowerCase();
            if (/share|help|give|contribute|socialgoal|kingdomshare/.test(action)) {
                me.norms.sharing_expectation = round3(me.norms.sharing_expectation + rate * 0.25);
                other.norms.sharing_expectation = round3(other.norms.sharing_expectation + rate * 0.25);
            }
            other.updatedAt = nowIso();
            culture.last_interaction = {
                at: nowIso(),
                from: agent.name,
                to: partner.name,
                weight: round3(rate),
            };
        }

        me.updatedAt = nowIso();
        aggregateCulture(culture);
        culture.updatedAt = nowIso();
        writeKingdomState(state);
        return culture;
    }, 3000);
    return result.locked ? result.value : null;
}

/**
 * Direct cooperation signal used by supply sharing. This raises sharing expectation for
 * both sides without waiting for the observation timer.
 */
export async function noteSharing(agent, target) {
    if (!enabled() || !agent?.bot || !target || target === agent.name) return false;
    const result = await withNamedLock(agent.bot, 'kingdom-state', () => {
        const state = readKingdomState();
        const culture = ensureCulture(state);
        const me = ensureMember(culture, agent.name, agent.personality ?? getPersonality(agent.name));
        const other = ensureMember(culture, target, getPersonality(target));
        const bump = Math.max(0.005, Math.min(0.05, Number(settings.cognition?.culture_convergence_rate ?? 0.06) * 0.5));
        me.norms.sharing_expectation = round3(me.norms.sharing_expectation + bump);
        other.norms.sharing_expectation = round3(other.norms.sharing_expectation + bump * 0.7);
        me.updatedAt = nowIso();
        other.updatedAt = nowIso();
        aggregateCulture(culture);
        culture.last_interaction = { at: nowIso(), from: agent.name, to: target, weight: round3(bump), reason: 'sharing' };
        culture.updatedAt = nowIso();
        writeKingdomState(state);
        return true;
    }, 3000);
    return result.locked && result.value;
}

export async function applyReflection(agent, update = {}) {
    if (!enabled() || !agent?.bot) return false;
    const result = await withNamedLock(agent.bot, 'kingdom-state', () => {
        const state = readKingdomState();
        const culture = ensureCulture(state);
        const member = ensureMember(culture, agent.name, agent.personality ?? getPersonality(agent.name));

        const adjustments = update.norm_adjustments && typeof update.norm_adjustments === 'object'
            ? update.norm_adjustments
            : {};
        for (const key of NORM_KEYS) {
            if (adjustments[key] == null) continue;
            member.norms[key] = round3(Number(member.norms[key] ?? defaultNorms()[key])
                + Math.max(-0.08, Math.min(0.08, Number(adjustments[key]))));
        }

        const value = String(update.settlement_value ?? '').replace(/\s+/g, ' ').trim();
        if (value.length >= 12)
            culture.settlement_value = value.slice(0, 220);

        member.updatedAt = nowIso();
        aggregateCulture(culture);
        culture.last_reflection = {
            at: nowIso(),
            actor: agent.name,
        };
        culture.updatedAt = nowIso();
        writeKingdomState(state);
        return true;
    }, 3000);
    return result.locked && result.value;
}

export function cultureContext(agent) {
    if (!enabled()) return '';
    const norms = getNorms(agent);
    const culture = getCultureState();
    return [
        'Culture norms (soft biases, not commands):',
        `- sharing_expectation=${norms.sharing_expectation.toFixed(2)}`,
        `- night_caution=${norms.night_caution.toFixed(2)}`,
        `- build_density_preference=${norms.build_density_preference.toFixed(2)}`,
        `- settlement_value=${culture.settlement_value}`,
    ].join('\n');
}

function normLine(label, norms) {
    return `${label}: sharing=${norms.sharing_expectation.toFixed(2)}, night=${norms.night_caution.toFixed(2)}, build_density=${norms.build_density_preference.toFixed(2)}`;
}

export function formatCultureStatus(agent = null) {
    const culture = getCultureState();
    const globalNorms = normalizeNorms(culture.norms);
    const effective = agent?.name ? getNorms(agent) : globalNorms;
    const memberCount = Object.keys(culture.members ?? {}).length;
    const last = culture.last_interaction
        ? `${culture.last_interaction.from} -> ${culture.last_interaction.to} (${culture.last_interaction.at})`
        : 'none yet';
    const lastReflection = culture.last_reflection
        ? `${culture.last_reflection.actor} (${culture.last_reflection.at})`
        : 'none yet';
    return [
        `CULTURE: enabled=${enabled() ? 'yes' : 'no'} members=${memberCount}`,
        normLine('global', globalNorms),
        agent?.name ? normLine(agent.name, effective) : '',
        `settlement_value: ${culture.settlement_value}`,
        `last convergence: ${last}`,
        `last reflection: ${lastReflection}`,
    ].filter(Boolean).join('\n');
}
