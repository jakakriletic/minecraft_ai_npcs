# AI NPC development blueprint

> **Preberi najprej.** Ta datoteka je enoten, hitro berljiv kontekst za nadaljnji razvoj **kingdom** NPC-jev. Stanje je bilo preverjeno statično v repozitoriju 2026-09-24. Kjer piše »implementirano«, to pomeni, da koda obstaja; vedenje v daljšem dejanskem igranju še ni potrjeno. Po vsakem pomembnem milestoneu posodobi to datoteko, tako da ostane resnična.

**Skupni aktualni razvojni načrt:** [NPC_DEVELOPMENT_MASTER_PLAN.md](NPC_DEVELOPMENT_MASTER_PLAN.md) združuje pregled AI integracije, stroškov, gameplay vrzeli (diamanti, oprema, enchanting, anvil, farming) in prioritetne milestone G0–G6. Pred nadaljnjim razvojem preberi oba dokumenta.

## 1. Projekt v dveh minutah

**Vizija:** NPC-ji naj v Minecraft Java 1.20.1 čim bolj igrajo kot sposobni igralci: preživijo, raziskujejo, zbirajo vire, napredujejo, gradijo, sodelujejo, se odzivajo na igralca in si postavljajo lastne dosegljive cilje. AI naj prispeva namen, ustvarjalne zamisli, izbiro strategije in prilagoditev neuspehu. Koda naj izvaja in preverja fizična dejanja v svetu.

**Osrednja razvojna teza:** največja vrzel ni pomanjkanje novega modela ali novega decision treeja. Model danes izbira omejen `focus`; NPC izvede eno od že napisanih rutin. Naslednji preskok je `opazovanje -> cilj -> razčlenjen izvedljiv načrt -> omejena veščina -> dokaz v svetu -> popravek načrta`. Odprta ustvarjalnost je uporabna šele, ko ta povratna zanka deluje.

**Ne zamenjuj dveh sistemov:**

| Sistem | Zagon | Koda | Namen |
| --- | --- | --- | --- |
| **Kingdom** | `main.js`, `summon_kingdom.bat` | `src/agent/library/*`, `src/agent/roleplay/*`, `src/mindcraft/*` | Glavni cilj tega blueprinta: NPC-ji, ki dejansko igrajo Minecraft. |
| **RP town** | `rp.js`, `start_boti.bat` | `src/rp/*` | Ločen sistem prebivalcev, urnikov in ekonomije. Ne predpostavljaj, da sprememba tukaj spremeni kingdom. |

Privzeti `settings.js` za kingdom trenutno zažene **pet** profilov (`Blaz`, `Nejc`, `Lara`, `Zan`, `Maja`), ostali so komentirani. Starejši dokumenti omenjajo deset botov; pred posegom preveri dejansko konfiguracijo. Botov govor je v trenutnih profilih pretežno nastavljen na angleščino, čeprav je del stare dokumentacije v slovenščini.

### Trenutni dokazni status

- `npm test` je ob pregledu prestal **140 Node testov** in **7 civilization smoke preverjanj**.
- To **ni** in-game potrditev avtonomije, preživetja, gradnje ali socialnega vedenja. Za vsak večji milestone je potreben ponovljiv test na dejanskem strežniku.
- Repo je ob začetku tega blueprinta na `main`, commit `78efdd1`, brez sprememb pred dodajanjem te datoteke. Ta podatek je zgodovinska referenca, ne trajna trditev o HEAD.
- `AGENTS.md` je orientacijska in razvojna referenca; pred implementacijo vedno preveri aktualno kodo in konfiguracijo. `ALTERA_PLAN.md`, `DECISION_GRAPH.md` in `GAMEPLAY_IMPLEMENTATION_CHECKLIST.md` vsebujejo zgodovino ter dodatne podrobnosti, a so lahko starejši od kode.

## 2. Kako kingdom trenutno deluje

