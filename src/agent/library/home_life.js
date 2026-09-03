// Home-life routines: beds, sleep, morning prep, personal corner and lighting.
// This module intentionally builds on base/camp/storage instead of inventing a
// second "home" concept.
import { Vec3 } from 'vec3';
import * as base from './base.js';
import * as loadout from './loadout.js';
import * as storage from './storage.js';
import * as survival from './survival.js';
import * as world from './world.js';
import { isBedBlock } from '../../utils/mcdata.js';
import {
    craftRecipe,
    goToPosition,
    log,
    placeBlock,
} from './skills.js';

const BED_ITEMS = [
    'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed',
    'lime_bed', 'pink_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed',
    'purple_bed', 'blue_bed', 'brown_bed', 'green_bed', 'red_bed', 'black_bed',
    'bed',
];
const WOOL_ITEMS = [
    'white_wool', 'orange_wool', 'magenta_wool', 'light_blue_wool', 'yellow_wool',
    'lime_wool', 'pink_wool', 'gray_wool', 'light_gray_wool', 'cyan_wool',
    'purple_wool', 'blue_wool', 'brown_wool', 'green_wool', 'red_wool',
    'black_wool', 'wool',
];
const PLANK_ITEMS = [
    'planks', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
    'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks',
];
const LIGHT_BLOCKS = new Set([
    'torch', 'wall_torch', 'lantern', 'soul_lantern', 'glowstone',
    'sea_lantern', 'jack_o_lantern', 'redstone_lamp',
]);
const AIR_LIKE = new Set([
    'air', 'cave_air', 'void_air', 'short_grass', 'tallgrass', 'tall_grass',
    'fern', 'large_fern', 'snow', 'dead_bush',
]);
const UTILITY_GROUPS = {
    chest: ['chest', 'trapped_chest', 'barrel'],
    crafting: ['crafting_table'],
    furnace: ['furnace', 'blast_furnace', 'smoker'],
};
const HOME_LIGHT_RADIUS = 6;
const HOME_AUDIT_RADIUS = 5;
const HOME_SETUP_COOLDOWN_MS = 8 * 60_000;
const HOME_SLEEP_COOLDOWN_MS = 3 * 60_000;
const MORNING_PREP_COOLDOWN_MS = 90_000;
// How often the idle planner is allowed to run the full (findBlocks-heavy) home
// scan when no sleep/morning window is open. Keeps steady-state idle ticks cheap.
const HOME_SCAN_TTL_MS = 30_000;

function safe(fn, fallback = null) {
    try {
        const value = fn();
        return value === undefined ? fallback : value;
    } catch {
        return fallback;
    }
}

function point(anchor) {
    if (!anchor) return null;
    return new Vec3(Math.floor(anchor.x), Math.floor(anchor.y), Math.floor(anchor.z));
}

function blockAt(bot, pos) {
    return safe(() => bot.blockAt(pos, false), null);
}

function isAirLike(block) {
    return !block || AIR_LIKE.has(block.name);
}

function isSolid(block) {
    return block
        && !AIR_LIKE.has(block.name)
        && !['water', 'flowing_water', 'lava', 'flowing_lava'].includes(block.name)
        && Array.isArray(block.shapes)
        && block.shapes.length > 0;
}

function isBed(block) {
    return isBedBlock(block);
}

function isLight(block) {
    return LIGHT_BLOCKS.has(block?.name);
}

function nameMatches(block, names) {
    return names.includes(block?.name);
}

function positionSummary(pos) {
    if (!pos) return null;
    return {
        x: Math.floor(pos.x),
        y: Math.floor(pos.y),
        z: Math.floor(pos.z),
    };
}

function invCount(bot, names) {
    const counts = world.getInventoryCounts(bot);
    return (Array.isArray(names) ? names : [names])
        .reduce((sum, name) => sum + (counts[name] ?? 0), 0);
}

function findBlocks(bot, center, predicate, radius = 12, count = 32) {
    if (!bot?.entity || !center || typeof bot.findBlocks !== 'function') return [];
    return safe(() => bot.findBlocks({
        point: center,
        matching: predicate,
        maxDistance: radius,
        count,
    })
        .map(pos => blockAt(bot, pos))
        .filter(Boolean), []);
}

