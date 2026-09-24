// Live mining test: drives a running agent through the MindServer and checks
// whether its inventory actually grows. Needs: Minecraft server + `node main.js` running.
//
//   node tools/mining-live-test.mjs <AgentName> [scenario ...]
//   node tools/mining-live-test.mjs Zan                 -> all scenarios
//   node tools/mining-live-test.mjs Zan stone iron      -> only these
//
// Tip: before each run put the bot somewhere sensible (e.g. /tp Zan ~ 40 ~ in stone,
// give it a stone pickaxe: /give Zan stone_pickaxe). Log is saved to bots/mining-live-<agent>.log
import { io } from 'socket.io-client';
import { appendFileSync, writeFileSync } from 'node:fs';

const AGENT = process.argv[2];
if (!AGENT) { console.error('Usage: node tools/mining-live-test.mjs <AgentName> [scenario ...]'); process.exit(2); }
const PORT = process.env.MINDSERVER_PORT ?? 8080;

const SCENARIOS = {
    stone:       { cmd: '!collectBlocks("stone", 8)',        items: ['cobblestone', 'cobbled_deepslate', 'stone'], min: 4, timeoutS: 240 },
    cobblestone: { cmd: '!collectBlocks("cobblestone", 8)',  items: ['cobblestone', 'cobbled_deepslate'],          min: 4, timeoutS: 240 },
    coal:        { cmd: '!collectBlocks("coal_ore", 3)',     items: ['coal'],                                      min: 1, timeoutS: 300 },
    iron:        { cmd: '!mineOre("iron_ore", 3)',           items: ['raw_iron'],                                  min: 1, timeoutS: 720 },
    coal_mine:   { cmd: '!mineOre("coal_ore", 4)',           items: ['coal'],                                      min: 1, timeoutS: 720 },
};

const LOG = `bots/mining-live-${AGENT}.log`;
writeFileSync(LOG, `# mining live test ${new Date().toISOString()}\n`);
const t0 = Date.now();
const log = (...a) => {
    const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${a.join(' ')}`;
    console.log(line);
    appendFileSync(LOG, line + '\n');
};

const socket = io(`http://localhost:${PORT}`);
let listeners = [];
socket.on('bot-output', (name, message) => {
    if (name !== AGENT) return;
    const text = String(message);
    appendFileSync(LOG, `  <${name}> ${text}\n`);
    for (const l of listeners) l(text);
});

function waitFor(pred, timeoutMs) {
    return new Promise(resolve => {
        const l = text => { if (pred(text)) { done(text); } };
        const timer = setTimeout(() => done(null), timeoutMs);
        function done(v) { clearTimeout(timer); listeners = listeners.filter(x => x !== l); resolve(v); }
        listeners.push(l);
    });
}

const send = cmd => socket.emit('send-message', AGENT, { from: 'ADMIN', message: cmd });

async function inventory() {
    const p = waitFor(t => t.includes('INVENTORY'), 20000);
    send('!inventory');
    const text = await p;
    if (!text) return null;
    const inv = {};
    for (const m of text.matchAll(/^- ([a-z0-9_]+): (\d+)/gm)) inv[m[1]] = Number(m[2]);
    return inv;
}

const count = (inv, names) => names.reduce((s, n) => s + (inv?.[n] ?? 0), 0);

async function run(name, sc) {
    log(`=== ${name}: ${sc.cmd}`);
    const before = await inventory();
    if (!before) { log('  could not read inventory (is the agent running / name correct?)'); return { name, status: 'ERROR' }; }
    const lines = [];
    const collect = t => { lines.push(t); return false; };
    listeners.push(collect);
    const finished = waitFor(t => /Action output|Collected \d+|interrupted|timed out|Agent executed/i.test(t), sc.timeoutS * 1000);
    const started = Date.now();
    send(sc.cmd);
    const end = await finished;
    listeners = listeners.filter(x => x !== collect);
    await new Promise(r => setTimeout(r, 2500)); // let item pickups land
    const after = await inventory();
    const gained = count(after, sc.items) - count(before, sc.items);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    const all = lines.join('\n');
    const hints = [
        [/No .* nearby to collect/i, 'found no candidates (search/filter problem)'],
        [/Don't have right tools/i, 'wrong/missing pickaxe'],
        [/timed out/i, 'collect/path timed out'],
        [/Failed to collect/i, 'collect threw errors'],
        [/jama\/prepad/i, 'stopped at cave/drop'],
        [/zascitene strukture|protected/i, 'blocked by structure protection'],
        [/Picked up 0 items/i, 'broke blocks but did not pick up drops'],
    ].filter(([re]) => re.test(all)).map(([, h]) => h);
    const status = !end ? 'TIMEOUT' : gained >= sc.min ? 'PASS' : 'FAIL';
    log(`  ${status}: gained ${gained} of ${sc.items.join('/')} (need ${sc.min}) in ${secs}s${hints.length ? ' | ' + hints.join('; ') : ''}`);
    if (!end) { send('!stop'); await new Promise(r => setTimeout(r, 3000)); }
    return { name, status, gained, secs, hints };
}

socket.on('connect_error', e => { console.error('Cannot reach MindServer:', e.message); process.exit(1); });
socket.on('connect', async () => {
    socket.emit('listen-to-agents');
    await new Promise(r => setTimeout(r, 800));
    const wanted = process.argv.slice(3);
    const names = wanted.length ? wanted : Object.keys(SCENARIOS);
    const results = [];
    for (const n of names) {
        if (!SCENARIOS[n]) { log(`unknown scenario ${n}; options: ${Object.keys(SCENARIOS).join(', ')}`); continue; }
        results.push(await run(n, SCENARIOS[n]));
    }
    log('=== SUMMARY');
    for (const r of results) log(`  ${r.status.padEnd(7)} ${r.name} ${r.gained ?? ''} ${r.hints?.join('; ') ?? ''}`);
    log(`full log: ${LOG}`);
    process.exit(results.every(r => r.status === 'PASS') ? 0 : 1);
});
