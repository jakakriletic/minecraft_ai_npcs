import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Vec3 } from 'vec3';

import { actionsList } from '../src/agent/commands/actions.js';
import { queryList } from '../src/agent/commands/queries.js';
import {
    formatLoadoutStatus,
    getAllLoadoutStatuses,
    getLoadoutProfile,
    getLoadoutStatus,
    loadoutProfileNames,
    normalizeTaskName,
    prepareForTask,
} from '../src/agent/library/loadout.js';
import { formatGameplayStatus } from '../src/agent/library/gameplay_status.js';
import {
    bumpRoyalIntentResume,
    cancelRoyalIntent,
    createRoyalIntent,
    finishRoyalIntent,
    formatRoyalDuty,
    markRoyalIntent,
} from '../src/agent/library/royal_intent.js';
import {
    classifyOwnerCommand,
    ownerCommandLooksActionable,
} from '../src/agent/owner_commands.js';
import {
    auditHomeLighting,
    formatHomeLifeStatus,
    getHomeLifeStatus,
    planHomeLifeAction,
} from '../src/agent/library/home_life.js';
import {
    classifyPlayerHelperCommand,
    formatPlayerHelperStatus,
    getPlayerHelperStatus,
    normalizeHelperItem,
} from '../src/agent/library/player_helper.js';
import { withNamedLock } from '../src/agent/library/container_lock.js';
import { furnaceHasActiveFuel, openFurnaceAttempt, smeltItem } from '../src/agent/library/skills.js';
import {
    inventoryCanReceive,
    inventoryReceiveCapacity,
    selectMatchingItems,
    takeAnyPublic,
} from '../src/agent/library/storage.js';
import {
    inspectContainerIndex,
    installContainerIndex,
    recordContainerSnapshot,
} from '../src/agent/library/container_index.js';
import {
    immediateRecoveryNeed,
    isSurfaceRecoveryComplete,
    needsEmergencyNutrition,
    needsFoodBeforeHealing,
    pantryItemPriority,
    planEmergencyFood,
    preferredOreY,
    recoveryActionKind,
    selectedFuelSmeltCapacity,
} from '../src/agent/library/survival.js';
import {
    expeditionBranchDirection,
    expeditionMemberQuota,
    expeditionProgress,
    memberCanJoinExpedition,
    requestResourceExpedition,
    shouldRallyAtEntrance,
} from '../src/agent/library/mining.js';
import {
    actionCandidates as progressionActionCandidates,
    estimateMilestone,
    getMilestoneGraph,
    getStatus as getProgressionStatus,
    nextAction as nextProgressionAction,
    normalizeMilestoneAttemptOutcome,
    validateMilestoneGraph,
} from '../src/agent/library/progression.js';
import { writeJsonAtomic } from '../src/utils/atomic_json.js';
import { assignRoleNames } from '../src/agent/library/society.js';
import {
    castFireball,
    fireballDamageCommand,
    regenerationCommand,
    selectLowestHealthMember,
} from '../src/agent/library/magic.js';

const originalCwd = process.cwd();
let tempCwd;

function makeItem(name, count = 1, extra = {}) {
    return {
        name,
        count,
        metadata: 0,
        ...extra,
    };
}

function blockKey(pos) {
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function makeBlock(name, x, y, z, extra = {}) {
    const solid = extra.solid ?? !['air', 'cave_air', 'void_air'].includes(name);
    return {
        name,
        position: new Vec3(x, y, z),
        shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [],
        boundingBox: solid ? 'block' : 'empty',
        ...extra,
    };
}

function makeBot({
    username = `test_bot_${Date.now()}`,
    items = [],
    emptySlots = 20,
    health = 20,
    food = 20,
    dimension = 'gameplay-test-dimension',
    offhand = null,
    blocks = [],
    time = {},
} = {}) {
    const slots = Array(46).fill(null);
    items.forEach((item, index) => {
        const slot = 9 + index;
        slots[slot] = { slot, ...item };
    });
    if (offhand) slots[45] = offhand;
    const blockMap = new Map(blocks.map(block => [blockKey(block.position), block]));

    const bot = {
        username,
        version: '1.20.1',
        health,
        food,
        interrupt_code: false,
        entity: {
            position: new Vec3(0, 64, 0),
        },
        game: {
            dimension,
            gameMode: 'survival',
        },
        time: {
            timeOfDay: time.timeOfDay ?? 6000,
            day: time.day ?? 0,
            age: time.age ?? ((time.day ?? 0) * 24_000 + (time.timeOfDay ?? 6000)),
        },
        inventory: {
            slots,
            items: () => slots.filter(Boolean),
            emptySlotCount: () => emptySlots,
        },
        getEquipmentDestSlot: destination => destination === 'off-hand' ? 45 : null,
        blockAt: pos => blockMap.get(blockKey(pos)) ?? null,
        findBlocks: ({ point = new Vec3(0, 64, 0), matching, maxDistance = 16, count = 1 }) => {
            const matches = [];
            for (const block of blockMap.values()) {
                const ok = typeof matching === 'function'
                    ? matching(block)
                    : false;
                if (!ok || block.position.distanceTo(point) > maxDistance) continue;
                matches.push(block);
            }
            return matches
                .sort((a, b) => a.position.distanceTo(point) - b.position.distanceTo(point))
                .slice(0, count)
                .map(block => block.position);
        },
    };
    return bot;
}

function makeHomeBlocks({ bed = true, utilities = true, torch = true } = {}) {
    const blocks = [];
    for (let dx = -6; dx <= 6; dx++) {
        for (let dz = -6; dz <= 6; dz++) {
            blocks.push(makeBlock('stone', dx, 63, dz));
            blocks.push(makeBlock('air', dx, 64, dz, { solid: false }));
            blocks.push(makeBlock('air', dx, 65, dz, { solid: false }));
        }
    }
    if (bed) blocks.push(makeBlock('white_bed', 2, 64, 0));
    if (utilities) {
        blocks.push(makeBlock('chest', -2, 64, 0));
        blocks.push(makeBlock('crafting_table', -2, 64, 1));
        blocks.push(makeBlock('furnace', -2, 64, -1));
    }
    if (torch) blocks.push(makeBlock('torch', 0, 64, 0));
    return blocks;
}

function writeBase(bot) {
    const dir = join(tempCwd, 'bots', bot.username);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'base.json'), JSON.stringify({
        x: 0,
        y: 64,
        z: 0,
        radius: 10,
    }));
}

