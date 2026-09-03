# Altera AI NPC-ji - podroben opis za Mindcraft

Datum raziskave: 2026-06-30

Glavni viri:
- Altera / Project Sid paper: https://arxiv.org/html/2411.00114v1
- Project Sid GitHub: https://github.com/altera-al/project-sid
- OpenAI case study o Alteri: https://openai.com/index/altera/
- Altera Substack povzetek: https://digitalhumanity.substack.com/p/project-sid-many-agent-simulations

Opomba: "Altera" je tu Altera.AL, podjetje za AI agente oziroma "digital humans", ne Intel/FPGA Altera. Njihov najbolj relevanten javni material je Project Sid, Minecraft eksperiment z vec sto do 1000+ avtonomnimi agenti.

## 1. Kaj so Altera NPC-ji

Altera NPC ni klasicen skriptan NPC, ki ima samo dialog tree in nekaj ukazov. Bolj je "digitalni prebivalec": LLM-agent, ki ima osebnost, spomin, socialne odnose, cilje, zmoznost govora, zmoznost izvajanja akcij v Minecraftu in zmoznost dolgorocnega prilagajanja svetu.

V praksi to pomeni:
- NPC ne caka samo na igralca, ampak sam opazuje svet in se odloca.
- Ima osebno zgodovino, vrednote, navade in trenutne potrebe.
- Komunicira z drugimi NPC-ji in si o njih ustvarja mnenja.
- Lahko si izbere ali spremeni poklic glede na izkusnje in potrebe skupnosti.
- Lahko uposteva skupna pravila, kot so davki, glasovanje ali mestni red.
- Lahko sodeluje pri kulturi kraja: govori o lokalnih idejah, navadah, dogodkih, veri ali tračih.

Najboljsi povzetek: Altera NPC je Minecraft prebivalec z "notranjim zivljenjem", ne samo bot za ukaz "pojdi tja in naredi to".

## 2. Arhitektura: PIANO

Altera opisuje PIANO kot arhitekturo, kjer vec modulov tece vzporedno in bere/pise v skupno stanje agenta. Namen je, da lahko NPC hkrati:
- hitro reagira na okolje,
- pocasi razmislja o dolgoročnih ciljih,
- govori z ljudmi ali drugimi NPC-ji,
- izvaja Minecraft akcije,
- posodablja spomin in odnose.

Za Mindcraft bi to lahko prevedli v te plasti:

### Skupno stanje NPC-ja

Vsak NPC naj ima eno glavno stanje, ki ga berejo vsi moduli:
- identiteta: ime, starost, vloga, dom, javna reputacija;
- osebnost: vrednote, stil govora, muhe, pogum, postenost, socialnost;
- potrebe: denar, sitost, utrujenost, druzabnost, varnost, dolgcas;
- spomin: kratkorocni dogodki, dolgorocni povzetki, pomembne obljube;
- socialni graf: odnos do vsakega znanega NPC-ja;
- cilji: trenutni cilj, socialni cilj, delovni cilj, osebni cilj;
- kontekst sveta: lokacija, cas dneva, bliznji igralci/NPC-ji, nevarnosti;
- pravila skupnosti: zakoni, davki, urniki, prepovedane cone, javna skladisca;
- kultura: lokalni memi, govorice, prazniki, navade, vera ali simboli kraja.

### Moduli

Priporoceni moduli:
- Perception: bere Minecraft okolje, chat, inventar, entitete in cas.
- Memory: dogodke pretvori v kratke zapise in obcasno v povzetke.
- Needs: izracuna, kaj NPC trenutno najbolj tisci.
- Social Awareness: posodobi odnos do drugih glede na govor in dejanja.
- Goal Generation: ustvari ali popravi cilj.
- Planner: cilj razbije v izvedljive akcije.
- Action Executor: izvede mineflayer akcije.
- Speech: odloci, ali naj NPC kaj rece, komu in v kaksnem tonu.
- Reflection: pocasnejsi modul, ki ob koncu dneva posodobi prepricanja, spomine, zamere in naklonjenosti.

## 3. Posamezen NPC kot osebnost

Altera agenti imajo proceduralno generirane ali rocno dane osebnosti. V Project Sid so imeli agenti razlicne osebnostne lastnosti, interese in socialne stile. Te lastnosti niso samo kozmetika, ampak vplivajo na:
- s kom NPC govori,
- komu zaupa,
- kaksno delo ga privlaci,
- ali uposteva zakone,
- ali se pusti prepricati,
- ali siri kulturo, religijo, govorice ali politicne ideje.

