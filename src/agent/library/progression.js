// Persistent deterministic early-to-late progression for Mindcraft agents.
// The LLM may choose broad projects, but equipment progression is entirely code-driven.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { Vec3 } from 'vec3';
import settings from '../../../settings.js';
import * as world from './world.js';
import * as base from './base.js';
import * as build from './build.js';
import * as survival from './survival.js';
import * as storage from './storage.js';
import * as mc from '../../utils/mcdata.js';
import { actionOutcome } from './action_outcome.js';
import {
    craftRecipe,
    ensureLogs,
    ensurePlanks,
    equip,
    gearUp,
    log,
    placeBlock,
    smeltItem,
} from './skills.js';

const ARMOR = {
    iron: [
        ['iron_chestplate', 8],
        ['iron_leggings', 7],
        ['iron_helmet', 5],
        ['iron_boots', 4],
    ],
    diamond: [
        ['diamond_chestplate', 8],
        ['diamond_leggings', 7],
        ['diamond_helmet', 5],
        ['diamond_boots', 4],
    ],
};

const TOOLS = {
    iron: [['iron_pickaxe', 3], ['iron_axe', 3], ['iron_sword', 2], ['shield', 1]],
    diamond: [['diamond_pickaxe', 3], ['diamond_axe', 3], ['diamond_sword', 2]],
};
const STARTER_TORCH_TARGET = 16;
const ADVANCED_UTILITY_BLOCKS = [
    { item: 'enchanting_table', desired: 1 },
    { item: 'bookshelf', desired: 6 },
    { item: 'anvil', desired: 1, names: ['anvil', 'chipped_anvil', 'damaged_anvil'] },
];
const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log'];
const PLANKS = LOGS.map(name => name.replace('_log', '_planks'));
const TIER_SCORE = { wooden: 1, golden: 1.5, stone: 2, iron: 3, diamond: 4, netherite: 5 };
const STAGE_ORDER = [
    'bootstrap',
    'homestead',
    'starter_utility',
    'iron_tools',
    'iron_utility',
    'iron_armor',
    'shelter',
    'diamond_tools',
    'diamond_armor',
    'advanced_utility',
    'late_game',
];
const STAGE_MILESTONE = {
    bootstrap: 'stoneTools',
    homestead: 'homestead',
    starter_utility: 'starterUtility',
    iron_tools: 'ironTools',
    iron_utility: 'ironUtility',
    iron_armor: 'ironArmor',
    shelter: 'shelter',
    diamond_tools: 'diamondTools',
    diamond_armor: 'diamondArmor',
    advanced_utility: 'advancedUtility',
};
const MILESTONE_DEFINITIONS = Object.freeze({
    stoneTools: {
        stage: 'bootstrap',
        label: 'osnovno kamnito orodje',
        requires: [],
        targets: ['stone', 'iron', 'diamond'],
        utility: 100,
    },
    homestead: {
        stage: 'homestead',
        label: 'urejanje baze',
        requires: ['stoneTools'],
        targets: ['stone', 'iron', 'diamond'],
        utility: 72,
    },
    starterUtility: {
        stage: 'starter_utility',
        label: 'bakle za varno raziskovanje',
        requires: ['stoneTools'],
        targets: ['stone', 'iron', 'diamond'],
        utility: 66,
    },
    ironTools: {
        stage: 'iron_tools',
        label: 'železno orodje in ščit',
        requires: ['stoneTools'],
        targets: ['iron', 'diamond'],
        utility: 70,
    },
    ironUtility: {
        stage: 'iron_utility',
        label: 'vedro za vodo, farme in varnost',
        requires: ['ironTools'],
        targets: ['iron', 'diamond'],
        utility: 52,
    },
    ironArmor: {
        stage: 'iron_armor',
        label: 'poln železni oklep',
        requires: ['ironTools'],
        targets: ['iron', 'diamond'],
        utility: 50,
    },
    shelter: {
        stage: 'shelter',
        label: 'gradnja prvega doma',
        requires: ['homestead'],
        targets: ['stone', 'iron', 'diamond'],
        utility: 42,
    },
    diamondTools: {
        stage: 'diamond_tools',
        label: 'diamantno orodje',
        requires: ['ironTools'],
        targets: ['diamond'],
        utility: 48,
    },
    diamondArmor: {
        stage: 'diamond_armor',
        label: 'poln diamantni oklep',
        requires: ['ironTools'],
        targets: ['diamond'],
        utility: 36,
    },
    advancedUtility: {
        stage: 'advanced_utility',
        label: 'enchanting setup in napredni utility bloki',
        requires: ['diamondTools', 'homestead'],
        targets: ['diamond'],
        utility: 30,
    },
});
const MILESTONE_ACTION_NAMES = Object.freeze({
    stoneTools: 'progress:stone',
    homestead: 'progress:base',
    starterUtility: 'progress:starterUtility',
    ironTools: 'progress:ironTools',
    ironUtility: 'progress:ironUtility',
    ironArmor: 'progress:ironArmor',
    shelter: 'progress:shelter',
    diamondTools: 'progress:diamondTools',
    diamondArmor: 'progress:diamondArmor',
    advancedUtility: 'progress:advancedUtility',
});

const cache = new WeakMap();
const utilityCache = new WeakMap();
const advancedUtilityCache = new WeakMap();

function stateFile(bot) {
    return `./bots/${bot.username}/progression.json`;
}

