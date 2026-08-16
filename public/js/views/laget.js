// "Läget" — sekretariatets tävlingsdagsvy.
//
// Live overview of the competition as it happens: who is still out in the
// woods (via the Start/Mål-station), which patrols have gone silent, and
// where patrols are stacking up. Queue pressure per control is estimated
// from reporting order: the course runs start → 1 → 2 → … → mål, so an
// active patrol whose latest report is control N-1 is walking to or queuing
// at control N. Rising leg times (median minutes from previous control)
// confirm a bottleneck — time to reallocate crew.

import { layout, setTopbarCompetition, registerViewCleanup } from '../app.js';
import {
  getCompetition, listPatrols, listStations, createStation, watchPassages, watchSelfPassages, clearSelfPassage,
  watchControls, watchScoresForControl, getTrack, getControlMeta, watchControlBeacon,
  updateCompetition, updateControl, setPatrolUtgatt, createBroadcastMessage, loggHandelse, watchLogg
} from '../store.js';
import { deleteField } from '../firebase.js';
import { compPlaces, placeKind, drawPlaces } from '../places.js';
import { courseLegs, drawCourseOnMap, courseEtaCalibrated, patrolFinishEtaMs } from '../course.js';
import {
  escapeHtml, toast, copyToClipboard, formatTime, patrolStartTime, patrolStartDateTime, avdShort, patrolLabel,
  isCompAdminUser, withBusy, confirmDialog, promptDialog, startFinishPoints
} from '../utils.js';
import { solnedgang } from '../sol.js';
import { hamtaVader, vaderMeddelande } from '../vader.js';
import { byggDagskopia, sparaDagskopia, listaDagskopior, KOPIA_INTERVALL_MS } from '../dagskopia.js';
import { ensureLeaflet } from '../leaflet.js';
import { renderQrToImg } from '../pdf.js';
import { icon } from '../icons.js';
import { help } from '../help.js';
import { compHeader, compLabel, setDocTitle } from '../nav.js';

const WARN_SILENT_MIN = 60;   // patrol out with no sign of life this long → warning
const CTRL_STALE_MIN = 45;    // control silent this long WITH inbound patrols → red

const HEAT = {
  green:  { fill: '#41A62A', label: 'Lugnt' },
  yellow: { fill: '#E2B100', label: 'Kö byggs upp' },
  red:    { fill: '#DA005E', label: 'Flaskhals' }
};

let unsubs = [];
function cleanup() {
  unsubs.forEach(u => { try { u(); } catch {} });
  unsubs = [];
}

