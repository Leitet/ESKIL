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

export function removeFromQueue(cid, ctrlId, patrolId) {
  const arr = load(cid, ctrlId).filter(x => x.patrolId !== patrolId);
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

// Try to flush the queue for (cid, ctrlId). For each queued item, invoke
// syncOne(item) — if it resolves, remove the item from the queue and call
// onSynced(item). If it rejects, the item stays queued and we stop (since a
// connectivity failure for one item will fail the rest too).
export async function flushQueue(cid, ctrlId, syncOne, { onSynced, timeoutMs = 6000 } = {}) {
  const items = load(cid, ctrlId);
  const synced = [];
  for (const item of items) {
    try {
      await withTimeout(syncOne(item), timeoutMs);
      removeFromQueue(cid, ctrlId, item.patrolId);
      synced.push(item);
      onSynced?.(item);
    } catch {
      break;
    }
  }
  return synced;
}
