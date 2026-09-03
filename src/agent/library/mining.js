// Autonomous cooperative deep-mining expeditions (deterministic, no LLM).
//
// When the settlement is short on a deep resource, any capable member opens an expedition:
// a single shared staircase entrance recorded in bots/mining-expedition.json. Up
// to PARTY_SIZE members rally at that entrance, descend the SAME staircase
// together (survival.descend digs a staircase, never straight down), take
// separate branches at the target depth, then follow their recorded trails back
// and stash the loot in public storage.
//
// Safety first (autonomous deep mining previously stranded bots): the staircase
// and per-bot trail provide a concrete walk-back route. A personal stall or low
// HP recalls that miner; a shared abort, timeout, or hurt teammate below ground
// recalls the whole party.
import { existsSync, readFileSync } from 'node:fs';
import pf from 'mineflayer-pathfinder';
import settings from '../../../settings.js';
import * as world from './world.js';
import * as skills from './skills.js';
import * as base from './base.js';
import * as storage from './storage.js';
import * as society from './society.js';
import * as survival from './survival.js';
import { withNamedLock } from './container_lock.js';
import { writeJsonAtomic } from '../../utils/atomic_json.js';

const FILE = './bots/mining-expedition.json';
const PARTY_SIZE = 3;
const EXPEDITION_TTL_MS = 10 * 60_000; // basic dig: hard cap so a stuck expedition always ends
const DEEP_TTL_MS = 18 * 60_000;       // deep digs are risky; prefer shorter repeatable sorties
const RETREAT_HEALTH = 12;             // own low HP -> personal retreat; hurt miner below -> team retreat
const ORE_QUOTA = 10;                  // target drops per member before that miner returns
const RALLY_RADIUS = 4;
const RALLY_REPATH_AFTER = 2;          // a bad surface entrance should not stall the whole party
const RALLY_ABORT_AFTER = 4;           // repeated bad entrances must end, not spin forever
const ENTRANCE_PATH_CHECK_MS = 400;
const MAX_ENTRANCE_PATH_CHECKS = 4;    // bound synchronous A* work while opening an expedition
const MAX_PROVISION_PASSES = 3;        // best-effort restock before a deep dig, then go anyway
const BASIC_MIN_HUNGER = 10;
const DEEP_MIN_HUNGER = 14;
const RETREAT_HUNGER = 6;
const DEEP_RETREAT_HUNGER = 9;
const PHASE_STALL_LIMIT = 2;
const BASIC_STRIP_STEPS = 16;
const DEEP_STRIP_STEPS = 14;

