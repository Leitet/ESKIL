// Meddelandepanelen på fältsidorna — kontrollens rapportsida (/k) och
// patrullens startkort (/s).
//
// EN ikon och EN modal för allt tävlingsledningen sagt. För den som står i
// skogen är skillnaden mellan "driftmeddelande till alla" och "svar på min
// fråga" ointressant: det är samma ledning, samma dag, och det som räknas är
// i vilken ordning det kom. Därför flätas driftmeddelandena (broadcast.js)
// in i samma tidslinje som samtalet, sorterat på tid.
//
// Bannerstacken och larmen ligger kvar i broadcast.js — ett kritiskt
// meddelande ska synas utan att någon öppnar en modal.
//
// Bilder skickas som nedskalade data-URL:er, se photo.js.

import { escapeHtml } from './utils.js';
import { lockScroll, unlockScroll } from './haptic.js';
import { icon } from './icons.js';
import { watchThread, watchThreadDoc, sendThreadMessage, markThreadRead } from './store.js';
import { pickImage } from './photo.js';
import {
  onBroadcastChange, broadcastFeed, broadcastPendingAcks, ackBroadcast,
  notificationState, requestNotifications
} from './broadcast.js';

const klocka = (d) => d
  ? new Date(d).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
  : '';
const tillDatum = (ts) => {
  if (!ts) return null;
  return typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
};

/**
 * @param opts { cid, kind: 'kontroll'|'patrull', refId, enabled }
 *   `enabled` styr BARA om man kan skriva själv — driftmeddelandenas historik
 *   visas alltid, den är inte en tvåvägsfunktion.
 * @returns { destroy() }
 */
