// Structured city planning (deterministic, no LLM).
//
// The settlement shares ONE town plan: a central public-storage plaza and a
// GRID of ZONED plots around it, recorded in bots/town-plan.json. Builders claim
// the nearest free plot (cross-process lock, like the mining party) and build the
// plot's assigned structure at an EXACT aligned origin, so the result reads as a
// laid-out town rather than a random sprinkle.
//
// Phase 1: plan + claiming + aligned placement.
// Phase 2 (this file): ZONING — civic buildings ring the plaza, then residential,
//   workshops, and a defensive perimeter; a fountain anchors the centre. Each plot
//   gets a structure that FITS its footprint. Roads between buildings are handled
//   by roads.js (hub-and-spoke over the now-gridded buildings).
// Phase 3: explicit grid avenues, richer decor pass, street-facing rotation,
//   terrain terracing on slopes (heightmap). See NACRTOVANJE_MESTA.md.
import { existsSync, readFileSync } from 'node:fs';
import { Vec3 } from 'vec3';
import settings from '../../../settings.js';
import * as society from './society.js';
import * as build from './build.js';
import * as storage from './storage.js';
import { goToPosition, log } from './skills.js';
import { withNamedLock } from './container_lock.js';
import { getProtectedBuilds } from './resource_guard.js';
import { writeJsonAtomic } from '../../utils/atomic_json.js';

const FILE = './bots/town-plan.json';
const SCHEM_DIR = './schematics';
const PLAN_VERSION = 6;
const DECOR_VERSION = 3;
const PLOT = 15;            // plot footprint (fits everything up to the town hall/market)
const STRIDE = 22;          // plot center-to-center (≈15 footprint + ≈7 street)
const GRID_RADIUS = 2;      // (2*R+1)^2 cells = 25 → plaza + 24 plots
const CLAIM_TTL_MS = 8 * 60_000;
const MAX_ATTEMPTS = 2;
const MAX_BUILD_STALLS = 6;
const TOWN_BUILD_SPEED = Math.max(0.1, positiveNumber(settings.town_build_speed, 1));
const BASE_BUILD_STEP_BLOCKS = Math.max(4,
    Math.floor(positiveNumber(settings.town_build_step_blocks,
        positiveNumber(settings.build_step_blocks, 24))));
const BUILD_STEP_BLOCKS = Math.max(4, Math.floor(BASE_BUILD_STEP_BLOCKS * TOWN_BUILD_SPEED));
const BUILD_COOLDOWN_MS = Math.max(2000, Math.floor(30_000 / TOWN_BUILD_SPEED));
const MAX_PLOT_ROUGHNESS = Math.max(1, settings.town_max_plot_roughness ?? 3);
const PLOT_SEARCH_RADIUS = Math.max(0, settings.town_plot_search_radius ?? 8);
const MAX_PLOT_BASE_DELTA = Math.max(2, settings.town_max_plot_base_delta ?? 6);
const SITE_MARGIN = 2;
const EMPTY = new Set([
    'air', 'cave_air', 'void_air', 'short_grass', 'tallgrass', 'tall_grass',
    'fern', 'large_fern', 'snow', 'dead_bush', 'vine', 'glow_lichen',
]);
const SURFACE_TERRAIN = new Set([
    'grass_block', 'grass', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
    'dirt_path', 'grass_path', 'mud', 'clay', 'gravel', 'sand', 'red_sand', 'sandstone',
    'red_sandstone', 'stone', 'deepslate', 'granite', 'diorite', 'andesite',
    'tuff', 'calcite', 'dripstone_block', 'moss_block', 'snow_block',
]);

