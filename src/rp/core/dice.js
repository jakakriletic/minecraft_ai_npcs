// Daily probability dice — deterministic code, zero LLM.
// P(crime) = base × modifiers(nagnjenost↑, denar↓, sitost↓, zamerljivost↑, zasvojenost↑), hard cap.
export function crimeProbability(npc, cfg) {
    const l = npc.state.data.lastnosti;
    const p = npc.state.data.potrebe;
    const r = npc.state.data.razvade;

    let prob = (cfg.bazna_verjetnost ?? 0.02) * (1 + (l.nagnjenost_kriminal ?? 0) / 25);
    if (p.denar < 10) prob *= 1.5;
    if (p.sitost < 30) prob *= 1.3;
    if ((l.zamerljivost ?? 0) > 70) prob *= 1.2;
    if ((r.zasvojenost ?? 0) > 50) prob *= 1.5;
    return Math.min(prob, cfg.cap ?? 0.2);
}

// One roll; logs the dice so balancing is debuggable.
export function rollCrime(npc, cfg) {
    const p = crimeProbability(npc, cfg);
    const roll = Math.random();
    const hit = roll < p;
    npc.log.info(`dice CRIME: p=${(p * 100).toFixed(1)}% roll=${(roll * 100).toFixed(1)} -> ${hit ? 'DA' : 'ne'}`);
    return hit;
}
