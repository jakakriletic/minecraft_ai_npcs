// Home base for Mindcraft agents: a persistent spot (per bot) where the bot
// stashes items, places a chest/furnace/crafting table, and builds. Persisted to
// bots/<name>/base.json so it survives restarts (Mindcraft's memory_bank does not).
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import * as world from './world.js';
import { log, goToPosition, travelToPosition, placeBlock, craftRecipe } from './skills.js';
import { withContainerLock } from './container_lock.js';
import { Vec3 } from 'vec3';
import * as storage from './storage.js';
import * as camp from './camp.js';
import * as mc from '../../utils/mcdata.js';

const DEFAULT_RADIUS = 10; // 20x20 area

const AMMUNITION = ['arrow', 'spectral_arrow', 'tipped_arrow'];
const FOOD = ['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'baked_potato',
    'apple', 'carrot', 'golden_carrot', 'cooked_cod', 'cooked_salmon', 'cooked_fish', 'cooked_rabbit', 'fish'];
const SEEDS = ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds'];
const TOOL_SUFFIXES = ['_pickaxe', '_axe', '_sword', '_shovel', '_hoe'];
const ARMOR_SUFFIXES = ['_helmet', '_chestplate', '_leggings', '_boots'];
const PERSONAL_EQUIPMENT_SUFFIXES = [...TOOL_SUFFIXES, ...ARMOR_SUFFIXES];
const TOOL_TIERS = {
    wooden: 1,
    golden: 1.5,
    stone: 2,
    iron: 3,
    diamond: 4,
    netherite: 5,
};
const PRIORITY_SHARED_RESOURCES = new Set([
    'raw_iron', 'raw_gold', 'raw_copper', 'iron_ingot', 'gold_ingot',
    'copper_ingot', 'diamond', 'emerald', 'lapis_lazuli', 'redstone',
    'quartz', 'amethyst_shard', 'dye',
]);
const baseCache = new WeakMap();

function baseFile(bot) { return `./bots/${bot.username}/base.json`; }

export function getBase(bot) {
    if (baseCache.has(bot)) {
        const cached = baseCache.get(bot);
        bot._settlementHome = cached;
        return cached;
    }
    try {
        const value = JSON.parse(readFileSync(baseFile(bot), 'utf8'));
        baseCache.set(bot, value);
        bot._settlementHome = value;
        return value;
    } catch {
        baseCache.set(bot, null);
        bot._settlementHome = null;
        return null;
    }
}

export function setHome(bot, x, y, z, radius = DEFAULT_RADIUS) {
    const base = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), radius };
    const f = baseFile(bot);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(base, null, 2));
    baseCache.set(bot, base);
    bot._settlementHome = base;
    // Home doubles as the respawn point. /spawnpoint only works if the server
    // gave the bot permission — otherwise it is silently refused and death
    // recovery falls back to long-range travel home (goHome handles distance).
    try { bot.chat(`/spawnpoint ${bot.username} ${base.x} ${base.y} ${base.z}`); } catch { /* disconnected */ }
    log(bot, `Baza nastavljena pri ${base.x},${base.y},${base.z} (radij ${radius}).`);
    return base;
}

export function distanceFromHome(bot) {
    const base = getBase(bot);
    if (!base || !bot.entity) return 0;
    const p = bot.entity.position;
    return Math.hypot(p.x - base.x, p.y - base.y, p.z - base.z);
}

export async function goHome(bot) {
    const base = getBase(bot);
    if (!base) { log(bot, 'Nimam še baze. Igralec naj uporabi !setHome.'); return false; }
    // Beyond one pathfinder search there is no single-trip path home (search
    // radius ~128), so a lost bot switches to waypoint travel by coordinates.
    const searchRadius = bot.pathfinder?.searchRadius > 0 ? bot.pathfinder.searchRadius : 128;
    if (distanceFromHome(bot) > searchRadius * 0.8)
        return await travelToPosition(bot, base.x, base.y, base.z, 3);
    return await goToPosition(bot, base.x, base.y, base.z, 3);
}

// Forget the owner-set home (leash, auto-return, respawn anchor). The old home
// spot lives on as the bot's personal camp so its chest corner stays reachable.
export function clearHome(bot) {
    const existing = getBase(bot);
    if (existing && !camp.getCamp(bot))
        camp.setCamp(bot, existing.x, existing.y, existing.z);
    try { unlinkSync(baseFile(bot)); } catch { /* none saved */ }
    baseCache.set(bot, null);
    bot._settlementHome = null;
    log(bot, 'Baze nimam več — od zdaj se znajdem po svoje.');
    return true;
}

