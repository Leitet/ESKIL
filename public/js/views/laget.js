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
  getCompetition, listPatrols, listStations, createStation, watchPassages,
  watchControls, watchScoresForControl
} from '../store.js';
import {
  escapeHtml, toast, copyToClipboard, formatTime, patrolStartTime, avdShort,
  isCompAdminUser
} from '../utils.js';
import { ensureLeaflet } from '../leaflet.js';
import { renderQrToImg } from '../pdf.js';
import { icon } from '../icons.js';
import { compActionsHtml } from './competition.js';

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
  let passages = {};   // patrolId -> { startAt, finishAt }
  let scoresByCtrl = {}; // ctrlId -> [{patrolId, reportedAt}]
  let station = null;

  try {
    [patrols, station] = await Promise.all([
      listPatrols(cid),
      listStations(cid).then(s => s[0] || null).catch(() => null)
    ]);
  } catch (e) {
    wrap.innerHTML = `<div class="empty"><h3>Kunde inte ladda</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }
  if (!wrap.isConnected) return;

  wrap.innerHTML = `
    <div class="page-head">
      <div>
        <div class="t-over" style="color:var(--avent-orange);">${escapeHtml(comp.shortName || '')} · ${comp.year || ''}</div>
        <h1 class="t-d2">Läget</h1>
        <p class="muted">Tävlingsdagsvy — uppdateras live när kontrollanter rapporterar och stationen checkar in.</p>
      </div>
      <div class="btn-row">${compActionsHtml(cid, comp, user)}</div>
    </div>

    <div class="tabs">
      <a href="/app/c/${cid}" data-link>Översikt</a>
      <a href="/app/c/${cid}/laget" data-link class="active">Läget</a>
      <a href="/app/c/${cid}/patrols" data-link>Patruller</a>
      <a href="/app/c/${cid}/controls" data-link>Kontroller</a>
      <a href="/app/c/${cid}/scoreboard" data-link>Poängtabell</a>
      <a href="/app/c/${cid}/anmalan" data-link>Anmälan</a>
    </div>

    <div id="station-card"></div>
    <div class="kpi-row" id="kpis"></div>

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
                <input class="input mono t-sm" readonly value="${escapeHtml(url)}" style="max-width:340px;" onclick="this.select()">
                <button class="btn btn-secondary btn-sm" id="copy-station">${icon('copy', { size: 14 })} Kopiera</button>
                <a class="btn btn-ghost btn-sm" href="${escapeHtml(url)}" target="_blank" rel="noopener">${icon('external', { size: 14 })} Öppna</a>
              </div>
            </div>
          </div>
        </div>`;
      stationCard.querySelector('#copy-station').addEventListener('click', () => {
        copyToClipboard(url);
        toast('Stationslänk kopierad', 'success');
      });
      const qrHost = stationCard.querySelector('#station-qr');
      renderQrToImg(url, 96).then(img => { qrHost.innerHTML = ''; qrHost.appendChild(img); }).catch(() => {});
    }
  };
  renderStationCard();

  // --- Subscriptions -----------------------------------------------------------
  const subscribedScores = new Set();
  const subscribePassages = () => {
    if (!station) return;
    unsubs.push(watchPassages(cid, station.id, rows => {
      passages = {};
      rows.forEach(p => { passages[p.id] = p; });
      renderStats();
    }));
  };
  subscribePassages();

  unsubs.push(watchControls(cid, rows => {
    controls = rows;
    for (const c of controls) {
      if (subscribedScores.has(c.id)) continue;
      subscribedScores.add(c.id);
      unsubs.push(watchScoresForControl(cid, c.id, scores => {
        scoresByCtrl[c.id] = scores;
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

  function compute() {
    const now = new Date();
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
      const started = !!startAt || reports.length > 0;
      const active = started && !finishAt;
      const silentMin = active ? minSince(lastSeen, now) : null;
      return {
        patrol: p, startAt, finishAt, reports, position, lastReport, lastSeen,
        started, active, silentMin,
        warn: active && silentMin != null && silentMin >= WARN_SILENT_MIN
      };
    });

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

  // --- Render ------------------------------------------------------------------
  function renderStats() {
    if (!wrap.isConnected) return;
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

    // Controls table
    wrap.querySelector('#ctrl-table').innerHTML = ctrlStats.length ? `
      <div class="table-wrap"><table class="t">
        <thead><tr>
          <th style="width:30px;"></th><th class="num">Nr</th><th>Kontroll</th><th>Telefon</th>
          <th class="num">Klara</th><th class="num">Kö nu</th><th class="num">Mellantid</th><th>Senaste rapport</th>
        </tr></thead>
        <tbody>
          ${ctrlStats.map(cs => `
            <tr>
              <td><span title="${HEAT[cs.heat].label}" style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${HEAT[cs.heat].fill};"></span></td>
              <td class="num">${cs.control.nummer ?? ''}</td>
              <td><a class="row-link" href="/app/c/${cid}/controls/${cs.control.id}" data-link>${escapeHtml(cs.control.name || '—')}</a></td>
              <td>${cs.control.telefon ? `<a class="mono t-sm" href="tel:${escapeHtml(cs.control.telefon)}" style="color:var(--scout-blue);text-decoration:none;white-space:nowrap;">${escapeHtml(cs.control.telefon)}</a>` : '<span class="muted">—</span>'}</td>
              <td class="num">${cs.doneCount}/${patrols.length}</td>
              <td class="num" style="${cs.inbound >= 2 ? 'font-weight:700;color:' + HEAT[cs.heat].fill + ';' : ''}">${cs.inbound}</td>
              <td class="num">${cs.legMedian != null ? Math.round(cs.legMedian) + ' min' + (cs.trendUp ? ' <strong style="color:var(--utm-pink);">↑</strong>' : '') : '—'}</td>
              <td>${cs.lastReport ? `${formatTime(cs.lastReport)} <span class="muted t-sm">(${cs.silent} min sedan)</span>` : '<span class="muted">Ingen än</span>'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table></div>
    ` : '<div class="empty"><h3>Inga kontroller</h3></div>';

    // Patrol table — warnings first, then by number.
    const rows = [...perPatrol].sort((a, b) =>
      (b.warn - a.warn) || (a.patrol.number ?? 0) - (b.patrol.number ?? 0));
    wrap.querySelector('#patrol-table').innerHTML = rows.length ? `
      <div class="table-wrap"><table class="t">
        <thead><tr>
          <th class="num">#</th><th>Patrull</th><th>Status</th><th>Start</th>
          <th class="num">Klara</th><th>Senast sedd</th>
        </tr></thead>
        <tbody>
          ${rows.map(pp => {
            const p = pp.patrol;
            const planned = patrolStartTime(comp, p, patrols.length);
            const status = pp.finishAt ? `<span class="badge badge-green">I mål ${formatTime(pp.finishAt)}</span>`
              : pp.warn ? `<span class="badge badge-pink">Tyst i ${pp.silentMin} min</span>`
              : pp.active ? '<span class="badge badge-blue">Ute</span>'
              : '<span class="badge badge-gray">Ej startad</span>';
            return `<tr style="${pp.warn ? 'background:#fdf0f6;' : ''}">
              <td class="num">${p.number ?? ''}</td>
              <td><strong>${escapeHtml(p.name || '')}</strong> <span class="muted t-sm"><span class="dot ${avdShort(p.avdelning)}"></span>${escapeHtml(p.avdelning || '')}</span></td>
              <td>${status}</td>
              <td class="t-sm">${pp.startAt ? formatTime(pp.startAt) : (planned ? `<span class="muted">plan ${escapeHtml(planned)}</span>` : '—')}</td>
              <td class="num">${pp.reports.length}/${controls.length || '—'}</td>
              <td class="t-sm">${pp.lastSeen
                ? `${formatTime(pp.lastSeen)} <span class="muted">(${pp.position ? 'kontroll ' + pp.position : (pp.finishAt ? 'mål' : 'start')})</span>`
                : '<span class="muted">—</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
    ` : '<div class="empty"><h3>Inga patruller</h3></div>';

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
      for (const c of withPos) {
        const m = L.circleMarker([c.lat, c.lng], {
          radius: 15, color: '#ffffff', weight: 3, fillColor: HEAT.green.fill, fillOpacity: 0.95
        }).bindTooltip(String(c.nummer ?? '?'), { permanent: true, direction: 'center', className: 'map-label' })
          .addTo(mapInstance);
        markers.set(c.id, m);
      }
      mapInstance.fitBounds(L.latLngBounds(withPos.map(c => [c.lat, c.lng])).pad(0.2));
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
