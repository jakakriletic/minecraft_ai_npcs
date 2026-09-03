// Direct admin control — NPCs obey COMPLETELY: no trust checks, no LLM, no refusals.
// Runtime only (nothing written to config). Each bot self-filters by target, which
// is either a specific NPC id or "vsi" (everyone). These commands are NOT deduped,
// so "!pridi vsi" makes every bot act.
//
//   !pridi  <npc|vsi>            — come to me and wait here
//   !sledi  <npc|vsi>            — follow me around
//   !ostani <npc|vsi>            — stop and stand still
//   !pojdi  <npc|vsi> <regija>   — go to a known region
//   !domov  <npc|vsi>            — go home and wait
//   !delaj  <npc|vsi>            — go to work now (overrides schedule)
//   !spat   <npc|vsi>            — go sleep now (overrides schedule)
//   !prosto <npc|vsi>            — release all overrides, resume normal life
//   !daj    <npc> <item> <kol>   — give (drop) an item to me
//   !reci   <npc> <besedilo>     — say something in chat
//
// Returns true if THIS bot handled the command (so the dispatcher knows it matched).
export function handleControlCommand(npc, cmd, username, args) {
    const target = (args[0] ?? '').toLowerCase();
    if (target !== 'vsi' && target !== npc.cfg.id) return false; // not addressed to this bot
    const rest = args.slice(1);
    const bot = npc.bot;

    switch (cmd) {
        case '!pridi':
            npc.command = { type: 'pridi', player: username };
            bot.chat('Razumem, pridem.');
            return true;
        case '!sledi':
            npc.command = { type: 'sledi', player: username };
            bot.chat('Ti sledim.');
            return true;
        case '!ostani':
            npc.command = { type: 'cakaj', player: username };
            bot.chat('Ostanem tukaj.');
            return true;
        case '!pojdi': {
            const region = rest[0];
            if (!region || !npc.locations[region]) { bot.chat(`Regije '${region ?? ''}' ne poznam.`); return true; }
            npc.command = { type: 'pojdi', region, player: username };
            bot.chat(`Grem na '${region}'.`);
            return true;
        }
        case '!domov':
            npc.command = { type: 'domov', player: username };
            bot.chat('Grem domov.');
            return true;
        case '!delaj':
            npc.command = null; npc.forcedActivity = 'work';
            bot.chat('Grem delat.');
            return true;
        case '!spat':
            npc.command = null; npc.forcedActivity = 'sleep';
            bot.chat('Grem spat.');
            return true;
        case '!prosto':
            npc.command = null; npc.forcedActivity = null;
            bot.chat('Prav, kakor želiš.');
            return true;
        case '!daj': {
            const item = resolveItem(npc, rest[0]);
            const qty = Math.min(Math.max(parseInt(rest[1]) || 1, 1), 64);
            if (!item) { bot.chat('Kaj naj ti dam?'); return true; }
            npc.command = { type: 'daj', player: username, item, qty };
            return true;
        }
        case '!reci': {
            const text = rest.join(' ').slice(0, 250);
            if (text) bot.chat(text);
            return true;
        }
    }
    return false;
}

function resolveItem(npc, word) {
    if (!word) return null;
    const w = word.toLowerCase();
    const aliasi = npc.settings.economyConfig?.aliasi ?? {};
    return aliasi[w] ?? w;
}
