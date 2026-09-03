import { existsSync, readFileSync } from 'fs';
import { writeJsonAtomic } from '../../utils/atomic_json.js';

const DEFAULT_STATE = {
    version: 1,
    created_at: null,
    current_day: -1,
    laws: [
        {
            id: 'basic_tax',
            enabled: true,
            name: 'Mestni prispevek',
            text: 'Delavci ob koncu sihta prispevajo del uporabnih surovin v mestno zalogo.',
            rate: 0.2,
            storage_region: 'mestna_zaloga',
            applies_to: [
                'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
                'cobblestone', 'stone', 'coal', 'coal_ore', 'iron_ore', 'raw_iron', 'iron_ingot',
                'bread', 'apple', 'carrot', 'potato', 'wheat',
            ],
            due_after_tick: 9000,
            grace_until_tick: 17000,
        },
    ],
    tax_ledger: {},
    culture: {
        memes: [
            {
                id: 'zaloga_je_cast',
                text: 'V tem mestu se javna zaloga ne prazni na skrivaj.',
                theme: 'law',
                origin: 'town',
                strength: 0.65,
                carriers: [],
                last_spread_at: null,
            },
            {
                id: 'petkov_trg',
                text: 'Ko je delo koncano, se novice slisijo na trgu ali v gostilni.',
                theme: 'community',
                origin: 'town',
                strength: 0.55,
                carriers: [],
                last_spread_at: null,
            },
            {
                id: 'pocasi_ni_panike',
                text: 'Pocasi, saj ni panike.',
                theme: 'local_phrase',
                origin: 'tone',
                strength: 0.5,
                carriers: ['tone'],
                last_spread_at: null,
            },
        ],
    },
    proposals: [],
    public_events: [],
    reputations: {},
    social_structure: {
        leaders: [],
        circles: [],
        last_updated_at: null,
    },
    society: {
        last_compliance: null,
        compliance_history: [],
    },
};

export class CivicState {
    constructor(path, log = null) {
        this.path = path;
        this.log = log;
        this.data = this.#load();
        if (!this.data.created_at) {
            this.data.created_at = new Date().toISOString();
            this.save();
        }
    }

