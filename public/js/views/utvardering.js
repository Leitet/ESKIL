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
  MAX_TEXT, MAX_BILDTEXT, normUtvardering, utvarderingBildIds, OVERLAMNING_ARRANGOR, OVERLAMNING_ADRESS
} from '../utvardering.js';
import { formateraKod } from '../overlamningskod.js';

const radbryt = (t) => escapeHtml(t).replace(/\n/g, '<br>');

export async function mountUtvardering(host, { cid, comp, user, readOnly }) {
  const card = document.createElement('section');
  card.className = 'card mt-6';
  card.id = 'utvardering';
  card.innerHTML = `
    <h3 class="t-h3" style="margin-top:0;">Utvärdering och överlämning ${help('comp.utvardering')}</h3>
    <p class="muted">När tävlingen är avslutad skriver ni utvärderingen här — gärna tillsammans, medan dagen är färsk.
    Den sparas i ESKIL, följer med till nästa årgång som "förra årets utvärdering", och blir tillsammans med banan,
    kontrollerna, anmälningarna och resultaten en <strong>tävlingsrapport</strong> (PDF) att arkivera och dela med kåren.</p>
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
  // UTVÄRDERINGEN LÅSES UPP AV AVSLUTET. Det är moroten för att faktiskt
  // avsluta tävlingen — och därmed gallra personuppgifterna — och det gör
  // rapportens påstående sant: när den tas ut ÄR allt utom ledningens namn och
  // e-post raderat. De löpande anteckningarna och förra årets utvärdering står
  // utanför låset: dem behöver ledningen medan tävlingen planeras.
  const avslutad = comp?.closed === true;
  let ovl = null;
  if (avslutad) { try { ovl = await store.getOverlamning(cid); } catch { /* ingen kod */ } }

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

  // Guiden för en ny arrangör — samma text i formuläret, i rapporten och i
  // nästa års tävling (OVERLAMNING_ARRANGOR i utvardering.js).
  const pilar = (t) => escapeHtml(t).replace(/-&gt;/g, '→');
  const lista = (rader) => `<ul class="utv-lista">${rader.map(r => `<li>${pilar(r)}</li>`).join('')}</ul>`;
  const arrangorGuideHtml = () => {
    const o = OVERLAMNING_ARRANGOR;
    return `
      <p class="muted t-sm" style="margin:0 0 8px;">${escapeHtml(o.ingress)}</p>
      <ol class="utv-steg">${o.steg.map(s => `<li><strong>${escapeHtml(s.rubrik)}.</strong> ${pilar(s.text)}</li>`).join('')}</ol>
      <div class="grid grid-2" style="gap:var(--sp-4);">
        <div><h4 class="utv-foreg-rubrik" style="margin-top:4px;">Följer med i kopian</h4>${lista(o.foljerMed)}</div>
        <div><h4 class="utv-foreg-rubrik" style="margin-top:4px;">Följer inte med</h4>${lista(o.foljerInteMed)}</div>
      </div>
      <h4 class="utv-foreg-rubrik">Det första nästa arrangör gör i den nya tävlingen</h4>${lista(o.attGoraForst)}`;
  };

  // Överlämningskoden: skapa, visa, dra in — och se när den lösts in.
  const kodHtml = () => {
    const datum = (iso) => iso ? new Date(iso).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    if (!ovl?.kod) {
      return `<div class="utv-kod">
        <strong>Överlämningskod</strong>
        <p class="muted t-sm" style="margin:4px 0 10px;">Skapa en kod som nästa arrangör löser in på <strong>${escapeHtml(OVERLAMNING_ADRESS)}</strong>. De får då en färdig tävling för nästa år, utan att någon behöver ge dem åtkomst till er. Koden skrivs ut i tävlingsrapporten.</p>
        ${lasning ? '' : '<button type="button" class="btn btn-secondary btn-sm" id="utv-kod-skapa">Skapa överlämningskod</button>'}
      </div>`;
    }
    if (ovl.anvand) {
      return `<div class="utv-kod">
        <strong>${icon('check', { size: 16 })} Koden är inlöst</strong>
        <p class="muted t-sm" style="margin:4px 0 10px;">Löstes in ${escapeHtml(datum(ovl.anvand.at))}${ovl.anvand.av ? ` av <strong>${escapeHtml(ovl.anvand.av)}</strong>` : ''} — en ny tävling är skapad åt dem. Koden gäller inte längre.</p>
        ${lasning ? '' : '<button type="button" class="btn btn-ghost btn-sm" id="utv-kod-skapa">Skapa en ny kod</button>'}
      </div>`;
    }
    return `<div class="utv-kod">
      <strong>Överlämningskod</strong>
      <div class="utv-kod-rad">
        <code class="utv-kod-varde" id="utv-kod-varde">${escapeHtml(formateraKod(ovl.kod))}</code>
        <button type="button" class="btn btn-secondary btn-sm" id="utv-kod-kopiera">${icon('copy', { size: 14 })} Kopiera</button>
      </div>
      <p class="muted t-sm" style="margin:8px 0 10px;">Nästa arrangör går till <strong>${escapeHtml(OVERLAMNING_ADRESS)}</strong>, skriver koden och sin e-postadress. Koden gäller en gång, står i tävlingsrapporten och är inte inlöst ännu. Skapad ${escapeHtml(datum(ovl.skapad))}. <strong>Behandla den som en nyckel</strong> — den som har den kan skapa en kopia av tävlingens upplägg.</p>
      ${lasning ? '' : `<button type="button" class="btn btn-ghost btn-sm" id="utv-kod-skapa">Skapa en ny kod</button>
      <button type="button" class="btn btn-ghost btn-sm" id="utv-kod-dra-in" style="color:var(--utm-pink);">Dra in koden</button>`}
    </div>`;
  };

  const arrangorHtml = () => `
    <div class="utv-avdelare"></div>
    <div class="utv-sektion" data-sektion="nyArrangor">
      <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
        <input type="checkbox" id="utv-nyArrangor" ${u.nyArrangor ? 'checked' : ''} ${lasning ? 'disabled' : ''} style="margin-top:4px;">
        <span><strong>${escapeHtml(OVERLAMNING_ARRANGOR.kryssruta)}</strong>
          <div class="field-hint" style="margin-top:2px;">Lägger till ett kapitel i tävlingsrapporten med överlämningskoden och hur nästa arrangör tar över i ESKIL, och visar "att göra först" för dem i den nya tävlingen.</div></span>
      </label>
      <div id="utv-arrangor-panel" ${u.nyArrangor ? '' : 'hidden'}>
        <div id="utv-kod-host">${kodHtml()}</div>
        <label class="field mt-3" for="utv-nyArrangorText">Eget meddelande till nästa arrangör <span class="muted">(valfritt)</span></label>
        <textarea class="textarea" id="utv-nyArrangorText" rows="4" maxlength="${MAX_TEXT}" ${lasning ? 'disabled' : ''}
          placeholder="T.ex. vem som tar över och när, vad ni lämnar över fysiskt, vem hos er de kan ringa första året.">${escapeHtml(u.nyArrangorText)}</textarea>
        <details class="utv-foregaende" style="margin-top:var(--sp-3);">
          <summary>${icon('info', { size: 16 })} Det här kommer med i rapporten</summary>
          <div style="margin-top:10px;">${arrangorGuideHtml()}</div>
        </details>
      </div>
    </div>`;

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
    // Lämnades tävlingen över till en ny arrangör möts de av sin att-göra-lista
    // FÖRST — betalningsuppgifterna pekar annars på förra arrangörens konto.
    const overtag = f.nyArrangor ? `
      <div class="utv-overtag">
        <strong>${icon('triangle-alert', { size: 16 })} Tävlingen lämnades över till en ny arrangör — gör det här först</strong>
        ${lista(OVERLAMNING_ARRANGOR.attGoraForst)}
        ${f.nyArrangorText.trim() ? `<h4 class="utv-foreg-rubrik">Meddelande från förra arrangören</h4><p class="utv-foreg-text">${radbryt(f.nyArrangorText)}</p>` : ''}
      </div>` : '';
    if (!delar && !overtag) return '';
    return `<details class="utv-foregaende" open>
      <summary>${icon('history', { size: 16 })} Förra årets utvärdering${f.namn || f.ar ? ` — ${escapeHtml([f.namn, f.ar].filter(Boolean).join(' '))}` : ''}</summary>
      ${overtag}
      ${delar ? '<p class="muted t-sm" style="margin:8px 0 0;">Skrivskyddad. Börja med förbättringsförslagen — vilka har ni tagit hand om i år?</p>' : ''}
      ${delar}
    </details>`;
  };

  const metaText = () => osparat
    ? 'Osparade ändringar'
    : (u.updatedAt ? `Senast sparad ${new Date(u.updatedAt).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' })}${u.updatedBy ? ' av ' + u.updatedBy : ''}` : '');

  function render() {
    if (!avslutad) {
      body.innerHTML = `
        ${foregaendeHtml()}
        <div class="utv-last">
          ${icon('lock', { size: 20 })}
          <div><strong>Utvärderingen låses upp när tävlingen är avslutad</strong>
          <span>Avsluta tävlingen här ovanför när den är genomförd. Då gallras personuppgifterna, och utvärderingens fyra delar, tävlingsrapporten och överlämningen till nästa arrangör blir tillgängliga. Ledningens namn och e-post sparas för rapporten; allt annat personligt raderas.</span></div>
        </div>
        ${sektionHtml(UTV_ANTECKNINGAR, 0)}
        <div class="row wrap mt-4" style="align-items:center;gap:var(--sp-3);">
          ${lasning ? '' : `<button class="btn btn-primary" id="utv-spara">Spara anteckningarna</button>`}
          <span class="muted t-sm" id="utv-meta">${escapeHtml(metaText())}</span>
        </div>`;
      koppla();
      return;
    }
    body.innerHTML = `
      ${foregaendeHtml()}
      ${UTV_SEKTIONER.map((s, i) => sektionHtml(s, i + 1)).join('')}
      <div class="utv-avdelare"></div>
      ${sektionHtml(UTV_ANTECKNINGAR, 0)}
      ${arrangorHtml()}
      <p class="field-hint" style="margin-top:var(--sp-3);">${icon('info', { size: 14 })} Utvärderingen är intern — den syns bara för tävlingens medlemmar. Den ligger kvar efter att tävlingen avslutats och följer med till nästa årgång, så undvik personuppgifter och bilder där enskilda scouter går att känna igen.</p>
      <div class="row wrap mt-4" style="align-items:center;gap:var(--sp-3);">
        ${lasning ? '' : `<button class="btn btn-primary" id="utv-spara">Spara utvärdering</button>`}
        <button class="btn btn-secondary" id="utv-pdf">${icon('file-text', { size: 16 })} Ladda ner tävlingsrapport (PDF)</button>
        <span class="muted t-sm" id="utv-meta">${escapeHtml(metaText())}</span>
      </div>
      <p class="field-hint" style="margin-top:6px;">Rapporten innehåller försättsblad, utvärderingen med bilder, bankarta med planerad och verklig tid, kontrollerna med instruktioner, anmälningsstatistik, start- och måltider, kompletta resultat, dagens meddelanden och inställningarna. Den säger uttryckligen att alla personuppgifter utom ledningens namn och e-post raderades när tävlingen avslutades.</p>`;
    koppla();
  }

  const lasFalt = () => {
    for (const k of UTV_ALLA_NYCKLAR) { const el = body.querySelector(`#utv-${k}`); if (el) u[k] = el.value; }
    body.querySelectorAll('[data-bildtext]').forEach(inp => {
      const b = u.bilder.find(x => x.id === inp.dataset.bildtext);
      if (b) b.bildtext = inp.value.trim();
    });
    const kryss = body.querySelector('#utv-nyArrangor'); if (kryss) u.nyArrangor = kryss.checked;
    const medd = body.querySelector('#utv-nyArrangorText'); if (medd) u.nyArrangorText = medd.value;
  };
  const markeraOsparat = () => {
    osparat = true;
    const m = body.querySelector('#utv-meta'); if (m) m.textContent = metaText();
  };

  async function spara({ tyst = false } = {}) {
    lasFalt();
    const sparad = await store.sparaUtvardering(cid, {
      ...Object.fromEntries(UTV_ALLA_NYCKLAR.map(k => [k, u[k]])),
      bilder: u.bilder, nyArrangor: u.nyArrangor, nyArrangorText: u.nyArrangorText
    }, user);
    u.updatedAt = sparad.updatedAt; u.updatedBy = sparad.updatedBy;
    osparat = false;
    const m = body.querySelector('#utv-meta'); if (m) m.textContent = metaText();
    if (!tyst) toast('Utvärderingen sparad', 'success');
  }

  function koppla() {
    body.querySelectorAll('textarea, [data-bildtext]').forEach(el => el.addEventListener('input', markeraOsparat));
    const kopplaKod = () => {
      const host = body.querySelector('#utv-kod-host');
      if (!host) return;
      host.querySelector('#utv-kod-skapa')?.addEventListener('click', (e) => withBusy(e.currentTarget, 'Skapar…', async () => {
        try {
          if (ovl?.kod && !ovl.anvand && !await confirmDialog(
            'Skapa en ny kod? Den gamla slutar gälla direkt — en rapport som redan lämnats över bär då en kod som inte fungerar.',
            { okLabel: 'Skapa ny kod', danger: true })) return;
          ovl = await store.skapaOverlamningskod(cid, user);
          host.innerHTML = kodHtml(); kopplaKod();
          toast('Överlämningskoden skapad', 'success');
        } catch (err) { console.error(err); toast('Kunde inte skapa koden: ' + err.message, 'error'); }
      }));
      host.querySelector('#utv-kod-dra-in')?.addEventListener('click', async () => {
        if (!await confirmDialog('Dra in koden? Den slutar gälla direkt och går inte att lösa in.', { okLabel: 'Dra in koden', danger: true })) return;
        try {
          await store.draInOverlamningskod(cid);
          ovl = null;
          host.innerHTML = kodHtml(); kopplaKod();
          toast('Koden är indragen');
        } catch (err) { console.error(err); toast('Kunde inte dra in koden: ' + err.message, 'error'); }
      });
      host.querySelector('#utv-kod-kopiera')?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(formateraKod(ovl.kod)); toast('Koden kopierad', 'success'); }
        catch { toast('Kunde inte kopiera — markera koden och kopiera för hand.', 'error'); }
      });
    };
    kopplaKod();

    body.querySelector('#utv-nyArrangor')?.addEventListener('change', (e) => {
      const panel = body.querySelector('#utv-arrangor-panel');
      if (panel) panel.hidden = !e.target.checked;
      markeraOsparat();
    });

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
        await byggTavlingsrapport({ cid, comp, user, utvardering: u, bildData, overlamning: ovl }, {
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
