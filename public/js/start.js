// ESKIL — Scout-side startkort.
// URL pattern: /s/<competitionId>/<patrolId>
// Same look and feel as the reporter page. Shows:
//   - Flip card: patrol info on front; competition info/management/general info on back
//   - Map with all controls (color-coded by done/not-done for this patrol)
//   - Filter chips + control list with anonymity enforced

import { db, doc, onSnapshot, collection } from './firebase.js';
import {
  getCompetition, getCompetitionBySlug, getPatrol, listControls, listPatrols, getTrack,
  watchSelfPassages, confirmSelfPassage
} from './store.js';
import { courseLegs, drawCourseOnMap, addCourseChip, legLatLngs, courseEtaCalibrated, patrolFinishEtaMs, fmtDist, fmtMin, competitionArea } from './course.js';
import {
  escapeHtml, publicManagement, patrolStartTime, patrolStartDateTime,
  startFinishPoints, startTimeSettings,
  effectiveIntervalSec as effectiveIntervalSecValue,
  wireOverlayClose, allowedAvdelningar,
  controlsAutoReleased, controlsReleaseTime
} from './utils.js';
import { ensureLeaflet } from './leaflet.js';
import { icon } from './icons.js';
import { bindHaptic, bindTap, lockScroll, unlockScroll } from './haptic.js';
import { updateBroadcast } from './broadcast.js';
import { patrolHighlights } from './highlights.js';
import { mountChat } from './chat.js';
import { compPlaces, placeKind, drawPlaces } from './places.js';

const root = document.getElementById('root');
const modeBtn = document.getElementById('mode-toggle');
const modeIcon = document.getElementById('mode-icon');
const modeLbl = document.getElementById('mode-label');

// --- Mode toggle (shared semantics with reporter page) ---
function applyMode(mode) {
  document.documentElement.setAttribute('data-mode', mode);
  try { localStorage.setItem('eskil:mode', mode); } catch {}
  if (mode === 'night') { modeIcon.innerHTML = icon('moon', { size: 16 }); modeLbl.textContent = 'Dagläge'; }
  else { modeIcon.innerHTML = icon('sun', { size: 16 }); modeLbl.textContent = 'Nattläge'; }
}
applyMode(document.documentElement.getAttribute('data-mode') || 'light');
bindHaptic(modeBtn);

// Same iOS zoom-blockers as the reporter page (dblclick + pinch gestures).
document.addEventListener('dblclick',      (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart',  (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gestureend',    (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1 && !e.target.closest?.('.leaflet-container')) {
    e.preventDefault();
  }
}, { passive: false });
modeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-mode') || 'light';
  applyMode(cur === 'night' ? 'light' : 'night');
});

function parsePath() {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 's' && parts.length >= 3) {
    return { cid: parts[1], patrolId: parts[2] };
  }
  return null;
}

// --- Global state ---
let comp = null;
let patrol = null;
let patrols = [];          // all patrols in the competition — needed for
                           // accurate start-time interval in range mode
                           // and for the countdown window.
let controls = [];
let track = null;    // drawn course from the Spår editor (fetched once)
let scoresForPatrol = {};  // controlId -> score doc (egna patrullens)
let allScoresByCtrl = {};  // controlId -> score[] — kalibrerar ETA-motorn
let filter = 'alla';       // 'alla' | 'kvar' | 'klara'
let selfStartAt = null;    // Date — patrullens egen startbekräftelse
let selfFinishAt = null;   // Date — patrullens egen målmarkering
let confirming = null;     // 'startAt' | 'finishAt' medan skrivningen pågår
let chatPanel = null;      // samtalspanelen mot tävlingsledningen

async function main() {
  const parsed = parsePath();
  if (!parsed) return renderError('Ogiltig länk.');
  let { cid } = parsed;
  const { patrolId } = parsed;

  try {
    // /s/<id>/... or the competition's fixed slug (/s/ah26/...) — resolve.
    comp = await getCompetition(cid);
    if (!comp) {
      comp = await getCompetitionBySlug(cid);
      if (comp) cid = comp.id;
    }
    if (comp) {
      [patrol, controls, patrols, track] = await Promise.all([
        // /s/<cid>/test — a synthetic patrol so the startkort can be
        // previewed before any patrols exist. Everything shown is public
        // data anyway; the banner below marks it clearly as a test.
        /^test(-\d+)?$/.test(patrolId)
          ? Promise.resolve({
              id: 'test', number: 0, name: 'Testpatrullen',
              avdelning: allowedAvdelningar(comp)[0]?.key || 'Spårare',
              antal: 6, kar: 'Lindsdals Scoutkår', startOrder: 0, __test: true
            })
          : getPatrol(cid, patrolId),
        listControls(cid),
        listPatrols(cid),
        getTrack(cid).catch(() => null)
      ]);
    }
  } catch (e) {
    return renderError('Kunde inte ladda startkortet: ' + e.message);
  }
  if (!comp)   return renderError('Tävlingen hittades inte.');
  if (!patrol) return renderError('Patrullen hittades inte.');
  document.title = `${patrol.name || 'Startkort'} · ${comp.shortName || comp.name || ''} — ESKIL`;

  // Offline-bannern följer nätstatusen direkt.
  window.addEventListener('online', render);
  window.addEventListener('offline', render);

  // Live updates: competition, controls, scores for this patrol across all controls
  const bctx = { audience: 'patrull', id: patrolId };
  onSnapshot(doc(db, 'competitions', cid), s => {
    if (s.exists()) { comp = { id: cid, ...s.data() }; updateBroadcast(comp, bctx); render(); }
  });
  updateBroadcast(comp, bctx);
  // Egna avprickningar — live, så knapparna slår om även om patrullen
  // tryckte på en annan telefon.
  watchSelfPassages(cid, rows => {
    const own = rows.find(r => r.id === patrolId) || {};
    const toDate = (ts) => ts ? (typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts)) : null;
    selfStartAt = toDate(own.startAt);
    selfFinishAt = toDate(own.finishAt);
    render();
  });

  const subscribedScoreCtrls = new Set();
  onSnapshot(collection(db, 'competitions', cid, 'controls'), snap => {
    controls = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // EN lyssnare per kontroll över hela scores-kollektionen (dedupad så
    // controls-snapshots inte staplar dubbletter): driver både egna poängen
    // på kortet och ETA-kalibreringen — initial läsning + deltas därefter,
    // ingen polling som dränerar läskvot och batteri.
    for (const c of controls) {
      if (subscribedScoreCtrls.has(c.id)) continue;
      subscribedScoreCtrls.add(c.id);
      onSnapshot(collection(db, 'competitions', cid, 'controls', c.id, 'scores'), scoreSnap => {
        const rows = scoreSnap.docs.map(d => ({ id: d.id, controlId: c.id, ...d.data(), patrolId: d.data().patrolId || d.id }));
        allScoresByCtrl[c.id] = rows;
        const own = rows.find(r => r.patrolId === patrolId);
        if (own) scoresForPatrol[c.id] = own; else delete scoresForPatrol[c.id];
        render();
      });
    }
    render();
  });

  render();
}

function isAnonymous() { return comp?.anonymousControls !== false; }

