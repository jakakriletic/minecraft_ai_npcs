// Deterministic task loadouts. This module is the bridge between high-level
// intent ("go mine", "guard the king") and the inventory/equipment a player-like
// NPC should carry before starting.
import * as base from './base.js';
import * as combat from './combat.js';
import * as skills from './skills.js';
import * as storage from './storage.js';
import * as survival from './survival.js';
import * as world from './world.js';

export const FOOD = [
    'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    'baked_potato', 'apple', 'carrot', 'golden_carrot', 'cooked_cod',
    'cooked_salmon', 'cooked_fish', 'cooked_rabbit', 'fish',
];
export const AMMO = ['arrow', 'spectral_arrow', 'tipped_arrow'];
export const SUPPORT_BLOCKS = [
    'cobblestone', 'stone', 'dirt', 'planks', 'oak_planks', 'spruce_planks',
    'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks',
];
export const SEEDS = ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds'];

const TOOL_KINDS = ['pickaxe', 'axe', 'sword', 'shovel', 'hoe'];
const TIER_SCORE = {
    wooden: 1,
    golden: 1.5,
    stone: 2,
    iron: 3,
    diamond: 4,
    netherite: 5,
};

export const LOADOUT_PROFILES = {
    miner: {
        label: 'miner',
        minHealth: 14,
        minHunger: 12,
        returnPoint: true,
        food: 4,
        torches: 16,
        supportBlocks: 16,
        freeSlots: 4,
        tools: { pickaxe: 'stone', sword: 'stone' },
        optionalTools: { shovel: 'stone' },
    },
    builder: {
        label: 'builder',
        minHealth: 10,
        storage: true,
        food: 2,
        supportBlocks: 24,
        freeSlots: 8,
        tools: { axe: 'stone', pickaxe: 'stone' },
        optionalTools: { shovel: 'stone' },
    },
    farmer: {
        label: 'farmer',
        minHealth: 10,
        returnPoint: true,
        food: 2,
        seeds: 4,
        freeSlots: 4,
        tools: { hoe: 'wooden' },
        optionalItems: ['bucket', 'water_bucket'],
    },
    ranger: {
        label: 'ranger',
        minHealth: 16,
        minHunger: 12,
        food: 4,
        arrows: 12,
        freeSlots: 3,
        shield: true,
        bow: true,
        tools: { sword: 'stone' },
    },
    steward: {
        label: 'steward',
        minHealth: 10,
        storage: true,
        food: 2,
        freeSlots: 10,
        optionalTools: { axe: 'stone', pickaxe: 'stone' },
    },
    explorer: {
        label: 'explorer',
        minHealth: 16,
        minHunger: 14,
        returnPoint: true,
        food: 6,
        torches: 16,
        supportBlocks: 16,
        freeSlots: 6,
        tools: { pickaxe: 'stone', axe: 'stone', sword: 'stone' },
        optionalTools: { shovel: 'stone' },
    },
    escort: {
        label: 'escort',
        minHealth: 16,
        minHunger: 12,
        food: 4,
        arrows: 8,
        supportBlocks: 8,
        freeSlots: 3,
        shield: true,
        tools: { sword: 'stone' },
        optionalItems: ['bow'],
    },
};

const PROFILE_ALIASES = {
    mine: 'miner',
    mining: 'miner',
    miner: 'miner',
    build: 'builder',
    building: 'builder',
    builder: 'builder',
    farm: 'farmer',
    farming: 'farmer',
    farmer: 'farmer',
    guard: 'ranger',
    guardian: 'ranger',
    ranger: 'ranger',
    combat: 'ranger',
    storage: 'steward',
    steward: 'steward',
    logistics: 'steward',
    scout: 'explorer',
    scouting: 'explorer',
    explore: 'explorer',
    explorer: 'explorer',
    follow: 'escort',
    escort: 'escort',
    king: 'escort',
    royal: 'escort',
};

function safe(fn, fallback = null) {
    try {
        const value = fn();
        return value === undefined ? fallback : value;
    } catch {
        return fallback;
    }
}

function count(bot, names) {
    const inventory = world.getInventoryCounts(bot);
    return (Array.isArray(names) ? names : [names])
        .reduce((sum, name) => sum + (inventory[name] ?? 0), 0);
}

function tierOf(name) {
    return Object.keys(TIER_SCORE).find(tier => name?.startsWith(`${tier}_`)) ?? null;
}

function itemScore(item) {
    if (!item) return 0;
    const tier = tierOf(item.name);
    const durability = item.maxDurability
        ? Math.max(0, 1 - (item.durabilityUsed ?? 0) / item.maxDurability)
        : 1;
    return (TIER_SCORE[tier] ?? 0) * 100 + durability;
}

