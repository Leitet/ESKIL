import { layout, setTopbarCompetition, registerViewCleanup } from '../app.js';
import {
  getCompetition, watchControls, createControl, updateControl, flyttaTillPapperskorg,
  updateControlNumbers, setCompetitionUsers, getControlMeta, migrateControlMeta,
  updateCompetition
} from '../store.js';
import {
  AVDELNINGAR, allowedAvdelningar, escapeHtml, toast, confirmDialog, confirmHardDelete, withBusy, startFinishPoints,
  isCompAdminUser, normEmail
} from '../utils.js';
import { navigate } from '../router.js';
import { initMapPicker } from '../mappicker.js';
import { icon } from '../icons.js';
import { help, helpOnButton } from '../help.js';
import { openPlaceModal } from '../place-modal.js';
import { compPlaces } from '../places.js';
import { compHeader, compLabel, setDocTitle } from '../nav.js';

// Lazy-load SortableJS (also used by patrols.js).
let sortableReady = null;
function ensureSortable() {
  if (sortableReady) return sortableReady;
  sortableReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js';
    s.integrity = 'sha384-BSxuMLxX+FCbTdYec3TbXlnMGEEM2QXTFdtDaveen71o+jswm2J36+xFqp8k4VHM';
    s.crossOrigin = 'anonymous';
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
  if (!wrap.isConnected) return; // navigated away while loading
  if (!comp) { wrap.innerHTML = `<div class="empty"><h3>Tävlingen hittades inte</h3></div>`; return; }
  setTopbarCompetition(cid, comp, user);
  const isAdmin = isCompAdminUser(comp, user);

  let state = { rows: [], sort: 'nummer', dir: 1 };

  setDocTitle('Kontroller', compLabel(comp));
  wrap.innerHTML = `
    ${compHeader(cid, comp, user, {
      active: 'controls', title: 'Kontroller',
      actions: `
        ${helpOnButton(
          `<button class="btn btn-secondary btn-sm" id="field-pack" title="Alla kontrollers kompletta PDF:er i en fil — placering, instruktioner, nödinfo och reservprotokoll. Varje kontroll börjar på en ny framsida.">${icon('file-text', { size: 14 })} Fältpaket (PDF)</button>`,
          'comp.faltpaket')}
        ${isAdmin ? `
          <button class="btn btn-secondary btn-sm" id="open-all">Öppna alla</button>
          <button class="btn btn-secondary btn-sm" id="close-all">Stäng alla</button>
          <button class="btn btn-primary" id="new">+ Ny kontroll</button>
        ` : ''}`
    })}

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
    const sfMode = comp.startFinish?.mode === 'separate' ? 'separate' : 'same';

    const tbl = wrap.querySelector('#tbl');
    // Start och mål är banans ändpunkter, inte kontroller — de har inga poäng
    // och ingen rapportsida. Men de hör hemma HÄR, i banans lista, och inte i
    // en inställningsflik: det är här man bygger banan.
    const pseudoRowHtml = (label, p, colCount, which) => `
      <tr class="sf-row">
        <td colspan="${colCount}">
          <div style="display:flex;align-items:center;gap:var(--sp-3);">
            <span class="badge" style="background:#E2E000;color:#003660;font-weight:800;display:inline-flex;align-items:center;gap:6px;">${escapeHtml(p.label)}</span>
            <strong>${escapeHtml(label)}</strong>${help('comp.startFinish')}
            ${p.name ? `<span class="muted t-sm">· ${escapeHtml(p.name)}</span>` : ''}
            ${Number.isFinite(p.lat) ? `<span class="muted t-sm mono">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</span>` : ''}
            <span class="spacer"></span>
            ${isAdmin ? `<button class="btn btn-ghost btn-sm" data-edit-sf="${which}">Ändra</button>` : ''}
          </div>
        </td>
      </tr>`;

    const emptySfRow = (colCount) => `
      <tr class="sf-row">
        <td colspan="${colCount}">
          <div style="display:flex;align-items:center;gap:var(--sp-3);">
            <span class="badge badge-gray" style="display:inline-flex;align-items:center;gap:6px;">S/M</span>
            <span class="muted">Ingen start- och målplats satt</span>${help('comp.startFinish')}
            <span class="spacer"></span>
            <button class="btn btn-secondary btn-sm" data-edit-sf="start">Sätt start och mål</button>
          </div>
        </td>
      </tr>`;

    if (!rows.length && !sfPoints.length) {
      tbl.innerHTML = `<div class="empty">
        <h3>Inga kontroller</h3>
        <p>${isAdmin ? 'Skapa din första kontroll.' : 'Inga kontroller har skapats än.'}</p>
      </div>`;
      return;
    }

    const COL_COUNT = 8 + (dragEnabled ? 1 : 0);
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
              <th>Telefon</th>
              <th>Status</th>
              <th class="actions"></th>
            </tr>
          </thead>
          <tbody id="ctrl-body">
            ${sfStart ? pseudoRowHtml(sfStart.kind === 'startfinish' ? 'Start / Mål' : 'Start', sfStart, COL_COUNT, 'start')
              : (isAdmin ? emptySfRow(COL_COUNT) : '')}
            ${isAdmin && sfStart && sfMode === 'same' ? `
              <tr class="sf-row"><td colspan="${COL_COUNT}">
                <div style="display:flex;align-items:center;gap:var(--sp-3);">
                  <span style="width:1px;"></span>
                  <span class="muted t-sm">Start och mål på samma plats.</span>
                  <button class="btn btn-ghost btn-sm" data-split-sf>Målet ligger någon annanstans</button>
                </div></td></tr>` : ''}
            ${rows.map(r => `
              <tr data-id="${r.id}">
                ${dragEnabled ? `<td class="drag-col" aria-label="Dra för att ändra ordning">${icon('grip-vertical', { size: 18, class: 'drag-handle' })}</td>` : ''}
                <td class="num">${escapeHtml(String(r.nummer ?? ''))}</td>
                <td><a class="row-link" href="/app/c/${cid}/controls/${r.id}" data-link>${escapeHtml(r.name || '—')}</a></td>
                <td class="num">${r.maxPoang ?? ''}</td>
                <td class="num">${r.minPoang ?? ''}</td>
                <td class="num">${r.extraPoang ?? ''}</td>
                <td>${r.telefon ? `<a class="mono t-sm" href="tel:${escapeHtml(r.telefon)}" style="color:var(--scout-blue);text-decoration:none;white-space:nowrap;">${escapeHtml(r.telefon)}</a>` : '<span class="muted">—</span>'}</td>
                <td>${r.open ? '<span class="badge badge-green">Öppen</span>' : '<span class="badge badge-gray">Stängd</span>'}</td>
                <td class="actions">
                  <a class="btn btn-ghost btn-sm" href="/app/c/${cid}/meddelanden?kontroll=${encodeURIComponent(r.id)}" data-link
                     title="Skicka meddelande till den här kontrollen" aria-label="Skicka meddelande till kontroll ${r.nummer ?? ''}">${icon('send', { size: 15 })}</a>
                  <a class="btn btn-ghost btn-sm" href="/app/c/${cid}/controls/${r.id}" data-link>Öppna</a>
                </td>
              </tr>
            `).join('')}
            ${sfFinish ? pseudoRowHtml('Mål', sfFinish, COL_COUNT, 'finish')
              : (isAdmin && sfStart && sfMode === 'separate' ? `
                <tr class="sf-row"><td colspan="${COL_COUNT}">
                  <div style="display:flex;align-items:center;gap:var(--sp-3);">
                    <span class="badge badge-gray">M</span><span class="muted">Målplats saknas</span>
                    <span class="spacer"></span>
                    <button class="btn btn-secondary btn-sm" data-edit-sf="finish">Sätt mål</button>
                  </div></td></tr>` : '')}
          </tbody>
        </table>
      </div>
      ${dragEnabled && rows.length > 1 ? '<p class="muted t-sm mt-2">Dra kontroller för att ändra ordning. Numren räknas om 1…N efter släpp. QR-länkar påverkas inte.</p>' : ''}
      ${!dragEnabled && isAdmin ? '<p class="muted t-sm mt-2">Sortera på Nr stigande för att kunna dra och släppa.</p>' : ''}
    `;

    // Start/mål-redigering direkt i banans lista.
    tbl.querySelectorAll('[data-edit-sf]').forEach(btn => btn.addEventListener('click', () => {
      openStartFinishModal(btn.dataset.editSf);
    }));
    // Dela upp start och mål. Läget lagras i comp.startFinish.mode och styr
    // banans sista sträcka — därför en uttrycklig handling, inte en dold flagga.
    tbl.querySelector('[data-split-sf]')?.addEventListener('click', async () => {
      const nytt = { ...(comp.startFinish || {}), mode: 'separate' };
      await updateCompetition(cid, { startFinish: nytt });
      comp.startFinish = nytt;
      render();
      openStartFinishModal('finish');
    });

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

  // Start och mål lagras som förut i comp.startFinish — ETA-motorn,
  // spårdragningen och stationssidan hänger på den formen. Det som flyttat
  // hit är REDIGERINGEN: banan byggs där banan visas.
  async function openStartFinishModal(which) {
    const sf = comp.startFinish || {};
    const separat = sf.mode === 'separate';
    const isFinish = which === 'finish';
    const nuv = isFinish
      ? (sf.finish || {})
      : (sf.start || (Number.isFinite(sf.lat) ? { name: sf.name, lat: sf.lat, lng: sf.lng } : {}));

    await openPlaceModal({
      title: isFinish ? 'Målplats' : (separat ? 'Startplats' : 'Start- och målplats'),
      value: nuv,
      // Banan i bakgrunden: att sätta ut starten utan att se kontrollerna är
      // att gissa.
      context: {
        controls: [...state.rows]
          .filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lng))
          .sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0)),
        places: compPlaces(comp),
        startFinish: startFinishPoints(comp).filter(x => (x.kind === 'finish') !== isFinish)
      },
      namePlaceholder: isFinish ? 'Ex. Målgång vid parkeringen' : 'Ex. Lindsdals scoutgård',
      onSave: async (v) => {
        const nytt = {
          ...sf,
          enabled: true,
          mode: sf.mode === 'separate' ? 'separate' : 'same',
          [isFinish ? 'finish' : 'start']: { name: v.name, note: v.note, lat: v.lat, lng: v.lng }
        };
        // Gamla platta formen (sf.lat/sf.lng) ersätts när något sparas om.
        delete nytt.lat; delete nytt.lng; delete nytt.name;
        await updateCompetition(cid, { startFinish: nytt });
        comp.startFinish = nytt;
        toast(isFinish ? 'Målplats sparad' : 'Startplats sparad', 'success');
        render();
      },
      onDelete: (nuv.lat != null || Number.isFinite(nuv.lat)) ? async () => {
        if (!(await confirmDialog(
          isFinish
            ? 'Ta bort målplatsen? Banan får då samma start och mål.'
            : 'Ta bort start- och målplatsen? Spårets ändpunkter försvinner och ETA räknas bara mellan kontrollerna.',
          { okLabel: 'Ta bort', danger: true }))) return;
        const nytt = isFinish
          ? { ...sf, mode: 'same', finish: null }
          : { ...sf, enabled: false };
        await updateCompetition(cid, { startFinish: nytt });
        comp.startFinish = nytt;
        toast('Borttagen');
        render();
      } : null
    });
  }

  if (isAdmin) {
    wrap.querySelector('#new').addEventListener('click', () => {
      openControlModal(cid, null, (id) => navigate(`/app/c/${cid}/controls/${id}`), { comp });
    });

    // Bulk open/close — tävlingsmorgonens 15 klick blir ett. state.rows is
    // live via watchControls, so the table updates as each write lands.
    const bulkSetOpen = (open) => async (e) => {
      const btn = e.currentTarget; // nulled once the handler yields — capture first
      const targets = state.rows.filter(c => !!c.open !== open);
      if (!targets.length) { toast(open ? 'Alla kontroller är redan öppna' : 'Alla kontroller är redan stängda'); return; }
      const verb = open ? 'Öppna' : 'Stäng';
      if (!(await confirmDialog(`${verb} ${targets.length} kontroller för rapportering?`, { okLabel: `${verb} alla`, danger: false }))) return;
      await withBusy(btn, '…', async () => {
        try {
          for (const c of targets) await updateControl(cid, c.id, { open });
          toast(`${targets.length} kontroller ${open ? 'öppnade' : 'stängda'}`, 'success');
        } catch (err) { toast('Fel: ' + err.message, 'error'); }
      });
    };
    wrap.querySelector('#open-all').addEventListener('click', bulkSetOpen(true));
    wrap.querySelector('#close-all').addEventListener('click', bulkSetOpen(false));
  }

  // Fältpaketet: varje kontrolls KOMPLETTA PDF, i en fil att skriva ut och
  // riva isär till kontrollernas pärmar. Telefonnumren ligger i private/meta
  // — mergeMeta har redan fyllt på state.rows.
  wrap.querySelector('#field-pack').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    withBusy(btn, 'Skapar fältpaket…', async () => {
      try {
        const [{ downloadFieldPackPdf }, { listPatrols, getTrack, attachControlMeta, ensureThreadTokens },
               { internalManagement }] = await Promise.all([
          import('../pdf.js'), import('../store.js'), import('../utils.js')
        ]);
        const [patrols, track] = await Promise.all([listPatrols(cid), getTrack(cid).catch(() => null)]);
        // Telefonnummer OCH samtalstoken bor i kontrollens private/meta — utan
        // det här blir nödinfon tom och fältkortens QR skickar-bara.
        await attachControlMeta(cid, state.rows).catch(() => {});
        await ensureThreadTokens(cid, 'kontroll', state.rows).catch(() => {});
        // Paketet ritar en karta per kontroll — det tar tid, så säg var vi är
        // i stället för att låta knappen stå och snurra.
        const label = btn.querySelector('.busy-label') || btn;
        await downloadFieldPackPdf(comp, state.rows, patrols, internalManagement(comp), {
          track,
          onProgress: (i, n) => { label.textContent = `Kontroll ${i} av ${n}…`; }
        });
        toast('Fältpaketet skapat', 'success');
      } catch (err) { console.error(err); toast('Kunde inte skapa PDF: ' + err.message, 'error'); }
    });
  });

  registerViewCleanup(() => {
    if (unsub) { unsub(); unsub = null; }
    if (sortableInstance) { sortableInstance.destroy(); sortableInstance = null; }
  });
  // telefon/notering/ansvariga live in each control's member-only private/meta
  // subdoc — merge them in for the table AND the edit modal (cached so we
  // don't refetch on every live snapshot). ansvariga MUST be merged here:
  // the edit modal starts from control.ansvariga and saves the list back, so
  // a row without the merge opened → saved would wipe the kontrollansvariga.
  const metaById = {};
  async function mergeMeta(rows) {
    const missing = rows.filter(r => !(r.id in metaById));
    if (missing.length) {
      const metas = await Promise.all(missing.map(r => getControlMeta(cid, r.id).catch(() => ({}))));
      missing.forEach((r, i) => { metaById[r.id] = metas[i] || {}; });
    }
    rows.forEach(r => {
      const m = metaById[r.id] || {};
      r.telefon = m.telefon || '';
      r.notering = m.notering || '';
      if (m.ansvariga !== undefined) r.ansvariga = m.ansvariga;
      if (m.ansvarigaEmails !== undefined) r.ansvarigaEmails = m.ansvarigaEmails;
    });
  }
  // Migrate any legacy telefon/notering off the world-readable control docs
  // before subscribing, so the first render reads them from the private subdoc.
  if (isAdmin && !comp.demo) await migrateControlMeta(cid).catch(() => {});
  unsub = watchControls(cid, async rows => { await mergeMeta(rows); state.rows = rows; render(); });
}

