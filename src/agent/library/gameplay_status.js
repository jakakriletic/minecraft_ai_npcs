// Central gameplay readiness snapshot. This is intentionally read-only: player
// commands, AI planning, dashboards and future decision trees can ask "what can
// this NPC safely do next?" without mutating the world.
import { existsSync, readFileSync } from 'fs';
import settings from '../../../settings.js';
import * as base from './base.js';
import * as farm from './farm.js';
import * as progression from './progression.js';
import * as roads from './roads.js';
import * as society from './society.js';
import * as storage from './storage.js';
import * as survival from './survival.js';
import * as tidy from './tidy.js';
import * as town from './town.js';
import * as world from './world.js';
import { getAllLoadoutStatuses } from './loadout.js';
import { getHomeLifeStatus } from './home_life.js';
import { getPlayerHelperStatus } from './player_helper.js';

const MINING_FILE = './bots/mining-expedition.json';

const FOOD = [
    'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    'baked_potato', 'apple', 'carrot', 'golden_carrot', 'cooked_cod',
    'cooked_salmon', 'cooked_fish', 'cooked_rabbit', 'fish',
];
const AMMO = ['arrow', 'spectral_arrow', 'tipped_arrow'];
const BLOCKS = [
    'cobblestone', 'stone', 'dirt', 'planks', 'oak_planks', 'spruce_planks',
    'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks',
];
const SEEDS = ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds'];
const TOOL_KINDS = ['pickaxe', 'axe', 'sword', 'shovel', 'hoe'];
const ARMOR_SLOTS = [
    ['helmet', 5],
    ['chestplate', 6],
    ['leggings', 7],
    ['boots', 8],
];
const TIER_SCORE = {
    wooden: 1,
    golden: 1.5,
    stone: 2,
    iron: 3,
    diamond: 4,
    netherite: 5,
};

function safe(fn, fallback = null) {
    try {
        const value = fn();
        return value === undefined ? fallback : value;
    } catch {
        return fallback;
    }
}

function invCount(counts, names) {
    return (Array.isArray(names) ? names : [names])
        .reduce((sum, name) => sum + (counts[name] ?? 0), 0);
}

function itemTier(name) {
    return Object.keys(TIER_SCORE).find(tier => name?.startsWith(`${tier}_`)) ?? null;
}

function itemScore(item) {
    if (!item) return 0;
    const tier = itemTier(item.name);
    const baseScore = TIER_SCORE[tier] ?? 0;
    const durability = item.maxDurability
        ? Math.max(0, 1 - (item.durabilityUsed ?? 0) / item.maxDurability)
        : 1;
    return baseScore * 100 + durability;
}

function bestTool(items, kind) {
    const best = items
        .filter(item => item.name.endsWith(`_${kind}`))
        .sort((a, b) => itemScore(b) - itemScore(a))[0];
    if (!best) return { name: null, tier: null, score: 0 };
    return { name: best.name, tier: itemTier(best.name), score: itemScore(best) };
}

function equipmentSlot(bot, destination) {
    if (typeof bot.getEquipmentDestSlot !== 'function') return null;
    return bot.inventory.slots[bot.getEquipmentDestSlot(destination)] ?? null;
}

function hasInventoryOrEquipped(bot, counts, name) {
    if ((counts[name] ?? 0) > 0) return true;
    if (name === 'shield') return equipmentSlot(bot, 'off-hand')?.name === 'shield';
    return false;
}

function formatPoint(point) {
    if (!point) return 'none';
    return `${Math.floor(point.x)},${Math.floor(point.y)},${Math.floor(point.z)}`;
}

function currentActivity(agent) {
    if (!agent.isIdle()) return agent.actions.currentActionLabel || 'Acting';
    if (agent.self_prompter?.isStopped?.()) return 'Stopped';
    if (agent.self_prompter?.isPaused?.()) return 'Paused';
    if (agent.self_prompter?.isActive?.()) return 'Thinking';
    return 'Idle';
}

function readMiningExpedition(agent) {
    if (!existsSync(MINING_FILE)) return null;
    return safe(() => {
        const exp = JSON.parse(readFileSync(MINING_FILE, 'utf8'));
        if (!exp?.active || !exp?.startedAt) return null;
        const started = Number.isFinite(Number(exp.startedAt))
            ? Number(exp.startedAt)
            : Date.parse(exp.startedAt);
        const stale = Number.isFinite(started) && Date.now() - started > 25 * 60_000;
        if (stale) return null;
        return {
            active: true,
            resource: exp.resource ?? 'iron',
            phase: exp.phase ?? 'unknown',
            leader: exp.leader ?? null,
            members: exp.members ?? [],
            mineMember: (exp.members ?? []).includes(agent.name),
            abort: exp.abort === true,
            targetY: exp.targetY ?? null,
            requestedAmount: Math.max(0, Number(exp.requestedAmount) || 0),
            progress: Object.values(exp.progress ?? {})
                .reduce((sum, amount) => sum + Math.max(0, Number(amount) || 0), 0),
        };
    }, null);
}

