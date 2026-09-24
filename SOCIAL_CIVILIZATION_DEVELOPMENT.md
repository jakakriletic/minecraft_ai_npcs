# Razvoj žive NPC ekipe in civilizacije

Status: **S0 delno implementiran, brez potrditve v igri**. Ciljna verzija je Minecraft Java 1.20.1. Ta dokument razširi M7 iz `AGENTS.md`; za obstoječi ALTERA/PIANO sloj preberi tudi `ALTERA_PLAN.md`.

## 1. Produktni cilj

NPC naj bo prepoznaven posameznik, ki lahko samostojno igra Minecraft **in** pripada ekipi. Uspeh ni število izgovorjenih stavkov ali število modelskih klicev. Uspeh je opazna veriga: član nekaj zazna -> predlaga izvedljiv cilj -> se z drugimi dogovori -> vsak prevzame delo -> skupaj premaknejo svetovno stanje -> preverijo rezultat -> dogodek spremeni spomin, odnos in prihodnje izbire. En NPC mora znati sam preživeti; skupina mora ustvariti vedenje, ki ga posameznik sam ne more zanesljivo doseči.

Osebnosti naj nastanejo iz začetnih profilov **in** izkušenj. AI je uporaben pri interpretaciji dogodkov, oblikovanju ciljev, izbiri med izvedljivimi alternativami in naravnem pogovoru. Fizična dejanja, varnost, inventar, dosegljivost, lastništvo in dokaz rezultata ostanejo v deterministični kodi. Govor ne sme biti nadomestek za opravljeno delo.

## 2. Dejansko stanje danes

| Zmožnost | Implementacija | Meja |
|---|---|---|
| Začetna osebnost | `roleplay/personality.js`: ročni profili, lastnosti, slog govora; profil lahko vsebuje override | Razlike so večinoma začetno določene; trajna sprememba osebnosti skozi dogodke je omejena |
| Refleksija in spomin | `roleplay/{memory,reflection,events}.js`: beleži dogodke, redka AI refleksija povzame karakter in samopodobo | Povzetek ni strogo strukturiran vzročni spomin; dogodek še ne spreminja zanesljivo izbire konkretne metode |
| Govor | `roleplay/cognition.js`: govor po dejansko izbrani akciji, LLM vrstica z budget guardom in fallbackom | Stavek večinoma ne ustvari naslovljene naloge, ponudbe ali dogovora; prejemnik ga ne obravnava kot pogodbo |
| Odnosi | `roleplay/social_graph.js`: usmerjeno zaupanje, prijateljstvo, rivalstvo, dolg itd. | Model je številčen; malo je dokazov, da odnosi spremenijo daljše skupne projekte |
| Socialni cilji | `roleplay/{social_awareness,social_goals}.js`: modeli potreb drugih; pomoč, check-in, darilo, bias tekmovanja/pomanjkanja | Izvedljive akcije so predvsem kratke predaje/obiski; obljuba, pogajanje in reševanje spora še niso del pogodbe |
| Skupinska organizacija | `library/{society,planner}.js`: skupno stanje in zaloge, vloge, deljeni AI načrt po članih | Plan so posamezni fokusi; manjka trajen projekt z odvisnostmi, lease, ownerjem, dokazom in zamenjavo člana |
| Kultura | `library/culture.js`: nekaj številčnih norm, ki se približujejo med člani | To še ni bogata zgodovina običajev, institucij ali skupnih pravil, ki jih ekipa sama ustvari |

Vse zgoraj je pregled kode. `npm run check` meri regresije, ne prepričljivosti civilizacije. Pred oceno kakovosti v igri potrebujemo isti začetni svet, več ponovitev, trace in posnetke dogovorov ter dokončanih ciljev.

## 3. Pravila arhitekture

