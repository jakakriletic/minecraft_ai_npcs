// Persistent irrigated wheat farms. Each bot reserves its own 9x9 plot, shares
// seeds/materials through base storage, and only harvests fully mature wheat.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { dirname } from 'path';
import { Vec3 } from 'vec3';
import * as world from './world.js';
import * as base from './base.js';
import {
    attackEntity,
    breakBlockAt,
    collectBlock,
    craftRecipe,
    equipItemSafely,
    goToPosition,
    log,
    obtainTool,
    pickupNearbyItems,
    placeBlock,
    smeltItem,
    tillAndSow,
    useToolOnBlock,
} from './skills.js';
import { withNamedLock } from './container_lock.js';
import { isNaturalResourceCandidate, isPositionProtected } from './resource_guard.js';
import * as mc from '../../utils/mcdata.js';

const FARM_RADIUS = 4;
const FARM_SIZE = FARM_RADIUS * 2 + 1;
const FARM_CELLS = FARM_SIZE * FARM_SIZE - 1;
const STARTER_FARM_RADIUS = 2;
const EMPTY = new Set([
    'air', 'cave_air', 'void_air', 'short_grass', 'tallgrass', 'tall_grass',
    'fern', 'large_fern', 'snow', 'dead_bush',
]);
const NATURAL_GROUND = new Set([
    'grass_block', 'grass', 'dirt', 'coarse_dirt', 'farmland', 'dirt_path', 'grass_path', 'podzol',
]);
const FARMABLE_FOUNDATION = new Set([
    ...NATURAL_GROUND,
    'stone', 'andesite', 'diorite', 'granite', 'gravel', 'sand', 'clay',
    'moss_block', 'rooted_dirt', 'mud',
]);
const GRASS = ['short_grass', 'tallgrass', 'tall_grass', 'fern', 'large_fern'];
// Trivial man-made/pond blocks a farmer may clear from his own plot: bot lighting
// (auto-light drops torches mid-field) and lily pads on the irrigation water.
const CLEARABLE_TRIVIA = new Set(['torch', 'waterlily', 'lily_pad']);
// After this many consecutive "plot is built over/flooded" failures the site is
// abandoned and blacklisted; without it a farm inside a player build retries forever.
const FARM_ABANDON_AFTER_FAILS = 3;
const FARM_BLACKLIST_RADIUS = 12;
const FARM_MAX_HOME_DISTANCE = 96;
const BREED_COOLDOWN_MS = 5 * 60_000;
const CULL_COOLDOWN_MS = 5 * 60_000;
const LIVESTOCK = [
    { name: 'cow', feed: 'wheat', reserve: 2 },
    { name: 'pig', feed: 'carrot', reserve: 0 },
    { name: 'chicken', feed: 'wheat_seeds', reserve: 10 },
];

function invCount(bot, names) {
    const inventory = world.getInventoryCounts(bot);
    return (Array.isArray(names) ? names : [names])
        .reduce((sum, name) => sum + (inventory[name] ?? 0), 0);
}

function farmRadius(farm) {
    return Math.max(STARTER_FARM_RADIUS, Math.min(FARM_RADIUS, Number(farm?.radius) || FARM_RADIUS));
}

function farmCellCount(farm) {
    const radius = farmRadius(farm);
    return (radius * 2 + 1) ** 2 - 1;
}

function farmFile(bot) {
    return `./bots/${bot.username}/farm.json`;
}

function dimensionKey(bot) {
    return String(bot.game?.dimension ?? 'world');
}

export function getFarm(bot) {
    try {
        const farm = JSON.parse(readFileSync(farmFile(bot), 'utf8'));
        return farm.dimension === dimensionKey(bot) ? farm : null;
    } catch {
        return null;
    }
}

function saveFarm(bot, farm) {
    const file = farmFile(bot);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(farm, null, 2));
}

// A plot that repeatedly fails to normalize is built over or flooded by the world
// (glowstone ponds, cobble walls, lakes...). Count consecutive failures; past the
// limit drop the site and blacklist it so findFarmSite never picks it again.
function failFarmNormalize(bot, farm) {
    farm.normalizeFails = (Number(farm.normalizeFails) || 0) + 1;
    if (farm.normalizeFails < FARM_ABANDON_AFTER_FAILS) {
        saveFarm(bot, farm);
        log(bot, 'Prostor za njivo ni vec varen ali prost.');
    } else {
        saveFarm(bot, {
            dimension: farm.dimension,
            blacklist: [...(farm.blacklist ?? []), { x: farm.x, y: farm.y, z: farm.z }].slice(-12),
        });
        log(bot, `Lokacija njive pri ${farm.x},${farm.y},${farm.z} je zazidana ali poplavljena; opuscam jo in poiscem novo.`);
    }
    return false;
}

