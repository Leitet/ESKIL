// Full-page competition settings — replaces the old "Redigera tävling" modal
// and absorbs the per-competition bits of the old settings view.
//
// Tabs: Grund · Regler & info · Start/Mål · Tävlingsledning · Användare
//
// Each tab has its own form and Save button so the user can focus on one
// concern at a time without scrolling through a giant modal.

import { layout, setTopbarCompetition } from '../app.js';
import {
  getCompetition, updateCompetition, deleteCompetition,
  setCompetitionUsers, listControls, closeCompetition, reopenCompetition
} from '../store.js';
import {
  db, doc, getDoc, getDocs, collection, query, where
} from '../firebase.js';
import {
  escapeHtml, toast, withBusy, confirmDialog,
  registrationSettings, REG_PRICING_MODELS, registrationUrl, copyToClipboard,
  AVDELNINGAR, allowedAvdelningar,
  isCompAdminUser, normEmail
} from '../utils.js';
import { createManagementForm } from '../managementform.js';
import { icon } from '../icons.js';
import { navigate } from '../router.js';
import { initMapPicker } from '../mappicker.js';

const TABS = [
  { key: 'basic',      label: 'Grund'           },
  { key: 'rules',      label: 'Regler & info'   },
  { key: 'anmalan',    label: 'Anmälan'         },
  { key: 'startfinish',label: 'Start/Mål'       },
  { key: 'management', label: 'Tävlingsledning' },
  { key: 'members',    label: 'Användare'       }
];

let activeTab = 'basic';

export async function renderCompetitionSettings(app, user, cid) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="muted">Laddar…</div>`;
  layout(wrap);

  let comp;
  try { comp = await getCompetition(cid); } catch (e) {
    wrap.innerHTML = `<div class="empty"><h3>Ingen åtkomst</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }
  if (!comp) { wrap.innerHTML = `<div class="empty"><h3>Tävlingen hittades inte</h3></div>`; return; }
  setTopbarCompetition(cid, comp, user);

  const isSuperAdmin = user.role === 'super-admin';
  const isAdmin = isSuperAdmin || isCompAdminUser(comp, user);
  if (!isAdmin) {
    wrap.innerHTML = `<div class="empty"><h3>Inte tillgängligt</h3><p>Bara tävlingsadministratörer kan öppna inställningarna.</p></div>`;
    return;
  }
  const isDemoReadOnly = comp.demo && !isSuperAdmin;

  const refresh = async () => {
    comp = await getCompetition(cid);
    renderAll();
  };

  const renderAll = () => {
    wrap.innerHTML = `
      <div class="page-head">
        <div>
          <div class="t-over" style="color:var(--avent-orange);">${escapeHtml(comp.shortName || '')} · ${comp.year || ''}${comp.demo ? ' · DEMO' : ''}</div>
          <h1 class="t-d2">Inställningar</h1>
          <p class="muted">${escapeHtml(comp.name)}${isDemoReadOnly ? ' · skrivskyddat (demospår)' : ''}</p>
        </div>
        <div class="btn-row">
          <a class="btn btn-ghost" href="/app/c/${cid}" data-link>${icon('arrow-left', { size: 16 })} Tillbaka</a>
        </div>
      </div>

      <div class="tabs">
        ${TABS.map(t => `<a href="#${t.key}" data-tab="${t.key}" class="${activeTab === t.key ? 'active' : ''}">${escapeHtml(t.label)}</a>`).join('')}
      </div>

      <div id="tab-body"></div>
    `;

    wrap.querySelectorAll('[data-tab]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        activeTab = a.dataset.tab;
        renderAll();
      });
    });

    const body = wrap.querySelector('#tab-body');
    if (activeTab === 'basic')       body.appendChild(renderBasicTab(comp, cid, refresh, isDemoReadOnly, isSuperAdmin));
    if (activeTab === 'rules')       body.appendChild(renderRulesTab(comp, cid, refresh, isDemoReadOnly));
    if (activeTab === 'anmalan')     body.appendChild(renderAnmalanTab(comp, cid, refresh, isDemoReadOnly));
    if (activeTab === 'startfinish') body.appendChild(renderStartFinishTab(comp, cid, refresh, isDemoReadOnly));
    if (activeTab === 'management')  body.appendChild(renderManagementTab(comp, cid, refresh, isDemoReadOnly));
    if (activeTab === 'members')     body.appendChild(renderMembersTab(comp, cid, user, refresh));
  };

  renderAll();
}

// ---- helpers ---------------------------------------------------------------
function section(title, bodyHtml, opts = {}) {
  const card = document.createElement('section');
  card.className = 'card';
  card.innerHTML = `
    <h3 class="t-h3" style="margin-top:0;">${escapeHtml(title)}</h3>
    ${opts.hint ? `<p class="muted t-sm" style="margin-top:-6px;">${escapeHtml(opts.hint)}</p>` : ''}
    ${bodyHtml}
  `;
  return card;
}

function saveRow(btnLabel, disabled = false) {
  return `<div class="btn-row mt-6" style="justify-content:flex-end;">
    <button class="btn btn-primary" data-save ${disabled ? 'disabled' : ''}>${escapeHtml(btnLabel)}</button>
  </div>`;
}

function wireSave(host, handler, label = 'Sparar…') {
  const btn = host.querySelector('[data-save]');
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    const form = host.querySelector('form');
    if (form && !form.reportValidity()) return;
    await withBusy(btn, label, async () => {
      try {
        await handler();
        toast('Sparat', 'success');
      } catch (err) {
        console.error(err);
        toast('Fel: ' + err.message, 'error');
      }
    });
  });
}

// ---- tabs ------------------------------------------------------------------

