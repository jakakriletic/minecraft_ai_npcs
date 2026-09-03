// AI-driven employment: the admin describes a job in plain language, the
// background model turns that into ALL structured parameters (job type, where to
// work, schedule, what to do with the goods), the code validates them and saves
// to config. Jobs are NOT a predisposition — an NPC does whatever it's told to.
//
//   !zaposli <npc> <prosto besedilo>   — employ via AI (sets job + region + schedule + delivery)
//   !odpusti <npc>                     — fire (back to idle/citizen life)
//   !prodajnik <npc> [off]             — toggle vendor flag (may sell to other NPCs)
import { readFileSync } from 'fs';
import { validateSchedule } from '../core/scheduler.js';
import { writeJsonAtomic } from '../../utils/atomic_json.js';

// Job types the system can actually execute, described for the AI to choose from.
const JOB_TYPES = {
    woodcutter: 'seka drevesa (hlode) v gozdu in posadi saplinge nazaj',
    miner: 'koplje kamen in rudo (potrebuje regijo z rudo/kamnom)',
    gatherer: 'nabira lokalne surovine v izbrani regiji',
    builder: 'je prisoten na gradbiscu, popravlja in pripravlja naslednje mestne gradnje',
    steward: 'skrbi za javno zalogo, red v skrinjah in mestne prispevke',
    cook: 'dela v kuhinji ali gostilni, skrbi za obroke in ljudi',
    innkeeper: 'vodi gostilno, je tam in streže gostom',
    policeman: 'skrbi za red, davke in mestne spore',
    guard: 'patruljira po dodeljeni regiji in skrbi za red',
    idle: 'navaden prebivalec brez posebnega dela',
};

const PROMPT = (npc, text, regions) => `Si pomožni sistem, ki iz navodila admina sestavi parametre dela za NPC-ja v Minecraft mestu.
Razpoložljivi tipi dela: ${Object.entries(JOB_TYPES).map(([k, v]) => `${k} (${v})`).join('; ')}.
Znane regije (uporabi TOČNO ta imena): ${regions.join(', ')}.
Čas dneva je v tickih 0-24000: 0=6:00 jutro, 6000=poldne, 12000=18:00 večer, 18000=polnoč.

Navodilo admina: "${text}"

Vrni SAMO veljaven JSON (brez razlage, brez markdown):
{"job": "<eden od tipov>",
 "job_region": "<ime znane regije kjer dela, ali null>",
 "gather_targets": ["<imena blokov za miner, npr. stone, iron_ore>"] ali null,
 "deliver_to": "<ime regije kamor nosi pridelek, ali 'domov'>",
 "keep_ratio": <0..1, koliko pridelka obdrži zase>,
 "work_start": <tick>, "work_end": <tick>,
 "sleep_start": <tick>, "sleep_end": <tick>}
Če navodilo ne omenja urnika, izberi smiseln dnevni šiht in nočno spanje. Spanje se NE sme prekrivati z delom.`;

export async function employ(npc, paths, username, args) {
    const [target, ...words] = args;
    if (target?.toLowerCase() !== npc.cfg.id) return;
    const text = words.join(' ');
    if (!text) return npc.bot.chat('Uporaba: !zaposli <NPC> <opis dela>');
    if (!npc.llm) return npc.bot.chat('Brez AI tega ne morem urediti — uporabi !setjob.');

    npc.bot.chat('Razumem, malo premislim...');
    const regions = Object.keys(npc.locations);
    const reply = await npc.llm.chat(npc.cfg.id, 'Vrni samo veljaven JSON.', [{ role: 'user', content: PROMPT(npc, text, regions) }], 'ozadje');
    const params = extractJson(reply);
    if (!params?.job) {
        npc.log.warn(`employ: bad AI output: ${reply?.slice(0, 100)}`);
        return npc.bot.chat('Nisem čisto razumel naloge. Poskusi drugače ali uporabi !setjob.');
    }
    applyJob(npc, paths, params);
}

function applyJob(npc, paths, p) {
    const job = JOB_TYPES[p.job] ? p.job : 'idle';
    let region = (p.job_region && npc.locations[p.job_region]) ? p.job_region : null;
    const needsRegion = ['woodcutter', 'miner', 'gatherer', 'builder', 'steward', 'cook', 'policeman', 'guard', 'innkeeper'].includes(job);

    // schedule: sanitize to ints in [0,24000], then validate (no sleep/work overlap)
    const tick = (v, d) => Number.isFinite(v) ? ((Math.round(v) % 24000) + 24000) % 24000 : d;
    const schedule = validateSchedule({
        work_start: tick(p.work_start, 1000), work_end: tick(p.work_end, 9000),
        sleep_start: tick(p.sleep_start, 13000), sleep_end: tick(p.sleep_end, 23000),
    }, npc.log);

    const deliver_to = (p.deliver_to && npc.locations[p.deliver_to]) ? p.deliver_to
        : (p.deliver_to === 'domov' ? npc.cfg.home_region : npc.cfg.home_region);
    const keep_ratio = Math.max(0, Math.min(1, Number(p.keep_ratio) || 0));
    const gather_targets = Array.isArray(p.gather_targets) ? p.gather_targets.filter(s => typeof s === 'string') : null;

    if (needsRegion && !region) region = npc.cfg.home_region; // fall back so it at least stands somewhere

    const patch = {
        job, job_region: region ?? npc.cfg.home_region,
        job_rules: { deliver_to, keep_ratio, replant: job === 'woodcutter' },
        schedule,
    };
    if (gather_targets) patch.gather_targets = gather_targets;

    editJson(paths.npcConfig, d => Object.assign(d, patch));
    Object.assign(npc.cfg, patch);
    npc.schedule = schedule;
    npc.jobState = null;
    npc.forcedActivity = null;

    npc.log.info(`employed as ${job} in '${patch.job_region}', deliver_to=${deliver_to} keep=${keep_ratio}`);
    npc.bot.chat(`Velja. Od zdaj delam kot ${job}${region ? ` v '${region}'` : ''}.`);
    if (needsRegion && !npc.locations[region]) npc.bot.chat('Le povej mi še, kje točno — !setlokacija pa !setjob.');
}

export function unemploy(npc, paths, username, args) {
    const [target] = args;
    if (target?.toLowerCase() !== npc.cfg.id) return;
    const patch = { job: 'idle', job_region: npc.locations['center'] ? 'center' : npc.cfg.home_region };
    editJson(paths.npcConfig, d => Object.assign(d, patch));
    Object.assign(npc.cfg, patch);
    npc.jobState = null;
    npc.forcedActivity = null;
    npc.bot.chat('Prav, brez dela sem zdaj.');
}

export function setVendor(npc, paths, username, args) {
    const [target, flag] = args;
    if (target?.toLowerCase() !== npc.cfg.id) return;
    const on = flag?.toLowerCase() !== 'off';
    editJson(paths.npcConfig, d => { d.vendor = on; });
    npc.cfg.vendor = on;
    npc.bot.chat(on ? 'Od zdaj prodajam svoje stvari drugim vaščanom.' : 'Ne prodajam več.');
    npc.log.info(`vendor flag -> ${on}`);
}

function editJson(path, fn) {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    fn(data);
    writeJsonAtomic(path, data);
}

function extractJson(text) {
    if (!text) return null;
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}
