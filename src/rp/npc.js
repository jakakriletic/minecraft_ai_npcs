// One NPC = one mineflayer bot + its scheduler loop.
// Phase 2: woodcutter job, personal storage (storage_index), admin commands.
import mineflayer from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { pathfinder, goals } = pkg;
import { plugin as pvp } from 'mineflayer-pvp';
import { plugin as autoEat } from 'mineflayer-auto-eat';
import armorManager from 'mineflayer-armor-manager';
import hawkeyePkg from 'minecrafthawkeye';
import { join } from 'path';
import { makeLogger } from './core/logger.js';
import { validateSchedule, activityFor, igClock } from './core/scheduler.js';
import { setupMovement, gotoRegion, gotoNear, isInRegion, sleep } from './core/movement.js';
import { Storage } from './core/storage.js';
import { NpcState } from './state/npcState.js';
import { EventLog, attachEventDetection } from './core/events.js';
import { attachNeeds } from './systems/needs.js';
import { collectWage } from './systems/economy.js';
import { PriceBeliefs } from './systems/prices.js';
import { attachTrade } from './systems/trade.js';
import { reflect } from './state/reflection.js';
import { attachGossip } from './state/gossip.js';
import { attachCrime, inJail } from './systems/crime.js';
import { freeTimeStep } from './systems/freetime.js';
import { attachLiveness } from './systems/liveness.js';
import { attachAdminCommands } from './admin/commands.js';
import { attachChatListener } from './chat/listener.js';
import { workStep } from './jobs/woodcutter.js';
import { gatherStep } from './jobs/gather.js';
import { presenceStep } from './jobs/presence.js';
import { cookStep } from './jobs/cook.js';
import { stewardStep } from './jobs/steward.js';
import { guardStep } from './jobs/guard.js';
import { builderStep } from './jobs/builder.js';
import { attachMarket } from './systems/market.js';
import { attachMind } from './systems/mind.js';
import { attachSocialBonds } from './systems/social_bonds.js';
import { attachSocietyStatus } from './systems/status.js';
import { trySocietyRoutineFix } from './systems/routines.js';
import { isBedBlock } from '../utils/mc_compat.js';
import { BANNED_AUTO_FOOD, patchLegacyFoodRegistry, syncSatiety } from './systems/food.js';
import { createForgeClient } from '../utils/forge_handshake.js';

const hawkeye = hawkeyePkg.default ?? hawkeyePkg;

const RECONNECT_DELAY_MS = 10_000;
const FATAL_KICK_MARKERS = [
    'unverified_username',
    'failed to verify username',
    'invalid session',
    'server mod rejections',
    'requires version',
    'whitelist',
    'banned',
    'outdated client',
];

export function isFatalRpKickReason(reason) {
    const raw = (typeof reason === 'string' ? reason : JSON.stringify(reason ?? '')).toLowerCase();
    return FATAL_KICK_MARKERS.some(marker => raw.includes(marker));
}
// woodcutter/miner have real harvest logic; social/guard roles "be there" (presence)
const JOBS = {
    woodcutter: workStep, miner: gatherStep, gatherer: gatherStep,
    innkeeper: presenceStep, policeman: guardStep, guard: guardStep,
    builder: builderStep, steward: stewardStep, cook: cookStep, idle: presenceStep,
};

export class Npc {
    constructor(npcConfig, locations, settings, paths, llm, regionOwners = {}, civicState = null) {
        this.llm = llm;
        this.regionOwners = regionOwners;
        this.civic = civicState;
        this.cfg = npcConfig;
        this.locations = locations;
        this.settings = settings;
        this.paths = paths; // { locations, npcConfig, stateDir }
        this.log = makeLogger(npcConfig.osebnost.ime);
        this.schedule = validateSchedule({ ...npcConfig.schedule }, this.log);
        this.storage = new Storage(npcConfig.id, join(paths.stateDir, npcConfig.id, 'storage_index.json'), this.log);
        this.state = new NpcState(join(paths.stateDir, npcConfig.id, 'state.json'), npcConfig.zacetno_stanje, this.log);
        this.eventLog = new EventLog(join(paths.stateDir, npcConfig.id, 'event_log.json'));
        const eco = settings.economyConfig ?? {};
        this.prices = new PriceBeliefs(
            join(paths.stateDir, npcConfig.id, 'price_beliefs.json'),
            eco.bazni_cenik ?? {}, eco.trgovanje?.ucenje_alfa, this.log
        );
        this.currentActivity = null;
        this.busy = false;
        this.homeScanned = false;
        this.jobState = null;
        this.command = null;          // admin direct control (come/follow/go/give...)
        this.forcedActivity = null;   // admin override of the schedule (work/sleep/free)
        this.bot = null;
        this.stopped = false;
        this.starting = false;
        this.startGeneration = 0;
        this.startTimer = null;
        this.reconnectTimer = null;
        this.followState = null;
    }

