// Shared public storage for all Mindcraft agents. The location is global, while
// container access is serialized across bot processes through filesystem locks.
import { readFileSync, unlinkSync } from 'fs';
import { Vec3 } from 'vec3';
import * as world from './world.js';
import { craftRecipe, goToPosition, log, placeBlock } from './skills.js';
import { withContainerLock, withNamedLock } from './container_lock.js';
import * as mc from '../../utils/mcdata.js';
import { writeJsonAtomic } from '../../utils/atomic_json.js';
import {
    inspectContainerIndex,
    orderContainersFromIndex,
} from './container_index.js';

const STORAGE_FILE = './bots/public-storage.json';
const DEFAULT_RADIUS = 10;
const TARGET_CONTAINERS = 5;
const MAX_CONTAINERS = 12;
const ACCESS_LOCK = 'public-storage-access';
const ACCESS_WAIT_MS = 600;
const CONTAINER_WAIT_MS = 2000;
const OPEN_TIMEOUT_MS = 6000;
const EMPTY = new Set([
    'air', 'cave_air', 'void_air', 'short_grass', 'tallgrass', 'tall_grass',
    'fern', 'large_fern', 'snow', 'dead_bush',
]);
const UNSAFE_FLOOR = new Set(['air', 'cave_air', 'void_air', 'water', 'lava']);
const CATEGORY_ORDER = ['food', 'resources', 'building', 'equipment', 'misc'];

function dimensionKey(bot) {
    return String(bot.game?.dimension ?? 'world');
}

function saveStorage(storage) {
    writeJsonAtomic(STORAGE_FILE, storage);
}

export function getPublicStorage(bot) {
    try {
        const storage = JSON.parse(readFileSync(STORAGE_FILE, 'utf8'));
        if (storage.dimension !== dimensionKey(bot)) return null;
        return storage;
    } catch {
        return null;
    }
}

// Undo !storage: forget the shared hub (global file, so it applies to every bot
// process at once). The chests stay in the world — bots just stop treating them
// as the town hub and fall back to home/personal-camp storage.
export function clearPublicStorage() {
    try { unlinkSync(STORAGE_FILE); } catch { /* none configured */ }
}

export function getPublicStorageAnchor(bot) {
    const storage = getPublicStorage(bot);
    if (!storage) return null;
    if (Array.isArray(storage.containers) && storage.containers.length > 0)
        return storage;
    const snapped = snapStoragePosition(bot, storagePoint(storage));
    if (Math.abs(snapped.y - storage.y) <= 2)
        return storage;
    const updated = {
        ...storage,
        x: snapped.x,
        y: snapped.y,
        z: snapped.z,
        updatedAt: new Date().toISOString(),
    };
    saveStorage(updated);
    return updated;
}

function storagePoint(storage) {
    return new Vec3(storage.x, storage.y, storage.z);
}

function storageFloorLoadedAndSafe(floor) {
    return floor
        && !UNSAFE_FLOOR.has(floor.name)
        && !EMPTY.has(floor.name)
        && Array.isArray(floor.shapes)
        && floor.shapes.length > 0;
}

function snapStoragePosition(bot, position, search = 64) {
    const x = Math.floor(position.x);
    const z = Math.floor(position.z);
    const originY = Math.floor(position.y);
    const minY = bot.game?.minY ?? -64;
    const maxY = minY + (bot.game?.height ?? 384) - 2;
    const candidates = [];
    for (let offset = 0; offset <= search; offset++) {
        candidates.push(originY - offset);
        if (offset > 0) candidates.push(originY + offset);
    }
    for (const rawY of candidates) {
        const y = Math.max(minY + 1, Math.min(maxY, rawY));
        const feet = bot.blockAt(new Vec3(x, y, z), false);
        const head = bot.blockAt(new Vec3(x, y + 1, z), false);
        const floor = bot.blockAt(new Vec3(x, y - 1, z), false);
        if (!feet || !head || !floor) continue;
        if (!EMPTY.has(feet.name) || !EMPTY.has(head.name)) continue;
        if (!storageFloorLoadedAndSafe(floor)) continue;
        return new Vec3(x, y, z);
    }
    return new Vec3(x, originY, z);
}

function storageAreaLoaded(bot, storage) {
    if (!bot.entity || !storage) return false;
    if (bot.entity.position.distanceTo(storagePoint(storage)) > 96) return false;
    return bot.blockAt(storagePoint(storage), false) !== null;
}

