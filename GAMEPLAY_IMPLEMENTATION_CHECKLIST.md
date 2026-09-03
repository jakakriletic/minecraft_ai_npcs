# Gameplay Implementation Checklist

Goal: NPCs should feel like capable Minecraft players with full obedience to the
king. A king's order should be heard, acknowledged, executed through safe
deterministic skills, honestly reported, then the NPC should return to routine.

## Update Rules For Future AI

After every successful implementation:

- Change exactly the relevant checkbox from `[ ]` to `[x]`.
- Only check a box when code exists, imports cleanly, lint/syntax checks pass,
  and there is a manual smoke command or test.
- Add a short `DONE yyyy-mm-dd:` note with files changed and verification.
- If work is partial, keep the checkbox empty and add a `PARTIAL:` note.
- Do not check a box just because the approach is planned.

## Completed Foundation

- [x] Central deterministic brain loop.
  DONE before 2026-07-09: `src/agent/library/brain.js`.
- [x] Owner command layer for stop/follow/gather/chest/combat/mining/order.
  DONE before 2026-07-09: `src/agent/owner_commands.js`.
- [x] Public storage, base/camp, stash/restock.
  DONE before 2026-07-09: `src/agent/library/base.js`, `storage.js`, `camp.js`.
- [x] Progression from stone to iron to diamond.
  DONE before 2026-07-09: `src/agent/library/progression.js`.
- [x] Farming wheat plus basic livestock.
  DONE before 2026-07-09: `src/agent/library/farm.js`.
- [x] Town build queue, schematics, roads and cleanup.
  DONE before 2026-07-09: `build.js`, `town.js`, `roads.js`, `tidy.js`.
- [x] Cooperative mining expedition.
  DONE before 2026-07-09: `src/agent/library/mining.js`.
  BUGFIX 2026-07-09 (stuck underground): `bot._miningExpeditionActive` was set in
  `participate()` and only cleared in `retreat()`, so an abnormal exit could leave
  it pinned. While pinned it SUPPRESSES `checkStrandedBelowSettlement` surface
  recovery (brain.js) and stockpile smelting → a bot stranded deep after the run
  ends never gets rescued. `planExpeditionAction` now reconciles the flag every
  idle tick: cleared whenever this bot is not a member of a live expedition.
- [x] Guardian/combat layer without PvP.
  DONE before 2026-07-09: `combat.js`, `guardian.js`, `npc_defense.js`.
- [x] Social/planner/memory/culture foundation.
  DONE before 2026-07-09: `planner.js`, `society.js`, `roleplay/*`, `culture.js`.
- [x] Gameplay readiness status.
  DONE 2026-07-09: `src/agent/library/gameplay_status.js`, `!gameplay`.

## Roadmap

- [x] Faza 2: Loadout and inventory policy.
  Implement `src/agent/library/loadout.js` with profiles for miner, builder,
  farmer, ranger, steward, explorer and escort. Add a manual smoke command.
  DONE 2026-07-09: `src/agent/library/loadout.js`, `!loadout`,
  `!prepareForTask`, `!gameplay` profile integration. Verified with
  `node --check`, `npx eslint`, command registry import and mock runtime tests.
  TESTED 2026-07-09: `test/gameplay_modules.test.js` covers profile aliases,
  ready/blocked loadout status, unknown profiles and prepared miner no-op path.

- [x] Faza 3: Royal Command Contract.
  Convert owner orders into a structured `RoyalIntent`/duty shape with target,
  selected bots, timeout, safety policy and report policy.
  DONE 2026-07-09: `src/agent/library/royal_intent.js`,
  `src/agent/owner_commands.js`, `!royalDuty`. Owner duties now carry
  structured intent, target, selected bot, timeout, safety/report policies,
  resume attempts and last-result history. Verified with `node --check`,
  `npx eslint`, command registry import and mock runtime tests.
  TESTED 2026-07-09: `test/gameplay_modules.test.js` covers intent creation,
  lifecycle status, resume tracking, last-duty summary, cancellation, owner
  parser smoke and command registry exposure.
  BUGFIX 2026-07-09 (freeze): `runOwnerAction` had no try/finally, so if anything
  between setting `bot._ownerDuty` and clearing it threw (e.g. a translation/chat
  failure inside the spoken ack — `routeResponse`→`openChat`→`handleTranslation`
  is a network call), an INDEFINITE duty (`until===null`, "follow me"/"guard me")
  stayed pinned on the bot and `brainTick` returned early forever → bot frozen,
  alive but idle. Wrapped the body in try/finally that always finishes+releases
  OUR duty on exit. `node --check` + `npx eslint` clean, 17/17 tests pass.

