// Control reporting page logic. No auth — security-by-obscurity via long
// Firestore document IDs. Subscribes to patrols + scores and lets anyone
// with the URL report (if the control is open).

import { db, doc, onSnapshot } from './firebase.js';
import { getCompetition, getControl, listPatrols, watchScoresForControl, upsertScore, deleteScore } from './store.js';
import { AVDELNINGAR, escapeHtml, allInstructionGroups, internalManagement } from './utils.js';
import { ensureLeaflet } from './leaflet.js';
import { icon } from './icons.js';
import { haptic, bindHaptic, lockScroll, unlockScroll } from './haptic.js';

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

// Wire up the flip card: (i) toggles, ✕ closes, map lazy-loads on first flip.
let flipMapLoaded = false;
function wireFlipCard(control) {
  const card = document.getElementById('flip-card');
  const inner = card?.querySelector('.flip-card-inner');
  const openBtn = document.getElementById('flip-open');
  const closeBtn = document.getElementById('flip-close');
  const front = card?.querySelector('.flip-front');
  const back = card?.querySelector('.flip-back');
  if (!card || !openBtn || !inner) return;

  const applyHeight = () => {
    const isFlipped = card.classList.contains('flipped');
    const h = isFlipped ? back.offsetHeight : front.offsetHeight;
    inner.style.minHeight = h + 'px';
  };

  const setFlipped = (on) => {
    if (on && !flipMapLoaded && control.lat && control.lng) {
      flipMapLoaded = true;
      loadFlipMap(control.lat, control.lng);
    }
    card.classList.toggle('flipped', on);
    openBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    back.setAttribute('aria-hidden', on ? 'false' : 'true');
    applyHeight();
  };

  openBtn.addEventListener('click', () => setFlipped(!card.classList.contains('flipped')));
  closeBtn?.addEventListener('click', () => setFlipped(false));
  // Initial size once fonts etc. have painted
  requestAnimationFrame(applyHeight);
  window.addEventListener('resize', applyHeight);
}

async function loadFlipMap(lat, lng) {
  const host = document.getElementById('flip-map');
  if (!host) return;
  try {
    const L = await ensureLeaflet();
    const map = L.map(host, { zoomControl: true, scrollWheelZoom: false, dragging: true }).setView([lat, lng], 16);
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
      if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
      if (userLine) { map.removeLayer(userLine); userLine = null; }
      distChip.hidden = true;
      if (btn) setBtnState(btn, false);
    }

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
  // /k/:cid/:ctrlId
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'k' && parts.length >= 3) {
    return { cid: parts[1], ctrlId: parts[2] };
  }
  return null;
}

