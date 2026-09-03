import minecraftData from 'minecraft-data';
import settings from '../agent/settings.js';
import { createBot } from 'mineflayer';
import prismarine_items from 'prismarine-item';
import { pathfinder } from 'mineflayer-pathfinder';
import { installContainerIndex } from '../agent/library/container_index.js';
import { plugin as pvp } from 'mineflayer-pvp';
import { plugin as collectblock } from 'mineflayer-collectblock';
import { plugin as autoEat } from 'mineflayer-auto-eat';
import plugin from 'mineflayer-armor-manager';
import hawkeyePkg from 'minecrafthawkeye'; // parabolic bow aiming (bot.hawkEye), one bot per process
import * as compat from './mc_compat.js';
import { createForgeClient } from './forge_handshake.js';
const hawkeye = hawkeyePkg.default ?? hawkeyePkg; // CJS interop: the inject fn is on .default
const armorManager = plugin;
let mc_version = settings.minecraft_version;
let mcdata = mc_version && mc_version !== 'auto' ? minecraftData(mc_version) : null;
let Item = mc_version && mc_version !== 'auto' ? prismarine_items(mc_version) : null;

function patchFoodRegistry(bot) {
    const foods = bot.registry?.foodsByName;
    const items = bot.registry?.itemsByName;
    if (!foods || !items) return;
    for (const [itemName, legacyFoodName] of [
        ['carrot', 'carrots'],
        ['potato', 'potatoes'],
        ['melon', 'melon_block'],
    ]) {
        if (!foods[itemName] && foods[legacyFoodName] && items[itemName])
            foods[itemName] = { ...foods[legacyFoodName], id: items[itemName].id, name: itemName };
    }
    delete foods.wheat;
    delete foods.wheat_seeds;
}

/**
 * @typedef {string} ItemName
 * @typedef {string} BlockName
*/

export const WOOD_TYPES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'];
export const MATCHING_WOOD_BLOCKS = [
    'log',
    'planks',
    'sign',
    'boat',
    'fence_gate',
    'door',
    'fence',
    'slab',
    'stairs',
    'button',
    'pressure_plate',
    'trapdoor'
];
export const WOOL_COLORS = [
    'white',
    'orange',
    'magenta',
    'light_blue',
    'yellow',
    'lime',
    'pink',
    'gray',
    'light_gray',
    'cyan',
    'purple',
    'blue',
    'brown',
    'green',
    'red',
    'black'
];


