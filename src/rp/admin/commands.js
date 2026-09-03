// In-game admin commands. Whitelisted players only (settings.admin_players).
// Commands write straight into the JSON configs so they survive restarts.
// Each NPC's bot listens; commands targeting an NPC are handled by that NPC's bot,
// world commands (!setlokacija) by whichever bot hears them first (deduped by timestamp).
import { readFileSync } from 'fs';
import { Vec3 } from 'vec3';
import { handleControlCommand } from './control.js';
import { employ, unemploy, setVendor } from './employ.js';
import { formatMindStatus } from '../systems/mind.js';
import { formatSocialStatus } from '../systems/social_bonds.js';
import { formatSocietyStatus, formatTownSocietyStatus } from '../systems/status.js';
import * as mcCompat from '../../utils/mc_compat.js';
import { writeJsonAtomic } from '../../utils/atomic_json.js';

const recentCommands = new Map(); // dedupe: "user:msg" -> timestamp

export function attachAdminCommands(npc, paths) {
    const bot = npc.bot;

    bot.on('chat', async (username, message) => {
        if (username === bot.username) return;
        if (!message.startsWith('!')) return;
        if ((npc.settings.blacklisted_players ?? []).some(name => name.toLowerCase() === username.toLowerCase())) return;
        if (!npc.settings.admin_players.includes(username)) return;

        // dedupe between bots: world-level commands should run once
        const key = `${username}:${message}`;
        const now = Date.now();
        if (recentCommands.get(key) && now - recentCommands.get(key) < 3000) return;

        const [cmd, ...args] = message.trim().split(/\s+/);
        try {
            switch (cmd) {
                case '!setlokacija': return await setLokacija(npc, paths, username, args, key, now);
                case '!sethome': return setHome(npc, paths, username, args);
                case '!setjob': return setJob(npc, paths, username, args);
                case '!setjobdesc': return setJobDesc(npc, paths, username, args);
                case '!setskrinja': return await setSkrinja(npc, paths, username, args, key, now);
                case '!status': return status(npc, args);
                case '!odnosi': return socialStatus(npc, args);
                case '!mesto': return townStatus(npc, key, now);
                case '!help': case '!pomoc': case '!ukazi': return help(npc, key, now);
                case '!zaposli': return await employ(npc, paths, username, args);   // AI configures the whole job
                case '!odpusti': return unemploy(npc, paths, username, args);
                case '!prodajnik': return setVendor(npc, paths, username, args);    // enable NPC->NPC selling
                default: return handleControlCommand(npc, cmd, username, args); // come/follow/go/give/say...
            }
        } catch (e) {
            npc.log.error(`admin command failed: ${e.message}`);
            // "can't see player" is expected when several bots race for the same command — stay quiet
            if (!e.message.startsWith('ne vidim igralca')) bot.chat(`Napaka: ${e.message}`);
        }
    });
}

function playerPos(bot, username) {
    const p = bot.players[username]?.entity?.position;
    if (!p) throw new Error(`ne vidim igralca ${username} (predaleč?)`);
    return p;
}

function editJson(path, fn) {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    fn(data);
    writeJsonAtomic(path, data);
    return data;
}

// !setlokacija <ime> <radij> — save my position as a region
function setLokacija(npc, paths, username, args, key, now) {
    const [name, radiusStr] = args;
    if (!name) return npc.bot.chat('Uporaba: !setlokacija <ime> <radij>');
    const pos = playerPos(npc.bot, username); // throws if this bot can't see the player -> next bot tries
    recentCommands.set(key, now);
    const region = { center: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, radius: parseInt(radiusStr) || 10 };
    editJson(paths.locations, d => { d[name] = region; });
    npc.locations[name] = region;
    npc.log.info(`region '${name}' saved at ${JSON.stringify(region.center)} r=${region.radius}`);
    npc.bot.chat(`Regija '${name}' shranjena (r=${region.radius}).`);
}

