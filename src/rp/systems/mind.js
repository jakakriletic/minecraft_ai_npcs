import { gotoChestInRegion, openContainerSafe, withChestLock } from '../core/storage.js';
import { gotoNear, sleep } from '../core/movement.js';
import { onSocialized } from './needs.js';
import * as mcCompat from '../../utils/mc_compat.js';

const DEFAULT_TICK_MS = 30_000;
const SOCIAL_COOLDOWN_MS = 3 * 60_000;
const CULTURE_COOLDOWN_MS = 4 * 60_000;
const AUDIT_COOLDOWN_MS = 5 * 60_000;
const TOOL_SUFFIXES = ['_axe', '_pickaxe', '_sword', '_shovel', '_hoe'];

export function attachMind(npc, civic) {
    if (!civic || npc.settings.mind?.enabled === false) return;
    npc.civic = civic;
    ensureMindShape(npc);

    const tickMs = npc.settings.mind?.tick_interval_ms ?? DEFAULT_TICK_MS;
    const timer = setInterval(() => {
        safeMindTick(npc, civic);
    }, tickMs + Math.random() * 5000);
    npc.bot.once('end', () => clearInterval(timer));
    safeMindTick(npc, civic);
}

export function mindTick(npc, civic) {
    const bot = npc.bot;
    if (!bot?.entity || npc.command || npc.defending) return;

    const day = civic.dayFromBot(bot);
    civic.ensureDay(day);
    ensureDailyAgenda(npc, civic, day);
    updateIntention(npc, civic);

    if (npc.busy || npc.pendingAction || npc.currentActivity === 'sleep' || npc.currentActivity === 'jail') return;

    const t = bot.time.timeOfDay;
    const mind = ensureMindShape(npc);

    if (shouldPayTax(npc, civic, day, t)) {
        mind.last_tax_attempt_at = Date.now();
        npc.pendingAction = () => payTax(npc, civic, day);
        npc.state.save();
        return;
    }

    if (isLawman(npc) && shouldAudit(npc, civic, day, t)) {
        mind.last_audit_at = Date.now();
        npc.pendingAction = () => auditTown(npc, civic, day);
        npc.state.save();
        return;
    }

    if (npc.currentActivity === 'free' && shouldSocialize(npc)) {
        const target = chooseSocialTarget(npc);
        if (target) {
            mind.last_social_action_at = Date.now();
            npc.pendingAction = () => seekSocialContact(npc, target, civic);
            npc.state.save();
            return;
        }
    }

    if (npc.currentActivity === 'free' && shouldSpreadCulture(npc)) {
        mind.last_culture_action_at = Date.now();
        npc.pendingAction = () => spreadCulture(npc, civic);
        npc.state.save();
    }
}

function safeMindTick(npc, civic) {
    try {
        mindTick(npc, civic);
    } catch (e) {
        npc.log.warn(`mind: ${e.message}`);
    }
}

export function mindSnapshot(npc) {
    const mind = ensureMindShape(npc);
    const civic = npc.civic;
    const ctx = civic?.contextFor?.(npc.cfg.id) ?? { laws: [], memes: [], events: [], reputation: null };
    return {
        daily_goal: mind.daily_goal,
        social_goal: mind.social_goal,
        civic_goal: mind.civic_goal,
        personal_goal: mind.personal_goal,
        current_intention: mind.current_intention,
        known_memes: mind.known_memes ?? [],
        beliefs: mind.beliefs ?? {},
        civic_context: ctx,
    };
}

export function formatMindStatus(npc) {
    const m = ensureMindShape(npc);
    return [
        `cilj: ${m.daily_goal ?? 'se oblikuje'}`,
        `socialno: ${m.social_goal ?? 'brez'}`,
        `skupnost: ${m.civic_goal ?? 'brez'}`,
        `namen zdaj: ${m.current_intention ?? 'opazuje svet'}`,
    ].join(' | ');
}

