// Structured owner duty contract. The brain, command layer and future planners
// can inspect this instead of guessing what "current owner action" means.
const DEFAULT_REPORT_POLICY = 'ack_success_failure';
const DEFAULT_SAFETY_POLICY = 'allow_survival_interrupts';

function nowIso(ms = Date.now()) {
    return new Date(ms).toISOString();
}

function compactLabel(label) {
    return String(label ?? 'owner-command')
        .toLowerCase()
        .replace(/[^a-z0-9:_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48) || 'owner-command';
}

function inferIntent(label) {
    const text = String(label ?? '').toLowerCase();
    if (text.startsWith('attack:')) return 'attack';
    if (text.startsWith('chest:')) return 'chest';
    if (text.startsWith('gather:')) return 'gather';
    if (text === 'collectwood') return 'gather';
    if (text === 'follow') return 'follow';
    if (text === 'digpit') return 'dig';
    return 'owner_command';
}

function normalizeTimeout(timeoutMins) {
    const value = Number(timeoutMins);
    return Number.isFinite(value) ? value : null;
}

function normalizeTarget(source, target = null) {
    if (target && typeof target === 'object') return target;
    if (typeof target === 'string' && target.trim()) return { type: 'text', value: target.trim() };
    return { type: 'owner_order', owner: source ?? null };
}

function summarizeValue(value) {
    if (value === undefined || value === null) return null;
    if (['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (Array.isArray(value)) return { type: 'array', length: value.length };
    if (typeof value === 'object') {
        return {
            type: value.constructor?.name ?? 'object',
            keys: Object.keys(value).slice(0, 8),
        };
    }
    return String(value);
}

function summarizeResult(result = {}, options = {}) {
    return {
        success: result?.success === true,
        timedout: result?.timedout === true,
        interrupted: result?.interrupted === true,
        replaced: options.replaced === true,
        reason: options.reason ?? null,
        value: summarizeValue(result?.value),
    };
}

function finishStatus(result = {}, options = {}) {
    if (options.replaced) return 'replaced';
    if (options.reason === 'owner_stop') return 'cancelled';
    if (result?.success) return 'succeeded';
    if (result?.timedout) return 'timed_out';
    if (result?.interrupted) return 'interrupted';
    return 'failed';
}

export function createRoyalIntent(agent, source, label, options = {}) {
    const createdAtMs = Date.now();
    const timeoutMins = normalizeTimeout(options.timeoutMins);
    const until = options.until !== undefined
        ? options.until
        : timeoutMins > 0 ? createdAtMs + timeoutMins * 60_000 : null;
    const actor = agent?.name ?? agent?.bot?.username ?? null;
    const sequence = agent?._ownerCommandSeq ?? 0;
    const selectedBots = options.selectedBots ?? (actor ? [actor] : []);

    return {
        kind: 'RoyalIntent',
        version: 1,
        id: `${actor ?? 'npc'}:${sequence}:${createdAtMs}:${compactLabel(label)}`,
        label: String(label ?? 'owner command'),
        intent: options.intent ?? inferIntent(label),
        source: source ?? null,
        actor,
        selectedBots,
        target: normalizeTarget(source, options.target),
        priority: options.priority ?? 'royal',
        status: 'accepted',
        safetyPolicy: options.safetyPolicy ?? DEFAULT_SAFETY_POLICY,
        reportPolicy: options.reportPolicy ?? DEFAULT_REPORT_POLICY,
        ack: options.ack ?? '',
        createdAt: nowIso(createdAtMs),
        createdAtMs,
        startedAt: null,
        startedAtMs: null,
        updatedAt: nowIso(createdAtMs),
        updatedAtMs: createdAtMs,
        until,
        untilIso: until === null ? null : nowIso(until),
        timeoutMins,
        sequence,
        resume: {
            attempts: 0,
            maxUntil: until,
        },
        metadata: options.metadata ?? {},
        result: null,
    };
}

export function markRoyalIntent(intent, status, patch = {}) {
    if (!intent) return null;
    const updatedAtMs = patch.updatedAtMs ?? Date.now();
    intent.status = status;
    intent.updatedAtMs = updatedAtMs;
    intent.updatedAt = nowIso(updatedAtMs);
    if (status === 'running' && !intent.startedAtMs) {
        const startedAtMs = patch.startedAtMs ?? updatedAtMs;
        intent.startedAtMs = startedAtMs;
        intent.startedAt = nowIso(startedAtMs);
    }
    for (const [key, value] of Object.entries(patch)) {
        if (['updatedAtMs', 'startedAtMs'].includes(key)) continue;
        intent[key] = value;
    }
    return intent;
}

export function bumpRoyalIntentResume(intent) {
    if (!intent) return null;
    intent.resume = intent.resume ?? { attempts: 0, maxUntil: intent.until ?? null };
    intent.resume.attempts += 1;
    return markRoyalIntent(intent, 'interrupted_resuming', {
        lastResumeAtMs: Date.now(),
    });
}

export function summarizeRoyalIntent(intent) {
    if (!intent) return null;
    return {
        id: intent.id,
        label: intent.label,
        intent: intent.intent,
        source: intent.source,
        actor: intent.actor,
        selectedBots: intent.selectedBots ?? [],
        target: intent.target,
        priority: intent.priority,
        status: intent.status,
        safetyPolicy: intent.safetyPolicy,
        reportPolicy: intent.reportPolicy,
        createdAt: intent.createdAt,
        startedAt: intent.startedAt,
        updatedAt: intent.updatedAt,
        untilIso: intent.untilIso,
        timeoutMins: intent.timeoutMins,
        resumeAttempts: intent.resume?.attempts ?? 0,
        result: intent.result ?? null,
    };
}

export function finishRoyalIntent(bot, intent, result = {}, options = {}) {
    if (!intent) return null;
    const status = finishStatus(result, options);
    markRoyalIntent(intent, status, {
        result: summarizeResult(result, options),
    });
    if (bot) bot._lastRoyalDuty = summarizeRoyalIntent(intent);
    return intent;
}

export function cancelRoyalIntent(bot, reason = 'owner_stop') {
    const intent = bot?._ownerDuty ?? null;
    if (!intent) return null;
    finishRoyalIntent(bot, intent, { success: false, interrupted: true }, { reason });
    if (bot?._ownerDuty === intent) delete bot._ownerDuty;
    return intent;
}

export function getRoyalDuty(bot) {
    return bot?._ownerDuty ?? null;
}

function formatTarget(target) {
    if (!target) return 'none';
    if (typeof target === 'string') return target;
    const bits = [];
    if (target.type) bits.push(target.type);
    if (target.owner) bits.push(`owner=${target.owner}`);
    if (target.player) bits.push(`player=${target.player}`);
    if (target.query) bits.push(`query=${target.query}`);
    if (target.resource) bits.push(`resource=${target.resource}`);
    if (target.item) bits.push(`item=${target.item}`);
    if (target.count) bits.push(`count=${target.count}`);
    if (target.dimensions) {
        const d = target.dimensions;
        bits.push(`size=${d.width}x${d.length}x${d.depth}`);
    }
    return bits.length ? bits.join(' ') : JSON.stringify(target);
}

function formatIntentLine(intent, prefix) {
    const timeout = intent.untilIso ? `until=${intent.untilIso}` : 'until=manual stop/completion';
    return `${prefix}: ${intent.label} | status=${intent.status} | intent=${intent.intent}`
        + ` | target=${formatTarget(intent.target)} | ${timeout}`
        + ` | resumes=${intent.resume?.attempts ?? intent.resumeAttempts ?? 0}`;
}

export function formatRoyalDuty(agent) {
    const bot = agent?.bot ?? agent;
    const current = getRoyalDuty(bot);
    const lines = ['ROYAL DUTY'];
    if (current) {
        lines.push(formatIntentLine(current, 'Current'));
        lines.push(`- safety=${current.safetyPolicy} | report=${current.reportPolicy}`);
    } else {
        lines.push('Current: none');
    }
    if (bot?._lastRoyalDuty) {
        lines.push(formatIntentLine(bot._lastRoyalDuty, 'Last'));
        if (bot._lastRoyalDuty.result)
            lines.push(`- last result: success=${bot._lastRoyalDuty.result.success} timedout=${bot._lastRoyalDuty.result.timedout}`);
    }
    return lines.join('\n');
}
