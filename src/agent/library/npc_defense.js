// Reactive self-defense against modded NPCs (CustomNPCs / AncientWarfare) and hostile
// players. The vanilla self_defense mode targets via mc.isHostile(), which only knows
// vanilla mobs — modded NPCs arrive as "unknown"/player-type entities, so that mode never
// engages them. This module instead reacts to ACTUAL aggression:
//   - if something recently damaged me, blame the nearest non-friendly entity that swung
//     at me (melee), and fight/flee;
//   - if a kingdom ally was just attacked nearby, go help against the aggressor.
// It deliberately ignores vanilla hostiles (left to self_defense) and never targets
// friends: self, other kingdom bots, the owner, villagers/golems, or passive animals.

import * as world from './world.js';
import * as mc from '../../utils/mcdata.js';
import settings from '../settings.js';
import { serverProxy } from '../mindserver_proxy.js';

const THREAT_TTL_MS = 8000;     // keep engaging an attacker this long after its last hit/swing
const SWING_TTL_MS = 1500;      // a melee swing counts as "recent" for attribution this long
const ATTRIBUTION_RANGE = 5;    // blame a non-friend within this many blocks of the victim
const ALLY_HELP_RANGE = 18;     // help an ally attacked within this range
const KEEP_RANGE = 24;          // drop a threat that gets farther than this

// Non-hostile vanilla mobs we must never retaliate against.
const FRIENDLY_MOBS = new Set([
    'iron_golem', 'snow_golem', 'villager', 'wandering_trader', 'armor_stand',
    'horse', 'donkey', 'mule', 'llama', 'cat', 'ocelot', 'wolf', 'parrot',
]);

// Entity kinds mineflayer resolves for definitely-non-living spawns.
const NONLIVING_TYPES = new Set(['object', 'orb', 'global']);
// Vanilla non-living names, as a safety net for registry quirks.
const NONLIVING_NAMES = new Set([
    'item', 'xp_orb', 'arrow', 'spectral_arrow', 'snowball', 'egg', 'ender_pearl',
    'eye_of_ender', 'potion', 'fireball', 'small_fireball', 'dragon_fireball',
    'wither_skull', 'shulker_bullet', 'llama_spit', 'evocation_fangs', 'tnt',
    'falling_block', 'boat', 'minecart', 'painting', 'item_frame', 'leash_knot',
    'area_effect_cloud', 'fireworks_rocket', 'ender_crystal', 'fishing_bobber',
]);

// Attacking a non-living entity (item/orb/arrow/self) gets the player kicked.
// Some unknown MODDED entities arrive as type 'other' though — living NPCs
// and modded projectiles alike — so 'other' only counts as living with positive
// evidence: a recent arm swing, or a numeric metadata health field that
// projectiles/items do not carry.
export function looksLiving(bot, entity) {
    if (!entity) return false;
    if (NONLIVING_TYPES.has(entity.type)) return false;
    if (entity.name && NONLIVING_NAMES.has(entity.name)) return false;
    if (entity.type === 'mob' || entity.type === 'player' || entity.type === 'hostile'
        || entity.type === 'animal' || entity.type === 'water_creature' || entity.type === 'ambient')
        return true;
    if (recentSwing(bot, entity.id)) return true;
    return typeof entity.metadata?.[7] === 'number';
}

const ALLY_CACHE_MS = 3000; // roster changes rarely; rebuilding the Set every 300ms tick is wasted work
function allyNames(agent) {
    const bot = agent.bot;
    const cache = bot._npcAllyCache;
    const now = Date.now();
    if (cache && now - cache.at < ALLY_CACHE_MS) return cache.names;
    const names = new Set([agent.name]);
    try {
        for (const entry of serverProxy.getAgents()) {
            const n = typeof entry === 'string' ? entry : entry?.name;
            if (n) names.add(n);
        }
    } catch { /* mindserver may still be connecting */ }
    if (settings.owner_player) names.add(settings.owner_player);
    bot._npcAllyCache = { names, at: now };
    return names;
}

function isRealPlayerEntity(bot, entity, allies) {
    if (entity?.type !== 'player' || !entity.username) return false;
    if (allies.has(entity.username)) return true;
    return Boolean(bot.players?.[entity.username]);
}

// Entities we will never attack. Unknown/modded non-passive entities are NOT friendly here
// (so they can become foes) — but they only ever become a threat if they actually attack.
export function isFriendly(entity, agent, allies) {
    const bot = agent.bot;
    if (!entity || entity === bot.entity) return true;
    // Non-living entities (dropped items, the arrow that just hit us, XP orbs...) can
    // never be the aggressor, and attacking one gets the bot kicked
    // ("Attempting to attack an invalid entity"). Modded NPCs share type 'other' with
    // modded projectiles, so liveness needs positive evidence — see looksLiving().
    if (!looksLiving(bot, entity)) return true;
    if (isRealPlayerEntity(bot, entity, allies)) return true;
    const name = entity.name;
    if (name && FRIENDLY_MOBS.has(name)) return true;
    if (mc.isHostile(entity)) return false;                     // vanilla hostile: handled by self_defense, not "friendly"
    if (entity.type === 'animal' || entity.type === 'water_creature' || entity.type === 'ambient')
        return true;                                            // passive vanilla wildlife
    return false;                                               // unknown/modded, non-passive
}

