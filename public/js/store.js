// Firestore data access layer. Keeps queries in one place.

import {
  db, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs, onSnapshot, query, where, orderBy,
  serverTimestamp, deleteField, writeBatch
} from './firebase.js';

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

export async function listCompetitionsForUser(user) {
  const snap = await getDocs(collection(db, 'competitions'));
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (user.role === 'super-admin') return all;
  const email = String(user.email || '').trim().toLowerCase();
  // Everyone can see demo competitions; otherwise only ones they belong to —
  // as legacy uid-admin, email-invited admin, or email-invited user
  // (kontrollansvariga are mirrored into userEmails when assigned).
  return all.filter(c =>
    c.demo === true ||
    (c.admins || []).includes(user.uid) ||
    (c.adminEmails || []).includes(email) ||
    (c.userEmails || []).includes(email)
  );
}

export async function getCompetition(cid) {
  const snap = await getDoc(doc(db, 'competitions', cid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function createCompetition(data, user) {
  const ref = await addDoc(collection(db, 'competitions'), {
    ...data,
    admins: [user.uid],
    users: [],
    createdBy: user.uid,
    createdAt: serverTimestamp()
  });
  return ref.id;
}

export async function updateCompetition(cid, data) {
  await updateDoc(doc(db, 'competitions', cid), data);
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
        notering: '',
        telefon: '',
        ansvariga: [],
        ansvarigaEmails: [],
        open: false
      };
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
  await updateDoc(doc(db, 'competitions', cid), {
    users: clean,
    userEmails: clean.map(e => e.email)
  });
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
        open: false, ansvariga: [], ansvarigaEmails: [], telefon: ''
      });
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
    ? comp.management.map(r => ({ id: r.id, label: r.label || '', visibility: r.visibility || 'public', name: '', phone: '', email: '' }))
    : undefined;

  await updateDoc(doc(db, 'competitions', cid), {
    closed: true, users: [], userEmails: [],
    ...(strippedManagement ? { management: strippedManagement } : {})
  });
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
  }
  await deleteRefs(controlsSnap.docs.map(d => d.ref));
  for (const sub of ['patrols', 'registrations', 'invites']) {
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
  const ref = await addDoc(collection(db, 'competitions', cid, 'patrols'), {
    ...data,
    createdAt: serverTimestamp()
  });
  return ref.id;
}

export async function updatePatrol(cid, pid, data) {
  await updateDoc(doc(db, 'competitions', cid, 'patrols', pid), data);
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
  const ref = await addDoc(collection(db, 'competitions', cid, 'controls'), {
    ...data,
    open: data.open ?? false,
    createdAt: serverTimestamp()
  });
  return ref.id;
}

export async function updateControl(cid, ctrlId, data) {
  await updateDoc(doc(db, 'competitions', cid, 'controls', ctrlId), data);
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