function writeProgression(bot, state) {
    const dir = join(tempCwd, 'bots', bot.username);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'progression.json'), JSON.stringify(state));
}

function preparedMinerBot() {
    const bot = makeBot({
        username: 'prepared_miner',
        items: [
            makeItem('stone_pickaxe', 1, { maxDurability: 132, durabilityUsed: 0 }),
            makeItem('stone_sword', 1, { maxDurability: 132, durabilityUsed: 0 }),
            makeItem('stone_shovel', 1, { maxDurability: 132, durabilityUsed: 0 }),
            makeItem('bread', 4),
            makeItem('torch', 16),
            makeItem('cobblestone', 16),
        ],
        emptySlots: 8,
    });
    writeBase(bot);
    return bot;
}

before(() => {
    tempCwd = mkdtempSync(join(tmpdir(), 'mindcraft-gameplay-tests-'));
    process.chdir(tempCwd);
});

after(() => {
    process.chdir(originalCwd);
    if (tempCwd) rmSync(tempCwd, { recursive: true, force: true });
});

describe('Healer and magician society roles', () => {
    test('preferred NPCs receive exactly one healer and one magician role', () => {
        const roles = assignRoleNames(
            ['Maja', 'Nejc', 'Blaz', 'Lara', 'Zan'],
            { healer: 'Blaz', magician: 'Nejc' },
        );
        assert.deepEqual(roles, {
            Blaz: 'healer',
            Lara: 'member',
            Maja: 'member',
            Nejc: 'magician',
            Zan: 'member',
        });
        assert.equal(Object.values(roles).filter(role => role === 'healer').length, 1);
        assert.equal(Object.values(roles).filter(role => role === 'magician').length, 1);
    });

    test('special roles fall back deterministically when preferred NPCs are offline', () => {
        assert.deepEqual(
            assignRoleNames(['Zan', 'Lara', 'Maja'], { healer: 'Blaz', magician: 'Nejc' }),
            { Lara: 'healer', Maja: 'magician', Zan: 'member' },
        );
        assert.deepEqual(
            assignRoleNames(['Zan', 'Nejc'], { healer: 'Blaz', magician: 'Nejc' }),
            { Nejc: 'magician', Zan: 'healer' },
        );
    });

    test('healer selects the visible damaged member with the lowest health', () => {
        const bot = makeBot({ username: 'Blaz' });
        bot.players = {
            Blaz: { username: 'Blaz', entity: bot.entity },
            Nejc: { username: 'Nejc', entity: { position: new Vec3(5, 64, 0), isValid: true } },
            Lara: { username: 'Lara', entity: { position: new Vec3(8, 64, 0), isValid: true } },
            Maja: { username: 'Maja', entity: { position: new Vec3(3, 64, 0), isValid: true } },
        };
        const selected = selectLowestHealthMember(bot, [
            { name: 'Blaz', health: 1 },
            { name: 'Nejc', health: 8 },
            { name: 'Lara', health: 4 },
            { name: 'Maja', health: 20 },
        ], 'Blaz', 32);
        assert.equal(selected.name, 'Lara');
        assert.equal(selected.health, 4);
        assert.equal(regenerationCommand(selected.name, 2),
            '/effect give Lara minecraft:regeneration 2 0 false');
    });

    test('magician attack sends one damage command without a particle-command burst', async () => {
        const target = {
            id: 2,
            uuid: '12345678-1234-1234-1234-123456789abc',
            name: 'zombie',
            position: new Vec3(12, 65, 0),
            height: 1.8,
            isValid: true,
        };
        const commands = [];
        const bot = {
            username: 'Nejc',
            entity: { position: new Vec3(0, 65, 0) },
            entities: { [target.id]: target },
            players: {},
            interrupt_code: false,
            canSeeEntity: () => true,
            lookAt: async () => {},
            chat: command => commands.push(command),
            modes: { pause() {}, unpause() {} },
        };

        assert.equal(await castFireball({ bot }, target), true);
        assert.deepEqual(commands, [
            '/damage 12345678-1234-1234-1234-123456789abc 5 minecraft:magic by Nejc',
        ]);
        assert.equal(commands.some(command => command.startsWith('/particle ')), false);
        assert.equal(
            fireballDamageCommand({
                uuid: '12345678-1234-1234-1234-123456789abc',
                name: 'zombie',
                position: target.position,
            }, 5, 'Nejc'),
            '/damage 12345678-1234-1234-1234-123456789abc 5 minecraft:magic by Nejc',
        );
    });
});

describe('Faza 2 loadout policy', () => {
    test('profiles and aliases are registered for the player-like roles', () => {
        assert.deepEqual(loadoutProfileNames(), [
            'miner',
            'builder',
            'farmer',
            'ranger',
            'steward',
            'explorer',
            'escort',
        ]);
        assert.equal(normalizeTaskName('mine'), 'miner');
        assert.equal(normalizeTaskName('royal'), 'escort');
        assert.equal(getLoadoutProfile('building').name, 'builder');
        assert.equal(getLoadoutProfile('unknown-role'), null);
    });

    test('miner is ready when the bot has a return point and required gear', () => {
        const bot = preparedMinerBot();
        const status = getLoadoutStatus(bot, 'miner');
        assert.equal(status.ready, true);
        assert.deepEqual(status.blockers, []);
        assert.equal(status.inventory.food, 4);
        assert.equal(status.inventory.torches, 16);
        assert.equal(status.inventory.supportBlocks, 16);
        assert.equal(status.inventory.tools.pickaxe.name, 'stone_pickaxe');
        assert.match(formatLoadoutStatus(bot, 'miner'), /LOADOUT miner: READY/);
        assert.equal(getAllLoadoutStatuses(bot).miner.ready, true);
    });

    test('ranger reports actionable blockers when combat kit is missing', () => {
        const bot = makeBot({
            username: 'unprepared_ranger',
            health: 20,
            food: 20,
            items: [makeItem('bread', 4)],
            emptySlots: 10,
        });
        const status = getLoadoutStatus(bot, 'ranger');
        assert.equal(status.ready, false);
        assert.ok(status.blockers.includes('needs 12 arrows'));
        assert.ok(status.blockers.includes('needs shield'));
        assert.ok(status.blockers.includes('needs bow'));
        assert.ok(status.blockers.includes('needs stone+ sword'));
        assert.match(formatLoadoutStatus(bot, 'ranger'), /LOADOUT ranger: BLOCKED/);
    });

    test('unknown profiles return a helpful blocked status', () => {
        const bot = makeBot({ username: 'unknown_profile_bot' });
        const status = getLoadoutStatus(bot, 'bard');
        assert.equal(status.ready, false);
        assert.deepEqual(status.blockers, ['unknown loadout profile "bard"']);
        assert.match(status.warnings[0], /known profiles: miner, builder/);
    });

    test('prepareForTask is a no-op success path for an already prepared profile', async () => {
        const bot = preparedMinerBot();
        const status = await prepareForTask({ bot }, 'miner', { claimCamp: false });
        assert.equal(status.ready, true);
        assert.deepEqual(status.blockers, []);
    });
});

