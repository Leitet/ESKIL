// Main SPA shell. Waits for Firebase auth, then renders either the login
// splash or the authenticated app.

import {
  watchAuth, doSignOut,
  pendingMagicLink, savedSigninEmail, completeMagicLink, clearMagicLinkParams
} from './auth.js';
import { ensureUser, getUser, getCompetition } from './store.js';
import { route, startRouter, dispatch, navigate, setRouteChangeHandler } from './router.js';
import { toast, escapeHtml, isCompAdminUser } from './utils.js';
import { compLabel } from './nav.js';

import { icon } from './icons.js';

// ADMINVYERNA LADDAS FÖRST NÄR DE SKA VISAS. Förut importerades alla nitton
// statiskt, vilket betydde att den PUBLIKA startsidan drog ner hela
// administratörsappen — ~40 moduler — innan den ritade en enda pixel. Mätt i
// produktion: nätet klart efter 3 s, flera enskilda vyfiler över 2 s var, och
// besökaren såg "Laddar…" hela tiden. En förälder som öppnar tävlingssidan
// ska inte betala för Läget, spårdragningen och backupvyn.
//
// import() cachas av webbläsaren, så en vy hämtas en gång per sidladdning.
const vy = (fil, namn) => async (...args) => (await import(fil))[namn](...args);
import { renderLogin } from './views/login.js';
import { renderLanding } from './views/landing.js';
import { renderKontakt, renderKontaktArende } from './views/kontakt.js';
import { renderOm } from './views/om.js';

const app = document.getElementById('app');
let currentUser = null;
let startskarmVisad = false;   // styr om startskärmen behöver rivas vid ruttbyte

// Route table — every /app/* route is gated by auth.
// Root = public landing page (no auth) — promotes ESKIL, lists competitions
// open for registration / ongoing / finished, and links to login.
route('/',             () => renderLanding(app, currentUser));
// Publik kontaktsida — meddelanden till dem som ansvarar för ESKIL.
// Om ESKIL — officiell sida, samma meny och smulor som de övriga.
route('/om',           () => renderOm(app, currentUser));
route('/kontakt',      () => renderKontakt(app, currentUser));
// Ärendet — id:t är hemligheten, precis som anmälningarnas ändringslänk.
route('/kontakt/:id',  (p) => renderKontaktArende(app, p.id));
route('/app',          () => guard(async () => await vy('./views/home.js', 'renderHome')(app, currentUser)));
route('/app/settings', () => guard(async () => await vy('./views/settings.js', 'renderSettings')(app, currentUser)));
route('/app/admin/users', () => guard(async () => await vy('./views/admin-users.js', 'renderAdminUsers')(app, currentUser)));
route('/app/admin/requests', () => guard(async () => await vy('./views/admin-requests.js', 'renderAdminRequests')(app, currentUser)));
route('/app/admin/feedback', () => guard(async () => await vy('./views/admin-feedback.js', 'renderAdminFeedback')(app, currentUser)));
route('/app/admin/system', () => guard(async () => await vy('./views/admin-system.js', 'renderAdminSystem')(app, currentUser)));
route('/app/c/:cid',                          (p) => guard(async () => await vy('./views/competition.js', 'renderCompetition')(app, currentUser, p.cid), p.cid));
route('/app/c/:cid/settings',                 (p) => guard(async () => await vy('./views/competition-settings.js', 'renderCompetitionSettings')(app, currentUser, p.cid), p.cid));
route('/app/c/:cid/startscreen',              (p) => guard(async () => (startskarmVisad = true) && await vy('./views/startscreen.js', 'renderStartScreen')(app, currentUser, p.cid), p.cid));
route('/app/c/:cid/patrols',                  (p) => guard(async () => await vy('./views/patrols.js', 'renderPatrols')(app, currentUser, p.cid), p.cid));
route('/app/c/:cid/controls',                 (p) => guard(async () => await vy('./views/controls.js', 'renderControls')(app, currentUser, p.cid), p.cid));
route('/app/c/:cid/controls/:ctrlId',         (p) => guard(async () => await vy('./views/control-detail.js', 'renderControlDetail')(app, currentUser, p.cid, p.ctrlId), p.cid));
route('/app/c/:cid/scoreboard',               (p) => guard(async () => await vy('./views/scoreboard.js', 'renderScoreboard')(app, currentUser, p.cid), p.cid));
route('/app/c/:cid/anmalan',                  (p) => guard(async () => await vy('./views/anmalan-admin.js', 'renderAnmalanAdmin')(app, currentUser, p.cid), p.cid));
route('/app/c/:cid/laget',                    (p) => guard(async () => await vy('./views/laget.js', 'renderLaget')(app, currentUser, p.cid), p.cid));
route('/app/c/:cid/meddelanden',              (p) => guard(async () => await vy('./views/meddelanden.js', 'renderMeddelanden')(app, currentUser, p.cid), p.cid));
route('/app/c/:cid/track',                    (p) => guard(async () => await vy('./views/track.js', 'renderTrack')(app, currentUser, p.cid), p.cid));
route('/app/c/:cid/utskrifter',              (p) => guard(async () => await vy('./views/utskrifter.js', 'renderUtskrifter')(app, currentUser, p.cid), p.cid));
route('/app/c/:cid/ceremony',                 (p) => guard(async () => await vy('./views/ceremony.js', 'renderCeremony')(app, currentUser, p.cid), p.cid));

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