// Unique landmarks assigned once each around the plaza (no duplicate town halls).
const CIVIC_LANDMARKS = ['town_hall', 'village_market', 'library', 'medieval_chapel', 'medieval_tavern', 'british_pub'];
const RESIDENTIAL = ['medieval_cottage', 'british_cottage', 'british_townhouse', 'modern_townhouse', 'hisa', 'koca'];
const WORKSHOP = ['medieval_blacksmith', 'medieval_bakery', 'medieval_apothecary', 'medieval_stable', 'medieval_windmill', 'greenhouse', 'red_barn'];
const DEFENSE = ['medieval_watchtower', 'medieval_gatehouse'];
const STREET_LAMP = 'lamp_post';
const GARDENS = ['garden_pavilion', 'flower_garden', 'park_bench'];
const STREET_DECOR = [
    STREET_LAMP,
    'oak_lantern_post',
    'stone_lantern_pillar',
];
const EDGE_DECOR = [
    'spruce_lantern_arch',
    'notice_board',
    'crate_stack',
    'barrel_stack',
    'woodpile',
    'hay_cart',
    'water_trough',
    'market_awning',
    'flower_planter_boxes',
    'hedge_corner',
    'stone_bench',
];
const FEATURE_DECOR = [
    'village_well',
    'campfire_circle',
    'picnic_table',
    'hedge_arch',
    'scarecrow',
    'crop_patch_small',
    'wayside_shrine',
    'stone_fountain',
    'garden_pavilion',
    'flower_garden',
    'park_bench',
];
const GREENBELT_DECOR = [
    'flower_garden',
    'crop_patch_small',
    'campfire_circle',
    'picnic_table',
    'wayside_shrine',
    'stone_bench',
    'park_bench',
    'garden_pavilion',
];
const STYLE_PRESETS = {
    medieval: {
        civic: ['town_hall', 'medieval_chapel', 'medieval_tavern', 'medieval_guildhall', 'village_market', 'library'],
        residential: ['medieval_cottage', 'medieval_manor', 'koca', 'hisa'],
        workshop: ['medieval_blacksmith', 'medieval_bakery', 'medieval_apothecary', 'medieval_stable', 'medieval_windmill', 'warehouse', 'red_barn'],
        defense: ['medieval_watchtower', 'medieval_gatehouse', 'medieval_barracks', 'medieval_keep'],
        gardens: ['stone_fountain', 'flower_garden', 'garden_pavilion', 'park_bench'],
    },
    modern: {
        civic: ['modern_office', 'town_hall', 'library', 'village_market'],
        residential: ['modern_villa', 'modern_glass_house', 'modern_townhouse'],
        workshop: ['warehouse', 'greenhouse', 'modern_office'],
        defense: ['modern_office'],
        gardens: ['stone_fountain', 'flower_garden', 'park_bench', 'garden_pavilion'],
    },
    british: {
        civic: ['british_pub', 'british_station', 'town_hall', 'library', 'village_market'],
        residential: ['british_cottage', 'british_townhouse'],
        workshop: ['warehouse', 'greenhouse', 'red_barn'],
        defense: ['medieval_watchtower', 'medieval_gatehouse'],
        gardens: ['flower_garden', 'park_bench', 'garden_pavilion'],
    },
    classic: {
        civic: CIVIC_LANDMARKS,
        residential: RESIDENTIAL,
        workshop: WORKSHOP,
        defense: DEFENSE,
        gardens: GARDENS,
    },
    mixed: {
        civic: CIVIC_LANDMARKS,
        residential: RESIDENTIAL,
        workshop: WORKSHOP,
        defense: DEFENSE,
        gardens: GARDENS,
    },
};

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function readPlan() {
    try {
        if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, 'utf8'));
    } catch { /* missing or corrupt → regenerate */ }
    return { active: false, plots: [] };
}

function writePlan(plan) {
    writeJsonAtomic(FILE, plan);
}

async function mutate(bot, fn) {
    const result = await withNamedLock(bot, 'town-plan', () => {
        const next = fn(readPlan());
        if (next) writePlan(next);
        return next ?? readPlan();
    }, 5000);
    return result.locked ? result.value : readPlan();
}

function townCenter(bot) {
    const shared = storage.getPublicStorageAnchor(bot);
    const center = shared ?? society.getSocietyState()?.center;
    if (!center) return null;
    const dimension = String(bot.game?.dimension ?? 'world');
    if (center.dimension && center.dimension !== dimension) return null;
    return {
        x: Math.floor(center.x),
        y: Math.floor(center.y),
        z: Math.floor(center.z),
        dimension,
        style: center.townStyle ?? center.style ?? 'mixed',
    };
}

function planMatchesCenter(plan, center) {
    if (!plan?.center || !center) return false;
    if (Number(plan.version ?? 0) < PLAN_VERSION) return false;
    const dimension = String(center.dimension ?? 'world');
    return Math.abs(Math.floor(plan.center.x) - Math.floor(center.x)) <= 2
        && Math.abs(Math.floor(plan.center.z) - Math.floor(center.z)) <= 2
        && Math.abs(Math.floor(plan.center.y) - Math.floor(center.y)) <= 4
        && String(plan.center.dimension ?? dimension) === dimension
        && String(plan.style ?? plan.center.style ?? 'mixed') === String(center.style ?? 'mixed');
}

function normalizeRotation(rotation = 0) {
    const value = Number(rotation);
    if (!Number.isFinite(value)) return 0;
    return ((Math.round(value) % 4) + 4) % 4;
}

function schematicSize(name, rotation = 0) {
    try {
        const data = JSON.parse(readFileSync(`${SCHEM_DIR}/${name}.json`, 'utf8'));
        if (Array.isArray(data.size) && data.size.length === 3) {
            const [width, height, depth] = data.size;
            return normalizeRotation(rotation) % 2 === 1
                ? [depth, height, width]
                : [width, height, depth];
        }
    } catch { /* fall through to a safe default */ }
    return [PLOT, 8, PLOT];
}

function fits(name, rotation = 0) {
    const [width, , depth] = schematicSize(name, rotation);
    return width <= PLOT && depth <= PLOT;
}

// Keep only the structures that exist on disk and fit a plot, preserving order.
function usable(list) {
    const available = new Set(build.listSchematics());
    return list.filter(name => available.has(name) && fits(name));
}

function usableForFootprint(list, maxWidth, maxDepth = maxWidth) {
    const available = new Set(build.listSchematics());
    return list.filter(name => {
        if (!available.has(name)) return false;
        const [width, , depth] = schematicSize(name);
        return width <= maxWidth && depth <= maxDepth;
    });
}

function hashIndex(seed, length) {
    if (length <= 0) return -1;
    let hash = 0;
    for (const char of String(seed)) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    return hash % length;
}

