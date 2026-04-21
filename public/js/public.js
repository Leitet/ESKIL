// ESKIL — public landing page for a competition.
// No auth. Reads are public (competitions, patrols, controls, scores).
// URL pattern: /t/<competitionId>[/<tab>]
// Tabs: overview (default), patrols, scoreboard.

import { db, doc, onSnapshot, collection } from './firebase.js';
import { getCompetition, listPatrols, listControls } from './store.js';
import {
  AVDELNINGAR, escapeHtml, formatDate, publicManagement, patrolStartTime,
  startFinishPoints, parkingPoint, rankPatrols, rankKarer, RANKING_RULES_TEXT
} from './utils.js';
import { ensureLeaflet } from './leaflet.js';
import { icon } from './icons.js';

const root = document.getElementById('root');

function avdSlug(avd) {
  return { 'Spårare':'sp','Upptäckare':'up','Äventyrare':'av','Utmanare':'ut','Rover':'ro','Ledare':'le' }[avd] || 'le';
}
function avdImg(avd) {
  return {
    'Spårare':    '/assets/age-sparare.png',
    'Upptäckare': '/assets/age-upptackare.png',
    'Äventyrare': '/assets/age-aventyrare.png',
    'Utmanare':   '/assets/age-utmanare.png',
    'Rover':      '/assets/age-rover.png'
  }[avd] || null;
}

// Inline scout-symbol SVG so we can color it via currentColor — loading it as
// `<img>` ignored CSS color and gave flaky results when filter-inverted.
const SCOUT_SYMBOL_SVG = `<svg class="avd-scout-symbol" viewBox="0 0 200 240" aria-hidden="true" fill="currentColor">
  <path d="M100 12 C 92 38, 90 60, 90 92 C 90 118, 95 138, 100 158 C 105 138, 110 118, 110 92 C 110 60, 108 38, 100 12 Z"/>
  <path d="M38 32 C 44 62, 52 86, 68 108 C 78 122, 84 132, 82 152 C 78 138, 70 132, 58 128 C 44 124, 34 118, 30 102 C 26 82, 28 58, 38 32 Z"/>
  <path d="M162 32 C 156 62, 148 86, 132 108 C 122 122, 116 132, 118 152 C 122 138, 130 132, 142 128 C 156 124, 166 118, 170 102 C 174 82, 172 58, 162 32 Z"/>
  <ellipse cx="100" cy="170" rx="62" ry="10"/>
  <rect x="48" y="184" width="104" height="6"/>
  <rect x="54" y="196" width="92" height="6"/>
  <path d="M100 208 C 94 216, 92 224, 96 232 L 104 232 C 108 224, 106 216, 100 208 Z"/>
</svg>`;

function avdIllustration(avd) {
  if (avd === 'Ledare') return SCOUT_SYMBOL_SVG;
  const src = avdImg(avd);
  return src ? `<img src="${src}" alt="">` : '';
}

function parsePath() {
  const parts = location.pathname.split('/').filter(Boolean); // ['t', cid, tab?]
  if (parts[0] !== 't' || !parts[1]) return null;
  return { cid: parts[1], tab: parts[2] || 'overview' };
}

function setTab(cid, tab) {
  history.pushState({}, '', `/t/${cid}${tab === 'overview' ? '' : '/' + tab}`);
  render();
}

// --- Global state -----------------------------------------------------------
let comp = null;
let patrols = [];
let controls = [];
let scoresByControl = {}; // ctrlId -> score[]
const subscribedScoreCtrls = new Set();
let unsubs = [];

function cleanup() {
  unsubs.forEach(u => { try { u(); } catch {} });
  unsubs = [];
}