function recentSwing(bot, id) {
    const t = bot._npcSwings?.get(id);
    return t != null && Date.now() - t < SWING_TTL_MS;
}

// Nearest non-friendly, non-vanilla-hostile entity that swung near `pos` recently. Requiring
// a swing avoids blaming a friendly/unknown NPC when the damage was environmental (fall/lava).
function findAttackerNear(bot, agent, pos, allies) {
    let best = null;
    let bestD = Infinity;
    for (const e of world.getNearbyEntities(bot, ATTRIBUTION_RANGE + 3)) {
        if (!e?.position || isFriendly(e, agent, allies) || mc.isHostile(e)) continue;
        const d = e.position.distanceTo(pos);
        if (d > ATTRIBUTION_RANGE || !recentSwing(bot, e.id)) continue;
        if (d < bestD) { best = e; bestD = d; }
    }
    return best;
}

// Fallback for a directly-hit bot when no swing was observed (some modded NPCs may not send
// the animation): if EXACTLY ONE non-friendly, non-vanilla entity is right next to me, it's
// almost certainly the melee attacker. Ambiguous cases (0 or >1) are left to swing detection.
function loneCloseEnemy(bot, agent, pos, allies, range = 3.5) {
    let found = null;
    for (const e of world.getNearbyEntities(bot, range + 1)) {
        if (!e?.position || isFriendly(e, agent, allies) || mc.isHostile(e)) continue;
        if (e.position.distanceTo(pos) > range) continue;
        if (found) return null; // more than one candidate -> don't guess
        found = e;
    }
    return found;
}

// Attach the once-per-bot trackers. Idempotent; safe to call every tick.
export function ensureNpcDefense(agent) {
    const bot = agent.bot;
    if (bot._npcDefenseInit) return;
    bot._npcDefenseInit = true;
    bot._npcSwings = new Map();
    bot._npcThreat = null;
    bot._npcAllyHurt = null;

    bot.on('entitySwingArm', (e) => {
        if (!e || e === bot.entity) return;
        bot._npcSwings.set(e.id, Date.now());
        if (bot._npcSwings.size > 64) { // prune stale entries
            const cutoff = Date.now() - SWING_TTL_MS * 2;
            for (const [id, t] of bot._npcSwings) if (t < cutoff) bot._npcSwings.delete(id);
        }
    });

    bot.on('entityHurt', (e) => {
        if (!e || e === bot.entity || e.type !== 'player' || !e.username) return;
        if (allyNames(agent).has(e.username) && e.position) // a teammate got hit -> remember, go help
            bot._npcAllyHurt = { pos: e.position.clone(), at: Date.now(), who: e.username };
    });
}

// The entity this bot should currently be defending against (or null). Prefers an already
// locked threat, then a fresh self-attacker, then an attacker on a nearby ally.
export function currentThreat(agent) {
    const bot = agent.bot;
    ensureNpcDefense(agent);
    if (!bot.entity) return null;
    const allies = allyNames(agent);
    const now = Date.now();

    // 1) keep the locked target while it stays valid, in range, and non-friendly
    if (bot._npcThreat && now < bot._npcThreat.until) {
        const e = bot.entities?.[bot._npcThreat.id];
        if (e && e.position && !isFriendly(e, agent, allies)
            && e.position.distanceTo(bot.entity.position) <= KEEP_RANGE)
            return e;
        bot._npcThreat = null;
    }

    // 2) I was just damaged -> blame the nearest non-friend that swung at me (or the lone
    //    entity standing on top of me if no swing was seen)
    if (bot.lastDamageTaken > 0 && now - (bot.lastDamageTime ?? 0) < THREAT_TTL_MS) {
        const attacker = findAttackerNear(bot, agent, bot.entity.position, allies)
            ?? loneCloseEnemy(bot, agent, bot.entity.position, allies);
        if (attacker) {
            bot._npcThreat = { id: attacker.id, until: now + THREAT_TTL_MS };
            return attacker;
        }
    }

    // 3) a nearby ally was just attacked -> go help against the aggressor next to them
    if (bot._npcAllyHurt && now - bot._npcAllyHurt.at < THREAT_TTL_MS) {
        const ap = bot._npcAllyHurt.pos;
        if (ap && ap.distanceTo(bot.entity.position) <= ALLY_HELP_RANGE) {
            const aggressor = findAttackerNear(bot, agent, ap, allies);
            if (aggressor) {
                bot._npcThreat = { id: aggressor.id, until: now + THREAT_TTL_MS };
                return aggressor;
            }
        }
    }
    return null;
}

export function threatLabel(entity) {
    return entity?.username || entity?.name || 'napadalec';
}
