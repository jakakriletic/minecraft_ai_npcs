import { cosineSimilarity } from '../../utils/math.js';
import { getSkillDocs } from './index.js';
import { wordOverlapScore } from '../../utils/text.js';

export class SkillLibrary {
    constructor(agent,embedding_model) {
        this.agent = agent;
        this.embedding_model = embedding_model;
        this.skill_docs_embeddings = {};
        this.skill_docs = null;
        this.always_show_skills = ['skills.placeBlock', 'skills.wait', 'skills.breakBlockAt'];
    }
    async initSkillLibrary() {
        const skillDocs = getSkillDocs();
        this.skill_docs = skillDocs;
        if (this.embedding_model) {
            try {
                await this.ensureSkillEmbeddings();
            } catch {
                // The embedding service may just not be up yet (e.g. Ollama still
                // starting). KEEP the model: getRelevantSkillDocs retries lazily and
                // falls back to word overlap per call, so embeddings recover on
                // their own instead of being disabled for the whole session.
                console.warn('Error with embedding model, using word-overlap until it recovers.');
            }
        }
        this.always_show_skills_docs = {};
        for (const skillName of this.always_show_skills) {
            this.always_show_skills_docs[skillName] = this.skill_docs.find(doc => doc.includes(skillName));
        }
    }

    // Embed any skill docs that don't have a cached vector yet (no-op when complete).
    async ensureSkillEmbeddings() {
        await Promise.all((this.skill_docs ?? [])
            .filter(doc => this.skill_docs_embeddings[doc] === undefined)
            .map(doc => {
                const func_name_desc = doc.split('\n').slice(0, 2).join('');
                return this.embedding_model.embed(func_name_desc)
                    .then(embedding => { this.skill_docs_embeddings[doc] = embedding; });
            }));
    }

    getAllSkillDocs() {
        // Callers `await` this; awaiting a plain value is fine.
        return this.skill_docs;
    }

    async getRelevantSkillDocs(message, select_num) {
        if(!message) // use filler message if none is provided
            message = '(no message)';
        let skill_doc_similarities = null;

        if (select_num === -1) {
            skill_doc_similarities = (this.skill_docs ?? [])
            .map(doc_key => ({
                doc_key,
                similarity_score: 0
            }));
        }
        else if (this.embedding_model) {
            try {
                await this.ensureSkillEmbeddings();
                let latest_message_embedding = await this.embedding_model.embed(message);
                skill_doc_similarities = Object.keys(this.skill_docs_embeddings)
                .map(doc_key => ({
                    doc_key,
                    similarity_score: cosineSimilarity(latest_message_embedding, this.skill_docs_embeddings[doc_key])
                }))
                .sort((a, b) => b.similarity_score - a.similarity_score);
            } catch { /* embedding service down right now — use word overlap below */ }
        }
        if (skill_doc_similarities === null) {
            // Word-overlap fallback over the real doc TEXTS. (The old fallback iterated
            // the embeddings map, which is empty exactly when embedding init failed —
            // the LLM then got NO relevant command docs at all.)
            skill_doc_similarities = (this.skill_docs ?? [])
                .map(doc_key => ({
                    doc_key,
                    similarity_score: wordOverlapScore(message, doc_key)
                }))
                .sort((a, b) => b.similarity_score - a.similarity_score);
        }

        let length = skill_doc_similarities.length;
        if (select_num === -1 || select_num > length) {
            select_num = length;
        }
        // Get initial docs from similarity scores
        let selected_docs = new Set(skill_doc_similarities.slice(0, select_num).map(doc => doc.doc_key));
        
        // Add always show docs
        Object.values(this.always_show_skills_docs).forEach(doc => {
            if (doc) {
                selected_docs.add(doc);
            }
        });
        
        let relevant_skill_docs = '#### RELEVANT CODE DOCS ###\nThe following functions are available to use:\n';
        relevant_skill_docs += Array.from(selected_docs).join('\n### ');

        console.log('Selected skill docs:', Array.from(selected_docs).map(doc => {
            const first_line_break = doc.indexOf('\n');
            return first_line_break > 0 ? doc.substring(0, first_line_break) : doc;
        }));
        return relevant_skill_docs;
    }
}
