import { getBlockId, getItemId } from "../../utils/mcdata.js";
import { actionsList } from './actions.js';
import { queryList } from './queries.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import * as decisionGraph from '../library/decision_graph.js';

let suppressNoDomainWarning = true;

const commandList = queryList.concat(actionsList);
const commandMap = {};
for (let command of commandList) {
    commandMap[command.name] = command;
}

export function getCommand(name) {
    return commandMap[name];
}

export function blacklistCommands(commands) {
    const unblockable = ['!stop', '!stats', '!inventory', '!goal'];
    for (let command_name of commands) {
        if (unblockable.includes(command_name)){
            console.warn(`Command ${command_name} is unblockable`);
            continue;
        }
        delete commandMap[command_name];
        const index = commandList.findIndex(command => command.name === command_name);
        if (index !== -1) commandList.splice(index, 1);
    }
}

const commandRegex = /!(\w+)(?:\(((?:-?\d+(?:\.\d+)?|true|false|"[^"]*")(?:\s*,\s*(?:-?\d+(?:\.\d+)?|true|false|"[^"]*"))*)\))?/;
const argRegex = /-?\d+(?:\.\d+)?|true|false|"[^"]*"/g;

export function containsCommand(message) {
    const commandMatch = message.match(commandRegex);
    if (commandMatch)
        return "!" + commandMatch[1];
    return null;
}

export function commandExists(commandName) {
    if (!commandName.startsWith("!"))
        commandName = "!" + commandName;
    return commandMap[commandName] !== undefined;
}

/**
 * Converts a string into a boolean.
 * @param {string} input
 * @returns {boolean | null} the boolean or `null` if it could not be parsed.
 * */
function parseBoolean(input) {
    switch(input.toLowerCase()) {
        case 'false': //These are interpreted as flase;
        case 'f':
        case '0':
        case 'off':
            return false;
        case 'true': //These are interpreted as true;
        case 't':
        case '1':
        case 'on':
            return true;
        default:
            return null;
    }
}

/**
 * @param {number} value - the value to check
 * @param {number} lowerBound
 * @param {number} upperBound
 * @param {string} endpointType - The type of the endpoints represented as a two character string. `'[)'` `'()'` 
 */
function checkInInterval(number, lowerBound, upperBound, endpointType) {
    switch (endpointType) {
        case '[)':
            return lowerBound <= number && number < upperBound;
        case '()':
            return lowerBound < number && number < upperBound;
        case '(]':
            return lowerBound < number && number <= upperBound;
        case '[]':
            return lowerBound <= number && number <= upperBound;
        default:
            throw new Error(`Unknown endpoint type: ${endpointType}`);
    }
}



// todo: handle arrays?
/**
 * Returns an object containing the command, the command name, and the comand parameters.
 * If parsing unsuccessful, returns an error message as a string.
 * @param {string} message - A message from a player or language model containing a command.
 * @returns {string | Object}
 */