function bestTool(bot, kind) {
    const best = bot.inventory.items()
        .filter(item => item.name.endsWith(`_${kind}`))
        .sort((a, b) => itemScore(b) - itemScore(a))[0];
    if (!best) return { name: null, tier: null, score: 0 };
    return { name: best.name, tier: tierOf(best.name), score: itemScore(best) };
}

function toolMeets(bot, kind, tier) {
    const tool = bestTool(bot, kind);
    return Boolean(tool.tier) && (TIER_SCORE[tool.tier] ?? 0) >= (TIER_SCORE[tier] ?? 0);
}

function equipmentSlot(bot, destination) {
    if (typeof bot.getEquipmentDestSlot !== 'function') return null;
    return bot.inventory.slots[bot.getEquipmentDestSlot(destination)] ?? null;
}

function hasItemOrEquipped(bot, name) {
    if (count(bot, name) > 0) return true;
    if (name === 'shield') return equipmentSlot(bot, 'off-hand')?.name === 'shield';
    return false;
}

function hasAny(bot, names) {
    return names.some(name => hasItemOrEquipped(bot, name));
}

export function normalizeTaskName(taskName = 'steward') {
    const key = String(taskName || 'steward').trim().toLowerCase();
    return PROFILE_ALIASES[key] ?? key;
}

export function getLoadoutProfile(taskName = 'steward') {
    const name = normalizeTaskName(taskName);
    return LOADOUT_PROFILES[name] ? { name, ...LOADOUT_PROFILES[name] } : null;
}

export function loadoutProfileNames() {
    return Object.keys(LOADOUT_PROFILES);
}

function addMissing(missing, blockers, entry, required = true) {
    missing.push({ ...entry, required });
    if (required) blockers.push(entry.reason);
}

export function summarizeInventory(bot) {
    const inventory = world.getInventoryCounts(bot);
    const tools = Object.fromEntries(TOOL_KINDS.map(kind => [kind, bestTool(bot, kind)]));
    return {
        inventory,
        tools,
        food: count(bot, FOOD),
        torches: count(bot, 'torch'),
        arrows: count(bot, AMMO),
        supportBlocks: count(bot, SUPPORT_BLOCKS),
        seeds: count(bot, SEEDS),
        emptySlots: safe(() => bot.inventory.emptySlotCount(), 0),
        hasShield: hasItemOrEquipped(bot, 'shield'),
        hasBow: hasItemOrEquipped(bot, 'bow'),
    };
}

