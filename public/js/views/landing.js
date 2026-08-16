// Public landing page at / — promotes ESKIL and lists competitions grouped by
// state: open for registration, ongoing/upcoming, the demo track, and finished
// competitions with results. No auth required (competition meta is public);
// signed-in users get a shortcut to their competitions instead of the login
// button.

import { listAllCompetitions } from '../store.js';
import { escapeHtml, formatDate, registrationState } from '../utils.js';
import { icon } from '../icons.js';
import { publikHeader, publikFooter } from '../publik-nav.js';

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
    ${bevisremsa(comps)}
    ${funktionslista()}

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
      <div class="pub-section-head" id="testa">
        <h2 class="t-h2">Testa ESKIL</h2>
        <span class="muted">Inget konto behövs — klicka runt fritt</span>
      </div>
      <p class="landing-demo-lede">Demospåret är en riktig tävling mitt i loppet: tio kontroller,
      trettio patruller och poäng som droppar in. Allt är påhittat, ingenting går att ändra —
      men varje vy är den ni skulle använda på tävlingsdagen.</p>
      ${demoCards(demos[0])}
    ` : `
      <div class="pub-section-head" id="testa"><h2 class="t-h2">Testa ESKIL</h2></div>
      <div class="empty"><p class="muted">Demospåret är tillfälligt otillgängligt. <a href="/kontakt" data-link>Hör av er</a> så visar vi.</p></div>
    `}

    ${finished.length ? `
      <div class="pub-section-head"><h2 class="t-h2">Avslutade tävlingar</h2><span class="muted">Resultaten finns kvar</span></div>
      <div class="landing-grid">
        ${finished.slice(0, 6).map(c => compCard(c, {
          badge: '<span class="badge badge-gray">Avslutad</span>',
          cta: `<a class="btn btn-secondary btn-sm" href="/t/${c.slug || c.id}/scoreboard">Se resultat ${icon('trophy', { size: 14 })}</a>`
        })).join('')}
      </div>
    ` : ''}

    ${finished.length > 6 ? `<p class="muted t-sm" style="margin:calc(-1 * var(--sp-5)) 0 var(--sp-8);">Visar de sex senaste av ${finished.length} avslutade tävlingar.</p>` : ''}

    ${!comps.length ? '<div class="empty"><h3>Inga tävlingar ännu</h3></div>' : ''}

    ${komIgang()}

  `;
}

// "Så kommer ni igång". Vägen är inte självklar: en inloggad användare kan
// INTE skapa en tävling själv — hen skickar en förfrågan som en super-admin
// godkänner. Står det inte här gissar folk fel och ger upp.
function komIgang() {
  const steg = [
    ['Testa demot', 'Klicka runt i Läget och på fältsidorna. Ni behöver inget konto för det.'],
    ['Begär en tävling', 'Logga in med er e-post — ni får en inloggningslänk i mailen, inget lösenord. Fyll i namn, datum och distrikt.'],
    ['Ni blir administratörer', 'När förfrågan godkänts är tävlingen er. Lägg upp kontroller, rita banan och öppna anmälan.']
  ];
  return `
    <div class="pub-section-head"><h2 class="t-h2">Så kommer ni igång</h2>
      <span class="muted">Tre steg — och det kostar ingenting</span></div>
    <div class="landing-steg">
      ${steg.map(([rubrik, text], i) => `
        <div class="landing-steg-kort">
          <span class="landing-steg-num" aria-hidden="true">${i + 1}</span>
          <strong>${escapeHtml(rubrik)}</strong>
          <p class="t-sm" style="color:var(--fg2);margin:6px 0 0;">${escapeHtml(text)}</p>
        </div>`).join('')}
    </div>
    <div class="landing-kostnad">
      <p><strong>Vad kostar det?</strong> Ingenting. ESKIL drivs av scouter och körs inom
      Google Firebase gratisnivå — den enda kostnaden är utskicken av e-post, som ryms i samma
      budget. Det finns ingen licens, inget abonnemang och ingen uppsägningstid.</p>
      <p class="t-sm" style="margin:var(--sp-3) 0 0;">Er data är er. Ladda ner hela tävlingen som
      en fil när ni vill. Kontaktuppgifter, allergier och fältets meddelanden raderas automatiskt
      när tävlingen avslutas — <a href="/integritet">så här hanteras personuppgifter</a>.</p>
      <div class="btn-row mt-4">
        <a class="btn btn-primary" href="/app" data-link>Logga in och begär en tävling ${icon('arrow-right', { size: 15 })}</a>
        <a class="btn btn-ghost" href="/kontakt" data-link>Ställ en fråga först</a>
      </div>
    </div>
  `;
}

