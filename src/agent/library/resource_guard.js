// Shared structure protection and conservative deterministic resource selection.
import { existsSync, readFileSync, statSync } from 'fs';
import { Vec3 } from 'vec3';
import { withNamedLock } from './container_lock.js';
import * as mc from '../../utils/mcdata.js';
import { writeJsonAtomic } from '../../utils/atomic_json.js';

const REGISTRY_FILE = './bots/protected-builds.json';
const KINGDOM_FILE = './bots/kingdom.json';
const PUBLIC_STORAGE_FILE = './bots/public-storage.json';
const TOWN_PLAN_FILE = './bots/town-plan.json';
const CACHE_MS = 1000;
const SETTLEMENT_CACHE_MS = 2000;
const BUILD_PADDING = 2;
const MINING_PADDING = 12;
const TOWN_PLAN_PADDING = 4;
const TOWN_MINING_EXTRA_MARGIN = 10;
const TREE_LEAF_RANGE = 9;
const ARTIFICIAL_RANGE = 4;
const STRUCTURE_BREAK_RANGE = 6;
const SURFACE_STRUCTURE_MIN_Y = 48;

const ARTIFICIAL_MARKERS = [
    'crafting_table', 'chest', 'trapped_chest', 'barrel', 'furnace', 'lit_furnace',
    'blast_furnace', 'smoker', 'hopper', 'dispenser', 'dropper', 'crafter',
    'glass', 'glass_pane', 'bricks', 'stone_bricks', 'stonebrick', 'cobblestone',
    'mossy_cobblestone', 'torch', 'wall_torch', 'lantern', 'soul_lantern',
    'ladder', 'scaffolding', 'iron_bars', 'bookshelf', 'enchanting_table',
    'anvil', 'chipped_anvil', 'damaged_anvil', 'brewing_stand',
    'planks', 'wooden_slab', 'wooden_door', 'fence', 'fence_gate',
];
const TERRAIN_REQUESTS = new Set([
    'stone', 'cobblestone', 'dirt', 'grass_block', 'grass', 'sand', 'red_sand',
    'gravel', 'clay', 'mud', 'terracotta', 'water', 'lava',
]);

let registryCache = { checkedAt: 0, mtimeMs: -1, builds: [] };
let settlementCache = { checkedAt: 0, zones: [] };
let townPlanCache = { checkedAt: 0, mtimeMs: -1, plan: null, builds: [], zones: [] };
const markerIdCache = new WeakMap();
const leafIdCache = new WeakMap();
const resourceCandidateCache = new WeakMap();
const structureBreakCache = new WeakMap();

function normalizeDimension(value) {
    const raw = String(value ?? 'overworld').toLowerCase().replace(/^minecraft:/, '');
    if (raw === '0' || raw === 'world' || raw === 'overworld') return 'overworld';
    if (raw === '-1' || raw === 'nether' || raw === 'the_nether') return 'the_nether';
    if (raw === '1' || raw === 'end' || raw === 'the_end') return 'the_end';
    return raw;
}

function dimensionKey(bot) {
    return normalizeDimension(bot.game?.dimension);
}

function normalizePoint(point) {
    return {
        x: Math.floor(point.x),
        y: Math.floor(point.y),
        z: Math.floor(point.z),
    };
}

function isValidBuild(build) {
    return build && typeof build.id === 'string' && typeof build.dimension === 'string'
        && ['min', 'max'].every(side => build[side]
            && ['x', 'y', 'z'].every(axis => Number.isFinite(build[side][axis])));
}

function readRegistry(force = false) {
    const now = Date.now();
    if (!force && now - registryCache.checkedAt < CACHE_MS)
        return registryCache.builds;

    registryCache.checkedAt = now;
    try {
        if (!existsSync(REGISTRY_FILE)) {
            registryCache = { checkedAt: now, mtimeMs: -1, builds: [] };
            return registryCache.builds;
        }
        const mtimeMs = statSync(REGISTRY_FILE).mtimeMs;
        if (!force && mtimeMs === registryCache.mtimeMs)
            return registryCache.builds;
        const parsed = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
        const builds = (Array.isArray(parsed) ? parsed : parsed.builds)?.filter(isValidBuild);
        registryCache = {
            checkedAt: now,
            mtimeMs,
            builds: Array.isArray(builds) ? builds : [],
        };
    } catch (error) {
        console.warn(`[resource-guard] could not read ${REGISTRY_FILE}: ${error.message}`);
    }
    return registryCache.builds;
}

