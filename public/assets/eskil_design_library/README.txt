ESKIL – designbibliotek
=======================

Detta paket innehåller en enkel varumärkesuppsättning för ESKIL,
anpassad till Scouternas färgprofil.

Innehåll
--------
svg/
  - eskil-logo-primary.svg                Blå huvudlogotyp för ljusa bakgrunder
  - eskil-logo-inverted.svg               Vit logotyp för mörka bakgrunder (transparent)
  - eskil-logo-primary-on-white.svg       Huvudlogotyp med vit bakgrund
  - eskil-logo-inverted-on-scoutbla.svg   Vit logotyp på Scoutblå bakgrund
  - eskil-symbol-primary.svg              Enbart symbol, blå
  - eskil-symbol-inverted.svg             Enbart symbol, vit
  - eskil-symbol-primary-on-white.svg     Enbart symbol med vit bakgrund
  - eskil-symbol-inverted-on-scoutbla.svg Enbart symbol på Scoutblå bakgrund
  - eskil-favicon.svg                     Webbläsarikon, 64x64 (se nedan)
  - eskil-appicon.svg                     Hemskärmsikon, raka hörn (se nedan)

png/
  - Motsvarande PNG-versioner av alla varianter ovan.
  - eskil-favicon-32.png                  Webbläsarikon, 32x32
  - eskil-favicon-512.png                 Webbläsarikon, 512x512
  - eskil-appicon-180.png                 apple-touch-icon (opak, raka hörn)

previews/
  - eskil-designbibliotek.png             Översiktsbild
  - eskil-designbibliotek.pdf             Översikt i PDF-format

Färger (enligt Scouternas profil)
---------------------------------
  Scoutblå        #003660
  Spårargrön      #41A62A
  Upptäckarblå    #00A8E1
  Äventyrarorange #E95F13
  Utmanarrosa     #DA005E
  Rovergul        #E2E000

Logotyptext
-----------
  Namn: ESKIL
  Tagline: Där spåret börjar

Notering
--------
SVG-filerna är vektorbaserade och lämpar sig bäst för vidare redigering,
webb och tryckproduktion. PNG-filerna passar för presentationsmaterial,
dokument och sociala medier.

Ändringar i logotypfilerna (2026-08-16)
---------------------------------------
De fyra eskil-logo-*.svg har bearbetats för webbanvändning. Rör man dem
igen: behåll de tre punkterna, annars kommer felen tillbaka.

1. TYPSNITTET LIGGER I FILEN. En SVG som visas via <img> är ett isolerat
   dokument — den når varken sidans CSS eller externa webbfonter. Med bara
   font-family="Arial, Helvetica, sans-serif" renderades ordbilden i det
   besökarens enhet råkade ha: Arial på Mac och Windows, Roboto på Android,
   DejaVu på Linux. Logotypen bytte alltså form efter besökare.
   Inbakat som data-URL ligger nu Arimo — metriskt identisk med Arial,
   licensierad under OFL — i en delmängd med bara de tecken som används
   (3,8 kB, hämtad med text=-parametern mot Google Fonts). Utseendet är
   detsamma som förut, men lika överallt. Verifierat genom mutation: tas
   @font-face bort krymper taglinens bläck från 1080 till 1011 px.
   Byts taglinen eller namnet måste delmängden hämtas om — nya tecken
   finns inte i den.

2. RAMEN ÄR BESKUREN till innehållet. Den gamla viewBoxen var 1800x560
   medan bläcket slutade vid x 1202 och y 451 — en tredjedel tom yta. Den
   ytan räknas med när CSS ger logotypen en höjd, så taglinen blev 7 px
   och oläslig i ett sidhuvud. Nu är viewBoxen "78 57 1149 418" (2,75:1),
   och samma 48 px höjd ger 11 px tagline.

3. SYMBOLEN ÄR CENTRERAD mot ordbilden. Den satt 23 enheter för högt
   (transform translate(60,60) → translate(60,83)); båda har nu mitten
   på y 266.

PNG-versionerna av de fyra logotyperna är omgenererade ur SVG:erna efter
detta (2400x873). Symbolfilerna är orörda.

Webbläsarikonen (favicon)
-------------------------
eskil-favicon.svg är en EGEN teckning, inte eskil-symbol-*.svg nedskalad. Det
är avsiktligt: originalsymbolens bas består av en ellips och två streck som är
6 av 240 enheter höga, alltså 0,4 px vid 16 px. Nedskalad blir den grå gröt —
uppmätt genom att rendera i 16 px och titta på en pixelförstoring.

Tre beslut, alla fattade genom rendering i 16/24/32/48 px:

  PLATTA I SCOUTBLÅ, inte en fristående mark. En favicon-SVG KAN byta färg med
  flikraden via prefers-color-scheme — men Safari ignorerar media-frågan i
  favicons i alla versioner, så en temaväxlande mark visar sin reservfärg för
  varje Apple-användare, och den färgen måste kompromissa mellan ljus och mörk
  flikrad. Plattan bär kontrasten själv: vit lilja mot Scoutblå är 12,38:1, och
  ikonen ser likadan ut i Safari, i äldre webbläsare och i PNG-export.
  Lyftet till #17456B i mörkt läge är en FÖRBÄTTRING ovanpå en fungerande
  grund, aldrig mekanismen (vit mot lyftet: 10,00:1).

  SVEPTA BLAD, feta med en kontur i samma färg. Räta INTE ut dem för att vinna
  skärpa: en provskiss som gjorde det läste som en KRONA vid 32 px. Fetare än
  stroke-width 10 provades också — då slöts mellanrummen och marken blev en
  klump.

  BASEN SMALNAR NEDÅT och ligger på pixelrutnätet (1 px = 4 enheter i den
  64-enheters viewBoxen). Ett rakt streck under tre spröt läser som en
  kronbas; en skål gör det inte.

eskil-appicon.svg är samma mark för hemskärmen: raka hörn (iOS maskar själv,
och egen rundning ger genomskinliga hörn mot vitt), ingen media-fråga (en PNG
kan inte växla), lättare kontur (vid 180 px finns inget antialias-problem) och
större marginal (Androids maskable-form kan beskära 10 % per kant).

PNG-filerna renderas ur SVG:erna i VARJE storlek för sig — låt aldrig ett
verktyg skala ner en stor PNG till 16 och 32 px, det är precis det som ger
grå gröt. public/favicon.ico i projektroten packar 16/32/48.

Bygg om hela uppsättningen med scripts/bygg-ikoner.sh efter varje ändring i
de två SVG-filerna. PNG:erna och .ico:n är genererade, inte handgjorda.
