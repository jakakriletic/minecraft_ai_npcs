# Village build review - vanilla-like frame

Status: 2026-06-30 review after the "large trampled grass around storage" issue.

## Short diagnosis

The ugly large patch comes from `src/agent/library/roads.js`, not from storage itself.
The planned road system used `town_plaza_radius = 9` and built the central plaza as a
filled square:

- old default: `(9 * 2 + 1)^2 = 361` candidate cells
- result in `bots/kingdom-roads.json`: `centralni trg` completed with 334-339 path blocks

That is why the storage area reads as a carpet of `dirt_path` instead of a village
meeting point.

## Vanilla cues worth copying

Sources:

- Mojang vanilla data mirror: [village_plains.json](https://raw.githubusercontent.com/misode/mcmeta/data-json/data/minecraft/worldgen/structure/village_plains.json)
- Mojang vanilla data mirror: [plains town_centers](https://raw.githubusercontent.com/misode/mcmeta/data-json/data/minecraft/worldgen/template_pool/village/plains/town_centers.json)
- Mojang vanilla data mirror: [plains streets](https://raw.githubusercontent.com/misode/mcmeta/data-json/data/minecraft/worldgen/template_pool/village/plains/streets.json)
- Mojang vanilla data mirror: [plains houses](https://raw.githubusercontent.com/misode/mcmeta/data-json/data/minecraft/worldgen/template_pool/village/plains/houses.json)
- Mojang vanilla data mirror: [plains terminators](https://raw.githubusercontent.com/misode/mcmeta/data-json/data/minecraft/worldgen/template_pool/village/plains/terminators.json)
- Mechanics reference: [Jigsaw structure](https://minecraft.wiki/w/Jigsaw_structure), [Villager](https://minecraft.wiki/w/Villager)

Important vanilla patterns:

1. Villages start from a small town-center pool, not a huge filled path slab.
2. Streets use `projection: terrain_matching`, while houses mostly use `projection: rigid`.
3. Streets have terminators/fallbacks, so a road can end gracefully.
4. Houses include profession buildings and farms, not just generic homes.
5. A functional village is really a POI network: beds, job-site blocks, meeting point/bell,
   reachable paths, light, and enough safe interior space.

## Current local system

Already good:

- `town.js` creates one shared plan in `bots/town-plan.json`.
- Plots are zoned: plaza, civic, residential, workshop, defense, decor.
- Build claiming is cross-process locked, so multiple builders do not overlap.
- Terrain checks can downgrade rough plots to gardens/decor.
- `roads.js` can follow terrain and avoids protected builds.

Needs work:

- The plaza was a filled square carpet.
- Planned grid roads are built before the village really exists, so the frame can look like
  an empty road graph.
- House functionality is visual only; schematics do not guarantee villager POIs.
- Roads do not yet have proper endings, side details, stairs/slabs on slopes, or frontage
  rules.
- Terrain preparation still uses rectangular fill per plot; fine for small plots, bad if
  used for public spaces.

## Patch applied now

`roads.js` now supports plaza shapes:

- `meeting` - default. Small filled center + cross arms to the roads.
- `frame` - meeting shape plus an outline ring.
- `square` / `filled` - old behavior for rollback.

Settings changed:

- `town_plaza_shape: "meeting"`
- `town_plaza_radius: 6`
- `town_plaza_core_radius: 3`

This keeps the storage usable but stops new towns from creating a 19x19 path carpet.
Existing path carpet in an already-built world is not automatically reverted.

## Best next design

Use a three-layer village frame:

1. Meeting point
   - 7x7-ish core near storage/bell/well.
   - Four narrow path arms.
   - Optional fountain/well/bell schematic, but do not overwrite storage chests.

2. Street graph
   - Grow roads only to claimed/built plots, not the full grid up front.
   - Keep `terrain_matching` behavior: follow surface, allow one-block slope, use stairs/slabs
     later instead of cutting terrain.
   - Add road terminators: small lamp, bench, hedge, dead-end marker, farm gate.

3. Functional plots
   - Residential: at least one bed per house.
   - Workshop: matching job-site block, for example smithing table, smoker, loom,
     cartography table, lectern, composter, stonecutter.
   - Civic: bell/meeting point, market stalls, storage, notice board.
   - Farm/decor: composter, water, crops, fences.

## Recommended implementation order

1. Limit planned grid roads to the inner ring and roads to active/built plots.
2. Add `village_function` metadata to schematics: beds, job sites, doors, bell, farm.
3. Add a `!village` / `!town` diagnostic command showing plots, roads, POI count, blocked
   roads, and next build.
4. Add a safe cleanup command for old path carpets around storage, gated by admin command
   and distance/radius checks.
5. Add road endings and small frontage paths from each building door to the nearest road.

