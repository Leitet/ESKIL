// ESKIL — public landing page for a competition.
// No auth. Reads are public (competitions, patrols, controls, scores).
// URL pattern: /t/<competitionId>[/<tab>]
// Tabs: overview (default), patrols, scoreboard.

import { db, doc, onSnapshot, collection } from './firebase.js';
import { getCompetition, listPatrols, listControls, getTrack } from './store.js';
import { courseLegs, drawCourseOnMap, addCourseChip, competitionArea, courseDistance, fmtDist } from './course.js';
import {
  AVDELNINGAR, escapeHtml, formatDate, publicManagement, patrolStartTime,
  patrolStartDateTime, startTimeSettings, allowedAvdelningar,
  registrationSettings, registrationState,
  startFinishPoints, parkingPoint, rankPatrols, rankKarer, RANKING_RULES_TEXT,
  wireOverlayClose, controlsAutoReleased, controlsReleaseTime
} from './utils.js';
import { ensureLeaflet } from './leaflet.js';
import { icon } from './icons.js';

const root = document.getElementById('root');

function avdSlug(avd) {
  return { 'Spårare':'sp','Upptäckare':'up','Äventyrare':'av','Utmanare':'ut','Rover':'ro','Ledare':'le' }[avd] || 'le';
}
function avdImg(avd) {
  return {
    'Spårare':    '/assets/age-sparare.png',
    'Upptäckare': '/assets/age-upptackare.png',
    'Äventyrare': '/assets/age-aventyrare.png',
    'Utmanare':   '/assets/age-utmanare.png',
    'Rover':      '/assets/age-rover.png'
  }[avd] || null;
}

// Inline scout-symbol SVG so we can color it via currentColor — loading it as
// `<img>` ignored CSS color and gave flaky results when filter-inverted.
const SCOUT_SYMBOL_SVG = `<svg class="avd-scout-symbol" viewBox="0 0 200 240" aria-hidden="true" fill="currentColor">
  <path d="M100 12 C 92 38, 90 60, 90 92 C 90 118, 95 138, 100 158 C 105 138, 110 118, 110 92 C 110 60, 108 38, 100 12 Z"/>
  <path d="M38 32 C 44 62, 52 86, 68 108 C 78 122, 84 132, 82 152 C 78 138, 70 132, 58 128 C 44 124, 34 118, 30 102 C 26 82, 28 58, 38 32 Z"/>
  <path d="M162 32 C 156 62, 148 86, 132 108 C 122 122, 116 132, 118 152 C 122 138, 130 132, 142 128 C 156 124, 166 118, 170 102 C 174 82, 172 58, 162 32 Z"/>
  <ellipse cx="100" cy="170" rx="62" ry="10"/>
  <rect x="48" y="184" width="104" height="6"/>
  <rect x="54" y="196" width="92" height="6"/>
  <path d="M100 208 C 94 216, 92 224, 96 232 L 104 232 C 108 224, 106 216, 100 208 Z"/>
</svg>`;

function avdIllustration(avd) {
  if (avd === 'Ledare') return SCOUT_SYMBOL_SVG;
  const src = avdImg(avd);
  return src ? `<img src="${src}" alt="">` : '';
}

function parsePath() {
  const parts = location.pathname.split('/').filter(Boolean); // ['t', cid, tab?]
  if (parts[0] !== 't' || !parts[1]) return null;
  return { cid: parts[1], tab: parts[2] || 'overview' };
}

function setTab(cid, tab) {
  history.pushState({}, '', `/t/${cid}${tab === 'overview' ? '' : '/' + tab}`);
  render();
}

// --- Global state -----------------------------------------------------------
let comp = null;
let patrols = [];
let controls = [];
let track = null;    // drawn course from the Spår editor (fetched once)
let scoresByControl = {}; // ctrlId -> score[]
const subscribedScoreCtrls = new Set();
let unsubs = [];

function cleanup() {
  unsubs.forEach(u => { try { u(); } catch {} });
  unsubs = [];
}

// Per-competition setting: when publicScores is false the public page hides
// all points, totals and rankings — only green completion checks are shown.
// Missing field means public (backward compatible with existing competitions).
function scoresPublic() { return comp?.publicScores !== false; }

// Per-competition setting: when publicControls is false the public map hides
// control positions and the drawn course — a shaded "Tävlingsområde" polygon
// is shown instead (start/mål + parkering stay visible). UI-level only, like
// publicScores: startkort and reporter links (secret URLs) always show all.
// With autoReleaseControls the course releases itself 5 min before the first
// patrol's start on the competition date (see controlsAutoReleased).
function controlsPublic() {
  return comp?.publicControls !== false || controlsAutoReleased(comp);
}