// Bevisremsan: konkreta siffror ur den faktiska produkten, inte marknadsföring.
// Talen räknas ur tävlingslistan så de aldrig kan bli osanna.
function bevisremsa(comps) {
  const skarpa = comps.filter(c => !c.demo);
  const kar = new Set(skarpa.map(c => c.organizer).filter(Boolean));
  const rader = [
    ['Ingen app', 'Allt körs i webbläsaren — kontrollanten skannar en QR-kod och är igång.'],
    ['Fungerar offline', 'Poäng som rapporteras utan täckning köas i telefonen och skickas när nätet kommer tillbaka.'],
    ['Inga cookies', 'Ingen spårning, ingen analys. Kontaktuppgifter och allergier gallras när tävlingen avslutas.']
  ];
  return `
    <section class="landing-proof" aria-label="Kort om ESKIL">
      ${skarpa.length ? `<div class="landing-proof-num">
        <strong>${skarpa.length}</strong><span>tävling${skarpa.length === 1 ? '' : 'ar'}${kar.size ? ` · ${kar.size} kår${kar.size === 1 ? '' : 'er'}` : ''}</span>
      </div>` : ''}
      ${rader.map(([rubrik, text]) => `
        <div class="landing-proof-item">
          <strong>${escapeHtml(rubrik)}</strong>
          <span>${escapeHtml(text)}</span>
        </div>`).join('')}
    </section>`;
}