function rtoast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'r-toast' + (kind === 'err' ? ' err' : '');
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
    openSheetFor: null // patrol being reported
  };

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
      <div class="flip-card" id="flip-card">
        <div class="flip-card-inner">
          <div class="flip-face flip-front">
            <div class="r-head">
              <div class="r-eyebrow">${escapeHtml(comp?.shortName || 'Tävling')} ${comp?.year ? '· ' + comp.year : ''}</div>
              <div class="flip-title-row">
                <h1 class="r-title">
                  <span class="r-ctrl-no">${escapeHtml(String(control.nummer ?? ''))}</span>${escapeHtml(control.name || '')}
                </h1>
                ${hasBackContent ? `<button class="flip-btn" id="flip-open" aria-expanded="false" aria-label="Visa instruktioner och karta">${icon('info', { size: 22 })}</button>` : ''}
              </div>
              <div class="r-sub">Rapportera poäng. Max ${control.maxPoang ?? 0} · Min ${control.minPoang ?? 0}${control.extraPoang ? ' · Extra max ' + control.extraPoang : ''}</div>
            </div>
          </div>
          <div class="flip-face flip-back" aria-hidden="true">
            <button class="flip-back-close" id="flip-close" aria-label="Stäng instruktioner">${icon('x', { size: 22 })}</button>

            ${groups.length ? `
              <h3>Instruktioner</h3>
              ${groups.map(g => `
                <div class="flip-inst-group">
                  <span class="tag">${(g.avdelningar || []).length ? escapeHtml(g.avdelningar.join(' · ')) : 'Default (alla andra)'}</span>
                  <p>${escapeHtml(g.text)}</p>
                </div>
              `).join('')}
            ` : ''}

            ${generalInfo ? `
              <h3>Allmän information</h3>
              <div class="flip-placement">
                <p>${escapeHtml(generalInfo)}</p>
              </div>
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

            ${(control.lat && control.lng) ? `
              <h3>Karta</h3>
              <div class="flip-coords" aria-label="Koordinater">
                <span class="flip-coords-label">Koordinater (vid nödsituation)</span>
                <span class="flip-coords-value">${control.lat.toFixed(5)}, ${control.lng.toFixed(5)}</span>
              </div>
              <div class="flip-map" id="flip-map"></div>
            ` : ''}
            ${control.placement ? `
              <div class="flip-placement">
                <div class="label">Placering</div>
                <p>${escapeHtml(control.placement)}</p>
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;

    if (!hasBackContent) return;
    wireFlipCard(control);
  }

  // --- Avdelning chips ---
  function renderAvdelningar() {
    const counts = {};
    patrols.forEach(p => { counts[p.avdelning] = (counts[p.avdelning] || 0) + 1; });
    const reported = new Set(scores.map(s => s.patrolId));
    const remaining = {};
    patrols.forEach(p => {
      if (!reported.has(p.id)) remaining[p.avdelning] = (remaining[p.avdelning] || 0) + 1;
    });
    const totalRemaining = patrols.filter(p => !reported.has(p.id)).length;
    const totalDone = patrols.length - totalRemaining;
    const present = AVDELNINGAR.filter(a => counts[a.key]);
    avd.innerHTML = `
      <div class="r-label" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Avdelning</span>
        <span style="color:var(--r-fg);letter-spacing:normal;text-transform:none;font-weight:600;">${totalDone} av ${patrols.length} klara</span>
      </div>
      <div class="avd-chips">
        <button class="avd-chip ${state.avd == null ? 'active' : ''}" data-avd="">
          Alla<span class="avd-count">${totalRemaining} kvar</span>
        </button>
        ${present.map(a => `
          <button class="avd-chip ${state.avd === a.key ? 'active' : ''}" data-color="${a.short}" data-avd="${a.key}">
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
    // Non-reported patrols first (start-order within group), reported last.
    rows = [...rows].sort((a, b) => {
      const aDone = !!scoreByPatrol[a.id];
      const bDone = !!scoreByPatrol[b.id];
      if (aDone !== bDone) return aDone ? 1 : -1;
      return (a.number || 0) - (b.number || 0) || (a.name || '').localeCompare(b.name || '', 'sv');
    });

    if (!rows.length) {
      plist.innerHTML = `
        <div class="r-label">Patruller</div>
        <div class="r-empty">Inga patruller i vald avdelning.</div>`;
      return;
    }

    plist.innerHTML = `
      <div class="r-label">Välj patrull (${rows.length})</div>
      <div class="patrol-grid">
        ${rows.map(p => {
          const s = scoreByPatrol[p.id];
          return `<button class="patrol-btn ${s ? 'reported' : ''}" data-id="${p.id}">
            <div class="p-num">#${p.number ?? '—'}</div>
            <div class="p-name">${escapeHtml(p.name || '—')}</div>
            <div class="p-meta">${escapeHtml(p.kar || '')}</div>
            ${s ? `<span class="p-score">${s.poang}${s.extraPoang ? '+' + s.extraPoang : ''}</span>` : ''}
          </button>`;
        }).join('')}
      </div>
    `;

    plist.querySelectorAll('.patrol-btn').forEach(b => {
      bindHaptic(b);
      b.addEventListener('click', () => openSheet(b.dataset.id));
    });
  }

  // --- Score entry sheet ---
  function openSheet(patrolId) {
    const patrol = patrols.find(p => p.id === patrolId);
    if (!patrol) return;
    const existing = scores.find(s => s.patrolId === patrolId);
    const maxP = Number(control.maxPoang) || 0;
    const minP = Number(control.minPoang) || 0;
    const maxE = Number(control.extraPoang) || 0;

    const midP = Math.round((minP + maxP) / 2);
    let poang = existing ? Number(existing.poang) : midP;
    let extra = existing ? Number(existing.extraPoang) : 0;
    let note = existing?.note || '';

    const overlay = document.createElement('div');
    overlay.className = 'sheet-overlay';
    overlay.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true">
        <div class="sheet-head">
          <div>
            <div style="font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--r-fg-muted);font-weight:700;">Patrull #${patrol.number ?? ''}</div>
            <h2>${escapeHtml(patrol.name || '')}</h2>
            <div style="color:var(--r-fg-muted);margin-top:2px;">${escapeHtml(patrol.avdelning || '')} · ${escapeHtml(patrol.kar || '')}</div>
          </div>
          <button class="sheet-close" id="close" aria-label="Stäng">${icon('x', { size: 22 })}</button>
        </div>

        <div class="r-label-inline">Poäng</div>
        <div class="score-stepper">
          <button class="step-btn" id="minus" aria-label="Minska">${icon('minus', { size: 28 })}</button>
          <div class="score-display" id="val">
            ${poang}
            <span class="range">max ${maxP} · min ${minP}</span>
          </div>
          <button class="step-btn" id="plus" aria-label="Öka">${icon('plus', { size: 28 })}</button>
        </div>
        <input type="number" class="r-input" id="poang-input" inputmode="numeric" value="${poang}" min="${minP}" max="${maxP}" step="1">

        ${maxE > 0 ? `
          <div style="margin-top:18px;" class="r-label-inline">Extra poäng (max ${maxE})</div>
          <div class="score-stepper">
            <button class="step-btn" id="eminus" aria-label="Minska extra">${icon('minus', { size: 28 })}</button>
            <div class="score-display" id="eval">${extra}<span class="range">0 – ${maxE}</span></div>
            <button class="step-btn" id="eplus" aria-label="Öka extra">${icon('plus', { size: 28 })}</button>
          </div>
        ` : ''}

        <div style="margin-top:18px;" class="r-label-inline">Notering (frivilligt)</div>
        <textarea class="r-textarea" id="note" placeholder="T.ex. regelavvikelse eller kommentar…">${escapeHtml(note)}</textarea>

        <button class="r-btn" id="save">${existing ? 'Uppdatera poäng' : 'Spara poäng'}</button>
        ${existing ? '<button class="r-btn danger" id="remove">Ta bort rapport</button>' : ''}
      </div>
    `;
    document.body.appendChild(overlay);
    lockScroll();
    const close = () => { overlay.remove(); unlockScroll(); };
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    const closeBtn = overlay.querySelector('#close');
    closeBtn.onclick = close;
    bindHaptic(closeBtn);

    const valEl = overlay.querySelector('#val');
    const inp = overlay.querySelector('#poang-input');
    const setPoang = (v) => {
      poang = Math.max(minP, Math.min(maxP, Number(v) || 0));
      valEl.firstChild.textContent = poang + ' ';
      inp.value = poang;
    };
    const minusBtn = overlay.querySelector('#minus');
    const plusBtn = overlay.querySelector('#plus');
    minusBtn.onclick = () => setPoang(poang - 1);
    plusBtn.onclick = () => setPoang(poang + 1);
    bindHaptic(minusBtn);
    bindHaptic(plusBtn);
    inp.addEventListener('input', e => setPoang(e.target.value));

    if (maxE > 0) {
      const evalEl = overlay.querySelector('#eval');
      const setExtra = (v) => {
        extra = Math.max(0, Math.min(maxE, Number(v) || 0));
        evalEl.firstChild.textContent = extra + '';
      };
      const eminus = overlay.querySelector('#eminus');
      const eplus = overlay.querySelector('#eplus');
      eminus.onclick = () => setExtra(extra - 1);
      eplus.onclick = () => setExtra(extra + 1);
      bindHaptic(eminus);
      bindHaptic(eplus);
    }

    const saveBtn = overlay.querySelector('#save');
    bindHaptic(saveBtn, 15);
    saveBtn.addEventListener('click', async () => {
      if (comp?.demo) { rtoast('Demospår — rapportering är avstängd.', 'err'); return; }
      if (!control.open) { rtoast('Kontrollen är stängd.', 'err'); return; }
      saveBtn.disabled = true; saveBtn.textContent = 'Sparar…';
      try {
        await upsertScore(cid, ctrlId, patrol.id, poang, extra, overlay.querySelector('#note').value.trim(), reporterId());
        haptic([12, 40, 12]);
        rtoast(existing ? 'Poäng uppdaterat' : 'Poäng sparat');
        close();
      } catch (e) {
        console.error(e);
        rtoast('Fel: ' + e.message, 'err');
        saveBtn.disabled = false; saveBtn.textContent = existing ? 'Uppdatera poäng' : 'Spara poäng';
      }
    });

    if (existing) {
      const removeBtn = overlay.querySelector('#remove');
      bindHaptic(removeBtn, 20);
      removeBtn.addEventListener('click', async () => {
        if (!confirm('Ta bort rapporten för denna patrull?')) return;
        try {
          await deleteScore(cid, ctrlId, existing.id);
          rtoast('Borttagen');
          close();
        } catch (e) {
          rtoast('Fel: ' + e.message, 'err');
        }
      });
    }
  }

  // --- Layout ---
  root.innerHTML = `
    <div id="head"></div>
    <div class="r-section" id="avd"></div>
    <div class="r-section" id="plist"></div>
    <p class="r-sub" style="text-align:center;opacity:.6;margin-top:40px;">
      ESKIL · rapporteringen uppdateras i realtid
    </p>
  `;
  const head = root.querySelector('#head');
  const avd = root.querySelector('#avd');
  const plist = root.querySelector('#plist');

  renderHead();
  renderAvdelningar();
  renderPatrols();
}

main().catch(e => {
  console.error(e);
  root.innerHTML = `<div class="r-empty">Fel vid inläsning: ${escapeHtml(e.message)}</div>`;
});
