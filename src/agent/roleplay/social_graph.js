import { existsSync, readFileSync } from 'fs';
import { withNamedLock } from '../library/container_lock.js';
import { writeJsonAtomic } from '../../utils/atomic_json.js';

const GRAPH_FILE = './bots/rp-social-graph.json';
const METRICS = ['trust', 'respect', 'annoyance', 'rivalry', 'friendship', 'fear', 'dependency', 'debt'];

function nowIso() {
    return new Date().toISOString();
}

function emptyGraph() {
    return {
        version: 1,
        relationships: {},
        updatedAt: nowIso(),
    };
}

// PERF read cache: relationsFor()/relationContext() are called on the HOT brain path
// (every cognition tick, via assembleState + social_goals) and this file grows large, so
// re-reading + JSON.parsing it on every call was a real per-tick cost across 10 bot
// processes (a likely frame-drop source once the cognition layer was added). We cache
// reads briefly — mirroring society.js. Writers force a fresh read UNDER THE LOCK and then
// refresh the cache, so a concurrent write is never read stale into a read-modify-write.
let graphCache = { graph: null, at: 0 };
const GRAPH_CACHE_MS = 1500;

function loadSocialGraph() {
    try {
        if (!existsSync(GRAPH_FILE)) {
            const fresh = emptyGraph();
            writeJsonAtomic(GRAPH_FILE, fresh);
            return fresh;
        }
        const parsed = JSON.parse(readFileSync(GRAPH_FILE, 'utf8'));
        return {
            ...emptyGraph(),
            ...parsed,
            relationships: parsed.relationships && typeof parsed.relationships === 'object'
                ? parsed.relationships
                : {},
        };
    } catch (error) {
        console.warn(`[rp-social] could not read graph: ${error.message}`);
        return emptyGraph();
    }
}

// Read-only callers (relationsFor/relationContext) get the cached graph; they must not
// mutate it. Mutating callers (updateRelation/updateMutual) pass { force: true }.
export function readSocialGraph({ force = false } = {}) {
    if (!force && graphCache.graph && Date.now() - graphCache.at < GRAPH_CACHE_MS)
        return graphCache.graph;
    const graph = loadSocialGraph();
    graphCache = { graph, at: Date.now() };
    return graph;
}

function writeSocialGraph(graph) {
    graph.updatedAt = nowIso();
    writeJsonAtomic(GRAPH_FILE, graph);
    graphCache = { graph, at: Date.now() }; // keep this process's later reads consistent with its own write
}

function relationKey(from, to) {
    return `${from}=>${to}`;
}

function defaultRelation(from, to) {
    return {
        from,
        to,
        trust: 0.5,
        respect: 0.5,
        annoyance: 0,
        rivalry: 0,
        friendship: 0.2,
        fear: 0,
        dependency: 0,
        debt: 0,
        recent_interactions: [],
        updatedAt: nowIso(),
    };
}

function clampMetric(value) {
    return Math.max(0, Math.min(1, Number(value)));
}

function positiveScore(relation) {
    return (relation.friendship ?? 0) * 0.38
        + (relation.trust ?? 0) * 0.32
        + (relation.respect ?? 0) * 0.22
        + (relation.dependency ?? 0) * 0.08
        - (relation.annoyance ?? 0) * 0.28
        - (relation.rivalry ?? 0) * 0.22
        - (relation.fear ?? 0) * 0.2;
}

export function relationStatus(relation) {
    if (!relation) return 'unknown';
    if ((relation.fear ?? 0) >= 0.55) return 'afraid';
    if ((relation.rivalry ?? 0) >= 0.5) return 'rival';
    if ((relation.annoyance ?? 0) >= 0.42 && (relation.friendship ?? 0) < 0.35) return 'strained';
    if ((relation.friendship ?? 0) >= 0.65 && (relation.trust ?? 0) >= 0.62) return 'close_friend';
    if ((relation.friendship ?? 0) >= 0.38 || positiveScore(relation) >= 0.45) return 'friend';
    if ((relation.trust ?? 0) >= 0.58 || (relation.respect ?? 0) >= 0.62) return 'known';
    return 'acquaintance';
}

function applyDeltas(relation, deltas, reason) {
    for (const metric of METRICS) {
        if (deltas[metric] == null) continue;
        relation[metric] = clampMetric(Number(relation[metric] ?? 0) + Number(deltas[metric]));
    }
    relation.recent_interactions.unshift({
        at: nowIso(),
        reason: String(reason ?? 'interaction').slice(0, 160),
        deltas: Object.fromEntries(Object.entries(deltas)
            .filter(([metric]) => METRICS.includes(metric))),
    });
    relation.recent_interactions = relation.recent_interactions.slice(0, 12);
    relation.updatedAt = nowIso();
}

export async function updateRelation(agent, target, deltas, reason = 'interaction') {
    if (!agent?.bot || !agent?.name || !target || target === agent.name) return false;
    const result = await withNamedLock(agent.bot, 'rp-social-graph', () => {
        const graph = readSocialGraph({ force: true });
        const key = relationKey(agent.name, target);
        const relation = graph.relationships[key] ?? defaultRelation(agent.name, target);
        applyDeltas(relation, deltas, reason);
        graph.relationships[key] = relation;
        writeSocialGraph(graph);
        return relation;
    }, 3000);
    return result.locked;
}

