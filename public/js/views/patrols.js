import { layout, setTopbarCompetition, registerViewCleanup } from '../app.js';
import {
  getCompetition, watchCompetition, watchPatrols, createPatrol, updatePatrol, flyttaTillPapperskorg,
  sparaStartlista, loggHandelse, getPatrolMeta, migratePatrolMeta, listControls, getTrack, ensureThreadToken,
  listStations, createStation, watchPassages, watchSelfPassages, setPassage, clearSelfPassage
} from '../store.js';
import {
  allowedAvdelningar, escapeHtml, toast, confirmDialog, withBusy, startUrl,
  copyToClipboard, patrolStartTime, startTimeSettings, effectiveIntervalSec,
  wireOverlayClose, isCompAdminUser,
  startlistaPublik, antalStartplatser, startlistaLuckor, startlistaLuckorSparade, starttidsAndringar,
  startlistaLuft, startlistaLuftSparad, planLaggInLuft, planLuftVarN, startskarmsSchema, paStartskarmen
} from '../utils.js';
import { renderQrToImg, downloadStartPdf, downloadManualStartPdf } from '../pdf.js';
import { icon } from '../icons.js';
import { help, helpOnButton } from '../help.js';
import { compPlaces } from '../places.js';
import { compHeader, compLabel, setDocTitle } from '../nav.js';

let unsub = null;
let unsubComp = null;
let unsubStart = [];
let tidTick = null;
let sortableInstance = null;

// Lazy-load SortableJS on first use (touch + desktop drag-reorder).
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