### Priporocena struktura osebnosti

```json
{
  "id": "ana",
  "ime": "Ana",
  "vloga": "gostilnicarka",
  "zgodovina": "v mesto se je priselila pred nekaj leti in prevzela gostilno",
  "vrednote": ["domacnost", "dobri odnosi", "varnost gostov"],
  "nacin_govora": "topel, vsakdanji, zgovoren",
  "muhe": ["tezko rece ne", "rada zbira mestne govorice"],
  "lastnosti": {
    "postenost": 65,
    "pogum": 45,
    "zamerljivost": 45,
    "socialnost": 70,
    "raziskovalnost": 40,
    "nagnjenost_kriminal": 5
  }
}
```

### Kaj mora osebnost povzrocati v igri

Dobra osebnost mora biti vidna v obnasaju:
- posten NPC vrne izposojene predmete in podpira davke;
- zamerljiv NPC si zapomni zalitev in kasneje ne pomaga;
- socialen NPC pogosteje zacne pogovor;
- pogumen NPC gre v rudnik ali na patruljo;
- previden NPC se izogiba noci, jamam in tujcem;
- raziskovalen NPC sam isce nove kraje, vasi in materiale;
- kriminalno nagnjen NPC lahko krade, goljufa pri davkih ali siri lazi.

## 4. Socialni odnosi

Ena glavnih poant Altera NPC-jev je socialna zavest. V Project Sid so agenti znali sklepati, kako drugi gledajo nanje, in to uporabiti pri odlocanju. Primer: "chef" agent je hrano raje dal tistim, za katere je mislil, da ga bolj cenijo.

Za Mindcraft to pomeni, da naj odnos ne bo samo "friend/enemy", ampak vecdimenzionalen.

### Socialni graf

Za vsak par NPC-jev:

```json
{
  "from": "ana",
  "to": "marko",
  "sentiment": 6.5,
  "trust": 7,
  "respect": 6,
  "fear": 1,
  "debt": 2,
  "last_interaction": 123456,
  "notes": [
    "Marko je Ani prinesel drva.",
    "Ana misli, da je Marko tih, ampak zanesljiv."
  ]
}
```

### Dogodki, ki spreminjajo odnose

Pozitivno:
- darilo ali pomoc pri delu;
- skupna gradnja;
- obramba pred nevarnostjo;
- placan dolg;
- vljuden pogovor;
- javna pohvala.

Negativno:
- kraja;
- ignoriranje prosnje;
- zalitev;
- napad;
- neplacan dolg;
- sirjenje skodljive govorice;
- krsenje pravil skupnosti.

### Socialne posledice

Odnos mora vplivati na dejanja:
- komu NPC proda ceneje;
- komu posodi orodje;
- koga povabi k skupni nalogi;
- komu pove skrivnost ali govorico;
- za koga glasuje;
- komu pomaga v nevarnosti;
- komu verjame, ko pride do spora.

## 5. Samodejna specializacija v poklice

V Project Sid so se agenti sami specializirali v vloge, kot so farmerji, minerji, inzenirji, strazarji, raziskovalci in kovaci. V artisticni druzbi so se pojavile vloge kot kuratorji in zbiratelji; v vojaski druzbi pa skavti in strategi.

To je pomembno: poklic ni samo label. Poklic mora spremeniti prioritete in akcije.

### Poklic kot kombinacija identitete, nalog in reputacije

Poklic naj ima:
- ime: "drvar", "rudar", "gostilnicar", "strazar";
- dnevne naloge;
- pomembne lokacije;
- potrebna orodja;
- izdelke/storitve;
- socialno vlogo;
- pravila, ki jih mora upostevati;
- status v skupnosti.

### Primeri vlog

#### Farmer

Vedenje:
- zjutraj gre na polje;
- preveri semena, vodo, motiko in pridelek;
- pospravlja pridelek v javno ali osebno skladisce;
- trguje s hrano;
- rad govori o vremenu, zemlji in zalogah.

Tipicni cilji:
- "zasadi psenico pri juznem polju";
- "prinesi kruh v gostilno";
- "zamenjaj krompir za premog";
- "povabi nekoga k popravilu ograje".

#### Miner

