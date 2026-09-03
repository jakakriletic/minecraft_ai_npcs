// Price beliefs: each NPC's evolving idea of what items are worth (in nuggets).
// Seeded from the town's base price list; updated by observation:
//   - every transaction it makes or witnesses pulls belief toward the seen price
//     (exponential moving average: belief = (1-a)*belief + a*observed)
//   - rejected offers are weaker directional signals
// Stored per NPC in state/<id>/price_beliefs.json.
import { readFileSync, existsSync } from 'fs';
import { writeJsonAtomic } from '../../utils/atomic_json.js';

export class PriceBeliefs {
    constructor(path, baseCenik, alpha, log) {
        this.path = path;
        this.base = baseCenik;
        this.alpha = alpha ?? 0.2;
        this.log = log;
        this.beliefs = {};
        this.recent = []; // last few observed transactions — gossip material
        if (existsSync(path)) {
            try { this.beliefs = JSON.parse(readFileSync(path, 'utf8')); } catch { /* fresh */ }
        }
    }

    #save() {
        writeJsonAtomic(this.path, this.beliefs);
    }

    // Current belief; falls back to base price; null if item completely unknown.
    get(item) {
        if (this.beliefs[item] !== undefined) return this.beliefs[item];
        if (this.base[item] !== undefined) return this.base[item];
        return null;
    }

    knows(item) { return this.get(item) !== null; }

    // A transaction happened (own or witnessed) at unitPrice.
    observe(item, unitPrice, source = 'lastna') {
        const prev = this.get(item) ?? unitPrice;
        const next = Math.max(0.1, (1 - this.alpha) * prev + this.alpha * unitPrice);
        this.beliefs[item] = Math.round(next * 100) / 100;
        this.recent.push({ item, unit: unitPrice, ts: Date.now() });
        this.recent = this.recent.slice(-5);
        this.#save();
        this.log.info(`price belief ${item}: ${prev} -> ${this.beliefs[item]} (videl ${unitPrice}, ${source})`);
    }

    // Rejected offer: weak directional nudge. dir +1 = "they wanted more", -1 = "nobody pays that much".
    signalRejected(item, dir) {
        const prev = this.get(item);
        if (prev === null) return;
        const next = Math.max(0.1, prev * (1 + 0.05 * Math.sign(dir)));
        this.beliefs[item] = Math.round(next * 100) / 100;
        this.#save();
    }

    // A few beliefs for the persona prompt (items the NPC plausibly talks about).
    sample(n = 5) {
        const all = { ...this.base, ...this.beliefs };
        return Object.entries(all).slice(0, n).map(([k, v]) => `${k}≈${v}`);
    }
}