function renderBasicTab(comp, cid, refresh, readOnly, isSuperAdmin) {
  const host = document.createElement('div');
  host.className = 'field-group';

  const card = section('Grunduppgifter', `
    <form class="field-group" ${readOnly ? 'inert' : ''}>
      <div class="grid grid-2">
        <div>
          <label class="field" for="shortName">Kort namn</label>
          <input class="input" id="shortName" required value="${escapeHtml(comp.shortName || '')}">
        </div>
        <div>
          <label class="field" for="year">År</label>
          <input class="input" id="year" type="number" required value="${comp.year || ''}">
        </div>
      </div>
      <div>
        <label class="field" for="name">Fullständigt namn</label>
        <input class="input" id="name" required value="${escapeHtml(comp.name || '')}">
      </div>
      <div class="grid grid-2">
        <div>
          <label class="field" for="date">Datum</label>
          <input class="input" id="date" type="date" value="${comp.date || ''}">
        </div>
        <div>
          <label class="field" for="location">Plats</label>
          <input class="input" id="location" value="${escapeHtml(comp.location || '')}">
        </div>
      </div>
      <div>
        <label class="field" for="organizer">Arrangör</label>
        <input class="input" id="organizer" value="${escapeHtml(comp.organizer || '')}">
      </div>
      <div>
        <label class="field" for="description">Beskrivning</label>
        <textarea class="textarea" id="description">${escapeHtml(comp.description || '')}</textarea>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
        <label class="field">Avdelningar som deltar</label>
        <div class="field-hint" style="margin-bottom:var(--sp-3);">Endast valda avdelningar visas i t.ex. anmälan och patrullformulär. Minst en måste vara vald.</div>
        <div class="row wrap" style="gap:6px;">
          ${(() => {
            const allowed = new Set(allowedAvdelningar(comp).map(a => a.key));
            return AVDELNINGAR.map(a => {
              const checked = allowed.has(a.key);
              return `<label style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1.5px solid ${checked ? 'var(--scout-blue)' : 'var(--border)'};border-radius:999px;background:${checked ? 'var(--scout-blue-100)' : 'var(--white)'};cursor:pointer;font-size:13px;font-weight:600;">
                <input type="checkbox" data-avd-part="${a.key}" ${checked ? 'checked' : ''} style="margin:0;">
                <span class="dot ${a.short}" style="margin:0;"></span>${a.key}
              </label>`;
            }).join('');
          })()}
        </div>
      </div>
    </form>
    ${readOnly ? '<p class="muted t-sm">Skrivskyddad demotävling — bara superadministratör kan ändra.</p>' : saveRow('Spara grunduppgifter')}
  `);
  host.appendChild(card);

  // Live-restyle the avdelnings-chips as they're toggled.
  card.querySelectorAll('[data-avd-part]').forEach(cb => cb.addEventListener('change', () => {
    const label = cb.closest('label');
    label.style.borderColor = cb.checked ? 'var(--scout-blue)' : 'var(--border)';
    label.style.background = cb.checked ? 'var(--scout-blue-100)' : 'var(--white)';
  }));

  wireSave(card, async () => {
    const avdelningar = [...card.querySelectorAll('[data-avd-part]')]
      .filter(cb => cb.checked).map(cb => cb.dataset.avdPart);
    if (!avdelningar.length) throw new Error('Minst en avdelning måste vara vald.');
    await updateCompetition(cid, {
      name: card.querySelector('#name').value.trim(),
      shortName: card.querySelector('#shortName').value.trim(),
      year: Number(card.querySelector('#year').value),
      date: card.querySelector('#date').value || null,
      location: card.querySelector('#location').value.trim(),
      organizer: card.querySelector('#organizer').value.trim(),
      description: card.querySelector('#description').value.trim(),
      avdelningar
    });
    await refresh();
  });

  // Lifecycle: avsluta/återöppna tävlingen (competition admins)
  if (!readOnly) {
    const lifecycle = document.createElement('section');
    lifecycle.className = 'card mt-6';
    if (comp.closed) {
      lifecycle.innerHTML = `
        <h3 class="t-h3" style="margin-top:0;">Tävlingen är avslutad <span class="badge badge-gray">Avslutad</span></h3>
        <p class="muted">Alla användare och kontrollansvariga är borttagna, kontrollerna är stängda och tävlingen är skrivskyddad för alla utom administratörer. Publika sidor och resultat går fortfarande att titta på.</p>
        <button class="btn btn-secondary mt-4" id="reopen-comp">Återöppna tävlingen</button>
      `;
      lifecycle.querySelector('#reopen-comp').addEventListener('click', (e) => withBusy(e.currentTarget, 'Återöppnar…', async () => {
        try {
          await reopenCompetition(cid);
          toast('Tävlingen är återöppnad', 'success');
          await refresh();
        } catch (err) { toast('Fel: ' + err.message, 'error'); }
      }));
    } else {
      lifecycle.innerHTML = `
        <h3 class="t-h3" style="margin-top:0;">Avsluta tävling</h3>
        <p class="muted">När tävlingen är genomförd: raderar samtliga användare och kontrollansvariga
        (inklusive namn — bara administratörer ligger kvar), stänger alla kontroller för rapportering
        och gör tävlingen skrivskyddad. Resultat och publika sidor går fortfarande att titta på.
        Kan återöppnas, men de borttagna personerna återställs inte.</p>
        <button class="btn btn-secondary mt-4" id="close-comp">Avsluta tävling</button>
      `;
      lifecycle.querySelector('#close-comp').addEventListener('click', (e) => withBusy(e.currentTarget, 'Avslutar…', async () => {
        if (!(await confirmDialog(`Avsluta "${comp.name}"? Alla användare och kontrollansvariga raderas (administratörer ligger kvar) och alla kontroller stängs.`, { okLabel: 'Avsluta tävling' }))) return;
        try {
          await closeCompetition(cid);
          toast('Tävlingen är avslutad', 'success');
          await refresh();
        } catch (err) { toast('Fel: ' + err.message, 'error'); }
      }));
    }
    host.appendChild(lifecycle);
  }

  // Danger zone (delete) — super-admin only
  if (isSuperAdmin) {
    const danger = document.createElement('section');
    danger.className = 'card mt-6';
    danger.style.borderColor = 'var(--utm-pink)';
    danger.innerHTML = `
      <h3 class="t-h3" style="margin-top:0;color:var(--utm-pink);">Farlig zon</h3>
      <p class="muted">Tar bort tävlingen permanent. Patruller, kontroller och poäng följer med. Kan inte ångras.</p>
      <button class="btn btn-danger mt-4" id="delete-comp">${icon('trash', { size: 16 })} Ta bort tävling</button>
    `;
    danger.querySelector('#delete-comp').addEventListener('click', async () => {
      if (!(await confirmDialog(`Ta bort "${comp.name}" för gott? Detta går inte att ångra.`))) return;
      try {
        await deleteCompetition(cid);
        toast('Tävling borttagen');
        navigate('/app');
      } catch (e) {
        toast('Fel: ' + e.message, 'error');
      }
    });
    host.appendChild(danger);
  }

  return host;
}

