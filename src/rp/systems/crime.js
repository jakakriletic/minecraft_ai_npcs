// Crime + investigation + jail.
//
// Daily dice (dice.js) decide whether an NPC plans a crime today. The plan is a
// night theft from another NPC's home chest. Execution checks nobody is within
// sight first — but the regular witness system (events.js) still applies, so a
// badly-timed thief WILL be seen opening the chest.
//
// Victim discovers the theft later (bus event, delayed), then reports it to the
// policeman when they meet. The policeman "interrogates witnesses" = reads every
// NPC's event log around the crime time. Witness found -> arrest (jail schedule
// override + town-wide reputation hit via gossip). No witness -> unsolved,
// theories circulate.
import { bus } from '../core/bus.js';
import { rollCrime } from '../core/dice.js';
import { gotoRegion, sleep } from '../core/movement.js';
import { Vec3 } from 'vec3';
import { NUGGET, INGOT } from './economy.js';
import { openContainerSafe, withChestLock } from '../core/storage.js';
import { noteNegativeInteraction } from './social_bonds.js';
import * as mcCompat from '../../utils/mc_compat.js';

const CHECK_MS = 60_000;
const NIGHT = (t) => t >= 13000 && t <= 23000;
const LOOT_PRIORITY = [NUGGET, INGOT, 'diamond', 'emerald', 'iron_ingot'];

export function attachCrime(npc, crimeCfg) {
    const st = { lastRollDay: -1, planned: false, attempts: 0 };
    npc.crimeState = st;

    const timer = setInterval(() => {
        try { crimeTick(npc, crimeCfg, st); }
        catch (e) { npc.log.warn(`crime: ${e.message}`); }
    }, CHECK_MS);
    npc.bot.once('end', () => clearInterval(timer));

    // victim side: learn about thefts against me (delayed discovery)
    const onCrime = (ev) => {
        if (ev.victimId !== npc.cfg.id) return;
        setTimeout(() => {
            npc.state.applyDelta({ slisal: [`nekdo ti je vlomil v shrambo in odnesel ${ev.lootDesc}`] }, 'kraja');
            npc.state.data.mood_danes = 'jezen';
            npc.pendingReport = ev;
            npc.state.save();
            npc.log.info(`discovered theft: ${ev.lootDesc} missing`);
        }, (crimeCfg.odkritje_zamik_min ?? 5) * 60_000);
    };
    bus.on('crime', onCrime);

    // everyone: hear town-wide announcements (arrests, unsolved crimes)
    const onRazglas = (ev) => {
        if (ev.sourceId === npc.cfg.id) return;
        npc.state.applyDelta({ slisal: [ev.besedilo] }, 'razglas');
        if (ev.suspectId && ev.suspectId !== npc.cfg.id) {
            const isNpc = npc.settings.npcs.some(id => id.toLowerCase() === ev.suspectId.toLowerCase());
            npc.state.applyDelta({ [isNpc ? 'odnosi_npcji' : 'odnosi_igralci']: { [ev.suspectId]: { zaupanje: -10 } } }, 'razglas');
        }
    };
    bus.on('razglas', onRazglas);

    npc.bot.once('end', () => { bus.off('crime', onCrime); bus.off('razglas', onRazglas); });
}

function crimeTick(npc, cfg, st) {
    const bot = npc.bot;
    if (!bot?.entity) return;

    // victim with a report -> file it when near the policeman
    if (npc.pendingReport) tryReport(npc, cfg);

    // the lawman doesn't commit crimes
    if (isLawman(npc)) return;
    // no crime while in jail
    if (inJail(npc)) return;

    // one dice roll per in-game day
    const day = Math.floor(bot.time.age / 24000);
    if (day !== st.lastRollDay) {
        st.lastRollDay = day;
        st.planned = rollCrime(npc, cfg);
        st.attempts = 0;
        if (st.planned) npc.log.info('crime planned for tonight...');
    }

    // execute at night, when free of other actions
    if (st.planned && NIGHT(bot.time.timeOfDay) && !npc.busy && !npc.pendingAction) {
        st.planned = false;
        npc.pendingAction = async () => { await executeTheft(npc, cfg, st); };
    }
}

