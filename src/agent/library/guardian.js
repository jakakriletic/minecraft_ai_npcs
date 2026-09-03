// Deterministic guard behavior: acquire the best defensive equipment from
// shared storage, use a bow when the shot is safe, and stay near vulnerable
// society members instead of wandering independently.
import { Vec3 } from 'vec3';
import settings from '../../../settings.js';
import * as base from './base.js';
import * as combat from './combat.js';
import * as skills from './skills.js';
import * as society from './society.js';
import * as storage from './storage.js';
import * as world from './world.js';

const ARMOR_SLOTS = ['torso', 'legs', 'head', 'feet'];
const ARMOR_NAMES = {
    torso: 'chestplate',
    legs: 'leggings',
    head: 'helmet',
    feet: 'boots',
};
const ARMOR_POINTS = {
    leather: { head: 1, torso: 3, legs: 2, feet: 1 },
    golden: { head: 2, torso: 5, legs: 3, feet: 1 },
    chainmail: { head: 2, torso: 5, legs: 4, feet: 1 },
    iron: { head: 2, torso: 6, legs: 5, feet: 2 },
    diamond: { head: 3, torso: 8, legs: 6, feet: 3 },
    netherite: { head: 3, torso: 8, legs: 6, feet: 3 },
    turtle: { head: 2, torso: 0, legs: 0, feet: 0 },
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function armorSlot(itemOrName) {
    const name = typeof itemOrName === 'string' ? itemOrName : itemOrName?.name;
    if (!name) return null;
    return ARMOR_SLOTS.find(slot => name.includes(ARMOR_NAMES[slot])) ?? null;
}

function armorTier(name) {
    return Object.keys(ARMOR_POINTS).find(tier => name.startsWith(`${tier}_`)) ?? null;
}

function enchantments(item) {
    if (Array.isArray(item?.enchants)) return item.enchants;
    const values = item?.nbt?.value?.Enchantments?.value?.value
        ?? item?.nbt?.value?.enchantments?.value?.value
        ?? [];
    return Array.isArray(values) ? values.map(enchantment => ({
        name: enchantment.id?.value ?? enchantment.id ?? '',
        lvl: enchantment.lvl?.value ?? enchantment.lvl ?? 0,
    })) : [];
}

function enchantmentScore(item) {
    const weights = {
        protection: 0.7,
        blast_protection: 0.45,
        projectile_protection: 0.4,
        fire_protection: 0.35,
        feather_falling: 0.3,
        respiration: 0.12,
        unbreaking: 0.08,
        mending: 0.4,
        power: 0.3,
        punch: 0.15,
        flame: 0.2,
        infinity: 0.5,
    };
    return enchantments(item).reduce((total, enchantment) => {
        const rawName = enchantment.name ?? enchantment.id ?? '';
        const name = String(rawName).replace('minecraft:', '');
        const level = Number(enchantment.lvl ?? enchantment.level ?? 0);
        return total + (weights[name] ?? 0.05) * Math.max(1, level);
    }, 0);
}

export function guardianEquipmentScore(item) {
    const slot = armorSlot(item);
    if (!slot) {
        if (item?.name === 'shield') return 5 + enchantmentScore(item);
        if (item?.name === 'bow') return 4 + enchantmentScore(item);
        return 0;
    }
    const tier = armorTier(item.name);
    const points = ARMOR_POINTS[tier]?.[slot] ?? 0;
    const toughness = tier === 'netherite' ? 1.5 : tier === 'diamond' ? 1 : 0;
    const knockback = tier === 'netherite' ? 0.5 : 0;
    const maxDurability = item.maxDurability ?? null;
    const durabilityRatio = maxDurability
        ? Math.max(0, 1 - (item.durabilityUsed ?? 0) / maxDurability)
        : 1;
    return points + toughness + knockback + enchantmentScore(item) + durabilityRatio * 0.1;
}

function equipped(bot, destination) {
    if (typeof bot.getEquipmentDestSlot !== 'function') return null;
    const slot = bot.getEquipmentDestSlot(destination);
    return bot.inventory.slots[slot] ?? null;
}

function inventoryHas(bot, name) {
    if (bot.inventory.items().some(item => item.name === name)) return true;
    if (name === 'shield') return equipped(bot, 'off-hand')?.name === 'shield';
    return false;
}

function currentArmorScores(bot) {
    return Object.fromEntries(ARMOR_SLOTS.map(slot => [
        slot,
        guardianEquipmentScore(equipped(bot, slot)),
    ]));
}

export function needsGuardianLoadout(bot) {
    return ARMOR_SLOTS.some(slot => !equipped(bot, slot))
        || !inventoryHas(bot, 'shield')
        || !inventoryHas(bot, 'bow')
        || (world.getInventoryCounts(bot).arrow ?? 0) < 8;
}

export async function improveLoadout(agent) {
    if (settings.kingdom_guardians === false)
        return false;
    const bot = agent.bot;
    try { await bot.armorManager.equipAll(); } catch { /* optional plugin */ }

    const scores = currentArmorScores(bot);
    const hasShield = inventoryHas(bot, 'shield');
    const hasBow = inventoryHas(bot, 'bow');
    const candidate = await storage.takeOnePublicMatching(
        bot,
        item => {
            const slot = armorSlot(item);
            if (slot) return guardianEquipmentScore(item) > scores[slot] + 0.05;
            if (item.name === 'shield') return !hasShield;
            if (item.name === 'bow') return !hasBow;
            return false;
        },
        item => {
            const slot = armorSlot(item);
            if (slot) return 1000 + (guardianEquipmentScore(item) - scores[slot]) * 100;
            if (item.name === 'shield') return 700 + guardianEquipmentScore(item);
            if (item.name === 'bow') return 600 + guardianEquipmentScore(item);
            return 0;
        },
    );

    if (candidate) {
        try { await bot.armorManager.equipAll(); } catch { /* optional plugin */ }
        if (candidate.name === 'shield') {
            try { await skills.equip(bot, 'shield'); } catch { /* equip on next combat */ }
        }
        if (candidate.name === 'bow' && (world.getInventoryCounts(bot).arrow ?? 0) < 24)
            await storage.takeNeededPublic(bot, { arrow: 24 });
        skills.log(bot, `Varuh je prevzel boljso opremo: ${candidate.name}.`);
        return true;
    }

    if (hasBow && (world.getInventoryCounts(bot).arrow ?? 0) < 24
        && await storage.takeNeededPublic(bot, { arrow: 24 }))
        return true;

    if (hasBow && (world.getInventoryCounts(bot).arrow ?? 0) < 8) {
        try {
            await base.takeNeeded(bot, { flint: 4, stick: 4, feather: 4 });
            if (await skills.craftRecipe(bot, 'arrow', 16)) return true;
        } catch { /* missing flint, sticks, feathers or crafting table */ }
    }

    if (!hasShield) {
        try {
            await base.takeNeeded(bot, { iron_ingot: 1 });
            await base.takeAny(bot, [
                'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
                'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
            ], 6);
            if (await skills.craftRecipe(bot, 'shield', 1)) {
                await skills.equip(bot, 'shield');
                return true;
            }
        } catch { /* missing planks or table */ }
    }
    if (!hasBow) {
        try {
            await base.takeNeeded(bot, { string: 3, stick: 3 });
            if (await skills.craftRecipe(bot, 'bow', 1)) return true;
        } catch { /* missing string or table */ }
    }
    return await combat.ensureCombatKit(agent, { gather: true, arrowTarget: 24 });
}

function entityAlive(bot, entity) {
    return Boolean(entity?.position)
        && entity.isValid !== false
        && Object.values(bot.entities).includes(entity);
}

export function isFriendlyShotClear(bot, from, target) {
    const direction = target.minus(from);
    const lengthSquared = direction.dot(direction);
    if (lengthSquared <= 0.01) return false;
    return !Object.values(bot.players).some(player => {
        if (!player.entity || player.username === bot.username) return false;
        const point = player.entity.position.offset(0, 1, 0);
        const projection = Math.max(0, Math.min(1, point.minus(from).dot(direction) / lengthSquared));
        const nearest = from.plus(direction.scaled(projection));
        return projection > 0.08 && projection < 0.95 && nearest.distanceTo(point) < 1.35;
    });
}

function bowAim(bot, entity) {
    const from = bot.entity.position.offset(0, 1.62, 0);
    const horizontal = Math.hypot(
        entity.position.x - from.x,
        entity.position.z - from.z,
    );
    const flightTicks = Math.min(12, horizontal / 2.8);
    const velocity = entity.velocity ?? new Vec3(0, 0, 0);
    const dropCompensation = Math.min(2.4, horizontal * horizontal * 0.0022);
    return entity.position
        .plus(velocity.scaled(flightTicks))
        .offset(0, (entity.height ?? 1.8) * 0.65 + dropCompensation, 0);
}

async function shootBow(bot, entity) {
    const bow = bot.inventory.items().find(item => item.name === 'bow');
    const arrows = world.getInventoryCounts(bot).arrow ?? 0;
    if (!bow || arrows < 1 || !entityAlive(bot, entity)) return false;
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance < 6 || distance > 30) return false;
    if (typeof bot.canSeeEntity === 'function' && !bot.canSeeEntity(entity)) return false;

    const from = bot.entity.position.offset(0, 1.62, 0);
    let aim = bowAim(bot, entity);
    if (!isFriendlyShotClear(bot, from, aim)) return false;

    try {
        if (!await skills.equipItemSafely(bot, bow, 'hand')) return false;
        await bot.lookAt(aim, true);
        bot.activateItem();
        for (let elapsed = 0; elapsed < 1000; elapsed += 100) {
            if (bot.interrupt_code || !entityAlive(bot, entity)) {
                bot.deactivateItem();
                return false;
            }
            await sleep(100);
        }
        aim = bowAim(bot, entity);
        if (!isFriendlyShotClear(bot, bot.entity.position.offset(0, 1.62, 0), aim)) {
            bot.deactivateItem();
            return false;
        }
        await bot.lookAt(aim, true);
        bot.deactivateItem();
        await sleep(350);
        return true;
    } catch {
        try { bot.deactivateItem(); } catch { /* disconnected */ }
        return false;
    }
}

