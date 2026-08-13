// ESKIL — Start/Mål-station.
// URL pattern: /m/<competitionId>/<stationId>   (stationId is the secret)
//
// The station crew checks patrols OUT at start and IN at mål, one tap per
// patrol, with server timestamps. This feeds the "Läget" dashboard so the
// secretariat always knows who is still out in the woods.

import { db, doc, onSnapshot } from './firebase.js';
import { getCompetition, getStation, listPatrols, watchPassages, setPassage, listControls, getTrack } from './store.js';
import { escapeHtml, toast, confirmDialog, patrolStartTime, patrolStartDateTime, avdShort } from './utils.js';
import { bindTap } from './haptic.js';
import { updateBroadcast } from './broadcast.js';
import { courseEta } from './course.js';

const root = document.getElementById('root');

function parsePath() {
  const parts = location.pathname.split('/').filter(Boolean); // ['m', cid, stationId]
  if (parts[0] !== 'm' || !parts[1] || !parts[2]) return null;
  return { cid: parts[1], stationId: parts[2] };
}

let comp = null;
let patrols = [];
let passages = {};      // patrolId -> passage doc
let mode = 'start';     // 'start' | 'mal'
let cid = null, stationId = null;
let finishMin = null;   // hela banans ETA i minuter (gångtid + stationstid)

function fmtClock(ts) {
  if (!ts) return '';
  const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}

// Demospår: pin the clock to the newest passage timestamp (+5 min) so the
// planned start times roll in step with the frozen seeded snapshot instead
// of the wall clock (see the demo branch of patrolStartDateTime).
function virtualNow() {
  if (!comp?.demo) return new Date();
  let max = null;
  for (const p of Object.values(passages)) {
    for (const ts of [p.startAt, p.finishAt]) {
      if (!ts) continue;
      const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
      if (!max || d > max) max = d;
    }
  }
  return max ? new Date(max.getTime() + 5 * 60000) : new Date();
}

async function main() {
  const parsed = parsePath();
  if (!parsed) return renderError('Ogiltig länk.');
  ({ cid, stationId } = parsed);

  let station;
  try {
    [comp, station, patrols] = await Promise.all([
      getCompetition(cid),
      getStation(cid, stationId),
      listPatrols(cid)
    ]);
  } catch (e) {
    return renderError('Kunde inte ladda: ' + e.message);
  }
  if (!comp) return renderError('Tävlingen hittades inte.');
  if (!station) return renderError('Stationen hittades inte. Kontrollera länken.');

  document.title = `Start/Mål · ${comp.shortName || comp.name || 'ESKIL'}`;

  // Driftmeddelanden från ledningen — stationen följer funktionärskanalen.
  const bctx = { audience: 'kontroller' };
  onSnapshot(doc(db, 'competitions', cid), snap => {
    if (!snap.exists()) return;
    comp = { id: cid, ...snap.data() };
    updateBroadcast(comp, bctx);
  });
  updateBroadcast(comp, bctx);

  watchPassages(cid, stationId, rows => {
    passages = {};
    rows.forEach(p => { passages[p.id] = p; });
    render();
  });

  render();
  // "Sen till start" är tidsbaserat — uppdatera markeringarna var 30:e sekund.
  setInterval(render, 30000);

  // ETA-motorn i bakgrunden: banans gångtid + stationstid ger "mål ca HH:MM"
  // per patrull ute i skogen. Kräver placerade kontroller — annars visas inget.
  (async () => {
    try {
      const [controls, track] = await Promise.all([
        listControls(cid),
        getTrack(cid).catch(() => null)
      ]);
      const eta = courseEta(comp, controls, track);
      if (eta.finishMin != null && eta.totalDist > 0) { finishMin = eta.finishMin; render(); }
    } catch { /* ETA är en bonus — aldrig ett fel */ }
  })();
}

