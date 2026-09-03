import {
    existsSync,
    mkdirSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const renameWait = new Int32Array(new SharedArrayBuffer(4));
const RETRYABLE_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'EEXIST', 'EPERM']);

function temporaryPath(file) {
    return `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

export function writeJsonAtomic(file, value, { attempts = 5 } = {}) {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = temporaryPath(file);
    let replaced = false;

    try {
        writeFileSync(temporary, JSON.stringify(value, null, 2));
        for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
            try {
                renameSync(temporary, file);
                replaced = true;
                return;
            } catch (error) {
                const retryable = RETRYABLE_RENAME_ERRORS.has(error.code);
                if (!retryable || attempt >= attempts - 1) throw error;
                Atomics.wait(renameWait, 0, 0, 5 * (attempt + 1));
            }
        }
    } finally {
        if (!replaced && existsSync(temporary)) {
            try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
        }
    }
}
