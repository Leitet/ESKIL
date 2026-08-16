// ESKIL — public landing page for a competition.
// No auth. Reads are public (competitions, patrols, controls, scores).
// URL pattern: /t/<competitionId>[/<tab>]
// Tabs: overview (default), patrols, scoreboard.

import { db, doc, getDoc, onSnapshot, collection, auth, onAuthStateChanged } from './firebase.js';
import { getCompetition, getCompetitionBySlug, listPatrols, listControls, getTrack, watchBroadcastMessages } from './store.js';
import { courseLegs, drawCourseOnMap, addCourseChip, competitionArea, courseDistance, fmtDist, courseEtaCalibrated, patrolFinishEtaMs } from './course.js';
import {
  AVDELNINGAR, escapeHtml, publicNotices, anslagSynlig, linkifyText, formatDate, publicManagement, patrolStartTime,
  patrolStartDateTime, startTimeSettings, allowedAvdelningar,
  registrationSettings, registrationState,
  startFinishPoints, rankPatrols, rankKarer, RANKING_RULES_TEXT,
  wireOverlayClose, controlsAutoReleased, controlsReleaseTime, utslagRows, isNumSet,
  copyToClipboard, toast
} from './utils.js';
import { ensureLeaflet } from './leaflet.js';
import { compPlaces, placeKind, drawPlaces } from './places.js';
import { icon } from './icons.js';
import { buildIcs } from './ics.js';
import { showSystemNotification } from './broadcast.js';

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
let adminAccess = false; // signed-in visitor may administer → "Administrera" in hero
let realCid = null;      // resolved competition id (the URL may carry the slug)
const subscribedScoreCtrls = new Set();
let anslag = [];                 // publika anslag från tävlingsledningen
// Följ-länkens markering. /t renderar om vid VARJE poäng- och anslagssnapshot,
// så en klass som sätts en gång rivs av nästa render. Markeringen hålls därför
// i modulstate och sätts tillbaka efter varje render, i ett kort fönster.
let foljdPatrull = null;
let foljdTill = 0;
const FOLJD_MS = 12000;
let anslagSeedat = false;        // första server-snapshoten notiserar inte
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
// publicScores. Startkorten (/s) follow the SAME gate (scouts hold their
// links days ahead and must not scout the course); reporter links (/k) always
// show positions — kontrollanterna need them to build their control.
// With autoReleaseControls the course releases itself 5 min before the first
// patrol's start on the competition date (see controlsAutoReleased).
function controlsPublic() {
  return comp?.publicControls !== false || controlsAutoReleased(comp);
}

async function boot() {
  const parsed = parsePath();
  if (!parsed) return renderNotFound('Ogiltig länk.');
  // The URL segment is a competition id OR its fixed slug (/t/ah26) — the
  // address bar keeps whichever the visitor used; Firestore paths use the
  // resolved id.
  let cid = parsed.cid;
  try {
    comp = await getCompetition(cid);
    if (!comp) {
      comp = await getCompetitionBySlug(cid);
      if (comp) cid = comp.id;
    }
    if (comp) {
      [patrols, controls, track] = await Promise.all([
        listPatrols(cid),
        listControls(cid),
        getTrack(cid).catch(() => null)
      ]);
    }
  } catch (e) {
    return renderNotFound('Kunde inte ladda tävlingen: ' + e.message);
  }
  if (!comp) return renderNotFound('Tävlingen hittades inte.');
  realCid = cid;
  document.title = `${comp.name || 'Tävling'} — ESKIL`;

  // Sessions are long-lived, so an admin who opens the public page is often
  // already signed in — give them a shortcut into the admin app. Anonymous
  // visitors never see it. Admin e-mail lists live in the member-only
  // private/access subdoc (PII Fas 3c), so a denied read simply means "no".
  onAuthStateChanged(auth, async (user) => {
    const ok = await checkAdminAccess(user, cid);
    if (ok !== adminAccess) { adminAccess = ok; render(); }
  });

  // Live updates for competition, patrols, and every control's scores
  // Anslagstavlan. Prenumerationen går på det UPPLÖSTA id:t — nås sidan via
  // kortadressen (/t/ah26, normalvägen) är parsed.cid slugen, och en lyssnare
  // på den hade pekat på en tävling som inte finns: inga anslag, ingen felkod.
  unsubs.push(watchBroadcastMessages(cid, (msgs) => {
    const nya = publicNotices(msgs);
    const fanns = new Set(anslag.map(a => a.id));
    anslag = nya;
    renderAnslag();
    // Tyst seedning: den som öppnar sidan mitt under dagen ska inte få en
    // notis per anslag som redan står uppe.
    if (!anslagSeedat) { anslagSeedat = true; return; }
    for (const a of nya) {
      if (fanns.has(a.id)) continue;
      showSystemNotification(`${comp?.shortName || 'Tävlingen'}`, { body: a.text, tag: `eskil-anslag-${a.id}` });
    }
  }));

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

  // Keep the startlista alive: every second the clock, countdowns and row
  // states (upcoming → GÅR NU → startade) are patched in place — no
  // re-render, so the visitor's scroll position in the list never moves.
  const clockTick = setInterval(() => {
    const clock = document.getElementById('pub-clock');
    if (!clock) return;
    const now = new Date();
    clock.textContent = now.toLocaleTimeString('sv-SE');
    document.querySelectorAll('.start-row .st-count[data-dt]').forEach(el => {
      const dt = new Date(el.dataset.dt);
      const row = el.closest('.start-row');
      if (dt - now <= -60000) {
        el.textContent = el.dataset.fin || 'startade';
        row?.classList.add('is-past');
        row?.classList.remove('is-now');
      } else {
        const cd = countdownText(dt, now);
        el.textContent = cd;
        row?.classList.toggle('is-now', cd === 'GÅR NU');
        row?.classList.remove('is-past');
      }
    });
  }, 1000);
  unsubs.push(() => clearInterval(clockTick));

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
        s => {
          scoresByControl[c.id] = s.docs.map(d => ({ id: d.id, ...d.data() }));
          notiseraFavoriter(c.id, scoresByControl[c.id], s.metadata.fromCache);
          render();
        }
      );
      unsubs.push(u);
    }
    render();
  }));

  render();

  // Följ-länken konsumeras efter första renderingen, så raden finns att
  // scrolla till. Görs i en rAF eftersom listan just skrivits till DOM:en.
  const foljd = konsumeraFoljLank();
  if (foljd) {
    foljdPatrull = foljd;
    foljdTill = Date.now() + FOLJD_MS;
    render();
    requestAnimationFrame(() => markeraFoljd({ scrolla: true }));
  }
}

