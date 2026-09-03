// Deterministic settlement roads. Registered schematic buildings are connected
// to the public storage (or the oldest building) with terrain-following dirt paths
// and public lighting. One cross-process lock prevents five builders racing.
import { existsSync, readFileSync } from 'fs';
import { Vec3 } from 'vec3';
import * as storage from './storage.js';
import * as skills from './skills.js';
import * as society from './society.js';
import * as mc from '../../utils/mcdata.js';
import { getProtectedBuilds, isPositionProtected } from './resource_guard.js';
import { withNamedLock } from './container_lock.js';
import settings from '../../../settings.js';
import { writeJsonAtomic } from '../../utils/atomic_json.js';

const ROAD_FILE = './bots/kingdom-roads.json';
const TOWN_PLAN_FILE = './bots/town-plan.json';
const MAX_ROAD_LENGTH = 110;
const MAX_ROUTE_LENGTH = Math.max(MAX_ROAD_LENGTH, settings.kingdom_road_max_route_length ?? 140);
const ROAD_SEARCH_MARGIN = Math.max(8, settings.kingdom_road_search_margin ?? 14);
const MAX_ROUTE_SEARCH_NODES = Math.max(500, settings.kingdom_road_search_nodes ?? 9000);
const ROAD_COMMAND_DELAY_MS = Math.max(20,
    settings.kingdom_road_command_delay_ms ?? settings.build_command_delay_ms ?? 75);
const ROAD_MOVE_STRIDE = Math.max(6, settings.kingdom_road_move_stride ?? 12);
const ROAD_COMPLETE_RATIO = Math.min(0.95,
    Math.max(0.55, settings.kingdom_road_complete_ratio ?? 0.8));
const ROAD_STALL_LIMIT = Math.max(1, settings.kingdom_road_stall_limit ?? 3);
const TOWN_ROAD_HALF_WIDTH = Math.max(1, settings.town_road_half_width ?? 1);
const TOWN_ROAD_MARGIN = Math.max(6, settings.town_road_margin ?? 10);
const TOWN_PLAZA_SHAPE = String(settings.town_plaza_shape ?? 'meeting').toLowerCase();
const TOWN_PLAZA_RADIUS = Math.max(3, settings.town_plaza_radius ?? 6);
const TOWN_PLAZA_CORE_RADIUS = Math.min(
    TOWN_PLAZA_RADIUS,
    Math.max(1, settings.town_plaza_core_radius ?? 3),
);
const TOWN_ROAD_COMPLETE_RATIO = Math.min(0.95,
    Math.max(0.45, settings.town_road_complete_ratio ?? 0.68));
const PATHABLE_GROUND = new Set([
    'grass_block', 'grass', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol',
    'mycelium', 'dirt_path', 'grass_path', 'gravel', 'sand', 'red_sand', 'stone',
    'andesite', 'diorite', 'granite', 'tuff', 'cobblestone',
]);
const SHOVEL_GROUND = new Set([
    'grass_block', 'grass', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
]);
const EMPTY = new Set([
    'air', 'cave_air', 'void_air', 'short_grass', 'tallgrass', 'tall_grass',
    'fern', 'large_fern', 'snow', 'dead_bush', 'dandelion', 'poppy',
    'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower',
    'lily_of_the_valley',
]);
const CLEARABLE = new Set([...EMPTY].filter(name => !['air', 'cave_air', 'void_air'].includes(name)));

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function emptyRoadState() {
    return { version: 1, roads: [], updatedAt: null };
}

function readRoadState() {
    try {
        if (existsSync(ROAD_FILE))
            return { ...emptyRoadState(), ...JSON.parse(readFileSync(ROAD_FILE, 'utf8')) };
    } catch (error) {
        console.warn(`[roads] could not read state: ${error.message}`);
    }
    return emptyRoadState();
}

function readTownPlan() {
    try {
        if (existsSync(TOWN_PLAN_FILE)) return JSON.parse(readFileSync(TOWN_PLAN_FILE, 'utf8'));
    } catch (error) {
        console.warn(`[roads] could not read town plan: ${error.message}`);
    }
    return null;
}

