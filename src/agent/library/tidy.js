// Conservative settlement cleanup for debris left by old pathfinder scaffolds.
// Only obvious floating blocks and thin vertical dirt/cobblestone towers are
// removed. Registered builds, farms, storage utilities and spawners are excluded.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { Vec3 } from 'vec3';
import * as base from './base.js';
import * as storage from './storage.js';
import { goToPosition, log } from './skills.js';
import { withNamedLock } from './container_lock.js';
import { getProtectedBuilds, isPositionProtected } from './resource_guard.js';
import * as mc from '../../utils/mcdata.js';

const SUSPECT_NAMES = ['dirt', 'cobblestone'];
const EMPTY = new Set([
    'air', 'cave_air', 'void_air', 'water', 'lava', 'bubble_column',
    'short_grass', 'tallgrass', 'tall_grass', 'fern', 'large_fern', 'snow',
    'dead_bush', 'vine', 'glow_lichen',
]);
const UTILITY_NAMES = [
    'chest', 'trapped_chest', 'barrel', 'crafting_table', 'furnace',
    'blast_furnace', 'smoker', 'hopper', 'enchanting_table', 'anvil',
    'chipped_anvil', 'damaged_anvil', 'torch', 'wall_torch', 'lantern',
    'soul_lantern', 'spawner',
];
const SCAN_RADIUS = 56;
const MAX_SCAN_BLOCKS = 768;
const AUTO_REMOVE_LIMIT = 24;
const MANUAL_REMOVE_LIMIT = 96;
const COMMAND_DELAY_MS = 65;
let farmCache = { checkedAt: 0, farms: [] };

function dimensionKey(bot) {
    return String(bot.game?.dimension ?? 'world');
}

function settlementCenter(bot) {
    return storage.getPublicStorage(bot) ?? base.getBase(bot) ?? (
        bot.entity
            ? {
                x: Math.floor(bot.entity.position.x),
                y: Math.floor(bot.entity.position.y),
                z: Math.floor(bot.entity.position.z),
                radius: 10,
                dimension: dimensionKey(bot),
            }
            : null
    );
}