export function homeAnchor(bot) {
    const home = safe(() => base.getBase(bot), null);
    const personalAnchor = safe(() => base.getPersonalAnchor(bot), null);
    const publicStorage = safe(() => storage.getPublicStorageAnchor(bot), null)
        ?? safe(() => storage.getPublicStorage(bot), null);
    const anchor = personalAnchor ?? home ?? publicStorage ?? null;
    return {
        anchor,
        home,
        personalAnchor,
        publicStorage,
        type: home ? 'home' : personalAnchor ? 'camp' : publicStorage ? 'public_storage' : 'none',
        position: point(anchor),
    };
}

export function findHomeBed(bot, anchor = homeAnchor(bot).position, radius = 14) {
    const beds = findBlocks(bot, anchor, isBed, radius, 8);
    return beds[0] ?? null;
}

function findUtility(bot, anchor, names) {
    return findBlocks(bot, anchor, block => nameMatches(block, names), 10, 8)[0] ?? null;
}

function sampleStandableHomePoints(bot, anchor, radius = HOME_AUDIT_RADIUS) {
    const samples = [];
    if (!anchor) return samples;
    for (let dx = -radius; dx <= radius; dx += 2) {
        for (let dz = -radius; dz <= radius; dz += 2) {
            if (Math.hypot(dx, dz) > radius + 0.25) continue;
            const pos = anchor.offset(dx, 0, dz);
            const feet = blockAt(bot, pos);
            const head = blockAt(bot, pos.offset(0, 1, 0));
            const floor = blockAt(bot, pos.offset(0, -1, 0));
            if (feet === null && head === null && floor === null) continue;
            if (isAirLike(feet) && isAirLike(head) && isSolid(floor)) samples.push(pos);
        }
    }
    return samples;
}

export function auditHomeLighting(bot, anchor = homeAnchor(bot).position) {
    const samples = sampleStandableHomePoints(bot, anchor);
    const lights = findBlocks(bot, anchor, isLight, HOME_AUDIT_RADIUS + HOME_LIGHT_RADIUS, 64);
    const darkSpots = [];
    for (const sample of samples) {
        const covered = lights.some(light =>
            light.position && light.position.distanceTo(sample) <= HOME_LIGHT_RADIUS);
        if (!covered) darkSpots.push(positionSummary(sample));
    }
    return {
        checked: samples.length,
        lights: lights.length,
        dark: darkSpots.length,
        darkSpots: darkSpots.slice(0, 8),
        loaded: samples.length > 0,
        ok: samples.length === 0 || darkSpots.length === 0,
    };
}

export function timeOfDayStatus(bot) {
    const time = Number(bot?.time?.timeOfDay ?? 6000);
    const day = Number(bot?.time?.day ?? Math.floor(Number(bot?.time?.age ?? 0) / 24_000));
    const isNight = time >= 12_542 && time <= 23_458;
    const isMorning = time >= 0 && time < 3_000;
    return {
        time,
        day,
        label: isNight ? 'Night' : isMorning ? 'Morning' : time < 12_000 ? 'Day' : 'Evening',
        isNight,
        isMorning,
    };
}

