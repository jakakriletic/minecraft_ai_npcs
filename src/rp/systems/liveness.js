// Deterministic liveness and squad combat. ZERO LLM.
// NPCs agree on urgent targets through their shared in-process registry, protect
// nearby allies/players, spread around a fight, use bows only on a clear firing
// lane, and disengage before low health or a creeper turns into a death spiral.
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import { Vec3 } from 'vec3';

const HOSTILE = new Set([
    'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged',
    'wither_skeleton', 'spider', 'cave_spider', 'creeper', 'witch', 'slime',
    'magma_cube', 'silverfish', 'endermite', 'enderman', 'phantom', 'pillager',
    'vindicator', 'evoker', 'ravager', 'vex', 'zoglin', 'hoglin', 'piglin_brute',
    'blaze', 'ghast', 'guardian', 'elder_guardian', 'shulker', 'zombified_piglin',
    'zombie_pigman', 'breeze', 'warden',
]);
// Ordered by practical Java-edition DPS for the PvP plugin's full-cooldown hits.
const WEAPONS = ['netherite_sword', 'diamond_sword', 'netherite_axe', 'iron_sword',
    'diamond_axe', 'iron_axe', 'stone_axe', 'stone_sword', 'wooden_axe', 'golden_axe',
    'wooden_sword', 'golden_sword'];
const PASSIVE = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'cat', 'wolf', 'villager', 'fox', 'goat']);
const THREAT_PRIORITY = {
    warden: 120,
    creeper: 60,
    evoker: 48,
    witch: 44,
    ravager: 42,
    vex: 38,
    skeleton: 32,
    stray: 32,
    bogged: 32,
    pillager: 32,
    blaze: 30,
    ghast: 30,
    phantom: 28,
    cave_spider: 26,
};

export function combatParams(cfg = {}) {
    return {
        threatRange: cfg.threat_range ?? 12,
        assistRange: cfg.assist_range ?? 24,
        allyDangerRange: cfg.ally_danger_range ?? 7,
        fleeHpBelow: cfg.flee_hp_below ?? 8,
        braveToFight: cfg.brave_to_fight ?? 40,
        braveForCreeper: cfg.brave_for_creeper ?? 75,
        combatMs: cfg.combat_interval_ms ?? 1000,
        combatTimeoutMs: cfg.combat_timeout_ms ?? 30_000,
        fidgetMs: cfg.fidget_interval_ms ?? 4000,
        bowMinRange: cfg.bow_min_range ?? 5,
        bowPreferredRange: cfg.bow_preferred_range ?? 9,
        bowMaxRange: cfg.bow_max_range ?? 28,
        friendlyFireRadius: cfg.friendly_fire_radius ?? 1.7,
        creeperRetreatRange: cfg.creeper_retreat_range ?? 5,
    };
}

export function attachLiveness(npc, cfg = {}) {
    const bot = npc.bot;
    const p = combatParams(cfg);
    npc.defending = false;

    const combat = setInterval(() => defenseLoop(npc, p).catch(e => npc.log.warn(`defense: ${e.message}`)), p.combatMs);
    const fidget = setInterval(() => fidgetLoop(npc, p).catch(() => {}), p.fidgetMs + Math.random() * 2000);

    bot.once('end', () => { clearInterval(combat); clearInterval(fidget); });
}

// ---------- defense ----------
async function defenseLoop(npc, p) {
    const bot = npc.bot;
    if (!bot?.entity || npc._inCombat) return;

    const threat = selectCombatThreat(npc, p);
    if (!threat) return;
    const shouldFight = shouldFightThreat(npc, threat, p);
    const immediateDangerRange = threat.name === 'creeper'
        ? p.creeperRetreatRange + 1
        : p.threatRange;
    // A distant threat near an ally should summon capable helpers, but it should
    // not repeatedly cancel the work of a hurt/cautious NPC that is itself safe.
    if (!shouldFight
        && threat.position.distanceTo(bot.entity.position) > immediateDangerRange) return;

    npc._inCombat = true;
    npc.defending = true;
    bot.pathfinder.stop(); // drop whatever the job was walking toward
    try {
        if (shouldFight) {
            await fight(npc, threat, p);
        } else {
            const reason = bot.health <= p.fleeHpBelow
                ? 'low HP'
                : threat.name === 'creeper'
                    ? 'not the designated creeper interceptor'
                    : 'outmatched';
            npc.log.info(`${reason} — regrouping away from ${threat.name}`);
            await flee(npc, threat, p);
        }
    } finally {
        npc.defending = false;
        npc._inCombat = false;
    }
}

