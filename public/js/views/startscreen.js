// Kiosk-style Start Screen for the sekretariat.
// Route: /app/c/:cid/startscreen — admin-only.
//
// Shows exactly one patrol at a time with QR + countdown to their start.
// Visibility window per patrol = one full interval centered near their start:
//   [scheduled - 0.8 × interval, scheduled + 0.2 × interval]
// → card appears 80 % of an interval before their time and stays 20 % after.
// When the wall clock reaches their scheduled moment the whole card pulses
// green: "GÅ NU". Transitions automatically as the clock advances, and
// resyncs whenever startTimes or startOrder changes in Firestore.

import { getCompetition, watchPatrols } from '../store.js';
import { db, doc, onSnapshot } from '../firebase.js';
import {
  escapeHtml, startTimeSettings, patrolStartDateTime, effectiveIntervalSec, startUrl
} from '../utils.js';
import { renderQrToImg } from '../pdf.js';
import { icon } from '../icons.js';

const FUTURE_OFFSET_FRAC = 0.8;   // card appears this far before the scheduled time
const PAST_OFFSET_FRAC   = 0.2;   // card lingers this far after

let unsubPatrols = null;
let unsubComp = null;
let tickInterval = null;
let currentPatrolId = null;
let currentQrId = null;

export async function renderStartScreen(app, user, cid) {
  stopWatches();

  let comp = await getCompetition(cid).catch(() => null);
  if (!comp) {
    app.innerHTML = `<div class="page"><div class="empty"><h3>Tävlingen hittades inte</h3></div></div>`;
    return;
  }
  const isAdmin = user.role === 'super-admin' || (comp.admins || []).includes(user.uid);
  if (!isAdmin) {
    app.innerHTML = `<div class="page"><div class="empty"><h3>Inte tillgängligt</h3><p>Bara tävlingsadministratörer kan öppna startskärmen.</p></div></div>`;
    return;
  }
  if (!startTimeSettings(comp).enabled) {
    app.innerHTML = `<div class="page"><div class="empty"><h3>Starttider är inte aktiverade</h3><p>Aktivera starttider i tävlingsinställningar först.</p><a class="btn btn-primary mt-4" href="/app/c/${cid}/settings" data-link>Öppna inställningar</a></div></div>`;
    return;
  }

  app.innerHTML = `
    <div class="ss-root">
      <header class="ss-top">
        <div class="ss-top-left">
          <div class="ss-eyebrow">${escapeHtml(comp.shortName || comp.name)} · STARTSKÄRM</div>
          <div class="ss-subline">${escapeHtml(comp.location || '')}</div>
        </div>
        <div class="ss-clock"><span id="ss-clock">—</span></div>
        <div class="ss-top-right">
          <button class="ss-btn" id="ss-fs" aria-label="Fullskärm">${icon('external', { size: 18 })}</button>
          <a class="ss-btn" href="/app/c/${cid}" data-link title="Tillbaka">${icon('x', { size: 18 })}</a>
        </div>
      </header>

      <aside class="ss-sidebar" id="ss-sidebar"></aside>

      <main class="ss-main" id="ss-main">
        <div class="ss-loading">Väntar på data…</div>
      </main>

      <footer class="ss-foot" id="ss-foot"></footer>
    </div>
  `;

  document.getElementById('ss-fs').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

  // Live: competition (starttime settings can change) + patrols (order/add/remove)
  let patrols = [];
  unsubComp = onSnapshot(doc(db, 'competitions', cid), snap => {
    if (snap.exists()) { comp = { id: cid, ...snap.data() }; tick(); }
  });
  unsubPatrols = watchPatrols(cid, rows => {
    patrols = rows;
    tick();
  });

  // 1 Hz tick — clock + window re-evaluation + countdown
  const tick = () => {
    const now = new Date();
    document.getElementById('ss-clock').textContent =
      now.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    renderWindow(comp, patrols, now);
  };
  tick();
  tickInterval = setInterval(tick, 1000);
}

function stopWatches() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  if (unsubPatrols) { unsubPatrols(); unsubPatrols = null; }
  if (unsubComp)    { unsubComp();    unsubComp = null; }
  currentPatrolId = null;
  currentQrId = null;
}
// Export so the router can call it when navigating away.
export function teardownStartScreen() { stopWatches(); }

