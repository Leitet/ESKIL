// Fälthjälp — den tredje informationsnivån i administrationsgränssnittet.
//
//   1. Rubriken säger VAD fältet heter          (<label class="field">)
//   2. Hjälptexten säger kort vad det GÖR       (<div class="field-hint">)
//   3. Den här modulen svarar på VARFÖR, HUR och VAD HÄNDER DÅ
//
// Användning i en vy: lägg `${help('comp.slug')}` inuti etiketten.
//
//   <label class="field" for="slug">Kortadress ${help('comp.slug')}</label>
//
// Ingen wiring behövs — modulen installerar en delegerad klicklyssnare på
// document första gången den importeras, så knappen fungerar oavsett vilken
// vy som renderat den och överlever omrenderingar.
//
// Innehållet ligger samlat i HELP nedan i stället för utspritt i vyerna: det
// gör texterna läsbara och granskningsbara som en helhet, och håller
// markupen i vyerna ren.

import { escapeHtml } from './utils.js';
import { icon } from './icons.js';

// --- Demoillustrationer -------------------------------------------------------
// Små efterlikningar av hur inställningen ser ut ute i produktion, byggda med
// samma designtokens som riktiga ytor. Hellre det än skärmdumpar: de kan inte
// bli inaktuella på samma sätt, väger ingenting och funkar i mörkt läge.

const demoUrl = (url, caption) => `
  <div class="help-demo">
    <div class="help-urlbar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      <span class="help-url">${escapeHtml(url)}</span></div>
    ${caption ? `<p class="help-demo-cap">${escapeHtml(caption)}</p>` : ''}
  </div>`;

const demoBanner = (level, text, { ack = false, caption = '' } = {}) => `
  <div class="help-demo">
    <div class="help-banner help-banner-${level}">
      <span class="help-banner-label">${level === 'kritisk' ? 'Kritisk information' : level === 'varning' ? 'Varning' : 'Information'}</span>
      <span class="help-banner-text">${escapeHtml(text)}</span>
      ${ack ? '<span class="help-banner-btn">Bekräfta mottaget</span>' : ''}
    </div>
    ${caption ? `<p class="help-demo-cap">${escapeHtml(caption)}</p>` : ''}
  </div>`;

// Två lägen som växlar — för inställningar vars poäng är just skillnaden.
const demoToggle = (aLabel, aHtml, bLabel, bHtml) => `
  <div class="help-demo help-demo-2">
    <div><div class="help-demo-cap">${escapeHtml(aLabel)}</div>${aHtml}</div>
    <div><div class="help-demo-cap">${escapeHtml(bLabel)}</div>${bHtml}</div>
  </div>`;

const demoCard = (inner) => `<div class="help-card">${inner}</div>`;
const demoMapHidden = () => demoCard(`
  <div class="help-map">
    <div class="help-map-area">Tävlingsområde</div>
    <span class="help-pin help-pin-sf" style="left:22%;top:62%;">S</span>
  </div>`);
const demoMapShown = () => demoCard(`
  <div class="help-map">
    <svg class="help-track" viewBox="0 0 200 90" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="30,60 70,30 120,45 165,25" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="6 6"/>
    </svg>
    <span class="help-pin help-pin-sf" style="left:11%;top:62%;">S</span>
    <span class="help-pin" style="left:33%;top:30%;">1</span>
    <span class="help-pin" style="left:58%;top:47%;">2</span>
    <span class="help-pin" style="left:80%;top:24%;">3</span>
  </div>`);

// --- Innehållet ---------------------------------------------------------------
// Varje post: { title, body: [stycken], demo?, faq?: [{q,a}], warn? }