export function parseCommandMessage(message) {
    const commandMatch = message.match(commandRegex);
    if (!commandMatch) return `Command is incorrectly formatted`;

    const commandName = "!"+commandMatch[1];

    const command = getCommand(commandName);
    if(!command) return `${commandName} is not a command.`

    const params = commandParams(command);
    const paramNames = commandParamNames(command);
    let args;
    if (commandMatch[2]) {
        args = commandMatch[2].match(argRegex) ?? [];
    } else if (params.length > 0) {
        // Human-friendly form: !goToPlayer Steve 3. The original parenthesized
        // syntax remains supported for LLM output and strings containing spaces.
        const tail = message.slice(commandMatch.index + commandMatch[0].length).trim();
        args = tail.match(/"[^"]*"|'[^']*'|\S+/g)?.slice(0, params.length) ?? [];
    } else {
        args = [];
    }
    
    const requiredCount = requiredParamCount(command);
    if (args.length < requiredCount || args.length > params.length) {
        const optionalText = requiredCount === params.length
            ? `${params.length}`
            : `${requiredCount}-${params.length}`;
        return `Command ${command.name} was given ${args.length} args, but requires ${optionalText} args.`;
    }

    
    for (let i = 0; i < args.length; i++) {
        const param = params[i];
        //Remove any extra characters
        let arg = args[i].trim();
        if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
            arg = arg.substring(1, arg.length-1);
        }
        
        //Convert to the correct type
        switch(param.type) {
            case 'int':
                arg = Number.parseInt(arg); break;
            case 'float':
                arg = Number.parseFloat(arg); break;
            case 'boolean':
                arg = parseBoolean(arg); break;
            case 'BlockName':
            case 'BlockOrItemName':
            case 'ItemName':
                if (arg.endsWith('plank') || arg.endsWith('seed'))
                    arg += 's'; // add 's' to for common mistakes like "oak_plank" or "wheat_seed"
                break;
            case 'string':
                break;
            default:
                throw new Error(`Command '${commandName}' parameter '${paramNames[i]}' has an unknown type: ${param.type}`);
        }
        if(arg === null || Number.isNaN(arg))
            return `Error: Param '${paramNames[i]}' must be of type ${param.type}.`

        if(typeof arg === 'number') { //Check the domain of numbers
            const domain = param.domain;
            if(domain) {
                /**
                 * Javascript has a built in object for sets but not intervals.
                 * Currently the interval (lowerbound,upperbound] is represented as an Array: `[lowerbound, upperbound, '(]']`
                 */
                if (!domain[2]) domain[2] = '[)'; //By default, lower bound is included. Upper is not.

                if(!checkInInterval(arg, ...domain)) {
                    return `Error: Param '${paramNames[i]}' must be an element of ${domain[2][0]}${domain[0]}, ${domain[1]}${domain[2][1]}.`;
                    //Alternatively arg could be set to the nearest value in the domain.
                }
            } else if (!suppressNoDomainWarning) {
                console.warn(`Command '${commandName}' parameter '${paramNames[i]}' has no domain set. Expect any value [-Infinity, Infinity].`)
                suppressNoDomainWarning = true; //Don't spam console. Only give the warning once.
            }
        } else if(param.type === 'BlockName') { //Check that there is a block with this name
            if(getBlockId(arg) == null) return  `Invalid block type: ${arg}.`
        } else if(param.type === 'ItemName') { //Check that there is an item with this name
            if(getItemId(arg) == null) return `Invalid item type: ${arg}.`
        } else if(param.type === 'BlockOrItemName') {
            if(getBlockId(arg) == null && getItemId(arg) == null) return  `Invalid block or item type: ${arg}.`
        }
        args[i] = arg;
    }
    while (args.length < params.length) args.push(undefined);
    
    return { commandName, args };
}

