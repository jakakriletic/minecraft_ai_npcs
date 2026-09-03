// Advanced deterministic survival skills for Mindcraft agents (no LLM).
// These make the bots genuinely player-like at the game: iron progression,
// mining/strip-mining, food (hunt + cook), farming (wheat -> bread), torches,
// and tool maintenance. The brain (brain.js) sequences them; they're also
// exposed as commands. Everything is best-effort with guards + interrupt checks.
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import { Vec3 } from 'vec3';
import settings from '../../../settings.js';
import * as world from './world.js';
import * as base from './base.js';
import * as farming from './farm.js';
import * as storage from './storage.js';
import * as mc from '../../utils/mcdata.js';
import {
    isMiningPositionProtected,
    isNaturalResourceCandidate,
    isStructureBreakProtected,
} from './resource_guard.js';
import {
    log,
    collectBlock,
    craftRecipe,
    equipItemSafely,
    smeltItem,
    attackEntity,
    pickupNearbyItems,
    gearUp,
    obtainTool,
    placeBlock,
    goToPosition,
    tossItemSafely,
    avoidEnemies,
    consume,
} from './skills.js';

const PICKS = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe'];
const AXES = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe'];
const SWORDS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword'];
const OBSOLETE_WOODEN_EQUIPMENT = [
    'wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'wooden_shovel', 'wooden_hoe',
];
const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log'];
const FOOD = ['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'baked_potato',
    'apple', 'carrot', 'golden_carrot', 'cooked_cod', 'cooked_salmon', 'cooked_rabbit',
    // Legitimate 1.20.1 food that used to be ignored by pantry/recovery scans.
    'beetroot', 'cookie', 'dried_kelp', 'melon_slice', 'sweet_berries', 'glow_berries',
    'golden_apple', 'enchanted_golden_apple', 'mushroom_stew', 'rabbit_stew',
    'suspicious_stew', 'pumpkin_pie', 'honey_bottle'];
const RAW_MEAT = ['beef', 'porkchop', 'chicken', 'mutton', 'cod', 'salmon', 'rabbit'];
const COOKABLE_FOOD = [...RAW_MEAT, 'potato'];
const EMERGENCY_EDIBLE = ['beef', 'porkchop', 'mutton', 'cod', 'salmon', 'rabbit', 'potato', 'rotten_flesh'];
const PANTRY_ITEMS = [...FOOD, 'wheat', ...COOKABLE_FOOD, 'rotten_flesh'];
const FOOD_CROP_MATURITY = Object.freeze({
    wheat: 7,
    carrots: 7,
    potatoes: 7,
    beetroots: 3,
    sweet_berry_bush: 3,
});
const SMELT_FUEL = [
    'coal', 'charcoal', 'coal_block', 'blaze_rod', 'lava_bucket',
    'log', 'log2', ...LOGS,
    'planks', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
    'acacia_planks', 'dark_oak_planks',
];
const HAZARD = new Set(['lava', 'flowing_lava', 'water', 'flowing_water']);
const AIR_LIKE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tallgrass', 'tall_grass', 'fern', 'large_fern', 'snow']);
const SUPPORT_BLOCKS = ['cobblestone', 'dirt', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'planks', 'oak_planks', 'spruce_planks'];
const TOOL_TIER = { wooden: 1, golden: 1.5, stone: 2, iron: 3, diamond: 4, netherite: 5 };
const MINING_TRIP_EXTRA = 26;
const TUNNEL_OPEN_AIR_LIMIT = 38;
const EMERGENCY_RETURN_COOLDOWN_MS = 15000;
const EMERGENCY_RETURN_MAX_BACKOFF_MS = 120000;
const RECOVER_HEALTH_BELOW = 16;
const RECOVER_HEALTH_TARGET = 19;
const MODERN_ORE_TARGET_Y = {
    coal: 48,
    iron: 16,
    copper: 48,
    gold: -16,
    lapis: 0,
    redstone: -54,
    diamond: -54,
    emerald: 96,
};
const LEGACY_ORE_TARGET_Y = {
    coal: 48,
    iron: 35,
    copper: 48,
    gold: 12,
    lapis: 14,
    redstone: 11,
    diamond: 11,
    emerald: 16,
};

const invCount = (bot, names) => {
    const requested = Array.isArray(names) ? names : [names];
    return (bot?.inventory?.slots ?? [])
        .filter(item => item && mc.stackMatchesAnyName(item, requested, bot))
        .reduce((sum, item) => sum + Number(item.count ?? 0), 0);
};

function oreResourceName(name) {
    return String(name ?? '')
        .replace(/^minecraft:/, '')
        .replace(/^deepslate_/, '')
        .replace(/_ore$/, '');
}

export function preferredOreY(names, source = null) {
    const requested = Array.isArray(names) ? names : [names];
    const table = mc.usesExpandedWorldHeight(source) ? MODERN_ORE_TARGET_Y : LEGACY_ORE_TARGET_Y;
    const resource = requested.map(oreResourceName).find(name => table[name] != null);
    return table[resource] ?? (mc.usesExpandedWorldHeight(source) ? -16 : 8);
}

export function needsHealing(bot) {
    return bot?._guardianCombatExempt !== true
        && Number(bot?.health ?? 20) < RECOVER_HEALTH_BELOW;
}

// Kept as a narrow diagnostic predicate. Hunger recovery is selected by the brain
// and auto-eat; it must not interrupt every storage/mining/crafting action.
export function needsEmergencyNutrition(bot) {
    const food = Number(bot?.food ?? 20);
    const health = Number(bot?.health ?? 20);
    return food <= 3 || (food <= 6 && health < 8);
}

function countNames(counts, names) {
    return names.reduce((sum, name) => sum + Number(counts?.[name] ?? 0), 0);
}

function edibleFoodCount(bot) {
    return invCount(bot, [...FOOD, ...EMERGENCY_EDIBLE]);
}

export function needsFoodBeforeHealing(bot) {
    return needsHealing(bot)
        && Number(bot?.food ?? 20) < 18
        && edibleFoodCount(bot) < 1;
}

export function immediateRecoveryNeed(bot) {
    if ((needsEmergencyNutrition(bot) && edibleFoodCount(bot) < 1)
        || needsFoodBeforeHealing(bot))
        return 'food';
    if (needsHealing(bot)) return 'health';
    return null;
}

// The brain must not choose the passive healing loop while hunger makes natural
// regeneration impossible and there is no meal to eat. In that state it should
// run one bounded food rescue, then let farming/foraging and other safe work make
// progress while the rescue action is cooling down.
export function recoveryActionKind(bot, foodRescueCooling = false) {
    const need = immediateRecoveryNeed(bot);
    if (need === 'food') return foodRescueCooling ? null : 'food';
    if (need === 'health') return 'health';
    return null;
}

export function pantryItemPriority(item, bot = null) {
    if (mc.stackMatchesAnyName(item, FOOD, bot)) return 300;
    if (mc.stackMatchesName(item, 'wheat', bot)) return 200;
    if (mc.stackMatchesAnyName(item, EMERGENCY_EDIBLE, bot)) return 120;
    if (mc.stackMatchesAnyName(item, COOKABLE_FOOD, bot)) return 100;
    return 0;
}

export function selectedFuelSmeltCapacity(bot) {
    const fuel = mc.getSmeltingFuel(bot);
    if (!fuel) return 0;
    return Math.max(0, Math.floor(Number(fuel.count ?? 0) * mc.getFuelSmeltOutput(fuel.name)));
}

// Pure plan used by the emergency pantry path and its regression tests. Prepared
// food wins, then wheat becomes bread, then meat/potatoes use the furnace.
export function planEmergencyFood(counts = {}, targetCount = 6) {
    const target = Math.max(1, Math.floor(Number(targetCount) || 1));
    const prepared = countNames(counts, FOOD);
    let missing = Math.max(0, target - prepared);
    const craftBread = Math.min(Math.floor(Number(counts.wheat ?? 0) / 3), missing);
    missing -= craftBread;

    const cook = [];
    for (const name of COOKABLE_FOOD) {
        if (missing <= 0) break;
        const count = Math.min(Math.max(0, Number(counts[name] ?? 0)), missing);
        if (count > 0) cook.push({ name, count });
        missing -= count;
    }
    return { target, prepared, craftBread, cook, missing };
}

