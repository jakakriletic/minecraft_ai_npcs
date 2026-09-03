// Woodcutter job: in the job region find log blocks, chop them, replant saplings,
// and when inventory fills up deliver logs according to job_rules.
// Pure deterministic code — no LLM.
import { Vec3 } from 'vec3';
import { gotoRegion, gotoNear, isInRegion, sleep } from '../core/movement.js';
import { gotoChestInRegion } from '../core/storage.js';
import * as mcCompat from '../../utils/mc_compat.js';

const LOG_NAMES = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log'];
const SAPLING_FOR = {
    oak_log: 'oak_sapling', birch_log: 'birch_sapling', spruce_log: 'spruce_sapling',
    jungle_log: 'jungle_sapling', acacia_log: 'acacia_sapling', dark_oak_log: 'dark_oak_sapling',
    cherry_log: 'cherry_sapling',
};
const AXES = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe'];

function logAliases(blockOrItem, bot) {
    const name = typeof blockOrItem === 'string' ? blockOrItem : blockOrItem?.name;
    const metadata = typeof blockOrItem === 'string' ? 0 : blockOrItem?.metadata;
    return mcCompat.aliasesForLegacyStack(name, metadata, bot);
}

function isLogStack(stack, bot) {
    return mcCompat.stackMatchesAnyName(stack, LOG_NAMES, bot);
}

function canonicalLogName(block, bot) {
    return logAliases(block, bot).find(name => name.endsWith('_log')) ?? block?.name;
}

// One work-tick step. Called repeatedly by the NPC loop while activity === 'work'.
// Keeps its own tiny state on the npc object (npc.jobState).
export async function workStep(npc) {
    const bot = npc.bot;
    const st = (npc.jobState ??= { toolChecked: false, lastTreeBase: null, complainedNoTrees: 0 });

    // 1. Tool: once per shift, try to get an axe from home storage (works bare-handed as last resort).
    if (!st.toolChecked) {
        await ensureAxe(npc);
        st.toolChecked = true;
    }

    // 2. Inventory full -> deliver per job_rules.
    if (bot.inventory.emptySlotCount() <= 1) {
        await deliver(npc);
        return;
    }

    // 3. Be in the job region.
    const region = npc.region(npc.cfg.job_region);
    if (!isInRegion(bot, region)) {
        await gotoRegion(bot, region, npc.log);
        return;
    }

    // 4. Replant first if we owe a sapling.
    if (st.lastTreeBase) {
        await tryReplant(npc, st.lastTreeBase);
        st.lastTreeBase = null;
    }

    // 5. Find and chop nearest log.
    const logIds = mcCompat.registryBlockIds(bot, LOG_NAMES);
    const found = bot.findBlocks({ point: region.center, matching: logIds, maxDistance: region.radius + 4, count: 1 });
    if (found.length === 0) {
        if (st.complainedNoTrees++ % 20 === 0) npc.log.info('no trees in job region, waiting for regrowth');
        await sleep(5000);
        return;
    }

    const base = bot.blockAt(found[0]);
    if (!base || !mcCompat.blockMatchesAnyName(base, LOG_NAMES, bot)) {
        npc.log.warn('tree block unloaded before chopping');
        await sleep(1500);
        return;
    }
    npc.log.info(`chopping ${base.name} at ${base.position}`);
    try {
        await chopTree(bot, base, npc.log);
        st.lastTreeBase = { pos: base.position.clone(), logName: canonicalLogName(base, bot) };
        await sleep(1500); // let drops fly toward us / settle
        await pickupNearbyDrops(bot);
    } catch (e) {
        npc.log.warn(`chop failed: ${e.message}`);
        await sleep(2000);
    }
}

// Chop the whole trunk: dig the found log, then keep digging connected logs above.
async function chopTree(bot, baseBlock, log) {
    let current = baseBlock;
    for (let i = 0; i < 20 && current && mcCompat.blockMatchesAnyName(current, LOG_NAMES, bot); i++) {
        // get close enough to dig
        if (bot.entity.position.distanceTo(current.position) > 4.5) {
            const p = current.position;
            if (!await gotoNear(bot, p, 3, log, 10000))
                throw new Error('tree is unreachable');
        }
        await equipBestAxe(bot);
        await bot.dig(current);
        // next log directly above the original base
        current = bot.blockAt(baseBlock.position.offset(0, i + 1, 0));
    }
}

async function equipBestAxe(bot) {
    for (const name of AXES) {
        const it = bot.inventory.items().find(i => i.name === name);
        if (it) { try { await bot.equip(it, 'hand'); } catch { /* ignore */ } return; }
    }
}

async function pickupNearbyDrops(bot) {
    const drops = Object.values(bot.entities).filter(e =>
        e.name === 'item' && e.position.distanceTo(bot.entity.position) < 8);
    for (const d of drops.slice(0, 5)) {
        try {
            const p = d.position;
            await gotoNear(bot, p, 1, null, 4000);
        } catch { /* drop may despawn or be unreachable; fine */ }
    }
}

