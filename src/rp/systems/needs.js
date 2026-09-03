// Needs simulation: deterministic decay/refill, no LLM.
//   sitost      — falls over time; refilled by eating (own food or a paid meal at the inn)
//   druzabnost  — falls over time; rises with conversations
//   utrujenost  — rises while awake, falls while sleeping
//   denar       — mirror of PHYSICAL gold (inventory + home storage), recomputed here
// Low needs already shape the persona prompt; meal trips are queued as pendingAction
// so they never fight the main activity loop for pathfinding.
import { totalMoney, payAtInn } from './economy.js';
import { eatAvailableFood, FOOD_NAMES, needsFoodNow, syncSatiety } from './food.js';
import { withdrawFromRegions } from './routines.js';

const TICK_MS = 60_000; // one needs-tick per real minute

export function attachNeeds(npc, economy) {
    const bot = npc.bot;
    const timer = setInterval(() => needsTick(npc, economy), TICK_MS);
    const onHealth = () => syncSatiety(npc);
    bot.on('health', onHealth);
    bot.once('end', () => clearInterval(timer));
    bot.once('end', () => bot.removeListener('health', onHealth));
}

function needsTick(npc, economy) {
    if (!npc.bot?.entity) return;
    const p = npc.state.data.potrebe;

    // Minecraft's real hunger bar is authoritative; the RP state mirrors it.
    syncSatiety(npc, { save: false });
    p.druzabnost = clamp(p.druzabnost - 1);
    if (npc.currentActivity === 'sleep') {
        p.utrujenost = clamp(p.utrujenost - 4);
    } else {
        p.utrujenost = clamp(p.utrujenost + (npc.currentActivity === 'work' ? 1.5 : 0.5));
    }

    // money mirrors physical gold
    p.denar = totalMoney(npc);

    npc.state.save();

    // hungry? queue an action for the main loop (don't path-find from a timer!)
    // never queue meal trips while sleeping — breakfast can wait till morning
    if (needsFoodNow(npc) && !npc.pendingAction && npc.currentActivity !== 'sleep') {
        npc.pendingAction = async () => {
            let meal = await eatAvailableFood(npc);
            if (meal.success) return;

            // Pull a real edible item before considering the inn. The old path paid
            // for an imaginary meal and increased RP satiety without feeding the bot.
            await withdrawFromRegions(npc, FOOD_NAMES, 2,
                [npc.cfg.home_region, 'mestna_zaloga']);
            meal = await eatAvailableFood(npc);
            if (meal.success) return;

            if (npc.currentActivity !== 'work' && await payAtInn(npc, economy)) {
                meal = await eatAvailableFood(npc);
                if (meal.success) p.druzabnost = clamp(p.druzabnost + 10);
                syncSatiety(npc, { save: false });
                npc.state.save();
            } else if (Number(npc.bot.food ?? 20) < 6) {
                npc.log.warn(`hungry and broke (sitost ${p.sitost}, denar ${p.denar})`);
            }
        };
    }
}

// social need refill — called from chat listener on each exchange
export function onSocialized(npc, amount = 5) {
    const p = npc.state.data.potrebe;
    p.druzabnost = clamp(p.druzabnost + amount);
    npc.state.save();
}

const clamp = (v) => Math.max(0, Math.min(100, Math.round(v * 10) / 10));
