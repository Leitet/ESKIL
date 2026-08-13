import { layout, setTopbarCompetition } from '../app.js';
import { getCompetition, listPatrols, listControls, listAllScores, updateControl, updateCompetition, getTrack, listRegistrations } from '../store.js';
import { downloadResultsPdf, downloadResultsCsv, attachTrackStats } from '../results-export.js';
import { allowedAvdelningar, escapeHtml, rankPatrols, rankKarer, RANKING_RULES_TEXT, utslagRows, isNumSet, toast, withBusy, isCompAdminUser } from '../utils.js';
import { icon } from '../icons.js';
import { compTabs, compCrumbs, compLabel, setDocTitle } from '../nav.js';

export async function renderScoreboard(app, user, cid) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="muted">Laddar…</div>`;
  layout(wrap);

  const comp = await getCompetition(cid).catch(() => null);
  if (!comp) { wrap.innerHTML = `<div class="empty"><h3>Tävlingen hittades inte</h3></div>`; return; }
  setTopbarCompetition(cid, comp, user);

  const isAdmin = isCompAdminUser(comp, user);
  const canTogglePublic = isAdmin && !(comp.demo && user.role !== 'super-admin');

  setDocTitle('Poängtabell', compLabel(comp));
  wrap.innerHTML = `
    <div class="page-head">
      <div>
        ${compCrumbs(cid, comp, { label: 'Poängtabell' })}
        <h1 class="t-d2">Poängtabell</h1>
      </div>
      <div class="btn-row">
        ${isAdmin ? `<a class="btn btn-secondary btn-sm" href="/app/c/${cid}/ceremony" target="_blank" rel="noopener">${icon('trophy', { size: 14 })} Prisutdelning</a>
        <button class="btn btn-secondary btn-sm" id="dl-pdf">${icon('download', { size: 14 })} Resultat (PDF)</button>
        <button class="btn btn-ghost btn-sm" id="dl-csv">${icon('download', { size: 14 })} CSV</button>` : ''}
        ${canTogglePublic ? `<button class="btn btn-secondary btn-sm" id="toggle-public-scores"></button>` : ''}
        <button class="btn btn-ghost btn-sm" id="refresh">Uppdatera</button>
      </div>
    </div>

    ${compTabs(cid, 'scoreboard', comp, user)}

    <div class="scoreboard-controls">
      <label class="t-sm muted">Visa</label>
      <select class="select" id="view" style="max-width:220px;">
        <option value="overall">Overall (alla)</option>
        <optgroup label="Per avdelning">
          ${allowedAvdelningar(comp).map(a => `<option value="avd:${a.key}">${a.key}</option>`).join('')}
        </optgroup>
        <optgroup label="Per kår">
          <option value="by-kar">Gruppera per kår</option>
        </optgroup>
      </select>
      <label class="t-sm muted">Sortera</label>
      <select class="select" id="sort" style="max-width:200px;">
        <option value="total">Total poäng</option>
        <option value="avg">Snittpoäng</option>
        <option value="controls">Antal kontroller</option>
      </select>
    </div>

    <details class="rules-info mb-4">
      <summary>Placeringsregler</summary>
      <ol>
        ${RANKING_RULES_TEXT.map(r => `<li><strong>${escapeHtml(r.title)}</strong> — ${escapeHtml(r.rule)}</li>`).join('')}
      </ol>
    </details>

    <div id="content"></div>
    <div id="utslag-section"></div>
    <div id="adjust-log"></div>
  `;

  const content = wrap.querySelector('#content');
  content.innerHTML = `<div class="muted">Räknar poäng…</div>`;

  // Toggle for whether the public page shows points or only completion checks.
  const pubBtn = wrap.querySelector('#toggle-public-scores');
  const paintPubBtn = () => {
    if (!pubBtn) return;
    const pub = comp.publicScores !== false;
    pubBtn.innerHTML = pub
      ? `${icon('eye-off', { size: 14 })} Dölj poäng publikt`
      : `${icon('eye', { size: 14 })} Publicera poäng`;
    pubBtn.title = pub
      ? 'Publika sidan visar poäng och placeringar. Klicka för att bara visa gröna bockar för genomförda kontroller.'
      : 'Publika sidan visar bara gröna bockar för genomförda kontroller. Klicka för att publicera poängen.';
  };
  paintPubBtn();
  pubBtn?.addEventListener('click', async () => {
    const next = !(comp.publicScores !== false);
    try {
      await updateCompetition(cid, { publicScores: next });
      comp.publicScores = next;
      paintPubBtn();
      toast(next ? 'Poängen är nu publika' : 'Poängen är nu dolda på publika sidan', 'success');
    } catch (e) {
      toast('Fel: ' + e.message, 'error');
    }
  });

  let patrols = [], controls = [], scores = [];
  async function load() {
    try {
      [patrols, controls, scores] = await Promise.all([
        listPatrols(cid),
        listControls(cid),
        listAllScores(cid)
      ]);
      render();
      renderUtslagSection();
      renderAdjustLog();
      maybeAutoCloseReadyControls();
    } catch (e) {
      console.error(e);
      content.innerHTML = `<div class="empty"><h3>Kunde inte ladda</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  }

  // When the competition has autoCloseControls enabled, sweep every still-open
  // control and close the ones where every patrol has reported. This gives us
  // a bulk-processing opportunity whenever an admin visits the scoreboard —
  // the control-detail page handles the live case for a single control.
  async function maybeAutoCloseReadyControls() {
    if (!comp?.autoCloseControls || !isAdmin || !patrols.length) return;
    const patrolIds = new Set(patrols.map(p => p.id));
    const scoresByCtrl = {};
    for (const s of scores) {
      if (!patrolIds.has(s.patrolId)) continue;
      (scoresByCtrl[s.controlId] ||= new Set()).add(s.patrolId);
    }
    const ready = controls.filter(c =>
      c.open && (scoresByCtrl[c.id]?.size || 0) >= patrolIds.size
    );
    if (!ready.length) return;
    const closed = [];
    for (const c of ready) {
      try {
        await updateControl(cid, c.id, { open: false });
        c.open = false;
        closed.push(c);
      } catch (e) {
        console.warn('[ESKIL] auto-close failed for', c.id, e);
      }
    }
    if (closed.length) {
      toast(`Stängde ${closed.length} kontroll${closed.length === 1 ? '' : 'er'} automatiskt`, 'success');
    }
  }

  wrap.querySelector('#dl-pdf')?.addEventListener('click', (e) => withBusy(e.currentTarget, 'Skapar PDF…', async () => {
    try {
      const [track, regs] = await Promise.all([
        getTrack(cid).catch(() => null),
        listRegistrations(cid).catch(() => null)
      ]);
      await downloadResultsPdf(attachTrackStats(comp, controls, track), patrols, controls, scores, regs);
    } catch (err) { console.error(err); toast('Kunde inte skapa PDF: ' + err.message, 'error'); }
  }));
  wrap.querySelector('#dl-csv')?.addEventListener('click', () => {
    try { downloadResultsCsv(comp, patrols, controls, scores); }
    catch (err) { console.error(err); toast('Fel: ' + err.message, 'error'); }
  });

  wrap.querySelector('#refresh').addEventListener('click', () => {
    content.innerHTML = `<div class="muted">Uppdaterar…</div>`;
    load();
  });
  wrap.querySelector('#view').addEventListener('change', render);
  wrap.querySelector('#sort').addEventListener('change', render);

  // Tiebreaker panel: facit + every guess per utslagskontroll, closest first.
  // Shown to admins even before the facit is set (with a reminder) — the
  // public page only reveals it once the answer is in and scores are public.
  function renderUtslagSection() {
    const host = wrap.querySelector('#utslag-section');
    const uc = controls
      .filter(c => c.utslag)
      .sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
    if (!uc.length) { host.innerHTML = ''; return; }
    host.innerHTML = uc.map(c => {
      const per = {};
      scores.filter(s => s.controlId === c.id).forEach(s => { per[s.patrolId] = s; });
      const rows = utslagRows(c, patrols, per);
      const hasFacit = isNumSet(c.utslagSvar);
      return `
        <div class="card mt-6">
          <div class="t-over" style="color:var(--avent-orange);">Utslagsfråga — kontroll ${c.nummer ?? '?'} · ${escapeHtml(c.name || '')}</div>
          ${c.utslagFraga ? `<p class="t-serif" style="font-size:17px;margin:8px 0 4px;">"${escapeHtml(c.utslagFraga)}"</p>` : ''}
          ${hasFacit
            ? `<p style="margin:4px 0 var(--sp-2);">Rätt svar: <strong style="font-size:18px;color:var(--scout-blue);">${Number(c.utslagSvar)}</strong></p>`
            : `<p class="muted t-sm" style="margin:4px 0 var(--sp-2);">Rätt svar är inte angivet ännu — utslaget påverkar inte placeringarna.</p>`}
          ${isAdmin ? `
            <div class="row" style="gap:8px;margin:0 0 var(--sp-3);">
              <input class="input" type="number" step="any" data-facit-input="${escapeHtml(c.id)}" value="${hasFacit ? Number(c.utslagSvar) : ''}" placeholder="Rätt svar" style="max-width:130px;">
              <button class="btn btn-secondary btn-sm" data-facit-save="${escapeHtml(c.id)}">${hasFacit ? 'Ändra facit' : 'Sätt facit'}</button>
            </div>` : ''}
          <div class="table-wrap"><table class="t">
            <thead><tr><th class="num">#</th><th>Patrull</th><th class="num">Svar</th>${hasFacit ? '<th class="num">Från facit</th>' : ''}</tr></thead>
            <tbody>
              ${rows.map(r => `
                <tr>
                  <td class="num">${r.patrol.number ?? ''}</td>
                  <td><strong>${escapeHtml(r.patrol.name || '')}</strong> <span class="muted t-sm">${escapeHtml(r.patrol.kar || '')}</span></td>
                  <td class="num">${r.gissning != null ? r.gissning : '<span class="muted">—</span>'}</td>
                  ${hasFacit ? `<td class="num">${r.diff != null ? (r.diff === 0 ? '<span class="badge badge-green">Rätt!</span>' : '±' + r.diff) : '<span class="muted">—</span>'}</td>` : ''}
                </tr>
              `).join('')}
            </tbody>
          </table></div>
        </div>
      `;
    }).join('');

    // Inline-facit: sätt/ändra rätt svar direkt här i stället för att öppna
    // kontrollens stora redigeringsmodal mitt i slutspurten.
    host.querySelectorAll('[data-facit-save]').forEach(btn => btn.addEventListener('click', (e) => {
      const b = e.currentTarget;
      const id = b.dataset.facitSave;
      const inp = host.querySelector(`[data-facit-input="${CSS.escape(id)}"]`);
      const raw = (inp?.value ?? '').trim();
      if (raw === '' || !Number.isFinite(Number(raw))) { toast('Ange ett numeriskt svar.', 'error'); return; }
      withBusy(b, 'Sparar…', async () => {
        try {
          await updateControl(cid, id, { utslagSvar: Number(raw) });
          const local = controls.find(c => c.id === id);
          if (local) local.utslagSvar = Number(raw);
          renderUtslagSection();
          render();
          toast('Facit sparat — placeringarna är uppdaterade', 'success');
        } catch (err) { toast('Fel: ' + err.message, 'error'); }
      });
    }));
  }

  // Justeringslogg — every score that has been overwritten or adjusted, with
  // the old values, who and when. Admin/members only (this is the trust
  // trail for protests). Newest first.
  function renderAdjustLog() {
    const host = wrap.querySelector('#adjust-log');
    if (!isAdmin) { host.innerHTML = ''; return; }
    const ctrlById = Object.fromEntries(controls.map(c => [c.id, c]));
    const patrolById = Object.fromEntries(patrols.map(p => [p.id, p]));
    const entries = [];
    for (const s of scores) {
      const hist = s.history || [];
      if (!hist.length && !s.adjustNote) continue;
      // Each history entry was replaced by the NEXT one (or by the current doc).
      hist.forEach((h, i) => {
        const next = hist[i + 1] || s;
        entries.push({
          at: h.replacedAt || '',
          ctrl: ctrlById[s.controlId], patrol: patrolById[s.patrolId],
          from: h, to: next,
          byAdjust: !!next.adjustNote,
          adjustNote: next.adjustNote || '', adjustedBy: next.adjustedBy || '',
          reporter: next.reporter || ''
        });
      });
    }
    if (!entries.length) { host.innerHTML = ''; return; }
    entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const fmt = (v) => `${v.poang ?? 0}${Number(v.extraPoang) ? '+' + v.extraPoang : ''} p`;
    host.innerHTML = `
      <div class="card mt-6">
        <div class="t-over" style="color:var(--scout-blue);">Justeringslogg</div>
        <p class="muted t-sm" style="margin:4px 0 var(--sp-3);">Alla poäng som skrivits över eller justerats — gammalt värde, nytt värde, vem och när. Poäng justeras från kontrollens sida.</p>
        <div class="table-wrap"><table class="t">
          <thead><tr><th>När</th><th>Kontroll</th><th>Patrull</th><th class="num">Från</th><th class="num">Till</th><th>Av</th><th>Motivering</th></tr></thead>
          <tbody>
            ${entries.map(e => `
              <tr>
                <td class="muted t-sm" style="white-space:nowrap;">${e.at ? new Date(e.at).toLocaleString('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                <td>${e.ctrl ? `${e.ctrl.nummer ?? ''} · ${escapeHtml(e.ctrl.name || '')}` : '?'}</td>
                <td><strong>${escapeHtml(e.patrol?.name || '?')}</strong></td>
                <td class="num">${fmt(e.from)}</td>
                <td class="num"><strong>${fmt(e.to)}</strong></td>
                <td class="t-sm">${e.byAdjust ? `<span class="badge badge-blue">Sekretariat</span> ${escapeHtml(e.adjustedBy)}` : '<span class="muted">Kontrollant (omrapportering)</span>'}</td>
                <td class="t-sm">${escapeHtml(e.adjustNote || '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table></div>
      </div>
    `;
  }

  function computeTotals() {
    const map = {};
    for (const p of patrols) {
      map[p.id] = { ...p, total: 0, extra: 0, count: 0, perControl: {} };
    }
    for (const s of scores) {
      const row = map[s.patrolId];
      if (!row) continue;
      row.total += Number(s.poang) || 0;
      row.extra += Number(s.extraPoang) || 0;
      row.count += 1;
      row.perControl[s.controlId] = s;
    }
    for (const r of Object.values(map)) {
      r.avg = r.count ? (r.total / r.count) : 0;
      r.grand = r.total + r.extra;
    }
    return Object.values(map);
  }

  function render() {
    if (!patrols.length) {
      content.innerHTML = `<div class="empty"><h3>Inga patruller</h3><p>Lägg till patruller först.</p></div>`;
      return;
    }
    const view = wrap.querySelector('#view').value;
    const sort = wrap.querySelector('#sort').value;
    let rows = computeTotals();

    if (view === 'by-kar') {
      // Enrich patrols with rank info (so maxedCount is computed), then sum per kår.
      const rankedPatrols = rankPatrols(rows, controls);
      const grouped = {};
      rankedPatrols.forEach(r => {
        const k = r.kar || '(Ingen kår)';
        if (!grouped[k]) grouped[k] = { kar: k, patrols: [], total: 0, extra: 0, count: 0, maxedCount: 0 };
        grouped[k].patrols.push(r);
        grouped[k].total += r.total;
        grouped[k].extra += r.extra;
        grouped[k].count += r.count;
        grouped[k].maxedCount += r.maxedCount;
      });
      const karRaw = Object.values(grouped).map(g => ({
        ...g, grand: g.total + g.extra, avg: g.patrols.length ? g.total / g.patrols.length : 0
      }));
      return renderKarTable(content, rankKarer(karRaw), controls, sort);
    }

    if (view.startsWith('avd:')) {
      rows = rows.filter(r => r.avdelning === view.slice(4));
    }

    // For "total" — the primary ranking per the three-rule system. For
    // avg/controls the user explicitly asked for that sort, so honor it.
    if (sort === 'total') {
      rows = rankPatrols(rows, controls);
    } else {
      rows = rankPatrols(rows, controls);     // still compute rank (for display)
      rows.sort((a, b) => sort === 'avg' ? b.avg - a.avg : b.count - a.count);
    }

    renderPatrolTable(content, rows, controls, sort);
  }

  load();
}

function renderPatrolTable(container, rows, controls, sort) {
  const ctrls = [...controls].sort((a, b) => (a.nummer || 0) - (b.nummer || 0));
  if (!rows.length) {
    container.innerHTML = `<div class="empty"><h3>Inga patruller i vald vy</h3></div>`;
    return;
  }
  const useRank = sort === 'total';
  container.innerHTML = `
    <div class="table-wrap">
      <table class="t">
        <thead>
          <tr>
            <th class="num" style="width:60px;">${useRank ? 'Plats' : '#'}</th>
            <th>Patrull</th>
            <th>Avdelning</th>
            <th>Kår</th>
            <th class="num">Kontr.</th>
            <th class="num">Max</th>
            ${ctrls.map(c => `<th class="num" title="${escapeHtml(c.name || '')}">${c.nummer ?? ''}</th>`).join('')}
            <th class="num">Extra</th>
            <th class="num">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => {
            const place = useRank ? r.rank : (i + 1);
            return `
            <tr>
              <td class="num"><strong>${place === 1 && useRank ? icon('trophy', { size: 14, class: 'mr-1' }) + ' ' : ''}${place}</strong></td>
              <td><strong>${escapeHtml(r.name || '')}</strong> <span class="muted t-sm">#${r.number ?? ''}</span></td>
              <td><span class="dot ${shortOf(r.avdelning)}"></span>${escapeHtml(r.avdelning || '')}</td>
              <td>${escapeHtml(r.kar || '')}</td>
              <td class="num">${r.count}</td>
              <td class="num">${r.maxedCount || 0}</td>
              ${ctrls.map(c => {
                const s = r.perControl[c.id];
                return `<td class="num">${s ? (Number(s.poang) || 0) : '<span class="muted">—</span>'}</td>`;
              }).join('')}
              <td class="num">${r.extra || ''}</td>
              <td class="num"><strong style="color:var(--scout-blue);">${r.grand}</strong></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderKarTable(container, rows, controls, sort) {
  // rows already ranked via rankKarer in caller; only re-sort if user wanted
  // a non-rank sort.
  if (sort === 'avg') rows.sort((a, b) => b.avg - a.avg);
  else if (sort === 'controls') rows.sort((a, b) => b.count - a.count);
  const useRank = sort === 'total';
  container.innerHTML = `
    <div class="table-wrap">
      <table class="t">
        <thead>
          <tr>
            <th class="num" style="width:60px;">${useRank ? 'Plats' : '#'}</th>
            <th>Kår</th>
            <th class="num">Patruller</th>
            <th class="num">Kontroller</th>
            <th class="num">Max</th>
            <th class="num">Snitt / patrull</th>
            <th class="num">Extra</th>
            <th class="num">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => {
            const place = useRank ? r.rank : (i + 1);
            return `
            <tr>
              <td class="num"><strong>${place === 1 && useRank ? icon('trophy', { size: 14, class: 'mr-1' }) + ' ' : ''}${place}</strong></td>
              <td><strong>${escapeHtml(r.kar)}</strong></td>
              <td class="num">${r.patrols.length}</td>
              <td class="num">${r.count}</td>
              <td class="num">${r.maxedCount || 0}</td>
              <td class="num">${r.avg.toFixed(1)}</td>
              <td class="num">${r.extra || ''}</td>
              <td class="num"><strong style="color:var(--scout-blue);">${r.grand}</strong></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function shortOf(avd) {
  return { 'Spårare':'sp','Upptäckare':'up','Äventyrare':'av','Utmanare':'ut','Rover':'ro','Ledare':'le' }[avd] || 'le';
}