// Anchor for the bot's OWN storage work (stash/fetch/smelt): owner-set home wins,
// otherwise the bot's self-claimed personal camp. Never used for leashing.
export function getPersonalAnchor(bot) {
    return getBase(bot) ?? camp.getCamp(bot);
}

// Walk to the personal storage anchor. With claim=true a home-less bot that has no
// camp yet claims one at its current spot (only under open sky), like a player
// deciding where to drop their first chest.
export async function goPersonalAnchor(bot, { claim = false } = {}) {
    if (getBase(bot)) return await goHome(bot);
    let spot = camp.getCamp(bot);
    if (!spot) {
        if (!claim || !bot.entity) return false;
        if (!camp.canClaimCampHere(bot)) {
            log(bot, 'Tu si ne bom uredil kotička (ni odprtega neba).');
            return false;
        }
        const p = bot.entity.position;
        camp.setCamp(bot, p.x, p.y, p.z);
        return true; // already standing there
    }
    const p = bot.entity?.position;
    if (!p) return false;
    const distance = Math.hypot(p.x - spot.x, p.y - spot.y, p.z - spot.z);
    if (distance <= 3) return true;
    const searchRadius = bot.pathfinder?.searchRadius > 0 ? bot.pathfinder.searchRadius : 128;
    if (distance > searchRadius * 0.8)
        return await travelToPosition(bot, spot.x, spot.y, spot.z, 3);
    return await goToPosition(bot, spot.x, spot.y, spot.z, 3);
}

function toolKind(name) {
    return TOOL_SUFFIXES.find(suffix => name.endsWith(suffix)) ?? null;
}

function isObsoleteWoodenEquipment(name) {
    return name.startsWith('wooden_')
        && TOOL_SUFFIXES.some(suffix => name.endsWith(suffix));
}

function hasTieredEquipment(counts, kind, tiers = ['iron', 'diamond', 'netherite']) {
    return tiers.some(tier => (counts[`${tier}_${kind}`] ?? 0) > 0);
}

function personalIronReserve(bot) {
    const counts = world.getInventoryCounts(bot);
    const missingTools = ['pickaxe', 'axe', 'sword'].some(kind => !hasTieredEquipment(counts, kind))
        || (counts.shield ?? 0) < 1;
    if (missingTools) return 12;

    const missingArmor = ['helmet', 'chestplate', 'leggings', 'boots']
        .some(kind => !hasTieredEquipment(counts, kind));
    return missingArmor ? 24 : 4;
}

function itemQuality(item) {
    const tier = Object.keys(TOOL_TIERS).find(name => item.name.startsWith(`${name}_`));
    const enchantmentBonus = (item.enchants ?? [])
        .reduce((total, enchantment) => total + Number(enchantment.lvl ?? 1), 0) * 0.1;
    const durability = item.maxDurability
        ? Math.max(0, 1 - (item.durabilityUsed ?? 0) / item.maxDurability)
        : 1;
    return (TOOL_TIERS[tier] ?? 0) + enchantmentBonus + durability * 0.05;
}

export function publicReserve(bot, name) {
    const ranged = bot._combatStyle === 'archer';
    if (FOOD.includes(name)) return 8;
    if (AMMUNITION.includes(name)) return ranged ? 24 : 12;
    if (name.endsWith('_log') || name === 'log' || name === 'log2') return 8;
    if (name.endsWith('_planks') || name === 'planks') return 24;
    if (name === 'cobblestone' || name === 'stone') return 24;
    if (name === 'dirt') return 16;
    if (name.includes('seed')) return 16;
    if (name === 'wheat') return 12;
    if (name === 'torch') return 16;
    if (name === 'stick') return 8;
    if (name === 'coal' || name === 'charcoal') return 8;
    if (name === 'iron_ingot' || name === 'raw_iron') return personalIronReserve(bot);
    if (name === 'gold_ingot') return 2;
    if (name === 'diamond') return 2;
    if (name === 'lapis_lazuli' || name === 'dye') return 3;
    if (name === 'bucket' || name === 'water_bucket') return 1;
    if (name === 'crafting_table' || name === 'furnace' || name === 'chest') return 1;
    return 0;
}

