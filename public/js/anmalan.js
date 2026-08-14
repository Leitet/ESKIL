// ESKIL — public registration page (Anmälan).
// URL pattern: /a/<competitionId>            → new registration
//              /a/<competitionId>/<regId>    → manage an existing registration
//
// The regId is the secret (same trust model as reporter URLs). Two-step flow:
// 1) Uppgifter — kår, kontakt, patruller, with a live-updating price bar.
// 2) Betalning — configured payment methods; Swish renders a QR code with
//    amount and reference locked.
// The confirmation screen shows the manage link; a Cloud Function
// (functions/index.js) also emails it to the contact when the registration
// document is created, via the Trigger Email extension.

import {
  getCompetition, getCompetitionBySlug, getRegistration, createRegistration, updateRegistration
} from './store.js';
import {
  allowedAvdelningar, escapeHtml, formatDate, toast, withBusy, confirmDialog, wireOverlayClose,
  registrationSettings, registrationState, computeRegistrationPrice,
  makePaymentReference, swishQrString, swishAppUrl, registrationUrl, copyToClipboard, isPaymentPaid,
  publicManagement
} from './utils.js';
import { ensureQRCode } from './qr.js';
import { downloadReceiptPdf } from './pdf.js';
import { icon } from './icons.js';

const root = document.getElementById('root');

function parsePath() {
  const parts = location.pathname.split('/').filter(Boolean); // ['a', cid, regId?]
  if (parts[0] !== 'a' || !parts[1]) return null;
  return { cid: parts[1], regId: parts[2] || null };
}

// --- Global state -----------------------------------------------------------
let cid = null;
let comp = null;
let settings = null;   // registrationSettings(comp)
let reg = null;        // existing registration when managing
let view = 'form';     // 'form' | 'pay' | 'done' | 'manage' | 'closed-info'
let editing = false;   // manage-mode: currently editing the form

// Draft being edited in the form (kept across re-renders).
let draft = null;
// Pending payment prepared when entering the pay step.
let pendingPay = null; // { amount, reference, isDiff }
// Payment being *viewed* from the manage screen (no confirm button).
let viewPay = null;

const isoNow = () => new Date().toISOString();

function newDraft() {
  return {
    kar: '',
    contact: { name: '', email: '', phone: '' },
    patrols: [emptyPatrol()],
    answers: {}
  };
}
function emptyPatrol() {
  return { name: '', avdelning: allowedAvdelningar(comp)[0]?.key || 'Spårare', antal: 5, answers: {} };
}

// Autospara utkast: formuläret skrivs kontinuerligt till localStorage så ett
// tappat mobilnät eller en stängd flik inte kastar en halv anmälan. Rensas
// när anmälan skickats in.
function draftStorageKey() { return `eskil.anm.draft.${cid}`; }
function saveDraftLocal() {
  if (editing || view !== 'form') return;
  try { localStorage.setItem(draftStorageKey(), JSON.stringify(draft)); } catch { /* privat läge */ }
}
function restoreDraftLocal() {
  try {
    const d = JSON.parse(localStorage.getItem(draftStorageKey()) || 'null');
    if (!d || (!d.kar && !d.contact?.name && !d.contact?.email && !(d.patrols || []).some(p => p.name))) return false;
    draft = { ...newDraft(), ...d };
    return true;
  } catch { return false; }
}
function clearDraftLocal() { try { localStorage.removeItem(draftStorageKey()); } catch { /* privat läge */ } }

function draftFromReg(r) {
  return {
    kar: r.kar || '',
    contact: { ...(r.contact || {}) },
    patrols: (r.patrols || []).map(p => ({ ...p, answers: { ...(p.answers || {}) } })),
    answers: { ...(r.answers || {}) }
  };
}

// Custom free-text fields, split by scope.
function regFields(scope) {
  return settings.fields.filter(f => f.scope === scope);
}

function price() {
  return computeRegistrationPrice(settings.pricing, draft ? draft.patrols : []);
}

