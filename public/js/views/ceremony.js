// Prisutdelningsläge — a fullscreen big-screen mode for the award ceremony.
// Pick a category (avdelning or Overall), then reveal the podium with drama:
// third place… second place… FIRST PLACE — advanced by click/space/arrow so
// the speaker controls the pace. Handles shared places (everyone on the same
// rank revealed together). Pairs with the hidden-public-scores mode: keep the
// scoreboard dark, reveal on stage.

import { getCompetition, listPatrols, listControls, listAllScores } from '../store.js';
import { AVDELNINGAR, escapeHtml, rankPatrols, avdShort } from '../utils.js';
import { registerViewCleanup } from '../app.js';
import { navigate } from '../router.js';

const PLACE_LABELS = { 3: 'På tredje plats…', 2: 'På andra plats…', 1: 'Och segrare är…' };

export async function renderCeremony(app, user, cid) {
  app.innerHTML = `<div class="ceremony"><div class="cer-loading">Laddar…</div></div>`;

  const exitLink = `<a class="cer-close" href="/app/c/${cid}/scoreboard" data-link aria-label="Till poängtabellen" title="Till poängtabellen">✕</a>`;
  let comp, patrols, controls, scores;
  try {
    [comp, patrols, controls, scores] = await Promise.all([
      getCompetition(cid), listPatrols(cid), listControls(cid), listAllScores(cid)
    ]);
  } catch (e) {
    app.innerHTML = `<div class="ceremony">${exitLink}<div class="cer-loading">Kunde inte ladda: ${escapeHtml(e.message)}</div></div>`;
    return;
  }
  if (!comp) { app.innerHTML = `<div class="ceremony">${exitLink}<div class="cer-loading">Tävlingen hittades inte.</div></div>`; return; }
  document.title = `Prisutdelning · ${comp.shortName || comp.name || 'ESKIL'}`;

  // Totals + ranking (same math as the scoreboard).
  const map = {};
  for (const p of patrols) map[p.id] = { ...p, total: 0, extra: 0, count: 0, perControl: {} };
  for (const s of scores) {
    const row = map[s.patrolId]; if (!row) continue;
    row.total += Number(s.poang) || 0;
    row.extra += Number(s.extraPoang) || 0;
    row.count += 1;
    row.perControl[s.controlId] = s;
  }
  Object.values(map).forEach(r => { r.grand = r.total + r.extra; });
  const totals = Object.values(map);

  const categories = [
    ...AVDELNINGAR
      .filter(a => totals.some(t => t.avdelning === a.key && t.grand > 0))
      .map(a => ({ key: a.key, label: a.key, short: a.short, rows: () => totals.filter(t => t.avdelning === a.key) })),
    ...(totals.some(t => t.grand > 0) ? [{ key: '__overall', label: 'Overall — hela tävlingen', short: 'le', rows: () => totals }] : [])
  ];

  const root = document.createElement('div');
  root.className = 'ceremony';
  app.innerHTML = '';
  app.appendChild(root);

  // Always-visible exit — the view used to be a dead end: no link anywhere,
  // and every click advanced the reveal. Lives outside the re-rendered stage.
  const closeBtn = document.createElement('a');
  closeBtn.className = 'cer-close';
  closeBtn.href = `/app/c/${cid}/scoreboard`;
  closeBtn.setAttribute('data-link', '');
  closeBtn.setAttribute('aria-label', 'Avsluta prisutdelningen');
  closeBtn.title = 'Avsluta prisutdelningen';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', (e) => e.stopPropagation());
  const stage = document.createElement('div');
  root.append(closeBtn, stage);

  let state = { view: 'menu' };
  const done = new Set(); // categories already presented

  // Build the reveal steps for a category: intro → each podium rank group
  // (worst → best, shared ranks together) → full podium.
  function buildSteps(cat) {
    const ranked = rankPatrols(cat.rows(), controls);
    const podium = ranked.filter(r => r.rank <= 3);
    const groups = {};
    for (const r of podium) (groups[r.rank] ||= []).push(r);
    const order = Object.keys(groups).map(Number).sort((a, b) => b - a); // 3, 2, 1
    return [
      { type: 'intro' },
      ...order.map(rank => ({ type: 'reveal', rank, rows: groups[rank] })),
      { type: 'podium', podium: ranked.slice(0, Math.max(podium.length, 3)) }
    ];
  }

  function render() {
    if (state.view === 'menu') {
      stage.innerHTML = `
        <div class="cer-menu">
          <div class="cer-eyebrow">ESKIL · PRISUTDELNING</div>
          <h1 class="cer-title">${escapeHtml(comp.name || '')}</h1>
          <p class="cer-sub">Välj kategori — avslöjas i tur och ordning: trea, tvåa, etta.</p>
          <div class="cer-cats">
            ${categories.map(c => `
              <button class="cer-cat ${done.has(c.key) ? 'is-done' : ''}" data-cat="${escapeHtml(c.key)}">
                <span class="dot ${c.short}"></span>${escapeHtml(c.label)}
                ${done.has(c.key) ? '<span class="cer-check">✓</span>' : ''}
              </button>
            `).join('')}
          </div>
          ${categories.length === 0 ? '<p class="cer-sub">Inga poäng rapporterade ännu.</p>' : ''}
          ${(() => {
            // Slutspurtsvarning: pallen kan ändras så länge rapporter saknas.
            const byCtrl = {};
            for (const s of scores) (byCtrl[s.controlId] ||= new Set()).add(s.patrolId);
            const missing = controls.reduce((sum, c) => sum + patrols.filter(p => !(byCtrl[c.id]?.has(p.id))).length, 0);
            return missing > 0 ? `<p class="cer-warn">OBS: ${missing} rapport${missing === 1 ? '' : 'er'} saknas ännu — pallen kan ändras. Se "Saknade rapporter" i poängtabellen.</p>` : '';
          })()}
          <p class="cer-hint">Mellanslag/klick = nästa · Esc = tillbaka hit · ✕ = till poängtabellen</p>
        </div>
      `;
      stage.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', (e) => {
        e.stopPropagation();
        const cat = categories.find(c => c.key === b.dataset.cat);
        state = { view: 'cat', cat, steps: buildSteps(cat), idx: 0 };
        render();
      }));
      return;
    }

    const { cat, steps, idx } = state;
    const step = steps[idx];
    const catLabel = cat.key === '__overall' ? 'Overall' : cat.label;

    if (step.type === 'intro') {
      stage.innerHTML = `
        <div class="cer-stage">
          <div class="cer-eyebrow">${escapeHtml(comp.shortName || '')} ${comp.year ? '· ' + comp.year : ''}</div>
          <h1 class="cer-cat-title"><span class="dot ${cat.short}" style="width:22px;height:22px;"></span> ${escapeHtml(catLabel)}</h1>
          <p class="cer-sub cer-pulse">Är ni redo?</p>
          <p class="cer-hint">Tryck för att börja avslöja pallen</p>
        </div>
      `;
    } else if (step.type === 'reveal') {
      const label = PLACE_LABELS[step.rank] || `Plats ${step.rank}…`;
      const shared = step.rows.length > 1;
      stage.innerHTML = `
        <div class="cer-stage">
          <div class="cer-eyebrow">${escapeHtml(catLabel)}</div>
          <p class="cer-place-label">${shared ? `Delad ${step.rank === 1 ? 'förstaplats' : step.rank === 2 ? 'andraplats' : 'tredjeplats'}…` : escapeHtml(label)}</p>
          <div class="cer-reveal ${step.rank === 1 ? 'is-gold' : ''}">
            ${step.rows.map(r => `
              <div class="cer-winner">
                <div class="cer-medal">${step.rank}</div>
                <div>
                  <div class="cer-name">${escapeHtml(r.name || '')}</div>
                  <div class="cer-meta">${escapeHtml(r.kar || '')} · ${r.grand} poäng</div>
                </div>
              </div>
            `).join('')}
          </div>
          <p class="cer-hint">${idx < steps.length - 1 ? 'Tryck för nästa' : ''}</p>
        </div>
      `;
    } else { // podium
      stage.innerHTML = `
        <div class="cer-stage">
          <div class="cer-eyebrow">${escapeHtml(catLabel)}</div>
          <h2 class="cer-podium-title">Grattis!</h2>
          <div class="cer-podium">
            ${step.podium.map(r => `
              <div class="cer-podium-row rank-${r.rank <= 3 ? r.rank : 'x'}">
                <span class="cer-medal small">${r.rank}</span>
                <span class="cer-name-sm">${escapeHtml(r.name || '')}</span>
                <span class="cer-meta">${escapeHtml(r.kar || '')}</span>
                <span class="cer-points">${r.grand} p</span>
              </div>
            `).join('')}
          </div>
          <p class="cer-hint">Tryck för att gå till kategorivalet</p>
        </div>
      `;
    }
  }

  function advance() {
    if (state.view !== 'cat') return;
    if (state.idx < state.steps.length - 1) {
      state.idx++;
    } else {
      done.add(state.cat.key);
      state = { view: 'menu' };
    }
    render();
  }

  const onClick = (e) => {
    if (state.view === 'cat') advance();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      if (state.view === 'cat') { state = { view: 'menu' }; render(); }
      else navigate(`/app/c/${cid}/scoreboard`);
      return;
    }
    if ([' ', 'Enter', 'ArrowRight', 'PageDown'].includes(e.key)) {
      e.preventDefault();
      advance();
    }
  };
  root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  registerViewCleanup(() => {
    document.removeEventListener('keydown', onKey);
  });

  render();
}
