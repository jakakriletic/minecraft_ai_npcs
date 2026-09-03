import { gotoNear, sleep } from '../core/movement.js';
import { onSocialized } from './needs.js';
import { countFood, minecraftSatiety, transferFood } from './food.js';

const DEFAULT_TICK_MS = 45_000;
const PAIR_COOLDOWN_MS = 4 * 60_000;
const AUDIENCE_RANGE = 18;
const RELATION_CAP = 100;
const SHARE_HUNGER_THRESHOLD = 85;

const pairCooldowns = new Map();

export function attachSocialBonds(npc, civic, llm = null) {
    if (npc.settings.social_bonds?.enabled === false) return;
    ensureSocialShape(npc);

    const tickMs = npc.settings.social_bonds?.tick_interval_ms ?? DEFAULT_TICK_MS;
    const timer = setInterval(() => {
        try { socialBondTick(npc, civic, llm); }
        catch (e) { npc.log.warn(`social bonds: ${e.message}`); }
    }, tickMs + Math.random() * 10_000);
    npc.bot.once('end', () => clearInterval(timer));
}

export function socialSnapshot(npc, limit = 4) {
    const social = ensureSocialShape(npc);
    const bonds = Object.entries(social.bonds)
        .map(([id, bond]) => ({ id, ...bond }))
        .sort((a, b) => bondStrength(b) - bondStrength(a))
        .slice(0, limit);
    return {
        bonds,
        active_focus: social.active_focus ?? null,
        leadership_preference: social.leadership_preference ?? null,
    };
}

export function formatSocialStatus(npc) {
    const snap = socialSnapshot(npc, 3);
    if (snap.bonds.length === 0) return 'odnosi se se oblikujejo';
    return snap.bonds
        .map(b => `${b.id}:${b.status} a${Math.round(b.affinity)} t${Math.round(b.trust)} n${Math.round(b.tension)}`)
        .join(' | ');
}

export function notePositiveInteraction(a, b, reason = 'positive_interaction', weight = 1) {
    if (!a || !b) return;
    updateBond(a, b, {
        affinity: 1.5 * weight,
        trust: 1 * weight,
        familiarity: 2 * weight,
        tension: -0.5 * weight,
    }, reason);
    updateBond(b, a, {
        affinity: 1.5 * weight,
        trust: 1 * weight,
        familiarity: 2 * weight,
        tension: -0.5 * weight,
    }, reason);
}

export function noteNegativeInteraction(witness, actorId, reason = 'negative_interaction', weight = 1) {
    if (!witness || !actorId) return;
    updateBondById(witness, actorId, {
        affinity: -2 * weight,
        trust: -2 * weight,
        respect: -1 * weight,
        tension: 2 * weight,
        familiarity: 1,
    }, reason);
}

function socialBondTick(npc, civic, llm) {
    const bot = npc.bot;
    if (!bot?.entity || npc.busy || npc.pendingAction || npc.command || npc.defending || bot.isSleeping) return;
    if (npc.currentActivity === 'sleep' || npc.currentActivity === 'jail') return;

    ensureSocialShape(npc);
    decayBonds(npc);

    const target = chooseTarget(npc);
    if (!target) {
        civic?.updateSocialStructure?.(npc.registry ?? []);
        updateLeadershipPreference(npc, civic);
        return;
    }

    const pairKey = [npc.cfg.id, target.cfg.id].sort().join('|');
    if (Date.now() - (pairCooldowns.get(pairKey) ?? 0) < PAIR_COOLDOWN_MS) return;
    // Reserve the pair immediately so both timers cannot schedule the same meeting.
    // A failed meeting gets only a short retry delay instead of the full cooldown.
    pairCooldowns.set(pairKey, Date.now());

    npc.pendingAction = async () => {
        const completed = await runSocialBeat(npc, target, civic, llm);
        if (!completed) pairCooldowns.set(pairKey, Date.now() - PAIR_COOLDOWN_MS + 30_000);
    };
    npc.state.save();
}

