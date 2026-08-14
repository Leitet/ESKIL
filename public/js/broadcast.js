// Meddelanden (broadcast v2) — stackade driftmeddelanden för fältsidorna
// (/k, /s, /m) och startskärmen, med notisklocka och kvittensflöde.
//
// Datamodell: competitions/{cid}/messages/{msgId}
//   { text, level: 'info'|'varning'|'kritisk', at: ISO,
//     target: { kontroller: true|[ctrlId]|false, patruller: true|[patrolId]|false },
//     requireAck: bool, active: bool }
// skrivna från Meddelanden-fliken (admin), publikt läsbara (fältsidorna är
// anonyma — composern varnar för personuppgifter). Meddelanden med
// requireAck samlar kvittenser i messages/{id}/acks — den här modulen
// stämplar "mottaget" (seenAt) automatiskt när bannern visas och
// "bekräftat" (ackAt) när funktionären trycker Bekräfta.
//
// Sidintegration (oförändrad från v1): sidorna anropar
// updateBroadcast(comp, ctx) på varje comp-snapshot. Modulen startar själv
// prenumerationen på messages-kollektionen första gången (cid ur comp.id)
// och renderar därefter live. Det gamla comp.broadcast-fältet renderas
// fortfarande som ett meddelande i stacken tills det rensas.
//
// ctx: { audience: 'kontroll'|'patrull'|'kontroller'|'patruller', id? }
//   /k:          { audience: 'kontroll',   id: ctrlId }
//   /s:          { audience: 'patrull',    id: patrolId }
//   /m:          { audience: 'kontroller', id: stationId }  (kvitterar som "station")
//   startskärm:  { audience: 'patruller' }                  (visning, ingen kvittens/klocka)
//
// 'kritisk' ALARMS: vibration + stigande pip via WebAudio (armas på första
// pointerdown — autoplay-policy). Larmet gäller bara NYA kritiska meddelanden
// som landar medan sidan är öppen, inte sådana som redan var aktiva vid load.
//
// PWA-notiser: när Notification-behörighet beviljats (via klockans panel)
// visas systemnotiser för nya meddelanden när fliken ligger i bakgrunden —
// via service workerns showNotification så det fungerar även på Android.
// Riktig server-push (FCM) är nästa steg; behörighetsflödet här är grunden.

import { escapeHtml } from './utils.js';
import { haptic } from './haptic.js';
import { db, collection, onSnapshot } from './firebase.js';
import { ackBroadcastMessage } from './store.js';

const LEVELS = {
  info:    { label: 'Information',        weight: 2 },
  varning: { label: 'Varning',            weight: 1 },
  kritisk: { label: 'Kritisk information', weight: 0 }
};

// --- Modulstate ---------------------------------------------------------------
let cid = null;
let ctx = null;
let legacy = null;            // comp.broadcast (gamla fältet)
let msgs = [];                // alla messages-dokument (live)
let subStarted = false;
let firstSnapshotDone = false;
let stylesInjected = false;
let audioCtx = null;
let panelOpen = false;
let legacyLastAt;             // för legacy-larmet (at-ändring)

// --- Lokalt minne (per tävling + identitet) -----------------------------------
// { [msgId]: { seenAt, ackAt?, hidden?, seenSynced?, text, level, at } }
// Textkopian gör att klockan kan visa historik även för raderade meddelanden.
function storeKey() {
  return `eskil.msg.${cid}.${ctx?.audience || 'x'}.${ctx?.id || '-'}`;
}
function loadLocal() {
  try { return JSON.parse(localStorage.getItem(storeKey()) || '{}'); } catch { return {}; }
}
function saveLocal(state) {
  // Cap: behåll de 30 senaste per at-tid så nyckeln inte växer för evigt.
  const ids = Object.keys(state);
  if (ids.length > 30) {
    ids.sort((a, b) => String(state[b].at || '').localeCompare(String(state[a].at || '')));
    for (const id of ids.slice(30)) delete state[id];
  }
  try { localStorage.setItem(storeKey(), JSON.stringify(state)); } catch { /* privat läge */ }
}

// --- Larm (oförändrat från v1) ------------------------------------------------
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch { /* no audio available — vibration still works */ }
  }, { passive: true });
}

function beep(atMs, freq = 880, durMs = 180) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime + atMs / 1000;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + durMs / 1000);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + durMs / 1000 + 0.05);
}

function alarm() {
  haptic([250, 120, 250, 120, 500]);
  for (const round of [0, 1200]) {
    beep(round, 660); beep(round + 250, 880); beep(round + 500, 1100, 320);
  }
}

