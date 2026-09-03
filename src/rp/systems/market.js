// NPC <-> NPC market. Vendors (npc.cfg.vendor === true) offer their surplus;
// ANY NPC can buy from a nearby vendor. Decisions come from needs + each NPC's
// own evolving PRICE BELIEFS — no LLM. A deal happens only when the seller's ask
// (belief * margin) fits under the buyer's max (belief * margin); both then nudge
// their beliefs toward the agreed price, so the whole town's prices converge over
// time. Physical gold throughout: buyer pays nuggets first, vendor then hands over
// goods (co-located, so it's a real in-world exchange).
import { bus } from '../core/bus.js';
import { NUGGET } from './economy.js';
import { gotoNear, sleep } from '../core/movement.js';
import { notePositiveInteraction } from './social_bonds.js';
import { FOOD_NAMES } from './food.js';

const MARKET_MS = 30_000;
const TRADE_RANGE = 8;
const FOOD = FOOD_NAMES;
const TOOLS_WEAPONS = new Set([
    'netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe',
    'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe',
    'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword',
    'shield', 'bow', 'crossbow']);

export function attachMarket(npc, economyCfg) {
    const t = economyCfg.trgovanje ?? {};
    const timer = setInterval(
        () => marketTick(npc, t).catch(e => npc.log.warn(`market: ${e.message}`)),
        MARKET_MS + Math.random() * 10_000);
    npc.bot.once('end', () => clearInterval(timer));
}

// This NPC acts as a BUYER, looking for a nearby vendor to buy from.
async function marketTick(npc, tcfg) {
    const bot = npc.bot;
    if (!bot?.entity || npc.busy || npc.defending || npc.command || bot.isSleeping) return;

    const vendor = nearestVendor(npc);
    if (!vendor) return;

    const offers = vendorOffers(vendor);
    const item = chooseWant(npc, offers);
    if (!item) return;

    // price check from beliefs
    const vendorAsk = Math.max(1, Math.round((vendor.prices.get(item) ?? 1) * (tcfg.prodajna_marza ?? 1.2)));
    const buyerMax = Math.max(1, Math.round((npc.prices.get(item) ?? 1) * (tcfg.max_nakupni_delez ?? 1.1)));
    if (vendorAsk > buyerMax) {
        // beliefs don't overlap — a small signal to both, no deal
        npc.prices.signalRejected(item, +1);
        vendor.prices.signalRejected(item, -1);
        return;
    }

    // how many can we trade?
    let qty = FOOD.includes(item) ? 3 : 1;
    qty = Math.min(qty, offers[item]);
    const nuggets = countItem(bot, NUGGET);
    qty = Math.min(qty, Math.floor(nuggets / vendorAsk));
    if (qty < 1) return; // can't afford even one in nuggets

    await execTrade(npc, vendor, item, qty, vendorAsk);
}

function nearestVendor(npc) {
    const bot = npc.bot;
    let best = null, bestD = TRADE_RANGE;
    for (const o of npc.registry ?? []) {
        if (o === npc || !o.cfg.vendor || !o.bot?.entity) continue;
        if (o.busy || o.defending || o.command || o.bot.isSleeping) continue;
        const d = o.bot.entity.position.distanceTo(bot.entity.position);
        if (d < bestD) { bestD = d; best = o; }
    }
    return best;
}

// What the vendor is willing to sell from its inventory (with a price belief, not gear).
function vendorOffers(vendor) {
    const offers = {};
    const foodHeld = vendor.bot.inventory.items().filter(i => FOOD.includes(i.name)).reduce((s, i) => s + i.count, 0);
    for (const it of vendor.bot.inventory.items()) {
        if (TOOLS_WEAPONS.has(it.name)) continue;
        if (it.name === NUGGET || it.name === 'gold_ingot') continue; // don't sell money
        if (vendor.prices.get(it.name) === null) continue;            // no idea what it's worth
        let avail = it.count;
        if (FOOD.includes(it.name) && foodHeld <= 4) continue;        // keep a little food for itself
        if (avail > 0) offers[it.name] = (offers[it.name] ?? 0) + avail;
    }
    return offers;
}

