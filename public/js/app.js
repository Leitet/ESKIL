// Main SPA shell. Waits for Firebase auth, then renders either the login
// splash or the authenticated app.

import { watchAuth, completeMagicLinkIfPresent, doSignOut } from './auth.js';
import { ensureUser, getUser } from './store.js';
import { route, startRouter, navigate, setRouteChangeHandler } from './router.js';
import { toast } from './utils.js';

import { icon } from './icons.js';
import { renderLogin } from './views/login.js';
import { renderHome } from './views/home.js';
import { renderCompetition } from './views/competition.js';
import { renderCompetitionSettings } from './views/competition-settings.js';
import { renderStartScreen, teardownStartScreen } from './views/startscreen.js';
import { renderPatrols } from './views/patrols.js';
import { renderControls } from './views/controls.js';
import { renderControlDetail } from './views/control-detail.js';
import { renderScoreboard } from './views/scoreboard.js';
import { renderSettings } from './views/settings.js';
import { renderAdminUsers } from './views/admin-users.js';

const app = document.getElementById('app');
let currentUser = null;

// Route table — every /app/* route is gated by auth.
route('/',             () => navigate('/app', true));
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

function guard(render) {
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
  const isAdmin = user.role === 'super-admin' || (comp.admins || []).includes(user.uid);
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

// ---- Boot ----------------------------------------------------------------

(async function boot() {
  try {
    await completeMagicLinkIfPresent();
  } catch (e) {
    console.error(e);
    toast('Inloggningslänken kunde inte slutföras: ' + e.message, 'error');
  }

  watchAuth(async (fbUser) => {
    if (fbUser) {
      try {
        const userDoc = await ensureUser(fbUser.uid, fbUser.email);
        currentUser = { uid: fbUser.uid, email: fbUser.email, ...userDoc };
      } catch (e) {
        console.error(e);
        const u = await getUser(fbUser.uid);
        currentUser = u ? { uid: fbUser.uid, email: fbUser.email, ...u } : null;
      }
    } else {
      currentUser = null;
    }
    startRouter();
  });
})();
