// Editable roleplay scenario layer. The server owner writes mindcraft/roleplay.md
// and it is injected into every chat prompt. The file is re-read live (mtime
// checked at most every few seconds), so edits apply without restarting bots.
//
// File format:
//   - HTML comments <!-- ... --> are stripped (editing instructions live there).
//   - Everything above the first "## <BotName>" heading applies to ALL bots.
//   - A "## <BotName>" section is appended only for that bot (case-insensitive).
//   - Missing or empty file = scenario layer off.
import { readFileSync, statSync } from 'fs';

const SCENARIO_FILE = './roleplay.md';
const TTL_MS = 3000;
const cache = { checkedAt: 0, mtimeMs: -1, global: '', sections: new Map() };

function refresh() {
    const now = Date.now();
    if (now - cache.checkedAt < TTL_MS) return;
    cache.checkedAt = now;
    let mtimeMs = null;
    try { mtimeMs = statSync(SCENARIO_FILE).mtimeMs; } catch { /* no scenario file */ }
    if (mtimeMs === cache.mtimeMs) return;
    cache.mtimeMs = mtimeMs;
    cache.global = '';
    cache.sections = new Map();
    if (mtimeMs === null) return;
    let raw = '';
    try { raw = readFileSync(SCENARIO_FILE, 'utf8'); } catch { return; }
    raw = raw.replace(new RegExp('^\\uFEFF'), '').replace(/<!--[\s\S]*?-->/g, '');
    let current = null; // null -> global part
    const globalLines = [];
    for (const line of raw.split(/\r?\n/)) {
        const heading = line.match(/^##\s+(\S+)\s*$/);
        if (heading) {
            current = heading[1].toLowerCase();
            if (!cache.sections.has(current)) cache.sections.set(current, []);
            continue;
        }
        if (current) cache.sections.get(current).push(line);
        else globalLines.push(line);
    }
    cache.global = globalLines.join('\n').trim();
    for (const [name, lines] of cache.sections) {
        const text = lines.join('\n').trim();
        if (text) cache.sections.set(name, text);
        else cache.sections.delete(name);
    }
}

export function scenarioContext(botName) {
    refresh();
    const personal = cache.sections.get(String(botName ?? '').toLowerCase());
    if (!cache.global && !personal) return '';
    return [
        'ROLEPLAY SCENARIO (set by the server owner in roleplay.md; it defines your role and overrides generic style guidance):',
        cache.global,
        personal ? `Your personal scenario notes:\n${personal}` : '',
    ].filter(Boolean).join('\n');
}

export function scenarioSummary() {
    refresh();
    if (!cache.global && cache.sections.size === 0) return '';
    const title = cache.global.split('\n').find(line => line.trim());
    return (title ?? 'active').replace(/^#+\s*/, '').trim().slice(0, 80) || 'active';
}
