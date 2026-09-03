# Deterministic Gameplay Plan

Namen tega dokumenta je imeti prakticen plan za deterministicne gameplay funkcije,
ki botom dajejo bolj player-like obnasanje: priprava pred delom, razumne dnevne
rutine, varna raba sveta, sodelovanje z vasjo, in manj "task bot" obcutka.

Status tega pregleda: narejen je staticni audit trenutnih modulov in njihovega
pretoka skozi `brain.js`. In-game smoke test naj bo locen korak, ker trenutni repo
nima avtomatskih testov za Mineflayer svet.

## Definicija: player-like deterministic

Deterministic funkcija je "player-like", ko bot:

- najprej poskrbi za prezivetje, opremo, hrano in pot nazaj;
- pred izhodom pripravi loadout za nalogo, ne samo reagira na manjkajoc item;
- ima domaco rutino: spanje, jutranja priprava, storage, orodja, hrana;
- uporablja vas kot funkcionalen prostor: postelje, workstations, poti, storage,
  farme, obrambo in zbirne tocke;
- gradi in popravlja svet berljivo, z namenom, ne kot nakljucne ploskve;
- se v nevarnih sistemih obnasajo previdno: mining, noc, combat, voda, padci;
- pusti sled, ki jo igralec razume: poti imajo vhode, storage ima namen,
  farme so obnovljive, rudniki imajo vrnitev.

## Audit trenutnega stanja

| Domena | Kaj ze obstaja | Kako trenutno deluje | Glavne vrzeli |
| --- | --- | --- | --- |
| Brain loop | `src/agent/library/brain.js` | Prioritetni deterministic loop: recovery, obramba, farmer, hrana, orodja, storage, progression, society, social, idle. | Manjka enoten "daily routine" sloj, ki poveze spanje, loadout, delo, povratek, deposit in pocitek. |
| Survival | `src/agent/library/survival.js` | Hrana, orodja, emergency return, safe digging, trap recovery, torches, ore mining. | Autonomous mining se ponekod se vedno klice direktno z `allowDigging=true`; manjkajo voda/drowning rutina, vremenski/nocni rezim, repair/anvil. |
| Progression | `src/agent/library/progression.js` | Stage sistem od stone/iron do diamond tools/armor, craft in storage claim. | Manjkajo Nether, XP/enchant loop, anvil repair, shield/ranged progression kot splosna stopnja. |
| Farming | `src/agent/library/farm.js` | Per-bot farm site, voda, wheat, harvest/replant, bread, livestock breeding/culling. | Manjkajo multi-crop rotacija, fence/pen construction, shepherding, village POI povezava. |
| Mining | `src/agent/library/mining.js` | Shared mining expedition, party size, entrance, provisions, abort ob poskodbah. | Treba centralizirati vse autonomous ore akcije skozi expedition ali surface-only pravila; manjkajo shaft registry, oznake, return chest, tunnel map. |
| Base | `src/agent/library/base.js` | Home, return, public reserve, restock, stash, base setup. | Base je utility-only; manjka postelja, osebni koti, morning prep, lighting audit, hotbar policy. |
| Storage | `src/agent/library/storage.js` | Public storage z locki, kategorijami, expansion, NBT-safe oprema. | Manjkajo labels/signs, workstation zone, smelting queues, trash/compost queues, pregledne diagnostike. |
| Combat | `src/agent/library/combat.js`, `guardian.js` | Bow + shield kit, safe friendly-fire check, ranger protect/patrol, melee fallback. | Manjkajo shield timing, retreat/heal routine, patrol checkpoints, escort, post-combat recovery. |
| Enchanting | `src/agent/library/enchanting.js` | Enchanter v society, public storage oprema/lapis, NBT-safe vracanje. | Manjkajo enchanting room build, bookshelf staging, XP source, anvil/books management. |
| Town/Roads | `src/agent/library/town.js`, `roads.js`, `build.js` | Town plan, claims, protected builds, roads, hub connections, plaza shape. | Poti se lahko gradijo pred realnimi hisami; manjkajo door/frontage paths, POI metadata, slope stairs/slabs, cleanup starega path materiala. |
| Cleanup | `src/agent/library/tidy.js` | Konzervativen cleanup scaffold/debris, varovanje farm/storage/buildov. | Manjka road repair, landscape restoration, cleanup starih plosc, ce niso vec del plana. |
| Commands/diagnostics | `src/agent/commands` | Veliko manual deterministic ukazov in query statusov. | Manjka enoten `!gameplay` ali `!village` diagnostic za readiness, rutine, backlog in varnostne blokade. |

