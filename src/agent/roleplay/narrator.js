import settings from '../settings.js';
import { getPersonality, personalityPrompt, pickPhrase } from './personality.js';
import { memoryContext, ensureMemory } from './memory.js';
import { relationContext } from './social_graph.js';
import { describeIntention } from './cognition.js'; // ALTERA/PIANO Phase 2 — grounds chat in the real current action
import { socialContext } from './social_awareness.js'; // ALTERA/PIANO Phase 3 — how the bot reads the others
import { cultureContext } from '../library/culture.js'; // ALTERA/PIANO Phase 6 — shared norms shape dialogue
import { scenarioContext } from './scenario.js'; // owner-editable scenario from roleplay.md (live reload)
import * as society from '../library/society.js'; // recent settlement events ground small talk in shared reality

const FOCUS_TEXT = {
    base: {
        intent: 'organize base and storage',
        action: 'base upkeep',
    },
    build: {
        intent: 'build a settlement structure',
        action: 'construction',
    },
    farm: {
        intent: 'secure food and tend crops',
        action: 'farming',
    },
    explore: {
        intent: 'scout nearby terrain safely',
        action: 'exploration',
    },
    stockpile: {
        intent: 'gather useful shared supplies',
        action: 'stockpiling',
    },
    relax: {
        intent: 'stay nearby and keep social presence',
        action: 'resting',
    },
};

function riskNote(personality, plan) {
    if (plan.focus === 'explore' || ['iron', 'gold', 'lapis'].includes(plan.resource)) {
        if (personality.caution > 0.7)
            return 'mentions risk, torches, and not pushing too deep';
        if (personality.courage > 0.75)
            return 'treats danger as manageable but still follows deterministic safety';
    }
    if (plan.focus === 'build' && personality.ambition > 0.75)
        return 'may sound ambitious, but must keep the build feasible';
    return 'normal settlement risk';
}

function planSentence(personality, plan) {
    const phrase = pickPhrase(personality, `${plan.focus}:${plan.resource}:${plan.project}`);
    const resource = plan.resource ? ` ${plan.resource}` : '';
    const project = plan.project ? ` ${plan.project}` : '';
    if (personality.name === 'Blaz')
        return `${phrase} Useful work first:${project || resource}. If I need tools, I'll sort them out along the way.`;
    if (personality.name === 'Nejc')
        return `${phrase} Going in carefully:${project || resource}. If the terrain gets weird, I'll come back better prepared.`;
    if (personality.name === 'Lara')
        return `${phrase} I'll take this one:${project || resource}. Let it show we work as a team.`;
    if (personality.name === 'Zan')
        return `${phrase} We can make real progress out of this:${project || resource}. No small thinking.`;
    if (personality.name === 'Maja')
        return `${phrase} This makes sense for the settlement's stability:${project || resource}. Supplies must hold.`;
    if (personality.name === 'Ema')
        return `${phrase} Fine, this goes on the list:${project || resource}. Less chaos afterwards.`;
    if (personality.name === 'Jure')
        return `${phrase} I'll take this on carefully:${project || resource}. Better done right than fixed twice.`;
    if (personality.name === 'Kaja')
        return `${phrase} I'll take care of this:${project || resource}. And yes, if anyone gets hungry, speak up.`;
    if (personality.name === 'Rok')
        return `${phrase} Task is clear:${project || resource}. I'll bring what's missing.`;
    if (personality.name === 'Tilen')
        return `${phrase} On it:${project || resource}. I'll keep an eye out for danger too.`;
    return `${phrase} Taking on ${project || resource || FOCUS_TEXT[plan.focus]?.action || 'the task'}.`;
}