export function mountMessages({ cid, kind, refId, enabled = true } = {}) {
  let samtal = [];
  let tråd = null;
  let bild = null;
  let öppen = false;
  const unsubs = [];

  // --- Ikonen -----------------------------------------------------------------
  const knapp = document.createElement('button');
  knapp.id = 'eskil-msg-btn';
  knapp.type = 'button';
  knapp.setAttribute('aria-label', 'Meddelanden');
  document.body.appendChild(knapp);

  // Placeras mätt, inte gissat: till vänster om Nattläge-knappen och nedanför
  // bannerstacken, så de aldrig täcker varandra.
  const placera = () => {
    const toggle = document.querySelector('.mode-toggle');
    knapp.style.right = toggle
      ? Math.round(window.innerWidth - toggle.getBoundingClientRect().left + 10) + 'px'
      : '12px';
    knapp.style.top = ((document.getElementById('eskil-broadcast')?.offsetHeight || 0) + 12) + 'px';
  };

  const oläsraSvar = () => {
    const sist = tillDatum(tråd?.lastAt);
    const läst = tillDatum(tråd?.faltReadAt);
    return (tråd?.lastFrom === 'ledning' && sist && (!läst || sist > läst)) ? 1 : 0;
  };

  const ritaKnapp = () => {
    placera();
    const antal = broadcastPendingAcks() + (öppen ? 0 : oläsraSvar());
    knapp.innerHTML = `${icon('message-circle', { size: 18 })}${antal ? `<span class="emb-badge">${antal}</span>` : ''}`;
    knapp.classList.toggle('has-unread', antal > 0);
  };

  // --- Tidslinjen -------------------------------------------------------------
  // Driftmeddelanden och samtal i ETT flöde, äldst först — som en chatt.
  const tidslinje = () => [
    ...broadcastFeed(),
    ...samtal.map(m => ({
      id: m.id, kind: 'samtal', from: m.from, text: m.text || '',
      image: m.image || null, at: tillDatum(m.at), pending: m._pending
    }))
  ].filter(p => p.at).sort((a, b) => a.at - b.at);

  let overlay = null;
  const ritaPanel = () => {
    if (!öppen || !overlay) return;
    const log = overlay.querySelector('#emb-log');
    const nereVid = log.scrollHeight - log.scrollTop - log.clientHeight;
    const poster = tidslinje();

    log.innerHTML = poster.length ? poster.map(p => {
      if (p.kind === 'broadcast') {
        return `
          <div class="emb-item emb-broadcast emb-lvl-${p.level}">
            <div class="emb-head">
              <span class="emb-dot"></span>${escapeHtml(p.levelLabel)}
              <span class="emb-time">${klocka(p.at)}</span>
              ${p.avslutat ? '<span class="emb-done">avslutat</span>' : ''}
            </div>
            <div class="emb-text">${escapeHtml(p.text)}</div>
            ${p.ackAt ? `<div class="emb-status">${icon('check', { size: 12 })} Bekräftat ${klocka(p.ackAt)}</div>` : ''}
            ${p.needsAck ? `<button type="button" class="emb-ack" data-ack="${escapeHtml(p.id)}">Bekräfta mottaget</button>` : ''}
          </div>`;
      }
      return `
        <div class="emb-item emb-msg ${p.from === 'falt' ? 'emb-mine' : 'emb-theirs'}">
          ${p.image ? `<img class="emb-img" src="${escapeHtml(p.image)}" alt="Bifogad bild" loading="lazy">` : ''}
          ${p.text ? `<div class="emb-text">${escapeHtml(p.text)}</div>` : ''}
          <div class="emb-status">${p.from === 'falt' ? 'Du' : 'Tävlingsledningen'} · ${klocka(p.at)}${p.pending ? ' · skickar…' : ''}</div>
        </div>`;
    }).join('') : `<p class="emb-empty">Inget än. Här samlas allt tävlingsledningen skickar ut — och dina egna frågor.</p>`;

    // Hoppa inte ifrån den som scrollat upp för att läsa något äldre.
    if (nereVid < 80) log.scrollTop = log.scrollHeight;

    log.querySelectorAll('[data-ack]').forEach(b =>
      b.addEventListener('click', () => { ackBroadcast(b.dataset.ack); ritaPanel(); ritaKnapp(); }));

    const notif = overlay.querySelector('#emb-notif');
    if (notif) {
      const läge = notificationState();
      notif.innerHTML = läge === 'granted'
        ? `Notiser är aktiva på den här enheten ${icon('check', { size: 13 })}`
        : läge === 'denied'
          ? 'Notiser är blockerade i webbläsarens inställningar.'
          : `<button type="button" id="emb-enable">Aktivera notiser på den här enheten</button>
             <div class="emb-notif-hint">Då syns nya meddelanden även när skärmen visar något annat.</div>`;
      notif.querySelector('#emb-enable')?.addEventListener('click', async () => {
        await requestNotifications(); ritaPanel();
      });
    }
  };

  const visaBild = () => {
    const rad = overlay?.querySelector('#emb-attach');
    if (!rad) return;
    rad.hidden = !bild;
    if (bild) rad.querySelector('img').src = bild.dataUrl;
  };

  const stäng = () => {
    öppen = false;
    overlay?.remove();
    overlay = null;
    unlockScroll();
    ritaKnapp();
  };

  const öppna = () => {
    öppen = true;
    overlay = document.createElement('div');
    overlay.className = 'emb-overlay';
    overlay.innerHTML = `
      <div class="emb-modal" role="dialog" aria-modal="true" aria-label="Meddelanden">
        <div class="emb-modal-head">
          <strong>Meddelanden</strong>
          <button type="button" class="emb-x" id="emb-close" aria-label="Stäng">${icon('x', { size: 20 })}</button>
        </div>
        <div class="emb-log" id="emb-log"></div>
        ${enabled ? `
          <div class="emb-compose">
            <div class="emb-attach" id="emb-attach" hidden>
              <img alt="Vald bild">
              <button type="button" class="emb-attach-x" id="emb-attach-x" aria-label="Ta bort bilden">${icon('x', { size: 15 })}</button>
            </div>
            <textarea class="emb-input" id="emb-text" rows="2" maxlength="2000" placeholder="Skriv till tävlingsledningen…"></textarea>
            <div class="emb-actions">
              <button type="button" class="emb-photo" id="emb-photo">${icon('camera', { size: 18 })}<span>Bild</span></button>
              <button type="button" class="emb-send" id="emb-send">Skicka</button>
            </div>
            <p class="emb-hint" id="emb-hint">Tävlingsledningen ser frågan direkt och svarar här.</p>
          </div>` : `
          <p class="emb-hint emb-readonly">Tävlingsledningen har stängt av möjligheten att skriva hit.</p>`}
        <div class="emb-notif" id="emb-notif"></div>
      </div>`;
    document.body.appendChild(overlay);
    lockScroll();

    overlay.querySelector('#emb-close').addEventListener('click', stäng);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) stäng(); });

    if (enabled) {
      overlay.querySelector('#emb-photo').addEventListener('click', async () => {
        try {
          const v = await pickImage({ camera: true });
          if (v) { bild = v; visaBild(); }
        } catch (e) { overlay.querySelector('#emb-hint').textContent = e.message; }
      });
      overlay.querySelector('#emb-attach-x').addEventListener('click', () => { bild = null; visaBild(); });
      const send = overlay.querySelector('#emb-send');
      send.addEventListener('click', async () => {
        const text = overlay.querySelector('#emb-text').value.trim();
        if (!text && !bild) return;
        send.disabled = true;
        try {
          await sendThreadMessage(cid, kind, refId, { from: 'falt', text, image: bild?.dataUrl || null });
          overlay.querySelector('#emb-text').value = '';
          bild = null; visaBild();
          overlay.querySelector('#emb-hint').textContent = 'Tävlingsledningen ser frågan direkt och svarar här.';
        } catch (e) {
          // Offline hamnar skrivningen i Firestores lokala kö och går fram
          // sedan; det här är riktiga fel.
          overlay.querySelector('#emb-hint').textContent = 'Kunde inte skicka: ' + (e?.message || e);
        } finally { send.disabled = false; }
      });
    }

    if (oläsraSvar()) markThreadRead(cid, kind, refId, 'falt').catch(() => {});
    ritaPanel();
    ritaKnapp();
    overlay.querySelector('#emb-log').scrollTop = overlay.querySelector('#emb-log').scrollHeight;
  };

  knapp.addEventListener('click', () => (öppen ? stäng() : öppna()));

  // --- Datakällor -------------------------------------------------------------
  unsubs.push(onBroadcastChange(() => { ritaKnapp(); ritaPanel(); }));
  unsubs.push(watchThread(cid, kind, refId, rows => { samtal = rows; ritaPanel(); }));
  unsubs.push(watchThreadDoc(cid, kind, refId, t => {
    tråd = t;
    if (öppen && oläsraSvar()) markThreadRead(cid, kind, refId, 'falt').catch(() => {});
    ritaKnapp();
  }));
  window.addEventListener('resize', ritaKnapp);

  ritaKnapp();
  return {
    destroy() {
      unsubs.forEach(u => { try { u(); } catch {} });
      window.removeEventListener('resize', ritaKnapp);
      stäng();
      knapp.remove();
    }
  };
}
