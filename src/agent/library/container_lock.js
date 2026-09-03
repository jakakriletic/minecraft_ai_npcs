import { mkdir, open, readFile, stat, unlink, utimes } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const LOCK_DIR = './bots/.container-locks';
const STALE_MS = 30000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function lockFile(bot, block) {
    const dimension = String(bot.game?.dimension ?? 'world').replace(/[^a-z0-9_-]/gi, '_');
    const { x, y, z } = block.position;
    return `${LOCK_DIR}/${dimension}_${x}_${y}_${z}.lock`;
}

function namedLockFile(name) {
    const safeName = String(name).replace(/[^a-z0-9_-]/gi, '_');
    return `${LOCK_DIR}/global_named_${safeName}.lock`;
}

async function acquireFile(bot, file, waitMs, { interruptible = true } = {}) {
    await mkdir(LOCK_DIR, { recursive: true });
    const deadline = Date.now() + waitMs;

    while (Date.now() < deadline && (!interruptible || !bot.interrupt_code)) {
        try {
            const token = `${bot.username}:${randomUUID()}`;
            const handle = await open(file, 'wx');
            await handle.writeFile(token);
            await handle.close();
            const heartbeat = setInterval(() => {
                void readFile(file, 'utf8').then(owner => {
                    if (owner !== token) return;
                    const now = new Date();
                    return utimes(file, now, now);
                }).catch(() => {});
            }, 10000);
            heartbeat.unref?.();
            return async () => {
                clearInterval(heartbeat);
                try {
                    if (await readFile(file, 'utf8') === token)
                        await unlink(file);
                } catch { /* already released or ownership changed */ }
            };
        } catch (error) {
            const retryable = ['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code);
            if (!retryable) throw error;
            if (error.code === 'EEXIST') {
                try {
                    const info = await stat(file);
                    if (Date.now() - info.mtimeMs > STALE_MS) {
                        await unlink(file);
                        continue;
                    }
                } catch { /* lock disappeared between checks */ }
            }
            await sleep(100 + Math.floor(Math.random() * 150));
        }
    }
    return null;
}

async function acquire(bot, block, waitMs) {
    return await acquireFile(bot, lockFile(bot, block), waitMs);
}

export async function acquireContainerLock(bot, block, waitMs = 5000) {
    return await acquire(bot, block, waitMs);
}

export async function withContainerLock(bot, block, callback, waitMs = 5000) {
    const release = await acquireContainerLock(bot, block, waitMs);
    if (!release) return { locked: false, value: null };
    try {
        return { locked: true, value: await callback() };
    } finally {
        await release();
    }
}

export async function withNamedLock(bot, name, callback, waitMs = 15000, options = {}) {
    const release = await acquireFile(bot, namedLockFile(name), waitMs, options);
    if (!release) return { locked: false, value: null };
    try {
        return { locked: true, value: await callback() };
    } finally {
        await release();
    }
}
