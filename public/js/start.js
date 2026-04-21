// ESKIL — Scout-side startkort.
// URL pattern: /s/<competitionId>/<patrolId>
// Same look and feel as the reporter page. Shows:
//   - Flip card: patrol info on front; competition info/management/general info on back
//   - Map with all controls (color-coded by done/not-done for this patrol)
//   - Filter chips + control list with anonymity enforced

import { db, doc, onSnapshot, collection } from './firebase.js';
import { getCompetition, getPatrol, listControls } from './store.js';
import {
  escapeHtml, publicManagement, patrolStartTime, patrolStartDateTime,
  startFinishPoints, parkingPoint, startTimeSettings,
  effectiveIntervalSec as effectiveIntervalSecValue
} from './utils.js';
import { ensureLeaflet } from './leaflet.js';
import { icon } from './icons.js';

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
let controls = [];
let scoresForPatrol = {};  // controlId -> score doc
let filter = 'alla';       // 'alla' | 'kvar' | 'klara'

async function main() {
  const parsed = parsePath();
  if (!parsed) return renderError('Ogiltig länk.');
  const { cid, patrolId } = parsed;

  try {
    [comp, patrol, controls] = await Promise.all([
      getCompetition(cid),
      getPatrol(cid, patrolId),
      listControls(cid)
    ]);
  } catch (e) {
    return renderError('Kunde inte ladda startkortet: ' + e.message);
  }
  if (!comp)   return renderError('Tävlingen hittades inte.');
  if (!patrol) return renderError('Patrullen hittades inte.');

  // Live updates: competition, controls, scores for this patrol across all controls
  onSnapshot(doc(db, 'competitions', cid), s => {
    if (s.exists()) { comp = { id: cid, ...s.data() }; render(); }
  });
  onSnapshot(collection(db, 'competitions', cid, 'controls'), snap => {
    controls = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // For each control, subscribe to THIS patrol's score (keyed by patrolId).
    for (const c of controls) {
      onSnapshot(
        doc(db, 'competitions', cid, 'controls', c.id, 'scores', patrolId),
        scoreSnap => {
          if (scoreSnap.exists()) scoresForPatrol[c.id] = { id: scoreSnap.id, ...scoreSnap.data() };
          else delete scoresForPatrol[c.id];
          render();
        }
      );
    }
    render();
  });

  render();
}

