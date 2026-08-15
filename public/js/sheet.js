// Bottensheet — ETT sätt att visa allt som poppar upp på fältsidorna:
// kontrollblad, information, meddelanden.
//
// Att varje yta hade sin egen lösning (ett kort som snurrade, en panel som
// fällde ut, en egen overlay) betydde att man fick lära sig gränssnittet på
// nytt för varje sak. Här är beteendet detsamma överallt: den glider upp
// underifrån, scrollar internt, och stängs med handtaget, ett svep nedåt, ett
// klick utanför eller Esc.
//
// Svepet mäts på handtaget och rubriken, inte på hela arket — annars skulle
// ett svep i en scrollande lista stänga bladet i stället för att scrolla.

import { escapeHtml } from './utils.js';
import { icon } from './icons.js';
import { lockScroll, unlockScroll } from './haptic.js';

// Så långt man måste dra innan det räknas som "stäng".
const STÄNG_PX = 90;

/**
 * @param opts
 *   title     rubrik (sträng) — utelämna för ett blad utan huvud
 *   eyebrow   liten rad ovanför rubriken
 *   body      HTML för innehållet
 *   footer    HTML som ligger fast under det scrollande innehållet
 *   onClose   anropas när bladet stängts
 *   className extra klass på arket, för ytor med egna behov
 *   backdropClose  false för blad där ett tapp bredvid skulle slänga arbete
 *                  (poängbladet) — handtaget, ✕ och Esc stänger ändå
 * @returns { el, close, setBody, setFooter }
 */
export function openSheet({ title = '', eyebrow = '', body = '', footer = '', onClose = null, className = '', backdropClose = true } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet ${escapeHtml(className)}" role="dialog" aria-modal="true"${title ? ` aria-label="${escapeHtml(title)}"` : ''}>
      <div class="sheet-grip" id="sheet-grip"><span></span></div>
      ${title ? `
        <div class="sheet-head" id="sheet-head">
          <div>
            ${eyebrow ? `<div class="sheet-eyebrow">${escapeHtml(eyebrow)}</div>` : ''}
            <h2>${escapeHtml(title)}</h2>
          </div>
          <button type="button" class="sheet-close" id="sheet-x" aria-label="Stäng">${icon('x', { size: 22 })}</button>
        </div>` : ''}
      <div class="sheet-body" id="sheet-body">${body}</div>
      <div class="sheet-foot" id="sheet-foot" ${footer ? '' : 'hidden'}>${footer}</div>
    </div>`;
  document.body.appendChild(overlay);
  lockScroll();

  const ark = overlay.querySelector('.sheet');
  let stängd = false;
  const close = () => {
    if (stängd) return;
    stängd = true;
    document.removeEventListener('keydown', onKey);
    ark.style.transition = 'transform .18s ease-in';
    ark.style.transform = 'translateY(100%)';
    setTimeout(() => { overlay.remove(); unlockScroll(); onClose?.(); }, 170);
  };

  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  if (backdropClose) overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#sheet-x')?.addEventListener('click', close);

  // --- Svep ner ---------------------------------------------------------------
  const grepp = [overlay.querySelector('#sheet-grip'), overlay.querySelector('#sheet-head')].filter(Boolean);
  let startY = null;
  const börja = (y) => { startY = y; ark.style.transition = 'none'; };
  const dra = (y) => {
    if (startY == null) return;
    const dy = Math.max(0, y - startY);
    ark.style.transform = `translateY(${dy}px)`;
  };
  const släpp = (y) => {
    if (startY == null) return;
    const dy = Math.max(0, y - startY);
    startY = null;
    if (dy > STÄNG_PX) { close(); return; }
    ark.style.transition = 'transform .18s ease-out';
    ark.style.transform = '';
  };
  for (const g of grepp) {
    g.addEventListener('touchstart', (e) => börja(e.touches[0].clientY), { passive: true });
    g.addEventListener('touchmove', (e) => dra(e.touches[0].clientY), { passive: true });
    g.addEventListener('touchend', (e) => släpp(e.changedTouches[0].clientY));
    // Mus, så det går att prova på dator också.
    g.addEventListener('mousedown', (e) => {
      börja(e.clientY);
      const move = (ev) => dra(ev.clientY);
      const up = (ev) => {
        släpp(ev.clientY);
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  return {
    el: overlay,
    close,
    setBody(html) { overlay.querySelector('#sheet-body').innerHTML = html; },
    setFooter(html) {
      const f = overlay.querySelector('#sheet-foot');
      f.innerHTML = html;
      f.hidden = !html;
    }
  };
}
