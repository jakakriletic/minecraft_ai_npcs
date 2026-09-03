// Proximity chat: NPC responds when a player is within 10 blocks OR mentions its name.
// Keeps a short per-player conversation history; conversation "ends" after 60 s of silence
// (phase 4 will add summarization at that point).
import { buildSystemPrompt } from './persona.js';
import { summarizeConversation } from '../state/memory.js';
import { onSocialized } from '../systems/needs.js';

const PROXIMITY_BLOCKS = 10;
const HISTORY_MAX = 10;
const CONVERSATION_TIMEOUT_MS = 60_000;
const DEFAULT_NPC_REACTION_COOLDOWN_MS = 18_000;
const DEFAULT_GLOBAL_REACTION_COOLDOWN_MS = 12_000;
const DEFAULT_HEAR_RANGE = 18;

const globalReactionClaims = new Map(); // normalized player message -> timestamp
const npcReactionCooldowns = new Map(); // npcId -> timestamp

export function attachChatListener(npc, llm) {
    const bot = npc.bot;
    const conversations = new Map(); // playerName -> { history: [], lastAt: number, summarized: bool }
    let chatChain = Promise.resolve();
    npc.conversations = conversations;
    npc.directPrompt = (from, message) => handleChat(from || 'Dashboard', message, { force: true });

    // watch for conversations that went quiet -> summarize once, then forget
    const sweeper = setInterval(() => {
        void (async () => {
            for (const [player, conv] of conversations) {
                if (!conv.summarized && !isActive(conv) && conv.history.length >= 2) {
                    conv.summarized = true;
                    await summarizeConversation(npc, llm, player, conv.history);
                    conversations.delete(player);
                }
            }
        })().catch(error => npc.log.warn(`conversation summary: ${error.message}`));
    }, 15_000);
    bot.once('end', () => clearInterval(sweeper));

    bot.on('chat', (username, message) => {
        chatChain = chatChain
            .catch(() => {})
            .then(() => handleChat(username, message))
            .catch(error => npc.log.warn(`chat: ${error.message}`));
    });

    async function handleChat(username, message, options = {}) {
        const force = options.force === true;
        if (username === bot.username) return;
        const blocked = (npc.settings.blacklisted_players ?? [])
            .some(name => name.toLowerCase() === username.toLowerCase());
        if (!force && blocked) return;
        if (!force && message.startsWith('!')) return; // admin commands
        // ignore other NPC bots for now (NPC-NPC dialogues come later, only with players nearby)
        if (!force && npc.settings.npcs.some(id => id.toLowerCase() === username.toLowerCase())) return;

        const attention = evaluateAttention(npc, username, message, force);
        const playerEntity = bot.players[username]?.entity;
        const distance = playerEntity ? playerEntity.position.distanceTo(bot.entity.position) : Infinity;
        const near = distance <= (npc.settings.chat_reactions?.proximity_blocks ?? PROXIMITY_BLOCKS);
        const canHear = distance <= (npc.settings.chat_reactions?.hear_blocks ?? DEFAULT_HEAR_RANGE);
        const inConversation = isActive(conversations.get(username));

        if (!force && canHear && !attention.shouldReply) {
            rememberOverheard(npc, username, message, attention);
        }

        if (!force && !inConversation && !attention.shouldReply) return;
        if (!force && !inConversation && !attention.direct && !near) return;
        if (!force && !attention.direct && !inConversation && !passReactionChance(npc, attention)) return;
        if (!force && !attention.direct && !inConversation && !claimAmbientReply(npc, username, message)) return;

        // conversation history
        let conv = conversations.get(username);
        if (!isActive(conv)) {
            conv = { history: [], lastAt: 0, summarized: false };
            conversations.set(username, conv);
            npc.log.info(`conversation started with ${username}`);
        }
        conv.history.push({ role: 'user', content: message });
        conv.history = conv.history.slice(-HISTORY_MAX);
        conv.lastAt = Date.now();

        const system = buildSystemPrompt(npc, username, attention);
        const reply = await llm.chat(npc.cfg.id, system, conv.history, 'pogovori');
        if (!reply) return; // rate limited / all providers down — NPC just stays quiet

        conv.history.push({ role: 'assistant', content: reply });
        conv.lastAt = Date.now();
        onSocialized(npc); // talking fills the social need

        // split into chat-sized lines, small delay feels more natural
        for (const line of reply.split('\n').filter(l => l.trim())) {
            bot.chat(line.trim().slice(0, 250));
            await new Promise(r => setTimeout(r, 600));
        }
        return reply;
    }
}