// Buyer demand: hungry -> food; otherwise an occasional opportunistic buy.
function chooseWant(npc, offers) {
    const candidates = Object.keys(offers);
    if (candidates.length === 0) return null;
    const hungry = (npc.state.data.potrebe.sitost ?? 100) < 60;
    if (hungry) {
        const food = candidates.filter(i => FOOD.includes(i));
        if (food.length) return food[0];
    }
    if (Math.random() < 0.3) return candidates[Math.floor(Math.random() * candidates.length)];
    return null;
}

async function execTrade(buyer, vendor, item, qty, unit) {
    const total = unit * qty;
    buyer.busy = true; vendor.busy = true; // lock both bots' schedulers during the swap
    try {
        buyer.log.info(`buying ${qty}x ${item} @ ${unit} from ${vendor.cfg.id} (total ${total})`);
        // 1) buyer pays gold
        const paid = await handover(buyer.bot, vendor.bot, NUGGET, total, buyer.log);
        if (paid < total) {
            buyer.log.warn(`market: only paid ${paid}/${total}, aborting`);
            return;
        }
        // 2) vendor hands over goods
        const got = await handover(vendor.bot, buyer.bot, item, qty, vendor.log);
        if (got < qty) vendor.log.warn(`market: only delivered ${got}/${qty}`);

        // both learn the price; town prices converge over time
        buyer.prices.observe(item, unit, `kupil od ${vendor.cfg.id}`);
        vendor.prices.observe(item, unit, `prodal ${buyer.cfg.id}`);
        buyer.eventLog?.add({ tip: 'trgoval', akter: vendor.cfg.id, podrobnost: `kupil ${got}x ${item} po ${unit}` });
        vendor.eventLog?.add({ tip: 'trgoval', akter: buyer.cfg.id, podrobnost: `prodal ${got}x ${item} po ${unit}` });
        // relationship: trading builds a little trust both ways
        buyer.state.applyDelta({ odnosi_npcji: { [vendor.cfg.id]: { zaupanje: 1 } } }, 'trgovanje');
        vendor.state.applyDelta({ odnosi_npcji: { [buyer.cfg.id]: { zaupanje: 1 } } }, 'trgovanje');
        notePositiveInteraction(buyer, vendor, 'market_trade', 1.1);
        buyer.civic?.adjustReputation?.(vendor.cfg.id, { public_trust: 1, respect: 1 }, 'fair_trade');
        buyer.civic?.addPublicEvent?.('trade', vendor.cfg.id, `${vendor.cfg.osebnost.ime} je prodal/a ${qty}x ${item} ${buyer.cfg.osebnost.ime}.`, {
            buyer: buyer.cfg.id,
            item,
            qty,
            unit,
        });
        // nearby NPCs watching learn the price too
        bus.emit('trade', { sellerId: vendor.cfg.id, item, unit, pos: vendor.bot.entity.position.clone() });

        if (Math.random() < 0.5) vendor.bot.chat(pickLine(['Hvala za kupčijo.', 'Lepo, da sva se zmenila.', 'Pridi spet.']));
    } finally {
        buyer.busy = false; vendor.busy = false;
    }
}

// fromBot tosses `count` of an item; toBot walks the few blocks over and collects it.
async function handover(fromBot, toBot, itemName, count, log) {
    const before = countItem(toBot, itemName);
    let left = count;
    for (const it of fromBot.inventory.items().filter(i => i.name === itemName)) {
        if (left <= 0) break;
        const n = Math.min(it.count, left);
        try { await fromBot.toss(it.type, null, n); left -= n; }
        catch (e) { log?.warn?.(`handover toss failed: ${e.message}`); break; }
    }
    const tossed = count - left;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && countItem(toBot, itemName) - before < tossed) {
        const drops = Object.values(toBot.entities).filter(e =>
            e.name === 'item' && e.position && e.position.distanceTo(toBot.entity.position) < 8);
        for (const d of drops.slice(0, 4)) {
            try { await gotoNear(toBot, d.position, 1, null, 3000); }
            catch { /* gone */ }
        }
        await sleep(500);
    }
    return countItem(toBot, itemName) - before;
}

const countItem = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0);
const pickLine = (arr) => arr[Math.floor(Math.random() * arr.length)];