async function eatIfHungry(bot) {
    if (Number(bot?.food ?? 20) > 18 || edibleFoodCount(bot) < 1) return false;
    // Auto-eat correctly avoids rotten flesh during normal play. At the actual
    // starvation threshold, though, hunger/poison is survivable and starvation is
    // not, so consume one manually before trying the normal food selector.
    if (Number(bot.food ?? 20) <= 4 && invCount(bot, 'rotten_flesh') > 0)
        return await consume(bot, 'rotten_flesh');
    if (typeof bot.autoEat?.eat !== 'function') return false;
    try {
        return await bot.autoEat.eat() === true;
    } catch {
        return false;
    }
}

// Emergency pantry: withdraw pantry supplies in priority order, turn stored wheat
// into bread, then use raw food + fuel to cook a small batch at the shared furnace.
// A small batch is deliberate: it gets a starving bot eating inside one brain
// action instead of blocking for a whole stack of ten-second furnace cycles.
export async function prepareEmergencyFood(bot, targetCount = 6, { pullFromStorage = true } = {}) {
    if (!bot?.entity || !bot?.inventory) return false;
    const target = Math.max(1, Math.min(12, Math.floor(Number(targetCount) || 1)));

    if (pullFromStorage && invCount(bot, FOOD) < target) {
        const pantryTarget = Math.max(12, target * 3);
        let moved = 0;
        if (storage.getPublicStorage(bot)) {
            try {
                moved = await storage.withdrawPublicMatching(
                    bot,
                    item => mc.stackMatchesAnyName(item, PANTRY_ITEMS, bot),
                    pantryTarget,
                    ['food'],
                    item => pantryItemPriority(item, bot),
                );
            } catch { /* fall back to the personal chest */ }
        }
        if (moved === 0) {
            try { await base.takeAny(bot, PANTRY_ITEMS, pantryTarget); } catch { /* pantry is empty */ }
        }
    }

    let plan = planEmergencyFood(world.getInventoryCounts(bot), target);
    if (plan.craftBread > 0) {
        try { await craftRecipe(bot, 'bread', plan.craftBread); } catch { /* try raw food */ }
    }

    if (invCount(bot, FOOD) >= target) return true;
    plan = planEmergencyFood(world.getInventoryCounts(bot), target);
    let cookCount = plan.cook.reduce((sum, entry) => sum + entry.count, 0);
    const desiredCookCount = Math.min(3, cookCount);
    if (desiredCookCount > selectedFuelSmeltCapacity(bot) && pullFromStorage) {
        try { await base.takeAny(bot, SMELT_FUEL, 4); } catch { /* no fuel stored */ }
    }

    // If the first pantry stack was banned raw chicken and there is no fuel, do a
    // focused second pass for ready food/wheat instead of starving beside other food.
    if (cookCount > 0 && selectedFuelSmeltCapacity(bot) < 1
        && edibleFoodCount(bot) < 1 && pullFromStorage) {
        try { await base.takeAny(bot, [...FOOD, 'wheat'], Math.max(6, target * 3)); } catch { /* none */ }
        const fallbackPlan = planEmergencyFood(world.getInventoryCounts(bot), target);
        if (fallbackPlan.craftBread > 0) {
            try { await craftRecipe(bot, 'bread', fallbackPlan.craftBread); } catch { /* no table */ }
        }
        if (invCount(bot, FOOD) > 0) return true;
        plan = planEmergencyFood(world.getInventoryCounts(bot), target);
        cookCount = plan.cook.reduce((sum, entry) => sum + entry.count, 0);
    }

    if (cookCount > 0 && selectedFuelSmeltCapacity(bot) > 0
        && !world.getNearestBlock(bot, 'furnace', 16)
        && storage.getPublicStorage(bot)) {
        try { await storage.ensurePublicUtility(bot, 'furnace', 1, ['furnace'], 3000); } catch { /* no furnace */ }
    }

    let cookingBudget = 3;
    for (const entry of plan.cook) {
        if (bot.interrupt_code || cookingBudget <= 0) break;
        const fuelCapacity = selectedFuelSmeltCapacity(bot);
        const nearbyFurnace = world.getNearestBlock(bot, 'furnace', 16);
        if (fuelCapacity < 1 && !nearbyFurnace) break;
        // Never request a batch larger than the selected fuel stack can handle.
        // With an already-burning furnace, try one item and let smeltItem verify it.
        const amount = Math.min(entry.count, cookingBudget, Math.max(1, fuelCapacity));
        const before = invCount(bot, entry.name);
        try {
            await smeltItem(bot, entry.name, amount, { openAttempts: 1, openTimeoutMs: 5000 });
        } catch { /* raw food remains an emergency fallback */ }
        const cooked = Math.max(0, before - invCount(bot, entry.name));
        cookingBudget -= cooked;
        if (cooked === 0) break;
        if (invCount(bot, FOOD) >= target) break;
    }

    // Furnace GUI failures must not strand a bot with only banned raw chicken
    // while ready food exists in a later chest. Retry only the immediately usable
    // sources after a failed cooking attempt.
    if (edibleFoodCount(bot) < 1 && pullFromStorage) {
        try { await base.takeAny(bot, [...FOOD, 'wheat'], Math.max(6, target * 3)); } catch { /* none */ }
        const recoveryPlan = planEmergencyFood(world.getInventoryCounts(bot), target);
        if (recoveryPlan.craftBread > 0) {
            try { await craftRecipe(bot, 'bread', recoveryPlan.craftBread); } catch { /* no table */ }
        }
    }
    return edibleFoodCount(bot) > 0;
}

async function equipPick(bot) {
    for (const n of PICKS) {
        const it = bot.inventory.items().find(i => i.name === n);
        if (it) return await equipItemSafely(bot, it, 'hand');
    }
    return false;
}

async function takeSharedTool(bot, kind, tiers) {
    if (!storage.getPublicStorage(bot)) return false;
    bot._sharedToolRetry ??= {};
    const retryAt = bot._sharedToolRetry[kind] ?? 0;
    if (Date.now() < retryAt) return false;
    const allowed = new Set(tiers.map(tier => `${tier}_${kind}`));
    const selected = await storage.takeOnePublicMatching(
        bot,
        item => allowed.has(item.name),
        item => {
            const tier = item.name.split('_')[0];
            const enchants = (item.enchants ?? [])
                .reduce((sum, enchantment) => sum + Number(enchantment.lvl ?? 1), 0);
            const durability = item.maxDurability
                ? Math.max(0, 1 - (item.durabilityUsed ?? 0) / item.maxDurability)
                : 1;
            return (TOOL_TIER[tier] ?? 0) * 100 + enchants * 2 + durability;
        },
    );
    if (!selected)
        bot._sharedToolRetry[kind] = Date.now() + 120_000;
    else
        bot._sharedToolRetry[kind] = 0;
    return Boolean(selected);
}

async function gotoNearWithTimeout(bot, pos, radius = 1, timeoutMs = 20_000) {
    let timer;
    try {
        await Promise.race([
            bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, radius)),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    try { bot.pathfinder.setGoal(null); } catch { /* disconnected */ }
                    try { bot.pathfinder.stop(); } catch { /* disconnected */ }
                    reject(new Error('path timeout'));
                }, timeoutMs);
            }),
        ]);
        return true;
    } catch {
        try { bot.pathfinder.setGoal(null); } catch { /* */ }
        try { bot.pathfinder.stop(); } catch { /* */ }
        return false;
    } finally {
        clearTimeout(timer);
    }
}

function usernameAngle(username) {
    let hash = 0;
    for (const char of String(username))
        hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    return (hash % 360) * Math.PI / 180;
}

function isAirLike(block) {
    return !block || AIR_LIKE.has(block.name);
}

function isSafeSolid(block) {
    return block
        && !AIR_LIKE.has(block.name)
        && !HAZARD.has(block.name)
        && Array.isArray(block.shapes)
        && block.shapes.length > 0;
}