export async function protectSociety(agent, threat) {
    const bot = agent.bot;
    const entity = threat?.entity ?? threat;
    if (!entityAlive(bot, entity)) return false;
    const previousCombatExemption = bot._guardianCombatExempt;
    bot._guardianCombatExempt = true;
    try { await bot.armorManager.equipAll(); } catch { /* optional plugin */ }
    if (inventoryHas(bot, 'shield')) {
        try { await skills.equip(bot, 'shield'); } catch { /* melee still works */ }
    }

    bot.modes.pause('cowardice');
    bot.modes.pause('self_defense');
    try {
        let shots = 0;
        while (!bot.interrupt_code && entityAlive(bot, entity) && shots < 4) {
            const distance = bot.entity.position.distanceTo(entity.position);
            if (distance > 30) {
                const reached = await skills.goToPosition(
                    bot,
                    entity.position.x,
                    entity.position.y,
                    entity.position.z,
                    18,
                );
                if (!reached) break;
            }
            if (!await shootBow(bot, entity)) break;
            shots++;
        }
        if (!entityAlive(bot, entity)) {
            skills.log(bot, `Varuh je odstranil nevarnost pri ${threat?.protectedName ?? 'naselbini'}.`);
            return true;
        }
        return await skills.attackEntity(bot, entity, true);
    } finally {
        try { bot.deactivateItem(); } catch { /* disconnected */ }
        bot.pvp?.stop?.();
        bot.modes.unpause('self_defense');
        bot.modes.unpause('cowardice');
        if (previousCombatExemption === undefined)
            delete bot._guardianCombatExempt;
        else
            bot._guardianCombatExempt = previousCombatExemption;
    }
}