// --- Startkortets tre lägen ---------------------------------------------------
//
// Med `selfStart` påslaget är startkortet inte ett kort utan ett förlopp:
//
//   'info'      Före bekräftad start. Bara tävlingsinformation, ledningens
//               kontaktuppgifter och vägen till starten. Ingen bankarta,
//               inga kontroller — patrullen ska inte kunna planera banan i
//               bilen på väg dit.
//   'tavling'   Normalläget: karta, kontroller, poäng, ETA.
//   'summering' Banan är avklarad. Positiva höjdpunkter i stället för
//               kontrollistan.
//
// Utan `selfStart` finns bara 'tavling' och 'summering' — kortet beter sig
// som förut.
function selfStartEnabled() { return comp?.selfStart === true; }

function selfStarted() { return !!selfStartAt; }
function selfFinishEnabled() { return comp?.selfFinish === true; }
function selfFinished() { return !!selfFinishAt; }

// Knappen tänds när patrullens egen starttid passerats. Saknar tävlingen
// starttider finns ingenting att vänta på — då är den tänd direkt.
function mayConfirmStart(now = new Date()) {
  const dt = patrolStartDateTime(comp, patrol, now, patrols.length);
  return !dt || now >= dt;
}

function courseFinished() {
  const t = totals();
  return t.total > 0 && t.done >= t.total;
}

function cardPhase() {
  if (courseFinished() || comp?.closed) return 'summering';
  if (selfStartEnabled() && !selfStarted()) return 'info';
  return 'tavling';
}

// Startkortet kan inte läsa stationens passages (stations-id:t är hemligt),
// så patrullens faktiska start är den egna bekräftelsen när den finns —
// annars den planerade tiden.
function effectiveStartMs() {
  if (selfStartAt) return selfStartAt.getTime();
  const dt = patrolStartDateTime(comp, patrol, new Date(), patrols.length);
  return dt ? dt.getTime() : null;
}

// Kontrollernas POSITIONER på startkortet döljs tills de är publika — scouter
// får startkortslänken dagar i förväg och ska inte kunna rekognosera banan.
// Samma släpplogik som publika sidan: publicControls-flaggan, eller
// autosläppet 5 min före första start (controlsAutoReleased). Kontrollanternas
// /k-sidor berörs inte — de behöver sina positioner för att bygga kontrollen.
function positionsVisible() {
  // Med självbekräftad start är banan stängd tills patrullen tryckt på
  // knappen — det gäller ÖVERALLT på kortet, även i start/mål-bladets
  // bankontext, inte bara i huvudvyn.
  if (selfStartEnabled() && !selfStarted()) return false;
  return comp?.publicControls !== false || controlsAutoReleased(comp);
}

// Text för när platserna dyker upp — visas där kartnålarna skulle varit.
function releaseText() {
  if (selfStartEnabled() && !selfStarted()) {
    return 'Kontrollerna visas när ni bekräftat start.';
  }
  const t = controlsReleaseTime(comp);
  if (t) {
    const kl = t.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    return `Kontrollernas platser visas här kl ${kl} på tävlingsdagen (5 min före första start).`;
  }
  return 'Kontrollernas platser visas här när tävlingsledningen släpper dem.';
}

function isDone(ctrlId) { return !!scoresForPatrol[ctrlId]; }

function displayName(c) {
  // Anonymous until scored; number always visible.
  if (!isAnonymous() || isDone(c.id)) return c.name || '';
  return 'Kontroll ' + (c.nummer ?? '?');
}

function totals() {
  const done = controls.filter(c => isDone(c.id));
  const sum = done.reduce((acc, c) => {
    const s = scoresForPatrol[c.id];
    return acc + (Number(s?.poang) || 0) + (Number(s?.extraPoang) || 0);
  }, 0);
  return { done: done.length, total: controls.length, points: sum };
}

// --- Render ---
// "Nästa kontroll"-kortet: första ej avklarade kontrollen i nummerordning —
// ett tryck öppnar kontrollbladet med karta och vägen dit.
function renderNextControl(t) {
  if (!controls.length || t.done >= t.total) return '';
  const ordered = [...controls].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
  const next = ordered.find(c => !isDone(c.id));
  if (!next) return '';
  return `<button type="button" class="start-next" data-next="${escapeHtml(next.id)}">
    <span class="sn-label">Nästa kontroll</span>
    <span class="sn-name"><span class="sn-no">${next.nummer ?? '?'}</span>${escapeHtml(displayName(next))}</span>
    <span class="sn-go">${positionsVisible() ? 'Visa på kartan →' : 'Mer info →'}</span>
  </button>`;
}

// ETA-raden under KPI:erna: hur mycket bana som är kvar och när patrullen
// beräknas vara i mål. Kalibrerad motor: verkliga mellantider ur poängdatan
// (inkl. köer på kontrollerna) ersätter gångtid + stationstid så fort tre
// patruller passerat ett ben. Målgången ankras i patrullens senaste rapport
// — inte i klockan — så en lång paus inte "försvinner" ur estimatet.
function renderEtaLine(t) {
  try {
    if (!t.total) return '';
    // Före positionssläppet avslöjar vi ingen bansträckning — visa i stället
    // NÄR platserna dyker upp.
    if (!positionsVisible()) {
      return `<div class="start-eta">${icon('eye-off', { size: 14 })} ${escapeHtml(releaseText())}</div>`;
    }
    const now = new Date();
    const eta = courseEtaCalibrated(comp, controls, track, Object.values(allScoresByCtrl).flat(), patrols, now);
    if (!(eta.totalDist > 0)) return '';
    if (t.done >= t.total) return `<div class="start-eta">${icon('flag', { size: 14 })} Alla kontroller klara — gå i mål!</div>`;

    let fromKey = eta.nodes[0]?.key;
    for (const n of eta.nodes) if (n.kind === 'control' && isDone(n.key)) fromKey = n.key;
    const from = eta.byKey[fromKey];
    const to = eta.byKey[eta.nodes[eta.nodes.length - 1]?.key];
    if (!from || !to) return '';
    const kvar = t.total - t.done;
    const distLeft = Math.max(0, to.dist - from.dist);

    if (t.done === 0) {
      return `<div class="start-eta">${icon('clock', { size: 14 })} Hela banan: ${fmtDist(eta.totalDist)} · ca ${fmtMin(eta.finishMin)} inkl. kontroller</div>`;
    }
    const reports = {};
    for (const [ctrlId, s] of Object.entries(scoresForPatrol)) {
      const t = s?.clientReportedAt ?? s?.reportedAt;
      if (t) reports[ctrlId] = t;
    }
    const startDt = patrolStartDateTime(comp, patrol, now, patrols.length);
    const finMs = patrolFinishEtaMs(eta, reports, startDt ? startDt.getTime() : null);
    const minLeft = finMs != null
      ? Math.max(0, (finMs - now.getTime()) / 60000)
      : (distLeft / 1000) / eta.speedKmh * 60 + kvar * eta.dwellMin;
    // Ett passerat estimat visas som "nu" — patrullen väntas vilken minut som helst.
    const malKl = new Date(Math.max(finMs ?? (now.getTime() + minLeft * 60000), now.getTime()))
      .toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    return `<div class="start-eta">${icon('clock', { size: 14 })} Kvar: ${kvar} kontroll${kvar === 1 ? '' : 'er'} · ${fmtDist(distLeft)} · ~${fmtMin(minLeft)} — i mål ca ${malKl}</div>`;
  } catch { return ''; }
}

