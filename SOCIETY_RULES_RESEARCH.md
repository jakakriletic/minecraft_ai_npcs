# Society rules research for start_boti

Date: 2026-08-04

Goal: make `start_boti` NPCs behave less like loose chatty villagers and more like a real town society: routines, rules, visible needs, job responsibilities, resource obligations, consequences, and social memory that actually changes behavior.

`summon_kingdom` is intentionally out of scope for this note. The target runtime is `rp.js` with `src/rp/config/settings.start_boti.json`.

## Current implementation audit

### What already works

- `src/rp/core/scheduler.js`
  - Simple day loop: `work`, `free`, `sleep`.
  - Supports overnight windows, so guards can work at night.

- `src/rp/systems/needs.js`
  - Tracks `sitost`, `druzabnost`, `utrujenost`, `denar`.
  - Hunger can queue eating or an inn meal.
  - Money mirrors physical gold inventory plus indexed home storage.

- `src/rp/state/civicState.js`
  - Shared town state: laws, tax ledger, public events, reputations, culture memes, social leaders/circles.
  - Basic tax law exists and can record paid/missed tax.
  - Culture memes can spread.

- `src/rp/systems/mind.js`
  - Creates daily, social, civic, and personal goals.
  - Can queue tax payment, tax audits, social visits, culture spreading.
  - Good seed for Altera-style internal state.

- `src/rp/systems/social_bonds.js`
  - Multi-dimensional directed relationships: affinity, trust, respect, romance, tension, familiarity.
  - Social events can cause food sharing, confiding, help offers, rivalry/tension changes.

- `src/rp/systems/economy.js`, `market.js`, `trade.js`
  - Physical gold economy, wages, inn payments, NPC-vendor trading, player-NPC trading.
  - Price beliefs converge after witnessed trades.

- `src/rp/systems/crime.js` and `src/rp/core/events.js`
  - Witness-based property/crime system.
  - Theft can be discovered, reported, investigated, and punished with jail/reputation damage.

### Core weakness

The society layer has intentions, but not enough hard routines and enforceable state machines.

Right now a lot of civic life is represented as:

- `mind.current_intention`
- a public event line
- a relation delta
- a scheduled `pendingAction`

That is good narrative scaffolding, but weak simulation. A rule should have:

1. Preconditions: what structure, item, tool, region, time, social condition is required?
2. A chosen task: exactly what action is being attempted now?
3. A visible blocker: why is it not happening?
4. A retry/backoff policy.
5. A success/failure record in town state.
6. A behavior consequence: speed, willingness, route choice, trade price, reputation, social preference, or job choice changes.

TekTopia is strong because most social rules are backed by physical constraints and per-profession routines, not just dialogue.

## External research: TekTopia lessons

Primary sources used:

- TekTopia wiki home: https://sites.google.com/view/tektopia
- Getting Started: https://sites.google.com/view/tektopia/home/getting-started
- CurseForge project page: https://www.curseforge.com/minecraft/mc-mods/tektopia
- Hunger: https://sites.google.com/view/tektopia/home/mechanics/hunger
- Happiness: https://sites.google.com/view/tektopia/home/mechanics/happiness
- Profession AI: https://sites.google.com/view/tektopia/home/mechanics/profession-ai
- Storage: https://sites.google.com/view/tektopia/home/structures/storage
- Homes: https://sites.google.com/view/tektopia/home/structures/homes
- Guard Post: https://sites.google.com/view/tektopia/home/structures/guard-post
- Mineshaft: https://sites.google.com/view/tektopia/home/structures/mineshaft
- Kitchen: https://sites.google.com/view/tektopia/home/structures/kitchen
- Tavern: https://sites.google.com/view/tektopia/home/structures/tavern
- Thought Icons: https://sites.google.com/view/tektopia/home/mechanics/thought-icons
- Overcrowding: https://sites.google.com/view/tektopia/home/mechanics/overcrowding

TekTopia patterns worth copying:

1. Structure tokens / validation
   - Buildings are not just labels. A home, storage, tavern, kitchen, mineshaft, guard post, etc. must be structurally valid.
   - Our equivalent should be a `town_structures.json` registry with `type`, `region`, `required_blocks`, `capacity`, `valid`, and `blockers`.