export function getHomeLifeStatus(agentOrBot) {
    const bot = agentOrBot?.bot ?? agentOrBot;
    const anchorInfo = homeAnchor(bot);
    const bed = findHomeBed(bot, anchorInfo.position);
    const lighting = auditHomeLighting(bot, anchorInfo.position);
    const utilities = anchorInfo.position ? {
        chest: Boolean(findUtility(bot, anchorInfo.position, UTILITY_GROUPS.chest)),
        crafting: Boolean(findUtility(bot, anchorInfo.position, UTILITY_GROUPS.crafting)),
        furnace: Boolean(findUtility(bot, anchorInfo.position, UTILITY_GROUPS.furnace)),
    } : { chest: false, crafting: false, furnace: false };
    const utilitiesComplete = utilities.chest && utilities.crafting && utilities.furnace;
    const time = timeOfDayStatus(bot);
    const blockers = [];
    const warnings = [];

    if (!anchorInfo.anchor) blockers.push('needs home/camp anchor');
    if (!bed) blockers.push('needs bed near home');
    if (anchorInfo.anchor && !utilitiesComplete)
        blockers.push('personal corner utilities incomplete');
    if (!lighting.ok)
        warnings.push(`${lighting.dark} dark home spots`);
    if ((bot?.health ?? 20) < 14) warnings.push('low health before bed');
    if ((bot?.food ?? 20) < 10) warnings.push('low hunger before morning work');

    return {
        ready: blockers.length === 0 && lighting.ok && utilitiesComplete,
        anchorType: anchorInfo.type,
        anchor: anchorInfo.anchor,
        position: positionSummary(anchorInfo.position),
        hasBed: Boolean(bed),
        bed: bed ? positionSummary(bed.position) : null,
        utilities,
        lighting,
        time,
        inventory: {
            food: invCount(bot, loadout.FOOD),
            torches: invCount(bot, 'torch'),
            beds: invCount(bot, BED_ITEMS),
        },
        blockers,
        warnings,
    };
}

async function takeOrCraftBed(bot) {
    if (invCount(bot, BED_ITEMS) > 0) return true;
    await base.takeAny(bot, BED_ITEMS, 1);
    if (invCount(bot, BED_ITEMS) > 0) return true;
    await base.takeAny(bot, WOOL_ITEMS, 3);
    await base.takeAny(bot, PLANK_ITEMS, 3);
    for (const name of ['white_bed', 'bed']) {
        try {
            await craftRecipe(bot, name, 1);
            if (invCount(bot, BED_ITEMS) > 0) return true;
        } catch { /* try legacy/modern alternate */ }
    }
    return invCount(bot, BED_ITEMS) > 0;
}

async function placeBedAtHome(bot) {
    if (findHomeBed(bot)) return true;
    if (!await takeOrCraftBed(bot)) {
        log(bot, 'Nimam materiala za posteljo pri domu.');
        return false;
    }
    const spot = world.getNearestFreeSpace(bot, 2, 8);
    if (!spot) {
        log(bot, 'Ne najdem prostora za posteljo pri domu.');
        return false;
    }
    for (const bedName of BED_ITEMS) {
        if (invCount(bot, bedName) <= 0 && bot.game?.gameMode !== 'creative') continue;
        try {
            if (await placeBlock(bot, bedName, spot.x, spot.y, spot.z, 'bottom')) {
                log(bot, 'Postelja je pripravljena pri domu.');
                return true;
            }
        } catch { /* try the next bed item name */ }
    }
    return Boolean(findHomeBed(bot));
}

export async function lightHome(agentOrBot, options = {}) {
    const bot = agentOrBot?.bot ?? agentOrBot;
    const anchor = homeAnchor(bot).position;
    if (!anchor) return getHomeLifeStatus(bot);
    let audit = auditHomeLighting(bot, anchor);
    if (audit.ok) return getHomeLifeStatus(bot);

    const target = Math.min(Math.max(4, audit.dark), Number(options.maxTorches ?? 8));
    if (invCount(bot, 'torch') < Math.min(2, target)) {
        try { await base.takeNeeded(bot, { torch: target }); } catch { /* no stored torches */ }
    }
    if (invCount(bot, 'torch') < Math.min(2, target)) {
        try { await survival.makeTorches(bot, target, false); } catch { /* no coal */ }
    }

    let placed = 0;
    for (const spot of audit.darkSpots.slice(0, target)) {
        if (bot.interrupt_code || invCount(bot, 'torch') <= 0) break;
        try {
            if (await placeBlock(bot, 'torch', spot.x, spot.y, spot.z, 'bottom', true)) placed++;
        } catch { /* keep trying other dark spots */ }
    }
    audit = auditHomeLighting(bot, anchor);
    log(bot, placed > 0
        ? `Osvetlil dom (${placed} bakel).`
        : 'Doma nisem uspel dodati luči.');
    return getHomeLifeStatus(bot);
}