// --- Läge 'info': före bekräftad start ----------------------------------------
// Allt patrullen behöver INNAN de går: hur de tar sig till starten, vad som
// gäller, vem de ringer. Ingenting om banan.
function renderInfoBody() {
  const kanStarta = mayConfirmStart();
  const generalInfo = (comp.generalInfo || '').trim();
  const mgmt = publicManagement(comp);
  const places = compPlaces(comp);
  const sf = startFinishPoints(comp);
  const start = sf.find(p => p.kind === 'start' || p.kind === 'startfinish');
  const maxMin = Number(comp.startTimes?.maxTimeMinutes) || 0;

  const vagCard = (label, sub, kind, ikon, farg) => `
    <div class="start-ctrl start-ctrl-sf" data-sf="${escapeHtml(kind)}">
      <div class="start-ctrl-no sf-no"${farg ? ` style="background:${farg};color:#fff;"` : ''}>${ikon}</div>
      <div class="start-ctrl-body">
        <div class="start-ctrl-name">${escapeHtml(label)}</div>
        <div class="start-ctrl-sub">${escapeHtml(sub || 'Tryck för karta och koordinater')}</div>
      </div>
      <span class="start-ctrl-status">Visa</span>
    </div>`;

  return `
    <div class="start-confirm-wrap">
      <button type="button" class="start-confirm ${kanStarta ? 'is-ready' : ''}"
        data-confirm="startAt" ${kanStarta && !confirming ? '' : 'disabled'}>
        ${icon(kanStarta ? 'flag' : 'clock', { size: 22 })}
        <span>${confirming ? 'Bekräftar…' : 'Bekräfta start'}</span>
      </button>
      <p class="start-confirm-hint">
        ${kanStarta
          ? 'Tryck när ni går ut från starten. Då öppnas kartan och kontrollerna — och tävlingsledningen ser att ni är ute på banan.'
          : 'Knappen tänds när er starttid är inne. Kartan och kontrollerna visas först när ni bekräftat.'}
      </p>
    </div>

    ${(places.length || start) ? `
      <h2 class="start-info-h">Så tar ni er till starten</h2>
      <div class="start-ctrl-list">
        ${places.map(pl => vagCard(pl.name, placeKind(pl.kind).label, 'place:' + pl.id, icon(pl.icon, { size: 20, stroke: 2.5 }), pl.colorHex)).join('')}
        ${start ? vagCard(start.kind === 'startfinish' ? 'Start / Mål' : 'Start', start.name, 'start', escapeHtml(start.label)) : ''}
      </div>` : ''}

    ${maxMin > 0 ? `
      <div class="start-eta">${icon('clock', { size: 14 })} Maxtid på banan: ${[Math.floor(maxMin / 60) ? Math.floor(maxMin / 60) + ' h' : '', maxMin % 60 ? (maxMin % 60) + ' min' : ''].filter(Boolean).join(' ')}. Nedräkningen startar när ni bekräftar.</div>
    ` : ''}

    ${generalInfo ? `
      <h2 class="start-info-h">Allmän information</h2>
      <div class="start-info-body">${escapeHtml(generalInfo)}</div>` : ''}

    ${mgmt.length ? `
      <h2 class="start-info-h">Tävlingsledning</h2>
      <div class="flip-mgmt start-info-mgmt">
        ${mgmt.map(r => `
          <div class="flip-mgmt-row">
            <div class="flip-mgmt-label">${escapeHtml(r.label)}</div>
            ${r.name ? `<div class="flip-mgmt-name">${escapeHtml(r.name)}</div>` : ''}
            ${r.phone ? `<a class="flip-mgmt-contact" href="tel:${escapeHtml(r.phone)}">${icon('phone', { size: 16 })} ${escapeHtml(r.phone)}</a>` : ''}
            ${r.email ? `<a class="flip-mgmt-contact" href="mailto:${escapeHtml(r.email)}">${icon('mail', { size: 16 })} ${escapeHtml(r.email)}</a>` : ''}
          </div>
        `).join('')}
      </div>` : ''}
  `;
}

// --- Läge 'summering': banan avklarad -----------------------------------------
// Bara det som gick bra (se highlights.js). Kontrollistan står kvar under —
// det är där patrullen ser sina poäng kontroll för kontroll.
function renderSummaryBody() {
  const visaJamforelser = comp?.publicScores !== false;
  const rapporter = Object.values(scoresForPatrol)
    .map(s => s?.clientReportedAt ?? s?.reportedAt)
    .map(v => (v && typeof v.toDate === 'function' ? v.toDate() : v ? new Date(v) : null))
    .filter(Boolean)
    .sort((a, b) => b - a);
  const punkter = patrolHighlights({
    patrolId: patrol.id,
    controls,
    scoresByControl: allScoresByCtrl,
    showRank: visaJamforelser,
    startMs: effectiveStartMs(),
    endMs: selfFinishAt ? selfFinishAt.getTime() : (rapporter[0] ? rapporter[0].getTime() : null)
  });
  if (!punkter.length) return '';

  // Målmarkeringen — bara när tävlingen har funktionen på och patrullen inte
  // redan tryckt. Att alla kontroller är rapporterade vet vi redan: det är
  // villkoret för att över huvud taget vara i det här läget.
  const malknapp = selfFinishEnabled() && !selfFinished() ? `
    <div class="start-confirm-wrap">
      <button type="button" class="start-confirm is-ready" data-confirm="finishAt" ${confirming ? 'disabled' : ''}>
        ${icon('flag', { size: 22 })}
        <span>${confirming === 'finishAt' ? 'Markerar…' : 'Vi är i mål'}</span>
      </button>
      <p class="start-confirm-hint">Tryck när ni är tillbaka vid målet, så vet tävlingsledningen att ni är hemma.</p>
    </div>` : '';

  return `
    ${malknapp}
    <div class="start-summary">
      <div class="start-summary-head">${icon('party-popper', { size: 20 })} <span>I mål!</span>${
        selfFinishAt ? `<span class="start-summary-time">${selfFinishAt.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}</span>` : ''}</div>
      <ul class="start-summary-list">
        ${punkter.map(h => `<li>${icon(h.icon, { size: 17 })}<span>${escapeHtml(h.text)}</span></li>`).join('')}
      </ul>
      ${visaJamforelser ? '' : `<p class="start-summary-foot">Placeringarna visas när tävlingsledningen publicerat resultatet.</p>`}
    </div>`;
}

