// Diagnostic capture: agent subprocesses are spawned with stdio:'inherit', so their
// console.warn/error and any uncaught exceptions only appear in the launch terminal and
// are lost. This module mirrors that output to a file per bot so it can be inspected
// afterwards. Imported first in init_agent.js. Safe to leave on (append-only, cheap);
// remove the import when no longer needed.
import { appendFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Derive the bot name from argv (init_agent.js is called with -n <name>, name also at argv[2]).
function botName() {
    const a = process.argv.slice(2);
    const i = a.indexOf('-n');
    if (i !== -1 && a[i + 1]) return a[i + 1];
    const j = a.indexOf('--name');
    if (j !== -1 && a[j + 1]) return a[j + 1];
    return a[0] && !a[0].startsWith('-') ? a[0] : 'unknown';
}

const name = botName();
const dir = join(projectRoot, 'bots', name);
try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
const file = join(dir, 'console.log');

function write(level, args) {
    try {
        const line = args.map(a => {
            if (a instanceof Error) return (a.stack || a.message);
            if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
            return String(a);
        }).join(' ');
        appendFileSync(file, `${new Date().toISOString()} [${level}] ${line}\n`);
    } catch { /* never let logging break the bot */ }
}

const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);
console.error = (...args) => { write('ERROR', args); origError(...args); };
console.warn = (...args) => { write('WARN', args); origWarn(...args); };

// Observe fatal errors without replacing Node's default handler. Registering an
// `uncaughtException`/`unhandledRejection` handler here used to keep a corrupted
// agent process alive after logging the crash.
process.on('uncaughtExceptionMonitor', (err, origin) => write('UNCAUGHT', [origin, err]));

write('INFO', [`crashlog started for ${name} (pid ${process.pid})`]);