function pickFrom(list, seed) {
    const index = hashIndex(seed, list.length);
    return index < 0 ? null : list[index];
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function isSurfaceTerrain(name) {
    return SURFACE_TERRAIN.has(name)
        || name?.endsWith('_ore')
        || (name?.endsWith('_terracotta') && !name.includes('glazed'))
        || name === 'terracotta'
        || name === 'stained_hardened_clay';
}

function surfaceAt(bot, x, z, anchorY) {
    const worldMinY = bot.game?.minY ?? -64;
    const minY = Math.max(worldMinY, Math.floor(anchorY) - 18);
    const maxY = Math.min(worldMinY + (bot.game?.height ?? 384) - 2, Math.floor(anchorY) + 24);
    let sawLoaded = false;
    for (let y = maxY; y >= minY; y--) {
        const block = bot.blockAt(new Vec3(x, y, z), false);
        if (!block) continue;
        sawLoaded = true;
        if (EMPTY.has(block.name)) continue;
        if (isSurfaceTerrain(block.name)) return y;
    }
    return sawLoaded ? null : undefined;
}

function plotOffsets(radius) {
    const step = 4;
    const offsets = [{ x: 0, z: 0 }];
    for (let ring = step; ring <= radius; ring += step) {
        for (let x = -ring; x <= ring; x += step) {
            offsets.push({ x, z: -ring }, { x, z: ring });
        }
        for (let z = -ring + step; z <= ring - step; z += step) {
            offsets.push({ x: -ring, z }, { x: ring, z });
        }
    }
    return offsets;
}

function evaluateTerrainSite(bot, plot, bounds, offset) {
    const centerX = Math.floor(plot.x + offset.x);
    const centerZ = Math.floor(plot.z + offset.z);
    const originX = Math.floor(centerX - (bounds.width - 1) / 2);
    const originZ = Math.floor(centerZ - (bounds.depth - 1) / 2);
    const surfaces = [];
    let unloaded = 0;

    for (let x = originX - SITE_MARGIN; x < originX + bounds.width + SITE_MARGIN; x++)
        for (let z = originZ - SITE_MARGIN; z < originZ + bounds.depth + SITE_MARGIN; z++) {
            const surface = surfaceAt(bot, x, z, plot.y);
            if (surface === undefined) {
                unloaded++;
                continue;
            }
            if (surface !== null) surfaces.push(surface);
        }

    const expected = (bounds.width + SITE_MARGIN * 2) * (bounds.depth + SITE_MARGIN * 2);
    if (unloaded > expected * 0.1 || surfaces.length < expected * 0.85) return null;

    const minSurface = Math.min(...surfaces);
    const maxSurface = Math.max(...surfaces);
    const baseY = median(surfaces) + 1;
    const roughness = maxSurface - minSurface;
    const highCut = maxSurface - baseY;
    const deepFill = baseY - minSurface;
    const baseDelta = Math.abs(baseY - Math.floor(plot.y));
    const highColumns = surfaces.filter(y => y >= baseY + 3).length;
    const deepColumns = surfaces.filter(y => y <= baseY - 4).length;
    const highRatio = highColumns / surfaces.length;
    const deepRatio = deepColumns / surfaces.length;
    const safe = roughness <= MAX_PLOT_ROUGHNESS
        && highCut <= 2
        && deepFill <= Math.max(3, settings.town_max_foundation_depth ?? 3)
        && baseDelta <= MAX_PLOT_BASE_DELTA
        && highRatio <= 0.08
        && deepRatio <= 0.12;
    const distance = Math.hypot(offset.x, offset.z);
    const score = roughness * 120
        + highCut * 90
        + deepFill * 45
        + baseDelta * 70
        + highColumns * 18
        + deepColumns * 8
        + distance * 3;

    return {
        safe,
        score,
        distance,
        origin: new Vec3(originX, baseY, originZ),
        bounds,
        minSurface,
        maxSurface,
        roughness,
        highCut,
        deepFill,
        baseDelta,
        center: { x: centerX, y: baseY, z: centerZ },
    };
}

function findTerrainFriendlySite(bot, plot) {
    const [width, height, depth] = schematicSize(plot.schematic, plot.rotation);
    const bounds = { width, height, depth };
    const candidates = plotOffsets(PLOT_SEARCH_RADIUS)
        .map(offset => evaluateTerrainSite(bot, plot, bounds, offset))
        .filter(Boolean)
        .sort((a, b) => a.score - b.score || a.distance - b.distance);
    return candidates.find(candidate => candidate.safe) ?? null;
}

// Entrance faces the plaza (toward center) — stored for Phase 3 rotation.
function plotFacing(i, j) {
    if (Math.abs(i) >= Math.abs(j)) return i > 0 ? 'west' : 'east';
    return j > 0 ? 'north' : 'south';
}

function rotationForFacing(facing) {
    return {
        north: 0,
        east: 1,
        south: 2,
        west: 3,
    }[facing] ?? 0;
}

function zoneOf(i, j) {
    const ring = Math.max(Math.abs(i), Math.abs(j));
    if (ring === 1) return 'civic';
    if (Math.abs(i) === GRID_RADIUS && Math.abs(j) === GRID_RADIUS) return 'defense';
    return (i + j) % 2 === 0 ? 'residential' : 'workshop';
}

function presetFor(style) {
    return STYLE_PRESETS[style] ?? STYLE_PRESETS.mixed;
}

function generatePlan(center, bot = null) {
    const style = center.style ?? 'mixed';
    const preset = presetFor(style);
    const civic = usable(preset.civic);
    const houses = usable(preset.residential);
    const shops = usable(preset.workshop);
    const guards = usable(preset.defense);

    const cells = [];
    for (let i = -GRID_RADIUS; i <= GRID_RADIUS; i++)
        for (let j = -GRID_RADIUS; j <= GRID_RADIUS; j++) {
            const zone = (i === 0 && j === 0) ? 'plaza' : zoneOf(i, j);
            cells.push({ i, j, zone, ring: Math.max(Math.abs(i), Math.abs(j)) });
        }

    // Civic landmarks: one each, assigned around the plaza in a stable angular order;
    // any extra inner plots become houses.
    const civicCells = cells
        .filter(cell => cell.zone === 'civic')
        .sort((a, b) => Math.atan2(a.j, a.i) - Math.atan2(b.j, b.i));
    civicCells.forEach((cell, index) => {
        cell.schematic = index < civic.length ? civic[index] : pickFrom(houses, `${cell.i}_${cell.j}`);
    });

    for (const cell of cells) {
        if (cell.schematic) continue;
        const seed = `${cell.i}_${cell.j}`;
        // The public storage is the physical centre of the village. Keep the
        // central plot reserved so town builds never clear/overwrite the chests,
        // crafting tables, furnaces, or player-donated hub items.
        if (cell.zone === 'plaza') cell.schematic = null;
        else if (cell.zone === 'defense') cell.schematic = pickFrom(guards, seed) ?? pickFrom(houses, seed);
        else if (cell.zone === 'workshop') cell.schematic = pickFrom(shops, seed) ?? pickFrom(houses, seed);
        else cell.schematic = pickFrom(houses, seed);
    }

    const plots = cells.map(cell => {
        const facing = plotFacing(cell.i, cell.j);
        return {
            id: `plot_${cell.i}_${cell.j}`,
            x: center.x + cell.i * STRIDE,
            z: center.z + cell.j * STRIDE,
            gridX: center.x + cell.i * STRIDE,
            gridZ: center.z + cell.j * STRIDE,
            y: center.y,
            zone: cell.zone,
            ring: cell.ring,
            facing,
            rotation: rotationForFacing(facing),
            schematic: cell.schematic ?? null,
            status: cell.schematic ? 'free' : 'built', // nothing to build -> inert
            owner: null,
            attempts: 0,
            claimedAt: null,
        };
    });

    applyTerrainIntent(bot, plots, style);
    const allPlots = [...plots, ...decorPlots(center, style)];

    return {
        active: true,
        version: PLAN_VERSION,
        decorVersion: DECOR_VERSION,
        style,
        center: { ...center, style },
        createdAt: new Date().toISOString(),
        plots: reconcilePlanWithProtectedBuilds(bot, { plots: allPlots }).plots,
    };
}

function clearBuildProgress(plot) {
    plot.owner = null;
    plot.attempts = 0;
    plot.claimedAt = null;
    plot.prepared = false;
    plot.progress = 0;
    plot.total = null;
    plot.stalls = 0;
    plot.blockedReason = null;
    plot.stalledReason = null;
}

function applyPlannedSite(plot, site) {
    plot.x = site.center.x;
    plot.y = site.origin.y;
    plot.z = site.center.z;
    plot.origin = {
        x: site.origin.x,
        y: site.origin.y,
        z: site.origin.z,
    };
    plot.bounds = site.bounds;
    plot.terrain = {
        minSurface: site.minSurface,
        maxSurface: site.maxSurface,
        roughness: site.roughness,
        highCut: site.highCut,
        deepFill: site.deepFill,
        baseDelta: site.baseDelta,
    };
    plot.sitePlanned = true;
}

function downgradeToGreenbelt(plot, style) {
    const choices = usableForFootprint([
        ...GREENBELT_DECOR,
        ...(presetFor(style).gardens ?? GARDENS),
    ], 9);
    const schematic = pickFrom(choices, `${style}:greenbelt:${plot.id}`);
    plot.zone = 'decor';
    plot.facing = 'south';
    plot.rotation = 0;
    plot.schematic = schematic ?? null;
    plot.status = schematic ? 'free' : 'built';
    plot.terrain = {
        ...(plot.terrain ?? {}),
        greenbelt: true,
        reason: 'terrain_too_steep_for_building',
    };
    plot.origin = null;
    plot.bounds = null;
    clearBuildProgress(plot);
}

function applyTerrainIntent(bot, plots, style) {
    if (!bot?.entity) return;
    for (const plot of plots) {
        if (!plot.schematic || plot.zone === 'plaza') continue;
        const loadedProbe = surfaceAt(bot, Math.floor(plot.x), Math.floor(plot.z), plot.y);
        if (loadedProbe === undefined) continue;
        const site = findTerrainFriendlySite(bot, plot);
        if (site) {
            applyPlannedSite(plot, site);
            continue;
        }
        downgradeToGreenbelt(plot, style);
    }
}

function decorPlot(center, ox, oz, schematic, id, ring = null) {
    return {
        id,
        x: center.x + ox,
        z: center.z + oz,
        gridX: center.x + ox,
        gridZ: center.z + oz,
        y: center.y,
        zone: 'decor',
        ring: ring ?? Math.max(1, Math.ceil(Math.hypot(ox, oz) / STRIDE)),
        facing: 'south',
        rotation: 0,
        schematic: schematic ?? null,
        status: schematic ? 'free' : 'built',
        owner: null,
        attempts: 0,
        claimedAt: null,
    };
}

function pushDecorChoice(decor, center, ox, oz, choices, id, seed, ring = null) {
    if (!choices.length) return;
    decor.push(decorPlot(center, ox, oz, pickFrom(choices, seed), id, ring));
}

// Compact lights sit at street intersections. Larger details live on the outer
// edge pockets, where the site-prep margin cannot clip a house footprint.
function decorPlots(center, style = 'mixed') {
    const decor = [];
    const streetDecor = usableForFootprint(STREET_DECOR, 3);
    if (streetDecor.length)
        for (let i = -GRID_RADIUS; i < GRID_RADIUS; i++)
            for (let j = -GRID_RADIUS; j < GRID_RADIUS; j++)
                pushDecorChoice(
                    decor,
                    center,
                    (i + 0.5) * STRIDE,
                    (j + 0.5) * STRIDE,
                    streetDecor,
                    `decor_street_${i}_${j}`,
                    `${style}:street:${i}:${j}`,
                    3,
                );

    const edgeDecor = usableForFootprint([...EDGE_DECOR, ...(presetFor(style).gardens ?? GARDENS)], 9);
    const outer = GRID_RADIUS * STRIDE + Math.ceil(PLOT / 2) + SITE_MARGIN + 6;
    if (edgeDecor.length) {
        for (const side of [-1, 1]) {
            for (const k of [-1, 0, 1]) {
                pushDecorChoice(decor, center, side * outer, k * STRIDE, edgeDecor,
                    `decor_edge_x_${side}_${k}`, `${style}:edge:x:${side}:${k}`, 4);
                pushDecorChoice(decor, center, k * STRIDE, side * outer, edgeDecor,
                    `decor_edge_z_${side}_${k}`, `${style}:edge:z:${side}:${k}`, 4);
            }
        }
    }

    const featureDecor = usableForFootprint([...FEATURE_DECOR, ...(presetFor(style).gardens ?? GARDENS)], 11);
    const reach = (GRID_RADIUS + 1) * STRIDE;
    for (const [dx, dz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]])
        pushDecorChoice(decor, center, dx * reach, dz * reach, featureDecor,
            `decor_corner_${dx}_${dz}`, `${style}:corner:${dx}:${dz}`, 5);

    return decor;
}