// --- Målgruppsmatchning (oförändrad semantik) ---------------------------------
function targetsUs(m) {
  const t = m.target;
  if (!t || !ctx) return true;
  const k = t.kontroller, p = t.patruller;
  const someK = k === true || (Array.isArray(k) && k.length > 0);
  const someP = p === true || (Array.isArray(p) && p.length > 0);
  switch (ctx.audience) {
    case 'kontroll':   return k === true || (Array.isArray(k) && k.includes(ctx.id));
    case 'patrull':    return p === true || (Array.isArray(p) && p.includes(ctx.id));
    case 'kontroller': return someK;
    case 'patruller':  return someP;
  }
  return true;
}

// Kvittensidentitet: vem den här klienten är i acks-dokumenten.
function ackIdentity() {
  if (!ctx?.id) return null;
  if (ctx.audience === 'kontroll') return { kind: 'kontroll', refId: ctx.id };
  if (ctx.audience === 'patrull') return { kind: 'patrull', refId: ctx.id };
  if (ctx.audience === 'kontroller') return { kind: 'station', refId: ctx.id };
  return null;
}

function fmtTime(at) {
  if (!at) return '';
  const d = new Date(at);
  return isNaN(d) ? '' : d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}

// --- Styles -------------------------------------------------------------------
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const st = document.createElement('style');
  st.textContent = `
    #eskil-broadcast {
      position: fixed; top: 0; left: 0; right: 0; z-index: 900;
      display: flex; flex-direction: column;
    }
    .eb-msg {
      display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
      padding: 11px 16px;
      font-family: "Libre Franklin", -apple-system, Helvetica, Arial, sans-serif;
      font-size: 15px; line-height: 1.4;
      box-shadow: 0 2px 12px rgba(0,0,0,.25);
    }
    .eb-msg .eb-label {
      font-size: 11px; font-weight: 800; letter-spacing: .12em;
      text-transform: uppercase; white-space: nowrap;
      padding: 2px 8px; border-radius: 999px;
      background: rgba(0,0,0,.18);
    }
    .eb-msg .eb-text { font-weight: 600; flex: 1 1 200px; white-space: pre-wrap; }
    .eb-msg .eb-time { font-size: 12px; opacity: .8; white-space: nowrap; }
    .eb-msg .eb-ack, .eb-msg .eb-hide {
      font: inherit; font-size: 13px; font-weight: 700;
      border: 1.5px solid currentColor; background: rgba(255,255,255,.12);
      color: inherit; border-radius: 999px; padding: 4px 14px; cursor: pointer;
      white-space: nowrap;
    }
    .eb-msg .eb-hide { border-color: transparent; background: none; opacity: .7; padding: 4px 8px; }
    .eb-msg .eb-acked { font-size: 13px; font-weight: 700; white-space: nowrap; opacity: .9; }
    .eb-info    { background: #003660; color: #ffffff; }
    .eb-varning { background: #E2E000; color: #003660; }
    .eb-varning .eb-label { background: rgba(0,54,96,.15); }
    .eb-varning .eb-ack { background: rgba(0,54,96,.08); }
    .eb-kritisk { background: #DA005E; color: #ffffff; animation: eb-pulse 1.2s ease-in-out infinite; }
    @keyframes eb-pulse {
      0%, 100% { filter: brightness(1); }
      50%      { filter: brightness(1.35); }
    }
    @media (prefers-reduced-motion: reduce) { .eb-kritisk { animation: none; } }
    html[data-mode="night"] .eb-info    { background: #2a0d0d; color: #ff8a80; box-shadow: 0 2px 12px rgba(0,0,0,.6); }
    html[data-mode="night"] .eb-varning { background: #5c1a00; color: #ffb38a; }
    html[data-mode="night"] .eb-varning .eb-label { background: rgba(255,138,128,.18); }
    html[data-mode="night"] .eb-kritisk { background: #c8102e; color: #ffffff; }

    /* Notisklockan — sitter bredvid Nattläge-knappen där den finns. */
    #eskil-bell {
      position: absolute; top: 12px; z-index: 60;
      background: var(--r-card, #fff);
      border: 1.5px solid var(--r-border, #d8d8d8);
      color: var(--r-fg, #282727);
      border-radius: 999px;
      width: 38px; height: 38px;
      display: inline-flex; align-items: center; justify-content: center;
      cursor: pointer; font-size: 17px;
    }
    #eskil-bell .eb-badge {
      position: absolute; top: -5px; right: -5px;
      min-width: 18px; height: 18px; border-radius: 999px;
      background: #DA005E; color: #fff;
      font: 800 11px/18px "Libre Franklin", Helvetica, Arial, sans-serif;
      text-align: center; padding: 0 4px;
    }
    #eskil-bell-panel {
      position: absolute; z-index: 950;
      top: 56px; right: 12px;
      width: min(360px, calc(100vw - 24px));
      max-height: 60vh; overflow-y: auto;
      background: var(--r-card, #fff);
      color: var(--r-fg, #282727);
      border: 1.5px solid var(--r-border, #d8d8d8);
      border-radius: 14px;
      box-shadow: 0 8px 30px rgba(0,0,0,.25);
      font-family: "Libre Franklin", -apple-system, Helvetica, Arial, sans-serif;
    }
    #eskil-bell-panel .ebp-head {
      padding: 12px 16px 8px; font-weight: 800; font-size: 14px;
      display: flex; justify-content: space-between; align-items: center;
    }
    #eskil-bell-panel .ebp-empty { padding: 8px 16px 16px; font-size: 13.5px; opacity: .7; }
    #eskil-bell-panel .ebp-row {
      padding: 10px 16px; border-top: 1px solid var(--r-border, #eee);
      font-size: 13.5px; line-height: 1.45;
    }
    #eskil-bell-panel .ebp-meta { display: flex; gap: 8px; align-items: center; font-size: 11.5px; opacity: .75; margin-bottom: 2px; }
    #eskil-bell-panel .ebp-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
    #eskil-bell-panel .ebp-dot.info { background: #003660; }
    #eskil-bell-panel .ebp-dot.varning { background: #E2B100; }
    #eskil-bell-panel .ebp-dot.kritisk { background: #DA005E; }
    #eskil-bell-panel .ebp-status { font-size: 12px; font-weight: 700; margin-top: 3px; }
    #eskil-bell-panel .ebp-ackbtn {
      font: inherit; font-size: 12.5px; font-weight: 700;
      border: 1.5px solid var(--r-border, #d8d8d8); background: none; color: inherit;
      border-radius: 999px; padding: 3px 12px; cursor: pointer; margin-top: 4px;
    }
    #eskil-bell-panel .ebp-notif {
      padding: 12px 16px; border-top: 1.5px solid var(--r-border, #eee);
      font-size: 12.5px;
    }
    #eskil-bell-panel .ebp-notif button {
      font: inherit; font-weight: 700; font-size: 12.5px;
      border: 1.5px solid var(--r-border, #d8d8d8); background: none; color: inherit;
      border-radius: 999px; padding: 5px 14px; cursor: pointer;
    }
    html[data-mode="night"] #eskil-bell, html[data-mode="night"] #eskil-bell-panel {
      background: #1a0808; border-color: #5c1a1a; color: #ff8a80;
    }
  `;
  document.head.appendChild(st);
}