describe('Faza 3 royal command contract', () => {
    test('RoyalIntent infers core command shape and timeout fields', () => {
        const agent = { name: 'TestNpc', _ownerCommandSeq: 42, bot: {} };
        const intent = createRoyalIntent(agent, 'King', 'attack:zombie', {
            timeoutMins: 5,
            target: {
                type: 'entity',
                query: 'zombie',
                count: 1,
            },
            safetyPolicy: 'urgent_combat',
        });

        assert.equal(intent.kind, 'RoyalIntent');
        assert.equal(intent.version, 1);
        assert.equal(intent.intent, 'attack');
        assert.equal(intent.actor, 'TestNpc');
        assert.deepEqual(intent.selectedBots, ['TestNpc']);
        assert.equal(intent.priority, 'royal');
        assert.equal(intent.status, 'accepted');
        assert.equal(intent.timeoutMins, 5);
        assert.ok(intent.until > intent.createdAtMs);
        assert.equal(intent.safetyPolicy, 'urgent_combat');
        assert.equal(intent.reportPolicy, 'ack_success_failure');
    });

    test('RoyalIntent lifecycle records resume, finish, last duty and cancellation', () => {
        const bot = {};
        const agent = { name: 'TestNpc', _ownerCommandSeq: 7, bot };
        const intent = createRoyalIntent(agent, 'King', 'gather:wood', {
            timeoutMins: 15,
            target: {
                type: 'resource',
                resource: 'wood',
                count: 12,
            },
        });
        bot._ownerDuty = intent;

        markRoyalIntent(intent, 'running');
        bumpRoyalIntentResume(intent);
        assert.equal(intent.status, 'interrupted_resuming');
        assert.equal(intent.resume.attempts, 1);
        assert.match(formatRoyalDuty(agent), /Current: gather:wood/);

        finishRoyalIntent(bot, intent, {
            success: true,
            value: { large: 'object', should: 'summarize' },
        });
        assert.equal(bot._lastRoyalDuty.status, 'succeeded');
        assert.equal(bot._lastRoyalDuty.result.success, true);
        assert.deepEqual(bot._lastRoyalDuty.result.value, {
            type: 'Object',
            keys: ['large', 'should'],
        });

        const follow = createRoyalIntent(agent, 'King', 'follow', { timeoutMins: -1 });
        bot._ownerDuty = follow;
        cancelRoyalIntent(bot);
        assert.equal(bot._ownerDuty, undefined);
        assert.equal(bot._lastRoyalDuty.status, 'cancelled');
        assert.match(formatRoyalDuty(agent), /Last: follow/);
    });

    test('owner command parser and command registries expose Faza 2/3 controls', () => {
        assert.equal(classifyOwnerCommand('sledi mi 3 minutes').type, 'follow');
        assert.equal(classifyOwnerCommand('napadi zombie').type, 'attack');
        assert.equal(classifyOwnerCommand('napadi').target, 'enemy');
        assert.equal(classifyOwnerCommand('napadi').count, 32);
        assert.equal(classifyOwnerCommand('napadi tri zombije').count, 1);
        assert.equal(classifyOwnerCommand('poglej skrinjo').type, 'chestView');
        assert.equal(classifyOwnerCommand('guard me').type, 'guard');
        assert.equal(classifyOwnerCommand('give me 4 torches').type, 'bring');
        assert.equal(classifyOwnerCommand('follow me and stay close').type, 'follow');
        assert.equal(classifyOwnerCommand('guard me and stay close').type, 'guard');
        assert.equal(classifyOwnerCommand('stop follow me').type, 'stop');
        assert.equal(ownerCommandLooksActionable('naberi les'), true);

        assert.ok(queryList.some(command => command.name === '!loadout'));
        assert.ok(queryList.some(command => command.name === '!royalDuty'));
        assert.ok(queryList.some(command => command.name === '!gameplay'));
        assert.ok(queryList.some(command => command.name === '!loyalty'));
        assert.ok(actionsList.some(command => command.name === '!prepareForTask'));
        assert.ok(actionsList.some(command => command.name === '!follow'));
        assert.ok(actionsList.some(command => command.name === '!defend'));
        assert.ok(actionsList.some(command => command.name === '!defende'));
    });
});

