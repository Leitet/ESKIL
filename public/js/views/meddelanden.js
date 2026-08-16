// Meddelanden — ledningens kanal ut till fältet, som egen flik.
//
// Ersätter det gamla driftmeddelande-kortet i Läget. Flera meddelanden kan
// vara aktiva parallellt (klienterna staplar dem); varje meddelande kan begära
// bekräftelse och samlar då kvittenser per kontroll/patrull/station i sin
// acks-subkollektion — "Mottaget" stämplas när bannern visats på enheten,
// "Bekräftat" när funktionären tryckt på knappen. Meddelanden arkiveras
// (försvinner hos klienterna men behåller kvittenshistoriken) i stället för
// att raderas; radering finns för arkiverade.

import { layout, setTopbarCompetition, registerViewCleanup } from '../app.js';
import {
  getCompetition, listControls, listPatrols, listStations,
  watchBroadcastMessages, createBroadcastMessage, setBroadcastMessageActive,
  deleteBroadcastMessage, watchMessageAcks, updateCompetition,
  watchThreads, watchThread, sendThreadMessage, markThreadRead, arHarleddTrad
} from '../store.js';
import { deleteField } from '../firebase.js';
import { escapeHtml, linkifyText, toast, withBusy, confirmDialog, isCompAdminUser, formatTime } from '../utils.js';
import { compHeader, compLabel, setDocTitle } from '../nav.js';
import { icon } from '../icons.js';
import { help } from '../help.js';
import { pickImage } from '../photo.js';

const LEVELS = [['info', 'Information'], ['varning', 'Varning'], ['kritisk', 'Kritisk — larmar']];
const PRESETS = [
  { label: 'Paus — ta skydd', text: 'Tävlingen pausas — ta skydd och invänta besked.', level: 'kritisk', requireAck: true, clearOthers: false },
  { label: 'Åska i området', text: 'Åska i området — var beredda att söka skydd.', level: 'varning', requireAck: false, clearOthers: false },
  // Återupptagning ska AVLÖSA paus-larmet — annars står det kritiska kvar
  // och stacken säger emot sig själv (regression mot enmeddelande-modellen).
  { label: 'Tävlingen återupptas', text: 'Tävlingen återupptas — lycka till!', level: 'info', requireAck: false, clearOthers: true }
];

const AUDIENCES = [
  ['alla', 'Alla'],
  ['kontroller', 'Alla kontroller'],
  ['patruller', 'Alla patruller'],
  ['vissa', 'Välj enskilda…']
];

const levelBadge = (lvl) => lvl === 'kritisk' ? 'badge-pink' : lvl === 'varning' ? 'badge-yellow' : 'badge-blue';
const levelLabel = (lvl) => lvl === 'kritisk' ? 'KRITISK' : lvl === 'varning' ? 'VARNING' : 'INFORMATION';

let unsubs = [];
function cleanup() { unsubs.forEach(u => { try { u(); } catch { /* redan nere */ } }); unsubs = []; }

