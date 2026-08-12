// Main SPA shell. Waits for Firebase auth, then renders either the login
// splash or the authenticated app.

import {
  watchAuth, doSignOut,
  pendingMagicLink, savedSigninEmail, completeMagicLink, clearMagicLinkParams
} from './auth.js';
import { ensureUser, getUser } from './store.js';
import { route, startRouter, dispatch, navigate, setRouteChangeHandler } from './router.js';
import { toast, escapeHtml, isCompAdminUser } from './utils.js';

import { icon } from './icons.js';
import { renderLogin } from './views/login.js';
import { renderLanding } from './views/landing.js';
import { renderHome } from './views/home.js';
import { renderCompetition } from './views/competition.js';
import { renderCompetitionSettings } from './views/competition-settings.js';
import { renderStartScreen, teardownStartScreen } from './views/startscreen.js';
import { renderPatrols } from './views/patrols.js';
import { renderControls } from './views/controls.js';
import { renderControlDetail } from './views/control-detail.js';
import { renderScoreboard } from './views/scoreboard.js';
import { renderAnmalanAdmin } from './views/anmalan-admin.js';
import { renderLaget } from './views/laget.js';
import { renderTrack } from './views/track.js';
import { renderSettings } from './views/settings.js';
import { renderAdminUsers } from './views/admin-users.js';

const app = document.getElementById('app');
let currentUser = null;

// Route table — every /app/* route is gated by auth.
// Root = public landing page (no auth) — promotes ESKIL, lists competitions
// open for registration / ongoing / finished, and links to login.
route('/',             () => renderLanding(app, currentUser));
route('/app',          () => guard(() => renderHome(app, currentUser)));
route('/app/settings', () => guard(() => renderSettings(app, currentUser)));
route('/app/admin/users', () => guard(() => renderAdminUsers(app, currentUser)));
route('/app/c/:cid',                          (p) => guard(() => renderCompetition(app, currentUser, p.cid)));
route('/app/c/:cid/settings',                 (p) => guard(() => renderCompetitionSettings(app, currentUser, p.cid)));
route('/app/c/:cid/startscreen',              (p) => guard(() => renderStartScreen(app, currentUser, p.cid)));
route('/app/c/:cid/patrols',                  (p) => guard(() => renderPatrols(app, currentUser, p.cid)));
route('/app/c/:cid/controls',                 (p) => guard(() => renderControls(app, currentUser, p.cid)));
route('/app/c/:cid/controls/:ctrlId',         (p) => guard(() => renderControlDetail(app, currentUser, p.cid, p.ctrlId)));
route('/app/c/:cid/scoreboard',               (p) => guard(() => renderScoreboard(app, currentUser, p.cid)));
route('/app/c/:cid/anmalan',                  (p) => guard(() => renderAnmalanAdmin(app, currentUser, p.cid)));
route('/app/c/:cid/laget',                    (p) => guard(() => renderLaget(app, currentUser, p.cid)));
route('/app/c/:cid/track',                    (p) => guard(() => renderTrack(app, currentUser, p.cid)));

// ---- Per-view cleanup ------------------------------------------------------
// Views with live subscriptions (watchControls/watchPatrols/watchScores…)
// register a cleanup here; it runs on the next route change. Previously those
// subscriptions survived navigation — the control-detail listener could even
// auto-close a control and re-render its page on top of whatever view the
// admin had moved to.
let activeViewCleanup = null;
export function registerViewCleanup(fn) { activeViewCleanup = fn; }
function runViewCleanup() {
  const fn = activeViewCleanup;
  activeViewCleanup = null;
  if (fn) { try { fn(); } catch (e) { console.warn('[ESKIL] view cleanup failed:', e); } }
}

function guard(render) {
  runViewCleanup();
  if (!currentUser) {
    renderLogin(app);
    return;
  }
  render();
}