function nearestFirst(bot, blocks) {
    const origin = bot.entity?.position;
    if (!origin) return [...blocks];
    return [...blocks].sort((a, b) =>
        origin.distanceSquared(a.position) - origin.distanceSquared(b.position));
}

function withinStorage(storage, position) {
    return Math.abs(position.y - storage.y) <= 6
        && Math.hypot(position.x - storage.x, position.z - storage.z) <= storage.radius + 2;
}

function blockIds(bot, names) {
    return mc.registryBlockIds(bot, names);
}

function containerKey(position) {
    return `${position.x},${position.y},${position.z}`;
}

function registeredContainerPositions(storage) {
    return Array.isArray(storage?.containers)
        ? storage.containers.filter(position =>
            [position?.x, position?.y, position?.z].every(Number.isFinite))
        : [];
}

function publicIndexQuery(bot, storage, predicate, score = null) {
    return inspectContainerIndex(
        bot,
        registeredContainerPositions(storage),
        predicate,
        { score },
    );
}

function publicIndexKnowsMissing(bot, storage, predicate) {
    const query = publicIndexQuery(bot, storage, predicate);
    return query.complete && query.matches.length === 0;
}

function scanPublicContainers(bot, storage) {
    if (!storage) return [];
    const ids = blockIds(bot, ['chest', 'trapped_chest', 'barrel']);
    if (ids.length === 0) return [];
    return bot.findBlocks({
        point: storagePoint(storage),
        matching: ids,
        maxDistance: storage.radius + 4,
        count: 48,
    })
        .filter(position => withinStorage(storage, position))
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .sort((a, b) => a.position.x - b.position.x
            || a.position.z - b.position.z
            || a.position.y - b.position.y);
}

export function findPublicContainers(bot, storage = getPublicStorage(bot)) {
    if (!storage) return [];
    if (!Array.isArray(storage.containers))
        return scanPublicContainers(bot, storage);

    const containerNames = new Set(['chest', 'trapped_chest', 'barrel']);
    return storage.containers
        .map(position => bot.blockAt(new Vec3(position.x, position.y, position.z)))
        .filter(block => block && containerNames.has(block.name))
        .sort((a, b) => a.position.x - b.position.x
            || a.position.z - b.position.z
            || a.position.y - b.position.y);
}

function ensureContainerRegistry(bot, storage) {
    const hadRegistry = Array.isArray(storage.containers);
    const candidates = hadRegistry
        ? storage.containers
        : scanPublicContainers(bot, storage)
            .sort((a, b) =>
                a.position.distanceSquared(storagePoint(storage))
                - b.position.distanceSquared(storagePoint(storage)))
            .slice(0, TARGET_CONTAINERS)
            .map(block => block.position);
    const seen = new Set();
    const registered = [];

    for (const position of candidates) {
        const normalized = {
            x: Math.floor(position.x),
            y: Math.floor(position.y),
            z: Math.floor(position.z),
        };
        const key = containerKey(normalized);
        if (seen.has(key) || !withinStorage(storage, normalized)) continue;
        const block = bot.blockAt(new Vec3(normalized.x, normalized.y, normalized.z));
        // Once the storage area is loaded, a missing block is a destroyed/stale
        // container, not an unknown chunk. Prune it so repair can place a new chest.
        if ((!block && storageAreaLoaded(bot, storage))
            || (block && !['chest', 'trapped_chest', 'barrel'].includes(block.name))) continue;
        seen.add(key);
        registered.push(normalized);
    }

    if (!hadRegistry || JSON.stringify(registered) !== JSON.stringify(storage.containers)) {
        storage.containers = registered;
        saveStorage(storage);
    }
    return storage;
}

function findPublicBlocks(bot, storage, names) {
    const ids = blockIds(bot, names);
    if (ids.length === 0) return [];
    return bot.findBlocks({
        point: storagePoint(storage),
        matching: ids,
        maxDistance: storage.radius + 4,
        count: 32,
    }).filter(position => withinStorage(storage, position));
}

// Does the public storage already provide this utility block nearby? Used so bots
// near the storage don't drop duplicate crafting tables / furnaces.
export function publicHasUtility(bot, names) {
    const storage = getPublicStorage(bot);
    if (!storage) return false;
    return findPublicBlocks(bot, storage, Array.isArray(names) ? names : [names]).length > 0;
}

function placementOffsets(radius) {
    const offsets = [];
    for (let ring = 2; ring <= radius; ring++) {
        for (let x = -ring; x <= ring; x++) {
            offsets.push({ x, z: -ring }, { x, z: ring });
        }
        for (let z = -ring + 1; z <= ring - 1; z++) {
            offsets.push({ x: -ring, z }, { x: ring, z });
        }
    }
    return offsets;
}