function writeRoadState(state) {
    state.updatedAt = new Date().toISOString();
    writeJsonAtomic(ROAD_FILE, state);
}

function nodePoint(node, toward) {
    if (!node.build) return new Vec3(node.x, node.y, node.z);
    const build = node.build;
    const centerX = (build.min.x + build.max.x) / 2;
    const centerZ = (build.min.z + build.max.z) / 2;
    const dx = toward.x - centerX;
    const dz = toward.z - centerZ;
    if (Math.abs(dx) >= Math.abs(dz)) {
        return new Vec3(
            dx < 0 ? build.min.x - 3 : build.max.x + 3,
            build.min.y,
            Math.floor(centerZ),
        );
    }
    return new Vec3(
        Math.floor(centerX),
        build.min.y,
        dz < 0 ? build.min.z - 3 : build.max.z + 3,
    );
}

function settlementNodes(bot) {
    const buildings = getProtectedBuilds(bot)
        .filter(build => {
            const volume = (build.max.x - build.min.x + 1)
                * (build.max.y - build.min.y + 1)
                * (build.max.z - build.min.z + 1);
            return volume >= 20;
        })
        .map(build => ({
            id: build.id,
            label: build.name,
            x: Math.floor((build.min.x + build.max.x) / 2),
            y: build.min.y,
            z: Math.floor((build.min.z + build.max.z) / 2),
            build,
            createdAt: build.createdAt,
        }));
    const shared = storage.getPublicStorage(bot);
    if (shared) {
        buildings.unshift({
            id: `storage:${shared.dimension}:${shared.x},${shared.y},${shared.z}`,
            label: 'javni storage',
            x: shared.x,
            y: shared.y,
            z: shared.z,
            priority: true,
        });
    }
    return buildings;
}

function normalizedRoadId(a, b) {
    return [a.id, b.id].sort().join('=>');
}

function nextRoadProject(bot, state = readRoadState()) {
    const nodes = settlementNodes(bot);
    if (nodes.length < 2) return null;
    const hub = nodes.find(node => node.priority)
        ?? [...nodes].sort((a, b) => Date.parse(a.createdAt ?? 0) - Date.parse(b.createdAt ?? 0))[0];
    const completed = new Set(state.roads.filter(road => road.status === 'complete').map(road => road.id));
    const recentlyBlocked = new Set(state.roads
        .filter(road => road.status === 'blocked'
            && Date.now() - Date.parse(road.attemptedAt ?? road.builtAt ?? 0) < 30 * 60_000)
        .map(road => road.id));
    const candidates = nodes
        .filter(node => node.id !== hub.id)
        .map(node => ({
            hub,
            target: node,
            id: normalizedRoadId(hub, node),
            distance: Math.hypot(node.x - hub.x, node.z - hub.z),
        }))
        .filter(project => !completed.has(project.id) && !recentlyBlocked.has(project.id)
            && project.distance >= 8 && project.distance <= MAX_ROAD_LENGTH)
        .sort((a, b) => a.distance - b.distance);
    return candidates[0] ?? null;
}

function planDimensionMatches(bot, plan) {
    if (!plan?.active || !plan.center) return false;
    const dimension = String(bot.game?.dimension ?? 'world');
    return String(plan.center.dimension ?? dimension) === dimension;
}

function plotGridCoordinate(plot, axis) {
    const gridKey = axis === 'x' ? 'gridX' : 'gridZ';
    return Math.floor(Number(plot[gridKey] ?? plot[axis]));
}

