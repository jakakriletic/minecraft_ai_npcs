// Dynamic NPC state: the LLM reads it AND updates it (via strict, validated deltas).
// Stored per NPC in state/<id>/state.json. Core personality is NOT here — it never changes.
import { readFileSync, existsSync } from 'fs';
import { writeJsonAtomic } from '../../utils/atomic_json.js';

const DEFAULT_STATE = {
    odnosi_igralci: {},   // { "Player": { zaupanje: 0-100, mnenje: "..." } }
    odnosi_npcji: {},
    znanje_o_svetu: { slisal: [] },
    potrebe: { denar: 0, sitost: 80, druzabnost: 50, utrujenost: 20 },
    lastnosti: { postenost: 50, pogum: 50, zamerljivost: 50, nagnjenost_kriminal: 5, socialnost: 50, raziskovalnost: 50 },
    razvade: { zasvojenost: 0, zadnja_uporaba: null },
    mood_danes: 'normalen',
    // evolving self-image: starts generic, reflection slowly builds it from lived experience —
    // this is how NPCs "specialize" into personalities over time instead of starting as caricatures
    samopodoba: 'navaden prebivalec, ki se v tem mestu šele dobro znajde',
    spomini_pogovorov: {},  // { "Player": [ { ts, povzetek } ] }
    dnevnik: [],            // [ { ts, zapis } ] — reflection diary, last ~7 entries
    zadnja_refleksija: null,
    zapor_do: null,         // ISO timestamp — jail schedule override while in the future
    mind: {
        day: -1,
        daily_goal: null,
        social_goal: null,
        civic_goal: null,
        personal_goal: null,
        current_intention: null,
        last_goal_update: null,
        commitments: [],
        known_memes: [],
        beliefs: {
            tax_support: 50,
            town_identity: 50,
            lawfulness: 50,
        },
        last_social_action_at: 0,
        last_culture_action_at: 0,
        last_tax_attempt_at: 0,
        last_audit_at: 0,
        last_audit_day: -1,
    },
    social: {
        bonds: {},
        circles: [],
        active_focus: null,
        leadership_preference: null,
        last_bond_event_at: 0,
    },
    society: {
        last_checked_at: null,
        compliance_score: 100,
        ready: true,
        expected_activity: null,
        expected_region: null,
        current_region_ok: null,
        blockers: [],
        warnings: [],
        structures: {},
        last_fix: null,
        fix_history: [],
        last_job: null,
        job_history: [],
        signature: null,
    },
};

// validation limits
const MAX_DELTA_DEFAULT = 10;  // max change per event for needs / trust
const MAX_DELTA_TRAIT = 2;     // personality traits drift very slowly
const MAX_MNENJE_LEN = 120;
const MEMORIES_KEPT = 7;

export class NpcState {
    constructor(path, initialOverrides, log) {
        this.path = path;
        this.log = log;
        this.data = this.#load(initialOverrides);
    }