export async function setupHomeLife(agentOrBot) {
    const bot = agentOrBot?.bot ?? agentOrBot;
    await base.setupBase(bot);
    await placeBedAtHome(bot);
    await lightHome(bot);
    return getHomeLifeStatus(bot);
}

export async function morningPrep(agent, options = {}) {
    const bot = agent.bot;
    if (!base.getPersonalAnchor(bot) && options.claimHome !== false)
        await base.setupBase(bot);
    if ((bot.health ?? 20) < 16) {
        try { await survival.recoverHealth(bot, 18); } catch { /* no food yet */ }
    }
    if (base.needsPublicRestock(bot)) {
        try { await base.restockFromPublic(bot); } catch { /* public hub unreachable */ }
    }
    if (safe(() => bot.inventory.emptySlotCount(), 0) <= 4) {
        try { await base.stash(bot); } catch { /* chest unavailable */ }
    }
    try { await loadout.prepareForTask(agent, 'steward', { claimCamp: options.claimHome !== false }); } catch { /* best effort */ }
    const time = timeOfDayStatus(bot);
    bot._homeLifeLastMorningPrepDay = time.day;
    log(bot, 'Jutranja priprava koncana: hrana, prostor in osnovna oprema preverjeni.');
    return getHomeLifeStatus(agent);
}

export async function sleepAtHome(agent, options = {}) {
    const bot = agent.bot;
    if (options.setup !== false) await setupHomeLife(agent);
    const time = timeOfDayStatus(bot);
    if (!time.isNight && options.force !== true) {
        log(bot, 'Ni noc, spanje preskocim.');
        return getHomeLifeStatus(agent);
    }
    const bed = findHomeBed(bot);
    if (!bed) return getHomeLifeStatus(agent);

    try {
        await goToPosition(bot, bed.position.x, bed.position.y, bed.position.z, 2);
        await bot.sleep(bed);
        log(bot, 'Spim v svoji postelji.');
        try { bot.modes?.pause?.('unstuck'); } catch { /* optional mode */ }
        const deadline = Date.now() + Number(options.sleepTimeoutMs ?? 30_000);
        while (bot.isSleeping && Date.now() < deadline && !bot.interrupt_code)
            await new Promise(resolve => setTimeout(resolve, 500));
        log(bot, 'Zbudil sem se doma.');
        bot._homeLifeLastSleepDay = time.day;
    } catch (error) {
        log(bot, `Ne morem spati: ${error.message}`);
    } finally {
        // Night does not auto-advance while a human is online and awake, so the
        // sleep wait above usually hits its timeout with the bot STILL in bed.
        // Always wake explicitly (like liveness.js/npc.js do) or the bot stays
        // stuck in bed and every following action fails to move it.
        if (bot.isSleeping) { try { await bot.wake(); } catch { /* already awake */ } }
        try { bot.modes?.unpause?.('unstuck'); } catch { /* optional mode */ }
    }
    if (options.morningPrep !== false)
        return await morningPrep(agent, { claimHome: true });
    return getHomeLifeStatus(agent);
}

function cooldownReady(bot, key, ms) {
    bot._homeLifeCooldowns ??= {};
    return Date.now() >= (bot._homeLifeCooldowns[key] ?? 0) + ms;
}

function markCooldown(bot, key) {
    bot._homeLifeCooldowns ??= {};
    bot._homeLifeCooldowns[key] = Date.now();
}

function markOnActionStart(bot, key, action) {
    const previous = action.onStart;
    action.onStart = () => {
        markCooldown(bot, key);
        if (typeof previous === 'function') previous();
    };
    return action;
}

function pendingHomeLifeAction(bot, time) {
    const pending = bot._homeLifePendingAction;
    if (!pending?.action) return null;
    const expired = Date.now() >= Number(pending.expiresAt ?? 0);
    const wrongWindow = (pending.window === 'night' && !time.isNight)
        || (pending.window === 'morning' && !time.isMorning)
        || Number(pending.day) !== Number(time.day);
    if (expired || wrongWindow) {
        delete bot._homeLifePendingAction;
        return null;
    }
    return pending.action;
}