    region(name) {
        const r = this.locations[name];
        if (!r) throw new Error(`unknown region '${name}' in locations.json`);
        return r;
    }

    async start() {
        if (this.starting || this.bot) {
            this.log.warn('start requested while NPC is already starting or online');
            return;
        }

        clearTimeout(this.startTimer);
        this.startTimer = null;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const generation = ++this.startGeneration;
        this.starting = true;
        this.stopped = false;
        const mc = this.settings.minecraft;
        let bot;
        try {
            this.log.info(`connecting to ${mc.host}:${mc.port} (MC ${mc.version})...`);
            const botOptions = {
                host: mc.host, port: mc.port,
                username: this.cfg.username,
                version: mc.version, auth: mc.auth,
                viewDistance: 'short', // 4 chunks: manj chunk-load/tick obremenitve strežnika
            };
            const forgeOptions = mc.forge_handshake ?? {};
            const client = forgeOptions.enabled ? createForgeClient(botOptions, forgeOptions) : null;
            bot = mineflayer.createBot(client ? { ...botOptions, client } : botOptions);
            this.bot = bot;
            // RP subsystems intentionally register independent cleanup hooks on `end`.
            // Mineflayer's default EventEmitter limit (10) is lower than that known set.
            bot.setMaxListeners(20);
            bot.loadPlugin(pathfinder);
            bot.loadPlugin(pvp); // self-defense against mobs
            bot.loadPlugin(autoEat);
            bot.loadPlugin(armorManager);
            try { bot.loadPlugin(hawkeye); }
            catch (error) { this.log.warn(`bow aiming unavailable: ${error.message}`); }
        } catch (error) {
            try { bot?.quit(); } catch { /* connection did not finish */ }
            if (this.bot === bot) this.bot = null;
            if (generation !== this.startGeneration) return;
            this.starting = false;
            this.scheduleReconnect('startup failure');
            throw error;
        }

        bot.once('spawn', () => {
            if (generation !== this.startGeneration || this.stopped) {
                try { bot.quit(); } catch { /* connection already closed */ }
                return;
            }
            this.starting = false;
            this.followState = null;
            this.log.info('spawned in world');
            setupMovement(bot);
            patchLegacyFoodRegistry(bot);
            Object.assign(bot.autoEat.options, {
                priority: 'foodPoints',
                startAt: 18,
                bannedFood: BANNED_AUTO_FOOD,
                checkOnItemPickup: true,
            });
            syncSatiety(this);
            attachAdminCommands(this, this.paths);
            if (this.llm) attachChatListener(this, this.llm);
            attachEventDetection(this, this.regionOwners, this.settings.event_utezi ?? {});
            attachNeeds(this, this.settings.economy ?? {});
            attachMind(this, this.civic);
            attachSocialBonds(this, this.civic, this.llm);
            attachSocietyStatus(this, this.civic);
            attachTrade(this, this.settings.economyConfig ?? {});
            attachGossip(this, this.settings.event_utezi ?? {}, this.llm);
            attachCrime(this, this.settings.crime ?? {});
            attachLiveness(this, this.settings.liveness ?? {}); // glances, fidgets, defense
            attachMarket(this, this.settings.economyConfig ?? {}); // NPC<->NPC trading
            this.loop = setInterval(() => {
                void this.tick().catch(error => this.log.error(`scheduler: ${error.message}`));
            }, this.settings.scheduler_tick_interval_ms);
        });

        bot.on('end', (reason) => {
            if (this.bot !== bot) return;
            this.starting = false;
            clearInterval(this.loop);
            this.currentActivity = null;
            this.followState = null;
            if (this.bot === bot) this.bot = null;
            if (this.stopped) return;
            this.scheduleReconnect(`disconnected (${reason})`);
        });

        bot.on('kicked', (reason) => {
            this.log.warn('kicked:', reason);
            if (isFatalRpKickReason(reason)) {
                this.stopped = true;
                this.log.error('fatal login rejection; automatic reconnect disabled until the server/auth/mod configuration is fixed');
            }
        });
        bot.on('error', (err) => this.log.error(err.message));
    }

