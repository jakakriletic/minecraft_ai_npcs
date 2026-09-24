import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../settings.js";
import { serverProxy } from '../mindserver_proxy.js';
import { acquireContainerLock, withContainerLock } from './container_lock.js';
import { isNaturalResourceCandidate, isStructureBreakProtected } from './resource_guard.js';
import { looksLiving } from './npc_defense.js';
import {
    NavigationGoalBackoffError,
    clearNavigationGoalFailure,
    getNavigationGoalBackoff,
    isRetryableNavigationError,
    navigateWithWatchdog,
    recordNavigationGoalFailure,
} from '../../utils/navigation.js';

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;
const NAV_TIMEOUT_MS = Math.max(10000, (settings.navigation_timeout_seconds ?? 45) * 1000);
const NAV_STALL_MS = Math.max(4000, (settings.navigation_stall_seconds ?? 9) * 1000);
const NAV_NO_PROGRESS_MS = Math.max(NAV_STALL_MS * 2,
    (settings.navigation_no_progress_seconds ?? 25) * 1000);
const COLLECT_TIMEOUT_MS = Math.max(10000, (settings.collect_timeout_seconds ?? 40) * 1000);
// Below this health the bot stops fighting and flees (cowardice/self_defense read it
// via canFightAtCurrentHealth). Was 3 (1.5 hearts) — they fought to the brink of death
// with no margin to escape and regen, so they just died. 6 (3 hearts) makes them break
// off early enough to run, let hunger-fed regen top them back up, then re-engage.
// Designated guardians keep the old grit via bot._guardianCombatExempt.
const LOW_HEALTH_COMBAT_THRESHOLD = 14;
const DEFAULT_PHYSICS_GRAVITY = 0.08;
const protectedMovementInstances = new WeakSet();
const AIR_LIKE_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const BOAT_ITEM_CANDIDATES = [
    'boat',
    'oak_boat',
    'spruce_boat',
    'birch_boat',
    'jungle_boat',
    'acacia_boat',
    'dark_oak_boat',
];
const NEVER_CONSUME_ITEMS = new Set(['wheat', 'wheat_seeds', 'cake']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const INVENTORY_RETRY_ATTEMPTS = 3;
const INVENTORY_RETRY_DELAY_MS = 250;

function isPassableNudgeBlock(block) {
    if (!block) return false;
    if (['water', 'flowing_water', 'lava', 'flowing_lava'].includes(block.name)) return false;
    return AIR_LIKE_BLOCKS.has(block.name)
        || block.boundingBox === 'empty'
        || (Array.isArray(block.shapes) && block.shapes.length === 0);
}

function isSoftNudgeObstacle(block) {
    return Boolean(block?.name && (
        block.name.endsWith('_leaves')
        || block.name.includes('vine')
        || ['cobweb', 'short_grass', 'tall_grass', 'tallgrass', 'fern', 'large_fern'].includes(block.name)
    ));
}

// A* can report "No path" when the bot is standing on foliage, a corpse/modded
// collision box, or the edge of a one-block pocket. Retrying the same goal from the
// exact same coordinates only creates a fast failure loop. Make one short, locally
// validated player-like step and let the normal planner retry from a new node.
async function nudgeAfterNavigationFailure(bot, target) {
    if (!bot?.entity || Date.now() < (bot._navigationNudgeRetryAt ?? 0)) return false;
    const inLiquid = ['water', 'flowing_water', 'lava', 'flowing_lava']
        .includes(bot.blockAt(bot.entity.position)?.name);
    if (inLiquid) return false; // self_preservation owns liquid escape

    bot._navigationNudgeRetryAt = Date.now() + 3000;
    const origin = bot.entity.position.floored();
    const towardX = Number(target?.x ?? origin.x) - origin.x;
    const towardZ = Number(target?.z ?? origin.z) - origin.z;
    const directions = [
        { x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 },
    ].sort((left, right) =>
        (right.x * towardX + right.z * towardZ) - (left.x * towardX + left.z * towardZ));

    for (const direction of directions) {
        let feet = bot.blockAt(origin.offset(direction.x, 0, direction.z), false);
        let head = bot.blockAt(origin.offset(direction.x, 1, direction.z), false);
        // A common modded-world trap is spawning inside/against tree leaves. Clear
        // only soft foliage; never break a wall, chest, build, or unknown mod block.
        for (const obstacle of [feet, head]) {
            if (!isSoftNudgeObstacle(obstacle)) continue;
            try { await bot.dig(obstacle, true); } catch { /* try another direction */ }
        }
        feet = bot.blockAt(origin.offset(direction.x, 0, direction.z), false);
        head = bot.blockAt(origin.offset(direction.x, 1, direction.z), false);
        if (!isPassableNudgeBlock(feet) || !isPassableNudgeBlock(head)) continue;

        // Permit a normal two/three-block drop off a leaf canopy or small ledge.
        // Pathfinder sometimes refuses the starting node even though a player can
        // safely step down. Liquids and drops deeper than three remain forbidden.
        let drop = 1;
        let floor = null;
        for (; drop <= 3; drop++) {
            floor = bot.blockAt(origin.offset(direction.x, -drop, direction.z), false);
            if (floor && !isPassableNudgeBlock(floor)) break;
        }
        if (!floor || drop > 3
            || ['water', 'flowing_water', 'lava', 'flowing_lava'].includes(floor.name)) continue;

        const before = bot.entity.position.clone();
        stopPathingQuietly(bot);
        try {
            await bot.lookAt(origin.offset(direction.x, 1, direction.z), true);
            bot.setControlState('forward', true);
            if (drop === 1) bot.setControlState('jump', true);
            await sleep(drop === 1 ? 700 : 900);
        } catch { /* entity may disconnect mid-nudge */ }
        finally {
            bot.setControlState('forward', false);
            bot.setControlState('jump', false);
        }
        if (bot.entity?.position?.distanceTo(before) > 0.35) {
            log(bot, 'Navigation was blocked; stepped to a neighbouring safe block and replanning.');
            return true;
        }
    }
    return false;
}

function closeWindowQuietly(bot, win) {
    if (typeof win?.close === 'function') {
        try {
            const closing = win.close();
            if (closing?.catch) void closing.catch(() => {});
            return;
        } catch { /* fall back to bot.closeWindow */ }
    }
    try { bot.closeWindow(win); } catch { /* already closed or disconnected */ }
}

async function closeCurrentWindowQuietly(bot) {
    const current = bot.currentWindow;
    if (current && current !== bot.inventory) {
        closeWindowQuietly(bot, current);
        await sleep(120);
    }
}

function isRetryableInventoryError(error) {
    const message = String(error?.message ?? error ?? '').toLowerCase();
    return message.includes('server rejected transaction')
        || message.includes('transaction')
        || message.includes('windowopen')
        || message.includes('window with id');
}

async function settleInventory(bot, attempt = 0) {
    try { bot.deactivateItem?.(); } catch { /* not using an item */ }
    await closeCurrentWindowQuietly(bot);
    await sleep(INVENTORY_RETRY_DELAY_MS * (attempt + 1));
}

function stackMatchesItem(stack, item) {
    return Boolean(stack && item && stack.type === item.type
        && (item.metadata == null || item.metadata < 0 || stack.metadata === item.metadata));
}

function equippedStack(bot, destination) {
    if (destination === 'hand') return bot.heldItem;
    const slots = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 };
    const slot = slots[destination];
    return Number.isInteger(slot) ? bot.inventory.slots[slot] : null;
}

function isConsumableStack(bot, item) {
    return Boolean(item && !NEVER_CONSUME_ITEMS.has(item.name)
        && bot.registry?.foodsByName?.[item.name]);
}

export async function equipItemSafely(bot, item, destination = 'hand') {
    if (!item) return false;
    let lastError = null;
    for (let attempt = 0; attempt < INVENTORY_RETRY_ATTEMPTS && !bot.interrupt_code; attempt++) {
        try {
            await closeCurrentWindowQuietly(bot);
            await bot.equip(item, destination);
            await sleep(100);
            return true;
        } catch (error) {
            lastError = error;
            await settleInventory(bot, attempt);
            if (stackMatchesItem(equippedStack(bot, destination), item)) return true;
            if (!isRetryableInventoryError(error)) break;
        }
    }
    if (bot.interrupt_code && !lastError) return false;
    console.warn(`[inventory ${bot.username}] equip ${item.name} -> ${destination} failed: ${lastError?.message ?? lastError}`);
    return false;
}

export async function unequipItemSafely(bot, destination = 'hand') {
    let lastError = null;
    for (let attempt = 0; attempt < INVENTORY_RETRY_ATTEMPTS && !bot.interrupt_code; attempt++) {
        try {
            await closeCurrentWindowQuietly(bot);
            await bot.unequip(destination);
            await sleep(100);
            return true;
        } catch (error) {
            lastError = error;
            await settleInventory(bot, attempt);
            if (!equippedStack(bot, destination)) return true;
            if (!isRetryableInventoryError(error)) break;
        }
    }
    if (bot.interrupt_code && !lastError) return false;
    console.warn(`[inventory ${bot.username}] unequip ${destination} failed: ${lastError?.message ?? lastError}`);
    return false;
}

export async function tossItemSafely(bot, item, count) {
    if (!item || count <= 0) return 0;
    let lastError = null;
    for (let attempt = 0; attempt < INVENTORY_RETRY_ATTEMPTS && !bot.interrupt_code; attempt++) {
        const before = bot.inventory.count(item.type, item.metadata);
        const toToss = Math.min(count, before);
        if (toToss <= 0) return 0;
        try {
            await closeCurrentWindowQuietly(bot);
            await bot.toss(item.type, item.metadata, toToss);
            await sleep(100);
            return toToss;
        } catch (error) {
            lastError = error;
            await settleInventory(bot, attempt);
            const removed = Math.max(0, before - bot.inventory.count(item.type, item.metadata));
            if (removed > 0) return removed;
            if (!isRetryableInventoryError(error)) break;
        }
    }
    if (bot.interrupt_code && !lastError) return 0;
    console.warn(`[inventory ${bot.username}] toss ${count}x ${item.name} failed: ${lastError?.message ?? lastError}`);
    return 0;
}

function stopDiggingQuietly(bot) {
    try {
        const stoppingDig = bot.stopDigging?.();
        if (stoppingDig?.catch) void stoppingDig.catch(() => {});
    } catch { /* disconnected or not digging */ }
}

function stopPathingQuietly(bot) {
    let hadCollectTargets = false;
    try {
        hadCollectTargets = bot.collectBlock?.targets && !bot.collectBlock.targets.empty;
        bot.collectBlock?.targets?.clear?.();
    } catch { /* disconnected */ }
    try { bot.pathfinder?.setGoal?.(null); } catch { /* disconnected */ }
    try { bot.pathfinder?.stop?.(); } catch { /* disconnected */ }
    stopDiggingQuietly(bot);
    if (hadCollectTargets) {
        try { queueMicrotask(() => bot.emit('collectBlock_finished')); } catch { /* disconnected */ }
    }
}

export function canFightAtCurrentHealth(bot) {
    return bot?._guardianCombatExempt === true
        || Number(bot?.health ?? 20) >= LOW_HEALTH_COMBAT_THRESHOLD;
}

function stopLowHealthCombat(bot) {
    if (canFightAtCurrentHealth(bot)) return false;
    try { bot.pvp?.stop?.(); } catch { /* disconnected */ }
    try { bot.deactivateItem?.(); } catch { /* disconnected */ }
    return true;
}

function protectedPlayerNames(bot) {
    const names = new Set([String(bot?.username ?? '').toLowerCase()]);
    if (settings.owner_player) names.add(String(settings.owner_player).toLowerCase());
    try {
        for (const entry of serverProxy.getAgents()) {
            const name = typeof entry === 'string' ? entry : entry?.name;
            if (name) names.add(String(name).toLowerCase());
        }
    } catch { /* mindserver may still be connecting */ }
    return names;
}

export function isProtectedPlayerTarget(bot, entity) {
    if (entity?.type !== 'player' || !entity.username) return false;
    const username = String(entity.username).toLowerCase();
    if (protectedPlayerNames(bot).has(username)) return true;
    return Boolean(bot.players?.[entity.username]);
}

function finishCreativeFlight(bot) {
    if (bot._creativeBuildFlying === true) {
        try { bot.creative?.stopFlying(); } catch { /* not flying */ }
    };
    bot._creativeBuildFlying = false;
    const gravity = Number(bot.physics?.gravity);
    if (bot.physics && (!Number.isFinite(gravity) || gravity <= 0))
        bot.physics.gravity = DEFAULT_PHYSICS_GRAVITY;
}

function protectStructures(bot, movements) {
    if (!movements || protectedMovementInstances.has(movements)) return movements;
    movements.exclusionAreasBreak.push(block =>
        isStructureBreakProtected(bot, block.position) ? 100 : 0);
    protectedMovementInstances.add(movements);
    return movements;
}

function makeMovementNonDestructive(movements) {
    if (!movements) return movements;
    // Navigation is transportation, not construction. Mineflayer otherwise
    // consumes dirt/cobblestone to bridge gaps and build 1x1 towers, leaving
    // permanent debris whenever a path is interrupted.
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.scafoldingBlocks = [];
    return movements;
}

function createMovements(bot) {
    const movements = protectStructures(bot, new pf.Movements(bot));
    makeMovementNonDestructive(movements);
    // Pathfinder can swim, but water exits are still one of its weak spots.
    // Prefer dry routes and never treat a deep water drop as a free shortcut.
    movements.liquidCost = 25;
    movements.infiniteLiquidDropdownDistance = false;
    movements.maxDropDown = Math.min(movements.maxDropDown, 3);
    // Ten NPCs frequently share doors, paths and utility blocks. A higher entity
    // cost makes A* prefer an open neighbouring lane instead of all agents trying
    // to occupy the same node and repeatedly pushing one another back.
    movements.entityCost = 4;
    return movements;
}

function createDryEscapeMovements(bot) {
    const movements = createMovements(bot);
    // Fleeing from a mob must not choose a lake/river as the cheapest open lane.
    // When already swimming, escapeWater owns movement and needs liquid enabled.
    if (!isBotInWater(bot)) {
        for (const id of mc.registryBlockIds(bot, ['water', 'flowing_water', 'lava', 'flowing_lava']))
            movements.blocksToAvoid.add(id);
        movements.liquidCost = 100;
    }
    return movements;
}