export async function initBot(username) {
    mc_version = settings.minecraft_version;
    if (mc_version && mc_version !== 'auto') {
        mcdata = minecraftData(mc_version);
        Item = prismarine_items(mc_version);
    }
    const options = {
        username: username,
        host: settings.host,
        port: settings.port,
        auth: settings.auth,
        version: mc_version,
        checkTimeoutInterval: 60000,  // 60s keep-alive check (default 30s) — reduces disconnects on slow servers
        viewDistance: 'short',        // 4 chunks (~64 blocks) — big CPU/RAM cut for 10 bots; still covers the
                                      // 36-42 block world scans (findTarget/guardian range). Do NOT go to 'tiny'(32).
    };
    if (!mc_version || mc_version === "auto") {
        delete options.version;
    }

    const forgeOptions = settings.forge_handshake ?? {};
    const client = forgeOptions.enabled ? createForgeClient(options, forgeOptions) : null;
    const bot = createBot(client ? { ...options, client } : options);
    installContainerIndex(bot);

    // Throttle position packets to avoid kicks on Paper/Spigot servers
    // Paper enforces stricter packet rate limits than vanilla, causing ECONNRESET
    // when mineflayer sends position updates faster than 50ms apart
    let lastPositionUpdate = 0;
    let pendingPositionPacket = null;
    const POSITION_THROTTLE_MS = 50;
    const originalWrite = bot._client.write.bind(bot._client);
    bot._client.write = function(name, data) {
        if (name === 'position' || name === 'position_look' || name === 'look') {
            const now = Date.now();
            if (now - lastPositionUpdate < POSITION_THROTTLE_MS) {
                // Keep replacing the queued payload so the server receives the newest
                // position/look state, not the first stale packet in the throttle window.
                if (pendingPositionPacket) {
                    pendingPositionPacket.name = name;
                    pendingPositionPacket.data = data;
                } else {
                    const pending = { name, data, timer: null };
                    pending.timer = setTimeout(() => {
                        if (pendingPositionPacket !== pending) return;
                        pendingPositionPacket = null;
                        lastPositionUpdate = Date.now();
                        originalWrite(pending.name, pending.data);
                    }, POSITION_THROTTLE_MS - (now - lastPositionUpdate));
                    pendingPositionPacket = pending;
                }
                return;
            }
            lastPositionUpdate = now;
            if (pendingPositionPacket) {
                clearTimeout(pendingPositionPacket.timer);
                pendingPositionPacket = null;
            }
        }
        return originalWrite(name, data);
    };
    bot.once('end', () => {
        if (pendingPositionPacket) {
            clearTimeout(pendingPositionPacket.timer);
            pendingPositionPacket = null;
        }
    });

    // Suppress PartialReadError for non-critical packets
    // Paper servers sometimes send packets that node-minecraft-protocol
    // can't fully parse (scoreboard, resource_pack, custom_payload, etc.)
    // These errors crash the bot but the packets aren't needed for gameplay
    const originalEmit = bot._client.emit.bind(bot._client);
    bot._client.emit = function(event, ...args) {
        if (event === 'error' && args[0]) {
            const err = args[0];
            const errStr = err instanceof Error ? err.message : String(err);
            if (errStr.includes('PartialReadError')) {
                console.warn('[mcdata] Suppressed PartialReadError:', errStr.substring(0, 120));
                return true; // Swallow the error
            }
        }
        return originalEmit(event, ...args);
    };

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvp);
    bot.loadPlugin(collectblock);
    bot.loadPlugin(autoEat);
    bot.loadPlugin(armorManager); // auto equip armor
    try { bot.loadPlugin(hawkeye); } catch (err) { console.warn('[mcdata] hawkeye plugin failed to load:', err?.message); } // bow aiming; archers fall back to melee if missing
    bot.once('resourcePack', () => {
        bot.acceptResourcePack();
    });

    bot.once('login', () => {
        mc_version = bot.version;
        mcdata = minecraftData(mc_version);
        Item = prismarine_items(mc_version);
        patchFoodRegistry(bot);
    });

    return bot;
}

export function isBabyEntity(entity, source = null) {
    return compat.isBabyEntity(entity, currentSource(source));
}

export function isHuntable(mob) {
    if (!mob || !mob.name) return false;
    const animals = ['chicken', 'cow', 'llama', 'mooshroom', 'pig', 'rabbit', 'sheep'];
    return animals.includes(mob.name.toLowerCase()) && !isBabyEntity(mob);
}

export function isHostile(mob) {
    if (!mob || !mob.name) return false;
    const name = String(mob.name).toLowerCase();
    const activeData = mcdata
        ?? (settings.minecraft_version && settings.minecraft_version !== 'auto'
            ? minecraftData(settings.minecraft_version)
            : null);
    const definition = activeData?.entitiesByName?.[name]
        ?? (mob.entityType != null ? activeData?.entities?.[mob.entityType] : null);
    if (definition?.category)
        return definition.category === 'Hostile mobs';
    // Explicit category used by a few test/mod adapters. Unknown modded living
    // entities are handled by npc_defense only after actual aggression; treating
    // every Mineflayer `mob` as hostile also marks cows and villagers as enemies.
    return mob.type === 'hostile';
}

// blocks that don't work with collectBlock, need to be manually collected
export function mustCollectManually(blockName) {
    // all crops (that aren't normal blocks), torches, buttons, levers, redstone,
    const full_names = ['wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart', 'cocoa', 'sugar_cane', 'kelp', 'short_grass', 'tallgrass', 'fern', 'tall_grass', 'bamboo',
        'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'lilac', 'wither_rose', 'lily_of_the_valley', 'wither_rose',
        'lever', 'redstone_wire', 'lantern'];
    const partial_names = ['sapling', 'torch', 'button', 'carpet', 'pressure_plate', 'mushroom', 'tulip', 'bush', 'vines', 'fern'];
    return full_names.includes(blockName.toLowerCase()) || partial_names.some(partial => blockName.toLowerCase().includes(partial));
}

function currentSource(source = null) {
    return source ?? mc_version ?? settings.minecraft_version;
}

export function getItemSpec(itemName, source = null) {
    return compat.legacyItemSpec(itemName, currentSource(source));
}