async function runSocialBeat(npc, target, civic, llm) {
    if (!target.bot?.entity || target.bot.isSleeping || target.busy || target.defending || target.command) return false;
    if (npc.bot.entity.position.distanceTo(target.bot.entity.position) > 8) {
        await gotoNear(npc.bot, target.bot.entity.position, 3, npc.log, 14_000);
    }
    if (!target.bot?.entity || npc.bot.entity.position.distanceTo(target.bot.entity.position) > 10) return false;

    const beforeA = bondFor(npc, target.cfg.id).status;
    const beforeB = bondFor(target, npc.cfg.id).status;
    const beat = chooseBeat(npc, target);
    if (beat.kind === 'share_food') {
        const donor = beat.donor === 'b' ? target : npc;
        const recipient = donor === npc ? target : npc;
        if (!await shareFood(donor, recipient, civic)) return false;
    }
    applyBeat(npc, target, beat);

    onSocialized(npc, 7);
    onSocialized(target, 7);

    const afterA = bondFor(npc, target.cfg.id).status;
    const afterB = bondFor(target, npc.cfg.id).status;
    if (beforeA !== afterA || beforeB !== afterB) {
        civic?.recordBondEvent?.(npc.cfg.id, target.cfg.id, afterA, beat.reason);
    }

    civic?.updateSocialStructure?.(npc.registry ?? []);
    updateLeadershipPreference(npc, civic);

    if (shouldSpeak(npc) || shouldSpeak(target)) {
        await speakBeat(npc, target, beat, llm);
    }
    await sleep(1200);
    return true;
}

function chooseTarget(npc) {
    const candidates = (npc.registry ?? []).filter(other =>
        other !== npc && other.bot?.entity && !other.bot.isSleeping && other.currentActivity !== 'jail' && !other.command);
    if (candidates.length === 0) return null;

    return candidates
        .map(other => {
            const bond = bondFor(npc, other.cfg.id);
            const distance = npc.bot.entity.position.distanceTo(other.bot.entity.position);
            const socialNeed = 100 - (npc.state.data.potrebe.druzabnost ?? 50);
            const repair = bond.tension > 45 ? 20 : 0;
            const friend = ['friend', 'close_friend', 'sweetheart', 'ally'].includes(bond.status) ? 15 : 0;
            const curiosity = bond.familiarity < 25 ? 10 : 0;
            const innBonus = ['innkeeper', 'cook', 'steward'].includes(other.cfg.job) ? 8 : 0;
            const score = socialNeed * 0.25 + repair + friend + curiosity + innBonus - distance * 0.45 + Math.random() * 12;
            return { other, score };
        })
        .sort((a, b) => b.score - a.score)[0]?.other ?? null;
}

function chooseBeat(a, b) {
    const ab = bondFor(a, b.cfg.id);
    const ba = bondFor(b, a.cfg.id);
    const avgTrust = (ab.trust + ba.trust) / 2;
    const avgTension = (ab.tension + ba.tension) / 2;
    const sociable = ((a.state.data.lastnosti.socialnost ?? 50) + (b.state.data.lastnosti.socialnost ?? 50)) / 2;

    if (avgTension > 60) return { kind: 'cooldown', reason: 'napet pogovor' };
    const aSatiety = minecraftSatiety(a.bot) ?? Number(a.state.data.potrebe.sitost ?? 100);
    const bSatiety = minecraftSatiety(b.bot) ?? Number(b.state.data.potrebe.sitost ?? 100);
    if (bSatiety < SHARE_HUNGER_THRESHOLD && hasSpareFood(a) && avgTrust > 45)
        return { kind: 'share_food', donor: 'a', reason: 'deljenje hrane' };
    if (aSatiety < SHARE_HUNGER_THRESHOLD && hasSpareFood(b) && avgTrust > 45)
        return { kind: 'share_food', donor: 'b', reason: 'deljenje hrane' };
    if (avgTrust > 72 && avgTension < 30 && Math.random() < 0.25) return { kind: 'confide', reason: 'zaupanje' };
    if (avgTrust > 66 && Math.random() < 0.18) return { kind: 'help_offer', reason: 'pomoc' };
    if (isRomancePossible(a, b, ab, ba) && Math.random() < 0.16) return { kind: 'warmth', reason: 'simpatija' };
    if (sociable > 60 || Math.random() < 0.55) return { kind: 'chat', reason: 'druzenje' };
    return { kind: 'quiet_respect', reason: 'mirno sobivanje' };
}