function npcNames(npc) {
    const names = new Set();
    for (const other of npc.registry ?? []) {
        if (other?.cfg?.id) names.add(String(other.cfg.id).toLowerCase());
        if (other?.cfg?.username) names.add(String(other.cfg.username).toLowerCase());
    }
    return names;
}

function protectedPeople(npc, range) {
    const bot = npc.bot;
    const names = npcNames(npc);
    const admins = new Set((npc.settings?.admin_players ?? []).map(name => String(name).toLowerCase()));
    const people = [{
        name: bot.username,
        position: bot.entity.position,
        health: bot.health ?? 20,
        self: true,
    }];
    for (const player of Object.values(bot.players ?? {})) {
        if (!player?.entity?.position || player.username === bot.username) continue;
        const name = String(player.username ?? '').toLowerCase();
        if (!names.has(name) && !admins.has(name)) continue;
        if (player.entity.position.distanceTo(bot.entity.position) > range) continue;
        const member = (npc.registry ?? []).find(other =>
            String(other?.cfg?.username ?? '').toLowerCase() === name
            || String(other?.cfg?.id ?? '').toLowerCase() === name);
        people.push({
            name: player.username,
            position: player.entity.position,
            health: member?.bot?.health ?? player.entity.health ?? 20,
            self: false,
        });
    }
    return people;
}

function focusCount(npc, entityId) {
    return (npc.registry ?? []).filter(other =>
        other?._combatTargetId === entityId
        && other.bot?.entity
        && other.bot.health > 0).length;
}

function entityValid(bot, entity) {
    return Boolean(entity?.position)
        && entity.isValid !== false
        && Boolean(bot.entities?.[entity.id]);
}

// Group target selection: candidates close to any protected NPC/admin are scored
// from the same shared reference set. An existing squad focus is sticky so the
// group finishes dangerous mobs instead of spreading damage across a whole pack.
export function selectCombatThreat(npc, cfg = {}) {
    const p = 'assistRange' in cfg ? cfg : combatParams(cfg);
    const bot = npc.bot;
    if (!bot?.entity) return null;
    const people = protectedPeople(npc, p.assistRange);
    let best = null;
    for (const entity of Object.values(bot.entities ?? {})) {
        if (!entityValid(bot, entity) || !HOSTILE.has(entity.name)) continue;
        const selfDistance = entity.position.distanceTo(bot.entity.position);
        if (selfDistance > p.assistRange) continue;
        let nearest = Infinity;
        let endangeredHealth = 20;
        for (const person of people) {
            const distance = entity.position.distanceTo(person.position);
            if (distance < nearest) {
                nearest = distance;
                endangeredHealth = person.health;
            }
        }
        if (selfDistance > p.threatRange && nearest > p.allyDangerRange) continue;

        const score = (THREAT_PRIORITY[entity.name] ?? 18)
            + Math.max(0, p.assistRange - nearest) * 7
            + Math.max(0, p.allyDangerRange - selfDistance) * 8
            + Math.max(0, 16 - endangeredHealth) * 3
            + focusCount(npc, entity.id) * 24
            + (npc._combatTargetId === entity.id ? 16 : 0)
            - selfDistance * 0.2;
        if (!best || score > best.score
            || (score === best.score && Number(entity.id) < Number(best.entity.id)))
            best = { entity, score };
    }
    return best?.entity ?? null;
}

function inventoryItem(bot, name) {
    return bot.inventory?.items?.().find(item => item.name === name) ?? null;
}

function hasBowKit(bot) {
    return Boolean(inventoryItem(bot, 'bow'))
        && Boolean(inventoryItem(bot, 'arrow'))
        && typeof bot.hawkEye?.getMasterGrade === 'function';
}

function hasShield(bot) {
    return Boolean(inventoryItem(bot, 'shield'));
}

function hasMeleeWeapon(bot) {
    return WEAPONS.some(name => inventoryItem(bot, name));
}

function nearbyReadyAllies(npc, threat, p) {
    return (npc.registry ?? []).filter(other => other !== npc
        && other?.bot?.entity
        && other.bot.health > p.fleeHpBelow
        && other.bot.entity.position.distanceTo(threat.position) <= p.assistRange);
}

