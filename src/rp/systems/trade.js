// Player <-> NPC trading. Conversation ABOUT prices is LLM (persona knows beliefs);
// the offer/accept mechanics are deterministic chat commands the code validates —
// the LLM can never be sweet-talked into a bad deal.
//
// Player commands (anyone, not admin-only; NPC id is always explicit):
//   !cena <npc> <item>            — ask both quotes
//   !kupi <npc> <item> <kolicina> — player buys FROM the NPC
//   !prodaj <npc> <item> <kolicina> — player sells TO the NPC
//   !sprejmi <npc> / !zavrni <npc>
//
// Physical exchange, payment-first:
//   buy:  player tosses gold -> NPC counts what it picked up -> only then tosses goods
//   sell: player tosses goods -> NPC counts -> tosses gold
// Timeout refunds whatever arrived.
import { bus } from '../core/bus.js';
import { inventoryMoney, NUGGET } from './economy.js';
import { gotoNear, sleep } from '../core/movement.js';

const WITNESS_RANGE = 16;

export function attachTrade(npc, economyCfg) {
    const bot = npc.bot;
    const t = economyCfg.trgovanje;
    const sessions = new Map(); // playerName -> session

    const resolveItem = (word) => {
        const w = word.toLowerCase();
        return economyCfg.aliasi?.[w] ?? w;
    };

    bot.on('chat', (username, message) => {
        if (username === bot.username || !message.startsWith('!')) return;
        const [cmd, target, ...rest] = message.trim().split(/\s+/);
        if (target?.toLowerCase() !== npc.cfg.id) return; // not addressed to this NPC

        try {
            switch (cmd) {
                case '!cena': return quotePrice(rest[0]);
                case '!kupi': return propose('buy', username, rest[0], rest[1]);
                case '!prodaj': return propose('sell', username, rest[0], rest[1]);
                case '!sprejmi': return accept(username);
                case '!zavrni': return decline(username);
            }
        } catch (e) {
            npc.log.error(`trade: ${e.message}`);
        }
    });

    function quotePrice(itemWord) {
        if (!itemWord) return;
        const item = resolveItem(itemWord);
        const belief = npc.prices.get(item);
        if (belief === null) return bot.chat(`Za ${itemWord} ne vem cene, tega ne poznam.`);
        bot.chat(`${itemWord}: prodam po ${sellPrice(item)} | odkupim po ${buyPrice(item)} (zlato).`);
    }

    function sellPrice(item, playerName) {
        let p = npc.prices.get(item) * (t.prodajna_marza ?? 1.2);
        // friends get a discount, but never below the hard validation floor
        const rel = playerName ? npc.state.relationTo(playerName) : null;
        if (rel && rel.zaupanje >= (t.popust_pri_zaupanju?.prag ?? 70)) {
            p *= t.popust_pri_zaupanju?.faktor ?? 0.9;
        }
        const floor = npc.prices.get(item) * (t.min_prodajni_delez ?? 0.8);
        return Math.max(1, Math.round(Math.max(p, floor)));
    }

    function buyPrice(item) {
        let p = npc.prices.get(item) * (t.nakupna_marza ?? 0.8);
        const cap = npc.prices.get(item) * (t.max_nakupni_delez ?? 1.1);
        return Math.max(1, Math.round(Math.min(p, cap)));
    }

    function countItem(name) {
        return bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0);
    }

    function propose(type, player, itemWord, qtyStr) {
        const item = resolveItem(itemWord ?? '');
        const qty = parseInt(qtyStr) || 1;
        if (!itemWord || qty < 1 || qty > 64) return bot.chat('Uporaba: !kupi/<!prodaj> <npc> <item> <kolicina>');
        if (!npc.prices.knows(item)) return bot.chat(`Tega (${itemWord}) ne poznam, žal.`);

        if (type === 'buy') {
            const have = countItem(item);
            if (have < qty) {
                bot.chat(have > 0 ? `Pri sebi imam samo ${have} ${itemWord}.` : `Tega trenutno nimam pri sebi.`);
                if (have === 0) return;
            }
            const unit = sellPrice(item, player);
            const realQty = Math.min(qty, have);
            sessions.set(player, { type, item, itemWord, qty: realQty, unit, total: unit * realQty, expiresAt: Date.now() + (t.timeout_s ?? 60) * 1000 });
            bot.chat(`${realQty}x ${itemWord} ti prodam za ${unit * realQty} zlata (${unit}/kos). !sprejmi ${npc.cfg.id} ali !zavrni ${npc.cfg.id}.`);
        } else {
            const unit = buyPrice(item);
            const total = unit * qty;
            if (inventoryMoney(bot) < total) return bot.chat(`Toliko denarja nimam pri sebi (rabil bi ${total}).`);
            sessions.set(player, { type, item, itemWord, qty, unit, total, expiresAt: Date.now() + (t.timeout_s ?? 60) * 1000 });
            bot.chat(`${qty}x ${itemWord} odkupim za ${total} zlata (${unit}/kos). !sprejmi ${npc.cfg.id} ali !zavrni ${npc.cfg.id}.`);
        }
    }

    function decline(player) {
        const s = sessions.get(player);
        if (!s) return;
        sessions.delete(player);
        // a declined offer is a price signal
        npc.prices.signalRejected(s.item, s.type === 'buy' ? -1 : +1);
        bot.chat('Prav, pa drugič.');
    }

    async function accept(player) {
        const s = sessions.get(player);
        if (!s || Date.now() > s.expiresAt) {
            sessions.delete(player);
            return bot.chat('Ponudba ne velja več.');
        }
        sessions.delete(player);

        if (s.type === 'buy') {
            // payment first: wait for gold, then hand over goods
            bot.chat(`Velja. Vrzi ${s.total} zlata (nuggete) predme.`);
            const before = inventoryMoney(bot);
            const received = await collectUntil(() => inventoryMoney(bot) - before, s.total, (t.timeout_s ?? 60) * 1000);
            if (received < s.total) {
                bot.chat('Premalo zlata. Nič ne bo, vračam.');
                await tossNuggets(received);
                return;
            }
            await tossItems(s.item, s.qty);
            finishTrade(player, s, 'prodal');
        } else {
            // goods first, then gold
            bot.chat(`Velja. Vrzi ${s.qty}x ${s.itemWord} predme.`);
            const before = countItem(s.item);
            const received = await collectUntil(() => countItem(s.item) - before, s.qty, (t.timeout_s ?? 60) * 1000);
            if (received < s.qty) {
                bot.chat('To ni vse, kar sva se zmenila. Vračam.');
                await tossItems(s.item, received);
                return;
            }
            await tossNuggets(s.total);
            finishTrade(player, s, 'odkupil');
        }
    }

    // keep picking up nearby drops until measure() >= target or timeout
    async function collectUntil(measure, target, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && measure() < target) {
            const drops = Object.values(bot.entities).filter(e =>
                e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < 8);
            for (const d of drops.slice(0, 4)) {
                try { await gotoNear(bot, d.position, 1, npc.log, 3000); }
                catch { /* gone */ }
            }
            await sleep(1000);
        }
        return measure();
    }

    async function tossItems(itemName, count) {
        let left = count;
        for (const it of bot.inventory.items().filter(i => i.name === itemName)) {
            if (left <= 0) break;
            const n = Math.min(it.count, left);
            try { await bot.toss(it.type, null, n); left -= n; }
            catch (e) { npc.log.warn(`toss ${itemName} failed: ${e.message}`); break; }
        }
    }

    async function tossNuggets(amount) {
        if (amount <= 0) return;
        await tossItems(NUGGET, amount);
    }

    function finishTrade(player, s, verb) {
        bot.chat('No, pa sva. Me veseli.');
        npc.log.info(`TRADE: ${verb} ${s.qty}x ${s.item} @ ${s.unit} (${player})`);
        npc.prices.observe(s.item, s.unit, 'lastna transakcija');
        npc.eventLog.add({ tip: 'trgoval', akter: player, podrobnost: `${verb} ${s.qty}x ${s.item} po ${s.unit}` });
        npc.state.applyDelta({ odnosi_igralci: { [player]: { zaupanje: 2 } } }, 'trade');
        npc.civic?.adjustReputation?.(npc.cfg.id, { public_trust: 1, respect: 1 }, 'player_trade');
        npc.civic?.addPublicEvent?.('player_trade', npc.cfg.id, `${npc.cfg.osebnost.ime} je trgoval/a z ${player}: ${verb} ${s.qty}x ${s.item}.`, {
            player,
            item: s.item,
            qty: s.qty,
            unit: s.unit,
        });
        // nearby NPCs learn the price by watching
        bus.emit('trade', { sellerId: npc.cfg.id, item: s.item, unit: s.unit, pos: bot.entity.position.clone() });
    }

    // witness other NPCs' trades -> update own beliefs
    const onTrade = (ev) => {
        if (ev.sellerId === npc.cfg.id || !bot.entity) return;
        if (ev.pos.distanceTo(bot.entity.position) > WITNESS_RANGE) return;
        npc.prices.observe(ev.item, ev.unit, `videl pri ${ev.sellerId}`);
    };
    bus.on('trade', onTrade);
    bot.once('end', () => bus.off('trade', onTrade));
}
