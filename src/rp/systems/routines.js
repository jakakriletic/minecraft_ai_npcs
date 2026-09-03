import { Vec3 } from 'vec3';
import { gotoNear, gotoRegion, sleep } from '../core/movement.js';
import { payTax } from './mind.js';
import { getSocietyStatus, rememberSocietyStatus } from './status.js';
import * as mcCompat from '../../utils/mc_compat.js';
import { eatAvailableFood, FOOD_NAMES, needsFoodNow, syncSatiety } from './food.js';

const DEFAULT_FIX_COOLDOWN_MS = 120_000;

const AXE_NAMES = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe'];
const PICKAXE_NAMES = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe'];
const SWORD_NAMES = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword'];
export { FOOD_NAMES } from './food.js';

const TOOL_REQUIREMENTS = {
    woodcutter: { label: 'axe', names: AXE_NAMES },
    miner: { label: 'pickaxe', names: PICKAXE_NAMES },
    gatherer: { label: 'pickaxe', names: PICKAXE_NAMES },
    guard: { label: 'sword', names: SWORD_NAMES },
    policeman: { label: 'sword', names: SWORD_NAMES },
};

export async function trySocietyRoutineFix(npc, status) {
    if (npc.settings.society?.auto_fix_enabled !== true) return false;
    if (!npc.bot?.entity || npc.command || npc.defending || npc.currentActivity === 'sleep' || npc.currentActivity === 'jail') return false;

    const currentStatus = status ?? getSocietyStatus(npc);
    rememberSocietyStatus(npc, currentStatus);
    const plan = nextSocietyFixPlan(npc, currentStatus);
    if (!plan) return false;

    markAttempt(npc, plan);
    let result = { success: false, detail: 'no action' };
    try {
        switch (plan.type) {
            case 'eat':
                result = await fixHunger(npc);
                break;
            case 'tax':
                result = await fixTax(npc);
                break;
            case 'tool':
                result = await fixTool(npc, plan);
                break;
            case 'cook_food_stock':
                result = await fixCookFoodStock(npc);
                break;
            default:
                result = { success: false, detail: `unknown routine fix '${plan.type}'` };
        }
    } catch (error) {
        result = { success: false, detail: error.message };
    }

    rememberRoutineFix(npc, plan, result);
    return true;
}

export function societyFixPlan(npc, status = null) {
    return societyFixPlans(npc, status)[0] ?? null;
}

export function societyFixPlans(npc, status = null) {
    if (npc.settings?.society?.auto_fix_enabled !== true) return [];
    const messages = [...(status?.blockers ?? []), ...(status?.warnings ?? [])];
    const plans = [];

    if (needsFoodNow(npc))
        plans.push({ type: 'eat', key: 'eat', reason: `Minecraft hunger ${Math.round(npc.bot?.food ?? 0)}/20` });

    if (!isLawman(npc) && messages.some(text => text.includes('mestni prispevek')))
        plans.push({ type: 'tax', key: 'tax', reason: 'mestni prispevek caka' });

    const tool = TOOL_REQUIREMENTS[npc.cfg.job];
    if (tool && !hasInventoryAny(npc, tool.names))
        plans.push({ type: 'tool', key: `tool:${tool.label}`, reason: `manjka ${tool.label}`, label: tool.label, names: tool.names });

    if (npc.cfg.job === 'cook' && messages.some(text => text.includes('kuhar nima vidne hrane')))
        plans.push({ type: 'cook_food_stock', key: 'cook_food_stock', reason: 'kuhinja nima vidne hrane' });

    return plans;
}

export function nextSocietyFixPlan(npc, status = null) {
    return societyFixPlans(npc, status).find(plan => cooldownReady(npc, plan)) ?? null;
}

async function fixHunger(npc) {
    syncSatiety(npc);
    if (!needsFoodNow(npc)) return { success: true, detail: 'Minecraft hunger je ze poln' };
    if (!inventoryItemAny(npc, FOOD_NAMES))
        await withdrawFromRegions(npc, FOOD_NAMES, 2, [npc.cfg.home_region, 'mestna_zaloga', 'gostilna']);
    return await eatAvailableFood(npc);
}

async function fixTax(npc) {
    const civic = npc.civic;
    if (!civic?.taxLaw?.()) return { success: false, detail: 'ni davcnega zakona' };
    const day = civic.data?.current_day ?? civic.dayFromBot?.(npc.bot);
    const paid = await payTax(npc, civic, day);
    return paid
        ? { success: true, detail: 'mestni prispevek oddan' }
        : { success: false, detail: 'mestnega prispevka ni uspelo oddati' };
}

async function fixTool(npc, plan) {
    const result = await withdrawFromRegions(npc, plan.names, 1, [npc.cfg.home_region, 'mestna_zaloga']);
    if (result.success) {
        return { success: true, detail: `vzel ${result.item} iz ${result.region}` };
    }
    return { success: false, detail: `${plan.label} ni v domu ali mestni zalogi` };
}

