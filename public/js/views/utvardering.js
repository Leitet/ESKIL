// Utvärdering och överlämning — kortet under Inställningar → Grund.
//
// Fyra delar + löpande anteckningar, bilder per del, och knappen som bygger
// tävlingsrapporten (PDF). All lagringslogik ligger i store.js och den rena
// modellen i ../utvardering.js; den här filen är bara formuläret.
//
// Går att fylla i EFTER att tävlingen avslutats: private/{doc}-regeln släpper
// in admin oavsett `closed`, och det är efteråt utvärderingen skrivs.

import { escapeHtml, toast, withBusy, confirmDialog } from '../utils.js';
import { icon } from '../icons.js';
import { help } from '../help.js';
import {
  UTV_SEKTIONER, UTV_ANTECKNINGAR, UTV_ALLA_NYCKLAR, MAX_BILDER_PER_SEKTION,
  MAX_TEXT, MAX_BILDTEXT, normUtvardering, utvarderingBildIds
} from '../utvardering.js';

const radbryt = (t) => escapeHtml(t).replace(/\n/g, '<br>');

export async function mountUtvardering(host, { cid, comp, user, readOnly }) {
  const card = document.createElement('section');
  card.className = 'card mt-6';
  card.id = 'utvardering';
  card.innerHTML = `
    <h3 class="t-h3" style="margin-top:0;">Utvärdering och överlämning ${help('comp.utvardering')}</h3>
    <p class="muted">Skriv utvärderingen medan dagen är färsk — gärna tillsammans, veckan efter. Den sparas i ESKIL,
    följer med till nästa årgång som "förra årets utvärdering", och blir tillsammans med banan, kontrollerna,
    anmälningarna och resultaten en <strong>tävlingsrapport</strong> (PDF) att arkivera och dela med kåren.</p>
    <div id="utv-body"><p class="muted">Laddar…</p></div>`;
  host.appendChild(card);
  const body = card.querySelector('#utv-body');

  const store = await import('../store.js');
  let u;
  try { u = normUtvardering(await store.getHandover(cid)); }
  catch { u = normUtvardering(null); }
  let bildData = {};
  try { bildData = await store.hamtaUtvarderingBilder(cid, utvarderingBildIds(u)); } catch { /* visas som "saknas" */ }

  let osparat = false;
  const lasning = !!readOnly;

  const bildHtml = (b, redigerbar) => `
    <figure class="utv-bild" data-bild="${escapeHtml(b.id)}">
      ${bildData[b.id]
        ? `<a href="${bildData[b.id]}" target="_blank" rel="noopener"><img src="${bildData[b.id]}" alt="${escapeHtml(b.bildtext || 'Bild i utvärderingen')}" loading="lazy"></a>`
        : '<div class="utv-bild-saknas">Bilden saknas</div>'}
      ${redigerbar
        ? `<input class="input" data-bildtext="${escapeHtml(b.id)}" maxlength="${MAX_BILDTEXT}" placeholder="Bildtext (valfri)" value="${escapeHtml(b.bildtext || '')}">
           <button type="button" class="btn btn-ghost btn-sm" data-ta-bort-bild="${escapeHtml(b.id)}" style="color:var(--utm-pink);">${icon('trash-2', { size: 14 })} Ta bort</button>`
        : (b.bildtext ? `<figcaption>${escapeHtml(b.bildtext)}</figcaption>` : '')}
    </figure>`;

  const sektionHtml = (s, nr) => {
    const bilder = u.bilder.filter(b => b.sektion === s.key);
    return `
      <div class="utv-sektion" data-sektion="${s.key}">
        <label class="field" for="utv-${s.key}">${nr ? `<span class="utv-nr">${nr}</span>` : ''}${escapeHtml(s.titel)}</label>
        <div class="field-hint" style="margin:-2px 0 6px;">${escapeHtml(s.ingress)}</div>
        <textarea class="textarea" id="utv-${s.key}" rows="${s.key === 'sammanfattning' ? 4 : 6}" maxlength="${MAX_TEXT}"
          placeholder="${escapeHtml(s.exempel)}" ${lasning ? 'disabled' : ''}>${escapeHtml(u[s.key])}</textarea>
        <div class="utv-bilder" data-bilder="${s.key}">${bilder.map(b => bildHtml(b, !lasning)).join('')}</div>
        ${lasning ? '' : `<button type="button" class="btn btn-ghost btn-sm" data-lagg-bild="${s.key}" ${bilder.length >= MAX_BILDER_PER_SEKTION ? 'disabled' : ''}>
          ${icon('image', { size: 14 })} Lägg till bild <span class="muted">(${bilder.length}/${MAX_BILDER_PER_SEKTION})</span></button>`}
      </div>`;
  };

  const foregaendeHtml = () => {
    const f = u.foregaende;
    if (!f) return '';
    // Förbättringsförslagen FÖRST: det är dem nästa ledning ska följa upp.
    const ordning = ['forbattringar', 'mindreBra', 'bra', 'sammanfattning'];
    const delar = ordning.map(k => {
      const s = UTV_SEKTIONER.find(x => x.key === k);
      const bilder = f.bilder.filter(b => b.sektion === k);
      if (!f[k].trim() && !bilder.length) return '';
      return `<h4 class="utv-foreg-rubrik">${escapeHtml(s.titel)}</h4>
        ${f[k].trim() ? `<p class="utv-foreg-text">${radbryt(f[k])}</p>` : ''}
        ${bilder.length ? `<div class="utv-bilder">${bilder.map(b => bildHtml(b, false)).join('')}</div>` : ''}`;
    }).join('');
    if (!delar) return '';
    return `<details class="utv-foregaende" open>
      <summary>${icon('history', { size: 16 })} Förra årets utvärdering${f.namn || f.ar ? ` — ${escapeHtml([f.namn, f.ar].filter(Boolean).join(' '))}` : ''}</summary>
      <p class="muted t-sm" style="margin:8px 0 0;">Skrivskyddad. Börja med förbättringsförslagen — vilka har ni tagit hand om i år?</p>
      ${delar}
    </details>`;
  };

  const metaText = () => osparat
    ? 'Osparade ändringar'
    : (u.updatedAt ? `Senast sparad ${new Date(u.updatedAt).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' })}${u.updatedBy ? ' av ' + u.updatedBy : ''}` : '');

  function render() {
    body.innerHTML = `
      ${foregaendeHtml()}
      ${UTV_SEKTIONER.map((s, i) => sektionHtml(s, i + 1)).join('')}
      <div class="utv-avdelare"></div>
      ${sektionHtml(UTV_ANTECKNINGAR, 0)}
      <p class="field-hint" style="margin-top:var(--sp-3);">${icon('info', { size: 14 })} Utvärderingen är intern — den syns bara för tävlingens medlemmar. Den ligger kvar efter att tävlingen avslutats och följer med till nästa årgång, så undvik personuppgifter och bilder där enskilda scouter går att känna igen.</p>
      <div class="row wrap mt-4" style="align-items:center;gap:var(--sp-3);">
        ${lasning ? '' : `<button class="btn btn-primary" id="utv-spara">Spara utvärdering</button>`}
        <button class="btn btn-secondary" id="utv-pdf">${icon('file-text', { size: 16 })} Ladda ner tävlingsrapport (PDF)</button>
        <span class="muted t-sm" id="utv-meta">${escapeHtml(metaText())}</span>
      </div>
      <p class="field-hint" style="margin-top:6px;">Rapporten innehåller försättsblad, utvärderingen med bilder, bankarta med planerad och verklig tid, kontrollerna med instruktioner, anmälningsstatistik, start- och måltider, kompletta resultat, dagens meddelanden och inställningarna. Ta ut den <strong>innan</strong> tävlingen avslutas — avslutet gallrar ledningens namn och sekretariatets logg.</p>`;
    koppla();
  }

  const lasFalt = () => {
    for (const k of UTV_ALLA_NYCKLAR) { const el = body.querySelector(`#utv-${k}`); if (el) u[k] = el.value; }
    body.querySelectorAll('[data-bildtext]').forEach(inp => {
      const b = u.bilder.find(x => x.id === inp.dataset.bildtext);
      if (b) b.bildtext = inp.value.trim();
    });
  };
  const markeraOsparat = () => {
    osparat = true;
    const m = body.querySelector('#utv-meta'); if (m) m.textContent = metaText();
  };

  async function spara({ tyst = false } = {}) {
    lasFalt();
    const sparad = await store.sparaUtvardering(cid, { ...Object.fromEntries(UTV_ALLA_NYCKLAR.map(k => [k, u[k]])), bilder: u.bilder }, user);
    u.updatedAt = sparad.updatedAt; u.updatedBy = sparad.updatedBy;
    osparat = false;
    const m = body.querySelector('#utv-meta'); if (m) m.textContent = metaText();
    if (!tyst) toast('Utvärderingen sparad', 'success');
  }

  function koppla() {
    body.querySelectorAll('textarea, [data-bildtext]').forEach(el => el.addEventListener('input', markeraOsparat));

    body.querySelector('#utv-spara')?.addEventListener('click', (e) => withBusy(e.currentTarget, 'Sparar…', async () => {
      try { await spara(); } catch (err) { console.error(err); toast('Kunde inte spara: ' + err.message, 'error'); }
    }));

    body.querySelectorAll('[data-lagg-bild]').forEach(btn => btn.addEventListener('click', () => withBusy(btn, 'Förbereder…', async () => {
      try {
        const { pickImage } = await import('../photo.js');
        const bild = await pickImage();
        if (!bild) return;
        lasFalt();
        const sektion = btn.dataset.laggBild;
        const id = await store.laggTillUtvarderingBild(cid, { dataUrl: bild.dataUrl, sektion }, user);
        u.bilder.push({ id, sektion, bildtext: '' });
        bildData[id] = bild.dataUrl;
        // Indexet skrivs DIREKT — annars ligger bilden i databasen utan att
        // något pekar på den om fliken stängs innan nästa Spara.
        await spara({ tyst: true });
        render();
        toast('Bilden tillagd', 'success');
      } catch (err) { console.error(err); toast('Kunde inte lägga till bilden: ' + err.message, 'error'); }
    })));

    body.querySelectorAll('[data-ta-bort-bild]').forEach(btn => btn.addEventListener('click', async () => {
      if (!await confirmDialog('Ta bort bilden ur utvärderingen?', { okLabel: 'Ta bort bilden', danger: true })) return;
      try {
        lasFalt();
        const id = btn.dataset.taBortBild;
        u.bilder = u.bilder.filter(b => b.id !== id);
        await spara({ tyst: true });          // indexet först — en rad utan bild är värre än tvärtom
        await store.taBortUtvarderingBild(cid, id).catch(() => {});
        delete bildData[id];
        render();
      } catch (err) { console.error(err); toast('Kunde inte ta bort bilden: ' + err.message, 'error'); }
    }));

    const pdfBtn = body.querySelector('#utv-pdf');
    pdfBtn?.addEventListener('click', () => withBusy(pdfBtn, 'Samlar underlag…', async () => {
      try {
        if (osparat && !lasning) await spara({ tyst: true });
        const label = pdfBtn.querySelector('.busy-label') || pdfBtn;
        const { byggTavlingsrapport } = await import('../rapport-pdf.js');
        await byggTavlingsrapport({ cid, comp, user, utvardering: u, bildData }, {
          onProgress: (text) => { label.textContent = text; }
        });
        toast('Tävlingsrapporten skapad', 'success');
      } catch (err) { console.error(err); toast('Kunde inte skapa rapporten: ' + err.message, 'error'); }
    }));
  }

  // Lämnar man sidan med osparad text ska webbläsaren fråga.
  const vakt = (e) => { if (osparat && card.isConnected) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', vakt);

  render();
  return card;
}
