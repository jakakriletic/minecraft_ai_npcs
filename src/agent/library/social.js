// Cheap deterministic reactions plus short LLM society conversations between
// nearby members (model-agnostic, budget-gated through the shared planner ceiling).
import { serverProxy } from '../mindserver_proxy.js';
import * as world from './world.js';
import * as society from './society.js';
import settings from '../../../settings.js';
import runtimeSettings from '../settings.js';
import * as cognition from '../roleplay/cognition.js';
import { getPersonality } from '../roleplay/personality.js';
import { relationsFor, relationStatus, updateMutual } from '../roleplay/social_graph.js';
import { getSocialModel } from '../roleplay/social_awareness.js';
import { getNorms } from './culture.js';
import { addMemory } from '../roleplay/memory.js';

const HOSTILE = new Set([
    'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'spider',
    'cave_spider', 'creeper', 'witch', 'slime', 'enderman', 'pillager',
    'vindicator', 'zombie_villager', 'wither_skeleton', 'phantom',
]);
const FIND_ITEMS = ['iron_ingot', 'raw_iron', 'gold_ingot', 'diamond', 'coal', 'emerald'];
const pick = values => values[Math.floor(Math.random() * values.length)];

function controllerEnabled() {
    return (runtimeSettings.cognition ?? settings.cognition)?.controller_enabled === true;
}

function speakThroughController(agent, topic, speechIntent = topic, socialTarget = null, opts = {}) {
    if (!controllerEnabled()) return false;
    return Boolean(cognition.speakIntention(agent, {
        topic,
        speechIntent,
        socialTarget,
        actionName: `social:${topic}`,
        label: topic,
        ts: Date.now(),
    }, opts));
}

function autonomousChat(agent, line, topic = 'work', speechIntent = topic, opts = {}) {
    if (speakThroughController(agent, topic, speechIntent, null, opts)) return true;
    if (controllerEnabled()) return false;
    agent.bot.chat(line);
    return true;
}

// An LLM society line spoken outside the controller still counts as controller
// speech, so speakIntention doesn't pile a template line right on top of it.
function markControllerSpoke(agent) {
    (agent._cog ??= {}).lastSpoke = Date.now();
}

function botNames() {
    try {
        return serverProxy.getAgents()
            .map(agent => typeof agent === 'string' ? agent : agent?.name)
            .filter(Boolean)
            .map(name => name.toLowerCase());
    } catch {
        return [];
    }
}

function realPlayersNear(bot, range) {
    const bots = botNames();
    return Object.values(bot.players).filter(player =>
        player.entity && player.username !== bot.username
        && !bots.includes(player.username.toLowerCase())
        && player.entity.position.distanceTo(bot.entity.position) <= range);
}

export function attachSocial(agent) {
    const bot = agent.bot;
    agent._social = {
        lastReact: 0,
        lastBanter: 0,
        night: bot.time.timeOfDay >= 13000 && bot.time.timeOfDay <= 23000,
        inv: world.getInventoryCounts(bot),
        localBusy: false,
    };
    bot.on('rain', () => {
        if (Date.now() - agent._social.lastReact < 20_000) return;
        agent._social.lastReact = Date.now();
        autonomousChat(agent, bot.isRaining
            ? pick(["Hey, it's raining.", 'Rain again...', 'Rain, great.'])
            : pick(['The rain stopped.', 'Finally, some sun.']), 'patrol');
    });
}