Vedenje:
- isce rude, premog, kamen in zelezo;
- raje dela v daljsih blokih casa;
- potrebuje svetilke, kramp in hrano;
- zvecer prinese material v mesto;
- ima vec tveganih dogodkov in vec potreb po zdravljenju.

Tipicni cilji:
- "naberi 32 cobblestone za mestno cesto";
- "najdi zelezo za kovaca";
- "prosi Ano za hrano pred odhodom v rudnik".

#### Builder / Engineer

Vedenje:
- bere town-plan;
- rezervira parcelo;
- gradi po schematicu;
- popravlja ceste, mostove in svetilke;
- sodeluje z drvarjem, rudarjem in kovacem.

Tipicni cilji:
- "zgradi vodnjak na trgu";
- "dokoncaj streho pekarne";
- "oznaci parcelo za novo hiso";
- "popravi pot do rudnika".

#### Guard / Policaj

Vedenje:
- patruljira po mestu;
- pazi na javna skladisca;
- reagira na krajo, napad ali nocne nevarnosti;
- mediira spore;
- podpira zakone in red.

Tipicni cilji:
- "patruljiraj med trgom in skladiscem";
- "preveri, kdo je vzel javne zaloge";
- "opozori NPC-ja, ki krsi pravila";
- "spremljaj rudarje do nevarne cone".

#### Gostilnicar / Social Hub

Vedenje:
- prodaja ali deli hrano;
- zbira govorice;
- povezuje ljudi;
- hrani socialni graf mesta;
- lahko vpliva na javno mnenje.

Tipicni cilji:
- "skuhaj hrano za delavce";
- "vprasaj Markota, ce potrebuje pomoc";
- "povej Tonetu, da je nekdo razbijal pri skladiscu";
- "organizira vecerno srecanje".

#### Priest / Cultural Influencer

Vedenje:
- siri prepricanja, rituale ali vrednote;
- organizira dogodke;
- vpliva na kulturo in politiko;
- ni nujno koristen prakticno, ampak gradi identiteto mesta.

Tipicni cilji:
- "povabi ljudi k nedeljskemu zboru";
- "pripoveduj zgodbo o nastanku mesta";
- "predlagaj praznik zetve";
- "prepricaj ljudi, da donirajo za kapelo".

#### Trader / Merchant

Vedenje:
- spremlja zaloge in cene;
- kupuje poceni, prodaja drago;
- sklepa dolgorocne dogovore;
- ustvarja dolgove in kredite;
- ima mocen vpliv na ekonomijo.

Tipicni cilji:
- "odkupi les od drvarja";
- "prodaj hrano rudarjem";
- "dvigni ceno svetilk, ce je noc nevarna";
- "zabelezi dolg NPC-ja".

## 6. Pravila, davki in upravljanje mesta

Project Sid je testiral druzbo, kjer agenti upostevajo davcna pravila, glasujejo o spremembah in se pustijo prepricati pro- ali anti-tax influencerjem. To je zelo uporabno za Minecraft mesto, ker NPC-ji dobijo razlog za skupno skladisce, politiko in konflikte.

### Osnovni sistem zakonov

Zakon naj bo preprost, strojno berljiv in hkrati razumljiv NPC-jem:

```json
{
  "law_id": "tax_basic",
  "name": "Mestni davek",
  "text": "Vsak delavec ob koncu dneva odda 20% uporabnih surovin v javno skladisce.",
  "rate": 0.2,
  "applies_to": ["wood", "stone", "food", "ore"],
  "storage": "public_storage",
  "enforced_by": ["tone"],
  "penalty": "opozorilo, nato globa ali izguba zaupanja"
}
```

### Mehanika davkov

1. NPC dela in nabira surovine.
2. Ob dolocenem casu dobi signal "tax season".
3. Iz inventarja izracuna 20% ustreznih itemov.
4. Gre do javnega skladisca in odlozi delež.
5. Policaj ali sistem zabelezi, kdo je placal.
6. Neplacilo vpliva na reputacijo, zaupanje in morebitne sankcije.

### Glasovanje

Za Altera stil dodaj:
- predlog zakona;
- debate med NPC-ji;
- influencerje;
- glasovanje;
- election manager ali mestni pisar;
- posodobitev "ustave" mesta.

Primer:
- Ana podpira nizje davke, ker vidi lacne delavce.
- Tone podpira visje davke, ker zeli urejene ceste in varnost.
- Marko je skepticen, ampak ga lahko preprica nekdo, ki mu zaupa.

