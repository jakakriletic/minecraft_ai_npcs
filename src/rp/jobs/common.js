import { gotoNear, gotoRegion, isInRegion, sleep } from '../core/movement.js';
import * as mcCompat from '../../utils/mc_compat.js';

export function countInventoryAny(bot, names) {
    return (bot?.inventory?.items?.() ?? [])
        .filter(item => mcCompat.stackMatchesAnyName(item, names, bot))
        .reduce((sum, item) => sum + item.count, 0);
}

export function firstInventoryAny(bot, names) {
    return (bot?.inventory?.items?.() ?? [])
        .find(item => mcCompat.stackMatchesAnyName(item, names, bot)) ?? null;
}

export async function ensureInRegion(npc, regionName) {
    const region = npc.region(regionName);
    if (isInRegion(npc.bot, region)) return true;
    return await gotoRegion(npc.bot, region, npc.log);
}

export async function wanderInRegion(npc, regionName, minMs = 20_000, maxMs = 60_000) {
    const region = npc.region(regionName);
    const st = (npc.jobState ??= {});
    if (Date.now() < (st.nextMoveAt ?? 0)) return;

    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * Math.max(2, (region.radius ?? 4) - 2);
    const x = Math.floor(region.center.x + Math.cos(angle) * dist);
    const z = Math.floor(region.center.z + Math.sin(angle) * dist);
    await gotoNear(npc.bot, { x, y: region.center.y, z }, 1, npc.log, 10_000);
    st.nextMoveAt = Date.now() + minMs + Math.random() * Math.max(0, maxMs - minMs);
    await sleep(300);
}

export function rememberJobBeat(npc, kind, detail, extra = {}) {
    const society = (npc.state.data.society ??= {});
    society.last_job = {
        ts: new Date().toISOString(),
        kind,
        detail: String(detail ?? '').slice(0, 180),
        ...extra,
    };
    society.job_history ??= [];
    society.job_history.push(society.last_job);
    society.job_history = society.job_history.slice(-16);
    npc.state.save();
}

export function addCivicEvent(npc, type, text, metadata = {}, cooldownKey = type, cooldownMs = 180_000) {
    const st = (npc.jobState ??= {});
    st.eventCooldowns ??= {};
    if (Date.now() - (st.eventCooldowns[cooldownKey] ?? 0) < cooldownMs) return false;
    st.eventCooldowns[cooldownKey] = Date.now();
    npc.civic?.addPublicEvent?.(type, npc.cfg.id, text, metadata);
    return true;
}

export function unique(values) {
    return [...new Set(values.filter(Boolean))];
}
