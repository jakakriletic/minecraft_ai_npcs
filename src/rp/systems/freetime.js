// Dynamic free time: instead of standing at home, the NPC picks an activity
// weighted by personality AND current needs (pure dice, no LLM):
//   druzenje  ~ socialnost + missing social need  -> hang out at the inn
//   sprehod   ~ raziskovalnost                    -> wander to random spots around town
//   pocitek   ~ utrujenost                        -> rest at home
// A loner with high curiosity roams; a sociable slacker lives at the inn —
// free time becomes an expression of character. Blocks last 3-6 real minutes.
import { gotoRegion, gotoNear, isInRegion, sleep } from '../core/movement.js';

const BLOCK_MIN_MS = 3 * 60_000;
const BLOCK_MAX_MS = 6 * 60_000;
const WANDER_RADIUS = 40; // around town center; NPC returns before sleep via scheduler

export async function freeTimeStep(npc) {
    let st = npc.freeState;
    if (!st || Date.now() > st.until) {
        st = npc.freeState = chooseActivity(npc);
        npc.log.info(`free time: ${st.tip} (${Math.round((st.until - Date.now()) / 60000)} min)`);
    }

    switch (st.tip) {
        case 'druzenje': {
            const inn = npc.locations['gostilna'] ?? npc.region(npc.cfg.home_region);
            if (!isInRegion(npc.bot, inn)) { await gotoRegion(npc.bot, inn, npc.log); return; }
            await wanderWithin(npc, inn);
            break;
        }
        case 'sprehod': {
            const p = randomTownPoint(npc);
            try {
                await gotoNear(npc.bot, p, 3, npc.log, 15000);
            } catch { /* unreachable — pick another next step */ }
            await sleep(3000 + Math.random() * 5000); // look around a bit
            break;
        }
        default: { // pocitek
            const home = npc.region(npc.cfg.home_region);
            if (!isInRegion(npc.bot, home)) await gotoRegion(npc.bot, home, npc.log);
        }
    }
}

function chooseActivity(npc) {
    const l = npc.state.data.lastnosti;
    const p = npc.state.data.potrebe;
    const weights = {
        druzenje: (l.socialnost ?? 50) + (100 - (p.druzabnost ?? 50)) * 0.5,
        sprehod: (l.raziskovalnost ?? 50) + 15,
        pocitek: (p.utrujenost ?? 0) * 1.5 + 10,
    };
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    let tip = 'pocitek';
    for (const [k, w] of Object.entries(weights)) {
        roll -= w;
        if (roll <= 0) { tip = k; break; }
    }
    return { tip, until: Date.now() + BLOCK_MIN_MS + Math.random() * (BLOCK_MAX_MS - BLOCK_MIN_MS) };
}

function randomTownPoint(npc) {
    const center = npc.locations['center']?.center ?? npc.region(npc.cfg.home_region).center;
    const angle = Math.random() * Math.PI * 2;
    const dist = 5 + Math.random() * WANDER_RADIUS;
    return {
        x: Math.floor(center.x + Math.cos(angle) * dist),
        y: center.y,
        z: Math.floor(center.z + Math.sin(angle) * dist),
    };
}

async function wanderWithin(npc, region) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * Math.max(2, region.radius - 2);
    const x = Math.floor(region.center.x + Math.cos(angle) * dist);
    const z = Math.floor(region.center.z + Math.sin(angle) * dist);
    try { await gotoNear(npc.bot, { x, y: region.center.y, z }, 1, npc.log, 10000); }
    catch { /* fine */ }
    await sleep(15_000 + Math.random() * 20_000); // linger, chat happens around us
}