```text
main.js
  -> src/mindcraft/mindcraft.js: mindserver + nadzornik procesov
  -> vsak profil dobi svoj Node proces
  -> src/agent/agent.js: Mineflayer povezava, chat, ukazi, ActionManager
  -> src/agent/library/brain.js: samonačrtovana zanka dejanj
       1. trda varnost / ukaz igralca / aktivna odprava
       2. ponudniki kandidatov: okolje, napredovanje, AI, družba, vzdrževanje
       3. decision_graph.js: ocena in izbor
       4. deterministična veščina prek ActionManager
       5. action_outcome.js: izid, odmik, ponovni poskus
  -> roleplay/cognition.js: namera in govor iz že izbranega dejanja
  -> roleplay/telemetry.js: snapshot in sled odločitev
```

### Kje iskati

| Naloga | Glavne datoteke |
| --- | --- |
| Zagon, profili, varna povezava | `main.js`, `settings.js`, `src/mindcraft/mindcraft.js`, `src/agent/agent.js` |
| Izbira dejanja | `src/agent/library/brain.js`, `decision_graph.js`, `action_outcome.js`, `src/agent/action_manager.js` |
| AI skupinski in lokalni načrt | `src/agent/library/planner.js`, `src/agent/roleplay/personality.js` |
| Napredovanje in pridobivanje predmetov | `src/agent/library/progression.js`, `src/agent/npc/item_goal.js` |
| Dejanski gameplay | `src/agent/library/{survival,skills,mining,farm,storage,loadout,home_life,combat,guardian,build,town,roads}.js` |
| Skupina in deljeno stanje | `src/agent/library/society.js`, `container_lock.js`, `container_index.js` |
| Spomin, sociala, govor | `src/agent/roleplay/{memory,social_graph,social_awareness,social_goals,cognition,awareness,reflection,telemetry}.js` |
| Ukazi igralca | `src/agent/owner_commands.js`, `src/agent/commands/*`, `src/agent/library/royal_intent.js` |
| Diagnostika | `!decisions`, `!progress`, `!gameplay`, `node tools/kingdom-status.js Blaz --trace 30` |

### Kaj je že vredno ohraniti

- `decision_graph.js` ni navaden decision tree. Kandidati imajo vir, uporabnost, nujnost, strošek, bonus za nadaljevanje dela, staranje in kazen za neuspeh. Varnost in ukazi imajo ločeni najvišji ravni. **Nadgradi pogodbo kandidatov; ne zamenjaj arbitra s še večjim `if/else`.**
- `progression.js` ima graf mejnikov od kamnitega do diamantnega orodja in več hkrati odklenjenih vej. `item_goal.js` rešuje AND/OR odvisnosti za predmete.
- `ActionManager` serializira akcije in obravnava prekinitve. Nova veščina mora spoštovati prekinitve in vrniti preverljiv izid.
- Sistemi za preživetje, kmetovanje, skladiščenje, odprave, obrambo in home life že obstajajo. Najprej jih poveži v ciljna zaporedja; ne piši podvojenih implementacij.
- Vsak bot je svoj proces. Deljeno stanje v `bots/` se koordinira z zaklepi in atomskimi zapisi; ne računaj na deljeni in-memory objekt.
- Telemetrija že piše `bots/<name>/debug-state.json` in `trace.ndjson`. Izkoristi jo za primerjavo vedenja pred spremembo in po njej.

## 3. Dejansko stanje in ozka grla

