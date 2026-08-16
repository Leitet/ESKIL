import { layout, setTopbarCompetition } from '../app.js';
import { getCompetition, listPatrols, listControls, getControlMeta, migrateCompetitionAccess } from '../store.js';
import { startklarChecks } from '../startklar.js';
import { escapeHtml, formatDate, activeManagement, isCompAdminUser } from '../utils.js';
import { compTabs, compCrumbs, setDocTitle } from '../nav.js';

export async function renderCompetition(app, user, cid) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="muted">Laddar…</div>`;
  layout(wrap);

  let comp;
  try {
    comp = await getCompetition(cid);
  } catch (e) {
    wrap.innerHTML = `<div class="empty"><h3>Ingen åtkomst</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }
  if (!comp) {
    wrap.innerHTML = `<div class="empty"><h3>Tävlingen hittades inte</h3></div>`;
    return;
  }

  const isAdmin = isCompAdminUser(comp, user);
  setTopbarCompetition(cid, comp, user);
  setDocTitle(comp.name);
  // Fas 3a: mirror this competition's permission fields into the member-only
  // private/access subdoc (copy only — the doc keeps them until Fas 3c).
  if (isAdmin && !comp.demo) migrateCompetitionAccess(cid).catch(() => {});
  const [patrols, controls] = await Promise.all([
    listPatrols(cid).catch(() => []),
    listControls(cid).catch(() => [])
  ]);

  const avdCounts = {};
  patrols.forEach(p => { avdCounts[p.avdelning] = (avdCounts[p.avdelning] || 0) + 1; });
  const karer = new Set(patrols.map(p => p.kar).filter(Boolean));

  wrap.innerHTML = `
    <div class="page-head">
      <div>
        ${compCrumbs(cid, comp)}
        <h1 class="t-d2" style="color:var(--scout-blue);">${escapeHtml(comp.name)} ${comp.demo ? '<span class="badge badge-orange" style="font-size:14px;vertical-align:middle;">Demospår</span>' : ''}${comp.closed ? '<span class="badge badge-gray" style="font-size:14px;vertical-align:middle;">Avslutad</span>' : ''}</h1>
        <p class="muted">${comp.date ? formatDate(comp.date) : ''} ${comp.location ? '· ' + escapeHtml(comp.location) : ''}</p>
        ${comp.demo && user.role !== 'super-admin' ? '<p class="t-sm" style="color:var(--avent-orange);font-weight:600;">Demospår — du kan utforska men inte ändra.</p>' : ''}
      </div>
    </div>

    ${compTabs(cid, 'oversikt', comp, user)}

    <div id="startklar"></div>

    <div class="kpi-row">
      <div class="kpi"><div class="k-label">Patruller</div><div class="k-value">${patrols.length}</div></div>
      <div class="kpi"><div class="k-label">Kontroller</div><div class="k-value">${controls.length}</div></div>
      <div class="kpi"><div class="k-label">Kårer</div><div class="k-value">${karer.size}</div></div>
      <div class="kpi"><div class="k-label">Öppna kontroller</div><div class="k-value">${controls.filter(c => c.open).length}</div></div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <h3 class="t-h3">Om tävlingen</h3>
        <div class="field-group">
          ${row('Arrangör', comp.organizer)}
          ${row('Plats', comp.location)}
          ${row('Datum', comp.date ? formatDate(comp.date) : '')}
        </div>
        ${comp.description ? `<p class="t-serif mt-4" style="color:var(--fg2);">${escapeHtml(comp.description)}</p>` : ''}
        ${comp.generalInfo ? `
          <div class="mt-4" style="padding:var(--sp-4);background:var(--scout-blue-50);border-radius:var(--r-md);border-left:3px solid var(--avent-orange);">
            <div class="t-over" style="color:var(--avent-orange);margin-bottom:var(--sp-2);">Allmän info på kontroller</div>
            <p class="t-sm" style="white-space:pre-wrap;margin:0;color:var(--fg2);">${escapeHtml(comp.generalInfo)}</p>
          </div>` : ''}
        ${(() => {
          const active = activeManagement(comp);
          if (!active.length) return '';
          return `
            <div class="mt-4">
              <div class="t-over" style="color:var(--scout-blue);margin-bottom:var(--sp-2);">Tävlingsledning</div>
              <div class="grid" style="gap:var(--sp-3);">
                ${active.map(r => {
                  const isPublic = (r.visibility || 'public') === 'public';
                  return `
                  <div style="padding:var(--sp-3);background:var(--bg-muted);border-radius:var(--r-md);">
                    <div class="row" style="justify-content:space-between;align-items:center;">
                      <div class="t-sm" style="font-weight:700;color:var(--scout-blue);">${escapeHtml(r.label)}</div>
                      <span class="badge ${isPublic ? 'badge-blue' : 'badge-gray'}" style="font-size:10px;">${isPublic ? 'Publik' : 'Intern'}</span>
                    </div>
                    ${r.name ? `<div class="t-sm mt-2">${escapeHtml(r.name)}</div>` : ''}
                    ${r.phone ? `<div class="t-sm mono"><a href="tel:${escapeHtml(r.phone)}" style="color:var(--fg1);text-decoration:none;">${escapeHtml(r.phone)}</a></div>` : ''}
                    ${r.email ? `<div class="t-sm"><a href="mailto:${escapeHtml(r.email)}" style="color:var(--scout-blue);">${escapeHtml(r.email)}</a></div>` : ''}
                  </div>`;
                }).join('')}
              </div>
            </div>`;
        })()}
      </div>

      <div class="card">
        <h3 class="t-h3">Patruller per avdelning</h3>
        ${['Spårare','Upptäckare','Äventyrare','Utmanare','Rover','Ledare'].map(a => `
          <div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
            <span><span class="dot ${shortOf(a)}"></span>${a}</span>
            <span class="mono">${avdCounts[a] || 0}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  if (isAdmin && !comp.closed && !comp.demo) {
    renderStartklar(wrap.querySelector('#startklar'), comp, cid, controls, patrols)
      .catch(() => { /* panelen är en bonus — översikten står ändå */ });
  }
}