function loadState(bot) {
    if (cache.has(bot)) return cache.get(bot);
    let state = { shelterComplete: false, milestones: {}, work: {}, lastStage: null, updatedAt: null };
    let hadMilestones = false;
    try {
        if (existsSync(stateFile(bot))) {
            const stored = JSON.parse(readFileSync(stateFile(bot), 'utf8'));
            hadMilestones = Object.prototype.hasOwnProperty.call(stored, 'milestones');
            state = { ...state, ...stored };
        }
    } catch { /* use defaults */ }
    state.milestones = state.milestones && typeof state.milestones === 'object'
        ? { ...state.milestones }
        : {};
    state.work = state.work && typeof state.work === 'object' ? { ...state.work } : {};

    // Migration for progression files written before milestones existed. lastStage
    // described the next unfinished stage, so every earlier stage was completed at
    // least once even if the bot later spent/lost the corresponding inventory item.
    const previousIndex = STAGE_ORDER.indexOf(state.lastStage);
    if (!hadMilestones && previousIndex > 0) {
        for (const stage of STAGE_ORDER.slice(0, previousIndex)) {
            const milestone = STAGE_MILESTONE[stage];
            if (milestone) state.milestones[milestone] = true;
        }
    }
    if (state.shelterComplete) state.milestones.shelter = true;
    cache.set(bot, state);
    return state;
}

function saveState(bot, patch) {
    const state = { ...loadState(bot), ...patch, updatedAt: new Date().toISOString() };
    cache.set(bot, state);
    const file = stateFile(bot);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2));
    return state;
}

function recordMilestoneWork(bot, milestone, outcome) {
    const state = loadState(bot);
    const previous = state.work?.[milestone] ?? {};
    const kind = outcome?.kind ?? 'failed';
    const progressed = kind === 'done' || kind === 'progress';
    const work = {
        ...(state.work ?? {}),
        [milestone]: {
            status: kind,
            attempts: Number(previous.attempts ?? 0) + 1,
            consecutiveFailures: kind === 'failed'
                ? Number(previous.consecutiveFailures ?? 0) + 1
                : 0,
            consecutiveBlocks: kind === 'blocked'
                ? Number(previous.consecutiveBlocks ?? 0) + 1
                : 0,
            blocker: outcome?.blocker ?? null,
            retryAt: Number(outcome?.retryAt ?? 0) || null,
            lastProgressAt: progressed ? Date.now() : previous.lastProgressAt ?? null,
            updatedAt: Date.now(),
        },
    };
    saveState(bot, { work });
}

export function normalizeMilestoneAttemptOutcome(key, raw, {
    completed = false,
    pending = null,
    interrupted = false,
} = {}) {
    if (raw?.kind) return raw;
    if (completed) return actionOutcome('done', { milestone: key });
    if (raw === true) {
        return actionOutcome('progress', {
            milestone: key,
            message: `made partial progress toward ${key}`,
        });
    }
    if (pending) return pending;
    if (interrupted) {
        return actionOutcome('interrupted', {
            milestone: key,
            message: `${key} was interrupted before its prerequisites could be re-evaluated`,
        });
    }
    return actionOutcome('failed', {
        milestone: key,
        message: `${key} made no observable prerequisite progress`,
    });
}

function count(bot, names) {
    const inv = world.getInventoryCounts(bot);
    return (Array.isArray(names) ? names : [names]).reduce((sum, name) => sum + (inv[name] ?? 0), 0);
}

function recordObservedMilestones(bot, state, observed) {
    const milestones = { ...(state.milestones ?? {}) };
    let changed = false;
    for (const [name, reached] of Object.entries(observed)) {
        if (!reached || milestones[name]) continue;
        milestones[name] = true;
        changed = true;
    }
    return changed ? saveState(bot, { milestones }) : state;
}

function equipmentKind(name) {
    if (name === 'shield') return 'shield';
    const tier = Object.keys(TIER_SCORE).find(candidate => name.startsWith(`${candidate}_`));
    return tier ? name.slice(tier.length + 1) : null;
}

function equipmentClass(name) {
    if (name === 'shield') return 'shield';
    return ['helmet', 'chestplate', 'leggings', 'boots', 'pickaxe', 'axe', 'sword', 'shovel', 'hoe']
        .find(kind => name.endsWith(`_${kind}`)) ?? null;
}

function equipmentScore(item) {
    if (!item) return 0;
    if (item.name === 'shield') return 250;
    const tier = TIER_SCORE[item.name.split('_')[0]] ?? 0;
    const enchants = (item.enchants ?? [])
        .reduce((sum, enchantment) => sum + Number(enchantment.lvl ?? 1), 0);
    const durability = item.maxDurability
        ? Math.max(0, 1 - (item.durabilityUsed ?? 0) / item.maxDurability)
        : 1;
    return tier * 100 + enchants * 2 + durability;
}

function satisfiesEquipment(bot, desired) {
    if (desired === 'shield') return count(bot, 'shield') > 0;
    const kind = equipmentKind(desired);
    const desiredTier = desired.split('_')[0];
    if (!kind || !TIER_SCORE[desiredTier]) return count(bot, desired) > 0;
    return bot.inventory.slots.some(item => item
        && item.name.endsWith(`_${kind}`)
        && (TIER_SCORE[item.name.split('_')[0]] ?? 0) >= TIER_SCORE[desiredTier]);
}

async function takeSharedUpgrade(bot, desired) {
    if (!storage.getPublicStorage(bot) || satisfiesEquipment(bot, desired)) return false;
    const kind = equipmentKind(desired);
    const desiredTier = desired.split('_')[0];
    const selected = await storage.takeOnePublicMatching(
        bot,
        item => {
            if (desired === 'shield') return item.name === 'shield';
            return kind && item.name.endsWith(`_${kind}`)
                && (TIER_SCORE[item.name.split('_')[0]] ?? 0) >= (TIER_SCORE[desiredTier] ?? 0);
        },
        item => {
            const tier = TIER_SCORE[item.name.split('_')[0]] ?? 0;
            const enchants = (item.enchants ?? [])
                .reduce((sum, enchantment) => sum + Number(enchantment.lvl ?? 1), 0);
            const durability = item.maxDurability
                ? Math.max(0, 1 - (item.durabilityUsed ?? 0) / item.maxDurability)
                : 1;
            return tier * 100 + enchants * 2 + durability;
        },
    );
    return Boolean(selected);
}

