// Generic "presence" job for roles without real work logic yet (innkeeper,
// policeman before investigations, etc.): stay in the job region and wander
// between random points inside it so the NPC looks alive, not statue-like.
// Real job behaviours (serving, investigations) get layered on in later phases.
import { gotoRegion, gotoNear, isInRegion, sleep } from '../core/movement.js';
import { pickupNearbyGold } from '../systems/economy.js';

export async function presenceStep(npc) {
    const bot = npc.bot;
    const region = npc.region(npc.cfg.job_region);

    if (!isInRegion(bot, region)) {
        await gotoRegion(bot, region, npc.log);
        return;
    }

    // collect payments / dropped items lying around the workplace (innkeeper income!)
    await pickupNearbyGold(npc);

    const st = (npc.jobState ??= { nextMoveAt: 0 });
    if (Date.now() < st.nextMoveAt) return;

    // wander to a random point inside the region
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * Math.max(2, region.radius - 2);
    const x = Math.floor(region.center.x + Math.cos(angle) * dist);
    const z = Math.floor(region.center.z + Math.sin(angle) * dist);
    try {
        await gotoNear(bot, { x, y: region.center.y, z }, 1, npc.log, 10000);
    } catch { /* unreachable point — just try another one next time */ }

    // linger 20-60 s before next wander
    st.nextMoveAt = Date.now() + 20_000 + Math.random() * 40_000;
    await sleep(500);
}