function applyBeat(a, b, beat) {
    switch (beat.kind) {
        case 'cooldown':
            updateBond(a, b, { tension: -3, affinity: 0.5, familiarity: 1 }, beat.reason);
            updateBond(b, a, { tension: -3, affinity: 0.5, familiarity: 1 }, beat.reason);
            break;
        case 'confide':
            updateBond(a, b, { trust: 3, affinity: 2, familiarity: 3, tension: -2 }, beat.reason);
            updateBond(b, a, { trust: 3, affinity: 2, familiarity: 3, tension: -2 }, beat.reason);
            addHeard(a, `${b.cfg.osebnost.ime} ti je zaupal/a nekaj osebnega.`);
            addHeard(b, `${a.cfg.osebnost.ime} ti je zaupal/a nekaj osebnega.`);
            break;
        case 'help_offer':
            updateBond(a, b, { trust: 2, respect: 2, affinity: 1.5, familiarity: 2, tension: -1 }, beat.reason);
            updateBond(b, a, { trust: 2, respect: 2, affinity: 1.5, familiarity: 2, tension: -1 }, beat.reason);
            addCommitment(a, b, 'pomoc ob priliki');
            break;
        case 'share_food':
            {
                const donor = beat.donor === 'b' ? b : a;
                const recipient = donor === a ? b : a;
                updateBond(donor, recipient, { trust: 3, respect: 2, affinity: 2, familiarity: 2, tension: -1 }, beat.reason);
                updateBond(recipient, donor, { trust: 4, respect: 1, affinity: 3, familiarity: 2, tension: -1.5 }, beat.reason);
            }
            break;
        case 'warmth':
            updateBond(a, b, { romance: 2.5, affinity: 2, trust: 1, familiarity: 2, tension: -1 }, beat.reason);
            updateBond(b, a, { romance: 2.5, affinity: 2, trust: 1, familiarity: 2, tension: -1 }, beat.reason);
            break;
        case 'quiet_respect':
            updateBond(a, b, { respect: 1.5, familiarity: 1, tension: -0.5 }, beat.reason);
            updateBond(b, a, { respect: 1.5, familiarity: 1, tension: -0.5 }, beat.reason);
            break;
        default:
            updateBond(a, b, { affinity: 1.2, trust: 0.8, familiarity: 2, tension: -0.6 }, beat.reason);
            updateBond(b, a, { affinity: 1.2, trust: 0.8, familiarity: 2, tension: -0.6 }, beat.reason);
    }
}

async function speakBeat(a, b, beat, llm) {
    if (llm && hasPlayerAudience(a)) {
        const dialogue = await stagedDialogue(a, b, beat, llm);
        if (dialogue) {
            for (const { speaker, text } of dialogue) {
                speaker.bot.chat(text.slice(0, 250));
                await sleep(1200);
            }
            return;
        }
    }

    const line = fallbackLine(a, b, beat);
    const speaker = beat.kind === 'share_food' && beat.donor === 'b' ? b : a;
    if (line) speaker.bot.chat(line);
}

async function stagedDialogue(a, b, beat, llm) {
    const ab = bondFor(a, b.cfg.id);
    const ba = bondFor(b, a.cfg.id);
    const prompt = `Napisi kratek Minecraft NPC dialog v slovenscini, tocno dve vrstici.
Situacija: ${beat.reason}. Odnos ${a.cfg.osebnost.ime}->${b.cfg.osebnost.ime}: ${ab.status}, zaupanje ${Math.round(ab.trust)}, napetost ${Math.round(ab.tension)}.
Odnos ${b.cfg.osebnost.ime}->${a.cfg.osebnost.ime}: ${ba.status}, zaupanje ${Math.round(ba.trust)}, napetost ${Math.round(ba.tension)}.
Stila:
${a.cfg.osebnost.ime}: ${a.cfg.osebnost.nacin_govora}
${b.cfg.osebnost.ime}: ${b.cfg.osebnost.nacin_govora}
Ne omenjaj stevilk. Naj zveni kot normalen trenutek med prebivalci.
Format:
${a.cfg.osebnost.ime}: <stavek>
${b.cfg.osebnost.ime}: <stavek>`;
    const reply = await llm.chat(a.cfg.id, 'Si pisec kratkih naravnih dialogov za Minecraft NPC-je. Vrni samo dve vrstici.', [{ role: 'user', content: prompt }], 'ozadje');
    if (!reply) return null;
    const lines = reply.split('\n').filter(l => l.includes(':')).slice(0, 2);
    if (lines.length < 1) return null;
    return lines.map(line => {
        const [name, ...rest] = line.split(':');
        const speaker = name.trim().toLowerCase() === b.cfg.osebnost.ime.toLowerCase() ? b : a;
        return { speaker, text: rest.join(':').trim() };
    }).filter(x => x.text);
}

