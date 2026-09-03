// Schematic builder for Mindcraft agents. Supports two formats from /schematics:
//   - <name>.json  : simple { "size":[w,h,l], "blocks":[{x,y,z,name}, ...] } (easy to hand-author)
//   - <name>.schem : standard Sponge schematic (WorldEdit export) via prismarine-schematic
// Autonomous builds use survival materials. Manual !build requests first choose
// a safe site, prepare natural terrain, then temporarily use creative.
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { isDeepStrictEqual } from 'util';
import { Vec3 } from 'vec3';
import * as world from './world.js';
import * as base from './base.js';
import * as mc from '../../utils/mcdata.js';
import { ensureCobblestone, ensureLogs, ensurePlanks, goToPosition, log, placeBlock } from './skills.js';
import settings from '../../../settings.js';
import {
    findNearestProtectedBuild,
    getProtectedBuilds,
    registerProtectedBuild,
    removeProtectedBuild,
} from './resource_guard.js';
import { withNamedLock } from './container_lock.js';

const SCHEM_DIR = './schematics';
const MAX_BLOCKS = 3000;
const SKIP = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'fire']);
const PLANK_SUFFIX = '_planks';
const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log'];
const PLANKS = LOGS.map(name => name.replace('_log', '_planks'));
const schematicCache = new Map();
let catalogSnapshot = { signature: '', entries: [] };
const AIR_LIKE = new Set([
    'air', 'cave_air', 'void_air', 'short_grass', 'tallgrass', 'tall_grass', 'fern',
    'large_fern', 'dead_bush', 'snow', 'vine', 'glow_lichen',
]);
const FLUIDS = new Set(['water', 'lava', 'bubble_column']);
const NATURAL_TERRAIN = new Set([
    'grass_block', 'grass', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
    'dirt_path', 'grass_path', 'mud', 'muddy_mangrove_roots', 'clay', 'gravel', 'sand',
    'red_sand', 'sandstone', 'red_sandstone', 'stone', 'deepslate', 'granite',
    'diorite', 'andesite', 'tuff', 'calcite', 'dripstone_block',
    'pointed_dripstone', 'moss_block', 'moss_carpet', 'snow_block', 'ice',
    'packed_ice', 'blue_ice', 'bedrock', 'obsidian', 'netherrack', 'soul_sand',
    'soul_soil', 'end_stone', 'basalt', 'smooth_basalt', 'blackstone',
]);
const NATURAL_PLANTS = new Set([
    'bamboo', 'bamboo_sapling', 'sugar_cane', 'cactus', 'lily_pad', 'kelp',
    'kelp_plant', 'seagrass', 'tall_seagrass', 'brown_mushroom', 'red_mushroom',
    'brown_mushroom_block', 'red_mushroom_block', 'mushroom_stem', 'pumpkin',
    'melon', 'sweet_berry_bush', 'cocoa', 'azalea', 'flowering_azalea',
    'hanging_roots', 'spore_blossom', 'big_dripleaf', 'small_dripleaf',
    'yellow_flower', 'red_flower', 'double_plant',
]);
const PROTECTED_BLOCKS = new Set([
    'chest', 'trapped_chest', 'barrel', 'furnace', 'lit_furnace', 'blast_furnace', 'smoker',
    'crafting_table', 'enchanting_table', 'brewing_stand', 'beacon', 'lodestone',
    'respawn_anchor', 'hopper', 'dispenser', 'dropper', 'crafter', 'jukebox',
    'lectern', 'anvil', 'chipped_anvil', 'damaged_anvil', 'ender_chest',
    'bookshelf', 'cauldron',
]);
const SITE_MARGIN = 2;
const SITE_SEARCH_RINGS = 3;
const SITE_VERTICAL_ABOVE = 24;
const SITE_VERTICAL_BELOW = 18;
const MAX_SAFE_ARTIFICIAL_BLOCKS = 2;
const MAX_FILL_VOLUME = 30000;
const CREATIVE_COMMAND_DELAY_MS = Math.max(40, settings.build_command_delay_ms ?? 75);
const DEFAULT_PHYSICS_GRAVITY = 0.08;

const CATEGORY_DEFINITIONS = {
    medieval: {
        label: 'srednjeveske',
        aliases: ['medieval', 'medieval buildings', 'medieval houses', 'srednjevesko', 'srednjeveske', 'srednjeveske stavbe'],
    },
    modern: {
        label: 'moderne',
        aliases: ['modern', 'modern buildings', 'modern houses', 'moderno', 'moderne', 'moderne stavbe', 'moderne hise'],
    },
    british: {
        label: 'britanske',
        aliases: ['british', 'british buildings', 'british houses', 'britansko', 'britanske', 'britanske stavbe', 'britanske hise'],
    },
    civic: {
        label: 'mestne',
        aliases: ['civic', 'civic buildings', 'public buildings', 'mesto', 'mestne', 'mestne stavbe', 'javne stavbe'],
    },
    utility: {
        label: 'uporabne',
        aliases: ['utility', 'utility buildings', 'uporabno', 'uporabne', 'uporabne stavbe'],
    },
    decor: {
        label: 'dekor',
        aliases: ['decor', 'decoration', 'decorations', 'dekor', 'dekoracija', 'dekoracije'],
    },
    classic: {
        label: 'klasicne',
        aliases: ['classic', 'classic buildings', 'klasicno', 'klasicne', 'klasicne stavbe', 'hise'],
    },
};

