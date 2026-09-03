// LLM provider layer: two-tier model system with budget guard and cascade fallback.
//   model_pogovori  -> Anthropic Sonnet (player conversations only)
//   model_ozadje    -> Anthropic Haiku  (reflections, summaries, parsing)
//   model_fallback  -> local Ollama     (development default + fallback when API fails / budget exceeded)
// Works fully offline: with provider "ollama" or no API key, no tokens are ever spent.
import { readFileSync, existsSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { getKey, hasKey } from '../../utils/keys.js';
import { writeJsonAtomic } from '../../utils/atomic_json.js';

// USD per 1M tokens (input, output) — for the budget guard
const PRICES = {
    'gpt-5.4': { in: 2.5, out: 15.0 },
    'gpt-5.4-mini': { in: 0.75, out: 4.5 },
    'gpt-5.4-nano': { in: 0.2, out: 1.25 },
    'chatgpt-4o-latest': { in: 5.0, out: 15.0 },
    'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
    'claude-haiku-4-5': { in: 1.0, out: 5.0 },
};

let ollamaUnavailableUntil = 0;
let ollamaLastWarnAt = 0;

function markOllamaUnavailable(log, err) {
    const now = Date.now();
    ollamaUnavailableUntil = now + 60_000;
    if (now - ollamaLastWarnAt > 60_000) {
        ollamaLastWarnAt = now;
        log.warn(`[llm] ollama unavailable (${err?.cause?.code ?? err?.code ?? err?.message ?? err}); suppressing fallback calls for 60s`);
    }
}

export class Llm {
    constructor(config, usagePath, log) {
        this.cfg = config; // settings.json "llm" section
        this.usagePath = usagePath;
        this.log = log;
        this.usage = this.#loadUsage();
        this.anthropic = null;
        this.openaiKey = null;
        const key = process.env.ANTHROPIC_API_KEY ?? config.anthropic_api_key;
        if (key) this.anthropic = new Anthropic({ apiKey: key });
        if (config.openai_api_key) this.openaiKey = config.openai_api_key;
        else if (hasKey('OPENAI_API_KEY')) this.openaiKey = getKey('OPENAI_API_KEY');
        // per-NPC rate limiting
        this.npcLocks = new Map();     // npcId -> Promise (1 concurrent call per NPC)
        this.npcLastCall = new Map();  // npcId -> timestamp (cooldown)
        this.npcDailyCalls = new Map();// npcId -> count
    }

    #loadUsage() {
        const today = new Date().toISOString().slice(0, 10);
        if (existsSync(this.usagePath)) {
            try {
                const u = JSON.parse(readFileSync(this.usagePath, 'utf8'));
                if (u.date === today) return u;
            } catch { /* corrupt -> reset */ }
        }
        return { date: today, cost_usd: 0, calls: 0, tokens_in: 0, tokens_out: 0 };
    }

    #saveUsage() {
        writeJsonAtomic(this.usagePath, this.usage);
    }

    #rolloverDay() {
        const today = new Date().toISOString().slice(0, 10);
        if (this.usage.date !== today) {
            this.usage = { date: today, cost_usd: 0, calls: 0, tokens_in: 0, tokens_out: 0 };
            this.npcDailyCalls.clear();
        }
    }

    budgetExceeded() {
        this.#rolloverDay();
        return this.usage.cost_usd >= this.cfg.daily_budget_usd;
    }

    usageSummary() {
        return `LLM danes: ${this.usage.calls} klicev, ${this.usage.tokens_in}+${this.usage.tokens_out} tok, $${this.usage.cost_usd.toFixed(4)} / $${this.cfg.daily_budget_usd}`;
    }

    // tier: 'pogovori' | 'ozadje'. Returns string or null (all providers failed).
    // Cascade: requested tier -> haiku -> ollama. Dev mode (force_fallback) goes straight to ollama.
    async chat(npcId, systemPrompt, messages, tier = 'pogovori') {
        this.#rolloverDay();

        // 1 concurrent call per NPC
        const prev = this.npcLocks.get(npcId) ?? Promise.resolve();
        let release;
        const gate = new Promise(r => { release = r; });
        const tail = prev.then(() => gate);
        this.npcLocks.set(npcId, tail);
        await prev;

        try {
            // Recheck limits after waiting for the previous call. Otherwise two
            // simultaneous events can both pass the same stale counter/cooldown.
            const calls = this.npcDailyCalls.get(npcId) ?? 0;
            if (calls >= this.cfg.daily_calls_per_npc) {
                this.log.warn(`[llm] ${npcId}: daily call limit (${this.cfg.daily_calls_per_npc}) reached`);
                return null;
            }
            const last = this.npcLastCall.get(npcId) ?? 0;
            if (Date.now() - last < this.cfg.cooldown_ms) return null;

            this.npcLastCall.set(npcId, Date.now());
            this.npcDailyCalls.set(npcId, calls + 1);

            const chain = this.#providerChain(tier);
            for (const provider of chain) {
                try {
                    const text = await this.#call(provider, systemPrompt, messages);
                    if (text) return text;
                } catch (e) {
                    this.log.warn(`[llm] ${provider.name} failed (${e.message}), cascading to next`);
                }
            }
            this.log.error('[llm] all providers failed');
            return null;
        } finally {
            release();
            if (this.npcLocks.get(npcId) === tail)
                this.npcLocks.delete(npcId);
        }
    }

    #providerChain(tier) {
        const ollama = { name: 'ollama', type: 'ollama', model: this.cfg.model_fallback };
        if (this.cfg.force_fallback) return [ollama];
        if (this.budgetExceeded()) {
            this.log.warn(`[llm] BUDGET EXCEEDED ($${this.usage.cost_usd.toFixed(2)}) -> Ollama only`);
            return [ollama];
        }
        if ((this.cfg.provider ?? 'openai') === 'openai') {
            if (!this.openaiKey) return [ollama];
            const requested = {
                name: tier === 'ozadje' ? 'openai-background' : 'openai-conversation',
                type: 'openai',
                model: tier === 'ozadje' ? this.cfg.model_ozadje : this.cfg.model_pogovori,
            };
            const cheap = { name: 'openai-cheap', type: 'openai', model: this.cfg.model_ozadje };
            return tier === 'ozadje' ? [requested, ollama] : [requested, cheap, ollama];
        }
        if (!this.anthropic) return [ollama];
        const haiku = { name: 'haiku', type: 'anthropic', model: this.cfg.model_ozadje };
        if (tier === 'ozadje') return [haiku, ollama];
        return [{ name: 'sonnet', type: 'anthropic', model: this.cfg.model_pogovori }, haiku, ollama];
    }

    async #call(provider, systemPrompt, messages) {
        if (provider.type === 'openai') {
            return await this.#callOpenAI(provider, systemPrompt, messages);
        }

        if (provider.type === 'anthropic') {
            const resp = await this.anthropic.messages.create({
                model: provider.model,
                max_tokens: 300,
                system: systemPrompt,
                messages,
            }, { timeout: 60_000 });
            const tIn = resp.usage?.input_tokens ?? 0;
            const tOut = resp.usage?.output_tokens ?? 0;
            const price = PRICES[provider.model] ?? { in: 3, out: 15 };
            const cost = (tIn * price.in + tOut * price.out) / 1e6;
            this.usage.calls++;
            this.usage.tokens_in += tIn;
            this.usage.tokens_out += tOut;
            this.usage.cost_usd += cost;
            this.#saveUsage();
            this.log.info(`[llm] ${provider.name}: ${tIn}+${tOut} tok, $${cost.toFixed(5)} (dan: $${this.usage.cost_usd.toFixed(4)})`);
            const block = resp.content.find(b => b.type === 'text');
            return block?.text?.trim() ?? null;
        }

        // ollama (local, free)
        if (Date.now() < ollamaUnavailableUntil)
            throw new Error('ollama temporarily unavailable');
        const url = this.cfg.ollama_url ?? 'http://localhost:11434';
        let resp;
        try {
            resp = await fetch(`${url}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: provider.model,
                    messages: [{ role: 'system', content: systemPrompt }, ...messages],
                    stream: false,
                    options: { num_predict: 200 },
                }),
                signal: AbortSignal.timeout(30_000),
            });
        } catch (err) {
            if (err?.name === 'TimeoutError' || err?.cause?.code === 'ECONNREFUSED' || err?.code === 'ECONNREFUSED')
                markOllamaUnavailable(this.log, err);
            throw err;
        }
        if (!resp.ok) throw new Error(`ollama HTTP ${resp.status}`);
        const data = await resp.json();
        this.usage.calls++;
        this.#saveUsage();
        this.log.info(`[llm] ollama (${provider.model}): ok`);
        return data.message?.content?.trim() ?? null;
    }

    async #callOpenAI(provider, systemPrompt, messages) {
        const url = this.cfg.openai_url ?? 'https://api.openai.com/v1/responses';
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.openaiKey}`,
            },
            body: JSON.stringify({
                model: provider.model,
                instructions: systemPrompt,
                input: messages.map(m => ({
                    role: m.role,
                    content: String(m.content ?? ''),
                })),
                max_output_tokens: this.cfg.max_output_tokens ?? 300,
            }),
            signal: AbortSignal.timeout(this.cfg.openai_timeout_ms ?? 60_000),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`openai HTTP ${resp.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
        }
        const data = await resp.json();
        const tIn = data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? 0;
        const tOut = data.usage?.output_tokens ?? data.usage?.completion_tokens ?? 0;
        const price = PRICES[provider.model] ?? PRICES['gpt-5.4-mini'];
        const cost = (tIn * price.in + tOut * price.out) / 1e6;
        this.usage.calls++;
        this.usage.tokens_in += tIn;
        this.usage.tokens_out += tOut;
        this.usage.cost_usd += cost;
        this.#saveUsage();
        this.log.info(`[llm] ${provider.name} (${provider.model}): ${tIn}+${tOut} tok, $${cost.toFixed(5)} (dan: $${this.usage.cost_usd.toFixed(4)})`);
        return extractOpenAIText(data);
    }
}

function extractOpenAIText(data) {
    if (typeof data.output_text === 'string' && data.output_text.trim())
        return data.output_text.trim();

    const chunks = [];
    for (const item of data.output ?? []) {
        for (const part of item.content ?? []) {
            if (typeof part.text === 'string') chunks.push(part.text);
            if (typeof part.output_text === 'string') chunks.push(part.output_text);
        }
    }
    return chunks.join('\n').trim() || null;
}