// Startklar-panelen: härledda förkontroller (startklar.js) med direktlänkar.
// Bara för admins på en levande tävling — en avslutad eller demo behöver
// ingen packlista. Grön enradare när allt är grönt; annars listas varje
// avvikelse med länk till fliken där den rättas.
async function renderStartklar(host, comp, cid, controls, patrols) {
  // Ett misslyckat meta-anrop får INTE tolkas som "kontrollen saknar telefon".
  // Med `.catch(() => ({}))` per kontroll blev en nätverksglapp till en panel
  // som påstod att halva banan saknade nödnummer — en falsk brandlarm strax
  // före tävlingsdagen är värre än ingen kontroll alls. Faller något, hoppar
  // telefonkollen över sig helt (metas = null).
  let metas = null;
  try { metas = await Promise.all(controls.map(c => getControlMeta(cid, c.id))); }
  catch { /* medlem utan meta-läsning, eller tappat nät — hoppa kollen */ }
  const checks = startklarChecks(comp, controls, patrols, metas);
  const varningar = checks.filter(c => c.status === 'varning');
  const flikHref = { controls: `/app/c/${cid}/controls`, patrols: `/app/c/${cid}/patrols`, settings: `/app/c/${cid}/settings` };

  if (!varningar.length) {
    host.innerHTML = `
      <div class="card startklar-ok">
        ${'✓'} <strong>Startklar</strong> — inga avvikelser i förkontrollen
        (position, nummerserie, telefon, start/mål, startordning).
      </div>`;
    return;
  }
  host.innerHTML = `
    <div class="card startklar-panel">
      <h3 class="t-h3" style="margin-top:0;">Inför tävlingsdagen — ${varningar.length} sak${varningar.length === 1 ? '' : 'er'} att titta på</h3>
      <p class="muted t-sm" style="margin:-4px 0 10px;">Härlett ur det som redan är upplagt. Rätta gärna innan tävlingsdagen — varje rad länkar dit den fixas.</p>
      ${varningar.map(v => `
        <a class="startklar-rad" href="${flikHref[v.flik] || flikHref.settings}" data-link>
          <span class="startklar-prick"></span>
          <span>${escapeHtml(v.text)}</span>
        </a>`).join('')}
    </div>`;
}

function row(label, value) {
  if (!value) return '';
  return `<div class="row" style="justify-content:space-between;">
    <span class="muted t-sm">${escapeHtml(label)}</span>
    <span>${escapeHtml(value)}</span>
  </div>`;
}

function shortOf(avd) {
  return { 'Spårare':'sp','Upptäckare':'up','Äventyrare':'av','Utmanare':'ut','Rover':'ro','Ledare':'le' }[avd] || 'le';
}