async function boot() {
  const parsed = parsePath();
  if (!parsed) return renderNotFound('Ogiltig länk.');
  const { cid } = parsed;

  try {
    [comp, patrols, controls, track] = await Promise.all([
      getCompetition(cid),
      listPatrols(cid),
      listControls(cid),
      getTrack(cid).catch(() => null)
    ]);
  } catch (e) {
    return renderNotFound('Kunde inte ladda tävlingen: ' + e.message);
  }
  if (!comp) return renderNotFound('Tävlingen hittades inte.');

  // Live updates for competition, patrols, and every control's scores
  unsubs.push(onSnapshot(doc(db, 'competitions', cid), snap => {
    if (!snap.exists()) return;
    const prevShown = controlsPublic();
    comp = { id: cid, ...snap.data() };
    // The map instance is normally kept across re-renders; when the admin
    // flips "Visa kontrollplatser publikt" it must be rebuilt so open public
    // pages switch between tävlingsområde and controls live.
    if (prevShown !== controlsPublic() && pubMap) {
      try { pubMap.remove(); } catch {}
      pubMap = null;
    }
    render();
  }));

  // Timed auto-release: no snapshot fires when the clock passes the release
  // moment, so poll it — when the state flips, rebuild the map so an open
  // public page reveals the course by itself 5 min before first start.
  let lastShown = controlsPublic();
  const releaseTick = setInterval(() => {
    if (!comp) return;
    const shown = controlsPublic();
    if (shown === lastShown) return;
    lastShown = shown;
    if (pubMap) { try { pubMap.remove(); } catch {} pubMap = null; }
    render();
  }, 20000);
  unsubs.push(() => clearInterval(releaseTick));

  // Keep the "Kommande starter" countdowns fresh — re-render every 20 s while
  // the section is on screen (the map node survives re-renders, see render()).
  const startsTick = setInterval(() => {
    if (comp && parsePath()?.tab === 'overview' && upcomingStarts().length) render();
  }, 20000);
  unsubs.push(() => clearInterval(startsTick));
  unsubs.push(onSnapshot(collection(db, 'competitions', cid, 'patrols'), snap => {
    patrols = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }));
  unsubs.push(onSnapshot(collection(db, 'competitions', cid, 'controls'), snap => {
    controls = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Attach a score subscription per control — track subscribed IDs in a
    // dedicated set so we don't double-subscribe. Previously we compared to
    // `controls` itself, which was pre-populated via listControls() — meaning
    // every control looked "already subscribed" and no score listeners were
    // attached.
    for (const c of controls) {
      if (subscribedScoreCtrls.has(c.id)) continue;
      subscribedScoreCtrls.add(c.id);
      const u = onSnapshot(
        collection(db, 'competitions', cid, 'controls', c.id, 'scores'),
        s => { scoresByControl[c.id] = s.docs.map(d => ({ id: d.id, ...d.data() })); render(); }
      );
      unsubs.push(u);
    }
    render();
  }));

  render();
}

window.addEventListener('popstate', () => render());

let pubMap = null; // live Leaflet instance — reused across re-renders

async function renderLeafletMap(withPos, sfPoints = [], park = null) {
  const host = document.getElementById('pub-map');
  if (!host || (!withPos.length && !sfPoints.length && !park)) return;
  try {
    const L = await ensureLeaflet();
    if (!host.isConnected) return; // re-rendered while Leaflet loaded
    host.innerHTML = '';
    const allPts = [
      ...withPos.map(c => [c.lat, c.lng]),
      ...sfPoints.map(p => [p.lat, p.lng]),
      ...(park ? [[park.lat, park.lng]] : [])
    ];
    const avgLat = allPts.reduce((s, p) => s + p[0], 0) / allPts.length;
    const avgLng = allPts.reduce((s, p) => s + p[1], 0) / allPts.length;
    const map = L.map(host, { zoomControl: true, scrollWheelZoom: false }).setView([avgLat, avgLng], 14);
    pubMap = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap'
    }).addTo(map);

    const ordered = [...withPos].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
    if (controlsPublic()) {
      // Course line: start → controls in nummer order → finish. When a track
      // has been drawn in the Spår editor it is always the one shown — drawn
      // legs follow the actual path (solid), undrawn legs stay dashed fågelväg.
      const { legs, hasDrawn } = courseLegs(comp, ordered, track);
      drawCourseOnMap(L, map, legs);
      if (hasDrawn) addCourseChip(L, map, legs, track && track.speedKmh);

      // Control markers — label = only the number
      for (const c of ordered) {
        L.circleMarker([c.lat, c.lng], {
          radius: 14, color: '#ffffff', weight: 3, fillColor: '#E95F13', fillOpacity: 0.95
        })
          .bindTooltip(String(c.nummer ?? '?'), { permanent: true, direction: 'center', className: 'map-label' })
          .addTo(map);
      }
    } else {
      // Controls hidden until race day — shade the competition area instead.
      // The hull is computed from control + start/mål positions but reveals
      // no individual point (convex hull, buffered ~120 m outward).
      const area = competitionArea([...ordered, ...sfPoints]);
      if (area) {
        L.polygon(area, {
          color: '#003660', weight: 2, dashArray: '8 8', opacity: 0.8,
          fillColor: '#003660', fillOpacity: 0.10, interactive: false
        }).addTo(map);
        const label = L.control({ position: 'bottomleft' });
        label.onAdd = () => {
          const div = L.DomUtil.create('div');
          div.style.cssText = 'background:rgba(255,255,255,.92);border:1px solid #d2dde8;border-radius:8px;padding:4px 10px;font:600 12px/1.5 Helvetica,Arial,sans-serif;color:#003660;box-shadow:0 1px 4px rgba(0,0,0,.15);';
          div.textContent = 'Tävlingsområde';
          return div;
        };
        label.addTo(map);
      }
    }

    // Start/finish markers — distinctive yellow
    for (const p of sfPoints) {
      L.circleMarker([p.lat, p.lng], {
        radius: 16, color: '#003660', weight: 3, fillColor: '#E2E000', fillOpacity: 1
      })
        .bindTooltip(p.label, { permanent: true, direction: 'center', className: 'map-label map-label-sf' })
        .addTo(map);
    }

    // Parking marker — blue pill with square-parking icon
    if (park) {
      L.circleMarker([park.lat, park.lng], {
        radius: 16, color: '#ffffff', weight: 3, fillColor: '#003660', fillOpacity: 1
      })
        .bindTooltip(icon('square-parking', { size: 18, stroke: 2.5 }), {
          permanent: true, direction: 'center', className: 'map-label map-label-park'
        })
        .addTo(map);
    }

    if (allPts.length > 1) {
      map.fitBounds(L.latLngBounds(allPts).pad(0.2));
    }
  } catch (e) {
    console.warn('Leaflet load failed; leaving map host empty.', e);
  }
}

