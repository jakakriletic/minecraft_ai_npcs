import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import express from 'express';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';

import {
    canSourceRunAction,
    executeCommand,
    isConfiguredOwner,
    parseCommandMessage,
    shouldSuppressGeneratedAction,
    truncCommandMessage,
} from '../src/agent/commands/index.js';
import {
    blockMatchesName,
    babyMetadataIndex,
    isBedBlock,
    legacyBlockSpec,
    legacyItemSpec,
    setBlockCommand,
    usesExpandedWorldHeight,
} from '../src/utils/mc_compat.js';
import { selectAPI } from '../src/models/_model_map.js';
import { attachRpDashboardApi } from '../src/mindcraft/rp_dashboard.js';
import { parseKickReason } from '../src/agent/connection_handler.js';
import { isFatalRpKickReason, Npc } from '../src/rp/npc.js';
import settings, { setSettings } from '../src/agent/settings.js';
import rootSettings from '../settings.js';
import { isHostile } from '../src/utils/mcdata.js';
import { isAllowedOrderedTarget } from '../src/agent/library/combat.js';
import { shouldFleeRecentDamage } from '../src/agent/modes.js';
import {
    combatParams,
    combatSlot,
    safestRetreatPosition,
    selectCombatThreat,
    shouldFightThreat,
    trajectoryClearOfFriendPositions,
} from '../src/rp/systems/liveness.js';

test('starvation damage does not pre-empt food recovery with a fake retreat', () => {
    const now = 10_000;
    const damaged = { lastDamageTime: now - 100, lastDamageTaken: 2, health: 6, food: 0 };
    assert.equal(shouldFleeRecentDamage(damaged, false, now), false);
    assert.equal(shouldFleeRecentDamage(damaged, true, now), true);
    assert.equal(shouldFleeRecentDamage({ ...damaged, food: 5 }, false, now), true);
    assert.equal(shouldFleeRecentDamage({ ...damaged, lastDamageTime: now - 4000 }, true, now), false);
});

describe('command parsing regressions', () => {
    test('keeps human-form arguments when truncating model output', () => {
        const truncated = truncCommandMessage('Okay: !guardPlayer Steve 5 ignore this');
        assert.equal(truncated, 'Okay: !guardPlayer Steve 5');
        assert.deepEqual(parseCommandMessage(truncated), {
            commandName: '!guardPlayer',
            args: ['Steve', 5],
        });
    });

    test('keeps parenthesized syntax and supports an omitted optional argument', () => {
        assert.equal(
            truncCommandMessage('Okay: !guardPlayer("Steve", 5) ignore this'),
            'Okay: !guardPlayer("Steve", 5)',
        );
        assert.deepEqual(parseCommandMessage('!guardPlayer Steve'), {
            commandName: '!guardPlayer',
            args: ['Steve', undefined],
        });
    });

    test('supports loyal squad aliases and a targetless all-hostiles attack', () => {
        assert.deepEqual(parseCommandMessage('!follow'), {
            commandName: '!follow',
            args: [undefined],
        });
        assert.deepEqual(parseCommandMessage('!defende'), {
            commandName: '!defende',
            args: [undefined],
        });
        assert.deepEqual(parseCommandMessage('!attack'), {
            commandName: '!attack',
            args: [undefined, undefined],
        });
        assert.deepEqual(parseCommandMessage('!attack zombie 3'), {
            commandName: '!attack',
            args: ['zombie', 3],
        });
    });

    test('only the configured owner can issue player-originated action commands', async () => {
        const previous = { ...settings };
        try {
            setSettings({
                minecraft_version: '1.20.1',
                owner_player: 'jakakriletic',
                owner_only_commands: true,
            });
            const agent = { name: 'Blaz' };
            assert.equal(isConfiguredOwner('JAKAKRILETIC'), true);
            assert.equal(canSourceRunAction(agent, 'jakakriletic'), true);
            assert.equal(canSourceRunAction(agent, 'randomPlayer'), false);
            assert.equal(canSourceRunAction(agent, 'system'), true);
            assert.match(
                await executeCommand(agent, '!stop', 'randomPlayer'),
                /owner-only.*jakakriletic/i,
            );
        } finally {
            setSettings(previous);
        }
    });

    test('a death reaction cannot turn into an autonomous return-to-death command', () => {
        const deathPrompt = "You died at position x: 1, y: 64, z: 2 in the overworld dimension with the final message: 'Zan was slain'.";
        assert.equal(shouldSuppressGeneratedAction('system', deathPrompt, '!goToRememberedPlace'), true);
        assert.equal(shouldSuppressGeneratedAction('system', 'Continue your assigned task.', '!goToRememberedPlace'), false);
        assert.equal(shouldSuppressGeneratedAction('jakakriletic', deathPrompt, '!goToRememberedPlace'), false);
    });
});

