import { pickupNearbyGold } from '../systems/economy.js';
import { FOOD_NAMES } from '../systems/routines.js';
import { addCivicEvent, ensureInRegion, rememberJobBeat, wanderInRegion } from './common.js';

const SCAN_COOLDOWN_MS = 75_000;
const REPORT_COOLDOWN_MS = 240_000;
const MATERIAL_NAMES = ['cobblestone', 'stone', 'oak_log', 'birch_log', 'spruce_log', 'oak_planks', 'planks', 'dirt', 'sand', 'glass'];
const TOOL_NAMES = ['stone_pickaxe', 'iron_pickaxe', 'stone_axe', 'iron_axe', 'stone_sword', 'iron_sword', 'torch'];
const MONEY_NAMES = ['gold_nugget', 'gold_ingot'];

export async function stewardStep(npc) {
    const st = (npc.jobState ??= { lastScanAt: 0, lastReportAt: 0 });
    const regionName = npc.cfg.job_region || 'mestna_zaloga';
    if (!await ensureInRegion(npc, regionName)) return;
    await pickupNearbyGold(npc);

    if (Date.now() - st.lastScanAt > SCAN_COOLDOWN_MS) {
        st.lastScanAt = Date.now();
        await npc.storage.scanRegion(npc.bot, npc.region(regionName), regionName);
        const summary = summarizeStorageIndex(npc.storage.index, regionName);
        const concerns = stewardConcerns(summary);
        rememberJobBeat(npc, 'steward_scan', formatSummary(summary), { summary, concerns });

        if (concerns.length && Date.now() - st.lastReportAt > REPORT_COOLDOWN_MS) {
            st.lastReportAt = Date.now();
            const text = `${npc.cfg.osebnost.ime} je pri zalogi opazila: ${concerns.join(', ')}.`;
            addCivicEvent(npc, 'stock_concern', text, { concerns, summary }, 'stock_concern', REPORT_COOLDOWN_MS);
            if (Math.random() < 0.7) npc.bot.chat(`Zaloga opozarja: ${concerns.join(', ')}.`);
        }
        return;
    }

    await wanderInRegion(npc, regionName, 24_000, 55_000);
}

export function summarizeStorageIndex(index, regionName = null) {
    const items = {};
    for (const chest of Object.values(index?.chests ?? {})) {
        if (regionName && chest.region !== regionName) continue;
        for (const [name, count] of Object.entries(chest.items ?? {})) {
            items[name] = (items[name] ?? 0) + Number(count ?? 0);
        }
    }
    return {
        total: Object.values(items).reduce((sum, count) => sum + count, 0),
        food: countNames(items, FOOD_NAMES),
        materials: countNames(items, MATERIAL_NAMES),
        tools: countNames(items, TOOL_NAMES),
        money: countNames(items, MONEY_NAMES),
        items,
    };
}

export function stewardConcerns(summary) {
    const concerns = [];
    if ((summary.food ?? 0) < 8) concerns.push('malo hrane');
    if ((summary.materials ?? 0) < 32) concerns.push('malo gradbenega materiala');
    if ((summary.tools ?? 0) < 3) concerns.push('malo orodja/bakel');
    if ((summary.total ?? 0) < 24) concerns.push('skrinje so skoraj prazne');
    return concerns;
}

function countNames(items, names) {
    return names.reduce((sum, name) => sum + Number(items[name] ?? 0), 0);
}

function formatSummary(summary) {
    return `hrana ${summary.food}, materiali ${summary.materials}, orodje ${summary.tools}, denar ${summary.money}`;
}