// --- Render -----------------------------------------------------------------
function render() {
  const parsed = parsePath(); if (!parsed) return;
  const tab = parsed.tab;
  const cid = parsed.cid;

  const totals = computeTotals();

  // render() runs on every live snapshot (each score report). Recreating the
  // map every time reset the visitor's pan/zoom mid-gesture and leaked the
  // old instance — so keep the live map's DOM node and move it into the new
  // markup instead.
  const keepMapEl = (tab === 'overview' && pubMap) ? document.getElementById('pub-map') : null;
  if (tab !== 'overview' && pubMap) {
    try { pubMap.remove(); } catch {}
    pubMap = null;
  }

  root.innerHTML = `
    ${renderHero()}
    <div class="pub-tabs-bar">
      <div class="pub-tabs">
        <a data-tab="overview"   href="/t/${cid}"            class="${tab==='overview'?'active':''}">Översikt</a>
        <a data-tab="patrols"    href="/t/${cid}/patrols"    class="${tab==='patrols'?'active':''}">Patruller</a>
        <a data-tab="scoreboard" href="/t/${cid}/scoreboard" class="${tab==='scoreboard'?'active':''}">${scoresPublic() ? 'Poängtabell' : 'Genomfört'}</a>
      </div>
    </div>
    <main class="page">
      ${tab === 'overview'   ? renderOverview(totals)  : ''}
      ${tab === 'patrols'    ? renderPatrols(totals)   : ''}
      ${tab === 'scoreboard' ? renderScoreboard(totals): ''}
    </main>
    ${renderFooter()}
  `;

  root.querySelectorAll('[data-tab]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      setTab(cid, a.dataset.tab);
    });
  });

  if (tab === 'overview') {
    const newHost = document.getElementById('pub-map');
    if (keepMapEl && newHost) {
      // Swap the freshly-rendered empty host for the live map's node.
      newHost.replaceWith(keepMapEl);
      requestAnimationFrame(() => { try { pubMap?.invalidateSize(); } catch {} });
    } else {
      const withPos = controls.filter(c => c.lat && c.lng);
      const sfPoints = startFinishPoints(comp);
      const park = parkingPoint(comp);
      if (withPos.length || sfPoints.length || park) renderLeafletMap(withPos, sfPoints, park);
    }
  }
}

function renderHero() {
  const openCount = controls.filter(c => c.open).length;
  const reg = registrationState(comp);
  const regSettings = registrationSettings(comp);
  const cid = parsePath()?.cid;
  return `
    <header class="pub-hero">
      <div class="pub-hero-pattern"></div>
      <img class="pub-hero-symbol" src="/assets/scout-symbol.svg" alt="" aria-hidden="true">
      <div class="page">
        <div class="pub-hero-top">
          <div class="pub-brand">
            <img src="/assets/logo-scouterna-tagline-white.svg" alt="Scouterna">
            <span class="divider"></span>
            <span class="sublabel">ESKIL</span>
          </div>
          ${openCount > 0 ? `<div class="status-pill"><span class="dot-live"></span>Tävlingen pågår · live</div>` : ''}
        </div>
        <div class="t-over" style="color:var(--rover-yellow);">${escapeHtml(comp.shortName || '')} · ${comp.year || ''}</div>
        <h1>${escapeHtml(comp.name || '')}</h1>
        ${comp.description ? `<p class="lede">${escapeHtml(comp.description)}</p>` : ''}
        <div class="meta">
          ${comp.date ? `<span><b>${escapeHtml(formatDate(comp.date))}</b> · datum</span>` : ''}
          ${comp.location ? `<span><b>${escapeHtml(comp.location)}</b> · plats</span>` : ''}
          ${comp.organizer ? `<span><b>${escapeHtml(comp.organizer)}</b> · arrangör</span>` : ''}
        </div>
        ${reg === 'open' ? `
          <a class="hero-cta" href="/a/${escapeHtml(cid || '')}">Anmäl er nu${regSettings.closesAt ? ` — öppet t.o.m. ${escapeHtml(formatDate(regSettings.closesAt))}` : ''} →</a>
        ` : ''}
      </div>
    </header>
  `;
}

function renderFooter() {
  return `
    <footer class="pub-foot">
      <div class="page">
        <div style="display:flex;align-items:center;gap:var(--sp-4);">
          <img src="/assets/logo-scouterna-tagline-white.svg" alt="Scouterna">
          <span>· ESKIL · ${comp?.year || ''}</span>
        </div>
        <span class="muted">${scoresPublic()
          ? 'Poängtabellen uppdateras direkt när kontrollanter rapporterar.'
          : 'Poängen publiceras av tävlingsledningen — tills dess visas bara genomförda kontroller.'}</span>
      </div>
    </footer>
  `;
}

// --- Tab: Overview ---------------------------------------------------------

// Days until the competition date (local midnight to local midnight);
// null when no date is set. 0 = today.
function daysUntilComp() {
  if (!comp?.date) return null;
  const [Y, M, D] = String(comp.date).split('-').map(Number);
  if (![Y, M, D].every(Number.isFinite)) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((new Date(Y, M - 1, D) - today) / 86400000);
}