// --- Systemnotiser (PWA-förberedelse) -----------------------------------------
function canNotify() { return typeof Notification !== 'undefined'; }

async function showSystemNotification(m) {
  if (!canNotify() || Notification.permission !== 'granted') return;
  const title = `${LEVELS[m.level]?.label || 'Meddelande'} — tävlingsledningen`;
  const opts = { body: m.text, tag: `eskil-msg-${m.id}` };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg?.showNotification) { reg.showNotification(title, opts); return; }
  } catch { /* faller tillbaka nedan */ }
  try { new Notification(title, opts); } catch { /* Android kräver SW-vägen */ }
}

// --- Aktiva meddelanden för den här klienten ----------------------------------
function activeMsgs() {
  const list = msgs.filter(m => m.active !== false && (m.text || '').trim() && targetsUs(m));
  if (legacy && (legacy.text || '').trim() && targetsUs(legacy)) {
    list.push({ id: 'legacy', ...legacy, requireAck: false, active: true });
  }
  return list.sort((a, b) =>
    (LEVELS[a.level]?.weight ?? 2) - (LEVELS[b.level]?.weight ?? 2)
    || String(b.at || '').localeCompare(String(a.at || '')));
}

// --- Render -------------------------------------------------------------------
function render() {
  if (!cid) return;
  ensureStyles();
  const local = loadLocal();
  const identity = ackIdentity();
  const act = activeMsgs();
  let dirty = false;

  // Stäpla lokalt "sett" + synka mottagningskvittens för requireAck.
  const nowIso = new Date().toISOString();
  for (const m of act) {
    const st = local[m.id] || (local[m.id] = {});
    if (!st.seenAt) { st.seenAt = nowIso; dirty = true; }
    // Textkopia till klockans historik (överlever radering).
    if (st.text !== m.text || st.level !== m.level) {
      st.text = m.text; st.level = m.level; st.at = m.at; dirty = true;
    }
    if (m.requireAck && identity && m.id !== 'legacy' && !st.seenSynced) {
      st.seenSynced = true; dirty = true;
      ackBroadcastMessage(cid, m.id, identity.kind, identity.refId, 'seen')
        .catch(() => { st.seenSynced = false; saveLocal(local); });
    }
  }
  if (dirty) saveLocal(local);

  // --- Bannerstacken ---
  const visible = act.filter(m => !local[m.id]?.hidden);
  let host = document.getElementById('eskil-broadcast');
  if (!visible.length) {
    if (host) { host.remove(); document.body.style.removeProperty('padding-top'); }
  } else {
    if (!host) {
      host = document.createElement('div');
      host.id = 'eskil-broadcast';
      host.setAttribute('role', 'alert');
      document.body.prepend(host);
    }
    host.innerHTML = visible.map(m => {
      const level = LEVELS[m.level] ? m.level : 'info';
      const st = local[m.id] || {};
      const needsAck = m.requireAck && identity && m.id !== 'legacy';
      return `<div class="eb-msg eb-${level}" data-msg="${escapeHtml(m.id)}">
        <span class="eb-label">${LEVELS[level].label}</span>
        <span class="eb-text">${escapeHtml(m.text)}</span>
        ${m.at ? `<span class="eb-time">kl ${fmtTime(m.at)}</span>` : ''}
        ${needsAck
          ? (st.ackAt
              ? `<span class="eb-acked">✓ Bekräftat ${fmtTime(st.ackAt)}</span>`
              : `<button type="button" class="eb-ack" data-ack="${escapeHtml(m.id)}">Bekräfta mottaget</button>`)
          : ''}
        ${(!needsAck || st.ackAt) ? `<button type="button" class="eb-hide" data-hide="${escapeHtml(m.id)}" aria-label="Dölj meddelandet (finns kvar i klockan)">✕</button>` : ''}
      </div>`;
    }).join('');
    document.body.style.paddingTop = host.offsetHeight + 'px';

    host.querySelectorAll('[data-ack]').forEach(b => b.addEventListener('click', () => doAck(b.dataset.ack)));
    host.querySelectorAll('[data-hide]').forEach(b => b.addEventListener('click', () => {
      const l = loadLocal();
      (l[b.dataset.hide] ||= {}).hidden = true;
      saveLocal(l);
      render();
    }));
  }

  renderBell(act, local, identity);
}

