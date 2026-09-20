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

import { getCompetition, watchPatrols, ensureThreadToken, watchStartskarm, rensaStartskarm } from '../store.js';
import { db, doc, onSnapshot } from '../firebase.js';
import {
  escapeHtml, startTimeSettings, startUrl,
  isCompAdminUser, startskarmsSchema, paStartskarmen, startskarmExtra, startkortNyckel
} from '../utils.js';
import { renderQrToImg } from '../pdf.js';
import { icon } from '../icons.js';
import { updateBroadcast } from '../broadcast.js';

let unsubPatrols = null;
let unsubComp = null;
let unsubVisar = null;
let tickInterval = null;
// Nyckeln till det som STÅR på det stora kortet (startkortNyckel) — inte bara
// patrullens id. Kortet ritades förut om först när en ANNAN patrull blev
// aktiv, så ett namnbyte på patrullen som visades syntes inte förrän nästa.
let currentKortNyckel = null;
let currentQrId = null;
// Sekretariatets extra-visning: { patrolId, at } ur private/startskarm.
let ssVisar = null;
// renderWindow() ligger på MODULNIVÅ och ser inte renderStartScreen:s lokala
// variabler. Det som QR-koden behöver måste därför bo här — annars kastar
// kortritningen ReferenceError, och den enda synliga effekten är en tom
// QR-ruta (kastet sker före .catch-grenen som skulle visat felet).
let ssCid = null;
let ssTestMode = false;
const ssQrTokens = new Map();   // patrolId -> samtalstoken, en mintning per patrull
// QR-BILDEN sparas också: kortet ritas nu om när ett namn ändras, och utan
// cachen blinkade QR-koden till varje gång — mitt under en skanning.
const ssQrBilder = new Map();   // patrolId -> Promise<HTMLImageElement>

export async function renderStartScreen(app, user, cid) {
  stopWatches();

  ssCid = cid;
  ssQrTokens.clear();
  ssQrBilder.clear();
  ssVisar = null;
  let comp = await getCompetition(cid).catch(() => null);
  if (!comp) {
    app.innerHTML = `<div class="page"><div class="empty"><h3>Tävlingen hittades inte</h3></div></div>`;
    return;
  }
  // Demo competitions are open for exploration — anyone may watch the demo
  // startskärm (it only renders publicly readable start times).
  const isAdmin = isCompAdminUser(comp, user);
  if (!isAdmin && !comp.demo) {
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
          <div id="ss-test-badge" style="margin-top:6px;display:none;background:#E2E000;color:#003660;font-weight:800;font-size:12px;letter-spacing:.08em;padding:3px 10px;border-radius:999px;">TESTLÄGE — exempelpatruller tills riktiga finns</div>
        </div>
        <div class="ss-clock"><span id="ss-clock">—</span></div>
        <div class="ss-top-right">
          <button class="ss-btn" id="ss-fs" aria-label="Fullskärm">${icon('external', { size: 18 })}</button>
          <a class="ss-btn" id="ss-close" href="/app/c/${cid}" data-link title="Stäng startskärmen" aria-label="Stäng startskärmen">${icon('x', { size: 18 })}</a>
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

  // The startscreen is always opened in its own tab (target=_blank) — close
  // that tab instead of navigating it into a second parallel admin session.
  // Falls back to the href when the tab wasn't script-opened.
  document.getElementById('ss-close').addEventListener('click', (e) => {
    if (window.opener) {
      e.preventDefault();
      e.stopPropagation();
      window.close();
    }
  });

  // Live: competition (starttime settings can change) + patrols (order/add/remove)
  let patrols = [];
  // Test mode: no patrols yet → show example patrols on a schedule anchored
  // ~2 min from now, so the whole flow (countdown → GÅ → rotation) can be
  // previewed live before any patrols exist. Flips to real data the moment
  // real patrols arrive. The QR ids resolve to the /s/<cid>/test startkort.
  let testMode = false;
  let testAnchor = null; // 'HH:MM' first test start, fixed when armed
  const TEST_PATROLS = [
    { id: 'test',   number: 1, name: 'Testpatrullen',    avdelning: 'Spårare',    kar: 'Lindsdals Scoutkår', antal: 6, startOrder: 0 },
    { id: 'test-2', number: 2, name: 'Provpatrullen',    avdelning: 'Upptäckare', kar: 'Lindsdals Scoutkår', antal: 5, startOrder: 1 },
    { id: 'test-3', number: 3, name: 'Exempelpatrullen', avdelning: 'Äventyrare', kar: 'Lindsdals Scoutkår', antal: 7, startOrder: 2 }
  ];
  const bctx = { audience: 'patruller' }; // startskärmen är patrullernas yta
  unsubComp = onSnapshot(doc(db, 'competitions', cid), snap => {
    if (snap.exists()) { comp = { id: cid, ...snap.data() }; updateBroadcast(comp, bctx); tick(); }
  });
  updateBroadcast(comp, bctx);
  // Extra-visningen från patrullistan. Demot får ett tyst null (läsningen
  // kräver medlemskap), och då händer ingenting.
  unsubVisar = watchStartskarm(cid, v => { ssVisar = v; tick(); });
  unsubPatrols = watchPatrols(cid, rows => {
    testMode = rows.length === 0;
    if (testMode && !testAnchor) {
      const t = new Date(Date.now() + 2 * 60 * 1000);
      testAnchor = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    }
    patrols = testMode ? TEST_PATROLS : rows;
    ssTestMode = testMode;
    const badge = document.getElementById('ss-test-badge');
    if (badge) badge.style.display = testMode ? 'inline-block' : 'none';
    tick();
  });

  // 1 Hz tick — clock + window re-evaluation + countdown
  const tick = () => {
    const now = new Date();
    const clock = document.getElementById('ss-clock');
    if (!clock) return;
    clock.textContent =
      now.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    // Testläget rullar på dagens klocka — datumet måste bort, annars ankrar
    // patrolStartDateTime testschemat på den riktiga tävlingsdagen.
    const effComp = testMode
      ? { ...comp, date: null, startTimes: { enabled: true, mode: 'interval', firstStart: testAnchor, intervalMinutes: comp.startTimes?.intervalMinutes || 5 } }
      : comp;
    renderWindow(effComp, patrols, now);
  };
  tick();
  tickInterval = setInterval(tick, 1000);
}

function stopWatches() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  if (unsubPatrols) { unsubPatrols(); unsubPatrols = null; }
  if (unsubComp)    { unsubComp();    unsubComp = null; }
  if (unsubVisar)   { unsubVisar();   unsubVisar = null; }
  currentKortNyckel = null;
  currentQrId = null;
  ssVisar = null;
  updateBroadcast(null); // ta ner ev. driftmeddelande-banner vid SPA-navigering
}
// Export so the router can call it when navigating away.
export function teardownStartScreen() { stopWatches(); }

