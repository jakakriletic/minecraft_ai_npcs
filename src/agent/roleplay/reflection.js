// ============================================================================
// Reflection / Belief Consolidation - ALTERA / PIANO plan, PHASE 7
// ============================================================================
//
// WHAT THIS IS
// Long-timescale reflection turns recent memories, relationships and shared culture into
// stable beliefs: an updated character_summary, a self_image line, and optional culture
// value/norm updates. It is deliberately rare and never controls movement or actions.
//
// LLM / BUDGET RULE
// Prefer the bot's local Ollama chat model. If the active chat model is not local, this
// module reserves planner budget before the call and records usage afterward. Invalid
// JSON or disconnected model output is ignored rather than written into memory.
//
// WIRING
// brain.js calls tickReflection(agent) from the existing social timer. This function
// schedules itself internally using rp-memory.json, so restarts do not cause a stampede.
// ============================================================================

import settings from '../settings.js';
import { addMemory, compactMemory, readMemory, writeMemory } from './memory.js';
import { relationsFor } from './social_graph.js';
import { getPersonality } from './personality.js';
import { cultureContext, applyReflection } from '../library/culture.js';
import { reservePlannerCall, recordPlannerUsage } from '../library/planner.js';

const MIN_RETRY_MS = 5 * 60_000;
const DEFAULT_OUTPUT_TOKENS = 350;

function nowIso() {
    return new Date().toISOString();
}

function enabled() {
    return settings.cognition?.reflection_enabled === true;
}

function intervalMs() {
    return Math.max(1, Number(settings.cognition?.reflection_interval_minutes ?? 25)) * 60_000;
}

function isLocalModel(agent) {
    const model = String(agent?.prompter?.profile?.model ?? '').toLowerCase();
    return model.startsWith('ollama/') || model.includes('local');
}

function recentEntries(memory, lastReflectionAt, limit = 18) {
    const since = Date.parse(lastReflectionAt ?? 0);
    return [
        ...memory.long_term,
        ...memory.world,
        ...memory.task,
        ...memory.short_term,
    ]
        .filter(Boolean)
        .filter(entry => !since || Date.parse(entry.timestamp) >= since || Number(entry.importance ?? 0) >= 6)
        .sort((a, b) => (Number(b.importance ?? 0) - Number(a.importance ?? 0))
            || (Date.parse(b.timestamp) - Date.parse(a.timestamp)))
        .slice(0, limit);
}

function relationLines(name, limit = 8) {
    return relationsFor(name).slice(0, limit).map(r =>
        `${r.to}: trust=${r.trust.toFixed(2)} respect=${r.respect.toFixed(2)} friendship=${r.friendship.toFixed(2)} annoyance=${r.annoyance.toFixed(2)} rivalry=${r.rivalry.toFixed(2)} debt=${r.debt.toFixed(2)}`);
}

