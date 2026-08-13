// Firestore data access layer. Keeps queries in one place.

import {
  auth,
  db, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs, onSnapshot, query, where, orderBy,
  serverTimestamp, deleteField, writeBatch
} from './firebase.js';

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
  const ref = await addDoc(collection(db, 'competitions'), {
    ...docData,
    admins: [user.uid],
    createdBy: user.uid,
    createdAt: serverTimestamp()
  });
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
  await updateDoc(doc(db, 'competitions', cid), docData);
  await mirrorAccess(cid, data);
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
    userEmails: []
  };
  if (Array.isArray(src.avdelningar) && src.avdelningar.length) data.avdelningar = src.avdelningar;
  for (const k of ['startTimes', 'startFinish', 'parking', 'management',
                   'publicScores', 'publicControls', 'autoReleaseControls',
                   'anonymousControls', 'autoCloseControls']) {
    if (src[k] !== undefined) data[k] = src[k];
  }
  if (src.registration) {
    data.registration = { ...src.registration, enabled: false, opensAt: null, closesAt: null };
  }

  const newCid = await createCompetition(data, user);

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

export async function reopenCompetition(cid) {
  await updateDoc(doc(db, 'competitions', cid), { closed: false });
}

export async function deleteCompetition(cid) {
  // Firestore never deletes subcollections with their parent, so remove
  // everything that lives under the competition first — otherwise patrols,
  // controls, scores and registrations linger as orphaned documents.
  const controlsSnap = await getDocs(collection(db, 'competitions', cid, 'controls'));
  for (const c of controlsSnap.docs) {
    const scores = await getDocs(collection(db, 'competitions', cid, 'controls', c.id, 'scores'));
    await deleteRefs(scores.docs.map(d => d.ref));
    // private/meta (telefon, notering) lives in a subcollection too.
    await deleteDoc(doc(db, 'competitions', cid, 'controls', c.id, 'private', 'meta')).catch(() => {});
  }
  await deleteRefs(controlsSnap.docs.map(d => d.ref));
  const patrolsSnap = await getDocs(collection(db, 'competitions', cid, 'patrols'));
  for (const p of patrolsSnap.docs) {
    await deleteDoc(doc(db, 'competitions', cid, 'patrols', p.id, 'private', 'meta')).catch(() => {});
  }
  await deleteRefs(patrolsSnap.docs.map(d => d.ref));
  for (const sub of ['registrations', 'invites']) {
    const snap = await getDocs(collection(db, 'competitions', cid, sub));
    await deleteRefs(snap.docs.map(d => d.ref));
  }
  await deleteDoc(doc(db, 'competitions', cid));
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

export async function deletePatrol(cid, pid) {
  await deleteDoc(doc(db, 'competitions', cid, 'patrols', pid));
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
  patrols.forEach((p, i) => { p.notering = metas[i].notering || ''; });
  return patrols;
}

export async function deleteControl(cid, ctrlId) {
  await deleteDoc(doc(db, 'competitions', cid, 'controls', ctrlId));
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

export async function listAllScores(cid) {
  // Read all controls, then all scores under each.
  const controls = await listControls(cid);
  const out = [];
  for (const c of controls) {
    const snap = await getDocs(
      collection(db, 'competitions', cid, 'controls', c.id, 'scores')
    );
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
  if (existing.adjustNote) { entry.adjustNote = existing.adjustNote; entry.adjustedBy = existing.adjustedBy || ''; }
  return entry;
}

export async function upsertScore(cid, ctrlId, patrolId, poang, extraPoang, note, reporter, utslagGissning = null, history = null) {
  // One score per patrol per control. Use patrolId as the doc id to keep it unique.
  const ref = doc(db, 'competitions', cid, 'controls', ctrlId, 'scores', patrolId);
  const data = {
    patrolId,
    poang: Number(poang) || 0,
    extraPoang: Number(extraPoang) || 0,
    note: note || '',
    reportedAt: serverTimestamp(),
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
    reportedAt: serverTimestamp(),
    reporter: 'sekretariat',
    adjustNote: adjustNote || '',
    adjustedBy: adjustedBy || ''
  };
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
  return onSnapshot(
    collection(db, 'competitions', cid, 'stations', stationId, 'passages'),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

// field: 'startAt' | 'finishAt'. value=true stamps now, value=false clears.
export async function setPassage(cid, stationId, patrolId, field, value) {
  const ref = doc(db, 'competitions', cid, 'stations', stationId, 'passages', patrolId);
  if (value) {
    await setDoc(ref, { patrolId, [field]: serverTimestamp() }, { merge: true });
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
  await deleteDoc(doc(db, 'competitions', cid, 'registrations', regId));
}
