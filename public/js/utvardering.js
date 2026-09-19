// Utvärdering och överlämning — den rena delen (inga Firebase-anrop, testad).
//
// "Post mortem" är IT-jargong; i föreningslivet heter det UTVÄRDERING, och
// dokumentet som går vidare heter ÖVERLÄMNING. Formuläret har fyra delar i en
// medveten ordning:
//
//   1. Vad fungerade bra        — det man vill göra om. Glöms annars först.
//   2. Vad fungerade mindre bra — det som stack ut. Hålls ISÄR från
//                                 förbättringarna, annars blir allt en önskelista
//                                 och ingen minns vad som faktiskt hände.
//   3. Förbättringsförslag      — konkreta åtgärder. Det nästa ledning öppnar först.
//   4. Kort sammanfattning      — helhetsbilden: väder, stämning, antal, upplägg.
//
// Allt ligger i competitions/{cid}/private/handover — SAMMA dokument som det
// gamla fritextfältet (`text`), som lever kvar som "Löpande anteckningar". Inga
// befintliga dokument behöver migreras: ett dokument med bara `text` är en giltig
// utvärdering med fyra tomma delar. Skrivningar MÅSTE gå med merge (se
// sparaUtvardering i store.js) — en setDoc utan merge hade sopat de andra fälten.
//
// Bilderna ligger INTE i dokumentet (1 MiB-taket): en doc per bild i
// private/utv-bild-<id>, med ett index (`bilder`) i handover-dokumentet som bär
// ordning, del och bildtext. private/{doc}-regeln täcker dem utan regeländring,
// och deleteCompetition sveper redan hela private-kollektionen.

export const UTV_SEKTIONER = [
  {
    key: 'bra',
    titel: 'Vad fungerade bra',
    ingress: 'Det ni vill göra om nästa år. Skriv ner det — det som gick bra är det som glöms först.',
    exempel: 'T.ex. sponsorer, ESKIL + pappersbackup, dubbel bemanning på kontrollerna, lucka i startfältet, lånekåsor.'
  },
  {
    key: 'mindreBra',
    titel: 'Vad fungerade mindre bra',
    ingress: 'Det som stack ut under dagen — vad som hände, inte vad ni önskar. Åtgärderna hör hemma i nästa del.',
    exempel: 'T.ex. rekryteringen kom igång för sent, markörer och reflexer saknades, mat blev över, kontrollplatserna spikades sent.'
  },
  {
    key: 'forbattringar',
    titel: 'Förbättringsförslag till nästa år',
    ingress: 'Konkreta åtgärder, gärna med tidpunkt. Det här är det nästa års ledning öppnar först.',
    exempel: 'T.ex. "Börja rekrytera funktionärer i juni", "3 personer per kontroll", "ordningspoäng som egen kontroll".'
  },
  {
    key: 'sammanfattning',
    titel: 'Kort sammanfattning',
    ingress: 'Helhetsbilden på några rader: väder och stämning, ungefärligt antal, start och intervall, var sekretariatet satt.',
    exempel: 'T.ex. "Soligt men blåsigt, över 200 deltagare. Första start 09:00 med 5 min intervall, sekretariatet i scoutstugan."'
  }
];

// Det gamla fritextfältet. Följer med år från år som ett levande dokument:
// markägare, bokningar, vem som har materiel.
export const UTV_ANTECKNINGAR = {
  key: 'text',
  titel: 'Löpande anteckningar',
  ingress: 'Det som gäller år efter år och inte syns i systemet: markägare som ska ringas, bokningar, vem som har materiel, fällor att undvika. Följer med oförändrat till nästa årgång.',
  exempel: 'T.ex. Boka Tinnerö-stugan i januari. Kontroll 4 behöver eldningstillstånd…'
};

