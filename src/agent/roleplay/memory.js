import { existsSync, readFileSync } from 'fs';
import settings from '../settings.js';
import { getPersonality } from './personality.js';
import { writeJsonAtomic } from '../../utils/atomic_json.js';

const DEFAULT_MAX_ENTRIES = 180;
const DEFAULT_CONTEXT_ENTRIES = 8;

function nowIso() {
    return new Date().toISOString();
}

function memoryPath(name) {
    return `./bots/${name}/rp-memory.json`;
}

function stableId(name, type) {
    return `${name}:${type}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
}

function emptyMemory(name, personality = getPersonality(name)) {
    return {
        version: 1,
        bot_name: name,
        personality_snapshot: {
            baseRole: personality.baseRole,
            socialStyle: personality.socialStyle,
            temperament: personality.temperament,
        },
        short_term: [],
        long_term: [],
        social: {},
        world: [],
        task: [],
        character_summary: `${name} is still forming their story in the settlement.`,
        archived_count: 0,
        updatedAt: nowIso(),
    };
}

export function readMemory(name, personality = getPersonality(name)) {
    const file = memoryPath(name);
    try {
        if (!existsSync(file)) {
            const fresh = emptyMemory(name, personality);
            writeJsonAtomic(file, fresh);
            return fresh;
        }
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        return {
            ...emptyMemory(name, personality),
            ...parsed,
            short_term: Array.isArray(parsed.short_term) ? parsed.short_term : [],
            long_term: Array.isArray(parsed.long_term) ? parsed.long_term : [],
            social: parsed.social && typeof parsed.social === 'object' ? parsed.social : {},
            world: Array.isArray(parsed.world) ? parsed.world : [],
            task: Array.isArray(parsed.task) ? parsed.task : [],
        };
    } catch (error) {
        console.warn(`[rp-memory ${name}] could not read memory: ${error.message}`);
        return emptyMemory(name, personality);
    }
}

export function writeMemory(name, memory) {
    memory.updatedAt = nowIso();
    writeJsonAtomic(memoryPath(name), memory);
}

export function ensureMemory(agent) {
    const personality = agent.personality ?? getPersonality(agent.prompter?.profile ?? agent.name);
    const memory = readMemory(agent.name, personality);
    writeMemory(agent.name, memory);
    return memory;
}

function targetBucket(memory, type) {
    if (type === 'world') return memory.world;
    if (type === 'task') return memory.task;
    if (type === 'social') return memory.long_term;
    if (type === 'preference' || type === 'milestone') return memory.long_term;
    return memory.short_term;
}

function summarizeOldEntries(memory, removed) {
    if (removed.length === 0) return;
    const important = removed
        .filter(entry => Number(entry.importance ?? 0) >= 6)
        .slice(-8)
        .map(entry => `${entry.type}: ${entry.content}`);
    const last = removed.at(-1);
    const note = important.length > 0
        ? important.join(' | ')
        : `${removed.length} minor events archived; latest was ${last?.type ?? 'unknown'}.`;
    memory.character_summary = `${memory.character_summary}\n${note}`.trim().slice(-1200);
    memory.archived_count = Number(memory.archived_count ?? 0) + removed.length;
}

export function compactMemory(memory, maxEntries = settings.rp_memory_max_entries ?? DEFAULT_MAX_ENTRIES) {
    const buckets = [memory.short_term, memory.long_term, memory.world, memory.task];
    let all = buckets.flat().sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const now = Date.now();
    all = all.filter(entry => !entry.expiresAt || Date.parse(entry.expiresAt) > now);
    if (all.length <= maxEntries) {
        memory.short_term = all.filter(entry => entry.bucket === 'short_term' || !entry.bucket).slice(0, maxEntries);
        memory.long_term = all.filter(entry => entry.bucket === 'long_term');
        memory.world = all.filter(entry => entry.bucket === 'world');
        memory.task = all.filter(entry => entry.bucket === 'task');
        return memory;
    }

    const keep = all
        .filter((entry, index) => index < Math.floor(maxEntries * 0.55) || Number(entry.importance ?? 0) >= 6)
        .slice(0, maxEntries);
    const keepIds = new Set(keep.map(entry => entry.id));
    summarizeOldEntries(memory, all.filter(entry => !keepIds.has(entry.id)));
    memory.short_term = keep.filter(entry => entry.bucket === 'short_term' || !entry.bucket);
    memory.long_term = keep.filter(entry => entry.bucket === 'long_term');
    memory.world = keep.filter(entry => entry.bucket === 'world');
    memory.task = keep.filter(entry => entry.bucket === 'task');
    return memory;
}

export function addMemory(agentOrName, entry) {
    const name = typeof agentOrName === 'string' ? agentOrName : agentOrName.name;
    const personality = typeof agentOrName === 'string'
        ? getPersonality(name)
        : (agentOrName.personality ?? getPersonality(agentOrName.prompter?.profile ?? name));
    const memory = readMemory(name, personality);
    const type = entry.type ?? 'event';
    const bucketName = entry.bucket
        ?? (type === 'world' ? 'world'
            : type === 'task' ? 'task'
                : (type === 'social' || type === 'preference' || type === 'milestone' ? 'long_term' : 'short_term'));
    const normalized = {
        id: entry.id ?? stableId(name, type),
        bot_name: name,
        type,
        bucket: bucketName,
        content: String(entry.content ?? '').slice(0, 500),
        importance: Math.max(1, Math.min(10, Number(entry.importance ?? 3))),
        timestamp: entry.timestamp ?? nowIso(),
        related_entities: Array.isArray(entry.related_entities) ? entry.related_entities.slice(0, 10) : [],
        expiresAt: entry.expiresAt ?? null,
        decay: entry.decay ?? (bucketName === 'short_term' ? 'session' : 'slow'),
        tone: entry.tone ?? 'neutral',
        source_event: entry.source_event ?? entry.source ?? 'system',
        meta: entry.meta ?? {},
    };
    if (!normalized.content) return memory;
    targetBucket(memory, type).unshift(normalized);
    compactMemory(memory);
    writeMemory(name, memory);
    return memory;
}

export function recordPlanMemory(agent, plan) {
    return addMemory(agent, {
        type: 'task',
        bucket: 'task',
        content: `Planned ${plan.focus}${plan.resource ? `/${plan.resource}` : ''}: ${plan.project || 'no project text'}.`,
        importance: plan.source === 'society' ? 5 : 3,
        related_entities: ['kingdom'],
        tone: 'intentional',
        source_event: `planner:${plan.source ?? 'unknown'}`,
        meta: {
            focus: plan.focus,
            resource: plan.resource,
            amount: plan.amount,
            schematic: plan.schematic,
            expiresAt: plan.expiresAt,
        },
    });
}

export function recordActionMemory(agent, actionName, result) {
    const ok = result?.success && !result?.interrupted && !result?.timedout;
    return addMemory(agent, {
        type: 'task',
        bucket: 'task',
        content: `${ok ? 'Succeeded' : 'Failed'} at ${actionName}.`,
        importance: ok ? 3 : 5,
        related_entities: ['kingdom'],
        tone: ok ? 'satisfied' : 'frustrated',
        source_event: `action:${actionName}`,
        meta: {
            action: actionName,
            success: Boolean(result?.success),
            interrupted: Boolean(result?.interrupted),
            timedout: Boolean(result?.timedout),
        },
    });
}

export function memoryContext(agent, limit = settings.rp_memory_context_entries ?? DEFAULT_CONTEXT_ENTRIES) {
    const memory = readMemory(agent.name, agent.personality ?? getPersonality(agent.name));
    const entries = [
        ...memory.long_term,
        ...memory.social ? Object.values(memory.social).flatMap(v => Array.isArray(v) ? v : []) : [],
        ...memory.world,
        ...memory.task,
        ...memory.short_term,
    ]
        .filter(Boolean)
        .sort((a, b) => (Number(b.importance ?? 0) - Number(a.importance ?? 0))
            || (Date.parse(b.timestamp) - Date.parse(a.timestamp)))
        .slice(0, limit);
    const lines = entries.map(entry =>
        `- [${entry.type}, imp ${entry.importance}, ${entry.tone}] ${entry.content}`);
    return [
        `Character development: ${memory.character_summary}`,
        lines.length > 0 ? `Relevant memories:\n${lines.join('\n')}` : 'Relevant memories: none yet',
    ].join('\n');
}

export function formatMemoryStatus(agent, limit = 8) {
    const memory = readMemory(agent.name, agent.personality ?? getPersonality(agent.name));
    const recent = [...memory.short_term, ...memory.task, ...memory.world, ...memory.long_term]
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
        .slice(0, limit)
        .map(entry => `- ${entry.type}(${entry.importance}): ${entry.content}`)
        .join('\n') || '- no structured memories yet';
    return `${agent.name} memory | archived=${memory.archived_count ?? 0}\n${memory.character_summary}\n${recent}`;
}
