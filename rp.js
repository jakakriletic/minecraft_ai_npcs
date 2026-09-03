// RP town entry point. Run with: node rp.js
import { readFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, isAbsolute, join } from 'path';
import { Npc } from './src/rp/npc.js';
import { Llm } from './src/rp/chat/llm.js';
import { makeLogger } from './src/rp/core/logger.js';
import { CivicState } from './src/rp/state/civicState.js';
import { validateSchedule } from './src/rp/core/scheduler.js';
import { getSocietyStatus } from './src/rp/systems/status.js';
import { writeJsonAtomic } from './src/utils/atomic_json.js';

const projectDir = dirname(fileURLToPath(import.meta.url));
const configRoot = join(projectDir, 'src', 'rp', 'config');
const stateDir = join(projectDir, 'src', 'rp', 'state');
const runtimeFile = join(stateDir, 'rp-runtime.json');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const settingsFile = resolveSettingsPath(process.argv.slice(2), process.env.RP_SETTINGS);
const settings = readJson(settingsFile);
const locations = readJson(join(configRoot, 'locations.json'));
settings.economyConfig = readJson(join(configRoot, 'economy.json'));
const civicState = new CivicState(join(stateDir, 'town_mind.json'), makeLogger('TOWN'));

function resolveSettingsPath(args, envSettings) {
    const explicit = envSettings || optionValue(args, '--settings') || optionValue(args, '--config');
    const file = explicit || 'settings.json';
    return isAbsolute(file) ? file : join(configRoot, file);
}

function optionValue(args, flag) {
    const withEquals = args.find(arg => arg.startsWith(`${flag}=`));
    if (withEquals) return withEquals.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    if (idx !== -1) return args[idx + 1];
    return null;
}

const llm = settings.llm
    ? new Llm(settings.llm, join(stateDir, 'llm_usage.json'), makeLogger('LLM'))
    : null;
if (llm) {
    const mode = settings.llm.force_fallback
        ? `RAZVOJNI nacin - samo Ollama (${settings.llm.model_fallback})`
        : `${settings.llm.provider ?? 'openai'} (${settings.llm.model_pogovori}/${settings.llm.model_ozadje}) + Ollama fallback`;
    console.log(`LLM: ${mode}`);
}

const regionOwners = {};
const npcConfigs = settings.npcs.map(id => readJson(join(configRoot, 'npcs', `${id}.json`)));
for (const cfg of npcConfigs) {
    if (cfg.home_region) regionOwners[cfg.home_region] = cfg.id;
}

const npcs = [];
for (const [i, id] of settings.npcs.entries()) {
    const npcConfigPath = join(configRoot, 'npcs', `${id}.json`);
    const cfg = npcConfigs[i];
    const paths = {
        locations: join(configRoot, 'locations.json'),
        npcConfig: npcConfigPath,
        stateDir,
    };
    const npc = new Npc(cfg, locations, settings, paths, llm, regionOwners, civicState);
    npcs.push(npc);
    npc.scheduleStart(i * settings.bot_join_stagger_ms);
}
npcs.forEach(n => { n.registry = npcs; });

function writeRuntimeFile() {
    try {
        writeJsonAtomic(runtimeFile, {
            pid: process.pid,
            startedAt: new Date().toISOString(),
            npcs: settings.npcs,
            settingsFile,
            minecraft: settings.minecraft,
            ipc: Boolean(process.send),
        });
    } catch (error) {
        console.warn(`could not write RP runtime file: ${error.message}`);
    }
}

function removeRuntimeFile() {
    try { unlinkSync(runtimeFile); } catch { /* already gone */ }
}

function npcById(id) {
    return npcs.find(n => n.cfg.id === id || n.cfg.username === id || n.cfg.osebnost?.ime === id);
}

function inventoryCounts(npc) {
    const counts = {};
    for (const item of npc.bot?.inventory?.items?.() ?? []) {
        counts[item.name] = (counts[item.name] ?? 0) + item.count;
    }
    return counts;
}

function npcSnapshot(npc) {
    const pos = npc.bot?.entity?.position;
    const society = (() => {
        try { return getSocietyStatus(npc); }
        catch { return null; }
    })();
    return {
        id: npc.cfg.id,
        username: npc.cfg.username,
        name: npc.cfg.osebnost?.ime ?? npc.cfg.id,
        online: Boolean(npc.bot?.entity),
        stopped: npc.stopped,
        activity: npc.currentActivity,
        forcedActivity: npc.forcedActivity,
        command: npc.command,
        health: npc.bot?.health ?? null,
        food: npc.bot?.food ?? null,
        position: pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
        navigation: npc.bot?._navigationDiagnostics ?? null,
        inventory: inventoryCounts(npc),
        society,
    };
}

function reloadSettings() {
    const fresh = readJson(settingsFile);
    Object.keys(settings).forEach(key => delete settings[key]);
    Object.assign(settings, fresh, {
        economyConfig: readJson(join(configRoot, 'economy.json')),
    });
    return settings;
}

