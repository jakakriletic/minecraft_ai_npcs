// Cross-process society state for the Mindcraft kingdom. This is intentionally
// deterministic: the local/cloud models add flavor and long-range direction, while
// membership, supplies and shared experience live in one locked JSON file.
//
// ALTERA / PIANO ROADMAP: this file holds the shared "society" half of the Agent State.
// Culture/norm transmission (Phase 6) extends kingdom.json here. See ../../../ALTERA_PLAN.md.
import { existsSync, readFileSync } from 'fs';
import * as world from './world.js';
import * as base from './base.js';
import * as storage from './storage.js';
import * as progression from './progression.js';
import * as skills from './skills.js';
import { getProtectedBuilds } from './resource_guard.js';
import { withNamedLock } from './container_lock.js';
import { serverProxy } from '../mindserver_proxy.js';
import settings from '../../../settings.js';
import * as mc from '../../utils/mcdata.js';
import { writeJsonAtomic } from '../../utils/atomic_json.js';

const STATE_FILE = './bots/kingdom.json';
const ROLES = ['healer', 'magician', 'member'];
const ROLE_LABELS = {
    healer: 'healer',
    magician: 'magician',
    member: 'member',
};
const SPECIALTY_LABELS = {
    enchanter: 'enchanter',
};
const ROLE_COLORS = {
    healer: 'light_purple',
    magician: 'dark_purple',
    member: 'white',
    enchanter: 'light_purple',
};
const FOOD = new Set([
    'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    'baked_potato', 'apple', 'carrot', 'golden_carrot', 'cooked_cod',
    'cooked_salmon', 'cooked_rabbit',
]);
const LOGS = new Set([
    'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log',
    'dark_oak_log', 'cherry_log', 'mangrove_log',
]);
const PICKAXE_TIER = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 };
const cache = { checkedAt: 0, state: null };

function emptyState() {
    return {
        version: 1,
        name: settings.kingdom_name ?? 'Kingdom',
        center: null,
        members: {},
        knownBiomes: [],
        events: [],
        transfers: {},
        metrics: { buildingCount: 0, roadCount: 0 },
        lastSocialAt: 0,
        updatedAt: null,
    };
}

function readState(force = false) {
    if (!force && cache.state && Date.now() - cache.checkedAt < 1500)
        return cache.state;
    let state = emptyState();
    try {
        if (existsSync(STATE_FILE))
            state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) };
    } catch (error) {
        console.warn(`[kingdom] could not read state: ${error.message}`);
    }
    state.members = state.members && typeof state.members === 'object' ? state.members : {};
    state.events = Array.isArray(state.events) ? state.events : [];
    state.knownBiomes = Array.isArray(state.knownBiomes) ? state.knownBiomes : [];
    state.transfers = state.transfers && typeof state.transfers === 'object' ? state.transfers : {};
    state.metrics = { buildingCount: 0, roadCount: 0, ...(state.metrics ?? {}) };
    cache.state = state;
    cache.checkedAt = Date.now();
    return state;
}

function writeState(state) {
    state.updatedAt = new Date().toISOString();
    writeJsonAtomic(STATE_FILE, state);
    cache.state = state;
    cache.checkedAt = Date.now();
}

