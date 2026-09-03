// Event detection + per-NPC event log. Pure deterministic code, no LLM.
// Each bot is its own witness: it observes the world within VIEW_RANGE blocks,
// writes witnessed events to its own event_log.json, and applies a direct
// trust delta from the configurable weights table (settings.event_utezi).
//
// Detected event types:
//   razbil_blok_v_tuji_regiji — someone broke a block inside another NPC's home region
//   odprl_tujo_skrinjo        — someone opened a chest in another NPC's home region
//   udaril_nekoga             — someone hit a player/NPC
//   ubil_zival                — someone killed an animal
import { readFileSync, existsSync } from 'fs';
import { Vec3 } from 'vec3';
import { noteNegativeInteraction } from '../systems/social_bonds.js';
import { writeJsonAtomic } from '../../utils/atomic_json.js';

const VIEW_RANGE = 16;
const LOG_CAP = 200;
const ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey', 'goat', 'cat', 'wolf', 'llama']);

export class EventLog {
    constructor(path) {
        this.path = path;
        this.entries = [];
        if (existsSync(path)) {
            try { this.entries = JSON.parse(readFileSync(path, 'utf8')); } catch { /* fresh */ }
        }
    }
    add(entry) {
        this.entries.push({ ts: new Date().toISOString(), ...entry });
        this.entries = this.entries.slice(-LOG_CAP);
        writeJsonAtomic(this.path, this.entries);
    }
    recent(n = 5) { return this.entries.slice(-n); }
}

// regionOwners: { regionName: npcId } — built from NPC home regions in rp.js
export function attachEventDetection(npc, regionOwners, weights) {
    const bot = npc.bot;
    const swings = new Map();   // entityId -> ts of last arm swing
    const lastHit = new Map();  // victimEntityId -> { attacker, ts }
    const chestCooldown = new Map(); // posKey -> ts (dedupe chest-open spam)

    const actorName = (e) => e?.username ?? e?.name ?? 'neznanec';
    const isNpc = (name) => npc.settings.npcs.some(id => id.toLowerCase() === String(name).toLowerCase());
    const inView = (pos) => pos && bot.entity && pos.distanceTo(bot.entity.position) <= VIEW_RANGE;

    // whose home region contains this position? returns npcId or null
    function ownerAt(pos) {
        for (const [regionName, ownerId] of Object.entries(regionOwners)) {
            const r = npc.locations[regionName];
            if (!r) continue;
            const dx = pos.x - r.center.x, dz = pos.z - r.center.z;
            if (Math.sqrt(dx * dx + dz * dz) <= r.radius) return ownerId;
        }
        return null;
    }

    function witness(tip, akter, podrobnost, pos) {
        if (akter === bot.username) return; // not a witness to own actions
        npc.eventLog.add({ tip, akter, podrobnost, pos: pos ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } : null });
        const w = weights[tip] ?? 0;
        if (w !== 0) {
            const rel = isNpc(akter) ? 'odnosi_npcji' : 'odnosi_igralci';
            npc.state.applyDelta({ [rel]: { [akter]: { zaupanje: w } } }, `event:${tip}`);
            const actorNpc = npc.registry?.find(o =>
                o.cfg.id.toLowerCase() === String(akter).toLowerCase() ||
                o.cfg.username.toLowerCase() === String(akter).toLowerCase());
            const publicId = actorNpc?.cfg.id ?? akter;
            npc.civic?.adjustReputation?.(publicId, {
                public_trust: Math.round(w / 2),
                respect: w > 0 ? 1 : -1,
                notoriety: w < 0 ? Math.min(6, Math.abs(w)) : -1,
            }, `witness:${tip}`);
            if (actorNpc && w < 0) noteNegativeInteraction(npc, publicId, `witness:${tip}`, Math.min(3, Math.abs(w) / 4));
        }
        npc.log.info(`WITNESSED: ${akter} ${tip} (${podrobnost}) -> zaupanje ${weights[tip] ?? 0}`);
    }

    // --- arm swings (for attack attribution) ---
    bot.on('entitySwingArm', (entity) => swings.set(entity.id, Date.now()));

    // --- someone got hurt ---
    bot.on('entityHurt', (victim) => {
        if (!inView(victim.position)) return;
        // attacker = nearest player/mob that swung an arm in the last second
        let attacker = null, best = 5;
        for (const e of Object.values(bot.entities)) {
            if (e.id === victim.id || !e.position) continue;
            const swungAt = swings.get(e.id) ?? 0;
            if (Date.now() - swungAt > 1000) continue;
            const d = e.position.distanceTo(victim.position);
            if (d < best) { best = d; attacker = e; }
        }
        if (!attacker || attacker.id === bot.entity?.id) return;
        lastHit.set(victim.id, { attacker: actorName(attacker), ts: Date.now() });

        const victimIsPerson = victim.type === 'player' || victim.username;
        if (victimIsPerson && actorName(attacker) !== 'neznanec') {
            witness('udaril_nekoga', actorName(attacker), `udaril ${actorName(victim)}`, victim.position);
        }
    });

    // --- something died ---
    bot.on('entityDead', (entity) => {
        if (!entity || !inView(entity.position)) return;
        const hit = lastHit.get(entity.id);
        lastHit.delete(entity.id);
        if (!hit || Date.now() - hit.ts > 5000) return;
        if (ANIMALS.has(entity.name)) {
            witness('ubil_zival', hit.attacker, `ubil ${entity.name}`, entity.position);
        }
    });

    // --- block broken in a foreign home region ---
    bot.on('blockBreakProgressEnd', (block, entity) => {
        if (!block || !entity || !inView(block.position)) return;
        const akter = actorName(entity);
        const owner = ownerAt(block.position);
        if (!owner) return;                       // unowned land — fair game
        if (owner.toLowerCase() === String(akter).toLowerCase()) return; // own property
        witness('razbil_blok_v_tuji_regiji', akter, `razbil ${block.name} pri ${owner}`, block.position);
    });

    // --- chest opened in a foreign home region (lid animation packet) ---
    bot._client.on('block_action', (packet) => {
        try {
            if (packet.byte1 !== 1 || packet.byte2 < 1) return; // lid open only
            const pos = new Vec3(packet.location.x, packet.location.y, packet.location.z);
            if (!inView(pos)) return;
            const block = bot.blockAt(pos);
            if (!block || !['chest', 'trapped_chest', 'barrel'].includes(block.name)) return;

            const key = `${pos.x},${pos.y},${pos.z}`;
            if (Date.now() - (chestCooldown.get(key) ?? 0) < 5000) return;
            chestCooldown.set(key, Date.now());

            const owner = ownerAt(pos);
            if (!owner) return;
            // attribute to nearest player/NPC within 4 blocks
            let opener = null, best = 4;
            for (const e of Object.values(bot.entities)) {
                if (!e.position || e.id === bot.entity?.id) continue;
                if (e.type !== 'player' && !e.username) continue;
                const d = e.position.distanceTo(pos);
                if (d < best) { best = d; opener = e; }
            }
            if (!opener) return;
            const akter = actorName(opener);
            if (owner.toLowerCase() === String(akter).toLowerCase()) return;
            witness('odprl_tujo_skrinjo', akter, `odprl skrinjo pri ${owner}`, pos);
        } catch { /* malformed packet — ignore */ }
    });
}
