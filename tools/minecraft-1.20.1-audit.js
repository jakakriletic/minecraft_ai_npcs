import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import minecraftData from 'minecraft-data';
import settings from '../settings.js';

const require = createRequire(import.meta.url);
const mineflayerVersions = require('mineflayer/lib/version');
const TARGET_VERSION = '1.20.1';
const EXPECTED_PROTOCOL = 763;
const failures = [];
let checkedTaskNames = 0;

function check(condition, message) {
    if (!condition) failures.push(message);
}

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

const data = minecraftData(TARGET_VERSION);
const packageJson = readJson('package.json');
const rpSettings = readJson('src/rp/config/settings.json');
const rpStartSettings = readJson('src/rp/config/settings.start_boti.json');

check(settings.minecraft_version === TARGET_VERSION, `settings.js targets ${settings.minecraft_version}`);
check(rpSettings.minecraft.version === TARGET_VERSION, 'RP settings.json has the wrong Minecraft version');
check(rpStartSettings.minecraft.version === TARGET_VERSION, 'RP settings.start_boti.json has the wrong Minecraft version');
check(settings.forge_handshake?.enabled === true, 'main settings do not enable the built-in FML3 handshake');
check(rpSettings.minecraft.forge_handshake?.enabled === true, 'RP settings.json does not enable the built-in FML3 handshake');
check(rpStartSettings.minecraft.forge_handshake?.enabled === true, 'RP settings.start_boti.json does not enable the built-in FML3 handshake');
check(packageJson.version === TARGET_VERSION, `package version is ${packageJson.version}`);
check(!packageJson.dependencies['minecraft-protocol-forge'], 'legacy minecraft-protocol-forge dependency is present');
check(!existsSync('src/utils/forge.js'), 'legacy Forge handshake module is present');
check(existsSync('src/utils/forge_handshake.js'), 'built-in Forge 1.20.1 handshake module is missing');
check(mineflayerVersions.testedVersions.includes(TARGET_VERSION), 'Mineflayer does not list 1.20.1 as tested');
check(data.version.version === EXPECTED_PROTOCOL, `minecraft-data reports protocol ${data.version.version}`);

for (const name of [
    'white_bed', 'cherry_log', 'mangrove_log', 'raw_iron', 'raw_gold',
    'deepslate_diamond_ore', 'deepslate_redstone_ore', 'oak_slab', 'red_dye',
]) {
    check(Boolean(data.itemsByName[name] || data.blocksByName[name]), `1.20.1 registry is missing ${name}`);
}

function registryHas(name) {
    return Boolean(data.itemsByName[name] || data.blocksByName[name]);
}

function noteRegistryName(name, file, field) {
    if (typeof name !== 'string') return;
    checkedTaskNames += 1;
    check(registryHas(name), `${file}: ${field} uses unknown 1.20.1 name '${name}'`);
}

function scanTask(value, file, field = '') {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => scanTask(entry, file, `${field}[${index}]`));
        return;
    }
    if (!value || typeof value !== 'object') return;

    for (const [key, entry] of Object.entries(value)) {
        const nextField = field ? `${field}.${key}` : key;
        if (['target', 'item', 'block'].includes(key)) noteRegistryName(entry, file, nextField);
        if (key === 'initial_inventory' && entry && typeof entry === 'object') {
            for (const inventory of Object.values(entry)) {
                if (!inventory || typeof inventory !== 'object') continue;
                for (const name of Object.keys(inventory)) noteRegistryName(name, file, nextField);
            }
        }
        scanTask(entry, file, nextField);
    }
}

function scanDirectory(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) scanDirectory(path);
        else if (entry.name.endsWith('.json')) {
            try {
                scanTask(readJson(path), path);
            } catch (error) {
                failures.push(`${path}: invalid JSON (${error.message})`);
            }
        }
    }
}

scanDirectory('tasks');

if (failures.length) {
    console.error(`Minecraft ${TARGET_VERSION} compatibility audit failed:`);
    failures.forEach(message => console.error(`- ${message}`));
    process.exitCode = 1;
} else {
    console.log(`Minecraft ${TARGET_VERSION} compatibility audit passed (protocol ${EXPECTED_PROTOCOL}, ${checkedTaskNames} task registry references checked).`);
}
