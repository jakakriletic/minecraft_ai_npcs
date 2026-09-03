import { strictFormat } from '../utils/text.js';

export class Ollama {
    static prefix = 'ollama';
    static unavailableUntil = 0;
    static lastUnavailableLogAt = 0;

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.url = url || 'http://127.0.0.1:11434';
        this.chat_endpoint = '/api/chat';
        this.embedding_endpoint = '/api/embed'; // modern endpoint: {model, input} -> {embeddings: [[...]]}
    }

    static markUnavailable(err) {
        const now = Date.now();
        Ollama.unavailableUntil = now + 60_000;
        if (now - Ollama.lastUnavailableLogAt > 60_000) {
            Ollama.lastUnavailableLogAt = now;
            console.warn(`Ollama unavailable (${err?.cause?.code ?? err?.code ?? err?.message ?? err}); suppressing retries for 60s.`);
        }
    }

    async sendRequest(turns, systemMessage) {
        let model = this.model_name || 'sweaterdog/andy-4:micro-q8_0';
        let messages = strictFormat(turns);
        messages.unshift({ role: 'system', content: systemMessage });
        const maxAttempts = 5;
        let attempt = 0;
        let finalRes = null;

        while (attempt < maxAttempts) {
            attempt++;
            console.log(`Awaiting local response... (model: ${model}, attempt: ${attempt})`);
            let res = null;
            try {
                let apiResponse = await this.send(this.chat_endpoint, {
                    model: model,
                    messages: messages,
                    stream: false,
                    ...(this.params || {})
                });
                if (apiResponse) {
                    res = apiResponse['message']['content'];
                } else {
                    res = 'No response data.';
                }
            } catch (err) {
                if (err.message.toLowerCase().includes('context length') && turns.length > 1) {
                    console.log('Context length exceeded, trying again with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage);
                } else if (Date.now() < Ollama.unavailableUntil
                    || err.message === 'Ollama is temporarily unavailable.') {
                    res = 'My brain disconnected, try again.';
                    finalRes = res;
                    break;
                } else {
                    console.warn(err.message);
                    res = 'My brain disconnected, try again.';
                }
            }

            const hasOpenTag = res.includes("<think>");
            const hasCloseTag = res.includes("</think>");

            if ((hasOpenTag && !hasCloseTag)) {
                console.warn("Partial <think> block detected. Re-generating...");
                if (attempt < maxAttempts) continue;
            }
            if (hasCloseTag && !hasOpenTag) {
                res = '<think>' + res;
            }
            if (hasOpenTag && hasCloseTag) {
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            }
            finalRes = res;
            break;
        }

        if (finalRes == null) {
            console.warn("Could not get a valid response after max attempts.");
            finalRes = 'I thought too hard, sorry, try again.';
        }
        return finalRes;
    }

    async embed(text) {
        let model = this.model_name || 'nomic-embed-text';
        let body = { model: model, input: text };
        let res = await this.send(this.embedding_endpoint, body);
        const emb = res?.['embeddings']?.[0] ?? res?.['embedding'];
        if (!emb) throw new Error('Ollama embed: no embedding in response');
        return emb;
    }

    async send(endpoint, body) {
        if (Date.now() < Ollama.unavailableUntil) {
            throw new Error('Ollama is temporarily unavailable.');
        }

        const url = new URL(endpoint, this.url);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!res.ok) throw new Error(`Ollama Status: ${res.status}`);
            return await res.json();
        } catch (err) {
            if (err?.name === 'AbortError' || err?.cause?.code === 'ECONNREFUSED' || err?.code === 'ECONNREFUSED') {
                Ollama.markUnavailable(err);
            }
            throw err;
        } finally {
            clearTimeout(timeout);
        }
    }

    sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "text", text: systemMessage },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                    }
                }
            ]
        });
        
        return this.sendRequest(imageMessages, systemMessage);
    }
}