export async function renderMeddelanden(app, user, cid) {
  cleanup();
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="muted">Laddar…</div>`;
  layout(wrap);

  const [comp, controls, patrols, stations] = await Promise.all([
    getCompetition(cid),
    listControls(cid).catch(() => []),
    listPatrols(cid).catch(() => []),
    listStations(cid).catch(() => [])
  ]);
  if (!wrap.isConnected) return;
  if (!comp) { wrap.innerHTML = `<div class="empty"><h3>Tävlingen hittades inte</h3></div>`; return; }
  setTopbarCompetition(cid, comp, user);
  const isAdmin = isCompAdminUser(comp, user);
  setDocTitle('Meddelanden', compLabel(comp));

  let msgs = [];
  const acksByMsg = {};
  const ackSubs = new Set();

  wrap.innerHTML = `
    ${compHeader(cid, comp, user, { active: 'meddelanden', title: 'Meddelanden' })}
    <p class="muted" style="max-width:72ch;">Når fältet direkt som banner på kontrollernas rapportsidor,
    start/mål-stationen, patrullernas startkort och startskärmen. Flera meddelanden kan vara aktiva
    samtidigt — klienterna staplar dem och samlar historiken i sin notisklocka ${icon('bell', { size: 14 })}.</p>
    <div id="msg-inbox"></div>
    <div id="msg-composer"></div>
    <div id="msg-legacy"></div>
    <div id="msg-active"></div>
    <div id="msg-archive"></div>
  `;

  // --- Inkorg: frågor från fältet -------------------------------------------
  // Åt andra hållet mot utskicken nedan. En kontrollant med en regel som inte
  // täcker fallet framför sig, eller en patrull som gått vilse, ska inte
  // behöva leta rätt på ett telefonnummer.
  mountInbox(wrap.querySelector('#msg-inbox'), { cid, comp, controls, patrols, isAdmin });

  // --- Composer (admin) ------------------------------------------------------
  const composerHost = wrap.querySelector('#msg-composer');
  if (isAdmin) {
    let level = 'info';
    let requireAck = false;
    let clearOthers = false;
    // ETT mottagarval i stället för två menyer med nio kombinationer (varav
    // en var ogiltig). De tre vanliga fallen är ett klick; enskilda mottagare
    // väljs i en gemensam panel.
    let audience = 'alla'; // 'alla' | 'kontroller' | 'patruller' | 'vissa'
    const kIds = new Set(), pIds = new Set();

    // Djuplänk från kontroll- och patrullistan: ?kontroll=<id> / ?patrull=<id>
    // förväljer mottagaren så att "skicka till just den här" blir ett klick.
    const q = new URLSearchParams(location.search);
    const preK = q.get('kontroll'), preP = q.get('patrull');
    if (preK && controls.some(c => c.id === preK)) { kIds.add(preK); audience = 'vissa'; }
    if (preP && patrols.some(p => p.id === preP)) { pIds.add(preP); audience = 'vissa'; }

    // Målgruppen på datamodellens form: true = hela kanalen, [] = utvalda,
    // false = kanalen berörs inte.
    // Publikt är ALLTID ett eget, uttryckligt val. "Alla" betyder alla i
    // FÄLTET — anhöriga är inte en mottagare man råkar få på köpet.
    let publikt = false;

    const targetFromUI = () => {
      if (audience === 'alla') return { kontroller: true, patruller: true, publikt };
      if (audience === 'kontroller') return { kontroller: true, patruller: false, publikt };
      if (audience === 'patruller') return { kontroller: false, patruller: true, publikt };
      return { kontroller: kIds.size ? [...kIds] : false, patruller: pIds.size ? [...pIds] : false, publikt };
    };

    // Klartext om vem som faktiskt nås — mottagarvalet ska aldrig behöva gissas.
    const summaryText = () => {
      const stationTxt = stations.length ? ' och start/mål-stationen' : '';
      if (audience === 'alla') {
        return `Går till alla ${controls.length} kontroller${stationTxt}, alla ${patrols.length} patrullers startkort och startskärmen.`;
      }
      if (audience === 'kontroller') return `Går till alla ${controls.length} kontroller${stationTxt}.`;
      if (audience === 'patruller') return `Går till alla ${patrols.length} patrullers startkort och startskärmen.`;
      if (!kIds.size && !pIds.size) return 'Välj minst en mottagare nedan.';
      const namn = [
        ...[...kIds].map(id => { const c = controls.find(x => x.id === id); return c ? `kontroll ${c.nummer ?? '?'}` : null; }),
        ...[...pIds].map(id => { const p = patrols.find(x => x.id === id); return p ? `#${p.number ?? '?'} ${p.name || ''}`.trim() : null; })
      ].filter(Boolean);
      const lista = namn.length <= 4 ? namn.join(', ') : `${namn.slice(0, 3).join(', ')} och ${namn.length - 3} till`;
      return `Går till ${lista}${kIds.size && stations.length ? stationTxt : ''}.`;
    };

    const renderComposer = () => {
      composerHost.innerHTML = `
        <div class="card mb-4" style="padding:var(--sp-4);">
          <h3 class="t-h3" style="margin:0 0 var(--sp-3);">Nytt meddelande${help('msg.level')}</h3>
          <div class="row wrap" style="gap:6px;">
            ${LEVELS.map(([k, l]) => `<button type="button" class="btn btn-sm ${level === k ? 'btn-primary' : 'btn-secondary'}" data-level="${k}">${l}</button>`).join('')}
          </div>
          <textarea class="textarea mt-3" id="msg-text" placeholder="Meddelande till fältet…" style="min-height:64px;"></textarea>
          <div class="row wrap mt-2" style="gap:6px;">
            ${PRESETS.map((p, i) => `<button type="button" class="btn btn-ghost btn-sm" data-preset="${i}">${escapeHtml(p.label)}</button>`).join('')}
          </div>
          <div class="mt-4">
            <div class="t-sm" style="font-weight:700;margin-bottom:6px;">Mottagare${help('msg.target')}</div>
            <div class="row wrap" style="gap:6px;">
              ${AUDIENCES.map(([k, l]) => `
                <button type="button" class="btn btn-sm ${audience === k ? 'btn-primary' : 'btn-secondary'}" data-aud="${k}">${l}</button>
              `).join('')}
            </div>
            <div class="mt-3" ${audience === 'vissa' ? '' : 'hidden'} id="msg-pick">
              <div class="t-sm muted" style="margin-bottom:4px;">Kontroller — meddelandet når även start/mål-stationen</div>
              <div class="row wrap" style="gap:6px;">
                ${[...controls].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0)).map(c => `
                  <label class="msg-chip ${kIds.has(c.id) ? 'is-on' : ''}">
                    <input type="checkbox" data-kid="${escapeHtml(c.id)}" ${kIds.has(c.id) ? 'checked' : ''}>${c.nummer ?? '?'}. ${escapeHtml(c.name || '')}
                  </label>`).join('') || '<span class="muted t-sm">Inga kontroller ännu.</span>'}
              </div>
              <div class="t-sm muted" style="margin:var(--sp-3) 0 4px;">Patruller — meddelandet visas på deras startkort</div>
              <div class="row wrap" style="gap:6px;">
                ${[...patrols].sort((a, b) => (a.number ?? 0) - (b.number ?? 0)).map(p => `
                  <label class="msg-chip ${pIds.has(p.id) ? 'is-on' : ''}">
                    <input type="checkbox" data-pid="${escapeHtml(p.id)}" ${pIds.has(p.id) ? 'checked' : ''}>#${p.number ?? '?'} ${escapeHtml(p.name || '')}
                  </label>`).join('') || '<span class="muted t-sm">Inga patruller ännu.</span>'}
              </div>
            </div>
            <p class="field-hint" id="msg-summary" style="margin-top:8px;">${escapeHtml(summaryText())}</p>
          </div>

          <div class="row wrap mt-3" style="gap:var(--sp-5);align-items:center;">
            <label class="t-sm" style="display:inline-flex;gap:8px;align-items:center;font-weight:600;cursor:pointer;">
              <input type="checkbox" id="msg-ack" ${requireAck ? 'checked' : ''} style="margin:0;">
              Begär bekräftelse ${help('msg.requireAck')}
            </label>
            <label class="t-sm" style="display:inline-flex;gap:8px;align-items:center;font-weight:600;cursor:pointer;">
              <input type="checkbox" id="msg-clear" ${clearOthers ? 'checked' : ''} style="margin:0;">
              Avsluta alla andra aktiva samtidigt ${help('msg.clearOthers')}
            </label>
            <label class="t-sm" style="display:inline-flex;gap:8px;align-items:center;font-weight:600;cursor:pointer;">
              <input type="checkbox" id="msg-publikt" ${publikt ? 'checked' : ''} style="margin:0;">
              Visa även på tävlingssidan ${help('msg.publikt')}
            </label>
          </div>
          <p class="field-hint" style="margin:10px 0 8px;">Meddelandet är publikt — skriv inga personuppgifter.
          Kritisk nivå larmar med ljud och vibration. Med "Begär bekräftelse" ser du här vilka som tagit
          emot och bekräftat meddelandet.</p>
          <button class="btn btn-primary" id="msg-send">Skicka meddelande</button>
        </div>`;

      const keepText = () => composerHost.querySelector('#msg-text')?.value ?? '';
      const rerenderKeeping = (fn) => { const t = keepText(); fn(); renderComposer(); composerHost.querySelector('#msg-text').value = t; };
      composerHost.querySelectorAll('[data-level]').forEach(b => b.addEventListener('click', () =>
        rerenderKeeping(() => { level = b.dataset.level; })));
      composerHost.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
        const p = PRESETS[Number(b.dataset.preset)];
        level = p.level; requireAck = p.requireAck; clearOthers = p.clearOthers;
        renderComposer();
        composerHost.querySelector('#msg-text').value = p.text;
      }));
      composerHost.querySelectorAll('[data-aud]').forEach(b => b.addEventListener('click', () =>
        rerenderKeeping(() => { audience = b.dataset.aud; })));
      composerHost.querySelector('#msg-ack').addEventListener('change', (e) => { requireAck = e.target.checked; });
      composerHost.querySelector('#msg-clear').addEventListener('change', (e) => { clearOthers = e.target.checked; });
      composerHost.querySelector('#msg-publikt').addEventListener('change', (e) => { publikt = e.target.checked; });
      // Chipsen uppdaterar sammanfattningen direkt — man ska se följden av
      // sitt val utan att först trycka Skicka.
      const refreshSummary = () => {
        const el = composerHost.querySelector('#msg-summary');
        if (el) el.textContent = summaryText();
      };
      composerHost.querySelectorAll('[data-kid], [data-pid]').forEach(cb => cb.addEventListener('change', () => {
        const set = cb.dataset.kid ? kIds : pIds;
        const id = cb.dataset.kid || cb.dataset.pid;
        cb.checked ? set.add(id) : set.delete(id);
        cb.closest('label').classList.toggle('is-on', cb.checked);
        refreshSummary();
      }));
      composerHost.querySelector('#msg-send').addEventListener('click', async (e) => {
        const text = keepText().trim();
        if (!text) { toast('Skriv ett meddelande först.', 'error'); return; }
        const target = targetFromUI();
        if (target.kontroller === false && target.patruller === false && !target.publikt) {
          toast('Välj minst en mottagare.', 'error');
          return;
        }
        await withBusy(e.currentTarget, 'Skickar…', async () => {
          try {
            const newId = await createBroadcastMessage(cid, { text, level, target, requireAck });
            if (clearOthers) {
              for (const m of msgs.filter(x => x.active !== false && x.id !== newId)) {
                await setBroadcastMessageActive(cid, m.id, false).catch(() => { /* nästa */ });
              }
              if (comp.broadcast) {
                await updateCompetition(cid, { broadcast: deleteField() }).catch(() => { /* legacy */ });
                comp.broadcast = null;
                renderLegacy();
              }
            }
            composerHost.querySelector('#msg-text').value = '';
            const cleared = clearOthers;
            clearOthers = false;
            composerHost.querySelector('#msg-clear').checked = false;
            publikt = false;
            composerHost.querySelector('#msg-publikt').checked = false;
            toast(cleared ? 'Meddelandet skickat — övriga avslutade' : 'Meddelandet skickat', 'success');
          } catch (err) { toast('Fel: ' + err.message, 'error'); }
        });
      });
    };
    renderComposer();
  }

  // --- Legacy: gamla broadcast-fältet på tävlingsdokumentet -------------------
  const legacyHost = wrap.querySelector('#msg-legacy');
  const renderLegacy = () => {
    const b = comp.broadcast && (comp.broadcast.text || '').trim() ? comp.broadcast : null;
    legacyHost.innerHTML = !b ? '' : `
      <div class="card mb-4" style="padding:var(--sp-4);border-left:3px solid var(--avent-orange);">
        <div class="row wrap" style="justify-content:space-between;align-items:center;gap:var(--sp-3);">
          <div>
            <span class="badge ${levelBadge(b.level)}">${levelLabel(b.level)}</span>
            <strong style="margin-left:8px;">${escapeHtml(b.text)}</strong>
            <span class="muted t-sm" style="margin-left:8px;">Äldre driftmeddelande (gamla systemet) — fortfarande synligt hos klienterna.</span>
          </div>
          ${isAdmin ? '<button class="btn btn-secondary btn-sm" id="legacy-clear">Ta bort</button>' : ''}
        </div>
      </div>`;
    legacyHost.querySelector('#legacy-clear')?.addEventListener('click', (e) => withBusy(e.currentTarget, '…', async () => {
      try {
        await updateCompetition(cid, { broadcast: deleteField() });
        comp.broadcast = null;
        renderLegacy();
        toast('Meddelandet borttaget');
      } catch (err) { toast('Fel: ' + err.message, 'error'); }
    }));
  };
  renderLegacy();

  // --- Mottagare & kvittenser -------------------------------------------------
  const targetLabel = (t) => {
    if (!t) return 'alla';
    const part = (v, allWord, unit) => (v === true || v === undefined) ? allWord
      : (v === false || (Array.isArray(v) && !v.length)) ? null : `${v.length} ${unit}`;
    const parts = [part(t.kontroller, 'alla kontroller', 'kontroller'),
                   part(t.patruller, 'alla patruller', 'patruller')].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'ingen';
  };

  // Förväntade mottagare med kvittensidentitet: målgruppens kontroller och
  // patruller, plus stationen när kontrollkanalen är på (stationen visar då
  // meddelandet och kvitterar som "station").
  const expectedFor = (m) => {
    const t = m.target || {};
    const rows = [];
    const ks = t.kontroller === true ? controls
      : Array.isArray(t.kontroller) ? controls.filter(c => t.kontroller.includes(c.id)) : [];
    const ps = t.patruller === true ? patrols
      : Array.isArray(t.patruller) ? patrols.filter(p => t.patruller.includes(p.id)) : [];
    for (const c of [...ks].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0))) {
      rows.push({ kind: 'kontroll', refId: c.id, label: `${c.nummer ?? '?'}. ${c.name || ''}` });
    }
    for (const p of [...ps].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))) {
      rows.push({ kind: 'patrull', refId: p.id, label: `#${p.number ?? '?'} ${p.name || ''}` });
    }
    // Stationen visar meddelandet när kontrollkanalen är PÅ (samma villkor
    // som klientens targetsUs — inte "minst en kontroll finns", annars blir
    // stationens kvittens osynlig i tävlingar utan kontroller).
    const someK = t.kontroller === true || (Array.isArray(t.kontroller) && t.kontroller.length > 0);
    if (someK) for (const s of stations) {
      rows.push({ kind: 'station', refId: s.id, label: 'Start/Mål-stationen' });
    }
    return rows;
  };

  const msgCard = (m, archived) => {
    const acks = acksByMsg[m.id] || [];
    const findAck = (r) => acks.find(a => a.kind === r.kind && a.refId === r.refId);
    const expected = m.requireAck ? expectedFor(m) : [];
    const nAck = expected.filter(r => findAck(r)?.ackAt).length;
    const nSeen = expected.filter(r => { const a = findAck(r); return a?.seenAt || a?.ackAt; }).length;
    const allAck = expected.length > 0 && nAck === expected.length;
    return `
      <div class="card mb-3" style="padding:var(--sp-4);${m.level === 'kritisk' && !archived ? 'border-left:3px solid var(--utm-pink);' : ''}${archived ? 'opacity:.75;' : ''}">
        <div class="row wrap" style="gap:var(--sp-3);align-items:baseline;">
          <span class="badge ${levelBadge(m.level)}">${levelLabel(m.level)}</span>
          <strong style="flex:1 1 240px;white-space:pre-wrap;">${escapeHtml(m.text)}</strong>
          <span class="muted t-sm" style="white-space:nowrap;">kl ${m.at ? formatTime(new Date(m.at)) : ''} · till ${escapeHtml(targetLabel(m.target))}</span>
        </div>
        ${m.requireAck ? `
          <details class="mt-2" data-msg="${escapeHtml(m.id)}" ${!archived && !allAck ? 'open' : ''}>
            <summary style="cursor:pointer;font-weight:700;font-size:14px;color:${allAck ? 'var(--spaer-green, #41A62A)' : 'var(--avent-orange)'};">
              ${allAck ? `${icon('check', { size: 14 })} Alla har bekräftat` : `Bekräftat ${nAck} av ${expected.length}`} · mottaget ${nSeen} av ${expected.length}
            </summary>
            <div class="table-wrap mt-2"><table class="t">
              <thead><tr><th>Mottagare</th><th>Status</th></tr></thead>
              <tbody>
                ${expected.map(r => {
                  const a = findAck(r);
                  const status = a?.ackAt ? `<span style="color:var(--spaer-green, #2d7a1c);font-weight:700;">${icon('check', { size: 13 })} Bekräftat ${formatTime(a.ackAt)}</span>`
                    : (a?.seenAt ? `Mottaget ${formatTime(a.seenAt)}` : '<span class="muted">—</span>');
                  return `<tr><td>${escapeHtml(r.label)}</td><td class="t-sm">${status}</td></tr>`;
                }).join('')}
              </tbody>
            </table></div>
            <p class="field-hint" style="margin:6px 0 0;">Kvittenser rapporteras av fältenheterna utan inloggning —
            använd dem som lägesbild. Vid kritiska lägen: bekräfta muntligt via telefonlistan i Läget.</p>
          </details>
        ` : ''}
        ${isAdmin ? `
          <div class="row wrap mt-3" style="gap:var(--sp-2);">
            ${archived
              ? `<button class="btn btn-ghost btn-sm" data-reactivate="${escapeHtml(m.id)}">Aktivera igen</button>
                 <button class="btn btn-ghost btn-sm" style="color:var(--utm-pink);" data-delete="${escapeHtml(m.id)}">Ta bort permanent</button>`
              : `<button class="btn btn-secondary btn-sm" data-archive="${escapeHtml(m.id)}">Avsluta meddelandet</button>`}
          </div>
        ` : ''}
      </div>`;
  };

  const activeHost = wrap.querySelector('#msg-active');
  const archiveHost = wrap.querySelector('#msg-archive');
  const renderLists = () => {
    if (!wrap.isConnected) return;
    // Kvittenser strömmar in live — bevara vilka detaljvyer användaren har
    // öppna/stängda över omrenderingarna.
    const prevDetails = {};
    wrap.querySelectorAll('details[data-msg]').forEach(d => { prevDetails[d.dataset.msg] = d.open; });
    const active = msgs.filter(m => m.active !== false);
    const archived = msgs.filter(m => m.active === false);
    activeHost.innerHTML = `
      <h3 class="t-h3" style="margin:var(--sp-5) 0 var(--sp-3);">Aktiva meddelanden (${active.length})</h3>
      ${active.length ? active.map(m => msgCard(m, false)).join('')
        : '<div class="empty" style="padding:var(--sp-5);"><p class="muted" style="margin:0;">Inga aktiva meddelanden — fältet ser inga banners just nu.</p></div>'}`;
    archiveHost.innerHTML = !archived.length ? '' : `
      <details class="mt-5" data-msg="__arkiv">
        <summary style="cursor:pointer;font-weight:700;">Avslutade meddelanden (${archived.length})</summary>
        <div class="mt-3">${archived.map(m => msgCard(m, true)).join('')}</div>
      </details>`;
    wrap.querySelectorAll('details[data-msg]').forEach(d => {
      if (d.dataset.msg in prevDetails) d.open = prevDetails[d.dataset.msg];
    });

    wrap.querySelectorAll('[data-archive]').forEach(b => b.addEventListener('click', (e) => withBusy(e.currentTarget, '…', async () => {
      try { await setBroadcastMessageActive(cid, b.dataset.archive, false); toast('Meddelandet avslutat — försvinner hos klienterna'); }
      catch (err) { toast('Fel: ' + err.message, 'error'); }
    })));
    wrap.querySelectorAll('[data-reactivate]').forEach(b => b.addEventListener('click', (e) => withBusy(e.currentTarget, '…', async () => {
      try { await setBroadcastMessageActive(cid, b.dataset.reactivate, true); toast('Meddelandet är aktivt igen', 'success'); }
      catch (err) { toast('Fel: ' + err.message, 'error'); }
    })));
    wrap.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Ta bort meddelandet och alla dess kvittenser permanent?'))) return;
      try { await deleteBroadcastMessage(cid, b.dataset.delete); toast('Meddelandet borttaget'); }
      catch (err) { toast('Fel: ' + err.message, 'error'); }
    }));
  };

  unsubs.push(watchBroadcastMessages(cid, rows => {
    msgs = rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    for (const m of msgs) {
      if (m.requireAck && !ackSubs.has(m.id)) {
        ackSubs.add(m.id);
        unsubs.push(watchMessageAcks(cid, m.id, list => { acksByMsg[m.id] = list; renderLists(); }));
      }
    }
    renderLists();
  }));

  registerViewCleanup(() => { cleanup(); inboxUnsubs.forEach(u => { try { u(); } catch {} }); });
}

