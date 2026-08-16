// Utskriftscentral — "Inför tävlingsdagen".
//
// Utskrifterna bodde på fem olika ställen: kontrollernas PDF under Kontroller,
// fältkorten på samma flik men en annan knapp, startkorten under Patruller,
// resultatlistan under Poängtabell och kvittona under Anmälan. En
// förstagångsarrangör som ska packa pärmarna kvällen före har ingen chans att
// veta att listan är komplett — och det man missar upptäcks i skogen.
//
// Sidan GENERERAR ingenting eget. Varje knapp anropar samma funktion som den
// ursprungliga fliken, så det finns fortfarande bara EN implementation per
// dokument. Skulle den här sidan börja rita egna PDF:er är det två sanningar
// om hur en kontrollpärm ser ut, och den ena kommer att glömmas bort.
import { getCompetition, listPatrols, listControls, attachControlMeta, getTrack, listAllScores, listRegistrations,
  skapaGenrepPatrull, rensaGenrep, GENREP_NAMN } from '../store.js';
import { compHeader, setDocTitle } from '../nav.js';
import { escapeHtml, toast, withBusy, isCompAdminUser, internalManagement, confirmDialog } from '../utils.js';
import { compPlaces } from '../places.js';
import { icon } from '../icons.js';
import { downloadFieldPackPdf, downloadManualStartPdf } from '../pdf.js';
import { downloadResultsPdf, attachTrackStats } from '../results-export.js';
import { help } from '../help.js';
import { layout, setTopbarCompetition } from '../app.js';

// Avbockningen lever i localStorage per tävling: den handlar om FYSISKA
// högar papper på ett bord, inte om data, och ska inte skrivas till Firestore
// där den blir en till sak att gallra.
const bockNyckel = (cid) => `eskil-utskrift-${cid}`;
const lasBockar = (cid) => {
  try { return new Set(JSON.parse(localStorage.getItem(bockNyckel(cid)) || '[]')); }
  catch { return new Set(); }
};
const sparaBockar = (cid, set) => {
  try { localStorage.setItem(bockNyckel(cid), JSON.stringify([...set])); } catch { /* privat läge */ }
};

