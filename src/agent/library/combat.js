// Per-bot combat for every society member (deterministic, no LLM).
// - Every bot carries a bow + arrows and a melee kit.
// - "archer" bots prefer ranged fire; "defender" bots prefer shield + sword/axe.
// Bow aiming uses minecrafthawkeye's parabolic solver (bot.hawkEye), but the
// shot is gated by our own friendly-fire check so bots never hit the player or
// each other (hawkeye has no such safety). Style comes from each profile's
// `combat_style` field, with a deterministic name-based fallback.
import { Vec3 } from 'vec3';
import * as world from './world.js';
import * as skills from './skills.js';
import * as base from './base.js';
import * as storage from './storage.js';
import * as npcDefense from './npc_defense.js';
import * as mc from '../../utils/mcdata.js';

const BOW_MIN = 5;   // closer than this → finish in melee instead of drawing a bow
const BOW_MAX = 32;  // farther than this the shot is unreliable / target may unload
const FRIENDLY_RADIUS = 1.7; // keep the arc this clear of any teammate or the player
const MAX_VOLLEY = 6;        // arrows per engagement before falling through to melee
const ARCHER_ARROW_TARGET = 16;
const DEFENDER_ARROW_TARGET = 8;
const DEFAULT_DIRECTIVE_MINUTES = 15;
const MAX_DIRECTIVE_MINUTES = 120;