| Vrzel | Dokaz v kodi | Kaj pomeni za cilj |
| --- | --- | --- |
| AI načrt je zelo ozek | `planner.js` določa fokuse `base/build/farm/explore/stockpile/relax` in po potrebi `social`; `brain.js:focusAction()` jih preslika s `switch`. `project` je predvsem opis. | Model lahko predlaga namen, ne more pa načrtovati novega večstopenjskega projekta iz dovoljenih veščin. |
| Načrtovanje je vezano na dom | `brain.js:brainTick()` kliče skupinski in lokalni planner le v veji `if (!recoveryPending && home)`; `settings.auto_claim_home` je `false`. | Bot brez nastavljenega doma še vedno dela deterministično, vendar v tej poti ne dobi rednih AI načrtov. To je prva stvar za preveriti v igri in popraviti. |
| Cognitive controller večinoma sledi izboru | `cognition.tick(agent, act)` se pokliče po `chooseAction()`; sestavi namero za govor. | Govor je bolj skladen z dejanjem, vendar kognitivni sloj še ne oblikuje izbire cilja na podlagi celotnega stanja. |
| Raziskovanje nima dolgega obzorja | `survival.explore()` izbere naključen kot in kratko pot 12–25 blokov. | NPC ne odkriva sistematično sveta in ne uporablja topološkega spomina za prihodnje poti ali vire. |
| Spomin ni operativni zemljevid | `roleplay/memory.js:memoryContext()` razvrsti zapise pretežno po pomembnosti in času. | »Vem, kje je nevarna jama« ni enako kot podatek, ki ga lahko planner uporabi pri izbiri varne poti. |
| Uspeh posamezne akcije ni uspeh cilja | `action_outcome.js` spremlja inventar, premik, zdravje, hrano in podobne signale. | Premik sam lahko pomeni lokalni napredek, ne pa dosežka projekta; potrebni so kriteriji za celoten cilj. |
| Socialna avtonomija je omejena | `social_goals.js` generira pomoč, obisk, darilo, tekmovanje in pokrivanje vrzeli; izvedljivi socialni cilji so ožji. | Odnosi vplivajo na del vedenja, še ne pa močno na dolgoročno sodelovanje, učenje in specializacijo. |
| Ustvarjalna gradnja trenutno ni aktivna | `settings.allow_building=false`; del gradnje uporablja `/setblock`, `/fill`, teleport ali creative način. | Za »kot igralec« je treba ločiti survival dosežke od administrativne gradnje in jasno določiti želeni način igre. |
| Testi še ne merijo celotnega igranja | `npm test` je enotski/smoke paket; obstoječi checklist sam označuje in-game verification kot nedokončan. | Brez ponovljivih epizod ne vemo, ali NPC preživi, napreduje ali le ponavlja akcije. |

**Opomba glede nastavitev:** `base_profile="survival"`, `progression_target="diamond"`, `deterministic_brain=true`, `ai_enabled=true`, `planner_mode="hybrid"`, `allow_vision=false`, `allow_building=false`, `auto_claim_home=false` v trenutnem `settings.js`. Vse to so spremenljive nastavitve, zato pred vsako fazo preveri njihove dejanske vrednosti.

**Opomba glede starega RPG dela:** `src/agent/npc/controller.js` je še ena pot za profile z `npc` cilji. Ne predpostavljaj, da jo `brain.js` nadomešča povsod. Pri spremembi lastništva akcij preveri, kdo kliče `ActionManager`, da se zanki ne borita za istega bota.

## 4. Ciljna arhitektura

Obdrži hitro deterministično izvajanje; dodaj enoten cilj in povratno zanko:

```text
Senzorji / dogodki
  -> read-only AgentState + prostorski WorldModel
  -> kandidatni cilji (survival, owner, progression, social, AI, exploration)
  -> arbiter (obstoječi decision_graph)
  -> GoalPlan: odvisnosti + vrstni red + omejitve + dokaz uspeha
  -> katalog preverjenih Skills (deterministični executor)
  -> opazovanje izida v Minecraft svetu
  -> nadaljuj / popravi metodo / odloži / prekini / končaj
  -> spomin, deljeno stanje, telemetrija in govor iz istega dejanskega stanja
```

### Pogodba cilja, ne zgolj `focus`

Naslednji zapis je **predlog pogodbe**, ne trditev, da je že implementiran:

```js
{
  id: 'food-supply:west-camp',
  source: 'self|owner|society|milestone|safety',
  intent: 'Vzpostavi trajen vir hrane za pet članov',
  success: { kind: 'verified_state', predicate: 'foodReserveAndFarmReady' },
  priority: 0, urgency: 0, expectedValue: 0,
  constraints: { mode: 'survival', maxRisk: 0.3, maxMinutes: 30 },
  prerequisites: ['safeRoute', 'starterTools'],
  plan: [{ skill: 'scout_site', args: {} }, { skill: 'prepare_farm', args: {} }],
  state: 'proposed|active|waiting|blocked|failed|completed',
  evidence: [], blockers: [], nextReviewAt: null
}
```