function paymentsSum(r) {
  return (r?.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
}

// --- Boot -------------------------------------------------------------------
async function boot() {
  const parsed = parsePath();
  if (!parsed) return renderFatal('Ogiltig länk.');
  cid = parsed.cid;

  try {
    // /a/<id> or the fixed slug /a/ah26 — resolve to the real id.
    comp = await getCompetition(cid);
    if (!comp) {
      comp = await getCompetitionBySlug(cid);
      if (comp) cid = comp.id;
    }
  } catch (e) {
    return renderFatal('Kunde inte ladda tävlingen: ' + e.message);
  }
  if (!comp) return renderFatal('Tävlingen hittades inte.');

  settings = registrationSettings(comp);
  document.title = `Anmälan · ${comp.shortName || comp.name || 'ESKIL'}`;

  if (parsed.regId) {
    try {
      reg = await getRegistration(cid, parsed.regId);
    } catch (e) {
      return renderFatal('Kunde inte ladda anmälan: ' + e.message);
    }
    if (!reg) return renderFatal('Anmälan hittades inte. Kontrollera länken.');
    view = 'manage';
  } else {
    draft = newDraft();
    view = 'form';
    if (restoreDraftLocal()) {
      setTimeout(() => toast('Ditt påbörjade utkast återställdes.'), 400);
    }
  }

  render();
}

// --- Shared chrome ----------------------------------------------------------
function stateChip() {
  const st = registrationState(comp);
  if (st === 'open') {
    return `<span class="anm-period-chip"><span class="dot-live"></span>Anmälan öppen${settings.closesAt ? ` · t.o.m. ${escapeHtml(formatDate(settings.closesAt))}` : ''}</span>`;
  }
  if (st === 'before') {
    return `<span class="anm-period-chip before"><span class="dot-live"></span>Öppnar ${escapeHtml(formatDate(settings.opensAt))}</span>`;
  }
  return `<span class="anm-period-chip closed"><span class="dot-live"></span>Anmälan stängd</span>`;
}

function hero(sub = 'Anmälan') {
  return `
    <header class="anm-hero">
      <div class="anm-hero-pattern"></div>
      <div class="anm-hero-inner">
        <img src="/assets/logo-scouterna-tagline-white.svg" alt="Scouterna" style="height:30px;">
        <div class="t-over" style="color:var(--rover-yellow);margin-top:14px;">${escapeHtml(comp.shortName || '')} · ${comp.year || ''} · ${escapeHtml(sub)}</div>
        <h1>${escapeHtml(comp.name || '')}</h1>
        <div class="sub">${comp.date ? escapeHtml(formatDate(comp.date)) : ''}${comp.location ? ' · ' + escapeHtml(comp.location) : ''}</div>
        ${stateChip()}
      </div>
    </header>
  `;
}

function footer() {
  const cid = comp?.id || parsePath()?.cid || '';
  return `<div class="anm-foot">ESKIL · anmälan · ${escapeHtml(comp.organizer || comp.shortName || '')}
    · <a href="/t/${escapeHtml(cid)}" style="color:inherit;">Tävlingssidan</a>
    · <a href="/integritet" style="color:inherit;">Integritet &amp; GDPR</a></div>`;
}

function steps(active) {
  const s = (n, label) => {
    const cls = active === n ? 'active' : (active > n ? 'done' : '');
    return `<span class="step ${cls}"><span class="n">${active > n ? icon('check', { size: 13, stroke: 3 }) : n}</span>${label}</span>`;
  };
  return `
    <div class="anm-steps">
      ${s(1, 'Uppgifter')}
      <span class="sep"></span>
      ${s(2, 'Betalning')}
      <span class="sep"></span>
      ${s(3, 'Klart')}
    </div>
  `;
}

// --- Render dispatcher ------------------------------------------------------
function render() {
  const st = registrationState(comp);

  if (view === 'form' && !reg) {
    if (st === 'unconfigured') return renderShell(`
      <div class="anm-card"><h2>Anmälan är inte öppen</h2>
      <p class="muted">Den här tävlingen tar inte emot anmälningar just nu.</p></div>`);
    if (st === 'before') return renderShell(`
      <div class="anm-card"><h2>Anmälan har inte öppnat ännu</h2>
      <p class="muted">Anmälan öppnar ${escapeHtml(formatDate(settings.opensAt))}. Välkommen tillbaka då!</p></div>`);
    if (st === 'closed') return renderShell(`
      <div class="anm-card"><h2>Anmälan är stängd</h2>
      <p class="muted">Anmälningsperioden${settings.closesAt ? ' gick ut ' + escapeHtml(formatDate(settings.closesAt)) : ' är avslutad'}. Kontakta tävlingsledningen om ni ändå vill delta.</p></div>`);
  }

  if (view === 'form')   return renderShell(renderForm(), () => wireForm());
  if (view === 'pay')    return renderShell(renderPay(), () => wirePay());
  if (view === 'done')   return renderShell(renderDone(), () => wireDone());
  if (view === 'manage') return renderShell(renderManage(), () => wireManage());
}

function renderShell(bodyHtml, wire = null) {
  root.innerHTML = `${hero()}<main class="anm-page">${bodyHtml}</main>${footer()}`;
  wire?.();
}

function renderFatal(msg) {
  const cid = comp?.id || parsePath()?.cid || '';
  root.innerHTML = `
    <header class="anm-hero">
      <div class="anm-hero-pattern"></div>
      <div class="anm-hero-inner">
        <img src="/assets/logo-scouterna-tagline-white.svg" alt="Scouterna" style="height:30px;">
        <h1>Hoppsan</h1>
        <div class="sub">${escapeHtml(msg)}</div>
        <div style="margin-top:var(--sp-6);display:flex;gap:var(--sp-3);justify-content:center;flex-wrap:wrap;">
          ${cid ? `<a class="btn btn-secondary btn-sm" href="/t/${escapeHtml(cid)}">Till tävlingssidan</a>` : ''}
          <a class="btn btn-ghost btn-sm" href="/" style="color:#fff;">ESKIL:s startsida</a>
        </div>
      </div>
    </header>
  `;
}

// --- Step 1: form -----------------------------------------------------------
function renderForm() {
  const karvis = settings.mode === 'kar';
  const p = price();
  return `
    ${steps(1)}
    ${settings.info ? `<div class="anm-info">${escapeHtml(settings.info)}</div>` : ''}

    <form id="anm-form">
      <div class="anm-card">
        <h2>${karvis ? 'Kår och kontakt' : 'Kontaktuppgifter'}</h2>
        <p class="muted" style="font-size:13px;margin:4px 0 0;">Uppgifterna används bara för att administrera anmälan och raderas när tävlingen avslutas — <a href="/integritet" target="_blank" rel="noopener">integritet &amp; GDPR</a>.</p>
        <div class="field-group">
          <div>
            <label class="field" for="f-kar">Kår</label>
            <input class="input" id="f-kar" required value="${escapeHtml(draft.kar)}" placeholder="Ex. Lindsdals Scoutkår" autocomplete="organization">
          </div>
          <div>
            <label class="field" for="f-cname">Anmälningsansvarig</label>
            <input class="input" id="f-cname" required value="${escapeHtml(draft.contact.name || '')}" placeholder="För- och efternamn" autocomplete="name">
          </div>
          <div class="grid grid-2">
            <div>
              <label class="field" for="f-cemail">E-post</label>
              <input class="input" id="f-cemail" type="email" required value="${escapeHtml(draft.contact.email || '')}" placeholder="namn@exempel.se" autocomplete="email">
              <div class="field-hint">Hit skickas länken för att ändra anmälan.</div>
            </div>
            <div>
              <label class="field" for="f-cphone">Telefon</label>
              <input class="input" id="f-cphone" type="tel" value="${escapeHtml(draft.contact.phone || '')}" placeholder="070-123 45 67" autocomplete="tel">
            </div>
          </div>
          ${editing ? '' : `
          <div>
            <label class="field" for="f-cemail2">Upprepa e-post</label>
            <input class="input" id="f-cemail2" type="email" required placeholder="Samma adress igen" autocomplete="off" value="${escapeHtml(draft.contact.email || '')}">
            <div class="field-hint">Dubbelkoll — en felstavad adress betyder att ändringslänken aldrig kommer fram.</div>
          </div>`}
        </div>
      </div>

      <div class="anm-card">
        <h2>${karvis ? 'Patruller' : 'Patrull'}</h2>
        ${karvis ? `<p class="muted t-sm" style="margin-top:-8px;">Anmäl kårens alla patruller här — en anmälan för hela kåren.</p>` : ''}
        <div id="patrol-list">
          ${draft.patrols.map((pt, i) => patrolCard(pt, i, karvis)).join('')}
        </div>
        ${karvis ? `<button type="button" class="btn btn-secondary btn-sm" id="add-patrol">${icon('plus', { size: 14 })} Lägg till patrull</button>` : ''}
      </div>

      ${regFields('anmalan').length ? `
        <div class="anm-card" id="anm-extra">
          <h2>Övrig information</h2>
          <div class="field-group">
            ${regFields('anmalan').map(f => `
              <div>
                <label class="field">${escapeHtml(f.label)}${f.required ? '' : ' <span style="font-weight:400;color:var(--fg3);">(valfritt)</span>'}</label>
                ${f.description ? `<p class="anm-field-desc">${escapeHtml(f.description)}</p>` : ''}
                <textarea class="textarea" rows="2" data-answer="${escapeHtml(f.id)}" ${f.required ? 'required' : ''}>${escapeHtml(draft.answers?.[f.id] || '')}</textarea>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
    </form>

    <div class="anm-pricebar">
      <div class="inner">
        <div class="total">
          <div class="lbl">Att betala${editing ? ' (nytt totalpris)' : ''}</div>
          <div class="val" id="price-total">${p.total}<small> kr</small></div>
        </div>
        <div class="btn-row">
          ${editing ? `<button class="btn btn-ghost" id="cancel-edit">Avbryt</button>` : ''}
          <button class="btn btn-primary" id="to-pay">${editing ? 'Spara ändringar' : 'Till betalning'} ${icon('arrow-right', { size: 16 })}</button>
        </div>
      </div>
      <div class="anm-price-rows" id="price-rows">${priceRowsHtml(p)}</div>
    </div>

    ${editing ? '' : `
    <p class="muted t-sm" style="text-align:center;margin-top:18px;">
      Redan anmäld men tappat ändringslänken?
      <a href="#" id="resend-link">Få den skickad igen</a>
    </p>`}
  `;
}

function patrolCard(pt, i, removable) {
  return `
    <div class="anm-patrol" data-idx="${i}">
      <div class="anm-patrol-head">
        <strong>Patrull ${i + 1}</strong>
        ${removable ? `<button type="button" class="btn btn-ghost btn-sm remove-patrol" data-remove="${i}">${icon('trash', { size: 14 })} Ta bort</button>` : ''}
      </div>
      <div class="grid-3">
        <div>
          <label class="field">Patrullnamn</label>
          <input class="input" required data-f="name" value="${escapeHtml(pt.name)}" placeholder="Ex. Rävarna">
        </div>
        <div>
          <label class="field">Avdelning</label>
          <select class="select" data-f="avdelning">
            ${allowedAvdelningar(comp).map(a => `<option value="${a.key}" ${pt.avdelning === a.key ? 'selected' : ''}>${a.key} (${a.range})</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="field">Antal scouter</label>
          <input class="input" required data-f="antal" type="number" min="1" inputmode="numeric" value="${pt.antal || ''}">
        </div>
      </div>
      ${regFields('patrull').map(f => `
        <div class="mt-3">
          <label class="field">${escapeHtml(f.label)}${f.required ? '' : ' <span style="font-weight:400;color:var(--fg3);">(valfritt)</span>'}</label>
          ${f.description ? `<p class="anm-field-desc">${escapeHtml(f.description)}</p>` : ''}
          <textarea class="textarea" rows="2" data-answer="${escapeHtml(f.id)}" ${f.required ? 'required' : ''}>${escapeHtml(pt.answers?.[f.id] || '')}</textarea>
        </div>
      `).join('')}
    </div>
  `;
}

function priceRowsHtml(p) {
  return p.rows.filter(r => r.amount > 0 || p.rows.length === 1)
    .map(r => `<div class="r"><span>${escapeHtml(r.label)}</span><span>${r.amount} kr</span></div>`).join('');
}

function wireForm() {
  const form = document.getElementById('anm-form');

  // Sync inputs → draft, update price live.
  const sync = () => {
    draft.kar = document.getElementById('f-kar').value;
    draft.contact = {
      name: document.getElementById('f-cname').value,
      email: document.getElementById('f-cemail').value,
      phone: document.getElementById('f-cphone').value
    };
    document.querySelectorAll('.anm-patrol').forEach(card => {
      const i = Number(card.dataset.idx);
      const get = f => card.querySelector(`[data-f="${f}"]`).value;
      const answers = {};
      card.querySelectorAll('[data-answer]').forEach(t => { answers[t.dataset.answer] = t.value; });
      draft.patrols[i] = { name: get('name'), avdelning: get('avdelning'), antal: Number(get('antal')) || 0, answers };
    });
    draft.answers = {};
    document.querySelectorAll('#anm-extra [data-answer]').forEach(t => { draft.answers[t.dataset.answer] = t.value; });
    const p = price();
    document.getElementById('price-total').innerHTML = `${p.total}<small> kr</small>`;
    document.getElementById('price-rows').innerHTML = priceRowsHtml(p);
    saveDraftLocal();
  };
  form.addEventListener('input', sync);
  form.addEventListener('change', sync);

  document.getElementById('add-patrol')?.addEventListener('click', () => {
    sync();
    draft.patrols.push(emptyPatrol());
    render();
    // Focus the new patrol's name field.
    const cards = document.querySelectorAll('.anm-patrol');
    cards[cards.length - 1]?.querySelector('[data-f="name"]')?.focus();
  });

  document.getElementById('patrol-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    sync();
    draft.patrols.splice(Number(btn.dataset.remove), 1);
    if (!draft.patrols.length) draft.patrols.push(emptyPatrol());
    render();
  });

  document.getElementById('cancel-edit')?.addEventListener('click', () => {
    editing = false;
    view = 'manage';
    render();
  });

  // Självbetjäning: skicka om ändringslänken. Egen modal (inte promptDialog):
  // anropet kan ta 5–15 s vid kallstart, så dialogen måste stanna kvar med
  // "Skickar…" och visa bekräftelsen/felet PÅ PLATS — en toast som dyker upp
  // långt efter att rutan stängts ser ut som att inget hände. Bekräftelsen
  // är neutral: funktionen avslöjar aldrig om adressen finns i en anmälan.
  document.getElementById('resend-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:440px;">
        <div class="modal-head"><h3>Skicka ändringslänken igen</h3></div>
        <div class="modal-body">
          <p style="margin-top:0;">Ange e-postadressen ni anmälde er med, så skickas ändringslänken dit igen.</p>
          <input class="input" id="rs-email" type="email" placeholder="namn@exempel.se" autocomplete="email">
          <p class="t-sm" id="rs-err" style="color:var(--utm-pink);margin:8px 0 0;display:none;"></p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" id="rs-cancel">Avbryt</button>
          <button class="btn btn-primary" id="rs-send">Skicka länken</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    wireOverlayClose(overlay, close);
    overlay.querySelector('#rs-cancel').addEventListener('click', close);
    const input = overlay.querySelector('#rs-email');
    const err = overlay.querySelector('#rs-err');
    const send = overlay.querySelector('#rs-send');
    const submit = async () => {
      const email = input.value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        err.textContent = 'Ange en giltig e-postadress.';
        err.style.display = 'block';
        input.focus();
        return;
      }
      err.style.display = 'none';
      send.disabled = true;
      send.textContent = 'Skickar…';
      try {
        const { functions, httpsCallable } = await import('./firebase.js');
        await httpsCallable(functions, 'resendManageLink')({ cid, email });
        overlay.querySelector('.modal').innerHTML = `
          <div class="modal-head"><h3>Begäran mottagen</h3></div>
          <div class="modal-body">
            <p style="margin-top:0;">Om <strong>${escapeHtml(email)}</strong> är kontaktadress i en anmälan
            till tävlingen skickas ändringslänken dit inom någon minut.</p>
            <p class="muted t-sm">Inget mail? Kolla skräpposten — eller kontakta tävlingsledningen,
            som kan slå upp er anmälan direkt.</p>
          </div>
          <div class="modal-foot"><button class="btn btn-primary" id="rs-done">Stäng</button></div>`;
        overlay.querySelector('#rs-done').addEventListener('click', close);
      } catch (e2) {
        send.disabled = false;
        send.textContent = 'Skicka länken';
        err.textContent = e2?.code === 'functions/resource-exhausted'
          ? e2.message
          : 'Kunde inte skicka just nu — försök igen om en stund, eller kontakta tävlingsledningen.';
        err.style.display = 'block';
      }
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });
    setTimeout(() => input.focus(), 30);
  });

  document.getElementById('to-pay').addEventListener('click', async (e) => {
    e.preventDefault();
    sync();
    if (!form.reportValidity()) return;
    // E-postdubbelkoll (bara nya anmälningar): fel adress = ändringslänken
    // når aldrig fram, och anmälan blir oåtkomlig för kårledaren.
    const email2 = document.getElementById('f-cemail2');
    if (email2 && email2.value.trim().toLowerCase() !== draft.contact.email.trim().toLowerCase()) {
      toast('E-postadresserna stämmer inte överens — kontrollera stavningen.', 'error');
      email2.focus();
      return;
    }
    const p = price();

    if (editing) {
      // Manage-mode save: compute the difference against what has already
      // been registered for payment. More → a new payment for the diff.
      // Re-fetch first — the admin may have updated payments (marked paid)
      // while this page sat open.
      reg = await getRegistration(cid, reg.id).catch(() => null) || reg;
      const already = paymentsSum(reg);
      const diff = p.total - already;
      if (diff > 0) {
        pendingPay = { amount: diff, reference: makePaymentReference(comp), isDiff: true };
        view = 'pay';
        render();
      } else {
        await persistEdit(null);
        if (diff < 0) toast('Anmälan uppdaterad. Mellanskillnaden regleras av tävlingsledningen.', 'success');
        else toast('Anmälan uppdaterad', 'success');
        editing = false;
        view = 'manage';
        render();
      }
      return;
    }

    if (p.total > 0) {
      pendingPay = { amount: p.total, reference: makePaymentReference(comp), isDiff: false };
      view = 'pay';
    } else {
      await persistNew(null);
      view = 'done';
    }
    render();
  });
}

// --- Step 2: payment --------------------------------------------------------
function renderPay() {
  const pay = viewPay || pendingPay;
  const confirmable = !viewPay;
  return `
    ${steps(2)}
    <div class="anm-card">
      <h2>${pay.isDiff ? 'Betalning — tillägg' : 'Betalning'}</h2>
      ${pay.isDiff ? `<p class="muted t-sm" style="margin-top:-8px;">Ni har utökat er anmälan — mellanskillnaden betalas separat.</p>` : ''}
      <div class="anm-due">
        <span class="lbl">Att betala</span>
        <span class="val">${pay.amount} kr</span>
      </div>
      <div class="anm-ref">
        <div>
          <div class="lbl">Betalningsreferens — ange vid betalning</div>
          <div class="code">${escapeHtml(pay.reference)}</div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" id="copy-ref">${icon('copy', { size: 14 })} Kopiera</button>
      </div>
      ${renderMethods(pay)}
    </div>
    <div class="btn-row" style="justify-content:space-between;">
      <button class="btn btn-ghost" id="pay-back">${icon('arrow-left', { size: 16 })} Tillbaka</button>
      ${confirmable ? `<button class="btn btn-primary" id="pay-confirm">${pay.isDiff ? 'Bekräfta ändringen' : 'Slutför anmälan'} ${icon('check', { size: 16 })}</button>` : ''}
    </div>
    <p class="muted t-sm mt-3" style="text-align:center;">
      ${confirmable ? 'Anmälan registreras direkt — betalningen bekräftas av tävlingsledningen när den kommit in.<br>' : ''}
      När tävlingsledningen registrerat betalningen får ni ett kvitto (PDF) via e-post.
    </p>
  `;
}

function renderMethods(pay) {
  if (!settings.methods.length) {
    return `<div class="anm-info">Tävlingsledningen skickar betalningsinstruktioner separat.</div>`;
  }
  return settings.methods.map((m, i) => {
    if (m.type === 'swish') {
      return `
        <div class="anm-method">
          <div class="anm-method-head">${escapeHtml(m.label || 'Swish')}<span class="tag">Swish</span></div>
          <div class="anm-method-body">
            <div>Swisha till <span class="mono-big">${escapeHtml(m.number || '')}</span></div>
            <a class="btn btn-primary mt-3" style="display:inline-flex;align-items:center;gap:8px;"
               href="${escapeHtml(swishAppUrl(m.number, pay.amount, pay.reference))}"
               target="_blank" rel="noopener">Öppna i Swish — ${pay.amount} kr</a>
            <div class="hint" style="margin-top:6px;">Öppnar Swish-appen med belopp och referens ifyllda (på den här enheten).</div>
            <div class="anm-qr">
              <div class="qr-box" id="swish-qr-${i}" data-number="${escapeHtml(m.number || '')}"></div>
              <div class="hint">…eller skanna QR-koden med Swish-appen från en annan enhet. Belopp och referens är låsta i koden.</div>
            </div>
          </div>
        </div>
      `;
    }
    if (m.type === 'bankgiro') {
      return `
        <div class="anm-method">
          <div class="anm-method-head">${escapeHtml(m.label || 'Bankgiro')}<span class="tag">Bankgiro</span></div>
          <div class="anm-method-body">
            <div>Bankgiro <span class="mono-big">${escapeHtml(m.number || '')}</span></div>
            <div class="mt-2">Ange referensen <strong class="mono">${escapeHtml(pay.reference)}</strong> som meddelande.</div>
          </div>
        </div>
      `;
    }
    return `
      <div class="anm-method">
        <div class="anm-method-head">${escapeHtml(m.label || 'Faktura')}<span class="tag">Faktura</span></div>
        <div class="anm-method-body">${escapeHtml(m.info || 'Kontakta tävlingsledningen för fakturering.')}${m.info ? '' : ''}
          <div class="mt-2">Uppge referensen <strong class="mono">${escapeHtml(pay.reference)}</strong>.</div>
        </div>
      </div>
    `;
  }).join('');
}

async function renderSwishQrCodes(pay) {
  const hosts = document.querySelectorAll('[id^="swish-qr-"]');
  if (!hosts.length) return;
  try {
    const QRCode = await ensureQRCode();
    hosts.forEach(host => {
      host.innerHTML = '';
      new QRCode(host, {
        text: swishQrString(host.dataset.number, pay.amount, pay.reference),
        width: 210, height: 210,
        correctLevel: QRCode.CorrectLevel.M
      });
    });
  } catch (e) {
    console.warn('QR load failed', e);
    hosts.forEach(h => { h.innerHTML = '<span class="muted t-sm">QR-koden kunde inte laddas.</span>'; });
  }
}

function wirePay() {
  const pay = viewPay || pendingPay;
  renderSwishQrCodes(pay);

  document.getElementById('copy-ref').addEventListener('click', () => {
    copyToClipboard(pay.reference);
    toast('Referens kopierad', 'success');
  });

  document.getElementById('pay-back').addEventListener('click', () => {
    if (viewPay) { viewPay = null; view = 'manage'; }
    else view = 'form';
    render();
  });

  document.getElementById('pay-confirm')?.addEventListener('click', (e) => withBusy(e.currentTarget, 'Sparar…', async () => {
    try {
      if (editing) {
        await persistEdit(pendingPay);
        editing = false;
        pendingPay = null;
        toast('Anmälan uppdaterad', 'success');
        view = 'manage';
      } else {
        await persistNew(pendingPay);
        pendingPay = null;
        view = 'done';
      }
      render();
    } catch (err) {
      console.error(err);
      toast('Kunde inte spara: ' + err.message, 'error');
    }
  }));
}

// --- Persistence ------------------------------------------------------------
function paymentEntry(pay) {
  return {
    id: crypto.randomUUID(),
    amount: pay.amount,
    reference: pay.reference,
    createdAt: isoNow(),
    paid: false,
    paidAt: null
  };
}

function cleanAnswers(answers) {
  const out = {};
  for (const [k, v] of Object.entries(answers || {})) {
    const t = String(v).trim();
    if (t) out[k] = t;
  }
  return out;
}

function cleanPatrol(pt) {
  return {
    name: pt.name.trim(),
    avdelning: pt.avdelning,
    antal: Number(pt.antal) || 0,
    answers: cleanAnswers(pt.answers)
  };
}

async function persistNew(pay) {
  const p = price();
  const regId = crypto.randomUUID();
  await createRegistration(cid, regId, {
    kar: draft.kar.trim(),
    contact: {
      name: draft.contact.name.trim(),
      email: draft.contact.email.trim().toLowerCase(),
      phone: draft.contact.phone.trim()
    },
    patrols: draft.patrols.map(cleanPatrol),
    answers: cleanAnswers(draft.answers),
    mode: settings.mode,
    totalAmount: p.total,
    payments: pay ? [paymentEntry(pay)] : [],
    cancelled: false,
    forhinder: [],
    createdAt: isoNow(),
    updatedAt: isoNow()
  });
  reg = await getRegistration(cid, regId);
  history.replaceState({}, '', `/a/${cid}/${regId}`);
  clearDraftLocal(); // anmälan inne — utkastet behövs inte längre
  // A Cloud Function reacts to the new registration document and emails the
  // confirmation (with this manage link) to the contact — nothing to do here.
}

async function persistEdit(pay) {
  const p = price();
  // Base the payments array on a FRESH read — this page can sit open for
  // days, and writing a stale snapshot back would silently revert paid-flags
  // the admin set in the meantime.
  const fresh = await getRegistration(cid, reg.id).catch(() => null) || reg;
  const payments = [...(fresh.payments || [])];
  if (pay) payments.push(paymentEntry(pay));
  await updateRegistration(cid, reg.id, {
    kar: draft.kar.trim(),
    contact: {
      name: draft.contact.name.trim(),
      email: draft.contact.email.trim().toLowerCase(),
      phone: draft.contact.phone.trim()
    },
    patrols: draft.patrols.map(cleanPatrol),
    answers: cleanAnswers(draft.answers),
    totalAmount: p.total,
    payments,
    updatedAt: isoNow()
  });
  reg = await getRegistration(cid, reg.id);
}

// --- Step 3: done -----------------------------------------------------------
function renderDone() {
  const url = registrationUrl(cid, reg.id);
  return `
    ${steps(3)}
    <div class="anm-card anm-success">
      <div class="check-ring">${icon('check', { size: 32, stroke: 3 })}</div>
      <h2>Anmälan är registrerad!</h2>
      <p class="muted">${escapeHtml(reg.kar)} — ${reg.patrols.length} patrull${reg.patrols.length === 1 ? '' : 'er'}, ${reg.patrols.reduce((s, p) => s + (p.antal || 0), 0)} scouter.</p>
      <p class="t-sm" style="margin-top:var(--sp-4);"><strong>Spara den här länken</strong> — med den kan ni se och ändra er anmälan:</p>
      <div class="anm-link-box">
        <input class="js-selectall" readonly value="${escapeHtml(url)}">
        <button type="button" class="btn btn-secondary btn-sm" id="copy-link">${icon('copy', { size: 14 })} Kopiera</button>
      </div>
      <p class="t-sm" style="color:var(--spaer-green);font-weight:600;">${icon('mail', { size: 14 })} Ett bekräftelsemail med länken skickas till ${escapeHtml(reg.contact.email)}.
        <span class="muted" style="font-weight:400;display:block;">Kolla skräpposten om det dröjer.</span></p>
      <div class="btn-row" style="justify-content:center;margin-top:var(--sp-5);">
        <button class="btn btn-primary" id="goto-manage">Visa min anmälan ${icon('arrow-right', { size: 16 })}</button>
      </div>
    </div>
  `;
}

function wireDone() {
  document.querySelector('.js-selectall')?.addEventListener('click', (e) => e.target.select());
  document.getElementById('copy-link').addEventListener('click', () => {
    copyToClipboard(registrationUrl(cid, reg.id));
    toast('Länk kopierad', 'success');
  });
  document.getElementById('goto-manage').addEventListener('click', () => {
    view = 'manage';
    render();
  });
}

// --- Manage view ------------------------------------------------------------
// Kårledarens "Inför tävlingsdagen"-kort: allt de behöver veta samlat på
// anmälningssidan de redan har länken till.
function renderInforDagen() {
  const mgmt = publicManagement(comp);
  const contact = mgmt.find(r => r.phone || r.email);
  return `
    <div class="anm-card">
      <h2>Inför tävlingsdagen</h2>
      <ul class="t-sm" style="margin:8px 0 0;padding-left:18px;line-height:1.8;">
        ${comp.date ? `<li><strong>${escapeHtml(formatDate(comp.date))}</strong>${comp.location ? ` · ${escapeHtml(comp.location)}` : ''}${comp.startTimes?.enabled && comp.startTimes?.firstStart ? ` · första start ${escapeHtml(comp.startTimes.firstStart)}` : ''}</li>` : ''}
        <li>Startlista med patrullernas starttider, karta och liveresultat finns på
          <a href="/t/${escapeHtml(cid)}" target="_blank" rel="noopener">tävlingssidan</a> —
          dela gärna länken med scouter och anhöriga.</li>
        <li>Varje patrull har ett digitalt startkort (nås från startlistan) med sina kontroller,
          poäng och vägen på kartan.</li>
        ${comp.parking?.enabled ? `<li>Parkering finns markerad på tävlingssidans karta${comp.parking.note ? ` — ${escapeHtml(comp.parking.note)}` : ''}.</li>` : ''}
        ${contact ? `<li>Frågor? ${escapeHtml(contact.label || 'Tävlingsledningen')}${contact.name ? ` ${escapeHtml(contact.name)}` : ''}${contact.phone ? ` · <a href="tel:${escapeHtml(contact.phone)}">${escapeHtml(contact.phone)}</a>` : ''}${contact.email ? ` · <a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(contact.email)}</a>` : ''}</li>` : ''}
      </ul>
    </div>
  `;
}

function renderManage() {
  const st = registrationState(comp);
  const open = st === 'open';
  const nScouts = (reg.patrols || []).reduce((s, p) => s + (Number(p.antal) || 0), 0);
  const paid = (reg.payments || []).filter(p => isPaymentPaid(reg, p)).reduce((s, p) => s + p.amount, 0);
  const total = paymentsSum(reg);

  if (reg.cancelled) {
    return `
      <div class="anm-card">
        <h2>Anmälan är återkallad</h2>
        <p class="muted">Er anmälan för ${escapeHtml(reg.kar)} är avanmäld. Kontakta tävlingsledningen om detta inte stämmer.</p>
      </div>
    `;
  }

  return `
    <div class="anm-card">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:var(--sp-3);">
        <div>
          <h2 style="margin-bottom:4px;">${escapeHtml(reg.kar)}</h2>
          <p class="muted t-sm" style="margin:0;">Anmäld ${escapeHtml(formatDate(reg.createdAt?.slice(0, 10) || ''))} · ${reg.patrols.length} patrull${reg.patrols.length === 1 ? '' : 'er'} · ${nScouts} scouter</p>
        </div>
        ${paid >= total && total > 0
          ? '<span class="anm-badge paid">Betald</span>'
          : (total > 0 ? '<span class="anm-badge pending">Betalning väntar</span>' : '')}
      </div>

      <div class="mt-4">
        ${(reg.patrols || []).map((p, i) => `
          <div class="anm-sum-row">
            <span class="n">${i + 1}.</span>
            <strong>${escapeHtml(p.name)}</strong>
            <span class="meta">${escapeHtml(p.avdelning)} · ${p.antal} scouter</span>
          </div>
          ${regFields('patrull').filter(f => p.answers?.[f.id]).map(f => `
            <div class="t-sm muted" style="padding:2px 0 8px 26px;"><strong>${escapeHtml(f.label)}:</strong> ${escapeHtml(p.answers[f.id])}</div>
          `).join('')}
        `).join('')}
      </div>

      ${regFields('anmalan').some(f => reg.answers?.[f.id]) ? `
        <div class="mt-4 t-sm" style="border-top:1px solid var(--border);padding-top:var(--sp-3);">
          ${regFields('anmalan').filter(f => reg.answers?.[f.id]).map(f => `
            <div style="margin-bottom:4px;"><strong>${escapeHtml(f.label)}:</strong> ${escapeHtml(reg.answers[f.id])}</div>
          `).join('')}
        </div>
      ` : ''}

      <div class="mt-4 t-sm muted">
        Kontakt: ${escapeHtml(reg.contact?.name || '')} · ${escapeHtml(reg.contact?.email || '')}${reg.contact?.phone ? ' · ' + escapeHtml(reg.contact.phone) : ''}
      </div>

      ${open ? `
        <div class="btn-row mt-5">
          <button class="btn btn-secondary" id="edit-reg">Ändra anmälan</button>
          <button class="btn btn-ghost" id="cancel-reg" style="color:var(--utm-pink);">Avanmäl allt</button>
        </div>
      ` : `
        <p class="t-sm muted mt-4">Anmälningsperioden är stängd — anmälan kan inte längre ändras här. Har en patrull fått förhinder? Meddela tävlingsledningen nedan.</p>
      `}
    </div>

    ${renderInforDagen()}

    ${(reg.payments || []).length ? `
      <div class="anm-card">
        <h2>Betalningar</h2>
        ${reg.payments.some(p => !isPaymentPaid(reg, p)) ? `
          <p class="muted t-sm" style="margin-top:-8px;">
            Betalningar bekräftas <strong>manuellt</strong> av tävlingsledningen när de synts på kontot —
            det kan därför dröja någon dag innan statusen ändras här, även om ni redan har betalat.
            När betalningen registrerats får ni ett kvitto (PDF) via e-post — det kan även hämtas här på sidan.
          </p>
        ` : ''}
        ${reg.payments.map(p => `
          <div class="anm-payment-row">
            <span class="ref">${escapeHtml(p.reference)}</span>
            ${isPaymentPaid(reg, p)
              ? `<span class="anm-badge paid">Betald</span><button type="button" class="btn btn-ghost btn-sm" data-receipt="${escapeHtml(p.id)}">${icon('download', { size: 14 })} Kvitto</button>`
              : `<span class="anm-badge pending">Väntar</span><button type="button" class="btn btn-ghost btn-sm" data-showpay="${escapeHtml(p.id)}">Betala</button>`}
            <span class="amt">${p.amount} kr</span>
          </div>
        `).join('')}
      </div>
    ` : ''}

    ${!open ? renderForhinderCard() : ''}
    ${(reg.forhinder || []).length ? `
      <div class="anm-card">
        <h2>Anmälda förhinder</h2>
        ${reg.forhinder.map(f => `
          <div class="anm-sum-row">
            <span>${escapeHtml(f.patrol || 'Hela anmälan')}</span>
            <span class="meta">${escapeHtml((f.at || '').slice(0, 10))}</span>
          </div>
          <p class="t-sm muted" style="margin:2px 0 10px;">${escapeHtml(f.message)}</p>
        `).join('')}
      </div>
    ` : ''}
  `;
}

function renderForhinderCard() {
  return `
    <div class="anm-card">
      <h2>Anmäl förhinder</h2>
      <p class="muted t-sm" style="margin-top:-8px;">Informationen skickas till tävlingsledningen.</p>
      <div class="field-group">
        <div>
          <label class="field" for="fh-patrol">Gäller</label>
          <select class="select" id="fh-patrol">
            <option value="">Hela anmälan</option>
            ${(reg.patrols || []).map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="field" for="fh-msg">Meddelande</label>
          <textarea class="textarea" id="fh-msg" required placeholder="Ex. Patrullen kan tyvärr inte delta…"></textarea>
        </div>
      </div>
      <div class="btn-row mt-4" style="justify-content:flex-end;">
        <button class="btn btn-primary" id="fh-send">Skicka till tävlingsledningen</button>
      </div>
    </div>
  `;
}

function wireManage() {
  document.getElementById('edit-reg')?.addEventListener('click', () => {
    draft = draftFromReg(reg);
    editing = true;
    view = 'form';
    render();
  });

  document.getElementById('cancel-reg')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Avanmäla hela anmälan för ${reg.kar}? Meddela även tävlingsledningen om ni redan har betalat.`, { okLabel: 'Avanmäl' }))) return;
    try {
      await updateRegistration(cid, reg.id, { cancelled: true, updatedAt: isoNow() });
      reg = await getRegistration(cid, reg.id);
      toast('Anmälan är återkallad');
      render();
    } catch (e) {
      toast('Fel: ' + e.message, 'error');
    }
  });

  document.querySelectorAll('[data-receipt]').forEach(b => b.addEventListener('click', () => withBusy(b, 'Skapar…', async () => {
    const p = (reg.payments || []).find(x => x.id === b.dataset.receipt);
    if (!p) return;
    try { await downloadReceiptPdf(comp, reg, p); }
    catch (e) { toast('Kunde inte skapa kvittot: ' + e.message, 'error'); }
  })));

  document.querySelectorAll('[data-showpay]').forEach(b => b.addEventListener('click', () => {
    const p = (reg.payments || []).find(x => x.id === b.dataset.showpay);
    if (!p) return;
    viewPay = { amount: p.amount, reference: p.reference, isDiff: false };
    view = 'pay';
    render();
  }));

  document.getElementById('fh-send')?.addEventListener('click', (e) => withBusy(e.currentTarget, 'Skickar…', async () => {
    const msg = document.getElementById('fh-msg').value.trim();
    if (!msg) { toast('Skriv ett meddelande först', 'error'); return; }
    const entry = {
      patrol: document.getElementById('fh-patrol').value || '',
      message: msg,
      at: isoNow()
    };
    try {
      // Append to a fresh copy so concurrent submissions/admin edits aren't
      // overwritten by this page's stale snapshot.
      const fresh = await getRegistration(cid, reg.id).catch(() => null) || reg;
      await updateRegistration(cid, reg.id, {
        forhinder: [...(fresh.forhinder || []), entry],
        updatedAt: isoNow()
      });
      reg = await getRegistration(cid, reg.id);
      toast('Förhindret är anmält till tävlingsledningen', 'success');
      render();
    } catch (err) {
      toast('Fel: ' + err.message, 'error');
    }
  }));
}

boot();
