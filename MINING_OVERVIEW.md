# Mining – overview in znani problemi

## Kako teče minanje

| Pot | Vstop | Datoteka |
|---|---|---|
| Nabiranje bloka (kamen, ruda, …) | `!collectBlocks` → `skills.collectBlock` | `src/agent/library/skills.js` ~1321 |
| Minanje rude s kopanjem | `!mineOre` → `survival.mineOre` → `descend` / `stripMine` / `grabNearbyOres` | `src/agent/library/survival.js` ~700–990 |
| Skupinska ekspedicija | brain → `mining.runExpeditionStep` → `participate` | `src/agent/library/mining.js` |
| Filter, ali se blok sme lomiti | `isNaturalResourceCandidate`, `isMiningPositionProtected` | `src/agent/library/resource_guard.js` |

`collectBlock` najde najbližje bloke (`bot.findBlocks`) in jih prefiltrira z resource_guard. Nato vsakega pobere z `mineflayer-collectblock` (pathfinder lahko koplje) z 40 s timeoutom.
`mineOre` rudo, ki je že izpostavljena (vsaj ena stran je zrak), pobere s `collectBlock`. Sicer koplje stopnice do ciljnega Y (`descend`, vedno v smer +x) in nato 1x2 tunel (`stripMine`).

## Popravljeni in regresijsko preverjeni bugi (test `npm run test:mining`)

1. **BUG-1 `collectBlock("iron")` ne išče `deepslate_iron_ore`.** Enako velja za coal/gold/diamond/redstone/emerald. Pri besedi brez `_ore` se deepslate različica ne doda, zato se na Y < 0 zdi, da rude »ni«.
2. **BUG-2 `"lapis_lazuli"` išče `lapis_lazuli_ore`**, ki ne obstaja. Pravilno ime je `lapis_ore`.
3. **BUG-3 `"copper"` ni na seznamu**, zato se `copper_ore` ne išče.
4. **BUG-4 Premajhen iskalni limit.** `findBlocks` vrne samo najbližjih 16 blokov (`max(16, num*4)`), filter šele nato. Če je najbližjih 16 zaščitenih, izključenih (neuspel path) ali nevarnih, izpiše »No X nearby«, čeprav je dobra ruda 20 blokov stran.
5. **BUG-5 Bakle in cobblestone blokirajo kamen.** `ARTIFICIAL_MARKERS` vključuje `torch`, `wall_torch` in `cobblestone`. Za `stone`/`dirt`/… se kamen v krogu 4 blokov od teh blokov zavrne. `collectBlock` sam postavlja bakle (`autoLight`), `stripMine`/`descend` pa vsakih 4–6 korakov. Po kratkem času je ves kamen okoli bota »umeten« in nabiranje kamna odpove.

## Verjetni problemi (iz kode, test v živo)

6. **`grabNearbyOres` / `mineOre` podata samo ime bloka.** `collectBlock(bot, o.name, 1)` znova išče najbližjo rudo tega imena v 64 blokih, ne tiste, ki je bila najdena ob tunelu. Ta je lahko zakopana ali za steno, zato pathfinder koplje naključne rove, zapusti tunel, pokvari mining trail in se vrnitev zatakne. `mineOre` ima enak problem: filtrira `isExposedMiningTarget`, a `collectBlock` tega filtra ne uporabi.
7. **Uspeh se meri z razbitim blokom, ne s pobranim itemom** (`remaining.name !== block.name`). Če drop pade v lavo ali luknjo ali ga bot ne pobere, se šteje kot uspeh. `mineOre` šteje inventar in se zato lahko vrti do `maxTries`.
8. **`canHarvest` = false vrne `false` za celoten klic**, namesto da preskoči en blok (npr. prva najdena je `deepslate_diamond_ore`, bot ima kamniti kramp).
9. **`descend` vedno koplje v smer +x.** Če je tam jama, zaščita ali lava, se ustavi in `participate` po 2 stallih izbere nov vhod. Pri `mineOre` (brez ekspedicije) ni rerouta, zato 16 poskusov zapored obtiči na isti steni.
10. **`mutate` pri neuspelem locku tiho zavrže spremembo** (progress, abort). Ker je ekspedicija skupna datoteka, se napredek lahko izgubi in boti ostanejo spodaj do TTL.
11. **Bakla na lastni poziciji** (`placeBlock(... p.x,p.y,p.z, 'bottom')`) v 1x2 tunelu pogosto odpove, zato so tuneli temni in pojavijo se mobi.

## Kako testirati

Offline (brez strežnika, ~1 s):
```
npm run test:mining
```
Vseh 10 offline testov je zelenih (2026-09-24). Dejanski rezultat v igri še ni preverjen.

V živo (strežnik + `node main.js`, MindServer na :8080):
```
node tools/mining-live-test.mjs Zan                 # vsi scenariji
node tools/mining-live-test.mjs Zan stone iron      # izbrani
```
Scenariji: `stone`, `cobblestone`, `coal`, `iron`, `coal_mine`. Za vsakega zabeleži inventar pred in po, PASS/FAIL/TIMEOUT in namig (»found no candidates«, »wrong pickaxe«, »stopped at cave« …). Poln izpis je v `bots/mining-live-<agent>.log`.
Priporočeno: da `stone` preveri BUG-5, bota postavi v jamo z baklami.