export async function renderPatrols(app, user, cid) {
  if (unsub) { unsub(); unsub = null; }
  unsubStart.forEach(u => { try { u(); } catch { /* redan stängd */ } }); unsubStart = [];
  clearInterval(tidTick); tidTick = null;
  if (sortableInstance) { sortableInstance.destroy(); sortableInstance = null; }

  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="muted">Laddar…</div>`;
  layout(wrap);

  let comp = await getCompetition(cid).catch(() => null);
  if (!wrap.isConnected) return; // navigated away while loading
  if (!comp) { wrap.innerHTML = `<div class="empty"><h3>Tävlingen hittades inte</h3></div>`; return; }
  setTopbarCompetition(cid, comp, user);
  const isAdmin = isCompAdminUser(comp, user);
  let st = startTimeSettings(comp);
  // Publicerad startlista: kårerna har bokat resor efter tiderna. Varje
  // ändring som flyttar någon annans starttid varnas — se genomforStartlista.
  let publik = startlistaPublik(comp);

  let state = {
    rows: [],
    filter: 'alla',
    sort: st.enabled ? 'startOrder' : 'number',
    dir: 1,
    q: ''
  };

  setDocTitle('Patruller', compLabel(comp));
  wrap.innerHTML = `
    ${compHeader(cid, comp, user, {
      active: 'patrols', title: 'Patruller',
      subtitleHtml: st.enabled ? `<span id="st-header">Starttid från ${escapeHtml(st.firstStart)} · ${st.intervalMinutes} min intervall</span>` : '',
      actions: `
        <a class="btn btn-ghost btn-sm" href="/s/${encodeURIComponent(comp.slug || cid)}/test" target="_blank" rel="noopener">${icon('external', { size: 14 })} Testa startkort</a>
        ${isAdmin ? helpOnButton(
          `<button class="btn btn-secondary btn-sm" id="manual-all">${icon('file-text', { size: 14 })} Manuella startkort</button>`,
          'comp.manualStartkort') : ''}
        ${isAdmin ? '<button class="btn btn-primary" id="new">+ Ny patrull</button>' : ''}`
    })}

    <div class="scoreboard-controls">
      <input class="input" id="q" placeholder="Sök namn, kår, nummer…" style="max-width:260px;">
      <select class="select" id="avd" style="max-width:200px;">
        <option value="alla">Alla avdelningar</option>
        ${allowedAvdelningar(comp).map(a => `<option value="${a.key}">${a.key}</option>`).join('')}
      </select>
      ${st.enabled && isAdmin ? helpOnButton(
        `<button class="btn btn-secondary btn-sm" id="luft">${icon('clock', { size: 14 })} Lägg in luft…</button>`,
        'patrol.luft') : ''}
      ${st.enabled && isAdmin ? `<span class="muted t-sm" id="drag-hint">Dra patruller för att ändra starttid · släpp intill en lucka så tar patrullen luckan</span>` : ''}
    </div>

    <div id="startlista-banner"></div>
    <div id="tbl"></div>
  `;

  // --- Startstatus ---------------------------------------------------------
  // Två källor, samma företräde som Läget: funktionärens avprickning på
  // start/mål-stationen före patrullens egen bekräftelse. Den PLANERADE tiden
  // är ingen start — hela poängen med kolumnen är att någon sett patrullen gå.
  let station = null;
  let stationPass = {};   // patrolId -> { startAt, finishAt }
  let selfPass = {};      // patrolId -> { startAt, finishAt }
  // Startstatusen kommer i egna snapshots. De får varken rita en tom lista
  // innan patrullerna lästs, eller rita om tabellen mitt i ett drag — då
  // förstörs Sortable och patrullen släpps ingenstans.
  let harPatruller = false;
  let drar = false;
  let ritaEfterDrag = false;
  const ritaOmStatus = () => {
    if (!harPatruller) return;
    if (drar) { ritaEfterDrag = true; return; }
    render();
  };

  const lyssnaPaStation = () => {
    if (!station) return;
    unsubStart.push(watchPassages(cid, station.id, rows => {
      stationPass = {}; rows.forEach(p => { stationPass[p.id] = p; });
      ritaOmStatus();
    }));
  };

  const vaxlaStart = async (pid, knapp) => {
    const row = state.rows.find(r => r.id === pid);
    if (!row) return;
    // Demospåret nekar varje skrivning — svara med en demotext, aldrig ett rättighetsfel.
    if (comp.demo) { toast('Demospår — inget sparas. I en riktig tävling stämplas starten här.'); return; }
    const nu = startInfo(pid);
    try {
      if (!nu) {
        if (!station) {
          // Stationen skapas annars från Läget. Titta efter en FÄRSK först:
          // en kollega kan ha skapat den sedan sidan laddades, och två
          // stationer delar avprickningarna mellan sig.
          station = (await listStations(cid))[0] || null;
          if (!station) {
            if (!isAdmin) { toast('Ingen start/mål-station finns ännu — be en administratör skapa den under Läget.', 'error'); return; }
            station = { id: await createStation(cid) };
          }
          lyssnaPaStation();
        }
        knapp.disabled = true;
        await setPassage(cid, station.id, pid, 'startAt', true);
        return;
      }
      const vem = namnet(row);
      const text = nu.kalla === 'sjalv'
        ? `Ångra starten för ${vem}?\n\nPatrullen bekräftade själv starten ${klockslag(nu.at)} på sitt startkort. Tiden tas bort och går inte att få tillbaka — patrullen kan bekräfta på nytt.`
        : `Ångra starten för ${vem}?\n\nDen uppmätta starttiden ${klockslag(nu.at)} tas bort och går inte att få tillbaka.`;
      if (!await confirmDialog(text, { okLabel: 'Ångra starten', danger: true })) return;
      if (nu.kalla === 'sjalv') await clearSelfPassage(cid, pid, 'startAt');
      else await setPassage(cid, station.id, pid, 'startAt', false);
    } catch (e) {
      toast('Kunde inte spara: ' + e.message, 'error');
      render();
    }
  };

  // --- Tidsläget: vem står på startskärmen, vilka har gått ------------------
  // Härleds ur klockan med SAMMA fönster som startskärmen (utils.js). Sätts som
  // klasser på raderna i stället för en omritning: tabellen ritas inte om var
  // femte sekund, för då dör ett pågående drag.
  //   pa-startskarmen  fönstret innehåller nu
  //   har-gatt         startat, ELLER tiden har gått i en tävling där ingen
  //                    prickar av starter (då är klockan det enda vi har)
  //   start-missad     tiden har gått men patrullen är inte avprickad, i en
  //                    tävling där starter FAKTISKT prickas av — den raden ska
  //                    synas, inte gråna: det är patrullen som missade sin start
  const uppdateraTidslage = () => {
    const body = wrap.querySelector('#patrol-body');
    if (!body) return;
    const now = new Date();
    const schema = st.enabled ? startskarmsSchema(comp, state.rows, now) : [];
    const aktiv = paStartskarmen(schema, now)?.patrol?.id || null;
    const perId = new Map(schema.map(e => [e.patrol.id, e]));
    const prickas = state.rows.some(r => startInfo(r.id));
    body.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;
      const e = perId.get(id);
      const startat = !!startInfo(id);
      const forbi = !!e && now > e.windowEnd;
      const utgatt = !!state.rows.find(r => r.id === id)?.utgatt;
      tr.classList.toggle('pa-startskarmen', id === aktiv);
      tr.classList.toggle('har-gatt', id !== aktiv && (startat || utgatt || (forbi && !prickas)));
      tr.classList.toggle('start-missad', id !== aktiv && forbi && !startat && !utgatt && prickas);
    });
  };

  // Platsvyn: hela listan i startordning, plats för plats, med luckorna som
  // egna rader. Patruller utan startordning sist.
  const platsRader = (rows, platser) => {
    const perPlats = new Map(); const utan = [];
    for (const r of rows) {
      const o = Number(r.startOrder);
      if (Number.isFinite(o)) { if (!perPlats.has(o)) perPlats.set(o, []); perPlats.get(o).push(r); }
      else utan.push(r);
    }
    const ut = [];
    for (let i = 0; i < platser; i++) {
      const har = perPlats.get(i);
      if (har) har.forEach(r => ut.push({ typ: 'patrull', r }));
      else ut.push({ typ: 'lucka', plats: i });
    }
    utan.forEach(r => ut.push({ typ: 'patrull', r }));
    return ut;
  };

  // Startat / ej startat. Ett klick på "Ej startat" stämplar starten NU — samma
  // avprickning som startfunktionären gör på stationssidan, så Läget,
  // stationen och den här listan alltid säger samma sak. Att ÅNGRA kräver en
  // bekräftelse: då försvinner en uppmätt tid, och den går inte att få tillbaka.
  const startInfo = (pid) => {
    const f = stationPass[pid]?.startAt, sj = selfPass[pid]?.startAt;
    const d = (v) => (v?.toDate ? v.toDate() : v ? new Date(v) : null);
    if (f) return { at: d(f), kalla: 'funktionar' };
    if (sj) return { at: d(sj), kalla: 'sjalv' };
    return null;
  };
  const klockslag = (d) => (d && Number.isFinite(d.getTime())
    ? d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }) : '');
  const statusCell = (r) => {
    const s = startInfo(r.id);
    if (r.utgatt) return `<span class="start-pill start-pill-utgatt">Utgått</span>`;
    const text = s
      ? `${icon('check', { size: 14 })} Startat ${escapeHtml(klockslag(s.at))}${s.kalla === 'sjalv' ? ' <span class="start-kalla">· själv</span>' : ''}`
      : 'Ej startat';
    const titel = s
      ? (s.kalla === 'sjalv' ? 'Patrullen bekräftade starten själv på sitt startkort. Klicka för att ångra.' : 'Klicka för att ångra starten.')
      : 'Klicka när patrullen har gått — starten stämplas med klockslaget nu.';
    return `<button type="button" class="start-pill ${s ? 'start-pill-ja' : 'start-pill-nej'}" data-startat="${r.id}"
      aria-pressed="${s ? 'true' : 'false'}" title="${escapeHtml(titel)}">${text}</button>`;
  };

  const patrullRad = (r, platser, dragEnabled) => {
    const t = patrolStartTime(comp, r, platser);
    return `<tr data-id="${r.id}"${startInfo(r.id) ? ' class="har-startat"' : ''}>
      ${dragEnabled ? `<td class="drag-col" aria-label="Dra för att ändra ordning">${icon('grip-vertical', { size: 18, class: 'drag-handle' })}</td>` : ''}
      ${st.enabled ? `<td class="num time-col">${t ?? '<span class="muted">—</span>'}</td>` : ''}
      <td class="status-col">${statusCell(r)}</td>
      <td class="num">${escapeHtml(String(r.number ?? ''))}</td>
      <td><strong>${escapeHtml(r.name || '—')}</strong> <span class="badge badge-blue pa-skarm-badge">${icon('monitor', { size: 12 })} På startskärmen</span></td>
      <td><span class="dot ${shortOf(r.avdelning)}"></span>${escapeHtml(r.avdelning || '')}</td>
      <td>${escapeHtml(r.kar || '')}</td>
      <td class="num">${escapeHtml(String(r.antal ?? ''))}</td>
      <td class="muted">${escapeHtml((r.notering || '').slice(0, 60))}</td>
      ${isAdmin ? `<td class="actions">
        <a class="btn btn-ghost btn-sm" href="/app/c/${cid}/meddelanden?patrull=${encodeURIComponent(r.id)}" data-link
           title="Skicka meddelande till den här patrullen" aria-label="Skicka meddelande till patrull ${r.number ?? ''}">${icon('send', { size: 15 })}</a>
        <button class="btn btn-secondary btn-sm" data-start="${r.id}">Startkort</button>
        <button class="btn btn-ghost btn-sm" data-edit="${r.id}">Redigera</button>
        <button class="btn btn-ghost btn-sm" data-del="${r.id}" style="color:var(--utm-pink);">Ta bort</button>
      </td>` : ''}
    </tr>`;
  };

  // En lucka är en tom starttid — en rad, så hålet syns i stället för att de
  // andra tyst flyttas upp. Går att fylla (drag eller knapp) eller ta bort.
  const luckaRad = (plats, platser, kolumner, dragEnabled, arLuft) => {
    const t = patrolStartTime(comp, { startOrder: plats }, platser) || '—';
    return `<tr class="start-lucka${arLuft ? ' start-luft' : ''}" data-lucka="${plats}"${arLuft ? ' data-luft="1"' : ''}>
      ${dragEnabled ? '<td class="drag-col"></td>' : ''}
      <td class="num time-col">${escapeHtml(t)}</td>
      <td colspan="${kolumner}" class="lucka-cell">
        <span class="lucka-text">${icon('clock', { size: 14 })} ${arLuft
          ? `Luft i schemat — ${escapeHtml(t)} hålls tom med flit`
          : `Lucka — ingen patrull startar ${escapeHtml(t)}`}</span>
        ${isAdmin ? `<button class="btn btn-ghost btn-sm" data-fyll="${plats}">${arLuft ? 'Flytta hit en patrull…' : 'Fyll luckan…'}</button>
        <button class="btn btn-ghost btn-sm" data-ta-bort-lucka="${plats}">${arLuft ? 'Ta bort luften' : 'Ta bort luckan'}</button>` : ''}
      </td>
    </tr>`;
  };

  const ritaBanner = () => {
    const host = wrap.querySelector('#startlista-banner');
    if (!host) return;
    if (!publik) { host.innerHTML = ''; return; }
    const luckor = startlistaLuckor(comp, state.rows);
    host.innerHTML = `<div class="startlista-banner" role="status">
      ${icon('triangle-alert', { size: 20 })}
      <div>
        <strong>Startlistan är publicerad ${help('patrol.startlista')}</strong>
        <span>Kårerna planerar resor efter tiderna. En ändring som flyttar någon annans starttid varnas först, och en borttagen patrull lämnar en lucka i stället för att flytta de andra.${luckor.length ? ` Just nu ${luckor.length === 1 ? 'en lucka' : luckor.length + ' luckor'} — dra en patrull dit eller ta bort luckan.` : ''}</span>
      </div>
    </div>`;
  };

  const render = () => {
    if (sortableInstance) { sortableInstance.destroy(); sortableInstance = null; }
    ritaBanner();
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

    // Bara i platsvyn går det att dra: i en filtrerad eller omsorterad lista
    // säger radföljden inget om platserna.
    const platsVy = st.enabled && !isFiltering && state.sort === 'startOrder' && state.dir === 1;
    const dragEnabled = isAdmin && platsVy;
    const platser = antalStartplatser(comp, state.rows);
    const radlista = platsVy ? platsRader(rows, platser) : rows.map(r => ({ typ: 'patrull', r }));

    const tbl = wrap.querySelector('#tbl');
    if (!rows.length) {
      tbl.innerHTML = `<div class="empty">
        <h3>Inga patruller</h3>
        <p>${isAdmin ? 'Klicka "Ny patrull" för att lägga till.' : 'Inga patruller har lagts till än.'}</p>
      </div>`;
      return;
    }
    const kolumner = 7 + (isAdmin ? 1 : 0);
    const luft = new Set(startlistaLuft(comp, state.rows));
    tbl.innerHTML = `
      <div class="table-wrap">
        <table class="t">
          <thead>
            <tr>
              ${dragEnabled ? '<th style="width:36px;"></th>' : ''}
              ${st.enabled ? th('startOrder', 'Start', state, { num: true, help: 'patrol.startOrder' }) : ''}
              <th>Status ${help('patrol.startat')}</th>
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
            ${radlista.map(rad => rad.typ === 'lucka'
              ? luckaRad(rad.plats, platser, kolumner, dragEnabled, luft.has(rad.plats))
              : patrullRad(rad.r, platser, dragEnabled)).join('')}
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
    tbl.querySelectorAll('[data-startat]').forEach(b => b.addEventListener('click', () => vaxlaStart(b.dataset.startat, b)));
    uppdateraTidslage();
    if (isAdmin) {
      tbl.querySelectorAll('[data-edit]').forEach(b => {
        b.addEventListener('click', () => {
          const row = state.rows.find(r => r.id === b.dataset.edit);
          openPatrolModal(cid, comp, row, null, onPatrolSaved);
        });
      });
      tbl.querySelectorAll('[data-start]').forEach(b => {
        b.addEventListener('click', () => {
          const row = state.rows.find(r => r.id === b.dataset.start);
          openStartCardModal(cid, row, st.enabled);
        });
      });
      tbl.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => taBortPatrull(b.dataset.del)));
      tbl.querySelectorAll('[data-fyll]').forEach(b => b.addEventListener('click', () => openFyllLuckaModal(Number(b.dataset.fyll))));
      tbl.querySelectorAll('[data-ta-bort-lucka]').forEach(b => b.addEventListener('click', () => taBortLucka(Number(b.dataset.taBortLucka))));
    }

    if (dragEnabled) {
      const body = tbl.querySelector('#patrol-body');
      ensureSortable().then(Sortable => {
        if (!body.isConnected) return;
        sortableInstance = new Sortable(body, {
          handle: '.drag-col',
          filter: '.start-lucka',        // luckor dras inte — men går att släppa intill
          preventOnFilter: false,        // annars dör knapparna i luckraden på touch
          animation: 150,
          ghostClass: 'drag-ghost',
          chosenClass: 'drag-chosen',
          forceFallback: true,      // nicer cross-browser feedback; also fixes touch
          fallbackTolerance: 5,
          onStart: () => { drar = true; },
          onEnd: async (evt) => {
            drar = false;
            await draSlappt(evt, body);
            if (ritaEfterDrag) { ritaEfterDrag = false; render(); }
          }
        });
      });
    }
  };

  // Släppt intill en lucka = patrullen tar luckan och lämnar sin gamla plats
  // tom. Annars en vanlig ordningsändring: raderna i tabellen, luckor
  // inräknade, blir platserna 0, 1, 2 … (så en lucka mitt i listan består).
  const draSlappt = async (evt, body) => {
    const id = evt.item?.dataset?.id;
    const patrull = state.rows.find(r => r.id === id);
    if (!patrull || evt.oldIndex === evt.newIndex) { render(); return; }
    const granne = [evt.item.previousElementSibling, evt.item.nextElementSibling]
      .find(el => el?.dataset?.lucka != null);
    const plan = granne ? planFyllLucka(patrull, Number(granne.dataset.lucka)) : planFranRader(body);
    await genomforStartlista(plan, { flyttad: patrull, handling: 'Startordning ändrad' });
  };

  const planFyllLucka = (patrull, plats) => {
    const gammal = Number(patrull.startOrder);
    const luckor = startlistaLuckorSparade(comp).filter(l => l !== plats);
    if (Number.isFinite(gammal)) luckor.push(gammal);
    // Den fyllda platsen är inte luft längre; den LÄMNADE platsen är en vanlig
    // lucka, inte luft — ingen har valt att hålla den tom.
    return { tilldelning: [{ id: patrull.id, startOrder: plats }], luckor,
      luft: startlistaLuftSparad(comp).filter(l => l !== plats) };
  };

  const planFranRader = (body) => {
    const tilldelning = []; const luckor = []; const luft = [];
    [...body.children].forEach((tr, i) => {
      if (tr.dataset.id) {
        const r = state.rows.find(x => x.id === tr.dataset.id);
        if (r && Number(r.startOrder) !== i) tilldelning.push({ id: r.id, startOrder: i });
      } else if (tr.dataset.lucka != null) { luckor.push(i); if (tr.dataset.luft) luft.push(i); }
    });
    return { tilldelning, luckor, luft };
  };

  const sammaLuckor = (luckor, luft) => {
    const norm = (a) => [...new Set(a)].sort((x, y) => x - y).join(',');
    return norm(luckor) === norm(startlistaLuckorSparade(comp))
      && (luft === undefined || norm(luft) === norm(startlistaLuftSparad(comp)));
  };

  const namnet = (p) => `${p.name || 'Patrull'}${p.kar ? ' (' + p.kar + ')' : ''}`;
  const andringsrad = (a) => `${namnet(a.patrol)}: ${a.fran ?? '—'} → ${a.till ?? '—'}`;

  // EN väg för varje ändring av startlistan: räkna ut vilka som får ny tid,
  // varna om listan är publicerad, skriv, logga. `flyttad` är den patrull
  // användaren själv flyttade — dess egen tidsändring är avsikten, alla
  // andras är bieffekten som varningen räknar upp.
  const genomforStartlista = async (plan, { flyttad = null, handling = 'Startlista' } = {}) => {
    const efterPatrols = state.rows.map(r => {
      const t = plan.tilldelning.find(x => x.id === r.id);
      return t ? { ...r, startOrder: t.startOrder } : r;
    });
    const efterComp = { ...comp, startTimes: { ...(comp.startTimes || {}), luckor: plan.luckor } };
    // I tidsordning: den som läser varningen letar efter klockslag, och
    // starttidsAndringar ger dem i dokumentordning.
    const andringar = starttidsAndringar({ comp, patrols: state.rows }, { comp: efterComp, patrols: efterPatrols })
      .sort((a, b) => String(a.fran ?? '').localeCompare(String(b.fran ?? '')));
    if (!plan.tilldelning.length && sammaLuckor(plan.luckor, plan.luft)) { render(); return false; }
    if (publik) {
      const andra = andringar.filter(a => a.patrol.id !== flyttad?.id);
      const egen = andringar.find(a => a.patrol.id === flyttad?.id);
      let text = null, okLabel = 'Fortsätt';
      if (andra.length) {
        text = `STARTLISTAN ÄR PUBLICERAD.\n\nKårerna planerar resor efter tiderna. Den här ändringen flyttar starttiden för ${andra.length} ${andra.length === 1 ? 'annan patrull' : 'andra patruller'}:\n\n${andra.slice(0, 12).map(andringsrad).join('\n')}${andra.length > 12 ? `\n… och ${andra.length - 12} till` : ''}\n\nDet bör inte göras nu utan att kårerna får veta. Fortsätt ändå?`;
        okLabel = 'Ja, flytta starttiderna';
      } else if (egen) {
        text = `Startlistan är publicerad.\n\n${andringsrad(egen)}\n\nIngen annan patrulls starttid ändras. Fortsätt?`;
        okLabel = 'Flytta patrullen';
      }
      if (text && !await confirmDialog(text, { okLabel, danger: andra.length > 0 })) { render(); return false; }
    }
    try {
      await sparaStartlista(cid, plan.tilldelning, plan.luckor, plan.luft);
      if (publik && andringar.length) {
        loggHandelse(cid, { vad: 'startlista', av: user?.email || '',
          text: `${handling} i publicerad startlista: ${andringar.slice(0, 8).map(andringsrad).join('; ')}${andringar.length > 8 ? ` … +${andringar.length - 8}` : ''}` });
      }
      toast('Startordning sparad', 'success');
      return true;
    } catch (e) {
      toast('Kunde inte spara: ' + e.message, 'error');
      render();
      return false;
    }
  };

  // Borttagning lämnar ALLTID en lucka — de andras tider rörs inte. Är listan
  // publicerad säger dialogen det skarpt; annars bara att luckan uppstår.
  const taBortPatrull = async (id) => {
    const row = state.rows.find(r => r.id === id);
    if (!row) return;
    const plats = Number(row.startOrder);
    const tid = Number.isFinite(plats) ? patrolStartTime(comp, row, antalStartplatser(comp, state.rows)) : null;
    const text = publik && tid
      ? `STARTLISTAN ÄR PUBLICERAD.\n\nKårerna planerar resor efter tiderna. "${namnet(row)}" flyttas till papperskorgen och starttiden ${tid} blir en tom lucka — ingen annan patrulls starttid ändras. Luckan går att fylla genom att dra en annan patrull dit.\n\nFortsätt?`
      : `Flytta patrull "${row.name || ''}" till papperskorgen? Poängen följer med och går att återställa tills tävlingen avslutas.${tid ? ` Starttiden ${tid} blir en lucka.` : ''}`;
    if (!await confirmDialog(text, { okLabel: 'Flytta till papperskorgen', danger: true })) return;
    try {
      await flyttaTillPapperskorg(cid, 'patrull', row.id);
      if (Number.isFinite(plats)) await sparaStartlista(cid, [], [...startlistaLuckorSparade(comp), plats]);
      if (publik && tid) {
        loggHandelse(cid, { vad: 'startlista', av: user?.email || '',
          text: `Patrull borttagen ur publicerad startlista: ${namnet(row)}, ${tid} blev en lucka` });
      }
      toast('Flyttad till papperskorgen — går att återställa under Inställningar');
    } catch (e) { toast(e.message, 'error'); }
  };

  // Tar bort luckan: allt efter platsen flyttas ett steg tidigare. Det ÄR en
  // ändring av andras tider — en publicerad lista varnar med namnen.
  const taBortLucka = async (plats) => {
    const tilldelning = state.rows
      .filter(r => Number.isFinite(Number(r.startOrder)) && Number(r.startOrder) > plats)
      .map(r => ({ id: r.id, startOrder: Number(r.startOrder) - 1 }));
    const kvar = (arr) => arr.filter(l => l !== plats).map(l => l > plats ? l - 1 : l);
    await genomforStartlista({ tilldelning, luckor: kvar(startlistaLuckorSparade(comp)), luft: kvar(startlistaLuftSparad(comp)) },
      { handling: 'Lucka borttagen' });
  };

  const openFyllLuckaModal = (plats) => {
    const platser = antalStartplatser(comp, state.rows);
    const tid = patrolStartTime(comp, { startOrder: plats }, platser) || '';
    const kandidater = [...state.rows].sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:480px;">
        <div class="modal-head"><h3>Fyll luckan ${escapeHtml(tid)}</h3><button class="icon-btn" id="x" aria-label="Stäng">${icon('x')}</button></div>
        <div class="modal-body">
          <p class="muted t-sm" style="margin-top:0;">Patrullen får starttiden ${escapeHtml(tid)}. Dess gamla plats blir en lucka.</p>
          <label class="field" for="fl-patrull">Patrull</label>
          <select class="select" id="fl-patrull">
            ${kandidater.map(r => `<option value="${r.id}">#${escapeHtml(String(r.number ?? ''))} ${escapeHtml(r.name || '')}${r.kar ? ' (' + escapeHtml(r.kar) + ')' : ''} — ${escapeHtml(patrolStartTime(comp, r, platser) || 'ingen starttid')}</option>`).join('')}
          </select>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" id="cancel">Avbryt</button>
          <button class="btn btn-primary" id="ok">Flytta hit</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    wireOverlayClose(overlay, close);
    overlay.querySelector('#x').onclick = close;
    overlay.querySelector('#cancel').onclick = close;
    overlay.querySelector('#ok').addEventListener('click', async () => {
      const patrull = state.rows.find(r => r.id === overlay.querySelector('#fl-patrull').value);
      close();
      if (patrull) await genomforStartlista(planFyllLucka(patrull, plats), { flyttad: patrull, handling: 'Lucka fylld' });
    });
  };

  // --- Luft i schemat -------------------------------------------------------
  // Två sätt: en tom plats på ETT ställe, eller efter var N:e patrull. Båda
  // flyttar allt som kommer efter, så de går genom genomforStartlista — en
  // publicerad lista varnar med namnen innan något skrivs.
  const openLuftModal = () => {
    const platser = antalStartplatser(comp, state.rows);
    const iOrdning = state.rows.filter(r => Number.isFinite(Number(r.startOrder)))
      .sort((a, b) => Number(a.startOrder) - Number(b.startOrder));
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:520px;">
        <div class="modal-head"><h3>Lägg in luft i schemat</h3><button class="icon-btn" id="x" aria-label="Stäng">${icon('x')}</button></div>
        <div class="modal-body">
          <p class="muted t-sm" style="margin-top:0;">Luft är en starttid som hålls tom med flit — att flytta in en patrull som missade sin start, eller en som kom för tidigt. Patrullerna efter luften startar ett intervall senare.${publik ? ' <strong>Startlistan är publicerad</strong>: du får se exakt vilka som får ny tid innan något sparas.' : ''}</p>
          <label class="luft-val"><input type="radio" name="luft-lage" value="var" checked>
            <span>Efter var <input class="input" id="luft-n" type="number" min="2" max="99" value="10" style="width:72px;display:inline-block;"> :e patrull</span></label>
          <p class="muted t-sm luft-hint" id="luft-var-hint"></p>
          <label class="luft-val"><input type="radio" name="luft-lage" value="en">
            <span>En tom plats före
              <select class="select" id="luft-fore" style="display:inline-block;width:auto;max-width:280px;">
                ${iOrdning.map(r => `<option value="${Number(r.startOrder)}">${escapeHtml(patrolStartTime(comp, r, platser) || '')} · #${escapeHtml(String(r.number ?? ''))} ${escapeHtml(r.name || '')}</option>`).join('')}
              </select></span></label>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" id="cancel">Avbryt</button>
          <button class="btn btn-primary" id="ok">Lägg in luft</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    wireOverlayClose(overlay, close);
    overlay.querySelector('#x').onclick = close;
    overlay.querySelector('#cancel').onclick = close;
    const nEl = overlay.querySelector('#luft-n');
    const hint = overlay.querySelector('#luft-var-hint');
    const visaHint = () => {
      const { nya } = planLuftVarN(comp, state.rows, nEl.value);
      hint.textContent = nya ? `Ger ${nya === 1 ? 'en ny tom plats' : nya + ' nya tomma platser'}. Tomma platser som redan finns räknas — verktyget lägger aldrig dubbel luft.`
        : 'Ger ingen ny luft — listan är för kort, eller så finns redan tomma platser på de ställena.';
    };
    nEl.addEventListener('input', () => { overlay.querySelector('input[value="var"]').checked = true; visaHint(); });
    overlay.querySelector('#luft-fore').addEventListener('change', () => { overlay.querySelector('input[value="en"]').checked = true; });
    visaHint();
    overlay.querySelector('#ok').addEventListener('click', async () => {
      const lage = overlay.querySelector('input[name="luft-lage"]:checked').value;
      const plan = lage === 'var' ? planLuftVarN(comp, state.rows, nEl.value)
        : planLaggInLuft(comp, state.rows, Number(overlay.querySelector('#luft-fore').value));
      close();
      if (lage === 'var' && !plan.nya) { toast('Ingen ny luft att lägga in'); return; }
      await genomforStartlista(plan, { handling: 'Luft inlagd' });
    });
  };

  wrap.querySelector('#luft')?.addEventListener('click', () => {
    if (!state.rows.some(r => Number.isFinite(Number(r.startOrder)))) { toast('Inga patruller har en startplats ännu'); return; }
    openLuftModal();
  });
  wrap.querySelector('#q').addEventListener('input', e => { state.q = e.target.value; render(); });
  wrap.querySelector('#avd').addEventListener('change', e => { state.filter = e.target.value; render(); });
  if (isAdmin) {
    wrap.querySelector('#new').addEventListener('click', () => openPatrolModal(cid, comp, null, { rows: state.rows, publik, user }, onPatrolSaved));
    wrap.querySelector('#manual-all').addEventListener('click',
      () => openManualPdfModal(cid, comp, state.rows));
  }

  registerViewCleanup(() => {
    if (unsub) { unsub(); unsub = null; }
    if (unsubComp) { unsubComp(); unsubComp = null; }
    unsubStart.forEach(u => { try { u(); } catch { /* redan stängd */ } }); unsubStart = [];
    clearInterval(tidTick); tidTick = null;
    if (sortableInstance) { sortableInstance.destroy(); sortableInstance = null; }
  });
  // notering lives in each patrol's member-only private/meta subdoc — merge it
  // in (cached) for the list column and the edit-modal pre-fill.
  const metaById = {};
  async function mergePatrolMeta(rows) {
    const missing = rows.filter(r => !(r.id in metaById));
    if (missing.length) {
      const metas = await Promise.all(missing.map(r => getPatrolMeta(cid, r.id).catch(() => ({}))));
      missing.forEach((r, i) => { metaById[r.id] = metas[i] || {}; });
    }
    rows.forEach(r => { r.notering = metaById[r.id]?.notering || ''; });
  }
  const onPatrolSaved = (id, data) => { metaById[id] = { notering: data.notering || '' }; };

  if (isAdmin && !comp.demo) await migratePatrolMeta(cid).catch(() => {});
  unsub = watchPatrols(cid, async rows => {
    await mergePatrolMeta(rows);
    state.rows = rows;
    harPatruller = true;
    // Refresh the header line so the computed interval text stays in sync
    // as patruller are added/removed in range mode.
    const header = wrap.querySelector('#st-header');
    if (header && st.enabled) {
      if (st.mode === 'range' && st.lastStart && rows.length >= 2) {
        const sec = effectiveIntervalSec(comp, antalStartplatser(comp, rows));
        const mins = (sec / 60).toFixed(sec % 60 ? 1 : 0);
        header.innerHTML = `Starttider ${escapeHtml(st.firstStart)} → ${escapeHtml(st.lastStart)} · ≈ ${mins} min mellan starter`;
      } else {
        header.innerHTML = `Starttid från ${escapeHtml(st.firstStart)} · ${st.intervalMinutes} min intervall`;
      }
    }
    render();
  });
  // Startstatusen. Stationslistan kräver medlemskap (eller demo) — misslyckas
  // läsningen står kolumnen på "Ej startat" och klicket säger vad som saknas.
  listStations(cid).then(lista => { station = lista[0] || null; lyssnaPaStation(); }).catch(() => {});
  unsubStart.push(watchSelfPassages(cid, rows => {
    selfPass = {}; rows.forEach(p => { selfPass[p.id] = p; });
    ritaOmStatus();
  }));
  clearInterval(tidTick);
  tidTick = setInterval(uppdateraTidslage, 5000);

  // Luckorna och publicerings-växeln bor på tävlingen — håll dem färska så
  // att en kollega som tar bort en patrull i en annan flik syns här direkt.
  unsubComp = watchCompetition(cid, c => {
    comp = { ...comp, ...c };
    st = startTimeSettings(comp);
    publik = startlistaPublik(comp);
    render();
  });
}

