import assert from 'node:assert';

const ACTION_TIMEOUT_GRACE_MS = 5000;
const ACTION_STOP_GRACE_MS = 30000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class ActionTimeoutError extends Error {
    constructor(actionLabel, timeoutMins) {
        super(`Action "${actionLabel}" timed out after ${timeoutMins} minutes.`);
        this.name = 'ActionTimeoutError';
        this.timedout = true;
    }
}

export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.last_action_time = 0;
        this.recent_action_counter = 0;
        this.currentActionPromise = null;
        // Every action transition is serialized. Previously several callers could all
        // observe `executing === true`, wait in stop(), and then start together as soon
        // as the old action cleared the flag. One of those new actions would reset the
        // shared interrupt flag while the others were still unwinding, producing the
        // follow/goHome/self-preservation restart loop seen in live logs.
        this._requestGeneration = 0;
        this._transitionTail = Promise.resolve();
        this._stopPromise = null;
        this._activeActionToken = null;
    }

    resumeAction(timeout) {
        return this._scheduleAction({ actionLabel: null, actionFn: null, timeout, resume: true });
    }

    runAction(actionLabel, actionFn, { timeout, resume = false, preempt = true } = {}) {
        return this._scheduleAction({ actionLabel, actionFn, timeout, resume, preempt });
    }

    _interruptedResult(extra = {}) {
        return {
            success: false,
            message: null,
            interrupted: true,
            timedout: false,
            value: false,
            ...extra,
        };
    }

    _scheduleAction(request) {
        if (this.executing && request.preempt === false)
            return Promise.resolve(this._interruptedResult({ busy: true }));

        const requestGeneration = ++this._requestGeneration;
        const interruptedLabel = this.currentActionLabel;
        if (this.executing) {
            console.log(`action "${request.actionLabel ?? this.resume_name}" trying to interrupt current action "${interruptedLabel}"`);
            // Begin cancellation immediately; do not wait for this request's turn in
            // the transition queue. stop() is single-flight and captures the current
            // action token, so it can never spill into and interrupt the next action.
            try { this.agent.requestInterrupt(); } catch { /* bot may be disconnecting */ }
            void this.stop({ invalidatePending: false });
        }

        const scheduled = this._transitionTail
            .catch(() => {})
            .then(async () => {
                // When commands arrive in a burst, only the newest pending request is
                // useful. This is especially important for mode ticks queued behind an
                // owner command: running every stale request recreates the interrupt
                // storm immediately after the current action stops.
                if (requestGeneration !== this._requestGeneration)
                    return this._interruptedResult({ superseded: true });
                if (request.resume)
                    return this._executeResume(request.actionLabel, request.actionFn, request.timeout);
                return this._executeAction(request.actionLabel, request.actionFn, request.timeout);
            });
        this._transitionTail = scheduled.then(() => undefined, () => undefined);
        return scheduled;
    }

    async stop({ invalidatePending = true } = {}) {
        if (invalidatePending) this._requestGeneration++;
        if (!this.executing) return true;
        if (this._stopPromise) {
            const inFlight = this._stopPromise;
            await inFlight;
            if (this._stopPromise === inFlight) this._stopPromise = null;
            // The previous stop may have belonged to an action that settled just as a
            // queued replacement began. Start a fresh token-scoped stop when needed.
            if (this.executing) return this.stop({ invalidatePending: false });
            return true;
        }

        const token = this._activeActionToken;
        const label = this.currentActionLabel;
        const stopPromise = this._stopCurrentAction(token, label);
        this._stopPromise = stopPromise;
        try {
            return await stopPromise;
        } finally {
            if (this._stopPromise === stopPromise) this._stopPromise = null;
        }
    }

    async _stopCurrentAction(token, label) {
        // 30 s grace: long pathfinder/collect tasks on slow local models often need
        // 10-20 s to honor the interrupt — killing the whole process at 10 s caused
        // constant leave/rejoin loops whenever the player sent a new command mid-action.
        const timeout = setTimeout(() => {
            if (this.executing && this._activeActionToken === token)
                this.agent.cleanKill(`Code execution ("${label}") refused stop after 30 seconds. Killing process.`);
        }, ACTION_STOP_GRACE_MS);
        let nextLogAt = 0;
        while (this.executing && this._activeActionToken === token) {
            // requestInterrupt is intentionally idempotent. Reasserting it catches an
            // async path/collect operation that began just after the first interrupt.
            this.agent.requestInterrupt();
            if (Date.now() >= nextLogAt) {
                console.log(`waiting for code to finish executing... (${label})`);
                nextLogAt = Date.now() + 5000;
            }
            await sleep(100);
        }
        clearTimeout(timeout);
        return true;
    }

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            this.resume_func = actionFn;
            assert(actionLabel != null, 'actionLabel is required for new resume');
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && (!this.agent.self_prompter.isActive() || new_resume)) {
            return await this._executeAction(this.resume_name, this.resume_func, timeout);
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10) {
        try {
            this.timedout = false;
            if (this.last_action_time > 0) {
                let time_diff = Date.now() - this.last_action_time;
                if (time_diff < 20) {
                    this.recent_action_counter++;
                }
                else {
                    this.recent_action_counter = 0;
                }
                if (this.recent_action_counter > 3) {
                    console.warn('Fast action loop detected, cancelling resume.');
                    this.cancelResume(); // likely cause of repetition
                }
                if (this.recent_action_counter > 5) {
                    console.error('Fast action loop detected; cancelling resume and backing off.');
                    this.cancelResume();
                    this.recent_action_counter = 0;
                    await sleep(250);
                    return { success: false, message: 'Fast action loop cancelled.', interrupted: false, timedout: false, value: false };
                }
            }
            this.last_action_time = Date.now();
            console.log('executing code...\n');

            // _scheduleAction guarantees the previous action has fully settled before
            // this point. It is now safe to reset the shared interrupt flag.
            this.agent.clearBotLogs();

            const actionToken = Symbol(actionLabel);
            this.executing = true;
            this._activeActionToken = actionToken;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;

            // start the action
            const value = await this._runWithTimeout(actionLabel, actionFn, timeout);

            // mark action as finished + cleanup
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            this.currentActionPromise = null;
            if (this._activeActionToken === actionToken) this._activeActionToken = null;

            // get bot activity summary
            let output = this.getBotOutputSummary();
            let timedout = this.timedout;
            let interrupted = this.agent.bot.interrupt_code && !timedout;
            if (!timedout) this.agent.clearBotLogs();

            // if not interrupted and not generating, emit idle event
            if (!interrupted && !timedout) {
                this.agent.bot.emit('idle');
            }

            // return action status report
            return { success: !timedout && value !== false, message: output, interrupted, timedout, value };
        } catch (err) {
            const timedout = this.timedout || err?.timedout || err?.name === 'ActionTimeoutError';
            const stack = err?.stack ?? String(err);
            const actionPromise = this.currentActionPromise;
            const actionLabel = this.currentActionLabel;
            try { this.agent.requestInterrupt(); } catch { /* bot may already be gone */ }
            this.cancelResume();
            console.error("Code execution triggered catch:", err);
            // Log the full stack trace
            console.error(err.stack);
            await this._waitForActionToSettle(actionPromise, actionLabel);
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            this.currentActionPromise = null;
            this._activeActionToken = null;
            const errText = err.toString();

            let message = this.getBotOutputSummary() +
                '!!Code threw exception!!\n' +
                'Error: ' + errText + '\n' +
                'Stack trace:\n' + stack + '\n';

            let interrupted = this.agent.bot.interrupt_code && !timedout;
            if (!timedout) this.agent.clearBotLogs();
            if (!interrupted && !timedout) {
                this.agent.bot.emit('idle');
            }
            return { success: false, message, interrupted, timedout, value: false };
        }
    }

    getBotOutputSummary() {
        const { bot } = this.agent;
        if (bot.interrupt_code && !this.timedout) return '';
        let output = bot.output;
        const MAX_OUT = 500;
        if (output.length > MAX_OUT) {
            output = `Action output is very long (${output.length} chars) and has been shortened.\n
          First outputs:\n${output.substring(0, MAX_OUT / 2)}\n...skipping many lines.\nFinal outputs:\n ${output.substring(output.length - MAX_OUT / 2)}`;
        }
        else {
            output = 'Action output:\n' + output.toString();
        }
        bot.output = '';
        return output;
    }

    _runWithTimeout(actionLabel, actionFn, timeoutMins = 10) {
        const actionPromise = Promise.resolve().then(actionFn);
        let actionSettled = false;
        const trackedAction = actionPromise.finally(() => {
            actionSettled = true;
        });
        void trackedAction.catch(() => {});
        this.currentActionPromise = trackedAction;

        if (!(timeoutMins > 0)) return trackedAction;

        let timeoutTimer;
        let graceTimer;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutTimer = setTimeout(() => {
                console.warn(`Code execution timed out after ${timeoutMins} minutes. Attempting force stop.`);
                this.timedout = true;
                try { this.agent.requestInterrupt(); } catch { /* bot may already be gone */ }
                if (this.agent.history?.add) {
                    void this.agent.history
                        .add('system', `Code execution timed out after ${timeoutMins} minutes. Attempting force stop.`)
                        .catch(error => console.error('Failed to record timed-out action:', error));
                }
                graceTimer = setTimeout(() => {
                    if (!actionSettled) reject(new ActionTimeoutError(actionLabel, timeoutMins));
                }, ACTION_TIMEOUT_GRACE_MS);
            }, timeoutMins * 60 * 1000);
        });

        return Promise.race([trackedAction, timeoutPromise]).finally(() => {
            clearTimeout(timeoutTimer);
            clearTimeout(graceTimer);
        });
    }

    async _waitForActionToSettle(actionPromise, actionLabel) {
        if (!actionPromise) return true;
        let settled = false;
        const settledPromise = actionPromise
            .catch(() => {})
            .then(() => { settled = true; });
        let nextLogAt = 0;
        const deadline = Date.now() + ACTION_STOP_GRACE_MS;

        while (!settled) {
            if (Date.now() >= deadline) {
                this.agent.cleanKill(`Code execution ("${actionLabel}") refused stop after 30 seconds. Killing process.`);
                return false;
            }
            try { this.agent.requestInterrupt(); } catch { /* bot may already be gone */ }
            if (Date.now() >= nextLogAt) {
                console.log(`waiting for code to settle after interruption... (${actionLabel})`);
                nextLogAt = Date.now() + 1000;
            }
            await Promise.race([settledPromise, sleep(100)]);
        }
        return true;
    }

}