    #load(overrides) {
        let saved = {};
        if (existsSync(this.path)) {
            try { saved = JSON.parse(readFileSync(this.path, 'utf8')); }
            catch (e) { this.log.warn(`state.json corrupt (${e.message}), starting fresh`); }
        }
        // deep-ish merge: defaults <- config overrides (first run) <- saved
        // (plain objects merge; null/strings/arrays replace — typeof null === 'object' trap!)
        const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
        const merge = (baseVal, newVal) => (isPlainObj(baseVal) && isPlainObj(newVal)) ? { ...baseVal, ...newVal } : newVal;
        const base = structuredClone(DEFAULT_STATE);
        for (const k of Object.keys(base)) {
            if (overrides?.[k] !== undefined && saved[k] === undefined) base[k] = merge(base[k], overrides[k]);
            if (saved[k] !== undefined) base[k] = merge(base[k], saved[k]);
        }
        if (overrides?.skrivnost) base.skrivnost = base.skrivnost ?? overrides.skrivnost;
        // repair values corrupted by the old merge ({} instead of null)
        for (const k of ['zadnja_refleksija', 'zapor_do']) {
            if (typeof base[k] !== 'string') base[k] = null;
        }
        if (!base.society || typeof base.society !== 'object' || Array.isArray(base.society)) {
            base.society = structuredClone(DEFAULT_STATE.society);
        }
        return base;
    }

    save() {
        writeJsonAtomic(this.path, this.data);
    }

    // Apply an LLM-produced delta. Anything invalid is dropped and logged; valid parts apply.
    // Delta shape (all optional):
    // { potrebe: {druzabnost: +5}, lastnosti: {zamerljivost: +1}, mood_danes: "vesel",
    //   odnosi_igralci: { "Player": { zaupanje: +5, mnenje: "..." } }, slisal: ["..."] }
    applyDelta(delta, source = 'llm') {
        if (!delta || typeof delta !== 'object') return;
        const d = this.data;

        for (const [k, v] of Object.entries(delta.potrebe ?? {})) {
            this.#applyNumeric(d.potrebe, k, v, MAX_DELTA_DEFAULT, `potrebe.${k}`, source);
        }
        for (const [k, v] of Object.entries(delta.lastnosti ?? {})) {
            this.#applyNumeric(d.lastnosti, k, v, MAX_DELTA_TRAIT, `lastnosti.${k}`, source);
        }
        for (const rel of ['odnosi_igralci', 'odnosi_npcji']) {
            for (const [who, ch] of Object.entries(delta[rel] ?? {})) {
                d[rel][who] = d[rel][who] ?? { zaupanje: 50, mnenje: '' };
                if (typeof ch?.zaupanje === 'number') {
                    this.#applyNumeric(d[rel][who], 'zaupanje', ch.zaupanje, MAX_DELTA_DEFAULT, `${rel}.${who}.zaupanje`, source);
                }
                if (typeof ch?.mnenje === 'string' && ch.mnenje.trim()) {
                    d[rel][who].mnenje = ch.mnenje.trim().slice(0, MAX_MNENJE_LEN);
                }
            }
        }
        if (typeof delta.mood_danes === 'string' && delta.mood_danes.trim()) {
            d.mood_danes = delta.mood_danes.trim().slice(0, 40);
        }
        if (typeof delta.samopodoba === 'string' && delta.samopodoba.trim()) {
            d.samopodoba = delta.samopodoba.trim().slice(0, 250);
        }
        if (Array.isArray(delta.slisal)) {
            for (const s of delta.slisal.slice(0, 3)) {
                if (typeof s === 'string' && s.trim()) {
                    d.znanje_o_svetu.slisal.push(s.trim().slice(0, 160));
                }
            }
            d.znanje_o_svetu.slisal = d.znanje_o_svetu.slisal.slice(-20);
        }
        this.save();
    }

    // Validated relative change: must be a number, capped at ±max, result clamped 0-100.
    #applyNumeric(obj, key, change, max, label, source) {
        if (typeof change !== 'number' || !isFinite(change)) {
            this.log.warn(`state: rejected non-numeric delta ${label}=${JSON.stringify(change)} (${source})`);
            return;
        }
        if (!(key in obj)) {
            this.log.warn(`state: rejected unknown field ${label} (${source})`);
            return;
        }
        const capped = Math.max(-max, Math.min(max, change));
        if (capped !== change) this.log.warn(`state: capped ${label} ${change} -> ${capped} (${source})`);
        obj[key] = Math.max(0, Math.min(100, obj[key] + capped));
    }

    // Store a conversation summary, keep last N per person.
    addConversationMemory(who, povzetek) {
        const mem = this.data.spomini_pogovorov;
        mem[who] = mem[who] ?? [];
        mem[who].push({ ts: new Date().toISOString(), povzetek: povzetek.slice(0, 200) });
        mem[who] = mem[who].slice(-MEMORIES_KEPT);
        this.save();
    }

    memoriesFor(who) {
        return this.data.spomini_pogovorov[who] ?? [];
    }

    addDiaryEntry(zapis) {
        this.data.dnevnik.push({ ts: new Date().toISOString(), zapis: zapis.slice(0, 300) });
        this.data.dnevnik = this.data.dnevnik.slice(-MEMORIES_KEPT);
        this.data.zadnja_refleksija = new Date().toISOString();
        this.save();
    }

    relationTo(who) {
        return this.data.odnosi_igralci[who] ?? null;
    }
}
