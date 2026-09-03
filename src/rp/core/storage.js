// Personal storage: each NPC scans chests in a region, keeps a storage_index.json
// on disk, and all chest interactions go through a per-chest mutex so two bots
// never open the same chest concurrently.
import { readFileSync, existsSync } from 'fs';
import { Vec3 } from 'vec3';
import { gotoRegion, gotoNear, sleep } from './movement.js';
import * as mcCompat from '../../utils/mc_compat.js';
import { writeJsonAtomic } from '../../utils/atomic_json.js';

// --- chest mutex (shared across all NPCs in this process) ---
const chestLocks = new Map(); // posKey -> Promise chain
const OPEN_TIMEOUT_MS = 8000;

export async function withChestLock(posKey, fn) {
    const prev = chestLocks.get(posKey) ?? Promise.resolve();
    let release;
    const gate = new Promise(r => { release = r; });
    const tail = prev.then(() => gate);
    chestLocks.set(posKey, tail);
    await prev;
    try {
        return await fn();
    } finally {
        release();
        if (chestLocks.get(posKey) === tail) chestLocks.delete(posKey);
    }
}

const posKey = (p) => `${p.x},${p.y},${p.z}`;

export async function openContainerSafe(bot, chestBlock, timeoutMs = OPEN_TIMEOUT_MS) {
    let timer;
    let timedOut = false;
    const opening = bot.openContainer(chestBlock);
    try {
        return await Promise.race([
            opening,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    reject(new Error(`container open timeout after ${timeoutMs} ms`));
                }, timeoutMs);
            }),
        ]);
    } catch (error) {
        const current = bot.currentWindow;
        if (current && current !== bot.inventory) {
            try { bot.closeWindow(current); } catch { /* already closed */ }
        }
        if (timedOut) {
            void opening.then(async container => {
                try { await container.close(); } catch { /* late window */ }
            }).catch(() => {});
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

export class Storage {
    constructor(npcId, statePath, log) {
        this.npcId = npcId;
        this.path = statePath; // .../state/<id>/storage_index.json
        this.log = log;
        this.index = this.#load();
    }

    #load() {
        if (existsSync(this.path)) {
            try { return JSON.parse(readFileSync(this.path, 'utf8')); }
            catch (e) { this.log.warn(`storage_index corrupt, rebuilding: ${e.message}`); }
        }
        return { chests: {} };
    }

    #save() {
        writeJsonAtomic(this.path, this.index);
    }

    // Find chest blocks within a region.
    findChestsInRegion(bot, region) {
        const chestIds = mcCompat.registryBlockIds(bot, ['chest', 'trapped_chest', 'barrel']);
        const c = region.center;
        return bot.findBlocks({
            point: c, matching: chestIds,
            maxDistance: region.radius + 4, count: 32,
        }).map(p => bot.blockAt(p)).filter(Boolean);
    }

    // Scan all chests in the region and rebuild that part of the index.
    async scanRegion(bot, region, regionName) {
        const chests = this.findChestsInRegion(bot, region);
        this.log.info(`scanning ${chests.length} chest(s) in '${regionName}'`);
        for (const chest of chests) {
            if (bot.entity.position.distanceTo(chest.position) > 4 &&
                !await gotoNear(bot, chest.position, 3, this.log, 10000)) {
                continue;
            }
            try {
                await this.#scanChest(bot, chest, regionName);
            } catch (error) {
                this.log.warn(`scan chest ${chest.position} failed: ${error.message}`);
            }
        }
        this.#save();
    }

    async #scanChest(bot, chestBlock, regionName) {
        const key = posKey(chestBlock.position);
        await withChestLock(key, async () => {
            let win;
            try {
                win = await openContainerSafe(bot, chestBlock);
                const items = this.#countItems(win.containerItems(), bot);
                this.index.chests[key] = {
                    pos: { x: chestBlock.position.x, y: chestBlock.position.y, z: chestBlock.position.z },
                    region: regionName,
                    items,
                };
            } finally {
                if (win) {
                    try { await win.close(); } catch { /* disconnected */ }
                }
            }
        });
        await sleep(300);
    }

    #countItems(itemsList, bot) {
        const items = {};
        for (const it of itemsList) {
            for (const name of new Set(mcCompat.aliasesForLegacyStack(it.name, it.metadata, bot)))
                items[name] = (items[name] ?? 0) + it.count;
        }
        return items;
    }

    // Deposit matching inventory items into a chest. Returns count deposited.
    async deposit(bot, chestBlock, matchFn, regionName) {
        const key = posKey(chestBlock.position);
        let total = 0;
        await withChestLock(key, async () => {
            let win;
            try {
                win = await openContainerSafe(bot, chestBlock);
                for (const it of bot.inventory.items().filter(matchFn)) {
                    try {
                        await win.deposit(it.type, it.metadata, it.count, it.nbt);
                        total += it.count;
                    } catch (e) {
                        this.log.warn(`deposit ${it.name} failed (chest full?): ${e.message}`);
                        break;
                    }
                }
                const items = this.#countItems(win.containerItems(), bot);
                this.index.chests[key] = { pos: this.index.chests[key]?.pos ?? chestBlock.position, region: regionName, items };
            } finally {
                if (win) {
                    try { await win.close(); } catch { /* disconnected */ }
                }
            }
        });
        this.#save();
        return total;
    }

    // Withdraw up to `count` of an item by name from a chest. Returns count withdrawn.
    async withdraw(bot, chestBlock, itemName, count, regionName) {
        const result = await this.withdrawMatching(bot, chestBlock, [itemName], count, regionName);
        return result.count;
    }

    // Open a chest once and withdraw a cumulative amount across interchangeable
    // names. Name order is priority order (bread before less useful food, etc.).
    async withdrawMatching(bot, chestBlock, itemNames, count, regionName) {
        const key = posKey(chestBlock.position);
        let got = 0;
        const itemsTaken = {};
        const names = [...new Set(itemNames ?? [])];
        await withChestLock(key, async () => {
            let win;
            try {
                win = await openContainerSafe(bot, chestBlock);
                const priority = item => names.findIndex(name => mcCompat.stackMatchesName(item, name, bot));
                const have = win.containerItems()
                    .filter(item => priority(item) >= 0)
                    .sort((left, right) => priority(left) - priority(right));
                for (const it of have) {
                    if (got >= count) break;
                    const capacity = inventoryReceiveCapacity(bot, it);
                    if (capacity <= 0) break;
                    const take = Math.min(it.count, count - got, capacity);
                    const matchedName = names[priority(it)] ?? it.name;
                    try {
                        await win.withdraw(it.type, it.metadata, take, it.nbt);
                        got += take;
                        itemsTaken[matchedName] = (itemsTaken[matchedName] ?? 0) + take;
                    } catch (e) {
                        this.log.warn(`withdraw ${matchedName} failed: ${e.message}`);
                        break;
                    }
                }
                const items = this.#countItems(win.containerItems(), bot);
                this.index.chests[key] = { pos: this.index.chests[key]?.pos ?? chestBlock.position, region: regionName, items };
            } finally {
                if (win) {
                    try { await win.close(); } catch { /* disconnected */ }
                }
            }
        });
        this.#save();
        return { count: got, items: itemsTaken };
    }

    // Where (per index) does the NPC have this item? Returns [{posKey, count}], most first.
    // Optional regionFilter: only count chests in that region (e.g. own home —
    // the index also remembers town/delivery chests, which are NOT the NPC's property).
    locate(itemName, regionFilter = null) {
        return Object.entries(this.index.chests)
            .filter(([, c]) => !regionFilter || c.region === regionFilter)
            .map(([k, c]) => ({ posKey: k, pos: c.pos, count: c.items[itemName] ?? 0 }))
            .filter(e => e.count > 0)
            .sort((a, b) => b.count - a.count);
    }

    totalOf(itemName, regionFilter = null) {
        return this.locate(itemName, regionFilter).reduce((s, e) => s + e.count, 0);
    }
}