export const HELP = {

  // ---------- Grund ----------
  'comp.shortName': {
    title: 'Kort namn',
    body: [
      'Det korta namnet används överallt där det fullständiga inte får plats: webbläsarens fliktitel, brödsmulorna i administrationen, rubriken i utskicksmailen och märkningen på tävlingskorten.',
      'Det ligger också till grund för förslaget på kortadress och betalningsreferens — "Älghornsjakten" + 2026 blir förslaget AG26.'
    ],
    faq: [
      { q: 'Måste det innehålla årtalet?', a: 'Nej. Året lagras separat och läggs till automatiskt där det behövs. Skriv "Älghornsjakten", inte "Älghornsjakten 2026".' },
      { q: 'Kan jag ändra det senare?', a: 'Ja. Till skillnad från kortadressen är det korta namnet fritt att ändra när som helst — inget hänger på det.' }
    ]
  },

  'comp.slug': {
    title: 'Kortadress & betalningsprefix',
    body: [
      'Kortadressen är tävlingens läsbara identitet. Den ger den korta webbadressen som scouter, anhöriga och kårer använder, och den blir prefix i alla betalningsreferenser så att inbetalningar går att matcha mot rätt tävling.',
      'Samma kortadress fungerar på alla publika ingångar: tävlingssidan, anmälan och patrullernas startkort.'
    ],
    demo: demoUrl('eskilscout.se/t/ah26', 'Tävlingssidan — samma adress fungerar för /a (anmälan) och /s (startkort).'),
    warn: 'Kortadressen går inte att ändra efter att tävlingen skapats. Tryckta QR-koder, utskickade länkar och redan utfärdade betalningsreferenser slutar fungera om den byts.',
    faq: [
      { q: 'Vad är en bra kortadress?', a: 'Kort och läsbar — initialer plus tvåsiffrigt år, som ah26. Den ska gå att läsa upp i telefon och skriva rätt utan att stava.' },
      { q: 'Varför föreslås AG26 och inte AH26 för Älghornsjakten?', a: 'Referensalfabetet utesluter bokstäver som lätt förväxlas i handskrift (bland annat I, L och O), så förslaget hoppar över L:et. Du kan skriva över förslaget med vad du vill.' },
      { q: 'Vad händer om två tävlingar vill ha samma?', a: 'Det går inte. Systemet kontrollerar mot både befintliga kortadresser och interna tävlings-id:n innan tävlingen skapas.' }
    ]
  },

  'comp.date': {
    title: 'Datum',
    body: [
      'Tävlingsdagen styr mer än vad som visas på sidan: den är ankaret för alla starttider. Patrullernas nedräkning på startkorten räknar mot första start på det här datumet, inte mot närmaste klockslag.',
      'Utan datum antar systemet att starttiderna gäller idag, vilket är rätt för testtävlingar men fel för en riktig tävling som ligger veckor bort.'
    ],
    faq: [
      { q: 'Varför visar startkortet "om 3 dagar" i stället för en tid?', a: 'Det är meningen. Scouter öppnar sina startkort i god tid, och då är dagar mer begripligt än timmar.' },
      { q: 'Kan jag lämna datumet tomt tills det är spikat?', a: 'Ja. Fyll i det så snart det är bestämt — automatiskt släpp av kontrollpositioner kräver ett datum för att veta vilken dag det gäller.' }
    ]
  },

  'comp.selfStart': {
    title: 'Patrullerna bekräftar start själva',
    body: [
      'Normalt checkas patrullerna ut av en funktionär vid startstationen. Med den här inställningen kan patrullen i stället trycka "Bekräfta start" på sitt eget startkort.',
      'Startkortet får då tre lägen. Före bekräftelsen visas bara tävlingsinformation, tävlingsledningens kontaktuppgifter och vägen till starten — ingen bankarta och inga kontroller. Knappen finns men är släckt tills patrullens starttid passerats, och tänds då grön. Efter bekräftelsen öppnas kortet: karta, kontroller, poäng och ETA.',
      'Bekräftelsen landar i Läget precis som en utcheckning från startstationen, så sen-till-start-larmet och ETA:n räknar på patrullens verkliga starttid.'
    ],
    warn: 'Startkortslänken är hemligheten. Den som har den kan bekräfta starten — men bara en gång: en bekräftad start går inte att flytta i efterhand. Behöver den ångras gör en administratör det.',
    faq: [
      { q: 'Kan de trycka innan starttiden?', a: 'Nej. Knappen är släckt tills patrullens egen starttid passerats. Har tävlingen inga starttider alls är knappen tänd direkt.' },
      { q: 'Vad händer om de glömmer trycka?', a: 'Kortet står kvar i informationsläget. Startfunktionären kan checka ut dem på stationen som vanligt — de två sätten fungerar sida vid sida och Läget visar båda.' },
      { q: 'Ersätter det startstationen?', a: 'Det kan det göra på mindre tävlingar. På större är det bekvämt som komplement: patrullen bekräftar själv, funktionären behöver bara pricka av dem som inte gjort det.' },
      { q: 'Var syns bekräftelsen?', a: 'I Läget, i patrullistan och på startstationens sida — samma kolumn som utcheckningar, märkt så att du ser att patrullen bekräftat själv.' }
    ]
  },

  'comp.places': {
    title: 'Platser på kartan',
    body: [
      'Allt som ska pekas ut på kartan utan att vara en kontroll: parkering, sekretariat, toaletter, vattenpost, matplats, samlingsplats. Varje plats får en färgad nål med sin symbol och syns på tävlingssidan, startkorten och i Läget.',
      'Välj en sorts plats så sätts symbol och färg åt dig — eller välj "Egen plats" och peka ut vad som helst med den symbol och färg du vill. Noteringen visas publikt, till exempel "Parkera högst upp, ej framför lokalen".'
    ],
    faq: [
      { q: 'Var sätter jag start och mål?', a: 'I kontrollistan, tillsammans med resten av banan. De är banans ändpunkter — ETA:n räknar ben från dem och spåret hänger på dem — så de hör hemma där banan byggs, inte här.' },
      { q: 'Var tog parkeringsinställningen vägen?', a: 'Den är en plats som alla andra nu. Parkeringar som redan var utsatta ligger kvar och ritas som förut; nästa gång du sparar flyttar den in i listan.' },
      { q: 'Syns platserna innan tävlingsdagen?', a: 'Ja. Till skillnad från kontrollerna är de inte hemliga — de är till för att folk ska hitta.' }
    ]
  },

  'comp.selfFinish': {
    title: 'Patrullerna markerar sig i mål själva',
    body: [
      'Knappen "Vi är i mål" dyker upp på startkortet först när alla kontroller är rapporterade — patrullen kan alltså inte checka in sig medan de fortfarande har kontroller kvar.',
      'Det här är ett komplement, inte en ersättning: startfunktionären kan checka in patrullen på stationssidan precis som vanligt, och Läget visar båda i samma kolumn.'
    ],
    faq: [
      { q: 'Vad händer om de trycker för tidigt?', a: 'Det går inte — knappen finns inte förrän sista kontrollen är rapporterad. Och tiden går inte att flytta i efterhand; behöver den ångras gör en administratör det i Läget.' },
      { q: 'En patrull hoppade över en kontroll — kan de markera sig i mål?', a: 'Nej. Då får funktionären checka in dem på stationssidan, eller så markeras patrullen som utgången i Läget.' }
    ]
  },

  'comp.autoFinish': {
    title: 'Registrera målgång automatiskt',
    body: [
      'Patrullen räknas som i mål så snart alla kontroller är rapporterade. Tiden som används är sista rapportens — alltså när kontrollanten tryckte, inte när den synkades.',
      'Ingen tid skrivs till databasen: målgången härleds ur poängen. Prickar en funktionär in patrullen, eller markerar de sig själva, väger den riktiga tiden alltid tyngre. Läget märker de härledda med "auto" så du ser skillnad på sett och antaget.'
    ],
    warn: 'Slå bara på detta när sista kontrollen ÄR målet. Ligger målet en promenad bort visar Läget patrullen som hemma medan de fortfarande går — och det är den listan sekretariatet använder för att veta vem som är kvar ute i skogen.',
    faq: [
      { q: 'Kan jag kombinera med de andra sätten?', a: 'Ja. En funktionärs incheckning och patrullens egen markering slår alltid den automatiska — den fyller bara i luckorna.' },
      { q: 'Vad händer om en poäng rättas efteråt?', a: 'Målgången räknas om, eftersom den härleds ur poängen. Rättningar behåller dessutom ursprungstiden — en korrigering flyttar alltså inte målgången.' }
    ]
  },

  'comp.district': {
    title: 'Scoutdistrikt',
    body: [
      'Distriktet tävlingen hör till. Det används för att gruppera tävlingar i listan — när ESKIL rymmer många tävlingar blir det snabbt svårt att hitta rätt utan den indelningen.',
      'Listan följer Scouternas 26 distrikt. Välj "Annat / inget distrikt" om kåren står utanför distriktsindelningen, om tävlingen arrangeras tillsammans med andra förbund, eller om den helt enkelt inte hör hemma i något av dem.'
    ],
    faq: [
      { q: 'Kan jag ändra distrikt senare?', a: 'Ja. Till skillnad från kortadressen är distriktet fritt att ändra här under Grund.' },
      { q: 'Vårt distrikt saknas i listan', a: 'Distrikt slås ihop och byter namn ibland. Välj "Annat" tills vidare och hör av dig, så uppdateras listan.' }
    ]
  },

  'comp.avdelningar': {
    title: 'Avdelningar',
    body: [
      'Avdelningarna styr vilka åldersgrupper som kan anmälas och tävla. De används för separata klasser i poängtabellen och prisutdelningen, och kontrollerna kan ha olika instruktioner per avdelning.',
      'Bocka bara i dem som faktiskt deltar — de påverkar anmälningsformulärets val och vilka klasser som visas i resultaten.'
    ]
  },

  // ---------- Regler & info ----------
  'comp.anonymousControls': {
    title: 'Dolda kontrolluppgifter',
    body: [
      'Med den här på ser patrullen bara kontrollens nummer på sitt startkort tills de rapporterat poäng där. Uppgiften avslöjas alltså inte i förväg.',
      'Efter rapportering visas kontrollens namn som vanligt, så startkortet fungerar som en logg över vad patrullen gjort.'
    ],
    faq: [
      { q: 'Gäller det kontrollanternas sidor också?', a: 'Nej. Kontrollanterna ser alltid sin egen kontroll fullt ut — de behöver uppgiften för att kunna bygga och bemanna den.' }
    ]
  },

  'comp.publicScores': {
    title: 'Publika poäng',
    body: [
      'Styr om poängen syns på den offentliga tävlingssidan medan tävlingen pågår. Är den av visas i stället bara hur många kontroller varje patrull genomfört — spänningen sparas till prisutdelningen.',
      'Inställningen påverkar bara vad som visas. Tävlingsledningen ser alltid allt.'
    ],
    faq: [
      { q: 'Kan jag slå på den efter prisutdelningen?', a: 'Ja, det är precis tanken: kör mörklagt under dagen och tänd resultaten när pallen är avslöjad.' }
    ]
  },

  'comp.publicControls': {
    title: 'Publika kontrollpositioner',
    body: [
      'Avgör om kontrollernas placeringar syns på kartan — både på den offentliga tävlingssidan och på patrullernas startkort.',
      'När positionerna är dolda visas i stället ett skuggat tävlingsområde plus start, mål och parkering, så att anhöriga ändå ser var tävlingen äger rum.'
    ],
    demo: demoToggle('Dolda positioner', demoMapHidden(), 'Efter släppet', demoMapShown()),
    warn: 'Startkorten delas ut i förväg. Utan den här spärren kan patrullerna rekognosera banan dagarna före tävlingen.',
    faq: [
      { q: 'När blir positionerna synliga?', a: 'Antingen när du slår på inställningen manuellt, eller automatiskt fem minuter före första start om automatiskt släpp är påslaget.' },
      { q: 'Måste scouterna ladda om sidan?', a: 'Nej. Släppet slår igenom direkt i öppna startkort — kartan ritas om av sig själv.' }
    ]
  },

  'comp.autoReleaseControls': {
    title: 'Automatiskt släpp av kontroller',
    body: [
      'Släpper kontrollernas positioner automatiskt fem minuter före första patrullens start på tävlingsdagen. Då slipper du komma ihåg att göra det manuellt i morgonstressen.',
      'Kräver att både datum och första starttid är ifyllda — annars vet systemet inte när släppet ska ske.'
    ],
    faq: [
      { q: 'Vad händer om tävlingen blir försenad?', a: 'Släppet följer den planerade första starten, inte verkligheten. Blir det stor förskjutning kan du styra positionerna manuellt i stället.' }
    ]
  },

  'comp.autoCloseControls': {
    title: 'Stäng kontroller automatiskt',
    body: [
      'När samtliga patruller fått poäng på en kontroll stängs den för rapportering. Det skyddar mot efterhandsrapportering på fel kontroll och gör Läget lättare att läsa.',
      'Stängningen sker när en administratör tittar på kontrollen eller poängtabellen — inte av sig själv i bakgrunden.'
    ],
    faq: [
      { q: 'Kan en stängd kontroll öppnas igen?', a: 'Ja, när som helst från kontrollistan eller direkt från Läget om en patrull dyker upp sent.' }
    ]
  },

  'comp.startTimes': {
    title: 'Starttider',
    body: [
      'Slår på gemensam start med intervall. Patrullernas starttider räknas fram ur startordningen, och används sedan på startkortens nedräkning, startskärmen vid start, stationens "sen till start"-larm och tidsberäkningarna i Läget.',
      'Är den av startar patrullerna på egen hand utan schema, och alla tidsberäkningar utgår i stället från faktiska in- och utcheckningar.'
    ],
    faq: [
      { q: 'Intervall eller sluttid?', a: 'Med intervall bestämmer du minuterna mellan patrullerna. Med sluttid anger du sista start i stället, så räknas intervallet ut från antalet patruller — bra när startfönstret är låst.' },
      { q: 'Fungerar det över midnatt?', a: 'Ja, en tävling som startar 22:00 och sista start 02:00 hanteras korrekt.' }
    ]
  },

  'comp.maxTime': {
    title: 'Maxtid på banan',
    body: [
      'Den längsta tid en patrull får vara ute. Startkortet visar en nedräkning från patrullens egen starttid och färgar den röd sista kvarten, så patrullen själv ser när det börjar bli bråttom.',
      'Maxtiden är informativ — systemet diskvalificerar ingen automatiskt.'
    ],
    faq: [
      { q: 'Lämnar jag den tom?', a: 'Då visas ingen nedräkning alls. Det är helt i sin ordning för tävlingar utan tidsgräns.' }
    ]
  },

  'eta.model': {
    title: 'Så beräknas målgången',
    body: [
      'På morgonen är siffran en uppskattning: gångtiden längs banan i fyra kilometer i timmen, plus en kvart per kontroll patrullen ska hinna igenom.',
      'Under dagen kalibrerar sig beräkningen själv. Så snart tre patruller passerat samma sträcka ersätts uppskattningen av medianen av deras verkliga mellantider — och eftersom väntetid ingår i den, räknas köer in automatiskt utan att någon behöver rapportera dem.',
      'Varje patrulls tid ankras dessutom i dess senaste rapport, inte i starttiden. En patrull som ligger efter får därför en tid som speglar var den faktiskt är.'
    ],
    faq: [
      { q: 'Varför står det bara ett streck?', a: 'Patrullen har inte startat, är redan i mål eller har markerats som utgången. Beräkningen gäller bara patruller som är ute på banan.' },
      { q: 'Vad betyder "väntas nu"?', a: 'Den beräknade tiden har passerat. Det behöver inte betyda att något är fel — men i kombination med lång tystnad är det värt ett samtal till närmaste kontroll.' },
      { q: 'Kan jag lita på siffran på morgonen?', a: 'Se den som en grov planeringssiffra tills några patruller hunnit runt. Ju fler rapporter, desto närmare verkligheten.' },
      { q: 'Var syns samma beräkning mer?', a: 'På kontrollernas rapportsidor ("patruller väntas hit ca…"), på stationens målflik, på patrullernas startkort och i startlistan för anhöriga.' }
    ]
  },

  'comp.generalInfo': {
    title: 'Allmän information',
    body: [
      'Text som visas för alla kontrollanter längst ner på deras rapportsida, och som följer med i fältpaketets PDF.',
      'Här hör sådant hemma som varje funktionär behöver veta oavsett kontroll: akutrutiner, var sjukvårdsväskan finns, vem som ringer 112 och hur man når tävlingsledningen.'
    ],
    warn: 'Texten är läsbar för alla som har en kontrollänk. Skriv inga personuppgifter utöver tävlingsledningens tjänstekontakter.'
  },

  // ---------- Anmälan ----------
  'reg.enabled': {
    title: 'Anmälan via ESKIL',
    body: [
      'Öppnar ett anmälningsformulär på tävlingens publika adress. Kårer anmäler sina patruller själva, får en bekräftelse via mail och en egen länk där de kan ändra anmälan så länge den är öppen.',
      'Är den av tar ni emot anmälningar på annat sätt och lägger in patrullerna manuellt under Patruller.'
    ]
  },

  'reg.period': {
    title: 'Anmälningsperiod',
    body: [
      'Datumen styr när formuläret tar emot anmälningar. Före öppningsdatumet visas en "öppnar snart"-sida, efter stängningsdatumet en stängd sida — båda med tävlingens kontaktuppgifter.',
      'Båda datumen räknas inklusive: sista anmälningsdag betyder att anmälningar går igenom hela den dagen.'
    ],
    faq: [
      { q: 'Kan kårer ändra sin anmälan efter stängning?', a: 'Nej, då låses ändringslänken för redigering. Kåren kan fortfarande se sin anmälan och anmäla förhinder, och du kan alltid justera manuellt.' }
    ]
  },

  'reg.mode': {
    title: 'Anmälningssätt',
    body: [
      'Kårvis anmälan betyder att en person anmäler hela kårens patruller i ett formulär, med en kontakt och en betalning. Patrullvis betyder att varje patrull anmäls för sig.',
      'Kårvis är det vanliga för scouttävlingar: det ger en motpart per kår att fakturera och kommunicera med.'
    ]
  },

  'reg.pricing': {
    title: 'Prismodell',
    body: [
      'Avgör hur avgiften räknas fram när kåren anmäler. Beloppet visas direkt i formuläret och blir underlag för betalningsreferensen.',
      'Per patrull tar en fast avgift per anmäld patrull. Per scout multiplicerar med antalet deltagare. Fast avgift tar samma summa oavsett storlek. Dynamisk kombinerar en grundavgift med ett pris per patrull eller scout.'
    ],
    faq: [
      { q: 'Kan jag ändra priset efter att anmälningar kommit in?', a: 'Ja, men redan skapade betalningsposter behåller sitt belopp. Ändringen gäller nya anmälningar och tillägg.' },
      { q: 'Vad händer om en kår lägger till en patrull i efterhand?', a: 'Systemet räknar fram mellanskillnaden och skapar en ny betalningspost för den.' }
    ]
  },

  'reg.methods': {
    title: 'Betalningssätt',
    body: [
      'Betalningssätten visas för kåren efter att anmälan skickats. Swish ger både en knapp som öppnar appen med belopp och referens ifyllda, och en QR-kod att skanna från en annan enhet.',
      'Bankgiro och faktura visar i stället numret och referensen som ska anges som meddelande.'
    ],
    warn: 'Betalningar prickas av manuellt av er under fliken Anmälan — ESKIL har ingen koppling till banken och kan inte se när pengarna kommit in.'
  },

  'reg.fields': {
    title: 'Egna frågor i anmälan',
    body: [
      'Fritextfrågor som kåren svarar på i anmälningsformuläret. Frågor per anmälan ställs en gång för hela kåren, frågor per patrull ställs för varje patrull — det senare passar allergier och specialkost.',
      'Beskrivningen visas kursivt under rubriken och är rätt plats för det som annars blir följdfrågor: vad alternativen innebär, vad ni behöver veta och varför.'
    ],
    faq: [
      { q: 'Var ser jag svaren?', a: 'Under fliken Anmälan, på varje anmälan. Svaren följer också med i exporten.' },
      { q: 'Vad händer med svaren efteråt?', a: 'De rensas automatiskt när tävlingen avslutas, eftersom de ofta innehåller känsliga uppgifter som allergier.' }
    ]
  },

  // ---------- Start/Mål ----------
  'comp.startFinish': {
    title: 'Start- och målplats',
    body: [
      'Banans ändpunkter. De sätts i kontrollistan, tillsammans med resten av banan: ETA-motorn räknar första och sista benet från dem, spårdragningen hänger på dem och start/mål-stationen checkar av mot dem.',
      'Normalt är start och mål samma plats. Ligger målet någon annanstans väljer du "Målet ligger någon annanstans" i listan — då blir det ett eget ben in i mål, och sträckan räknas om.'
    ],
    faq: [
      { q: 'Behöver jag sätta start och mål?', a: 'Nej, men utan dem räknas banan bara mellan kontrollerna. Startkortets "Så tar ni er till starten" blir också tommare.' },
      { q: 'Kan de ha egen symbol och färg?', a: 'Nej. Start och mål har en fast, igenkännbar look på alla kartor — de ska aldrig kunna förväxlas med en intressepunkt. Vill du färgsätta något är det platserna under Inställningar → Platser.' },
      { q: 'Vad händer om jag tar bort målet?', a: 'Banan går tillbaka till samma plats för start och mål.' }
    ]
  },


  // ---------- Tävlingsledning ----------
  'comp.management': {
    title: 'Tävlingsledning',
    body: [
      'Rollerna med kontaktuppgifter. Publika roller visas på tävlingssidan så att kårer och anhöriga vet vem de ska kontakta. Interna roller visas bara för funktionärerna — på kontrollernas rapportsidor och i fältpaketets PDF.',
      'Rollen ekonomiansvarig ger dessutom behörighet: personen får läsa hela tävlingen och pricka av betalningar, men kan inte ändra något annat.'
    ],
    warn: 'Kontaktuppgifterna rensas automatiskt när tävlingen avslutas — rollen finns kvar, men namn, telefon och e-post tas bort.',
    faq: [
      { q: 'Blir en person automatiskt administratör?', a: 'Nej. Rollen i tävlingsledningen är en kontaktuppgift. Behörighet ges under Användare, förutom ekonomiansvarig som får sin läsbehörighet via kryssrutan.' }
    ]
  },

  // ---------- Användare ----------
  'comp.users': {
    title: 'Användare & administratörer',
    body: [
      'Behörigheten följer e-postadressen, inte kontot. Du kan bjuda in någon som aldrig loggat in i ESKIL — rättigheten aktiveras automatiskt första gången personen loggar in med exakt den adressen.',
      'Administratörer får ändra allt i tävlingen. Läsbehöriga ser samma vyer men kan inte ändra. Kontrollansvariga utses på respektive kontroll och får läsa tävlingen plus sköta sin egen kontroll.'
    ],
    warn: 'Var minst två administratörer. Tappar den ende adminen åtkomsten på tävlingsdagen finns ingen som kan öppna kontroller eller rätta poäng.',
    faq: [
      { q: 'Varför syns inte personen i listan över konton?', a: 'Kontot skapas först vid personens första inloggning. Behörigheten gäller ändå — inbjudna utan konto listas separat under Användare på systemnivå.' },
      { q: 'Vad händer när tävlingen avslutas?', a: 'Alla användare, kontrollansvariga och ekonomiansvariga tas bort som en del av GDPR-gallringen. Administratörerna ligger kvar.' }
    ]
  },

  // ---------- Kontroller ----------
  'ctrl.nummer': {
    title: 'Kontrollnummer',
    body: [
      'Numret är banans ordning. Patrullerna antas gå kontrollerna i nummerordning, och det antagandet används på flera ställen: köberäkningen i Läget, spårets sträckning, tidsberäkningarna och "nästa kontroll" på startkortet.',
      'Numret visas alltid för patrullen, även när kontrollernas uppgifter är dolda.'
    ]
  },

  'ctrl.points': {
    title: 'Poängsättning',
    body: [
      'Max- och minpoäng avgränsar vad kontrollanten kan rapportera. Det är inte bara en hjälp — säkerhetsreglerna avvisar poäng utanför intervallet, så en felskrivning kan inte hamna i tabellen.',
      'Extrapoäng är en separat pott för sådant som stil, samarbete eller bonusuppgifter. Den räknas ovanpå grundpoängen och visas separat i poängtabellen.'
    ],
    faq: [
      { q: 'Kan jag ändra maxpoäng mitt under tävlingen?', a: 'Ja, men redan rapporterade poäng ändras inte. Höj hellre än sänk, så att befintliga rapporter fortsätter vara giltiga.' }
    ]
  },

  'ctrl.placement': {
    title: 'Placering',
    body: [
      'Beskrivningen och positionen används för att hitta kontrollen. De trycks i kontrollens PDF tillsammans med en karta som visar vägen in till kontrollen och vart patrullerna ska skickas vidare.',
      'Koordinaterna visas också på patrullernas startkort vid nödsituation, så att en skadad patrull kan uppge exakt position.'
    ]
  },

  'ctrl.instructions': {
    title: 'Instruktioner',
    body: [
      'Uppgiften som kontrollanten läser upp eller följer. Du kan ge olika instruktioner till olika avdelningar — spårare får en enklare variant än utmanare — och en standardtext för alla som inte har en egen.',
      'Instruktionerna visas på kontrollens rapportsida och trycks i kontroll-PDF:en.'
    ]
  },

  'ctrl.utslag': {
    title: 'Utslagsfråga',
    body: [
      'En gissningsfråga som skiljer patruller med samma poäng. Kontrollanten matar in patrullens gissning tillsammans med poängen, och den som gissar närmast rätt svar vinner delade placeringar.',
      'Facit fyller du i när tävlingen är klar — antingen här eller direkt i poängtabellen. Rangordningen tar hänsyn till gissningarna först när facit är satt.'
    ],
    faq: [
      { q: 'Vad händer om kontrollanten glömmer fråga?', a: 'Rapportsidan varnar innan den sparar en rapport utan gissning, och patruller som saknar svar märks upp i listan så att det går att komplettera.' }
    ]
  },

  'ctrl.telefon': {
    title: 'Telefon till kontrollen',
    body: [
      'Numret till den som bemannar kontrollen under tävlingen. Det visas för tävlingsledningen i Läget och i poängtabellens restlista, som klickbara nummer — så att man kan ringa direkt när en patrull är försenad eller en rapport saknas.',
      'Numret trycks också i fältpaketets telefonlista.'
    ],
    warn: 'Numret är en personuppgift och lagras internt, aldrig publikt. Det raderas automatiskt när tävlingen avslutas.'
  },

  'ctrl.ansvariga': {
    title: 'Kontrollansvariga',
    body: [
      'Den eller de som ansvarar för kontrollen. De får läsbehörighet till hela tävlingen plus rätt att redigera och öppna eller stänga sin egen kontroll, och kan bjuda in fler medansvariga.',
      'En kontrollansvarig kan lägga till kollegor men aldrig ta bort någon — det kan bara en administratör. Det gör att ingen kan låsa ut den andre mitt i förberedelserna.'
    ]
  },

  // ---------- Meddelanden ----------
  'msg.level': {
    title: 'Nivå',
    body: [
      'Nivån styr både utseende och hur mycket meddelandet stör. Information visas i lugn blå ton, varning i gult, och kritisk information i rött med pulserande banner.',
      'Kritisk nivå larmar dessutom: mottagarnas enheter vibrerar och spelar en stigande signal. Använd den när något måste uppmärksammas omedelbart — avbruten tävling, åska, olycka.'
    ],
    demo: demoBanner('kritisk', 'Tävlingen pausas — ta skydd och invänta besked.', { ack: true, caption: 'Kritiskt meddelande med begärd bekräftelse, som det ser ut på en kontrollants mobil.' })
  },

  'msg.target': {
    title: 'Mottagare',
    body: [
      'Välj vilka som ska se meddelandet. Kontrollkanalen når kontrollernas rapportsidor och start/mål-stationen. Patrullkanalen når patrullernas startkort och startskärmen vid starten.',
      'Med "vissa" kan du rikta meddelandet till enstaka kontroller eller patruller — bra när bara en del av banan berörs.'
    ]
  },

  'msg.requireAck': {
    title: 'Begär bekräftelse',
    body: [
      'Mottagarna får en knapp att trycka på, och du ser vilka som tagit emot och vilka som bekräftat — per kontroll, patrull och station.',
      '"Mottaget" stämplas automatiskt när meddelandet visats på enheten. "Bekräftat" kräver att en människa tryckt på knappen.'
    ],
    warn: 'Kvittenserna rapporteras av fältenheterna utan inloggning. Använd dem som lägesbild — vid kritiska lägen, bekräfta muntligt via telefonlistan i Läget.'
  },

  'msg.clearOthers': {
    title: 'Avsluta alla andra samtidigt',
    body: [
      'Flera meddelanden kan vara aktiva på samma gång och staplas hos mottagarna. Ibland ska ett nytt meddelande ersätta det gamla i stället för att läggas ovanpå.',
      'Ett typiskt fall är "tävlingen återupptas" efter en paus: utan det här skulle det kritiska pausmeddelandet ligga kvar och säga emot det nya.'
    ]
  },

  // ---------- Patruller ----------
  'patrol.startOrder': {
    title: 'Startordning',
    body: [
      'Startordningen avgör patrullens starttid: första start plus ordningsnummer gånger intervallet. Den styr också turordningen på startskärmen och i startlistan.',
      'Ordningen sätts genom att dra patrullerna i listan. Numret är alltså positionen i listan, inte ett fritt fält.'
    ]
  },

  'patrol.number': {
    title: 'Patrullnummer',
    body: [
      'Numret patrullen är känd som under dagen — det som ropas ut vid start och som kontrollanterna letar efter i listan.',
      'Numret är oberoende av startordningen: patrull 7 kan mycket väl starta först.'
    ]
  }
};

