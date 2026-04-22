import { layout, setTopbarCompetition } from '../app.js';
import {
  getCompetition, watchPatrols, createPatrol, updatePatrol, deletePatrol,
  updatePatrolOrders
} from '../store.js';
import {
  AVDELNINGAR, escapeHtml, toast, confirmDialog, withBusy, startUrl,
  copyToClipboard, patrolStartTime, startTimeSettings, effectiveIntervalSec
} from '../utils.js';
import { renderQrToImg, downloadStartPdf } from '../pdf.js';
import { icon } from '../icons.js';
import { compActionsHtml } from './competition.js';

let unsub = null;
let sortableInstance = null;

// Lazy-load SortableJS on first use (touch + desktop drag-reorder).
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

export async function renderPatrols(app, user, cid) {
  if (unsub) { unsub(); unsub = null; }
  if (sortableInstance) { sortableInstance.destroy(); sortableInstance = null; }

  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="muted">Laddar…</div>`;
  layout(wrap);

  const comp = await getCompetition(cid).catch(() => null);
  if (!comp) { wrap.innerHTML = `<div class="empty"><h3>Tävlingen hittades inte</h3></div>`; return; }
  setTopbarCompetition(cid, comp, user);
  const isAdmin = user.role === 'super-admin' || (comp.admins || []).includes(user.uid);
  const st = startTimeSettings(comp);

  let state = {
    rows: [],
    filter: 'alla',
    sort: st.enabled ? 'startOrder' : 'number',
    dir: 1,
    q: ''
  };

  wrap.innerHTML = `
    <div class="page-head">
      <div>
        <div class="t-over" style="color:var(--avent-orange);">${escapeHtml(comp.shortName || '')} · ${comp.year || ''}</div>
        <h1 class="t-d2">Patruller</h1>
        ${st.enabled ? `<p class="muted" id="st-header">Starttid från ${escapeHtml(st.firstStart)} · ${st.intervalMinutes} min intervall</p>` : ''}
      </div>
      <div class="btn-row">
        ${compActionsHtml(cid, comp, user)}
        ${isAdmin ? '<button class="btn btn-primary" id="new">+ Ny patrull</button>' : ''}
      </div>
    </div>

    <div class="tabs">
      <a href="/app/c/${cid}" data-link>Översikt</a>
      <a href="/app/c/${cid}/patrols" data-link class="active">Patruller</a>
      <a href="/app/c/${cid}/controls" data-link>Kontroller</a>
      <a href="/app/c/${cid}/scoreboard" data-link>Poängtabell</a>
    </div>

    <div class="scoreboard-controls">
      <input class="input" id="q" placeholder="Sök namn, kår, nummer…" style="max-width:260px;">
      <select class="select" id="avd" style="max-width:200px;">
        <option value="alla">Alla avdelningar</option>
        ${AVDELNINGAR.map(a => `<option value="${a.key}">${a.key}</option>`).join('')}
      </select>
      ${st.enabled && isAdmin ? `<span class="muted t-sm" id="drag-hint">Dra patruller för att ändra starttid</span>` : ''}
    </div>

    <div id="tbl"></div>
  `;

  const render = () => {
    if (sortableInstance) { sortableInstance.destroy(); sortableInstance = null; }
    let rows = [...state.rows];
    const isFiltering = state.q.trim() !== '' || state.filter !== 'alla';
    if (state.filter !== 'alla') rows = rows.filter(r => r.avdelning === state.filter);
    if (state.q) {
      const q = state.q.toLowerCase();
      rows = rows.filter(r =>
        String(r.number || '').toLowerCase().includes(q) ||
        (r.name || '').toLowerCase().includes(q) ||
        (r.kar || '').toLowerCase().includes(q)
      );
    }
    rows.sort((a, b) => {
      const key = state.sort;
      const A = a[key] ?? (key === 'startOrder' ? Number.MAX_SAFE_INTEGER : '');
      const B = b[key] ?? (key === 'startOrder' ? Number.MAX_SAFE_INTEGER : '');
      if (typeof A === 'number' && typeof B === 'number') return state.dir * (A - B);
      return state.dir * String(A).localeCompare(String(B), 'sv');
    });

    // Drag only enabled when: admin + startTimes on + not filtered/searched + default sort.
    const dragEnabled = isAdmin && st.enabled
      && !isFiltering
      && state.sort === 'startOrder' && state.dir === 1;

    const tbl = wrap.querySelector('#tbl');
    if (!rows.length) {
      tbl.innerHTML = `<div class="empty">
        <h3>Inga patruller</h3>
        <p>${isAdmin ? 'Klicka "Ny patrull" för att lägga till.' : 'Inga patruller har lagts till än.'}</p>
      </div>`;
      return;
    }
    tbl.innerHTML = `
      <div class="table-wrap">
        <table class="t">
          <thead>
            <tr>
              ${dragEnabled ? '<th style="width:36px;"></th>' : ''}
              ${st.enabled ? th('startOrder', 'Start', state, { num: true }) : ''}
              ${th('number', 'Nr', state, { num: true })}
              ${th('name', 'Namn', state)}
              ${th('avdelning', 'Avdelning', state)}
              ${th('kar', 'Kår', state)}
              ${th('antal', 'Antal', state, { num: true })}
              <th>Notering</th>
              ${isAdmin ? '<th class="actions"></th>' : ''}
            </tr>
          </thead>
          <tbody id="patrol-body">
            ${rows.map(r => {
              const t = patrolStartTime(comp, r, state.rows.length);
              return `<tr data-id="${r.id}">
                ${dragEnabled ? `<td class="drag-col" aria-label="Dra för att ändra ordning">${icon('grip-vertical', { size: 18, class: 'drag-handle' })}</td>` : ''}
                ${st.enabled ? `<td class="num time-col">${t ?? '<span class="muted">—</span>'}</td>` : ''}
                <td class="num">${escapeHtml(String(r.number ?? ''))}</td>
                <td><strong>${escapeHtml(r.name || '—')}</strong></td>
                <td><span class="dot ${shortOf(r.avdelning)}"></span>${escapeHtml(r.avdelning || '')}</td>
                <td>${escapeHtml(r.kar || '')}</td>
                <td class="num">${escapeHtml(String(r.antal ?? ''))}</td>
                <td class="muted">${escapeHtml((r.notering || '').slice(0, 60))}</td>
                ${isAdmin ? `<td class="actions">
                  <button class="btn btn-secondary btn-sm" data-start="${r.id}">Startkort</button>
                  <button class="btn btn-ghost btn-sm" data-edit="${r.id}">Redigera</button>
                  <button class="btn btn-ghost btn-sm" data-del="${r.id}" style="color:var(--utm-pink);">Ta bort</button>
                </td>` : ''}
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      ${st.enabled && isFiltering && isAdmin ? `<p class="muted t-sm mt-2">Rensa filter/sök för att kunna dra och släppa.</p>` : ''}
    `;

    // Sort header clicks
    tbl.querySelectorAll('th.sortable').forEach(thEl => {
      thEl.addEventListener('click', () => {
        const key = thEl.dataset.key;
        if (state.sort === key) state.dir *= -1;
        else { state.sort = key; state.dir = 1; }
        render();
      });
    });
    if (isAdmin) {
      tbl.querySelectorAll('[data-edit]').forEach(b => {
        b.addEventListener('click', () => {
          const row = state.rows.find(r => r.id === b.dataset.edit);
          openPatrolModal(cid, row);
        });
      });
      tbl.querySelectorAll('[data-start]').forEach(b => {
        b.addEventListener('click', () => {
          const row = state.rows.find(r => r.id === b.dataset.start);
          openStartCardModal(cid, row);
        });
      });
      tbl.querySelectorAll('[data-del]').forEach(b => {
        b.addEventListener('click', async () => {
          const row = state.rows.find(r => r.id === b.dataset.del);
          if (await confirmDialog(`Ta bort patrull "${row?.name || ''}"?`)) {
            try { await deletePatrol(cid, row.id); toast('Borttagen'); }
            catch (e) { toast(e.message, 'error'); }
          }
        });
      });
    }

    if (dragEnabled) {
      const body = tbl.querySelector('#patrol-body');
      ensureSortable().then(Sortable => {
        sortableInstance = new Sortable(body, {
          handle: '.drag-col',
          animation: 150,
          ghostClass: 'drag-ghost',
          chosenClass: 'drag-chosen',
          forceFallback: true,      // nicer cross-browser feedback; also fixes touch
          fallbackTolerance: 5,
          onEnd: async () => {
            const ids = [...body.querySelectorAll('tr[data-id]')].map(tr => tr.dataset.id);
            try {
              await updatePatrolOrders(cid, ids);
              toast('Startordning sparad', 'success');
            } catch (e) {
              toast('Kunde inte spara: ' + e.message, 'error');
            }
          }
        });
      });
    }
  };

  wrap.querySelector('#q').addEventListener('input', e => { state.q = e.target.value; render(); });
  wrap.querySelector('#avd').addEventListener('change', e => { state.filter = e.target.value; render(); });
  if (isAdmin) {
    wrap.querySelector('#new').addEventListener('click', () => openPatrolModal(cid, null, state.rows.length));
  }

  unsub = watchPatrols(cid, rows => {
    state.rows = rows;
    // Refresh the header line so the computed interval text stays in sync
    // as patruller are added/removed in range mode.
    const header = wrap.querySelector('#st-header');
    if (header && st.enabled) {
      if (st.mode === 'range' && st.lastStart && rows.length >= 2) {
        const sec = effectiveIntervalSec(comp, rows.length);
        const mins = (sec / 60).toFixed(sec % 60 ? 1 : 0);
        header.innerHTML = `Starttider ${escapeHtml(st.firstStart)} → ${escapeHtml(st.lastStart)} · ≈ ${mins} min mellan starter`;
      } else {
        header.innerHTML = `Starttid från ${escapeHtml(st.firstStart)} · ${st.intervalMinutes} min intervall`;
      }
    }
    render();
  });
}

function th(key, label, state, opts = {}) {
  const arrow = state.sort === key ? (state.dir > 0 ? '▲' : '▼') : '';
  const cls = 'sortable' + (opts.num ? ' num' : '');
  return `<th class="${cls}" data-key="${key}">${escapeHtml(label)} <span class="arrow">${arrow}</span></th>`;
}

function shortOf(avd) {
  return { 'Spårare':'sp','Upptäckare':'up','Äventyrare':'av','Utmanare':'ut','Rover':'ro','Ledare':'le' }[avd] || 'le';
}

async function openStartCardModal(cid, patrol) {
  if (!patrol) return;
  const url = startUrl(cid, patrol.id);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:560px;">
      <div class="modal-head">
        <h3>Startkort · Patrull #${escapeHtml(String(patrol.number ?? ''))} ${escapeHtml(patrol.name || '')}</h3>
        <button class="icon-btn" id="x" aria-label="Stäng">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <p class="muted t-sm" style="margin-top:0;">Distribuera denna länk eller QR-kod till patrullen. Skannas på sekretariatet för att få sitt digitala startkort — kontrollerna, kartan och poängen.</p>
        <div id="qr" class="row" style="justify-content:center;padding:12px 0;"></div>
        <label class="field">Länk</label>
        <div class="row">
          <input class="input mono t-sm" readonly value="${escapeHtml(url)}" id="url-input">
          <button class="btn btn-secondary btn-sm" id="copy">Kopiera</button>
        </div>
        <div class="btn-row mt-4">
          <button class="btn btn-primary" id="pdf">${icon('download', { size: 16 })} Ladda ner PDF</button>
          <a class="btn btn-ghost" href="${url}" target="_blank" rel="noopener">Öppna startkort</a>
          <a class="btn btn-secondary" href="/app/c/${cid}/startscreen" target="_blank" rel="noopener">Startskärm</a>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="close">Stäng</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#x').onclick = close;
  overlay.querySelector('#close').onclick = close;

  const qrHost = overlay.querySelector('#qr');
  renderQrToImg(url, 200).then(img => { qrHost.innerHTML = ''; qrHost.appendChild(img); });

  overlay.querySelector('#copy').addEventListener('click', async () => {
    await copyToClipboard(url);
    toast('Länk kopierad', 'success');
  });

  const pdfBtn = overlay.querySelector('#pdf');
  pdfBtn.addEventListener('click', () => withBusy(pdfBtn, 'Skapar PDF…', async () => {
    try {
      const comp = await getCompetition(cid);
      await downloadStartPdf({ id: cid, ...comp }, patrol);
    } catch (e) {
      console.error(e);
      toast('Kunde inte skapa PDF: ' + e.message, 'error');
    }
  }));
}

function openPatrolModal(cid, patrol, fallbackOrder = null) {
  const isEdit = !!patrol;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>${isEdit ? 'Redigera patrull' : 'Ny patrull'}</h3><button class="icon-btn" id="x" aria-label="Stäng">${icon('x')}</button></div>
      <div class="modal-body">
        <form id="f" class="field-group">
          <div class="grid grid-2">
            <div>
              <label class="field" for="number">Nr</label>
              <input class="input" id="number" type="number" value="${escapeHtml(String(patrol?.number ?? ''))}">
            </div>
            <div>
              <label class="field" for="antal">Antal deltagare</label>
              <input class="input" id="antal" type="number" value="${escapeHtml(String(patrol?.antal ?? ''))}">
            </div>
          </div>
          <div>
            <label class="field" for="name">Patrullnamn</label>
            <input class="input" id="name" required value="${escapeHtml(patrol?.name || '')}" placeholder="Ex. Björnarna">
          </div>
          <div>
            <label class="field" for="avd">Avdelning</label>
            <select class="select" id="avd" required>
              <option value="">Välj avdelning…</option>
              ${AVDELNINGAR.map(a => `<option value="${a.key}" ${patrol?.avdelning === a.key ? 'selected' : ''}>${a.key} (${a.range})</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="field" for="kar">Kår</label>
            <input class="input" id="kar" value="${escapeHtml(patrol?.kar || '')}" placeholder="Ex. Lindsdals Scoutkår">
          </div>
          <div>
            <label class="field" for="notering">Notering</label>
            <textarea class="textarea" id="notering">${escapeHtml(patrol?.notering || '')}</textarea>
          </div>
        </form>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel">Avbryt</button>
        <button class="btn btn-primary" id="save">${isEdit ? 'Spara' : 'Skapa patrull'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#x').onclick = close;
  overlay.querySelector('#cancel').onclick = close;

  const saveBtn = overlay.querySelector('#save');
  saveBtn.addEventListener('click', async () => {
    const f = overlay.querySelector('#f');
    if (!f.reportValidity()) return;
    await withBusy(saveBtn, 'Sparar…', async () => {
      const data = {
        number: overlay.querySelector('#number').value ? Number(overlay.querySelector('#number').value) : null,
        antal: overlay.querySelector('#antal').value ? Number(overlay.querySelector('#antal').value) : null,
        name: overlay.querySelector('#name').value.trim(),
        avdelning: overlay.querySelector('#avd').value,
        kar: overlay.querySelector('#kar').value.trim(),
        notering: overlay.querySelector('#notering').value.trim()
      };
      try {
        if (isEdit) {
          await updatePatrol(cid, patrol.id, data);
        } else {
          // Put new patrol at the end of the start queue by default.
          if (fallbackOrder != null) data.startOrder = fallbackOrder;
          await createPatrol(cid, data);
        }
        close();
        toast('Sparat', 'success');
      } catch (e) {
        toast('Fel: ' + e.message, 'error');
      }
    });
  });
}
