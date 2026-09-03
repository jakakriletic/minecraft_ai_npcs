// Movement wrapper around mineflayer-pathfinder with timeout/retry,
// so a bot never hangs forever on an unreachable goal.
import pkg from 'mineflayer-pathfinder';
const { goals, Movements } = pkg;
import { isRetryableNavigationError, navigateWithWatchdog } from '../../utils/navigation.js';

const GOTO_TIMEOUT_MS = 25_000;
const MAX_RETRIES = 1;
const STALL_TIMEOUT_MS = 8_000;
const NO_PROGRESS_TIMEOUT_MS = 24_000;
const BASE_ENTITY_COST = 4;

export function setupMovement(bot) {
    const movements = new Movements(bot);
    movements.canDig = false; // phase 1: never dig through terrain while commuting
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.scafoldingBlocks = [];
    movements.liquidCost = 25;
    movements.infiniteLiquidDropdownDistance = false;
    movements.maxDropDown = Math.min(movements.maxDropDown, 3);
    movements.entityCost = BASE_ENTITY_COST;
    bot.pathfinder.setMovements(movements);
    // Bound A* work per NPC. Partial searches continue on later physics ticks, while
    // unreachable goals stop consuming several seconds of CPU across all ten bots.
    bot.pathfinder.searchRadius = 128;
    bot.pathfinder.thinkTimeout = 3_000;
}

// Returns true if bot is inside the region (horizontal distance to center <= radius).
export function isInRegion(bot, region) {
    const p = bot.entity.position;
    const c = region.center;
    const dx = p.x - c.x, dz = p.z - c.z;
    return dx * dx + dz * dz <= region.radius * region.radius;
}

// Walk into a region. Resolves true on arrival, false if all retries failed.
export async function gotoRegion(bot, region, log) {
    if (isInRegion(bot, region)) return true;
    const c = region.center;
    const goal = new goals.GoalNear(c.x, c.y, c.z, Math.max(2, region.radius - 1));
    const distance = horizontalDistance(bot.entity.position, c);
    // A fixed 25 s timeout cut off legitimate 60-100 block commutes. Keep the
    // quick minimum for local trips and scale only the hard ceiling by distance;
    // the progress watchdog still aborts a genuinely stuck bot in ~8 s.
    const timeoutMs = Math.min(75_000, Math.max(GOTO_TIMEOUT_MS, 12_000 + distance * 750));
    const reached = await navigateWithRetries(bot, goal, log, timeoutMs,
        `goto (${c.x},${c.y},${c.z})`);
    return reached && isInRegion(bot, region);
}

// Walk to a specific position (e.g. the admin, a dropped item). Timeout-guarded.
export async function gotoNear(bot, pos, range, log, timeoutMs = 30_000) {
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    const goal = new goals.GoalNear(x, y, z, range);
    return await navigateWithRetries(bot, goal, log, timeoutMs, `gotoNear (${x},${y},${z})`);
}

async function navigateWithRetries(bot, goal, log, timeoutMs, label) {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
        try {
            if (bot.pathfinder.movements)
                bot.pathfinder.movements.entityCost = attempt === 1 ? BASE_ENTITY_COST : 8;
            await navigateWithWatchdog(bot, goal, () => bot.pathfinder.goto(goal), {
                timeoutMs,
                stallMs: Math.min(STALL_TIMEOUT_MS, Math.max(3_000, timeoutMs - 1_000)),
                noProgressMs: Math.min(NO_PROGRESS_TIMEOUT_MS, Math.max(6_000, timeoutMs - 1_000)),
                attempt,
                onAbort: () => bot.pathfinder.stop(),
            });
            return true;
        } catch (error) {
            lastError = error;
            log?.warn?.(`${label} attempt ${attempt} failed: ${error.message}`);
            bot.pathfinder.stop();
            if (attempt > MAX_RETRIES || !isRetryableNavigationError(error)) break;
            await sleep(350);
        }
    }
    if (bot._navigationDiagnostics && lastError)
        bot._navigationDiagnostics.reason = lastError.message;
    return false;
}

function horizontalDistance(a, b) {
    const dx = a.x - b.x, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
