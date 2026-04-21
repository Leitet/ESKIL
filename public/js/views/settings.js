// Global settings page — now a concise dashboard linking to each competition's
// own settings page. Per-competition admin/user management has moved into
// /app/c/:cid/settings under the "Användare" tab.

import { layout } from '../app.js';
import { listCompetitionsForUser } from '../store.js';
import { escapeHtml } from '../utils.js';
import { icon } from '../icons.js';

export async function renderSettings(app, user) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="muted">Laddar…</div>`;
  layout(wrap, { narrow: true });

  const comps = await listCompetitionsForUser(user).catch(() => []);
  const mine = comps.filter(c =>
    user.role === 'super-admin' || (c.admins || []).includes(user.uid)
  );

  wrap.innerHTML = `
    <div class="page-head">
      <div>
        <div class="t-over">Inställningar</div>
        <h1 class="t-d2">Ditt konto</h1>
      </div>
    </div>

    <div class="card">
      <h3 class="t-h3" style="margin-top:0;">Konto</h3>
      <p class="muted t-sm">${escapeHtml(user.email)} — roll: <strong>${escapeHtml(user.role || 'användare')}</strong></p>
    </div>

    <h2 class="t-h2 mt-6">Tävlingar du administrerar</h2>
    <p class="muted">Välj en tävling för att redigera uppgifter, regler, tävlingsledning och användare.</p>
    ${mine.length ? `<div class="grid" style="gap:var(--sp-3);">${mine.map(c => `
      <a class="card" style="text-decoration:none;color:inherit;display:flex;align-items:center;justify-content:space-between;gap:var(--sp-4);" href="/app/c/${c.id}/settings" data-link>
        <div>
          <div class="t-over" style="color:var(--avent-orange);">${escapeHtml(c.shortName || '')} · ${c.year || ''}${c.demo ? ' · DEMO' : ''}</div>
          <h3 class="t-h4" style="margin:4px 0 0;color:var(--scout-blue);">${escapeHtml(c.name)}</h3>
        </div>
        <span class="muted t-sm">Öppna inställningar ${icon('arrow-right', { size: 14 })}</span>
      </a>`).join('')}</div>` : '<div class="empty"><h3>Inga tävlingar att administrera</h3></div>'}
  `;
}