// Update topbar active state when route changes. Also tear down any active
// start-screen intervals when we navigate away.
setRouteChangeHandler(() => {
  document.querySelectorAll('.tabs a').forEach(a => {
    if (a.getAttribute('href') === location.pathname) a.classList.add('active');
    else a.classList.remove('active');
  });
  if (!location.pathname.endsWith('/startscreen')) teardownStartScreen();
});

// ---- Topbar --------------------------------------------------------------

export function renderTopbar(extra) {
  const bar = document.createElement('nav');
  bar.className = 'topbar';
  bar.innerHTML = `
    <div class="topbar-inner">
      <a class="brand" href="/app" data-link>
        <img class="brand-mark" src="/assets/scout-symbol.svg" alt="" aria-hidden="true">
        <span class="brand-name">ESKIL</span>
        <span class="brand-sub">Scouttävlingar</span>
      </a>
      <div class="topbar-comp" id="topbar-comp"></div>
      <div class="topbar-right">
        ${currentUser?.role === 'super-admin' ? '<span class="badge badge-blue">Super-admin</span>' : ''}
        <span class="muted" title="${currentUser?.email ?? ''}">${currentUser?.email ?? ''}</span>
        <a class="btn btn-ghost btn-sm" href="/app/settings" data-link>Inställningar</a>
        <button class="btn btn-ghost btn-sm" id="sign-out">Logga ut</button>
      </div>
    </div>
  `;
  bar.querySelector('#sign-out').addEventListener('click', async () => {
    await doSignOut();
    navigate('/app');
  });
  return bar;
}

// Populate the competition-specific slot in the topbar (Offentlig sida +
// Startskärm). Views call this after their `comp` data has loaded. The slot
// is recreated empty on every layout() call, so stale comps never leak.
export function setTopbarCompetition(cid, comp, user) {
  const slot = document.getElementById('topbar-comp');
  if (!slot || !comp) return;
  const isAdmin = isCompAdminUser(comp, user);
  slot.innerHTML = `
    <a class="btn btn-secondary btn-sm" href="/t/${cid}" target="_blank" rel="noopener">Offentlig sida ${icon('external', { size: 14 })}</a>
    ${comp.startTimes?.enabled && isAdmin ? `<a class="btn btn-secondary btn-sm" href="/app/c/${cid}/startscreen" target="_blank" rel="noopener">Startskärm ${icon('external', { size: 14 })}</a>` : ''}
  `;
}

// Shared layout helper — call with {topbar:true} on most pages.
export function layout(inner, { narrow = false } = {}) {
  app.innerHTML = '';
  app.appendChild(renderTopbar());
  const page = document.createElement('main');
  page.className = 'page' + (narrow ? ' page-narrow' : '');
  page.appendChild(inner);
  app.appendChild(page);
}

// ---- Magic-link completion UI ---------------------------------------------
// Renders into #app while the sign-in link from the email is being redeemed.
// Replaces the old window.prompt() (blocked/auto-dismissed in several mobile
// and in-app browsers, which left users stuck on the loading splash).

function splashScreen(bodyHtml) {
  app.innerHTML = `
    <div class="splash">
      <div class="splash-pattern"></div>
      <div class="splash-inner">
        <img class="splash-logo" src="/assets/logo-scouterna-tagline-white.svg" alt="Scouterna" width="320">
        ${bodyHtml}
      </div>
    </div>`;
}

