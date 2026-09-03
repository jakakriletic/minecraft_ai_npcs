import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    actionOutcome,
    captureActionProgress,
    nextActionBackoff,
    verifyActionOutcome,
} from '../src/agent/library/action_outcome.js';

function fakeAgent() {
    const position = { x: 1, y: 64, z: 1 };
    return {
        bot: {
            entity: { position },
            inventory: { items: () => [{ name: 'oak_log', count: 2 }] },
            health: 20,
            food: 20,
            experience: { level: 0, progress: 0 },
            game: { gameMode: 'survival' },
        },
        _plan: { planId: 'plan-1', completed: false },
    };
}

describe('Brain action outcome proof', () => {
    test('rejects ambiguous success with no observable progress', () => {
        const agent = fakeAgent();
        const before = captureActionProgress(agent);
        const verified = verifyActionOutcome(
            { name: 'legacyNoOp' },
            { success: true, interrupted: false, value: undefined, message: '' },
            before,
            captureActionProgress(agent),
        );
        assert.equal(verified.success, false);
        assert.equal(verified.unverified, true);
        assert.match(verified.message, /without an explicit result or observable progress/);
    });

    test('accepts ambiguous legacy success when player state changed', () => {
        const agent = fakeAgent();
        const before = captureActionProgress(agent);
        agent.bot.entity.position.x += 2;
        const verified = verifyActionOutcome(
            { name: 'walk' },
            { success: true, interrupted: false, value: undefined },
            before,
            captureActionProgress(agent),
        );
        assert.equal(verified.success, true);
        assert.equal(verified.progressVerified, true);
    });

    test('accepts an explicit provider success result', () => {
        const agent = fakeAgent();
        const before = captureActionProgress(agent);
        const verified = verifyActionOutcome(
            { name: 'socialAction' },
            { success: true, interrupted: false, value: true },
            before,
            captureActionProgress(agent),
        );
        assert.equal(verified.success, true);
        assert.equal(verified.progressVerified, true);
    });

    test('normalizes an interrupted action to failure with a logged reason', () => {
        const agent = fakeAgent();
        const before = captureActionProgress(agent);
        const verified = verifyActionOutcome(
            { name: 'farm' },
            { success: true, interrupted: true, value: true, message: '' },
            before,
            captureActionProgress(agent),
        );
        assert.equal(verified.success, false);
        assert.equal(verified.interrupted, true);
        assert.match(verified.message, /temporary retry backoff/);
    });

    test('interruption backoff escalates and a success clears it', () => {
        const first = nextActionBackoff(null, { success: false, interrupted: true }, 1000);
        assert.equal(first.cause, 'interrupted');
        assert.equal(first.interruptions, 1);
        assert.equal(first.retryAt, 3000);
        const second = nextActionBackoff(first, { success: false, interrupted: true }, 3000);
        assert.equal(second.interruptions, 2);
        assert.equal(second.retryAt, 7000);
        assert.equal(nextActionBackoff(second, { success: true, interrupted: false }, 7000), null);
    });

    test('preserves waiting as a dependency state instead of a failure', () => {
        const agent = fakeAgent();
        const before = captureActionProgress(agent);
        const waiting = actionOutcome('waiting', {
            blocker: 'diamond', retryAt: 60_000, message: 'expedition is active',
        });
        const verified = verifyActionOutcome(
            { name: 'progress:diamondTools' },
            { success: true, interrupted: false, value: waiting },
            before,
            captureActionProgress(agent),
        );
        assert.equal(verified.success, false);
        assert.equal(verified.actionStatus, 'waiting');
        assert.equal(verified.blocker, 'diamond');
        const backoff = nextActionBackoff(null, verified, 1000);
        assert.equal(backoff.cause, 'waiting');
        assert.equal(backoff.failures, 0);
        assert.equal(backoff.retryAt, 60_000);
    });

    test('preserves an explicitly interrupted structured outcome', () => {
        const agent = fakeAgent();
        const before = captureActionProgress(agent);
        const verified = verifyActionOutcome(
            { name: 'progress:stone' },
            {
                success: true,
                interrupted: false,
                value: actionOutcome('interrupted', { message: 'threat preemption' }),
            },
            before,
            captureActionProgress(agent),
        );
        assert.equal(verified.success, false);
        assert.equal(verified.interrupted, true);
        assert.equal(verified.actionStatus, 'interrupted');
        assert.equal(nextActionBackoff(null, verified, 1000).cause, 'interrupted');
    });
});