test('hostile classification and ordered-target safety distinguish monsters from civilians', () => {
    const previous = { ...settings };
    try {
        setSettings({ ...previous, minecraft_version: '1.20.1', owner_player: 'jakakriletic' });
        assert.equal(isHostile({ name: 'zombie', type: 'mob' }), true);
        assert.equal(isHostile({ name: 'cow', type: 'mob' }), false);
        assert.equal(isHostile({ name: 'villager', type: 'mob' }), false);

        const self = { id: 1, type: 'player', username: 'Blaz', position: {} };
        const zombie = { id: 2, type: 'mob', name: 'zombie', position: {} };
        const cow = { id: 3, type: 'mob', name: 'cow', position: {}, metadata: [] };
        const villager = { id: 4, type: 'mob', name: 'villager', position: {} };
        const player = { id: 5, type: 'player', username: 'SomePlayer', position: {} };
        const bot = {
            username: 'Blaz',
            entity: self,
            entities: { 1: self, 2: zombie, 3: cow, 4: villager, 5: player },
            players: { SomePlayer: { entity: player } },
        };
        const agent = { name: 'Blaz', bot };
        assert.equal(isAllowedOrderedTarget(agent, zombie), true);
        assert.equal(isAllowedOrderedTarget(agent, cow), true);
        assert.equal(isAllowedOrderedTarget(agent, villager), false);
        assert.equal(isAllowedOrderedTarget(agent, player), false);
    } finally {
        setSettings(previous);
    }
});

function combatTestNpc(name, x, { health = 20, courage = 50, items = [] } = {}) {
    const self = { id: 1000 + x, type: 'player', username: name, position: new Vec3(x, 64, 0) };
    const bot = {
        username: name,
        entity: self,
        entities: { [self.id]: self },
        players: {},
        health,
        inventory: { items: () => items.map(item => ({ name: item })) },
        hawkEye: items.includes('bow') && items.includes('arrow')
            ? { getMasterGrade() {} }
            : null,
    };
    return {
        cfg: { id: name.toLowerCase(), username: name },
        settings: { admin_players: [], npcs: [] },
        state: { data: { lastnosti: { pogum: courage } } },
        bot,
        registry: [],
        defending: false,
    };
}

function addVisiblePlayer(observer, playerNpc) {
    observer.bot.players[playerNpc.cfg.username] = {
        username: playerNpc.cfg.username,
        entity: {
            id: playerNpc.bot.entity.id,
            type: 'player',
            username: playerNpc.cfg.username,
            position: playerNpc.bot.entity.position,
        },
    };
}

function addHostile(npc, id, name, x, z = 0) {
    const entity = { id, name, type: 'mob', position: new Vec3(x, 64, z), isValid: true };
    npc.bot.entities[id] = entity;
    return entity;
}

