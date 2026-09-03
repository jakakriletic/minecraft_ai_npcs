# ALTERA_PLAN.md — making the kingdom NPCs behave like Altera / Project Sid

> **STATUS:** living document. Last updated 2026-06-30. Owner: jaka (Slovenian).
> This is the single source of truth for the "make our NPCs like Altera" effort.
> If you change the architecture, update the **Status table** (section 8) in the same commit.

---

## 0. TL;DR (za uporabnika, slovensko)

Cilj: da naši kingdom NPC-ji (10 botov: Blaz/Nejc/Lara/Zan/Maja/Ema/Jure/Kaja/Rok/Tilen,
ki tečejo prek `main.js` / `summon_kingdom.bat`) delujejo bolj kot Altera "Project Sid"
agenti — torej da imajo **usklajen govor in dejanja**, da **sproti opazujejo svoje
napredovanje**, in da iz **modelov drugih agentov sami generirajo socialne cilje**
(to je tisto, kar je pri Alteri pripeljalo do emergentne specializacije).

Dobra novica: velik del te infrastrukture **že obstaja** (osebnosti, graf odnosov z
8 metrikami, večnivojski spomin, hibridni planner). Manjka predvsem **povezovalni
sloj** (Cognitive Controller) + **Action Awareness** + to, da odnosi dejansko
poganjajo planiranje. Plan spodaj je razdeljen na faze; vsaka faza je samostojna in
testabilna v igri. **Ne preskakuj faz.** Vsaka faza ima "acceptance test" in "rollback".

Razvojna pravila ostajajo ista kot vedno: deterministika kjer se da (poceni, brez
LLM), LLM le redko in pod budget guardom, ne spreminjaj ciljne MC verzije (1.20.1), komentarji
v kodi v angleščini, govor NPC-jev v slovenščini.

---

## 1. FOR AI ASSISTANTS — READ THIS FIRST (hard rules)

You are editing a **Mindcraft fork**. Two independent agent systems live here:

| System | Entry | Bots | Models | Altera work applies? |
|---|---|---|---|---|
| **Kingdom** | `main.js` / `summon_kingdom.bat` | 10 player-like bots | local Ollama `gemma3:12b` (chat) + cloud `gpt-5.4-mini` (rare planner) | **YES — this is the target** |
| RP town | `src/rp/rp.js` | Marko/Ana/Tone | local Ollama only | No (separate; has its own gossip/economy) |

**This plan targets the KINGDOM system only** (`src/agent/library/*` + `src/agent/roleplay/*`).

Non-negotiable constraints (violating these has broken the project before — see project memory):

1. **Deterministic-first.** The LLM never drives pathfinding, combat, inventory, mining,
   or movement. It only picks a *bounded* high-level intention that deterministic code
   executes. Every new behavior must default to a deterministic code path; LLM is opt-in
   flavor/direction only.
2. **Budget guard is sacred.** Every cloud LLM call must go through `planner.js`
   `reservePlannerCall()` / the budget window. Never add an un-guarded cloud call.
3. **Per-process bots.** Each bot is its OWN node process (`src/process/init_agent.js`),
   auto-restarted by the mindserver supervisor. Cross-bot state MUST go through a locked
   JSON file via `withNamedLock` (see `container_lock.js`). Never assume a shared
   in-memory singleton across bots.
4. **Don't churn dependencies.** `npm i <new dep>` re-resolves the tree and has bricked
   crafting/protocol before. If a phase needs a new dep, isolate it and clean-reinstall;
   prefer pure-JS in-repo solutions.
5. **MC 1.20.1, offline mode, vanilla/Paper.** Do not change the target version. ASCII bot names only (offline
   rejects š/ž/č). Code comments English; NPC speech Slovenian; user comms Slovenian.
6. **Verify before claiming done.** Static + lint + a boot smoke test. In-game test is the
   user's job (they test after each phase). Never report a phase "working" from code alone.