describe('Faza 4 home life', () => {
    test('home-life status is ready with bed, utilities and lighting near home', () => {
        const bot = makeBot({
            username: 'home_life_ready',
            blocks: makeHomeBlocks(),
            items: [makeItem('bread', 3), makeItem('torch', 4)],
            time: { timeOfDay: 1000, day: 2 },
        });
        writeBase(bot);

        const status = getHomeLifeStatus({ bot });
        assert.equal(status.ready, true);
        assert.equal(status.anchorType, 'home');
        assert.equal(status.hasBed, true);
        assert.deepEqual(status.utilities, {
            chest: true,
            crafting: true,
            furnace: true,
        });
        assert.equal(status.lighting.ok, true);
        assert.equal(auditHomeLighting(bot).dark, 0);
        assert.match(formatHomeLifeStatus(status), /HOME LIFE: READY/);
    });

    test('home-life status reports missing bed and dark spots', () => {
        const bot = makeBot({
            username: 'home_life_dark',
            blocks: makeHomeBlocks({ bed: false, torch: false }),
            time: { timeOfDay: 6000, day: 3 },
        });
        writeBase(bot);

        const status = getHomeLifeStatus({ bot });
        assert.equal(status.ready, false);
        assert.ok(status.blockers.includes('needs bed near home'));
        assert.equal(status.lighting.ok, false);
        assert.ok(status.lighting.dark > 0);
        assert.match(formatHomeLifeStatus(status), /NEEDS WORK/);
    });

    test('home-life status treats missing personal corner utilities as not ready', () => {
        const bot = makeBot({
            username: 'home_life_no_corner',
            blocks: makeHomeBlocks({ utilities: false }),
            time: { timeOfDay: 6000, day: 4 },
        });
        writeBase(bot);

        const status = getHomeLifeStatus({ bot });
        assert.equal(status.ready, false);
        assert.ok(status.blockers.includes('personal corner utilities incomplete'));
        assert.match(formatHomeLifeStatus(status), /NEEDS WORK/);

        const action = planHomeLifeAction({ bot }, { stage: 'iron_tools' });
        assert.equal(action.name, 'setupHomeLife');
    });

    test('home-life planner proposes sleep at night and morning prep after waking', () => {
        const nightBot = makeBot({
            username: 'home_life_night',
            blocks: makeHomeBlocks(),
            time: { timeOfDay: 13000, day: 5 },
        });
        writeBase(nightBot);
        const nightAction = planHomeLifeAction({ bot: nightBot }, { stage: 'iron_tools' });
        assert.equal(nightAction.name, 'homeSleep');

        const morningBot = makeBot({
            username: 'home_life_morning',
            blocks: makeHomeBlocks(),
            time: { timeOfDay: 1000, day: 6 },
        });
        writeBase(morningBot);
        const morningAction = planHomeLifeAction({ bot: morningBot }, { stage: 'iron_tools' });
        assert.equal(morningAction.name, 'morningPrep');

        const homelessBootstrapBot = makeBot({
            username: 'home_life_bootstrap',
            blocks: makeHomeBlocks(),
            time: { timeOfDay: 1000, day: 7 },
        });
        const skipped = planHomeLifeAction({ bot: homelessBootstrapBot }, { stage: 'bootstrap' });
        assert.equal(skipped, null);
    });

    test('home-life task cooldown begins only after the selected action starts', () => {
        const bot = makeBot({
            username: 'home_life_start_cooldown',
            blocks: makeHomeBlocks(),
            time: { timeOfDay: 13000, day: 9 },
        });
        writeBase(bot);

        const action = planHomeLifeAction({ bot }, { stage: 'iron_tools' });
        assert.equal(action.name, 'homeSleep');
        assert.equal(bot._homeLifeCooldowns?.sleep, undefined);
        assert.equal(planHomeLifeAction({ bot }, { stage: 'iron_tools' }), action);

        action.onStart();
        assert.ok(Number(bot._homeLifeCooldowns?.sleep) > 0);
        assert.equal(bot._homeLifePendingAction, undefined);
    });

    test('gameplay status includes home-life summary', () => {
        const bot = makeBot({
            username: 'home_life_gameplay',
            blocks: makeHomeBlocks(),
            items: [
                makeItem('stone_pickaxe', 1, { maxDurability: 132, durabilityUsed: 0 }),
                makeItem('stone_sword', 1, { maxDurability: 132, durabilityUsed: 0 }),
                makeItem('stone_axe', 1, { maxDurability: 132, durabilityUsed: 0 }),
                makeItem('bread', 4),
                makeItem('torch', 16),
                makeItem('cobblestone', 16),
            ],
            time: { timeOfDay: 1000, day: 8 },
        });
        writeBase(bot);

        const output = formatGameplayStatus({
            name: 'HomeLifeTester',
            bot,
            isIdle: () => true,
            actions: { currentActionLabel: '' },
            self_prompter: { isStopped: () => false, isPaused: () => false, isActive: () => false },
        });
        assert.match(output, /Home: ready, bed=yes, light=ok, time=Morning/);
        assert.match(output, /Helper: ready/);
    });

    test('command registries expose Faza 4 controls', () => {
        assert.ok(queryList.some(command => command.name === '!homeLife'));
        assert.ok(actionsList.some(command => command.name === '!setupHomeLife'));
        assert.ok(actionsList.some(command => command.name === '!sleepHome'));
        assert.ok(actionsList.some(command => command.name === '!morningPrep'));
        assert.ok(actionsList.some(command => command.name === '!auditHomeLight'));
    });
});

describe('Faza 5 player helper routines', () => {
    test('helper parser understands bring, carry, guard and help-build orders', () => {
        assert.equal(normalizeHelperItem('bakle'), 'torch');
        assert.equal(normalizeHelperItem('lesa'), 'wood');

        const bring = classifyPlayerHelperCommand('prinesi mi 8 bakel', 'King');
        assert.deepEqual({
            type: bring.type,
            item: bring.item,
            count: bring.count,
            targetPlayer: bring.targetPlayer,
        }, {
            type: 'bring',
            item: 'torch',
            count: 8,
            targetPlayer: 'King',
        });

        const bow = classifyPlayerHelperCommand('bring me a bow', 'King');
        assert.equal(bow.item, 'bow');
        assert.equal(bow.count, 1);

        const carry = classifyPlayerHelperCommand('carry the chest items', 'King');
        assert.equal(carry.type, 'carry');
        assert.equal(carry.item, null);

        const guard = classifyPlayerHelperCommand('guard me for 5 minutes', 'King');
        assert.equal(guard.type, 'guard');
        assert.equal(guard.minutes, 5);
        assert.equal(guard.targetPlayer, 'King');

        const help = classifyPlayerHelperCommand('pomagaj mi graditi koca', 'King');
        assert.equal(help.type, 'helpBuild');
        assert.equal(help.buildName, 'koca');
    });

    test('helper status summarizes visible players and carried supplies', () => {
        const bot = makeBot({
            username: 'helper_status_bot',
            blocks: makeHomeBlocks(),
            items: [
                makeItem('bread', 3),
                makeItem('torch', 6),
                makeItem('cobblestone', 20),
                makeItem('stone_axe', 1, { maxDurability: 132, durabilityUsed: 0 }),
                makeItem('stone_pickaxe', 1, { maxDurability: 132, durabilityUsed: 0 }),
            ],
            emptySlots: 8,
        });
        bot.players = {
            King: { entity: { username: 'King', position: new Vec3(2, 64, 2) } },
            helper_status_bot: { entity: bot.entity },
        };
        writeBase(bot);

        const status = getPlayerHelperStatus({ bot });
        assert.equal(status.visiblePlayers.includes('King'), true);
        assert.equal(status.carriedFood, 3);
        assert.equal(status.carriedTorches, 6);
        assert.equal(status.carriedBlocks >= 20, true);
        assert.match(formatPlayerHelperStatus({ bot }), /PLAYER HELPER:/);
    });

    test('command registries expose Faza 5 helper controls', () => {
        assert.ok(queryList.some(command => command.name === '!helperStatus'));
        assert.ok(actionsList.some(command => command.name === '!bringToPlayer'));
        assert.ok(actionsList.some(command => command.name === '!carryNearbyChest'));
        assert.ok(actionsList.some(command => command.name === '!guardPlayer'));
        assert.ok(actionsList.some(command => command.name === '!helpBuild'));
    });
});