2. Permanent tasks
   - TekTopia treats storage, eating, and sleeping as permanent non-toggleable tasks.
   - Our `Npc.tick()` should get a permanent task layer before job/free/society tasks:
     - danger/defense
     - eat
     - medical/recover
     - sleep/rest
     - deposit overflow
     - obey admin command

3. Profession AI task toggles
   - TekTopia jobs are task menus, not one monolithic job.
   - Our equivalent should be per-NPC `ai_filters` in config/state:
     - `woodcutter.chop_oak`, `woodcutter.replant`, `miner.mine`, `miner.smelt`, `guard.patrol_posts`, `cook.craft_bread`, `steward.sort_storage`, etc.
   - These make NPCs tunable without rewriting personality.

4. Hunger costs per action
   - TekTopia does not only decay hunger by time. Actions cost hunger: walking, mining, chopping, fighting, crafting, cooking.
   - Our `needs.js` should expose `applyActionCost(npc, action, amount)` and jobs should call it.

5. Happiness / morale as a real performance variable
   - In TekTopia, unhappy villagers slow down and barely work.
   - Our `druzabnost` and `mood_danes` should become `morale`, with concrete effects:
     - low morale increases work cooldowns and social avoidance
     - high morale improves job throughput
     - tavern/home/social beats restore morale

6. Food variety memory
   - TekTopia remembers recent food and changes happiness reward for repeated food.
   - Our state should track `recent_foods`; cook/steward should prioritize variety, not just any food.

7. Central storage as village heart
   - TekTopia storage is central and used by all villagers for food/supplies.
   - Our `mestna_zaloga` should become authoritative town inventory, not each NPC's partial storage index only.
   - Add shared `src/rp/state/town_inventory.json` rebuilt by stewards and updated after deposits/withdrawals.

8. Visible blockers / thought icons
   - TekTopia shows icons when a villager lacks a tool, torch, food, bed, tavern, etc.
   - Our equivalent can be chat/admin status and JSON telemetry:
     - `bots/start-boti-status.json` or `src/rp/state/town_status.json`
     - `blocked_reason`: `no_food_in_storage`, `no_pickaxe`, `no_bed`, `storage_missing_chest`, `work_region_invalid`
     - `!status` should show blocker, not just mood/inventory.

9. Structure capacity / overcrowding
   - TekTopia penalizes buildings with too little floor space per villager.
   - Our RP regions have only center/radius. Add capacity to structures and avoid sending too many NPCs to the same place for social/free tasks.

10. Guard posts and patrol assignment
   - TekTopia guard posts route guards around actual defense points.
   - Our `guard`/`policeman` presence loop should read `town_structures.guard_posts[]`, claim a post/route, patrol it, and log coverage.

11. Villager-made item provenance
   - TekTopia distinguishes villager-produced goods and makes the economy depend on NPC production chains.
   - Our simple version: mark town inventory records with `source: npc|player|unknown` and let taxes/trade/reputation value NPC-produced goods higher.

## Project Sid / Altera lessons

Primary sources used:

- Project Sid paper: https://arxiv.org/html/2411.00114v1
- Project Sid GitHub: https://github.com/altera-al/project-sid
- Fundamental/Altera blog: https://fundamentalresearchlabs.com/blog/project-sid

Relevant design lessons:

1. Coherence requires a bottlenecked controller.
   - The paper's PIANO architecture uses concurrent modules, but high-level decisions are coordinated through a controller.
   - Our RP side currently has many timers (`needs`, `mind`, `market`, `crime`, `social_bonds`, `liveness`) competing via `pendingAction`.
   - Better: introduce one `society_controller.js` that scores candidate tasks and chooses one. Timers should propose tasks, not directly mutate `pendingAction`.

2. Social awareness must affect action selection.
   - Project Sid's chef food-sharing example is important: social perception should decide who gets limited resources.
   - Our social bonds already affect food sharing and social target choice, but not enough job/resource allocation.
   - Add social influence to:
     - who gets food/tool priority
     - who gets help when blocked
     - who guards whom
     - who pays tax willingly
     - who buys/sells at better prices

3. Collective rules need amendment loops.
   - Project Sid evaluates tax adherence and constitutional changes.
   - Our `civicState.proposals` exists but is unused.
   - Add a lightweight law cycle: propose -> debate/social influence -> vote -> enact -> measure compliance.

