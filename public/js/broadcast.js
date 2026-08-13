// Driftmeddelande (broadcast) — shared banner for the field pages (/k, /s,
// /m) and the startskärm. The competition doc carries
//   broadcast: {
//     text, level: 'info' | 'varning' | 'kritisk', at: ISO,
//     target: { kontroller: true | [ctrlId] | false,
//               patruller:  true | [patrolId] | false }
//   }
// (admin-written via the Läget composer, world-readable like the rest of the
// competition meta — the composer reminds admins to never put personal data
// in it). A missing target means everyone. Pages that subscribe to the
// competition doc call updateBroadcast(comp, ctx) on every snapshot with
// their audience context; the banner mounts/updates/removes itself at the
// top of the page and only renders when the message targets that audience.
//
// 'kritisk' also ALARMS: vibration + a beep sequence via WebAudio. Browsers
// only allow audio after a user gesture, so the AudioContext is armed on the
// first pointerdown — on the reporter/station pages the funktionär has
// always interacted long before an alarm arrives. The alarm fires only when
// a NEW kritisk message lands while the page is open (not for one already
// active at load, which autoplay policy would block anyway).

import { escapeHtml } from './utils.js';
import { haptic } from './haptic.js';

const LEVELS = {
  info:    { label: 'Information' },
  varning: { label: 'Varning' },
  kritisk: { label: 'Kritisk information' }
};

let lastAt;             // undefined until first updateBroadcast call
let stylesInjected = false;
let audioCtx = null;

// Arm audio on the first user gesture anywhere on the page.
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
  // Two rounds of three rising beeps — distinct from any notification sound.
  for (const round of [0, 1200]) {
    beep(round, 660); beep(round + 250, 880); beep(round + 500, 1100, 320);
  }
}

function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const st = document.createElement('style');
  st.textContent = `
    .eskil-broadcast {
      position: fixed; top: 0; left: 0; right: 0; z-index: 900;
      display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
      padding: 12px 16px;
      font-family: "Libre Franklin", -apple-system, Helvetica, Arial, sans-serif;
      font-size: 15px; line-height: 1.4;
      box-shadow: 0 2px 12px rgba(0,0,0,.25);
    }
    .eskil-broadcast .eb-label {
      font-size: 11px; font-weight: 800; letter-spacing: .12em;
      text-transform: uppercase; white-space: nowrap;
      padding: 2px 8px; border-radius: 999px;
      background: rgba(0,0,0,.18);
    }
    .eskil-broadcast .eb-text { font-weight: 600; flex: 1 1 200px; white-space: pre-wrap; }
    .eskil-broadcast .eb-time { font-size: 12px; opacity: .8; white-space: nowrap; }
    .eskil-broadcast.eb-info    { background: #003660; color: #ffffff; }
    .eskil-broadcast.eb-varning { background: #E2E000; color: #003660; }
    .eskil-broadcast.eb-varning .eb-label { background: rgba(0,54,96,.15); }
    .eskil-broadcast.eb-kritisk { background: #DA005E; color: #ffffff; animation: eb-pulse 1.2s ease-in-out infinite; }
    @keyframes eb-pulse {
      0%, 100% { filter: brightness(1); }
      50%      { filter: brightness(1.35); }
    }
    @media (prefers-reduced-motion: reduce) {
      .eskil-broadcast.eb-kritisk { animation: none; }
    }
    /* Night mode (reporter/startkort red palette) — keep night vision but
       let kritisk stay unmistakably alarming. */
    html[data-mode="night"] .eskil-broadcast.eb-info    { background: #2a0d0d; color: #ff8a80; box-shadow: 0 2px 12px rgba(0,0,0,.6); }
    html[data-mode="night"] .eskil-broadcast.eb-varning { background: #5c1a00; color: #ffb38a; }
    html[data-mode="night"] .eskil-broadcast.eb-varning .eb-label { background: rgba(255,138,128,.18); }
    html[data-mode="night"] .eskil-broadcast.eb-kritisk { background: #c8102e; color: #ffffff; }
  `;
  document.head.appendChild(st);
}

// ctx: { audience: 'kontroll', id } for /k, { audience: 'patrull', id } for
// /s, { audience: 'kontroller' } for the station (funktionärsytan) and
// { audience: 'patruller' } for the startskärm (patrullytan).
function targetsUs(b, ctx) {
  const t = b.target;
  if (!t || !ctx) return true; // legacy shape or untargeted page → everyone
  const k = t.kontroller, p = t.patruller;
  const someK = k === true || (Array.isArray(k) && k.length > 0);
  const someP = p === true || (Array.isArray(p) && p.length > 0);
  switch (ctx.audience) {
    case 'kontroll':   return k === true || (Array.isArray(k) && k.includes(ctx.id));
    case 'patrull':    return p === true || (Array.isArray(p) && p.includes(ctx.id));
    case 'kontroller': return someK; // stationen följer funktionärskanalen
    case 'patruller':  return someP; // startskärmen följer patrullkanalen
  }
  return true;
}

export function updateBroadcast(comp, ctx = null) {
  const b = comp?.broadcast;
  let el = document.getElementById('eskil-broadcast');

  if (!b || !(b.text || '').trim() || !targetsUs(b, ctx)) {
    lastAt = null;
    if (el) {
      el.remove();
      document.body.style.removeProperty('padding-top');
    }
    return;
  }

  ensureStyles();
  const level = LEVELS[b.level] ? b.level : 'info';
  if (!el) {
    el = document.createElement('div');
    el.id = 'eskil-broadcast';
    el.setAttribute('role', 'alert');
    document.body.prepend(el);
  }
  el.className = `eskil-broadcast eb-${level}`;
  const time = b.at ? new Date(b.at).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }) : '';
  el.innerHTML = `
    <span class="eb-label">${LEVELS[level].label}</span>
    <span class="eb-text">${escapeHtml(b.text)}</span>
    ${time ? `<span class="eb-time">kl ${time}</span>` : ''}
  `;
  // Push the page content down so the banner never covers anything.
  document.body.style.paddingTop = el.offsetHeight + 'px';

  // Alarm only when a NEW kritisk message arrives while the page is open.
  if (level === 'kritisk' && lastAt !== undefined && lastAt !== null && b.at !== lastAt) alarm();
  lastAt = b.at || '';
}