describe('Emergency pantry recovery', () => {
    test('reserves emergency status for actual starvation danger', () => {
        assert.equal(needsEmergencyNutrition({ food: 3, health: 20 }), true);
        assert.equal(needsEmergencyNutrition({ food: 6, health: 7 }), true);
        assert.equal(needsEmergencyNutrition({ food: 8, health: 20 }), false);
        assert.equal(needsEmergencyNutrition({ food: 6, health: 20 }), false);
        assert.equal(needsEmergencyNutrition({ food: 18, health: 8 }), false);
    });

    test('secures food before waiting for natural healing when regeneration is impossible', () => {
        assert.equal(needsFoodBeforeHealing(makeBot({ health: 13, food: 5 })), true);
        assert.equal(immediateRecoveryNeed(makeBot({ health: 13, food: 5 })), 'food');
        assert.equal(immediateRecoveryNeed(makeBot({ health: 4, food: 8 })), 'food');
        assert.equal(immediateRecoveryNeed(makeBot({ health: 13, food: 18 })), 'health');
        assert.equal(immediateRecoveryNeed(makeBot({
            health: 13,
            food: 8,
            items: [makeItem('bread', 1)],
        })), 'health');
        assert.equal(immediateRecoveryNeed(makeBot()), null);
        assert.equal(recoveryActionKind(makeBot({ health: 13, food: 5 }), false), 'food');
        assert.equal(recoveryActionKind(makeBot({ health: 13, food: 5 }), true), null);
        assert.equal(recoveryActionKind(makeBot({ health: 13, food: 18 }), true), 'health');
    });

    test('surface recovery stays active until the bot reaches the actual top stand', () => {
        const blocks = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                blocks.push(makeBlock('stone', dx, 52, dz));
                blocks.push(makeBlock('cave_air', dx, 53, dz, { solid: false, skyLight: 0 }));
                blocks.push(makeBlock('cave_air', dx, 54, dz, { solid: false, skyLight: 0 }));
                blocks.push(makeBlock('grass_block', dx, 70, dz));
                blocks.push(makeBlock('air', dx, 71, dz, { solid: false, skyLight: 15 }));
                blocks.push(makeBlock('air', dx, 72, dz, { solid: false, skyLight: 15 }));
            }
        }
        const bot = makeBot({ username: 'surface_recovery_bot', blocks });
        writeBase(bot);
        bot.entity.position = new Vec3(0, 53, 0);
        assert.equal(isSurfaceRecoveryComplete(bot), false);
        bot.entity.position = new Vec3(0, 71, 0);
        assert.equal(isSurfaceRecoveryComplete(bot), true);
    });

    test('uses prepared food before crafting or cooking', () => {
        assert.deepEqual(planEmergencyFood({ cooked_beef: 6, wheat: 18, beef: 8 }, 6), {
            target: 6,
            prepared: 6,
            craftBread: 0,
            cook: [],
            missing: 0,
        });
    });

    test('turns stored wheat into bread before raw meat', () => {
        assert.deepEqual(planEmergencyFood({ bread: 1, wheat: 12, beef: 8 }, 6), {
            target: 6,
            prepared: 1,
            craftBread: 4,
            cook: [{ name: 'beef', count: 1 }],
            missing: 0,
        });
    });

    test('plans furnace work for raw meat and potatoes', () => {
        assert.deepEqual(planEmergencyFood({ porkchop: 2, potato: 5 }, 6), {
            target: 6,
            prepared: 0,
            craftBread: 0,
            cook: [
                { name: 'porkchop', count: 2 },
                { name: 'potato', count: 4 },
            ],
            missing: 0,
        });
    });

    test('does not double-count legacy fish and its modern alias', () => {
        assert.deepEqual(planEmergencyFood({ fish: 4, cod: 4 }, 6), {
            target: 6,
            prepared: 0,
            craftBread: 0,
            cook: [{ name: 'cod', count: 4 }],
            missing: 2,
        });
    });

    test('orders chest candidates as cooked food, wheat, safe raw food, banned raw food', () => {
        const bot = makeBot();
        const candidates = [
            makeItem('chicken', 16),
            makeItem('beef', 8),
            makeItem('wheat', 12),
            makeItem('bread', 4),
        ];
        const ordered = selectMatchingItems(
            candidates,
            () => true,
            item => pantryItemPriority(item, bot),
        );
        assert.deepEqual(ordered.map(item => item.name), ['bread', 'wheat', 'beef', 'chicken']);
    });

    test('allows a chest withdrawal into an existing partial stack when inventory is full', () => {
        const bot = makeBot({
            items: [makeItem('bread', 32, { type: 297, stackSize: 64 })],
            emptySlots: 0,
        });
        assert.equal(inventoryCanReceive(bot, makeItem('bread', 8, { type: 297, stackSize: 64 })), true);
        bot.inventory.slots[9].count = 63;
        assert.equal(inventoryReceiveCapacity(bot, makeItem('bread', 8, { type: 297, stackSize: 64 })), 1);
        assert.equal(inventoryCanReceive(bot, makeItem('beef', 8, { type: 363, stackSize: 64 })), false);
    });

    test('accounts for active furnace burn and clamps inventory fuel capacity', () => {
        assert.equal(furnaceHasActiveFuel({ fuelItem: () => null, fuelSeconds: 4, fuel: 0.25 }), true);
        assert.equal(furnaceHasActiveFuel({ fuelItem: () => null, fuelSeconds: 0, fuel: 0 }), false);
        assert.equal(selectedFuelSmeltCapacity(makeBot({ items: [makeItem('oak_planks', 1)] })), 1);
        assert.equal(selectedFuelSmeltCapacity(makeBot({ items: [makeItem('coal', 1)] })), 8);
    });

    test('times out a swallowed furnace GUI without leaking window listeners', async () => {
        const bot = new EventEmitter();
        bot.inventory = {};
        bot.currentWindow = null;
        bot.openFurnace = async () => (await once(bot, 'windowOpen'))[0];
        bot.closeWindow = () => {};
        const windowListeners = bot.listenerCount('windowOpen');
        const errorListeners = bot.listenerCount('error');

        await assert.rejects(openFurnaceAttempt(bot, {}, 15), /furnace open timed out/);
        assert.equal(bot.listenerCount('windowOpen'), windowListeners);
        assert.equal(bot.listenerCount('error'), errorListeners);
    });

    test('shared furnace clears stale output and uses an active burn for the new food batch', async () => {
        const furnaceBlock = makeBlock('furnace', 1, 64, 0, { type: 61 });
        const bot = makeBot({
            username: 'emergency_smelt_bot',
            items: [makeItem('beef', 1, { type: 363, stackSize: 64 })],
            blocks: [furnaceBlock],
        });
        bot.registry = {
            blocksByName: { furnace: { id: 61 } },
            itemsByName: {
                beef: { id: 363 },
                cooked_beef: { id: 364 },
                coal: { id: 263 },
                iron_ingot: { id: 265 },
            },
        };
        bot.findBlocks = () => [furnaceBlock.position];
        bot.blockAt = () => furnaceBlock;
        bot.modes = { pause: () => {}, unpause: () => {} };
        bot.lookAt = async () => {};
        const events = new EventEmitter();
        for (const method of ['listeners', 'removeListener', 'on', 'once', 'emit'])
            bot[method] = events[method].bind(events);

        let output = makeItem('iron_ingot', 1, { type: 265, stackSize: 64 });
        let outputTakes = 0;
        let fuelPuts = 0;
        const furnace = {
            fuel: 0.5,
            fuelSeconds: 8,
            inputItem: () => null,
            fuelItem: () => null,
            outputItem: () => output,
            takeOutput: async () => {
                const taken = output;
                output = null;
                outputTakes += 1;
                return taken;
            },
            putFuel: async () => { fuelPuts += 1; },
            putInput: async () => {
                bot.inventory.slots[9] = null;
                output = makeItem('cooked_beef', 1, { type: 364, stackSize: 64 });
            },
            close: async () => {},
        };
        bot.openFurnace = async () => furnace;

        assert.equal(await smeltItem(bot, 'beef', 1), true, bot.output);
        assert.equal(outputTakes, 2);
        assert.equal(fuelPuts, 0);
    });
});