function nameAngle(name) {
    let hash = 0;
    for (const char of name)
        hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    return (hash % 360) * Math.PI / 180;
}

export async function patrolSociety(agent, home = base.getBase(agent.bot)) {
    const bot = agent.bot;
    const range = Math.max(16, settings.kingdom_guardian_range ?? 32);
    const members = society.activeMembers(bot)
        .filter(member => member.name !== agent.name)
        .map(member => ({ ...member, entity: bot.players[member.name]?.entity }))
        .filter(member => member.entity
            && member.entity.position.distanceTo(bot.entity.position) <= range)
        .sort((a, b) => (a.health ?? 20) - (b.health ?? 20)
            || a.entity.position.distanceTo(bot.entity.position)
            - b.entity.position.distanceTo(bot.entity.position));
    const anchor = members[0]?.entity?.position
        ?? (home ? new Vec3(home.x, home.y, home.z) : bot.entity.position);
    const angle = nameAngle(agent.name);
    const target = anchor.offset(Math.cos(angle) * 5, 0, Math.sin(angle) * 5);
    if (bot.entity.position.distanceTo(target) <= 4) {
        try { await bot.lookAt(anchor.offset(0, 1.4, 0)); } catch { /* chunk changed */ }
        return await skills.wait(bot, 1200);
    }
    return await skills.goToPosition(bot, target.x, target.y, target.z, 3);
}
