// Dynamic Tävlingsledning editor. Supports arbitrary roles with a per-role
// visibility toggle (publik / intern). Returns a controller with `.element`
// (mount this) and `.read()` (call at save-time to get the current array).

import { normalizeManagement, normEmail } from './utils.js';
import { escapeHtml } from './utils.js';
import { icon } from './icons.js';

function randId() {
  return 'r-' + Math.random().toString(36).slice(2, 10);
}

export function createManagementForm(comp, { seedDefaults = false } = {}) {
  const host = document.createElement('div');
  host.className = 'mgmt-form';

  const existingAdmins = new Set((comp?.adminEmails || []).map(normEmail));
  let items = normalizeManagement(comp, { seedDefaults })
    .map(r => ({ ...r, invite: existingAdmins.has(normEmail(r.email)) }));

  const roleCard = (r, idx) => `
    <div class="card mgmt-card" data-idx="${idx}" style="padding:var(--sp-4);margin-bottom:var(--sp-3);background:var(--bg-muted);box-shadow:none;">
      <div class="grid" style="grid-template-columns: 1fr 200px auto;gap:var(--sp-3);align-items:end;">
        <div>
          <label class="field">Rollnamn</label>
          <input class="input" data-field="${idx}:label" value="${escapeHtml(r.label || '')}" placeholder="Ex. Tävlingsledare, Banläggare…" required>
        </div>
        <div>
          <label class="field">Visas</label>
          <select class="select" data-field="${idx}:visibility">
            <option value="public"   ${r.visibility === 'public'   ? 'selected' : ''}>Publikt (startkort + offentlig sida)</option>
            <option value="internal" ${r.visibility === 'internal' ? 'selected' : ''}>Internt (bara på kontrollkort)</option>
          </select>
        </div>
        <div>
          <button type="button" class="btn btn-ghost btn-sm" data-remove="${idx}" style="color:var(--utm-pink);" aria-label="Ta bort roll">
            ${icon('trash', { size: 16 })}
          </button>
        </div>
      </div>

      <div class="grid grid-2 mt-3">
        <div>
          <label class="field">Namn</label>
          <input class="input" data-field="${idx}:name" value="${escapeHtml(r.name || '')}" placeholder="Ex. Anna Svensson">
        </div>
        <div>
          <label class="field">Telefon</label>
          <input class="input" data-field="${idx}:phone" value="${escapeHtml(r.phone || '')}" type="tel" placeholder="070-123 45 67">
        </div>
      </div>
      <label class="field mt-3">E-post</label>
      <input class="input" data-field="${idx}:email" value="${escapeHtml(r.email || '')}" type="email" placeholder="namn@exempel.se">
      <label class="mt-3" style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;">
        <input type="checkbox" data-invite="${idx}" ${r.invite ? 'checked' : ''} ${normEmail(r.email) ? '' : 'disabled'} style="margin:0;">
        <span>Bjud in som administratör
          ${existingAdmins.has(normEmail(r.email)) ? '<span class="badge badge-green" style="margin-left:4px;">Administratör</span>' : ''}
        </span>
      </label>
    </div>
  `;

  const render = () => {
    host.innerHTML = `
      <div id="mgmt-list">
        ${items.length
          ? items.map((r, i) => roleCard(r, i)).join('')
          : '<p class="muted">Inga roller. Klicka "Lägg till roll" för att börja.</p>'}
      </div>
      <button type="button" class="btn btn-secondary btn-sm mt-3" id="mgmt-add">
        ${icon('plus', { size: 14 })} Lägg till roll
      </button>
    `;

    host.querySelector('#mgmt-add').addEventListener('click', () => {
      items.push({
        id: randId(),
        label: '',
        visibility: 'public',
        name: '', phone: '', email: ''
      });
      render();
      // Focus the new label field for quick typing
      const cards = host.querySelectorAll('.mgmt-card');
      cards[cards.length - 1]?.querySelector('input[data-field$=":label"]')?.focus();
    });

    host.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.remove);
        items.splice(idx, 1);
        render();
      });
    });

    host.querySelectorAll('[data-field]').forEach(inp => {
      inp.addEventListener('input', () => {
        const [idxStr, field] = inp.dataset.field.split(':');
        const idx = Number(idxStr);
        if (!items[idx]) return;
        items[idx][field] = inp.value;
        // The invite checkbox needs a valid email to be actionable.
        if (field === 'email') {
          const cb = host.querySelector(`[data-invite="${idx}"]`);
          if (cb) cb.disabled = !normEmail(inp.value);
        }
      });
    });

    host.querySelectorAll('[data-invite]').forEach(cb => {
      cb.addEventListener('change', () => {
        const idx = Number(cb.dataset.invite);
        if (items[idx]) items[idx].invite = cb.checked;
      });
    });
  };

  render();

  return {
    element: host,
    read() {
      // Drop roles where the label is blank — they're placeholders. The
      // runtime-only `invite` flag is intentionally not persisted.
      return items
        .map(r => ({
          id: r.id || randId(),
          label: (r.label || '').trim(),
          visibility: r.visibility === 'internal' ? 'internal' : 'public',
          name: (r.name || '').trim(),
          phone: (r.phone || '').trim(),
          email: (r.email || '').trim()
        }))
        .filter(r => r.label);
    },
    // Emails ticked "Bjud in som administratör". The caller unions these into
    // comp.adminEmails at save — unticking never REMOVES an admin (that's done
    // deliberately under Användare, not as a side effect of editing a role).
    adminInvites() {
      return items
        .filter(r => r.invite && normEmail(r.email))
        .map(r => normEmail(r.email));
    }
  };
}
