// Super-admin: inkorgen för meddelanden från kontaktformuläret på /kontakt.
//
// Svaret skrivs HÄR, inte i mailklienten. Notismailet till super-admins har
// därför inget Reply-To: en Cloud Function (onFeedbackReplyCreated) skickar
// svaret som mail FRÅN ESKIL, så att ingen super-admins privata adress hamnar
// i inkorgen hos en utomstående.
//
// Avsändaren har ingen inloggning men når SIN egen tråd via den hemliga
// länken /kontakt/<fbId> och kan svara där. Därför innehåller trådhuvudet
// bara sådant hen själv skrivit — det interna (vilken super-admin som svarat
// och hanterat) ligger i private/meta, som bara super-admin når. Regler kan
// inte dölja enskilda fält, så uppdelningen ÄR skyddet.

import { layout } from '../app.js';
import { watchFeedback, watchFeedbackMessages, watchFeedbackMeta, sendFeedbackMessage, setFeedbackStatus, markFeedbackRead } from '../store.js';
import { escapeHtml } from '../utils.js';
import { icon } from '../icons.js';
import { crumbs, setDocTitle } from '../nav.js';
import { navigate } from '../router.js';

const SORT = {
  forslag: { label: 'Förbättringsförslag', färg: 'var(--upp-blue)' },
  fel: { label: 'Något fungerar inte', färg: 'var(--utm-pink)' },
  fraga: { label: 'Fråga', färg: 'var(--avent-orange)' },
  annat: { label: 'Annat', färg: 'var(--gray-500)' }
};
const STATUS = {
  ny: { label: 'Ny', klass: 'badge-green' },
  besvarad: { label: 'Besvarad', klass: 'badge-blue' },
  stangd: { label: 'Avslutad', klass: '' }
};

const tid = (ts) => {
  const d = ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : null);
  if (!d) return '';
  return d.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
};