// Shortages in these resources may start an unscheduled expedition. Long treasure
// runs (gold/lapis/diamond) are kept to the periodic scheduler or !mining command.
const BASIC_EXPEDITION_RESOURCES = new Set(['iron', 'coal']);
// Long/well-provisioned treatment for ores below the ordinary iron/coal layers.
const DEEP_TARGETS = new Set(['diamond', 'redstone', 'gold', 'lapis']);
const IRON_PICK_RESOURCES = new Set(['diamond', 'redstone', 'gold']);
const RESOURCE_DROPS = {
    coal: ['coal'],
    iron: ['raw_iron', 'iron_ingot'],
    gold: ['raw_gold', 'gold_ingot'],
    lapis: ['lapis_lazuli'],
    redstone: ['redstone'],
    diamond: ['diamond'],
};
const DIAMOND_PICKS = ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];
const FOOD = ['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    'baked_potato', 'cooked_cod', 'cooked_salmon', 'cooked_rabbit'];
const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log'];
const invCount = (bot, names) => {
    const inv = world.getInventoryCounts(bot);
    return (Array.isArray(names) ? names : [names]).reduce((sum, name) => sum + (inv[name] ?? 0), 0);
};

function hasPickaxe(bot) {
    return bot.inventory.items().some(item => item.name.endsWith('_pickaxe'));
}

// Diamonds need an iron-or-better pickaxe; only then is a diamond run worth it.
function canMineDiamonds(bot) {
    return bot.inventory.items().some(item => DIAMOND_PICKS.includes(item.name));
}

function isDeepResource(resource) {
    return DEEP_TARGETS.has(resource);
}

function canMineResource(bot, resource = 'iron') {
    if (IRON_PICK_RESOURCES.has(resource)) return canMineDiamonds(bot);
    return hasPickaxe(bot);
}

function minHungerFor(resource = 'iron') {
    return isDeepResource(resource) ? DEEP_MIN_HUNGER : BASIC_MIN_HUNGER;
}

function canJoinExpedition(bot, resource = 'iron') {
    const deep = isDeepResource(resource);
    return Boolean(bot?.entity)
        && canMineResource(bot, resource)
        && (bot.food ?? 20) >= minHungerFor(resource)
        && (bot.health ?? 20) > RETREAT_HEALTH + (deep ? 4 : 2);
}

export function memberCanJoinExpedition(member, resource = 'iron') {
    const deep = isDeepResource(resource);
    const inventory = member.inventory ?? {};
    const hasRequiredPick = IRON_PICK_RESOURCES.has(resource)
        ? Number(inventory.bestPickaxeTier ?? 0) >= 3
        : (inventory.pickaxes ?? 0) > 0;
    return (member.health ?? 20) > RETREAT_HEALTH + (deep ? 4 : 2)
        && (member.hunger ?? member.food ?? 20) >= minHungerFor(resource)
        && hasRequiredPick;
}

function oreQuota(resource) {
    if (resource === 'diamond') return 3;   // rare; smaller hauls keep deep runs survivable
    if (resource === 'redstone') return 12;
    if (isDeepResource(resource)) return 8;
    return ORE_QUOTA;
}

export function expeditionProgress(exp) {
    return Object.values(exp?.progress ?? {})
        .reduce((sum, amount) => sum + Math.max(0, Number(amount) || 0), 0);
}

export function expeditionMemberQuota(exp) {
    const safeQuota = oreQuota(exp?.resource);
    const requested = Math.max(0, Number(exp?.requestedAmount) || 0);
    if (requested <= 0) return safeQuota;
    const members = Math.max(1, (exp?.members ?? []).length);
    const fairShare = Math.max(1, Math.ceil(requested / members));
    return Math.min(safeQuota, fairShare);
}

async function eatIfHungry(bot) {
    if ((bot.food ?? 20) > 18 || invCount(bot, FOOD) < 1) return;
    try { await bot.autoEat?.eat?.(); } catch { /* no edible food right now */ }
}

function notePhaseStall(bot, exp, phase) {
    const key = `${exp.startedAt}:${phase}`;
    if (bot._expeditionPhaseKey !== key) {
        bot._expeditionPhaseKey = key;
        bot._expeditionPhaseStalls = 0;
    }
    bot._expeditionPhaseStalls = (bot._expeditionPhaseStalls ?? 0) + 1;
    return bot._expeditionPhaseStalls;
}

function clearPhaseStall(bot, exp, phase) {
    bot._expeditionPhaseKey = `${exp.startedAt}:${phase}`;
    bot._expeditionPhaseStalls = 0;
}

function hashText(text) {
    let hash = 0;
    for (const char of String(text))
        hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    return hash;
}

function safeEntranceAt(bot, x, z, aroundY) {
    const safe = survival.findSafeSurfaceStand(bot, x, z, aroundY);
    return safe ? { x: safe.x, y: safe.y, z: safe.z } : null;
}

function entranceKey(pos) {
    return pos ? `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` : '';
}

function sameEntrance(a, b) {
    return entranceKey(a) === entranceKey(b);
}

function pathLooksReachable(bot, point) {
    if (!bot?.entity || !bot.pathfinder || !point) return false;
    if (Math.hypot(bot.entity.position.x - point.x, bot.entity.position.z - point.z) <= RALLY_RADIUS)
        return true;
    try {
        const movements = new pf.Movements(bot);
        movements.liquidCost = 20;
        movements.infiniteLiquidDropdownDistance = false;
        const goal = new pf.goals.GoalNear(point.x, point.y, point.z, 2);
        const path = bot.pathfinder.getPathTo(movements, goal, ENTRANCE_PATH_CHECK_MS);
        return path?.status === 'success';
    } catch {
        return false;
    }
}

function noteRallyFailure(bot, exp) {
    // Include the entrance in the key. When one member reroutes the rally point,
    // every other process must start a fresh failure count for that new route.
    const rallyKey = `${exp.startedAt}:${entranceKey(exp.entrance)}`;
    if (bot._expeditionRallyFor !== rallyKey) {
        bot._expeditionRallyFor = rallyKey;
        bot._expeditionRallyFailures = 0;
    }
    bot._expeditionRallyFailures = (bot._expeditionRallyFailures ?? 0) + 1;
    return bot._expeditionRallyFailures;
}

function clearRallyFailures(bot, exp) {
    bot._expeditionRallyFor = `${exp.startedAt}:${entranceKey(exp.entrance)}`;
    bot._expeditionRallyFailures = 0;
}

// Rallying is a surface-only phase. The old target-depth check stayed true for
// almost the entire descent, so after every 12-step batch a miner was sent back
// to the entrance because it had naturally moved more than four blocks away.
// That produced an entrance -> shaft -> entrance loop with no useful mining.
export function shouldRallyAtEntrance(position, entrance, radius = RALLY_RADIUS) {
    if (!position || !entrance) return false;
    const awayHorizontally = Math.hypot(position.x - entrance.x, position.z - entrance.z) > radius;
    const stillOnSurfaceApproach = position.y >= Number(entrance.y) - 3;
    return awayHorizontally && stillOnSurfaceApproach;
}

const BRANCH_DIRECTIONS = [
    { x: 1, z: 0 },
    { x: 0, z: 1 },
    { x: -1, z: 0 },
    { x: 0, z: -1 },
];

// Everyone shares the staircase, then takes a separate cardinal branch at ore
// depth. This prevents three entities from body-blocking one another in a 1x2
// tunnel while keeping the common staircase and recorded return trails intact.
export function expeditionBranchDirection(exp, memberName, reroute = 0) {
    const memberIndex = (exp?.members ?? []).indexOf(memberName);
    const baseIndex = memberIndex >= 0
        ? memberIndex
        : hashText(`${exp?.startedAt ?? 0}:${memberName}`);
    const index = baseIndex + Math.max(0, Number(reroute) || 0);
    return BRANCH_DIRECTIONS[index % BRANCH_DIRECTIONS.length];
}

function readExpedition() {
    try {
        if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, 'utf8'));
    } catch { /* missing or corrupt → treat as none */ }
    return { active: false };
}

