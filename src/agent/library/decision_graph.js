// Dynamic goal arbitration for the deterministic brain.
//
// This is deliberately not a classic decision tree. Trees bake transitions and
// branch order into one structure, which recreates the same rigidity as a linear
// progression. Instead, independent providers publish goal candidates every tick:
// static progression milestones, environment needs, AI plans, society work and
// player commands. The arbiter ranks currently-applicable candidates and only then
// materializes the winning ActionManager action.

const SOURCE_BIAS = Object.freeze({
    safety: 300,
    command: 200,
    environment: 30,
    milestone: 25,
    ai: 20,
    society: 15,
    maintenance: 10,
    ambient: 0,
});
const SOURCE_TIER = Object.freeze({
    safety: 3,
    command: 2,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const COMMITMENT_MS = 45_000;
const SAFETY_REQUEST_TTL_MS = 5_000;

function hasFiniteExpiry(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function available(candidate) {
    if (candidate.available === false) return false;
    if (typeof candidate.available !== 'function') return true;
    try { return candidate.available() !== false; } catch { return false; }
}

function cooling(candidate, backoff, now) {
    if (Number(candidate.cooldownUntil ?? 0) > now) return true;
    const actionName = candidate.actionName;
    return Boolean(actionName && Number(backoff?.[actionName]?.retryAt ?? 0) > now);
}

function candidateAging(candidate, { now, waiting }) {
    const config = candidate.aging;
    if (!config) return { agingBonus: 0, waitedMs: 0 };
    const readySince = Number(waiting?.[candidate.key]?.readySince ?? candidate.readySince ?? now);
    const waitedMs = Math.max(0, now - readySince);
    const afterMs = Math.max(0, Number(config.afterMs ?? 0));
    const fullAtMs = Math.max(afterMs + 1, Number(config.fullAtMs ?? afterMs + 1));
    const maxBonus = clamp(config.maxBonus ?? 0, 0, 150);
    if (waitedMs <= afterMs) return { agingBonus: 0, waitedMs };
    const ratio = clamp((waitedMs - afterMs) / (fullAtMs - afterMs), 0, 1);
    return { agingBonus: Math.round(maxBonus * ratio), waitedMs };
}

function outcomePenalty(candidate, { now, outcomes }) {
    const outcome = outcomes?.[candidate.key];
    if (!outcome) return 0;
    const ageMs = Math.max(0, now - Number(outcome.lastAt ?? now));
    // Failure knowledge is useful, but the world changes. Decay it over ten
    // minutes so a repaired path/resource source can eventually be tried again.
    const decay = Math.max(0, 1 - ageMs / (10 * 60_000));
    if (outcome.lastOutcome === 'failed') {
        const failures = Math.max(1, Number(outcome.consecutiveFailures ?? 1));
        return Math.round(Math.min(90, 12 * (2 ** Math.min(failures - 1, 3))) * decay);
    }
    if (outcome.lastOutcome === 'blocked') {
        const blocks = Math.max(1, Number(outcome.consecutiveBlocks ?? 1));
        return Math.round(Math.min(75, 18 * blocks) * decay);
    }
    // Waiting is an expected dependency state, not a failure. A tiny penalty lets
    // another ready branch win after the wait backoff without burying this goal.
    if (outcome.lastOutcome === 'waiting') return Math.round(4 * decay);
    return 0;
}

function candidateScore(candidate, { now, lastSelected, waiting, outcomes }) {
    const sourceBias = SOURCE_BIAS[candidate.source] ?? SOURCE_BIAS.maintenance;
    const utility = clamp(candidate.utility, -100, 100);
    const urgency = clamp(candidate.urgency, 0, 50);
    const priority = clamp(candidate.priority, -50, 50);
    const unlockValue = clamp(candidate.unlockValue, 0, 50);
    const estimatedCost = clamp(candidate.estimatedCost, 0, 100);
    const stillCommitted = lastSelected?.key === candidate.key
        && !['failed', 'interrupted'].includes(lastSelected.outcome)
        && now - Number(lastSelected.selectedAt ?? 0) < COMMITMENT_MS;
    const commitmentBonus = stillCommitted
        ? clamp(candidate.commitmentBonus ?? 12, 0, 25)
        : 0;
    const { agingBonus, waitedMs } = candidateAging(candidate, { now, waiting });
    const failurePenalty = outcomePenalty(candidate, { now, outcomes });
    const baseScore = sourceBias + utility + urgency + priority + unlockValue - estimatedCost;
    return {
        score: baseScore + commitmentBonus + agingBonus - failurePenalty,
        baseScore,
        commitmentBonus,
        agingBonus,
        unlockValue,
        estimatedCost,
        failurePenalty,
        waitedMs,
    };
}

// Pure ranking entry point, exported so policy can be regression-tested without a
// Mineflayer bot. Ties are stable by key to keep multi-bot behavior reproducible.
export function rankDecisionCandidates(candidates, context = {}) {
    const now = Number(context.now ?? Date.now());
    const lastSelected = context.lastSelected ?? null;
    const backoff = context.backoff ?? {};
    const waiting = context.waiting ?? {};
    const outcomes = context.outcomes ?? {};
    return (candidates ?? [])
        .filter(candidate => candidate?.key && available(candidate))
        .filter(candidate => !hasFiniteExpiry(candidate.expiresAt)
            || Number(candidate.expiresAt) > now)
        .filter(candidate => !cooling(candidate, backoff, now))
        .map(candidate => ({
            ...candidate,
            tier: SOURCE_TIER[candidate.source] ?? 1,
            ...candidateScore(candidate, { now, lastSelected, waiting, outcomes }),
        }))
        .sort((a, b) => b.tier - a.tier
            || b.score - a.score
            || String(a.key).localeCompare(String(b.key)));
}

function publicCandidate(candidate) {
    return {
        key: candidate.key,
        source: candidate.source ?? 'maintenance',
        tier: Number(candidate.tier ?? SOURCE_TIER[candidate.source] ?? 1),
        score: candidate.score,
        baseScore: candidate.baseScore,
        utility: Number(candidate.utility ?? 0),
        urgency: Number(candidate.urgency ?? 0),
        commitmentBonus: Number(candidate.commitmentBonus ?? 0),
        agingBonus: Number(candidate.agingBonus ?? 0),
        unlockValue: Number(candidate.unlockValue ?? 0),
        estimatedCost: Number(candidate.estimatedCost ?? 0),
        failurePenalty: Number(candidate.failurePenalty ?? 0),
        waitedMs: Number(candidate.waitedMs ?? 0),
        reason: candidate.reason ?? '',
    };
}

function updateWaitingState(state, candidates, now) {
    state.waiting ??= {};
    const live = new Set();
    for (const candidate of candidates ?? []) {
        if (!candidate?.key || !available(candidate)) continue;
        if (hasFiniteExpiry(candidate.expiresAt) && Number(candidate.expiresAt) <= now) continue;
        live.add(candidate.key);
        state.waiting[candidate.key] ??= { readySince: now };
        state.waiting[candidate.key].lastSeenAt = now;
    }
    for (const key of Object.keys(state.waiting)) {
        if (!live.has(key)) delete state.waiting[key];
    }
}

// Materialize providers in score order. A provider may return null when its detailed
// preconditions changed between sensing and selection; the next candidate then gets
// a chance without rebuilding the whole decision graph.
export function chooseDecision(agent, candidates, context = {}) {
    agent._decisionState ??= { candidates: [], lastSelected: null, waiting: {}, outcomes: {} };
    const now = Number(context.now ?? Date.now());
    const backoff = agent._brain?.actionBackoff ?? {};
    updateWaitingState(agent._decisionState, candidates, now);
    const ranked = rankDecisionCandidates(candidates, {
        now,
        backoff,
        lastSelected: agent._decisionState.lastSelected,
        waiting: agent._decisionState.waiting,
        outcomes: agent._decisionState.outcomes,
    });
    agent._decisionState.candidates = ranked.slice(0, 10).map(publicCandidate);
    agent._decisionState.updatedAt = now;

    for (const candidate of ranked) {
        let action;
        try {
            action = typeof candidate.createAction === 'function'
                ? candidate.createAction()
                : candidate.action;
        } catch (error) {
            console.warn(`[decision ${agent.name}] ${candidate.key}: ${error.message}`);
            continue;
        }
        if (!action?.name || typeof action.fn !== 'function') continue;
        if (Number(backoff[action.name]?.retryAt ?? 0) > now) continue;

        const selected = {
            ...publicCandidate(candidate),
            action: action.name,
            selectedAt: now,
        };
        agent._decisionState.lastSelected = selected;
        action.decision = selected;
        const actionOnStart = action.onStart;
        const candidateOnStart = candidate.onSelected;
        if (typeof actionOnStart === 'function' || typeof candidateOnStart === 'function') {
            action.onStart = () => {
                if (typeof candidateOnStart === 'function') candidateOnStart(action);
                if (typeof actionOnStart === 'function') actionOnStart();
            };
        }
        return action;
    }
    return null;
}

function safetyRequests(agent) {
    if (!(agent._pendingSafetyDecisions instanceof Map))
        agent._pendingSafetyDecisions = new Map();
    return agent._pendingSafetyDecisions;
}

function pruneSafetyRequests(agent, now) {
    const requests = safetyRequests(agent);
    for (const [key, request] of requests) {
        if (Number(request.expiresAt ?? 0) > now) continue;
        requests.delete(key);
        try { request.onDiscard?.('expired'); } catch { /* safety cleanup is best effort */ }
    }
    return requests;
}

// Reactive modes publish urgent work here instead of starting a second, competing
// ActionManager action. The brain remains the single owner of safety arbitration and
// wakes immediately; an active player command is never preempted by this queue.
export function queueSafetyAction(agent, request = {}) {
    const now = Number(request.now ?? Date.now());
    const key = String(request.key ?? request.name ?? '').trim();
    const canCreate = typeof request.createAction === 'function' || request.action;
    if (!key || !canCreate) return false;

    const goalKey = String(request.goalKey ?? key);
    const active = agent._brain?.activeDecision;
    if (agent.actions?.executing && active?.goalKey === goalKey) return false;

    const requests = pruneSafetyRequests(agent, now);
    const expiresAt = hasFiniteExpiry(request.expiresAt)
        ? Number(request.expiresAt)
        : now + SAFETY_REQUEST_TTL_MS;
    const requestedPriority = Number(request.priority ?? 0);
    const sameGoal = [...requests.values()].find(entry => entry.goalKey === goalKey);
    if (sameGoal && sameGoal.key !== key) {
        if (sameGoal.priority >= requestedPriority) {
            sameGoal.expiresAt = Math.max(sameGoal.expiresAt, expiresAt);
            agent._brain?.wake?.();
            return false;
        }
        requests.delete(sameGoal.key);
        try { sameGoal.onDiscard?.('superseded'); } catch { /* best effort */ }
    }
    const previous = requests.get(key);
    if (previous) {
        previous.createAction = request.createAction ?? previous.createAction;
        previous.action = request.action ?? previous.action;
        previous.reason = request.reason ?? previous.reason;
        previous.expiresAt = Math.max(previous.expiresAt, expiresAt);
        previous.priority = Math.max(previous.priority, requestedPriority);
        agent._brain?.wake?.();
        return false;
    }

    const actionLabel = agent.actions?.currentActionLabel ?? '';
    const stored = {
        key,
        goalKey,
        priority: requestedPriority,
        reason: request.reason ?? `reactive safety mode ${key}`,
        createAction: request.createAction,
        action: request.action,
        onDiscard: request.onDiscard,
        requestedAt: now,
        expiresAt,
        preemptedAction: actionLabel || null,
    };
    requests.set(key, stored);

    if (agent.actions?.executing && actionLabel.startsWith('brain:')) {
        const activeId = `${actionLabel}:${active?.selectedAt ?? ''}`;
        const pending = agent._brain?.pendingPreemption;
        if (!pending || stored.priority > pending.priority) {
            if (active) {
                active.preemptedBy = key;
                active.preemptedAt = now;
            }
            if (agent._brain) {
                agent._brain.pendingPreemption = {
                    activeId,
                    key,
                    priority: stored.priority,
                    requestedAt: now,
                };
            }
        }
        if (pending?.activeId !== activeId) {
            try { agent.requestInterrupt(); } catch { /* bot may be disconnecting */ }
        }
    }
    agent._brain?.wake?.();
    return true;
}

export function hasPendingSafetyAction(agent, { now = Date.now() } = {}) {
    return pruneSafetyRequests(agent, Number(now)).size > 0;
}

export function takeSafetyAction(agent, { now = Date.now() } = {}) {
    const currentTime = Number(now);
    const requests = pruneSafetyRequests(agent, currentTime);
    const backoff = agent._brain?.actionBackoff ?? {};
    const ranked = [...requests.values()].sort((a, b) =>
        b.priority - a.priority || a.requestedAt - b.requestedAt || a.key.localeCompare(b.key));

    for (const request of ranked) {
        let action;
        try {
            action = typeof request.createAction === 'function'
                ? request.createAction()
                : request.action;
        } catch (error) {
            console.warn(`[decision ${agent.name}] queued safety ${request.key}: ${error.message}`);
            requests.delete(request.key);
            try { request.onDiscard?.('factory-error'); } catch { /* best effort */ }
            continue;
        }
        if (!action?.name || typeof action.fn !== 'function') {
            requests.delete(request.key);
            try { request.onDiscard?.('not-applicable'); } catch { /* best effort */ }
            continue;
        }
        if (Number(backoff[action.name]?.retryAt ?? 0) > currentTime) continue;

        requests.delete(request.key);
        action.safetyGoal = request.goalKey;
        recordPolicyDecision(agent, action, {
            source: 'safety',
            reason: request.reason,
            now: currentTime,
        });
        action.decision.key = `safety:${request.key}`;
        action.decision.goalKey = request.goalKey;
        action.decision.requestedAt = request.requestedAt;
        action.decision.preemptedAction = request.preemptedAction;
        return action;
    }
    return null;
}

export function recordPolicyDecision(agent, action, {
    source = 'safety',
    reason = 'selected by a deterministic hard-priority rule',
    now = Date.now(),
} = {}) {
    if (!action?.name) return action;
    agent._decisionState ??= { candidates: [], lastSelected: null, waiting: {}, outcomes: {} };
    const selected = {
        key: `${source}:${action.name}`,
        source,
        score: SOURCE_BIAS[source] ?? SOURCE_BIAS.maintenance,
        baseScore: SOURCE_BIAS[source] ?? SOURCE_BIAS.maintenance,
        utility: 0,
        urgency: 0,
        commitmentBonus: 0,
        agingBonus: 0,
        waitedMs: 0,
        reason,
        action: action.name,
        selectedAt: now,
    };
    agent._decisionState.lastSelected = selected;
    agent._decisionState.updatedAt = now;
    action.decision = selected;
    return action;
}

export function recordDecisionOutcome(agent, action, result, { now = Date.now() } = {}) {
    const decision = action?.decision;
    if (!decision?.key) return null;
    agent._decisionState ??= { candidates: [], lastSelected: null, waiting: {}, outcomes: {} };
    agent._decisionState.outcomes ??= {};
    const previous = agent._decisionState.outcomes[decision.key] ?? {};
    const reported = result?.actionStatus;
    const outcome = result?.interrupted
        ? 'interrupted'
        : reported === 'done' ? 'completed'
            : reported === 'progress' ? 'progress'
                : ['waiting', 'blocked', 'failed'].includes(reported)
                    ? reported
                    : (result?.success ? 'completed' : 'failed');
    const record = {
        consecutiveFailures: outcome === 'failed' ? Number(previous.consecutiveFailures ?? 0) + 1 : 0,
        consecutiveBlocks: outcome === 'blocked' ? Number(previous.consecutiveBlocks ?? 0) + 1 : 0,
        consecutiveWaits: outcome === 'waiting' ? Number(previous.consecutiveWaits ?? 0) + 1 : 0,
        consecutiveInterruptions: outcome === 'interrupted'
            ? Number(previous.consecutiveInterruptions ?? 0) + 1
            : 0,
        lastOutcome: outcome,
        lastAt: now,
        retryAt: Number(result?.retryAt ?? 0) || null,
        blocker: result?.blocker ?? null,
        reason: result?.message ?? null,
    };
    agent._decisionState.outcomes[decision.key] = record;
    decision.outcome = outcome;
    decision.completedAt = now;
    if (agent._decisionState.lastSelected?.key === decision.key)
        Object.assign(agent._decisionState.lastSelected, { outcome, completedAt: now });
    // Every actual attempt has received service. Restart aging from here, including
    // failures/waits, otherwise an impossible candidate reaches max age and keeps
    // monopolizing autonomous work immediately after every short backoff.
    if (agent._decisionState.waiting?.[decision.key])
        agent._decisionState.waiting[decision.key].readySince = now;
    agent._decisionState.lastOutcome = { key: decision.key, ...record };
    return record;
}

function externalGoals(agent) {
    if (!(agent._externalDecisionGoals instanceof Map))
        agent._externalDecisionGoals = new Map();
    return agent._externalDecisionGoals;
}

// Player commands still preempt immediately through ActionManager. Recording them as
// external goals puts them in the same observable decision model without delaying an
// explicit command until the next brain tick.
export function recordExternalGoal(agent, goal = {}) {
    const now = Date.now();
    const id = goal.id ?? `${goal.source ?? 'command'}:${goal.key ?? 'goal'}:${now}`;
    const recorded = {
        id,
        key: goal.key ?? id,
        source: goal.source ?? 'command',
        description: String(goal.description ?? goal.key ?? 'external goal').slice(0, 180),
        status: 'active',
        createdAt: now,
        expiresAt: Number(goal.expiresAt ?? now + 30 * 60_000),
    };
    externalGoals(agent).set(id, recorded);
    agent._decisionState ??= { candidates: [], lastSelected: null, waiting: {}, outcomes: {} };
    agent._decisionState.lastSelected = {
        key: `${recorded.source}:${recorded.key}`,
        source: recorded.source,
        score: (SOURCE_BIAS[recorded.source] ?? SOURCE_BIAS.command) + 100,
        utility: 100,
        urgency: 50,
        reason: recorded.description,
        action: recorded.key,
        selectedAt: now,
    };
    agent._decisionState.updatedAt = now;
    return id;
}

export function completeExternalGoal(agent, id, status = 'completed') {
    const goal = externalGoals(agent).get(id);
    if (!goal) return false;
    goal.status = status;
    goal.completedAt = Date.now();
    goal.expiresAt = Math.max(goal.expiresAt ?? 0, goal.completedAt + 2 * 60_000);
    return true;
}

export function getExternalGoals(agent, { includeRecent = true, now = Date.now() } = {}) {
    const goals = externalGoals(agent);
    for (const [id, goal] of goals) {
        const staleCompleted = goal.status !== 'active'
            && now - Number(goal.completedAt ?? goal.createdAt ?? now) > 5 * 60_000;
        if (Number(goal.expiresAt ?? 0) <= now || staleCompleted) goals.delete(id);
    }
    return [...goals.values()]
        .filter(goal => includeRecent || goal.status === 'active')
        .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
}

export function formatDecisionStatus(agent) {
    const state = agent._decisionState ?? {};
    const chosen = state.lastSelected
        ? `${state.lastSelected.key}/${state.lastSelected.source}=${state.lastSelected.score}`
            + `${state.lastSelected.outcome ? `/${state.lastSelected.outcome}` : ''}`
            + ` (${String(state.lastSelected.reason ?? 'no reason').replace(/\s+/g, ' ').slice(0, 100)})`
        : 'none';
    const candidates = (state.candidates ?? []).slice(0, 5)
        .map(candidate => `${candidate.key}:${candidate.score}`
            + `${candidate.agingBonus ? `[age+${candidate.agingBonus}]` : ''}`
            + `${candidate.failurePenalty ? `[fail-${candidate.failurePenalty}]` : ''}`
            + `${candidate.estimatedCost ? `[cost-${candidate.estimatedCost}]` : ''}`
            + `(${String(candidate.reason ?? 'no reason').replace(/\s+/g, ' ').slice(0, 60)})`)
        .join(', ') || 'none';
    const external = getExternalGoals(agent).slice(0, 3)
        .map(goal => `${goal.key}/${goal.status}`)
        .join(', ') || 'none';
    return `DECISIONS: chosen=${chosen} | candidates=${candidates} | external=${external}`;
}
