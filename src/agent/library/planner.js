// Hybrid planner for the kingdom.
//
// The cloud model acts as one shared strategist for the whole society. Cheap local
// Ollama calls fill gaps for individual bots. Neither model ever receives direct
// control over movement, combat, mining, inventory, or code execution: it can only
// choose a bounded focus that the deterministic brain knows how to execute.
//
// ALTERA / PIANO ROADMAP: this is "goal generation". To reach Altera-style emergent
// specialization it must (Phase 4) consume the social graph + models of other agents,
// not only resource need + personality. See ../../../ALTERA_PLAN.md.
import * as world from './world.js';
import * as base from './base.js';
import * as build from './build.js';
import * as progression from './progression.js';
import * as society from './society.js';
import settings from '../../../settings.js';
import runtimeSettings from '../settings.js';
import { readFileSync, existsSync } from 'fs';
import { withNamedLock } from './container_lock.js';
import { writeJsonAtomic } from '../../utils/atomic_json.js';
import { getPersonality, influencePlan } from '../roleplay/personality.js';
import { memoryContext } from '../roleplay/memory.js';
import { narratePlan } from '../roleplay/narrator.js';
import * as rpEvents from '../roleplay/events.js';
import { socialContext } from '../roleplay/social_awareness.js'; // ALTERA/PIANO Phase 3 — how the bot reads the others
import { socialGoalContext } from '../roleplay/social_goals.js'; // ALTERA/PIANO Phase 4 — recursive social goals
import { cultureContext } from './culture.js'; // ALTERA/PIANO Phase 6 - shared norms

const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'];
const FOOD = ['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'apple', 'carrot'];
export const FOCUSES = ['base', 'build', 'farm', 'explore', 'stockpile', 'relax'];
export const RESOURCES = ['wood', 'stone', 'food', 'iron', 'coal', 'gold', 'lapis', 'diamond'];
const BUDGET_FILE = './bots/planner-budget.json';
const SOCIETY_PLAN_FILE = './bots/kingdom-plan.json';
const GPT_54_MINI_INPUT_USD = 0.75 / 1_000_000;
const GPT_54_MINI_OUTPUT_USD = 4.50 / 1_000_000;
const societyPlanCache = { checkedAt: 0, value: null };

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const parseTime = value => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

function cognitionSettings() {
    return runtimeSettings.cognition ?? settings.cognition ?? {};
}

function recordPlannerStatus(agent, channel, status, details = {}) {
    agent._plannerStatus ??= {};
    agent._plannerStatus[channel] = {
        status,
        at: new Date().toISOString(),
        home: agent.bot && base.getBase(agent.bot) ? 'set' : 'no-home',
        ...details,
    };
}

function readBudget(now = Date.now()) {
    const windowMs = Math.max(1, settings.planner_budget_window_hours ?? 10) * 60 * 60_000;
    try {
        const value = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));
        if (now - Number(value.windowStartedAt ?? 0) < windowMs)
            return value;
    } catch { /* start a fresh window */ }
    return {
        windowStartedAt: now,
        calls: 0,
        reservedUsd: 0,
        actualInputTokens: 0,
        actualOutputTokens: 0,
        actualUsd: 0,
    };
}

function writeBudget(value) {
    writeJsonAtomic(BUDGET_FILE, value);
}

function estimatedCallCost(inputTokens, outputTokens = Math.max(64, settings.planner_max_output_tokens ?? 250)) {
    return inputTokens * GPT_54_MINI_INPUT_USD + outputTokens * GPT_54_MINI_OUTPUT_USD;
}

