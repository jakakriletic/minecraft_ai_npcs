// Shared enchanting service. Any member with XP can use it; a lock keeps the table
// single-user. Equipment and lapis come from public storage and are returned there.
import { Vec3 } from 'vec3';
import * as storage from './storage.js';
import * as society from './society.js';
import * as skills from './skills.js';
import { withNamedLock } from './container_lock.js';
import settings from '../../../settings.js';
import * as mc from '../../utils/mcdata.js';

const TIERS = new Set(['iron', 'diamond', 'netherite']);
const TOOL_TYPES = new Set(['sword', 'pickaxe', 'axe', 'shovel', 'hoe']);
const STANDALONE = new Set(['bow', 'crossbow', 'trident', 'fishing_rod']);
const ARMOR_TYPES = new Set(['helmet', 'chestplate', 'leggings', 'boots']);

function hasEnchantments(item) {
    try { return (item?.enchants?.length ?? 0) > 0; }
    catch { return false; }
}

function isEnchantableEquipment(item) {
    if (!item || hasEnchantments(item)) return false;
    if (STANDALONE.has(item.name)) return true;
    const [tier, ...rest] = item.name.split('_');
    const kind = rest.join('_');
    return TIERS.has(tier) && (TOOL_TYPES.has(kind) || ARMOR_TYPES.has(kind));
}

function findEnchantingTable(bot, shared) {
    const id = bot.registry.blocksByName.enchanting_table?.id;
    if (!Number.isInteger(id)) return null;
    return bot.findBlock({
        point: new Vec3(shared.x, shared.y, shared.z),
        matching: id,
        maxDistance: Math.max(48, shared.radius + 16),
    });
}

async function waitForChoices(table, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (table.enchantments?.every(option => option.level >= 0))
            return table.enchantments;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
}

function chooseEnchant(options, xpLevel, lapisCount) {
    for (let choice = 2; choice >= 0; choice--) {
        const option = options?.[choice];
        if (option?.level > 0 && xpLevel >= option.level && lapisCount >= choice + 1)
            return choice;
    }
    return -1;
}

function inventorySlotInWindow(window, inventorySlot) {
    if (!Number.isInteger(inventorySlot)) return null;
    let playerIndex;
    if (inventorySlot >= 9 && inventorySlot <= 35)
        playerIndex = inventorySlot - 9;
    else if (inventorySlot >= 36 && inventorySlot <= 44)
        playerIndex = 27 + inventorySlot - 36;
    else
        return null;
    return window.slots?.[window.inventoryStart + playerIndex] ?? null;
}

async function recoverTableItems(bot, table) {
    if (!table) return null;
    let recovered = null;
    try {
        if (table.targetItem()) recovered = await table.takeTargetItem();
    } catch { /* window may already be closed */ }
    try {
        const lapis = table.slots?.[1];
        if (lapis) await bot.putAway(lapis.slot);
    } catch { /* window may already be closed */ }
    try { table.close(); } catch { /* disconnected */ }
    return recovered;
}

function sameNbt(a, b) {
    try { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }
    catch { return false; }
}

async function returnEquipmentAndLapis(bot, selected, recovered) {
    const preferred = Number.isInteger(selected.slot) ? bot.inventory.slots[selected.slot] : null;
    const targetNbt = recovered?.nbt ?? selected.nbt;
    const equipment = preferred?.name === selected.name
        ? preferred
        : bot.inventory.items().find(item =>
            item.name === selected.name && sameNbt(item.nbt, targetNbt));
    if (equipment) await storage.depositPublicItem(bot, equipment, 1);
    const lapis = bot.inventory.items().find(item => mc.stackMatchesName(item, 'lapis_lazuli', bot));
    if (lapis) await storage.depositPublicItem(bot, lapis, lapis.count);
}

export function canTryEnchanting(agent) {
    return settings.kingdom_enchanting !== false
        && Boolean(storage.getPublicStorage(agent.bot))
        && (agent.bot.experience?.level ?? 0) >= 1;
}

export async function enchantFromPublicStorage(agent) {
    if (!canTryEnchanting(agent)) return false;
    const bot = agent.bot;
    const result = await withNamedLock(bot, 'kingdom-enchanting', async () => {
        const shared = storage.getPublicStorage(bot);
        if (!shared || !await storage.goToPublicStorage(bot)) return false;
        const enchantingTable = findEnchantingTable(bot, shared);
        if (!enchantingTable) return false;

        await storage.takeNeededPublic(bot, { lapis_lazuli: 3 });
        if (!bot.inventory.items().some(item => mc.stackMatchesName(item, 'lapis_lazuli', bot))) return false;

        const selected = await storage.takeOnePublicMatching(bot, isEnchantableEquipment);
        if (!selected) return false;

        let table = null;
        let enchanted = false;
        try {
            if (!await skills.goToPosition(
                bot,
                enchantingTable.position.x,
                enchantingTable.position.y,
                enchantingTable.position.z,
                2,
            )) return false;

            table = await bot.openEnchantmentTable(enchantingTable);
            const equipment = inventorySlotInWindow(table, selected.slot);
            const lapis = table.items().find(item => mc.stackMatchesName(item, 'lapis_lazuli', bot));
            if (!equipment || equipment.name !== selected.name
                || !isEnchantableEquipment(equipment) || !lapis)
                return false;

            await table.putTargetItem(equipment);
            await table.putLapis(lapis);
            const choices = await waitForChoices(table);
            const choice = chooseEnchant(
                choices,
                bot.experience?.level ?? 0,
                table.slots?.[1]?.count ?? 0,
            );
            if (choice < 0) return false;

            await Promise.race([
                table.enchant(choice),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('enchanting timed out')), 10_000)),
            ]);
            enchanted = true;
            return true;
        } catch (error) {
            console.warn(`[enchant ${agent.name}] ${error.message}`);
            return false;
        } finally {
            const recovered = await recoverTableItems(bot, table);
            await returnEquipmentAndLapis(bot, selected, recovered);
            if (enchanted) {
                const text = `${agent.name} je za naselbino zacaral ${selected.name}.`;
                await society.recordEvent(bot, 'enchanting', agent.name, text);
                skills.log(bot, text);
            }
        }
    }, 5000);
    return result.locked && result.value;
}