function render() {
  if (!comp || !patrol) return;

  const generalInfo = (comp.generalInfo || '').trim();
  const mgmt = publicManagement(comp);
  const hasBackContent = !!generalInfo || mgmt.length > 0;

  const t = totals();
  const phase = cardPhase();

  // Batteri: behåll den levande kartnoden över re-renders (varje poäng-
  // snapshot kör render()). Noden byts in i den nya strukturen efteråt och
  // bara pinnarna ritas om — inga nya tile-hämtningar.
  const keepMapEl = overviewMap ? document.getElementById('start-map') : null;

  root.innerHTML = `
    ${!navigator.onLine ? `<div class="start-offline">Offline — visar senast kända läge. Allt uppdateras automatiskt när nätet är tillbaka.</div>` : ''}
    <div class="flip-card" id="flip-card">
      <div class="flip-card-inner">
        <div class="flip-face flip-front">
          <div class="start-head">
            ${patrol.__test ? `<div style="background:#fde5d4;color:#b84a0a;border-radius:10px;padding:8px 12px;margin-bottom:10px;font-size:13px;font-weight:700;">TESTLÄGE — så här ser patrullernas startkort ut. Riktiga startkort får patrullens namn och poäng.</div>` : ''}
            <div class="start-eyebrow">${escapeHtml(comp.shortName || 'Tävling')} ${comp.year ? '· ' + comp.year : ''} · STARTKORT</div>
            <div class="flip-title-row">
              <h1 class="start-title">
                <span class="r-ctrl-no">#${escapeHtml(String(patrol.number ?? ''))}</span>${escapeHtml(patrol.name || '')}
              </h1>
              ${hasBackContent ? `<button type="button" class="flip-btn" id="flip-open" aria-expanded="false" aria-label="Visa tävlingsinformation">${icon('info', { size: 22 })}</button>` : ''}
            </div>
            <div class="start-sub">
              ${escapeHtml(patrol.avdelning || '')}${patrol.kar ? ' · ' + escapeHtml(patrol.kar) : ''}${patrol.antal ? ' · ' + patrol.antal + ' deltagare' : ''}
            </div>
            ${(() => {
              const t = patrolStartTime(comp, patrol, patrols.length);
              if (!t) return '';
              const dt = patrolStartDateTime(comp, patrol, new Date(), patrols.length);
              // Maxtid: nedräkning mot planerad start + maxTimeMinutes.
              const maxMin = Number(comp.startTimes?.maxTimeMinutes) || 0;
              // Maxtiden räknas från när patrullen FAKTISKT gick. Med
              // självbekräftad start är det bekräftelsen — annars hade
              // nedräkningen tickat medan de fortfarande stod i kön.
              const ankare = selfStartAt || dt;
              // Banan avklarad → ingen nedräkning kvar att bry sig om.
              const deadline = maxMin > 0 && ankare && !courseFinished()
                && !(selfStartEnabled() && !selfStarted())
                ? new Date(ankare.getTime() + maxMin * 60000) : null;
              return `<div class="start-time-chip" id="start-time-chip" data-start="${dt?.toISOString() || ''}">
                ${icon('clock', { size: 18 })}
                <span>Starttid</span>
                <span class="start-time-value">${escapeHtml(t)}</span>
                <span class="start-time-sep">·</span>
                <span class="start-time-countdown" id="start-time-countdown">—</span>
              </div>
              ${deadline ? `<div class="start-max-chip" id="start-max-chip" data-deadline="${deadline.toISOString()}" hidden>
                ${icon('clock', { size: 15 })} <span>Maxtid</span> <span id="start-max-countdown">—</span>
              </div>` : ''}`;
            })()}
          </div>
        </div>
        <div class="flip-face flip-back" aria-hidden="true">
          <button type="button" class="flip-back-close" id="flip-close" aria-label="Stäng">${icon('x', { size: 22 })}</button>
          ${generalInfo ? `
            <h3>Allmän information</h3>
            <div class="flip-placement"><p>${escapeHtml(generalInfo)}</p></div>
          ` : ''}
          ${mgmt.length ? `
            <h3>Tävlingsledning</h3>
            <div class="flip-mgmt">
              ${mgmt.map(r => `
                <div class="flip-mgmt-row">
                  <div class="flip-mgmt-label">${escapeHtml(r.label)}</div>
                  ${r.name ? `<div class="flip-mgmt-name">${escapeHtml(r.name)}</div>` : ''}
                  ${r.phone ? `<a class="flip-mgmt-contact" href="tel:${escapeHtml(r.phone)}">${icon('phone', { size: 16 })} ${escapeHtml(r.phone)}</a>` : ''}
                  ${r.email ? `<a class="flip-mgmt-contact" href="mailto:${escapeHtml(r.email)}">${icon('mail', { size: 16 })} ${escapeHtml(r.email)}</a>` : ''}
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      </div>
    </div>

    ${phase === 'info' ? renderInfoBody() : `
      ${phase === 'summering' ? renderSummaryBody() : ''}

      <div class="start-kpis">
        <div class="start-kpi primary"><div class="kp-label">Poäng</div><div class="kp-value">${t.points}</div></div>
        <div class="start-kpi"><div class="kp-label">Klara</div><div class="kp-value">${t.done} / ${t.total}</div></div>
        <div class="start-kpi"><div class="kp-label">Kvar</div><div class="kp-value">${t.total - t.done}</div></div>
      </div>
      ${phase === 'summering' ? '' : renderEtaLine(t) + renderNextControl(t)}

      ${controls.some(c => c.lat && c.lng) ? `
        <div class="start-map-wrap">
          <div class="start-map" id="start-map"></div>
        </div>
      ` : ''}

      <div class="start-filter">
        <button type="button" data-f="alla"  class="${filter === 'alla'  ? 'active' : ''}">Alla · ${t.total}</button>
        <button type="button" data-f="kvar"  class="${filter === 'kvar'  ? 'active' : ''}">Kvar · ${t.total - t.done}</button>
        <button type="button" data-f="klara" class="${filter === 'klara' ? 'active' : ''}">Klara · ${t.done}</button>
      </div>

      <div class="start-ctrl-list">
        ${renderList()}
      </div>
    `}

    <div id="chat"></div>

    <p class="r-sub" style="text-align:center;opacity:.55;margin-top:36px;font-size:13px;">
      ESKIL · startkort · live-uppdaterat när poäng rapporteras<br>
      <a href="/t/${escapeHtml(parsePath()?.cid || '')}" style="color:inherit;text-decoration:underline;">Tävlingssidan — startlista, karta &amp; resultat</a>
    </p>
  `;

  // Samtal med tävlingsledningen — samma panel som kontrollernas sida.
  // Testkortet får den inte: /s/<cid>/test har ingen patrull i databasen, så
  // reglerna skulle neka och panelen bara se trasig ut.
  chatPanel?.destroy();
  if (!patrol.__test) {
    chatPanel = mountChat(root.querySelector('#chat'), {
      cid: parsePath().cid, kind: 'patrull', refId: patrol.id,
      enabled: comp?.fieldMessaging !== false,
      title: 'Fråga tävlingsledningen'
    });
  }

  // Wire filter
  root.querySelectorAll('.start-filter button').forEach(b => {
    b.addEventListener('click', () => { filter = b.dataset.f; render(); });
  });

  // Countdown to the patrol's start time on the chip
  wireStartCountdown();

  // Nästa kontroll-kortet öppnar kontrollbladet direkt.
  root.querySelector('[data-next]')?.addEventListener('click', (e) => {
    openControlSheet(e.currentTarget.dataset.next);
  });

  // Wire control rows (regular + start/finish pseudo-rows)
  root.querySelectorAll('.start-ctrl').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.sf) openStartFinishSheet(el.dataset.sf);
      else openControlSheet(el.dataset.id);
    });
  });

  // Flip card
  wireFlipCard();

  // Bekräfta start / Vi är i mål — samma knapp, olika stämpel.
  root.querySelectorAll('[data-confirm]').forEach(btn => bindTap(btn, async () => {
    const field = btn.dataset.confirm;
    if (confirming) return;
    if (field === 'startAt' && !mayConfirmStart()) return;
    if (field === 'finishAt' && !courseFinished()) return;
    // Testkortet (/s/<cid>/test) har ingen patrull i databasen — reglerna
    // skulle neka skrivningen. Låt förhandsvisningen gå vidare ändå, den
    // finns just för att visa hur kortet beter sig.
    if (patrol.__test) {
      if (field === 'startAt') selfStartAt = new Date(); else selfFinishAt = new Date();
      render();
      return;
    }
    confirming = field;
    render();
    try {
      await confirmSelfPassage(parsePath().cid, patrol.id, field);
      // Snapshoten skriver tillbaka tiden och renderar om. Offline landar
      // skrivningen i Firestores lokala kö och slår igenom lokalt direkt —
      // patrullen ska kunna gå ut i skogen utan täckning.
    } catch (e) {
      confirming = null;
      alert((field === 'startAt' ? 'Kunde inte bekräfta starten: ' : 'Kunde inte markera målgången: ')
            + (e?.message || e) + '\n\nGå till funktionären vid start/mål så prickar de av er.');
      render();
    }
  }));

  // Overview map — swap the live node back in if we kept one.
  const withPos = controls.filter(c => c.lat && c.lng);
  const newHost = document.getElementById('start-map');
  if (keepMapEl && newHost) {
    newHost.replaceWith(keepMapEl);
    requestAnimationFrame(() => { try { overviewMap?.invalidateSize(); } catch {} });
  }
  if (withPos.length) renderOverviewMap(withPos);
}