function farmNearHome(farm, home) {
    return farm && home
        && Number.isFinite(farm.x) && Number.isFinite(farm.y) && Number.isFinite(farm.z)
        && Math.hypot(farm.x - home.x, farm.z - home.z) <= FARM_MAX_HOME_DISTANCE
        && Math.abs(farm.y - home.y) <= 20;
}

function reservedFarms(bot, home) {
    const farms = [];
    try {
        for (const entry of readdirSync('./bots', { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name === bot.username || entry.name.startsWith('.')) continue;
            try {
                const farm = JSON.parse(readFileSync(`./bots/${entry.name}/farm.json`, 'utf8'));
                if (farm.dimension === dimensionKey(bot) && farmNearHome(farm, home))
                    farms.push(farm);
            } catch { /* bot has no reserved farm */ }
        }
    } catch { /* bots directory does not exist yet */ }
    return farms;
}

function candidateOffsets() {
    const offsets = [];
    for (const distance of [12, 18, 24, 30, 36, 42]) {
        offsets.push(
            { x: distance, z: 0 }, { x: -distance, z: 0 },
            { x: 0, z: distance }, { x: 0, z: -distance },
            { x: distance, z: distance }, { x: -distance, z: distance },
            { x: distance, z: -distance }, { x: -distance, z: -distance },
        );
    }
    return offsets;
}

function surfaceAt(bot, x, z, anchorY) {
    for (let y = Math.floor(anchorY) + 5; y >= Math.floor(anchorY) - 7; y--) {
        const ground = bot.blockAt(new Vec3(x, y, z));
        if (!ground) continue;
        if (ground.name === 'water' && ground.metadata === 0) {
            // Shallow river/pond cells can be filled while the center source is
            // preserved for irrigation. Reject deep water to avoid huge fill jobs.
            const shallowBottom = [1, 2].some(depth => {
                const below = bot.blockAt(new Vec3(x, y - depth, z));
                return below && below.name !== 'water' && !EMPTY.has(below.name);
            });
            if (shallowBottom) return { y, obstacles: 0 };
            continue;
        }
        if (!FARMABLE_FOUNDATION.has(ground.name)) continue;
        let clear = true;
        let obstacles = 0;
        for (let checkY = y + 2; checkY <= y + 4; checkY++) {
            const block = bot.blockAt(new Vec3(x, checkY, z));
            if (!block) {
                clear = false;
                break;
            }
            if (EMPTY.has(block.name)) continue;
            if (isNaturalResourceCandidate(bot, block, block.name)) {
                obstacles++;
                continue;
            }
            clear = false;
            break;
        }
        const above = bot.blockAt(new Vec3(x, y + 1, z));
        if (!above) continue;
        if (!EMPTY.has(above.name)) {
            if (!isNaturalResourceCandidate(bot, above, above.name)) continue;
            obstacles++;
        }
        if (clear) return { y, obstacles };
    }
    return null;
}

function evaluateFarmSite(
    bot,
    centerX,
    centerZ,
    anchorY,
    reservations,
    waterCenter = null,
    radius = FARM_RADIUS,
) {
    if (reservations.some(farm =>
        Math.hypot(farm.x - centerX, farm.z - centerZ)
            < radius + farmRadius(farm) + 4))
        return null;
    const surfaces = [];
    let plants = 0;
    for (let dx = -radius; dx <= radius; dx++)
        for (let dz = -radius; dz <= radius; dz++) {
            const x = centerX + dx;
            const z = centerZ + dz;
            if (isPositionProtected(bot, new Vec3(x, anchorY, z), 1))
                return null;
            if (waterCenter && dx === 0 && dz === 0) {
                const water = bot.blockAt(new Vec3(waterCenter.x, waterCenter.y, waterCenter.z));
                if (!water || water.name !== 'water' || water.metadata !== 0) return null;
                surfaces.push(waterCenter.y);
                continue;
            }
            const surface = surfaceAt(bot, x, z, anchorY);
            if (surface === null) return null;
            surfaces.push(surface.y);
            plants += surface.obstacles;
        }

    const levels = new Map();
    for (const y of surfaces) levels.set(y, (levels.get(y) ?? 0) + 1);
    const groundY = waterCenter?.y ?? [...levels.entries()]
        .sort((a, b) => b[1] - a[1] || Math.abs(a[0] - anchorY) - Math.abs(b[0] - anchorY))[0][0];
    const levelCells = levels.get(groundY) ?? 0;
    const roughness = Math.max(...surfaces.map(y => Math.abs(y - groundY)));
    const earthwork = surfaces.reduce((sum, y) => sum + Math.abs(y - groundY), 0);
    const plotCells = (radius * 2 + 1) ** 2;
    if (roughness > 2
        || levelCells < Math.ceil(plotCells * 0.5)
        || earthwork > Math.ceil(plotCells * 0.95))
        return null;
    return {
        x: centerX,
        y: groundY,
        z: centerZ,
        radius,
        dimension: dimensionKey(bot),
        score: roughness * 80 + earthwork * 4 + (plotCells - levelCells) * 2 + plants,
    };
}

function naturalWaterSources(bot, home) {
    const waterId = bot.registry.blocksByName.water?.id;
    if (waterId == null) return [];
    const positions = bot.findBlocks({
        point: new Vec3(home.x, home.y, home.z),
        // Filter during the world scan. Limiting an unfiltered search to the
        // first few water blocks lets underground caves hide a nearby river.
        matching: block => block.type === waterId
            && block.metadata === 0
            && Math.abs(block.position.y - home.y) <= 18,
        useExtraInfo: true,
        maxDistance: 56,
        count: 64,
    });
    const accepted = [];
    for (const position of positions) {
        const block = bot.blockAt(position);
        if (!block || block.metadata !== 0 || Math.abs(position.y - home.y) > 18
            || isPositionProtected(bot, position)) continue;
        if (accepted.some(other => other.distanceTo(position) < 4)) continue;
        accepted.push(position.clone());
        if (accepted.length >= 12) break;
    }
    return accepted;
}

function waterSideCandidates(bot, home, reservations) {
    const candidates = [];
    const seen = new Set();
    for (const water of naturalWaterSources(bot, home)) {
        const centered = evaluateFarmSite(
            bot,
            water.x,
            water.z,
            water.y,
            reservations,
            water,
        );
        if (centered) {
            centered.waterSource = { x: water.x, y: water.y, z: water.z };
            centered.waterAtCenter = true;
            centered.score -= 160;
            candidates.push(centered);
        } else {
            // A smaller 5x5 starter plot still hydrates fully from one center
            // source and is much easier to fit beside a river or pond. It uses
            // exactly the same planting/harvest/husbandry loop as a 9x9 farm.
            const starter = evaluateFarmSite(
                bot,
                water.x,
                water.z,
                water.y,
                reservations,
                water,
                STARTER_FARM_RADIUS,
            );
            if (starter) {
                starter.waterSource = { x: water.x, y: water.y, z: water.z };
                starter.waterAtCenter = true;
                starter.score -= 100;
                candidates.push(starter);
            }
        }
        for (const offset of [
            { x: FARM_RADIUS + 1, z: 0 },
            { x: -FARM_RADIUS - 1, z: 0 },
            { x: 0, z: FARM_RADIUS + 1 },
            { x: 0, z: -FARM_RADIUS - 1 },
        ]) {
            const x = water.x + offset.x;
            const z = water.z + offset.z;
            const key = `${x},${z}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const candidate = evaluateFarmSite(bot, x, z, water.y, reservations);
            if (!candidate) continue;
            candidate.waterSource = { x: water.x, y: water.y, z: water.z };
            candidate.score -= 75;
            candidates.push(candidate);
        }
    }
    return candidates;
}

export function findFarmSite(bot, home, reservations = reservedFarms(bot, home)) {
    const blacklist = getFarm(bot)?.blacklist ?? [];
    const notBlacklisted = site => !blacklist.some(bad =>
        Math.hypot(site.x - bad.x, site.z - bad.z) < FARM_BLACKLIST_RADIUS);
    const baseCandidates = candidateOffsets()
        .map(offset => evaluateFarmSite(bot, home.x + offset.x, home.z + offset.z, home.y, reservations))
        .filter(Boolean);
    return [...waterSideCandidates(bot, home, reservations), ...baseCandidates]
        .filter(notBlacklisted)
        .sort((a, b) => a.score - b.score
            || Math.hypot(a.x - home.x, a.z - home.z)
                - Math.hypot(b.x - home.x, b.z - home.z))[0] ?? null;
}

async function ensureFarmSite(bot) {
    const home = base.getBase(bot);
    if (!home) {
        log(bot, 'Za stalno njivo najprej potrebujem bazo.');
        return null;
    }
    const existing = getFarm(bot);
    if (existing && farmNearHome(existing, home)) return existing;
    if (existing && Number.isFinite(existing.x))
        log(bot, 'Stara lokacija njive ne pripada tej bazi; poiskal bom novo.');
    const horizontalDistance = bot.entity
        ? Math.hypot(bot.entity.position.x - home.x, bot.entity.position.z - home.z)
        : Number.POSITIVE_INFINITY;
    // Exact home coordinates may sit on a roof, hill edge, or behind a build.
    // Being inside the settlement is enough to inspect and reserve nearby plots.
    if (horizontalDistance > 48 && !await base.goHome(bot)) return null;

    const result = await withNamedLock(bot, 'farm-site-reservation', () => {
        const afterWait = getFarm(bot);
        if (afterWait && farmNearHome(afterWait, home)) return afterWait;
        const farm = findFarmSite(bot, home);
        if (farm) {
            if (afterWait?.blacklist?.length) farm.blacklist = afterWait.blacklist;
            saveFarm(bot, farm);
        }
        return farm;
    });
    if (!result.locked || !result.value) {
        log(bot, 'Blizu baze ne najdem dovolj varnega prostora, ki ga lahko poravnam za 9x9 njivo.');
        return null;
    }
    const size = farmRadius(result.value) * 2 + 1;
    log(bot, `Prostor za ${size}x${size} njivo rezerviran pri ${result.value.x},${result.value.y},${result.value.z}`
        + `${result.value.waterSource ? ' ob naravnem izviru vode' : ''}.`);
    return result.value;
}

async function ensureHoe(bot) {
    if (bot.inventory.items().some(item => item.name.endsWith('_hoe'))) return true;
    const target = bot._societyStoneBaseline ? 'stone_hoe' : 'wooden_hoe';
    await base.takeNeeded(bot, { [target]: 1 });
    if (bot.inventory.items().some(item => item.name.endsWith('_hoe'))) return true;
    await obtainTool(bot, target);
    return bot.inventory.items().some(item => item.name.endsWith('_hoe'));
}

async function getSeeds(bot, target) {
    if (invCount(bot, 'wheat_seeds') >= target) return true;
    await base.takeNeeded(bot, { wheat_seeds: target });
    for (let tries = 0; tries < 48
        && invCount(bot, 'wheat_seeds') < target
        && !bot.interrupt_code; tries++) {
        const grass = world.getNearestBlocks(bot, GRASS, 24, 1);
        if (grass.length === 0) break;
        try { await collectBlock(bot, grass[0].name, 1); } catch { /* try another patch */ }
        await pickupNearbyItems(bot);
    }
    return invCount(bot, 'wheat_seeds') > 0;
}

function farmApproaches(bot, farm) {
    const radius = farmRadius(farm);
    const positions = [];
    for (let dx = -radius - 1; dx <= radius + 1; dx++)
        for (let dz = -radius - 1; dz <= radius + 1; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) < radius) continue;
            const ground = new Vec3(farm.x + dx, farm.y, farm.z + dz);
            const floor = bot.blockAt(ground);
            const feet = bot.blockAt(ground.offset(0, 1, 0));
            const head = bot.blockAt(ground.offset(0, 2, 0));
            if (!floor || floor.name === 'water' || floor.name === 'lava'
                || !Array.isArray(floor.shapes) || floor.shapes.length === 0)
                continue;
            if (!feet || !head || !EMPTY.has(feet.name) || !EMPTY.has(head.name))
                continue;
            positions.push(ground.offset(0, 1, 0));
        }
    return positions.sort((a, b) =>
        a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
}

async function goToFarm(bot, farm) {
    for (const position of farmApproaches(bot, farm).slice(0, 10)) {
        try {
            if (await goToPosition(bot, position.x, position.y, position.z, 1))
                return true;
        } catch { /* try another dry edge */ }
    }
    log(bot, 'Do suhega roba njive ne najdem varne poti.');
    return false;
}

async function normalizeFarmGround(bot, farm) {
    const radius = farmRadius(farm);
    const fillPositions = [];
    for (let dx = -radius; dx <= radius; dx++)
        for (let dz = -radius; dz <= radius; dz++) {
            const x = farm.x + dx;
            const z = farm.z + dz;
            for (let clearY = farm.y + 4; clearY >= farm.y + 1; clearY--) {
                const obstacle = bot.blockAt(new Vec3(x, clearY, z));
                if (!obstacle) return false;
                if (EMPTY.has(obstacle.name) || obstacle.name === 'wheat') continue;
                if (!CLEARABLE_TRIVIA.has(obstacle.name)
                    && !NATURAL_GROUND.has(obstacle.name)
                    && !GRASS.includes(obstacle.name)
                    && !isNaturalResourceCandidate(bot, obstacle, obstacle.name))
                    return false;
                if (!await breakBlockAt(bot, x, clearY, z)) return false;
            }

            // The center is permanently reserved for irrigation. ensureFarmWater
            // runs first and may either preserve a natural source or place one.
            if (dx === 0 && dz === 0) continue;

            const groundPos = new Vec3(x, farm.y, z);
            const ground = bot.blockAt(groundPos);
            if (!ground) return false;
            if (EMPTY.has(ground.name) || ground.name === 'water') {
                const support = bot.blockAt(groundPos.offset(0, -1, 0));
                if (!support || EMPTY.has(support.name) || support.name === 'water')
                    fillPositions.push(groundPos.offset(0, -1, 0));
                fillPositions.push(groundPos);
            } else if (FARMABLE_FOUNDATION.has(ground.name)
                && !NATURAL_GROUND.has(ground.name)) {
                if (!await breakBlockAt(bot, groundPos.x, groundPos.y, groundPos.z))
                    return false;
                fillPositions.push(groundPos);
            } else if (!NATURAL_GROUND.has(ground.name)) {
                return false;
            }
        }

    const uniqueFill = [...new Map(fillPositions.map(position => [
        `${position.x},${position.y},${position.z}`,
        position,
    ])).values()].sort((a, b) => a.y - b.y);
    if (uniqueFill.length > 0) {
        await base.takeNeeded(bot, { dirt: uniqueFill.length });
        if (invCount(bot, 'dirt') < uniqueFill.length) {
            const excluded = [];
            const radius = farmRadius(farm);
            for (let dx = -radius; dx <= radius; dx++)
                for (let dz = -radius; dz <= radius; dz++) {
                    excluded.push(new Vec3(farm.x + dx, farm.y, farm.z + dz));
                    excluded.push(new Vec3(farm.x + dx, farm.y - 1, farm.z + dz));
                }
            await collectBlock(
                bot,
                'dirt',
                uniqueFill.length - invCount(bot, 'dirt'),
                excluded,
            );
            await pickupNearbyItems(bot);
        }
        if (invCount(bot, 'dirt') < uniqueFill.length) {
            log(bot, `Za poravnavo njive manjka ${uniqueFill.length - invCount(bot, 'dirt')} zemlje.`);
            return 'no_dirt'; // recoverable supply problem — must not count toward abandoning the site
        }
        for (const position of uniqueFill) {
            if (bot.interrupt_code || invCount(bot, 'dirt') < 1) break;
            if (EMPTY.has(bot.blockAt(position)?.name) || bot.blockAt(position)?.name === 'water')
                await placeBlock(bot, 'dirt', position.x, position.y, position.z);
        }
    }
    return uniqueFill.every(position => NATURAL_GROUND.has(bot.blockAt(position)?.name));
}

async function ensureIrrigationBucket(bot) {
    if (invCount(bot, 'bucket') > 0) return true;

    await base.takeNeeded(bot, {
        bucket: 1,
        iron_ingot: 3,
        raw_iron: 3,
        coal: 1,
        furnace: 1,
    });
    if (invCount(bot, 'bucket') > 0) return true;

    if (invCount(bot, 'iron_ingot') < 3 && invCount(bot, 'raw_iron') > 0)
        await smeltItem(bot, 'raw_iron', Math.min(
            invCount(bot, 'raw_iron'),
            3 - invCount(bot, 'iron_ingot'),
        ));

    if (invCount(bot, 'iron_ingot') < 3 && !bot.interrupt_code) {
        const needed = 3 - invCount(bot, 'iron_ingot');
        log(bot, `Za vedro mi manjka ${needed} zeleza; poiscem izpostavljeno rudo stran od baze.`);
        await collectBlock(bot, 'iron_ore', needed);
        await pickupNearbyItems(bot);
        if (invCount(bot, ['raw_iron', 'iron_ingot']) < needed && !bot.interrupt_code) {
            log(bot, 'Na povrsju ni zeleza; odprem varen rudnik stran od naselbine.');
            const { mineOre } = await import('./survival.js');
            await mineOre(bot, ['iron_ore', 'deepslate_iron_ore'], needed, true);
            await pickupNearbyItems(bot);
        }
        if (invCount(bot, 'raw_iron') > 0)
            await smeltItem(bot, 'raw_iron', Math.min(
                invCount(bot, 'raw_iron'),
                3 - invCount(bot, 'iron_ingot'),
            ));
    }

    if (invCount(bot, 'iron_ingot') < 3) return false;
    await craftRecipe(bot, 'bucket', 1);
    return invCount(bot, 'bucket') > 0;
}

function relocateFarmToNaturalWater(bot, farm) {
    const home = base.getBase(bot);
    if (!home) return false;
    const replacement = waterSideCandidates(bot, home, reservedFarms(bot, home))
        .filter(candidate => candidate.waterAtCenter)
        .sort((a, b) => a.score - b.score)[0];
    if (!replacement) return false;

    const husbandry = farm.husbandry;
    for (const key of Object.keys(farm)) delete farm[key];
    Object.assign(farm, replacement);
    if (husbandry) farm.husbandry = husbandry;
    saveFarm(bot, farm);
    log(bot, `Njivo sem prestavil k naravni vodi pri ${farm.x},${farm.y},${farm.z}.`);
    return true;
}

async function ensureFarmWater(bot, farm) {
    const waterPos = new Vec3(farm.x, farm.y, farm.z);
    const current = bot.blockAt(waterPos);
    if (current?.name === 'water' && current.metadata === 0) return true;

    await base.takeNeeded(bot, { water_bucket: 1 });
    if (invCount(bot, 'water_bucket') < 1) {
        // Prefer a farm whose center is already a natural source. This avoids an
        // unnecessary mining trip and keeps first-time farmers moving.
        if (relocateFarmToNaturalWater(bot, farm)) return true;
        if (!await ensureIrrigationBucket(bot)) {
            log(bot, 'Za namakanje njive potrebujem naravni izvir ali tri kose zeleza za vedro.');
            return false;
        }
        let collectedWater = false;
        if (farm.waterSource) {
            const source = bot.blockAt(new Vec3(
                farm.waterSource.x,
                farm.waterSource.y,
                farm.waterSource.z,
            ));
            if (source?.name === 'water' && source.metadata === 0
                && isNaturalResourceCandidate(bot, source, 'water')) {
                try {
                    collectedWater = await useToolOnBlock(bot, 'bucket', source);
                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch { /* fall back to the nearest safe natural source */ }
            }
        }
        if (!collectedWater) {
            const sources = naturalWaterSources(bot, {
                x: bot.entity.position.x,
                y: bot.entity.position.y,
                z: bot.entity.position.z,
            });
            for (const position of sources) {
                const source = bot.blockAt(position);
                try {
                    if (source && await useToolOnBlock(bot, 'bucket', source)) {
                        collectedWater = true;
                        break;
                    }
                } catch { /* try the next source */ }
            }
        }
        await new Promise(resolve => setTimeout(resolve, 200));
        if (!collectedWater || invCount(bot, 'water_bucket') < 1) {
            log(bot, 'Ne najdem izvira vode za njivo.');
            return false;
        }
    }

    if (!await goToPosition(bot, waterPos.x, waterPos.y + 1, waterPos.z, 3)) return false;
    const target = bot.blockAt(waterPos);
    if (target && target.name !== 'air' && !await breakBlockAt(bot, waterPos.x, waterPos.y, waterPos.z))
        return false;
    const placed = await placeBlock(bot, 'water', waterPos.x, waterPos.y, waterPos.z);
    const ready = placed || bot.blockAt(waterPos)?.name === 'water';
    if (ready) {
        farm.waterAtCenter = true;
        saveFarm(bot, farm);
    }
    return ready;
}

async function addFarmUtilities(bot, farm) {
    const edge = farmRadius(farm) + 1;
    const composterPos = new Vec3(farm.x + edge, farm.y + 1, farm.z);
    // No composter before 1.14 (the compat layer would "craft" a cauldron instead);
    // without this gate every plantFarm cycle walked to storage for a phantom item.
    const composterExists = bot.registry?.itemsByName?.composter != null;
    if (composterExists && EMPTY.has(bot.blockAt(composterPos)?.name)) {
        if (invCount(bot, 'composter') < 1)
            await base.takeNeeded(bot, { composter: 1 });
        if (invCount(bot, 'composter') < 1) await craftRecipe(bot, 'composter', 1);
        if (invCount(bot, 'composter') > 0)
            try { await placeBlock(bot, 'composter', composterPos.x, composterPos.y, composterPos.z); } catch { /* optional */ }
    }
    const corners = [
        new Vec3(farm.x - edge, farm.y + 1, farm.z - edge),
        new Vec3(farm.x + edge, farm.y + 1, farm.z - edge),
        new Vec3(farm.x - edge, farm.y + 1, farm.z + edge),
        new Vec3(farm.x + edge, farm.y + 1, farm.z + edge),
    ];
    for (const position of corners) {
        if (invCount(bot, 'torch') < 1) break;
        if (EMPTY.has(bot.blockAt(position)?.name))
            try { await placeBlock(bot, 'torch', position.x, position.y, position.z); } catch { /* optional */ }
    }
}

function cropState(bot, farm) {
    const radius = farmRadius(farm);
    const ripe = [];
    const empty = [];
    let growing = 0;
    for (let dx = -radius; dx <= radius; dx++)
        for (let dz = -radius; dz <= radius; dz++) {
            if (dx === 0 && dz === 0) continue;
            const groundPos = new Vec3(farm.x + dx, farm.y, farm.z + dz);
            const ground = bot.blockAt(groundPos);
            const crop = bot.blockAt(groundPos.offset(0, 1, 0));
            if (crop?.name === 'wheat') {
                if (crop.metadata === 7
                    || Number(crop.getProperties?.().age ?? crop._properties?.age) === 7)
                    ripe.push(crop);
                else growing++;
            } else if (ground && NATURAL_GROUND.has(ground.name) && EMPTY.has(crop?.name)) {
                empty.push(groundPos);
            }
        }
    return { ripe, empty, growing };
}

export async function harvestFarm(bot, farm = getFarm(bot), maxWork = FARM_CELLS) {
    const home = base.getBase(bot);
    if (!farm || !farmNearHome(farm, home)) return false;
    const state = cropState(bot, farm);
    if (state.ripe.length === 0) return false;
    log(bot, `Zanjem ${Math.min(state.ripe.length, maxWork)} zrele psenice.`);
    let harvested = 0;
    for (const wheat of state.ripe.slice(0, maxWork)) {
        if (bot.interrupt_code) break;
        const position = wheat.position;
        try {
            if (!await breakBlockAt(bot, position.x, position.y, position.z)) continue;
            harvested++;
            if (harvested % 8 === 0) await pickupNearbyItems(bot);
            if (invCount(bot, 'wheat_seeds') > 0)
                await tillAndSow(bot, position.x, position.y - 1, position.z, 'wheat_seeds');
        } catch { /* next cycle repairs this crop */ }
    }
    if (harvested > 0) await pickupNearbyItems(bot);
    const breadWheat = Math.max(0, invCount(bot, 'wheat') - 4);
    if (breadWheat >= 3)
        await craftRecipe(bot, 'bread', Math.floor(breadWheat / 3));
    return harvested > 0;
}

// Emergency food source for a hungry bot: walk to our own wheat farm, cut any ripe
// wheat, and bake bread — dipping into the reserve wheat if needed, since a starving
// bot values HP over seed stock. Bread needs no furnace, so this is the reliable food
// path on servers where the furnace GUI is temporarily unavailable.
// Returns true only if it actually produced bread. No-op when nothing is ripe.
export async function harvestForFood(bot) {
    const home = base.getBase(bot);
    const farm = getFarm(bot);
    if (!farm || !farmNearHome(farm, home)) return false;
    const breadBefore = invCount(bot, 'bread');
    if (!await goToFarm(bot, farm)) return false;
    await harvestFarm(bot, farm);
    // Starving: convert spare wheat to bread, keeping only 3 to reseed the plot.
    const spare = Math.max(0, invCount(bot, 'wheat') - 3);
    if (spare >= 3) {
        try { await craftRecipe(bot, 'bread', Math.floor(spare / 3)); } catch { /* no crafting table reachable */ }
    }
    return invCount(bot, 'bread') > breadBefore;
}

export async function plantFarm(bot, maxWork = 24, farm = getFarm(bot)) {
    const home = base.getBase(bot);
    if (!farm || !farmNearHome(farm, home)) farm = await ensureFarmSite(bot);
    if (!farm) return false;
    if (!await goToFarm(bot, farm)) return false;
    if (!await ensureFarmWater(bot, farm)) return false;
    if (!await goToFarm(bot, farm)) return false;
    const normalized = await normalizeFarmGround(bot, farm);
    if (normalized === 'no_dirt') return false;
    if (normalized !== true) return failFarmNormalize(bot, farm);
    if (farm.normalizeFails) {
        delete farm.normalizeFails;
        saveFarm(bot, farm);
    }
    let state = cropState(bot, farm);
    const target = Math.min(maxWork, state.empty.length);
    if (target === 0) return true;
    if (!await getSeeds(bot, target)) {
        log(bot, 'Njiva je pripravljena, vendar nimam semen.');
        return false;
    }
    if (!await ensureHoe(bot)) {
        log(bot, 'Nimam motike za njivo.');
        return false;
    }
    await addFarmUtilities(bot, farm);

    await goToFarm(bot, farm);
    state = cropState(bot, farm);
    let planted = 0;
    for (const position of state.empty) {
        if (bot.interrupt_code || planted >= maxWork || invCount(bot, 'wheat_seeds') < 1) break;
        try {
            if (await tillAndSow(bot, position.x, position.y, position.z, 'wheat_seeds'))
                planted++;
        } catch { /* next cycle retries */ }
    }
    if (planted > 0) {
        const cells = farmCellCount(farm);
        const filled = cells - cropState(bot, farm).empty.length;
        log(bot, `Posadil ${planted} psenice (${filled}/${cells}).`);
    }
    return planted > 0;
}

function adultAnimals(bot, animalName, center, range = 24) {
    return Object.values(bot.entities ?? {})
        .filter(entity => entity?.name === animalName
            && entity.position
            && entity.isValid !== false
            && !mc.isBabyEntity(entity, bot)
            && entity.position.distanceTo(bot.entity.position) <= range
            && (!center || entity.position.distanceTo(center) <= range + 8))
        .sort((a, b) =>
            a.position.distanceTo(bot.entity.position)
            - b.position.distanceTo(bot.entity.position));
}

async function ensureBreedingFeed(bot, animal) {
    const target = 2 + animal.reserve;
    if (invCount(bot, animal.feed) < target)
        await base.takeNeeded(bot, { [animal.feed]: target });
    return invCount(bot, animal.feed) >= target;
}

async function feedAnimal(bot, entity, itemName) {
    if (!entity?.position || entity.isValid === false) return false;
    if (!await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, 2))
        return false;
    const current = bot.entities?.[entity.id];
    if (!current?.position || current.isValid === false) return false;
    const item = bot.inventory.items().find(stack => stack.name === itemName);
    if (!item) return false;
    try {
        if (!await equipItemSafely(bot, item, 'hand')) return false;
        await bot.lookAt(current.position.offset(0, Math.max(0.5, current.height * 0.6), 0), true);
        const before = invCount(bot, itemName);
        bot.useOn(current);
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline && invCount(bot, itemName) >= before)
            await new Promise(resolve => setTimeout(resolve, 100));
        return invCount(bot, itemName) < before;
    } catch {
        return false;
    }
}

function saveHusbandryState(bot, farm, animalName, updates) {
    farm.husbandry ??= {};
    farm.husbandry[animalName] = {
        ...(farm.husbandry[animalName] ?? {}),
        ...updates,
    };
    saveFarm(bot, farm);
}

export async function tendLivestock(bot, farm = getFarm(bot)) {
    if (!farm || !bot.entity) return false;
    const center = new Vec3(farm.x, farm.y + 1, farm.z);
    for (const animal of LIVESTOCK) {
        if (bot.interrupt_code) return false;
        const adults = adultAnimals(bot, animal.name, center);
        if (adults.length < 2) continue;
        const state = farm.husbandry?.[animal.name] ?? {};
        if (Date.now() - (state.lastBredAt ?? 0) < BREED_COOLDOWN_MS) continue;
        if (!await ensureBreedingFeed(bot, animal)) continue;

        const firstFed = await feedAnimal(bot, adults[0], animal.feed);
        const secondFed = firstFed && await feedAnimal(bot, adults[1], animal.feed);
        if (!secondFed) continue;

        const now = Date.now();
        saveHusbandryState(bot, farm, animal.name, { lastBredAt: now });
        log(bot, `Nahranil sem dva ${animal.name}; čreda se lahko razmnoži.`);

        // Cull exactly one unfed adult only when at least three adults existed,
        // leaving two breeding adults plus the new baby. Never target babies.
        if (adults.length >= 3
            && Date.now() - (state.lastCulledAt ?? 0) >= CULL_COOLDOWN_MS) {
            await new Promise(resolve => setTimeout(resolve, 800));
            const target = bot.entities?.[adults[2].id];
            if (target?.position && target.isValid !== false && !mc.isBabyEntity(target, bot)) {
                const culled = await attackEntity(bot, target, true);
                if (culled) {
                    saveHusbandryState(bot, farm, animal.name, {
                        lastBredAt: now,
                        lastCulledAt: Date.now(),
                    });
                    await pickupNearbyItems(bot);
                    log(bot, `Čreda ${animal.name} ostaja trajnostna; vzel sem eno odraslo žival za hrano.`);
                }
            }
        }
        return true;
    }
    return false;
}

export async function tendFarm(bot, maxWork = 24) {
    const farm = await ensureFarmSite(bot);
    if (!farm) return false;
    if (!await goToFarm(bot, farm)) return false;
    if (await harvestFarm(bot, farm, maxWork)) {
        await tendLivestock(bot, farm);
        return true;
    }
    const state = cropState(bot, farm);
    if (state.empty.length > 0) {
        const planted = await plantFarm(bot, maxWork, farm);
        if (planted) await tendLivestock(bot, farm);
        return planted;
    }
    if (await tendLivestock(bot, farm)) return true;
    log(bot, `Njiva raste (${state.growing}/${farmCellCount(farm)}); pozanjem jo, ko bo psenica zrela.`);
    return true;
}
