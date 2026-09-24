# Kingdom NPC: AI, avtonomija in gameplay — skupni razvojni načrt

> Stanje: statični pregled kode 2026-09-24, cilj Minecraft Java 1.20.1. »Obstaja« pomeni, da je pot v kodi, ne da je bila uspešno odigrana na strežniku. Ta datoteka je vstopna točka za nadaljnji razvoj; podrobnosti arhitekture so v [AGENTS.md](AGENTS.md), družbe v [SOCIAL_CIVILIZATION_DEVELOPMENT.md](SOCIAL_CIVILIZATION_DEVELOPMENT.md), znane rudarske napake v [MINING_OVERVIEW.md](MINING_OVERVIEW.md).

## 1. Cilj in dejanska arhitektura

Pet aktivnih kingdom botov (`Blaz`, `Nejc`, `Lara`, `Zan`, `Maja`) teče v ločenih procesih. `main.js` jih zažene, `src/agent/library/brain.js` izbere dejanje prek `decision_graph.js`, `ActionManager` ga izvede, `action_outcome.js` oceni lokalni izid. `planner.js` pripravi skupinski in osebni AI fokus, `roleplay/cognition.js` in socialni moduli dodajo namero, govor in odnose. Mineflayer je uporaben izvršilni sloj; ključni razvoj je zanesljivo zaporedje ciljev, preverjanje rezultata v svetu in usklajevanje botov, ne menjava ogrodja.

**Ciljni cikel:** opazovanje → predlog cilja (AI, napredovanje, igralec, družba) → preverba pogojev, cene in tveganja → razbitje na deterministične veščine → izvedba → dokaz spremembe inventarja/sveta/odnosa → popravek ali opustitev. AI sme izbrati namen in ustvarjalno rešitev iz omejenega kataloga; nevarne ali nesmiselne akcije blokira executor. Socialna namera mora vplivati na dejanske naloge (pomoč, delitev dela, zalog), ne samo na besedilo.

## 2. AI integracija in stroški

### Trenutni tok

- Vsi aktivni profili imajo `model` in `code_model` = `gpt-5.4-mini` (`profiles/*.json`). `code_model` ustvarja skupinski načrt; `chat_model` lokalne načrte, govor, pogovore in pozive iz `src/models/prompter.js`.
- `settings.js`: `ai_enabled=true`, `planner_mode=hybrid`, `society_planner_interval_minutes=5`, lokalni interval 2 min z jitterjem, `local_planner_allow_cloud=true`, `planner_budget_usd=2` na 10 ur, največ 900 klicev v oknu. Govor in socialni pogovori uporabljajo del skupne planner omejitve.
- Skupinski/osebni plan danes pretežno izbira omejen `focus`; `brain.js` ga pretvori v znano rutino. `project` večinoma opisuje namen. Brez doma oziroma aktivne ustrezne poti skozi `brainTick` se planner morda sploh ne kliče; to je treba preveriti v živo.
- Rezervacija v `planner.js` je cenovni približek za GPT-5.4 mini, ne univerzalna dejanska omejitev računa. Neposredni klici v `prompter.js` (npr. običajen chat in nekateri drugi pozivi) niso vsi na isti rezervacijski poti. `Gemini` in `DeepSeek` adapterja ne vračata primerljive `last_usage` in ne sprejmeta vseh `requestParams`; zamenjava modela sama po sebi ne zagotovi pravilnega obračuna. `gpt.js` ob delu napak vrne besedilo »My brain disconnected, try again.«, ki lahko zgleda kot uspešen modelni odgovor.

### Priporočena zasnova

1. En `AIRequestGateway` za **vse** klice: kategorija (`group_strategy`, `microplan`, `dialogue`, `speech`, `memory`), bot, model, omejitev tokenov, timeout, ponovitve, dejanska poraba in strošek. Rezervacijo in poračun delaj z dejanskimi cenami iz konfiguracije modela; ne z eno hardkodirano tarifo. Per-bot in skupinska omejitev, metrika porabe na uspešno zaključen cilj.
2. Različni modeli po nalogi. Za začetek en OpenAI API ključ: `gpt-5.4-mini` za skupinsko strategijo in zahtevnejši dialog; `gpt-5.4-nano` za kratko rangiranje/mikroplan/govor **šele po evalvaciji**. Templates ali lokalni Ollama za banalne ambientne replike. Ne pošiljaj modelu celotnega sveta; pošlji kratek strukturiran snapshot z dokazljivimi dejstvi.
3. Modelni izhod kot stroga shema: `goal`, `why`, `preconditions`, `skillSteps`, `successPredicate`, `abortPredicate`, `resourceBudget`, `assignees`. Validacija, omejene vrednosti, idempotentni ukazi, brez poljubne kode ali neomejene gradnje. Napake adapterjev naj bodo tipizirane; planner naj jih šteje kot napake in uporabi deterministični fallback.
4. Pred zamenjavo modela zberi 30–50 enakih stanj in primerjaj veljavnost sheme, realizem načrtov, delež dokončanih nalog, zamike ter USD na dokončan cilj. Cene niso merilo kakovosti avtonomije.

