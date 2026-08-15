// Super-admin: tävlingsförfrågningar.
//
// Vanliga användare kan inte skapa tävlingar (se firestore.rules) utan skickar
// en förfrågan med grunduppgifter och ett meddelande. Här granskas de:
// godkännandet SKAPAR tävlingen med sökanden som administratör, ett nej
// lämnar ingen tävling efter sig. Båda besluten kan bära ett svar tillbaka
// till sökanden — en Cloud Function mailar det (och mailar super-admins när
// en ny förfrågan kommer in).

import { layout } from '../app.js';
import {
  listCompetitionRequests, approveCompetitionRequest,
  denyCompetitionRequest, deleteCompetitionRequest
} from '../store.js';
import { escapeHtml, formatDate, toast, withBusy, confirmDialog } from '../utils.js';
import { crumbs, setDocTitle } from '../nav.js';
import { navigate } from '../router.js';

const STATUS = {
  vantar:  { label: 'Väntar', badge: 'badge-orange' },
  godkand: { label: 'Godkänd', badge: 'badge-green' },
  nekad:   { label: 'Nekad', badge: 'badge-pink' }
};

export async function renderAdminRequests(app, user) {
  if (user.role !== 'super-admin') { navigate('/app', true); return; }
  setDocTitle('Tävlingsförfrågningar');

  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="card"><div class="muted">Laddar…</div></div>`;
  layout(wrap);

  let reqs = [];
  const load = async () => {
    try {
      reqs = (await listCompetitionRequests())
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      render();
    } catch (e) {
      wrap.innerHTML = `<div class="empty"><h3>Kunde inte läsa förfrågningar</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  };

  function card(r) {
    const st = STATUS[r.status] || STATUS.vantar;
    const pending = r.status === 'vantar';
    return `
      <div class="card mb-3" style="${pending ? 'border-left:3px solid var(--avent-orange);' : 'opacity:.85;'}">
        <div class="row wrap" style="justify-content:space-between;gap:var(--sp-3);align-items:baseline;">
          <div>
            <span class="badge ${st.badge}">${st.label}</span>
            <strong style="margin-left:8px;font-size:17px;">${escapeHtml(r.name)}</strong>
          </div>
          <span class="muted t-sm">${r.createdAt ? escapeHtml(formatDate(String(r.createdAt).slice(0, 10))) : ''}</span>
        </div>

        <div class="mt-3 t-sm">
          <div><strong>Sökande:</strong> <a href="mailto:${escapeHtml(r.requestedByEmail || '')}">${escapeHtml(r.requestedByEmail || '')}</a></div>
          ${r.date ? `<div><strong>Datum:</strong> ${escapeHtml(formatDate(r.date))}</div>` : ''}
          ${r.description ? `<div class="mt-2"><strong>Beskrivning:</strong><br>${escapeHtml(r.description)}</div>` : ''}
          ${r.message ? `<div class="mt-2" style="border-left:2px solid var(--border);padding-left:10px;white-space:pre-wrap;">${escapeHtml(r.message)}</div>` : ''}
        </div>

        ${pending ? `
          <div class="mt-4" style="border-top:1px solid var(--border);padding-top:var(--sp-3);">
            <label class="field" for="msg-${escapeHtml(r.id)}">Svar till sökanden (skickas med i mailet)</label>
            <textarea class="textarea" id="msg-${escapeHtml(r.id)}" rows="2" placeholder="Valfritt vid godkännande — motivera gärna ett nej."></textarea>
            <div class="btn-row mt-3">
              <button class="btn btn-primary btn-sm" data-approve="${escapeHtml(r.id)}">Godkänn och skapa tävlingen</button>
              <button class="btn btn-secondary btn-sm" data-deny="${escapeHtml(r.id)}" style="color:var(--utm-pink);">Neka</button>
            </div>
          </div>
        ` : `
          <div class="mt-3 t-sm" style="border-top:1px solid var(--border);padding-top:var(--sp-3);">
            ${r.decisionMessage ? `<div><strong>Svar:</strong> ${escapeHtml(r.decisionMessage)}</div>` : ''}
            <div class="muted">${r.status === 'godkand' ? 'Godkänd' : 'Nekad'}${r.decidedBy ? ' av ' + escapeHtml(r.decidedBy) : ''}${r.decidedAt ? ' · ' + escapeHtml(formatDate(String(r.decidedAt).slice(0, 10))) : ''}</div>
            <div class="btn-row mt-3">
              ${r.competitionId ? `<a class="btn btn-secondary btn-sm" href="/app/c/${escapeHtml(r.competitionId)}" data-link>Öppna tävlingen</a>` : ''}
              <button class="btn btn-ghost btn-sm" data-remove="${escapeHtml(r.id)}">Ta bort ur listan</button>
            </div>
          </div>
        `}
      </div>`;
  }

  function render() {
    const pending = reqs.filter(r => r.status === 'vantar');
    const handled = reqs.filter(r => r.status !== 'vantar');
    wrap.innerHTML = `
      <div class="page-head">
        <div>
          ${crumbs([{ label: 'Tävlingar', href: '/app' }, { label: 'Konto', href: '/app/settings' }, { label: 'Tävlingsförfrågningar' }])}
          <h1 class="t-d2">Tävlingsförfrågningar</h1>
        </div>
        <div class="btn-row"><a class="btn btn-ghost btn-sm" href="/app/admin/system" data-link>Systemhubb</a></div>
      </div>
      <p class="muted" style="max-width:70ch;">Användare kan inte skapa tävlingar själva. Godkänner du en förfrågan
      skapas tävlingen direkt med sökanden som administratör; nekar du skapas ingen tävling. Sökanden får ditt svar
      via mail och ser beslutet på sin startsida.</p>

      <h2 class="t-h3" style="margin:var(--sp-5) 0 var(--sp-3);">Väntar på beslut (${pending.length})</h2>
      ${pending.length ? pending.map(card).join('')
        : '<div class="empty" style="padding:var(--sp-5);"><p class="muted" style="margin:0;">Inga förfrågningar väntar.</p></div>'}

      ${handled.length ? `
        <details class="mt-5">
          <summary style="cursor:pointer;font-weight:700;">Behandlade förfrågningar (${handled.length})</summary>
          <div class="mt-3">${handled.map(card).join('')}</div>
        </details>` : ''}
    `;

    wrap.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', (e) => withBusy(e.currentTarget, 'Skapar…', async () => {
      const r = reqs.find(x => x.id === b.dataset.approve);
      if (!r) return;
      const msg = wrap.querySelector(`#msg-${CSS.escape(r.id)}`)?.value || '';
      try {
        const cid = await approveCompetitionRequest(r, msg, user.email);
        toast('Tävlingen skapad — sökanden är administratör', 'success');
        navigate(`/app/c/${cid}`);
      } catch (err) { toast('Kunde inte godkänna: ' + err.message, 'error'); }
    })));

    wrap.querySelectorAll('[data-deny]').forEach(b => b.addEventListener('click', async () => {
      const r = reqs.find(x => x.id === b.dataset.deny);
      if (!r) return;
      const msg = wrap.querySelector(`#msg-${CSS.escape(r.id)}`)?.value || '';
      if (!(await confirmDialog(`Neka förfrågan om "${r.name}"? Ingen tävling skapas. Sökanden får ditt svar via mail.`,
        { okLabel: 'Neka förfrågan' }))) return;
      try {
        await denyCompetitionRequest(r.id, msg, user.email);
        toast('Förfrågan nekad');
        await load();
      } catch (err) { toast('Kunde inte neka: ' + err.message, 'error'); }
    }));

    wrap.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Ta bort förfrågan ur listan? Tävlingen (om den skapades) påverkas inte.'))) return;
      try {
        await deleteCompetitionRequest(b.dataset.remove);
        await load();
      } catch (err) { toast('Kunde inte ta bort: ' + err.message, 'error'); }
    }));
  }

  load();
}