function writeExpedition(state) {
    writeJsonAtomic(FILE, state);
}

function isStale(exp) {
    const ttl = exp?.ttlMs ?? EXPEDITION_TTL_MS; // deep digs carry a longer cap
    return !exp?.active || !exp.startedAt || Date.now() - exp.startedAt > ttl;
}

// Atomic read-modify-write across processes.
async function mutate(bot, fn) {
    const result = await withNamedLock(bot, 'mining-expedition', () => {
        const next = fn(readExpedition());
        if (next) writeExpedition(next);
        return next ?? readExpedition();
    }, 5000);
    return result.locked ? result.value : readExpedition();
}

// A single shared entrance well away from base (so survival.descend won't relocate
// each bot by its own name-angle — everyone digs the SAME +x staircase from here).
function expeditionEntrance(bot, resource = 'iron', opts = {}) {
    const center = storage.getPublicStorage(bot) ?? base.getBase(bot) ?? bot.entity.position;
    const radius = Number(center.radius) || 10;
    const baseAngle = (hashText(`${resource}:${Math.floor(center.x)}:${Math.floor(center.z)}`) % 360) * Math.PI / 180;
    const aroundY = Number(center.y ?? bot.entity.position.y);
    const avoid = new Set((opts.avoid ?? []).map(entranceKey));
    let fallback = null;
    let pathChecks = 0;
    for (const distance of [radius + 48, radius + 64, radius + 84, radius + 108]) {
        for (let attempt = 0; attempt < 20; attempt++) {
            const angle = baseAngle + attempt * (Math.PI * 2 / 20);
            const x = Math.floor(center.x + Math.cos(angle) * distance);
            const z = Math.floor(center.z + Math.sin(angle) * distance);
            const safe = safeEntranceAt(bot, x, z, aroundY);
            if (!safe || avoid.has(entranceKey(safe))) continue;
            fallback ??= safe;
            if (pathChecks < MAX_ENTRANCE_PATH_CHECKS) {
                pathChecks++;
                if (pathLooksReachable(bot, safe)) return safe;
            }
            // Surface scanning checks hundreds of blocks per candidate. Once a
            // bounded number of viable candidates has been assessed, use the
            // first safe fallback and let the normal rally reroute handle rare
            // dynamic obstructions instead of blocking every bot's event loop.
            if (pathChecks >= MAX_ENTRANCE_PATH_CHECKS) return fallback;
        }
    }
    if (fallback) return fallback;
    const local = safeEntranceAt(
        bot,
        Math.floor(bot.entity.position.x),
        Math.floor(bot.entity.position.z),
        aroundY,
    );
    return local && !avoid.has(entranceKey(local)) ? local : null;
}