**Cene (USD na 1M besedilnih tokenov, standardni API, preverjeno 2026-09-24):**

| Model | Vhod | Izhod | Vloga / omejitev |
| --- | ---: | ---: | --- |
| [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini) | 0,75 | 4,50 | Dober začetni kandidat za strategijo; že nastavljen. |
| [GPT-5.4 nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano) | 0,20 | 1,25 | Poceni za ozke naloge; kakovost Minecraft planov še neizmerjena. |
| [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/pricing) | 0,30 | 2,50 | Alternativa po popravilu adapterja in primerjalnem testu. |

Preveri uradne cenike pred spremembo konfiguracije. Ključ naj ostane v lokalnem okolju oziroma zasebni konfiguraciji, nikoli v repozitoriju. Omejitev `planner_budget_usd` trenutno ni jamstvo za celoten račun.

## 3. Gameplay: stanje, vrzeli in vrstni red

| Področje | Kar že obstaja | Kaj manjka za res samostojno igro |
| --- | --- | --- |
| Preživetje, hrana, poti | `survival.js`, `loadout.js`, `brain.js`; varnostne prioritete, hrana, navigacijski timeouti | Ponovljivo dokazati preživetje več dni brez teleport reševanja; meriti smrt, lakoto, izgubo inventarja, vrnitev domov. |
| Rudarjenje diamantov | `mining.js`: skupne odprave, iron-or-better kramp, ciljni Y, veje, trail in umik; `progression.js` zahteva diamante | Popraviti točno ciljanje rude, potrditev pobranega dropa, izbiro smeri ob blokadi, ponovitve deljenega stanja in osvetlitev. Glej [MINING_OVERVIEW.md](MINING_OVERVIEW.md) #6–11. Uspeh naj pomeni diamant v inventarju in nato v skladišču, ne razbit blok. |
| Diamantno orodje in oklep | `progression.js` izdeluje pickaxe/axe/sword ter štiri dele oklepa, material lahko vzame iz baze ali sproži odpravo; delne nadgradnje niso blokirane s ceno celotnega seta | Končna politika razdelitve redkih diamantov med člane in prioriteta kramp → ključni obrambni deli → drugo; rezervacije ob sočasnem craftanju; dokaz dejansko opremljenega seta. |
| Boljša oprema vedno v uporabi | `claimSharedEquipment()` primerja razred in tier, enchant ter durability; `armorManager.equipAll()` se kliče na nekaj mestih; `loadout.bestTool()` ocenjuje tier | Enotna, periodična in ob spremembi inventarja sprožena odločitev po slotu/namenu. Zdaj `maintainTools()` pregleda prvi ujemajoči se predmet, kar lahko spregleda boljši drugi kramp; različni moduli uporabljajo različne ocene. Preveriti tudi dejansko opremo in izbiro orodja pri vsakem delu. |
| Popravilo in nakovalo | `progression.js` zna izdelati/postaviti anvil; worn tools se pretežno nadomestijo z novimi | Ni gameplay cikla `openAnvil`/združevanje/popravilo ali odločitve, kdaj je popravilo vredno XP/materiala. Dodati varovanje dragih enchantov, `too expensive`, poškodovanega nakovala in povratka predmeta. |
| Enchanting | `enchanting.js` pod zaklepom vzame opremo in lapis iz javnega skladišča, uporabi XP in predmet vrne; `progression.js` cilja mizo in 6 knjižnih polic | Ni načrtnega XP vira, cilja za 15 pravilno razporejenih polic za višje stopnje, vloge/koristnosti enchantov ali zanesljivega cikla osebna najboljša oprema ↔ skupno enchantanje ↔ equip. Izbira je trenutno najvišja dostopna opcija, ne najbolj uporabna. |
| Farming in živina | `farm.js`: trajna namakana 9×9 pšenična parcela, zrelo žetje, ponovna setev, kruh, luči/komposter; krave, prašiči, kokoši z razmnoževanjem in trajnostnim odvzemom | Razširiti na krompir/korenje/rdečo peso po potrebi, obravnavati manjkajoča semena in neprimeren teren, zalogo hrane za odprave, kuhanje/razdeljevanje ter merjenje neto donosa. Sedanja poljska zanka je pšenica. Živinoreja je odvisna od razpoložljivih odraslih živali in krme. |
| Skladišče, logistika, delitev | `storage.js`, `base.js`, `container_lock.js`, `container_index.js`; javna zaloga in zaklepi | Enotna rezervacija materialov za cilje, poštena delitev brez podvajanja, prenos plena/XP/lapisa do uporabnika, okrevanje po prekinjeni transakciji. |
| Boj in raziskovanje | `combat.js`, `guardian.js`, kratko `survival.explore()` | Izbira orožja/oklepa po nasprotniku, bolj varni umik in reševanje soigralca; svetovni zemljevid virov/nevarnosti in sistematično raziskovanje namesto kratkih naključnih smeri. |
| Gradnja, naselbina, civilizacija | `build.js`, `town.js`, `roads.js`, socialni moduli | `allow_building=false`, zato ustvarjalna gradnja trenutno ni aktivna. Nekatere gradbene poti uporabljajo ukaze/creative; za pošten survival cilj je treba določiti dovoljen način izvedbe in preveriti porabo materiala. Socialni projekti naj se končajo z realnimi spremembami sveta in odnosov. |