function progressionSuggestion(status) {
    const map = {
        bootstrap: '!gearUp or !advance',
        homestead: '!setupBase or !advance',
        starter_utility: '!makeTorches or !advance',
        iron_tools: '!getIron or !advance',
        iron_utility: '!advance',
        shelter: '!advance',
        iron_armor: '!advance',
        diamond_tools: '!advance',
        diamond_armor: '!advance',
        advanced_utility: '!advance',
    };
    return map[status.stage] ?? null;
}

function buildInventorySummary(bot) {
    const counts = world.getInventoryCounts(bot);
    const items = bot.inventory.items();
    const tools = Object.fromEntries(TOOL_KINDS.map(kind => [kind, bestTool(items, kind)]));
    const armor = Object.fromEntries(ARMOR_SLOTS.map(([name, slot]) => [
        name,
        bot.inventory.slots[slot]?.name ?? null,
    ]));
    const armorCount = Object.values(armor).filter(Boolean).length;

    return {
        counts,
        food: invCount(counts, FOOD),
        torches: counts.torch ?? 0,
        arrows: invCount(counts, AMMO),
        supportBlocks: invCount(counts, BLOCKS),
        seeds: invCount(counts, SEEDS),
        emptySlots: safe(() => bot.inventory.emptySlotCount(), 0),
        stackSlotsUsed: items.length,
        tools,
        armor,
        armorCount,
        hasShield: hasInventoryOrEquipped(bot, counts, 'shield'),
        hasBow: hasInventoryOrEquipped(bot, counts, 'bow'),
        hasBucket: invCount(counts, ['bucket', 'water_bucket', 'lava_bucket']) > 0,
    };
}

function buildSurvivalStatus(agent, inventory) {
    const bot = agent.bot;
    const pos = bot.entity?.position;
    const feet = safe(() => world.getBlockAtPosition(bot, 0, 0, 0)?.name, 'unknown');
    const head = safe(() => world.getBlockAtPosition(bot, 0, 1, 0)?.name, 'unknown');
    const below = safe(() => world.getBlockAtPosition(bot, 0, -1, 0)?.name, 'unknown');
    const blockers = [];
    const warnings = [];

    if (!pos) blockers.push('not spawned');
    if ((bot.health ?? 20) <= 8) blockers.push('critical health');
    else if (survival.needsHealing(bot)) warnings.push('needs healing');
    if ((bot.food ?? 20) <= 6) blockers.push('critical hunger');
    else if ((bot.food ?? 20) <= 12) warnings.push('low hunger');
    if (inventory.food <= 0) warnings.push('no carried food');
    if (['lava', 'flowing_lava'].includes(feet) || ['lava', 'flowing_lava'].includes(below))
        blockers.push('standing in lava');
    if (bot._miningRecoveryRequested) blockers.push('mining recovery requested');
    if (safe(() => survival.isOpenCaveTrap(bot), false)) blockers.push('open cave trap');
    if (safe(() => survival.isBelowSettlement(bot, 16), false)) warnings.push('below settlement');

    return {
        health: Math.round(bot.health ?? 0),
        hunger: Math.round(bot.food ?? 0),
        timeOfDay: bot.time?.timeOfDay ?? null,
        timeLabel: bot.time?.timeOfDay < 6000
            ? 'Morning'
            : bot.time?.timeOfDay < 12000 ? 'Afternoon' : 'Night',
        weather: bot.thunderState > 0 ? 'Thunderstorm' : bot.rainState > 0 ? 'Rain' : 'Clear',
        position: pos ? {
            x: Number(pos.x.toFixed(1)),
            y: Number(pos.y.toFixed(1)),
            z: Number(pos.z.toFixed(1)),
        } : null,
        dimension: bot.game?.dimension ?? 'unknown',
        biome: safe(() => world.getBiomeName(bot), 'unknown'),
        blocks: { below, feet, head },
        blockers,
        warnings,
        ok: blockers.length === 0,
    };
}