function canRetargetDecor(plot) {
    return plot.zone === 'decor'
        && ['free', 'blocked'].includes(plot.status)
        && !plot.prepared
        && !plot.owner;
}

function sameDecorSpot(plot, desired) {
    return plot.zone === 'decor'
        && Math.abs(Math.floor(plot.x) - Math.floor(desired.x)) <= 1
        && Math.abs(Math.floor(plot.z) - Math.floor(desired.z)) <= 1;
}

function applyDecorTarget(plot, desired) {
    const id = plot.id;
    Object.assign(plot, desired, {
        id,
        status: desired.schematic ? 'free' : 'built',
        owner: null,
        attempts: 0,
        claimedAt: null,
        prepared: false,
        progress: 0,
        total: null,
        stalls: 0,
        blockedReason: null,
        stalledReason: null,
        origin: null,
        bounds: null,
        terrain: null,
    });
}

function planNeedsDecorUpgrade(plan) {
    return Number(plan.decorVersion ?? 0) < DECOR_VERSION
        || !(plan.plots ?? []).some(plot => String(plot.id ?? '').startsWith('decor_edge_'));
}

function upgradeTownDecor(plan, center) {
    const style = center.style ?? plan.style ?? plan.center?.style ?? 'mixed';
    const plots = (plan.plots ?? []).map(plot => ({ ...plot }));
    for (const desired of decorPlots(center, style)) {
        const sameId = plots.find(plot => plot.id === desired.id);
        if (sameId) {
            if (canRetargetDecor(sameId)) applyDecorTarget(sameId, desired);
            continue;
        }
        const sameSpot = plots.find(plot => sameDecorSpot(plot, desired));
        if (sameSpot) {
            if (canRetargetDecor(sameSpot)) applyDecorTarget(sameSpot, desired);
            continue;
        }
        plots.push(desired);
    }
    return {
        ...plan,
        version: Math.max(Number(plan.version ?? 0), PLAN_VERSION),
        decorVersion: DECOR_VERSION,
        style,
        center: { ...plan.center, ...center, style },
        plots,
    };
}