export async function renderUtskrifter(app, user, cid) {
  setDocTitle('Utskrifter');
  // Vyn bygger i ett eget element och lämnar över till layout(), precis som
  // övriga admin-vyer. Skriver man rakt i app.innerHTML hoppar man över topbar,
  // sidmarginaler och sidfot — sidan ser då ut att tillhöra en annan app.
  const wrap = document.createElement('div');
  wrap.innerHTML = '<div class="muted">Laddar…</div>';
  layout(wrap);

  let comp, patrols, controls, track;
  try {
    comp = await getCompetition(cid);
    if (!wrap.isConnected) return;   // navigerade bort medan vi laddade
    if (!comp) { wrap.innerHTML = '<div class="empty"><h3>Tävlingen hittades inte</h3></div>'; return; }
    [patrols, controls, track] = await Promise.all([
      listPatrols(cid), listControls(cid), getTrack(cid).catch(() => null)
    ]);
    // Telefonnumret bor i controls/{id}/private/meta, inte på kontrolldokumentet.
    // Utan det här blev nödinfon i fältkorten TOM — och den här sidan är enligt
    // CLAUDE.md den kompletta listan man packar pärmarna efter.
    await attachControlMeta(cid, controls).catch(() => { /* medlem utan metaläsning */ });
  } catch (e) {
    wrap.innerHTML = `<div class="empty"><h3>Kunde inte ladda</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }
  if (!wrap.isConnected) return;
  setTopbarCompetition(cid, comp, user);

  const isAdmin = isCompAdminUser(comp, user);
  const bockar = lasBockar(cid);
  const antalKontroller = controls.length;
  const antalPatruller = patrols.length;

  // Varje post: vad det är, varför det behövs, hur många papper det blir, och
  // knappen. `saknas` gör posten dämpad med en förklaring i stället för en
  // knapp som ger en tom PDF.
  const poster = [
    {
      id: 'faltkort',
      titel: 'Kontrollernas pärmar (fältkorten)',
      varfor: 'En fil med varje kontrolls kompletta paket: placering med karta och QR, instruktioner, nödinfo och reservprotokoll. Skrivs ut dubbelsidigt och rivs isär — varje kontroll börjar på en udda sida.',
      antal: antalKontroller ? `${antalKontroller} kontroller` : null,
      saknas: antalKontroller ? null : 'Inga kontroller upplagda än.',
      knapp: 'Ladda ner fältkorten',
      kor: (btn) => {
        const label = btn.querySelector('.busy-label') || btn;
        return downloadFieldPackPdf(comp, controls, patrols, internalManagement(comp), {
          track,
          onProgress: (i, n) => { label.textContent = `Kontroll ${i} av ${n}…`; }
        });
      }
    },
    {
      id: 'startkort',
      titel: 'Startkort på papper',
      varfor: 'A4 liggande som viks till A5: hela kartan på ena sidan, information och poängkort på den andra. För patruller utan mobil — och som reserv när ett batteri tar slut.',
      antal: antalPatruller ? `${antalPatruller} patruller` : null,
      saknas: antalPatruller ? null : 'Inga patruller upplagda än.',
      knapp: 'Alla patrullers startkort',
      kor: () => downloadManualStartPdf(comp, patrols, controls, track, compPlaces(comp))
    },
    {
      id: 'reservkort',
      titel: 'Tomma reservstartkort',
      varfor: 'Samma kort men utan patrull: namn, kår och starttid blir skrivrader. Ta med några — det dyker alltid upp en patrull som inte står i listan.',
      antal: '5 blanka',
      saknas: null,
      knapp: 'Fem blanka kort',
      kor: () => downloadManualStartPdf(comp, 5, controls, track, compPlaces(comp))
    },
    {
      id: 'resultat',
      titel: 'Resultatlista till prisutdelningen',
      varfor: 'Skrivs ut EFTER tävlingen, när alla poäng är inne. Ligger här så ni vet att den finns — skriv inte ut den i förväg.',
      antal: null,
      saknas: null,
      efterat: true,
      knapp: 'Ladda ner resultatlistan',
      kor: async () => {
        const [scores, regs] = await Promise.all([
          listAllScores(cid, controls), listRegistrations(cid).catch(() => null)
        ]);
        return downloadResultsPdf(attachTrackStats(comp, controls, track), patrols, controls, scores, regs);
      }
    }
  ];

  wrap.innerHTML = `
    ${compHeader(cid, comp, user, {
      active: 'utskrifter', crumb: 'Utskrifter',
      titleHtml: `Inför tävlingsdagen ${help('utskrift.oversikt')}`,
      subtitle: 'Allt som ska tryckas, på ett ställe. Bocka av när högen ligger i lådan — markeringen sparas i den här webbläsaren och är till för dig som packar, inte för systemet.'
    })}

    ${!isAdmin ? '<div class="notice">Du kan ladda ner, men bara tävlingens admin kan ändra underlagen.</div>' : ''}

    <div class="utskrift-lista">
      ${poster.map(p => `
        <div class="card utskrift-post ${bockar.has(p.id) ? 'is-klar' : ''} ${p.saknas ? 'is-saknas' : ''}" data-post="${p.id}">
          <label class="utskrift-bock">
            <input type="checkbox" data-bock="${p.id}" ${bockar.has(p.id) ? 'checked' : ''}
              aria-label="Markera ${escapeHtml(p.titel)} som utskriven">
          </label>
          <div class="utskrift-kropp">
            <h3>${escapeHtml(p.titel)}${p.efterat ? ' <span class="badge">Efter tävlingen</span>' : ''}</h3>
            <p class="muted t-sm">${escapeHtml(p.varfor)}</p>
            ${p.antal ? `<div class="t-sm mono utskrift-antal">${escapeHtml(p.antal)}</div>` : ''}
          </div>
          <div class="utskrift-knapp">
            ${p.saknas
              ? `<span class="muted t-sm">${escapeHtml(p.saknas)}</span>`
              : `<button class="btn btn-secondary" data-kor="${p.id}">${icon('download', { size: 15 })} ${escapeHtml(p.knapp)}</button>`}
          </div>
        </div>
      `).join('')}
    </div>

    <div class="card" style="margin-top:var(--sp-5);" id="genrep-kort"></div>

    <div class="card" style="margin-top:var(--sp-5);">
      <h3>Innan ni lämnar sekretariatet</h3>
      <p class="muted t-sm">Det här står inte i någon PDF, men det är det man ångrar att man glömde.</p>
      <ul class="utskrift-checklista">
        ${[
          'Pennor i varje kontrollpärm — reservprotokollet är värdelöst utan penna.',
          'Powerbank till kontrollerna som ligger längst ut. Rapportsidan håller skärmen tänd hela dagen.',
          'Tävlingsledningens telefonnummer uppskrivet på papper, inte bara i mobilen.',
          'En utskriven karta till sekretariatet, för att kunna peka när någon ringer.',
          'Kontrollera att kontrollernas nödinfo faktiskt har telefonnummer — se förkontrollen på Översikt.'
        ].map((t, i) => `
          <li><label><input type="checkbox" data-bock="fys-${i}" ${bockar.has('fys-' + i) ? 'checked' : ''}>
            <span>${escapeHtml(t)}</span></label></li>`).join('')}
      </ul>
    </div>
  `;

  // Genrepet. En förstagångsarrangör kan inte bevisa att kedjan rapport →
  // sekretariat → poängtabell fungerar på SIN bana förrän tävlingsdagen.
  // Genrepspatrullen är en RIKTIG patrull just därför: den går genom exakt
  // samma kod, regler och vyer som en skarp, så ett genrep som fungerar bevisar
  // något. Priset är att den måste gå att städa bort — därav knappen.
  function ritaGenrep() {
    const host = wrap.querySelector('#genrep-kort');
    if (!host) return;
    const g = patrols.find(p => p.genrep);
    host.innerHTML = `
      <h3>${icon('target', { size: 16 })} Genrep</h3>
      <p class="muted t-sm" style="margin:6px 0 10px;">
        Provkör hela kedjan kvällen före: lägg upp en testpatrull, rapportera den från en
        kontrolls QR-kod och se att den dyker upp i Läget och poängtabellen. Patrullen är
        på riktigt — det är enda sättet att bevisa att det fungerar.
      </p>
      ${g ? `
        <div class="notice" style="border-left:3px solid var(--avent-orange);">
          <strong>Genrep pågår.</strong> ${escapeHtml(GENREP_NAMN)} ligger bland patrullerna och
          syns i Läget och poängtabellen. <strong>Rensa den innan tävlingsdagen</strong> — annars
          står den i resultatlistan.
        </div>
        <div class="btn-row mt-3">
          <a class="btn btn-secondary btn-sm" href="/s/${escapeHtml(comp.slug || cid)}/${escapeHtml(g.id)}" target="_blank" rel="noopener">
            ${icon('external', { size: 14 })} Öppna genrepets startkort</a>
          <button class="btn btn-danger btn-sm" id="genrep-rensa">Rensa genrepet</button>
        </div>`
        : `<div class="btn-row"><button class="btn btn-secondary" id="genrep-start">Starta genrep</button></div>`}
    `;

    host.querySelector('#genrep-start')?.addEventListener('click', (e) => withBusy(e.currentTarget, 'Skapar…', async () => {
      try {
        await skapaGenrepPatrull(cid);
        patrols = await listPatrols(cid);
        ritaGenrep();
        toast('Genrepspatrullen är upplagd — rapportera den från en kontroll', 'success');
      } catch (err) { toast('Kunde inte starta genrep: ' + (err?.message || err), 'error'); }
    }));

    host.querySelector('#genrep-rensa')?.addEventListener('click', (e) => withBusy(e.currentTarget, 'Rensar…', async () => {
      const ok = await confirmDialog(
        'Ta bort genrepspatrullen och allt den rapporterat? Riktiga patruller och deras poäng rörs inte.',
        { okLabel: 'Rensa genrepet', danger: true });
      if (!ok) return;
      try {
        const res = await rensaGenrep(cid);
        patrols = await listPatrols(cid);
        ritaGenrep();
        toast(`Genrepet rensat — ${res.patruller} patrull och ${res.poang} rapport${res.poang === 1 ? '' : 'er'} borttagna`, 'success');
      } catch (err) { toast('Kunde inte rensa: ' + (err?.message || err), 'error'); }
    }));
  }
  ritaGenrep();

  // Nedladdningarna — samma funktioner som de ursprungliga flikarna anropar.
  wrap.querySelectorAll('[data-kor]').forEach(btn => {
    const post = poster.find(p => p.id === btn.dataset.kor);
    btn.addEventListener('click', () => withBusy(btn, 'Skapar…', async () => {
      try {
        await post.kor(btn);
        // Bocka av automatiskt: den som just laddat ner har gjort momentet.
        const b = lasBockar(cid); b.add(post.id); sparaBockar(cid, b);
        wrap.querySelector(`[data-bock="${post.id}"]`).checked = true;
        wrap.querySelector(`[data-post="${post.id}"]`)?.classList.add('is-klar');
      } catch (e) {
        toast('Kunde inte skapa PDF:en: ' + (e?.message || e), 'error');
      }
    }));
  });

  wrap.querySelectorAll('[data-bock]').forEach(cb => {
    cb.addEventListener('change', () => {
      const b = lasBockar(cid);
      if (cb.checked) b.add(cb.dataset.bock); else b.delete(cb.dataset.bock);
      sparaBockar(cid, b);
      wrap.querySelector(`[data-post="${cb.dataset.bock}"]`)?.classList.toggle('is-klar', cb.checked);
    });
  });
}