describe('Mining expedition movement policy', () => {
    test('uses 1.20.1 ore layers, including negative deepslate coordinates', () => {
        assert.equal(preferredOreY(['diamond_ore', 'deepslate_diamond_ore'], '1.20.1'), -54);
        assert.equal(preferredOreY('redstone', '1.20.1'), -54);
        assert.equal(preferredOreY('gold', '1.20.1'), -16);
        assert.equal(preferredOreY('lapis', '1.20.1'), 0);
        assert.equal(preferredOreY('iron', '1.20.1'), 16);
        assert.equal(preferredOreY('coal', '1.20.1'), 48);
    });

    test('rallies only while approaching on the surface, not after descending the shaft', () => {
        const entrance = { x: 0, y: 68, z: 0 };
        assert.equal(shouldRallyAtEntrance(new Vec3(12, 68, 0), entrance), true);
        assert.equal(shouldRallyAtEntrance(new Vec3(3, 68, 0), entrance), false);
        assert.equal(shouldRallyAtEntrance(new Vec3(12, 60, 0), entrance), false);
        assert.equal(shouldRallyAtEntrance(new Vec3(24, 14, 0), entrance), false);
    });

    test('assigns the first four expedition members separate tunnel branches', () => {
        const expedition = {
            startedAt: 123,
            members: ['Blaz', 'Lara', 'Maja', 'Nejc'],
        };
        const branches = expedition.members.map(name => expeditionBranchDirection(expedition, name));
        assert.equal(new Set(branches.map(({ x, z }) => `${x},${z}`)).size, 4);
        assert.deepEqual(branches[0], { x: 1, z: 0 });
    });

    test('rotates a stalled miner onto another cardinal branch', () => {
        const expedition = { startedAt: 123, members: ['Lara', 'Maja'] };
        assert.notDeepEqual(
            expeditionBranchDirection(expedition, 'Lara', 1),
            expeditionBranchDirection(expedition, 'Lara'),
        );
    });

    test('does not draft a wooden-pickaxe member into a diamond expedition', () => {
        const member = {
            health: 20,
            hunger: 20,
            inventory: { pickaxes: 1, bestPickaxeTier: 1 },
        };
        assert.equal(memberCanJoinExpedition(member, 'iron'), true);
        assert.equal(memberCanJoinExpedition(member, 'diamond'), false);
        member.inventory.bestPickaxeTier = 3;
        assert.equal(memberCanJoinExpedition(member, 'diamond'), true);
    });

    test('opens a shared iron expedition for a deterministic progression request', async () => {
        const expeditionFile = join(tempCwd, 'bots', 'mining-expedition.json');
        mkdirSync(join(tempCwd, 'bots'), { recursive: true });
        writeFileSync(expeditionFile, JSON.stringify({ active: false, lastStartedAt: 0 }));
        const bot = makeBot({
            username: 'progression_mining_request',
            items: [makeItem('stone_pickaxe')],
            blocks: makeHomeBlocks({ bed: false, utilities: false, torch: false }),
        });
        const request = await requestResourceExpedition({ name: bot.username, bot }, 'iron', 9);

        assert.equal(request.created, true);
        assert.equal(request.active, true);
        const persisted = JSON.parse(readFileSync(expeditionFile, 'utf8'));
        assert.equal(persisted.resource, 'iron');
        assert.equal(persisted.requestedBy, bot.username);
        assert.equal(persisted.requestedAmount, 9);
    });

    test('merges per-bot resource requests without double-counting retries', async () => {
        const expeditionFile = join(tempCwd, 'bots', 'mining-expedition.json');
        mkdirSync(join(tempCwd, 'bots'), { recursive: true });
        writeFileSync(expeditionFile, JSON.stringify({ active: false, lastStartedAt: 0 }));
        const blocks = makeHomeBlocks({ bed: false, utilities: false, torch: false });
        const first = makeBot({ username: 'iron_request_a', items: [makeItem('stone_pickaxe')], blocks });
        const second = makeBot({ username: 'iron_request_b', items: [makeItem('stone_pickaxe')], blocks });

        await requestResourceExpedition({ name: first.username, bot: first }, 'iron', 9);
        await requestResourceExpedition({ name: second.username, bot: second }, 'iron', 7);
        await requestResourceExpedition({ name: first.username, bot: first }, 'iron', 9);

        const persisted = JSON.parse(readFileSync(expeditionFile, 'utf8'));
        assert.equal(persisted.requestedAmount, 16);
        assert.equal(persisted.requests.iron_request_a.amount, 9);
        assert.equal(persisted.requests.iron_request_b.amount, 7);
    });

    test('uses requested amount for safe shared quotas and global progress', () => {
        const expedition = {
            resource: 'diamond',
            requestedAmount: 8,
            members: ['A', 'B', 'C'],
            progress: { A: 3, B: 2, C: 1 },
        };
        assert.equal(expeditionMemberQuota(expedition), 3);
        assert.equal(expeditionProgress(expedition), 6);
        expedition.requestedAmount = 2;
        assert.equal(expeditionMemberQuota(expedition), 1);
    });
});