// Which deep treasure the settlement is shortest on. Diamonds first (when this bot
// can even mine them), then gold, then lapis; thresholds scale with member count.
function pickDeepTarget(bot) {
    if (!canMineDiamonds(bot)) return null;
    const members = society.activeMembers(bot);
    const sum = key => members.reduce((total, member) => total + (member.inventory?.[key] ?? 0), 0);
    if (sum('diamonds') < Math.max(6, members.length * 3)) return 'diamond';
    if (sum('gold') < Math.max(8, members.length * 4)) return 'gold';
    if (sum('lapis') < Math.max(12, members.length * 6)) return 'lapis';
    return 'diamond';
}

function expeditionPartySize() {
    return Math.max(2, Math.min(4, Number(settings.mining_expedition_party) || PARTY_SIZE));
}

// The periodic "every few in-game days" trigger: has enough time passed since the
// last expedition START (persisted in the expedition file across runs)?
export function expeditionDue(exp = readExpedition()) {
    const intervalMs = Math.max(10, Number(settings.mining_expedition_interval_minutes) || 75) * 60_000;
    return Date.now() - (exp.lastStartedAt ?? 0) > intervalMs;
}

// For the planner: deep-ore stockpile assignments make sense while a party is out
// or one is about to start; otherwise deep resources come from expeditions anyway.
export function expeditionOpenOrDue() {
    const exp = readExpedition();
    return !isStale(exp) || expeditionDue(exp);
}

function createExpedition(agent, resourceOverride = null, opts = {}) {
    const bot = agent.bot;
    let resource = resourceOverride;
    if (!resource) {
        const need = society.getResourceNeed(bot);
        const needsBasic = BASIC_EXPEDITION_RESOURCES.has(need.resource) && need.ratio < 1;
        if (needsBasic && !opts.preferDeep) resource = need.resource; // settlement short on a basic
        else resource = pickDeepTarget(bot);                          // scheduled/commanded → treasure run
    }
    const deep = isDeepResource(resource);
    if (!resource || !canJoinExpedition(bot, resource)) {
        skills.log(bot, 'Mining expedition: not enough food/health/tools for a safe run yet.');
        return null;
    }
    const requestedAmount = Math.max(0, Number(opts.requestedAmount) || 0);
    const requests = opts.requestedBy && requestedAmount > 0
        ? { [opts.requestedBy]: { amount: requestedAmount, requestedAt: Date.now() } }
        : {};
    const common = {
        active: true,
        leader: agent.name,
        resource,
        deep,
        targetY: survival.preferredOreY(resource, bot),
        members: [agent.name],
        partySize: expeditionPartySize(),
        commanded: opts.commanded === true,
        requestedBy: opts.requestedBy ?? null,
        requestedAmount,
        requests,
        progress: {},
        startedAt: Date.now(),
        lastStartedAt: Date.now(),
        abort: false,
    };
    const entrance = expeditionEntrance(bot, resource);
    if (!entrance) {
        skills.log(bot, 'Mining expedition: no safe surface entrance found, trying again later.');
        return { ...common, entrance: null, ttlMs: 60_000, abort: true };
    }
    return { ...common, entrance, ttlMs: deep ? DEEP_TTL_MS : EXPEDITION_TTL_MS };
}

// Progression and owner-independent resource work both enter through this one
// state machine. A request starts an expedition only when no live run exists;
// subsequent bots join it through the normal planExpeditionAction path.
export async function requestResourceExpedition(agent, resource, amount = 1) {
    const bot = agent?.bot;
    if (!bot?.entity || !RESOURCE_DROPS[resource])
        return { active: false, created: false, resource };

    let created = false;
    const exp = await mutate(bot, current => {
        if (!isStale(current)) {
            if (current.resource !== resource) return current;
            current.requests ??= {};
            const previous = Math.max(0, Number(current.requests[agent.name]?.amount) || 0);
            current.requests[agent.name] = {
                amount: Math.max(previous, Math.max(1, Number(amount) || 1)),
                requestedAt: Date.now(),
            };
            current.requestedAmount = Object.values(current.requests)
                .reduce((sum, request) => sum + Math.max(0, Number(request?.amount) || 0), 0);
            return current;
        }
        const next = createExpedition(agent, resource, {
            requestedBy: agent.name,
            requestedAmount: amount,
        });
        if (next?.active && !next.abort) created = true;
        return next ?? current;
    });
    const active = !isStale(exp) && exp.abort !== true && exp.resource === resource;
    return {
        active,
        created,
        resource: exp.resource ?? resource,
        targetY: exp.targetY ?? null,
        members: exp.members ?? [],
        requestedAmount: Number(exp.requestedAmount ?? 0),
        progress: expeditionProgress(exp),
    };
}

