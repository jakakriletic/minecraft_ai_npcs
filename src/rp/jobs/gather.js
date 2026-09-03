// Generic harvesting job (miner, stone-cutter, generic gatherer): dig a
// configurable set of target blocks (npc.cfg.gather_targets) inside the job
// region and deliver per job_rules. No replanting (that's woodcutter's thing).
// Pure deterministic code — no LLM. The AI only PICKS the targets/region/rules.
import { gotoRegion, gotoNear, isInRegion, sleep } from '../core/movement.js';
import { gotoChestInRegion } from '../core/storage.js';
import * as mcCompat from '../../utils/mc_compat.js';

const PICKAXES = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe'];
const NON_DELIVER = new Set([...PICKAXES,
    'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe',
    'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword']);

export async function gatherStep(npc) {
    const bot = npc.bot;
    const st = (npc.jobState ??= { toolChecked: false, complained: 0 });
    const targets = npc.cfg.gather_targets?.length ? npc.cfg.gather_targets : ['stone', 'cobblestone', 'coal_ore', 'iron_ore', 'copper_ore'];

    if (!st.toolChecked) { await ensurePick(npc); st.toolChecked = true; }

    if (bot.inventory.emptySlotCount() <= 1) { await deliver(npc); return; }

    const region = npc.region(npc.cfg.job_region);
    if (!isInRegion(bot, region)) { await gotoRegion(bot, region, npc.log); return; }

    const ids = mcCompat.registryBlockIds(bot, targets);
    const found = bot.findBlocks({ point: region.center, matching: ids, maxDistance: region.radius + 4, count: 1 });
    if (found.length === 0) {
        if (st.complained++ % 20 === 0) npc.log.info('no target blocks in region, waiting');
        await sleep(4000);
        return;
    }
    const block = bot.blockAt(found[0]);
    if (!block || !block.diggable) {
        npc.log.warn('target block unloaded or not diggable');
        await sleep(1500);
        return;
    }
    npc.log.info(`mining ${block.name} at ${block.position}`);
    try {
        if (bot.entity.position.distanceTo(block.position) > 4.5) {
            const p = block.position;
            if (!await gotoNear(bot, p, 3, npc.log, 10000))
                throw new Error('target block is unreachable');
        }
        await equipPick(bot);
        await bot.dig(block);
        await sleep(800);
        await pickupDrops(bot);
    } catch (e) {
        npc.log.warn(`dig failed: ${e.message}`);
        await sleep(1500);
    }
}

async function pickupDrops(bot) {
    const drops = Object.values(bot.entities).filter(e =>
        e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < 8);
    for (const d of drops.slice(0, 5)) {
        try { await gotoNear(bot, d.position, 1, null, 4000); }
        catch { /* despawned */ }
    }
}

async function deliver(npc) {
    const bot = npc.bot;
    const rules = npc.cfg.job_rules ?? { deliver_to: npc.cfg.home_region, keep_ratio: 0 };
    const region = npc.region(rules.deliver_to);
    const chest = await gotoChestInRegion(
        bot, region, npc.storage, npc.log, Object.values(npc.cfg.chests ?? {}));
    if (!chest) { npc.log.warn(`no chest in '${rules.deliver_to}', keeping load`); await sleep(8000); return; }
    const n = await npc.storage.deposit(bot, chest, (i) => !NON_DELIVER.has(i.name), rules.deliver_to);
    npc.log.info(`delivered ${n} items to '${rules.deliver_to}'`);
}

async function ensurePick(npc) {
    const bot = npc.bot;
    if (bot.inventory.items().some(i => PICKAXES.includes(i.name))) return;
    for (const pick of PICKAXES) {
        if (npc.storage.totalOf(pick, npc.cfg.home_region) > 0) {
            const ok = await gotoRegion(bot, npc.region(npc.cfg.home_region), npc.log);
            if (!ok) break;
            const entry = npc.storage.locate(pick, npc.cfg.home_region)[0];
            const { Vec3 } = await import('vec3');
            const chest = bot.blockAt(new Vec3(entry.pos.x, entry.pos.y, entry.pos.z));
            if (chest) {
                const got = await npc.storage.withdraw(bot, chest, pick, 1, npc.cfg.home_region);
                if (got > 0) { npc.log.info(`took ${pick} from home`); return; }
            }
        }
    }
    npc.log.warn('no pickaxe — mining will yield little');
}

async function equipPick(bot) {
    for (const name of PICKAXES) {
        const it = bot.inventory.items().find(i => i.name === name);
        if (it) { try { await bot.equip(it, 'hand'); } catch { /* */ } return; }
    }
}
