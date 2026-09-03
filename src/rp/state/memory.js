// Conversation summarization: when a conversation goes quiet, ask the cheap
// background model for a 1-sentence summary + a strict-JSON state delta.
// The summary feeds future conversations; the delta updates relationships/needs.

const SUMMARY_PROMPT = `Si pomožni sistem za NPC-ja v igri. Dobiš prepis pogovora med NPC-jem in osebo.
Vrni SAMO veljaven JSON (brez razlage, brez markdown), v obliki:
{"povzetek": "<en stavek, kaj se je zgodilo, v slovenščini, iz NPC-jeve perspektive>",
 "delta": {"odnosi_igralci": {"<ime>": {"zaupanje": <celo število -10..10>, "mnenje": "<kratko mnenje o osebi>"}},
           "potrebe": {"druzabnost": <0..10>},
           "mood_danes": "<ena beseda, opcijsko>"}}
Zaupanje spremeni samo, če se je v pogovoru zgodilo kaj pomembnega (prijaznost, žalitev, dogovor, grožnja). Sicer 0.`;

export async function summarizeConversation(npc, llm, playerName, history) {
    const transcript = history
        .map(m => `${m.role === 'user' ? playerName : npc.cfg.osebnost.ime}: ${m.content}`)
        .join('\n');

    const reply = await llm.chat(
        npc.cfg.id,
        SUMMARY_PROMPT,
        [{ role: 'user', content: `NPC: ${npc.cfg.osebnost.ime} (${npc.cfg.osebnost.vloga})\nOseba: ${playerName}\n\nPrepis:\n${transcript}` }],
        'ozadje'
    );
    if (!reply) {
        npc.log.warn(`summary: LLM unavailable, conversation with ${playerName} not summarized`);
        return;
    }

    const parsed = extractJson(reply);
    if (!parsed?.povzetek) {
        npc.log.warn(`summary: invalid JSON from LLM, dropped (${reply.slice(0, 80)}...)`);
        return;
    }
    npc.state.addConversationMemory(playerName, parsed.povzetek);
    if (parsed.delta) npc.state.applyDelta(parsed.delta, `pogovor:${playerName}`);
    npc.log.info(`summary for ${playerName}: "${parsed.povzetek}"`);
}

// Lenient JSON extraction — small models love wrapping JSON in prose/markdown.
function extractJson(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); }
    catch { return null; }
}
