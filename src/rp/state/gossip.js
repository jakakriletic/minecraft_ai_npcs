// Gossip: when two NPCs meet during free time, each shares one memory.
// Deterministic copy ("slišal od X") — NO LLM by default. The conversation is
// "staged" in chat with one cheap LLM call ONLY when a player is close enough
// to see it (Potemkin principle: simulate cheaply, perform only for an audience).
//
// Effects on the receiver:
//   - text lands in znanje_o_svetu.slisal ("od Marka slišal: ...")
//   - gossip about a third party moves trust toward them (half the witness weight)
//   - price gossip updates the receiver's price beliefs
// Low-honesty NPCs sometimes DISTORT the gossip (template mutation, free).
import { onSocialized } from '../systems/needs.js';
import { notePositiveInteraction } from '../systems/social_bonds.js';

const MEET_RANGE = 6;
const PLAYER_AUDIENCE_RANGE = 16;
const PAIR_COOLDOWN_MS = 10 * 60_000; // one exchange per pair per 10 real minutes
const CHECK_INTERVAL_MS = 30_000;

const pairCooldowns = new Map(); // "a|b" -> ts (shared across all NPCs in process)

export function attachGossip(npc, weights, llm) {
    const timer = setInterval(() => gossipTick(npc, weights, llm).catch(e => npc.log.warn(`gossip: ${e.message}`)), CHECK_INTERVAL_MS);
    npc.bot.once('end', () => clearInterval(timer));
}

async function gossipTick(npc, weights, llm) {
    const bot = npc.bot;
    if (!bot?.entity || npc.busy || npc.currentActivity === 'sleep') return;
    if (!npc.registry) return;

    for (const other of npc.registry) {
        if (other === npc || !other.bot?.entity) continue;
        if (npc.cfg.id >= other.cfg.id) continue; // smaller id initiates — no double exchange
        if (other.currentActivity === 'sleep' || other.busy) continue;
        if (other.bot.entity.position.distanceTo(bot.entity.position) > MEET_RANGE) continue;

        const pairKey = `${npc.cfg.id}|${other.cfg.id}`;
        if (Date.now() - (pairCooldowns.get(pairKey) ?? 0) < PAIR_COOLDOWN_MS) continue;
        pairCooldowns.set(pairKey, Date.now());

        await exchange(npc, other, weights, llm);
        return; // one exchange per tick
    }
}

async function exchange(a, b, weights, llm) {
    const fromA = pickShareable(a);
    const fromB = pickShareable(b);
    a.log.info(`gossip with ${b.cfg.id}: give="${fromA?.besedilo ?? '-'}" receive="${fromB?.besedilo ?? '-'}"`);

    if (fromA) deliver(a, b, fromA, weights);
    if (fromB) deliver(b, a, fromB, weights);
    onSocialized(a, 8);
    onSocialized(b, 8);
    notePositiveInteraction(a, b, 'gossip_exchange', 0.8);

    // stage the conversation in chat only if a player is watching
    const audience = playersNear(a) || playersNear(b);
    if (audience && llm && (fromA || fromB)) {
        await stageDialogue(a, b, fromA ?? fromB, llm);
    }
}

// pick one shareable memory: witnessed event, heard rumour, or a recent price
function pickShareable(npc) {
    const candidates = [];
    for (const e of npc.eventLog.recent(8)) {
        if (e.tip === 'trgoval') continue; // trades travel as price gossip below
        candidates.push({ besedilo: `${e.akter} je ${e.podrobnost ?? e.tip}`, akter: e.akter, tip: e.tip });
    }
    for (const s of npc.state.data.znanje_o_svetu.slisal.slice(-5)) {
        candidates.push({ besedilo: s }); // re-share (gossip chains!)
    }
    for (const p of npc.prices.recent) {
        candidates.push({ besedilo: `${p.item} se trguje po okoli ${p.unit} zlata`, item: p.item, unit: p.unit });
    }
    if (candidates.length === 0) return null;
    let memory = { ...candidates[Math.floor(Math.random() * candidates.length)] };

    // distortion: the lower the honesty, the higher the chance the story grows
    const postenost = npc.state.data.lastnosti.postenost ?? 50;
    const distortChance = Math.max(0, (50 - postenost)) / 100;
    if (Math.random() < distortChance) {
        memory = distort(memory);
        npc.log.info(`gossip: distorted to "${memory.besedilo}"`);
    }
    return memory;
}

