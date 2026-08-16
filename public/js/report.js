// Control reporting page logic. No auth — security-by-obscurity via long
// Firestore document IDs. Subscribes to patrols + scores and lets anyone
// with the URL report (if the control is open).

import { db, doc, onSnapshot } from './firebase.js';
import { getCompetition, getControl, listPatrols, watchScoresForControl, upsertScore, deleteScore, listControls, getTrack, listAllScoresForEta, rensaEtaCache, sendControlBeacon } from './store.js';
import { AVDELNINGAR, escapeHtml, allInstructionGroups, internalManagement, parseFieldPath,
  NOTE_CHIPS, harNotering, laggTillNotering, taBortNotering, kapaNotering,
  sparlagesBeslut } from './utils.js';
import { controlEtaWindow } from './course.js';
import { ensureLeaflet } from './leaflet.js';
import { icon } from './icons.js';
import { haptic, bindHaptic, bindTap } from './haptic.js';
import { updateBroadcast } from './broadcast.js';
import { mountMessages } from './chat.js';
import { openSheet, sheetNotice } from './sheet.js';
import { enqueue, removeFromQueue, listQueue, isPending, flushQueue, withTimeout, isPermanentError } from './offline-queue.js';

const root = document.getElementById('root');
const modeBtn = document.getElementById('mode-toggle');
const modeIcon = document.getElementById('mode-icon');
const modeLbl = document.getElementById('mode-label');

function applyMode(mode) {
  document.documentElement.setAttribute('data-mode', mode);
  try { localStorage.setItem('eskil:mode', mode); } catch {}
  if (mode === 'night') {
    modeIcon.innerHTML = icon('moon', { size: 16 });
    modeLbl.textContent = 'Dagläge';
  } else {
    modeIcon.innerHTML = icon('sun', { size: 16 });
    modeLbl.textContent = 'Nattläge';
  }
}
applyMode(document.documentElement.getAttribute('data-mode') || 'light');
bindHaptic(modeBtn);

// Dubbeltapp-zoomen är den OAVSIKTLIGA zoomen — två snabba tryck på +/-
// ska ge två poängsteg, inte en inzoomad sida. Den blockeras. NYP-zoomen är
// däremot den avsiktliga: en ledare med nedsatt syn förstorar kontrollnamn
// och siffror med den (WCAG 1.4.4), så den får INTE blockeras — de gamla
// gesture*/touchmove-blockarna som svalde nypet är borttagna tillsammans med
// user-scalable=no i viewporten. Stegknapparna skyddas redan per element av
// bindTap (touchstart + preventDefault).
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
modeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-mode') || 'light';
  applyMode(cur === 'night' ? 'light' : 'night');
});

function reporterId() {
  let id = localStorage.getItem('eskil:reporter');
  if (!id) {
    id = 'r_' + Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem('eskil:reporter', id); } catch {}
  }
  return id;
}

// Informationsknappen i fältheadern öppnar kontrollens blad: instruktioner,
// karta med "hitta mig", placering, allmän information och tävlingsledningen.
//
// Tidigare snurrade hela kortet runt. Bottensheeten gör samma innehåll
// tillgängligt på samma sätt som allt annat som poppar upp här, och — det som
// avgjorde saken på mobil — den tar inte plats ovanför patrullistan när den
// är stängd.
//
// renderHead() bygger om headern varje gång kontrollen öppnas/stängs, så allt
// som lever längre än en rendering (kartan, GPS-vakten) ligger på modulnivå
// och städas innan det kopplas om.
let chatPanel = null;        // samtalspanelen mot tävlingsledningen
let flipMap = null;          // active Leaflet instance (or null)
let flipStopLocate = null;   // stops the geolocation watch of that instance
let infoSheet = null;        // öppet informationsblad, om något

function wireInfoButton(control, groups, generalInfo, mgmt, harInnehåll) {
  const btn = document.getElementById('info-btn');
  if (!btn) return;
  btn.hidden = !harInnehåll;
  btn.innerHTML = icon('info', { size: 20 });
  if (!harInnehåll || btn.dataset.wired) return;
  btn.dataset.wired = '1';

  btn.addEventListener('click', () => {
    if (infoSheet) { infoSheet.close(); return; }
    infoSheet = openSheet({
      eyebrow: `Kontroll ${control.nummer ?? ''}`,
      title: control.name || 'Kontrollen',
      className: 'sheet-info',
      body: `
        ${groups.length ? `
          <h3>Instruktioner</h3>
          ${groups.map(g => `
            <div class="flip-inst-group">
              <span class="tag">${(g.avdelningar || []).length ? escapeHtml(g.avdelningar.join(' · ')) : 'Default (alla andra)'}</span>
              <p>${escapeHtml(g.text)}</p>
            </div>`).join('')}` : ''}
        ${control.placement ? `
          <h3>Placering</h3>
          <div class="flip-placement">
            <p>${escapeHtml(control.placement)}</p>
          </div>` : ''}
        ${(control.lat && control.lng) ? `
          <h3>Karta</h3>
          <div class="flip-coords" aria-label="Koordinater">
            <span class="flip-coords-label">Koordinater (vid nödsituation)</span>
            <span class="flip-coords-value">${control.lat.toFixed(5)}, ${control.lng.toFixed(5)}</span>
          </div>
          <div class="flip-map" id="flip-map"></div>` : ''}
        ${generalInfo ? `
          <h3>Allmän information</h3>
          <div class="flip-placement"><p>${escapeHtml(generalInfo)}</p></div>` : ''}
        ${mgmt.length ? `
          <h3>Tävlingsledning</h3>
          <div class="flip-mgmt">
            ${mgmt.map(r => `
              <div class="flip-mgmt-row">
                <div class="flip-mgmt-label">${escapeHtml(r.label)}</div>
                ${r.name ? `<div class="flip-mgmt-name">${escapeHtml(r.name)}</div>` : ''}
                ${r.phone ? `<a class="flip-mgmt-contact" href="tel:${escapeHtml(r.phone)}">${icon('phone', { size: 16 })} ${escapeHtml(r.phone)}</a>` : ''}
                ${r.email ? `<a class="flip-mgmt-contact" href="mailto:${escapeHtml(r.email)}">${icon('mail', { size: 16 })} ${escapeHtml(r.email)}</a>` : ''}
              </div>`).join('')}
          </div>` : ''}`,
      onClose: () => {
        infoSheet = null;
        // Kartan följer med bladet ut — annars ligger en GPS-vakt kvar och
        // tuggar batteri i en kontrollant­telefon resten av dagen.
        flipStopLocate?.(); flipStopLocate = null;
        if (flipMap) { try { flipMap.remove(); } catch {} flipMap = null; }
      }
    });
    // Kartan ritas när bladet glidit klart — Leaflet mäter sin container vid
    // skapandet, och mitt i animationen är den inte på plats än.
    if (control.lat && control.lng) {
      setTimeout(() => loadFlipMap(control.lat, control.lng), 220);
    }
  });
}

