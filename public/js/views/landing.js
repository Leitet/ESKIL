// Public landing page at / — promotes ESKIL and lists competitions grouped by
// state: open for registration, ongoing/upcoming, the demo track, and finished
// competitions with results. No auth required (competition meta is public);
// signed-in users get a shortcut to their competitions instead of the login
// button.

import { listAllCompetitions } from '../store.js';
import { escapeHtml, formatDate, registrationState } from '../utils.js';
import { icon } from '../icons.js';

export async function renderLanding(app, user) {
  document.title = 'ESKIL — Scouttävlingssystem';
  app.innerHTML = `
    ${heroHtml(user)}
    <main class="page" id="landing-body">
      <div class="muted" style="padding:var(--sp-8) 0;">Laddar tävlingar…</div>
    </main>
    ${footHtml(user)}
  `;

  const body = app.querySelector('#landing-body');
  let comps = [];
  try {
    comps = await listAllCompetitions();
  } catch (e) {
    console.error(e);
    body.innerHTML = `<div class="empty"><h3>Kunde inte ladda tävlingarna</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }
  if (!body.isConnected) return;

  const byDate = (a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999'));

  const demos = comps.filter(c => c.demo);
  const openReg = comps.filter(c => !c.demo && registrationState(c) === 'open').sort(byDate);
  const finished = comps.filter(c => !c.demo && c.closed)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const upcoming = comps.filter(c => !c.demo && !c.closed && !openReg.includes(c)).sort(byDate);

  body.innerHTML = `
    ${openReg.length ? `
      <div class="pub-section-head"><h2 class="t-h2">Öppna för anmälan</h2><span class="muted">Anmäl er kår direkt</span></div>
      <div class="landing-grid">
        ${openReg.map(c => compCard(c, {
          badge: '<span class="badge badge-green">Anmälan öppen</span>',
          cta: `<a class="btn btn-primary btn-sm" href="/a/${c.slug || c.id}">Anmäl er ${icon('arrow-right', { size: 14 })}</a>`
        })).join('')}
      </div>
    ` : ''}

    ${upcoming.length ? `
      <div class="pub-section-head"><h2 class="t-h2">Pågående & kommande</h2><span class="muted">Följ live på tävlingssidan</span></div>
      <div class="landing-grid">
        ${upcoming.map(c => compCard(c)).join('')}
      </div>
    ` : ''}

    ${demos.length ? `
      <div class="pub-section-head"><h2 class="t-h2">Testa ESKIL</h2><span class="muted">Demospåret är öppet för alla — inget konto behövs</span></div>
      <div class="landing-grid">
        ${demoCards(demos[0])}
      </div>
    ` : ''}

    ${finished.length ? `
      <div class="pub-section-head"><h2 class="t-h2">Avslutade tävlingar</h2><span class="muted">Resultaten finns kvar</span></div>
      <div class="landing-grid">
        ${finished.map(c => compCard(c, {
          badge: '<span class="badge badge-gray">Avslutad</span>',
          cta: `<a class="btn btn-secondary btn-sm" href="/t/${c.slug || c.id}/scoreboard">Se resultat ${icon('trophy', { size: 14 })}</a>`
        })).join('')}
      </div>
    ` : ''}

    ${!comps.length ? '<div class="empty"><h3>Inga tävlingar ännu</h3></div>' : ''}

    <div class="pub-section-head"><h2 class="t-h2">Vad är ESKIL?</h2><span class="muted">Byggt av scouter, för scouter</span></div>
    <div class="landing-grid">
      <div class="card">
        <img class="landing-shot" src="/assets/landing/anmalan.png" alt="Anmälningssidan i mobilen" loading="lazy">
        <div class="row" style="gap:10px;align-items:center;">
          <div class="landing-feature-icon">${icon('send', { size: 22 })}</div>
          <h3 class="t-h4" style="margin:0;">Anmälan online</h3>
        </div>
        <p class="t-sm mt-3" style="color:var(--fg2);margin-bottom:var(--sp-4);">Kårer anmäler sina patruller på webben — med Swish-QR, betalningsreferenser och kvitton som mailas automatiskt.</p>
      </div>
      <div class="card">
        <img class="landing-shot" src="/assets/landing/rapportera.png" alt="Poängrapportering i mobilen" loading="lazy">
        <div class="row" style="gap:10px;align-items:center;">
          <div class="landing-feature-icon">${icon('check', { size: 22 })}</div>
          <h3 class="t-h4" style="margin:0;">Rapportera i mobilen</h3>
        </div>
        <p class="t-sm mt-3" style="color:var(--fg2);margin-bottom:var(--sp-4);">Kontrollanter rapporterar poäng direkt i mobilen via en QR-kod — fungerar även offline i skogen, med nattläge som skonar mörkerseendet.</p>
      </div>
      <div class="card">
        <img class="landing-shot" src="/assets/landing/resultat.png" alt="Live-uppdaterad poängtabell" loading="lazy">
        <div class="row" style="gap:10px;align-items:center;">
          <div class="landing-feature-icon">${icon('trophy', { size: 22 })}</div>
          <h3 class="t-h4" style="margin:0;">Live-resultat</h3>
        </div>
        <p class="t-sm mt-3" style="color:var(--fg2);margin-bottom:var(--sp-4);">Poängtabeller uppdateras i realtid på den publika tävlingssidan — per avdelning, per kår och overall, med digitala startkort för patrullerna.</p>
      </div>
    </div>
  `;
}

// Three doors into the demo competition — public page, the admin views
// (account-free read-only demo mode, see guard() in app.js) and the
// startskärm. Everything a curious kår needs to evaluate ESKIL in one row.
function demoCards(c) {
  return `
    <div class="card landing-card">
      <div class="row" style="gap:10px;align-items:center;">
        <div class="landing-feature-icon">${icon('globe', { size: 22 })}</div>
        <h3 class="t-h4" style="margin:0;">Tävlingssidan</h3>
      </div>
      <p class="t-sm mt-3" style="color:var(--fg2);">Det deltagare och föräldrar ser: live-poäng, startlista med nedräkning, karta med spåret och digitala startkort.</p>
      <div class="btn-row" style="margin-top:auto;">
        <a class="btn btn-primary btn-sm" href="/t/${c.id}">Öppna tävlingssidan ${icon('arrow-right', { size: 14 })}</a>
      </div>
    </div>
    <div class="card landing-card">
      <div class="row" style="gap:10px;align-items:center;">
        <div class="landing-feature-icon">${icon('users', { size: 22 })}</div>
        <h3 class="t-h4" style="margin:0;">Administratörsvyn</h3>
      </div>
      <p class="t-sm mt-3" style="color:var(--fg2);">Utforska tävlingen som tävlingsledningen ser den — Läget-dashboarden, spårdragningen, kontroller och poäng. Ingen inloggning behövs, klicka runt fritt.</p>
      <div class="btn-row" style="margin-top:auto;">
        <a class="btn btn-primary btn-sm" href="/app/c/${c.id}" data-link>Öppna som administratör ${icon('arrow-right', { size: 14 })}</a>
      </div>
    </div>
    <div class="card landing-card">
      <div class="row" style="gap:10px;align-items:center;">
        <div class="landing-feature-icon">${icon('clock', { size: 22 })}</div>
        <h3 class="t-h4" style="margin:0;">Startskärmen</h3>
      </div>
      <p class="t-sm mt-3" style="color:var(--fg2);">Projektorvyn vid startplatsen: nästa patrull i bild med nedräkning, startkortets QR och GÅ-signal — rullar av sig själv.</p>
      <div class="btn-row" style="margin-top:auto;">
        <a class="btn btn-primary btn-sm" href="/app/c/${c.id}/startscreen" target="_blank" rel="noopener">Öppna startskärmen ${icon('external', { size: 14 })}</a>
      </div>
    </div>
  `;
}

function compCard(c, { badge = '', cta = '', blurb = '' } = {}) {
  // Note: a card can't be one big <a> — the CTA buttons are links themselves
  // and nested anchors are invalid HTML (the browser splits them apart).
  return `
    <div class="card landing-card">
      <div class="row" style="justify-content:space-between;align-items:flex-start;">
        <div class="t-over" style="color:var(--avent-orange);">${escapeHtml(c.shortName || '')} · ${c.year || ''}</div>
        ${badge}
      </div>
      <h3 class="t-h3" style="color:var(--scout-blue);margin:6px 0 4px;">${escapeHtml(c.name || '')}</h3>
      <div class="muted t-sm">${c.date ? formatDate(c.date) : ''}${c.location ? ' · ' + escapeHtml(c.location) : ''}${c.organizer ? ' · ' + escapeHtml(c.organizer) : ''}</div>
      ${blurb ? `<p class="t-sm mt-2" style="color:var(--fg2);margin-bottom:0;">${escapeHtml(blurb)}</p>` : ''}
      <div class="btn-row mt-4" style="gap:var(--sp-2);">
        ${cta}
        <a class="btn btn-ghost btn-sm" href="/t/${c.slug || c.id}">Tävlingssida ${icon('arrow-right', { size: 14 })}</a>
      </div>
    </div>
  `;
}

function heroHtml(user) {
  return `
    <header class="pub-hero">
      <div class="pub-hero-pattern"></div>
      <img class="pub-hero-symbol" src="/assets/scout-symbol.svg" alt="" aria-hidden="true">
      <div class="page">
        <div class="pub-hero-top">
          <a class="pub-brand" href="/" data-link aria-label="Till ESKIL:s startsida">
            <img src="/assets/logo-scouterna-tagline-white.svg" alt="Scouterna">
            <span class="divider"></span>
            <span class="sublabel">ESKIL</span>
          </a>
          <div class="btn-row">
            ${user
              ? `<a class="btn btn-secondary btn-sm" href="/app" data-link>Dina tävlingar ${icon('arrow-right', { size: 14 })}</a>`
              : `<a class="btn btn-secondary btn-sm" href="/app" data-link>Logga in</a>`}
          </div>
        </div>
        <div class="t-over" style="color:var(--rover-yellow);">ESKIL · Scouttävlingssystem</div>
        <h1>Raised by <em style="font-family:var(--font-serif, Georgia, serif);">adventure.</em></h1>
        <p class="lede">ESKIL hjälper scoutkårer att arrangera tävlingar — anmälan, kontroller,
        poängrapportering och live-resultat, samlat på ett ställe. Från Älghornsjakten till DM.</p>
      </div>
    </header>
  `;
}

function footHtml(user) {
  return `
    <footer class="pub-foot">
      <div class="page">
        <div style="display:flex;align-items:center;gap:var(--sp-4);">
          <img src="/assets/logo-scouterna-tagline-white.svg" alt="Scouterna">
          <span>· ESKIL</span>
        </div>
        <span class="muted">${user
          ? '<a href="/app" data-link style="color:#a7bccf;">Till dina tävlingar</a>'
          : 'Vill din kår använda ESKIL? <a href="/app" data-link style="color:#a7bccf;">Logga in</a>.'}
          · <a href="/kontakt" data-link style="color:#a7bccf;">Skriv till oss</a>
          · <a href="/integritet" style="color:#a7bccf;">Integritet &amp; GDPR</a></span>
      </div>
    </footer>
  `;
}
