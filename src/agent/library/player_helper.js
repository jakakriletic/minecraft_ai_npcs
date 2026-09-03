// Player-helper routines: bring, carry, deliver, guard and build-assist.
// These wrap existing low-level skills into player-like service actions.
import * as base from './base.js';
import * as build from './build.js';
import * as combat from './combat.js';
import * as loadout from './loadout.js';
import * as skills from './skills.js';
import * as storage from './storage.js';
import * as survival from './survival.js';
import * as town from './town.js';
import * as world from './world.js';
import * as mc from '../../utils/mcdata.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const LOG_ITEMS = ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'log', 'log2'];
const PLANK_ITEMS = ['planks', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks'];
const BASIC_BLOCKS = ['cobblestone', 'stone', 'dirt', 'planks', 'oak_planks', 'spruce_planks'];
const SINGLE_ITEM_REQUESTS = new Set(['bow', 'shield', 'pickaxe', 'axe', 'sword', 'shovel', 'hoe']);
const ITEM_ALIASES = {
    wood: 'wood', log: 'wood', logs: 'wood', les: 'wood', lesa: 'wood', hlod: 'wood', hlode: 'wood', drva: 'wood',
    plank: 'planks', planks: 'planks', deske: 'planks', desk: 'planks',
    stone: 'stone', kamen: 'stone', kamna: 'stone',
    cobble: 'cobblestone', cobblestone: 'cobblestone', cobbl: 'cobblestone',
    dirt: 'dirt', zemlja: 'dirt', zemlje: 'dirt',
    sand: 'sand', pesek: 'sand', peska: 'sand',
    gravel: 'gravel', prod: 'gravel',
    food: 'food', hrana: 'food', hrane: 'food', hrano: 'food',
    bread: 'bread', kruh: 'bread', kruha: 'bread',
    torch: 'torch', torches: 'torch', bakla: 'torch', bakle: 'torch', bakel: 'torch',
    arrow: 'arrow', arrows: 'arrow', puscica: 'arrow', puscice: 'arrow', puscic: 'arrow',
    shield: 'shield', scit: 'shield',
    bow: 'bow', lok: 'bow',
    pickaxe: 'pickaxe', kramp: 'pickaxe',
    axe: 'axe', sekira: 'axe',
    sword: 'sword', mec: 'sword',
    shovel: 'shovel', lopata: 'shovel',
    hoe: 'hoe', motika: 'hoe',
    coal: 'coal', premog: 'coal', premoga: 'coal',
    iron: 'iron_ingot', zelezo: 'iron_ingot', zeleza: 'iron_ingot',
    gold: 'gold_ingot', zlato: 'gold_ingot', zlata: 'gold_ingot',
    diamond: 'diamond', diamonds: 'diamond', diamant: 'diamond', diamante: 'diamond', diamantov: 'diamond',
    seeds: 'wheat_seeds', seed: 'wheat_seeds', semena: 'wheat_seeds', semen: 'wheat_seeds',
    blocks: 'support_blocks', block: 'support_blocks', materiali: 'support_blocks', material: 'support_blocks',
};
const STOPWORDS = new Set([
    'bring', 'give', 'deliver', 'fetch', 'carry', 'haul', 'move', 'transport',
    'prinesi', 'prinesite', 'dostavi', 'dostavite', 'daj', 'dajte', 'nosi',
    'nesi', 'odnesi', 'odnesite', 'prenesi', 'prenesite', 'znosi', 'mi', 'me',
    'to', 'for', 'at', 'k', 'h', 'za', 'the', 'a', 'an', 'some', 'please',
    'prosim', 'mene', 'meni', 'kralju', 'king', 'kralj',
]);
const BRING_RE = /\b(bring|give|deliver|fetch|prinesi\w*|dostavi\w*|daj\w*)\b/;
const CARRY_RE = /\b(carry|haul|transport|move|nosi\w*|nesi\w*|odnesi\w*|prenesi\w*|znosi\w*|sprazni\w*)\b.*\b(chest|items|stuff|inventory|skrinj\w*|stvari|predmete|inventar)\b|\b(chest|skrinj\w*)\b.*\b(carry|haul|transport|move|nosi\w*|odnesi\w*|prenesi\w*|sprazni\w*)\b/;
const GUARD_RE = /\b(guard|protect|defend|escort|watch|varuj\w*|sciti\w*|brani\w*|cuvaj\w*|pospremi\w*)\b.*\b(me|king|owner|player|mene|me|kralj\w*)\b|\b(guard|protect|defend|escort|varuj\w*|sciti\w*|brani\w*|cuvaj\w*|pospremi\w*)\b$/;
const HELP_BUILD_RE = /\b(help|assist|pomagaj\w*|pomagajte)\b.*\b(build|building|gradit\w*|gradnj\w*|zidat\w*|zidam|postav\w*)\b|\b(build|gradi\w*|zidaj\w*)\b.*\b(with me|z mano|skupaj)\b/;

function normalizeText(text) {
    return String(text ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s.!?_-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseCount(text, fallback = 8, max = 64) {
    const match = String(text ?? '').match(/\b(\d{1,3})\b/);
    if (!match) return fallback;
    return Math.min(max, Math.max(1, Number(match[1])));
}

function parseDurationMinutes(text, fallback = 15) {
    if (/\b(forever|until stop|until i stop|za vedno|ves cas|dokler ne recem stop)\b/.test(text))
        return -1;
    const match = String(text ?? '').match(/\b(\d{1,3})\s*(minutes?|mins?|minut|min|m)\b/);
    if (!match) return fallback;
    return Math.min(120, Math.max(1, Number(match[1])));
}

export function normalizeHelperItem(query = '') {
    const text = normalizeText(query);
    if (ITEM_ALIASES[text]) return ITEM_ALIASES[text];
    if (text.includes('_')) return text;
    for (const token of text.split(/\s+/)) {
        if (STOPWORDS.has(token) || /^\d+$/.test(token)) continue;
        if (ITEM_ALIASES[token]) return ITEM_ALIASES[token];
    }
    return text || 'support_blocks';
}

function parseItemFromText(text) {
    const normalized = normalizeText(text);
    const rawItem = normalized.match(/\b([a-z]+(?:_[a-z]+)+)\b/)?.[1];
    if (rawItem) return rawItem;
    for (const token of normalized.split(/\s+/)) {
        if (STOPWORDS.has(token) || /^\d+$/.test(token)) continue;
        if (ITEM_ALIASES[token]) return ITEM_ALIASES[token];
    }
    return 'support_blocks';
}

function parseOptionalItemFromText(text) {
    const normalized = normalizeText(text);
    const rawItem = normalized.match(/\b([a-z]+(?:_[a-z]+)+)\b/)?.[1] ?? null;
    if (rawItem) return rawItem;
    for (const token of normalized.split(/\s+/)) {
        if (STOPWORDS.has(token) || /^\d+$/.test(token)) continue;
        if (ITEM_ALIASES[token]) return ITEM_ALIASES[token];
    }
    return null;
}

function parseTargetPlayer(text, source = null) {
    const normalized = normalizeText(text);
    const target = normalized.match(/\b(?:to|for|k|h|za)\s+([a-zA-Z0-9_]{2,16})\b/)?.[1] ?? null;
    if (!target || ['me', 'mene', 'meni', 'king', 'kralj', 'kralju'].includes(target)) return source;
    return target;
}

function parseBuildName(text) {
    const normalized = normalizeText(text);
    const match = normalized.match(/\b(?:build|gradit\w*|gradnj\w*|zidat\w*|postav\w*)\s+(.+)$/);
    if (!match) return null;
    const cleaned = match[1]
        .replace(/\b(with me|z mano|skupaj|please|prosim)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || null;
}

export function classifyPlayerHelperCommand(message, source = null) {
    const text = normalizeText(message);
    if (!text || text.startsWith('!')) return null;
    if (CARRY_RE.test(text)) {
        return {
            type: 'carry',
            text,
            item: parseOptionalItemFromText(text),
            count: parseCount(text, 64),
            targetPlayer: parseTargetPlayer(text, source),
        };
    }
    if (GUARD_RE.test(text)) {
        return {
            type: 'guard',
            text,
            targetPlayer: parseTargetPlayer(text, source) ?? source,
            minutes: parseDurationMinutes(text, -1),
        };
    }
    if (HELP_BUILD_RE.test(text)) {
        return {
            type: 'helpBuild',
            text,
            targetPlayer: parseTargetPlayer(text, source) ?? source,
            buildName: parseBuildName(text),
        };
    }
    if (BRING_RE.test(text)) {
        const item = parseItemFromText(text);
        return {
            type: 'bring',
            text,
            item,
            count: parseCount(text, SINGLE_ITEM_REQUESTS.has(item) ? 1 : 8),
            targetPlayer: parseTargetPlayer(text, source) ?? source,
        };
    }
    return null;
}

function aliasesForItem(itemName) {
    const item = normalizeHelperItem(itemName);
    if (item === 'wood') return LOG_ITEMS;
    if (item === 'planks') return PLANK_ITEMS;
    if (item === 'support_blocks') return BASIC_BLOCKS;
    if (item === 'food') return loadout.FOOD;
    if (item === 'pickaxe') return ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'];
    if (item === 'axe') return ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe'];
    if (item === 'sword') return ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword'];
    if (item === 'shovel') return ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel'];
    if (item === 'hoe') return ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'stone_hoe', 'wooden_hoe'];
    return [item];
}

function inventoryCount(bot, names) {
    const counts = world.getInventoryCounts(bot);
    return aliasesForItem(names).reduce((sum, name) => sum + (counts[name] ?? 0), 0);
}

// Parsed player names come out of normalizeText() lowercased, but bot.players and
// skills.giveToPlayer/goToPlayer/followPlayer key on the exact (case-sensitive)
// username. Map back to the real key so delivery/guard to a mixed-case player works.
function resolvePlayerName(bot, name) {
    if (!name) return name;
    const players = bot?.players ?? {};
    if (players[name]) return name;
    const lower = String(name).toLowerCase();
    return Object.keys(players).find(key => key.toLowerCase() === lower) ?? name;
}

function bestInventoryItemName(bot, itemName) {
    const aliases = aliasesForItem(itemName);
    return bot.inventory.items().find(item =>
        aliases.some(alias => mc.stackMatchesName(item, alias, bot)))?.name ?? aliases[0];
}

async function takeFromStorage(bot, itemName, count) {
    const aliases = aliasesForItem(itemName);
    try { await base.takeAny(bot, aliases, count); } catch { /* no home/public storage */ }
    return inventoryCount(bot, itemName) >= count;
}

async function craftOrGather(agent, itemName, count) {
    const bot = agent.bot;
    const item = normalizeHelperItem(itemName);
    if (item === 'wood') return await skills.ensureLogs(bot, count);
    if (item === 'planks') {
        if (inventoryCount(bot, 'planks') < count) await skills.ensureLogs(bot, Math.ceil(count / 4));
        return await skills.ensurePlanks(bot, count);
    }
    if (item === 'cobblestone' || item === 'support_blocks') return await skills.ensureCobblestone(bot, Math.min(count, 64));
    if (['stone', 'dirt', 'sand', 'gravel'].includes(item)) return await skills.collectBlock(bot, item, Math.min(count, 64));
    if (item === 'food' || item === 'bread') return await survival.secureFood(bot);
    if (item === 'torch') return await survival.makeTorches(bot, Math.min(count, 32), true);
    if (item === 'arrow' || item === 'bow' || item === 'shield') {
        await combat.ensureCombatKit(agent, { gather: true, arrowTarget: item === 'arrow' ? count : 8 });
        return inventoryCount(bot, item) >= Math.min(count, 64);
    }
    if (['pickaxe', 'axe', 'sword', 'shovel', 'hoe'].includes(item))
        return await skills.obtainTool(bot, `stone_${item}`);
    return false;
}

export async function ensureHelperItem(agent, itemName, count = 1) {
    const bot = agent.bot;
    const item = normalizeHelperItem(itemName);
    const target = Math.min(64, Math.max(1, Number(count) || 1));
    if (inventoryCount(bot, item) < target)
        await takeFromStorage(bot, item, target);
    if (inventoryCount(bot, item) < target)
        await craftOrGather(agent, item, target);
    const have = inventoryCount(bot, item);
    return {
        item,
        requested: target,
        have,
        ready: have >= target,
        deliveryName: bestInventoryItemName(bot, item),
    };
}

export async function bringToPlayer(agent, targetPlayer, itemName, count = 1) {
    const bot = agent.bot;
    const target = resolvePlayerName(bot, targetPlayer ?? agent.commandSource);
    if (!target) {
        skills.log(bot, 'Ne vem komu naj dostavim.');
        return false;
    }
    const prepared = await ensureHelperItem(agent, itemName, count);
    if (!prepared.ready) {
        skills.log(bot, `Ne morem pripraviti ${prepared.item} za dostavo.`);
        return false;
    }
    const amount = Math.min(prepared.requested, prepared.have);
    const ok = await skills.giveToPlayer(bot, prepared.deliveryName, target, amount);
    skills.log(bot, ok
        ? `Dostavil ${amount}x ${prepared.deliveryName} igralcu ${target}.`
        : `Dostava ${prepared.deliveryName} igralcu ${target} ni uspela.`);
    return ok;
}

export async function carryNearbyChest(agent, sourcePlayer = agent.commandSource, itemName = null) {
    const bot = agent.bot;
    const resolvedSource = resolvePlayerName(bot, sourcePlayer);
    const player = resolvedSource ? bot.players[resolvedSource]?.entity : null;
    const pos = player?.position ?? bot.entity?.position;
    if (!pos) return false;
    const item = itemName ? normalizeHelperItem(itemName) : null;
    const before = bot.inventory.emptySlotCount?.() ?? 0;
    const took = await base.takeFromChestsNear(bot, pos, 6, item);
    if (!took) return false;
    const stashed = await base.stash(bot);
    skills.log(bot, stashed
        ? `Prenesel stvari iz bliznje skrinje v shrambo.`
        : `Pobral stvari iz skrinje; shramba ni bila dosegljiva.`);
    return stashed || (bot.inventory.emptySlotCount?.() ?? before) < before;
}

// Long-lived player tracking for loyal follow/guard duties. Mineflayer drops the
// player's entity outside the server tracking range; a plain GoalFollow then returns
// and the bot silently abandons its order. Keep the last known position, travel there
// in long-range hops, and wait for the player to become visible again.
export async function followPlayerPersistently(agent, targetPlayer, distance = 3, minutes = -1) {
    const bot = agent.bot;
    const target = resolvePlayerName(bot, targetPlayer ?? agent.commandSource);
    if (!target) return false;
    const followDistance = Math.min(12, Math.max(1, Number(distance) || 3));
    const until = minutes === -1 ? null : Date.now() + Math.max(1, minutes) * 60_000;
    const firstSightDeadline = Date.now() + 20_000;
    let sawTarget = false;
    let announcedSearch = false;
    let offlineSince = null;
    delete bot._followTargetLastSeen;

    while (!bot.interrupt_code && (until === null || Date.now() < until)) {
        const player = bot.players?.[target]?.entity;
        if (player) {
            sawTarget = true;
            announcedSearch = false;
            offlineSince = null;
            bot._followTargetLastSeen = player.position.clone();
            await skills.followPlayer(bot, target, followDistance, { until });
            continue;
        }
        if (!bot.players?.[target]) {
            offlineSince ??= Date.now();
            if (Date.now() - offlineSince > 60_000) {
                skills.log(bot, `${target} is offline — ending the follow.`);
                return false;
            }
            await sleep(2000);
            continue;
        }
        offlineSince = null;
        const last = bot._followTargetLastSeen;
        if (last && bot.entity.position.distanceTo(last) > followDistance + 1) {
            if (!announcedSearch) {
                announcedSearch = true;
                skills.log(bot, `Lost sight of ${target} — heading to their last known position.`);
            }
            await skills.travelToPosition(bot, last.x, last.y, last.z, followDistance);
            continue;
        }
        if (!sawTarget && Date.now() >= firstSightDeadline) {
            skills.log(bot, `I cannot see ${target} anywhere near me.`);
            return false;
        }
        await sleep(1000);
    }
    return sawTarget;
}

export async function guardPlayer(agent, targetPlayer = agent.commandSource, minutes = -1) {
    const bot = agent.bot;
    const target = resolvePlayerName(bot, targetPlayer ?? agent.commandSource);
    if (!target) return false;
    await loadout.prepareForTask(agent, 'escort');
    combat.setOwnerCombatStance(agent, 'defensive', minutes);
    combat.setOwnerCombatStyle(agent, 'defender', minutes);
    skills.log(bot, `Varujem ${target}${minutes === -1 ? '' : ` ${minutes} minut`}.`);
    return await followPlayerPersistently(agent, target, 4, minutes);
}

export async function helpBuild(agent, targetPlayer = agent.commandSource, buildName = null) {
    const bot = agent.bot;
    const target = resolvePlayerName(bot, targetPlayer);
    await loadout.prepareForTask(agent, 'builder');
    if (target && bot.players?.[target]?.entity)
        await skills.goToPlayer(bot, target, 4);

    let queued = null;
    if (buildName) {
        const resolved = build.resolveSchematic(buildName, Math.random, storage.getPublicStorage(bot)?.townStyle);
        if (resolved.entry) queued = await town.queueBuild(bot, resolved.entry.name);
        else skills.log(bot, resolved.error ?? `Ne najdem nacrta "${buildName}".`);
    }
    const ready = loadout.getLoadoutStatus(bot, 'builder').ready;
    skills.log(bot, queued
        ? `Pomagam graditi: ${queued.schematic ?? queued.name ?? buildName}.`
        : `Pripravljen sem pomagati pri gradnji${target ? ` pri ${target}` : ''}.`);
    return ready || Boolean(queued);
}

export function getPlayerHelperStatus(agentOrBot) {
    const bot = agentOrBot?.bot ?? agentOrBot;
    const counts = world.getInventoryCounts(bot);
    const helper = {
        carriedFood: loadout.FOOD.reduce((sum, item) => sum + (counts[item] ?? 0), 0),
        carriedTorches: counts.torch ?? 0,
        carriedBlocks: BASIC_BLOCKS.reduce((sum, item) => sum + (counts[item] ?? 0), 0),
        emptySlots: bot.inventory?.emptySlotCount?.() ?? 0,
        visiblePlayers: Object.keys(bot.players ?? {}).filter(name => name !== bot.username),
        builderReady: loadout.getLoadoutStatus(bot, 'builder').ready,
        escortReady: loadout.getLoadoutStatus(bot, 'escort').ready,
    };
    return {
        ready: helper.emptySlots > 0 && (helper.builderReady || helper.escortReady || helper.carriedFood > 0 || helper.carriedBlocks > 0),
        ...helper,
    };
}

export function formatPlayerHelperStatus(agentOrBot) {
    const status = getPlayerHelperStatus(agentOrBot);
    return `PLAYER HELPER: ${status.ready ? 'READY' : 'NEEDS WORK'} | players=${status.visiblePlayers.join(', ') || 'none'} | `
        + `food=${status.carriedFood}, torches=${status.carriedTorches}, blocks=${status.carriedBlocks}, slots=${status.emptySlots} | `
        + `builder=${status.builderReady ? 'ready' : 'blocked'}, escort=${status.escortReady ? 'ready' : 'blocked'}`;
}