function findPlacementSpot(bot, storage, item, occupied) {
    const avoidAdjacentContainer = item === 'chest' || item === 'barrel';
    for (const offset of placementOffsets(storage.radius)) {
        const pos = new Vec3(storage.x + offset.x, storage.y, storage.z + offset.z);
        const target = bot.blockAt(pos);
        const above = bot.blockAt(pos.offset(0, 1, 0));
        const below = bot.blockAt(pos.offset(0, -1, 0));
        if (!target || !above || !below) continue;
        if (!EMPTY.has(target.name) || !EMPTY.has(above.name) || UNSAFE_FLOOR.has(below.name)) continue;
        if (occupied.has(`${pos.x},${pos.y},${pos.z}`)) continue;
        if (avoidAdjacentContainer) {
            const adjacent = [
                pos.offset(1, 0, 0), pos.offset(-1, 0, 0),
                pos.offset(0, 0, 1), pos.offset(0, 0, -1),
            ].some(p => occupied.has(`${p.x},${p.y},${p.z}`));
            if (adjacent) continue;
        }
        return pos;
    }
    return null;
}

async function ensurePlaced(bot, storage, item, desired, names = [item]) {
    const isContainer = names.some(name => ['chest', 'trapped_chest', 'barrel'].includes(name));
    const findExisting = () => isContainer
        ? findPublicContainers(bot, storage)
        : findPublicBlocks(bot, storage, names);
    let existing = findExisting();
    const occupied = new Set([
        ...scanPublicContainers(bot, storage),
        ...findPublicBlocks(bot, storage, [
            'crafting_table', 'furnace', 'blast_furnace', 'smoker',
            'enchanting_table', 'bookshelf', 'anvil', 'chipped_anvil',
            'damaged_anvil', 'brewing_stand', 'cauldron',
        ]),
    ].map(block => {
        const position = block.position ?? block;
        return containerKey(position);
    }));

    while (existing.length < desired && !bot.interrupt_code) {
        if ((world.getInventoryCounts(bot)[item] ?? 0) < 1)
            await craftRecipe(bot, item, 1);
        if ((world.getInventoryCounts(bot)[item] ?? 0) < 1) break;
        const spot = findPlacementSpot(bot, storage, item, occupied);
        if (!spot) break;
        if (!await placeBlock(bot, item, spot.x, spot.y, spot.z)) break;
        occupied.add(containerKey(spot));
        if (isContainer) {
            storage.containers ??= [];
            storage.containers.push({ x: spot.x, y: spot.y, z: spot.z });
            saveStorage(storage);
        }
        existing = findExisting();
    }
    return existing.length >= desired;
}

async function setupPublicStorageUnlocked(bot, storage) {
    if (!Array.isArray(storage.containers) || storage.containers.length === 0) {
        const snapped = snapStoragePosition(bot, storagePoint(storage));
        if (Math.abs(snapped.y - storage.y) > 2) {
            storage = { ...storage, x: snapped.x, y: snapped.y, z: snapped.z, updatedAt: new Date().toISOString() };
            saveStorage(storage);
            log(bot, `Javni storage sem popravil na tla pri ${storage.x},${storage.y},${storage.z}.`);
        }
    }
    if (!await goToPosition(bot, storage.x, storage.y, storage.z, 3)) return false;
    ensureContainerRegistry(bot, storage);
    await ensurePlaced(bot, storage, 'crafting_table', 1);
    await ensurePlaced(bot, storage, 'chest', TARGET_CONTAINERS, ['chest', 'trapped_chest', 'barrel']);
    await ensurePlaced(bot, storage, 'furnace', 2, ['furnace', 'blast_furnace', 'smoker']);
    const containers = findPublicContainers(bot, storage);
    log(bot, `Javni storage ima ${containers.length}/${TARGET_CONTAINERS} skrinj.`);
    return containers.length > 0;
}

export async function setupPublicStorage(bot, waitMs = ACCESS_WAIT_MS) {
    const storage = getPublicStorage(bot);
    if (!storage) return false;
    const result = await withNamedLock(bot, ACCESS_LOCK, async () =>
        await setupPublicStorageUnlocked(bot, getPublicStorage(bot) ?? storage), waitMs);
    return result.locked && result.value;
}