function reserveGroup(name) {
    if (FOOD.includes(name)) return 'food';
    if (AMMUNITION.includes(name)) return 'ammunition';
    if (SEEDS.includes(name) || name.includes('seed')) return 'seeds';
    if (name.endsWith('_log') || name === 'log' || name === 'log2') return 'logs';
    if (name.endsWith('_planks') || name === 'planks') return 'planks';
    if (name === 'raw_iron' || name === 'iron_ingot') return 'iron';
    return name;
}

export function publicContributionPlan(bot) {
    const items = bot.inventory.items();
    const keepSlots = new Set();

    for (const suffix of PERSONAL_EQUIPMENT_SUFFIXES) {
        const best = items
            .filter(item => item.name.endsWith(suffix))
            .sort((a, b) => itemQuality(b) - itemQuality(a))[0];
        if (best) keepSlots.add(best.slot);
    }
    for (const name of ['shield', 'bow', 'crossbow', 'shears', 'flint_and_steel']) {
        const best = items
            .filter(item => item.name === name)
            .sort((a, b) => itemQuality(b) - itemQuality(a))[0];
        if (best)
            keepSlots.add(best.slot);
    }

    const remainingReserve = new Map();
    const plan = new Map();
    for (const item of items) {
        if (bot._societyStoneBaseline && isObsoleteWoodenEquipment(item.name)) {
            plan.set(item.slot, 0);
            continue;
        }
        if (keepSlots.has(item.slot)) {
            plan.set(item.slot, 0);
            continue;
        }
        const group = reserveGroup(item.name);
        const reserve = remainingReserve.has(group)
            ? remainingReserve.get(group)
            : publicReserve(bot, item.name);
        const kept = Math.min(reserve, item.count);
        remainingReserve.set(group, Math.max(0, reserve - kept));
        plan.set(item.slot, Math.max(0, item.count - kept));
    }
    return plan;
}

export function publicContributionSize(bot) {
    return [...publicContributionPlan(bot).values()].reduce((sum, count) => sum + count, 0);
}

export function shouldVisitPublicStorage(bot) {
    const plan = publicContributionPlan(bot);
    const items = bot.inventory.items();
    const total = [...plan.values()].reduce((sum, count) => sum + count, 0);
    const priorityTotal = items.reduce((sum, item) =>
        sum + (PRIORITY_SHARED_RESOURCES.has(item.name) ? (plan.get(item.slot) ?? 0) : 0), 0);
    const spareEquipment = items.filter(item =>
        (plan.get(item.slot) ?? 0) > 0 && (item.stackSize ?? 64) === 1).length;
    return total >= 24
        || priorityTotal >= 8
        || spareEquipment >= 3
        || bot.inventory.emptySlotCount() <= 6;
}

export function needsPublicRestock(bot) {
    if (!storage.getPublicStorage(bot)) return false;
    const counts = world.getInventoryCounts(bot);
    const food = bot.inventory.items()
        .filter(item => FOOD.includes(item.name))
        .reduce((sum, item) => sum + item.count, 0);
    const seeds = SEEDS.reduce((sum, name) => sum + (counts[name] ?? 0), 0);
    return food < 3
        || (counts.arrow ?? 0) < 6
        || seeds < 4;
}

export async function restockFromPublic(bot) {
    if (!storage.getPublicStorage(bot)) return false;
    const before = world.getInventoryCounts(bot);
    const beforeTotal = Object.values(before).reduce((sum, count) => sum + count, 0);
    const food = bot.inventory.items()
        .filter(item => FOOD.includes(item.name))
        .reduce((sum, item) => sum + item.count, 0);
    const seeds = SEEDS.reduce((sum, name) => sum + (before[name] ?? 0), 0);

    if (food < 3)
        await storage.takeAnyPublic(bot, FOOD, 5);
    const needs = {};
    if ((before.arrow ?? 0) < 6)
        needs.arrow = bot._combatStyle === 'archer' ? 24 : 12;
    if (Object.keys(needs).length)
        await storage.takeNeededPublic(bot, needs);
    if (seeds < 4)
        await storage.takeAnyPublic(bot, SEEDS, 16);
    const afterTotal = Object.values(world.getInventoryCounts(bot))
        .reduce((sum, count) => sum + count, 0);
    return afterTotal > beforeTotal;
}

export function createPublicContributionSelector(bot) {
    const plan = publicContributionPlan(bot);
    const selector = item => plan.get(item.slot) ?? 0;
    selector.consume = (item, count) => {
        plan.set(item.slot, Math.max(0, (plan.get(item.slot) ?? 0) - count));
    };
    return selector;
}

