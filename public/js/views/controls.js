import { layout, setTopbarCompetition } from '../app.js';
import {
  getCompetition, watchControls, createControl, updateControl, deleteControl,
  updateControlNumbers
} from '../store.js';
import {
  AVDELNINGAR, escapeHtml, toast, confirmDialog, withBusy, startFinishPoints, parkingPoint
} from '../utils.js';
import { navigate } from '../router.js';
import { initMapPicker } from '../mappicker.js';
import { icon } from '../icons.js';
import { compActionsHtml } from './competition.js';

// Lazy-load SortableJS (also used by patrols.js).
let sortableReady = null;
function ensureSortable() {
  if (sortableReady) return sortableReady;
  sortableReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js';
    s.onload = () => resolve(window.Sortable);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return sortableReady;
}
let sortableInstance = null;

let unsub = null;

export async function renderControls(app, user, cid) {
  if (unsub) { unsub(); unsub = null; }
  if (sortableInstance) { sortableInstance.destroy(); sortableInstance = null; }

  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="muted">Laddar…</div>`;
  layout(wrap);

  const comp = await getCompetition(cid).catch(() => null);
  if (!comp) { wrap.innerHTML = `<div class="empty"><h3>Tävlingen hittades inte</h3></div>`; return; }
  setTopbarCompetition(cid, comp, user);
  const isAdmin = user.role === 'super-admin' || (comp.admins || []).includes(user.uid);

  let state = { rows: [], sort: 'nummer', dir: 1 };

  wrap.innerHTML = `
    <div class="page-head">
      <div>
        <div class="t-over" style="color:var(--avent-orange);">${escapeHtml(comp.shortName || '')} · ${comp.year || ''}</div>
        <h1 class="t-d2">Kontroller</h1>
      </div>
      <div class="btn-row">
        ${compActionsHtml(cid, comp, user)}
        ${isAdmin ? '<button class="btn btn-primary" id="new">+ Ny kontroll</button>' : ''}
      </div>
    </div>

    <div class="tabs">
      <a href="/app/c/${cid}" data-link>Översikt</a>
      <a href="/app/c/${cid}/patrols" data-link>Patruller</a>
      <a href="/app/c/${cid}/controls" data-link class="active">Kontroller</a>
      <a href="/app/c/${cid}/scoreboard" data-link>Poängtabell</a>
    </div>

    <div id="tbl"></div>
  `;

  const render = () => {
    if (sortableInstance) { sortableInstance.destroy(); sortableInstance = null; }
    const rows = [...state.rows].sort((a, b) => {
      const A = a[state.sort] ?? '', B = b[state.sort] ?? '';
      if (typeof A === 'number' && typeof B === 'number') return state.dir * (A - B);
      return state.dir * String(A).localeCompare(String(B), 'sv');
    });

    // Drag enabled when: admin, sorted by nummer ascending (natural order).
    const dragEnabled = isAdmin && state.sort === 'nummer' && state.dir === 1;

    const sfPoints = startFinishPoints(comp);
    const sfStart = sfPoints.find(p => p.kind === 'start' || p.kind === 'startfinish');
    const sfFinish = sfPoints.find(p => p.kind === 'finish');
    const park = parkingPoint(comp);

    const tbl = wrap.querySelector('#tbl');
    const pseudoRowHtml = (label, p, colCount, pillStyle) => {
      const isPark = p.kind === 'parking';
      const pillContent = isPark ? icon('square-parking', { size: 14, stroke: 2.5 }) : escapeHtml(p.label);
      return `
      <tr class="sf-row ${isPark ? 'park-row' : ''}">
        <td colspan="${colCount}">
          <div style="display:flex;align-items:center;gap:var(--sp-3);">
            <span class="badge" style="${pillStyle}display:inline-flex;align-items:center;gap:6px;">${pillContent}</span>
            <strong>${escapeHtml(label)}</strong>
            ${p.name ? `<span class="muted t-sm">· ${escapeHtml(p.name)}</span>` : ''}
            ${Number.isFinite(p.lat) ? `<span class="muted t-sm mono">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</span>` : ''}
            <span class="spacer"></span>
            ${isAdmin ? '<span class="muted t-sm">Redigera via Tävlingsinställningar</span>' : ''}
          </div>
        </td>
      </tr>`;
    };
    const sfPill = 'background:#E2E000;color:#003660;font-weight:800;';
    const parkPill = 'background:#003660;color:#ffffff;font-weight:900;';

    if (!rows.length && !sfPoints.length && !park) {
      tbl.innerHTML = `<div class="empty">
        <h3>Inga kontroller</h3>
        <p>${isAdmin ? 'Skapa din första kontroll.' : 'Inga kontroller har skapats än.'}</p>
      </div>`;
      return;
    }

    const COL_COUNT = 7 + (dragEnabled ? 1 : 0);
    tbl.innerHTML = `
      <div class="table-wrap">
        <table class="t">
          <thead>
            <tr>
              ${dragEnabled ? '<th style="width:36px;"></th>' : ''}
              ${th('nummer', 'Nr', state, { num: true })}
              ${th('name', 'Namn', state)}
              ${th('maxPoang', 'Max', state, { num: true })}
              ${th('minPoang', 'Min', state, { num: true })}
              ${th('extraPoang', 'Extra', state, { num: true })}
              <th>Status</th>
              <th class="actions"></th>
            </tr>
          </thead>
          <tbody id="ctrl-body">
            ${park ? pseudoRowHtml('Parkering', park, COL_COUNT, parkPill) : ''}
            ${sfStart ? pseudoRowHtml(sfStart.kind === 'startfinish' ? 'Start / Mål' : 'Start', sfStart, COL_COUNT, sfPill) : ''}
            ${rows.map(r => `
              <tr data-id="${r.id}">
                ${dragEnabled ? `<td class="drag-col" aria-label="Dra för att ändra ordning">${icon('grip-vertical', { size: 18, class: 'drag-handle' })}</td>` : ''}
                <td class="num">${escapeHtml(String(r.nummer ?? ''))}</td>
                <td><a class="row-link" href="/app/c/${cid}/controls/${r.id}" data-link>${escapeHtml(r.name || '—')}</a></td>
                <td class="num">${r.maxPoang ?? ''}</td>
                <td class="num">${r.minPoang ?? ''}</td>
                <td class="num">${r.extraPoang ?? ''}</td>
                <td>${r.open ? '<span class="badge badge-green">Öppen</span>' : '<span class="badge badge-gray">Stängd</span>'}</td>
                <td class="actions">
                  <a class="btn btn-ghost btn-sm" href="/app/c/${cid}/controls/${r.id}" data-link>Öppna</a>
                </td>
              </tr>
            `).join('')}
            ${sfFinish ? pseudoRowHtml('Mål', sfFinish, COL_COUNT, sfPill) : ''}
          </tbody>
        </table>
      </div>
      ${dragEnabled && rows.length > 1 ? '<p class="muted t-sm mt-2">Dra kontroller för att ändra ordning. Numren räknas om 1…N efter släpp. QR-länkar påverkas inte.</p>' : ''}
      ${!dragEnabled && isAdmin ? '<p class="muted t-sm mt-2">Sortera på Nr stigande för att kunna dra och släppa.</p>' : ''}
    `;

    tbl.querySelectorAll('th.sortable').forEach(thEl => {
      thEl.addEventListener('click', () => {
        const key = thEl.dataset.key;
        if (state.sort === key) state.dir *= -1;
        else { state.sort = key; state.dir = 1; }
        render();
      });
    });

    if (dragEnabled) {
      const body = tbl.querySelector('#ctrl-body');
      ensureSortable().then(Sortable => {
        sortableInstance = new Sortable(body, {
          handle: '.drag-col',
          animation: 150,
          ghostClass: 'drag-ghost',
          chosenClass: 'drag-chosen',
          forceFallback: true,
          fallbackTolerance: 5,
          filter: '.sf-row',      // start/finish pseudo rows never move
          preventOnFilter: false,
          onEnd: async () => {
            const ids = [...body.querySelectorAll('tr[data-id]')].map(tr => tr.dataset.id);
            try {
              await updateControlNumbers(cid, ids);
              toast('Ordning sparad', 'success');
            } catch (e) {
              toast('Kunde inte spara: ' + e.message, 'error');
            }
          }
        });
      });
    }
  };

  if (isAdmin) {
    wrap.querySelector('#new').addEventListener('click', () => {
      openControlModal(cid, null, (id) => navigate(`/app/c/${cid}/controls/${id}`));
    });
  }

  unsub = watchControls(cid, rows => { state.rows = rows; render(); });
}

function th(key, label, state, opts = {}) {
  const arrow = state.sort === key ? (state.dir > 0 ? '▲' : '▼') : '';
  const cls = 'sortable' + (opts.num ? ' num' : '');
  return `<th class="${cls}" data-key="${key}">${escapeHtml(label)} <span class="arrow">${arrow}</span></th>`;
}

export function openControlModal(cid, control, onSaved) {
  const isEdit = !!control;
  // Normalize legacy single-field instructions into the group format.
  let groups = Array.isArray(control?.instructions) && control.instructions.length
    ? control.instructions.map(g => ({ avdelningar: g.avdelningar || [], text: g.text || '' }))
    : [{ avdelningar: [], text: control?.information || '' }];

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:720px;">
      <div class="modal-head"><h3>${isEdit ? 'Redigera kontroll' : 'Ny kontroll'}</h3><button class="icon-btn" id="x" aria-label="Stäng">${icon('x')}</button></div>
      <div class="modal-body">
        <form id="f" class="field-group">
          <div class="grid grid-2">
            <div>
              <label class="field" for="nummer">Nummer</label>
              <input class="input" id="nummer" type="number" required value="${escapeHtml(String(control?.nummer ?? ''))}">
            </div>
            <div>
              <label class="field" for="name">Namn</label>
              <input class="input" id="name" required value="${escapeHtml(control?.name || '')}" placeholder="Ex. Spårkoll">
            </div>
          </div>

          <div class="grid grid-2">
            <div>
              <label class="field" for="maxPoang">Max poäng</label>
              <input class="input" id="maxPoang" type="number" value="${control?.maxPoang ?? 10}">
            </div>
            <div>
              <label class="field" for="minPoang">Min poäng</label>
              <input class="input" id="minPoang" type="number" value="${control?.minPoang ?? 0}">
            </div>
          </div>
          <div>
            <label class="field" for="extraPoang">Extra poäng (t.ex. ordningspoäng, max)</label>
            <input class="input" id="extraPoang" type="number" value="${control?.extraPoang ?? 0}">
            <div class="field-hint">0 om extra poäng inte används på denna kontroll.</div>
          </div>

          <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
            <div class="t-over" style="color:var(--scout-blue);margin-bottom:var(--sp-3);">Placering</div>
            <div class="field-hint" style="margin-bottom:var(--sp-3);">Klicka på kartan för att placera kontrollen. Markören kan dras för att finjustera.</div>
            <div id="picker-map" style="height:300px;width:100%;border-radius:var(--r-md);border:1.5px solid var(--border-strong);background:var(--bg-muted);"></div>
            <div class="row mt-3" style="gap:var(--sp-3);align-items:center;flex-wrap:wrap;">
              <button type="button" class="btn btn-ghost btn-sm" id="use-gps">${icon('locate', { size: 16 })} Använd min plats</button>
              <span class="muted t-sm" id="coord-display">${control?.lat && control?.lng ? `${control.lat.toFixed(5)}, ${control.lng.toFixed(5)}` : 'Ingen position vald'}</span>
            </div>
            <input type="hidden" id="lat" value="${control?.lat ?? ''}">
            <input type="hidden" id="lng" value="${control?.lng ?? ''}">
            <div class="mt-4">
              <label class="field" for="placement">Placeringsbeskrivning (visas på PDF-sida 1)</label>
              <input class="input" id="placement" value="${escapeHtml(control?.placement || '')}" placeholder="Ex. Strax innan korsningen, på den stora stenen på höger sida">
              <div class="field-hint">Fri text för den som ställer upp kontrollen. Visas under kartan i utskriften.</div>
            </div>
          </div>

          <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
            <div class="row" style="justify-content:space-between;margin-bottom:var(--sp-3);">
              <div class="t-over" style="color:var(--scout-blue);">Instruktioner per avdelning</div>
              <button type="button" class="btn btn-ghost btn-sm" id="add-group">+ Lägg till grupp</button>
            </div>
            <div class="field-hint" style="margin-bottom:var(--sp-3);">Första gruppen utan avdelningar är default och gäller för alla som inte har en egen grupp.</div>
            <div id="groups"></div>
          </div>

          <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
            <label class="field" for="notering">Intern notering (visas inte på kontrollsidan)</label>
            <textarea class="textarea" id="notering">${escapeHtml(control?.notering || '')}</textarea>
          </div>

          <div class="row">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="open" ${control?.open ? 'checked' : ''}>
              <span>Öppen för rapportering</span>
            </label>
          </div>
        </form>
      </div>
      <div class="modal-foot">
        ${isEdit ? '<button class="btn btn-danger" id="del">Ta bort</button><div class="spacer"></div>' : ''}
        <button class="btn btn-ghost" id="cancel">Avbryt</button>
        <button class="btn btn-primary" id="save">${isEdit ? 'Spara' : 'Skapa kontroll'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#x').onclick = close;
  overlay.querySelector('#cancel').onclick = close;

  const groupsHost = overlay.querySelector('#groups');
  const renderGroups = () => {
    groupsHost.innerHTML = groups.map((g, i) => `
      <div class="card" style="padding:var(--sp-4);margin-bottom:var(--sp-3);background:var(--bg-muted);box-shadow:none;" data-idx="${i}">
        <div class="row" style="justify-content:space-between;margin-bottom:var(--sp-3);">
          <strong style="font-size:13px;display:inline-flex;align-items:center;gap:6px;">${i === 0 && (!g.avdelningar || !g.avdelningar.length) ? `${icon('list', { size: 14 })} Default (används om ingen egen grupp matchar)` : `${icon('users', { size: 14 })} Grupp för valda avdelningar`}</strong>
          ${groups.length > 1 ? `<button type="button" class="btn btn-ghost btn-sm" data-rm="${i}" style="color:var(--utm-pink);">Ta bort grupp</button>` : ''}
        </div>
        <div class="row wrap" style="gap:6px;margin-bottom:var(--sp-3);">
          ${AVDELNINGAR.map(a => {
            const checked = (g.avdelningar || []).includes(a.key);
            return `<label style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1.5px solid ${checked ? 'var(--scout-blue)' : 'var(--border)'};border-radius:999px;background:${checked ? 'var(--scout-blue-100)' : 'var(--white)'};cursor:pointer;font-size:13px;font-weight:600;">
              <input type="checkbox" data-avd="${i}:${a.key}" ${checked ? 'checked' : ''} style="margin:0;">
              <span class="dot ${a.short}" style="margin:0;"></span>${a.key}
            </label>`;
          }).join('')}
        </div>
        <textarea class="textarea" rows="4" data-text="${i}" placeholder="Instruktioner för ${(g.avdelningar || []).length ? 'denna grupp' : 'alla avdelningar'}…">${escapeHtml(g.text || '')}</textarea>
      </div>
    `).join('');

    groupsHost.querySelectorAll('[data-avd]').forEach(cb => {
      cb.addEventListener('change', e => {
        const [i, key] = e.target.dataset.avd.split(':');
        const g = groups[+i];
        g.avdelningar = g.avdelningar || [];
        if (e.target.checked) g.avdelningar.push(key);
        else g.avdelningar = g.avdelningar.filter(x => x !== key);
        renderGroups();
      });
    });
    groupsHost.querySelectorAll('[data-text]').forEach(ta => {
      ta.addEventListener('input', e => {
        groups[+e.target.dataset.text].text = e.target.value;
      });
    });
    groupsHost.querySelectorAll('[data-rm]').forEach(b => {
      b.addEventListener('click', () => {
        groups.splice(+b.dataset.rm, 1);
        if (!groups.length) groups = [{ avdelningar: [], text: '' }];
        renderGroups();
      });
    });
  };
  renderGroups();

  overlay.querySelector('#add-group').addEventListener('click', () => {
    groups.push({ avdelningar: [], text: '' });
    renderGroups();
  });

  // --- Map picker for placement ------------------------------------------
  const latInput = overlay.querySelector('#lat');
  const lngInput = overlay.querySelector('#lng');
  const coordDisplay = overlay.querySelector('#coord-display');
  const mapEl = overlay.querySelector('#picker-map');

  let currentPos = (control?.lat && control?.lng) ? [control.lat, control.lng] : null;

  const updateCoords = (lat, lng) => {
    currentPos = [lat, lng];
    latInput.value = String(lat);
    lngInput.value = String(lng);
    coordDisplay.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    coordDisplay.classList.remove('muted');
  };

  (async () => {
    try {
      const picker = await initMapPicker({
        container: mapEl,
        lat: currentPos?.[0],
        lng: currentPos?.[1],
        onChange: ({ lat, lng }) => updateCoords(lat, lng)
      });
      overlay.querySelector('#use-gps').addEventListener('click', async () => {
        try { await picker.useGeolocation(); }
        catch (err) { toast('Kunde inte hämta plats: ' + err.message, 'error'); }
      });
    } catch (e) {
      console.error(e);
      mapEl.innerHTML = `<div class="empty" style="border:none;background:transparent;">Kartan kunde inte laddas.</div>`;
    }
  })();

  if (isEdit) {
    const delBtn = overlay.querySelector('#del');
    delBtn.addEventListener('click', async () => {
      if (!(await confirmDialog(`Ta bort kontroll "${control.name}"? Alla rapporterade poäng försvinner också.`))) return;
      await withBusy(delBtn, 'Tar bort…', async () => {
        try { await deleteControl(cid, control.id); close(); toast('Borttagen'); onSaved?.(null); }
        catch (e) { toast(e.message, 'error'); }
      });
    });
  }

  const saveBtn = overlay.querySelector('#save');
  saveBtn.addEventListener('click', async () => {
    const f = overlay.querySelector('#f');
    if (!f.reportValidity()) return;
    await withBusy(saveBtn, 'Sparar…', async () => {
      // Drop blank groups with no avdelningar and no text
      const cleanGroups = groups
        .map(g => ({ avdelningar: g.avdelningar || [], text: (g.text || '').trim() }))
        .filter(g => g.text || g.avdelningar.length);
      const data = {
        nummer: Number(overlay.querySelector('#nummer').value),
        name: overlay.querySelector('#name').value.trim(),
        maxPoang: Number(overlay.querySelector('#maxPoang').value) || 0,
        minPoang: Number(overlay.querySelector('#minPoang').value) || 0,
        extraPoang: Number(overlay.querySelector('#extraPoang').value) || 0,
        lat: overlay.querySelector('#lat').value ? Number(overlay.querySelector('#lat').value) : null,
        lng: overlay.querySelector('#lng').value ? Number(overlay.querySelector('#lng').value) : null,
        placement: overlay.querySelector('#placement').value.trim(),
        instructions: cleanGroups,
        notering: overlay.querySelector('#notering').value.trim(),
        open: overlay.querySelector('#open').checked
      };
      try {
        let id;
        if (isEdit) { await updateControl(cid, control.id, data); id = control.id; }
        else { id = await createControl(cid, data); }
        close();
        toast('Sparat', 'success');
        onSaved?.(id);
      } catch (e) {
        toast('Fel: ' + e.message, 'error');
      }
    });
  });
}