// Överlämning till en NY arrangör — en kryssruta i formuläret. Texten är
// densamma för alla tävlingar (den beskriver hur ESKIL fungerar, inte er
// tävling) och bor därför här, så att formuläret, rapporten och nästa års
// tävling visar exakt samma sak. VARJE påstående är bundet till koden av ett
// test: argangskopia.js (vad en kopia innehåller), forNyArrangor (vad som INTE
// följer med till en ny arrangör — betalningsuppgifter, namn, arrangör) och
// planeraOvertag i functions/overlamning.js (inlösaren blir ensam
// administratör). Ändras någon av dem: ändra här.
export const OVERLAMNING_ADRESS = 'eskilscout.se/overlamning';
export const OVERLAMNING_ARRANGOR = {
  titel: 'Överlämning till nästa arrangör',
  kryssruta: 'Tävlingen går vidare till en ny arrangör — ta med information om hur de tar vid i ESKIL',
  ingress: 'Tävlingen byter arrangör. Nästa arrangör tar över med en överlämningskod: ingen data flyttas för hand, ingen behöver få åtkomst till er tävling, och er egen tävling ligger kvar orörd som arkiv.',
  steg: [
    { rubrik: 'Skapa en överlämningskod',
      text: 'Under Inställningar -> Grund -> Utvärdering och överlämning. Koden skrivs ut i den här rapporten. Den gäller en enda gång, och en ny kod drar in den gamla.' },
    { rubrik: 'Lämna rapporten — eller bara koden — till nästa arrangör',
      text: 'Koden är en värdehandling: den som har den kan skapa en kopia av tävlingens upplägg. Lämna den till rätt person. I ESKIL ser ni när koden lösts in och från vilken e-postadress, och ni kan dra in den så länge den inte är använd.' },
    { rubrik: `Nästa arrangör löser in koden på ${OVERLAMNING_ADRESS}`,
      text: 'Hen skriver koden och sin e-postadress, får en inloggningslänk i mejlen och landar i en färdig tävling för nästa år — som ensam administratör. Inget konto behöver skapas i förväg, och ingen hos er behöver göra något mer.' },
    { rubrik: 'Lämna över det som inte finns i ESKIL',
      text: 'Materiel, nycklar, kontaktlistor, markägaravtal, sponsorer. Skriv upp det i de löpande anteckningarna — de följer med i kopian.' }
  ],
  foljerMed: [
    'Kontrollerna med instruktioner, placeringsbeskrivningar, positioner och utslagsfrågor',
    'Det ritade spåret, start och mål samt platserna',
    'Inställningar och regler — starttidsmall, anonyma kontroller, hemligt spår med mera',
    'Anmälans upplägg, egna fält och prismodell',
    'Tävlingsledningens roller — utan namn; nästa arrangör fyller i sina egna',
    'Utvärderingen (som "förra årets utvärdering") och de löpande anteckningarna, med bilder'
  ],
  foljerInteMed: [
    'Era namn, telefonnummer och e-postadresser, och arrangörens namn',
    'Betalningsuppgifterna (Swish, bankgiro) — nästa arrangör lägger in sina egna',
    'Patruller, poäng, anmälningar och betalningar',
    'Användare, kontrollansvariga och kontrollernas telefonnummer',
    'Utslagsfrågornas facit',
    'De hemliga länkarna — alla kontroller och startkort får nya',
    'Kortadressen (t.ex. ah26) — den nya tävlingen väljer en egen',
    'Åtkomst till ER tävling — den får nästa arrangör aldrig'
  ],
  attGoraForst: [
    'Kontrollera betalningsuppgifterna under Inställningar -> Anmälan. Med överlämningskoden följer de inte med och måste läggas in — utan dem kan ingen betala. Kopierades tävlingen på annat sätt pekar de på FÖRRA arrangörens konto.',
    'Fyll i tävlingsledningens namn och kontaktuppgifter under Inställningar -> Tävlingsledning. Rollerna finns kvar, personerna är era.',
    'Sätt arrangör, datum och scoutdistrikt under Inställningar -> Grund, och välj en kortadress. Kortadressen går inte att ändra efteråt.',
    'Lägg till resten av er ledning som administratörer under Inställningar -> Användare.',
    'Gå igenom kontrollernas positioner och instruktioner — banan ligger kvar där förra arrangören hade den.',
    'Läs förra årets utvärdering. Förbättringsförslagen står överst.',
    'Anmälan är avstängd och starttiderna opublicerade tills ni själva slår på dem.'
  ]
};

export const UTV_NYCKLAR = UTV_SEKTIONER.map(s => s.key);
export const UTV_ALLA_NYCKLAR = [...UTV_NYCKLAR, UTV_ANTECKNINGAR.key];
export const MAX_BILDER_PER_SEKTION = 6;
export const MAX_TEXT = 20000;
export const MAX_BILDTEXT = 200;
export const BILD_PREFIX = 'utv-bild-';

