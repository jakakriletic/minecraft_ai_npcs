import * as skills from '../library/skills.js';
import * as base from '../library/base.js';
import * as build from '../library/build.js';
import * as survival from '../library/survival.js';
import * as progression from '../library/progression.js';
import * as storage from '../library/storage.js';
import * as tidy from '../library/tidy.js';
import * as town from '../library/town.js';
import * as combat from '../library/combat.js';
import * as loadout from '../library/loadout.js';
import * as homeLife from '../library/home_life.js';
import * as playerHelper from '../library/player_helper.js';
import * as mc from '../../utils/mcdata.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';


function runAsAction (actionFn, resume = false, timeout = -1) {
    let actionLabel = null;  // Will be set on first use
    
    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        const actionFnWithAgent = async () => await actionFn(agent, ...args);
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
        if (code_return.interrupted && !code_return.timedout)
            return;
        return code_return.message;
    };

    return wrappedAction;
}

function configuredOwner(agent) {
    const owner = String(settings.owner_player ?? '').trim();
    if (!owner) skills.log(agent.bot, 'No owner_player is configured.');
    return owner || null;
}

async function followConfiguredOwner(agent, distance = 3) {
    const owner = configuredOwner(agent);
    if (!owner) return false;
    return await playerHelper.followPlayerPersistently(agent, owner, distance, -1);
}

async function defendConfiguredOwner(agent, minutes = -1) {
    const owner = configuredOwner(agent);
    if (!owner) return false;
    return await playerHelper.guardPlayer(agent, owner, minutes);
}