function pricingText(p) {
  switch (p.model) {
    case 'scout':    return p.perScout ? `${p.perScout} kr per scout` : '';
    case 'kar':      return p.flat ? `${p.flat} kr per kår` : '';
    case 'dynamisk': return `${p.base} kr per kår + ${p.perUnit} kr per ${p.unit === 'scout' ? 'scout' : 'patrull'}`;
    default:         return p.perPatrol ? `${p.perPatrol} kr per patrull` : '';
  }
}

// Registration call-to-action card — the reason this page can be sent to
// kårer before the competition. Open → big CTA; upcoming → when it opens.
function renderRegistrationCta() {
  const state = registrationState(comp);
  if (state === 'unconfigured') return '';
  const s = registrationSettings(comp);
  const cid = parsePath()?.cid;
  const price = pricingText(s.pricing);

  if (state === 'open') {
    return `
      <section class="reg-cta">
        <div>
          <div class="t-over" style="color:var(--avent-orange);">Anmälan</div>
          <h2>Anmälan är öppen${s.closesAt ? ` t.o.m. ${escapeHtml(formatDate(s.closesAt))}` : ''}</h2>
          <div class="reg-meta">
            ${s.mode === 'patrull' ? 'Anmälan görs per patrull.' : 'Anmäl hela kåren på en gång — flera patruller i samma anmälan.'}
            ${price ? ` Avgift: <b>${escapeHtml(price)}</b>.` : ''}
            ${s.info ? `<br>${escapeHtml(s.info)}` : ''}
          </div>
        </div>
        <a class="btn-anmal" href="/a/${escapeHtml(cid || '')}">Till anmälan →</a>
      </section>
    `;
  }
  if (state === 'before' && s.opensAt) {
    return `
      <section class="reg-cta is-info">
        <div>
          <div class="t-over" style="color:var(--upp-blue);">Anmälan</div>
          <h2>Anmälan öppnar ${escapeHtml(formatDate(s.opensAt))}</h2>
          <div class="reg-meta">${price ? `Avgift: <b>${escapeHtml(price)}</b>. ` : ''}${s.info ? escapeHtml(s.info) : 'Håll utkik här — anmälningslänken aktiveras när perioden öppnar.'}</div>
        </div>
      </section>
    `;
  }
  return ''; // closed → inget skrik om det; tävlingssidan lever vidare
}

// Upcoming starts — a light live version of the startskärm. Only meaningful
// on the competition day (start times are wall-clock anchored), or on demo
// competitions where the schedule rolls with the clock.
function upcomingStarts(now = new Date()) {
  const s = startTimeSettings(comp);
  if (!s.enabled || !patrols.length) return [];
  if (!comp.demo && comp.date && daysUntilComp() !== 0) return [];
  return patrols
    .map(p => ({ p, dt: patrolStartDateTime(comp, p, now, patrols.length) }))
    .filter(x => x.dt && x.dt.getTime() > now.getTime() - 60000)
    .sort((a, b) => a.dt - b.dt)
    .slice(0, 8);
}

function countdownText(dt, now = new Date()) {
  const min = Math.round((dt - now) / 60000);
  if (min <= 0) return 'nu';
  if (min < 60) return `om ${min} min`;
  return `om ${Math.floor(min / 60)} h ${min % 60} min`;
}

function renderUpcomingStarts() {
  const cid = parsePath()?.cid;
  const now = new Date();
  const rows = upcomingStarts(now);
  if (!rows.length) return '';
  return `
    <div class="pub-section-head"><h2 class="t-h2">Kommande starter</h2><span class="muted">Live · klicka för startkort</span></div>
    <div class="starts-list">
      ${rows.map(({ p, dt }) => {
        const cd = countdownText(dt, now);
        return `
          <a class="start-row ${cd === 'nu' ? 'is-now' : ''}" href="/s/${escapeHtml(cid || '')}/${escapeHtml(p.id)}" target="_blank" rel="noopener">
            <span class="st-time">${dt.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}</span>
            <span class="st-who">
              <span class="nm">#${p.number ?? '—'} ${escapeHtml(p.name || '')}</span>
              <span class="sub"><span class="dot ${avdSlug(p.avdelning)}"></span>${escapeHtml(p.avdelning || '')}${p.kar ? ' · ' + escapeHtml(p.kar) : ''}</span>
            </span>
            <span class="st-count">${escapeHtml(cd)}</span>
            <span class="st-link">Startkort →</span>
          </a>
        `;
      }).join('')}
    </div>
  `;
}