function ensureMindShape(npc) {
    const data = npc.state.data;
    data.mind ??= {};
    const m = data.mind;
    m.day ??= -1;
    m.daily_goal ??= null;
    m.social_goal ??= null;
    m.civic_goal ??= null;
    m.personal_goal ??= null;
    m.current_intention ??= null;
    m.known_memes ??= [];
    m.beliefs ??= { tax_support: 50, town_identity: 50, lawfulness: npc.state.data.lastnosti?.postenost ?? 50 };
    m.commitments ??= [];
    m.last_goal_update ??= null;
    m.last_social_action_at ??= 0;
    m.last_culture_action_at ??= 0;
    m.last_tax_attempt_at ??= 0;
    m.last_audit_at ??= 0;
    m.last_audit_day ??= -1;
    return m;
}

function ensureDailyAgenda(npc, civic, day) {
    const m = ensureMindShape(npc);
    if (m.day === day && m.daily_goal) return;

    const p = npc.state.data.potrebe;
    m.day = day;
    m.daily_goal = jobGoal(npc);
    m.social_goal = socialGoal(npc);
    m.civic_goal = civicGoal(npc, civic);
    m.personal_goal = personalGoal(p);
    m.current_intention = 'jutranji pregled dneva';
    m.last_goal_update = new Date().toISOString();

    const meme = civic.chooseMemeFor(npc, m.known_memes);
    if (meme && Math.random() < 0.75) {
        rememberMeme(npc, civic, meme);
    }

    npc.state.save();
    civic.addPublicEvent('agenda', npc.cfg.id, `${npc.cfg.osebnost.ime} si je zastavil/a cilj: ${m.daily_goal}`, {
        social_goal: m.social_goal,
        civic_goal: m.civic_goal,
    });
    npc.log.info(`mind agenda: ${m.daily_goal} | ${m.social_goal} | ${m.civic_goal}`);
}

function updateIntention(npc, civic) {
    const m = ensureMindShape(npc);
    const p = npc.state.data.potrebe;
    let intention;
    if (p.sitost < 25) intention = 'najti hrano';
    else if (p.utrujenost > 80) intention = 'prisparati energijo';
    else if (npc.currentActivity === 'work') intention = m.daily_goal;
    else if (npc.currentActivity === 'free' && p.druzabnost < 35) intention = m.social_goal;
    else if (npc.currentActivity === 'free') intention = m.civic_goal ?? 'opazovati mesto';
    else intention = 'drzati se ritma dneva';

    if (intention !== m.current_intention) {
        m.current_intention = intention;
        m.last_goal_update = new Date().toISOString();
        npc.state.save();
    }

    if (civic?.taxLaw?.() && m.beliefs) {
        m.beliefs.lawfulness = clamp((m.beliefs.lawfulness * 0.98) + ((npc.state.data.lastnosti.postenost ?? 50) * 0.02), 0, 100);
    }
}

function jobGoal(npc) {
    switch (npc.cfg.job) {
        case 'woodcutter': return 'nabrati les, posaditi nazaj in del pridelka prinesti mestu';
        case 'miner': case 'gatherer': return 'nabrati uporabne surovine in jih spraviti v skupno mrezo zalog';
        case 'innkeeper': return 'nahraniti ljudi, slisati novice in povezovati prebivalce';
        case 'policeman': case 'guard': return 'varovati ljudi, javno zalogo in mir med sosedi';
        case 'builder': return 'iskati naslednjo smiselno parcelo in graditi po mestnem nacrtu';
        case 'steward': return 'urediti javno zalogo, opaziti manjkajoce stvari in povezati potrebe mesta';
        case 'cook': return 'poskrbeti, da delavci niso lacni in da gostilna ostane socialno sredisce';
        default: return 'najti koristno mesto v skupnosti';
    }
}