// --- Window logic ---------------------------------------------------------
// Fönstret räknas i utils.js (startskarmsSchema / paStartskarmen) — patrullistan
// visar "På startskärmen" med SAMMA beräkning, och får aldrig peka på en annan
// patrull än den som står här.
function renderWindow(comp, patrols, now) {
  const schedule = startskarmsSchema(comp, patrols, now);
  if (!schedule.length) {
    document.getElementById('ss-main').innerHTML = `<div class="ss-loading">Inga patruller att visa.</div>`;
    document.getElementById('ss-foot').innerHTML = '';
    currentKortNyckel = null;
    return;
  }

  // Active = patrol whose visibility window contains now. Pick the latest if
  // multiple overlap (shouldn't happen with default window sizing, but be safe).
  const active = paStartskarmen(schedule, now);
  // Anything not yet out, excluding whoever is currently "active" (already on screen)
  const upcomingAll = schedule.filter(e => e.scheduled > now && e !== active);
  const upcoming = upcomingAll.slice(0, 4);           // bottom strip (narrow screens)
  const sidebarList = upcomingAll.slice(0, 10);       // left column (wide screens)

  // Main card
  const mainEl = document.getElementById('ss-main');
  const tid = (d) => d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  const msToStart = active ? active.scheduled - now : null;
  const go = !!active && msToStart <= 0 && now <= active.windowEnd;
  const goSeconds = active ? Math.floor(Math.max(0, (active.windowEnd - now) / 1000)) : 0;
  const countdownText = !active ? '' : go
    ? (goSeconds > 0 ? `GÅ NU · ${goSeconds}s kvar` : 'GÅ NU')
    : formatMs(msToStart);

  // QR-koden: token EN gång per patrull, bilden EN gång per patrull. Kortet
  // ritas om varje gång ett namn ändras, och startskärmen tickar varje sekund —
  // utan cacharna vore det en skrivning per sekund och en blinkande kod.
  // Testpatrullerna (tom lista → TEST_PATROLS) har inga riktiga id:n och får
  // aldrig mintas.
  const ritaQr = (p) => {
    const qrHost = document.getElementById('ss-qr');
    const qrKey = p.id;
    currentQrId = qrKey;
    if (!ssQrBilder.has(p.id)) {
      const tokenLöfte = (ssTestMode || !ssCid)
        ? Promise.resolve('')
        : (ssQrTokens.has(p.id)
            ? Promise.resolve(ssQrTokens.get(p.id))
            : ensureThreadToken(ssCid, 'patrull', p.id).catch(() => '')
                .then(tok => { ssQrTokens.set(p.id, tok || ''); return tok || ''; }));
      ssQrBilder.set(p.id, tokenLöfte.then(tok => renderQrToImg(startUrl(comp.id || comp, p.id, tok), 440)));
    }
    ssQrBilder.get(p.id).then(img => {
      if (currentQrId !== qrKey || !qrHost.isConnected) return;  // changed while loading
      qrHost.innerHTML = '';
      qrHost.appendChild(img);
    }).catch(() => {
      ssQrBilder.delete(p.id);
      if (currentQrId === qrKey) qrHost.innerHTML = '<span style="opacity:.6;">QR-koden kunde inte laddas</span>';
    });
  };
  const kortHuvud = (p) => `
          <header class="ss-card-head">
            <div class="ss-card-eyebrow">
              <span class="ss-number">#${escapeHtml(String(p.number ?? ''))}</span>
              <span class="ss-avd">${escapeHtml(p.avdelning || '')}</span>
              ${p.kar ? `<span class="ss-kar">${escapeHtml(p.kar)}</span>` : ''}
            </div>
            <h1 class="ss-name">${escapeHtml(p.name || '')}</h1>
          </header>`;

  // EXTRA: sekretariatet har lagt en patrulls kort över schemat (patrullistan →
  // "Visa på startskärmen"). Ingen nedräkning — patrullen är redan sen eller
  // tidig, och en klocka som räknar mot en passerad tid säger bara fel sak.
  // Schemat går vidare under: den som står i tur syns i remsan längst ner på
  // kortet, så ingen missar sitt GÅ NU för att någon annan visas.
  const extra = ssTestMode ? null : startskarmExtra(ssVisar, patrols, now);
  if (extra) {
    const egen = schedule.find(e => e.patrol.id === extra.id);
    const nyckel = 'extra:' + startkortNyckel(extra, egen?.scheduled || null);
    if (currentKortNyckel !== nyckel) {
      currentKortNyckel = nyckel;
      mainEl.innerHTML = `
        <div class="ss-card ss-extra" id="ss-card">
          <div class="ss-extra-rad">
            <span class="ss-extra-etikett">Visas av sekretariatet</span>
            <button type="button" class="ss-btn ss-extra-stang" id="ss-extra-stang">${icon('x', { size: 16 })} Tillbaka till schemat</button>
          </div>
          ${kortHuvud(extra)}
          <div class="ss-card-body">
            <div class="ss-card-info">
              <div class="ss-meta">
                ${extra.antal ? `<span class="ss-meta-pill">${extra.antal} deltagare</span>` : ''}
              </div>
              ${egen ? `<div class="ss-time-block">
                <div class="ss-time-label">Ordinarie starttid</div>
                <div class="ss-time-value">${tid(egen.scheduled)}</div>
              </div>` : ''}
              <div class="ss-count-block">
                <div class="ss-count-label">Skanna koden</div>
                <div class="ss-count-value ss-extra-text">och gå när ni är klara</div>
              </div>
            </div>
            <div class="ss-card-right">
              <div class="ss-qr" id="ss-qr"></div>
              <div class="ss-qr-caption">Scanna för startkort</div>
            </div>
          </div>
          <div class="ss-extra-schema" id="ss-extra-schema"></div>
        </div>`;
      document.getElementById('ss-extra-stang').addEventListener('click', () => {
        ssVisar = null;                       // direkt på den här skärmen …
        rensaStartskarm(ssCid).catch(() => {}); // … och för alla andra
      });
      ritaQr(extra);
    }
    const remsa = document.getElementById('ss-extra-schema');
    if (remsa) {
      remsa.classList.toggle('ss-go', go);
      remsa.innerHTML = active && active.patrol.id !== extra.id
        ? `<span class="ss-extra-schema-etikett">Enligt schemat</span>
           <strong>#${escapeHtml(String(active.patrol.number ?? ''))} ${escapeHtml(active.patrol.name || '')}</strong>
           <span>${tid(active.scheduled)}</span>
           <span class="ss-extra-schema-tid">${escapeHtml(countdownText)}</span>`
        : '';
      remsa.hidden = !remsa.innerHTML;
    }
  } else if (!active) {
    // Between windows — show a soft "waiting" state
    const nextScheduled = upcoming[0];
    const msToNext = nextScheduled ? Math.max(0, nextScheduled.windowStart - now) : null;
    mainEl.innerHTML = `
      <div class="ss-idle">
        <div class="ss-idle-label">Väntar på nästa patrull</div>
        ${nextScheduled ? `
          <div class="ss-idle-next">Nästa: <strong>#${escapeHtml(String(nextScheduled.patrol.number ?? ''))} ${escapeHtml(nextScheduled.patrol.name || '')}</strong></div>
          <div class="ss-idle-time">kl. ${tid(nextScheduled.scheduled)} · ${formatMs(msToNext)} till kort visas</div>
        ` : '<div class="ss-idle-next">Alla patruller har startat.</div>'}
      </div>
    `;
    currentKortNyckel = null;
  } else {
    const p = active.patrol;
    // Rita om kortet när det som STÅR på det ändras — en annan patrull, men
    // också ett nytt namn, en ny kår eller en flyttad starttid.
    const nyckel = startkortNyckel(p, active.scheduled);
    if (currentKortNyckel !== nyckel) {
      currentKortNyckel = nyckel;
      mainEl.innerHTML = `
        <div class="ss-card" id="ss-card">
          ${kortHuvud(p)}
          <div class="ss-card-body">
            <div class="ss-card-info">
              <div class="ss-meta">
                ${p.antal ? `<span class="ss-meta-pill">${p.antal} deltagare</span>` : ''}
              </div>
              <div class="ss-time-block">
                <div class="ss-time-label">Starttid</div>
                <div class="ss-time-value">${tid(active.scheduled)}</div>
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
      ritaQr(p);
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