export function getBlockSpec(blockName, source = null) {
    return compat.legacyBlockSpec(blockName, currentSource(source));
}

export const isPreFlatteningVersion = compat.isPreFlatteningVersion;
export const usesExpandedWorldHeight = compat.usesExpandedWorldHeight;
export const usesLegacyNames = compat.usesLegacyNames;
export const isBedBlock = compat.isBedBlock;
export const aliasesForLegacyStack = compat.aliasesForLegacyStack;
export const stackMatchesName = compat.stackMatchesName;
export const stackMatchesAnyName = compat.stackMatchesAnyName;
export const blockMatchesName = compat.blockMatchesName;
export const blockMatchesAnyName = compat.blockMatchesAnyName;
export const registryBlockIds = compat.registryBlockIds;
export const setBlockCommand = compat.setBlockCommand;
export const fillCommand = compat.fillCommand;

export function findInventoryItem(bot, requestedName) {
    return compat.findInventoryItem(bot, requestedName);
}

export function getItemId(itemName, source = null) {
    const registry = source?.registry?.itemsByName ? source.registry : mcdata;
    if (!registry) return null;
    const clean = compat.stripNamespaceAndState(itemName);
    let item = registry.itemsByName?.[clean];
    if (!item) {
        const spec = getItemSpec(clean, source);
        item = registry.itemsByName?.[spec.name];
    }
    if (item) {
        return item.id;
    }
    return null;
}

export function getItemMetadata(itemName, source = null) {
    const spec = getItemSpec(itemName, source);
    return spec.metadata;
}

export function getItemName(itemId) {
    if (!mcdata) return null;
    let item = mcdata.items[itemId];
    if (item) {
        return item.name;
    }
    return null;
}

export function getBlockId(blockName, source = null) {
    if (!mcdata) return null;
    const clean = compat.stripNamespaceAndState(blockName);
    let block = mcdata.blocksByName[clean];
    if (!block) {
        const spec = getBlockSpec(clean, source);
        block = mcdata.blocksByName[spec.name];
    }
    if (block) {
        return block.id;
    }
    return null;
}

export function getBlockName(blockId) {
    if (!mcdata) return null;
    let block = mcdata.blocks[blockId];
    if (block) {
        return block.name;
    }
    return null;
}

export function getEntityId(entityName) {
    if (!mcdata) return null;
    let entity = mcdata.entitiesByName[entityName];
    if (entity) {
        return entity.id;
    }
    return null;
}

export function getAllItems(ignore) {
    if (!mcdata) return [];
    if (!ignore) {
        ignore = [];
    }
    let items = [];
    for (const itemId in mcdata.items) {
        const item = mcdata.items[itemId];
        if (!ignore.includes(item.name)) {
            items.push(item);
        }
    }
    return items;
}

export function getAllItemIds(ignore) {
    const items = getAllItems(ignore);
    let itemIds = [];
    for (const item of items) {
        itemIds.push(item.id);
    }
    return itemIds;
}

export function getAllBlocks(ignore) {
    if (!mcdata) return [];
    if (!ignore) {
        ignore = [];
    }
    let blocks = [];
    for (const blockId in mcdata.blocks) {
        const block = mcdata.blocks[blockId];
        if (!ignore.includes(block.name)) {
            blocks.push(block);
        }
    }
    return blocks;
}

export function getAllBlockIds(ignore) {
    const blocks = getAllBlocks(ignore);
    let blockIds = [];
    for (const block of blocks) {
        blockIds.push(block.id);
    }
    return blockIds;
}

export function getAllBiomes() {
    return mcdata?.biomes ?? [];
}

function recipeIngredientEntry(ingredient) {
    if (ingredient == null) return null;
    if (typeof ingredient === 'number')
        return ingredient < 0 ? null : { id: ingredient, metadata: null, count: 1 };
    if (ingredient.id == null || ingredient.id < 0) return null;
    return {
        id: ingredient.id,
        metadata: ingredient.metadata ?? null,
        count: Math.max(1, Math.abs(ingredient.count ?? 1)),
    };
}

function preferredAlias(name, metadata = null) {
    const aliases = aliasesForLegacyStack(name, metadata, mc_version);
    return aliases.find(alias => alias !== name) ?? name;
}