function townGrid(plan) {
    const plots = (plan.plots ?? [])
        .map(plot => {
            const match = /^plot_(-?\d+)_(-?\d+)$/.exec(String(plot.id ?? ''));
            if (!match) return null;
            return {
                i: Number(match[1]),
                j: Number(match[2]),
                x: plotGridCoordinate(plot, 'x'),
                z: plotGridCoordinate(plot, 'z'),
            };
        })
        .filter(Boolean);
    if (plots.length < 4) return null;
    const xByI = new Map();
    const zByJ = new Map();
    for (const plot of plots) {
        if (!xByI.has(plot.i)) xByI.set(plot.i, []);
        if (!zByJ.has(plot.j)) zByJ.set(plot.j, []);
        xByI.get(plot.i).push(plot.x);
        zByJ.get(plot.j).push(plot.z);
    }
    const medianNumber = values => values
        .slice()
        .sort((a, b) => a - b)[Math.floor(values.length / 2)];
    return {
        xs: [...xByI.entries()].sort((a, b) => a[0] - b[0])
            .map(([i, values]) => ({ i, x: medianNumber(values) })),
        zs: [...zByJ.entries()].sort((a, b) => a[0] - b[0])
            .map(([j, values]) => ({ j, z: medianNumber(values) })),
    };
}

function areaCells(minX, maxX, minZ, maxZ) {
    const cells = [];
    for (let x = Math.floor(minX); x <= Math.floor(maxX); x++)
        for (let z = Math.floor(minZ); z <= Math.floor(maxZ); z++)
            cells.push({ x, z });
    return cells;
}

function plazaCells(center) {
    if (TOWN_PLAZA_SHAPE === 'square' || TOWN_PLAZA_SHAPE === 'filled')
        return areaCells(
            center.x - TOWN_PLAZA_RADIUS,
            center.x + TOWN_PLAZA_RADIUS,
            center.z - TOWN_PLAZA_RADIUS,
            center.z + TOWN_PLAZA_RADIUS,
        );

    const cells = [];
    for (let dx = -TOWN_PLAZA_RADIUS; dx <= TOWN_PLAZA_RADIUS; dx++) {
        for (let dz = -TOWN_PLAZA_RADIUS; dz <= TOWN_PLAZA_RADIUS; dz++) {
            const absX = Math.abs(dx);
            const absZ = Math.abs(dz);
            const inCore = absX <= TOWN_PLAZA_CORE_RADIUS && absZ <= TOWN_PLAZA_CORE_RADIUS;
            const inCrossArm = absX <= TOWN_ROAD_HALF_WIDTH || absZ <= TOWN_ROAD_HALF_WIDTH;
            const inFrame = TOWN_PLAZA_SHAPE === 'frame'
                && (absX === TOWN_PLAZA_RADIUS || absZ === TOWN_PLAZA_RADIUS);
            if (inCore || inCrossArm || inFrame)
                cells.push({ x: center.x + dx, z: center.z + dz });
        }
    }
    return cells;
}

function townRoadProjectId(plan, label) {
    const center = plan.center;
    return `town-grid:${center.dimension ?? 'world'}:${center.x},${center.z}:${label}`;
}

