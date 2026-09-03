import * as mcCompat from '../../utils/mc_compat.js';

export const FOOD_NAMES = [
    'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    'baked_potato', 'apple', 'carrot', 'potato', 'cooked_cod', 'cooked_salmon',
    'cooked_fish', 'fish', 'cooked_rabbit',
];

export const PREPARED_FOOD_NAMES = [
    'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    'baked_potato', 'apple', 'carrot', 'cooked_cod', 'cooked_salmon',
    'cooked_fish', 'cooked_rabbit',
];

export const BANNED_AUTO_FOOD = [
    'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken',
];

export function patchLegacyFoodRegistry(bot) {
    const foods = bot?.registry?.foodsByName;
    const items = bot?.registry?.itemsByName;
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

export function foodItems(bot) {
    return (bot?.inventory?.items?.() ?? [])
        .filter(item => mcCompat.stackMatchesAnyName(item, FOOD_NAMES, bot));
}

export function countFood(bot) {
    return foodItems(bot).reduce((sum, item) => sum + Number(item.count ?? 0), 0);
}

export function countPreparedFood(bot) {
    return (bot?.inventory?.items?.() ?? [])
        .filter(item => mcCompat.stackMatchesAnyName(item, PREPARED_FOOD_NAMES, bot))
        .reduce((sum, item) => sum + Number(item.count ?? 0), 0);
}

export function firstFood(bot) {
    return foodItems(bot)[0] ?? null;
}

export function minecraftSatiety(bot) {
    const food = Number(bot?.food);
    return Number.isFinite(food) ? clamp(food * 5, 0, 100) : null;
}

// `potrebe.sitost` is the RP-facing 0..100 representation of Minecraft's real
// 0..20 hunger bar. Keeping one source of truth prevents a physically full bot
// from being "RP hungry" (and unable to consume), or the reverse.
export function syncSatiety(npc, { save = true } = {}) {
    const next = minecraftSatiety(npc?.bot);
    const needs = npc?.state?.data?.potrebe;
    if (next === null || !needs) return false;
    if (Number(needs.sitost) === next) return false;
    needs.sitost = next;
    if (save) npc.state.save();
    return true;
}

export function needsFoodNow(npc, threshold = 18) {
    const realFood = Number(npc?.bot?.food);
    if (Number.isFinite(realFood)) return realFood <= threshold;
    return Number(npc?.state?.data?.potrebe?.sitost ?? 100) <= threshold * 5;
}

export async function eatAvailableFood(npc) {
    const bot = npc?.bot;
    if (!bot?.entity) return { success: false, ate: false, detail: 'NPC ni online' };

    const beforeFood = Number(bot.food ?? 20);
    if (beforeFood >= 20) {
        syncSatiety(npc);
        return { success: true, ate: false, detail: 'Minecraft hunger je ze poln' };
    }

    const food = firstFood(bot);
    if (!food) return { success: false, ate: false, detail: 'ni hrane v inventarju' };

    try {
        if (bot.autoEat?.isEating) {
            await waitFor(() => !bot.autoEat?.isEating, 3000);
        } else if (typeof bot.autoEat?.eat === 'function') {
            const started = await bot.autoEat.eat();
            if (started === false && Number(bot.food ?? 20) < 20) {
                await bot.equip(food, 'hand');
                await bot.consume();
            }
        } else {
            await bot.equip(food, 'hand');
            await bot.consume();
        }
    } catch (error) {
        syncSatiety(npc);
        return { success: false, ate: false, detail: `ne more pojesti ${food.name}: ${error.message}` };
    }

    syncSatiety(npc);
    const afterFood = Number(bot.food ?? beforeFood);
    return {
        success: afterFood > beforeFood,
        ate: afterFood > beforeFood,
        item: food.name,
        detail: afterFood > beforeFood ? `pojedel ${food.name}` : `${food.name} ni povecal hungerja`,
    };
}

// Physical handoff: the donor walks to an idle recipient and drops one food item
// directly beside them. The recipient's scheduler is briefly locked, but its
// auto-eat plugin remains active and can consume the pickup immediately.
export async function transferFood(from, to, { gotoNear, sleep, timeoutMs = 6000 } = {}) {
    const food = firstFood(from?.bot);
    if (!food || !to?.bot?.entity) return { success: false, detail: 'ni hrane ali cilja' };
    if (to.busy || to.defending || to.command || to.bot.isSleeping)
        return { success: false, detail: 'cilj je zaposlen' };

    if (from.bot.entity.position.distanceTo(to.bot.entity.position) > 3) {
        const reached = await gotoNear(from.bot, to.bot.entity.position, 2, from.log, 14_000);
        if (!reached || !to.bot?.entity || from.bot.entity.position.distanceTo(to.bot.entity.position) > 4)
            return { success: false, detail: 'ni prisel do cilja' };
    }

    const beforeCount = countMatching(to.bot, food);
    const beforeHunger = Number(to.bot.food ?? 20);
    const wasBusy = Boolean(to.busy);
    to.busy = true;
    try {
        await from.bot.toss(food.type, food.metadata ?? null, 1);
        const received = await waitFor(() =>
            countMatching(to.bot, food) > beforeCount || Number(to.bot.food ?? beforeHunger) > beforeHunger,
        timeoutMs, sleep);
        if (!received) return { success: false, detail: 'hrana je padla, cilj je ni pobral' };

        let meal = null;
        if (needsFoodNow(to)) meal = await eatAvailableFood(to);
        syncSatiety(to);
        const ate = Boolean(meal?.ate) || Number(to.bot.food ?? beforeHunger) > beforeHunger;
        return {
            success: true,
            item: food.name,
            ate,
            detail: ate
                ? `prevzel in pojedel ${food.name}`
                : `prevzel ${food.name}`,
        };
    } catch (error) {
        return { success: false, detail: `predaja hrane ni uspela: ${error.message}` };
    } finally {
        to.busy = wasBusy;
    }
}

function countMatching(bot, reference) {
    return (bot?.inventory?.items?.() ?? [])
        .filter(item => item.type === reference.type && item.metadata === reference.metadata)
        .reduce((sum, item) => sum + Number(item.count ?? 0), 0);
}

async function waitFor(predicate, timeoutMs, sleepFn = null) {
    const pause = sleepFn ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await pause(100);
    }
    return Boolean(predicate());
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