function socialGoal(npc) {
    const target = chooseSocialTarget(npc);
    if (!target) return 'opazovati ljudi in ostati odprt za pogovor';
    const trust = npc.state.data.odnosi_npcji?.[target.cfg.id]?.zaupanje ?? 50;
    if (trust < 40) return `popraviti odnos z ${target.cfg.osebnost.ime}`;
    if ((npc.state.data.potrebe.druzabnost ?? 50) < 40) return `poiskati pogovor z ${target.cfg.osebnost.ime}`;
    return `ohraniti stik z ${target.cfg.osebnost.ime}`;
}

function civicGoal(npc, civic) {
    const law = civic.taxLaw();
    if (isLawman(npc)) return 'preveriti, ali zakoni sluzijo mestu in ne samo pravilom';
    if (law) return `prispevati k skupnemu pravilu: ${law.name}`;
    return 'pomagati, da mesto deluje kot skupnost';
}

function personalGoal(p) {
    if ((p.sitost ?? 100) < 35) return 'najprej poskrbeti za hrano';
    if ((p.utrujenost ?? 0) > 70) return 'dan preziveti bolj pocasi';
    if ((p.druzabnost ?? 50) < 35) return 'ne ostati cel dan sam';
    return 'obdrzati dober ritem in mirno glavo';
}

function shouldPayTax(npc, civic, day, timeOfDay) {
    const law = civic.taxLaw();
    if (!law || isLawman(npc)) return false;
    if (civic.hasPaidTax(npc.cfg.id, day)) return false;
    if (timeOfDay < (law.due_after_tick ?? 9000)) return false;
    if (Date.now() - (ensureMindShape(npc).last_tax_attempt_at ?? 0) < 4 * 60_000) return false;
    if (npc.currentActivity === 'work' && timeOfDay < (npc.schedule.work_end ?? 9000)) return false;
    return hasTaxableInventory(npc, law);
}

function hasTaxableInventory(npc, law) {
    return Object.values(calculateTaxItems(npc, law)).some(count => count > 0);
}

export async function payTax(npc, civic, day) {
    const law = civic.taxLaw();
    if (!law) return false;
    const regionName = law.storage_region ?? 'mestna_zaloga';
    const region = npc.locations[regionName];
    if (!region) {
        npc.log.warn(`tax: no storage region '${regionName}'`);
        return false;
    }

    const items = calculateTaxItems(npc, law);
    const value = Object.values(items).reduce((s, n) => s + n, 0);
    if (value <= 0) {
        civic.recordTaxMiss(npc.cfg.id, day, 'no taxable inventory');
        return false;
    }

    npc.log.info(`tax: delivering ${JSON.stringify(items)} to ${regionName}`);
    const chest = await gotoChestInRegion(
        npc.bot, region, npc.storage, npc.log, Object.values(npc.cfg.chests ?? {}));
    if (!chest) {
        npc.log.warn(`tax: no chest in '${regionName}'`);
        civic.addPublicEvent('tax_failed', npc.cfg.id, `${npc.cfg.osebnost.ime} ni nasel/la mestne skrinje za prispevek.`, { day, regionName });
        return false;
    }

    const deposited = await depositLimited(npc, chest, items, regionName);
    const depositedValue = Object.values(deposited).reduce((s, n) => s + n, 0);
    if (depositedValue > 0) {
        civic.recordTax(npc.cfg.id, day, deposited, depositedValue);
        const m = ensureMindShape(npc);
        m.beliefs.tax_support = clamp((m.beliefs.tax_support ?? 50) + 1, 0, 100);
        npc.state.applyDelta({ slisal: [`Danes si oddal mestni prispevek: ${formatItems(deposited)}.`] }, 'tax_paid');
        if (Math.random() < 0.4) npc.bot.chat(pickLine(['Nekaj gre v mestno zalogo.', 'Naj bo vsaj zaloga urejena.', 'Tole je za skupno dobro.']));
        return true;
    }
    return false;
}