function createTravelMovements(bot) {
    // Fallback navigation must be able to dig and bridge like a real player.
    // With canDig=false everywhere, a bot inside any pit or cave had literally
    // no legal move, A* returned an empty path and the bot froze at the spot
    // forever (the goHome loop of 2026-07-02). High dig/place costs still make
    // it strongly prefer walking around obstacles over tunneling through them.
    const movements = protectStructures(bot, new pf.Movements(bot));
    movements.liquidCost = 25;
    movements.infiniteLiquidDropdownDistance = false;
    movements.maxDropDown = Math.min(movements.maxDropDown, 3);
    movements.digCost = 12;
    movements.placeCost = 3;
    movements.entityCost = 4;
    return movements;
}

export function installSafeMovements(bot) {
    // Bots MUST be able to dig, jump (parkour) and bridge to gather resources and
    // traverse real terrain. The earlier "non-destructive" navigation disabled all
    // of that, so collectBlock could never reach trees/ore — bots gathered nothing,
    // never left bootstrap, and just pathed around. Keep movements near mineflayer
    // defaults; only protect registered buildings so pathing won't tear through one.
    const movements = protectStructures(bot, new pf.Movements(bot));
    movements.liquidCost = 20;                        // prefer dry routes, but don't forbid water
    movements.infiniteLiquidDropdownDistance = false;
    bot.pathfinder?.setMovements?.(movements);
    if (bot.pathfinder) {
        // Bound pathfinding cost: home-leashed bots never path far (explore 12-25, mining
        // ~20-40, roads in-settlement), so cap A* well above any real route. An unreachable
        // goal then fails fast (stuck/stranded watchdogs recover) instead of burning CPU on
        // an unbounded search across loaded chunks — the dominant cost with 10 bots.
        bot.pathfinder.searchRadius = 128;            // default -1 (unlimited)
        bot.pathfinder.thinkTimeout = 3000;           // crowded/modded terrain needs enough time to find a real route
    }
    if (bot.collectBlock)
        bot.collectBlock.movements = protectStructures(bot, new pf.Movements(bot));
    return movements;
}

function goalDistance(bot, goal) {
    const target = goal?.entity?.position ??
        (Number.isFinite(goal?.x) && Number.isFinite(goal?.y) && Number.isFinite(goal?.z)
            ? new Vec3(goal.x, goal.y, goal.z)
            : null);
    return target && bot.entity ? bot.entity.position.distanceTo(target) : 20;
}

async function gotoWithTimeout(bot, goal, timeoutMs = NAV_TIMEOUT_MS) {
    await navigateWithWatchdog(bot, goal, () => bot.pathfinder.goto(goal), {
        timeoutMs,
        stallMs: NAV_STALL_MS,
        noProgressMs: NAV_NO_PROGRESS_MS,
        attempt: bot._navigationAttempt,
        onAbort: () => stopPathingQuietly(bot),
    });
    return true;
}

async function collectWithTimeout(bot, block) {
    let timer;
    let interruptWatcher;
    const collection = bot.collectBlock.collect(block);
    // Promise.race may finish on interruption first. Keep the original collection
    // rejection handled while Mineflayer unwinds its internal collect state.
    void collection.catch(() => {});
    try {
        await Promise.race([
            collection,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    stopPathingQuietly(bot);
                    reject(new Error(`Collecting ${block.name} timed out`));
                }, COLLECT_TIMEOUT_MS);
            }),
            new Promise((_, reject) => {
                interruptWatcher = setInterval(() => {
                    if (!bot.interrupt_code) return;
                    stopPathingQuietly(bot);
                    const error = new Error(`Collecting ${block.name} interrupted`);
                    error.name = 'ActionInterrupted';
                    reject(error);
                }, 50);
            }),
        ]);
        return true;
    } finally {
        clearTimeout(timer);
        clearInterval(interruptWatcher);
    }
}

export function log(bot, message) {
    bot.output += message + '\n';
}

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) {return false;}
    }
    return false;
}

async function equipHighestAttack(bot) {
    let weapons = bot.inventory.items().filter(item => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter(item => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return;
    weapons.sort((a, b) => b.attackDamage - a.attackDamage);
    let weapon = weapons[0];
    if (weapon)
        await equipItemSafely(bot, weapon, 'hand');
}

const SAFE_AUTO_CRAFT_INGREDIENTS = new Set([
    'stick',
    'crafting_table',
    'chest',
    'furnace',
    'bowl',
]);

function canAutoCraftIngredient(name) {
    // Resource compression recipes are reversible (ingot <-> nuggets/blocks).
    // Recursing through them makes a missing iron ingot bounce through unrelated
    // recipes instead of reporting that the raw resource is unavailable.
    return SAFE_AUTO_CRAFT_INGREDIENTS.has(name)
        || name.endsWith('_planks')
        || name === 'planks';
}

function recipeInputEntries(recipe, bot = null) {
    const inputs = new Map();
    for (const delta of recipe.delta ?? []) {
        if (!delta || delta.id < 0 || delta.count >= 0) continue;
        const baseName = mc.getItemName(delta.id) ?? String(delta.id);
        const aliases = mc.aliasesForLegacyStack(baseName, delta.metadata, bot);
        const key = `${delta.id}:${delta.metadata ?? 'any'}`;
        const existing = inputs.get(key) ?? {
            id: delta.id,
            metadata: delta.metadata ?? null,
            count: 0,
            name: aliases.find(alias => alias !== baseName) ?? baseName,
        };
        existing.count += -delta.count;
        inputs.set(key, existing);
    }
    return [...inputs.values()];
}

function recipeCraftCapacity(bot, recipe) {
    let capacity = Number.POSITIVE_INFINITY;
    let limitingResource = null;
    for (const input of recipeInputEntries(recipe, bot)) {
        const available = bot.inventory.count(input.id, input.metadata);
        const possible = Math.floor(available / input.count);
        if (possible < capacity) {
            capacity = possible;
            limitingResource = input.name;
        }
    }
    if (!Number.isFinite(capacity)) capacity = 0;
    return { count: Math.max(0, capacity), limitingResource };
}

function recipeMissingInputs(bot, recipe, craftCount) {
    return recipeInputEntries(recipe, bot)
        .map(input => {
            const available = bot.inventory.count(input.id, input.metadata);
            return {
                ...input,
                missing: Math.max(0, input.count * craftCount - available),
            };
        })
        .filter(input => input.missing > 0);
}

function recipesAllSafe(bot, itemId, metadata, craftingTable) {
    try {
        return bot.recipesAll(itemId, metadata ?? null, craftingTable).filter(Boolean);
    } catch {
        if (metadata == null) return [];
        try {
            return bot.recipesAll(itemId, null, craftingTable).filter(Boolean);
        } catch {
            return [];
        }
    }
}

function rankRecipesByInventory(bot, recipes) {
    return [...recipes].sort((a, b) => {
        const capA = recipeCraftCapacity(bot, a).count;
        const capB = recipeCraftCapacity(bot, b).count;
        return capB - capA
            || (b.result?.count ?? 1) - (a.result?.count ?? 1)
            || recipeMissingInputs(bot, a, 1).length - recipeMissingInputs(bot, b, 1).length;
    });
}

function bestCraftableRecipes(bot, recipes, requestedItems) {
    return rankRecipesByInventory(bot, recipes)
        .map(recipe => ({
            recipe,
            capacity: recipeCraftCapacity(bot, recipe),
            requestedCrafts: Math.max(1, Math.ceil(requestedItems / Math.max(1, recipe.result?.count ?? 1))),
        }))
        .filter(entry => entry.capacity.count > 0)
        .map(entry => ({
            recipe: entry.recipe,
            craftCount: Math.min(entry.capacity.count, entry.requestedCrafts),
            requestedCrafts: entry.requestedCrafts,
            limitingResource: entry.capacity.limitingResource,
        }));
}

async function closeCraftingWindow(bot) {
    const current = bot.currentWindow;
    if (current && current !== bot.inventory) {
        try { await current.close(); } catch {
            try { bot.closeWindow(current); } catch { /* already closed */ }
        }
    }
}

export async function craftRecipe(bot, itemName, num=1, _depth=0) {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * Missing ingredients that are themselves craftable (logs->planks->sticks)
     * are crafted automatically up to 3 levels deep.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    if (bot.interrupt_code) return false;
    let placedTable = false;
    const itemId = mc.getItemId(itemName, bot);
    const itemMetadata = mc.getItemMetadata(itemName, bot);
    const itemRecipes = mc.getItemCraftingRecipes(itemName);

    if (itemId == null || !itemRecipes?.length) {
        log(bot, `${itemName} is either not an item, or it does not have a crafting recipe!`);
        return false;
    }

    let craftingTable = null;
    const craftingTableRange = 16;
    const allRecipes = recipesAllSafe(bot, itemId, itemMetadata, true);

    const tryCraftFrom = async table => {
        const recipes = recipesAllSafe(bot, itemId, itemMetadata, table)
            .filter(recipe => !recipe.requiresTable || Boolean(table));
        const candidates = bestCraftableRecipes(bot, recipes, num);
        for (const candidate of candidates) {
            if (bot.interrupt_code) return false;
            const beforeCount = world.getInventoryCounts(bot)[itemName] ?? 0;
            try {
                await bot.craft(candidate.recipe, candidate.craftCount, table);
            } catch (error) {
                await closeCraftingWindow(bot);
                log(bot, `Craft ${itemName} ni uspel s tem receptom (${error.message}); poskusim drug recept.`);
                continue;
            }
            const afterCount = world.getInventoryCounts(bot)[itemName] ?? 0;
            const produced = Math.max(0, afterCount - beforeCount);
            if (produced <= 0) {
                log(bot, `Craft ${itemName} ni dal rezultata; poskusim drug recept.`);
                continue;
            }
            if (candidate.craftCount < candidate.requestedCrafts)
                log(bot, `Delno crafted ${produced}/${num} ${itemName}; manjka ${candidate.limitingResource}.`);
            else
                log(bot, `Crafted ${produced} ${itemName}; zdaj imam ${afterCount}.`);
            try { await bot.armorManager.equipAll(); } catch { /* armor manager optional */ }
            return true;
        }
        return false;
    };

    try {
        if (await tryCraftFrom(null)) return true;

        const tableRecipes = allRecipes.filter(recipe => recipe.requiresTable);
        if (tableRecipes.length > 0) {
            craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
            if (!craftingTable) {
                let hasTable = (world.getInventoryCounts(bot).crafting_table ?? 0) > 0;
                if (!hasTable && itemName !== 'crafting_table' && _depth < 4) {
                    await craftRecipe(bot, 'crafting_table', 1, _depth + 1);
                    hasTable = (world.getInventoryCounts(bot).crafting_table ?? 0) > 0;
                }
                if (hasTable) {
                    const pos = world.getNearestFreeSpace(bot, 1, 6);
                    if (!pos) {
                        log(bot, `Cannot place a crafting table: no safe free space nearby.`);
                        return false;
                    }
                    if (!await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z))
                        return false;
                    craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                    placedTable = Boolean(craftingTable);
                } else if (itemName !== 'crafting_table') {
                    log(bot, `Crafting ${itemName} requires a crafting table.`);
                    return false;
                }
            }
            if (craftingTable && bot.entity.position.distanceTo(craftingTable.position) > 4) {
                if (!await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange)) {
                    log(bot, `Could not reach the crafting table.`);
                    return false;
                }
                craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange) ?? craftingTable;
            }
            if (craftingTable && await tryCraftFrom(craftingTable)) return true;
        }

        if (_depth < 4 && !bot.interrupt_code) {
            for (const recipe of rankRecipesByInventory(bot, allRecipes)) {
                const recipeCrafts = Math.max(1, Math.ceil(num / Math.max(1, recipe.result?.count ?? 1)));
                const missing = recipeMissingInputs(bot, recipe, recipeCrafts);
                if (missing.length === 0) continue;
                let craftedSomething = false;
                let variantPossible = true;
                for (const input of missing) {
                    if (!canAutoCraftIngredient(input.name)
                        || !mc.getItemCraftingRecipes(input.name)?.length) {
                        variantPossible = false;
                        break;
                    }
                    log(bot, `Missing ${input.missing} ${input.name} for ${itemName}, crafting it first...`);
                    if (await craftRecipe(bot, input.name, input.missing, _depth + 1))
                        craftedSomething = true;
                    else {
                        variantPossible = false;
                        break;
                    }
                }
                if (variantPossible && craftedSomething)
                    return await craftRecipe(bot, itemName, num, _depth + 1);
            }
        }

        const fallback = rankRecipesByInventory(bot, allRecipes)[0];
        const fallbackCrafts = fallback
            ? Math.max(1, Math.ceil(num / Math.max(1, fallback.result?.count ?? 1)))
            : 1;
        const missing = fallback
            ? recipeMissingInputs(bot, fallback, fallbackCrafts)
                .map(input => `${input.name}: ${input.missing}`)
                .join(', ')
            : Object.entries(itemRecipes[0][0]).map(([key, value]) => `${key}: ${value}`).join(', ');
        log(bot, `You do not have the resources to craft ${itemName}. Missing: ${missing || 'unknown'}.`);
        return false;
    } finally {
        await closeCraftingWindow(bot);
        if (placedTable && craftingTable)
            await breakBlockAt(bot, craftingTable.position.x, craftingTable.position.y, craftingTable.position.z);
    }
}

// ===== Deterministic macro-skills =====
// High-level routines that chain many low-level actions in CODE, so a weak local
// model only has to pick the macro (e.g. !gearUp) — the whole craft/mine chain is
// deterministic and works regardless of model smarts.

const LOG_TYPES = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log'];
const PLANK_TYPES = LOG_TYPES.map(l => l.replace('_log', '_planks'));

function countOf(bot, names) {
    const inv = world.getInventoryCounts(bot);
    return (Array.isArray(names) ? names : [names]).reduce((s, n) => s + (inv[n] ?? 0), 0);
}

// Make sure we hold at least `n` logs (any species); finds and chops trees, wanders if none near.
export async function ensureLogs(bot, n) {
    for (let attempt = 0; attempt < 8 && countOf(bot, LOG_TYPES) < n && !bot.interrupt_code; attempt++) {
        const before = countOf(bot, LOG_TYPES);
        const trees = world.getNearestBlocks(bot, LOG_TYPES, 64, 1); // ID fast path
        if (trees.length === 0) { log(bot, 'Iščem drevesa...'); await moveAway(bot, 30); continue; }
        const need = n - before;
        await collectBlock(bot, trees[0].name, Math.min(need + 1, 8));
        if (countOf(bot, LOG_TYPES) <= before) await moveAway(bot, 15); // tree unreachable -> reposition
    }
    return countOf(bot, LOG_TYPES) >= n;
}

