import { layout } from '../app.js';
import { listCompetitionsForUser, createCompetition } from '../store.js';
import { escapeHtml, formatDate, toast, withBusy } from '../utils.js';
import { createManagementForm } from '../managementform.js';
import { icon } from '../icons.js';

// Shared reader for the start/finish form block.
function readStartFinish(overlay) {
  const mode = overlay.querySelector('input[name="sf-mode"]:checked')?.value || 'same';
  const num = (el) => el.value ? Number(el.value) : null;
  const sfEnabled = overlay.querySelector('#sf-enabled').checked;
  const start = {
    name: overlay.querySelector('#sf-start-name').value.trim(),
    lat: num(overlay.querySelector('#sf-start-lat')),
    lng: num(overlay.querySelector('#sf-start-lng'))
  };
  const finish = mode === 'separate' ? {
    name: overlay.querySelector('#sf-finish-name').value.trim(),
    lat: num(overlay.querySelector('#sf-finish-lat')),
    lng: num(overlay.querySelector('#sf-finish-lng'))
  } : null;
  const obj = { enabled: sfEnabled, mode, start };
  if (finish) obj.finish = finish;
  return obj;
}

export { readStartFinish };
import { navigate } from '../router.js';

export async function renderHome(app, user) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="page-head">
      <div>
        <div class="t-over">Dina tävlingar</div>
        <h1 class="t-d2">Tävlingar</h1>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="create">+ Ny tävling</button>
      </div>
    </div>
    <div id="list"></div>
  `;
  layout(wrap);

  wrap.querySelector('#create').addEventListener('click', () => openCreateModal(user));

  const list = wrap.querySelector('#list');
  list.innerHTML = `<div class="muted">Laddar…</div>`;

  try {
    const comps = await listCompetitionsForUser(user);
    if (!comps.length) {
      list.innerHTML = `
        <div class="empty">
          <h3>Inga tävlingar än</h3>
          <p>Skapa din första tävling — t.ex. Älghornsjakten ${new Date().getFullYear()}.</p>
        </div>`;
      return;
    }

    comps.sort((a, b) => (b.year || 0) - (a.year || 0));

    list.innerHTML = `<div class="grid grid-2">${comps.map(c => `
      <a class="card" style="text-decoration:none;color:inherit;display:block;" href="/app/c/${c.id}" data-link>
        <div class="row" style="justify-content:space-between;">
          <span class="t-over" style="color:var(--avent-orange);">${escapeHtml(c.shortName || c.name || 'Tävling')}</span>
          <span class="badge badge-blue">${c.year || ''}</span>
        </div>
        <h3 class="t-h3" style="color:var(--scout-blue);margin:6px 0 4px;">${escapeHtml(c.name)}</h3>
        <div class="muted t-sm">${c.date ? formatDate(c.date) : 'Datum saknas'} · ${escapeHtml(c.location || 'Plats saknas')}</div>
        <div class="mt-4 row" style="gap:6px;">
          ${c.demo ? '<span class="badge badge-orange">Demo</span>' : `<span class="badge badge-gray">${(c.admins || []).length} admin</span>`}
          ${ (c.admins || []).includes(user.uid) ? '<span class="badge badge-green">Admin</span>' : '' }
          ${c.demo && user.role !== 'super-admin' ? '<span class="badge badge-gray">Läsbart</span>' : ''}
        </div>
      </a>
    `).join('')}</div>`;
  } catch (e) {
    console.error(e);
    list.innerHTML = `<div class="empty"><h3>Kunde inte läsa in tävlingar</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function openCreateModal(user) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h3>Ny tävling</h3>
        <button class="icon-btn" aria-label="Stäng" id="x">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <form id="f" class="field-group">
          <div>
            <label class="field" for="shortName">Kort namn</label>
            <input class="input" id="shortName" required placeholder="Älghornsjakten">
          </div>
          <div class="grid grid-2">
            <div>
              <label class="field" for="year">År</label>
              <input class="input" id="year" type="number" required value="${new Date().getFullYear()}">
            </div>
            <div>
              <label class="field" for="date">Datum</label>
              <input class="input" id="date" type="date">
            </div>
          </div>
          <div>
            <label class="field" for="name">Fullständigt namn</label>
            <input class="input" id="name" required placeholder="Älghornsjakten 2026">
            <div class="field-hint">Visas i listor och på PDF-utskrifter.</div>
          </div>
          <div>
            <label class="field" for="location">Plats</label>
            <input class="input" id="location" placeholder="Ex. Skogsmark, Linköping">
          </div>
          <div>
            <label class="field" for="organizer">Arrangör</label>
            <input class="input" id="organizer" placeholder="Ex. Lindsdals Scoutkår">
          </div>
          <div>
            <label class="field" for="description">Beskrivning</label>
            <textarea class="textarea" id="description" placeholder="Kort beskrivning av tävlingen…"></textarea>
          </div>
          <div>
            <label class="field" for="generalInfo">Allmän information (visas på alla kontrollers rapportsida)</label>
            <textarea class="textarea" id="generalInfo" placeholder="T.ex. akutrutiner, ansvarig vid olycka…"></textarea>
            <div class="field-hint">Syns under instruktionerna på varje kontrolls rapporteringssida.</div>
          </div>

          <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
              <input type="checkbox" id="anonymousControls" checked>
              <span>
                <strong>Anonyma kontroller</strong>
                <div class="field-hint" style="margin-top:2px;">Patrullerna ser bara "Kontroll N" tills de fått poäng — då avslöjas kontrollens namn och poängen.</div>
              </span>
            </label>
          </div>

          <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
              <input type="checkbox" id="st-enabled">
              <span>
                <strong>Använd starttider</strong>
                <div class="field-hint" style="margin-top:2px;">Patrullernas starttid beräknas utifrån deras ordning i patrullistan. Dra och släpp för att ändra.</div>
              </span>
            </label>
            <div id="st-fields" style="display:none;margin-top:var(--sp-3);">
              <div class="row wrap" style="gap:var(--sp-4);">
                <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                  <input type="radio" name="st-mode" value="interval" checked>
                  Starttid + intervall
                </label>
                <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                  <input type="radio" name="st-mode" value="range">
                  Starttid + sluttid
                </label>
              </div>
              <div class="grid grid-2 mt-3">
                <div>
                  <label class="field" for="st-firstStart">Första start</label>
                  <input class="input" type="time" id="st-firstStart" value="09:00">
                </div>
                <div id="st-interval-field">
                  <label class="field" for="st-interval">Intervall (minuter)</label>
                  <input class="input" type="number" id="st-interval" min="1" value="5">
                </div>
                <div id="st-last-field" style="display:none;">
                  <label class="field" for="st-lastStart">Sista start</label>
                  <input class="input" type="time" id="st-lastStart" value="12:00">
                </div>
              </div>
            </div>
          </div>

          <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
              <input type="checkbox" id="sf-enabled">
              <span>
                <strong>Start- och målplats</strong>
                <div class="field-hint" style="margin-top:2px;">Visas som specialkort i kontrollistan och som markörer på kartan. Normalt samma plats; annars två olika.</div>
              </span>
            </label>
            <div id="sf-fields" style="display:none;margin-top:var(--sp-3);" class="field-group">
              <div class="row wrap" style="gap:var(--sp-4);">
                <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                  <input type="radio" name="sf-mode" value="same" id="sf-mode-same" checked>
                  Samma plats (normalt)
                </label>
                <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                  <input type="radio" name="sf-mode" value="separate" id="sf-mode-separate">
                  Olika platser
                </label>
              </div>

              <div class="card" style="padding:var(--sp-4);background:var(--bg-muted);box-shadow:none;">
                <strong style="font-size:13px;display:block;margin-bottom:var(--sp-3);" id="sf-start-heading">Start / Mål</strong>
                <label class="field" for="sf-start-name">Namn</label>
                <input class="input" id="sf-start-name" placeholder="Ex. Lindsdals scoutgård">
                <div class="grid grid-2 mt-3">
                  <div>
                    <label class="field" for="sf-start-lat">Latitud</label>
                    <input class="input" id="sf-start-lat" type="number" step="any" placeholder="56.7380">
                  </div>
                  <div>
                    <label class="field" for="sf-start-lng">Longitud</label>
                    <input class="input" id="sf-start-lng" type="number" step="any" placeholder="16.3280">
                  </div>
                </div>
              </div>

              <div class="card" id="sf-finish-block" style="padding:var(--sp-4);background:var(--bg-muted);box-shadow:none;display:none;">
                <strong style="font-size:13px;display:block;margin-bottom:var(--sp-3);">Mål</strong>
                <label class="field" for="sf-finish-name">Namn</label>
                <input class="input" id="sf-finish-name" placeholder="Ex. Målgång vid parkeringen">
                <div class="grid grid-2 mt-3">
                  <div>
                    <label class="field" for="sf-finish-lat">Latitud</label>
                    <input class="input" id="sf-finish-lat" type="number" step="any">
                  </div>
                  <div>
                    <label class="field" for="sf-finish-lng">Longitud</label>
                    <input class="input" id="sf-finish-lng" type="number" step="any">
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
            <div class="t-over" style="color:var(--scout-blue);margin-bottom:var(--sp-2);">Tävlingsledning</div>
            <div class="field-hint" style="margin-bottom:var(--sp-3);">Lägg till roller. Välj om varje ska vara publik (startkort + offentlig sida) eller intern (bara på kontrollkort).</div>
            <div id="mgmt-host"></div>
          </div>
        </form>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel">Avbryt</button>
        <button class="btn btn-primary" id="save">Skapa tävling</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#x').onclick = close;
  overlay.querySelector('#cancel').onclick = close;

  // Keep shortName synced to name when user hasn't touched name
  const shortEl = overlay.querySelector('#shortName');
  const yearEl = overlay.querySelector('#year');
  const nameEl = overlay.querySelector('#name');
  let nameDirty = false;
  nameEl.addEventListener('input', () => { nameDirty = true; });
  const syncName = () => {
    if (!nameDirty) nameEl.value = `${shortEl.value} ${yearEl.value}`.trim();
  };
  shortEl.addEventListener('input', syncName);
  yearEl.addEventListener('input', syncName);
  syncName();

  // Toggle starttime fields + mode selector
  const stEnabled = overlay.querySelector('#st-enabled');
  const stFields = overlay.querySelector('#st-fields');
  stEnabled.addEventListener('change', () => {
    stFields.style.display = stEnabled.checked ? 'block' : 'none';
  });
  const applyStMode = () => {
    const m = overlay.querySelector('input[name="st-mode"]:checked').value;
    overlay.querySelector('#st-interval-field').style.display = m === 'range' ? 'none' : 'block';
    overlay.querySelector('#st-last-field').style.display = m === 'range' ? 'block' : 'none';
  };
  overlay.querySelectorAll('input[name="st-mode"]').forEach(r => r.addEventListener('change', applyStMode));

  // Mount management form (with default roles seeded for a fresh competition)
  const mgmt = createManagementForm(null, { seedDefaults: true });
  overlay.querySelector('#mgmt-host').appendChild(mgmt.element);

  // Toggle start/finish fields + mode selector
  const sfEnabled = overlay.querySelector('#sf-enabled');
  const sfFields = overlay.querySelector('#sf-fields');
  const sfFinishBlock = overlay.querySelector('#sf-finish-block');
  const sfStartHeading = overlay.querySelector('#sf-start-heading');
  sfEnabled.addEventListener('change', () => {
    sfFields.style.display = sfEnabled.checked ? 'block' : 'none';
  });
  const applyMode = () => {
    const mode = overlay.querySelector('input[name="sf-mode"]:checked').value;
    sfFinishBlock.style.display = mode === 'separate' ? 'block' : 'none';
    sfStartHeading.textContent = mode === 'separate' ? 'Start' : 'Start / Mål';
  };
  overlay.querySelectorAll('input[name="sf-mode"]').forEach(r => r.addEventListener('change', applyMode));
  applyMode();

  const saveBtn = overlay.querySelector('#save');
  saveBtn.addEventListener('click', async () => {
    const f = overlay.querySelector('#f');
    if (!f.reportValidity()) return;
    await withBusy(saveBtn, 'Skapar…', async () => {
      const data = {
        name: nameEl.value.trim(),
        shortName: shortEl.value.trim(),
        year: Number(yearEl.value) || new Date().getFullYear(),
        date: overlay.querySelector('#date').value || null,
        location: overlay.querySelector('#location').value.trim(),
        organizer: overlay.querySelector('#organizer').value.trim(),
        description: overlay.querySelector('#description').value.trim(),
        generalInfo: overlay.querySelector('#generalInfo').value.trim(),
        anonymousControls: overlay.querySelector('#anonymousControls').checked,
        startTimes: {
          enabled: overlay.querySelector('#st-enabled').checked,
          mode: overlay.querySelector('input[name="st-mode"]:checked').value,
          firstStart: overlay.querySelector('#st-firstStart').value || '09:00',
          intervalMinutes: Number(overlay.querySelector('#st-interval').value) || 5,
          lastStart: overlay.querySelector('#st-lastStart').value || null
        },
        startFinish: readStartFinish(overlay),
        management: mgmt.read()
      };
      try {
        const id = await createCompetition(data, user);
        close();
        toast('Tävling skapad', 'success');
        navigate(`/app/c/${id}`);
      } catch (e) {
        console.error(e);
        toast('Kunde inte skapa: ' + e.message, 'error');
      }
    });
  });
}