function doAck(msgId) {
  const identity = ackIdentity();
  if (!identity) return;
  const local = loadLocal();
  const st = local[msgId] || (local[msgId] = {});
  st.ackAt = new Date().toISOString();
  saveLocal(local);
  haptic([12, 40, 12]);
  ackBroadcastMessage(cid, msgId, identity.kind, identity.refId, 'ack').catch(() => { /* offlinekö tar den */ });
  // Kvitterade banners viker undan av sig själva efter en stund.
  setTimeout(() => {
    const l = loadLocal();
    if (l[msgId]?.ackAt) { l[msgId].hidden = true; saveLocal(l); render(); }
  }, 2500);
  render();
}

// --- Klockan ------------------------------------------------------------------
function renderBell(act, local, identity) {
  // Bara på sidor med en kvittensidentitet (/k, /s, /m) — startskärmen är en
  // projektor och behöver ingen klocka.
  if (!identity) return;
  let bell = document.getElementById('eskil-bell');
  if (!bell) {
    bell = document.createElement('button');
    bell.id = 'eskil-bell';
    bell.type = 'button';
    bell.setAttribute('aria-label', 'Meddelanden från tävlingsledningen');
    bell.textContent = '🔔';
    // Bredvid Nattläge-knappen där den finns, annars i högerkanten.
    bell.style.right = document.querySelector('.mode-toggle') ? '64px' : '12px';
    document.body.appendChild(bell);
    bell.addEventListener('click', () => { panelOpen = !panelOpen; render(); });
  }
  const needAction = act.filter(m => m.requireAck && m.id !== 'legacy' && !local[m.id]?.ackAt).length;
  bell.innerHTML = `🔔${needAction ? `<span class="eb-badge">${needAction}</span>` : ''}`;

  let panel = document.getElementById('eskil-bell-panel');
  if (!panelOpen) { panel?.remove(); return; }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'eskil-bell-panel';
    document.body.appendChild(panel);
  }

  // Historik: allt vi sett lokalt (textkopior) + aktiva — nyast först.
  const activeIds = new Set(act.map(m => m.id));
  const rows = Object.entries(local)
    .filter(([, st]) => st.seenAt && (st.text || '').trim())
    .sort(([, a], [, b]) => String(b.at || b.seenAt || '').localeCompare(String(a.at || a.seenAt || '')))
    .slice(0, 20);

  panel.innerHTML = `
    <div class="ebp-head"><span>Meddelanden</span><button type="button" class="eb-hide" id="ebp-close" aria-label="Stäng">✕</button></div>
    ${rows.length ? rows.map(([id, st]) => {
      const m = act.find(x => x.id === id);
      const level = LEVELS[st.level] ? st.level : 'info';
      const needsAck = m?.requireAck && !st.ackAt && id !== 'legacy';
      return `<div class="ebp-row">
        <div class="ebp-meta">
          <span class="ebp-dot ${level}"></span>
          <span>${LEVELS[level].label}</span>
          <span>·</span><span>kl ${fmtTime(st.at || st.seenAt)}</span>
          ${!activeIds.has(id) ? '<span>· avslutat</span>' : ''}
        </div>
        <div>${escapeHtml(st.text)}</div>
        ${st.ackAt ? `<div class="ebp-status">✓ Bekräftat ${fmtTime(st.ackAt)}</div>` : ''}
        ${needsAck ? `<button type="button" class="ebp-ackbtn" data-ack="${escapeHtml(id)}">Bekräfta mottaget</button>` : ''}
      </div>`;
    }).join('') : '<div class="ebp-empty">Inga meddelanden ännu. Här samlas allt tävlingsledningen skickar ut.</div>'}
    ${canNotify() ? `<div class="ebp-notif">${
      Notification.permission === 'granted'
        ? 'Notiser är aktiva på den här enheten ✓'
        : Notification.permission === 'denied'
          ? 'Notiser är blockerade i webbläsarens inställningar.'
          : '<button type="button" id="ebp-enable-notif">Aktivera notiser på den här enheten</button><div style="opacity:.7;margin-top:6px;">Då syns nya meddelanden även när skärmen visar något annat.</div>'
    }</div>` : ''}
  `;
  panel.querySelector('#ebp-close').addEventListener('click', () => { panelOpen = false; render(); });
  panel.querySelectorAll('[data-ack]').forEach(b => b.addEventListener('click', () => doAck(b.dataset.ack)));
  panel.querySelector('#ebp-enable-notif')?.addEventListener('click', async () => {
    try { await Notification.requestPermission(); } catch { /* äldre callback-API */ }
    render();
  });
}

