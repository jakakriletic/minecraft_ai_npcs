import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';

import { ActionManager } from '../src/agent/action_manager.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeAgent() {
    const bot = new EventEmitter();
    bot.interrupt_code = false;
    bot.output = '';
    const agent = {
        bot,
        history: { add: async () => {} },
        self_prompter: { isActive: () => false },
        killCalls: [],
        requestInterrupt() { bot.interrupt_code = true; },
        clearBotLogs() {
            bot.output = '';
            bot.interrupt_code = false;
        },
        cleanKill(message) { this.killCalls.push(message); },
        isIdle() { return !this.actions.executing; },
    };
    agent.actions = new ActionManager(agent);
    return agent;
}

async function waitUntil(predicate, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('condition timed out');
        await sleep(5);
    }
}

describe('ActionManager serialization', () => {
    test('a replacement waits for the interrupted action to fully settle', async () => {
        const agent = makeAgent();
        let active = 0;
        let maxActive = 0;
        const order = [];

        const first = agent.actions.runAction('first', async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            order.push('first:start');
            while (!agent.bot.interrupt_code) await sleep(5);
            await sleep(20); // model a plugin unwinding listeners after cancellation
            order.push('first:end');
            active--;
            return true;
        }, { timeout: -1 });
        await waitUntil(() => order.includes('first:start'));

        const second = agent.actions.runAction('second', async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            order.push('second:start');
            active--;
            return true;
        }, { timeout: -1 });

        const [firstResult, secondResult] = await Promise.all([first, second]);
        assert.equal(firstResult.interrupted, true);
        assert.equal(secondResult.success, true);
        assert.equal(maxActive, 1);
        assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
        assert.deepEqual(agent.killCalls, []);
    });

    test('only the newest action in a burst runs after preemption', async () => {
        const agent = makeAgent();
        const ran = [];
        const first = agent.actions.runAction('first', async () => {
            ran.push('first');
            while (!agent.bot.interrupt_code) await sleep(5);
            return true;
        }, { timeout: -1 });
        await waitUntil(() => ran.includes('first'));

        const stale = agent.actions.runAction('stale', async () => {
            ran.push('stale');
            return true;
        }, { timeout: -1 });
        const latest = agent.actions.runAction('latest', async () => {
            ran.push('latest');
            return true;
        }, { timeout: -1 });

        const [, staleResult, latestResult] = await Promise.all([first, stale, latest]);
        assert.equal(staleResult.superseded, true);
        assert.equal(staleResult.interrupted, true);
        assert.equal(latestResult.success, true);
        assert.deepEqual(ran, ['first', 'latest']);
    });

    test('a non-preempting brain action yields to the active action', async () => {
        const agent = makeAgent();
        const ran = [];
        const first = agent.actions.runAction('player-command', async () => {
            ran.push('player-command');
            while (!agent.bot.interrupt_code) await sleep(5);
            return true;
        }, { timeout: -1 });
        await waitUntil(() => ran.includes('player-command'));

        const brainResult = await agent.actions.runAction('brain:goHome', async () => {
            ran.push('brain:goHome');
            return true;
        }, { timeout: -1, preempt: false });

        assert.equal(brainResult.busy, true);
        assert.equal(agent.bot.interrupt_code, false);
        assert.deepEqual(ran, ['player-command']);

        await agent.actions.stop();
        const firstResult = await first;
        assert.equal(firstResult.interrupted, true);
    });

    test('explicit stop invalidates queued work', async () => {
        const agent = makeAgent();
        const ran = [];
        const first = agent.actions.runAction('first', async () => {
            ran.push('first');
            while (!agent.bot.interrupt_code) await sleep(5);
            return true;
        }, { timeout: -1 });
        await waitUntil(() => ran.includes('first'));
        const queued = agent.actions.runAction('queued', async () => {
            ran.push('queued');
            return true;
        }, { timeout: -1 });

        await agent.actions.stop();
        const [, queuedResult] = await Promise.all([first, queued]);
        assert.equal(queuedResult.superseded, true);
        assert.deepEqual(ran, ['first']);
    });
});
