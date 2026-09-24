#!/usr/bin/env node
// Summarize existing kingdom decision traces. This does not claim goal completion:
// the current trace records action outcomes, not end-to-end verified goals.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultBotsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bots');
const RESULT_KINDS = ['ok', 'fail', 'failed', 'blocked', 'waiting', 'interrupted', 'progress', 'done'];

function readJson(file) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function readTrace(file) {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split(/\r?\n/)
        .filter(Boolean)
        .flatMap(line => {
            try { return [JSON.parse(line)]; } catch { return []; }
        });
}

export function summarizeTrace(lines) {
    const counts = Object.fromEntries(RESULT_KINDS.map(kind => [kind, 0]));
    const failures = new Map();
    const streaks = new Map();
    let selected = 0;
    let blockedSelections = 0;
    let maxFailureStreak = { action: null, count: 0 };
    let firstAt = null;
    let lastAt = null;

    for (const line of lines) {
        if (!line || typeof line !== 'object') continue;
        if (line.t && (!firstAt || line.t < firstAt)) firstAt = line.t;
        if (line.t && (!lastAt || line.t > lastAt)) lastAt = line.t;
        const action = String(line.action ?? 'unknown');
        if (line.blocked === true) {
            blockedSelections++;
            continue;
        }
        selected++;
        const result = String(line.result ?? 'unknown');
        counts[result] = (counts[result] ?? 0) + 1;
        if (result === 'fail' || result === 'failed' || result === 'blocked') {
            failures.set(action, (failures.get(action) ?? 0) + 1);
            const streak = (streaks.get(action) ?? 0) + 1;
            streaks.set(action, streak);
            if (streak > maxFailureStreak.count)
                maxFailureStreak = { action, count: streak };
        } else if (RESULT_KINDS.includes(result)) {
            streaks.set(action, 0);
        }
    }

    return {
        traceLines: lines.length,
        selectedActions: selected,
        blockedSelections,
        actionOutcomes: counts,
        maxFailureStreak,
        topFailingActions: [...failures.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 5)
            .map(([action, count]) => ({ action, count })),
        firstAt,
        lastAt,
    };
}

export function evaluateKingdom(botsDir = defaultBotsDir) {
    const bots = {};
    if (!existsSync(botsDir)) return { botsDir, bots, note: 'No runtime traces found.' };
    for (const entry of readdirSync(botsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const folder = path.join(botsDir, entry.name);
        const current = path.join(folder, 'trace.ndjson');
        const backup = `${current}.1`;
        if (!existsSync(current) && !existsSync(backup)) continue;
        const snapshot = readJson(path.join(folder, 'debug-state.json'));
        bots[entry.name] = {
            ...summarizeTrace([...readTrace(backup), ...readTrace(current)]),
            snapshotAt: snapshot?.t ?? null,
            home: snapshot?.planning?.local?.home ?? snapshot?.planning?.society?.home ?? null,
            localPlanner: snapshot?.planning?.local?.status ?? null,
            societyPlanner: snapshot?.planning?.society?.status ?? null,
            currentFocus: snapshot?.plan?.focus ?? null,
        };
    }
    return {
        botsDir,
        bots,
        note: 'Action outcomes only. Goal completion, survival and admin interventions require in-game evidence.',
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const folder = process.argv.find((arg, index) => index > 1 && arg !== '--json') ?? defaultBotsDir;
    const report = evaluateKingdom(path.resolve(folder));
    if (process.argv.includes('--json')) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(`Kingdom trace summary: ${report.botsDir}`);
        for (const [name, bot] of Object.entries(report.bots)) {
            const c = bot.actionOutcomes;
            console.log(`${name}: actions=${bot.selectedActions}, ok=${c.ok + c.done + c.progress}, fail=${c.fail + c.failed}, `
                + `blocked=${c.blocked}, interrupted=${c.interrupted}, planner=${bot.localPlanner ?? '-'}, `
                + `home=${bot.home ?? '-'}, worst=${bot.maxFailureStreak.action ?? '-'}:${bot.maxFailureStreak.count}`);
        }
        if (Object.keys(report.bots).length === 0) console.log('No runtime traces found.');
        console.log(report.note);
    }
}
