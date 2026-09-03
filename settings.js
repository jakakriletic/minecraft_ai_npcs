const settings = {
    "minecraft_version": "1.20.1", // exact target version; startup rejects a mismatched server
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    "port": 25565, // set to -1 to automatically scan for open ports
    "auth": "offline", // or "microsoft"
    "forge_handshake": {
        "enabled": true, // Forge 1.20.1/FML3 login negotiation for the local Horror server
        "networkVersion": 3,
        "ignoreInvalidCommandTree": true, // trusted local Forge server can extend the command argument registry
        "debug": false,
    },

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": false, // opens UI in browser on startup (ročno: http://localhost:8080)
    
    "deterministic_brain": true, // drive play with code (library/brain.js), NOT the LLM. Huge token savings. LLM only for chat.
    "allow_building": false, // ZAČASNO IZKLOPLJENO (delanje vasi/hiš/zaklonišč) na uporabnikovo željo. Nazaj na true za gradnjo. Osnovne uporabne stvari (skrinja/peč/miza) delajo naprej.
    "auto_claim_home": false, // boti si NE zastavijo več doma ~30 s po spawnu. Dom je opcijski (!setHome / !storage); brez njega ni vrvice do baze in si vsak bot sam uredi osebni kamp (svojo skrinjo/mizo/peč), kjer ga prvič rabi. true = staro vedenje.
    "progression_target": "diamond", // stone, iron, or diamond
    "progression_allow_digging": true, // allows bounded mining expeditions for iron/diamonds
    "mining_expedition_interval_minutes": 75, // scheduled deep run (gold/lapis/diamond) roughly every ~4 MC days; !mining forces one now
    "mining_expedition_party": 3, // 2-4 members descend the shared staircase together
    "mining_stranded_seconds": 15, // idle this long well below town level -> force surface recovery
    "mining_stranded_depth": 16, // vertical blocks below town center that count as a cave trap
    "mining_emergency_teleport": true, // last resort after natural cave escape fails twice
    "mining_recovery_teleport_failures": 2,
    "stuck_home_reset_seconds": 300, // 5 min without meaningful movement away from setHome -> teleport home
    "stuck_home_reset_distance": 18, // never reset normal idle inside this distance from setHome
    "navigation_timeout_seconds": 45, // hard limit for one pathfinder trip before retry/fallback
    "navigation_stall_seconds": 9, // replan quickly when position is not changing (small jitter does not count)
    "navigation_no_progress_seconds": 25, // replan loops that move but never get closer to a static goal
    "collect_timeout_seconds": 40, // hard limit for one collect-block target
    "build_step_blocks": 24, // autonomous building yields after this many placed blocks
    "town_build_speed": 1, // 1 = normal; 3-5 = fast testing (scales town build step + cooldown)
    "town_build_step_blocks": 18, // slow city construction: setblock count per builder tick
    "town_max_plot_roughness": 3, // max height difference inside a town plot before the plot is skipped
    "town_plot_search_radius": 8, // small local offset search so plots avoid cutting into hills
    "town_max_foundation_depth": 3, // cap dirt fill depth under command-built town plots
    "town_max_plot_base_delta": 6, // if a plot must jump more than this vertically, use green/decor instead
    "town_road_half_width": 1, // 1 = 3-wide planned town streets
    "town_plaza_shape": "meeting", // meeting = small center + cross arms; frame adds an outline; square restores the old carpet
    "town_plaza_radius": 6, // reach of the central meeting-point roads around shared storage
    "town_plaza_core_radius": 3, // filled center only, so storage/bell/well area is usable without a giant path carpet
    "town_road_interval_minutes": 1, // planned street/plaza cadence before normal building
    "build_command_delay_ms": 75, // throttle batched creative /fill and /setblock commands on Paper
    "suppress_command_feedback": true, // hides spam like "[Bot: Changed the block at ...]" from /setblock and /fill
    "ai_enabled": true, // false disables planner/dialogue model calls; deterministic play still works
    "ai_model": "profile", // profile = use each bot profile; can be set to an explicit provider/model in future
    "ai_max_tokens": 600,
    "ai_memory_summarization_enabled": false, // structured memory compacts locally by default
    "rp_enabled": true, // structured personality, memory, social graph and RP narration
    "rp_memory_max_entries": 180,
    "rp_memory_context_entries": 8,
    "rp_plan_narration": true,
    "rp_spoken_plan_chance": 0.75,
    "planner_mode": "hybrid", // hybrid = group cloud strategy + local Ollama micro-plans
    "society_planner_enabled": true, // one shared cloud-AI plan for the whole kingdom
    "society_planner_interval_minutes": 5, // cloud strategy cadence, shared by all bots
    "society_planner_check_seconds": 60, // each bot cheaply checks whether a shared plan is due
    "society_planner_max_output_tokens": 1800, // enough room for social assignments for ten bots
    "local_planner_enabled": true, // frequent per-bot micro decisions on the local chat model
    "local_planner_interval_minutes": 2,
    "local_planner_jitter_minutes": 1,
    "local_planner_timeout_seconds": 15,
    "local_planner_allow_cloud": true, // VKLOPLJENO: mikro-načrti tečejo v oblaku (OpenAI gpt-5.4-mini), varovano s planner_budget_usd + planner_max_calls_per_window
    "planner_interval_minutes": 12, // legacy single-bot planner cadence
    "planner_jitter_minutes": 3, // legacy spread for single-bot planner calls
    "planner_timeout_seconds": 25, // planner failure must never stall deterministic play
    "planner_budget_window_hours": 10,
    "planner_budget_usd": 2.0, // hard shared ceiling across all bots in one window
    "planner_max_calls_per_window": 900, // raised 2026-07-02: llm_speech + society exchanges share this guard; the USD ceiling above stays the real cap
    "planner_max_output_tokens": 500,
    "kingdom_mode": true, // ten bots share roles, supplies, discoveries and infrastructure
    "kingdom_name": "Kraljestvo",
    "kingdom_heartbeat_seconds": 12, // lightweight cross-process society sync
    "kingdom_social_ai": true, // short LLM conversations between nearby members (profile chat model, planner-budget gated)
    "kingdom_social_interval_minutes": 2, // one society-wide exchange (2-3 lines) may START this often
    "kingdom_roads": false, // ZAČASNO IZKLOPLJENO (gradnja cest/poti) skupaj z allow_building. Nazaj na true, ko spet dovoliš gradnjo.
    "kingdom_road_interval_minutes": 4,
    "kingdom_cleanup": true, // stewards remove only obvious old pathfinder scaffolds
    "kingdom_cleanup_interval_minutes": 10,
    "kingdom_enchanting": true, // one ranger enchants shared equipment with real XP/lapis
    "kingdom_enchant_interval_minutes": 5,
    "kingdom_guardians": true, // rangers prioritize armor, bows and protecting nearby members
    "kingdom_guardian_range": 32, // maximum response/patrol radius around a ranger
    "kingdom_healer_name": "Blaz", // exactly one preferred healer; an online member fills in if Blaz is absent
    "kingdom_healer_range": 32, // healer can select a damaged, visible society member in this radius
    "kingdom_healer_cooldown_minutes": 3, // successful Regeneration I casts are limited to once per 3 minutes
    "kingdom_magician_name": "Nejc", // exactly one preferred magician; an online member fills in if Nejc is absent
    "kingdom_magician_range": 24, // maximum particle-fireball engagement range
    "kingdom_magician_damage": 5, // exact magic damage dealt when the particle fireball lands
    "kingdom_magician_cast_cooldown_seconds": 1.2, // keeps repeated particle commands paced during combat
    "kingdom_role_nameplates": true, // show role in parentheses in tab list/name tag (requires command permission)
    "kingdom_legacy_role_nameplates": "off", // modern 1.20.1 uses vanilla /team suffixes

    // ── ALTERA / PIANO cognition layer ──────────────────────────────────────────
    // Phased effort to make the kingdom NPCs behave like Altera "Project Sid" (PIANO):
    // coherent speech<->action, action-awareness, social goals. Master plan + rationale:
    // ALTERA_PLAN.md (repo root). Future phases stay OFF until their module is merged;
    // built phases may be flipped ON here for in-game testing. If you touch this block,
    // document the change here AND in
    // ALTERA_PLAN.md section 8 (Status table).
    "cognition": {
        "awareness_enabled": true,   // Phase 1: deterministic Action Awareness (roleplay/awareness.js)
        "plan_stall_seconds": 90,     // Phase 1: no progress toward plan target this long -> abandon/replan
        "frustration_ambient": true,  // Phase 1: voice a free templated "this isn't working" line when stuck + a player is near
        "controller_enabled": true,  // Phase 2: Cognitive Controller (roleplay/cognition.js)
        "social_perception_enabled": true, // Phase 3: social_awareness.js perception loop
        "social_goals_enabled": true,      // Phase 4: deterministic recursive social goals (roleplay/social_goals.js)
        // llm_speech IMPLEMENTED 2026-07-02 (cognition.js generateSpokenLine): a slice of
        // autonomous lines is voiced by the profile chat model in-character instead of the
        // template pools. Gated by llm_speech_chance, llm_speech_max_per_hour (per bot) AND
        // the shared planner budget; urgent combat lines stay deterministic; any failure
        // falls back to the template. See ALTERA_PLAN.md §8.
        "llm_speech": true,
        "llm_speech_chance": 0.85,         // share of eligible routine lines voiced by the LLM (raised: chat should be mostly LLM)
        "llm_speech_max_per_hour": 20,     // per-bot cap on LLM-voiced lines
        "speak_cooldown_seconds": 150,     // routine autonomous-speech gap (was hardcoded 300)
        "culture_enabled": true,           // Phase 6: culture.js norm transmission (enabled for test)
        "culture_convergence_rate": 0.06,  // Phase 6: per-interaction scalar norm convergence rate
        "culture_tick_seconds": 60,        // Phase 6: each bot attempts culture convergence at this cadence
        "reflection_enabled": true,        // Phase 7: reflection.js rare belief consolidation (enabled for test)
        "reflection_interval_minutes": 25,  // Phase 7
    },

    // ── DEBUG TELEMETRY ("Sloj A") ───────────────────────────────────────────
    // Per-bot observability for debugging/optimizing the kingdom cognition layer. Each
    // bot writes a live Agent State snapshot (bots/<name>/debug-state.json) and a rotated
    // decision trace (bots/<name>/trace.ndjson). Deterministic, LLM-free, cheap, per-bot
    // files (no cross-process lock). Inspect with: node tools/kingdom-status.js
    // (roleplay/telemetry.js). Master plan: ALTERA_PLAN.md.
    "telemetry": {
        "enabled": true,            // debug cognition/social/mining decisions while testing Altera behavior
        "snapshot_seconds": 5,       // min seconds between Agent State snapshots per bot
        "trace_enabled": true,       // append one line per decision to trace.ndjson
        "trace_max_kb": 512,         // rotate trace.ndjson past this size (keeps one .1 backup)
    },

    "base_profile": "survival", // survival, assistant, creative, or god_mode
    "profiles": [
        "./profiles/Blaz.json",
        "./profiles/Nejc.json",
        "./profiles/Lara.json",
        "./profiles/Zan.json",
        "./profiles/Maja.json",
        // zmanjšano na 5 botov zaradi obremenitve strežnika. Odkomentiraj za več:
        // "./profiles/Ema.json",
        // "./profiles/Jure.json",
        // "./profiles/Kaja.json",
        // "./profiles/Rok.json",
        // "./profiles/Tilen.json",
        // "./profiles/terminator.json", // avtonomni preZivetveni bot (1 sam)
        // "./andy.json",
        // "./profiles/gpt.json",
        // "./profiles/claude.json",
        // "./profiles/gemini.json",
        // "./profiles/llama.json",
        // "./profiles/qwen.json",
        // "./profiles/grok.json",
        // "./profiles/mistral.json",
        // "./profiles/deepseek.json",
        // "./profiles/mercury.json",
        // "./profiles/andy-4.json", // Supports up to 75 messages!

        // using more than 1 profile requires you to /msg each bot indivually
        // individual profiles override values from the base profile
    ],

    "load_memory": false, // load memory from previous session
    "init_message": "Briefly introduce yourself in English (one sentence). Do not use any command.", // sends to all on spawn; play is driven by the deterministic brain, not by a self-prompt goal
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly
    "owner_player": "jakakriletic", // server admin/owner: bots obey him first and answer him with priority (see prompter.js + owner_commands.js)
    "owner_only_commands": true, // only the configured owner may order world-changing actions; other players may still chat and use info queries

    "speak": false,
    // allows all bots to speak through text-to-speech. 
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech. 
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    "render_bot_view": false, // show bot's view in browser at localhost:3000, 3001...

    "allow_insecure_coding": false, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": false, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel"] , // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": -1, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 15, // max number of messages to keep in context
    "num_examples": 2, // number of examples to give to the model
    "max_commands": -1, // let agents inspect an action result and continue/retry multi-step work
    "show_command_syntax": "full", // keep real executed commands visible while gameplay is being verified
    "narrate_behavior": false, // IZKLOPLJENO 2026-07-02: brez "Fighting pig!"/"Picking up item!" spama; chat naj nosi LLM/karakterne replike
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 30, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 0, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.
  
    "log_all_prompts": false, // log ALL prompts to file
};

export default settings;
