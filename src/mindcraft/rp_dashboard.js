import express from 'express';
import { fork } from 'child_process';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeJsonAtomic } from '../utils/atomic_json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const rpScript = path.join(rootDir, 'rp.js');
const rpConfigRoot = path.join(rootDir, 'src', 'rp', 'config');
const rpStateRoot = path.join(rootDir, 'src', 'rp', 'state');
const botsRoot = path.join(rootDir, 'bots');
const rpRuntimeFile = path.join(rpStateRoot, 'rp-runtime.json');

let rpChild = null;
let nextMessageId = 1;
const pendingMessages = new Map();

function readJson(filePath, fallback = null) {
    try {
        if (!existsSync(filePath)) return fallback;
        return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (error) {
        return { error: error.message, path: filePath };
    }
}

function writeJson(filePath, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('JSON body must be an object');
    writeJsonAtomic(filePath, data);
}

function safeNpcId(value) {
    const id = String(value ?? '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
        throw new Error('Invalid NPC id');
    return id;
}

function isRunning(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return false;
    try {
        process.kill(n, 0);
        return true;
    } catch {
        return false;
    }
}

function getRuntimeStatus() {
    const runtime = readJson(rpRuntimeFile, null);
    const externalPid = Number(runtime?.pid);
    const childRunning = Boolean(rpChild && !rpChild.killed && isRunning(rpChild.pid));
    const externalRunning = Boolean(runtime && isRunning(externalPid));
    return {
        running: childRunning || externalRunning,
        controllable: childRunning,
        pid: childRunning ? rpChild.pid : (externalRunning ? externalPid : null),
        startedAt: childRunning ? null : (runtime?.startedAt ?? null),
        runtime,
    };
}

function onRpMessage(message) {
    const id = message?.id;
    if (!id || !pendingMessages.has(id)) return;
    const pending = pendingMessages.get(id);
    pendingMessages.delete(id);
    clearTimeout(pending.timer);
    if (message.ok === false) pending.reject(new Error(message.error ?? 'RP command failed'));
    else pending.resolve(message.result ?? null);
}

function startRpProcess() {
    if (rpChild && !rpChild.killed && isRunning(rpChild.pid)) return getRuntimeStatus();
    const current = getRuntimeStatus();
    if (current.running) return current;

    rpChild = fork(rpScript, [], {
        cwd: rootDir,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    rpChild.on('message', onRpMessage);
    rpChild.on('exit', () => {
        for (const pending of pendingMessages.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('RP process exited'));
        }
        pendingMessages.clear();
        rpChild = null;
    });
    return getRuntimeStatus();
}

function sendRpMessage(type, payload = {}, timeoutMs = 8000) {
    if (!rpChild || rpChild.killed || !isRunning(rpChild.pid) || !rpChild.connected) {
        return Promise.reject(new Error('RP process is not controllable from this dashboard'));
    }
    const id = nextMessageId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingMessages.delete(id);
            reject(new Error('RP process did not answer in time'));
        }, timeoutMs);
        pendingMessages.set(id, { resolve, reject, timer });
        rpChild.send({ id, type, ...payload }, error => {
            if (!error) return;
            clearTimeout(timer);
            pendingMessages.delete(id);
            reject(error);
        });
    });
}

function waitForChildExit(child, timeoutMs) {
    if (!child || !isRunning(child.pid)) return Promise.resolve(true);
    return new Promise(resolve => {
        let settled = false;
        const finish = exited => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.off('exit', onExit);
            resolve(exited);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(!isRunning(child.pid)), timeoutMs);
        child.once('exit', onExit);
    });
}

async function waitForPidExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isRunning(pid)) return true;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return !isRunning(pid);
}