// --- Ledningens inkorg ---------------------------------------------------------
// Trådarna ligger på competitions/<cid>/threads och listas bara för medlemmar.
// En tråd per kontroll och patrull; oläst = fältet skrev senast och senare än
// ledningens läskvittens (som delas av hela sekretariatet — har en läst frågan
// behöver inte alla göra det).
const inboxUnsubs = [];

function mountInbox(host, { cid, comp, controls, patrols, isAdmin }) {
  if (!host) return;
  if (comp?.fieldMessaging === false) {
    host.innerHTML = `<div class="card mb-4"><p class="muted" style="margin:0;">
      Frågor från fältet är avstängt för den här tävlingen. Slå på det under
      Inställningar → Regler &amp; info om kontroller och patruller ska kunna skriva hit.</p></div>`;
    return;
  }

  const namnAv = (t) => {
    if (t.kind === 'kontroll') {
      const c = controls.find(x => x.id === t.refId);
      return c ? `Kontroll ${c.nummer ?? '?'} · ${c.name || ''}` : 'Kontroll (borttagen)';
    }
    const p = patrols.find(x => x.id === t.refId);
    return p ? `#${p.number ?? '?'} ${p.name || ''}${p.kar ? ` (${p.kar})` : ''}` : 'Patrull (borttagen)';
  };
  const olästDel = (d) => {
    const sist = d.lastAt?.toDate?.();
    const läst = d.ledningReadAt?.toDate?.();
    return !!(d.lastFrom === 'falt' && sist && (!läst || sist > läst));
  };
  // En grupp är oläst om NÅGON del är det. Räknade man bara på den senaste
  // delen kunde en fråga som kom in i den härledda tråden tystas av ett
  // nyare meddelande i tokentråden — och tvärtom.
  const oläst = (t) => (t.delar ? t.delar.some(olästDel) : olästDel(t));

  // En kontroll eller patrull kan ha TVÅ trådar: den härledda (dit fältet
  // skriver utan token, t.ex. från en gammal utskrift eller från startkortet
  // man öppnat via tävlingssidan) och tokentråden (dit den som har den nya
  // fältlänken både skriver och läser). För sekretariatet är det ETT samtal —
  // annars ligger halva konversationen i en rad man inte råkar klicka på.
  const nyckelAv = (t) => `${t.kind}-${t.refId}`;
  const grupper = () => {
    const map = new Map();
    for (const t of trådar) {
      // Ett nymintat tokenhuvud bär bara {kind, refId}. Det är inte ett samtal
      // och ska inte stå i inkorgen som en tom rad.
      const g = map.get(nyckelAv(t)) || { nyckel: nyckelAv(t), kind: t.kind, refId: t.refId, delar: [] };
      g.delar.push(t);
      map.set(g.nyckel, g);
    }
    return [...map.values()]
      .map(g => {
        const medText = g.delar.filter(t => t.lastAt);
        const sist = medText.sort((a, b) => (b.lastAt?.toMillis?.() || 0) - (a.lastAt?.toMillis?.() || 0))[0];
        // Kom det senaste FÄLTmeddelandet i den härledda tråden sitter
        // avsändaren på en länk utan samtalsnyckel och kan inte läsa svaret.
        // Det måste ledningen se innan de skriver ett svar ingen läser.
        const senasteFalt = medText.filter(t => t.lastFrom === 'falt')[0];
        return { ...g, sist, lastAt: sist?.lastAt || null, lastText: sist?.lastText || '',
                 utanNyckel: !!senasteFalt && arHarleddTrad(senasteFalt.id) };
      })
      .filter(g => g.sist);
  };
  // Ledningens svar går i TOKENtråden när en sådan finns — svarar man i den
  // härledda kan fältet inte läsa det, hur ny länk kontrollanten än har.
  const svarsTrad = (g) => g.delar.find(t => !arHarleddTrad(t.id)) || g.delar[0];

  let trådar = [];
  let öppen = null;   // gruppens nyckel

  host.innerHTML = `
    <section class="card mb-4">
      <div class="row" style="justify-content:space-between;align-items:baseline;">
        <h3 class="t-h3" style="margin:0;">${icon('inbox', { size: 18 })} Frågor från fältet ${help('comp.fieldMessaging')}</h3>
        <span class="badge badge-orange" id="inbox-count" hidden>0</span>
      </div>
      <p class="muted t-sm" style="margin:6px 0 12px;">Kontroller och patruller kan skriva hit från sina egna sidor, med bild. Svaren visas direkt hos dem.</p>
      <div id="inbox-list"></div>
      <div id="inbox-thread"></div>
    </section>`;

  const list = host.querySelector('#inbox-list');
  const threadHost = host.querySelector('#inbox-thread');
  const count = host.querySelector('#inbox-count');

  const ritaLista = () => {
    const rader = grupper();
    const nya = rader.filter(oläst).length;
    count.hidden = nya === 0;
    count.textContent = `${nya} ny${nya === 1 ? '' : 'a'}`;
    if (!rader.length) {
      list.innerHTML = `<div class="empty" style="padding:var(--sp-4);"><p class="muted" style="margin:0;">Inga frågor än.</p></div>`;
      return;
    }
    const sorterade = rader.sort((a, b) =>
      (oläst(b) - oläst(a)) || ((b.lastAt?.toMillis?.() || 0) - (a.lastAt?.toMillis?.() || 0)));
    list.innerHTML = sorterade.map(t => `
      <button type="button" class="place-row ${oläst(t) ? 'inbox-unread' : ''}" data-thread="${escapeHtml(t.nyckel)}">
        <span class="place-dot" style="background:${t.kind === 'kontroll' ? 'var(--scout-blue)' : 'var(--avent-orange)'};">
          ${icon(t.kind === 'kontroll' ? 'flag' : 'users', { size: 16 })}</span>
        <span class="place-body">
          <span class="place-name">${escapeHtml(namnAv(t))}</span>
          <span class="muted t-sm" style="display:block;">${escapeHtml(t.lastText || '')}</span>
          ${t.utanNyckel ? '<span class="muted t-sm" style="display:block;">Skickat från en länk utan samtalsnyckel — de ser inte ert svar</span>' : ''}
        </span>
        ${oläst(t) ? '<span class="badge badge-orange">Ny</span>' : ''}
        <span class="muted t-sm">${t.lastAt ? formatTime(t.lastAt.toDate()) : ''}</span>
      </button>`).join('');
    list.querySelectorAll('[data-thread]').forEach(b =>
      b.addEventListener('click', () => öppnaTråd(b.dataset.thread)));
  };

  let bild = null;
  let trådUnsubs = [];
  let öppnaDelar = 0;   // antal trådhalvor det öppna samtalet prenumererar på
  function öppnaTråd(nyckel) {
    const t = grupper().find(x => x.nyckel === nyckel);
    if (!t) return;
    öppen = nyckel;
    trådUnsubs.forEach(u => { try { u(); } catch {} });
    trådUnsubs = [];
    // Kvittera på VARJE del — annars står gruppen kvar som oläst för att den
    // andra tråden aldrig markerades.
    if (isAdmin) {
      t.delar.forEach(d =>
        markThreadRead(cid, d.kind, d.refId, 'ledning', arHarleddTrad(d.id) ? null : d.id).catch(() => {}));
    }

    threadHost.innerHTML = `
      <div class="card mt-3" style="box-shadow:none;border:1.5px solid var(--border);">
        <div class="row" style="justify-content:space-between;align-items:baseline;">
          <strong>${escapeHtml(namnAv(t))}</strong>
          <button class="btn btn-ghost btn-sm" id="inbox-close">Stäng</button>
        </div>
        <div class="inbox-log" id="inbox-log"></div>
        ${isAdmin ? `
          <div class="inbox-attach" id="inbox-attach" hidden>
            <img id="inbox-attach-img" alt="Vald bild">
            <button type="button" class="btn btn-ghost btn-sm" id="inbox-attach-x">Ta bort bilden</button>
          </div>
          <textarea class="textarea mt-3" id="inbox-text" rows="2" placeholder="Svara…"></textarea>
          <div class="btn-row mt-2">
            <button class="btn btn-secondary btn-sm" id="inbox-photo">${icon('image', { size: 15 })} Bifoga bild</button>
            <button class="btn btn-primary btn-sm" id="inbox-send">Skicka svar</button>
          </div>` : '<p class="muted t-sm mt-3">Bara administratörer kan svara.</p>'}
      </div>`;

    const log = threadHost.querySelector('#inbox-log');
    threadHost.querySelector('#inbox-close').addEventListener('click', () => {
      trådUnsubs.forEach(u => { try { u(); } catch {} });
      trådUnsubs = [];
      öppen = null; threadHost.innerHTML = '';
    });

    // Gruppens delar prenumereras var för sig och flätas ihop på tid — det är
    // ETT samtal för den som läser.
    const perTrad = new Map();
    const rita = () => {
      const rows = [...perTrad.values()].flat()
        .sort((a, b) => (a.at?.toMillis?.() || 0) - (b.at?.toMillis?.() || 0));
      log.innerHTML = rows.length ? rows.map(m => `
        <div class="inbox-msg ${m.from === 'ledning' ? 'inbox-mine' : 'inbox-theirs'}">
          ${m.image ? `<img class="inbox-img" src="${escapeHtml(m.image)}" alt="Bifogad bild" loading="lazy">` : ''}
          ${m.text ? `<div style="white-space:pre-wrap;word-break:break-word;">${linkifyText(m.text)}</div>` : ''}
          <div class="inbox-meta">${m.from === 'ledning' ? 'Ni' : 'Fältet'} · ${m.at ? formatTime(m.at.toDate()) : ''}</div>
        </div>`).join('') : '<p class="muted t-sm">Tom tråd.</p>';
      log.scrollTop = log.scrollHeight;
    };
    öppnaDelar = t.delar.length;
    t.delar.forEach(d => trådUnsubs.push(watchThread(cid, d.id, rows => {
      perTrad.set(d.id, rows);
      rita();
    })));

    if (!isAdmin) return;
    const attach = threadHost.querySelector('#inbox-attach');
    const visaBild = () => {
      attach.hidden = !bild;
      if (bild) threadHost.querySelector('#inbox-attach-img').src = bild.dataUrl;
    };
    threadHost.querySelector('#inbox-photo').addEventListener('click', async () => {
      try { const v = await pickImage(); if (v) { bild = v; visaBild(); } }
      catch (e) { toast(e.message, 'error'); }
    });
    threadHost.querySelector('#inbox-attach-x').addEventListener('click', () => { bild = null; visaBild(); });
    const send = threadHost.querySelector('#inbox-send');
    send.addEventListener('click', () => withBusy(send, 'Skickar…', async () => {
      const text = threadHost.querySelector('#inbox-text').value.trim();
      if (!text && !bild) return;
      try {
        const mal = svarsTrad(t);
        await sendThreadMessage(cid, t.kind, t.refId,
          { from: 'ledning', text, image: bild?.dataUrl || null,
            token: arHarleddTrad(mal.id) ? null : mal.id });
        threadHost.querySelector('#inbox-text').value = '';
        bild = null; visaBild();
      } catch (e) { toast('Kunde inte skicka: ' + e.message, 'error'); }
    }));
  }

  // Notis när något kommer in medan appen är öppen. Första snapshoten räknas
  // inte — då hade varje sidladdning larmat om gamla frågor.
  let första = true;
  const sedda = new Set();
  inboxUnsubs.push(watchThreads(cid, rows => {
    trådar = rows;
    for (const t of grupper()) {
      const nyckel = `${t.nyckel}:${t.lastAt?.toMillis?.() || 0}`;
      if (!första && oläst(t) && !sedda.has(nyckel)) {
        toast(`Ny fråga: ${namnAv(t)}`, 'success');
        try { navigator.vibrate?.(120); } catch { /* stöds inte */ }
      }
      sedda.add(nyckel);
    }
    första = false;
    ritaLista();
    const öppenGrupp = öppen ? grupper().find(g => g.nyckel === öppen) : null;
    if (öppen && !öppenGrupp) { threadHost.innerHTML = ''; öppen = null; }
    // Dök en NY trådhalva upp för det öppna samtalet (fältet skrev via den
    // andra länken) prenumererar vi inte på den — öppna om.
    else if (öppenGrupp && öppenGrupp.delar.length !== öppnaDelar) öppnaTråd(öppen);
  }));

  ritaLista();
}