window.addEventListener('popstate', () => render());

let pubMap = null; // live Leaflet instance — reused across re-renders

// Popup for the special map points (S/M, S, M, P): title, place name, the
// admin's note and a directions link — what a parent standing in the wrong
// field actually needs.
function pointPopupHtml(p) {
  const dir = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${p.lat},${p.lng}`)}`;
  return `
    <div class="map-popup">
      <div class="map-popup-title">${escapeHtml(p.title || '')}</div>
      ${p.name ? `<div class="map-popup-name">${escapeHtml(p.name)}</div>` : ''}
      ${(p.note || '').trim() ? `<p class="map-popup-note">${escapeHtml(p.note)}</p>` : ''}
      <a class="map-popup-dir" href="${dir}" target="_blank" rel="noopener">Vägbeskrivning ${icon('external', { size: 12 })}</a>
    </div>`;
}

async function renderLeafletMap(withPos, sfPoints = [], places = []) {
  const host = document.getElementById('pub-map');
  if (!host || (!withPos.length && !sfPoints.length && !places.length)) return;
  try {
    const L = await ensureLeaflet();
    if (!host.isConnected) return; // re-rendered while Leaflet loaded
    host.innerHTML = '';
    const allPts = [
      ...withPos.map(c => [c.lat, c.lng]),
      ...sfPoints.map(p => [p.lat, p.lng]),
      ...places.map(p => [p.lat, p.lng])
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

    // Start/finish markers — distinctive yellow; click opens the info popup
    for (const p of sfPoints) {
      L.circleMarker([p.lat, p.lng], {
        radius: 16, color: '#003660', weight: 3, fillColor: '#E2E000', fillOpacity: 1
      })
        .bindTooltip(p.label, { permanent: true, direction: 'center', className: 'map-label map-label-sf' })
        .bindPopup(pointPopupHtml(p), { offset: [0, -8] })
        .addTo(map);
    }

    // Intressepunkter — parkering, sekretariat, toaletter, egna punkter.
    // Gemensam ritning (places.js) så nålarna ser likadana ut på alla kartor.
    drawPlaces(L, map, places, {
      iconHtml: (n) => icon(n, { size: 18, stroke: 2.5 }),
      onPopup: (p) => pointPopupHtml({ title: placeKind(p.kind).label, name: p.name, note: p.note, lat: p.lat, lng: p.lng })
    });

    if (allPts.length > 1) {
      map.fitBounds(L.latLngBounds(allPts).pad(0.2));
    }
  } catch (e) {
    console.warn('Leaflet load failed; leaving map host empty.', e);
  }
}

// --- Render -----------------------------------------------------------------
// Följ-länk. En mor- eller farförälder ska kunna få EN länk som redan följer
// rätt patrull: /t/<slug>?folj=<patrolId>. patrolId är publikt läsbart och /t
// är en publik sida, så länken avslöjar ingenting — till skillnad från
// startkortets /s/<cid>/<patrolId>, som ALDRIG får delas så här.
//
// Parametern konsumeras EN gång och plockas ur adressfältet. Annars skulle
// varje omladdning stjärnmärka patrullen på nytt, och den som medvetet tagit
// bort stjärnan får tillbaka den — en inställning man inte kan stänga av är
// inte en inställning.
// Patrullen visas olika på olika flikar: startlistan har en stjärna
// (`data-fav`), patrullfliken kort med `data-patrol`, poängtabellen en rad med
// `data-patrol`. Sök därför på båda handtagen — en följ-länk som landar utan
// att peka ut raden är halva funktionen.
function markeraFoljd({ scrolla = false } = {}) {
  if (!foljdPatrull || Date.now() > foljdTill) { foljdPatrull = null; return; }
  const id = CSS.escape(foljdPatrull);
  const träff = document.querySelector(`[data-patrol="${id}"]`)
    || document.querySelector(`[data-fav="${id}"]`);
  const rad = träff?.closest('.start-row, .pat-card, tr') || träff;
  if (!rad) return;
  rad.classList.add('folj-blink');
  if (scrolla) rad.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function konsumeraFoljLank() {
  let pid = null;
  try {
    const u = new URL(location.href);
    pid = u.searchParams.get('folj');
    if (!pid) return null;
    u.searchParams.delete('folj');
    history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
  } catch { return null; }
  if (!patrols.some(p => p.id === pid)) return null;   // gammal eller påhittad länk
  const s = getFavs();
  s.add(pid);
  try { localStorage.setItem(favKey(), JSON.stringify([...s])); } catch { /* privat läge */ }
  return pid;
}

// Favoritpatrull — anhörigas stjärnmärkning. Ligger bara i webbläsarens
// localStorage (ingen server), en lista patrull-id per tävling.
function favKey() { return `eskil.fav.${parsePath()?.cid || ''}`; }
function getFavs() {
  try { return new Set(JSON.parse(localStorage.getItem(favKey()) || '[]')); } catch { return new Set(); }
}
function toggleFav(pid) {
  const s = getFavs();
  if (s.has(pid)) s.delete(pid); else s.add(pid);
  try { localStorage.setItem(favKey(), JSON.stringify([...s])); } catch { /* privat läge */ }
  // Stjärnklicket är den naturliga stunden att fråga om notiser — det är ett
  // användargest (krav för prompten) och exakt då man börjar följa någon.
  // Nekat eller stöds inte → stjärnan fungerar precis som förr.
  if (s.has(pid) && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    try { Notification.requestPermission().catch(() => {}); } catch { /* äldre callback-API */ }
  }
  render();
}

// --- Notiser för favoritpatruller -------------------------------------------
// Lokalt, utan server: sidan lyssnar redan live på alla poäng, så när en NY
// avprickning dyker upp för en stjärnmärkt patrull visas en systemnotis.
// Föräldern ska inte behöva sitta och ladda om — telefonen säger till.
//
// Första snapshoten per kontroll seedas TYST: den innehåller alla historiska
// poäng, och att öppna sidan mitt på dagen ska inte ge trettio notiser.
// Anonymitets- och poängreglerna är samma som på sidan: en öppen kontroll
// nämns bara med nummer när anonymousControls är på, och poäng nämns bara
// när de är publicerade.
const settScoreKeys = new Set();   // "ctrlId:patrolId" som redan hanterats
const seedadeCtrls = new Set();    // kontroller vars första snapshot passerat
const målNotifierade = new Set();  // patruller som redan fått mål-notisen
function notiseraFavoriter(ctrlId, rows, franCache = false) {
  // Seeda på första SERVER-snapshoten, inte första snapshoten. Den första
  // kommer ofta ur den lokala cachen och kan vara tom eller förlegad; räknade
  // vi den som seed levererade serverns svar direkt efteråt hela dagens
  // avprickningar som "nya" — en notisstorm i telefonen.
  const seedad = seedadeCtrls.has(ctrlId);
  if (!seedad && !franCache) seedadeCtrls.add(ctrlId);
  const första = !seedad;
  const favs = getFavs();
  const kanNotisa = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  for (const s of rows) {
    const key = `${ctrlId}:${s.patrolId}`;
    if (settScoreKeys.has(key)) continue;
    settScoreKeys.add(key);
    if (första || !kanNotisa || !favs.has(s.patrolId)) continue;
    const patrol = patrols.find(p => p.id === s.patrolId);
    const control = controls.find(c => c.id === ctrlId);
    if (!patrol || !control) continue;
    const anon = comp?.anonymousControls !== false;
    const namn = (anon && control.open) ? `kontroll ${control.nummer ?? '?'}` : (control.name || `kontroll ${control.nummer ?? '?'}`);
    const poäng = scoresPublic() ? ` — ${(Number(s.poang) || 0) + (Number(s.extraPoang) || 0)} poäng` : '';
    showSystemNotification(`${patrol.name || 'Er patrull'} · ${comp?.shortName || 'Tävlingen'}`, {
      body: `Prickade av ${namn}${poäng}`,
      tag: `eskil-fav-${key}`
    });
    // Härledd målsignal: alla kontroller rapporterade.
    if (controls.length > 0 && !målNotifierade.has(s.patrolId)) {
      const klara = controls.filter(c => (scoresByControl[c.id] || []).some(x => x.patrolId === s.patrolId)).length;
      if (klara >= controls.length) {
        målNotifierade.add(s.patrolId);
        showSystemNotification(`${patrol.name || 'Er patrull'} · ${comp?.shortName || 'Tävlingen'}`, {
          body: 'Alla kontroller klara — på väg mot mål!',
          tag: `eskil-fav-mal-${s.patrolId}`
        });
      }
    }
  }
}
function favStar(pid, favs) {
  return `<button type="button" class="fav-star ${favs.has(pid) ? 'is-on' : ''}" data-fav="${escapeHtml(pid)}"
    aria-label="${favs.has(pid) ? 'Ta bort favorit' : 'Markera som favorit'}"
    title="${favs.has(pid) ? 'Ta bort favorit' : 'Följ patrullen — överst i listorna, och en notis när den prickar av en kontroll (om du tillåter notiser)'}">${icon('star', { size: 16 })}</button>`;
}

function render() {
  const parsed = parsePath(); if (!parsed) return;
  // renderAnslag() anropas sist i den här funktionen: render() skriver om
  // hela sidan, inklusive tavlans värdelement.
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

  // Preserve the visitor's position in the scrollable startlista across
  // re-renders (snapshots fire on every score report). null = list is new →
  // auto-scroll so the next upcoming start sits at the top.
  const oldStartsList = document.getElementById('starts-list');
  const savedStartsScroll = oldStartsList ? oldStartsList.scrollTop : null;

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

  // Dela sidan — native share på mobil, kopiera länken annars.
  root.querySelector('#pub-share')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const url = `${location.origin}/t/${cid}`;
    if (navigator.share) {
      try { await navigator.share({ title: comp?.name || 'ESKIL', url }); } catch { /* avbrutet */ }
    } else {
      await copyToClipboard(url);
      toast('Länk kopierad', 'success');
    }
  });

  // Stjärnorna sitter inuti länkar/rader — stoppa klicket från att följa med.
  root.querySelectorAll('[data-fav]').forEach(b => {
    b.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      toggleFav(b.dataset.fav);
    });
  });

  const startsList = document.getElementById('starts-list');
  if (startsList) {
    if (savedStartsScroll != null) {
      startsList.scrollTop = savedStartsScroll;
    } else {
      const next = startsList.querySelector('.start-row:not(.is-past)');
      if (next) {
        const delta = next.getBoundingClientRect().top - startsList.getBoundingClientRect().top;
        startsList.scrollTop = Math.max(0, delta - 6);
      }
    }
  }

  if (tab === 'overview') {
    const newHost = document.getElementById('pub-map');
    if (keepMapEl && newHost) {
      // Swap the freshly-rendered empty host for the live map's node.
      newHost.replaceWith(keepMapEl);
      requestAnimationFrame(() => { try { pubMap?.invalidateSize(); } catch {} });
    } else {
      const withPos = controls.filter(c => c.lat && c.lng);
      const sfPoints = startFinishPoints(comp);
      const places = compPlaces(comp);
      if (withPos.length || sfPoints.length || places.length) renderLeafletMap(withPos, sfPoints, places);
    }
  }

  // Sist: render() skrev om sidan och därmed tavlans värdelement.
  renderAnslag();
  markeraFoljd();
}