function renderRulesTab(comp, cid, refresh, readOnly) {
  const host = document.createElement('div');
  host.className = 'field-group';

  const card = section('Regler och information', `
    <form class="field-group" ${readOnly ? 'inert' : ''}>
      <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
        <input type="checkbox" id="anonymousControls" ${comp.anonymousControls !== false ? 'checked' : ''} style="margin-top:4px;">
        <span>
          <strong>Anonyma kontroller</strong>
          <div class="field-hint" style="margin-top:2px;">Patruller ser bara "Kontroll N" tills de fått poäng — då avslöjas kontrollens namn och poängen.</div>
        </span>
      </label>

      <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
          <input type="checkbox" id="publicScores" ${comp.publicScores !== false ? 'checked' : ''} style="margin-top:4px;">
          <span>
            <strong>Publicera poäng på publika sidan</strong>
            <div class="field-hint" style="margin-top:2px;">Avbockad: publika sidan visar bara en grön bock när en patrull genomfört en kontroll — inga poäng, totaler eller placeringar. Bocka i när poängställningen ska publiceras (kan även växlas från poängtabellen).</div>
          </span>
        </label>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
          <input type="checkbox" id="publicControls" ${comp.publicControls !== false ? 'checked' : ''} style="margin-top:4px;">
          <span>
            <strong>Visa kontrollplatser på publika sidan</strong>
            <div class="field-hint" style="margin-top:2px;">Avbockad: publika kartan visar start/mål, parkering och ett skuggat "Tävlingsområde" — men inga kontroller eller spår. Bocka i på tävlingsdagen. Startkort och inloggade ser alltid allt.</div>
          </span>
        </label>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
          <input type="checkbox" id="autoCloseControls" ${comp.autoCloseControls ? 'checked' : ''} style="margin-top:4px;">
          <span>
            <strong>Stäng kontroller automatiskt</strong>
            <div class="field-hint" style="margin-top:2px;">När samtliga patruller rapporterat poäng på en kontroll stängs den automatiskt (syns som "Stängd" i listor). Gäller bara när en administratör är inne och tittar på kontrollen eller poängtabellen.</div>
          </span>
        </label>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
          <input type="checkbox" id="st-enabled" ${comp.startTimes?.enabled ? 'checked' : ''} style="margin-top:4px;">
          <span>
            <strong>Starttider</strong>
            <div class="field-hint" style="margin-top:2px;">Patrullernas starttid beräknas utifrån deras ordning i patrullistan. Dra och släpp i patrullvyn för att ändra.</div>
          </span>
        </label>
        ${(() => {
          const mode = comp.startTimes?.mode === 'range' ? 'range' : 'interval';
          return `
            <div id="st-fields" style="display:${comp.startTimes?.enabled ? 'block' : 'none'};margin-top:var(--sp-3);">
              <div class="row wrap" style="gap:var(--sp-4);">
                <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                  <input type="radio" name="st-mode" value="interval" ${mode === 'interval' ? 'checked' : ''}>
                  Starttid + intervall
                </label>
                <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                  <input type="radio" name="st-mode" value="range" ${mode === 'range' ? 'checked' : ''}>
                  Starttid + sluttid
                </label>
              </div>
              <div class="grid grid-2 mt-3">
                <div>
                  <label class="field" for="st-firstStart">Första start</label>
                  <input class="input" type="time" id="st-firstStart" value="${escapeHtml(comp.startTimes?.firstStart || '09:00')}">
                </div>
                <div id="st-interval-field" style="display:${mode === 'range' ? 'none' : 'block'};">
                  <label class="field" for="st-interval">Intervall (minuter)</label>
                  <input class="input" type="number" id="st-interval" min="1" value="${comp.startTimes?.intervalMinutes ?? 5}">
                </div>
                <div id="st-last-field" style="display:${mode === 'range' ? 'block' : 'none'};">
                  <label class="field" for="st-lastStart">Sista start</label>
                  <input class="input" type="time" id="st-lastStart" value="${escapeHtml(comp.startTimes?.lastStart || '12:00')}">
                </div>
              </div>
              <div class="field-hint mt-2" id="st-range-hint" style="display:${mode === 'range' ? 'block' : 'none'};">Intervallet räknas ut automatiskt från antalet patruller. Går tider över midnatt (t.ex. 22:00 → 02:00) hanteras det korrekt.</div>
            </div>
          `;
        })()}
      </div>

      <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
        <label class="field" for="generalInfo">Allmän information</label>
        <textarea class="textarea" id="generalInfo" placeholder="T.ex. akutrutiner, ansvarig vid olycka…" rows="4">${escapeHtml(comp.generalInfo || '')}</textarea>
        <div class="field-hint">Syns under instruktionerna på varje kontrolls rapporteringssida.</div>
      </div>
    </form>
    ${readOnly ? '' : saveRow('Spara regler')}
  `);
  host.appendChild(card);

  const stEnabled = card.querySelector('#st-enabled');
  const stFields = card.querySelector('#st-fields');
  stEnabled.addEventListener('change', () => { stFields.style.display = stEnabled.checked ? 'block' : 'none'; });
  const applyStMode = () => {
    const m = card.querySelector('input[name="st-mode"]:checked').value;
    card.querySelector('#st-interval-field').style.display = m === 'range' ? 'none' : 'block';
    card.querySelector('#st-last-field').style.display = m === 'range' ? 'block' : 'none';
    card.querySelector('#st-range-hint').style.display = m === 'range' ? 'block' : 'none';
  };
  card.querySelectorAll('input[name="st-mode"]').forEach(r => r.addEventListener('change', applyStMode));

  wireSave(card, async () => {
    await updateCompetition(cid, {
      anonymousControls: card.querySelector('#anonymousControls').checked,
      publicScores: card.querySelector('#publicScores').checked,
      publicControls: card.querySelector('#publicControls').checked,
      autoCloseControls: card.querySelector('#autoCloseControls').checked,
      startTimes: {
        enabled: card.querySelector('#st-enabled').checked,
        mode: card.querySelector('input[name="st-mode"]:checked').value,
        firstStart: card.querySelector('#st-firstStart').value || '09:00',
        intervalMinutes: Number(card.querySelector('#st-interval').value) || 5,
        lastStart: card.querySelector('#st-lastStart').value || null
      },
      generalInfo: card.querySelector('#generalInfo').value.trim()
    });
    await refresh();
  });

  return host;
}

