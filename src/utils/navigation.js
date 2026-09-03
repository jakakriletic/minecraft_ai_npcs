import { Vec3 } from 'vec3';

const DEFAULT_SAMPLE_MS = 400;
const DEFAULT_STALL_MS = 8_000;
const DEFAULT_NO_PROGRESS_MS = 25_000;
const DEFAULT_MIN_MOVEMENT = 0.75;
const DEFAULT_MIN_GOAL_PROGRESS = 0.5;
const DEFAULT_GOAL_BACKOFF_MS = 5_000;
const MAX_GOAL_BACKOFF_MS = 60_000;
const GOAL_FAILURE_RESET_MS = 2 * 60_000;
const MAX_TRACKED_GOALS = 128;
const goalFailureBackoffs = new WeakMap();

function asVec3(position) {
    if (!position) return null;
    const x = Number(position.x), y = Number(position.y), z = Number(position.z);
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
        ? new Vec3(x, y, z)
        : null;
}

function asNode(position) {
    const pos = asVec3(position);
    return pos ? pos.floored() : null;
}

function hasDynamicTarget(goal) {
    if (!goal) return false;
    if (goal.entity) return true;
    if (goal.goal) return hasDynamicTarget(goal.goal);
    if (Array.isArray(goal.goals)) return goal.goals.some(hasDynamicTarget);
    return false;
}

export function describeNavigationGoal(goal) {
    if (!goal) return 'unknown goal';
    const name = goal.constructor?.name ?? 'Goal';
    if (goal.entity?.username || goal.entity?.name)
        return `${name}(${goal.entity.username ?? goal.entity.name})`;
    if (Number.isFinite(goal.x) && Number.isFinite(goal.z)) {
        const y = Number.isFinite(goal.y) ? `,${Math.floor(goal.y)}` : '';
        return `${name}(${Math.floor(goal.x)}${y},${Math.floor(goal.z)})`;
    }
    if (goal.goal) return `${name}(${describeNavigationGoal(goal.goal)})`;
    return name;
}

export function navigationGoalMetric(goal, position) {
    const node = asNode(position);
    if (!goal || !node) return null;
    try {
        const metric = Number(goal.heuristic?.(node));
        return Number.isFinite(metric) ? metric : null;
    } catch {
        return null;
    }
}

export class NavigationProgressMonitor {
    constructor(goal, position, options = {}) {
        const now = options.now ?? Date.now();
        this.goal = goal;
        this.stallMs = Math.max(250, options.stallMs ?? DEFAULT_STALL_MS);
        this.noProgressMs = Math.max(this.stallMs, options.noProgressMs ?? DEFAULT_NO_PROGRESS_MS);
        this.minMovement = Math.max(0.05, options.minMovement ?? DEFAULT_MIN_MOVEMENT);
        this.minGoalProgress = Math.max(0.05, options.minGoalProgress ?? DEFAULT_MIN_GOAL_PROGRESS);
        this.dynamic = hasDynamicTarget(goal);
        this.anchor = asVec3(position);
        this.lastMovementAt = now;
        this.lastGoalProgressAt = now;
        this.bestMetric = navigationGoalMetric(goal, position);
    }

    observe(position, options = {}) {
        const now = options.now ?? Date.now();
        const pos = asVec3(position);
        if (!pos) return { stalled: true, reason: 'bot position is unavailable' };

        const node = pos.floored();
        try {
            if (this.goal?.isEnd?.(node))
                return { stalled: false, reached: true, metric: 0 };
        } catch { /* malformed or unloaded goal; the pathfinder will report it */ }

        if (!this.anchor || pos.distanceTo(this.anchor) >= this.minMovement) {
            this.anchor = pos;
            this.lastMovementAt = now;
        }

        const metric = navigationGoalMetric(this.goal, pos);
        if (metric != null && (this.bestMetric == null || metric <= this.bestMetric - this.minGoalProgress)) {
            this.bestMetric = metric;
            this.lastGoalProgressAt = now;
        }

        // A hard block may legitimately keep a bot still while it is being mined.
        // Give digging three times the ordinary motion window, then still recover.
        const motionLimit = options.digging ? this.stallMs * 3 : this.stallMs;
        if (now - this.lastMovementAt >= motionLimit) {
            return {
                stalled: true,
                reason: `no meaningful movement for ${Math.round((now - this.lastMovementAt) / 1000)}s`,
                metric,
            };
        }

        // Static goals can also fail by walking in circles. Dynamic follow goals are
        // excluded because their target may be moving away while the bot moves correctly.
        const progressLimit = options.digging ? this.noProgressMs * 3 : this.noProgressMs;
        if (!this.dynamic && metric != null && now - this.lastGoalProgressAt >= progressLimit) {
            return {
                stalled: true,
                reason: `no progress toward the goal for ${Math.round((now - this.lastGoalProgressAt) / 1000)}s`,
                metric,
            };
        }

        return { stalled: false, reached: false, metric };
    }
}

export class NavigationStalledError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NavigationStalledError';
        this.code = 'NAVIGATION_STALLED';
    }
}

export class NavigationTimeoutError extends Error {
    constructor(timeoutMs) {
        super(`Navigation timed out after ${Math.round(timeoutMs / 1000)}s`);
        this.name = 'NavigationTimeoutError';
        this.code = 'NAVIGATION_TIMEOUT';
    }
}

export class NavigationGoalBackoffError extends Error {
    constructor(goal, retryAt, now = Date.now()) {
        const waitMs = Math.max(0, retryAt - now);
        super(`Navigation goal ${describeNavigationGoal(goal)} is cooling down for ${Math.ceil(waitMs / 1000)}s after repeated failures`);
        this.name = 'NavigationGoalBackoffError';
        this.code = 'NAVIGATION_GOAL_BACKOFF';
        this.retryAt = retryAt;
    }
}