async function boot() {
  const parsed = parsePath();
  if (!parsed) return renderNotFound('Ogiltig länk.');
  const { cid } = parsed;

  try {
    [comp, patrols, controls] = await Promise.all([
      getCompetition(cid),
      listPatrols(cid),
      listControls(cid)
    ]);
  } catch (e) {
    return renderNotFound('Kunde inte ladda tävlingen: ' + e.message);
  }
  if (!comp) return renderNotFound('Tävlingen hittades inte.');

  // Live updates for competition, patrols, and every control's scores
  unsubs.push(onSnapshot(doc(db, 'competitions', cid), snap => {
    if (snap.exists()) { comp = { id: cid, ...snap.data() }; render(); }
  }));
  unsubs.push(onSnapshot(collection(db, 'competitions', cid, 'patrols'), snap => {
    patrols = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }));
  unsubs.push(onSnapshot(collection(db, 'competitions', cid, 'controls'), snap => {
    controls = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Attach a score subscription per control — track subscribed IDs in a
    // dedicated set so we don't double-subscribe. Previously we compared to
    // `controls` itself, which was pre-populated via listControls() — meaning
    // every control looked "already subscribed" and no score listeners were
    // attached.
    for (const c of controls) {
      if (subscribedScoreCtrls.has(c.id)) continue;
      subscribedScoreCtrls.add(c.id);
      const u = onSnapshot(
        collection(db, 'competitions', cid, 'controls', c.id, 'scores'),
        s => { scoresByControl[c.id] = s.docs.map(d => ({ id: d.id, ...d.data() })); render(); }
      );
      unsubs.push(u);
    }
    render();
  }));

  render();
}

window.addEventListener('popstate', () => render());

async function renderLeafletMap(withPos, sfPoints = [], park = null) {
  const host = document.getElementById('pub-map');
  if (!host || (!withPos.length && !sfPoints.length && !park)) return;
  try {
    const L = await ensureLeaflet();
    host.innerHTML = '';
    const allPts = [
      ...withPos.map(c => [c.lat, c.lng]),
      ...sfPoints.map(p => [p.lat, p.lng]),
      ...(park ? [[park.lat, park.lng]] : [])
    ];
    const avgLat = allPts.reduce((s, p) => s + p[0], 0) / allPts.length;
    const avgLng = allPts.reduce((s, p) => s + p[1], 0) / allPts.length;
    const map = L.map(host, { zoomControl: true, scrollWheelZoom: false }).setView([avgLat, avgLng], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap'
    }).addTo(map);

    // Dashed route: start → controls in nummer order → finish (same point if mode='same')
    const ordered = [...withPos].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
    const startPt = sfPoints.find(p => p.kind === 'start' || p.kind === 'startfinish');
    const finishPt = sfPoints.find(p => p.kind === 'finish') || startPt;
    const linePoints = [
      ...(startPt ? [[startPt.lat, startPt.lng]] : []),
      ...ordered.map(c => [c.lat, c.lng]),
      ...(finishPt ? [[finishPt.lat, finishPt.lng]] : [])
    ];
    if (linePoints.length >= 2) {
      L.polyline(linePoints, {
        color: '#003660', weight: 3, opacity: 0.7, dashArray: '6 8'
      }).addTo(map);
    }

    // Control markers — label = only the number
    for (const c of ordered) {
      L.circleMarker([c.lat, c.lng], {
        radius: 14, color: '#ffffff', weight: 3, fillColor: '#E95F13', fillOpacity: 0.95
      })
        .bindTooltip(String(c.nummer ?? '?'), { permanent: true, direction: 'center', className: 'map-label' })
        .addTo(map);
    }

    // Start/finish markers — distinctive yellow
    for (const p of sfPoints) {
      L.circleMarker([p.lat, p.lng], {
        radius: 16, color: '#003660', weight: 3, fillColor: '#E2E000', fillOpacity: 1
      })
        .bindTooltip(p.label, { permanent: true, direction: 'center', className: 'map-label map-label-sf' })
        .addTo(map);
    }

    // Parking marker — blue pill with square-parking icon
    if (park) {
      L.circleMarker([park.lat, park.lng], {
        radius: 16, color: '#ffffff', weight: 3, fillColor: '#003660', fillOpacity: 1
      })
        .bindTooltip(icon('square-parking', { size: 18, stroke: 2.5 }), {
          permanent: true, direction: 'center', className: 'map-label map-label-park'
        })
        .addTo(map);
    }

    if (allPts.length > 1) {
      map.fitBounds(L.latLngBounds(allPts).pad(0.2));
    }
  } catch (e) {
    console.warn('Leaflet load failed; leaving map host empty.', e);
  }
}

