// ESKIL — Start/Mål-station.
// URL pattern: /m/<competitionId>/<stationId>   (stationId is the secret)
//
// The station crew checks patrols OUT at start and IN at mål, one tap per
// patrol, with server timestamps. This feeds the "Läget" dashboard so the
// secretariat always knows who is still out in the woods.

import { getCompetition, getStation, listPatrols, watchPassages, setPassage } from './store.js';
import { escapeHtml, toast, confirmDialog, patrolStartTime, avdShort } from './utils.js';
import { bindTap } from './haptic.js';

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

  watchPassages(cid, stationId, rows => {
    passages = {};
    rows.forEach(p => { passages[p.id] = p; });
    render();
  });

  render();
}

function statusOf(p) {
  const pass = passages[p.id] || {};
  if (pass.finishAt) return 'finished';
  if (pass.startAt) return 'out';
  return 'waiting';
}

function render() {
  const sorted = [...patrols].sort((a, b) => (a.startOrder ?? a.number ?? 0) - (b.startOrder ?? b.number ?? 0));
  const counts = { waiting: 0, out: 0, finished: 0 };
  sorted.forEach(p => { counts[statusOf(p)]++; });

  root.innerHTML = `
    <div class="st-head">
      <div class="eyebrow">${escapeHtml(comp.shortName || '')} ${comp.year ? '· ' + comp.year : ''} · Start/Mål-station</div>
      <h1>${mode === 'start' ? 'Checka ut vid start' : 'Checka in vid mål'}</h1>
    </div>

    ${comp.demo ? `<div class="st-demo-note">Demospår — utforska gärna, men in-/utcheckning är avstängd.</div>` : ''}

    <div class="st-kpis">
      <div class="st-kpi"><div class="v">${counts.waiting}</div><div class="l">Ej startade</div></div>
      <div class="st-kpi ${counts.out ? 'warn' : ''}"><div class="v">${counts.out}</div><div class="l">Ute i skogen</div></div>
      <div class="st-kpi"><div class="v">${counts.finished}</div><div class="l">I mål</div></div>
    </div>

    <div class="st-tabs">
      <button type="button" data-mode="start" class="${mode === 'start' ? 'active' : ''}">Start</button>
      <button type="button" data-mode="mal" class="${mode === 'mal' ? 'active' : ''}">Mål</button>
    </div>

    <div class="patrol-grid">
      ${sorted.map(p => patrolBtn(p)).join('')}
    </div>

    <p class="r-sub" style="text-align:center;opacity:.55;margin-top:32px;font-size:13px;">
      ESKIL · tryck på en patrull för att ${mode === 'start' ? 'checka ut den' : 'checka in den'} — tryck igen för att ångra
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
  const sub = checked
    ? `<span class="st-checked-at">${mode === 'start' ? 'Startade' : 'I mål'} ${fmtClock(pass[field])}</span>`
    : (mode === 'start'
        ? (planned ? `<span class="st-patrol-time">start ${escapeHtml(planned)}</span>` : 'Ej startad')
        : (pass.startAt ? `Ute · startade ${fmtClock(pass.startAt)}` : 'Har inte startat'));
  return `
    <button type="button" class="patrol-btn ${checked ? 'reported' : ''}" data-patrol="${escapeHtml(p.id)}">
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