    #load() {
        if (!existsSync(this.path)) return structuredClone(DEFAULT_STATE);
        try {
            const saved = JSON.parse(readFileSync(this.path, 'utf8'));
            return deepMerge(structuredClone(DEFAULT_STATE), saved);
        } catch (e) {
            this.log?.warn?.(`civic state corrupt (${e.message}), starting fresh`);
            return structuredClone(DEFAULT_STATE);
        }
    }

    save() {
        writeJsonAtomic(this.path, this.data);
    }

    dayFromBot(bot) {
        return Math.floor((bot?.time?.age ?? 0) / 24000);
    }

    ensureDay(day) {
        if (!Number.isFinite(day)) return;
        if (this.data.current_day === day) return;
        const previous = this.data.current_day;
        this.data.current_day = day;
        this.data.tax_ledger[String(day)] ??= {};
        this.addPublicEvent('new_day', 'town', `Zacel se je mestni dan ${day}.`, { previous_day: previous }, false);
        this.#decayCulture();
        this.save();
    }

    activeLaws() {
        return this.data.laws.filter(law => law.enabled !== false);
    }

    taxLaw() {
        return this.activeLaws().find(law => law.id === 'basic_tax' || law.rate > 0) ?? null;
    }

    taxLedgerFor(day = this.data.current_day) {
        const key = String(day);
        this.data.tax_ledger[key] ??= {};
        return this.data.tax_ledger[key];
    }

    hasPaidTax(npcId, day = this.data.current_day) {
        return Boolean(this.taxLedgerFor(day)[npcId]?.paid_at);
    }

    recordTax(npcId, day, items, value) {
        const ledger = this.taxLedgerFor(day);
        ledger[npcId] = {
            paid_at: new Date().toISOString(),
            items,
            value,
        };
        this.addPublicEvent('tax_paid', npcId, `${npcId} je oddal mestni prispevek (${value} kosov).`, { items, day }, false);
        this.adjustReputation(npcId, { public_trust: 1, respect: 1 }, 'tax_paid', false);
        this.save();
    }

    recordTaxMiss(npcId, day, reason = 'no taxable goods') {
        const ledger = this.taxLedgerFor(day);
        ledger[npcId] = {
            checked_at: new Date().toISOString(),
            items: {},
            value: 0,
            reason,
        };
        this.addPublicEvent('tax_checked_empty', npcId, `${npcId} danes nima prispevka za oddajo.`, { day, reason }, false);
        this.save();
    }

    addPublicEvent(type, actor, text, metadata = {}, persist = true) {
        this.data.public_events.push({
            ts: new Date().toISOString(),
            day: this.data.current_day,
            type,
            actor,
            text: String(text).slice(0, 240),
            metadata,
        });
        this.data.public_events = this.data.public_events.slice(-100);
        if (persist) this.save();
    }

    adjustReputation(npcId, deltas, reason = 'event', persist = true) {
        const rep = this.data.reputations[npcId] ??= {
            public_trust: 50,
            respect: 50,
            notoriety: 0,
            notes: [],
        };
        for (const [k, v] of Object.entries(deltas ?? {})) {
            if (typeof v !== 'number' || !Number.isFinite(v)) continue;
            if (!(k in rep)) continue;
            rep[k] = clamp(rep[k] + Math.max(-10, Math.min(10, v)), 0, 100);
        }
        rep.notes.push({ ts: new Date().toISOString(), reason });
        rep.notes = rep.notes.slice(-8);
        if (persist) this.save();
    }

    chooseMemeFor(npc, knownIds = []) {
        const known = new Set(knownIds);
        const candidates = this.data.culture.memes
            .filter(m => !known.has(m.id))
            .sort((a, b) => Number(b.strength ?? 0) - Number(a.strength ?? 0));
        if (candidates.length === 0) return null;

        const job = npc?.cfg?.job;
        const preferred = candidates.find(m =>
            (job === 'policeman' || job === 'guard' || job === 'steward') && ['law', 'local_phrase'].includes(m.theme));
        return preferred ?? candidates[0];
    }

    adoptMeme(npcId, memeId, persist = true) {
        const meme = this.data.culture.memes.find(m => m.id === memeId);
        if (!meme) return null;
        meme.carriers = Array.from(new Set([...(meme.carriers ?? []), npcId]));
        meme.strength = clamp(Number(meme.strength ?? 0.5) + 0.03, 0, 1);
        meme.last_spread_at = new Date().toISOString();
        if (persist) this.save();
        return meme;
    }

    spreadMeme(memeId, fromId, toId) {
        const meme = this.adoptMeme(toId, memeId, false);
        if (!meme) return null;
        this.addPublicEvent('culture_spread', fromId, `${fromId} je razsiril/a navado: ${meme.text}`, { meme_id: memeId, to: toId }, false);
        this.save();
        return meme;
    }

    contextFor(npcId, limit = 4) {
        const laws = this.activeLaws().map(law => `${law.name}: ${law.text}`);
        const memes = this.data.culture.memes
            .filter(m => (m.carriers ?? []).includes(npcId) || Number(m.strength ?? 0) >= 0.6)
            .sort((a, b) => Number(b.strength ?? 0) - Number(a.strength ?? 0))
            .slice(0, limit)
            .map(m => m.text);
        const events = this.data.public_events.slice(-limit).map(e => e.text);
        const rep = this.data.reputations[npcId];
        const social = this.socialContextFor(npcId);
        return { laws, memes, events, reputation: rep ?? null, social };
    }

    summary() {
        const law = this.taxLaw();
        const ledger = this.taxLedgerFor();
        const paid = Object.entries(ledger)
            .filter(([, v]) => v.paid_at)
            .map(([id, v]) => `${id}:${v.value}`)
            .join(', ') || 'nihce se';
        const strongest = this.data.culture.memes
            .slice()
            .sort((a, b) => Number(b.strength ?? 0) - Number(a.strength ?? 0))[0];
        const leader = this.data.social_structure.leaders?.[0];
        const compliance = this.data.society?.last_compliance;
        const complianceText = compliance
            ? `${compliance.avg_score}% (${compliance.ready}/${compliance.total} OK)`
            : 'se meri';
        return `dan ${this.data.current_day} | zakon: ${law?.name ?? 'brez'} | prispevki: ${paid} | skladnost: ${complianceText} | kultura: ${strongest?.text ?? 'se oblikuje'} | vodja: ${leader?.id ?? 'se oblikuje'}`;
    }

    recordComplianceSnapshot(statuses = [], persist = true) {
        if (!Array.isArray(statuses) || statuses.length === 0) return null;
        const total = statuses.length;
        const ready = statuses.filter(s => s?.ready).length;
        const avg_score = Math.round(statuses.reduce((sum, s) => sum + Number(s?.score ?? 0), 0) / total);
        const blocked = statuses
            .filter(s => s?.blockers?.length)
            .map(s => ({
                id: s.npc_id,
                name: s.name,
                score: s.score,
                blocker: s.blockers[0],
            }))
            .slice(0, 8);
        const snapshot = {
            ts: new Date().toISOString(),
            day: this.data.current_day,
            total,
            ready,
            blocked_count: blocked.length,
            avg_score,
            blocked,
        };
        this.data.society ??= { last_compliance: null, compliance_history: [] };
        this.data.society.last_compliance = snapshot;
        this.data.society.compliance_history ??= [];
        this.data.society.compliance_history.push(snapshot);
        this.data.society.compliance_history = this.data.society.compliance_history.slice(-24);
        if (persist) this.save();
        return snapshot;
    }

    recordBondEvent(fromId, toId, status, reason = 'bond_change') {
        this.addPublicEvent('bond_change', fromId, `${fromId} in ${toId}: odnos je zdaj ${status}.`, {
            from: fromId,
            to: toId,
            status,
            reason,
        });
    }

    updateSocialStructure(npcs = []) {
        if (!Array.isArray(npcs) || npcs.length === 0) return;
        const leaders = npcs
            .filter(npc => npc?.cfg?.id && npc.state?.data)
            .map(npc => ({
                id: npc.cfg.id,
                name: npc.cfg.osebnost?.ime ?? npc.cfg.id,
                score: this.#leadershipScore(npc),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);

        const circles = this.#buildCircles(npcs);
        const oldTop = this.data.social_structure.leaders?.[0]?.id;
        this.data.social_structure = {
            leaders,
            circles,
            last_updated_at: new Date().toISOString(),
        };
        if (leaders[0]?.id && leaders[0].id !== oldTop) {
            this.addPublicEvent('leadership_shift', leaders[0].id, `${leaders[0].name} postaja najbolj vpliven glas v mestu.`, {
                score: leaders[0].score,
            }, false);
        }
        this.save();
    }

    socialContextFor(npcId) {
        const structure = this.data.social_structure ?? {};
        const leader = structure.leaders?.[0] ?? null;
        const circles = (structure.circles ?? []).filter(circle => circle.members.includes(npcId));
        return {
            leader,
            circles,
            leaders: structure.leaders ?? [],
        };
    }

    #decayCulture() {
        for (const meme of this.data.culture.memes) {
            meme.strength = clamp(Number(meme.strength ?? 0.5) * 0.985, 0.05, 1);
        }
    }

    #leadershipScore(npc) {
        const rep = this.data.reputations[npc.cfg.id] ?? { public_trust: 50, respect: 50, notoriety: 0 };
        const traits = npc.state.data.lastnosti ?? {};
        const bonds = Object.values(npc.state.data.social?.bonds ?? {});
        const bondRespect = bonds.length
            ? bonds.reduce((sum, b) => sum + Number(b.respect ?? 50) + Number(b.trust ?? 50) - Number(b.tension ?? 0), 0) / bonds.length
            : 50;
        const roleBonus = ['policeman', 'guard', 'innkeeper', 'steward', 'cook', 'builder'].includes(npc.cfg.job) ? 8 : 0;
        const charisma = (Number(traits.socialnost ?? 50) + Number(traits.pogum ?? 50)) / 2;
        return Math.round(
            Number(rep.public_trust ?? 50) * 0.35 +
            Number(rep.respect ?? 50) * 0.25 +
            bondRespect * 0.2 +
            charisma * 0.15 -
            Number(rep.notoriety ?? 0) * 0.2 +
            roleBonus
        );
    }

    #buildCircles(npcs) {
        const circles = [];
        for (const npc of npcs) {
            const close = Object.entries(npc.state?.data?.social?.bonds ?? {})
                .filter(([, bond]) => ['friend', 'close_friend', 'sweetheart', 'ally'].includes(bond.status))
                .sort(([, a], [, b]) => (Number(b.trust ?? 0) + Number(b.affinity ?? 0)) - (Number(a.trust ?? 0) + Number(a.affinity ?? 0)))
                .slice(0, 4)
                .map(([id]) => id);
            if (close.length === 0) continue;
            const members = Array.from(new Set([npc.cfg.id, ...close])).sort();
            const key = members.join('|');
            if (circles.some(c => c.key === key)) continue;
            circles.push({
                key,
                name: `krog okoli ${npc.cfg.osebnost?.ime ?? npc.cfg.id}`,
                members,
                anchor: npc.cfg.id,
            });
        }
        return circles.slice(0, 6);
    }
}

function deepMerge(base, saved) {
    if (!saved || typeof saved !== 'object') return base;
    for (const [k, v] of Object.entries(saved)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
            base[k] = deepMerge(base[k], v);
        } else {
            base[k] = v;
        }
    }
    return base;
}

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
