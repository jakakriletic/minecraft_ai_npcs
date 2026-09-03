// Cross-process knowledge of container contents. Every bot process reads the same
// small atomic JSON file; writes are serialized so one bot cannot overwrite a
// snapshot learned by another bot at the same time.
import { readFileSync } from 'node:fs';

import { writeJsonAtomic } from '../../utils/atomic_json.js';
import { withNamedLock } from './container_lock.js';

const INDEX_FILE = './bots/container-index.json';
const INDEX_LOCK = 'container-content-index';
const INDEX_VERSION = 1;
const INDEX_WRITE_WAIT_MS = 1500;
const DEFAULT_FRESH_MS = 5 * 60_000;
const MAX_ENTRIES = 256;
const INSTALLED = Symbol('containerIndexInstalled');
const INSTALL_PENDING = Symbol('containerIndexInstallPending');
const INSTRUMENTED = Symbol('containerIndexInstrumented');

function dimensionKey(bot) {
    return String(bot?.game?.dimension ?? 'world');
}

function normalizePosition(blockOrPosition) {
    const position = blockOrPosition?.position ?? blockOrPosition;
    if (![position?.x, position?.y, position?.z].every(Number.isFinite)) return null;
    return {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z),
    };
}

export function containerIndexKey(bot, blockOrPosition) {
    const position = normalizePosition(blockOrPosition);
    return position
        ? `${dimensionKey(bot)}|${position.x},${position.y},${position.z}`
        : null;
}

function emptyIndex() {
    return { version: INDEX_VERSION, updatedAt: null, containers: {} };
}

export function readContainerIndex() {
    try {
        const parsed = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
        if (!parsed || typeof parsed.containers !== 'object') return emptyIndex();
        return parsed;
    } catch {
        return emptyIndex();
    }
}

function jsonValue(value) {
    if (value == null) return null;
    try { return JSON.parse(JSON.stringify(value)); }
    catch { return null; }
}

function serializeItem(item) {
    const snapshot = {
        name: item?.name ?? null,
        type: Number(item?.type),
        metadata: Number(item?.metadata ?? 0),
        count: Math.max(0, Number(item?.count ?? 0)),
        stackSize: Math.max(1, Number(item?.stackSize ?? 64)),
    };
    for (const field of ['durabilityUsed', 'maxDurability', 'enchants']) {
        const value = jsonValue(item?.[field]);
        if (value != null) snapshot[field] = value;
    }
    const nbt = jsonValue(item?.nbt);
    if (nbt != null) snapshot.nbt = nbt;
    return snapshot;
}

function containerItems(container) {
    try {
        return (container?.containerItems?.() ?? [])
            .filter(item => item?.name && Number(item.count) > 0)
            .map(serializeItem);
    } catch {
        return null;
    }
}

function pruneIndex(index) {
    const entries = Object.entries(index.containers ?? {});
    if (entries.length <= MAX_ENTRIES) return;
    entries
        .sort((left, right) => Number(right[1]?.observedAt ?? 0) - Number(left[1]?.observedAt ?? 0))
        .slice(MAX_ENTRIES)
        .forEach(([key]) => delete index.containers[key]);
}

export async function recordContainerSnapshot(bot, block, container, now = Date.now()) {
    const position = normalizePosition(block);
    const key = containerIndexKey(bot, position);
    const items = containerItems(container);
    if (!position || !key || !items) return false;

    const result = await withNamedLock(bot, INDEX_LOCK, async () => {
        const index = readContainerIndex();
        const counts = {};
        for (const item of items)
            counts[item.name] = (counts[item.name] ?? 0) + item.count;
        index.version = INDEX_VERSION;
        index.updatedAt = new Date(now).toISOString();
        index.containers ??= {};
        index.containers[key] = {
            dimension: dimensionKey(bot),
            position,
            items,
            counts,
            observedAt: now,
            observedBy: bot?.username ?? null,
        };
        pruneIndex(index);
        writeJsonAtomic(INDEX_FILE, index);
        return true;
    }, INDEX_WRITE_WAIT_MS, { interruptible: false });
    return Boolean(result.locked && result.value);
}