async function reservePlannerCallDetailed(bot, inputTokens, outputTokens) {
    const result = await withNamedLock(bot, 'planner-budget', () => {
        const budget = readBudget();
        const callCost = estimatedCallCost(inputTokens, outputTokens);
        const maxCalls = Math.max(1, settings.planner_max_calls_per_window ?? 500);
        const maxUsd = Math.max(0.05, settings.planner_budget_usd ?? 1);
        if (budget.calls >= maxCalls || budget.reservedUsd + callCost > maxUsd)
            return { allowed: false, reason: 'budget-cooldown' };
        budget.calls++;
        budget.reservedUsd += callCost;
        budget.updatedAt = Date.now();
        writeBudget(budget);
        return { allowed: true };
    }, 3000, { interruptible: false });
    return result.locked ? result.value : { allowed: false, reason: 'lock-busy' };
}

export async function reservePlannerCall(bot, inputTokens, outputTokens) {
    return (await reservePlannerCallDetailed(bot, inputTokens, outputTokens)).allowed;
}

export async function recordPlannerUsage(bot, usage) {
    if (!usage) return;
    const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
    const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
    await withNamedLock(bot, 'planner-budget', () => {
        const budget = readBudget();
        budget.actualInputTokens += inputTokens;
        budget.actualOutputTokens += outputTokens;
        budget.actualUsd += inputTokens * GPT_54_MINI_INPUT_USD
            + outputTokens * GPT_54_MINI_OUTPUT_USD;
        budget.updatedAt = Date.now();
        writeBudget(budget);
        return true;
    }, 3000, { interruptible: false });
}

function emptySocietyPlan() {
    return {
        version: 1,
        planId: null,
        coordinator: null,
        strategy: '',
        assignments: {},
        updatedAt: null,
        expiresAt: null,
        nextAt: null,
    };
}

function readSocietyPlan(force = false) {
    if (!force && societyPlanCache.value && Date.now() - societyPlanCache.checkedAt < 1500)
        return societyPlanCache.value;
    let value = emptySocietyPlan();
    try {
        if (existsSync(SOCIETY_PLAN_FILE))
            value = { ...value, ...JSON.parse(readFileSync(SOCIETY_PLAN_FILE, 'utf8')) };
    } catch (error) {
        console.warn(`[plan society] could not read shared plan: ${error.message}`);
    }
    value.assignments = value.assignments && typeof value.assignments === 'object'
        ? value.assignments
        : {};
    societyPlanCache.value = value;
    societyPlanCache.checkedAt = Date.now();
    return value;
}

function writeSocietyPlan(value) {
    writeJsonAtomic(SOCIETY_PLAN_FILE, value);
    societyPlanCache.value = value;
    societyPlanCache.checkedAt = Date.now();
}

function inventorySummary(bot) {
    const inv = world.getInventoryCounts(bot);
    const sum = (names) => names.reduce((total, name) => total + (inv[name] ?? 0), 0);
    return {
        food: sum(FOOD),
        wood: sum(LOGS),
        stone: inv.cobblestone ?? 0,
        iron: (inv.iron_ingot ?? 0) + (inv.raw_iron ?? 0),
        coal: (inv.coal ?? 0) + (inv.charcoal ?? 0),
        gold: (inv.gold_ingot ?? 0) + (inv.raw_gold ?? 0),
        lapis: inv.lapis_lazuli ?? 0,
        diamonds: inv.diamond ?? 0,
        torches: inv.torch ?? 0,
        emptySlots: bot.inventory.emptySlotCount(),
    };
}

function situation(agent) {
    const bot = agent.bot;
    const inv = world.getInventoryCounts(bot);
    const has = (name) => (inv[name] ?? 0) > 0;
    const sum = (arr) => arr.reduce((total, name) => total + (inv[name] ?? 0), 0);
    return [
        has('iron_pickaxe') ? 'iron tools' : (has('stone_pickaxe') ? 'stone tools' : 'weak tools'),
        base.getBase(bot) ? 'has home base' : 'no home base yet',
        `progression:${progression.getStatus(bot).stage}`,
        `food:${sum(FOOD)}`,
        `wood:${sum(LOGS)} stone:${inv.cobblestone ?? 0} iron:${inv.iron_ingot ?? 0} coal:${inv.coal ?? 0} gold:${inv.gold_ingot ?? 0} lapis:${inv.lapis_lazuli ?? 0}`,
        `empty inventory slots:${bot.inventory.emptySlotCount()}`,
        `role:${society.roleLabel(society.getRole(agent))}`,
        `shared resource need:${society.getResourcePriority(bot)}`,
    ].join(', ');
}

