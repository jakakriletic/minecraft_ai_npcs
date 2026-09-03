import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Vec3 } from 'vec3';

import { formatTownSocietyStatus, getSocietyStatus } from '../src/rp/systems/status.js';
import { nextSocietyFixPlan, societyFixPlan, withdrawFromRegions } from '../src/rp/systems/routines.js';
import { chooseHungryTarget } from '../src/rp/jobs/cook.js';
import { summarizeStorageIndex, stewardConcerns } from '../src/rp/jobs/steward.js';
import { guardPatrolRegions } from '../src/rp/jobs/guard.js';
import { builderMaterialPlan } from '../src/rp/jobs/builder.js';
import { eatAvailableFood, syncSatiety, transferFood } from '../src/rp/systems/food.js';
import { inventoryReceiveCapacity } from '../src/rp/core/storage.js';

function makeBlock(name, x, y, z) {
    return {
        name,
        metadata: 0,
        position: new Vec3(x, y, z),
    };
}

function makeBot({ blocks = [], items = [], position = new Vec3(0, 64, 0), timeOfDay = 6000, food = 20 } = {}) {
    return {
        version: '1.20.1',
        entity: { position },
        health: 20,
        food,
        isSleeping: false,
        time: { timeOfDay, age: timeOfDay },
        inventory: {
            items: () => items,
        },
        findBlocks: ({ point, matching, maxDistance = 16, count = 1 }) => blocks
            .filter(block => matching(block))
            .filter(block => block.position.distanceTo(new Vec3(point.x, point.y, point.z)) <= maxDistance)
            .slice(0, count)
            .map(block => block.position),
    };
}

function makeNpc(overrides = {}) {
    const locations = {
        home: { center: { x: 0, y: 64, z: 0 }, radius: 8 },
        kitchen: { center: { x: 0, y: 64, z: 0 }, radius: 8 },
        mine: { center: { x: 0, y: 64, z: 0 }, radius: 8 },
        obcina: { center: { x: 0, y: 64, z: 0 }, radius: 8 },
        mestna_zaloga: { center: { x: 0, y: 64, z: 0 }, radius: 8 },
    };
    const bot = makeBot(overrides.bot ?? {});
    return {
        cfg: {
            id: overrides.id ?? 'kaja',
            job: overrides.job ?? 'cook',
            home_region: 'home',
            job_region: overrides.jobRegion ?? 'kitchen',
            osebnost: { ime: overrides.name ?? 'Kaja' },
        },
        bot,
        locations,
        settings: {
            economy: { obcinska_skrinja_regija: 'obcina' },
            society: { auto_fix_enabled: true },
        },
        schedule: {
            work_start: 0,
            work_end: 12000,
            sleep_start: 13000,
            sleep_end: 23000,
        },
        currentActivity: 'work',
        state: {
            data: {
                potrebe: { sitost: 80, druzabnost: 50, utrujenost: 20 },
                zapor_do: null,
            },
            save: () => {},
        },
        storage: {
            totalOf: () => 0,
        },
        civic: {
            data: { current_day: 0 },
            taxLaw: () => ({
                id: 'basic_tax',
                storage_region: 'mestna_zaloga',
                applies_to: ['cobblestone'],
                due_after_tick: 9000,
                grace_until_tick: 17000,
            }),
            hasPaidTax: () => false,
            dayFromBot: () => 0,
        },
        ...overrides.npc,
    };
}

