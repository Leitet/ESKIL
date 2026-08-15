// "Dela resultat" — bladet där patrullen väljer design, format och innehåll.
//
// Förhandsvisningen ÄR bilden: samma canvas som delas, bara skalad med CSS.
// Det som syns är alltså exakt det som hamnar i flödet — inget kan skilja
// mellan förhandsvisning och resultat.
//
// Delningen går via Web Share API när den finns (då hamnar bilden direkt i
// Instagram/Snapchat/meddelanden), annars laddas filen ner. Ingenting laddas
// upp till någon server: bilden skapas i telefonen och lämnar den bara om
// patrullen själv väljer att dela den.

import { escapeHtml } from './utils.js';
import { icon } from './icons.js';
import { openSheet } from './sheet.js';
import {
  renderShareCard, shareCardFile,
  SHARE_DESIGNS, SHARE_FORMATS, SHARE_FIELDS, SHARE_DEFAULTS
} from './share-card.js';

const NYCKEL = 'eskil:share-val';

function läsVal() {
  try { return { ...SHARE_DEFAULTS, ...JSON.parse(localStorage.getItem(NYCKEL) || '{}') }; }
  catch { return { ...SHARE_DEFAULTS }; }
}
function sparaVal(v) {
  try { localStorage.setItem(NYCKEL, JSON.stringify(v)); } catch { /* privat läge */ }
}

const filnamn = (data) =>
  `${(data.patrolName || 'resultat').replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()}-${data.compYear || ''}.png`.replace(/-+/g, '-');

function delningstext(data, val) {
  const bitar = [`${data.patrolName} i ${data.compName}${data.compYear ? ' ' + data.compYear : ''}`];
  if (val.placering && data.rank) bitar.push(`plats ${data.rank.rank} av ${data.rank.of}`);
  else if (val.poang && data.points != null) bitar.push(`${data.points} poäng`);
  return bitar.join(' — ') + '!';
}

/**
 * @param data  se renderShareCard i share-card.js
 * @param opts  { kanVisaPlacering } — false när poängen inte är publicerade,
 *              då erbjuds inte placeringen alls
 */