// Beräknad målgång (ms-epok) för en patrull som är ute: faktisk starttid +
// hela banans ETA. null när ETA saknas eller patrullen inte är ute.
function etaFinishMs(p) {
  if (finishMin == null) return null;
  const pass = passages[p.id] || {};
  if (!pass.startAt || pass.finishAt) return null;
  const d = typeof pass.startAt.toDate === 'function' ? pass.startAt.toDate() : new Date(pass.startAt);
  return d.getTime() + finishMin * 60000;
}

function statusOf(p) {
  const pass = passages[p.id] || {};
  if (pass.finishAt) return 'finished';
  if (pass.startAt) return 'out';
  return 'waiting';
}

// Sen till start: planerad tid passerad ≥3 min utan utcheckning.
function lateToStartMin(p) {
  const pass = passages[p.id] || {};
  if (pass.startAt) return 0;
  const plannedAt = patrolStartDateTime(comp, p, virtualNow(), patrols.length);
  if (!plannedAt) return 0;
  const min = Math.floor((virtualNow() - plannedAt) / 60000);
  return min >= 3 ? min : 0;
}

function render() {
  const sorted = [...patrols].sort((a, b) => (a.startOrder ?? a.number ?? 0) - (b.startOrder ?? b.number ?? 0));
  const counts = { waiting: 0, out: 0, finished: 0 };
  sorted.forEach(p => { counts[statusOf(p)]++; });
  const lateCount = sorted.filter(p => lateToStartMin(p) > 0).length;

  // Målfliken sorterar som en ute-lista: de som väntas först ligger överst,
  // sedan ej startade, sist redan incheckade. Startfliken behåller startordning.
  let display = sorted;
  if (mode === 'mal' && finishMin != null) {
    const rank = { out: 0, waiting: 1, finished: 2 };
    display = [...sorted].sort((a, b) => {
      const ra = rank[statusOf(a)], rb = rank[statusOf(b)];
      if (ra !== rb) return ra - rb;
      if (ra === 0) {
        const ea = etaFinishMs(a) ?? Infinity, eb = etaFinishMs(b) ?? Infinity;
        if (ea !== eb) return ea - eb;
      }
      return (a.startOrder ?? a.number ?? 0) - (b.startOrder ?? b.number ?? 0);
    });
  }

  root.innerHTML = `
    <div class="st-head">
      <div class="eyebrow">${escapeHtml(comp.shortName || '')} ${comp.year ? '· ' + comp.year : ''} · Start/Mål-station</div>
      <h1>${mode === 'start' ? 'Checka ut vid start' : 'Checka in vid mål'}</h1>
    </div>

    ${comp.demo ? `<div class="st-demo-note">Demospår — utforska gärna, men in-/utcheckning är avstängd.</div>` : ''}

    <div class="st-kpis">
      <div class="st-kpi"><div class="v">${counts.waiting}</div><div class="l">Ej startade</div></div>
      <div class="st-kpi ${lateCount ? 'late' : ''}"><div class="v">${lateCount}</div><div class="l">Sena till start</div></div>
      <div class="st-kpi ${counts.out ? 'warn' : ''}"><div class="v">${counts.out}</div><div class="l">Ute i skogen</div></div>
      <div class="st-kpi"><div class="v">${counts.finished}</div><div class="l">I mål</div></div>
    </div>

    <div class="st-tabs">
      <button type="button" data-mode="start" class="${mode === 'start' ? 'active' : ''}">Start</button>
      <button type="button" data-mode="mal" class="${mode === 'mal' ? 'active' : ''}">Mål</button>
    </div>

    <div class="patrol-grid">
      ${display.map(p => patrolBtn(p)).join('')}
    </div>

    <p class="r-sub" style="text-align:center;opacity:.55;margin-top:32px;font-size:13px;">
      ESKIL · tryck på en patrull för att ${mode === 'start' ? 'checka ut den' : 'checka in den'} — tryck igen för att ångra<br>
      <a href="/t/${escapeHtml(cid)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;">Tävlingssidan — startlista &amp; resultat</a>
    </p>
  `;

  root.querySelectorAll('[data-mode]').forEach(b => {
    b.addEventListener('click', () => { mode = b.dataset.mode; render(); });
  });
  root.querySelectorAll('[data-patrol]').forEach(btn => {
    bindTap(btn, () => onTap(btn.dataset.patrol));
  });
}