describe('RP society status', () => {
    test('cook with validated home, kitchen and town storage is ready', () => {
        const npc = makeNpc({
            bot: {
                items: [{ name: 'bread', count: 2, metadata: 0 }],
                blocks: [
                    makeBlock('white_bed', 0, 64, 1),
                    makeBlock('chest', 1, 64, 0),
                    makeBlock('furnace', 2, 64, 0),
                    makeBlock('crafting_table', 3, 64, 0),
                ],
            },
        });

        const status = getSocietyStatus(npc);
        assert.equal(status.ready, true);
        assert.equal(status.blockers.length, 0);
        assert.equal(status.structures.home.checks.bed.count, 1);
        assert.equal(status.structures.work.checks.furnace.count, 1);
    });

    test('miner reports concrete blockers for missing home bed and pickaxe', () => {
        const npc = makeNpc({
            job: 'miner',
            jobRegion: 'mine',
            bot: {
                blocks: [makeBlock('chest', 1, 64, 0)],
            },
        });

        const status = getSocietyStatus(npc);
        assert.equal(status.ready, false);
        assert.ok(status.blockers.includes("dom 'home' nima postelje"));
        assert.ok(status.blockers.includes("manjka pickaxe za delo 'miner'"));
    });

    test('town formatter summarizes blocked NPCs', () => {
        const ready = makeNpc({
            id: 'ready',
            name: 'Ready',
            bot: {
                items: [{ name: 'bread', count: 2, metadata: 0 }],
                blocks: [
                    makeBlock('white_bed', 0, 64, 1),
                    makeBlock('chest', 1, 64, 0),
                    makeBlock('furnace', 2, 64, 0),
                    makeBlock('crafting_table', 3, 64, 0),
                ],
            },
        });
        const blocked = makeNpc({
            id: 'blocked',
            name: 'Blocked',
            job: 'miner',
            jobRegion: 'mine',
            bot: { blocks: [] },
        });
        const lines = formatTownSocietyStatus([ready, blocked]);
        assert.match(lines[0], /Society: /);
        assert.match(lines[0], /blokirani: /);
        assert.match(lines[1], /Blocked/);
    });

    test('routine planner prioritizes hard needs before job prep', () => {
        const npc = makeNpc({
            job: 'miner',
            jobRegion: 'mine',
            bot: { food: 3 },
            npc: {
                state: {
                    data: {
                        potrebe: { sitost: 18, druzabnost: 50, utrujenost: 20 },
                        zapor_do: null,
                    },
                    save: () => {},
                },
            },
        });
        const plan = societyFixPlan(npc, {
            blockers: ["manjka pickaxe za delo 'miner'"],
            warnings: [],
        });
        assert.equal(plan.type, 'eat');
    });

    test('routine planner turns missing tool and cook food warnings into actions', () => {
        const miner = makeNpc({ job: 'miner', jobRegion: 'mine' });
        const toolPlan = societyFixPlan(miner, {
            blockers: ["manjka pickaxe za delo 'miner'"],
            warnings: [],
        });
        assert.equal(toolPlan.type, 'tool');
        assert.equal(toolPlan.label, 'pickaxe');

        const cook = makeNpc({ job: 'cook', jobRegion: 'kitchen' });
        const foodPlan = societyFixPlan(cook, {
            blockers: [],
            warnings: ['kuhar nima vidne hrane v inventarju ali znani zalogi'],
        });
        assert.equal(foodPlan.type, 'cook_food_stock');
    });

    test('routine planner schedules tax for non-lawmen only', () => {
        const worker = makeNpc({ job: 'builder', jobRegion: 'kitchen' });
        const taxPlan = societyFixPlan(worker, {
            blockers: [],
            warnings: ['mestni prispevek se ni oddan (12 kosov)'],
        });
        assert.equal(taxPlan.type, 'tax');

        const guard = makeNpc({ job: 'guard', jobRegion: 'kitchen' });
        const guardPlan = societyFixPlan(guard, {
            blockers: [],
            warnings: ['mestni prispevek se ni oddan (12 kosov)'],
        });
        assert.equal(guardPlan.type, 'tool');
    });

    test('cook job chooses the hungriest reachable NPC', () => {
        const cook = makeNpc({ id: 'cook', name: 'Cook', bot: { position: new Vec3(0, 64, 0) } });
        const hungry = makeNpc({
            id: 'hungry',
            name: 'Hungry',
            bot: { position: new Vec3(5, 64, 0), food: 4 },
            npc: {
                state: {
                    data: { potrebe: { sitost: 22, druzabnost: 50, utrujenost: 20 }, zapor_do: null },
                    save: () => {},
                },
            },
        });
        const peckish = makeNpc({
            id: 'peckish',
            name: 'Peckish',
            bot: { position: new Vec3(1, 64, 0), food: 10 },
            npc: {
                state: {
                    data: { potrebe: { sitost: 48, druzabnost: 50, utrujenost: 20 }, zapor_do: null },
                    save: () => {},
                },
            },
        });
        cook.registry = [cook, peckish, hungry];
        assert.equal(chooseHungryTarget(cook).cfg.id, 'hungry');
    });

    test('cook ignores unreachable and busy hungry targets', () => {
        const cook = makeNpc({ id: 'cook', bot: { position: new Vec3(0, 64, 0) } });
        const far = makeNpc({ id: 'far', bot: { position: new Vec3(80, 64, 0), food: 1 } });
        const busy = makeNpc({ id: 'busy', bot: { position: new Vec3(2, 64, 0), food: 2 }, npc: { busy: true } });
        const ready = makeNpc({ id: 'ready', bot: { position: new Vec3(6, 64, 0), food: 8 } });
        cook.registry = [cook, far, busy, ready];
        assert.equal(chooseHungryTarget(cook).cfg.id, 'ready');
    });

    test('routine cooldown falls through from tax to cook restock', () => {
        const npc = makeNpc({ job: 'cook', jobRegion: 'kitchen' });
        npc.societyRoutineState = { attempts: { tax: Date.now() } };
        const plan = nextSocietyFixPlan(npc, {
            blockers: [],
            warnings: [
                'mestni prispevek se ni oddan (12 kosov)',
                'kuhar nima vidne hrane v inventarju ali znani zalogi',
            ],
        });
        assert.equal(plan.type, 'cook_food_stock');
    });

    test('withdrawal accumulates the requested amount across multiple chests', async () => {
        const first = makeBlock('chest', 1, 64, 0);
        const second = makeBlock('chest', 2, 64, 0);
        const calls = [];
        const npc = makeNpc({
            npc: {
                storage: {
                    index: { chests: {} },
                    findChestsInRegion: () => [first, second],
                    withdrawMatching: async (_bot, chest, _names, remaining) => {
                        calls.push(chest.position.x);
                        const count = chest.position.x === 1 ? 1 : Math.min(7, remaining);
                        return { count, items: { bread: count } };
                    },
                },
            },
        });
        npc.bot.blockAt = position => [first, second].find(block => block.position.equals(position)) ?? null;
        const result = await withdrawFromRegions(npc, ['bread'], 8, ['kitchen']);
        assert.equal(result.complete, true);
        assert.equal(result.count, 8);
        assert.deepEqual(calls, [1, 2]);
    });

    test('configured chest is tried before discovered region chests', async () => {
        const ordinary = makeBlock('chest', 1, 64, 0);
        const assigned = makeBlock('chest', 3, 64, 0);
        const calls = [];
        const npc = makeNpc({
            npc: {
                cfg: {
                    id: 'kaja', job: 'cook', home_region: 'home', job_region: 'kitchen',
                    osebnost: { ime: 'Kaja' }, chests: { hrana: { x: 3, y: 64, z: 0 } },
                },
                storage: {
                    index: { chests: {} },
                    findChestsInRegion: () => [ordinary, assigned],
                    withdrawMatching: async (_bot, chest) => {
                        calls.push(chest.position.x);
                        return { count: 1, items: { bread: 1 } };
                    },
                },
            },
        });
        npc.bot.blockAt = position => [ordinary, assigned].find(block => block.position.equals(position)) ?? null;
        const result = await withdrawFromRegions(npc, ['bread'], 1, ['kitchen']);
        assert.equal(result.complete, true);
        assert.deepEqual(calls, [3]);
    });

    test('RP satiety mirrors real hunger and eating updates it from Minecraft', async () => {
        const items = [{ name: 'bread', type: 297, metadata: 0, count: 1 }];
        let saves = 0;
        const npc = makeNpc({
            bot: { items, food: 10 },
            npc: { state: { data: { potrebe: { sitost: 5 } }, save: () => { saves++; } } },
        });
        npc.bot.autoEat = { isEating: false, eat: async () => { npc.bot.food = 15; items.length = 0; return true; } };
        assert.equal(syncSatiety(npc), true);
        assert.equal(npc.state.data.potrebe.sitost, 50);
        const result = await eatAvailableFood(npc);
        assert.equal(result.ate, true);
        assert.equal(npc.state.data.potrebe.sitost, 75);
        assert.ok(saves >= 2);
    });

    test('food handoff locks the recipient and ends in a real meal', async () => {
        const fromItems = [{ name: 'bread', type: 297, metadata: 0, count: 2 }];
        const toItems = [];
        const from = makeNpc({ id: 'from', bot: { items: fromItems, position: new Vec3(0, 64, 0) } });
        const to = makeNpc({ id: 'to', bot: { items: toItems, position: new Vec3(1, 64, 0), food: 10 } });
        from.bot.toss = async () => { fromItems[0].count--; toItems.push({ name: 'bread', type: 297, metadata: 0, count: 1 }); };
        to.bot.autoEat = {
            isEating: false,
            eat: async () => { toItems.length = 0; to.bot.food = 15; return true; },
        };
        const result = await transferFood(from, to, {
            gotoNear: async () => true,
            sleep: async () => {},
        });
        assert.equal(result.success, true);
        assert.equal(result.ate, true);
        assert.equal(to.state.data.potrebe.sitost, 75);
        assert.equal(to.busy, false);
    });

    test('full inventory still accepts a withdrawal into a partial stack', () => {
        const carried = { name: 'bread', type: 297, metadata: 0, count: 60, stackSize: 64 };
        const bot = makeBot({ items: [carried] });
        bot.inventory.emptySlotCount = () => 0;
        assert.equal(inventoryReceiveCapacity(bot, { ...carried, count: 8 }), 4);
    });

    test('steward inventory summary reports low public stock', () => {
        const summary = summarizeStorageIndex({
            chests: {
                a: { region: 'mestna_zaloga', items: { bread: 2, cobblestone: 12, torch: 1 } },
                b: { region: 'home', items: { bread: 64, cobblestone: 64, torch: 64 } },
            },
        }, 'mestna_zaloga');
        assert.equal(summary.food, 2);
        assert.equal(summary.materials, 12);
        assert.deepEqual(stewardConcerns(summary), [
            'malo hrane',
            'malo gradbenega materiala',
            'malo orodja/bakel',
            'skrinje so skoraj prazne',
        ]);
    });

    test('guard and builder job planners expose concrete routines', () => {
        const guard = makeNpc({ job: 'guard', jobRegion: 'patrulja_noc' });
        guard.locations.patrulja_noc = { center: { x: 0, y: 64, z: 0 }, radius: 12 };
        assert.deepEqual(guardPatrolRegions(guard), [
            'patrulja_noc',
            'mestna_zaloga',
            'obcina',
        ]);

        assert.deepEqual(builderMaterialPlan({ materials: 40, lighting: 8, tools: 1 }), {
            ready: true,
            missing: [],
            counts: { materials: 40, lighting: 8, tools: 1 },
        });
        assert.deepEqual(builderMaterialPlan({ materials: 4, lighting: 0, tools: 0 }).missing, [
            'gradbeni material',
            'bakle',
            'orodje',
        ]);
    });
});
