// Delad redigeringsdialog för en plats på kartan.
//
// Används av två ställen med olika data bakom sig:
//   - kontrollistan, för banans start och mål (comp.startFinish)
//   - inställningarnas Platser-flik, för intressepunkter (comp.places)
//
// Därav `fields`: samma dialog, men bara start/mål saknar symbol- och
// färgval (de har en fast, igenkännbar look på alla kartor och får inte
// kunna målas om till något oigenkännligt).

import { escapeHtml, wireOverlayClose } from './utils.js';
import { icon } from './icons.js';
import { initMapPicker } from './mappicker.js';
import { PLACE_KINDS, PLACE_ICONS, PALETTE, placeKind, normPlace, drawPlaces } from './places.js';

/**
 * @param {object} opts
 *   title      dialogrubrik
 *   value      { name, note, lat, lng, kind?, icon?, color? }
 *   fields     { kind?: bool, look?: bool, course?: bool } — sortväljare /
 *              symbol+färg / "ingår i spåret"
 *   context    { controls: [{nummer, name, lat, lng}], places: [normPlace] }
 *              ritas som blek bakgrund på kartan så man ser var man sätter
 *              punkten i förhållande till resten
 *   namePlaceholder
 *   onSave(v)  async; dialogen stängs när den gått igenom
 *   onDelete   valfri; visar en "Ta bort"-knapp
 * @returns Promise<void>
 */
