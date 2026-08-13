// Admin view: Anmälan — lists all registrations for a competition, tracks
// payment status (mark paid by reference), shows förhinder reported after the
// registration period, and imports registered patrols into the patrol list.

import { layout, setTopbarCompetition } from '../app.js';
import {
  getCompetition, listRegistrations, updateRegistration, deleteRegistration,
  listPatrols, createPatrol, createUtskick, listUtskick
} from '../store.js';
import { downloadReceiptPdf } from '../pdf.js';
import {
  escapeHtml, formatDate, toast, withBusy, confirmDialog, wireOverlayClose,
  registrationSettings, registrationState, registrationUrl, copyToClipboard,
  isPaymentPaid, isCompAdminUser, isEkonomiUser
} from '../utils.js';
import { icon } from '../icons.js';
import { compTabs, compCrumbs, compLabel, setDocTitle } from '../nav.js';

// Ready-made PM templates — {comp} is replaced with the competition label,
// [HAKPARENTESER] are gaps the admin fills in before sending.
const PM_MALLAR = [
  {
    key: 'pm', label: 'PM inför tävlingen',
    subject: 'PM inför {comp}',
    body: `Hej!\n\nHär kommer PM inför {comp}.\n\nSamling: [TID] vid [PLATS].\nFörsta start: [TID].\n\nAtt ta med:\n- [PACKLISTA]\n\nStartkort och karta finns på tävlingssidan. Vid frågor, kontakta tävlingsledningen.\n\nVäl mötta!`
  },
  {
    key: 'starttider', label: 'Ändrade starttider',
    subject: 'Ändrade starttider — {comp}',
    body: `Hej!\n\nStarttiderna för {comp} har ändrats: [BESKRIV ÄNDRINGEN].\n\nDe uppdaterade tiderna syns på era startkort och på tävlingssidan — kontrollera er nya tid innan tävlingsdagen.\n\nVid frågor, kontakta tävlingsledningen.`
  },
  {
    key: 'plats', label: 'Ändrad samlingsplats/parkering',
    subject: 'Ändrad samlingsplats — {comp}',
    body: `Hej!\n\nSamlingsplatsen för {comp} har ändrats till [NY PLATS]. [VÄGBESKRIVNING/PARKERING]\n\nUppdaterad karta finns på tävlingssidan.\n\nVid frågor, kontakta tävlingsledningen.`
  },
  {
    key: 'installd', label: 'Inställd tävling',
    subject: 'Inställd: {comp}',
    body: `Hej!\n\nTyvärr måste vi ställa in {comp}. [ANLEDNING]\n\nErlagda anmälningsavgifter återbetalas — vi återkommer med detaljer om hur.\n\nVi beklagar det inträffade och hoppas få se er vid ett annat tillfälle.`
  }
];