// Funktionslistan. Grupperad efter NÄR under tävlingen man behöver saken —
// det är så en tävlingsledning tänker, och det gör listan läsbar trots att den
// är lång. Varje rad motsvarar något som faktiskt finns i produkten; hittar du
// en rad utan funktion bakom är det en bugg i den här listan.
const FUNKTIONER = [
  {
    rubrik: 'Före tävlingen', ikon: 'send',
    poster: [
      ['Anmälan på webben', 'Kårerna anmäler sina patruller själva. Pris per scout, Swish-QR och betalningsreferenser räknas ut åt er.'],
      ['Kvitton och påminnelser', 'Bekräftelse och kvitto mailas automatiskt. Obetalda anmälningar syns i en lista med en påminnelseknapp.'],
      ['Komplettering per patrull', 'Kårledaren skickar en egen länk till varje patrulledare för allergier och antal — utan att lämna ut hela anmälan.'],
      ['Banan på karta', 'Rita spåret sträcka för sträcka, lägg ut kontroller, parkering, sekretariat och matplats. Längd och gångtid räknas ut.'],
      ['Utskriftscentral', 'Kontrollernas pärmar med karta, QR, instruktioner, nödinfo och reservprotokoll — och startkort på papper för patruller utan mobil.'],
      ['Genrep', 'Provkör hela kedjan med en testpatrull som går genom exakt samma kod som en skarp, och städa bort den efteråt.']
    ]
  },
  {
    rubrik: 'Under tävlingsdagen', ikon: 'check',
    poster: [
      ['Rapportera i mobilen', 'Kontrollanten öppnar sin QR-kod och sätter poäng. Nattläge i rött för mörkerseendet, och skärmen släcks inte mellan patrullerna.'],
      ['Fungerar utan täckning', 'Rapporter köas lokalt och skickas när nätet kommer tillbaka — med tiden de faktiskt sattes, inte synktiden.'],
      ['Läget', 'Sekretariatets vy: vilka som är ute, kötryck per kontroll, mellantider, larm för tysta kontroller och sena starter.'],
      ['Beräknad ankomst', 'ETA per patrull och kontroll, kalibrerad mot patrullernas verkliga mellantider — köer räknas in automatiskt.'],
      ['Driftmeddelanden', 'Skicka ett meddelande till alla kontroller, valda kontroller eller patrullerna. Kritiska larm ljuder och kräver bekräftelse.'],
      ['Samtal med fältet', 'Kontroller och patruller kan ställa frågor och skicka foton till ledningen — och få svar i samma vy.'],
      ['Nödknapp med position', 'Patrullen kan skicka sin GPS-position till sekretariatet med en knapp, som en kartlänk i inkorgen.'],
      ['Digitalt startkort', 'Patrullen ser sin bana, nästa kontroll, avstånd och sina poäng. Kan bekräfta start och målgång själv.']
    ]
  },
  {
    rubrik: 'Efter mål', ikon: 'trophy',
    poster: [
      ['Live-resultat', 'Poängtabellen uppdateras direkt — overall, per avdelning och per kår, med utslagsfråga när två patruller står lika.'],
      ['Prisutdelning', 'Fullskärmsvy som avslöjar pallen kategori för kategori, med varning om någon kontroll saknar rapporter.'],
      ['Patrullens summering', 'Startkortet blir en sammanfattning med höjdpunkter — och en delningsbild som ritas i telefonen och aldrig lämnar den.'],
      ['Resultatlista att skriva ut', 'Färdig PDF till anslagstavlan.'],
      ['Årgångskopiering', 'Kopiera hela upplägget till nästa år — bana, kontroller och instruktioner följer med, personuppgifterna gör det inte.']
    ]
  },
  {
    rubrik: 'Trygghet och ordning', ikon: 'eye',
    poster: [
      ['Roller', 'Administratörer, kontrollansvariga, ekonomiansvariga och läsbehöriga — var och en ser bara sitt.'],
      ['GDPR-gallring', 'När tävlingen avslutas raderas kontaktuppgifter, fritextsvar, telefonnummer och hela fältsamtalet automatiskt.'],
      ['Papperskorg', 'Raderade patruller och kontroller går att ångra — med sina poäng och samma id, så tryckta QR-koder fungerar igen.'],
      ['Säkerhetskopiering', 'Ladda ner hela tävlingen som en fil, och läs tillbaka den. Tävlingar går inte att radera utan en färsk kopia.'],
      ['Publik tävlingssida', 'Anhöriga följer starttider och resultat, kan prenumerera på en patrull och lägga målgången i sin kalender.']
    ]
  }
];

function funktionslista() {
  return `
    <div class="pub-section-head" id="funktioner">
      <h2 class="t-h2">Vad ESKIL gör</h2>
      <span class="muted">Byggt för en härlig dag på spåret i skogen</span>
    </div>
    <div class="landing-funk">
      ${FUNKTIONER.map(g => `
        <section class="landing-funk-grupp">
          <h3 class="landing-funk-rubrik">
            <span class="landing-feature-icon">${icon(g.ikon, { size: 20 })}</span>
            ${escapeHtml(g.rubrik)}
          </h3>
          <ul class="landing-funk-lista">
            ${g.poster.map(([namn, text]) => `
              <li><strong>${escapeHtml(namn)}</strong><span>${escapeHtml(text)}</span></li>`).join('')}
          </ul>
        </section>`).join('')}
    </div>
  `;
}