export async function ensurePublicUtility(bot, item, desired = 1, names = [item], waitMs = ACCESS_WAIT_MS) {
    const storage = getPublicStorage(bot);
    if (!storage) return false;
    const result = await withNamedLock(bot, ACCESS_LOCK, async () => {
        let current = getPublicStorage(bot) ?? storage;
        if (!await setupPublicStorageUnlocked(bot, current)) return false;
        current = getPublicStorage(bot) ?? current;
        await takeNeededPublicUnlocked(bot, { [item]: desired }, current);
        return await ensurePlaced(bot, current, item, desired, names);
    }, waitMs);
    return result.locked && result.value;
}

export async function configurePublicStorage(bot, position, radius = DEFAULT_RADIUS, townStyle = null) {
    const result = await withNamedLock(bot, ACCESS_LOCK, async () => {
        const existing = getPublicStorage(bot);
        const requested = snapStoragePosition(bot, position);
        // A public !storage command is heard by every bot. The first bot through
        // the cross-process lock chooses the shared anchor; the other responders
        // must join that same hub instead of replacing it with their own position.
        const freshExisting = existing
            && Date.now() - Date.parse(existing.updatedAt ?? 0) < 30_000;
        if (freshExisting) {
            if (townStyle && existing.townStyle !== townStyle) {
                const updated = {
                    ...existing,
                    townStyle,
                    updatedBy: bot.username,
                    updatedAt: new Date().toISOString(),
                };
                saveStorage(updated);
                log(bot, `Stil vasi pri javnem storageu je zdaj ${townStyle}.`);
            }
            return await setupPublicStorageUnlocked(bot, getPublicStorage(bot) ?? existing);
        }
        const storage = {
            x: requested.x,
            y: requested.y,
            z: requested.z,
            radius,
            dimension: dimensionKey(bot),
            townStyle: townStyle ?? existing?.townStyle ?? 'mixed',
            updatedBy: bot.username,
            updatedAt: new Date().toISOString(),
        };
        saveStorage(storage);
        log(bot, `Javni storage nastavljen pri ${storage.x},${storage.y},${storage.z} (radij ${radius}, stil ${storage.townStyle}).`);
        return await setupPublicStorageUnlocked(bot, storage);
    }, 15_000);
    return result.locked && result.value;
}

export async function goToPublicStorage(bot) {
    let storage = getPublicStorageAnchor(bot);
    if (!storage) return false;
    if (!Array.isArray(storage.containers) || storage.containers.length === 0) {
        await setupPublicStorage(bot, 500);
        storage = getPublicStorageAnchor(bot) ?? storage;
        if (!Array.isArray(storage.containers) || storage.containers.length === 0) {
            const snapped = snapStoragePosition(bot, storagePoint(storage));
            if (Math.abs(snapped.y - storage.y) > 2) {
                storage = { ...storage, x: snapped.x, y: snapped.y, z: snapped.z, updatedAt: new Date().toISOString() };
                saveStorage(storage);
            }
        }
    }
    if (!await goToPosition(bot, storage.x, storage.y, storage.z, 3)) return false;

    storage = getPublicStorage(bot) ?? storage;
    ensureContainerRegistry(bot, storage);
    storage = getPublicStorage(bot) ?? storage;
    if (findPublicContainers(bot, storage).length > 0) return true;

    // Creepers and modded mobs can destroy the last registered chest. Repair the
    // hub once; callers must not treat an empty coordinate as usable storage.
    await setupPublicStorage(bot, 500);
    storage = getPublicStorage(bot) ?? storage;
    return findPublicContainers(bot, storage).length > 0;
}

function itemCategory(name) {
    if (name.includes('food') || name.includes('seed') || name === 'wheat'
        || name === 'bread' || name === 'carrot' || name === 'potato'
        || name === 'beetroot' || name === 'pumpkin' || name === 'melon'
        || name.startsWith('cooked_') || name.endsWith('_berries')
        || ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'apple',
            'golden_apple', 'golden_carrot', 'baked_potato', 'cod', 'salmon',
            'fish', 'cooked_fish', 'cookie', 'dried_kelp', 'mushroom_stew', 'rabbit_stew'].includes(name))
        return 'food';
    if (name.includes('ore') || name.includes('ingot') || name.includes('nugget')
        || name.startsWith('raw_') || ['coal', 'charcoal', 'diamond', 'emerald', 'lapis_lazuli',
            'dye', 'redstone', 'quartz', 'amethyst_shard', 'flint'].includes(name))
        return 'resources';
    if (['_pickaxe', '_shovel', '_sword', '_helmet', '_chestplate', '_leggings',
        '_boots', '_hoe', '_axe'].some(suffix => name.endsWith(suffix))
        || ['bow', 'crossbow', 'shield', 'elytra', 'trident', 'mace'].includes(name))
        return 'equipment';
    if (name.includes('planks') || name === 'planks' || name.includes('log') || name === 'log' || name === 'log2' || name.includes('wood')
        || name.includes('stone') || name.includes('brick') || name.includes('glass')
        || name.includes('concrete') || name.includes('terracotta')
        || name === 'stained_hardened_clay'
        || name.includes('sand') || name.includes('dirt') || name.includes('wool') || name === 'wool'
        || name.includes('slab') || name.includes('stairs') || name.includes('fence'))
        return 'building';
    return 'misc';
}