function calculateTaxItems(npc, law) {
    const taxable = new Set(law.applies_to ?? []);
    const rate = clamp(Number(law.rate ?? 0.2), 0, 1);
    const result = {};
    for (const it of npc.bot.inventory.items()) {
        if (!taxable.has(it.name) || isTool(it.name)) continue;
        const qty = Math.floor(it.count * rate);
        if (qty > 0) result[it.name] = (result[it.name] ?? 0) + qty;
    }
    return result;
}

async function depositLimited(npc, chestBlock, itemsByName, regionName) {
    const bot = npc.bot;
    const key = `${chestBlock.position.x},${chestBlock.position.y},${chestBlock.position.z}`;
    const deposited = {};
    await withChestLock(key, async () => {
        let win;
        try {
            win = await openContainerSafe(bot, chestBlock);
            for (const [name, targetCount] of Object.entries(itemsByName)) {
                let left = targetCount;
                for (const it of bot.inventory.items().filter(i => mcCompat.stackMatchesName(i, name, bot))) {
                    if (left <= 0) break;
                    const n = Math.min(it.count, left);
                    try {
                        await win.deposit(it.type, it.metadata, n, it.nbt);
                        deposited[name] = (deposited[name] ?? 0) + n;
                        left -= n;
                    } catch (e) {
                        npc.log.warn(`tax deposit ${name} failed: ${e.message}`);
                        break;
                    }
                }
            }
        } finally {
            if (win) {
                try { await win.close(); } catch { /* disconnected */ }
            }
        }
    });
    await npc.storage.scanRegion(bot, npc.region(regionName), regionName);
    return deposited;
}

function shouldAudit(npc, civic, day, timeOfDay) {
    const law = civic.taxLaw();
    const m = ensureMindShape(npc);
    if (!law || m.last_audit_day === day) return false;
    if (timeOfDay < (law.grace_until_tick ?? 17000)) return false;
    if (Date.now() - (m.last_audit_at ?? 0) < AUDIT_COOLDOWN_MS) return false;
    return true;
}

async function auditTown(npc, civic, day) {
    const m = ensureMindShape(npc);
    m.last_audit_day = day;
    const ledger = civic.taxLedgerFor(day);
    const missing = [];
    for (const other of npc.registry ?? []) {
        if (other === npc || isLawman(other)) continue;
        if (other.cfg.job === 'idle') continue;
        if (!ledger[other.cfg.id]?.paid_at && !ledger[other.cfg.id]?.checked_at) {
            missing.push(other);
            civic.adjustReputation(other.cfg.id, { public_trust: -2, respect: -1, notoriety: 1 }, 'missed_tax', false);
            npc.state.applyDelta({ odnosi_npcji: { [other.cfg.id]: { zaupanje: -2 } } }, 'tax_audit');
        }
    }
    civic.addPublicEvent('tax_audit', npc.cfg.id, `${npc.cfg.osebnost.ime} je preveril/a mestne prispevke.`, {
        day,
        missing: missing.map(o => o.cfg.id),
    });
    npc.state.save();

    if (missing.length > 0) {
        npc.bot.chat(`Danes se moramo pogovoriti o prispevkih: ${missing.map(o => o.cfg.osebnost.ime).join(', ')}.`);
    } else if (Math.random() < 0.5) {
        npc.bot.chat('Mestna zaloga je danes lepo pod nadzorom.');
    }
    await sleep(1000);
}

function shouldSocialize(npc) {
    const m = ensureMindShape(npc);
    const p = npc.state.data.potrebe;
    if (Date.now() - (m.last_social_action_at ?? 0) < SOCIAL_COOLDOWN_MS) return false;
    return (p.druzabnost ?? 50) < 45 || (npc.state.data.lastnosti.socialnost ?? 50) > 65;
}