4. Specialization should emerge through tracked behavior.
   - We already assign jobs in config, but self-image/reflection should evolve based on repeated task history.
   - Add `skill` and `work_history` per NPC, then let high skill + repeated task reinforce identity and priority.

## Recommended architecture for start_boti

### 1. Town structures registry

New file:

- `src/rp/state/town_structures.json`

New module:

- `src/rp/systems/structures.js`

Shape:

```json
{
  "version": 1,
  "structures": {
    "mestna_zaloga": {
      "type": "storage",
      "region": "mestna_zaloga",
      "capacity": 6,
      "required": ["chest"],
      "recommended": ["crafting_table", "furnace"],
      "valid": true,
      "blockers": []
    },
    "gostilna": {
      "type": "tavern",
      "region": "gostilna",
      "capacity": 8,
      "required": [],
      "recommended": ["chair", "note_block"],
      "valid": true,
      "blockers": []
    }
  }
}
```

Implementation:

- Scan nearby required blocks lazily when a structure is used.
- Store last validation time and blockers.
- `!mesto` should report invalid structures.
- If a structure is invalid, job tasks using it produce a blocker and choose fallback.

### 2. Task proposals instead of direct pendingAction mutation

New module:

- `src/rp/core/task_board.js`

Each subsystem can propose:

```js
{
  id,
  source: 'needs' | 'job' | 'mind' | 'crime' | 'market' | 'social',
  priority,
  urgency,
  preconditions,
  blockers,
  run: async () => {}
}
```

Then `Npc.tick()` does:

1. collect candidates
2. filter impossible tasks
3. apply priority rules
4. run one task
5. record outcome

Priority order:

1. admin command
2. defense / flee
3. hunger below danger threshold
4. sleep / recover
5. crime/jail/reporting
6. job obligations
7. tax/law obligations
8. market/trade
9. social/culture/free-time

This fixes the current hidden race where many timers can set `pendingAction`.

### 3. Rule compliance model

Extend `CivicState` laws:

```json
{
  "id": "basic_tax",
  "enabled": true,
  "type": "tax",
  "text": "...",
  "rate": 0.2,
  "due_after_tick": 9000,
  "grace_until_tick": 17000,
  "applies_to": ["oak_log", "iron_ingot"],
  "enforced_by": ["policeman", "guard", "steward"],
  "compliance": {
    "required": "deposit_items",
    "evidence": "tax_ledger",
    "penalty": { "public_trust": -2, "respect": -1, "notoriety": 1 }
  }
}
```

Add:

- `civicState.complianceFor(npcId, lawId, day)`
- `civicState.recordCompliance(...)`
- `civicState.recordViolation(...)`
- `formatLawStatus()`

Rules should affect behavior:

- high `lawfulness` -> pays early
- low `tax_support` -> pays minimum / delays
- high trust in lawman -> more compliance
- low morale -> more missed tax / crime risk
- repeated enforcement -> reputation and social bonds change

### 4. Real job routines by role

Current:

- `woodcutter` real
- `miner/gatherer` basic real
- `builder/steward/cook/guard/innkeeper` mostly presence

Add modules:

- `src/rp/jobs/steward.js`
  - scan storage
  - create shared `town_inventory.json`
  - sort obvious categories when possible
  - detect low supplies and create public needs
  - remind/tax audit support

- `src/rp/jobs/cook.js`
  - check town food count
  - use wheat/bread/meat if available
  - cook raw food in kitchen furnace
  - keep tavern/gostilna stocked
  - prioritize hungry/high-trust/working NPCs

- `src/rp/jobs/guard.js`
  - claim guard post or patrol route
  - check storage and town hall
  - respond to threat sightings from event bus
  - report coverage in civic state

- `src/rp/jobs/builder.js`
  - first phase: maintain structures, place missing simple utility blocks if carried
  - second phase: use existing schematic/build code only after safe adapter is designed

- `src/rp/jobs/innkeeper.js`
  - host tavern social blocks
  - collect payments
  - boost morale/socialization
  - spread gossip/culture with higher probability

### 5. Needs and morale as hard mechanics

Extend state:

```json
{
  "potrebe": {
    "sitost": 70,
    "druzabnost": 50,
    "utrujenost": 20,
    "morala": 60
  },
  "recent_foods": [],
  "blocked": {
    "reason": null,
    "since": null,
    "count": 0
  }
}
```

