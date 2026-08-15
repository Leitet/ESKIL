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
import { watchFeedbackThread, watchFeedbackMessages, sendFeedbackMessage, markFeedbackSeenByUser } from '../store.js';

const SORTER = [
  { id: 'forslag', label: 'Förbättringsförslag', hint: 'Något som skulle göra ESKIL bättre' },
  { id: 'fel', label: 'Något fungerar inte', hint: 'En bugg eller ett fel du stött på' },
  { id: 'fraga', label: 'Fråga', hint: 'Undrar du över något?' },
  { id: 'annat', label: 'Annat', hint: '' }
];

const UTKAST = 'eskil:kontakt-utkast';
// Senaste ärendet, så den som kommer tillbaka till formuläret hittar sin tråd
// utan att leta i mailen. Bara id:t — inget innehåll ligger i webbläsaren.
const SENASTE = 'eskil:kontakt-arende';

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
      <div id="kontakt-pagaende"></div>
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

  // Har man ett pågående ärende sedan tidigare, erbjud det i stället för att
  // låta personen skriva samma sak igen i en ny tråd.
  let senaste = null;
  try { senaste = localStorage.getItem(SENASTE); } catch { /* privat läge */ }
  if (senaste) {
    app.querySelector('#kontakt-pagaende').innerHTML = `
      <div class="card kontakt-pagaende">
        <div>
          <strong>Du har ett pågående ärende hos oss.</strong>
          <p class="muted t-sm" style="margin:2px 0 0;">Fortsätt där i stället för att börja om — då ser vi hela sammanhanget.</p>
        </div>
        <a class="btn btn-secondary btn-sm" href="/kontakt/${escapeHtml(senaste)}" data-link>Öppna ärendet</a>
      </div>`;
  }

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
      const res = await httpsCallable(functions, 'sendFeedback')({ email, name: namn.value.trim(), kind, message });
      const id = res?.data?.id;
      try {
        sessionStorage.removeItem(UTKAST);
        if (id) localStorage.setItem(SENASTE, id);
      } catch { /* privat läge */ }
      app.querySelector('#kontakt-form').outerHTML = `
        <div class="card kontakt-tack">
          <div class="kontakt-tack-ikon">${icon('check', { size: 30 })}</div>
          <h2 class="t-h2" style="margin:0;">Tack — meddelandet är framme</h2>
          <p>Vi hör av oss till <strong>${escapeHtml(email)}</strong>. Svaret kommer från ESKIL,
          så håll utkik även i skräpposten.</p>
          ${id ? `
            <p class="muted t-sm">Här är ditt ärende. Länken fungerar tills ärendet avslutas —
            spara den om du vill följa det utan att vänta på mailet.</p>
            <div class="btn-row"><a class="btn btn-primary" href="/kontakt/${escapeHtml(id)}" data-link>Öppna ditt ärende</a>
            <a class="btn btn-ghost" href="/" data-link>Till startsidan</a></div>` : `
            <div class="btn-row"><a class="btn btn-ghost" href="/" data-link>Till startsidan</a></div>`}
        </div>`;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      knapp.disabled = false;
      knapp.innerHTML = `${icon('send', { size: 16 })} Skicka meddelandet`;
      visaFel(err?.message || 'Kunde inte skicka just nu. Försök igen om en stund.');
    }
  });
}

// --- Ärendet: /kontakt/<fbId> -------------------------------------------------
// Id:t ÄR hemligheten, precis som anmälningarnas ändringslänk. Den som har
// länken får läsa tråden och svara i den.
//
// Trådhuvudet innehåller därför bara sådant avsändaren själv skrivit — regler
// kan inte dölja enskilda fält, så vem som svarat från ESKIL ligger i
// private/meta, utom räckhåll för länken. Hela poängen med att svara i ESKIL
// är att super-adminens adress aldrig lämnar systemet.

const SORTNAMN = Object.fromEntries(SORTER.map(s => [s.id, s.label]));

const klocka = (ts) => {
  const d = ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : null);
  return d ? d.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) : '';
};