function renderAnmalanTab(comp, cid, refresh, readOnly) {
  const host = document.createElement('div');
  host.className = 'field-group';
  const s = registrationSettings(comp);

  // Local working copy of payment methods — rendered/synced below.
  const methods = s.methods.map(m => ({ ...m }));

  const priceFieldBlocks = `
    <div data-price-block="patrull" class="mt-3" style="max-width:280px;">
      <label class="field" for="rp-perPatrol">Kostnad per patrull (kr)</label>
      <input class="input" id="rp-perPatrol" type="number" min="0" value="${s.pricing.perPatrol}">
    </div>
    <div data-price-block="scout" class="mt-3" style="max-width:280px;">
      <label class="field" for="rp-perScout">Kostnad per scout (kr)</label>
      <input class="input" id="rp-perScout" type="number" min="0" value="${s.pricing.perScout}">
    </div>
    <div data-price-block="kar" class="mt-3" style="max-width:280px;">
      <label class="field" for="rp-flat">Kostnad per kår (kr)</label>
      <input class="input" id="rp-flat" type="number" min="0" value="${s.pricing.flat}">
    </div>
    <div data-price-block="dynamisk" class="mt-3">
      <div class="grid grid-2" style="max-width:560px;">
        <div>
          <label class="field" for="rp-base">Fast grundkostnad (kr)</label>
          <input class="input" id="rp-base" type="number" min="0" value="${s.pricing.base}">
        </div>
        <div>
          <label class="field" for="rp-perUnit">Avgift per enhet (kr)</label>
          <input class="input" id="rp-perUnit" type="number" min="0" value="${s.pricing.perUnit}">
        </div>
      </div>
      <div class="row wrap mt-3" style="gap:var(--sp-4);">
        <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="radio" name="rp-unit" value="patrull" ${s.pricing.unit === 'patrull' ? 'checked' : ''}> Avgift per patrull
        </label>
        <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="radio" name="rp-unit" value="scout" ${s.pricing.unit === 'scout' ? 'checked' : ''}> Avgift per scout
        </label>
      </div>
    </div>
  `;

  const card = section('Anmälan', `
    <form class="field-group" ${readOnly ? 'inert' : ''}>
      <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
        <input type="checkbox" id="reg-enabled" ${s.enabled ? 'checked' : ''} style="margin-top:4px;">
        <span>
          <strong>Öppna för anmälan</strong>
          <div class="field-hint" style="margin-top:2px;">Kårer/patruller anmäler sig via den publika anmälningssidan. Länken hittar du längst ner.</div>
        </span>
      </label>

      <div id="reg-fields" style="display:${s.enabled ? 'block' : 'none'};" class="field-group">
        <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
          <label class="field">Anmälningssätt</label>
          <div class="row wrap" style="gap:var(--sp-4);">
            <label style="display:inline-flex;align-items:flex-start;gap:8px;cursor:pointer;max-width:280px;">
              <input type="radio" name="reg-mode" value="kar" ${s.mode === 'kar' ? 'checked' : ''} style="margin-top:3px;">
              <span><strong>Kårvis</strong><div class="field-hint">En anmälan per kår — samtliga patruller anmäls och betalas tillsammans.</div></span>
            </label>
            <label style="display:inline-flex;align-items:flex-start;gap:8px;cursor:pointer;max-width:280px;">
              <input type="radio" name="reg-mode" value="patrull" ${s.mode === 'patrull' ? 'checked' : ''} style="margin-top:3px;">
              <span><strong>Patrullvis</strong><div class="field-hint">Varje patrull ansvarar för sin egen anmälan och betalning.</div></span>
            </label>
          </div>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
          <label class="field">Anmälningsperiod</label>
          <div class="grid grid-2" style="max-width:460px;">
            <div>
              <label class="field" for="reg-opens">Öppnar</label>
              <input class="input" id="reg-opens" type="date" value="${s.opensAt || ''}">
            </div>
            <div>
              <label class="field" for="reg-closes">Stänger</label>
              <input class="input" id="reg-closes" type="date" value="${s.closesAt || ''}">
            </div>
          </div>
          <div class="field-hint">Under perioden kan anmälningar skapas och ändras. Efteråt kan anmälare bara titta på sin anmälan och anmäla förhinder.</div>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
          <label class="field">Prismodell</label>
          <div class="field-group" style="gap:var(--sp-2);">
            ${REG_PRICING_MODELS.map(m => `
              <label style="display:inline-flex;align-items:flex-start;gap:8px;cursor:pointer;">
                <input type="radio" name="rp-model" value="${m.key}" ${s.pricing.model === m.key ? 'checked' : ''} style="margin-top:3px;">
                <span><strong>${escapeHtml(m.label)}</strong><div class="field-hint">${escapeHtml(m.hint)}</div></span>
              </label>
            `).join('')}
          </div>
          ${priceFieldBlocks}
        </div>

        <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
          <label class="field">Betalningssätt</label>
          <div class="field-hint" style="margin-bottom:var(--sp-3);">Visas på betalningssidan. Swish genererar en QR-kod med belopp och betalningsreferens låsta.</div>
          <div id="method-list"></div>
          <button type="button" class="btn btn-secondary btn-sm" id="add-method">${icon('plus', { size: 14 })} Lägg till betalningssätt</button>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
          <label class="field">Egna fält i anmälan</label>
          <div class="field-hint" style="margin-bottom:var(--sp-3);">Fritextfrågor som anmälaren fyller i — t.ex. "Information till tävlingsledningen" (en per anmälan) eller "Allergier" (en per patrull).</div>
          <div id="field-list"></div>
          <button type="button" class="btn btn-secondary btn-sm" id="add-field">${icon('plus', { size: 14 })} Lägg till fält</button>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
          <label class="field" for="reg-info">Information på anmälningssidan</label>
          <textarea class="textarea" id="reg-info" rows="3" placeholder="Ex. Anmälan är bindande. Frågor? Kontakta…">${escapeHtml(s.info)}</textarea>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
          <label class="field">Publik anmälningslänk</label>
          <div class="row" style="gap:var(--sp-2);align-items:center;flex-wrap:wrap;">
            <code style="background:var(--bg-muted);padding:6px 10px;border-radius:var(--r-sm);font-size:13px;">${escapeHtml(registrationUrl(cid))}</code>
            <button type="button" class="btn btn-ghost btn-sm" id="copy-reg-link">${icon('copy', { size: 14 })} Kopiera</button>
            <a class="btn btn-ghost btn-sm" href="/a/${cid}" target="_blank" rel="noopener">${icon('external', { size: 14 })} Öppna</a>
          </div>
        </div>
      </div>
    </form>
    ${readOnly ? '' : saveRow('Spara anmälningsinställningar')}
  `);
  host.appendChild(card);

  // --- enable toggle ---------------------------------------------------------
  const enabledBox = card.querySelector('#reg-enabled');
  const fields = card.querySelector('#reg-fields');
  enabledBox.addEventListener('change', () => {
    fields.style.display = enabledBox.checked ? 'block' : 'none';
  });

  // --- pricing model visibility ---------------------------------------------
  const applyPriceVisibility = () => {
    const m = card.querySelector('input[name="rp-model"]:checked').value;
    card.querySelectorAll('[data-price-block]').forEach(b => {
      b.style.display = b.dataset.priceBlock === m ? 'block' : 'none';
    });
  };
  card.querySelectorAll('input[name="rp-model"]').forEach(r => r.addEventListener('change', applyPriceVisibility));
  applyPriceVisibility();

  // --- payment methods editor ------------------------------------------------
  const methodList = card.querySelector('#method-list');
  const renderMethods = () => {
    methodList.innerHTML = methods.length ? methods.map((m, i) => `
      <div class="card" data-midx="${i}" style="padding:var(--sp-4);background:var(--bg-muted);box-shadow:none;margin-bottom:var(--sp-3);">
        <div class="row wrap" style="gap:var(--sp-3);align-items:flex-end;">
          <div>
            <label class="field">Typ</label>
            <select class="select" data-mf="type" style="max-width:160px;">
              <option value="swish" ${m.type === 'swish' ? 'selected' : ''}>Swish</option>
              <option value="bankgiro" ${m.type === 'bankgiro' ? 'selected' : ''}>Bankgiro</option>
              <option value="faktura" ${m.type === 'faktura' ? 'selected' : ''}>Faktura</option>
            </select>
          </div>
          ${m.type !== 'faktura' ? `
            <div style="flex:1;min-width:180px;">
              <label class="field">${m.type === 'swish' ? 'Swish-nummer' : 'Bankgironummer'}</label>
              <input class="input" data-mf="number" value="${escapeHtml(m.number || '')}" placeholder="${m.type === 'swish' ? '123 456 78 90' : '123-4567'}">
            </div>
          ` : `
            <div style="flex:1;min-width:220px;">
              <label class="field">Fakturainstruktioner</label>
              <input class="input" data-mf="info" value="${escapeHtml(m.info || '')}" placeholder="Ex. Maila fakturaadress till kassor@kåren.se">
            </div>
          `}
          <div style="min-width:140px;">
            <label class="field">Etikett (valfri)</label>
            <input class="input" data-mf="label" value="${escapeHtml(m.label || '')}" placeholder="Ex. Swish till kassören">
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-mremove="${i}" style="color:var(--utm-pink);">${icon('trash', { size: 14 })}</button>
        </div>
      </div>
    `).join('') : '<p class="muted t-sm">Inga betalningssätt tillagda ännu.</p>';
  };
  const syncMethods = () => {
    methodList.querySelectorAll('[data-midx]').forEach(row => {
      const i = Number(row.dataset.midx);
      const field = f => row.querySelector(`[data-mf="${f}"]`);
      methods[i] = {
        type: field('type').value,
        label: field('label').value,
        number: field('number') ? field('number').value : (methods[i].number || ''),
        info: field('info') ? field('info').value : (methods[i].info || '')
      };
    });
  };
  methodList.addEventListener('input', syncMethods);
  methodList.addEventListener('change', (e) => {
    if (e.target.matches('[data-mf="type"]')) {
      syncMethods();
      const i = Number(e.target.closest('[data-midx]').dataset.midx);
      methods[i].type = e.target.value;
      renderMethods();
    }
  });
  methodList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mremove]');
    if (!btn) return;
    syncMethods();
    methods.splice(Number(btn.dataset.mremove), 1);
    renderMethods();
  });
  card.querySelector('#add-method').addEventListener('click', () => {
    syncMethods();
    methods.push({ type: 'swish', label: '', number: '', info: '' });
    renderMethods();
  });
  renderMethods();

  // --- custom fields editor --------------------------------------------------
  const customFields = s.fields.map(f => ({ ...f }));
  const fieldList = card.querySelector('#field-list');
  const renderFields = () => {
    fieldList.innerHTML = customFields.length ? customFields.map((f, i) => `
      <div class="card" data-fidx="${i}" style="padding:var(--sp-4);background:var(--bg-muted);box-shadow:none;margin-bottom:var(--sp-3);">
        <div class="row wrap" style="gap:var(--sp-3);align-items:flex-end;">
          <div style="flex:1;min-width:220px;">
            <label class="field">Fältets rubrik</label>
            <input class="input" data-ff="label" value="${escapeHtml(f.label || '')}" placeholder="Ex. Allergier">
          </div>
          <div>
            <label class="field">Frågan ställs</label>
            <select class="select" data-ff="scope" style="max-width:170px;">
              <option value="anmalan" ${f.scope !== 'patrull' ? 'selected' : ''}>Per anmälan</option>
              <option value="patrull" ${f.scope === 'patrull' ? 'selected' : ''}>Per patrull</option>
            </select>
          </div>
          <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;padding-bottom:8px;">
            <input type="checkbox" data-ff="required" ${f.required ? 'checked' : ''} style="margin:0;"> Obligatoriskt
          </label>
          <button type="button" class="btn btn-ghost btn-sm" data-fremove="${i}" style="color:var(--utm-pink);">${icon('trash', { size: 14 })}</button>
        </div>
      </div>
    `).join('') : '<p class="muted t-sm">Inga egna fält tillagda.</p>';
  };
  const syncFields = () => {
    fieldList.querySelectorAll('[data-fidx]').forEach(row => {
      const i = Number(row.dataset.fidx);
      customFields[i] = {
        id: customFields[i].id,
        label: row.querySelector('[data-ff="label"]').value,
        scope: row.querySelector('[data-ff="scope"]').value,
        required: row.querySelector('[data-ff="required"]').checked
      };
    });
  };
  fieldList.addEventListener('input', syncFields);
  fieldList.addEventListener('change', syncFields);
  fieldList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fremove]');
    if (!btn) return;
    syncFields();
    customFields.splice(Number(btn.dataset.fremove), 1);
    renderFields();
  });
  card.querySelector('#add-field').addEventListener('click', () => {
    syncFields();
    customFields.push({ id: crypto.randomUUID(), label: '', scope: 'anmalan', required: false });
    renderFields();
  });
  renderFields();

  card.querySelector('#copy-reg-link').addEventListener('click', () => {
    copyToClipboard(registrationUrl(cid));
    toast('Länk kopierad', 'success');
  });

  wireSave(card, async () => {
    syncMethods();
    const num = id => Number(card.querySelector(id).value) || 0;
    await updateCompetition(cid, {
      registration: {
        enabled: enabledBox.checked,
        mode: card.querySelector('input[name="reg-mode"]:checked').value,
        opensAt: card.querySelector('#reg-opens').value || null,
        closesAt: card.querySelector('#reg-closes').value || null,
        info: card.querySelector('#reg-info').value.trim(),
        pricing: {
          model: card.querySelector('input[name="rp-model"]:checked').value,
          perPatrol: num('#rp-perPatrol'),
          perScout: num('#rp-perScout'),
          flat: num('#rp-flat'),
          base: num('#rp-base'),
          unit: card.querySelector('input[name="rp-unit"]:checked').value,
          perUnit: num('#rp-perUnit')
        },
        methods: methods
          .filter(m => m.type === 'faktura' ? true : (m.number || '').trim())
          .map(m => ({
            type: m.type,
            label: (m.label || '').trim(),
            number: (m.number || '').trim(),
            info: (m.info || '').trim()
          })),
        fields: (syncFields(), customFields)
          .filter(f => (f.label || '').trim())
          .map(f => ({
            id: f.id,
            label: f.label.trim(),
            scope: f.scope === 'patrull' ? 'patrull' : 'anmalan',
            required: f.required === true
          }))
      }
    });
    await refresh();
  });

  return host;
}

