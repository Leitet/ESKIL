// Small helpers used across the app.

export const AVDELNINGAR = [
  { key: 'Spårare',    short: 'sp', range: '8–10 år',    color: 'var(--spaer-green)'  },
  { key: 'Upptäckare', short: 'up', range: '10–12 år',   color: 'var(--upp-blue)'      },
  { key: 'Äventyrare', short: 'av', range: '12–15 år',   color: 'var(--avent-orange)' },
  { key: 'Utmanare',   short: 'ut', range: '15–18 år',   color: 'var(--utm-pink)'      },
  { key: 'Rover',      short: 'ro', range: '19–25 år',   color: 'var(--rover-yellow)' },
  { key: 'Ledare',     short: 'le', range: '18+',         color: 'var(--black)'         }
];

// Default role presets for new competitions.
export const DEFAULT_MANAGEMENT_ROLES = [
  { id: 'leader',        label: 'Tävlingsledare', visibility: 'public'   },
  { id: 'registrations', label: 'Anmälningar',    visibility: 'public'   },
  { id: 'secretariat',   label: 'Sekretariat',    visibility: 'internal' }
];

function randId() {
  return 'r-' + Math.random().toString(36).slice(2, 10);
}

// Normalize management into a canonical array — handles legacy object-form
// from before we introduced visibility + custom roles.
export function normalizeManagement(comp, { seedDefaults = false } = {}) {
  const raw = comp?.management;
  if (Array.isArray(raw)) {
    return raw.map(r => ({
      id: r.id || randId(),
      label: r.label || '',
      visibility: r.visibility === 'internal' ? 'internal' : 'public',
      name: r.name || '',
      phone: r.phone || '',
      email: r.email || ''
    }));
  }
  if (raw && typeof raw === 'object') {
    // Legacy: { leader: {...}, registrations: {...}, secretariat: {...} }
    return DEFAULT_MANAGEMENT_ROLES.map(d => ({
      id: d.id,
      label: d.label,
      visibility: d.visibility,
      name: raw[d.id]?.name  || '',
      phone: raw[d.id]?.phone || '',
      email: raw[d.id]?.email || ''
    }));
  }
  return seedDefaults
    ? DEFAULT_MANAGEMENT_ROLES.map(d => ({
        id: d.id, label: d.label, visibility: d.visibility,
        name: '', phone: '', email: ''
      }))
    : [];
}

// Any role with actual contact info filled in.
export function activeManagement(comp) {
  return normalizeManagement(comp)
    .filter(r => (r.name || '').trim() || (r.email || '').trim() || (r.phone || '').trim());
}

// Roles visible on startkort + publika sidan.
export function publicManagement(comp) {
  return activeManagement(comp).filter(r => (r.visibility || 'public') === 'public');
}

// Roles visible on the control report card (reporter page). Shows everything
// active — internal roles are exclusive to this surface, public roles also
// show here for completeness so control runners reach any contact.
export function internalManagement(comp) {
  return activeManagement(comp);
}

export function avdShort(avd) {
  const a = AVDELNINGAR.find(x => x.key === avd);
  return a ? a.short : 'le';
}

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    }
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function toast(msg, kind = '') {
  const wrap = document.getElementById('toasts') || document.body;
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; }, 2600);
  setTimeout(() => t.remove(), 3000);
}

export function confirmDialog(message) {
  return new Promise(resolve => {
    const overlay = el('div', { class: 'modal-overlay' });
    const modal = el('div', { class: 'modal' });
    modal.innerHTML = `
      <div class="modal-head"><h3>Bekräfta</h3></div>
      <div class="modal-body">${escapeHtml(message)}</div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-cancel>Avbryt</button>
        <button class="btn btn-danger" data-ok>Ta bort</button>
      </div>`;
    overlay.appendChild(modal);
    overlay.addEventListener('click', e => {
      if (e.target === overlay) { overlay.remove(); resolve(false); }
    });
    modal.querySelector('[data-cancel]').onclick = () => { overlay.remove(); resolve(false); };
    modal.querySelector('[data-ok]').onclick = () => { overlay.remove(); resolve(true); };
    document.body.appendChild(overlay);
  });
}