// Craft planks from whatever logs we have until we hold at least `n` planks.
export async function ensurePlanks(bot, n) {
    if (countOf(bot, PLANK_TYPES) >= n) return true;
    for (const logName of LOG_TYPES) {
        if (countOf(bot, PLANK_TYPES) >= n) break;
        if (countOf(bot, logName) <= 0) continue;
        const plank = logName.replace('_log', '_planks');
        await craftRecipe(bot, plank, n - countOf(bot, PLANK_TYPES));
    }
    return countOf(bot, PLANK_TYPES) >= n;
}

// Mine `n` cobblestone (requires a pickaxe; collectBlock auto-equips the best tool).
export async function ensureCobblestone(bot, n) {
    if (countOf(bot, 'cobblestone') >= n) return true;
    for (let attempt = 0; attempt < 6 && countOf(bot, 'cobblestone') < n && !bot.interrupt_code; attempt++) {
        const before = countOf(bot, 'cobblestone');
        const stones = world.getNearestBlocks(bot, ['stone', 'cobblestone'], 48, 1); // ID fast path
        if (stones.length === 0) { log(bot, 'Iščem kamen...'); await moveAway(bot, 20); continue; }
        await collectBlock(bot, 'stone', n - before);
        if (countOf(bot, 'cobblestone') <= before) await moveAway(bot, 12); // unreachable -> reposition
    }
    return countOf(bot, 'cobblestone') >= n;
}

const TOOL_SPECS = {
    wooden: { mat: PLANK_TYPES, matN: 3, stickN: 2 },
    stone: { mat: ['cobblestone'], matN: 3, stickN: 2 },
    iron: { mat: ['iron_ingot'], matN: 3, stickN: 2 },
    golden: { mat: ['gold_ingot'], matN: 3, stickN: 2 },
    diamond: { mat: ['diamond'], matN: 3, stickN: 2 },
};

// Obtain ONE specific tool by name (e.g. "stone_pickaxe", "iron_axe"), crafting the
// whole prerequisite chain deterministically. Returns true if the tool is in inventory.
export async function obtainTool(bot, toolName) {
    /**
     * Obtain a tool by crafting the full chain (logs->planks->sticks->table->tool, mining as needed).
     * @param {MinecraftBot} bot
     * @param {string} toolName e.g. "stone_pickaxe", "iron_axe", "wooden_sword"
     * @returns {Promise<boolean>} true if the tool ends up in inventory.
     * @example await skills.obtainTool(bot, "stone_pickaxe");
     **/
    if (countOf(bot, toolName) > 0) { log(bot, `${toolName} že imam.`); return true; }
    const tier = toolName.split('_')[0];
    const spec = TOOL_SPECS[tier];
    const headMaterialCount = toolName.endsWith('_shovel') ? 1
        : (toolName.endsWith('_sword') || toolName.endsWith('_hoe')) ? 2
            : 3;
    if (!spec) { log(bot, `Ne poznam orodja ${toolName}.`); return false; }

    // base materials: wood + sticks always needed
    await ensureLogs(bot, 2);
    await ensurePlanks(bot, 6);
    if (countOf(bot, 'crafting_table') < 1) await craftRecipe(bot, 'crafting_table', 1);
    if (countOf(bot, 'stick') < spec.stickN) await craftRecipe(bot, 'stick', Math.max(4, spec.stickN));

    // tier-specific head material
    if (tier === 'stone') {
        if (countOf(bot, 'wooden_pickaxe') < 1) await obtainTool(bot, 'wooden_pickaxe');
        await ensureCobblestone(bot, headMaterialCount);
    } else if (tier === 'iron') {
        if (countOf(bot, 'stone_pickaxe') < 1) await obtainTool(bot, 'stone_pickaxe');
        await ensureCobblestone(bot, 8);
        if (countOf(bot, 'iron_ore') + countOf(bot, 'raw_iron') + countOf(bot, 'iron_ingot') < headMaterialCount) {
            const ores = world.getNearestBlocks(bot, ['iron_ore', 'deepslate_iron_ore'], 48, 1); // ID fast path
            if (ores.length) await collectBlock(bot, ores[0].name, headMaterialCount);
        }
        if (countOf(bot, 'iron_ingot') < headMaterialCount && countOf(bot, 'raw_iron') > 0) {
            await smeltItem(bot, 'raw_iron', countOf(bot, 'raw_iron'));
        }
    }

    const ok = await craftRecipe(bot, toolName, 1);
    log(bot, ok && countOf(bot, toolName) > 0 ? `Naredil sem ${toolName}.` : `${toolName} mi (še) ni uspel.`);
    return countOf(bot, toolName) > 0;
}

// Get a full set of basic gear from scratch: wooden pickaxe -> stone pickaxe/axe/sword.
export async function gearUp(bot) {
    /**
     * Deterministically obtain basic gear from nothing: collects wood, crafts tools,
     * mines stone, upgrades to stone tools. Works even with a weak decision model.
     * @param {MinecraftBot} bot
     * @returns {Promise<boolean>} true if at least a stone pickaxe was obtained.
     * @example await skills.gearUp(bot);
     **/
    log(bot, 'Se opremim...');
    await ensureLogs(bot, 4);
    if (!await ensurePlanks(bot, 12)) { log(bot, 'Ne najdem lesa za opremo.'); return false; }
    if (countOf(bot, 'crafting_table') < 1) await craftRecipe(bot, 'crafting_table', 1);
    if (countOf(bot, 'stick') < 6) await craftRecipe(bot, 'stick', 6);

    if (countOf(bot, 'wooden_pickaxe') + countOf(bot, 'stone_pickaxe') < 1) await craftRecipe(bot, 'wooden_pickaxe', 1);
    await ensureCobblestone(bot, 11);
    for (const t of ['stone_pickaxe', 'stone_axe', 'stone_sword']) {
        if (countOf(bot, t) < 1) await craftRecipe(bot, t, 1);
        if (bot.interrupt_code) break;
    }
    await bot.armorManager.equipAll();
    const got = ['stone_pickaxe', 'stone_axe', 'stone_sword'].filter(t => countOf(bot, t) > 0);
    log(bot, got.length ? `Opremljen: ${got.join(', ')}.` : 'Opreme mi ni čisto uspelo sestaviti.');
    return countOf(bot, 'stone_pickaxe') > 0;
}

export async function wait(bot, milliseconds) {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    let startTime = Date.now();
    
    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;
        
        let waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        let elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}

// Some servers intermittently swallow the furnace GUI open. Mineflayer's
// openBlock waits for windowOpen without its own timeout, so bound each attempt and
// remove only the listeners it installed before retrying or falling back to other food.
export async function openFurnaceAttempt(bot, furnaceBlock, timeoutMs) {
    const beforeWindowListeners = new Set(bot.listeners('windowOpen'));
    const beforeErrorListeners = new Set(bot.listeners('error'));
    const opening = bot.openFurnace(furnaceBlock);
    const addedWindowListeners = bot.listeners('windowOpen')
        .filter(listener => !beforeWindowListeners.has(listener));
    const addedErrorListeners = bot.listeners('error')
        .filter(listener => !beforeErrorListeners.has(listener));
    let timer;
    let timedOut = false;
    try {
        return await Promise.race([
            opening,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    const error = new Error('furnace open timed out');
                    error.code = 'FURNACE_OPEN_TIMEOUT';
                    reject(error);
                }, timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
        if (timedOut) {
            // mineflayer's openBlock waits on events.once() without a timeout.
            // Remove only the listeners installed by this attempt so a dead GUI
            // cannot leak listeners or hijack a later, unrelated windowOpen.
            for (const listener of addedWindowListeners)
                bot.removeListener('windowOpen', listener);
            for (const listener of addedErrorListeners)
                bot.removeListener('error', listener);
            void opening.catch(() => {});
            const current = bot.currentWindow;
            if (current && current !== bot.inventory) {
                try { bot.closeWindow(current); } catch { /* window may already be closed */ }
            }
        }
    }
}

async function openFurnaceWithRetry(bot, furnaceBlock, attempts = 2, timeoutMs = 6000) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts && !bot.interrupt_code; attempt++) {
        await closeCurrentWindowQuietly(bot);
        const liveBlock = bot.blockAt(furnaceBlock.position);
        const block = liveBlock?.name?.includes('furnace') ? liveBlock : furnaceBlock;
        try {
            return await openFurnaceAttempt(bot, block, timeoutMs);
        } catch (error) {
            lastError = error;
            await settleInventory(bot, attempt);
            try {
                await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                await bot.lookAt(block.position);
            } catch { /* retry from where we stand */ }
            if (!isRetryableInventoryError(error) && !String(error?.message ?? '').includes('windowOpen'))
                break;
        }
    }
    throw lastError ?? new Error('Could not open furnace.');
}

export function furnaceHasActiveFuel(furnace) {
    return Boolean(furnace?.fuelItem?.())
        || Number(furnace?.fuelSeconds ?? 0) > 0
        || Number(furnace?.fuel ?? 0) > 0;
}

export async function smeltItem(bot, itemName, num=1, options = {}) {
    /**
     * Puts 1 coal in furnace and smelts the given item name, waits until the furnace runs out of fuel or input items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to smelt. Ores must contain "raw" like raw_iron.
     * @param {number} num, the number of items to smelt. Defaults to 1.
     * @param {{openAttempts?: number, openTimeoutMs?: number}} options, bounded furnace GUI retry settings.
     * @returns {Promise<boolean>} true if the item was smelted, false otherwise. Fail
     * @example
     * await skills.smeltItem(bot, "raw_iron");
     * await skills.smeltItem(bot, "beef");
     **/

    if (!mc.isSmeltable(itemName)) {
        log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
        return false;
    }

    let placedFurnace = false;
    let furnaceBlock;
    let furnace;
    const furnaceRange = 16;
    const itemId = mc.getItemId(itemName, bot);
    const itemMetadata = mc.getItemMetadata(itemName, bot);
    if (itemId == null) {
        log(bot, `Cannot smelt ${itemName}; item does not exist in Minecraft ${bot.version}.`);
        return false;
    }
    furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock) {
        // Try to place furnace
        const hasFurnace = (world.getInventoryCounts(bot).furnace ?? 0) > 0;
        if (hasFurnace) {
            const pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
            if (!pos) {
                log(bot, `There is no safe space nearby for a furnace.`);
                return false;
            }
            if (!await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z)) return false;
            furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
            placedFurnace = true;
        }
    }
    if (!furnaceBlock) {
        log(bot, `There is no furnace nearby and you have no furnace.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        if (!await goToPosition(bot, furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 3))
            return false;
    }
    bot.modes.pause('unstuck');
    await bot.lookAt(furnaceBlock.position);
    const releaseFurnace = await acquireContainerLock(bot, furnaceBlock, 5000);
    if (!releaseFurnace) {
        bot.modes.unpause('unstuck');
        log(bot, `The furnace is currently in use.`);
        return false;
    }

    let total = 0;
    let smelted_item = null;
    try {
        console.log('smelting...');
        try {
            furnace = await openFurnaceWithRetry(
                bot,
                furnaceBlock,
                Math.max(1, Number(options.openAttempts ?? 2)),
                Math.max(1000, Number(options.openTimeoutMs ?? 6000)),
            );
        } catch (openError) {
            log(bot, `Could not open the furnace (${openError.message}); giving up on smelting for now.`);
            return false;
        }
        const inputItem = furnace.inputItem();
        if (inputItem && inputItem.count > 0
            && (inputItem.type !== itemId
                || (itemMetadata != null && inputItem.metadata !== itemMetadata))) {
            log(bot, `The furnace is currently smelting ${mc.getItemName(inputItem.type)}.`);
            return false;
        }

        // A shared furnace can contain output left by an earlier bot. Collect it
        // before starting this batch so it is not counted as output from the new
        // input (which previously caused false "success" and returned raw food).
        if (furnace.outputItem()) {
            try { await furnace.takeOutput(); } catch {
                log(bot, 'The furnace output is full and cannot be cleared.');
                return false;
            }
        }

        if (!furnace.fuelItem() && furnace.fuelSeconds == null && furnace.fuel == null)
            await new Promise(resolve => setTimeout(resolve, 100));

        const available = (bot.inventory.slots ?? [])
            .filter(item => item && mc.stackMatchesName(item, itemName, bot))
            .reduce((sum, item) => sum + Number(item.count ?? 0), 0);
        const toSmelt = Math.min(num, available);
        if (toSmelt <= 0) {
            log(bot, `You do not have any ${itemName} to smelt.`);
            return false;
        }

        // The fuel slot becomes empty as soon as a piece of fuel starts burning.
        // fuelSeconds/fuel still report that active burn; do not require another
        // inventory fuel item while the furnace has enough fire left to continue.
        if (!furnaceHasActiveFuel(furnace)) {
            const fuel = mc.getSmeltingFuel(bot);
            if (!fuel) {
                log(bot, `You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.`);
                return false;
            }
            const putFuel = Math.ceil(toSmelt / mc.getFuelSmeltOutput(fuel.name));
            if (fuel.count < putFuel) {
                log(bot, `You don't have enough ${fuel.name} to smelt ${toSmelt} ${itemName}; you need ${putFuel}.`);
                return false;
            }
            await furnace.putFuel(fuel.type, fuel.metadata, putFuel);
            log(bot, `Added ${putFuel} ${fuel.name} to furnace fuel.`);
        }

        await furnace.putInput(itemId, itemMetadata, toSmelt);
        await new Promise(resolve => setTimeout(resolve, 250));
        let lastProgress = Date.now();
        while (total < toSmelt && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const output = furnace.outputItem();
            if (output) {
                smelted_item = await furnace.takeOutput();
                if (smelted_item) {
                    total += smelted_item.count;
                    lastProgress = Date.now();
                }
            }
            if (Date.now() - lastProgress > 13000) break;
        }

        // Return unfinished input to the bot so a later deterministic step can
        // resume instead of believing the resources disappeared.
        if (furnace.inputItem()) {
            try { await furnace.takeInput(); } catch { /* inventory may be full */ }
        }
    } finally {
        if (furnace) {
            try { await furnace.close(); } catch { /* disconnected */ }
        }
        await releaseFurnace();
        bot.modes.unpause('unstuck');
        if (placedFurnace && !bot.interrupt_code) {
            try {
                await breakBlockAt(bot, furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z);
                await pickupNearbyItems(bot);
            } catch { /* leave it placed */ }
        }
    }
    if (total === 0) {
        log(bot, `Failed to smelt ${itemName}.`);
        return false;
    }
    if (total < num) {
        log(bot, `Only smelted ${total} ${mc.getItemName(smelted_item.type)}.`);
        return false;
    }
    log(bot, `Successfully smelted ${itemName}, got ${total} ${mc.getItemName(smelted_item.type)}.`);
    return true;
}