function rememberHomeLifeAction(bot, time, window, action) {
    const previous = action.onStart;
    action.onStart = () => {
        if (bot._homeLifePendingAction?.action === action)
            delete bot._homeLifePendingAction;
        if (typeof previous === 'function') previous();
    };
    bot._homeLifePendingAction = {
        action,
        window,
        day: time.day,
        expiresAt: Date.now() + HOME_SCAN_TTL_MS,
    };
    return action;
}

export function planHomeLifeAction(agent, progressStatus = null) {
    const bot = agent.bot;
    if (!bot?.entity || bot.interrupt_code || bot._ownerDuty || bot._miningExpeditionActive)
        return null;
    const time = timeOfDayStatus(bot); // cheap; the full status scan is gated below
    const pending = pendingHomeLifeAction(bot, time);
    if (pending) return pending;
    const nightWindow = time.isNight && cooldownReady(bot, 'sleep', HOME_SLEEP_COOLDOWN_MS);
    const morningWindow = time.isMorning
        && bot._homeLifeLastMorningPrepDay !== time.day
        && cooldownReady(bot, 'morningPrep', MORNING_PREP_COOLDOWN_MS);
    // Skip the findBlocks-heavy home scan on the vast majority of idle ticks: only
    // look when a sleep/morning window is open or the periodic scan TTL has elapsed.
    if (!nightWindow && !morningWindow && !cooldownReady(bot, 'homeScan', HOME_SCAN_TTL_MS))
        return null;
    markCooldown(bot, 'homeScan');

    const status = getHomeLifeStatus(agent);
    const stage = progressStatus?.stage ?? null;
    const hasAnchor = Boolean(status.anchor);
    const earlyNoHome = !hasAnchor && ['bootstrap', 'homestead'].includes(stage);

    if (nightWindow && status.hasBed) {
        return rememberHomeLifeAction(bot, time, 'night', markOnActionStart(bot, 'sleep', {
            name: 'homeSleep', timeout: 6, fn: async () => await sleepAtHome(agent),
        }));
    }
    if (hasAnchor && morningWindow) {
        return rememberHomeLifeAction(bot, time, 'morning', markOnActionStart(bot, 'morningPrep', {
            name: 'morningPrep', timeout: 4, fn: async () => await morningPrep(agent),
        }));
    }
    if (!earlyNoHome
        && (!status.ready || !status.utilities.chest || !status.utilities.crafting || !status.utilities.furnace)
        && cooldownReady(bot, 'setup', HOME_SETUP_COOLDOWN_MS)) {
        return rememberHomeLifeAction(bot, time, 'setup', markOnActionStart(bot, 'setup', {
            name: 'setupHomeLife', timeout: 8, fn: async () => await setupHomeLife(agent),
        }));
    }
    return null;
}

function formatPoint(pos) {
    if (!pos) return 'none';
    return `${pos.x},${pos.y},${pos.z}`;
}

export function formatHomeLifeStatus(agentOrBot) {
    const status = agentOrBot?.lighting && agentOrBot?.time && agentOrBot?.utilities
        ? agentOrBot
        : getHomeLifeStatus(agentOrBot);
    return [
        `HOME LIFE: ${status.ready ? 'READY' : 'NEEDS WORK'} | anchor=${status.anchorType} ${formatPoint(status.position)} | time=${status.time.label}`,
        `Bed: ${status.hasBed ? formatPoint(status.bed) : 'missing'} | corner chest=${status.utilities.chest ? 'yes' : 'no'}, craft=${status.utilities.crafting ? 'yes' : 'no'}, furnace=${status.utilities.furnace ? 'yes' : 'no'}`,
        `Lighting: ${status.lighting.ok ? 'ok' : `${status.lighting.dark} dark spots`} | checked=${status.lighting.checked}, lights=${status.lighting.lights}`,
        `Morning kit: food=${status.inventory.food}, torches=${status.inventory.torches}, spare beds=${status.inventory.beds}`,
        `Blockers: ${status.blockers.length ? status.blockers.join(', ') : 'ok'}${status.warnings.length ? ` | warnings: ${status.warnings.join(', ')}` : ''}`,
    ].join('\n');
}
