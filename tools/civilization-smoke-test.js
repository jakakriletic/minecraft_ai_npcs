#!/usr/bin/env node
// Offline civilization smoke tests for the Altera/PIANO kingdom layer.
// These tests do not connect to Minecraft, do not call an LLM, and do not touch the
// real bots/ state. They exercise the deterministic parts that make civilization
// development possible: social perception, recursive social goals, action awareness,
// coherent intention, and culture convergence.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import rootSettings from '../settings.js';
import { setSettings } from '../src/agent/settings.js';
import { assessAwareness } from '../src/agent/roleplay/awareness.js';
import { tick as tickCognition, describeIntention } from '../src/agent/roleplay/cognition.js';
import { perceive, socialContext } from '../src/agent/roleplay/social_awareness.js';
import { generateSocialGoals, socialGoalContext } from '../src/agent/roleplay/social_goals.js';
import { getCultureState, tickCulture } from '../src/agent/library/culture.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-civ-'));
const nowIso = () => new Date().toISOString();

function setTestSettings(overrides = {}) {
    setSettings({
        ...rootSettings,
        cognition: {
            ...(rootSettings.cognition ?? {}),
            awareness_enabled: true,
            controller_enabled: true,
            social_perception_enabled: true,
            social_goals_enabled: true,
            culture_enabled: false,
            reflection_enabled: false,
            plan_stall_seconds: 1,
            culture_tick_seconds: 1,
            culture_convergence_rate: 0.06,
            ...overrides,
        },
    });
}

function vec(x, y, z) {
    return {
        x,
        y,
        z,
        distanceTo(other) {
            return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
        },
        offset(dx, dy, dz) {
            return vec(this.x + dx, this.y + dy, this.z + dz);
        },
        clone() {
            return vec(this.x, this.y, this.z);
        },
    };
}

function makeInventory(items) {
    const slots = items.map(item => ({ ...item, type: item.type ?? item.name, metadata: item.metadata ?? null }));
    return {
        slots,
        items() {
            return slots.filter(Boolean);
        },
        emptySlotCount() {
            return Math.max(0, 36 - slots.length);
        },
    };
}

function makeBot(username, items = [], playerPositions = {}) {
    const bot = {
        username,
        inventory: makeInventory(items),
        entity: { position: vec(0, 64, 0) },
        players: {},
        game: { dimension: 'overworld' },
        health: 20,
        food: 20,
        interrupt_code: false,
        chatLog: [],
        chat(line) {
            this.chatLog.push(line);
        },
    };
    for (const [name, position] of Object.entries(playerPositions)) {
        bot.players[name] = { username: name, entity: { position } };
    }
    return bot;
}

function makeAgent(name, items = [], personality = {}, playerPositions = {}) {
    const bot = makeBot(name, items, playerPositions);
    return {
        name,
        bot,
        personality: {
            name,
            baseRole: 'tester',
            socialStyle: 'practical',
            temperament: 'steady',
            courage: 0.5,
            altruism: 0.5,
            ambition: 0.5,
            caution: 0.5,
            humor: 0.5,
            orderliness: 0.5,
            ...personality,
        },
        prompter: { profile: { name } },
        actions: { executing: false, currentActionLabel: 'idle' },
        _brain: {},
    };
}