function creeperResponder(npc, threat, p) {
    const candidates = [npc, ...(npc.registry ?? []).filter(other => other !== npc)]
        .filter(other => other?.bot?.entity
            && other.bot.health > p.fleeHpBelow
            && other.bot.entity.position.distanceTo(threat.position) <= p.assistRange)
        .map(other => ({
            npc: other,
            ranged: hasBowKit(other.bot) ? 1 : 0,
            shield: hasShield(other.bot) ? 1 : 0,
            health: other.bot.health ?? 0,
            courage: other.state?.data?.lastnosti?.pogum ?? 50,
            distance: other.bot.entity.position.distanceTo(threat.position),
        }))
        .filter(entry => entry.ranged || entry.shield)
        .sort((a, b) => b.ranged - a.ranged
            || b.shield - a.shield
            || b.health - a.health
            || b.courage - a.courage
            || a.distance - b.distance
            || String(a.npc.cfg?.username ?? a.npc.cfg?.id).localeCompare(
                String(b.npc.cfg?.username ?? b.npc.cfg?.id)));
    return candidates[0]?.npc ?? null;
}

export function shouldFightThreat(npc, threat, cfg = {}) {
    const p = 'assistRange' in cfg ? cfg : combatParams(cfg);
    const bot = npc.bot;
    if (!entityValid(bot, threat) || bot.health <= p.fleeHpBelow) return false;
    if (threat.name === 'warden') return false;
    if (threat.name === 'creeper') {
        const responder = creeperResponder(npc, threat, p);
        if (responder !== npc) return false;
    }
    const allies = nearbyReadyAllies(npc, threat, p).length;
    const courage = npc.state?.data?.lastnosti?.pogum ?? 50;
    const baseThreshold = threat.name === 'creeper' ? p.braveForCreeper : p.braveToFight;
    const woundedPenalty = bot.health <= p.fleeHpBelow + 4 ? 12 : 0;
    const squadBonus = Math.min(24, allies * 6);
    const armedBonus = hasBowKit(bot) || hasMeleeWeapon(bot) ? 8 : 0;
    const guardBonus = ['guard', 'policeman'].includes(npc.cfg?.job) ? 10 : 0;
    return courage + squadBonus + armedBonus + guardBonus >= baseThreshold + woundedPenalty;
}

function announceCombat(npc, lines) {
    const now = Date.now();
    if (now - (npc._lastCombatChatAt ?? 0) < 15_000) return;
    npc._lastCombatChatAt = now;
    npc.bot.chat(pickLine(lines));
}

async function safePvpStop(bot) {
    try {
        if (typeof bot.pvp?.forceStop === 'function') bot.pvp.forceStop();
        else await bot.pvp?.stop?.();
    } catch { /* disconnected or path already stopped */ }
}

async function prepareMelee(bot, npcName) {
    try { await bot.armorManager?.equipAll?.(); } catch { /* optional armor plugin */ }
    const shield = inventoryItem(bot, 'shield');
    if (shield) {
        try { await bot.equip(shield, 'off-hand'); } catch { /* melee still works */ }
    }
    await equipWeapon(bot);
    if (bot.pvp) {
        let hash = 0;
        for (const char of String(npcName ?? bot.username))
            hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
        bot.pvp.followRange = 2.35 + (hash % 4) * 0.2;
        bot.pvp.attackRange = 3.35;
        bot.pvp.viewDistance = 40;
    }
}

function friendlyPositions(npc) {
    return Object.values(npc.bot.players ?? {})
        .filter(player => player?.entity?.position && player.username !== npc.bot.username)
        .map(player => player.entity.position.offset(0, 1, 0));
}

export function trajectoryClearOfFriendPositions(points, friends, radius = 1.7) {
    if (!Array.isArray(points) || points.length === 0) return false;
    return !points.some(point => friends.some(friend => point.distanceTo(friend) < radius));
}

async function shootBow(npc, entity, p) {
    const bot = npc.bot;
    if (!hasBowKit(bot) || !entityValid(bot, entity)) return false;
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance < p.bowMinRange || distance > p.bowMaxRange) return false;
    if (typeof bot.canSeeEntity === 'function' && !bot.canSeeEntity(entity)) return false;
    let grade;
    try {
        grade = bot.hawkEye.getMasterGrade(entity, entity.velocity ?? new Vec3(0, 0, 0), 'bow');
    } catch {
        return false;
    }
    if (!grade || grade.blockInTrayect) return false;
    if (!trajectoryClearOfFriendPositions(
        grade.arrowTrajectoryPoints,
        friendlyPositions(npc),
        p.friendlyFireRadius,
    )) return false;
    const bow = inventoryItem(bot, 'bow');
    try {
        await bot.equip(bow, 'hand');
        await bot.hawkEye.simplyShot(grade.yaw, grade.pitch);
        return true;
    } catch {
        try { bot.deactivateItem(); } catch { /* disconnected */ }
        return false;
    }
}

function nameAngle(name, entityId = 0) {
    let hash = Number(entityId) || 0;
    for (const char of String(name ?? ''))
        hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    return (hash % 360) * Math.PI / 180;
}