// True when the signed-in visitor can open this competition's admin app:
// super-admin (own users-doc), legacy uid admin (public doc), or their e-mail
// is in adminEmails OR userEmails (read-only members see Läget/poäng too) —
// both live in the member-only private/access subdoc (falling back to the
// public doc for un-migrated competitions).
async function checkAdminAccess(user, cid) {
  if (!user || !comp) return false;
  if ((comp.admins || []).includes(user.uid)) return true;
  try {
    const u = await getDoc(doc(db, 'users', user.uid));
    if (u.exists() && u.data().role === 'super-admin') return true;
  } catch { /* not readable → not super-admin */ }
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return false;
  try {
    const a = await getDoc(doc(db, 'competitions', cid, 'private', 'access'));
    if (a.exists()) {
      const d = a.data();
      if ((d.adminEmails || []).includes(email)
        || (d.userEmails || []).includes(email)
        || (d.ekonomiEmails || []).includes(email)) return true;
    }
  } catch { /* denied read = not a member — expected for most visitors */ }
  return (comp.adminEmails || []).includes(email) || (comp.userEmails || []).includes(email);
}

// Kalenderfil (.ics) för tävlingsdagen — heldagshändelse, ren data-URL.
function calendarIcsUrl() {
  const d = String(comp.date || '').replaceAll('-', '');
  if (!d) return '#';
  const next = new Date(comp.date); next.setDate(next.getDate() + 1);
  const dtEnd = next.toISOString().slice(0, 10).replaceAll('-', '');
  const esc = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ESKIL//SV',
    'BEGIN:VEVENT',
    `UID:eskil-${comp.id || parsePath()?.cid || ''}@eskilscout.se`,
    `DTSTART;VALUE=DATE:${d}`,
    `DTEND;VALUE=DATE:${dtEnd}`,
    `SUMMARY:${esc(comp.name)}`,
    comp.location ? `LOCATION:${esc(comp.location)}` : '',
    `DESCRIPTION:${esc('Startlista och resultat: ' + location.origin + '/t/' + (parsePath()?.cid || ''))}`,
    'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
  return 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);
}