// --- Render -----------------------------------------------------------------
function render() {
  const parsed = parsePath(); if (!parsed) return;
  const tab = parsed.tab;
  const cid = parsed.cid;

  const totals = computeTotals();

  root.innerHTML = `
    ${renderHero()}
    <div class="pub-tabs-bar">
      <div class="pub-tabs">
        <a data-tab="overview"   href="/t/${cid}"            class="${tab==='overview'?'active':''}">Översikt</a>
        <a data-tab="patrols"    href="/t/${cid}/patrols"    class="${tab==='patrols'?'active':''}">Patruller</a>
        <a data-tab="scoreboard" href="/t/${cid}/scoreboard" class="${tab==='scoreboard'?'active':''}">Poängtabell</a>
      </div>
    </div>
    <main class="page">
      ${tab === 'overview'   ? renderOverview(totals)  : ''}
      ${tab === 'patrols'    ? renderPatrols(totals)   : ''}
      ${tab === 'scoreboard' ? renderScoreboard(totals): ''}
    </main>
    ${renderFooter()}
  `;

  root.querySelectorAll('[data-tab]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      setTab(cid, a.dataset.tab);
    });
  });

  if (tab === 'overview') {
    const withPos = controls.filter(c => c.lat && c.lng);
    const sfPoints = startFinishPoints(comp);
    const park = parkingPoint(comp);
    if (withPos.length || sfPoints.length || park) renderLeafletMap(withPos, sfPoints, park);
  }
}

function renderHero() {
  const openCount = controls.filter(c => c.open).length;
  const statusLabel = openCount > 0 ? 'Tävlingen pågår · live' : 'Tävlingen är inte aktiv';
  return `
    <header class="pub-hero">
      <div class="pub-hero-pattern"></div>
      <img class="pub-hero-symbol" src="/assets/scout-symbol.svg" alt="" aria-hidden="true">
      <div class="page">
        <div class="pub-hero-top">
          <div class="pub-brand">
            <img src="/assets/logo-scouterna-tagline-white.svg" alt="Scouterna">
            <span class="divider"></span>
            <span class="sublabel">ESKIL</span>
          </div>
          ${openCount > 0 ? `<div class="status-pill"><span class="dot-live"></span>${escapeHtml(statusLabel)}</div>` : ''}
        </div>
        <div class="t-over" style="color:var(--rover-yellow);">${escapeHtml(comp.shortName || '')} · ${comp.year || ''}</div>
        <h1>${escapeHtml(comp.name || '')}</h1>
        ${comp.description ? `<p class="lede">${escapeHtml(comp.description)}</p>` : ''}
        <div class="meta">
          ${comp.date ? `<span><b>${escapeHtml(formatDate(comp.date))}</b> · datum</span>` : ''}
          ${comp.location ? `<span><b>${escapeHtml(comp.location)}</b> · plats</span>` : ''}
          ${comp.organizer ? `<span><b>${escapeHtml(comp.organizer)}</b> · arrangör</span>` : ''}
        </div>
      </div>
    </header>
  `;
}

function renderFooter() {
  return `
    <footer class="pub-foot">
      <div class="page">
        <div style="display:flex;align-items:center;gap:var(--sp-4);">
          <img src="/assets/logo-scouterna-tagline-white.svg" alt="Scouterna">
          <span>· ESKIL · ${comp?.year || ''}</span>
        </div>
        <span class="muted">Poängtabellen uppdateras direkt när kontrollanter rapporterar.</span>
      </div>
    </footer>
  `;
}