function assignedContainerIndex(category, containerCount) {
    if (containerCount <= 1) return 0;
    const categoryIndex = CATEGORY_ORDER.indexOf(category);
    return Math.min(containerCount - 1, Math.max(0, categoryIndex));
}

function containersForCategories(bot, containers, categories) {
    const preferredIndices = [...new Set(categories
        .map(category => assignedContainerIndex(category, containers.length)))];
    const preferred = preferredIndices.map(index => containers[index]).filter(Boolean);
    const preferredKeys = new Set(preferred.map(block => containerKey(block.position)));
    return [
        ...preferred,
        ...nearestFirst(bot, containers.filter(block =>
            !preferredKeys.has(containerKey(block.position)))),
    ];
}

async function depositInto(bot, block, category, depositAmount) {
    let moved = 0;
    const result = await withContainerLock(bot, block, async () => {
        let container;
        try {
            container = await openContainerSafe(bot, block);
            const items = bot.inventory.items()
                .filter(item => depositAmount(item) > 0 && itemCategory(item.name) === category);
            for (const item of items) {
                const count = Math.min(item.count, Math.max(0, depositAmount(item)));
                if (count <= 0) continue;
                try {
                    await container.deposit(item.type, item.metadata, count, item.nbt);
                    depositAmount.consume?.(item, count);
                    moved += count;
                } catch {
                    break;
                }
            }
        } catch {
            return false;
        } finally {
            if (container)
                try { await container.close(); } catch { /* disconnected */ }
        }
    }, CONTAINER_WAIT_MS);
    return result.locked ? moved : 0;
}

async function stashPublicUnlocked(bot, depositAmount, storage) {
    const hasDeposits = bot.inventory.items().some(item => depositAmount(item) > 0);
    if (!hasDeposits) return true;
    ensureContainerRegistry(bot, storage);
    let containers = findPublicContainers(bot, storage);
    if (containers.length === 0) {
        if (!await setupPublicStorage(bot)) return false;
        containers = findPublicContainers(bot, getPublicStorage(bot) ?? storage);
    }
    if (containers.length === 0) return false;

    let deposited = 0;
    for (const category of CATEGORY_ORDER) {
        if (bot.interrupt_code) break;
        const index = assignedContainerIndex(category, containers.length);
        const ordered = [
            containers[index],
            ...nearestFirst(bot, containers.filter((_, otherIndex) => otherIndex !== index)),
        ];
        for (const block of ordered) {
            const hasItems = bot.inventory.items()
                .some(item => depositAmount(item) > 0 && itemCategory(item.name) === category);
            if (!hasItems || bot.interrupt_code) break;
            if (!await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2)) continue;
            deposited += await depositInto(bot, block, category, depositAmount);
        }
    }

    const leftovers = () => bot.inventory.items().some(item => depositAmount(item) > 0);
    if (leftovers() && containers.length < MAX_CONTAINERS) {
        const expansion = await withNamedLock(bot, ACCESS_LOCK, async () => {
            const currentStorage = getPublicStorage(bot) ?? storage;
            const currentCount = findPublicContainers(bot, currentStorage).length;
            if (currentCount >= MAX_CONTAINERS) return [];
            const expandedOk = await ensurePlaced(
                bot,
                currentStorage,
                'chest',
                Math.min(MAX_CONTAINERS, currentCount + 1),
                ['chest', 'trapped_chest', 'barrel'],
            );
            return expandedOk ? findPublicContainers(bot, currentStorage) : [];
        }, ACCESS_WAIT_MS);
        if (expansion.locked && expansion.value.length > containers.length) {
            const expanded = expansion.value;
            const previous = new Set(containers.map(block =>
                `${block.position.x},${block.position.y},${block.position.z}`));
            const overflow = expanded.filter(block =>
                !previous.has(`${block.position.x},${block.position.y},${block.position.z}`));
            for (const block of overflow) {
                if (!leftovers() || bot.interrupt_code) break;
                if (!await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2)) continue;
                for (const category of CATEGORY_ORDER)
                    deposited += await depositInto(bot, block, category, depositAmount);
            }
        }
    }

    log(bot, deposited > 0
        ? `Shranil ${deposited} stvari v javni storage.`
        : 'Nimam novih stvari za javni storage.');
    return deposited > 0 || !leftovers();
}