- [x] Faza 4: Home Life.
  Add beds, sleep routine, morning prep, personal corner and home lighting audit.
  DONE 2026-07-09: `src/agent/library/home_life.js`, `!homeLife`,
  `!setupHomeLife`, `!sleepHome`, `!morningPrep`, `!auditHomeLight`,
  brain planner integration and `!gameplay` home-life summary/next steps.
  NPCs now understand home/camp anchor, bed presence, personal corner utilities,
  home lighting, night sleep and morning preparation.
  TESTED 2026-07-09: `test/gameplay_modules.test.js` covers ready home-life
  status, missing bed/dark home blockers, night sleep planning, morning prep
  planning and command registry exposure.
  BUGCHECK 2026-07-09: tightened readiness so a bed+light home is not marked
  ready until the personal corner utilities also exist; added regression tests
  for utility blockers and `!gameplay` home-life summary. `npm run
  test:gameplay` now passes 14 tests.
  BUGFIX 2026-07-09: `sleepAtHome` never woke the bot — night does not
  auto-advance while a human is online, so the 30s sleep wait timed out with the
  bot STILL in bed and every later action failed to move it (stuck-in-bed).
  Now always calls `bot.wake()` in the `finally` block, matching the
  liveness.js/npc.js convention.
  OPT 2026-07-09: `planHomeLifeAction` ran the findBlocks-heavy home scan on
  every idle brain tick (~2.5s). Gated it behind a 30s `homeScan` TTL (sleep and
  morning windows still bypass the gate), cutting idle scan cost ~12x with no
  behavior change. `npm run test:gameplay` still passes 17 tests, `node --check`
  and `npx eslint` clean.

- [x] Faza 5: Player Helper Routines.
  Add bring/carry/deliver/guard/help-building routines for natural king orders.
  DONE 2026-07-09: `src/agent/library/player_helper.js`,
  `!helperStatus`, `!bringToPlayer`, `!carryNearbyChest`, `!guardPlayer`,
  `!helpBuild`, owner natural parser integration and `!gameplay` helper
  summary. Natural king orders now cover bring/deliver items, carry nearby
  chest contents to storage, guard/escort a player and help building by
  preparing builder loadout plus optional town build queue.
  TESTED 2026-07-09: `test/gameplay_modules.test.js` covers helper aliases,
  natural bring/carry/guard/help-build parsing, helper readiness summary,
  owner parser smoke and command registry exposure. `npm run test:gameplay`
  passes 17 tests.
  BUGFIX 2026-07-09: parsed player names come out of `normalizeText`
  lowercased, but `bot.players[...]` / `giveToPlayer` / `goToPlayer` /
  `followPlayer` key on the exact (case-sensitive) username — delivery/guard to a
  mixed-case or explicitly named player silently failed with "could not find".
  Added `resolvePlayerName()` (case-insensitive lookup against `bot.players`,
  falling back to the given string) and applied it in `bringToPlayer`,
  `carryNearbyChest`, `guardPlayer` and `helpBuild`.
  CLEANUP 2026-07-09: removed dead `buildWorkProfiles`/`profile`/`hasToolAtLeast`
  and the now-unused `guardian` import from `gameplay_status.js` (never called;
  `!gameplay` uses `getAllLoadoutStatuses`).

- [ ] Faza 6: Village POI Registry.
  Add `village_poi.js` and `bots/village-pois.json` for beds, workstations,
  farms, mines, doors, roads, guard posts and market.

- [ ] Faza 7: Roads, Frontage and Terrain v2.
  Connect real doors and POIs, add slopes, terminators and cleanup of stale roads.

- [ ] Faza 8: Workstation Queues.
  Add smelting, repair/anvil, enchanting, compost and trash queues.

- [ ] Faza 9: Mining v2.
  Route all dangerous autonomous mining through expeditions or safe surface scan.
  Add mine route registry, entrance chest and danger markers.

- [ ] Faza 10: Scouting.
  Add safe exploration loops, waypoints, resource reports and return policy.

- [ ] Faza 11: Combat/Escort v2.
  Add shield stance, retreat/heal, patrol checkpoints, king escort and recovery.

- [ ] Faza 12: Social and Economy.
  Add jobs, market, prices, orders, debts, gifts and practical NPC help.

- [ ] Faza 13: Verification Harness.
  Add static import smoke, mock tests for status/loadout/royal intent and an
  in-game checklist.
  PARTIAL 2026-07-09: Added `npm run test:gameplay` and
  `test/gameplay_modules.test.js` for Faza 2/3/4/5. Full in-game checklist still
  remains before this box can be checked.