export function recipeRequiresTable(recipe) {
    if (Array.isArray(recipe?.inShape)) {
        const rows = recipe.inShape.filter(row => Array.isArray(row) && row.some(Boolean));
        const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
        return rows.length > 2 || columns > 2;
    }
    if (Array.isArray(recipe?.ingredients))
        return recipe.ingredients.filter(ingredient => recipeIngredientEntry(ingredient)).length > 4;
    return false;
}

export function getItemCraftingRecipes(itemName) {
    let itemId = getItemId(itemName);
    if (itemId == null || !mcdata?.recipes?.[itemId]) {
        return null;
    }
    const targetMetadata = getItemMetadata(itemName);

    let recipes = [];
    for (let r of mcdata.recipes[itemId]) {
        if (targetMetadata != null && r.result?.metadata != null && r.result.metadata !== targetMetadata)
            continue;
        let recipe = {};
        let ingredients = [];
        if (r.ingredients) {
            ingredients = r.ingredients;
        } else if (r.inShape) {
            ingredients = r.inShape.flat();
        }
        for (let ingredient of ingredients) {
            const entry = recipeIngredientEntry(ingredient);
            if (!entry) continue;
            let ingredientName = getItemName(entry.id);
            if (ingredientName === null) continue;
            ingredientName = preferredAlias(ingredientName, entry.metadata);
            if (!recipe[ingredientName])
                recipe[ingredientName] = 0;
            recipe[ingredientName] += entry.count;
        }
        recipes.push([
            recipe,
            {
                craftedCount: r.result.count,
                requiresTable: recipeRequiresTable(r),
            }
        ]);
    }
    // sort recipes by if their ingredients include common items
    const commonItems = ['oak_planks', 'planks', 'oak_log', 'log', 'coal', 'cobblestone'];
    recipes.sort((a, b) => {
        let commonCountA = Object.keys(a[0]).filter(key => commonItems.includes(key)).reduce((acc, key) => acc + a[0][key], 0);
        let commonCountB = Object.keys(b[0]).filter(key => commonItems.includes(key)).reduce((acc, key) => acc + b[0][key], 0);
        return commonCountB - commonCountA;
    });

    return recipes;
}

export function isSmeltable(itemName) {
    const spec = getItemSpec(itemName);
    const name = spec.name;
    const misc_smeltables = ['beef', 'chicken', 'cod', 'fish', 'mutton', 'porkchop', 'rabbit', 'salmon', 'tropical_fish', 'potato', 'kelp', 'sand', 'cobblestone', 'clay_ball'];
    return itemName.includes('raw') || ['iron_ore', 'gold_ore'].includes(name)
        || name.includes('log') || misc_smeltables.includes(itemName) || misc_smeltables.includes(name);
}

export function getSmeltingFuel(bot) {
    let fuel = bot.inventory.items().find(i => i.name === 'coal' || i.name === 'charcoal' || i.name === 'blaze_rod');
    if (fuel)
        return fuel;
    fuel = bot.inventory.items().find(i => i.name.includes('log') || i.name.includes('planks'));
    if (fuel)
        return fuel;
    return bot.inventory.items().find(i => i.name === 'coal_block' || i.name === 'lava_bucket');
}

export function getFuelSmeltOutput(fuelName) {
    if (fuelName === 'coal' || fuelName === 'charcoal')
        return 8;
    if (fuelName === 'blaze_rod')
        return 12;
    if (fuelName.includes('log') || fuelName.includes('planks'))
        return 1.5;
    if (fuelName === 'coal_block')
        return 80;
    if (fuelName === 'lava_bucket')
        return 100;
    return 0;
}

export function getItemSmeltingIngredient(itemName) {
    return {    
        baked_potato: 'potato',
        cooked_beef: 'beef',
        cooked_chicken: 'chicken',
        cooked_cod: 'cod',
        cooked_mutton: 'mutton',
        cooked_porkchop: 'porkchop',
        cooked_rabbit: 'rabbit',
        cooked_salmon: 'salmon',
        dried_kelp: 'kelp',
        iron_ingot: 'raw_iron',
        gold_ingot: 'raw_gold',
        copper_ingot: 'raw_copper',
        glass: 'sand'
    }[itemName];
}

export function getItemBlockSources(itemName) {
    let itemId = getItemId(itemName);
    if (itemId == null) return [];
    let sources = [];
    for (let block of getAllBlocks()) {
        const drops = (block.drops ?? []).map(drop => typeof drop === 'number' ? drop : drop?.drop);
        if (drops.includes(itemId)) {
            sources.push(block.name);
        }
    }
    return sources;
}