## 7. Kultura, memi in religija

V Project Sid so agenti ustvarjali in sirili kulturne meme. V vecjih mestih je bilo vec kulturnega prenosa kot na ruralnih obmocjih, ker je vec socialnih stikov. Uvedli so tudi Pastafarianism kot primer religije, ki jo siri skupina duhovnikov.

Za igro je to super, ker mesto ne deluje vec kot zbirka delavcev, ampak kot kraj z identiteto.

### Kulturni mem

Mem je kratka ideja, navada ali motiv, ki ga NPC-ji ponavljajo:
- "pri nas se ob petkih pleše na trgu";
- "Woodhaven varuje gozd";
- "rudarji imajo srečni kamen";
- "Tone vedno rece: počasi, saj ni panike";
- "Ana dela najboljso juho pred rudarsko izmeno";
- "v tem mestu se ne krade iz javnega skladisca".

### Model sirjenja mema

Mem ima:
- besedilo;
- izvor;
- tematiko;
- moc;
- seznam NPC-jev, ki ga poznajo;
- verjetnost, da ga NPC omeni;
- povezavo z lokacijo ali dogodkom.

```json
{
  "id": "petkov_trg",
  "text": "Ob petkih se ljudje zberejo na trgu.",
  "origin": "ana",
  "theme": "community",
  "strength": 0.62,
  "known_by": ["ana", "marko"],
  "location": "center"
}
```

### Religija ali ideologija

Religija v igri ne rabi biti resna; lahko je:
- kult vodnjaka;
- ceh graditeljev;
- zeleni red gozda;
- rudarski ritual pred odhodom v jamo;
- mestni praznik prve hise.

Pomembno je, da vpliva na vedenje:
- NPC gre na zbor;
- donira za kapelo ali shrine;
- zagovarja moralna pravila;
- siri fraze;
- ima konflikte z drugimi prepricanji.

## 8. Dnevna zanka NPC-ja

Altera style NPC naj zivi v ciklu, ne samo v odzivih.

### Jutro

- preveri potrebe: lakota, utrujenost, denar, varnost;
- preveri urnik;
- izbere dnevni cilj;
- pogleda socialne obveznosti;
- pripravi orodje.

Primer:
"Marko je lacen 30%, utrujen 20%, ima delo drvarja. Vzame sekiro, gre proti gozdu, prej pozdravi Ano, ker imata dober odnos."

### Delo

- izvaja poklicne naloge;
- opazuje dogodke;
- po potrebi govori z drugimi;
- sproti posodablja cilje.

Primer:
"Marko nabere les. Vidi, da Builder potrebuje hrast za streho, zato spremeni cilj iz 'naberi les zase' v 'dostavi 24 oak_log graditelju'."

### Socialni cas

- gre na trg, gostilno ali dom;
- izmenja novice;
- poveca ali zmanjsa odnose;
- siri meme;
- oblikuje mnenje o zakonih.

### Vecer

- odda davek ali skrije del zalog;
- pospravi inventar;
- gre domov;
- reflection modul povzame dan.

Primer reflection:
"Danes mi je Ana dala hrano, ko sem bil lacen. Zaupanje do Ane +1. Tone je zahteval davek, ampak cesta do gozda je se vedno slaba. Podpora davkom -0.5."

## 9. Konflikti

Altera NPC-ji so zanimivi, ko nastanejo socialna trenja, ne samo harmonija.

### Vrste konfliktov

Ekonomski:
- kdo je vzel javne zaloge;
- ali so davki previsoki;
- kdo dobi redke materiale;
- ali trgovec izkorisca lakoto.

Socialni:
- govorice;
- zamere;
- nevrnjena orodja;
- favoritizem;
- prepiri med poklici.

Politicni:
- pro-tax vs anti-tax;
- varnost vs svoboda;
- gradnja obzidja vs gradnja trga;
- mestni center vs ruralne hise.

Kulturni:
- staroselci proti priseljencem;
- vera proti skepticizmu;
- umetniki proti prakticnim delavcem;
- tradicija proti novim pravilom.

### Zakaj so konflikti dobri

Konflikt ustvari:
- razlog za pogovor;
- razlog za policaja;
- razlog za zakone;
- razlog za spomin;
- razlog, da se mesto spreminja.

