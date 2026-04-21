// Firestore data access layer. Keeps queries in one place.

import {
  db, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs, onSnapshot, query, where, orderBy,
  serverTimestamp, writeBatch
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
    await setDoc(ref, {
      email,
      role: isBootstrapSuper ? 'super-admin' : 'user',
      createdAt: serverTimestamp()
    });
    return { email, role: isBootstrapSuper ? 'super-admin' : 'user' };
  }
  return snap.data();
}

export async function getUser(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// --- Competitions ----------------------------------------------------------

export async function listCompetitionsForUser(user) {
  const snap = await getDocs(collection(db, 'competitions'));
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (user.role === 'super-admin') return all;
  // Everyone can see demo competitions; otherwise only ones they belong to.
  return all.filter(c =>
    c.demo === true ||
    (c.admins || []).includes(user.uid) ||
    (c.users || []).includes(user.uid)
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

export async function deleteCompetition(cid) {
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

export async function upsertScore(cid, ctrlId, patrolId, poang, extraPoang, note, reporter) {
  // One score per patrol per control. Use patrolId as the doc id to keep it unique.
  const ref = doc(db, 'competitions', cid, 'controls', ctrlId, 'scores', patrolId);
  await setDoc(ref, {
    patrolId,
    poang: Number(poang) || 0,
    extraPoang: Number(extraPoang) || 0,
    note: note || '',
    reportedAt: serverTimestamp(),
    reporter: reporter || ''
  });
}

export async function deleteScore(cid, ctrlId, scoreId) {
  await deleteDoc(doc(db, 'competitions', cid, 'controls', ctrlId, 'scores', scoreId));
}