function normalizeChoice(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\.(json|schem)$/i, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function categoryForChoice(choice) {
    const normalized = normalizeChoice(choice);
    return Object.entries(CATEGORY_DEFINITIONS)
        .find(([, definition]) => definition.aliases.some(alias => normalizeChoice(alias) === normalized))?.[0] ?? null;
}

export function resolveSchematicCategory(choice) {
    const normalized = normalizeChoice(choice);
    if (!normalized) return null;
    if (['mixed', 'mix', 'mesano', 'mesane', 'any', 'karkol', 'karkoli', 'vse'].includes(normalized))
        return 'mixed';
    if (CATEGORY_DEFINITIONS[normalized]) return normalized;
    return categoryForChoice(normalized);
}

export function schematicCategoryLabel(category) {
    if (category === 'mixed') return 'mesane';
    return CATEGORY_DEFINITIONS[category]?.label ?? 'klasicne';
}

export function knownSchematicCategories() {
    return ['mixed', ...Object.keys(CATEGORY_DEFINITIONS)];
}

function editDistance(a, b) {
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = previous[0];
        previous[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const above = previous[j];
            previous[j] = Math.min(
                previous[j] + 1,
                previous[j - 1] + 1,
                diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
            diagonal = above;
        }
    }
    return previous[b.length];
}

function fuzzySchematic(catalog, normalized) {
    if (normalized.length < 5) return null;
    const ranked = catalog
        .flatMap(entry => [entry.name, ...entry.aliases].map(name => ({
            entry,
            distance: editDistance(normalized, normalizeChoice(name)),
        })))
        .sort((a, b) => a.distance - b.distance);
    const best = ranked[0];
    const runnerUp = ranked.find(candidate => candidate.entry.name !== best?.entry.name);
    const limit = normalized.length >= 12 ? 3 : 2;
    if (!best || best.distance > limit || runnerUp?.distance === best.distance) return null;
    return best.entry;
}

function readCatalogEntry(fileName) {
    const extension = fileName.endsWith('.schem') ? 'schem' : 'json';
    const name = fileName.replace(/\.(json|schem)$/i, '');
    let metadata = {};
    if (extension === 'json') {
        try {
            metadata = JSON.parse(readFileSync(`${SCHEM_DIR}/${fileName}`, 'utf8'));
        } catch {
            metadata = {};
        }
    }
    const category = CATEGORY_DEFINITIONS[metadata._category] ? metadata._category : 'classic';
    return {
        name,
        description: metadata._opis ?? metadata._description ?? '',
        category,
        categoryLabel: CATEGORY_DEFINITIONS[category].label,
        aliases: Array.isArray(metadata._aliases) ? metadata._aliases.filter(alias => typeof alias === 'string') : [],
        kind: metadata._kind === 'decor' ? 'decor' : 'building',
        extension,
    };
}

export function getSchematicCatalog() {
    let files;
    try {
        files = readdirSync(SCHEM_DIR)
            .filter(file => file.endsWith('.json') || file.endsWith('.schem'))
            .sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }

    const signature = files.map(fileName => {
        const stat = statSync(`${SCHEM_DIR}/${fileName}`);
        return `${fileName}:${stat.size}:${stat.mtimeMs}`;
    }).join('|');
    if (signature === catalogSnapshot.signature) return catalogSnapshot.entries;

    catalogSnapshot = {
        signature,
        entries: files.map(readCatalogEntry),
    };
    return catalogSnapshot.entries;
}

export function listSchematics() {
    return getSchematicCatalog().map(entry => entry.name);
}

export function formatSchematicCatalog() {
    const catalog = getSchematicCatalog();
    if (catalog.length === 0) return 'Ni nacrtov v mapi schematics.';
    const categories = new Map();
    for (const entry of catalog) {
        if (!categories.has(entry.categoryLabel)) categories.set(entry.categoryLabel, []);
        categories.get(entry.categoryLabel).push(entry.name);
    }
    return [...categories.entries()]
        .map(([label, names]) => `${label}: ${names.join(', ')}`)
        .join(' | ');
}

export function resolveSchematic(choice, random = Math.random, preferredCategory = null) {
    const catalog = getSchematicCatalog();
    if (catalog.length === 0)
        return { entry: null, error: 'Ni nacrtov v mapi schematics.' };

    const normalized = normalizeChoice(choice);
    const preferred = resolveSchematicCategory(preferredCategory);
    const randomAliases = new Set(['random', 'nakljucno', 'nakljucna', 'nakljucna stavba']);
    const allAliases = new Set(['random vse', 'nakljucno vse', 'all']);
    let candidates = [];
    let selection = 'exact';

    if (randomAliases.has(normalized)) {
        candidates = catalog.filter(entry => entry.kind !== 'decor'
            && (!preferred || preferred === 'mixed' || entry.category === preferred));
        if (candidates.length === 0)
            candidates = catalog.filter(entry => entry.kind !== 'decor');
        selection = 'random';
    } else if (allAliases.has(normalized)) {
        candidates = catalog;
        selection = 'random';
    } else {
        const exact = catalog.find(entry =>
            normalizeChoice(entry.name) === normalized
            || entry.aliases.some(alias => normalizeChoice(alias) === normalized));
        if (exact) return { entry: exact, selection };

        const category = categoryForChoice(normalized);
        if (category) {
            candidates = catalog.filter(entry => entry.category === category);
            selection = 'category';
        } else {
            const partial = catalog.filter(entry =>
                normalizeChoice(entry.name).includes(normalized)
                || normalized.includes(normalizeChoice(entry.name)));
            if (partial.length === 1) return { entry: partial[0], selection: 'partial' };
            const fuzzy = fuzzySchematic(catalog, normalized);
            if (fuzzy) return { entry: fuzzy, selection: 'fuzzy' };
        }
    }

    if (candidates.length === 0)
        return { entry: null, error: `Ne najdem schematica ali kategorije "${choice}". Uporabi !schematics.` };
    const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
    return { entry: candidates[index], selection };
}

function schematicBounds(blocks) {
    const max = blocks.reduce((bounds, block) => ({
        x: Math.max(bounds.x, block.x),
        y: Math.max(bounds.y, block.y),
        z: Math.max(bounds.z, block.z),
    }), { x: 0, y: 0, z: 0 });
    return {
        width: max.x + 1,
        height: max.y + 1,
        depth: max.z + 1,
    };
}

function normalizeRotation(rotation = 0) {
    const value = Number(rotation);
    if (!Number.isFinite(value)) return 0;
    return ((Math.round(value) % 4) + 4) % 4;
}

function rotateBlock(block, bounds, rotation) {
    switch (normalizeRotation(rotation)) {
        case 1:
            return { ...block, x: bounds.depth - 1 - block.z, z: block.x };
        case 2:
            return { ...block, x: bounds.width - 1 - block.x, z: bounds.depth - 1 - block.z };
        case 3:
            return { ...block, x: block.z, z: bounds.width - 1 - block.x };
        default:
            return block;
    }
}

function rotateBlocks(blocks, rotation = 0) {
    const turns = normalizeRotation(rotation);
    if (turns === 0) return blocks;
    const bounds = schematicBounds(blocks);
    return blocks.map(block => rotateBlock(block, bounds, turns));
}

function isLeaf(name) {
    return name?.endsWith('_leaves') || name === 'leaves' || name === 'leaves2'
        || name === 'nether_wart_block' || name === 'warped_wart_block';
}

function isLog(name) {
    return name === 'log' || name === 'log2'
        || name?.endsWith('_log') || name?.endsWith('_wood')
        || name?.endsWith('_stem') || name?.endsWith('_hyphae');
}

function isNaturalPlant(name) {
    return NATURAL_PLANTS.has(name)
        || name?.endsWith('_sapling')
        || name?.endsWith('_flower')
        || name?.endsWith('_tulip')
        || isLeaf(name);
}

function isNaturalTerrain(name) {
    return NATURAL_TERRAIN.has(name)
        || name?.endsWith('_ore')
        || (name?.endsWith('_terracotta') && !name.includes('glazed'))
        || name === 'terracotta'
        || name === 'stained_hardened_clay';
}

function isProtectedBlock(name) {
    return PROTECTED_BLOCKS.has(name)
        || mc.isBedBlock(name)
        || name?.endsWith('_shulker_box')
        || name?.endsWith('_sign')
        || name?.endsWith('_hanging_sign');
}

function positionKey(x, y, z) {
    return `${x},${y},${z}`;
}

function hasNearbyLeaves(cells, x, y, z) {
    for (let dx = -3; dx <= 3; dx++)
        for (let dz = -3; dz <= 3; dz++)
            for (let dy = -2; dy <= 6; dy++)
                if (isLeaf(cells.get(positionKey(x + dx, y + dy, z + dz))))
                    return true;
    return false;
}

function classifySiteBlock(name, cells, x, y, z) {
    if (!name || AIR_LIKE.has(name)) return 'empty';
    if (FLUIDS.has(name)) return 'fluid';
    if (isProtectedBlock(name)) return 'protected';
    if (isNaturalTerrain(name)) return 'terrain';
    if (isNaturalPlant(name)) return 'natural';
    if (isLog(name)) return hasNearbyLeaves(cells, x, y, z) ? 'natural' : 'artificial';
    return 'artificial';
}

function candidateOffsets(step) {
    const offsets = [{ x: 0, z: 0 }];
    for (let ring = 1; ring <= SITE_SEARCH_RINGS; ring++) {
        for (let x = -ring; x <= ring; x++) {
            offsets.push({ x: x * step, z: -ring * step });
            offsets.push({ x: x * step, z: ring * step });
        }
        for (let z = -ring + 1; z <= ring - 1; z++) {
            offsets.push({ x: -ring * step, z: z * step });
            offsets.push({ x: ring * step, z: z * step });
        }
    }
    return offsets;
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function scanBuildCandidate(bot, center, anchorY, bounds) {
    const originX = Math.floor(center.x - (bounds.width - 1) / 2);
    const originZ = Math.floor(center.z - (bounds.depth - 1) / 2);
    if (protectedBuildConflicts(bot, new Vec3(originX, Math.floor(anchorY), originZ), bounds))
        return null;
    const scanMinX = originX - SITE_MARGIN - 3;
    const scanMaxX = originX + bounds.width - 1 + SITE_MARGIN + 3;
    const scanMinZ = originZ - SITE_MARGIN - 3;
    const scanMaxZ = originZ + bounds.depth - 1 + SITE_MARGIN + 3;
    const worldMinY = bot.game?.minY ?? -64;
    const worldMaxY = worldMinY + (bot.game?.height ?? 384) - 1;
    const scanMinY = Math.max(worldMinY, Math.floor(anchorY) - SITE_VERTICAL_BELOW);
    const scanMaxY = Math.min(worldMaxY, Math.floor(anchorY) + SITE_VERTICAL_ABOVE + bounds.height);
    const cells = new Map();
    let loadedColumns = 0;
    let totalColumns = 0;

    for (let x = scanMinX; x <= scanMaxX; x++)
        for (let z = scanMinZ; z <= scanMaxZ; z++) {
            totalColumns++;
            let loaded = false;
            for (let y = scanMinY; y <= scanMaxY; y++) {
                const block = bot.blockAt(new Vec3(x, y, z));
                if (!block) continue;
                loaded = true;
                if (!AIR_LIKE.has(block.name))
                    cells.set(positionKey(x, y, z), block.name);
            }
            if (loaded) loadedColumns++;
        }

    if (loadedColumns / totalColumns < 0.95) return null;

    const surfaceHeights = [];
    for (let x = originX - SITE_MARGIN; x < originX + bounds.width + SITE_MARGIN; x++)
        for (let z = originZ - SITE_MARGIN; z < originZ + bounds.depth + SITE_MARGIN; z++) {
            let surface = null;
            for (let y = scanMaxY; y >= scanMinY; y--) {
                const name = cells.get(positionKey(x, y, z));
                if (isNaturalTerrain(name)) {
                    surface = y;
                    break;
                }
            }
            if (surface !== null) surfaceHeights.push(surface);
        }

    const expectedColumns = (bounds.width + SITE_MARGIN * 2) * (bounds.depth + SITE_MARGIN * 2);
    if (surfaceHeights.length / expectedColumns < 0.85) return null;

    const baseY = median(surfaceHeights) + 1;
    const minSurface = Math.min(...surfaceHeights);
    const maxSurface = Math.max(...surfaceHeights);
    const roughness = maxSurface - minSurface;
    let artificial = 0;
    let protectedCount = 0;
    let naturalObstacles = 0;
    let fluids = 0;
    const artificialColumns = new Set();
    let tallestArtificial = 0;

    const inspectedTop = baseY + Math.max(bounds.height + 5, 16);
    const inspectedBottom = Math.max(scanMinY, minSurface);
    for (let x = originX - SITE_MARGIN; x < originX + bounds.width + SITE_MARGIN; x++)
        for (let z = originZ - SITE_MARGIN; z < originZ + bounds.depth + SITE_MARGIN; z++)
            for (let y = inspectedBottom; y <= inspectedTop; y++) {
                const name = cells.get(positionKey(x, y, z));
                const type = classifySiteBlock(name, cells, x, y, z);
                if (type === 'protected') {
                    protectedCount++;
                    artificialColumns.add(`${x},${z}`);
                } else if (type === 'artificial') {
                    artificial++;
                    artificialColumns.add(`${x},${z}`);
                    tallestArtificial = Math.max(tallestArtificial, y - baseY + 1);
                } else if (type === 'fluid') {
                    fluids++;
                } else if ((type === 'natural' || type === 'terrain') && y >= baseY) {
                    naturalObstacles++;
                }
            }

    const safe = protectedCount === 0
        && artificial <= MAX_SAFE_ARTIFICIAL_BLOCKS
        && artificialColumns.size <= 2
        && tallestArtificial <= 1
        && roughness <= 6;
    const score = protectedCount * 100000
        + artificial * 5000
        + artificialColumns.size * 1000
        + roughness * 80
        + fluids * 25
        + naturalObstacles;

    return {
        safe,
        score,
        origin: new Vec3(originX, baseY, originZ),
        bounds,
        minSurface,
        maxSurface,
        roughness,
        artificial,
        protected: protectedCount,
        naturalObstacles,
        fluids,
    };
}

function protectedBuildConflicts(bot, origin, bounds, allowedName = null) {
    const min = {
        x: origin.x - SITE_MARGIN,
        y: origin.y - 4,
        z: origin.z - SITE_MARGIN,
    };
    const max = {
        x: origin.x + bounds.width - 1 + SITE_MARGIN,
        y: origin.y + bounds.height + 5,
        z: origin.z + bounds.depth - 1 + SITE_MARGIN,
    };
    return getProtectedBuilds(bot).some(build => {
        const sameRetry = allowedName === build.name
            && build.min.x === Math.floor(origin.x)
            && build.min.y === Math.floor(origin.y)
            && build.min.z === Math.floor(origin.z);
        if (sameRetry) return false;
        return min.x <= build.max.x && max.x >= build.min.x
            && min.y <= build.max.y && max.y >= build.min.y
            && min.z <= build.max.z && max.z >= build.min.z;
    });
}

export function findBuildSite(bot, blocks, anchor) {
    const bounds = schematicBounds(blocks);
    const step = Math.max(9, Math.ceil(Math.max(bounds.width, bounds.depth) / 2) + 4);
    const candidates = [];
    for (const offset of candidateOffsets(step)) {
        const center = {
            x: Math.floor(anchor.x) + offset.x,
            z: Math.floor(anchor.z) + offset.z,
        };
        const candidate = scanBuildCandidate(bot, center, anchor.y, bounds);
        if (candidate) {
            candidate.distanceFromAnchor = Math.hypot(offset.x, offset.z);
            candidate.score += candidate.distanceFromAnchor * 0.25;
            candidates.push(candidate);
        }
    }
    return candidates
        .filter(candidate => candidate.safe)
        .sort((a, b) => a.score - b.score || a.distanceFromAnchor - b.distanceFromAnchor)[0] ?? null;
}

// Returns array of {x,y,z,name} relative blocks (air removed), or null if not found.
async function loadSchematic(bot, name) {
    const cacheKey = `${bot.version ?? 'json'}:${name}`;
    if (schematicCache.has(cacheKey)) return schematicCache.get(cacheKey);
    const jsonPath = `${SCHEM_DIR}/${name}.json`;
    if (existsSync(jsonPath)) {
        const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
        const blocks = (data.blocks ?? []).filter(b => b?.name && !SKIP.has(b.name));
        schematicCache.set(cacheKey, blocks);
        return blocks;
    }
    const schemPath = `${SCHEM_DIR}/${name}.schem`;
    if (existsSync(schemPath)) {
        const { Schematic } = await import('prismarine-schematic');
        const schem = await Schematic.read(readFileSync(schemPath), bot.version);
        const start = schem.start();
        const end = schem.end();
        const blocks = [];
        for (let y = start.y; y <= end.y; y++)
            for (let z = start.z; z <= end.z; z++)
                for (let x = start.x; x <= end.x; x++) {
                    const b = await schem.getBlock(new Vec3(x, y, z));
                    if (b && b.name && !SKIP.has(b.name))
                        blocks.push({ x: x - start.x, y: y - start.y, z: z - start.z, name: b.name });
                }
        schematicCache.set(cacheKey, blocks);
        return blocks;
    }
    return null;
}

// most blocks place from the same-named item; a few differ
function itemFor(blockName, bot) {
    if (blockName === 'redstone_wire') return 'redstone';
    if (blockName.endsWith(PLANK_SUFFIX) && bot.game.gameMode !== 'creative') {
        const exact = world.getInventoryCounts(bot)[blockName] ?? 0;
        if (exact > 0) return blockName;
        const substitute = bot.inventory.items()
            .flatMap(item => mc.aliasesForLegacyStack(item.name, item.metadata, bot))
            .find(name => name.endsWith(PLANK_SUFFIX));
        if (substitute) return substitute;
    }
    const spec = mc.getItemSpec(blockName, bot);
    if (spec.name === 'grass') return 'dirt';
    return spec.name;
}

function equivalentBlock(actual, expected, bot = null) {
    const actualName = typeof actual === 'string' ? actual : actual?.name;
    if (!actualName || !expected) return false;
    if (actualName === expected) return true;
    if (actualName?.endsWith(PLANK_SUFFIX) && expected?.endsWith(PLANK_SUFFIX)) return true;
    return mc.blockMatchesName(actual, expected, bot);
}

export async function inspectSchematic(bot, name, origin, rotation = 0) {
    const rawBlocks = await loadSchematic(bot, name);
    if (!rawBlocks?.length) return { total: 0, correct: 0, ratio: 0 };
    const blocks = rotateBlocks(rawBlocks, rotation);
    let correct = 0;
    for (const blk of blocks) {
        const existing = bot.blockAt(new Vec3(origin.x + blk.x, origin.y + blk.y, origin.z + blk.z));
        if (existing && equivalentBlock(existing, blk.name, bot)) correct++;
    }
    return { total: blocks.length, correct, ratio: correct / blocks.length };
}

export async function getSchematicBounds(bot, name, rotation = 0) {
    const blocks = await loadSchematic(bot, name);
    return blocks?.length ? schematicBounds(rotateBlocks(blocks, rotation)) : null;
}

export async function buildSchematicCommandStep(bot, name, origin, maxPlacements = settings.build_step_blocks ?? 24, rotation = 0) {
    const rawBlocks = await loadSchematic(bot, name);
    if (!rawBlocks?.length) {
        log(bot, `Schematic "${name}" ne obstaja ali je prazen.`);
        return { placed: 0, correct: 0, total: 0, complete: false };
    }
    const blocks = rotateBlocks(rawBlocks, rotation);
    if (blocks.length > MAX_BLOCKS) {
        log(bot, `Schematic prevelik (${blocks.length} > ${MAX_BLOCKS} blokov).`);
        return { placed: 0, correct: 0, total: blocks.length, complete: false };
    }
    if (!await registerProtectedBuild(bot, name, origin, schematicBounds(blocks))) {
        const conflict = bot._lastBuildRegistrationConflict;
        log(bot, conflict
            ? `Gradnje ne bom nadaljeval, ker bi se prekrivala z "${conflict.name}".`
            : 'Gradnje ne bom nadaljeval, ker zascitnega registra ni bilo mogoce zakleniti.');
        return { placed: 0, correct: 0, total: blocks.length, complete: false };
    }

    const ordered = [...blocks].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
    let placed = 0;
    let correctSeen = 0;
    const limit = Math.max(1, Math.floor(maxPlacements));

    for (const blk of ordered) {
        if (bot.interrupt_code || placed >= limit) break;
        const x = Math.floor(origin.x + blk.x);
        const y = Math.floor(origin.y + blk.y);
        const z = Math.floor(origin.z + blk.z);
        const existing = bot.blockAt(new Vec3(x, y, z), false);
        if (existing && equivalentBlock(existing, blk.name, bot)) {
            correctSeen++;
            continue;
        }
        bot.chat(mc.setBlockCommand(x, y, z, blk.name, bot));
        placed++;
        await new Promise(resolve => setTimeout(resolve, CREATIVE_COMMAND_DELAY_MS));
    }

    await new Promise(resolve => setTimeout(resolve, 250));
    const inspection = await inspectSchematic(bot, name, origin, rotation);
    const complete = inspection.ratio >= 0.99;
    log(bot, complete
        ? `Gradnja "${name}" je koncana (${inspection.correct}/${inspection.total}).`
        : `Gradnja "${name}" napreduje: +${placed} blokov, skupaj ${inspection.correct}/${inspection.total}.`);
    return {
        placed,
        correct: inspection.correct || correctSeen,
        total: inspection.total || blocks.length,
        complete,
    };
}

export async function getMissingMaterials(bot, name, origin) {
    const blocks = await loadSchematic(bot, name);
    if (!blocks) return null;
    const required = {};
    for (const blk of blocks) {
        const existing = bot.blockAt(new Vec3(origin.x + blk.x, origin.y + blk.y, origin.z + blk.z));
        if (existing && equivalentBlock(existing, blk.name, bot)) continue;
        const item = itemFor(blk.name, bot);
        required[item] = (required[item] ?? 0) + 1;
    }
    const inventory = world.getInventoryCounts(bot);
    const plankRequired = Object.entries(required)
        .filter(([name]) => name.endsWith(PLANK_SUFFIX))
        .reduce((sum, [, amount]) => sum + amount, 0);
    const plankInventory = PLANKS.reduce((sum, name) => sum + (inventory[name] ?? 0), 0);
    const missing = {};
    if (plankRequired > plankInventory) missing.planks = plankRequired - plankInventory;
    for (const [name, amount] of Object.entries(required)) {
        if (name.endsWith(PLANK_SUFFIX)) continue;
        const deficit = amount - (inventory[name] ?? 0);
        if (deficit > 0) missing[name] = deficit;
    }
    return missing;
}

export async function prepareSchematic(bot, name, origin) {
    const missing = await getMissingMaterials(bot, name, origin);
    if (!missing) return false;

    if ((missing.planks ?? 0) > 0) {
        const currentPlanks = PLANKS.reduce((sum, plank) => sum + (world.getInventoryCounts(bot)[plank] ?? 0), 0);
        const targetPlanks = currentPlanks + missing.planks;
        await base.takeAny(bot, PLANKS, targetPlanks);
        const afterStorage = PLANKS.reduce((sum, plank) => sum + (world.getInventoryCounts(bot)[plank] ?? 0), 0);
        const logTarget = Math.ceil(Math.max(0, targetPlanks - afterStorage) / 4);
        if (logTarget > 0) {
            await base.takeAny(bot, LOGS, logTarget);
            if (LOGS.reduce((sum, logName) => sum + (world.getInventoryCounts(bot)[logName] ?? 0), 0) < logTarget)
                await ensureLogs(bot, logTarget);
            await ensurePlanks(bot, targetPlanks);
        }
    }

    if ((missing.cobblestone ?? 0) > 0) {
        const target = (world.getInventoryCounts(bot).cobblestone ?? 0) + missing.cobblestone;
        await base.takeNeeded(bot, { cobblestone: target });
        if ((world.getInventoryCounts(bot).cobblestone ?? 0) < target)
            await ensureCobblestone(bot, target);
    }

    const exactNeeds = {};
    const current = world.getInventoryCounts(bot);
    for (const [item, amount] of Object.entries(missing)) {
        if (item === 'planks' || item === 'cobblestone' || amount <= 0) continue;
        exactNeeds[item] = (current[item] ?? 0) + amount;
    }
    if (Object.keys(exactNeeds).length > 0)
        await base.takeNeeded(bot, exactNeeds);

    const remaining = await getMissingMaterials(bot, name, origin);
    return remaining && Object.keys(remaining).length === 0;
}

function stopTransientBuildMotion(bot) {
    try { bot.pathfinder?.stop(); } catch { /* pathfinder may not be active */ }
    try { bot.pathfinder?.setGoal(null); } catch { /* plugin version compatibility */ }
    try { bot.clearControlStates(); } catch { /* disconnected */ }
    try {
        const stoppingDig = bot.stopDigging?.();
        if (stoppingDig?.catch) void stoppingDig.catch(() => {});
    } catch { /* not digging */ }
    try { bot.deactivateItem(); } catch { /* not using an item */ }
    try { bot.pvp?.stop(); } catch { /* not fighting */ }
    if (bot._creativeBuildFlying === true) {
        try { bot.creative?.stopFlying(); } catch { /* not flying */ }
    }
    bot._creativeBuildFlying = false;
    repairBotPhysics(bot);
    if (bot.currentWindow && bot.currentWindow !== bot.inventory) {
        try { bot.closeWindow(bot.currentWindow); } catch { /* window already closed */ }
    }
    try { bot.entity?.velocity?.set(0, 0, 0); } catch { /* entity not ready */ }
}

export function repairBotPhysics(bot) {
    if (!bot?.physics || bot._creativeBuildFlying === true) return false;
    const gravity = Number(bot.physics.gravity);
    if (Number.isFinite(gravity) && gravity > 0) return false;
    bot.physics.gravity = DEFAULT_PHYSICS_GRAVITY;
    return true;
}

async function teleportBuildBot(bot, position, timeoutMs = 5000) {
    if (!bot.entity) return false;
    stopTransientBuildMotion(bot);
    const target = new Vec3(
        Math.floor(position.x) + 0.5,
        Math.floor(position.y),
        Math.floor(position.z) + 0.5,
    );
    // The build target is usually well above the ground (clearing/overview
    // height). In creative without flight the bot falls the instant it arrives,
    // so the distance check can miss the brief moment it is actually at the
    // target — especially for a far site where the teleport-confirm packet lags
    // a poll behind and the bot is already plummeting once its position updates.
    // Hold it in place: hover (creative flight), pin velocity each poll, and
    // re-issue the teleport until it settles at the target.
    const creative = bot.game?.gameMode === 'creative';
    const sendTp = () => bot.chat(`/tp @s ${target.x} ${target.y} ${target.z}`);
    sendTp();
    if (creative) {
        try { bot.creative.startFlying(); bot._creativeBuildFlying = true; } catch { /* flight unavailable */ }
    }
    const deadline = Date.now() + timeoutMs;
    let lastResend = Date.now();
    while (Date.now() < deadline && bot.entity) {
        if (bot.entity.position.distanceTo(target) <= 2) return true;
        try { bot.entity.velocity.set(0, 0, 0); } catch { /* entity not ready */ }
        if (Date.now() - lastResend >= 600) { sendTp(); lastResend = Date.now(); }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
}

async function placeCreativeRun(bot, run) {
    if (bot.game.gameMode !== 'creative') return false;
    const command = run.minX === run.maxX
        ? mc.setBlockCommand(run.minX, run.y, run.z, run.name, bot)
        : mc.fillCommand(
            new Vec3(run.minX, run.y, run.z),
            new Vec3(run.maxX, run.y, run.z),
            run.name,
            bot,
        );
    bot.chat(command);
    await new Promise(resolve => setTimeout(resolve, CREATIVE_COMMAND_DELAY_MS));
    return true;
}

function creativeRuns(bot, blocks, origin) {
    const pending = blocks
        .map(block => ({
            name: block.name,
            x: origin.x + block.x,
            y: origin.y + block.y,
            z: origin.z + block.z,
        }))
        .filter(block => {
            const existing = bot.blockAt(new Vec3(block.x, block.y, block.z));
            return !existing || !equivalentBlock(existing, block.name, bot);
        })
        .sort((a, b) => a.y - b.y || a.z - b.z || a.name.localeCompare(b.name) || a.x - b.x);

    const runs = [];
    for (const block of pending) {
        const previous = runs.at(-1);
        if (previous && previous.name === block.name && previous.y === block.y
            && previous.z === block.z && previous.maxX + 1 === block.x) {
            previous.maxX = block.x;
            continue;
        }
        runs.push({
            name: block.name,
            minX: block.x,
            maxX: block.x,
            y: block.y,
            z: block.z,
        });
    }
    return runs;
}

async function buildCreativeSchematic(bot, name, blocks, origin, maxPlacements) {
    let placed = 0;
    let failures = 0;
    for (const run of creativeRuns(bot, blocks, origin)) {
        if (bot.interrupt_code || bot.game.gameMode !== 'creative' || placed >= maxPlacements)
            break;
        const remaining = maxPlacements - placed;
        const cappedRun = {
            ...run,
            maxX: Math.min(run.maxX, run.minX + remaining - 1),
        };
        if (await placeCreativeRun(bot, cappedRun))
            placed += cappedRun.maxX - cappedRun.minX + 1;
        else
            failures++;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    const inspection = await inspectSchematic(bot, name, origin);
    log(bot, `Creative ukazi: ${placed} blokov, dokoncanih ${inspection.correct}/${inspection.total}, napake ${failures}.`);
    return {
        placed,
        skipped: Math.max(0, inspection.total - inspection.correct),
        correct: inspection.correct,
        complete: inspection.ratio >= 0.99,
        missing: {},
    };
}

async function buildSchematicInternal(bot, name, origin, maxPlacements, maxFailures) {
    const blocks = await loadSchematic(bot, name);
    if (!blocks) { log(bot, `Schematic "${name}" ne obstaja v ${SCHEM_DIR}/ (.json ali .schem).`); return { placed: 0, complete: false }; }
    if (blocks.length === 0) { log(bot, `Schematic "${name}" je prazen.`); return { placed: 0, complete: false }; }
    if (blocks.length > MAX_BLOCKS) { log(bot, `Schematic prevelik (${blocks.length} > ${MAX_BLOCKS} blokov).`); return { placed: 0, complete: false }; }
    if (!await registerProtectedBuild(bot, name, origin, schematicBounds(blocks))) {
        const conflict = bot._lastBuildRegistrationConflict;
        log(bot, conflict
            ? `Gradnje ne bom zacel, ker bi se prekrivala z "${conflict.name}".`
            : 'Gradnje ne bom zacel, ker zascitnega registra ni bilo mogoce zakleniti.');
        return { placed: 0, complete: false };
    }

    // build bottom layer first; within a layer place far-from-center blocks first so the bot doesn't wall itself in
    const ordered = [...blocks].sort((a, b) => a.y - b.y || (Math.abs(b.x) + Math.abs(b.z)) - (Math.abs(a.x) + Math.abs(a.z)));
    log(bot, `Gradim "${name}" (${blocks.length} blokov)...`);
    if (bot.game.gameMode === 'creative')
        return await buildCreativeSchematic(bot, name, blocks, origin, maxPlacements);

    let placed = 0, skipped = 0, failures = 0, correct = 0;
    const missing = {};
    for (const blk of ordered) {
        if (bot.interrupt_code) { log(bot, 'Gradnja prekinjena.'); break; }
        if (bot._creativeBuildActive && bot.game.gameMode !== 'creative') {
            log(bot, 'Creative build mode je bil izgubljen; gradnjo varno ponastavljam.');
            break;
        }
        if (placed >= maxPlacements || failures >= maxFailures) break;
        const wx = origin.x + blk.x, wy = origin.y + blk.y, wz = origin.z + blk.z;
        const existing = bot.blockAt(new Vec3(wx, wy, wz));
        if (existing && equivalentBlock(existing, blk.name, bot)) { correct++; continue; }
        const item = itemFor(blk.name, bot);
        if (bot.game.gameMode !== 'creative' && (world.getInventoryCounts(bot)[item] ?? 0) < 1) {
            skipped++;
            missing[item] = (missing[item] ?? 0) + 1;
            continue;
        }
        try {
            if (await placeBlock(bot, item, wx, wy, wz)) placed++;
            else { skipped++; failures++; }
        } catch {
            skipped++;
            failures++;
        }
    }
    const inspection = await inspectSchematic(bot, name, origin);
    const missStr = Object.entries(missing).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${v}x ${k}`).join(', ');
    log(bot, `Postavil ${placed}, dokončanih ${inspection.correct}/${inspection.total}, preskočil ${skipped}.${missStr ? ` Manjka material: ${missStr}.` : ''}`);
    return { placed, skipped, correct: inspection.correct, complete: inspection.ratio >= 0.99, missing };
}

export function buildSchematicStep(bot, name, origin, maxPlacements = 24) {
    return buildSchematicInternal(bot, name, origin, maxPlacements, 10);
}

export async function buildSchematic(bot, name, origin) {
    const result = await buildSchematicInternal(bot, name, origin, Number.POSITIVE_INFINITY, 30);
    return result.complete || result.placed > 0;
}

const INVENTORY_SLOTS = 45;

async function changeGameMode(bot, mode, timeoutMs = 4500) {
    if (bot.game.gameMode === mode) return true;
    const commands = [`/gamemode ${mode} @s`, `/gamemode ${mode} ${bot.username}`];
    for (const command of commands) {
        bot.chat(command);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (bot.game.gameMode === mode) return true;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    return false;
}

export async function ensureSurvivalMode(bot) {
    stopTransientBuildMotion(bot);
    if (bot.game.gameMode === 'survival') {
        bot._mustReturnToSurvival = false;
        bot._creativeBuildActive = false;
        return true;
    }
    bot._mustReturnToSurvival = true;
    const survived = await changeGameMode(bot, 'survival');
    bot._mustReturnToSurvival = !survived;
    bot._creativeBuildActive = !survived;
    stopTransientBuildMotion(bot);
    if (!survived)
        log(bot, 'NAPAKA: bot se ni mogel vrniti v survival; brain bo poskusil znova.');
    return survived;
}

export async function recoverBuilderState(bot, landing = null) {
    stopTransientBuildMotion(bot);
    if (landing)
        await teleportBuildBot(bot, landing);
    const survived = await ensureSurvivalMode(bot);
    stopTransientBuildMotion(bot);
    if (survived) {
        bot._creativeBuildActive = false;
        bot._mustReturnToSurvival = false;
    }
    return survived;
}

async function restoreInventory(bot, snapshot) {
    let restored = true;
    for (let slot = 0; slot < INVENTORY_SLOTS; slot++) {
        const before = snapshot[slot] ?? null;
        const current = bot.inventory.slots[slot] ?? null;
        const same = before === current
            || (before && current
                && before.type === current.type
                && before.count === current.count
                && before.metadata === current.metadata
                && before.durabilityUsed === current.durabilityUsed
                && isDeepStrictEqual(before.nbt ?? null, current.nbt ?? null)
                && isDeepStrictEqual(before.components ?? null, current.components ?? null));
        if (same) continue;
        try {
            await bot.creative.setInventorySlot(slot, before);
        } catch (error) {
            restored = false;
            console.warn(`[build ${bot.username}] could not restore inventory slot ${slot}: ${error.message}`);
        }
    }
    return restored;
}

function splitFillArea(min, max) {
    const boxes = [{ min: min.clone(), max: max.clone() }];
    const ready = [];
    while (boxes.length > 0) {
        const box = boxes.pop();
        const lengths = {
            x: box.max.x - box.min.x + 1,
            y: box.max.y - box.min.y + 1,
            z: box.max.z - box.min.z + 1,
        };
        const volume = lengths.x * lengths.y * lengths.z;
        if (volume <= MAX_FILL_VOLUME) {
            ready.push(box);
            continue;
        }
        const axis = Object.entries(lengths).sort((a, b) => b[1] - a[1])[0][0];
        const midpoint = Math.floor((box.min[axis] + box.max[axis]) / 2);
        const firstMax = box.max.clone();
        firstMax[axis] = midpoint;
        const secondMin = box.min.clone();
        secondMin[axis] = midpoint + 1;
        boxes.push(
            { min: box.min.clone(), max: firstMax },
            { min: secondMin, max: box.max.clone() },
        );
    }
    return ready;
}

async function fillArea(bot, min, max, blockName) {
    const normalizedMin = new Vec3(
        Math.min(min.x, max.x),
        Math.min(min.y, max.y),
        Math.min(min.z, max.z),
    ).floored();
    const normalizedMax = new Vec3(
        Math.max(min.x, max.x),
        Math.max(min.y, max.y),
        Math.max(min.z, max.z),
    ).floored();
    for (const box of splitFillArea(normalizedMin, normalizedMax)) {
        if (bot.interrupt_code) return false;
        bot.chat(mc.fillCommand(box.min, box.max, blockName, bot));
        await new Promise(resolve => setTimeout(resolve, 180));
    }
    return true;
}

function firstSolidPosition(bot, build) {
    for (let y = build.min.y; y <= build.max.y; y++)
        for (let x = build.min.x; x <= build.max.x; x++)
            for (let z = build.min.z; z <= build.max.z; z++) {
                const position = new Vec3(x, y, z);
                const block = bot.blockAt(position);
                if (block && !AIR_LIKE.has(block.name) && !FLUIDS.has(block.name))
                    return position;
            }
    return null;
}

export async function demolishNearestBuild(bot, position, maxDistance = 48) {
    const target = findNearestProtectedBuild(bot, position, maxDistance);
    if (!target) {
        log(bot, `V radiju ${maxDistance} blokov ni registrirane NPC-gradnje za rusenje.`);
        return false;
    }

    const center = new Vec3(
        Math.floor((target.min.x + target.max.x) / 2),
        target.min.y + 1,
        Math.floor((target.min.z + target.max.z) / 2),
    );
    try {
        if (!await goToPosition(bot, center.x, center.y, center.z, 8)) {
            log(bot, `Ne morem priti do gradnje "${target.name}".`);
            return false;
        }
    } catch {
        log(bot, `Ne morem priti do gradnje "${target.name}".`);
        return false;
    }

    const sample = firstSolidPosition(bot, target);
    log(bot, `Rusim registrirano gradnjo "${target.name}" (${target.owner}).`);
    if (!await fillArea(
        bot,
        new Vec3(target.min.x, target.min.y, target.min.z),
        new Vec3(target.max.x, target.max.y, target.max.z),
        'air',
    )) return false;
    await new Promise(resolve => setTimeout(resolve, 600));

    if (sample) {
        const remaining = bot.blockAt(sample);
        if (remaining && !AIR_LIKE.has(remaining.name) && !FLUIDS.has(remaining.name)) {
            log(bot, 'Rusenje ni uspelo; preveri dovoljenje za /fill.');
            return false;
        }
    }
    if (!await removeProtectedBuild(bot, target.id)) {
        log(bot, 'Gradnja je podrta, vendar registra ni bilo mogoce takoj posodobiti.');
        return false;
    }
    log(bot, `Gradnja "${target.name}" je odstranjena.`);
    return true;
}

async function waitForPreparedSite(bot, site, timeoutMs = 5000) {
    const checkX = site.origin.x - 1;
    const checkZ = site.origin.z - 1;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ground = bot.blockAt(new Vec3(checkX, site.origin.y - 1, checkZ));
        const space = bot.blockAt(new Vec3(checkX, site.origin.y, checkZ));
        if (mc.blockMatchesName(ground, 'grass_block', bot) && (!space || AIR_LIKE.has(space.name)))
            return true;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
}

export async function prepareBuildSite(bot, site) {
    const { origin, bounds } = site;
    const clearMin = new Vec3(
        origin.x - SITE_MARGIN,
        origin.y,
        origin.z - SITE_MARGIN,
    );
    const clearHeight = Math.max(bounds.height + 5, 16);
    const clearMax = new Vec3(
        origin.x + bounds.width - 1 + SITE_MARGIN,
        origin.y + clearHeight,
        origin.z + bounds.depth - 1 + SITE_MARGIN,
    );
    const foundationMin = new Vec3(
        origin.x - SITE_MARGIN,
        Math.min(site.minSurface, origin.y - 2),
        origin.z - SITE_MARGIN,
    );
    const foundationMax = new Vec3(
        origin.x + bounds.width - 1 + SITE_MARGIN,
        origin.y - 1,
        origin.z + bounds.depth - 1 + SITE_MARGIN,
    );
    const topMin = new Vec3(foundationMin.x, origin.y - 1, foundationMin.z);
    const topMax = new Vec3(foundationMax.x, origin.y - 1, foundationMax.z);

    if (!await teleportBuildBot(
        bot,
        new Vec3(clearMin.x - 2, clearMax.y + 2, clearMin.z - 2),
    )) {
        log(bot, 'Ne morem se premakniti nad izbrano gradbisce.');
        return false;
    }

    log(bot, `Pripravljam teren pri ${origin.x},${origin.y},${origin.z}: `
        + `${site.naturalObstacles} naravnih ovir, naklon ${site.roughness}.`);
    if (!await fillArea(bot, clearMin, clearMax, 'air')) return false;
    if (!await fillArea(bot, foundationMin, foundationMax, 'dirt')) return false;
    if (!await fillArea(bot, topMin, topMax, 'grass_block')) return false;
    if (!await waitForPreparedSite(bot, site)) {
        log(bot, 'Priprava terena ni bila potrjena. Preveri dovoljenje za /fill.');
        return false;
    }
    return true;
}

export async function prepareBuildSiteWithCommands(bot, site) {
    const { origin, bounds } = site;
    const maxFoundationDepth = Math.max(1, settings.town_max_foundation_depth ?? 3);
    const clearMin = new Vec3(
        origin.x - SITE_MARGIN,
        origin.y,
        origin.z - SITE_MARGIN,
    );
    const clearHeight = Math.max(bounds.height + 5, 16);
    const clearMax = new Vec3(
        origin.x + bounds.width - 1 + SITE_MARGIN,
        origin.y + clearHeight,
        origin.z + bounds.depth - 1 + SITE_MARGIN,
    );
    const foundationMin = new Vec3(
        origin.x - SITE_MARGIN,
        Math.max(
            origin.y - maxFoundationDepth,
            Math.min(site.minSurface ?? origin.y - 2, origin.y - 2),
        ),
        origin.z - SITE_MARGIN,
    );
    const foundationMax = new Vec3(
        origin.x + bounds.width - 1 + SITE_MARGIN,
        origin.y - 1,
        origin.z + bounds.depth - 1 + SITE_MARGIN,
    );
    const topMin = new Vec3(foundationMin.x, origin.y - 1, foundationMin.z);
    const topMax = new Vec3(foundationMax.x, origin.y - 1, foundationMax.z);
    const stand = new Vec3(
        origin.x + Math.floor(bounds.width / 2),
        origin.y,
        origin.z - SITE_MARGIN - 2,
    );

    try {
        await goToPosition(bot, stand.x, stand.y, stand.z, 8);
    } catch {
        // Commands can still run; the walk mainly keeps chunks loaded when possible.
    }

    log(bot, `Pripravljam gradbisce pri ${origin.x},${origin.y},${origin.z} brez creative letenja.`);
    if (!await fillArea(bot, clearMin, clearMax, 'air')) return false;
    if (!await fillArea(bot, foundationMin, foundationMax, 'dirt')) return false;
    if (!await fillArea(bot, topMin, topMax, 'grass_block')) return false;
    if (bot.entity?.position?.distanceTo(origin) <= 96 && !await waitForPreparedSite(bot, site)) {
        log(bot, 'Priprava terena ni bila potrjena. Preveri dovoljenje za /fill ali loaded chunks.');
        return false;
    }
    return true;
}

// Used only by the manual !build command. Autonomous progression keeps using
// survival building, while an admin-requested schematic is completed reliably.
// presetSite (optional) builds at an EXACT prepared site (used by the town planner
// for aligned plots); when omitted, a safe site is searched around `anchor`.
async function buildSchematicCreativeUnlocked(bot, name, anchor, presetSite = null) {
    const blocks = await loadSchematic(bot, name);
    if (!blocks?.length) {
        log(bot, `Schematic "${name}" ne obstaja ali je prazen.`);
        return false;
    }
    if (blocks.length > MAX_BLOCKS) {
        log(bot, `Schematic prevelik (${blocks.length} > ${MAX_BLOCKS} blokov).`);
        return false;
    }

    // Keep exact Item objects, including durability, enchantments and components.
    // Creative placement may overwrite hotbar slot 36; restoring every slot also
    // removes any item obtained while creative.
    const inventorySnapshot = bot.inventory.slots.slice(0, INVENTORY_SLOTS);
    let enteredCreative = false;
    let buildOrigin = null;
    let sitePrepared = false;
    try {
        enteredCreative = await changeGameMode(bot, 'creative');
        if (!enteredCreative) {
            log(bot, 'Ne morem v creative. Bot potrebuje dovoljenje za /gamemode.');
            return false;
        }
        bot._mustReturnToSurvival = true;
        bot._creativeBuildActive = true;

        if (!await teleportBuildBot(bot, new Vec3(anchor.x, anchor.y + 12, anchor.z))) {
            log(bot, 'Ne morem priti do obmocja baze za pregled terena.');
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 400));

        const site = presetSite ?? findBuildSite(bot, blocks, anchor);
        if (!site) {
            log(bot, 'V blizini baze ne najdem varnega prostega gradbisca. Obstojecih stavb ne bom rusil.');
            return false;
        }
        if (presetSite
            && protectedBuildConflicts(bot, site.origin, site.bounds, name)) {
            log(bot, 'Nacrtovana parcela se prekriva z registrirano stavbo; gradnjo preklicujem.');
            return false;
        }
        buildOrigin = site.origin;
        log(bot, `Izbral sem prosto gradbisce ${(site.distanceFromAnchor ?? 0).toFixed(0)} blokov od baze.`);
        sitePrepared = await prepareBuildSite(bot, site);
        if (!sitePrepared) return false;

        log(bot, `Creative gradnja "${name}" se je zacela.`);
        let complete = false;
        for (let pass = 1; pass <= 3 && !bot.interrupt_code; pass++) {
            const result = await buildSchematicInternal(
                bot,
                name,
                buildOrigin,
                Number.POSITIVE_INFINITY,
                Number.POSITIVE_INFINITY,
            );
            complete = result.complete;
            if (complete) break;
            if (bot.game.gameMode !== 'creative') {
                log(bot, 'Creative mode je bil izgubljen; nadaljnje prehode preklicujem.');
                break;
            }
            if (pass < 3)
                log(bot, `Creative gradnja: ponovni prehod ${pass + 1}/3.`);
        }

        const inspection = await inspectSchematic(bot, name, buildOrigin);
        complete = inspection.ratio >= 0.99;
        log(bot, complete
            ? `Schematic "${name}" je v celoti zgrajen.`
            : `Schematic "${name}" ni povsem dokoncan (${inspection.correct}/${inspection.total}).`);
        return complete;
    } finally {
        const landing = sitePrepared && buildOrigin
            ? buildOrigin.offset(-1, 0, -1)
            : new Vec3(anchor.x, anchor.y, anchor.z);
        if (enteredCreative && bot.game.gameMode === 'creative') {
            const restored = await restoreInventory(bot, inventorySnapshot);
            if (!restored)
                log(bot, 'Opozorilo: vseh inventory slotov ni bilo mogoce obnoviti.');
        }
        if (enteredCreative || bot._mustReturnToSurvival)
            await recoverBuilderState(bot, landing);
        else {
            stopTransientBuildMotion(bot);
            bot._creativeBuildActive = false;
        }
    }
}

export async function buildSchematicCreative(bot, name, anchor, presetSite = null) {
    // Site selection must remain locked until the structure is complete. Without
    // this, several bots responding to one public !build scan the same empty site
    // and then construct overlapping schematics.
    const result = await withNamedLock(
        bot,
        'global-schematic-builder',
        async () => await buildSchematicCreativeUnlocked(bot, name, anchor, presetSite),
        300,
    );
    if (!result.locked) {
        log(bot, 'Drug NPC ze gradi; tega ukaza ne bom podvojil.');
        return false;
    }
    return result.value;
}
