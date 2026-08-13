// Field-page watchdog (k/s/m) — plain script, NOT a module, so it runs even
// when the ES-module graph fails to load or execute (blocked CDN, stale
// service-worker mix, unsupported browser, App Check hang…).
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

  window.addEventListener('error', function (e) {
    var src = e.filename ? ' (' + e.filename.split('/').slice(-1)[0] +
      (e.lineno ? ':' + e.lineno : '') + ')' : '';
    lastError = (e.message || 'Skriptfel') + src;
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    lastError = (r && (r.message || String(r))) || 'Okänt fel';
  });

  function arm() {
    var root = document.getElementById('root');
    if (!root) return;

    var done = false;
    var obs = new MutationObserver(function () {
      done = true;
      obs.disconnect();
    });
    obs.observe(root, { childList: true, subtree: true });

    setTimeout(function () {
      if (done) return;
      obs.disconnect();
      root.innerHTML =
        '<div style="max-width:480px;margin:40px auto;padding:0 20px;font-family:inherit;">' +
          '<h2 style="font-size:22px;margin:0 0 10px;">Sidan kunde inte ladda klart</h2>' +
          '<p style="margin:0 0 14px;opacity:.85;line-height:1.5;">Det kan bero på dålig täckning, en annonsblockerare, eller att QR-appens inbyggda webbläsare blockerar delar av sidan.</p>' +
          '<ul style="margin:0 0 18px;padding-left:20px;opacity:.85;line-height:1.6;">' +
            '<li>Prova knappen nedan.</li>' +
            '<li>Öppna annars länken i din vanliga webbläsare (Safari eller Chrome) i stället för QR-appens.</li>' +
            '<li>Stäng av ev. annonsblockerare för den här sidan.</li>' +
          '</ul>' +
          '<button id="wd-retry" style="display:block;width:100%;padding:14px;font-size:17px;font-weight:700;border-radius:12px;border:none;background:#003660;color:#fff;cursor:pointer;">Försök igen</button>' +
          (lastError
            ? '<p style="margin:18px 0 0;font-size:12px;opacity:.6;word-break:break-word;">Teknisk info: ' +
              String(lastError).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</p>'
            : '') +
        '</div>';
      var btn = document.getElementById('wd-retry');
      if (btn) btn.addEventListener('click', function () { location.reload(); });
    }, DEADLINE_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', arm);
  } else {
    arm();
  }
})();