export function openShareSheet(data, { kanVisaPlacering = true } = {}) {
  const sparat = läsVal();
  let design = sparat.__design || 'djup';
  let format = sparat.__format || 'staende';
  const fält = { ...sparat };
  delete fält.__design; delete fält.__format;

  // Erbjud bara det som faktiskt finns. En avstängd kryssruta för något
  // tävlingen inte har är en fråga användaren inte kan svara på.
  const tillgängligt = SHARE_FIELDS.filter(f => {
    if (f.id === 'kar') return !!data.kar;
    if (f.id === 'poang') return data.points != null;
    if (f.id === 'placering') return kanVisaPlacering && !!data.rank;
    if (f.id === 'hojdpunkter') return (data.highlights || []).length > 0;
    if (f.id === 'tid') return !!data.courseMs;
    if (f.id === 'lank') return !!data.tavlingUrl;
    return true;
  });
  if (!kanVisaPlacering) fält.placering = false;

  const chip = (aktiv, attr, värde, text, under = '') => `
    <button type="button" class="share-chip${aktiv ? ' active' : ''}" data-${attr}="${värde}">
      <span class="share-chip-label">${escapeHtml(text)}</span>
      ${under ? `<span class="share-chip-sub">${escapeHtml(under)}</span>` : ''}
    </button>`;

  const ark = openSheet({
    eyebrow: data.patrolName,
    title: 'Dela ert resultat',
    className: 'sheet-share',
    body: `
      <div class="share-preview">
        <canvas id="share-canvas" aria-label="Förhandsvisning av bilden"></canvas>
      </div>

      <div class="share-group">
        <div class="share-group-title">Design</div>
        <div class="share-chips" id="share-designs">
          ${SHARE_DESIGNS.map(d => chip(d.id === design, 'design', d.id, d.label, d.beskrivning)).join('')}
        </div>
      </div>

      <div class="share-group">
        <div class="share-group-title">Format</div>
        <div class="share-chips share-chips-row" id="share-formats">
          ${SHARE_FORMATS.map(f => chip(f.id === format, 'format', f.id, f.label, `${f.w}×${f.h}`)).join('')}
        </div>
      </div>

      <div class="share-group">
        <div class="share-group-title">Ta med</div>
        <div class="share-toggles" id="share-fields">
          ${tillgängligt.map(f => `
            <label class="share-toggle">
              <input type="checkbox" data-field="${f.id}" ${fält[f.id] ? 'checked' : ''}>
              <span>${escapeHtml(f.label)}</span>
            </label>`).join('')}
        </div>
        ${kanVisaPlacering ? '' : `<p class="share-note">Placeringen kan tas med när tävlingsledningen publicerat resultatet.</p>`}
        <p class="share-note">Bilden skapas i din telefon. Den skickas ingenstans förrän du väljer att dela den.</p>
      </div>`,
    footer: `
      <div class="share-actions">
        <button type="button" class="r-btn" id="share-go">${icon('share-2', { size: 20 })} <span>Dela bilden</span></button>
        <button type="button" class="r-btn ghost" id="share-save">${icon('download', { size: 18 })} <span>Spara i telefonen</span></button>
      </div>
      <p class="share-hint" id="share-hint"></p>`
  });

  const overlay = ark.el;
  const canvas = overlay.querySelector('#share-canvas');
  const hint = overlay.querySelector('#share-hint');

  const rita = () => renderShareCard(canvas, data, { design, format, fields: fält });
  const kom_ihåg = () => sparaVal({ ...fält, __design: design, __format: format });

  rita();

  overlay.querySelectorAll('[data-design]').forEach(b => b.addEventListener('click', () => {
    design = b.dataset.design;
    overlay.querySelectorAll('[data-design]').forEach(x => x.classList.toggle('active', x === b));
    rita(); kom_ihåg();
  }));
  overlay.querySelectorAll('[data-format]').forEach(b => b.addEventListener('click', () => {
    format = b.dataset.format;
    overlay.querySelectorAll('[data-format]').forEach(x => x.classList.toggle('active', x === b));
    rita(); kom_ihåg();
  }));
  overlay.querySelectorAll('[data-field]').forEach(c => c.addEventListener('change', () => {
    fält[c.dataset.field] = c.checked;
    rita(); kom_ihåg();
  }));

  const göra = async (knapp, arbete) => {
    knapp.disabled = true;
    hint.textContent = '';
    try { await arbete(); }
    catch (e) {
      // AbortError = användaren stängde delningsdialogen. Inget fel.
      if (e?.name !== 'AbortError') hint.textContent = 'Kunde inte dela bilden: ' + (e?.message || e);
    }
    finally { knapp.disabled = false; }
  };

  const laddaNer = (fil) => {
    const url = URL.createObjectURL(fil);
    const a = document.createElement('a');
    a.href = url; a.download = fil.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  overlay.querySelector('#share-go').addEventListener('click', (e) => göra(e.currentTarget, async () => {
    const fil = await shareCardFile(rita(), filnamn(data));
    if (navigator.canShare?.({ files: [fil] })) {
      await navigator.share({ files: [fil], text: delningstext(data, fält) });
      return;
    }
    // Datorer och äldre webbläsare delar inte filer — då är en nedladdning
    // det närmaste man kommer, och det säger vi rakt ut.
    laddaNer(fil);
    hint.textContent = 'Den här webbläsaren kan inte dela filer direkt — bilden är sparad i stället.';
  }));

  overlay.querySelector('#share-save').addEventListener('click', (e) => göra(e.currentTarget, async () => {
    laddaNer(await shareCardFile(rita(), filnamn(data)));
    hint.textContent = 'Bilden är sparad.';
  }));

  return ark;
}
