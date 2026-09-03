import { gotoNear, sleep } from '../core/movement.js';
import { withChestLock } from '../core/storage.js';
import { pickupNearbyGold } from '../systems/economy.js';
import { withdrawFromRegions } from '../systems/routines.js';
import { countFood, countPreparedFood, minecraftSatiety, PREPARED_FOOD_NAMES, transferFood } from '../systems/food.js';
import { notePositiveInteraction } from '../systems/social_bonds.js';
import { addCivicEvent, ensureInRegion, rememberJobBeat, wanderInRegion } from './common.js';
import { openFurnaceAttempt } from '../../agent/library/skills.js';
import * as mcCompat from '../../utils/mc_compat.js';

const SERVE_COOLDOWN_MS = 75_000;
const RESTOCK_COOLDOWN_MS = 90_000;
const HUNGER_THRESHOLD = 90;
const MAX_SERVE_DISTANCE = 32;
const RAW_COOKABLE = ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'fish', 'cod', 'salmon', 'potato'];
const FUEL_NAMES = ['coal', 'charcoal'];

export async function cookStep(npc) {
    const st = (npc.jobState ??= { lastServeAt: 0, lastStockAt: 0 });
    if (!await ensureInRegion(npc, npc.cfg.job_region)) return;
    await pickupNearbyGold(npc);

    if (countPreparedFood(npc.bot) < 4 && Date.now() - st.lastStockAt > RESTOCK_COOLDOWN_MS) {
        const stock = await withdrawFromRegions(npc, PREPARED_FOOD_NAMES, 8, ['mestna_zaloga', 'gostilna', npc.cfg.home_region]);
        let prepared = { success: false, detail: 'ni bilo sestavin' };
        if (!stock.complete && countPreparedFood(npc.bot) < 4)
            prepared = await prepareFood(npc, 6);
        const success = stock.success || prepared.success;
        st.lastStockAt = success ? Date.now() : Date.now() - RESTOCK_COOLDOWN_MS + 15_000;
        const detail = [
            stock.success ? `vzela ${stock.count} pripravljene hrane` : null,
            prepared.success ? prepared.detail : null,
        ].filter(Boolean).join('; ') || 'ni nasla hrane ali sestavin za kuhinjo';
        rememberJobBeat(npc, 'cook_stock', detail, { stock, prepared });
        return;
    }

    const target = chooseHungryTarget(npc);
    if (target && Date.now() - st.lastServeAt > SERVE_COOLDOWN_MS && countFood(npc.bot) > 0) {
        const served = await serveFood(npc, target);
        st.lastServeAt = served.success ? Date.now() : Date.now() - SERVE_COOLDOWN_MS + 15_000;
        rememberJobBeat(npc, 'cook_serve', served.success ? `nahranila ${target.cfg.osebnost.ime}` : served.detail, {
            target: target.cfg.id,
            success: served.success,
        });
        return;
    }

    await wanderInRegion(npc, npc.cfg.job_region, 18_000, 45_000);
}

async function prepareFood(npc, targetCount) {
    const regions = ['mestna_zaloga', 'gostilna', npc.cfg.home_region];
    const missing = Math.max(1, targetCount - countPreparedFood(npc.bot));

    await withdrawFromRegions(npc, ['wheat'], missing * 3, regions);
    if (await craftBread(npc, missing)) {
        return { success: true, detail: `spekel/a kruh; pripravljena hrana ${countPreparedFood(npc.bot)}` };
    }

    await withdrawFromRegions(npc, RAW_COOKABLE, Math.min(3, missing), regions);
    await withdrawFromRegions(npc, FUEL_NAMES, 1, regions);
    if (await cookRawFood(npc, Math.min(3, missing))) {
        return { success: true, detail: `skuhal/a hrano; pripravljena hrana ${countPreparedFood(npc.bot)}` };
    }
    return { success: false, detail: 'ni uspelo narediti kruha ali skuhati surove hrane' };
}

async function craftBread(npc, wanted) {
    const bot = npc.bot;
    const wheat = inventoryCount(bot, ['wheat']);
    const crafts = Math.min(Math.floor(wheat / 3), Math.max(1, wanted));
    if (crafts < 1) return false;

    const tableIds = mcCompat.registryBlockIds(bot, ['crafting_table', 'workbench']);
    const positions = bot.findBlocks({
        point: npc.region(npc.cfg.job_region).center,
        matching: tableIds,
        maxDistance: 16,
        count: 4,
    });
    for (const position of positions) {
        const table = bot.blockAt(position);
        if (!table) continue;
        if (bot.entity.position.distanceTo(table.position) > 4 &&
            !await gotoNear(bot, table.position, 3, npc.log, 10_000)) continue;
        const bread = bot.registry.itemsByName.bread;
        const recipe = bread && bot.recipesFor(bread.id, null, 1, table)[0];
        if (!recipe) continue;
        const before = countPreparedFood(bot);
        try {
            await bot.craft(recipe, crafts, table);
            if (countPreparedFood(bot) > before) return true;
        } catch (error) {
            npc.log.warn(`craft bread failed: ${error.message}`);
        }
    }
    return false;
}