function boxesOverlap(firstMin, firstMax, secondMin, secondMax) {
    return firstMin.x <= secondMax.x && firstMax.x >= secondMin.x
        && firstMin.y <= secondMax.y && firstMax.y >= secondMin.y
        && firstMin.z <= secondMax.z && firstMax.z >= secondMin.z;
}

function plotBuildBox(plot) {
    const site = defaultPlotSite(plot);
    const min = {
        x: Math.floor(site.origin.x),
        y: Math.floor(site.origin.y),
        z: Math.floor(site.origin.z),
    };
    const max = {
        x: min.x + site.bounds.width - 1,
        y: min.y + site.bounds.height - 1,
        z: min.z + site.bounds.depth - 1,
    };
    return { min, max };
}

function findProtectedBuildConflict(bot, plot) {
    const { min, max } = plotBuildBox(plot);
    for (const entry of getProtectedBuilds(bot)) {
        const sameRegisteredBuild = entry.name === plot.schematic
            && entry.min.x === min.x && entry.min.y === min.y && entry.min.z === min.z
            && entry.max.x === max.x && entry.max.y === max.y && entry.max.z === max.z;
        if (sameRegisteredBuild) return { entry, sameRegisteredBuild: true };
        if (boxesOverlap(min, max, entry.min, entry.max))
            return { entry, sameRegisteredBuild: false };
    }
    return null;
}