// Before a long deep dig, stock up so it isn't cut short and darkness/mobs can't
// interfere: extra wood (crafting/repairs), food, a crafting table, and plenty of
// torches to light the tunnels. Pulls from public storage first, else crafts.
async function provisionDeep(bot) {
    if (invCount(bot, LOGS) < 16) { try { await storage.takeAnyPublic(bot, LOGS, 16); } catch { /* none shared */ } }
    if (invCount(bot, FOOD) < 8) { try { await storage.takeAnyPublic(bot, FOOD, 8); } catch { /* none shared */ } }
    await eatIfHungry(bot);
    if (invCount(bot, 'crafting_table') < 1) {
        try {
            if (!await storage.takeNeededPublic(bot, { crafting_table: 1 }))
                await skills.craftRecipe(bot, 'crafting_table', 1); // craftRecipe makes planks from the logs above
        } catch { /* no table / planks */ }
    }
    if (invCount(bot, 'torch') < 32) {
        try { await storage.takeNeededPublic(bot, { torch: 32 }); } catch { /* none shared */ }
        if (invCount(bot, 'torch') < 16) { try { await survival.makeTorches(bot, 24, true); } catch { /* no coal */ } }
    }
}

function needsProvision(bot) {
    return (bot.food ?? 20) < DEEP_MIN_HUNGER
        || invCount(bot, LOGS) < 16 || invCount(bot, FOOD) < 8
        || invCount(bot, 'crafting_table') < 1 || invCount(bot, 'torch') < 24;
}

async function retreat(agent, exp) {
    const bot = agent.bot;
    let reachedEntrance = false;
    skills.log(bot, 'Mining expedition: returning to the surface.');
    if (exp.entrance) {
        // First retrace the actual tunnel/staircase waypoints. A single global A*
        // request frequently failed on long shafts even though each local segment
        // was walkable.
        try { reachedEntrance = await survival.returnAlongMiningTrail(bot, exp.entrance); } catch { /* fallback below */ }
        if (!reachedEntrance) {
            try { reachedEntrance = await skills.goToPosition(bot, exp.entrance.x, exp.entrance.y, exp.entrance.z, 2); } catch { /* recovery below */ }
        }
    }
    let recovered = reachedEntrance;
    if (!reachedEntrance && (survival.isBelowSettlement(bot, 6) || survival.isOpenCaveTrap(bot)))
        recovered = await survival.recoverFromMiningTrap(bot);
    // A successfully reached entrance is authoritative: it was selected as a
    // standable surface cell. A valley entrance can legitimately sit >6 blocks
    // below the town center, so settlement-relative Y alone must not reclassify
    // that success as an underground failure.
    const stillUnderground = !recovered
        && (survival.isBelowSettlement(bot, 6) || survival.isOpenCaveTrap(bot));
    if (stillUnderground) {
        // Clearing the expedition flag lets brain.js run escapeToSurface on the
        // very next decision. Previously retreat removed the member and then
        // tried to stash from underground, leaving it idle until a watchdog fired.
        bot._miningRecoveryRequested = true;
        skills.log(bot, 'Mining expedition: return path failed; keeping the loot and forcing surface recovery.');
    } else if (recovered) {
        try { await base.stash(bot); } catch { /* storage may be unreachable; keep the loot */ }
    }
    await mutate(bot, e => {
        e.members = (e.members ?? []).filter(name => name !== agent.name);
        if (e.members.length === 0) e.active = false;
        return e;
    });
    bot._miningExpeditionActive = null;
    bot._expeditionOreBaseline = null;
    bot._expeditionBranchFor = null;
    bot._expeditionBranchReroutes = 0;
    survival.clearMiningTrail(bot);
    return true;
}

