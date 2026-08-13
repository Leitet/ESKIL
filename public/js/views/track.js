// Spårdragning — draw the course between controls on a big map.
//
// The leg sequence is derived from control order (start → 1 → 2 → … → mål,
// using startFinishPoints when configured); the track doc only stores the
// waypoints drawn per leg, keyed "<fromKey>__<toKey>". A leg with no
// waypoints renders as a dashed straight line and is measured as such.
// Distances are haversine sums; walking time uses a selectable pace and the
// totals show hiking time both with and without 5 min per control.

import { layout, setTopbarCompetition, registerViewCleanup } from '../app.js';
import { getCompetition, listControls, getTrack, saveTrack } from '../store.js';
import { escapeHtml, toast, isCompAdminUser } from '../utils.js';
import { courseLegs, legPath, legLatLngs, legDistance, fmtDist, fmtMin, DEFAULT_SPEED_KMH } from '../course.js';
import { ensureLeaflet } from '../leaflet.js';
import { icon } from '../icons.js';
import { compTabs, compCrumbs, compLabel, setDocTitle } from '../nav.js';

const CONTROL_MINUTES = 5;     // scheduled stop per control (fixed by design)
const SPEEDS = [3, 4, 5];      // selectable walking pace, km/h
const DEFAULT_SPEED = DEFAULT_SPEED_KMH;

