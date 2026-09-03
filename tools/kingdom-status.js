#!/usr/bin/env node
// ============================================================================
// kingdom-status.js — read-only viewer for the kingdom debug telemetry ("Sloj A")
// ============================================================================
//
// Reads the per-bot Agent State snapshots written by src/agent/roleplay/telemetry.js
// (bots/<name>/debug-state.json) and prints a one-screen overview of the live kingdom.
// Standalone + dependency-free: it only reads files, never touches the running bots, so
// it is safe to run while the kingdom is up.
//
// USAGE (from the mindcraft/ root, while summon_kingdom.bat is running):
//   node tools/kingdom-status.js                 # one-shot overview table of all bots
//   node tools/kingdom-status.js --watch         # refresh the table every 3s
//   node tools/kingdom-status.js --watch 5       # refresh every 5s
//   node tools/kingdom-status.js Blaz            # full snapshot + recent trace for one bot
//   node tools/kingdom-status.js Blaz --trace 30 # ... with the last 30 trace lines
//
// Requires settings.telemetry.enabled = true (default) so the snapshots exist.
// ----------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOTS_DIR = path.resolve(__dirname, '..', 'bots');

function readJson(file) {
    try { return JSON.parse(readFileSync(file, 'utf8')); }
    catch { return null; }
}

// Every bots/<name>/ dir that has a debug-state.json snapshot.
function listBots() {
    if (!existsSync(BOTS_DIR)) return [];
    return readdirSync(BOTS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => existsSync(path.join(BOTS_DIR, name, 'debug-state.json')))
        .sort();
}

const pad = (value, width) => String(value ?? '').padEnd(width).slice(0, width);
const padStart = (value, width) => String(value ?? '').padStart(width).slice(0, width);

function ageSeconds(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.round((Date.now() - t) / 1000));
}

function planLabel(plan) {
    if (!plan) return '-';
    const focus = plan.focus ?? '?';
    const detail = plan.resource ?? plan.schematic ?? plan.project ?? null;
    return detail ? `${focus}/${detail}` : focus;
}

function progressLabel(awareness) {
    if (!awareness || awareness.planTargetRatio == null) return '-';
    return `${Math.round(awareness.planTargetRatio * 100)}%`;
}

function frustrationLabel(awareness) {
    if (!awareness || awareness.frustration == null) return '-';
    return awareness.frustration.toFixed(2);
}

function navigationLabel(navigation) {
    if (!navigation) return '-';
    if (navigation.status === 'navigating') return `moving#${navigation.attempt ?? 1}`;
    const endedAt = Date.parse(navigation.endedAt ?? '');
    return Number.isFinite(endedAt) && Date.now() - endedAt < 15_000
        ? navigation.status ?? '-'
        : '-';
}

function flagsLine(snap) {
    const f = snap.flags ?? {};
    const on = Object.entries(f).filter(([, v]) => v).map(([k]) => k);
    return on.length ? on.join('+') : '(none)';
}