function settlementAnchor(bot) {
    return storage.getPublicStorage(bot) ?? base.getBase(bot) ?? null;
}

export function isBelowSettlement(bot, margin = 8) {
    const anchor = settlementAnchor(bot);
    return Boolean(bot?.entity && anchor
        && bot.entity.position.y < Number(anchor.y) - Math.max(1, margin));
}

function isStandableAt(bot, pos, allowProtected = false) {
    const feet = bot.blockAt(pos, false);
    const head = bot.blockAt(pos.offset(0, 1, 0), false);
    const floor = bot.blockAt(pos.offset(0, -1, 0), false);
    return isAirLike(feet) && isAirLike(head) && isSafeSolid(floor)
        && (allowProtected || !isMiningPositionProtected(bot, pos));
}

function stableFooting(bot, pos, radius = 1) {
    let safe = 0;
    let total = 0;
    for (let dx = -radius; dx <= radius; dx++)
        for (let dz = -radius; dz <= radius; dz++) {
            total++;
            const p = pos.offset(dx, 0, dz);
            const floor = bot.blockAt(p.offset(0, -1, 0), false);
            const feet = bot.blockAt(p, false);
            const head = bot.blockAt(p.offset(0, 1, 0), false);
            if (isSafeSolid(floor) && isAirLike(feet) && isAirLike(head)) safe++;
        }
    return safe >= Math.ceil(total * 0.65);
}

export function findSafeSurfaceStand(bot, x, z, aroundY = bot.entity?.position?.y ?? 64, allowProtected = false) {
    const worldMinY = bot.game?.minY ?? -64;
    const worldMaxY = worldMinY + (bot.game?.height ?? 384) - 2;
    const startY = Math.min(worldMaxY - 2, Math.floor(aroundY) + 72);
    const endY = Math.max(worldMinY + 2, Math.floor(aroundY) - 72);
    for (let y = startY; y >= endY; y--) {
        const pos = new Vec3(Math.floor(x), y, Math.floor(z));
        if (!isStandableAt(bot, pos, allowProtected)) continue;
        if (!stableFooting(bot, pos)) continue;
        return pos;
    }
    return null;
}

function surfaceYAt(bot, x, z, aroundY = bot.entity?.position?.y ?? 64) {
    return findSafeSurfaceStand(bot, x, z, aroundY)?.y ?? null;
}

function isUnderground(bot, pos = bot.entity?.position) {
    if (!pos) return false;
    const surfaceY = surfaceYAt(bot, Math.floor(pos.x), Math.floor(pos.z), Math.max(pos.y, base.getPersonalAnchor(bot)?.y ?? pos.y));
    return surfaceY !== null && surfaceY - Math.floor(pos.y) >= 8;
}

export function isOpenCaveTrap(bot, pos = bot.entity?.position) {
    if (!bot?.entity || !pos || !isUnderground(bot, pos)) return false;
    const feet = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    const floor = bot.blockAt(feet.offset(0, -1, 0), false);
    if (!isSafeSolid(floor)) return true;

    let air = 0;
    let loaded = 0;
    for (let dx = -2; dx <= 2; dx++)
        for (let dz = -2; dz <= 2; dz++)
            for (let dy = -1; dy <= 3; dy++) {
                const block = bot.blockAt(feet.offset(dx, dy, dz), false);
                if (!block) continue;
                loaded++;
                if (isAirLike(block)) air++;
            }
    return loaded < 75 || air >= 55;
}

export function isSurfaceRecoveryComplete(bot) {
    const pos = bot?.entity?.position;
    if (!pos) return false;

    // Completion is intentionally stricter than trap detection. A few blocks of
    // stair progress must not clear the recovery flag while the bot is still well
    // below the town floor (the live Lara loop did exactly that at y=53).
    const anchor = settlementAnchor(bot);
    if (anchor && pos.y < Number(anchor.y) - 4) return false;

    // Accept only a nearby stable top stand. When chunks above are loaded this
    // rejects the cave floor in favor of the actual surface stand.
    const aroundY = Math.max(pos.y, base.getPersonalAnchor(bot)?.y ?? pos.y);
    // Protected settlement blocks are valid footing here; no block is being mined.
    const surface = findSafeSurfaceStand(bot, pos.x, pos.z, aroundY, true);
    return Boolean(surface && surface.y - Math.floor(pos.y) < 8);
}

function bestSupportBlock(bot) {
    const counts = world.getInventoryCounts(bot);
    return SUPPORT_BLOCKS.find(name => (counts[name] ?? 0) > 0) ?? null;
}

async function placeEmergencySupport(bot, pos) {
    const support = bestSupportBlock(bot);
    if (!support) return false;
    try { return await placeBlock(bot, support, pos.x, pos.y, pos.z, 'bottom', true); }
    catch { return false; }
}

async function hopTo(bot, pos) {
    const target = pos.offset(0.5, 0.1, 0.5);
    try { await bot.lookAt(target, true); } catch { /* keep moving */ }
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    await new Promise(resolve => setTimeout(resolve, 850));
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
    return bot.entity.position.distanceTo(pos.offset(0.5, 0, 0.5)) <= 1.6
        && bot.entity.position.y >= pos.y - 0.3;
}

async function prepareUpStep(bot, dir) {
    const basePos = bot.entity.position.floored();
    const floor = basePos.offset(dir.x, 0, dir.z);
    const feet = basePos.offset(dir.x, 1, dir.z);
    const head = basePos.offset(dir.x, 2, dir.z);
    if (HAZARD.has(bot.blockAt(floor, false)?.name)
        || HAZARD.has(bot.blockAt(feet, false)?.name)
        || HAZARD.has(bot.blockAt(head, false)?.name))
        return false;
    if (!isSafeSolid(bot.blockAt(floor, false)) && !await placeEmergencySupport(bot, floor))
        return false;
    if (!isAirLike(bot.blockAt(feet, false)) && !await digAt(bot, feet)) return false;
    if (!isAirLike(bot.blockAt(head, false)) && !await digAt(bot, head)) return false;
    return isSafeSolid(bot.blockAt(floor, false)) && isAirLike(bot.blockAt(feet, false)) && isAirLike(bot.blockAt(head, false))
        ? await hopTo(bot, feet)
        : false;
}

async function digEmergencyStairUp(bot, steps = 18) {
    await equipPick(bot);
    const directions = [
        new Vec3(1, 0, 0),
        new Vec3(0, 0, 1),
        new Vec3(-1, 0, 0),
        new Vec3(0, 0, -1),
    ];
    const startIndex = Math.floor(usernameAngle(bot.username) / (Math.PI / 2)) % directions.length;
    for (let i = 0; i < steps && !bot.interrupt_code; i++) {
        if (!isUnderground(bot) && !isOpenCaveTrap(bot)) return true;
        let moved = false;
        for (let attempt = 0; attempt < directions.length && !moved; attempt++)
            moved = await prepareUpStep(bot, directions[(startIndex + attempt) % directions.length]);
        if (!moved) return false;
    }
    return !isOpenCaveTrap(bot);
}

function stopRecoveryMotion(bot) {
    let hadCollectTargets = false;
    try {
        hadCollectTargets = bot.collectBlock?.targets && !bot.collectBlock.targets.empty;
        bot.collectBlock?.targets?.clear?.();
    } catch { /* disconnected */ }
    try { bot.pathfinder?.setGoal?.(null); } catch { /* disconnected */ }
    try { bot.pathfinder?.stop?.(); } catch { /* disconnected */ }
    try {
        const stopping = bot.stopDigging?.();
        if (stopping?.catch) void stopping.catch(() => {});
    } catch { /* disconnected */ }
    if (hadCollectTargets) {
        try { queueMicrotask(() => bot.emit('collectBlock_finished')); } catch { /* disconnected */ }
    }
    for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'])
        try { bot.setControlState(control, false); } catch { /* disconnected */ }
}

