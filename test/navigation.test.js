import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Vec3 } from 'vec3';
import {
    NavigationProgressMonitor,
    NavigationGoalBackoffError,
    NavigationStalledError,
    clearNavigationGoalFailure,
    describeNavigationGoal,
    getNavigationGoalBackoff,
    isRetryableNavigationError,
    navigateWithWatchdog,
    navigationGoalMetric,
    recordNavigationGoalFailure,
} from '../src/utils/navigation.js';

class StaticGoal {
    constructor(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    heuristic(node) {
        return Math.abs(this.x - node.x) + Math.abs(this.y - node.y) + Math.abs(this.z - node.z);
    }

    isEnd(node) {
        return this.heuristic(node) === 0;
    }
}

describe('navigation progress watchdog', () => {
    test('measures and describes a static goal', () => {
        const goal = new StaticGoal(10, 64, -4);
        assert.equal(navigationGoalMetric(goal, new Vec3(7, 64, -4)), 3);
        assert.equal(describeNavigationGoal(goal), 'StaticGoal(10,64,-4)');
    });

    test('small collision jitter does not hide a physical stall', () => {
        const monitor = new NavigationProgressMonitor(
            new StaticGoal(10, 64, 0),
            new Vec3(0, 64, 0),
            { now: 0, stallMs: 1_000, noProgressMs: 5_000, minMovement: 0.75 },
        );
        assert.equal(monitor.observe(new Vec3(0.2, 64, 0.1), { now: 900 }).stalled, false);
        const result = monitor.observe(new Vec3(0.1, 64, -0.1), { now: 1_100 });
        assert.equal(result.stalled, true);
        assert.match(result.reason, /no meaningful movement/);
    });

    test('meaningful movement resets the motion deadline', () => {
        const monitor = new NavigationProgressMonitor(
            new StaticGoal(10, 64, 0),
            new Vec3(0, 64, 0),
            { now: 0, stallMs: 1_000, noProgressMs: 5_000 },
        );
        assert.equal(monitor.observe(new Vec3(1, 64, 0), { now: 900 }).stalled, false);
        assert.equal(monitor.observe(new Vec3(1, 64, 0), { now: 1_700 }).stalled, false);
        assert.equal(monitor.observe(new Vec3(1, 64, 0), { now: 1_950 }).stalled, true);
    });

    test('walking sideways forever is detected as no goal progress', () => {
        const monitor = new NavigationProgressMonitor(
            new StaticGoal(10, 64, 0),
            new Vec3(0, 64, 0),
            { now: 0, stallMs: 1_000, noProgressMs: 1_500 },
        );
        assert.equal(monitor.observe(new Vec3(0, 64, 1), { now: 600 }).stalled, false);
        assert.equal(monitor.observe(new Vec3(0, 64, 2), { now: 1_200 }).stalled, false);
        const result = monitor.observe(new Vec3(0, 64, 3), { now: 1_600 });
        assert.equal(result.stalled, true);
        assert.match(result.reason, /no progress toward the goal/);
    });

    test('a hard block gets a longer stationary window while digging', () => {
        const monitor = new NavigationProgressMonitor(
            new StaticGoal(10, 64, 0),
            new Vec3(0, 64, 0),
            { now: 0, stallMs: 1_000, noProgressMs: 1_500 },
        );
        assert.equal(monitor.observe(new Vec3(0, 64, 0), { now: 2_500, digging: true }).stalled, false);
        assert.equal(monitor.observe(new Vec3(0, 64, 0), { now: 3_100, digging: true }).stalled, true);
    });

    test('watchdog aborts a hung path and records the reason', async () => {
        const bot = {
            entity: { position: new Vec3(0, 64, 0) },
            targetDigBlock: null,
        };
        let aborted = false;
        await assert.rejects(
            navigateWithWatchdog(bot, new StaticGoal(10, 64, 0), () => new Promise(() => {}), {
                timeoutMs: 2_000,
                stallMs: 250,
                noProgressMs: 1_500,
                sampleMs: 100,
                onAbort: () => { aborted = true; },
            }),
            NavigationStalledError,
        );
        assert.equal(aborted, true);
        assert.equal(bot._navigationDiagnostics.status, 'stalled');
        assert.match(bot._navigationDiagnostics.reason, /no meaningful movement/);
        assert.equal(isRetryableNavigationError(new NavigationStalledError('stuck')), true);
        assert.equal(isRetryableNavigationError({ name: 'GoalChanged' }), false);
    });

    test('successful navigation leaves a reached diagnostic', async () => {
        const bot = {
            entity: { position: new Vec3(0, 64, 0) },
            targetDigBlock: null,
        };
        const result = await navigateWithWatchdog(
            bot,
            new StaticGoal(0, 64, 0),
            async () => 'done',
            { timeoutMs: 1_000, sampleMs: 100 },
        );
        assert.equal(result, 'done');
        assert.equal(bot._navigationDiagnostics.status, 'reached');
    });

    test('repeated failures back off the same goal exponentially', () => {
        const bot = {};
        const goal = new StaticGoal(10, 64, -4);
        const noPath = Object.assign(new Error('no path'), { name: 'NoPath' });

        const first = recordNavigationGoalFailure(bot, goal, noPath, {
            now: 1_000,
            baseDelayMs: 1_000,
            maxDelayMs: 4_000,
        });
        assert.equal(first.failures, 1);
        assert.equal(first.retryAt, 2_000);
        assert.equal(getNavigationGoalBackoff(bot, goal, 1_500).retryAt, 2_000);
        assert.equal(getNavigationGoalBackoff(bot, goal, 2_000), null);

        const second = recordNavigationGoalFailure(bot, goal, noPath, {
            now: 2_000,
            baseDelayMs: 1_000,
            maxDelayMs: 4_000,
        });
        assert.equal(second.failures, 2);
        assert.equal(second.retryAt, 4_000);
        const cooldownError = new NavigationGoalBackoffError(goal, second.retryAt, 2_500);
        assert.equal(cooldownError.code, 'NAVIGATION_GOAL_BACKOFF');
        assert.match(cooldownError.message, /cooling down for 2s/);

        clearNavigationGoalFailure(bot, goal);
        assert.equal(getNavigationGoalBackoff(bot, goal, 2_500), null);
        assert.equal(recordNavigationGoalFailure(bot, goal, new Error('cancelled')), null);
    });
});