function printOverview() {
    const bots = listBots();
    if (bots.length === 0) {
        console.log(`No debug-state.json snapshots in ${BOTS_DIR}.`);
        console.log('Is the kingdom running with settings.telemetry.enabled = true?');
        return;
    }

    const header = [
        pad('BOT', 8), pad('AGE', 5), pad('STAGE', 13), pad('ACTION', 18),
        pad('NAV', 9), pad('INTENT', 10), padStart('FRUS', 5), padStart('PLAN', 6),
        pad('PLAN FOCUS', 16), padStart('HP', 4), padStart('FOOD', 5),
        padStart('REL', 4), pad('PLAYERS', 14),
    ].join(' ');
    console.log(header);
    console.log('-'.repeat(header.length));

    let need = null;
    for (const name of bots) {
        const snap = readJson(path.join(BOTS_DIR, name, 'debug-state.json'));
        if (!snap) { console.log(pad(name, 8) + ' (unreadable snapshot)'); continue; }
        need ??= snap.society?.resourceNeed ?? null;
        const age = ageSeconds(snap.t);
        const ageStr = age == null ? '?' : (age > 60 ? `${Math.round(age / 60)}m` : `${age}s`);
        const self = snap.self ?? {};
        console.log([
            pad(name, 8),
            pad(ageStr, 5),
            pad(self.stage ?? '-', 13),
            pad(self.currentAction ?? '-', 18),
            pad(navigationLabel(self.navigation), 9),
            pad(snap.intention?.topic ?? '-', 10),
            padStart(frustrationLabel(snap.awareness), 5),
            padStart(progressLabel(snap.awareness), 6),
            pad(planLabel(snap.plan), 16),
            padStart(self.health == null ? '-' : Math.round(self.health), 4),
            padStart(self.food == null ? '-' : Math.round(self.food), 5),
            padStart(snap.relations?.length ?? 0, 4),
            pad((snap.nearbyPlayers ?? []).join(',') || '-', 14),
        ].join(' '));
    }

    if (need) console.log(`\nSettlement resource need: ${need.resource} (ratio ${Number(need.ratio).toFixed(2)})`);
    console.log(`Bots with snapshots: ${bots.length}   ·   flags: ${flagsLine(readJson(path.join(BOTS_DIR, bots[0], 'debug-state.json')) ?? {})}`);
    console.log(`(${new Date().toLocaleTimeString()})`);
}

function tailLines(file, count) {
    if (!existsSync(file)) return [];
    try {
        return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-count);
    } catch { return []; }
}

function printBotDetail(name, traceCount) {
    const dir = path.join(BOTS_DIR, name);
    const snap = readJson(path.join(dir, 'debug-state.json'));
    if (!snap) {
        console.log(`No snapshot for "${name}". Known bots: ${listBots().join(', ') || '(none)'}`);
        return;
    }
    const age = ageSeconds(snap.t);
    console.log(`=== ${name} === (snapshot ${age == null ? '?' : age + 's'} old, flags: ${flagsLine(snap)})\n`);
    console.log(JSON.stringify(snap, null, 2));

    const trace = tailLines(path.join(dir, 'trace.ndjson'), traceCount);
    console.log(`\n--- last ${trace.length} trace lines (trace.ndjson) ---`);
    for (const raw of trace) {
        const line = (() => { try { return JSON.parse(raw); } catch { return null; } })();
        if (!line) { console.log(raw); continue; }
        const time = (line.t ?? '').slice(11, 19);
        const status = line.blocked ? 'BLOCKED' : (line.result ?? '?');
        const cooling = line.cooling?.length ? ` cooling:[${line.cooling.join(',')}]` : '';
        const flags = line.flags
            ? [line.flags.stuck && 'stuck', line.flags.stalled && 'stalled', line.flags.idle && 'idle']
                .filter(Boolean).join(',')
            : '';
        console.log(`${time}  ${pad(line.action ?? '-', 18)} ${pad(status, 11)} `
            + `topic=${pad(line.topic ?? '-', 9)} focus=${pad(line.focus ?? '-', 10)} `
            + `frus=${line.frustration ?? '-'}${flags ? ' [' + flags + ']' : ''}${cooling}`);
    }
}

// ── arg parsing ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const watchIdx = argv.indexOf('--watch');
const traceIdx = argv.indexOf('--trace');
const traceCount = traceIdx >= 0 ? Math.max(1, Number(argv[traceIdx + 1]) || 20) : 20;
// A positional arg is the bot name — but skip the numeric value that follows --trace/--watch.
const consumedValueIdx = new Set();
if (traceIdx >= 0) consumedValueIdx.add(traceIdx + 1);
if (watchIdx >= 0) consumedValueIdx.add(watchIdx + 1);
const botName = argv.find((arg, i) => !arg.startsWith('--') && !consumedValueIdx.has(i));

if (botName) {
    printBotDetail(botName, traceCount);
} else if (watchIdx >= 0) {
    const seconds = Math.max(1, Number(argv[watchIdx + 1]) || 3);
    const refresh = () => { console.clear(); printOverview(); console.log(`\n(watching, every ${seconds}s — Ctrl+C to stop)`); };
    refresh();
    setInterval(refresh, seconds * 1000);
} else {
    printOverview();
}