const str = (v) => (typeof v === 'string' ? v : '');

function normBilder(arr) {
  const sett = new Set();
  return (Array.isArray(arr) ? arr : [])
    .filter(b => b && typeof b.id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(b.id)
      && UTV_ALLA_NYCKLAR.includes(b.sektion) && !sett.has(b.id) && sett.add(b.id))
    .map(b => ({ id: b.id, sektion: b.sektion, bildtext: str(b.bildtext).slice(0, MAX_BILDTEXT) }));
}

// Alltid samma form ut, vad som än ligger i databasen — ett gammalt dokument
// med bara `text`, ett halvskrivet, eller inget alls.
export function normUtvardering(ho) {
  const f = ho?.foregaende;
  const ut = {};
  for (const k of UTV_ALLA_NYCKLAR) ut[k] = str(ho?.[k]);
  ut.bilder = normBilder(ho?.bilder);
  // Bara `=== true`: ett saknat fält (varje dokument från före kryssrutan) är av.
  ut.nyArrangor = ho?.nyArrangor === true;
  ut.nyArrangorText = str(ho?.nyArrangorText);
  ut.foregaende = (f && typeof f === 'object') ? {
    namn: str(f.namn), ar: f.ar ?? '',
    ...Object.fromEntries(UTV_NYCKLAR.map(k => [k, str(f[k])])),
    bilder: normBilder(f.bilder).filter(b => b.sektion !== 'text'),
    nyArrangor: f.nyArrangor === true,
    nyArrangorText: str(f.nyArrangorText)
  } : null;
  ut.updatedAt = str(ho?.updatedAt);
  ut.updatedBy = str(ho?.updatedBy);
  return ut;
}

// Har ÅRETS ledning skrivit någon utvärdering (de fyra delarna)? De löpande
// anteckningarna räknas inte — de är ärvda.
export function utvarderingTom(u) {
  const n = normUtvardering(u);
  return UTV_NYCKLAR.every(k => !n[k].trim()) && !n.bilder.some(b => b.sektion !== 'text');
}

export function bilderForSektion(u, sektion) {
  return normUtvardering(u).bilder.filter(b => b.sektion === sektion);
}

// Varje bild-id dokumentet pekar på — årets och förra årets. Det är listan som
// backupen, årgångskopian och PDF:en hämtar efter.
export function utvarderingBildIds(u) {
  const n = normUtvardering(u);
  return [...new Set([...n.bilder, ...(n.foregaende?.bilder || [])].map(b => b.id))];
}

// Det som skrivs till NÄSTA års tävling vid årgångskopieringen. Årets fyra
// delar blir nästa års "förra året" — skrivskyddade där, som facit att följa
// upp mot. De löpande anteckningarna bärs vidare som de är. Har årets ledning
// inte skrivit någon utvärdering bärs den äldre vidare: hellre en två år
// gammal läxa än ingen.
export function utvarderingForNastaAr(ho, comp) {
  const u = normUtvardering(ho);
  // Överlämningen till ny arrangör räknas som eget innehåll: har ledningen bara
  // kryssat i rutan ska nästa arrangör ändå mötas av "att göra först". Själva
  // kryssrutan bärs INTE vidare som nästa års egen — den gäller årets överlämning.
  const foregaende = (utvarderingTom(u) && !u.nyArrangor) ? u.foregaende : {
    namn: str(comp?.shortName) || str(comp?.name),
    ar: comp?.year ?? '',
    ...Object.fromEntries(UTV_NYCKLAR.map(k => [k, u[k]])),
    bilder: u.bilder.filter(b => b.sektion !== 'text'),
    nyArrangor: u.nyArrangor,
    nyArrangorText: u.nyArrangor ? u.nyArrangorText : ''
  };
  return {
    text: u.text,
    bilder: u.bilder.filter(b => b.sektion === 'text'),
    foregaende: foregaende || null,
    updatedAt: u.updatedAt,
    updatedBy: u.updatedBy
  };
}

// Finns det något alls att bära vidare?
export function harInnehall(ny) {
  return !!(ny && (str(ny.text).trim() || ny.foregaende || (ny.bilder || []).length));
}
