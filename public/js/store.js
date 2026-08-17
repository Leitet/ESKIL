// Firestore data access layer. Keeps queries in one place.

import {
  auth,
  db, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs, onSnapshot, query, where, orderBy,
  serverTimestamp, deleteField, writeBatch, Timestamp
} from './firebase.js';
import { normDistrict } from './districts.js';
import { mergeBeacons, splitManagement, mergeManagement } from './utils.js';

// --- System config (super-admin) --------------------------------------------
// A single config/system doc holding operational settings that are useful to
// tune WITHOUT a deploy (e.g. the mail rate-limit caps the Cloud Functions
// read). Super-admin only (Firestore rules); functions read it via admin SDK.

export async function getSystemConfig() {
  const snap = await getDoc(doc(db, 'config', 'system'));
  return snap.exists() ? snap.data() : {};
}

export async function setSystemConfig(data) {
  await setDoc(doc(db, 'config', 'system'), data, { merge: true });
}

// --- Users -----------------------------------------------------------------

export async function ensureUser(uid, email) {
  const ref = doc(db, 'users', uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    // Bootstrap: the configured SUPER_ADMIN_EMAIL becomes super-admin on first
    // sign-in. MUST match the literal email in firestore.rules.
    const SUPER_ADMIN_EMAIL = 'johan@leitet.se';
    const isBootstrapSuper = email === SUPER_ADMIN_EMAIL;
    const role = isBootstrapSuper ? 'super-admin' : 'user';
    await setDoc(ref, {
      email,
      role,
      createdAt: serverTimestamp(),
      lastSeenAt: serverTimestamp()
    });
    return { email, role };
  }
  // Refresh lastSeenAt on every sign-in — super-admin user list depends on it.
  updateDoc(ref, { lastSeenAt: serverTimestamp() }).catch(() => {});
  return snap.data();
}