export async function stashPublic(bot, depositAmount) {
    const storage = getPublicStorage(bot);
    if (!storage) return false;
    if (!await goToPublicStorage(bot)) return false;
    return await stashPublicUnlocked(bot, depositAmount, getPublicStorage(bot) ?? storage);
}

export async function openContainerSafe(bot, block) {
    let timer;
    let timedOut = false;
    const opening = bot.openContainer(block);
    try {
        return await Promise.race([
            opening,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    reject(new Error('container open timed out'));
                }, OPEN_TIMEOUT_MS);
            }),
        ]);
    } catch (error) {
        const current = bot.currentWindow;
        if (current && current !== bot.inventory) {
            try { bot.closeWindow(current); } catch { /* window may already be closed */ }
        }
        if (timedOut) {
            void opening.then(async container => {
                try { await container.close(); } catch { /* late window may already be closed */ }
            }).catch(() => {});
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function openAndWithdraw(bot, block, callback) {
    let moved = 0;
    const result = await withContainerLock(bot, block, async () => {
        let container;
        try {
            container = await openContainerSafe(bot, block);
            moved = await callback(container);
        } catch {
            return false;
        } finally {
            if (container)
                try { await container.close(); } catch { /* disconnected */ }
        }
    }, CONTAINER_WAIT_MS);
    return result.locked ? moved : 0;
}

async function takeNeededPublicUnlocked(bot, needs, storage) {
    const current = world.getInventoryCounts(bot);
    const remaining = Object.fromEntries(
        Object.entries(needs)
            .map(([name, target]) => [name, Math.max(0, target - (current[name] ?? 0))])
            .filter(([, amount]) => amount > 0),
    );
    if (Object.keys(remaining).length === 0) return true;
    ensureContainerRegistry(bot, storage);

    let moved = 0;
    const containers = findPublicContainers(bot, storage);
    const categories = Object.keys(remaining).map(itemCategory);
    const predicate = item => Object.keys(remaining)
        .some(name => mc.stackMatchesName(item, name, bot));
    const ordered = orderContainersFromIndex(
        bot,
        containersForCategories(bot, containers, categories),
        predicate,
    );
    for (const block of ordered) {
        if (bot.interrupt_code || Object.values(remaining).every(amount => amount <= 0)) break;
        if (!await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2)) continue;
        moved += await openAndWithdraw(bot, block, async container => {
            let fromChest = 0;
            for (const item of container.containerItems()) {
                const matchName = Object.keys(remaining).find(name => remaining[name] > 0 && mc.stackMatchesName(item, name, bot));
                const needed = matchName ? remaining[matchName] : 0;
                if (needed <= 0) continue;
                const amount = Math.min(needed, item.count);
                try {
                    await container.withdraw(item.type, item.metadata, amount, item.nbt);
                    remaining[matchName] -= amount;
                    fromChest += amount;
                } catch {
                    break;
                }
            }
            return fromChest;
        });
    }
    return moved > 0;
}

export async function takeNeededPublic(bot, needs) {
    const storage = getPublicStorage(bot);
    if (!storage) return false;
    const current = world.getInventoryCounts(bot);
    const names = Object.entries(needs)
        .filter(([name, target]) => Number(current[name] ?? 0) < Number(target))
        .map(([name]) => name);
    if (names.length === 0) return true;
    const predicate = item => names.some(name => mc.stackMatchesName(item, name, bot));
    if (publicIndexKnowsMissing(bot, storage, predicate)) return false;
    if (!await goToPublicStorage(bot)) return false;
    return await takeNeededPublicUnlocked(bot, needs, getPublicStorage(bot) ?? storage);
}

async function takeAnyPublicUnlocked(bot, names, targetCount, storage) {
    const nameSet = new Set(names);
    const current = bot.inventory.items()
        .filter(item => mc.stackMatchesAnyName(item, [...nameSet], bot))
        .reduce((sum, item) => sum + item.count, 0);
    let remaining = Math.max(0, targetCount - current);
    if (remaining === 0) return true;
    ensureContainerRegistry(bot, storage);

    const containers = findPublicContainers(bot, storage);
    const categories = [...nameSet].map(itemCategory);
    const predicate = item => mc.stackMatchesAnyName(item, [...nameSet], bot);
    const ordered = orderContainersFromIndex(
        bot,
        containersForCategories(bot, containers, categories),
        predicate,
    );
    for (const block of ordered) {
        if (bot.interrupt_code || remaining <= 0) break;
        if (!await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2)) continue;
        await openAndWithdraw(bot, block, async container => {
            let fromChest = 0;
            for (const item of container.containerItems()) {
                if (!mc.stackMatchesAnyName(item, [...nameSet], bot) || remaining <= 0) continue;
                const amount = Math.min(remaining, item.count);
                try {
                    await container.withdraw(item.type, item.metadata, amount, item.nbt);
                    remaining -= amount;
                    fromChest += amount;
                } catch {
                    break;
                }
            }
            return fromChest;
        });
    }
    return remaining === 0;
}

