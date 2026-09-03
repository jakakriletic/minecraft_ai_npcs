import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    chooseDecision,
    completeExternalGoal,
    formatDecisionStatus,
    getExternalGoals,
    hasPendingSafetyAction,
    queueSafetyAction,
    rankDecisionCandidates,
    recordDecisionOutcome,
    recordExternalGoal,
    recordPolicyDecision,
    takeSafetyAction,
} from '../src/agent/library/decision_graph.js';

describe('Dynamic decision graph policy', () => {
    test('an explicit player command outranks autonomous candidates', () => {
        const ranked = rankDecisionCandidates([
            { key: 'milestone:ironTools', source: 'milestone', utility: 100 },
            { key: 'environment:food', source: 'environment', utility: 100, urgency: 50 },
            { key: 'command:follow', source: 'command', utility: 1 },
        ], { now: 1000 });
        assert.equal(ranked[0].key, 'command:follow');
    });

    test('a null expiry means no expiry instead of Unix epoch', () => {
        const ranked = rankDecisionCandidates([
            { key: 'ambient:null-expiry', source: 'ambient', utility: 1, expiresAt: null },
        ], { now: 1000 });
        assert.equal(ranked.length, 1);
    });

    test('environment pressure can beat a milestone without hard-coded branch order', () => {
        const ranked = rankDecisionCandidates([
            { key: 'milestone:ironArmor', source: 'milestone', utility: 48 },
            { key: 'environment:torches', source: 'environment', utility: 62, urgency: 20 },
            { key: 'ai:explore', source: 'ai', utility: 56 },
        ], { now: 1000 });
        assert.equal(ranked[0].key, 'environment:torches');
    });

    test('a zero-reserve settlement food recovery beats elective core-tool work', () => {
        const ranked = rankDecisionCandidates([
            {
                key: 'environment:settlementFoodShortage',
                source: 'environment', utility: 100, urgency: 45,
            },
            {
                key: 'maintenance:coreTools',
                source: 'maintenance', utility: 100, urgency: 12, priority: 18,
            },
        ], { now: 1000 });
        assert.equal(ranked[0].key, 'environment:settlementFoodShortage');
    });

    test('a short commitment bonus prevents near-tie action thrashing', () => {
        const candidates = [
            { key: 'ai:build', source: 'ai', utility: 60 },
            { key: 'milestone:shelter', source: 'milestone', utility: 58 },
        ];
        const ranked = rankDecisionCandidates(candidates, {
            now: 20_000,
            lastSelected: { key: 'ai:build', selectedAt: 10_000 },
        });
        assert.equal(ranked[0].key, 'ai:build');
    });

    test('an interrupted choice loses commitment before the next arbitration', () => {
        const agent = { name: 'Lara', _brain: {} };
        const candidates = [
            {
                key: 'ai:build', source: 'ai', utility: 60,
                createAction: () => ({ name: 'build', fn: async () => true }),
            },
            {
                key: 'milestone:shelter', source: 'milestone', utility: 58,
                createAction: () => ({ name: 'shelter', fn: async () => true }),
            },
        ];
        const action = chooseDecision(agent, candidates, { now: 10_000 });
        assert.equal(action.decision.key, 'milestone:shelter');

        // Make AI the current committed action, then interrupt it. Without the
        // outcome guard its +12 inertia bonus would incorrectly keep it on top.
        agent._decisionState.lastSelected = {
            key: 'ai:build', source: 'ai', score: 80, selectedAt: 10_000,
        };
        const interruptedAction = {
            name: 'build',
            decision: agent._decisionState.lastSelected,
        };
        recordDecisionOutcome(agent, interruptedAction, {
            success: false, interrupted: true, message: 'safety preemption',
        }, { now: 11_000 });
        const ranked = rankDecisionCandidates(candidates, {
            now: 12_000,
            lastSelected: agent._decisionState.lastSelected,
        });
        assert.equal(ranked[0].key, 'milestone:shelter');
        assert.equal(ranked.find(candidate => candidate.key === 'ai:build').commitmentBonus, 0);
    });

    test('bounded milestone aging prevents autonomous starvation', () => {
        const candidates = [
            {
                key: 'milestone:advancedUtility', source: 'milestone', utility: 30,
                aging: { afterMs: 30_000, fullAtMs: 300_000, maxBonus: 120 },
            },
            { key: 'ai:high', source: 'ai', utility: 92, priority: 28 },
        ];
        const fresh = rankDecisionCandidates(candidates, {
            now: 10_000,
            waiting: { 'milestone:advancedUtility': { readySince: 10_000 } },
        });
        assert.equal(fresh[0].key, 'ai:high');

        const aged = rankDecisionCandidates(candidates, {
            now: 310_000,
            waiting: { 'milestone:advancedUtility': { readySince: 10_000 } },
        });
        assert.equal(aged[0].key, 'milestone:advancedUtility');
        assert.equal(aged[0].agingBonus, 120);
    });

    test('milestone aging never outranks command or safety sources', () => {
        const ranked = rankDecisionCandidates([
            {
                key: 'milestone:aged', source: 'milestone', utility: 100,
                aging: { afterMs: 0, fullAtMs: 1, maxBonus: 120 },
            },
            { key: 'command:follow', source: 'command', utility: 50 },
            { key: 'safety:heal', source: 'safety', utility: 0 },
        ], {
            now: 1000,
            waiting: { 'milestone:aged': { readySince: 0 } },
            lastSelected: { key: 'milestone:aged', selectedAt: 900 },
        });
        assert.deepEqual(ranked.map(candidate => candidate.key), [
            'safety:heal', 'command:follow', 'milestone:aged',
        ]);
    });

    test('active action backoff removes a temporarily failed decision', () => {
        const ranked = rankDecisionCandidates([
            { key: 'milestone:ironTools', source: 'milestone', utility: 90, actionName: 'progress:ironTools' },
            { key: 'ai:farm', source: 'ai', utility: 40, actionName: 'planFood' },
        ], {
            now: 1000,
            backoff: { 'progress:ironTools': { retryAt: 2000 } },
        });
        assert.deepEqual(ranked.map(candidate => candidate.key), ['ai:farm']);
    });

    test('materialization falls through when a winning provider is no longer applicable', () => {
        const agent = { name: 'Lara', _brain: {} };
        const action = chooseDecision(agent, [
            { key: 'environment:stale', source: 'environment', utility: 90, createAction: () => null },
            {
                key: 'milestone:stoneTools',
                source: 'milestone',
                utility: 80,
                createAction: () => ({ name: 'progress:stone', fn: async () => true }),
            },
        ], { now: 1000 });
        assert.equal(action.name, 'progress:stone');
        assert.equal(action.decision.key, 'milestone:stoneTools');
    });

    test('a rejected materialized action does not consume its provider cooldown', () => {
        let cooldownStarts = 0;
        const agent = {
            name: 'Lara',
            _brain: { actionBackoff: { staleAction: { retryAt: 2000 } } },
        };
        const action = chooseDecision(agent, [
            {
                key: 'environment:stale', source: 'environment', utility: 90,
                onSelected: () => { cooldownStarts++; },
                createAction: () => ({ name: 'staleAction', fn: async () => true }),
            },
            {
                key: 'ambient:idle', source: 'ambient', utility: 1,
                createAction: () => ({ name: 'idle', fn: async () => true }),
            },
        ], { now: 1000 });
        assert.equal(action.name, 'idle');
        assert.equal(cooldownStarts, 0);
    });

    test('hard-policy decisions expose a reason in status output', () => {
        const agent = { _brain: {} };
        const action = { name: 'recoverHealth', fn: async () => true };
        recordPolicyDecision(agent, action, {
            source: 'safety', reason: 'health is below the recovery threshold', now: 1000,
        });
        assert.match(formatDecisionStatus(agent), /health is below the recovery threshold/);
        assert.equal(action.decision.source, 'safety');
    });

    test('failed outcomes are counted and disable inertia', () => {
        const agent = { _brain: {} };
        const action = { name: 'planBuild', fn: async () => false };
        recordPolicyDecision(agent, action, {
            source: 'ai', reason: 'build the planned workshop', now: 1000,
        });
        let outcome;
        for (let attempt = 0; attempt < 3; attempt++) {
            outcome = recordDecisionOutcome(agent, action, {
                success: false, interrupted: false, message: 'no build site',
            }, { now: 2000 + attempt });
        }
        assert.equal(outcome.consecutiveFailures, 3);
        assert.equal(agent._decisionState.lastSelected.outcome, 'failed');
    });

    test('repeatedly failing autonomous goals lose to a healthy alternative', () => {
        const candidates = [
            { key: 'milestone:blocked', source: 'milestone', utility: 90 },
            { key: 'environment:wood', source: 'environment', utility: 60 },
        ];
        const ranked = rankDecisionCandidates(candidates, {
            now: 10_000,
            outcomes: {
                'milestone:blocked': {
                    lastOutcome: 'failed', consecutiveFailures: 3, lastAt: 9_999,
                },
            },
        });
        assert.equal(ranked[0].key, 'environment:wood');
        assert.equal(ranked[1].failurePenalty, 48);
    });

    test('a serviced waiting goal restarts aging instead of keeping max age', () => {
        const agent = { _brain: {} };
        const candidate = {
            key: 'milestone:ironTools', source: 'milestone', utility: 70,
            aging: { afterMs: 0, fullAtMs: 1000, maxBonus: 120 },
            createAction: () => ({ name: 'progress:ironTools', fn: async () => true }),
        };
        const action = chooseDecision(agent, [candidate], { now: 5000 });
        agent._decisionState.waiting[candidate.key].readySince = 0;
        recordDecisionOutcome(agent, action, {
            success: false,
            actionStatus: 'waiting',
            blocker: 'iron',
            retryAt: 10_000,
        }, { now: 6000 });
        assert.equal(agent._decisionState.waiting[candidate.key].readySince, 6000);
        assert.equal(agent._decisionState.outcomes[candidate.key].consecutiveFailures, 0);
        assert.equal(agent._decisionState.outcomes[candidate.key].lastOutcome, 'waiting');
    });

    test('external command goals remain observable through completion', () => {
        const agent = {};
        const id = recordExternalGoal(agent, { key: 'follow', source: 'command', description: 'follow player' });
        assert.equal(getExternalGoals(agent, { includeRecent: false }).length, 1);
        assert.equal(agent._decisionState.lastSelected.key, 'command:follow');
        assert.equal(completeExternalGoal(agent, id), true);
        assert.equal(getExternalGoals(agent)[0].status, 'completed');
        assert.equal(getExternalGoals(agent, { includeRecent: false }).length, 0);
    });

    test('reactive safety requests preempt a brain action once and run through the arbiter', async () => {
        let interrupts = 0;
        const agent = {
            name: 'Lara',
            _brain: {
                actionBackoff: {},
                activeDecision: { key: 'environment:gatherWood', goalKey: 'gatherWood', selectedAt: 900 },
            },
            actions: { executing: true, currentActionLabel: 'brain:gatherWood' },
            requestInterrupt: () => { interrupts++; },
        };
        const request = {
            key: 'mode:self_defense',
            goalKey: 'combat',
            priority: 60,
            reason: 'a hostile entered melee range',
            now: 1000,
            createAction: () => ({ name: 'mode:self_defense', fn: async () => true }),
        };

        assert.equal(queueSafetyAction(agent, request), true);
        assert.equal(queueSafetyAction(agent, { ...request, now: 1001 }), false);
        assert.equal(interrupts, 1);
        assert.equal(agent._brain.activeDecision.preemptedBy, 'mode:self_defense');
        assert.equal(hasPendingSafetyAction(agent, { now: 1001 }), true);

        const action = takeSafetyAction(agent, { now: 1001 });
        assert.equal(action.name, 'mode:self_defense');
        assert.equal(action.decision.source, 'safety');
        assert.equal(action.decision.goalKey, 'combat');
        assert.equal(action.decision.preemptedAction, 'brain:gatherWood');
        assert.equal(await action.fn(), true);
        assert.equal(hasPendingSafetyAction(agent, { now: 1002 }), false);
    });

    test('a safety request does not interrupt work already serving the same goal', () => {
        let interrupts = 0;
        const agent = {
            _brain: { activeDecision: { goalKey: 'foodRecovery', selectedAt: 900 } },
            actions: { executing: true, currentActionLabel: 'brain:emergencyFood' },
            requestInterrupt: () => { interrupts++; },
        };
        const queued = queueSafetyAction(agent, {
            key: 'mode:emergency_nutrition',
            goalKey: 'foodRecovery',
            createAction: () => ({ name: 'mode:emergency_nutrition', fn: async () => true }),
            now: 1000,
        });
        assert.equal(queued, false);
        assert.equal(interrupts, 0);
        assert.equal(hasPendingSafetyAction(agent, { now: 1000 }), false);
    });
});
