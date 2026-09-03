import { gotoRegion } from '../core/movement.js';
import { pickupNearbyGold } from '../systems/economy.js';
import { addCivicEvent, ensureInRegion, rememberJobBeat, unique, wanderInRegion } from './common.js';

const PATROL_DWELL_MS = 35_000;
const REPORT_COOLDOWN_MS = 240_000;

export async function guardStep(npc) {
    const st = (npc.jobState ??= { patrolIndex: 0, arrivedAt: 0, lastReportAt: 0 });
    const patrol = guardPatrolRegions(npc);
    if (patrol.length === 0) return;

    const target = patrol[st.patrolIndex % patrol.length];
    if (!await ensureInRegion(npc, target)) {
        rememberJobBeat(npc, 'guard_move', `patrulja proti ${target}`, { target });
        return;
    }

    await pickupNearbyGold(npc);
    if (!st.arrivedAt) st.arrivedAt = Date.now();

    if (Date.now() - st.lastReportAt > REPORT_COOLDOWN_MS) {
        st.lastReportAt = Date.now();
        addCivicEvent(npc, 'guard_patrol', `${npc.cfg.osebnost.ime} je preveril strazo pri ${target}.`, {
            region: target,
            patrol,
        }, `guard:${target}`, REPORT_COOLDOWN_MS);
        rememberJobBeat(npc, 'guard_report', `preveril ${target}`, { target });
    }

    if (Date.now() - st.arrivedAt > PATROL_DWELL_MS) {
        st.arrivedAt = 0;
        st.patrolIndex = (st.patrolIndex + 1) % patrol.length;
        const next = patrol[st.patrolIndex];
        const region = npc.locations[next];
        if (region) await gotoRegion(npc.bot, region, npc.log);
        return;
    }

    await wanderInRegion(npc, target, 16_000, 36_000);
}

export function guardPatrolRegions(npc) {
    return unique([
        npc.cfg.job_region,
        'mestna_zaloga',
        'obcina',
        'gostilna',
        'zapor',
        'center',
    ]).filter(name => npc.locations?.[name]);
}
