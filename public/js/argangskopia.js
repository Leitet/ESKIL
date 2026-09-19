// Årgångskopian — den RENA delen: vad en kopia av en tävling innehåller.
//
// Två vägar skapar en kopia, och de måste ge samma tävling:
//   1. "Kopiera till ny tävling" i webbläsaren (copyCompetition i store.js),
//      där ledningen kopierar sin egen tävling.
//   2. Överlämningskoden, där en NY arrangör löser in en kod och servern gör
//      kopian åt dem (functions/overlamning.js) — de har ingen rätt till
//      källan, så det kan inte ske i webbläsaren.
// Därför bor reglerna här som rena funktioner, servern har en CJS-spegel, och
// ett parity-test kör båda mot samma indata (test/overlamning.test.js).
// Ändrar du vad som följer med: ändra på BÅDA ställena, annars faller testet.

// Fält som följer med oförändrade.
export const KOPIERADE_FALT = [
  'startTimes', 'startFinish', 'parking', 'places', 'management',
  'publicScores', 'publicControls', 'autoReleaseControls',
  'anonymousControls', 'autoCloseControls', 'courseHidden',
  'selfStart', 'selfFinish', 'autoFinish', 'fieldMessaging'
];

// Tävlingsdokumentet för kopian. Ingen slug (kortadressen väljs på nytt),
// inga behörigheter (den som skapar kopian blir ensam administratör), anmälan
// avstängd, starttiderna opublicerade och utan luckor.
export function kopiaTavlingsdata(src, { name, shortName, year, date }) {
  const data = {
    name, shortName, year: Number(year) || null, date: date || null,
    location: src.location || '',
    organizer: src.organizer || '',
    description: src.description || '',
    generalInfo: src.generalInfo || '',
    closed: false,
    demo: false,
    adminEmails: [],
    userEmails: [],
    district: src.district || 'annat',
    copiedFrom: src.id
  };
  if (Array.isArray(src.avdelningar) && src.avdelningar.length) data.avdelningar = src.avdelningar;
  for (const k of KOPIERADE_FALT) if (src[k] !== undefined) data[k] = src[k];
  if (src.registration) {
    data.registration = { ...src.registration, enabled: false, opensAt: null, closesAt: null };
  }
  if (data.startTimes) data.startTimes = { ...data.startTimes, published: false, luckor: [], luft: [] };
  return data;
}

// En kontroll i kopian: stängd, utan ansvariga, utan facit. Telefon och
// notering ligger i private/meta och följer aldrig med.
export function kopiaKontroll(c) {
  const copy = {
    nummer: c.nummer ?? null,
    name: c.name || '',
    maxPoang: c.maxPoang ?? 0,
    minPoang: c.minPoang ?? 0,
    extraPoang: c.extraPoang ?? 0,
    placement: c.placement || '',
    ansvariga: [],
    ansvarigaEmails: [],
    open: false
  };
  if (c.tidtagning === true) copy.tidtagning = true;
  if (Number.isFinite(c.lat)) { copy.lat = c.lat; copy.lng = c.lng; }
  if (Array.isArray(c.instructions)) copy.instructions = c.instructions;
  else if (c.information) copy.information = c.information;
  if (c.utslag) {
    copy.utslag = true;
    copy.utslagFraga = c.utslagFraga || '';
    copy.utslagSvar = null;
  }
  return copy;
}

// Spårets sträcknycklar bär kontroll-id:n — byt dem mot kopians.
export function remappaSpar(legs, idMap) {
  const ut = {};
  for (const [key, wps] of Object.entries(legs || {})) {
    let ny = key;
    for (const [gammalt, nytt] of Object.entries(idMap || {})) ny = ny.replaceAll(gammalt, nytt);
    ut[ny] = wps;
  }
  return ut;
}

// Nästa års namn: byt årtalet om det står i namnet.
export function nastaArsNamn(text, ar, nastaAr) {
  const s = String(text || '');
  return ar && s.includes(String(ar)) ? s.replaceAll(String(ar), String(nastaAr)) : s.trim();
}

// ÖVERLÄMNING TILL NY ARRANGÖR: samma kopia, minus det som hör till den
// GAMLA arrangören. Betalningsuppgifterna är det viktiga — ett kvarglömt
// Swish-nummer skickar nästa års anmälningsavgifter till fel kår. Rollerna
// behålls (strukturen är en del av upplägget), personerna töms.
export function forNyArrangor(data) {
  const ut = { ...data, organizer: '' };
  if (Array.isArray(ut.management)) {
    ut.management = ut.management.map(r => ({ ...r, name: '', phone: '', email: '' }));
  }
  if (ut.registration) ut.registration = { ...ut.registration, methods: [] };
  return ut;
}