export async function claimSharedEquipment(bot) {
    if (!storage.getPublicStorage(bot)) return false;
    const bestOwned = {};
    for (const item of bot.inventory.slots) {
        if (!item) continue;
        const itemClass = equipmentClass(item.name);
        if (!itemClass) continue;
        bestOwned[itemClass] = Math.max(bestOwned[itemClass] ?? 0, equipmentScore(item));
    }

    const selected = await storage.takeOnePublicMatching(
        bot,
        item => {
            const itemClass = equipmentClass(item.name);
            return itemClass && equipmentScore(item) > (bestOwned[itemClass] ?? 0) + 0.05;
        },
        item => {
            const itemClass = equipmentClass(item.name);
            const improvement = equipmentScore(item) - (bestOwned[itemClass] ?? 0);
            const priority = ['chestplate', 'leggings', 'helmet', 'boots'].includes(itemClass)
                ? 1000
                : itemClass === 'shield' ? 800 : 500;
            return priority + improvement;
        },
    );
    if (!selected) return false;
    try { await bot.armorManager.equipAll(); } catch { /* optional plugin */ }
    if (selected.name === 'shield') {
        try { await equip(bot, 'shield'); } catch { /* keep it for combat */ }
    }
    log(bot, `Iz javnega storagea sem vzel boljso opremo: ${selected.name}.`);
    return true;
}

function baseReady(bot) {
    // Owner-set home or the bot's own personal camp — a home-less bot sets up its
    // camp during 'homestead' (setupBase claims one) and then progresses normally.
    const home = base.getPersonalAnchor(bot);
    if (!home) return false;

    const cached = utilityCache.get(bot);
    if (cached && cached.homeX === home.x && cached.homeY === home.y && cached.homeZ === home.z
        && Date.now() - cached.checkedAt < 5000) {
        return cached.ready;
    }

    const names = ['crafting_table', 'chest', 'furnace'];
    const ids = mc.registryBlockIds(bot, names);
    const found = bot.findBlocks({
        point: new Vec3(home.x, home.y, home.z),
        matching: ids,
        maxDistance: 18,
        count: 16,
    });
    const foundNames = new Set(found.map(position => bot.blockAt(position)?.name));
    // blockMatchesName keeps the fallback safe for legacy burning-furnace registries.
    const ready = names.every(name =>
        [...foundNames].some(foundName => foundName && mc.blockMatchesName(foundName, name, bot)));
    utilityCache.set(bot, {
        homeX: home.x,
        homeY: home.y,
        homeZ: home.z,
        checkedAt: Date.now(),
        ready,
    });
    return ready;
}

function starterUtilityReady(bot) {
    return count(bot, 'torch') >= 8;
}

function ironUtilityReady(bot) {
    return count(bot, ['bucket', 'water_bucket', 'lava_bucket']) > 0;
}

function utilityAnchor(bot) {
    return storage.getPublicStorage(bot) ?? base.getPersonalAnchor(bot);
}

function placedUtilityCount(bot, names, radius = 24) {
    const anchor = utilityAnchor(bot);
    if (!anchor) return 0;
    const list = Array.isArray(names) ? names : [names];
    const ids = mc.registryBlockIds(bot, list);
    if (ids.length === 0) return 0;
    return bot.findBlocks({
        point: new Vec3(anchor.x, anchor.y, anchor.z),
        matching: ids,
        maxDistance: radius,
        count: 64,
    }).filter(position => {
        const block = bot.blockAt(position);
        return block && mc.blockMatchesAnyName(block, list, bot);
    }).length;
}

function advancedUtilityCounts(bot, force = false) {
    const anchor = utilityAnchor(bot);
    if (!anchor) return {};
    const cached = advancedUtilityCache.get(bot);
    if (!force && cached
        && cached.x === anchor.x && cached.y === anchor.y && cached.z === anchor.z
        && Date.now() - cached.checkedAt < 5000) return cached.counts;
    const counts = Object.fromEntries(ADVANCED_UTILITY_BLOCKS.map(spec => [
        spec.item,
        placedUtilityCount(bot, spec.names ?? [spec.item]),
    ]));
    advancedUtilityCache.set(bot, {
        x: anchor.x, y: anchor.y, z: anchor.z, checkedAt: Date.now(), counts,
    });
    return counts;
}

function advancedUtilityReady(bot, force = false) {
    const counts = advancedUtilityCounts(bot, force);
    return ADVANCED_UTILITY_BLOCKS.every(spec => (counts[spec.item] ?? 0) >= spec.desired);
}

function starterOrigin(home) {
    return new Vec3(home.x + 4, home.y, home.z - 2);
}

function milestoneAllowed(id, definition, target) {
    if (!definition.targets.includes(target)) return false;
    return id !== 'shelter' || settings.allow_building !== false;
}

