# Player-Like Progression Implementation Prompt

Use this as the next implementation prompt for Mindcraft 1.20.1 bots.

Goal: make bots progress like practical survival players, not only like gear grinders.
Keep deterministic code in `src/agent/library/progression.js`; the LLM may suggest broad
projects, but survival-critical item/block progression must stay code-driven.

Research notes:
- Early utility blocks: crafting table, chest, furnace, and bed are core player
  milestones. The current code already handles table/chest/furnace in `base.setupBase`.
- Early carried kit: torches are mandatory before cave work; shield already belongs
  in iron tools; bucket/water bucket should follow iron tools because it supports
  farms, lava safety, and emergency survival.
- Mid/late shared utility: enchanting table, bookshelves, and anvil should live near
  public storage so the kingdom shares one upgrade station instead of each bot
  duplicating expensive blocks.
- 1.20.1 compatibility: use modern color-specific beds such as `white_bed`, raw ore
  drops, deepslate ore variants, and the expanded negative-Y mining layers.

Web sources checked:
- Minecraft 101 "Crafted Blocks": lists crafting table, chest, bed, bookshelf,
  furnace, brewing stand, enchanting table, and anvil as practical crafted blocks.
  https://www.minecraft101.net/r/crafted-blocks.html
- Game8 "Utility Blocks": groups containers, crafting blocks, village blocks, and
  respawn blocks as utility categories useful for smoother progression.
  https://game8.co/games/Minecraft/archives/378490
- Minecraft Wiki/Fandom "Enchanting Table": confirms enchanting table is the block
  used to enchant tools, weapons, armor, and books.
  https://minecraft.fandom.com/wiki/Enchanting_Table

Implemented first pass:
- `starter_utility`: craft or withdraw enough torches after homestead.
- `iron_utility`: craft or withdraw a bucket after iron tools/shield.
- `advanced_utility`: after diamond tools plus a homestead, place a shared enchanting
  table, six bookshelves, and an anvil near public storage. All three parts now belong
  to the completion condition; partial placement is persisted as useful progress.

Next prompt:
1. Add a bed milestone that can collect matching wool and wood, then craft/place a
   color-specific bed using the 1.20.1 registry recipe.
2. Add `ensureBookSupply`: gather sugar cane, craft paper/books, hunt only safe surplus
   cows for leather, then feed enchanting-table and bookshelf recipes.
3. Add `ensureObsidianForEnchanting`: after diamond pickaxe, use bucket/water/lava
   handling to make or mine four obsidian without trapping the bot.
4. Add optional ranger kit progression: bow plus arrows from public storage first,
   then cautious string/flint/feather gathering.
5. Teach the enchanting service to prefer the shared bookshelf setup and record
   whether the station is low, medium, or max power.