## 10. Implementacijski model za ta projekt

V tvojem Mindcraft projektu ze obstajajo dobri nastavki:
- `src/rp/config/npcs/*.json`: osebnosti in zacetno stanje;
- `src/rp/systems/needs.js`: potrebe;
- `src/rp/systems/economy.js`, `market.js`, `trade.js`: ekonomija;
- `src/rp/systems/crime.js`: kriminal;
- `src/agent/roleplay/social_graph.js`: socialni odnosi;
- `src/agent/roleplay/memory.js`: spomin;
- `bots/public-storage.json`: javne zaloge;
- `bots/town-plan.json`: mestni nacrt;
- `src/agent/library/town.js`, `roads.js`, `build.js`: fizicni svet mesta.

Najbolj Altera-like nadgradnja bi bila:

1. Vsak NPC ima dnevni cilj, socialni cilj in osebni cilj.
2. Socialni graf direktno vpliva na akcije, ne samo na dialog.
3. Poklic nastane iz zgodovine dejanj in potreb mesta, ne samo iz config labela.
4. Javno skladisce in davki ustvarijo skupno ekonomijo.
5. NPC-ji redno govorijo med sabo, tudi brez igralca.
6. Memory/reflection na koncu dneva spremeni odnose in preference.
7. Kulturni memi se sirijo skozi pogovor in dogodke.
8. Zakonodaja se lahko spremeni skozi glasovanje ali ukaz igralca kot zupana.

## 11. Konkretna uporaba za trenutne NPC-je

### Ana

Altera opis:
Ana je socialni center mesta. Njena vrednost ni samo gostilna, ampak pretok informacij. Hrani delavce, poslusa njihove tezave, povezuje osamljene NPC-je in lahko postane mocan neformalni influencer.

Vedenje:
- ponuja hrano tistim, ki so lacni ali utrujeni;
- zbira govorice;
- hitreje oprosti napake kot Tone;
- tezko rece ne, zato jo lahko izkoristijo;
- podpira zakone, ce pomagajo ljudem;
- nasprotuje zakonom, ce vidi, da ljudje trpijo.

Socialna moc:
- visoka;
- veliko povezav;
- visoka verjetnost sirjenja memov;
- primerna za gostilno, trgovino, mestne novice.

### Marko

Altera opis:
Marko je prakticen delavec z nizjo socialno energijo. Ni vodja pogovorov, ampak je stabilen vir zaupanja, lesa in vsakodnevne rutine. Njegovi odnosi rastejo pocasi, a so mocni.

Vedenje:
- raje dela kot govori;
- zanesljivo dostavlja les;
- ne mara dolgih politicnih debat;
- ce mu nekdo pomaga, si to zapomni;
- lahko postane anti-tax, ce ne vidi konkretnih rezultatov;
- do tujcev je previden, ampak ne sovrazen.

Socialna moc:
- nizja frekvenca pogovorov;
- visoka reputacija pri prakticnih NPC-jih;
- dober za test, ali socialni sistem nagradi zanesljivost, ne samo zgovornost.

### Tone

Altera opis:
Tone je formalni red mesta. Ni samo policaj, ampak agent, ki povezuje zakone, javno skladisce, varnost in reputacijo. Njegova naloga je, da pravila niso samo tekst, ampak posledice v svetu.

Vedenje:
- patruljira;
- preverja javno skladisce;
- opozarja krsitelje;
- podpira davke, ce financirajo skupno dobro;
- je vljuden, ampak previden;
- v konfliktih isce dokaz in red, ne samo custven odziv.

Socialna moc:
- srednja do visoka;
- vpliva na strah, respekt in zaupanje;
- idealen za enforcement sistem: kraja, davek, spor, patrola.

## 12. Design pravilo

Ce zelis, da NPC deluje kot Altera agent, mora vsaka pomembna lastnost imeti posledico:

- Osebnost mora spremeniti odlocitve.
- Spomin mora spremeniti prihodnje pogovore.
- Odnos mora spremeniti pomoc, trgovino in glasovanje.
- Poklic mora spremeniti dnevne akcije.
- Zakon mora spremeniti inventar in gibanje.
- Kultura mora spremeniti fraze, dogodke in pripadnost.
- Mesto mora vplivati na NPC-ja, NPC pa mora vplivati nazaj na mesto.

To je glavna razlika med "NPC z AI dialogom" in "AI prebivalcem".