export async function clearNearestFurnace(bot) {
    /**
     * Clears the nearest furnace of all items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the furnace was cleared, false otherwise.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    let furnaceBlock = world.getNearestBlock(bot, 'furnace', 32);
    if (!furnaceBlock) {
        log(bot, `No furnace nearby to clear.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        if (!await goToNearestBlock(bot, 'furnace', 4, 32))
            return false;
    }

    console.log('clearing furnace...');
    const releaseFurnace = await acquireContainerLock(bot, furnaceBlock, 5000);
    if (!releaseFurnace) {
        log(bot, `The furnace is currently in use.`);
        return false;
    }
    let furnace;
    let smelted_item, intput_item, fuel_item;
    try {
        furnace = await openFurnaceWithRetry(bot, furnaceBlock);
        if (furnace.outputItem())
            smelted_item = await furnace.takeOutput();
        if (furnace.inputItem())
            intput_item = await furnace.takeInput();
        if (furnace.fuelItem())
            fuel_item = await furnace.takeFuel();
    } finally {
        if (furnace) {
            try { await furnace.close(); } catch { /* disconnected */ }
        }
        await releaseFurnace();
    }
    let smelted_name = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
    let input_name = intput_item ? `${intput_item.count} ${intput_item.name}` : `0 input items`;
    let fuel_name = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
    log(bot, `Cleared furnace, received ${smelted_name}, ${input_name}, and ${fuel_name}.`);
    return true;

}


export async function attackNearest(bot, mobType, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    if (stopLowHealthCombat(bot)) {
        log(bot, 'Premalo zdravja za boj; najprej se moram pozdraviti.');
        return false;
    }
    bot.modes.pause('cowardice');
    if (mobType === 'drowned' || mobType === 'cod' || mobType === 'salmon' || mobType === 'tropical_fish' || mobType === 'squid')
        bot.modes.pause('self_preservation'); // so it can go underwater. TODO: have an drowning mode so we don't turn off all self_preservation
    const mob = world.getNearbyEntities(bot, 24).find(entity => entity.name === mobType);
    if (mob) {
        return await attackEntity(bot, mob, kill);
    }
    log(bot, 'Could not find any '+mobType+' to attack.');
    return false;
}

export async function attackEntity(bot, entity, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    if (!entity?.position) return false;
    // Servers reject attacks on items/orbs/arrows/self, and swinging at
    // an entity the server already removed wastes the whole engage. Last line of
    // defense for every attack path (npc_defense, guardians, hunting, culling).
    if (entity.id === bot.entity?.id || !looksLiving(bot, entity) || !bot.entities?.[entity.id]) {
        log(bot, 'Tega ne morem napasti.');
        return false;
    }
    if (isProtectedPlayerTarget(bot, entity)) {
        log(bot, `I will not attack player ${entity.username}.`);
        return false;
    }
    if (stopLowHealthCombat(bot)) {
        log(bot, 'Premalo zdravja za boj; najprej se moram pozdraviti.');
        return false;
    }
    let pos = entity.position;
    await equipHighestAttack(bot);

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...');
            if (!await goToPosition(bot, pos.x, pos.y, pos.z))
                return false;
        }
        if (stopLowHealthCombat(bot)) return false;
        console.log('attacking mob...');
        await bot.attack(entity);
        return true;
    }
    else {
        const deadline = Date.now() + 30000;
        let lowHealthStop = false;
        try {
            bot.pvp.attack(entity);
            while (Date.now() < deadline && world.getNearbyEntities(bot, 32).includes(entity)) {
                await new Promise(resolve => setTimeout(resolve, 500));
                if (stopLowHealthCombat(bot)) {
                    lowHealthStop = true;
                    break;
                }
                if (bot.interrupt_code)
                    return false;
            }
        } finally {
            bot.pvp.stop();
        }
        if (lowHealthStop) {
            log(bot, `Prekinil boj z ${entity.name}; zdravje je padlo pod 1.5 srca.`);
            return false;
        }
        if (world.getNearbyEntities(bot, 32).includes(entity)) {
            log(bot, `Stopped attacking ${entity.name}; target could not be reached.`);
            return false;
        }
        log(bot, `Successfully killed ${entity.name}.`);
        await pickupNearbyItems(bot);
        return true;
    }
}

export async function defendSelf(bot, range=9) {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    if (stopLowHealthCombat(bot)) {
        log(bot, 'Premalo zdravja za obrambo; umikam se iz boja.');
        return false;
    }
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let attacked = false;
    let lowHealthStop = false;
    const deadline = Date.now() + 30000;
    try {
        let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
        while (enemy && Date.now() < deadline && !bot.interrupt_code
            && canFightAtCurrentHealth(bot)) {
            await equipHighestAttack(bot);
            const distance = bot.entity.position.distanceTo(enemy.position);
            if (distance >= 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
                try {
                    await goToGoal(bot, new pf.goals.GoalFollow(enemy, 3.5), { timeoutMs: 6000 });
                } catch { /* entity may have died or moved */ }
            } else if (distance <= 2) {
                try {
                    const retreat = new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, 2));
                    await goToGoal(bot, retreat, { timeoutMs: 3000 });
                } catch { /* no retreat path */ }
            }
            if (stopLowHealthCombat(bot)) {
                lowHealthStop = true;
                break;
            }
            bot.pvp.attack(enemy);
            attacked = true;
            await new Promise(resolve => setTimeout(resolve, 500));
            enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
        }
        if (!canFightAtCurrentHealth(bot)) lowHealthStop = true;
    } finally {
        bot.pvp.stop();
        bot.modes.unpause('self_defense');
        bot.modes.unpause('cowardice');
    }
    if (lowHealthStop)
        log(bot, 'Prekinil obrambo; zdravje je prenizko za varen boj.');
    else if (attacked)
        log(bot, `Successfully defended self.`);
    else
        log(bot, `No enemies nearby to defend self from.`);
    return attacked && !lowHealthStop;
}



export async function collectBlock(bot, blockType, num=1, exclude=null) {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @returns {Promise<boolean>} true if the block was collected, false if the block type was not found.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (num < 1) {
        log(bot, `Invalid number of blocks to collect: ${num}.`);
        return false;
    }
    const oreName = blockType === 'lapis_lazuli' ? 'lapis_ore'
        : ['coal', 'copper', 'diamond', 'emerald', 'iron', 'gold', 'redstone'].includes(blockType)
            ? `${blockType}_ore` : blockType;
    let blocktypes = [...new Set([blockType, oreName])];
    if (oreName.endsWith('_ore') && !oreName.startsWith('deepslate_'))
        blocktypes.push(`deepslate_${oreName}`);
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    const isLiquid = blockType === 'lava' || blockType === 'water';

    let collected = 0;

    // Use full (near-default) movements + building protection so the bot can
    // actually reach and dig the target. Crippling these to "non-destructive"
    // (canDig/parkour/bridging off) made collectBlock unable to reach trees/ore —
    // every collect timed out, bots gathered nothing and got stuck in bootstrap.
    const movements = protectStructures(bot, new pf.Movements(bot));
    movements.dontCreateFlow = true;
    if (bot.collectBlock) {
        const collectMovements = protectStructures(bot, new pf.Movements(bot));
        collectMovements.dontCreateFlow = true;
        bot.collectBlock.movements = collectMovements;
    }

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks = ['obsidian'];

    const excluded = new Set((exclude ?? []).map(position => `${position.x},${position.y},${position.z}`));
    for (let i=0; i<num; i++) {
        const eligible = block => {
            if (excluded.has(`${block.position.x},${block.position.y},${block.position.z}`)) return false;
            if (isLiquid && block.metadata !== 0) return false;
            if (!isNaturalResourceCandidate(bot, block, blockType)) return false;
            return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
        };
        // findBlocks applies its count limit before our safety and exclusion
        // filters. Widen the search if the first page contains no usable block.
        let blocks = [];
        for (const limit of [64, 256, 1024]) {
            const candidates = world.getNearestBlocks(bot, blocktypes, 64, limit);
            blocks = candidates.filter(eligible);
            if (blocks.length || candidates.length < limit) break;
        }

        if (blocks.length === 0) {
            if (collected === 0)
                log(bot, `No ${blockType} nearby to collect.`);
            else
                log(bot, `No more ${blockType} nearby to collect.`);
            break;
        }
        const block = blocks[0];
        const blockKey = `${block.position.x},${block.position.y},${block.position.z}`;
        try {
            await bot.tool.equipForBlock(block);
        } catch (err) {
            log(bot, `Could not equip a tool for ${block.name}: ${err.message}.`);
            excluded.add(blockKey);
            continue;
        }
        if (isLiquid) {
            const bucket = mc.findInventoryItem(bot, 'bucket');
            if (!bucket) {
                log(bot, `Don't have bucket to harvest ${blockType}.`);
                return false;
            }
            if (!await equipItemSafely(bot, bucket, 'hand')) return false;
        }
        const itemId = bot.heldItem ? bot.heldItem.type : null;
        // Liquids are collected by using an empty bucket, not by harvesting the
        // block. Water/lava report canHarvest=false even when the bucket action works.
        if (!isLiquid && !block.canHarvest(itemId)) {
            log(bot, `Don't have right tools to harvest ${blockType}.`);
            return false;
        }
        try {
            let success = false;
            if (isLiquid) {
                success = await useToolOnBlock(bot, 'bucket', block);
            }
            else if (mc.mustCollectManually(blockType)) {
                await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                await bot.dig(block);
                await pickupNearbyItems(bot);
                success = true;
            }
            else {
                await collectWithTimeout(bot, block);
                const remaining = bot.blockAt(block.position);
                success = !remaining || remaining.name !== block.name;
            }
            if (success)
                collected++;
            await autoLight(bot);
        }
        catch (err) {
            if (err.name === 'ActionInterrupted') {
                break;
            }
            else if (err.name === 'NoChests') {
                log(bot, `Failed to collect ${blockType}: Inventory full, no place to deposit.`);
                break;
            }
            else {
                log(bot, `Failed to collect ${blockType}: ${err}.`);
                // Do not spend every remaining iteration recalculating a path to the
                // exact same unreachable block. Try another nearby resource instead.
                excluded.add(blockKey);
                continue;
            }
        }
        
        if (bot.interrupt_code)
            break;  
    }
    log(bot, `Collected ${collected} ${blockType}.`);
    return collected > 0;
}

export async function pickupNearbyItems(bot) {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
     **/
    const distance = 8;
    const getNearestItem = bot => bot.nearestEntity(entity => entity.name === 'item' && bot.entity.position.distanceTo(entity.position) < distance);
    const deadline = Date.now() + 12000;
    let nearestItem = getNearestItem(bot);
    let pickedUp = 0;
    while (nearestItem && Date.now() < deadline && pickedUp < 16 && !bot.interrupt_code) {
        let movements = createMovements(bot);
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        try {
            await goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 1), { timeoutMs: 5000, canDig: false });
        } catch {
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
        let prev = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            break;
        }
        pickedUp++;
    }
    log(bot, `Picked up ${pickedUp} items.`);
    return pickedUp > 0;
}


export async function breakBlockAt(bot, x, y, z) {
    /**
     * Break the block at the given position. Will use the bot's equipped item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true if the block was broken, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.x);
     **/
    if (x == null || y == null || z == null) throw new Error('Invalid position to break block at.');
    let block = bot.blockAt(Vec3(x, y, z));
    if (!block) {
        log(bot, `Cannot break block: target chunk is not loaded.`);
        return false;
    }
    if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        if (isStructureBreakProtected(bot, block.position)) {
            log(bot, `Ne lomim ${block.name} pri ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}; preblizu je zascitene strukture.`);
            return false;
        }
        if (bot.modes.isOn('cheat')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat(mc.setBlockCommand(Math.floor(x), Math.floor(y), Math.floor(z), 'air', bot));
            log(bot, `Used /setblock to break block at ${x}, ${y}, ${z}.`);
            return true;
        }

        if (bot.entity.position.distanceTo(block.position) > 4.5) {
            let pos = block.position;
            let movements = createMovements(bot);
            movements.canPlaceOn = false;
            movements.allow1by1towers = false;
            bot.pathfinder.setMovements(movements);
            await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
        }
        if (bot.game.gameMode !== 'creative') {
            try {
                await bot.tool.equipForBlock(block);
            } catch (err) {
                log(bot, `Could not equip a tool for ${block.name}: ${err.message}.`);
                return false;
            }
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (!block.canHarvest(itemId)) {
                log(bot, `Don't have right tools to break ${block.name}.`);
                return false;
            }
        }
        await bot.dig(block, true);
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
    }
    return true;
}


