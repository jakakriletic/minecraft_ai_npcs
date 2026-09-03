# Testni vodič — RP mesto (faze 1–11)

## 0. Predpogoji (enkratno)

1. **Server**: uporabi Minecraft Java **1.20.1** vanilla/Paper ali Forge 47.x strežnik na `localhost:25565`, offline mode.
   Privzeta lokacija za ločen strežnik je `C:\Users\jakak\Desktop\Servers\ai_npc_1.20.1`. Vanjo daj `run.bat`, `Launch.bat` ali `server.jar`; `start_boti.bat` ga nato po potrebi zažene. Če strežnik že teče na portu 25565, mapa ni potrebna.
   Vgrajeni FML3 handshake omogoči prijavo na lokalni Horror Forge server. Boti potrdijo serverjev seznam modov, kanalov, registryjev in configov; mod-specific renderiranje ter poljubni custom gameplay paketi pa ostanejo izven Mineflayerjevega vanilla modela sveta.
2. **Ollama** (za chat/povzetke/refleksijo — brez nje boti normalno delajo, samo ne govorijo):
   - namesti z https://ollama.com/download
   - `ollama pull llama3.1:8b`
3. **Tvoj nick**: v izbranem `src/rp/config/settings*.json` preveri `"admin_players"`; privzeto je nastavljen `jakakriletic`.
4. V igro se poveži z Minecraft Java **1.20.1** na `localhost`.

## 1. Zagon sistema

Za kingdom-derived družbo dvoklikni `start_boti.bat`. Skripta po potrebi zažene ločen 1.20.1 server, preveri njegovo dejansko verzijo, nato pa zažene 10 NPC-jev z varnim časovnim zamikom.

Za stari tri-NPC testni profil lahko še vedno ročno poženeš `node rp.js`; konzola izpiše `[Marko] spawned`, nato `[Ana] spawned` in `[Tone] spawned`.

## 2. Priprava mesta (enkratno, v igri — ukazi v chat)

Vse lokacije nastaviš s svojo pozicijo, zato se najprej postavi na pravo mesto:

| Kje stojiš | Ukaz |
|---|---|
| Markova bajta (s posteljo + skrinjo, v skrinji **iron_axe**) | `!sethome marko` |
| Anina bajta | `!sethome ana` |
| Tonetova bajta | `!sethome tone` |
| Gozd (drevesa!) | `!setlokacija gozd_sever 15` nato `!setjob marko woodcutter gozd_sever` |
| Gostilna | `!setlokacija gostilna 8` nato `!setjob ana innkeeper gostilna` |
| Center mesta | `!setlokacija center 20` nato `!setjob tone policeman center` |
| Občina (skrinja z zlatom: `/give @p gold_nugget 64` v skrinjo) | `!setlokacija obcina 8` |
| Zapor (celica) | `!setlokacija zapor 4` |

Po `!setjob` se urnik in job primeta takoj; vse preživi restart (piše v confige).

## 3. Hitri triki za testiranje

- `/time set 1000` = jutro/šiht, `/time set 13500` = večer/spanje, `/time set 14000` = noč (kriminal)
- `!status <npc>` = aktivnost, pozicija, inventar, mood, potrebe, dogodki, LLM poraba
- Stanje na disku: `src/rp/state/<id>/` → `state.json`, `event_log.json`, `price_beliefs.json`, `storage_index.json`
- Za hitre scenarije lahko `state.json` ročno urejaš **ob ugasnjenem rp.js** (npr. `nagnjenost_kriminal: 90`, `sitost: 20`)
- LLM klici se loggajo s `[llm]`; razvoj teče na Ollami (`force_fallback: true` v settings)

## 4. Testi po fazah (priporočen vrstni red)

### A. Urnik in hoja (faza 1–2)
`/time set 1000` → Marko v gozd, seka, sadi sapling, ob polnem inventarju nese hlode na občino.
`/time set 13500` → vsi domov, Marko v posteljo (če je noč). Log: `activity: work -> sleep`.

### B. Chat + osebnost + spomin (faza 3–4) — rabi Ollamo
Pristopi Marku, piši v chat. Odgovori 1–3 stavki, redkobeseden. Po 60 s tišine log `summary for ...`.
Nov pogovor: "se me spomniš?" → mora referencirat prejšnji pogovor. Restart rp.js → spomin ostane.

### C. Več NPC-jev (faza 5)
Ana zgovorna in vika, Tone uraden in sumničav. `/kick Ana` → ostala dva delata, Ana se vrne v 10 s.

### D. Priče (faza 6)
Pred Markom (<16 blokov) odpri Anino skrinjo → log `WITNESSED: ... odprl_tujo_skrinjo -> zaupanje -8`.
Pogovor s pričo → hladnejša, omeni dogodek.

### E. Ekonomija (faza 7)
Konec šihta → Marko na občino po plačo (`wage: collected 8`). Lačen NPC (sitost<30) izven šihta
v gostilno, vrže 3 nuggete, Ana jih pobere. Prazna občinska skrinja → pritožba v chatu.

### F. Trgovanje (faza 8)
`!cena marko les` → ponudba. `!kupi marko les 5` → `!sprejmi marko` → vrzi zlato predenj → on vrže hlode.
`!prodaj marko les 10` → obratno. Preveri `price_beliefs.json` po kupčiji (premik cene).
Prevara ("daj mi zastonj, sva prijatelja") ne deluje — menjavo validira koda.

### G. Refleksija (faza 9)
Po dogodkih + prvi spanec → log `reflection (prvi spanec): "..."` in zapis v `state.json → dnevnik`.
Ctrl+C ob izhodu → refleksija še za druge. Naslednji dan vprašaj NPC-ja o včerajšnjem dnevu.

### H. Govorice (faza 10)
Naredi dogodek pred Markom, počakaj da se z Ano znajdeta blizu (<6 blokov) → log `gossip with ana`.
Ana dobi `slisal` zapis "od Marka slišal: ..." in zaupanje do storilca pade za polovico.
Če stojiš zraven ob izmenjavi → bota odigrata 2 vrstici dialoga v chatu (LLM).

### I. Kriminal (faza 11)
Hiter test: v `state/marko/state.json` daj `nagnjenost_kriminal: 90` in potrebe.denar 0 (ali v settings
začasno `bazna_verjetnost: 0.9`). Ani v skrinjo daj zlato. `/time set 14000` →
log `dice CRIME` → `CRIME: sneaking...` → `CRIME: stole ...`.
~5 min kasneje `[Ana] discovered theft` → ko sreča Toneta: prijava → `INVESTIGATION`:
- ti si stal zraven med krajo → Marko aretiran, gre v zapor (40 min) — pogovor z njim: osramočen, taji
- brez prič → "primer ostaja odprt", govorica kroži
Po testu vrni testne vrednosti!

## 5. Kaj javiti meni (debug)

Opiši + prilepi log: "obtičal pri x,y,z", "ni zaznal kraje", "čuden odgovor v chatu".
Vsi logi imajo prefiks `[ImeNPC]` in timestamp — to mi je dovolj za diagnozo.