// Go to chests near a position (e.g. the commanding player) and take items out.
// itemName null = take everything; otherwise only that item.
export async function takeFromChestsNear(bot, pos, radius = 6, itemName = null) {
    const chestIds = mc.registryBlockIds(bot, ['chest', 'trapped_chest', 'barrel']);
    const found = bot.findBlocks({ point: new Vec3(pos.x, pos.y, pos.z), matching: chestIds, maxDistance: radius + 2, count: 8 });
    if (found.length === 0) { log(bot, 'Ne najdem skrinje blizu tebe.'); return false; }

    let total = 0;
    const taken = {};
    for (const p of found) {
        if (bot.interrupt_code) break;
        const block = bot.blockAt(p);
        if (!block) continue;
        try {
            if (!await goToPosition(bot, p.x, p.y, p.z, 2)) continue;
            const result = await withContainerLock(bot, block, async () => {
                let container;
                try {
                    container = await storage.openContainerSafe(bot, block);
                    for (const it of container.containerItems()) {
                        if (itemName && !mc.stackMatchesName(it, itemName, bot)) continue;
                        try {
                            await container.withdraw(it.type, it.metadata, it.count, it.nbt);
                            total += it.count;
                            taken[it.name] = (taken[it.name] ?? 0) + it.count;
                        } catch { break; }
                    }
                    return true;
                } finally {
                    if (container)
                        try { await container.close(); } catch { /* disconnected */ }
                }
            });
            if (!result.locked) log(bot, 'Skrinja je trenutno v uporabi; poskusim kasneje.');
        } catch (e) {
            log(bot, `Skrinje ne morem odpreti: ${e.message}`);
        }
    }
    const summary = Object.entries(taken).slice(0, 6).map(([k, v]) => `${v}x ${k}`).join(', ');
    log(bot, total > 0 ? `Pobral iz skrinj: ${summary}.` : 'V skrinjah ni bilo nič zame (ali pa so moji žepi polni).');
    return total > 0;
}

// Ensure a utility block (chest/furnace/crafting_table) exists at the base; craft + place if missing.
async function ensureUtility(bot, item) {
    if (world.getNearestBlock(bot, item, 8)) return true;
    const shared = storage.getPublicStorage(bot);
    // Near the public storage, reuse its shared crafting table / furnace instead of
    // dropping a duplicate (bots clustered at the storage were each placing one).
    if (shared && item !== 'chest' && bot.entity) {
        const dist = Math.hypot(bot.entity.position.x - shared.x, bot.entity.position.z - shared.z);
        const group = item === 'furnace' ? ['furnace', 'blast_furnace', 'smoker'] : [item];
        if (dist <= (Number(shared.radius) || 12) + 10 && storage.publicHasUtility(bot, group))
            return true;
    }
    if (storage.getPublicStorage(bot))
        await storage.takeNeededPublic(bot, { [item]: 1 });
    if ((world.getInventoryCounts(bot)[item] ?? 0) < 1) await craftRecipe(bot, item, 1);
    if ((world.getInventoryCounts(bot)[item] ?? 0) < 1) { log(bot, `Ne morem narediti ${item} (manjka material).`); return false; }
    const spot = world.getNearestFreeSpace(bot, 1, 6);
    if (!spot) { log(bot, `Ni prostora za ${item}.`); return false; }
    if (!await placeBlock(bot, item, spot.x, spot.y, spot.z)) return false;
    log(bot, `Postavil ${item} v bazi.`);
    return true;
}

// Place crafting table + chest + furnace at the base (or the bot's own camp,
// claimed on the spot when it has no home).
export async function setupBase(bot) {
    if (!await goPersonalAnchor(bot, { claim: true })) return false;
    let complete = true;
    for (const item of ['crafting_table', 'chest', 'furnace']) {
        if (bot.interrupt_code) break;
        if (!await ensureUtility(bot, item))
            complete = false;
    }
    return complete && !bot.interrupt_code;
}