    async tick() {
        if (this.busy || this.defending || !this.bot?.entity) return; // surviving a mob beats the day job
        this.busy = true;
        try {
            // admin direct control takes absolute priority over schedule + jail
            if (this.command) { await this.handleCommand(); return; }

            const timeOfDay = this.bot.time.timeOfDay;
            // jail overrides the schedule; admin forcedActivity overrides everything below it
            const activity = inJail(this) ? 'jail' : (this.forcedActivity ?? activityFor(this.schedule, timeOfDay));

            if (activity !== this.currentActivity) {
                this.log.info(`in-game ${igClock(timeOfDay)} -> activity: ${this.currentActivity ?? 'none'} -> ${activity}`);
                if (this.currentActivity === 'work') {
                    this.jobState = null; // shift ended, reset
                    // shift over -> go collect the wage in physical gold
                    this.pendingAction = async () => { await collectWage(this, this.settings.economy ?? {}); };
                }
                // waking up: leave the bed even if dawn hasn't auto-ejected us yet
                if (this.currentActivity === 'sleep' && this.bot.isSleeping) {
                    try { await this.bot.wake(); } catch { /* already up */ }
                }
                if (activity !== 'free') this.freeState = null; // new free block tomorrow
                // first sleep of this real session -> evening reflection (one cheap LLM call)
                if (activity === 'sleep' && !this.reflectedThisSession && this.llm) {
                    this.reflectedThisSession = true;
                    reflect(this, this.llm, 'prvi spanec').catch(e => this.log.warn(`reflection: ${e.message}`));
                }
                this.currentActivity = activity;
            }

            // queued one-off actions (wage pickup, meal trip) run before normal behaviour
            if (this.pendingAction) {
                const action = this.pendingAction;
                this.pendingAction = null;
                await action();
                return;
            }

            if (await trySocietyRoutineFix(this)) return;

            if (activity === 'jail') {
                await this.beInJail();
            } else if (activity === 'work') {
                await this.doWork();
            } else if (activity === 'free') {
                await freeTimeStep(this); // dynamic: inn / wander / rest, by personality
            } else {
                await this.beHome(); // sleep
            }
        } catch (e) {
            this.log.error(`tick: ${e.message}`);
        } finally {
            this.busy = false;
        }
    }