// Demo competitions are explorable WITHOUT an account: every admin view of a
// demo comp runs on publicly readable data, and the Firestore rules block all
// writes for non-super-admins anyway. The landing page links straight into
// /app/c/<demo> — guard() then installs this read-only stand-in user.
const DEMO_VIEWER = Object.freeze({ uid: null, email: '', role: 'user', demoViewer: true });

async function guard(render, cid = null) {
  runViewCleanup();
  if (!currentUser && cid) {
    const comp = await getCompetition(cid).catch(() => null);
    if (!currentUser && comp?.demo) currentUser = DEMO_VIEWER; // re-check after await
  }
  // The demo viewer only exists inside competition routes — home/settings
  // still ask for a real sign-in.
  if (!currentUser || (currentUser.demoViewer && !cid)) {
    renderLogin(app);
    return;
  }
  render();
}

// Update topbar active state when route changes. Also tear down any active
// start-screen intervals when we navigate away, and reset the browser-tab
// title so a view-specific title (e.g. ceremony's) never leaks to the next
// page — views set their own via setDocTitle() once their data loads.
setRouteChangeHandler(() => {
  document.title = 'ESKIL — spår och tävlingar för scouter';
  document.querySelectorAll('.tabs a').forEach(a => {
    if (a.getAttribute('href') === location.pathname) a.classList.add('active');
    else a.classList.remove('active');
  });
  // Bara om startskärmen faktiskt varit uppe: annars skulle varje ruttbyte
  // hämta hem modulen vi just gjort oss av med.
  if (!location.pathname.endsWith('/startscreen') && startskarmVisad) {
    startskarmVisad = false;
    import('./views/startscreen.js').then(m => m.teardownStartScreen()).catch(() => {});
  }
});

// ---- Topbar --------------------------------------------------------------

export function renderTopbar(extra) {
  const bar = document.createElement('nav');
  bar.className = 'topbar';
  // Demo viewers have no /app home — their brand link goes to the public
  // landing instead of bouncing them onto the login screen via guard().
  const brandHref = currentUser?.demoViewer ? '/' : '/app';
  bar.innerHTML = `
    <div class="topbar-inner">
      <a class="brand" href="${brandHref}" data-link>
        <img class="brand-mark" src="/assets/scout-symbol.svg" alt="" aria-hidden="true">
        <span class="brand-name">ESKIL</span>
        <span class="brand-sub">Scoutspår</span>
      </a>
      <div class="topbar-comp" id="topbar-comp"></div>
      <div class="topbar-right">
        ${currentUser?.demoViewer ? `
          <span class="badge badge-orange">Demoläge — utforska fritt</span>
          <a class="btn btn-ghost btn-sm" href="/" data-link>Till startsidan</a>
          <button class="btn btn-secondary btn-sm" id="demo-login">Logga in</button>
        ` : `
          ${currentUser?.role === 'super-admin' ? '<span class="badge badge-blue">Super-admin</span>' : ''}
          <span class="muted topbar-email" title="${currentUser?.email ?? ''}">${currentUser?.email ?? ''}</span>
          <a class="btn btn-ghost btn-sm" href="/app/settings" data-link>Konto</a>
          <button class="btn btn-ghost btn-sm" id="sign-out">Logga ut</button>
        `}
      </div>
    </div>
  `;
  bar.querySelector('#sign-out')?.addEventListener('click', async () => {
    await doSignOut();
    navigate('/app');
  });
  bar.querySelector('#demo-login')?.addEventListener('click', () => {
    currentUser = null;
    navigate('/app');
  });
  return bar;
}

// Populate the competition-specific slot in the topbar: the competition name
// (always one click back to the competition's start page) + Offentlig sida +
// Startskärm. Views call this after their `comp` data has loaded. The slot
// is recreated empty on every layout() call, so stale comps never leak.
export function setTopbarCompetition(cid, comp, user) {
  const slot = document.getElementById('topbar-comp');
  if (!slot || !comp) return;
  const isAdmin = isCompAdminUser(comp, user);
  slot.innerHTML = `
    <a class="topbar-comp-name" href="/app/c/${encodeURIComponent(cid)}" data-link title="${escapeHtml(comp.name || '')}">${escapeHtml(compLabel(comp))}</a>
    <a class="btn btn-secondary btn-sm" href="/t/${encodeURIComponent(comp.slug || cid)}" target="_blank" rel="noopener">Offentlig sida ${icon('external', { size: 14 })}</a>
    ${comp.startTimes?.enabled && isAdmin ? `<a class="btn btn-secondary btn-sm" href="/app/c/${cid}/startscreen" target="_blank" rel="noopener">Startskärm ${icon('external', { size: 14 })}</a>` : ''}
  `;
}