**Where things live (kingdom):**
- `src/agent/library/brain.js` — the deterministic action loop (the "body"). Self-schedules.
- `src/agent/library/planner.js` — hybrid goal planner (society cloud + local micro). Budget-gated.
- `src/agent/library/society.js` — cross-process shared state (`bots/kingdom.json`): roles, members, resource needs, supply sharing, events.
- `src/agent/roleplay/personality.js` — trait-based personas (courage/altruism/ambition/caution/humor/orderliness) + `influencePlan()`.
- `src/agent/roleplay/social_graph.js` — directed relationships, 8 metrics, in `bots/rp-social-graph.json`.
- `src/agent/roleplay/memory.js` — per-bot memory `bots/<name>/rp-memory.json` (short_term/long_term/world/task + compaction + character_summary).
- `src/agent/roleplay/narrator.js` — turns a plan into a spoken line + memory/social updates.
- `src/agent/roleplay/events.js` — hooks that record plans/actions/deaths/player msgs into memory + relations.

---

## 2. WHAT "LIKE ALTERA" MEANS — PIANO mapping

Altera's agents run the **PIANO** architecture (*Parallel Information Aggregation via
Neural Orchestration*). The parts we care about:

| PIANO concept | What it does in Altera | Our target equivalent |
|---|---|---|
| **Concurrent modules @ different cadences** | cognition / planning / memory / social / speech / motor run in parallel as stateless fns over a shared Agent State | brain loop + social timer + planners + society heartbeat (already multi-cadence) |
| **Shared Agent State** | every module reads/writes one state object | **NEW: unified snapshot** (today state is scattered across 4 files + `agent._brain`/`_plan`) |
| **Cognitive Controller + bottleneck** | filters info (social cues prioritized), makes ONE decision, **broadcasts it so speech & action agree** | **NEW: `cognition.js`** (biggest gap) |
| **Action Awareness** | moment-to-moment self-assessment of state/performance | **NEW: `awareness.js`** (partial today: stuck detector + action memory) |
| **Social Awareness** | interpret social cues, form opinions of others | extend `social_graph.js` + **NEW perception loop** feeding opinions |
| **Goal Generation (recursive social goals)** | agents generate goals from models of *others* → emergent specialization | **NEW: social-goal generator** wired into `planner.js` (today goals come from role+resource+personality only) |
| **Memory across timescales** | conversations/actions/observations retrieved by relevance | `memory.js` exists; add **reflection/consolidation** + relevance retrieval |
| **Culture / norm transmission** | agents adopt & change collective rules; culture spreads | **NEW: `culture.js`** (mirror the price-belief convergence trick from rp.js) |

---

## 3. CURRENT-STATE AUDIT (accurate as of 2026-06-30)

Read this before proposing anything — most "Altera features" already half-exist.

- **Multi-cadence concurrency: ✅ present.** `brain.js attachBrain` runs: action loop
  (self-scheduling 0.2–2.5s), `socialTimer` (4s: greet + stuck check + `social.tickSocial`),
  and `society.attachSociety` heartbeat (12s sync to `kingdom.json`). Planners fire on
  their own intervals inside `brainTick`. **Gap:** no single Agent State; modules read
  scattered sources.

- **Planner / goal generation: ✅ partial.** `planner.js` has two tiers:
  `planSociety()` (rare cloud strategist, assigns all members, budget-gated) and
  `planLocal()` (cheap local micro-plan). Output is a bounded plan
  `{focus, resource, amount, schematic, project, say}` → `normalizePlan` → `influencePlan`
  (personality nudges). **Gap:** goals derive from role + shared resource need + personality.
  They do **NOT** use the social graph or models of other agents → no recursive social goals.

- **Social graph: ✅ present, ❌ unused by planning.** `social_graph.js` tracks 8 directed
  metrics (trust, respect, annoyance, rivalry, friendship, fear, dependency, debt) with
  `recent_interactions`. Updated by `events.js` on praise/criticism/supply-share/commands.
  `relationContext()` is injected into the **conversation** prompt — but **not** into the
  **planner**. **Gap:** relations don't influence what a bot decides to *do*.

- **Memory: ✅ present.** `memory.js` = buckets short_term/long_term/world/task, importance
  1–10, decay, `compactMemory()` with `character_summary` rollup. Retrieval = importance +
  recency. **Gap:** no periodic *reflection* that turns memories into stable beliefs /
  self-image; retrieval is not situation-relevance-aware.

- **Speech: ✅ present, ❌ loosely coupled to action.** `narrator.js narratePlan()` makes a
  spoken line from the *abstract plan* (`plan.say` or a per-persona template). It fires in
  `planner.js applySocietyPlan/planLocal` when a player is near. Free ambient + greetings in
  `brain.js`. **Gap:** the spoken line is bound to the *plan focus*, not to the *concrete
  action actually chosen* by `chooseAction`. A bot can say one thing and do another. There
  is no path for "answer *kaj delaš?* from the real current action."

