import { layout } from '../app.js';
import {
  listCompetitionsForUser, createCompetition, isSlugTaken,
  createCompetitionRequest, listMyCompetitionRequests, deleteCompetitionRequest
} from '../store.js';
import {
  escapeHtml, formatDate, toast, withBusy, isCompAdminUser, ekonomiFromManagement,
  normSlug, isValidSlug, suggestSlug, wireOverlayClose
} from '../utils.js';
import { createManagementForm } from '../managementform.js';
import { icon } from '../icons.js';
import { DISTRICTS, districtShort, districtDot, normDistrict } from '../districts.js';
import { help } from '../help.js';

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
import { setDocTitle } from '../nav.js';

export async function renderHome(app, user) {
  setDocTitle('Tävlingar');
  const isSuper = user.role === 'super-admin';
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="page-head">
      <div>
        <div class="t-over">Dina tävlingar</div>
        <h1 class="t-d2">Tävlingar</h1>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="create">${isSuper ? '+ Ny tävling' : '+ Begär ny tävling'}</button>
      </div>
    </div>
    <div id="requests"></div>
    <div id="list"></div>
  `;
  layout(wrap);

  // Super-admin skapar direkt; alla andra skickar en förfrågan som en
  // super-admin godkänner (rules tillåter inte fri tävlingsskapning).
  wrap.querySelector('#create').addEventListener('click', () =>
    isSuper ? openCreateModal(user) : openRequestModal(user, renderMyRequests));

  const reqHost = wrap.querySelector('#requests');
  const renderMyRequests = async () => {
    if (isSuper) return; // super-admins ser alla förfrågningar under /app/admin/requests
    try {
      const reqs = (await listMyCompetitionRequests(user))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      reqHost.innerHTML = reqs.map(r => requestCard(r)).join('');
      reqHost.querySelectorAll('[data-dismiss]').forEach(b => b.addEventListener('click', async () => {
        try {
          await deleteCompetitionRequest(b.dataset.dismiss);
          renderMyRequests();
        } catch (e) { toast('Kunde inte ta bort: ' + e.message, 'error'); }
      }));
    } catch { reqHost.innerHTML = ''; } // förfrågningar är en bonus, aldrig blockerande
  };
  renderMyRequests();

  const list = wrap.querySelector('#list');
  list.innerHTML = `<div class="muted">Laddar…</div>`;

  try {
    const comps = await listCompetitionsForUser(user);
    if (!comps.length) {
      list.innerHTML = `
        <div class="empty">
          <h3>Inga tävlingar än</h3>
          <p>${isSuper
            ? `Skapa din första tävling — t.ex. Älghornsjakten ${new Date().getFullYear()}.`
            : 'Begär en ny tävling ovan, så granskar ESKIL:s administratör förfrågan och hör av sig via mail. Är du redan inbjuden till en tävling dyker den upp här när inbjudan registrerats.'}</p>
        </div>`;
      return;
    }

    comps.sort((a, b) => (b.year || 0) - (a.year || 0));

    const card = (c) => `
      <a class="card" style="text-decoration:none;color:inherit;display:block;" href="/app/c/${c.id}" data-link>
        <div class="row" style="justify-content:space-between;">
          <span class="t-over" style="color:var(--avent-orange);">${escapeHtml(c.shortName || c.name || 'Tävling')}</span>
          <span class="badge badge-blue">${c.year || ''}</span>
        </div>
        <h3 class="t-h3" style="color:var(--scout-blue);margin:6px 0 4px;">${escapeHtml(c.name)}</h3>
        <div class="muted t-sm">${c.date ? formatDate(c.date) : 'Datum saknas'} · ${escapeHtml(c.location || 'Plats saknas')}</div>
        <div class="mt-4 row" style="gap:6px;">
          ${c.district ? `<span class="badge badge-gray">${districtDot(c.district)}${escapeHtml(districtShort(c.district))}</span>` : ''}
          ${c.demo ? '<span class="badge badge-orange">Demo</span>' : `<span class="badge badge-gray">${(c.admins || []).length + (c.adminEmails || []).length} admin</span>`}
          ${isCompAdminUser(c, user) && user.role !== 'super-admin' ? '<span class="badge badge-green">Admin</span>' : ''}
          ${c.closed ? '<span class="badge badge-gray">Avslutad</span>' : ''}
          ${c.demo && user.role !== 'super-admin' ? '<span class="badge badge-gray">Läsbart</span>' : ''}
        </div>
      </a>`;

    // Gruppera per distrikt först när det finns mer än ett — annars är
    // rubrikerna bara brus för en kår som kör en enda tävling.
    const groups = new Map();
    for (const c of comps) {
      const key = c.district || 'annat';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    if (groups.size <= 1) {
      list.innerHTML = `<div class="grid grid-2">${comps.map(card).join('')}</div>`;
    } else {
      // Distrikt i bokstavsordning, "Annat" sist.
      const order = [...groups.keys()].sort((a, b) =>
        (a === 'annat') - (b === 'annat') || districtShort(a).localeCompare(districtShort(b), 'sv'));
      list.innerHTML = order.map(key => `
        <h2 class="t-h3 district-head">${districtDot(key)}${escapeHtml(districtShort(key) || 'Utan distrikt')}
          <span class="muted t-sm" style="font-weight:400;">${groups.get(key).length} tävling${groups.get(key).length === 1 ? '' : 'ar'}</span>
        </h2>
        <div class="grid grid-2">${groups.get(key).map(card).join('')}</div>
      `).join('');
    }
  } catch (e) {
    console.error(e);
    list.innerHTML = `<div class="empty"><h3>Kunde inte läsa in tävlingar</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

// Statuskort för sökandens egna förfrågningar på /app.
function requestCard(r) {
  const when = r.createdAt ? formatDate(String(r.createdAt).slice(0, 10)) : '';
  if (r.status === 'godkand') {
    return `
      <div class="card mb-4" style="border-left:3px solid var(--spaer-green, #41A62A);">
        <div class="row wrap" style="justify-content:space-between;gap:var(--sp-3);align-items:center;">
          <div>
            <span class="badge badge-green">Godkänd</span>
            <strong style="margin-left:8px;">${escapeHtml(r.name)}</strong>
            <div class="muted t-sm" style="margin-top:4px;">Tävlingen är skapad och du är administratör för den.</div>
            ${r.decisionMessage ? `<div class="t-sm" style="margin-top:6px;"><strong>Svar:</strong> ${escapeHtml(r.decisionMessage)}</div>` : ''}
          </div>
          <div class="btn-row">
            ${r.competitionId ? `<a class="btn btn-secondary btn-sm" href="/app/c/${escapeHtml(r.competitionId)}" data-link>Öppna tävlingen</a>` : ''}
            <button class="btn btn-ghost btn-sm" data-dismiss="${escapeHtml(r.id)}">Dölj</button>
          </div>
        </div>
      </div>`;
  }
  if (r.status === 'nekad') {
    return `
      <div class="card mb-4" style="border-left:3px solid var(--utm-pink);">
        <div class="row wrap" style="justify-content:space-between;gap:var(--sp-3);align-items:center;">
          <div>
            <span class="badge badge-pink">Nekad</span>
            <strong style="margin-left:8px;">${escapeHtml(r.name)}</strong>
            ${r.decisionMessage
              ? `<div class="t-sm" style="margin-top:6px;"><strong>Svar från ESKIL:</strong> ${escapeHtml(r.decisionMessage)}</div>`
              : '<div class="muted t-sm" style="margin-top:4px;">Ingen motivering angavs.</div>'}
          </div>
          <button class="btn btn-ghost btn-sm" data-dismiss="${escapeHtml(r.id)}">Dölj</button>
        </div>
      </div>`;
  }
  return `
    <div class="card mb-4" style="border-left:3px solid var(--avent-orange);">
      <span class="badge badge-orange">Väntar på granskning</span>
      <strong style="margin-left:8px;">${escapeHtml(r.name)}</strong>
      <div class="muted t-sm" style="margin-top:4px;">Skickad ${escapeHtml(when)} — ESKIL:s administratör granskar din förfrågan och svarar via mail till ${escapeHtml(r.requestedByEmail || '')}.</div>
    </div>`;
}

// Förfrågan om ny tävling — det lilla formuläret för vanliga användare.
function openRequestModal(user, onDone) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:520px;">
      <div class="modal-head"><h3>Begär en ny tävling</h3></div>
      <div class="modal-body field-group">
        <p class="muted t-sm" style="margin-top:0;">ESKIL:s administratör granskar förfrågan och svarar via mail.
        Blir den godkänd skapas tävlingen med dig som administratör — då fyller du i resten själv.</p>
        <div>
          <label class="field" for="rq-name">Tävlingens namn</label>
          <input class="input" id="rq-name" required placeholder="Ex. Älghornsjakten ${new Date().getFullYear() + 1}">
        </div>
        <div>
          <label class="field" for="rq-district">Scoutdistrikt ${help('comp.district')}</label>
          <select class="select" id="rq-district" required>
            <option value="" selected disabled>Välj distrikt…</option>
            ${DISTRICTS.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('')}
          </select>
          <div class="field-hint">Vilket distrikt tävlingen hör till. Välj "Annat" om kåren står utanför distrikt eller arrangerar tillsammans med andra.</div>
        </div>
        <div>
          <label class="field" for="rq-date">Datum (om det är bestämt)</label>
          <input class="input" id="rq-date" type="date">
        </div>
        <div>
          <label class="field" for="rq-desc">Kort beskrivning</label>
          <textarea class="textarea" id="rq-desc" rows="2" placeholder="Vilken kår arrangerar, ungefär hur många patruller…"></textarea>
        </div>
        <div>
          <label class="field" for="rq-msg">Meddelande till ESKIL:s administratör</label>
          <textarea class="textarea" id="rq-msg" rows="3" placeholder="Berätta kort vem du är och varför ni vill använda ESKIL."></textarea>
        </div>
        <p class="t-sm muted" style="margin:0;">Skickas från ${escapeHtml(user.email || '')}.</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="rq-cancel">Avbryt</button>
        <button class="btn btn-primary" id="rq-send">Skicka förfrågan</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  wireOverlayClose(overlay, close);
  overlay.querySelector('#rq-cancel').addEventListener('click', close);
  setTimeout(() => overlay.querySelector('#rq-name').focus(), 30);
  overlay.querySelector('#rq-send').addEventListener('click', (e) => withBusy(e.currentTarget, 'Skickar…', async () => {
    const name = overlay.querySelector('#rq-name').value.trim();
    if (!name) { toast('Ange ett namn på tävlingen.', 'error'); return; }
    const district = overlay.querySelector('#rq-district').value;
    if (!district) { toast('Välj vilket scoutdistrikt tävlingen hör till.', 'error'); return; }
    try {
      await createCompetitionRequest({
        name,
        district,
        date: overlay.querySelector('#rq-date').value || null,
        description: overlay.querySelector('#rq-desc').value,
        message: overlay.querySelector('#rq-msg').value
      }, user);
      close();
      toast('Förfrågan skickad — du får svar via mail', 'success');
      onDone?.();
    } catch (err) { toast('Kunde inte skicka: ' + err.message, 'error'); }
  }));
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
            <label class="field" for="slug">Kortadress &amp; betalningsprefix</label>
            <input class="input mono" id="slug" required placeholder="ah26" maxlength="24" style="max-width:200px;text-transform:lowercase;">
            <div class="field-hint" id="slug-hint">Tävlingssidan nås på <strong>eskilscout.se/t/<span id="slug-preview">…</span></strong> och betalningsreferenserna blir <strong><span id="slug-ref-preview">…</span>-XXXX</strong>. Sätts nu och kan inte ändras senare.</div>
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
            <label class="field" for="cd-district">Scoutdistrikt ${help('comp.district')}</label>
            <select class="select" id="cd-district">
              ${DISTRICTS.map(d => `<option value="${escapeHtml(d.id)}" ${d.id === 'annat' ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
            </select>
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
  // No backdrop-tap close — create form, a stray tap would lose typed data.
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

  // Slug: suggested from shortName + year until the user edits it themselves.
  const slugEl = overlay.querySelector('#slug');
  const slugPreview = overlay.querySelector('#slug-preview');
  const slugRefPreview = overlay.querySelector('#slug-ref-preview');
  let slugDirty = false;
  const showSlug = () => {
    const s = normSlug(slugEl.value);
    slugPreview.textContent = s || '…';
    slugRefPreview.textContent = (s || '…').toUpperCase();
  };
  slugEl.addEventListener('input', () => { slugDirty = true; showSlug(); });
  const syncSlug = () => {
    if (!slugDirty) { slugEl.value = suggestSlug(shortEl.value, yearEl.value); showSlug(); }
  };
  shortEl.addEventListener('input', syncSlug);
  yearEl.addEventListener('input', syncSlug);
  syncSlug();

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
      const slug = normSlug(overlay.querySelector('#slug').value);
      if (!isValidSlug(slug)) {
        toast('Kortadressen måste vara 2–24 tecken: a–z, 0–9 och bindestreck.', 'error');
        return;
      }
      if (await isSlugTaken(slug)) {
        toast(`Kortadressen "${slug}" används redan av en annan tävling.`, 'error');
        return;
      }
      const management = mgmt.read();
      const ekonomi = ekonomiFromManagement(management);
      const data = {
        slug,
        name: nameEl.value.trim(),
        shortName: shortEl.value.trim(),
        year: Number(yearEl.value) || new Date().getFullYear(),
        date: overlay.querySelector('#date').value || null,
        location: overlay.querySelector('#location').value.trim(),
        organizer: overlay.querySelector('#organizer').value.trim(),
        district: normDistrict(overlay.querySelector('#cd-district').value),
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
        management,
        ekonomi,
        ekonomiEmails: ekonomi.map(e => e.email)
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