function isAnonymous() { return comp?.anonymousControls !== false; }

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
function render() {
  if (!comp || !patrol) return;

  const generalInfo = (comp.generalInfo || '').trim();
  const mgmt = publicManagement(comp);
  const hasBackContent = !!generalInfo || mgmt.length > 0;

  const t = totals();

  root.innerHTML = `
    <div class="flip-card" id="flip-card">
      <div class="flip-card-inner">
        <div class="flip-face flip-front">
          <div class="start-head">
            <div class="start-eyebrow">${escapeHtml(comp.shortName || 'Tävling')} ${comp.year ? '· ' + comp.year : ''} · STARTKORT</div>
            <div class="flip-title-row">
              <h1 class="start-title">
                <span class="r-ctrl-no">#${escapeHtml(String(patrol.number ?? ''))}</span>${escapeHtml(patrol.name || '')}
              </h1>
              ${hasBackContent ? `<button class="flip-btn" id="flip-open" aria-expanded="false" aria-label="Visa tävlingsinformation">${icon('info', { size: 22 })}</button>` : ''}
            </div>
            <div class="start-sub">
              ${escapeHtml(patrol.avdelning || '')}${patrol.kar ? ' · ' + escapeHtml(patrol.kar) : ''}${patrol.antal ? ' · ' + patrol.antal + ' deltagare' : ''}
            </div>
            ${(() => {
              const t = patrolStartTime(comp, patrol, patrols.length);
              if (!t) return '';
              const dt = patrolStartDateTime(comp, patrol, new Date(), patrols.length);
              return `<div class="start-time-chip" id="start-time-chip" data-start="${dt?.toISOString() || ''}">
                ${icon('clock', { size: 18 })}
                <span>Starttid</span>
                <span class="start-time-value">${escapeHtml(t)}</span>
                <span class="start-time-sep">·</span>
                <span class="start-time-countdown" id="start-time-countdown">—</span>
              </div>`;
            })()}
          </div>
        </div>
        <div class="flip-face flip-back" aria-hidden="true">
          <button class="flip-back-close" id="flip-close" aria-label="Stäng">${icon('x', { size: 22 })}</button>
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

    <div class="start-kpis">
      <div class="start-kpi primary"><div class="kp-label">Poäng</div><div class="kp-value">${t.points}</div></div>
      <div class="start-kpi"><div class="kp-label">Klara</div><div class="kp-value">${t.done} / ${t.total}</div></div>
      <div class="start-kpi"><div class="kp-label">Kvar</div><div class="kp-value">${t.total - t.done}</div></div>
    </div>

    ${controls.some(c => c.lat && c.lng) ? `
      <div class="start-map-wrap">
        <div class="start-map" id="start-map"></div>
      </div>
    ` : ''}

    <div class="start-filter">
      <button data-f="alla"  class="${filter === 'alla'  ? 'active' : ''}">Alla · ${t.total}</button>
      <button data-f="kvar"  class="${filter === 'kvar'  ? 'active' : ''}">Kvar · ${t.total - t.done}</button>
      <button data-f="klara" class="${filter === 'klara' ? 'active' : ''}">Klara · ${t.done}</button>
    </div>

    <div class="start-ctrl-list">
      ${renderList()}
    </div>

    <p class="r-sub" style="text-align:center;opacity:.55;margin-top:36px;font-size:13px;">
      ESKIL · startkort · live-uppdaterat när poäng rapporteras
    </p>
  `;

  // Wire filter
  root.querySelectorAll('.start-filter button').forEach(b => {
    b.addEventListener('click', () => { filter = b.dataset.f; render(); });
  });

  // Countdown to the patrol's start time on the chip
  wireStartCountdown();

  // Wire control rows (regular + start/finish pseudo-rows)
  root.querySelectorAll('.start-ctrl').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.sf) openStartFinishSheet(el.dataset.sf);
      else openControlSheet(el.dataset.id);
    });
  });

  // Flip card
  wireFlipCard();

  // Overview map (once per render)
  const withPos = controls.filter(c => c.lat && c.lng);
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
  const park = parkingPoint(comp);

  const pseudoCard = (label, p, extraClass = 'start-ctrl-sf', noClass = 'sf-no') => {
    const isPark = p.kind === 'parking';
    return `
      <div class="start-ctrl ${extraClass}" data-sf="${p.kind}">
        <div class="start-ctrl-no ${noClass}">${isPark ? icon('square-parking', { size: 20, stroke: 2.5 }) : escapeHtml(p.label)}</div>
        <div class="start-ctrl-body">
          <div class="start-ctrl-name">${escapeHtml(label)}</div>
          <div class="start-ctrl-sub">${escapeHtml(p.name || '')}</div>
        </div>
      </div>
    `;
  };

  const showSf = filter === 'alla';
  const parkingRow = (showSf && park) ? pseudoCard('Parkering', park, 'start-ctrl-park', 'park-no') : '';
  const startRow = (showSf && sfStart) ? pseudoCard(sfStart.kind === 'startfinish' ? 'Start / Mål' : 'Start', sfStart) : '';
  const finishRow = (showSf && sfFinish) ? pseudoCard('Mål', sfFinish) : '';

  const ctrlRows = rows.map(c => {
    const done = isDone(c.id);
    const score = scoresForPatrol[c.id];
    const name = displayName(c);
    const anon = isAnonymous() && !done;
    return `
      <button class="start-ctrl ${done ? 'done' : ''}" data-id="${c.id}">
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
// Re-created every render because render() wipes the DOM via innerHTML and
// any old Leaflet instance would be pointing at a detached node.
let overviewMap = null;
async function renderOverviewMap(withPos) {
  const host = document.getElementById('start-map');
  if (!host) return;
  try {
    const L = await ensureLeaflet();
    // Host might have been replaced while we awaited Leaflet.
    const currentHost = document.getElementById('start-map');
    if (!currentHost) return;

    // Dispose any previous map — especially if it's bound to a stale node.
    if (overviewMap) {
      try { overviewMap.remove(); } catch {}
      overviewMap = null;
    }

    const ordered = [...withPos].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
    const sfPoints = startFinishPoints(comp);
    const startPt = sfPoints.find(p => p.kind === 'start' || p.kind === 'startfinish');
    const finishPt = sfPoints.find(p => p.kind === 'finish') || startPt; // loop back if same

    overviewMap = L.map(currentHost, { zoomControl: true, scrollWheelZoom: false })
      .setView([ordered[0].lat, ordered[0].lng], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OSM'
    }).addTo(overviewMap);

    // Dashed route: start → controls in order → finish
    const linePoints = [
      ...(startPt ? [[startPt.lat, startPt.lng]] : []),
      ...ordered.map(c => [c.lat, c.lng]),
      ...(finishPt ? [[finishPt.lat, finishPt.lng]] : [])
    ];
    if (linePoints.length >= 2) {
      L.polyline(linePoints, {
        color: '#003660',
        weight: 3,
        opacity: 0.75,
        dashArray: '6 8'
      }).addTo(overviewMap);
    }

    // Control markers — labels show only the number. Done controls are
    // greyed out so the scout can see at a glance which ones are left.
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
        .addTo(overviewMap);
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

    // Parking marker — blue pill with the Lucide square-parking icon
    const park = parkingPoint(comp);
    if (park) {
      L.circleMarker([park.lat, park.lng], {
        radius: 16,
        color: '#ffffff',
        weight: 3,
        fillColor: '#003660',
        fillOpacity: 1
      })
        .bindTooltip(icon('square-parking', { size: 18, stroke: 2.5 }), {
          permanent: true, direction: 'center',
          className: 'start-map-label start-map-label-park'
        })
        .addTo(overviewMap);
    }

    // Fit bounds covering all markers incl. start/finish + parking
    const allPts = ordered.map(c => [c.lat, c.lng]);
    for (const p of sfPoints) allPts.push([p.lat, p.lng]);
    if (park) allPts.push([park.lat, park.lng]);
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
        <button class="sheet-close" id="close" aria-label="Stäng">${icon('x', { size: 22 })}</button>
      </div>

      ${c.lat && c.lng ? `
        <div class="detail-field" style="margin-top:6px;">
          <div class="dfl">Koordinater (vid nödsituation)</div>
          <div class="detail-coord">${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}</div>
        </div>
        <div class="flip-dist-chip" id="detail-dist" hidden></div>
        <div class="detail-map detail-map-tall" id="ctrl-detail-map"></div>
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
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#close').onclick = () => overlay.remove();

  if (c.lat && c.lng) {
    ensureLeaflet().then(L => {
      const host = overlay.querySelector('#ctrl-detail-map');
      const map = L.map(host, { zoomControl: true, scrollWheelZoom: true }).setView([c.lat, c.lng], 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© OSM'
      }).addTo(map);
      L.circleMarker([c.lat, c.lng], {
        radius: 14, color: '#ffffff', weight: 3,
        fillColor: done ? '#8a8a8a' : '#E95F13',
        fillOpacity: done ? 0.6 : 0.98
      }).addTo(map);

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
  const tick = () => {
    const now = new Date();
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
  };
  tick();
  countdownInterval = setInterval(tick, 1000);
}

function formatRelative(ms) {
  const total = Math.round(ms / 1000);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
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
  if (kind === 'parking') {
    p = parkingPoint(comp);
  } else if (kind === 'finish') {
    p = startFinishPoints(comp).find(x => x.kind === 'finish');
  } else {
    p = startFinishPoints(comp).find(x => x.kind === 'start' || x.kind === 'startfinish');
  }
  if (!p) return;
  const isParking = kind === 'parking';

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
        <button class="sheet-close" id="close" aria-label="Stäng">${icon('x', { size: 22 })}</button>
      </div>

      <div class="detail-field" style="margin-top:6px;">
        <div class="dfl">Koordinater</div>
        <div class="detail-coord">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
      </div>
      <div class="detail-map" id="sf-detail-map"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#close').onclick = () => overlay.remove();

  ensureLeaflet().then(L => {
    const host = overlay.querySelector('#sf-detail-map');
    const map = L.map(host, { zoomControl: true, scrollWheelZoom: false }).setView([p.lat, p.lng], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OSM'
    }).addTo(map);
    L.circleMarker([p.lat, p.lng], {
      radius: 16,
      color: isParking ? '#ffffff' : '#003660',
      weight: 3,
      fillColor: isParking ? '#003660' : '#E2E000',
      fillOpacity: 1
    })
      .bindTooltip(isParking ? icon('square-parking', { size: 18, stroke: 2.5 }) : p.label, {
        permanent: true,
        direction: 'center',
        className: 'start-map-label ' + (isParking ? 'start-map-label-park' : 'start-map-label-sf')
      })
      .addTo(map);
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
