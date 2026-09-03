# Altera-like preobrazba NPC sistema

Datum: 2026-06-30

Ta sprememba premakne RP NPC-je iz "urnik + job + dialog" v bolj Altera-like model:
vsak NPC ima notranji nacrt dneva, skupni mestni spomin, socialne cilje, davke,
kulturo, javni sloves in posledice svojih dejanj.

## Novi glavni deli

### OpenAI LLM routing

`src/rp/chat/llm.js` zdaj podpira OpenAI Responses API kot primarni provider.

Trenutna nastavitev v `src/rp/config/settings.json`:
- `provider: "openai"`;
- `model_pogovori: "gpt-5.4-mini"` za pogovore z igralcem in pomembne dialoge;
- `model_ozadje: "gpt-5.4-nano"` za refleksije, povzetke, socialne beat-e in ozadje;
- `model_fallback: "gemma3:12b"` prek Ollame, ce API pade ali je budget presezen;
- `daily_budget_usd: 2.0`.

Ključ se prebere iz `OPENAI_API_KEY` v `keys.json`, `.env`, `.env.local` ali sistemskem environmentu.

Pomembno: `node --check` in lint ne naredita testnega API klica. Prvi pravi klic se zgodi sele, ko NPC v igri potrebuje LLM odgovor.

### Selektivne chat reakcije

`src/rp/chat/listener.js` zdaj deluje kot attention system:
- direktni nagovor po imenu/id skoraj vedno sprozi odgovor;
- aktivni pogovor se nadaljuje naravno;
- vprasanja, pozdravi, nujne besede in skupinski nagovori lahko sprozijo ambient odgovor;
- navaden klepet v blizini NPC vcasih samo slisi in si ga zapomni kot govorico;
- globalni cooldown preprecuje, da bi vsi NPC-ji hkrati odgovorili na isti stavek;
- NPC cooldown preprecuje, da bi isti NPC prevec govoril.

Nastavitve so v `src/rp/config/settings.json` pod `chat_reactions`.

### `src/rp/state/civicState.js`

Skupni um mesta. Shrani se v:

```text
src/rp/state/town_mind.json
```

Vsebuje:
- aktivne zakone;
- davcni ledger po dnevih;
- kulturne meme/navade;
- javne dogodke;
- reputacijo NPC-jev.

### `src/rp/systems/mind.js`

Centralna Altera-like plast za posameznega NPC-ja.

Vsak NPC dobi:
- `daily_goal`;
- `social_goal`;
- `civic_goal`;
- `personal_goal`;
- `current_intention`;
- znane kulturne meme;
- prepricanja o davkih, mestu in zakonitosti.

Mind tick ne pathfinda direktno. Samo izbere naslednjo `pendingAction`, ki jo nato varno izvede glavni NPC scheduler.

### `src/rp/systems/social_bonds.js`

Formalni socialni model med NPC-ji.

Vsak par NPC-jev ima locen odnos:
- naklonjenost (`affinity`);
- zaupanje (`trust`);
- spostovanje (`respect`);
- simpatija/toplina (`romance`);
- napetost (`tension`);
- poznanost (`familiarity`);
- status: `acquaintance`, `known`, `friend`, `close_friend`, `ally`, `strained`, `rival`, `sweetheart`;
- kratka zgodovina sprememb.

Sistem dela poceni, deterministično osnovo:
- NPC-ji med prostim casom sami izberejo, s kom bi govorili;
- odnos se spreminja zaradi pogovorov, govoric, trgovanja, pomoci, konfliktov in aretacij;
- ce je igralec blizu, se pogovor lahko odigra v chatu;
- ce igralca ni, se odnos vseeno posodobi v ozadju.

Dodano je tudi prvo fizicno dejanje pomoci:
- ce je NPC lacen in drugi NPC nosi hrano, mu lahko hrano dejansko vrze;
- prejemniku se dvigne sitost;
- javni mestni spomin zabelezi pomoc.

## Kaj NPC-ji zdaj delajo

### Marko

Default je postal `woodcutter`.

