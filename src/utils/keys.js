import { readFileSync } from 'fs';

let keys = {};
let envFileKeys = {};
try {
    const data = readFileSync('./keys.json', 'utf8');
    keys = JSON.parse(data);
} catch (err) {
    console.warn('keys.json not found. Defaulting to environment variables.'); // still works with local models
}

for (const file of ['.env', '.env.local']) {
    try {
        const data = readFileSync(file, 'utf8');
        for (const line of data.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (!match) continue;
            let value = match[2].trim();
            if ((value.startsWith('"') && value.endsWith('"'))
                || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            envFileKeys[match[1]] = value;
        }
    } catch {
        // Optional local config file.
    }
}

export function getKey(name) {
    let key = keys[name];
    if (!key) {
        key = process.env[name];
    }
    if (!key) {
        key = envFileKeys[name];
    }
    if (!key) {
        throw new Error(`API key "${name}" not found in keys.json or environment variables!`);
    }
    return key;
}

export function hasKey(name) {
    return keys[name] || process.env[name] || envFileKeys[name];
}