export async function renderAnmalanAdmin(app, user, cid) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="muted">Laddar…</div>`;
  layout(wrap);

  const comp = await getCompetition(cid).catch(() => null);
  if (!comp) { wrap.innerHTML = `<div class="empty"><h3>Tävlingen hittades inte</h3></div>`; return; }
  setTopbarCompetition(cid, comp, user);

  const isAdmin = isCompAdminUser(comp, user);
  // Ekonomiansvarig/kassör may tick payments off (paidRefs) but nothing else —
  // the Firestore rules enforce the same field-level limit.
  const canPay = isAdmin || isEkonomiUser(comp, user);
  const settings = registrationSettings(comp);
  const state = registrationState(comp);

  const stateLabel = {
    unconfigured: 'Inte aktiverad',
    before: `Öppnar ${settings.opensAt ? formatDate(settings.opensAt) : '—'}`,
    open: `Öppen${settings.closesAt ? ' t.o.m. ' + formatDate(settings.closesAt) : ''}`,
    closed: 'Stängd'
  }[state];

  setDocTitle('Anmälan', compLabel(comp));
  wrap.innerHTML = `
    <div class="page-head">
      <div>
        ${compCrumbs(cid, comp, { label: 'Anmälan' })}
        <h1 class="t-d2">Anmälan</h1>
        <p class="muted">${escapeHtml(stateLabel)} · ${settings.mode === 'kar' ? 'kårvis anmälan' : 'patrullvis anmälan'}</p>
      </div>
      <div class="btn-row">
        ${isAdmin && !comp.demo ? `<button class="btn btn-primary btn-sm" id="send-pm">${icon('send', { size: 14 })} Skicka PM</button>` : ''}
        <button class="btn btn-secondary btn-sm" id="copy-link">${icon('copy', { size: 14 })} Anmälningslänk</button>
      </div>
    </div>

    ${compTabs(cid, 'anmalan', comp, user)}

    <div id="content"><div class="muted">Laddar anmälningar…</div></div>
  `;

  wrap.querySelector('#copy-link').addEventListener('click', () => {
    copyToClipboard(registrationUrl(cid));
    toast('Anmälningslänk kopierad', 'success');
  });

  let regs = [];
  wrap.querySelector('#send-pm')?.addEventListener('click', () => openPmModal());

  // --- "Skicka PM" — massutskick till alla aktiva anmälningar -------------------
  async function openPmModal() {
    // Fetch fresh — the view may have early-returned (anmälan not enabled)
    // before regs loaded, and the recipient list should be current anyway.
    let allRegs = regs;
    if (!allRegs.length) {
      try { allRegs = await listRegistrations(cid); } catch { allRegs = []; }
    }
    const recipients = allRegs.filter(r => !r.cancelled && (r.contact?.email || '').trim());
    const compName = `${comp.shortName || comp.name || ''}${comp.year ? ' ' + comp.year : ''}`;
    const fill = (s) => s.replaceAll('{comp}', compName);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:640px;">
        <div class="modal-head"><h3>Skicka PM till alla anmälda</h3></div>
        <div class="modal-body">
          ${recipients.length === 0 ? `
            <div class="empty" style="padding:var(--sp-6);"><h3>Inga mottagare</h3>
            <p>Det finns inga aktiva anmälningar med e-postadress att skicka till.</p></div>
          ` : `
            <p class="muted t-sm" style="margin-top:0;">Skickas till <strong>${recipients.length} anmälningsansvarig${recipients.length === 1 ? '' : 'a'}</strong>
            (${recipients.slice(0, 3).map(r => escapeHtml(r.kar || r.contact.email)).join(', ')}${recipients.length > 3 ? ' m.fl.' : ''}).
            Varje mail får automatiskt en knapp till mottagarens egen anmälningssida, och svar går till tävlingsledningen.</p>
            <label class="field" for="pm-mall">Mall</label>
            <select class="select" id="pm-mall" style="max-width:320px;">
              <option value="">Eget meddelande</option>
              ${PM_MALLAR.map(m => `<option value="${m.key}">${escapeHtml(m.label)}</option>`).join('')}
            </select>
            <label class="field mt-4" for="pm-subject">Ämne</label>
            <input class="input" id="pm-subject" placeholder="Ex. PM inför ${escapeHtml(compName)}">
            <label class="field mt-4" for="pm-body">Meddelande</label>
            <textarea class="textarea" id="pm-body" rows="12" placeholder="Skriv PM:et här — eller välj en mall ovan och fyll i [luckorna]."></textarea>
            <div class="field-hint">Text i [hakparenteser] är luckor att fylla i innan du skickar.</div>
            <div id="pm-history" class="mt-4"></div>
          `}
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" id="pm-cancel">Avbryt</button>
          ${recipients.length ? `<button class="btn btn-primary" id="pm-send">${icon('send', { size: 14 })} Skicka till ${recipients.length} mottagare</button>` : ''}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    wireOverlayClose(overlay, close);
    overlay.querySelector('#pm-cancel').addEventListener('click', close);

    overlay.querySelector('#pm-mall')?.addEventListener('change', (e) => {
      const m = PM_MALLAR.find(x => x.key === e.target.value);
      if (!m) return;
      overlay.querySelector('#pm-subject').value = fill(m.subject);
      overlay.querySelector('#pm-body').value = fill(m.body);
    });

    // Tidigare utskick — kvitto på vad som redan gått ut.
    const history = overlay.querySelector('#pm-history');
    if (history) {
      listUtskick(cid).then(list => {
        if (!history.isConnected || !list.length) return;
        history.innerHTML = `
          <div class="t-over" style="color:var(--scout-blue);margin-bottom:6px;">Tidigare utskick</div>
          ${list.slice(0, 5).map(u => `
            <div class="t-sm" style="padding:4px 0;border-top:1px solid var(--border);">
              <strong>${escapeHtml(u.subject || '')}</strong>
              <span class="muted"> · ${u.sentAt ? formatDate(u.sentAt) + ` · ${u.recipients ?? '?'} mottagare` : 'skickas…'}</span>
            </div>
          `).join('')}
        `;
      }).catch(() => {});
    }

    overlay.querySelector('#pm-send')?.addEventListener('click', (e) => withBusy(e.currentTarget, 'Skickar…', async () => {
      const subject = overlay.querySelector('#pm-subject').value.trim();
      const body = overlay.querySelector('#pm-body').value.trim();
      if (!subject || !body) { toast('Fyll i både ämne och meddelande.', 'error'); return; }
      if (/\[[^\]]+\]/.test(subject + body)
        && !(await confirmDialog('Meddelandet innehåller ofyllda [luckor] från mallen. Skicka ändå?', { okLabel: 'Skicka ändå', danger: false }))) return;
      try {
        await createUtskick(cid, { subject, body }, user?.email || '');
        toast(`PM:et skickas nu till ${recipients.length} mottagare`, 'success');
        close();
      } catch (err) { toast('Kunde inte skicka: ' + err.message, 'error'); }
    }));
  }

  const content = wrap.querySelector('#content');

  if (!settings.enabled) {
    content.innerHTML = `
      <div class="empty">
        <h3>Anmälan är inte aktiverad</h3>
        <p>Aktivera och konfigurera anmälan (period, prismodell, betalningssätt) under inställningarna.</p>
        ${isAdmin ? `<a class="btn btn-primary mt-4" href="/app/c/${cid}/settings" data-link>Öppna inställningar</a>` : ''}
      </div>
    `;
    return;
  }

  let patrols = [];

  async function load() {
    try {
      [regs, patrols] = await Promise.all([listRegistrations(cid), listPatrols(cid)]);
      regs.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      if (isAdmin && !comp.demo) await migrateLegacyPaid();
      render();
    } catch (e) {
      content.innerHTML = `<div class="empty"><h3>Kunde inte ladda</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  }

  // One-time migration: registrations from before paidRefs stored paid on
  // each payment object. Upgrade any that still lack paidRefs but have legacy
  // paid:true payments, so the admin-only authoritative source is in place.
  async function migrateLegacyPaid() {
    const legacy = regs.filter(r => r.paidRefs === undefined && (r.payments || []).some(p => p.paid));
    if (!legacy.length) return;
    for (const r of legacy) {
      const paidRefs = (r.payments || []).filter(p => p.paid).map(p => p.reference).filter(Boolean);
      try { await updateRegistration(cid, r.id, { paidRefs }); r.paidRefs = paidRefs; }
      catch (e) { console.warn('[ESKIL] paidRefs-migrering misslyckades', r.id, e); }
    }
  }

  function paySum(r, onlyPaid = false) {
    return (r.payments || []).filter(p => !onlyPaid || isPaymentPaid(r, p)).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  }

  function render() {
    const active = regs.filter(r => !r.cancelled);
    const nPatrols = active.reduce((s, r) => s + (r.patrols || []).length, 0);
    const nScouts = active.reduce((s, r) => s + (r.patrols || []).reduce((x, p) => x + (Number(p.antal) || 0), 0), 0);
    const totalAmount = active.reduce((s, r) => s + paySum(r), 0);
    const totalPaid = active.reduce((s, r) => s + paySum(r, true), 0);
    const forhinderCount = regs.reduce((s, r) => s + (r.forhinder || []).length, 0);

    content.innerHTML = `
      <div class="kpi-row">
        <div class="kpi"><div class="k-label">Anmälningar</div><div class="k-value">${active.length}</div></div>
        <div class="kpi"><div class="k-label">Patruller</div><div class="k-value">${nPatrols}</div></div>
        <div class="kpi"><div class="k-label">Scouter</div><div class="k-value">${nScouts}</div></div>
        <div class="kpi"><div class="k-label">Inbetalt</div><div class="k-value">${totalPaid}<span style="font-size:14px;color:var(--fg3);"> / ${totalAmount} kr</span></div></div>
        ${forhinderCount ? `<div class="kpi" style="border-color:var(--utm-pink);"><div class="k-label" style="color:var(--utm-pink);">Förhinder</div><div class="k-value">${forhinderCount}</div></div>` : ''}
      </div>

      ${canPay ? `
        <div class="card mb-4" style="padding:var(--sp-4);">
          <div class="row wrap" style="gap:var(--sp-3);align-items:flex-end;">
            <div style="flex:1;min-width:220px;max-width:320px;">
              <label class="field" for="pay-ref">Pricka av betalning</label>
              <input class="input" id="pay-ref" placeholder="Betalningsreferens, ex. AH26-K7PM" style="text-transform:uppercase;">
            </div>
            <button class="btn btn-primary btn-sm" id="mark-paid">${icon('check', { size: 14 })} Markera betald</button>
            ${(() => {
              const unpaidRegs = active.filter(r => {
                const t = paySum(r), p = paySum(r, true);
                return t > 0 && p < t && (r.contact?.email || '').trim();
              });
              return isAdmin && !comp.demo && unpaidRegs.length ? `
                <span class="spacer"></span>
                <button class="btn btn-secondary btn-sm" id="remind-all">${icon('mail', { size: 14 })} Påminn alla obetalda (${unpaidRegs.length})</button>
              ` : '';
            })()}
          </div>
        </div>
      ` : ''}

      ${regs.length === 0 ? `
        <div class="empty"><h3>Inga anmälningar ännu</h3><p>Dela anmälningslänken så börjar det trilla in.</p></div>
      ` : regs.map(r => regCard(r)).join('')}
    `;

    wireContent();
  }

  function regCard(r) {
    const total = paySum(r);
    const paid = paySum(r, true);
    const nScouts = (r.patrols || []).reduce((s, p) => s + (Number(p.antal) || 0), 0);
    const fullyPaid = total > 0 && paid >= total;
    const existingKeys = new Set(patrols.map(p => `${(p.name || '').toLowerCase()}|${(p.kar || '').toLowerCase()}`));
    const importable = (r.patrols || []).filter(p => !existingKeys.has(`${(p.name || '').toLowerCase()}|${(r.kar || '').toLowerCase()}`));

    return `
      <div class="card mb-4" style="${r.cancelled ? 'opacity:.6;' : ''}" data-reg="${escapeHtml(r.id)}">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:var(--sp-3);flex-wrap:wrap;">
          <div>
            <h3 class="t-h3" style="margin:0;">${escapeHtml(r.kar || '(okänd kår)')}
              ${r.cancelled ? '<span class="badge badge-pink">Avanmäld</span>' : ''}
              ${!r.cancelled && (r.forhinder || []).length ? '<span class="badge badge-orange">Förhinder</span>' : ''}
              ${!r.cancelled && fullyPaid ? '<span class="badge badge-green">Betald</span>' : ''}
              ${!r.cancelled && !fullyPaid && total > 0 ? '<span class="badge">Väntar på betalning</span>' : ''}
            </h3>
            <p class="muted t-sm" style="margin:4px 0 0;">
              ${escapeHtml(r.contact?.name || '')} ·
              <a href="mailto:${escapeHtml(r.contact?.email || '')}" style="color:var(--scout-blue);">${escapeHtml(r.contact?.email || '')}</a>
              ${r.contact?.phone ? ' · ' + escapeHtml(r.contact.phone) : ''}
              · anmäld ${escapeHtml((r.createdAt || '').slice(0, 10))}
            </p>
          </div>
          <div class="btn-row">
            <a class="btn btn-ghost btn-sm" href="/a/${cid}/${escapeHtml(r.id)}" target="_blank" rel="noopener">${icon('external', { size: 14 })} Öppna</a>
            ${isAdmin && !comp.demo && !r.cancelled && !fullyPaid && total > 0 && (r.contact?.email || '').trim() ? `
              <button class="btn btn-secondary btn-sm" data-remind="${escapeHtml(r.id)}" title="${r.reminderSentAt ? 'Senast påmind ' + escapeHtml(formatDate(r.reminderSentAt)) : 'Mailar en betalningspåminnelse med referens och belopp'}">
                ${icon('mail', { size: 14 })} Påminn om betalning${r.reminderSentAt ? ` <span class="muted">(${escapeHtml(formatDate(r.reminderSentAt))})</span>` : ''}
              </button>` : ''}
            ${isAdmin && !r.cancelled && importable.length ? `<button class="btn btn-secondary btn-sm" data-import="${escapeHtml(r.id)}">${icon('users', { size: 14 })} Importera ${importable.length} till patrullistan</button>` : ''}
            ${isAdmin ? `<button class="btn btn-ghost btn-sm" data-delete-reg="${escapeHtml(r.id)}" style="color:var(--utm-pink);">${icon('trash', { size: 14 })} Radera</button>` : ''}
          </div>
        </div>

        <div class="mt-3" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--sp-4);">
          <div>
            <div class="t-over" style="color:var(--scout-blue);margin-bottom:4px;">Patruller (${(r.patrols || []).length}) · ${nScouts} scouter</div>
            ${(r.patrols || []).map(p => `
              <div class="t-sm" style="padding:3px 0;border-bottom:1px solid var(--border);">
                <strong>${escapeHtml(p.name)}</strong>
                <span class="muted"> · ${escapeHtml(p.avdelning || '')} · ${p.antal} scouter</span>
                ${settings.fields.filter(f => f.scope === 'patrull' && p.answers?.[f.id]).map(f => `
                  <div class="muted" style="padding-left:10px;">${escapeHtml(f.label)}: <span style="color:var(--fg1);">${escapeHtml(p.answers[f.id])}</span></div>
                `).join('')}
              </div>
            `).join('') || '<span class="muted t-sm">—</span>'}
            ${settings.fields.some(f => f.scope !== 'patrull' && r.answers?.[f.id]) ? `
              <div class="t-sm mt-2">
                ${settings.fields.filter(f => f.scope !== 'patrull' && r.answers?.[f.id]).map(f => `
                  <div style="padding:2px 0;"><span class="muted">${escapeHtml(f.label)}:</span> ${escapeHtml(r.answers[f.id])}</div>
                `).join('')}
              </div>
            ` : ''}
          </div>
          <div>
            <div class="t-over" style="color:var(--scout-blue);margin-bottom:4px;">Betalningar · ${paid}/${total} kr</div>
            ${(r.payments || []).map(p => `
              <div class="t-sm" style="display:flex;align-items:center;gap:8px;padding:3px 0;border-bottom:1px solid var(--border);">
                <span class="mono" style="font-weight:700;">${escapeHtml(p.reference)}</span>
                <span class="mono">${p.amount} kr</span>
                ${isPaymentPaid(r, p)
                  ? `<span class="badge badge-green">Betald${p.paidAt ? ' ' + escapeHtml(String(p.paidAt).slice(0, 10)) : ''}</span>
                     <button class="btn btn-ghost btn-sm" data-receipt="${escapeHtml(r.id)}:${escapeHtml(p.id)}" style="margin-left:auto;">${icon('download', { size: 14 })} Kvitto</button>
                     ${canPay ? `<button class="btn btn-ghost btn-sm" data-unpay="${escapeHtml(r.id)}:${escapeHtml(p.id)}">Ångra</button>` : ''}`
                  : `<span class="badge">Väntar</span>
                     ${canPay ? `<button class="btn btn-secondary btn-sm" data-pay="${escapeHtml(r.id)}:${escapeHtml(p.id)}" style="margin-left:auto;">Markera betald</button>` : ''}`}
              </div>
            `).join('') || '<span class="muted t-sm">Inga betalningar (gratis eller ej klar)</span>'}
          </div>
        </div>

        ${(r.forhinder || []).length ? `
          <div class="mt-3" style="padding:var(--sp-3) var(--sp-4);background:var(--scout-blue-50);border-left:3px solid var(--utm-pink);border-radius:var(--r-sm);">
            <div class="t-over" style="color:var(--utm-pink);margin-bottom:4px;">Anmälda förhinder</div>
            ${r.forhinder.map(f => `
              <div class="t-sm" style="margin-bottom:6px;">
                <strong>${escapeHtml(f.patrol || 'Hela anmälan')}</strong>
                <span class="muted">· ${escapeHtml((f.at || '').slice(0, 10))}</span>
                <div>${escapeHtml(f.message)}</div>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  // Create patrol docs for a registration's patrols that aren't already in
  // the patrol list (matched on name+kår, numbered after the highest existing).
  // Returns how many were added.
  async function importPatrolsFromReg(r) {
    const existingKeys = new Set(patrols.map(p => `${(p.name || '').toLowerCase()}|${(p.kar || '').toLowerCase()}`));
    let nextNumber = patrols.reduce((m, p) => Math.max(m, Number(p.number) || 0), 0) + 1;
    let added = 0;
    for (const p of (r.patrols || [])) {
      const key = `${(p.name || '').toLowerCase()}|${(r.kar || '').toLowerCase()}`;
      if (existingKeys.has(key)) continue;
      await createPatrol(cid, {
        name: p.name,
        avdelning: p.avdelning || 'Spårare',
        kar: r.kar || '',
        antal: Number(p.antal) || 0,
        number: nextNumber++
      });
      existingKeys.add(key);
      added++;
    }
    return added;
  }

  // Returns { imported } when marking paid, or null when un-marking. The
  // receipt mail (PDF attached) is sent by the Cloud Function that reacts to
  // the payment flipping to paid — nothing to send from here.
  // Once the registration is fully paid its patrols are auto-imported into
  // the patrol list.
  async function setPaid(regId, payId, paidValue) {
    const r = regs.find(x => x.id === regId);
    if (!r) return null;
    const pay = (r.payments || []).find(p => p.id === payId);
    if (!pay || !pay.reference) return null;
    // Payment status is the admin-only paidRefs array (references the kassör
    // has ticked off) — anonymous manage-link holders cannot forge it.
    const refs = new Set(r.paidRefs || []);
    if (paidValue) refs.add(pay.reference); else refs.delete(pay.reference);
    const paidRefs = [...refs];
    await updateRegistration(cid, regId, { paidRefs });
    let result = null;
    if (paidValue) {
      const fullyPaid = (r.payments || []).length > 0 && (r.payments || []).every(p => paidRefs.includes(p.reference));
      // Patrol writes require admin (rules) — when the kassör ticks the last
      // payment the auto-import is skipped; an admin imports via the card's
      // "Importera till patrullistan" button instead.
      const imported = (fullyPaid && !r.cancelled && isAdmin) ? await importPatrolsFromReg(r) : 0;
      result = { imported };
    }
    await load();
    return result;
  }

  function paidToast(prefix, res, email) {
    const parts = [prefix];
    if (res?.imported) parts.push(`${res.imported} patrull${res.imported === 1 ? '' : 'er'} importerad${res.imported === 1 ? '' : 'e'} till patrullistan`);
    if (email) parts.push(`kvitto mailas till ${email}`);
    return parts.join(' · ');
  }

  function wireContent() {
    content.querySelectorAll('[data-pay]').forEach(b => b.addEventListener('click', () => withBusy(b, '…', async () => {
      const [regId, payId] = b.dataset.pay.split(':');
      const email = regs.find(x => x.id === regId)?.contact?.email;
      try {
        const res = await setPaid(regId, payId, true);
        toast(paidToast('Markerad som betald', res, email), 'success');
      }
      catch (e) { toast('Fel: ' + e.message, 'error'); }
    })));

    content.querySelectorAll('[data-receipt]').forEach(b => b.addEventListener('click', () => withBusy(b, '…', async () => {
      const [regId, payId] = b.dataset.receipt.split(':');
      const r = regs.find(x => x.id === regId);
      const p = (r?.payments || []).find(x => x.id === payId);
      if (!r || !p) return;
      try { await downloadReceiptPdf(comp, r, p); }
      catch (e) { toast('Kunde inte skapa kvittot: ' + e.message, 'error'); }
    })));
    content.querySelectorAll('[data-unpay]').forEach(b => b.addEventListener('click', () => withBusy(b, '…', async () => {
      const [regId, payId] = b.dataset.unpay.split(':');
      try { await setPaid(regId, payId, false); toast('Betalning återställd'); }
      catch (e) { toast('Fel: ' + e.message, 'error'); }
    })));

    const markBtn = content.querySelector('#mark-paid');
    markBtn?.addEventListener('click', () => withBusy(markBtn, 'Söker…', async () => {
      const ref = content.querySelector('#pay-ref').value.replace(/\s+/g, '').toUpperCase();
      if (!ref) { toast('Ange en betalningsreferens', 'error'); return; }
      let hit = null;
      for (const r of regs) {
        const p = (r.payments || []).find(p => (p.reference || '').toUpperCase() === ref);
        if (p) { hit = { r, p }; break; }
      }
      if (!hit) { toast('Ingen betalning hittades med referensen ' + ref, 'error'); return; }
      if (isPaymentPaid(hit.r, hit.p)) { toast('Den betalningen är redan markerad som betald'); return; }
      try {
        const res = await setPaid(hit.r.id, hit.p.id, true);
        toast(paidToast(`${hit.r.kar}: ${hit.p.amount} kr markerad som betald`, res, hit.r.contact?.email), 'success');
      } catch (e) { toast('Fel: ' + e.message, 'error'); }
    }));

    content.querySelector('#remind-all')?.addEventListener('click', (e) => withBusy(e.currentTarget, 'Skickar…', async () => {
      const unpaidRegs = regs.filter(r => {
        const t = paySum(r), p = paySum(r, true);
        return !r.cancelled && t > 0 && p < t && (r.contact?.email || '').trim();
      });
      if (!(await confirmDialog(
        `Skicka betalningspåminnelse till ${unpaidRegs.length} anmälningar som inte är fullbetalda?`,
        { okLabel: `Påminn ${unpaidRegs.length} st`, danger: false }
      ))) return;
      try {
        const stamp = new Date().toISOString();
        for (const r of unpaidRegs) {
          await updateRegistration(cid, r.id, { reminderRequestedAt: stamp });
        }
        toast(`Påminnelser skickas till ${unpaidRegs.length} mottagare`, 'success');
        await load();
      } catch (err) { toast('Fel: ' + err.message, 'error'); }
    }));

    // Betalningspåminnelse — kassören stämplar reminderRequestedAt; Cloud
    // Function onRegistrationUpdated ser stämpeln, mailar de obetalda
    // referenserna med ändringslänken och skriver reminderSentAt tillbaka.
    content.querySelectorAll('[data-remind]').forEach(b => b.addEventListener('click', () => withBusy(b, 'Skickar…', async () => {
      const r = regs.find(x => x.id === b.dataset.remind);
      if (!r) return;
      const unpaid = (r.payments || []).filter(p => !isPaymentPaid(r, p));
      if (!(await confirmDialog(
        `Skicka betalningspåminnelse till ${r.contact?.email || ''}? Gäller ${unpaid.map(p => `${p.amount} kr (${p.reference})`).join(' + ')}.`,
        { okLabel: 'Skicka påminnelse', danger: false }
      ))) return;
      try {
        await updateRegistration(cid, r.id, { reminderRequestedAt: new Date().toISOString() });
        toast('Påminnelsen skickas till ' + (r.contact?.email || ''), 'success');
        await load();
      } catch (e) { toast('Fel: ' + e.message, 'error'); }
    })));

    content.querySelectorAll('[data-delete-reg]').forEach(b => b.addEventListener('click', () => withBusy(b, 'Raderar…', async () => {
      const r = regs.find(x => x.id === b.dataset.deleteReg);
      if (!r) return;
      const ok = await confirmDialog(
        `Radera anmälan för ${r.kar || 'okänd kår'} permanent? ` +
        `Patruller, betalningar och förhinder i anmälan försvinner och kårens ändringslänk slutar fungera. ` +
        `Patruller som redan importerats till patrullistan ligger kvar och tas i så fall bort där. Detta går inte att ångra.`,
        { okLabel: 'Radera anmälan' }
      );
      if (!ok) return;
      try {
        await deleteRegistration(cid, r.id);
        toast('Anmälan raderad');
        await load();
      } catch (e) { toast('Fel: ' + e.message, 'error'); }
    })));

    content.querySelectorAll('[data-import]').forEach(b => b.addEventListener('click', () => withBusy(b, 'Importerar…', async () => {
      const r = regs.find(x => x.id === b.dataset.import);
      if (!r) return;
      if (!(await confirmDialog(`Lägga till ${r.kar}:s patruller i patrullistan?`, { okLabel: 'Lägg till', danger: false }))) return;
      try {
        const added = await importPatrolsFromReg(r);
        toast(`${added} patrull${added === 1 ? '' : 'er'} tillagd${added === 1 ? '' : 'a'}`, 'success');
        await load();
      } catch (e) {
        toast('Fel vid import: ' + e.message, 'error');
      }
    })));
  }

  load();
}
