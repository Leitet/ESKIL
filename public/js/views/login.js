import { sendMagicLink } from '../auth.js';
import { toast } from '../utils.js';
import { icon } from '../icons.js';

export function renderLogin(app) {
  app.innerHTML = '';
  const splash = document.createElement('div');
  splash.className = 'splash';
  splash.innerHTML = `
    <div class="splash-pattern"></div>
    <div class="splash-inner">
      <img class="splash-logo" src="/assets/logo-scouterna-tagline-white.svg" alt="Scouterna — raised by adventure" width="320">
      <div class="t-over eyebrow" style="margin-top: var(--sp-8);">ESKIL · Scouttävlingssystem</div>
      <h1>Raised by <em>adventure.</em></h1>
      <p class="lede">ESKIL hjälper dig att köra scouttävlingar — från Älghornsjakten till DM. Patruller, kontroller, poängrapportering — samlat på ett ställe.</p>

      <div class="login-card">
        <h2 class="t-h2" style="margin-top:0;color:var(--scout-blue);">Logga in</h2>
        <p class="muted" style="margin-top:6px;">Vi skickar en inloggningslänk till din e-post. Ingen lösenord.</p>
        <form id="magic-form" style="margin-top:16px;">
          <label class="field" for="email">E-postadress</label>
          <input class="input" id="email" name="email" type="email" required autocomplete="email" placeholder="din@adress.se">
          <button class="btn btn-primary btn-block" style="margin-top:14px;" type="submit">
            Skicka inloggningslänk
          </button>
        </form>
        <div id="sent" style="display:none;margin-top:16px;padding:12px;background:var(--scout-blue-50);border-radius:var(--r-md);color:var(--scout-blue);font-size:14px;">
          <span style="display:inline-flex;align-items:center;gap:8px;">${icon('mail', { size: 18 })}Länk skickad! Kolla din inkorg (och skräpposten). Klicka på länken på samma enhet.</span>
        </div>
      </div>

      <p class="mt-6" style="font-size:13px;color:#a7bccf;">Sessioner sparas på enheten — du behöver bara logga in igen om du loggar ut manuellt eller rensar webbläsardata.</p>
    </div>
  `;

  const form = splash.querySelector('#magic-form');
  const sent = splash.querySelector('#sent');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    if (!email) return;
    const btn = form.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Skickar…';
    try {
      await sendMagicLink(email);
      sent.style.display = 'block';
      btn.textContent = 'Länk skickad';
      await maybeShowEmulatorLink(email, sent);
    } catch (err) {
      console.error(err);
      toast('Kunde inte skicka länk: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Skicka inloggningslänk';
    }
  });

  app.appendChild(splash);
}

// Emulator-only dev convenience: fetch the latest magic link from the Auth
// emulator and render it as a clickable button so you don't have to dig
// through the emulator UI. Silent no-op when running against real Firebase.
async function maybeShowEmulatorLink(email, sentEl) {
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!isLocal) return;
  const url = `http://${location.hostname}:9099/emulator/v1/projects/demo-eskil/oobCodes`;
  try {
    // The emulator sometimes lags a beat — retry briefly.
    for (let i = 0; i < 8; i++) {
      const r = await fetch(url);
      if (r.ok) {
        const { oobCodes = [] } = await r.json();
        const match = [...oobCodes].reverse().find(c =>
          c.email?.toLowerCase() === email.toLowerCase() && c.requestType === 'EMAIL_SIGNIN'
        );
        if (match?.oobLink) {
          sentEl.innerHTML = `
            <span style="display:inline-flex;align-items:center;gap:8px;">${icon('flask', { size: 18 })}<strong>Emulator-läge upptäckt.</strong></span> Ingen riktig e-post skickas — klicka här för att slutföra inloggning:<br>
            <a href="${match.oobLink}" style="display:inline-flex;align-items:center;gap:6px;margin-top:10px;padding:10px 16px;background:var(--scout-blue);color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Öppna inloggningslänken ${icon('arrow-right', { size: 16 })}</a>
          `;
          return;
        }
      }
      await new Promise(r => setTimeout(r, 250));
    }
  } catch { /* emulator not running — fall back to the default toast */ }
}