function reloadNpc(npcId) {
    const npc = npcById(npcId);
    if (!npc) throw new Error(`unknown NPC '${npcId}'`);
    const cfg = readJson(join(configRoot, 'npcs', `${npc.cfg.id}.json`));
    Object.keys(npc.cfg).forEach(key => delete npc.cfg[key]);
    Object.assign(npc.cfg, cfg);
    npc.schedule = validateSchedule({ ...npc.cfg.schedule }, npc.log);
    try {
        npc.state.data = readJson(join(stateDir, npc.cfg.id, 'state.json'));
    } catch {
        // State may not exist yet on a fresh NPC.
    }
    return npcSnapshot(npc);
}

async function waitForNpcOffline(npc, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (npc.bot && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 100));
    return !npc.bot;
}

async function handleNpcRuntime(npcId, action) {
    const npc = npcById(npcId);
    if (!npc) throw new Error(`unknown NPC '${npcId}'`);
    switch (action) {
        case 'start':
            if (npc.stopped && npc.bot && !await waitForNpcOffline(npc))
                throw new Error(`${npc.cfg.id} did not disconnect in time`);
            if (!npc.bot?.entity) await npc.start();
            break;
        case 'stop':
        case 'kick':
            npc.stop();
            break;
        case 'restart':
            npc.stop();
            if (!await waitForNpcOffline(npc))
                throw new Error(`${npc.cfg.id} did not disconnect in time`);
            await npc.start();
            break;
        default:
            throw new Error(`unknown NPC runtime action '${action}'`);
    }
    return npcSnapshot(npc);
}

function handleNpcControl(npcId, command = {}) {
    const npc = npcById(npcId);
    if (!npc) throw new Error(`unknown NPC '${npcId}'`);
    const player = command.player || settings.admin_players?.[0] || 'Dashboard';
    const type = command.type || command.action;
    switch (type) {
        case 'come':
        case 'pridi':
            npc.command = { type: 'pridi', player };
            break;
        case 'follow':
        case 'sledi':
            npc.command = { type: 'sledi', player };
            break;
        case 'stay':
        case 'ostani':
            npc.command = { type: 'cakaj', player };
            npc.bot?.pathfinder?.stop?.();
            break;
        case 'go':
        case 'pojdi':
            if (!command.region) throw new Error('region is required');
            npc.command = { type: 'pojdi', region: command.region, player };
            break;
        case 'home':
        case 'domov':
            npc.command = { type: 'domov', player };
            break;
        case 'work':
        case 'delaj':
            npc.command = null;
            npc.forcedActivity = 'work';
            break;
        case 'sleep':
        case 'spat':
            npc.command = null;
            npc.forcedActivity = 'sleep';
            break;
        case 'free':
        case 'prosto':
            npc.command = null;
            npc.forcedActivity = null;
            break;
        case 'say':
        case 'reci':
            if (command.text) npc.bot?.chat(String(command.text).slice(0, 250));
            break;
        default:
            throw new Error(`unknown NPC control command '${type}'`);
    }
    return npcSnapshot(npc);
}

async function handleNpcPrompt(npcId, from, message) {
    const npc = npcById(npcId);
    if (!npc) throw new Error(`unknown NPC '${npcId}'`);
    if (typeof npc.directPrompt !== 'function') {
        throw new Error(`${npc.cfg.osebnost?.ime ?? npc.cfg.id} is not ready for direct prompts yet`);
    }
    const reply = await npc.directPrompt(from || 'Dashboard', message);
    return { npc: npcSnapshot(npc), reply };
}

let shuttingDown = false;
async function shutdown(reason = 'SIGINT') {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    console.log(`\nshutting down RP NPCs (${reason}): running reflections (Ctrl+C again to skip)...`);
    if (llm) {
        const { reflect } = await import('./src/rp/state/reflection.js');
        await Promise.race([
            Promise.allSettled(npcs.filter(n => n.bot?.entity).map(n => reflect(n, llm, 'shutdown'))),
            new Promise(resolve => setTimeout(resolve, 30_000)),
        ]);
    }
    console.log('disconnecting bots...');
    npcs.forEach(n => n.stop());
    setTimeout(() => process.exit(0), 1000);
}

function reply(message, ok, resultOrError) {
    if (!process.send || !message?.id) return;
    process.send(ok
        ? { id: message.id, ok: true, result: resultOrError }
        : { id: message.id, ok: false, error: resultOrError?.message ?? String(resultOrError) });
}

process.on('message', (message) => {
    void (async () => {
        try {
            switch (message?.type) {
                case 'status':
                    return reply(message, true, npcs.map(npcSnapshot));
                case 'reload-settings':
                    return reply(message, true, reloadSettings());
                case 'reload-npc':
                    return reply(message, true, reloadNpc(message.npcId));
                case 'npc-runtime':
                    return reply(message, true, await handleNpcRuntime(message.npcId, message.action));
                case 'npc-control':
                    return reply(message, true, handleNpcControl(message.npcId, message.command));
                case 'npc-prompt':
                    return reply(message, true, await handleNpcPrompt(message.npcId, message.from, message.message));
                case 'shutdown':
                    reply(message, true, { stopping: true });
                    void shutdown('dashboard');
                    return;
                default:
                    throw new Error(`unknown dashboard message '${message?.type}'`);
            }
        } catch (error) {
            reply(message, false, error);
        }
    })();
});

writeRuntimeFile();
process.once('exit', removeRuntimeFile);
process.on('SIGINT', () => { void shutdown('SIGINT'); });