function renderOverview(totals) {
  const avdCounts = {};
  patrols.forEach(p => { avdCounts[p.avdelning] = (avdCounts[p.avdelning] || 0) + 1; });
  const karer = new Set(patrols.map(p => p.kar).filter(Boolean));

  const podium = [...totals].sort((a,b) => b.grand - a.grand).slice(0, 3);

  // Fourth KPI adapts to where we are: live count during the race, countdown
  // before it, track length as a teaser otherwise.
  const openCount = controls.filter(c => c.open).length;
  const days = daysUntilComp();
  const trackDist = track && controlsPublic() ? courseDistance(courseLegs(comp, controls, track).legs) : 0;
  const kpi4 = openCount > 0 ? { label: 'Öppna just nu', val: openCount }
    : (days != null && days > 0) ? { label: days === 1 ? 'Dag kvar' : 'Dagar kvar', val: days }
    : trackDist > 0 ? { label: 'Spårlängd', val: fmtDist(trackDist) }
    : { label: 'Öppna just nu', val: openCount };

  return `
    ${renderRegistrationCta()}

    <section class="pub-kpis">
      <div class="pub-kpi"><div class="label">Patruller</div><div class="val">${patrols.length}</div></div>
      <div class="pub-kpi"><div class="label">Kontroller</div><div class="val">${controls.length}</div></div>
      <div class="pub-kpi"><div class="label">Kårer</div><div class="val">${karer.size}</div></div>
      <div class="pub-kpi"><div class="label">${kpi4.label}</div><div class="val">${kpi4.val}</div></div>
    </section>

    ${renderUpcomingStarts()}

    ${scoresPublic() && podium.length && podium[0].grand > 0 ? `
      <div class="pub-section-head"><h2 class="t-h2">Topp tre · Overall</h2><span class="muted">Live</span></div>
      <div class="podium">
        ${renderPodiumStep(podium[1], 2, 'p2')}
        ${renderPodiumStep(podium[0], 1, 'p1')}
        ${renderPodiumStep(podium[2], 3, 'p3')}
      </div>
    ` : ''}

    <div class="pub-section-head"><h2 class="t-h2">Avdelningar</h2><span class="muted">${patrols.length ? 'Klicka för detaljer' : 'Avdelningar som tävlar'}</span></div>
    <div class="avd-cards">
      ${allowedAvdelningar(comp).map(a => `
        <a class="avd-card ${avdSlug(a.key)}" data-avd="${a.key}" href="#">
          <div class="top">
            <span class="label">${a.key}</span>
            ${avdIllustration(a.key)}
          </div>
          <div class="bottom">
            <span class="count-label">Patruller</span>
            <span class="count">${avdCounts[a.key] || 0}</span>
          </div>
        </a>
      `).join('')}
    </div>

    ${renderManagement()}
    ${renderMap()}
  `;
}