// Called on the light social timer. The local model never enters the action loop.
export async function tickSocial(agent) {
    const bot = agent.bot;
    const social = agent._social;
    if (!social) return;
    const now = Date.now();

    // Reply turn in a running bot-to-bot exchange (cross-process via kingdom state).
    // Checked first and cheaply (plain state read); the lock is only taken when the
    // pending exchange is actually addressed to this bot.
    if (settings.kingdom_social_ai !== false && !social.localBusy) {
        const pending = society.getSocietyState()?.socialExchange;
        if (pending && pending.to === agent.name && now - (pending.at ?? 0) <= 90_000) {
            social.localBusy = true;
            void (async () => {
                const exchange = await society.takeSocialExchangeFor(bot, agent.name);
                if (!exchange) return;
                const line = await generateSocietyLine(agent, exchange.from, exchange.text);
                if (!line) return;
                bot.chat(line);
                markControllerSpoke(agent);
                social.lastBanter = Date.now();
                // PIANO: conversations become memories and shift sentiment, so the next
                // exchange with the same member starts from a real shared history.
                try {
                    addMemory(agent, {
                        type: 'social',
                        content: `${exchange.from} told me: "${exchange.text}" — I replied: "${line}".`,
                        importance: 3,
                        related_entities: [exchange.from],
                        tone: 'social',
                        source_event: 'society_chat',
                    });
                } catch { /* memory best-effort */ }
                void updateMutual(agent, exchange.from,
                    { friendship: 0.02, trust: 0.01 },
                    { friendship: 0.02, trust: 0.01 },
                    'short conversation').catch(() => {});
                if ((exchange.turnsLeft ?? 0) > 1)
                    await society.postSocialExchange(bot, {
                        from: agent.name, to: exchange.from, text: line,
                        turnsLeft: exchange.turnsLeft - 1, at: Date.now(),
                    });
            })().catch(error => console.warn(`[social ${agent.name}] reply failed: ${error.message}`))
                .finally(() => { social.localBusy = false; });
            return;
        }
    }

    const time = bot.time.timeOfDay;
    const isNight = time >= 13000 && time <= 23000;
    if (isNight !== social.night) {
        social.night = isNight;
        if (now - social.lastReact > 20_000) {
            social.lastReact = now;
            autonomousChat(agent, isNight
                ? pick(["It's getting dark, let's watch out for each other.", 'Night is coming, light the torches.'])
                : pick(["It's daytime, let's get to work.", 'Beautiful morning!']), isNight ? 'patrol' : 'work');
            return;
        }
    }

    if (now - social.lastReact > 20_000) {
        const mob = bot.nearestEntity(entity =>
            HOSTILE.has(entity.name)
            && entity.position.distanceTo(bot.entity.position) < 12);
        if (mob) {
            social.lastReact = now;
            autonomousChat(agent, pick(['A monster!', `Look, a ${mob.name}.`, 'Something is creeping over there.']), 'defend', 'defend');
            return;
        }
    }

    if (now - social.lastReact > 20_000) {
        const counts = world.getInventoryCounts(bot);
        for (const item of FIND_ITEMS) {
            if ((counts[item] ?? 0) <= (social.inv[item] ?? 0) + (item === 'coal' ? 4 : 0))
                continue;
            social.lastReact = now;
            const label = {
                iron_ingot: 'iron',
                raw_iron: 'iron',
                gold_ingot: 'gold',
                diamond: 'a diamond',
                coal: 'coal',
                emerald: 'an emerald',
            }[item];
            autonomousChat(agent, pick([
                `Found some ${label}.`,
                `Some ${label} for the shared storage.`,
                `This ${label} will come in handy.`,
            ]), 'logistics');
            social.inv = { ...counts };
            return;
        }
        social.inv = { ...counts };
    }

    if (now - social.lastBanter <= 180_000 || social.localBusy) return;
    const names = botNames();
    const mate = Object.values(bot.players).find(player =>
        player.entity && player.username !== bot.username
        && names.includes(player.username.toLowerCase())
        && player.entity.position.distanceTo(bot.entity.position) < 8);
    if (!mate) return;

    if (settings.kingdom_social_ai !== false
        && await society.claimSocialTurn(bot)) {
        // Start a short 2-3 line exchange: this bot speaks an LLM opener, the mate's
        // process picks the exchange up from kingdom state and replies in character.
        social.localBusy = true;
        social.lastBanter = now;
        void (async () => {
            const line = await generateSocietyLine(agent, mate.username, null);
            if (!line) return;
            bot.chat(line);
            markControllerSpoke(agent);
            try {
                addMemory(agent, {
                    type: 'social',
                    content: `I told ${mate.username}: "${line}".`,
                    importance: 2,
                    related_entities: [mate.username],
                    tone: 'social',
                    source_event: 'society_chat',
                });
            } catch { /* memory best-effort */ }
            await society.postSocialExchange(bot, {
                from: agent.name, to: mate.username, text: line,
                turnsLeft: 2, at: Date.now(),
            });
        })().catch(error => console.warn(`[social ${agent.name}] opener failed: ${error.message}`))
            .finally(() => { social.localBusy = false; });
    } else if (Math.random() < 0.12) { // canned fallback greeting, rare — chat should be mostly LLM lines
        social.lastBanter = now;
        if (speakThroughController(agent, 'help', 'help', mate.username)) return;
        if (controllerEnabled()) return;
        bot.chat(pick([
            `Hey ${mate.username}, how's it going?`,
            `${mate.username}, want to check the storage later?`,
            `Hey ${mate.username}, the settlement keeps growing.`,
            `${mate.username}, if you need anything, say the word.`,
        ]));
    }
}