function plannedTownRoadProjects(bot, state = readRoadState()) {
    const plan = readTownPlan();
    if (!planDimensionMatches(bot, plan)) return [];
    const grid = townGrid(plan);
    if (!grid || grid.xs.length < 2 || grid.zs.length < 2) return [];

    const center = plan.center;
    const completed = new Set(state.roads.filter(road => road.status === 'complete').map(road => road.id));
    const recentlyBlocked = new Set(state.roads
        .filter(road => road.status === 'blocked'
            && Date.now() - Date.parse(road.attemptedAt ?? road.builtAt ?? 0) < 10 * 60_000)
        .map(road => road.id));
    const projects = [];
    projects.push({
        id: townRoadProjectId(plan, 'plaza'),
        type: 'town-grid',
        label: 'centralni trg',
        fromLabel: 'town plan',
        toLabel: 'centralni trg',
        axis: 'area',
        y: center.y,
        cells: plazaCells(center),
        start: new Vec3(center.x, center.y, center.z),
    });

    const zMin = grid.zs[0].z - TOWN_ROAD_MARGIN;
    const zMax = grid.zs[grid.zs.length - 1].z + TOWN_ROAD_MARGIN;
    for (let index = 0; index < grid.xs.length - 1; index++) {
        const x = Math.floor((grid.xs[index].x + grid.xs[index + 1].x) / 2);
        const cells = lineCells(new Vec3(x, center.y, zMin), new Vec3(x, center.y, zMax));
        projects.push({
            id: townRoadProjectId(plan, `north-south-${index}`),
            type: 'town-grid',
            label: `ulica sever-jug ${index + 1}`,
            fromLabel: 'town plan',
            toLabel: `ulica sever-jug ${index + 1}`,
            axis: 'z',
            y: center.y,
            cells,
            start: new Vec3(x, center.y, zMin),
        });
    }

    const xMin = grid.xs[0].x - TOWN_ROAD_MARGIN;
    const xMax = grid.xs[grid.xs.length - 1].x + TOWN_ROAD_MARGIN;
    for (let index = 0; index < grid.zs.length - 1; index++) {
        const z = Math.floor((grid.zs[index].z + grid.zs[index + 1].z) / 2);
        const cells = lineCells(new Vec3(xMin, center.y, z), new Vec3(xMax, center.y, z));
        projects.push({
            id: townRoadProjectId(plan, `east-west-${index}`),
            type: 'town-grid',
            label: `ulica vzhod-zahod ${index + 1}`,
            fromLabel: 'town plan',
            toLabel: `ulica vzhod-zahod ${index + 1}`,
            axis: 'x',
            y: center.y,
            cells,
            start: new Vec3(xMin, center.y, z),
        });
    }

    return projects
        .filter(project => !completed.has(project.id) && !recentlyBlocked.has(project.id))
        .sort((a, b) => {
            if (a.axis === 'area' && b.axis !== 'area') return -1;
            if (b.axis === 'area' && a.axis !== 'area') return 1;
            return Math.abs(a.start.x - center.x) + Math.abs(a.start.z - center.z)
                - (Math.abs(b.start.x - center.x) + Math.abs(b.start.z - center.z));
        });
}

function nextTownPlanRoadProject(bot, state = readRoadState()) {
    return plannedTownRoadProjects(bot, state)[0] ?? null;
}

export function needsTownPlanRoads(bot) {
    return settings.kingdom_roads !== false && Boolean(nextTownPlanRoadProject(bot));
}

export function needsRoad(bot) {
    return settings.kingdom_roads !== false && (Boolean(nextTownPlanRoadProject(bot)) || Boolean(nextRoadProject(bot)));
}

function lineCells(from, to) {
    const cells = [];
    let x0 = Math.floor(from.x);
    let z0 = Math.floor(from.z);
    const x1 = Math.floor(to.x);
    const z1 = Math.floor(to.z);
    const dx = Math.abs(x1 - x0);
    const dz = Math.abs(z1 - z0);
    const sx = x0 < x1 ? 1 : -1;
    const sz = z0 < z1 ? 1 : -1;
    let error = dx - dz;
    while (true) {
        cells.push({ x: x0, z: z0 });
        if (x0 === x1 && z0 === z1) break;
        const twice = 2 * error;
        if (twice > -dz) { error -= dz; x0 += sx; }
        if (twice < dx) { error += dx; z0 += sz; }
    }
    return cells;
}

function combineLines(...lines) {
    const cells = [];
    const seen = new Set();
    for (const line of lines)
        for (const cell of line) {
            const key = `${cell.x},${cell.z}`;
            if (seen.has(key)) continue;
            seen.add(key);
            cells.push(cell);
        }
    return cells;
}

function routeCandidates(from, to) {
    const cornerA = new Vec3(to.x, from.y, from.z);
    const cornerB = new Vec3(from.x, from.y, to.z);
    return [
        lineCells(from, to),
        combineLines(lineCells(from, cornerA), lineCells(cornerA, to)),
        combineLines(lineCells(from, cornerB), lineCells(cornerB, to)),
    ];
}

function findSurface(bot, x, z, anchorGroundY) {
    const anchor = Math.floor(anchorGroundY);
    for (let offset = 5; offset >= -7; offset--) {
        const y = anchor + offset;
        const ground = bot.blockAt(new Vec3(x, y, z));
        const above = bot.blockAt(new Vec3(x, y + 1, z));
        const head = bot.blockAt(new Vec3(x, y + 2, z));
        if (!ground || !above || !head || !PATHABLE_GROUND.has(ground.name)) continue;
        if (!EMPTY.has(above.name) || !EMPTY.has(head.name)) continue;
        return ground;
    }
    return null;
}

