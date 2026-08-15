// ESKIL — Start/Mål-station.
// URL pattern: /m/<competitionId>/<stationId>   (stationId is the secret)
//
// The station crew checks patrols OUT at start and IN at mål, one tap per
// patrol, with server timestamps. This feeds the "Läget" dashboard so the
// secretariat always knows who is still out in the woods.

import { db, doc, collection, onSnapshot } from './firebase.js';
import {
  getCompetition, getStation, listPatrols, watchPassages, watchSelfPassages, setPassage,
  listControls, getTrack
} from './store.js';
import { escapeHtml, toast, confirmDialog, patrolStartTime, patrolStartDateTime, avdShort, patrolLabel } from './utils.js';
import { bindTap } from './haptic.js';
import { updateBroadcast } from './broadcast.js';
import { courseEtaCalibrated, patrolFinishEtaMs } from './course.js';

const root = document.getElementById('root');

function parsePath() {
  const parts = location.pathname.split('/').filter(Boolean); // ['m', cid, stationId]
  if (parts[0] !== 'm' || !parts[1] || !parts[2]) return null;
  return { cid: parts[1], stationId: parts[2] };
}

let comp = null;
let patrols = [];
// Start och mål kan komma från två håll här: den här stationens avprickningar
// och patrullernas egna knappar på startkortet (comp.selfStart/selfFinish).
// Råformerna hålls isär; `passages` är sammanslagningen som resten av sidan
// läser. Funktionärens avprickning väger tyngst — den bygger på att någon
// faktiskt sett patrullen.
//
// Den HÄRLEDDA målgången (comp.autoFinish) räknas medvetet INTE in här:
// stationen ska visa vem som fysiskt passerat målet, inte vem systemet gissar
// är hemma. Läget har hela bilden.
let stationPassages = {};
let selfPassages = {};
let passages = {};      // patrolId -> passage doc (+ selfStarted/selfFinished)

function mergePassages() {
  passages = {};
  for (const [pid, row] of Object.entries(stationPassages)) passages[pid] = { ...row };
  for (const [pid, row] of Object.entries(selfPassages)) {
    const cur = passages[pid] || (passages[pid] = {});
    if (!cur.startAt && row.startAt) { cur.startAt = row.startAt; cur.selfStarted = true; }
    if (!cur.finishAt && row.finishAt) { cur.finishAt = row.finishAt; cur.selfFinished = true; }
  }
}
let mode = 'start';     // 'start' | 'mal'
let cid = null, stationId = null;
let etaEngine = null;   // kalibrerad ETA-motor (byggs om ur cachade poäng)
let etaCourse = null;   // {controls, track} — statiskt underlag för motorn
let scoresByCtrl = {};  // ctrlId -> score[] (live via onSnapshot — bara deltas)
let reportsByPatrol = {}; // pid -> {ctrlId: passagetid} för positionsankare
let searchText = '';    // fritextfilter över patrullknapparna

// Flik via URL (?flik=mal — målfunktionärens direktlänk) eller senaste valet
// på den här enheten (sessionStorage), annars start.
function initialMode() {
  const q = new URLSearchParams(location.search).get('flik');
  if (q === 'mal' || q === 'start') return q;
  try {
    const saved = sessionStorage.getItem(`eskil.station.flik.${stationId}`);
    if (saved === 'mal' || saved === 'start') return saved;
  } catch { /* privat läge */ }
  return 'start';
}
function rememberMode() {
  try { sessionStorage.setItem(`eskil.station.flik.${stationId}`, mode); } catch { /* privat läge */ }
}

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
  mode = initialMode();

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

  // Driftmeddelanden från ledningen — stationen följer funktionärskanalen
  // och kvitterar med stations-id:t som identitet ("Stationen" hos ledningen).
  const bctx = { audience: 'kontroller', id: stationId };
  onSnapshot(doc(db, 'competitions', cid), snap => {
    if (!snap.exists()) return;
    comp = { id: cid, ...snap.data() };
    updateBroadcast(comp, bctx);
  });
  updateBroadcast(comp, bctx);

  watchPassages(cid, stationId, rows => {
    stationPassages = {};
    rows.forEach(p => { stationPassages[p.id] = p; });
    mergePassages();
    render();
  });
  watchSelfPassages(cid, rows => {
    selfPassages = {};
    rows.forEach(r => { selfPassages[r.id] = r; });
    mergePassages();
    render();
  });

  render();
  // "Sen till start" är tidsbaserat — uppdatera markeringarna var 30:e sekund.
  setInterval(render, 30000);
  // Offline-bannern följer nätstatusen direkt.
  window.addEventListener('online', render);
  window.addEventListener('offline', render);

  // ETA-motorn: "mål ca HH:MM" per patrull ute i skogen. Kalibrerad —
  // verkliga mellantider ur poängdatan (inkl. köer på kontrollerna)
  // ersätter modellantagandet så fort tre patruller passerat ett ben.
  // Poängen följs via onSnapshot (initial läsning + bara ändringar därefter
  // — ingen polling som dränerar läskvot och batteri); själva motorbygget
  // är en billig lokal beräkning som görs per render.
  (async () => {
    try {
      const [controls, track] = await Promise.all([
        listControls(cid),
        getTrack(cid).catch(() => null)
      ]);
      etaCourse = { controls, track };
      for (const c of controls) {
        onSnapshot(collection(db, 'competitions', cid, 'controls', c.id, 'scores'), snap => {
          scoresByCtrl[c.id] = snap.docs.map(d => ({ id: d.id, controlId: c.id, ...d.data(), patrolId: d.data().patrolId || d.id }));
          render();
        });
      }
    } catch { /* ETA är en bonus — aldrig ett fel */ }
  })();
}

