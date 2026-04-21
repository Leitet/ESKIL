// Full-page competition settings — replaces the old "Redigera tävling" modal
// and absorbs the per-competition bits of the old settings view.
//
// Tabs: Grund · Regler & info · Start/Mål · Tävlingsledning · Användare
//
// Each tab has its own form and Save button so the user can focus on one
// concern at a time without scrolling through a giant modal.

import { layout, setTopbarCompetition } from '../app.js';
import {
  getCompetition, updateCompetition, deleteCompetition
} from '../store.js';
import {
  db, doc, getDoc, getDocs, collection, query, where
} from '../firebase.js';
import {
  escapeHtml, toast, withBusy, confirmDialog
} from '../utils.js';
import { createManagementForm } from '../managementform.js';
import { icon } from '../icons.js';
import { navigate } from '../router.js';
import { initMapPicker } from '../mappicker.js';

const TABS = [
  { key: 'basic',      label: 'Grund'           },
  { key: 'rules',      label: 'Regler & info'   },
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
  const isAdmin = isSuperAdmin || (comp.admins || []).includes(user.uid);
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
    </form>
    ${readOnly ? '<p class="muted t-sm">Skrivskyddad demotävling — bara superadministratör kan ändra.</p>' : saveRow('Spara grunduppgifter')}
  `);
  host.appendChild(card);

  wireSave(card, async () => {
    await updateCompetition(cid, {
      name: card.querySelector('#name').value.trim(),
      shortName: card.querySelector('#shortName').value.trim(),
      year: Number(card.querySelector('#year').value),
      date: card.querySelector('#date').value || null,
      location: card.querySelector('#location').value.trim(),
      organizer: card.querySelector('#organizer').value.trim(),
      description: card.querySelector('#description').value.trim()
    });
    await refresh();
  });

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
        lng: num('#pk-lng')
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
        lng: num('#sf-start-lng')
      }
    };
    if (m === 'separate') {
      data.finish = {
        name: card.querySelector('#sf-finish-name').value.trim(),
        lat: num('#sf-finish-lat'),
        lng: num('#sf-finish-lng')
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
    await updateCompetition(cid, { management: mgmt.read() });
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
    <p class="muted t-sm" style="margin-top:-6px;">Bjud in en användare genom att skriva in deras e-postadress. De måste ha loggat in i ESKIL en gång först.</p>
    <div id="member-body"><div class="muted">Laddar…</div></div>
  `;
  host.appendChild(card);

  const body = card.querySelector('#member-body');

  (async () => {
    const [adminEmails, userEmails] = await Promise.all([
      lookupEmailsForUids(comp.admins || []),
      lookupEmailsForUids(comp.users || [])
    ]);

    body.innerHTML = `
      <div class="mt-4">
        <h4 class="t-over">Administratörer (${(comp.admins || []).length})</h4>
        <ul class="muted t-sm" style="padding-left:16px;margin:6px 0 10px;">
          ${adminEmails.map((e, i) => `<li>
            ${escapeHtml(e || comp.admins[i])}
            ${comp.admins[i] !== user.uid ? `<button class="btn btn-ghost btn-sm" style="color:var(--utm-pink);margin-left:8px;" data-remove-admin="${comp.admins[i]}">Ta bort</button>` : '<span class="muted">(du)</span>'}
          </li>`).join('') || '<li>—</li>'}
        </ul>
        <div class="row">
          <input class="input" placeholder="e-post@exempel.se" id="new-admin-email" style="max-width:320px;">
          <button class="btn btn-secondary btn-sm" id="add-admin">${icon('plus', { size: 14 })} Lägg till admin</button>
        </div>
      </div>

      <div class="mt-6">
        <h4 class="t-over">Övriga användare (läsåtkomst) (${(comp.users || []).length})</h4>
        <ul class="muted t-sm" style="padding-left:16px;margin:6px 0 10px;">
          ${userEmails.map((e, i) => `<li>
            ${escapeHtml(e || comp.users[i])}
            <button class="btn btn-ghost btn-sm" style="color:var(--utm-pink);margin-left:8px;" data-remove-user="${comp.users[i]}">Ta bort</button>
          </li>`).join('') || '<li>—</li>'}
        </ul>
        <div class="row">
          <input class="input" placeholder="e-post@exempel.se" id="new-user-email" style="max-width:320px;">
          <button class="btn btn-secondary btn-sm" id="add-user">${icon('plus', { size: 14 })} Lägg till användare</button>
        </div>
      </div>
    `;

    const addByEmail = async (key, email, btn) => {
      const uid = await findUidByEmail(email);
      if (!uid) {
        toast('Den e-postadressen har inte loggat in i ESKIL än.', 'error');
        return;
      }
      const existing = comp[key] || [];
      if (existing.includes(uid)) { toast('Användaren är redan tillagd'); return; }
      await updateCompetition(cid, { [key]: [...existing, uid] });
      await refresh();
      toast('Tillagd', 'success');
    };

    const adminBtn = body.querySelector('#add-admin');
    adminBtn.addEventListener('click', () => withBusy(adminBtn, 'Lägger till…', async () => {
      const email = body.querySelector('#new-admin-email').value.trim().toLowerCase();
      if (email) await addByEmail('admins', email, adminBtn);
    }));
    const userBtn = body.querySelector('#add-user');
    userBtn.addEventListener('click', () => withBusy(userBtn, 'Lägger till…', async () => {
      const email = body.querySelector('#new-user-email').value.trim().toLowerCase();
      if (email) await addByEmail('users', email, userBtn);
    }));

    body.querySelectorAll('[data-remove-admin]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Ta bort denna administratör?'))) return;
      const uid = b.dataset.removeAdmin;
      const next = (comp.admins || []).filter(x => x !== uid);
      try { await updateCompetition(cid, { admins: next }); await refresh(); toast('Borttagen'); }
      catch (e) { toast(e.message, 'error'); }
    }));
    body.querySelectorAll('[data-remove-user]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Ta bort denna användare?'))) return;
      const uid = b.dataset.removeUser;
      const next = (comp.users || []).filter(x => x !== uid);
      try { await updateCompetition(cid, { users: next }); await refresh(); toast('Borttagen'); }
      catch (e) { toast(e.message, 'error'); }
    }));
  })();

  return host;
}

async function findUidByEmail(email) {
  try {
    const snap = await getDocs(query(collection(db, 'users'), where('email', '==', email)));
    if (snap.empty) return null;
    return snap.docs[0].id;
  } catch { return null; }
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