export function validateMilestoneGraph(target = settings.progression_target ?? 'diamond') {
    const normalizedTarget = ['stone', 'iron', 'diamond'].includes(target) ? target : 'diamond';
    const enabled = new Set(Object.entries(MILESTONE_DEFINITIONS)
        .filter(([id, definition]) => milestoneAllowed(id, definition, normalizedTarget))
        .map(([id]) => id));
    const errors = [];
    for (const [id, definition] of Object.entries(MILESTONE_DEFINITIONS)) {
        if (!enabled.has(id)) continue;
        if (!Array.isArray(definition.requires)) errors.push(`${id}: requires must be an array`);
        if (!Number.isFinite(Number(definition.utility))) errors.push(`${id}: utility must be numeric`);
        if (!MILESTONE_ACTION_NAMES[id]) errors.push(`${id}: missing action name`);
        for (const required of definition.requires ?? []) {
            if (!MILESTONE_DEFINITIONS[required]) errors.push(`${id}: unknown prerequisite ${required}`);
            else if (!enabled.has(required)) errors.push(`${id}: disabled prerequisite ${required}`);
        }
    }

    const visiting = new Set();
    const visited = new Set();
    const order = [];
    const visit = (id, path = []) => {
        if (visiting.has(id)) {
            errors.push(`cycle: ${[...path, id].join(' -> ')}`);
            return;
        }
        if (visited.has(id) || !enabled.has(id)) return;
        visiting.add(id);
        for (const required of MILESTONE_DEFINITIONS[id]?.requires ?? []) visit(required, [...path, id]);
        visiting.delete(id);
        visited.add(id);
        order.push(id);
    };
    for (const id of enabled) visit(id);
    return { valid: errors.length === 0, errors, order };
}

function availableMilestones(milestones, target) {
    return Object.entries(MILESTONE_DEFINITIONS)
        .filter(([id, definition]) => milestoneAllowed(id, definition, target)
            && milestones[id] !== true
            && definition.requires.every(required => milestones[required] === true))
        .map(([id, definition]) => ({ id, ...definition }));
}

export function getMilestoneGraph(target = settings.progression_target ?? 'diamond') {
    const normalizedTarget = ['stone', 'iron', 'diamond'].includes(target) ? target : 'diamond';
    return Object.entries(MILESTONE_DEFINITIONS)
        .filter(([id, definition]) => milestoneAllowed(id, definition, normalizedTarget))
        .map(([id, definition]) => ({
            id,
            stage: definition.stage,
            label: definition.label,
            requires: [...definition.requires],
        }));
}

export function getStatus(bot) {
    const configuredTarget = settings.progression_target ?? 'diamond';
    const target = ['stone', 'iron', 'diamond'].includes(configuredTarget) ? configuredTarget : 'diamond';
    let state = loadState(bot);
    const inventory = world.getInventoryCounts(bot);
    const ownsAny = names => names.some(name => (inventory[name] ?? 0) > 0);
    const hasToolSet = tiers => ['pickaxe', 'axe', 'sword']
        .every(kind => ownsAny(tiers.map(tier => `${tier}_${kind}`)));
    const hasArmorSet = tiers => ['helmet', 'chestplate', 'leggings', 'boots']
        .every(slot => ownsAny(tiers.map(tier => `${tier}_${slot}`)));
    const stoneTools = hasToolSet(['stone', 'iron', 'diamond', 'netherite']);
    const ironTools = hasToolSet(['iron', 'diamond', 'netherite']) && ownsAny(['shield']);
    const diamondTools = hasToolSet(['diamond', 'netherite']);
    const ironArmor = hasArmorSet(['iron', 'diamond', 'netherite']);
    const diamondArmor = hasArmorSet(['diamond', 'netherite']);
    const milestones = state.milestones ?? {};
    const homesteadNow = milestones.homestead || baseReady(bot);
    const hasStarterUtilityNow = starterUtilityReady(bot);
    const hasIronUtilityNow = ironUtilityReady(bot);
    const hasAdvancedUtilityNow = (milestones.diamondTools || diamondTools)
        ? advancedUtilityReady(bot)
        : false;

    // Milestones are achievements, not a mirror of consumable inventory. Once a
    // player has made a stone kit, carried enough torches, or completed an armor
    // tier, spending/losing an item becomes a loadout-maintenance concern and must
    // not rewind the whole technology progression.
    state = recordObservedMilestones(bot, state, {
        stoneTools,
        homestead: homesteadNow,
        starterUtility: hasStarterUtilityNow,
        ironTools,
        ironUtility: hasIronUtilityNow,
        ironArmor,
        shelter: state.shelterComplete,
        diamondTools,
        diamondArmor,
        advancedUtility: hasAdvancedUtilityNow,
    });
    const done = name => state.milestones?.[name] === true;
    const openMilestones = availableMilestones(state.milestones ?? {}, target);
    // `stage` remains as a backward-compatible recommendation for status displays
    // and old consumers. Execution no longer follows it as a mandatory sequence:
    // actionCandidates() publishes every currently-unlocked branch to the arbiter.
    const recommended = openMilestones[0] ?? null;
    const stage = recommended?.stage ?? (target === 'diamond' ? 'late_game' : 'established');
    const label = recommended?.label
        ?? (target === 'diamond' ? 'late-game diamantna oprema' : `razvit ${target} igralec`);

    return {
        stage,
        label,
        target,
        shelterComplete: done('shelter'),
        starterUtility: done('starterUtility'),
        ironUtility: done('ironUtility'),
        advancedUtility: done('advancedUtility'),
        ironArmor: ARMOR.iron.filter(([name]) => (inventory[name] ?? 0) > 0).length,
        diamondArmor: ARMOR.diamond.filter(([name]) => (inventory[name] ?? 0) > 0).length,
        milestones: { ...(state.milestones ?? {}) },
        completedMilestones: Object.keys(MILESTONE_DEFINITIONS)
            .filter(id => state.milestones?.[id] === true),
        availableMilestones: openMilestones.map(milestone => ({
            id: milestone.id,
            stage: milestone.stage,
            label: milestone.label,
            requires: [...milestone.requires],
        })),
        readiness: {
            stoneTools,
            homestead: homesteadNow,
            starterUtility: hasStarterUtilityNow,
            ironTools,
            ironUtility: hasIronUtilityNow,
            ironArmor,
            diamondTools,
            diamondArmor,
            advancedUtility: hasAdvancedUtilityNow,
        },
        work: { ...(state.work ?? {}) },
    };
}