### Pravila, ki jih mora imeti oprema

**En vir resnice za kakovost.** `EquipmentPolicy` naj razvrsti predmete po slotu in nalogi, ne le po imenu: minimalna harvest stopnja in hitrost orodja, armor/toughness, tip orožja, koristni enchantmenti (Efficiency, Fortune/Silk Touch glede na rudo; Protection, Unbreaking, Mending itd.), preostala vzdržljivost, cena popravila, razpoložljivost rezerv. Zlato ne sme zmagati zgolj zaradi hitrosti, če ne pobere ciljne rude. Enchanted iron lahko v nekaterih nalogah premaga navaden diamond; primerjavo določi po uporabnosti za delo, ne po enem tier številu.

Ob `inventoryUpdate`, po craftu, prevzemu iz skladišča, enchanting rezultatu, obrabi ali pred zahtevno nalogo: primerjaj **vse** predmete in trenutno opremljeni slot; opremi boljšega, šibkejšega shrani ali uporabi kot rezervo. Ne spreminjaj orodja med akcijo. Pokvarjen predmet oziroma premajhna harvest stopnja je trd blocker. Zabeleži `before/after` slot, razlog in uspešnost `equip` klica. Zaščiti trenutno najboljši kos pred avtomatskim deponiranjem ali porabo v nakovalu.

**Popravilo:** pri razumnem pragu obrabe poskusi Mending/XP, nato anvil z enakim predmetom ali materialom, nato izdelavo/nakup nadomestila; odločitev temelji na ceni XP/materiala in enchantih. Če postopek odpove, ohrani original in izberi varno rezervno orodje. Skladiščne operacije in anvil imajo zaklep in jasno povrnitev predmetov ob prekinitvi.

### Cikel do diamantne opreme

1. Pripravi hrano, bakle, rezervni iron pickaxe, prazne slote in pot za umik; preveri zdravje/stradanje in trenutno verzijo sveta. `preferredOreY()` iz `survival.js` naj ostane vir za ciljni Y, dokler ga ne potrdijo rezultati na konkretnem strežniku.
2. Rezerviraj ekspedicijo in cilj, zapiši vhod/trail; koplji varno z reakcijo na lavo, odprto jamo in blokado. Nabiraj **točno odkrito** rudo, preveri inventar/drope in število diamantov; neuspeh spremeni pot oziroma nalogo.
3. Vrni se po trailu in odloži plen v javno zalogo. Cilj je dokončan šele po potrjeni zalogi. Če se je vrnitev zasilno rešila s teleportom, to zabeleži kot neuspeh navigacije, ne uspešno avtonomijo.
4. Skupinska politika rezervira prve diamante za kramp in nato določi obrambne nadgradnje po vlogah/tveganju. Craft, equip in skladiščenje slabših kosov imajo ločene dokaze uspeha. Predhodni cilj ne sme čakati na vseh 24 diamantov za oklep, če je prva koristna nadgradnja dosegljiva.
5. Napredna oprema sproži XP/lapis/knjižne police/enchanting in nato popravilo. Brez virov sistem ostane na varnem, uporabnem tierju in prijavi konkretno oviro.