// Human wording for the relation status, so the model plays the RELATIONSHIP,
// not just two strangers exchanging pleasantries (PIANO: sentiment shapes dialogue).
const RELATION_WORDS = {
    close_friend: 'a close friend you trust',
    friend: 'a friend',
    known: 'a reliable acquaintance',
    acquaintance: 'an acquaintance',
    strained: 'a slightly strained relationship',
    rival: 'a rival',
    afraid: 'someone you are a little afraid of',
    unknown: 'someone you barely know',
};

// One in-character society line (opener when `opener` is null, otherwise a reply).
// Model-agnostic: whatever chat model the profile uses, gated by the shared planner
// budget so ten chatty bots can never outspend the global ceiling. The prompt carries
// the PIANO-style social state: relation to the mate, last observation of them, shared
// norms, and occasionally a third member (gossip), so conversations transmit culture.
async function generateSocietyLine(agent, mateName, opener) {
    const { reservePlannerCall } = await import('./planner.js');
    if (!await reservePlannerCall(agent.bot, 400, 60)) return null;
    const state = society.getSocietyState();
    const personality = agent.personality ?? getPersonality(agent.prompter?.profile ?? agent.name);
    const myRole = society.roleLabel(society.getRole(agent));
    const theirRole = society.roleLabel(state.members?.[mateName]?.role);
    const event = state.events?.at(-1)?.text ?? 'No special event today.';

    let relationLine = '';
    try {
        const relation = relationsFor(agent.name).find(r => r.to === mateName);
        relationLine = `Your relationship with them: ${RELATION_WORDS[relationStatus(relation)] ?? 'an acquaintance'}.`;
    } catch { /* graph optional */ }
    let observationLine = '';
    try {
        const seen = getSocialModel(agent)?.[mateName]?.lastSeenDoing;
        if (seen && seen !== 'idle') observationLine = `You last saw them: ${seen}.`;
    } catch { /* opinions optional */ }
    let normLine = '';
    try {
        const norms = getNorms(agent);
        if (Number(norms?.sharing_expectation) >= 0.6)
            normLine = 'The settlement values sharing resources and working together.';
    } catch { /* culture optional */ }
    let gossipLine = '';
    try {
        const others = Object.entries(state.members ?? {})
            .filter(([name, m]) => name !== agent.name && name !== mateName && m?.online)
            .map(([name]) => name);
        if (others.length && Math.random() < 0.35) {
            const third = others[Math.floor(Math.random() * others.length)];
            gossipLine = `If it fits naturally, you may casually mention ${third}.`;
        }
    } catch { /* members optional */ }

    const system = 'Write ONE short natural English Minecraft line between two settlement members. '
        + 'No commands, no quotes, no emojis, no explanations, never mention AI. 3-16 words. Stay in the speaker\'s character and play their relationship.';
    const prompt = [
        `Speaker: ${agent.name} (${myRole}) — ${personality.temperament}; speech: ${personality.speechStyle}.`,
        `Conversation partner: ${mateName} (${theirRole}).`,
        relationLine,
        observationLine,
        normLine,
        gossipLine,
        opener
            ? `${mateName} just said: "${opener}" — reply naturally, like in a conversation.`
            : `Latest shared event: ${event} Start a relaxed short conversation.`,
    ].filter(Boolean).join('\n');
    let timer;
    try {
        const response = await Promise.race([
            agent.prompter.chat_model.sendRequest([{ role: 'user', content: prompt }], system),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('society line timeout')), 15_000);
            }),
        ]);
        const line = String(response ?? '')
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/^["']|["']$/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160);
        return line && !line.includes('\t') && !line.startsWith('!') ? line : null;
    } finally {
        clearTimeout(timer);
    }
}

