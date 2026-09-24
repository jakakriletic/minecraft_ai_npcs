import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeTrace } from '../tools/kingdom-eval.js';

test('kingdom trace evaluation distinguishes actions from blocked selections and failure streaks', () => {
    const report = summarizeTrace([
        { t: '2026-09-24T10:00:00Z', action: 'gatherWood', result: 'fail' },
        { t: '2026-09-24T10:00:01Z', action: 'gatherWood', blocked: true },
        { t: '2026-09-24T10:00:02Z', action: 'gatherWood', result: 'fail' },
        { t: '2026-09-24T10:00:03Z', action: 'gatherWood', result: 'ok' },
        { t: '2026-09-24T10:00:04Z', action: 'gatherWood', result: 'fail' },
    ]);
    assert.equal(report.selectedActions, 4);
    assert.equal(report.blockedSelections, 1);
    assert.equal(report.actionOutcomes.fail, 3);
    assert.deepEqual(report.maxFailureStreak, { action: 'gatherWood', count: 2 });
    assert.deepEqual(report.topFailingActions, [{ action: 'gatherWood', count: 3 }]);
});