function renderStartFinishTab(comp, cid, refresh, readOnly) {
  const host = document.createElement('div');
  const sf = comp.startFinish || {};
  const mode = sf.mode === 'separate' ? 'separate' : 'same';
  const start = sf.start || (Number.isFinite(sf.lat) ? { name: sf.name, lat: sf.lat, lng: sf.lng } : {});
  const finish = sf.finish || {};
  const parking = comp.parking || {};

  const card = section('Start- och målplats', `
    <form class="field-group" ${readOnly ? 'inert' : ''}>
      <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
        <input type="checkbox" id="sf-enabled" ${sf.enabled ? 'checked' : ''} style="margin-top:4px;">
        <span>
          <strong>Aktivera start- och målplats</strong>
          <div class="field-hint" style="margin-top:2px;">Visas som specialkort i kontrollistan och som markör på kartan. Normalt samma plats; annars två olika.</div>
        </span>
      </label>

      <div id="sf-fields" style="display:${sf.enabled ? 'block' : 'none'};">
        <div class="row wrap mt-4" style="gap:var(--sp-4);">
          <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="radio" name="sf-mode" value="same" ${mode === 'same' ? 'checked' : ''}>
            Samma plats (normalt)
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="radio" name="sf-mode" value="separate" ${mode === 'separate' ? 'checked' : ''}>
            Olika platser
          </label>
        </div>

        <div class="card mt-4" style="padding:var(--sp-4);background:var(--bg-muted);box-shadow:none;">
          <strong style="font-size:13px;display:block;margin-bottom:var(--sp-3);" id="sf-start-heading">${mode === 'separate' ? 'Start' : 'Start / Mål'}</strong>
          <label class="field" for="sf-start-name">Namn</label>
          <input class="input" id="sf-start-name" value="${escapeHtml(start.name || '')}" placeholder="Ex. Lindsdals scoutgård">
          <div class="field-hint mt-3">Klicka på kartan för att placera. Markören kan dras för att finjustera.</div>
          <div id="sf-start-map" style="height:280px;width:100%;border-radius:var(--r-md);border:1.5px solid var(--border-strong);background:var(--bg-muted);"></div>
          <div class="row mt-3" style="gap:var(--sp-3);align-items:center;flex-wrap:wrap;">
            <button type="button" class="btn btn-ghost btn-sm" id="sf-start-gps">${icon('locate', { size: 16 })} Använd min plats</button>
            <span class="muted t-sm" id="sf-start-coord">${Number.isFinite(start.lat) ? `${start.lat.toFixed(5)}, ${start.lng.toFixed(5)}` : 'Ingen position vald'}</span>
          </div>
          <input type="hidden" id="sf-start-lat" value="${start.lat ?? ''}">
          <input type="hidden" id="sf-start-lng" value="${start.lng ?? ''}">
          <label class="field mt-3" for="sf-start-note">Notering (visas på publika sidan)</label>
          <textarea class="textarea" id="sf-start-note" placeholder="T.ex. parkeringsinstruktioner, samlingstid, incheckning…">${escapeHtml(start.note || '')}</textarea>
        </div>

        <div class="card mt-3" id="sf-finish-block" style="padding:var(--sp-4);background:var(--bg-muted);box-shadow:none;display:${mode === 'separate' ? 'block' : 'none'};">
          <strong style="font-size:13px;display:block;margin-bottom:var(--sp-3);">Mål</strong>
          <label class="field" for="sf-finish-name">Namn</label>
          <input class="input" id="sf-finish-name" value="${escapeHtml(finish.name || '')}" placeholder="Ex. Målgång vid parkeringen">
          <div class="field-hint mt-3">Klicka på kartan för att placera mål.</div>
          <div id="sf-finish-map" style="height:280px;width:100%;border-radius:var(--r-md);border:1.5px solid var(--border-strong);background:var(--bg-muted);"></div>
          <div class="row mt-3" style="gap:var(--sp-3);align-items:center;flex-wrap:wrap;">
            <button type="button" class="btn btn-ghost btn-sm" id="sf-finish-gps">${icon('locate', { size: 16 })} Använd min plats</button>
            <span class="muted t-sm" id="sf-finish-coord">${Number.isFinite(finish.lat) ? `${finish.lat.toFixed(5)}, ${finish.lng.toFixed(5)}` : 'Ingen position vald'}</span>
          </div>
          <input type="hidden" id="sf-finish-lat" value="${finish.lat ?? ''}">
          <input type="hidden" id="sf-finish-lng" value="${finish.lng ?? ''}">
          <label class="field mt-3" for="sf-finish-note">Notering (visas på publika sidan)</label>
          <textarea class="textarea" id="sf-finish-note" placeholder="T.ex. målgångsinstruktioner, utcheckning…">${escapeHtml(finish.note || '')}</textarea>
        </div>
      </div>
    </form>
    ${readOnly ? '' : saveRow('Spara start/mål')}
  `);
  host.appendChild(card);

  // --- Parking card (separate save row) ------------------------------------
  const parkingCard = section('Parkering', `
    <form class="field-group" ${readOnly ? 'inert' : ''}>
      <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
        <input type="checkbox" id="pk-enabled" ${parking.enabled ? 'checked' : ''} style="margin-top:4px;">
        <span>
          <strong>Aktivera parkeringsplats</strong>
          <div class="field-hint" style="margin-top:2px;">Visas som en blå P-markör på kartan (separat från start/mål) och som specialkort i kontrollistan.</div>
        </span>
      </label>
      <div id="pk-fields" style="display:${parking.enabled ? 'block' : 'none'};" class="field-group">
        <div>
          <label class="field" for="pk-name">Namn</label>
          <input class="input" id="pk-name" value="${escapeHtml(parking.name || '')}" placeholder="Ex. Grusparkeringen vid scoutgården">
        </div>
        <div class="field-hint">Klicka på kartan för att placera parkeringen.</div>
        <div id="pk-map" style="height:280px;width:100%;border-radius:var(--r-md);border:1.5px solid var(--border-strong);background:var(--bg-muted);"></div>
        <div class="row mt-3" style="gap:var(--sp-3);align-items:center;flex-wrap:wrap;">
          <button type="button" class="btn btn-ghost btn-sm" id="pk-gps">${icon('locate', { size: 16 })} Använd min plats</button>
          <span class="muted t-sm" id="pk-coord">${Number.isFinite(parking.lat) ? `${parking.lat.toFixed(5)}, ${parking.lng.toFixed(5)}` : 'Ingen position vald'}</span>
        </div>
        <input type="hidden" id="pk-lat" value="${parking.lat ?? ''}">
        <input type="hidden" id="pk-lng" value="${parking.lng ?? ''}">
        <label class="field mt-3" for="pk-note">Notering (visas på publika sidan)</label>
        <textarea class="textarea" id="pk-note" placeholder="T.ex. 'Parkera högst upp, ej framför lokalen'">${escapeHtml(parking.note || '')}</textarea>
      </div>
    </form>
    ${readOnly ? '' : saveRow('Spara parkering')}
  `);
  host.appendChild(parkingCard);

  const sfEnabled = card.querySelector('#sf-enabled');
  const sfFields = card.querySelector('#sf-fields');
  const sfFinishBlock = card.querySelector('#sf-finish-block');
  const sfStartHeading = card.querySelector('#sf-start-heading');
  sfEnabled.addEventListener('change', () => {
    sfFields.style.display = sfEnabled.checked ? 'block' : 'none';
    if (sfEnabled.checked) {
      // Map mis-sizes when it was hidden at init; nudge on reveal.
      startPicker?.invalidateSize();
      finishPicker?.invalidateSize();
    }
  });
  const applyMode = () => {
    const m = card.querySelector('input[name="sf-mode"]:checked').value;
    sfFinishBlock.style.display = m === 'separate' ? 'block' : 'none';
    sfStartHeading.textContent = m === 'separate' ? 'Start' : 'Start / Mål';
    if (m === 'separate') finishPicker?.invalidateSize();
  };
  card.querySelectorAll('input[name="sf-mode"]').forEach(r => r.addEventListener('change', applyMode));

  // --- Map pickers (start + finish) ----------------------------------------
  let startPicker = null, finishPicker = null, parkingPicker = null;
  const updateCoord = (host, prefix, lat, lng) => {
    host.querySelector(`#${prefix}-lat`).value = String(lat);
    host.querySelector(`#${prefix}-lng`).value = String(lng);
    host.querySelector(`#${prefix}-coord`).textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    host.querySelector(`#${prefix}-coord`).classList.remove('muted');
  };
  (async () => {
    try {
      startPicker = await initMapPicker({
        container: card.querySelector('#sf-start-map'),
        lat: start.lat, lng: start.lng,
        onChange: ({ lat, lng }) => updateCoord(card, 'sf-start', lat, lng)
      });
      card.querySelector('#sf-start-gps').addEventListener('click', async () => {
        try { await startPicker.useGeolocation(); }
        catch (e) { toast('Kunde inte hämta plats: ' + e.message, 'error'); }
      });
      finishPicker = await initMapPicker({
        container: card.querySelector('#sf-finish-map'),
        lat: finish.lat, lng: finish.lng,
        onChange: ({ lat, lng }) => updateCoord(card, 'sf-finish', lat, lng)
      });
      card.querySelector('#sf-finish-gps').addEventListener('click', async () => {
        try { await finishPicker.useGeolocation(); }
        catch (e) { toast('Kunde inte hämta plats: ' + e.message, 'error'); }
      });
    } catch (e) {
      console.warn('Map picker failed:', e);
    }
  })();

  // --- Parking card wiring -------------------------------------------------
  const pkEnabled = parkingCard.querySelector('#pk-enabled');
  const pkFields = parkingCard.querySelector('#pk-fields');
  pkEnabled.addEventListener('change', () => {
    pkFields.style.display = pkEnabled.checked ? 'block' : 'none';
    if (pkEnabled.checked) parkingPicker?.invalidateSize();
  });
  (async () => {
    try {
      parkingPicker = await initMapPicker({
        container: parkingCard.querySelector('#pk-map'),
        lat: parking.lat, lng: parking.lng,
        onChange: ({ lat, lng }) => updateCoord(parkingCard, 'pk', lat, lng)
      });
      parkingCard.querySelector('#pk-gps').addEventListener('click', async () => {
        try { await parkingPicker.useGeolocation(); }
        catch (e) { toast('Kunde inte hämta plats: ' + e.message, 'error'); }
      });
    } catch (e) { console.warn('Parking picker failed:', e); }
  })();

  wireSave(parkingCard, async () => {
    const num = (sel) => parkingCard.querySelector(sel).value ? Number(parkingCard.querySelector(sel).value) : null;
    await updateCompetition(cid, {
      parking: {
        enabled: pkEnabled.checked,
        name: parkingCard.querySelector('#pk-name').value.trim(),
        lat: num('#pk-lat'),
        lng: num('#pk-lng'),
        note: parkingCard.querySelector('#pk-note').value.trim()
      }
    });
    await refresh();
  });

  wireSave(card, async () => {
    const m = card.querySelector('input[name="sf-mode"]:checked').value;
    const num = (sel) => card.querySelector(sel).value ? Number(card.querySelector(sel).value) : null;
    const data = {
      enabled: sfEnabled.checked,
      mode: m,
      start: {
        name: card.querySelector('#sf-start-name').value.trim(),
        lat: num('#sf-start-lat'),
        lng: num('#sf-start-lng'),
        note: card.querySelector('#sf-start-note').value.trim()
      }
    };
    if (m === 'separate') {
      data.finish = {
        name: card.querySelector('#sf-finish-name').value.trim(),
        lat: num('#sf-finish-lat'),
        lng: num('#sf-finish-lng'),
        note: card.querySelector('#sf-finish-note').value.trim()
      };
    }
    await updateCompetition(cid, { startFinish: data });
    await refresh();
  });

  return host;
}