// --- Prenumeration ------------------------------------------------------------
let unsubMsgs = null;
function ensureSubscription() {
  if (subStarted || !cid) return;
  subStarted = true;
  let prevIds = null;
  unsubMsgs = onSnapshot(collection(db, 'competitions', cid, 'messages'), snap => {
    msgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const act = activeMsgs();
    if (firstSnapshotDone && prevIds) {
      const fresh = act.filter(m => m.id !== 'legacy' && !prevIds.has(m.id));
      if (fresh.some(m => m.level === 'kritisk')) alarm();
      if (document.hidden) fresh.forEach(m => showSystemNotification(m));
    }
    prevIds = new Set(act.map(m => m.id));
    firstSnapshotDone = true;
    render();
  });
}

// --- Publikt API (samma som v1) -----------------------------------------------

// Full nedmontering — används när startskärmen (som bor i admin-SPA:n)
// lämnas via SPA-navigering, så banners/klocka/prenumeration inte hänger
// kvar på nästa vy. Fältsidorna (egna dokument) behöver aldrig anropa den.
export function teardownBroadcast() {
  try { unsubMsgs?.(); } catch { /* redan nere */ }
  unsubMsgs = null; subStarted = false; firstSnapshotDone = false;
  msgs = []; legacy = null; legacyLastAt = undefined; panelOpen = false;
  cid = null; ctx = null;
  document.getElementById('eskil-broadcast')?.remove();
  document.getElementById('eskil-bell')?.remove();
  document.getElementById('eskil-bell-panel')?.remove();
  document.body.style.removeProperty('padding-top');
}

export function updateBroadcast(comp, newCtx = null) {
  if (comp === null && !newCtx) { teardownBroadcast(); return; }
  if (newCtx) ctx = newCtx;
  cid = comp?.id || ctx?.cid || cid;
  const b = comp?.broadcast;
  legacy = b && (b.text || '').trim() ? b : null;
  // Legacy-larmet: nytt/ändrat kritiskt meddelande i gamla fältet.
  if (legacy && legacy.level === 'kritisk' && legacyLastAt !== undefined
      && legacyLastAt !== null && legacy.at !== legacyLastAt && targetsUs(legacy)) alarm();
  legacyLastAt = legacy ? (legacy.at || '') : null;
  ensureSubscription();
  render();
}