### Farming in ekonomija hrane

Pšenica je uporabna osnova, ni pa celoten prehranski sistem. Ciljna politika: minimalna zaloga hrane na bota in na odpravo, rezervna semena, več kultur glede na podnebje/teren in potrebe živine, pobiranje samo zrelih rastlin, takojšnja ponovna setev, skladiščenje presežka ter priprava bolj hranljive hrane, kadar je ekonomsko upravičena. Ko parcela ne uspe, bot ne sme neskončno ponavljati setve: zabeleži razlog (voda, svetloba, semena, zaseden blok, pot) in izberi popravek ali novo lokacijo. Za živino preveri varno ogrado, razmnoževalne starše, krmo in dejanski prirast pred zakolom.

## 4. Prioritetni milestonei

| Faza | Delo | Sprejemni kriterij |
| --- | --- | --- |
| G0 — merjenje | Dodaj epizode na strežniku, posnetek začetnega sveta, metrike za cilj, smrt, teleport reševanje, inventar in strošek AI | Ponovljiv 2–4 urni baseline petih botov; rezultat loči uspeh akcije od uspeha cilja. |
| G1 — rudarski krog | Popravi [znane točke #6–11](MINING_OVERVIEW.md), ekspedicijske locke, pobiranje dropov in povratek | V več zaporednih svežih svetovih bot pridobi diamant s pravim krampom, se naravno vrne in ga dokazano odloži; vsaka izguba ima vzrok. |
| G2 — oprema | Centralni `EquipmentPolicy`, inventory event in slot verification, skupinska rezervacija diamantov, vzdrževanje vseh slotov | Ob boljšem oklepu/orodju ga bot opremi; slabšega ne zamenja brez jasnega razloga; diamantna veriga deluje brez dvojne porabe. |
| G3 — hrana | Razširi farmo na več kultur in oskrbovalni cilj za odprave, robustna živinoreja | Pet botov ohranja dogovorjeno zalogo hrane skozi več Minecraft dni brez ročnega dodajanja. |
| G4 — enchanting/repair | XP načrt, polna knjižnična postavitev, izbira enchantov po vlogi, anvil transakcije | Oprema preide iz skladišča skozi enchanting/repair nazaj v pravilni slot; inventar in XP sta skladna tudi po prekinitvi. |
| G5 — AI orkestracija | En gateway, sheme, model routing, izidi celih ciljev, socialne zadolžitve | AI izbere izvedljiv večstopenjski cilj, naloge so razdeljene, 30–50 fiksnih stanj se evalvira, USD na dokončan cilj je viden. |
| G6 — dolga avtonomija | Prostorski spomin, raziskovanje, adaptacija po neuspehu, preživetje in dejanski družbeni projekti | Večurna epizoda brez lastnikovega ukaza: boti preživijo, ustvarijo/izboljšajo zaloge in opremo, se usklajujejo in dokazano končajo vsaj en skupinski projekt. |

Za vsak milestone: unit/integration test za pravilo ali stanje, nato dejanska epizoda na strežniku. Ne spreminjaj oznake v »potrjeno« samo na podlagi `npm test`. Pri razvojnih posegih posodobi to datoteko, [AGENTS.md](AGENTS.md) ter ustrezni podrobni dokument; obdrži en sam aktualen status.

## 5. Kaj implementirati najprej

Prvi praktični paket je **G0 + G1 + začetni G2**: merilni scenarij, odprava z dokazanim diamantnim dropom in vračilom, nato enoten izbor/equip najboljšega krampa in oklepa. Ta paket zapre ključni razkorak med »v kodi obstaja diamond armor« in »NPC ga sam dejansko pridobi ter uporablja«. Ko ta zanka deluje, ima smisel dodati XP, enchanting, anvil in ustvarjalne AI cilje, ki jih NPC lahko res izvede.