function protectedBuildConflictsPlot(bot, plot) {
    const conflict = findProtectedBuildConflict(bot, plot);
    return Boolean(conflict && !conflict.sameRegisteredBuild);
}

function reconcilePlanWithProtectedBuilds(bot, plan) {
    if (!bot?.entity) return plan;
    const plots = (plan.plots ?? []).map(plot => {
        if (!plot.schematic || plot.status === 'built') return plot;
        const conflict = findProtectedBuildConflict(bot, plot);
        if (!conflict) return plot;
        const next = { ...plot };
        if (conflict.sameRegisteredBuild) {
            next.status = 'built';
            next.owner = conflict.entry.owner ?? null;
            next.prepared = true;
            next.builtAt = conflict.entry.updatedAt ?? conflict.entry.createdAt ?? new Date().toISOString();
            next.progress = next.total ?? null;
            next.stalls = 0;
        } else {
            next.status = 'blocked';
            next.owner = null;
            next.claimedAt = null;
            next.blockedReason = `existing_build:${conflict.entry.name}`;
        }
        return next;
    });
    return { ...plan, plots };
}

function isClaimable(bot, plot) {
    if (!plot.schematic) return false;
    if (plot.status === 'free') return !protectedBuildConflictsPlot(bot, plot);
    if (plot.status === 'blocked'
        && plot.prepared
        && (plot.progress ?? 0) < (plot.total ?? Number.POSITIVE_INFINITY)
        && (plot.stalls ?? 0) < MAX_BUILD_STALLS
        && !protectedBuildConflictsPlot(bot, plot))
        return true;
    if (plot.status === 'claimed' && Date.now() - Date.parse(plot.claimedAt ?? 0) > CLAIM_TTL_MS)
        return !protectedBuildConflictsPlot(bot, plot); // builder vanished -> reclaimable
    if (['preparing', 'building'].includes(plot.status)
        && Date.now() - Date.parse(plot.claimedAt ?? 0) > CLAIM_TTL_MS)
        return !protectedBuildConflictsPlot(bot, plot);
    return false;
}

async function ensurePlan(bot, center) {
    const plan = readPlan();
    if (plan.active && plan.plots?.length && planMatchesCenter(plan, center)) {
        if (!planNeedsDecorUpgrade(plan)) return plan;
        return await mutate(bot, current =>
            (current.active && current.plots?.length && planMatchesCenter(current, center))
                ? reconcilePlanWithProtectedBuilds(bot, upgradeTownDecor(current, center))
                : generatePlan(center, bot));
    }
    if (plan.active && plan.plots?.length)
        log(bot, 'Town plan premikam na trenutni javni storage center.');
    return await mutate(bot, current =>
        (current.active && current.plots?.length && planMatchesCenter(current, center))
            ? reconcilePlanWithProtectedBuilds(bot, planNeedsDecorUpgrade(current) ? upgradeTownDecor(current, center) : current)
            : generatePlan(center, bot));
}

export async function resetTownPlan(bot, center = townCenter(bot)) {
    if (!center) return false;
    const plan = await mutate(bot, () => generatePlan(center, bot));
    const ok = planMatchesCenter(plan, center);
    if (ok)
        log(bot, `Town plan je zdaj centriran na storage pri ${center.x},${center.y},${center.z} (stil ${plan.style ?? 'mixed'}).`);
    return ok;
}

export function townBuildCooldownMs() {
    return BUILD_COOLDOWN_MS;
}

function decorClaimRank(plan, plot) {
    if (plot.zone !== 'decor') return 0;
    const plots = plan.plots ?? [];
    const builtBuildings = plots.filter(entry => entry.zone !== 'decor'
        && entry.zone !== 'plaza'
        && entry.status === 'built').length;
    const openBuildings = plots.filter(entry => entry.zone !== 'decor'
        && entry.zone !== 'plaza'
        && entry.schematic
        && entry.status !== 'built'
        && entry.status !== 'blocked').length;
    if (openBuildings === 0) return 0;
    const openCivic = plots.some(entry => entry.zone === 'civic'
        && entry.schematic
        && entry.status !== 'built'
        && entry.status !== 'blocked');
    if (openCivic || builtBuildings < 8) return 1.5;
    const startedDecor = plots.filter(entry => entry.zone === 'decor'
        && entry.status !== 'free'
        && entry.status !== 'blocked').length;
    const decorBudget = Math.floor((builtBuildings - 6) / 3);
    return startedDecor < decorBudget ? -0.1 : 1;
}

