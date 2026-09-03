# Schematics - nacrti za gradnjo

NPC-ji berejo nacrte iz te mape. Pred gradnjo nastavi lokacijo z `!setHome`.
Ukaz `!build` bota zacasno prestavi v creative, zgradi celoten nacrt, obnovi
prejsnji inventory in ga vrne v survival.
Vsako zaceto schematic gradnjo vpise v skupni zascitni register, zato je
deterministicno nabiranje in pathfinding ne uporabljata kot vir materiala.
Najblizjo registrirano gradnjo namensko odstrani samo ukaz `!demolish`.

Pred gradnjo bot pregleda vec lokacij okoli baze. Obmocja z obstojecimi
stavbami, skrinjami, pecmi, deskami, steklom in drugimi umetnimi bloki zavrne.
Na izbrani naravni lokaciji odstrani drevesa in rastje, zapolni manjse luknje
ter pripravi ravno travnato podlago. Ce varne lokacije ne najde, ne porusi
obstojece stavbe in gradnjo prekine.

## Ukazi

```text
Blaz !setHome
Blaz !schematics
Blaz !shematics
Blaz !build medieval_cottage
Blaz !build "moderne stavbe"
Blaz !build dekor
Blaz !build random
Blaz !build "random vse"
Blaz !demolish
```

`!schematics` in `!shematics` sta isti ukaz in izpiseta vse nacrte po skupinah.

`!build` sprejme:

- tocno ime, na primer `modern_villa`
- alias, na primer `kovacija`
- kategorijo, na primer `"srednjeveske stavbe"`, `"moderne stavbe"`,
  `british`, `mestne`, `uporabne` ali `dekor`
- `random`, ki izbere nakljucno stavbo brez drobnega dekorja
- `"random vse"`, ki lahko izbere tudi dekor

Pri vecbesednih imenih ali kategorijah uporabi narekovaje.

## Vkljucene skupine

- `medieval`: 15 nacrtov - koca, taverna, kovacija, kapela, strazni stolp,
  grascina, pekarna, vojasnica, cehovska dvorana, apoteka, hlev, mestna vrata,
  vetrni mlin, kamniti most in utrdba
- `modern`: vila, mestna hisa, steklena hisa in pisarna
- `british`: podezelska hisa, vrstna hisa, pub in postaja
- `civic`: trznica, mestna hisa in knjiznica
- `utility`: skladisce, rastlinjak in skedenj
- `decor`: fontana, paviljon, svetilka, klop in cvetlicni vrt
- `classic`: prvotni nacrti `hisa`, `koca` in `stolp`

## Formati

Preprost JSON:

```json
{
  "_opis": "Opis nacrta",
  "_category": "modern",
  "_kind": "building",
  "_aliases": ["alias"],
  "size": [5, 5, 5],
  "blocks": [
    { "x": 0, "y": 0, "z": 0, "name": "oak_planks" }
  ]
}
```

Koordinate so relativne, `0,0,0` pa je vogal pri botovi bazi. Podprte so tudi
standardne Sponge `.schem` datoteke iz WorldEdita.

Nove vgrajene JSON nacrte lahko ponovno ustvaris z:

```powershell
node scripts/generate-schematics.js
```