// A hostile near any human or fellow society member becomes a high-priority target.
export function findThreatToSociety(bot) {
    const names = new Set(botNames());
    const protectedPlayers = [
        ...realPlayersNear(bot, 12),
        ...Object.values(bot.players).filter(player =>
            player.entity && player.username !== bot.username
            && names.has(player.username.toLowerCase())
            && player.entity.position.distanceTo(bot.entity.position) <= 14),
    ];
    for (const player of protectedPlayers) {
        const mob = bot.nearestEntity(entity =>
            HOSTILE.has(entity.name)
            && entity.position.distanceTo(player.entity.position) < 6);
        if (mob) return mob;
    }
    return null;
}

// Focus fire: pick ONE target the whole nearby group will converge on. The score
// depends only on shared reference points (nearby humans + society members and
// their health), NOT on the calling bot's own position, so every bot that can
// see the same fight scores candidates identically and independently lands on
// the same mob. Ties break on entity id (stable across processes) for consensus.
export function findCoordinatedThreat(bot, range = 16) {
    const names = new Set(botNames());
    const refs = [
        { pos: bot.entity.position, health: bot.health ?? 20 },
        ...realPlayersNear(bot, range).map(player => ({
            pos: player.entity.position,
            health: player.entity.health ?? 20,
        })),
        ...Object.values(bot.players)
            .filter(player => player.entity && player.username !== bot.username
                && names.has(player.username.toLowerCase())
                && player.entity.position.distanceTo(bot.entity.position) <= range)
            .map(player => ({
                pos: player.entity.position,
                health: player.entity.health ?? 20,
            })),
    ];

    let best = null;
    for (const mob of Object.values(bot.entities)) {
        if (!mob?.position || !HOSTILE.has(mob.name)) continue;
        if (mob.position.distanceTo(bot.entity.position) > range) continue;
        let proximity = -Infinity;
        let woundBonus = 0;
        for (const ref of refs) {
            const distance = mob.position.distanceTo(ref.pos);
            proximity = Math.max(proximity, range - distance);
            if (distance < 6) woundBonus = Math.max(woundBonus, Math.max(0, 20 - ref.health));
        }
        if (proximity <= -Infinity) continue;
        const score = proximity * 10
            + woundBonus * 3
            + (mob.name === 'creeper' ? 15 : 0)
            + (mob.name === 'skeleton' || mob.name === 'pillager' ? 6 : 0);
        if (!best || score > best.score
            || (score === best.score && mob.id < best.entity.id))
            best = { entity: mob, score };
    }
    return best?.entity ?? null;
}

// Rangers watch a wider area than ordinary self-defense. Targets are ranked by
// how close they are to a vulnerable player or society member, then by distance
// from the ranger so a reachable danger wins over a remote one.
export function findGuardianThreat(bot) {
    const guardRange = Math.max(16, settings.kingdom_guardian_range ?? 32);
    const memberHealth = new Map(society.activeMembers(bot)
        .map(member => [member.name.toLowerCase(), member.health ?? 20]));
    const protectedPlayers = Object.values(bot.players)
        .filter(player => player.entity
            && player.username !== bot.username
            && player.entity.position.distanceTo(bot.entity.position) <= guardRange);
    const threats = Object.values(bot.entities)
        .filter(entity => entity?.position
            && HOSTILE.has(entity.name)
            && entity.position.distanceTo(bot.entity.position) <= guardRange + 10);

    let best = null;
    for (const threat of threats) {
        for (const player of protectedPlayers) {
            const distanceToProtected = threat.position.distanceTo(player.entity.position);
            if (distanceToProtected > 10) continue;
            const health = memberHealth.get(player.username.toLowerCase())
                ?? player.entity.health
                ?? 20;
            const score = (10 - distanceToProtected) * 12
                + Math.max(0, 20 - health) * 3
                - threat.position.distanceTo(bot.entity.position) * 0.35
                + (threat.name === 'creeper' ? 12 : 0)
                + (threat.name === 'skeleton' || threat.name === 'pillager' ? 6 : 0);
            if (!best || score > best.score)
                best = { entity: threat, protectedName: player.username, score };
        }
    }
    return best;
}

export const findThreatToPlayer = findThreatToSociety;
