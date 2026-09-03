import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { scaleRecipeRequirements } from '../src/agent/npc/item_goal.js';
import { recipeRequiresTable } from '../src/utils/mcdata.js';

describe('Quantity-aware item goal planning', () => {
    test('scales recipe inputs by output batch count', () => {
        assert.deepEqual(
            scaleRecipeRequirements({ coal: 1, stick: 1 }, 4, 16),
            [
                { name: 'coal', quantity: 4 },
                { name: 'stick', quantity: 4 },
            ],
        );
        assert.deepEqual(
            scaleRecipeRequirements({ oak_planks: 3 }, 6, 13),
            [{ name: 'oak_planks', quantity: 9 }],
        );
    });

    test('detects crafting-table need from recipe shape instead of ingredient sum', () => {
        const ingredient = { id: 1, count: 1 };
        assert.equal(recipeRequiresTable({
            inShape: [[ingredient], [ingredient], [ingredient]],
        }), true);
        assert.equal(recipeRequiresTable({
            inShape: [[ingredient, ingredient], [ingredient, ingredient]],
        }), false);
        assert.equal(recipeRequiresTable({
            ingredients: [ingredient, ingredient, ingredient, ingredient, ingredient],
        }), true);
    });
});
