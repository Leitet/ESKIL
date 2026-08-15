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
  deleteBroadcastMessage, watchMessageAcks, updateCompetition
} from '../store.js';
import { deleteField } from '../firebase.js';
import { escapeHtml, toast, withBusy, confirmDialog, isCompAdminUser, formatTime } from '../utils.js';
import { compTabs, compCrumbs, compLabel, setDocTitle } from '../nav.js';
import { icon } from '../icons.js';
import { help } from '../help.js';

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
    <div class="page-head">
      <div>
        ${compCrumbs(cid, comp, { label: 'Meddelanden' })}
        <h1 class="t-d2">Meddelanden</h1>
      </div>
    </div>
    ${compTabs(cid, 'meddelanden', comp, user)}
    <p class="muted" style="max-width:72ch;">Når fältet direkt som banner på kontrollernas rapportsidor,
    start/mål-stationen, patrullernas startkort och startskärmen. Flera meddelanden kan vara aktiva
    samtidigt — klienterna staplar dem och samlar historiken i sin notisklocka ${icon('bell', { size: 14 })}.</p>
    <div id="msg-composer"></div>
    <div id="msg-legacy"></div>
    <div id="msg-active"></div>
    <div id="msg-archive"></div>
  `;

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
    const targetFromUI = () => {
      if (audience === 'alla') return { kontroller: true, patruller: true };
      if (audience === 'kontroller') return { kontroller: true, patruller: false };
      if (audience === 'patruller') return { kontroller: false, patruller: true };
      return { kontroller: kIds.size ? [...kIds] : false, patruller: pIds.size ? [...pIds] : false };
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
        if (target.kontroller === false && target.patruller === false) {
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

  registerViewCleanup(cleanup);
}