// --- Tab: Overview ---------------------------------------------------------
function renderOverview(totals) {
  const avdCounts = {};
  patrols.forEach(p => { avdCounts[p.avdelning] = (avdCounts[p.avdelning] || 0) + 1; });
  const karer = new Set(patrols.map(p => p.kar).filter(Boolean));

  const podium = [...totals].sort((a,b) => b.grand - a.grand).slice(0, 3);

  return `
    <section class="pub-kpis">
      <div class="pub-kpi"><div class="label">Patruller</div><div class="val">${patrols.length}</div></div>
      <div class="pub-kpi"><div class="label">Kontroller</div><div class="val">${controls.length}</div></div>
      <div class="pub-kpi"><div class="label">Kårer</div><div class="val">${karer.size}</div></div>
      <div class="pub-kpi"><div class="label">Öppna just nu</div><div class="val">${controls.filter(c=>c.open).length}</div></div>
    </section>

    ${podium.length && podium[0].grand > 0 ? `
      <div class="pub-section-head"><h2 class="t-h2">Topp tre · Overall</h2><span class="muted">Live</span></div>
      <div class="podium">
        ${renderPodiumStep(podium[1], 2, 'p2')}
        ${renderPodiumStep(podium[0], 1, 'p1')}
        ${renderPodiumStep(podium[2], 3, 'p3')}
      </div>
    ` : ''}

    <div class="pub-section-head"><h2 class="t-h2">Avdelningar</h2><span class="muted">Klicka för detaljer</span></div>
    <div class="avd-cards">
      ${AVDELNINGAR.filter(a => avdCounts[a.key]).map(a => `
        <a class="avd-card ${avdSlug(a.key)}" data-avd="${a.key}" href="#">
          <div class="top">
            <span class="label">${a.key}</span>
            ${avdIllustration(a.key)}
          </div>
          <div class="bottom">
            <span class="count-label">Patruller</span>
            <span class="count">${avdCounts[a.key]}</span>
          </div>
        </a>
      `).join('')}
    </div>

    ${renderManagement()}
    ${renderMap()}
  `;
}