describe('RP squad combat', () => {
    test('assists an ally beyond personal threat range and joins an existing focus target', () => {
        const blaz = combatTestNpc('Blaz', 0, { courage: 58, items: ['iron_sword'] });
        const lara = combatTestNpc('Lara', 16, { courage: 50, items: ['stone_sword'] });
        blaz.registry = lara.registry = [blaz, lara];
        addVisiblePlayer(blaz, lara);
        const nearAlly = addHostile(blaz, 41, 'skeleton', 17);
        assert.equal(selectCombatThreat(blaz)?.id, nearAlly.id);
        delete blaz.bot.entities[nearAlly.id];

        const left = addHostile(blaz, 42, 'zombie', 5, -2);
        const right = addHostile(blaz, 43, 'zombie', 5, 2);
        lara._combatTargetId = right.id;
        // Existing squad focus wins over two otherwise equivalent zombies.
        assert.equal(selectCombatThreat(blaz)?.id, right.id);
        assert.notEqual(left.id, right.id);
    });

    test('assigns only the best-equipped NPC to intercept a creeper', () => {
        const archer = combatTestNpc('Nejc', 0, {
            courage: 80,
            items: ['bow', 'arrow', 'stone_sword'],
        });
        const defender = combatTestNpc('Tilen', 4, {
            courage: 90,
            items: ['shield', 'iron_sword'],
        });
        archer.registry = defender.registry = [archer, defender];
        const creeperA = addHostile(archer, 50, 'creeper', 8);
        const creeperB = addHostile(defender, 50, 'creeper', 8);
        const p = combatParams({});
        assert.equal(shouldFightThreat(archer, creeperA, p), true);
        assert.equal(shouldFightThreat(defender, creeperB, p), false);
        defender.registry = [defender];
        assert.equal(shouldFightThreat(defender, creeperB, p), true);
    });

    test('low-health NPCs disengage even with squad support', () => {
        const hurt = combatTestNpc('Maja', 0, {
            health: 6,
            courage: 100,
            items: ['diamond_sword', 'shield'],
        });
        const ally = combatTestNpc('Jure', 3, { courage: 100, items: ['diamond_sword'] });
        hurt.registry = ally.registry = [hurt, ally];
        const zombie = addHostile(hurt, 60, 'zombie', 4);
        assert.equal(shouldFightThreat(hurt, zombie), false);
    });

    test('uses distinct formation slots and rejects a bow path through a friend', () => {
        const target = new Vec3(10, 64, 10);
        assert.notDeepEqual(combatSlot('Blaz', target, 9, 70), combatSlot('Lara', target, 9, 70));
        const points = [new Vec3(0, 65, 0), new Vec3(2, 65, 0), new Vec3(4, 65, 0)];
        assert.equal(trajectoryClearOfFriendPositions(points, [new Vec3(2, 65, 0)]), false);
        assert.equal(trajectoryClearOfFriendPositions(points, [new Vec3(2, 65, 4)]), true);
    });

    test('does not choose a home route that runs into the threat', () => {
        const npc = combatTestNpc('Rok', 0, { health: 6 });
        npc.registry = [npc];
        const zombie = addHostile(npc, 80, 'zombie', 3);
        const unsafeHome = { center: { x: 4, y: 64, z: 0 } };
        const retreat = safestRetreatPosition(npc, zombie, {}, unsafeHome);
        assert.ok(retreat.x < 0);
        assert.ok(retreat.distanceTo(zombie.position) > npc.bot.entity.position.distanceTo(zombie.position));
    });
});

describe('Minecraft 1.20.1 compatibility regressions', () => {
    test('all shipped entry points target 1.20.1 with the built-in FML3 handshake', () => {
        const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
        const rpSettings = JSON.parse(readFileSync('src/rp/config/settings.json', 'utf8'));
        const rpStartSettings = JSON.parse(readFileSync('src/rp/config/settings.start_boti.json', 'utf8'));
        assert.equal(rootSettings.minecraft_version, '1.20.1');
        assert.equal(rpSettings.minecraft.version, '1.20.1');
        assert.equal(rpStartSettings.minecraft.version, '1.20.1');
        assert.equal(rootSettings.forge_handshake.enabled, true);
        assert.equal(rootSettings.forge_handshake.ignoreInvalidCommandTree, true);
        assert.equal(rootSettings.max_commands, -1);
        assert.equal(rootSettings.show_command_syntax, 'full');
        assert.equal(rpSettings.minecraft.forge_handshake.enabled, true);
        assert.equal(rpSettings.minecraft.forge_handshake.ignoreInvalidCommandTree, true);
        assert.equal(rpStartSettings.minecraft.forge_handshake.enabled, true);
        assert.equal(rpStartSettings.minecraft.forge_handshake.ignoreInvalidCommandTree, true);
        assert.equal(packageJson.dependencies['minecraft-protocol-forge'], undefined);
        assert.match(readFileSync('start_boti.bat', 'utf8'), /EXPECTED_VERSION=1\.20\.1/);
    });

    test('uses the exact 1.20.1 registry and protocol', () => {
        const data = minecraftData('1.20.1');
        assert.equal(data.version.minecraftVersion, '1.20.1');
        assert.equal(data.version.version, 763);
        assert.ok(data.blocksByName.deepslate_diamond_ore);
        assert.ok(data.itemsByName.cherry_log);
        assert.ok(data.recipes[data.itemsByName.white_bed.id]?.length > 0);
    });

    test('recognizes modern colored beds without matching bedrock', () => {
        assert.equal(isBedBlock('minecraft:red_bed[part=head]'), true);
        assert.equal(isBedBlock('bedrock'), false);
        assert.deepEqual(legacyBlockSpec('white_bed', '1.20.1'), { name: 'white_bed', metadata: null });
        assert.deepEqual(legacyItemSpec('red_bed', '1.20.1'), { name: 'red_bed', metadata: null });
        assert.equal(blockMatchesName({ name: 'red_bed', metadata: 0 }, 'red_bed', '1.20.1'), true);
    });

    test('keeps modern names and command syntax intact', () => {
        assert.deepEqual(legacyBlockSpec('spruce_button', '1.20.1'), { name: 'spruce_button', metadata: null });
        assert.deepEqual(legacyBlockSpec('oak_pressure_plate', '1.20.1'), { name: 'oak_pressure_plate', metadata: null });
        assert.deepEqual(legacyItemSpec('oak_sign', '1.20.1'), { name: 'oak_sign', metadata: null });
        assert.deepEqual(legacyItemSpec('oak_boat', '1.20.1'), { name: 'oak_boat', metadata: null });
        assert.equal(
            setBlockCommand(1, -54, 3, 'deepslate', '1.20.1'),
            '/setblock 1 -54 3 minecraft:deepslate replace',
        );
    });

    test('uses expanded world height and modern entity metadata', () => {
        assert.equal(usesExpandedWorldHeight('1.20.1'), true);
        assert.equal(babyMetadataIndex('1.20.1'), 16);
    });
});