- **Action awareness: ✅ partial.** `brain.js` has `checkStuck` / `checkStranded` /
  `checkLongStuck` + per-action exponential backoff, and `events.js recordActionResult`
  writes success/frustration into memory. **Gap:** no unified self-model ("am I progressing
  toward my plan's target? am I idle too long? is this plan stalled?") that the controller
  and speech can read.

- **Culture / norms: ❌ absent in kingdom.** Price-belief convergence exists only in the
  separate rp.js town (`src/rp/systems/prices.js`, `market.js`). The kingdom has shared
  *events* and *roles* but no evolving shared *norms/values*.

**Conclusion:** we don't rebuild — we add a thin **Cognitive Controller** that integrates
the existing modules into one coherent decision, plus **Action Awareness**, then wire the
**social graph into goal generation**, and finally add **culture** + **reflection**.

---

## 4. TARGET: the unified Agent State (the PIANO bottleneck)

Introduce one assembled-per-tick snapshot object. It is **derived/read-only** (assembled
from existing sources each cognition tick) — it does NOT become a new persisted store, so
we don't add another file to keep in sync. Modules keep their own persistence; the snapshot
just *gathers* + *filters* (the "bottleneck") so the controller decides over one view.

```
AgentState = {
  self: {                       // from situation()/progression/bot
    name, role, roleLabel, progressionStage,
    health, hunger, position, inventory: {food,wood,stone,iron,...,emptySlots},
    tools: {pickaxe, axe, sword}, combatStyle,
  },
  plan: agent._plan | null,     // current bounded goal {focus,resource,project,say,expiresAt}
  awareness: {                  // NEW, from awareness.js (Phase 1)
    currentAction, msOnAction, makingProgress: bool,
    planTargetRatio: 0..1, idleMs, frustration: 0..1,
    flags: { stuck, planStalled, idleTooLong },
  },
  threats: [ {entity, kind, dist} ],          // from social.findCoordinatedThreat etc.
  society: {                    // filtered from kingdom.json
    members: [ {name, role, action, inventory, needs, position, distance} ],
    resourceNeed: {resource, ratio}, events: lastN, center,
  },
  relations: [ {to, trust, respect, friendship, annoyance, rivalry, debt, ...} ],  // social_graph
  socialOpinions: { name -> {needs, competence, lastSeenDoing} },  // NEW, Phase 3
  norms: {...},                 // NEW, Phase 6 (culture)
  memoryHighlights: [...],      // top-importance + situation-relevant memory entries
  nearbyPlayers: [ {username, distance} ],
}
```

The **bottleneck rule** (Altera prioritizes social cues): when assembling, the controller
elevates (a) a real player talking/near, (b) a member in danger or in need, above routine
resource work. This is mostly already true in `chooseAction` priority order — the controller
makes it *explicit and shared with speech*.

---

## 5. PHASED IMPLEMENTATION PLAN

Each phase: **Goal · Files · LLM? · Settings · Acceptance test · Rollback.**
Phases are ordered by value/effort. Do them in order; each ships independently.

### Phase 0 — Foundations & docs *(no behavior change)*
- **Goal:** this document + code pointers + a settings block so later phases can be toggled.
- **Files:** `ALTERA_PLAN.md` (this); header pointer comments in `brain.js`, `planner.js`,
  `society.js`; add a `cognition` settings block (all flags default `false`/off until their
  phase lands) in `settings.js`.
- **LLM?** No.
- **Acceptance test:** kingdom boots unchanged; no new behavior; lint clean.
- **Rollback:** delete the doc + pointer comments.

### Phase 1 — Action Awareness  *(deterministic, highest value/effort ratio)*
- **Goal:** a cheap self-model so bots notice "I'm progressing / stalled / idle / frustrated"
  and that feeds replanning + speech. Sets up the `awareness` slice of Agent State.
- **New file:** `src/agent/roleplay/awareness.js`.
  - `assessAwareness(agent)` → returns the `awareness` object above. Pure/deterministic:
    diff inventory + position over a short window (store samples on `agent._aware`), compare
    inventory of `plan.resource` vs `plan.amount` for `planTargetRatio`, derive `frustration`
    from the existing `actionBackoff` failure streak + msOnAction, reuse the stuck flags.
  - Fold the existing `checkStuck`/backoff signals in rather than duplicating them.
- **Wire:** call once per `brainTick` (cheap), store on `agent._aware`. Add 2 uses:
  (a) if `planStalled` (ratio not moving for N ms) → mark `agent._plan.completed = true` so a
  new plan is fetched; (b) frustration → unlock a free templated "this isn't working" ambient
  line (extend `brain.js` AMBIENT, throttled, only when a player is near).
- **LLM?** No.
- **Settings:** `cognition.awareness_enabled` (default on once shipped),
  `cognition.plan_stall_seconds` (default 90).
- **Acceptance test:** in-game, give a bot an impossible stockpile target (no trees nearby) →
  within ~90s it abandons/replans instead of flailing; with a player near it occasionally
  voices frustration. No new errors in logs; no extra LLM calls.
- **Rollback:** flag off → `assessAwareness` becomes a no-op; brain behaves as before.

### Phase 2 — Cognitive Controller  *(the core Altera piece)*
- **Goal:** one integrating layer that reads the Agent State snapshot (the bottleneck),
  picks **one coherent intention**, and **broadcasts** it so the concrete action and the
  spoken line agree.
- **New file:** `src/agent/roleplay/cognition.js`.
  - `assembleState(agent)` → the AgentState in §4 (gathers from situation/society/social_graph/
    awareness/threats/memory; applies the social-cue bottleneck prioritization).
  - `decideIntention(agent, state)` → deterministic mapping to an `intention`
    `{ topic, actionBias, speechIntent, socialTarget }`. Mostly mirrors `chooseAction`'s
    priority but produces a *named intention* + a *matching speech intent* (e.g. topic
    `defend` → speechIntent "warn/encourage", topic `help:<name>` → "offer help").
  - `speakIntention(agent, intention)` → ONE place that emits speech, bound to the real
    intention (currently deterministic templates; any future local LLM line must stay
    budget-gated behind `cognition.llm_speech`). Replaces the plan-bound
    `bot.chat(narration.spoken_text)` calls in `planner.js`.
- **Wire:** `brain.js brainTick` calls `cognition.tick(agent, act)` after `chooseAction`
  returns an action and after action-backoff says it can actually run; it stores
  `agent._intention`. `chooseAction` remains authoritative (no Phase-2 biasing yet; any
  future bias must stay below survival/safety order). Speech now flows through
  `speakIntention`; legacy ambient, planner narration, and deterministic social chatter
  stand down or route through the controller while `controller_enabled` is on.
- **Coherence guarantee:** after `chooseAction` returns the concrete action, the controller
  records `{action, intention}` so that if a player asks "kaj delaš?", the conversation layer
  answers from `agent._intention`/current action — not from an LLM guess. (Hook the
  conversation prompt to include `agent._intention`.)
- **LLM?** IMPLEMENTED 2026-07-02: `cognition.llm_speech` voices a slice of routine
  autonomous lines through the profile chat model (in-character prompt with personality +
  current intention + awareness). Gates: per-bot `llm_speech_max_per_hour`, probability
  `llm_speech_chance`, AND the shared planner budget (`reservePlannerCall`). Urgent
  combat/help lines remain deterministic; any model failure/timeout falls back to the
  already-chosen template line, so the gate never blocks or goes silent.
  EXTENDED 2026-07-03: generateOwnerReply flavors the deterministic owner-command
  acknowledgements (owner_commands.js) the same way — personality + roleplay.md scenario,
  planner-budget gated, template fallback — so obeying the owner sounds in character.
- **Settings:** `cognition.controller_enabled`, `cognition.llm_speech` (+ `llm_speech_chance`,
  `llm_speech_max_per_hour`, `speak_cooldown_seconds`).
- **Acceptance test:** a bot that *says* it's going mining is actually mining within the next
  action; asking "kaj delaš?" returns the real current task; survival/safety still preempt
  everything (verify a creeper still interrupts a "build" intention).
- **Rollback:** flag off → speech falls back to current plan-bound narration; `chooseAction`
  ignores `_intention`.

### Phase 3 — Social Awareness perception loop
- **Goal:** each bot maintains a model of the *others* (what they need, what they're good at,
  what they were last seen doing) and updates opinions from observed behavior — not just from
  praise/criticism.
- **New file:** `src/agent/roleplay/social_awareness.js`.
  - `perceive(agent)` (runs on the 4s social timer, deterministic): reads `kingdom.json`
    members + nearby entities; for each known member updates a lightweight opinion
    (`socialOpinions[name] = {needs, competence, lastSeenDoing}`) and nudges `social_graph`
    metrics from *observed* facts (e.g. saw member share → +respect for high-altruism
    personalities; member idle while settlement short on resources → +annoyance for
    high-orderliness personalities; member discovered/built something → +respect).
  - Throttle nudges hard (they're frequent) so relations drift slowly.
- **Wire:** add `socialOpinions` to the Agent State; expose `socialContext(agent)` (compact
  string) for the planner (Phase 4) and conversation.
- **LLM?** No.
- **Settings:** `cognition.social_perception_enabled`, nudge rate caps.
- **Acceptance test:** after a session, `bots/rp-social-graph.json` shows relations that
  evolved from *gameplay* (not only chat); a bot that repeatedly received help shows higher
  `debt`/`dependency` toward the helper. No perf regression on the 4s timer.
- **Rollback:** flag off → perception loop is a no-op; relations update only via `events.js`.

### Phase 4 — Recursive social goal generation  *(the Altera "specialization" driver)*
- **Goal:** bots generate goals from models of others → emergent role differentiation beyond
  the fixed role slots. "Help X (they lack Y)", "out-produce rival Z", "earn the player's
  trust", "cover the gap nobody is filling."
- **Files:**
  - `src/agent/roleplay/social_goals.js` (NEW, deterministic): given Agent State, propose 0–2
    candidate social goals with a priority score from relations + member needs + personality
    (e.g. high altruism → weight "help"; high ambition/rivalry → weight "out-produce";
    high dependency-on-player → weight "impress player"). Generalizes the existing
    `society.findSupplyShare` into goal-driven helping.
  - `planner.js`: inject `socialContext` + top candidate social goal into BOTH the society
    and local planner prompts, and let `normalizePlan` accept a `social` focus that maps to
    deterministic social actions (deliver-to-member, escort, gift). Keep all execution
    deterministic (reuse `society.shareSupplies`, `skills.giveToPlayer`, goto).
- **LLM?** The planner already uses LLM; we only enrich its prompt + add a deterministic
  fallback goal so it works even with LLM off.
- **Settings:** `cognition.social_goals_enabled`, weight knobs.
- **Acceptance test:** over a longer session, bots visibly diverge — e.g. one bot becomes the
  de-facto supplier to a specific other; helping/gifting happens without a player command;
  relations and roles correlate. Budget stays within window.
- **Rollback:** flag off → planner prompt reverts; only fixed-role goals remain.

### Phase 5 — Speech↔action coherence hardening
- **Goal:** remove every remaining path where speech is decoupled from the real action.
- **Files:** `planner.js` (drop direct `bot.chat` of plan narration; plan narration is now
  memory-only), `conversation`/prompt layer (include `agent._intention` + current action +
  awareness summary so chat answers are grounded), `narrator.js` (fallback status answers
  read from `cognition.describeIntention`, not a generic guess).
- **LLM?** Conversation already uses LLM; we only feed it grounded context.
- **Acceptance test:** ask each bot "kaj delaš / kako gre" mid-task → answers match reality;
  no "I finished X" when X didn't succeed (the existing rule in `narrator.js` is enforced
  via awareness).
- **Rollback:** revert routing; narration falls back to focus templates.

### Phase 6 — Culture / norm transmission
- **Goal:** a small set of evolving shared **norms/values** that spread between bots and bias
  behavior — the Altera "agents adopt & change collective rules" result.
- **New file:** `src/agent/library/culture.js` (cross-process, locked, in `bots/kingdom.json`
  under a `culture` key).
  - Norms are scalar beliefs in [0,1], e.g. `sharing_expectation`, `night_caution`,
    `build_density_preference`, plus a free-text "settlement value" line. They converge via
    interaction (mirror `prices.js` belief-convergence math): when two bots interact or one
    observes another, both nudge toward a blended value, weighted by respect/trust.
  - Reflection (Phase 7) can mutate the free-text value.
- **Wire:** norms enter Agent State; `social_goals.js`/`planner` read them as soft biases
  (e.g. high `sharing_expectation` raises the priority of help goals society-wide).
- **LLM?** No for the scalar norms; optional for the free-text value via reflection.
- **Settings:** `cognition.culture_enabled`, convergence rate.
- **Acceptance test:** start bots with divergent norm seeds → over a session norms converge;
  a high `sharing_expectation` run shows measurably more gifting than a low one.
- **Rollback:** flag off → norms ignored by planning.

### Phase 7 — Reflection / belief consolidation (long-timescale memory)
- **Goal:** the slow loop — periodically (rare, budget-gated) turn accumulated memories +
  relations + events into stable beliefs: an updated `character_summary`, a self-image line
  (the kingdom analogue of rp.js `samopodoba`), and norm/value updates.
- **Files:** `src/agent/roleplay/reflection.js` (NEW). One LLM call per bot at a long interval
  (e.g. 20–30 min; local model preferred, cloud path through the planner budget guard),
  summarizing memory.js + social_graph into a short belief update written back to
  `memory.js character_summary` and `culture.js`.
- **LLM?** Yes — rare, budget-gated, local model preferred.
- **Settings:** `cognition.reflection_enabled`, `cognition.reflection_interval_minutes`.
- **Acceptance test:** after ~2 reflection cycles a bot's `character_summary` reflects what it
  actually did/experienced; budget window respected.
- **Rollback:** flag off → no reflection; memory still compacts as today.

### Phase 8 — In-game diagnostics & tuning loop
- **Goal:** expose the new cognition/culture/reflection state through cheap chat commands so
  in-game testing can verify what changed without opening JSON files.
- **Files:** `src/agent/commands/queries.js`, `src/agent/library/culture.js`,
  `src/agent/roleplay/reflection.js`, parent `UKAZI.md`.
- **LLM?** No.
- **Settings:** no new flags; these commands read existing `cognition.*` flags and state.
- **Acceptance test:** `!culture` shows shared norms/value/convergence, `!reflection` shows
  per-bot self-image/last-next reflection, and `!ukazi` lists both.
- **Rollback:** remove the two query commands; all behavior remains unchanged.

---

## 6. CROSS-CUTTING DESIGN NOTES

- **Cadence budget.** Cognition tick rides the existing brain loop / 4s social timer — do NOT
  add new timers per bot (10 processes × timers adds up). Deterministic assembly must be cheap
  (no block scans; reuse cached `world.getInventoryCounts`, `kingdom.json` cache).
- **One speech gate.** After Phase 2 there should be exactly one function that calls
  `bot.chat` for autonomous (non-command, non-conversation) speech: `cognition.speakIntention`.
  Greetings/ambient route through it too. This kills "say one thing, do another."
- **State is derived, not a 5th file.** AgentState is assembled per tick from existing stores.
  Only *new persistent* stores in this plan: `socialOpinions` (can live inside rp-memory.json
  `social` bucket) and `culture` (kingdom.json key or its own locked file). Don't multiply files.
- **Personality stays the lever.** All new scoring (social goals, norm weights, frustration
  thresholds) must read the existing `personality.js` traits so bots differ. Reuse, don't add a
  parallel trait system.
- **Backwards compatible.** Every phase is behind a `cognition.*` flag, default off until the
  user has tested it in-game. Shipping a phase = flip its flag default to on after the user OKs.

---

## 7. HOW WE WORK THROUGH THIS (procedure for each phase)

1. **Confirm scope** of the phase with the user (Slovenian). Restate the acceptance test.
2. **Implement deterministically first.** Write the new module with a thorough English JSDoc
   header that (a) states its PIANO role, (b) links back to this doc + phase number,
   (c) lists its inputs/outputs in Agent State terms.
3. **Add the `cognition.*` settings flag(s)**, default OFF.
4. **Wire minimally** into `brain.js`/`planner.js` behind the flag.
5. **Static-verify:** `node --check` on touched files, run the project linter, and a boot
   smoke test (`summon_kingdom.bat` for ~1 min, watch logs for errors / ECONNREFUSED-only).
   Do NOT spend cloud budget to verify; brain runs LLM-free at boot.
6. **Hand to user for in-game test** with the flag ON. User reports back.
7. **On OK:** flip the flag default to ON, tick the Status table below, write/update a project
   memory note, move to next phase.
8. **On problems:** the flag-off rollback must restore prior behavior with zero edits.

---

## 8. STATUS TABLE (living checklist — keep this current)

| Phase | Name | State | Flag | Files | Notes |
|---|---|---|---|---|---|
| 0 | Foundations & docs | **DONE 2026-06-30** | — | this doc, pointers, settings block | created |
| 1 | Action Awareness | **BUILT — awaiting in-game test** (2026-06-30) | `cognition.awareness_enabled` (enabled for test) | `roleplay/awareness.js`, `library/brain.js`, `settings.js` | deterministic; flag-on test, then mark DONE |
| 2 | Cognitive Controller | **BUILT — awaiting in-game test** (2026-06-30; llm_speech implemented 2026-07-02) | `cognition.controller_enabled`, `cognition.llm_speech` (both enabled for test) | `roleplay/cognition.js`, `library/brain.js`, `library/planner.js`, `library/social.js`, `roleplay/narrator.js` | derives intention from the real chosen action after backoff (safety order stays authoritative); single speech gate for autonomous lines; grounds chat. Also delivers most of Phase 5. llm_speech: budget-gated in-character LLM lines with template fallback; generateOwnerReply (2026-07-03) flavors owner-command acks the same way; society chat is model-agnostic 2-3 line exchanges via kingdom state. |
| 3 | Social Awareness loop | **BUILT — awaiting in-game test** (2026-06-30) | `cognition.social_perception_enabled` (enabled for test) | `roleplay/social_awareness.js`, `library/brain.js`, `roleplay/cognition.js`, `roleplay/narrator.js` | in-memory opinion model + throttled social-graph nudges from observed behavior; uses real progression stages, drops stale/offline opinions, feeds chat (socialContext) + Agent State (socialOpinions). Sets up Phase 4. |
| 4 | Social goal generation | **BUILT — awaiting in-game test** (2026-06-30) | `cognition.social_goals_enabled` (enabled for test) | `roleplay/social_goals.js`, `library/planner.js`, `library/brain.js`, `roleplay/cognition.js` | deterministic goal generator from models of others (help/out-produce/impress/cover-gap); normalizes need labels across Phase 3/4; ranged unprompted helping+gifting as the LLM-off fallback from iron stages onward; `social` planner focus + prompt enrichment; the specialization driver |
| 5 | Speech↔action coherence | **BUILT — awaiting in-game test** (2026-06-30) | (uses P2 flags) | `library/planner.js`, `roleplay/cognition.js`, `roleplay/narrator.js` | planner plan speech is memory-only; autonomous speech stays behind `cognition.speakIntention`; fallback/status chat answers from real current intention/action |
| 6 | Culture / norms | **BUILT — awaiting in-game test** (2026-06-30) | `cognition.culture_enabled` (enabled for test) | `library/culture.js`, `library/brain.js`, `library/planner.js`, `roleplay/cognition.js`, `roleplay/social_goals.js`, `roleplay/events.js`, `settings.js` | per-member scalar norms in `kingdom.json.culture`; nearby/coop interactions converge norms; `sharing_expectation` biases social goals and planner prompt |
| 7 | Reflection | **BUILT — awaiting in-game test** (2026-06-30) | `cognition.reflection_enabled` (enabled for test) | `roleplay/reflection.js`, `library/brain.js`, `library/planner.js`, `library/culture.js`, `settings.js` | first tick schedules per bot; later rare local reflection updates `character_summary`/`self_image`; cloud fallback is planner-budget guarded; can update culture settlement value/norms |
| 8 | In-game diagnostics & tuning | **BUILT — awaiting in-game test** (2026-06-30) | — | `commands/queries.js`, `library/culture.js`, `roleplay/reflection.js`, parent `UKAZI.md` | adds `!culture` and `!reflection` so the new long-timescale state can be checked from chat without opening JSON |

---

2026-07-01 tuning note: Phase 3/4 were adjusted for visible in-game bonding. Social
awareness now favors mutual positive nudges from nearby/shared/helpful work and slows
idle-annoyance; social goals now include `check_in` actions that walk to a member and
write mutual trust/friendship, and social actions run before routine role work so they
are not starved by endless farming/mining/building. `!relations` and telemetry expose
relationship statuses and a compact social-structure summary.

2026-07-02 (4) "deep mining expeditions" note: the cooperative expedition system in
library/mining.js was dead code — it required role 'miner', and the 5-bot role
assignment (capacities steward1/builder2/farmer2/miner4/ranger1 filled in order) never
produces a miner. Changes: (a) planExpeditionAction is role-aware instead of
miner-only — members always continue, miners join any dig, other roles join deep or
commanded parties; (b) gold/lapis joined DEEP_TARGETS (1.20.1 targets Y-16/Y0 — provisioned,
long-TTL runs like diamonds/redstone at Y-54); (c) scheduled treasure runs: `expeditionDue()` fires every
`mining_expedition_interval_minutes` (75), target picked by settlement scarcity
(pickDeepTarget: diamond→gold→lapis); (d) owner `!mining [target]` (owner_commands.js)
→ `startCommandedExpedition` drafts a 2-3 member crew immediately (lock-deduped) and
forces a society replan; (e) brain slot 6d runs expedition work above
progression/role work so the party stays together; (f) planner RESOURCES now include
diamond, and non-miner deep-ore assignments survive normalizePlan while an expedition
is open or due; (g) agent.js routes owner pseudo-commands (!order/!ukaz/!mining) down
the owner path — containsCommand() would otherwise feed them to the regular command
parser, which rejects them (this had silently broken !order). Also new owner
chest duties (chestView/chestTake): the bot nearest to the owner opens the chest
NEXT TO THE OWNER and reports/withdraws items (EN+SLO item aliases).

2026-07-02 (3) "AI big-picture control + English-only" note: (a) plans gained a
`priority` field — the society planner may mark ≤2 members "high", which runs their
plan focus BEFORE progression/role work (new chooseAction slot 6c); survival, recovery,
food, missing tools and defense still preempt, per the PIANO safety contract; (b) the
old slot-9 late-game-only gate is gone — normal-priority plans now engage whenever role
work leaves room, so the planner actually steers all game stages; (c) new owner command
`!order <text>` (owner_commands.js) stores a binding `ownerDirective` in kingdom state,
which societyPrompt/planLocal inject as SUPREME COMMANDER context and which forces an
immediate society replan (`planner.forceSocietyReplan`); deduped so ten bots produce one
write/reply; (d) ALL bot speech is English now: speech pools, ambient lines, greetings,
templates, LLM line/exchange prompts, role labels/nameplates, event texts, profile
conversing prompts, and the owner directive pins replies to English.

2026-07-02 (2) "Altera parity for dialogue" note: per the PIANO paper (arXiv:2411.00114),
agents' TALKING should read the same state the other modules write. Wired: (a)
`buildRoleplayContext` now also injects culture norms + settlement value (Phase 6),
the reflected `self_image` (Phase 7) and the last 3 settlement events, so player chat
draws on every long-timescale module; (b) society exchanges (`generateSocietyLine`)
carry the speaker's RELATION to the mate (social graph status), the last observation
of them (Phase 3 opinions), a sharing-norm hint and an occasional third-member mention
(gossip → meme/norm transmission); (c) exchanges are written into rp-memory
(`society_chat` entries) and completed exchanges nudge mutual friendship/trust
(`updateMutual`) — conversations now build real shared history, PIANO-style; (d)
`narrate_behavior` off + `llm_speech_chance` 0.85 so chat is carried by in-character
LLM lines instead of "Fighting X!" mode spam.

2026-07-02 "give them a voice" note (Phase 2 extension + society chat): the personality
layer existed but almost never spoke through an LLM. Three changes: (1) `cognition.llm_speech`
implemented (see §5 Phase 2) — a budget-gated slice of routine autonomous lines is voiced
by the chat model in character; (2) bot-to-bot society chat in `library/social.js` is now
model-agnostic (was: only `ollama/*` profiles with the controller OFF — i.e. never in the
current config) and runs short 2-3 line EXCHANGES: the initiator posts
`kingdom.json.socialExchange {from,to,text,turnsLeft}`, the addressee's process takes it and
replies in character (`society.postSocialExchange`/`takeSocialExchangeFor`); both sides mark
the controller speech gate so template lines don't pile on top; (3) the owner directive in
`models/prompter.js` now mirrors the owner's language (Slovenian!) and only reaches for
commands when the owner asks for an action — plain chat gets an in-character conversational
reply. Telemetry traces additionally record a `reason` for failed actions (brain.js →
telemetry.recordDecision).

## 9. EXPLICITLY OUT OF SCOPE (for now)

- Changing the rp.js town (Marko/Ana/Tone) — it has its own social/economy stack.
- 1000-agent scale, separate Minecraft servers, or PIANO's neural-orchestration internals —
  we approximate the *behavioral* results, not the research infra.
- New PvP/mining/town libraries — see prior research notes in project memory (`NACRTOVANJE_MESTA.md`
  etc.); don't re-litigate those.
- Replacing the deterministic brain with LLM-in-the-loop — that's the opposite of our design.