function renderManagementTab(comp, cid, refresh, readOnly) {
  const host = document.createElement('div');
  const card = document.createElement('section');
  card.className = 'card';
  card.innerHTML = `
    <h3 class="t-h3" style="margin-top:0;">Tävlingsledning</h3>
    <p class="muted t-sm" style="margin-top:-6px;">Lägg till valfria roller. Välj för varje om den ska vara <strong>publik</strong> (syns på startkort och offentlig sida) eller <strong>intern</strong> (syns bara på kontrollernas rapportkort).</p>
  `;
  const form = document.createElement('form');
  if (readOnly) form.setAttribute('inert', '');
  card.appendChild(form);

  const mgmt = createManagementForm(comp, { seedDefaults: false });
  form.appendChild(mgmt.element);

  if (!readOnly) {
    const saveBlock = document.createElement('div');
    saveBlock.innerHTML = saveRow('Spara tävlingsledning');
    card.appendChild(saveBlock);
  }

  host.appendChild(card);

  wireSave(card, async () => {
    // Union — ticking "Bjud in som administratör" adds; removal happens
    // deliberately under Användare, never as a side effect here.
    const adminEmails = [...new Set([...(comp.adminEmails || []), ...mgmt.adminInvites()])];
    await updateCompetition(cid, { management: mgmt.read(), adminEmails });
    await refresh();
  });

  return host;
}