function evaluateRoute(bot, cells, startY) {
    if (cells.length < 2 || cells.length > MAX_ROUTE_LENGTH) return null;
    const route = [];
    let previousY = Math.floor(startY) - 1;
    let score = cells.length;
    for (const cell of cells) {
        const ground = findSurface(bot, cell.x, cell.z, previousY);
        if (!ground || isPositionProtected(bot, ground.position, 1)) return null;
        const slope = Math.abs(ground.position.y - previousY);
        if (slope > 1) return null;
        score += slope * 8;
        if (!SHOVEL_GROUND.has(ground.name) && !mc.blockMatchesName(ground, 'dirt_path', bot)) score += 3;
        route.push({ x: cell.x, y: ground.position.y, z: cell.z });
        previousY = ground.position.y;
    }
    return { route, score };
}

function routeKey(x, z) {
    return `${x},${z}`;
}

function reconstructRoute(node) {
    const route = [];
    let cursor = node;
    while (cursor) {
        route.push({ x: cursor.x, y: cursor.y, z: cursor.z });
        cursor = cursor.parent;
    }
    return route.reverse();
}

function roadSurfaceCost(name) {
    if (name === 'dirt_path' || name === 'grass_path') return 0.2;
    if (SHOVEL_GROUND.has(name)) return 1;
    if (PATHABLE_GROUND.has(name)) return 2.5;
    return 8;
}

function searchRoute(bot, from, to) {
    const startX = Math.floor(from.x);
    const startZ = Math.floor(from.z);
    const targetX = Math.floor(to.x);
    const targetZ = Math.floor(to.z);
    const minX = Math.min(startX, targetX) - ROAD_SEARCH_MARGIN;
    const maxX = Math.max(startX, targetX) + ROAD_SEARCH_MARGIN;
    const minZ = Math.min(startZ, targetZ) - ROAD_SEARCH_MARGIN;
    const maxZ = Math.max(startZ, targetZ) + ROAD_SEARCH_MARGIN;
    const startGround = findSurface(bot, startX, startZ, from.y);
    if (!startGround || isPositionProtected(bot, startGround.position, 1)) return null;

    const start = {
        x: startX,
        y: startGround.position.y,
        z: startZ,
        g: 0,
        f: Math.abs(targetX - startX) + Math.abs(targetZ - startZ),
        parent: null,
    };
    const open = [start];
    const best = new Map([[routeKey(start.x, start.z), start]]);
    const closed = new Set();
    let expanded = 0;
    const directions = [
        { x: 1, z: 0 },
        { x: -1, z: 0 },
        { x: 0, z: 1 },
        { x: 0, z: -1 },
    ];

    while (open.length && expanded < MAX_ROUTE_SEARCH_NODES) {
        let bestIndex = 0;
        for (let index = 1; index < open.length; index++)
            if (open[index].f < open[bestIndex].f) bestIndex = index;
        const current = open.splice(bestIndex, 1)[0];
        const key = routeKey(current.x, current.z);
        if (closed.has(key)) continue;
        closed.add(key);
        expanded++;

        if (current.x === targetX && current.z === targetZ) {
            const route = reconstructRoute(current);
            if (route.length < 2 || route.length > MAX_ROUTE_LENGTH) return null;
            return { route, score: current.g, searched: true };
        }

        for (const direction of directions) {
            const x = current.x + direction.x;
            const z = current.z + direction.z;
            if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
            const nextKey = routeKey(x, z);
            if (closed.has(nextKey)) continue;
            const ground = findSurface(bot, x, z, current.y);
            if (!ground || isPositionProtected(bot, ground.position, 1)) continue;
            const slope = Math.abs(ground.position.y - current.y);
            if (slope > 1) continue;
            const stepCost = 1 + slope * 8 + roadSurfaceCost(ground.name);
            const g = current.g + stepCost;
            const existing = best.get(nextKey);
            if (existing && existing.g <= g) continue;
            const heuristic = Math.abs(targetX - x) + Math.abs(targetZ - z);
            const next = {
                x,
                y: ground.position.y,
                z,
                g,
                f: g + heuristic,
                parent: current,
            };
            best.set(nextKey, next);
            open.push(next);
        }
    }
    return null;
}