function chooseSocialTarget(npc) {
    const candidates = (npc.registry ?? []).filter(o =>
        o !== npc && o.bot?.entity && !o.bot.isSleeping && o.currentActivity !== 'jail');
    if (candidates.length === 0) return null;

    const relations = npc.state.data.odnosi_npcji ?? {};
    return candidates
        .map(o => ({
            npc: o,
            score: socialScore(npc, o, relations[o.cfg.id]?.zaupanje ?? 50),
        }))
        .sort((a, b) => b.score - a.score)[0].npc;
}

function socialScore(npc, other, trust) {
    const distance = npc.bot.entity.position.distanceTo(other.bot.entity.position);
    const repairBonus = trust < 40 ? 25 : 0;
    const friendBonus = trust > 65 ? 10 : 0;
    const roleBonus = (['innkeeper', 'cook', 'steward'].includes(npc.cfg.job) || ['innkeeper', 'cook', 'steward'].includes(other.cfg.job)) ? 8 : 0;
    return repairBonus + friendBonus + roleBonus - distance * 0.4 + Math.random() * 8;
}

async function seekSocialContact(npc, target, civic) {
    if (!target.bot?.entity || target.bot.isSleeping) return;
    await gotoNear(npc.bot, target.bot.entity.position, 3, npc.log, 15_000);
    if (!target.bot?.entity || npc.bot.entity.position.distanceTo(target.bot.entity.position) > 8) return;

    const meme = currentMeme(npc, civic);
    const line = socialLine(npc, target, meme);
    npc.bot.chat(line);
    onSocialized(npc, 8);
    onSocialized(target, 5);
    npc.state.applyDelta({ odnosi_npcji: { [target.cfg.id]: { zaupanje: 1 } } }, 'autonomous_social');
    target.state.applyDelta({ odnosi_npcji: { [npc.cfg.id]: { zaupanje: 1 } } }, 'autonomous_social');
    civic.addPublicEvent('social_contact', npc.cfg.id, `${npc.cfg.osebnost.ime} je poiskal/a pogovor z ${target.cfg.osebnost.ime}.`, {
        target: target.cfg.id,
    });
    await sleep(1500);
}

function shouldSpreadCulture(npc) {
    const m = ensureMindShape(npc);
    if (Date.now() - (m.last_culture_action_at ?? 0) < CULTURE_COOLDOWN_MS) return false;
    const identity = m.beliefs?.town_identity ?? 50;
    return Math.random() < (0.2 + identity / 250);
}

async function spreadCulture(npc, civic) {
    const mind = ensureMindShape(npc);
    let meme = currentMeme(npc, civic);
    if (!meme) {
        meme = civic.chooseMemeFor(npc, mind.known_memes);
        if (meme) rememberMeme(npc, civic, meme);
    }
    if (!meme) return;

    const near = (npc.registry ?? []).filter(o =>
        o !== npc && o.bot?.entity && o.bot.entity.position.distanceTo(npc.bot.entity.position) <= 10);
    const target = near.find(o => !(ensureMindShape(o).known_memes ?? []).includes(meme.id));
    if (target) {
        ensureMindShape(target).known_memes.push(meme.id);
        target.state.applyDelta({ slisal: [`${npc.cfg.osebnost.ime} je omenil/a mestno navado: ${meme.text}`] }, 'culture');
        civic.spreadMeme(meme.id, npc.cfg.id, target.cfg.id);
        target.state.save();
    } else {
        civic.adoptMeme(npc.cfg.id, meme.id);
    }

    if (hasPlayerAudience(npc) || Math.random() < 0.25) {
        npc.bot.chat(cultureLine(npc, meme));
    }
    const m = ensureMindShape(npc);
    m.beliefs.town_identity = clamp((m.beliefs.town_identity ?? 50) + 1, 0, 100);
    npc.state.save();
    await sleep(1000);
}