// Claim the nearest claimable plot (civic ring first, since it's closest to centre).
async function claimNextPlot(agent, center) {
    const bot = agent.bot;
    let claimed = null;
    await mutate(bot, plan => {
        const decorRank = plot => decorClaimRank(plan, plot);
        const ownStarted = (plan.plots ?? [])
            .filter(plot => plot.owner === agent.name && ['preparing', 'building'].includes(plot.status))
            .sort((a, b) =>
                decorRank(a) - decorRank(b)
                || Math.hypot(a.x - center.x, a.z - center.z) - Math.hypot(b.x - center.x, b.z - center.z))[0];
        const candidate = ownStarted ?? (plan.plots ?? [])
            .filter(plot => isClaimable(bot, plot))
            .sort((a, b) =>
                decorRank(a) - decorRank(b)
                || Math.hypot(a.x - center.x, a.z - center.z) - Math.hypot(b.x - center.x, b.z - center.z))[0];
        if (!candidate) return plan;
        if (!['preparing', 'building'].includes(candidate.status))
            candidate.status = 'claimed';
        candidate.owner = agent.name;
        candidate.claimedAt = new Date().toISOString();
        claimed = { ...candidate };
        return plan;
    });
    return claimed;
}

async function finishPlotStep(bot, plotId, outcome) {
    await mutate(bot, plan => {
        const plot = (plan.plots ?? []).find(entry => entry.id === plotId);
        if (!plot) return plan;
        const previousProgress = Number(plot.progress ?? 0);
        const correct = Number(outcome.correct ?? 0);
        const verifiedProgress = correct > previousProgress;
        if (outcome.site) {
            plot.origin = {
                x: outcome.site.origin.x,
                y: outcome.site.origin.y,
                z: outcome.site.origin.z,
            };
            plot.bounds = outcome.site.bounds;
            plot.terrain = {
                minSurface: outcome.site.minSurface,
                maxSurface: outcome.site.maxSurface,
                roughness: outcome.site.roughness,
                highCut: outcome.site.highCut,
                deepFill: outcome.site.deepFill,
                baseDelta: outcome.site.baseDelta,
            };
        }
        if (outcome.complete) {
            plot.status = 'built';
            plot.builtAt = new Date().toISOString();
            plot.progress = outcome.total ?? plot.progress ?? null;
            plot.stalls = 0;
        } else if (outcome.prepared || verifiedProgress) {
            plot.status = 'building';
            plot.prepared = true;
            plot.progress = Math.max(correct, previousProgress);
            plot.total = outcome.total ?? plot.total ?? null;
            plot.claimedAt = new Date().toISOString();
            plot.stalls = 0;
        } else if (outcome.retryable || outcome.placed > 0) {
            plot.status = 'building';
            plot.prepared = plot.prepared || outcome.prepared === true;
            plot.progress = previousProgress;
            plot.total = outcome.total ?? plot.total ?? null;
            plot.claimedAt = new Date().toISOString();
            plot.stalls = (plot.stalls ?? 0) + 1;
            plot.stalledReason = outcome.reason ?? 'no_verified_progress';
            if (plot.stalls >= MAX_BUILD_STALLS) {
                plot.status = 'blocked';
                plot.blockedReason = plot.stalledReason;
                plot.owner = null;
                plot.claimedAt = null;
            }
        } else if (outcome.blocked) {
            plot.status = 'blocked';
            plot.blockedReason = outcome.reason ?? 'terrain';
            plot.owner = null;
            plot.claimedAt = null;
        } else {
            plot.attempts = (plot.attempts ?? 0) + 1;
            plot.status = plot.attempts >= MAX_ATTEMPTS ? 'blocked' : 'free';
            plot.owner = null;
            plot.claimedAt = null;
        }
        return plan;
    });
}

function defaultPlotSite(plot) {
    if (plot.origin && plot.bounds) {
        const origin = new Vec3(plot.origin.x, plot.origin.y, plot.origin.z);
        return {
            origin,
            bounds: plot.bounds,
            baseY: origin.y,
            minSurface: plot.terrain?.minSurface ?? origin.y - 4,
            naturalObstacles: 0,
            roughness: plot.terrain?.roughness ?? 0,
            distanceFromAnchor: 0,
        };
    }
    const [width, height, depth] = schematicSize(plot.schematic, plot.rotation);
    const baseY = Math.floor(plot.y);
    const origin = new Vec3(
        Math.floor(plot.x - (width - 1) / 2),
        baseY,
        Math.floor(plot.z - (depth - 1) / 2),
    );
    return {
        origin,
        bounds: { width, height, depth },
        baseY,
        minSurface: baseY - 4,
        naturalObstacles: 0,
        roughness: 0,
        distanceFromAnchor: 0,
    };
}

async function moveNearPlot(bot, site) {
    const stand = new Vec3(
        site.origin.x + Math.floor(site.bounds.width / 2),
        site.origin.y,
        site.origin.z - SITE_MARGIN - 2,
    );
    try {
        return await goToPosition(
            bot,
            stand.x,
            stand.y,
            stand.z,
            Math.max(8, Math.ceil(Math.max(site.bounds.width, site.bounds.depth) / 2)),
        );
    } catch {
        return false;
    }
}

function plotChunksLookLoaded(bot, site) {
    const samples = [
        site.origin,
        site.origin.offset(site.bounds.width - 1, 0, 0),
        site.origin.offset(0, 0, site.bounds.depth - 1),
        site.origin.offset(site.bounds.width - 1, 0, site.bounds.depth - 1),
    ];
    return samples.some(pos => bot.blockAt(pos, false));
}