function isValidTownBuild(build) {
    return build && ['min', 'max'].every(side => build[side]
        && ['x', 'y', 'z'].every(axis => Number.isFinite(build[side][axis])));
}

function townBuildFromPlot(plan, plot) {
    if (!plan?.center || !plot?.origin || !plot?.bounds) return null;
    if (plot.status === 'blocked') return null;
    const origin = normalizePoint(plot.origin);
    const width = Math.max(1, Math.floor(Number(plot.bounds.width) || 1));
    const height = Math.max(1, Math.floor(Number(plot.bounds.height) || 1));
    const depth = Math.max(1, Math.floor(Number(plot.bounds.depth) || 1));
    const min = origin;
    const max = normalizePoint({
        x: origin.x + width - 1,
        y: origin.y + height - 1,
        z: origin.z + depth - 1,
    });
    return {
        id: `town-plan:${plot.id ?? plot.schematic ?? registryId(normalizeDimension(plan.center.dimension), min, max)}`,
        name: plot.schematic ?? plot.id ?? 'town_plot',
        owner: plot.owner ?? null,
        dimension: normalizeDimension(plan.center.dimension),
        min,
        max,
    };
}

function townPlanRadius(plan, builds) {
    if (!plan?.center || builds.length === 0) return 0;
    let radius = 0;
    for (const build of builds) {
        for (const corner of [
            { x: build.min.x, z: build.min.z },
            { x: build.min.x, z: build.max.z },
            { x: build.max.x, z: build.min.z },
            { x: build.max.x, z: build.max.z },
        ]) {
            radius = Math.max(radius, Math.hypot(corner.x - plan.center.x, corner.z - plan.center.z));
        }
    }
    return Math.ceil(radius + TOWN_MINING_EXTRA_MARGIN);
}

function readTownPlan(force = false) {
    const now = Date.now();
    if (!force && now - townPlanCache.checkedAt < SETTLEMENT_CACHE_MS)
        return townPlanCache;

    townPlanCache.checkedAt = now;
    try {
        if (!existsSync(TOWN_PLAN_FILE)) {
            townPlanCache = { checkedAt: now, mtimeMs: -1, plan: null, builds: [], zones: [] };
            return townPlanCache;
        }
        const mtimeMs = statSync(TOWN_PLAN_FILE).mtimeMs;
        if (!force && mtimeMs === townPlanCache.mtimeMs)
            return townPlanCache;
        const plan = JSON.parse(readFileSync(TOWN_PLAN_FILE, 'utf8'));
        const builds = (plan.active === false ? [] : (plan.plots ?? [])
            .map(plot => townBuildFromPlot(plan, plot))
            .filter(isValidTownBuild));
        const zones = [];
        if (plan.active !== false && plan.center && builds.length > 0) {
            zones.push({
                x: Number(plan.center.x),
                z: Number(plan.center.z),
                radius: townPlanRadius(plan, builds),
                dimension: normalizeDimension(plan.center.dimension),
            });
        }
        townPlanCache = { checkedAt: now, mtimeMs, plan, builds, zones };
    } catch (error) {
        console.warn(`[resource-guard] could not read ${TOWN_PLAN_FILE}: ${error.message}`);
    }
    return townPlanCache;
}

function writeRegistry(builds) {
    writeJsonAtomic(REGISTRY_FILE, { version: 1, builds });
    registryCache = { checkedAt: 0, mtimeMs: -1, builds };
}

function registryId(dimension, min, max) {
    return `${dimension}:${min.x},${min.y},${min.z}:${max.x},${max.y},${max.z}`;
}

function buildBoxesOverlap(firstMin, firstMax, secondMin, secondMax) {
    return firstMin.x <= secondMax.x && firstMax.x >= secondMin.x
        && firstMin.y <= secondMax.y && firstMax.y >= secondMin.y
        && firstMin.z <= secondMax.z && firstMax.z >= secondMin.z;
}

