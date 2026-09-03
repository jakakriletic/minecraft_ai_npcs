import settings from '../settings.js';
import { addMemory, recordActionMemory, recordPlanMemory } from './memory.js';
import { updateRelation, updateMutual } from './social_graph.js';
import { noteSharing } from '../library/culture.js';

function isHumanSource(agent, source) {
    if (!source || source === 'system' || source === agent.name) return false;
    try {
        const names = Object.values(agent.bot?.players ?? {}).map(player => player.username);
        return names.includes(source);
    } catch {
        return true;
    }
}

export async function recordPlan(agent, plan, narration = null) {
    if (settings.rp_enabled === false || !agent?.name || !plan) return;
    await Promise.resolve();
    recordPlanMemory(agent, plan);
    if (narration?.risk_notes?.length) {
        addMemory(agent, {
            type: 'preference',
            bucket: 'long_term',
            content: `Planning risk note: ${narration.risk_notes.join('; ')}.`,
            importance: 3,
            tone: 'thoughtful',
            source_event: `planner:${plan.source ?? 'unknown'}`,
        });
    }
}

export async function recordActionResult(agent, actionName, result) {
    if (settings.rp_enabled === false || !agent?.name || !actionName) return;
    await Promise.resolve();
    recordActionMemory(agent, actionName, result);
    const ok = result?.success && !result?.interrupted && !result?.timedout;
    if (!ok && Number(agent.personality?.caution ?? 0) > 0.65) {
        addMemory(agent, {
            type: 'preference',
            bucket: 'long_term',
            content: `A failed or interrupted ${actionName} made ${agent.name} more cautious about repeating that exact approach.`,
            importance: 4,
            tone: 'wary',
            source_event: `action:${actionName}`,
        });
    }
}

export async function recordDeath(agent) {
    if (settings.rp_enabled === false || !agent?.name) return;
    await Promise.resolve();
    addMemory(agent, {
        type: 'milestone',
        bucket: 'long_term',
        content: `${agent.name} died and will remember this as a serious setback.`,
        importance: 8,
        tone: 'shaken',
        related_entities: ['kingdom'],
        source_event: 'death',
    });
}

export async function recordPlayerCommand(agent, source, message, commandName) {
    if (settings.rp_enabled === false || !isHumanSource(agent, source)) return;
    const lower = String(message).toLowerCase();
    const related = [source];
    let content = `${source} ordered ${agent.name} to run ${commandName}.`;
    let tone = 'obedient';
    let importance = 3;
    if (/mine|iron|diamond|ore|kop|ruda/i.test(lower)) {
        content = `${source} often treats ${agent.name} as useful for mining or resource work.`;
        importance = 4;
    } else if (/build|farm|storage|stash|protect|follow/i.test(lower)) {
        importance = 4;
    }
    addMemory(agent, {
        type: 'social',
        bucket: 'long_term',
        content,
        importance,
        tone,
        related_entities: related,
        source_event: `player_command:${commandName}`,
    });
    await updateRelation(agent, source, {
        trust: 0.015,
        dependency: 0.01,
        respect: commandName === '!stop' ? -0.005 : 0.005,
    }, `player command ${commandName}`);
}

export async function recordPlayerMessage(agent, source, message) {
    if (settings.rp_enabled === false || !isHumanSource(agent, source)) return;
    const text = String(message);
    if (text.trim().startsWith('!')) return;
    if (/bravo|dobro|super|hvala|nice|good|thanks/i.test(text)) {
        addMemory(agent, {
            type: 'social',
            bucket: 'long_term',
            content: `${source} encouraged or thanked ${agent.name}.`,
            importance: 4,
            tone: 'appreciated',
            related_entities: [source],
            source_event: 'player_praise',
        });
        await updateRelation(agent, source, { trust: 0.03, respect: 0.02, friendship: 0.025 }, 'player praise');
    } else if (/neumno|slabo|bad|stupid|fail/i.test(text)) {
        addMemory(agent, {
            type: 'social',
            bucket: 'long_term',
            content: `${source} criticized ${agent.name}.`,
            importance: 5,
            tone: 'hurt',
            related_entities: [source],
            source_event: 'player_criticism',
        });
        await updateRelation(agent, source, { trust: -0.025, annoyance: 0.035, respect: -0.015 }, 'player criticism');
    }
}

export async function recordSupplyShare(agent, target, item, count) {
    if (settings.rp_enabled === false || !target || target === agent.name) return;
    addMemory(agent, {
        type: 'social',
        bucket: 'long_term',
        content: `${agent.name} helped ${target} with ${count}x ${item}.`,
        importance: 5,
        tone: 'helpful',
        related_entities: [target],
        source_event: 'supply_share',
    });
    await updateMutual(agent, target,
        { trust: 0.025, respect: 0.015, friendship: 0.02 },
        { trust: 0.04, respect: 0.02, friendship: 0.035, dependency: 0.015, debt: 0.03 },
        `shared ${count}x ${item}`);
    await noteSharing(agent, target);
}