function renderList() {
  const sorted = [...controls].sort((a, b) => (a.nummer || 0) - (b.nummer || 0));
  const rows = sorted.filter(c => {
    const done = isDone(c.id);
    if (filter === 'kvar')  return !done;
    if (filter === 'klara') return done;
    return true;
  });
  if (!rows.length && filter !== 'alla') {
    return `<div class="r-empty">Inga kontroller i denna vy.</div>`;
  }

  // Start/finish + parking pseudo-entries — shown in the "Alla" list regardless
  // of kvar/klara filtering (they aren't scored).
  const sf = startFinishPoints(comp);
  const sfStart = sf.find(p => p.kind === 'start' || p.kind === 'startfinish');
  const sfFinish = sf.find(p => p.kind === 'finish');
  const places = compPlaces(comp);

  const pseudoCard = (label, sub, kindAttr, badge, farg) => `
      <div class="start-ctrl start-ctrl-sf" data-sf="${escapeHtml(kindAttr)}">
        <div class="start-ctrl-no sf-no"${farg ? ` style="background:${farg};color:#fff;"` : ''}>${badge}</div>
        <div class="start-ctrl-body">
          <div class="start-ctrl-name">${escapeHtml(label)}</div>
          <div class="start-ctrl-sub">${escapeHtml(sub || '')}</div>
        </div>
      </div>`;

  const showSf = filter === 'alla';
  const parkingRow = showSf
    ? places.map(pl => pseudoCard(pl.name, placeKind(pl.kind).label, 'place:' + pl.id,
        icon(pl.icon, { size: 20, stroke: 2.5 }), pl.colorHex)).join('')
    : '';
  const startRow = (showSf && sfStart) ? pseudoCard(sfStart.kind === 'startfinish' ? 'Start / Mål' : 'Start', sfStart.name, 'start', escapeHtml(sfStart.label)) : '';
  const finishRow = (showSf && sfFinish) ? pseudoCard('Mål', sfFinish.name, 'finish', escapeHtml(sfFinish.label)) : '';

  const ctrlRows = rows.map(c => {
    const done = isDone(c.id);
    const score = scoresForPatrol[c.id];
    const name = displayName(c);
    const anon = isAnonymous() && !done;
    return `
      <button type="button" class="start-ctrl ${done ? 'done' : ''}" data-id="${c.id}">
        <div class="start-ctrl-no">${escapeHtml(String(c.nummer ?? '?'))}</div>
        <div class="start-ctrl-body">
          <div class="start-ctrl-name ${anon ? 'anon' : ''}">${escapeHtml(name)}</div>
          <div class="start-ctrl-sub">${done ? 'Rapporterad' : (c.open ? 'Öppen · inte klar' : 'Stängd · inte klar')}</div>
        </div>
        ${done
          ? `<span class="start-ctrl-score">${score.poang}${score.extraPoang ? '+' + score.extraPoang : ''}</span>`
          : `<span class="start-ctrl-status">Kvar</span>`}
      </button>
    `;
  }).join('');

  return parkingRow + startRow + ctrlRows + finishRow;
}

// --- Flip card (reuses reporter page CSS/markup) ---
let flipMapLoaded = false;
function wireFlipCard() {
  const card = document.getElementById('flip-card');
  const inner = card?.querySelector('.flip-card-inner');
  const openBtn = document.getElementById('flip-open');
  const closeBtn = document.getElementById('flip-close');
  const front = card?.querySelector('.flip-front');
  const back = card?.querySelector('.flip-back');
  if (!card || !openBtn || !inner) return;

  const applyHeight = () => {
    const on = card.classList.contains('flipped');
    inner.style.minHeight = (on ? back.offsetHeight : front.offsetHeight) + 'px';
  };
  const setFlipped = (on) => {
    card.classList.toggle('flipped', on);
    openBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    back.setAttribute('aria-hidden', on ? 'false' : 'true');
    applyHeight();
  };
  openBtn.addEventListener('click', () => setFlipped(!card.classList.contains('flipped')));
  closeBtn?.addEventListener('click', () => setFlipped(false));
  requestAnimationFrame(applyHeight);
}

// --- Overview map with all control pins ---
// The live map node is kept across re-renders (see render()); only the
// control pins are dynamic (done-state colors) and live in their own layer.
let overviewMap = null;
let controlPinLayer = null;