function isActive(conv) {
    return conv && Date.now() - conv.lastAt < CONVERSATION_TIMEOUT_MS;
}

function evaluateAttention(npc, username, message, force = false) {
    if (force) return { shouldReply: true, direct: true, reason: 'admin direct prompt', urgency: 1 };

    const lower = normalize(message);
    const name = normalize(npc.cfg.osebnost.ime);
    const id = normalize(npc.cfg.id);
    const usernameAlias = normalize(npc.cfg.username ?? '');
    const direct = includesWord(lower, name) || includesWord(lower, id) || (usernameAlias && includesWord(lower, usernameAlias));
    const groupAddress = /\b(vsi|folk|ljudje|vasecani|vaščani|npcji|kdo|kdorkoli|hej)\b/i.test(lower);
    const question = /[?]|(\b(kdo|kaj|kje|kam|kako|zakaj|kdaj|a lahko|ali lahko|mi lahko|imas|imaš|ves|veš)\b)/i.test(lower);
    const urgent = /\b(pomoc|pomoč|help|nevarn|napad|creeper|zombi|umrl|umiram|ukrad|kraja|vlom|ogenj|gori|hitro|nujno|lac|lač|hrana|zalog|izgubil)\b/i.test(lower);
    const greeting = /\b(zivjo|živjo|hej|hello|hi|dan|dober|oj|yo)\b/i.test(lower);
    const social = /\b(hvala|oprosti|sorry|rad te mam|super|bravo|dobro|slabo|zalost|žalost|vesel|jezen)\b/i.test(lower);

    const shouldReply = direct || urgent || groupAddress || question || greeting || social;
    let urgency = 0;
    if (direct) urgency += 0.7;
    if (urgent) urgency += 0.5;
    if (question) urgency += 0.25;
    if (groupAddress) urgency += 0.2;
    if (greeting || social) urgency += 0.15;

    return {
        shouldReply,
        direct,
        groupAddress,
        question,
        urgent,
        greeting,
        social,
        reason: direct ? 'direktno si nagovorjen'
            : urgent ? 'sporocilo zveni nujno ali pomembno'
                : question ? 'slisal si vprasanje'
                    : groupAddress ? 'nekdo nagovarja skupino'
                        : greeting ? 'nekdo je pozdravil v tvoji blizini'
                            : social ? 'sporocilo ima socialno/custveno vsebino'
                                : 'slisal si klepet',
        urgency: Math.min(1, urgency),
        speaker: username,
    };
}

function passReactionChance(npc, attention) {
    if (attention.direct || attention.urgent) return true;

    const cooldownMs = npc.settings.chat_reactions?.npc_cooldown_ms ?? DEFAULT_NPC_REACTION_COOLDOWN_MS;
    const last = npcReactionCooldowns.get(npc.cfg.id) ?? 0;
    if (Date.now() - last < cooldownMs) return false;

    const social = npc.state?.data?.lastnosti?.socialnost ?? 50;
    const lonely = Math.max(0, 55 - (npc.state?.data?.potrebe?.druzabnost ?? 50)) / 100;
    const base = npc.settings.chat_reactions?.ambient_reply_chance ?? 0.18;
    let chance = base + (social - 50) / 220 + lonely;
    if (attention.question) chance += 0.22;
    if (attention.groupAddress) chance += 0.12;
    if (attention.greeting) chance += 0.08;
    if (attention.social) chance += 0.08;

    const passed = Math.random() < Math.max(0.05, Math.min(0.75, chance));
    if (passed) npcReactionCooldowns.set(npc.cfg.id, Date.now());
    return passed;
}

function claimAmbientReply(npc, username, message) {
    const cooldownMs = npc.settings.chat_reactions?.global_cooldown_ms ?? DEFAULT_GLOBAL_REACTION_COOLDOWN_MS;
    const key = `${username}:${normalize(message).slice(0, 120)}`;
    const now = Date.now();
    const last = globalReactionClaims.get(key) ?? 0;
    if (now - last < cooldownMs) return false;
    globalReactionClaims.set(key, now);
    return true;
}

function rememberOverheard(npc, username, message, attention) {
    if (!attention.urgent && !attention.question && !attention.social && Math.random() > 0.12) return;
    const trimmed = message.trim().slice(0, 140);
    if (!trimmed) return;
    npc.state?.applyDelta?.({
        slisal: [`${username} je v blizini rekel: "${trimmed}"`],
    }, 'overheard_chat');
}

function normalize(text) {
    return String(text ?? '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function includesWord(text, word) {
    if (!word) return false;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\W)${escaped}(\\W|$)`, 'i').test(text);
}
