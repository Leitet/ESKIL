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

png/
  - Motsvarande PNG-versioner av alla varianter ovan.

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