function activePlannerMembers(agent) {
    const state = society.getSocietyState();
    const now = Date.now();
    const members = new Map();
    for (const [name, member] of Object.entries(state.members ?? {})) {
        if (member.online === false) continue;
        if (now - parseTime(member.seenAt) > 90_000) continue;
        members.set(name, {
            name,
            role: member.role ?? 'member',
            roleLabel: society.roleLabel(member.role),
            personality: getPersonality(name),
            progression: member.progression ?? 'unknown',
            action: member.action ?? 'idle',
            inventory: member.inventory ?? {},
            health: member.health ?? 20,
            hunger: member.hunger ?? 20,
            position: member.position ?? null,
            hasHome: Boolean(member.home),
            combatStyle: member.combatStyle ?? null,
        });
    }

    if (agent.bot?.entity) {
        const position = agent.bot.entity.position;
        members.set(agent.name, {
            name: agent.name,
            role: society.getRole(agent),
            roleLabel: society.roleLabel(society.getRole(agent)),
            personality: agent.personality ?? getPersonality(agent.prompter?.profile ?? agent.name),
            progression: progression.getStatus(agent.bot).stage,
            action: agent.actions.currentActionLabel || 'idle',
            inventory: inventorySummary(agent.bot),
            health: Math.round(agent.bot.health ?? 20),
            hunger: Math.round(agent.bot.food ?? 20),
            position: {
                x: Math.floor(position.x),
                y: Math.floor(position.y),
                z: Math.floor(position.z),
                dimension: String(agent.bot.game?.dimension ?? 'world'),
            },
            hasHome: Boolean(base.getBase(agent.bot)),
            combatStyle: agent.prompter?.profile?.combat_style ?? null,
        });
    }

    return [...members.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function allowedPlanFocuses({ hasHome = true, allowBuilding = true,
    hasSchematics = true, socialGoals = false } = {}) {
    const base = FOCUSES.filter(focus => {
        if (!hasHome && ['base', 'build', 'farm'].includes(focus)) return false;
        if (focus === 'build' && (!allowBuilding || !hasSchematics)) return false;
        return true;
    });
    return socialGoals ? [...base, 'social'] : base;
}

function getAllowedFocuses(hasHome = true) {
    const schematics = build.listSchematics();
    // ALTERA/PIANO Phase 4: a `social` focus lets the planner prioritize a social goal that
    // the deterministic generator then executes (deliver surplus / gift). Flag-gated.
    return allowedPlanFocuses({
        hasHome,
        allowBuilding: settings.allow_building !== false,
        hasSchematics: schematics.length > 0,
        socialGoals: cognitionSettings().social_goals_enabled === true,
    });
}

function defaultResourceForRole(_role, sharedNeed = 'wood') {
    return RESOURCES.includes(sharedNeed) ? sharedNeed : 'wood';
}

function defaultFocusForRole(_role, sharedNeed = 'wood', allowedFocuses = FOCUSES) {
    if (sharedNeed === 'food' && allowedFocuses.includes('farm')) return 'farm';
    if (allowedFocuses.includes('build') && ['wood', 'stone'].includes(sharedNeed))
        return 'build';
    return 'stockpile';
}

export function normalizePlan(raw, context, now, source, sharedNeed = 'wood') {
    const role = context.role;
    const personality = context.personality ?? getPersonality(context.name ?? 'Agent');
    const allowedFocuses = getAllowedFocuses(context.hasHome !== false);
    const schematics = build.listSchematics();
    let focus = allowedFocuses.includes(raw?.focus)
        ? raw.focus
        : defaultFocusForRole(role, sharedNeed, allowedFocuses);
    let resource = RESOURCES.includes(raw?.resource)
        ? raw.resource
        : defaultResourceForRole(role, sharedNeed);
    let schematic = schematics.includes(raw?.schematic) ? raw.schematic : '';

    if (focus === 'build') {
        schematic ||= schematics[0] ?? '';
        if (!schematic || settings.allow_building === false)
            focus = 'stockpile';
    }
    const amount = clamp(Number.parseInt(raw?.amount) || (resource === 'food' ? 16 : 32), 8, 128);
    const durationMinutes = clamp(Number.parseInt(raw?.duration_minutes) || 10, 4, 30);
    const project = String(raw?.project ?? `${focus} ${resource}`).replace(/\s+/g, ' ').trim().slice(0, 120);
    const say = String(raw?.say ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);

    return influencePlan({
        focus,
        resource,
        amount,
        schematic,
        project,
        say,
        // AI escalation lever: 'high' runs this plan BEFORE routine progression/role
        // work in brain.js (survival/safety still preempt). The society planner uses it
        // for owner directives and urgent settlement needs; capped in buildSocietyPlan.
        priority: raw?.priority === 'high' ? 'high' : 'normal',
        source,
        ts: now,
        expiresAt: now + durationMinutes * 60_000,
        completed: false,
    }, personality, role, allowedFocuses);
}

function hasActivePlan(agent, now = Date.now()) {
    return Boolean(agent._plan
        && !agent._plan.completed
        && Number(agent._plan.expiresAt ?? 0) > now + 45_000);
}

function extractJson(text) {
    if (!text) return null;
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

async function callWithTimeout(model, turns, system, timeoutSeconds, requestParams = {}) {
    let timer;
    try {
        return await Promise.race([
            model.sendRequest(turns, system, '***', requestParams),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('planner timeout')),
                    Math.max(5000, timeoutSeconds * 1000));
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function societyPrompt(agent, members, allowedFocuses, schematics) {
    const state = society.getSocietyState();
    const totals = RESOURCES.map(resource => {
        const total = members.reduce((sum, member) => sum + (member.inventory?.[resource] ?? 0), 0);
        return `${resource}:${total}`;
    }).join(' ');
    const memberLines = members.map(member => {
        const inv = member.inventory ?? {};
        const p = member.personality ?? getPersonality(member.name);
        return `${member.name}: role=${member.role}/${member.roleLabel}, home=${member.hasHome ? 'set' : 'none'}, personality=${p.socialStyle}/${p.temperament}, traits courage=${p.courage} altruism=${p.altruism} ambition=${p.ambition} caution=${p.caution}, progress=${member.progression}, action=${member.action}, hp=${member.health}, foodbar=${member.hunger}, inv food=${inv.food ?? 0} wood=${inv.wood ?? 0} stone=${inv.stone ?? 0} iron=${inv.iron ?? 0} coal=${inv.coal ?? 0} gold=${inv.gold ?? 0} lapis=${inv.lapis ?? 0} empty=${inv.emptySlots ?? '?'}, combat=${member.combatStyle ?? 'balanced'}`;
    }).join('\n');
    const events = (state.events ?? []).slice(-6).map(event => `- ${event.text}`).join('\n') || '- no recent events';
    const buildNames = schematics.slice(0, 50).join(', ');
    // ALTERA/PIANO Phase 4: the coordinator's read of the others + candidate social goals,
    // so cooperation/specialization can be assigned, not only resource quotas. '' when off.
    const socialBlocks = [socialContext(agent), socialGoalContext(agent), cultureContext(agent)].filter(Boolean).join('\n');
    const socialNote = socialBlocks
        ? `\n${socialBlocks}\nYou may assign a "social" focus to a member to deliver surplus to whoever needs it (helping/gifting); deterministic code picks the concrete recipient.\n`
        : '';
    const directive = state.ownerDirective;
    const directiveNote = directive?.text
        ? `\nOWNER DIRECTIVE from ${directive.by ?? settings.owner_player} (SUPREME COMMANDER — binding until changed): "${directive.text}"\nEvery assignment MUST advance this directive where it is feasible; mark the members executing it most directly with "priority":"high".\n`
        : '';
    return `Kingdom: ${state.name ?? settings.kingdom_name ?? 'Kingdom'}.
Shared totals: ${totals}. Most needed resource: ${society.getResourcePriority(agent.bot)}.
Buildings: ${state.metrics?.buildingCount ?? 0}, roads: ${state.metrics?.roadCount ?? 0}.
Recent events:
${events}
${directiveNote}
Members:
${memberLines}
${socialNote}
Choose one coordinated plan for the next ${settings.society_planner_interval_minutes ?? 10} minutes.
Use only these focuses: [${allowedFocuses.join(', ')}].
Use only these resources for stockpile: [${RESOURCES.join(', ')}].
Build schematic must be one of: [${buildNames}].
Rules:
- survival, combat, hunger, stuck recovery, player commands, and gear progression stay deterministic.
- "priority":"high" makes a member work the plan BEFORE routine role work — use it for at most 2 members, only for the owner directive or an urgent settlement need.
- every member is a generalist: any member may farm, mine, build, guard, explore, handle storage, or gather resources when it helps the settlement.
- do not assign impossible fantasy projects or materials the bots cannot gather.
- members with home=none cannot use base, farm or build focuses; give them stockpile, explore, relax or social work.
- return every listed member exactly once.

Return ONLY valid JSON:
{"strategy":"short group intention","assignments":{"${members[0]?.name ?? 'Name'}":{"focus":"${allowedFocuses.join('|')}","resource":"${RESOURCES.join('|')}","amount":32,"schematic":"","duration_minutes":10,"priority":"normal|high","project":"short concrete goal","say":"optional short in-character line"}}}`;
}

function buildSocietyPlan(raw, agent, members, now) {
    const sharedNeed = society.getResourcePriority(agent.bot);
    const intervalMs = Math.max(3, settings.society_planner_interval_minutes ?? 10) * 60_000;
    const assignments = {};
    let maxExpiresAt = now + intervalMs;
    let highs = 0;
    for (const member of members) {
        const source = raw?.assignments?.[member.name] ?? raw?.[member.name] ?? {};
        const plan = normalizePlan(source, member, now, 'society', sharedNeed);
        if (plan.priority === 'high' && ++highs > 2) plan.priority = 'normal'; // cap escalations
        plan.planId = `${now}:${agent.name}:${member.name}`;
        assignments[member.name] = plan;
        maxExpiresAt = Math.max(maxExpiresAt, plan.expiresAt);
    }
    const strategy = String(raw?.strategy ?? 'Coordinate useful kingdom work.')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
    return {
        version: 1,
        planId: `${now}:${agent.name}`,
        coordinator: agent.name,
        strategy,
        assignments,
        updatedAt: new Date(now).toISOString(),
        expiresAt: new Date(maxExpiresAt).toISOString(),
        nextAt: new Date(now + intervalMs).toISOString(),
    };
}

function writeSocietyPlannerCooldown(delayMs, reason) {
    const previous = readSocietyPlan(true);
    const now = Date.now();
    writeSocietyPlan({
        ...previous,
        nextAt: new Date(now + delayMs).toISOString(),
        lastError: String(reason ?? 'planner cooldown').slice(0, 180),
    });
}

// Owner directives must take effect immediately: expire the current shared plan and
// clear the planner cooldown, so the next society check (<=60s) produces a fresh
// plan aligned with the directive instead of riding out the old one.
export function forceSocietyReplan(reason = 'owner directive') {
    const previous = readSocietyPlan(true);
    const now = Date.now();
    writeSocietyPlan({
        ...previous,
        expiresAt: new Date(now).toISOString(),
        nextAt: new Date(now).toISOString(),
        lastError: String(reason).slice(0, 180),
    });
}

export function applySocietyPlan(agent) {
    if (settings.kingdom_mode === false || !agent.bot?.entity) return false;
    const store = readSocietyPlan();
    const now = Date.now();
    if (parseTime(store.expiresAt) <= now) return false;
    const assignment = store.assignments?.[agent.name];
    if (!assignment) return false;
    const expiresAt = typeof assignment.expiresAt === 'number'
        ? assignment.expiresAt
        : parseTime(assignment.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;

    const planId = assignment.planId ?? `${store.planId}:${agent.name}`;
    // Same plan: never re-apply. Re-applying a plan the bot already completed would
    // resurrect it every tick (memory spam + completed/reapply ping-pong) until the
    // shared assignment expires.
    if (agent._plan?.planId === planId) return !agent._plan.completed;

    const plan = normalizePlan(
        assignment,
        { name: agent.name, role: society.getRole(agent), hasHome: Boolean(base.getBase(agent.bot)) },
        Number(assignment.ts ?? now),
        'society',
        society.getResourcePriority(agent.bot),
    );
    plan.planId = planId;
    plan.expiresAt = expiresAt;
    agent._plan = plan;
    recordPlannerStatus(agent, 'society', 'plan-executable', {
        focus: plan.focus, planId, source: 'shared-assignment',
    });
    const narration = narratePlan(agent, plan);
    void rpEvents.recordPlan(agent, plan, narration)
        .catch(error => console.warn(`[rp ${agent.name}] plan memory failed: ${error.message}`));
    // ALTERA/PIANO Phase 5: planner narration is memory-only. The bot speaks through
    // cognition.speakIntention() after brain.js has chosen the real executable action.
    console.log(`[plan ${agent.name}] society focus=${plan.focus}${plan.project ? ' - ' + plan.project : ''}`);
    return true;
}

export async function planSociety(agent) {
    if (settings.ai_enabled === false || settings.kingdom_mode === false || settings.society_planner_enabled === false) {
        recordPlannerStatus(agent, 'society', 'disabled');
        return false;
    }
    const bot = agent.bot;
    const model = agent.prompter?.code_model ?? agent.prompter?.chat_model;
    if (!bot?.entity || !model) {
        recordPlannerStatus(agent, 'society', !model ? 'no-model' : 'not-ready');
        return false;
    }

    const result = await withNamedLock(bot, 'society-planner', async () => {
        const current = readSocietyPlan(true);
        const now = Date.now();
        if (parseTime(current.nextAt) > now) {
            recordPlannerStatus(agent, 'society', 'scheduled', { nextAt: current.nextAt });
            return { created: false };
        }

        const members = activePlannerMembers(agent);
        if (members.length === 0) {
            recordPlannerStatus(agent, 'society', 'no-members');
            return { created: false };
        }

        const schematics = build.listSchematics();
        const allowedFocuses = getAllowedFocuses(members.some(member => member.hasHome));
        const system = 'You are the strategic planner for a cooperative Minecraft NPC kingdom. Return only valid JSON. You assign bounded goals; deterministic code handles execution, safety, combat, pathfinding, inventory, and player commands.';
        const user = societyPrompt(agent, members, allowedFocuses, schematics);
        const outputTokens = Math.max(400, settings.society_planner_max_output_tokens ?? 1200);
        const estimatedInputTokens = Math.ceil((system.length + user.length) / 3) + 200;
        const reservation = await reservePlannerCallDetailed(bot, estimatedInputTokens, outputTokens);
        if (!reservation.allowed) {
            recordPlannerStatus(agent, 'society', reservation.reason);
            writeSocietyPlannerCooldown(reservation.reason === 'lock-busy' ? 15_000 : 5 * 60_000,
                reservation.reason);
            console.log(`[plan society] ${reservation.reason}`);
            return { created: false };
        }

        let reply;
        try {
            reply = await callWithTimeout(
                model,
                [{ role: 'user', content: user }],
                system,
                Math.max(5, settings.planner_timeout_seconds ?? 25),
                {
                    reasoning: { effort: 'low' },
                    max_output_tokens: outputTokens,
                },
            );
        } catch (error) {
            recordPlannerStatus(agent, 'society', 'model-error', { reason: error.message });
            writeSocietyPlannerCooldown(2 * 60_000, error.message);
            console.log(`[plan society] LLM error: ${error.message}`);
            return { created: false };
        }
        await recordPlannerUsage(bot, model.last_usage);

        const parsed = extractJson(reply);
        if (!parsed) {
            recordPlannerStatus(agent, 'society', 'planner-invalid', { reason: 'invalid JSON' });
            writeSocietyPlannerCooldown(2 * 60_000, 'invalid JSON');
            console.log('[plan society] invalid JSON, keeping deterministic behavior');
            return { created: false };
        }

        const plan = buildSocietyPlan(parsed, agent, members, now);
        recordPlannerStatus(agent, 'society', 'plan-executable', {
            planId: plan.planId, source: 'new-shared-plan',
        });
        writeSocietyPlan(plan);
        console.log(`[plan society] ${plan.strategy}`);
        void society.recordEvent(bot, 'planning', agent.name,
            `Shared plan: ${plan.strategy}`).catch(() => {});
        return { created: true, plan };
    }, 250);

    if (!result.locked) {
        recordPlannerStatus(agent, 'society', 'lock-busy');
        return false;
    }
    if (result.value?.created) applySocietyPlan(agent);
    return Boolean(result.value?.created);
}

export async function planLocal(agent, options = {}) {
    const bot = agent.bot;
    const now = Date.now();
    if (settings.ai_enabled === false || !bot?.entity) {
        recordPlannerStatus(agent, 'local', settings.ai_enabled === false ? 'disabled' : 'not-ready');
        return false;
    }
    if (!options.force && hasActivePlan(agent, now)) {
        recordPlannerStatus(agent, 'local', 'plan-active', { planId: agent._plan.planId });
        return false;
    }

    const model = options.model ?? agent.prompter?.chat_model;
    if (!model) {
        recordPlannerStatus(agent, 'local', 'no-model');
        return false;
    }

    const profileModel = String(agent.prompter?.profile?.model ?? '');
    const allowCloud = options.allowCloud ?? settings.local_planner_allow_cloud === true;
    if (!allowCloud && !profileModel.startsWith('ollama/')) {
        recordPlannerStatus(agent, 'local', 'cloud-disabled');
        return false;
    }

    // Cloud micro-plans MUST respect the planner budget cap ($/window + max calls) and cap
    // their output tokens; local ollama plans are free and skip it. The regular brain.js
    // caller passes no options, so infer "cloud" from the model rather than the caller —
    // otherwise enabling local_planner_allow_cloud would spend on OpenAI uncapped.
    const usingCloud = !profileModel.startsWith('ollama/');
    const reserveBudget = options.reserveBudget ?? usingCloud;

    const role = society.getRole(agent);
    const hasHome = Boolean(base.getBase(bot));
    const allowedFocuses = getAllowedFocuses(hasHome);
    const schematics = build.listSchematics();
    const sharedPlan = readSocietyPlan();
    const sharedAssignment = sharedPlan.assignments?.[agent.name];
    // ALTERA/PIANO Phase 4: this bot's read of the others + candidate social goals, so a
    // single bot can choose to help/specialize on its own (the recursive-social-goal path).
    const socialBlocks = [socialContext(agent), socialGoalContext(agent), cultureContext(agent)].filter(Boolean).join('\n');
    const socialFocusHint = allowedFocuses.includes('social')
        ? ' Use "social" focus to help a fellow member (deterministic code delivers the surplus).'
        : '';
    const system = 'You are a cheap local Minecraft NPC micro-planner. Return only valid JSON. Pick one small, feasible focus; deterministic code will execute it safely.';
    const ownerDirective = society.getSocietyState()?.ownerDirective;
    const user = `Bot: ${agent.name}, role=${role}/${society.roleLabel(role)}.
Current situation: ${situation(agent)}.
${ownerDirective?.text ? `OWNER DIRECTIVE (binding): "${ownerDirective.text}" — your goal must advance it when feasible.\n` : ''}Memory context:
${memoryContext(agent, 5)}
${socialBlocks ? socialBlocks + '\n' : ''}Shared strategy: ${sharedPlan.strategy || 'none'}.
Shared assignment: ${sharedAssignment ? JSON.stringify({
        focus: sharedAssignment.focus,
        resource: sharedAssignment.resource,
        project: sharedAssignment.project,
    }) : 'none'}.
Allowed focuses: [${allowedFocuses.join(', ')}].
Resources: [${RESOURCES.join(', ')}].
Schematics: [${schematics.slice(0, 50).join(', ')}].
Pick a short useful goal for the next few minutes.${socialFocusHint} Do not fight, pathfind, or issue commands. Return ONLY:
{"focus":"${allowedFocuses.join('|')}","resource":"${RESOURCES.join('|')}","amount":8,"schematic":"","duration_minutes":6,"project":"short concrete goal","say":"optional short line"}`;
    const outputTokens = Math.max(64, options.outputTokens ?? 220);
    const estimatedInputTokens = Math.ceil((system.length + user.length) / 3) + 100;
    if (reserveBudget) {
        const reservation = await reservePlannerCallDetailed(bot, estimatedInputTokens, outputTokens);
        if (!reservation.allowed) {
            recordPlannerStatus(agent, 'local', reservation.reason, { allowedFocuses });
            return false;
        }
    }

    let reply;
    try {
        reply = await callWithTimeout(
            model,
            [{ role: 'user', content: user }],
            system,
            Math.max(5, options.timeoutSeconds ?? settings.local_planner_timeout_seconds ?? 15),
            reserveBudget
                ? { reasoning: { effort: 'low' }, max_output_tokens: outputTokens }
                : {},
        );
    } catch (error) {
        recordPlannerStatus(agent, 'local', 'model-error', { reason: error.message, allowedFocuses });
        console.log(`[plan ${agent.name}] local planner error: ${error.message}`);
        return false;
    }
    if (reserveBudget) await recordPlannerUsage(bot, model.last_usage);

    const parsed = extractJson(reply);
    if (!parsed) {
        recordPlannerStatus(agent, 'local', 'planner-invalid', { reason: 'invalid JSON', allowedFocuses });
        return false;
    }
    const plan = normalizePlan(parsed, { name: agent.name, role, hasHome }, now, options.source ?? 'local',
        society.getResourcePriority(bot));
    plan.planId = `${plan.source}:${agent.name}:${now}`;
    agent._plan = plan;
    recordPlannerStatus(agent, 'local', 'plan-executable', {
        focus: plan.focus, planId: plan.planId, allowedFocuses,
    });
    const narration = narratePlan(agent, plan);
    void rpEvents.recordPlan(agent, plan, narration)
        .catch(error => console.warn(`[rp ${agent.name}] plan memory failed: ${error.message}`));
    // ALTERA/PIANO Phase 5: planner narration is memory-only. The bot speaks through
    // cognition.speakIntention() after brain.js has chosen the real executable action.
    console.log(`[plan ${agent.name}] ${plan.source} focus=${plan.focus}${plan.project ? ' - ' + plan.project : ''}`);
    return true;
}

// Backward-compatible single-bot planner entry point. The brain now prefers the
// hybrid society/local flow, but tests or manual imports can still call plan().
export async function plan(agent) {
    const model = agent.prompter?.code_model ?? agent.prompter?.chat_model;
    return await planLocal(agent, {
        force: true,
        allowCloud: true,
        model,
        reserveBudget: true,
        source: 'legacy',
        timeoutSeconds: settings.planner_timeout_seconds ?? 25,
        outputTokens: Math.max(64, settings.planner_max_output_tokens ?? 250),
    });
}