function th(key, label, state, opts = {}) {
  const arrow = state.sort === key ? (state.dir > 0 ? '▲' : '▼') : '';
  const cls = 'sortable' + (opts.num ? ' num' : '');
  // Hjälpknappen stoppar sitt eget klick (help.js), så den krockar inte med
  // kolumnsorteringen.
  return `<th class="${cls}" data-key="${key}">${escapeHtml(label)}${opts.help ? help(opts.help) : ''} <span class="arrow">${arrow}</span></th>`;
}

function shortOf(avd) {
  return { 'Spårare':'sp','Upptäckare':'up','Äventyrare':'av','Utmanare':'ut','Rover':'ro','Ledare':'le' }[avd] || 'le';
}

async function openStartCardModal(cid, patrol, startScreenAvailable = false) {
  if (!patrol) return;
  // Se control-detail.js: token mintas där länken byggs.
  if (!patrol.threadToken) {
    patrol.threadToken = await ensureThreadToken(cid, 'patrull', patrol.id).catch(() => '');
  }
  const url = startUrl(cid, patrol.id, patrol.threadToken);
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
          <button class="btn btn-primary" id="pdf">${icon('download', { size: 16 })} QR-blad (PDF)</button>
          <button class="btn btn-secondary" id="manual-pdf">${icon('file-text', { size: 16 })} Manuellt startkort</button>
          <a class="btn btn-ghost" href="${url}" target="_blank" rel="noopener">Öppna startkort</a>
          ${startScreenAvailable ? `<a class="btn btn-secondary" href="/app/c/${cid}/startscreen" target="_blank" rel="noopener">Startskärm</a>` : ''}
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="close">Stäng</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  wireOverlayClose(overlay, close);
  overlay.querySelector('#x').onclick = close;
  overlay.querySelector('#close').onclick = close;

  const qrHost = overlay.querySelector('#qr');
  renderQrToImg(url, 200)
    .then(img => { qrHost.innerHTML = ''; qrHost.appendChild(img); })
    .catch(() => { qrHost.innerHTML = '<span class="muted t-sm">QR-koden kunde inte laddas — ladda om sidan.</span>'; });

  overlay.querySelector('#copy').addEventListener('click', async () => {
    await copyToClipboard(url);
    toast('Länk kopierad', 'success');
  });

  // Manuellt startkort — för patruller utan mobil. A4 som viks till A5.
  const manBtn = overlay.querySelector('#manual-pdf');
  manBtn.addEventListener('click', () => withBusy(manBtn, 'Ritar kartan…', async () => {
    try {
      const comp = await getCompetition(cid);
      const [controls, track] = await Promise.all([listControls(cid), getTrack(cid).catch(() => null)]);
      await downloadManualStartPdf({ id: cid, ...comp }, patrol, controls, track, compPlaces(comp));
    } catch (e) {
      console.error(e);
      toast('Kunde inte skapa PDF: ' + e.message, 'error');
    }
  }));

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

// Två sätt att använda samma kort: namngivna åt alla patruller, eller tomma
// reservkort. Det senare är normalfallet när tävlingen kör digitalt — då
// behövs bara några få, och att skriva ut specade kort åt alla är slöseri.
function openManualPdfModal(cid, comp, rows) {
  const patruller = [...rows].sort((a, b) => (a.startOrder ?? 0) - (b.startOrder ?? 0));
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:520px;">
      <div class="modal-head">
        <h3>Manuella startkort</h3>
        <button class="icon-btn" id="x" aria-label="Stäng">${icon('x')}</button>
      </div>
      <div class="modal-body field-group">
        <p class="muted t-sm" style="margin-top:0;">Pappersstartkort för patruller utan mobil. A4 som viks på mitten till A5 — karta på ena sidan, information och poängkort på den andra. Skriv ut dubbelsidigt.</p>

        <div class="card" style="padding:var(--sp-4);box-shadow:none;border:1.5px solid var(--border);">
          <strong>Tomma reservkort</strong>
          <div class="field-hint" style="margin-top:2px;">Utan patrullnamn och starttid — sekretariatet fyller i för hand när ett behövs. Lämpligt när tävlingen kör digitalt och bara några enstaka patruller saknar mobil.</div>
          <div class="row mt-3" style="gap:var(--sp-3);align-items:flex-end;">
            <div style="max-width:110px;">
              <label class="field" for="mp-antal">Antal</label>
              <input class="input" type="number" id="mp-antal" min="1" max="50" value="10">
            </div>
            <button class="btn btn-primary" id="mp-blank">${icon('download', { size: 16 })} Skapa reservkort</button>
          </div>
        </div>

        <div class="card" style="padding:var(--sp-4);box-shadow:none;border:1.5px solid var(--border);">
          <strong>Ett kort per patrull</strong>
          <div class="field-hint" style="margin-top:2px;">Namn, kår och starttid ifyllda i förväg. ${patruller.length} ${patruller.length === 1 ? 'patrull' : 'patruller'} i startordning, i en fil.</div>
          <div class="btn-row mt-3">
            <button class="btn btn-secondary" id="mp-alla" ${patruller.length ? '' : 'disabled'}>${icon('download', { size: 16 })} Skapa åt alla patruller</button>
          </div>
        </div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" id="close">Stäng</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  wireOverlayClose(overlay, close);
  overlay.querySelector('#x').onclick = close;
  overlay.querySelector('#close').onclick = close;

  const skapa = (btn, vad, klartText) => withBusy(btn, 'Ritar kartan…', async () => {
    try {
      const [controls, track] = await Promise.all([listControls(cid), getTrack(cid).catch(() => null)]);
      await downloadManualStartPdf({ id: cid, ...comp }, vad, controls, track, compPlaces(comp));
      toast(klartText, 'success');
      close();
    } catch (e) {
      console.error(e);
      toast('Kunde inte skapa PDF: ' + e.message, 'error');
    }
  });

  const blankBtn = overlay.querySelector('#mp-blank');
  blankBtn.addEventListener('click', () => {
    const n = Math.max(1, Math.min(50, Number(overlay.querySelector('#mp-antal').value) || 10));
    skapa(blankBtn, n, `${n} reservkort skapade`);
  });
  const allaBtn = overlay.querySelector('#mp-alla');
  allaBtn?.addEventListener('click', () =>
    skapa(allaBtn, patruller, `${patruller.length} startkort skapade`));
}

const ny_or = (data, startOrder) => ({ ...data, startOrder });

function openPatrolModal(cid, comp, patrol, ctx = null, onSaved = null) {
  const isEdit = !!patrol;
  // Ny patrull: sist i listan som standard, eller i en lucka om ledningen
  // väljer det. Sist flyttar ingen annan i intervall-läget; i läget starttid
  // + sluttid räknas intervallet om — det varnas nedan om listan är publicerad.
  const st = startTimeSettings(comp);
  const rows = ctx?.rows || [];
  const platsVal = !isEdit && st.enabled;
  const platser = antalStartplatser(comp, rows);
  const luckor = platsVal ? startlistaLuckor(comp, rows) : [];
  const sistTid = platsVal ? patrolStartTime(comp, { startOrder: platser }, platser + 1) : null;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>${isEdit ? 'Redigera patrull' : 'Ny patrull'}</h3><button class="icon-btn" id="x" aria-label="Stäng">${icon('x')}</button></div>
      <div class="modal-body">
        <form id="f" class="field-group">
          <div class="grid grid-2">
            <div>
              <label class="field" for="number">Nr ${help('patrol.number')}</label>
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
              ${allowedAvdelningar(comp).map(a => `<option value="${a.key}" ${patrol?.avdelning === a.key ? 'selected' : ''}>${a.key} (${a.range})</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="field" for="kar">Kår</label>
            <input class="input" id="kar" value="${escapeHtml(patrol?.kar || '')}" placeholder="Ex. Lindsdals Scoutkår">
          </div>
          ${platsVal ? `<div>
            <label class="field" for="plats">Startplats ${help('patrol.startOrder')}</label>
            <select class="select" id="plats">
              <option value="sist">Sist i listan${sistTid ? ` (${escapeHtml(sistTid)})` : ''}</option>
              ${luckor.map(l => `<option value="${l}">Lucka ${escapeHtml(patrolStartTime(comp, { startOrder: l }, platser) || String(l + 1))}</option>`).join('')}
            </select>
          </div>` : ''}
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
  // No backdrop-tap close — edit form, a stray tap would lose typed data.
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
        let savedId;
        if (isEdit) {
          await updatePatrol(cid, patrol.id, data);
          savedId = patrol.id;
        } else {
          const val = overlay.querySelector('#plats')?.value;
          const startOrder = val == null ? null : (val === 'sist' ? platser : Number(val));
          if (startOrder != null) data.startOrder = startOrder;
          if (ctx?.publik && startOrder != null) {
            const ny = { id: '__ny', name: data.name, kar: data.kar, startOrder };
            const luckorEfter = startlistaLuckorSparade(comp).filter(l => l !== startOrder);
            const andra = starttidsAndringar(
              { comp, patrols: rows },
              { comp: { ...comp, startTimes: { ...(comp.startTimes || {}), luckor: luckorEfter } }, patrols: [...rows, ny] }
            ).filter(a => a.patrol.id !== '__ny');
            if (andra.length && !await confirmDialog(
              `STARTLISTAN ÄR PUBLICERAD.\n\nKårerna planerar resor efter tiderna. Den nya patrullen flyttar starttiden för ${andra.length} ${andra.length === 1 ? 'annan patrull' : 'andra patruller'}:\n\n${andra.slice(0, 12).map(a => `${a.patrol.name || 'Patrull'}${a.patrol.kar ? ' (' + a.patrol.kar + ')' : ''}: ${a.fran ?? '—'} → ${a.till ?? '—'}`).join('\n')}${andra.length > 12 ? `\n… och ${andra.length - 12} till` : ''}\n\nLägg patrullen i en lucka i stället, eller fortsätt ändå?`,
              { okLabel: 'Ja, flytta starttiderna', danger: true })) return;
          }
          savedId = await createPatrol(cid, data);
          // Tog patrullen en sparad lucka: stryk den.
          if (startOrder != null && startlistaLuckorSparade(comp).includes(startOrder)) {
            await sparaStartlista(cid, [], startlistaLuckorSparade(comp).filter(l => l !== startOrder),
              startlistaLuftSparad(comp).filter(l => l !== startOrder));
          }
          if (ctx?.publik && startOrder != null) {
            loggHandelse(cid, { vad: 'startlista', av: ctx.user?.email || '',
              text: `Ny patrull i publicerad startlista: ${data.name}${data.kar ? ' (' + data.kar + ')' : ''}, ${patrolStartTime(comp, ny_or(data, startOrder), Math.max(platser, startOrder + 1)) || 'ingen tid'}` });
          }
        }
        onSaved?.(savedId, data);
        close();
        toast('Sparat', 'success');
      } catch (e) {
        toast('Fel: ' + e.message, 'error');
      }
    });
  });
}
