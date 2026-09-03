// Deterministic healer and magician abilities. They intentionally use vanilla
// commands because the NPCs already need command permission for role nameplates.
// The magic attack uses one exact-damage command. Do not animate it with a burst
// of /particle commands: Minecraft counts those chat-command packets as spam and
// can kick the magician (which used to take the whole kingdom process down).
import settings from '../../../settings.js';
import * as skills from './skills.js';
import * as society from './society.js';

const USERNAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function commandNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(2) : '0.00';
}

function playerForName(bot, name) {
    return Object.values(bot.players ?? {}).find(player =>
        player?.entity && player.username?.toLowerCase() === String(name).toLowerCase()) ?? null;
}

export function selectLowestHealthMember(bot, members, selfName, range = 32) {
    if (!bot?.entity?.position) return null;
    return members
        .filter(member => member?.name && member.name.toLowerCase() !== String(selfName).toLowerCase())
        .map(member => {
            const player = playerForName(bot, member.name);
            const health = Number(member.health ?? 20);
            const distance = player?.entity?.position?.distanceTo(bot.entity.position) ?? Infinity;
            return { ...member, health, distance, player, entity: player?.entity ?? null };
        })
        .filter(member => member.entity?.position
            && member.entity.isValid !== false
            && Number.isFinite(member.health)
            && member.health < 20
            && member.distance <= range)
        .sort((a, b) => a.health - b.health
            || a.distance - b.distance
            || a.name.localeCompare(b.name))[0] ?? null;
}

export function findHealingTarget(agent) {
    const range = Math.max(4, Number(settings.kingdom_healer_range ?? 32));
    return selectLowestHealthMember(
        agent.bot,
        society.activeMembers(agent.bot),
        agent.name,
        range,
    );
}

export function regenerationCommand(username, durationSeconds = 2) {
    if (!USERNAME_RE.test(String(username))) return null;
    const duration = Math.max(1, Math.floor(Number(durationSeconds) || 2));
    // Amplifier 0 is Regeneration I. Keep particles visible so the heal is readable.
    return `/effect give ${username} minecraft:regeneration ${duration} 0 false`;
}

export async function healMember(agent, selectedTarget) {
    const bot = agent.bot;
    const target = selectedTarget?.name
        ? selectLowestHealthMember(bot, society.activeMembers(bot), agent.name,
            Math.max(4, Number(settings.kingdom_healer_range ?? 32)))
        : null;
    if (!target) return false;

    if (target.distance > 3.5) {
        const reached = await skills.goToPosition(
            bot,
            target.entity.position.x,
            target.entity.position.y,
            target.entity.position.z,
            3,
        );
        if (!reached || bot.interrupt_code) return false;
    }

    const livePlayer = playerForName(bot, target.name);
    if (!livePlayer?.entity?.position
        || livePlayer.entity.position.distanceTo(bot.entity.position) > 5)
        return false;
    const command = regenerationCommand(target.name, 2);
    if (!command) return false;
    try { await bot.lookAt(livePlayer.entity.position.offset(0, 1.2, 0), true); } catch { /* moved */ }
    bot.chat(command);
    skills.log(bot, `Healer je dal Regeneration I za 2 sekundi igralcu ${target.name}.`);
    return true;
}

export function fireballDamageCommand(entity, damage = 5, casterName = '') {
    const amount = Math.max(0, Number(damage) || 5);
    if (!USERNAME_RE.test(String(casterName))) return null;
    let selector = UUID_RE.test(String(entity?.uuid ?? '')) ? entity.uuid : null;
    if (!selector) {
        const type = String(entity?.name ?? '').replace(/[^a-z0-9_]/g, '');
        const position = entity?.position;
        if (!type || !position) return null;
        selector = `@e[type=minecraft:${type},x=${commandNumber(position.x)},y=${commandNumber(position.y)},z=${commandNumber(position.z)},distance=..2.5,sort=nearest,limit=1]`;
    }
    return `/damage ${selector} ${amount} minecraft:magic by ${casterName}`;
}

function entityAlive(bot, entity) {
    if (!entity?.position || entity.isValid === false) return false;
    if (!bot.entities) return true;
    return bot.entities[entity.id] === entity || Object.values(bot.entities).includes(entity);
}

function friendlyPathClear(bot, from, to) {
    const direction = to.minus(from);
    const lengthSquared = direction.dot(direction);
    if (lengthSquared <= 0.01) return false;
    return !Object.values(bot.players ?? {}).some(player => {
        if (!player.entity || player.username === bot.username) return false;
        const point = player.entity.position.offset(0, 1, 0);
        const projection = Math.max(0, Math.min(1, point.minus(from).dot(direction) / lengthSquared));
        const nearest = from.plus(direction.scaled(projection));
        return projection > 0.08 && projection < 0.95 && nearest.distanceTo(point) < 1.2;
    });
}

async function performFireball(agent, entity) {
    const bot = agent.bot;
    const range = Math.max(8, Number(settings.kingdom_magician_range ?? 24));
    if (!entityAlive(bot, entity)) return false;

    let distance = bot.entity.position.distanceTo(entity.position);
    if (distance > range) return false;
    if (distance > 18 || (typeof bot.canSeeEntity === 'function' && !bot.canSeeEntity(entity))) {
        const reached = await skills.goToPosition(
            bot,
            entity.position.x,
            entity.position.y,
            entity.position.z,
            Math.min(12, range - 2),
        );
        if (!reached || bot.interrupt_code || !entityAlive(bot, entity)) return false;
        distance = bot.entity.position.distanceTo(entity.position);
    }
    if (distance > range || (typeof bot.canSeeEntity === 'function' && !bot.canSeeEntity(entity)))
        return false;

    const impact = entity.position.offset(0, Math.max(0.6, (entity.height ?? 1.6) * 0.55), 0);
    const from = bot.entity.position.offset(0, 1.45, 0);
    if (!friendlyPathClear(bot, from, impact)) return false;
    try { await bot.lookAt(impact, true); } catch { /* target can move while aiming */ }

    if (bot.interrupt_code || !entityAlive(bot, entity)) return false;
    const command = fireballDamageCommand(
        entity,
        settings.kingdom_magician_damage ?? 5,
        bot.username,
    );
    if (!command) return false;
    bot.chat(command);
    skills.log(bot, `Magicianov urok je zadel ${entity.name} za ${settings.kingdom_magician_damage ?? 5} damagea.`);
    return true;
}

export async function castFireball(agent, entity) {
    const bot = agent.bot;
    // The reactive combat modes normally interrupt any brain action. Pause them
    // during this short cast so they cannot replace the spell with melee midway.
    bot.modes?.pause('cowardice');
    bot.modes?.pause('self_defense');
    bot.modes?.pause('npc_defense');
    try {
        return await performFireball(agent, entity);
    } finally {
        bot.modes?.unpause('npc_defense');
        bot.modes?.unpause('self_defense');
        bot.modes?.unpause('cowardice');
    }
}

export function healerCooldownMs() {
    return Math.max(1, Number(settings.kingdom_healer_cooldown_minutes ?? 3)) * 60_000;
}

export function magicianCastCooldownMs() {
    return Math.max(0.5, Number(settings.kingdom_magician_cast_cooldown_seconds ?? 1.2)) * 1000;
}