async function stopRpProcess() {
    if (rpChild && !rpChild.killed && isRunning(rpChild.pid)) {
        const child = rpChild;
        try {
            await sendRpMessage('shutdown', {}, 2000);
        } catch {
            try { child.kill('SIGTERM'); } catch { /* already gone */ }
        }
        if (!await waitForChildExit(child, 35_000)) {
            try { child.kill('SIGTERM'); } catch { /* already gone */ }
            await waitForChildExit(child, 5000);
        }
        return getRuntimeStatus();
    }

    const runtime = readJson(rpRuntimeFile, null);
    if (runtime?.pid && isRunning(runtime.pid)) {
        const pid = Number(runtime.pid);
        try { process.kill(pid, 'SIGINT'); } catch { /* already gone */ }
        if (!await waitForPidExit(pid, 35_000)) {
            try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
            await waitForPidExit(pid, 5000);
        }
    } else if (runtime) {
        try { unlinkSync(rpRuntimeFile); } catch { /* already gone */ }
    }
    return getRuntimeStatus();
}

function npcIds(settings) {
    const configured = Array.isArray(settings?.npcs) ? settings.npcs : [];
    return [...new Set(configured.map(String).filter(Boolean))];
}

function summarizeStorage(storage) {
    const totals = {};
    for (const chest of Object.values(storage?.chests ?? {})) {
        for (const [item, count] of Object.entries(chest.items ?? {})) {
            totals[item] = (totals[item] ?? 0) + Number(count || 0);
        }
    }
    return {
        chestCount: Object.keys(storage?.chests ?? {}).length,
        totals,
    };
}

function readNpc(id) {
    id = safeNpcId(id);
    const cfgPath = path.join(rpConfigRoot, 'npcs', `${id}.json`);
    const stateDir = path.join(rpStateRoot, id);
    const config = readJson(cfgPath, {});
    const state = readJson(path.join(stateDir, 'state.json'), config.zacetno_stanje ?? {});
    const storage = readJson(path.join(stateDir, 'storage_index.json'), { chests: {} });
    const eventLog = readJson(path.join(stateDir, 'event_log.json'), []);
    const prices = readJson(path.join(stateDir, 'price_beliefs.json'), null);
    return {
        id,
        config,
        state,
        storage,
        storageSummary: summarizeStorage(storage),
        eventLog: Array.isArray(eventLog) ? eventLog.slice(-40) : eventLog,
        prices,
    };
}

function readRpDashboardData() {
    const settings = readJson(path.join(rpConfigRoot, 'settings.json'), {});
    const ids = npcIds(settings);
    return {
        runtime: getRuntimeStatus(),
        settings,
        locations: readJson(path.join(rpConfigRoot, 'locations.json'), {}),
        economy: readJson(path.join(rpConfigRoot, 'economy.json'), {}),
        civic: readJson(path.join(rpStateRoot, 'town_mind.json'), {}),
        llmUsage: readJson(path.join(rpStateRoot, 'llm_usage.json'), {}),
        npcs: ids.map(readNpc),
    };
}

function readKingdomData() {
    return {
        runtime: readJson(path.join(botsRoot, 'kingdom-runtime.json'), null),
        society: readJson(path.join(botsRoot, 'kingdom.json'), null),
        publicStorage: readJson(path.join(botsRoot, 'public-storage.json'), null),
        plan: readJson(path.join(botsRoot, 'kingdom-plan.json'), null),
        roads: readJson(path.join(botsRoot, 'kingdom-roads.json'), null),
        socialGraph: readJson(path.join(botsRoot, 'rp-social-graph.json'), null),
    };
}

function updateAccessLists(body) {
    const settingsPath = path.join(rpConfigRoot, 'settings.json');
    const settings = readJson(settingsPath, {});
    if (Array.isArray(body.admin_players)) {
        settings.admin_players = body.admin_players.map(String).map(s => s.trim()).filter(Boolean);
    }
    if (Array.isArray(body.blacklisted_players)) {
        settings.blacklisted_players = body.blacklisted_players.map(String).map(s => s.trim()).filter(Boolean);
    }
    writeJson(settingsPath, settings);
    void sendRpMessage('reload-settings').catch(() => {});
    return settings;
}