async function loadFlipMap(lat, lng) {
  const host = document.getElementById('flip-map');
  if (!host) return;
  // Dispose the previous instance (renderHead replaced its DOM): stops any
  // running GPS watch and detaches Leaflet's own window listeners.
  flipStopLocate?.();
  flipStopLocate = null;
  if (flipMap) { try { flipMap.remove(); } catch {} flipMap = null; }
  try {
    const L = await ensureLeaflet();
    // The card may have been rebuilt again while Leaflet loaded.
    if (!host.isConnected) return;
    const map = L.map(host, { zoomControl: true, scrollWheelZoom: false, dragging: true }).setView([lat, lng], 16);
    flipMap = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OSM'
    }).addTo(map);
    L.circleMarker([lat, lng], {
      radius: 12, color: '#ffffff', weight: 3, fillColor: '#E95F13', fillOpacity: 0.95
    }).addTo(map);

    // --- "Find me" control — a Leaflet custom button + a distance chip ---
    let userMarker = null, userLine = null, watchId = null;
    const distChip = document.createElement('div');
    distChip.className = 'flip-dist-chip';
    distChip.hidden = true;
    host.parentElement.insertBefore(distChip, host);

    const setBtnState = (btn, on) => {
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.innerHTML = on ? icon('x', { size: 18 }) : icon('locate', { size: 18 });
      btn.title = on ? 'Sluta följa min plats' : 'Visa min plats';
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

    function stopLocate(btn) {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      if (userMarker) { try { map.removeLayer(userMarker); } catch {} userMarker = null; }
      if (userLine) { try { map.removeLayer(userLine); } catch {} userLine = null; }
      distChip.hidden = true;
      if (btn) setBtnState(btn, false);
    }
    // Let the next loadFlipMap (after a head rebuild) stop this watch.
    flipStopLocate = () => stopLocate(null);

    function toggleLocate(btn) {
      if (!navigator.geolocation) { rtoast('Platstjänster stöds inte', 'err'); return; }
      if (watchId != null) { stopLocate(btn); return; }
      setBtnState(btn, true);
      let firstFix = true;
      watchId = navigator.geolocation.watchPosition((pos) => {
        const { latitude: ulat, longitude: ulng, accuracy } = pos.coords;
        if (!userMarker) {
          userMarker = L.circleMarker([ulat, ulng], {
            radius: 9, color: '#ffffff', weight: 3, fillColor: '#00A8E1', fillOpacity: 0.95,
            className: 'user-pulse'
          }).addTo(map);
          userLine = L.polyline([[ulat, ulng], [lat, lng]], {
            color: '#00A8E1', weight: 3, dashArray: '6 8', opacity: 0.85
          }).addTo(map);
        } else {
          userMarker.setLatLng([ulat, ulng]);
          userLine.setLatLngs([[ulat, ulng], [lat, lng]]);
        }
        if (firstFix) {
          firstFix = false;
          map.fitBounds(L.latLngBounds([[ulat, ulng], [lat, lng]]).pad(0.4));
        }
        const m = haversineMeters([ulat, ulng], [lat, lng]);
        distChip.hidden = false;
        distChip.innerHTML = `<span class="flip-dist-label">Avstånd</span><span class="flip-dist-val">${formatDistance(m)}</span>${accuracy ? `<span class="flip-dist-acc">±${Math.round(accuracy)} m</span>` : ''}`;
      }, (err) => {
        rtoast('Kunde inte hämta plats: ' + err.message, 'err');
        stopLocate(btn);
      }, { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 });
    }

    setTimeout(() => map.invalidateSize(), 700);
  } catch (e) {
    host.innerHTML = `<div class="r-empty">Kartan kunde inte laddas.</div>`;
  }
}

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

function parsePath() {
  // /k/:cid/:ctrlId[/:token] — token är FRIVILLIG med flit. Tryckta QR-koder
  // är från före den, och de måste fortsätta rapportera poäng och nå
  // ledningen. Token styr bara om SVAREN går att läsa (se chat.js).
  const p = parseFieldPath(location.pathname, 'k');
  return p ? { cid: p.cid, ctrlId: p.id, token: p.token } : null;
}

function rtoast(msg, kind) {
  // Ett öppet blad täcker sidan — en toast i nederkanten hamnar bakom det.
  // Då stod svaret på varför Spara inte gick där ingen såg det.
  if (sheetNotice(msg, kind === 'err' ? 'err' : 'ok')) return;
  const el = document.createElement('div');
  el.className = 'r-toast' + (kind === 'err' ? ' err' : '');
  // assertive för fel: "kontrollen är stängd" måste bryta igenom, annars
  // sparar kontrollanten vidare i tron att det gick.
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.setAttribute('aria-live', kind === 'err' ? 'assertive' : 'polite');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; }, 2400);
  setTimeout(() => el.remove(), 2800);
}