function buildVillageStatus(bot) {
    const home = safe(() => base.getBase(bot), null);
    const personalAnchor = safe(() => base.getPersonalAnchor(bot), null);
    const publicStorage = safe(() => storage.getPublicStorageAnchor(bot), null)
        ?? safe(() => storage.getPublicStorage(bot), null);
    const farmState = safe(() => farm.getFarm(bot), null);
    const townState = safe(() => town.townSummary(), null);
    const roadState = safe(() => roads.roadSummary(), null);
    const resourceNeed = safe(() => society.getResourceNeed(bot), null);

    return {
        home,
        personalAnchor,
        publicStorage,
        publicStorageMaintenance: safe(() => storage.publicStorageNeedsMaintenance(bot), false),
        needsPublicRestock: safe(() => base.needsPublicRestock(bot), false),
        shouldStash: safe(() => base.shouldVisitPublicStorage(bot), false),
        farm: farmState,
        town: townState,
        roads: roadState,
        cleanupSuggested: safe(() => tidy.settlementNeedsCleanup(bot), false),
        resourceNeed,
    };
}

function buildNextSteps(status) {
    const steps = [];
    const add = (command, reason, priority = 'normal') => {
        if (!steps.some(step => step.command === command)) steps.push({ command, reason, priority });
    };

    if (status.survival.blockers.length) {
        if (status.survival.blockers.some(b => b.includes('hunger') || b.includes('food')))
            add('!getFood', 'survival blocker: food', 'high');
        if (status.survival.blockers.some(b => b.includes('mining') || b.includes('cave') || b.includes('lava')))
            add('!goHome', 'recover from unsafe location', 'high');
    }
    if (!status.village.home && !status.village.personalAnchor)
        add('!setHome or !setupBase', 'no personal base/camp yet', 'high');
    if (!status.village.publicStorage)
        add('!storage <style>', 'no public town storage configured', 'normal');
    if (status.village.publicStorageMaintenance)
        add('!storage', 'public storage needs maintenance', 'normal');
    if (status.village.shouldStash)
        add('!stash', 'inventory has shareable or excess items', 'normal');
    if (status.village.needsPublicRestock && status.inventory.food < 3)
        add('!getFood', 'low carried food before work', 'normal');
    if (status.homeLife?.blockers?.includes('needs bed near home'))
        add('!setupHomeLife', 'home has no bed yet', 'normal');
    if (status.homeLife?.blockers?.includes('personal corner utilities incomplete'))
        add('!setupHomeLife', 'personal corner utilities incomplete', 'normal');
    if (status.homeLife && !status.homeLife.lighting.ok)
        add('!auditHomeLight', `${status.homeLife.lighting.dark} dark home spots`, 'normal');
    if (status.homeLife?.time?.isNight && status.homeLife?.hasBed)
        add('!sleepHome', 'night with a known home bed', 'normal');
    if (status.homeLife?.time?.isMorning)
        add('!morningPrep', 'morning routine', 'normal');
    if (!status.village.farm)
        add('!farm', 'no reserved farm yet', 'normal');
    if (status.village.cleanupSuggested)
        add('!cleanup', 'settlement has temporary debris', 'low');
    const progressionCommand = progressionSuggestion(status.progression);
    if (progressionCommand)
        add(progressionCommand, `progression stage: ${status.progression.stage}`, 'normal');
    if (status.village.resourceNeed && status.village.resourceNeed.ratio < 1)
        add('!advance or !mineOre', `shared resource need: ${status.village.resourceNeed.resource}`, 'normal');

    return steps;
}

export function getGameplayStatus(agent) {
    const bot = agent.bot;
    const inventory = buildInventorySummary(bot);
    const survivalStatus = buildSurvivalStatus(agent, inventory);
    const village = buildVillageStatus(bot);
    const progress = safe(() => progression.getStatus(bot), {
        stage: 'unknown',
        label: 'unknown',
        target: settings.progression_target ?? 'diamond',
    });
    const mining = readMiningExpedition(agent);

    const status = {
        agent: { name: agent.name, bot },
        name: agent.name,
        activity: {
            current: currentActivity(agent),
            idle: agent.isIdle(),
            action: agent.actions?.currentActionLabel ?? null,
            selfPrompting: agent.self_prompter?.isActive?.() ?? false,
        },
        survival: survivalStatus,
        inventory,
        village,
        homeLife: safe(() => getHomeLifeStatus(agent), null),
        playerHelper: safe(() => getPlayerHelperStatus(agent), null),
        progression: progress,
        mining,
        settings: {
            kingdomMode: settings.kingdom_mode !== false,
            buildingAllowed: settings.allow_building !== false,
            guardiansEnabled: settings.kingdom_guardians !== false,
            progressionTarget: settings.progression_target ?? 'diamond',
        },
    };

    status.profiles = getAllLoadoutStatuses(bot);
    status.openBlockers = [
        ...status.survival.blockers.map(reason => ({ type: 'survival', reason })),
        ...(!status.activity.idle ? [{ type: 'current_task', reason: status.activity.current }] : []),
        ...(!village.publicStorage ? [{ type: 'village', reason: 'no public storage' }] : []),
        ...(status.homeLife && !status.homeLife.ready ? [{ type: 'home_life', reason: status.homeLife.blockers.join(', ') || 'home needs work' }] : []),
        ...(inventory.emptySlots <= 2 ? [{ type: 'loadout', reason: 'inventory almost full' }] : []),
    ];
    status.readyForWork = status.activity.idle
        && status.survival.ok
        && Object.values(status.profiles).some(p => p.ready);
    status.nextSteps = buildNextSteps(status);

    delete status.agent.bot;
    return status;
}

