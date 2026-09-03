import * as Mindcraft from './src/mindcraft/mindcraft.js';
import settings from './settings.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';

function parseArguments() {
    return yargs(hideBin(process.argv))
        .option('profiles', {
            type: 'array',
            describe: 'List of agent profile paths',
        })
        .option('task_path', {
            type: 'string',
            describe: 'Path to task file to execute'
        })
        .option('task_id', {
            type: 'string',
            describe: 'Task ID to execute'
        })
        .help()
        .alias('help', 'h')
        .parse();
}

const RUNTIME_FILE = './bots/kingdom-runtime.json';
let shuttingDown = false;

function writeRuntimeFile() {
    try {
        mkdirSync('./bots', { recursive: true });
        writeFileSync(RUNTIME_FILE, JSON.stringify({
            mainPid: process.pid,
            startedAt: new Date().toISOString(),
            mindserverPort: settings.mindserver_port,
            minecraftHost: settings.host,
            minecraftPort: settings.port,
            profiles: settings.profiles,
        }, null, 2));
    } catch (err) {
        console.warn(`Could not write kingdom runtime file: ${err.message}`);
    }
}

function removeRuntimeFile() {
    try {
        unlinkSync(RUNTIME_FILE);
    } catch {
        // Already gone or never created.
    }
}

function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down kingdom agents...`);
    try {
        Mindcraft.shutdown();
    } catch (err) {
        console.error('Shutdown failed:', err);
        process.exit(1);
    }
}

function parseJsonEnv(name, fallback = null) {
    if (process.env[name] === undefined) return fallback;
    try {
        return JSON.parse(process.env[name]);
    } catch (err) {
        console.error(`Failed to parse environment variable ${name}:`, err);
        return fallback;
    }
}

function parseNumberEnv(name, fallback) {
    if (process.env[name] === undefined) return fallback;
    const value = Number(process.env[name]);
    if (Number.isFinite(value)) return value;
    console.warn(`Ignoring invalid numeric environment variable ${name}: ${process.env[name]}`);
    return fallback;
}

function parseBooleanEnv(name, fallback = false) {
    if (process.env[name] === undefined) return fallback;
    const value = String(process.env[name]).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    console.warn(`Ignoring invalid boolean environment variable ${name}: ${process.env[name]}`);
    return fallback;
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('exit', removeRuntimeFile);

const args = parseArguments();
if (args.profiles) {
    settings.profiles = args.profiles;
}
if (args.task_path) {
    const tasks = JSON.parse(readFileSync(args.task_path, 'utf8'));
    if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks))
        throw new Error(`Task file '${args.task_path}' must contain an object keyed by task id`);
    if (args.task_id) {
        const task = tasks[args.task_id];
        if (!task || typeof task !== 'object' || Array.isArray(task))
            throw new Error(`Task '${args.task_id}' was not found in '${args.task_path}'`);
        settings.task = { ...task, task_id: args.task_id };
    }
    else {
        throw new Error('task_id is required when task_path is provided');
    }
}

// these environment variables override certain settings
settings.port = parseNumberEnv('MINECRAFT_PORT', settings.port);
settings.mindserver_port = parseNumberEnv('MINDSERVER_PORT', settings.mindserver_port);

const envProfiles = parseJsonEnv('PROFILES');
if (Array.isArray(envProfiles) && envProfiles.length > 0) {
    settings.profiles = envProfiles;
}

settings.allow_insecure_coding = parseBooleanEnv('INSECURE_CODING', settings.allow_insecure_coding);

const envBlockedActions = parseJsonEnv('BLOCKED_ACTIONS');
if (Array.isArray(envBlockedActions)) {
    settings.blocked_actions = envBlockedActions;
}

settings.max_messages = parseNumberEnv('MAX_MESSAGES', settings.max_messages);
settings.num_examples = parseNumberEnv('NUM_EXAMPLES', settings.num_examples);
settings.log_all_prompts = parseBooleanEnv('LOG_ALL', settings.log_all_prompts);

const envSettings = parseJsonEnv('SETTINGS_JSON');
if (envSettings && typeof envSettings === 'object' && !Array.isArray(envSettings)) {
    Object.assign(settings, envSettings);
}

settings.mindserver_port = await Mindcraft.init(false, settings.mindserver_port, settings.auto_open_ui);
writeRuntimeFile();

// stagger agent logins so several bots don't hit the server connection limit at once
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (const profile of settings.profiles) {
    const profile_json = JSON.parse(readFileSync(profile, 'utf8'));
    settings.profile = profile_json;
    const result = await Mindcraft.createAgent({ ...settings, profile: profile_json });
    if (!result.success) {
        console.error(`Failed to create agent ${profile_json.name}: ${result.error}`);
    }
    await sleep(4000);
}
