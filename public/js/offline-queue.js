// Offline-first score queue for the reporter page.
//
// Every rapport is queued in localStorage *before* we try to send it to
// Firestore — so even if the network dies mid-save (or the browser is killed
// before the write lands), the score survives until it syncs.
//
// Queue key is scoped per (competition, control) because the reporter URL is
// per-control and that mirrors device usage: one person at one control with
// one browser tab.
//
// Writes via upsertScore are idempotent (the doc id is the patrolId) so
// retrying on reconnect can never create duplicates or clobber a later
// legitimate write — "latest savedAt wins" is effectively enforced by the
// Firestore document id plus the reportedAt timestamp.

const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // pending items older than a week get dropped

function keyFor(cid, ctrlId) {
  return `eskil:pending-scores:${cid}:${ctrlId}`;
}

function load(cid, ctrlId) {
  try {
    const raw = localStorage.getItem(keyFor(cid, ctrlId));
    const arr = raw ? JSON.parse(raw) : [];
    // Prune ancient entries — a week-old offline report is almost certainly
    // stale data that would do more harm than good if it suddenly synced.
    const cutoff = Date.now() - PENDING_TTL_MS;
    return arr.filter(x => (x.queuedAt || 0) > cutoff);
  } catch {
    return [];
  }
}

function save(cid, ctrlId, arr) {
  try { localStorage.setItem(keyFor(cid, ctrlId), JSON.stringify(arr)); } catch {}
}

export function enqueue(cid, ctrlId, item) {
  const arr = load(cid, ctrlId);
  const i = arr.findIndex(x => x.patrolId === item.patrolId);
  const entry = { ...item, queuedAt: Date.now() };
  if (i >= 0) arr[i] = entry; else arr.push(entry);
  save(cid, ctrlId, arr);
  return entry;
}

// Remove a queued item. When `queuedAt` is given, only that exact entry is
// removed — so a flush that finishes AFTER the user queued a NEWER report for
// the same patrol can't delete the newer entry (which would silently lose it).
export function removeFromQueue(cid, ctrlId, patrolId, queuedAt = null) {
  const arr = load(cid, ctrlId).filter(x =>
    !(x.patrolId === patrolId && (queuedAt == null || x.queuedAt === queuedAt))
  );
  save(cid, ctrlId, arr);
}

export function listQueue(cid, ctrlId) {
  return load(cid, ctrlId);
}

export function isPending(cid, ctrlId, patrolId) {
  return load(cid, ctrlId).some(x => x.patrolId === patrolId);
}

// Wrap a promise with a timeout — Firestore setDoc() returns a promise that
// does not resolve while offline, so a timeout is our only way to know we
// should fall back to the local queue.
export function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('offline-timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); },
           e => { clearTimeout(t); reject(e); });
  });
}

// Firestore errors that will never succeed on retry — e.g. the control was
// closed while the report sat in the queue (rules reject with
// permission-denied). Keeping such an item queued would block every later
// report behind it, forever, while the UI showed "Synkar…".
export function isPermanentError(e) {
  return ['permission-denied', 'invalid-argument', 'not-found', 'failed-precondition']
    .includes(e?.code);
}

// Try to flush the queue for (cid, ctrlId). For each queued item, invoke
// syncOne(item):
//  - resolves            → remove from queue, report in `synced`
//  - permanent rejection → remove from queue, report in `failed` (the caller
//                          must tell the user — this is lost data otherwise)
//  - other rejection     → connectivity: item stays queued, stop (the rest
//                          would fail the same way)
export async function flushQueue(cid, ctrlId, syncOne, { onSynced, timeoutMs = 6000 } = {}) {
  const items = load(cid, ctrlId);
  const synced = [];
  const failed = [];
  for (const item of items) {
    // `items` är en ögonblicksbild från flushens start. Har en direktsparning
    // (report.js) eller en nyare rapport hunnit ersätta eller ta bort just den
    // här posten sedan dess, får den INTE skickas: en förlegad poäng som landar
    // efter en färsk rättelse skriver över den (setDoc är ovillkorlig). Läs om
    // den aktuella kön och matcha på (patrolId, queuedAt) precis före sändning.
    const stillQueued = load(cid, ctrlId)
      .some(x => x.patrolId === item.patrolId && x.queuedAt === item.queuedAt);
    if (!stillQueued) continue;
    try {
      await withTimeout(syncOne(item), timeoutMs);
      removeFromQueue(cid, ctrlId, item.patrolId, item.queuedAt);
      synced.push(item);
      onSynced?.(item);
    } catch (e) {
      if (isPermanentError(e)) {
        removeFromQueue(cid, ctrlId, item.patrolId, item.queuedAt);
        failed.push({ item, error: e });
        continue;
      }
      break;
    }
  }
  return { synced, failed };
}