function renderManagement() {
  const active = publicManagement(comp);
  if (!active.length) return '';
  return `
    <div class="pub-section-head"><h2 class="t-h2">Tävlingsledning</h2><span class="muted">Kontakta vid frågor</span></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:var(--sp-4);margin-bottom:var(--sp-8);">
      ${active.map(r => `
        <div class="card">
          <div class="t-over" style="color:var(--scout-blue);">${escapeHtml(r.label)}</div>
          ${r.name ? `<h3 class="t-h4" style="margin:6px 0 4px;">${escapeHtml(r.name)}</h3>` : ''}
          ${r.phone ? `<div class="mt-2"><a href="tel:${escapeHtml(r.phone)}" class="mono" style="color:var(--scout-blue);text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:6px;">${icon('phone', { size: 16 })} ${escapeHtml(r.phone)}</a></div>` : ''}
          ${r.email ? `<div class="mt-2"><a href="mailto:${escapeHtml(r.email)}" style="color:var(--scout-blue);word-break:break-all;display:inline-flex;align-items:center;gap:6px;">${icon('mail', { size: 16 })} ${escapeHtml(r.email)}</a></div>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function renderPodiumStep(row, rank, cls) {
  if (!row) return `<div class="podium-step ${cls}"><div class="rank">${rank}:a</div><div class="score">—</div></div>`;
  return `
    <div class="podium-step ${cls}">
      <div class="rank">${rank}:a plats</div>
      <div class="score">${row.grand}</div>
      <div class="p-name">${escapeHtml(row.name || '')}</div>
      <div class="p-kar">${escapeHtml(row.kar || '')}</div>
      <div class="mt-2"><span class="dot ${avdSlug(row.avdelning)}"></span>${escapeHtml(row.avdelning || '')}</div>
    </div>
  `;
}

function renderMap() {
  const withPos = controls.filter(c => c.lat && c.lng);
  const sf = startFinishPoints(comp);
  const park = parkingPoint(comp);
  if (!withPos.length && !sf.length) return '';
  // Notes for the special points (parking, start, finish). Only render the
  // section if at least one of them has a non-empty note.
  const notedPoints = [park, ...sf].filter(p => p && (p.note || '').trim());
  const notesBlock = notedPoints.length ? `
    <div class="map-notes">
      ${notedPoints.map(p => `
        <div class="map-note">
          <div class="map-note-head">
            <span class="badge ${p.kind === 'parking' ? 'badge-blue' : 'badge-orange'}">${escapeHtml(p.title)}</span>
            ${p.name ? `<strong>${escapeHtml(p.name)}</strong>` : ''}
          </div>
          <p>${escapeHtml(p.note)}</p>
        </div>
      `).join('')}
    </div>
  ` : '';

  return `
    <div class="pub-section-head"><h2 class="t-h2">Karta</h2><span class="muted">${controlsPublic()
      ? `${withPos.length} kontroller${sf.length ? ' · start/mål' : ''}${park ? ' · parkering' : ''}`
      : `tävlingsområde${sf.length ? ' · start/mål' : ''}${park ? ' · parkering' : ''}`}</span></div>
    <div class="map-card">
      <div id="pub-map"></div>
      <div class="foot">
        <span>${(() => {
          if (controlsPublic()) return 'Kontrollpositioner — exakta platser kan skilja något.';
          const rel = controlsReleaseTime(comp);
          return rel
            ? `Banan släpps här ${rel.toLocaleDateString('sv-SE', { day: 'numeric', month: 'long' })} kl ${rel.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })} — 5 min före första start.`
            : 'Kontrollernas platser visas här när tävlingsledningen släpper dem.';
        })()}</span>
      </div>
    </div>
    ${notesBlock}
  `;
}

// --- Tab: Patrols ----------------------------------------------------------
let avdFilter = null;
function renderPatrols(totals) {
  const rows = patrols
    .filter(p => !avdFilter || p.avdelning === avdFilter)
    .slice()
    .sort((a,b) => (a.number||0) - (b.number||0) || (a.name||'').localeCompare(b.name||'', 'sv'));
  const totalMap = Object.fromEntries(totals.map(t => [t.id, t]));

  const ctrlCount = controls.length || 1;

  return `
    <div class="pub-section-head"><h2 class="t-h2">Patruller</h2><span class="muted">${rows.length} av ${patrols.length}</span></div>
    <div class="avd-filter">
      <button class="${avdFilter === null ? 'active' : ''}" data-avd="">Alla</button>
      ${AVDELNINGAR.filter(a => patrols.some(p => p.avdelning === a.key))
        .map(a => `<button class="${avdFilter === a.key ? 'active' : ''}" data-avd="${a.key}"><span class="dot ${avdSlug(a.key)}"></span>${a.key}</button>`)
        .join('')}
    </div>

    ${rows.length === 0 ? `
      <div class="empty"><h3>Inga patruller att visa</h3></div>
    ` : `
      <div class="pat-grid">
        ${rows.map(p => {
          const t = totalMap[p.id];
          const done = t?.count || 0;
          const pct = Math.round((done / ctrlCount) * 100);
          const stime = patrolStartTime(comp, p, patrols.length);
          return `<button type="button" class="pat-card" data-patrol="${escapeHtml(p.id)}">
            <div class="n">#${p.number ?? '—'} · <span class="dot ${avdSlug(p.avdelning)}"></span>${escapeHtml(p.avdelning || '')}${stime ? ` · <span class="mono" style="color:var(--scout-blue);">${escapeHtml(stime)}</span>` : ''}</div>
            <div class="name">${escapeHtml(p.name || '')}</div>
            <div class="kar">${escapeHtml(p.kar || '')}</div>
            <div class="progress"><span style="width:${pct}%"></span></div>
            <div class="progress-label"><span>${done} / ${ctrlCount} kontroller</span>${scoresPublic() ? `<span>${t?.grand || 0} p</span>` : ''}</div>
          </button>`;
        }).join('')}
      </div>
    `}
  `;
}

// --- Tab: Scoreboard -------------------------------------------------------
let scoreView = 'overall'; // 'overall' | 'avd:<key>' | 'kar'
function renderScoreboard(totals) {
  if (!scoresPublic()) return renderCompletionBoard(totals);
  const tabs = [
    { key: 'overall', label: 'Overall' },
    ...AVDELNINGAR.filter(a => patrols.some(p => p.avdelning === a.key))
      .map(a => ({ key: 'avd:' + a.key, label: a.key })),
    { key: 'kar', label: 'Per kår' }
  ];

  let body;
  if (scoreView === 'kar') {
    // Pre-rank all patrols to get maxedCount, then aggregate by kår.
    const rankedPatrols = rankPatrols(totals, controls);
    const byKar = {};
    for (const t of rankedPatrols) {
      const k = t.kar || '(Okänd)';
      if (!byKar[k]) byKar[k] = { kar: k, total: 0, extra: 0, patrols: [], count: 0, maxedCount: 0 };
      byKar[k].total      += t.total;
      byKar[k].extra      += t.extra;
      byKar[k].count      += t.count;
      byKar[k].maxedCount += t.maxedCount;
      byKar[k].patrols.push(t);
    }
    const karRaw = Object.values(byKar)
      .map(r => ({ ...r, grand: r.total + r.extra, avg: r.patrols.length ? r.total / r.patrols.length : 0 }));
    const karRows = rankKarer(karRaw);
    body = `
      <div class="lb"><table>
        <thead><tr><th class="rank">#</th><th>Kår</th><th class="num">Patruller</th><th class="num">Kontroller</th><th class="num">Max</th><th class="num">Snitt</th><th class="num">Extra</th><th class="num">Total</th></tr></thead>
        <tbody>
          ${karRows.map(r => `<tr class="${r.rank<=3?'top'+r.rank:''}">
            <td class="rank">${r.rank === 1 ? icon('trophy', { size: 16 }) + ' ' : ''}${r.rank}</td>
            <td><span class="pname">${escapeHtml(r.kar)}</span></td>
            <td class="num">${r.patrols.length}</td>
            <td class="num">${r.count}</td>
            <td class="num">${r.maxedCount}</td>
            <td class="num">${r.avg.toFixed(1)}</td>
            <td class="num">${r.extra || ''}</td>
            <td class="num total">${r.grand}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>
    `;
  } else {
    let rows = totals.slice();
    if (scoreView.startsWith('avd:')) {
      rows = rows.filter(r => r.avdelning === scoreView.slice(4));
    }
    rows = rankPatrols(rows, controls);
    body = rows.length ? `
      <div class="lb"><table>
        <thead><tr><th class="rank">#</th><th>Patrull</th><th>Kår</th><th class="num">Kontr.</th><th class="num">Max</th><th class="num">Extra</th><th class="num">Total</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr class="${r.rank<=3?'top'+r.rank:''} is-clickable" data-patrol="${escapeHtml(r.id)}">
            <td class="rank">${r.rank === 1 ? icon('trophy', { size: 16 }) + ' ' : ''}${r.rank}</td>
            <td>
              <span class="pname">${escapeHtml(r.name || '')}</span>
              <div style="font-size:12px;color:var(--fg3);"><span class="dot ${avdSlug(r.avdelning)}"></span>${escapeHtml(r.avdelning || '')}</div>
            </td>
            <td><span class="pkar">${escapeHtml(r.kar || '')}</span></td>
            <td class="num">${r.count}</td>
            <td class="num">${r.maxedCount}</td>
            <td class="num">${r.extra || ''}</td>
            <td class="num total">${r.grand}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>
    ` : '<div class="empty"><h3>Inga resultat än</h3></div>';
  }

  return `
    <div class="pub-section-head">
      <h2 class="t-h2">Poängtabell</h2>
      <span class="muted">Live-uppdaterad</span>
    </div>
    ${renderRankingInfo()}
    <div class="sub-tabs">
      ${tabs.map(t => `<button data-view="${t.key}" class="${scoreView === t.key ? 'active' : ''}">${escapeHtml(t.label)}</button>`).join('')}
    </div>
    ${body}
  `;
}

// Scores unpublished: show which controls each patrol has completed (green
// check per control) without revealing points or ranking. Rows are in
// patrol-number order so nothing about the standings leaks.
function renderCompletionBoard(totals) {
  const tabs = [
    { key: 'overall', label: 'Alla' },
    ...AVDELNINGAR.filter(a => patrols.some(p => p.avdelning === a.key))
      .map(a => ({ key: 'avd:' + a.key, label: a.key }))
  ];
  if (!tabs.some(t => t.key === scoreView)) scoreView = 'overall';

  const totalMap = Object.fromEntries(totals.map(t => [t.id, t]));
  const ctrls = [...controls].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
  const rows = patrols
    .filter(p => !scoreView.startsWith('avd:') || p.avdelning === scoreView.slice(4))
    .slice()
    .sort((a, b) => (a.number || 0) - (b.number || 0) || (a.name || '').localeCompare(b.name || '', 'sv'));

  const body = rows.length ? `
    <div class="lb lb-matrix"><table>
      <thead><tr>
        <th>Patrull</th><th>Kår</th><th class="num">Klara</th>
        ${ctrls.map(c => `<th class="num">${c.nummer ?? ''}</th>`).join('')}
      </tr></thead>
      <tbody>
        ${rows.map(p => {
          const t = totalMap[p.id];
          return `<tr class="is-clickable" data-patrol="${escapeHtml(p.id)}">
            <td>
              <span class="pname">${escapeHtml(p.name || '')}</span>
              <div style="font-size:12px;color:var(--fg3);"><span class="dot ${avdSlug(p.avdelning)}"></span>${escapeHtml(p.avdelning || '')}</div>
            </td>
            <td><span class="pkar">${escapeHtml(p.kar || '')}</span></td>
            <td class="num">${t?.count || 0}/${ctrls.length}</td>
            ${ctrls.map(c => t?.perControl?.[c.id]
              ? `<td class="num done-check">${icon('check', { size: 18, stroke: 3 })}</td>`
              : `<td class="num"><span class="muted">—</span></td>`).join('')}
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>
  ` : '<div class="empty"><h3>Inga patruller att visa</h3></div>';

  return `
    <div class="pub-section-head">
      <h2 class="t-h2">Genomförda kontroller</h2>
      <span class="muted">Live-uppdaterad</span>
    </div>
    <div class="pub-notice">${icon('info', { size: 16 })}<span>Poängen är inte publicerade ännu. En grön bock visar att patrullen genomfört kontrollen.</span></div>
    <div class="sub-tabs">
      ${tabs.map(t => `<button data-view="${t.key}" class="${scoreView === t.key ? 'active' : ''}">${escapeHtml(t.label)}</button>`).join('')}
    </div>
    ${body}
  `;
}

// --- Totals helper ---------------------------------------------------------
function computeTotals() {
  const map = {};
  for (const p of patrols) {
    map[p.id] = { ...p, id: p.id, total: 0, extra: 0, count: 0, perControl: {} };
  }
  for (const ctrlId of Object.keys(scoresByControl)) {
    for (const s of scoresByControl[ctrlId]) {
      const row = map[s.patrolId];
      if (!row) continue;
      row.total += Number(s.poang) || 0;
      row.extra += Number(s.extraPoang) || 0;
      row.count += 1;
      row.perControl[ctrlId] = s;
    }
  }
  for (const r of Object.values(map)) r.grand = r.total + r.extra;
  return Object.values(map);
}

function renderRankingInfo() {
  return `
    <details class="rules-info">
      <summary>Placeringsregler</summary>
      <ol>
        ${RANKING_RULES_TEXT.map(r => `<li><strong>${escapeHtml(r.title)}</strong> — ${escapeHtml(r.rule)}</li>`).join('')}
      </ol>
    </details>
  `;
}

// --- Delegated interactions ------------------------------------------------
document.addEventListener('click', (e) => {
  const avdBtn = e.target.closest('.avd-filter button');
  if (avdBtn) {
    avdFilter = avdBtn.dataset.avd || null;
    render();
    return;
  }
  const avdCard = e.target.closest('.avd-card[data-avd]');
  if (avdCard) {
    e.preventDefault();
    avdFilter = avdCard.dataset.avd;
    scoreView = 'avd:' + avdCard.dataset.avd;
    setTab(parsePath().cid, 'scoreboard');
    return;
  }
  const subTab = e.target.closest('.sub-tabs button[data-view]');
  if (subTab) {
    scoreView = subTab.dataset.view;
    render();
    return;
  }
  const patBtn = e.target.closest('[data-patrol]');
  if (patBtn) {
    openPatrolModal(patBtn.dataset.patrol);
    return;
  }
});

// --- Patrol detail modal ---------------------------------------------------
// Click on a patrol card or scoreboard row to see every control the patrol has
// scored, with the points and optional reporter note. Respects the
// competition's anonymousControls flag: while a control is still open, its
// name is hidden (only the number is shown) — only when an admin closes the
// control does its name reveal on this public view.
function openPatrolModal(patrolId) {
  const patrol = patrols.find(p => p.id === patrolId);
  if (!patrol) return;

  const anon = comp?.anonymousControls !== false;
  const showScores = scoresPublic();
  const controlName = (c) => (anon && c.open) ? `Kontroll ${c.nummer ?? '?'}` : (c.name || `Kontroll ${c.nummer ?? '?'}`);

  // Gather this patrol's score for every control, in control-number order.
  const sorted = [...controls].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
  const perCtrl = sorted.map(c => {
    const score = (scoresByControl[c.id] || []).find(s => s.patrolId === patrolId);
    return { control: c, score };
  });
  const totals = perCtrl.reduce((acc, { score }) => {
    if (!score) return acc;
    acc.done += 1;
    acc.poang += Number(score.poang) || 0;
    acc.extra += Number(score.extraPoang) || 0;
    return acc;
  }, { done: 0, poang: 0, extra: 0 });
  const grand = totals.poang + totals.extra;

  const stime = patrolStartTime(comp, patrol, patrols.length);

  const overlay = document.createElement('div');
  overlay.className = 'pub-modal-overlay';
  overlay.innerHTML = `
    <div class="pub-modal" role="dialog" aria-modal="true">
      <div class="pub-modal-head">
        <div>
          <div class="t-over" style="color:var(--avent-orange);">Patrull #${escapeHtml(String(patrol.number ?? ''))}</div>
          <h2 style="margin:4px 0 2px;">${escapeHtml(patrol.name || '')}</h2>
          <div class="muted t-sm">
            <span class="dot ${avdSlug(patrol.avdelning)}"></span>${escapeHtml(patrol.avdelning || '')}
            ${patrol.kar ? ' · ' + escapeHtml(patrol.kar) : ''}
            ${patrol.antal ? ' · ' + escapeHtml(String(patrol.antal)) + ' deltagare' : ''}
            ${stime ? ' · <span class="mono" style="color:var(--scout-blue);">' + escapeHtml(stime) + '</span>' : ''}
          </div>
          <a class="t-sm" style="display:inline-flex;align-items:center;gap:5px;margin-top:8px;color:var(--scout-blue);font-weight:600;" href="/s/${escapeHtml(parsePath()?.cid || '')}/${escapeHtml(patrol.id)}" target="_blank" rel="noopener">${icon('external', { size: 14 })} Öppna patrullens startkort</a>
        </div>
        <button type="button" class="icon-btn" id="pub-modal-close" aria-label="Stäng">${icon('x', { size: 20 })}</button>
      </div>

      <div class="pub-modal-totals ${showScores ? '' : 'no-scores'}">
        <div>
          <div class="val">${totals.done}<span class="of">/${sorted.length}</span></div>
          <div class="lbl">Kontroller</div>
        </div>
        ${showScores ? `
          <div>
            <div class="val">${totals.poang}</div>
            <div class="lbl">Poäng</div>
          </div>
          <div>
            <div class="val">${totals.extra}</div>
            <div class="lbl">Extra</div>
          </div>
          <div class="grand">
            <div class="val">${grand}</div>
            <div class="lbl">Totalt</div>
          </div>
        ` : ''}
      </div>

      ${showScores ? '' : `<p class="pub-modal-hint muted t-sm">Poängen är inte publicerade ännu — en grön bock visar genomförd kontroll.</p>`}
      ${anon ? `<p class="pub-modal-hint muted t-sm">Anonyma kontroller: namn visas först när kontrollen stängts.</p>` : ''}

      <div class="pub-modal-list">
        ${perCtrl.map(({ control, score }) => {
          const name = controlName(control);
          const hidden = anon && control.open;
          if (score) {
            const extra = Number(score.extraPoang) || 0;
            return `
              <div class="pub-modal-row is-done">
                <div class="num">#${escapeHtml(String(control.nummer ?? '?'))}</div>
                <div class="name ${hidden ? 'is-hidden' : ''}">${escapeHtml(name)}</div>
                ${showScores ? `
                  <div class="pts">
                    <span class="main">${Number(score.poang) || 0}</span>
                    ${extra > 0 ? `<span class="extra">+${extra}</span>` : ''}
                  </div>
                ` : `<div class="pts done-icon">${icon('check', { size: 20, stroke: 3 })}</div>`}
                ${score.note ? `<div class="note">${escapeHtml(score.note)}</div>` : ''}
              </div>
            `;
          }
          return `
            <div class="pub-modal-row is-pending">
              <div class="num">#${escapeHtml(String(control.nummer ?? '?'))}</div>
              <div class="name ${hidden ? 'is-hidden' : ''}">${escapeHtml(name)}</div>
              <div class="pts muted">${control.open ? 'Öppen' : 'Inte rapporterat'}</div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // The Escape listener must be removed however the modal closes — the old
  // code only removed it on Escape itself, so every ✕/backdrop close leaked
  // one document-level listener (each retaining its overlay DOM).
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  wireOverlayClose(overlay, close);
  overlay.querySelector('#pub-modal-close').onclick = close;
  document.addEventListener('keydown', onKey);
}

function renderNotFound(msg) {
  root.innerHTML = `
    <header class="pub-hero">
      <div class="pub-hero-pattern"></div>
      <div class="page">
        <div class="pub-brand">
          <img src="/assets/logo-scouterna-tagline-white.svg" alt="Scouterna">
        </div>
        <h1>Tävlingen hittades inte</h1>
        <p class="lede">${escapeHtml(msg)}</p>
      </div>
    </header>
  `;
}

boot();
