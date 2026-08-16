// Backup, restore and ZIP export for a competition.
//
// Backup  = one JSON file with the complete competition (doc + every
//           subcollection) that importCompetitionBackup can read back to
//           recreate the competition — same subcollection doc ids, so old
//           QR reporter links and startkort links keep working.
// Export  = a ZIP (JSZip via CDN) with the backup JSON plus CSV files for
//           results, patrols, controls and registrations, and a README.
//
// Import never re-triggers mail: registrations and controls are written
// with `imported: true`, which the Cloud Function triggers skip on create.
// Utskick history is included in the backup file for the archive but is
// NOT recreated on import — restoring it would fan the PM out again.

import {
  db, doc, collection, getDocs, setDoc, writeBatch
} from './firebase.js';
import {
  getCompetition, listPatrols, listControls, listAllScores, listRegistrations,
  listStations, listUtskick, getTrack, createCompetition,
  getControlMeta, getPatrolMeta, setControlMeta, setPatrolMeta,
  listSelfPassages, getHandover
} from './store.js';
import { rankPatrols } from './utils.js';

// v2 adds control/patrol private meta (telefon, notering). Imports still
// accept v1 dumps (they simply carry no meta).
// v3 adds selfPassages (patrullernas egna start-/målstämplar) and the
// handover document. Båda raderas av deleteCompetition, och sedan
// raderingsskyddet KRÄVER en färsk backup är det backupen som avgör om de
// går att få tillbaka. Imports still accept v1/v2 dumps.
export const BACKUP_VERSION = 3;

// --- Timestamp-safe (de)serialization -----------------------------------------

function toPlain(v) {
  if (v == null) return v;
  if (typeof v.toDate === 'function') return { __ts: v.toDate().toISOString() };
  if (Array.isArray(v)) return v.map(toPlain);
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = toPlain(x);
    return o;
  }
  return v;
}

function revive(v) {
  if (v == null) return v;
  if (typeof v === 'object' && typeof v.__ts === 'string' && Object.keys(v).length === 1) {
    return new Date(v.__ts);
  }
  if (Array.isArray(v)) return v.map(revive);
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = revive(x);
    return o;
  }
  return v;
}

// --- Dump ----------------------------------------------------------------------

