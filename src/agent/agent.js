import { History } from './history.js';
import { existsSync, readFileSync } from 'fs';
import { Coder } from './coder.js';
// VisionInterpreter and browser viewer are lazy-imported below: their deps
// (prismarine-viewer, node-canvas-webgl/gl) are removed from this fork because
// they need a native C++ toolchain on Windows. Loaded only if enabled in settings.
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { canSourceRunAction, containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands, shouldSuppressGeneratedAction } from './commands/index.js';
import { ownerCommandLooksActionable, tryHandleOwnerCommand } from './owner_commands.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import { getPersonality } from './roleplay/personality.js';
import { ensureMemory } from './roleplay/memory.js';
import * as rpEvents from './roleplay/events.js';

const COMMAND_FEEDBACK_GAMERULES = [
    '/gamerule sendCommandFeedback false',
    '/gamerule commandBlockOutput false',
    '/gamerule logAdminCommands false',
];
const DEFAULT_TASK_CHECK_INTERVAL_MS = 1000;
const CONSTRUCTION_TASK_CHECK_INTERVAL_MS = 3000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function taskCheckIntervalMs(task) {
    const configured = Number(settings.task_check_interval_ms);
    const constructionConfigured = Number(settings.construction_task_check_interval_ms);
    if (task?.task_type === 'construction') {
        return Math.max(1000, constructionConfigured || CONSTRUCTION_TASK_CHECK_INTERVAL_MS);
    }
    return Math.max(300, configured || DEFAULT_TASK_CHECK_INTERVAL_MS);
}