function patrolBtn(p) {
  const pass = passages[p.id] || {};
  const field = mode === 'start' ? 'startAt' : 'finishAt';
  const checked = !!pass[field];
  const planned = mode === 'start' ? patrolStartTime(comp, p, patrols.length, virtualNow()) : null;
  const lateMin = mode === 'start' ? lateToStartMin(p) : 0;
  // Beräknad målgång + försening (ute-patruller på målfliken).
  const etaMs = mode === 'mal' ? etaFinishMs(p) : null;
  const overdueMin = etaMs != null ? Math.floor((virtualNow().getTime() - etaMs) / 60000) : 0;
  const etaNote = etaMs != null
    ? (overdueMin >= 10
        ? `<span class="st-late-note"> · mål ca ${fmtClock(etaMs)} · ${overdueMin} min över</span>`
        : ` · mål ca ${fmtClock(etaMs)}`)
    : '';
  const sub = checked
    ? `<span class="st-checked-at">${mode === 'start' ? 'Startade' : 'I mål'} ${fmtClock(pass[field])}</span>`
    : (mode === 'start'
        ? (lateMin > 0
            ? `<span class="st-late-note">skulle startat ${escapeHtml(planned || '')} · ${lateMin} min sen</span>`
            : (planned ? `<span class="st-patrol-time">start ${escapeHtml(planned)}</span>` : 'Ej startad'))
        : (pass.startAt ? `Ute · startade ${fmtClock(pass.startAt)}${etaNote}` : 'Har inte startat'));
  return `
    <button type="button" class="patrol-btn ${checked ? 'reported' : ''} ${lateMin > 0 || overdueMin >= 10 ? 'st-late' : ''}" data-patrol="${escapeHtml(p.id)}">
      <span style="font-size:12px;color:var(--r-fg-muted);">#${p.number ?? '—'} · <span class="dot ${avdShort(p.avdelning)}"></span>${escapeHtml(p.avdelning || '')}</span>
      <strong style="display:block;">${escapeHtml(p.name || '')}</strong>
      <span style="font-size:13px;">${sub}</span>
    </button>
  `;
}

async function onTap(patrolId) {
  if (comp.demo) { toast('Demospår — in-/utcheckning är avstängd.'); return; }
  const p = patrols.find(x => x.id === patrolId);
  if (!p) return;
  const field = mode === 'start' ? 'startAt' : 'finishAt';
  const pass = passages[patrolId] || {};
  try {
    if (pass[field]) {
      // Undo — deliberate second confirmation so a stray double-tap can't
      // silently erase a timestamp.
      const ok = await confirmDialog(
        `Ångra ${mode === 'start' ? 'utcheckningen' : 'incheckningen'} för ${p.name} (${fmtClock(pass[field])})?`,
        { okLabel: 'Ångra', danger: true }
      );
      if (!ok) return;
      await setPassage(cid, stationId, patrolId, field, false);
      toast(`${p.name} — ${mode === 'start' ? 'utcheckning' : 'incheckning'} ångrad`);
    } else {
      if (mode === 'mal' && !pass.startAt) {
        const ok = await confirmDialog(
          `${p.name} är inte utcheckad från start. Checka in i mål ändå?`,
          { okLabel: 'Checka in', danger: false }
        );
        if (!ok) return;
      }
      await setPassage(cid, stationId, patrolId, field, true);
      toast(`${p.name} ${mode === 'start' ? 'utcheckad' : 'i mål'}`, 'success');
    }
  } catch (e) {
    console.error(e);
    toast('Kunde inte spara: ' + e.message, 'error');
  }
}

function renderError(msg) {
  root.innerHTML = `<div class="r-empty">${escapeHtml(msg)}</div>`;
}

main().catch(e => {
  console.error(e);
  renderError('Fel vid inläsning: ' + e.message);
});
