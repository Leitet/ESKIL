// Överlämningskoden — serverdelen. En NY arrangör löser in en kod och får en
// kopia av tävlingens upplägg med sig själv som ensam administratör.
//
// TREDJE undantaget från "Cloud Functions finns bara för mail" (efter
// deleteMyAccount och MCP-servern), och av samma slags skäl: det GÅR inte i
// klienten. Reglerna släpper bara in en kopia från den som redan administrerar
// källan, och den som löser in koden har per definition ingen rätt till den —
// det är hela poängen med en överlämning till någon utanför kåren.
//
// Vad kopian innehåller bestäms INTE här utan av samma regler som
// webbläsarens "Kopiera till ny tävling": funktionerna nedan är CJS-speglar av
// public/js/argangskopia.js, overlamningskod.js och utvardering.js, och
// test/overlamning.test.js kör båda mot samma indata och kräver identiskt
// utfall. Ändrar du vad som följer med: ändra på båda ställena.

const crypto = require('crypto');
const { delaLedning } = require('./mcp/ledning');

// ── Koden ───────────────────────────────────────────────────────────────────
const KOD_ALFABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KOD_LANGD = 12;
const normKod = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const arGiltigKod = (s) => {
  const n = normKod(s);
  return n.length === KOD_LANGD && [...n].every(ch => KOD_ALFABET.includes(ch));
};
const kodHash = (s) => crypto.createHash('sha256').update(normKod(s), 'utf8').digest('hex');

// ── Årgångskopian (spegel av argangskopia.js) ───────────────────────────────
const KOPIERADE_FALT = [
  'startTimes', 'startFinish', 'parking', 'places', 'management',
  'publicScores', 'publicControls', 'autoReleaseControls',
  'anonymousControls', 'autoCloseControls', 'courseHidden',
  'selfStart', 'selfFinish', 'autoFinish', 'fieldMessaging'
];

