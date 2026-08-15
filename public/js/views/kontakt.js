// Publik kontaktsida på /kontakt — vem som helst kan skriva till ESKIL.
//
// Meddelandet skrivs INTE direkt till Firestore. Det går via den anropbara
// funktionen sendFeedback, som stryper per adress och mot dygnskvoten innan
// admin-SDK:n skriver. En anonymt skrivbar toppnivåkollektion vore en öppen
// kran rakt in i databasen, och rules kan inte räkna anrop.
//
// Bekräftelsen och felen visas PÅ PLATS, inte som toast: den som just skrivit
// ett långt meddelande ska se vad som hände med det utan att jaga en ruta som
// försvinner efter tre sekunder.

import { escapeHtml } from '../utils.js';
import { icon } from '../icons.js';
import { setDocTitle } from '../nav.js';

const SORTER = [
  { id: 'forslag', label: 'Förbättringsförslag', hint: 'Något som skulle göra ESKIL bättre' },
  { id: 'fel', label: 'Något fungerar inte', hint: 'En bugg eller ett fel du stött på' },
  { id: 'fraga', label: 'Fråga', hint: 'Undrar du över något?' },
  { id: 'annat', label: 'Annat', hint: '' }
];

const UTKAST = 'eskil:kontakt-utkast';

export function renderKontakt(app, user) {
  setDocTitle('Kontakta ESKIL');
  document.title = 'Kontakta ESKIL';

  let utkast = {};
  try { utkast = JSON.parse(sessionStorage.getItem(UTKAST) || '{}'); } catch { /* privat läge */ }
  const epost = utkast.email || user?.email || '';

  app.innerHTML = `
    <header class="pub-hero pub-hero-slim">
      <div class="page">
        <a class="pub-back" href="/" data-link>${icon('arrow-left', { size: 15 })} ESKIL:s startsida</a>
        <h1 class="t-d2">Skriv till oss</h1>
        <p class="lede">Har du ett förbättringsförslag, hittat ett fel eller undrar över något?
        Meddelandet går till dem som ansvarar för ESKIL, och du får svar på adressen du anger.</p>
      </div>
    </header>

    <main class="page page-narrow">
      <form class="card" id="kontakt-form" novalidate>
        <div class="field-group">
          <div>
            <label class="field">Vad gäller det?</label>
            <div class="kontakt-kinds" id="kontakt-kinds">
              ${SORTER.map((k, i) => `
                <button type="button" class="kontakt-kind${(utkast.kind || 'forslag') === k.id || (!utkast.kind && i === 0 && false) ? '' : ''}" data-kind="${k.id}">
                  <span class="kk-label">${escapeHtml(k.label)}</span>
                  ${k.hint ? `<span class="kk-hint">${escapeHtml(k.hint)}</span>` : ''}
                </button>`).join('')}
            </div>
          </div>

          <div class="grid grid-2">
            <div>
              <label class="field" for="k-name">Ditt namn <span class="muted">(frivilligt)</span></label>
              <input class="input" id="k-name" maxlength="120" autocomplete="name"
                value="${escapeHtml(utkast.name || '')}" placeholder="Så vi vet vem vi svarar">
            </div>
            <div>
              <label class="field" for="k-email">Din e-postadress</label>
              <input class="input" id="k-email" type="email" maxlength="160" autocomplete="email"
                value="${escapeHtml(epost)}" placeholder="namn@exempel.se" required>
              <div class="field-hint">Svaret skickas hit. Adressen används inte till något annat.</div>
            </div>
          </div>

          <div>
            <label class="field" for="k-message">Meddelande</label>
            <textarea class="textarea" id="k-message" rows="7" maxlength="4000"
              placeholder="Skriv så utförligt du vill. Gäller det ett fel hjälper det att veta var i ESKIL du var och vad du gjorde.">${escapeHtml(utkast.message || '')}</textarea>
            <div class="field-hint"><span id="k-count">0</span> / 4000 tecken</div>
          </div>
        </div>

        <p class="kontakt-err" id="k-err" hidden></p>

        <div class="btn-row" style="margin-top:var(--sp-5);">
          <button class="btn btn-primary" type="submit" id="k-send">${icon('send', { size: 16 })} Skicka meddelandet</button>
        </div>
        <p class="muted t-sm" style="margin:var(--sp-4) 0 0;">Namnet, adressen och meddelandet sparas i ESKIL tills ärendet är avslutat.
        Se <a href="/integritet">Integritet &amp; GDPR</a>.</p>
      </form>
    </main>
  `;

  let kind = utkast.kind || 'forslag';
  const märk = () => app.querySelectorAll('[data-kind]').forEach(b =>
    b.classList.toggle('active', b.dataset.kind === kind));
  app.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => {
    kind = b.dataset.kind; märk(); spara();
  }));
  märk();

  const namn = app.querySelector('#k-name');
  const post = app.querySelector('#k-email');
  const text = app.querySelector('#k-message');
  const räknare = app.querySelector('#k-count');
  const fel = app.querySelector('#k-err');

  // Utkastet ligger i sessionStorage: ett långt meddelande ska inte
  // försvinna för att någon råkade backa eller ladda om.
  const spara = () => {
    try {
      sessionStorage.setItem(UTKAST, JSON.stringify({
        kind, name: namn.value, email: post.value, message: text.value
      }));
    } catch { /* privat läge */ }
  };
  const räkna = () => { räknare.textContent = text.value.length; };
  [namn, post, text].forEach(f => f.addEventListener('input', () => { spara(); räkna(); }));
  räkna();

  const visaFel = (msg) => { fel.textContent = msg; fel.hidden = false; };

  app.querySelector('#kontakt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    fel.hidden = true;
    const email = post.value.trim().toLowerCase();
    const message = text.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      visaFel('Ange en giltig e-postadress så vi kan svara.'); post.focus(); return;
    }
    if (message.length < 10) {
      visaFel('Skriv några rader till så vi förstår vad du menar.'); text.focus(); return;
    }

    const knapp = app.querySelector('#k-send');
    knapp.disabled = true;
    knapp.textContent = 'Skickar…';
    try {
      const { functions, httpsCallable } = await import('../firebase.js');
      await httpsCallable(functions, 'sendFeedback')({ email, name: namn.value.trim(), kind, message });
      try { sessionStorage.removeItem(UTKAST); } catch { /* privat läge */ }
      app.querySelector('#kontakt-form').outerHTML = `
        <div class="card kontakt-tack">
          <div class="kontakt-tack-ikon">${icon('check', { size: 30 })}</div>
          <h2 class="t-h2" style="margin:0;">Tack — meddelandet är framme</h2>
          <p>Vi hör av oss till <strong>${escapeHtml(email)}</strong>. Svaret kommer från ESKIL,
          så håll utkik även i skräpposten.</p>
          <div class="btn-row"><a class="btn btn-ghost" href="/" data-link>Till startsidan</a></div>
        </div>`;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      knapp.disabled = false;
      knapp.innerHTML = `${icon('send', { size: 16 })} Skicka meddelandet`;
      visaFel(err?.message || 'Kunde inte skicka just nu. Försök igen om en stund.');
    }
  });
}