// ---- members / admins ------------------------------------------------------
function renderMembersTab(comp, cid, user, refresh) {
  const host = document.createElement('div');
  host.className = 'field-group';

  const card = document.createElement('section');
  card.className = 'card';
  card.innerHTML = `
    <h3 class="t-h3" style="margin-top:0;">Användare & administratörer</h3>
    <p class="muted t-sm" style="margin-top:-6px;">Ange e-postadress (och gärna namn) — personen behöver inte ha loggat in i ESKIL tidigare, rättigheterna gäller från första inloggningen. Kontrollansvariga utses på respektive kontroll.</p>
    <div id="member-body"><div class="muted">Laddar…</div></div>
  `;
  host.appendChild(card);

  const body = card.querySelector('#member-body');
  const myEmail = normEmail(user.email);
  // Legacy entries: users used to be uid arrays; treat string entries as uids.
  const userEntries = (comp.users || []).filter(u => u && typeof u === 'object');
  const legacyUserUids = (comp.users || []).filter(u => typeof u === 'string');

  (async () => {
    const [legacyAdminEmails, legacyUserEmails, controls] = await Promise.all([
      lookupEmailsForUids(comp.admins || []),
      lookupEmailsForUids(legacyUserUids),
      listControls(cid).catch(() => [])
    ]);

    // Kontrollansvariga överblick: email -> { name, controls: [nr] }
    const ansvariga = new Map();
    for (const c of [...controls].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0))) {
      for (const a of (c.ansvariga || [])) {
        const key = normEmail(a.email);
        if (!key) continue;
        if (!ansvariga.has(key)) ansvariga.set(key, { name: a.name || '', controls: [] });
        ansvariga.get(key).controls.push(c.nummer ?? '?');
        if (a.name && !ansvariga.get(key).name) ansvariga.get(key).name = a.name;
      }
    }

    body.innerHTML = `
      <div class="mt-4">
        <h4 class="t-over">Administratörer (${(comp.admins || []).length + (comp.adminEmails || []).length})</h4>
        <ul class="muted t-sm" style="padding-left:16px;margin:6px 0 10px;">
          ${legacyAdminEmails.map((e, i) => `<li>
            ${escapeHtml(e || comp.admins[i])}
            ${comp.admins[i] !== user.uid ? `<button class="btn btn-ghost btn-sm" style="color:var(--utm-pink);margin-left:8px;" data-remove-admin="${comp.admins[i]}">Ta bort</button>` : '<span class="muted">(du)</span>'}
          </li>`).join('')}
          ${(comp.adminEmails || []).map(e => `<li>
            ${escapeHtml(e)}
            ${normEmail(e) !== myEmail ? `<button class="btn btn-ghost btn-sm" style="color:var(--utm-pink);margin-left:8px;" data-remove-admin-email="${escapeHtml(e)}">Ta bort</button>` : '<span class="muted">(du)</span>'}
          </li>`).join('')}
          ${!(comp.admins || []).length && !(comp.adminEmails || []).length ? '<li>—</li>' : ''}
        </ul>
        <div class="row">
          <input class="input" type="email" placeholder="e-post@exempel.se" id="new-admin-email" style="max-width:320px;">
          <button class="btn btn-secondary btn-sm" id="add-admin">${icon('plus', { size: 14 })} Lägg till admin</button>
        </div>
      </div>

      <div class="mt-6">
        <h4 class="t-over">Användare — läsåtkomst (${userEntries.length + legacyUserUids.length})</h4>
        <ul class="muted t-sm" style="padding-left:16px;margin:6px 0 10px;">
          ${userEntries.map(u => `<li>
            ${u.name ? `<strong>${escapeHtml(u.name)}</strong> · ` : ''}${escapeHtml(u.email)}
            ${ansvariga.has(normEmail(u.email)) ? `<span class="badge badge-blue" style="margin-left:4px;">Kontrollansvarig</span>` : ''}
            <button class="btn btn-ghost btn-sm" style="color:var(--utm-pink);margin-left:8px;" data-remove-user="${escapeHtml(u.email)}">Ta bort</button>
          </li>`).join('')}
          ${legacyUserEmails.map((e, i) => `<li>
            ${escapeHtml(e || legacyUserUids[i])} <span class="muted">(äldre format)</span>
            <button class="btn btn-ghost btn-sm" style="color:var(--utm-pink);margin-left:8px;" data-remove-legacy-user="${legacyUserUids[i]}">Ta bort</button>
          </li>`).join('')}
          ${!userEntries.length && !legacyUserUids.length ? '<li>—</li>' : ''}
        </ul>
        <div class="row wrap">
          <input class="input" type="email" placeholder="e-post@exempel.se" id="new-user-email" style="max-width:280px;">
          <input class="input" placeholder="Namn (frivilligt)" id="new-user-name" style="max-width:220px;">
          <button class="btn btn-secondary btn-sm" id="add-user">${icon('plus', { size: 14 })} Lägg till användare</button>
        </div>
      </div>

      <div class="mt-6">
        <h4 class="t-over">Kontrollansvariga (${ansvariga.size})</h4>
        ${ansvariga.size ? `
          <ul class="muted t-sm" style="padding-left:16px;margin:6px 0 10px;">
            ${[...ansvariga.entries()].map(([email, a]) => `<li>
              ${a.name ? `<strong>${escapeHtml(a.name)}</strong> · ` : ''}${escapeHtml(email)}
              <span class="muted">— kontroll ${a.controls.join(', ')}</span>
            </li>`).join('')}
          </ul>
        ` : '<p class="muted t-sm" style="margin:6px 0 10px;">Inga kontrollansvariga utsedda.</p>'}
        <p class="field-hint">Kontrollansvariga kan redigera och öppna/stänga sin kontroll, och har läsåtkomst till resten av tävlingen. De utses på respektive kontrollsida och står automatiskt med som användare ovan.</p>
      </div>
    `;

    const adminBtn = body.querySelector('#add-admin');
    adminBtn.addEventListener('click', () => withBusy(adminBtn, 'Lägger till…', async () => {
      const email = normEmail(body.querySelector('#new-admin-email').value);
      if (!email) return;
      const existing = comp.adminEmails || [];
      if (existing.includes(email)) { toast('Är redan administratör'); return; }
      try {
        await updateCompetition(cid, { adminEmails: [...existing, email] });
        await refresh();
        toast('Administratör tillagd', 'success');
      } catch (e) { toast('Fel: ' + e.message, 'error'); }
    }));

    const userBtn = body.querySelector('#add-user');
    userBtn.addEventListener('click', () => withBusy(userBtn, 'Lägger till…', async () => {
      const email = normEmail(body.querySelector('#new-user-email').value);
      const name = body.querySelector('#new-user-name').value.trim();
      if (!email) return;
      if (userEntries.some(u => normEmail(u.email) === email)) { toast('Användaren är redan tillagd'); return; }
      try {
        await setCompetitionUsers(cid, [...userEntries, { email, name }]);
        await refresh();
        toast('Användare tillagd', 'success');
      } catch (e) { toast('Fel: ' + e.message, 'error'); }
    }));

    body.querySelectorAll('[data-remove-admin]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Ta bort denna administratör?'))) return;
      const uid = b.dataset.removeAdmin;
      const next = (comp.admins || []).filter(x => x !== uid);
      try { await updateCompetition(cid, { admins: next }); await refresh(); toast('Borttagen'); }
      catch (e) { toast(e.message, 'error'); }
    }));
    body.querySelectorAll('[data-remove-admin-email]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Ta bort denna administratör?'))) return;
      const email = normEmail(b.dataset.removeAdminEmail);
      const next = (comp.adminEmails || []).filter(x => normEmail(x) !== email);
      try { await updateCompetition(cid, { adminEmails: next }); await refresh(); toast('Borttagen'); }
      catch (e) { toast(e.message, 'error'); }
    }));
    body.querySelectorAll('[data-remove-user]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Ta bort denna användare?'))) return;
      const email = normEmail(b.dataset.removeUser);
      try {
        await setCompetitionUsers(cid, userEntries.filter(u => normEmail(u.email) !== email));
        await refresh(); toast('Borttagen');
      } catch (e) { toast(e.message, 'error'); }
    }));
    body.querySelectorAll('[data-remove-legacy-user]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Ta bort denna användare?'))) return;
      const uid = b.dataset.removeLegacyUser;
      try {
        await updateCompetition(cid, { users: (comp.users || []).filter(x => x !== uid) });
        await refresh(); toast('Borttagen');
      } catch (e) { toast(e.message, 'error'); }
    }));
  })();

  return host;
}

async function lookupEmailsForUids(uids) {
  const out = [];
  for (const uid of uids) {
    try {
      const s = await getDoc(doc(db, 'users', uid));
      out.push(s.exists() ? s.data().email : null);
    } catch { out.push(null); }
  }
  return out;
}
