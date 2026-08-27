// Watchdog för varje sida som bootar med en statisk "Laddar…" i #root:
// k/s/m (fältet), a (anmälan) och t (tävlingssidan). Vanligt skript, INTE en
// modul, så den kör även när ES-modulgrafen aldrig blir klar — blockerad CDN,
// hängande konfigurationshämtning bakom toppnivå-await, gammal
// service-worker-blandning, App Check som inte får token.
//
// Filnamnet är kvar av praktiska skäl: sw.js förcachar den på den här
// sökvägen, och ett byte hade kostat en cacheinvalidering utan att göra
// någon nytta.
//
// The pages boot with a static "Laddar…" in #root. If NOTHING has replaced
// that content within the deadline, the user is stuck on an eternal loading
// screen with zero information — the worst possible state in the field.
// This watchdog then swaps in a real message: what might be wrong, a retry
// button, and the captured error text so problems can be diagnosed from a
// phone photo.
//
// Disarm condition: ANY child change in #root — every real outcome (success
// render or handled error screen) replaces the loading div.
(function () {
  'use strict';
  var DEADLINE_MS = 10000;
  var lastError = '';

  // ── Startfaser ────────────────────────────────────────────────────────────
  // En kall första sidladdning på morgonen kan ta lång tid, och "Laddar…" säger
  // inte VAD den väntar på. Faserna märks av modulerna (firebase.js, app.js,
  // public.js) och sparas — så att nästa gång det händer finns svaret redan,
  // utan att någon behöver sitta och testa strukturerat.
  //
  // Ingen personuppgift: bara fasnamn och millisekunder. Ligger i localStorage
  // på enheten och skickas ingenstans.
  var faser = [];
  var NYCKEL = 'eskil-start';
  function nu() {
    try { return Math.round(performance.now()); } catch (e) { return -1; }
  }
  window.__eskilFas = function (namn) {
    faser.push(namn + ':' + nu());
    try {
      var gamla = JSON.parse(localStorage.getItem(NYCKEL) || '[]');
      gamla[0] = { vid: new Date().toISOString(), sida: location.pathname, faser: faser.slice() };
      localStorage.setItem(NYCKEL, JSON.stringify(gamla.slice(0, 3)));
    } catch (e) { /* privat läge */ }
  };
  // Ny sidladdning skjuter ner föregående i listan, så de tre senaste finns kvar.
  try {
    var tidigare = JSON.parse(localStorage.getItem(NYCKEL) || '[]');
    localStorage.setItem(NYCKEL, JSON.stringify([{ vid: new Date().toISOString(), sida: location.pathname, faser: [] }]
      .concat(tidigare).slice(0, 3)));
  } catch (e) { /* privat läge */ }
  window.__eskilFas('start');

  window.addEventListener('error', function (e) {
    var src = e.filename ? ' (' + e.filename.split('/').slice(-1)[0] +
      (e.lineno ? ':' + e.lineno : '') + ')' : '';
    lastError = (e.message || 'Skriptfel') + src;
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    lastError = (r && (r.message || String(r))) || 'Okänt fel';
  });

  var aktivObs = null;
  var aktivTimer = null;

  // ÅTERBEVÄPNINGSBAR. Första versionen kopplade ner sig vid första
  // barnändringen i behållaren och kom aldrig tillbaka — i SPA:n betydde det
  // att allt efter landningssidans rendering var helt oskyddat, alltså precis
  // de vyer som laddas dynamiskt och kan misslyckas. Route-change-hooken i
  // app.js anropar window.__eskilVakt() vid varje ruttbyte.
  //
  // En lyckad navigering ritar alltid om innehållet (layout() byter <main>),
  // så uteblir varje ändring i tio sekunder är något faktiskt fel.
  function arm() {
    var root = document.getElementById('root') || document.getElementById('app');
    if (!root) return;

    // Rensa en tidigare beväpning, annars kan en gammal timer fyra av på en
    // sida som sedan länge fungerar.
    if (aktivObs) { try { aktivObs.disconnect(); } catch (e) {} }
    if (aktivTimer) clearTimeout(aktivTimer);

    var done = false;
    var obs = new MutationObserver(function () {
      done = true;
      obs.disconnect();
    });
    aktivObs = obs;
    obs.observe(root, { childList: true, subtree: true });

    aktivTimer = setTimeout(function () {
      if (done) return;
      obs.disconnect();
      root.innerHTML =
        '<div style="max-width:480px;margin:40px auto;padding:0 20px;font-family:inherit;">' +
          '<h2 style="font-size:22px;margin:0 0 10px;">Sidan kunde inte ladda klart</h2>' +
          '<p style="margin:0 0 14px;opacity:.85;line-height:1.5;">Det kan bero på dålig täckning, en annonsblockerare, eller att en app med inbyggd webbläsare (QR-läsaren, e-postappen) blockerar delar av sidan.</p>' +
          '<ul style="margin:0 0 18px;padding-left:20px;opacity:.85;line-height:1.6;">' +
            '<li>Prova knappen nedan.</li>' +
            '<li>Öppna annars länken i din vanliga webbläsare (Safari eller Chrome) i stället för appens inbyggda.</li>' +
            '<li>Stäng av ev. annonsblockerare för den här sidan.</li>' +
          '</ul>' +
          '<button id="wd-retry" style="display:block;width:100%;padding:14px;font-size:17px;font-weight:700;border-radius:12px;border:none;background:#003660;color:#fff;cursor:pointer;">Försök igen</button>' +
          '<p style="margin:18px 0 0;font-size:12px;opacity:.6;word-break:break-word;">Teknisk info: ' +
            String(lastError || 'inget fel — sidan väntade')
              .replace(/&/g, '&amp;').replace(/</g, '&lt;') +
            '<br>Kom till: ' + faser.join(' · ') + '</p>' +
        '</div>';
      var btn = document.getElementById('wd-retry');
      if (btn) btn.addEventListener('click', function () { location.reload(); });
    }, DEADLINE_MS);
  }

  // Route-change-hooken i app.js beväpnar om vid varje SPA-navigering.
  window.__eskilVakt = arm;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', arm);
  } else {
    arm();
  }
})();