export async function placeBlock(bot, blockType, x, y, z, placeOn='bottom', dontCheat=false) {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string} placeOn, the preferred side of the block to place on. Can be 'top', 'bottom', 'north', 'south', 'east', 'west', or 'side'. Defaults to bottom. Will place on first available side if not possible.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true if the block was placed, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.x);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.x, 'side');
     **/
    const target_dest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));

    if (blockType === 'air') {
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        return await breakBlockAt(bot, x, y, z);
    }

    if (bot.modes.isOn('cheat') && !dontCheat) {
        if (bot.restrict_to_inventory) {
            let block = mc.findInventoryItem(bot, blockType);
            if (!block) {
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
                return false;
            }
        }

        // invert the facing direction
        let face = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
        bot.chat(mc.setBlockCommand(Math.floor(x), Math.floor(y), Math.floor(z), blockType, bot));
        if (blockType.includes('door')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat(mc.setBlockCommand(Math.floor(x), Math.floor(y + 1), Math.floor(z), `${blockType}[half=upper]`, bot));
        }
        if (mc.isBedBlock(blockType)) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat(mc.setBlockCommand(Math.floor(x), Math.floor(y), Math.floor(z - 1), `${blockType}[part=head]`, bot));
        }
        log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
        return true;
    }

    let item_name = mc.getItemSpec(blockType, bot).name;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    if (item_name === 'grass') item_name = 'dirt';
    let block_item = mc.findInventoryItem(bot, item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        const creativeItem = mc.makeItem(item_name, 1);
        if (creativeItem)
            await bot.creative.setInventorySlot(36, creativeItem); // 36 is first hotbar slot
        block_item = mc.findInventoryItem(bot, item_name);
    }
    if (!block_item) {
        log(bot, `Don't have any ${item_name} to place.`);
        return false;
    }

    const targetBlock = bot.blockAt(target_dest);
    if (!targetBlock) {
        log(bot, `Cannot place ${blockType}: target chunk is not loaded.`);
        return false;
    }
    if (mc.blockMatchesName(targetBlock, blockType, bot)
        || (mc.blockMatchesName(targetBlock, 'grass_block', bot) && blockType === 'dirt')) {
        log(bot, `${blockType} already at ${targetBlock.position}.`);
        return false;
    }
    const empty_blocks = ['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'tallgrass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for block to break
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock = null;
    let faceVec = null;
    const dir_map = {
        'top': Vec3(0, 1, 0),
        'bottom': Vec3(0, -1, 0),
        'north': Vec3(0, 0, -1),
        'south': Vec3(0, 0, 1),
        'east': Vec3(1, 0, 0),
        'west': Vec3(-1, 0, 0),
    };
    let dirs = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
    }
    dirs.push(...Object.values(dir_map).filter(d => !dirs.includes(d)));

    for (let d of dirs) {
        const block = bot.blockAt(target_dest.plus(d));
        if (block && !empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new Vec3(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
        return false;
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(Vec3(0,1,0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail', 
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    const tooClose = !dont_move_for.includes(item_name) &&
        (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1);
    const tooFar = bot.entity.position.distanceTo(targetBlock.position) > 4.5;
    let creativeFlightStarted = false;
    if (bot.game.gameMode === 'creative' && (tooClose || tooFar)) {
        try {
            bot._creativeBuildFlying = true;
            creativeFlightStarted = true;
            await bot.creative.flyTo(targetBlock.position.offset(2.25, 2.25, 2.25));
        } catch {
            finishCreativeFlight(bot);
            return false;
        }
    }
    else if (tooClose) {
        // too close
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        bot.pathfinder.setMovements(createMovements(bot));
        try {
            await goToGoal(bot, inverted_goal, { timeoutMs: Math.min(NAV_TIMEOUT_MS, 12000) });
        } catch {
            return false;
        }
    }
    if (bot.game.gameMode !== 'creative' && bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        let pos = targetBlock.position;
        let movements = createMovements(bot);
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            return await useToolOnBlock(bot, item_name, buildOffBlock);
        }
        else {
            if (!await equipItemSafely(bot, block_item, 'hand')) return false;
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
            await bot.placeBlock(buildOffBlock, faceVec);
            await new Promise(resolve => setTimeout(resolve, 200));
            const placed = bot.blockAt(target_dest);
            const success = placed && placed.name !== 'air' && placed.name !== targetBlock.name;
            if (success)
                log(bot, `Placed ${blockType} at ${target_dest}.`);
            else
                log(bot, `Placement of ${blockType} at ${target_dest} was not confirmed.`);
            return success;
        }
    } catch (err) {
        log(bot, `Failed to place ${blockType} at ${target_dest}.`);
        return false;
    } finally {
        if (creativeFlightStarted)
            finishCreativeFlight(bot);
    }
}

export async function equip(bot, itemName) {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true if the item was equipped, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    if (itemName === 'hand') {
        if (!await unequipItemSafely(bot, 'hand')) {
            log(bot, `Could not unequip hand.`);
            return false;
        }
        log(bot, `Unequipped hand.`);
        return true;
    }
    let item = mc.findInventoryItem(bot, itemName);
    if (!item) {
        if (bot.game.gameMode === "creative") {
            const creativeItem = mc.makeItem(itemName, 1);
            if (creativeItem)
                await bot.creative.setInventorySlot(36, creativeItem);
            item = mc.findInventoryItem(bot, itemName);
        }
        else {
            log(bot, `You do not have any ${itemName} to equip.`);
            return false;
        }
    }
    let destination = 'hand';
    if (itemName.includes('leggings')) destination = 'legs';
    else if (itemName.includes('boots')) destination = 'feet';
    else if (itemName.includes('helmet')) destination = 'head';
    else if (itemName.includes('chestplate') || itemName.includes('elytra')) destination = 'torso';
    else if (itemName.includes('shield')) destination = 'off-hand';

    if (!await equipItemSafely(bot, item, destination)) {
        log(bot, `Could not equip ${itemName}.`);
        return false;
    }
    log(bot, `Equipped ${itemName}.`);
    return true;
}

export async function discard(bot, itemName, num=-1) {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    let discarded = 0;
    while (true) {
        let item = mc.findInventoryItem(bot, itemName);
        if (!item) {
            break;
        }
        let to_discard = num === -1 ? item.count : Math.min(num - discarded, item.count);
        if (to_discard <= 0) break;
        const tossed = await tossItemSafely(bot, item, to_discard);
        if (tossed <= 0) break;
        discarded += tossed;
        if (num !== -1 && discarded >= num) {
            break;
        }
    }
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
    log(bot, `Discarded ${discarded} ${itemName}.`);
    return true;
}

export async function putInChest(bot, itemName, num=-1) {
    /**
     * Put the given item in the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, the number of items to put in the chest. Defaults to -1, which puts all items.
     * @returns {Promise<boolean>} true if the item was put in the chest, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    let item = mc.findInventoryItem(bot, itemName);
    if (!item) {
        log(bot, `You do not have any ${itemName} to put in the chest.`);
        return false;
    }
    let to_put = num === -1 ? item.count : Math.min(num, item.count);
    if (!await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2))
        return false;
    const result = await withContainerLock(bot, chest, async () => {
        let chestContainer = null;
        try {
            chestContainer = await bot.openContainer(chest);
            await chestContainer.deposit(item.type, item.metadata, to_put, item.nbt);
            return true;
        } finally {
            if (chestContainer)
                try { await chestContainer.close(); } catch { /* disconnected */ }
        }
    });
    if (!result.locked) {
        log(bot, `Chest is currently in use.`);
        return false;
    }
    if (result.value)
        log(bot, `Successfully put ${to_put} ${itemName} in the chest.`);
    return result.value === true;
}

export async function takeFromChest(bot, itemName, num=-1) {
    /**
     * Take the given item from the nearest chest, potentially from multiple slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, the number of items to take from the chest. Defaults to -1, which takes all items.
     * @returns {Promise<boolean>} true if the item was taken from the chest, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    if (!await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2))
        return false;
    const result = await withContainerLock(bot, chest, async () => {
        let chestContainer = null;
        try {
            chestContainer = await bot.openContainer(chest);
            const matchingItems = chestContainer.containerItems()
                .filter(item => mc.stackMatchesName(item, itemName, bot));
            if (matchingItems.length === 0)
                return 0;

            const totalAvailable = matchingItems.reduce((sum, item) => sum + item.count, 0);
            let remaining = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
            let totalTaken = 0;
            for (const item of matchingItems) {
                if (remaining <= 0) break;
                const toTakeFromSlot = Math.min(remaining, item.count);
                await chestContainer.withdraw(item.type, item.metadata, toTakeFromSlot, item.nbt);
                totalTaken += toTakeFromSlot;
                remaining -= toTakeFromSlot;
            }
            return totalTaken;
        } finally {
            if (chestContainer)
                try { await chestContainer.close(); } catch { /* disconnected */ }
        }
    });
    if (!result.locked) {
        log(bot, `Chest is currently in use.`);
        return false;
    }
    if (!result.value) {
        log(bot, `Could not find any ${itemName} in the chest.`);
        return false;
    }
    log(bot, `Successfully took ${result.value} ${itemName} from the chest.`);
    return true;
}

export async function viewChest(bot) {
    /**
     * View the contents of the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    if (!await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2))
        return false;
    const result = await withContainerLock(bot, chest, async () => {
        let chestContainer = null;
        try {
            chestContainer = await bot.openContainer(chest);
            return chestContainer.containerItems().map(item => ({
                count: item.count,
                name: item.name,
            }));
        } finally {
            if (chestContainer)
                try { await chestContainer.close(); } catch { /* disconnected */ }
        }
    });
    if (!result.locked) {
        log(bot, `Chest is currently in use.`);
        return false;
    }
    if (result.value.length === 0) {
        log(bot, `The chest is empty.`);
    } else {
        log(bot, `The chest contains:`);
        for (const item of result.value)
            log(bot, `${item.count} ${item.name}`);
    }
    return true;
}

export async function consume(bot, itemName="") {
    /**
     * Eat/drink the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink.
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.eat(bot, "apple");
     **/
    let item, name;
    if (itemName) {
        item = mc.findInventoryItem(bot, itemName);
        name = itemName;
    } else {
        item = bot.inventory.items()
            .filter(stack => isConsumableStack(bot, stack))
            .sort((a, b) =>
                (bot.registry.foodsByName[b.name]?.foodPoints ?? 0)
                - (bot.registry.foodsByName[a.name]?.foodPoints ?? 0))[0];
        name = item?.name ?? 'food';
    }
    if (!item) {
        log(bot, `You do not have any ${name} to eat.`);
        return false;
    }
    if (!isConsumableStack(bot, item)) {
        log(bot, `${item.name} is not edible. If this is wheat, craft it into bread first.`);
        return false;
    }
    if (!await equipItemSafely(bot, item, 'hand')) return false;
    try {
        await bot.consume();
    } catch (error) {
        log(bot, `Could not eat ${item.name}: ${error.message}.`);
        return false;
    }
    log(bot, `Consumed ${item.name}.`);
    return true;
}


export async function giveToPlayer(bot, itemType, username, num=1) {
    /**
     * Give one of the specified item to the specified player
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item to give.
     * @param {string} username, the username of the player to give the item to.
     * @param {number} num, the number of items to give. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was given, false otherwise.
     * @example
     * await skills.giveToPlayer(bot, "oak_log", "player1");
     **/
    if (bot.username === username) {
        log(bot, `You cannot give items to yourself.`);
        return false;
    }
    let player = bot.players[username]?.entity;
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }
    if (!await goToPlayer(bot, username, 2.5))
        return false;
    player = bot.players[username]?.entity;
    if (!player) return false;
    if (bot.entity.position.y < player.position.y - 1) {
        if (!await goToPlayer(bot, username, 1))
            return false;
    }
    // Keep enough room for the item entity to spawn, but remain in pickup range.
    if (bot.entity.position.distanceTo(player.position) < 1.4) {
        await moveAwayFromEntity(bot, player, 2.5);
        await new Promise(resolve => setTimeout(resolve, 300));
        player = bot.players[username]?.entity;
        if (!player) return false;
    }

    await bot.lookAt(player.position.offset(0, 1, 0));
    let given = false;
    const onCollect = (collector) => {
        if (collector?.username === username) {
            log(bot, `${username} received ${itemType}.`);
            given = true;
        }
    };
    bot.on('playerCollect', onCollect);
    try {
        if (!await discard(bot, itemType, num))
            return false;
        const start = Date.now();
        while (!given && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 250));
            if (Date.now() - start > 4000) break;
        }
    } finally {
        bot.removeListener('playerCollect', onCollect);
    }
    if (given) return true;
    log(bot, `Failed to give ${itemType} to ${username}, it was never received.`);
    return false;
}

export async function goToGoal(bot, goal, options = {}) {
    /**
     * Navigate to the given goal using doors without digging or scaffolding.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     **/

    const activeBackoff = getNavigationGoalBackoff(bot, goal);
    if (activeBackoff)
        throw new NavigationGoalBackoffError(goal, activeBackoff.retryAt);

    const nonDestructiveMovements = createMovements(bot);
    const dontBreakBlocks = ['glass', 'glass_pane', 'chest', 'trapped_chest', 'barrel',
        'furnace', 'lit_furnace', 'blast_furnace', 'smoker', 'crafting_table'];
    const protectedBlockIds = [];
    for (let block of dontBreakBlocks) {
        const id = mc.getBlockId(block);
        if (id != null) {
            nonDestructiveMovements.blocksCantBreak.add(id);
            protectedBlockIds.push(id);
        }
    }
    nonDestructiveMovements.placeCost = 2;
    nonDestructiveMovements.digCost = 10;

    const fallbackMovements = createTravelMovements(bot);
    for (const id of protectedBlockIds)
        fallbackMovements.blocksCantBreak.add(id);
    if (typeof options === 'object' && options.canDig === false) {
        nonDestructiveMovements.canDig = false;
        fallbackMovements.canDig = false;
    }

    const configuredTimeout = typeof options === 'object' && options.timeoutMs
        ? options.timeoutMs
        : NAV_TIMEOUT_MS;
    const tripTimeout = Math.min(configuredTimeout, Math.max(12000, goalDistance(bot, goal) * 1100 + 8000));
    let final_movements = fallbackMovements;

    // Longer trips get a short feasibility check before the full path search.
    if (goalDistance(bot, goal) > 8) {
        const pathfindTimeout = 500;
        try {
            const safePath = bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfindTimeout);
            if (safePath.status === 'success')
                final_movements = nonDestructiveMovements;
        } catch { /* fall back to normal movements */ }
    }

    const doorCheckInterval = startDoorInterval(bot);
    const attempts = final_movements === fallbackMovements
        ? [fallbackMovements, fallbackMovements]
        : [final_movements, fallbackMovements];
    let lastError = null;
    try {
        for (let attempt = 0; attempt < attempts.length; attempt++) {
            const movements = attempts[attempt];
            // On a replan, avoid occupied nodes more aggressively. This is especially
            // useful at shared doors/chests where several NPCs converge at once.
            movements.entityCost = attempt === 0 ? Math.max(4, movements.entityCost) : 8;
            bot.pathfinder.setMovements(movements);
            bot._navigationAttempt = attempt + 1;
            try {
                await gotoWithTimeout(bot, goal, tripTimeout);
                clearNavigationGoalFailure(bot, goal);
                return true;
            } catch (error) {
                lastError = error;
                if (attempt === attempts.length - 1 || !isRetryableNavigationError(error))
                    throw error;
                console.warn(`[navigation ${bot.username}] ${error.message}; replanning ${attempt + 2}/${attempts.length}`);
                stopPathingQuietly(bot);
                await sleep(200);
            }
        }
        throw lastError;
    } catch (error) {
        recordNavigationGoalFailure(bot, goal, error);
        throw error;
    } finally {
        delete bot._navigationAttempt;
        stopDoorInterval(bot, doorCheckInterval);
    }
}

const doorIntervals = new WeakMap();

function stopDoorInterval(bot, interval) {
    if (interval) clearInterval(interval);
    const active = doorIntervals.get(bot);
    if (!active || active === interval) doorIntervals.delete(bot);
}

