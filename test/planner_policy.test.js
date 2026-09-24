import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { allowedPlanFocuses, normalizePlan } from '../src/agent/library/planner.js';
import { influencePlan } from '../src/agent/roleplay/personality.js';

describe('Planner focus eligibility', () => {
    test('a bot without a home can still receive executable autonomous work', () => {
        const focuses = allowedPlanFocuses({
            hasHome: false,
            allowBuilding: true,
            hasSchematics: true,
            socialGoals: true,
        });
        assert.deepEqual(focuses, ['explore', 'stockpile', 'relax', 'social']);
    });

    test('home-only work becomes available after a home is set', () => {
        const focuses = allowedPlanFocuses({
            hasHome: true,
            allowBuilding: true,
            hasSchematics: true,
        });
        assert.ok(focuses.includes('base'));
        assert.ok(focuses.includes('farm'));
        assert.ok(focuses.includes('build'));
    });

    test('personality cannot turn a valid no-home focus into base work', () => {
        const allowedFocuses = allowedPlanFocuses({ hasHome: false });
        const plan = influencePlan({ focus: 'relax' }, {
            workEthic: 'persistent', orderliness: 0.9,
        }, 'member', allowedFocuses);
        assert.equal(plan.focus, 'relax');
    });

    test('a shared food assignment becomes executable stockpiling without a home', () => {
        const plan = normalizePlan({ focus: 'farm', resource: 'food', amount: 16 }, {
            name: 'Blaz', role: 'member', hasHome: false,
        }, 1000, 'society', 'food');
        assert.equal(plan.focus, 'stockpile');
        assert.equal(plan.resource, 'food');
    });
});