export function openPlaceModal({
  title, value = {}, fields = {}, namePlaceholder = '',
  context = null, onSave, onDelete
} = {}) {
  return new Promise((resolve) => {
    const v = normPlace(value);
    // normPlace fyller i sortens namn när namnet är tomt — men i dialogen ska
    // ett tomt fält vara tomt, annars skriver användaren i en rubrik de tror
    // att de valt själva.
    const namn = String(value?.name || '');
    let lat = v.lat, lng = v.lng;
    let vald = { kind: v.kind, icon: v.icon, color: v.color };

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:560px;">
        <div class="modal-head">
          <h3>${escapeHtml(title)}</h3>
          <button class="icon-btn" id="pm-x" aria-label="Stäng">${icon('x', { size: 22 })}</button>
        </div>
        <div class="modal-body field-group">
          ${fields.kind ? `
            <div>
              <label class="field" for="pm-kind">Sorts plats</label>
              <select class="select" id="pm-kind">
                ${PLACE_KINDS.map(k => `<option value="${k.id}" ${k.id === v.kind ? 'selected' : ''}>${escapeHtml(k.label)}</option>`).join('')}
              </select>
              <div class="field-hint">Sorten sätter symbol och färg — du kan ändra båda nedan.</div>
            </div>` : ''}

          <div>
            <label class="field" for="pm-name">Namn</label>
            <input class="input" id="pm-name" maxlength="60" value="${escapeHtml(namn)}" placeholder="${escapeHtml(namePlaceholder)}">
          </div>

          ${fields.look ? `
            <div>
              <label class="field">Symbol</label>
              <div class="place-icons" id="pm-icons">
                ${PLACE_ICONS.map(n => `
                  <button type="button" class="place-icon ${n === v.icon ? 'active' : ''}" data-icon="${n}" title="${n}" aria-label="${n}">${icon(n, { size: 18 })}</button>
                `).join('')}
              </div>
            </div>
            <div>
              <label class="field">Färg</label>
              <div class="place-colors" id="pm-colors">
                ${PALETTE.map(c => `
                  <button type="button" class="place-color ${c.id === v.color ? 'active' : ''}" data-color="${c.id}"
                    style="background:${c.hex};" title="${escapeHtml(c.label)}" aria-label="${escapeHtml(c.label)}"></button>
                `).join('')}
              </div>
            </div>` : ''}

          ${fields.course ? `
            <div style="border-top:1px solid var(--border);padding-top:var(--sp-3);">
              <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
                <input type="checkbox" id="pm-incourse" ${v.inCourse ? 'checked' : ''} style="margin-top:4px;">
                <span>
                  <strong>Ingår i spåret</strong>
                  <div class="field-hint" style="margin-top:2px;">Platsen blir en punkt i banan — Start → 1 → 2 → <em>Matplats</em> → 3 — och spåret dras dit. Den ger inga poäng och räknas aldrig som en avklarad kontroll.</div>
                </span>
              </label>
              <div id="pm-course-fields" class="grid grid-2 mt-3" style="display:${v.inCourse ? 'grid' : 'none'};">
                <div>
                  <label class="field" for="pm-after">Passeras efter</label>
                  <select class="select" id="pm-after">
                    <option value="0" ${v.courseAfter === 0 ? 'selected' : ''}>Starten</option>
                    ${(context?.controls || []).map(c => `<option value="${Number(c.nummer)}" ${v.courseAfter === Number(c.nummer) ? 'selected' : ''}>Kontroll ${escapeHtml(String(c.nummer))}${c.name ? ' · ' + escapeHtml(c.name) : ''}</option>`).join('')}
                  </select>
                </div>
                <div>
                  <label class="field" for="pm-dwell">Tid på platsen (min)</label>
                  <input class="input" type="number" id="pm-dwell" min="0" step="5" placeholder="0" value="${v.dwellMinutes || ''}">
                  <div class="field-hint">Räknas in i banans tid och i ETA. Lämna tomt om man bara passerar.</div>
                </div>
              </div>
            </div>` : ''}

          <div>
            <label class="field">Position</label>
            <div class="field-hint" style="margin-bottom:6px;">Klicka på kartan för att placera. Markören kan dras för att finjustera.</div>
            <div id="pm-map" style="height:280px;width:100%;border-radius:var(--r-md);border:1.5px solid var(--border-strong);background:var(--bg-muted);"></div>
            <div class="row mt-3" style="gap:var(--sp-3);align-items:center;flex-wrap:wrap;">
              <button type="button" class="btn btn-ghost btn-sm" id="pm-gps">${icon('locate', { size: 16 })} Använd min plats</button>
              <span class="muted t-sm mono" id="pm-coord">${lat != null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : 'Ingen position vald'}</span>
            </div>
          </div>

          <div>
            <label class="field" for="pm-note">Notering (visas publikt)</label>
            <textarea class="textarea" id="pm-note" rows="2" placeholder="T.ex. 'Parkera högst upp, ej framför lokalen'">${escapeHtml(value?.note || '')}</textarea>
          </div>
        </div>
        <div class="modal-foot" style="justify-content:space-between;">
          <div>${onDelete ? '<button class="btn btn-ghost btn-sm" id="pm-del" style="color:var(--utm-pink);">Ta bort</button>' : ''}</div>
          <div class="btn-row">
            <button class="btn btn-ghost" id="pm-cancel">Avbryt</button>
            <button class="btn btn-primary" id="pm-save">Spara</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    let picker = null;
    const close = () => { try { picker?.destroy(); } catch {} overlay.remove(); resolve(); };
    wireOverlayClose(overlay, close);
    overlay.querySelector('#pm-x').addEventListener('click', close);
    overlay.querySelector('#pm-cancel').addEventListener('click', close);

    const coord = overlay.querySelector('#pm-coord');
    const setPos = (la, ln) => {
      lat = la; lng = ln;
      coord.textContent = `${la.toFixed(5)}, ${ln.toFixed(5)}`;
    };

    initMapPicker({
      container: overlay.querySelector('#pm-map'),
      lat: lat ?? undefined, lng: lng ?? undefined,
      onChange: ({ lat: la, lng: ln }) => setPos(la, ln)
    }).then(p => {
      picker = p;
      // Bakgrunden: befintliga kontroller och platser, dämpade och
      // oklickbara. Att sätta ut en punkt utan att se banan är att gissa.
      if (!context || !p?.map || !p?.L) return;
      const { L, map } = p;
      for (const c of context.controls || []) {
        if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
        L.circleMarker([c.lat, c.lng], {
          radius: 11, color: '#ffffff', weight: 2,
          fillColor: '#E95F13', fillOpacity: 0.55, interactive: false
        }).bindTooltip(String(c.nummer ?? '?'), {
          permanent: true, direction: 'center', className: 'map-label map-label-ctx'
        }).addTo(map);
      }
      const andra = (context.places || []).filter(pl => pl.id !== value?.id);
      drawPlaces(L, map, andra, { iconHtml: (n) => icon(n, { size: 15 }) })
        .forEach(m => {
          m.setStyle({ fillOpacity: 0.5, weight: 2, interactive: false });
          m.getTooltip()?.getElement()?.classList.add('map-label-ctx');
        });
      for (const sfp of context.startFinish || []) {
        L.circleMarker([sfp.lat, sfp.lng], {
          radius: 12, color: '#003660', weight: 2,
          fillColor: '#E2E000', fillOpacity: 0.6, interactive: false
        }).bindTooltip(sfp.label, {
          permanent: true, direction: 'center', className: 'map-label map-label-sf map-label-ctx'
        }).addTo(map);
      }
    }).catch(() => {});

    overlay.querySelector('#pm-gps').addEventListener('click', async () => {
      try {
        const pos = await picker?.useGeolocation();
        if (pos) setPos(pos.lat, pos.lng);
      } catch { coord.textContent = 'Kunde inte hämta din plats'; }
    });

    // Sortbytet uppdaterar symbol och färg — men bara så länge användaren inte
    // valt något eget. Annars skulle deras val tyst kastas bort.
    let egetUtseende = fields.look
      && (value?.icon != null || value?.color != null);
    const markera = (host, attr, val) => {
      overlay.querySelectorAll(`${host} [data-${attr}]`).forEach(b =>
        b.classList.toggle('active', b.dataset[attr] === val));
    };
    overlay.querySelector('#pm-kind')?.addEventListener('change', (e) => {
      vald.kind = e.target.value;
      if (egetUtseende) return;
      const k = placeKind(vald.kind);
      vald.icon = k.icon; vald.color = k.color;
      markera('#pm-icons', 'icon', vald.icon);
      markera('#pm-colors', 'color', vald.color);
    });
    overlay.querySelectorAll('#pm-icons [data-icon]').forEach(b => b.addEventListener('click', () => {
      vald.icon = b.dataset.icon; egetUtseende = true; markera('#pm-icons', 'icon', vald.icon);
    }));
    overlay.querySelectorAll('#pm-colors [data-color]').forEach(b => b.addEventListener('click', () => {
      vald.color = b.dataset.color; egetUtseende = true; markera('#pm-colors', 'color', vald.color);
    }));

    const inCourseBox = overlay.querySelector('#pm-incourse');
    inCourseBox?.addEventListener('change', () => {
      overlay.querySelector('#pm-course-fields').style.display = inCourseBox.checked ? 'grid' : 'none';
    });

    overlay.querySelector('#pm-del')?.addEventListener('click', async () => {
      await onDelete?.();
      close();
    });

    overlay.querySelector('#pm-save').addEventListener('click', async (e) => {
      if (lat == null || lng == null) { coord.textContent = 'Välj en position på kartan först'; return; }
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const inCourse = !!overlay.querySelector('#pm-incourse')?.checked;
        await onSave?.({
          ...vald,
          name: overlay.querySelector('#pm-name').value.trim(),
          note: overlay.querySelector('#pm-note').value.trim(),
          inCourse,
          courseAfter: inCourse ? Number(overlay.querySelector('#pm-after')?.value) || 0 : 0,
          dwellMinutes: inCourse ? Number(overlay.querySelector('#pm-dwell')?.value) || 0 : 0,
          lat, lng
        });
        close();
      } catch (err) {
        btn.disabled = false;
        coord.textContent = 'Kunde inte spara: ' + (err?.message || err);
      }
    });

    setTimeout(() => overlay.querySelector('#pm-name')?.focus(), 40);
  });
}