function sameStackKind(left, right) {
    if (!left || !right || left.type !== right.type || left.metadata !== right.metadata) return false;
    if (!left.nbt && !right.nbt) return true;
    try { return JSON.stringify(left.nbt) === JSON.stringify(right.nbt); } catch { return false; }
}

export function inventoryReceiveCapacity(bot, item) {
    if (!bot?.inventory || !item) return 0;
    const stackSize = Math.max(1, Number(item.stackSize ?? 64));
    const partialSpace = bot.inventory.items()
        .filter(carried => sameStackKind(carried, item))
        .reduce((sum, carried) =>
            sum + Math.max(0, Number(carried.stackSize ?? stackSize) - Number(carried.count ?? 0)), 0);
    const emptySlots = typeof bot.inventory.emptySlotCount === 'function'
        ? Math.max(0, bot.inventory.emptySlotCount())
        : 36;
    return partialSpace + emptySlots * stackSize;
}

// Helper: walk to a region and return its first chest block (or null).
export async function gotoChestInRegion(bot, region, storage, log, preferredPositions = []) {
    const ok = await gotoRegion(bot, region, log);
    if (!ok) return null;
    const chests = [];
    const seen = new Set();
    const add = block => {
        if (!block?.position) return;
        const dx = block.position.x - region.center.x;
        const dz = block.position.z - region.center.z;
        if (Math.hypot(dx, dz) > Number(region.radius ?? 0) + 4) return;
        if (!mcCompat.blockMatchesAnyName(block, ['chest', 'trapped_chest', 'barrel'], bot)) return;
        const key = posKey(block.position);
        if (!seen.has(key)) { seen.add(key); chests.push(block); }
    };
    for (const position of preferredPositions ?? [])
        add(bot.blockAt(new Vec3(position.x, position.y, position.z)));
    for (const block of storage.findChestsInRegion(bot, region)) add(block);
    for (const chest of chests) {
        if (bot.entity.position.distanceTo(chest.position) <= 4 ||
            await gotoNear(bot, chest.position, 3, log, 10000)) {
            return chest;
        }
    }
    return null;
}