function th(key, label, state, opts = {}) {
  const arrow = state.sort === key ? (state.dir > 0 ? '▲' : '▼') : '';
  const cls = 'sortable' + (opts.num ? ' num' : '');
  return `<th class="${cls}" data-key="${key}">${escapeHtml(label)} <span class="arrow">${arrow}</span></th>`;
}

// opts.manageAnsvariga: full edit of the kontrollansvariga list (admins).
// opts.inviteAnsvariga: append-only — a kontrollansvarig may invite
// co-ansvariga to their own control but never remove anyone (the security
// rules enforce the same via a hasAll superset guard).
export function openControlModal(cid, control, onSaved, { manageAnsvariga = true, inviteAnsvariga = false, comp = null } = {}) {
  const isEdit = !!control;
  const ansvariga = (control?.ansvariga || []).map(a => ({ ...a }));
  const showAnsvariga = manageAnsvariga || inviteAnsvariga;
  // In invite mode the existing entries are locked rows — only additions.
  const lockedCount = manageAnsvariga ? 0 : ansvariga.length;
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
              <label class="field" for="nummer">Nummer ${help('ctrl.nummer')}</label>
              <input class="input" id="nummer" type="number" required value="${escapeHtml(String(control?.nummer ?? ''))}">
            </div>
            <div>
              <label class="field" for="name">Namn</label>
              <input class="input" id="name" required value="${escapeHtml(control?.name || '')}" placeholder="Ex. Spårkoll">
            </div>
          </div>

          <div class="grid grid-2">
            <div>
              <label class="field" for="maxPoang">Max poäng ${help('ctrl.points')}</label>
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
            <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
              <input type="checkbox" id="utslag" ${control?.utslag ? 'checked' : ''} style="margin-top:4px;">
              <span>
                <strong>Utslagskontroll</strong>
                <div class="field-hint" style="margin-top:2px;">Kontrollen har en utslagsfråga (t.ex. "Hur många knopar är det i burken?"). Kontrollanten rapporterar patrullens svar, och vid lika poäng vinner den som ligger närmast rätt svar.</div>
              </span>
            </label>
            <div id="utslag-fields" style="margin-top:var(--sp-3);${control?.utslag ? '' : 'display:none;'}">
              <label class="field" for="utslagFraga">Utslagsfråga ${help('ctrl.utslag')}</label>
              <input class="input" id="utslagFraga" value="${escapeHtml(control?.utslagFraga || '')}" placeholder="Ex. Hur många knopar är det i burken?">
              <label class="field mt-3" for="utslagSvar">Rätt svar</label>
              <input class="input" id="utslagSvar" type="number" step="any" value="${control?.utslagSvar ?? ''}" placeholder="Lämna tomt tills facit är klart" style="max-width:260px;">
              <div class="field-hint">Utslaget räknas i placeringarna först när rätt svar är angivet — och då visas facit och alla gissningar på poängtabellen.</div>
            </div>
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
              <label class="field" for="placement">Placeringsbeskrivning (visas på PDF-sida 1) ${help('ctrl.placement')}</label>
              <input class="input" id="placement" value="${escapeHtml(control?.placement || '')}" placeholder="Ex. Strax innan korsningen, på den stora stenen på höger sida">
              <div class="field-hint">Fri text för den som ställer upp kontrollen. Visas under kartan i utskriften.</div>
            </div>
          </div>

          <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
            <div class="row" style="justify-content:space-between;margin-bottom:var(--sp-3);">
              <div class="t-over" style="color:var(--scout-blue);">Instruktioner per avdelning${help('ctrl.instructions')}</div>
              <button type="button" class="btn btn-ghost btn-sm" id="add-group">+ Lägg till grupp</button>
            </div>
            <div class="field-hint" style="margin-bottom:var(--sp-3);">Första gruppen utan avdelningar är default och gäller för alla som inte har en egen grupp.</div>
            <div id="groups"></div>
          </div>

          <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
            <label class="field" for="telefon">Telefon till kontrollen ${help('ctrl.telefon')}</label>
            <input class="input" id="telefon" type="tel" value="${escapeHtml(control?.telefon || '')}" placeholder="070-123 45 67" style="max-width:260px;">
            <div class="field-hint">Till någon som är på plats på kontrollen, så att sekretariatet kan nå den under tävlingen. Visas bara internt och raderas när tävlingen avslutas.</div>
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

          ${showAnsvariga ? `
            <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
              <label class="field">Kontrollansvariga ${help('ctrl.ansvariga')}</label>
              <div class="field-hint" style="margin-bottom:var(--sp-3);">${manageAnsvariga
                ? 'Kan redigera och öppna/stänga den här kontrollen, och får läsåtkomst till resten av tävlingen. Rättigheterna gäller från deras första inloggning.'
                : 'Bjud in fler som hjälper till på kontrollen — de får ett välkomstmail med rapportlänken. Bara administratörer kan ta bort någon.'}</div>
              <div id="ansvariga-list"></div>
              <button type="button" class="btn btn-secondary btn-sm" id="add-ansvarig">${icon('plus', { size: 14 })} ${manageAnsvariga ? 'Lägg till kontrollansvarig' : 'Bjud in kontrollansvarig'}</button>
            </div>
          ` : ''}
        </form>
      </div>
      <div class="modal-foot">
        ${isEdit && manageAnsvariga ? '<button class="btn btn-danger" id="del">Ta bort</button><div class="spacer"></div>' : ''}
        <button class="btn btn-ghost" id="cancel">Avbryt</button>
        <button class="btn btn-primary" id="save">${isEdit ? 'Spara' : 'Skapa kontroll'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // --- Kontrollansvariga editor ---------------------------------------------
  const ansvarigaList = overlay.querySelector('#ansvariga-list');
  if (ansvarigaList) {
    const renderAnsvariga = () => {
      ansvarigaList.innerHTML = ansvariga.length ? ansvariga.map((a, i) => i < lockedCount ? `
        <div class="row wrap" style="gap:var(--sp-2);margin-bottom:var(--sp-2);align-items:center;">
          <span class="t-sm" style="padding:6px 0;">${a.name ? `<strong>${escapeHtml(a.name)}</strong> · ` : ''}${escapeHtml(a.email || '')}</span>
        </div>
      ` : `
        <div class="row wrap" data-aidx="${i}" style="gap:var(--sp-2);margin-bottom:var(--sp-2);align-items:center;">
          <input class="input" type="email" required data-af="email" value="${escapeHtml(a.email || '')}" placeholder="e-post@exempel.se" style="max-width:240px;">
          <input class="input" data-af="name" value="${escapeHtml(a.name || '')}" placeholder="Namn" style="max-width:200px;">
          <button type="button" class="btn btn-ghost btn-sm" data-aremove="${i}" style="color:var(--utm-pink);">${icon('trash', { size: 14 })}</button>
        </div>
      `).join('') : '<p class="muted t-sm">Inga kontrollansvariga.</p>';
    };
    const syncAnsvariga = () => {
      ansvarigaList.querySelectorAll('[data-aidx]').forEach(row => {
        const i = Number(row.dataset.aidx);
        ansvariga[i] = {
          email: row.querySelector('[data-af="email"]').value,
          name: row.querySelector('[data-af="name"]').value
        };
      });
    };
    ansvarigaList.addEventListener('input', syncAnsvariga);
    ansvarigaList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-aremove]');
      if (!btn) return;
      syncAnsvariga();
      ansvariga.splice(Number(btn.dataset.aremove), 1);
      renderAnsvariga();
    });
    overlay.querySelector('#add-ansvarig').addEventListener('click', () => {
      syncAnsvariga();
      ansvariga.push({ email: '', name: '' });
      renderAnsvariga();
      const rows = ansvarigaList.querySelectorAll('[data-aidx]');
      rows[rows.length - 1]?.querySelector('[data-af="email"]')?.focus();
    });
    renderAnsvariga();
  }

  let picker = null; // map picker — must be destroyed on close (leaks a Leaflet map otherwise)
  const close = () => {
    try { picker?.destroy(); } catch {}
    picker = null;
    overlay.remove();
  };
  // No backdrop-tap close on this modal — it's a large edit form and a stray
  // tap outside would throw away everything typed. Close via X or Avbryt.
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
          ${AVDELNINGAR.filter(a =>
            // Only the avdelningar chosen for this competition — plus any
            // already ticked on the group, so stale choices stay removable.
            allowedAvdelningar(comp).some(x => x.key === a.key)
            || (g.avdelningar || []).includes(a.key)
          ).map(a => {
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

  overlay.querySelector('#utslag').addEventListener('change', (e) => {
    overlay.querySelector('#utslag-fields').style.display = e.target.checked ? '' : 'none';
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
      const p = await initMapPicker({
        container: mapEl,
        lat: currentPos?.[0],
        lng: currentPos?.[1],
        onChange: ({ lat, lng }) => updateCoords(lat, lng)
      });
      // Modal may have been closed while the picker loaded.
      if (!overlay.isConnected) { try { p.destroy(); } catch {} return; }
      picker = p;
      overlay.querySelector('#use-gps').addEventListener('click', async () => {
        try { await p.useGeolocation(); }
        catch (err) { toast('Kunde inte hämta plats: ' + err.message, 'error'); }
      });
    } catch (e) {
      console.error(e);
      mapEl.innerHTML = `<div class="empty" style="border:none;background:transparent;">Kartan kunde inte laddas.</div>`;
    }
  })();

  if (isEdit && manageAnsvariga) {
    const delBtn = overlay.querySelector('#del');
    delBtn.addEventListener('click', async () => {
      // Kontrollens poäng följer med i raderingen — samma grind som tävlingen:
      // färsk backup (hela tävlingen) + kontrollnamnet skrivet.
      const bekräftat = await confirmHardDelete({
        what: 'kontrollen',
        name: control.name || `Kontroll ${control.nummer ?? ''}`,
        hint: 'Alla rapporterade poäng på kontrollen försvinner också.',
        onBackup: async () => {
          const { downloadBackup } = await import('../backup.js');
          await downloadBackup(cid);
        }
      });
      if (!bekräftat) return;
      await withBusy(delBtn, 'Tar bort…', async () => {
        try {
          await flyttaTillPapperskorg(cid, 'kontroll', control.id);
          close();
          toast('Flyttad till papperskorgen — går att återställa under Inställningar');
          onSaved?.(null);
        }
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
        telefon: overlay.querySelector('#telefon').value.trim(),
        notering: overlay.querySelector('#notering').value.trim(),
        open: overlay.querySelector('#open').checked,
        utslag: overlay.querySelector('#utslag').checked,
        utslagFraga: overlay.querySelector('#utslagFraga').value.trim(),
        utslagSvar: overlay.querySelector('#utslagSvar').value.trim() !== ''
          ? Number(overlay.querySelector('#utslagSvar').value)
          : null
      };
      let cleanAnsvariga = null;
      if (showAnsvariga) {
        // Locked rows (invite mode) pass through untouched — the rules only
        // accept a superset of the existing list from non-admins.
        cleanAnsvariga = ansvariga
          .map(a => ({ email: normEmail(a.email), name: (a.name || '').trim() }))
          .filter(a => a.email);
        data.ansvariga = cleanAnsvariga;
        data.ansvarigaEmails = cleanAnsvariga.map(a => a.email);
      }
      try {
        let id;
        if (isEdit) { await updateControl(cid, control.id, data); id = control.id; }
        else { id = await createControl(cid, data); }
        // Kontrollansvariga get read access to the whole competition — mirror
        // them into the competition's user list (union; removal is manual
        // under Användare since they may be users in their own right).
        // Admin-only: private/access writes are denied for kontrollansvariga —
        // an invited co-ansvarig gets competition access via ansvarigaEmails.
        if (manageAnsvariga && cleanAnsvariga?.length) {
          try {
            const comp = await getCompetition(cid);
            const users = (comp.users || []).filter(u => u && typeof u === 'object');
            const known = new Set(users.map(u => normEmail(u.email)));
            const additions = cleanAnsvariga.filter(a => !known.has(a.email));
            if (additions.length) await setCompetitionUsers(cid, [...users, ...additions]);
          } catch (e) {
            console.warn('[ESKIL] could not mirror ansvariga into users:', e);
          }
        }
        close();
        toast('Sparat', 'success');
        onSaved?.(id);
      } catch (e) {
        toast('Fel: ' + e.message, 'error');
      }
    });
  });
}