async function tryReplant(npc, treeBase) {
    const bot = npc.bot;
    const saplingName = SAPLING_FOR[treeBase.logName];
    if (!saplingName) return;
    const sapling = bot.inventory.items().find(i => mcCompat.stackMatchesName(i, saplingName, bot));
    if (!sapling) return;
    const ground = bot.blockAt(treeBase.pos.offset(0, -1, 0));
    const spot = bot.blockAt(treeBase.pos);
    if (!ground || !mcCompat.blockMatchesAnyName(ground, ['dirt', 'grass_block', 'podzol', 'coarse_dirt'], bot)) return;
    if (spot && spot.name !== 'air') return;
    try {
        if (bot.entity.position.distanceTo(treeBase.pos) > 4) {
            const p = treeBase.pos;
            if (!await gotoNear(bot, p, 3, npc.log, 10000))
                return;
        }
        await bot.equip(sapling, 'hand');
        await bot.placeBlock(ground, new Vec3(0, 1, 0));
        npc.log.info(`replanted ${saplingName}`);
    } catch (e) {
        npc.log.warn(`replant failed: ${e.message}`);
    }
}

// Get an axe: inventory -> home chests (storage_index) -> town fallback chest -> bare hands.
async function ensureAxe(npc) {
    const bot = npc.bot;
    if (bot.inventory.items().some(i => AXES.includes(i.name))) return;

    // home storage
    for (const axe of AXES) {
        if (npc.storage.totalOf(axe, npc.cfg.home_region) > 0) {
            const home = npc.region(npc.cfg.home_region);
            const entry = npc.storage.locate(axe, npc.cfg.home_region)[0];
            const ok = await gotoRegion(bot, home, npc.log);
            if (!ok) break;
            const chest = bot.blockAt(new Vec3(entry.pos.x, entry.pos.y, entry.pos.z));
            if (chest) {
                const got = await npc.storage.withdraw(bot, chest, axe, 1, npc.cfg.home_region);
                if (got > 0) { npc.log.info(`took ${axe} from home chest`); return; }
            }
        }
    }

    // town fallback chest (logged — phase 7 will charge a fee for this)
    const fallback = npc.locations['mestna_zaloga'];
    if (fallback) {
        const chest = await gotoChestInRegion(
            bot, fallback, npc.storage, npc.log, Object.values(npc.cfg.chests ?? {}));
        if (chest) {
            for (const axe of AXES) {
                const got = await npc.storage.withdraw(bot, chest, axe, 1, 'mestna_zaloga');
                if (got > 0) {
                    npc.log.warn(`TOWN STOCK USED: took ${axe} from mestna_zaloga`);
                    return;
                }
            }
        }
    }
    npc.log.warn('no axe anywhere — chopping bare-handed (slow)');
}

// Deliver logs according to job_rules: deliver_to region's chest, keep keep_ratio at home.
async function deliver(npc) {
    const bot = npc.bot;
    const rules = npc.cfg.job_rules ?? { deliver_to: npc.cfg.home_region, keep_ratio: 1 };
    const isLog = (i) => isLogStack(i, bot);
    const totalLogs = bot.inventory.items().filter(isLog).reduce((s, i) => s + i.count, 0);
    if (totalLogs === 0) {
        // inventory full of junk, dump everything-not-tool at home
        npc.log.info('inventory full (no logs) — dumping non-tools at home');
        await dumpAtHome(npc, (i) => !AXES.includes(i.name));
        return;
    }

    const keep = Math.floor(totalLogs * (rules.keep_ratio ?? 0));
    npc.log.info(`delivering: ${totalLogs} logs, keep ${keep} home, rest -> '${rules.deliver_to}'`);

    // 1. keep_ratio portion -> home chest
    if (keep > 0) {
        let toKeep = keep;
        await dumpAtHome(npc, (i) => {
            if (!isLog(i) || toKeep <= 0) return false;
            toKeep -= i.count; // approximation per stack
            return true;
        });
    }

    // 2. rest -> deliver_to chest
    const targetRegion = npc.region(rules.deliver_to);
    const chest = await gotoChestInRegion(
        bot, targetRegion, npc.storage, npc.log, Object.values(npc.cfg.chests ?? {}));
    if (!chest) {
        npc.log.warn(`no chest found in '${rules.deliver_to}' — keeping logs, will retry`);
        await sleep(10_000);
        return;
    }
    const n = await npc.storage.deposit(bot, chest, isLog, rules.deliver_to);
    npc.log.info(`delivered ${n} logs to '${rules.deliver_to}'`);
}

async function dumpAtHome(npc, matchFn) {
    const home = npc.region(npc.cfg.home_region);
    const chest = await gotoChestInRegion(
        npc.bot, home, npc.storage, npc.log, Object.values(npc.cfg.chests ?? {}));
    if (!chest) { npc.log.warn('no chest at home to dump into'); return; }
    const n = await npc.storage.deposit(npc.bot, chest, matchFn, npc.cfg.home_region);
    npc.log.info(`stored ${n} items at home`);
}