function seedKingdomState() {
    mkdirSync('bots', { recursive: true });
    writeFileSync('bots/kingdom.json', JSON.stringify({
        version: 1,
        name: 'TestKingdom',
        center: { x: 0, y: 64, z: 0, dimension: 'overworld' },
        members: {
            Ana: {
                role: 'farmer',
                online: true,
                position: { x: 0, y: 64, z: 0, dimension: 'overworld' },
                inventory: { food: 8, wood: 0, stone: 0, iron: 0, coal: 0, torches: 12, pickaxes: 1, swords: 1 },
                progression: 'iron_tools',
                action: 'brain:idle',
                seenAt: nowIso(),
            },
            Rok: {
                role: 'miner',
                online: true,
                position: { x: 6, y: 64, z: 0, dimension: 'overworld' },
                inventory: { food: 0, wood: 0, stone: 0, iron: 0, coal: 0, torches: 0, pickaxes: 0, swords: 1 },
                progression: 'bootstrap',
                action: 'brain:kingdomShare',
                seenAt: nowIso(),
            },
        },
        knownBiomes: [],
        events: [],
        transfers: {},
        metrics: { buildingCount: 0, roadCount: 0 },
        culture: {
            version: 1,
            norms: {
                sharing_expectation: 0.5,
                night_caution: 0.5,
                build_density_preference: 0.5,
            },
            members: {
                Ana: {
                    norms: {
                        sharing_expectation: 0.2,
                        night_caution: 0.4,
                        build_density_preference: 0.5,
                    },
                    updatedAt: nowIso(),
                },
                Rok: {
                    norms: {
                        sharing_expectation: 0.8,
                        night_caution: 0.7,
                        build_density_preference: 0.4,
                    },
                    updatedAt: nowIso(),
                },
            },
            settlement_value: 'Shared supplies matter more than hoarding.',
            updatedAt: nowIso(),
        },
        updatedAt: nowIso(),
    }, null, 2));
}

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

test('social goals create a deliverable help goal from a model of another member', () => {
    setTestSettings();
    const agent = makeAgent('Ana', [
        { name: 'bread', count: 8 },
        { name: 'torch', count: 16 },
        { name: 'stone_pickaxe', count: 2 },
    ], { altruism: 0.9, ambition: 0.2, orderliness: 0.7 });

    const state = {
        society: {
            resourceNeed: { resource: 'food', ratio: 0.25 },
            members: [{
                name: 'Rok',
                inventory: { food: 0, pickaxes: 1, swords: 1, torches: 0 },
                action: 'brain:planIron',
                progression: 'iron_tools',
            }],
        },
        socialOpinions: {
            Rok: { needs: ['hrana', 'bakle'], competence: 0.7, lastSeenDoing: 'planIron' },
        },
        relations: [{
            to: 'Rok',
            friendship: 0.7,
            trust: 0.8,
            respect: 0.6,
            debt: 0.4,
            rivalry: 0,
            annoyance: 0,
        }],
        nearbyPlayers: [],
    };

    const goals = generateSocialGoals(agent, state);
    const help = goals.find(goal => goal.kind === 'help' && goal.target === 'Rok');
    assert.ok(help, 'expected a help goal for Rok');
    assert.equal(help.item, 'bread');
    assert.ok(help.score >= 0.5, `expected actionable help score, got ${help.score}`);
    assert.match(socialGoalContext(agent, state), /pomagam Rok/);
});

test('social goals also produce rivalry and settlement-gap motives', () => {
    setTestSettings();
    const agent = makeAgent('Lara', [], { ambition: 0.9, orderliness: 0.9, altruism: 0.2 });
    const state = {
        society: {
            resourceNeed: { resource: 'stone', ratio: 0.1 },
            members: [{
                name: 'Zan',
                inventory: { food: 5, pickaxes: 1, swords: 1, torches: 6 },
                action: 'brain:idle',
                progression: 'iron_tools',
            }],
        },
        socialOpinions: {
            Zan: { needs: [], competence: 0.65, lastSeenDoing: 'idle' },
        },
        relations: [{
            to: 'Zan',
            friendship: 0.2,
            trust: 0.5,
            respect: 0.6,
            debt: 0,
            rivalry: 0.7,
            annoyance: 0.1,
        }],
        nearbyPlayers: [],
    };

    const kinds = new Set(generateSocialGoals(agent, state).map(goal => goal.kind));
    assert.ok(kinds.has('outproduce'), 'expected rivalry/out-produce motive');
    assert.ok(kinds.has('cover_gap'), 'expected settlement resource-gap motive');
});