function rememberMeme(npc, civic, meme) {
    const mind = ensureMindShape(npc);
    if (!mind.known_memes.includes(meme.id)) mind.known_memes.push(meme.id);
    mind.known_memes = mind.known_memes.slice(-12);
    civic.adoptMeme(npc.cfg.id, meme.id, false);
    npc.state.applyDelta({ slisal: [`Mestna navada: ${meme.text}`] }, 'culture_adopted');
}

function currentMeme(npc, civic) {
    const known = ensureMindShape(npc).known_memes ?? [];
    const memes = civic.data.culture.memes.filter(m => known.includes(m.id));
    if (memes.length === 0) return null;
    return memes.sort((a, b) => Number(b.strength ?? 0) - Number(a.strength ?? 0))[0];
}

function socialLine(npc, target, meme) {
    const role = npc.cfg.job;
    if (meme && Math.random() < 0.45) return `${target.cfg.osebnost.ime}, ${meme.text}`;
    if (role === 'innkeeper') return pickLine([`Kako si, ${target.cfg.osebnost.ime}?`, `Pridi kasneje mimo gostilne, ce bos lacen.`, `Kaj se danes govori po mestu?`]);
    if (role === 'policeman' || role === 'guard') return pickLine([`Vse v redu, ${target.cfg.osebnost.ime}?`, `Samo preverjam, da je mir.`, `Ce kaj opazis pri zalogi, mi povej.`]);
    if (role === 'woodcutter') return pickLine([`Danes bom spravil nekaj lesa v zalogo.`, `Gozd je miren, za zdaj.`, `${target.cfg.osebnost.ime}, ce rabis drva, povej.`]);
    if (role === 'miner' || role === 'gatherer') return pickLine([`Ce grem spet dol, hocem pot nazaj oznaceno.`, `Kamen in ruda gresta v mesto, ne v zep.`, `${target.cfg.osebnost.ime}, ce vidis bakle, mi povej.`]);
    if (role === 'builder') return pickLine([`Mesto mora stati tako, da ga ne bo sram.`, `Ce rabis kaj popraviti, povej prej kot kasneje.`, `${target.cfg.osebnost.ime}, dober temelj prihrani tri prepire.`]);
    if (role === 'steward') return pickLine([`Javna zaloga mora imeti rep in glavo.`, `Ce kdo vzame zadnji kos, naj vsaj pove.`, `${target.cfg.osebnost.ime}, danes preverjam skrinje.`]);
    if (role === 'cook') return pickLine([`Lacen clovek ne dela dobrih nacrtov.`, `Pridi mimo kuhinje, ce bos brez hrane.`, `${target.cfg.osebnost.ime}, ne hodi v rudnik na prazen zelodec.`]);
    return pickLine([`Kako gre, ${target.cfg.osebnost.ime}?`, `Danes je kar ziv dan.`, `Se vidimo na trgu kasneje.`]);
}

function cultureLine(npc, meme) {
    if (npc.cfg.job === 'policeman' || npc.cfg.job === 'guard') return meme.text;
    if (npc.cfg.job === 'innkeeper' || npc.cfg.job === 'cook') return `Saj veste: ${meme.text}`;
    if (npc.cfg.job === 'steward') return `Za zapisnik: ${meme.text}`;
    return meme.text;
}

function hasPlayerAudience(npc) {
    return Object.values(npc.bot.players).some(p =>
        p.entity && p.username !== npc.bot.username &&
        !npc.settings.npcs.some(id => id.toLowerCase() === p.username.toLowerCase()) &&
        p.entity.position.distanceTo(npc.bot.entity.position) <= 16);
}

function isLawman(npc) {
    return npc.cfg.job === 'policeman' || npc.cfg.job === 'guard';
}

function isTool(name) {
    return TOOL_SUFFIXES.some(suffix => name.endsWith(suffix)) || ['shield', 'bow', 'crossbow'].includes(name);
}

function formatItems(items) {
    return Object.entries(items).map(([name, count]) => `${count}x ${name}`).join(', ');
}

const pickLine = (lines) => lines[Math.floor(Math.random() * lines.length)];
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