export async function registerProtectedBuild(bot, name, origin, bounds) {
    const min = normalizePoint(origin);
    const max = normalizePoint({
        x: origin.x + bounds.width - 1,
        y: origin.y + bounds.height - 1,
        z: origin.z + bounds.depth - 1,
    });
    const dimension = dimensionKey(bot);
    const id = registryId(dimension, min, max);
    const result = await withNamedLock(bot, 'protected-build-registry', () => {
        const builds = readRegistry(true);
        const now = new Date().toISOString();
        const existing = builds.find(build => build.id === id);
        if (existing?.name === name)
            return { entry: existing, conflict: null };
        const conflict = builds.find(build =>
            normalizeDimension(build.dimension) === dimension
            && build.id !== id
            && buildBoxesOverlap(min, max, build.min, build.max));
        if (existing || conflict)
            return { entry: null, conflict: existing ?? conflict };
        const entry = {
            id,
            name,
            owner: bot.username,
            dimension,
            min,
            max,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        writeRegistry([...builds.filter(build => build.id !== id), entry]);
        return { entry, conflict: null };
    });
    bot._lastBuildRegistrationConflict = result.locked
        ? result.value?.conflict ?? null
        : null;
    return result.locked ? result.value?.entry ?? null : null;
}

export function getProtectedBuilds(bot) {
    const dimension = dimensionKey(bot);
    return readRegistry().filter(build => normalizeDimension(build.dimension) === dimension);
}

export function isPositionProtected(bot, position, padding = BUILD_PADDING) {
    if (!position) return false;
    const dimension = dimensionKey(bot);
    return [...readRegistry(), ...readTownPlan().builds].some(build =>
        normalizeDimension(build.dimension) === dimension
        && position.x >= build.min.x - padding && position.x <= build.max.x + padding
        && position.y >= build.min.y - 1 && position.y <= build.max.y + padding
        && position.z >= build.min.z - padding && position.z <= build.max.z + padding);
}

function readSettlementZones() {
    const now = Date.now();
    if (now - settlementCache.checkedAt < SETTLEMENT_CACHE_MS)
        return settlementCache.zones;

    const zones = [];
    const add = (point, radius, dimension) => {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) return;
        zones.push({
            x: Number(point.x),
            z: Number(point.z),
            radius: Math.max(4, Number(radius) || 10),
            dimension: normalizeDimension(dimension),
        });
    };

    try {
        const kingdom = JSON.parse(readFileSync(KINGDOM_FILE, 'utf8'));
        for (const member of Object.values(kingdom.members ?? {}))
            add(member.home, member.home?.radius, member.position?.dimension ?? kingdom.center?.dimension);
    } catch { /* society may not be initialized yet */ }

    try {
        const shared = JSON.parse(readFileSync(PUBLIC_STORAGE_FILE, 'utf8'));
        add(shared, shared.radius, shared.dimension);
    } catch { /* public storage is optional */ }

    zones.push(...readTownPlan().zones);

    settlementCache = { checkedAt: now, zones };
    return zones;
}

// Mining is kept outside homes and the public hub on the entire vertical column.
// This prevents shafts directly under the settlement while still allowing trees
// and crops in town to be handled by their dedicated systems.
export function isMiningPositionProtected(bot, position, padding = MINING_PADDING) {
    if (!position) return true;
    const dimension = dimensionKey(bot);
    if (readTownPlan().builds.some(build =>
        normalizeDimension(build.dimension) === dimension
        && position.x >= build.min.x - TOWN_PLAN_PADDING && position.x <= build.max.x + TOWN_PLAN_PADDING
        && position.z >= build.min.z - TOWN_PLAN_PADDING && position.z <= build.max.z + TOWN_PLAN_PADDING))
        return true;
    const ownHome = bot._settlementHome;
    if (ownHome && Math.hypot(position.x - ownHome.x, position.z - ownHome.z)
        <= (Number(ownHome.radius) || 10) + padding)
        return true;
    // A home-less bot's personal camp (camp.js) gets a small no-dig bubble too,
    // so the bot never opens a shaft under its own chest corner.
    const ownCamp = bot._personalCamp;
    if (ownCamp && Math.hypot(position.x - ownCamp.x, position.z - ownCamp.z) <= 8 + padding)
        return true;
    return readSettlementZones().some(zone =>
        normalizeDimension(zone.dimension) === dimension
        && Math.hypot(position.x - zone.x, position.z - zone.z) <= zone.radius + padding);
}

function distanceToBox(position, build) {
    const dx = Math.max(build.min.x - position.x, 0, position.x - build.max.x);
    const dy = Math.max(build.min.y - position.y, 0, position.y - build.max.y);
    const dz = Math.max(build.min.z - position.z, 0, position.z - build.max.z);
    return Math.hypot(dx, dy, dz);
}

export function findNearestProtectedBuild(bot, position, maxDistance = 48) {
    const dimension = dimensionKey(bot);
    return [...getProtectedBuilds(bot), ...readTownPlan().builds.filter(build => normalizeDimension(build.dimension) === dimension)]
        .map(build => ({ build, distance: distanceToBox(position, build) }))
        .filter(candidate => candidate.distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance)[0]?.build ?? null;
}