function readFarms(bot) {
    if (Date.now() - farmCache.checkedAt < 5000) return farmCache.farms;
    const farms = [];
    try {
        for (const entry of readdirSync('./bots', { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const file = `./bots/${entry.name}/farm.json`;
            if (!existsSync(file)) continue;
            try {
                const farm = JSON.parse(readFileSync(file, 'utf8'));
                if (farm.dimension === dimensionKey(bot)
                    && Number.isFinite(farm.x)
                    && Number.isFinite(farm.y)
                    && Number.isFinite(farm.z)) {
                    farms.push({
                        x: farm.x,
                        y: farm.y,
                        z: farm.z,
                        radius: Math.max(2, Number(farm.radius) || 4),
                    });
                }
            } catch { /* malformed or partially-written farm state */ }
        }
    } catch { /* bots directory may not exist during tests */ }
    farmCache = { checkedAt: Date.now(), farms };
    return farms;
}

function insideFarm(bot, position) {
    return readFarms(bot).some(farm =>
        Math.abs(position.x - farm.x) <= farm.radius + 2
        && Math.abs(position.z - farm.z) <= farm.radius + 2
        && Math.abs(position.y - farm.y) <= 5);
}

function insideBuildFoundation(bot, position, padding = 2) {
    return getProtectedBuilds(bot).some(build =>
        position.x >= build.min.x - padding
        && position.x <= build.max.x + padding
        && position.z >= build.min.z - padding
        && position.z <= build.max.z + padding
        && position.y >= build.min.y - 12
        && position.y <= build.max.y + 4);
}

function blockKey(position) {
    return `${position.x},${position.y},${position.z}`;
}

function nearbyUtilities(bot, center) {
    const ids = UTILITY_NAMES
        .flatMap(name => mc.registryBlockIds(bot, name));
    if (ids.length === 0) return [];
    return bot.findBlocks({
        point: new Vec3(center.x, center.y, center.z),
        matching: ids,
        maxDistance: SCAN_RADIUS,
        count: 256,
    }).map(position => ({
        position,
        name: bot.blockAt(position)?.name,
    }));
}

function nearUtility(position, utilities) {
    return utilities.some(utility => {
        const maxDistance = utility.name === 'spawner' ? 5 : 2;
        return utility.position.distanceTo(position) <= maxDistance;
    });
}

function openHorizontalSides(bot, position) {
    return [
        position.offset(1, 0, 0),
        position.offset(-1, 0, 0),
        position.offset(0, 0, 1),
        position.offset(0, 0, -1),
    ].filter(check => EMPTY.has(bot.blockAt(check)?.name)).length;
}

function sameSuspect(bot, position, name) {
    return bot.blockAt(position)?.name === name;
}

function verticalColumn(bot, position, name) {
    let bottom = position.clone();
    let top = position.clone();
    for (let i = 0; i < 16 && sameSuspect(bot, bottom.offset(0, -1, 0), name); i++)
        bottom = bottom.offset(0, -1, 0);
    for (let i = 0; i < 16 && sameSuspect(bot, top.offset(0, 1, 0), name); i++)
        top = top.offset(0, 1, 0);
    return {
        bottom,
        top,
        height: top.y - bottom.y + 1,
    };
}

function obviousTemporaryBlock(bot, block, utilities) {
    const position = block.position;
    if (isPositionProtected(bot, position, 1)
        || insideBuildFoundation(bot, position)
        || insideFarm(bot, position)
        || nearUtility(position, utilities))
        return false;

    const below = bot.blockAt(position.offset(0, -1, 0));
    const above = bot.blockAt(position.offset(0, 1, 0));
    const openSides = openHorizontalSides(bot, position);

    // A pathfinder bridge or interrupted jump-place normally has no support.
    if (EMPTY.has(below?.name) && openSides >= 2) return true;

    // Remove narrow 1x1 towers, but not natural dirt banks or broad foundations.
    const column = verticalColumn(bot, position, block.name);
    if (column.height < 2) return false;
    if (above?.name === 'torch' || above?.name === 'lantern') return false;
    for (let y = column.bottom.y; y <= column.top.y; y++) {
        const part = new Vec3(position.x, y, position.z);
        if (isPositionProtected(bot, part, 1)
            || insideBuildFoundation(bot, part)
            || insideFarm(bot, part)
            || nearUtility(part, utilities)
            || openHorizontalSides(bot, part) < 3)
            return false;
    }
    return true;
}

export function findSettlementDebris(bot, maxBlocks = MAX_SCAN_BLOCKS) {
    const center = settlementCenter(bot);
    if (!center || center.dimension && center.dimension !== dimensionKey(bot)) return [];
    const ids = SUSPECT_NAMES
        .flatMap(name => mc.registryBlockIds(bot, name));
    if (ids.length === 0) return [];
    const utilities = nearbyUtilities(bot, center);
    const positions = bot.findBlocks({
        point: new Vec3(center.x, center.y, center.z),
        matching: ids,
        maxDistance: SCAN_RADIUS,
        count: maxBlocks,
    });
    const found = new Map();
    for (const position of positions) {
        if (position.y < center.y - 10 || position.y > center.y + 48) continue;
        const block = bot.blockAt(position);
        if (!block || !obviousTemporaryBlock(bot, block, utilities)) continue;
        found.set(blockKey(position), position.clone());
    }
    return [...found.values()].sort((a, b) =>
        b.y - a.y || a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
}

export function settlementNeedsCleanup(bot) {
    return findSettlementDebris(bot, 192).length > 0;
}

async function cleanupUnlocked(bot, limit) {
    const center = settlementCenter(bot);
    if (!center) return false;
    if (bot.entity.position.distanceTo(new Vec3(center.x, center.y, center.z)) > SCAN_RADIUS - 8)
        await goToPosition(bot, center.x, center.y, center.z, Math.max(3, Number(center.radius) || 8));

    const debris = findSettlementDebris(bot).slice(0, limit);
    if (debris.length === 0) {
        log(bot, 'Okoli naselbine ne vidim ocitnih zacasnih scaffold blokov.');
        return false;
    }

    let removed = 0;
    for (const position of debris) {
        if (bot.interrupt_code) break;
        const block = bot.blockAt(position);
        if (!block || !SUSPECT_NAMES.includes(block.name)
            || isPositionProtected(bot, position, 1)
            || insideBuildFoundation(bot, position)
            || insideFarm(bot, position))
            continue;
        bot.chat(mc.setBlockCommand(position.x, position.y, position.z, 'air', bot));
        await new Promise(resolve => setTimeout(resolve, COMMAND_DELAY_MS));
        if (bot.blockAt(position)?.name !== block.name) removed++;
    }
    log(bot, `Pospravil ${removed}/${debris.length} ocitnih zacasnih blokov okoli naselbine.`);
    return removed > 0;
}

export async function cleanupSettlement(bot, manual = false) {
    const result = await withNamedLock(
        bot,
        // Share the lock with schematic construction so cleanup never edits a
        // site while a builder is preparing or placing the structure.
        'global-schematic-builder',
        async () => await cleanupUnlocked(
            bot,
            manual ? MANUAL_REMOVE_LIMIT : AUTO_REMOVE_LIMIT,
        ),
        manual ? 1000 : 150,
    );
    if (!result.locked) {
        if (manual) log(bot, 'Drug NPC ze pospravlja naselbino.');
        return false;
    }
    return result.value;
}