// Control markers — labels show only the number. Done controls are greyed
// out so the scout can see at a glance which ones are left.
function drawControlPins(L, ordered) {
  if (controlPinLayer) { try { controlPinLayer.remove(); } catch {} }
  controlPinLayer = L.layerGroup().addTo(overviewMap);
  for (const c of ordered) {
    const done = isDone(c.id);
    L.circleMarker([c.lat, c.lng], {
      radius: done ? 11 : 14,
      color: done ? '#d0d0d0' : '#ffffff',
      weight: done ? 2 : 3,
      fillColor: done ? '#8a8a8a' : '#E95F13',
      fillOpacity: done ? 0.55 : 0.98
    })
      .bindTooltip(String(c.nummer ?? '?'), {
        permanent: true,
        direction: 'center',
        className: 'start-map-label' + (done ? ' start-map-label-done' : '')
      })
      .addTo(controlPinLayer);
  }
}
let overviewMapMode = null; // 'full' | 'hidden' — läget byter → kartan byggs om
async function renderOverviewMap(withPos) {
  const host = document.getElementById('start-map');
  if (!host) return;
  try {
    const L = await ensureLeaflet();
    // Host might have been replaced while we awaited Leaflet.
    const currentHost = document.getElementById('start-map');
    if (!currentHost) return;

    const ordered = [...withPos].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
    const mode = positionsVisible() ? 'full' : 'hidden';

    // Batteri: när kartnoden behållits över en re-render (render() byter in
    // den levande noden) räcker det att rita om kontrollpinnarna — tiles,
    // spår och S/M/P är statiska. Byter synlighetsläget (positionssläppet)
    // byggs kartan om från grunden.
    if (overviewMap && currentHost === overviewMap.getContainer() && mode === overviewMapMode) {
      if (mode === 'full') drawControlPins(L, ordered);
      return;
    }

    // Dispose any previous map — especially if it's bound to a stale node.
    if (overviewMap) {
      try { overviewMap.remove(); } catch { /* redan nere */ }
      overviewMap = null;
      controlPinLayer = null;
    }
    overviewMapMode = mode;

    const sfPoints = startFinishPoints(comp);
    const mapPlaces = compPlaces(comp);
    const anchor = (mode === 'full' ? ordered[0] : null) || sfPoints[0] || mapPlaces[0] || ordered[0];
    if (!anchor) return;

    overviewMap = L.map(currentHost, { zoomControl: true, scrollWheelZoom: false })
      .setView([anchor.lat, anchor.lng], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OSM'
    }).addTo(overviewMap);

    if (mode === 'full') {
      // Course line: a drawn track (Spår editor) is always the one shown —
      // drawn legs solid along the actual path, undrawn legs dashed fågelväg.
      const { legs, hasDrawn } = courseLegs(comp, ordered, track);
      drawCourseOnMap(L, overviewMap, legs);
      if (hasDrawn) addCourseChip(L, overviewMap, legs, track && track.speedKmh);
      drawControlPins(L, ordered);
    } else if (ordered.length >= 3) {
      // Hemliga positioner: skuggat "Tävlingsområde" i stället för nålar och
      // spår — samma grepp som publika sidan före släppet.
      const hull = competitionArea(ordered.map(c => ({ lat: c.lat, lng: c.lng })));
      if (hull) {
        L.polygon(hull, {
          color: '#003660', weight: 1.5, dashArray: '6 8',
          fillColor: '#003660', fillOpacity: 0.12, interactive: false
        }).addTo(overviewMap).bindTooltip('Tävlingsområde', { direction: 'center' });
      }
    }

    // Start/finish markers — distinct (rover-yellow). One "S/M" if same, else "S" and "M".
    for (const p of sfPoints) {
      L.circleMarker([p.lat, p.lng], {
        radius: 16,
        color: '#003660',
        weight: 3,
        fillColor: '#E2E000',
        fillOpacity: 1
      })
        .bindTooltip(p.label, { permanent: true, direction: 'center', className: 'start-map-label start-map-label-sf' })
        .addTo(overviewMap);
    }

    // Intressepunkter — gemensam ritning (places.js).
    for (const m of drawPlaces(L, overviewMap, mapPlaces, { iconHtml: (n) => icon(n, { size: 18, stroke: 2.5 }) })) {
      m.getTooltip()?.getElement()?.classList.add('start-map-label', 'start-map-label-place');
    }

    // Fit bounds covering all markers incl. start/finish + parking
    const allPts = mode === 'full' ? ordered.map(c => [c.lat, c.lng]) : [];
    if (mode === 'hidden' && ordered.length >= 3) {
      const hull = competitionArea(ordered.map(c => ({ lat: c.lat, lng: c.lng })));
      if (hull) allPts.push(...hull);
    }
    for (const p of sfPoints) allPts.push([p.lat, p.lng]);
    for (const pl of mapPlaces) allPts.push([pl.lat, pl.lng]);
    if (allPts.length > 1) {
      overviewMap.fitBounds(L.latLngBounds(allPts).pad(0.25));
    }
    setTimeout(() => overviewMap && overviewMap.invalidateSize(), 100);
  } catch (e) {
    host.innerHTML = `<div class="r-empty">Kartan kunde inte laddas.</div>`;
  }
}