export async function getUser(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function listAllUsers() {
  const snap = await getDocs(collection(db, 'users'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function updateUserRole(uid, role) {
  await updateDoc(doc(db, 'users', uid), { role });
}

export async function deleteUser(uid) {
  await deleteDoc(doc(db, 'users', uid));
}

// --- Competitions ----------------------------------------------------------

// All competitions, unauthenticated — competition meta is public by design
// (the public pages /t/<cid> are open) and the landing page lists them.
export async function listAllCompetitions() {
  const snap = await getDocs(collection(db, 'competitions'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// PII permission fields moved off the world-readable competition doc into the
// member-only private/access subdoc (Fas 3). `admins` (opaque uids) stays on
// the competition doc — it isn't PII and the rules read it there.
// ekonomi/ekonomiEmails (ekonomiansvarig/kassör — may tick off registration
// payments) live ONLY in the access subdoc, never on the public doc.
const PII_ACCESS_FIELDS = ['adminEmails', 'userEmails', 'users', 'ekonomi', 'ekonomiEmails'];

async function readAccess(cid) {
  try {
    const snap = await getDoc(doc(db, 'competitions', cid, 'private', 'access'));
    return snap.exists() ? snap.data() : null;
  } catch { return null; } // not a member — denied read is expected
}

// Tävlingsledningens INTERNA kontaktuppgifter. Mastern; faltinfo-speglarna
// härleds ur den. Sväljer fel av samma skäl som readAccess: en nekad läsning
// betyder "inte medlem", inte "något gick sönder".
async function readLedning(cid) {
  try {
    const snap = await getDoc(doc(db, 'competitions', cid, 'private', 'ledning'));
    return snap.exists() ? (snap.data()?.internPii || null) : null;
  } catch { return null; }
}

// --- Tävlingsförfrågningar ---------------------------------------------------
// Vanliga användare skapar inte tävlingar själva (rules tillåter det bara för
// super-admin, plus årgångskopiering av en tävling man redan administrerar).
// I stället skickas en förfrågan som en super-admin godkänner eller nekar;
// godkännandet skapar tävlingen med sökanden som admin. Cloud Functions
// mailar super-admins vid ny förfrågan och sökanden vid beslut.

// Tre platser per konto: dokument-id:t är "<uid>-0|1|2" och reglerna nekar
// create på ett id som redan finns. Leta upp en ledig plats — är alla tagna
// får sökanden dölja en behandlad förfrågan först.
export const MAX_COMPETITION_REQUESTS = 3;

export async function createCompetitionRequest({ name, description, date, message, district }, user) {
  const mine = await listMyCompetitionRequests(user);
  const taken = new Set(mine.map(r => r.id));
  const slot = [...Array(MAX_COMPETITION_REQUESTS).keys()]
    .map(i => `${user.uid}-${i}`)
    .find(id => !taken.has(id));
  if (!slot) {
    const pending = mine.filter(r => r.status === 'vantar').length;
    throw new Error(pending >= MAX_COMPETITION_REQUESTS
      ? `Du har redan ${pending} förfrågningar som väntar på svar. Avvakta beskedet innan du skickar fler.`
      : 'Du har tre förfrågningar registrerade. Dölj en färdigbehandlad först, så frigörs en plats.');
  }
  const ref = doc(db, 'competitionRequests', slot);
  await setDoc(ref, {
    name: String(name || '').trim().slice(0, 120),
    description: String(description || '').trim().slice(0, 2000),
    date: date || null,
    message: String(message || '').trim().slice(0, 2000),
    district: normDistrict(district),
    requestedBy: user.uid,
    requestedByEmail: String(user.email || '').trim().toLowerCase(),
    status: 'vantar',
    createdAt: new Date().toISOString()
  });
  return ref.id;
}

// Sökandens egna förfrågningar. Frågan MÅSTE vara begränsad på requestedBy —
// regeln validerar per dokument och nekar en obegränsad list.
export async function listMyCompetitionRequests(user) {
  const snap = await getDocs(query(
    collection(db, 'competitionRequests'), where('requestedBy', '==', user.uid)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Alla förfrågningar (super-admin).
export async function listCompetitionRequests() {
  const snap = await getDocs(collection(db, 'competitionRequests'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function deleteCompetitionRequest(reqId) {
  await deleteDoc(doc(db, 'competitionRequests', reqId));
}

// Godkänn: skapa tävlingen med SÖKANDEN som admin (både uid och e-post, så
// rättigheten gäller direkt och överlever ett uid-byte), och stämpla
// förfrågan med beslutet — den uppdateringen är det Cloud Functionen
// reagerar på när svarsmailet ska gå iväg.
export async function approveCompetitionRequest(req, decisionMessage, decidedByEmail, { slug, shortName } = {}) {
  const cid = await createCompetition({
    name: req.name,
    shortName: (shortName || req.name).slice(0, 24),
    description: req.description || '',
    date: req.date || null,
    year: req.date ? Number(String(req.date).slice(0, 4)) || null : new Date().getFullYear(),
    district: req.district || 'annat',
    // Kortadressen slås fast HÄR — den går inte att ändra sedan (tryckta
    // QR-koder och betalningsreferenser hänger på den).
    ...(slug ? { slug } : {}),
    adminEmails: [req.requestedByEmail]
  }, { uid: req.requestedBy, email: req.requestedByEmail });
  await updateDoc(doc(db, 'competitionRequests', req.id), {
    status: 'godkand',
    competitionId: cid,
    decisionMessage: String(decisionMessage || '').trim(),
    decidedAt: new Date().toISOString(),
    decidedBy: decidedByEmail || ''
  });
  return cid;
}

export async function denyCompetitionRequest(reqId, decisionMessage, decidedByEmail) {
  await updateDoc(doc(db, 'competitionRequests', reqId), {
    status: 'nekad',
    decisionMessage: String(decisionMessage || '').trim(),
    decidedAt: new Date().toISOString(),
    decidedBy: decidedByEmail || ''
  });
}

// Alla tävlingar med sina access-dokument inlästa (adminEmails/userEmails/
// ekonomiEmails ligger i private/access sedan Fas 3c och är RADERADE från det
// publika dokumentet). Super-admin får läsa alla; för andra faller de
// otillgängliga tillbaka på tävlingsdokumentets legacy-fält.
export async function listCompetitionsWithAccess() {
  const snap = await getDocs(collection(db, 'competitions'));
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const accesses = await Promise.all(all.map(c => readAccess(c.id)));
  return all.map((c, i) => {
    const a = accesses[i] || {};
    return {
      ...c,
      adminEmails: a.adminEmails || c.adminEmails || [],
      userEmails: a.userEmails || c.userEmails || [],
      ekonomiEmails: a.ekonomiEmails || c.ekonomiEmails || [],
      admins: a.admins || c.admins || []
    };
  });
}

export async function listCompetitionsForUser(user) {
  const snap = await getDocs(collection(db, 'competitions'));
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (user.role === 'super-admin') return all;
  const email = String(user.email || '').trim().toLowerCase();
  // adminEmails/userEmails now live in the member-only access subdoc; read it
  // per competition (denied for ones we don't belong to → filtered out).
  // Union with the competition doc so un-migrated competitions still resolve.
  const accesses = await Promise.all(all.map(c => c.demo ? Promise.resolve(null) : readAccess(c.id)));
  return all.filter((c, i) => {
    if (c.demo === true) return true;
    const a = accesses[i] || {};
    return (c.admins || []).includes(user.uid)
      || (a.adminEmails || c.adminEmails || []).includes(email)
      || (a.userEmails || c.userEmails || []).includes(email);
  });
}

// Resolve a competition by its fixed slug (kortadress) — /t/ah26. Returns
// the same merged shape as getCompetition, or null. Publicly readable.
export async function getCompetitionBySlug(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return null;
  const snap = await getDocs(query(collection(db, 'competitions'), where('slug', '==', s)));
  if (snap.empty) return null;
  return getCompetition(snap.docs[0].id);
}

// A slug is free when no competition uses it AND no competition document has
// it as its id (an id-colliding slug would be unreachable — /t tries ids first).
export async function isSlugTaken(slug, excludeCid = null) {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return false;
  const bySlug = await getCompetitionBySlug(s);
  if (bySlug && bySlug.id !== excludeCid) return true;
  const asId = await getDoc(doc(db, 'competitions', s)).catch(() => null);
  return !!(asId && asId.exists() && asId.id !== excludeCid);
}

export async function getCompetition(cid) {
  const snap = await getDoc(doc(db, 'competitions', cid));
  if (!snap.exists()) return null;
  const comp = { id: snap.id, ...snap.data() };
  // Merge the member-only permission mirror so isCompAdminUser/isCompMemberUser
  // keep working after the PII fields leave the public doc. Only attempted when
  // signed in — anonymous pages (which can't read it and don't need it) skip
  // the extra request entirely.
  if (auth.currentUser) {
    const a = await readAccess(cid);
    if (a) for (const k of PII_ACCESS_FIELDS) if (a[k] !== undefined) comp[k] = a[k];
  }
  // De interna rollernas uppgifter vävs tillbaka in i comp.management, så att
  // varje inloggad yta (inställningar, översikt, utskrifter) ser samma array
  // som förut och inte behöver ändras.
  //
  // Demogrenen är INTE kosmetisk: DEMO_VIEWER i app.js är ett vanligt objekt,
  // inte auth.currentUser, så utan den tappar demots fältpaket och kontrollista
  // sina seedade interna roller — och demot är skyltfönstret.
  if (auth.currentUser || comp.demo === true) {
    const internPii = await readLedning(cid);
    if (internPii) comp.management = mergeManagement(comp, internPii);
  }
  return comp;
}

// Permission/PII fields that are being moved off the world-readable
// competition doc into a member-only private/access subdoc (Fas 3).
const ACCESS_FIELDS = ['adminEmails', 'userEmails', 'admins', 'users', 'ekonomi', 'ekonomiEmails'];

// Mirror permission fields into competitions/{cid}/private/access. During the
// migration these are DUAL-written (the competition doc keeps them too) and
// the rules read a union of both, so a bug on the new side can never lock
// anyone out. Fas 3c removes them from the competition doc.
async function mirrorAccess(cid, data) {
  const fields = {};
  for (const k of ACCESS_FIELDS) if (data[k] !== undefined) fields[k] = data[k];
  if (Object.keys(fields).length) {
    await setDoc(doc(db, 'competitions', cid, 'private', 'access'), fields, { merge: true });
  }
}

export async function createCompetition(data, user) {
  // Keep PII permission fields off the public doc — they go to private/access.
  const docData = { ...data };
  for (const k of PII_ACCESS_FIELDS) delete docData[k];
  // Tävlingsledningen delas på samma sätt: rollstrukturen och de PUBLIKA
  // rollernas uppgifter på det världsläsbara dokumentet, de INTERNA rollernas
  // i private/ledning. Att det sker HÄR och inte i en egen
  // setCompetitionManagement är avsiktligt — då blir home.js, copyCompetition
  // (som går via den här) och backupimporten korrekta utan att ändras, och
  // årgångskopian kan inte skriva tillbaka intern PII på den publika ytan.
  const delad = data.management !== undefined ? splitManagement(data.management) : null;
  if (delad) docData.management = delad.publikt;
  const ref = await addDoc(collection(db, 'competitions'), {
    ...docData,
    admins: [user.uid],
    createdBy: user.uid,
    createdAt: serverTimestamp()
  });
  if (delad) await skrivLedning(ref.id, delad.internPii);
  await mirrorAccess(ref.id, {
    admins: [user.uid], users: [],
    adminEmails: data.adminEmails || [], userEmails: data.userEmails || [],
    ekonomi: data.ekonomi || [], ekonomiEmails: data.ekonomiEmails || []
  });
  return ref.id;
}

export async function updateCompetition(cid, data) {
  // PII permission fields go ONLY to the member-only access subdoc; clear them
  // from the public competition doc (Fas 3c). `admins` (uids) stays.
  const docData = {};
  for (const [k, v] of Object.entries(data)) {
    docData[k] = PII_ACCESS_FIELDS.includes(k) ? deleteField() : v;
  }
  const delad = data.management !== undefined ? splitManagement(data.management) : null;
  if (delad) docData.management = delad.publikt;
  await updateDoc(doc(db, 'competitions', cid), docData);
  if (delad) {
    await skrivLedning(cid, delad.internPii);
    // Speglarna är HÄRLEDDA och måste skrivas om när mastern ändras. Fel här
    // kostar ett inaktuellt nummer på en kontroll, inte förlorad data — men
    // det får inte gå tyst.
    await syncFaltinfo(cid, delad.internPii);
  }
  await mirrorAccess(cid, data);
}

/** Skriver mastern. Tom uppsättning raderar dokumentet hellre än att lämna ett
 *  tomt objekt kvar — gallringen ska kunna se skillnad. */
async function skrivLedning(cid, internPii) {
  const ref = doc(db, 'competitions', cid, 'private', 'ledning');
  if (!internPii || !Object.keys(internPii).length) {
    await deleteDoc(ref).catch(() => {});
    return;
  }
  await setDoc(ref, { internPii }, { merge: false });
}

/**
 * Skriver om VARJE faltinfo-spegel ur mastern.
 *
 * Enumererar kollektionen DIREKT, aldrig via kontrollistan:
 * flyttaTillPapperskorg raderar kontrolldokumentet, och en spegel som bara nås
 * via sin kontroll blir då föräldralös OCH världsläsbar. `list` är member-only,
 * så admin får den.
 *
 * Batchen delas vid 400 — Firestore tar 500 operationer, och en halvfärdig
 * omskrivning skulle lämna några kontroller med det gamla numret.
 */
export async function syncFaltinfo(cid, internPii) {
  const pii = internPii || await readLedning(cid) || {};
  const snap = await getDocs(collection(db, 'competitions', cid, 'faltinfo'));
  const dokument = snap.docs;
  for (let i = 0; i < dokument.length; i += 400) {
    const batch = writeBatch(db);
    for (const d of dokument.slice(i, i + 400)) {
      batch.set(d.ref, { internPii: pii, uppdaterad: new Date().toISOString() }, { merge: false });
    }
    await batch.commit();
  }
  return dokument.length;
}

// Mirror the competition doc's permission fields into private/access, then
// REMOVE the PII copies (adminEmails/userEmails/users) from the public doc
// (Fas 3c). `admins` (uids) stays. Admin-triggered on open.
//
// MUST be a no-op once the doc is migrated: it runs on every overview visit,
// and the old version mirrored `c.userEmails || []` — after the first run the
// doc fields are deleted, so every later visit overwrote the access doc with
// EMPTY lists and silently wiped all invited admins and users (data loss).
export async function migrateCompetitionAccess(cid) {
  const snap = await getDoc(doc(db, 'competitions', cid));
  if (!snap.exists()) return;
  const c = snap.data();
  // Nothing left to migrate → never touch the access doc.
  if (!PII_ACCESS_FIELDS.some(k => c[k] !== undefined)) return;
  // Mirror ONLY fields that actually exist on the doc — a missing field must
  // never become an empty list that overwrites real data in the access doc.
  const fields = {};
  for (const k of ACCESS_FIELDS) if (c[k] !== undefined) fields[k] = c[k];
  await mirrorAccess(cid, fields);
  const clear = {};
  for (const k of PII_ACCESS_FIELDS) if (c[k] !== undefined) clear[k] = deleteField();
  if (Object.keys(clear).length) await updateDoc(snap.ref, clear);
}

// Copy a competition to a new year: controls (instructions, positions,
// utslagsfråga — but no facit, phone numbers or ansvariga), settings,
// pricing, management and the drawn track. NOT copied: patrols, scores,
// registrations, stations, utskick, users. Registration is carried over but
// disabled with the period cleared so nothing opens by accident. The creator
// becomes the sole admin of the copy.
export async function copyCompetition(cid, { name, shortName, year, date }, user) {
  const src = await getCompetition(cid);
  if (!src) throw new Error('Tävlingen hittades inte.');

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
    // Distriktet måste följa med — annars saknar kopian fältet och faller ur
    // distriktsgrupperingen på /app (normDistrict tvingar okänt/tomt → 'annat').
    district: normDistrict(src.district),
    // Årgångskedjan: publika sidan länkar till föregående års tävling.
    copiedFrom: cid
  };
  if (Array.isArray(src.avdelningar) && src.avdelningar.length) data.avdelningar = src.avdelningar;
  // 'places' bärs med precis som startFinish och spåret: en plats med
  // inCourse blir en nod i banan (kostar sin dwell i ETA:n), så att tappa
  // dem skulle tyst ändra nästa års bana och alla kartnålar.
  for (const k of ['startTimes', 'startFinish', 'parking', 'places', 'management',
                   'publicScores', 'publicControls', 'autoReleaseControls',
                   'anonymousControls', 'autoCloseControls',
                   'selfStart', 'selfFinish', 'autoFinish', 'fieldMessaging']) {
    if (src[k] !== undefined) data[k] = src[k];
  }
  if (src.registration) {
    data.registration = { ...src.registration, enabled: false, opensAt: null, closesAt: null };
  }

  const newCid = await createCompetition(data, user);

  // Överlämningsdokumentet följer med — det är skrivet för nästa års ledning.
  try {
    const ho = await getHandover(cid);
    if (ho?.text) await setDoc(doc(db, 'competitions', newCid, 'private', 'handover'), ho);
  } catch { /* saknas eller ej läsbart — hoppa över */ }

  // Controls — new ids (fresh secret reporter URLs), everything closed,
  // person-bound fields cleared, tiebreaker facit reset.
  const controls = await listControls(cid);
  const idMap = {};
  for (let i = 0; i < controls.length; i += 400) {
    const batch = writeBatch(db);
    controls.slice(i, i + 400).forEach(c => {
      const ref = doc(collection(db, 'competitions', newCid, 'controls'));
      idMap[c.id] = ref.id;
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
      // telefon/notering live in the private meta subdoc and are intentionally
      // NOT copied to next year's competition.
      if (Number.isFinite(c.lat)) { copy.lat = c.lat; copy.lng = c.lng; }
      if (Array.isArray(c.instructions)) copy.instructions = c.instructions;
      else if (c.information) copy.information = c.information;
      if (c.utslag) {
        copy.utslag = true;
        copy.utslagFraga = c.utslagFraga || '';
        copy.utslagSvar = null;
      }
      batch.set(ref, copy);
    });
    await batch.commit();
  }

  // The drawn track — leg keys reference control ids, remap them.
  const track = await getTrack(cid).catch(() => null);
  if (track && track.legs && Object.keys(track.legs).length) {
    const legs = {};
    for (const [key, wps] of Object.entries(track.legs)) {
      let newKey = key;
      for (const [oldId, newId] of Object.entries(idMap)) newKey = newKey.replaceAll(oldId, newId);
      legs[newKey] = wps;
    }
    await saveTrack(newCid, { speedKmh: track.speedKmh ?? 4, legs });
  }

  return newCid;
}

// Batched deletes — Firestore caps a batch at 500 ops.
async function deleteRefs(refs) {
  for (let i = 0; i < refs.length; i += 450) {
    const batch = writeBatch(db);
    refs.slice(i, i + 450).forEach(r => batch.delete(r));
    await batch.commit();
  }
}

// Persist the user list: `users` holds {email, name} for display, and the
// flat `userEmails` mirror is what the security rules check membership
// against. Always write both through this helper so they can't drift.
export async function setCompetitionUsers(cid, entries) {
  const clean = entries
    .map(e => ({ email: String(e.email || '').trim().toLowerCase(), name: (e.name || '').trim() }))
    .filter(e => e.email);
  // Fas 3c: users/userEmails live only in the member-only access subdoc —
  // clear any legacy copies from the public doc.
  await updateDoc(doc(db, 'competitions', cid), {
    users: deleteField(),
    userEmails: deleteField()
  });
  await mirrorAccess(cid, { users: clean, userEmails: clean.map(e => e.email) });
}

// Persist the ekonomiansvarig list (derived from management roles flagged
// `ekonomi`): `ekonomi` holds {email, name} for display, flat `ekonomiEmails`
// is what the rules check payment-write access against. Access subdoc only.
export async function setCompetitionEkonomi(cid, entries) {
  const clean = entries
    .map(e => ({ email: String(e.email || '').trim().toLowerCase(), name: (e.name || '').trim() }))
    .filter(e => e.email);
  await mirrorAccess(cid, { ekonomi: clean, ekonomiEmails: clean.map(e => e.email) });
}

// Close (avsluta) a competition: wipe users and kontrollansvariga (including
// their names) plus each control's on-site phone number — only admins remain.
// Also closes every control for reporting and marks the competition
// read-only. Reversible via reopenCompetition, but the removed people/numbers
// are gone for good.
export async function closeCompetition(cid) {
  const controls = await listControls(cid);
  for (let i = 0; i < controls.length; i += 400) {
    const batch = writeBatch(db);
    controls.slice(i, i + 400).forEach(c => {
      batch.update(doc(db, 'competitions', cid, 'controls', c.id), {
        open: false, ansvariga: deleteField(), ansvarigaEmails: deleteField()
      });
      // telefon/ansvariga now live in the private meta subdoc — wipe them there.
      batch.set(doc(db, 'competitions', cid, 'controls', c.id, 'private', 'meta'),
        { telefon: '', ansvariga: [], ansvarigaEmails: [] }, { merge: true });
    });
    await batch.commit();
  }
  // Papperskorgen bär hela raderade patruller och kontroller: namn, kår,
  // noteringar, telefonnummer. Ångra-fönstret sträcker sig fram till avslut —
  // sedan är den bara personuppgifter. Töms helt.
  const korgSnap = await getDocs(collection(db, 'competitions', cid, 'papperskorg'));
  await deleteRefs(korgSnap.docs.map(d => d.ref));

  // Ledningens interna kontaktuppgifter: mastern OCH varje härledd spegel.
  // RADERAS, inte nollas — precis som trådar, logg och kompletteringar. Missas
  // speglarna ligger interna telefonnummer kvar VÄRLDSLÄSBARA efter
  // GDPR-gallringen, alltså värre än före flytten. Speglarna enumereras direkt
  // ur kollektionen: en kontroll som flyttats till papperskorgen har inget
  // kontrolldokument kvar att hitta sin spegel via.
  const faltinfoSnap = await getDocs(collection(db, 'competitions', cid, 'faltinfo'));
  await deleteRefs(faltinfoSnap.docs.map(d => d.ref));
  await deleteDoc(doc(db, 'competitions', cid, 'private', 'ledning')).catch(() => {});

  // Kompletteringarna bär ALLERGIER — hälsouppgifter — och kontaktpersoner.
  // De fyller sitt syfte fram till tävlingsdagen; efter avslut är de bara
  // personuppgifter. Raderas helt, som fälttrådarna.
  const komplSnap = await getDocs(collection(db, 'competitions', cid, 'kompletteringar'));
  await deleteRefs(komplSnap.docs.map(d => d.ref));

  // Sekretariatets logg namnger enskilda patruller och bär funktionärernas
  // e-postadresser. Den fyller sitt syfte under och strax efter dagen; när
  // tävlingen avslutas är den bara personuppgifter kvar. Raderas helt, precis
  // som fälttrådarna.
  const loggSnap = await getDocs(collection(db, 'competitions', cid, 'logg'));
  await deleteRefs(loggSnap.docs.map(d => d.ref));

  // Utgått-noteringar kan innehålla känsligt (skäl, skador) — gallra noten
  // vid avslut men behåll själva utgått-statusen som tävlingshistorik.
  // Noten ligger numera i private/meta; den publika grenen finns kvar för
  // tävlingar som skrevs innan den flyttades dit.
  const patrolsSnap = await getDocs(collection(db, 'competitions', cid, 'patrols'));
  for (let i = 0; i < patrolsSnap.docs.length; i += 400) {
    const batch = writeBatch(db);
    patrolsSnap.docs.slice(i, i + 400).forEach(d => {
      const u = d.data().utgatt;
      if (!u) return;
      if (u.note) batch.update(d.ref, { utgatt: { at: u.at } });
      batch.set(doc(db, 'competitions', cid, 'patrols', d.id, 'private', 'meta'),
        { utgattNote: '' }, { merge: true });
    });
    await batch.commit();
  }
  // GDPR-gallring av anmälningarna: kontaktuppgifter, fritextsvar (t.ex.
  // allergier) och förhinder-meddelanden raderas — kår, patrullnamn och
  // betalningsstatus (belopp/referenser, ingen persondata) behålls som
  // tävlingshistorik/bokföringsunderlag.
  const regsSnap = await getDocs(collection(db, 'competitions', cid, 'registrations'));
  for (let i = 0; i < regsSnap.docs.length; i += 400) {
    const batch = writeBatch(db);
    regsSnap.docs.slice(i, i + 400).forEach(d => {
      const r = d.data();
      batch.update(d.ref, {
        contact: { name: '', email: '', phone: '' },
        answers: {},
        patrols: (r.patrols || []).map(p => ({ ...p, answers: {} })),
        forhinder: []
      });
    });
    await batch.commit();
  }
  // Samtalen med fältet raderas HELT, inte gallras: en bild tagen i skogen
  // kan visa scouters ansikten, och texten kan bära vad som helst från en
  // stressad kväll. Det finns inget här som är tävlingshistorik.
  await deleteThreads(cid);

  // Strip the tävlingsledning's personal contact details (name/phone/email)
  // from `management` too — the role structure stays, the PII goes. Only
  // admins remain reachable (via adminEmails).
  const comp = await getCompetition(cid).catch(() => null);
  const strippedManagement = Array.isArray(comp?.management)
    ? comp.management.map(r => ({ id: r.id, label: r.label || '', visibility: r.visibility || 'public', ekonomi: r.ekonomi === true, name: '', phone: '', email: '' }))
    : undefined;

  await updateDoc(doc(db, 'competitions', cid), {
    closed: true, users: deleteField(), userEmails: deleteField(),
    ...(strippedManagement ? { management: strippedManagement } : {})
  });
  await mirrorAccess(cid, { users: [], userEmails: [], ekonomi: [], ekonomiEmails: [] });
}

// Trådar + deras meddelanden. Firestore raderar aldrig subcollections med
// föräldern, så meddelandena måste bort först — annars ligger bilderna kvar
// som föräldralösa dokument.
export async function deleteThreads(cid) {
  const trådar = await getDocs(collection(db, 'competitions', cid, 'threads'));
  for (const t of trådar.docs) {
    const msgs = await getDocs(collection(db, 'competitions', cid, 'threads', t.id, 'messages'));
    await deleteRefs(msgs.docs.map(d => d.ref));
  }
  await deleteRefs(trådar.docs.map(d => d.ref));
}

export async function reopenCompetition(cid) {
  await updateDoc(doc(db, 'competitions', cid), { closed: false });
}

export async function deleteCompetition(cid) {
  // Firestore never deletes subcollections with their parent, so remove
  // everything that lives under the competition first — otherwise patrols,
  // controls, scores and registrations linger as orphaned documents.
  await deleteThreads(cid);
  const controlsSnap = await getDocs(collection(db, 'competitions', cid, 'controls'));
  for (const c of controlsSnap.docs) {
    const scores = await getDocs(collection(db, 'competitions', cid, 'controls', c.id, 'scores'));
    await deleteRefs(scores.docs.map(d => d.ref));
    // Livstecknen: en doc per telefon som stått på kontrollen.
    const beacons = await getDocs(collection(db, 'competitions', cid, 'controls', c.id, 'beacon'));
    await deleteRefs(beacons.docs.map(d => d.ref));
    // private/meta (telefon, notering) lives in a subcollection too.
    await deleteDoc(doc(db, 'competitions', cid, 'controls', c.id, 'private', 'meta')).catch(() => {});
  }
  await deleteRefs(controlsSnap.docs.map(d => d.ref));
  const patrolsSnap = await getDocs(collection(db, 'competitions', cid, 'patrols'));
  for (const p of patrolsSnap.docs) {
    await deleteDoc(doc(db, 'competitions', cid, 'patrols', p.id, 'private', 'meta')).catch(() => {});
  }
  await deleteRefs(patrolsSnap.docs.map(d => d.ref));
  // Meddelanden bär en acks-subkollektion var — töm dem först.
  const msgsSnap = await getDocs(collection(db, 'competitions', cid, 'messages'));
  for (const m of msgsSnap.docs) {
    const acks = await getDocs(collection(db, 'competitions', cid, 'messages', m.id, 'acks'));
    await deleteRefs(acks.docs.map(d => d.ref));
  }
  await deleteRefs(msgsSnap.docs.map(d => d.ref));
  // Stationerna bär avprickningarna som subkollektion.
  const stationsSnap = await getDocs(collection(db, 'competitions', cid, 'stations'));
  for (const st of stationsSnap.docs) {
    const pass = await getDocs(collection(db, 'competitions', cid, 'stations', st.id, 'passages'));
    await deleteRefs(pass.docs.map(d => d.ref));
  }
  await deleteRefs(stationsSnap.docs.map(d => d.ref));
  // Platta kollektioner. `selfPassages`, `track` och `utskick` saknades och
  // låg kvar som föräldralösa dokument efter en "raderad" tävling.
  for (const sub of ['registrations', 'invites', 'selfPassages', 'track', 'utskick', 'logg', 'faltinfo', 'kompletteringar', 'papperskorg']) {
    const snap = await getDocs(collection(db, 'competitions', cid, sub));
    await deleteRefs(snap.docs.map(d => d.ref));
  }
  // Tävlingens EGNA private-dokument sist: `access` bär adminEmails,
  // userEmails och ekonomiEmails. De låg kvar efter raderingen — personuppgift
  // kvar i databasen efter att någon tryckt "radera tävlingen" är precis det
  // raderingen ska göra slut på.
  const privSnap = await getDocs(collection(db, 'competitions', cid, 'private'));
  await deleteRefs(privSnap.docs.map(d => d.ref));
  await deleteDoc(doc(db, 'competitions', cid));
}

// --- Sekretariatets logg ------------------------------------------------------
// Vem stängde kontrollen, vem tog bort patrullen, vem ändrade maxtiden. Det
// saknade spår helt, och dagen efter minns ingen.
//
// Loggen skrivs från ADMIN-VYERNA, aldrig härifrån inuti mutationerna. Det är
// frestande att lägga anropet i t.ex. deleteScore så det aldrig glöms — men
// deleteScore anropas ANONYMT från rapportsidan, och en anonym klient kan inte
// skriva till en member-only logg. Skrivningen hade då kastat och tagit
// borttagningen med sig.
//
// Fel sväljs medvetet: en logg som inte kunde skrivas får aldrig hindra det
// den skulle beskriva.
export async function loggHandelse(cid, { vad, text, av }) {
  try {
    await addDoc(collection(db, 'competitions', cid, 'logg'), {
      at: Timestamp.fromDate(new Date()),
      av: String(av || 'okänd').slice(0, 120),
      vad: String(vad || '').slice(0, 60),
      text: String(text || '').slice(0, 500)
    });
  } catch (e) {
    console.warn('[ESKIL] kunde inte logga:', e?.message || e);
  }
}

export function watchLogg(cid, cb) {
  return onSnapshot(collection(db, 'competitions', cid, 'logg'),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.at?.toMillis?.() ?? 0) - (a.at?.toMillis?.() ?? 0))),
    () => cb([]));
}

// --- Patrols ---------------------------------------------------------------

export function watchPatrols(cid, cb) {
  const q = collection(db, 'competitions', cid, 'patrols');
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export async function listPatrols(cid) {
  const snap = await getDocs(collection(db, 'competitions', cid, 'patrols'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getPatrol(cid, pid) {
  const snap = await getDoc(doc(db, 'competitions', cid, 'patrols', pid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function createPatrol(cid, data) {
  // notering is an internal admin note — keep it off the world-readable doc.
  const { notering, ...rest } = data;
  const ref = await addDoc(collection(db, 'competitions', cid, 'patrols'), {
    ...rest,
    createdAt: serverTimestamp()
  });
  if (notering) await setPatrolMeta(cid, ref.id, { notering });
  return ref.id;
}

export async function updatePatrol(cid, pid, data) {
  const { notering, ...rest } = data;
  if (Object.keys(rest).length) {
    await updateDoc(doc(db, 'competitions', cid, 'patrols', pid), rest);
  }
  if (notering !== undefined) await setPatrolMeta(cid, pid, { notering });
}

// --- Komplettering per patrull -------------------------------------------------
// Kårledaren har anmälningslänken och kan ändra ALLT i anmälan — den kan hen
// inte skicka vidare till varje patrulledare. Kompletteringen ger därför varje
// patrull en EGEN hemlighet: doc-id:t är en slumpad token, och länken
// /a/<cid>/k/<token> öppnar exakt den patrullens rad.
function slumpToken() {
  const b = new Uint8Array(16);
  (globalThis.crypto || {}).getRandomValues?.(b);
  return [...b].map(x => x.toString(36).padStart(2, '0')).join('').slice(0, 24);
}

// Returnerar de skapade {token, patrol}. ANROPAREN skriver dem på anmälan —
// kopplingen token→anmälan får inte ligga i kompletteringsdokumentet, som är
// öppet läsbart för den som har token.
export async function skapaKompletteringar(cid, patrullnamn = []) {
  const skapade = [];
  for (const namn of patrullnamn) {
    const token = slumpToken();
    await setDoc(doc(db, 'competitions', cid, 'kompletteringar', token), {
      patrol: namn, antal: 0, allergier: '', kontakt: '', ovrigt: ''
    });
    skapade.push({ token, patrol: namn });
  }
  return skapade;
}

export async function getKomplettering(cid, token) {
  const snap = await getDoc(doc(db, 'competitions', cid, 'kompletteringar', token));
  return snap.exists() ? { token, ...snap.data() } : null;
}

// Skickar BARA de fält patrulledaren får röra. regId och patrol utelämnas
// medvetet — reglerna nekar dem, och att skicka med dem hade gjort varje
// sparning till ett avslag.
export async function sparaKomplettering(cid, token, { antal, allergier, kontakt, ovrigt }) {
  await updateDoc(doc(db, 'competitions', cid, 'kompletteringar', token), {
    antal: Math.max(0, Math.min(20, Number(antal) || 0)),
    allergier: String(allergier || '').slice(0, 500),
    kontakt: String(kontakt || '').slice(0, 200),
    ovrigt: String(ovrigt || '').slice(0, 500),
    ifylltAt: new Date().toISOString()
  });
}

// Hämtar kompletteringarna för EN anmälan via dess egen tokenlista. Ingen
// list-operation: den är member-only, och kårledaren är anonym — ett getDocs
// här kastade permission-denied och tog hela funktionen med sig, tyst.
export async function kompletteringarForAnmalan(cid, reg) {
  const rader = (reg?.kompletteringar || []);
  const ut = [];
  for (const r of rader) {
    const k = await getKomplettering(cid, r.token).catch(() => null);
    if (k) ut.push(k);
    else ut.push({ token: r.token, patrol: r.patrol, saknas: true });
  }
  return ut;
}

// --- Genrep --------------------------------------------------------------------
// En förstagångsarrangör kan inte bevisa att kedjan rapport → sekretariat →
// poängtabell faktiskt fungerar på SIN bana, med SINA kontroller, förrän
// tävlingsdagen. /s/<cid>/test visar bara hur ett startkort SER UT — patrullen
// finns inte i databasen och går därför inte att rapportera på.
//
// Genrepspatrullen är därför en RIKTIG patrull. Det är hela poängen: den går
// genom exakt samma kod, samma regler och samma vyer som en skarp patrull, så
// ett genrep som fungerar bevisar något. Priset är att den måste gå att städa
// bort spårlöst — se rensaGenrep.
export const GENREP_NAMN = 'GENREP — testpatrull';

export async function skapaGenrepPatrull(cid) {
  const befintlig = (await listPatrols(cid)).find(p => p.genrep);
  if (befintlig) return befintlig.id;
  return createPatrol(cid, {
    name: GENREP_NAMN,
    number: 0,
    kar: 'Genrep',
    avdelning: 'Spårare',
    antal: 1,
    startOrder: 0,
    genrep: true
  });
}

// Städar bort ALLT genrepet skapade: patrullen, dess poäng på varje kontroll,
// dess avprickningar på varje station och dess egna start-/målstämplar. En
// kvarglömd genrepspatrull i poängtabellen på tävlingsdagen är precis det den
// här knappen finns för att förhindra.
export async function rensaGenrep(cid) {
  const patruller = (await listPatrols(cid)).filter(p => p.genrep);
  if (!patruller.length) return { patruller: 0, poang: 0 };
  let poang = 0;
  const controls = await listControls(cid);
  for (const c of controls) {
    for (const p of patruller) {
      try {
        await deleteDoc(doc(db, 'competitions', cid, 'controls', c.id, 'scores', p.id));
        poang++;
      } catch { /* fanns ingen rapport på den kontrollen */ }
    }
  }
  const stationer = await listStations(cid).catch(() => []);
  for (const st of stationer) {
    for (const p of patruller) {
      await deleteDoc(doc(db, 'competitions', cid, 'stations', st.id, 'passages', p.id)).catch(() => {});
    }
  }
  for (const p of patruller) {
    await deleteDoc(doc(db, 'competitions', cid, 'selfPassages', p.id)).catch(() => {});
    await deleteDoc(doc(db, 'competitions', cid, 'patrols', p.id, 'private', 'meta')).catch(() => {});
    await deleteDoc(doc(db, 'competitions', cid, 'patrols', p.id));
  }
  return { patruller: patruller.length, poang };
}

export async function deletePatrol(cid, pid) {
  await deleteDoc(doc(db, 'competitions', cid, 'patrols', pid));
}

// --- Meddelanden (broadcast v2) ----------------------------------------------
// Parallella driftmeddelanden i competitions/{cid}/messages — publikt läsbara
// (fältsidorna är anonyma), admin-skrivna. Meddelanden med requireAck samlar
// kvittenser i messages/{id}/acks (doc-id = "<kind>-<refId>", anonymt
// skrivbara med validerad form; läsbara endast för medlemmar eftersom
// stations-id är hemligt).

export function watchBroadcastMessages(cid, cb) {
  return onSnapshot(collection(db, 'competitions', cid, 'messages'),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

export async function createBroadcastMessage(cid, { text, level, target, requireAck }) {
  const ref = doc(collection(db, 'competitions', cid, 'messages'));
  await setDoc(ref, {
    text: String(text || '').trim().slice(0, 500),
    level: ['info', 'varning', 'kritisk'].includes(level) ? level : 'info',
    target: target || { kontroller: true, patruller: true },
    requireAck: !!requireAck,
    active: true,
    at: new Date().toISOString()
  });
  return ref.id;
}

export async function setBroadcastMessageActive(cid, msgId, active) {
  await updateDoc(doc(db, 'competitions', cid, 'messages', msgId), { active: !!active });
}

export async function deleteBroadcastMessage(cid, msgId) {
  // Kvittenserna först — subkollektioner följer aldrig med föräldern.
  const acks = await getDocs(collection(db, 'competitions', cid, 'messages', msgId, 'acks'));
  for (const d of acks.docs) await deleteDoc(d.ref);
  await deleteDoc(doc(db, 'competitions', cid, 'messages', msgId));
}

export function watchMessageAcks(cid, msgId, cb) {
  return onSnapshot(collection(db, 'competitions', cid, 'messages', msgId, 'acks'),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

// Klientkvittens (anonym): phase 'seen' stämplar mottaget, 'ack' bekräftat.
// Klienttid — kvittensen ska bära ögonblicket, inte synkögonblicket.
export async function ackBroadcastMessage(cid, msgId, kind, refId, phase) {
  const ref = doc(db, 'competitions', cid, 'messages', msgId, 'acks', `${kind}-${refId}`);
  const stamp = Timestamp.fromDate(new Date());
  await setDoc(ref, {
    kind, refId,
    ...(phase === 'ack' ? { ackAt: stamp } : { seenAt: stamp })
  }, { merge: true });
}

// Överlämningsdokument — ledningens fria anteckningar om hur tävlingen körs
// ("så gör vi, fällor, kontakter"). Ligger i private/handover: läsbart för
// medlemmar, skrivbart för admins (täcks av private/{doc}-regeln). Följer
// med vid årgångskopiering.
export async function getHandover(cid) {
  const snap = await getDoc(doc(db, 'competitions', cid, 'private', 'handover'));
  return snap.exists() ? snap.data() : null;
}
export async function setHandover(cid, text, user) {
  await setDoc(doc(db, 'competitions', cid, 'private', 'handover'), {
    text: String(text || ''),
    updatedAt: new Date().toISOString(),
    updatedBy: user?.email || ''
  });
}

// DNF: markera en patrull som utgått (eller ångra med null). Patrulldokumentet
// är publikt läsbart, så noten hålls kort och saklig — den gallras vid avslut.
// Noten hamnar i private/meta, ALDRIG på patrulldokumentet. patrols har
// `allow read: if true` — det måste den, fältsidorna är anonyma — och
// dialogen i Läget lovar ordagrant att anteckningen "syns bara för ledningen".
// Den som i god tro skrev "Elsa svimmade, hämtad med ambulans" publicerade
// alltså en hälsouppgift om ett barn för hela internet. Kvar publikt ligger
// bara tidsstämpeln, som Läget och köerna behöver för att veta ATT patrullen
// utgått.
export async function setPatrolUtgatt(cid, pid, utgatt) {
  await updateDoc(doc(db, 'competitions', cid, 'patrols', pid),
    utgatt ? { utgatt: { at: Timestamp.fromDate(new Date()) } } : { utgatt: deleteField() });
  await setPatrolMeta(cid, pid, { utgattNote: utgatt ? (utgatt.note || '') : '' })
    .catch(() => { /* noten är en bonus — statusen får aldrig hänga på den */ });
}

// Write `startOrder: idx` on each patrol in one batched commit.
export async function updatePatrolOrders(cid, orderedIds) {
  const batch = writeBatch(db);
  orderedIds.forEach((id, idx) => {
    batch.update(doc(db, 'competitions', cid, 'patrols', id), { startOrder: idx });
  });
  await batch.commit();
}

// Renumber controls 1..N based on the given ordered ID list (one batched
// commit). The QR URL is tied to the document ID so renumbering is safe —
// only the visible label changes, PDFs may need regeneration.
export async function updateControlNumbers(cid, orderedIds) {
  const batch = writeBatch(db);
  orderedIds.forEach((id, idx) => {
    batch.update(doc(db, 'competitions', cid, 'controls', id), { nummer: idx + 1 });
  });
  await batch.commit();
}

// --- Controls --------------------------------------------------------------

export function watchControls(cid, cb) {
  return onSnapshot(collection(db, 'competitions', cid, 'controls'), snap => {
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export async function listControls(cid) {
  const snap = await getDocs(collection(db, 'competitions', cid, 'controls'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getControl(cid, ctrlId) {
  const snap = await getDoc(doc(db, 'competitions', cid, 'controls', ctrlId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function createControl(cid, data) {
  // telefon/notering AND ansvariga/ansvarigaEmails are personal/internal —
  // they live in a member-only private subdoc, not the world-readable doc.
  const { telefon, notering, ansvariga, ansvarigaEmails, ...rest } = data;
  const ref = await addDoc(collection(db, 'competitions', cid, 'controls'), {
    ...rest,
    open: rest.open ?? false,
    createdAt: serverTimestamp()
  });
  await writeControlMeta(cid, ref.id, { telefon, notering, ansvariga, ansvarigaEmails });
  return ref.id;
}

export async function updateControl(cid, ctrlId, data) {
  const { telefon, notering, ansvariga, ansvarigaEmails, ...rest } = data;
  const docWrite = { ...rest };
  // Clear ansvariga from the public doc if this write touched them (Fas 3c —
  // they live in the meta subdoc now).
  if (ansvariga !== undefined) docWrite.ansvariga = deleteField();
  if (ansvarigaEmails !== undefined) docWrite.ansvarigaEmails = deleteField();
  if (Object.keys(docWrite).length) {
    await updateDoc(doc(db, 'competitions', cid, 'controls', ctrlId), docWrite);
  }
  await writeControlMeta(cid, ctrlId, { telefon, notering, ansvariga, ansvarigaEmails });
}

// Route the member-only control fields into the private/meta subdoc.
async function writeControlMeta(cid, ctrlId, { telefon, notering, ansvariga, ansvarigaEmails }) {
  const meta = {};
  if (telefon !== undefined) meta.telefon = telefon;
  if (notering !== undefined) meta.notering = notering;
  if (ansvariga !== undefined) meta.ansvariga = ansvariga;
  if (ansvarigaEmails !== undefined) meta.ansvarigaEmails = ansvarigaEmails;
  if (Object.keys(meta).length) await setControlMeta(cid, ctrlId, meta);
}

// --- Control/patrol private meta (telefon, notering) ------------------------
// Kept out of the world-readable control/patrol docs. Read is member-only
// (control meta also readable by that control's kontrollansvarig); write is
// admin (control meta also writable by the kontrollansvarig). The store hides
// the split — views pass telefon/notering as normal fields and use
// attachControlMeta/attachPatrolMeta to merge them back for display.

export async function setControlMeta(cid, ctrlId, meta) {
  await setDoc(doc(db, 'competitions', cid, 'controls', ctrlId, 'private', 'meta'), meta, { merge: true });
}

export async function getControlMeta(cid, ctrlId) {
  const snap = await getDoc(doc(db, 'competitions', cid, 'controls', ctrlId, 'private', 'meta'));
  return snap.exists() ? snap.data() : {};
}

// Fetch every control's meta in parallel and merge telefon/notering onto the
// control objects (for admin/ansvarig list + detail views only — never the
// anonymous pages, which can't read the private docs and don't need them).
export async function attachControlMeta(cid, controls) {
  const metas = await Promise.all(controls.map(c => getControlMeta(cid, c.id).catch(() => ({}))));
  controls.forEach((c, i) => {
    const m = metas[i] || {};
    c.telefon = m.telefon || '';
    c.notering = m.notering || '';
    // Samtalstoken hör till fältlänken, inte till samtalet — den behövs där
    // länkar och QR-koder byggs.
    c.threadToken = m.threadToken || '';
    // ansvariga/ansvarigaEmails moved to the meta subdoc (Fas 3c) — surface
    // them for the admin/ansvarig editor. Fall back to the doc during migration.
    if (m.ansvariga !== undefined) c.ansvariga = m.ansvariga;
    if (m.ansvarigaEmails !== undefined) c.ansvarigaEmails = m.ansvarigaEmails;
  });
  return controls;
}

// One-time migration: older data stored telefon/notering directly on the
// (world-readable) control doc. Move any such fields into the private/meta
// subdoc and delete them from the doc. Idempotent — skips already-migrated
// controls. Admin-triggered on the Kontroller view load.
export async function migrateControlMeta(cid) {
  const snap = await getDocs(collection(db, 'competitions', cid, 'controls'));
  for (const d of snap.docs) {
    const c = d.data();
    const meta = {};
    // telefon/notering are fully moved (deleted from the doc — Fas 1).
    if (c.telefon !== undefined) meta.telefon = c.telefon;
    if (c.notering !== undefined) meta.notering = c.notering;
    // ansvariga/ansvarigaEmails move to the meta subdoc. Seed `welcomed` with
    // the existing ansvariga so the meta trigger never re-mails them.
    if (c.ansvariga !== undefined) meta.ansvariga = c.ansvariga;
    if (c.ansvarigaEmails !== undefined) {
      meta.ansvarigaEmails = c.ansvarigaEmails;
      meta.welcomed = (c.ansvarigaEmails || []).map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
    }
    if (!Object.keys(meta).length) continue;
    try {
      await setControlMeta(cid, d.id, meta);
      // Fas 3c: remove telefon/notering AND ansvariga/ansvarigaEmails from the
      // public control doc once copied into the meta subdoc.
      const clear = {};
      for (const k of ['telefon', 'notering', 'ansvariga', 'ansvarigaEmails']) {
        if (c[k] !== undefined) clear[k] = deleteField();
      }
      if (Object.keys(clear).length) await updateDoc(d.ref, clear);
    } catch (e) { console.warn('[ESKIL] control-meta-migrering misslyckades', d.id, e); }
  }
}

export async function setPatrolMeta(cid, pid, meta) {
  await setDoc(doc(db, 'competitions', cid, 'patrols', pid, 'private', 'meta'), meta, { merge: true });
}

export async function migratePatrolMeta(cid) {
  const snap = await getDocs(collection(db, 'competitions', cid, 'patrols'));
  for (const d of snap.docs) {
    const p = d.data();
    if (p.notering === undefined) continue;
    try {
      await setPatrolMeta(cid, d.id, { notering: p.notering });
      await updateDoc(d.ref, { notering: deleteField() });
    } catch (e) { console.warn('[ESKIL] patrol-meta-migrering misslyckades', d.id, e); }
  }
}

export async function getPatrolMeta(cid, pid) {
  const snap = await getDoc(doc(db, 'competitions', cid, 'patrols', pid, 'private', 'meta'));
  return snap.exists() ? snap.data() : {};
}

export async function attachPatrolMeta(cid, patrols) {
  const metas = await Promise.all(patrols.map(p => getPatrolMeta(cid, p.id).catch(() => ({}))));
  patrols.forEach((p, i) => {
    p.notering = metas[i].notering || '';
    // Utgått-anteckningen ligger här sedan den flyttades av från det
    // världsläsbara patrulldokumentet — se setPatrolUtgatt.
    p.utgattNote = metas[i].utgattNote || '';
    p.threadToken = metas[i].threadToken || '';
  });
  return patrols;
}

export async function deleteControl(cid, ctrlId) {
  await deleteDoc(doc(db, 'competitions', cid, 'controls', ctrlId));
}

// --- ETA-kalibreringens läscache -----------------------------------------------
// MÄTT, inte uppskattat: på en tävling med 30 kontroller och 40 patruller läser
// rapportsidan 1312 dokument per sidladdning, varav 1200 (91 %) är
// kalibreringens listAllScores. Firestores gratisnivå ger 50 000 läsningar per
// dygn — EN laddning per kontroll äter alltså 79 % av dygnskvoten, och två
// laddningar spränger den. Går kvoten ryker rapporteringen mitt i tävlingen.
//
// Persistent cache hjälper inte: getDocs går till servern varje gång även när
// den är påslagen (verifierat — andra körningen gav 1200 dokument, noll ur
// cachen). Den tjänar offline-läsning, inte kvot.
//
// Cachen bär BARA de tre fält motorn faktiskt läser: patrolId, controlId och
// passagetiden. Inga poäng, inga noteringar — dels blir den liten, dels ska en
// kontrollants telefon inte lagra andra patrullers poäng i onödan.
//
// Färskheten spelar mindre roll än den ser ut: fönstret räknas om mot klockan
// vid varje laddning, det är bara benens medianer som är upp till en halvtimme
// gamla. En median över tre passager rör sig inte snabbt, och rapportsidan
// rensar cachen så fort kontrollanten sparat en egen poäng.
//
// KOSTNADEN ÄR INTE PENGAR. Projektet ligger på Blaze, som debiterar i stället
// för att neka: 5 laddningar × 30 kontroller är 196 800 läsningar ≈ 0,09 USD
// för hela tävlingsdagen. Det som gör ont är TIDEN och DATAN — 567 ms blockerad
// laddning och 177 kB över mobilnätet, på en telefon med en stapel i skogen.
// Cachen tar bort båda för varje omladdning inom fönstret.
const ETA_CACHE_MS = 30 * 60000;
const etaNyckel = (cid) => `eskil-eta-${cid}`;

export async function listAllScoresForEta(cid, controls = null) {
  try {
    const rå = localStorage.getItem(etaNyckel(cid));
    if (rå) {
      const { at, rader } = JSON.parse(rå);
      if (Date.now() - at < ETA_CACHE_MS && Array.isArray(rader)) {
        return rader.map(r => ({ ...r, clientReportedAt: new Date(r.t) }));
      }
    }
  } catch { /* privat läge eller trasig post — läs om */ }

  const alla = await listAllScores(cid, controls);
  try {
    localStorage.setItem(etaNyckel(cid), JSON.stringify({
      at: Date.now(),
      rader: alla.map(s => ({
        patrolId: s.patrolId, controlId: s.controlId,
        t: (s.clientReportedAt ?? s.reportedAt)?.toDate?.().getTime()
           ?? new Date(s.clientReportedAt ?? s.reportedAt ?? 0).getTime()
      })).filter(r => r.patrolId && r.controlId && Number.isFinite(r.t))
    }));
  } catch { /* full disk — cachen är en bonus */ }
  return alla;
}

// Rapportsidan sparar en egen poäng: då är cachen förlegad för just den raden.
// Billigare att slänga den än att försöka laga den — nästa laddning läser om.
export function rensaEtaCache(cid) {
  try { localStorage.removeItem(etaNyckel(cid)); } catch { /* privat läge */ }
}

// --- Papperskorg ---------------------------------------------------------------
// deletePatrol och deleteControl var hårda: ett felklick mitt under
// tävlingsdagen raderade en patrull och allt den rapporterat, spårlöst.
//
// Papperskorgen FLYTTAR dokumentet i stället för att flagga det. Det är ett
// medvetet val framför en `deleted: true`-flagga, av tre skäl:
//
//  1. Ingen filtrering. En flagga hade krävt `!deleted` på ~30 ställen som
//     listar patruller och kontroller — köer, ETA, larm, PDF:er, exporten. En
//     enda missad yta betyder att en "raderad" patrull dyker upp i en kö.
//  2. Den hemliga länken dör direkt. Kontrollens /k-länk vaktas av
//     `open == true`, inte av någon deleted-flagga — en flaggad kontroll hade
//     fortsatt ta emot poäng från sin QR-kod.
//  3. Ingen .get()-fälla. En direktläsning av ett saknat `deleted` i reglerna
//     är ett evalueringsFEL som tyst nekar skrivningen.
//
// Priset är att poängen måste bäras med i papperskorgsposten och skrivas
// tillbaka vid återställning. Det är ett litet pris för att resten av
// systemet inte behöver veta att papperskorgen finns.
export async function flyttaTillPapperskorg(cid, sort, id) {
  const ref = sort === 'patrull'
    ? doc(db, 'competitions', cid, 'patrols', id)
    : doc(db, 'competitions', cid, 'controls', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;

  const post = {
    sort, ursprungsId: id, data: snap.data(),
    raderadAt: Timestamp.fromDate(new Date()),
    poang: []
  };

  if (sort === 'kontroll') {
    // Kontrollens egna poäng. De var FÖRÄLDRALÖSA förut: deleteControl
    // raderade bara kontrolldokumentet och lämnade scores-subkollektionen kvar.
    const sc = await getDocs(collection(db, 'competitions', cid, 'controls', id, 'scores'));
    post.poang = sc.docs.map(d => ({ id: d.id, ...toPlainish(d.data()) }));
    await deleteRefs(sc.docs.map(d => d.ref));
    const meta = await getDoc(doc(db, 'competitions', cid, 'controls', id, 'private', 'meta'));
    if (meta.exists()) post.meta = meta.data();
    await deleteDoc(doc(db, 'competitions', cid, 'controls', id, 'private', 'meta')).catch(() => {});
    // Kontrollens faltinfo-spegel MÅSTE med. Kvar blir den föräldralös OCH
    // världsläsbar — ingen kontroll pekar längre på den, så varken
    // syncFaltinfo eller en okulär genomgång hittar den, medan doc-id:t
    // (kontrollens threadToken) fortfarande öppnar den för vem som helst.
    const tok = meta.exists() ? meta.data()?.threadToken : null;
    if (tok) await deleteDoc(doc(db, 'competitions', cid, 'faltinfo', tok)).catch(() => {});
  } else {
    // Patrullens poäng ligger utspridda under varje kontroll.
    const ctrls = await getDocs(collection(db, 'competitions', cid, 'controls'));
    for (const c of ctrls.docs) {
      const sref = doc(db, 'competitions', cid, 'controls', c.id, 'scores', id);
      const ss = await getDoc(sref);
      if (!ss.exists()) continue;
      post.poang.push({ controlId: c.id, id, ...toPlainish(ss.data()) });
      await deleteDoc(sref);
    }
    const meta = await getDoc(doc(db, 'competitions', cid, 'patrols', id, 'private', 'meta'));
    if (meta.exists()) post.meta = meta.data();
    await deleteDoc(doc(db, 'competitions', cid, 'patrols', id, 'private', 'meta')).catch(() => {});
  }

  await addDoc(collection(db, 'competitions', cid, 'papperskorg'), post);
  await deleteDoc(ref);
  return post;
}

// Timestamps kan inte ligga nästlade i en array i Firestore — de blir tysta
// null:ar. Görs om till ISO-strängar här och tillbaka vid återställning.
function toPlainish(o) {
  const ut = {};
  for (const [k, v] of Object.entries(o || {})) {
    ut[k] = (v && typeof v.toDate === 'function') ? v.toDate().toISOString() : v;
  }
  return ut;
}

export async function listaPapperskorg(cid) {
  const snap = await getDocs(collection(db, 'competitions', cid, 'papperskorg'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.raderadAt?.toMillis?.() ?? 0) - (a.raderadAt?.toMillis?.() ?? 0));
}

// Skriver tillbaka med SAMMA doc-id. Kontrollens QR-koder och patrullens
// startkortslänk pekar på id:t — ett nytt id hade gjort tryckta koder döda.
export async function aterstallFranPapperskorg(cid, korgId) {
  const ref = doc(db, 'competitions', cid, 'papperskorg', korgId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const post = snap.data();
  const bas = post.sort === 'patrull' ? 'patrols' : 'controls';
  await setDoc(doc(db, 'competitions', cid, bas, post.ursprungsId), post.data);
  if (post.meta) {
    await setDoc(doc(db, 'competitions', cid, bas, post.ursprungsId, 'private', 'meta'), post.meta);
    // Spegeln återskapas när token skrivs tillbaka. Utan detta står den
    // återställda kontrollens /k utan nödkontakter fram till att någon råkar
    // öppna kontrollistan — och det är just en återställd kontroll som
    // sannolikt är på väg ut i skogen igen.
    if (post.sort === 'kontroll' && post.meta.threadToken) {
      await sakerstallFaltinfo(cid, post.meta.threadToken);
    }
  }
  for (const p of (post.poang || [])) {
    const { controlId, id, ...rest } = p;
    const cId = post.sort === 'kontroll' ? post.ursprungsId : controlId;
    const pId = post.sort === 'kontroll' ? id : post.ursprungsId;
    if (!cId || !pId) continue;
    const data = { ...rest };
    for (const nyckel of ['reportedAt', 'clientReportedAt']) {
      if (typeof data[nyckel] === 'string') data[nyckel] = Timestamp.fromDate(new Date(data[nyckel]));
    }
    await setDoc(doc(db, 'competitions', cid, 'controls', cId, 'scores', pId), data);
  }
  await deleteDoc(ref);
  return post;
}

export async function tommPapperskorg(cid) {
  const snap = await getDocs(collection(db, 'competitions', cid, 'papperskorg'));
  await deleteRefs(snap.docs.map(d => d.ref));
  return snap.docs.length;
}

// --- Scores ----------------------------------------------------------------

export function watchScoresForControl(cid, ctrlId, cb) {
  return onSnapshot(
    collection(db, 'competitions', cid, 'controls', ctrlId, 'scores'),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

export async function listScoresForControl(cid, ctrlId) {
  const snap = await getDocs(
    collection(db, 'competitions', cid, 'controls', ctrlId, 'scores')
  );
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function listAllScores(cid, preloadedControls = null) {
  // Read all controls (unless the caller already has them), then all scores
  // under each — in parallel, one round-trip per control instead of serial.
  const controls = preloadedControls || await listControls(cid);
  const out = [];
  const snaps = await Promise.all(controls.map(c =>
    getDocs(collection(db, 'competitions', cid, 'controls', c.id, 'scores'))
      .then(snap => ({ c, snap }))
  ));
  for (const { c, snap } of snaps) {
    for (const d of snap.docs) {
      out.push({ id: d.id, controlId: c.id, controlNummer: c.nummer, ...d.data() });
    }
  }
  return out;
}

// Snapshot the replaced values of a score doc for its history trail —
// pushed onto `history` whenever a score is overwritten, so protests can be
// resolved against a record of who reported what and when. Capped at the 10
// most recent entries to keep the doc small.
export function scoreHistoryEntry(existing) {
  if (!existing) return null;
  const entry = {
    poang: Number(existing.poang) || 0,
    extraPoang: Number(existing.extraPoang) || 0,
    note: existing.note || '',
    reporter: existing.reporter || '',
    replacedAt: new Date().toISOString()
  };
  if (existing.reportedAt) {
    const d = typeof existing.reportedAt.toDate === 'function' ? existing.reportedAt.toDate() : new Date(existing.reportedAt);
    if (!isNaN(d)) entry.reportedAt = d.toISOString();
  }
  if (existing.utslagGissning != null) entry.utslagGissning = existing.utslagGissning;
  if (existing.adjustNote) entry.adjustNote = existing.adjustNote;
  return entry;
}

export async function upsertScore(cid, ctrlId, patrolId, poang, extraPoang, note, reporter, utslagGissning = null, history = null, clientAt = null) {
  // One score per patrol per control. Use patrolId as the doc id to keep it unique.
  const ref = doc(db, 'competitions', cid, 'controls', ctrlId, 'scores', patrolId);
  const data = {
    patrolId,
    poang: Number(poang) || 0,
    extraPoang: Number(extraPoang) || 0,
    note: note || '',
    reportedAt: serverTimestamp(),
    // Passagetiden = när knappen trycktes, INTE när skrivningen synkade.
    // En rapport som legat i offlinekön i timmar ska bära tryck-ögonblicket
    // (clientAt från kön) — annars förgiftar batchsynkar ETA-motorns
    // mellantider och patrullernas målgångsankare.
    clientReportedAt: Timestamp.fromDate(clientAt ? new Date(clientAt) : new Date()),
    reporter: reporter || ''
  };
  // Tiebreaker guess (utslagskontroll) — only written when actually given.
  if (utslagGissning != null && Number.isFinite(Number(utslagGissning))) {
    data.utslagGissning = Number(utslagGissning);
  }
  if (Array.isArray(history) && history.length) data.history = history.slice(-10);
  await setDoc(ref, data);
}

// Sekretariat adjustment: overwrite a score with a MANDATORY motivation,
// preserving the replaced values in the history trail. Requires competition
// admin (rules allow admins to write scores even on closed controls).
export async function adjustScore(cid, ctrlId, patrolId, existing, { poang, extraPoang, adjustNote, adjustedBy }) {
  const ref = doc(db, 'competitions', cid, 'controls', ctrlId, 'scores', patrolId);
  const history = [...(existing?.history || []), scoreHistoryEntry(existing)].filter(Boolean).slice(-10);
  const data = {
    patrolId,
    poang: Number(poang) || 0,
    extraPoang: Number(extraPoang) || 0,
    note: existing?.note || '',
    // Behåll den URSPRUNGLIGA passagetiden — patrullen stod inte vid
    // kontrollen när sekretariatet rättade poängen. Justeringsögonblicket
    // finns redan i history-posten (replacedAt).
    reportedAt: existing?.reportedAt ?? serverTimestamp(),
    reporter: 'sekretariat',
    adjustNote: adjustNote || '',
    // adjustedBy SKRIVS INTE HIT. Poängdokumentet har `allow read: if true`
    // (firestore.rules:406), så sekretariatets e-postadress låg publikt
    // läsbar — och `reporter: 'sekretariat'` ovan säger redan det vyn behöver
    // visa ("rättad av sekretariatet"). Attributionen bor i sekretariatets
    // logg, som är member-only och gallras med tävlingen. Argumentet finns
    // kvar i signaturen med flit: anroparen ska fortsätta skicka adressen, men
    // till loggen, inte till det publika dokumentet.
  };
  if (existing?.clientReportedAt) data.clientReportedAt = existing.clientReportedAt;
  if (existing?.utslagGissning != null) data.utslagGissning = existing.utslagGissning;
  if (history.length) data.history = history;
  await setDoc(ref, data);
}

export async function deleteScore(cid, ctrlId, scoreId) {
  await deleteDoc(doc(db, 'competitions', cid, 'controls', ctrlId, 'scores', scoreId));
}

// --- Start/Mål-station --------------------------------------------------------
// One station per competition (the doc ID is the secret in /m/<cid>/<sid>).
// Passages: one doc per patrol with startAt/finishAt server timestamps.

// --- Spårdragning ------------------------------------------------------------
// One doc per competition: { speedKmh, legs: { "<fromKey>__<toKey>": [{lat,lng},…] } }.
// The leg sequence itself is derived from control order at render time — the
// doc only stores drawn waypoints, so renumbering controls keeps whatever
// legs still connect the same pair.

export async function getTrack(cid) {
  const snap = await getDoc(doc(db, 'competitions', cid, 'track', 'main'));
  return snap.exists() ? snap.data() : null;
}

export async function saveTrack(cid, data) {
  await setDoc(doc(db, 'competitions', cid, 'track', 'main'), {
    ...data,
    updatedAt: serverTimestamp()
  });
}

// --- PM-utskick ---------------------------------------------------------------
// Creating a doc here triggers the onUtskickCreated Cloud Function, which
// mails every active registration contact and stamps sentAt/recipients back.

export async function createUtskick(cid, { subject, body }, createdBy) {
  const ref = await addDoc(collection(db, 'competitions', cid, 'utskick'), {
    subject, body, createdBy: createdBy || '', createdAt: serverTimestamp()
  });
  return ref.id;
}

export async function listUtskick(cid) {
  const snap = await getDocs(query(
    collection(db, 'competitions', cid, 'utskick'),
    orderBy('createdAt', 'desc')
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function listStations(cid) {
  const snap = await getDocs(collection(db, 'competitions', cid, 'stations'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function createStation(cid) {
  const ref = await addDoc(collection(db, 'competitions', cid, 'stations'), {
    createdAt: serverTimestamp()
  });
  return ref.id;
}

export async function getStation(cid, stationId) {
  const snap = await getDoc(doc(db, 'competitions', cid, 'stations', stationId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export function watchPassages(cid, stationId, cb) {
  // includeMetadataChanges + _pending: stationssidan markerar incheckningar
  // som ligger i den lokala kön ("väntar på nät") tills servern bekräftat.
  return onSnapshot(
    collection(db, 'competitions', cid, 'stations', stationId, 'passages'),
    { includeMetadataChanges: true },
    snap => cb(snap.docs.map(d => ({ id: d.id, _pending: d.metadata.hasPendingWrites, ...d.data() })))
  );
}

// --- Samtal fält <-> tävlingsledning -------------------------------------------
// En tråd per kontroll och per patrull. Tråd-id:t finns i TVÅ former, och
// skillnaden är hela säkerhetsmodellen:
//
//   HÄRLEDD  'kontroll-<ctrlId>' / 'patrull-<patrolId>' — går att räkna fram,
//            eftersom kontroller och patruller är världsläsbara. Fältet får
//            fortfarande SKRIVA hit (nödropet måste alltid gå fram), men bara
//            ledningen får läsa.
//   TOKEN    en slumpad sträng som ledningen mintar och som ligger i
//            fältlänkens fjärde segment. Den som har länken får läsa svaren.
//
// Se `harledd()` i firestore.rules. Funktionerna nedan tar ett FÄRDIGT tråd-id
// — anroparen väljer form med `threadIdFor`.

export const threadId = (kind, refId) => `${kind}-${refId}`;

// Fältsidans val: har vi en token i länken används den, annars den härledda
// formen (skriv-bara). Ledningen anropar alltid med trådens riktiga id.
export const threadIdFor = (kind, refId, token) => token || threadId(kind, refId);

// Ett tråd-id som INTE är härlett kan bara ledningen ha skapat — det är så
// klienten vet om den får läsa. Samma regex som reglerna.
export const arHarleddTrad = (tid) => /^(kontroll|patrull)-/.test(String(tid || ''));

// Mintar samtalstoken för en kontroll eller patrull, en gång.
//
// Token läggs i private/meta (member-only) OCH ett tomt trådhuvud skapas på
// token-id:t: reglerna kräver att huvudet finns innan fältet får skriva i en
// tokentråd, och det kravet är det enda som hindrar att någon lägger upp ett
// eget id och läser sina egna meddelanden.
//
// Mintningen sker LAT, där länken byggs — inte i createControl. Kontroller och
// patruller skapas nämligen på fyra ställen till (årgångskopiering,
// backupimport, återställning ur papperskorgen, massimport från anmälan), och
// var och en av dem hade behövt komma ihåg det.
export async function ensureThreadToken(cid, kind, refId) {
  const metaRef = kind === 'kontroll'
    ? doc(db, 'competitions', cid, 'controls', refId, 'private', 'meta')
    : doc(db, 'competitions', cid, 'patrols', refId, 'private', 'meta');
  // Läsfelet får INTE svälja: "kunde inte läsa" och "har ingen token" måste
  // hållas isär. Gjorde de inte det skulle en tillfällig läsmiss mynta en ny
  // token över den befintliga, och ledningen skulle svara i en tråd som den
  // utskrivna QR-koden inte pekar på.
  const snap = await getDoc(metaRef);
  const redan = snap.exists() ? snap.data()?.threadToken : null;

  // ÅTER-MINT-SPÄRREN står kvar orörd: en ny token hade dödat en tryckt QR.
  // Men spegeln måste ändå kunna skapas för en kontroll som REDAN har token,
  // annars får ingen befintlig fältlänk någonsin nödkontakterna. Därför
  // returneras inte tidigt förrän spegeln är avklarad.
  if (redan) {
    if (kind === 'kontroll') await sakerstallFaltinfo(cid, redan);
    return redan;
  }
  // Samma generator som kompletteringarnas token: 24 tecken bas36, inga
  // bindestreck — kan alltså aldrig se ut som den härledda formen.
  const token = slumpToken();
  const batch = writeBatch(db);
  batch.set(metaRef, { threadToken: token }, { merge: true });
  batch.set(doc(db, 'competitions', cid, 'threads', token), { kind, refId }, { merge: true });
  await batch.commit();
  if (kind === 'kontroll') await sakerstallFaltinfo(cid, token);
  return token;
}

/**
 * Skapar kontrollens faltinfo-spegel om den saknas.
 *
 * VAKTEN kind === 'kontroll' hos anroparna är inte valfri: samma
 * ensureThreadToken mintar PATRULLERNAS tokens, och tävlingssidan länkar
 * publikt till startkorten. En spegel på en patrulltoken hade gjort ledningens
 * interna nummer effektivt publika — /s behöver bara de publika rollerna.
 */
async function sakerstallFaltinfo(cid, token) {
  const ref = doc(db, 'competitions', cid, 'faltinfo', token);
  try {
    if ((await getDoc(ref)).exists()) return;
    const internPii = await readLedning(cid) || {};
    await setDoc(ref, { internPii, uppdaterad: new Date().toISOString() }, { merge: false });
  } catch { /* spegeln får aldrig hindra att länken byggs */ }
}

// Mintar för en hel lista och hänger på `threadToken` på varje post, så
// länkbyggarna (PDF:er, kopiera-länk, utskiftscentralen) kan köra rakt igenom.
export async function ensureThreadTokens(cid, kind, items) {
  await Promise.all((items || []).map(async (it) => {
    if (it.threadToken) return;
    it.threadToken = await ensureThreadToken(cid, kind, it.id).catch(() => null);
  }));
  return items;
}

export function watchThread(cid, tid, cb) {
  return onSnapshot(
    query(collection(db, 'competitions', cid, 'threads', tid, 'messages'), orderBy('at')),
    // includeMetadataChanges: ett meddelande skrivet utan täckning ska synas
    // som "skickar…" tills servern bekräftat, precis som stationens
    // incheckningar.
    { includeMetadataChanges: true },
    snap => cb(snap.docs.map(d => ({ id: d.id, _pending: d.metadata.hasPendingWrites, ...d.data() }))),
    () => cb([])   // avstängd funktion eller stängd tävling — tyst tom tråd
  );
}

export function watchThreadDoc(cid, tid, cb) {
  return onSnapshot(doc(db, 'competitions', cid, 'threads', tid),
    snap => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null), () => cb(null));
}

// Alla trådar (ledningens inkorg). Kräver medlemskap — se list-regeln.
export function watchThreads(cid, cb) {
  return onSnapshot(collection(db, 'competitions', cid, 'threads'),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => cb([]));
}

// Skicka ett meddelande. `from` är 'falt' eller 'ledning' — reglerna tillåter
// bara 'falt' anonymt.
//
// Klienttid, inte serverTimestamp: samma skäl som poängrapporterna. Ett
// meddelande som skrivs offline och synkas senare ska bära ögonblicket det
// skrevs, annars hamnar samtalet i fel ordning när nätet kommer tillbaka.
export async function sendThreadMessage(cid, kind, refId, { from, text = '', image = null, token = null }) {
  const tid = threadIdFor(kind, refId, token);
  const at = Timestamp.fromDate(new Date());
  const msg = { from, at };
  if (text) msg.text = String(text).slice(0, 2000);
  if (image) msg.image = image;
  // Trådhuvudet driver ledningens inkorg — utan det finns meddelandet i
  // databasen men syns ingenstans. Båda skrivningarna läggs i SAMMA batch, och
  // det är hela poängen: förut väntade koden ut `addDoc` innan huvudet skrevs,
  // och offline resolvar den väntan aldrig. Stängde kontrollanten fliken innan
  // täckningen kom tillbaka synkades meddelandet — men huvudet hade aldrig ens
  // köats, så frågan från skogen landade i en tråd ledningen inte kunde se.
  // Fältet får inte röra ledningReadAt (reglerna vaktar det), så oläst-status
  // kan inte gömmas.
  const huvud = {
    kind, refId, lastAt: at, lastFrom: from,
    lastText: text ? String(text).slice(0, 120) : (image ? '[bild]' : '')
  };
  if (from === 'falt') huvud.faltReadAt = at;
  else huvud.ledningReadAt = at;
  const batch = writeBatch(db);
  batch.set(doc(collection(db, 'competitions', cid, 'threads', tid, 'messages')), msg);
  batch.set(doc(db, 'competitions', cid, 'threads', tid), huvud, { merge: true });
  await batch.commit();
}

// Läskvittens. Vem som läst styr vilken stämpel som sätts — och reglerna
// hindrar fältet från att sätta ledningens.
export async function markThreadRead(cid, kind, refId, who, token = null) {
  await setDoc(doc(db, 'competitions', cid, 'threads', threadIdFor(kind, refId, token)),
    { kind, refId, [who === 'ledning' ? 'ledningReadAt' : 'faltReadAt']: Timestamp.fromDate(new Date()) },
    { merge: true });
}

// --- Patrullens egna avprickningar -------------------------------------------
// "Bekräfta start" och "Vi är i mål" på startkortet. Egen collection: kortet
// känner inte till stations-id:t (hemligt). Läget och stationssidan slår ihop
// dessa med stationens passages så bilden blir en och samma.

export function watchSelfPassages(cid, cb) {
  return onSnapshot(
    collection(db, 'competitions', cid, 'selfPassages'),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

export async function listSelfPassages(cid) {
  const snap = await getDocs(collection(db, 'competitions', cid, 'selfPassages'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// field: 'startAt' | 'finishAt'.
//
// Klienttid, inte serverTimestamp — samma skäl som stationens utcheckning: en
// avprickning som synkas när nätet kommer tillbaka ska bära ögonblicket då
// knappen trycktes. Reglerna låter varje stämpel sättas EN gång; ett andra
// försök kastar, och det är meningen.
export async function confirmSelfPassage(cid, patrolId, field) {
  await setDoc(
    doc(db, 'competitions', cid, 'selfPassages', patrolId),
    { patrolId, [field]: Timestamp.fromDate(new Date()) },
    { merge: true }
  );
}

// Admin ångrar: ta bort en stämpel utan att röra den andra.
export async function clearSelfPassage(cid, patrolId, field) {
  await updateDoc(doc(db, 'competitions', cid, 'selfPassages', patrolId), { [field]: deleteField() });
}

// field: 'startAt' | 'finishAt'. value=true stamps now, value=false clears.
export async function setPassage(cid, stationId, patrolId, field, value) {
  const ref = doc(db, 'competitions', cid, 'stations', stationId, 'passages', patrolId);
  if (value) {
    // Klienttid, inte serverTimestamp: en utcheckning som synkas först när
    // nätet kommer tillbaka ska bära ögonblicket då knappen trycktes — inte
    // synkögonblicket. Stationens klocka är gott nog som facit.
    await setDoc(ref, { patrolId, [field]: Timestamp.fromDate(new Date()) }, { merge: true });
  } else {
    await updateDoc(ref, { [field]: deleteField() });
  }
}

// --- Registrations (Anmälan) ------------------------------------------------
// The registration doc ID is the secret — the manage link /a/<cid>/<regId> is
// the only way for the anmälare to reach their registration (same pattern as
// control reporter URLs). Anonymous get/create/update; only admins may list.

export async function getRegistration(cid, regId) {
  const snap = await getDoc(doc(db, 'competitions', cid, 'registrations', regId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function listRegistrations(cid) {
  const snap = await getDocs(collection(db, 'competitions', cid, 'registrations'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function createRegistration(cid, regId, data) {
  await setDoc(doc(db, 'competitions', cid, 'registrations', regId), data);
}

export async function updateRegistration(cid, regId, data) {
  await updateDoc(doc(db, 'competitions', cid, 'registrations', regId), data);
}

export async function deleteRegistration(cid, regId) {
  // Kompletteringarna hänger på anmälan. Lämnades de kvar skulle deras länkar
  // fortsätta fungera och visa allergier för en anmälan som inte finns — och
  // en tävling utan anmälningar skulle bära patrulluppgifter i databasen.
  const reg = await getRegistration(cid, regId).catch(() => null);
  for (const r of (reg?.kompletteringar || [])) {
    await deleteDoc(doc(db, 'competitions', cid, 'kompletteringar', r.token)).catch(() => {});
  }
  await deleteDoc(doc(db, 'competitions', cid, 'registrations', regId));
}

// --- Meddelanden till ESKIL (kontaktformuläret) -------------------------------
// Tråden skapas ALDRIG härifrån: formuläret går genom den anropbara funktionen
// sendFeedback, som stryper per adress innan admin-SDK:n skriver.
//
// Id:t är hemligheten. Den som har `/kontakt/<fbId>` får läsa tråden och svara
// i den — precis som anmälningarnas ändringslänk. Därför innehåller
// trådhuvudet bara sådant avsändaren själv skrivit; det interna (vilken
// super-admin som svarat) ligger i private/meta, som bara super-admin når.

export function watchFeedback(cb) {
  return onSnapshot(query(collection(db, 'feedback'), orderBy('lastAt', 'desc')),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => cb([]));
}

export function watchFeedbackThread(fbId, cb) {
  return onSnapshot(doc(db, 'feedback', fbId),
    snap => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null), () => cb(null));
}

export function watchFeedbackMessages(fbId, cb) {
  return onSnapshot(query(collection(db, 'feedback', fbId, 'messages'), orderBy('at', 'asc')),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => cb([]));
}

// `from` är 'eskil' eller 'anvandare' — reglerna kräver super-admin för
// 'eskil' och att ärendet är öppet för 'anvandare'. Vem som skrev ett
// ESKIL-svar loggas i private/meta, inte i meddelandet: den som har länken
// ska aldrig se en super-admins adress.
export async function sendFeedbackMessage(fbId, from, text) {
  const ref = await addDoc(collection(db, 'feedback', fbId, 'messages'), {
    from,
    text: String(text).slice(0, 4000),
    at: serverTimestamp()
  });
  if (from === 'eskil') {
    await setDoc(doc(db, 'feedback', fbId, 'private', 'meta'), {
      authors: { [ref.id]: (auth.currentUser?.email || '').toLowerCase() }
    }, { merge: true });
  }
}

export function watchFeedbackMeta(fbId, cb) {
  return onSnapshot(doc(db, 'feedback', fbId, 'private', 'meta'),
    snap => cb(snap.exists() ? snap.data() : {}), () => cb({}));
}

export async function setFeedbackStatus(fbId, status) {
  await updateDoc(doc(db, 'feedback', fbId), { status });
  await setDoc(doc(db, 'feedback', fbId, 'private', 'meta'), {
    handledBy: (auth.currentUser?.email || '').toLowerCase(),
    handledAt: serverTimestamp()
  }, { merge: true });
}

// Läskvitto — för de andra super-adminsen, så två personer inte sitter och
// svarar på samma sak utan att veta om varandra.
export async function markFeedbackRead(fbId) {
  await setDoc(doc(db, 'feedback', fbId, 'private', 'meta'),
    { readAt: serverTimestamp() }, { merge: true });
}

// Avsändaren öppnade tråden. Enda fältet hen får röra i huvudet.
export async function markFeedbackSeenByUser(fbId) {
  await updateDoc(doc(db, 'feedback', fbId), { faltReadAt: serverTimestamp() });
}

// Antalet obesvarade — bara till badgen på kontosidan.
export async function listNewFeedback() {
  const snap = await getDocs(query(collection(db, 'feedback'), where('status', '==', 'ny')));
  return snap.size;
}

// --- Kontrollens livstecken (beacon) ------------------------------------------
// Rapportsidan skriver; Läget läser. `at` är KLIENT-tid med flit: en buffrad
// offline-skrivning som synkar senare ska bära den sanna senast-vid-liv-tiden,
// inte synkögonblicket (samma resonemang som clientReportedAt på poängen).
// Ett livstecken per ENHET, inte ett per kontroll. En kontroll bemannas ofta
// av två personer, och med en delad `status`-doc skrev den friska telefonen
// över den döende: Läget visade grönt medan batteriet som faktiskt rapporterar
// gick mot noll. Enhets-id:t lever i localStorage och är slumpat — det säger
// inget om vem som håller telefonen.
function enhetsId() {
  const NYCKEL = 'eskil-enhet';
  try {
    let v = localStorage.getItem(NYCKEL);
    if (!v) { v = Math.random().toString(36).slice(2, 12) + Date.now().toString(36); localStorage.setItem(NYCKEL, v); }
    return v;
  } catch { return 'enhet'; }         // privat läge: dela på en doc som förr
}

export async function sendControlBeacon(cid, ctrlId, { batteri = null, laddar = null, koade = 0 } = {}) {
  const data = { at: Timestamp.fromDate(new Date()), koade: Number(koade) || 0 };
  if (typeof batteri === 'number' && Number.isFinite(batteri)) data.batteri = Math.round(batteri);
  if (typeof laddar === 'boolean') data.laddar = laddar;
  await setDoc(doc(db, 'competitions', cid, 'controls', ctrlId, 'beacon', enhetsId()), data);
}

export function watchControlBeacon(cid, ctrlId, cb) {
  return onSnapshot(collection(db, 'competitions', cid, 'controls', ctrlId, 'beacon'),
    snap => cb(mergeBeacons(snap.docs.map(d => d.data()))), () => cb(null));
}