export function getLoadoutStatus(bot, taskName = 'steward') {
    const profile = getLoadoutProfile(taskName);
    if (!profile) {
        return {
            name: normalizeTaskName(taskName),
            ready: false,
            blockers: [`unknown loadout profile "${taskName}"`],
            warnings: [`known profiles: ${loadoutProfileNames().join(', ')}`],
            missing: [],
            inventory: summarizeInventory(bot),
            profile: null,
        };
    }

    const summary = summarizeInventory(bot);
    const blockers = [];
    const warnings = [];
    const missing = [];
    const home = base.getBase(bot);
    const personalAnchor = base.getPersonalAnchor(bot);
    const publicStorage = storage.getPublicStorageAnchor(bot) ?? storage.getPublicStorage(bot);
    const hasReturnPoint = Boolean(home || personalAnchor || publicStorage);
    const hasStorage = Boolean(personalAnchor || publicStorage);

    if (!bot?.entity) blockers.push('not spawned');
    if (Number(bot.health ?? 20) < (profile.minHealth ?? 0))
        blockers.push(`health ${Math.round(bot.health ?? 0)}/${profile.minHealth}`);
    if (Number(bot.food ?? 20) < (profile.minHunger ?? 0))
        blockers.push(`hunger ${Math.round(bot.food ?? 0)}/${profile.minHunger}`);
    if (profile.returnPoint && !hasReturnPoint)
        blockers.push('needs home/camp return point');
    if (profile.storage && !hasStorage)
        blockers.push('needs storage/home/camp');
    if (profile.freeSlots && summary.emptySlots < profile.freeSlots)
        addMissing(missing, blockers, {
            type: 'space',
            reason: `needs ${profile.freeSlots} free slots`,
            have: summary.emptySlots,
            need: profile.freeSlots,
        });
    if (profile.food && summary.food < profile.food)
        addMissing(missing, blockers, {
            type: 'item',
            item: 'food',
            reason: `needs ${profile.food} carried food`,
            have: summary.food,
            need: profile.food,
        });
    if (profile.torches && summary.torches < profile.torches)
        addMissing(missing, blockers, {
            type: 'item',
            item: 'torch',
            reason: `needs ${profile.torches} torches`,
            have: summary.torches,
            need: profile.torches,
        });
    if (profile.supportBlocks && summary.supportBlocks < profile.supportBlocks)
        addMissing(missing, blockers, {
            type: 'item',
            item: 'support_blocks',
            reason: `needs ${profile.supportBlocks} support blocks`,
            have: summary.supportBlocks,
            need: profile.supportBlocks,
        });
    if (profile.seeds && summary.seeds < profile.seeds)
        addMissing(missing, blockers, {
            type: 'item',
            item: 'seeds',
            reason: `needs ${profile.seeds} seeds`,
            have: summary.seeds,
            need: profile.seeds,
        });
    if (profile.arrows && summary.arrows < profile.arrows)
        addMissing(missing, blockers, {
            type: 'item',
            item: 'arrow',
            reason: `needs ${profile.arrows} arrows`,
            have: summary.arrows,
            need: profile.arrows,
        });
    if (profile.shield && !summary.hasShield)
        addMissing(missing, blockers, {
            type: 'item',
            item: 'shield',
            reason: 'needs shield',
            have: 0,
            need: 1,
        });
    if (profile.bow && !summary.hasBow)
        addMissing(missing, blockers, {
            type: 'item',
            item: 'bow',
            reason: 'needs bow',
            have: 0,
            need: 1,
        });

    for (const [kind, tier] of Object.entries(profile.tools ?? {})) {
        if (!toolMeets(bot, kind, tier))
            addMissing(missing, blockers, {
                type: 'tool',
                item: `${tier}_${kind}`,
                kind,
                tier,
                reason: `needs ${tier}+ ${kind}`,
                have: summary.tools[kind]?.name ?? null,
                need: `${tier}+`,
            });
    }

    for (const [kind, tier] of Object.entries(profile.optionalTools ?? {})) {
        if (!toolMeets(bot, kind, tier))
            warnings.push(`optional ${tier}+ ${kind} missing`);
    }
    for (const item of profile.optionalItems ?? []) {
        const names = Array.isArray(item) ? item : [item];
        if (!hasAny(bot, names))
            warnings.push(`optional ${names.join('/')} missing`);
    }

    return {
        name: profile.name,
        label: profile.label,
        ready: blockers.length === 0,
        blockers,
        warnings,
        missing,
        inventory: summary,
        profile,
    };
}

export function getAllLoadoutStatuses(bot) {
    return Object.fromEntries(loadoutProfileNames()
        .map(name => [name, getLoadoutStatus(bot, name)]));
}

async function ensureSpace(bot, profile) {
    if (!profile.freeSlots || safe(() => bot.inventory.emptySlotCount(), 0) >= profile.freeSlots)
        return true;
    if (!base.getPersonalAnchor(bot)) await base.setupBase(bot);
    if (safe(() => bot.inventory.emptySlotCount(), 0) >= profile.freeSlots)
        return true;
    return await base.stash(bot);
}

async function ensureFood(bot, target) {
    if (!target || count(bot, FOOD) >= target) return true;
    if (base.getPersonalAnchor(bot)) await base.takeAny(bot, FOOD, target);
    if (count(bot, FOOD) >= target) return true;
    await survival.secureFood(bot);
    return count(bot, FOOD) >= Math.min(1, target) || count(bot, FOOD) >= target;
}

async function ensureSupportBlocks(bot, target) {
    if (!target || count(bot, SUPPORT_BLOCKS) >= target) return true;
    if (base.getPersonalAnchor(bot)) await base.takeAny(bot, SUPPORT_BLOCKS, target);
    if (count(bot, SUPPORT_BLOCKS) >= target) return true;
    try { await skills.ensureCobblestone(bot, target); } catch { /* no nearby stone */ }
    return count(bot, SUPPORT_BLOCKS) >= target;
}

async function ensureSeeds(bot, target) {
    if (!target || count(bot, SEEDS) >= target) return true;
    if (base.getPersonalAnchor(bot)) await base.takeAny(bot, SEEDS, target);
    return count(bot, SEEDS) >= target;
}

async function ensureTorches(bot, target) {
    if (!target || count(bot, 'torch') >= target) return true;
    if (base.getPersonalAnchor(bot))
        await base.takeNeeded(bot, { torch: target, coal: 4, charcoal: 4, stick: 4 });
    if (count(bot, 'torch') >= target) return true;
    await survival.makeTorches(bot, target, false);
    return count(bot, 'torch') >= target;
}