export function combatSlot(name, targetPosition, radius, entityId = 0) {
    const angle = nameAngle(name, entityId);
    return targetPosition.offset(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
}

async function repositionArcher(npc, target, p) {
    const bot = npc.bot;
    const slot = combatSlot(npc.cfg?.username ?? npc.cfg?.id, target.position,
        p.bowPreferredRange, target.id);
    try {
        bot.pathfinder.setGoal(new goals.GoalNear(
            Math.floor(slot.x),
            Math.floor(bot.entity.position.y),
            Math.floor(slot.z),
            2,
        ));
        const deadline = Date.now() + 1800;
        while (Date.now() < deadline && entityValid(bot, target)) {
            const distance = bot.entity.position.distanceTo(target.position);
            if (distance >= p.bowMinRange
                && bot.entity.position.distanceTo(slot) <= 3) break;
            await wait(150);
        }
    } finally {
        bot.pathfinder.stop();
    }
}

async function fight(npc, initialMob, p) {
    const bot = npc.bot;
    if (bot.isSleeping) { try { await bot.wake(); } catch { /* */ } }
    try { await bot.armorManager?.equipAll?.(); } catch { /* optional armor plugin */ }
    npc.log.info(`coordinated defense against ${initialMob.name}!`);
    announceCombat(npc, ['Držimo skupaj!', 'Krijem vas!', 'Na isto tarčo!', 'Pazi na bok!']);

    const deadline = Date.now() + p.combatTimeoutMs;
    let mob = initialMob;
    let meleeTargetId = null;
    let rangedFailures = 0;
    try {
        while (Date.now() < deadline && !npc.stopped) {
            const target = bot.entities?.[mob.id];
            if (!target?.position) {
                await safePvpStop(bot);
                meleeTargetId = null;
                mob = selectCombatThreat(npc, p);
                if (!mob || !shouldFightThreat(npc, mob, p)) break;
                rangedFailures = 0;
                continue;
            }
            npc._combatTargetId = target.id;
            const distance = target.position.distanceTo(bot.entity.position);
            if (distance > p.assistRange + 4) break;
            if (bot.health <= p.fleeHpBelow) {
                npc.log.info('HP too low mid-fight — breaking off and regrouping');
                await safePvpStop(bot);
                await flee(npc, target, p);
                return;
            }

            // Exactly one equipped member handles a creeper. Everyone else was
            // filtered by shouldFightThreat and moves clear instead of dog-piling.
            if (target.name === 'creeper'
                && distance < p.creeperRetreatRange
                && !hasShield(bot)) {
                await safePvpStop(bot);
                meleeTargetId = null;
                await repositionArcher(npc, target, p);
                if (!hasBowKit(bot)) {
                    await flee(npc, target, p);
                    return;
                }
                continue;
            }

            if (hasBowKit(bot) && rangedFailures < 2) {
                await safePvpStop(bot);
                meleeTargetId = null;
                if (distance < p.bowMinRange) {
                    await repositionArcher(npc, target, p);
                    rangedFailures++;
                } else if (await shootBow(npc, target, p)) {
                    rangedFailures = 0;
                } else {
                    await repositionArcher(npc, target, p);
                    rangedFailures++;
                }
                await wait(150);
                continue;
            }

            await prepareMelee(bot, npc.cfg?.username ?? npc.cfg?.id);
            if (meleeTargetId !== target.id) {
                await bot.pvp.attack(target);
                meleeTargetId = target.id;
            }
            await wait(300);
        }
    } finally {
        await safePvpStop(bot);
        delete npc._combatTargetId;
    }
    npc.eventLog?.add({
        tip: 'branil_se',
        akter: 'pošast',
        podrobnost: `usklajeno se je branil pred ${initialMob.name}`,
    });
}

async function flee(npc, mob, p) {
    const bot = npc.bot;
    if (bot.isSleeping) { try { await bot.wake(); } catch { /* */ } }
    await safePvpStop(bot);
    announceCombat(npc, ['Umik!', 'Preveč jih je!', 'Nazaj na varno!', 'Drži razdaljo!']);

    // Score several escape directions. Home is used only when it is actually
    // farther from the nearby mob pack; this avoids the old "run home through a
    // creeper" behaviour. A healthy, non-fighting ally is another rally option.
    const home = npc.locations?.[npc.cfg.home_region];
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        const target = bot.entities[mob.id];
        if (!target || target.position.distanceTo(bot.entity.position) > p.threatRange + 6) break;
        try {
            const destination = safestRetreatPosition(npc, target, p, home);
            const goal = new goals.GoalNear(
                Math.floor(destination.x),
                Math.floor(destination.y),
                Math.floor(destination.z),
                2,
            );
            bot.pathfinder.setGoal(goal);
        } catch { /* */ }
        await wait(700);
    }
    bot.pathfinder.stop();
}