async function rerouteEntrance(agent, exp) {
    const bot = agent.bot;
    const current = exp.entrance;
    const replacement = expeditionEntrance(bot, exp.resource, { avoid: current ? [current] : [] });
    if (!replacement || sameEntrance(replacement, current)) return false;
    const updated = await mutate(bot, e => {
        if (e.startedAt !== exp.startedAt || isStale(e)) return e;
        if (!sameEntrance(e.entrance, current)) return e;
        e.entrance = replacement;
        e.reroutedAt = Date.now();
        e.reroutedBy = agent.name;
        return e;
    });
    if (!sameEntrance(updated.entrance, replacement)) return false;
    clearRallyFailures(bot, updated);
    skills.log(bot, `Mining expedition: rally point moved to ${replacement.x}, ${replacement.y}, ${replacement.z}.`);
    return true;
}

async function participate(agent, exp) {
    const bot = agent.bot;
    if (!bot.entity) return false;
    bot._miningExpeditionActive = exp.startedAt;
    survival.beginMiningTrail(bot, exp.startedAt);
    const pos = bot.entity.position;
    const entrance = exp.entrance;
    const targetY = exp.targetY ?? survival.preferredOreY(exp.resource, bot);
    const entranceY = Number(entrance?.y ?? pos.y);
    const drops = RESOURCE_DROPS[exp.resource] ?? RESOURCE_DROPS.iron;
    const carriedDrops = invCount(bot, drops);
    if (bot._expeditionOreBaseline?.startedAt !== exp.startedAt) {
        bot._expeditionOreBaseline = { startedAt: exp.startedAt, count: carriedDrops };
    }
    if (bot._expeditionBranchFor !== exp.startedAt) {
        bot._expeditionBranchFor = exp.startedAt;
        bot._expeditionBranchReroutes = 0;
    }

    if (survival.isOpenCaveTrap(bot)) {
        // Personal emergency: recover and bow out ALONE. The rest of the party still
        // has the shared staircase — aborting everyone for one trapped member used
        // to cancel every expedition within minutes.
        await survival.recoverFromMiningTrap(bot);
        return await retreat(agent, exp);
    }

    // SAFETY: the whole party bails out when someone called it off or the run timed
    // out. A hurt member retreats alone; only a teammate hurt DOWN THE SHAFT (below
    // the entrance) recalls the entire party — a drafted bot that is limping around
    // the base topside must not cancel the dig for the healthy diggers.
    if (exp.abort || isStale(exp)) return await retreat(agent, exp);
    if (exp.targetMet === true
        || (Number(exp.requestedAmount ?? 0) > 0
            && expeditionProgress(exp) >= Number(exp.requestedAmount))) {
        skills.log(bot, 'Mining expedition: the shared requested amount is complete; returning with the haul.');
        return await retreat(agent, exp);
    }
    if (bot.health <= RETREAT_HEALTH) return await retreat(agent, exp);
    if (!canMineResource(bot, exp.resource)) {
        skills.log(bot, 'Mining expedition: I do not have the right pickaxe, heading back.');
        return await retreat(agent, exp);
    }
    const hungerLimit = exp.deep ? DEEP_RETREAT_HUNGER : RETREAT_HUNGER;
    if ((bot.food ?? 20) <= hungerLimit) {
        await eatIfHungry(bot);
        if ((bot.food ?? 20) <= hungerLimit && exp.deep && pos.y > targetY + 2) {
            await provisionDeep(bot);
            await eatIfHungry(bot);
        }
        if ((bot.food ?? 20) <= hungerLimit) {
            skills.log(bot, 'Mining expedition: low food, heading back before this turns ugly.');
            return await retreat(agent, exp);
        }
    }
    const team = society.activeMembers(bot).filter(member => (exp.members ?? []).includes(member.name));
    const teammateHurtBelow = team.some(member => (member.health ?? 20) <= RETREAT_HEALTH
        && Number(member.position?.y ?? entranceY) < entranceY - 4);
    if (teammateHurtBelow) {
        await mutate(bot, e => { e.abort = true; return e; });
        return await retreat(agent, exp);
    }

    // DEEP digs: stock up FIRST (at storage, before heading down) so the long run
    // isn't cut short and well-lit tunnels keep darkness/mobs from interfering.
    // Best-effort and capped — if supplies aren't available, go anyway.
    if (exp.deep && pos.y > targetY + 2 && needsProvision(bot)) {
        if (bot._provisionFor !== exp.startedAt) { bot._provisionPasses = 0; bot._provisionFor = exp.startedAt; }
        if ((bot._provisionPasses ?? 0) < MAX_PROVISION_PASSES) {
            bot._provisionPasses = (bot._provisionPasses ?? 0) + 1;
            skills.log(bot, 'Deep expedition: stocking up (wood, food, crafting table, torches).');
            await provisionDeep(bot);
            return true;
        }
    }

    // RALLY: reach the shared entrance before digging so the party stays on ONE staircase.
    if (shouldRallyAtEntrance(pos, entrance)) {
        skills.log(bot, 'Mining expedition: heading to the rally point.');
        const reached = await skills.goToPosition(bot, entrance.x, entrance.y, entrance.z, 2);
        if (reached) {
            clearRallyFailures(bot, exp);
            return true;
        }
        const failures = noteRallyFailure(bot, exp);
        if (failures >= RALLY_REPATH_AFTER && await rerouteEntrance(agent, exp))
            return true;
        if (failures >= RALLY_ABORT_AFTER) {
            skills.log(bot, 'Mining expedition: rally point remains unreachable, aborting this run.');
            await mutate(bot, e => { e.abort = true; return e; });
            return await retreat(agent, exp);
        }
        return false;
    }

    // DESCEND the shared staircase to the target depth (lit, with lava/HP guards).
    if (pos.y > targetY + 2) {
        try { await survival.makeTorches(bot, 6, true); } catch { /* mine in the dark if we must */ }
        const beforeY = bot.entity.position.y;
        const descended = await survival.descend(bot, 12);
        const progressed = descended && bot.entity.position.y < beforeY - 0.5;
        if (progressed) {
            clearPhaseStall(bot, exp, 'descend');
            return true;
        }
        const stalls = notePhaseStall(bot, exp, 'descend');
        if (stalls >= PHASE_STALL_LIMIT) {
            if (bot.entity.position.y >= entranceY - 3 && await rerouteEntrance(agent, exp))
                return true;
            skills.log(bot, 'Mining expedition: my descent stalled; I am leaving without cancelling the crew.');
            return await retreat(agent, exp);
        }
        return true;
    }

    // MINE at depth. Once I have my share, return alone while the other branches
    // keep working toward their own quotas.
    const before = bot.entity.position.clone();
    const branch = expeditionBranchDirection(exp, agent.name, bot._expeditionBranchReroutes);
    const mined = await survival.stripMine(
        bot,
        exp.deep ? DEEP_STRIP_STEPS : BASIC_STRIP_STEPS,
        branch,
    );
    if (mined && bot.entity.position.distanceTo(before) > 1) clearPhaseStall(bot, exp, 'mine');
    else if (notePhaseStall(bot, exp, 'mine') >= PHASE_STALL_LIMIT) {
        if ((bot._expeditionBranchReroutes ?? 0) < BRANCH_DIRECTIONS.length - 1) {
            bot._expeditionBranchReroutes = (bot._expeditionBranchReroutes ?? 0) + 1;
            clearPhaseStall(bot, exp, 'mine');
            skills.log(bot, 'Mining expedition: branch blocked; rotating to another tunnel direction.');
            return true;
        }
        skills.log(bot, 'Mining expedition: all my branches stalled; I am leaving without cancelling the crew.');
        return await retreat(agent, exp);
    }
    const gainedDrops = Math.max(0, invCount(bot, drops) - (bot._expeditionOreBaseline?.count ?? 0));
    exp = await mutate(bot, current => {
        if (current.startedAt !== exp.startedAt || isStale(current)) return current;
        current.progress ??= {};
        current.progress[agent.name] = Math.max(
            Number(current.progress[agent.name] ?? 0),
            gainedDrops,
        );
        if (Number(current.requestedAmount ?? 0) > 0
            && expeditionProgress(current) >= Number(current.requestedAmount)) {
            current.targetMet = true;
            current.targetMetAt = Date.now();
        }
        return current;
    });
    if (exp.targetMet === true) {
        skills.log(bot, `Mining expedition: shared target ${expeditionProgress(exp)}/${exp.requestedAmount} reached.`);
        return await retreat(agent, exp);
    }
    if (gainedDrops >= expeditionMemberQuota(exp)) {
        skills.log(bot, 'Mining expedition: my ore quota is complete; the rest of the crew can finish theirs.');
        return await retreat(agent, exp);
    }
    return true;
}

