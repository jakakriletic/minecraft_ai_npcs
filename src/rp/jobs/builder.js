import { pickupNearbyGold } from '../systems/economy.js';
import { addCivicEvent, countInventoryAny, ensureInRegion, rememberJobBeat, wanderInRegion } from './common.js';

const INSPECT_COOLDOWN_MS = 90_000;
const REPORT_COOLDOWN_MS = 240_000;
const BUILDING_MATERIALS = ['cobblestone', 'stone', 'oak_log', 'birch_log', 'spruce_log', 'oak_planks', 'planks', 'dirt', 'sand', 'glass'];
const LIGHTING = ['torch'];
const TOOLS = ['stone_axe', 'iron_axe', 'stone_pickaxe', 'iron_pickaxe'];

export async function builderStep(npc) {
    const st = (npc.jobState ??= { lastInspectAt: 0, lastReportAt: 0 });
    if (!await ensureInRegion(npc, npc.cfg.job_region)) return;
    await pickupNearbyGold(npc);

    if (Date.now() - st.lastInspectAt > INSPECT_COOLDOWN_MS) {
        st.lastInspectAt = Date.now();
        const plan = builderMaterialPlan(npc);
        rememberJobBeat(npc, 'builder_inspect', plan.ready ? 'gradbisce ima osnovne pogoje' : `manjka: ${plan.missing.join(', ')}`, plan);
        if (!plan.ready && Date.now() - st.lastReportAt > REPORT_COOLDOWN_MS) {
            st.lastReportAt = Date.now();
            addCivicEvent(npc, 'build_need', `${npc.cfg.osebnost.ime} na gradbiscu potrebuje: ${plan.missing.join(', ')}.`, {
                missing: plan.missing,
                counts: plan.counts,
            }, 'build_need', REPORT_COOLDOWN_MS);
            if (Math.random() < 0.55) npc.bot.chat(`Gradbisce rabi ${plan.missing.join(', ')}.`);
        }
        return;
    }

    await wanderInRegion(npc, npc.cfg.job_region, 22_000, 55_000);
}

export function builderMaterialPlan(npcOrCounts) {
    const counts = npcOrCounts?.bot
        ? {
            materials: countInventoryAny(npcOrCounts.bot, BUILDING_MATERIALS) + countStoredAny(npcOrCounts, BUILDING_MATERIALS, 'mestna_zaloga'),
            lighting: countInventoryAny(npcOrCounts.bot, LIGHTING) + countStoredAny(npcOrCounts, LIGHTING, 'mestna_zaloga'),
            tools: countInventoryAny(npcOrCounts.bot, TOOLS) + countStoredAny(npcOrCounts, TOOLS, npcOrCounts.cfg.home_region),
        }
        : npcOrCounts;
    const missing = [];
    if ((counts.materials ?? 0) < 24) missing.push('gradbeni material');
    if ((counts.lighting ?? 0) < 4) missing.push('bakle');
    if ((counts.tools ?? 0) < 1) missing.push('orodje');
    return {
        ready: missing.length === 0,
        missing,
        counts,
    };
}

function countStoredAny(npc, names, regionName) {
    if (!npc.storage?.totalOf || !regionName) return 0;
    return names.reduce((sum, name) => sum + Number(npc.storage.totalOf(name, regionName) ?? 0), 0);
}
