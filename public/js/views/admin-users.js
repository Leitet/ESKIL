// Super-admin only: list all user accounts that have ever signed in.
// Allows role change and deletion. Memberships in each user's competitions
// are shown inline so super-admin can spot orphan accounts.
//
// "Last seen" is updated by ensureUser() on every sign-in. Accounts that
// predate that change show "—" until the user next signs in.

import { layout } from '../app.js';
import { listAllUsers, updateUserRole, deleteUser, listCompetitionsForUser } from '../store.js';
import { escapeHtml, formatDate, formatTime, toast, confirmDialog } from '../utils.js';
import { navigate } from '../router.js';

export async function renderAdminUsers(app, user) {
  if (user.role !== 'super-admin') {
    navigate('/app', true);
    return;
  }

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="page-head">
      <div>
        <div class="t-over">Super-admin</div>
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
      listCompetitionsForUser(user) // super-admin sees all
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
          <div class="t-over">Super-admin</div>
          <h1 class="t-d2">Användare (${users.length})</h1>
        </div>
      </div>
      <div class="table-wrap">
        <table class="t">
          <thead>
            <tr>
              <th>E-post</th>
              <th>Roll</th>
              <th>Tävlingar</th>
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
    `;

    wrap.querySelectorAll('[data-role-change]').forEach(sel => {
      sel.addEventListener('change', async () => {
        const uid = sel.dataset.roleChange;
        const role = sel.value;
        const target = users.find(u => u.id === uid);
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

  function rowHtml(u) {
    const mine = comps.filter(c =>
      (c.admins || []).includes(u.id) || (c.users || []).includes(u.id)
    );
    const compLabels = mine.length
      ? mine.map(c => {
          const isAdmin = (c.admins || []).includes(u.id);
          return `<span class="badge ${isAdmin ? 'badge-blue' : 'badge-gray'}" title="${escapeHtml(c.name)}">${escapeHtml(c.shortName || c.name)}${isAdmin ? ' · admin' : ''}</span>`;
        }).join(' ')
      : '<span class="muted t-sm">—</span>';
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