// !sethome <NPC> — NPC's home = my position (creates region <npc>_dom)
function setHome(npc, paths, username, args) {
    const [target] = args;
    if (target?.toLowerCase() !== npc.cfg.id) return;
    const pos = playerPos(npc.bot, username);
    const name = `${npc.cfg.id}_dom`;
    const region = { center: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, radius: 8 };
    editJson(paths.locations, d => { d[name] = region; });
    npc.locations[name] = region;
    editJson(paths.npcConfig, d => { d.home_region = name; });
    npc.cfg.home_region = name;
    npc.bot.chat(`Dom za ${npc.cfg.osebnost.ime} nastavljen.`);
}

// !setjob <NPC> <job> <regija>
function setJob(npc, paths, username, args) {
    const [target, job, region] = args;
    if (target?.toLowerCase() !== npc.cfg.id) return;
    if (!job || !region) return npc.bot.chat('Uporaba: !setjob <NPC> <job> <regija>');
    if (!npc.locations[region]) return npc.bot.chat(`Regija '${region}' ne obstaja. Najprej !setlokacija.`);
    editJson(paths.npcConfig, d => { d.job = job; d.job_region = region; });
    npc.cfg.job = job;
    npc.cfg.job_region = region;
    npc.jobState = null; // reset shift state
    npc.bot.chat(`${npc.cfg.osebnost.ime}: job '${job}' v regiji '${region}'.`);
}

// !setjobdesc <NPC> <besedilo...> — free text; LLM parsing comes in phase 3,
// for now we run a tiny keyword parser and warn if ambiguous.
function setJobDesc(npc, paths, username, args) {
    const [target, ...words] = args;
    if (target?.toLowerCase() !== npc.cfg.id) return;
    const text = words.join(' ');
    if (!text) return npc.bot.chat('Uporaba: !setjobdesc <NPC> <besedilo>');
    const rules = parseJobDescription(text, npc);
    editJson(paths.npcConfig, d => { d.job_description = text; d.job_rules = rules; });
    npc.cfg.job_description = text;
    npc.cfg.job_rules = rules;
    npc.bot.chat(`Opis dela shranjen. Oddaja: '${rules.deliver_to}', obdrži: ${Math.round(rules.keep_ratio * 100)} %.`);
}

// Deterministic keyword parser (placeholder until LLM parsing in phase 3).
export function parseJobDescription(text, npc) {
    const t = text.toLowerCase();
    let deliver_to = npc.cfg.home_region;
    let keep_ratio = 1;
    // find a known region name mentioned in the text
    for (const name of Object.keys(npc.locations)) {
        if (t.includes(name.toLowerCase()) && name !== npc.cfg.job_region && name !== npc.cfg.home_region) {
            deliver_to = name;
            keep_ratio = 0;
        }
    }
    if (/(domov|doma|obdrži|hraniš)/.test(t) && /(vse|všetko)/.test(t)) { deliver_to = npc.cfg.home_region; keep_ratio = 1; }
    if (/polovic/.test(t)) keep_ratio = 0.5;
    return { deliver_to, keep_ratio, replant: /sapling|posadi/.test(t) || true };
}

// !setskrinja <NPC> <namen> — nearest chest to the admin (within 5 blocks) becomes NPC's
function setSkrinja(npc, paths, username, args, key, now) {
    const [target, purpose] = args;
    if (target?.toLowerCase() !== npc.cfg.id) return;
    const pos = playerPos(npc.bot, username);
    recentCommands.set(key, now);
    const chestIds = mcCompat.registryBlockIds(npc.bot, ['chest', 'trapped_chest', 'barrel']);
    const found = npc.bot.findBlocks({ point: pos, matching: chestIds, maxDistance: 5, count: 1 });
    if (found.length === 0) return npc.bot.chat('Ne najdem skrinje v tvoji bližini (5 blokov).');
    const p = found[0];
    editJson(paths.npcConfig, d => {
        d.chests = d.chests ?? {};
        d.chests[purpose ?? 'osebna'] = { x: p.x, y: p.y, z: p.z };
    });
    npc.cfg.chests = { ...(npc.cfg.chests ?? {}), [purpose ?? 'osebna']: { x: p.x, y: p.y, z: p.z } };
    npc.bot.chat(`Skrinja (${purpose ?? 'osebna'}) na ${p.x},${p.y},${p.z} je zdaj ${npc.cfg.osebnost.ime}-jeva.`);
}

