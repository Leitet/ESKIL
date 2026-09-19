// eskilscout.se/overlamning — en NY arrangör löser in överlämningskoden ur
// förra arrangörens tävlingsrapport och får en färdig tävling för nästa år.
//
// Två steg, och ordningen är säkerhetsmodellen:
//   1. Koden + e-postadressen -> en inloggningslänk i mejlen. Koden sparas i
//      webbläsaren under tiden; app.js skickar tillbaka hit efter inloggningen.
//   2. Inloggad -> servern (losInOverlamningskod) skapar tävlingen åt den
//      VERIFIERADE adressen i inloggningen, aldrig åt en adress ur ett formulär.
// Utan steg 1 hade ett stavfel i adressen skapat en tävling åt ingen och bränt
// en kod som står tryckt i en rapport.

import { escapeHtml, toast, withBusy } from '../utils.js';
import { icon } from '../icons.js';
import { publikHeader, publikFooter } from '../publik-nav.js';
import { setDocTitle } from '../nav.js';
import { setSeo } from '../seo.js';
import { navigate } from '../router.js';
import { sendMagicLink } from '../auth.js';
import { functions, httpsCallable } from '../firebase.js';
import { arGiltigKod, formateraKod, normKod, KOD_LANGD } from '../overlamningskod.js';
import { OVERLAMNING_ARRANGOR } from '../utvardering.js';

export const VANTANDE_KOD = 'eskil:overlamningskod';
const GILTIG_MS = 60 * 60 * 1000;

// Koden som väntar på att inloggningen blir klar. Tidsbunden: en kvarglömd
// nyckel får inte skicka hit användaren vid varje inloggning för alltid.
export function vantandeKod() {
  try {
    const p = JSON.parse(localStorage.getItem(VANTANDE_KOD) || 'null');
    if (p && arGiltigKod(p.kod) && Date.now() - p.at < GILTIG_MS) return p.kod;
    localStorage.removeItem(VANTANDE_KOD);
  } catch { /* privat läge */ }
  return null;
}
const sparaVantande = (kod) => { try { localStorage.setItem(VANTANDE_KOD, JSON.stringify({ kod, at: Date.now() })); } catch { /* privat läge */ } };
const glomVantande = () => { try { localStorage.removeItem(VANTANDE_KOD); } catch { /* privat läge */ } };