function bestRoute(bot, from, to) {
    const simple = routeCandidates(from, to)
        .map(cells => evaluateRoute(bot, cells, from.y))
        .filter(Boolean);
    if (simple.length > 0)
        return simple.sort((a, b) => a.score - b.score)[0];
    return searchRoute(bot, from, to);
}

async function placeRoadLight(bot, point, previous, index) {
    if (index === 0 || index % 8 !== 0) return false;
    const dx = point.x - (previous?.x ?? point.x - 1);
    const dz = point.z - (previous?.z ?? point.z);
    const sides = dx !== 0
        ? [{ x: 0, z: 1 }, { x: 0, z: -1 }]
        : [{ x: 1, z: 0 }, { x: -1, z: 0 }];
    for (const side of sides) {
        const sideGround = findSurface(bot, point.x + side.x, point.z + side.z, point.y);
        if (!sideGround || isPositionProtected(bot, sideGround.position, 0)) continue;
        const target = sideGround.position.offset(0, 1, 0);
        if (!EMPTY.has(bot.blockAt(target)?.name)) continue;
        bot.chat(mc.setBlockCommand(target.x, target.y, target.z, 'torch', bot));
        await sleep(ROAD_COMMAND_DELAY_MS);
        if (bot.blockAt(target, false)?.name === 'torch') return true;
    }
    return false;
}

async function buildRoute(bot, route) {
    let pathBlocks = 0;
    let lights = 0;
    for (let index = 0; index < route.length && !bot.interrupt_code; index++) {
        const point = route[index];
        if (index % ROAD_MOVE_STRIDE === 0
            && !await skills.goToPosition(bot, point.x, point.y + 1, point.z, 4))
            continue;
        let ground = bot.blockAt(new Vec3(point.x, point.y, point.z));
        const above = bot.blockAt(new Vec3(point.x, point.y + 1, point.z));
        if (!ground || !above) continue;
        if (CLEARABLE.has(above.name)) {
            bot.chat(mc.setBlockCommand(above.position.x, above.position.y, above.position.z, 'air', bot));
            await sleep(ROAD_COMMAND_DELAY_MS);
            ground = bot.blockAt(new Vec3(point.x, point.y, point.z));
        }
        if (mc.blockMatchesName(ground, 'dirt_path', bot)) {
            pathBlocks++;
        } else if (ground && PATHABLE_GROUND.has(ground.name)) {
            try {
                bot.chat(mc.setBlockCommand(ground.position.x, ground.position.y, ground.position.z, 'dirt_path', bot));
                await sleep(ROAD_COMMAND_DELAY_MS);
                if (mc.blockMatchesName(bot.blockAt(ground.position), 'dirt_path', bot)) pathBlocks++;
            } catch { /* retry on next maintenance pass */ }
        }
        if (await placeRoadLight(bot, point, route[index - 1], index)) lights++;
    }
    return { pathBlocks, lights };
}

function expandedTownRoadCells(project) {
    const cells = [];
    const seen = new Set();
    const add = (x, z) => {
        const key = `${x},${z}`;
        if (seen.has(key)) return;
        seen.add(key);
        cells.push({ x, z });
    };
    for (const cell of project.cells) {
        if (project.axis === 'z') {
            for (let dx = -TOWN_ROAD_HALF_WIDTH; dx <= TOWN_ROAD_HALF_WIDTH; dx++)
                add(cell.x + dx, cell.z);
        } else if (project.axis === 'x') {
            for (let dz = -TOWN_ROAD_HALF_WIDTH; dz <= TOWN_ROAD_HALF_WIDTH; dz++)
                add(cell.x, cell.z + dz);
        } else {
            add(cell.x, cell.z);
        }
    }
    return cells;
}