function publicBuildCoordinator(myName, otherNames) {
    const names = [...new Set([myName, ...otherNames].filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    try {
        if (existsSync('./bots/kingdom.json')) {
            const state = JSON.parse(readFileSync('./bots/kingdom.json', 'utf8'));
            const online = names.filter(name => state.members?.[name]?.online !== false);
            if (online.length > 0) return online[0];
        }
    } catch { /* fall back to deterministic name order */ }
    return names[0] ?? myName;
}

async function suppressCommandFeedback(bot, agentName, countId) {
    if (settings.suppress_command_feedback === false || countId !== 0) return;
    for (const command of COMMAND_FEEDBACK_GAMERULES) {
        try {
            bot.chat(command);
        } catch (error) {
            console.warn(`[${agentName}] could not send ${command}: ${error.message}`);
            return;
        }
        await sleep(150);
    }
    console.log(`[${agentName}] Minecraft command feedback suppressed`);
}

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;
        this._messageQueue = [];
        this._processingMessages = false;
        this._messageGeneration = 0;
        this._priorityCommandChain = Promise.resolve();
        this._running = true;
        this._lastTaskCheckAt = 0;
        this._taskFinished = false;

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        this.personality = getPersonality(this.prompter.profile);
        this.prompter.profile.personality = this.personality;
        ensureMemory(this);
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = await initBot(this.name);
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { isFatal } = handleDisconnection(this.name, reason);

            process.exit(isFatal ? 2 : 1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                if (settings.render_bot_view) {
                    const { addBrowserViewer } = await import('./vision/browser_viewer.js');
                    addBrowserViewer(this.bot, count_id);
                }
                if (settings.allow_vision) {
                    console.log('Initializing vision intepreter...');
                    const { VisionInterpreter } = await import('./vision/vision_interpreter.js');
                    this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);
                } else {
                    this.vision_interpreter = null;
                }

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
                await suppressCommandFeedback(this.bot, this.name, count_id);
                this.clearBotLogs();
                const { installSafeMovements } = await import('./library/skills.js');
                installSafeMovements(this.bot);
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();

                // deterministic behaviour brain: drives play WITHOUT the LLM (cheap).
                // LLM then fires only on player chat + rare ambient. See library/brain.js.
                if (settings.deterministic_brain) {
                    const { attachBrain } = await import('./library/brain.js');
                    attachBrain(this);
                }

                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(1);
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message, opts = {}) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (!convoManager.isOtherAgent(username))
                    await this.enqueueMessage(username, message, opts);
            } catch (error) {
                console.error('Error handling message:', error);
            }
        };

		this.respondFunc = respondFunc;
        serverProxy.flushPendingMessages();

        // Wrap instead of passing respondFunc directly: mineflayer's whisper event has
        // extra args (translate, jsonMsg) that would land in the opts parameter.
        this.bot.on('whisper', (username, message) => respondFunc(username, message, { whisper: true }));
        
        this.bot.on('chat', (username, message) => {
            // With several bots present, public chat would make all of them answer every
            // line. So when others are present, only respond if THIS bot is addressed by
            // name, or it's a broadcast command not aimed at a specific other bot.
            if (serverProxy.getNumOtherAgents() > 0) {
                const text = (message || '').toLowerCase();
                const myName = this.name.toLowerCase();
                // Word-boundary match so "Zan" never fires on "zanima" and a bot name
                // inside a longer word does not count as addressing.
                const mentions = (name) => {
                    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text);
                };
                const named = mentions(myName);
                const isCmd = (message || '').trim().startsWith('!');
                const others = serverProxy.getAgents()
                    .map(a => (typeof a === 'string' ? a : a?.name))
                    .filter(n => n && n.toLowerCase() !== myName);
                const otherNamed = others.some(n => mentions(n.toLowerCase()));
                // The owner can address the whole team at once ("vsi", "everyone", ...).
                const fromOwner = settings.owner_player
                    && username.toLowerCase() === String(settings.owner_player).toLowerCase();
                const addressesAll = /(\bvsi\b|\bvse\b|\bekipa\b|\bteam\b|everyone|\ball\b)/i.test(text);
                const ownerActionable = fromOwner && ownerCommandLooksActionable(message);
                // Naming a bot ALWAYS wins: "Blaz get me wood" is Blaz's job alone even
                // though it is an actionable owner order — those broadcast only when
                // no bot is named (or the owner addresses the whole team).
                if (otherNamed && !named && !(fromOwner && addressesAll)) return;   // aimed at a different bot
                if (!named && isCmd && /^!build\b/i.test((message || '').trim())
                    && publicBuildCoordinator(this.name, others) !== this.name)
                    return;                         // one builder handles public build broadcasts
                if (!named && !isCmd && !(fromOwner && (addressesAll || ownerActionable))) {
                    // Unnamed owner small talk: the nearest bot answers in character
                    // instead of everyone ignoring it — that's where personality lives.
                    // Everyone else's generic chatter stays ignored (no 5-way spam).
                    if (!fromOwner || !this.isNearestAgentTo(username)) return;
                }
            }
            void respondFunc(username, message);
        });

        // Set up auto-eat. MERGE (Object.assign), never replace: replacing the object
        // drops the plugin's own defaults (eatingTimeout, checkOnItemPickup, offhand,
        // equipOldItem, ignoreInventoryCheck) to undefined — which breaks the eat
        // wait-loop (`elapsed < undefined` is always false) and disables eat-on-pickup.
        // Natural health regen needs hunger >= 18. startAt 17 let hunger drop BELOW 18
        // before eating, so regen kept stalling in that 17->refill gap — a big reason the
        // bots healed so poorly. startAt 18 eats the moment hunger leaves 18, keeping it at
        // 18-20 so passive regen is essentially always active (they refill to 20 anyway).
        Object.assign(this.bot.autoEat.options, {
            priority: 'foodPoints',
            startAt: 18,
            bannedFood: [
                "rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken",
                "wheat", "wheat_seeds", "cake"
            ]
        });

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            if (init_message === 'Agent process restarted.') {
                // A restart is status, not a new instruction. Let the deterministic
                // brain recover naturally instead of asking the LLM to guess an action
                // from stale memory (it repeatedly invented malformed !follow calls).
                await this.history.add('system', init_message);
            } else {
                await this.handleMessage('system', init_message, 1);
            }
        }
        else {
            this.openChat("Hello world! I am "+this.name);
        }
    }

    // Deterministic election: is THIS bot the agent nearest to the given player?
    // Each bot computes it from its own world view; positions are consistent enough
    // for bots near the player. Ties break on name. If nobody sees the player, the
    // alphabetically first agent answers so the player is never left hanging (two
    // replies are possible in rare mixed-visibility cases — better than silence).
    isNearestAgentTo(playerName) {
        let names = [this.name];
        try {
            names = serverProxy.getAgents()
                .map(a => (typeof a === 'string' ? a : a?.name))
                .filter(Boolean);
            if (!names.includes(this.name)) names.push(this.name);
        } catch { /* single-agent fallback */ }
        const first = [...names].sort((a, b) => a.localeCompare(b))[0];
        const target = this.bot.players[playerName]?.entity;
        if (!target) return first === this.name;
        let winner = null;
        let best = Infinity;
        for (const name of names) {
            const entity = name === this.name ? this.bot.entity : this.bot.players[name]?.entity;
            if (!entity) continue;
            const distance = entity.position.distanceTo(target.position);
            if (distance < best - 0.01 || (Math.abs(distance - best) <= 0.01 && name < (winner ?? '￿'))) {
                best = distance;
                winner = name;
            }
        }
        return (winner ?? first) === this.name;
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        // cancelTask() waits for collectBlock_finished. Calling it repeatedly while
        // an action is stuck adds one listener per call and eventually makes command
        // preemption slower than the action itself. Stop the active primitives
        // directly; if we cleared active targets, emit once so any existing
        // cancelTask waiters from the plugin do not pile up.
        let hadCollectTargets = false;
        try {
            hadCollectTargets = this.bot.collectBlock?.targets && !this.bot.collectBlock.targets.empty;
            this.bot.collectBlock?.targets?.clear?.();
        } catch { /* disconnected */ }
        try { this.bot.pathfinder?.setGoal?.(null); } catch { /* disconnected */ }
        try { this.bot.pathfinder?.stop?.(); } catch { /* disconnected */ }
        try {
            const stoppingDig = this.bot.stopDigging?.();
            if (stoppingDig?.catch) void stoppingDig.catch(() => {});
        } catch { /* disconnected */ }
        try { this.bot.pvp?.stop?.(); } catch { /* disconnected */ }
        // Don't spit out food mid-bite: deactivating while auto-eat is eating cancels
        // the meal, so a starving bot could never finish eating. Eating ends on its own
        // in ~2s; every other primitive (pathfinder, pvp, digging) is still stopped.
        try { if (!this.bot.autoEat?.isEating) this.bot.deactivateItem?.(); } catch { /* disconnected */ }
        if (hadCollectTargets) {
            try { queueMicrotask(() => this.bot.emit('collectBlock_finished')); } catch { /* disconnected */ }
        }
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    enqueueMessage(source, message, opts = {}) {
        const fromOwner = settings.owner_player
            && String(source ?? '').toLowerCase() === String(settings.owner_player).toLowerCase();
        const hasExplicitCommand = containsCommand(message);
        // Owner-only pseudo-commands (!order/!ukaz/!mining) live in owner_commands.js,
        // not the command registry — containsCommand() would otherwise shove them into
        // the regular parser, which rejects them as unknown commands.
        const ownerPseudoCommand = fromOwner && /^\s*!(?:order|ukaz|mining)\b/i.test(String(message ?? ''));
        if (fromOwner && (ownerPseudoCommand || (!hasExplicitCommand && ownerCommandLooksActionable(message)))) {
            this.requestInterrupt();
            // A newer royal order outranks a duty that is mid-resume in
            // runOwnerAction — the bumped seq tells its retry loop to yield.
            this._ownerCommandSeq = (this._ownerCommandSeq ?? 0) + 1;
            this._messageGeneration++;
            const run = this._priorityCommandChain
                .catch(() => {})
                .then(async () => {
                    if (await tryHandleOwnerCommand(this, source, message, opts)) return true;
                    return this.handleMessage(source, message);
                });
            this._priorityCommandChain = run;
            return run;
        }

        const isHumanCommand = source !== 'system' && source !== this.name &&
            !convoManager.isOtherAgent(source) && hasExplicitCommand;
        // A non-owner is allowed to ask/read, but must not even interrupt the owner's
        // active duty by sending an action that will later be rejected.
        if (isHumanCommand && isAction(hasExplicitCommand)
            && !canSourceRunAction(this, source)) {
            return this.handleMessage(source, message);
        }
        if (isHumanCommand) {
            this.requestInterrupt();
            this._messageGeneration++;
            const run = this._priorityCommandChain
                .catch(() => {})
                .then(() => this.handleMessage(source, message));
            this._priorityCommandChain = run;
            return run;
        }
        return new Promise((resolve, reject) => {
            const entry = { source, message, resolve, reject };
            this._messageQueue.push(entry);
            if (this._messageQueue.length > 20) {
                const dropped = this._messageQueue.splice(20);
                for (const item of dropped) item.resolve(false);
            }
            void this._drainMessageQueue();
        });
    }

    async _drainMessageQueue() {
        if (this._processingMessages) return;
        this._processingMessages = true;
        try {
            while (this._messageQueue.length > 0) {
                const entry = this._messageQueue.shift();
                try {
                    entry.resolve(await this.handleMessage(entry.source, entry.message));
                } catch (error) {
                    entry.reject(error);
                }
            }
        } finally {
            this._processingMessages = false;
        }
    }

    async handleMessage(source, message, max_responses=null) {
        const messageGeneration = this._messageGeneration;
        await this.checkTaskDone({ force: true });
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                void rpEvents.recordPlayerCommand(this, source, message, user_command_name)
                    .catch(error => console.warn(`[rp ${this.name}] command memory failed: ${error.message}`));
                if (!commandExists(user_command_name)) {
                    await this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                if (isAction(user_command_name) && !canSourceRunAction(this, source)) {
                    const denied = await executeCommand(this, message, source);
                    await this.routeResponse(source, denied);
                    return true;
                }
                await this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    await this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message, source);
                if (execute_res) 
                    await this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => messageGeneration !== this._messageGeneration ||
            this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up ||
            convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        // Handle other user messages
        await this.history.add(source, message);
        if (!self_prompt && !from_other_bot) {
            void rpEvents.recordPlayerMessage(this, source, message)
                .catch(error => console.warn(`[rp ${this.name}] message memory failed: ${error.message}`));
        }
        await this.history.save();

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history);
            if (checkInterrupt()) break;

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response');
                break; // empty response ends loop
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                if (shouldSuppressGeneratedAction(source, message, command_name)) {
                    const spoken = res.substring(0, res.indexOf(command_name)).trim();
                    await this.history.add(this.name, spoken || '[post-death action omitted]');
                    if (spoken) await this.routeResponse(source, spoken);
                    await this.history.add('system', 'Post-death action ignored; deterministic recovery controls the next move.');
                    break;
                }
                await this.history.add(this.name, res);
                
                if (!commandExists(command_name)) {
                    await this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name);
                    continue;
                }

                if (isAction(command_name) && !canSourceRunAction(this, source)) {
                    const denied = await executeCommand(this, res, source);
                    await this.routeResponse(source, denied);
                    await this.history.add('system', denied);
                    used_command = true;
                    break;
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    await this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    await this.routeResponse(source, chat_message);
                }
                else {
                    // no command at all
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        await this.routeResponse(source, pre_message);
                }

                // Preserve the original speaker so owner-only action authorization also
                // applies when a player's natural-language request makes the model emit
                // a command. Self/system prompts are still recognized and allowed.
                let execute_res = await executeCommand(this, res, source);

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res)
                    await this.history.add('system', execute_res);
                else
                    break;
            }
            else { // conversation response
                await this.history.add(this.name, res);
                await this.routeResponse(source, res);
                break;
            }
            
            await this.history.save();
        }

        return used_command;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            await this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            this._running = false;
            if (!this._disconnectHandled) {
                const { msg, isFatal } = handleDisconnection(this.name, reason);
                this.cleanKill(msg, isFatal ? 2 : 1);
            }
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            void this.actions.stop();
        });
        this.bot.on('kicked', (reason) => {
            if (!this._disconnectHandled) {
                const { msg, isFatal } = handleDisconnection(this.name, reason);
                this.cleanKill(msg, isFatal ? 2 : 1);
            }
        });
        this.bot.on('messagestr', (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                void this.enqueueMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`)
                    .catch(error => console.error('Failed to queue death message:', error));
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    void this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        const runUpdateLoop = async () => {
            while (this._running) {
                let start = Date.now();
                try {
                    await this.update(start - last);
                } catch (error) {
                    console.error(`[${this.name}] update loop error:`, error);
                }
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        };
        setTimeout(() => {
            void runUpdateLoop().catch(error => {
                console.error(`[${this.name}] update loop stopped:`, error);
            });
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }
    

    cleanKill(msg='Killing agent process...', code=1) {
        this._running = false;
        const bot = this.bot;
        console.warn(`[agent ${this.name}] ${msg} action=${this.actions?.currentActionLabel || 'idle'} health=${bot?.health ?? 'n/a'} food=${bot?.food ?? 'n/a'} position=${bot?.entity?.position ?? 'n/a'}`);
        void this.history?.add('system', msg);
        try { this.bot?.chat(code > 1 ? 'Stopping.' : 'Restarting.'); } catch { /* disconnected */ }
        try { void this.history?.save(); } catch { /* best effort */ }
        process.exit(code);
    }
    async checkTaskDone({ force = false } = {}) {
        if (this._taskFinished) return;
        if (this.task.data) {
            const now = Date.now();
            if (!force && now - this._lastTaskCheckAt < taskCheckIntervalMs(this.task)) return;
            this._lastTaskCheckAt = now;
            let res = this.task.isDone();
            if (res) {
                this._taskFinished = true;
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}