// Bygg om motorn ur cachade poäng + faktiska starttider (passages). Faktisk
// start som ankare för första benets mellantid — annars dubbelräknas en
// systematisk startförsening för patruller som ankras i sin faktiska start.
function rebuildEtaEngine() {
  if (!etaCourse) return;
  try {
    const scores = Object.values(scoresByCtrl).flat();
    reportsByPatrol = {};
    for (const s of scores) {
      const t = s.clientReportedAt ?? s.reportedAt;
      if (s.patrolId && t) (reportsByPatrol[s.patrolId] ||= {})[s.controlId] = t;
    }
    const startMsByPatrol = {};
    for (const [pid, pass] of Object.entries(passages)) {
      if (!pass.startAt) continue;
      const d = typeof pass.startAt.toDate === 'function' ? pass.startAt.toDate() : new Date(pass.startAt);
      startMsByPatrol[pid] = d.getTime();
    }
    const eta = courseEtaCalibrated(comp, etaCourse.controls, etaCourse.track, scores, patrols, virtualNow(), startMsByPatrol);
    etaEngine = (eta.finishMin != null && eta.totalDist > 0) ? eta : null;
  } catch { etaEngine = null; }
}

// Beräknad målgång (ms-epok) för en patrull som är ute: ankrad i senaste
// rapporterade kontrollen (positionsmedveten) eller faktisk starttid, plus
// kvarvarande ben ur den kalibrerade motorn. null när ETA saknas eller
// patrullen inte är ute.
function etaFinishMs(p) {
  if (!etaEngine || p.utgatt) return null;
  const pass = passages[p.id] || {};
  if (!pass.startAt || pass.finishAt) return null;
  const d = typeof pass.startAt.toDate === 'function' ? pass.startAt.toDate() : new Date(pass.startAt);
  return patrolFinishEtaMs(etaEngine, reportsByPatrol[p.id], d.getTime());
}

function statusOf(p) {
  if (p.utgatt) return 'utgatt';
  const pass = passages[p.id] || {};
  if (pass.finishAt) return 'finished';
  if (pass.startAt) return 'out';
  return 'waiting';
}

// Sen till start: planerad tid passerad ≥3 min utan utcheckning.
function lateToStartMin(p) {
  if (p.utgatt) return 0; // DNF — kommer inte, ska inte larma
  const pass = passages[p.id] || {};
  if (pass.startAt) return 0;
  const plannedAt = patrolStartDateTime(comp, p, virtualNow(), patrols.length);
  if (!plannedAt) return 0;
  const min = Math.floor((virtualNow() - plannedAt) / 60000);
  return min >= 3 ? min : 0;
}