function activeAgentNames(agent) {
    let names = [];
    try {
        names = serverProxy.getAgents()
            .filter(entry => entry?.in_game !== false)
            .map(entry => typeof entry === 'string' ? entry : entry?.name)
            .filter(Boolean);
    } catch { /* mindserver may still be connecting */ }
    if (!names.includes(agent.name)) names.push(agent.name);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

export function assignRoleNames(activeNames, preferences = {}) {
    const names = [...new Set(activeNames.filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    const assignments = Object.fromEntries(names.map(name => [name, 'member']));
    const available = new Set(names);
    const preferred = {
        healer: preferences.healer ?? settings.kingdom_healer_name,
        magician: preferences.magician ?? settings.kingdom_magician_name,
    };

    // Claim every online preferred NPC first. A missing healer must not steal the
    // configured magician (or vice versa) before fallback assignment runs.
    const unfilledRoles = [];
    for (const role of ['healer', 'magician']) {
        const wanted = names.find(name => name.toLowerCase() === String(preferred[role] ?? '').toLowerCase());
        if (wanted && available.has(wanted)) {
            assignments[wanted] = role;
            available.delete(wanted);
        } else {
            unfilledRoles.push(role);
        }
    }
    for (const role of unfilledRoles) {
        const selected = names.find(name => available.has(name));
        if (!selected) break;
        assignments[selected] = role;
        available.delete(selected);
    }
    return assignments;
}

function assignRoles(state, activeNames) {
    const assignments = assignRoleNames(activeNames);
    for (const name of activeNames) {
        state.members[name] ??= {};
        state.members[name].role = assignments[name] ?? 'member';
    }

    for (const name of activeNames)
        state.members[name].specialty = null;
}

function summarizeInventory(bot) {
    const counts = world.getInventoryCounts(bot);
    const sum = predicate => Object.entries(counts)
        .filter(([name]) => predicate(name))
        .reduce((total, [, amount]) => total + amount, 0);
    const pickaxeNames = Object.keys(counts)
        .filter(name => name.endsWith('_pickaxe') && (counts[name] ?? 0) > 0);
    const bestPickaxeTier = pickaxeNames.reduce((best, name) =>
        Math.max(best, PICKAXE_TIER[name.split('_')[0]] ?? 0), 0);
    return {
        food: sum(name => FOOD.has(name)),
        wood: sum(name => LOGS.has(name)),
        stone: counts.cobblestone ?? 0,
        iron: (counts.iron_ingot ?? 0) + (counts.raw_iron ?? 0),
        coal: (counts.coal ?? 0) + (counts.charcoal ?? 0),
        gold: (counts.gold_ingot ?? 0) + (counts.raw_gold ?? 0),
        lapis: counts.lapis_lazuli ?? 0,
        diamonds: counts.diamond ?? 0,
        torches: counts.torch ?? 0,
        pickaxes: sum(name => name.endsWith('_pickaxe')),
        bestPickaxeTier,
        axes: sum(name => name.endsWith('_axe') && !name.endsWith('_pickaxe')),
        swords: sum(name => name.endsWith('_sword')),
        emptySlots: bot.inventory.emptySlotCount(),
    };
}

function addEventUnlocked(state, type, actor, text, metadata = {}) {
    const previous = state.events.at(-1);
    if (previous?.type === type && previous?.actor === actor && previous?.text === text
        && Date.now() - Date.parse(previous.at) < 30_000)
        return;
    state.events.push({
        type,
        actor,
        text: String(text).slice(0, 220),
        metadata,
        at: new Date().toISOString(),
    });
    state.events = state.events.slice(-40);
}

function settlementCenter(bot, state) {
    const shared = storage.getPublicStorage(bot);
    if (shared) {
        return {
            x: shared.x,
            y: shared.y,
            z: shared.z,
            dimension: shared.dimension,
            source: 'public_storage',
        };
    }
    return state.center;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function applyRoleNameplate(agent, state) {
    if (settings.kingdom_role_nameplates === false || !agent.bot?.entity) return;
    const member = state?.members?.[agent.name];
    if (!member?.role) return;
    const specialty = member.specialty;
    const key = specialty ?? member.role;
    if (agent._society?.nameplateKey === key) return;

    const safeKey = String(key).replace(/[^A-Za-z0-9_]/g, '_');
    const teamName = `kn_${safeKey}`.slice(0, 16);
    const role = roleLabel(member.role);
    const label = specialty ? `${role}/${specialtyLabel(specialty)}` : role;

    if (mc.isPreFlatteningVersion(agent.bot)) {
        if (settings.kingdom_legacy_role_nameplates === 'fakename') {
            const safeLabel = String(label)
                .replace(/\s+/g, '/-')
                .replace(/[^A-Za-z0-9_()&/-]/g, '_');
            agent.bot.chat(`/fakename set ${agent.bot.username} ${agent.bot.username}/-(${safeLabel})`);
        }
        agent._society.nameplateKey = key;
        return;
    }
    const suffix = JSON.stringify({
        text: ` (${label})`,
        color: ROLE_COLORS[key] ?? 'gray',
    });

    // Modern scoreboard teams change only display names; login names and bot commands stay intact.
    if (!agent.bot.teams?.[teamName]) {
        agent.bot.chat(`/team add ${teamName}`);
        await sleep(120);
    }
    agent.bot.chat(`/team modify ${teamName} suffix ${suffix}`);
    await sleep(120);
    agent.bot.chat(`/team join ${teamName} ${agent.bot.username}`);
    agent._society.nameplateKey = key;
}

export async function syncSociety(agent) {
    if (settings.kingdom_mode === false || !agent.bot?.entity) return null;
    const bot = agent.bot;
    const result = await withNamedLock(bot, 'kingdom-state', () => {
        const state = readState(true);
        const activeNames = activeAgentNames(agent);
        assignRoles(state, activeNames);
        bot._kingdomRole = state.members[agent.name]?.role ?? null;
        const previous = state.members[agent.name] ?? {};
        const status = progression.getStatus(bot);
        const inventory = summarizeInventory(bot);
        const home = base.getBase(bot);
        let biome = previous.biome ?? null;
        try { biome = world.getBiomeName(bot); } catch { /* chunk may still be loading */ }
        const position = bot.entity.position;

        state.center = settlementCenter(bot, state) ?? {
            x: Math.floor(home?.x ?? position.x),
            y: Math.floor(home?.y ?? position.y),
            z: Math.floor(home?.z ?? position.z),
            dimension: String(bot.game?.dimension ?? 'world'),
            source: home ? 'first_home' : 'spawn',
        };
        state.members[agent.name] = {
            ...previous,
            role: previous.role,
            online: true,
            position: {
                x: Math.floor(position.x),
                y: Math.floor(position.y),
                z: Math.floor(position.z),
                dimension: String(bot.game?.dimension ?? 'world'),
            },
            home,
            health: Math.round(bot.health),
            hunger: Math.round(bot.food),
            inventory,
            progression: status.stage,
            action: agent.actions.currentActionLabel || 'idle',
            biome,
            seenAt: new Date().toISOString(),
        };

        for (const [name, member] of Object.entries(state.members)) {
            if (name === agent.name) continue;
            member.online = activeNames.includes(name)
                && Date.now() - Date.parse(member.seenAt ?? 0) < 90_000;
        }

        if (previous.progression && previous.progression !== status.stage)
            addEventUnlocked(state, 'progression', agent.name,
                `${agent.name} je napredoval iz ${previous.progression} v ${status.stage}.`);
        if (biome && !state.knownBiomes.includes(biome)) {
            state.knownBiomes.push(biome);
            state.knownBiomes = state.knownBiomes.slice(-30);
            addEventUnlocked(state, 'discovery', agent.name,
                `${agent.name} je za naselbino odkril biom ${biome}.`);
        }
        if ((previous.inventory?.diamonds ?? 0) < inventory.diamonds)
            addEventUnlocked(state, 'resource', agent.name,
                `${agent.name} je naselbini prinesel diamant.`);

        const buildingCount = getProtectedBuilds(bot).length;
        if (buildingCount > (state.metrics.buildingCount ?? 0))
            addEventUnlocked(state, 'construction', agent.name,
                `Naselbina ima novo registrirano stavbo (${buildingCount} skupaj).`);
        state.metrics.buildingCount = buildingCount;
        writeState(state);
        return state;
    }, 5000);
    return result.locked ? result.value : readState();
}

export function attachSociety(agent) {
    if (settings.kingdom_mode === false) return;
    agent._society = { syncing: false };
    const sync = async () => {
        if (agent._society.syncing || !agent.bot?.entity) return;
        agent._society.syncing = true;
        try {
            const state = await syncSociety(agent);
            await applyRoleNameplate(agent, state);
        }
        catch (error) { console.warn(`[kingdom ${agent.name}] sync failed: ${error.message}`); }
        finally { agent._society.syncing = false; }
    };
    void sync();
    const interval = setInterval(sync,
        Math.max(5, settings.kingdom_heartbeat_seconds ?? 12) * 1000);
    interval.unref?.();
    const onDeath = () => {
        void recordEvent(agent.bot, 'danger', agent.name,
            `${agent.name} je umrl; ostali naj pomagajo obnoviti opremo.`);
    };
    agent.bot.on('death', onDeath);
    agent.bot.once('end', () => {
        clearInterval(interval);
        agent.bot.removeListener('death', onDeath);
    });
}

export function getSocietyState() {
    return readState();
}

export function getRole(agent) {
    const assigned = assignRoleNames(activeAgentNames(agent));
    const role = assigned[agent.name] ?? readState().members?.[agent.name]?.role;
    if (ROLES.includes(role)) {
        if (agent.bot) agent.bot._kingdomRole = role;
        return role;
    }
    const fallback = 'member';
    if (agent.bot) agent.bot._kingdomRole = fallback;
    return fallback;
}

export function roleLabel(role) {
    return ROLE_LABELS[role] ?? role ?? 'member';
}

export function getSpecialty(agent) {
    return readState().members?.[agent.name]?.specialty ?? null;
}

export function specialtyLabel(specialty) {
    return SPECIALTY_LABELS[specialty] ?? specialty ?? '';
}

export function isEnchanter(agent) {
    return Boolean(agent?.bot);
}

export function activeMembers(bot) {
    const dimension = String(bot.game?.dimension ?? 'world');
    return Object.entries(readState().members)
        .filter(([, member]) => member.online
            && member.position?.dimension === dimension
            && Date.now() - Date.parse(member.seenAt ?? 0) < 90_000)
        .map(([name, member]) => ({ name, ...member }));
}

// The most-needed resource AND how covered it is (ratio >= 1 means the settlement
// already has its target). Callers use the ratio to decide when basics are handled
// and members can move on to deeper goals (diamonds).
export function getResourceNeed(bot) {
    const members = activeMembers(bot);
    if (members.length === 0) return { resource: 'wood', ratio: 0 };
    const total = key => members.reduce((sum, member) => sum + (member.inventory?.[key] ?? 0), 0);
    const ironLoadoutDemand = members.reduce((sum, member) => {
        if (member.progression === 'iron_tools') return sum + 12;
        if (member.progression === 'iron_utility') return sum + 4;
        if (member.progression === 'iron_armor') return sum + 24;
        return sum;
    }, 0);
    const targets = {
        food: members.length * 5,
        wood: members.length * 24,
        stone: members.length * 24,
        iron: members.length * 12 + ironLoadoutDemand,
        coal: members.length * 8,
        gold: members.length * 4,
        lapis: members.length * 5,
    };
    const need = resource => ({ resource, ratio: total(resource) / targets[resource] });
    const ironNeed = need('iron');
    if (ironLoadoutDemand > 0 && ironNeed.ratio < 1)
        return ironNeed;
    return Object.keys(targets)
        .map(need)
        .sort((a, b) => a.ratio - b.ratio)[0];
}

export function getResourcePriority(bot) {
    return getResourceNeed(bot).resource;
}

export function shouldContribute(bot) {
    return Boolean(storage.getPublicStorage(bot)) && base.shouldVisitPublicStorage(bot);
}

export function hasSocietyStoneBaseline(bot) {
    const members = activeMembers(bot);
    return members.length >= 2 && members.every(member =>
        member.progression !== 'bootstrap'
        && (member.inventory?.pickaxes ?? 0) > 0
        && (member.inventory?.axes ?? 0) > 0
        && (member.inventory?.swords ?? 0) > 0);
}

function spareTool(bot, suffix) {
    const matching = bot.inventory.items().filter(item => item.name.endsWith(suffix));
    return matching.length > 1 ? matching.at(-1)?.name : null;
}

export function findSupplyShare(agent) {
    const bot = agent.bot;
    const mine = summarizeInventory(bot);
    const members = activeMembers(bot)
        .filter(member => member.name !== agent.name)
        .map(member => ({
            ...member,
            entity: bot.players[member.name]?.entity,
        }))
        .filter(member => member.entity
            && member.entity.position.distanceTo(bot.entity.position) <= 14)
        .sort((a, b) => a.entity.position.distanceTo(bot.entity.position)
            - b.entity.position.distanceTo(bot.entity.position));

    for (const member of members) {
        if ((member.inventory?.food ?? 0) < 2 && mine.food >= 6) {
            const item = bot.inventory.items().find(stack => mc.stackMatchesAnyName(stack, [...FOOD], bot));
            if (item) return { target: member.name, item: item.name, count: Math.min(2, item.count), reason: 'hrana' };
        }
        if ((member.inventory?.torches ?? 0) < 2 && mine.torches >= 12)
            return { target: member.name, item: 'torch', count: 4, reason: 'bakle' };
        if ((member.inventory?.pickaxes ?? 0) < 1) {
            const item = spareTool(bot, '_pickaxe');
            if (item) return { target: member.name, item, count: 1, reason: 'kramp' };
        }
        if ((member.inventory?.swords ?? 0) < 1) {
            const item = spareTool(bot, '_sword');
            if (item) return { target: member.name, item, count: 1, reason: 'orozje' };
        }
    }
    return null;
}

async function claimTransfer(bot, transfer) {
    const result = await withNamedLock(bot, 'kingdom-state', () => {
        const state = readState(true);
        const key = `${bot.username}:${transfer.target}:${transfer.item}`;
        if (Date.now() - (state.transfers[key] ?? 0) < 5 * 60_000)
            return false;
        state.transfers[key] = Date.now();
        state.transfers = Object.fromEntries(Object.entries(state.transfers)
            .filter(([, at]) => Date.now() - at < 30 * 60_000));
        writeState(state);
        return true;
    });
    return result.locked && result.value;
}

async function releaseTransfer(bot, transfer) {
    await withNamedLock(bot, 'kingdom-state', () => {
        const state = readState(true);
        delete state.transfers[`${bot.username}:${transfer.target}:${transfer.item}`];
        writeState(state);
        return true;
    });
}

export async function shareSupplies(agent, transfer = findSupplyShare(agent)) {
    if (!transfer || !await claimTransfer(agent.bot, transfer)) return false;
    const success = await skills.giveToPlayer(
        agent.bot,
        transfer.item,
        transfer.target,
        transfer.count,
    );
    if (success)
        await recordEvent(agent.bot, 'cooperation', agent.name,
            `${agent.name} gave ${transfer.count}x ${transfer.item} to ${transfer.target}.`);
    if (success) {
        const { recordSupplyShare } = await import('../roleplay/events.js');
        void recordSupplyShare(agent, transfer.target, transfer.item, transfer.count)
            .catch(error => console.warn(`[rp ${agent.name}] supply memory failed: ${error.message}`));
    } else
        await releaseTransfer(agent.bot, transfer);
    return success;
}

export async function recordEvent(bot, type, actor, text, metadata = {}) {
    const result = await withNamedLock(bot, 'kingdom-state', () => {
        const state = readState(true);
        addEventUnlocked(state, type, actor, text, metadata);
        writeState(state);
        return true;
    }, 5000);
    return result.locked;
}

export async function claimSocialTurn(bot) {
    const interval = Math.max(1, settings.kingdom_social_interval_minutes ?? 8) * 60_000;
    const result = await withNamedLock(bot, 'kingdom-state', () => {
        const state = readState(true);
        if (Date.now() - (state.lastSocialAt ?? 0) < interval) return false;
        state.lastSocialAt = Date.now();
        writeState(state);
        return true;
    }, 3000);
    return result.locked && result.value;
}

// ── Owner directive (supreme-commander strategic order) ─────────────────────
// Stored in kingdom state; the society + local planners treat it as binding context
// and mark executors priority:"high". Deduped so ten bots hearing the same public
// chat line produce ONE write/event/reply (the first past the lock wins).
export async function setOwnerDirective(bot, text, by) {
    const result = await withNamedLock(bot, 'kingdom-state', () => {
        const state = readState(true);
        const next = text ? String(text).replace(/\s+/g, ' ').trim().slice(0, 240) : null;
        const previous = state.ownerDirective ?? null;
        const recentWrite = previous?.at && Date.now() - Date.parse(previous.at) < 15_000;
        if ((previous?.text ?? null) === next && (next === null || recentWrite)) return false;
        state.ownerDirective = next ? { text: next, by, at: new Date().toISOString() } : null;
        addEventUnlocked(state, 'directive', by ?? 'owner',
            next ? `${by} issued a kingdom directive: ${next.slice(0, 160)}` : `${by} cleared the kingdom directive.`);
        writeState(state);
        return true;
    }, 3000);
    return result.locked && result.value;
}

// ── Cross-process bot-to-bot exchange (short 2-3 line conversations) ─────────
// The initiator posts {from,to,text,turnsLeft}; the addressee's social tick takes it,
// replies in character, and posts the next turn back until turnsLeft runs out.
export async function postSocialExchange(bot, exchange) {
    const result = await withNamedLock(bot, 'kingdom-state', () => {
        const state = readState(true);
        state.socialExchange = exchange;
        writeState(state);
        return true;
    }, 3000);
    return result.locked;
}

export async function takeSocialExchangeFor(bot, name) {
    const result = await withNamedLock(bot, 'kingdom-state', () => {
        const state = readState(true);
        const exchange = state.socialExchange;
        if (!exchange || exchange.to !== name || Date.now() - (exchange.at ?? 0) > 90_000)
            return null;
        state.socialExchange = null;
        writeState(state);
        return exchange;
    }, 3000);
    return result.locked ? result.value : null;
}

export async function noteRoadCompleted(bot, actor, road) {
    const result = await withNamedLock(bot, 'kingdom-state', () => {
        const state = readState(true);
        state.metrics.roadCount = Math.max(state.metrics.roadCount ?? 0, road.totalRoads ?? 0);
        addEventUnlocked(state, 'infrastructure', actor,
            `${actor} finished a path ${road.fromLabel} - ${road.toLabel}.`);
        writeState(state);
        return true;
    });
    return result.locked;
}

export function formatSocietyStatus() {
    const state = readState();
    const members = Object.entries(state.members)
        .filter(([, member]) => member.online)
        .map(([name, member]) => {
            const specialty = member.specialty ? `/${specialtyLabel(member.specialty)}` : '';
            return `${name}=${roleLabel(member.role)}${specialty} (${member.action ?? 'idle'})`;
        })
        .join(', ');
    const recent = state.events.at(-1)?.text ?? 'brez skupnih dogodkov';
    return `${state.name}: ${members || 'ni aktivnih clanov'} | stavbe=${state.metrics.buildingCount ?? 0}`
        + ` poti=${state.metrics.roadCount ?? 0} | zadnje: ${recent}`;
}