async function cookRawFood(npc, wanted) {
    const bot = npc.bot;
    const raw = bot.inventory.items().find(item => mcCompat.stackMatchesAnyName(item, RAW_COOKABLE, bot));
    const fuel = bot.inventory.items().find(item => mcCompat.stackMatchesAnyName(item, FUEL_NAMES, bot));
    if (!raw || !fuel) return false;

    const furnaceIds = mcCompat.registryBlockIds(bot, ['furnace', 'lit_furnace']);
    const positions = bot.findBlocks({
        point: npc.region(npc.cfg.job_region).center,
        matching: furnaceIds,
        maxDistance: 16,
        count: 4,
    });
    for (const position of positions) {
        const block = bot.blockAt(position);
        if (!block) continue;
        if (bot.entity.position.distanceTo(block.position) > 4 &&
            !await gotoNear(bot, block.position, 3, npc.log, 10_000)) continue;
        const key = `furnace:${block.position.x},${block.position.y},${block.position.z}`;
        const before = countPreparedFood(bot);
        try {
            await withChestLock(key, async () => {
                let furnace;
                try {
                    furnace = await openFurnaceAttempt(bot, block, 6000);
                    if (furnace.outputItem()) await furnace.takeOutput();
                    if (furnace.inputItem()) return;
                    const amount = Math.min(Number(raw.count ?? 0), Math.max(1, wanted));
                    if (!furnace.fuelItem() && Number(furnace.fuelSeconds ?? furnace.fuel ?? 0) <= 0)
                        await furnace.putFuel(fuel.type, fuel.metadata, 1);
                    await furnace.putInput(raw.type, raw.metadata, amount);
                    const deadline = Date.now() + amount * 11_000 + 3000;
                    while (Date.now() < deadline) {
                        await sleep(500);
                        if (furnace.outputItem()) await furnace.takeOutput();
                        if (!furnace.inputItem()) break;
                    }
                    if (furnace.inputItem()) {
                        try { await furnace.takeInput(); } catch { /* retry next work step */ }
                    }
                } finally {
                    if (furnace) try { await furnace.close(); } catch { /* disconnected */ }
                }
            });
        } catch (error) {
            npc.log.warn(`cook furnace failed: ${error.message}`);
        }
        if (countPreparedFood(bot) > before) return true;
    }
    return false;
}

function inventoryCount(bot, names) {
    return bot.inventory.items()
        .filter(item => mcCompat.stackMatchesAnyName(item, names, bot))
        .reduce((sum, item) => sum + Number(item.count ?? 0), 0);
}

export function chooseHungryTarget(npc, threshold = HUNGER_THRESHOLD) {
    const bot = npc.bot;
    if (!bot?.entity) return null;
    return (npc.registry ?? [])
        .filter(other => other !== npc && other.bot?.entity && !other.bot.isSleeping && other.currentActivity !== 'jail')
        .filter(other => !other.busy && !other.defending && !other.command)
        .map(other => ({
            npc: other,
            hunger: minecraftSatiety(other.bot) ?? Number(other.state?.data?.potrebe?.sitost ?? 100),
            distance: other.bot.entity.position.distanceTo(bot.entity.position),
        }))
        .filter(entry => entry.hunger < threshold && entry.distance <= MAX_SERVE_DISTANCE)
        .sort((a, b) => (a.hunger - b.hunger) || (a.distance - b.distance))[0]?.npc ?? null;
}

async function serveFood(cook, target) {
    const served = await transferFood(cook, target, { gotoNear, sleep });
    if (!served.success) return served;
    notePositiveInteraction(cook, target, 'cook_served_food', 1.2);
    addCivicEvent(cook, 'meal_served', `${cook.cfg.osebnost.ime} je nahranila ${target.cfg.osebnost.ime}.`, {
        target: target.cfg.id,
        item: served.item,
        ate: served.ate,
    }, `meal:${target.cfg.id}`, 120_000);
    if (Math.random() < 0.35) cook.bot.chat(`${target.cfg.osebnost.ime}, jej najprej. Potem delo.`);
    return served;
}
