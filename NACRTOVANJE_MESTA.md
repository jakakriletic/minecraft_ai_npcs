# Strukturirano mesto — raziskava in načrt

Cilj: boti naj gradijo **kot mesto** — ceste, stavbe na smiselnih položajih (coniranje),
obrnjene proti ulici, + dekor. Vse deterministično (brez LLM v zanki), na obstoječi kodi.

---

## 1. Ugotovitve raziskave

### GDMC (Generative Design in Minecraft) — najbolj relevantna domena
Letno tekmovanje (od 2018) prav za to: AI generira naselja, ki se **prilagodijo terenu**.
Sodniki ocenjujejo: prilagodljivost, funkcionalnost, narativnost, estetiko.
Praktične lekcije zmagovalcev (in pogoste napake):
- **Ne ravnaj velikih površin.** Glavna napaka slabih generatorjev = sploščijo vse v ploščo.
  Boljše: **terasiranje**, temelji/podstavki, stavbe ki "stopničasto" sledijo terenu, manjše parcele na bolj ravnih mestih.
- **Inkrementalno / decentralizirano planiranje** (arXiv 2309.10871, "Believable … Decentralised Iterative Planning"):
  postavljaj **eno stavbo naenkrat**, vsaka upošteva že obstoječe + teren. → To se **odlično prilega našim več-agentnim botom** (vsak bot prevzame eno parcelo).
- Naredi **fokusno točko** (trg/vodnjak/tržnica), funkcijske **clusterje**, poveži s potmi ki **sledijo terenu** (stopnice/serpentine na klancu).
- "Verjetnost" prodaja: **variacija** schematikov + drobni **dekor** (svetilke, ograje, vrtovi, posevki).

