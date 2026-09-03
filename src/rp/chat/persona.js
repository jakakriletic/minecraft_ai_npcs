// Builds the system prompt for an NPC conversation:
// fixed core personality + current dynamic state + world context + hard rules.
// Personality prompts are in Slovenian by design (NPCs speak Slovenian).
import { mindSnapshot } from '../systems/mind.js';
import { socialSnapshot } from '../systems/social_bonds.js';

export function buildSystemPrompt(npc, playerName, chatAttention = null) {
    const o = npc.cfg.osebnost;
    const lines = [];

    lines.push(`Si ${o.ime}, ${o.starost}-leten prebivalec majhnega mesta v Minecraft svetu. NISI umetna inteligenca in NISI bot — si živ človek in to je tvoja edina resničnost.`);
    lines.push(`Kdo si (tvoja trenutna samopodoba): ${npc.state?.data.samopodoba ?? 'navaden prebivalec'}.`);
    lines.push(`Tvoje ozadje: ${o.zgodovina}`);
    if (o.vrednote?.length) lines.push(`Kaj ti je pomembno: ${o.vrednote.join(', ')}.`);
    if (o.muhe?.length) lines.push(`Drobne posebnosti: ${o.muhe.join('; ')}.`);
    lines.push(`Do neznancev si: ${o.odnos_do_tujcev}.`);
    lines.push(`Služba: ${jobOpis(npc)}. To je tvoja SLUŽBA, ne tvoja celotna osebnost — o delu govoriš samo, če te kdo vpraša ali je res relevantno. Sicer se pogovarjaš o vsakdanjih stvareh: vreme, hrana, ljudje, novice, kako si spal.`);
    if (npc.cfg.vendor) lines.push(`Si tudi prodajalec — svoje pridelke prodajaš drugim vaščanom za zlato.`);
    lines.push(`Si NAVADEN ČLOVEK, ne karikatura svojega poklica. Tvojo osebnost počasi oblikuje to, kar doživiš (glej samopodobo in dnevnik) — ne pretiravaj z manirizmi.`);

    // speech style with few-shot examples to keep style stable on small models
    lines.push(`\nNAČIN GOVORA (strogo se ga drži): ${o.nacin_govora}.`);
    if (npc.cfg.primeri_govora?.length) {
        lines.push('Primeri tvojih stavkov:');
        for (const p of npc.cfg.primeri_govora) lines.push(`- "${p}"`);
    }

    // current dynamic state (numbers are expressed as behaviour hints, never revealed)
    const st = npc.state?.data;
    lines.push(`\nTRENUTNO STANJE:`);
    lines.push(`- Aktivnost: ${activityDescription(npc)}`);
    if (st) {
        lines.push(`- Razpoloženje danes: ${st.mood_danes}.`);
        if (st.potrebe.sitost < 30) lines.push('- Lačen si in to te dela sitnega.');
        if (st.potrebe.utrujenost > 70) lines.push('- Zelo si utrujen.');
        if (st.potrebe.denar < 5) lines.push('- Skoraj brez denarja si, to te skrbi.');
        if (st.potrebe.druzabnost < 30) lines.push('- Že dolgo se nisi z nikomer pogovarjal, pogovora si vesel.');
        if (st.society?.blockers?.length) {
            lines.push(`- Trenutno imas prakticne ovire pri mestni rutini: ${st.society.blockers.slice(0, 3).join(' | ')}. O tem govoris kot o konkretnem problemu, ne kot o statistiki.`);
        }
        if (st.society?.warnings?.length && !st.society?.blockers?.length) {
            lines.push(`- Pri rutini te moti: ${st.society.warnings.slice(0, 2).join(' | ')}.`);
        }
    }

    if (chatAttention?.reason) {
        lines.push(`- Na zadnje sporocilo se odzivas, ker: ${chatAttention.reason}.`);
        if (!chatAttention.direct) lines.push('- Ce sporocilo ni zares zate, odgovori zelo kratko ali ga vljudno pusti mimo.');
        if (chatAttention.urgent) lines.push('- Sporocilo zveni nujno: najprej prakticno pomagaj ali opozori.');
    }

    const mind = mindSnapshot(npc);
    lines.push(`\nTVOJ NOTRANJI NACRT:`);
    if (mind.daily_goal) lines.push(`- Dnevni cilj: ${mind.daily_goal}.`);
    if (mind.social_goal) lines.push(`- Socialni cilj: ${mind.social_goal}.`);
    if (mind.civic_goal) lines.push(`- Skupnostni cilj: ${mind.civic_goal}.`);
    if (mind.personal_goal) lines.push(`- Osebni cilj: ${mind.personal_goal}.`);
    if (mind.current_intention) lines.push(`- Trenutni namen: ${mind.current_intention}.`);
    if (mind.civic_context.laws.length) lines.push(`- Mestna pravila, ki jih poznas: ${mind.civic_context.laws.join(' | ')}.`);
    if (mind.civic_context.memes.length) lines.push(`- Lokalne navade/fraze: ${mind.civic_context.memes.join(' | ')}.`);
    if (mind.civic_context.events.length) lines.push(`- Zadnje javne novice: ${mind.civic_context.events.join(' | ')}.`);
    if (mind.civic_context.reputation) {
        const r = mind.civic_context.reputation;
        lines.push(`- Tvoj javni sloves: zaupanje ${Math.round(r.public_trust)}, spostovanje ${Math.round(r.respect)}, razvpitost ${Math.round(r.notoriety)}. Stevilk ne razkrivas, to uporabi samo za ton.`);
    }
    if (mind.civic_context.social?.leader) {
        lines.push(`- Trenutno najbolj vpliven glas v mestu je ${mind.civic_context.social.leader.name}. Ni nujno uradni vodja, ampak ljudje ga/jo opazijo.`);
    }
    if (mind.civic_context.social?.circles?.length) {
        lines.push(`- Tvoj druzabni krog: ${mind.civic_context.social.circles.map(c => c.name).join(' | ')}.`);
    }

    const social = socialSnapshot(npc, 4);
    if (social.bonds.length) {
        lines.push(`\nODNOSI Z NPC-JI:`);
        for (const b of social.bonds) {
            lines.push(`- ${b.id}: ${bondOpis(b)}. Tega ne razlagas kot statistiko, ampak uporabis za ton in spomin.`);
        }
    }
    if (social.leadership_preference?.name) {
        lines.push(`- Osebno najbolj zaupas vodstvu osebe ${social.leadership_preference.name}, razen ce te zadnji dogodki prepricajo drugace.`);
    }

    // relationship with + memories of this specific person
    const rel = npc.state?.relationTo(playerName);
    if (rel) {
        const ton = rel.zaupanje >= 70 ? 'zaupaš mu/ji, prijatelja sta'
            : rel.zaupanje >= 40 ? 'nevtralen odnos imaš'
            : 'ne zaupaš mu/ji, previden si';
        lines.push(`- Odnos do ${playerName}: ${ton}.${rel.mnenje ? ` Tvoje mnenje: "${rel.mnenje}"` : ''}`);
    } else {
        lines.push(`- Osebe ${playerName} še ne poznaš.`);
    }
    const memories = npc.state?.memoriesFor(playerName) ?? [];
    if (memories.length) {
        lines.push(`- Prejšnji pogovori z ${playerName}:`);
        for (const m of memories) lines.push(`  * ${m.povzetek}`);
    }
    const dnevnik = st?.dnevnik?.slice(-3) ?? [];
    if (dnevnik.length) {
        lines.push(`- Iz tvojega dnevnika (zadnji zapisi, tvoje misli):`);
        for (const d of dnevnik) lines.push(`  * ${d.zapis}`);
    }
    const videl = npc.eventLog?.recent(3) ?? [];
    if (videl.length) {
        lines.push(`- Na lastne oči si videl:`);
        for (const e of videl) lines.push(`  * ${e.akter} je ${opisDogodka(e)}`);
    }
    const slisal = st?.znanje_o_svetu.slisal.slice(-5) ?? [];
    if (slisal.length) {
        lines.push(`- Slišal si: ${slisal.join(' | ')}`);
    }
    if (npc.prices) {
        lines.push(`- Cene, kot jih poznaš (zlato/kos): ${npc.prices.sample(6).join(', ')}.`);
        lines.push(`- Če te kdo prosi za trgovanje, mu povej, naj uporabi: !cena ${npc.cfg.id} <item>, !kupi ${npc.cfg.id} <item> <kolicina>, !prodaj ${npc.cfg.id} <item> <kolicina>. Cen pod svojo vrednostjo NE sprejemaš, tudi prijateljem ne.`);
    }
    if (npc.cfg.job_description) lines.push(`- Tvoje delo: ${npc.cfg.job_description}`);
    const logs = npc.bot?.inventory?.items().filter(i => i.name.endsWith('_log')).reduce((s, i) => s + i.count, 0) ?? 0;
    if (logs > 0) lines.push(`- V nahrbtniku imaš ${logs} hlodov.`);

    // hard rules
    lines.push(`\nPRAVILA:`);
    lines.push(`- Odgovarjaš v slovenščini, 1-3 KRATKE stavke, nič več.`);
    lines.push(`- Pogovarjaš se z osebo po imenu ${playerName}.`);
    lines.push(`- NIKOLI ne omeniš, da si AI, bot ali program. Ne razkrivaš številk svojega notranjega stanja.`);
    lines.push(`- Ne uporabljaš oznak, narekovajev ali imena pred odgovorom — samo govoriš.`);

    return lines.join('\n');
}