/**
 * Run one pathfinder attempt with both a hard deadline and progress checks.
 * `startNavigation` is a function so diagnostics exist before pathfinding begins.
 */
export async function navigateWithWatchdog(bot, goal, startNavigation, options = {}) {
    const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 30_000);
    const sampleMs = Math.max(100, Number(options.sampleMs) || DEFAULT_SAMPLE_MS);
    const startedAt = Date.now();
    const monitor = new NavigationProgressMonitor(goal, bot.entity?.position, {
        now: startedAt,
        stallMs: options.stallMs,
        noProgressMs: options.noProgressMs,
        minMovement: options.minMovement,
        minGoalProgress: options.minGoalProgress,
    });
    const diagnostic = {
        status: 'navigating',
        goal: describeNavigationGoal(goal),
        attempt: Math.max(1, Number(options.attempt) || 1),
        startedAt: new Date(startedAt).toISOString(),
        lastProgressAt: new Date(startedAt).toISOString(),
        bestMetric: monitor.bestMetric,
        reason: null,
    };
    bot._navigationDiagnostics = diagnostic;

    let hardTimer;
    let progressTimer;
    let rejectGuard;
    let guardFinished = false;

    const abort = (error) => {
        if (guardFinished) return;
        guardFinished = true;
        diagnostic.status = error instanceof NavigationStalledError ? 'stalled' : 'timeout';
        diagnostic.reason = error.message;
        diagnostic.endedAt = new Date().toISOString();
        diagnostic.elapsedMs = Date.now() - startedAt;
        rejectGuard(error);
        try { options.onAbort?.(error); } catch { /* recovery is best-effort */ }
    };

    const guard = new Promise((_, reject) => {
        rejectGuard = reject;
        hardTimer = setTimeout(() => abort(new NavigationTimeoutError(timeoutMs)), timeoutMs);
        progressTimer = setInterval(() => {
            const sample = monitor.observe(bot.entity?.position, {
                digging: Boolean(bot.targetDigBlock),
            });
            diagnostic.bestMetric = monitor.bestMetric;
            diagnostic.lastProgressAt = new Date(Math.max(
                monitor.lastMovementAt,
                monitor.lastGoalProgressAt,
            )).toISOString();
            if (sample.stalled)
                abort(new NavigationStalledError(`Navigation stalled: ${sample.reason}`));
        }, sampleMs);
    });

    const navigation = Promise.resolve().then(startNavigation);
    // The watchdog may win the race while pathfinder is unwinding its listeners.
    // Keep that late rejection handled.
    void navigation.catch(() => {});

    try {
        const value = await Promise.race([navigation, guard]);
        guardFinished = true;
        diagnostic.status = 'reached';
        diagnostic.endedAt = new Date().toISOString();
        diagnostic.elapsedMs = Date.now() - startedAt;
        diagnostic.bestMetric = navigationGoalMetric(goal, bot.entity?.position);
        return value;
    } catch (error) {
        guardFinished = true;
        if (diagnostic.status === 'navigating') {
            diagnostic.status = 'failed';
            diagnostic.reason = error?.message ?? String(error);
            diagnostic.endedAt = new Date().toISOString();
            diagnostic.elapsedMs = Date.now() - startedAt;
        }
        throw error;
    } finally {
        clearTimeout(hardTimer);
        clearInterval(progressTimer);
    }
}

export function isRetryableNavigationError(error) {
    return error?.code === 'NAVIGATION_STALLED'
        || error?.code === 'NAVIGATION_TIMEOUT'
        || error?.name === 'NoPath'
        || error?.name === 'Timeout';
}

function navigationGoalFailureKey(goal) {
    return describeNavigationGoal(goal);
}

function pruneGoalFailureBackoffs(backoffs) {
    if (backoffs.size <= MAX_TRACKED_GOALS) return;
    const oldest = [...backoffs.entries()]
        .sort((left, right) => left[1].lastFailureAt - right[1].lastFailureAt)
        .slice(0, backoffs.size - MAX_TRACKED_GOALS);
    for (const [key] of oldest) backoffs.delete(key);
}

export function getNavigationGoalBackoff(bot, goal, now = Date.now()) {
    const entry = goalFailureBackoffs.get(bot)?.get(navigationGoalFailureKey(goal));
    return entry && now < entry.retryAt ? { ...entry } : null;
}

export function recordNavigationGoalFailure(bot, goal, error, options = {}) {
    if (!bot || !isRetryableNavigationError(error)) return null;
    const now = options.now ?? Date.now();
    const baseDelayMs = Math.max(250, options.baseDelayMs ?? DEFAULT_GOAL_BACKOFF_MS);
    const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? MAX_GOAL_BACKOFF_MS);
    let backoffs = goalFailureBackoffs.get(bot);
    if (!backoffs) {
        backoffs = new Map();
        goalFailureBackoffs.set(bot, backoffs);
    }
    const key = navigationGoalFailureKey(goal);
    const previous = backoffs.get(key);
    const failures = previous && now - previous.lastFailureAt <= GOAL_FAILURE_RESET_MS
        ? previous.failures + 1
        : 1;
    const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** (failures - 1)));
    const entry = {
        failures,
        retryAt: now + delayMs,
        lastFailureAt: now,
        reason: error?.message ?? String(error),
    };
    backoffs.set(key, entry);
    pruneGoalFailureBackoffs(backoffs);
    return { ...entry };
}

export function clearNavigationGoalFailure(bot, goal) {
    const backoffs = goalFailureBackoffs.get(bot);
    if (!backoffs) return;
    backoffs.delete(navigationGoalFailureKey(goal));
    if (backoffs.size === 0) goalFailureBackoffs.delete(bot);
}
