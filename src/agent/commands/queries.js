import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { checkLevelBlueprint, checkBlueprint } from '../tasks/construction_tasks.js';
import { load } from 'cheerio';
import * as progression from '../library/progression.js';
import * as decisionGraph from '../library/decision_graph.js';
import * as build from '../library/build.js';
import { formatGameplayStatus } from '../library/gameplay_status.js';
import { formatLoadoutStatus } from '../library/loadout.js';
import { formatRoyalDuty } from '../library/royal_intent.js';
import { formatHomeLifeStatus } from '../library/home_life.js';
import { formatPlayerHelperStatus } from '../library/player_helper.js';
import * as combat from '../library/combat.js';
import settings from '../settings.js';

const pad = (str) => {
    return '\n' + str + '\n';
};

async function getOtherBotNames(agent) {
    const { default: convoManager } = await import('../conversation.js');
    return convoManager.getInGameAgents().filter(name => name !== agent.name);
}

// queries are commands that just return strings and don't affect anything in the world
export const queryList = [
    {
        name: "!stats",
        description: "Get your bot's location, health, hunger, and time of day.", 
        perform: async function (agent) {
            let bot = agent.bot;
            let res = 'STATS';
            let pos = bot.entity.position;
            // display position to 2 decimal places
            res += `\n- Position: x: ${pos.x.toFixed(2)}, y: ${pos.y.toFixed(2)}, z: ${pos.z.toFixed(2)}`;
            // Gameplay
            res += `\n- Gamemode: ${bot.game.gameMode}`;
            res += `\n- Health: ${Math.round(bot.health)} / 20`;
            res += `\n- Hunger: ${Math.round(bot.food)} / 20`;
            res += `\n- Biome: ${world.getBiomeName(bot)}`;
            let weather = "Clear";
            if (bot.rainState > 0)
                weather = "Rain";
            if (bot.thunderState > 0)
                weather = "Thunderstorm";
            res += `\n- Weather: ${weather}`;
            // let block = bot.blockAt(pos);
            // res += `\n- Artficial light: ${block.skyLight}`;
            // res += `\n- Sky light: ${block.light}`;
            // light properties are bugged, they are not accurate


            if (bot.time.timeOfDay < 6000) {
                res += '\n- Time: Morning';
            } else if (bot.time.timeOfDay < 12000) {
                res += '\n- Time: Afternoon';
            } else {
                res += '\n- Time: Night';
            }

            // get the bot's current action
            let action = agent.actions.currentActionLabel;
            if (agent.isIdle())
                action = 'Idle';
            res += `\n- Current Action: ${action}`;


            let players = world.getNearbyPlayerNames(bot);
            let bots = await getOtherBotNames(agent);
            players = players.filter(p => !bots.includes(p));

            res += '\n- Nearby Human Players: ' + (players.length > 0 ? players.join(', ') : 'None.');
            res += '\n- Nearby Bot Players: ' + (bots.length > 0 ? bots.join(', ') : 'None.');

            res += '\n' + agent.bot.modes.getMiniDocs() + '\n';
            return pad(res);
        }
    },
    {
        name: "!inventory",
        description: "Get your bot's inventory.",
        perform: function (agent) {
            let bot = agent.bot;
            let inventory = world.getInventoryCounts(bot);
            let res = 'INVENTORY';
            for (const item in inventory) {
                if (inventory[item] && inventory[item] > 0)
                    res += `\n- ${item}: ${inventory[item]}`;
            }
            if (res === 'INVENTORY') {
                res += ': Nothing';
            }
            else if (agent.bot.game.gameMode === 'creative') {
                res += '\n(You have infinite items in creative mode. You do not need to gather resources!!)';
            }

            let helmet = bot.inventory.slots[5];
            let chestplate = bot.inventory.slots[6];
            let leggings = bot.inventory.slots[7];
            let boots = bot.inventory.slots[8];
            res += '\nWEARING: ';
            if (helmet)
                res += `\nHead: ${helmet.name}`;
            if (chestplate)
                res += `\nTorso: ${chestplate.name}`;
            if (leggings)
                res += `\nLegs: ${leggings.name}`;
            if (boots)
                res += `\nFeet: ${boots.name}`;
            if (!helmet && !chestplate && !leggings && !boots)
                res += 'Nothing';

            return pad(res);
        }
    },
    {
        name: "!nearbyBlocks",
        description: "Get the blocks near the bot.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_BLOCKS';
            let blocks = world.getNearestBlocks(bot, null, 8, 256);
            let block_details = new Set();
            
            for (let block of blocks) {
                let details = block.name;
                if (block.name === 'water' || block.name === 'lava') {
                    details += block.metadata === 0 ? ' (source)' : ' (flowing)';
                }
                block_details.add(details);
            }
            for (let details of block_details) {
                res += `\n- ${details}`;
            }
            if (block_details.size === 0) {
                res += ': none';
            } 
            else {
                res += '\n- ' + world.getSurroundingBlocks(bot).join('\n- ');
                res += `\n- First Solid Block Above Head: ${world.getFirstBlockAboveHead(bot, null, 32)}`;
            }
            return pad(res);
        }
    },
    {
        name: "!craftable",
        description: "Get the craftable items with the bot's inventory.",
        perform: function (agent) {
            let craftable = world.getCraftableItems(agent.bot);
            let res = 'CRAFTABLE_ITEMS';
            for (const item of craftable) {
                res += `\n- ${item}`;
            }
            if (res == 'CRAFTABLE_ITEMS') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!entities",
        description: "Get the nearby players and entities.",
        perform: async function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_ENTITIES';
            let players = world.getNearbyPlayerNames(bot);
            let bots = await getOtherBotNames(agent);
            players = players.filter(p => !bots.includes(p));

            for (const player of players) {
                res += `\n- Human player: ${player}`;
            }
            for (const bot of bots) {
                res += `\n- Bot player: ${bot}`;
            }

            let nearbyEntities = world.getNearbyEntities(bot);
            let entityCounts = {};
            let villagerIds = [];
            let babyVillagerIds = [];
            let villagerDetails = []; // Store detailed villager info including profession
            
            for (const entity of nearbyEntities) {
                if (entity.type === 'player' || entity.name === 'item')
                    continue;
                    
                if (!entityCounts[entity.name]) {
                    entityCounts[entity.name] = 0;
                }
                entityCounts[entity.name]++;
                
                if (entity.name === 'villager') {
                    if (mc.isBabyEntity(entity, bot)) {
                        babyVillagerIds.push(entity.id);
                    } else {
                        const profession = world.getVillagerProfession(entity);
                        villagerIds.push(entity.id);
                        villagerDetails.push({
                            id: entity.id,
                            profession: profession
                        });
                    }
                }
            }
            
            for (const [entityType, count] of Object.entries(entityCounts)) {
                if (entityType === 'villager') {
                    let villagerInfo = `${count} ${entityType}(s)`;
                    if (villagerDetails.length > 0) {
                        const detailStrings = villagerDetails.map(v => `(${v.id}:${v.profession})`);
                        villagerInfo += ` - Adults: ${detailStrings.join(', ')}`;
                    }
                    if (babyVillagerIds.length > 0) {
                        villagerInfo += ` - Baby IDs: ${babyVillagerIds.join(', ')} (babies cannot trade)`;
                    }
                    res += `\n- entities: ${villagerInfo}`;
                } else {
                    res += `\n- entities: ${count} ${entityType}(s)`;
                }
            }
            
            if (res == 'NEARBY_ENTITIES') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!modes",
        description: "Get all available modes and their docs and see which are on/off.",
        perform: function (agent) {
            return agent.bot.modes.getDocs();
        }
    },
    {
        name: '!savedPlaces',
        description: 'List all saved locations.',
        perform: function (agent) {
            return "Saved place names: " + agent.memory_bank.getKeys();
        }
    }, 
    {
        name: '!checkBlueprintLevel',
        description: 'Check if the level is complete and what blocks still need to be placed for the blueprint',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = checkLevelBlueprint(agent, levelNum);
            console.log(res);
            return pad(res);
        }
    }, 
    {
        name: '!checkBlueprint',
        description: 'Check what blocks still need to be placed for the blueprint',
        perform: function (agent) {
            let res = checkBlueprint(agent);
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprint',
        description: 'Get the blueprint for the building',
        perform: function (agent) {
            let res = agent.task.blueprint.explain();
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprintLevel',
        description: 'Get the blueprint for the building',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = agent.task.blueprint.explainLevel(levelNum);
            console.log(res);
            return pad(res);
        }
    },
    {
        name: '!getCraftingPlan',
        description: "Provides a comprehensive crafting plan for a specified item. This includes a breakdown of required ingredients, the exact quantities needed, and an analysis of missing ingredients or extra items needed based on the bot's current inventory.",
        params: {
            targetItem: { 
                type: 'string', 
                description: 'The item that we are trying to craft' 
            },
            quantity: { 
                type: 'int',
                description: 'The quantity of the item that we are trying to craft',
                optional: true,
                domain: [1, Infinity, '[)'], // Quantity must be at least 1,
                default: 1
            }
        },
        perform: function (agent, targetItem, quantity = 1) {
            let bot = agent.bot;

            // Fetch the bot's inventory
            const curr_inventory = world.getInventoryCounts(bot); 
            const target_item = targetItem;
            let existingCount = curr_inventory[target_item] || 0;
            let prefixMessage = '';
            if (existingCount > 0) {
                curr_inventory[target_item] -= existingCount;
                prefixMessage = `You already have ${existingCount} ${target_item} in your inventory. If you need to craft more,\n`;
            }

            // Generate crafting plan
            try {
                let craftingPlan = mc.getDetailedCraftingPlan(target_item, quantity, curr_inventory);
                craftingPlan = prefixMessage + craftingPlan;
                return pad(craftingPlan);
            } catch (error) {
                console.error("Error generating crafting plan:", error);
                return `An error occurred while generating the crafting plan: ${error.message}`;
            }
            
            
        },
    },
    {
        name: '!searchWiki',
        description: 'Search the Minecraft Wiki for the given query.',
        params: {
            'query': { type: 'string', description: 'The query to search for.' }
        },
        perform: async function (agent, query) {
            const url = `https://minecraft.wiki/w/${query}`;
            try {
                const response = await fetch(url);
                if (response.status === 404) {
                  return `${query} was not found on the Minecraft Wiki. Try adjusting your search term.`;
                }
                const html = await response.text();
                const $ = load(html);
            
                const parserOutput = $("div.mw-parser-output");
                
                parserOutput.find("table.navbox").remove();

                const divContent = parserOutput.text();
            
                return divContent.trim();
              } catch (error) {
                console.error("Error fetching or parsing HTML:", error);
                return `The following error occurred: ${error}`;
              }
        }
    },
    {
        name: '!progress',
        description: 'Show completed and currently unlocked progression milestone branches.',
        perform: function (agent) {
            const p = progression.getStatus(agent.bot);
            const open = p.availableMilestones.map(milestone => {
                const estimate = progression.estimateMilestone(agent, milestone.id, p);
                const work = p.work?.[milestone.id];
                return `${milestone.id}{cost=${estimate?.estimatedCost ?? 0},unlock=${estimate?.unlockValue ?? 0}`
                    + `${work?.blocker ? `,blocker=${work.blocker}` : ''}}`;
            }).join(', ') || 'none';
            const done = p.completedMilestones.join(', ') || 'none';
            return `PROGRESS GRAPH: priporočilo=${p.stage} (${p.label}) | odprto=[${open}] | opravljeno=[${done}] | cilj=${p.target} | železni oklep=${p.ironArmor}/4 | diamantni oklep=${p.diamondArmor}/4`;
        }
    },
    {
        name: '!decisions',
        description: 'Show the latest dynamic decision winner, ranked candidates and external command goals.',
        perform: function (agent) {
            return decisionGraph.formatDecisionStatus(agent);
        }
    },
    {
        name: '!gameplay',
        description: 'Show deterministic gameplay readiness: survival, loadout, village state, work profiles, blockers and next suggested commands.',
        perform: function (agent) {
            return pad(formatGameplayStatus(agent));
        }
    },
    {
        name: '!loadout',
        description: 'Show task loadout readiness. Optional profile: miner, builder, farmer, ranger, steward, explorer, escort, or all.',
        params: {
            'profile': { type: 'string', description: 'Optional task profile name.', optional: true },
        },
        perform: function (agent, profile = 'all') {
            return pad(formatLoadoutStatus(agent.bot, profile));
        }
    },
    {
        name: '!royalDuty',
        description: 'Show current and last structured royal duty contract.',
        perform: function (agent) {
            return pad(formatRoyalDuty(agent));
        }
    },
    {
        name: '!homeLife',
        description: 'Show home-life readiness: bed, personal corner, lighting and morning kit.',
        perform: function (agent) {
            return pad(formatHomeLifeStatus(agent));
        }
    },
    {
        name: '!helperStatus',
        description: 'Show player-helper readiness for bring/carry/deliver/guard/build support.',
        perform: function (agent) {
            return pad(formatPlayerHelperStatus(agent));
        }
    },
    {
        name: '!kingdom',
        description: 'Show society roles, current work, buildings, roads and the latest shared event.',
        perform: async function () {
            const [society, roads] = await Promise.all([
                import('../library/society.js'),
                import('../library/roads.js'),
            ]);
            const road = roads.roadSummary();
            return `${society.formatSocietyStatus()} | poti: koncane=${road.complete}, delne=${road.partial}, blokirane=${road.blocked}`;
        }
    },
    {
        name: '!persona',
        description: 'Show this bot personality profile and current roleplay identity.',
        perform: async function (agent) {
            const { formatPersonaCard } = await import('../roleplay/personality.js');
            const { scenarioSummary } = await import('../roleplay/scenario.js');
            const scenario = scenarioSummary();
            return formatPersonaCard(agent.personality)
                + ` | scenario: ${scenario || 'none (roleplay.md empty)'}`;
        }
    },
    {
        name: '!memory',
        description: 'Show recent structured RP memories for this bot.',
        params: {
            count: {
                type: 'int',
                description: 'Number of memories to show',
                optional: true,
                domain: [1, 20, '[]'],
                default: 8,
            },
        },
        perform: async function (agent, count = 8) {
            const { formatMemoryStatus } = await import('../roleplay/memory.js');
            return formatMemoryStatus(agent, count);
        }
    },
    {
        name: '!relations',
        description: 'Show this bot social relationship graph, optionally toward one target.',
        params: {
            target: {
                type: 'string',
                description: 'Optional bot or player name',
                optional: true,
            },
        },
        perform: async function (agent, target = null) {
            const { formatRelations } = await import('../roleplay/social_graph.js');
            return formatRelations(agent.name, target);
        }
    },
    {
        name: '!culture',
        description: 'Show kingdom culture norms and the current shared settlement value.',
        perform: async function (agent) {
            const { formatCultureStatus } = await import('../library/culture.js');
            return formatCultureStatus(agent);
        }
    },
    {
        name: '!reflection',
        description: 'Show this bot long-timescale reflection status and self-image.',
        perform: async function (agent) {
            const { formatReflectionStatus } = await import('../roleplay/reflection.js');
            return formatReflectionStatus(agent);
        }
    },
    {
        name: '!loyalty',
        description: 'Show the configured loyal owner, command lock, current action, and combat stance.',
        perform: function (agent) {
            const owner = String(settings.owner_player ?? '').trim() || '(not configured)';
            const ownerOnly = settings.owner_only_commands === true ? 'ON' : 'OFF';
            const current = agent.actions?.currentActionLabel || 'idle';
            return `LOYALTY: owner=${owner} | owner-only actions=${ownerOnly} | current=${current} | combat=${combat.getCombatStance(agent)}/${combat.getCombatStyle(agent)} | commands: !follow [distance], !defend [minutes], !attack [target] [count], !storage`;
        }
    },
    {
        name: '!help',
        description: 'Lists all available commands and their descriptions.',
        perform: async function (agent) {
            const { getCommandDocs } = await import('./index.js');
            return getCommandDocs(agent);
        }
    },
    {
        name: '!ukazi',
        description: 'Kratek seznam najbolj uporabnih ukazov (v slovenščini).',
        perform: function (agent) {
            return 'Loyal squad (owner): !follow [razdalja], !defend [minute], !defende [minute], !attack [tarca] [stevilo], !storage [stil], !stop | '
                + 'Baza: !setHome, !clearHome, !storage <medieval|modern|british|classic|mixed>, !clearStorage, !goHome, !setupBase, !setupHomeLife, !sleepHome, !morningPrep, !auditHomeLight, !stash, !build <ime|kategorija|random>, !demolish, !cleanup, !schematics | '
                + 'Razvoj: !progress, !advance | Delo: !loadout [profil], !prepareForTask <profil>, !bringToPlayer <igralec> <item> <n>, !carryNearbyChest [igralec] [item], !guardPlayer <igralec>, !helpBuild [igralec] [nacrt], !getIron, !mineOre <ruda> <n>, !getFood, !farm, !makeTorches, !maintainTools | '
                + 'Skrinje: !takeFromNearbyChests | '
                + 'Gibanje: !goToPlayer <ime>, !followPlayer <ime>, !stay, !stop | '
                + 'Info: !loyalty, !progress, !decisions, !gameplay, !homeLife, !helperStatus, !royalDuty, !stats, !inventory, !savedPlaces, !kingdom, !persona, !memory, !relations, !culture, !reflection, !help (poln seznam vseh ukazov)';
        }
    },
    {
        name: '!schematics',
        description: 'List all schematic names grouped by category.',
        perform: function () {
            return build.formatSchematicCatalog();
        }
    },
    {
        name: '!shematics',
        description: 'Alias for !schematics.',
        perform: function () {
            return build.formatSchematicCatalog();
        }
    },
];