export async function takeAnyPublic(bot, names, targetCount) {
    const storage = getPublicStorage(bot);
    if (!storage) return false;
    const current = bot.inventory.items()
        .filter(item => mc.stackMatchesAnyName(item, names, bot))
        .reduce((sum, item) => sum + item.count, 0);
    if (current >= targetCount) return true;
    const predicate = item => mc.stackMatchesAnyName(item, names, bot);
    if (publicIndexKnowsMissing(bot, storage, predicate)) return false;
    if (!await goToPublicStorage(bot)) return false;
    return await takeAnyPublicUnlocked(bot, names, targetCount, getPublicStorage(bot) ?? storage);
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
    return partialSpace + Math.max(0, bot.inventory.emptySlotCount()) * stackSize;
}

export function inventoryCanReceive(bot, item) {
    return inventoryReceiveCapacity(bot, item) > 0;
}

export function selectMatchingItems(items, predicate, score = null) {
    const candidates = items.filter(item => {
        try { return predicate(item); } catch { return false; }
    });
    if (!score) return candidates;
    const safeScore = item => {
        try {
            const value = Number(score(item));
            return Number.isFinite(value) ? value : 0;
        } catch {
            return 0;
        }
    };
    return candidates.sort((left, right) => safeScore(right) - safeScore(left));
}

export async function withdrawPublicMatching(
    bot,
    predicate,
    maxItems = 32,
    categories = ['equipment'],
    score = null,
) {
    const storage = getPublicStorage(bot);
    if (!storage || maxItems < 1) return 0;
    if (publicIndexKnowsMissing(bot, storage, predicate)) return 0;
    if (!await goToPublicStorage(bot)) return 0;
    const currentStorage = getPublicStorage(bot) ?? storage;
    ensureContainerRegistry(bot, currentStorage);

    let moved = 0;
    const containers = findPublicContainers(bot, currentStorage);
    const ordered = orderContainersFromIndex(
        bot,
        containersForCategories(bot, containers, categories),
        predicate,
        { score },
    );
    for (const block of ordered) {
        if (bot.interrupt_code || moved >= maxItems) break;
        if (!await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2))
            continue;
        moved += await openAndWithdraw(bot, block, async container => {
            let fromChest = 0;
            const candidates = selectMatchingItems(container.containerItems(), predicate, score);
            for (const item of candidates) {
                if (moved + fromChest >= maxItems) break;
                const inventoryRoom = inventoryReceiveCapacity(bot, item);
                if (inventoryRoom < 1) continue;
                const amount = Math.min(item.count, maxItems - moved - fromChest, inventoryRoom);
                try {
                    await container.withdraw(item.type, item.metadata, amount, item.nbt);
                    fromChest += amount;
                } catch {
                    break;
                }
            }
            return fromChest;
        });
    }
    return moved;
}

export function selectMatchingItem(items, predicate, score = null) {
    return selectMatchingItems(items, predicate, score)[0] ?? null;
}