describe('Persistent progression milestones', () => {
    test('classifies interruption separately from a real milestone failure', () => {
        const outcome = normalizeMilestoneAttemptOutcome('stoneTools', false, {
            interrupted: true,
        });
        assert.equal(outcome.kind, 'interrupted');
        assert.equal(outcome.milestone, 'stoneTools');
    });

    test('preserves explicit partial milestone progress', () => {
        const progress = normalizeMilestoneAttemptOutcome('stoneTools', {
            kind: 'progress', milestone: 'stoneTools', message: 'obtained a stone pickaxe',
        });
        assert.equal(progress.kind, 'progress');
        assert.match(progress.message, /pickaxe/);
    });

    test('unlocks multiple milestone branches instead of one mandatory next step', () => {
        const bot = makeBot({ username: 'progression_dag_branches' });
        writeProgression(bot, {
            milestones: { stoneTools: true, ironTools: true },
            lastStage: 'iron_tools',
            updatedAt: new Date().toISOString(),
        });

        const status = getProgressionStatus(bot);
        const open = new Set(status.availableMilestones.map(milestone => milestone.id));
        assert.equal(open.has('homestead'), true);
        assert.equal(open.has('starterUtility'), true);
        assert.equal(open.has('ironUtility'), true);
        assert.equal(open.has('ironArmor'), true);
        assert.equal(open.has('diamondTools'), true);
        assert.equal(open.has('diamondArmor'), true);

        const candidates = progressionActionCandidates({ name: bot.username, bot }, status);
        assert.deepEqual(new Set(candidates.map(candidate => candidate.key)),
            new Set([...open].map(id => `milestone:${id}`)));
    });

    test('advanced utility declares real DAG prerequisites', () => {
        const advanced = getMilestoneGraph('diamond')
            .find(milestone => milestone.id === 'advancedUtility');
        assert.deepEqual(advanced.requires, ['diamondTools', 'homestead']);
        assert.ok(queryList.some(command => command.name === '!progress'));
        assert.ok(queryList.some(command => command.name === '!decisions'));
    });

    test('validates the enabled milestone graph and exposes dynamic cost estimates', () => {
        const validation = validateMilestoneGraph('diamond');
        assert.equal(validation.valid, true, validation.errors.join('\n'));
        assert.equal(new Set(validation.order).size, validation.order.length);

        const bot = makeBot({ username: 'progression_cost_estimate' });
        writeProgression(bot, { milestones: { stoneTools: true }, updatedAt: new Date().toISOString() });
        const status = getProgressionStatus(bot);
        const estimate = estimateMilestone({ name: bot.username, bot }, 'ironTools', status);
        assert.ok(estimate.estimatedCost > 0);
        assert.ok(estimate.unlockValue > 0);
        const candidate = progressionActionCandidates({ name: bot.username, bot }, status)
            .find(entry => entry.key === 'milestone:ironTools');
        assert.equal(candidate.estimatedCost, estimate.estimatedCost);
        assert.equal(candidate.unlockValue, estimate.unlockValue);
    });

    test('migrates a legacy stage without rewinding to missing earlier gear', () => {
        const bot = makeBot({ username: 'legacy_progression_migration' });
        writeProgression(bot, {
            shelterComplete: true,
            lastStage: 'iron_tools',
            updatedAt: new Date().toISOString(),
        });

        const status = getProgressionStatus(bot);
        assert.equal(status.stage, 'iron_tools');
        assert.equal(status.milestones.stoneTools, true);
        assert.equal(status.milestones.homestead, true);
        assert.equal(status.milestones.starterUtility, true);
        assert.equal(status.readiness.stoneTools, false);
    });

    test('spending torches does not rewind an achieved starter milestone', () => {
        const bot = makeBot({
            username: 'persistent_starter_utility',
            items: [
                makeItem('stone_pickaxe'),
                makeItem('stone_axe'),
                makeItem('stone_sword'),
                makeItem('torch', 16),
            ],
        });
        writeProgression(bot, {
            shelterComplete: true,
            lastStage: 'starter_utility',
            updatedAt: new Date().toISOString(),
        });

        assert.equal(getProgressionStatus(bot).stage, 'iron_tools');
        const torch = bot.inventory.slots.find(item => item?.name === 'torch');
        bot.inventory.slots[torch.slot] = null;

        const afterSpending = getProgressionStatus(bot);
        assert.equal(afterSpending.stage, 'iron_tools');
        assert.equal(afterSpending.milestones.starterUtility, true);
        assert.equal(afterSpending.readiness.starterUtility, false);
    });

    test('merely selecting a progression action does not consume its cooldown', () => {
        const bot = makeBot({ username: 'progression_selection_cooldown' });
        writeProgression(bot, {
            shelterComplete: true,
            lastStage: 'iron_tools',
            updatedAt: new Date().toISOString(),
        });
        const agent = { name: bot.username, bot };
        const status = getProgressionStatus(bot);

        assert.equal(nextProgressionAction(agent, status)?.name, 'progress:ironTools');
        assert.equal(nextProgressionAction(agent, status)?.name, 'progress:ironTools');
    });
});