1. **En izvršilni tok.** `brain.js` in obstoječi decision graph/ActionManager ostanejo edini arbiter akcij. Socialni projekt ponudi `GoalCandidate`, ne zažene vzporednega krmilnika. Owner ukaz, boj, lakota in varnost imajo prednost.
2. **Dve ravni AI.** Redek skupinski plan določi *zakaj/kaj/kdo*; lokalni plan po potrebi določi *kako* iz kataloga veščin. Kratki pogovori razložijo ali uskladijo delo. Vsaka raven uporablja skupen proračun in lahko odpove brez izpada osnovnega vedenja.
3. **Razlika med namenom in dejstvom.** `proposed`, `committed`, `started`, `progress`, `verified_done`, `blocked`, `abandoned` so različna stanja. Sporočilo »prinesel sem železo« sme nastati šele po opazni predaji.
4. **Vse skupno stanje je restart-safe.** Boti so ločeni procesi. Uporabi obstoječe imenovane locke/atomic JSON, idempotentne ID-je dogodkov in omejeno velikost zgodovine. Ne dodajaj neskončnih per-tick logov.
5. **Osebnost je omejitev in preferenca, ne dovoljenje za halucinacijo.** Pogum lahko spremeni oceno tveganja, altruizem pripravljenost pomagati, redoljubnost prioriteto skladišča. Nihče ne more izbrati veščine brez opreme, varne poti ali dovoljenja.
6. **Jasna ločitev Minecraft dokazov.** Inventar, sprememba blokov, oddan predmet, pozicija, preživeta nevarnost, dokončana struktura in uspešen dostop do nje so dokazi. LLM izjava in `action.success=true` sama nista dokončanje projekta.

## 4. Podatkovne pogodbe, ki jih uvedemo postopno

### `SocialEpisode`

```json
{
  "id": "stable-event-id",
  "at": "ISO timestamp",
  "actors": ["Lara", "Blaz"],
  "kind": "request|offer|handoff|rescue|conflict|repair|joint_success",
  "place": {"dimension": "overworld", "x": 0, "y": 64, "z": 0},
  "projectId": "optional",
  "claim": "what was intended",
  "evidence": [{"type": "inventory_delta|transfer|block|position|action_result", "ref": "trace/event reference"}],
  "outcome": "verified|failed|unknown"
}
```

Epizoda je dejstvo, ne prosti LLM tekst. Model lahko doda kratko interpretacijo, ne more prepisati `evidence/outcome`. Spomin zna iskati po akterju, kraju, cilju, izidu in starosti. Neuspeh ostane na voljo za prihodnjo izbiro poti.

### `TeamProject`

```json
{
  "id": "stable-project-id",
  "purpose": "stockpile food for winter shelter",
  "proposer": "Maja",
  "owner": "Maja",
  "state": "proposed|active|blocked|verified_done|abandoned",
  "priority": "normal|urgent",
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp",
  "deadlineAt": "ISO timestamp",
  "constraints": {"dimension": "overworld", "noAdmin": true},
  "steps": [
    {"id": "food", "skill": "gather_food", "assignee": "Lara", "status": "assigned", "dependsOn": [], "leaseUntil": "ISO timestamp", "target": {"item": "bread", "count": 8}, "evidence": []},
    {"id": "deliver", "skill": "deliver", "assignee": "Blaz", "status": "waiting", "dependsOn": ["food"], "target": {"recipient": "Maja"}, "evidence": []}
  ]
}
```

V prvi iteraciji uporabljaj samo dovoljene vrste korakov in dejansko obstoječe veščine. Model predlaga namen in kandidate; validator odstrani izmišljene cilje, podvojene rezervacije, krožne odvisnosti, nemogočo opremo, nedosegljivega prejemnika in predolge roke. Projekt v `verified_done` preide šele, ko so terminalni dokazi vseh obveznih korakov validirani.

### `SocialMessage`

```json
{
  "id": "stable-message-id",
  "from": "Lara",
  "to": "Blaz",
  "projectId": "optional",
  "intent": "request|offer|commit|handoff|report|warn|disagree|resolve",
  "payload": {"item": "bread", "count": 4},
  "assertion": "intent|observed|verified",
  "expiresAt": "ISO timestamp",
  "utterance": "I can bring you food."
}
```