    scheduleReconnect(reason = 'disconnected') {
        if (this.stopped || this.reconnectTimer) return;
        this.log.warn(`${reason}, reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.stopped) return;
            void this.start().catch(error => this.log.error(`reconnect: ${error.message}`));
        }, RECONNECT_DELAY_MS);
    }

    scheduleStart(delayMs = 0) {
        clearTimeout(this.startTimer);
        this.startTimer = null;
        this.stopped = false;
        const delay = Math.max(0, Number(delayMs) || 0);
        if (delay === 0) {
            void this.start().catch(error => this.log.error(`initial connection: ${error.message}`));
            return;
        }
        this.startTimer = setTimeout(() => {
            this.startTimer = null;
            if (this.stopped) return;
            void this.start().catch(error => this.log.error(`initial connection: ${error.message}`));
        }, delay);
    }

    // Direct admin control. Runs instead of normal activity while this.command is set.
    async handleCommand() {
        const c = this.command;
        const bot = this.bot;
        const adminEntity = () => bot.players[c.player]?.entity;
        if (c.type !== 'sledi') this.followState = null;

        switch (c.type) {
            case 'sledi': { // follow persists and replans only when progress actually stalls
                const e = adminEntity();
                if (!e) {
                    this.followState = null;
                    bot.pathfinder.stop(); // lost sight of admin — wait
                    return;
                }
                const now = Date.now();
                const distance = bot.entity.position.distanceTo(e.position);
                if (!this.followState || this.followState.entityId !== e.id) {
                    this.followState = {
                        entityId: e.id,
                        goal: new goals.GoalFollow(e, 2),
                        sample: bot.entity.position.clone(),
                        lastMovementAt: now,
                        replans: 0,
                    };
                }
                const state = this.followState;
                if (bot.entity.position.distanceTo(state.sample) >= 0.75) {
                    state.sample = bot.entity.position.clone();
                    state.lastMovementAt = now;
                }
                if (distance > 3 && now - state.lastMovementAt >= 10_000) {
                    state.goal = new goals.GoalFollow(e, 2);
                    state.sample = bot.entity.position.clone();
                    state.lastMovementAt = now;
                    state.replans++;
                    this.log.warn(`follow stalled ${Math.round(distance)} blocks from ${c.player}; replanning (${state.replans})`);
                    bot.pathfinder.stop();
                }
                // GoalFollow already updates itself as its entity moves. Replacing it on
                // every 5 s scheduler tick reset A* repeatedly and caused door jitter.
                if (distance > 3 && bot.pathfinder.goal !== state.goal)
                    bot.pathfinder.setGoal(state.goal, true);
                return;
            }
            case 'pridi': {
                const e = adminEntity();
                if (!e) return; // can't see admin yet, keep waiting
                if (bot.isSleeping) { try { await bot.wake(); } catch { /* */ } }
                await gotoNear(bot, e.position, 2, this.log);
                this.command = { type: 'cakaj', player: c.player };
                bot.chat('Tu sem.');
                return;
            }
            case 'cakaj': // stand still until released (liveness fidgets still run between ticks)
                bot.pathfinder.stop();
                return;
            case 'pojdi': {
                const ok = await gotoRegion(bot, this.region(c.region), this.log);
                bot.chat(ok ? 'Tu sem.' : `Ne morem do '${c.region}'.`);
                this.command = null; // done -> back to normal schedule
                return;
            }
            case 'domov': {
                await gotoRegion(bot, this.region(this.cfg.home_region), this.log);
                this.command = { type: 'cakaj', player: c.player }; // stay home until released
                return;
            }
            case 'daj': {
                this.command = null;
                await this.giveItemTo(c.player, c.item, c.qty);
                return;
            }
            default:
                this.command = null;
        }
    }

    async giveItemTo(username, itemName, qty) {
        const bot = this.bot;
        const e = bot.players[username]?.entity;
        if (e) await gotoNear(bot, e.position, 2, this.log);
        let left = qty;
        for (const it of bot.inventory.items().filter(i => i.name === itemName)) {
            if (left <= 0) break;
            const n = Math.min(it.count, left);
            try { await bot.toss(it.type, null, n); left -= n; }
            catch (err) { this.log.warn(`give toss failed: ${err.message}`); break; }
        }
        const given = qty - left;
        bot.chat(given > 0 ? `Izvoli, ${given}x ${itemName}.` : `Nimam ${itemName}.`);
    }

    async doWork() {
        // first time at work after startup: index home chests (only jobs that use storage)
        if (!this.homeScanned && this.cfg.job === 'woodcutter') {
            const home = this.region(this.cfg.home_region);
            if (await gotoRegion(this.bot, home, this.log)) {
                await this.storage.scanRegion(this.bot, home, this.cfg.home_region);
                this.homeScanned = true;
            }
        }
        const jobFn = JOBS[this.cfg.job];
        if (!jobFn) {
            this.log.warn(`no implementation for job '${this.cfg.job}', idling in job region`);
            await gotoRegion(this.bot, this.region(this.cfg.job_region), this.log);
            return;
        }
        await jobFn(this);
    }

    async beInJail() {
        const region = this.locations['zapor'];
        if (!region) {
            // no jail built yet -> house arrest at home
            this.log.warn("no 'zapor' region configured — serving house arrest at home");
            await this.beHome();
            return;
        }
        if (!isInRegion(this.bot, region)) {
            this.log.info('walking to jail...');
            await gotoRegion(this.bot, region, this.log);
        }
    }

    async beHome() {
        const home = this.region(this.cfg.home_region);
        if (!isInRegion(this.bot, home)) {
            this.log.info(`walking home ('${this.cfg.home_region}')...`);
            const ok = await gotoRegion(this.bot, home, this.log);
            if (!ok) { this.log.warn('could not reach home, retry next tick'); await sleep(10_000); }
            return;
        }
        // at home: sleep in bed at night if sleeping time
        if (this.currentActivity === 'sleep' && !this.bot.isSleeping) {
            await this.trySleepInBed();
        }
    }

    async trySleepInBed() {
        const bedIds = Object.values(this.bot.registry.blocksByName)
            .filter(b => isBedBlock(b)).map(b => b.id);
        const found = this.bot.findBlocks({ matching: bedIds, maxDistance: 16, count: 1 });
        if (found.length === 0) return; // no bed: just "rests" at home
        const bed = this.bot.blockAt(found[0]);
        try {
            await this.bot.sleep(bed);
            this.log.info('sleeping in bed');
        } catch { /* daytime or bed occupied — resting at home is fine */ }
    }

    stop() {
        this.stopped = true;
        this.startGeneration++;
        this.starting = false;
        clearTimeout(this.startTimer);
        this.startTimer = null;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        clearInterval(this.loop);
        this.followState = null;
        this.bot?.quit();
    }
}