async function main() {
  const parsed = parsePath();
  if (!parsed) {
    root.innerHTML = `<div class="r-empty">Ogiltig länk.</div>`;
    return;
  }
  const { cid, ctrlId } = parsed;
  // Samtalstoken ur länkens fjärde segment. Saknas den kan sidan skicka men
  // inte läsa svaren — se mountMessages.
  const samtalsToken = parsed.token;

  let comp, control, patrols = [], scores = [];
  try {
    [comp, control, patrols] = await Promise.all([
      getCompetition(cid),
      getControl(cid, ctrlId),
      listPatrols(cid)
    ]);
  } catch (e) {
    console.error(e);
    root.innerHTML = `<div class="r-empty">Kunde inte läsa kontrollen: ${escapeHtml(e.message)}</div>`;
    return;
  }

  if (!control) {
    root.innerHTML = `<div class="r-empty">Kontrollen hittades inte.</div>`;
    return;
  }
  document.title = `${control.nummer ?? ''}. ${control.name || 'Kontroll'} · ${comp?.shortName || ''} — ESKIL`;

  // --- Live competition doc — driftmeddelanden (broadcast) från ledningen ---
  const bctx = { audience: 'kontroll', id: ctrlId };
  onSnapshot(doc(db, 'competitions', cid), snap => {
    if (!snap.exists()) return;
    comp = { id: cid, ...snap.data() };
    updateBroadcast(comp, bctx);
  });
  updateBroadcast(comp, bctx);

  // --- Live control doc (to react to open/closed changes) ---
  onSnapshot(doc(db, 'competitions', cid, 'controls', ctrlId), snap => {
    if (!snap.exists()) return;
    const next = snap.data();
    if (next.open !== control.open) {
      control = { ...control, ...next };
      renderHead();
    } else {
      control = { ...control, ...next };
    }
  });

  // --- Live scores for this control ---
  watchScoresForControl(cid, ctrlId, (rows) => {
    scores = rows;
    renderAvdelningar();
    renderPatrols();
  });

  // --- UI State ---
  const state = {
    avd: null, // selected avdelning filter
    sok: ''    // fritext-filter över patrullrutnätet
  };

  // --- ETA: "Patruller väntas ca X–Y" ---
  // Gångtid längs spåret (eller fågelvägen) + stationstid per kontroll före
  // denna, adderat på första/sista patrullens starttid. Bäst-effort i
  // bakgrunden — kräver starttider + placerade kontroller.
  let etaText = '';
  (async () => {
    try {
      if (comp?.demo) return;
      const [allControls, track, allScores] = await Promise.all([
        listControls(cid),
        getTrack(cid).catch(() => null),
        // Kalibrering: verkliga mellantider (inkl. köer) skärper fönstret
        // så fort tre patruller passerat ett ben.
        listAllScoresForEta(cid).catch(() => null)
      ]);
      const w = controlEtaWindow(comp, allControls, track, patrols, ctrlId, new Date(), allScores);
      if (!w) return;
      etaText = w.lo === w.hi ? `Patruller väntas hit ca ${w.lo}` : `Patruller väntas hit ca ${w.lo}–${w.hi}`;
      renderHead();
    } catch { /* estimatet är en bonus — aldrig ett fel */ }
  })();

  // --- Render head (title etc) ---
  function renderHead() {
    const closedBanner = comp?.demo
      ? `<div class="r-closed" style="background:var(--r-accent);">Demospår — rapportering är avstängd. Utforska gärna, inget sparas.</div>`
      : (control.open
        ? ''
        : `<div class="r-closed">Kontrollen är stängd för rapportering.</div>`);

    const groups = allInstructionGroups(control);
    const generalInfo = (comp?.generalInfo || '').trim();
    const mgmt = internalManagement(comp);
    const hasBackContent = groups.length > 0 || (control.lat && control.lng) || !!control.placement || !!generalInfo || mgmt.length > 0;
    head.innerHTML = `
      ${closedBanner}
      <div class="r-head">
        <div class="r-eyebrow">${escapeHtml(comp?.shortName || 'Tävling')} ${comp?.year ? '· ' + comp.year : ''}</div>
        <h1 class="r-title">
          <span class="r-ctrl-no">${escapeHtml(String(control.nummer ?? ''))}</span>${escapeHtml(control.name || '')}
        </h1>
        <div class="r-sub">Rapportera poäng. Max ${control.maxPoang ?? 0} · Min ${control.minPoang ?? 0}${control.extraPoang ? ' · Extra max ' + control.extraPoang : ''}</div>
        ${etaText ? `<div class="r-eta">${icon('clock', { size: 13 })} ${escapeHtml(etaText)}</div>` : ''}
      </div>
    `;

    wireInfoButton(control, groups, generalInfo, mgmt, hasBackContent);
  }

  // --- Avdelning chips ---
  function renderAvdelningar() {
    const counts = {};
    patrols.forEach(p => { counts[p.avdelning] = (counts[p.avdelning] || 0) + 1; });
    const reported = new Set(scores.map(s => s.patrolId));
    // Utgångna patruller (DNF) kommer aldrig — de räknas inte som "kvar".
    const remaining = {};
    patrols.forEach(p => {
      if (!reported.has(p.id) && !p.utgatt) remaining[p.avdelning] = (remaining[p.avdelning] || 0) + 1;
    });
    const expected = patrols.filter(p => !p.utgatt);
    const totalRemaining = expected.filter(p => !reported.has(p.id)).length;
    const totalDone = patrols.length - patrols.filter(p => !reported.has(p.id)).length;
    const present = AVDELNINGAR.filter(a => counts[a.key]);
    // Klart-läge: sista patrullen rapporterad — svara på dagens sista fråga
    // ("kan vi gå hem?") och varna om osynkade rapporter innan mobilen åker
    // ner i fickan utan täckning.
    const pendingCount = listQueue(cid, ctrlId).length;
    const allDone = expected.length > 0 && totalRemaining === 0;
    avd.innerHTML = `
      ${allDone ? `
        <div class="r-done-banner${pendingCount ? ' has-pending' : ''}">
          <strong>${pendingCount ? 'Nästan klart!' : `Ni är klara — tack för i dag! ${icon('party-popper', { size: 16 })}`}</strong>
          ${pendingCount
            ? `<span>${pendingCount} rapport${pendingCount === 1 ? '' : 'er'} är INTE synkad${pendingCount === 1 ? '' : 'e'} ännu — håll sidan öppen där det finns täckning tills allt skickats.</span>`
            : '<span>Alla patruller har fått poäng och allt är synkat. Stäng kontrollen med sekretariatet innan ni packar ihop.</span>'}
        </div>
      ` : ''}
      <div class="r-label" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Avdelning</span>
        <span style="color:var(--r-fg);letter-spacing:normal;text-transform:none;font-weight:600;">${totalDone} av ${patrols.length} klara</span>
      </div>
      <div class="avd-chips">
        <button type="button" class="avd-chip ${state.avd == null ? 'active' : ''}" data-avd="">
          Alla<span class="avd-count">${totalRemaining} kvar</span>
        </button>
        ${present.map(a => `
          <button type="button" class="avd-chip ${state.avd === a.key ? 'active' : ''}" data-color="${a.short}" data-avd="${a.key}">
            ${escapeHtml(a.key)}
            <span class="avd-count">${remaining[a.key] || 0} kvar</span>
          </button>
        `).join('')}
      </div>
    `;
    avd.querySelectorAll('.avd-chip').forEach(b => {
      b.addEventListener('click', () => {
        state.avd = b.dataset.avd || null;
        renderAvdelningar();
        renderPatrols();
      });
    });
  }

  // --- Patrols list ---
  function renderPatrols() {
    const scoreByPatrol = {};
    scores.forEach(s => { scoreByPatrol[s.patrolId] = s; });
    let rows = patrols;
    if (state.avd) rows = rows.filter(p => p.avdelning === state.avd);
    // Sök: nummer matchar på prefix ("1" hittar #1, #12, #13), namn och kår på
    // delsträng. När patruller kommer i klunga ska kontrollanten kunna skriva
    // "7" eller "räv" i stället för att ögna igenom hela rutnätet — att öppna
    // fel patrull är en riktig poängmiss.
    const q = (state.sok || '').trim().toLowerCase();
    if (q) {
      rows = rows.filter(p =>
        String(p.number ?? '').startsWith(q)
        || (p.name || '').toLowerCase().includes(q)
        || (p.kar || '').toLowerCase().includes(q));
    }
    // Non-reported patrols first (start-order within group), reported last.
    // Utgångna (DNF) allra sist — de kommer inte, men går att rapportera om
    // de hann göra kontrollen innan de bröt.
    rows = [...rows].sort((a, b) => {
      const aOut = a.utgatt ? 1 : 0, bOut = b.utgatt ? 1 : 0;
      if (aOut !== bOut) return aOut - bOut;
      const aDone = !!scoreByPatrol[a.id];
      const bDone = !!scoreByPatrol[b.id];
      if (aDone !== bDone) return aDone ? 1 : -1;
      return (a.number || 0) - (b.number || 0) || (a.name || '').localeCompare(b.name || '', 'sv');
    });

    if (!rows.length) {
      plist.innerHTML = `
        <div class="r-label">Patruller</div>
        <div class="r-empty">${q ? 'Ingen patrull matchar sökningen.' : 'Inga patruller i vald avdelning.'}</div>`;
      return;
    }

    plist.innerHTML = `
      <div class="r-label">Välj patrull (${rows.length})</div>
      <div class="patrol-grid">
        ${rows.map(p => {
          const s = scoreByPatrol[p.id];
          const pending = isPending(cid, ctrlId, p.id);
          const missingGissning = s && control.utslag && s.utslagGissning == null;
          return `<button type="button" class="patrol-btn ${s ? 'reported' : ''}" data-id="${p.id}"
            aria-label="${escapeHtml(`#${p.number ?? ''} ${p.name || ''}${p.kar ? ', ' + p.kar : ''}. ${s ? `Rapporterad, ${(Number(s.poang) || 0) + (Number(s.extraPoang) || 0)} poäng` : 'Ej rapporterad'}${pending ? ', väntar på synk' : ''}`)}">
            <div class="p-num">#${p.number ?? '—'}</div>
            <div class="p-name">${escapeHtml(p.name || '—')}</div>
            <div class="p-meta">${escapeHtml(p.kar || '')}${p.utgatt ? ' <span class="p-utgatt">Utgått</span>' : ''}${pending ? ' <span class="p-pending">Väntar på synk</span>' : ''}${missingGissning ? ' <span class="p-missing-guess">Utslagssvar saknas!</span>' : ''}</div>
            ${s ? `<span class="p-score">${s.poang}${s.extraPoang ? '+' + s.extraPoang : ''}</span>` : ''}
          </button>`;
        }).join('')}
      </div>
    `;

    plist.querySelectorAll('.patrol-btn').forEach(b => {
      bindHaptic(b);
      b.addEventListener('click', () => openScoreSheet(b.dataset.id));
    });
  }

  // --- Score entry sheet ---
  function openScoreSheet(patrolId) {
    const patrol = patrols.find(p => p.id === patrolId);
    if (!patrol) return;
    const existing = scores.find(s => s.patrolId === patrolId);
    // If nothing is confirmed server-side yet but a pending offline write is
    // queued for this patrol, treat that as the current state so the user
    // doesn't re-enter a score they already reported.
    const pending = !existing ? listQueue(cid, ctrlId).find(x => x.patrolId === patrolId) : null;
    const seed = existing || pending;
    const maxP = Number(control.maxPoang) || 0;
    const minP = Number(control.minPoang) || 0;
    const maxE = Number(control.extraPoang) || 0;

    const midP = Math.round((minP + maxP) / 2);
    let poang = seed ? Number(seed.poang) : midP;
    let extra = seed ? Number(seed.extraPoang) : 0;
    let note = seed?.note || '';
    const isUtslag = !!control.utslag;
    const seedGissning = seed?.utslagGissning;

    // Poängbladet ligger i samma bottensheet som allt annat på fältsidorna.
    // Spara-knappen bor i fotens fasta yta: på en telefon med långa
    // instruktioner ska man aldrig behöva scrolla för att komma åt den.
    const ark = openSheet({
      eyebrow: `Patrull #${patrol.number ?? ''}`,
      title: patrol.name || '',
      className: 'sheet-score',
      // Inget stäng-på-tapp-bredvid: kontrollanten kan ha prickat in poäng
      // och skrivit en notering, och ett slarvigt tapp ovanför bladet får
      // inte kasta det. Handtaget, ✕ och Esc stänger.
      backdropClose: false,
      body: `
        <div class="score-who">${escapeHtml(patrol.avdelning || '')} · ${escapeHtml(patrol.kar || '')}</div>

        <div class="r-label-inline">Poäng</div>
        <div class="score-stepper">
          <button type="button" class="step-btn" id="minus" aria-label="Minska">${icon('minus', { size: 28 })}</button>
          <div class="score-display" id="val" role="status" aria-live="polite" aria-atomic="true">
            ${poang}
            <span class="range">max ${maxP} · min ${minP}</span>
          </div>
          <button type="button" class="step-btn" id="plus" aria-label="Öka">${icon('plus', { size: 28 })}</button>
        </div>
        <input type="number" class="r-input" id="poang-input" inputmode="numeric" value="${poang}" min="${minP}" max="${maxP}" step="1">
        ${maxP > minP ? `<button type="button" class="score-full" id="fullpott" aria-pressed="false">Full pott — ${maxP}${maxE > 0 ? ` + ${maxE} extra` : ''}</button>` : ''}

        ${maxE > 0 ? `
          <div style="margin-top:18px;" class="r-label-inline">Extra poäng (max ${maxE})</div>
          <div class="score-stepper">
            <button type="button" class="step-btn" id="eminus" aria-label="Minska extra">${icon('minus', { size: 28 })}</button>
            <div class="score-display" id="eval" role="status" aria-live="polite" aria-atomic="true">${extra}<span class="range">0 – ${maxE}</span></div>
            <button type="button" class="step-btn" id="eplus" aria-label="Öka extra">${icon('plus', { size: 28 })}</button>
          </div>` : ''}

        ${isUtslag ? `
          <div style="margin-top:18px;" class="r-label-inline">Utslagsfråga${control.utslagFraga ? `: ${escapeHtml(control.utslagFraga)}` : ''}</div>
          <input type="number" class="r-input" id="gissning-input" inputmode="decimal" step="any"
            value="${seedGissning != null && Number.isFinite(Number(seedGissning)) ? seedGissning : ''}"
            placeholder="Patrullens svar" style="display:block;">
          <div style="font-size:13px;color:var(--r-fg-muted);margin-top:4px;">Vid lika poäng vinner patrullen närmast rätt svar — glöm inte fylla i!</div>` : ''}

        <div style="margin-top:18px;" class="r-label-inline">Notering (frivilligt)</div>
        <div class="note-chips">${NOTE_CHIPS.map(t =>
          `<button type="button" class="note-chip${harNotering(note, t) ? ' active' : ''}" data-chip="${escapeHtml(t)}" aria-pressed="${harNotering(note, t)}">${escapeHtml(t)}</button>`
        ).join('')}</div>
        <textarea class="r-textarea" id="note" placeholder="T.ex. regelavvikelse eller kommentar…">${escapeHtml(note)}</textarea>`,
      footer: `
        <button type="button" class="r-btn" id="save">${existing ? 'Uppdatera poäng' : 'Spara poäng'}</button>
        ${existing ? '<button type="button" class="r-btn danger" id="remove">Ta bort rapport</button>' : ''}`
    });
    const overlay = ark.el;
    const close = ark.close;

    const valEl = overlay.querySelector('#val');
    const inp = overlay.querySelector('#poang-input');
    // Sätts nedan när Full pott-knappen finns. Måste deklareras HÄR: setPoang
    // skriver inp.value programmatiskt, vilket inte utlöser något input-event,
    // så knappen stod kvar som "full" efter ett tryck på minus.
    let speglaFull = () => {};
    const setPoang = (v) => {
      poang = Math.max(minP, Math.min(maxP, Number(v) || 0));
      valEl.firstChild.textContent = poang + ' ';
      inp.value = poang;
      speglaFull();
    };
    // bindTap uses touchstart+preventDefault so two quick +/- taps register
    // as two increments on iOS without the browser ever considering it a
    // double-tap-to-zoom gesture.
    bindTap(overlay.querySelector('#minus'), () => setPoang(poang - 1));
    bindTap(overlay.querySelector('#plus'),  () => setPoang(poang + 1));
    // Don't clamp while the user is still typing — with min 5, typing "12"
    // used to become "5" after the first keystroke and then "52" → 20.
    // Track the raw value on input; clamp once on blur/change and at save.
    inp.addEventListener('input', e => {
      const n = Number(e.target.value);
      if (Number.isFinite(n) && e.target.value.trim() !== '') {
        poang = n;
        valEl.firstChild.textContent = n + ' ';
      }
    });
    inp.addEventListener('change', e => setPoang(e.target.value));

    // setExtra ligger utanför if-blocket: Full pott-knappen nedan måste nå den,
    // och en block-scopad const hade kastat ReferenceError vid första trycket.
    const evalEl = overlay.querySelector('#eval');
    const setExtra = (v) => {
      extra = Math.max(0, Math.min(maxE, Number(v) || 0));
      if (evalEl) evalEl.firstChild.textContent = extra + '';
      speglaFull();
    };
    if (maxE > 0) {
      bindTap(overlay.querySelector('#eminus'), () => setExtra(extra - 1));
      bindTap(overlay.querySelector('#eplus'),  () => setExtra(extra + 1));
    }

    // Full pott: vid kontroller där de flesta klarar allt stegade kontrollanten
    // upp från mitten för VARJE patrull — åtta tapp på en 15-poängskontroll.
    // Knappen fyller bara i värdet; Spara är kvar som bekräftelse, så ett
    // felaktigt tapp aldrig blir en sparad rapport.
    const fullBtn = overlay.querySelector('#fullpott');
    if (fullBtn) {
      speglaFull = () => {
        const full = poang === maxP && extra === maxE;
        fullBtn.classList.toggle('is-full', full);
        fullBtn.setAttribute('aria-pressed', String(full));
      };
      bindTap(fullBtn, () => { setPoang(maxP); setExtra(maxE); });
      inp.addEventListener('input', () => speglaFull());
      speglaFull();
    }

    // Snabbnoteringar. Chipsen skriver in vanlig läsbar text i SAMMA note-fält
    // — noteringen hamnar i reservprotokollet, exporten och admin, och där ska
    // det stå svenska, inte koder. Aktiv = etiketten finns i texten, vilket
    // också gör att en handskriven "Regelbrott" tänder sitt chip.
    const noteEl = overlay.querySelector('#note');
    overlay.querySelectorAll('[data-chip]').forEach(chip => {
      bindTap(chip, () => {
        const t = chip.dataset.chip;
        noteEl.value = harNotering(noteEl.value, t)
          ? taBortNotering(noteEl.value, t)
          : laggTillNotering(noteEl.value, t);
        const på = harNotering(noteEl.value, t);
        chip.classList.toggle('active', på);
        chip.setAttribute('aria-pressed', String(på));
      });
    });
    // Skriver kontrollanten själv ska chipsen följa med.
    noteEl.addEventListener('input', () => {
      overlay.querySelectorAll('[data-chip]').forEach(c => {
        const på = harNotering(noteEl.value, c.dataset.chip);
        c.classList.toggle('active', på);
        c.setAttribute('aria-pressed', String(på));
      });
    });

    const saveBtn = overlay.querySelector('#save');
    bindHaptic(saveBtn, 15);
    saveBtn.addEventListener('click', async () => {
      if (comp?.demo) { rtoast('Demospår — rapportering är avstängd.', 'err'); return; }
      if (!control.open) { rtoast('Kontrollen är stängd.', 'err'); return; }
      // Final clamp — the input only clamps on blur, and a fast tap on Spara
      // could race the change event.
      poang = Math.round(Math.max(minP, Math.min(maxP, Number(poang) || 0)));
      extra = Math.round(Math.max(0, Math.min(maxE, Number(extra) || 0)));
      const noteRaw = overlay.querySelector('#note').value.trim();
      const noteVal = kapaNotering(noteRaw, 500);
      if (noteVal !== noteRaw) rtoast('Noteringen var för lång och kortades.', 'err');
      const gissningRaw = isUtslag ? overlay.querySelector('#gissning-input').value.trim() : '';
      const gissning = gissningRaw !== '' && Number.isFinite(Number(gissningRaw)) ? Number(gissningRaw) : null;
      // Gissningsvakt: en glömd utslagsgissning är oåterkallelig när
      // patrullen gått vidare. Första trycket utan svar armerar en varning;
      // andra trycket sparar medvetet utan svar.
      if (isUtslag && gissning == null && saveBtn.dataset.guessArmed !== '1') {
        saveBtn.dataset.guessArmed = '1';
        saveBtn.textContent = 'Spara UTAN utslagssvar';
        const gi = overlay.querySelector('#gissning-input');
        gi.style.borderColor = 'var(--r-danger, #DA005E)';
        gi.focus();
        rtoast('Ingen utslagsgissning ifylld — vid lika poäng förlorar patrullen utslaget. Fyll i svaret, eller tryck igen för att spara utan.', 'err');
        gi.addEventListener('input', () => {
          saveBtn.dataset.guessArmed = '';
          saveBtn.textContent = existing ? 'Uppdatera poäng' : 'Spara poäng';
          gi.style.borderColor = '';
        }, { once: true });
        return;
      }
      const reporter = reporterId();
      // The adjustment/revision trail (`history`) is admin-authored only and
      // immutable to anonymous writes (Firestore rules enforce it). A plain
      // re-report therefore passes the EXISTING history through verbatim so
      // any sekretariat-justering that was recorded survives the overwrite —
      // it never fabricates or grows history itself.
      const history = existing && Array.isArray(existing.history) && existing.history.length
        ? existing.history
        : null;
      // Queue locally first so the report survives even if the tab is closed
      // mid-save. Firestore's setDoc is idempotent on our keys (patrolId) so
      // the retry on reconnect cannot create duplicates.
      enqueue(cid, ctrlId, {
        patrolId: patrol.id, poang, extraPoang: extra, note: noteVal, reporter,
        ...(gissning != null ? { utslagGissning: gissning } : {}),
        ...(history ? { history } : {})
      });
      sync.render();

      saveBtn.disabled = true; saveBtn.textContent = 'Sparar…';
      try {
        await withTimeout(
          // clientAt = nu: direktrapport bär tryck-ögonblicket som passagetid.
          upsertScore(cid, ctrlId, patrol.id, poang, extra, noteVal, reporter, gissning, history, new Date()),
          navigator.onLine ? 5000 : 500
        );
        removeFromQueue(cid, ctrlId, patrol.id);
        haptic([12, 40, 12]);
        sync.render();
        // Stäng bladet FÖRST, sedan toasten: rtoast lämnar över till bladets
        // notisrad så länge bladet är öppet, och den raden försvinner med
        // bladet. En kontrollant i skogen ska se att poängen gick fram, så
        // bekräftelsen måste ligga kvar på sidan efter att bladet glidit ner.
        close();
        rtoast(existing ? 'Poäng uppdaterat' : 'Poäng sparat');
      } catch (e) {
        if (isPermanentError(e)) {
          // Firestore actively rejected the write (e.g. the control was just
          // closed) — retrying can never succeed, so don't pretend it was
          // saved and don't leave it poisoning the queue.
          console.error('[ESKIL] score rejected:', e);
          removeFromQueue(cid, ctrlId, patrol.id);
          saveBtn.disabled = false;
          saveBtn.textContent = existing ? 'Uppdatera poäng' : 'Spara poäng';
          rtoast('Kunde inte spara — kontrollen kan ha stängts. Kontakta tävlingsledningen.', 'err');
          sync.render();
          return;
        }
        // Timeout / connectivity: the item is already in the local queue and
        // will be retried by trySync() when the network comes back.
        console.warn('[ESKIL] score queued for later sync:', e.message);
        haptic(20);
        sync.render();
        // Se kommentaren i success-grenen: bekräftelsen måste överleva att
        // bladet stängs. Extra viktigt här — "sparat offline" är hela
        // tryggheten när nätet är borta.
        close();
        rtoast('Sparat offline — synkas när nätet kommer tillbaka');
      }
    });

    if (existing) {
      const removeBtn = overlay.querySelector('#remove');
      bindHaptic(removeBtn, 20);
      removeBtn.addEventListener('click', async () => {
        if (!confirm('Ta bort rapporten för denna patrull?')) return;
        // Also purge any pending offline write for this patrol so the queue
        // doesn't resurrect the deleted score when it eventually syncs.
        removeFromQueue(cid, ctrlId, patrol.id);
        try {
          // Samma timeout-mönster som spara-vägen: en offline Firestore-
          // skrivning (även delete) resolvar aldrig, så utan withTimeout
          // hänger bladet öppet utan återkoppling i exakt de svaga-nät-
          // förhållanden fältet lever i. Firestore buffrar borttagningen
          // lokalt och synkar den när nätet är tillbaka.
          await withTimeout(deleteScore(cid, ctrlId, existing.id), navigator.onLine ? 5000 : 500);
          sync.render();
          close();
          rtoast('Borttagen');
        } catch (e) {
          if (e?.message === 'offline-timeout') {
            sync.render();
            close();
            rtoast('Borttagen offline — synkas när nätet kommer tillbaka');
          } else {
            rtoast('Fel: ' + e.message, 'err');
          }
        }
      });
    }
  }

  // --- Offline queue UI ---
  const sync = {
    el: null,
    set(state, text) {
      if (!this.el) return;
      this.el.hidden = !text;
      this.el.className = 'r-sync ' + (state ? 'is-' + state : '');
      this.el.innerHTML = text
        ? `<span class="r-sync-dot"></span><span>${escapeHtml(text)}</span>`
        : '';
    },
    render() {
      const pending = listQueue(cid, ctrlId).length;
      if (!pending && navigator.onLine) { this.set('', ''); return; }
      if (!navigator.onLine) {
        this.set('offline', pending
          ? `Offline — ${pending} rapport${pending === 1 ? '' : 'er'} väntar på synk`
          : 'Offline — rapporter sparas lokalt tills nätet kommer tillbaka');
      } else {
        this.set('syncing', `Synkar ${pending} rapport${pending === 1 ? '' : 'er'}…`);
      }
    }
  };

  let syncInFlight = false;
  // Sätts av livstecken-blocket längre ner (som definieras efter trySync men
  // initieras före första anropet). Null tills dess — och på en stängd eller
  // demo-kontroll, där inget livstecken skickas alls.
  let beaconRefresh = null;
  async function trySync({ silent = false } = {}) {
    if (!navigator.onLine) { sync.render(); return; }
    const before = listQueue(cid, ctrlId).length;
    if (!before) { sync.render(); return; }
    // online/visibilitychange can fire in quick succession — never run two
    // flushes concurrently (a slow in-flight write could otherwise overwrite
    // a newer score saved meanwhile).
    if (syncInFlight) return;
    syncInFlight = true;
    sync.render();
    let synced = [], failed = [];
    try {
      ({ synced, failed } = await flushQueue(cid, ctrlId,
        // queuedAt = när knappen trycktes — passagetiden följer med även när
        // rapporten synkas timmar senare (annars förgiftas ETA-mellantiderna).
        (item) => upsertScore(cid, ctrlId, item.patrolId, item.poang, item.extraPoang, item.note, item.reporter, item.utslagGissning ?? null, item.history ?? null, item.queuedAt ?? null)
      ));
    } finally {
      syncInFlight = false;
    }
    if (failed.length) {
      // Permanently rejected (e.g. the control was closed while the reports
      // sat in the queue). This is data the user believes is saved — say so
      // loudly, with patrol names, so they can alert tävlingsledningen.
      const names = failed
        .map(f => patrols.find(p => p.id === f.item.patrolId)?.name || 'okänd patrull');
      console.error('[ESKIL] queued scores rejected:', failed);
      rtoast(`${failed.length} rapport${failed.length === 1 ? '' : 'er'} avvisades (kontrollen kan ha stängts): ${names.join(', ')}. Kontakta tävlingsledningen!`, 'err');
    }
    if (synced.length) {
      renderPatrols();
      rensaEtaCache(cid);
      beaconRefresh?.();
      if (!silent) {
        const names = synced
          .map(s => patrols.find(p => p.id === s.patrolId)?.name || '#' + (patrols.find(p => p.id === s.patrolId)?.number ?? ''))
          .filter(Boolean);
        const head = synced.length === 1
          ? `Synkade: ${names[0] || '1 rapport'}`
          : `Synkade ${synced.length} rapporter: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`;
        rtoast(head);
      }
    }
    if (!listQueue(cid, ctrlId).length && !silent) {
      sync.set('ok', 'Alla rapporter synkade');
      setTimeout(() => sync.render(), 3000);
    } else {
      sync.render();
    }
  }

  window.addEventListener('online', () => trySync());
  window.addEventListener('offline', () => sync.render());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) trySync(); });

  // --- Layout ---
  root.innerHTML = `
    <div id="head"></div>
    <div id="sync" class="r-sync" role="status" aria-live="polite" hidden></div>
    <div class="r-section" id="avd"></div>
    <div class="r-section" id="psok"></div>
    <div class="r-section" id="plist"></div>
    <p class="r-sub" style="text-align:center;opacity:.6;margin-top:40px;">
      ESKIL · rapporteringen uppdateras i realtid<br>
      <a href="/t/${escapeHtml(cid)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;">Tävlingssidan — startlista &amp; resultat</a>
    </p>
  `;
  const head = root.querySelector('#head');
  const avd = root.querySelector('#avd');
  const plist = root.querySelector('#plist');

  // Meddelandeikonen: driftmeddelanden OCH samtalet med ledningen i samma
  // modal. Kontrollanten står ensam i skogen med en regel som inte täcker
  // fallet framför sig — det här är vägen att fråga.
  chatPanel?.destroy();
  chatPanel = mountMessages({
    cid, kind: 'kontroll', refId: ctrlId, token: samtalsToken,
    enabled: comp?.fieldMessaging !== false, demo: !!comp?.demo
  });

  sync.el = root.querySelector('#sync');

  // Sökrutan ligger UTANFÖR renderPatrols: rutnätet ritas om på varje
  // poäng-snapshot, och ett fält inne i det skulle tappa fokus och text mitt
  // i skrivandet. Visas först när listan är lång nog att behöva sökas i.
  if (patrols.length >= 9) {
    const psok = root.querySelector('#psok');
    psok.innerHTML = `
      <div class="p-sok">
        ${icon('search', { size: 17 })}
        <input type="search" id="p-sok-input" placeholder="Sök nummer, patrull eller kår"
          autocomplete="off" enterkeyhint="search" aria-label="Sök patrull">
        <button type="button" id="p-sok-x" aria-label="Rensa sökningen" hidden>${icon('x', { size: 16 })}</button>
      </div>`;
    const inp = psok.querySelector('#p-sok-input');
    const x = psok.querySelector('#p-sok-x');
    inp.addEventListener('input', () => {
      state.sok = inp.value;
      x.hidden = !inp.value;
      renderPatrols();
    });
    x.addEventListener('click', () => {
      inp.value = ''; state.sok = ''; x.hidden = true;
      renderPatrols(); inp.focus();
    });
  }

  // Håll skärmen tänd så länge sidan är synlig. En ensam kontrollant i regn
  // ska inte behöva låsa upp med blöta vantar mellan varje patrullklunga —
  // och en släckt skärm mitt i ett halvifyllt poängblad är hur rapporter
  // tappas. Låset släpps av webbläsaren när fliken göms; ta det igen när den
  // syns. Tyst no-op där API:t saknas (äldre Safari) — sidan fungerar som förr.
  // --- Sparläge vid lågt batteri --------------------------------------------
  // En kontroll längst ut på banan har ingen laddning, och telefonen ska räcka
  // hela dagen. Under tröskeln stängs det som kostar ström och INTE är
  // rapportering av: skärmlåset släpps och hjärtslaget glesas ut.
  //
  // Rapporteringen och offline-kön rörs ALDRIG. De är hela skälet till att
  // sidan finns; en optimering som gör dem långsammare eller osäkrare har
  // missat vad den optimerar för. Sparläget säger heller aldrig ifrån mer än
  // en gång — en banner som tjatar är en banner man slutar läsa.
  // Tröskelbeslutet (med hysteres) ligger i utils.sparlagesBeslut — rent och
  // testat. Här bara följderna.
  let sparlage = false;
  let sparlageSagt = false;
  let wakeSentinel = null;

  const keepAwake = async () => {
    if (sparlage) return;
    try { wakeSentinel = await navigator.wakeLock?.request('screen') ?? null; }
    catch { /* t.ex. batterisparläge */ }
  };
  const slappAwake = () => {
    try { wakeSentinel?.release?.(); } catch { /* redan släppt */ }
    wakeSentinel = null;
  };

  function sattSparlage(pa) {
    if (pa === sparlage) return;
    sparlage = pa;
    if (pa) {
      slappAwake();
      if (!sparlageSagt) {
        sparlageSagt = true;
        rtoast('Lågt batteri — sparläge på. Skärmen släcks som vanligt och livstecknet glesas ut. Rapporteringen påverkas inte.');
      }
    } else {
      keepAwake();
    }
    document.body.classList.toggle('is-sparlage', pa);
  }

  // Batteri-API:t saknas på iOS. Där finns inget sparläge — och det är rätt:
  // att gissa batterinivå vore värre än att låta bli.
  (async () => {
    let b = null;
    try { b = await navigator.getBattery?.(); } catch { /* stöds inte */ }
    if (!b) return;
    const bedom = () => sattSparlage(sparlagesBeslut(sparlage, { level: b.level, charging: b.charging }));
    bedom();
    b.addEventListener?.('levelchange', bedom);
    b.addEventListener?.('chargingchange', bedom);
  })();

  keepAwake();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });

  // Livstecknet till Läget: var femte minut medan sidan är synlig skrivs ett
  // litet hjärtslag (klient-tid, batterinivå, antal köade poäng) till
  // kontrollens beacon-dokument. Ledningen kan då skilja "tyst för att inga
  // patruller kommit än" från "telefonen håller på att dö" — och ser köade
  // offline-poäng som annars bara finns i den här telefonens localStorage.
  // `at` är klient-tid: buffras skrivningen offline och synkar senare bär den
  // ändå den sanna senast-vid-liv-tiden. Fel sväljs — livstecknet är en
  // bonus och får aldrig störa rapporteringen.
  // Minsta tid mellan två livstecken. Intervallet är 5 min, men
  // flikväxlingen nedan skickar också — och en kontrollant väcker telefonen
  // för varje patrull. Utan strypning blir det hundratals skrivningar per
  // kontroll och dag (mätt: 200 väckningar × 30 kontroller ≈ 44 % av
  // Firestores dygnskvot bara för hjärtslag). Läget behöver ändå bara veta
  // "hördes av inom fem minuter" — sekundprecision tillför ingenting.
  const BEACON_MIN_MS = 60000;
  let sistaBeacon = 0;
  const skickaLivstecken = async ({ tvinga = false } = {}) => {
    if (document.hidden || comp?.demo || !control.open) return;
    // I sparläge glesas hjärtslaget till en fjärdedel. Det stängs INTE av:
    // en kontroll med lågt batteri är precis den ledningen behöver se.
    const minsta = sparlage ? BEACON_MIN_MS * 4 : BEACON_MIN_MS;
    if (!tvinga && Date.now() - sistaBeacon < minsta) return;
    sistaBeacon = Date.now();
    let batteri = null, laddar = null;
    try {
      const b = await navigator.getBattery?.();
      if (b) { batteri = Math.round(b.level * 100); laddar = !!b.charging; }
    } catch { /* API:t saknas (iOS) — skicka utan */ }
    try {
      await sendControlBeacon(cid, ctrlId, { batteri, laddar, koade: listQueue(cid, ctrlId).length });
    } catch { /* aldrig ett fel för kontrollanten */ }
  };
  skickaLivstecken();
  let beaconTimer = setInterval(skickaLivstecken, 5 * 60000);
  // När kontrollanten växlar tillbaka till fliken: skicka direkt i stället
  // för att vänta upp till fem minuter på nästa intervall — Läget ska se
  // "vaknade nyss" så fort telefonen faktiskt är tillbaka.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) skickaLivstecken(); });
  // pagehide/pageshow är ett PAR. Sidan hamnar i bfcache när kontrollanten
  // byter app, och plockas fram igen när hen kommer tillbaka — utan
  // pageshow-halvan var intervallet dödat för resten av dagen och kontrollen
  // slutade tyst höra av sig efter första app-växlingen.
  window.addEventListener('pagehide', () => { clearInterval(beaconTimer); beaconTimer = null; });
  window.addEventListener('pageshow', () => {
    if (beaconTimer) return;
    beaconTimer = setInterval(skickaLivstecken, 5 * 60000);
    skickaLivstecken();
  });
  // Efter en lyckad synk är kön tom — säg det direkt i stället för att låta
  // Läget visa "3 i kö" i upp till fem minuter efter att de kommit fram.
  // Efter en lyckad synk är kön tom — säg det direkt i stället för att låta
  // Läget visa "3 i kö" i upp till fem minuter efter att de kommit fram.
  beaconRefresh = () => skickaLivstecken({ tvinga: true });

  renderHead();
  renderAvdelningar();
  renderPatrols();

  // Flush on load — if the previous session left queued writes, sync them and
  // tell the user (a toast here is informative, not noise: it explains why
  // patrols suddenly flip to "reported").
  trySync();
}

main().catch(e => {
  console.error(e);
  root.innerHTML = `<div class="r-empty">Fel vid inläsning: ${escapeHtml(e.message)}</div>`;
});