Strojno berljiv del krmili usklajevanje. `utterance` je predstavitev za ljudi in lahko uporablja AI; model ne sme samodejno dvigniti `assertion` na `verified`. Prejemnik potrdi, zavrne ali prosi za pojasnilo. Neodgovorjena ponudba poteče.

## 5. Zaporedje implementacije

### S0 — Merilna osnova in ozki skupinski kontrakt

- **Delno narejeno 2026-09-24:** `society.shareSupplies` je dobil skupno obveznost po `prejemnik:potreba` z zaklepanjem v `kingdom.json`, lease, poskusom, statusi `claimed/failed/delivered` in dokazom `playerCollect`. Načrtovalec vidi zadnje obveznosti, telemetry jih pokaže v debug snapshotu. To prepreči sočasno podvojeno dostavo iste potrebe z različnima predmetoma, dokler lease velja. Offline testi preverijo ključ in življenjski cikel lease.
- Dodaj poln `TeamProject` state z ID-ji, koraki, odvisnostmi, ownerjem in omejeno zgodovino. Začni s hrano/orodjem. Uporabi obstoječe `society.shareSupplies` in `social_goals`; ne piši nove poti za premikanje.
- Poveži plan z izidom akcije: obljuba/predaja/sprejem/poraba imajo ločene evidence. Ne zamenjaj `progress` za `done`. Po restartu ostanejo projekt in dodelitve, stale lease se sprosti.
- V telemetry in `kingdom-status` pokaži projekt, ownerja, podnaloge, zadnjo preverjeno spremembo in razlog blokade. Test: dve procesni instanci tekmujeta za isti korak; samo ena ga prevzame.

**Odprta meja trenutnega reza:** `playerCollect` je dokaz, ki ga vidi darovalec; še ni prejemnikove potrditve inventarja/porabe. Kratka supply obveznost še ni večstopenjski `TeamProject`, nima pogajanja in ni bila preizkušena na strežniku. Ne označi S0 ali M7 kot končanega.

### S1 — Osebna zgodovina in odločitve

- Ohraniti ročne profile kot seed. Dodaj `PersonalState`: trenutne preference, posebne spretnosti, navade, strah pred preverjeno nevarnostjo in dolgoročno željo. Vsaka sprememba shrani izvorno epizodo, smer, omejeno velikost premika ter datum; brez samovoljnega prepisovanja prvotne identitete.
- Refleksija lahko predlaga spremembo, validator jo omeji. Primer: po več varnih rudarskih vrnitvah je bot manj zadržan pri jamah; po skorajšnji smrti previdnejši. V naslednjih identičnih stanjih to spremeni rang *izvedljivih* ciljev.
- Testiraj kontrafaktualno: zamenjaj osebnosti ob istem svetu, orodjih in ciljih; vsaj v nekaterih situacijah se mora spremeniti izbrana metoda, ne le govor.

### S2 — Semantični dialog in dogovor

- Komunikacija potuje med boti kot preverljiv dogodek. Govorjenje ne pomeni sprejetja naloge. Dodaj response/timeout in deduplikacijo ID-jev. Chat sporočilo je lahko javna razlaga, vendar strojni namen nastane iz validirane ponudbe.
- Vzorec: Maja zazna pomanjkanje; prosi Laro za hrano; Lara preveri svoje zaloge in odgovori da/ne; po sprejetju nastane projektni korak; po fizični predaji oba posodobita projekt/spomin/odnos. Če je Lara lačna, ne sme obljubiti lastne zadnje hrane.
- AI lahko oblikuje naravno besedilo in predlaga ponudbo, ne pa lažno potrditi materialnega izida. Testiraj ponavljajoč chat, zamujene odgovore, reconnect in chat spam budget.

### S3 — Razdelitev dela in predaje