export function getItemAnimalSource(itemName) {
    return {    
        beef: 'cow',
        chicken: 'chicken',
        cod: 'cod',
        feather: 'chicken',
        mutton: 'sheep',
        porkchop: 'pig',
        rabbit: 'rabbit',
        salmon: 'salmon',
        leather: 'cow',
        string: 'spider',
        wool: 'sheep'
    }[itemName];
}

export function getBlockTool(blockName) {
    if (!mcdata) return null;
    const spec = getBlockSpec(blockName);
    let block = mcdata.blocksByName[spec.name];
    if (!block || !block.harvestTools) {
        return null;
    }
    return getItemName(Object.keys(block.harvestTools)[0]);  // Double check first tool is always simplest
}

export function makeItem(name, amount=1) {
    if (!Item) return null;
    const itemId = getItemId(name);
    if (itemId == null) return null;
    return new Item(itemId, amount, getItemMetadata(name) ?? 0);
}

/**
 * Returns the number of ingredients required to use the recipe once.
 * 
 * @param {Recipe} recipe
 * @returns {Object<mc.ItemName, number>} an object describing the number of each ingredient.
 */
export function ingredientsFromPrismarineRecipe(recipe) {
    let requiredIngedients = {};
    if (recipe.inShape)
        for (const ingredient of recipe.inShape.flat()) {
            if(ingredient.id<0) continue; //prismarine-recipe uses id -1 as an empty crafting slot
            const ingredientName = getItemName(ingredient.id);
            requiredIngedients[ingredientName] ??=0;
            requiredIngedients[ingredientName] += ingredient.count;
        }
    if (recipe.ingredients)
        for (const ingredient of recipe.ingredients) {
            if(ingredient.id<0) continue;
            const ingredientName = getItemName(ingredient.id);
            requiredIngedients[ingredientName] ??=0;
            requiredIngedients[ingredientName] -= ingredient.count;
            //Yes, the `-=` is intended.
            //prismarine-recipe uses positive numbers for the shaped ingredients but negative for unshaped.
            //Why this is the case is beyond my understanding.
        }
    return requiredIngedients;
}

/**
 * Calculates the number of times an action, such as a crafing recipe, can be completed before running out of resources.
 * @template T - doesn't have to be an item. This could be any resource.
 * @param {Object.<T, number>} availableItems - The resources available; e.g, `{'cobble_stone': 7, 'stick': 10}`
 * @param {Object.<T, number>} requiredItems - The resources required to complete the action once; e.g, `{'cobble_stone': 3, 'stick': 2}`
 * @param {boolean} discrete - Is the action discrete?
 * @returns {{num: number, limitingResource: (T | null)}} the number of times the action can be completed and the limmiting resource; e.g `{num: 2, limitingResource: 'cobble_stone'}`
 */
export function calculateLimitingResource(availableItems, requiredItems, discrete=true) {
    let limitingResource = null;
    let num = Infinity;
    for (const itemType in requiredItems) {
        if (requiredItems[itemType] <= 0) continue;
        const available = availableItems[itemType] ?? 0;
        if (available < requiredItems[itemType] * num) {
            limitingResource = itemType;
            num = available / requiredItems[itemType];
        }
    }
    if (!Number.isFinite(num)) num = 0;
    if(discrete) num = Math.floor(num);
    return {num, limitingResource};
}

let loopingItems = new Set();

export function initializeLoopingItems() {

    loopingItems = new Set(['coal',
        'wheat',
        'bone_meal',
        'diamond',
        'emerald',
        'raw_iron',
        'raw_gold',
        'redstone',
        'blue_wool',
        'packed_mud',
        'raw_copper',
        'iron_ingot',
        'dried_kelp',
        'gold_ingot',
        'slime_ball',
        'black_wool',
        'quartz_slab',
        'copper_ingot',
        'lapis_lazuli',
        'honey_bottle',
        'rib_armor_trim_smithing_template',
        'eye_armor_trim_smithing_template',
        'vex_armor_trim_smithing_template',
        'dune_armor_trim_smithing_template',
        'host_armor_trim_smithing_template',
        'tide_armor_trim_smithing_template',
        'wild_armor_trim_smithing_template',
        'ward_armor_trim_smithing_template',
        'coast_armor_trim_smithing_template',
        'spire_armor_trim_smithing_template',
        'snout_armor_trim_smithing_template',
        'shaper_armor_trim_smithing_template',
        'netherite_upgrade_smithing_template',
        'raiser_armor_trim_smithing_template',
        'sentry_armor_trim_smithing_template',
        'silence_armor_trim_smithing_template',
        'wayfinder_armor_trim_smithing_template']);
}


