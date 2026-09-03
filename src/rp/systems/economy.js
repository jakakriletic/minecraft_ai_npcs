// Physical-gold economy. Money is NOT an abstract number:
//   gold_nugget = 1 unit, gold_ingot = 9 (vanilla craft ratio).
// An NPC's money = gold actually in its inventory + home storage (via storage_index).
// Wages are paid in physical gold withdrawn from the town chest (region "obcina").
import { gotoChestInRegion } from '../core/storage.js';
import { gotoRegion, gotoNear, sleep } from '../core/movement.js';
import { FOOD_NAMES } from './food.js';
import { Vec3 } from 'vec3';

export const NUGGET = 'gold_nugget';
export const INGOT = 'gold_ingot';

export function inventoryMoney(bot) {
    let total = 0;
    for (const it of bot.inventory.items()) {
        if (it.name === NUGGET) total += it.count;
        if (it.name === INGOT) total += it.count * 9;
    }
    return total;
}

export function storedMoney(npc) {
    // only chests in the NPC's OWN home count as its money (the index also
    // tracks town/delivery chests it has touched — those aren't its property)
    const home = npc.cfg.home_region;
    return npc.storage.totalOf(NUGGET, home) + npc.storage.totalOf(INGOT, home) * 9;
}

export function totalMoney(npc) {
    return inventoryMoney(npc.bot) + storedMoney(npc);
}

// Collect today's wage from the town chest. Returns nuggets collected.
export async function collectWage(npc, economy) {
    const wage = economy.place?.[npc.cfg.job] ?? 0;
    if (wage <= 0) return 0;

    const region = npc.locations[economy.obcinska_skrinja_regija ?? 'obcina'];
    if (!region) { npc.log.warn('wage: no town chest region configured'); return 0; }

    const chest = await gotoChestInRegion(
        npc.bot, region, npc.storage, npc.log, Object.values(npc.cfg.chests ?? {}));
    if (!chest) { npc.log.warn('wage: no chest found at town hall'); return 0; }

    // prefer nuggets, fall back to ingots (1 ingot = 9)
    let got = await npc.storage.withdraw(npc.bot, chest, NUGGET, wage, 'obcina');
    let remaining = wage - got;
    if (remaining > 0) {
        const ingots = Math.ceil(remaining / 9);
        const gotIngots = await npc.storage.withdraw(npc.bot, chest, INGOT, ingots, 'obcina');
        got += gotIngots * 9;
    }
    if (got === 0) {
        npc.log.warn('wage: TOWN CHEST EMPTY — no pay today');
        npc.bot.chat('Spet ni plače? Občina je čisto propadla.');
    } else {
        npc.log.info(`wage: collected ${got} (target ${wage}) from town chest`);
    }
    return got;
}

// Pay for a meal at the inn: walk there, toss the gold on the ground near the
// innkeeper (physical hand-over — innkeeper or anyone nearby picks it up).
// Returns true if paid.
export async function payAtInn(npc, economy) {
    const price = economy.cena_obroka ?? 3;
    const region = npc.locations['gostilna'];
    if (!region) return false;
    if (countItem(npc.bot, NUGGET) < price) return false;

    const ok = await gotoRegion(npc.bot, region, npc.log);
    if (!ok) return false;

    // A meal is a real item, not a timer plus an artificial satiety increase.
    // Search the inn's chests until one edible item is actually withdrawn.
    let meal = null;
    const preferred = Object.values(npc.cfg.chests ?? {});
    const chests = orderedRegionChests(npc, region, preferred);
    for (const chest of chests) {
        if (npc.bot.entity.position.distanceTo(chest.position) > 4 &&
            !await gotoNear(npc.bot, chest.position, 3, npc.log, 10_000)) continue;
        const result = await npc.storage.withdrawMatching(npc.bot, chest, FOOD_NAMES, 1, 'gostilna');
        if (result.count > 0) { meal = Object.keys(result.items)[0] ?? 'food'; break; }
    }
    if (!meal) {
        npc.log.warn('payAtInn: gostilna nima hrane v skrinjah');
        return false;
    }

    // Toss `price` worth of nuggets after a physical meal was secured.
    const bot = npc.bot;
    let toPay = price;
    for (const it of bot.inventory.items().filter(i => i.name === NUGGET)) {
        if (toPay <= 0) break;
        const n = Math.min(it.count, toPay);
        try {
            await bot.toss(it.type, null, n);
            toPay -= n;
        } catch (e) { npc.log.warn(`payAtInn: toss failed: ${e.message}`); break; }
    }
    if (toPay > 0) return false;
    npc.log.info(`paid ${price} nuggets at the inn for ${meal}`);
    await sleep(300);
    return true;
}

// Pick up gold items lying within a few blocks (innkeeper collecting payment, etc.)
export async function pickupNearbyGold(npc) {
    const bot = npc.bot;
    const drops = Object.values(bot.entities).filter(e =>
        e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < 6);
    for (const d of drops.slice(0, 3)) {
        try {
            await gotoNear(bot, d.position, 1, npc.log, 4000);
        } catch { /* despawned/unreachable */ }
    }
}

function orderedRegionChests(npc, region, preferredPositions) {
    const result = [];
    const seen = new Set();
    const add = block => {
        if (!block?.position) return;
        const dx = block.position.x - region.center.x;
        const dz = block.position.z - region.center.z;
        if (Math.hypot(dx, dz) > Number(region.radius ?? 0) + 4) return;
        const key = `${block.position.x},${block.position.y},${block.position.z}`;
        if (!seen.has(key)) { seen.add(key); result.push(block); }
    };
    for (const position of preferredPositions)
        add(npc.bot.blockAt(new Vec3(position.x, position.y, position.z)));
    for (const block of npc.storage.findChestsInRegion(npc.bot, region)) add(block);
    return result;
}

const countItem = (bot, name) => bot.inventory.items()
    .filter(item => item.name === name)
    .reduce((sum, item) => sum + item.count, 0);