function renderHero() {
  const openCount = controls.filter(c => c.open).length;
  const reg = registrationState(comp);
  const regSettings = registrationSettings(comp);
  const cid = parsePath()?.cid;
  return `
    <header class="pub-hero">
      <div class="pub-hero-pattern"></div>
      <img class="pub-hero-symbol" src="/assets/eskil_design_library/svg/eskil-symbol-inverted.svg" alt="" aria-hidden="true">
      <div class="page">
        <div class="pub-hero-top">
          <a class="pub-brand" href="/" aria-label="Till ESKIL:s startsida">
            <img class="pub-logo" src="/assets/eskil_design_library/svg/eskil-logo-inverted.svg" alt="ESKIL — Där spåret börjar">
          </a>
          <div class="pub-hero-actions">
            ${adminAccess ? `<a class="btn btn-secondary btn-sm" href="/app/c/${encodeURIComponent(realCid || cid || '')}">${icon('settings', { size: 14 })} Administrera</a>` : ''}
            ${openCount > 0 ? `<div class="status-pill"><span class="dot-live"></span>Tävlingen pågår · live</div>` : ''}
          </div>
        </div>
        <div class="pub-hero-grid">
        <div class="pub-hero-huvud">
        <div class="t-over" style="color:var(--rover-yellow);">${escapeHtml(comp.shortName || '')} · ${comp.year || ''}</div>
        <h1>${escapeHtml(comp.name || '')}</h1>
        ${comp.description ? `<p class="lede">${escapeHtml(comp.description)}</p>` : ''}
        <div class="meta">
          ${comp.date ? `<span><b>${escapeHtml(formatDate(comp.date))}</b> · datum</span>` : ''}
          ${comp.location ? `<span><b>${escapeHtml(comp.location)}</b> · plats</span>` : ''}
          ${comp.organizer ? `<span><b>${escapeHtml(comp.organizer)}</b> · arrangör</span>` : ''}
        </div>
        <div class="pub-hero-links">
          ${comp.date ? `<a href="${calendarIcsUrl()}" download="${escapeHtml((comp.shortName || 'tavling').toLowerCase())}-${comp.year || ''}.ics">${icon('clock', { size: 13 })} Lägg i kalendern</a>` : ''}
          <a href="#" id="pub-share">${icon('external', { size: 13 })} Dela sidan</a>
          ${comp.copiedFrom ? `<a href="/t/${escapeHtml(comp.copiedFrom)}" target="_blank" rel="noopener">Föregående årgång →</a>` : ''}
        </div>
        ${reg === 'open' ? `
          <a class="hero-cta" href="/a/${escapeHtml(cid || '')}">Anmäl er nu${regSettings.closesAt ? ` — öppet t.o.m. ${escapeHtml(formatDate(regSettings.closesAt))}` : ''} →</a>
        ` : ''}
        </div>
        <div id="anslagstavla" class="anslag-kol"></div>
        </div>
      </div>
    </header>
  `;
}