function nearbyHostiles(bot, range) {
    return Object.values(bot.entities ?? {}).filter(entity =>
        entityValid(bot, entity)
        && HOSTILE.has(entity.name)
        && entity.position.distanceTo(bot.entity.position) <= range);
}

function minThreatDistance(position, threats) {
    return threats.reduce((minimum, threat) =>
        Math.min(minimum, position.distanceTo(threat.position)), Infinity);
}

export function safestRetreatPosition(npc, mob, cfg = {}, home = null) {
    const p = 'assistRange' in cfg ? cfg : combatParams(cfg);
    const bot = npc.bot;
    const threats = nearbyHostiles(bot, p.assistRange);
    const delta = bot.entity.position.minus(mob.position);
    const horizontal = new Vec3(delta.x, 0, delta.z);
    const away = horizontal.norm() > 0.01
        ? horizontal.normalize().scaled(12)
        : new Vec3(12, 0, 0);
    const direct = bot.entity.position.plus(away);
    const candidates = [direct];
    if (home?.center) candidates.push(new Vec3(home.center.x, home.center.y, home.center.z));
    for (const other of npc.registry ?? []) {
        if (other === npc || !other?.bot?.entity || other.defending) continue;
        if (other.bot.health <= p.fleeHpBelow + 4) continue;
        candidates.push(other.bot.entity.position);
    }
    return candidates
        .map(position => ({
            position,
            score: minThreatDistance(position, threats) * 10
                - position.distanceTo(bot.entity.position) * 0.25,
        }))
        .sort((a, b) => b.score - a.score)[0].position;
}

async function equipWeapon(bot) {
    for (const name of WEAPONS) {
        const it = bot.inventory.items().find(i => i.name === name);
        if (it) { try { await bot.equip(it, 'hand'); } catch { /* */ } return; }
    }
}

// ---------- idle fidgets ----------
async function fidgetLoop(npc, p) {
    const bot = npc.bot;
    if (!bot?.entity || npc.busy || npc.defending || npc._inCombat) return;
    if (bot.isSleeping) return;
    if (bot.pathfinder.isMoving()) return; // only fidget while standing still

    const r = Math.random();
    if (r < 0.42) {
        // glance at the nearest player
        const player = nearestPlayer(npc, 14);
        if (player) return lookAtEntity(bot, player);
        return glanceAround(bot);
    } else if (r < 0.68) {
        // watch a passing animal / neighbour
        const ent = nearestInteresting(npc, 12);
        if (ent) return lookAtEntity(bot, ent);
        return glanceAround(bot);
    } else if (r < 0.96) {
        return glanceAround(bot);
    } else {
        // the odd little hop — feels restless/alive
        try {
            bot.setControlState('jump', true);
            await wait(250);
        } finally {
            bot.setControlState('jump', false);
        }
    }
}

function nearestPlayer(npc, range) {
    const bot = npc.bot;
    let best = null, bestD = range;
    for (const pl of Object.values(bot.players)) {
        if (!pl.entity || pl.username === bot.username) continue;
        if (npc.settings.npcs.some(id => id.toLowerCase() === pl.username.toLowerCase())) continue;
        const d = pl.entity.position.distanceTo(bot.entity.position);
        if (d < bestD) { bestD = d; best = pl.entity; }
    }
    return best;
}

function nearestInteresting(npc, range) {
    const bot = npc.bot;
    let best = null, bestD = range;
    for (const e of Object.values(bot.entities)) {
        if (!e?.position || e === bot.entity) continue;
        const ok = PASSIVE.has(e.name) || e.name === 'item' ||
            (e.type === 'player' && npc.settings.npcs.some(id => id.toLowerCase() === e.username?.toLowerCase()));
        if (!ok) continue;
        const d = e.position.distanceTo(bot.entity.position);
        if (d < bestD) { bestD = d; best = e; }
    }
    return best;
}

async function lookAtEntity(bot, ent) {
    try { await bot.lookAt(ent.position.offset(0, ent.height ? ent.height * 0.9 : 1.4, 0), false); }
    catch { /* */ }
}

async function glanceAround(bot) {
    const yaw = bot.entity.yaw + (Math.random() - 0.5) * Math.PI; // turn head a bit
    const pitch = (Math.random() - 0.5) * 0.5;
    try { await bot.look(yaw, pitch, false); } catch { /* */ }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const pickLine = (arr) => arr[Math.floor(Math.random() * arr.length)];