const PLANKS = [
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
    'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
];
const STRING_BLOCKS = ['cobweb', 'tripwire'];
const MELEE_WEAPONS = [
    'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
    'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe',
];
const SWORDS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword'];
const GENERIC_TARGET_WORDS = new Set([
    'enemy', 'enemies', 'monster', 'monsters', 'mob', 'mobs', 'threat', 'threats',
    'hostile', 'hostiles', 'attacker', 'attackers', 'nearest', 'closest', 'that',
    'this', 'it', 'tisto', 'tistega', 'tega', 'to', 'najblizji', 'najblizjega',
    'sovraznik', 'sovrazniki', 'posast', 'posasti', 'napadalec', 'napadalci',
]);
const TARGET_ALIASES = new Map([
    ['zombie', ['zombie', 'zombi', 'zombija', 'zombije']],
    ['skeleton', ['skeleton', 'skelet', 'skeleta', 'okostnjak', 'okostnjaka']],
    ['creeper', ['creeper', 'creeperja', 'kriper', 'kriperja']],
    ['spider', ['spider', 'spiders', 'pajek', 'pajka', 'pajki', 'pajke']],
    ['cave_spider', ['cave spider', 'cave_spider', 'jamski pajek']],
    ['enderman', ['enderman', 'endermana']],
    ['witch', ['witch', 'vesca', 'vesco']],
    ['slime', ['slime', 'slajm']],
    ['drowned', ['drowned', 'utopljenec']],
    ['wither_skeleton', ['wither skeleton', 'wither_skeleton']],
    ['zombie_pigman', ['zombie pigman', 'zombie_pigman', 'pigman']],
    ['blaze', ['blaze', 'blazea']],
    ['ghast', ['ghast']],
    ['guardian', ['guardian']],
]);

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizeText(text) {
    return String(text ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[_-]+/g, ' ')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function directiveUntil(minutes) {
    if (minutes === -1 || String(minutes).toLowerCase() === 'forever') return Infinity;
    const parsed = Number(minutes);
    const duration = Number.isFinite(parsed)
        ? clamp(parsed, 1, MAX_DIRECTIVE_MINUTES)
        : DEFAULT_DIRECTIVE_MINUTES;
    return Date.now() + duration * 60 * 1000;
}

function activeDirective(directive) {
    if (!directive) return null;
    if (directive.until !== Infinity && Date.now() > directive.until) return null;
    return directive;
}

function directiveMinutesLeft(directive) {
    if (!directive) return 0;
    if (directive.until === Infinity) return -1;
    return Math.max(1, Math.ceil((directive.until - Date.now()) / 60000));
}

function normalizeStyle(style) {
    const text = normalizeText(style);
    if (['archer', 'ranged', 'range', 'bow', 'bows', 'lokostrelec', 'lokostrelci', 'lok'].includes(text))
        return 'archer';
    if (['defender', 'defensive', 'melee', 'shield', 'sword', 'branilec', 'branilci', 'obrambni'].includes(text))
        return 'defender';
    if (['normal', 'balanced', 'default', 'reset', 'navadno', 'normalno'].includes(text))
        return 'normal';
    return null;
}

function normalizeStance(stance) {
    const text = normalizeText(stance);
    if (['aggressive', 'attack', 'attack mode', 'agresivni', 'agresivno', 'napadalni', 'napadalno'].includes(text))
        return 'aggressive';
    if (['defensive', 'defense', 'guard', 'guarding', 'defenzivni', 'defenzivno', 'obrambni', 'obrambno'].includes(text))
        return 'defensive';
    if (['passive', 'peaceful', 'hold fire', 'do not fight', 'mirni', 'mirno', 'ne napadaj'].includes(text))
        return 'passive';
    if (['normal', 'balanced', 'default', 'reset', 'navadno', 'normalno'].includes(text))
        return 'normal';
    return null;
}

export function setOwnerCombatStyle(agent, style, minutes = DEFAULT_DIRECTIVE_MINUTES) {
    const normalized = normalizeStyle(style);
    if (!normalized) return null;
    if (normalized === 'normal') {
        delete agent.bot._ownerCombatStyle;
        return { style: getCombatStyle(agent), minutes: 0, reset: true };
    }
    const directive = { style: normalized, until: directiveUntil(minutes) };
    agent.bot._ownerCombatStyle = directive;
    agent.bot._combatStyle = normalized;
    return { style: normalized, minutes: directiveMinutesLeft(directive), reset: false };
}

export function setOwnerCombatStance(agent, stance, minutes = DEFAULT_DIRECTIVE_MINUTES) {
    const normalized = normalizeStance(stance);
    if (!normalized) return null;
    if (normalized === 'normal') {
        delete agent.bot._ownerCombatStance;
        return { stance: getCombatStance(agent), minutes: 0, reset: true };
    }
    const directive = { stance: normalized, until: directiveUntil(minutes) };
    agent.bot._ownerCombatStance = directive;
    return { stance: normalized, minutes: directiveMinutesLeft(directive), reset: false };
}

export function getCombatStance(agent) {
    const directive = activeDirective(agent?.bot?._ownerCombatStance);
    if (directive) return directive.stance;
    if (agent?.bot?._ownerCombatStance) delete agent.bot._ownerCombatStance;
    return 'normal';
}

export function getCombatStyle(agent) {
    const override = activeDirective(agent?.bot?._ownerCombatStyle);
    if (override) {
        if (agent?.bot) agent.bot._combatStyle = override.style;
        return override.style;
    }
    if (agent?.bot?._ownerCombatStyle) delete agent.bot._ownerCombatStyle;
    const declared = String(agent?.prompter?.profile?.combat_style ?? '').toLowerCase();
    if (declared === 'archer' || declared === 'ranged') {
        if (agent?.bot) agent.bot._combatStyle = 'archer';
        return 'archer';
    }
    if (declared === 'defender' || declared === 'melee') {
        if (agent?.bot) agent.bot._combatStyle = 'defender';
        return 'defender';
    }
    // Unconfigured bots still differ: split deterministically by name.
    let hash = 0;
    for (const char of agent?.name ?? '')
        hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    const style = hash % 2 === 0 ? 'archer' : 'defender';
    if (agent?.bot) agent.bot._combatStyle = style;
    return style;
}

function entityAlive(bot, entity) {
    return Boolean(entity?.position)
        && entity.isValid !== false
        && Object.values(bot.entities).includes(entity);
}

function isAttackableEntity(bot, entity) {
    return entityAlive(bot, entity)
        && entity !== bot.entity
        && !skills.isProtectedPlayerTarget(bot, entity);
}

// Explicit owner orders may target vanilla hostiles or adult huntable livestock.
// Villagers, golems, pets, babies, players and arbitrary modded/passive entities are
// not legal named targets. A modded entity is allowed only after npc_defense has
// positively identified it as the current aggressor.
export function isAllowedOrderedTarget(agent, entity) {
    if (!isAttackableEntity(agent.bot, entity)) return false;
    return mc.isHostile(entity)
        || mc.isHuntable(entity)
        || (agent.bot._npcThreat?.id === entity.id
            && Date.now() < (agent.bot._npcThreat?.until ?? 0));
}

function inventoryHas(bot, name) {
    return bot.inventory.items().some(item => item.name === name);
}

function bestMeleeWeapon(bot) {
    const owned = new Set(bot.inventory.items().map(item => item.name));
    return MELEE_WEAPONS.find(name => owned.has(name)) ?? null;
}

function arrowCount(bot) {
    return world.getInventoryCounts(bot).arrow ?? 0;
}

function referencePosition(agent, source = null) {
    const bot = agent.bot;
    const sourceEntity = source ? bot.players?.[source]?.entity : null;
    return sourceEntity?.position ?? bot.entity.position;
}

function sortedAttackableEntities(agent, source = null, maxDistance = 48) {
    const bot = agent.bot;
    const ref = referencePosition(agent, source);
    return world.getNearbyEntities(bot, maxDistance)
        .filter(entity => isAttackableEntity(bot, entity))
        .sort((left, right) => left.position.distanceTo(ref) - right.position.distanceTo(ref));
}

function playerNameMentioned(bot, targetText) {
    const text = normalizeText(targetText);
    if (!text) return null;
    for (const username of Object.keys(bot.players ?? {})) {
        if (username === bot.username) continue;
        const name = normalizeText(username);
        if (name && (text === name || text.includes(name))) return username;
    }
    return null;
}

function targetAliases(targetText) {
    const text = normalizeText(targetText);
    const aliases = new Set([text, text.replace(/\s+/g, '_')]);
    for (const [canonical, words] of TARGET_ALIASES) {
        if (words.some(word => text.includes(normalizeText(word)))) {
            aliases.add(canonical);
            aliases.add(canonical.replace(/_/g, ' '));
        }
    }
    return aliases;
}

function targetMatches(entity, aliases) {
    const names = [
        entity.name,
        entity.username,
        entity.displayName,
        entity.mobType,
    ].filter(Boolean).map(normalizeText);
    return names.some(name => aliases.has(name)
        || aliases.has(name.replace(/\s+/g, '_')));
}

function isGenericTarget(targetText) {
    const text = normalizeText(targetText);
    if (!text) return true;
    return text.split(/\s+/).some(word => GENERIC_TARGET_WORDS.has(word));
}

function invCount(bot, names) {
    const inv = world.getInventoryCounts(bot);
    return (Array.isArray(names) ? names : [names]).reduce((sum, name) => sum + (inv[name] ?? 0), 0);
}

function hasAny(bot, names) {
    return (Array.isArray(names) ? names : [names]).some(name => inventoryHas(bot, name));
}

function rangedMaterialScore(bot) {
    const inv = world.getInventoryCounts(bot);
    return (inventoryHas(bot, 'bow') ? 64 : 0)
        + (inv.arrow ?? 0)
        + (inv.string ?? 0)
        + (inv.flint ?? 0)
        + (inv.feather ?? 0)
        + Math.min(inv.stick ?? 0, 16);
}

async function takeNeededQuietly(bot, needs) {
    try { await base.takeNeeded(bot, needs); }
    catch { /* no base/public storage yet */ }
}

async function ensureSticks(bot, target, gather = false) {
    if (invCount(bot, 'stick') >= target) return true;
    await takeNeededQuietly(bot, { stick: target });
    if (invCount(bot, 'stick') >= target) return true;
    if (gather) {
        await skills.ensureLogs(bot, 2);
        await skills.ensurePlanks(bot, 4);
    }
    if (invCount(bot, 'stick') < target)
        await skills.craftRecipe(bot, 'stick', target - invCount(bot, 'stick'));
    return invCount(bot, 'stick') >= target;
}

async function collectNaturalString(bot, target) {
    const before = invCount(bot, 'string');
    const source = world.getNearestBlocks(bot, STRING_BLOCKS, 48, 8)[0];
    if (!source) return false;
    if (source.name === 'cobweb' && !hasAny(bot, [...SWORDS, 'shears']))
        await skills.obtainTool(bot, 'wooden_sword');
    const needed = Math.max(1, target - before);
    skills.log(bot, `Nabiram string iz ${source.name}.`);
    await skills.collectBlock(bot, source.name, Math.min(needed, 4));
    return invCount(bot, 'string') > before;
}

async function huntForString(bot) {
    if (!skills.canFightAtCurrentHealth(bot)) return false;
    const spider = world.getNearestEntityWhere(bot,
        entity => ['spider', 'cave_spider'].includes(entity.name), 24);
    if (!spider) return false;
    const before = invCount(bot, 'string');
    skills.log(bot, `Rabim string za lok, grem nad ${spider.name}.`);
    await skills.attackEntity(bot, spider, true);
    return invCount(bot, 'string') > before;
}

async function ensureString(bot, target, gather = false) {
    if (invCount(bot, 'string') >= target) return true;
    await takeNeededQuietly(bot, { string: target });
    if (invCount(bot, 'string') >= target) return true;
    if (!gather) return false;
    if (await collectNaturalString(bot, target)) return invCount(bot, 'string') >= target;
    await huntForString(bot);
    return invCount(bot, 'string') >= target;
}

async function ensureFlint(bot, target, gather = false) {
    if (invCount(bot, 'flint') >= target) return true;
    await takeNeededQuietly(bot, { flint: target });
    if (invCount(bot, 'flint') >= target) return true;
    if (!gather) return false;
    const before = invCount(bot, 'flint');
    const missing = target - before;
    const gravel = world.getNearestBlocks(bot, ['gravel'], 48, 1)[0];
    if (!gravel) return false;
    skills.log(bot, 'Kopljem gravel za flint.');
    await skills.collectBlock(bot, 'gravel', Math.min(12, Math.max(4, missing * 6)));
    return invCount(bot, 'flint') > before;
}

async function ensureFeathers(bot, target, gather = false) {
    if (invCount(bot, 'feather') >= target) return true;
    await takeNeededQuietly(bot, { feather: target });
    if (invCount(bot, 'feather') >= target) return true;
    if (!gather || !skills.canFightAtCurrentHealth(bot)) return false;
    const adults = Object.values(bot.entities ?? {})
        .filter(entity => entity?.name === 'chicken'
            && entity.position
            && entity.isValid !== false
            && !mc.isBabyEntity(entity, bot)
            && entity.position.distanceTo(bot.entity.position) < 24)
        .sort((left, right) =>
            left.position.distanceTo(bot.entity.position)
            - right.position.distanceTo(bot.entity.position));
    if (adults.length < 3) return false;
    const before = invCount(bot, 'feather');
    skills.log(bot, 'Rabim feathers za puscice, ulovim eno kuro.');
    await skills.attackEntity(bot, adults[0], true);
    return invCount(bot, 'feather') > before;
}

async function craftBowIfPossible(bot, gather) {
    if (inventoryHas(bot, 'bow')) return true;
    if (await storage.takeOnePublicMatching(bot, item => item.name === 'bow', () => 100))
        return true;
    await ensureString(bot, 3, gather);
    await ensureSticks(bot, 3, gather);
    if (invCount(bot, 'string') >= 3 && invCount(bot, 'stick') >= 3)
        await skills.craftRecipe(bot, 'bow', 1);
    return inventoryHas(bot, 'bow');
}

async function craftArrowsIfPossible(bot, target, gather) {
    const before = arrowCount(bot);
    if (arrowCount(bot) >= target) return true;
    await storage.takeNeededPublic(bot, { arrow: target });
    if (arrowCount(bot) >= target) return true;
    const batches = Math.max(1, Math.ceil((target - arrowCount(bot)) / 4));
    await ensureFlint(bot, batches, gather);
    await ensureSticks(bot, batches, gather);
    await ensureFeathers(bot, batches, gather);
    if (invCount(bot, 'flint') >= batches && invCount(bot, 'stick') >= batches && invCount(bot, 'feather') >= batches)
        await skills.craftRecipe(bot, 'arrow', target - arrowCount(bot));
    return arrowCount(bot) >= target || arrowCount(bot) > before;
}

// Positions of everyone we must not shoot: the human player and fellow bots are
// all entities of type 'player'.
function friendPositions(bot) {
    return Object.values(bot.players)
        .filter(player => player.entity && player.username !== bot.username)
        .map(player => player.entity.position);
}

function trajectoryClearOfFriends(bot, points) {
    if (!Array.isArray(points) || points.length === 0) return false;
    const friends = friendPositions(bot);
    if (friends.length === 0) return true;
    return !points.some(point => friends.some(friend =>
        point.distanceTo(friend.offset(0, 1, 0)) < FRIENDLY_RADIUS));
}

export function canShootBow(bot, entity) {
    if (typeof bot.hawkEye?.getMasterGrade !== 'function') return false;
    if (!inventoryHas(bot, 'bow') || arrowCount(bot) < 1) return false;
    if (!entityAlive(bot, entity)) return false;
    const distance = bot.entity.position.distanceTo(entity.position);
    return distance >= BOW_MIN && distance <= BOW_MAX;
}

export function findAttackTarget(agent, targetText = 'enemy', options = {}) {
    const bot = agent.bot;
    const source = options.source ?? agent.commandSource ?? null;
    const maxDistance = options.maxDistance ?? 48;
    const playerMention = playerNameMentioned(bot, targetText);
    if (playerMention)
        return { ok: false, reason: `I will not attack real player ${playerMention}.` };

    const currentThreat = npcDefense.currentThreat?.(agent);
    if (isGenericTarget(targetText)) {
        if (isAttackableEntity(bot, currentThreat))
            return { ok: true, entity: currentThreat, label: npcDefense.threatLabel(currentThreat) };
        const hostile = sortedAttackableEntities(agent, source, maxDistance)
            .find(entity => mc.isHostile(entity));
        if (hostile)
            return { ok: true, entity: hostile, label: hostile.name };
        return { ok: false, reason: 'I do not see a hostile target nearby.' };
    }

    const aliases = targetAliases(targetText);
    const target = sortedAttackableEntities(agent, source, maxDistance)
        .find(entity => isAllowedOrderedTarget(agent, entity) && targetMatches(entity, aliases));
    if (!target)
        return { ok: false, reason: `I do not see a safe hostile or adult huntable animal matching "${targetText}" nearby.` };
    return { ok: true, entity: target, label: target.username || target.name || 'target' };
}

export async function attackTargets(agent, targetText = 'enemy', count = null, options = {}) {
    const bot = agent.bot;
    const defaultCount = isGenericTarget(targetText) ? 32 : 1;
    const maxCount = clamp(count == null ? defaultCount : (Number(count) || defaultCount), 1, 32);
    let attacked = 0;
    for (let i = 0; i < maxCount && !bot.interrupt_code; i++) {
        const target = findAttackTarget(agent, targetText, options);
        if (!target.ok) {
            skills.log(bot, target.reason);
            break;
        }
        await ensureCombatKit(agent, {
            gather: getCombatStyle(agent) === 'archer',
            arrowTarget: getCombatStyle(agent) === 'archer' ? ARCHER_ARROW_TARGET : DEFENDER_ARROW_TARGET,
        });
        skills.log(bot, `Owner target acquired: ${target.label}.`);
        const ok = await engage(agent, target.entity);
        if (!ok) break;
        attacked++;
    }
    return attacked > 0;
}

// Aim with hawkeye, then veto the shot ourselves if the computed arc passes any
// teammate. Returns true only if an arrow was actually loosed.
export async function shootBowAt(bot, entity) {
    if (!canShootBow(bot, entity)) return false;
    if (typeof bot.canSeeEntity === 'function' && !bot.canSeeEntity(entity)) return false;
    const bow = bot.inventory.items().find(item => item.name === 'bow');
    if (!bow) return false;

    let grade;
    try {
        grade = bot.hawkEye.getMasterGrade(entity, entity.velocity ?? new Vec3(0, 0, 0), 'bow');
    } catch {
        return false; // hawkeye throws when no trajectory converges
    }
    if (!grade || grade.blockInTrayect) return false; // no solution, or a block is in the way
    if (!trajectoryClearOfFriends(bot, grade.arrowTrajectoryPoints)) return false;

    try {
        if (!await skills.equipItemSafely(bot, bow, 'hand')) return false;
        await bot.hawkEye.simplyShot(grade.yaw, grade.pitch); // look → draw 1.2s → release
        return true;
    } catch {
        try { bot.deactivateItem(); } catch { /* disconnected */ }
        return false;
    }
}

// Whether an armed, healthy bot should hold its ground and fight rather than
// flee. The caller checks health; here we only check the combat kit. Used to let
// fighters override the default cowardice (flee) reflex.
export function willStandGround(agent, entity) {
    const bot = agent.bot;
    if (!entityAlive(bot, entity)) return false;
    const stance = getCombatStance(agent);
    if (stance === 'passive') return false;
    if (stance === 'aggressive')
        return skills.canFightAtCurrentHealth(bot);
    if (getCombatStyle(agent) === 'archer')
        return canShootBow(bot, entity); // has bow + arrows and target is in range
    return inventoryHas(bot, 'shield') && bestMeleeWeapon(bot) !== null;
}

// Style-aware response to one specific threat. Archers volley until out of
// range/arrows then finish in melee; defenders raise a shield and close in.
// Pauses flee/auto-defense reflexes so they don't interrupt the engagement.
export async function engage(agent, threat) {
    const bot = agent.bot;
    const entity = threat?.entity ?? threat;
    if (!entityAlive(bot, entity)) return false;
    if (!skills.canFightAtCurrentHealth(bot)) return false;
    const style = getCombatStyle(agent);
    try { await bot.armorManager.equipAll(); } catch { /* optional plugin */ }
    bot.modes?.pause('cowardice');
    bot.modes?.pause('self_defense');
    try {
        if (style === 'archer') {
            let shots = 0;
            while (!bot.interrupt_code && entityAlive(bot, entity) && shots < MAX_VOLLEY) {
                // Kite: if the target closed inside bow range, back off a few blocks
                // first. This naturally keeps archers behind the melee defenders.
                if (bot.entity.position.distanceTo(entity.position) < BOW_MIN) {
                    try { await skills.moveAwayFromEntity(bot, entity, 6); } catch { /* no retreat path */ }
                }
                if (!canShootBow(bot, entity)) break; // out of range/arrows after repositioning
                if (!await shootBowAt(bot, entity)) break;
                shots++;
            }
            if (!entityAlive(bot, entity)) return true;
            // Out of arrows or the target closed the gap → finish with whatever melee we have.
        } else {
            if (inventoryHas(bot, 'shield')) {
                try { await skills.equip(bot, 'shield'); } catch { /* melee still works */ }
            }
            const weapon = bestMeleeWeapon(bot);
            if (weapon) {
                try { await skills.equip(bot, weapon); } catch { /* pvp picks a weapon anyway */ }
            }
        }
        return await skills.attackEntity(bot, entity, true);
    } finally {
        try { bot.deactivateItem(); } catch { /* disconnected */ }
        try { bot.pvp?.stop?.(); } catch { /* not fighting */ }
        bot.modes?.unpause('self_defense');
        bot.modes?.unpause('cowardice');
    }
}

// Keep every bot's combat kit topped up: a bow + arrows for all, plus a shield
// for defenders. Best-effort: pull from shared storage first, otherwise craft.
// Call this on a cooldown so it never flails when materials are missing.
export async function ensureCombatKit(agent, options = {}) {
    const bot = agent.bot;
    const style = getCombatStyle(agent);
    const gatherRangedMaterials = options.gather ?? (style === 'archer');
    const arrowTarget = options.arrowTarget ?? (
        style === 'archer' ? ARCHER_ARROW_TARGET : DEFENDER_ARROW_TARGET
    );
    let changed = false;
    const beforeMaterials = rangedMaterialScore(bot);

    if (!inventoryHas(bot, 'bow') && await craftBowIfPossible(bot, gatherRangedMaterials))
        changed = true;

    if (inventoryHas(bot, 'bow') && arrowCount(bot) < arrowTarget
        && await craftArrowsIfPossible(bot, arrowTarget, gatherRangedMaterials))
        changed = true;

    if (style === 'defender' && !inventoryHas(bot, 'shield')) {
        if (await storage.takeOnePublicMatching(bot, item => item.name === 'shield', () => 100))
            changed = true;
        else {
            try {
                await base.takeNeeded(bot, { iron_ingot: 1 });
                await base.takeAny(bot, PLANKS, 6);
                if (await skills.craftRecipe(bot, 'shield', 1)) {
                    await skills.equip(bot, 'shield');
                    changed = true;
                }
            } catch { /* missing iron / planks / table */ }
        }
    }
    return changed || rangedMaterialScore(bot) > beforeMaterials;
}

export function needsCombatKit(agent) {
    const bot = agent.bot;
    const style = getCombatStyle(agent);
    const arrowTarget = style === 'archer' ? ARCHER_ARROW_TARGET : DEFENDER_ARROW_TARGET;
    if (!inventoryHas(bot, 'bow')) return true;
    if (arrowCount(bot) < arrowTarget) return true;
    if (style === 'defender' && !inventoryHas(bot, 'shield')) return true;
    return false;
}