Vsi AI izhodi naj gredo skozi shemo in validacijo **zoper trenutno stanje sveta**. Veljaven JSON še ni izvedljiv načrt. Model sme predlagati samo sposobnosti iz kataloga; koda določa dovoljene parametre, predpogoje, varnost, stop pravila in dokaz. Ko model odpove ali proračun poteče, NPC nadaljuje z determinističnimi cilji. Za OpenAI pot preveri aktualno uradno dokumentacijo za Structured Outputs in function calling; ne veži jedra sistema na enega ponudnika.

### Sloji odgovornosti

1. **Safety policy:** hrana, zdravje, nevarnost, reševanje, izrecni ukaz za stop. Prekinja nižje cilje; ne potrebuje modela.
2. **Goal arbiter:** izbira *kaj* je trenutno vredno doseči. Ohraniti pregledne score breakdowns in razloge v `!decisions`.
3. **Planner:** sestavi omejen večstopenjski načrt za izbrani cilj. Model prispeva alternativo in ustvarjalnost; koda preveri izvedljivost.
4. **Executor:** izvede eno veščino naenkrat prek ActionManager. Veščine vračajo `done/progress/waiting/blocked/failed/interrupted` in opazne dokaze.
5. **World model:** kraj, dimenzija, objekt, lastništvo, nevarnost, vir, pot, starost podatka in zaupanje v podatek. Loči opažanje od sklepa ali informacije drugega NPC-ja.
6. **Memory/social/speech:** uporabljajo dejanski cilj, dejanski korak in izid. Osebnost naj vpliva na izbiro med izvedljivimi alternativami, ne le na formulacijo stavka.

### Načelo player-like vedenja

Za vsako sposobnost določi, ali pripada **survival igranju** ali **admin/fantasy mehaniki**. Meri ju ločeno. V survival poti NPC nosi opremo, porablja vire, potuje, dela in se vrača; `/tp`, `/fill`, `/setblock`, `/gamemode` so izjeme ali ločen način delovanja. Obstoječe reševanje s teleportom je lahko nujna varovalka, vendar se mora v metriki označiti kot poseg.

## 5. Milestone razvoj

Statusi spodaj so za **novi razvojni program**. `[ ]` pomeni, da milestone kot celota še ni potrjen, tudi če njegove osnovne funkcije že obstajajo. Ne prepisuj zgodovinskih statusov iz starega checklist dokumenta brez preverjanja kode in igre.

### M0 — Merljiv baseline in odprava začetnih blokad `[ ]`

**Cilj:** imeti zanesljivo izhodišče, preden povečamo avtonomijo.

**Delo:**

- Popravi ali namenoma odstrani vezavo AI načrtovanja na `home`; bot brez doma mora še vedno dobiti izvedljive cilje, medtem ko domače in mestne naloge zahtevajo primerno bazo.
- Zabeleži jasen status `no-home`, `no-model`, `budget-cooldown`, `planner-invalid`, `plan-executable` v telemetriji.
- Uskladi namestitev paketov s `patches/`: svež `npm install` trenutno izbere novejši `mineflayer`, za katerega se popravek `mineflayer+4.37.1.patch` ne uporabi. Lokalno sta `mineflayer@4.37.1` in `minecraft-protocol@1.67.0` omogočila uspešno uporabo popravkov. Poskrbi za ponovljivo čisto namestitev, brez nenamerne posodobitve celotnega dependency drevesa.
- Določi eval scenarije in shrani baseline trace, modelne klice in stroške. Očisti zmedo v dokumentaciji med kingdom in RP town zagoni.

**Sprejem:** svež clone + install uporabi vse popravke; bot z domom in bot brez doma oba dobita smiselno nalogo; pri izklopljenem AI sistem nadaljuje; baseline report vsebuje merila iz poglavja 6. Statika + dejanski in-game test.

### M1 — Enotna pogodba ciljev in razbitje `brain.js` `[ ]`

**Odvisnost:** M0.

**Delo:** uvedi tip/schémo za `GoalCandidate`, `Goal`, `ActionOutcome` in `GoalEvidence`; razdeli `dynamicDecisionCandidates()` v čiste ponudnike za survival, progression, society, social, maintenance, AI in exploration. `brain.js` naj ostane orkestrator. Ohraniti obstoječo prednost safety/owner in delujoče ukaze. Jasno dokumentiraj, kdo je lastnik vsake vrste akcije (`brain`, owner, mode, legacy NPC controller).

