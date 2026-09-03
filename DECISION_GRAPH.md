# Dynamic decision graph

The deterministic brain uses a hybrid goal architecture rather than a linear
progression chain or one monolithic decision tree.

## Flow

1. Hard safety checks preempt everything: recovery, healing, combat, starvation,
   active player duties and an active mining retreat/expedition. Reactive modes and
   entity events publish expiring requests into the same brain-owned safety queue;
   they do not start competing ActionManager actions in deterministic-brain mode.
2. Independent providers publish currently applicable candidates:
   `environment`, `milestone`, `ai`, `society`, `maintenance` and `ambient`.
3. `decision_graph.js` first enforces hard source tiers (`safety > command >
   autonomous`), then scores candidates inside a tier from source bias, utility,
   urgency, unlock value, estimated remaining path cost, decaying failure penalty,
   bounded actionable aging and a short commitment bonus.
4. The highest actionable provider creates an ordinary ActionManager action.
5. Actions report `done`, `progress`, `waiting`, `blocked`, `failed` or
   `interrupted`. Waiting on an asynchronous dependency and safety interruption do
   not count as failure. Real failures and blockers receive separate exponential
   backoff and a decaying score penalty. The next candidate may run while that
   action is cooling down.

Player action commands still execute immediately. They are recorded as
`command` goals for a unified status/history view instead of being delayed until
the next autonomous brain tick.

## Stability guarantees

- Unlocked actionable milestones gain a bounded waiting-time bonus after 30 seconds
  and reach their maximum bonus after five minutes. Every actual attempt restarts
  aging, including waits and failures, so an impossible milestone cannot monopolize
  autonomous work. Aging cannot cross the safety or command tiers.
- Commitment lasts at most 45 seconds and applies only after a non-failed,
  non-interrupted selection.
- Candidate cooldowns start through `onSelected`/`onStart`, after the action has
  passed applicability and backoff checks. Merely inspecting or materializing a
  provider does not consume its cooldown.
- A reactive request never interrupts a player command. Requests with the same
  semantic goal are coalesced, so an emergency-food mode cannot interrupt an
  already-running food recovery and combat observers cannot enqueue duplicate
  attacks for one decision.
- A legacy action that resolves with `undefined` counts as successful only when
  inventory, position, health, food, experience, game mode or plan state changed.
  Explicit boolean action results remain the preferred success contract.
- Repeated milestone failures are persisted in `progression.json`; the runtime
  decision state and persistent history both decay after ten minutes so repaired
  paths and newly available resources can be reconsidered.
- Partial milestone work is persisted as `progress`, while a safety interruption is
  persisted as `interrupted`; neither inflates the consecutive-failure counter.
- Three consecutive non-interrupted failures abandon an AI-authored plan so a bad
  plan cannot occupy the bot until its full expiry.
- Every selected action, including hard-policy actions, receives decision metadata
  with a source and human-readable reason. `!decisions` and telemetry expose the
  score breakdown, waiting bonus and outcome.

## Static milestone DAG

Milestones describe capability unlocks, not a required sequence. For example,
after `stoneTools`, the bot may independently work on `homestead`,
`starterUtility` or `ironTools`. After `ironTools`, utility, armor and diamond
branches can be open together. Completion remains persistent in
`bots/<name>/progression.json`.

Each milestone declares:

- `requires`: prerequisite milestone IDs;
- `targets`: progression targets where it is enabled;
- base `utility`: its default value before live context is added;
- an action factory: deterministic execution for that capability.

At runtime progression also estimates material/path cost and direct unlock value.
Gear tiers consume partial stock immediately (for example, one affordable armor
piece) instead of waiting for the entire tier. Ore shortages become per-bot demands
inside the shared expedition state; retries update the same request rather than
double-counting it, and the crew records progress toward the global requested total.

## Item acquisition AND/OR graph

`npc/item_goal.js` treats alternative acquisition methods as OR branches and all
ingredients/prerequisites of one method as AND branches. Recipe output counts scale
ingredient batches, smelting scales source and fuel amounts, and crafting-table need
comes from the actual recipe shape. Method cost includes quantity, acquisition kind,
nearby availability and a ten-minute decaying failure penalty. The cheapest feasible
branch is re-evaluated after every leaf action, which repairs only the affected branch
instead of restarting the whole root goal.

## Adding a dynamic decision

Add a candidate provider in `dynamicDecisionCandidates()` with this contract:

```js
{
    key: 'environment:example',
    source: 'environment',
    utility: 60,
    urgency: 0,
    reason: 'short observable reason',
    onSelected: () => markCooldown(),
    createAction: () => ({ name: 'example', timeout: 2, fn: async () => true }),
}
```

Sensing and scoring must be cheap and side-effect free. State changes, cooldown
marks and expensive world work belong in `onSelected`, an action `onStart`, or the
action itself. `createAction` may be called for a candidate whose concrete action
is still backed off, so it must stay side-effect free.

Use `!progress` to inspect milestone branches and `!decisions` to inspect the
latest winner, ranked candidates and external command goals.