function render() {
  rebuildEtaEngine();
  const sorted = [...patrols].sort((a, b) => (a.startOrder ?? a.number ?? 0) - (b.startOrder ?? b.number ?? 0));
  const counts = { waiting: 0, out: 0, finished: 0, utgatt: 0 };
  sorted.forEach(p => { counts[statusOf(p)]++; });
  const lateCount = sorted.filter(p => lateToStartMin(p) > 0).length;

  // Målfliken sorterar som en ute-lista: de som väntas först ligger överst,
  // sedan ej startade, sist redan incheckade. Startfliken behåller startordning.
  let display = sorted;
  if (mode === 'mal' && etaEngine) {
    const rank = { out: 0, waiting: 1, finished: 2, utgatt: 3 };
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
    ${!navigator.onLine ? `<div class="st-offline">${escapeHtml('Offline — in-/utcheckningar sparas i telefonen och synkas automatiskt när nätet är tillbaka.')}</div>` : ''}

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

    <input class="input st-search" id="st-search" type="search" placeholder="Sök patrull (namn, nummer, kår)…"
      value="${escapeHtml(searchText)}" autocomplete="off">

    <div class="patrol-grid">
      ${display.filter(matchesSearch).map(p => patrolBtn(p)).join('')}
    </div>
    ${searchText && !display.some(matchesSearch) ? `<div class="r-empty">Ingen patrull matchar "${escapeHtml(searchText)}".</div>` : ''}

    <p class="r-sub" style="text-align:center;opacity:.55;margin-top:32px;font-size:13px;">
      ESKIL · tryck på en patrull för att ${mode === 'start' ? 'checka ut den' : 'checka in den'} — tryck igen för att ångra<br>
      <a href="/t/${escapeHtml(cid)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;">Tävlingssidan — startlista &amp; resultat</a>
    </p>
  `;

  root.querySelectorAll('[data-mode]').forEach(b => {
    b.addEventListener('click', () => { mode = b.dataset.mode; rememberMode(); render(); });
  });
  root.querySelectorAll('[data-patrol]').forEach(btn => {
    bindTap(btn, () => onTap(btn.dataset.patrol));
  });

  // Sökfältet filtrerar knapparna live utan att tappa fokus/markör.
  const search = root.querySelector('#st-search');
  search.addEventListener('input', () => {
    const pos = search.selectionStart;
    searchText = search.value;
    render();
    const again = root.querySelector('#st-search');
    again.focus();
    try { again.setSelectionRange(pos, pos); } catch { /* type=search i vissa lägen */ }
  });
}

// Fritextmatch mot namn, nummer och kår (gemener, delsträng räcker).
function matchesSearch(p) {
  const q = searchText.trim().toLowerCase();
  if (!q) return true;
  return [p.name, p.kar, '#' + (p.number ?? ''), String(p.number ?? '')]
    .some(v => String(v || '').toLowerCase().includes(q));
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
  const pendingNote = checked && pass._pending
    ? ` <span class="st-pending">· väntar på nät</span>` : '';
  const sub = p.utgatt
    ? `<span class="st-utgatt-note">Utgått${pass.startAt && !checked ? ' · startade ' + fmtClock(pass.startAt) : ''}</span>${checked ? ` · ${mode === 'start' ? 'startade' : 'i mål'} ${fmtClock(pass[field])}` : ''}`
    : checked
    ? `<span class="st-checked-at">${mode === 'start' ? 'Startade' : 'I mål'} ${fmtClock(pass[field])}</span>${(mode === 'start' ? pass.selfStarted : pass.selfFinished) ? ' <span class="st-patrol-time">· markerade själva</span>' : ''}${pendingNote}`
    : (mode === 'start'
        ? (lateMin > 0
            ? `<span class="st-late-note">skulle startat ${escapeHtml(planned || '')} · ${lateMin} min sen</span>`
            : (planned ? `<span class="st-patrol-time">start ${escapeHtml(planned)}</span>` : 'Ej startad'))
        : (pass.startAt ? `Ute · startade ${fmtClock(pass.startAt)}${etaNote}` : 'Har inte startat'));
  return `
    <button type="button" class="patrol-btn ${checked ? 'reported' : ''} ${lateMin > 0 || overdueMin >= 10 ? 'st-late' : ''} ${p.utgatt ? 'st-utgatt' : ''}" data-patrol="${escapeHtml(p.id)}">
      <span style="font-size:12px;color:var(--r-fg-muted);">#${p.number ?? '—'} · <span class="dot ${avdShort(p.avdelning)}"></span>${escapeHtml(p.avdelning || '')}</span>
      <strong style="display:block;">${escapeHtml(patrolLabel(p))}</strong>
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
  // Fire-and-forget: skrivningen hamnar i Firestores lokala kö direkt och
  // synkas när nätet finns — stationen ska aldrig stå och vänta på täckning
  // med en scout framför sig. Fel (t.ex. rules-avslag) ytas via catch;
  // kö-läget syns som "väntar på nät" på knappen tills servern bekräftat.
  const fail = (e) => { console.error(e); toast('Kunde inte spara: ' + e.message, 'error'); };
  // Patrullens egna avprickningar ligger i deras egen collection, inte i
  // stationens passages — de kan bara ångras av en administratör (reglerna
  // låter varje stämpel sättas en gång och aldrig ändras). Säg det i klartext
  // i stället för att låta en ångra-dialog misslyckas tyst.
  if (mode === 'start' ? pass.selfStarted : pass.selfFinished) {
    toast(`${p.name} ${mode === 'start' ? 'bekräftade sin start' : 'markerade sig i mål'} själva ${fmtClock(pass[field])}. Behöver det ångras gör tävlingsledningen det i Läget.`);
    return;
  }
  if (pass[field]) {
    // Undo — deliberate second confirmation so a stray double-tap can't
    // silently erase a timestamp.
    const ok = await confirmDialog(
      `Ångra ${mode === 'start' ? 'utcheckningen' : 'incheckningen'} för ${p.name} (${fmtClock(pass[field])})?`,
      { okLabel: 'Ångra', danger: true }
    );
    if (!ok) return;
    setPassage(cid, stationId, patrolId, field, false).catch(fail);
    toast(`${p.name} — ${mode === 'start' ? 'utcheckning' : 'incheckning'} ångrad`);
  } else {
    if (mode === 'mal' && !pass.startAt) {
      const ok = await confirmDialog(
        `${p.name} är inte utcheckad från start. Checka in i mål ändå?`,
        { okLabel: 'Checka in', danger: false }
      );
      if (!ok) return;
    }
    setPassage(cid, stationId, patrolId, field, true).catch(fail);
    toast(`${p.name} ${mode === 'start' ? 'utcheckad' : 'i mål'}`, 'success');
  }
}

function renderError(msg) {
  root.innerHTML = `<div class="r-empty">${escapeHtml(msg)}</div>`;
}

main().catch(e => {
  console.error(e);
  renderError('Fel vid inläsning: ' + e.message);
});