function kopiaTavlingsdata(src, { name, shortName, year, date }) {
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

function kopiaKontroll(c) {
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

function remappaSpar(legs, idMap) {
  const ut = {};
  for (const [key, wps] of Object.entries(legs || {})) {
    let ny = key;
    for (const [gammalt, nytt] of Object.entries(idMap || {})) ny = ny.replaceAll(gammalt, nytt);
    ut[ny] = wps;
  }
  return ut;
}

function nastaArsNamn(text, ar, nastaAr) {
  const s = String(text || '');
  return ar && s.includes(String(ar)) ? s.replaceAll(String(ar), String(nastaAr)) : s.trim();
}

function forNyArrangor(data) {
  const ut = { ...data, organizer: '' };
  if (Array.isArray(ut.management)) {
    ut.management = ut.management.map(r => ({ ...r, name: '', phone: '', email: '' }));
  }
  if (ut.registration) ut.registration = { ...ut.registration, methods: [] };
  return ut;
}

// ── Utvärderingen (spegel av utvardering.js) ────────────────────────────────
const UTV_NYCKLAR = ['bra', 'mindreBra', 'forbattringar', 'sammanfattning'];
const UTV_ALLA_NYCKLAR = [...UTV_NYCKLAR, 'text'];
const MAX_BILDTEXT = 200;
const BILD_PREFIX = 'utv-bild-';
const str = (v) => (typeof v === 'string' ? v : '');

function normBilder(arr) {
  const sett = new Set();
  return (Array.isArray(arr) ? arr : [])
    .filter(b => b && typeof b.id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(b.id)
      && UTV_ALLA_NYCKLAR.includes(b.sektion) && !sett.has(b.id) && sett.add(b.id))
    .map(b => ({ id: b.id, sektion: b.sektion, bildtext: str(b.bildtext).slice(0, MAX_BILDTEXT) }));
}

function normUtvardering(ho) {
  const f = ho?.foregaende;
  const ut = {};
  for (const k of UTV_ALLA_NYCKLAR) ut[k] = str(ho?.[k]);
  ut.bilder = normBilder(ho?.bilder);
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

function utvarderingTom(u) {
  const n = normUtvardering(u);
  return UTV_NYCKLAR.every(k => !n[k].trim()) && !n.bilder.some(b => b.sektion !== 'text');
}

function utvarderingBildIds(u) {
  const n = normUtvardering(u);
  return [...new Set([...n.bilder, ...(n.foregaende?.bilder || [])].map(b => b.id))];
}

function utvarderingForNastaAr(ho, comp) {
  const u = normUtvardering(ho);
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

const harInnehall = (ny) => !!(ny && (str(ny.text).trim() || ny.foregaende || (ny.bilder || []).length));

// ── Inlösningen ─────────────────────────────────────────────────────────────
// Ett eget fel så att anroparen kan skilja "fel kod" från ett riktigt haveri.
class KodFel extends Error {}

// Planen för den nya tävlingen — ren, så att den går att testa utan databas.
function planeraOvertag(src, { email, uid, nu = new Date() }) {
  const ar = Number(src.year) || nu.getFullYear();
  const nastaAr = ar + 1;
  const data = forNyArrangor(kopiaTavlingsdata(src, {
    name: nastaArsNamn(src.name, src.year, nastaAr) || 'Ny tävling',
    shortName: nastaArsNamn(src.shortName, src.year, nastaAr),
    year: nastaAr,
    date: null
  }));
  // Behörigheterna bor i private/access, aldrig på det världsläsbara dokumentet.
  const { adminEmails, userEmails, ...publikt } = data;
  const delad = publikt.management !== undefined ? delaLedning(publikt.management) : null;
  if (delad) publikt.management = delad.publikt;
  return {
    comp: { ...publikt, admins: [uid], createdBy: uid, overtagenMedKod: true },
    access: { admins: [uid], users: [], adminEmails: [email], userEmails: [], ekonomi: [], ekonomiEmails: [] },
    nastaAr
  };
}

// En reservation som ingen avslutar.
//
// Koden tas i en transaktion (`anvand.pagar`) och släpps i catch-grenen om
// kopian havererar. Men en catch körs bara om processen LEVER: dör funktionen
// mitt i kopian — tidsgränsen, minnet, en omstart av instansen — körs ingen
// kod alls, och reservationen blev förut liggande för alltid. Koden var då
// bränd utan att någon tävling fanns, och den som stod med pappret fick
// "redan använd". Det är precis det en långlivad kod inte får råka ut för.
//
// Därför har reservationen en ålder (`sedan`, funktionens klocka i ms — en
// serverTimestamp går inte att räkna på i samma transaktion). Är den äldre än
// RESERVATION_TTL_MS hör den till ett anrop som är DÖTT: funktionen får leva i
// högst INLOSNING_TIMEOUT_S (index.js), och ett test kräver att TTL:en är
// längre än den med marginal. En reservation helt utan `sedan` är skriven av
// koden före den här ändringen och räknas som hängande.
const RESERVATION_TTL_MS = 15 * 60 * 1000;
const INLOSNING_TIMEOUT_S = 300;

const OGILTIG_KOD = 'Koden är ogiltig eller redan använd.';
// Ett EGET fel: koden är rätt, den är bara upptagen. Anroparen får inte glömma
// den (sidan rensar den väntande koden på "fel kod").
class KodUpptagen extends KodFel {}

// Städar en HALV kopia — dokument under ett tävlings-id vars tävlingsdokument
// aldrig skrevs. Tävlingsdokumentet skrivs SIST (se nedan), så en halv kopia
// syns inte för någon: inte i listor, inte för inlösaren, inte publikt.
// Vakten är hela säkerheten: finns tävlingsdokumentet rörs ingenting.
async function stadaHalvKopia(db, nyCid) {
  try {
    const ref = db.doc(`competitions/${nyCid}`);
    if ((await ref.get()).exists) return;
    if (typeof db.recursiveDelete === 'function') await db.recursiveDelete(ref);
  } catch { /* skräp som ingen ser får aldrig stoppa en inlösning */ }
}

async function losInKod(db, FieldValue, { kod, email, uid, nu = Date.now() }) {
  if (!arGiltigKod(kod)) throw new KodFel('Koden har fel form. Den ska se ut som XXXX-XXXX-XXXX.');
  const kodRef = db.doc(`overlamningskoder/${kodHash(kod)}`);
  // Id:t bestäms FÖRE reservationen och skrivs in i den, så att nästa försök
  // kan se vad det förra hann med.
  const nyRef = db.collection('competitions').doc();

  // Ta koden i en transaktion: två samtidiga inlösningar får inte ge två
  // tävlingar. Misslyckas kopian släpps den igen — ett haveri ska inte bränna
  // en kod som står tryckt i en rapport.
  const tagen = await db.runTransaction(async (tx) => {
    const snap = await tx.get(kodRef);
    const d = snap.exists ? snap.data() : null;
    if (!d || !d.cid) throw new KodFel(OGILTIG_KOD);
    const a = d.anvand;
    let forraCid = null;
    if (a) {
      if (!a.pagar) throw new KodFel(OGILTIG_KOD);
      const hanger = !Number.isFinite(a.sedan) || nu - a.sedan > RESERVATION_TTL_MS;
      if (!hanger) {
        throw new KodUpptagen('Koden håller redan på att lösas in. Blev det ett fel alldeles nyss? '
          + 'Vänta en kvart och försök igen — koden är inte förbrukad.');
      }
      forraCid = a.pagarCid || null;
      if (forraCid && (await tx.get(db.doc(`competitions/${forraCid}`))).exists) {
        // Förra försöket blev KLART — tävlingsdokumentet skrivs sist — men dog
        // före bokföringen. Bokför det nu i stället för att skapa en dubblett.
        tx.update(kodRef, { anvand: { at: FieldValue.serverTimestamp(), nyCid: forraCid } });
        return { cid: d.cid, klarCid: forraCid, av: a.av || '' };
      }
    }
    tx.update(kodRef, { anvand: {
      at: FieldValue.serverTimestamp(), pagar: true, sedan: nu, pagarCid: nyRef.id, av: email
    } });
    return { cid: d.cid, forraCid };
  });
  const cid = tagen.cid;

  // Den gamla arrangören ser i sitt formulär ATT koden lösts in och av vem —
  // det är den de lämnade över till, och de ska kunna upptäcka om det inte är det.
  const bokforKallan = (av, nyCid) => db.doc(`competitions/${cid}/private/overlamning`)
    .set({ anvand: { at: new Date(nu).toISOString(), av, nyCid } }, { merge: true })
    .catch(() => {});

  if (tagen.klarCid) {
    await bokforKallan(tagen.av, tagen.klarCid);
    // Bara den som GJORDE inlösningen får tävlingen tillbaka; för alla andra
    // är koden precis vad den är — använd.
    if (!tagen.av || tagen.av !== email) throw new KodFel(OGILTIG_KOD);
    const [ny, src, kontroller] = await Promise.all([
      db.doc(`competitions/${tagen.klarCid}`).get(),
      db.doc(`competitions/${cid}`).get(),
      db.collection(`competitions/${tagen.klarCid}/controls`).get()
    ]);
    return { cid: tagen.klarCid, name: ny.data().name || '', fran: (src.exists && src.data().name) || '', kontroller: kontroller.size };
  }
  if (tagen.forraCid) await stadaHalvKopia(db, tagen.forraCid);

  let plan, src, kontroller;
  try {
    const srcSnap = await db.doc(`competitions/${cid}`).get();
    if (!srcSnap.exists) throw new KodFel('Tävlingen som koden hör till finns inte längre.');
    src = { ...srcSnap.data(), id: cid };
    plan = planeraOvertag(src, { email, uid });

    // Utvärderingen: årets blir "förra årets", anteckningarna bärs vidare,
    // bilderna kopieras med samma id:n.
    const hoSnap = await db.doc(`competitions/${cid}/private/handover`).get();
    const ny = hoSnap.exists ? utvarderingForNastaAr(hoSnap.data(), src) : null;
    if (harInnehall(ny)) {
      await nyRef.collection('private').doc('handover').set(ny);
      for (const id of utvarderingBildIds(ny)) {
        const b = await db.doc(`competitions/${cid}/private/${BILD_PREFIX}${id}`).get();
        if (b.exists) await nyRef.collection('private').doc(BILD_PREFIX + id).set(b.data());
      }
    }

    // Kontrollerna: nya id:n (nya hemliga länkar), stängda, utan facit.
    kontroller = await db.collection(`competitions/${cid}/controls`).get();
    const idMap = {};
    for (let i = 0; i < kontroller.docs.length; i += 400) {
      const batch = db.batch();
      for (const c of kontroller.docs.slice(i, i + 400)) {
        const ref = nyRef.collection('controls').doc();
        idMap[c.id] = ref.id;
        batch.set(ref, kopiaKontroll(c.data()));
      }
      await batch.commit();
    }

    const spar = await db.doc(`competitions/${cid}/track/main`).get();
    if (spar.exists && spar.data().legs && Object.keys(spar.data().legs).length) {
      await nyRef.collection('track').doc('main').set({
        speedKmh: spar.data().speedKmh ?? 4,
        legs: remappaSpar(spar.data().legs, idMap),
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    await nyRef.collection('private').doc('access').set(plan.access);
    // TÄVLINGSDOKUMENTET SKRIVS SIST, och det är kvittot på att kopian är hel.
    // Förut skrevs det först: en funktion som dog mitt i lämnade då en halv
    // tävling — utan kontroller eller spår — synlig i inlösarens lista (uid:t
    // står i `admins`). Nu finns en tävling antingen hel eller inte alls, och
    // nästa försök kan avgöra vilket genom att fråga efter just det dokumentet.
    await nyRef.set({ ...plan.comp, createdAt: FieldValue.serverTimestamp() });
  } catch (e) {
    await kodRef.update({ anvand: FieldValue.delete() }).catch(() => {});
    await stadaHalvKopia(db, nyRef.id);
    throw e;
  }

  // Bokföringen. Härifrån FINNS tävlingen, så ett fel får varken släppa koden
  // (då gick den att lösa in en gång till) eller bli ett fel för inlösaren
  // (som har sin tävling). Går märkningen inte att skriva ligger reservationen
  // kvar med `pagarCid`, och nästa försök bokför den via grenen ovan.
  await kodRef.update({ anvand: { at: FieldValue.serverTimestamp(), nyCid: nyRef.id } }).catch(() => {});
  await bokforKallan(email, nyRef.id);

  return { cid: nyRef.id, name: plan.comp.name, fran: src.name || '', kontroller: kontroller.size };
}

module.exports = {
  KOD_ALFABET, KOD_LANGD, normKod, arGiltigKod, kodHash,
  KOPIERADE_FALT, kopiaTavlingsdata, kopiaKontroll, remappaSpar, nastaArsNamn, forNyArrangor,
  normUtvardering, utvarderingTom, utvarderingBildIds, utvarderingForNastaAr, harInnehall,
  planeraOvertag, losInKod, KodFel, KodUpptagen, RESERVATION_TTL_MS, INLOSNING_TIMEOUT_S
};