function findLooseRoadSurface(bot, x, z, anchorY) {
    const anchor = Math.floor(anchorY);
    for (let offset = 10; offset >= -14; offset--) {
        const y = anchor + offset;
        const ground = bot.blockAt(new Vec3(x, y, z));
        if (!ground || !PATHABLE_GROUND.has(ground.name)) continue;
        if (isPositionProtected(bot, ground.position, 0)) continue;
        return ground;
    }
    return null;
}

async function clearRoadColumn(bot, ground) {
    for (const dy of [1, 2]) {
        const block = bot.blockAt(ground.position.offset(0, dy, 0));
        if (!block || !CLEARABLE.has(block.name)) continue;
        bot.chat(mc.setBlockCommand(block.position.x, block.position.y, block.position.z, 'air', bot));
        await sleep(ROAD_COMMAND_DELAY_MS);
    }
}

async function buildTownPlanRoad(bot, project) {
    const cells = expandedTownRoadCells(project);
    let pathBlocks = 0;
    let lights = 0;
    let skipped = 0;
    try {
        await skills.goToPosition(bot, project.start.x, project.start.y, project.start.z, 8);
    } catch {
        // Commands can still work if chunks are loaded by another nearby bot/player.
    }

    let previousCenter = null;
    for (let index = 0; index < cells.length && !bot.interrupt_code; index++) {
        const cell = cells[index];
        if (index % ROAD_MOVE_STRIDE === 0) {
            try { await skills.goToPosition(bot, cell.x, project.y, cell.z, 8); }
            catch { /* keep issuing safe commands for loaded chunks */ }
        }
        const ground = findLooseRoadSurface(bot, cell.x, cell.z, project.y);
        if (!ground) {
            skipped++;
            continue;
        }
        await clearRoadColumn(bot, ground);
        if (mc.blockMatchesName(ground, 'dirt_path', bot)) {
            pathBlocks++;
        } else {
            bot.chat(mc.setBlockCommand(ground.position.x, ground.position.y, ground.position.z, 'dirt_path', bot));
            await sleep(ROAD_COMMAND_DELAY_MS);
            if (mc.blockMatchesName(bot.blockAt(ground.position, false), 'dirt_path', bot)) pathBlocks++;
        }
    }

    if (project.axis !== 'area') {
        for (let index = 0; index < project.cells.length && !bot.interrupt_code; index += 9) {
            const cell = project.cells[index];
            const ground = findLooseRoadSurface(bot, cell.x, cell.z, project.y);
            if (!ground) continue;
            const point = { x: cell.x, y: ground.position.y, z: cell.z };
            if (await placeRoadLight(bot, point, previousCenter, index)) lights++;
            previousCenter = point;
        }
    }

    return { pathBlocks, lights, skipped, total: cells.length };
}

function upsertRoadState(state, road) {
    state.roads = [...state.roads.filter(existing => existing.id !== road.id), road];
    writeRoadState(state);
}