async function fixCookFoodStock(npc) {
    const result = await withdrawFromRegions(npc, FOOD_NAMES, 8, ['mestna_zaloga', npc.cfg.home_region, 'gostilna']);
    if (result.success) return { success: true, detail: `vzel ${result.count}x ${result.item} iz ${result.region}` };
    return { success: false, detail: 'ni hrane v znanih skrinjah' };
}

export async function withdrawFromRegions(npc, names, count, regionNames) {
    const target = Math.max(1, Math.floor(Number(count) || 1));
    let total = 0;
    const items = {};
    const regions = [];
    for (const regionName of unique(regionNames).filter(Boolean)) {
        if (total >= target) break;
        const region = npc.locations[regionName];
        if (!region) continue;
        const ok = await gotoRegion(npc.bot, region, npc.log);
        if (!ok) continue;

        for (const chest of orderedChestCandidates(npc, region, regionName)) {
            if (total >= target) break;
            if (npc.bot.entity.position.distanceTo(chest.position) > 4 &&
                !await gotoNear(npc.bot, chest.position, 3, npc.log, 10_000)) {
                continue;
            }
            try {
                const result = await npc.storage.withdrawMatching(
                    npc.bot, chest, names, target - total, regionName);
                if (result.count <= 0) continue;
                total += result.count;
                regions.push(regionName);
                for (const [name, amount] of Object.entries(result.items ?? {}))
                    items[name] = (items[name] ?? 0) + amount;
                await sleep(150);
            } catch (error) {
                npc.log.warn(`withdraw from chest ${chest.position} failed: ${error.message}`);
            }
        }
    }
    const firstItem = Object.keys(items)[0] ?? null;
    return {
        success: total > 0,
        complete: total >= target,
        item: firstItem,
        items,
        count: total,
        region: regions[0] ?? null,
        regions: unique(regions),
    };
}

function orderedChestCandidates(npc, region, regionName) {
    const candidates = [];
    const seen = new Set();
    const add = position => {
        if (!position || !insideRegion(position, region)) return;
        const block = npc.bot.blockAt(new Vec3(position.x, position.y, position.z));
        if (!block || !mcCompat.blockMatchesAnyName(block, ['chest', 'trapped_chest', 'barrel'], npc.bot)) return;
        const key = `${block.position.x},${block.position.y},${block.position.z}`;
        if (!seen.has(key)) { seen.add(key); candidates.push(block); }
    };

    // Explicit `!setskrinja` assignments finally affect withdrawals.
    for (const position of Object.values(npc.cfg.chests ?? {})) add(position);
    for (const chest of Object.values(npc.storage.index?.chests ?? {}))
        if (chest.region === regionName) add(chest.pos);
    for (const block of npc.storage.findChestsInRegion?.(npc.bot, region) ?? []) add(block.position);
    return candidates;
}

function insideRegion(position, region) {
    const dx = Number(position.x) - Number(region.center.x);
    const dz = Number(position.z) - Number(region.center.z);
    return Math.hypot(dx, dz) <= Number(region.radius ?? 0) + 4;
}

function cooldownReady(npc, plan) {
    const st = (npc.societyRoutineState ??= { attempts: {} });
    const cooldown = Math.max(10_000, Number(npc.settings.society?.fix_cooldown_ms ?? DEFAULT_FIX_COOLDOWN_MS));
    return Date.now() - (st.attempts[plan.key] ?? 0) >= cooldown;
}

function markAttempt(npc, plan) {
    const st = (npc.societyRoutineState ??= { attempts: {} });
    st.attempts[plan.key] = Date.now();
}

function rememberRoutineFix(npc, plan, result) {
    const society = (npc.state.data.society ??= {});
    society.last_fix = {
        ts: new Date().toISOString(),
        type: plan.type,
        reason: plan.reason,
        success: Boolean(result.success),
        detail: String(result.detail ?? '').slice(0, 160),
    };
    society.fix_history ??= [];
    society.fix_history.push(society.last_fix);
    society.fix_history = society.fix_history.slice(-12);
    if (result.success) {
        npc.state.data.znanje_o_svetu.slisal.push(`Popravil/a si rutino: ${plan.reason} (${society.last_fix.detail}).`);
        npc.state.data.znanje_o_svetu.slisal = npc.state.data.znanje_o_svetu.slisal.slice(-20);
    }
    npc.state.save();
    npc.log.info(`society fix ${plan.type}: ${result.success ? 'ok' : 'failed'} - ${society.last_fix.detail}`);
}

function hasInventoryAny(npc, names) {
    return Boolean(inventoryItemAny(npc, names));
}

function inventoryItemAny(npc, names) {
    return npc.bot?.inventory?.items?.().find(item => mcCompat.stackMatchesAnyName(item, names, npc.bot)) ?? null;
}

function isLawman(npc) {
    return npc.cfg.job === 'policeman' || npc.cfg.job === 'guard';
}

function unique(values) {
    return [...new Set(values)];
}