**Sprejem:** ob istih snapshotih stara in nova politika izbereta enako dejanje, razen izrecno odobrenih sprememb; vse akcije imajo stalen cilj, razlog in izid; test zajame prekinitev, cooldown, neizvedljiv kandidat in ponovni poskus.

### M2 — Verifikacija cilja in popravljanje načrta `[ ]`

**Odvisnost:** M1.

**Delo:** razlikuj med dokončanim korakom in dokončanim ciljem. Vsak cilj ima `success predicate`, časovno omejitev, dokaz ter seznam blokad. Pri neuspehu preveri, kaj se je v svetu spremenilo, in poskusi drugo metodo, ne samo isto akcijo po backoffu. Shrani delno napredovanje prek restartov. Posodobi `!decisions`/telemetrijo z »zakaj še ni končano«.

**Sprejem:** simulirana neprehodna pot sproži alternativni načrt ali jasno blokado; lažno pozitivna akcija ne zaključi cilja; restart ne izgubi aktivnega projekta; in-game bot zna povedati, kaj mu manjka.

### M3 — Uporaben model sveta in namensko raziskovanje `[ ]`

**Odvisnost:** M1, vzporedno z M2, kjer ni konflikta.

**Delo:** zgradi perzistenten register POI, poti, virov, nevarnih območij, rudnikov, skrinj, postelj, delovnih postaj in gradbenih mest. Uskladi z že obstoječimi town/storage/mining podatki; ne ustvarjaj še ene nasprotujoče resnice. Podatki potrebujejo dimenzijo, koordinato, timestamp, izvor in stopnjo zaupanja. Raziskovanje naj izbere »najbolj koristno neznano območje«, se opremi, sledi poti, zabeleži odkritja in se vrne.

**Sprejem:** bot po restartu najde že odkrit vir; nevarnega ali neuspešnega prehoda ne ponavlja brez razloga; dve osebi lahko delita odkrito lokacijo; scout se vrne z opaznim poročilom ali jasnim blockerjem. To vključuje odprte točke POI registry/scouting iz `GAMEPLAY_IMPLEMENTATION_CHECKLIST.md`.

### M4 — AI načrtovanje iz kataloga veščin `[ ]`

**Odvisnost:** M2 in osnovni M3.

**Delo:** uvedi katalog veščin z opisom, argumenti, predpogoji, oceno stroška/tveganja in preverjanjem izida. AI lahko sestavi 2–8 korakov ter izbere med več metodami za isti cilj. Shema je striktna, izhod se validira proti trenutnemu stanju. Model naj dobi le relevanten povzetek stanja in zadnjih neuspehov. Ohraniti shared budget guard in deterministični fallback. Najprej podpri hrano, orodja, bazo, stockpile in kratko raziskovanje; ne odpiraj poljubne kode.

**Sprejem:** v treh različnih svetovnih stanjih model izbere različne izvedljive poti do istega cilja; ob manjkajočem orodju najprej pripravi orodje; ob izpadu modela bot nadaljuje; napačen ali nevaren plan je zavrnjen z razlogom in ne izvede dejanja.

### M5 — Celoten player-like lifecycle `[ ]`

**Odvisnost:** M2–M4.

**Delo:** poveži obstoječe module v cikel: oceni stanje -> izberi cilj -> loadout -> pot -> delo -> zbiranje plena -> vrnitev -> deposit/repair/food -> spanje/pavza -> nov cilj. Dodaj pripravo za daljšo odpravo, post-combat recovery, vzdrževanje orodja, delovne vrste pri peči/nakovalih/enchantingu, mine route registry in varno vrnitev. Razširi napredovanje po diamantu glede na dejansko verzijo 1.20.1 šele, ko so osnovni cikli stabilni.

**Sprejem:** bot več zaporednih igralnih dni preživi in napreduje brez ročnega reševanja; dolga naloga ne porabi vse hrane ali obstane s polnim inventarjem; zna predati zaloge in nadaljevati začeti cilj; število teleport/creative posegov je izmerjeno.