function renderManagement() {
  const active = publicManagement(comp);
  if (!active.length) return '';
  return `
    <div class="pub-section-head"><h2 class="t-h2">Tävlingsledning</h2><span class="muted">Kontakta vid frågor</span></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:var(--sp-4);margin-bottom:var(--sp-8);">
      ${active.map(r => `
        <div class="card">
          <div class="t-over" style="color:var(--scout-blue);">${escapeHtml(r.label)}</div>
          ${r.name ? `<h3 class="t-h4" style="margin:6px 0 4px;">${escapeHtml(r.name)}</h3>` : ''}
          ${r.phone ? `<div class="mt-2"><a href="tel:${escapeHtml(r.phone)}" class="mono" style="color:var(--scout-blue);text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:6px;">${icon('phone', { size: 16 })} ${escapeHtml(r.phone)}</a></div>` : ''}
          ${r.email ? `<div class="mt-2"><a href="mailto:${escapeHtml(r.email)}" style="color:var(--scout-blue);word-break:break-all;display:inline-flex;align-items:center;gap:6px;">${icon('mail', { size: 16 })} ${escapeHtml(r.email)}</a></div>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function renderPodiumStep(row, rank, cls) {
  if (!row) return `<div class="podium-step ${cls}"><div class="rank">${rank}:a</div><div class="score">—</div></div>`;
  return `
    <div class="podium-step ${cls}">
      <div class="rank">${rank}:a plats</div>
      <div class="score">${row.grand}</div>
      <div class="p-name">${escapeHtml(row.name || '')}</div>
      <div class="p-kar">${escapeHtml(row.kar || '')}</div>
      <div class="mt-2"><span class="dot ${avdSlug(row.avdelning)}"></span>${escapeHtml(row.avdelning || '')}</div>
    </div>
  `;
}

function renderMap() {
  const withPos = controls.filter(c => c.lat && c.lng);
  const sf = startFinishPoints(comp);
  if (!withPos.length && !sf.length) return '';
  const allPts = [...withPos.map(c => [c.lat, c.lng]), ...sf.map(p => [p.lat, p.lng])];
  const avgLat = allPts.reduce((s, p) => s + p[0], 0) / allPts.length;
  const avgLng = allPts.reduce((s, p) => s + p[1], 0) / allPts.length;
  const osm = `https://www.openstreetmap.org/#map=14/${avgLat.toFixed(4)}/${avgLng.toFixed(4)}`;
  return `
    <div class="pub-section-head"><h2 class="t-h2">Karta</h2><span class="muted">${withPos.length} kontroller${sf.length ? ' · start/mål' : ''}</span></div>
    <div class="map-card">
      <div id="pub-map"></div>
      <div class="foot">
        <span>Kontrollpositioner — exakta platser kan skilja något.</span>
        <a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="${osm}">Öppna i OpenStreetMap</a>
      </div>
    </div>
  `;
}

// --- Tab: Patrols ----------------------------------------------------------
let avdFilter = null;
function renderPatrols(totals) {
  const rows = patrols
    .filter(p => !avdFilter || p.avdelning === avdFilter)
    .slice()
    .sort((a,b) => (a.number||0) - (b.number||0) || (a.name||'').localeCompare(b.name||'', 'sv'));
  const totalMap = Object.fromEntries(totals.map(t => [t.id, t]));

  const ctrlCount = controls.length || 1;

  return `
    <div class="pub-section-head"><h2 class="t-h2">Patruller</h2><span class="muted">${rows.length} av ${patrols.length}</span></div>
    <div class="avd-filter">
      <button class="${avdFilter === null ? 'active' : ''}" data-avd="">Alla</button>
      ${AVDELNINGAR.filter(a => patrols.some(p => p.avdelning === a.key))
        .map(a => `<button class="${avdFilter === a.key ? 'active' : ''}" data-avd="${a.key}"><span class="dot ${avdSlug(a.key)}"></span>${a.key}</button>`)
        .join('')}
    </div>

    ${rows.length === 0 ? `
      <div class="empty"><h3>Inga patruller att visa</h3></div>
    ` : `
      <div class="pat-grid">
        ${rows.map(p => {
          const t = totalMap[p.id];
          const done = t?.count || 0;
          const pct = Math.round((done / ctrlCount) * 100);
          const stime = patrolStartTime(comp, p, patrols.length);
          return `<div class="pat-card">
            <div class="n">#${p.number ?? '—'} · <span class="dot ${avdSlug(p.avdelning)}"></span>${escapeHtml(p.avdelning || '')}${stime ? ` · <span class="mono" style="color:var(--scout-blue);">${escapeHtml(stime)}</span>` : ''}</div>
            <div class="name">${escapeHtml(p.name || '')}</div>
            <div class="kar">${escapeHtml(p.kar || '')}</div>
            <div class="progress"><span style="width:${pct}%"></span></div>
            <div class="progress-label"><span>${done} / ${ctrlCount} kontroller</span><span>${t?.grand || 0} p</span></div>
          </div>`;
        }).join('')}
      </div>
    `}
  `;
}

// --- Tab: Scoreboard -------------------------------------------------------
let scoreView = 'overall'; // 'overall' | 'avd:<key>' | 'kar'
function renderScoreboard(totals) {
  const tabs = [
    { key: 'overall', label: 'Overall' },
    ...AVDELNINGAR.filter(a => patrols.some(p => p.avdelning === a.key))
      .map(a => ({ key: 'avd:' + a.key, label: a.key })),
    { key: 'kar', label: 'Per kår' }
  ];

  let body;
  if (scoreView === 'kar') {
    // Pre-rank all patrols to get maxedCount, then aggregate by kår.
    const rankedPatrols = rankPatrols(totals, controls);
    const byKar = {};
    for (const t of rankedPatrols) {
      const k = t.kar || '(Okänd)';
      if (!byKar[k]) byKar[k] = { kar: k, total: 0, extra: 0, patrols: [], count: 0, maxedCount: 0 };
      byKar[k].total      += t.total;
      byKar[k].extra      += t.extra;
      byKar[k].count      += t.count;
      byKar[k].maxedCount += t.maxedCount;
      byKar[k].patrols.push(t);
    }
    const karRaw = Object.values(byKar)
      .map(r => ({ ...r, grand: r.total + r.extra, avg: r.patrols.length ? r.total / r.patrols.length : 0 }));
    const karRows = rankKarer(karRaw);
    body = `
      <div class="lb"><table>
        <thead><tr><th class="rank">#</th><th>Kår</th><th class="num">Patruller</th><th class="num">Kontroller</th><th class="num">Max</th><th class="num">Snitt</th><th class="num">Extra</th><th class="num">Total</th></tr></thead>
        <tbody>
          ${karRows.map(r => `<tr class="${r.rank<=3?'top'+r.rank:''}">
            <td class="rank">${r.rank === 1 ? icon('trophy', { size: 16 }) + ' ' : ''}${r.rank}</td>
            <td><span class="pname">${escapeHtml(r.kar)}</span></td>
            <td class="num">${r.patrols.length}</td>
            <td class="num">${r.count}</td>
            <td class="num">${r.maxedCount}</td>
            <td class="num">${r.avg.toFixed(1)}</td>
            <td class="num">${r.extra || ''}</td>
            <td class="num total">${r.grand}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>
    `;
  } else {
    let rows = totals.slice();
    if (scoreView.startsWith('avd:')) {
      rows = rows.filter(r => r.avdelning === scoreView.slice(4));
    }
    rows = rankPatrols(rows, controls);
    body = rows.length ? `
      <div class="lb"><table>
        <thead><tr><th class="rank">#</th><th>Patrull</th><th>Kår</th><th class="num">Kontr.</th><th class="num">Max</th><th class="num">Extra</th><th class="num">Total</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr class="${r.rank<=3?'top'+r.rank:''}">
            <td class="rank">${r.rank === 1 ? icon('trophy', { size: 16 }) + ' ' : ''}${r.rank}</td>
            <td>
              <span class="pname">${escapeHtml(r.name || '')}</span>
              <div style="font-size:12px;color:var(--fg3);"><span class="dot ${avdSlug(r.avdelning)}"></span>${escapeHtml(r.avdelning || '')}</div>
            </td>
            <td><span class="pkar">${escapeHtml(r.kar || '')}</span></td>
            <td class="num">${r.count}</td>
            <td class="num">${r.maxedCount}</td>
            <td class="num">${r.extra || ''}</td>
            <td class="num total">${r.grand}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>
    ` : '<div class="empty"><h3>Inga resultat än</h3></div>';
  }

  return `
    <div class="pub-section-head">
      <h2 class="t-h2">Poängtabell</h2>
      <span class="muted">Live-uppdaterad</span>
    </div>
    ${renderRankingInfo()}
    <div class="sub-tabs">
      ${tabs.map(t => `<button data-view="${t.key}" class="${scoreView === t.key ? 'active' : ''}">${escapeHtml(t.label)}</button>`).join('')}
    </div>
    ${body}
  `;
}

// --- Totals helper ---------------------------------------------------------
function computeTotals() {
  const map = {};
  for (const p of patrols) {
    map[p.id] = { ...p, id: p.id, total: 0, extra: 0, count: 0, perControl: {} };
  }
  for (const ctrlId of Object.keys(scoresByControl)) {
    for (const s of scoresByControl[ctrlId]) {
      const row = map[s.patrolId];
      if (!row) continue;
      row.total += Number(s.poang) || 0;
      row.extra += Number(s.extraPoang) || 0;
      row.count += 1;
      row.perControl[ctrlId] = s;
    }
  }
  for (const r of Object.values(map)) r.grand = r.total + r.extra;
  return Object.values(map);
}

function renderRankingInfo() {
  return `
    <details class="rules-info">
      <summary>Placeringsregler</summary>
      <ol>
        ${RANKING_RULES_TEXT.map(r => `<li><strong>${escapeHtml(r.title)}</strong> — ${escapeHtml(r.rule)}</li>`).join('')}
      </ol>
    </details>
  `;
}

// --- Delegated interactions ------------------------------------------------
document.addEventListener('click', (e) => {
  const avdBtn = e.target.closest('.avd-filter button');
  if (avdBtn) {
    avdFilter = avdBtn.dataset.avd || null;
    render();
    return;
  }
  const avdCard = e.target.closest('.avd-card[data-avd]');
  if (avdCard) {
    e.preventDefault();
    avdFilter = avdCard.dataset.avd;
    scoreView = 'avd:' + avdCard.dataset.avd;
    setTab(parsePath().cid, 'scoreboard');
    return;
  }
  const subTab = e.target.closest('.sub-tabs button[data-view]');
  if (subTab) {
    scoreView = subTab.dataset.view;
    render();
    return;
  }
});

function renderNotFound(msg) {
  root.innerHTML = `
    <header class="pub-hero">
      <div class="pub-hero-pattern"></div>
      <div class="page">
        <div class="pub-brand">
          <img src="/assets/logo-scouterna-tagline-white.svg" alt="Scouterna">
        </div>
        <h1>Tävlingen hittades inte</h1>
        <p class="lede">${escapeHtml(msg)}</p>
      </div>
    </header>
  `;
}

boot();