describe('Shared state safety', () => {
    test('container indexing installs at spawn when Mineflayer attaches openContainer late', async () => {
        const block = makeBlock('chest', 3, 64, 3);
        const bot = new EventEmitter();
        Object.assign(bot, {
            username: 'late_container_index_bot',
            game: { dimension: 'late-container-index-dimension' },
            interrupt_code: false,
        });
        assert.equal(installContainerIndex(bot), false);
        bot.openContainer = async () => ({
            containerItems: () => [makeItem('bread', 2, { type: 297 })],
            close: async () => {},
        });
        bot.emit('spawn');

        await bot.openContainer(block);
        const indexed = inspectContainerIndex(
            bot,
            [block.position],
            item => item.name === 'bread',
        );
        assert.equal(indexed.complete, true);
        assert.equal(indexed.total, 2);
    });

    test('shared container index snapshots opens and post-mutation closes', async () => {
        const block = makeBlock('chest', 4, 64, 2);
        const bot = makeBot({
            username: 'container_index_bot',
            dimension: 'container-index-dimension',
        });
        let contents = [makeItem('bread', 3, { type: 297 })];
        let closeCalls = 0;
        const container = {
            containerItems: () => contents,
            close: async () => { closeCalls += 1; },
        };
        bot.openContainer = async () => container;
        assert.equal(installContainerIndex(bot), true);

        const opened = await bot.openContainer(block);
        const withBread = inspectContainerIndex(
            bot,
            [block.position],
            item => item.name === 'bread',
        );
        assert.equal(withBread.complete, true);
        assert.equal(withBread.total, 3);

        contents = [];
        await opened.close();
        const empty = inspectContainerIndex(
            bot,
            [block.position],
            item => item.name === 'bread',
        );
        assert.equal(empty.complete, true);
        assert.equal(empty.matches.length, 0);
        assert.equal(closeCalls, 1);
    });

    test('known-empty public storage skips travel and becomes unknown after expiry', async () => {
        const position = new Vec3(8, 64, 8);
        const bot = makeBot({
            username: 'known_empty_storage_bot',
            dimension: 'known-empty-storage-dimension',
        });
        mkdirSync(join(tempCwd, 'bots'), { recursive: true });
        writeFileSync(join(tempCwd, 'bots', 'public-storage.json'), JSON.stringify({
            dimension: bot.game.dimension,
            x: position.x,
            y: position.y,
            z: position.z,
            radius: 10,
            containers: [{ x: position.x, y: position.y, z: position.z }],
        }));
        const observedAt = Date.now();
        await recordContainerSnapshot(bot, position, { containerItems: () => [] }, observedAt);

        assert.equal(await takeAnyPublic(bot, ['diamond'], 1), false);
        const stale = inspectContainerIndex(
            bot,
            [position],
            item => item.name === 'diamond',
            { now: observedAt + 5 * 60_000 + 1 },
        );
        assert.equal(stale.complete, false);
        assert.equal(stale.unknown.length, 1);
    });

    test('named locks serialize bots even when they are in different dimensions', async () => {
        const lockName = `cross-dimension-${Date.now()}-${Math.random()}`;
        const firstBot = makeBot({ username: 'lock_first', dimension: 'overworld' });
        const secondBot = makeBot({ username: 'lock_second', dimension: 'the_nether' });
        const order = [];
        let releaseFirst;
        let markFirstEntered;
        const firstEntered = new Promise(resolve => { markFirstEntered = resolve; });
        const firstGate = new Promise(resolve => { releaseFirst = resolve; });

        const first = withNamedLock(firstBot, lockName, async () => {
            order.push('first-start');
            markFirstEntered();
            await firstGate;
            order.push('first-end');
        }, 1000);
        await firstEntered;
        const second = withNamedLock(secondBot, lockName, () => {
            order.push('second');
        }, 1000);

        try {
            await new Promise(resolve => setTimeout(resolve, 75));
            assert.deepEqual(order, ['first-start']);
        } finally {
            releaseFirst();
        }
        const results = await Promise.all([first, second]);
        assert.equal(results.every(result => result.locked), true);
        assert.deepEqual(order, ['first-start', 'first-end', 'second']);
    });

    test('non-interruptible named locks remain available for budget accounting', async () => {
        const bot = makeBot({ username: 'interrupted_lock' });
        bot.interrupt_code = true;
        const skipped = await withNamedLock(bot, 'interruptible-test', () => true, 50);
        const acquired = await withNamedLock(bot, 'non-interruptible-test', () => true, 50, {
            interruptible: false,
        });
        assert.equal(skipped.locked, false);
        assert.equal(acquired.locked, true);
        assert.equal(acquired.value, true);
    });

    test('atomic JSON writes replace the file without leaving temporary files', () => {
        const directory = join(tempCwd, 'atomic-json');
        const file = join(directory, 'state.json');
        writeJsonAtomic(file, { version: 1 });
        writeJsonAtomic(file, { version: 2, ok: true });
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 2, ok: true });
        assert.deepEqual(readdirSync(directory), ['state.json']);
    });
});