export async function emergencyReturnHome(bot, reason = 'stuck') {
    if (settings.mining_emergency_teleport === false || !bot?.entity) return false;
    const now = Date.now();
    if (now < (bot._emergencyReturnHomeRetryAt ?? 0)) return false;
    const anchor = base.getBase(bot) ?? storage.getPublicStorage(bot);
    if (!anchor) return false;
    const safe = findSafeSurfaceStand(bot, anchor.x, anchor.z, anchor.y, true)
        ?? new Vec3(Math.floor(anchor.x), Math.floor(anchor.y), Math.floor(anchor.z));
    stopRecoveryMotion(bot);
    bot._emergencyReturnHomeRetryAt = now + EMERGENCY_RETURN_COOLDOWN_MS;
    log(bot, `Emergency recovery (${reason}): poskusam reset na setHome pri ${safe.x},${safe.y},${safe.z}.`);
    console.warn(`[recovery ${bot.username}] attempting setHome reset ${safe.x},${safe.y},${safe.z} (${reason})`);
    for (const command of [
        `/tp @s ${safe.x + 0.5} ${safe.y} ${safe.z + 0.5}`,
        `/tp ${bot.username} ${safe.x + 0.5} ${safe.y} ${safe.z + 0.5}`,
    ]) {
        bot.chat(command);
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
            if (bot.entity.position.distanceTo(safe.offset(0.5, 0, 0.5)) <= 3) {
                bot._miningRecoveryFailures = 0;
                bot._miningRecoveryRequested = false;
                bot._emergencyReturnHomeBackoffMs = 0;
                bot._emergencyReturnHomeRetryAt = 0;
                console.warn(`[recovery ${bot.username}] setHome reset succeeded`);
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    const previousBackoff = bot._emergencyReturnHomeBackoffMs ?? EMERGENCY_RETURN_COOLDOWN_MS;
    const nextBackoff = Math.min(EMERGENCY_RETURN_MAX_BACKOFF_MS, previousBackoff * 2);
    bot._emergencyReturnHomeBackoffMs = nextBackoff;
    bot._emergencyReturnHomeRetryAt = Date.now() + nextBackoff;
    console.warn(`[recovery ${bot.username}] setHome reset did not move bot; retrying after ${Math.round(nextBackoff / 1000)}s`);
    return false;
}

export async function recoverFromMiningTrap(bot) {
    if (!bot?.entity) return false;
    if (isSurfaceRecoveryComplete(bot)) {
        bot._miningRecoveryFailures = 0;
        bot._miningRecoveryRequested = false;
        return true;
    }
    log(bot, 'Rudarjenje: resujem se iz jame/proc od prepada.');
    const pos = bot.entity.position;
    const aroundY = Math.max(pos.y, base.getPersonalAnchor(bot)?.y ?? pos.y);
    const candidates = [];
    const candidateKeys = new Set();
    for (const radius of [0, 4, 8, 12, 18]) {
        const attempts = radius === 0 ? 1 : 12;
        for (let i = 0; i < attempts && !bot.interrupt_code; i++) {
            const angle = usernameAngle(bot.username) + i * (Math.PI * 2 / attempts);
            const safe = findSafeSurfaceStand(
                bot,
                Math.floor(pos.x + Math.cos(angle) * radius),
                Math.floor(pos.z + Math.sin(angle) * radius),
                aroundY,
            );
            const key = safe ? `${safe.x},${safe.y},${safe.z}` : null;
            if (safe && !candidateKeys.has(key)) {
                candidateKeys.add(key);
                candidates.push(safe);
            }
            if (candidates.length >= 4) break;
        }
        if (candidates.length >= 4) break;
    }
    for (const safe of candidates) {
        if (bot.interrupt_code) break;
        if (await gotoNearWithTimeout(bot, safe, 2, 8000)
            && isSurfaceRecoveryComplete(bot)) {
            bot._miningRecoveryFailures = 0;
            bot._miningRecoveryRequested = false;
            return true;
        }
    }

    const climbed = await digEmergencyStairUp(bot, 8);
    if (climbed && isSurfaceRecoveryComplete(bot)) {
        bot._miningRecoveryFailures = 0;
        bot._miningRecoveryRequested = false;
        log(bot, 'Rudarjenje: nasel sem izhod iz slabe lokacije.');
        return true;
    }
    if (climbed)
        log(bot, 'Rudarjenje: napredoval sem navzgor, vendar se nisem na povrsju.');
    if (bot.interrupt_code) return false;
    bot._miningRecoveryFailures = (bot._miningRecoveryFailures ?? 0) + 1;
    const teleportAfter = Math.max(1, Number(settings.mining_recovery_teleport_failures) || 2);
    if (bot._miningRecoveryFailures >= teleportAfter
        && await emergencyReturnHome(bot, 'mining trap')
        && isSurfaceRecoveryComplete(bot))
        return true;
    log(bot, 'Rudarjenje: izhod ni uspel, poskusim znova naslednji tick.');
    return false;
}

async function ensureMiningDistance(bot) {
    if (!bot.entity) return false;
    if (isOpenCaveTrap(bot)) return await recoverFromMiningTrap(bot);
    if (!isMiningPositionProtected(bot, bot.entity.position)) return true;
    const shared = storage.getPublicStorage(bot);
    const home = base.getPersonalAnchor(bot);
    const center = shared ?? home ?? bot.entity.position;
    const radius = Number(center.radius) || 10;
    const startAngle = usernameAngle(bot.username);

    log(bot, 'Rudnik bom odprl stran od baze.');
    for (const distance of [radius + MINING_TRIP_EXTRA, radius + 44, radius + 64, radius + 88, radius + 112]) {
        for (let attempt = 0; attempt < 12 && !bot.interrupt_code; attempt++) {
            const angle = startAngle + attempt * (Math.PI * 2 / 12);
            const target = new Vec3(
                Math.floor(center.x + Math.cos(angle) * distance),
                Math.floor(bot.entity.position.y),
                Math.floor(center.z + Math.sin(angle) * distance),
            );
            const safe = findSafeSurfaceStand(bot, target.x, target.z, center.y ?? bot.entity.position.y);
            if (!safe) continue;
            try {
                if (await goToPosition(bot, safe.x, safe.y, safe.z, 3)
                    && !isMiningPositionProtected(bot, bot.entity.position))
                    return true;
            } catch { /* try another direction */ }
        }
    }
    log(bot, 'Ne najdem varne poti do rudarskega obmocja stran od naselbine.');
    return false;
}

async function digAt(bot, pos) {
    const b = bot.blockAt(pos);
    if (!b || b.name === 'air' || b.name === 'bedrock' || !b.diggable) return false;
    if (isStructureBreakProtected(bot, pos)) return false;
    if (HAZARD.has(b.name)) return false;
    try {
        if (bot.entity.position.distanceTo(pos) > 4 && !await gotoNearWithTimeout(bot, pos, 3)) return false;
        await equipPick(bot);
        await bot.dig(b);
        return true;
    } catch { return false; }
}

const ORES = ['coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'emerald_ore',
    'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_copper_ore', 'deepslate_gold_ore', 'deepslate_redstone_ore', 'deepslate_lapis_ore', 'deepslate_diamond_ore', 'deepslate_emerald_ore'];
// grab any exposed ore within a few blocks (called while tunnelling)
async function grabNearbyOres(bot) {
    const ores = world.getNearestBlocks(bot, ORES, 4, 3)
        .filter(block => safeMiningTarget(bot, block)); // ID fast path
    for (const o of ores) {
        if (bot.interrupt_code) break;
        try { await collectBlock(bot, o.name, 1); } catch { /* */ }
    }
}

function hazardAhead(bot, cells) {
    return cells.some(p => HAZARD.has(bot.blockAt(p)?.name));
}

function openCavityAhead(bot, cells) {
    return cells.some(p => {
        const block = bot.blockAt(p, false);
        return !block || AIR_LIKE.has(block.name);
    });
}

function openAirCount(bot, pos, radius = 2) {
    let air = 0;
    for (let dx = -radius; dx <= radius; dx++)
        for (let dz = -radius; dz <= radius; dz++)
            for (let dy = -radius; dy <= radius; dy++)
                if (isAirLike(bot.blockAt(pos.offset(dx, dy, dz), false))) air++;
    return air;
}

function isOpenCaveOre(bot, block) {
    const anchorY = Math.max(
        bot.entity?.position?.y ?? block.position.y,
        base.getBase(bot)?.y ?? block.position.y,
        storage.getPublicStorage(bot)?.y ?? block.position.y,
    );
    const surfaceY = surfaceYAt(bot, block.position.x, block.position.z, anchorY);
    return surfaceY !== null
        && surfaceY - block.position.y >= 8
        && openAirCount(bot, block.position, 2) >= 45;
}

function safeMiningTarget(bot, block) {
    return isNaturalResourceCandidate(bot, block, block.name)
        && !isOpenCaveOre(bot, block);
}

function isExposedMiningTarget(bot, block) {
    const neighbors = [
        block.position.offset(1, 0, 0), block.position.offset(-1, 0, 0),
        block.position.offset(0, 1, 0), block.position.offset(0, -1, 0),
        block.position.offset(0, 0, 1), block.position.offset(0, 0, -1),
    ];
    return neighbors.some(position => {
        const neighbor = bot.blockAt(position, false);
        return neighbor && isAirLike(neighbor);
    });
}

function isTraversableTunnelCell(bot, feet, head = feet.offset(0, 1, 0)) {
    return isAirLike(bot.blockAt(feet, false))
        && isAirLike(bot.blockAt(head, false))
        && isSafeSolid(bot.blockAt(feet.offset(0, -1, 0), false))
        && !isMiningPositionProtected(bot, feet)
        && openAirCount(bot, feet, 2) < TUNNEL_OPEN_AIR_LIMIT;
}

function looksLikeCaveOpening(bot, feet, cells) {
    return openCavityAhead(bot, cells)
        && !isTraversableTunnelCell(bot, feet)
        && openAirCount(bot, feet, 2) >= TUNNEL_OPEN_AIR_LIMIT;
}

async function nudgeIntoCell(bot, feet) {
    const center = feet.offset(0.5, 0.1, 0.5);
    try { bot.pathfinder?.setGoal?.(null); } catch { /* disconnected */ }
    try { bot.pathfinder?.stop?.(); } catch { /* disconnected */ }
    try { await bot.lookAt(center, true); } catch { /* keep moving */ }
    try {
        bot.setControlState('forward', true);
        if (feet.y > bot.entity.position.y + 0.2)
            bot.setControlState('jump', true);
        await new Promise(resolve => setTimeout(resolve, 900));
    } finally {
        for (const control of ['forward', 'jump', 'sprint', 'sneak'])
            try { bot.setControlState(control, false); } catch { /* disconnected */ }
    }
    return bot.entity.position.distanceTo(feet.offset(0.5, 0, 0.5)) <= 1.35
        && bot.entity.position.y >= feet.y - 0.4;
}

async function advanceTunnelCell(bot, feet) {
    if (bot.entity.position.distanceTo(feet.offset(0.5, 0, 0.5)) <= 1.1)
        return true;
    if (await gotoNearWithTimeout(bot, feet, 0, 3500))
        return true;
    return await nudgeIntoCell(bot, feet);
}

export function beginMiningTrail(bot, expeditionId) {
    if (bot._miningTrailFor === expeditionId && Array.isArray(bot._miningTrail)) return;
    bot._miningTrailFor = expeditionId;
    bot._miningTrail = [];
    if (bot.entity?.position) bot._miningTrail.push(bot.entity.position.floored());
}

function recordMiningTrail(bot) {
    if (!bot._miningTrailFor || !bot.entity?.position) return;
    bot._miningTrail ??= [];
    const current = bot.entity.position.floored();
    const previous = bot._miningTrail.at(-1);
    if (!previous || previous.distanceTo(current) >= 2.5)
        bot._miningTrail.push(current);
    if (bot._miningTrail.length > 160)
        bot._miningTrail.splice(0, bot._miningTrail.length - 160);
}

// Retrace short local waypoints before asking the global pathfinder to solve the
// entire shaft in one shot. This keeps the exact staircase/branch topology that
// the bot actually traversed and greatly reduces failed underground returns.
export async function returnAlongMiningTrail(bot, finalPosition = null) {
    const trail = Array.isArray(bot._miningTrail) ? [...bot._miningTrail].reverse() : [];
    for (const waypoint of trail) {
        if (bot.interrupt_code) return false;
        if (bot.entity.position.distanceTo(waypoint) <= 2) continue;
        if (!await goToPosition(bot, waypoint.x, waypoint.y, waypoint.z, 1)) return false;
    }
    if (finalPosition
        && !await goToPosition(bot, finalPosition.x, finalPosition.y, finalPosition.z, 2))
        return false;
    bot._miningTrail = [];
    bot._miningTrailFor = null;
    return trail.length > 0 || Boolean(finalPosition);
}

export function clearMiningTrail(bot) {
    bot._miningTrail = [];
    bot._miningTrailFor = null;
}

function cardinalMiningDirection(direction = { x: 1, z: 0 }) {
    const x = Number(direction?.x ?? 0);
    const z = Number(direction?.z ?? 0);
    if (Math.abs(x) >= Math.abs(z)) return new Vec3(x < 0 ? -1 : 1, 0, 0);
    return new Vec3(0, 0, z < 0 ? -1 : 1);
}

async function widenTunnelCell(bot, feet, direction, extraHead = false) {
    const side = new Vec3(-direction.z, 0, direction.x);
    const sideFeet = feet.offset(side.x, 0, side.z);
    const sideHead = sideFeet.offset(0, 1, 0);
    const sideTop = sideFeet.offset(0, 2, 0);
    if (isMiningPositionProtected(bot, sideFeet)) return false;
    if (!isSafeSolid(bot.blockAt(sideFeet.offset(0, -1, 0), false))) return false;
    if (hazardAhead(bot, [sideFeet, sideHead, sideTop])) return false;
    if (!isAirLike(bot.blockAt(sideHead, false)) && !await digAt(bot, sideHead)) return false;
    if (!isAirLike(bot.blockAt(sideFeet, false)) && !await digAt(bot, sideFeet)) return false;
    if (extraHead && !isAirLike(bot.blockAt(sideTop, false)))
        await digAt(bot, sideTop);
    return true;
}

// Dig or follow a 1x2 tunnel in one cardinal direction for `length`, grabbing ore,
// stopping on hazards/low HP.
// If another miner already opened the tunnel, advance through that safe air instead of
// misclassifying it as a cave. Best-effort side widening gives a party room to pass.
export async function stripMine(bot, length = 24, requestedDirection = { x: 1, z: 0 }) {
    if (!await ensureMiningDistance(bot)) return false;
    await equipPick(bot);
    const direction = cardinalMiningDirection(requestedDirection);
    let advanced = false;
    for (let i = 0; i < length && !bot.interrupt_code; i++) {
        if (bot.health <= 8) { log(bot, 'Malo zdravja, neham kopat.'); break; }
        const base = bot.entity.position.floored();
        const feet = base.offset(direction.x, 0, direction.z);
        const head = feet.offset(0, 1, 0);
        const twoAhead = base.offset(direction.x * 2, 0, direction.z * 2);
        if (isMiningPositionProtected(bot, feet)) break;
        if (hazardAhead(bot, [feet, head, twoAhead, feet.offset(0, -1, 0)])
            || looksLikeCaveOpening(bot, feet, [feet, head])
            || !isSafeSolid(bot.blockAt(feet.offset(0, -1, 0), false))) {
            log(bot, 'Pred tunelom je jama/prepad, neham kopat.');
            break;
        }
        if (!isTraversableTunnelCell(bot, feet, head)) {
            await digAt(bot, head);
            await digAt(bot, feet);
        }
        await widenTunnelCell(bot, feet, direction);
        await grabNearbyOres(bot);
        if (!isTraversableTunnelCell(bot, feet, head) || !await advanceTunnelCell(bot, feet)) break;
        advanced = true;
        recordMiningTrail(bot);
        if (i % 6 === 5 && invCount(bot, 'torch') > 0) {
            const p = bot.entity.position.floored();
            try { await placeBlock(bot, 'torch', p.x, p.y, p.z, 'bottom', true); } catch { /* keep mining */ }
        }
    }
    return advanced;
}

// Safe-ish staircase down toward +x for `steps` (to reach ore depth).
export async function descend(bot, steps = 12) {
    if (!await ensureMiningDistance(bot)) return false;
    await equipPick(bot);
    let advanced = false;
    for (let i = 0; i < steps && !bot.interrupt_code; i++) {
        if (bot.health <= 8) break;
        const base = bot.entity.position.floored();
        const step = base.offset(1, -1, 0), head = base.offset(1, 1, 0), mid = base.offset(1, 0, 0);
        if (isMiningPositionProtected(bot, step)) break;
        if (hazardAhead(bot, [step, head, mid, step.offset(0, -1, 0)])
            || !isSafeSolid(bot.blockAt(step.offset(0, -1, 0), false))
            || looksLikeCaveOpening(bot, step, [step, mid])) {
            log(bot, 'Spodaj je jama/prepad, neham se spuscat.');
            break;
        }
        if (!isTraversableTunnelCell(bot, step, mid)) {
            await digAt(bot, head); await digAt(bot, mid); await digAt(bot, step);
        }
        await widenTunnelCell(bot, step, new Vec3(1, 0, 0), true);
        await grabNearbyOres(bot);
        if (!isTraversableTunnelCell(bot, step, mid) || !await advanceTunnelCell(bot, step)) break;
        advanced = true;
        recordMiningTrail(bot);
        if (i % 4 === 3 && invCount(bot, 'torch') > 0) { // light the staircase so mobs don't spawn on it
            const p = bot.entity.position.floored();
            try { await placeBlock(bot, 'torch', p.x, p.y, p.z, 'bottom', true); } catch { /* keep descending */ }
        }
    }
    return advanced;
}

// Mine a given ore: exposed first, then dig toward it (strip / descend) ONLY if
// allowDigging (manual commands). Autonomous brain passes allowDigging=false so
// bots never strand themselves underground — they just grab exposed ore.
export async function mineOre(bot, names, count = 3, allowDigging = true) {
    const drops = names.map(n => n.replace('deepslate_', '').replace('_ore', '')).flatMap(b =>
        b === 'iron' ? ['raw_iron', 'iron_ingot'] : b === 'gold' ? ['raw_gold', 'gold_ingot'] :
        b === 'copper' ? ['raw_copper', 'copper_ingot'] : b === 'lapis' ? ['lapis_lazuli'] : [b]);
    const have = () => invCount(bot, drops);
    const start = have();
    const targetY = preferredOreY(names, bot);
    const descentBatches = Math.max(0, Math.ceil((Number(bot?.entity?.position?.y ?? targetY) - targetY - 2) / 10));
    const maxTries = Math.min(16, Math.max(4, descentBatches + 4));
    if (allowDigging && !await ensureMiningDistance(bot)) return false;
    for (let tries = 0; tries < maxTries && have() - start < count && !bot.interrupt_code; tries++) {
        // findBlocks sees buried blocks in loaded chunks. Only hand an exposed ore
        // to generic collectBlock; otherwise continue the controlled staircase or
        // strip tunnel until mining naturally exposes a vein.
        const found = world.getNearestBlocks(bot, names, 64, 16)
            .filter(block => safeMiningTarget(bot, block) && isExposedMiningTarget(bot, block));
        if (found.length) await collectBlock(bot, found[0].name, count - (have() - start));
        else if (!allowDigging) break;                  // surface only: nothing exposed -> give up
        else if (bot.entity.position.y > targetY + 2) await descend(bot, 10);
        else await stripMine(bot, 22);
    }
    const success = have() - start > 0 || have() >= count;
    if (allowDigging && !bot._miningExpeditionActive
        && (isBelowSettlement(bot) || isOpenCaveTrap(bot))) {
        bot._miningRecoveryRequested = true;
        if (!bot.interrupt_code)
            await recoverFromMiningTrap(bot);
    }
    return success;
}

// Full iron progression: stone pick -> fuel -> mine iron -> smelt -> craft iron pick (+sword).
export async function progressToIron(bot, allowDigging = true) {
    if (invCount(bot, 'iron_pickaxe') > 0) return true;
    if (await takeSharedTool(bot, 'pickaxe', ['netherite', 'diamond', 'iron']))
        return true;
    log(bot, 'Grem po železo...');
    if (invCount(bot, ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe']) === 0) await gearUp(bot);
    if (invCount(bot, ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe']) === 0) { log(bot, 'Brez kamnitega krampa ne morem do železa.'); return false; }

    // fuel: prefer coal, else wood works in smeltItem
    if (invCount(bot, ['coal', 'charcoal']) === 0 && invCount(bot, LOGS) < 4) await mineOre(bot, ['coal_ore', 'deepslate_coal_ore'], 4, allowDigging);
    await mineOre(bot, ['iron_ore', 'deepslate_iron_ore'], 4, allowDigging);

    if (invCount(bot, ['raw_iron', 'iron_ingot']) === 0) { log(bot, 'Železne rude (še) ne najdem tu okoli.'); return false; }
    if (invCount(bot, 'raw_iron') > 0) await smeltItem(bot, 'raw_iron', invCount(bot, 'raw_iron'));
    await craftRecipe(bot, 'iron_pickaxe', 1);
    if (invCount(bot, 'iron_ingot') >= 2) await craftRecipe(bot, 'iron_sword', 1);
    const ok = invCount(bot, 'iron_pickaxe') > 0;
    log(bot, ok ? 'Naredil sem železni kramp!' : 'Železnega krampa mi ni čisto uspelo.');
    return ok;
}

// Make torches (needs coal/charcoal + sticks; mines a little coal if needed).
export async function makeTorches(bot, count = 8, allowDigging = true) {
    if (invCount(bot, 'torch') >= count) return true;
    if (invCount(bot, ['coal', 'charcoal']) === 0) await mineOre(bot, ['coal_ore', 'deepslate_coal_ore'], 2, allowDigging);
    if (invCount(bot, ['coal', 'charcoal']) === 0) return false;
    if (invCount(bot, 'stick') < 1) await craftRecipe(bot, 'stick', 4);
    await craftRecipe(bot, 'torch', count);
    return invCount(bot, 'torch') > 0;
}

// Ensure we have food: hunt an animal, pick up the drop, cook it (or keep raw — still edible).
export async function recoverNutrition(bot, targetFood = 14) {
    if (!bot?.entity) return false;
    const target = Math.max(10, Math.min(18, Number(targetFood) || 14));
    const startingFood = Number(bot.food ?? 20);
    if (startingFood >= target) return true;

    try { bot.pvp?.stop?.(); } catch { /* not fighting */ }
    try { await prepareEmergencyFood(bot, 6); } catch { /* pantry may be empty */ }

    const eatAvailableFood = async () => {
        for (let attempt = 0; attempt < 4
            && !bot.interrupt_code
            && Number(bot.food ?? 20) < target
            && edibleFoodCount(bot) > 0; attempt++) {
            await eatIfHungry(bot);
        }
    };
    await eatAvailableFood();

    if (Number(bot.food ?? 20) < target && !bot.interrupt_code) {
        try { await farming.harvestForFood(bot); } catch { /* farm may be empty */ }
        try { await prepareEmergencyFood(bot, 4, { pullFromStorage: false }); } catch { /* no crop */ }
        await eatAvailableFood();
    }
    if (Number(bot.food ?? 20) < target && !bot.interrupt_code && edibleFoodCount(bot) < 1) {
        try { await secureFood(bot, { pullFromStorage: false }); } catch { /* no safe source */ }
        await eatAvailableFood();
    }

    return Number(bot.food ?? 20) > startingFood || Number(bot.food ?? 20) >= target;
}

export async function recoverHealth(bot, targetHealth = RECOVER_HEALTH_TARGET) {
    if (!bot?.entity) return false;
    const startingHealth = Number(bot.health ?? 20);
    if (startingHealth >= targetHealth) return true;

    try { bot.pvp?.stop?.(); } catch { /* not fighting */ }
    try { if (!bot.autoEat?.isEating) bot.deactivateItem?.(); } catch { /* not using item */ }

    const targetReached = () => Number(bot.health ?? 20) >= targetHealth;
    const stopEarly = () => bot.interrupt_code || targetReached();

    // Use food already carried/shared first, but do not run the whole harvest/hunt
    // macro here. The brain handles that separately, so healing cannot monopolize
    // every other job when the pantry is empty.
    try { await prepareEmergencyFood(bot, 6); } catch { /* no usable pantry supplies */ }
    if (stopEarly()) return !bot.interrupt_code;
    await eatIfHungry(bot);
    if (stopEarly()) return !bot.interrupt_code;

    const stillNeedsNutrition = () => Number(bot.food ?? 20) <= 18 && edibleFoodCount(bot) < 1;
    if (stillNeedsNutrition()) {
        try { await farming.harvestForFood(bot); } catch { /* farm may be empty */ }
        if (stopEarly()) return !bot.interrupt_code;
        await eatIfHungry(bot);
        if (stopEarly()) return !bot.interrupt_code;
    }
    if (stillNeedsNutrition() && startingHealth >= 12) {
        try { await secureFood(bot, { pullFromStorage: false }); } catch { /* too risky or no food nearby */ }
        if (stopEarly()) return !bot.interrupt_code;
        await eatIfHungry(bot);
        if (stopEarly()) return !bot.interrupt_code;
    }

    // Waiting cannot heal below 18 hunger. Return promptly so the decision graph
    // can establish a farm or forage instead of pacing between empty containers
    // for 18 seconds and selecting the same impossible action again.
    if (stillNeedsNutrition()) return false;

    const hostile = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), 16);
    if (hostile) {
        try { await avoidEnemies(bot, 24); } catch { /* no retreat path */ }
        if (stopEarly()) return !bot.interrupt_code;
    }

    log(bot, `Low health (${Math.round(bot.health ?? 0)}/20): eating and waiting to recover.`);
    const deadline = Date.now() + 18000;
    while (!bot.interrupt_code
        && Date.now() < deadline
        && Number(bot.health ?? 20) < targetHealth) {
        if (Number(bot.food ?? 20) <= 18) {
            try { await bot.autoEat?.eat?.(); } catch { /* no edible food right now */ }
            if (stopEarly()) return !bot.interrupt_code;
        }
        const nearbyHostile = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), 10);
        if (nearbyHostile) {
            try { await avoidEnemies(bot, 24); } catch { /* keep waiting */ }
            if (stopEarly()) return !bot.interrupt_code;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return Number(bot.health ?? 20) > startingHealth || Number(bot.health ?? 20) >= targetHealth;
}

function cropAge(block) {
    return Number(block?.getProperties?.().age ?? block?._properties?.age ?? block?.metadata ?? -1);
}

function ripeFoodCrop(block) {
    return Number.isFinite(FOOD_CROP_MATURITY[block?.name])
        && cropAge(block) >= FOOD_CROP_MATURITY[block.name];
}

async function harvestNearbyFoodCrops(bot) {
    let harvested = false;
    for (const crop of Object.keys(FOOD_CROP_MATURITY)) {
        if (bot.interrupt_code) break;
        const nearby = world.getNearestBlocks(bot, crop, 64, 64);
        if (!nearby.some(ripeFoodCrop)) continue;
        const immature = nearby
            .filter(block => !ripeFoodCrop(block))
            .map(block => block.position);
        try {
            harvested = (await collectBlock(bot, crop, 2, immature)) || harvested;
            if (harvested) await pickupNearbyItems(bot);
        } catch { /* another crop or animal may still be available */ }
        if (edibleFoodCount(bot) >= 3) break;
    }
    if (harvested) {
        try { await prepareEmergencyFood(bot, 3, { pullFromStorage: false }); } catch { /* edible crops still help */ }
    }
    return harvested;
}

async function huntNearbyFoodAnimals(bot, { forceHunt = false } = {}) {
    for (const animal of ['cow', 'pig', 'chicken', 'sheep', 'rabbit']) {
        if (bot.interrupt_code) break;
        const urgent = forceHunt || needsFoodBeforeHealing(bot) || Number(bot.food ?? 20) <= 6;
        const huntRange = urgent ? 48 : 24;
        const adults = Object.values(bot.entities ?? {})
            .filter(entity => entity?.name === animal
                && entity.position
                && entity.isValid !== false
                && !mc.isBabyEntity(entity, bot)
                && entity.position.distanceTo(bot.entity.position) < huntRange)
            .sort((left, right) =>
                left.position.distanceTo(bot.entity.position)
                - right.position.distanceTo(bot.entity.position));
        // Keep a breeding pair in ordinary conditions; food recovery may use one.
        if (adults.length >= (urgent ? 1 : 3)) {
            try { await attackEntity(bot, adults[0], true); } catch { /* try another food source */ }
            await pickupNearbyItems(bot);
            return true;
        }
    }
    return false;
}

async function scoutForFood(bot) {
    if (bot.interrupt_code || !bot.entity?.position) return false;
    const home = base.getBase(bot) ?? bot.entity.position;
    const directions = [
        [1, 0], [0, 1], [-1, 0], [0, -1],
        [1, 1], [-1, 1], [-1, -1], [1, -1],
    ];
    const index = Number(bot._foodScoutIndex ?? 0) % directions.length;
    bot._foodScoutIndex = index + 1;
    const [x, z] = directions[index];
    const distance = 28;
    const target = {
        x: home.x + x * distance,
        y: home.y,
        z: home.z + z * distance,
    };
    log(bot, 'V bližini ni hrane; iščem naslednje območje za hrano.');
    try {
        return await goToPosition(bot, target.x, target.y, target.z, 4);
    } catch {
        return false;
    }
}

export async function secureFood(bot, { pullFromStorage = true, forceHunt = false } = {}) {
    const startingFood = Number(bot?.food ?? 20);
    if (invCount(bot, FOOD) >= 4) return true;
    try { await prepareEmergencyFood(bot, 6, { pullFromStorage }); } catch { /* continue to farm/hunt */ }
    await eatIfHungry(bot);
    if (invCount(bot, FOOD) >= 3 || edibleFoodCount(bot) >= 3) return true;
    // Harvest our own wheat farm before hunting: bread needs no furnace, so this feeds
    // the bot even when the server's furnace GUI is broken and there are no huntable
    // animals nearby. No-op when nothing is ripe — then we fall through to hunting.
    try { await farming.harvestForFood(bot); } catch { /* fall through to hunting */ }
    if (invCount(bot, FOOD) >= 3) return true;
    await harvestNearbyFoodCrops(bot);
    if (invCount(bot, FOOD) >= 3 || edibleFoodCount(bot) >= 3) return true;
    log(bot, 'Grem po hrano...');
    // Cook food already carried before killing another animal.
    try { await prepareEmergencyFood(bot, 3, { pullFromStorage: false }); } catch { /* try hunting fallback */ }
    if (invCount(bot, FOOD) >= 3) return true;
    await huntNearbyFoodAnimals(bot, { forceHunt });
    if (edibleFoodCount(bot) < 1 && !bot.interrupt_code && await scoutForFood(bot)) {
        await harvestNearbyFoodCrops(bot);
        if (edibleFoodCount(bot) < 1)
            await huntNearbyFoodAnimals(bot, { forceHunt });
    }
    // Cook whatever raw meat we got; safe raw food remains an emergency fallback.
    try { await prepareEmergencyFood(bot, 3, { pullFromStorage: false }); } catch { /* */ }
    await eatIfHungry(bot);
    return Number(bot.food ?? 20) > startingFood
        || invCount(bot, FOOD) > 0
        || edibleFoodCount(bot) > 0;
}

// ── Batch smelting (DETERMINISTIC_GAMEPLAY_PLAN Faza 7 "workstation queues", light) ──
// Raw materials worth processing at the base furnace. `reserve` stays raw:
// potatoes remain plantable so smelting never eats the farm's seed stock.
const SMELT_STOCK = [
    { name: 'raw_iron', reserve: 0 },
    { name: 'raw_gold', reserve: 0 },
    ...RAW_MEAT.map(name => ({ name, reserve: 0 })),
    { name: 'potato', reserve: 12 },
];

// How many carried items smeltStockpile would process right now.
export function smeltableStock(bot) {
    return SMELT_STOCK.reduce((sum, { name, reserve }) =>
        sum + Math.max(0, invCount(bot, name) - reserve), 0);
}

// Smelt carried raw ore + raw food into ingots/cooked food at the base furnace.
// With pullFromStorage (steward duty) it first collects raw ore parked in the
// public storage / base chest, so mined ore doesn't sit unprocessed in chests.
export async function smeltStockpile(bot, { pullFromStorage = false, minBatch = 2 } = {}) {
    if (pullFromStorage && smeltableStock(bot) < minBatch) {
        await base.takeNeeded(bot, { raw_iron: 24, raw_gold: 16, coal: 8 });
        if (storage.getPublicStorage(bot)) {
            await storage.withdrawPublicMatching(
                bot,
                item => mc.stackMatchesAnyName(item, COOKABLE_FOOD, bot),
                24,
                ['food'],
            );
        }
    }
    if (smeltableStock(bot) < minBatch) return false;

    if (!mc.getSmeltingFuel(bot)) {
        await base.takeNeeded(bot, { coal: 6 });
        if (!mc.getSmeltingFuel(bot)) { log(bot, 'Za peč nimam goriva (premog ali les).'); return false; }
    }

    // Work at the base furnace; smeltItem would otherwise scatter single-use furnaces.
    const furnaceReachable = () =>
        world.getNearestBlock(bot, 'furnace', 16) || (world.getInventoryCounts(bot).furnace ?? 0) > 0;
    if (!furnaceReachable() && base.getPersonalAnchor(bot)) await base.goPersonalAnchor(bot);
    if (!furnaceReachable()) { log(bot, 'Nikjer ni peči, pa tudi s sabo je nimam.'); return false; }

    let smeltedAny = false;
    let budget = 24; // furnace time is ~10 s/item; keep one run inside the brain action timeout
    for (const { name, reserve } of SMELT_STOCK) {
        if (bot.interrupt_code || budget <= 0) break;
        const amount = Math.min(invCount(bot, name) - reserve, budget, 16);
        if (amount <= 0) continue;
        const before = invCount(bot, name);
        try { await smeltItem(bot, name, amount); } catch { /* judged by progress below */ }
        const smelted = before - invCount(bot, name);
        if (smelted <= 0) break; // furnace busy/unfueled/unreachable — retry next cycle
        smeltedAny = true;
        budget -= smelted;
    }
    return smeltedAny;
}

// --- Farming ---
export const plantFarm = farming.plantFarm;
export const harvestFarm = farming.harvestFarm;
export const tendFarm = farming.tendFarm;

// Replace broken or near-worn tools (pickaxe/axe/sword) with a fresh stone one.
export async function maintainTools(bot) {
    const inventory = world.getInventoryCounts(bot);
    const preferredTier = (
        PICKS.some(n => n.startsWith('diamond_') && (inventory[n] ?? 0) > 0)
        || AXES.some(n => n.startsWith('diamond_') && (inventory[n] ?? 0) > 0)
        || SWORDS.some(n => n.startsWith('diamond_') && (inventory[n] ?? 0) > 0)
        || (inventory.diamond ?? 0) >= 3
    ) ? 'diamond' : (
        PICKS.some(n => n.startsWith('iron_') && (inventory[n] ?? 0) > 0)
        || AXES.some(n => n.startsWith('iron_') && (inventory[n] ?? 0) > 0)
        || SWORDS.some(n => n.startsWith('iron_') && (inventory[n] ?? 0) > 0)
        || (inventory.iron_ingot ?? 0) >= 3
    ) ? 'iron' : 'stone';

    const tiers = preferredTier === 'diamond'
        ? ['diamond', 'iron', 'stone']
        : preferredTier === 'iron' ? ['iron', 'stone'] : ['stone'];
    const obtainReplacement = async kind => {
        if (bot.interrupt_code) return false;
        for (const tier of tiers) {
            const material = tier === 'diamond' ? 'diamond' : tier === 'iron' ? 'iron_ingot' : 'cobblestone';
            const amount = kind === 'sword' ? 2 : 3;
            if (tier !== 'stone' && (world.getInventoryCounts(bot)[material] ?? 0) < amount) {
                if (base.getPersonalAnchor(bot)) await base.takeNeeded(bot, { [material]: amount });
                if ((world.getInventoryCounts(bot)[material] ?? 0) < amount) continue;
            }
            if (await obtainTool(bot, `${tier}_${kind}`)) return true;
        }
        if (await takeSharedTool(bot, kind, ['netherite', 'diamond', 'iron', 'stone'])) return true;
        return false;
    };

    bot._maintainToolRetry ??= {};
    const now = Date.now();
    const needs = [];
    for (const [kind, tools] of [['pickaxe', PICKS], ['axe', AXES], ['sword', SWORDS]]) {
        if (bot.interrupt_code) break;
        const held = bot.inventory.items().find(i => tools.includes(i.name));
        if (!held) {
            needs.push({ kind, worn: false });
            continue;
        }
        const max = bot.registry.items[held.type]?.maxDurability;
        if (max) {
            const left = max - (held.durabilityUsed ?? 0);
            if (left <= max * 0.1) {
                needs.push({ kind, worn: true, tier: held.name.split('_')[0], name: held.name });
            }
        }
    }
    for (const need of needs) {
        if ((bot._maintainToolRetry[need.kind] ?? 0) > now) continue;
        if (need.worn)
            log(bot, `${need.name} je skoraj obrabljen, naredim novega.`);
        else
            log(bot, `Manjka mi ${need.kind}, naredim nadomestnega.`);
        const ok = need.worn
            ? (await obtainTool(bot, `${need.tier}_${need.kind}`) || await obtainReplacement(need.kind))
            : await obtainReplacement(need.kind);
        bot._maintainToolRetry[need.kind] = ok ? 0 : Date.now() + 60_000;
        return ok;
    }
    return needs.length === 0;
}

export function hasObsoleteWoodenEquipment(bot) {
    return bot.inventory.items().some(item => OBSOLETE_WOODEN_EQUIPMENT.includes(item.name));
}

async function destroyInventoryItem(bot, itemName) {
    const before = invCount(bot, itemName);
    if (before === 0) return 0;
    bot.chat(`/clear @s minecraft:${itemName}`);
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && invCount(bot, itemName) >= before)
        await new Promise(resolve => setTimeout(resolve, 100));
    let removed = before - invCount(bot, itemName);

    // Fallback for servers where the bot lacks /clear permission.
    for (const item of bot.inventory.items().filter(stack => stack.name === itemName)) {
        removed += await tossItemSafely(bot, item, item.count);
    }
    return removed;
}

export async function discardObsoleteWoodenEquipment(bot, includePublic = false) {
    if (includePublic && storage.getPublicStorage(bot))
        await storage.withdrawPublicMatching(
            bot,
            item => OBSOLETE_WOODEN_EQUIPMENT.includes(item.name),
            32,
        );

    let removed = 0;
    for (const itemName of OBSOLETE_WOODEN_EQUIPMENT) {
        if (bot.interrupt_code) break;
        removed += await destroyInventoryItem(bot, itemName);
    }
    if (removed > 0)
        log(bot, `Odstranil sem ${removed} zastarelih lesenih kosov opreme.`);
    return removed > 0;
}

// Take a scouting trip away from base and back, grabbing exposed ore on the way.
export async function explore(bot, home) {
    const cx = home ? home.x : bot.entity.position.x;
    const cy = home ? home.y : bot.entity.position.y;
    const cz = home ? home.z : bot.entity.position.z;
    const angle = Math.random() * Math.PI * 2;
    const dist = 12 + Math.random() * 13; // 12-25 blocks — a short scout, stays near base
    const tx = Math.floor(cx + Math.cos(angle) * dist);
    const tz = Math.floor(cz + Math.sin(angle) * dist);
    log(bot, 'Grem malo raziskat okolico.');
    let reached = false;
    try { reached = await goToPosition(bot, tx, cy, tz, 3); } catch { /* */ }
    if (!reached) return false;
    await grabNearbyOres(bot);
    await pickupNearbyItems(bot);
    try { return await goToPosition(bot, cx, cy, cz, 6); } catch { return false; }
}

export { invCount, FOOD };