async function requestMining(agent, resource, amount) {
    if (settings.progression_allow_digging === false) {
        agent._progressionPendingOutcome = actionOutcome('blocked', {
            blocker: resource,
            message: `automatic ${resource} mining is disabled`,
            retryAt: Date.now() + 5 * 60_000,
        });
        return false;
    }
    // Dynamic import avoids a progression -> mining -> society -> progression
    // initialization cycle while still routing every autonomous ore request through
    // the one shared expedition state machine.
    const mining = await import('./mining.js');
    const request = await mining.requestResourceExpedition(agent, resource, amount);
    if (request.active) {
        log(agent.bot, `Za progression potrebujemo ${amount}x ${resource}; odprta je skupinska odprava.`);
        agent._progressionPendingOutcome = actionOutcome('waiting', {
            blocker: resource,
            message: `waiting for the shared ${resource} expedition (${amount} requested)`,
            retryAt: Date.now() + 30_000,
        });
    } else {
        agent._progressionPendingOutcome = actionOutcome('blocked', {
            blocker: resource,
            message: `a ${resource} expedition cannot start yet`,
            retryAt: Date.now() + 60_000,
        });
    }
    return request.active;
}

async function ensureIron(agent, amount) {
    const bot = agent.bot;
    await base.takeNeeded(bot, { iron_ingot: amount });
    if (count(bot, 'iron_ingot') >= amount) return true;

    const rawTarget = Math.max(1, amount - count(bot, 'iron_ingot'));
    await base.takeNeeded(bot, { raw_iron: rawTarget });
    if (count(bot, 'raw_iron') > 0) {
        await base.takeAny(bot, ['coal', 'charcoal'], Math.ceil(count(bot, 'raw_iron') / 8));
        if (count(bot, ['coal', 'charcoal']) === 0) await ensureLogs(bot, 4);
        await smeltItem(bot, 'raw_iron', count(bot, 'raw_iron'));
    }
    if (count(bot, 'iron_ingot') >= amount) return true;
    await requestMining(agent, 'iron', amount - count(bot, 'iron_ingot'));
    return false;
}

async function ensureDiamonds(agent, amount) {
    const bot = agent.bot;
    await base.takeNeeded(bot, { diamond: amount });
    if (count(bot, 'diamond') >= amount) return true;
    await requestMining(agent, 'diamond', amount - count(bot, 'diamond'));
    return false;
}

async function ensureCraftWood(bot, plankCount) {
    await base.takeAny(bot, PLANKS, plankCount);
    const plankDeficit = Math.max(0, plankCount - count(bot, PLANKS));
    if (plankDeficit === 0) return true;

    const neededLogs = Math.ceil(plankDeficit / 4);
    await base.takeAny(bot, LOGS, neededLogs);
    if (count(bot, LOGS) < neededLogs) await ensureLogs(bot, neededLogs);
    return ensurePlanks(bot, plankCount);
}

async function craftMissing(agent, specs, material, ensureMaterial) {
    const bot = agent.bot;
    const missing = [];
    for (const spec of specs) {
        const [item] = spec;
        if (satisfiesEquipment(bot, item)) continue;
        if (await takeSharedUpgrade(bot, item)) continue;
        missing.push(spec);
    }
    if (missing.length === 0) return true;

    // Request the complete tier as one material batch, but use any partial stock
    // immediately. Waiting for all 24 armor ingots/diamonds made useful upgrades
    // sit idle through several expeditions even when a chestplate was affordable.
    const totalMaterial = missing.reduce((sum, [, cost]) => sum + cost, 0);
    if (count(bot, material) < totalMaterial)
        await ensureMaterial(agent, totalMaterial);

    let craftedAny = false;
    if (base.getPersonalAnchor(bot) && !await base.goPersonalAnchor(bot)) return false;
    for (const [item, cost] of missing) {
        if (bot.interrupt_code) return false;
        if (count(bot, material) < cost) continue;
        if (await craftRecipe(bot, item, 1)) craftedAny = true;
    }
    try { await bot.armorManager.equipAll(); } catch { /* optional plugin behavior */ }
    return craftedAny || specs.every(([item]) => satisfiesEquipment(bot, item));
}

async function progressStoneTools(bot) {
    const toolNames = ['stone_pickaxe', 'stone_axe', 'stone_sword'];
    const before = toolNames.filter(item => satisfiesEquipment(bot, item)).length;
    for (const item of ['stone_pickaxe', 'stone_axe', 'stone_sword']) {
        if (!satisfiesEquipment(bot, item))
            await takeSharedUpgrade(bot, item);
    }
    const complete = () => toolNames.every(item => satisfiesEquipment(bot, item));
    if (!complete()) await gearUp(bot);
    if (complete()) return actionOutcome('done', { milestone: 'stoneTools' });
    const after = toolNames.filter(item => satisfiesEquipment(bot, item)).length;
    if (after > before) {
        return actionOutcome('progress', {
            milestone: 'stoneTools',
            message: `obtained ${after - before} missing stone tool${after - before === 1 ? '' : 's'}`,
        });
    }
    return false;
}

async function progressIronTools(agent) {
    const bot = agent.bot;
    log(bot, 'Napredujem na železno opremo.');
    if (!await ensureCraftWood(bot, 16)) return false;
    const ok = await craftMissing(agent, TOOLS.iron, 'iron_ingot', ensureIron);
    if (count(bot, 'shield') > 0) {
        try { await equip(bot, 'shield'); } catch { /* shield is optional */ }
    }
    return ok;
}

