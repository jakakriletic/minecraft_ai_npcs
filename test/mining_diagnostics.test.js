// Mining diagnostics: offline tests (no Minecraft server) for known mining bugs.
// Run:  node --test test/mining_diagnostics.test.js
// A FAILING test = the bug is still present. Once fixed, the test turns green.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Vec3 } from 'vec3';
import prismarineRegistry from 'prismarine-registry';
import prismarineBlock from 'prismarine-block';
import { collectBlock } from '../src/agent/library/skills.js';
import { isNaturalResourceCandidate } from '../src/agent/library/resource_guard.js';

const registry = prismarineRegistry('1.20.1');
const Block = prismarineBlock(registry);
const key = p => `${p.x},${p.y},${p.z}`;

// Minimal voxel world bot. Unset positions = air (or `fill` if given).
function makeWorldBot({ blocks = {}, fill = 'air', pos = new Vec3(0.5, 20, 0.5), items = [] } = {}) {
    const world = new Map();
    for (const [k, name] of Object.entries(blocks)) world.set(k, name);
    const blockAt = (p) => {
        const v = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
        const name = world.get(key(v)) ?? fill;
        const def = registry.blocksByName[name];
        const b = Block.fromStateId(def.defaultState, 0);
        b.position = v;
        return b;
    };
    const findCalls = [];
    const bot = {
        username: `mining_diag_${Math.random().toString(36).slice(2, 8)}`,
        version: '1.20.1',
        registry,
        output: '',
        interrupt_code: false,
        health: 20, food: 20,
        entity: { position: pos, height: 1.8, onGround: true },
        game: { dimension: 'mining-diag-dimension', gameMode: 'survival', minY: -64, height: 384 },
        heldItem: null,
        inventory: { slots: Array(46).fill(null), items: () => items, emptySlotCount: () => 20 },
        modes: { isOn: () => false },
        world: { getBlock: blockAt, getBlockStateId: p => blockAt(p).stateId },
        blockAt,
        findCalls,
        attempted: [],
        tool: { equipForBlock: async (b) => { bot.attempted.push(b); throw new Error('diag-stop'); } },
        findBlocks({ matching, maxDistance = 16, count = 1, point = bot.entity.position }) {
            findCalls.push({ matching, maxDistance, count });
            const ids = typeof matching === 'function' ? null : new Set([].concat(matching));
            const hits = [];
            for (const [k, name] of world) {
                const [x, y, z] = k.split(',').map(Number);
                const v = new Vec3(x, y, z);
                const b = blockAt(v);
                const ok = ids ? ids.has(b.type) : matching(b);
                if (ok && v.distanceTo(point) <= maxDistance) hits.push(v);
            }
            hits.sort((a, b) => a.distanceTo(point) - b.distanceTo(point));
            return hits.slice(0, count);
        },
        on() {}, once() {}, removeListener() {}, off() {},
        pathfinder: { setMovements() {}, setGoal() {}, stop() {} },
    };
    return bot;
}

function idsSearchedBy(bot) {
    const names = new Set();
    for (const call of bot.findCalls)
        if (typeof call.matching !== 'function')
            for (const id of [].concat(call.matching)) names.add(registry.blocks[id]?.name);
    return names;
}

describe('collectBlock: ore name expansion', () => {
    test('BUG-1 "iron" must also search deepslate_iron_ore', async () => {
        const bot = makeWorldBot();
        await collectBlock(bot, 'iron', 1);
        const names = idsSearchedBy(bot);
        assert.ok(names.has('iron_ore'), 'iron_ore not searched');
        assert.ok(names.has('deepslate_iron_ore'), `deepslate_iron_ore not searched; searched: ${[...names]}`);
    });

    test('BUG-2 "lapis_lazuli" must search lapis_ore (lapis_lazuli_ore does not exist)', async () => {
        const bot = makeWorldBot();
        await collectBlock(bot, 'lapis_lazuli', 1);
        assert.ok(idsSearchedBy(bot).has('lapis_ore'));
    });

    test('BUG-3 "copper" must search copper_ore', async () => {
        const bot = makeWorldBot();
        await collectBlock(bot, 'copper', 1);
        assert.ok(idsSearchedBy(bot).has('copper_ore'));
    });

    test('control: "iron_ore" searches deepslate_iron_ore', async () => {
        const bot = makeWorldBot();
        await collectBlock(bot, 'iron_ore', 1);
        assert.ok(idsSearchedBy(bot).has('deepslate_iron_ore'));
    });
});

describe('collectBlock: candidate search', () => {
    test('control: finds a single nearby ore', async () => {
        const bot = makeWorldBot({ blocks: { '0,19,30': 'iron_ore' } });
        await collectBlock(bot, 'iron_ore', 1);
        assert.ok(bot.attempted.some(b => b.position.z === 30));
    });

    test('BUG-4 finds a valid block even when the 16+ nearest candidates are excluded', async () => {
        const blocks = {};
        const exclude = [];
        for (let i = 1; i <= 20; i++) { blocks[`${i},19,0`] = 'iron_ore'; exclude.push(new Vec3(i, 19, 0)); }
        blocks['0,19,30'] = 'iron_ore'; // valid one, 30 blocks away
        const bot = makeWorldBot({ blocks });
        await collectBlock(bot, 'iron_ore', 1, exclude);
        assert.ok(bot.attempted.some(b => b.position.z === 30),
            `never tried the valid ore; output:\n${bot.output}`);
    });
});

describe('resource_guard: torches in own tunnel', () => {
    test('BUG-5 underground stone next to a wall_torch is still minable', () => {
        const bot = makeWorldBot({ blocks: { '0,20,0': 'stone', '1,20,0': 'wall_torch' } });
        assert.equal(isNaturalResourceCandidate(bot, bot.blockAt(new Vec3(0, 20, 0)), 'stone'), true,
            'stone near a torch is rejected -> after autoLight places torches, "No stone nearby"');
    });

    test('BUG-5b underground stone next to cobblestone (mined rubble) is minable', () => {
        const bot = makeWorldBot({ blocks: { '0,20,0': 'stone', '0,21,0': 'cobblestone' } });
        assert.equal(isNaturalResourceCandidate(bot, bot.blockAt(new Vec3(0, 20, 0)), 'stone'), true);
    });

    test('control: plain underground stone is minable', () => {
        const bot = makeWorldBot({ blocks: { '0,20,0': 'stone' } });
        assert.equal(isNaturalResourceCandidate(bot, bot.blockAt(new Vec3(0, 20, 0)), 'stone'), true);
    });

    test('control: ore next to torch is minable', () => {
        const bot = makeWorldBot({ blocks: { '0,20,0': 'iron_ore', '1,20,0': 'wall_torch' } });
        assert.equal(isNaturalResourceCandidate(bot, bot.blockAt(new Vec3(0, 20, 0)), 'iron_ore'), true);
    });
});