- Projekt naj ima graf odvisnosti in veščin. Razdeli gather -> craft -> deliver -> use/build med različne člane na podlagi opreme, razdalje, aktualnih nalog, odnosa in preference; najmanjši možni strošek ni edini kriterij.
- Ko NPC naleti na blokado, pošlje strukturirano prošnjo (`need_tool`, `route_blocked`, `recipient_offline`, `inventory_full`). Ekipa poskusi pomoč ali reassign. Lease se podaljšuje samo ob dejanskem delu, ne vsak tick.
- Spremembe skupnega inventarja/rezervacije se izvajajo pod lockom. Ne označi dostave kot končane, dokler prejemnik nima predmeta ali ga ni prevzel iz znanega zabojnika.

### S4 — Skupna gradnja in dolgoročna civilizacija

- Poveži M6 s projektom: predlog stavbe -> izbira mesta/stila -> zaščita prostora -> materialna lista -> transport -> gradnja -> funkcionalni pregled. Kreativnost je v raznolikih izvedljivih načrtih in pogajanju o prioritetah, ne v čarobno ustvarjenih blokih.
- Socialni graf posodobi z uspehi, neuspehi, spori in popravo odnosa. Kultura hrani majhen nabor norm in dokaz, kateri dogodki so jih spremenili. Člani lahko predlagajo novo skupno pravilo; uporaba se mora poznati pri izbiri nalog.
- Spremljaj dolgoročno ravnovesje: specializacija naj ne zaklene člana v eno vlogo, tekmovanje naj ne blokira survival dela, govor naj ostane redek in smiseln.

## 6. Prednostni primeri za razvoj in preverjanje

| Scenarij | Opazni uspeh | Kritični neuspeh |
|---|---|---|
| Dva NPC-ja in en lačen član | En zazna potrebo, drugi prinese hrano; prejemnik jo dejansko dobi/poje | Oba samo govorita o hrani ali podarita zadnjo lastno hrano |
| Skupna zaloga orodij | Eden zbere material, drugi izdela kramp, tretji ga uporabi | Dva ista koraka brez dogovora; plan šteje craft kot dostavo |
| Član offline sredi naloge | Lease poteče, korak dobi drug član, rezultat se ne podvoji | Projekt večno čaka ali dve instanci hkrati zapišeta uspeh |
| Nevarna jama | Opozorilo spremeni izbiro poti/ekipe in ostane v lokacijskem spominu | Bot ponovi isto nevarno pot kljub opozorilu |
| Različni karakterji | Enako stanje da vsaj dve izvedljivi strategiji z razložljivo osebno preferenco | Različen je samo stavek, delo identično |
| Konflikt interesov | NPC-ji se dogovorijo o prioriteti, nezadovoljstvo se pozneje lahko popravi | Neskončno prepiranje ali skrivni preglas safety/owner ukaza |
| Večdnevna gradnja | Dokončana uporabna zgradba z deljenim delom po restartu | Model razglasi dokončanje na osnovi enega `success=true` |

Meritve na epizodo: dokončani *verificirani* skupni cilji, čas do dogovora in dokončanja, število podvojenih akcij, uspešne predaje, stale lease, ponovne dodelitve, posegi igralca, preživetje, skladnost govora/akcije, raznolikost strategij pri istih seedih, AI tokeni na dokončan cilj. Primerjaj socialni sloj ON/OFF ob istem svetu in profilu ter vsaj treh seedih. Zabeleži tudi neuspešne epizode in top 10 vzrokov.

## 7. Kaj je naslednji najmanjši vertikalni rez

Nadaljuj s projektom **»nahrani člana«**. Osnovni claim in darovalčeva potrditev prevzema že obstajata; dodaj prejemnikovo potrditev, uporabo hrane in predajo iste obveznosti ob izpadu člana. Projekt mora nato ustvariti realno pogodbo med dvema botoma. Šele ko deluje pri reconnectu in z omejenim AI budgetom, uporabi isti mehanizem za orodje, odpravo in skupno gradnjo. Tako se abstrakcija preveri v igri, preden jo razširimo na vse vrste projektov.