function fallbackLine(a, b, beat) {
    const recipient = beat.kind === 'share_food' && beat.donor === 'b' ? a : b;
    switch (beat.kind) {
        case 'cooldown': return pick([`${b.cfg.osebnost.ime}, pustiva to za danes.`, `Ne bom se prepiral/a. Pocasi.`]);
        case 'confide': return pick([`${b.cfg.osebnost.ime}, to ti povem, ker ti zaupam.`, `Med nama naj ostane, prav?`]);
        case 'help_offer': return pick([`${b.cfg.osebnost.ime}, ce bos rabil/a pomoc, povej.`, `Lahko ti pomagam kasneje, ce bo treba.`]);
        case 'share_food': return pick([`${recipient.cfg.osebnost.ime}, vzemi nekaj hrane.`, `Vidim, da si lacen/a. Izvoli.`]);
        case 'warmth': return pick([`Lepo te je videti, ${b.cfg.osebnost.ime}.`, `S tabo je dan malo lazji.`]);
        case 'quiet_respect': return pick([`Dobro delas, ${b.cfg.osebnost.ime}.`, `To cenim.`]);
        default: return pick([`Kako gre, ${b.cfg.osebnost.ime}?`, `Danes je kar ziv dan.`, `Se vidiva kasneje.`]);
    }
}

function updateBond(a, b, deltas, reason) {
    updateBondById(a, b.cfg.id, deltas, reason);
}

function updateBondById(npc, otherId, deltas, reason) {
    const bond = bondFor(npc, otherId);
    const before = bond.status;
    for (const [key, delta] of Object.entries(deltas)) {
        if (typeof delta !== 'number' || !Number.isFinite(delta)) continue;
        if (!(key in bond)) continue;
        const min = key === 'tension' || key === 'romance' ? 0 : 0;
        bond[key] = clamp(bond[key] + delta, min, RELATION_CAP);
    }
    bond.status = classifyBond(bond);
    bond.last_interaction_at = new Date().toISOString();
    bond.history.push({
        ts: bond.last_interaction_at,
        reason,
        status: bond.status,
    });
    bond.history = bond.history.slice(-8);

    npc.state.data.odnosi_npcji[otherId] ??= { zaupanje: 50, mnenje: '' };
    npc.state.data.odnosi_npcji[otherId].zaupanje = Math.round(bond.trust);
    if (before !== bond.status) {
        npc.state.data.odnosi_npcji[otherId].mnenje = bondOpinion(bond);
        npc.state.data.znanje_o_svetu.slisal.push(`Tvoj odnos z ${otherId} je zdaj: ${bond.status}.`);
        npc.state.data.znanje_o_svetu.slisal = npc.state.data.znanje_o_svetu.slisal.slice(-20);
    }
    npc.state.save();
}

function bondFor(npc, otherId) {
    const social = ensureSocialShape(npc);
    social.bonds[otherId] ??= {
        affinity: 50,
        trust: npc.state.data.odnosi_npcji?.[otherId]?.zaupanje ?? 50,
        respect: 50,
        romance: 0,
        tension: 0,
        familiarity: 0,
        status: 'acquaintance',
        tags: [],
        history: [],
        last_interaction_at: null,
    };
    const bond = social.bonds[otherId];
    for (const [key, value] of Object.entries({ affinity: 50, trust: 50, respect: 50, romance: 0, tension: 0, familiarity: 0 })) {
        if (typeof bond[key] !== 'number') bond[key] = value;
    }
    bond.status ??= classifyBond(bond);
    bond.tags ??= [];
    bond.history ??= [];
    return bond;
}

function ensureSocialShape(npc) {
    const data = npc.state.data;
    data.social ??= {};
    const social = data.social;
    social.bonds ??= {};
    social.circles ??= [];
    social.active_focus ??= null;
    social.leadership_preference ??= null;
    social.last_bond_event_at ??= 0;
    return social;
}

function updateLeadershipPreference(npc, civic) {
    const social = ensureSocialShape(npc);
    const leaders = civic?.data?.social_structure?.leaders ?? [];
    if (leaders.length === 0) return;
    const preferred = leaders
        .map(leader => {
            const bond = social.bonds[leader.id];
            const ownBond = leader.id === npc.cfg.id ? { trust: 65, respect: 65, tension: 0, affinity: 60 } : bond;
            const bondScore = ownBond
                ? Number(ownBond.trust ?? 50) + Number(ownBond.respect ?? 50) + Number(ownBond.affinity ?? 50) - Number(ownBond.tension ?? 0)
                : 120;
            return {
                id: leader.id,
                name: leader.name,
                score: Number(leader.score ?? 50) + bondScore * 0.35,
            };
        })
        .sort((a, b) => b.score - a.score)[0];
    if (!preferred) return;
    social.leadership_preference = {
        id: preferred.id,
        name: preferred.name,
        updated_at: new Date().toISOString(),
    };
    npc.state.save();
}