// --- Knapp och modal ----------------------------------------------------------

export function help(id) {
  if (!HELP[id]) {
    console.warn('[help] okänt hjälp-id:', id);
    return '';
  }
  return `<button type="button" class="help-btn" data-help="${escapeHtml(id)}" aria-label="Mer om ${escapeHtml(HELP[id].title)}" title="Mer om ${escapeHtml(HELP[id].title)}">${icon('help', { size: 15 })}</button>`;
}

function render(entry) {
  return `
    <div class="modal help-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(entry.title)}">
      <div class="modal-head">
        <h3>${escapeHtml(entry.title)}</h3>
        <button type="button" class="help-close" id="help-close" aria-label="Stäng">${icon('x', { size: 20 })}</button>
      </div>
      <div class="modal-body">
        ${(entry.body || []).map(p => `<p>${escapeHtml(p)}</p>`).join('')}
        ${entry.demo || ''}
        ${entry.warn ? `<div class="help-warn">${escapeHtml(entry.warn)}</div>` : ''}
        ${(entry.faq || []).length ? `
          <h4 class="help-faq-head">Vanliga frågor</h4>
          ${entry.faq.map(f => `
            <div class="help-faq">
              <div class="help-q">${escapeHtml(f.q)}</div>
              <div class="help-a">${escapeHtml(f.a)}</div>
            </div>`).join('')}` : ''}
      </div>
      <div class="modal-foot"><button class="btn btn-secondary" id="help-ok">Stäng</button></div>
    </div>`;
}

export function openHelp(id) {
  const entry = HELP[id];
  if (!entry) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = render(entry);
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    last?.focus?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const last = document.activeElement;
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#help-close').addEventListener('click', close);
  overlay.querySelector('#help-ok').addEventListener('click', close);
  setTimeout(() => overlay.querySelector('#help-close')?.focus(), 30);
}

// Delegerad lyssnare — installeras en gång, gäller all hjälp i hela appen.
if (typeof document !== 'undefined' && !window.__eskilHelpWired) {
  window.__eskilHelpWired = true;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-help]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    openHelp(btn.dataset.help);
  });
}