// Build one short command-based step at its exact, aligned origin. No creative,
// no flying, no inventory mutation: the town itself is constructing.
async function buildPlotStep(agent, plot) {
    const bot = agent.bot;
    if (!plot.schematic) return { placed: 0, complete: false };
    const fallbackSite = defaultPlotSite(plot);
    await moveNearPlot(bot, fallbackSite);
    const terrainSite = !plot.prepared && !plot.origin
        ? findTerrainFriendlySite(bot, plot)
        : null;
    const site = terrainSite ?? fallbackSite;
    if (!plot.prepared) {
        log(bot, `Pripravljam parcelo ${plot.id} za ${plot.schematic}.`);
        const prepared = await build.prepareBuildSiteWithCommands(bot, site);
        return { placed: 0, complete: false, prepared, site, retryable: !prepared, reason: 'prepare_failed' };
    }
    if (!plotChunksLookLoaded(bot, site)) {
        log(bot, `Parcela ${plot.id} se ni dovolj nalozila; poskusim kasneje.`);
        return { placed: 0, complete: false, retryable: true, reason: 'chunks_unloaded', site };
    }
    log(bot, `Mesto gradi (${plot.zone}): ${plot.schematic} na parceli ${plot.id}.`);
    const result = await build.buildSchematicCommandStep(
        bot,
        plot.schematic,
        site.origin,
        BUILD_STEP_BLOCKS,
        plot.rotation ?? rotationForFacing(plot.facing),
    );
    return { ...result, site, retryable: !result.complete && (result.correct ?? 0) <= (plot.progress ?? 0) };
}

async function buildNextPlot(agent, center) {
    const bot = agent.bot;
    await ensurePlan(bot, center);
    const plot = await claimNextPlot(agent, center);
    if (!plot) return false;
    let outcome = { placed: 0, complete: false };
    try {
        outcome = await buildPlotStep(agent, plot);
    } finally {
        await finishPlotStep(bot, plot.id, outcome);
    }
    return outcome.complete || outcome.prepared || (outcome.correct ?? 0) > (plot.progress ?? 0);
}

export async function queueBuild(bot, schematicName) {
    const center = townCenter(bot);
    if (!center) {
        log(bot, 'Najprej nastavi javni storage center z !storage <stil>.');
        return null;
    }
    if (!fits(schematicName)) {
        const [width, , depth] = schematicSize(schematicName);
        log(bot, `Schematic "${schematicName}" je prevelik za mestno parcelo (${width}x${depth}, max ${PLOT}x${PLOT}).`);
        return null;
    }
    await ensurePlan(bot, center);
    let queued = null;
    await mutate(bot, plan => {
        const candidate = (plan.plots ?? [])
            .filter(plot => plot.zone !== 'plaza'
                && plot.zone !== 'decor'
                && (plot.status === 'free'
                    || (plot.status === 'blocked' && !protectedBuildConflictsPlot(bot, plot))))
            .sort((a, b) =>
                (a.status === 'blocked' ? 1 : 0) - (b.status === 'blocked' ? 1 : 0)
                || Math.hypot(a.x - center.x, a.z - center.z)
                - Math.hypot(b.x - center.x, b.z - center.z))[0];
        if (!candidate) return plan;
        candidate.schematic = schematicName;
        candidate.rotation = candidate.rotation ?? rotationForFacing(candidate.facing);
        candidate.status = 'free';
        candidate.owner = null;
        candidate.attempts = 0;
        candidate.claimedAt = null;
        candidate.prepared = false;
        candidate.progress = 0;
        candidate.total = null;
        candidate.stalls = 0;
        candidate.blockedReason = null;
        candidate.stalledReason = null;
        candidate.origin = null;
        candidate.bounds = null;
        candidate.terrain = null;
        candidate.queuedBy = bot.username;
        candidate.queuedAt = new Date().toISOString();
        queued = { ...candidate };
        return plan;
    });
    if (queued)
        log(bot, `Dodano v gradbeni queue: ${schematicName} na parceli ${queued.id}.`);
    else
        log(bot, 'Ni proste mestne parcele za novo gradnjo.');
    return queued;
}

// Cheap sync check for brain.js: is there town-building work for this member?
export function planBuildAction(agent) {
    if (settings.kingdom_mode === false || settings.allow_building === false) return null;
    const center = townCenter(agent.bot);
    if (!center) return null;
    const plan = readPlan();
    const hasOwnStarted = (plan.plots ?? [])
        .some(plot => plot.owner === agent.name && ['preparing', 'building'].includes(plot.status));
    if (plan.active && plan.plots?.length && planMatchesCenter(plan, center)
        && !hasOwnStarted && !plan.plots.some(plot => isClaimable(agent.bot, plot))) return null;
    return { name: 'townBuild', timeout: 2, fn: async () => await buildNextPlot(agent, center) };
}

export function townSummary() {
    const plan = readPlan();
    const plots = plan.plots ?? [];
    const byZone = {};
    for (const plot of plots) {
        byZone[plot.zone] ??= { total: 0, built: 0 };
        byZone[plot.zone].total++;
        if (plot.status === 'built') byZone[plot.zone].built++;
    }
    return {
        active: plan.active === true,
        style: plan.style ?? 'mixed',
        total: plots.length,
        built: plots.filter(p => p.status === 'built').length,
        claimed: plots.filter(p => p.status === 'claimed').length,
        building: plots.filter(p => ['preparing', 'building'].includes(p.status)).length,
        free: plots.filter(p => p.status === 'free').length,
        blocked: plots.filter(p => p.status === 'blocked').length,
        byZone,
    };
}