export function buildRoleplayContext(agent) {
    if (settings.rp_enabled === false) return '';
    const personality = agent.personality ?? getPersonality(agent.prompter?.profile ?? agent.name);
    // ALTERA/PIANO Phase 2: inject what the bot is ACTUALLY doing now so chat answers
    // ("kaj delaš?") stay coherent with action. Empty string unless controller_enabled.
    const currentActivity = describeIntention(agent, { includeActionName: true });
    // ALTERA/PIANO Phase 3: inject how this bot currently reads the other members, so
    // dialogue reflects its social perception. Empty unless social_perception_enabled.
    const socialRead = socialContext(agent);
    // ALTERA/PIANO Phase 6/7: shared culture norms + the bot's reflected self-image, so
    // conversation carries the long-timescale state instead of ignoring it.
    let selfImage = '';
    try { selfImage = ensureMemory(agent)?.self_image ?? ''; } catch { /* memory optional */ }
    let recentEvents = '';
    try {
        const events = society.getSocietyState()?.events?.slice(-3) ?? [];
        if (events.length)
            recentEvents = `Recent settlement events (shared knowledge, usable in small talk):\n${events.map(e => `- ${e.text}`).join('\n')}`;
    } catch { /* society state optional */ }
    return [
        'ROLEPLAY IDENTITY LAYER',
        scenarioContext(agent.name),
        personalityPrompt(personality),
        selfImage ? `Self-image (your own reflected belief about yourself): ${selfImage}` : '',
        memoryContext(agent),
        relationContext(agent.name),
        currentActivity ? `Current activity (answer truthfully if asked): ${currentActivity}` : '',
        socialRead,
        cultureContext(agent),
        recentEvents,
        'Rules:',
        '- Stay in Minecraft RP. Speak as this character, not as an AI.',
        '- Keep spoken text separate from real actions. Never claim an action succeeded until the system/action result says it did.',
        '- If using a Minecraft command, output only one command and keep it valid.',
        '- Use memories and relationships as flavor, not as a reason to ignore direct player commands.',
    ].filter(Boolean).join('\n');
}

export function appendRoleplayContext(agent, prompt) {
    const context = buildRoleplayContext(agent);
    if (!context) return prompt;
    return `${prompt}\n\n${context}`;
}

export function narratePlan(agent, plan) {
    const personality = agent.personality ?? getPersonality(agent.prompter?.profile ?? agent.name);
    const focus = FOCUS_TEXT[plan.focus] ?? FOCUS_TEXT.stockpile;
    const spoken = plan.say && String(plan.say).trim().length > 0
        ? String(plan.say).trim().slice(0, 180)
        : planSentence(personality, plan).slice(0, 220);
    return {
        spoken_text: spoken,
        internal_intent: `${personality.name} intends to ${focus.intent}.`,
        memory_updates: [{
            type: 'task',
            content: `Chose ${plan.focus}${plan.resource ? `/${plan.resource}` : ''}: ${plan.project || focus.action}.`,
            importance: plan.source === 'society' ? 5 : 3,
            tone: 'intentional',
        }],
        social_updates: [],
        risk_notes: [riskNote(personality, plan)],
        action_plan_summary: `${plan.focus}${plan.resource ? `:${plan.resource}` : ''}${plan.schematic ? `:${plan.schematic}` : ''} amount=${plan.amount ?? 0}`,
    };
}

export function fallbackConversation(agent, messages = []) {
    const personality = agent.personality ?? getPersonality(agent.prompter?.profile ?? agent.name);
    const last = messages?.at?.(-1)?.content ?? '';
    if (/hvala|bravo|dobro|nice|thanks/i.test(last))
        return `${pickPhrase(personality, 'thanks')} No problem.`;
    if (/status|kaj dela[sš]|kako gre|what'?s your status|what are you doing|what.*doing|current task|how'?s it going/i.test(last)) {
        const currentActivity = describeIntention(agent);
        if (currentActivity) return `${pickPhrase(personality, 'status')} ${currentActivity}.`;
        return `${pickPhrase(personality, 'status')} Following my task and trying not to do anything stupid.`;
    }
    if (/pomag|help/i.test(last))
        return `${pickPhrase(personality, 'help')} Tell me the goal and I'll get to it sensibly.`;
    return `${pickPhrase(personality, last)} Heard you.`;
}