async function listPassages(cid, stationId) {
  const snap = await getDocs(collection(db, 'competitions', cid, 'stations', stationId, 'passages'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function dumpCompetition(cid) {
  const [comp, patrols, controls, scores, registrations, stations, utskick, track,
         selfPassages, handover] = await Promise.all([
    getCompetition(cid),
    listPatrols(cid),
    listControls(cid),
    listAllScores(cid),
    listRegistrations(cid).catch(() => []),
    listStations(cid).catch(() => []),
    listUtskick(cid).catch(() => []),
    getTrack(cid).catch(() => null),
    listSelfPassages(cid).catch(() => []),
    getHandover(cid).catch(() => null)
  ]);
  if (!comp) throw new Error('Tävlingen hittades inte.');

  const scoresByCtrl = {};
  for (const s of scores) (scoresByCtrl[s.controlId] ||= []).push(s);

  const stationsFull = [];
  for (const st of stations) {
    stationsFull.push({ ...st, passages: await listPassages(cid, st.id).catch(() => []) });
  }

  // Private meta (telefon, notering) lives in subdocs — fetch it so the
  // backup is complete and a restore doesn't silently drop it.
  const ctrlMetas = await Promise.all(controls.map(c => getControlMeta(cid, c.id).catch(() => ({}))));
  const patrolMetas = await Promise.all(patrols.map(p => getPatrolMeta(cid, p.id).catch(() => ({}))));

  const { id, ...compData } = comp;
  return toPlain({
    eskilBackup: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    sourceCid: cid,
    competition: compData,
    patrols: patrols.map((p, i) => ({ ...p, _private: patrolMetas[i] || {} })),
    controls: controls.map((c, i) => ({
      ...c,
      _private: ctrlMetas[i] || {},
      scores: (scoresByCtrl[c.id] || []).map(({ controlId, ...s }) => s)
    })),
    registrations,
    stations: stationsFull,
    utskick,
    track,
    selfPassages,
    handover
  });
}

// --- Restore ---------------------------------------------------------------------

async function batchSet(refs) {
  for (let i = 0; i < refs.length; i += 400) {
    const batch = writeBatch(db);
    refs.slice(i, i + 400).forEach(([ref, data]) => batch.set(ref, data));
    await batch.commit();
  }
}

// Recreates the competition from a backup dump as a NEW competition (new
// competition id — the old one may still exist). Subcollection doc ids are
// preserved so reporter/startkort/station links and the track keep working.
export async function importCompetitionBackup(rawDump, user) {
  const dump = revive(rawDump);
  if (!dump || !dump.eskilBackup || dump.eskilBackup > BACKUP_VERSION || !dump.competition) {
    throw new Error('Filen är inte en giltig ESKIL-backup.');
  }

  const compData = { ...dump.competition };
  delete compData.admins; delete compData.createdBy; delete compData.createdAt;
  compData.demo = false; // a restored copy must never be the protected demo
  const newCid = await createCompetition(compData, user);

  const writes = [];
  const metaWrites = []; // [kind, id, meta] — written to private subdocs after
  for (const p of dump.patrols || []) {
    // Strip private meta (v2 `_private`, and any legacy `notering` that older
    // dumps stored on the doc) — it must land in the subdoc, not the doc.
    const { id, _private, notering, ...data } = p;
    writes.push([doc(db, 'competitions', newCid, 'patrols', id), data]);
    const meta = { ...(_private || {}) };
    if (notering !== undefined && meta.notering === undefined) meta.notering = notering;
    if (Object.keys(meta).length) metaWrites.push(['patrol', id, meta]);
  }
  for (const c of dump.controls || []) {
    // Strip member-only fields (v2 `_private`, plus any legacy telefon/notering/
    // ansvariga older dumps kept on the doc) — they belong in the meta subdoc.
    const { id, scores, _private, telefon, notering, ansvariga, ansvarigaEmails, ...data } = c;
    writes.push([doc(db, 'competitions', newCid, 'controls', id), { ...data, imported: true }]);
    for (const s of scores || []) {
      const { id: sid, ...sdata } = s;
      writes.push([doc(db, 'competitions', newCid, 'controls', id, 'scores', sid), sdata]);
    }
    const meta = { ...(_private || {}) };
    if (telefon !== undefined && meta.telefon === undefined) meta.telefon = telefon;
    if (notering !== undefined && meta.notering === undefined) meta.notering = notering;
    if (ansvariga !== undefined && meta.ansvariga === undefined) meta.ansvariga = ansvariga;
    if (ansvarigaEmails !== undefined && meta.ansvarigaEmails === undefined) meta.ansvarigaEmails = ansvarigaEmails;
    if (Object.keys(meta).length) metaWrites.push(['control', id, meta]);
  }
  for (const r of dump.registrations || []) {
    const { id, ...data } = r;
    writes.push([doc(db, 'competitions', newCid, 'registrations', id), { ...data, imported: true }]);
  }
  for (const st of dump.stations || []) {
    const { id, passages, ...data } = st;
    writes.push([doc(db, 'competitions', newCid, 'stations', id), data]);
    for (const pa of passages || []) {
      const { id: pid, ...pdata } = pa;
      writes.push([doc(db, 'competitions', newCid, 'stations', id, 'passages', pid), pdata]);
    }
  }
  // Patrullernas egna start-/målstämplar. Doc-id ÄR patrolId, precis som i
  // originalet, så Läget och stationssidan hittar dem direkt.
  for (const sp of dump.selfPassages || []) {
    const { id, ...data } = sp;
    writes.push([doc(db, 'competitions', newCid, 'selfPassages', id), data]);
  }
  await batchSet(writes);

  // Private meta subdocs (telefon, notering) — written after the parent docs.
  for (const [kind, id, meta] of metaWrites) {
    if (kind === 'control') await setControlMeta(newCid, id, meta);
    else await setPatrolMeta(newCid, id, meta);
  }

  if (dump.track) {
    await setDoc(doc(db, 'competitions', newCid, 'track', 'main'), dump.track);
  }
  if (dump.handover) {
    await setDoc(doc(db, 'competitions', newCid, 'private', 'handover'), dump.handover);
  }
  return newCid;
}

// --- Downloads -------------------------------------------------------------------

function stem(comp) {
  return `${(comp.shortName || comp.name || 'tavling')}-${comp.year || ''}`
    .toLowerCase().replace(/[^a-z0-9åäö]+/gi, '-').replace(/^-|-$/g, '');
}

function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function downloadBackup(cid) {
  const dump = await dumpCompetition(cid);
  saveBlob(
    new Blob([JSON.stringify(dump, null, 1)], { type: 'application/json' }),
    `eskil-backup-${stem(dump.competition)}.json`
  );
  return dump;
}

// --- ZIP export --------------------------------------------------------------------

let jszipReady = null;
function ensureJsZip() {
  if (jszipReady) return jszipReady;
  jszipReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
    s.integrity = 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG';
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve(window.JSZip);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return jszipReady;
}

const csvCell = (v) => {
  // Neutralise spreadsheet formula injection: a cell that starts with = + - @
  // (or TAB/CR) is treated as a formula by Excel/LibreOffice even when quoted.
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replaceAll('"', '""')}"`;
};
const csvFile = (rows) => '﻿' + rows.map(r => r.join(';')).join('\r\n');

export async function downloadExportZip(cid) {
  const JSZip = await ensureJsZip();
  const dump = await dumpCompetition(cid);
  const comp = dump.competition;
  const zip = new JSZip();

  zip.file('backup.json', JSON.stringify(dump, null, 1));

  // Resultat
  const scores = (dump.controls || []).flatMap(c => (c.scores || []).map(s => ({ ...s, controlId: c.id })));
  const totalsMap = {};
  for (const p of dump.patrols || []) totalsMap[p.id] = { ...p, total: 0, extra: 0, count: 0, perControl: {} };
  for (const s of scores) {
    const row = totalsMap[s.patrolId]; if (!row) continue;
    row.total += Number(s.poang) || 0; row.extra += Number(s.extraPoang) || 0;
    row.count += 1; row.perControl[s.controlId] = s;
  }
  Object.values(totalsMap).forEach(r => { r.grand = r.total + r.extra; });
  const ranked = rankPatrols(Object.values(totalsMap), dump.controls || []);
  zip.file('resultat.csv', csvFile([
    ['Placering', 'Patrull', 'Nummer', 'Avdelning', 'Kår', 'Kontroller', 'Poäng', 'Extrapoäng', 'Totalpoäng'],
    ...ranked.map(r => [r.rank, csvCell(r.name), r.number ?? '', csvCell(r.avdelning), csvCell(r.kar), r.count, r.total, r.extra, r.grand])
  ]));

  zip.file('patruller.csv', csvFile([
    ['Nummer', 'Namn', 'Avdelning', 'Kår', 'Antal', 'Notering'],
    ...(dump.patrols || []).map(p => [p.number ?? '', csvCell(p.name), csvCell(p.avdelning), csvCell(p.kar), p.antal ?? '', csvCell(p._private?.notering)])
  ]));

  zip.file('kontroller.csv', csvFile([
    ['Nummer', 'Namn', 'Max', 'Min', 'Extra', 'Lat', 'Lng', 'Placering', 'Rapporter'],
    ...(dump.controls || []).map(c => [c.nummer ?? '', csvCell(c.name), c.maxPoang ?? '', c.minPoang ?? '', c.extraPoang ?? '', c.lat ?? '', c.lng ?? '', csvCell(c.placement), (c.scores || []).length])
  ]));

  if ((dump.registrations || []).length) {
    zip.file('anmalningar.csv', csvFile([
      ['Kår', 'Kontakt', 'E-post', 'Patruller', 'Scouter', 'Belopp', 'Betalt', 'Avanmäld'],
      ...dump.registrations.map(r => {
        const total = (r.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
        const paid = (r.payments || []).filter(p => p.paid).reduce((s, p) => s + (Number(p.amount) || 0), 0);
        return [csvCell(r.kar), csvCell(r.contact?.name), csvCell(r.contact?.email),
          (r.patrols || []).length, (r.patrols || []).reduce((s, p) => s + (Number(p.antal) || 0), 0),
          total, paid, r.cancelled ? 'Ja' : ''];
      })
    ]));
  }

  zip.file('README.txt',
`ESKIL-export: ${comp.name || ''} ${comp.year || ''}
Exporterad: ${new Date().toLocaleString('sv-SE')}

backup.json     Komplett säkerhetskopia. Kan läsas tillbaka i ESKIL via
                Inställningar → Grund → "Importera backup" och återskapar
                tävlingen med patruller, kontroller, poäng, anmälningar,
                spår och stationer (samma interna länkar).
resultat.csv    Slutresultat med placeringar (semikolonseparerad, UTF-8).
patruller.csv   Patrullistan.
kontroller.csv  Kontrollerna med poängsättning och positioner.
anmalningar.csv Anmälningarna med betalstatus (om tävlingen haft anmälan).
`);

  const blob = await zip.generateAsync({ type: 'blob' });
  saveBlob(blob, `eskil-export-${stem(comp)}.zip`);
}