/**
 * Gets a detailed plan for crafting an item considering current inventory
 */
export function getDetailedCraftingPlan(targetItem, count = 1, current_inventory = {}) {
    initializeLoopingItems();
    if (!targetItem || count <= 0 || !getItemId(targetItem)) {
        return "Invalid input. Please provide a valid item name and positive count.";
    }

    if (isBaseItem(targetItem)) {
        const available = current_inventory[targetItem] || 0;
        if (available >= count) return "You have all required items already in your inventory!";
        return `${targetItem} is a base item, you need to find ${count - available} more in the world`;
    }

    const inventory = { ...current_inventory };
    const leftovers = {};
    const plan = craftItem(targetItem, count, inventory, leftovers);
    return formatPlan(targetItem, plan);
}

function isBaseItem(item) {
    return loopingItems.has(item) || getItemCraftingRecipes(item) === null;
}

function craftItem(item, count, inventory, leftovers, crafted = { required: {}, steps: [], leftovers: {} }) {
    // Check available inventory and leftovers first
    const availableInv = inventory[item] || 0;
    const availableLeft = leftovers[item] || 0;
    const totalAvailable = availableInv + availableLeft;

    if (totalAvailable >= count) {
        // Use leftovers first, then inventory
        const useFromLeft = Math.min(availableLeft, count);
        leftovers[item] = availableLeft - useFromLeft;
        
        const remainingNeeded = count - useFromLeft;
        if (remainingNeeded > 0) {
            inventory[item] = availableInv - remainingNeeded;
        }
        return crafted;
    }

    // Use whatever is available
    const stillNeeded = count - totalAvailable;
    if (availableLeft > 0) leftovers[item] = 0;
    if (availableInv > 0) inventory[item] = 0;

    if (isBaseItem(item)) {
        crafted.required[item] = (crafted.required[item] || 0) + stillNeeded;
        return crafted;
    }

    const recipe = getItemCraftingRecipes(item)?.[0];
    if (!recipe) {
        crafted.required[item] = stillNeeded;
        return crafted;
    }

    const [ingredients, result] = recipe;
    const craftedPerRecipe = result.craftedCount;
    const batchCount = Math.ceil(stillNeeded / craftedPerRecipe);
    const totalProduced = batchCount * craftedPerRecipe;

    // Add excess to leftovers
    if (totalProduced > stillNeeded) {
        leftovers[item] = (leftovers[item] || 0) + (totalProduced - stillNeeded);
    }

    // Process each ingredient
    for (const [ingredientName, ingredientCount] of Object.entries(ingredients)) {
        const totalIngredientNeeded = ingredientCount * batchCount;
        craftItem(ingredientName, totalIngredientNeeded, inventory, leftovers, crafted);
    }

    // Add crafting step
    const stepIngredients = Object.entries(ingredients)
        .map(([name, amount]) => `${amount * batchCount} ${name}`)
        .join(' + ');
    crafted.steps.push(`Craft ${stepIngredients} -> ${totalProduced} ${item}`);

    return crafted;
}

function formatPlan(targetItem, { required, steps, leftovers }) {
    const lines = [];

    if (Object.keys(required).length > 0) {
        lines.push('You are missing the following items:');
        Object.entries(required).forEach(([item, count]) => 
            lines.push(`- ${count} ${item}`));
        lines.push('\nOnce you have these items, here\'s your crafting plan:');
    } else {
        lines.push('You have all items required to craft this item!');
        lines.push('Here\'s your crafting plan:');
    }

    lines.push('');
    lines.push(...steps);

    if (Object.keys(required).some(item => item.includes('oak')) && !targetItem.includes('oak')) {
        lines.push('Note: Any varient of wood can be used for this recipe.');
    }

    if (Object.keys(leftovers).length > 0) {
        lines.push('\nYou will have leftover:');
        Object.entries(leftovers).forEach(([item, count]) => 
            lines.push(`- ${count} ${item}`));
    }

    return lines.join('\n');
}