// --- Window logic ---------------------------------------------------------
function computeSchedule(comp, patrols, now) {
  const sorted = [...patrols]
    .filter(p => Number.isFinite(Number(p.startOrder)))
    .sort((a, b) => (a.startOrder || 0) - (b.startOrder || 0));

  const total = sorted.length;
  const intervalMs = effectiveIntervalSec(comp, total) * 1000;
  const winBefore = intervalMs * FUTURE_OFFSET_FRAC;
  const winAfter  = intervalMs * PAST_OFFSET_FRAC;

  return sorted.map(p => {
    const scheduled = patrolStartDateTime(comp, p, now, total);
    return scheduled ? {
      patrol: p,
      scheduled,
      windowStart: new Date(scheduled.getTime() - winBefore),
      windowEnd:   new Date(scheduled.getTime() + winAfter)
    } : null;
  }).filter(Boolean);
}

function renderWindow(comp, patrols, now) {
  const schedule = computeSchedule(comp, patrols, now);
  if (!schedule.length) {
    document.getElementById('ss-main').innerHTML = `<div class="ss-loading">Inga patruller att visa.</div>`;
    document.getElementById('ss-foot').innerHTML = '';
    currentPatrolId = null;
    return;
  }

  // Active = patrol whose visibility window contains now. Pick the latest if
  // multiple overlap (shouldn't happen with default window sizing, but be safe).
  const active = [...schedule].reverse().find(e => now >= e.windowStart && now <= e.windowEnd);
  // Anything not yet out, excluding whoever is currently "active" (already on screen)
  const upcomingAll = schedule.filter(e => e.scheduled > now && e !== active);
  const upcoming = upcomingAll.slice(0, 4);           // bottom strip (narrow screens)
  const sidebarList = upcomingAll.slice(0, 10);       // left column (wide screens)

  // Main card
  const mainEl = document.getElementById('ss-main');
  if (!active) {
    // Between windows — show a soft "waiting" state
    const nextScheduled = upcoming[0];
    const msToNext = nextScheduled ? Math.max(0, nextScheduled.windowStart - now) : null;
    mainEl.innerHTML = `
      <div class="ss-idle">
        <div class="ss-idle-label">Väntar på nästa patrull</div>
        ${nextScheduled ? `
          <div class="ss-idle-next">Nästa: <strong>#${escapeHtml(String(nextScheduled.patrol.number ?? ''))} ${escapeHtml(nextScheduled.patrol.name || '')}</strong></div>
          <div class="ss-idle-time">kl. ${nextScheduled.scheduled.toLocaleTimeString('sv-SE',{hour:'2-digit',minute:'2-digit'})} · ${formatMs(msToNext)} till kort visas</div>
        ` : '<div class="ss-idle-next">Alla patruller har startat.</div>'}
      </div>
    `;
    currentPatrolId = null;
  } else {
    const p = active.patrol;
    const msToStart = active.scheduled - now;
    const go = msToStart <= 0 && now <= active.windowEnd;
    const goSeconds = Math.floor(Math.max(0, (active.windowEnd - now) / 1000));
    const countdownText = go
      ? (goSeconds > 0 ? `GÅ NU · ${goSeconds}s kvar` : 'GÅ NU')
      : formatMs(msToStart);

    // Re-render the card shell only when the active patrol changes
    if (currentPatrolId !== p.id) {
      currentPatrolId = p.id;
      mainEl.innerHTML = `
        <div class="ss-card" id="ss-card">
          <header class="ss-card-head">
            <div class="ss-card-eyebrow">
              <span class="ss-number">#${escapeHtml(String(p.number ?? ''))}</span>
              <span class="ss-avd">${escapeHtml(p.avdelning || '')}</span>
              ${p.kar ? `<span class="ss-kar">${escapeHtml(p.kar)}</span>` : ''}
            </div>
            <h1 class="ss-name">${escapeHtml(p.name || '')}</h1>
          </header>
          <div class="ss-card-body">
            <div class="ss-card-info">
              <div class="ss-meta">
                ${p.antal ? `<span class="ss-meta-pill">${p.antal} deltagare</span>` : ''}
              </div>
              <div class="ss-time-block">
                <div class="ss-time-label">Starttid</div>
                <div class="ss-time-value">${active.scheduled.toLocaleTimeString('sv-SE',{hour:'2-digit',minute:'2-digit'})}</div>
              </div>
              <div class="ss-count-block" id="ss-count-block">
                <div class="ss-count-label" id="ss-count-label">${go ? 'GÅ!' : 'Tid till start'}</div>
                <div class="ss-count-value" id="ss-count">${escapeHtml(countdownText)}</div>
              </div>
            </div>
            <div class="ss-card-right">
              <div class="ss-qr" id="ss-qr"></div>
              <div class="ss-qr-caption">Scanna för startkort</div>
            </div>
          </div>
        </div>
      `;
      // Render QR once per patrol
      const qrHost = document.getElementById('ss-qr');
      const qrKey = p.id;
      currentQrId = qrKey;
      renderQrToImg(startUrl(comp.id || comp, p.id), 440).then(img => {
        if (currentQrId !== qrKey) return;  // changed while loading
        qrHost.innerHTML = '';
        qrHost.appendChild(img);
      });
    } else {
      // Just update countdown + go-state
      const countEl = document.getElementById('ss-count');
      const labelEl = document.getElementById('ss-count-label');
      if (countEl) countEl.textContent = countdownText;
      if (labelEl) labelEl.textContent = go ? 'GÅ!' : 'Tid till start';
    }

    // Toggle GO state
    const card = document.getElementById('ss-card');
    if (card) card.classList.toggle('ss-go', go);
  }

  // Sidebar (wide screens) — next ~10 patruller with the first one prominent
  const sidebar = document.getElementById('ss-sidebar');
  if (!sidebarList.length) {
    sidebar.innerHTML = '<div class="ss-side-empty">Inga patruller kvar</div>';
  } else {
    sidebar.innerHTML = `
      <div class="ss-side-label">Kommande starter</div>
      <div class="ss-side-list">
        ${sidebarList.map((e, i) => {
          const time = e.scheduled.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
          const mins = Math.max(0, Math.round((e.scheduled - now) / 60000));
          const minsLabel = mins < 60 ? `om ${mins} min` : `om ${Math.floor(mins / 60)}h ${mins % 60}m`;
          return `
            <div class="ss-side-item ${i === 0 ? 'ss-side-next' : ''}">
              <div class="ss-side-time">${time}</div>
              <div class="ss-side-body">
                <div class="ss-side-patrol">
                  <span class="ss-side-no">#${escapeHtml(String(e.patrol.number ?? ''))}</span>
                  <span class="ss-side-name">${escapeHtml(e.patrol.name || '')}</span>
                </div>
                <div class="ss-side-sub">
                  ${escapeHtml(e.patrol.avdelning || '')}${e.patrol.kar ? ' · ' + escapeHtml(e.patrol.kar) : ''}
                </div>
                ${i === 0 ? `<div class="ss-side-countdown">${escapeHtml(minsLabel)}</div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // Footer strip — fallback for narrow screens (sidebar is hidden via CSS)
  const foot = document.getElementById('ss-foot');
  if (!upcoming.length) {
    foot.innerHTML = '<div class="ss-foot-empty">Inga patruller kvar att starta.</div>';
  } else {
    foot.innerHTML = `
      <div class="ss-foot-label">Nästa ut</div>
      <div class="ss-foot-list">
        ${upcoming.map(e => `
          <div class="ss-foot-item">
            <span class="ss-foot-time">${e.scheduled.toLocaleTimeString('sv-SE',{hour:'2-digit',minute:'2-digit'})}</span>
            <span class="ss-foot-no">#${escapeHtml(String(e.patrol.number ?? ''))}</span>
            <span class="ss-foot-name">${escapeHtml(e.patrol.name || '')}</span>
            ${e.patrol.kar ? `<span class="ss-foot-kar">· ${escapeHtml(e.patrol.kar)}</span>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }
}

function formatMs(ms) {
  if (ms == null || ms <= 0) return '00:00';
  const total = Math.round(ms / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  if (mm >= 60) {
    const hh = Math.floor(mm / 60);
    const mrest = mm % 60;
    return `${hh}:${String(mrest).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  }
  return `${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
}