### M6 — Ustvarjalni projekti in gradnja `[ ]`

**Odvisnost:** M3–M5. `allow_building` je zdaj izklopljen; tega ne prižigaj kot dokaz, da je milestone končan.

**Delo:** AI naj predlaga *namen* projekta (npr. varno skladišče ob rudniku), omejitve prostora, stil in materiale. Koda pretvori namen v izvedljiv načrt, ga pokaže/validira, zaščiti obstoječe strukture in izvaja po majhnih korakih. Uporabi obstoječe schematics, town in build funkcije, po potrebi generiraj varne variante. Po gradnji preveri funkcionalnost: vrata, dostop, svetloba, storage, pot do drugih POI. Survival in admin način beleži ločeno.

**Sprejem:** zgradba je uporabna, dostopna in ne poškoduje zaščitenih blokov; projekt se prilagodi terenu/materialom; prekinitev/restart omogoča nadaljevanje; kreativen izbor je razviden iz načrta, brez izmišljenih dosežkov.

### M7 — Živa ekipa, karakterji in civilizacija `[ ]`

**To je osrednji produktni cilj**, ne kozmetični dodatek po survivalu. M7 se razvija vzporedno z M2–M6: M2/M3 dasta dokazljiv izid, M4 sestavljanje korakov, M5 igralni cikel, M6 skupni gradbeni projekt. Podroben tehnični načrt, podatkovne pogodbe in scenariji so v [SOCIAL_CIVILIZATION_DEVELOPMENT.md](SOCIAL_CIVILIZATION_DEVELOPMENT.md); ob posegu v te module preberi tudi `ALTERA_PLAN.md`.

**M7a — Osebnost z življenjsko zgodovino:** obstoječe profile obdrži kot začetno identiteto; AI predlaga osebne preference, strahove, ambicije in slog pogovora iz potrjenih izkušenj. Trajne spremembe morajo imeti dogodek, razlog in mejo. Različni NPC-ji ob enaki situaciji izberejo različne *izvedljive* poti, ne le različnih stavkov.

**M7b — Pogovor kot dejanje:** sporočilo ima namen in preverljivo semantiko (`request`, `offer`, `commit`, `handoff`, `report`, `warn`, `disagree`, `resolve`). Govor odraža resnične zaznave in trenutne obveznosti; ne sme ustvariti lažne obljube ali trditve o opravljenem delu. Prejemnik mora sporočilo zaznati, odgovoriti in lahko spremeni svojo izbiro cilja.

**M7c — Skupni projektni dogovor:** en trajen cilj vsebuje lastnika, sodelujoče, razdeljene podnaloge, odvisnosti, lastništvo virov, dokaze, rok in stanje. Dodelitve imajo lease/heartbeat, da reconnect ali offline bot ne zadrži dela. Ko član obstane, ekipa pomoč ponudi ali delo prerazdeli; player ukaz in safety ostaneta nad projektom.

**M7d — Odnosi, socialno učenje, kultura:** pomoč, prelomljena obljuba, reševanje in uspeh posodobijo obstoječi usmerjeni socialni graf. Norme (`culture.js`) naj nastajajo iz opaženih interakcij; vrednote morajo vplivati na dejanske odločitve. Spomin potrebuje epizode kdo–kaj–kje–izid, ne le besedilnega povzetka.

**M7e — Meritev emergentne ekipe:** večkrat ponovi scenarije s pomanjkanjem hrane, skupno gradnjo, offline članom, konfliktnima ciljema, nevarno lokacijo in večdnevnim delom. Primerjaj z izklopljenim socialnim slojem. Meri dokončane skupne cilje, podvojeno delo, predaje, uspešne prošnje, obnovo po izpadu, skladnost govora in dejanj ter razlike med karakterji. Brez in-game dokazov ostane M7 odprt.

**Sprejem:** ekipa samostojno izbere vsaj dva različna skupna cilja in ju dokonča z dokazom v svetu; en član pridobi vir, drugemu ga preda, tretji ga uporabi; projekt preživi restart in odsotnost člana; osebnosti različno vplivajo na strategijo pri istem začetnem stanju; pogovor pravilno napove ali poroča o dejanjih; ob izklopu modela varnost in osnovna kooperacija ostaneta delujoči.