// Walk home (or to the bot's own camp, claiming one if needed) and deposit all
// non-essential items into a chest there (placing one if needed).
export async function stash(bot) {
    const amount = createPublicContributionSelector(bot);
    if (storage.getPublicStorage(bot))
        return await storage.stashPublic(bot, amount);
    const wanted = publicContributionSize(bot);
    if (!await goPersonalAnchor(bot, { claim: true })) return false;
    if (!await ensureUtility(bot, 'chest')) return false;
    const chest = world.getNearestBlock(bot, 'chest', 8);
    if (!chest) { log(bot, 'Ne najdem skrinje v bazi.'); return false; }

    if (!await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2)) return false;
    let deposited = 0;
    try {
        const result = await withContainerLock(bot, chest, async () => {
            let container;
            try {
                container = await storage.openContainerSafe(bot, chest);
                for (const item of bot.inventory.items()) {
                    const count = amount(item);
                    if (count <= 0) continue;
                    try {
                        await container.deposit(item.type, item.metadata, count, item.nbt);
                        amount.consume(item, count);
                        deposited += count;
                    }
                    catch { break; }
                }
                return true;
            } finally {
                if (container)
                    try { await container.close(); } catch { /* disconnected */ }
            }
        });
        if (!result.locked) return false;
    } catch (e) {
        log(bot, `Skrinje ne morem odpreti: ${e.message}`);
        return false;
    }
    // A full chest must count as failure so the brain backs off instead of
    // re-running a trivially "successful" stash every tick with a stuffed inventory.
    if (deposited === 0 && wanted > 0) {
        log(bot, 'Skrinja je polna — nič nisem uspel shraniti.');
        return false;
    }
    log(bot, deposited > 0 ? `Shranil ${deposited} stvari v bazo.` : 'Nič za shranit.');
    return true;
}

// Withdraw only the resources currently needed for progression. `needs` maps
// item name -> desired inventory count, so materials stored at home remain useful.
export async function takeNeeded(bot, needs) {
    if (storage.getPublicStorage(bot))
        await storage.takeNeededPublic(bot, needs);
    const inv = world.getInventoryCounts(bot);
    const missing = Object.entries(needs).filter(([name, target]) => (inv[name] ?? 0) < target);
    if (!missing.length) return true;
    if (!getPersonalAnchor(bot)) return false;
    if (!await goPersonalAnchor(bot)) return false;

    const chest = world.getNearestBlock(bot, 'chest', 8);
    if (!chest) return false;
    if (!await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2))
        return false;

    let moved = 0;
    try {
        const result = await withContainerLock(bot, chest, async () => {
            let container;
            try {
                container = await storage.openContainerSafe(bot, chest);
                for (const [name, target] of missing) {
                    const current = world.getInventoryCounts(bot)[name] ?? 0;
                    let remaining = Math.max(0, target - current);
                    for (const item of container.containerItems().filter(i => mc.stackMatchesName(i, name, bot))) {
                        if (remaining <= 0 || bot.interrupt_code) break;
                        const amount = Math.min(remaining, item.count);
                        await container.withdraw(item.type, item.metadata, amount, item.nbt);
                        remaining -= amount;
                        moved += amount;
                    }
                }
            } finally {
                if (container)
                    try { await container.close(); } catch { /* disconnected */ }
            }
        });
        if (!result.locked) return false;
    } catch {
        return false;
    }
    return moved > 0;
}

// Withdraw up to `targetCount` items across interchangeable names, such as any
// plank or log species. Unlike takeNeeded, this treats the names as one pool.
export async function takeAny(bot, names, targetCount) {
    const nameSet = new Set(names);
    let current = bot.inventory.items()
        .filter(item => mc.stackMatchesAnyName(item, [...nameSet], bot))
        .reduce((sum, item) => sum + item.count, 0);
    let remaining = Math.max(0, targetCount - current);
    if (remaining === 0) return true;
    if (storage.getPublicStorage(bot)) {
        await storage.takeAnyPublic(bot, names, targetCount);
        current = bot.inventory.items()
            .filter(item => mc.stackMatchesAnyName(item, [...nameSet], bot))
            .reduce((sum, item) => sum + item.count, 0);
        remaining = Math.max(0, targetCount - current);
        if (remaining === 0) return true;
    }
    if (!getPersonalAnchor(bot)) return false;
    if (!await goPersonalAnchor(bot)) return false;

    const chest = world.getNearestBlock(bot, 'chest', 8);
    if (!chest) return false;
    if (!await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2))
        return false;

    try {
        const result = await withContainerLock(bot, chest, async () => {
            let container;
            try {
                container = await storage.openContainerSafe(bot, chest);
                for (const item of container.containerItems()) {
                    if (!mc.stackMatchesAnyName(item, [...nameSet], bot) || remaining <= 0 || bot.interrupt_code) continue;
                    const amount = Math.min(remaining, item.count);
                    await container.withdraw(item.type, item.metadata, amount, item.nbt);
                    remaining -= amount;
                }
            } finally {
                if (container)
                    try { await container.close(); } catch { /* disconnected */ }
            }
        });
        if (!result.locked) return false;
    } catch {
        return false;
    }
    return remaining === 0;
}