// One step of the expedition: create one if warranted, join an open one, or continue
// the one I'm on. Returns true if it did expedition work.
export async function runExpeditionStep(agent) {
    const bot = agent.bot;
    if (!bot?.entity) return false;
    let exp = readExpedition();

    if (isStale(exp))
        exp = await mutate(bot, e => (isStale(e)
            ? createExpedition(agent, null, { preferDeep: expeditionDue(e) })
            : e));
    if (isStale(exp)) return false;

    const partySize = exp.partySize ?? PARTY_SIZE;
    if (!(exp.members ?? []).includes(agent.name)) {
        if ((exp.members?.length ?? 0) >= partySize) return false; // full, not my expedition
        if (!canJoinExpedition(bot, exp.resource)) return false;
        exp = await mutate(bot, e => {
            if (!isStale(e) && (e.members?.length ?? 0) < (e.partySize ?? PARTY_SIZE)
                && !(e.members ?? []).includes(agent.name))
                e.members = [...(e.members ?? []), agent.name];
            return e;
        });
        if (!(exp.members ?? []).includes(agent.name)) return false;
    }
    return await participate(agent, exp);
}

// Owner `!mining` / society trigger: open an expedition NOW (unless one is already
// running) and draft a crew by name so 2-3 bots head down together.
export async function startCommandedExpedition(agent, resourceOverride = null) {
    const bot = agent.bot;
    let created = false;
    let exp = await mutate(bot, e => {
        if (!isStale(e)) return e;
        if (resourceOverride && !canJoinExpedition(bot, resourceOverride)) return e;
        created = true;
        const next = createExpedition(agent, resourceOverride, { commanded: true, preferDeep: true });
        if (!next) created = false;
        return next ?? e;
    });
    if (created && exp.entrance) {
        // Draft the FIT members (healthiest first), never the half-dead: a drafted
        // 1-HP bot used to hit the party HP guard and instantly abort the whole dig.
        const crewmates = society.activeMembers(bot)
            .filter(member => member.name !== agent.name
                && memberCanJoinExpedition(member, exp.resource))
            .sort((a, b) => (((b.health ?? 20) + (b.hunger ?? b.food ?? 20))
                - ((a.health ?? 20) + (a.hunger ?? a.food ?? 20))) || a.name.localeCompare(b.name))
            .map(member => member.name);
        const crew = [agent.name, ...crewmates.slice(0, Math.max(1, (exp.partySize ?? PARTY_SIZE) - 1))];
        exp = await mutate(bot, e => {
            if (e.startedAt === exp.startedAt) e.members = crew;
            return e;
        });
        void society.recordEvent(bot, 'expedition', agent.name,
            `${agent.name} launched a mining expedition for ${exp.resource} (crew: ${crew.join(', ')}).`).catch(() => {});
    }
    return {
        created,
        resource: exp.resource,
        targetY: exp.targetY,
        members: exp.members ?? [],
        leader: exp.leader,
    };
}

