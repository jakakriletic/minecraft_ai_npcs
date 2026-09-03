import { cosineSimilarity } from './math.js';
import { stringifyTurns, wordOverlapScore } from './text.js';

export class Examples {
    constructor(model, select_num=2) {
        this.examples = [];
        this.model = model;
        this.select_num = select_num;
        this.embeddings = {};
    }

    turnsToText(turns) {
        let messages = '';
        for (let turn of turns) {
            if (turn.role !== 'assistant')
                messages += turn.content.substring(turn.content.indexOf(':')+1).trim() + '\n';
        }
        return messages.trim();
    }

    async load(examples) {
        this.examples = examples;
        if (!this.model) return; // Early return if no embedding model

        if (this.select_num === 0)
            return;

        try {
            await this.ensureEmbeddings();
        } catch {
            // The embedding service may just not be up yet (e.g. Ollama still
            // starting). KEEP the model: getRelevant retries lazily and falls back
            // to word overlap per call, so embeddings recover on their own instead
            // of being disabled for the whole session.
            console.warn('Error with embedding model, using word-overlap until it recovers.');
        }
    }

    // Embed any examples that don't have a cached vector yet (no-op when complete).
    async ensureEmbeddings() {
        await Promise.all(this.examples
            .map(example => this.turnsToText(example))
            .filter(turn_text => this.embeddings[turn_text] === undefined)
            .map(turn_text => this.model.embed(turn_text)
                .then(embedding => { this.embeddings[turn_text] = embedding; })));
    }

    async getRelevant(turns) {
        if (this.select_num === 0)
            return [];

        let turn_text = this.turnsToText(turns);
        let sorted = false;
        if (this.model !== null) {
            try {
                await this.ensureEmbeddings();
                const embedding = await this.model.embed(turn_text);
                this.examples.sort((a, b) =>
                    cosineSimilarity(embedding, this.embeddings[this.turnsToText(b)]) -
                    cosineSimilarity(embedding, this.embeddings[this.turnsToText(a)])
                );
                sorted = true;
            } catch { /* embedding service down right now — use word overlap below */ }
        }
        if (!sorted) {
            this.examples.sort((a, b) =>
                wordOverlapScore(turn_text, this.turnsToText(b)) -
                wordOverlapScore(turn_text, this.turnsToText(a))
            );
        }
        let selected = this.examples.slice(0, this.select_num);
        return JSON.parse(JSON.stringify(selected)); // deep copy
    }

    async createExampleMessage(turns) {
        let selected_examples = await this.getRelevant(turns);

        console.log('selected examples:');
        for (let example of selected_examples) {
            console.log('Example:', example[0].content);
        }

        let msg = 'Examples of how to respond:\n';
        for (let i=0; i<selected_examples.length; i++) {
            let example = selected_examples[i];
            msg += `Example ${i+1}:\n${stringifyTurns(example)}\n\n`;
        }
        return msg;
    }
}