export function renderOverlamning(app, user, kodFranUrl = '') {
  setDocTitle('Ta över en tävling');
  // noindex: sidan är till för den som fått en kod, inte för sökmotorer.
  setSeo({ sokvag: '/overlamning', titel: 'Ta över en tävling — ESKIL', noindex: true,
           description: 'Lös in överlämningskoden från förra arrangörens tävlingsrapport och få en färdig tävling för nästa år.' });

  const forifylld = arGiltigKod(kodFranUrl) ? formateraKod(kodFranUrl) : (vantandeKod() ? formateraKod(vantandeKod()) : '');
  const inloggad = !!user && !user.demoViewer;

  app.innerHTML = `
    ${publikHeader({ titel: 'Ta över en tävling',
      ingress: 'Har du fått en överlämningskod av förra arrangören? Lös in den här, så får du en färdig tävling för nästa år — med kontroller, bana, inställningar och deras utvärdering.' })}
    <main class="page page-narrow">
      <form class="card" id="ovl-form" novalidate>
        <div class="field-group">
          <div>
            <label class="field" for="ovl-kod">Överlämningskod</label>
            <input class="input ovl-kod-input" id="ovl-kod" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false"
                   maxlength="20" placeholder="XXXX-XXXX-XXXX" value="${escapeHtml(forifylld)}">
            <div class="field-hint">Koden står i tävlingsrapporten, i kapitlet "Överlämning till nästa arrangör". Tolv tecken — bokstäver och siffror, aldrig I, O, 0 eller 1.</div>
          </div>
          ${inloggad ? `
            <p class="muted" style="margin:0;">Inloggad som <strong>${escapeHtml(user.email || '')}</strong>. Tävlingen skapas med den adressen som administratör.</p>
          ` : `
            <div>
              <label class="field" for="ovl-epost">Din e-postadress</label>
              <input class="input" id="ovl-epost" type="email" autocomplete="email" placeholder="din@adress.se">
              <div class="field-hint">Vi skickar en inloggningslänk dit. När du klickar på den skapas tävlingen — med den adressen som administratör. Inget konto behöver finnas i förväg.</div>
            </div>
          `}
          <div id="ovl-besked" role="status" aria-live="polite"></div>
          <div class="btn-row">
            <button class="btn btn-primary" type="submit" id="ovl-go">${inloggad ? 'Skapa tävlingen' : 'Skicka inloggningslänk'}</button>
            ${inloggad ? '<a class="btn btn-ghost" href="/app" data-link id="ovl-avbryt">Avbryt</a>' : ''}
          </div>
        </div>
      </form>

      <section class="card mt-6">
        <h2 class="t-h3" style="margin-top:0;">Det här får du</h2>
        <ul class="utv-lista">${OVERLAMNING_ARRANGOR.foljerMed.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
        <h3 class="utv-foreg-rubrik">Det här får du inte</h3>
        <ul class="utv-lista">${OVERLAMNING_ARRANGOR.foljerInteMed.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
        <p class="muted t-sm" style="margin-bottom:0;">Du blir ensam administratör för den nya tävlingen. Förra arrangörens tävling rör du aldrig — den ligger kvar hos dem som arkiv.</p>
      </section>
    </main>
    ${publikFooter()}`;

  const form = app.querySelector('#ovl-form');
  const kodInput = form.querySelector('#ovl-kod');
  const besked = form.querySelector('#ovl-besked');
  const visa = (text, sort = 'info') => {
    besked.innerHTML = text ? `<div class="ovl-besked ovl-${sort}">${icon(sort === 'fel' ? 'triangle-alert' : sort === 'ok' ? 'check' : 'info', { size: 16 })}<span>${text}</span></div>` : '';
  };

  // Formatera medan man skriver: versaler och bindestreck på rätt ställe.
  kodInput.addEventListener('input', () => {
    const n = normKod(kodInput.value).slice(0, KOD_LANGD);
    kodInput.value = formateraKod(n);
  });
  form.querySelector('#ovl-avbryt')?.addEventListener('click', glomVantande);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const knapp = form.querySelector('#ovl-go');
    const kod = kodInput.value;
    if (!arGiltigKod(kod)) { visa('Koden ska vara tolv tecken, skriven som XXXX-XXXX-XXXX. Den innehåller aldrig I, O, 0 eller 1 — kontrollera mot rapporten.', 'fel'); kodInput.focus(); return; }

    if (!inloggad) {
      const epost = form.querySelector('#ovl-epost').value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(epost)) { visa('Skriv din e-postadress.', 'fel'); return; }
      withBusy(knapp, 'Skickar…', async () => {
        try {
          sparaVantande(normKod(kod));
          await sendMagicLink(epost);
          visa(`Vi har skickat en inloggningslänk till <strong>${escapeHtml(epost)}</strong>. Öppna den <strong>i den här webbläsaren</strong> — då kommer du tillbaka hit och tävlingen skapas. Koden är inte förbrukad förrän dess.`, 'ok');
        } catch (err) { console.error(err); visa(escapeHtml(err.message || 'Kunde inte skicka länken.'), 'fel'); }
      });
      return;
    }

    withBusy(knapp, 'Skapar tävlingen…', async () => {
      try {
        const res = await httpsCallable(functions, 'losInOverlamningskod')({ kod: normKod(kod) });
        glomVantande();
        toast(`Tävlingen "${res.data.name}" är skapad`, 'success');
        navigate(`/app/c/${res.data.cid}/settings`);
      } catch (err) {
        console.error(err);
        // Fel kod är användarens att rätta — glöm den, annars skickas de hit igen.
        if (err.code === 'functions/not-found') glomVantande();
        visa(escapeHtml(err.message || 'Tävlingen kunde inte skapas.'), 'fel');
      }
    });
  });
}
