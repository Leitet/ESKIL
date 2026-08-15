// Samtalspanelen på fältsidorna — kontrollens rapportsida (/k) och
// patrullens startkort (/s) använder samma.
//
// Den ligger i en egen modul av två skäl: båda sidorna ska bete sig likadant
// (en kontrollant som fått hjälp en gång ska känna igen sig på nästa
// tävling), och nattläget måste hålla på båda — panelen ärver report.css
// variabler och sätter inga egna färger.
//
// Bilder skickas som nedskalade data-URL:er, se photo.js.

import { escapeHtml } from './utils.js';
import { icon } from './icons.js';
import { watchThread, watchThreadDoc, sendThreadMessage, markThreadRead } from './store.js';
import { pickImage } from './photo.js';

const klocka = (ts) => {
  if (!ts) return '';
  const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
};

/**
 * @param host   elementet panelen ritas i
 * @param opts   { cid, kind: 'kontroll'|'patrull', refId, enabled, title }
 * @returns      { destroy() }
 */
export function mountChat(host, { cid, kind, refId, enabled = true, title = 'Fråga tävlingsledningen' } = {}) {
  if (!host) return { destroy() {} };
  if (!enabled) { host.innerHTML = ''; return { destroy() {} }; }

  let meddelanden = [];
  let bild = null;              // { dataUrl, bytes } — vald men inte skickad
  let öppen = false;
  let oläst = 0;
  const unsubs = [];

  host.innerHTML = `
    <section class="chat">
      <button type="button" class="chat-toggle" id="chat-toggle" aria-expanded="false">
        ${icon('message-circle', { size: 17 })}
        <span class="chat-toggle-text">${escapeHtml(title)}</span>
        <span class="chat-badge" id="chat-badge" hidden>0</span>
        <span class="chat-chev" id="chat-chev">▾</span>
      </button>
      <div class="chat-body" id="chat-body" hidden>
        <div class="chat-log" id="chat-log"></div>
        <div class="chat-attach" id="chat-attach" hidden>
          <img id="chat-attach-img" alt="Vald bild">
          <button type="button" class="chat-attach-x" id="chat-attach-x" aria-label="Ta bort bilden">${icon('x', { size: 15 })}</button>
        </div>
        <div class="chat-compose">
          <textarea class="chat-input" id="chat-text" rows="2" maxlength="2000"
            placeholder="Skriv din fråga…"></textarea>
          <div class="chat-actions">
            <button type="button" class="chat-photo" id="chat-photo" aria-label="Bifoga bild">
              ${icon('camera', { size: 18 })}<span>Bild</span>
            </button>
            <button type="button" class="chat-send" id="chat-send">Skicka</button>
          </div>
        </div>
        <p class="chat-hint" id="chat-hint">Tävlingsledningen ser frågan direkt och svarar här.</p>
      </div>
    </section>`;

  const $ = (id) => host.querySelector('#' + id);
  const log = $('chat-log');
  const badge = $('chat-badge');
  const attach = $('chat-attach');

  const ritaLogg = () => {
    if (!meddelanden.length) {
      log.innerHTML = `<p class="chat-empty">Ingen kontakt än. Skriv en fråga så svarar tävlingsledningen här.</p>`;
      return;
    }
    const nereVid = log.scrollHeight - log.scrollTop - log.clientHeight;
    log.innerHTML = meddelanden.map(m => `
      <div class="chat-msg ${m.from === 'falt' ? 'chat-mine' : 'chat-theirs'}">
        ${m.image ? `<img class="chat-img" src="${escapeHtml(m.image)}" alt="Bifogad bild" loading="lazy">` : ''}
        ${m.text ? `<div class="chat-text">${escapeHtml(m.text)}</div>` : ''}
        <div class="chat-meta">${m.from === 'falt' ? 'Du' : 'Tävlingsledningen'} · ${klocka(m.at)}${m._pending ? ' · skickar…' : ''}</div>
      </div>`).join('');
    // Håll oss kvar längst ner om vi redan var där — annars rycker vyn ifrån
    // den som scrollat upp för att läsa något äldre.
    if (nereVid < 60) log.scrollTop = log.scrollHeight;
  };

  const uppdateraBadge = () => {
    badge.hidden = oläst === 0 || öppen;
    badge.textContent = String(oläst);
    host.querySelector('.chat-toggle')?.classList.toggle('has-unread', oläst > 0 && !öppen);
  };

  unsubs.push(watchThread(cid, kind, refId, rows => {
    meddelanden = rows;
    ritaLogg();
  }));
  unsubs.push(watchThreadDoc(cid, kind, refId, t => {
    // Oläst = ledningen har skrivit senast, och senare än vår läskvittens.
    const sist = t?.lastAt?.toDate?.() || null;
    const läst = t?.faltReadAt?.toDate?.() || null;
    oläst = (t?.lastFrom === 'ledning' && sist && (!läst || sist > läst)) ? 1 : 0;
    if (öppen && oläst) { markThreadRead(cid, kind, refId, 'falt').catch(() => {}); oläst = 0; }
    uppdateraBadge();
  }));

  const sättÖppen = (på) => {
    öppen = på;
    $('chat-body').hidden = !på;
    $('chat-chev').textContent = på ? '▴' : '▾';
    host.querySelector('.chat-toggle').setAttribute('aria-expanded', på ? 'true' : 'false');
    if (på) {
      log.scrollTop = log.scrollHeight;
      if (oläst) { markThreadRead(cid, kind, refId, 'falt').catch(() => {}); oläst = 0; }
    }
    uppdateraBadge();
  };
  host.querySelector('.chat-toggle').addEventListener('click', () => sättÖppen(!öppen));

  const visaBild = () => {
    attach.hidden = !bild;
    if (bild) $('chat-attach-img').src = bild.dataUrl;
  };
  $('chat-photo').addEventListener('click', async () => {
    try {
      const vald = await pickImage({ camera: true });
      if (vald) { bild = vald; visaBild(); }
    } catch (e) {
      $('chat-hint').textContent = e.message;
    }
  });
  $('chat-attach-x').addEventListener('click', () => { bild = null; visaBild(); });

  $('chat-send').addEventListener('click', async () => {
    const text = $('chat-text').value.trim();
    if (!text && !bild) return;
    const knapp = $('chat-send');
    knapp.disabled = true;
    try {
      await sendThreadMessage(cid, kind, refId, { from: 'falt', text, image: bild?.dataUrl || null });
      $('chat-text').value = '';
      bild = null; visaBild();
      $('chat-hint').textContent = 'Tävlingsledningen ser frågan direkt och svarar här.';
    } catch (e) {
      // Offline hamnar skrivningen i Firestores lokala kö och går fram sedan;
      // det här är riktiga fel, t.ex. att funktionen stängts av.
      $('chat-hint').textContent = 'Kunde inte skicka: ' + (e?.message || e);
    } finally {
      knapp.disabled = false;
    }
  });

  ritaLogg();
  return {
    destroy() { unsubs.forEach(u => { try { u(); } catch {} }); host.innerHTML = ''; }
  };
}