export function renderKontaktArende(app, fbId) {
  setDocTitle('Ditt ärende');
  document.title = 'Ditt ärende — ESKIL';

  app.innerHTML = `
    <header class="pub-hero pub-hero-slim">
      <div class="page">
        <a class="pub-back" href="/kontakt" data-link>${icon('arrow-left', { size: 15 })} Skriv till oss</a>
        <h1 class="t-d2">Ditt ärende</h1>
      </div>
    </header>
    <main class="page page-narrow" id="ar-body">
      <div class="card"><div class="muted">Hämtar ärendet…</div></div>
    </main>`;

  const body = app.querySelector('#ar-body');
  let tråd = null;
  let poster = [];
  let ritad = false;

  const stoppa = [
    watchFeedbackThread(fbId, t => { tråd = t; rita(); }),
    watchFeedbackMessages(fbId, m => { poster = m; rita(); })
  ];

  function rita() {
    if (tråd === null && ritad) return;   // snapshoten hann inte, behåll vyn
    // Ett stängt eller borttaget ärende ska inte längre skyltas som pågående
    // på formulärsidan — då pekar "Öppna ärendet" på en återvändsgränd.
    if (!tråd || tråd.status === 'stangd') {
      try {
        if (localStorage.getItem(SENASTE) === fbId) localStorage.removeItem(SENASTE);
      } catch { /* privat läge */ }
    }
    if (!tråd) {
      body.innerHTML = `
        <div class="empty">
          <h3>Ärendet hittades inte</h3>
          <p>Länken kan vara felstavad, eller så är ärendet borttaget.
          <a href="/kontakt" data-link>Skriv till oss</a> så tar vi det därifrån.</p>
        </div>`;
      ritad = true;
      return;
    }
    ritad = true;
    const stängt = tråd.status === 'stangd';
    // Behåll det som redan skrivits när snapshoten ritar om.
    const påbörjat = body.querySelector('#ar-text')?.value || '';

    body.innerHTML = `
      <div class="card">
        <div class="ar-topp">
          <span class="fb-kind" style="--fb-color:var(--scout-blue);">${escapeHtml(SORTNAMN[tråd.kind] || 'Meddelande')}</span>
          <span class="muted t-sm">${escapeHtml(klocka(tråd.at))}</span>
        </div>
        <div class="ar-tradd">
          <div class="ar-post ar-min">
            <div class="ar-post-head">Du skrev</div>
            <div class="ar-post-text">${escapeHtml(tråd.message || '')}</div>
          </div>
          ${poster.map(m => `
            <div class="ar-post ${m.from === 'eskil' ? 'ar-eskil' : 'ar-min'}">
              <div class="ar-post-head">${m.from === 'eskil' ? 'ESKIL svarade' : 'Du skrev'} · ${escapeHtml(klocka(m.at))}</div>
              <div class="ar-post-text">${escapeHtml(m.text || '')}</div>
            </div>`).join('')}
        </div>

        ${stängt ? `
          <p class="ar-stangt">Ärendet är avslutat. Behöver du mer hjälp,
          <a href="/kontakt" data-link>skriv till oss igen</a> — då startar vi ett nytt ärende.</p>
        ` : `
          <label class="field" for="ar-text" style="margin-top:var(--sp-6);">Svara</label>
          <textarea class="textarea" id="ar-text" rows="5" maxlength="4000"
            placeholder="Skriv ditt svar här.">${escapeHtml(påbörjat)}</textarea>
          <p class="kontakt-err" id="ar-err" hidden></p>
          <div class="btn-row" style="margin-top:var(--sp-4);">
            <button class="btn btn-primary" id="ar-send">${icon('send', { size: 16 })} Skicka svar</button>
          </div>
          <p class="muted t-sm" style="margin:var(--sp-4) 0 0;">Vi ser svaret direkt och hör av oss
          på ${escapeHtml(tråd.email || 'din adress')}.</p>
        `}
      </div>`;

    const knapp = body.querySelector('#ar-send');
    if (!knapp) return;
    const ta = body.querySelector('#ar-text');
    const fel = body.querySelector('#ar-err');
    knapp.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (text.length < 2) { fel.textContent = 'Skriv något först.'; fel.hidden = false; ta.focus(); return; }
      knapp.disabled = true;
      knapp.textContent = 'Skickar…';
      try {
        await sendFeedbackMessage(fbId, 'anvandare', text);
        ta.value = '';
        fel.hidden = true;
        // Snapshoten ritar om med meddelandet i tråden.
      } catch (e) {
        fel.textContent = 'Kunde inte skicka: ' + (e?.message || e);
        fel.hidden = false;
        knapp.disabled = false;
        knapp.innerHTML = `${icon('send', { size: 16 })} Skicka svar`;
      }
    });
  }

  markFeedbackSeenByUser(fbId).catch(() => { /* kvittot är en bonus */ });

  // Städa lyssnarna när vyn byts ut.
  const obs = new MutationObserver(() => {
    if (!body.isConnected) { stoppa.forEach(f => { try { f(); } catch {} }); obs.disconnect(); }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}