function startDoorInterval(bot) {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    const previous = doorIntervals.get(bot);
    if (previous) clearInterval(previous);
    let prev_pos = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;


    const doorCheckInterval = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }
        
        if (stuck_time > 1200) {
            // shuffle positions so we're not always opening the same door
            const positions = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1), 
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ];
            let elevated_positions = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet
            
            let currentIndex = positions.length;
            while (currentIndex != 0) {
                let randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }
            
            for (let position of positions) {
                let block = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor'))) 
                {
                    void bot.activateBlock(block).catch(() => {});
                    break;
                }
            }
            stuck_time = 0;
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    doorIntervals.set(bot, doorCheckInterval);
    return doorCheckInterval;
}

export async function goToPosition(bot, x, y, z, min_distance=2) {
    /**
     * Navigate to the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to. If null, the bot's current x coordinate will be used.
     * @param {number} y, the y coordinate to navigate to. If null, the bot's current y coordinate will be used.
     * @param {number} z, the z coordinate to navigate to. If null, the bot's current z coordinate will be used.
     * @param {number} distance, the distance to keep from the position. Defaults to 2.
     * @returns {Promise<boolean>} true if the position was reached, false otherwise.
     * @example
     * let position = world.world.getNearestBlock(bot, "oak_log", 64).position;
     * await skills.goToPosition(bot, position.x, position.y, position.x + 20);
     **/
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }
    
    const checkDigProgress = () => {
        if (bot.targetDigBlock) {
            const targetBlock = bot.targetDigBlock;
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (!targetBlock.canHarvest(itemId)) {
                log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.`);
                bot.pathfinder.stop();
                stopDiggingQuietly(bot);
            }
        }
    };
    
    const progressInterval = setInterval(checkDigProgress, 1000);
    
    try {
        const goal = new pf.goals.GoalNear(x, y, z, min_distance);
        await goToGoal(bot, goal);
        const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
        if (distance <= min_distance+1) {
            bot._navigationFailureStreak = 0;
            log(bot, `You have reached at ${x}, ${y}, ${z}.`);
            return true;
        }
        else {
            log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away.`);
            return false;
        }
    } catch (err) {
        let finalError = err;
        bot._navigationFailureStreak = (bot._navigationFailureStreak ?? 0) + 1;
        if (isRetryableNavigationError(err)
            && bot._navigationFailureStreak >= 2
            && await nudgeAfterNavigationFailure(bot, { x, y, z })) {
            try {
                await goToGoal(bot, new pf.goals.GoalNear(x, y, z, min_distance));
                const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
                if (distance <= min_distance + 1) {
                    bot._navigationFailureStreak = 0;
                    log(bot, `You have reached at ${x}, ${y}, ${z} after stepping free.`);
                    return true;
                }
            } catch (retryError) {
                finalError = retryError;
            }
        }
        log(bot, `Pathfinding stopped: ${finalError.message}.`);
        return false;
    } finally {
        clearInterval(progressInterval);
    }
}