// !help — list every command. Deduped so only ONE bot answers (no triple spam).
function help(npc, key, now) {
    if (recentCommands.get(key) && now - recentCommands.get(key) < 3000) return;
    recentCommands.set(key, now);
    const bot = npc.bot;
    const lines = [
        '=== UKAZI === (cilj je <npc> ali "vsi")',
        'Postavitev: !setlokacija <ime> <radij> | !sethome <npc> | !setskrinja <npc> <namen>',
        'Delo (AI): !zaposli <npc> <opis dela> | !odpusti <npc> | !prodajnik <npc> [off]',
        'Delo (rocno): !setjob <npc> <job> <regija> | !setjobdesc <npc> <besedilo>',
        'Vodenje: !pridi | !sledi | !ostani | !pojdi <npc> <regija> | !domov | !prosto',
        'Vodenje: !delaj | !spat | !daj <npc> <item> <kol> | !reci <npc> <besedilo>',
        'Trgovanje: !cena <npc> <item> | !kupi <npc> <item> <kol> | !prodaj <npc> <item> <kol> | !sprejmi/!zavrni <npc>',
        'Info: !status <npc> | !odnosi <npc> | !mesto | !help',
    ];
    void (async () => {
        for (const l of lines) { bot.chat(l); await new Promise(r => setTimeout(r, 350)); }
    })();
}

// !status <NPC>
function status(npc, args) {
    const [target] = args;
    if (target && target.toLowerCase() !== npc.cfg.id) return;
    const b = npc.bot;
    const logs = b.inventory.items()
        .filter(i => mcCompat.aliasesForLegacyStack(i.name, i.metadata, b).some(name => name.endsWith('_log')))
        .reduce((s, i) => s + i.count, 0);
    npc.bot.chat(
        `${npc.cfg.osebnost.ime}: ${npc.currentActivity ?? '?'} | poz ${Math.floor(b.entity.position.x)},${Math.floor(b.entity.position.y)},${Math.floor(b.entity.position.z)} | hlodi v inv: ${logs} | hp ${Math.round(b.health)}`
    );
    if (npc.state) {
        const p = npc.state.data.potrebe;
        npc.bot.chat(`mood: ${npc.state.data.mood_danes} | denar ${p.denar} | sitost ${p.sitost} | druzabnost ${p.druzabnost} | utrujenost ${p.utrujenost}`);
        npc.bot.chat(`mind: ${formatMindStatus(npc)}`);
        npc.bot.chat(`odnosi: ${formatSocialStatus(npc)}`);
        for (const line of formatSocietyStatus(npc)) npc.bot.chat(line);
    }
    const ev = npc.eventLog?.recent(2) ?? [];
    if (ev.length) npc.bot.chat(`zadnji dogodki: ${ev.map(e => `${e.akter}: ${e.tip}`).join(' | ')}`);
    if (npc.llm) npc.bot.chat(npc.llm.usageSummary());
}

function townStatus(npc, key, now) {
    if (recentCommands.get(key) && now - recentCommands.get(key) < 3000) return;
    recentCommands.set(key, now);
    npc.bot.chat(`Mesto: ${npc.civic?.summary?.() ?? 'skupni um se ni zagnal'}`);
    for (const line of formatTownSocietyStatus(npc.registry ?? [npc], npc.civic)) npc.bot.chat(line);
}

function socialStatus(npc, args) {
    const [target] = args;
    if (target && target.toLowerCase() !== npc.cfg.id) return;
    npc.bot.chat(`${npc.cfg.osebnost.ime} odnosi: ${formatSocialStatus(npc)}`);
}
