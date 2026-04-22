import { layout, setTopbarCompetition } from '../app.js';
import {
  getCompetition, getControl, updateControl,
  watchScoresForControl, listPatrols, deleteScore
} from '../store.js';
import { escapeHtml, toast, copyToClipboard, reportUrl, confirmDialog, formatTime, allInstructionGroups, withBusy } from '../utils.js';
import { icon } from '../icons.js';
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

  const [comp, control, patrols] = await Promise.all([
    getCompetition(cid),
    getControl(cid, ctrlId),
    listPatrols(cid).catch(() => [])
  ]);
  if (!comp || !control) {
    wrap.innerHTML = `<div class="empty"><h3>Kontrollen hittades inte</h3></div>`;
    return;
  }
  setTopbarCompetition(cid, comp, user);
  const isAdmin = user.role === 'super-admin' || (comp.admins || []).includes(user.uid);
  const url = reportUrl(cid, ctrlId);
  const shortOf = (avd) => ({ 'Spårare':'sp','Upptäckare':'up','Äventyrare':'av','Utmanare':'ut','Rover':'ro','Ledare':'le' }[avd] || 'le');

  wrap.innerHTML = `
    <div class="page-head">
      <div>
        <div class="t-over" style="color:var(--avent-orange);">${escapeHtml(comp.shortName || '')} · Kontroll</div>
        <h1 class="t-d2">${escapeHtml(control.nummer ?? '')}. ${escapeHtml(control.name || '')}</h1>
        <p class="muted">${control.open ? '<span class="badge badge-green">Öppen</span>' : '<span class="badge badge-gray">Stängd</span>'} Max ${control.maxPoang || 0} · Min ${control.minPoang || 0}${control.extraPoang ? ' · Extra ' + control.extraPoang : ''}</p>
      </div>
      <div class="btn-row">
        <a class="btn btn-ghost" href="/app/c/${cid}/controls" data-link>${icon('arrow-left', { size: 16 })} Alla kontroller</a>
        ${isAdmin ? '<button class="btn btn-secondary" id="edit">Redigera</button>' : ''}
        ${isAdmin ? `<button class="btn btn-primary" id="toggle">${control.open ? 'Stäng' : 'Öppna'} för rapport</button>` : ''}
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <h3 class="t-h3">Rapporteringslänk</h3>
        <p class="muted t-sm">Distribuera denna QR-kod eller länk till kontrollfunktionären. Länken är hemlig — dela den bara med rätt person.</p>
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
        ${control.notering ? `
          <div class="mt-4">
            <div class="t-over" style="color:var(--utm-pink);">Intern notering</div>
            <p class="t-sm">${escapeHtml(control.notering)}</p>
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
  renderQrToImg(url, 180).then(img => { qrHost.innerHTML = ''; qrHost.appendChild(img); });

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
      await downloadControlPdf({ id: cid, ...comp }, { ...control, id: ctrlId });
    } catch (e) {
      console.error(e);
      toast('Kunde inte skapa PDF: ' + e.message, 'error');
    }
  }));
  if (isAdmin) {
    wrap.querySelector('#edit').addEventListener('click', () => {
      openControlModal(cid, { id: ctrlId, ...control }, (id) => {
        if (!id) navigate(`/app/c/${cid}/controls`);
        else renderControlDetail(app, user, cid, ctrlId);
      });
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
  let autoCloseFired = false;
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
                <td class="num"><strong>${s.poang ?? 0}</strong></td>
                <td class="num">${s.extraPoang ?? 0}</td>
                <td class="muted t-sm">${formatTime(s.reportedAt)}</td>
                <td class="muted t-sm">${escapeHtml((s.note || '').slice(0, 40))}</td>
                ${isAdmin ? `<td class="actions"><button class="btn btn-ghost btn-sm" data-del="${s.id}" style="color:var(--utm-pink);">Radera</button></td>` : ''}
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
    if (isAdmin) {
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