export async function travelToPosition(bot, x, y, z, arriveRadius = 3) {
    /**
     * Long-range travel to known coordinates, like a player walking home.
     * A single pathfinder trip only searches searchRadius (~128) blocks, so a
     * distant target (failed expedition, respawn at world spawn) could never be
     * reached in one goto. This heads toward the target in bearing waypoints of
     * ~60% of the search radius, digging/bridging when necessary, until the
     * target is close enough for one normal precise approach.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, y, z target coordinates.
     * @param {number} arriveRadius, the distance to keep from the target.
     * @returns {Promise<boolean>} true if the target was reached.
     **/
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
    const target = new Vec3(x, y, z);
    const searchRadius = bot.pathfinder?.searchRadius > 0 ? bot.pathfinder.searchRadius : 128;
    const hop = Math.max(24, Math.min(96, Math.floor(searchRadius * 0.6)));
    // Straight at the target first; when a bearing is blocked (ocean, cliff wall,
    // unpathable build), fan out sideways before declaring the attempt failed.
    const bearingOffsets = [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5];
    const maxHops = Math.max(20, Math.ceil(bot.entity.position.distanceTo(target) / 20) + 10);
    let failedRounds = 0;
    console.log(`[travel ${bot.username}] starting long-range trip: ${Math.round(bot.entity.position.distanceTo(target))} blocks to ${x},${y},${z}`);
    for (let hops = 0; hops < maxHops && !bot.interrupt_code; hops++) {
        const from = bot.entity.position.clone();
        const distance = from.distanceTo(target);
        if (distance <= hop) {
            const reached = await goToPosition(bot, x, y, z, arriveRadius);
            if (reached)
                console.log(`[travel ${bot.username}] arrived at ${x},${y},${z}`);
            return reached;
        }

        // Overland travel is far more reliable than wandering cave systems.
        if (from.y < 55)
            await goToSurface(bot);

        let advanced = false;
        for (const offset of bearingOffsets) {
            if (bot.interrupt_code) return false;
            const start = bot.entity.position.clone();
            const bearing = Math.atan2(target.z - start.z, target.x - start.x) + offset;
            const step = Math.min(hop, Math.max(24, distance - 8));
            const wx = Math.round(start.x + Math.cos(bearing) * step);
            const wz = Math.round(start.z + Math.sin(bearing) * step);
            try {
                await goToGoal(bot, new pf.goals.GoalNearXZ(wx, wz, 10));
            } catch { /* this bearing is blocked, fan out to the next one */ }
            const now = bot.entity.position;
            if (start.distanceTo(now) >= 8 && now.distanceTo(target) < distance - 4) {
                advanced = true;
                break;
            }
        }
        if (advanced) {
            failedRounds = 0;
            console.log(`[travel ${bot.username}] ${Math.round(bot.entity.position.distanceTo(target))} blocks remaining`);
            continue;
        }
        failedRounds++;
        if (failedRounds >= 2) {
            log(bot, `Travel stalled ${Math.round(distance)} blocks from ${x}, ${y}, ${z}; giving up this attempt.`);
            return false;
        }
        await wait(bot, 2500);
    }
    log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(bot.entity.position.distanceTo(target))} blocks away.`);
    return false;
}

export async function goToNearestBlock(bot, blockType,  min_distance=2, range=64) {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 64, 2);
     * **/
    const MAX_RANGE = 512;
    if (range > MAX_RANGE) {
        log(bot, `Maximum search range capped at ${MAX_RANGE}. `);
        range = MAX_RANGE;
    }
    let block = null;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType && block.metadata === 0, range, 1);
        if (blocks.length === 0) {
            log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
            blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType, range, 1);
        }
        block = blocks[0];
    }
    else {
        block = world.getNearestBlock(bot, blockType, range);
    }
    if (!block) {
        log(bot, `Could not find any ${blockType} in ${range} blocks.`);
        return false;
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    return await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
}

export async function goToNearestEntity(bot, entityType, min_distance=2, range=64) {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    let entity = world.getNearestEntityWhere(bot, entity => entity.name === entityType, range);
    if (!entity) {
        log(bot, `Could not find any ${entityType} in ${range} blocks.`);
        return false;
    }
    let distance = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    return await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
}

export async function goToPlayer(bot, username, distance=3) {
    /**
     * Navigate to the given player.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, the goal distance to the player.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    if (bot.username === username) {
        log(bot, `You are already at ${username}.`);
        return true;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + username);
        log(bot, `Teleported to ${username}.`);
        return true;
    }

    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let player = bot.players[username]?.entity;
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }

    distance = Math.max(distance, 0.5);
    const goal = new pf.goals.GoalFollow(player, distance);

    if (shouldUseBoatToEntity(bot, player, distance)) {
        const crossed = await boatTravelToEntity(
            bot,
            () => bot.players[username]?.entity,
            { stopDistance: distance + 2, timeoutMs: 45_000 },
        );
        player = bot.players[username]?.entity;
        if (crossed && player && bot.entity.position.distanceTo(player.position) <= distance + 3) {
            log(bot, `You have reached ${username}.`);
            return true;
        }
    }

    try {
        if (!await goToGoal(bot, goal)) return false;
    } catch (error) {
        player = bot.players[username]?.entity;
        if (player && shouldUseBoatToEntity(bot, player, distance)) {
            const crossed = await boatTravelToEntity(
                bot,
                () => bot.players[username]?.entity,
                { stopDistance: distance + 2, timeoutMs: 45_000 },
            );
            if (crossed) return true;
        }
        throw error;
    }

    log(bot, `You have reached ${username}.`);
    return true;
}


export async function followPlayer(bot, username, distance=4, opts={}) {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @param {number} distance, the distance to keep from the player.
     * @param {object} opts, optional: { until } — epoch ms after which the follow ends on its own.
     * Maintains bot._followTargetLastSeen (Vec3) every tick so a caller can chase the
     * player's last known position after their entity unloads (48-block tracking range).
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     **/
    let player = bot.players[username]?.entity;
    if (!player)
        return false;

    const move = createMovements(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    let doorCheckInterval = startDoorInterval(bot);
    try {
        bot.pathfinder.setGoal(new pf.goals.GoalFollow(player, distance), true);
        log(bot, `You are now actively following player ${username}.`);

        while (!bot.interrupt_code) {
            if (opts.until != null && Date.now() >= opts.until) break;
            await new Promise(resolve => setTimeout(resolve, 500));
            player = bot.players[username]?.entity;
            if (!player) {
                log(bot, `${username} is no longer in range.`);
                break;
            }
            bot._followTargetLastSeen = player.position.clone();
        // in cheat mode, if the distance is too far, teleport to the player
        const distance_from_player = bot.entity.position.distanceTo(player.position);

        const teleport_distance = 100;
        const ignore_modes_distance = 30; 
        const nearby_distance = distance + 2;

        if (distance_from_player > nearby_distance
            && shouldUseBoatToEntity(bot, player, nearby_distance)) {
            if (doorCheckInterval) {
                stopDoorInterval(bot, doorCheckInterval);
                doorCheckInterval = null;
            }
            try { bot.pathfinder?.setGoal?.(null); } catch { /* pathfinder may be absent */ }
            await boatTravelToEntity(
                bot,
                () => bot.players[username]?.entity,
                { stopDistance: nearby_distance, timeoutMs: 30_000 },
            );
            player = bot.players[username]?.entity;
            if (!player) {
                log(bot, `${username} is no longer in range.`);
                break;
            }
            if (!isBotInBoat(bot)) {
                bot.pathfinder.setMovements(move);
                bot.pathfinder.setGoal(new pf.goals.GoalFollow(player, distance), true);
            }
            continue;
        }

        if (distance_from_player > teleport_distance && bot.modes.isOn('cheat')) {
            // teleport with cheat mode
            await goToPlayer(bot, username);
        }
        else if (distance_from_player > ignore_modes_distance) {
            // these modes slow down the bot, and we want to catch up
            bot.modes.pause('item_collecting');
            bot.modes.pause('hunting');
            bot.modes.pause('torch_placing');
        }
        else if (distance_from_player <= ignore_modes_distance) {
            bot.modes.unpause('item_collecting');
            bot.modes.unpause('hunting');
            bot.modes.unpause('torch_placing');
        }

            if (distance_from_player <= nearby_distance) {
                stopDoorInterval(bot, doorCheckInterval);
                doorCheckInterval = null;
                bot.modes.pause('unstuck');
                bot.modes.pause('elbow_room');
            }
            else {
                if (!doorCheckInterval) {
                    doorCheckInterval = startDoorInterval(bot);
                }
                bot.modes.unpause('unstuck');
                bot.modes.unpause('elbow_room');
            }
        }
        return true;
    } finally {
        stopDoorInterval(bot, doorCheckInterval);
        bot.pathfinder.stop();
        for (const mode of ['item_collecting', 'hunting', 'torch_placing', 'unstuck', 'elbow_room'])
            bot.modes.unpause(mode);
    }
}

function waterBlock(block) {
    return block && (block.name === 'water' || block.name === 'bubble_column');
}

function airLike(block) {
    return !block || AIR_LIKE_BLOCKS.has(block.name);
}

function boatItemNames(bot) {
    const existing = BOAT_ITEM_CANDIDATES.filter(name => mc.getItemId(name, bot) != null);
    return existing.length ? existing : ['boat'];
}

function boatInventoryItem(bot) {
    const names = boatItemNames(bot);
    return bot.inventory.items().find(item =>
        names.some(name => mc.stackMatchesName(item, name, bot))
        || item.name === 'boat'
        || item.name.endsWith('_boat'));
}

function isBoatEntity(entity) {
    const name = String(entity?.name ?? entity?.displayName ?? '').toLowerCase();
    return name.includes('boat');
}

export function isBotInBoat(bot) {
    return Boolean(bot?.vehicle && isBoatEntity(bot.vehicle));
}

function positionInWater(bot, position) {
    if (!position) return false;
    const p = position.floored ? position.floored() : new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    return waterBlock(bot.blockAt(p)) || waterBlock(bot.blockAt(p.offset(0, -1, 0)));
}

function nearestBoat(bot, range = 6) {
    if (!bot?.entity) return null;
    return Object.values(bot.entities ?? {})
        .filter(entity => entity?.isValid !== false && isBoatEntity(entity))
        .filter(entity => !entity.passengers?.length || entity.passengers.includes(bot.entity))
        .map(entity => ({ entity, distance: entity.position.distanceTo(bot.entity.position) }))
        .filter(entry => entry.distance <= range)
        .sort((a, b) => a.distance - b.distance)[0]?.entity ?? null;
}

function waterSurfaceBlock(bot, position) {
    const block = bot.blockAt(position);
    const above = bot.blockAt(position.offset(0, 1, 0));
    return waterBlock(block) && airLike(above) ? block : null;
}

function findNearbyWaterSurface(bot, radius = 6) {
    if (!bot?.entity) return null;
    const origin = bot.entity.position.floored();
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++)
        for (let dz = -radius; dz <= radius; dz++) {
            if (Math.hypot(dx, dz) > radius) continue;
            for (let dy = 3; dy >= -4; dy--) {
                const position = new Vec3(origin.x + dx, origin.y + dy, origin.z + dz);
                const block = waterSurfaceBlock(bot, position);
                if (!block) continue;
                candidates.push({
                    block,
                    score: Math.hypot(dx, dz) + Math.abs(dy) * 1.5,
                });
            }
        }
    return candidates.sort((a, b) => a.score - b.score)[0]?.block ?? null;
}

function waterAheadStats(bot, targetPosition, maxDistance = 48) {
    if (!bot?.entity || !targetPosition) return { count: 0, longestRun: 0 };
    const start = bot.entity.position;
    const dx = targetPosition.x - start.x;
    const dz = targetPosition.z - start.z;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal < 1) return { count: 0, longestRun: 0 };
    const samples = Math.min(24, Math.max(4, Math.floor(Math.min(horizontal, maxDistance) / 2)));
    let count = 0;
    let run = 0;
    let longestRun = 0;
    for (let i = 1; i <= samples; i++) {
        const t = i / samples;
        const x = Math.floor(start.x + dx * t);
        const z = Math.floor(start.z + dz * t);
        const y = Math.floor(start.y + (targetPosition.y - start.y) * t);
        const water = positionInWater(bot, new Vec3(x, y, z))
            || positionInWater(bot, new Vec3(x, start.y, z))
            || waterBlock(bot.blockAt(new Vec3(x, y - 1, z)));
        if (water) {
            count++;
            run++;
            longestRun = Math.max(longestRun, run);
        } else {
            run = 0;
        }
    }
    return { count, longestRun };
}

export function shouldUseBoatToEntity(bot, entity, stopDistance = 4) {
    if (!bot?.entity || !entity?.position) return false;
    if (isBotInBoat(bot)) return true;
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance <= Math.max(8, stopDistance + 3)) return false;
    if (isBotInWater(bot) && !findNearestShore(bot, 10)) return true;
    if (!findNearbyWaterSurface(bot, 7)) return false;
    const stats = waterAheadStats(bot, entity.position);
    return stats.longestRun >= 4 || stats.count >= 8;
}

function safeShoreBlock(bot, position) {
    const feet = bot.blockAt(position);
    const head = bot.blockAt(position.offset(0, 1, 0));
    const floor = bot.blockAt(position.offset(0, -1, 0));
    if (!feet || !head || !floor || waterBlock(feet) || waterBlock(head)) return false;
    const feetClear = feet.name === 'air' || feet.name === 'cave_air' || feet.name === 'void_air'
        || feet.name === 'short_grass' || feet.name === 'tall_grass' || feet.name === 'snow';
    const headClear = head.name === 'air' || head.name === 'cave_air' || head.name === 'void_air';
    const solidFloor = floor.name !== 'water' && floor.name !== 'lava'
        && Array.isArray(floor.shapes) && floor.shapes.length > 0;
    return feetClear && headClear && solidFloor;
}

function shoreApproachScore(bot, position, origin) {
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue;
            // A usable bank needs a water cell beside the solid bank and free
            // headroom above it. Otherwise the selected "shore" can be the top
            // of an overhang that the swimmer is already trapped underneath.
            const water = position.offset(dx, -1, dz);
            const exit = position.offset(dx, 0, dz);
            const exitBlock = bot.blockAt(exit);
            if (!waterBlock(bot.blockAt(water)) || !exitBlock) continue;
            if (Array.isArray(exitBlock.shapes) && exitBlock.shapes.length > 0
                && !waterBlock(exitBlock)) continue;
            best = Math.min(best,
                Math.hypot(water.x - origin.x, water.z - origin.z)
                + Math.abs(water.y - origin.y) * 1.5);
        }
    return best;
}

function shoreKey(position) {
    return `${position.x},${position.y},${position.z}`;
}

function findNearestShore(bot, maxRadius = 24, excluded = null) {
    if (!bot.entity) return null;
    const origin = bot.entity.position.floored();
    for (let radius = 1; radius <= maxRadius; radius++) {
        const candidates = [];
        for (let dx = -radius; dx <= radius; dx++)
            for (let dz = -radius; dz <= radius; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
                for (let dy = 3; dy >= -3; dy--) {
                    const position = new Vec3(origin.x + dx, origin.y + dy, origin.z + dz);
                    if (!safeShoreBlock(bot, position)) continue;
                    if (excluded?.has(shoreKey(position))) continue;
                    const approachScore = shoreApproachScore(bot, position, origin);
                    if (!Number.isFinite(approachScore)) continue;
                    candidates.push({
                        position,
                        score: approachScore + Math.hypot(dx, dz) * 0.25
                            + Math.abs(dy) * 1.75 - Math.max(0, dy) * 0.25,
                    });
                }
            }
        if (candidates.length > 0)
            return candidates.sort((a, b) => a.score - b.score)[0].position;
    }
    return null;
}

export function isBotInWater(bot) {
    if (!bot?.entity) return false;
    return bot.entity.isInWater === true
        || waterBlock(bot.blockAt(bot.entity.position))
        || waterBlock(bot.blockAt(bot.entity.position.offset(0, 1, 0)));
}

async function ensureBoat(bot) {
    let item = boatInventoryItem(bot);
    if (item) return item.name;

    if (countOf(bot, [...LOG_TYPES, ...PLANK_TYPES]) < 5 && !isBotInWater(bot))
        await ensureLogs(bot, 2);
    await ensurePlanks(bot, 5);
    for (const boatName of boatItemNames(bot)) {
        if (bot.interrupt_code) return null;
        if (mc.getItemId(boatName, bot) == null) continue;
        try {
            await craftRecipe(bot, boatName, 1);
        } catch { /* try the next variant */ }
        item = boatInventoryItem(bot);
        if (item) return item.name;
    }
    return null;
}

async function waitForMounted(bot, boat, timeoutMs = 3500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !bot.interrupt_code) {
        if (bot.vehicle && (!boat || bot.vehicle === boat || isBoatEntity(bot.vehicle)))
            return true;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
}

async function mountBoat(bot, boat) {
    if (isBotInBoat(bot)) return true;
    if (!boat) return false;
    if (boat.position.distanceTo(bot.entity.position) > 3.2) {
        try { await goToPosition(bot, boat.position.x, boat.position.y, boat.position.z, 2); }
        catch { /* water pathing is unreliable; still try mount if close enough after movement */ }
    }
    if (boat.position.distanceTo(bot.entity.position) > 4.5) return false;
    try { bot.mount(boat); } catch { return false; }
    return await waitForMounted(bot, boat);
}

async function placeAndMountBoat(bot) {
    if (isBotInBoat(bot)) return true;
    const existing = nearestBoat(bot, 5);
    if (existing && await mountBoat(bot, existing)) return true;

    const boatName = await ensureBoat(bot);
    if (!boatName) {
        log(bot, 'Za prečkanje vode nimam materiala za čoln.');
        return false;
    }
    let water = findNearbyWaterSurface(bot, 7);
    if (!water) return false;
    if (water.position.distanceTo(bot.entity.position) > 3) {
        try { await goToPosition(bot, water.position.x, water.position.y + 1, water.position.z, 2); }
        catch { /* still try from the current edge */ }
        water = findNearbyWaterSurface(bot, 4) ?? water;
    }

    try { await equip(bot, boatName); } catch { return false; }
    let boat = null;
    try {
        boat = await bot.placeEntity(water, new Vec3(0, 1, 0));
    } catch (error) {
        log(bot, `Čolna ne morem postaviti: ${error.message}`);
    }
    boat ??= nearestBoat(bot, 7);
    if (!boat) return false;
    return await mountBoat(bot, boat);
}

async function dismountNearShore(bot, targetPosition = null) {
    if (!isBotInBoat(bot)) return true;
    const shore = findNearestShore(bot, targetPosition ? 8 : 5);
    if (!shore) return false;
    try { bot.moveVehicle(0, 0); } catch { /* not mounted */ }
    try { bot.dismount(); } catch { return false; }
    await new Promise(resolve => setTimeout(resolve, 600));
    if (isBotInWater(bot))
        await escapeWater(bot, 5000);
    return !isBotInWater(bot);
}

export async function boatTravelToEntity(bot, entityProvider, options = {}) {
    const stopDistance = Math.max(2, Number(options.stopDistance ?? 5));
    const timeoutMs = Math.max(5000, Number(options.timeoutMs ?? 30_000));
    const deadline = Date.now() + timeoutMs;
    bot._waterTravelActive = true;
    try {
        try { bot.pathfinder?.setGoal?.(null); } catch { /* no pathfinder */ }
        stopDiggingQuietly(bot);
        if (!await placeAndMountBoat(bot)) return false;
        log(bot, 'Prečkam vodo s čolnom.');

        while (Date.now() < deadline && !bot.interrupt_code) {
            const entity = typeof entityProvider === 'function' ? entityProvider() : entityProvider;
            const target = entity?.position;
            if (!target) return false;
            const vehicle = bot.vehicle ?? bot.entity;
            const distance = vehicle.position.distanceTo(target);
            const targetInWater = positionInWater(bot, target);
            if (distance <= stopDistance) {
                if (!targetInWater)
                    await dismountNearShore(bot, target);
                return true;
            }

            const lookTarget = new Vec3(target.x, vehicle.position.y + 0.6, target.z);
            try { await bot.lookAt(lookTarget, true); } catch { /* still send input */ }
            try { bot.moveVehicle(0, 1); } catch { return false; }
            await new Promise(resolve => setTimeout(resolve, 180));

            if (!isBotInBoat(bot)) {
                if (isBotInWater(bot)) await escapeWater(bot, 4000);
                return false;
            }
        }
        return false;
    } finally {
        try { bot.moveVehicle?.(0, 0); } catch { /* not mounted */ }
        bot._waterTravelActive = false;
    }
}

export async function escapeWater(bot, timeoutMs = 15_000) {
    if (!isBotInWater(bot)) return true;

    // stop() waits for the next path node and can leave the bot swimming downward.
    // setGoal(null) is the pathfinder-documented immediate stop.
    try { bot.pathfinder?.setGoal?.(null); } catch { /* disconnected */ }
    stopDiggingQuietly(bot);

    const failedShores = new Set();
    let shore = findNearestShore(bot, 24, failedShores);
    let lastShoreSearch = Date.now();
    let progressAnchor = bot.entity.position.clone();
    let bestShoreDistance = shore ? bot.entity.position.distanceTo(shore) : Infinity;
    let lastProgressAt = Date.now();
    let drySince = null;
    let boatTried = false;
    const deadline = Date.now() + timeoutMs;
    log(bot, shore
        ? `Rešujem se iz vode proti obali pri ${shore.x},${shore.y},${shore.z}.`
        : 'Rešujem se iz vode in plavam proti površju.');

    try {
        bot.setControlState('sprint', true);
        bot.setControlState('jump', true);
        while (Date.now() < deadline && !bot.interrupt_code) {
            if (!isBotInWater(bot)) {
                drySince ??= Date.now();
                if (Date.now() - drySince >= 500) {
                    log(bot, 'Varno sem prišel iz vode.');
                    return true;
                }
            } else {
                drySince = null;
            }

            if (shore) {
                const distance = bot.entity.position.distanceTo(shore);
                if (bot.entity.position.distanceTo(progressAnchor) > 0.75
                    || distance < bestShoreDistance - 0.5) {
                    progressAnchor = bot.entity.position.clone();
                    bestShoreDistance = distance;
                    lastProgressAt = Date.now();
                } else if (Date.now() - lastProgressAt > 2500) {
                    // Do not keep swimming into the same ledge forever. Remember
                    // this bank for the duration of the attempt and try another
                    // water-adjacent exit instead.
                    failedShores.add(shoreKey(shore));
                    shore = null;
                    lastProgressAt = Date.now();
                }
            }

            if (!shore || Date.now() - lastShoreSearch > 2000) {
                shore = findNearestShore(bot, 24, failedShores);
                lastShoreSearch = Date.now();
                progressAnchor = bot.entity.position.clone();
                bestShoreDistance = shore ? bot.entity.position.distanceTo(shore) : Infinity;
            }

            if (!shore && !boatTried && Number(bot.oxygenLevel ?? 20) > 8) {
                boatTried = true;
                if (await placeAndMountBoat(bot)) {
                    log(bot, 'Na vodi sem varen v čolnu.');
                    return true;
                }
            }

            if (shore) {
                // Aim at feet height on the bank. Looking a full block above it
                // makes a swimmer push upward into the underside of a ledge.
                const target = shore.offset(0.5, 0.2, 0.5);
                try { await bot.lookAt(target, true); } catch { /* keep swimming */ }
                bot.setControlState('forward', true);
                bot.setControlState('sprint', true);
                bot.setControlState('left', false);
                bot.setControlState('right', false);
            } else {
                // No loaded shore: keep gaining air and add a gentle alternating
                // strafe so currents or a block edge do not pin the bot in place.
                bot.setControlState('forward', true);
                const phase = Math.floor(Date.now() / 1200) % 2;
                bot.setControlState('left', phase === 0);
                bot.setControlState('right', phase === 1);
            }
            bot.setControlState('jump', true);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    } finally {
        for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sprint'])
            bot.setControlState(control, false);
    }
    log(bot, 'Izhoda iz vode še nisem dosegel; poskus bom ponovil.');
    return false;
}


export async function moveAway(bot, distance) {
    /**
     * Move away from current position in any direction.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.moveAway(bot, 8);
     **/
    const pos = bot.entity.position;
    let goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(createDryEscapeMovements(bot));

    if (bot.modes.isOn('cheat')) {
        const move = createMovements(bot);
        const path = await bot.pathfinder.getPathTo(move, inverted_goal, 10000);
        let last_move = path.path[path.path.length-1];
        if (last_move) {
            let x = Math.floor(last_move.x);
            let y = Math.floor(last_move.y);
            let z = Math.floor(last_move.z);
            bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
            return true;
        }
    }

    try {
        await goToGoal(bot, inverted_goal, { timeoutMs: Math.min(NAV_TIMEOUT_MS, 20000) });
    } catch (error) {
        log(bot, `Could not move away: ${error.message}.`);
        return false;
    }
    let new_pos = bot.entity.position;
    log(bot, `Moved away from ${pos.floored()} to ${new_pos.floored()}.`);
    return true;
}

export async function moveAwayFromEntity(bot, entity, distance=16) {
    /**
     * Move away from the given entity.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to move away from.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     **/
    let goal = new pf.goals.GoalFollow(entity, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(createDryEscapeMovements(bot));
    try {
        await goToGoal(bot, inverted_goal, { timeoutMs: Math.min(NAV_TIMEOUT_MS, 15000) });
        return true;
    } catch {
        return false;
    }
}

export async function avoidEnemies(bot, distance=16) {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     **/
    bot.modes.pause('self_preservation'); // prevents damage-on-low-health from interrupting the bot
    const deadline = Date.now() + 20000;
    let moved = false;
    try {
        let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
        while (enemy && Date.now() < deadline && !bot.interrupt_code) {
            const follow = new pf.goals.GoalFollow(enemy, distance+1);
            const inverted_goal = new pf.goals.GoalInvert(follow);
            bot.pathfinder.setMovements(createDryEscapeMovements(bot));
            bot.pathfinder.setGoal(inverted_goal, true);
            await new Promise(resolve => setTimeout(resolve, 500));
            moved = true;
            enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
            if (enemy && bot.entity.position.distanceTo(enemy.position) < 3)
                await attackEntity(bot, enemy, false);
        }
    } finally {
        try { bot.pathfinder.setGoal(null); } catch { /* disconnected */ }
        try { bot.pathfinder.stop(); } catch { /* disconnected */ }
        bot.modes.unpause('self_preservation');
    }
    if (moved)
        log(bot, `Moved away from nearby enemies.`);
    return moved;
}

export async function stay(bot, seconds=30) {
    /**
     * Stay in the current position until interrupted. Disables all modes.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     **/
    bot.modes.pause('self_preservation');
    bot.modes.pause('unstuck');
    bot.modes.pause('cowardice');
    bot.modes.pause('self_defense');
    bot.modes.pause('hunting');
    bot.modes.pause('torch_placing');
    bot.modes.pause('item_collecting');
    let start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `Stayed for ${(Date.now() - start)/1000} seconds.`);
    return true;
}

export async function useDoor(bot, door_pos=null) {
    /**
     * Use the door at the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    if (!door_pos) {
        for (let door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                               'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
            const door = world.getNearestBlock(bot, door_type, 16);
            door_pos = door?.position ?? null;
            if (door_pos) break;
        }
    } else {
        door_pos = new Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `Could not find a door to use.`);
        return false;
    }

    try {
        await goToGoal(bot, new pf.goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1),
            { timeoutMs: Math.min(NAV_TIMEOUT_MS, 15000) });
    } catch (error) {
        log(bot, `Could not reach the door: ${error.message}.`);
        return false;
    }
    
    let door_block = bot.blockAt(door_pos);
    if (!door_block) return false;
    await bot.lookAt(door_block.position.offset(0.5, 0.5, 0.5));
    try {
        if (!door_block._properties?.open)
            await bot.activateBlock(door_block);

        bot.setControlState("forward", true);
        await new Promise((resolve) => setTimeout(resolve, 600));
    } finally {
        bot.setControlState("forward", false);
    }
    door_block = bot.blockAt(door_pos);
    if (door_block?._properties?.open)
        await bot.activateBlock(door_block);

    log(bot, `Used door at ${door_pos}.`);
    return true;
}

export async function goToBed(bot) {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    const beds = bot.findBlocks({
        matching: (block) => {
            return mc.isBedBlock(block);
        },
        maxDistance: 32,
        count: 1
    });
    if (beds.length === 0) {
        log(bot, `Could not find a bed to sleep in.`);
        return false;
    }
    let loc = beds[0];
    await goToPosition(bot, loc.x, loc.y, loc.z);
    const bed = bot.blockAt(loc);
    await bot.sleep(bed);
    log(bot, `You are in bed.`);
    bot.modes.pause('unstuck');
    while (bot.isSleeping) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `You have woken up.`);
    return true;
}

export async function tillAndSow(bot, x, y, z, seedType=null) {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} plantType, the type of plant to plant. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if the ground was tilled, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.x, "wheat");
     **/
    const seedItems = {
        wheat: 'wheat_seeds',
        wheat_seed: 'wheat_seeds',
        carrots: 'carrot',
        carrot: 'carrot',
        potatoes: 'potato',
        potato: 'potato',
        beetroot: 'beetroot_seeds',
        beetroots: 'beetroot_seeds',
    };
    seedType = seedType ? (seedItems[seedType] ?? seedType) : null;
    let pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    let block = bot.blockAt(pos);
    if (!block) return false;
    log(bot, `Planting ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

    if (bot.modes.isOn('cheat')) {
        let to_remove = ['_seed', '_seeds'];
        for (let remove of to_remove) {
            if (seedType.endsWith(remove)) {
                seedType = seedType.replace(remove, '');
            }
        }
        const tilled = await placeBlock(bot, 'farmland', x, y, z);
        if (!tilled)
            return false;
        return await placeBlock(bot, seedType, x, y+1, z);
    }

    if (!mc.blockMatchesAnyName(block, ['grass_block', 'dirt', 'farmland'], bot)) {
        log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
        return false;
    }
    let above = bot.blockAt(new Vec3(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `Land is already farmed with ${above.name}.`);
            return true;
        }
        let broken = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            log(bot, `Cannot cannot break above block to till.`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(createMovements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    if (block.name !== 'farmland') {
        let hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
        let to_equip = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            log(bot, `Cannot till, no hoes.`);
            return false;
        }
        await bot.activateBlock(block);
        const tillDeadline = Date.now() + 1500;
        do {
            await new Promise(resolve => setTimeout(resolve, 100));
            block = bot.blockAt(pos);
        } while (Date.now() < tillDeadline && block?.name !== 'farmland');
        if (block?.name !== 'farmland') {
            log(bot, `Tilling at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} was not confirmed.`);
            return false;
        }
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    
    if (seedType) {
        if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
            seedType += 's'; // fixes common mistake
        let equipped_seeds = await equip(bot, seedType);
        if (!equipped_seeds) {
            log(bot, `No ${seedType} to plant.`);
            return false;
        }

        block = bot.blockAt(pos);
        if (!block || block.name !== 'farmland') return false;
        await bot.activateBlock(block);
        const cropName = seedType === 'wheat_seeds' ? 'wheat'
            : seedType === 'carrot' ? 'carrots'
                : seedType === 'potato' ? 'potatoes'
                    : seedType === 'beetroot_seeds' ? 'beetroots'
                        : null;
        if (cropName) {
            const plantDeadline = Date.now() + 1500;
            while (Date.now() < plantDeadline
                && bot.blockAt(pos.offset(0, 1, 0))?.name !== cropName)
                await new Promise(resolve => setTimeout(resolve, 100));
            if (bot.blockAt(pos.offset(0, 1, 0))?.name !== cropName) {
                log(bot, `Planting ${seedType} was not confirmed.`);
                return false;
            }
        }
        log(bot, `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}

export async function activateNearestBlock(bot, type) {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    let block = world.getNearestBlock(bot, type, 16);
    if (!block) {
        log(bot, `Could not find any ${type} to activate.`);
        return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(createMovements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    await bot.activateBlock(block);
    log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`);
    return true;
}

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot, id) {
    id = id+"";
    const entity = bot.entities[id];
    
    if (!entity) {
        log(bot, `Cannot find villager with id ${id}`);
        let entities = world.getNearbyEntities(bot, 16);
        let villager_list = "Available villagers:\n";
        for (let entity of entities) {
            if (entity.name === 'villager') {
                if (mc.isBabyEntity(entity, bot)) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (villager_list === "Available villagers:\n") {
            log(bot, "No villagers found nearby.");
            return null;
        }
        log(bot, villager_list);
        return null;
    }
    
    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        log(bot, 'Entity is not a villager');
        return null;
    }
    
    if (mc.isBabyEntity(entity, bot)) {
        log(bot, 'This is either a baby villager or a villager with no job - neither can trade');
        return null;
    }
    
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
        try {
            bot.modes.pause('unstuck');
            const goal = new pf.goals.GoalFollow(entity, 2);
            await goToGoal(bot, goal);
            
            
            log(bot, 'Successfully reached villager');
        } catch (err) {
            log(bot, 'Failed to reach villager - pathfinding error or villager moved');
            console.log(err);
            return null;
        } finally {
            bot.modes.unpause('unstuck');
        }
    }
    
    return entity;
}

/**
 * Show available trades for a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to show trades for
 * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
 * @example
 * await skills.showVillagerTrades(bot, "123");
 */
export async function showVillagerTrades(bot, id) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    let villager;
    try {
        villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            return false;
        }
        
        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade, i) => {
            const tradeInfo = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });
        
        return true;
    } catch (err) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        console.log('Villager trading error:', err.message);
        return false;
    } finally {
        if (villager) {
            try { await villager.close(); } catch { /* disconnected */ }
        }
    }
}

