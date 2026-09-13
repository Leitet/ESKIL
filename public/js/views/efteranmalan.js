// Efteranmälan — ledningen lägger till patruller EFTER att anmälan stängt
// (eller när som helst: kåren som ringer). Kårens egen väg går via
// ändringslänken och låses av perioden; den här vägen är admins och går via
// reglernas isCompAdmin — ingen rules-ändring, ingen öppning av perioden för
// alla andra.
//
// Tre saker skiljer den från kårens egen utökning i anmalan.js:
// 1. Beloppet är REDIGERBART. Prismodellen förifyller mellanskillnaden
//    (planEfteranmalan i utils.js — samma beräkning som kårens utökning), men
//    efteranmälningsavgift och efterskänkning är ledningens beslut och finns
//    inte i prismodellen. 0 kr ger ingen betalningspost alls.
// 2. Kåren står inte vid skärmen. Referensen når den som ska betala bara via
//    mailet som Cloud Function onRegistrationUpdated skickar när
//    `efteranmalningar` växer (befintlig anmälan) respektive
//    onRegistrationCreated (ny anmälan). Därför bär posten patrullnamn, belopp
//    och referens själv.
// 3. Patrullerna kan läggas i patrullistan DIREKT — efteranmälan sker oftast
//    dagarna före tävlingen, när startlistan redan är på väg till tryck.
//
// Ledningens adress skrivs ALDRIG på anmälan: dokumentet är läsbart för den
// som har ändringslänken. Vem som efteranmälde står i sekretariatets logg,
// som är member-only.

import { getRegistration, createRegistration, updateRegistration, loggHandelse } from '../store.js';
import {
  allowedAvdelningar, escapeHtml, toast, withBusy, registrationSettings,
  makePaymentReference, paymentEntry, paymentsSum, planEfteranmalan
} from '../utils.js';
import { icon } from '../icons.js';

const isoNow = () => new Date().toISOString();