async function progressStarterUtility(agent) {
    const bot = agent.bot;
    log(bot, 'Pripravljam osnovni survival kit: bakle za jame in noc.');
    if (base.getPersonalAnchor(bot))
        await base.takeNeeded(bot, { torch: STARTER_TORCH_TARGET });
    if (starterUtilityReady(bot)) return true;
    await base.takeAny(bot, ['coal', 'charcoal'], 4);
    await ensureCraftWood(bot, 4);
    await survival.makeTorches(
        bot,
        STARTER_TORCH_TARGET,
        false,
    );
    if (!starterUtilityReady(bot) && count(bot, ['coal', 'charcoal']) === 0)
        await requestMining(agent, 'coal', 2);
    return starterUtilityReady(bot);
}

async function progressIronUtility(agent) {
    const bot = agent.bot;
    log(bot, 'Delam vedro za vodo, farme in varnost pri lavi.');
    if (ironUtilityReady(bot)) return true;
    if (base.getPersonalAnchor(bot))
        await base.takeNeeded(bot, { bucket: 1, water_bucket: 1, iron_ingot: 3, raw_iron: 3 });
    if (ironUtilityReady(bot)) return true;
    if (!await ensureIron(agent, 3)) return false;
    if (base.getPersonalAnchor(bot) && !await base.goPersonalAnchor(bot)) return false;
    await craftRecipe(bot, 'bucket', 1);
    return ironUtilityReady(bot);
}

function progressIronArmor(agent) {
    const bot = agent.bot;
    log(bot, 'Izdelujem železni oklep.');
    return craftMissing(agent, ARMOR.iron, 'iron_ingot', ensureIron);
}

async function progressDiamondTools(agent) {
    const bot = agent.bot;
    log(bot, 'Iščem diamante za boljše orodje.');
    if (!await ensureCraftWood(bot, 8)) return false;
    return craftMissing(agent, TOOLS.diamond, 'diamond', ensureDiamonds);
}

function progressDiamondArmor(agent) {
    const bot = agent.bot;
    log(bot, 'Napredujem proti polnemu diamantnemu oklepu.');
    return craftMissing(agent, ARMOR.diamond, 'diamond', ensureDiamonds);
}

async function ensureUtilityBlock(bot, item, desired = 1, names = [item]) {
    if (placedUtilityCount(bot, names) >= desired) return true;
    if (storage.getPublicStorage(bot)) {
        await storage.takeNeededPublic(bot, { [item]: desired });
        return await storage.ensurePublicUtility(bot, item, desired, names);
    }

    if (base.getPersonalAnchor(bot) && !await base.goPersonalAnchor(bot)) return false;
    if (count(bot, item) < 1)
        await craftRecipe(bot, item, desired);
    if (count(bot, item) < 1) return false;
    const spot = world.getNearestFreeSpace(bot, 1, 8);
    if (!spot) return false;
    return await placeBlock(bot, item, spot.x, spot.y, spot.z);
}

async function progressAdvancedUtility(agent) {
    const bot = agent.bot;
    log(bot, 'Postavljam napredne utility bloke za enchantanje in popravila.');
    const beforeCounts = advancedUtilityCounts(bot, true);
    const before = Object.values(beforeCounts).reduce((sum, amount) => sum + amount, 0);
    for (const spec of ADVANCED_UTILITY_BLOCKS) {
        if (bot.interrupt_code) break;
        await ensureUtilityBlock(bot, spec.item, spec.desired, spec.names ?? [spec.item]);
    }
    const afterCounts = advancedUtilityCounts(bot, true);
    const after = Object.values(afterCounts).reduce((sum, amount) => sum + amount, 0);
    return advancedUtilityReady(bot) || after > before;
}

async function buildStarterShelter(bot) {
    if (settings.allow_building === false) return true;
    const home = base.getPersonalAnchor(bot);
    if (!home) return false;
    const origin = starterOrigin(home);
    const before = await build.inspectSchematic(bot, 'koca', origin);
    if (before.ratio >= 0.9) {
        saveState(bot, { shelterComplete: true });
        return true;
    }
    await build.prepareSchematic(bot, 'koca', origin);
    const result = await build.buildSchematicStep(bot, 'koca', origin, settings.build_step_blocks ?? 24);
    const after = await build.inspectSchematic(bot, 'koca', origin);
    if (after.ratio >= 0.9) saveState(bot, { shelterComplete: true });
    return after.ratio >= 0.9 || result.placed > 0;
}

function progressionAction(agent, key, cooldownMs, name, timeout, fn) {
    agent._progressionRuntime ??= {};
    if (Date.now() < (agent._progressionRuntime[key] ?? 0)) return null;
    return {
        name,
        timeout,
        fn: async () => {
            let success = false;
            agent._progressionPendingOutcome = null;
            const finish = outcome => {
                const persisted = agent.bot.interrupt_code === true
                    && !['done', 'progress'].includes(outcome?.kind)
                    ? actionOutcome('interrupted', {
                        milestone: key,
                        message: outcome?.message ?? `${key} was interrupted`,
                    })
                    : outcome;
                success = persisted?.kind === 'done' || persisted?.kind === 'progress';
                recordMilestoneWork(agent.bot, key, persisted);
                return persisted;
            };
            try {
                const raw = await fn();
                const status = getStatus(agent.bot);
                return finish(normalizeMilestoneAttemptOutcome(key, raw, {
                    completed: status.milestones?.[key] === true,
                    pending: agent._progressionPendingOutcome,
                    interrupted: agent.bot.interrupt_code === true,
                }));
            } catch (error) {
                recordMilestoneWork(agent.bot, key, actionOutcome(
                    agent.bot.interrupt_code === true ? 'interrupted' : 'failed', {
                    milestone: key,
                    message: error?.message ?? String(error),
                }));
                throw error;
            } finally {
                // Do not burn a multi-minute cooldown when an emergency mode cut a
                // long mining/crafting action short. Failed prerequisites retry at a
                // bounded pace; a completed milestone keeps its normal cooldown.
                const interrupted = agent.bot.interrupt_code === true;
                const delay = success
                    ? cooldownMs
                    : interrupted ? 3_000 : Math.min(cooldownMs, 15_000);
                agent._progressionRuntime[key] = Date.now() + delay;
            }
        },
    };
}