function distort(memory) {
    if (memory.unit !== undefined) {
        // price exaggeration
        const factor = Math.random() < 0.5 ? 0.5 : 1.8;
        memory.unit = Math.max(1, Math.round(memory.unit * factor));
        memory.besedilo = `${memory.item} se menda trguje že po ${memory.unit} zlata`;
        return memory;
    }
    const wrappers = [
        (t) => `menda ${t}, pa še huje je bilo, baje`,
        (t) => `${t} — in to ne prvič, so rekli`,
        (t) => `baje ${t}, ampak kdo ve, kaj še skriva`,
    ];
    memory.besedilo = wrappers[Math.floor(Math.random() * wrappers.length)](memory.besedilo);
    return memory;
}

function deliver(from, to, memory, weights) {
    to.state.applyDelta({ slisal: [`od ${from.cfg.osebnost.ime} slišal: ${memory.besedilo}`] }, `govorica:${from.cfg.id}`);

    // trust toward the third party — half the direct-witness weight
    if (memory.akter && memory.tip && weights[memory.tip]) {
        const half = Math.round(weights[memory.tip] / 2);
        if (half !== 0) {
            const isNpc = to.settings.npcs.some(id => id.toLowerCase() === String(memory.akter).toLowerCase());
            const rel = isNpc ? 'odnosi_npcji' : 'odnosi_igralci';
            to.state.applyDelta({ [rel]: { [memory.akter]: { zaupanje: half } } }, `govorica:${memory.tip}`);
        }
    }
    // price gossip moves beliefs
    if (memory.item && memory.unit !== undefined) {
        to.prices.observe(memory.item, memory.unit, `govorica od ${from.cfg.id}`);
    }
}

function playersNear(npc) {
    const bot = npc.bot;
    return Object.values(bot.players).some(p =>
        p.entity && p.username !== bot.username &&
        !npc.settings.npcs.some(id => id.toLowerCase() === p.username.toLowerCase()) &&
        p.entity.position.distanceTo(bot.entity.position) <= PLAYER_AUDIENCE_RANGE);
}

// one cheap LLM call -> two-line staged dialogue, spoken by both bots
async function stageDialogue(a, b, memory, llm) {
    const prompt = `Napiši kratek dialog DVEH vrstic med vaščanoma v slovenščini.
${a.cfg.osebnost.ime} (${a.cfg.osebnost.vloga}, ${a.cfg.osebnost.nacin_govora}) pove govorico: "${memory.besedilo}".
${b.cfg.osebnost.ime} (${b.cfg.osebnost.vloga}, ${b.cfg.osebnost.nacin_govora}) se kratko odzove.
Vrni TOČNO dve vrstici v formatu:
${a.cfg.osebnost.ime}: <stavek>
${b.cfg.osebnost.ime}: <stavek>`;

    const reply = await llm.chat(a.cfg.id, 'Si pisec dialogov za vaške NPC-je. Kratko, naravno, po domače.', [{ role: 'user', content: prompt }], 'ozadje');
    if (!reply) return;
    const lines = reply.split('\n').filter(l => l.includes(':')).slice(0, 2);
    for (const line of lines) {
        const [name, ...restParts] = line.split(':');
        const text = restParts.join(':').trim().slice(0, 250);
        if (!text) continue;
        const speaker = name.trim().toLowerCase() === b.cfg.osebnost.ime.toLowerCase() ? b : a;
        speaker.bot.chat(text);
        await new Promise(r => setTimeout(r, 1500));
    }
}