// Three doors into the demo competition — public page, the admin views
// (account-free read-only demo mode, see guard() in app.js) and the
// startskärm. Everything a curious kår needs to evaluate ESKIL in one row.
function demoCards(c) {
  const t = (v) => escapeHtml(String(v || ''));
  // Fältlänkarna (/k, /s) är hemliga på en riktig tävling. De får bara byggas
  // här för att c.demo är sant — bygg ALDRIG villkoret på ett tävlings-id.
  const falt = c.demo;
  return `
    <div class="landing-demo">
      <div class="card landing-card landing-demo-huvud">
        <div class="row" style="gap:10px;align-items:center;">
          <div class="landing-feature-icon">${icon('users', { size: 22 })}</div>
          <h3 class="t-h3" style="margin:0;color:var(--scout-blue);">Sekretariatets vy</h3>
        </div>
        <p class="t-sm mt-3" style="color:var(--fg2);">Här sitter tävlingsledningen på dagen.
        Läget visar vilka som är ute i skogen, var kön står, vilka kontroller som tystnat och
        när sista patrullen väntas i mål. Klicka vidare till banan, kontrollerna, poängtabellen
        och anmälningarna — allt är öppet.</p>
        <div class="btn-row" style="margin-top:auto;">
          <a class="btn btn-primary" href="/app/c/${t(c.id)}/laget" data-link>Öppna Läget ${icon('arrow-right', { size: 15 })}</a>
          <a class="btn btn-ghost btn-sm" href="/app/c/${t(c.id)}" data-link>Hela tävlingen</a>
        </div>
      </div>

      <div class="landing-demo-sido">
        ${[
          ['globe', 'Tävlingssidan', 'Det deltagare och anhöriga ser: startlista med nedräkning, live-poäng och kartan.', `/t/${t(c.slug || c.id)}`, false],
          ['clock', 'Startskärmen', 'Projektorvyn vid startfållan — nästa patrull i bild med nedräkning och GÅ-signal.', `/app/c/${t(c.id)}/startscreen`, true],
          ...(falt ? [
            ['check', 'Kontrollantens mobil', 'Rapportsidan som kontrollanten har i fickan. Prova nattläget.', `/k/${t(c.id)}/demo-c03/demotokenc03aaaaaaaaaaaa`, true],
            ['flag', 'Patrullens startkort', 'Banan, nästa kontroll, avstånd och egna poäng — det patrullen bär med sig.', `/s/${t(c.slug || c.id)}/demo-p12`, true]
          ] : [])
        ].map(([ikon, rubrik, text, href, nyFlik]) => `
          <a class="card landing-card landing-demo-liten" href="${href}"${nyFlik ? ' target="_blank" rel="noopener"' : ' data-link'}>
            <div class="row" style="gap:8px;align-items:center;">
              <span class="landing-feature-icon landing-feature-icon-sm">${icon(ikon, { size: 16 })}</span>
              <strong>${escapeHtml(rubrik)}</strong>
              ${nyFlik ? `<span class="landing-demo-ext">${icon('external', { size: 13 })}</span>` : ''}
            </div>
            <p class="t-sm" style="color:var(--fg2);margin:6px 0 0;">${escapeHtml(text)}</p>
          </a>`).join('')}
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
          <div class="pub-hero-actions">
            <nav class="pub-meny" aria-label="ESKIL:s sidor">
              <a href="/om" data-link>Om ESKIL</a>
              <a href="/kontakt" data-link>Kontakt</a>
              <a href="/integritet">Integritet</a>
            </nav>
            ${user
              ? `<a class="btn btn-secondary btn-sm" href="/app" data-link>Dina tävlingar ${icon('arrow-right', { size: 14 })}</a>`
              : `<a class="btn btn-secondary btn-sm" href="/app" data-link>Logga in</a>`}
          </div>
        </div>
        <div class="t-over" style="color:var(--rover-yellow);">ESKIL · Scouttävlingssystem</div>
        <h1>Allt en scouttävling behöver — <em style="font-family:var(--font-serif, Georgia, serif);">från anmälan till prisutdelning.</em></h1>
        <p class="lede">Kårerna anmäler sig på webben. Kontrollanterna rapporterar i mobilen, även utan
        täckning. Sekretariatet ser hela banan i realtid och vet vilka som fortfarande är ute i skogen.</p>
        <div class="hero-cta-row">
          <a class="btn btn-gul" href="#testa" aria-label="Testa demot — inget konto behövs">
            Testa demot ${icon('arrow-right', { size: 16 })}</a>
          <span class="hero-cta-note">Inget konto. Inget att installera.</span>
        </div>
      </div>
    </header>
  `;
}

function footHtml(user) {
  return publikFooter({ extra: user
    ? '<a href="/app" data-link>Till dina tävlingar</a>'
    : '<a href="/app" data-link>Logga in</a>' });
}