// Anslagstavlan. Egen renderare så ett nytt anslag inte bygger om hela sidan
// — kartan och listorna ska stå still. Fritexten går genom linkifyText: en
// länk till t.ex. en ny samlingsplats ska gå att trycka på.
// Vilka anslag som redan fällts in. Renderaren körs om vid varje snapshot, och
// utan den här mängden skulle hela stacken glida in på nytt var gång någon
// rapporterar en poäng — rörelse utan innebörd, mitt framför den som läser.
const anslagAnimerade = new Set();
// Signaturen bor PÅ elementet, inte i en modulvariabel. Firestore levererar
// först ur den lokala cachen och sedan från servern, så renderaren kallas två
// gånger inom millisekunder — utan vakten byggdes DOM:en om mitt i
// infällningen och rörelsen kapades. Men renderHero() river och bygger om
// #anslagstavla, och med signaturen i en modulvariabel mötte ett FÄRSKT tomt
// element en oförändrad signatur: tavlan blev tyst tom. Sitter märket på
// elementet försvinner det med elementet, som sig bör.

function renderAnslag() {
  const host = document.getElementById('anslagstavla');
  if (!host) return;
  if (!anslagSynlig(comp, anslag)) { host.innerHTML = ''; host.hidden = true; delete host.dataset.sig; return; }
  const signatur = JSON.stringify(anslag.map(a => [a.id, a.level, a.text, String(a.at || '')]));
  if (host.dataset.sig === signatur) return;
  host.dataset.sig = signatur;
  host.hidden = false;
  if (!anslag.length) {
    // Tomt läge är ett BESKED, inte frånvaro av information: "vi har inget att
    // säga" är precis vad en förälder vill veta. Men det ska vara diskret.
    host.innerHTML = `<p class="anslag-lugn">${icon('check', { size: 15 })}
      <span>Allt lugnt — tävlingsledningen har inget att meddela.</span></p>`;
    return;
  }
  const ETIKETT = { kritisk: 'Viktigt', varning: 'Observera', info: 'Information' };
  // Fäll BARA in när dokumentet är synligt. Animationen börjar på opacitet 0
  // med fill-mode both, och webbläsaren fryser animationstidslinjen i en dold
  // flik: öppnar någon /t i en bakgrundsflik skulle anslagen fastna osynliga
  // och aldrig visa sig. Samma vakt som animeraIn() i app.js — vilotillståndet
  // måste alltid vara synligt.
  const fallIn = !document.hidden;
  host.innerHTML = `
    <h2 class="anslag-rubrik">${icon('info', { size: 15 })} Från tävlingsledningen</h2>
    <div class="anslag-stack">
      ${anslag.map((a, i) => `
        <article class="anslag-item anslag-${escapeHtml(a.level)}${(fallIn && !anslagAnimerade.has(a.id)) ? ' anslag-ny' : ''}"
                 role="status" style="--fall: ${i * 70}ms;">
          <div class="anslag-huvud">
            <span class="anslag-niva">${escapeHtml(ETIKETT[a.level] || 'Information')}</span>
            ${a.at ? `<span class="anslag-tid">${escapeHtml(klockslag(a.at))}</span>` : ''}
          </div>
          <div class="anslag-text">${linkifyText(a.text)}</div>
        </article>`).join('')}
    </div>`;
  // Markera som infällda FÖRST när ritningen visat sig överleva. /t bygger om
  // hela sidan vid varje poängsnapshot, och en markering direkt satte id:na
  // på ett element som revs en millisekund senare — då spelade infällningen
  // aldrig. Överlever elementet en halv sekund var det en riktig ritning.
  const stack = host.querySelector('.anslag-stack');
  setTimeout(() => {
    if (stack?.isConnected) anslag.forEach(a => anslagAnimerade.add(a.id));
  }, 600);
}

function klockslag(at) {
  const d = at?.toDate ? at.toDate() : new Date(at);
  return Number.isFinite(d?.getTime?.()) ? d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }) : '';
}