Add effects:

- hunger below 20: no work except eat/find food
- morale below 25: job speed multiplier 0.4 and higher chance to go tavern/home
- exhaustion above 85: work blocked except urgent law/defense
- repeated same food reduces morale gain
- tavern/home/socializing restores morale
- damage/crime/witness death lowers morale

### 6. Blocker visibility

New module:

- `src/rp/systems/status.js`

Track:

- current task
- expected location
- blocker reason
- missing item/structure
- last success
- last failure
- compliance state

Expose:

- `!status <npc>` includes blocker
- `!mesto` includes top town blockers
- optional `src/rp/state/town_status.json`

This is the TekTopia "thought icon" equivalent.

### 7. Law proposal / vote cycle

Use existing unused `civicState.proposals`.

Commands:

- `!predlog <besedilo>` or `!law propose <...>`
- `!glasuj <id> za|proti`
- `!zakoni`

Autonomous loop:

- if many NPCs complain about tax/storage/hunger, a high-social NPC can create a proposal
- influencers talk about it
- NPC vote based on:
  - tax_support
  - trust in proposer
  - job
  - recent hardship
  - lawfulness
  - social circle preference

This is how rules become society rules rather than static config.

## Concrete phased roadmap

### Phase 1: Make current rules observable

Files:

- `src/rp/systems/status.js` new
- `src/rp/admin/commands.js`
- `src/rp/systems/mind.js`
- `src/rp/state/civicState.js`

Deliverables:

- `!status` shows current task/blocker/compliance.
- `!mesto` shows invalid structures, tax compliance, low food/storage.
- `mindTick` records why tax/social/culture actions did or did not run.

Why first:

- Without visibility, every later behavior improvement is hard to debug in-game.

### Phase 2: Structure registry and permanent tasks

Files:

- `src/rp/systems/structures.js` new
- `src/rp/npc.js`
- `src/rp/core/storage.js`
- `src/rp/config/locations.json`

Deliverables:

- Validate storage, homes, tavern, kitchen, mine, guard posts.
- `Npc.tick()` runs permanent tasks before job/free tasks.
- NPCs clearly report no bed/no food/no chest/no worksite.

### Phase 3: Hard needs/morale loop

Files:

- `src/rp/systems/needs.js`
- `src/rp/state/npcState.js`
- all real jobs

Deliverables:

- Action-based hunger costs.
- Morale impacts work speed and free-time choice.
- Food variety memory.
- Tavern/home boosts.

### Phase 4: Real steward/cook/guard routines

Files:

- `src/rp/jobs/steward.js`
- `src/rp/jobs/cook.js`
- `src/rp/jobs/guard.js`
- `src/rp/npc.js`
- `src/rp/systems/social_bonds.js`

Deliverables:

- Maja/Ema scan and maintain town inventory.
- Kaja cooks/stocks food.
- Tilen patrols actual guard posts.
- Blaz/Tilen enforce missed tax and storage violations.

### Phase 5: Task board / controller

Files:

- `src/rp/core/task_board.js` new
- `src/rp/npc.js`
- `needs`, `mind`, `market`, `crime`, `social_bonds`

Deliverables:

- Subsystems propose tasks instead of directly setting `pendingAction`.
- One deterministic controller chooses action.
- Cleaner priorities and fewer timer races.

### Phase 6: Law amendment and civic influence

Files:

- `src/rp/state/civicState.js`
- `src/rp/systems/law.js` new
- `src/rp/admin/commands.js`
- `src/rp/systems/social_bonds.js`
- `src/rp/chat/persona.js`

Deliverables:

- Proposals, debates, votes, enacted law changes.
- NPCs obey based on traits and social influence.
- Public compliance metrics.

## Best next implementation step

Start with Phase 1 + a small piece of Phase 2:

1. Add `status.js`.
2. Add blocker fields to `NpcState`.
3. Update `!status` and `!mesto`.
4. Add structure validation for `mestna_zaloga`, `gostilna`, `kuhinja`, `rudnik_sever`, homes.

This gives immediate in-game feedback and makes later routines obvious to debug.

The correct mental model:

> A rule is not real until an NPC can fail to follow it for a visible reason, retry it, get judged for it, and change future behavior because of it.