export async function maintainRoadNetwork(bot) {
    if (settings.kingdom_roads === false) return false;
    const result = await withNamedLock(bot, 'kingdom-road-builder', async () => {
        const state = readRoadState();
        const townProject = nextTownPlanRoadProject(bot, state);
        if (townProject) {
            const built = await buildTownPlanRoad(bot, townProject);
            const completionRatio = built.pathBlocks / Math.max(1, built.total);
            const previous = state.roads.find(existing => existing.id === townProject.id);
            const madeProgress = !previous
                || built.pathBlocks > (previous.pathBlocks ?? 0)
                || built.lights > (previous.lights ?? 0);
            const stalls = madeProgress ? 0 : (previous?.stalls ?? 0) + 1;
            const road = {
                id: townProject.id,
                from: townProject.fromLabel,
                to: townProject.toLabel,
                fromLabel: townProject.fromLabel,
                toLabel: townProject.toLabel,
                status: completionRatio >= TOWN_ROAD_COMPLETE_RATIO
                    ? 'complete'
                    : built.pathBlocks > 0 && stalls < ROAD_STALL_LIMIT
                        ? 'partial'
                        : 'blocked',
                type: 'town-grid',
                label: townProject.label,
                length: built.total,
                pathBlocks: built.pathBlocks,
                lights: built.lights,
                skipped: built.skipped,
                stalls,
                route: 'town-plan-grid',
                builtBy: bot.username,
                builtAt: new Date().toISOString(),
                attemptedBy: bot.username,
                attemptedAt: new Date().toISOString(),
            };
            upsertRoadState(state, road);
            if (road.status === 'complete') {
                skills.log(bot, `Uredil mestno ulico: ${townProject.label} (${road.pathBlocks} poti, ${road.lights} luci).`);
                return true;
            }
            if (road.status === 'blocked') {
                skills.log(bot, `Mestna ulica ${townProject.label} je blokirana (${road.pathBlocks}/${road.length}).`);
                return false;
            }
            skills.log(bot, `Mestna ulica ${townProject.label} je delno urejena.`);
            return road.pathBlocks > 0 || road.lights > 0;
        }

        const project = nextRoadProject(bot, state);
        if (!project) return false;
        const roughHub = new Vec3(project.hub.x, project.hub.y, project.hub.z);
        const roughTarget = new Vec3(project.target.x, project.target.y, project.target.z);
        const from = nodePoint(project.hub, roughTarget);
        const to = nodePoint(project.target, roughHub);
        if (!await skills.goToPosition(bot, from.x, from.y, from.z, 5)) return false;

        const evaluated = bestRoute(bot, from, to);
        if (!evaluated) {
            upsertRoadState(state, {
                id: project.id,
                from: project.hub.id,
                to: project.target.id,
                fromLabel: project.hub.label,
                toLabel: project.target.label,
                status: 'blocked',
                attemptedBy: bot.username,
                attemptedAt: new Date().toISOString(),
            });
            return false;
        }

        const built = await buildRoute(bot, evaluated.route);
        const completionRatio = built.pathBlocks / evaluated.route.length;
        const previous = state.roads.find(existing => existing.id === project.id);
        const madeProgress = !previous
            || built.pathBlocks > (previous.pathBlocks ?? 0)
            || built.lights > (previous.lights ?? 0);
        const stalls = madeProgress ? 0 : (previous?.stalls ?? 0) + 1;
        const road = {
            id: project.id,
            from: project.hub.id,
            to: project.target.id,
            fromLabel: project.hub.label,
            toLabel: project.target.label,
            status: completionRatio >= ROAD_COMPLETE_RATIO
                ? 'complete'
                : (built.pathBlocks > 0 || built.lights > 0) && stalls < ROAD_STALL_LIMIT
                    ? 'partial'
                    : 'blocked',
            length: evaluated.route.length,
            pathBlocks: built.pathBlocks,
            lights: built.lights,
            stalls,
            route: evaluated.searched ? 'surface-search' : 'simple',
            builtBy: bot.username,
            builtAt: new Date().toISOString(),
            attemptedBy: bot.username,
            attemptedAt: new Date().toISOString(),
        };
        upsertRoadState(state, road);
        if (road.status === 'complete') {
            await society.noteRoadCompleted(bot, bot.username, {
                ...road,
                totalRoads: state.roads.filter(existing => existing.status === 'complete').length,
            });
            skills.log(bot, `Uredil pot ${road.fromLabel} - ${road.toLabel} (${road.pathBlocks} poti, ${road.lights} luci).`);
            return true;
        }
        if (road.status === 'blocked') {
            skills.log(bot, `Pot ${road.fromLabel} - ${road.toLabel} je blokirana (${road.pathBlocks}/${road.length}).`);
            return false;
        }
        skills.log(bot, `Pot ${road.fromLabel} - ${road.toLabel} je delno urejena.`);
        return built.pathBlocks > 0 || built.lights > 0;
    }, 180_000);
    return result.locked && result.value;
}

export function roadSummary() {
    const roads = readRoadState().roads;
    return {
        complete: roads.filter(road => road.status === 'complete').length,
        partial: roads.filter(road => road.status === 'partial').length,
        blocked: roads.filter(road => road.status === 'blocked').length,
        townGridComplete: roads.filter(road => road.type === 'town-grid' && road.status === 'complete').length,
        townGridPending: plannedTownRoadProjects({ game: { dimension: readTownPlan()?.center?.dimension ?? 'world' } }).length,
    };
}