function extractJson(text) {
    if (!text || /My brain disconnected|try again|No response/i.test(text)) return null;
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

function cleanLine(value, max = 500) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeReflection(parsed) {
    const characterSummary = cleanLine(parsed?.character_summary, 900);
    const selfImage = cleanLine(parsed?.self_image, 220);
    const settlementValue = cleanLine(parsed?.settlement_value, 220);
    const normAdjustments = {};
    const rawAdjustments = parsed?.norm_adjustments && typeof parsed.norm_adjustments === 'object'
        ? parsed.norm_adjustments
        : {};
    for (const key of ['sharing_expectation', 'night_caution', 'build_density_preference']) {
        if (rawAdjustments[key] == null) continue;
        const n = Number(rawAdjustments[key]);
        if (Number.isFinite(n)) normAdjustments[key] = Math.max(-0.08, Math.min(0.08, n));
    }
    if (characterSummary.length < 20 || selfImage.length < 10) return null;
    return {
        character_summary: characterSummary,
        self_image: selfImage,
        settlement_value: settlementValue,
        norm_adjustments: normAdjustments,
    };
}

async function callWithTimeout(model, turns, system, timeoutSeconds, requestParams = {}) {
    let timer;
    try {
        return await Promise.race([
            model.sendRequest(turns, system, '***', requestParams),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('reflection timeout')),
                    Math.max(5000, timeoutSeconds * 1000));
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function buildPrompt(agent, memory) {
    const personality = agent.personality ?? getPersonality(agent.prompter?.profile ?? agent.name);
    const entries = recentEntries(memory, memory.last_reflection_at);
    const memories = entries.map(entry =>
        `- ${entry.type}/${entry.tone}/imp${entry.importance}: ${entry.content}`).join('\n') || '- no major new memories';
    const relations = relationLines(agent.name).join('\n') || '- no strong relationships yet';
    const culture = cultureContext(agent) || 'Culture norms: disabled or not formed yet.';

    const system = 'You consolidate a Minecraft NPC memory. Return ONLY valid compact JSON. '
        + 'Do not invent completed actions. Base conclusions only on supplied memories, relations and culture.';
    const user = [
        `Bot: ${agent.name}`,
        `Personality: ${personality.baseRole}; ${personality.temperament}; traits altruism=${personality.altruism} ambition=${personality.ambition} caution=${personality.caution} orderliness=${personality.orderliness}`,
        `Previous character_summary: ${memory.character_summary}`,
        memory.self_image ? `Previous self_image: ${memory.self_image}` : 'Previous self_image: none',
        'Recent memories:',
        memories,
        'Relations:',
        relations,
        culture,
        'Return JSON shape:',
        '{"character_summary":"2-4 sentence stable summary, grounded in evidence","self_image":"one first-person self-belief line","settlement_value":"optional shared value sentence","norm_adjustments":{"sharing_expectation":0.0,"night_caution":0.0,"build_density_preference":0.0}}',
        'Norm adjustments must be small numbers from -0.08 to 0.08.',
    ].join('\n');
    return { system, user };
}

function shouldReflect(memory, now = Date.now()) {
    if (!memory.last_reflection_at) return { due: false, schedule: true };
    const last = Date.parse(memory.last_reflection_at);
    if (!Number.isFinite(last)) return { due: true, schedule: false };
    const attempt = Date.parse(memory.last_reflection_attempt_at ?? 0);
    if (Number.isFinite(attempt) && now - attempt < MIN_RETRY_MS) return { due: false, schedule: false };
    return { due: now - last >= intervalMs(), schedule: false };
}

export async function tickReflection(agent) {
    if (!enabled()) return false;
    if (!agent?.bot?.entity || agent._reflection?.running) return false;

    const personality = agent.personality ?? getPersonality(agent.prompter?.profile ?? agent.name);
    const memory = readMemory(agent.name, personality);
    const decision = shouldReflect(memory);
    if (decision.schedule) {
        memory.last_reflection_at = nowIso();
        memory.last_reflection_attempt_at = null;
        writeMemory(agent.name, memory);
        return false;
    }
    if (!decision.due) return false;

    const model = agent.prompter?.chat_model;
    if (!model) return false;

    agent._reflection = { running: true, startedAt: Date.now() };
    try {
        memory.last_reflection_attempt_at = nowIso();
        writeMemory(agent.name, memory);

        const { system, user } = buildPrompt(agent, memory);
        const outputTokens = Math.max(120, settings.cognition?.reflection_max_output_tokens ?? DEFAULT_OUTPUT_TOKENS);
        const needsBudget = !isLocalModel(agent);
        if (needsBudget) {
            const estimatedInputTokens = Math.ceil((system.length + user.length) / 3) + 100;
            if (!await reservePlannerCall(agent.bot, estimatedInputTokens, outputTokens)) {
                console.log(`[reflect ${agent.name}] planner budget is cooling down`);
                return false;
            }
        }

        let reply;
        try {
            reply = await callWithTimeout(model, [{ role: 'user', content: user }], system,
                Math.max(10, settings.cognition?.reflection_timeout_seconds ?? 45),
                needsBudget ? { reasoning: { effort: 'low' }, max_output_tokens: outputTokens } : {});
        } catch (error) {
            console.log(`[reflect ${agent.name}] ${error.message}`);
            return false;
        } finally {
            if (needsBudget) await recordPlannerUsage(agent.bot, model.last_usage);
        }

        const normalized = normalizeReflection(extractJson(reply));
        if (!normalized) {
            console.log(`[reflect ${agent.name}] invalid reflection output`);
            return false;
        }

        const fresh = readMemory(agent.name, personality);
        fresh.character_summary = normalized.character_summary;
        fresh.self_image = normalized.self_image;
        fresh.last_reflection_at = nowIso();
        fresh.last_reflection_attempt_at = null;
        fresh.reflection_count = Number(fresh.reflection_count ?? 0) + 1;
        compactMemory(fresh);
        writeMemory(agent.name, fresh);

        addMemory(agent, {
            type: 'preference',
            bucket: 'long_term',
            content: `Reflection updated self-image: ${normalized.self_image}`,
            importance: 6,
            tone: 'reflective',
            related_entities: ['kingdom'],
            source_event: 'reflection',
        });
        await applyReflection(agent, normalized);
        console.log(`[reflect ${agent.name}] updated character summary`);
        return true;
    } finally {
        agent._reflection.running = false;
    }
}

function formatAge(iso) {
    if (!iso) return 'never';
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return 'never';
    const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
    if (seconds < 90) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes}m ago`;
    return `${Math.round(minutes / 60)}h ago`;
}

function formatDue(lastReflectionAt) {
    if (!lastReflectionAt) return 'will schedule on next tick';
    const last = Date.parse(lastReflectionAt);
    if (!Number.isFinite(last)) return 'will schedule on next tick';
    const remaining = last + intervalMs() - Date.now();
    if (remaining <= 0) return 'due now';
    const minutes = Math.ceil(remaining / 60_000);
    return minutes <= 1 ? 'within 1m' : `in ${minutes}m`;
}

function compactStatusText(text, fallback, limit = 500) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return fallback;
    return clean.length > limit ? `${clean.slice(0, limit - 1)}...` : clean;
}

export function formatReflectionStatus(agent) {
    const personality = agent.personality ?? getPersonality(agent.prompter?.profile ?? agent.name);
    const memory = readMemory(agent.name, personality);
    return [
        `REFLECTION: enabled=${enabled() ? 'yes' : 'no'} interval=${Math.round(intervalMs() / 60_000)}m`,
        `last: ${formatAge(memory.last_reflection_at)} | next: ${formatDue(memory.last_reflection_at)} | attempts: ${formatAge(memory.last_reflection_attempt_at)}`,
        `count: ${Number(memory.reflection_count ?? 0)} | running: ${agent._reflection?.running ? 'yes' : 'no'}`,
        `self_image: ${compactStatusText(memory.self_image, 'not formed yet', 220)}`,
        `summary: ${compactStatusText(memory.character_summary, 'not formed yet')}`,
    ].join('\n');
}