// --- Control detail sheet (reuses reporter's sheet CSS) ---
function openControlSheet(ctrlId) {
  const c = controls.find(x => x.id === ctrlId);
  if (!c) return;
  const done = isDone(c.id);
  const score = scoresForPatrol[c.id];
  const name = displayName(c);
  const anon = isAnonymous() && !done;

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet sheet-tall" role="dialog" aria-modal="true">
      <div class="sheet-head">
        <div>
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--r-fg-muted);font-weight:700;">Kontroll #${escapeHtml(String(c.nummer ?? ''))}</div>
          <h2 style="${anon ? 'color:var(--r-fg-muted);font-style:italic;' : ''}">${escapeHtml(name)}</h2>
          <div style="color:var(--r-fg-muted);margin-top:2px;">
            ${done ? `<span style="color:var(--r-success);font-weight:700;">Rapporterad · ${score.poang}${score.extraPoang ? '+' + score.extraPoang : ''} p</span>`
                   : (c.open ? 'Öppen för rapportering' : 'Inte öppen ännu')}
          </div>
        </div>
        <button type="button" class="sheet-close" id="close" aria-label="Stäng">${icon('x', { size: 22 })}</button>
      </div>

      ${c.lat && c.lng && positionsVisible() ? `
        <div class="detail-field" style="margin-top:6px;">
          <div class="dfl">Koordinater (vid nödsituation)</div>
          <div class="detail-coord">${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}</div>
        </div>
        <div class="flip-dist-chip" id="detail-dist" hidden></div>
        <div class="detail-map detail-map-tall" id="ctrl-detail-map"></div>
      ` : ''}
      ${c.lat && c.lng && !positionsVisible() ? `
        <div class="detail-field" style="margin-top:6px;">
          <div class="dfl">Plats & karta</div>
          <p style="margin:0;">${escapeHtml(releaseText())}</p>
        </div>
      ` : ''}

      ${anon ? `
        <div class="detail-field">
          <div class="dfl">Tävlingsregel</div>
          <p style="margin:0;">Kontrollens uppgift avslöjas först när ni rapporterat poäng.</p>
        </div>
      ` : ''}
    </div>
  `;
  document.body.appendChild(overlay);
  lockScroll();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    unlockScroll();
  };
  // bindTap fires on touchstart — instant, reliable closing on mobiles where
  // iOS' double-tap-zoom heuristic delays or swallows plain clicks. The
  // backdrop close only triggers when a still tap starts AND ends on the
  // backdrop, so map-drags and scrolls can never close the sheet by mistake.
  bindTap(overlay.querySelector('#close'), close);
  wireOverlayClose(overlay, close);

  if (c.lat && c.lng && positionsVisible()) {
    ensureLeaflet().then(L => {
      const host = overlay.querySelector('#ctrl-detail-map');
      const map = L.map(host, { zoomControl: true, scrollWheelZoom: true }).setView([c.lat, c.lng], 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© OSM'
      }).addTo(map);

      // --- The way here: course context around this control -----------------
      // The whole course in muted gray, the leg INTO this control lit up in
      // accent orange, visited controls grayed with their number, upcoming
      // ones as "?", S/M for orientation. The view frames the lit leg so the
      // patrol sees exactly where to walk from the previous point.
      const { nodes, legs } = courseLegs(comp, controls, track);
      const targetIdx = nodes.findIndex(n => n.key === c.id);
      const legIn = targetIdx > 0 ? legs[targetIdx - 1] : null;

      for (const leg of legs) {
        const lit = leg === legIn;
        L.polyline(legLatLngs(leg), {
          color: lit ? '#E95F13' : '#8a8a8a',
          weight: lit ? 5 : 2.5,
          opacity: lit ? 0.95 : 0.45,
          ...(leg.drawn ? {} : { dashArray: lit ? '10 10' : '5 8' }),
          interactive: false
        }).addTo(map);
      }

      for (const n of nodes) {
        if (n.key === c.id) continue;
        if (n.kind === 'control') {
          const nd = isDone(n.key);
          L.circleMarker([n.lat, n.lng], {
            radius: 9,
            color: nd ? '#d0d0d0' : '#ffffff', weight: 2,
            fillColor: nd ? '#8a8a8a' : '#003660',
            fillOpacity: nd ? 0.55 : 0.85
          })
            .bindTooltip(nd ? n.label : '?', {
              permanent: true, direction: 'center',
              className: 'start-map-label' + (nd ? ' start-map-label-done' : '')
            })
            .addTo(map);
        } else {
          // Start/Mål — small yellow anchors for orientation.
          L.circleMarker([n.lat, n.lng], {
            radius: 12, color: '#003660', weight: 2.5,
            fillColor: '#E2E000', fillOpacity: 1
          })
            .bindTooltip(n.label, { permanent: true, direction: 'center', className: 'start-map-label start-map-label-sf' })
            .addTo(map);
        }
      }

      L.circleMarker([c.lat, c.lng], {
        radius: 14, color: '#ffffff', weight: 3,
        fillColor: done ? '#8a8a8a' : '#E95F13',
        fillOpacity: done ? 0.6 : 0.98
      })
        .bindTooltip(String(c.nummer ?? '?'), {
          permanent: true, direction: 'center',
          className: 'start-map-label' + (done ? ' start-map-label-done' : '')
        })
        .addTo(map);

      // Frame the lit leg (previous point → this control) when there is one.
      if (legIn) map.fitBounds(L.latLngBounds(legLatLngs(legIn)).pad(0.3));

      // --- "Follow me" control ---
      let userMarker = null, userLine = null, watchId = null;
      const distChip = overlay.querySelector('#detail-dist');

      const setBtnState = (btn, on) => {
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.innerHTML = on ? icon('x', { size: 18 }) : icon('locate', { size: 18 });
        btn.title = on ? 'Sluta följa min plats' : 'Visa min plats';
      };

      const stopLocate = (btn) => {
        if (watchId != null) navigator.geolocation.clearWatch(watchId);
        watchId = null;
        if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
        if (userLine)   { map.removeLayer(userLine);   userLine = null; }
        if (distChip) distChip.hidden = true;
        if (btn) setBtnState(btn, false);
      };

      const toggleLocate = (btn) => {
        if (!navigator.geolocation) return;
        if (watchId != null) { stopLocate(btn); return; }
        setBtnState(btn, true);
        let firstFix = true;
        watchId = navigator.geolocation.watchPosition((pos) => {
          const { latitude: ulat, longitude: ulng, accuracy } = pos.coords;
          if (!userMarker) {
            userMarker = L.circleMarker([ulat, ulng], {
              radius: 9, color: '#ffffff', weight: 3,
              fillColor: '#00A8E1', fillOpacity: 0.95, className: 'user-pulse'
            }).addTo(map);
            userLine = L.polyline([[ulat, ulng], [c.lat, c.lng]], {
              color: '#00A8E1', weight: 3, dashArray: '6 8', opacity: 0.85
            }).addTo(map);
          } else {
            userMarker.setLatLng([ulat, ulng]);
            userLine.setLatLngs([[ulat, ulng], [c.lat, c.lng]]);
          }
          if (firstFix) {
            firstFix = false;
            map.fitBounds(L.latLngBounds([[ulat, ulng], [c.lat, c.lng]]).pad(0.4));
          }
          const m = haversineMeters([ulat, ulng], [c.lat, c.lng]);
          if (distChip) {
            distChip.hidden = false;
            distChip.innerHTML = `<span class="flip-dist-label">Avstånd</span><span class="flip-dist-val">${formatDistance(m)}</span>${accuracy ? `<span class="flip-dist-acc">±${Math.round(accuracy)} m</span>` : ''}`;
          }
        }, () => stopLocate(btn), { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 });
      };

      const LocateControl = L.Control.extend({
        onAdd() {
          const btn = L.DomUtil.create('button', 'flip-locate-btn');
          btn.setAttribute('aria-label', 'Visa min plats');
          setBtnState(btn, false);
          L.DomEvent.disableClickPropagation(btn);
          btn.addEventListener('click', () => toggleLocate(btn));
          return btn;
        }
      });
      new LocateControl({ position: 'topright' }).addTo(map);

      // Stop watching when the sheet closes
      const origRemove = overlay.remove.bind(overlay);
      overlay.remove = () => { stopLocate(null); origRemove(); };

      setTimeout(() => map.invalidateSize(), 80);
    });
  }
}

// Ticker that keeps the "Starttid" chip in sync with the clock.
let countdownInterval = null;
function wireStartCountdown() {
  const chip = document.getElementById('start-time-chip');
  const out = document.getElementById('start-time-countdown');
  if (!chip || !out) return;
  if (countdownInterval) clearInterval(countdownInterval);
  const startIso = chip.dataset.start;
  if (!startIso) return;
  const startAt = new Date(startIso);
  // Use the effective interval (honors range mode) for the "GÅ nu"-window.
  const intervalMs = (patrols && patrols.length
    ? Math.max(1000, effectiveIntervalSecValue(comp, patrols.length) * 1000)
    : startTimeSettings(comp).intervalMinutes * 60 * 1000);
  const intervalMin = intervalMs / 60000;
  // Maxtid-chip: räknar ner mot planerad start + maxtid, syns först när
  // patrullen startat (planerad tid passerad) och rödmarkeras sista kvarten.
  const maxChip = document.getElementById('start-max-chip');
  const maxOut = document.getElementById('start-max-countdown');
  const maxDeadline = maxChip?.dataset.deadline ? new Date(maxChip.dataset.deadline) : null;

  let lastPosVisible = positionsVisible();
  let lastMayStart = mayConfirmStart();
  const tick = () => {
    const now = new Date();
    // Två saker ska slå om av sig själva, utan omladdning: positionssläppet
    // (5 min före första start) och bekräfta-knappen när patrullens egen
    // starttid går in. Kortet ligger uppe i fickan medan man väntar.
    const vis = positionsVisible();
    const may = mayConfirmStart(now);
    if (vis !== lastPosVisible || may !== lastMayStart) {
      lastPosVisible = vis;
      lastMayStart = may;
      render();
      return; // render() drar igång en ny wireStartCountdown-tick
    }
    const ms = startAt - now;
    chip.classList.remove('go', 'past');
    if (ms <= 0 && Math.abs(ms) < intervalMin * 60 * 1000) {
      chip.classList.add('go');
      out.textContent = 'Gå nu!';
    } else if (ms <= 0) {
      chip.classList.add('past');
      out.textContent = `startade ${formatRelative(-ms)} sedan`;
    } else {
      out.textContent = `om ${formatRelative(ms)}`;
    }
    if (maxChip && maxDeadline) {
      const started = selfStartEnabled() ? selfStarted() : now >= startAt;
      maxChip.hidden = !started;
      if (started) {
        const left = maxDeadline - now;
        maxOut.textContent = left > 0 ? `${formatRelative(left)} kvar` : `slut för ${formatRelative(-left)} sedan`;
        maxChip.classList.toggle('is-late', left <= 15 * 60000);
      }
    }
  };
  tick();
  countdownInterval = setInterval(tick, 1000);

  // Batteri: pausa sekundtickern när fliken ligger i bakgrunden.
  if (!wireStartCountdown._visWired) {
    wireStartCountdown._visWired = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
      } else {
        wireStartCountdown();
      }
    });
  }
}

function formatRelative(ms) {
  const total = Math.round(ms / 1000);
  // Startkortet öppnas ofta dagar före tävlingen — nedräkningen måste kunna
  // säga "om 12 dagar", inte bara timmar.
  const dd = Math.floor(total / 86400);
  const hh = Math.floor((total % 86400) / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  if (dd > 0) return `${dd} ${dd === 1 ? 'dag' : 'dagar'}${hh > 0 ? ` ${hh} h` : ''}`;
  if (hh > 0) return `${hh}h ${mm}m`;
  if (mm > 0) return `${mm} min ${String(ss).padStart(2,'0')}s`;
  return `${ss} s`;
}

// Haversine distance + formatting for the "follow me" chip.
function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
  const c = s1 * s1 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * s2 * s2;
  return 2 * R * Math.asin(Math.sqrt(c));
}
function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

// --- Start/finish/parking detail sheet ---
function openStartFinishSheet(kind) {
  let p;
  if (String(kind).startsWith('place:')) {
    const pl = compPlaces(comp).find(x => x.id === String(kind).slice(6));
    p = pl ? { ...pl, label: '', title: placeKind(pl.kind).label } : null;
  } else if (kind === 'finish') {
    p = startFinishPoints(comp).find(x => x.kind === 'finish');
  } else {
    p = startFinishPoints(comp).find(x => x.kind === 'start' || x.kind === 'startfinish');
  }
  if (!p) return;
  // En intressepunkt ritas i sin egen färg och symbol; start/mål har sin
  // fasta gula look på alla kartor.
  const isPlace = String(kind).startsWith('place:');

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet-head">
        <div>
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--r-fg-muted);font-weight:700;">${escapeHtml(p.title)}</div>
          <h2>${escapeHtml(p.name || (p.kind === 'startfinish' ? 'Start / Mål' : p.title))}</h2>
          <div style="color:var(--r-fg-muted);margin-top:2px;">Specialplats · inga poäng</div>
        </div>
        <button type="button" class="sheet-close" id="close" aria-label="Stäng">${icon('x', { size: 22 })}</button>
      </div>

      <div class="detail-field" style="margin-top:6px;">
        <div class="dfl">Koordinater</div>
        <div class="detail-coord">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
      </div>
      <div class="detail-map" id="sf-detail-map"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  lockScroll();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    unlockScroll();
  };
  bindTap(overlay.querySelector('#close'), close);
  wireOverlayClose(overlay, close);

  ensureLeaflet().then(L => {
    const host = overlay.querySelector('#sf-detail-map');
    const map = L.map(host, { zoomControl: true, scrollWheelZoom: false }).setView([p.lat, p.lng], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OSM'
    }).addTo(map);

    // Same course context as the control sheet — for Start the lit leg is
    // the way OUT (to the first control), for Mål the way IN (from the last
    // control), for a combined S/M both. Parking stays a plain marker (it
    // isn't on the course). Före positionssläppet ritas INGEN bankontext —
    // benen avslöjar kontrollernas platser.
    let litBounds = null;
    if (!isPlace && positionsVisible()) {
      const { nodes, legs } = courseLegs(comp, controls, track);
      const litLegs = new Set();
      const firstOut = legs.find(l => l.from.key === '__start');
      const lastIn = legs.find(l => l.to.key === '__mal');
      if ((kind === 'start' || p.kind === 'startfinish') && firstOut) litLegs.add(firstOut);
      if ((kind === 'finish' || p.kind === 'startfinish') && lastIn) litLegs.add(lastIn);

      for (const leg of legs) {
        const lit = litLegs.has(leg);
        L.polyline(legLatLngs(leg), {
          color: lit ? '#E95F13' : '#8a8a8a',
          weight: lit ? 5 : 2.5,
          opacity: lit ? 0.95 : 0.45,
          ...(leg.drawn ? {} : { dashArray: lit ? '10 10' : '5 8' }),
          interactive: false
        }).addTo(map);
      }

      for (const n of nodes) {
        if (n.kind !== 'control') continue; // S/M drawn big below
        const nd = isDone(n.key);
        L.circleMarker([n.lat, n.lng], {
          radius: 9,
          color: nd ? '#d0d0d0' : '#ffffff', weight: 2,
          fillColor: nd ? '#8a8a8a' : '#003660',
          fillOpacity: nd ? 0.55 : 0.85
        })
          .bindTooltip(nd ? n.label : '?', {
            permanent: true, direction: 'center',
            className: 'start-map-label' + (nd ? ' start-map-label-done' : '')
          })
          .addTo(map);
      }

      if (litLegs.size) {
        litBounds = L.latLngBounds([]);
        for (const leg of litLegs) legLatLngs(leg).forEach(ll => litBounds.extend(ll));
      }
    }

    L.circleMarker([p.lat, p.lng], {
      radius: 16,
      color: isPlace ? '#ffffff' : '#003660',
      weight: 3,
      fillColor: isPlace ? (p.colorHex || '#003660') : '#E2E000',
      fillOpacity: 1
    })
      .bindTooltip(isPlace ? icon(p.icon || 'map-pin', { size: 18, stroke: 2.5 }) : p.label, {
        permanent: true,
        direction: 'center',
        className: 'start-map-label ' + (isPlace ? 'start-map-label-place' : 'start-map-label-sf')
      })
      .addTo(map);
    if (litBounds && litBounds.isValid()) map.fitBounds(litBounds.pad(0.3));
    setTimeout(() => map.invalidateSize(), 80);
  });
}

// --- Error view ---
function renderError(msg) {
  root.innerHTML = `<div class="r-empty">${escapeHtml(msg)}</div>`;
}

main().catch(e => {
  console.error(e);
  renderError('Fel vid inläsning: ' + e.message);
});