function safePredicate(predicate, item) {
    try { return Boolean(predicate(item)); }
    catch { return false; }
}

function safeScore(score, items) {
    if (!score || items.length === 0) return 0;
    let best = -Infinity;
    for (const item of items) {
        try {
            const value = Number(score(item));
            if (Number.isFinite(value)) best = Math.max(best, value);
        } catch { /* malformed cached stack */ }
    }
    return Number.isFinite(best) ? best : 0;
}

export function inspectContainerIndex(bot, positions, predicate, options = {}) {
    const index = readContainerIndex();
    const now = options.now ?? Date.now();
    const freshMs = Math.max(1000, Number(options.freshMs ?? DEFAULT_FRESH_MS));
    const matches = [];
    const unknown = [];
    const misses = [];

    for (const rawPosition of positions ?? []) {
        const position = normalizePosition(rawPosition);
        const key = containerIndexKey(bot, position);
        const entry = key ? index.containers?.[key] : null;
        if (!position || !entry || now - Number(entry.observedAt ?? 0) > freshMs) {
            if (position && key) unknown.push({ key, position, entry: entry ?? null });
            continue;
        }
        const matchingItems = (entry.items ?? []).filter(item => safePredicate(predicate, item));
        const detail = {
            key,
            position,
            entry,
            count: matchingItems.reduce((sum, item) => sum + Number(item.count ?? 0), 0),
            score: safeScore(options.score, matchingItems),
        };
        if (matchingItems.length > 0) matches.push(detail);
        else misses.push(detail);
    }
    matches.sort((left, right) => right.score - left.score || right.count - left.count);
    return {
        complete: (positions?.length ?? 0) > 0 && unknown.length === 0,
        matches,
        unknown,
        misses,
        total: matches.reduce((sum, match) => sum + match.count, 0),
    };
}

export function orderContainersFromIndex(bot, blocks, predicate, options = {}) {
    const query = inspectContainerIndex(bot, blocks.map(block => block.position), predicate, options);
    const byKey = new Map(blocks.map(block => [containerIndexKey(bot, block), block]));
    return [
        ...query.matches.map(match => byKey.get(match.key)).filter(Boolean),
        ...query.unknown.map(match => byKey.get(match.key)).filter(Boolean),
    ];
}

function instrumentContainer(bot, block, container) {
    if (!container || container[INSTRUMENTED]) return container;
    container[INSTRUMENTED] = true;
    const originalClose = typeof container.close === 'function'
        ? container.close.bind(container)
        : null;
    if (originalClose) {
        container.close = async (...args) => {
            // Capture the post-mutation slots immediately, but close the GUI while
            // the tiny cross-process index write is acquiring its lock.
            const updating = recordContainerSnapshot(bot, block, container)
                .catch(() => false);
            const result = await originalClose(...args);
            await updating;
            return result;
        };
    }
    return container;
}

export function installContainerIndex(bot) {
    if (!bot || bot[INSTALLED]) return false;
    // Some Mineflayer versions attach openContainer after createBot() returns.
    // Retry once at spawn instead of silently leaving every container unindexed.
    if (typeof bot.openContainer !== 'function') {
        if (!bot[INSTALL_PENDING] && typeof bot.once === 'function') {
            bot[INSTALL_PENDING] = true;
            bot.once('spawn', () => {
                bot[INSTALL_PENDING] = false;
                installContainerIndex(bot);
            });
        }
        return false;
    }
    bot[INSTALLED] = true;
    const originalOpenContainer = bot.openContainer.bind(bot);
    bot.openContainer = async (block, ...args) => {
        const container = instrumentContainer(
            bot,
            block,
            await originalOpenContainer(block, ...args),
        );
        try { await recordContainerSnapshot(bot, block, container); }
        catch { /* gameplay must not fail when the cache cannot be written */ }
        return container;
    };
    return true;
}