test('social goals create a visible check-in goal for a hurt member', () => {
    setTestSettings();
    const agent = makeAgent('Lara', [], { altruism: 0.9, ambition: 0.2, orderliness: 0.5 });
    const state = {
        society: {
            resourceNeed: { resource: 'food', ratio: 0.8 },
            members: [{
                name: 'Maja',
                inventory: { food: 4, pickaxes: 1, swords: 1, torches: 4 },
                action: 'idle',
                progression: 'iron_tools',
                health: 16,
                hunger: 18,
            }],
        },
        socialOpinions: {
            Maja: { needs: [], competence: 0.6, lastSeenDoing: 'idle' },
        },
        relations: [{
            to: 'Maja',
            friendship: 0.3,
            trust: 0.62,
            respect: 0.55,
            debt: 0,
            rivalry: 0,
            annoyance: 0,
        }],
        nearbyPlayers: [],
    };

    const checkIn = generateSocialGoals(agent, state)
        .find(goal => goal.kind === 'check_in' && goal.target === 'Maja');
    assert.ok(checkIn, 'expected a check-in goal for a hurt member');
    assert.ok(checkIn.score >= 0.42, `expected actionable check-in score, got ${checkIn.score}`);
});

test('action awareness detects a stalled countable plan', () => {
    setTestSettings();
    const agent = makeAgent('Nejc', [], { caution: 0.9 });
    agent.actions = { executing: true, currentActionLabel: 'brain:gatherWood' };
    agent._plan = {
        planId: 'p1',
        focus: 'stockpile',
        resource: 'wood',
        amount: 8,
        completed: false,
        expiresAt: Date.now() + 60_000,
    };
    agent._aware = {
        planBaseline: { planId: 'p1', count: 0, since: Date.now() - 25_000 },
        lastPos: vec(0, 64, 0),
        lastInvTotal: 0,
        lastProgressAt: Date.now() - 25_000,
    };

    const awareness = assessAwareness(agent);
    assert.equal(awareness.planTargetRatio, 0);
    assert.equal(awareness.flags.planStalled, true);
    assert.ok(awareness.frustration > 0, 'stalled plan should raise frustration');
});

test('cognitive controller grounds speech intent in the real action', () => {
    setTestSettings();
    const agent = makeAgent('Tilen', [], { courage: 0.8 });
    agent._awareness = {
        currentAction: 'planIron',
        msOnAction: 1000,
        makingProgress: true,
        planTargetRatio: null,
        idleMs: 0,
        frustration: 0,
        flags: { stuck: false, planStalled: false, idleTooLong: false },
    };

    const intention = tickCognition(agent, { name: 'planIron' });
    assert.equal(intention.topic, 'mine');
    assert.equal(agent._intention.actionName, 'planIron');
    assert.match(describeIntention(agent, { includeActionName: true }), /real action: planIron/);
});

test('social perception reads other members from shared kingdom state', () => {
    setTestSettings();
    seedKingdomState();
    const agent = makeAgent('Ana', [], { altruism: 0.8 }, { Rok: vec(6, 64, 0) });
    agent._socialAware = { model: {}, lastNudge: {}, lastNudgeAt: Date.now() };

    perceive(agent);

    assert.ok(agent._socialAware.model.Rok, 'expected an opinion model for Rok');
    assert.deepEqual(agent._socialAware.model.Rok.needs.sort(), ['bakle', 'hrana', 'kramp'].sort());
    assert.match(socialContext(agent), /Rok/);
});

test('culture convergence moves member norms after nearby cooperation', async () => {
    setTestSettings({ culture_enabled: true });
    seedKingdomState();
    const agent = makeAgent('Ana', [], { altruism: 0.9 }, { Rok: vec(6, 64, 0) });
    agent._culture = { lastTickAt: 0 };

    const result = await tickCulture(agent);
    assert.ok(result, 'expected a culture tick result');
    const culture = getCultureState();
    assert.equal(culture.last_interaction.from, 'Ana');
    assert.equal(culture.last_interaction.to, 'Rok');
    assert.ok(
        culture.members.Ana.norms.sharing_expectation > 0.2,
        `expected Ana sharing norm to rise, got ${culture.members.Ana.norms.sharing_expectation}`,
    );
});

let failed = 0;
try {
    process.chdir(tempRoot);
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`PASS ${name}`);
        } catch (error) {
            failed++;
            console.error(`FAIL ${name}`);
            console.error(error.stack ?? error.message);
        }
    }
} finally {
    process.chdir(repoRoot);
    rmSync(tempRoot, { recursive: true, force: true });
}

if (failed > 0) {
    console.error(`\n${failed} civilization smoke test(s) failed.`);
    process.exit(1);
}

console.log(`\n${tests.length} civilization smoke tests passed.`);