Viri: [GDMC pregled (ACM)](https://dl.acm.org/doi/fullHtml/10.1145/3555858.3555940) · [GDMC (Wikipedia)](https://en.wikipedia.org/wiki/Generative_Design_in_Minecraft) · [Decentralised Iterative Planning (arXiv)](https://arxiv.org/abs/2309.10871) · [First Year Report (arXiv)](https://arxiv.org/pdf/2103.14950)

### Algoritmi za postavitev (cest + parcel)
- **Cestna mreža:** L-system (organsko, drevesasto), space-colonisation, ali **pravilna mreža/trg+ulice**.
  Za "mesto" videz + zanesljivost botov je **trg + glavne ulice + mreža parcel** najbolj predvidljiv; čist L-system se slabo prilega terenu in je težji za bote.
- **Delitev parcel (lot subdivision):** OBB-parcelacija — rekurzivno deli blok na parcele s pravili:
  min. površina, **dostop do ceste (frontage)**, razmerje stranic. Teoretično lepo, a **pretežko** za bote, ki fizično gradijo blok-po-blok → raje **mreža fiksnih parcel**.

Viri: [Roads via L-systems (PDF)](https://liu.diva-portal.org/smash/get/diva2:1467574/FULLTEXT01.pdf) · [Lot subdivision (martindevans)](https://martindevans.me/game-development/2015/12/27/Procedural-Generation-For-Dummies-Lots/) · [Space colonisation roads](https://www.researchgate.net/publication/330256216_Space_Colonisation_for_Procedural_Road_Generation)

### Knjižnice
- **Ni uporabne drop-in knjižnice.** JS generatorji mest so večinoma browser/Three.js demoji (vizualizacija),
  ne strežniške gradnje blok-po-blok: [CityGenerator](https://github.com/GoldenQubicle/CityGenerator), [Procedural-City-Generator (THREE.js)](https://github.com/photonlines/Procedural-City-Generator), [procgen.js](https://github.com/hoqqanen/procgen). Nobena ne gradi v mineflayer svetu.
- Skeniranje terena = **mineflayer nativno** (`bot.blockAt`, `bot.findBlocks`, chunk **heightmapi**) — brez knjižnice.
- **Zaključek: vse po meri**, a na obstoječih gradnikih (spodaj).

---

## 2. Kaj že imamo (ne podvajati!)
- **`build.js`**: `findBuildSite`/`scanBuildCandidate` ([:445](src/agent/library/build.js#L445)) — že **strukturirana analiza terena** (površinske višine, roughness/naklon, naravne ovire, umetni/zaščiteni bloki, izbira ravne parcele). `prepareBuildSite` (sploščitev + temelji), `buildSchematicCreative` (zanesljiva gradnja), `registerProtectedBuild`.
- **`protected-builds.json`**: register zasedenih AABB-jev `{name, owner, min, max}` → **rezervacija prostora** (anti-prekrivanje) že obstaja.
- **`roads.js`**: `maintainRoadNetwork` — povezuje registrirane stavbe s **hub-and-spoke** potmi + lučmi, sledi terenu. (Trenutno povezuje **po** gradnji, ni mreža.)
- **`society.js`**: `state.center` (središče naselbine), deljeni `kingdom.json`, vloge (vključno `builder`), cross-process zaklepi (`withNamedLock`).
- **Bogata zbirka schematikov** (`schematics/`): medieval_* (keep, manor, guildhall, tavern, blacksmith, bakery, apothecary, cottage, watchtower, gatehouse, barracks, windmill, stable, chapel, stone_bridge …), british_* (cottage, pub, townhouse, station), library, greenhouse, flower_garden, garden_pavilion, lamp_post … + generator `scripts/generate-schematics.js`. → **Idealen nabor za coniranje.**
- **Vrzel:** rare cloud **planner** izbere schematik, vsak bot pa ga zgradi pri **svojem** domu (`projectOrigin(home, name)`, [brain.js:240](src/agent/library/brain.js#L240)) → razpršeno. **Manjka skupni načrt mesta + dodeljevanje parcel.**

---

## 3. Priporočena arhitektura — `town.js` (nov modul)

Nova **plast načrta** nad `build.js`/`roads.js`. Deterministična, deljena prek datoteke `bots/town-plan.json` (vzorec kot `kingdom-roads.json`, zaklep `withNamedLock(bot,'town-plan',…)`).

### 3.1 Generiranje načrta (enkrat, deterministic)
Iz `society.center`:
1. **Trg** v središču (npr. 9×9), z **vodnjakom/tržnico** na sredini.
2. **Ulična mreža:** 2–4 glavne ceste iz trga + prečne ulice na fiksnem koraku (npr. vsakih ~12 blokov). Mreža **rotirana/poravnana** na najbolj raven sektor (heightmap).
3. **Parcele** = celice mreže ob ulicah: `{id, center, size, facing(ulica), zone, status, owner, schematic}`. Velikost parcele se ujema z velikostnimi razredi schematikov (S/M/L).
4. Načrt se shrani; vsi boti berejo **isti** načrt → soglasje brez sporočanja.

### 3.2 Coniranje (smiselni položaji)
Parcele dobijo **zono** glede na obroč od središča:
| Obroč | Zona | Schematiki |
|---|---|---|
| Trg/center | civic | keep/manor/guildhall (mestna hiša), chapel, library, tavern/pub, market, vodnjak |
| Notranji | residential | cottage(i), townhouse, hisa, koca |
| Srednji | workshops | blacksmith, bakery, apothecary, stable, windmill, greenhouse |
| Rob/perimeter | defense | watchtower, gatehouse, barracks, obzidje |
| Zunaj | agriculture/decor | farme, flower_garden, garden_pavilion, drevesa |

Pravilo orientacije: **vhod stavbe gleda proti pripadajoči ulici** (rotacija schematika ob postavitvi).

### 3.3 Gradnja (decentralizirano, več builderjev)
- Builder vzame **naslednjo prazno parcelo** po prioriteti (najprej civic/center, nato navzven), jo **zaklene** (status `claimed`, owner) v `town-plan.json` → vzporedno brez prekrivanja (isti vzorec kot rudarska ekipa).
- Postavi dodeljen schematik (terensko prilagojen: `prepareBuildSite` **terasira**, ne sploščuje na daleč), registrira v `protected-builds`, status `built`.
- Padec/restart: zaklep poteče (TTL) → parcelo prevzame drug.

### 3.4 Ceste po načrtu
`roads.js` razširi/uporabi tako, da gradi **ulice mreže** (parcela↔ulica frontage), ne le hub-and-spoke. Obstoječ `buildRoute` (dirt_path + luči) se ponovno uporabi na segmentih mreže.

### 3.5 Dekor (zadnji prehod)
Po stavbi/ulici: **ulične svetilke** (lamp_post / torch ob cesti — `roads.js` že zna), **ograje + path** ob parcelah, **vodnjak/fontana** na trgu, **vrtovi/drevesa** na praznih parcelah (flower_garden, garden_pavilion), napisi.

### 3.6 Prileganje terenu
- **Heightmap** (prismarine-chunk `WORLD_SURFACE`) za hitro iskanje najbolj ravnega sektorja za mrežo + Y vsake parcele.
- Na klancu: **terasiranje** parcel (različni Y), ceste s stopnicami; `scanBuildCandidate` roughness se uporabi za izločanje preveč razgibanih parcel (pusti jih kot vrt/drevo).

---

## 4. Izbrane odločitve (in zakaj)
- **Trg + mreža (ne čist L-system, ne OBB-parcelacija).** Daje "mesto" videz, je predvidljivo za bote in lahko za debug; L-system/OBB sta lepša na papirju a krhka za fizično gradnjo + slabše prilagajanje.
- **Decentralizirano inkrementalno** (eno stavbo naenkrat, vsak bot svojo parcelo) — natanko GDMC priporočilo IN naša več-procesna arhitektura.
- **Brez nove odvisnosti** — mineflayer + heightmap + obstoječ `build.js`/`roads.js`.

---

## 5. Fazni načrt (testabilno po fazah)
- **Faza 1 — Skelet mreže + parcele:** `town.js` generira `town-plan.json` (trg + glavne ulice + parcele) iz `society.center`; builder gradi **hiše na parcele** ob ulici (obrnjene proti njej) namesto pri svojem domu. *Test: hiše stojijo v ravni liniji ob ulici.*
- **Faza 2 — Coniranje + vzporedni builderji:** zone (center vs rob), zaklep parcele, več builderjev hkrati; ceste gradijo mrežo (frontage).
- **Faza 3 — Dekor + teren:** ulične luči, ograje/vrtovi, trg z vodnjakom; terasiranje na klancu (heightmap), prazne razgibane parcele → vrt/drevo.

## 6. Tveganja / odprta vprašanja
- **Estetika je težka** (razmerja, poravnava) — iterativno uglaševati v igri.
- **Velikosti schematikov** morajo ustrezati velikosti parcel → razredi S/M/L (preverit dejanske bounds).
- **Teren:** zelo razgiban teren → manjše/raztresene parcele; morda izbrati ravnejšo lokacijo za mesto vnaprej.
- **Performansa:** generiranje načrta poceni (enkrat); gradnja je že obstoječa cena.
