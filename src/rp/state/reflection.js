// Evening reflection (diary) + slow personality drift.
// NOTE: 1 in-game day = 20 real minutes, so reflection does NOT run every in-game
// evening (that would be 3 calls/hour/NPC). Default: once per real session —
// at the first sleep after startup, and again at shutdown if anything new happened.
// One cheap-model call: 2-3 sentence diary entry + a state delta (traits capped ±2
// by the state validator — that IS the slow drift).

const REFLECTION_PROMPT = `Si pomožni sistem za NPC-ja v igri. Dobiš opis NPC-ja in kaj je doživel v zadnjem obdobju.
Napiši kratek dnevniški zapis in predlagaj spremembo stanja.
Vrni SAMO veljaven JSON (brez razlage, brez markdown):
{"dnevnik": "<2-3 stavki v prvi osebi, v slovenščini, v slogu NPC-ja — kaj se je zgodilo in kako se počuti>",
 "delta": {"lastnosti": {"<ime_lastnosti>": <celo število -2..2>},
           "mood_danes": "<ena ali dve besedi>",
           "samopodoba": "<1-2 stavka: kdo je ta oseba postala — RAHLO dograduj obstoječo samopodobo na podlagi doživetega, ne izmišljuj na novo. Delo, ki ga opravlja vsak dan, in dogodki naj POČASI puščajo sled (npr. po tednih sekanja se začne imeti za pravega drvarja).>"}}
Lastnosti spreminjaj SAMO, če dogodki to upravičujejo (npr. okraden -> zamerljivost +1; lepi pogovori -> socialnost +1). Večinoma pusti prazno: {"lastnosti": {}}.
Možne lastnosti: postenost, pogum, zamerljivost, nagnjenost_kriminal, socialnost, raziskovalnost.
samopodoba se sme med dvema refleksijama spremeniti le malenkostno.`;

export async function reflect(npc, llm, reason = 'session') {
    const since = npc.state.data.zadnja_refleksija;
    const material = gatherMaterial(npc, since);
    if (!material.trim()) {
        npc.log.info(`reflection (${reason}): nothing new to reflect on, skipping`);
        return false;
    }

    const o = npc.cfg.osebnost;
    const reply = await llm.chat(
        npc.cfg.id,
        REFLECTION_PROMPT,
        [{ role: 'user', content: `NPC: ${o.ime}, dela kot ${o.vloga}. Način govora: ${o.nacin_govora}.\nDosedanja samopodoba: "${npc.state.data.samopodoba}"\nTrenutni mood: ${npc.state.data.mood_danes}.\n\nDoživeto v zadnjem obdobju:\n${material}` }],
        'ozadje'
    );
    if (!reply) { npc.log.warn(`reflection (${reason}): LLM unavailable, skipped`); return false; }

    const parsed = extractJson(reply);
    if (!parsed?.dnevnik) {
        npc.log.warn(`reflection (${reason}): invalid JSON, dropped`);
        return false;
    }
    npc.state.addDiaryEntry(parsed.dnevnik);
    if (parsed.delta) npc.state.applyDelta(parsed.delta, `refleksija:${reason}`);
    npc.log.info(`reflection (${reason}): "${parsed.dnevnik}"`);
    return true;
}

function gatherMaterial(npc, sinceIso) {
    const since = sinceIso ? new Date(sinceIso).getTime() : 0;
    const parts = [];

    const events = npc.eventLog.entries.filter(e => new Date(e.ts).getTime() > since).slice(-10);
    if (events.length) {
        parts.push('Videl/doživel:');
        for (const e of events) parts.push(`- ${e.akter}: ${e.podrobnost ?? e.tip}`);
    }

    const convs = [];
    for (const [who, mems] of Object.entries(npc.state.data.spomini_pogovorov)) {
        for (const m of mems) {
            if (new Date(m.ts).getTime() > since) convs.push(`- pogovor z ${who}: ${m.povzetek}`);
        }
    }
    if (convs.length) { parts.push('Pogovori:'); parts.push(...convs.slice(-6)); }

    const mind = npc.state.data.mind;
    if (mind) {
        parts.push('Notranji nacrt:');
        if (mind.daily_goal) parts.push(`- dnevni cilj: ${mind.daily_goal}`);
        if (mind.social_goal) parts.push(`- socialni cilj: ${mind.social_goal}`);
        if (mind.civic_goal) parts.push(`- skupnostni cilj: ${mind.civic_goal}`);
        if (mind.current_intention) parts.push(`- zadnji namen: ${mind.current_intention}`);
    }
    const civic = npc.civic?.contextFor?.(npc.cfg.id);
    if (civic) {
        if (civic.events?.length) {
            parts.push('Javne novice mesta:');
            for (const e of civic.events.slice(-4)) parts.push(`- ${e}`);
        }
        if (civic.memes?.length) {
            parts.push(`Lokalne navade/fraze, ki jih poznas: ${civic.memes.join(' | ')}`);
        }
    }
    const bonds = Object.entries(npc.state.data.social?.bonds ?? {})
        .sort(([, a], [, b]) => (Number(b.trust ?? 0) + Number(b.affinity ?? 0) - Number(b.tension ?? 0)) -
            (Number(a.trust ?? 0) + Number(a.affinity ?? 0) - Number(a.tension ?? 0)))
        .slice(0, 4);
    if (bonds.length) {
        parts.push('Pomembni odnosi:');
        for (const [id, b] of bonds) {
            parts.push(`- ${id}: ${b.status}, zaupanje ${Math.round(b.trust ?? 50)}, naklonjenost ${Math.round(b.affinity ?? 50)}, napetost ${Math.round(b.tension ?? 0)}`);
        }
    }

    const p = npc.state.data.potrebe;
    parts.push(`Oddelal si svoje delovne ure kot ${npc.cfg.osebnost.vloga}.`);
    parts.push(`Stanje: denar ${p.denar}, sitost ${p.sitost}, družabnost ${p.druzabnost}, utrujenost ${p.utrujenost}.`);
    return events.length || convs.length || mind || civic ? parts.join('\n') : '';
}

function extractJson(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); }
    catch { return null; }
}