function appendNpcMemory(id, body) {
    id = safeNpcId(id);
    const statePath = path.join(rpStateRoot, id, 'state.json');
    const state = readJson(statePath, {});
    const who = String(body.who || 'Dashboard').trim() || 'Dashboard';
    const text = String(body.text || '').trim();
    if (!text) throw new Error('Memory text is required');
    state.spomini_pogovorov ??= {};
    state.spomini_pogovorov[who] ??= [];
    state.spomini_pogovorov[who].push({
        ts: new Date().toISOString(),
        povzetek: text.slice(0, 300),
    });
    state.spomini_pogovorov[who] = state.spomini_pogovorov[who].slice(-12);
    writeJson(statePath, state);
    void sendRpMessage('reload-npc', { npcId: id }).catch(() => {});
    return state;
}

function asyncRoute(fn) {
    return (req, res) => {
        Promise.resolve(fn(req, res)).catch(error => {
            res.status(400).json({ ok: false, error: error.message });
        });
    };
}

export function attachRpDashboardApi(app) {
    app.use(express.json({ limit: '4mb' }));

    app.get('/api/dashboard', (req, res) => {
        res.json({
            ok: true,
            rp: readRpDashboardData(),
            kingdom: readKingdomData(),
        });
    });

    app.get('/api/rp', (req, res) => res.json({ ok: true, rp: readRpDashboardData() }));
    app.get('/api/rp/status', (req, res) => res.json({ ok: true, status: getRuntimeStatus() }));

    app.post('/api/rp/runtime/:action', asyncRoute(async (req, res) => {
        const action = req.params.action;
        if (action === 'start') startRpProcess();
        else if (action === 'stop') await stopRpProcess();
        else if (action === 'restart') {
            await stopRpProcess();
            startRpProcess();
        } else {
            throw new Error(`Unknown runtime action '${action}'`);
        }
        res.json({ ok: true, status: getRuntimeStatus() });
    }));

    app.put('/api/rp/settings', asyncRoute(async (req, res) => {
        const settingsPath = path.join(rpConfigRoot, 'settings.json');
        writeJson(settingsPath, req.body);
        await sendRpMessage('reload-settings').catch(() => null);
        res.json({ ok: true, settings: req.body });
    }));

    app.post('/api/rp/access', asyncRoute((req, res) => {
        res.json({ ok: true, settings: updateAccessLists(req.body) });
    }));

    app.put('/api/rp/npcs/:id/config', asyncRoute(async (req, res) => {
        const id = safeNpcId(req.params.id);
        writeJson(path.join(rpConfigRoot, 'npcs', `${id}.json`), req.body);
        await sendRpMessage('reload-npc', { npcId: id }).catch(() => null);
        res.json({ ok: true, npc: readNpc(id) });
    }));

    app.put('/api/rp/npcs/:id/state', asyncRoute(async (req, res) => {
        const id = safeNpcId(req.params.id);
        writeJson(path.join(rpStateRoot, id, 'state.json'), req.body);
        await sendRpMessage('reload-npc', { npcId: id }).catch(() => null);
        res.json({ ok: true, npc: readNpc(id) });
    }));

    app.post('/api/rp/npcs/:id/memory', asyncRoute((req, res) => {
        const state = appendNpcMemory(req.params.id, req.body);
        res.json({ ok: true, state });
    }));

    app.post('/api/rp/npcs/:id/runtime/:action', asyncRoute(async (req, res) => {
        const npcId = safeNpcId(req.params.id);
        const result = await sendRpMessage('npc-runtime', {
            npcId,
            action: req.params.action,
        }, 10000);
        res.json({ ok: true, result });
    }));

    app.post('/api/rp/npcs/:id/control', asyncRoute(async (req, res) => {
        const npcId = safeNpcId(req.params.id);
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
            throw new Error('Control body must be an object');
        const result = await sendRpMessage('npc-control', {
            npcId,
            command: req.body,
        }, 10000);
        res.json({ ok: true, result });
    }));

    app.post('/api/rp/npcs/:id/prompt', asyncRoute(async (req, res) => {
        const npcId = safeNpcId(req.params.id);
        const message = String(req.body.message || '').trim();
        if (!message) throw new Error('Prompt message is required');
        const result = await sendRpMessage('npc-prompt', {
            npcId,
            from: String(req.body.from || 'Dashboard'),
            message,
        }, 90000);
        res.json({ ok: true, result });
    }));
}