function compactBlockers(list) {
    return list.length ? list.join(', ') : 'ok';
}

function compactProfile(profileStatus) {
    return profileStatus.ready
        ? `${profileStatus.name}: ready`
        : `${profileStatus.name}: blocked (${compactBlockers(profileStatus.blockers)})`;
}

export function formatGameplayStatus(agent) {
    const status = getGameplayStatus(agent);
    const inv = status.inventory;
    const village = status.village;
    const storageText = village.publicStorage
        ? `${formatPoint(village.publicStorage)}${village.publicStorageMaintenance ? ' (needs maintenance)' : ''}`
        : 'none';
    const farmText = village.farm ? formatPoint(village.farm) : 'none';
    const townText = village.town
        ? `${village.town.built}/${village.town.total} built, ${village.town.blocked} blocked`
        : 'none';
    const roadsText = village.roads
        ? `${village.roads.complete} done, ${village.roads.partial} partial, ${village.roads.blocked} blocked`
        : 'none';
    const homeLifeText = status.homeLife
        ? `${status.homeLife.ready ? 'ready' : 'needs work'}, bed=${status.homeLife.hasBed ? 'yes' : 'no'}, light=${status.homeLife.lighting.ok ? 'ok' : `${status.homeLife.lighting.dark} dark`}, time=${status.homeLife.time.label}`
        : 'unknown';
    const helperText = status.playerHelper
        ? `${status.playerHelper.ready ? 'ready' : 'needs work'}, players=${status.playerHelper.visiblePlayers.join(',') || 'none'}, blocks=${status.playerHelper.carriedBlocks}, food=${status.playerHelper.carriedFood}, builder=${status.playerHelper.builderReady ? 'ready' : 'blocked'}, escort=${status.playerHelper.escortReady ? 'ready' : 'blocked'}`
        : 'unknown';
    const next = status.nextSteps.length
        ? status.nextSteps.slice(0, 5).map(step => `${step.command} (${step.reason})`).join('; ')
        : 'none';

    return [
        `GAMEPLAY: ${status.readyForWork ? 'READY' : 'NEEDS WORK'} | ${status.name} | ${status.activity.current}`,
        `Survival: HP ${status.survival.health}/20, food ${status.survival.hunger}/20, ${status.survival.timeLabel}, ${status.survival.weather}, pos ${formatPoint(status.survival.position)} | blockers: ${compactBlockers(status.survival.blockers)}${status.survival.warnings.length ? ` | warnings: ${status.survival.warnings.join(', ')}` : ''}`,
        `Loadout: food ${inv.food}, torches ${inv.torches}, arrows ${inv.arrows}, blocks ${inv.supportBlocks}, empty slots ${inv.emptySlots} | tools pick=${inv.tools.pickaxe.name ?? 'none'}, axe=${inv.tools.axe.name ?? 'none'}, sword=${inv.tools.sword.name ?? 'none'} | armor ${inv.armorCount}/4, shield ${inv.hasShield ? 'yes' : 'no'}, bow ${inv.hasBow ? 'yes' : 'no'}`,
        `Village: home ${formatPoint(village.home)}, storage ${storageText}, farm ${farmText}, town ${townText}, roads ${roadsText}${village.cleanupSuggested ? ', cleanup suggested' : ''}`,
        `Home: ${homeLifeText}`,
        `Helper: ${helperText}`,
        `Progress: ${status.progression.stage} (${status.progression.label}) target=${status.progression.target}${status.mining?.active ? ` | mining ${status.mining.resource}/${status.mining.phase} crew=${status.mining.members.join(',')} requested=${status.mining.progress}/${status.mining.requestedAmount || 'scheduled'}` : ''}`,
        `Profiles: ${Object.values(status.profiles).map(compactProfile).join(' | ')}`,
        `Next: ${next}`,
    ].join('\n');
}