export function renderAdminFeedback(app, user) {
  if (user?.role !== 'super-admin') {
    navigate('/app', true);
    return;
  }

  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="card"><div class="muted">Laddar meddelanden…</div></div>`;
  layout(wrap, { narrow: true });
  setDocTitle('Meddelanden till ESKIL');

  let poster = [];
  let öppen = null;              // id på det meddelande som är utfällt
  let svar = [];                 // hela samtalet i det öppna ärendet
  let meta = {};                 // private/meta — vem som svarat och hanterat
  let svarStopp = [];
  let filter = 'oppna';          // 'oppna' | 'alla'

  const unsub = watchFeedback(rows => { poster = rows; rita(); });

  function rita() {
    const synliga = filter === 'alla' ? poster : poster.filter(p => p.status !== 'stangd');
    const nya = poster.filter(p => p.status === 'ny').length;

    wrap.innerHTML = `
      <div class="page-head">
        <div>
          ${crumbs([
            { label: 'Tävlingar', href: '/app' },
            { label: 'Konto', href: '/app/settings' },
            { label: 'Meddelanden' }
          ])}
          <h1 class="t-d2">Meddelanden till ESKIL</h1>
          <p class="muted">Det som skickas via kontaktformuläret på
          <a href="/kontakt" data-link>eskilscout.se/kontakt</a>. Svara härifrån —
          svaret går ut från ESKIL, inte från din egen adress.</p>
        </div>
        <div class="btn-row"><a class="btn btn-ghost btn-sm" href="/app/admin/system" data-link>Systemhubb</a></div>
      </div>

      <div class="fb-filter">
        <button type="button" class="${filter === 'oppna' ? 'active' : ''}" data-filter="oppna">
          Öppna${nya ? ` · ${nya} ny${nya === 1 ? 'tt' : 'a'}` : ''}
        </button>
        <button type="button" class="${filter === 'alla' ? 'active' : ''}" data-filter="alla">Alla · ${poster.length}</button>
      </div>

      ${synliga.length ? synliga.map(kort).join('') : `
        <div class="empty">
          <h3>${filter === 'alla' ? 'Inga meddelanden än' : 'Inget öppet just nu'}</h3>
          <p>Meddelanden från kontaktformuläret hamnar här.</p>
        </div>`}
    `;

    wrap.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => {
      filter = b.dataset.filter; rita();
    }));
    wrap.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.open;
      öppen = öppen === id ? null : id;
      lyssnaPåSvar();
      // Läskvittot är för de andra super-adminsen: två personer ska inte
      // sitta och svara på samma meddelande utan att veta om varandra.
      if (öppen) markFeedbackRead(id).catch(() => {});
      rita();
    }));
    kopplaÖppet();
  }

  function kort(p) {
    const s = SORT[p.kind] || SORT.annat;
    const st = STATUS[p.status] || STATUS.ny;
    const utfälld = öppen === p.id;
    return `
      <div class="card fb-card${p.status === 'ny' ? ' is-new' : ''}">
        <button type="button" class="fb-head" data-open="${escapeHtml(p.id)}" aria-expanded="${utfälld}">
          <div class="fb-head-main">
            <div class="fb-meta">
              <span class="fb-kind" style="--fb-color:${s.färg};">${escapeHtml(s.label)}</span>
              <span class="badge ${st.klass}">${escapeHtml(st.label)}</span>
              ${p.replyCount ? `<span class="muted t-sm">${p.replyCount} svar</span>` : ''}
            </div>
            <div class="fb-from">${escapeHtml(p.name || p.email || '')}${
              p.lastFrom === 'anvandare' && p.replyCount ? ' <span class="fb-nytt">svarade</span>' : ''}</div>
            <div class="fb-preview">${escapeHtml((p.message || '').slice(0, 120))}${(p.message || '').length > 120 ? '…' : ''}</div>
          </div>
          <div class="fb-head-side">
            <span class="muted t-sm mono">${escapeHtml(tid(p.at))}</span>
            ${icon(utfälld ? 'chevron-up' : 'chevron-down', { size: 18 })}
          </div>
        </button>
        ${utfälld ? kropp(p) : ''}
      </div>`;
  }

  function kropp(p) {
    return `
      <div class="fb-body">
        <div class="fb-msg">${escapeHtml(p.message || '')}</div>
        <div class="fb-facts">
          <div><span class="muted t-sm">Avsändare</span><strong>${escapeHtml(p.email || '')}</strong></div>
          ${meta.accountEmail && meta.accountEmail !== p.email
            ? `<div><span class="muted t-sm">Inloggad som</span><strong>${escapeHtml(meta.accountEmail)}</strong></div>` : ''}
          ${meta.readAt ? `<div><span class="muted t-sm">Läst</span><strong>${escapeHtml(tid(meta.readAt))}</strong></div>` : ''}
          ${p.faltReadAt ? `<div><span class="muted t-sm">Avsändaren öppnade</span><strong>${escapeHtml(tid(p.faltReadAt))}</strong></div>` : ''}
          ${meta.handledBy ? `<div><span class="muted t-sm">Hanterad av</span><strong>${escapeHtml(meta.handledBy)}</strong></div>` : ''}
        </div>

        ${svar.length ? `
          <div class="fb-replies">
            ${svar.map(r => `
              <div class="fb-reply${r.from === 'anvandare' ? ' fb-reply-in' : ''}">
                <div class="fb-reply-head">${r.from === 'eskil'
                  ? escapeHtml(meta.authors?.[r.id] || 'ESKIL')
                  : escapeHtml(p.name || p.email || 'Avsändaren')} · ${escapeHtml(tid(r.at))}</div>
                <div>${escapeHtml(r.text || '')}</div>
              </div>`).join('')}
          </div>` : ''}

        <label class="field" for="fb-text" style="margin-top:var(--sp-5);">Svar</label>
        <textarea class="textarea" id="fb-text" rows="5" maxlength="5000"
          placeholder="Skriv svaret här. Det mailas till ${escapeHtml(p.email || '')} från ESKIL — din egen adress syns inte."></textarea>
        <p class="fb-err" id="fb-err" hidden></p>
        <div class="btn-row" style="margin-top:var(--sp-4);justify-content:space-between;">
          <button class="btn btn-primary btn-sm" id="fb-send">${icon('send', { size: 15 })} Skicka svar</button>
          <button class="btn btn-ghost btn-sm" id="fb-status">
            ${p.status === 'stangd' ? 'Öppna igen' : 'Markera som avslutad'}
          </button>
        </div>
      </div>`;
  }

  function lyssnaPåSvar() {
    svarStopp.forEach(f => { try { f(); } catch {} });
    svarStopp = [];
    svar = []; meta = {};
    if (!öppen) return;
    svarStopp = [
      watchFeedbackMessages(öppen, rows => { svar = rows; if (öppen) rita(); }),
      watchFeedbackMeta(öppen, m => { meta = m || {}; if (öppen) rita(); })
    ];
  }

  function kopplaÖppet() {
    const p = poster.find(x => x.id === öppen);
    if (!p) return;
    const ta = wrap.querySelector('#fb-text');
    const fel = wrap.querySelector('#fb-err');
    const visaFel = (m) => { fel.textContent = m; fel.hidden = false; };

    wrap.querySelector('#fb-send')?.addEventListener('click', async (e) => {
      const text = ta.value.trim();
      if (!text) { visaFel('Skriv ett svar först.'); ta.focus(); return; }
      const b = e.currentTarget;
      b.disabled = true; b.textContent = 'Skickar…';
      try {
        await sendFeedbackMessage(p.id, 'eskil', text);
        ta.value = '';
        fel.hidden = true;
        // Snapshoten ritar om med svaret; status och räknare stämplas av
        // funktionen som skickar mailet.
      } catch (err) {
        visaFel('Kunde inte skicka: ' + (err?.message || err));
        b.disabled = false;
        b.innerHTML = `${icon('send', { size: 15 })} Skicka svar`;
      }
    });

    wrap.querySelector('#fb-status')?.addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try { await setFeedbackStatus(p.id, p.status === 'stangd' ? 'besvarad' : 'stangd'); }
      catch (err) { visaFel('Kunde inte ändra status: ' + (err?.message || err)); b.disabled = false; }
    });
  }

  // Städa när vyn byts ut.
  const observer = new MutationObserver(() => {
    if (!wrap.isConnected) { unsub?.(); svarStopp.forEach(f => { try { f(); } catch {} }); observer.disconnect(); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