export async function updateMutual(agent, target, deltasFromAgent, deltasFromTarget, reason = 'interaction') {
    if (!agent?.bot || !target || target === agent.name) return false;
    const result = await withNamedLock(agent.bot, 'rp-social-graph', () => {
        const graph = readSocialGraph({ force: true });
        const aKey = relationKey(agent.name, target);
        const bKey = relationKey(target, agent.name);
        const a = graph.relationships[aKey] ?? defaultRelation(agent.name, target);
        const b = graph.relationships[bKey] ?? defaultRelation(target, agent.name);
        applyDeltas(a, deltasFromAgent, reason);
        applyDeltas(b, deltasFromTarget ?? deltasFromAgent, reason);
        graph.relationships[aKey] = a;
        graph.relationships[bKey] = b;
        writeSocialGraph(graph);
        return true;
    }, 3000);
    return result.locked && result.value;
}

export function relationsFor(name) {
    const graph = readSocialGraph();
    return Object.values(graph.relationships)
        .filter(relation => relation.from === name)
        .sort((a, b) => (b.friendship + b.trust + b.respect - b.annoyance - b.rivalry)
            - (a.friendship + a.trust + a.respect - a.annoyance - a.rivalry));
}

export function relationContext(name, limit = 6) {
    const relations = relationsFor(name).slice(0, limit);
    if (relations.length === 0) return 'Social relations: no strong opinions yet.';
    return 'Social relations:\n' + relations.map(r =>
        `- ${r.to}: status=${relationStatus(r)}, trust=${r.trust.toFixed(2)}, respect=${r.respect.toFixed(2)}, friendship=${r.friendship.toFixed(2)}, annoyance=${r.annoyance.toFixed(2)}, rivalry=${r.rivalry.toFixed(2)}, debt=${r.debt.toFixed(2)}`)
        .join('\n');
}

export function socialStructure(limit = 5) {
    const graph = readSocialGraph();
    const byKey = graph.relationships ?? {};
    const seenPairs = new Set();
    const bonds = [];
    const tensions = [];
    for (const relation of Object.values(byKey)) {
        const pair = [relation.from, relation.to].sort().join('<=>');
        if (seenPairs.has(pair)) continue;
        seenPairs.add(pair);
        const reverse = byKey[relationKey(relation.to, relation.from)];
        const mutual = reverse ?? relation;
        const bondScore = (positiveScore(relation) + positiveScore(mutual)) / 2;
        const tensionScore = ((relation.annoyance ?? 0) + (mutual.annoyance ?? 0)
            + (relation.rivalry ?? 0) + (mutual.rivalry ?? 0)) / 2;
        if (bondScore >= 0.38 || (relation.friendship ?? 0) >= 0.32 || (mutual.friendship ?? 0) >= 0.32)
            bonds.push({ a: relation.from, b: relation.to, score: bondScore });
        if (tensionScore >= 0.28)
            tensions.push({ a: relation.from, b: relation.to, score: tensionScore });
    }

    const inbound = new Map();
    for (const relation of Object.values(byKey)) {
        const entry = inbound.get(relation.to) ?? { name: relation.to, score: 0, count: 0 };
        entry.score += positiveScore(relation);
        entry.count++;
        inbound.set(relation.to, entry);
    }
    const hubs = [...inbound.values()]
        .filter(entry => entry.count >= 2)
        .map(entry => ({ name: entry.name, score: entry.score / entry.count, count: entry.count }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    return {
        bonds: bonds.sort((a, b) => b.score - a.score).slice(0, limit),
        tensions: tensions.sort((a, b) => b.score - a.score).slice(0, limit),
        hubs,
        updatedAt: graph.updatedAt,
    };
}

export function formatSocialStructure(limit = 5) {
    const structure = socialStructure(limit);
    const bonds = structure.bonds.length
        ? structure.bonds.map(b => `${b.a}<->${b.b} ${(b.score).toFixed(2)}`).join(', ')
        : 'ni mocnih pozitivnih vezi';
    const tensions = structure.tensions.length
        ? structure.tensions.map(t => `${t.a}<->${t.b} ${(t.score).toFixed(2)}`).join(', ')
        : 'ni vecjih napetosti';
    const hubs = structure.hubs.length
        ? structure.hubs.map(h => `${h.name} ${(h.score).toFixed(2)}`).join(', ')
        : 'ni jasnih socialnih hubov';
    return `Social structure: bonds: ${bonds} | tensions: ${tensions} | hubs: ${hubs}`;
}

export function formatRelations(name, target = null) {
    const relations = relationsFor(name).filter(r => !target || r.to.toLowerCase() === target.toLowerCase());
    if (relations.length === 0) return `${name} nima se zabelezenih odnosov${target ? ` do ${target}` : ''}.`;
    const lines = relations.map(r => {
        const last = r.recent_interactions?.[0]?.reason ?? 'brez nedavnih interakcij';
        return `${r.from} -> ${r.to}: ${relationStatus(r)} | trust=${r.trust.toFixed(2)}, respect=${r.respect.toFixed(2)}, friendship=${r.friendship.toFixed(2)}, annoyance=${r.annoyance.toFixed(2)}, rivalry=${r.rivalry.toFixed(2)}, fear=${r.fear.toFixed(2)}, debt=${r.debt.toFixed(2)} | zadnje: ${last}`;
    });
    if (!target) lines.push(formatSocialStructure());
    return lines.join('\n');
}