function announceMilestone(agent, milestone) {
    const state = loadState(agent.bot);
    if (state.lastStage === milestone.stage) return;
    saveState(agent.bot, { lastStage: milestone.stage });
    console.log(`[progress ${agent.name}] ${milestone.stage}: ${milestone.label}`);
}

function isNight(bot) {
    const time = Number(bot.time?.timeOfDay ?? 0);
    return time >= 12_542 && time <= 23_460;
}

function missingMaterial(bot, specs, material) {
    const required = specs.reduce((sum, [item, cost]) =>
        sum + (satisfiesEquipment(bot, item) ? 0 : cost), 0);
    const availableNames = material === 'iron_ingot' ? ['iron_ingot', 'raw_iron'] : material;
    return Math.max(0, required - count(bot, availableNames));
}

function directUnlockValue(milestone, status) {
    const completed = status?.milestones ?? {};
    const unlockedChildren = Object.entries(MILESTONE_DEFINITIONS)
        .filter(([id, definition]) => milestoneAllowed(id, definition, status?.target ?? 'diamond')
            && completed[id] !== true
            && definition.requires.includes(milestone.id)
            && definition.requires.every(required => required === milestone.id || completed[required] === true))
        .length;
    return Math.min(30, unlockedChildren * 8);
}

function milestoneEstimatedCost(agent, milestone, status) {
    const bot = agent.bot;
    switch (milestone.id) {
        case 'stoneTools':
            return status?.readiness?.stoneTools ? 0 : 12;
        case 'homestead':
            return base.getPersonalAnchor(bot) ? 5 : 16;
        case 'starterUtility':
            return Math.min(18, Math.ceil(Math.max(0, 8 - count(bot, 'torch')) / 2));
        case 'ironTools':
            return Math.min(30, missingMaterial(bot, TOOLS.iron, 'iron_ingot') * 2);
        case 'ironUtility':
            return Math.min(12, Math.max(0, 3 - count(bot, 'iron_ingot')) * 2);
        case 'ironArmor':
            return Math.min(36, missingMaterial(bot, ARMOR.iron, 'iron_ingot') * 1.5);
        case 'shelter':
            return isNight(bot) ? 8 : 24;
        case 'diamondTools':
            return Math.min(36, missingMaterial(bot, TOOLS.diamond, 'diamond') * 4);
        case 'diamondArmor':
            return Math.min(48, missingMaterial(bot, ARMOR.diamond, 'diamond') * 2);
        case 'advancedUtility': {
            const counts = advancedUtilityCounts(bot);
            const placed = ADVANCED_UTILITY_BLOCKS.reduce((sum, spec) =>
                sum + Math.min(spec.desired, counts[spec.item] ?? 0), 0);
            const desired = ADVANCED_UTILITY_BLOCKS.reduce((sum, spec) => sum + spec.desired, 0);
            return Math.min(45, Math.max(0, desired - placed) * 6);
        }
        default:
            return 0;
    }
}

export function estimateMilestone(agent, milestoneId, knownStatus = null) {
    const definition = MILESTONE_DEFINITIONS[milestoneId];
    if (!definition) return null;
    const status = knownStatus ?? getStatus(agent.bot);
    const milestone = { ...definition, id: milestoneId };
    const work = status.work?.[milestoneId] ?? {};
    const historyAge = Math.max(0, Date.now() - Number(work.updatedAt ?? Date.now()));
    const historyDecay = Math.max(0, 1 - historyAge / (10 * 60_000));
    const historyPenalty = Math.round(Math.min(30,
        Number(work.consecutiveFailures ?? 0) * 8
        + Number(work.consecutiveBlocks ?? 0) * 10) * historyDecay);
    const pathCost = Math.round(milestoneEstimatedCost(agent, milestone, status));
    return {
        estimatedCost: Math.min(100, pathCost + historyPenalty),
        pathCost,
        historyPenalty,
        unlockValue: directUnlockValue(milestone, status),
    };
}

