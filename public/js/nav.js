// Shared navigation components for the admin SPA.
//
// All wayfinding lives here so the competition menu, breadcrumbs and tab
// titles stay consistent across views. The competition tab bar used to be
// copy-pasted into seven view files — adding a tab meant seven synchronized
// edits and control-detail never got one at all.

import { escapeHtml, isCompAdminUser } from './utils.js';
import { icon } from './icons.js';

// Competition menu — single source of truth. `active` is a key below
// (or 'settings' for the admin-only settings tab).
const COMP_TABS = [
  { key: 'oversikt',    label: 'Översikt',    path: '' },
  { key: 'laget',       label: 'Läget',       path: '/laget' },
  { key: 'meddelanden', label: 'Meddelanden', path: '/meddelanden' },
  { key: 'patrols',     label: 'Patruller',   path: '/patrols' },
  { key: 'controls',   label: 'Kontroller',  path: '/controls' },
  { key: 'track',      label: 'Spår',        path: '/track' },
  { key: 'scoreboard', label: 'Poängtabell', path: '/scoreboard' },
  { key: 'anmalan',    label: 'Anmälan',     path: '/anmalan' },
  { key: 'utskrifter', label: 'Utskrifter',  path: '/utskrifter' }
];

export function compTabs(cid, active, comp, user) {
  const isAdmin = isCompAdminUser(comp, user);
  // The cid comes decoded from the router — re-encode it so a crafted URL
  // can't inject attributes into the hrefs.
  const c = encodeURIComponent(cid);
  // Mobile: the bar overflows — after render, center the active tab so the
  // user always sees where they are. rAF fires after the caller's innerHTML
  // assignment, so the elements exist by then; a no-op if nothing overflows.
  requestAnimationFrame(() => {
    const act = document.querySelector('.tabs a.active');
    const bar = act?.parentElement;
    if (bar && bar.scrollWidth > bar.clientWidth) {
      bar.scrollLeft = act.offsetLeft - (bar.clientWidth - act.offsetWidth) / 2;
    }
  });
  return `
    <nav class="tabs" aria-label="Tävlingsmeny">
      ${COMP_TABS.map(t => `<a href="/app/c/${c}${t.path}" data-link class="${active === t.key ? 'active' : ''}">${t.label}</a>`).join('')}
      ${isAdmin ? `<a href="/app/c/${c}/settings" data-link class="tab-end ${active === 'settings' ? 'active' : ''}">${icon('settings', { size: 14 })} Inställningar</a>` : ''}
    </nav>`;
}

// Breadcrumb trail. items: [{ label, href? }] — the last item is the current
// page and always renders as plain text.
export function crumbs(items) {
  const sep = '<span class="crumbs-sep" aria-hidden="true">›</span>';
  return `
    <nav class="crumbs" aria-label="Du är här">
      ${items.map((it, i) => it.href && i < items.length - 1
        ? `<a href="${escapeHtml(it.href)}" data-link>${escapeHtml(it.label)}</a>`
        : `<span aria-current="page">${escapeHtml(it.label)}</span>`
      ).join(sep)}
    </nav>`;
}

export function compLabel(comp) {
  if (!comp) return 'Tävling';
  return comp.shortName ? `${comp.shortName}${comp.year ? ' ' + comp.year : ''}` : (comp.name || 'Tävling');
}

// Standard trail for competition pages: Tävlingar › <comp> › …rest.
// With no rest the competition itself is the current page.
export function compCrumbs(cid, comp, ...rest) {
  return crumbs([
    { label: 'Tävlingar', href: '/app' },
    { label: compLabel(comp), href: `/app/c/${encodeURIComponent(cid)}` },
    // En ren sträng är det naturliga att skicka för sista steget, och gjorde
    // man det förr blev label undefined: smulan renderade en avslutande "›"
    // med ingenting efter, helt tyst. Ta emot båda formerna.
    ...rest.map(r => (typeof r === 'string' ? { label: r } : r))
  ]);
}

/**
 * Standardhuvudet för ALLA tävlingssidor. En definition, så att flikraden
 * hamnar på exakt samma höjd på varje flik.
 *
 * Tidigare byggde varje vy sitt eget huvud, med smulorna INUTI `page-head` och
 * flikarna efter. Höjden på page-head varierar — Anmälan har underrubrik och
 * två knappar, Spår bara en rubrik — så flikraden låg på olika y beroende på
 * var man var, och menyn hoppade när man bytte flik.
 *
 * Ordningen är därför: smulor → flikar → sidrubrik. Navigationen ligger överst
 * och står stilla; det som varierar hamnar under den.
 *
 * @param opts.active       flikens nyckel (samma som COMP_TABS)
 * @param opts.title        sidrubrik, ESCAPAS — standardvägen
 * @param opts.titleHtml    rå rubrik för de få sidor som bär badges; den som
 *                          skickar den ansvarar själv för escapning
 * @param opts.subtitle     förklarande rad under rubriken, ESCAPAS
 * @param opts.subtitleHtml rå underrubrik (badges, statusmärken)
 * @param opts.actions      HTML för knappraden till höger
 * @param opts.crumbs       extra brödsmulor FÖRE den sista (t.ex. Kontroller ›)
 * @param opts.crumb        sista brödsmulan; faller tillbaka på titeln
 */
export function compHeader(cid, comp, user, {
  active, title = '', titleHtml = '', subtitle = '', subtitleHtml = '',
  actions = '', crumbs: extra = [], crumb
} = {}) {
  const sista = crumb ?? title;
  const rubrik = titleHtml || (title ? escapeHtml(title) : '');
  const under = subtitleHtml || (subtitle ? escapeHtml(subtitle) : '');
  return `
    ${compCrumbs(cid, comp, ...extra, ...(sista ? [{ label: sista }] : []))}
    ${compTabs(cid, active, comp, user)}
    ${rubrik || under || actions ? `
      <div class="page-head page-head-under-tabs">
        <div>
          ${rubrik ? `<h1 class="t-d2">${rubrik}</h1>` : ''}
          ${under ? `<p class="muted">${under}</p>` : ''}
        </div>
        ${actions ? `<div class="btn-row">${actions}</div>` : ''}
      </div>` : ''}`;
}

// Browser-tab title: "Del · Del — ESKIL". Views call this once their data is
// loaded; the router resets to the base title on every route change.
export function setDocTitle(...parts) {
  const head = parts.filter(Boolean).join(' · ');
  document.title = head ? `${head} — ESKIL` : 'ESKIL — Scoutspår';
}
