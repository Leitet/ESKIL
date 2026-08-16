import { layout, setTopbarCompetition, registerViewCleanup } from '../app.js';
import {
  getCompetition, getControl, updateControl, attachControlMeta,
  watchScoresForControl, listPatrols, listControls, getTrack,
  deleteScore, adjustScore, ensureThreadToken
} from '../store.js';
import { courseLegs, legStub, legLatLngs, controlEtaWindow } from '../course.js';
import { escapeHtml, toast, copyToClipboard, reportUrl, confirmDialog, formatTime, allInstructionGroups, withBusy, wireOverlayClose, isCompAdminUser, canEditControl } from '../utils.js';
import { icon } from '../icons.js';
import { compHeader, compLabel, setDocTitle } from '../nav.js';
import { navigate } from '../router.js';
import { openControlModal } from './controls.js';
import { downloadControlPdf, renderQrToImg } from '../pdf.js';
import { ensureLeaflet } from '../leaflet.js';

let unsub = null;

export async function renderControlDetail(app, user, cid, ctrlId) {
  if (unsub) { unsub(); unsub = null; }

  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="muted">Laddar…</div>`;
  layout(wrap);

  const [comp, control, patrols, allControls, track] = await Promise.all([
    getCompetition(cid),
    getControl(cid, ctrlId),
    listPatrols(cid).catch(() => []),
    listControls(cid).catch(() => []),
    getTrack(cid).catch(() => null)
  ]);
  // The user may have navigated away while we were loading — don't render a
  // stale view over the new page or start subscriptions nothing will clean up.
  if (!wrap.isConnected) return;
  if (!comp || !control) {
    wrap.innerHTML = `<div class="empty"><h3>Kontrollen hittades inte</h3></div>`;
    return;
  }
  // telefon/notering live in a member-only subdoc — merge them in for display.
  await attachControlMeta(cid, [control]).catch(() => {});
  // Samtalstoken mintas LAT, här där länken byggs. Utan den blir den utskrivna
  // QR-koden en skickar-bara-länk: kontrollanten når ledningen men ser inga
  // svar. Misslyckas mintningen (t.ex. kontrollansvarig utan skrivrätt på
  // metan) byggs länken ändå — den fungerar, bara utan samtalet.
  if (!control.threadToken) {
    control.threadToken = await ensureThreadToken(cid, 'kontroll', ctrlId).catch(() => '');
  }
  setTopbarCompetition(cid, comp, user);
  const isAdmin = isCompAdminUser(comp, user);
  // Kontrollansvariga may edit and open/close THIS control (not delete it,
  // not change who is ansvarig) — the security rules enforce the same.
  const canEdit = canEditControl(comp, control, user);
  const url = reportUrl(cid, ctrlId, control.threadToken);
  const shortOf = (avd) => ({ 'Spårare':'sp','Upptäckare':'up','Äventyrare':'av','Utmanare':'ut','Rover':'ro','Ledare':'le' }[avd] || 'le');

  const ctrlTitle = `${control.nummer ?? ''}. ${control.name || ''}`;
  setDocTitle(ctrlTitle, compLabel(comp));
  wrap.innerHTML = `
    ${compHeader(cid, comp, user, {
      active: 'controls', title: ctrlTitle,
      crumbs: [{ label: 'Kontroller', href: `/app/c/${cid}/controls` }],
      subtitleHtml: `${control.open ? '<span class="badge badge-green">Öppen</span>' : '<span class="badge badge-gray">Stängd</span>'} Max ${control.maxPoang || 0} · Min ${control.minPoang || 0}${control.extraPoang ? ' · Extra ' + control.extraPoang : ''}`,
      actions: `
        ${canEdit ? '<button class="btn btn-secondary" id="edit">Redigera kontrollen</button>' : ''}
        ${canEdit ? `<button class="btn btn-primary" id="toggle">${control.open ? 'Stäng' : 'Öppna'} för rapport</button>` : ''}`
    })}

    <div class="grid grid-2">
      <div class="card">
        <h3 class="t-h3">Rapporteringslänk</h3>
        <p class="muted t-sm">Distribuera denna QR-kod eller länk till kontrollfunktionären. Länken är hemlig — dela den bara med rätt person.</p>
        ${control.threadToken ? `<p class="muted t-sm">Sista delen av länken är kontrollens samtalsnyckel. Har funktionären
        en <strong>äldre utskrift utan den</strong> går det fortfarande att rapportera poäng och skicka
        frågor till er — men era svar syns inte i telefonen. Skriv i så fall ut kontrollbladet på nytt.</p>`
        : `<p class="muted t-sm">Kontrollen saknar ännu en samtalsnyckel, så funktionären kan skicka
        frågor till tävlingsledningen men inte se svaren. Nyckeln skapas när en <strong>administratör</strong>
        öppnar den här sidan eller Utskrifter.</p>`}
        <div id="qr" class="row" style="justify-content:center;padding:16px 0;"></div>
        <label class="field">Länk</label>
        <div class="row">
          <input class="input mono t-sm" readonly value="${escapeHtml(url)}" id="url-input">
          <button class="btn btn-secondary btn-sm" id="copy">Kopiera</button>
        </div>
        <div class="btn-row mt-4">
          <button class="btn btn-primary" id="pdf">${icon('download', { size: 16 })} Ladda ner PDF</button>
          <a class="btn btn-ghost" href="${url}" target="_blank" rel="noopener">Öppna rapportsida</a>
        </div>
      </div>

      <div class="card">
        <h3 class="t-h3">Placering</h3>
        ${control.lat && control.lng ? `
          <p class="mono t-sm" style="margin:0 0 var(--sp-2);">${control.lat.toFixed(5)}, ${control.lng.toFixed(5)}</p>
          <div id="placering-map" style="aspect-ratio:1/1;width:100%;max-width:260px;border-radius:var(--r-md);overflow:hidden;border:1px solid var(--border);"></div>
        ` : '<p class="muted">Ingen position angiven.</p>'}
        ${control.placement ? `
          <div class="mt-4">
            <div class="t-over">Placeringsbeskrivning</div>
            <p class="t-serif" style="color:var(--fg2);">${escapeHtml(control.placement)}</p>
          </div>` : ''}
        ${control.telefon ? `
          <div class="mt-4">
            <div class="t-over" style="color:var(--scout-blue);">Telefon till kontrollen</div>
            <p class="t-sm" style="margin:4px 0;"><a class="mono" href="tel:${escapeHtml(control.telefon)}" style="color:var(--scout-blue);text-decoration:none;font-weight:600;">${escapeHtml(control.telefon)}</a>
            <span class="muted"> · någon på plats vid kontrollen</span></p>
          </div>` : ''}
        ${control.notering ? `
          <div class="mt-4">
            <div class="t-over" style="color:var(--utm-pink);">Intern notering</div>
            <p class="t-sm">${escapeHtml(control.notering)}</p>
          </div>` : ''}
        ${(control.ansvariga || []).length ? `
          <div class="mt-4">
            <div class="t-over" style="color:var(--scout-blue);">Kontrollansvariga</div>
            ${control.ansvariga.map(a => `
              <p class="t-sm" style="margin:4px 0;">${a.name ? `<strong>${escapeHtml(a.name)}</strong> · ` : ''}<a href="mailto:${escapeHtml(a.email)}" style="color:var(--scout-blue);">${escapeHtml(a.email)}</a></p>
            `).join('')}
          </div>` : ''}
      </div>
    </div>

    <h2 class="t-h2 mt-6">Instruktioner</h2>
    <div class="grid grid-2" id="inst-groups">
      ${(() => {
        const groups = allInstructionGroups(control);
        if (!groups.length) return '<div class="empty"><h3>Inga instruktioner</h3></div>';
        return groups.map(g => `
          <div class="card">
            <div class="row wrap" style="gap:6px;margin-bottom:var(--sp-3);">
              ${(g.avdelningar || []).length
                ? g.avdelningar.map(a => `<span class="badge badge-blue"><span class="dot ${shortOf(a)}"></span>${escapeHtml(a)}</span>`).join('')
                : '<span class="badge badge-gray">Default — alla andra</span>'}
            </div>
            <p class="t-serif" style="white-space:pre-wrap;color:var(--fg2);margin:0;">${escapeHtml(g.text || '')}</p>
          </div>
        `).join('');
      })()}
    </div>

    <h2 class="t-h2 mt-6">Rapporterade poäng</h2>
    <div id="scores"></div>
  `;

  // QR preview
  const qrHost = wrap.querySelector('#qr');
  renderQrToImg(url, 180)
    .then(img => { qrHost.innerHTML = ''; qrHost.appendChild(img); })
    .catch(() => { qrHost.innerHTML = '<span class="muted t-sm">QR-koden kunde inte laddas — ladda om sidan.</span>'; });

  // Course context for the placering map AND the PDF: the legs in/out of
  // this control — the kontrollant must see where patrols arrive from and
  // where to send them next.
  const { nodes: courseNodes, legs: courseLegList } = courseLegs(comp, allControls, track);
  const nodeIdx = courseNodes.findIndex(n => n.key === ctrlId);
  const legIn  = nodeIdx > 0 ? courseLegList[nodeIdx - 1] : null;
  const legOut = nodeIdx >= 0 && nodeIdx < courseLegList.length ? courseLegList[nodeIdx] : null;

  // Placering map — square, pinned on the control coordinates.
  const mapHost = wrap.querySelector('#placering-map');
  if (mapHost && control.lat && control.lng) {
    ensureLeaflet().then(L => {
      const map = L.map(mapHost, {
        zoomControl: true,
        scrollWheelZoom: false,
        dragging: true
      }).setView([control.lat, control.lng], 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© OSM'
      }).addTo(map);

      // Short dashed stubs of the course: gray = patrols arrive from there,
      // orange with arrow = send them onward that way.
      const drawStub = (leg, end, color, label, withArrow) => {
        const stub = legStub(leg, end, 150);
        if (!stub) return;
        L.polyline(stub.map(p => [p.lat, p.lng]), {
          color, weight: 4, opacity: 0.9, dashArray: '7 7', interactive: false
        }).addTo(map);
        const last = stub[stub.length - 1];
        const prev = stub[stub.length - 2] || stub[0];
        if (withArrow) {
          const p1 = map.project([prev.lat, prev.lng], 16);
          const p2 = map.project([last.lat, last.lng], 16);
          const deg = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;
          L.marker([last.lat, last.lng], {
            interactive: false,
            icon: L.divIcon({
              className: '',
              html: `<svg width="20" height="20" viewBox="-10 -10 20 20" style="transform:rotate(${deg}deg);display:block;"><path d="M-7 -6 L8 0 L-7 6 Z" fill="${color}" stroke="#ffffff" stroke-width="2"/></svg>`,
              iconSize: [20, 20], iconAnchor: [10, 10]
            })
          }).addTo(map);
        }
        if (label) {
          L.marker([last.lat, last.lng], {
            interactive: false,
            icon: L.divIcon({
              className: '',
              html: `<span style="display:inline-block;transform:translate(-50%,${withArrow ? '12px' : '-50%'});background:rgba(255,255,255,.92);border:1.5px solid ${color};color:${color};font:700 10px/1.4 Helvetica,Arial,sans-serif;padding:1px 6px;border-radius:9px;white-space:nowrap;">${escapeHtml(label)}</span>`,
              iconSize: [0, 0]
            })
          }).addTo(map);
        }
      };
      if (legIn)  drawStub(legIn,  'to',   '#8a8a8a', `från ${legIn.from.label}`, false);
      if (legOut) drawStub(legOut, 'from', '#E95F13', `till ${legOut.to.label}`,  true);

      L.circleMarker([control.lat, control.lng], {
        radius: 12, color: '#ffffff', weight: 3,
        fillColor: '#E95F13', fillOpacity: 0.98
      }).addTo(map);
      // Square containers often mount at zero height on first paint.
      setTimeout(() => map.invalidateSize(), 60);
    }).catch(e => { console.warn('[ESKIL] Leaflet load failed:', e); });
  }

  // Wire actions
  wrap.querySelector('#copy').addEventListener('click', async () => {
    await copyToClipboard(url);
    toast('Länk kopierad', 'success');
  });
  const pdfBtn = wrap.querySelector('#pdf');
  pdfBtn.addEventListener('click', () => withBusy(pdfBtn, 'Skapar PDF…', async () => {
    try {
      // "Patruller väntas" med i PDF:en så kontrollanterna vet när det drar
      // igång — samma estimat som visas på rapportsidan, kalibrerat mot
      // verkliga mellantider när rapporter finns.
      let etaWindow = null;
      try {
        const { listAllScores } = await import('../store.js');
        const allScores = await listAllScores(cid).catch(() => null);
        etaWindow = controlEtaWindow(comp, allControls, track, patrols, ctrlId, new Date(), allScores);
      } catch { /* bonus */ }
      // Kontrollens PDF är hela paketet: placering, instruktioner, nödinfo
      // och reservprotokoll — det som lämnas över till kontrollanten.
      const { internalManagement } = await import('../utils.js');
      await downloadControlPdf({ id: cid, ...comp }, { ...control, id: ctrlId }, {
        legIn, legOut, etaWindow,
        patrols, mgmt: internalManagement(comp), allControls
      });
    } catch (e) {
      console.error(e);
      toast('Kunde inte skapa PDF: ' + e.message, 'error');
    }
  }));
  if (canEdit) {
    wrap.querySelector('#edit').addEventListener('click', () => {
      openControlModal(cid, { id: ctrlId, ...control }, (id) => {
        if (!id) navigate(`/app/c/${cid}/controls`);
        else renderControlDetail(app, user, cid, ctrlId);
      }, { manageAnsvariga: isAdmin, inviteAnsvariga: !isAdmin && canEdit, comp });
    });
    const toggleBtn = wrap.querySelector('#toggle');
    toggleBtn.addEventListener('click', () => withBusy(toggleBtn, control.open ? 'Stänger…' : 'Öppnar…', async () => {
      try {
        await updateControl(cid, ctrlId, { open: !control.open });
        toast(control.open ? 'Kontroll stängd' : 'Kontroll öppnad', 'success');
        renderControlDetail(app, user, cid, ctrlId);
      } catch (e) { toast(e.message, 'error'); }
    }));
  }

  // Score subscription
  const scoresEl = wrap.querySelector('#scores');
  const patrolById = Object.fromEntries(patrols.map(p => [p.id, p]));

  // Sekretariat adjustment — mandatory motivation, old values preserved in
  // the score's history trail (visible in the justeringslogg on Poängtabellen).
  function openAdjustModal(s, patrol) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:480px;">
        <div class="modal-head"><h3>Justera poäng — ${escapeHtml(patrol.name || '')}</h3></div>
        <div class="modal-body field-group">
          <p class="muted t-sm" style="margin-top:0;">Nuvarande: <strong>${s.poang ?? 0} p</strong>${Number(s.extraPoang) ? ` + ${s.extraPoang} extra` : ''}.
          Det gamla värdet sparas i justeringsloggen tillsammans med din motivering.</p>
          <div class="grid grid-2">
            <div>
              <label class="field" for="adj-poang">Poäng</label>
              <input class="input" id="adj-poang" type="number" value="${s.poang ?? 0}">
            </div>
            <div>
              <label class="field" for="adj-extra">Extrapoäng</label>
              <input class="input" id="adj-extra" type="number" value="${s.extraPoang ?? 0}">
            </div>
          </div>
          <div>
            <label class="field" for="adj-note">Motivering (obligatorisk)</label>
            <textarea class="textarea" id="adj-note" rows="3" placeholder="Ex. Protest bifallen — kontrollanten rapporterade fel patrull."></textarea>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" id="adj-cancel">Avbryt</button>
          <button class="btn btn-primary" id="adj-save">Justera poängen</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    wireOverlayClose(overlay, close);
    overlay.querySelector('#adj-cancel').addEventListener('click', close);
    overlay.querySelector('#adj-save').addEventListener('click', (e) => withBusy(e.currentTarget, 'Justerar…', async () => {
      const adjustNote = overlay.querySelector('#adj-note').value.trim();
      if (!adjustNote) { toast('Motivering krävs för att justera poäng.', 'error'); return; }
      try {
        await adjustScore(cid, ctrlId, s.patrolId, s, {
          poang: Number(overlay.querySelector('#adj-poang').value) || 0,
          extraPoang: Number(overlay.querySelector('#adj-extra').value) || 0,
          adjustNote,
          adjustedBy: user?.email || ''
        });
        toast('Poängen justerad', 'success');
        close();
      } catch (err) { toast('Fel: ' + err.message, 'error'); }
    }));
  }
  let autoCloseFired = false;
  registerViewCleanup(() => { if (unsub) { unsub(); unsub = null; } });
  unsub = watchScoresForControl(cid, ctrlId, (rows) => {
    // Auto-close when every patrol has reported. Only admins can write the
    // control doc (per Firestore rules) so this runs just for admin viewers;
    // that's acceptable — the setting is per-competition and the control
    // simply stays open if no admin ever visits during the window.
    if (comp.autoCloseControls
        && control.open
        && !autoCloseFired
        && isAdmin
        && patrols.length > 0) {
      const reportedIds = new Set(rows.map(r => r.patrolId));
      const coverage = patrols.every(p => reportedIds.has(p.id));
      if (coverage) {
        autoCloseFired = true;
        updateControl(cid, ctrlId, { open: false })
          .then(() => {
            control.open = false;
            toast('Alla patruller rapporterat — kontrollen stängdes automatiskt', 'success');
            renderControlDetail(app, user, cid, ctrlId);
          })
          .catch(e => {
            autoCloseFired = false;
            console.warn('[ESKIL] auto-close failed:', e);
          });
      }
    }
    rows.sort((a, b) => {
      const A = patrolById[a.patrolId], B = patrolById[b.patrolId];
      return (A?.number || 0) - (B?.number || 0);
    });
    if (!rows.length) {
      scoresEl.innerHTML = `<div class="empty"><h3>Inga rapporter än</h3><p>När funktionären rapporterar poäng dyker de upp här.</p></div>`;
      return;
    }
    scoresEl.innerHTML = `
      <div class="table-wrap">
        <table class="t">
          <thead>
            <tr>
              <th>Nr</th><th>Patrull</th><th>Avdelning</th><th>Kår</th>
              <th class="num">Poäng</th><th class="num">Extra</th>
              <th>Tid</th><th>Notering</th>
              ${isAdmin ? '<th></th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${rows.map(s => {
              const p = patrolById[s.patrolId] || {};
              return `<tr>
                <td class="num">${p.number ?? ''}</td>
                <td><strong>${escapeHtml(p.name || s.patrolId)}</strong></td>
                <td>${escapeHtml(p.avdelning || '')}</td>
                <td>${escapeHtml(p.kar || '')}</td>
                <td class="num"><strong>${s.poang ?? 0}</strong>${s.adjustNote ? ` <span title="Justerad av sekretariatet">${icon('pencil', { size: 11 })}</span>` : ''}${(s.history || []).length ? ` <span class="muted t-sm" title="${(s.history || []).length} tidigare värden — se justeringsloggen på poängtabellen">${icon('history', { size: 11 })}${(s.history || []).length}</span>` : ''}</td>
                <td class="num">${s.extraPoang ?? 0}</td>
                <td class="muted t-sm">${formatTime(s.reportedAt)}</td>
                <td class="muted t-sm" style="max-width:22ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                  title="${escapeHtml(s.note || '')}">${escapeHtml(s.note || '')}</td>
                ${isAdmin ? `<td class="actions"><button class="btn btn-ghost btn-sm" data-adjust="${s.id}">Justera</button><button class="btn btn-ghost btn-sm" data-del="${s.id}" style="color:var(--utm-pink);">Radera</button></td>` : ''}
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
    if (isAdmin) {
      scoresEl.querySelectorAll('[data-adjust]').forEach(b => {
        b.addEventListener('click', () => {
          const s = rows.find(x => x.id === b.dataset.adjust);
          const patrol = patrolById[s.patrolId] || {};
          openAdjustModal(s, patrol);
        });
      });
      scoresEl.querySelectorAll('[data-del]').forEach(b => {
        b.addEventListener('click', async () => {
          if (await confirmDialog('Radera rapporterade poäng för denna patrull?')) {
            try { await deleteScore(cid, ctrlId, b.dataset.del); toast('Raderat'); }
            catch (e) { toast(e.message, 'error'); }
          }
        });
      });
    }
  });
}