function askEmailConfirm(errorMsg = '') {
  return new Promise(resolve => {
    splashScreen(`
      <div class="login-card" style="margin-top:var(--sp-8);">
        <h2 class="t-h2" style="margin-top:0;color:var(--scout-blue);">Bekräfta din e-postadress</h2>
        <p class="muted" style="margin-top:6px;">Länken öppnades i en annan webbläsare än där den beställdes. Ange adressen som inloggningslänken skickades till, så loggar vi in dig.</p>
        ${errorMsg ? `<p style="color:var(--utm-pink);font-size:14px;font-weight:600;">${escapeHtml(errorMsg)}</p>` : ''}
        <form id="confirm-form" style="margin-top:12px;">
          <label class="field" for="confirm-email">E-postadress</label>
          <input class="input" id="confirm-email" type="email" required autocomplete="email" placeholder="din@adress.se">
          <button class="btn btn-primary btn-block" style="margin-top:14px;" type="submit">Slutför inloggning</button>
        </form>
        <button class="btn btn-ghost btn-block" style="margin-top:10px;" id="confirm-abort" type="button">Avbryt — till inloggningssidan</button>
      </div>
    `);
    document.getElementById('confirm-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = document.getElementById('confirm-email').value.trim().toLowerCase();
      if (v) resolve(v);
    });
    document.getElementById('confirm-abort').addEventListener('click', () => resolve(null));
  });
}

function showLinkDeadScreen() {
  return new Promise(resolve => {
    splashScreen(`
      <div class="login-card" style="margin-top:var(--sp-8);">
        <h2 class="t-h2" style="margin-top:0;color:var(--scout-blue);">Länken har gått ut</h2>
        <p class="muted" style="margin-top:6px;">Inloggningslänken är redan använd eller för gammal. Beställ en ny från inloggningssidan så är du inne på nolltid.</p>
        <button class="btn btn-primary btn-block" style="margin-top:14px;" id="to-login" type="button">Till inloggningen</button>
      </div>
    `);
    document.getElementById('to-login').addEventListener('click', () => resolve());
  });
}

async function runMagicLinkFlow() {
  let email = savedSigninEmail();
  let errorMsg = '';
  for (;;) {
    if (!email) {
      email = await askEmailConfirm(errorMsg);
      if (email === null) break; // user bailed → clean URL, show login
    }
    splashScreen(`<div class="t-over eyebrow" style="margin-top: var(--sp-8);">Loggar in…</div>`);
    try {
      await completeMagicLink(email);
      return; // success — watchAuth below takes over
    } catch (e) {
      console.error('[ESKIL] Magic-link sign-in failed:', e);
      if (e.code === 'auth/invalid-action-code' || e.code === 'auth/expired-action-code') {
        await showLinkDeadScreen();
        break;
      }
      // Wrong/mistyped email (or transient error) — let the user try again.
      errorMsg = 'Det gick inte att logga in med den adressen. Kontrollera att det är exakt samma adress som länken skickades till.';
      email = null;
    }
  }
  clearMagicLinkParams();
}

// ---- Boot ----------------------------------------------------------------

(async function boot() {
  // Finish a magic-link sign-in BEFORE the auth watcher starts so the login
  // screen never flashes while the link is being redeemed.
  if (pendingMagicLink()) {
    try { await runMagicLinkFlow(); }
    catch (e) { console.error(e); clearMagicLinkParams(); }
  }

  let routerStarted = false;
  watchAuth(async (fbUser) => {
    if (fbUser) {
      try {
        const userDoc = await ensureUser(fbUser.uid, fbUser.email);
        currentUser = { uid: fbUser.uid, email: fbUser.email, ...userDoc };
      } catch (e) {
        // Never leave the splash hanging — fall back to a minimal profile and
        // let the views surface their own load errors instead.
        console.error('[ESKIL] ensureUser failed:', e);
        const u = await getUser(fbUser.uid).catch(() => null);
        currentUser = { uid: fbUser.uid, email: fbUser.email, role: 'user', ...(u || {}) };
      }
    } else {
      currentUser = null;
    }
    if (routerStarted) {
      // Auth state changed after boot (sign-out, token refresh) — re-render
      // the current route. startRouter() must only ever run once: it installs
      // the global click/popstate listeners, and the old code re-ran it on
      // every auth change, stacking duplicate listeners.
      dispatch();
    } else {
      routerStarted = true;
      startRouter();
    }
  });
})();