function milestoneUtility(agent, milestone, status) {
    const bot = agent.bot;
    const inventoryPressure = Number(bot.inventory?.emptySlotCount?.() ?? 36) <= 6;
    const planResource = agent._plan?.resource;
    let utility = milestone.utility;
    let reason = 'unlocked static milestone';
    switch (milestone.id) {
        case 'stoneTools':
            reason = 'core tools unlock every other branch';
            break;
        case 'homestead':
            if (!base.getPersonalAnchor(bot)) utility += 22;
            if (inventoryPressure) utility += 12;
            reason = 'storage and crafting base are missing or useful now';
            break;
        case 'starterUtility': {
            const torches = count(bot, 'torch');
            utility += torches === 0 ? 28 : torches < 4 ? 18 : 5;
            if (isNight(bot) || bot._miningExpeditionActive) utility += 12;
            reason = `torch reserve is ${torches}`;
            break;
        }
        case 'ironTools': {
            const iron = count(bot, ['iron_ingot', 'raw_iron']);
            utility += Math.min(18, iron * 2);
            if (planResource === 'iron') utility += 10;
            reason = `iron tools unlock safer and deeper gathering; iron=${iron}`;
            break;
        }
        case 'ironUtility':
            if (bot._miningExpeditionActive) utility += 14;
            reason = 'a bucket improves lava, farm and expedition safety';
            break;
        case 'ironArmor':
            if (Number(bot.health ?? 20) < 18) utility += 14;
            if (bot._miningExpeditionActive) utility += 10;
            utility += Math.min(16, count(bot, ['iron_ingot', 'raw_iron']));
            reason = 'armor value rises with danger and available iron';
            break;
        case 'shelter':
            if (isNight(bot)) utility += 24;
            if (inventoryPressure) utility += 8;
            reason = isNight(bot) ? 'night makes shelter urgent' : 'permanent home branch is open';
            break;
        case 'diamondTools': {
            const diamonds = count(bot, 'diamond');
            utility += Math.min(24, diamonds * 4);
            if (planResource === 'diamond') utility += 12;
            reason = `diamond tool branch; diamonds=${diamonds}`;
            break;
        }
        case 'diamondArmor': {
            const diamonds = count(bot, 'diamond');
            utility += Math.min(30, diamonds * 1.5);
            if (Number(bot.health ?? 20) < 16) utility += 10;
            reason = `diamond defense branch; diamonds=${diamonds}`;
            break;
        }
        case 'advancedUtility':
            utility += Math.min(18, Number(bot.experience?.level ?? 0));
            reason = 'enchanting branch scales with available experience';
            break;
        default:
            break;
    }
    const estimate = estimateMilestone(agent, milestone.id, status);
    return {
        utility: Math.min(100, utility),
        estimatedCost: estimate?.estimatedCost ?? 0,
        unlockValue: estimate?.unlockValue ?? 0,
        reason: `${reason}; remaining-cost=${estimate?.estimatedCost ?? 0}, unlock=${estimate?.unlockValue ?? 0}`,
    };
}

function actionForMilestone(agent, milestone) {
    const bot = agent.bot;
    let action = null;
    switch (milestone.id) {
        case 'stoneTools':
            action = progressionAction(agent, 'stoneTools', 30_000,
                'progress:stone', 4, () => progressStoneTools(bot));
            break;
        case 'homestead':
            action = progressionAction(agent, 'homestead', 45_000,
                'progress:base', 3, () => base.setupBase(bot));
            break;
        case 'starterUtility':
            action = progressionAction(agent, 'starterUtility', 45_000,
                'progress:starterUtility', 4, () => progressStarterUtility(agent));
            break;
        case 'ironTools':
            action = progressionAction(agent, 'ironTools', 45_000,
                'progress:ironTools', 5, () => progressIronTools(agent));
            break;
        case 'ironUtility':
            action = progressionAction(agent, 'ironUtility', 60_000,
                'progress:ironUtility', 4, () => progressIronUtility(agent));
            break;
        case 'shelter':
            action = progressionAction(agent, 'shelter', 45_000,
                'progress:shelter', 8, () => buildStarterShelter(bot));
            break;
        case 'ironArmor':
            action = progressionAction(agent, 'ironArmor', 75_000,
                'progress:ironArmor', 6, () => progressIronArmor(agent));
            break;
        case 'diamondTools':
            action = progressionAction(agent, 'diamondTools', 4 * 60_000,
                'progress:diamondTools', 8, () => progressDiamondTools(agent));
            break;
        case 'diamondArmor':
            action = progressionAction(agent, 'diamondArmor', 5 * 60_000,
                'progress:diamondArmor', 10, () => progressDiamondArmor(agent));
            break;
        case 'advancedUtility':
            action = progressionAction(agent, 'advancedUtility', 6 * 60_000,
                'progress:advancedUtility', 8, () => progressAdvancedUtility(agent));
            break;
        default:
            break;
    }
    if (action) {
        action.milestone = milestone.id;
        announceMilestone(agent, milestone);
    }
    return action;
}

// Publish every unlocked milestone branch. The brain's decision graph weighs these
// alongside environment, AI and society goals instead of obeying one fixed stage.
export function actionCandidates(agent, knownStatus = null) {
    const status = knownStatus ?? getStatus(agent.bot);
    return (status.availableMilestones ?? []).map(open => {
        const definition = { ...MILESTONE_DEFINITIONS[open.id], id: open.id };
        const scored = milestoneUtility(agent, definition, status);
        return {
            key: `milestone:${open.id}`,
            source: 'milestone',
            actionName: MILESTONE_ACTION_NAMES[open.id],
            utility: scored.utility,
            estimatedCost: scored.estimatedCost,
            unlockValue: scored.unlockValue,
            reason: scored.reason,
            commitmentBonus: 14,
            // Static priorities alone can starve behind recurring AI/society work.
            // A bounded five-minute aging curve guarantees service without allowing
            // milestones to outrank the hard safety/player-command layers.
            aging: { afterMs: 30_000, fullAtMs: 5 * 60_000, maxBonus: 120 },
            createAction: () => actionForMilestone(agent, definition),
        };
    });
}

// Backward-compatible entry point for !advance and direct callers. It uses the same
// open DAG branches, choosing their current utility winner without other goal sources.
export function nextAction(agent, knownStatus = null) {
    const candidates = actionCandidates(agent, knownStatus)
        .sort((a, b) => b.utility - a.utility || a.key.localeCompare(b.key));
    for (const candidate of candidates) {
        const action = candidate.createAction();
        if (action) return action;
    }
    return null;
}

export async function runProgression(agent) {
    const action = nextAction(agent);
    if (!action) return false;
    const result = await action.fn();
    return result?.kind === 'done' || result?.kind === 'progress' || result === true;
}