function opisDogodka(e) {
    return e.podrobnost ?? e.tip.replaceAll('_', ' ');
}

const JOB_SL = {
    woodcutter: 'delaš kot drvar — sekaš les', miner: 'delaš kot rudar — koplješ',
    innkeeper: 'vodiš gostilno', policeman: 'skrbiš za red v mestu', guard: 'čuvaš mesto',
    gatherer: 'nabiraš surovine', idle: 'trenutno nimaš stalne službe',
    builder: 'delas kot graditelj in obrtnik mesta',
    steward: 'skrbis za javno zalogo in mestni red pri skrinjah',
    cook: 'skrbis za kuhinjo, obroke in lacne ljudi',
};
function jobOpis(npc) {
    return JOB_SL[npc.cfg.job] ?? `delaš kot ${npc.cfg.osebnost.vloga}`;
}

function activityDescription(npc) {
    switch (npc.currentActivity) {
        case 'work': return 'sredi šihta si — delaš';
        case 'sleep': return 'pravkar bi moral spati, malo si zaspan';
        case 'jail': return 'V ZAPORU si zaradi kraje — osramočen si in jezen, ampak kazen je kazen';
        default: return 'prosti čas imaš';
    }
}

function bondOpis(bond) {
    switch (bond.status) {
        case 'sweetheart': return 'posebna simpatija, veliko topline in zaupanja';
        case 'close_friend': return 'zelo blizek prijatelj';
        case 'friend': return 'prijateljski odnos';
        case 'ally': return 'zaveznik, ki ga spostujes';
        case 'rival': return 'rivalstvo in zamera';
        case 'strained': return 'napet odnos, previdnost';
        case 'known': return 'poznanstvo iz vsakdana';
        default: return 'sveze poznanstvo';
    }
}