/**
 * Trade with a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to trade with
 * @param {number} index - the index (1-based) of the trade to execute
 * @param {number} count - how many times to execute the trade (optional)
 * @returns {Promise<boolean>} true if trade was successful, false otherwise
 * @example
 * await skills.tradeWithVillager(bot, "123", "1", "2");
 */
export async function tradeWithVillager(bot, id, index, count) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    let villager;
    try {
        villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            return false;
        }
        
        const tradeIndex = parseInt(index) - 1; // Convert to 0-based index
        const trade = villager.trades[tradeIndex];
        
        if (!trade) {
            log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
            return false;
        }
        
        if (trade.disabled) {
            log(bot, `Trade ${index} is currently disabled`);
            return false;
        }

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);
        
        const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount = count;
        const actualCount = Math.min(requestedCount, maxPossibleTrades);
        
        if (actualCount <= 0) {
            log(bot, `Trade ${index} has been used to its maximum limit`);
            return false;
        }
        
        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
            return false;
        }
        
        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);
        
        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `Successfully traded ${actualCount} time(s)`);
            return true;
        } catch (tradeErr) {
            log(bot, 'An error occurred while trying to execute the trade');
            console.log('Trade execution error:', tradeErr.message);
            return false;
        }
    } catch (err) {
        log(bot, 'Failed to open villager trading interface');
        console.log('Villager interface error:', err.message);
        return false;
    } finally {
        if (villager) {
            try { await villager.close(); } catch { /* disconnected */ }
        }
    }
}

function hasResources(window, trade, count) {
    const first = enough(trade.inputItem1, count);
    const second = !trade.inputItem2 || enough(trade.inputItem2, count);
    return first && second;

    function enough(item, count) {
        let c = 0;
        window.forEach((element) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot, trades) {
    return trades.map((trade) => {
        let text = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot, item) {
    if (!item) return 'nothing';
    let text = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench = item.nbt.value.ench;
        const StoredEnchantments = item.nbt.value.StoredEnchantments;
        const Potion = item.nbt.value.Potion;
        const display = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e) => {
                const lvl = e.lvl.value;
                const id = e.id.value;
                return bot.registry.enchantments[id].displayName + ' ' + lvl;
            }).join(' ')}`;
        }
    }
    return text;
}

export async function digDown(bot, distance = 10) {
    /**
     * Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, distance to dig down.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/

    const startBlock = bot.blockAt(bot.entity.position);
    if (!startBlock?.position) {
        log(bot, 'Cannot dig down: current block is not loaded.');
        return false;
    }
    let start_block_pos = startBlock.position;
    for (let i = 1; i <= distance; i++) {
        const targetBlock = bot.blockAt(start_block_pos.offset(0, -i, 0));
        let belowBlock = bot.blockAt(start_block_pos.offset(0, -i-1, 0));

        if (!targetBlock || !belowBlock) {
            log(bot, `Dug down ${i-1} blocks, but reached the end of the world.`);
            return true;
        }

        // Check for lava, water
        if (targetBlock.name === 'lava' || targetBlock.name === 'water' || 
            belowBlock.name === 'lava' || belowBlock.name === 'water') {
            log(bot, `Dug down ${i-1} blocks, but reached ${belowBlock ? belowBlock.name : '(lava/water)'}`);
            return false;
        }

        const MAX_FALL_BLOCKS = 2;
        let num_fall_blocks = 0;
        for (let j = 0; j <= MAX_FALL_BLOCKS; j++) {
            if (!belowBlock || (belowBlock.name !== 'air' && belowBlock.name !== 'cave_air')) {
                break;
            }
            num_fall_blocks++;
            belowBlock = bot.blockAt(belowBlock.position.offset(0, -1, 0));
        }
        if (num_fall_blocks > MAX_FALL_BLOCKS) {
            log(bot, `Dug down ${i-1} blocks, but reached a drop below the next block.`);
            return false;
        }

        if (targetBlock.name === 'air' || targetBlock.name === 'cave_air') {
            log(bot, 'Skipping air block');
            console.log(targetBlock.position);
            continue;
        }

        let dug = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
        if (!dug) {
            log(bot, 'Failed to dig block at position:' + targetBlock.position);
            return false;
        }
    };
    log(bot, `Dug down ${distance} blocks.`);
    return true;
}

export async function goToSurface(bot) {
    /**
     * Navigate to the surface (highest non-air block at current x,z).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     **/
    const pos = bot.entity.position;
    for (let y = 360; y > -64; y--) { // probably not the best way to find the surface but it works
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') {
            continue;
        }
        const reached = await goToPosition(
            bot,
            block.position.x,
            block.position.y + 1,
            block.position.z,
            1,
        );
        if (reached)
            log(bot, `Reached the surface at y=${y + 1}.`);
        return reached;
    }
    return false;
}

export async function useToolOn(bot, toolName, targetName) {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     */
    if (toolName !== 'hand' && !mc.findInventoryItem(bot, toolName) && bot.game.gameMode !== 'creative') {
        log(bot, `You do not have any ${toolName} to use.`);
        return false;
    }

    targetName = targetName.toLowerCase();
    if (targetName === 'nothing') {
        const equipped = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await bot.activateItem();
        log(bot, `Used ${toolName}.`);
    } else if (world.isEntityType(targetName)) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === targetName, 64);
        if (!entity) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z);
        if (toolName === 'hand') {
            if (!await unequipItemSafely(bot, 'hand')) return false;
        }
        else {
            const equipped = await equip(bot, toolName);
            if (!equipped) return false;
        }
        await bot.useOn(entity);
        log(bot, `Used ${toolName} on ${targetName}.`);
    } else {
        let block = null;
        if (targetName === 'water' || targetName === 'lava') {
            // we want to get liquid source blocks, not flowing blocks
            // so search for blocks with metadata 0 (not flowing)
            let blocks = world.getNearestBlocksWhere(bot, block => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${targetName}.`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
 }

 export async function useToolOnBlock(bot, toolName, block) {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

    const distance = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = () => {
        const blockInView = bot.blockAtCursor(5);
        const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView && 
            !blockInView.position.equals(block.position) && 
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    };
    const blockInView = bot.blockAtCursor(5);
    if (viewBlocked()) {
        log(bot, `Block ${blockInView.name} is in the way, moving closer...`);
        // choose random block next to target block, go to it
        const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
        await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        if (viewBlocked()) {
            const blockInView = bot.blockAtCursor(5);
            log(bot, `Block ${blockInView.name} is in the way, not using ${toolName}.`);
            return false;
        }
    }

    const equipped = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    if (toolName.includes('bucket')) {
        await bot.activateItem();
    }
    else {
        await bot.activateBlock(block);
    }
    log(bot, `Used ${toolName} on ${block.name}.`);
    return true;
 }
