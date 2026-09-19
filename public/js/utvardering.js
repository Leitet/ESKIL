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
  ut.foregaende = (f && typeof f === 'object') ? {
    namn: str(f.namn), ar: f.ar ?? '',
    ...Object.fromEntries(UTV_NYCKLAR.map(k => [k, str(f[k])])),
    bilder: normBilder(f.bilder).filter(b => b.sektion !== 'text')
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
  const foregaende = utvarderingTom(u) ? u.foregaende : {
    namn: str(comp?.shortName) || str(comp?.name),
    ar: comp?.year ?? '',
    ...Object.fromEntries(UTV_NYCKLAR.map(k => [k, u[k]])),
    bilder: u.bilder.filter(b => b.sektion !== 'text')
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
