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
    ...rest
  ]);
}

// Browser-tab title: "Del · Del — ESKIL". Views call this once their data is
// loaded; the router resets to the base title on every route change.
export function setDocTitle(...parts) {
  const head = parts.filter(Boolean).join(' · ');
  document.title = head ? `${head} — ESKIL` : 'ESKIL — Scouttävlingar';
}