// `importera(reg, namn)` är admin-vyns import till patrullistan (samma
// funktion som knappen på anmälningskortet), avgränsad till de nya namnen.
// `onSaved` körs efter en lyckad sparning — vyn laddar om.
export function openEfteranmalanModal({ cid, comp, user, reg = null, importera = null, onSaved = null }) {
  const settings = registrationSettings(comp);
  const karvis = settings.mode === 'kar';
  const ny = !reg;
  const faltPatrull = settings.fields.filter(f => f.scope === 'patrull');
  const faltAnmalan = ny ? settings.fields.filter(f => f.scope !== 'patrull') : [];
  const avd = allowedAvdelningar(comp);

  const tomRad = () => ({ name: '', avdelning: avd[0]?.key || 'Spårare', antal: 5, answers: {} });
  const rows = [tomRad()];
  // Admin har skrivit ett eget belopp — prisuppdateringen får inte skriva över det.
  let beloppRort = false;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:640px;">
      <div class="modal-head">
        <h3>${ny ? 'Ny efteranmälan' : `Efteranmäl patrull — ${escapeHtml(reg.kar || '')}`}</h3>
        <button class="icon-btn" id="x" aria-label="Stäng">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <p class="muted t-sm" style="margin-top:0;">${ny
          ? 'Skapar en anmälan åt kåren. Anmälningsansvarig får bekräftelsen med ändringslänk och betalningsreferens per mail, precis som vid en vanlig anmälan.'
          : 'Patrullen läggs till i kårens anmälan. Mellanskillnaden blir en ny betalning med egen referens, och anmälningsansvarig får ett mail med referensen och sin ändringslänk.'}</p>
        <form id="f" class="field-group">
          ${ny ? `
            <div>
              <label class="field" for="ea-kar">Kår</label>
              <input class="input" id="ea-kar" required placeholder="Ex. Lindsdals Scoutkår" autocomplete="organization">
            </div>
            <div class="grid grid-2">
              <div>
                <label class="field" for="ea-cname">Anmälningsansvarig</label>
                <input class="input" id="ea-cname" required placeholder="För- och efternamn">
              </div>
              <div>
                <label class="field" for="ea-cphone">Telefon</label>
                <input class="input" id="ea-cphone" type="tel" placeholder="070-123 45 67">
              </div>
            </div>
            <div>
              <label class="field" for="ea-cemail">E-post</label>
              <input class="input" id="ea-cemail" type="email" required placeholder="namn@exempel.se">
              <div class="field-hint">Hit går bekräftelsen med ändringslänken och betalningsreferensen.</div>
            </div>
            ${faltAnmalan.map(f => `
              <div>
                <label class="field">${escapeHtml(f.label)}</label>
                <textarea class="textarea" rows="2" data-anm-answer="${escapeHtml(f.id)}"></textarea>
              </div>`).join('')}
          ` : ''}
          <div id="ea-rader"></div>
          ${karvis ? `<div><button type="button" class="btn btn-secondary btn-sm" id="ea-add">${icon('plus', { size: 14 })} Lägg till patrull</button></div>` : ''}
          <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
            <div class="t-sm" id="ea-pris"></div>
            <div class="mt-3" style="max-width:280px;">
              <label class="field" for="ea-belopp">Ny betalning (kr)</label>
              <input class="input" id="ea-belopp" type="number" min="0" step="1" inputmode="numeric">
              <div class="field-hint">Förifyllt med mellanskillnaden enligt prismodellen. Ändra om ni tar ut efteranmälningsavgift eller vill efterskänka — 0 kr ger ingen betalning.</div>
            </div>
          </div>
          ${importera ? `
            <label style="display:inline-flex;align-items:flex-start;gap:8px;cursor:pointer;">
              <input type="checkbox" id="ea-import" checked style="margin-top:3px;">
              <span>Lägg till i patrullistan direkt<div class="field-hint">Annars importeras patrullen när anmälan är fullbetald, eller via knappen på anmälan.</div></span>
            </label>` : ''}
        </form>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel">Avbryt</button>
        <button class="btn btn-primary" id="save">${ny ? 'Skapa efteranmälan' : 'Efteranmäl'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  // Ingen stängning på bakgrundstryck — det är ett formulär, och en tappad rad är arbete.
  overlay.querySelector('#x').onclick = close;
  overlay.querySelector('#cancel').onclick = close;

  const raderEl = overlay.querySelector('#ea-rader');
  const prisEl = overlay.querySelector('#ea-pris');
  const beloppEl = overlay.querySelector('#ea-belopp');

  function radHtml(r, i) {
    return `
      <div style="padding:var(--sp-4);border:1px solid var(--border);border-radius:var(--r-sm);margin-bottom:var(--sp-3);" data-idx="${i}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--sp-2);">
          <strong>Patrull ${i + 1}</strong>
          ${rows.length > 1 ? `<button type="button" class="btn btn-ghost btn-sm" data-remove="${i}">${icon('trash', { size: 14 })} Ta bort</button>` : ''}
        </div>
        <div class="grid grid-3">
          <div>
            <label class="field">Patrullnamn</label>
            <input class="input" required data-f="name" value="${escapeHtml(r.name)}" placeholder="Ex. Rävarna">
          </div>
          <div>
            <label class="field">Avdelning</label>
            <select class="select" data-f="avdelning">
              ${avd.map(a => `<option value="${a.key}" ${r.avdelning === a.key ? 'selected' : ''}>${a.key} (${a.range})</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="field">Antal scouter</label>
            <input class="input" required data-f="antal" type="number" min="1" inputmode="numeric" value="${r.antal || ''}">
          </div>
        </div>
        ${faltPatrull.map(f => `
          <div class="mt-3">
            <label class="field">${escapeHtml(f.label)}</label>
            <textarea class="textarea" rows="2" data-answer="${escapeHtml(f.id)}">${escapeHtml(r.answers?.[f.id] || '')}</textarea>
          </div>`).join('')}
      </div>`;
  }

  function syncRows() {
    raderEl.querySelectorAll('[data-idx]').forEach(el => {
      const r = rows[Number(el.dataset.idx)];
      if (!r) return;
      el.querySelectorAll('[data-f]').forEach(inp => { r[inp.dataset.f] = inp.value; });
      el.querySelectorAll('[data-answer]').forEach(t => { r.answers[t.dataset.answer] = t.value; });
    });
  }

  function renderRows() {
    raderEl.innerHTML = rows.map(radHtml).join('');
    raderEl.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => {
      syncRows();
      rows.splice(Number(b.dataset.remove), 1);
      renderRows();
      uppdateraPris();
    }));
    raderEl.querySelectorAll('input, select, textarea').forEach(el =>
      el.addEventListener('input', () => { syncRows(); uppdateraPris(); }));
  }

  function cleanRows() {
    return rows.map(r => ({
      name: String(r.name || '').trim(),
      avdelning: r.avdelning,
      antal: Number(r.antal) || 0,
      answers: Object.fromEntries(
        Object.entries(r.answers || {}).map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v))
    }));
  }

  function uppdateraPris() {
    const plan = planEfteranmalan(settings.pricing, reg, cleanRows());
    prisEl.innerHTML = ny
      ? `Pris enligt prismodellen: <strong>${plan.totalAmount} kr</strong>`
      : `Nytt pris för hela anmälan: <strong>${plan.totalAmount} kr</strong> · redan som betalningsposter: <strong>${paymentsSum(reg)} kr</strong> · mellanskillnad: <strong>${plan.diff} kr</strong>`;
    if (!beloppRort) beloppEl.value = String(plan.diff);
  }
  beloppEl.addEventListener('input', () => { beloppRort = true; });
  overlay.querySelector('#ea-add')?.addEventListener('click', () => {
    syncRows();
    rows.push(tomRad());
    renderRows();
    uppdateraPris();
  });

  renderRows();
  uppdateraPris();

  const saveBtn = overlay.querySelector('#save');
  saveBtn.addEventListener('click', () => withBusy(saveBtn, 'Sparar…', async () => {
    syncRows();
    if (!overlay.querySelector('#f').reportValidity()) return;
    const nya = cleanRows();
    if (!nya.length || nya.some(p => !p.name || p.antal < 1)) { toast('Varje patrull behöver namn och antal.', 'error'); return; }
    const namn = nya.map(p => p.name);
    if (new Set(namn.map(n => n.toLowerCase())).size !== namn.length) { toast('Två patruller har samma namn.', 'error'); return; }
    const amount = Math.max(0, Math.round(Number(beloppEl.value) || 0));
    const importeraNu = !!overlay.querySelector('#ea-import')?.checked;

    try {
      const reference = amount > 0 ? makePaymentReference(comp) : null;
      const post = { at: isoNow(), patrols: namn, amount, reference };
      let regId;
      let sparad;
      if (ny) {
        const answers = {};
        overlay.querySelectorAll('[data-anm-answer]').forEach(t => {
          const v = t.value.trim();
          if (v) answers[t.dataset.anmAnswer] = v;
        });
        const plan = planEfteranmalan(settings.pricing, null, nya);
        regId = crypto.randomUUID();
        sparad = {
          kar: overlay.querySelector('#ea-kar').value.trim(),
          contact: {
            name: overlay.querySelector('#ea-cname').value.trim(),
            email: overlay.querySelector('#ea-cemail').value.trim().toLowerCase(),
            phone: overlay.querySelector('#ea-cphone').value.trim()
          },
          patrols: plan.patrols,
          answers,
          mode: settings.mode,
          totalAmount: plan.totalAmount,
          payments: reference ? [paymentEntry({ amount, reference })] : [],
          cancelled: false,
          forhinder: [],
          efteranmalningar: [post],
          createdAt: isoNow(),
          updatedAt: isoNow()
        };
        await createRegistration(cid, regId, sparad);
      } else {
        // FÄRSK läsning — kortet kan ha stått öppet medan kassören prickade av
        // eller kåren skickade en ändring, och en förlegad kopia hade skrivit
        // över det. Samma skäl som persistEdit i anmalan.js.
        const fresh = await getRegistration(cid, reg.id).catch(() => null) || reg;
        if (fresh.cancelled) { toast('Anmälan är avanmäld — gör en ny efteranmälan åt kåren i stället.', 'error'); return; }
        const upptagna = new Set((fresh.patrols || []).map(p => String(p.name || '').toLowerCase()));
        const dubblett = namn.find(n => upptagna.has(n.toLowerCase()));
        if (dubblett) { toast(`${dubblett} finns redan i anmälan.`, 'error'); return; }
        const plan = planEfteranmalan(settings.pricing, fresh, nya);
        const payments = [...(fresh.payments || [])];
        if (reference) payments.push(paymentEntry({ amount, reference }));
        regId = fresh.id;
        await updateRegistration(cid, regId, {
          patrols: plan.patrols,
          totalAmount: plan.totalAmount,
          payments,
          efteranmalningar: [...(fresh.efteranmalningar || []), post],
          updatedAt: isoNow()
        });
        sparad = { ...fresh, patrols: plan.patrols };
      }

      let importerade = 0;
      if (importeraNu && importera) {
        try { importerade = await importera({ ...sparad, id: regId }, namn); }
        catch (e) { toast('Anmälan sparad, men importen till patrullistan misslyckades: ' + e.message, 'error'); }
      }
      loggHandelse(cid, {
        vad: 'efteranmalan', av: user?.email || '',
        text: `${sparad.kar}: ${namn.join(', ')} · ${amount} kr${reference ? ` (${reference})` : ''}`
      });
      close();
      const antal = namn.length === 1 ? 'Patrullen efteranmäld' : `${namn.length} patruller efteranmälda`;
      const betalning = reference ? `${amount} kr, referens ${reference}` : 'ingen ny betalning';
      const import_ = importerade ? ` · ${importerade} tillagd${importerade === 1 ? '' : 'a'} i patrullistan` : '';
      toast(`${antal} · ${betalning}${import_}`, 'success');
      onSaved?.();
    } catch (e) {
      toast('Fel: ' + e.message, 'error');
    }
  }));
}