function decayBonds(npc) {
    const social = ensureSocialShape(npc);
    let changed = false;
    for (const bond of Object.values(social.bonds)) {
        const oldTension = bond.tension;
        const oldRomance = bond.romance;
        bond.tension = clamp(bond.tension * 0.995, 0, 100);
        if (bond.status !== 'sweetheart') bond.romance = clamp(bond.romance * 0.998, 0, 100);
        if (oldTension !== bond.tension || oldRomance !== bond.romance) changed = true;
        bond.status = classifyBond(bond);
    }
    if (changed) npc.state.save();
}

function classifyBond(bond) {
    if (bond.tension >= 70 && bond.trust < 38) return 'rival';
    if (bond.romance >= 70 && bond.trust >= 65 && bond.affinity >= 68 && bond.tension < 35) return 'sweetheart';
    if (bond.trust >= 78 && bond.affinity >= 72 && bond.respect >= 60) return 'close_friend';
    if (bond.trust >= 65 && bond.affinity >= 62) return 'friend';
    if (bond.respect >= 72 && bond.trust >= 55) return 'ally';
    if (bond.tension >= 45) return 'strained';
    return bond.familiarity >= 20 ? 'known' : 'acquaintance';
}

function bondOpinion(bond) {
    switch (bond.status) {
        case 'sweetheart': return 'do te osebe cutis posebno toplino in zaupanje';
        case 'close_friend': return 'zelo blizu sta si, tej osebi zaupas';
        case 'friend': return 'imata dober, prijateljski odnos';
        case 'ally': return 'to osebo spostujes in jo vidis kot zaveznika';
        case 'rival': return 'med vama je mocna zamera in tekmovalnost';
        case 'strained': return 'odnos je napet, ampak se ni izgubljen';
        case 'known': return 'osebo poznas iz vsakdana';
        default: return 'osebo se sele spoznavas';
    }
}

function bondStrength(bond) {
    return (bond.affinity ?? 0) + (bond.trust ?? 0) + (bond.respect ?? 0) + (bond.romance ?? 0) - (bond.tension ?? 0);
}

function isRomancePossible(a, b, ab, ba) {
    if (a.cfg.id === b.cfg.id) return false;
    if ((a.cfg.altera_profile?.romance ?? true) === false) return false;
    if ((b.cfg.altera_profile?.romance ?? true) === false) return false;
    return ab.trust > 58 && ba.trust > 58 && ab.affinity > 60 && ba.affinity > 60 && ab.tension < 25 && ba.tension < 25;
}

function addHeard(npc, text) {
    npc.state.data.znanje_o_svetu.slisal.push(text);
    npc.state.data.znanje_o_svetu.slisal = npc.state.data.znanje_o_svetu.slisal.slice(-20);
}

function addCommitment(from, to, text) {
    from.state.data.mind ??= {};
    from.state.data.mind.commitments ??= [];
    from.state.data.mind.commitments.push({
        to: to.cfg.id,
        text,
        ts: new Date().toISOString(),
    });
    from.state.data.mind.commitments = from.state.data.mind.commitments.slice(-8);
}

async function shareFood(from, to, civic) {
    const result = await transferFood(from, to, { gotoNear, sleep });
    if (result.success) {
        civic?.addPublicEvent?.('helped', from.cfg.id, `${from.cfg.osebnost.ime} je delil/a hrano z ${to.cfg.osebnost.ime}.`, {
            from: from.cfg.id,
            to: to.cfg.id,
            item: result.item,
            ate: result.ate,
        });
        return true;
    }
    from.log.warn(`share food failed: ${result.detail}`);
    return false;
}

function hasSpareFood(npc) {
    return countFood(npc.bot) > 1;
}

function shouldSpeak(npc) {
    return hasPlayerAudience(npc) || Math.random() < 0.35;
}

function hasPlayerAudience(npc) {
    return Object.values(npc.bot.players).some(p =>
        p.entity && p.username !== npc.bot.username &&
        !npc.settings.npcs.some(id => id.toLowerCase() === p.username.toLowerCase()) &&
        p.entity.position.distanceTo(npc.bot.entity.position) <= AUDIENCE_RANGE);
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, min, max) => Math.max(min, Math.min(max, Math.round(v * 100) / 100));