Vedenje:
- dela v `gozd_sever`;
- del lesa nosi v `mestna_zaloga`;
- del obdrzi zase;
- socialno je bolj tih in zanesljiv;
- davke podpira pragmaticno, ce vidi korist.

### Ana

Default je postala `innkeeper` in vendor.

Vedenje:
- ostaja pri `gostilna`;
- pobira placila;
- deluje kot socialni hub;
- lazje siri govorice in lokalne navade;
- v promptu dobi vec mestnih novic.

### Tone

Default je postal `policeman`.

Vedenje:
- patruljira center;
- preverja davcni ledger;
- kriminal in aretacije zapisuje v javni mestni spomin;
- javna zaloga in zakoni vplivajo na njegov dialog.

## Nove posledice

### Davki

Aktiven je zakon `basic_tax`.

Po koncu sihta NPC odda del uporabnih surovin v `mestna_zaloga`, ce jih ima pri sebi.
Ledger shrani, kdo je placal in kaj je oddal.

### Javni sloves

Dogodki zdaj spreminjajo javni ugled:
- trgovanje rahlo dvigne zaupanje/spostovanje;
- kraja, vlom ali aretacija znizajo javno zaupanje;
- witness sistem vpliva na reputacijo, ne samo na zasebne odnose.

### Kultura

Mesto ima meme/navade:
- javne zaloge se ne prazni na skrivaj;
- novice zivijo na trgu ali v gostilni;
- Tonetova fraza "Pocasi, saj ni panike."

NPC-ji jih lahko sprejmejo, ponovijo in sirijo drugim NPC-jem.

### Socialni bondi

NPC-ji zdaj ne gradijo samo abstraktnega zaupanja, ampak formalne odnose:
- prijatelji;
- bliznji prijatelji;
- zavezniki;
- rivalstva;
- napeti odnosi;
- simpatije.

Ti odnosi vplivajo na:
- s kom NPC sam zacne pogovor;
- komu ponudi pomoc;
- komu verjame;
- koga spostuje;
- kdo postane vpliven glas v mestu;
- kako se pogovarja z igralcem o drugih NPC-jih.

### Voditeljstvo in druzabni krogi

`CivicState` iz socialnih vezi, javnega ugleda, spostovanja in osebnostnih lastnosti izracuna:
- top vplivne NPC-je;
- neformalne druzabne kroge;
- osebno voditeljsko preferenco vsakega NPC-ja.

To ni uradna oblast, ampak socialna struktura: kdo ima besedo, komu ljudje zaupajo, okoli koga se zbirajo.

### Prompt

NPC dialog zdaj vidi:
- notranji dnevni nacrt;
- socialni cilj;
- skupnostni cilj;
- javna pravila;
- lokalne fraze/navade;
- zadnje javne dogodke;
- svoj javni sloves.

## Novi ukaz

```text
!mesto
```

Vrne kratek status skupnega mestnega uma: dan, aktivni zakon, kdo je placal prispevek in najjaca kulturna navada.

`!status <npc>` zdaj izpise tudi `mind:` vrstico z dnevnim ciljem in trenutnim namenom.

```text
!odnosi <npc>
```

Izpise najpomembnejse socialne vezi NPC-ja: status odnosa, naklonjenost, zaupanje in napetost.

## Testiranje

Preverjeno:

```text
node --check <spremenjene js datoteke>
npx eslint <spremenjene rp datoteke>
node -e "Promise.all([import('./src/rp/state/civicState.js'), import('./src/rp/systems/mind.js')]).then(() => console.log('imports ok'))"
```

Za test v igri:

```text
node rp.js
```

Potem v Minecraft chatu:

```text
!mesto
!status marko
!status ana
!status tone
!odnosi ana
```

Prakticni pogoji:
- v `mestna_zaloga` naj bo skrinja/barrel, da lahko NPC-ji oddajajo prispevke;
- v `obcina` naj bo skrinja z zlatom za place;
- `gozd_sever`, `gostilna`, `center` naj bodo realne lokacije v svetu.