## Najvecja tveganja

1. Mining bypass

   V `brain.js` so autonomous stockpile/planner akcije, ki klicejo
   `survival.mineOre(..., true)`. Funkcija `mineOre` ima varnostne garde, ampak
   za player-like sistem je boljse, da bot ne odpira nevarnih rudarskih poti brez
   expedition konteksta. To naj bo ena prvih varnostnih ureditev.

2. Manjka dnevni lifecycle

   Bot zna veliko posameznih nalog, ampak nima rutine tipa:
   wake up -> eat/restock -> choose work -> travel -> work -> deposit -> return
   -> sleep. Zaradi tega deluje bolj kot scheduler kot igralec.

3. Vas nima dovolj funkcionalnega spomina

   Town/roads/storage/farm obstajajo, ampak nimamo centralnega village frame
   registra: postelje, workstations, bell/meeting point, front doors, public paths,
   danger zones, torch coverage, POI ownership.

4. Inventory/loadout ni centraliziran

   Trenutno moduli sami jemljejo hrano, orodje, torche, combat kit ali material.
   To je uporabno, ampak tezje zagotovi consistent hotbar in pripravo za nalogo.

5. Premalo verification povratnih informacij

   Ko bot nekaj "uredi", ni dovolj enotnega statusa, ki pove: kaj je naredil,
   kaj je blokirano, kaj manjka, in kaj bo naslednji deterministic korak.

## Roadmap

### Faza 1 - Safety audit in centralni gameplay status

Implementirati:

- `src/agent/library/gameplay_status.js`
- query command `!gameplay`
- skupen snapshot: food, tools, armor, bed, home, public storage, farm, current
  assignment, stuck state, mining safety, open blockers
- logiko za "ready for work" in "must recover first"

Acceptance:

- `!gameplay` za vsakega bota pove, ali je pripravljen za delo;
- status jasno locuje: survival blocker, loadout blocker, village blocker,
  current task blocker;
- noben action loop ne rabi ugibati osnovnih readiness podatkov iz vec modulov.

### Faza 2 - Loadout in inventory policy

Implementirati:

- `src/agent/library/loadout.js`
- task profili: farmer, miner, builder, ranger, steward, explorer
- hotbar/equipment preferenca: food, pick/axe/shovel, sword/bow/shield, torches,
  blocks, bucket, bed po potrebi
- minimalne rezerve: food, torches, blocks, arrows, tool durability
- centralen `prepareForTask(agent, taskName)`

Acceptance:

- miner ne gre v rudnik brez hrane, torch budgeta, picka in return plana;
- builder ne polni inventoryja z odvecnim lootom pred gradnjo;
- ranger vedno poskusi vzeti bow/arrows/shield/food pred patrol;
- po tasku bot odlozi presezek in se vrne na normalno stanje.

### Faza 3 - Home life: bed, sleep, morning prep

Implementirati:

- `src/agent/library/home_life.js`
- bed claim/placement per bot
- sleep routine ob noci, ce je varno in bot ni v urgentnem tasku
- morning prep: eat, repair/replace tools, take food, take torches, deposit junk
- home lighting audit okoli postelje in storage poti

Acceptance:

- bot zna sam poiskati ali postaviti posteljo doma;
- ob noci se vrne spat, razen ce je v combat/recovery stanju;
- zjutraj ne gre v delo brez osnovnega loadouta;
- sleep ne krade postelj drugim botom, ce imamo claim registry.

### Faza 4 - Functional village frame

Implementirati:

- `src/agent/library/village_poi.js`
- registry `bots/village-pois.json`
- POI tipi: bed, workstation, bell/meeting, storage, farm, mine entrance,
  guard post, road node, front door
- workstation placement za role: composter, smithing/anvil, furnace/blast furnace,
  fletching/crafting/enchanting station
- povezava POI -> road/frontage -> protected build

Acceptance:

- vsaka zgrajena hisa ima front door in pot do glavne poti;
- vsaj osnovni POI-ji so registrirani in ponovno uporabljeni;
- farmer/fletcher/smith/miner ne buildajo svojih utility blokov nakljucno;
- public storage in meeting point sta logicno povezana s potmi.

### Faza 5 - Roads/frontage/terrain v2

Implementirati:

- road planner, ki daje prednost dejanskim vratom in POI-jem;
- road terminatorje za slepe konce: lamp, bench, post, small plaza;
- stairs/slabs na klancih, ne samo flatten;
- cleanup starega path carpet/materiala, ce ni vec v road planu;
- terrain prep, ki uporablja footprint + robove namesto velikih pravokotnih plosc.

Acceptance:

- ni vec velikih nakljucnih poteptanih plosc okoli storage/huba;
- cesta se vidi kot povezava med funkcijami, ne kot grid pred mestom;
- vsak plot ima vsaj eno berljivo povezavo do vhodnih vrat;
- slope paths so prehodne in vizualno manj brutalne.

### Faza 6 - Mining v2

Implementirati:

- vse autonomous ore potrebe naj gredo skozi:
  - shared expedition, ali
  - explicit surface-only scan, ce je res varno;
- `bots/mining-routes.json` za mine entrance, shaft, branches, danger markers;
- return chest ali drop-off na vhodu;
- lighting/repair pass za stopnice in glavni tunel;
- abort razlogi v gameplay statusu.

Acceptance:

- `brain.js` ne klice vec direktnega dangerous `mineOre(..., true)` za stockpile;
- expedition zna pustiti sled in se vrniti;
- bot ne koplje proti ore, ce bi odprl jamo brez plana;
- ob poskodbi teammate-a expedition prekine ali se pregrupira.

### Faza 7 - Workstation queues: smelting, repair, enchanting

Implementirati:

- public smelting queue: furnace/smoker/blast furnace;
  - DELNO NAREJENO: `survival.smeltStockpile` + brain korak `smeltStock` (brain.js 7b)
    batch-smelta nosen raw stock (raw_iron/raw_gold/surovo meso/presezek krompirja),
    steward na ~10 min povlece raw rudo iz public storage-a in jo predela;
    legacy-registry fallback: 'lit_furnace' se steje kot 'furnace' (mc_compat LEGACY_BLOCK_VARIANTS).
- anvil repair/merge routine;
- enchanting station build: table, bookshelves, lapis reserve;
- item priority: pickaxe, sword/bow, armor, tools;
- trash/compost queue za semena, rotten flesh, odvecne bloki po policyju.

Acceptance:

- raw ore ne ostaja v inventoryju brez razloga;
- bot zna batch-smeltati in potem vrniti ingote v public storage;
- oprema se popravlja ali zamenja pred zlomom;
- enchanting ni samo "ce je table ze tam", ampak zna zgraditi osnovno infrastrukturo.

### Faza 8 - Exploration and scouting

Implementirati:

- `src/agent/library/scouting.js`
- resource waypoints: trees, animals, village, caves, water, sand, lava
- safe return planning in max distance policy;
- landmark placement ali zapisi v state;
- no-night exploration policy brez bed/food.

Acceptance:

- bot raziskuje v krogu in se zna vrniti;
- najdene vire deli s society planom;
- explorer ne povzroci, da se bot izgubi cez noc brez hrane;
- dangerous POI-ji so oznaceni in ne postanejo random idle target.

### Faza 9 - Social helper routines

Implementirati:

- deterministic helper tasks za igralca: follow with distance, carry supplies,
  guard player, fetch from public storage, deliver gift/material;
- kratke chat template odgovore za zahteve in blokade;
- "ask for missing resource" namesto silent fail;
- handoff med boti, ce ima drug bot boljso vlogo/opremo.

Acceptance:

- igralec lahko dobi razumljiv odziv, zakaj bot nekaj ne more;
- bot zna prinesti material ali ga dati v chest blizu igralca;
- ranger zna spremiti igralca ali skupino;
- social govor ne preglasi urgent survival/combat akcij.

### Faza 10 - Combat v2

Implementirati:

- shield timing ali vsaj deterministic shield stance v melee;
- retreat/heal routine pod health threshold;
- patrol routes/checkpoints iz village POI;
- escort path za miner/farmer/builder v nevarnih casih;
- post-combat recovery: eat, replace arrows, repair, deposit loot.

Acceptance:

- defender ne samo equipa shield, ampak ga uporablja v smiselnih melee situacijah;
- ranger patrola specificne tocke, ne samo okolico;
- po napadu se bot vrne v normalno stanje in ne ostane v combat inventoryju;
- village alert ne povzroci endless chasing predalec od doma.

### Faza 11 - Test/verification harness

Implementirati:

- static smoke script za import/syntax critical modulov;
- mock snapshot teste za gameplay status/loadout odlocitve;
- in-game smoke checklist:
  - new bot bootstrap;
  - farm loop;
  - public storage restock/stash;
  - night sleep;
  - mining expedition;
  - build plot + road frontage;
  - combat patrol;
- `TESTIRANJE.md` dopolniti z deterministic gameplay section.

Acceptance:

- osnovni moduli imajo vsaj syntax/import smoke;
- deterministic odlocitve imajo ponovljive snapshot teste;
- vsak nov gameplay modul ima jasen manual smoke command ali query.

## Predlagan vrstni red implementacije

Najprej:

1. `gameplay_status.js` + `!gameplay`
2. `loadout.js` + `prepareForTask`
3. `home_life.js` za bed/sleep/morning prep
4. mining safety consolidation v `brain.js`
5. `village_poi.js` in road/frontage povezava

Zakaj ta vrstni red:

- status najprej naredi sistem pregleden;
- loadout zmanjsa napake vseh drugih taskov;
- home life najbolj hitro naredi bote bolj player-like;
- mining safety zapre najvecji gameplay risk;
- village POI potem lahko uporabi status/loadout/home podatke.

## Predlagane state datoteke

- `bots/gameplay-status.json` - opcijsko agregiran snapshot ali history;
- `bots/loadouts.json` - globalni profili in override po botu;
- `bots/<bot>/home-life.json` - bed claim, morning prep timestamps;
- `bots/village-pois.json` - centralni registry POI-jev;
- `bots/mining-routes.json` - vhodi, branchi, danger markers;
- `bots/workstation-queues.json` - smelting/repair/enchant backlog.

## Opombe za implementacijo

- Kjer obstaja public storage, naj novi moduli uporabljajo `storage.js` locke.
- Novi routine-i naj bodo majhni in idempotentni: ce jih brain poklice veckrat,
  ne smejo podvajati chestov, postelj, poti ali workstation blokov.
- V `brain.js` naj se dodajajo kot prioritetni actioni samo, ko imajo jasen
  cooldown in blocker status.
- Za village build naj se raje dela iz POI/frontage podatkov kot iz velikih
  pravokotnih terrain fill akcij.
- Chat naj ostane sekundaren: deterministic funkcija mora delovati tudi, ce bot
  nic ne rece.