// Withdraw one exact stack candidate while preserving metadata/NBT. An optional
// score scans all public containers and withdraws the highest-ranked match.
export async function takeOnePublicMatching(bot, predicate, score = null) {
    const storage = getPublicStorage(bot);
    if (!storage) return null;
    if (publicIndexKnowsMissing(bot, storage, predicate)) return null;
    if (!await goToPublicStorage(bot)) return null;
    const currentStorage = getPublicStorage(bot) ?? storage;
    ensureContainerRegistry(bot, currentStorage);
    const occupiedSlots = new Set(bot.inventory.items().map(item => item.slot));
    let best = null;
    const ranked = [];

    const candidates = orderContainersFromIndex(
        bot,
        nearestFirst(bot, findPublicContainers(bot, currentStorage)),
        predicate,
        { score },
    );
    for (const block of candidates) {
        if (bot.interrupt_code) break;
        if (!await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2))
            continue;
        const result = await withContainerLock(bot, block, async () => {
            let container;
            try {
                container = await openContainerSafe(bot, block);
                const candidate = selectMatchingItem(
                    container.containerItems(),
                    predicate,
                    score,
                );
                if (!candidate) return false;
                if (score) {
                    const candidateScore = score(candidate);
                    ranked.push({ block, score: candidateScore });
                    return true;
                }
                await container.withdraw(
                    candidate.type,
                    candidate.metadata,
                    1,
                    candidate.nbt,
                );
                best = {
                    name: candidate.name,
                    type: candidate.type,
                    metadata: candidate.metadata,
                    nbt: candidate.nbt,
                };
                return true;
            } catch {
                return false;
            } finally {
                if (container)
                    try { await container.close(); } catch { /* disconnected */ }
            }
        }, CONTAINER_WAIT_MS);
        if (!score && result.locked && result.value && best) {
            const received = bot.inventory.items().find(item =>
                !occupiedSlots.has(item.slot)
                && item.type === best.type
                && item.name === best.name);
            return { ...best, slot: received?.slot ?? null };
        }
    }

    if (!score || ranked.length === 0 || bot.interrupt_code) return null;
    ranked.sort((a, b) => b.score - a.score);
    for (const location of ranked) {
        if (bot.interrupt_code) break;
        if (!await goToPosition(
            bot,
            location.block.position.x,
            location.block.position.y,
            location.block.position.z,
            2,
        )) continue;

        let selected = null;
        const result = await withContainerLock(bot, location.block, async () => {
            let container;
            try {
                container = await openContainerSafe(bot, location.block);
                const candidate = selectMatchingItem(
                    container.containerItems(),
                    predicate,
                    score,
                );
                if (!candidate) return false;
                await container.withdraw(
                    candidate.type,
                    candidate.metadata,
                    1,
                    candidate.nbt,
                );
                selected = {
                    name: candidate.name,
                    type: candidate.type,
                    metadata: candidate.metadata,
                    nbt: candidate.nbt,
                };
                return true;
            } catch {
                return false;
            } finally {
                if (container)
                    try { await container.close(); } catch { /* disconnected */ }
            }
        }, CONTAINER_WAIT_MS);
        if (!result.locked || !result.value || !selected) continue;
        const received = bot.inventory.items().find(item =>
            !occupiedSlots.has(item.slot)
            && item.type === selected.type
            && item.name === selected.name);
        return { ...selected, slot: received?.slot ?? null };
    }
    return null;
}

// Deposit a specific live inventory item, preserving enchantments and damage.
export async function depositPublicItem(bot, item, count = item?.count ?? 1) {
    const storage = getPublicStorage(bot);
    if (!storage || !item || count < 1) return false;
    if (!await goToPublicStorage(bot)) return false;
    const currentStorage = getPublicStorage(bot) ?? storage;
    ensureContainerRegistry(bot, currentStorage);
    let containers = findPublicContainers(bot, currentStorage);
    if (containers.length === 0) {
        if (!await setupPublicStorage(bot)) return false;
        containers = findPublicContainers(bot, getPublicStorage(bot) ?? currentStorage);
    }
    const preferred = assignedContainerIndex(itemCategory(item.name), containers.length);
    const ordered = [
        containers[preferred],
        ...nearestFirst(bot, containers.filter((_, index) => index !== preferred)),
    ].filter(Boolean);

    for (const block of ordered) {
        if (bot.interrupt_code) break;
        if (!await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2))
            continue;
        const result = await withContainerLock(bot, block, async () => {
            let container;
            try {
                container = await openContainerSafe(bot, block);
                await container.deposit(item.type, item.metadata, count, item.nbt);
                return true;
            } catch {
                return false;
            } finally {
                if (container)
                    try { await container.close(); } catch { /* disconnected */ }
            }
        }, CONTAINER_WAIT_MS);
        if (result.locked && result.value) return true;
    }
    return false;
}

export function publicStorageNeedsMaintenance(bot) {
    const storage = getPublicStorage(bot);
    if (!storage || !storageAreaLoaded(bot, storage)) return false;
    return findPublicContainers(bot, storage).length < TARGET_CONTAINERS
        || findPublicBlocks(bot, storage, ['crafting_table']).length < 1
        || findPublicBlocks(bot, storage, ['furnace', 'blast_furnace', 'smoker']).length < 2;
}