// Shared layout helper — call with {topbar:true} on most pages.
//
// Topbaren och sidfoten ÅTERANVÄNDS mellan vyer. Förut tömdes hela #app och
// allt byggdes om vid varje vybyte, inklusive topbarens logotypbild — det gav
// en synlig blinkning över hela sidan varje gång man bytte flik, trots att
// bara innehållet faktiskt ändrades. Nu byts bara <main class="page">.
//
// Topbaren byggs om bara när identiteten ändras, för då ändras dess innehåll
// (Logga ut kontra Logga in, super-admin-märket). renderTopbar() kopplar sina
// egna lyssnare, så att återanvända noden kan aldrig dubbelkoppla dem.
let topbarNod = null;
let topbarFor = null;

function chromeNyckel() {
  return currentUser
    ? `${currentUser.uid || ''}:${currentUser.role || ''}:${currentUser.demoViewer ? 'demo' : ''}`
    : 'anon';
}

export function layout(inner, { narrow = false } = {}) {
  const nyckel = chromeNyckel();
  if (!topbarNod || !topbarNod.isConnected || topbarFor !== nyckel) {
    app.innerHTML = '';
    topbarNod = renderTopbar();
    topbarFor = nyckel;
    app.appendChild(topbarNod);
    const page = document.createElement('main');
    page.className = 'page';
    app.appendChild(page);
    // Slim footer — the signed-in app's only route to the public landing page.
    const foot = document.createElement('footer');
    foot.className = 'app-foot';
    foot.innerHTML = `
      <div class="app-foot-inner">
        <span>ESKIL · Scoutspår</span>
        <span><a href="/" data-link>ESKIL:s startsida</a> · <a href="/kontakt" data-link>Kontakta oss</a> · <a href="/integritet">Integritet &amp; GDPR</a></span>
      </div>`;
    app.appendChild(foot);
  }

  // Tävlingschipet hör till FÖRRA vyn tills den nya fyllt i sitt. Töms här,
  // annars står föregående tävlings namn kvar på t.ex. kontosidan.
  const chip = topbarNod.querySelector('#topbar-comp');
  if (chip) chip.innerHTML = '';

  const page = app.querySelector('main.page');
  page.className = 'page' + (narrow ? ' page-narrow' : '');
  page.replaceChildren(inner);

  animeraIn(page);
}

// Mjuk ingång — men ALDRIG på bekostnad av att innehållet syns.
//
// Animationen börjar på opacitet 0, och webbläsaren FRYSER animationens
// tidslinje i en dold flik: navigerar man med fliken i bakgrunden fastnar
// sidan osynlig (mätt: playState "running", currentTime 0, opacitet 0) tills
// man kommer tillbaka. Därför körs den bara när dokumentet faktiskt är synligt.
// Är fliken dold syns innehållet direkt i stället, vilket ändå är rätt: ingen
// tittar på övergången.
//
// Klassen tas bort och sätts igen med en påtvingad omflödning emellan, annars
// startar animationen inte om vid nästa vybyte. Den rör bara opacitet och sex
// pixlars lyft — ingen skalning, som hade fått Leaflet att mäta kartan fel
// medan den pågår.
function animeraIn(page) {
  page.classList.remove('page-in');
  if (document.hidden) return;
  try {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch { return; }
  void page.offsetWidth;
  page.classList.add('page-in');
  // Städa bort klassen när den gjort sitt, så en fryst animation från ett
  // tidigare vybyte aldrig kan ligga kvar och hålla sidan osynlig.
  page.addEventListener('animationend', () => page.classList.remove('page-in'), { once: true });
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
        <div class="splash-lockup">
        <img class="splash-mark" src="/assets/scout-symbol.svg" alt="" aria-hidden="true">
        <span class="splash-ord">ESKIL</span>
        <span class="splash-tagline">Där spåret börjar</span>
      </div>
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

  // DE PUBLIKA SIDORNA VÄNTAR INTE PÅ AUTH. Förut startade routern först när
  // onAuthStateChanged svarat, och på en KALL klient tar det sekunder — mätt
  // i produktion: nätet klart efter 3 s, innehåll först efter 12,8 s, och på
  // en långsammare enhet 30. Under tiden står "Laddar…" på en sida som inte
  // behöver ett enda inloggat anrop: rot-sidan, kontaktsidan och ärendet
  // renderar likadant för en utloggad besökare.
  //
  // /app/* väntar fortfarande: guard() skulle annars blinka förbi
  // inloggningsskärmen för den som faktiskt är inloggad, och den blinkningen
  // är värre än en halv sekunds väntan.
  //
  // Auth-callbacken nedan anropar dispatch() när den kommer, så sidan ritas
  // om med rätt identitet — knappen "Logga in" byts då mot "Dina tävlingar".
  const publikVag = /^\/$|^\/(om|kontakt)(\/|$)/.test(location.pathname);
  if (publikVag) { routerStarted = true; startRouter(); }

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
