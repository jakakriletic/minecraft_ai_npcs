import { sendOutputToServer } from './mindserver_proxy.js';

// Definitions of error types, keywords, and full human-readable messages.
const ERROR_DEFINITIONS = {
    'authentication': {
        keywords: ['unverified_username', 'failed to verify username', 'invalid session'],
        msg: 'Authentication Failed: The server requires a verified account, but the bot is using offline auth or an invalid session.',
        isFatal: true
    },
    'name_conflict': {
        keywords: ['name_taken', 'duplicate_login', 'already connected', 'already logged in', 'username is already'],
        msg: 'Name Conflict: The name is already in use or you are already logged in.',
        isFatal: true
    },
    'access_denied': {
        keywords: ['whitelist', 'not white-listed', 'banned', 'suspended', 'verify'],
        msg: 'Access Denied: You are not whitelisted or banned.',
        isFatal: true
    },
    'server_full': {
        keywords: ['server is full', 'full server'],
        msg: 'Connection Failed: The server is full.',
        isFatal: false
    },
    'mod_rejection': {
        keywords: ['server mod rejections', 'mod is not found on client', 'requires version'],
        msg: 'Server Mod Rejection: this server requires client mods that the Mineflayer bot does not provide.',
        isFatal: true
    },
    'version_mismatch': {
        keywords: ['outdated', 'version', 'client'],
        msg: 'Version Mismatch: Client and server versions do not match.',
        isFatal: true
    },
    'maintenance': {
        keywords: ['maintenance', 'updating', 'closed', 'restarting'],
        msg: 'Connection Failed: Server is under maintenance or restarting.',
        isFatal: false
    },
    'network_error': {
        keywords: ['timeout', 'timed out', 'connection lost', 'reset', 'refused', 'keepalive'],
        msg: 'Network Error: Connection timed out or was lost.',
        isFatal: false
    },
    'spam': {
        keywords: ['spam'],
        msg: 'Kicked for spamming. The agent will restart without stopping the rest of the kingdom.',
        isFatal: false
    },
    'behavior': {
        keywords: ['flying', 'speed'],
        msg: 'Kicked: Removed from server due to flying or invalid movement.',
        isFatal: true
    }
};

// Helper to log messages to console (once) and MindServer.
export const log = (agentName, msg) => {
    // Use console.error for visibility in terminal
    console.error(msg);
    try { sendOutputToServer(agentName || 'system', msg); } catch (_) { /* server may be offline */ }
};

// Analyzes the kick reason and returns a full, human-readable sentence.
export function parseKickReason(reason) {
    if (!reason) return { type: 'unknown', msg: 'Unknown reason (Empty)', isFatal: true };
    
    const raw = (typeof reason === 'string' ? reason : JSON.stringify(reason)).toLowerCase();

    // Search for keywords in definitions
    for (const [type, def] of Object.entries(ERROR_DEFINITIONS)) {
        if (def.keywords.some(k => raw.includes(k))) {
            console.error(`Disconnected: ${raw}`);
            return { type, msg: def.msg, isFatal: def.isFatal };
        }
    }
    
    // Fallback: Extract text from JSON
    let fallback = raw;
    try {
        const obj = typeof reason === 'string' ? JSON.parse(reason) : reason;
        fallback = obj.translate || obj.text || (obj.value?.translate) || raw;
    } catch (_) { /* reason was plain text, not JSON */ }
    
    return { type: 'other', msg: `Disconnected: ${fallback}`, isFatal: true };
}

// Centralized handler for disconnections.
export function handleDisconnection(agentName, reason) {
    const { type, msg, isFatal } = parseKickReason(reason);
    
    // Format: [LoginGuard] Error Message
    const finalMsg = `[LoginGuard] ${msg}`;
    
    // Only call log once (it handles console printing)
    log(agentName, finalMsg);
    
    return { type, msg: finalMsg, isFatal };
}

// Validates name format.
export function validateNameFormat(name) {
    if (!name || !/^[a-zA-Z0-9_]{3,16}$/.test(name)) {
        return { 
            success: false, 
            // Added [LoginGuard] prefix here for consistency
            msg: `[LoginGuard] Invalid name '${name}'. Must be 3-16 alphanumeric/underscore characters.` 
        };
    }
    return { success: true };
}