export async function removeProtectedBuild(bot, id) {
    const result = await withNamedLock(bot, 'protected-build-registry', () => {
        const builds = readRegistry(true);
        const remaining = builds.filter(build => build.id !== id);
        if (remaining.length === builds.length) return false;
        writeRegistry(remaining);
        return true;
    });
    return result.locked && result.value;
}

function leafIds(bot) {
    if (leafIdCache.has(bot)) return leafIdCache.get(bot);
    const ids = [
        ...mc.registryBlockIds(bot, ['leaves', 'leaves2']),
        ...Object.values(bot.registry.blocksByName)
            .filter(block => block.name.endsWith('_leaves')
                || block.name === 'nether_wart_block'
                || block.name === 'warped_wart_block')
            .map(block => block.id),
    ];
    leafIdCache.set(bot, ids);
    return ids;
}

function artificialMarkerIds(bot) {
    if (markerIdCache.has(bot)) return markerIdCache.get(bot);
    const ids = Object.values(bot.registry.blocksByName)
        .filter(block => ARTIFICIAL_MARKERS.includes(block.name)
            || block.name.endsWith('_planks')
            || block.name.endsWith('_stairs')
            || block.name.endsWith('_slab')
            || block.name.endsWith('_fence')
            || block.name.endsWith('_fence_gate')
            || block.name.endsWith('_door')
            || block.name.endsWith('_trapdoor')
            || block.name.endsWith('_wall')
            || block.name.endsWith('_concrete')
            || block.name.endsWith('_concrete_powder')
            || block.name.endsWith('_glazed_terracotta'))
        .map(block => block.id);
    markerIdCache.set(bot, ids);
    return ids;
}

function hasNearby(bot, position, ids, maxDistance) {
    if (ids.length === 0) return false;
    return bot.findBlocks({
        point: new Vec3(position.x, position.y, position.z),
        matching: ids,
        maxDistance,
        count: 1,
    }).length > 0;
}

function cachedHasNearbyArtificial(bot, position, maxDistance) {
    if (!position || position.y < SURFACE_STRUCTURE_MIN_Y) return false;
    let cache = structureBreakCache.get(bot);
    if (!cache) {
        cache = new Map();
        structureBreakCache.set(bot, cache);
    }
    const key = `${maxDistance}:${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.checkedAt < 5000)
        return cached.value;
    const value = hasNearby(bot, position, artificialMarkerIds(bot), maxDistance);
    if (cache.size >= 512) cache.clear();
    cache.set(key, { value, checkedAt: Date.now() });
    return value;
}

export function isStructureBreakProtected(bot, position, padding = BUILD_PADDING) {
    if (!position) return true;
    if (isPositionProtected(bot, position, padding)) return true;
    return cachedHasNearbyArtificial(bot, position, STRUCTURE_BREAK_RANGE);
}

function isTreeBlock(name) {
    return name === 'log' || name === 'log2'
        || name?.endsWith('_log') || name?.endsWith('_wood')
        || name?.endsWith('_stem') || name?.endsWith('_hyphae');
}

function isOre(name) {
    return name?.endsWith('_ore') || name === 'ancient_debris';
}

// Every collect path uses this guard. Demolition stays a separate explicit action,
// so even a generic collect command cannot accidentally consume a house.
export function isNaturalResourceCandidate(bot, block, requestedType = block?.name) {
    if (!block?.position || isStructureBreakProtected(bot, block.position)) return false;
    const name = block.name;
    let cache = resourceCandidateCache.get(bot);
    if (!cache) {
        cache = new Map();
        resourceCandidateCache.set(bot, cache);
    }
    const key = `${requestedType}:${name}:${block.position.x},${block.position.y},${block.position.z}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.checkedAt < 5000)
        return cached.value;

    let value;
    if (name === 'cobblestone' || name === 'mossy_cobblestone') {
        value = false;
    } else if (isTreeBlock(name)) {
        value = hasNearby(bot, block.position, leafIds(bot), TREE_LEAF_RANGE)
            && !hasNearby(bot, block.position, artificialMarkerIds(bot), ARTIFICIAL_RANGE);
    } else if (isOre(name)) {
        value = !isMiningPositionProtected(bot, block.position);
    } else if (TERRAIN_REQUESTS.has(requestedType) || TERRAIN_REQUESTS.has(name)) {
        value = !isMiningPositionProtected(bot, block.position)
            && !hasNearby(bot, block.position, artificialMarkerIds(bot), ARTIFICIAL_RANGE);
    } else {
        value = true;
    }

    if (cache.size >= 512) cache.clear();
    cache.set(key, { value, checkedAt: Date.now() });
    return value;
}