async function ensureTool(bot, kind, tier) {
    if (toolMeets(bot, kind, tier)) return true;
    if (['pickaxe', 'axe', 'sword'].includes(kind)) {
        try { await survival.maintainTools(bot); } catch { /* fall through */ }
        if (toolMeets(bot, kind, tier)) return true;
    }
    const candidates = Object.keys(TIER_SCORE)
        .filter(candidate => (TIER_SCORE[candidate] ?? 0) >= (TIER_SCORE[tier] ?? 0))
        .sort((a, b) => (TIER_SCORE[a] ?? 0) - (TIER_SCORE[b] ?? 0));
    for (const candidate of candidates) {
        if (bot.interrupt_code) break;
        try {
            if (await skills.obtainTool(bot, `${candidate}_${kind}`)) return true;
        } catch { /* try the next tier */ }
    }
    return toolMeets(bot, kind, tier);
}

async function ensureShield(bot) {
    if (hasItemOrEquipped(bot, 'shield')) return true;
    try {
        await base.takeNeeded(bot, { shield: 1, iron_ingot: 1 });
        await base.takeAny(bot, SUPPORT_BLOCKS.filter(name => name.includes('planks') || name === 'planks'), 6);
        if (!hasItemOrEquipped(bot, 'shield')) await skills.craftRecipe(bot, 'shield', 1);
        if (hasItemOrEquipped(bot, 'shield')) {
            try { await skills.equip(bot, 'shield'); } catch { /* off-hand may not exist */ }
        }
    } catch { /* materials missing */ }
    return hasItemOrEquipped(bot, 'shield');
}

async function ensureCombat(agent, profile) {
    if (!profile.bow && !profile.arrows && !profile.shield) return true;
    let ok = true;
    try {
        await combat.ensureCombatKit(agent, {
            gather: false,
            arrowTarget: profile.arrows ?? 8,
        });
    } catch { /* best effort */ }
    if (profile.shield) ok = await ensureShield(agent.bot) && ok;
    if (profile.bow) ok = hasItemOrEquipped(agent.bot, 'bow') && ok;
    if (profile.arrows) ok = count(agent.bot, AMMO) >= profile.arrows && ok;
    return ok;
}

export async function prepareForTask(agent, taskName = 'steward', options = {}) {
    const bot = agent.bot;
    const profile = getLoadoutProfile(taskName);
    if (!profile) return getLoadoutStatus(bot, taskName);

    const hasSharedStorage = storage.getPublicStorageAnchor(bot) ?? storage.getPublicStorage(bot);
    if (profile.returnPoint && !base.getPersonalAnchor(bot) && !hasSharedStorage && options.claimCamp !== false)
        await base.setupBase(bot);
    if (profile.storage && !base.getPersonalAnchor(bot) && !hasSharedStorage && options.claimCamp !== false)
        await base.setupBase(bot);

    if (Number(bot.health ?? 20) < (profile.minHealth ?? 0))
        await survival.recoverHealth(bot, Math.min(20, Math.max(profile.minHealth, 18)));

    await ensureSpace(bot, profile);
    await ensureFood(bot, profile.food);
    await ensureSeeds(bot, profile.seeds);

    for (const [kind, tier] of Object.entries(profile.tools ?? {})) {
        if (bot.interrupt_code) break;
        await ensureTool(bot, kind, tier);
    }

    await ensureTorches(bot, profile.torches);
    await ensureSupportBlocks(bot, profile.supportBlocks);
    await ensureCombat(agent, profile);

    return getLoadoutStatus(bot, profile.name);
}

function compactMissing(status) {
    if (status.ready) return 'ready';
    return status.blockers.join(', ');
}

export function formatLoadoutStatus(bot, taskName = 'all') {
    if (String(taskName ?? 'all').toLowerCase() === 'all') {
        return loadoutProfileNames()
            .map(name => formatLoadoutStatus(bot, name))
            .join('\n');
    }
    const status = getLoadoutStatus(bot, taskName);
    const inv = status.inventory;
    return `LOADOUT ${status.name}: ${status.ready ? 'READY' : 'BLOCKED'} | ${compactMissing(status)} | `
        + `food=${inv.food}, torches=${inv.torches}, arrows=${inv.arrows}, blocks=${inv.supportBlocks}, slots=${inv.emptySlots} | `
        + `pick=${inv.tools.pickaxe.name ?? 'none'}, axe=${inv.tools.axe.name ?? 'none'}, sword=${inv.tools.sword.name ?? 'none'}, shield=${inv.hasShield ? 'yes' : 'no'}, bow=${inv.hasBow ? 'yes' : 'no'}`
        + (status.warnings.length ? ` | warnings: ${status.warnings.join(', ')}` : '');
}
