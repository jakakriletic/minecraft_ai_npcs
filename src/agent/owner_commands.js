import { Vec3 } from 'vec3';
import * as mc from '../utils/mcdata.js';
import * as skills from './library/skills.js';
import * as survival from './library/survival.js';
import * as world from './library/world.js';
import * as combat from './library/combat.js';
import * as playerHelper from './library/player_helper.js';
import { isPositionProtected } from './library/resource_guard.js';
import {
    bumpRoyalIntentResume,
    cancelRoyalIntent,
    createRoyalIntent,
    finishRoyalIntent,
    markRoyalIntent,
} from './library/royal_intent.js';
import { serverProxy } from './mindserver_proxy.js';
import settings from './settings.js';

const LOG_BLOCKS = [
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
    'cherry_log', 'mangrove_log', 'log', 'log2',
];
const AIR_LIKE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tallgrass', 'tall_grass', 'fern', 'large_fern', 'snow']);
const LIQUIDS = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
const UNBREAKABLE = new Set([
    'bedrock', 'barrier', 'end_portal', 'end_portal_frame', 'nether_portal',
    'command_block', 'chain_command_block', 'repeating_command_block',
]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// \w* endings: Slovenian imperatives conjugate (nehaj/nehajte/nehajo, ustavi/ustavite,
// stoj/stojte) — a bare \b(nehaj)\b never matched the plural "nehajte", so a whole
// team ordered to follow could not be dismissed in plural.
const STOP_RE = /\b(stop|halt|wait|stay|stoj\w*|ustav\w*|pocak\w*|nehaj\w*|nehi\w*)\b/;
const FOLLOW_RE = /\b(follow|come with me|come along|sledi\w*|za mano|za menoj|hodi\w* za mano|hodi\w* z mano|pridi\w* z mano|pojdi\w* z mano)\b/;
const DIG_PIT_RE = /\b(dig|excavate|koplji|kopljejo|skoplji|izkoplji|kopljite)\b.*\b(pit|hole|shaft|area|region|jamo|jama|luknjo|luknja|regijo|obmocje)\b|\b(pit|hole|jamo|jama|luknjo|luknja)\b.*\b(dig|excavate|koplji|kopljejo|skoplji|izkoplji|kopljite)\b/;
const WOOD_RE = /\b(chop|cut|fell|seci|sekaj|sekajo|sekajte|posekaj|podri|podrite)\b.*\b(wood|log|logs|tree|trees|les|drva|drvi|drv|drevo|drevesa|dreves|hlod|hlode)\b|\b(wood|log|logs|tree|trees|les|drva|drvi|drv|drevo|drevesa|dreves|hlod|hlode)\b.*\b(chop|cut|collect|gather|get|naberi|naberite|prinesi|seci|sekaj|sekajo|sekajte|posekaj)\b/;
const GATHER_RE = /\b(gather|collect|get|bring|mine|naberi|nabiraj|nabirajo|nabirajte|naberite|prinesi|zberi|zbiraj|zbirajo|zberite|naredi|najdi|koplji|kopljejo|kopljite|pojdi|pojdite|pejt|pejte)\b.*\b(resource|resources|surovin|surovine|wood|log|logs|stone|cobble|cobblestone|coal|iron|gold|diamond|lapis|redstone|emerald|dirt|sand|gravel|food|torch|torches|les|drva|drvi|drv|kamen|premog|zelezo|zlato|diamant|smaragd|zemlja|pesek|prod|hrana|bakle|bakla)\b|\b(resource|resources|surovin|surovine)\b.*\b(gather|collect|get|naberi|nabiraj|nabirajo|nabirajte|naberite|zberi|zbiraj|zbirajo|zberite)\b/;
const ATTACK_RE = /\b(attack|kill|fight|engage|target|napadi|napadite|napadejo|ubij|ubijte|bori|borite)\b/;
const CHEST_WORD = '(?:chest\\w*|skrinj\\w*)';
const CHEST_TAKE_RE = new RegExp(
    `\\b(take|grab|fetch|withdraw|vzemi|vzem|uzemi|vzemite|poberi|poberite)\\b[^]*\\b${CHEST_WORD}\\b`
    + `|\\b${CHEST_WORD}\\b[^]*\\b(take|grab|withdraw|vzemi|uzemi|poberi|ven)\\b`);
const CHEST_VIEW_RE = new RegExp(
    `\\b(check|look|peek|view|open|show|inspect|whats? in|poglej|poglejte|preveri|preverite|odpri|odprite|pokazi|pokazite)\\b[^]*\\b${CHEST_WORD}\\b`);
// Owner phrasing → registry item match for chest withdrawals (normalized, no diacritics).
const CHEST_ITEM_ALIASES = {
    les: 'log', hlod: 'log', hlode: 'log', hlodi: 'log', wood: 'log', logs: 'log', log: 'log',
    drva: 'log', drv: 'log', drvi: 'log',
    deske: 'planks', deska: 'planks', planks: 'planks', plank: 'planks',
    kruh: 'bread', bread: 'bread',
    premog: 'coal', coal: 'coal',
    zelezo: 'iron_ingot', iron: 'iron_ingot', ingot: 'iron_ingot',
    zlato: 'gold_ingot', gold: 'gold_ingot',
    diamant: 'diamond', diamante: 'diamond', diamanti: 'diamond', diamond: 'diamond', diamonds: 'diamond',
    lapis: 'lapis_lazuli',
    kamen: 'cobblestone', stone: 'cobblestone', cobblestone: 'cobblestone', cobble: 'cobblestone',
    bakla: 'torch', bakle: 'torch', baklo: 'torch', torch: 'torch', torches: 'torch',
    hrana: 'food', hrano: 'food', food: 'food',
    seme: 'wheat_seeds', semena: 'wheat_seeds', seeds: 'wheat_seeds',
    psenica: 'wheat', psenico: 'wheat', wheat: 'wheat',
    kramp: 'pickaxe', pickaxe: 'pickaxe', sekira: 'axe', axe: 'axe', mec: 'sword', sword: 'sword',
    lopata: 'shovel', shovel: 'shovel', motika: 'hoe', hoe: 'hoe',
    obleka: 'chestplate', oklep: 'chestplate', armor: 'chestplate',
    lok: 'bow', bow: 'bow', bows: 'bow',
    puscica: 'arrow', puscice: 'arrow', arrow: 'arrow', arrows: 'arrow',
    scit: 'shield', shield: 'shield',
    vrv: 'string', vrvica: 'string', string: 'string',
    palica: 'stick', palice: 'stick', stick: 'stick', sticks: 'stick',
    redstone: 'redstone', smaragd: 'emerald', emerald: 'emerald',
    vedro: 'bucket', bucket: 'bucket',
    postelja: 'bed', posteljo: 'bed', bed: 'bed',
    knjiga: 'book', knjigo: 'book', book: 'book',
    jabolko: 'apple', apple: 'apple',
    meso: 'food', meat: 'food',
    obsidian: 'obsidian', obsidijan: 'obsidian',
    usnje: 'leather', leather: 'leather',
    volna: 'wool', volno: 'wool', wool: 'wool',
    steklo: 'glass', glass: 'glass',
    pesek: 'sand', sand: 'sand',
    zemlja: 'dirt', zemljo: 'dirt', dirt: 'dirt',
    // Slovenian genitive/count forms ("vzemi 5 kruha/premoga/zeleza...")
    kruha: 'bread', premoga: 'coal', zeleza: 'iron_ingot', zlata: 'gold_ingot',
    diamanta: 'diamond', diamantov: 'diamond', lesa: 'log', kamna: 'cobblestone',
    bakel: 'torch', loka: 'bow', puscic: 'arrow', palic: 'stick', semen: 'wheat_seeds',
    psenice: 'wheat', hrane: 'food', mesa: 'food', stekla: 'glass', peska: 'sand',
    zemlje: 'dirt', vedra: 'bucket', knjige: 'book', jabolk: 'apple', jabolka: 'apple',
};
const CHEST_FOOD = new Set(['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    'baked_potato', 'apple', 'carrot', 'golden_carrot', 'cooked_cod', 'cooked_salmon', 'cooked_rabbit']);
const CHEST_STOPWORDS = new Set(['chest', 'chests', 'the', 'from', 'out', 'some', 'and', 'take', 'grab',
    'fetch', 'withdraw', 'look', 'check', 'open', 'show', 'give', 'me', 'iz', 'ven', 'vzemi', 'uzemi',
    'poberi', 'poglej', 'preveri', 'odpri', 'pokazi', 'skrinje', 'skrinjo', 'skrinji', 'skrinja', 'tam', 'to']);

function parseChestItem(text) {
    for (const token of String(text).split(/\s+/)) {
        if (CHEST_STOPWORDS.has(token)) continue;
        if (CHEST_ITEM_ALIASES[token]) return CHEST_ITEM_ALIASES[token];
    }
    const explicit = String(text).match(/\b([a-z]+(?:_[a-z]+)+)\b/); // raw item ids like iron_ingot
    return explicit ? explicit[1] : null;
}

// All owner words that could NAME an item — matched against the chest's actual
// contents as a fallback, so items missing from the alias map still resolve.
function chestQueryTokens(text) {
    return String(text).split(/\s+/)
        .filter(token => token.length >= 3 && !CHEST_STOPWORDS.has(token) && !/^\d+$/.test(token));
}

// Resolve the owner's wording against what is actually IN the chest:
// alias/explicit query first, then each raw token; exact name → prefix → substring.
function resolveChestMatches(items, query, tokens) {
    const names = [...new Set(items.map(item => item.name))];
    const findFor = candidate => {
        if (!candidate) return null;
        if (candidate === 'food') return names.filter(name => CHEST_FOOD.has(name));
        if (candidate === 'log') return names.filter(name => name.endsWith('_log') || name === 'log' || name === 'log2');
        if (candidate === 'planks') return names.filter(name => name.includes('planks'));
        if (['pickaxe', 'axe', 'sword', 'shovel', 'hoe', 'chestplate', 'helmet', 'leggings', 'boots'].includes(candidate))
            return names.filter(name => name.endsWith(candidate));
        const exact = names.filter(name => name === candidate);
        if (exact.length) return exact;
        const prefixed = names.filter(name => name.startsWith(candidate));
        if (prefixed.length) return prefixed;
        const contains = names.filter(name => name.includes(candidate));
        return contains.length ? contains : null;
    };
    let matchedNames = findFor(query);
    if (matchedNames?.length) return { matchedNames, label: query };
    for (const token of tokens ?? []) {
        const singular = token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token;
        matchedNames = findFor(CHEST_ITEM_ALIASES[singular] ?? singular) ?? findFor(token);
        if (matchedNames?.length) return { matchedNames, label: matchedNames[0] };
    }
    return { matchedNames: [], label: query ?? tokens?.[0] ?? 'that' };
}

function parseChestCount(text) {
    const match = String(text).match(/\b(\d{1,3})\b/);
    return match ? Math.max(1, parseInt(match[1], 10)) : null; // null → take all of it
}
const STYLE_RE = /\b(archer|ranged|bow|bows|lokostrelec|lokostrelci|lok|defender|defenders|melee|shield|branilec|branilci)\b/;
const STANCE_RE = /\b(aggressive|attack mode|agresivni|agresivno|napadalni|napadalno|defensive|defense|guard|defenzivni|defenzivno|obrambni|obrambno|passive|peaceful|hold fire|mirni|mirno|normal|balanced|reset)\b/;
const HELPER_ACTION_RE = /\b(bring|give|deliver|fetch|carry|haul|transport|move|guard|protect|defend|escort|help|assist|prinesi\w*|dostavi\w*|daj\w*|nosi\w*|nesi\w*|odnesi\w*|prenesi\w*|varuj\w*|sciti\w*|brani\w*|cuvaj\w*|pospremi\w*|pomagaj\w*)\b/;

function normalizeText(message) {
    return String(message ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s.!?*x-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function ownerName() {
    return String(settings.owner_player ?? '').trim();
}

function isOwner(source) {
    const owner = ownerName();
    return owner.length > 0 && String(source ?? '').toLowerCase() === owner.toLowerCase();
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function validBlocks(bot, names) {
    return names.filter(name => {
        try {
            return mc.registryBlockIds(bot, [name]).length > 0;
        } catch {
            return false;
        }
    });
}

function parseCount(text, fallback, max = 64) {
    const match = text.match(/\b(\d{1,3})\b/);
    if (!match) return fallback;
    return clamp(Number(match[1]), 1, max);
}

function parseDurationMinutes(text, fallback = 15, max = 120) {
    if (/\b(forever|until i stop|dokler ne recem stop|za vedno|ves cas)\b/.test(text)) return -1;
    const match = text.match(/\b(\d{1,3})\s*(minutes?|mins?|minut|min|m)\b/);
    if (!match) return fallback;
    return clamp(Number(match[1]), 1, max);
}

function parseAttackTarget(text) {
    const match = text.match(/\b(?:attack|kill|fight|engage|target|napadi|napadite|napadejo|ubij|ubijte|bori|borite)\b\s*(.*)$/);
    let target = match?.[1]?.trim() || 'enemy';
    target = target
        .replace(/\b(nearest|closest|the|a|an|najblizjega|najblizji|tistega|tisto|tega|to|moba|mob)\b/g, ' ')
        .replace(/\b(for|za)\s+\d{1,3}\s*(minutes?|mins?|minut|min|m)\b/g, ' ')
        .replace(/\b\d{1,3}\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return target || 'enemy';
}

function parseCombatStyle(text) {
    if (/\b(archer|ranged|bow|bows|lokostrelec|lokostrelci|lok)\b/.test(text)) return 'archer';
    if (/\b(defender|defenders|melee|shield|branilec|branilci|obrambni)\b/.test(text)) return 'defender';
    if (/\b(normal|balanced|reset|navadno|normalno)\b/.test(text)) return 'normal';
    return null;
}

function parseCombatStance(text) {
    if (/\b(aggressive|attack mode|agresivni|agresivno|napadalni|napadalno)\b/.test(text)) return 'aggressive';
    if (/\b(defensive|defense|guard|defenzivni|defenzivno|obrambni|obrambno)\b/.test(text)) return 'defensive';
    if (/\b(passive|peaceful|hold fire|mirni|mirno|ne napadaj)\b/.test(text)) return 'passive';
    if (/\b(normal|balanced|reset|navadno|normalno)\b/.test(text)) return 'normal';
    return null;
}

function parsePitDimensions(text) {
    const dims = text.match(/\b(\d{1,2})\s*(?:x|\*|by)\s*(\d{1,2})(?:\s*(?:x|\*|by)\s*(\d{1,2}))?\b/);
    const depthOnly = text.match(/\b(?:depth|deep|globok|globoko)\s*(\d{1,2})\b/);
    return {
        width: clamp(Number(dims?.[1] ?? 5), 3, 12),
        length: clamp(Number(dims?.[2] ?? dims?.[1] ?? 5), 3, 12),
        depth: clamp(Number(dims?.[3] ?? depthOnly?.[1] ?? 3), 1, 8),
    };
}

function resourceFromText(text) {
    if (/\b(wood|log|logs|tree|trees|les|drva|drvi|drv|drevo|drevesa|dreves|hlod|hlode)\b/.test(text)) return 'wood';
    if (/\b(coal|premog)\b/.test(text)) return 'coal';
    if (/\b(iron|zelezo)\b/.test(text)) return 'iron';
    if (/\b(gold|zlato)\b/.test(text)) return 'gold';
    if (/\b(diamond|diamant)\b/.test(text)) return 'diamond';
    if (/\b(lapis)\b/.test(text)) return 'lapis';
    if (/\b(redstone)\b/.test(text)) return 'redstone';
    if (/\b(emerald|smaragd)\b/.test(text)) return 'emerald';
    if (/\b(cobble|cobblestone)\b/.test(text)) return 'cobblestone';
    if (/\b(stone|kamen)\b/.test(text)) return 'stone';
    if (/\b(dirt|zemlja)\b/.test(text)) return 'dirt';
    if (/\b(sand|pesek)\b/.test(text)) return 'sand';
    if (/\b(gravel|prod)\b/.test(text)) return 'gravel';
    if (/\b(food|hrana)\b/.test(text)) return 'food';
    if (/\b(torch|torches|bakle|bakla)\b/.test(text)) return 'torches';
    return 'resources';
}

function firstMatchIndex(text, patterns) {
    return patterns.reduce((earliest, pattern) => {
        const index = text.search(pattern);
        if (index < 0) return earliest;
        return earliest < 0 ? index : Math.min(earliest, index);
    }, -1);
}

export function classifyOwnerCommand(message) {
    const text = normalizeText(message);
    if (!text || text.startsWith('!')) return null;
    const helper = playerHelper.classifyPlayerHelperCommand(text, ownerName());
    const stopAt = text.search(STOP_RE);
    if (stopAt >= 0) {
        const actionAt = firstMatchIndex(text, [
            CHEST_TAKE_RE,
            CHEST_VIEW_RE,
            ATTACK_RE,
            STYLE_RE,
            STANCE_RE,
            FOLLOW_RE,
            DIG_PIT_RE,
            WOOD_RE,
            GATHER_RE,
            ...(helper ? [HELPER_ACTION_RE] : []),
        ]);
        if (actionAt < 0 || stopAt <= actionAt) return { type: 'stop', text };
    }
    // Chest requests are classified BEFORE combat/attack/gather matchers: "take the
    // bow from the chest" contains 'bow' (STYLE_RE) and item words (GATHER_RE), and
    // would otherwise flip every bot into archer mode instead of opening the chest.
    if (CHEST_TAKE_RE.test(text))
        return { type: 'chestTake', text, itemQuery: parseChestItem(text), tokens: chestQueryTokens(text), count: parseChestCount(text) };
    if (CHEST_VIEW_RE.test(text)) return { type: 'chestView', text };
    if (helper) return helper;
    if (ATTACK_RE.test(text)) {
        const target = parseAttackTarget(text);
        return { type: 'attack', text, target, count: parseCount(text, target === 'enemy' ? 32 : 1, 32) };
    }
    if (STYLE_RE.test(text) || STANCE_RE.test(text)) {
        const style = parseCombatStyle(text);
        const stance = parseCombatStance(text);
        if (style || stance)
            return { type: 'combatDirective', text, style, stance, minutes: parseDurationMinutes(text, 15, 120) };
    }
    // A bare "follow me" / "sledi mi" now follows INDEFINITELY (fallback -1) until the
    // owner says stop/nehaj — the bot drops its work and obeys until dismissed. An
    // explicit duration ("follow me for 10 minutes") still parses and caps the follow.
    if (FOLLOW_RE.test(text)) return { type: 'follow', text, minutes: parseDurationMinutes(text, -1, 120) };
    if (DIG_PIT_RE.test(text)) return { type: 'digPit', text, dims: parsePitDimensions(text) };
    if (WOOD_RE.test(text)) return { type: 'wood', text, count: parseCount(text, 12, 48) };
    if (GATHER_RE.test(text)) {
        const resource = resourceFromText(text);
        return { type: 'gather', text, resource, count: parseCount(text, resource === 'resources' ? 12 : 8, 64) };
    }
    return null;
}

export function ownerCommandLooksActionable(message) {
    return classifyOwnerCommand(message) != null;
}

// Does the owner's message name THIS bot (word-boundary, so "Zan" never fires on
// "zanima")? Used to skip elections: a bot the owner named was chosen by him.
function messageAddressesAgent(agent, message) {
    const name = String(agent.name ?? '').trim().toLowerCase();
    if (!name) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(normalizeText(message));
}

// In-character wording for owner acknowledgements: the order itself still executes
// deterministically; only the WORDING goes through the budget-gated LLM line in
// cognition.js (personality + roleplay.md scenario), falling back to the plain
// template on any failure. This is where the King hears his servants' personality.
async function ownerAck(agent, source, fallback, situation) {
    try {
        const { generateOwnerReply } = await import('./roleplay/cognition.js');
        return await generateOwnerReply(agent, source, situation, fallback);
    } catch {
        return fallback;
    }
}

// Let an interrupting emergency action (a survival mode) finish before the duty
// resumes; gives up when the duty was replaced, cancelled, or ran out of time.
async function waitForDutyTurn(agent, duty, seq, until) {
    while (!agent.isIdle()) {
        if (agent.bot._ownerDuty !== duty || (agent._ownerCommandSeq ?? 0) !== seq)
            return { ready: false, replaced: true };
        if (until !== null && Date.now() >= until) return { ready: false, expired: true };
        await sleep(250);
    }
    return { ready: true };
}

async function runOwnerAction(agent, source, label, ack, actionFn, timeout = 10, opts = {}) {
    agent.requestInterrupt();
    agent.actions.cancelResume();
    const duty = createRoyalIntent(agent, source, label, {
        timeoutMins: timeout,
        ack,
        intent: opts.intent,
        target: opts.target,
        selectedBots: opts.selectedBots,
        safetyPolicy: opts.safetyPolicy,
        reportPolicy: opts.reportPolicy,
        metadata: opts.metadata,
    });
    agent.bot._ownerDuty = duty;
    const seq = agent._ownerCommandSeq ?? 0;
    try {
    // Urgent duties (combat) keep the instant template ack; the rest may wait a
    // few seconds for an in-character line before starting.
    const spokenAck = opts.deterministicAck
        ? ack
        : await ownerAck(agent, source, ack, `You are about to start the task "${label}" as ordered.`);
    markRoyalIntent(duty, 'acknowledged', { spokenAck });
    await agent.routeResponse(source, spokenAck);
    markRoyalIntent(duty, 'running');
    let result = await agent.actions.runAction(`owner:${label}`, actionFn, { timeout });
    // The King's order outranks routine interrupts: when a survival mode (cowardice,
    // unstuck, self_defense...) cuts the duty short, wait for that emergency to end
    // and resume the SAME duty. Only success, an honest failure, the deadline, !stop
    // (clears _ownerDuty), or a newer owner command (bumps _ownerCommandSeq) end it.
    while (result?.interrupted && !result?.timedout
        && agent.bot._ownerDuty === duty
        && (agent._ownerCommandSeq ?? 0) === seq
        && (duty.until === null || Date.now() < duty.until)) {
        bumpRoyalIntentResume(duty);
        const turn = await waitForDutyTurn(agent, duty, seq, duty.until);
        if (!turn.ready) break;
        markRoyalIntent(duty, 'running');
        const minutesLeft = duty.until === null
            ? timeout
            : Math.max(1, Math.ceil((duty.until - Date.now()) / 60_000));
        result = await agent.actions.runAction(`owner:${label}`, actionFn, { timeout: minutesLeft });
    }
    const replaced = (agent._ownerCommandSeq ?? 0) !== seq || agent.bot._ownerDuty !== duty;
    if (result?.interrupted && !result?.timedout) {
        if (replaced) {
            finishRoyalIntent(agent.bot, duty, result, { replaced: true });
            if (agent.bot._ownerDuty === duty) delete agent.bot._ownerDuty;
            return true; // a newer royal order took over and reports itself
        }
        result = { ...result, success: false, timedout: true }; // deadline ran out mid-interrupt
    }
    finishRoyalIntent(agent.bot, duty, result, { replaced });
    if (agent.bot._ownerDuty === duty) delete agent.bot._ownerDuty;
    if (!result?.success) {
        const fallback = result?.timedout
            ? `I could not finish ${label} before the timeout.`
            : `I could not finish ${label}.`;
        await agent.routeResponse(source,
            await ownerAck(agent, source, fallback, `You FAILED to finish the task "${label}" and must report that honestly.`));
    } else {
        await agent.routeResponse(source,
            await ownerAck(agent, source, `Done with ${label}. Returning to normal duties.`, `You successfully finished the task "${label}" and report it.`));
    }
    return true;
    } finally {
        // Safety net: the normal paths above already release the duty. But if anything
        // threw (e.g. a translation/chat failure in the spoken ack, before cleanup),
        // an indefinite duty (until===null, "follow me"/"guard me") would stay pinned
        // on the bot and freeze brainTick forever. Always release OUR duty on exit.
        if (agent.bot._ownerDuty === duty) {
            try { finishRoyalIntent(agent.bot, duty, { success: false, interrupted: true }, { reason: 'aborted' }); }
            catch { /* best effort */ }
            delete agent.bot._ownerDuty;
        }
    }
}

async function stopForOwner(agent, source) {
    cancelRoyalIntent(agent.bot); // cancel FIRST so the resume loop cannot re-run the task
    agent.requestInterrupt();
    agent.actions.cancelResume();
    await agent.actions.stop();
    try { agent.bot.pathfinder?.stop?.(); } catch { /* disconnected */ }
    try { agent.bot.pvp?.stop?.(); } catch { /* disconnected */ }
    try {
        const stoppingDig = agent.bot.stopDigging?.();
        if (stoppingDig?.catch) void stoppingDig.catch(() => {});
    } catch { /* disconnected */ }
    await agent.routeResponse(source,
        await ownerAck(agent, source, 'Stopped.', 'You just stopped all work because the owner said stop.'));
    return true;
}

// Persistent escort. The old version quit the moment the owner's entity unloaded
// (some servers track players only at short range) — the bot trailed behind, the owner left
// tracking range, followPlayer returned "no longer in range" and the whole duty ended
// as a success. Now the bot follows while it sees the owner, chases the owner's LAST
// KNOWN position when it loses sight, and waits there for the owner to reappear.
// It only ends on: !stop / a newer order (interrupt), the deadline (timed follows),
// the owner being offline for over a minute, or never sighting the owner at all.
async function followOwner(agent, source, minutes) {
    return await playerHelper.followPlayerPersistently(agent, source, 3, minutes);
}

async function collectWood(bot, count) {
    const logs = validBlocks(bot, LOG_BLOCKS);
    if (logs.length === 0) {
        skills.log(bot, 'I do not know any log block names for this server version.');
        return false;
    }
    await survival.maintainTools(bot);
    let remaining = count;
    let didWork = false;
    let searchMoves = 0;
    while (remaining > 0 && !bot.interrupt_code) {
        const nearest = world.getNearestBlocks(bot, logs, 96, 1)[0];
        if (!nearest) {
            // The town centre is usually deforested — fan outward a few times
            // before reporting failure; a grove often sits just past the walls.
            if (searchMoves >= 4) {
                skills.log(bot, 'No trees or logs within reach, even after searching around.');
                break;
            }
            searchMoves++;
            await skills.moveAway(bot, 24);
            continue;
        }
        const batch = Math.min(remaining, 8);
        const ok = await skills.collectBlock(bot, nearest.name, batch);
        didWork = ok || didWork;
        if (!ok) break;
        remaining -= batch;
    }
    return didWork;
}

function oreNames(bot, base) {
    const normal = base === 'lapis' ? 'lapis_ore' : `${base}_ore`;
    return validBlocks(bot, [normal, `deepslate_${normal}`]);
}

async function gatherResource(bot, resource, count) {
    if (resource === 'wood') return collectWood(bot, clamp(count, 1, 48));
    if (resource === 'food') return survival.secureFood(bot);
    if (resource === 'torches') return survival.makeTorches(bot, clamp(count, 1, 32), true);
    if (resource === 'resources') {
        let didWork = await collectWood(bot, Math.min(count, 12));
        if (!bot.interrupt_code) didWork = await skills.collectBlock(bot, 'stone', Math.min(count, 16)) || didWork;
        if (!bot.interrupt_code) {
            const coal = oreNames(bot, 'coal');
            if (coal.length > 0)
                didWork = await survival.mineOre(bot, coal, 4, true) || didWork;
        }
        if (!bot.interrupt_code)
            didWork = await survival.secureFood(bot) || didWork;
        return didWork;
    }

    const blockResource = {
        stone: 'stone',
        cobblestone: 'stone',
        dirt: 'dirt',
        sand: 'sand',
        gravel: 'gravel',
    }[resource];
    if (blockResource)
        return skills.collectBlock(bot, blockResource, clamp(count, 1, 64));

    const ore = oreNames(bot, resource);
    if (ore.length === 0) {
        skills.log(bot, `I do not know how to mine ${resource} on this server version.`);
        return false;
    }
    await survival.maintainTools(bot);
    return survival.mineOre(bot, ore, clamp(count, 1, 24), true);
}

function pitCenter(bot, ownerEntity) {
    const yaw = Number(ownerEntity.yaw ?? 0);
    let dx = Math.round(-Math.sin(yaw) * 4);
    let dz = Math.round(-Math.cos(yaw) * 4);
    if (dx === 0 && dz === 0) {
        const away = bot.entity.position.minus(ownerEntity.position);
        dx = clamp(Math.round(away.x), -4, 4) || 0;
        dz = clamp(Math.round(away.z), -4, 4) || 4;
    }
    return ownerEntity.position.floored().offset(dx, -1, dz);
}

function pitLayerPositions(center, width, length, y) {
    const x0 = center.x - Math.floor(width / 2);
    const z0 = center.z - Math.floor(length / 2);
    const positions = [];
    for (let x = x0; x < x0 + width; x++) {
        for (let z = z0; z < z0 + length; z++) {
            positions.push(new Vec3(x, y, z));
        }
    }
    return positions;
}

function canDigPitBlock(bot, block) {
    if (!block || AIR_LIKE.has(block.name) || LIQUIDS.has(block.name) || UNBREAKABLE.has(block.name)) return false;
    if (isPositionProtected(bot, block.position)) return false;
    return true;
}

async function digPitBlock(bot, pos) {
    if (bot.interrupt_code) return false;
    let block = bot.blockAt(pos, false);
    if (!canDigPitBlock(bot, block)) return false;

    if (bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 4.5) {
        const reached = await skills.goToPosition(bot, block.position.x, block.position.y + 1, block.position.z, 3);
        if (!reached || bot.interrupt_code) return false;
    }

    block = bot.blockAt(pos, false);
    if (!canDigPitBlock(bot, block)) return false;
    try {
        await bot.tool.equipForBlock(block);
    } catch (error) {
        skills.log(bot, `Could not equip a tool for ${block.name}: ${error.message}.`);
    }
    const itemId = bot.heldItem ? bot.heldItem.type : null;
    if (!block.canHarvest(itemId)) {
        skills.log(bot, `I cannot harvest ${block.name} with my current tool.`);
        return false;
    }
    await bot.dig(block);
    return true;
}

async function digPit(agent, source, dims) {
    const bot = agent.bot;
    const owner = bot.players[source]?.entity;
    if (!owner) {
        skills.log(bot, `I cannot see ${source}.`);
        return false;
    }
    await survival.maintainTools(bot);
    const center = pitCenter(bot, owner);
    let dug = 0;
    for (let layer = 0; layer < dims.depth && !bot.interrupt_code; layer++) {
        const y = center.y - layer;
        const positions = pitLayerPositions(center, dims.width, dims.length, y)
            .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
        for (const pos of positions) {
            if (bot.interrupt_code) break;
            try {
                if (await digPitBlock(bot, pos)) dug++;
            } catch (error) {
                skills.log(bot, `Skipped pit block at ${pos.x},${pos.y},${pos.z}: ${error.message}.`);
            }
        }
    }
    await skills.pickupNearbyItems(bot);
    skills.log(bot, `Dug ${dug} blocks for a ${dims.width}x${dims.length}x${dims.depth} pit.`);
    return dug > 0;
}

// Election for owner requests tied to the OWNER's position (chest jobs): the bot
// nearest to the owner wins; ties break on name. Each bot computes this from its own
// view of the world — entity positions are consistent enough for bots near the owner.
function isNearestAgentToOwner(agent, source) {
    const bot = agent.bot;
    const owner = bot.players[source]?.entity;
    if (!owner) return false; // I can't even see the owner — someone closer will act
    let names = [agent.name];
    try {
        names = serverProxy.getAgents()
            .map(entry => (typeof entry === 'string' ? entry : entry?.name))
            .filter(Boolean);
        if (!names.includes(agent.name)) names.push(agent.name);
    } catch { /* single-agent fallback */ }
    let winner = null;
    let best = Infinity;
    for (const name of names) {
        const entity = name === agent.name ? bot.entity : bot.players[name]?.entity;
        if (!entity) continue;
        const distance = entity.position.distanceTo(owner.position);
        if (distance < best - 0.01 || (Math.abs(distance - best) <= 0.01 && name < (winner ?? '￿'))) {
            best = distance;
            winner = name;
        }
    }
    return winner === agent.name;
}

function summarizeChestItems(items) {
    const counts = {};
    for (const item of items) counts[item.name] = (counts[item.name] ?? 0) + item.count;
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([name, count]) => `${count}x ${name}`)
        .join(', ');
}

// Walk to the chest closest to the OWNER (not to the bot), open it, and either report
// the contents or withdraw the requested items. The owner said they'd usually stand
// right next to the chest they mean — so proximity to the owner IS the chest selector.
async function chestDuty(agent, source, command) {
    const bot = agent.bot;
    const owner = bot.players[source]?.entity;
    if (!owner) {
        skills.log(bot, `I cannot see ${source}.`);
        return false;
    }
    const chestIds = mc.registryBlockIds(bot, ['chest', 'trapped_chest']);
    const found = bot.findBlocks({ point: owner.position, matching: chestIds, maxDistance: 10, count: 8 })
        .sort((a, b) => a.distanceTo(owner.position) - b.distanceTo(owner.position));
    if (found.length === 0) {
        await agent.routeResponse(source, 'I do not see a chest near you.');
        return false;
    }
    const chestPos = found[0];
    if (bot.entity.position.distanceTo(chestPos) > 3.5) {
        const reached = await skills.goToPosition(bot, chestPos.x, chestPos.y, chestPos.z, 2);
        if (!reached || bot.interrupt_code) {
            skills.log(bot, 'I could not reach the chest.');
            return false;
        }
    }
    const chestBlock = bot.blockAt(new Vec3(chestPos.x, chestPos.y, chestPos.z));
    if (!chestBlock) return false;
    const container = await bot.openContainer(chestBlock);
    try {
        const items = container.containerItems();
        if (command.type === 'chestView') {
            const summary = summarizeChestItems(items);
            await agent.routeResponse(source, summary
                ? `In this chest: ${summary}.`
                : 'This chest is empty.');
            return true;
        }
        const { matchedNames, label } = resolveChestMatches(items, command.itemQuery, command.tokens);
        if (matchedNames.length === 0) {
            const summary = summarizeChestItems(items);
            await agent.routeResponse(source, command.itemQuery || command.tokens?.length
                ? `No ${label} in this chest. It has: ${summary || 'nothing'}.`
                : (summary
                    ? `In this chest: ${summary}. Tell me what to take, e.g. "take iron from the chest".`
                    : 'This chest is empty.'));
            return false;
        }
        const wanted = new Set(matchedNames);
        let remaining = command.count ?? Infinity;
        let took = 0;
        for (const item of items) {
            if (!wanted.has(item.name)) continue;
            if (remaining <= 0 || bot.interrupt_code) break;
            const amount = Math.min(item.count, remaining);
            try {
                await container.withdraw(item.type, item.metadata ?? null, amount);
                took += amount;
                remaining -= amount;
            } catch { /* slot may have changed; try the next stack */ }
        }
        await agent.routeResponse(source, took > 0
            ? `Took ${took}x ${label} from the chest.`
            : `I could not take ${label} out of this chest.`);
        return took > 0;
    } finally {
        try { container.close(); } catch { /* already closed */ }
    }
}

export async function tryHandleOwnerCommand(agent, source, message, opts = {}) {
    if (!isOwner(source)) return false;

    // Supreme-commander strategic order: `!order <text>` binds the society planner
    // to the directive (executors get priority:"high"); `!order clear` lifts it;
    // bare `!order` reports the current one. State write is deduped in society.js so
    // ten bots hearing the same public line produce a single write + single reply.
    const orderMatch = String(message ?? '').match(/^\s*!(?:order|ukaz)\b\s*(.*)$/i);
    if (orderMatch) {
        const text = orderMatch[1].trim();
        const societyLib = await import('./library/society.js');
        if (!text || /^(show|status)$/i.test(text)) {
            let responder = agent.name;
            try {
                const { serverProxy } = await import('./mindserver_proxy.js');
                const names = serverProxy.getAgents()
                    .map(a => (typeof a === 'string' ? a : a?.name)).filter(Boolean).sort();
                responder = names[0] ?? agent.name;
            } catch { /* single-bot fallback */ }
            if (agent.name === responder) {
                const current = societyLib.getSocietyState()?.ownerDirective;
                await agent.routeResponse(source, current?.text
                    ? `Current kingdom directive: "${current.text}" (set by ${current.by}).`
                    : 'No kingdom directive is set right now.');
            }
            return true;
        }
        const clearing = /^(clear|off|reset|cancel)$/i.test(text);
        const changed = await societyLib.setOwnerDirective(agent.bot, clearing ? null : text, source);
        if (changed) {
            const { forceSocietyReplan } = await import('./library/planner.js');
            forceSocietyReplan(clearing ? 'directive cleared' : 'owner directive changed');
            await agent.routeResponse(source, clearing
                ? 'Kingdom directive cleared. Back to normal duties.'
                : `Understood, commander. Kingdom directive set: "${text}". Re-planning now.`);
        }
        return true;
    }

    // Supreme-commander mining order: `!mining [diamond|gold|lapis|iron|coal]` opens a
    // cooperative deep expedition right away and drafts a crew of 2-3 members. The
    // expedition file lock dedupes concurrent handling — only the creator replies.
    const miningMatch = String(message ?? '').match(/^\s*!mining\b\s*(\w*)/i);
    if (miningMatch) {
        const targetMap = {
            diamond: 'diamond', diamonds: 'diamond', dia: 'diamond', diamant: 'diamond', diamante: 'diamond',
            gold: 'gold', zlato: 'gold',
            lapis: 'lapis',
            iron: 'iron', zelezo: 'iron',
            coal: 'coal', premog: 'coal',
        };
        const target = targetMap[(miningMatch[1] || '').toLowerCase()] ?? null;
        const mining = await import('./library/mining.js');
        const result = await mining.startCommandedExpedition(agent, target);
        if (result.created) {
            try {
                const { forceSocietyReplan } = await import('./library/planner.js');
                forceSocietyReplan('owner mining expedition');
            } catch { /* planner optional */ }
            await agent.routeResponse(source,
                `Mining expedition launched: ${result.resource} at Y${result.targetY}. Crew: ${result.members.join(', ')}.`);
        } else if (agent.name === result.leader) {
            await agent.routeResponse(source,
                `An expedition for ${result.resource} is already underway (crew: ${result.members.join(', ')}).`);
        }
        return true;
    }

    const command = classifyOwnerCommand(message);
    if (!command) return false;

    if (command.type === 'stop')
        return stopForOwner(agent, source);

    if (['bring', 'carry', 'guard', 'helpBuild'].includes(command.type)) {
        const addressed = opts.whisper === true || messageAddressesAgent(agent, message);
        if (!addressed && !isNearestAgentToOwner(agent, source)) return true;

        if (command.type === 'bring') {
            const targetPlayer = command.targetPlayer ?? source;
            return runOwnerAction(
                agent,
                source,
                `bring:${command.item}`,
                `Bringing ${command.count}x ${command.item} to ${targetPlayer}.`,
                () => playerHelper.bringToPlayer(agent, targetPlayer, command.item, command.count),
                12,
                {
                    intent: 'bring',
                    target: {
                        type: 'player_delivery',
                        player: targetPlayer,
                        item: command.item,
                        count: command.count,
                    },
                    metadata: { text: command.text },
                },
            );
        }

        if (command.type === 'carry') {
            return runOwnerAction(
                agent,
                source,
                command.item ? `carry:${command.item}` : 'carry',
                command.item
                    ? `Carrying nearby chest items matching ${command.item} into storage.`
                    : 'Carrying nearby chest items into storage.',
                () => playerHelper.carryNearbyChest(agent, source, command.item),
                10,
                {
                    intent: 'carry',
                    target: {
                        type: 'nearby_chest_to_storage',
                        owner: source,
                        item: command.item ?? null,
                    },
                    metadata: { text: command.text },
                },
            );
        }

        if (command.type === 'guard') {
            const targetPlayer = command.targetPlayer ?? source;
            return runOwnerAction(
                agent,
                source,
                `guard:${targetPlayer}`,
                command.minutes === -1
                    ? `Guarding ${targetPlayer} until you tell me to stop.`
                    : `Guarding ${targetPlayer} for ${command.minutes} minutes.`,
                () => playerHelper.guardPlayer(agent, targetPlayer, command.minutes),
                command.minutes === -1 ? -1 : Math.max(1, command.minutes + 1),
                {
                    intent: 'guard',
                    target: {
                        type: 'player',
                        player: targetPlayer,
                    },
                    safetyPolicy: 'defensive_escort',
                    metadata: { text: command.text },
                },
            );
        }

        if (command.type === 'helpBuild') {
            const targetPlayer = command.targetPlayer ?? source;
            return runOwnerAction(
                agent,
                source,
                command.buildName ? `helpBuild:${command.buildName}` : 'helpBuild',
                command.buildName
                    ? `Helping ${targetPlayer} build ${command.buildName}.`
                    : `Helping ${targetPlayer} build.`,
                () => playerHelper.helpBuild(agent, targetPlayer, command.buildName),
                10,
                {
                    intent: 'helpBuild',
                    target: {
                        type: 'player_build_help',
                        player: targetPlayer,
                        schematic: command.buildName ?? null,
                    },
                    metadata: { text: command.text },
                },
            );
        }
    }

    if (command.type === 'chestView' || command.type === 'chestTake') {
        // The owner stands near the chest they mean; the bot NEAREST to the owner takes
        // the job so five bots don't mob one chest (others consume the command silently).
        // A bot addressed by name (or via whisper) was chosen by the owner — no election.
        const addressed = opts.whisper === true || messageAddressesAgent(agent, message);
        if (!addressed && !isNearestAgentToOwner(agent, source)) return true;
        const label = command.type === 'chestTake'
            ? `chest:${command.itemQuery ?? 'look'}`
            : 'chest:look';
        return runOwnerAction(
            agent,
            source,
            label,
            command.type === 'chestTake' && command.itemQuery
                ? `Checking the chest next to you for ${command.itemQuery}.`
                : 'Let me check the chest next to you.',
            () => chestDuty(agent, source, command),
            5,
            {
                intent: command.type,
                target: {
                    type: 'nearby_chest',
                    owner: source,
                    item: command.itemQuery ?? null,
                    count: command.count ?? null,
                },
                metadata: {
                    text: command.text,
                    tokens: command.tokens ?? [],
                },
            },
        );
    }

    if (command.type === 'combatDirective') {
        const messages = [];
        if (command.style) {
            const result = combat.setOwnerCombatStyle(agent, command.style, command.minutes);
            if (result)
                messages.push(result.reset
                    ? `combat style reset to ${result.style}`
                    : `combat style set to ${result.style}${result.minutes === -1 ? '' : ` for ${result.minutes} minutes`}`);
        }
        if (command.stance) {
            const result = combat.setOwnerCombatStance(agent, command.stance, command.minutes);
            if (result)
                messages.push(result.reset
                    ? 'combat stance reset to normal'
                    : `combat stance set to ${result.stance}${result.minutes === -1 ? '' : ` for ${result.minutes} minutes`}`);
        }
        await agent.routeResponse(source, messages.length ? messages.join('; ') + '.' : 'I could not understand that combat directive.');
        return true;
    }

    if (command.type === 'attack') {
        return runOwnerAction(
            agent,
            source,
            `attack:${command.target}`,
            `Attacking ${command.target}.`,
            () => combat.attackTargets(agent, command.target, command.count, { source }),
            5,
            {
                deterministicAck: true, // combat must not wait on a model line
                intent: 'attack',
                target: {
                    type: 'entity',
                    query: command.target,
                    count: command.count,
                },
                safetyPolicy: 'urgent_combat',
                metadata: { text: command.text },
            },
        );
    }

    if (command.type === 'follow') {
        return runOwnerAction(
            agent,
            source,
            'follow',
            command.minutes === -1
                ? `Following you until you tell me to stop, ${source}.`
                : `Following you for ${command.minutes} minutes, ${source}.`,
            () => followOwner(agent, source, command.minutes),
            command.minutes === -1 ? -1 : Math.max(1, command.minutes + 1),
            {
                intent: 'follow',
                target: {
                    type: 'player',
                    player: source,
                },
                metadata: { text: command.text },
            },
        );
    }

    if (command.type === 'digPit') {
        const { width, length, depth } = command.dims;
        return runOwnerAction(
            agent,
            source,
            'digPit',
            `Digging a ${width}x${length}x${depth} pit near you.`,
            () => digPit(agent, source, command.dims),
            15,
            {
                intent: 'dig',
                target: {
                    type: 'area_near_owner',
                    owner: source,
                    dimensions: command.dims,
                },
                safetyPolicy: 'allow_survival_interrupts',
                metadata: { text: command.text },
            },
        );
    }

    if (command.type === 'wood') {
        return runOwnerAction(
            agent,
            source,
            'collectWood',
            'Chopping wood for you.',
            () => collectWood(agent.bot, command.count),
            10,
            {
                intent: 'gather',
                target: {
                    type: 'resource',
                    resource: 'wood',
                    count: command.count,
                },
                metadata: { text: command.text },
            },
        );
    }

    if (command.type === 'gather') {
        return runOwnerAction(
            agent,
            source,
            `gather:${command.resource}`,
            `Gathering ${command.resource} for you.`,
            () => gatherResource(agent.bot, command.resource, command.count),
            15,
            {
                intent: 'gather',
                target: {
                    type: 'resource',
                    resource: command.resource,
                    count: command.count,
                },
                metadata: { text: command.text },
            },
        );
    }

    return false;
}