test('an API-only model profile selects its default model', () => {
    assert.deepEqual(selectAPI({ api: 'ollama' }), { api: 'ollama', model: null });
    assert.deepEqual(selectAPI({ model: 'local/llama3' }), { api: 'ollama', model: 'llama3' });
});

test('login errors explain an offline-auth versus online-mode mismatch', () => {
    const parsed = parseKickReason('{"translate":"multiplayer.disconnect.unverified_username"}');
    assert.equal(parsed.type, 'authentication');
    assert.match(parsed.msg, /offline auth/);
    assert.equal(parsed.isFatal, true);
    assert.equal(isFatalRpKickReason('{"translate":"multiplayer.disconnect.unverified_username"}'), true);
    assert.equal(isFatalRpKickReason('Server Mod rejections: Requires version 1.0'), true);
    assert.equal(isFatalRpKickReason('multiplayer.disconnect.server_shutdown'), false);
    assert.equal(
        parseKickReason('Server Mod rejections: Antique Cities requires version 1.0').type,
        'mod_rejection',
    );
});

test('a spam kick restarts only the affected agent instead of ending the kingdom', () => {
    const parsed = parseKickReason('{"translate":"disconnect.spam"}');
    assert.equal(parsed.type, 'spam');
    assert.equal(parsed.isFatal, false);
    assert.match(parsed.msg, /restart/);
});

test('stopping an RP NPC cancels its staggered initial start', async () => {
    let starts = 0;
    const npc = {
        bot: null,
        loop: null,
        reconnectTimer: null,
        startGeneration: 0,
        startTimer: null,
        starting: false,
        stopped: false,
        log: { error() {} },
        async start() { starts++; },
    };
    Npc.prototype.scheduleStart.call(npc, 20);
    Npc.prototype.stop.call(npc);
    await new Promise(resolveWait => setTimeout(resolveWait, 40));
    assert.equal(starts, 0);
    assert.equal(npc.startTimer, null);
    assert.equal(npc.stopped, true);
});

test('crash logging observes but does not suppress a fatal exception', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mindcraft-crashlog-'));
    try {
        const copiedModule = join(cwd, 'src', 'utils', 'crashlog.mjs');
        mkdirSync(join(cwd, 'src', 'utils'), { recursive: true });
        copyFileSync(resolve('src/utils/crashlog.js'), copiedModule);
        const moduleUrl = pathToFileURL(copiedModule).href;
        const result = spawnSync(process.execPath, [
            '--input-type=module',
            '--eval',
            `await import(${JSON.stringify(moduleUrl)}); throw new Error('fatal regression test');`,
        ], { cwd, encoding: 'utf8' });

        assert.notEqual(result.status, 0);
        const log = readFileSync(join(cwd, 'bots', 'unknown', 'console.log'), 'utf8');
        assert.match(log, /UNCAUGHT/);
        assert.match(log, /fatal regression test/);
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

test('dashboard rejects unsafe NPC ids before touching the filesystem', async () => {
    const app = express();
    attachRpDashboardApi(app);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const address = server.address();
        const response = await fetch(`http://127.0.0.1:${address.port}/api/rp/npcs/bad.id/config`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { ok: false, error: 'Invalid NPC id' });
    } finally {
        await new Promise((resolveClose, rejectClose) => {
            server.close(error => error ? rejectClose(error) : resolveClose());
        });
    }
});
