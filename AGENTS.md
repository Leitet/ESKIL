# ESKIL — instruktioner för AI-agenter

ESKIL är ett administrationssystem för scouttävlingar: statiska ES-moduler
utan byggsteg, Firebase (Firestore-regler, e-postlänk-inloggning, App Check,
Cloud Functions), allt användarvänt på svenska. Produktion:
https://eskilscout.se.

**Den fullständiga referensen är [CLAUDE.md](CLAUDE.md)** — arkitekturens
invarianter, reglermodellen, fällorna som redan slagit till och varför varje
val gjordes. Läs den innan du ändrar något; den gäller oavsett vilket verktyg
du är. Katalogkartan, hur man kör lokalt och hur man deployar står i
[README.md](README.md). Den här filen bär bara det som ALDRIG får missas, och
avsnittet nedan står ordagrant även i CLAUDE.md — ändrar du det ena, ändra det
andra (ett test kräver att löftet finns i båda).

Tre arbetsregler som inte är förhandlingsbara:

- **Kör testerna.** `scripts/test.sh logic` (ingen emulator) efter varje
  ändring, `scripts/test.sh rules` efter VARJE ändring i `firestore.rules` —
  regler fallerar tyst och i produktion.
- **Inget byggsteg, inget ramverk, inga nya beroenden.** Ett beroende laddas
  från CDN enligt mönstret i `public/js/pdf.js`.
- **Uppdatera `/integritet` i samma commit** som en ändring som rör
  personuppgifter, lokal lagring, tredje parter eller gallringen vid avslut.

## ESKIL är LIVE — och har ställt ut löften som gäller i åratal

Skarpa tävlingar körs i produktion. Varje ändring ska vara bakåtkompatibel med
data som redan finns: nya fält är valfria och läses med ett standardvärde,
befintliga dokument skrivs aldrig om i förbifarten, och en migrering är
idempotent och körs EFTER att koden som tål båda formerna gått ut. Ordningen
vid en ändring som rör servern är **functions → hosting + regler → migrering**.

### Utestående överlämningskoder är ett löfte

Tävlingar i produktion har skapat överlämningskoder (`XXXX-XXXX-XXXX`). Koden
står TRYCKT i en tävlingsrapport, ligger i en pärm hos en kår vi aldrig pratat
med, och löses kanske in först om ett år — av någon som aldrig sett ESKIL. Det
finns ingen att ringa och inget sätt att skicka ut en ny. **En kod som gick att
lösa in den dag den skapades ska gå att lösa in med den kod som ligger i
produktion den dag någon försöker.** Bakgrunden till funktionen står under
`.../private/handover` i reglermodellen nedan; det här är vad som inte får
brytas, och varför:

1. **Vägen från kod till dokument är frusen.** `normKod()` → sha256 som hex →
   `overlamningskoder/{hash}` med fältet `cid`. Ändras normaliseringen,
   hashen, samlingens namn eller fältnamnet pekar varje tryckt kod på
   ingenting — och felet syns inte förrän någon står med pappret. Formen får
   VIDGAS (fler tecken, längre koder bredvid) men aldrig krympa:
   `arGiltigKod()` är första raden i inlösningen, och en skärpning där avvisar
   2026 års koder innan uppslagningen ens görs. `anvand` är enda spärren mot
   dubbel inlösning — byt aldrig dess betydelse.
2. **Adressen står på papper.** `eskilscout.se/overlamning` och QR-kodens
   `/overlamning/<kod>`: rutterna i app.js, deras rewrites i firebase.json och
   den anropbara funktionen `losInOverlamningskod`. En omdöpt rutt är ett 404
   för den som skannar. Funktionen deployas för hand — tas den bort ur
   `functions/index.js` föreslår nästa deploy att radera den i produktion.
3. **Källan läses vid INLÖSNINGEN, inte när koden skapas.** Om ett år kopierar
   `losInKod()` en tävling som skrevs med 2026 års schema och sedan avslutades.
   `kopiaTavlingsdata`, `kopiaKontroll`, `remappaSpar` och
   `utvarderingForNastaAr` (båda speglarna) måste därför för alltid tåla gamla
   och magra dokument: saknade fält, `track/main` med `legs` nycklade
   `<från>__<till>`, utvärderingen i `private/handover` och bilderna i
   `private/utv-bild-<id>`. Flyttar du något av det: läs BÅDA platserna, eller
   migrera även AVSLUTADE tävlingar — de är just de som har koder.
4. **Källtävlingen får inte försvinna eller tömmas.** Koden pekar på en
   tävling; utan den finns inget att kopiera. `deleteCompetition` varnar skarpt
   och drar in koden. Bygg aldrig en gallring, ett städskript eller en
   "radera gamla avslutade tävlingar" som inte först frågar
   `private/overlamning`, och låt aldrig `closeCompetition` börja riva
   kontroller, spår eller utvärdering — avslutet är det som LÅSER UPP koden.
5. **Inlösaren måste kunna ta sig in.** Flödet är inloggningslänk → tillbaka
   till `/overlamning` (koden väntar i localStorage) → servern gör inlösaren
   till admin via `private/access.adminEmails`. Ändras behörighetsmodellen ska
   `planeraOvertag()` skriva den NYA modellen, annars får den nya arrangören en
   tävling den inte kommer åt. Sidan måste också fortsätta initiera App Check;
   funktionen är enforced.

Allt detta är låst i `test/overlamning.test.js` ("koder som redan står
tryckta går att lösa in"): en känd kod mot ett facit räknat med rå sha256, en
databas så som den såg ut hösten 2026, en källa med bara ett namn, och
adresserna. **Faller ett av de testerna: ändra inte facit.** Gör ändringen
bakåtkompatibel eller migrera varje utestående kod först. Fixturen "2026 års
databas" får aldrig få nya fält — ändras den tillsammans med koden döljer den
precis det brott den ska fånga.