// Cheap synchronous check for brain.js chooseAction: should this bot be doing
// expedition work right now? Members always continue, and any capable member may
// join or start a dig when the settlement needs ore or the periodic deep run is due.
export function planExpeditionAction(agent, opts = {}) {
    if (settings.kingdom_mode === false) return null;
    const bot = agent.bot;
    const action = { name: 'miningExpedition', timeout: 6, fn: async () => await runExpeditionStep(agent) };
    const exp = readExpedition();
    const active = !isStale(exp);
    const isMember = active && (exp.members ?? []).includes(agent.name);
    // Reconcile a possibly-leaked mid-expedition flag: participate() sets
    // bot._miningExpeditionActive and only retreat() clears it, so an abnormal exit
    // (a thrown skill, the party going stale) can leave it pinned. While pinned it
    // SUPPRESSES stranded-underground surface recovery (brain.js) and stockpile
    // smelting — a stuck-underground risk. If this bot is no longer a member of a live
    // expedition, the flag must be false.
    if (bot._miningExpeditionActive && !isMember) bot._miningExpeditionActive = null;
    if (isMember) return action;

    const canJoin = active && !exp.abort && canJoinExpedition(bot, exp.resource)
        && (exp.members?.length ?? 0) < (exp.partySize ?? PARTY_SIZE);
    if (canJoin) return action;
    if (active) return null;
    if (opts.startIfDue === false) return null;

    const need = society.getResourceNeed(bot);
    const needsBasic = BASIC_EXPEDITION_RESOURCES.has(need.resource) && need.ratio < 1;
    if (needsBasic && canJoinExpedition(bot, need.resource)) return action;
    if (expeditionDue(exp)) {
        const target = pickDeepTarget(bot);
        if (target && canJoinExpedition(bot, target)) return action;
    }
    return null;
}