async function executeTheft(npc, cfg, st) {
    const bot = npc.bot;
    // target: another NPC with a home region (not the policeman's — too risky)
    const targets = (npc.registry ?? []).filter(o =>
        o !== npc && o.cfg.home_region && npc.locations[o.cfg.home_region] && o.cfg.job !== 'policeman');
    if (targets.length === 0) return;
    const victim = targets[Math.floor(Math.random() * targets.length)];
    const region = npc.locations[victim.cfg.home_region];

    npc.log.info(`CRIME: sneaking to ${victim.cfg.id}'s home...`);
    const ok = await gotoRegion(bot, region, npc.log);
    if (!ok) return;

    // is anyone watching? (players or NPCs within 12 blocks, except the sleeping victim... risky anyway)
    const watchers = Object.values(bot.entities).filter(e =>
        e !== bot.entity && (e.type === 'player' || e.username) &&
        e.username !== bot.username &&
        e.position.distanceTo(bot.entity.position) < 12);
    if (watchers.length > 0) {
        npc.log.info(`CRIME: aborted, ${watchers.map(w => w.username ?? w.name).join(',')} nearby`);
        if (++st.attempts < 3) st.planned = true; // retry later tonight
        return;
    }

    // find the victim's chest and grab valuables
    const chests = npc.storage.findChestsInRegion(bot, region);
    if (chests.length === 0) { npc.log.info('CRIME: no chest found, giving up'); return; }
    const chest = chests[0];

    let loot = [];
    try {
        const key = `${chest.position.x},${chest.position.y},${chest.position.z}`;
        await withChestLock(key, async () => {
            let win;
            try {
                win = await openContainerSafe(bot, chest);
                const items = win.containerItems();
                let slots = cfg.max_predmetov ?? 8;
                for (const name of LOOT_PRIORITY) {
                    for (const it of items.filter(i => mcCompat.stackMatchesName(i, name, bot))) {
                        if (slots <= 0) break;
                        const take = Math.min(it.count, slots * 16);
                        try { await win.withdraw(it.type, it.metadata, take, it.nbt); loot.push(`${take}x ${name}`); slots--; }
                        catch { break; }
                    }
                }
            } finally {
                if (win) {
                    try { await win.close(); } catch { /* disconnected */ }
                }
            }
        });
    } catch (e) {
        npc.log.warn(`CRIME: chest failed: ${e.message}`);
        return;
    }

    if (loot.length === 0) { npc.log.info('CRIME: chest had nothing worth taking'); return; }
    const lootDesc = loot.join(', ');
    npc.log.info(`CRIME: stole ${lootDesc} from ${victim.cfg.id}`);

    // thief's own (guilty) knowledge — never admitted, shapes persona
    npc.state.applyDelta({ slisal: [`ponoči si vlomil pri ${victim.cfg.osebnost.ime} in vzel ${lootDesc} (tega NIKOLI ne priznaš)`] }, 'zagresil');
    npc.state.data.mood_danes = 'nervozen';
    npc.state.save();

    bus.emit('crime', {
        thiefId: npc.cfg.id, victimId: victim.cfg.id,
        lootDesc, ts: Date.now(),
    });

    // scurry home
    await gotoRegion(bot, npc.region(npc.cfg.home_region), npc.log);
}

function tryReport(npc, cfg) {
    const policeman = (npc.registry ?? []).find(o => isLawman(o) && o.bot?.entity);
    if (!policeman || !npc.bot?.entity) return;
    if (policeman.bot.entity.position.distanceTo(npc.bot.entity.position) > 8) return;

    const crime = npc.pendingReport;
    npc.pendingReport = null;
    npc.bot.chat(`${policeman.cfg.osebnost.ime}! Okradli so me! Odnesli so ${crime.lootDesc}.`);
    npc.log.info(`reported theft to ${policeman.cfg.id}`);
    setTimeout(() => investigate(policeman, crime, cfg), 3000);
}

// Policeman reads every NPC's event log around the crime time looking for a witness.
function investigate(policeman, crime, cfg) {
    policeman.log.info(`INVESTIGATION: theft at ${crime.victimId}'s, interrogating witnesses (reading event logs)...`);
    const windowMs = (cfg.preiskava_okno_min ?? 30) * 60_000;
    let suspect = null, witnessId = null;

    for (const witness of policeman.registry ?? []) {
        for (const e of witness.eventLog.entries) {
            const dt = Math.abs(new Date(e.ts).getTime() - crime.ts);
            if (dt > windowMs) continue;
            if (e.tip === 'odprl_tujo_skrinjo' && e.podrobnost?.includes(`pri ${crime.victimId}`)) {
                suspect = e.akter;
                witnessId = witness.cfg.id;
                break;
            }
        }
        if (suspect) break;
    }

    if (suspect) {
        policeman.log.info(`INVESTIGATION: witness ${witnessId} saw ${suspect} -> ARREST`);
        policeman.bot.chat(`Priča je. ${suspect}, aretiran si zaradi kraje pri ${crime.victimId}!`);
        const culprit = policeman.registry.find(o => o.cfg.id.toLowerCase() === String(suspect).toLowerCase());
        if (culprit) {
            const days = cfg.zapor_dni ?? 2;
            culprit.state.data.zapor_do = new Date(Date.now() + days * 20 * 60_000).toISOString(); // 1 in-game day = 20 min
            culprit.state.data.mood_danes = 'osramočen';
            culprit.state.save();
            culprit.log.info(`JAILED for ${days} in-game days`);
            policeman.civic?.adjustReputation?.(culprit.cfg.id, { public_trust: -8, respect: -4, notoriety: 10 }, 'arrest');
            for (const witness of policeman.registry ?? []) {
                if (witness !== culprit) noteNegativeInteraction(witness, culprit.cfg.id, 'arrest', 1.5);
            }
        }
        policeman.civic?.addPublicEvent?.('arrest', policeman.cfg.id, `${suspect} je bil aretiran zaradi kraje pri ${crime.victimId}.`, {
            suspect: String(suspect),
            victim: crime.victimId,
            witness: witnessId,
        });
        bus.emit('razglas', {
            sourceId: policeman.cfg.id, suspectId: String(suspect),
            besedilo: `${suspect} je bil aretiran zaradi kraje pri ${crime.victimId}`,
        });
    } else {
        policeman.log.info('INVESTIGATION: no witnesses -> unsolved');
        policeman.civic?.addPublicEvent?.('unsolved_crime', policeman.cfg.id, `Pri ${crime.victimId} so vlomili, storilec pa ni znan.`, {
            victim: crime.victimId,
        });
        policeman.bot.chat(`Hm. Prič ni. Primer ostaja odprt, ampak oči imam povsod.`);
        bus.emit('razglas', {
            sourceId: policeman.cfg.id,
            besedilo: `pri ${crime.victimId} so ponoči vlomili, storilec neznan — po mestu krožijo teorije`,
        });
    }
}

export function inJail(npc) {
    const until = npc.state.data.zapor_do;
    return until && new Date(until) > new Date();
}

// who keeps the law — policeman or guard (jobs are AI-assigned, so accept both)
function isLawman(npc) {
    return npc.cfg.job === 'policeman' || npc.cfg.job === 'guard';
}
