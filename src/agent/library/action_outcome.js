// Small, deterministic proof-of-progress layer for brain actions.
//
// Most Mindcraft skills already return an explicit boolean. Legacy helpers may
// resolve with `undefined`, which ActionManager historically treated as success.
// For those ambiguous results we require an observable player-state change so a
// no-op cannot clear backoff and immediately win the utility graph again.

function inventorySignature(bot) {
    const counts = new Map();
    for (const item of bot?.inventory?.items?.() ?? [])
        counts.set(item.name, (counts.get(item.name) ?? 0) + Number(item.count ?? 0));
    return [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => `${name}:${count}`)
        .join('|');
}

const STRUCTURED_KINDS = new Set([
    'done',
    'progress',
    'waiting',
    'blocked',
    'failed',
    'interrupted',
]);

// Actions that have asynchronous prerequisites (a shared mining expedition, a
// locked container, a temporarily unreachable work site) need more vocabulary
// than true/false.  Keeping this tiny object contract here lets old boolean skills
// continue to work while newer planners can distinguish useful partial progress
// from a real failure.
export function actionOutcome(kind, details = {}) {
    const normalized = STRUCTURED_KINDS.has(kind) ? kind : 'failed';
    return {
        kind: normalized,
        ...details,
    };
}

function structuredValue(result) {
    const value = result?.value;
    return value && typeof value === 'object' && STRUCTURED_KINDS.has(value.kind)
        ? value
        : null;
}

export function captureActionProgress(agent) {
    const bot = agent?.bot;
    const position = bot?.entity?.position;
    return {
        position: position
            ? { x: Number(position.x), y: Number(position.y), z: Number(position.z) }
            : null,
        inventory: inventorySignature(bot),
        health: Number(bot?.health ?? 0),
        food: Number(bot?.food ?? 0),
        experienceLevel: Number(bot?.experience?.level ?? 0),
        experienceProgress: Number(bot?.experience?.progress ?? 0),
        gameMode: bot?.game?.gameMode ?? null,
        planCompleted: agent?._plan?.completed === true,
        planId: agent?._plan?.planId ?? null,
    };
}

function movedMeaningfully(before, after) {
    if (!before?.position || !after?.position) return false;
    const dx = after.position.x - before.position.x;
    const dy = after.position.y - before.position.y;
    const dz = after.position.z - before.position.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) >= 1.25;
}

export function observedActionProgress(before, after) {
    if (!before || !after) return false;
    return movedMeaningfully(before, after)
        || before.inventory !== after.inventory
        || before.health !== after.health
        || before.food !== after.food
        || before.experienceLevel !== after.experienceLevel
        || before.experienceProgress !== after.experienceProgress
        || before.gameMode !== after.gameMode
        || before.planCompleted !== after.planCompleted
        || before.planId !== after.planId;
}

export function verifyActionOutcome(action, result, before, after) {
    if (result?.interrupted) {
        return {
            ...result,
            success: false,
            message: result.message || 'Action was interrupted; temporary retry backoff applied.',
            progressVerified: false,
        };
    }
    if (!result?.success) {
        return {
            ...result,
            progressVerified: false,
        };
    }

    const structured = structuredValue(result);
    if (structured) {
        const successful = structured.kind === 'done' || structured.kind === 'progress';
        const interrupted = structured.kind === 'interrupted';
        return {
            ...result,
            ...structured,
            success: successful,
            interrupted,
            actionStatus: structured.kind,
            value: structured,
            message: structured.message ?? result.message ?? null,
            progressVerified: successful,
        };
    }

    const observed = observedActionProgress(before, after);
    const explicit = result.value !== undefined && result.value !== null;
    const accepted = action?.allowNoProgress === true || explicit || observed;
    if (accepted) {
        return {
            ...result,
            progressVerified: observed || explicit,
        };
    }

    const proofMessage = 'Action reported success without an explicit result or observable progress.';
    return {
        ...result,
        success: false,
        value: false,
        unverified: true,
        progressVerified: false,
        message: result.message ? `${result.message}\n${proofMessage}` : proofMessage,
    };
}

export function nextActionBackoff(previous, result, now = Date.now()) {
    if (result?.interrupted) {
        const interruptions = Number(previous?.interruptions ?? 0) + 1;
        return {
            failures: Number(previous?.failures ?? 0),
            interruptions,
            cause: 'interrupted',
            retryAt: now + Math.min(15_000, 1000 * (2 ** Math.min(interruptions, 4))),
        };
    }
    if (result?.success) return null;
    if (result?.actionStatus === 'waiting' || result?.actionStatus === 'blocked') {
        const waiting = Number(previous?.waiting ?? 0) + 1;
        const defaultDelay = result.actionStatus === 'waiting'
            ? Math.min(30_000, 3000 * (2 ** Math.min(waiting - 1, 3)))
            : Math.min(120_000, 10_000 * (2 ** Math.min(waiting - 1, 4)));
        return {
            failures: Number(previous?.failures ?? 0),
            interruptions: 0,
            waiting,
            cause: result.actionStatus,
            blocker: result.blocker ?? null,
            retryAt: Math.max(now + 250, Number(result.retryAt ?? now + defaultDelay)),
        };
    }
    const failures = Number(previous?.failures ?? 0) + 1;
    return {
        failures,
        interruptions: 0,
        waiting: 0,
        cause: result?.unverified ? 'no_progress_proof' : 'failed',
        retryAt: now + Math.min(30_000, 2500 * (2 ** Math.min(failures, 4))),
    };
}