function renderFooter() {
  return `
    <footer class="pub-foot">
      <div class="page">
        <div style="display:flex;align-items:center;gap:var(--sp-4);">
          <img class="pub-logo" src="/assets/eskil_design_library/svg/eskil-logo-inverted.svg" alt="ESKIL — Där spåret börjar">
          ${comp?.year ? `<span>· ${comp.year}</span>` : ''}
        </div>
        <span class="muted">${scoresPublic()
          ? 'Poängtabellen uppdateras direkt när kontrollanter rapporterar.'
          : 'Poängen publiceras av tävlingsledningen — tills dess visas bara genomförda kontroller.'}
          · <a href="/" style="color:#a7bccf;">Fler tävlingar på ESKIL</a>
          · <a href="/integritet" style="color:#a7bccf;">Integritet &amp; GDPR</a></span>
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

// The full start list — every patrol with a start time, past and upcoming,
// so visitors can scroll back through who has started and ahead through
// everyone still to come. Only meaningful on the competition day (start
// times are wall-clock anchored), or on demo competitions where the
// schedule rolls with the clock.
function startRows(now = new Date()) {
  const s = startTimeSettings(comp);
  if (!s.enabled || !patrols.length) return [];
  if (!comp.demo && comp.date && daysUntilComp() !== 0) return [];
  return patrols
    .map(p => ({ p, dt: patrolStartDateTime(comp, p, now, patrols.length) }))
    .filter(x => x.dt)
    .sort((a, b) => a.dt - b.dt);
}

// Under 10 min the countdown runs with seconds (startskärm feel); at/after
// the start moment it flips to GÅR NU until the row rotates out.
function countdownText(dt, now = new Date()) {
  const ms = dt - now;
  if (ms <= 0) return 'GÅR NU';
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 600) {
    const m = Math.floor(totalSec / 60), s = totalSec % 60;
    return `om ${m}:${String(s).padStart(2, '0')}`;
  }
  const min = Math.round(totalSec / 60);
  if (min < 60) return `om ${min} min`;
  return `om ${Math.floor(min / 60)} h ${min % 60} min`;
}

// The live start list: a scrollable window over ALL starts — already-started
// patrols dimmed with "startade", the rest counting down (seconds under
// 10 min, GÅR NU at the moment). The 1 s tick patches clock, countdowns and
// row states in place; rows are only rebuilt when data actually changes, and
// render() preserves the visitor's scroll position.
function renderStartList() {
  const cid = parsePath()?.cid;
  const now = new Date();
  const favs = getFavs();
  // Favoriter överst (i starttidsordning inom gruppen), resten efter.
  const rows = [...startRows(now)].sort((a, b) =>
    (favs.has(b.p.id) - favs.has(a.p.id)) || (a.dt - b.dt));
  if (!rows.length) return '';

  // Beräknad målgång för anhöriga — kalibrerad: verkliga mellantider ur
  // poängdatan (inkl. köer på kontrollerna) ersätter modellantagandet, och
  // varje patrulls estimat ankras i dess senaste rapporterade kontroll.
  // Visas bara när banan är publik, och alltid med "ca".
  let eta = null;
  try {
    if (controlsPublic()) {
      const scores = Object.entries(scoresByControl).flatMap(([ctrlId, list]) =>
        (list || []).map(s => ({ ...s, controlId: ctrlId, patrolId: s.patrolId || s.id })));
      const e = courseEtaCalibrated(comp, controls, track, scores, patrols, now);
      if (e.finishMin != null && e.totalDist > 0) eta = e;
    }
  } catch { /* estimatet är en bonus */ }
  // Returnerar hela suffixtexten. Tillstånden måste kunna UPPLÖSAS — /t kan
  // inte läsa målpassager, så: alla kontroller rapporterade → "i mål";
  // estimatet nyss passerat → "väntas i mål"; passerat sedan länge (>90 min)
  // → tomt (raden faller tillbaka till neutralt "startade") så kvällens
  // lista inte fastnar i ett evigt "väntas". Utgångna märks direkt.
  const finText = (p, dt) => {
    if (p.utgatt) return 'utgått';
    if (!eta) return '';
    const reports = {};
    for (const [ctrlId, list] of Object.entries(scoresByControl)) {
      const s = (list || []).find(x => (x.patrolId || x.id) === p.id);
      const t = s?.clientReportedAt ?? s?.reportedAt;
      if (t) reports[ctrlId] = t;
    }
    if (controls.length > 0 && Object.keys(reports).length >= controls.length) return 'i mål';
    const ms = patrolFinishEtaMs(eta, reports, dt.getTime());
    if (ms == null) return '';
    const late = now.getTime() - ms;
    if (late > 90 * 60000) return '';
    if (late > 60000) return 'väntas i mål';
    return `i mål ca ${new Date(ms).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}`;
  };

  return `
    <div class="pub-section-head">
      <h2 class="t-h2">Startlista</h2>
      <span class="muted">Live · klicka för startkort · <span class="mono" id="pub-clock">${now.toLocaleTimeString('sv-SE')}</span></span>
    </div>
    <div class="starts-list" id="starts-list">
      ${rows.map(({ p, dt }) => {
        const past = dt - now <= -60000;
        const fin = finText(p, dt);
        const cd = past ? (fin || 'startade') : countdownText(dt, now);
        return `
          <a class="start-row ${past ? 'is-past' : ''} ${cd === 'GÅR NU' ? 'is-now' : ''} ${favs.has(p.id) ? 'is-fav' : ''}" href="/s/${escapeHtml(cid || '')}/${escapeHtml(p.id)}" target="_blank" rel="noopener">
            ${favStar(p.id, favs)}
            <span class="st-time">${dt.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}</span>
            <span class="st-who">
              <span class="nm">#${p.number ?? '—'} ${escapeHtml(p.name || '')}</span>
              <span class="sub"><span class="dot ${avdSlug(p.avdelning)}"></span>${escapeHtml(p.avdelning || '')}${p.kar ? ' · ' + escapeHtml(p.kar) : ''}</span>
            </span>
            <span class="st-count" data-dt="${dt.toISOString()}"${fin ? ` data-fin="${escapeHtml(fin)}"` : ''}>${escapeHtml(cd)}</span>
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

    ${renderStartList()}

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
    <div class="grid" style="grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:var(--sp-4);margin-bottom:var(--sp-8);align-items:stretch;">
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
  const places = compPlaces(comp);
  if (!withPos.length && !sf.length && !places.length) return '';
  // Notes for the special points (start, finish, places). Only render the
  // section if at least one of them has a non-empty note.
  const notedPoints = [...sf, ...places.map(p => ({ ...p, title: placeKind(p.kind).label }))]
    .filter(p => p && (p.note || '').trim());
  const notesBlock = notedPoints.length ? `
    <div class="map-notes">
      ${notedPoints.map(p => `
        <div class="map-note">
          <div class="map-note-head">
            <span class="badge ${p.colorHex ? 'badge-blue' : 'badge-orange'}">${escapeHtml(p.title)}</span>
            ${p.name ? `<strong>${escapeHtml(p.name)}</strong>` : ''}
          </div>
          <p>${escapeHtml(p.note)}</p>
        </div>
      `).join('')}
    </div>
  ` : '';

  return `
    <div class="pub-section-head"><h2 class="t-h2">Karta</h2><span class="muted">${controlsPublic()
      ? `${withPos.length} kontroller${sf.length ? ' · start/mål' : ''}${places.length ? ` · ${places.length} plats${places.length === 1 ? '' : 'er'}` : ''}`
      : `tävlingsområde${sf.length ? ' · start/mål' : ''}${places.length ? ` · ${places.length} plats${places.length === 1 ? '' : 'er'}` : ''}`}</span></div>
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
    // Favoriter överst — placeringssiffran (rank) följer med raden, så
    // tabellen ljuger aldrig om läget.
    const favs = getFavs();
    rows = [...rows].sort((a, b) => (favs.has(b.id) - favs.has(a.id)) || (a.rank - b.rank));
    body = rows.length ? `
      <div class="lb"><table>
        <thead><tr><th class="rank">#</th><th>Patrull</th><th>Kår</th><th class="num">Kontr.</th><th class="num">Max</th><th class="num">Extra</th><th class="num">Total</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr class="${r.rank<=3?'top'+r.rank:''} is-clickable ${favs.has(r.id) ? 'is-fav' : ''}" data-patrol="${escapeHtml(r.id)}">
            <td class="rank">${r.rank === 1 ? icon('trophy', { size: 16 }) + ' ' : ''}${r.rank}</td>
            <td>
              <span class="pname">${favStar(r.id, favs)}${escapeHtml(r.name || '')}</span>
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
    ${renderUtslagPanel(totals)}
  `;
}

// Tiebreaker reveal — shown only once the facit is set (and scores are
// public): the question, the correct answer and everyone's guesses sorted by
// closeness, so patrols can see how the shared places were separated.
function renderUtslagPanel(totals) {
  const uc = controls
    .filter(c => c.utslag && isNumSet(c.utslagSvar))
    .sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
  if (!uc.length) return '';
  const perControlOf = Object.fromEntries(totals.map(t => [t.id, t.perControl || {}]));
  return uc.map(c => {
    const per = {};
    patrols.forEach(p => { const s = perControlOf[p.id]?.[c.id]; if (s) per[p.id] = s; });
    const rows = utslagRows(c, patrols, per);
    return `
      <div class="pub-section-head" style="margin-top:var(--sp-8);">
        <h2 class="t-h2">Utslagsfrågan</h2>
        <span class="muted">Kontroll ${c.nummer ?? '?'} · ${escapeHtml(c.name || '')}</span>
      </div>
      <div class="lb">
        ${c.utslagFraga ? `<p style="margin:14px 16px 4px;font-family:var(--font-serif, Georgia, serif);font-size:18px;">"${escapeHtml(c.utslagFraga)}"</p>` : ''}
        <p style="margin:6px 16px 10px;">Rätt svar: <strong style="font-size:20px;color:var(--scout-blue);">${Number(c.utslagSvar)}</strong></p>
        <table>
          <thead><tr><th class="rank">#</th><th>Patrull</th><th class="num">Svar</th><th class="num">Från facit</th></tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td class="rank">${r.patrol.number ?? ''}</td>
              <td><span class="pname">${escapeHtml(r.patrol.name || '')}</span> <span class="pkar">${escapeHtml(r.patrol.kar || '')}</span></td>
              <td class="num">${r.gissning != null ? r.gissning : '—'}</td>
              <td class="num">${r.diff != null ? (r.diff === 0 ? `${icon('target', { size: 13 })} Rätt!` : '±' + r.diff) : '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
  }).join('');
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

  // Senast sedd: när den senaste avprickningen faktiskt skedde. För den som
  // följer hemifrån är ett tyst glapp lätt att läsa som fara — tidsstämpeln
  // gör tystnaden till information ("de sågs vid kontroll 5 för 20 minuter
  // sedan"). Passagetid är clientReportedAt, INTE reportedAt: en offline-
  // batchsynk kan annars påstå att patrullen sågs för en minut sedan fast
  // trycket skedde för en timme sedan.
  const tsMs = (v) => {
    if (!v) return null;
    const d = typeof v.toDate === 'function' ? v.toDate() : new Date(v);
    const t = d.getTime();
    return Number.isFinite(t) ? t : null;
  };
  let senast = null;
  for (const { control, score } of perCtrl) {
    if (!score) continue;
    const t = tsMs(score.clientReportedAt) ?? tsMs(score.reportedAt);
    if (t != null && (!senast || t > senast.t)) senast = { t, control };
  }
  const senastText = (() => {
    if (!senast) return '';
    const kl = new Date(senast.t).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    const min = Math.round((Date.now() - senast.t) / 60000);
    const sedan = min < 1 ? 'nyss' : min < 60 ? `för ${min} min sedan` : `för ${Math.floor(min / 60)} h ${min % 60} min sedan`;
    return `Senast sedd vid ${controlName(senast.control)} · ${kl} (${sedan})`;
  })();

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
          <div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;">
            <a class="t-sm" style="display:inline-flex;align-items:center;gap:5px;color:var(--scout-blue);font-weight:600;" href="/s/${escapeHtml(parsePath()?.cid || '')}/${escapeHtml(patrol.id)}" target="_blank" rel="noopener">${icon('external', { size: 14 })} Öppna patrullens startkort</a>
            <button type="button" class="t-sm" id="pub-folj-lank" style="display:inline-flex;align-items:center;gap:5px;color:var(--scout-blue);font-weight:600;background:none;border:0;padding:0;cursor:pointer;font-family:inherit;">${icon('copy', { size: 14 })} Kopiera följ-länk</button>
            <button type="button" class="t-sm" id="pub-kalender" style="display:inline-flex;align-items:center;gap:5px;color:var(--scout-blue);font-weight:600;background:none;border:0;padding:0;cursor:pointer;font-family:inherit;">${icon('clock', { size: 14 })} Påminn mig före mål</button>
          </div>
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

      ${senastText ? `<div class="pub-senast">${icon('clock', { size: 14 })} ${escapeHtml(senastText)}</div>` : ''}

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
                <!-- Kontrollantens notering visas MEDVETET inte här. Den är
                     sekretariatets fält (kontrollens detaljvy i admin) och låg
                     dessutom utanför publicScores-grinden: den publicerades
                     alltså även när poängen var opublicerade. Med
                     standardiserade snabbnoteringar hade "Regelbrott" hamnat
                     bredvid patrullnamn och kår för vem som helst att läsa. -->
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
  // Följ-länk att skicka vidare. Bygger på tävlingens PUBLIKA adress och
  // patrull-id:t — aldrig startkortets hemliga länk, som ligger precis ovanför
  // i samma modal och är lätt att förväxla.
  overlay.querySelector('#pub-folj-lank')?.addEventListener('click', (e) => {
    const bas = `${location.origin}/t/${comp?.slug || parsePath()?.cid || ''}`;
    copyToClipboard(`${bas}?folj=${encodeURIComponent(patrol.id)}`);
    e.currentTarget.innerHTML = `${icon('check', { size: 14 })} Länk kopierad`;
  });

  // Kalenderpåminnelse. Notisen kräver att sidan är öppen och att man tillåtit
  // notiser; en kalenderpost ringer utan täckning och överlever att fliken
  // stängs. Tiden kommer ur SAMMA ETA-motor som resten av sidan.
  overlay.querySelector('#pub-kalender')?.addEventListener('click', () => {
    // patrolLabel används medvetet INTE här: enligt CLAUDE.md hör den inte
    // hemma på /t, där kåren redan står på egen rad. I kalenderposten bär
    // rubriken patrullnamnet och beskrivningen kåren — en kalenderpost läses
    // utanför sitt sammanhang, så kåren behövs, men inte i rubriken.
    const namn = patrol.name || 'Patrullen';
    const dt = patrolStartDateTime(comp, patrol);
    const reports = {};
    for (const { control, score } of perCtrl) {
      const t = score && (tsMs(score.clientReportedAt) ?? tsMs(score.reportedAt));
      if (t) reports[control.id] = new Date(t);
    }
    // courseEtaCalibrated vill ha en PLATT lista, inte objektet per kontroll —
    // samma platt-tryckning som startlistans ETA-rad gör.
    const platta = Object.entries(scoresByControl).flatMap(([ctrlId, list]) =>
      (list || []).map(x => ({ ...x, controlId: ctrlId, patrolId: x.patrolId || x.id })));
    const eta = courseEtaCalibrated(comp, controls, track, platta, patrols);
    const ms = dt ? patrolFinishEtaMs(eta, reports, dt.getTime()) : null;
    if (!ms) {
      alert('Ingen beräknad måltid än — den dyker upp när patrullen startat och passerat sin första kontroll.');
      return;
    }
    const ics = buildIcs({
      uid: `eskil-${parsePath()?.cid || ''}-${patrol.id}@eskilscout.se`,
      title: `${namn} väntas i mål`,
      description: `Beräknad målgång för ${namn}${patrol.kar ? ` (${patrol.kar})` : ''} i ${comp?.name || 'tävlingen'}. `
        + 'Tiden är ett estimat ur tävlingens ETA och kan ändras under dagen.',
      location: comp?.location || '',
      url: `${location.origin}/t/${comp?.slug || parsePath()?.cid || ''}`,
      start: new Date(ms),
      alarmMinutes: 30
    });
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(patrol.name || 'patrull').toLowerCase().replace(/[^a-z0-9åäö]+/gi, '-')}-mal.ics`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  overlay.querySelector('#pub-modal-close').onclick = close;
  document.addEventListener('keydown', onKey);
}

function renderNotFound(msg) {
  root.innerHTML = `
    <header class="pub-hero">
      <div class="pub-hero-pattern"></div>
      <div class="page">
        <a class="pub-brand" href="/" aria-label="Till ESKIL:s startsida">
          <img class="pub-logo" src="/assets/eskil_design_library/svg/eskil-logo-inverted.svg" alt="ESKIL — Där spåret börjar">
        </a>
        <h1>Tävlingen hittades inte</h1>
        <p class="lede">${escapeHtml(msg)}</p>
        <p style="margin-top:var(--sp-6);">
          <a class="btn btn-secondary" href="/">Till ESKIL:s startsida — alla tävlingar</a>
        </p>
      </div>
    </header>
  `;
}

boot();