export function truncCommandMessage(message) {
    const commandMatch = message.match(commandRegex);
    if (!commandMatch) return message;

    const commandEnd = commandMatch.index + commandMatch[0].length;
    if (commandMatch[2]) return message.substring(0, commandEnd);

    const command = getCommand(`!${commandMatch[1]}`);
    const paramCount = command ? commandParams(command).length : 0;
    if (paramCount === 0) return message.substring(0, commandEnd);

    const tail = message.slice(commandEnd);
    const tokens = [...tail.matchAll(/"[^"]*"|'[^']*'|\S+/g)].slice(0, paramCount);
    if (tokens.length === 0) return message.substring(0, commandEnd);
    const last = tokens.at(-1);
    return message.substring(0, commandEnd + last.index + last[0].length);
}

export function isAction(name) {
    return actionsList.find(action => action.name === name) !== undefined;
}

export function isConfiguredOwner(source) {
    const owner = String(settings.owner_player ?? '').trim();
    return Boolean(owner)
        && String(source ?? '').trim().toLowerCase() === owner.toLowerCase();
}

// Internal/self commands and teammate coordination remain available. When an action
// originates from Minecraft chat, however, only the configured owner may control the
// squad. Read-only query commands stay public so other players can still inspect/help.
export function canSourceRunAction(agent, source) {
    if (settings.owner_only_commands !== true) return true;
    if (source == null || source === 'system' || source === agent?.name) return true;
    if (convoManager.isOtherAgent(source)) return true;
    return isConfiguredOwner(source);
}

// Death notifications are system prompts used only to produce a short in-character
// reaction. Letting the model turn them into action commands repeatedly sent bots
// back into the same lethal mob at last_death_position. Other deliberate system/self
// prompts retain their existing command capability.
export function shouldSuppressGeneratedAction(source, prompt, commandName) {
    return source === 'system'
        && isAction(commandName)
        && /^You died at position\b/i.test(String(prompt ?? ''));
}

/**
 * @param {Object} command
 * @returns {Object[]} The command's parameters.
 */
function commandParams(command) {
    if (!command.params)
        return [];
    return Object.values(command.params);
}

/**
 * @param {Object} command
 * @returns {string[]} The names of the command's parameters.
 */
function commandParamNames(command) {
    if (!command.params)
        return [];
    return Object.keys(command.params);
}

function numParams(command) {
    return commandParams(command).length;
}

function requiredParamCount(command) {
    return commandParams(command).filter(param => !param.optional).length;
}

export async function executeCommand(agent, message, source = null) {
    let parsed = parseCommandMessage(message);
    if (typeof parsed === 'string')
        return parsed; //The command was incorrectly formatted or an invalid input was given.
    else {
        console.log('parsed command:', parsed);
        const command = getCommand(parsed.commandName);
        if (isAction(parsed.commandName) && !canSourceRunAction(agent, source)) {
            const owner = String(settings.owner_player ?? '').trim();
            return owner
                ? `Action commands are owner-only. I obey ${owner}.`
                : 'Action commands are locked because no owner_player is configured.';
        }
        let numArgs = 0;
        if (parsed.args) {
            numArgs = parsed.args.length;
        }
        const requiredCount = requiredParamCount(command);
        const totalCount = numParams(command);
        if (numArgs < requiredCount || numArgs > totalCount) {
            const optionalText = requiredCount === totalCount
                ? `${totalCount}`
                : `${requiredCount}-${totalCount}`;
            return `Command ${command.name} was given ${numArgs} args, but requires ${optionalText} args.`;
        }
        else {
            const previousSource = agent.commandSource;
            agent.commandSource = source;
            const externalSource = source != null && source !== 'system' && source !== agent?.name;
            const externalGoalId = isAction(parsed.commandName) && externalSource
                ? decisionGraph.recordExternalGoal(agent, {
                    key: parsed.commandName.slice(1),
                    source: convoManager.isOtherAgent(source) ? 'society' : 'command',
                    description: `${source}: ${message}`,
                })
                : null;
            try {
                const result = await command.perform(agent, ...parsed.args);
                if (externalGoalId) {
                    const succeeded = result !== false && result?.success !== false;
                    decisionGraph.completeExternalGoal(agent, externalGoalId, succeeded ? 'completed' : 'failed');
                }
                return result;
            } catch (error) {
                if (externalGoalId) decisionGraph.completeExternalGoal(agent, externalGoalId, 'failed');
                throw error;
            } finally {
                agent.commandSource = previousSource;
            }
        }
    }
}

export function getCommandDocs(agent) {
    const typeTranslations = {
        //This was added to keep the prompt the same as before type checks were implemented.
        //If the language model is giving invalid inputs changing this might help.
        'float':             'number',
        'int':               'number',
        'BlockName':         'string',
        'ItemName':          'string',
        'BlockOrItemName':   'string',
        'boolean':           'bool'
    }
    let docs = `\n*COMMAND DOCS\n You can use the following commands to perform actions and get information about the world. 
    Use the commands with the syntax: !commandName or !commandName("arg1", 1.2, ...) if the command takes arguments.\n
    Do not use codeblocks. Use double quotes for strings. Only use one command in each response, trailing commands and comments will be ignored.\n`;
    for (let command of commandList) {
        if (agent.blocked_actions.includes(command.name)) {
            continue;
        }
        docs += command.name + ': ' + command.description + '\n';
        if (command.params) {
            docs += 'Params:\n';
            for (let param in command.params) {
                const optional = command.params[param].optional ? 'optional ' : '';
                docs += `${param}: (${optional}${typeTranslations[command.params[param].type]??command.params[param].type}) ${command.params[param].description}\n`;
            }
        }
    }
    return docs + '*\n';
}