### M8 — Dolgoročna evalvacija in tuning `[ ]`

**Odvisnost:** začne se pri M0, kot zaključni milestone teče po M4–M7.

**Delo:** avtomatiziran/ponovljiv harness za Minecraft 1.20.1 in kratke ter dolge epizode; primerjave politik/modelov na istih začetnih stanjih; zbiranje video/trace dokazov po potrebi. Analiziraj top 10 razlogov za zastoj, ceno modela na dokončan cilj, sodelovanje in raznolikost vedenja. Tuning temelji na dokazih, ne na vtisu iz enega posnetka.

**Sprejem:** vsaka pomembna sprememba ima baseline, novo meritev in primer epizode; ni regresije varnosti ali ukazov igralca; vedenjski rezultati se izboljšajo čez več semen sveta in vsaj en daljši zagon.

## 6. Evalvacija: kaj pomeni »NPC igra sam«

Za vsako epizodo zabeleži seed/svet, Minecraft strežnik, konfiguracijo, profile, trajanje, model in verzijo kode. Osnovni scenariji:

1. **Nov svet brez doma:** bot naj se orientira, poskrbi za hrano in varen kamp, brez tihega izpada AI plannerja.
2. **Pomanjkanje hrane:** poišče izvedljivo pot do stabilne zaloge, pri tem preživi in ne vrti ene neuspešne akcije.
3. **Rudarjenje in vrnitev:** pripravi opremo, varno pridobi cilj, se vrne in shrani plen; ob blokadi se umakne ali zamenja metodo.
4. **Izgubljen/prekinjen bot:** po reconnectu uporabi ohranjeno stanje in nadaljuje ali pojasni blokado.
5. **Gradnja na neidealnem terenu:** izbere izvedljivo mesto, ne uniči drugih struktur, zgradi funkcionalen objekt.
6. **Igralčev dolgoročni ukaz:** razume namen, ga razdeli na izvedljive korake, poroča o napredku in uspeh potrdi v svetu.
7. **Skupina:** deli informacije in vire, ne podvaja dela, reši konflikt dveh ciljev.
8. **Brez modela / brez API proračuna:** deterministične potrebe in varnost ostanejo delujoče.

Merila: delež dokončanih ciljev; preživetje in smrti; čas do prve hrane/orodja/varne baze; delež korakov z dokazom; ponavljanja brez napredka; uspešne vrnitve; posegi `/tp`/creative/admin; strošek in latenca AI na **dokončan cilj**; skladnost govora in dejanj; raznolikost dosegljivih strategij; število uspešno zaključenih skupinskih projektov. Ne optimiziraj samo števila akcij ali količine pogovora.

## 7. Pravila za nadaljnje delo

- **Pred začetkom preberi:** to datoteko, aktualni `settings.js`, relevantne kode, zadnje `trace.ndjson` za konkretno napako in zgodovinski `GAMEPLAY_IMPLEMENTATION_CHECKLIST.md` samo za zadevno področje.
- **Izberi najmanjši naslednji milestone**, ki odstrani blokado. Ne implementiraj M6 ustvarjalne gradnje, dokler osnovni cilji in verifikacija niso stabilni.
- **Ne dodajaj drugega arbitra ali vzporednega ActionManagerja.** Novi cilji morajo v isti tok odločanja in prekinitve.
- **Ne predpostavljaj, da je model povedal resnico o svetu.** Uporabi opažanja iz Mineflayerja, registriranih POI, inventarja in preverjenih rezultatov veščin.
- **Ne uporabljaj poljubno generirane kode za igro.** `allow_insecure_coding=false` naj ostane privzeto. AI načrti gredo skozi dovoljene veščine in validacijo.
- **Ohrani proračun AI klicev.** Vsak cloud klic mora uporabljati obstoječi skupni budget guard ali enakovredno centralno omejitev. Cene/modeli v kodi so zgodovinski; preveri aktualne podatke, če delaš poseg v zaračunavanje.
- **MC 1.20.1 je ciljna verzija.** Forge FML3 login obstaja; mod-specifični svet/paketi niso splošno podprti. Ne trdi drugače brez testa na ciljnem strežniku.
- **Piši smiselne teste:** čista odločitev, pogodba izida, konflikt, restart in konkretna regresija. Za »dela v igri« je nujen in-game dokaz.
- **Dokumenti niso dokaz.** Če starejši dokument pravi DONE, a aktualna koda/test tega ne potrdi, opiši dejansko stanje. Po milestoneu posodobi ta file in po potrebi povezane zgodovinske checkliste.
- **Repo-specifična namestitev:** `package-lock.json` je verzioniran, ključne odvisnosti za `patch-package` pa so pripete na točne verzije. Uporabi `npm ci`, da je namestitev ponovljiva.

