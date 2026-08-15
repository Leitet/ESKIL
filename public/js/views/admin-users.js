// Super-admin only: list all user accounts that have ever signed in.
// Allows role change and deletion. Memberships in each user's competitions
// are shown inline so super-admin can spot orphan accounts.
//
// "Last seen" is updated by ensureUser() on every sign-in. Accounts that
// predate that change show "—" until the user next signs in.

import { layout } from '../app.js';
import { listAllUsers, updateUserRole, deleteUser, listCompetitionsWithAccess } from '../store.js';
import { escapeHtml, formatDate, formatTime, toast, confirmDialog } from '../utils.js';
import { crumbs, setDocTitle } from '../nav.js';
import { navigate } from '../router.js';

export async function renderAdminUsers(app, user) {
  if (user.role !== 'super-admin') {
    navigate('/app', true);
    return;
  }

  const crumbsHtml = crumbs([
    { label: 'Tävlingar', href: '/app' },
    { label: 'Konto', href: '/app/settings' },
    { label: 'Användare' }
  ]);
  setDocTitle('Användare');

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="page-head">
      <div>
        ${crumbsHtml}
        <h1 class="t-d2">Användare</h1>
      </div>
    </div>
    <div class="card"><div class="muted">Laddar…</div></div>
  `;
  layout(wrap);

  let users, comps;
  try {
    [users, comps] = await Promise.all([
      listAllUsers(),
      // Med access-dokumenten inlästa: rollerna per tävling ligger i
      // private/access sedan Fas 3c, inte på det publika dokumentet.
      listCompetitionsWithAccess()
    ]);
  } catch (e) {
    console.error(e);
    wrap.innerHTML = `<div class="empty"><h3>Kunde inte läsa in användare</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }

  render();

  function render() {
    users.sort((a, b) => {
      const ta = msOf(a.lastSeenAt) || msOf(a.createdAt) || 0;
      const tb = msOf(b.lastSeenAt) || msOf(b.createdAt) || 0;
      return tb - ta;
    });

    wrap.innerHTML = `
      <div class="page-head">
        <div>
          ${crumbsHtml}
          <h1 class="t-d2">Användare (${users.length})</h1>
        </div>
        <div class="btn-row"><a class="btn btn-ghost btn-sm" href="/app/admin/system" data-link>Systemhubb</a></div>
      </div>
      <div class="card mb-4" style="padding:var(--sp-3) var(--sp-4);border-left:3px solid var(--scout-blue);">
        <p class="t-sm" style="margin:0;"><strong>Två skilda saker:</strong> <em>Kontorollen</em> (user / super-admin)
        styr bara åtkomst till ESKIL:s systemsidor — den säger ingenting om tävlingar.
        <em>Roller per tävling</em> (admin, ekonomi, läser) sätts på respektive tävling under
        Inställningar → Användare och gäller bara där. Listan nedan visar konton som har loggat in
        minst en gång; inbjudna som ännu inte loggat in listas separat längst ned.</p>
      </div>
      <div class="table-wrap">
        <table class="t">
          <thead>
            <tr>
              <th>E-post</th>
              <th>Kontoroll</th>
              <th>Roller per tävling</th>
              <th>Senast inloggad</th>
              <th>Skapad</th>
              <th class="actions"></th>
            </tr>
          </thead>
          <tbody>
            ${users.map(u => rowHtml(u)).join('')}
          </tbody>
        </table>
      </div>
      <p class="muted t-sm mt-3">
        "Senast inloggad" registreras vid varje inloggning. Äldre konton som
        inte loggat in efter uppdateringen visar "—" tills de kommer tillbaka.
      </p>
      ${pendingHtml()}
    `;

    wrap.querySelectorAll('[data-role-change]').forEach(sel => {
      sel.addEventListener('change', async () => {
        const uid = sel.dataset.roleChange;
        const role = sel.value;
        const target = users.find(u => u.id === uid);
        if (!target) return;
        const prev = target.role;
        if (uid === user.uid && role !== 'super-admin') {
          const ok = await confirmDialog('Ta bort din egen super-admin-roll? Du förlorar åtkomst till den här sidan.');
          if (!ok) { sel.value = prev; return; }
        }
        try {
          await updateUserRole(uid, role);
          target.role = role;
          toast('Roll uppdaterad', 'success');
          if (uid === user.uid && role !== 'super-admin') {
            navigate('/app');
          }
        } catch (e) {
          console.error(e);
          sel.value = prev;
          toast('Kunde inte ändra roll: ' + e.message, 'error');
        }
      });
    });

    wrap.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.delete;
        const target = users.find(u => u.id === uid);
        const ok = await confirmDialog(`Ta bort user-dokumentet för ${target.email}? Firebase Auth-kontot finns kvar — användaren kan logga in igen och få rollen "user" automatiskt.`);
        if (!ok) return;
        try {
          await deleteUser(uid);
          users = users.filter(u => u.id !== uid);
          render();
          toast('Användare borttagen', 'success');
        } catch (e) {
          console.error(e);
          toast('Kunde inte ta bort: ' + e.message, 'error');
        }
      });
    });
  }

  // Inbjudna som ännu inte loggat in: e-postadresser som står som admin/
  // ekonomi/läsare på någon tävling men saknar konto (users/{uid} skapas
  // först vid första inloggningen). Det här är svaret på "jag bjöd in dem,
  // varför syns de inte i listan?".
  function pendingHtml() {
    const known = new Set(users.map(u => String(u.email || '').toLowerCase()).filter(Boolean));
    const pending = new Map(); // email -> [{ comp, role }]
    for (const c of comps) {
      for (const [list, role] of [[c.adminEmails, 'admin'], [c.ekonomiEmails, 'ekonomi'], [c.userEmails, 'las']]) {
        for (const raw of list || []) {
          const e = String(raw || '').trim().toLowerCase();
          if (!e || known.has(e)) continue;
          const rows = pending.get(e) || [];
          if (!rows.some(r => r.c.id === c.id)) rows.push({ c, role });
          pending.set(e, rows);
        }
      }
    }
    if (!pending.size) return '';
    return `
      <h2 class="t-h3" style="margin:var(--sp-6) 0 var(--sp-2);">Inbjudna som inte loggat in ännu (${pending.size})</h2>
      <p class="muted t-sm" style="margin-top:0;">Rättigheterna gäller redan — de aktiveras automatiskt vid personens
      första inloggning med exakt den här adressen. Något konto skapas alltså inte i förväg.</p>
      <div class="table-wrap">
        <table class="t">
          <thead><tr><th>E-post</th><th>Inbjuden till</th></tr></thead>
          <tbody>
            ${[...pending.entries()].sort((a, b) => a[0].localeCompare(b[0], 'sv')).map(([email, rows]) => `
              <tr>
                <td>${escapeHtml(email)}</td>
                <td><div class="row wrap" style="gap:4px;">${rows.map(({ c, role }) =>
                  `<a class="badge ${ROLE_BADGE[role]}" href="/app/c/${escapeHtml(c.id)}/settings" data-link title="${escapeHtml(c.name)} — ${ROLE_LABEL[role]}" style="text-decoration:none;">${escapeHtml(c.shortName || c.name)} · ${ROLE_LABEL[role]}</a>`
                ).join(' ')}</div></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function rowHtml(u) {
    const uEmail = String(u.email || '').toLowerCase();
    const mine = comps.map(c => ({ c, role: roleIn(c, uEmail, u.id) })).filter(x => x.role);
    const compLabels = mine.length
      ? mine.map(({ c, role }) =>
          `<a class="badge ${ROLE_BADGE[role]}" href="/app/c/${escapeHtml(c.id)}/settings" data-link title="${escapeHtml(c.name)} — ${ROLE_LABEL[role]}" style="text-decoration:none;">${escapeHtml(c.shortName || c.name)} · ${ROLE_LABEL[role]}</a>`
        ).join(' ')
      : '<span class="muted t-sm">— ingen tävling</span>';
    const self = u.id === user.uid;
    return `
      <tr>
        <td>
          <div>${escapeHtml(u.email || '(okänd)')}</div>
          <div class="muted t-sm" style="font-family:ui-monospace,monospace;font-size:11px;">${escapeHtml(u.id)}</div>
        </td>
        <td>
          <select class="input select" data-role-change="${escapeHtml(u.id)}" style="padding:6px 28px 6px 10px;font-size:13px;">
            <option value="user" ${u.role === 'user' ? 'selected' : ''}>user</option>
            <option value="super-admin" ${u.role === 'super-admin' ? 'selected' : ''}>super-admin</option>
          </select>
          ${self ? '<div class="muted t-sm" style="margin-top:2px;">du</div>' : ''}
        </td>
        <td><div class="row wrap" style="gap:4px;">${compLabels}</div></td>
        <td class="t-sm">${fmt(u.lastSeenAt)}</td>
        <td class="t-sm">${fmt(u.createdAt)}</td>
        <td class="actions">
          <button class="btn btn-ghost btn-sm" data-delete="${escapeHtml(u.id)}" ${self ? 'disabled title="Du kan inte ta bort ditt eget konto"' : ''}>Ta bort</button>
        </td>
      </tr>
    `;
  }
}

// Vilken roll en e-post har PÅ EN TÄVLING (inget att göra med kontorollen
// user/super-admin). Admin vinner över ekonomi som vinner över läsrättighet.
const ROLE_LABEL = { admin: 'admin', ekonomi: 'ekonomi', las: 'läser' };
const ROLE_BADGE = { admin: 'badge-blue', ekonomi: 'badge-green', las: 'badge-gray' };
function roleIn(c, email, uid) {
  if ((c.admins || []).includes(uid) || (c.adminEmails || []).includes(email)) return 'admin';
  if ((c.ekonomiEmails || []).includes(email)) return 'ekonomi';
  if ((c.userEmails || []).includes(email)) return 'las';
  if ((c.users || []).some(x => typeof x === 'string' && x === uid)) return 'las';
  return null;
}

function msOf(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.toDate === 'function') return ts.toDate().getTime();
  return new Date(ts).getTime() || 0;
}

function fmt(ts) {
  if (!ts) return '—';
  return `${formatDate(ts)} ${formatTime(ts)}`;
}