export async function renderLaget(app, user, cid) {
  cleanup();

  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="muted">Laddar…</div>`;
  layout(wrap);

  const comp = await getCompetition(cid).catch(() => null);
  if (!wrap.isConnected) return;
  if (!comp) { wrap.innerHTML = `<div class="empty"><h3>Tävlingen hittades inte</h3></div>`; return; }
  setTopbarCompetition(cid, comp, user);
  const isAdmin = isCompAdminUser(comp, user);

  let patrols = [];
  let controls = [];
  let vaderHamtat = false;   // prognosen hämtas en gång per sidladdning
  let sistaKopia = 0;        // strypning: högst en dagskopia per intervall
  let sistaKopiaPoang = -1;  // ...men alltid när kopian blivit rikare
  // Start och mål kan komma från tre håll: start/mål-stationens av-
  // prickningar, patrullens egna knappar på startkortet, och — om tävlingen
  // slagit på det — en målgång HÄRLEDD ur sista kontrollrapporten. Råformerna
  // hålls isär och slås ihop till EN bild; resten av vyn läser bara
  // `passages` och behöver inte veta varifrån tiden kom.
  //
  // Rangordningen är densamma överallt: en funktionär som SETT patrullen
  // väger tyngst, sedan patrullens egen knapptryckning, sist det härledda.
  let stationPassages = {};
  let selfPassages = {};
  let passages = {};   // patrolId -> { startAt, finishAt, selfStarted?, selfFinished?, autoFinished? }

  const mergePassages = () => {
    passages = {};
    for (const [pid, row] of Object.entries(stationPassages)) passages[pid] = { ...row };
    for (const [pid, row] of Object.entries(selfPassages)) {
      const cur = passages[pid] || (passages[pid] = {});
      if (!cur.startAt && row.startAt) { cur.startAt = row.startAt; cur.selfStarted = true; }
      if (!cur.finishAt && row.finishAt) { cur.finishAt = row.finishAt; cur.selfFinished = true; }
    }
    if (comp.autoFinish !== true) return;
    // Härledd målgång: alla kontroller rapporterade → sista rapportens tid.
    // Ingen skrivning — måltiden ligger redan i poängdatan. Se hjälptexten
    // för varför den bara ska användas när sista kontrollen ÄR målet.
    if (!controls.length) return;
    for (const p of patrols) {
      const cur = passages[p.id] || (passages[p.id] = {});
      if (cur.finishAt) continue;
      let senast = null, antal = 0;
      for (const c of controls) {
        const sc = (scoresByCtrl[c.id] || []).find(x => x.patrolId === p.id);
        if (!sc) break;                       // lucka → inte i mål
        antal++;
        const t = toDate(sc.clientReportedAt ?? sc.reportedAt);
        if (t && (!senast || t > senast)) senast = t;
      }
      if (antal === controls.length && senast) { cur.finishAt = senast; cur.autoFinished = true; }
    }
  };
  let scoresByCtrl = {}; // ctrlId -> [{patrolId, reportedAt}]
  let station = null;
  let track = null;

  try {
    [patrols, station, track] = await Promise.all([
      listPatrols(cid),
      listStations(cid).then(s => s[0] || null).catch(() => null),
      getTrack(cid).catch(() => null)
    ]);
  } catch (e) {
    wrap.innerHTML = `<div class="empty"><h3>Kunde inte ladda</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }
  if (!wrap.isConnected) return;

  setDocTitle('Läget', compLabel(comp));
  wrap.innerHTML = `
    ${compHeader(cid, comp, user, {
      active: 'laget', title: 'Läget',
      subtitle: 'Tävlingsdagsvy — uppdateras live när kontrollanter rapporterar och stationen checkar in.'
    })}

    <div id="broadcast-card"></div>
    <div id="station-card"></div>
    <div class="kpi-row" id="kpis"></div>
    <div id="tidslinje"></div>
    <div id="vader"></div>
    <div id="dagskopia"></div>
    <div id="logg"></div>

    <div class="grid" style="grid-template-columns:1fr;gap:var(--sp-6);">
      <div>
        <div class="row" style="justify-content:space-between;align-items:baseline;">
          <h2 class="t-h2">Kontroller — kötryck</h2>
          <span class="muted t-sm">Kö = patruller på väg från föregående kontroll</span>
        </div>
        <div class="card" style="padding:var(--sp-3);">
          <div id="laget-map" style="height:340px;border-radius:var(--r-md);"></div>
          <div class="row wrap t-sm muted" style="gap:var(--sp-4);padding:8px 6px 2px;">
            ${Object.values(HEAT).map(h => `<span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:12px;height:12px;border-radius:50%;background:${h.fill};display:inline-block;"></span>${h.label}</span>`).join('')}
          </div>
        </div>
        <div id="ctrl-table" class="mt-4"></div>
      </div>
      <div>
        <h2 class="t-h2">Patruller</h2>
        <div id="patrol-table"></div>
      </div>
    </div>
  `;

  // --- Driftmeddelanden — flyttade till egen flik --------------------------
  // Composern bor numera i Meddelanden-fliken (parallella meddelanden,
  // bekräftelser, kvittensöversikt). Här finns bara en genväg dit + en
  // indikator när något är aktivt.
  const bcCard = wrap.querySelector('#broadcast-card');
  if (bcCard) {
    const legacyActive = comp.broadcast && (comp.broadcast.text || '').trim();
    bcCard.innerHTML = `
      <div class="card mb-4" style="padding:var(--sp-3) var(--sp-4);">
        <div class="row wrap" style="justify-content:space-between;align-items:center;gap:var(--sp-3);">
          <div>
            <strong>Driftmeddelanden</strong>
            <span class="muted t-sm" style="margin-left:8px;">Banner till kontroller, station, startkort och startskärm
              <span id="bc-active-note">${legacyActive ? '<span class="badge badge-yellow">äldre meddelande aktivt</span>' : ''}</span>
            </span>
          </div>
          <a class="btn btn-secondary btn-sm" href="/app/c/${cid}/meddelanden" data-link>Till Meddelanden →</a>
        </div>
      </div>`;
    // Live-indikator: syns här när meddelanden är aktiva (kritiska markeras)
    // så sekretariatet ser läget utan att byta flik.
    import('../store.js').then(({ watchBroadcastMessages }) => {
      unsubs.push(watchBroadcastMessages(cid, msgs => {
        const el = bcCard.querySelector('#bc-active-note');
        if (!el) return;
        const active = msgs.filter(m => m.active !== false);
        const kritisk = active.some(m => m.level === 'kritisk');
        el.innerHTML = [
          active.length ? `<span class="badge ${kritisk ? 'badge-pink' : 'badge-blue'}">${active.length} aktiva${kritisk ? ' · KRITISK' : ''}</span>` : '',
          legacyActive ? '<span class="badge badge-yellow">äldre meddelande aktivt</span>' : ''
        ].filter(Boolean).join(' ');
      }));
    }).catch(() => { /* indikatorn är en bonus */ });
  }

  // --- Station card ----------------------------------------------------------
  const stationCard = wrap.querySelector('#station-card');
  const renderStationCard = () => {
    if (!station) {
      stationCard.innerHTML = `
        <div class="card mb-4" style="border-left:3px solid var(--avent-orange);">
          <strong>Ingen start/mål-station ännu.</strong>
          <p class="muted t-sm" style="margin:4px 0 ${isAdmin ? '10px' : '0'};">Stationen ger in-/utcheckning av patruller — utan den vet Läget bara det som syns i poängrapporterna.</p>
          ${isAdmin ? `<button class="btn btn-primary btn-sm" id="mk-station">Skapa stationslänk</button>` : ''}
        </div>`;
      stationCard.querySelector('#mk-station')?.addEventListener('click', async (e) => {
        try {
          const sid = await createStation(cid);
          station = { id: sid };
          subscribePassages();
          renderStationCard();
          toast('Station skapad', 'success');
        } catch (err) { toast('Fel: ' + err.message, 'error'); }
      });
    } else {
      const url = `${location.origin}/m/${cid}/${station.id}`;
      stationCard.innerHTML = `
        <div class="card mb-4">
          <div class="row wrap" style="gap:var(--sp-4);align-items:center;">
            <div id="station-qr" style="width:96px;height:96px;flex-shrink:0;"></div>
            <div style="flex:1;min-width:240px;">
              <strong>Start/Mål-stationen</strong>
              <p class="muted t-sm" style="margin:4px 0 8px;">Ge länken (eller QR-koden) till funktionärerna vid start och mål — de checkar ut patruller vid start och in vid målgång. Länken är hemlig.</p>
              <div class="row wrap" style="gap:var(--sp-2);">
                <input class="input mono t-sm js-selectall" readonly value="${escapeHtml(url)}" style="max-width:340px;">
                <button class="btn btn-secondary btn-sm" id="copy-station">${icon('copy', { size: 14 })} Kopiera</button>
                <a class="btn btn-ghost btn-sm" href="${escapeHtml(url)}" target="_blank" rel="noopener">${icon('external', { size: 14 })} Öppna</a>
              </div>
              <div class="row wrap mt-2" style="gap:var(--sp-2);">
                <button class="btn btn-ghost btn-sm" id="copy-station-start" title="Länk som öppnar direkt på startfliken — till startfunktionären">${icon('copy', { size: 14 })} Startfliken</button>
                <button class="btn btn-ghost btn-sm" id="copy-station-mal" title="Länk som öppnar direkt på målfliken — till målfunktionären">${icon('copy', { size: 14 })} Målfliken</button>
              </div>
            </div>
          </div>
        </div>`;
      stationCard.querySelector('.js-selectall')?.addEventListener('click', (e) => e.target.select());
      stationCard.querySelector('#copy-station').addEventListener('click', () => {
        copyToClipboard(url);
        toast('Stationslänk kopierad', 'success');
      });
      stationCard.querySelector('#copy-station-start')?.addEventListener('click', () => {
        copyToClipboard(`${url}?flik=start`);
        toast('Länk till startfliken kopierad', 'success');
      });
      stationCard.querySelector('#copy-station-mal')?.addEventListener('click', () => {
        copyToClipboard(`${url}?flik=mal`);
        toast('Länk till målfliken kopierad', 'success');
      });
      const qrHost = stationCard.querySelector('#station-qr');
      renderQrToImg(url, 96).then(img => { qrHost.innerHTML = ''; qrHost.appendChild(img); }).catch(() => {});
    }
  };
  renderStationCard();

  // --- Subscriptions -----------------------------------------------------------
  const subscribedScores = new Set();
  const beaconByCtrl = {};   // ctrlId -> beacon-doc — kontrollens livstecken
  const subscribePassages = () => {
    if (!station) return;
    unsubs.push(watchPassages(cid, station.id, rows => {
      stationPassages = {};
      rows.forEach(p => { stationPassages[p.id] = p; });
      renderStats();
    }));
  };
  subscribePassages();

  // Självbekräftade starter finns även när tävlingen saknar startstation.
  unsubs.push(watchLogg(cid, rader => ritaLogg(rader)));
  unsubs.push(watchSelfPassages(cid, rows => {
    selfPassages = {};
    rows.forEach(r => { selfPassages[r.id] = r; });
    renderStats();
  }));

  const ctrlMetaById = {};
  async function mergeControlMeta(rows) {
    const missing = rows.filter(r => !(r.id in ctrlMetaById));
    if (missing.length) {
      const metas = await Promise.all(missing.map(r => getControlMeta(cid, r.id).catch(() => ({}))));
      missing.forEach((r, i) => { ctrlMetaById[r.id] = metas[i] || {}; });
    }
    rows.forEach(r => { r.telefon = ctrlMetaById[r.id]?.telefon || ''; });
  }

  unsubs.push(watchControls(cid, async rows => {
    // telefon lives in each control's member-only private/meta — merge it in
    // (cached) so the Läget table can quick-dial the kontrollant.
    await mergeControlMeta(rows);
    controls = rows;
    for (const c of controls) {
      if (subscribedScores.has(c.id)) continue;
      subscribedScores.add(c.id);
      unsubs.push(watchScoresForControl(cid, c.id, scores => {
        scoresByCtrl[c.id] = scores;
        renderStats();
      }));
      // Livstecknet från kontrollens telefon (batteri, köade offline-poäng).
      unsubs.push(watchControlBeacon(cid, c.id, b => {
        beaconByCtrl[c.id] = b;
        renderStats();
      }));
    }
    renderStats();
    initMap();
  }));

  const tick = setInterval(() => renderStats(), 30000); // keep "X min sedan" fresh
  registerViewCleanup(() => { cleanup(); clearInterval(tick); mapInstance?.remove?.(); mapInstance = null; });

  // --- Derived stats -----------------------------------------------------------
  const toDate = (ts) => ts && typeof ts.toDate === 'function' ? ts.toDate() : (ts ? new Date(ts) : null);
  const minSince = (d, now) => d ? Math.floor((now - d) / 60000) : null;

  // Demospår: pin the clock to the newest timestamp in the data (+5 min).
  // The seeded snapshot is one frozen mid-race moment — with a real clock it
  // would age into "everything red, everyone silent" within the hour.
  function virtualNow() {
    if (!comp.demo) return new Date();
    let max = null;
    const consider = (ts) => { const d = toDate(ts); if (d && (!max || d > max)) max = d; };
    Object.values(passages).forEach(p => { consider(p.startAt); consider(p.finishAt); });
    Object.values(scoresByCtrl).forEach(list => list.forEach(s => consider(s.reportedAt)));
    return max ? new Date(max.getTime() + 5 * 60000) : new Date();
  }

  function compute() {
    const now = virtualNow();
    const ordered = [...controls].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));

    // Per patrol: reports by control number, position (highest reported), timestamps.
    const perPatrol = patrols.map(p => {
      const pass = passages[p.id] || {};
      const reports = [];
      for (const c of ordered) {
        const s = (scoresByCtrl[c.id] || []).find(x => x.patrolId === p.id);
        if (s && s.reportedAt) reports.push({ nummer: c.nummer ?? 0, t: toDate(s.reportedAt) });
      }
      reports.sort((a, b) => a.nummer - b.nummer);
      const startAt = toDate(pass.startAt);
      const finishAt = toDate(pass.finishAt);
      const position = reports.length ? reports[reports.length - 1].nummer : 0;
      const lastReport = reports.length ? reports.reduce((m, r) => r.t > m ? r.t : m, reports[0].t) : null;
      const lastSeen = [startAt, finishAt, lastReport].filter(Boolean).sort((a, b) => b - a)[0] || null;
      // DNF: en utgått patrull är per definition inte ute i skogen — den
      // räknas bort ur köer, tystnadsvarningar och sen-till-start-larm.
      const utgatt = p.utgatt || null;
      const started = !!startAt || reports.length > 0;
      const active = !utgatt && started && !finishAt;
      const silentMin = active ? minSince(lastSeen, now) : null;
      // Sen till start: planerad tid passerad (3 min marginal) utan livstecken.
      const plannedAt = !started && !utgatt ? patrolStartDateTime(comp, p, now, patrols.length) : null;
      const lateStartMin = plannedAt ? Math.floor((now - plannedAt) / 60000) : 0;
      const lateStart = !utgatt && !started && lateStartMin >= 3;
      return {
        patrol: p, startAt, finishAt,
        selfStarted: !!pass.selfStarted, selfFinished: !!pass.selfFinished, autoFinished: !!pass.autoFinished,
        reports, position, lastReport, lastSeen,
        started, active, silentMin, lateStart, lateStartMin, utgatt,
        warn: !utgatt && ((active && silentMin != null && silentMin >= WARN_SILENT_MIN) || (!started && lateStartMin >= 3))
      };
    });

    // Kalibrerad målgång per aktiv patrull — samma motor som stationens
    // målflik: verkliga mellantider (inkl. kö) + ankare i senaste rapporten.
    // Rapportkartan byggs i ETT svep (inte per patrull), och faktiska
    // starttider skickas in så startförseningar inte dubbelräknas.
    try {
      const allScores = [];
      const reportsByPid = {};
      for (const [ctrlId, list] of Object.entries(scoresByCtrl)) {
        for (const s of list || []) {
          const pid = s.patrolId || s.id;
          allScores.push({ ...s, controlId: ctrlId, patrolId: pid });
          const t = s.clientReportedAt ?? s.reportedAt;
          if (t) (reportsByPid[pid] ||= {})[ctrlId] = t;
        }
      }
      const startMsByPatrol = {};
      for (const pp of perPatrol) {
        if (pp.startAt) startMsByPatrol[pp.patrol.id] = pp.startAt.getTime();
      }
      const etaCal = courseEtaCalibrated(comp, controls, track, allScores, patrols, now, startMsByPatrol);
      if (etaCal.finishMin != null && etaCal.totalDist > 0) {
        for (const pp of perPatrol) {
          pp.finishEtaMs = pp.active
            ? patrolFinishEtaMs(etaCal, reportsByPid[pp.patrol.id], pp.startAt ? pp.startAt.getTime() : null)
            : null;
        }
      }
    } catch { /* ETA är en bonus — aldrig ett fel */ }

    // Per control: done count, last activity, inbound queue, leg times.
    const ctrlStats = ordered.map((c, i) => {
      const prevN = i > 0 ? (ordered[i - 1].nummer ?? 0) : 0;
      const scores = scoresByCtrl[c.id] || [];
      const lastReport = scores
        .map(s => toDate(s.reportedAt)).filter(Boolean)
        .sort((a, b) => b - a)[0] || null;
      const inbound = perPatrol.filter(pp =>
        pp.active && pp.position === prevN && (i > 0 || pp.started)
      ).length;

      // Leg time: minutes from the previous checkpoint (previous control's
      // report, or start check-out for the first control) to this report.
      const legs = [];
      for (const pp of perPatrol) {
        const here = pp.reports.find(r => r.nummer === (c.nummer ?? 0));
        if (!here) continue;
        const prevT = i > 0
          ? pp.reports.filter(r => r.nummer <= prevN).map(r => r.t).sort((a, b) => b - a)[0] || null
          : pp.startAt;
        if (prevT && here.t > prevT) legs.push({ t: here.t, min: (here.t - prevT) / 60000 });
      }
      legs.sort((a, b) => a.t - b.t);
      const median = (arr) => {
        if (!arr.length) return null;
        const v = arr.map(x => x.min).sort((a, b) => a - b);
        return v[Math.floor(v.length / 2)];
      };
      const legMedian = median(legs);
      const recentMedian = median(legs.slice(-3));
      const trendUp = legs.length >= 4 && recentMedian != null && legMedian != null && recentMedian > legMedian * 1.35;

      const silent = minSince(lastReport, now);
      let heat = 'green';
      if (inbound >= 4) heat = 'red';
      else if (inbound >= 2) heat = 'yellow';
      if (inbound > 0 && silent != null && silent >= CTRL_STALE_MIN) heat = 'red';
      if (heat === 'yellow' && trendUp) heat = 'red';

      return { control: c, doneCount: scores.length, lastReport, silent, inbound, legMedian, recentMedian, trendUp, heat };
    });

    return { now, perPatrol, ctrlStats, ordered };
  }

  // Livstecken-cellen: hur länge sedan kontrollens telefon hördes av, batteri
  // och köade offline-poäng. Rött när telefonen varit tyst länge (hjärtslaget
  // går var 5:e minut, så 15 min = tre missade) eller batteriet är lågt —
  // det är skillnaden mellan "lugn kontroll" och "poäng på väg att strandas".
  // Livstecknet skickas bara medan rapportsidan ligger framme. En kontrollant
  // som låst telefonen mellan två patruller slutar därför höra av sig helt
  // normalt — larmar vi på det blir kolumnen rosa för nästan varje kontroll,
  // och då slutar ledningen läsa den. Tystnad är alltså DÄMPAD, inte röd:
  // rosa reserveras för det som verkligen kräver ett samtal — lågt batteri
  // och rapporter som ännu inte nått servern. Vem som är obemannad syns i
  // "Senaste rapport"-kolumnen, som mäter något riktigt.
  function beaconCell(b, now) {
    if (!b || !b.at) return '<span class="muted t-sm">—</span>';
    const t = b.at?.toDate ? b.at.toDate() : new Date(b.at);
    const min = Math.max(0, Math.round((now - t) / 60000));
    const tyst = min >= 30;
    const lågBatt = typeof b.batteri === 'number' && b.batteri <= 20 && !b.laddar;
    const delar = [min < 1 ? 'nyss' : `${min} min sedan`];
    if (typeof b.batteri === 'number') delar.push(`${b.batteri} %${b.laddar ? ' ⚡' : ''}`);
    if (b.koade > 0) delar.push(`<strong>${b.koade} i kö</strong>`);
    if (b.enheter > 1) delar.push(`${b.enheter} telefoner`);
    const larm = lågBatt || b.koade > 0;
    const farg = larm ? 'color:var(--utm-pink);font-weight:600;' : (tyst ? 'color:var(--fg3);' : 'color:var(--fg2);');
    const titel = lågBatt ? 'Lågt batteri på den svagaste telefonen — kontrollen kan tappa möjligheten att rapportera'
      : b.koade > 0 ? 'Rapporter ligger kvar i telefonen och har inte nått servern'
      : tyst ? `Inget livstecken på ${min} minuter. Normalt om telefonen är låst — kolla "Senaste rapport" för att se om kontrollen är bemannad.`
      : 'Rapportsidan var framme här senast';
    return `<span class="t-sm mono" style="white-space:nowrap;${farg}" title="${escapeHtml(titel)}">${delar.join(' · ')}</span>`;
  }

  // Sekretariatets logg. Säger uttryckligen VILKA åtgärder som loggas — en
  // logg man tror är komplett är värre än ingen, för då drar man slutsatser av
  // det som inte står där. Rapportsidans egna åtgärder loggas inte: de görs
  // anonymt och en anonym klient kan inte skriva till en member-only logg.
  function ritaLogg(rader) {
    const host = wrap.querySelector('#logg');
    if (!host || !isAdmin) return;
    host.innerHTML = `
      <div class="card">
        <h3>${icon('history', { size: 16 })} Sekretariatets logg</h3>
        <p class="muted t-sm" style="margin:6px 0 10px;">
          Loggar det som görs härifrån: öppnade kontroller, utgångna patruller,
          efterlysningar och skickade vädervarningar. Poängrättelser och
          fältets egna åtgärder står inte här.
        </p>
        ${rader.length ? `
          <ul class="logg-lista">
            ${rader.slice(0, 40).map(r => `
              <li>
                <span class="logg-tid mono">${r.at ? formatTime(r.at.toDate ? r.at.toDate() : new Date(r.at)) : '—'}</span>
                <span class="logg-text">${escapeHtml(r.text || '')}</span>
                <span class="logg-av muted">${escapeHtml(r.av || '')}</span>
              </li>`).join('')}
          </ul>`
          : '<p class="muted t-sm">Inget loggat än.</p>'}
      </div>`;
  }

  // Kortet säger rakt ut vad kopian INTE innehåller. Kallas den "backup" i
  // gränssnittet kommer någon att lita på den vid en radering och förlora
  // anmälningar, utskick och överlämningsdokument.
  async function ritaDagskopia() {
    const host = wrap.querySelector('#dagskopia');
    if (!host) return;
    let kopior = [];
    try { kopior = await listaDagskopior(cid); } catch { return; }
    if (!kopior.length) { host.innerHTML = ''; return; }
    const senast = kopior[0];
    const antalPoang = senast.kopia?.poang?.length ?? 0;
    host.innerHTML = `
      <div class="card">
        <h3>${icon('history', { size: 16 })} Dagskopia i den här webbläsaren</h3>
        <p class="muted t-sm" style="margin:6px 0 0;">
          Sparas var femte minut medan Läget är öppet, utan extra databasläsningar.
          Senast ${formatTime(new Date(senast.skapad))} · ${antalPoang} poängrapporter · ${kopior.length} sparade.
        </p>
        <p class="muted t-sm" style="margin:6px 0 0;">
          <strong>Ersätter inte en backup.</strong> Den saknar anmälningar, utskick,
          överlämningsdokument och kontrollernas telefonnummer — ladda ner en riktig
          backup under Inställningar innan ni avslutar tävlingen.
        </p>
        <button class="btn btn-secondary btn-sm" id="kopia-hamta" style="margin-top:10px;">
          ${icon('download', { size: 14 })} Ladda ner senaste dagskopian
        </button>
      </div>`;
    host.querySelector('#kopia-hamta')?.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(senast.kopia, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `dagskopia-${(comp.shortName || 'tavling').toLowerCase()}-${senast.skapad.slice(0, 16).replace(/[:T]/g, '')}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  // Väderkortet. Åska är kritisk och får en knapp som FÖRIFYLLER ett
  // driftmeddelande — ledningen skickar det själv. Ett automatiskt utskick vid
  // varje prognosryck är precis det som får folk att sluta läsa meddelanden.
  function ritaVader(host, v) {
    // Bara ikonnamn som FINNS i icons.js — en saknad symbol renderar tomt.
    const ikon = v.varsta === 'kritisk' ? 'triangle-alert' : v.varsta === 'varning' ? 'droplet' : 'sun';
    const klass = v.varsta === 'kritisk' ? ' is-kritisk' : v.varsta === 'varning' ? ' is-varning' : '';
    host.innerHTML = `
      <div class="card vader${klass}">
        <div class="vader-huvud">
          ${icon(ikon, { size: 18 })}
          <h3>Vädret på banan</h3>
          <span class="muted t-sm">kommande dygnet</span>
        </div>
        ${v.larm.length
          ? `<ul class="vader-larm">${v.larm.map(l =>
              `<li class="vader-${escapeHtml(l.niva)}"><strong>${escapeHtml(l.rubrik)}</strong> ${escapeHtml(l.text)}</li>`
            ).join('')}</ul>`
          : '<p class="muted t-sm" style="margin:6px 0 0;">Inget oväder i prognosen — regn under 5 mm och byvindar under 15 m/s.</p>'}
        <div class="vader-fot muted t-sm">
          Nederbörd ${v.regnMm} mm · byvind upp till ${v.maxByMs} m/s · prognos från Open-Meteo
        </div>
        ${v.aska ? '<button class="btn btn-primary" id="vader-msg" style="margin-top:10px;">Förbered meddelande till fältet</button>' : ''}
      </div>`;

    host.querySelector('#vader-msg')?.addEventListener('click', (e) => withBusy(e.currentTarget, 'Skickar…', async () => {
      const text = vaderMeddelande(v);
      if (!text) return;
      const ok = await confirmDialog(
        `Skicka som KRITISKT meddelande till alla kontroller och alla patrullers startkort? `
        + `Det larmar med ljud och vibration.\n\n"${text}"`,
        { okLabel: 'Skicka varningen', danger: true });
      if (!ok) return;
      try {
        await createBroadcastMessage(cid, {
          text, level: 'kritisk',
          target: { kontroller: true, patruller: true, publikt: false },
          requireAck: true
        });
        loggHandelse(cid, { vad: 'askvarning', av: user?.email || '', text });
        toast('Åskvarningen är skickad', 'success');
      } catch (err) { toast('Kunde inte skicka: ' + (err?.message || err), 'error'); }
    }));
  }

  // --- Render ------------------------------------------------------------------
  function renderStats() {
    if (!wrap.isConnected) return;
    // Sammanslagningen görs här, inte i varje prenumeration: den härledda
    // målgången beror på poängdatan och måste räknas om när den ändras.
    mergePassages();
    const { now, perPatrol, ctrlStats } = compute();

    const waiting = perPatrol.filter(p => !p.started).length;
    const out = perPatrol.filter(p => p.active).length;
    const done = perPatrol.filter(p => p.finishAt).length;
    const warns = perPatrol.filter(p => p.warn);
    const recentReports = Object.values(scoresByCtrl).flat()
      .filter(s => { const d = toDate(s.reportedAt); return d && (now - d) < 30 * 60000; }).length;

    wrap.querySelector('#kpis').innerHTML = `
      <div class="kpi"><div class="k-label">Ej startade</div><div class="k-value">${waiting}</div></div>
      <div class="kpi"><div class="k-label">Ute i skogen</div><div class="k-value">${out}</div></div>
      <div class="kpi"><div class="k-label">I mål</div><div class="k-value">${done}</div></div>
      <div class="kpi"><div class="k-label">Rapporter senaste 30 min</div><div class="k-value">${recentReports}</div></div>
      <div class="kpi" style="${warns.length ? 'border-color:var(--utm-pink);' : ''}">
        <div class="k-label" style="${warns.length ? 'color:var(--utm-pink);' : ''}">Varningar</div>
        <div class="k-value" style="${warns.length ? 'color:var(--utm-pink);' : ''}">${warns.length}</div>
      </div>
    `;

    // --- Dagskopia -------------------------------------------------------------
    // Byggs ur de snapshots vyn REDAN har — inga extra Firestore-läsningar.
    // Se dagskopia.js: detta är en ögonblicksbild, INTE en backup, och den
    // stämplar därför aldrig comp.lastBackupAt.
    // Sparas ur renderStats egna kadens i stället för en egen timer: vyn
    // renderar om vid varje snapshot, så den första kopian tas så fort poängen
    // faktiskt kommit in. En omedelbar kopia vid sidladdning blev TOM —
    // kontrollernas poänglyssnare hade inte svarat än — och en tom kopia är
    // värre än ingen, för kortet påstår att något är sparat.
    (() => {
      // Kontrollerna är ryggraden: utan dem är kopian oanvändbar även om
      // avprickningar hunnit in. Lyssnarna svarar i olika ordning, och de
      // första sekunderna efter sidladdning har vyn bara delar av bilden.
      if (!controls.length) return;
      const kopia = byggDagskopia({
        comp: { id: cid, ...comp }, patrols, controls,
        scoresByCtrl, passages, selfPassages
      });
      if (!kopia.poang.length && !kopia.avprickningar.length) return;
      // Strypningen släpper förbi en kopia som blivit RIKARE. Annars låstes
      // en halvfärdig första kopia in i fem minuter, medan kortet påstod
      // "0 poängrapporter" fast poängen redan fanns på skärmen.
      const nu = Date.now();
      if (kopia.poang.length <= sistaKopiaPoang && nu - sistaKopia < KOPIA_INTERVALL_MS) return;
      sistaKopia = nu;
      sistaKopiaPoang = kopia.poang.length;
      sparaDagskopia(cid, kopia).then(ritaDagskopia).catch(() => { /* privat läge, full disk */ });
    })();

    // --- Väder ---------------------------------------------------------------
    // Åska upptäcks annars genom fönstret, och den som står på en kontroll har
    // inget fönster. Hämtas EN gång per sidladdning — renderStats kör var 30:e
    // sekund och vid varje snapshot, och därifrån hade det blivit hundratals
    // anrop mot en gratistjänst under en tävlingsdag.
    if (!vaderHamtat) {
      vaderHamtat = true;
      (async () => {
        const sf = startFinishPoints(comp)[0]
          || controls.find(c => Number.isFinite(c.lat) && Number.isFinite(c.lng));
        if (!sf) return;
        const v = await hamtaVader(sf.lat, sf.lng);
        const host = wrap.querySelector('#vader');
        // Tyst degradering: utan svar visas inget kort alls. En tävlingsdag
        // får aldrig hänga på en utomstående tjänst.
        if (!v || !host || !wrap.isConnected) return;
        ritaVader(host, v);
      })();
    }

    // --- Dagens tidslinje -----------------------------------------------------
    // Svaret på tävlingsledarens två klockfrågor: "hinner vi prisutdelningen?"
    // och "hinner alla ur skogen innan det blir mörkt?". Sista väntade målgång
    // är max av de aktiva patrullernas kalibrerade mål-ETA (samma siffra som
    // redan står per patrull i tabellen — här hopslagen till EN). Solnedgången
    // räknas astronomiskt (sol.js) — inget väder-API, inget nätberoende.
    (() => {
      const host = wrap.querySelector('#tidslinje');
      if (!host) return;
      const aktiva = perPatrol.filter(pp => pp.active && pp.finishEtaMs);
      const sistaMål = aktiva.length ? Math.max(...aktiva.map(pp => pp.finishEtaMs)) : null;

      // Platsen: start/mål om utsatt, annars första kontrollen med position.
      const sf = startFinishPoints(comp)[0];
      const punkt = sf || controls.find(c => Number.isFinite(c.lat) && Number.isFinite(c.lng));
      const ned = punkt ? solnedgang(comp.date ? new Date(comp.date + 'T12:00:00') : now, punkt.lat, punkt.lng) : null;
      // Solnedgången gäller bara om den är TÄVLINGSDAGENS — ett datum långt
      // fram säger inget om ikväll. Jämför mot ETA bara när dagen är samma.
      const nedIdag = ned && ned.toDateString() === now.toDateString() ? ned : null;
      const mörkerGräns = nedIdag ? nedIdag.getTime() - 30 * 60000 : null;
      const iMörker = mörkerGräns ? aktiva.filter(pp => pp.finishEtaMs > mörkerGräns) : [];

      if (!sistaMål && !ned) { host.innerHTML = ''; return; }
      const kl = (ms) => new Date(ms).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
      host.innerHTML = `
        <div class="card tidslinje${iMörker.length ? ' is-varning' : ''}">
          <div class="tidslinje-rad">
            ${sistaMål ? `
              <div><span class="muted t-sm">Sista väntade målgång</span><strong class="mono">${kl(sistaMål)}</strong></div>
              <div><span class="muted t-sm">Prisutdelning tidigast ca</span><strong class="mono">${kl(sistaMål + 15 * 60000)}</strong></div>` : `
              <div><span class="muted t-sm">Sista väntade målgång</span><strong>—</strong></div>`}
            ${ned ? `
              <div><span class="muted t-sm">Solnedgång${punkt === sf ? '' : ' (vid kontroll ' + (punkt.nummer ?? '?') + ')'}</span><strong class="mono">${ned.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}</strong></div>` : ''}
          </div>
          ${iMörker.length ? `
            <div class="tidslinje-varning">
              ${iMörker.length} patrull${iMörker.length === 1 ? '' : 'er'} väntas i mål mindre än 30 min före solnedgången:
              ${escapeHtml(iMörker.slice(0, 5).map(pp => patrolLabel(pp.patrol)).join(', '))}${iMörker.length > 5 ? '…' : ''}
              — överväg att korta banan eller möta upp.
            </div>` : ''}
        </div>`;
    })();

    // Controls table
    wrap.querySelector('#ctrl-table').innerHTML = ctrlStats.length ? `
      <div class="table-wrap"><table class="t">
        <thead><tr>
          <th style="width:30px;"></th><th class="num">Nr</th><th>Kontroll</th><th>Status</th><th>Telefon</th>
          <th>Livstecken${help('laget.beacon')}</th>
          <th class="num">Klara</th><th class="num">Kö nu</th><th class="num">Mellantid</th><th>Senaste rapport</th>
        </tr></thead>
        <tbody>
          ${ctrlStats.map(cs => `
            <tr>
              <td><span title="${HEAT[cs.heat].label}" style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${HEAT[cs.heat].fill};"></span></td>
              <td class="num">${cs.control.nummer ?? ''}</td>
              <td><a class="row-link" href="/app/c/${cid}/controls/${cs.control.id}" data-link>${escapeHtml(cs.control.name || '—')}</a></td>
              <td>${cs.control.open
                ? '<span class="badge badge-green">Öppen</span>'
                : `<span class="badge badge-gray">Stängd</span>${isAdmin && cs.inbound > 0 ? ` <button class="btn btn-secondary btn-sm" data-open-ctrl="${escapeHtml(cs.control.id)}" title="Kontrollen har patruller på väg men tar inte emot rapporter">Öppna</button>` : ''}`}</td>
              <td>${cs.control.telefon ? `<a class="mono t-sm" href="tel:${escapeHtml(cs.control.telefon)}" style="color:var(--scout-blue);text-decoration:none;white-space:nowrap;">${escapeHtml(cs.control.telefon)}</a>` : '<span class="muted">—</span>'}</td>
              <td>${beaconCell(beaconByCtrl[cs.control.id], now)}</td>
              <td class="num">${cs.doneCount}/${patrols.length}</td>
              <td class="num" style="${cs.inbound >= 2 ? 'font-weight:700;color:' + HEAT[cs.heat].fill + ';' : ''}">${cs.inbound}</td>
              <td class="num">${cs.legMedian != null ? Math.round(cs.legMedian) + ' min' + (cs.trendUp ? ' <strong style="color:var(--utm-pink);">↑</strong>' : '') : '—'}</td>
              <td>${cs.lastReport ? `${formatTime(cs.lastReport)} <span class="muted t-sm">(${cs.silent} min sedan)</span>` : '<span class="muted">Ingen än</span>'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table></div>
    ` : '<div class="empty"><h3>Inga kontroller</h3></div>';

    // Snabböppning av stängd kontroll med inkommande patruller.
    wrap.querySelectorAll('[data-open-ctrl]').forEach(btn => btn.addEventListener('click', () => withBusy(btn, '…', async () => {
      try {
        await updateControl(cid, btn.dataset.openCtrl, { open: true });
        const k = controls.find(c => c.id === btn.dataset.openCtrl);
        loggHandelse(cid, { vad: 'kontroll-oppnad', av: user?.email || '',
          text: `Öppnade kontroll ${k?.nummer ?? '?'}${k?.name ? ' — ' + k.name : ''}` });
        toast('Kontrollen öppnad', 'success');
      }
      catch (e) { toast('Fel: ' + e.message, 'error'); }
    })));

    // Patrol table — warnings first, then by number.
    const rows = [...perPatrol].sort((a, b) =>
      (b.warn - a.warn) || (a.patrol.number ?? 0) - (b.patrol.number ?? 0));
    wrap.querySelector('#patrol-table').innerHTML = rows.length ? `
      <div class="table-wrap"><table class="t">
        <thead><tr>
          <th class="num">#</th><th>Patrull</th><th>Status</th><th>Start</th>
          <th class="num">Klara</th><th>Mål ca${help('eta.model')}</th><th>Senast sedd</th>
        </tr></thead>
        <tbody>
          ${rows.map(pp => {
            const p = pp.patrol;
            const planned = patrolStartTime(comp, p, patrols.length, now);
            const status = pp.utgatt ? `<span class="badge badge-gray" title="${escapeHtml(pp.utgatt.note || '')}">Utgått${pp.utgatt.at ? ' ' + formatTime(pp.utgatt.at) : ''}</span>`
              : pp.finishAt ? `<span class="badge badge-green" title="${pp.autoFinished
                    ? 'Härledd ur sista kontrollrapporten — ingen har sett patrullen i mål'
                    : pp.selfFinished ? 'Patrullen markerade sig i mål på sitt startkort'
                    : 'Incheckad av funktionär vid målet'}">I mål ${formatTime(pp.finishAt)}${
                    pp.autoFinished ? ' · auto' : pp.selfFinished ? ' · själv' : ''}</span>`
              : pp.lateStart ? `<span class="badge badge-orange">Sen till start · ${pp.lateStartMin} min</span>`
              : pp.warn ? `<span class="badge badge-pink">Tyst i ${pp.silentMin} min</span>${
                    isAdmin ? ` <button class="btn btn-ghost btn-sm" data-efterlys="${escapeHtml(p.id)}" title="Fråga kontrollerna om de sett patrullen">Efterlys…</button>` : ''}`
              : pp.active ? '<span class="badge badge-blue">Ute</span>'
              : '<span class="badge badge-gray">Ej startad</span>';
            const undoFinish = (isAdmin && pp.selfFinished)
              ? ` <button class="btn btn-ghost btn-sm" data-undo-self="${escapeHtml(p.id)}" data-field="finishAt" title="Ta bort patrullens egen målmarkering">Ångra mål</button>` : '';
            const dnfBtn = !isAdmin ? '' : (pp.utgatt
              ? ` <button class="btn btn-ghost btn-sm" data-undo-utgatt="${escapeHtml(p.id)}" title="Ta tillbaka patrullen i tävlingen">Ångra</button>`
              : (!pp.finishAt ? ` <button class="btn btn-ghost btn-sm" data-set-utgatt="${escapeHtml(p.id)}" title="Markera patrullen som utgått (DNF)">Utgått…</button>` : ''));
            return `<tr style="${pp.warn ? 'background:#fdf0f6;' : ''}${pp.utgatt ? 'opacity:.6;' : ''}">
              <td class="num">${p.number ?? ''}</td>
              <td><strong>${escapeHtml(patrolLabel(p))}</strong> <span class="muted t-sm"><span class="dot ${avdShort(p.avdelning)}"></span>${escapeHtml(p.avdelning || '')}</span></td>
              <td>${status}${undoFinish}${dnfBtn}</td>
              <td class="t-sm">${pp.startAt
                ? formatTime(pp.startAt) + (pp.selfStarted
                    ? ` <span class="muted" title="Patrullen bekräftade själv på sitt startkort">·&nbsp;själv</span>${isAdmin ? ` <button class="btn btn-ghost btn-sm" data-undo-self="${escapeHtml(p.id)}" data-field="startAt" title="Ta bort patrullens egen startbekräftelse">Ångra</button>` : ''}`
                    : '')
                : (planned ? `<span class="muted">plan ${escapeHtml(planned)}</span>` : '—')}</td>
              <td class="num">${pp.reports.length}/${controls.length || '—'}</td>
              <td class="t-sm">${pp.finishEtaMs
                ? (pp.finishEtaMs < now.getTime() - 60000
                    ? '<span class="badge badge-orange" title="Beräknad målgång har passerats">väntas nu</span>'
                    : formatTime(new Date(pp.finishEtaMs)))
                : '<span class="muted">—</span>'}</td>
              <td class="t-sm">${pp.lastSeen
                ? `${formatTime(pp.lastSeen)} <span class="muted">(${pp.position ? 'kontroll ' + pp.position : (pp.finishAt ? 'mål' : 'start')})</span>`
                : '<span class="muted">—</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
    ` : '<div class="empty"><h3>Inga patruller</h3></div>';

    // DNF: markera/ångra utgått. Noten är kort och saklig (patrulldokumentet
    // är publikt läsbart) och gallras automatiskt när tävlingen avslutas.
    wrap.querySelectorAll('[data-set-utgatt]').forEach(btn => btn.addEventListener('click', async () => {
      const p = patrols.find(x => x.id === btn.dataset.setUtgatt);
      if (!p) return;
      const note = await promptDialog(
        `Markera ${p.name || 'patrullen'} som utgått (DNF)? Patrullen räknas bort ur köer och varningar men behåller sina poäng. Anteckning (valfri, syns bara för ledningen här):`,
        { okLabel: 'Markera utgått', placeholder: 'T.ex. "avbröt vid kontroll 4, hämtade"', danger: true }
      );
      if (note === null) return;
      try {
        await setPatrolUtgatt(cid, p.id, { note });
        loggHandelse(cid, { vad: 'patrull-utgatt', av: user?.email || '',
          text: `Markerade ${patrolLabel(p)} som utgången${note ? ' — ' + note : ''}` });
        p.utgatt = { at: new Date(), note }; // patrols hämtas inte live — spegla lokalt
        toast(`${p.name} markerad som utgått`);
        renderStats();
      } catch (e) { toast('Fel: ' + e.message, 'error'); }
    }));
    // Efterlysning. Går till KONTROLLERNA, aldrig till patrullerna: en patrull
    // som ser "har ni sett patrull 7?" på sitt eget startkort blir orolig, och
    // patrull 7 själv skulle läsa att ledningen letar efter dem. Nivån är
    // varning, inte kritisk — kritisk larmar med ljud och vibration på varje
    // kontroll, och det ska sparas till åska och avbrott.
    wrap.querySelectorAll('[data-efterlys]').forEach(btn => btn.addEventListener('click', () => withBusy(btn, 'Skickar…', async () => {
      const p = patrols.find(x => x.id === btn.dataset.efterlys);
      if (!p) return;
      const pp = perPatrol.find(x => x.patrol?.id === p.id);
      const tyst = pp?.silentMin != null ? ` (tyst i ${pp.silentMin} min)` : '';
      const text = `Har ni sett ${patrolLabel(p)}, startnummer ${p.number ?? '?'}${tyst}? `
        + 'Svara i meddelandetråden — även "nej, inte här" hjälper oss.';
      const ok = await confirmDialog(
        `Efterlys hos alla ${controls.length} kontroller? Patrullerna får den INTE.\n\n"${text}"`,
        { okLabel: 'Skicka efterlysning', danger: false });
      if (!ok) return;
      try {
        await createBroadcastMessage(cid, {
          text, level: 'varning',
          target: { kontroller: true, patruller: false, publikt: false },
          requireAck: false
        });
        loggHandelse(cid, { vad: 'efterlysning', av: user?.email || '',
          text: `Efterlyste ${patrolLabel(p)} hos kontrollerna` });
        toast('Efterlysningen är skickad till kontrollerna', 'success');
      } catch (e) { toast('Kunde inte skicka: ' + (e?.message || e), 'error'); }
    })));

    wrap.querySelectorAll('[data-undo-utgatt]').forEach(btn => btn.addEventListener('click', async () => {
      const p = patrols.find(x => x.id === btn.dataset.undoUtgatt);
      if (!p) return;
      if (!(await confirmDialog(`Ta tillbaka ${p.name || 'patrullen'} i tävlingen?`, { okLabel: 'Ångra utgått', danger: false }))) return;
      try {
        await setPatrolUtgatt(cid, p.id, null);
        loggHandelse(cid, { vad: 'patrull-ater', av: user?.email || '',
          text: `Tog tillbaka ${patrolLabel(p)} i tävlingen` });
        delete p.utgatt; // patrols hämtas inte live — spegla lokalt
        toast(`${p.name} är åter i tävlingen`, 'success');
        renderStats();
      } catch (e) { toast('Fel: ' + e.message, 'error'); }
    }));

    // Startstationen kan inte ångra en självbekräftad start (den ligger i
    // patrullens egen collection, anonymt bara skrivbar en gång) — det är
    // därför den knappen finns här.
    wrap.querySelectorAll('[data-undo-self]').forEach(btn => btn.addEventListener('click', async () => {
      const p = patrols.find(x => x.id === btn.dataset.undoSelf);
      if (!p) return;
      const field = btn.dataset.field;
      const vad = field === 'startAt' ? 'startbekräftelse' : 'målmarkering';
      if (!(await confirmDialog(
        `Ta bort ${p.name || 'patrullens'} egen ${vad}? De kan då trycka igen på sitt startkort.`,
        { okLabel: 'Ta bort', danger: true }))) return;
      try {
        await clearSelfPassage(cid, p.id, field);
        toast(field === 'startAt' ? 'Startbekräftelsen borttagen' : 'Målmarkeringen borttagen');
      } catch (e) { toast('Fel: ' + e.message, 'error'); }
    }));

    updateMapMarkers(ctrlStats);
  }

  // --- Map (created once; markers restyled on every update) --------------------
  let mapInstance = null;
  const markers = new Map(); // ctrlId -> circleMarker
  async function initMap() {
    const withPos = controls.filter(c => c.lat && c.lng);
    const host = wrap.querySelector('#laget-map');
    if (!host || mapInstance || !withPos.length) {
      if (host && !withPos.length && !mapInstance) host.innerHTML = '<div class="empty" style="border:none;">Inga kontroller med position.</div>';
      return;
    }
    try {
      const L = await ensureLeaflet();
      if (!host.isConnected) return;
      mapInstance = L.map(host, { zoomControl: true, scrollWheelZoom: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OSM' }).addTo(mapInstance);
      // Drawn course (Spår editor) as background orientation — added before
      // the markers so the heat dots always paint on top.
      if (track) {
        const { legs, hasDrawn } = courseLegs(comp, withPos, track);
        if (hasDrawn) drawCourseOnMap(L, mapInstance, legs, { color: '#6b87a5' });
      }
      for (const c of withPos) {
        const m = L.circleMarker([c.lat, c.lng], {
          radius: 15, color: '#ffffff', weight: 3, fillColor: HEAT.green.fill, fillOpacity: 0.95
        }).bindTooltip(String(c.nummer ?? '?'), { permanent: true, direction: 'center', className: 'map-label' })
          .addTo(mapInstance);
        markers.set(c.id, m);
      }
      // Intressepunkter — sekretariatet och första hjälpen är precis det man
      // vill kunna peka på när något händer i skogen.
      const platser = compPlaces(comp);
      drawPlaces(L, mapInstance, platser, {
        iconHtml: (n) => icon(n, { size: 17, stroke: 2.5 }),
        onPopup: (pl) => `<strong>${escapeHtml(pl.name)}</strong><br><span class="muted">${escapeHtml(placeKind(pl.kind).label)}</span>${pl.note ? `<br>${escapeHtml(pl.note)}` : ''}`
      }).forEach(m => m.getTooltip()?.getElement()?.classList.add('map-label-place'));

      mapInstance.fitBounds(L.latLngBounds([
        ...withPos.map(c => [c.lat, c.lng]),
        ...platser.map(pl => [pl.lat, pl.lng])
      ]).pad(0.2));
      renderStats();
    } catch (e) {
      console.warn('Läget-kartan kunde inte laddas', e);
    }
  }
  function updateMapMarkers(ctrlStats) {
    if (!mapInstance) return;
    for (const cs of ctrlStats) {
      const m = markers.get(cs.control.id);
      if (!m) continue;
      m.setStyle({ fillColor: HEAT[cs.heat].fill, radius: cs.inbound >= 4 ? 19 : cs.inbound >= 2 ? 17 : 15 });
    }
  }

  renderStats();
}