### Minimalna preverjanja po spremembi

```text
npm run lint
npm test
npm run audit:minecraft
npm run eval:kingdom                 # povzetek trace, ko so boti že tekli
node tools/kingdom-status.js Blaz --trace 30  # ko kingdom teče
```

Za gameplay milestone dodaj še dokumentiran in-game scenarij z začetnim stanjem, ukazi, pričakovanim opaznim rezultatom, dejanskim rezultatom in lokacijo trace. Uspešen `npm test` sam po sebi ne pomeni uspešnega Minecraft igranja.

### Kako posodobiti to datoteko

Po vsakem milestoneu dodaj kratek zapis pod spodnji dnevnik: datum, milestone, kaj je nastalo, katera merila so bila preverjena, kaj je ostalo nedokazano in naslednja naloga. `[ ]` spremeni v `[x]` šele, ko velja celotno sprejemno merilo. Če je faza delna, pusti `[ ]` in napiši `PARTIAL`. Ohrani prvo poglavje dovolj kratko, da naslednji AI v dveh minutah razume sistem.

## 8. Razvojni dnevnik

- **2026-09-24 — blueprint ustvarjen.** Statično pregledani kingdom tok, konfiguracija, načrtovanje, arbitraža, napredovanje, spomin, socialni sloj, gradnja in testni skripti. Prejšnji lokalni `npm test`: 140/140 Node testov + 7/7 civilization smoke. In-game rezultat ni bil preverjen. Naslednji korak: **M0**.
- **2026-09-24 — M0 PARTIAL.** Odstranjena zahteva po nastavljenem domu za klic AI plannerja; fokus za posameznega člana se zdaj omeji na veščine, ki jih lahko izvede brez doma. Dodani so razlogi stanja plannerja v telemetriji, ponovljiva zaklenjena namestitev popravljenih odvisnosti in `npm run eval:kingdom` za povzetek trace. Regresijski testi pokrivajo no-home fokuse in povzetek trace. Strežnik na `localhost:25565` med delom ni poslušal, zato in-game sprejem M0 ter dejanski baseline večurne epizode ostajata odprta. Naslednji korak: preizkus na strežniku z botom brez doma in primerjava trace pred/po.
- **2026-09-24 — rudarski regresijski popravki.** Imena rud se razširijo tudi na deepslate različice; `lapis_lazuli` in `copper` poiščeta pravo rudo. Iskanje po potrebi pregleda več kandidatov, bakle in tlakovci v podzemnem rovu pa ne izločijo naravnega kamna. `npm run test:mining`: 10/10; `npm run check`: 155/155 Node testov, 7/7 civilization smoke, 1.20.1 audit uspešen. Test v dejanskem svetu ostaja odprt; naslednji korak je `npm run test:mining:live` ob zagnanem strežniku.
- **2026-09-24 — M7/S0 PARTIAL.** Civilizacijska smer je razdeljena na osebnost, semantično komunikacijo, skupni projekt, socialno učenje in in-game evalvacijo v `SOCIAL_CIVILIZATION_DEVELOPMENT.md`. Prvi izvedbeni rez: skupna obveznost za dostavo zalog po potrebi prejemnika, z lease, statusom in `playerCollect` dokazom. Skupinski planner in telemetry vidita nedavne obveznosti. Še ni prejemnikove potrditve, pogajanja, večstopenjskega projekta ali in-game dokaza.