export async function renderTrack(app, user, cid) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="muted">Laddar…</div>`;
  layout(wrap);

  let comp, controls, stored;
  try {
    [comp, controls, stored] = await Promise.all([
      getCompetition(cid),
      listControls(cid),
      getTrack(cid).catch(() => null)
    ]);
  } catch (e) {
    wrap.innerHTML = `<div class="empty"><h3>Kunde inte ladda</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }
  if (!wrap.isConnected) return;
  if (!comp) { wrap.innerHTML = `<div class="empty"><h3>Tävlingen hittades inte</h3></div>`; return; }
  setTopbarCompetition(cid, comp, user);

  const canEdit = isCompAdminUser(comp, user) && (!comp.demo || user.role === 'super-admin');

  // --- Course sequence (shared derivation — see course.js) ----------------------
  const unplaced = controls.filter(c => !Number.isFinite(c.lat) || !Number.isFinite(c.lng));
  const { nodes, legs } = courseLegs(comp, controls, stored);

  let speedKmh = SPEEDS.includes(stored && stored.speedKmh) ? stored.speedKmh : DEFAULT_SPEED;
  let activeIdx = 0;
  let dirty = false;

  // --- Layout --------------------------------------------------------------------
  const nCtrls = nodes.filter(n => n.kind === 'control').length;
  setDocTitle('Spår', compLabel(comp));
  wrap.innerHTML = `
    <div class="page-head" style="margin-bottom:var(--sp-3);">
      <div>
        ${compCrumbs(cid, comp, { label: 'Spår' })}
        <h1 class="t-d2">Spår</h1>
      </div>
    </div>

    ${compTabs(cid, 'track', comp, user)}

    ${unplaced.length ? `
      <div class="card mb-3" style="border-left:3px solid var(--avent-orange);padding:10px 16px;">
        <span class="t-sm">${unplaced.length === 1 ? 'En kontroll saknar' : unplaced.length + ' kontroller saknar'} position och ingår inte i spåret:
        ${unplaced.map(c => `<a href="/app/c/${cid}/controls/${c.id}" data-link>${escapeHtml(String(c.nummer ?? '?'))} · ${escapeHtml(c.name || '')}</a>`).join(', ')}.</span>
      </div>` : ''}

    ${nodes.length < 2 ? `
      <div class="empty"><h3>Inget att rita än</h3>
      <p>Placera kontrollerna på kartan (och gärna start/mål under Inställningar) så kan spåret dras här.</p></div>
    ` : `
    <div class="track-wrap" id="track-wrap">
      <div id="track-map" class="track-map"></div>
      <div class="track-panel" id="track-panel"></div>
      <button class="btn btn-secondary btn-sm track-fs" id="track-fs" title="Fullskärm">⛶ Fullskärm</button>
    </div>
    <p class="muted t-sm" style="margin-top:8px;">
      ${canEdit
        ? 'Välj ett ben i panelen (eller klicka på linjen) och klicka i kartan för att lägga till punkter. Dra punkterna för att justera, dubbelklicka på en punkt för att ta bort den.'
        : 'Skrivskyddad vy — endast administratörer kan ändra spåret.'}
    </p>`}
  `;

  if (nodes.length < 2) return;

  // --- Stats -----------------------------------------------------------------
  const legDist = legDistance;
  const walkMin = (m) => (m / 1000) / speedKmh * 60;

  // --- Map ---------------------------------------------------------------------
  const L = await ensureLeaflet();
  if (!wrap.isConnected) return;

  const map = L.map(wrap.querySelector('#track-map'));
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
  }).addTo(map);
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: '© Esri — World Imagery'
  });
  L.control.layers({ 'Karta': osm, 'Satellit': sat }, null, { position: 'topleft' }).addTo(map);
  map.fitBounds(L.latLngBounds(nodes.map(n => [n.lat, n.lng])), { padding: [50, 50] });

  // Fixed nodes (start/controls/mål)
  nodes.forEach(n => {
    const bg = n.kind === 'control' ? 'var(--scout-blue)' : '#41A62A';
    L.marker([n.lat, n.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div style="width:26px;height:26px;border-radius:50%;background:${bg};color:#fff;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;font:700 12px/1 Helvetica,Arial,sans-serif;">${escapeHtml(n.label)}</div>`,
        iconSize: [26, 26], iconAnchor: [13, 13]
      }),
      title: n.title, keyboard: false
    }).addTo(map);
  });

  // Leg polylines
  // A double-click fires two click events first (Leaflet quirk) — without a
  // debounce, double-click-to-zoom would also drop two stray waypoints. So
  // single clicks insert after a short delay and a dblclick cancels them.
  let clickTimer = null;
  const insertDebounced = (leg, latlng) => {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => insertWaypoint(leg, latlng), 230);
  };
  map.on('dblclick', () => clearTimeout(clickTimer));

  const polys = legs.map((leg, i) => {
    const pl = L.polyline(legPath(leg).map(p => [p.lat, p.lng]), { weight: 4 }).addTo(map);
    pl.on('click', (e) => {
      L.DomEvent.stop(e);
      if (activeIdx !== i) { setActive(i); return; }
      if (canEdit) insertDebounced(leg, e.latlng);
    });
    return pl;
  });

  let wpMarkers = [];

  function styleLegs() {
    polys.forEach((pl, i) => {
      const straight = legs[i].wps.length === 0;
      pl.setStyle(i === activeIdx
        ? { color: '#ED6E24', opacity: 0.95, weight: 5, dashArray: straight ? '7 7' : null }
        : { color: '#003660', opacity: 0.55, weight: 4, dashArray: straight ? '7 7' : null });
    });
  }

  function redrawActiveLeg() {
    const leg = legs[activeIdx];
    polys[activeIdx].setLatLngs(legPath(leg).map(p => [p.lat, p.lng]));
    styleLegs();
    drawWaypoints();
    updatePanel();
  }

  function drawWaypoints() {
    wpMarkers.forEach(m => m.remove());
    wpMarkers = [];
    if (!canEdit) return;
    const leg = legs[activeIdx];
    leg.wps.forEach((p, j) => {
      // The visible dot is 14px but the hit area is 26px — a fat-finger
      // margin so grabbing/deleting a point doesn't require pixel aim.
      const mk = L.marker([p.lat, p.lng], {
        draggable: true, keyboard: false,
        icon: L.divIcon({
          className: '',
          html: '<div style="width:26px;height:26px;display:flex;align-items:center;justify-content:center;"><div style="width:14px;height:14px;border-radius:50%;background:#fff;border:3px solid #ED6E24;box-shadow:0 1px 3px rgba(0,0,0,.4);"></div></div>',
          iconSize: [26, 26], iconAnchor: [13, 13]
        }),
        title: 'Dra för att flytta · dubbelklicka för att ta bort'
      }).addTo(map);
      mk.on('drag', () => {
        const ll = mk.getLatLng();
        leg.wps[j] = { lat: ll.lat, lng: ll.lng };
        polys[activeIdx].setLatLngs(legPath(leg).map(q => [q.lat, q.lng]));
      });
      mk.on('dragend', () => { markDirty(); updatePanel(); });
      const removeWp = () => { leg.wps.splice(j, 1); markDirty(); redrawActiveLeg(); };
      mk.on('dblclick', (e) => { L.DomEvent.stop(e); removeWp(); });
      mk.on('contextmenu', (e) => { L.DomEvent.stop(e); removeWp(); });
      wpMarkers.push(mk);
    });
  }

  // Insert at the nearest segment of the active leg so clicks refine the
  // path where they land instead of always appending at the end.
  function insertWaypoint(leg, latlng) {
    const path = legPath(leg).map(p => map.latLngToLayerPoint([p.lat, p.lng]));
    const click = map.latLngToLayerPoint(latlng);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
      const d = L.LineUtil.pointToSegmentDistance(click, path[i], path[i + 1]);
      if (d < bestD) { bestD = d; best = i; }
    }
    leg.wps.splice(best, 0, { lat: latlng.lat, lng: latlng.lng });
    markDirty();
    redrawActiveLeg();
  }

  map.on('click', (e) => {
    if (!canEdit) return;
    insertDebounced(legs[activeIdx], e.latlng);
  });

  function setActive(i) {
    activeIdx = i;
    styleLegs();
    drawWaypoints();
    updatePanel();
  }

  // --- Panel -------------------------------------------------------------------
  const panel = wrap.querySelector('#track-panel');

  function markDirty() {
    if (!dirty) { dirty = true; updatePanel(); }
  }

  function updatePanel() {
    const dists = legs.map(legDist);
    const total = dists.reduce((s, d) => s + d, 0);
    const walk = walkMin(total);
    const ctrlMin = nCtrls * CONTROL_MINUTES;

    panel.innerHTML = `
      <div class="row" style="justify-content:space-between;align-items:center;">
        <strong>Spåret</strong>
        ${dirty ? '<span class="badge badge-orange">Osparat</span>' : ''}
      </div>

      <div class="track-totals">
        <div><span class="muted">Spårlängd</span><strong>${fmtDist(total)}</strong></div>
        <div><span class="muted">Gångtid</span><strong>${fmtMin(walk)}</strong></div>
        <div><span class="muted">Kontrolltid</span><strong>${fmtMin(ctrlMin)}</strong><span class="muted t-sm">${nCtrls} × ${CONTROL_MINUTES} min</span></div>
        <div class="track-grand"><span class="muted">Totalt inkl. kontroller</span><strong>${fmtMin(walk + ctrlMin)}</strong></div>
      </div>

      <label class="t-sm muted" style="display:flex;align-items:center;gap:8px;margin:10px 0 4px;">Promenadtempo
        <select class="input" id="track-speed" style="width:auto;padding:4px 8px;">
          ${SPEEDS.map(s => `<option value="${s}" ${s === speedKmh ? 'selected' : ''}>${s} km/h</option>`).join('')}
        </select>
      </label>

      <div class="track-legs">
        ${legs.map((leg, i) => `
          <button type="button" class="track-leg ${i === activeIdx ? 'active' : ''}" data-leg="${i}">
            <span class="track-leg-name">${escapeHtml(leg.from.label)} → ${escapeHtml(leg.to.label)}</span>
            <span class="mono t-sm">${fmtDist(dists[i])}</span>
            <span class="mono t-sm muted">${fmtMin(walkMin(dists[i]))}</span>
            ${leg.wps.length === 0 ? '<span class="muted t-sm" title="Inga punkter ritade — fågelvägen">✏</span>' : ''}
          </button>
        `).join('')}
      </div>

      ${canEdit ? `
        <div class="btn-row" style="margin-top:10px;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" id="track-undo" ${legs[activeIdx].wps.length ? '' : 'disabled'}>Ångra punkt</button>
          <button class="btn btn-ghost btn-sm" id="track-clear" ${legs[activeIdx].wps.length ? '' : 'disabled'}>Rensa ben</button>
          <button class="btn btn-primary btn-sm" id="track-save" ${dirty ? '' : 'disabled'}>Spara spår</button>
        </div>` : ''}
    `;

    panel.querySelectorAll('[data-leg]').forEach(b => {
      b.addEventListener('click', () => {
        const i = Number(b.dataset.leg);
        setActive(i);
        map.fitBounds(L.latLngBounds(legPath(legs[i]).map(p => [p.lat, p.lng])), { padding: [70, 70] });
      });
    });
    panel.querySelector('#track-speed')?.addEventListener('change', (e) => {
      speedKmh = Number(e.target.value) || DEFAULT_SPEED;
      markDirty();
      updatePanel();
    });
    panel.querySelector('#track-undo')?.addEventListener('click', () => {
      legs[activeIdx].wps.pop();
      markDirty();
      redrawActiveLeg();
    });
    panel.querySelector('#track-clear')?.addEventListener('click', () => {
      legs[activeIdx].wps = [];
      markDirty();
      redrawActiveLeg();
    });
    panel.querySelector('#track-save')?.addEventListener('click', async () => {
      try {
        const data = { speedKmh, legs: {} };
        legs.forEach(l => { if (l.wps.length) data.legs[l.key] = l.wps; });
        await saveTrack(cid, data);
        dirty = false;
        updatePanel();
        toast('Spåret sparat', 'success');
      } catch (e) { toast('Kunde inte spara: ' + e.message, 'error'); }
    });
  }

  styleLegs();
  drawWaypoints();
  updatePanel();

  // --- Fullscreen ---------------------------------------------------------------
  const wrapEl = wrap.querySelector('#track-wrap');
  wrap.querySelector('#track-fs').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrapEl.requestFullscreen?.();
  });
  const onFs = () => setTimeout(() => map.invalidateSize(), 60);
  document.addEventListener('fullscreenchange', onFs);

  // Warn before the tab closes with unsaved drawing.
  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  registerViewCleanup(() => {
    clearTimeout(clickTimer);
    document.removeEventListener('fullscreenchange', onFs);
    window.removeEventListener('beforeunload', beforeUnload);
    try { map.remove(); } catch {}
  });
}