export function formatDate(ts) {
  if (!ts) return '—';
  const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('sv-SE', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatTime(ts) {
  if (!ts) return '—';
  const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch {}
  ta.remove();
  return Promise.resolve();
}

export function reportUrl(competitionId, controlId) {
  return `${location.origin}/k/${competitionId}/${controlId}`;
}

export function startUrl(competitionId, patrolId) {
  return `${location.origin}/s/${competitionId}/${patrolId}`;
}

// --- Ranking rules (delad placering vid total tie) --------------------------
// 1. Totalpoäng (poang + extraPoang)
// 2. Högst ordningspoäng (summa extraPoang)
// 3. Flest kontroller där patrullen slog kontrollens maxpoäng
// Om alla tre är lika → delad placering.
export const RANKING_RULES_TEXT = [
  { title: 'Totalpoäng',                rule: 'Summan av kontrollpoäng och ordningspoäng.' },
  { title: 'Högst ordningspoäng',       rule: 'Vid lika totalpoäng jämförs extrapoängen.' },
  { title: 'Flest maxade kontroller',   rule: 'Vid lika ordningspoäng: den som tagit full maxpoäng på flest kontroller.' },
  { title: 'Delad placering',           rule: 'Går det inte att avgöra efter detta får de inblandade dela på platsen.' }
];

// Rank an array of "total" rows. Each row must have: grand, extra, perControl
// (ctrlId → score doc). `controls` supplies each control's maxPoang. Returns
// a new array with { ...row, rank, maxedCount } sorted by the three rules.
export function rankPatrols(totals, controls) {
  const ctrlMax = Object.fromEntries(controls.map(c => [c.id, Number(c.maxPoang) || 0]));
  const enriched = totals.map(r => {
    let maxedCount = 0;
    for (const [ctrlId, s] of Object.entries(r.perControl || {})) {
      const max = ctrlMax[ctrlId];
      if (max > 0 && (Number(s.poang) || 0) >= max) maxedCount++;
    }
    return { ...r, maxedCount };
  });
  enriched.sort((a, b) => {
    if ((b.grand || 0) !== (a.grand || 0)) return (b.grand || 0) - (a.grand || 0);
    if ((b.extra || 0) !== (a.extra || 0)) return (b.extra || 0) - (a.extra || 0);
    if ((b.maxedCount || 0) !== (a.maxedCount || 0)) return (b.maxedCount || 0) - (a.maxedCount || 0);
    return 0;
  });
  // Standard competition ranking (1, 2, 2, 4): tied rows share rank.
  let prev = null, prevRank = 0;
  enriched.forEach((r, i) => {
    const tied = prev
      && (r.grand       || 0) === (prev.grand       || 0)
      && (r.extra       || 0) === (prev.extra       || 0)
      && (r.maxedCount  || 0) === (prev.maxedCount  || 0);
    r.rank = tied ? prevRank : i + 1;
    if (!tied) prevRank = i + 1;
    prev = r;
  });
  return enriched;
}

// Same tiebreaker logic applied to kår-aggregated rows. Each row must carry
// `grand`, `extra`, and a pre-computed `maxedCount` (sum across the kår's
// patrols).
export function rankKarer(rows) {
  const arr = rows.slice().sort((a, b) => {
    if ((b.grand || 0) !== (a.grand || 0)) return (b.grand || 0) - (a.grand || 0);
    if ((b.extra || 0) !== (a.extra || 0)) return (b.extra || 0) - (a.extra || 0);
    if ((b.maxedCount || 0) !== (a.maxedCount || 0)) return (b.maxedCount || 0) - (a.maxedCount || 0);
    return 0;
  });
  let prev = null, prevRank = 0;
  arr.forEach((r, i) => {
    const tied = prev
      && (r.grand      || 0) === (prev.grand      || 0)
      && (r.extra      || 0) === (prev.extra      || 0)
      && (r.maxedCount || 0) === (prev.maxedCount || 0);
    r.rank = tied ? prevRank : i + 1;
    if (!tied) prevRank = i + 1;
    prev = r;
  });
  return arr;
}

// Resolve starttime settings on a competition. Shape:
//   competitions/{cid}.startTimes = {
//     enabled, mode: 'interval' | 'range',
//     firstStart: "HH:MM",
//     intervalMinutes: number,   // used when mode='interval'
//     lastStart: "HH:MM"          // used when mode='range'
//   }
export function startTimeSettings(comp) {
  const s = comp?.startTimes || {};
  return {
    enabled: !!s.enabled,
    mode: s.mode === 'range' ? 'range' : 'interval',
    firstStart: s.firstStart || '09:00',
    intervalMinutes: Number(s.intervalMinutes) || 5,
    lastStart: s.lastStart || null
  };
}

// Effective seconds between patrol starts. In interval mode this is just
// intervalMinutes × 60. In range mode it's derived from (lastStart - firstStart)
// / (N - 1), with an over-midnight wrap: if lastStart ≤ firstStart we add 24 h
// so a competition that runs 22:00 → 02:00 works correctly.
export function effectiveIntervalSec(comp, totalPatrols) {
  const s = startTimeSettings(comp);
  if (s.mode === 'range' && s.lastStart && totalPatrols >= 2) {
    const toMin = (t) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    const first = toMin(s.firstStart);
    let last = toMin(s.lastStart);
    if (!Number.isFinite(first) || !Number.isFinite(last)) return s.intervalMinutes * 60;
    if (last <= first) last += 24 * 60;             // rolls past midnight
    return ((last - first) * 60) / (totalPatrols - 1);
  }
  return s.intervalMinutes * 60;
}

// Resolve the competition's start and finish points, normalizing legacy data.
// Returns an array of 1 or 2 entries — use .length to decide whether start and
// finish share the same marker ("S/M") or show two ("S" and "M").
//
//   startFinish legacy:    { enabled, name, lat, lng }
//   startFinish new same:  { enabled, mode:'same',    start: {...} }
//   startFinish new split: { enabled, mode:'separate', start:{...}, finish:{...} }
export function startFinishPoints(comp) {
  const sf = comp?.startFinish;
  if (!sf?.enabled) return [];
  const start = sf.start
    ?? (Number.isFinite(sf.lat) ? { name: sf.name, lat: sf.lat, lng: sf.lng } : null);
  if (!start || !Number.isFinite(start.lat) || !Number.isFinite(start.lng)) return [];

  if (sf.mode === 'separate'
    && sf.finish
    && Number.isFinite(sf.finish.lat)
    && Number.isFinite(sf.finish.lng)) {
    return [
      { ...start,      kind: 'start',  label: 'S',   title: 'Start' },
      { ...sf.finish,  kind: 'finish', label: 'M',   title: 'Mål'   }
    ];
  }
  return [{ ...start, kind: 'startfinish', label: 'S/M', title: 'Start / Mål' }];
}

// Resolve the competition's parking location, if configured. Returns a
// point-like object compatible with the start/finish shape used on maps.
export function parkingPoint(comp) {
  const p = comp?.parking;
  if (!p?.enabled) return null;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null;
  return {
    kind: 'parking',
    label: 'P',
    title: 'Parkering',
    name: p.name || 'Parkering',
    lat: p.lat,
    lng: p.lng,
    note: p.note || ''
  };
}

// Full Date for a patrol's start moment, anchored on TODAY + firstStart +
// startOrder × effectiveInterval. Pass `totalPatrols` for range mode so the
// derived interval is correct. Anchored on the wall clock (not comp.date) so
// demos + countdowns work on any day.
export function patrolStartDateTime(comp, patrol, today = new Date(), totalPatrols = null) {
  const s = startTimeSettings(comp);
  if (!s.enabled) return null;
  const idx = Number(patrol?.startOrder);
  if (!Number.isFinite(idx)) return null;
  const [h, m] = s.firstStart.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  base.setHours(h, m, 0, 0);
  base.setSeconds(base.getSeconds() + idx * effectiveIntervalSec(comp, totalPatrols));
  return base;
}

// Compute the derived start time for a patrol given its startOrder (0-based).
// Returns "HH:MM" or null if start times are disabled or inputs invalid.
export function patrolStartTime(comp, patrol, totalPatrols = null) {
  const d = patrolStartDateTime(comp, patrol, new Date(), totalPatrols);
  if (!d) return null;
  return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}

// Pick the instruction text that applies to an avdelning.
// Returns { text, avdelningar } — falls back to the default (empty avdelningar) group.
// Legacy controls with a plain `information` string are treated as a single default group.
export function pickInstruction(control, avdelning) {
  const groups = Array.isArray(control?.instructions) && control.instructions.length
    ? control.instructions
    : (control?.information ? [{ avdelningar: [], text: control.information }] : []);
  if (!groups.length) return { text: '', avdelningar: [] };
  if (avdelning) {
    const specific = groups.find(g => (g.avdelningar || []).includes(avdelning));
    if (specific) return specific;
  }
  const fallback = groups.find(g => !g.avdelningar || g.avdelningar.length === 0) || groups[0];
  return fallback;
}

export function allInstructionGroups(control) {
  return Array.isArray(control?.instructions) && control.instructions.length
    ? control.instructions
    : (control?.information ? [{ avdelningar: [], text: control.information }] : []);
}

// Put a button into a disabled + spinner "busy" state while an async action
// runs. Returns a `reset()` to call in a finally block to restore.
export function busyButton(btn, label = 'Sparar…') {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.dataset.busy = '1';
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${label}</span>`;
  return () => {
    btn.disabled = false;
    delete btn.dataset.busy;
    btn.innerHTML = original;
  };
}

// Convenience: wrap an async handler so we never double-submit and the button
// always resets, even on failure.
export async function withBusy(btn, label, fn) {
  if (btn.disabled) return;
  const reset = busyButton(btn, label);
  try { return await fn(); }
  finally { reset(); }
}