export const actionsList = [
    {
        name: '!newAction',
        description: 'Perform new and unknown custom behaviors that are not available as a command.', 
        params: {
            'prompt': { type: 'string', description: 'A natural language prompt to guide code generation. Make a detailed step-by-step plan.' }
        },
        perform: async function(agent, prompt) {
            // just ignore prompt - it is now in context in chat history
            if (!settings.allow_insecure_coding) { 
                agent.openChat('newAction is disabled. Enable with allow_insecure_coding=true in settings.js');
                return "newAction not allowed! Code writing is disabled in settings. Notify the user.";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(agent.history);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins});
            return result;
        }
    },
    {
        name: '!stop',
        description: 'Force stop all actions and commands that are currently executing.',
        perform: async function (agent) {
            await agent.actions.stop();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            let msg = 'Agent stopped.';
            if (agent.self_prompter.isActive())
                msg += ' Self-prompting still active.';
            return msg;
        }
    },
    {
        name: '!stfu',
        description: 'Stop all chatting and self prompting, but continue current action.',
        perform: async function (agent) {
            await agent.openChat('Shutting up.');
            agent.shutUp();
            return;
        }
    },
    {
        name: '!restart',
        description: 'Restart the agent process.',
        perform: function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: 'Clear the chat history.',
        perform: function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!goToPlayer',
        description: 'Go to the given player.',
        params: {
            'player_name': {type: 'string', description: 'The name of the player to go to.'},
            'closeness': {type: 'float', description: 'How close to get to the player.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            await skills.goToPlayer(agent.bot, player_name, closeness);
        })
    },
    {
        name: '!followPlayer',
        description: 'Endlessly follow the given player.',
        params: {
            'player_name': {type: 'string', description: 'name of the player to follow.'},
            'follow_dist': {type: 'float', description: 'The distance to follow from.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
    },
    {
        name: '!follow',
        description: 'Loyal-squad order: endlessly follow the configured owner_player. Optional distance defaults to 3 blocks.',
        params: {
            'distance': { type: 'float', description: 'Distance to keep from the owner, default 3.', optional: true, domain: [1, 13] },
        },
        perform: runAsAction(async (agent, distance = 3) => {
            return await followConfiguredOwner(agent, distance);
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: 'Go to the given x, y, z location.',
        params: {
            'x': {type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: 'The y coordinate.', domain: [-64, 320]},
            'z': {type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: 'How close to get to the location.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.goToPosition(agent.bot, x, y, z, closeness);
        })
    },
    {
        name: '!searchForBlock',
        description: 'Find and go to the nearest block of a given type in a given range.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the block. Minimum 32.', domain: [10, 512] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!searchForEntity',
        description: 'Find and go to the nearest entity of a given type in a given range.',
        params: {
            'type': { type: 'string', description: 'The type of entity to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the entity.', domain: [32, 512] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: 'Move away from the current location in any direction by a given distance.',
        params: {'distance': { type: 'float', description: 'The distance to move away.', domain: [0, Infinity] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!rememberHere',
        description: 'Save the current location with a given name.',
        params: {'name': { type: 'string', description: 'The name to remember the location as.' }},
        perform: function (agent, name) {
            const pos = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z);
            return `Location saved as "${name}".`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: 'Go to a saved location.',
        params: {'name': { type: 'string', description: 'The name of the location to go to.' }},
        perform: runAsAction(async (agent, name) => {
            const pos = agent.memory_bank.recallPlace(name);
            if (!pos) {
            skills.log(agent.bot, `No location named "${name}" saved.`);
            return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
        })
    },
    {
        name: '!givePlayer',
        description: 'Give the specified item to the given player.',
        params: { 
            'player_name': { type: 'string', description: 'The name of the player to give the item to.' }, 
            'item_name': { type: 'ItemName', description: 'The name of the item to give.' },
            'num': { type: 'int', description: 'The number of items to give.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!bringToPlayer',
        description: 'Prepare or gather an item, then deliver it to a player. Good helper command for "bring me torches/wood/food".',
        params: {
            'player_name': { type: 'string', description: 'The player to deliver to.' },
            'item_name': { type: 'string', description: 'Item or helper alias, e.g. torch, wood, food, cobblestone.' },
            'num': { type: 'int', description: 'How many items to bring.', domain: [1, 64] },
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await playerHelper.bringToPlayer(agent, player_name, item_name, num);
        }, false, 12)
    },
    {
        name: '!carryNearbyChest',
        description: 'Carry items from a chest near the requesting player into public/home storage.',
        params: {
            'player_name': { type: 'string', description: 'Player standing near the chest.', optional: true },
            'item_name': { type: 'string', description: 'Optional item filter.', optional: true },
        },
        perform: runAsAction(async (agent, player_name = null, item_name = null) => {
            await playerHelper.carryNearbyChest(agent, player_name ?? agent.commandSource, item_name);
        }, false, 10)
    },
    {
        name: '!guardPlayer',
        description: 'Prepare escort loadout, switch to defensive guard stance, and follow/protect a player.',
        params: {
            'player_name': { type: 'string', description: 'Player to guard.' },
            'minutes': { type: 'int', description: 'How long to guard. -1 means until stopped.', optional: true, domain: [-1, 120] },
        },
        perform: runAsAction(async (agent, player_name, minutes = -1) => {
            return await playerHelper.guardPlayer(agent, player_name, minutes);
        }, true)
    },
    {
        name: '!defend',
        description: 'Loyal-squad order: equip for defense, stay with owner_player, and protect them until stopped.',
        params: {
            'minutes': { type: 'int', description: 'How long to defend. -1 means until !stop, default -1.', optional: true, domain: [-1, 121] },
        },
        perform: runAsAction(async (agent, minutes = -1) => {
            return await defendConfiguredOwner(agent, minutes);
        }, true)
    },
    {
        name: '!defende',
        description: 'Alias for !defend (kept for the requested spelling).',
        params: {
            'minutes': { type: 'int', description: 'How long to defend. -1 means until !stop, default -1.', optional: true, domain: [-1, 121] },
        },
        perform: runAsAction(async (agent, minutes = -1) => {
            return await defendConfiguredOwner(agent, minutes);
        }, true)
    },
    {
        name: '!helpBuild',
        description: 'Prepare builder loadout, come to the player, and optionally queue a schematic by name/category.',
        params: {
            'player_name': { type: 'string', description: 'Player to help.', optional: true },
            'schematic': { type: 'string', description: 'Optional schematic/category/random.', optional: true },
        },
        perform: runAsAction(async (agent, player_name = null, schematic = null) => {
            await playerHelper.helpBuild(agent, player_name ?? agent.commandSource, schematic);
        }, false, 10)
    },
    {
        name: '!consume',
        description: 'Eat/drink the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to consume.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: 'Equip the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to equip.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!putInChest',
        description: 'Put the given item in the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to put in the chest.' },
            'num': { type: 'int', description: 'The number of items to put in the chest.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.putInChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!takeFromChest',
        description: 'Take the given items from the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to take.' },
            'num': { type: 'int', description: 'The number of items to take.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.takeFromChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!viewChest',
        description: 'View the items/counts of the nearest chest.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.viewChest(agent.bot);
        })
    },
    {
        name: '!discard',
        description: 'Discard the given item from the inventory.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to discard.' },
            'num': { type: 'int', description: 'The number of items to discard.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            const start_loc = agent.bot.entity.position;
            await skills.moveAway(agent.bot, 5);
            await skills.discard(agent.bot, item_name, num);
            await skills.goToPosition(agent.bot, start_loc.x, start_loc.y, start_loc.z, 0);
        })
    },
    {
        name: '!collectBlocks',
        description: 'Collect the nearest blocks of a given type.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to collect.' },
            'num': { type: 'int', description: 'The number of blocks to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, type, num) => {
            await skills.collectBlock(agent.bot, type, num);
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!craftRecipe',
        description: 'Craft the given recipe a given number of times.',
        params: {
            'recipe_name': { type: 'ItemName', description: 'The name of the output item to craft.' },
            'num': { type: 'int', description: 'The number of times to craft the recipe. This is NOT the number of output items, as it may craft many more items depending on the recipe.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, recipe_name, num) => {
            await skills.craftRecipe(agent.bot, recipe_name, num);
        })
    },
    {
        name: '!gearUp',
        description: 'Deterministically get basic gear from scratch: collect wood, craft tools, mine stone, make stone pickaxe/axe/sword. Use this instead of crafting tools step by step.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.gearUp(agent.bot);
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!obtainTool',
        description: 'Get one specific tool by crafting the whole chain automatically (wood, planks, sticks, table, mining as needed). Prefer this over !craftRecipe for tools.',
        params: {
            'tool': { type: 'ItemName', description: 'The tool to obtain, e.g. stone_pickaxe, iron_axe, wooden_sword.' }
        },
        perform: runAsAction(async (agent, tool) => {
            await skills.obtainTool(agent.bot, tool);
        }, false, 10)
    },
    {
        name: '!setHome',
        description: 'Set your home base and respawn point at the nearest player (or your own spot). Radius 10 = 20x20 area. You keep your stuff and build here.',
        params: {},
        perform: function (agent) {
            const bot = agent.bot;
            const player = (agent.commandSource ? bot.players[agent.commandSource]?.entity : null)
                ?? bot.nearestEntity(entity =>
                    entity.type === 'player'
                    && entity.username !== bot.username
                    && !convoManager.isOtherAgent(entity.username));
            const pos = (player && player.position.distanceTo(bot.entity.position) < 12)
                ? player.position : bot.entity.position;
            base.setHome(bot, pos.x, pos.y, pos.z, 10);
            return 'Baza nastavljena.';
        }
    },
    {
        name: '!goHome',
        description: 'Walk back to your home base.',
        params: {},
        perform: runAsAction(async (agent) => { await base.goHome(agent.bot); }, false, 5)
    },
    {
        name: '!clearHome',
        description: 'Forget the home base: no more base leash, auto-return or home respawn. The old home spot is kept as the bot\'s personal camp (its own chest corner), so nothing is lost.',
        params: {},
        perform: function (agent) {
            base.clearHome(agent.bot);
            return 'Baza pozabljena.';
        }
    },
    {
        name: '!storage',
        description: 'Set the nearby area as shared public storage and town center; also sets every bot\'s home base and respawn point there (auto !setHome). Optional style: medieval, modern, british, classic, mixed.',
        params: {
            'style': { type: 'string', description: 'Optional town style: medieval, modern, british, classic, or mixed.', optional: true },
        },
        perform: runAsAction(async (agent, style) => {
            const bot = agent.bot;
            const townStyle = style ? build.resolveSchematicCategory(style) : null;
            if (style && !townStyle) {
                skills.log(bot, `Ne poznam stila "${style}". Uporabi medieval, modern, british, classic ali mixed.`);
                return;
            }
            const sourcePlayer = agent.commandSource
                ? bot.players[agent.commandSource]?.entity
                : null;
            if (agent.commandSource && !sourcePlayer) {
                await new Promise(resolve => setTimeout(resolve, 800));
                const shared = storage.getPublicStorageAnchor(bot);
                const fresh = shared && Date.now() - Date.parse(shared.updatedAt) < 10_000;
                if (fresh) {
                    await storage.setupPublicStorage(bot);
                    // !storage is also the crew-wide !setHome: town center = home + respawn.
                    base.setHome(bot, shared.x, shared.y, shared.z, 14);
                    return;
                }
                skills.log(bot, `Igralca ${agent.commandSource} ne vidim, zato lokacije storage ne bom ugibal.`);
                return;
            }
            const nearbyHuman = sourcePlayer ?? bot.nearestEntity(entity =>
                entity.type === 'player'
                && entity.username !== bot.username
                && !convoManager.isOtherAgent(entity.username));
            const position = nearbyHuman?.position ?? bot.entity.position;
            const ok = await storage.configurePublicStorage(bot, position, 12, townStyle);
            if (ok) {
                const shared = storage.getPublicStorageAnchor(bot);
                if (shared) {
                    await town.resetTownPlan(bot, {
                        x: shared.x,
                        y: shared.y,
                        z: shared.z,
                        dimension: shared.dimension,
                        style: shared.townStyle ?? townStyle ?? 'mixed',
                    });
                    // !storage is also the crew-wide !setHome: town center = home + respawn.
                    base.setHome(bot, shared.x, shared.y, shared.z, 14);
                    skills.log(bot, `Javni storage je zdaj center vasi pri ${shared.x},${shared.y},${shared.z} (stil ${shared.townStyle ?? townStyle ?? 'mixed'}).`);
                }
            }
        }, false, 10)
    },
    {
        name: '!clearStorage',
        description: 'Undo !storage: forget the shared public storage / town center for ALL bots. The chests and items stay in the world. Homes stay set — use !clearHome too if bots should roam free with personal camps.',
        params: {},
        perform: function (agent) {
            storage.clearPublicStorage();
            return 'Javni storage pozabljen.';
        }
    },
    {
        name: '!setupBase',
        description: 'Go home (or to your own personal camp, claiming one if you have no home) and set up the base: place a crafting table, chest and furnace (crafting them if needed).',
        params: {},
        perform: runAsAction(async (agent) => { await base.setupBase(agent.bot); }, false, 8)
    },
    {
        name: '!setupHomeLife',
        description: 'Set up player-like home life: base/camp utilities, bed and basic home lighting.',
        params: {},
        perform: runAsAction(async (agent) => {
            const status = await homeLife.setupHomeLife(agent);
            skills.log(agent.bot, homeLife.formatHomeLifeStatus(status));
        }, false, 10)
    },
    {
        name: '!sleepHome',
        description: 'Go to the home/camp bed, sleep when it is night, then run morning prep.',
        params: {},
        perform: runAsAction(async (agent) => {
            const status = await homeLife.sleepAtHome(agent);
            skills.log(agent.bot, homeLife.formatHomeLifeStatus(status));
        }, false, 8)
    },
    {
        name: '!morningPrep',
        description: 'Run the player-like morning routine: recover, restock, stash overflow and prepare steward loadout.',
        params: {},
        perform: runAsAction(async (agent) => {
            const status = await homeLife.morningPrep(agent);
            skills.log(agent.bot, homeLife.formatHomeLifeStatus(status));
        }, false, 8)
    },
    {
        name: '!auditHomeLight',
        description: 'Audit and improve torch coverage around the home/camp corner.',
        params: {},
        perform: runAsAction(async (agent) => {
            const status = await homeLife.lightHome(agent);
            skills.log(agent.bot, homeLife.formatHomeLifeStatus(status));
        }, false, 8)
    },
    {
        name: '!stash',
        description: 'Deposit non-essential items into organized public storage when configured, otherwise into the private base chest. A bot without a home claims its own personal camp chest.',
        params: {},
        perform: runAsAction(async (agent) => { await base.stash(agent.bot); }, false, 8)
    },
    {
        name: '!build',
        description: 'Queue a town build around public storage by exact name, category, or random. The city builds it slowly with commands.',
        params: { 'name': { type: 'string', description: 'Exact name, a category such as "moderne stavbe", or "random".' } },
        perform: runAsAction(async (agent, name) => {
            if (settings.allow_building === false) {
                skills.log(agent.bot, 'Gradnja je izklopljena v settings.js (allow_building=false).');
                return;
            }
            const shared = storage.getPublicStorageAnchor(agent.bot);
            if (!shared) {
                skills.log(agent.bot, 'Najprej nastavi center vasi z !storage <medieval|modern|british|classic|mixed>.');
                return;
            }
            const resolved = build.resolveSchematic(name, Math.random, shared.townStyle);
            if (!resolved.entry) {
                skills.log(agent.bot, resolved.error);
                return;
            }
            if (resolved.selection !== 'exact')
                skills.log(agent.bot, `Izbral sem "${resolved.entry.name}" (${resolved.entry.categoryLabel}).`);
            await storage.setupPublicStorage(agent.bot, 500);
            await town.queueBuild(agent.bot, resolved.entry.name);
        }, false, 2)
    },
    {
        name: '!demolish',
        description: 'Explicitly demolish the nearest registered NPC schematic build near the commanding player.',
        params: {},
        perform: runAsAction(async (agent) => {
            const bot = agent.bot;
            const sourcePlayer = agent.commandSource
                ? bot.players[agent.commandSource]?.entity
                : null;
            if (agent.commandSource && !sourcePlayer) {
                skills.log(bot, `Igralca ${agent.commandSource} ne vidim, zato ne bom ugibal, katero gradnjo naj porusim.`);
                return;
            }
            const nearbyHuman = sourcePlayer ?? bot.nearestEntity(entity =>
                entity.type === 'player'
                && entity.username !== bot.username
                && !convoManager.isOtherAgent(entity.username));
            const position = nearbyHuman?.position ?? bot.entity.position;
            await build.demolishNearestBuild(bot, position, 48);
        }, false, 5)
    },
    {
        name: '!listSchematics',
        description: 'List the schematics available to build.',
        params: {},
        perform: function (agent) {
            const list = [build.formatSchematicCatalog()];
            return list.length ? `Načrti: ${list.join(', ')}` : 'Ni načrtov v mapi schematics.';
        }
    },
    {
        name: '!takeFromNearbyChests',
        description: 'Go to chests near the player who asked and take ALL items out of them. High priority — use when asked to look in / empty a chest.',
        params: {},
        perform: runAsAction(async (agent) => {
            const bot = agent.bot;
            const player = bot.nearestEntity(e => e.type === 'player' && e.username !== bot.username);
            const pos = (player && player.position.distanceTo(bot.entity.position) < 16) ? player.position : bot.entity.position;
            await base.takeFromChestsNear(bot, pos, 6, null);
        }, false, 8)
    },
    {
        name: '!advance',
        description: 'Run the next deterministic progression step (base, iron tools/armor, diamond tools/armor).',
        params: {},
        perform: runAsAction(async (agent) => {
            await progression.runProgression(agent);
        }, false, 10)
    },
    {
        name: '!getIron',
        description: 'Deterministically progress to iron: mine iron ore (digging if needed), smelt it, craft an iron pickaxe (and sword).',
        params: {},
        perform: runAsAction(async (agent) => { await survival.progressToIron(agent.bot); }, false, 12)
    },
    {
        name: '!mineOre',
        description: 'Mine a given ore, searching and strip-mining as needed. e.g. iron_ore, coal_ore, diamond_ore.',
        params: {
            'ore': { type: 'BlockName', description: 'Ore block to mine (e.g. iron_ore).' },
            'count': { type: 'int', description: 'How many to obtain.', domain: [1, 64] }
        },
        perform: runAsAction(async (agent, ore, count) => {
            const names = [ore, 'deepslate_' + ore]
                .filter(n => mc.registryBlockIds(agent.bot, n).length > 0);
            await survival.mineOre(agent.bot, names.length ? names : [ore], count);
        }, false, 12)
    },
    {
        name: '!getFood',
        description: 'Get food: hunt a nearby animal and cook the meat.',
        params: {},
        perform: runAsAction(async (agent) => { await survival.secureFood(agent.bot); }, false, 6)
    },
    {
        name: '!farm',
        description: 'Create and maintain an irrigated 9x9 wheat farm, then breed and sustainably cull nearby cows, pigs, and chickens.',
        params: {},
        perform: runAsAction(async (agent) => {
            await survival.tendFarm(agent.bot, 80);
            // Farm setup is intentionally resumable because water escape and
            // path recovery may preempt it. Stop resuming after a normal finish.
            if (!agent.bot.interrupt_code) agent.actions.cancelResume();
        }, true, 12)
    },
    {
        name: '!cleanup',
        description: 'Remove obvious floating dirt/cobblestone scaffolds and thin temporary towers around the settlement without touching registered builds, farms, storage, lights, or spawners.',
        params: {},
        perform: runAsAction(async (agent) => {
            await tidy.cleanupSettlement(agent.bot, true);
        }, false, 8)
    },
    {
        name: '!makeTorches',
        description: 'Make torches (mining a little coal if needed).',
        params: {},
        perform: runAsAction(async (agent) => { await survival.makeTorches(agent.bot, 8); }, false, 8)
    },
    {
        name: '!maintainTools',
        description: 'Replace any broken or worn-out pickaxe/axe/sword with a fresh one.',
        params: {},
        perform: runAsAction(async (agent) => { await survival.maintainTools(agent.bot); }, false, 8)
    },
    {
        name: '!prepareForTask',
        description: 'Prepare inventory and equipment for a task profile: miner, builder, farmer, ranger, steward, explorer, or escort.',
        params: {
            'profile': { type: 'string', description: 'Task profile name.' },
        },
        perform: runAsAction(async (agent, profile) => {
            const status = await loadout.prepareForTask(agent, profile);
            skills.log(agent.bot, loadout.formatLoadoutStatus(agent.bot, status.name));
        }, false, 10)
    },
    {
        name: '!smeltItem',
        description: 'Smelt the given item the given number of times.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of times to smelt the item.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.smeltItem(agent.bot, item_name, num);
        })
    },
    {
        name: '!clearFurnace',
        description: 'Take all items out of the nearest furnace.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
        {
        name: '!placeHere',
        description: 'Place a given block in the current location. Do NOT use to build structures, only use for single blocks/torches.',
        params: {'type': { type: 'BlockOrItemName', description: 'The block type to place.' }},
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!attack',
        description: 'Owner-safe attack order. With no target, clear all nearby hostiles; with a target, attack matching hostiles or named adult huntable animals. Never attacks players.',
        params: {
            'target': { type: 'string', description: 'Optional target such as zombie, skeleton, cow, or sheep. Omit for all nearby hostiles.', optional: true },
            'count': { type: 'int', description: 'Optional maximum number of matching targets.', optional: true, domain: [1, 33] },
        },
        perform: runAsAction(async (agent, target = null, count = null) => {
            const query = target || 'enemy';
            return await combat.attackTargets(agent, query, count, { source: agent.commandSource });
        }, false, 10)
    },
    {
        name: '!attackTarget',
        description: 'Owner-safe combat order. Attack nearby non-player targets matching a name like zombie, skeleton, nearest enemy, or that mob. Never attacks real players.',
        params: {
            'target': { type: 'string', description: 'Target description, e.g. zombie, skeleton, nearest enemy, that mob.' },
            'count': { type: 'int', description: 'How many matching targets to attack, default 1.', optional: true, domain: [1, 33] }
        },
        perform: runAsAction(async (agent, target, count = 1) => {
            await combat.attackTargets(agent, target, count, { source: agent.commandSource });
        }, false, 5)
    },
    {
        name: '!combatStance',
        description: 'Temporarily set combat behavior: aggressive seeks nearby hostiles, defensive only reacts/guards, passive holds fire, normal resets.',
        params: {
            'stance': { type: 'string', description: 'aggressive, defensive, passive, or normal.' },
            'minutes': { type: 'int', description: 'Duration in minutes. -1 means forever, default 15.', optional: true, domain: [-1, 120] }
        },
        perform: function (agent, stance, minutes = 15) {
            const result = combat.setOwnerCombatStance(agent, stance, minutes);
            if (!result) return `Unknown combat stance "${stance}". Use aggressive, defensive, passive, or normal.`;
            return result.reset
                ? 'Combat stance reset to normal.'
                : `Combat stance set to ${result.stance}${result.minutes === -1 ? '' : ` for ${result.minutes} minutes`}.`;
        }
    },
    {
        name: '!combatStyle',
        description: 'Temporarily set fighting style: archer/ranged uses bows when safe, defender/melee uses shield and melee, normal resets.',
        params: {
            'style': { type: 'string', description: 'archer, defender, or normal.' },
            'minutes': { type: 'int', description: 'Duration in minutes. -1 means forever, default 15.', optional: true, domain: [-1, 120] }
        },
        perform: function (agent, style, minutes = 15) {
            const result = combat.setOwnerCombatStyle(agent, style, minutes);
            if (!result) return `Unknown combat style "${style}". Use archer, defender, or normal.`;
            return result.reset
                ? `Combat style reset to ${result.style}.`
                : `Combat style set to ${result.style}${result.minutes === -1 ? '' : ` for ${result.minutes} minutes`}.`;
        }
    },
    {
        name: '!attackPlayer',
        description: 'Refuse to attack a real player. Bots dislike violence and do not do PvP.',
        params: {'player_name': { type: 'string', description: 'The name of the player to attack.'}},
        perform: (agent, player_name) => {
            skills.log(agent.bot, `Refusing to attack player ${player_name}.`);
            return `I will not attack ${player_name}. I do not fight real players.`;
        }
    },
    {
        name: '!goToBed',
        description: 'Go to the nearest bed and sleep. Prefer !sleepHome for the full home-life routine.',
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        })
    },
    {
        name: '!stay',
        description: 'Stay in the current location no matter what. Pauses all modes.',
        params: {'type': { type: 'int', description: 'The number of seconds to stay. -1 for forever.', domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        description: 'Set a mode to on or off. A mode is an automatic behavior that constantly checks and responds to the environment.',
        params: {
            'mode_name': { type: 'string', description: 'The name of the mode to enable.' },
            'on': { type: 'boolean', description: 'Whether to enable or disable the mode.' }
        },
        perform: function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
            return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
            return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!goal',
        description: 'Set a goal prompt to endlessly work towards with continuous self-prompting.',
        params: {
            'selfPrompt': { type: 'string', description: 'The goal prompt.' },
        },
        perform: function (agent, prompt) {
            if (convoManager.inConversation()) {
                agent.self_prompter.setPromptPaused(prompt);
            }
            else {
                agent.self_prompter.start(prompt);
            }
        }
    },
    {
        name: '!endGoal',
        description: 'Call when you have accomplished your goal. It will stop self-prompting and the current action. ',
        perform: function (agent) {
            agent.self_prompter.stop();
            return 'Self-prompting stopped.';
        }
    },
    {
        name: '!showVillagerTrades',
        description: 'Show trades of a specified villager.',
        params: {'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' }},
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: 'Trade with a specified villager.',
        params: {
            'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' },
            'index': { type: 'int', description: 'The index of the trade you want executed (1-indexed).', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: 'How many times that trade should be executed.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: 'Start a conversation with a bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to send the message to.' },
            'message': { type: 'string', description: 'The message to send.' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name)) 
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                await agent.history.add('system', 'You are already in conversation with ' + player_name + '. Don\'t use this command to talk to them.');
            convoManager.startConversation(player_name, message);
        }
    },
    {
        name: '!endConversation',
        description: 'End the conversation with the given bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to end the conversation with.' }
        },
        perform: function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
    },
    {
        name: '!lookAtPlayer',
        description: 'Look at a player or look in the same direction as the player.',
        params: {
            'player_name': { type: 'string', description: 'Name of the target player' },
            'direction': {
                type: 'string',
                description: 'How to look ("at": look at the player, "with": look in the same direction as the player)',
            }
        },
        perform: async function(agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
                result = agent.vision_interpreter
                    ? await agent.vision_interpreter.lookAtPlayer(player_name, direction)
                    : "Vision is disabled.";
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!lookAtPosition',
        description: 'Look at specified coordinates.',
        params: {
            'x': { type: 'int', description: 'x coordinate' },
            'y': { type: 'int', description: 'y coordinate' },
            'z': { type: 'int', description: 'z coordinate' }
        },
        perform: async function(agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
                result = agent.vision_interpreter
                    ? await agent.vision_interpreter.lookAtPosition(x, y, z)
                    : "Vision is disabled.";
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: 'Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.',
        params: {'distance': { type: 'int', description: 'Distance to dig down', domain: [1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance);
        })
    },
    {
        name: '!goToSurface',
        description: 'Moves the bot to the highest block above it (usually the surface).',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!useOn',
        description: 'Use (right click) the given tool on the nearest target of the given type.',
        params: {
            'tool_name': { type: 'string', description: 'Name of the tool to use, or "hand" for no tool.' },
            'target': { type: 'string', description: 'The target as an entity type, block type, or "nothing" for no target.' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
];
