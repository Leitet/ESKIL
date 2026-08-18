// Full-page competition settings — replaces the old "Redigera tävling" modal
// and absorbs the per-competition bits of the old settings view.
//
// Tabs: Grund · Regler & info · Start/Mål · Tävlingsledning · Användare
//
// Each tab has its own form and Save button so the user can focus on one
// concern at a time without scrolling through a giant modal.

import { layout, setTopbarCompetition } from '../app.js';
import {
  getCompetition, updateCompetition, deleteCompetition, copyCompetition,
  setCompetitionUsers, setCompetitionEkonomi, listControls, attachControlMeta,
  closeCompetition, reopenCompetition, isSlugTaken,
  listaPapperskorg, aterstallFranPapperskorg,
  myntaMcpNyckel,
  mcpNyckelStatus,
  aterkallaMcpNyckel
} from '../store.js';
import {
  db, doc, getDoc, getDocs, collection, query, where
} from '../firebase.js';
import {
  escapeHtml, toast, withBusy, confirmDialog, confirmHardDelete, wireOverlayClose,
  registrationSettings, REG_PRICING_MODELS, registrationUrl, copyToClipboard,
  AVDELNINGAR, allowedAvdelningar,
  isCompAdminUser, normEmail, ekonomiFromManagement,
  normSlug, isValidSlug, suggestSlug, startFinishPoints,
  formatDate
} from '../utils.js';
import { createManagementForm } from '../managementform.js';
import { MCP_KLIENTER, medAdress, hittaKlient } from '../mcp-klienter.js';
import { icon } from '../icons.js';
import { help } from '../help.js';
import { DISTRICTS, normDistrict } from '../districts.js';
import { compPlaces, placeKind, placeToStorage } from '../places.js';
import { openPlaceModal } from '../place-modal.js';
import { compHeader, compLabel, setDocTitle } from '../nav.js';
import { navigate } from '../router.js';
import { initMapPicker } from '../mappicker.js';

const TABS = [
  { key: 'basic',      label: 'Grund'           },
  { key: 'rules',      label: 'Regler & info'   },
  { key: 'anmalan',    label: 'Anmälan'         },
  { key: 'platser',   label: 'Platser'         },
  { key: 'management', label: 'Tävlingsledning' },
  { key: 'members',    label: 'Användare'       },
  { key: 'mcp',        label: 'AI-koppling'     }
];

// The active section lives in the URL hash (#basic, #members, …) so sections
// are deep-linkable and never leak between competitions the way the old
// module-level state did.
const sectionFromHash = () => {
  const h = (location.hash || '').replace('#', '');
  return TABS.some(t => t.key === h) ? h : 'basic';
};

export async function renderCompetitionSettings(app, user, cid) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="muted">Laddar…</div>`;
  layout(wrap);

  let comp;
  try { comp = await getCompetition(cid); } catch (e) {
    wrap.innerHTML = `<div class="empty"><h3>Ingen åtkomst</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }
  if (!comp) { wrap.innerHTML = `<div class="empty"><h3>Tävlingen hittades inte</h3></div>`; return; }
  setTopbarCompetition(cid, comp, user);
  setDocTitle('Inställningar', compLabel(comp));

  const isSuperAdmin = user.role === 'super-admin';
  const isAdmin = isSuperAdmin || isCompAdminUser(comp, user);
  if (!isAdmin) {
    // Med bara ett tomt kort blev det här en återvändsgränd: ingen flikrad,
    // inga smulor, ingen väg tillbaka. Rendera huvudet som alla andra
    // tävlingssidor så man kan klicka sig vidare.
    wrap.innerHTML = `
      ${compHeader(cid, comp, user, { active: 'settings', crumb: 'Inställningar', title: 'Inställningar' })}
      <div class="empty"><h3>Inte tillgängligt</h3>
      <p>Bara tävlingens administratörer kan ändra inställningarna.${comp.demo
        ? ' Demospåret är skrivskyddat — men allt annat går att utforska.' : ''}</p></div>`;
    return;
  }
  const isDemoReadOnly = comp.demo && !isSuperAdmin;

  const refresh = async () => {
    comp = await getCompetition(cid);
    renderAll();
  };

  let activeTab = sectionFromHash();

  const renderAll = () => {
    wrap.innerHTML = `
      ${compHeader(cid, comp, user, {
        active: 'settings', title: 'Inställningar',
        subtitle: `${comp.name}${isDemoReadOnly ? ' · skrivskyddat (demospår)' : ''}`
      })}

      <div class="tabs-sub">
        ${TABS.map(t => `<a href="#${t.key}" data-tab="${t.key}" class="${activeTab === t.key ? 'active' : ''}">${escapeHtml(t.label)}</a>`).join('')}
      </div>

      <div id="tab-body"></div>
    `;

    wrap.querySelectorAll('[data-tab]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        activeTab = a.dataset.tab;
        history.replaceState(null, '', `#${activeTab}`);
        renderAll();
      });
    });

    const body = wrap.querySelector('#tab-body');
    if (activeTab === 'basic')       body.appendChild(renderBasicTab(comp, cid, refresh, isDemoReadOnly, isSuperAdmin, user));
    if (activeTab === 'rules')       body.appendChild(renderRulesTab(comp, cid, refresh, isDemoReadOnly));
    if (activeTab === 'anmalan')     body.appendChild(renderAnmalanTab(comp, cid, refresh, isDemoReadOnly));
    if (activeTab === 'platser')     body.appendChild(renderPlacesTab(comp, cid, refresh, isDemoReadOnly));
    if (activeTab === 'management')  body.appendChild(renderManagementTab(comp, cid, refresh, isDemoReadOnly));
    if (activeTab === 'members')     body.appendChild(renderMembersTab(comp, cid, user, refresh));
    if (activeTab === 'mcp')         body.appendChild(renderMcpTab(comp, cid, refresh, isDemoReadOnly));
  };

  renderAll();
}

// ---- helpers ---------------------------------------------------------------
function section(title, bodyHtml, opts = {}) {
  const card = document.createElement('section');
  card.className = 'card';
  card.innerHTML = `
    <h3 class="t-h3" style="margin-top:0;">${escapeHtml(title)}${opts.help ? help(opts.help) : ''}</h3>
    ${opts.hint ? `<p class="muted t-sm" style="margin-top:-6px;">${escapeHtml(opts.hint)}</p>` : ''}
    ${bodyHtml}
  `;
  return card;
}

function saveRow(btnLabel, disabled = false) {
  return `<div class="btn-row mt-6" style="justify-content:flex-end;">
    <button class="btn btn-primary" data-save ${disabled ? 'disabled' : ''}>${escapeHtml(btnLabel)}</button>
  </div>`;
}

function wireSave(host, handler, label = 'Sparar…') {
  const btn = host.querySelector('[data-save]');
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    const form = host.querySelector('form');
    if (form && !form.reportValidity()) return;
    await withBusy(btn, label, async () => {
      try {
        await handler();
        toast('Sparat', 'success');
      } catch (err) {
        console.error(err);
        toast('Fel: ' + err.message, 'error');
      }
    });
  });
}

// ---- tabs ------------------------------------------------------------------

function renderBasicTab(comp, cid, refresh, readOnly, isSuperAdmin, user) {
  const host = document.createElement('div');
  host.className = 'field-group';

  const card = section('Grunduppgifter', `
    <form class="field-group" ${readOnly ? 'inert' : ''}>
      <div class="grid grid-2">
        <div>
          <label class="field" for="shortName">Kort namn ${help('comp.shortName')}</label>
          <input class="input" id="shortName" required value="${escapeHtml(comp.shortName || '')}">
        </div>
        <div>
          <label class="field" for="year">År</label>
          <input class="input" id="year" type="number" required value="${comp.year || ''}">
        </div>
      </div>
      <div>
        <label class="field" for="name">Fullständigt namn</label>
        <input class="input" id="name" required value="${escapeHtml(comp.name || '')}">
      </div>
      <div class="grid grid-2">
        <div>
          <label class="field" for="date">Datum ${help('comp.date')}</label>
          <input class="input" id="date" type="date" value="${comp.date || ''}">
        </div>
        <div>
          <label class="field" for="location">Plats</label>
          <input class="input" id="location" value="${escapeHtml(comp.location || '')}">
        </div>
      </div>
      <div>
        <label class="field" for="district">Scoutdistrikt ${help('comp.district')}</label>
        <select class="select" id="district">
          ${DISTRICTS.map(d => `<option value="${escapeHtml(d.id)}" ${(comp.district || 'annat') === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="field" for="organizer">Arrangör</label>
        <input class="input" id="organizer" value="${escapeHtml(comp.organizer || '')}">
      </div>
      <div>
        <label class="field" for="description">Beskrivning</label>
        <textarea class="textarea" id="description">${escapeHtml(comp.description || '')}</textarea>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
        <label class="field">Avdelningar som deltar ${help('comp.avdelningar')}</label>
        <div class="field-hint" style="margin-bottom:var(--sp-3);">Endast valda avdelningar visas i t.ex. anmälan och patrullformulär. Minst en måste vara vald.</div>
        <div class="row wrap" style="gap:6px;">
          ${(() => {
            const allowed = new Set(allowedAvdelningar(comp).map(a => a.key));
            return AVDELNINGAR.map(a => {
              const checked = allowed.has(a.key);
              return `<label style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1.5px solid ${checked ? 'var(--scout-blue)' : 'var(--border)'};border-radius:999px;background:${checked ? 'var(--scout-blue-100)' : 'var(--white)'};cursor:pointer;font-size:13px;font-weight:600;">
                <input type="checkbox" data-avd-part="${a.key}" ${checked ? 'checked' : ''} style="margin:0;">
                <span class="dot ${a.short}" style="margin:0;"></span>${a.key}
              </label>`;
            }).join('');
          })()}
        </div>
      </div>
    </form>
    ${readOnly ? '<p class="muted t-sm">Skrivskyddad demotävling — bara superadministratör kan ändra.</p>' : saveRow('Spara grunduppgifter')}
  `);
  host.appendChild(card);

  // Kortadress (slug) — fixed once set: short public URL + payment prefix.
  const slugCard = section('Kortadress', comp.slug ? `
    <p class="muted t-sm" style="margin-top:0;">Tävlingens fasta kortadress — används i publika länkar och som prefix i betalningsreferenserna (<strong>${escapeHtml(comp.slug.toUpperCase())}-XXXX</strong>).</p>
    <div class="row">
      <code style="background:var(--bg-muted);padding:8px 12px;border-radius:var(--r-sm);font-size:14px;">${escapeHtml(location.origin)}/t/${escapeHtml(comp.slug)}</code>
      <button type="button" class="btn btn-secondary btn-sm" id="copy-slug-url">${icon('copy', { size: 14 })} Kopiera</button>
    </div>
    <p class="field-hint">Kortadressen är fast och kan inte ändras. Anmälan nås också på /a/${escapeHtml(comp.slug)}.</p>
  ` : `
    <p class="muted t-sm" style="margin-top:0;">Ge tävlingen en fast kortadress: tävlingssidan nås på <strong>eskilscout.se/t/&lt;kortadress&gt;</strong> och nya betalningsreferenser använder den som prefix. Den kan bara sättas en gång.</p>
    <div class="row wrap" ${readOnly ? 'inert' : ''}>
      <input class="input mono" id="slug-input" placeholder="ah26" maxlength="24" style="max-width:200px;text-transform:lowercase;">
      <button type="button" class="btn btn-primary btn-sm" id="set-slug">Lås fast kortadressen</button>
    </div>
  `, { help: 'comp.slug' });
  host.appendChild(slugCard);

  slugCard.querySelector('#copy-slug-url')?.addEventListener('click', () => {
    copyToClipboard(`${location.origin}/t/${comp.slug}`);
    toast('Kortadress kopierad', 'success');
  });
  const setSlugBtn = slugCard.querySelector('#set-slug');
  if (setSlugBtn) {
    const slugInput = slugCard.querySelector('#slug-input');
    slugInput.value = suggestSlug(comp.shortName, comp.year);
    setSlugBtn.addEventListener('click', () => withBusy(setSlugBtn, 'Kontrollerar…', async () => {
      const slug = normSlug(slugInput.value);
      if (!isValidSlug(slug)) { toast('Kortadressen måste vara 2–24 tecken: a–z, 0–9 och bindestreck.', 'error'); return; }
      if (await isSlugTaken(slug, cid)) { toast(`Kortadressen "${slug}" används redan av en annan tävling.`, 'error'); return; }
      if (!(await confirmDialog(`Lås fast kortadressen "${slug}"? Den kan inte ändras efteråt.`, { okLabel: 'Lås fast', danger: false }))) return;
      try {
        await updateCompetition(cid, { slug });
        await refresh();
        toast(`Kortadress satt — tävlingen nås nu på /t/${slug}`, 'success');
      } catch (e) { toast('Fel: ' + e.message, 'error'); }
    }));
  }

  // Live-restyle the avdelnings-chips as they're toggled.
  card.querySelectorAll('[data-avd-part]').forEach(cb => cb.addEventListener('change', () => {
    const label = cb.closest('label');
    label.style.borderColor = cb.checked ? 'var(--scout-blue)' : 'var(--border)';
    label.style.background = cb.checked ? 'var(--scout-blue-100)' : 'var(--white)';
  }));

  wireSave(card, async () => {
    const avdelningar = [...card.querySelectorAll('[data-avd-part]')]
      .filter(cb => cb.checked).map(cb => cb.dataset.avdPart);
    if (!avdelningar.length) throw new Error('Minst en avdelning måste vara vald.');
    await updateCompetition(cid, {
      name: card.querySelector('#name').value.trim(),
      shortName: card.querySelector('#shortName').value.trim(),
      year: Number(card.querySelector('#year').value),
      date: card.querySelector('#date').value || null,
      location: card.querySelector('#location').value.trim(),
      organizer: card.querySelector('#organizer').value.trim(),
      district: normDistrict(card.querySelector('#district').value),
      description: card.querySelector('#description').value.trim(),
      avdelningar
    });
    await refresh();
  });

  // Senaste backup stämplas på tävlingen så avsluta-dialogen kan visa om en
  // färsk kopia finns. Bäst-effort: läsbehöriga får ladda ner utan att skriva.
  const stampBackup = async () => {
    const at = new Date().toISOString();
    try { await updateCompetition(cid, { lastBackupAt: at }); comp.lastBackupAt = at; } catch { /* read-only */ }
    return at;
  };
  const fmtBackup = (v) => {
    if (!v) return 'aldrig';
    const d = v?.toDate ? v.toDate() : new Date(v);
    return isNaN(d) ? 'aldrig' : d.toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' });
  };

  // Lifecycle: avsluta/återöppna tävlingen (competition admins)
  if (!readOnly) {
    const lifecycle = document.createElement('section');
    lifecycle.className = 'card mt-6';
    if (comp.closed) {
      lifecycle.innerHTML = `
        <h3 class="t-h3" style="margin-top:0;">Tävlingen är avslutad <span class="badge badge-gray">Avslutad</span></h3>
        <p class="muted">Alla användare och kontrollansvariga är borttagna, kontrollerna är stängda och tävlingen är skrivskyddad för alla utom administratörer. Publika sidor och resultat går fortfarande att titta på.</p>
        <div class="mt-4" style="border:1px solid var(--border);border-left:3px solid var(--scout-blue);border-radius:10px;padding:12px 14px;">
          <strong>Arkiv</strong>
          <p class="muted t-sm" style="margin:4px 0 10px;">Spara en slutlig kopia för kårens arkiv — resultat, patruller och kontroller finns kvar i exporten. Senaste backup: <strong>${fmtBackup(comp.lastBackupAt)}</strong>.</p>
          <div class="btn-row">
            <button class="btn btn-secondary btn-sm" id="ar-zip">${icon('download', { size: 14 })} Exportera arkiv (ZIP)</button>
            <button class="btn btn-ghost btn-sm" id="ar-json">Backup (JSON)</button>
          </div>
        </div>
        <button class="btn btn-secondary mt-4" id="reopen-comp">Återöppna tävlingen</button>
      `;
      lifecycle.querySelector('#ar-zip').addEventListener('click', (e) => withBusy(e.currentTarget, 'Packar…', async () => {
        try {
          const { downloadExportZip } = await import('../backup.js');
          await downloadExportZip(cid);
          await stampBackup();
          toast('Exporten laddas ner', 'success');
        } catch (err) { console.error(err); toast('Fel: ' + err.message, 'error'); }
      }));
      lifecycle.querySelector('#ar-json').addEventListener('click', (e) => withBusy(e.currentTarget, 'Packar…', async () => {
        try {
          const { downloadBackup } = await import('../backup.js');
          await downloadBackup(cid);
          await stampBackup();
          toast('Backupen laddas ner', 'success');
        } catch (err) { console.error(err); toast('Fel: ' + err.message, 'error'); }
      }));
      lifecycle.querySelector('#reopen-comp').addEventListener('click', (e) => withBusy(e.currentTarget, 'Återöppnar…', async () => {
        try {
          await reopenCompetition(cid);
          toast('Tävlingen är återöppnad', 'success');
          await refresh();
        } catch (err) { toast('Fel: ' + err.message, 'error'); }
      }));
    } else {
      lifecycle.innerHTML = `
        <h3 class="t-h3" style="margin-top:0;">Avsluta tävling</h3>
        <p class="muted">När tävlingen är genomförd: raderar samtliga användare och kontrollansvariga
        (inklusive namn — bara administratörer ligger kvar), kontrollernas telefonnummer samt
        anmälningarnas kontaktuppgifter, fritextsvar och förhinder (GDPR-gallring), stänger alla
        kontroller för rapportering och gör tävlingen skrivskyddad. Resultat och publika sidor går
        fortfarande att titta på. Kan återöppnas, men de raderade uppgifterna återställs inte.</p>
        <button class="btn btn-secondary mt-4" id="close-comp">Avsluta tävling</button>
      `;
      // Backup-nudge: avslutet gallrar kontaktuppgifter PERMANENT — en backup
      // tagen efteråt saknar dem. Därför egen dialog med export på plats.
      lifecycle.querySelector('#close-comp').addEventListener('click', () => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
          <div class="modal" style="max-width:540px;">
            <div class="modal-head"><h3>Avsluta "${escapeHtml(comp.name || '')}"?</h3></div>
            <div class="modal-body">
              <p class="muted" style="margin-top:0;">Alla användare och kontrollansvariga raderas (administratörer ligger kvar), anmälningarnas kontaktuppgifter och fritextsvar rensas och alla kontroller stängs. De raderade uppgifterna går inte att återställa.</p>
              <div style="border:1px solid var(--border);border-left:3px solid var(--avent-orange);border-radius:10px;padding:12px 14px;">
                <strong>Ta en sista säkerhetskopia först</strong>
                <p class="muted t-sm" style="margin:4px 0 10px;">En backup tagen efter avslutet saknar det som gallras. Senaste backup: <strong id="cl-last">${fmtBackup(comp.lastBackupAt)}</strong>.</p>
                <button class="btn btn-secondary btn-sm" id="cl-backup">${icon('download', { size: 14 })} Ladda ner backup + export (ZIP)</button>
              </div>
            </div>
            <div class="modal-foot">
              <button class="btn btn-ghost" id="cl-cancel">Avbryt</button>
              <button class="btn btn-danger" id="cl-confirm">Avsluta tävling</button>
            </div>
          </div>
        `;
        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        wireOverlayClose(overlay, close);
        overlay.querySelector('#cl-cancel').addEventListener('click', close);
        overlay.querySelector('#cl-backup').addEventListener('click', (e) => withBusy(e.currentTarget, 'Packar…', async () => {
          try {
            const { downloadExportZip } = await import('../backup.js');
            await downloadExportZip(cid);
            const at = await stampBackup();
            const el = overlay.querySelector('#cl-last');
            if (el) el.textContent = fmtBackup(at);
            toast('Exporten laddas ner', 'success');
          } catch (err) { console.error(err); toast('Fel: ' + err.message, 'error'); }
        }));
        overlay.querySelector('#cl-confirm').addEventListener('click', (e) => withBusy(e.currentTarget, 'Avslutar…', async () => {
          try {
            await closeCompetition(cid);
            close();
            toast('Tävlingen är avslutad', 'success');
            await refresh();
          } catch (err) { toast('Fel: ' + err.message, 'error'); }
        }));
      });
    }
    host.appendChild(lifecycle);
  }

  // Copy to next year — the annual restart in five minutes. Also available
  // on the demo (as a template) since it only needs public reads + create.
  if (!user?.demoViewer) {
    const copyCard = document.createElement('section');
    copyCard.className = 'card mt-6';
    copyCard.innerHTML = `
      <h3 class="t-h3" style="margin-top:0;">Kopiera till ny tävling</h3>
      <p class="muted">Skapa nästa års tävling från den här: kontroller (med instruktioner,
      positioner och utslagsfrågor), spåret, inställningar, prismodell och tävlingsledning
      följer med. Patruller, poäng, anmälningar och användare gör det inte. Kontrollerna får
      nya hemliga rapportlänkar, facit och telefonnummer nollställs och anmälan är avstängd
      tills du öppnar den.</p>
      <button class="btn btn-secondary mt-4" id="copy-comp">Kopiera till ny tävling</button>
    `;
    copyCard.querySelector('#copy-comp').addEventListener('click', () => {
      const nextYear = (Number(comp.year) || new Date().getFullYear()) + 1;
      const suggestName = (s) => String(s || '').includes(String(comp.year))
        ? String(s).replaceAll(String(comp.year), String(nextYear))
        : `${s || ''}`.trim();
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" style="max-width:520px;">
          <div class="modal-head"><h3>Kopiera "${escapeHtml(comp.name || '')}"</h3></div>
          <div class="modal-body field-group">
            <div class="grid grid-2">
              <div>
                <label class="field" for="cp-short">Kort namn</label>
                <input class="input" id="cp-short" value="${escapeHtml(suggestName(comp.shortName))}">
              </div>
              <div>
                <label class="field" for="cp-year">År</label>
                <input class="input" id="cp-year" type="number" value="${nextYear}">
              </div>
            </div>
            <div>
              <label class="field" for="cp-name">Fullständigt namn</label>
              <input class="input" id="cp-name" required value="${escapeHtml(suggestName(comp.name))}">
            </div>
            <div>
              <label class="field" for="cp-date">Datum (kan sättas senare)</label>
              <input class="input" id="cp-date" type="date">
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" id="cp-cancel">Avbryt</button>
            <button class="btn btn-primary" id="cp-create">Skapa kopian</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const close = () => overlay.remove();
      wireOverlayClose(overlay, close);
      overlay.querySelector('#cp-cancel').addEventListener('click', close);
      overlay.querySelector('#cp-create').addEventListener('click', (e) => withBusy(e.currentTarget, 'Kopierar…', async () => {
        const name = overlay.querySelector('#cp-name').value.trim();
        if (!name) { toast('Ange ett namn.', 'error'); return; }
        try {
          const newCid = await copyCompetition(cid, {
            name,
            shortName: overlay.querySelector('#cp-short').value.trim(),
            year: overlay.querySelector('#cp-year').value,
            date: overlay.querySelector('#cp-date').value || null
          }, user);
          close();
          toast('Tävlingen kopierad', 'success');
          navigate(`/app/c/${newCid}/settings`);
        } catch (err) {
          console.error(err);
          toast('Kunde inte kopiera: ' + err.message, 'error');
        }
      }));
    });
    host.appendChild(copyCard);
  }

  // Överlämning — ledningens fria anteckningar till nästa års ledning.
  // Ligger i private/handover (medlemmar läser, admins skriver) och följer
  // med automatiskt när tävlingen kopieras till en ny årgång.
  if (!user?.demoViewer) {
    const hoCard = document.createElement('section');
    hoCard.className = 'card mt-6';
    hoCard.innerHTML = `
      <h3 class="t-h3" style="margin-top:0;">Överlämning till nästa år</h3>
      <p class="muted">Skriv ner det som inte syns i systemet: hur ni brukar lägga banan, vilka
      markägare som ska ringas, fällor att undvika, vem som har materiel. Dokumentet är internt
      (syns bara för tävlingsledningen) och följer med när tävlingen kopieras till nästa årgång.</p>
      <textarea class="textarea mt-3" id="ho-text" rows="7" placeholder="T.ex. Boka Tinnerö-stugan i januari. Markägare Nils: 070-… Kontroll 4 behöver eldningstillstånd…" disabled>Laddar…</textarea>
      <div class="row mt-3" style="align-items:center;gap:var(--sp-3);">
        ${readOnly ? '' : `<button class="btn btn-secondary btn-sm" id="ho-save">Spara överlämning</button>`}
        <span class="muted t-sm" id="ho-meta"></span>
      </div>
    `;
    host.appendChild(hoCard);
    const hoText = hoCard.querySelector('#ho-text');
    const hoMeta = hoCard.querySelector('#ho-meta');
    import('../store.js').then(({ getHandover, setHandover }) => {
      getHandover(cid).then(ho => {
        hoText.value = ho?.text || '';
        hoText.disabled = !!readOnly;
        if (ho?.updatedAt) hoMeta.textContent = `Senast ändrad ${new Date(ho.updatedAt).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' })}${ho.updatedBy ? ' av ' + ho.updatedBy : ''}`;
      }).catch(() => { hoText.value = ''; hoText.disabled = !!readOnly; });
      hoCard.querySelector('#ho-save')?.addEventListener('click', (e) => withBusy(e.currentTarget, 'Sparar…', async () => {
        try {
          await setHandover(cid, hoText.value, user);
          toast('Överlämningen sparad', 'success');
        } catch (err) { toast('Fel: ' + err.message, 'error'); }
      }));
    });
  }

  // Backup & export — full JSON dump (restorable), ZIP with structured data,
  // and restore-from-file. Available to everyone signed in (reads are public
  // for demo; import creates a fresh competition owned by the importer).
  if (!user?.demoViewer) {
    const buCard = document.createElement('section');
    buCard.className = 'card mt-6';
    buCard.innerHTML = `
      <h3 class="t-h3" style="margin-top:0;">Backup & export</h3>
      <p class="muted">Backupen är en komplett säkerhetskopia (JSON) som kan läsas tillbaka med
      "Importera backup" — den återskapar tävlingen som en ny tävling med patruller, kontroller,
      poäng, anmälningar, spår och stationer (rapport- och startkortslänkarna fortsätter fungera).
      Exporten är en zip med strukturerad data: säkerhetskopian plus CSV-filer för resultat,
      patruller, kontroller och anmälningar. Inga mail skickas vid import.</p>
      <div class="btn-row mt-4" style="flex-wrap:wrap;">
        <button class="btn btn-secondary" id="dl-backup">${icon('download', { size: 14 })} Ladda ner backup (JSON)</button>
        <button class="btn btn-secondary" id="dl-zip">${icon('download', { size: 14 })} Exportera (ZIP)</button>
        <button class="btn btn-ghost" id="do-import">Importera backup…</button>
        <input type="file" id="import-file" accept="application/json,.json" style="display:none;">
      </div>
    `;
    buCard.querySelector('#dl-backup').addEventListener('click', (e) => withBusy(e.currentTarget, 'Packar…', async () => {
      try {
        const { downloadBackup } = await import('../backup.js');
        await downloadBackup(cid);
        await stampBackup();
        toast('Backupen laddas ner', 'success');
      } catch (err) { console.error(err); toast('Fel: ' + err.message, 'error'); }
    }));
    buCard.querySelector('#dl-zip').addEventListener('click', (e) => withBusy(e.currentTarget, 'Packar…', async () => {
      try {
        const { downloadExportZip } = await import('../backup.js');
        await downloadExportZip(cid);
        await stampBackup();
        toast('Exporten laddas ner', 'success');
      } catch (err) { console.error(err); toast('Fel: ' + err.message, 'error'); }
    }));
    const fileInput = buCard.querySelector('#import-file');
    buCard.querySelector('#do-import').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      let dump;
      try { dump = JSON.parse(await file.text()); }
      catch { toast('Filen gick inte att läsa som JSON.', 'error'); return; }
      const label = `${dump?.competition?.name || '?'} ${dump?.competition?.year || ''}`;
      if (!(await confirmDialog(
        `Återskapa "${label}" från backupen som en NY tävling? Befintliga tävlingar påverkas inte, och inga mail skickas.`,
        { okLabel: 'Importera', danger: false }
      ))) return;
      try {
        const { importCompetitionBackup } = await import('../backup.js');
        const newCid = await importCompetitionBackup(dump, user);
        toast('Tävlingen återskapad', 'success');
        navigate(`/app/c/${newCid}`);
      } catch (err) { console.error(err); toast('Import misslyckades: ' + err.message, 'error'); }
    });
    host.appendChild(buCard);
  }

  // Klockslag för papperskorgen. Egen liten hjälpare i stället för att dra in
  // ytterligare en import — posten är alltid från samma dygn eller nyss.
  const korgTid = (ts) => {
    const d = ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : null);
    return d && Number.isFinite(d.getTime())
      ? d.toLocaleString('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '';
  };

  // Papperskorgen. Ligger FÖRE farliga zonen: den är motsatsen till en farlig
  // knapp, och den som just råkat radera fel patrull letar här.
  (async () => {
    if (!isCompAdminUser(comp, user)) return;
    const korg = document.createElement('section');
    korg.className = 'card mt-6';
    // host, inte wrap: papperskorgen ligger i renderBasicTab, och `wrap` är
    // deklarerad i renderCompetitionSettings — en helt annan funktion. Kortet
    // renderades därför ALDRIG, trots att toasten vid radering lovade att man
    // kunde återställa "under Inställningar".
    host.appendChild(korg);
    const rita = async () => {
      let poster = [];
      try { poster = await listaPapperskorg(cid); } catch { korg.remove(); return; }
      if (!poster.length) { korg.innerHTML = ''; return; }
      korg.innerHTML = `
        <h3 class="t-h3" style="margin-top:0;">${icon('trash', { size: 16 })} Papperskorg</h3>
        <p class="muted t-sm">Borttagna patruller och kontroller ligger kvar här tills tävlingen
        avslutas. Poängen följde med och kommer tillbaka vid återställning — med samma id, så
        tryckta QR-koder och startkortslänkar fungerar igen.</p>
        <div class="mt-3">
          ${poster.map(k => `
            <div class="anm-sum-row">
              <span><strong>${escapeHtml(k.data?.name || k.ursprungsId)}</strong>
                <span class="muted">· ${k.sort === 'patrull' ? 'patrull' : 'kontroll'}${
                  (k.poang || []).length ? ` · ${k.poang.length} rapport${k.poang.length === 1 ? '' : 'er'}` : ''}
                  · ${escapeHtml(korgTid(k.raderadAt))}</span></span>
              <button class="btn btn-secondary btn-sm" data-ater="${escapeHtml(k.id)}">Återställ</button>
            </div>`).join('')}
        </div>`;
      korg.querySelectorAll('[data-ater]').forEach(b => b.addEventListener('click', () => withBusy(b, 'Återställer…', async () => {
        try {
          const post = await aterstallFranPapperskorg(cid, b.dataset.ater);
          toast(`${post?.data?.name || 'Posten'} är återställd`, 'success');
          await rita();
        } catch (e) { toast('Kunde inte återställa: ' + (e?.message || e), 'error'); }
      })));
    };
    await rita();
  })();

  // Danger zone (delete) — super-admin only
  if (isSuperAdmin) {
    const danger = document.createElement('section');
    danger.className = 'card mt-6';
    danger.style.borderColor = 'var(--utm-pink)';
    danger.innerHTML = `
      <h3 class="t-h3" style="margin-top:0;color:var(--utm-pink);">Farlig zon</h3>
      <p class="muted">Tar bort tävlingen permanent. Patruller, kontroller och poäng följer med. Kan inte ångras.</p>
      <button class="btn btn-danger mt-4" id="delete-comp">${icon('trash', { size: 16 })} Ta bort tävling</button>
    `;
    danger.querySelector('#delete-comp').addEventListener('click', async () => {
      // Grinden: färsk backup + namnet skrivet. Ett felklick här raderade
      // annars en hel tävlings poäng utan kopia.
      const ok = await confirmHardDelete({
        what: 'tävlingen',
        name: comp.name,
        hint: 'Patruller, kontroller och alla poäng försvinner.',
        onBackup: async () => {
          const { downloadBackup } = await import('../backup.js');
          await downloadBackup(cid);
        }
      });
      if (!ok) return;
      try {
        await deleteCompetition(cid);
        toast('Tävling borttagen');
        navigate('/app');
      } catch (e) {
        toast('Fel: ' + e.message, 'error');
      }
    });
    host.appendChild(danger);
  }

  return host;
}

function renderRulesTab(comp, cid, refresh, readOnly) {
  const host = document.createElement('div');
  host.className = 'field-group';

  const card = section('Regler och information', `
    <form class="field-group" ${readOnly ? 'inert' : ''}>
      <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
        <input type="checkbox" id="anonymousControls" ${comp.anonymousControls !== false ? 'checked' : ''} style="margin-top:4px;">
        <span>
          <strong>Anonyma kontroller ${help('comp.anonymousControls')}</strong>
          <div class="field-hint" style="margin-top:2px;">Patruller ser bara "Kontroll N" tills de fått poäng — då avslöjas kontrollens namn och poängen.</div>
        </span>
      </label>

      <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
          <input type="checkbox" id="publicScores" ${comp.publicScores !== false ? 'checked' : ''} style="margin-top:4px;">
          <span>
            <strong>Publicera poäng på publika sidan ${help('comp.publicScores')}</strong>
            <div class="field-hint" style="margin-top:2px;">Avbockad: publika sidan visar bara en grön bock när en patrull genomfört en kontroll — inga poäng, totaler eller placeringar. Bocka i när poängställningen ska publiceras (kan även växlas från poängtabellen).</div>
          </span>
        </label>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
          <input type="checkbox" id="publicControls" ${comp.publicControls !== false ? 'checked' : ''} style="margin-top:4px;">
          <span>
            <strong>Visa kontrollplatser på publika sidan ${help('comp.publicControls')}</strong>
            <div class="field-hint" style="margin-top:2px;">Avbockad: publika kartan visar start/mål, parkering och ett skuggat "Tävlingsområde" — men inga kontroller eller spår. Bocka i på tävlingsdagen. Startkort och inloggade ser alltid allt.</div>
          </span>
        </label>
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin-top:var(--sp-3);padding-left:26px;">
          <input type="checkbox" id="autoReleaseControls" ${comp.autoReleaseControls ? 'checked' : ''} style="margin-top:4px;">
          <span>
            <strong>Släpp banan automatiskt 5 min före första start ${help('comp.autoReleaseControls')}</strong>
            <div class="field-hint" style="margin-top:2px;">Gäller när kontrollplatserna är dolda: publika kartan visar kontroller och spår av sig själv 5 minuter före första patrullens starttid på tävlingsdatumet. Kräver att datum och starttider är satta.</div>
          </span>
        </label>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
          <input type="checkbox" id="autoCloseControls" ${comp.autoCloseControls ? 'checked' : ''} style="margin-top:4px;">
          <span>
            <strong>Stäng kontroller automatiskt ${help('comp.autoCloseControls')}</strong>
            <div class="field-hint" style="margin-top:2px;">När samtliga patruller rapporterat poäng på en kontroll stängs den automatiskt (syns som "Stängd" i listor). Gäller bara när en administratör är inne och tittar på kontrollen eller poängtabellen.</div>
          </span>
        </label>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
          <input type="checkbox" id="st-enabled" ${comp.startTimes?.enabled ? 'checked' : ''} style="margin-top:4px;">
          <span>
            <strong>Starttider ${help('comp.startTimes')}</strong>
            <div class="field-hint" style="margin-top:2px;">Patrullernas starttid beräknas utifrån deras ordning i patrullistan. Dra och släpp i patrullvyn för att ändra.</div>
          </span>
        </label>
        ${(() => {
          const mode = comp.startTimes?.mode === 'range' ? 'range' : 'interval';
          return `
            <div id="st-fields" style="display:${comp.startTimes?.enabled ? 'block' : 'none'};margin-top:var(--sp-3);">
              <div class="row wrap" style="gap:var(--sp-4);">
                <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                  <input type="radio" name="st-mode" value="interval" ${mode === 'interval' ? 'checked' : ''}>
                  Starttid + intervall
                </label>
                <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                  <input type="radio" name="st-mode" value="range" ${mode === 'range' ? 'checked' : ''}>
                  Starttid + sluttid
                </label>
              </div>
              <div class="grid grid-2 mt-3">
                <div>
                  <label class="field" for="st-firstStart">Första start</label>
                  <input class="input" type="time" id="st-firstStart" value="${escapeHtml(comp.startTimes?.firstStart || '09:00')}">
                </div>
                <div id="st-interval-field" style="display:${mode === 'range' ? 'none' : 'block'};">
                  <label class="field" for="st-interval">Intervall (minuter)</label>
                  <input class="input" type="number" id="st-interval" min="1" value="${comp.startTimes?.intervalMinutes ?? 5}">
                </div>
                <div id="st-last-field" style="display:${mode === 'range' ? 'block' : 'none'};">
                  <label class="field" for="st-lastStart">Sista start</label>
                  <input class="input" type="time" id="st-lastStart" value="${escapeHtml(comp.startTimes?.lastStart || '12:00')}">
                </div>
              </div>
              <div class="field-hint mt-2" id="st-range-hint" style="display:${mode === 'range' ? 'block' : 'none'};">Intervallet räknas ut automatiskt från antalet patruller. Går tider över midnatt (t.ex. 22:00 → 02:00) hanteras det korrekt.</div>
              <div class="mt-3" style="max-width:260px;">
                <label class="field" for="st-maxtime">Maxtid på banan (minuter, valfritt) ${help('comp.maxTime')}</label>
                <input class="input" type="number" id="st-maxtime" min="0" placeholder="T.ex. 240" value="${comp.startTimes?.maxTimeMinutes ?? ''}">
                <div class="field-hint">Visas som nedräkning på patrullernas startkort. Lämna tomt för ingen maxtid.</div>
              </div>
            </div>
          `;
        })()}
      </div>

      <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
          <input type="checkbox" id="selfStart" ${comp.selfStart === true ? 'checked' : ''} style="margin-top:4px;">
          <span>
            <strong>Patrullerna bekräftar start själva ${help('comp.selfStart')}</strong>
            <div class="field-hint" style="margin-top:2px;">Startkortet visar bara tävlingsinformation och vägen till starten tills patrullen tryckt "Bekräfta start" — knappen tänds först när deras starttid passerats. Först då visas kartan och kontrollerna. Bekräftelsen syns i Läget precis som en utcheckning från startstationen.</div>
          </span>
        </label>

        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin-top:var(--sp-3);">
          <input type="checkbox" id="selfFinish" ${comp.selfFinish === true ? 'checked' : ''} style="margin-top:4px;">
          <span>
            <strong>Patrullerna markerar sig i mål själva ${help('comp.selfFinish')}</strong>
            <div class="field-hint" style="margin-top:2px;">Knappen "Vi är i mål" dyker upp på startkortet när alla kontroller är rapporterade. Startfunktionärens incheckning fungerar som vanligt vid sidan om.</div>
          </span>
        </label>

        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin-top:var(--sp-3);">
          <input type="checkbox" id="fieldMessaging" ${comp.fieldMessaging !== false ? 'checked' : ''} style="margin-top:4px;">
          <span>
            <strong>Kontroller och patruller kan skriva till er ${help('comp.fieldMessaging')}</strong>
            <div class="field-hint" style="margin-top:2px;">En frågepanel på rapportsidorna och startkorten. De kan skicka text och foton; ni svarar under Meddelanden och svaret dyker upp direkt hos dem.</div>
          </span>
        </label>

        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin-top:var(--sp-3);">
          <input type="checkbox" id="autoFinish" ${comp.autoFinish === true ? 'checked' : ''} style="margin-top:4px;">
          <span>
            <strong>Registrera målgång automatiskt vid sista kontrollen ${help('comp.autoFinish')}</strong>
            <div class="field-hint" style="margin-top:2px;">Patrullen räknas som i mål när alla kontroller är rapporterade, med sista rapportens tid. <strong>Slå bara på detta när sista kontrollen ÄR målet</strong> — annars visar Läget patruller som hemma medan de fortfarande går.</div>
          </span>
        </label>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
        <label class="field" for="generalInfo">Allmän information ${help('comp.generalInfo')}</label>
        <textarea class="textarea" id="generalInfo" placeholder="T.ex. akutrutiner, ansvarig vid olycka…" rows="4">${escapeHtml(comp.generalInfo || '')}</textarea>
        <div class="field-hint">Syns under instruktionerna på varje kontrolls rapporteringssida.</div>
      </div>
    </form>
    ${readOnly ? '' : saveRow('Spara regler')}
  `);
  host.appendChild(card);

  const stEnabled = card.querySelector('#st-enabled');
  const stFields = card.querySelector('#st-fields');
  stEnabled.addEventListener('change', () => { stFields.style.display = stEnabled.checked ? 'block' : 'none'; });
  const applyStMode = () => {
    const m = card.querySelector('input[name="st-mode"]:checked').value;
    card.querySelector('#st-interval-field').style.display = m === 'range' ? 'none' : 'block';
    card.querySelector('#st-last-field').style.display = m === 'range' ? 'block' : 'none';
    card.querySelector('#st-range-hint').style.display = m === 'range' ? 'block' : 'none';
  };
  card.querySelectorAll('input[name="st-mode"]').forEach(r => r.addEventListener('change', applyStMode));

  wireSave(card, async () => {
    await updateCompetition(cid, {
      anonymousControls: card.querySelector('#anonymousControls').checked,
      publicScores: card.querySelector('#publicScores').checked,
      publicControls: card.querySelector('#publicControls').checked,
      autoReleaseControls: card.querySelector('#autoReleaseControls').checked,
      autoCloseControls: card.querySelector('#autoCloseControls').checked,
      startTimes: {
        enabled: card.querySelector('#st-enabled').checked,
        mode: card.querySelector('input[name="st-mode"]:checked').value,
        firstStart: card.querySelector('#st-firstStart').value || '09:00',
        intervalMinutes: Number(card.querySelector('#st-interval').value) || 5,
        lastStart: card.querySelector('#st-lastStart').value || null,
        maxTimeMinutes: Number(card.querySelector('#st-maxtime').value) || null
      },
      selfStart: card.querySelector('#selfStart').checked,
      fieldMessaging: card.querySelector('#fieldMessaging').checked,
      selfFinish: card.querySelector('#selfFinish').checked,
      autoFinish: card.querySelector('#autoFinish').checked,
      generalInfo: card.querySelector('#generalInfo').value.trim()
    });
    await refresh();
  });

  return host;
}

function renderAnmalanTab(comp, cid, refresh, readOnly) {
  const host = document.createElement('div');
  host.className = 'field-group';
  const s = registrationSettings(comp);

  // Local working copy of payment methods — rendered/synced below.
  const methods = s.methods.map(m => ({ ...m }));

  const priceFieldBlocks = `
    <div data-price-block="patrull" class="mt-3" style="max-width:280px;">
      <label class="field" for="rp-perPatrol">Kostnad per patrull (kr)</label>
      <input class="input" id="rp-perPatrol" type="number" min="0" value="${s.pricing.perPatrol}">
    </div>
    <div data-price-block="scout" class="mt-3" style="max-width:280px;">
      <label class="field" for="rp-perScout">Kostnad per scout (kr)</label>
      <input class="input" id="rp-perScout" type="number" min="0" value="${s.pricing.perScout}">
    </div>
    <div data-price-block="kar" class="mt-3" style="max-width:280px;">
      <label class="field" for="rp-flat">Kostnad per kår (kr)</label>
      <input class="input" id="rp-flat" type="number" min="0" value="${s.pricing.flat}">
    </div>
    <div data-price-block="dynamisk" class="mt-3">
      <div class="grid grid-2" style="max-width:560px;">
        <div>
          <label class="field" for="rp-base">Fast grundkostnad (kr)</label>
          <input class="input" id="rp-base" type="number" min="0" value="${s.pricing.base}">
        </div>
        <div>
          <label class="field" for="rp-perUnit">Avgift per enhet (kr)</label>
          <input class="input" id="rp-perUnit" type="number" min="0" value="${s.pricing.perUnit}">
        </div>
      </div>
      <div class="row wrap mt-3" style="gap:var(--sp-4);">
        <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="radio" name="rp-unit" value="patrull" ${s.pricing.unit === 'patrull' ? 'checked' : ''}> Avgift per patrull
        </label>
        <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="radio" name="rp-unit" value="scout" ${s.pricing.unit === 'scout' ? 'checked' : ''}> Avgift per scout
        </label>
      </div>
    </div>
  `;

  const card = section('Anmälan', `
    <form class="field-group" ${readOnly ? 'inert' : ''}>
      <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
        <input type="checkbox" id="reg-enabled" ${s.enabled ? 'checked' : ''} style="margin-top:4px;">
        <span>
          <strong>Öppna för anmälan ${help('reg.enabled')}</strong>
          <div class="field-hint" style="margin-top:2px;">Kårer/patruller anmäler sig via den publika anmälningssidan. Länken hittar du längst ner.</div>
        </span>
      </label>

      <div id="reg-fields" style="display:${s.enabled ? 'block' : 'none'};" class="field-group">
        <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
          <label class="field">Anmälningssätt ${help('reg.mode')}</label>
          <div class="row wrap" style="gap:var(--sp-4);">
            <label style="display:inline-flex;align-items:flex-start;gap:8px;cursor:pointer;max-width:280px;">
              <input type="radio" name="reg-mode" value="kar" ${s.mode === 'kar' ? 'checked' : ''} style="margin-top:3px;">
              <span><strong>Kårvis</strong><div class="field-hint">En anmälan per kår — samtliga patruller anmäls och betalas tillsammans.</div></span>
            </label>
            <label style="display:inline-flex;align-items:flex-start;gap:8px;cursor:pointer;max-width:280px;">
              <input type="radio" name="reg-mode" value="patrull" ${s.mode === 'patrull' ? 'checked' : ''} style="margin-top:3px;">
              <span><strong>Patrullvis</strong><div class="field-hint">Varje patrull ansvarar för sin egen anmälan och betalning.</div></span>
            </label>
          </div>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
          <label class="field">Anmälningsperiod ${help('reg.period')}</label>
          <div class="grid grid-2" style="max-width:460px;">
            <div>
              <label class="field" for="reg-opens">Öppnar</label>
              <input class="input" id="reg-opens" type="date" value="${s.opensAt || ''}">
            </div>
            <div>
              <label class="field" for="reg-closes">Stänger</label>
              <input class="input" id="reg-closes" type="date" value="${s.closesAt || ''}">
            </div>
          </div>
          <div class="field-hint">Under perioden kan anmälningar skapas och ändras. Efteråt kan anmälare bara titta på sin anmälan och anmäla förhinder.</div>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
          <label class="field">Prismodell ${help('reg.pricing')}</label>
          <div class="field-group" style="gap:var(--sp-2);">
            ${REG_PRICING_MODELS.map(m => `
              <label style="display:inline-flex;align-items:flex-start;gap:8px;cursor:pointer;">
                <input type="radio" name="rp-model" value="${m.key}" ${s.pricing.model === m.key ? 'checked' : ''} style="margin-top:3px;">
                <span><strong>${escapeHtml(m.label)}</strong><div class="field-hint">${escapeHtml(m.hint)}</div></span>
              </label>
            `).join('')}
          </div>
          ${priceFieldBlocks}
        </div>

        <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
          <label class="field">Betalningssätt ${help('reg.methods')}</label>
          <div class="field-hint" style="margin-bottom:var(--sp-3);">Visas på betalningssidan. Swish genererar en QR-kod med belopp och betalningsreferens låsta.</div>
          <div id="method-list"></div>
          <button type="button" class="btn btn-secondary btn-sm" id="add-method">${icon('plus', { size: 14 })} Lägg till betalningssätt</button>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
          <label class="field">Egna fält i anmälan ${help('reg.fields')}</label>
          <div class="field-hint" style="margin-bottom:var(--sp-3);">Fritextfrågor som anmälaren fyller i — t.ex. "Information till tävlingsledningen" (en per anmälan) eller "Allergier" (en per patrull).</div>
          <div id="field-list"></div>
          <button type="button" class="btn btn-secondary btn-sm" id="add-field">${icon('plus', { size: 14 })} Lägg till fält</button>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
          <label class="field" for="reg-info">Information på anmälningssidan</label>
          <textarea class="textarea" id="reg-info" rows="3" placeholder="Ex. Anmälan är bindande. Frågor? Kontakta…">${escapeHtml(s.info)}</textarea>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:var(--sp-4);">
          <label class="field">Publik anmälningslänk</label>
          <div class="row" style="gap:var(--sp-2);align-items:center;flex-wrap:wrap;">
            <code style="background:var(--bg-muted);padding:6px 10px;border-radius:var(--r-sm);font-size:13px;">${escapeHtml(registrationUrl(comp.slug || cid))}</code>
            <button type="button" class="btn btn-ghost btn-sm" id="copy-reg-link">${icon('copy', { size: 14 })} Kopiera</button>
            <a class="btn btn-ghost btn-sm" href="/a/${cid}" target="_blank" rel="noopener">${icon('external', { size: 14 })} Öppna</a>
          </div>
        </div>
      </div>
    </form>
    ${readOnly ? '' : saveRow('Spara anmälningsinställningar')}
  `);
  host.appendChild(card);

  // --- enable toggle ---------------------------------------------------------
  const enabledBox = card.querySelector('#reg-enabled');
  const fields = card.querySelector('#reg-fields');
  enabledBox.addEventListener('change', () => {
    fields.style.display = enabledBox.checked ? 'block' : 'none';
  });

  // --- pricing model visibility ---------------------------------------------
  const applyPriceVisibility = () => {
    const m = card.querySelector('input[name="rp-model"]:checked').value;
    card.querySelectorAll('[data-price-block]').forEach(b => {
      b.style.display = b.dataset.priceBlock === m ? 'block' : 'none';
    });
  };
  card.querySelectorAll('input[name="rp-model"]').forEach(r => r.addEventListener('change', applyPriceVisibility));
  applyPriceVisibility();

  // --- payment methods editor ------------------------------------------------
  const methodList = card.querySelector('#method-list');
  const renderMethods = () => {
    methodList.innerHTML = methods.length ? methods.map((m, i) => `
      <div class="card" data-midx="${i}" style="padding:var(--sp-4);background:var(--bg-muted);box-shadow:none;margin-bottom:var(--sp-3);">
        <div class="row wrap" style="gap:var(--sp-3);align-items:flex-end;">
          <div>
            <label class="field">Typ</label>
            <select class="select" data-mf="type" style="max-width:160px;">
              <option value="swish" ${m.type === 'swish' ? 'selected' : ''}>Swish</option>
              <option value="bankgiro" ${m.type === 'bankgiro' ? 'selected' : ''}>Bankgiro</option>
              <option value="faktura" ${m.type === 'faktura' ? 'selected' : ''}>Faktura</option>
            </select>
          </div>
          ${m.type !== 'faktura' ? `
            <div style="flex:1;min-width:180px;">
              <label class="field">${m.type === 'swish' ? 'Swish-nummer' : 'Bankgironummer'}</label>
              <input class="input" data-mf="number" value="${escapeHtml(m.number || '')}" placeholder="${m.type === 'swish' ? '123 456 78 90' : '123-4567'}">
            </div>
          ` : `
            <div style="flex:1;min-width:220px;">
              <label class="field">Fakturainstruktioner</label>
              <input class="input" data-mf="info" value="${escapeHtml(m.info || '')}" placeholder="Ex. Maila fakturaadress till kassor@kåren.se">
            </div>
          `}
          <div style="min-width:140px;">
            <label class="field">Etikett (valfri)</label>
            <input class="input" data-mf="label" value="${escapeHtml(m.label || '')}" placeholder="Ex. Swish till kassören">
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-mremove="${i}" style="color:var(--utm-pink);">${icon('trash', { size: 14 })}</button>
        </div>
      </div>
    `).join('') : '<p class="muted t-sm">Inga betalningssätt tillagda ännu.</p>';
  };
  const syncMethods = () => {
    methodList.querySelectorAll('[data-midx]').forEach(row => {
      const i = Number(row.dataset.midx);
      const field = f => row.querySelector(`[data-mf="${f}"]`);
      methods[i] = {
        type: field('type').value,
        label: field('label').value,
        number: field('number') ? field('number').value : (methods[i].number || ''),
        info: field('info') ? field('info').value : (methods[i].info || '')
      };
    });
  };
  methodList.addEventListener('input', syncMethods);
  methodList.addEventListener('change', (e) => {
    if (e.target.matches('[data-mf="type"]')) {
      syncMethods();
      const i = Number(e.target.closest('[data-midx]').dataset.midx);
      methods[i].type = e.target.value;
      renderMethods();
    }
  });
  methodList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mremove]');
    if (!btn) return;
    syncMethods();
    methods.splice(Number(btn.dataset.mremove), 1);
    renderMethods();
  });
  card.querySelector('#add-method').addEventListener('click', () => {
    syncMethods();
    methods.push({ type: 'swish', label: '', number: '', info: '' });
    renderMethods();
  });
  renderMethods();

  // --- custom fields editor --------------------------------------------------
  const customFields = s.fields.map(f => ({ ...f }));
  const fieldList = card.querySelector('#field-list');
  const renderFields = () => {
    fieldList.innerHTML = customFields.length ? customFields.map((f, i) => `
      <div class="card" data-fidx="${i}" style="padding:var(--sp-4);background:var(--bg-muted);box-shadow:none;margin-bottom:var(--sp-3);">
        <div class="row wrap" style="gap:var(--sp-3);align-items:flex-end;">
          <div style="flex:1;min-width:220px;">
            <label class="field">Fältets rubrik</label>
            <input class="input" data-ff="label" value="${escapeHtml(f.label || '')}" placeholder="Ex. Allergier">
          </div>
          <div>
            <label class="field">Frågan ställs</label>
            <select class="select" data-ff="scope" style="max-width:170px;">
              <option value="anmalan" ${f.scope !== 'patrull' ? 'selected' : ''}>Per anmälan</option>
              <option value="patrull" ${f.scope === 'patrull' ? 'selected' : ''}>Per patrull</option>
            </select>
          </div>
          <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;padding-bottom:8px;">
            <input type="checkbox" data-ff="required" ${f.required ? 'checked' : ''} style="margin:0;"> Obligatoriskt
          </label>
          <button type="button" class="btn btn-ghost btn-sm" data-fremove="${i}" style="color:var(--utm-pink);">${icon('trash', { size: 14 })}</button>
        </div>
        <div class="mt-2">
          <label class="field">Beskrivning (valfri)</label>
          <textarea class="textarea" data-ff="description" rows="2" placeholder="Hjälptext under rubriken — t.ex. ingredienser, vad svaret används till…">${escapeHtml(f.description || '')}</textarea>
        </div>
      </div>
    `).join('') : '<p class="muted t-sm">Inga egna fält tillagda.</p>';
  };
  const syncFields = () => {
    fieldList.querySelectorAll('[data-fidx]').forEach(row => {
      const i = Number(row.dataset.fidx);
      customFields[i] = {
        id: customFields[i].id,
        label: row.querySelector('[data-ff="label"]').value,
        description: row.querySelector('[data-ff="description"]').value,
        scope: row.querySelector('[data-ff="scope"]').value,
        required: row.querySelector('[data-ff="required"]').checked
      };
    });
  };
  fieldList.addEventListener('input', syncFields);
  fieldList.addEventListener('change', syncFields);
  fieldList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fremove]');
    if (!btn) return;
    syncFields();
    customFields.splice(Number(btn.dataset.fremove), 1);
    renderFields();
  });
  card.querySelector('#add-field').addEventListener('click', () => {
    syncFields();
    customFields.push({ id: crypto.randomUUID(), label: '', description: '', scope: 'anmalan', required: false });
    renderFields();
  });
  renderFields();

  card.querySelector('#copy-reg-link').addEventListener('click', () => {
    copyToClipboard(registrationUrl(comp.slug || cid));
    toast('Länk kopierad', 'success');
  });

  wireSave(card, async () => {
    syncMethods();
    const num = id => Number(card.querySelector(id).value) || 0;
    await updateCompetition(cid, {
      registration: {
        enabled: enabledBox.checked,
        mode: card.querySelector('input[name="reg-mode"]:checked').value,
        opensAt: card.querySelector('#reg-opens').value || null,
        closesAt: card.querySelector('#reg-closes').value || null,
        info: card.querySelector('#reg-info').value.trim(),
        pricing: {
          model: card.querySelector('input[name="rp-model"]:checked').value,
          perPatrol: num('#rp-perPatrol'),
          perScout: num('#rp-perScout'),
          flat: num('#rp-flat'),
          base: num('#rp-base'),
          unit: card.querySelector('input[name="rp-unit"]:checked').value,
          perUnit: num('#rp-perUnit')
        },
        methods: methods
          .filter(m => m.type === 'faktura' ? true : (m.number || '').trim())
          .map(m => ({
            type: m.type,
            label: (m.label || '').trim(),
            number: (m.number || '').trim(),
            info: (m.info || '').trim()
          })),
        fields: (syncFields(), customFields)
          .filter(f => (f.label || '').trim())
          .map(f => ({
            id: f.id,
            label: f.label.trim(),
            description: (f.description || '').trim(),
            scope: f.scope === 'patrull' ? 'patrull' : 'anmalan',
            required: f.required === true
          }))
      }
    });
    await refresh();
  });

  return host;
}

// Platser — allt som ska pekas ut på kartan UTOM banans ändpunkter.
//
// Start och mål bor i kontrollistan: de är bandata (ETA-motorn räknar sträckor från
// dem, spåret hänger på dem), inte utmärkning. Här finns parkeringen och
// resten — sekretariat, toaletter, vatten, egna punkter med egen symbol och
// färg.
function renderPlacesTab(comp, cid, refresh, readOnly) {
  const host = document.createElement('div');

  // Kartkontext: banans kontroller och start/mål ritas dämpat i väljaren så
  // man ser var punkten hamnar i förhållande till banan. Hämtas en gång och
  // används i alla dialoger på fliken.
  let ctx = { controls: [], places: [], startFinish: startFinishPoints(comp) };
  listControls(cid)
    .then(rows => {
      ctx.controls = rows
        .filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lng))
        .sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
      draw();   // "Passeras efter"-listan behöver kontrollerna
    })
    .catch(() => {});

  const spara = async (lista) => {
    await updateCompetition(cid, { places: lista.map(placeToStorage) });
    await refresh();
  };

  const card = section('Platser på kartan', `
    <p class="muted t-sm" style="margin-top:-4px;">Visas på tävlingssidan, startkorten och i Läget. Parkering, sekretariat och toaletter är det folk letar efter först — men lägg gärna till egna punkter också.</p>
    <div id="pl-list"></div>
    ${readOnly ? '' : `<div class="btn-row mt-3"><button class="btn btn-secondary btn-sm" id="pl-add">${icon('plus', { size: 15 })} Lägg till plats</button></div>`}
  `, { help: 'comp.places' });
  host.appendChild(card);

  const list = card.querySelector('#pl-list');

  function draw() {
    const platser = compPlaces(comp);
    if (!platser.length) {
      list.innerHTML = `<div class="empty" style="padding:var(--sp-5);">
        <p class="muted" style="margin:0;">Inga platser utsatta än.</p></div>`;
      return;
    }
    list.innerHTML = platser.map((p, i) => `
      <button type="button" class="place-row" data-i="${i}" ${readOnly ? 'disabled' : ''}>
        <span class="place-dot" style="background:${p.colorHex};">${icon(p.icon, { size: 18 })}</span>
        <span class="place-body">
          <span class="place-name">${escapeHtml(p.name)}</span>
          <span class="muted t-sm" style="display:block;">${escapeHtml(placeKind(p.kind).label)}${p.note ? ' · ' + escapeHtml(p.note) : ''}</span>
        </span>
        <span class="muted t-sm mono">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</span>
      </button>
    `).join('');

    list.querySelectorAll('[data-i]').forEach(btn => btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i);
      const platser = compPlaces(comp);
      openPlaceModal({
        title: 'Redigera plats',
        value: platser[i],
        fields: { kind: true, look: true, course: true },
        context: { ...ctx, places: platser },
        namePlaceholder: 'Ex. Grusparkeringen vid scoutgården',
        onSave: async (v) => {
          const nya = platser.map((p, j) => j === i ? { ...p, ...v } : p);
          await spara(nya);
          toast('Platsen sparad', 'success');
        },
        onDelete: async () => {
          if (!(await confirmDialog(`Ta bort "${platser[i].name}" från kartan?`, { okLabel: 'Ta bort', danger: true }))) return;
          await spara(platser.filter((_, j) => j !== i));
          toast('Platsen borttagen');
        }
      });
    }));
  }
  draw();

  card.querySelector('#pl-add')?.addEventListener('click', () => {
    openPlaceModal({
      title: 'Ny plats',
      value: { kind: 'parkering' },
      fields: { kind: true, look: true, course: true },
      context: { ...ctx, places: compPlaces(comp) },
      namePlaceholder: 'Ex. Grusparkeringen vid scoutgården',
      onSave: async (v) => {
        // Id:t behöver bara vara unikt inom tävlingen — listan är kort och
        // ordningen är den arrangören lagt den i.
        const nytt = { ...v, id: 'p' + Math.random().toString(36).slice(2, 9) };
        await spara([...compPlaces(comp), nytt]);
        toast('Platsen tillagd', 'success');
      }
    });
  });

  // Genväg tillbaka till banan — start/mål hör hemma där, men det är hit man
  // går när man tänker "platser".
  const genvag = section('Start och mål', `
    <p class="muted t-sm" style="margin-top:-4px;">Banans start- och målplats sätts i kontrollistan, tillsammans med resten av banan. Normalt samma plats; går det att välja två olika gör du det där.</p>
    <div class="btn-row"><a class="btn btn-secondary btn-sm" href="/app/c/${escapeHtml(cid)}/controls" data-link>Öppna kontrollistan</a></div>
  `);
  host.appendChild(genvag);

  return host;
}

function renderManagementTab(comp, cid, refresh, readOnly) {
  const host = document.createElement('div');
  const card = document.createElement('section');
  card.className = 'card';
  card.innerHTML = `
    <h3 class="t-h3" style="margin-top:0;">Tävlingsledning${help('comp.management')}</h3>
    <p class="muted t-sm" style="margin-top:-6px;">Lägg till valfria roller. Välj för varje om den ska vara <strong>publik</strong> (syns på startkort och offentlig sida) eller <strong>intern</strong> (syns bara på kontrollernas rapportkort).</p>
  `;
  const form = document.createElement('form');
  if (readOnly) form.setAttribute('inert', '');
  card.appendChild(form);

  const mgmt = createManagementForm(comp, { seedDefaults: false });
  form.appendChild(mgmt.element);

  if (!readOnly) {
    const saveBlock = document.createElement('div');
    saveBlock.innerHTML = saveRow('Spara tävlingsledning');
    card.appendChild(saveBlock);
  }

  host.appendChild(card);

  wireSave(card, async () => {
    // Union — ticking "Bjud in som administratör" adds; removal happens
    // deliberately under Användare, never as a side effect here.
    const adminEmails = [...new Set([...(comp.adminEmails || []), ...mgmt.adminInvites()])];
    const management = mgmt.read();
    await updateCompetition(cid, { management, adminEmails });
    // The ekonomi-flagged roles ARE the ekonomiansvarig list — sync the
    // permission mirror (private/access) from them, adds and removals alike.
    await setCompetitionEkonomi(cid, ekonomiFromManagement(management));
    await refresh();
  });

  return host;
}

// ---- members / admins ------------------------------------------------------
function renderMembersTab(comp, cid, user, refresh) {
  const host = document.createElement('div');
  host.className = 'field-group';

  const card = document.createElement('section');
  card.className = 'card';
  card.innerHTML = `
    <h3 class="t-h3" style="margin-top:0;">Användare &amp; administratörer${help('comp.users')}</h3>
    <p class="muted t-sm" style="margin-top:-6px;">Ange e-postadress (och gärna namn) — personen behöver inte ha loggat in i ESKIL tidigare, rättigheterna gäller från första inloggningen. Kontrollansvariga utses på respektive kontroll.</p>
    <div id="member-body"><div class="muted">Laddar…</div></div>
  `;
  host.appendChild(card);

  const body = card.querySelector('#member-body');
  const myEmail = normEmail(user.email);
  // Legacy entries: users used to be uid arrays; treat string entries as uids.
  const userEntries = (comp.users || []).filter(u => u && typeof u === 'object');
  const legacyUserUids = (comp.users || []).filter(u => typeof u === 'string');

  (async () => {
    const [legacyAdminEmails, legacyUserEmails, controls] = await Promise.all([
      lookupEmailsForUids(comp.admins || []),
      lookupEmailsForUids(legacyUserUids),
      // ansvariga live in each control's private/meta since Fas 3c — the raw
      // docs no longer carry them, so merge the meta or the overview is empty.
      listControls(cid).then(cs => attachControlMeta(cid, cs)).catch(() => [])
    ]);

    // Administratörer kommer från TVÅ håll: legacy-uid:n i `admins` (skaparen)
    // och e-postlistan `adminEmails` (inbjudna). Samma person kan stå i båda —
    // t.ex. den som fick tävlingen via en godkänd förfrågan, som blir skapare
    // OCH inbjuden. Slå ihop dem på e-post så listan visar personer, inte
    // poster; "Ta bort" städar båda ställena i en och samma skrivning.
    const adminRows = [];
    const adminByKey = new Map();
    const addAdminRow = (key, patch) => {
      let row = adminByKey.get(key);
      if (!row) { row = { uid: null, email: null, label: key }; adminByKey.set(key, row); adminRows.push(row); }
      Object.assign(row, patch);
      return row;
    };
    (comp.admins || []).forEach((uid, i) => {
      const email = normEmail(legacyAdminEmails[i] || '');
      addAdminRow(email || `uid:${uid}`, { uid, ...(email ? { email } : {}), label: email || uid });
    });
    (comp.adminEmails || []).forEach(e => {
      const email = normEmail(e);
      if (email) addAdminRow(email, { email, label: e });
    });
    adminRows.forEach(r => {
      r.isMe = (r.email && r.email === myEmail) || (r.uid && r.uid === user.uid);
    });

    // Kontrollansvariga överblick: email -> { name, controls: [nr] }
    const ansvariga = new Map();
    for (const c of [...controls].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0))) {
      for (const a of (c.ansvariga || [])) {
        const key = normEmail(a.email);
        if (!key) continue;
        if (!ansvariga.has(key)) ansvariga.set(key, { name: a.name || '', controls: [] });
        ansvariga.get(key).controls.push(c.nummer ?? '?');
        if (a.name && !ansvariga.get(key).name) ansvariga.get(key).name = a.name;
      }
    }

    body.innerHTML = `
      ${(comp.admins || []).length + (comp.adminEmails || []).length <= 1 ? `
        <div class="mt-4" style="border:1px solid var(--border);border-left:3px solid var(--avent-orange);border-radius:10px;padding:10px 14px;">
          <strong style="color:var(--avent-orange);">Du är ensam administratör</strong>
          <p class="muted t-sm" style="margin:4px 0 0;">Tappar du åtkomsten på tävlingsdagen (mobil i sjön, dött batteri) kan ingen annan administrera tävlingen. Lägg till minst en reservadmin nedan.</p>
        </div>` : ''}
      <div class="mt-4">
        <h4 class="t-over">Administratörer (${adminRows.length})</h4>
        <ul class="muted t-sm" style="padding-left:16px;margin:6px 0 10px;">
          ${adminRows.map((r, i) => `<li>
            ${escapeHtml(r.label)}
            ${r.isMe
              ? '<span class="muted">(du)</span>'
              : `<button class="btn btn-ghost btn-sm" style="color:var(--utm-pink);margin-left:8px;" data-remove-admin-row="${i}">Ta bort</button>`}
          </li>`).join('')}
          ${adminRows.length ? '' : '<li>—</li>'}
        </ul>
        <div class="row">
          <input class="input" type="email" placeholder="e-post@exempel.se" id="new-admin-email" style="max-width:320px;">
          <button class="btn btn-secondary btn-sm" id="add-admin">${icon('plus', { size: 14 })} Lägg till admin</button>
        </div>
      </div>

      <div class="mt-6">
        <h4 class="t-over">Användare — läsåtkomst (${userEntries.length + legacyUserUids.length})</h4>
        <ul class="muted t-sm" style="padding-left:16px;margin:6px 0 10px;">
          ${userEntries.map(u => `<li>
            ${u.name ? `<strong>${escapeHtml(u.name)}</strong> · ` : ''}${escapeHtml(u.email)}
            ${ansvariga.has(normEmail(u.email)) ? `<span class="badge badge-blue" style="margin-left:4px;">Kontrollansvarig</span>` : ''}
            <button class="btn btn-ghost btn-sm" style="color:var(--utm-pink);margin-left:8px;" data-remove-user="${escapeHtml(u.email)}">Ta bort</button>
          </li>`).join('')}
          ${legacyUserEmails.map((e, i) => `<li>
            ${escapeHtml(e || legacyUserUids[i])} <span class="muted">(äldre format)</span>
            <button class="btn btn-ghost btn-sm" style="color:var(--utm-pink);margin-left:8px;" data-remove-legacy-user="${legacyUserUids[i]}">Ta bort</button>
          </li>`).join('')}
          ${!userEntries.length && !legacyUserUids.length ? '<li>—</li>' : ''}
        </ul>
        <div class="row wrap">
          <input class="input" type="email" placeholder="e-post@exempel.se" id="new-user-email" style="max-width:280px;">
          <input class="input" placeholder="Namn (frivilligt)" id="new-user-name" style="max-width:220px;">
          <button class="btn btn-secondary btn-sm" id="add-user">${icon('plus', { size: 14 })} Lägg till användare</button>
        </div>
      </div>

      <div class="mt-6">
        <h4 class="t-over">Kontrollansvariga (${ansvariga.size})</h4>
        ${ansvariga.size ? `
          <ul class="muted t-sm" style="padding-left:16px;margin:6px 0 10px;">
            ${[...ansvariga.entries()].map(([email, a]) => `<li>
              ${a.name ? `<strong>${escapeHtml(a.name)}</strong> · ` : ''}${escapeHtml(email)}
              <span class="muted">— kontroll ${a.controls.join(', ')}</span>
            </li>`).join('')}
          </ul>
        ` : '<p class="muted t-sm" style="margin:6px 0 10px;">Inga kontrollansvariga utsedda.</p>'}
        <p class="field-hint">Kontrollansvariga kan redigera och öppna/stänga sin kontroll, och har läsåtkomst till resten av tävlingen. De utses på respektive kontrollsida och står automatiskt med som användare ovan.</p>
      </div>

      <div class="mt-6">
        <h4 class="t-over">Ekonomiansvariga / kassörer (${(comp.ekonomi || []).length})</h4>
        ${(comp.ekonomi || []).length ? `
          <ul class="muted t-sm" style="padding-left:16px;margin:6px 0 10px;">
            ${(comp.ekonomi || []).map(e => `<li>
              ${e.name ? `<strong>${escapeHtml(e.name)}</strong> · ` : ''}${escapeHtml(e.email)}
            </li>`).join('')}
          </ul>
        ` : '<p class="muted t-sm" style="margin:6px 0 10px;">Ingen ekonomiansvarig utsedd.</p>'}
        <p class="field-hint">Ekonomiansvariga kan pricka av anmälningarnas betalningar och har läsåtkomst till hela tävlingen. De utses under fliken Tävlingsledning (kryssrutan "Ekonomiansvarig / kassör" på rollen).</p>
      </div>
    `;

    const adminBtn = body.querySelector('#add-admin');
    adminBtn.addEventListener('click', () => withBusy(adminBtn, 'Lägger till…', async () => {
      const email = normEmail(body.querySelector('#new-admin-email').value);
      if (!email) return;
      const existing = comp.adminEmails || [];
      if (existing.includes(email)) { toast('Är redan administratör'); return; }
      try {
        await updateCompetition(cid, { adminEmails: [...existing, email] });
        await refresh();
        toast('Administratör tillagd', 'success');
      } catch (e) { toast('Fel: ' + e.message, 'error'); }
    }));

    const userBtn = body.querySelector('#add-user');
    userBtn.addEventListener('click', () => withBusy(userBtn, 'Lägger till…', async () => {
      const email = normEmail(body.querySelector('#new-user-email').value);
      const name = body.querySelector('#new-user-name').value.trim();
      if (!email) return;
      if (userEntries.some(u => normEmail(u.email) === email)) { toast('Användaren är redan tillagd'); return; }
      try {
        await setCompetitionUsers(cid, [...userEntries, { email, name }]);
        await refresh();
        toast('Användare tillagd', 'success');
      } catch (e) { toast('Fel: ' + e.message, 'error'); }
    }));

    // En rad = en person. Tas hen bort ska både uid-posten och e-postposten
    // gå, annars är personen kvar som admin via det andra spåret.
    body.querySelectorAll('[data-remove-admin-row]').forEach(b => b.addEventListener('click', async () => {
      const row = adminRows[Number(b.dataset.removeAdminRow)];
      if (!row) return;
      if (!(await confirmDialog(`Ta bort ${row.label} som administratör?`))) return;
      const patch = {};
      if (row.uid) patch.admins = (comp.admins || []).filter(x => x !== row.uid);
      if (row.email) patch.adminEmails = (comp.adminEmails || []).filter(x => normEmail(x) !== row.email);
      try { await updateCompetition(cid, patch); await refresh(); toast('Borttagen'); }
      catch (e) { toast(e.message, 'error'); }
    }));
    body.querySelectorAll('[data-remove-user]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Ta bort denna användare?'))) return;
      const email = normEmail(b.dataset.removeUser);
      try {
        await setCompetitionUsers(cid, userEntries.filter(u => normEmail(u.email) !== email));
        await refresh(); toast('Borttagen');
      } catch (e) { toast(e.message, 'error'); }
    }));
    body.querySelectorAll('[data-remove-legacy-user]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Ta bort denna användare?'))) return;
      const uid = b.dataset.removeLegacyUser;
      try {
        await updateCompetition(cid, { users: (comp.users || []).filter(x => x !== uid) });
        await refresh(); toast('Borttagen');
      } catch (e) { toast(e.message, 'error'); }
    }));
  })();

  return host;
}

async function lookupEmailsForUids(uids) {
  const out = [];
  for (const uid of uids) {
    try {
      const s = await getDoc(doc(db, 'users', uid));
      out.push(s.exists() ? s.data().email : null);
    } catch { out.push(null); }
  }
  return out;
}


// ---------------------------------------------------------------------------
// AI-koppling (MCP). Kårledaren kopplar sin egen LLM till EN tävling och
// konfigurerar den i ett samtal.
//
// Sidan har tre uppgifter, i den ordningen: säga vad som INTE går att läsa
// (annars tror man att något är sönder när modellen svarar "(ifyllt)"), visa
// hur man kopplar in den, och ge färdiga prompter att klistra in. Nyckeln
// visas EN gång — bara hashen sparas.
//
// INKOPPLINGEN ÄR EN EGEN, ALLTID SYNLIG RUTA, och det är två rättelser i en:
//
//  1. Anvisningen låg förut INUTI engångsvisningen av nyckeln. Klickade man
//     "Jag har sparat den" försvann den, och kom man tillbaka en vecka senare
//     fanns ingen instruktion kvar — man fick återkalla en fungerande nyckel
//     bara för att se hur den skulle användas. Adressen är hemlig; det HUR man
//     kopplar in den är det inte. Utan färsk nyckel visas därför samma
//     anvisning med DIN-NYCKEL i adressens sista led.
//  2. Anvisningen var EN rad, `claude mcp add …`, och den gäller ett enda
//     program. Servern fungerar med varje klient som talar Streamable HTTP, så
//     texten var en onödig inlåsning. Katalogen bor i mcp-klienter.js.
// ---------------------------------------------------------------------------
function renderMcpTab(comp, cid, refresh, readOnly) {
  const host = document.createElement('div');
  // KANONISK VÄRD, inte location.origin — samma skäl som ORIGIN i seo.js.
  // Fyra värdnamn svarar 200 med identiskt innehåll (även www., .web.app och
  // .firebaseapp.com), så en admin som råkat komma in via ett av dem hade fått
  // en inkopplingsadress på den värden. Anthropics egen felsökningslista pekar
  // ut just det som en vanlig orsak till att en koppling slutar fungera:
  // adressen ska vara den servern faktiskt lyssnar på, inte en som kan komma
  // att omdirigeras dit. På localhost används den lokala värden — där finns
  // ingen prod-nyckel att koppla in med ändå.
  const LOKALT = ['localhost', '127.0.0.1', '0.0.0.0'].includes(location.hostname);
  const bas = LOKALT ? location.origin : 'https://eskilscout.se';

  const kort = document.createElement('section');
  kort.className = 'card';
  kort.innerHTML = `
    <h3 class="t-h3" style="margin-top:0;">Koppla en AI-assistent</h3>
    <p class="muted">Du kan låta en AI-assistent lägga upp tävlingen åt dig — skapa kontroller,
    lägga in patruller, sätta inställningar. Du pratar med din egen assistent; ESKIL skickar
    ingenting till någon AI-tjänst av sig själv.</p>

    <div class="no-cookies" style="border-left-color: var(--scout-blue);">
      <strong>Assistenten kan inte läsa kontaktuppgifter.</strong>
      Telefonnummer, e-postadresser och personnamn svarar alltid <em>”ifyllt”</em> eller
      <em>”saknas”</em> — aldrig värdet. Den kan däremot <em>sätta</em> dem, och då passerar
      uppgiften din AI-leverantör på vägen in. Patrullnamn och kårnamn är läsbara; de står
      redan på den publika tävlingssidan.
      <br><br>
      Assistenten når inte anmälningar, utskick, säkerhetskopior, PDF:er, fältets meddelanden
      eller papperskorgen, och kan inte avsluta eller radera tävlingen.
      <a href="/integritet">Så hanteras personuppgifter</a>.
    </div>

    <div id="mcp-nyckel"></div>
  `;
  host.appendChild(kort);

  const nyckelHost = kort.querySelector('#mcp-nyckel');

  // Sista ledet i adressen när ingen färsk nyckel finns att visa. Ett tydligt
  // ord slår en tom lucka: kopierar man kommandot rakt av blir felet synligt i
  // stället för att adressen tyst pekar på ingenting.
  const NYCKEL_PLATS = 'DIN-NYCKEL';
  let visadUrl = null;

  const ritaStatus = async () => {
    const st = await mcpNyckelStatus(cid);
    nyckelHost.innerHTML = st.finns
      ? `<p><strong>En nyckel finns.</strong>${st.senastAnvand
            ? ` Senast använd ${formatDate(st.senastAnvand)}.`
            : ' Den har inte använts ännu.'}</p>
         <p class="muted t-sm">Nyckeln visades bara när den skapades. Har du tappat bort den
         skapar du en ny — då slutar den gamla fungera direkt.</p>
         <div class="btn-row">
           <button class="btn btn-secondary" id="mcp-ny">Skapa ny nyckel</button>
           <button class="btn btn-danger" id="mcp-aterkalla">Återkalla</button>
         </div>`
      : `<p>Ingen nyckel är skapad. Utan nyckel kan ingen assistent nå tävlingen.</p>
         <div class="btn-row"><button class="btn btn-primary" id="mcp-ny">Skapa nyckel</button></div>`;

    nyckelHost.querySelector('#mcp-ny')?.addEventListener('click', (e) =>
      withBusy(e.currentTarget, 'Skapar…', async () => {
        const nyckel = await myntaMcpNyckel(cid);
        visaNyckel(nyckel);
      }));
    nyckelHost.querySelector('#mcp-aterkalla')?.addEventListener('click', async (e) => {
      if (!await confirmDialog(
        'Återkalla nyckeln? Assistenten tappar åtkomsten direkt. Tävlingens data påverkas inte.',
        { okLabel: 'Återkalla', danger: true })) return;
      await withBusy(e.currentTarget, 'Återkallar…', async () => {
        await aterkallaMcpNyckel(cid);
        visadUrl = null;
        ritaKoppling();
        toast('Nyckeln återkallad', 'success');
        await ritaStatus();
      });
    });
  };

  const visaNyckel = (nyckel) => {
    const url = `${bas}/mcp/${cid}/${nyckel}`;
    visadUrl = url;
    ritaKoppling();
    nyckelHost.innerHTML = `
      <div class="no-cookies" style="border-left-color: var(--rover-yellow);">
        <strong>Kopiera nu — nyckeln visas bara den här gången.</strong>
        Vi sparar bara ett avtryck av den, aldrig nyckeln själv, så vi kan inte visa den igen.
        Hela adressen är lösenordet: mejla den inte, och lägg den inte i en chattgrupp.
      </div>
      <label class="field">Inkopplingsadress</label>
      <input class="input" id="mcp-url" readonly value="${escapeHtml(url)}"
             style="font-family:var(--font-mono);font-size:12px;">
      <div class="btn-row" style="margin-top:var(--sp-3);">
        <button class="btn btn-primary" id="mcp-kopiera">Kopiera adressen</button>
        <button class="btn btn-secondary" id="mcp-klar">Jag har sparat den</button>
      </div>
      <p class="muted t-sm">Anvisningen för ditt verktyg står i rutan nedan — den är redan
      ifylld med adressen så länge den här sidan är öppen.</p>
    `;
    nyckelHost.querySelector('#mcp-kopiera').addEventListener('click', async () => {
      await copyToClipboard(url);
      toast('Adressen kopierad', 'success');
    });
    nyckelHost.querySelector('#mcp-klar').addEventListener('click', () => ritaStatus());
    nyckelHost.querySelector('#mcp-url').select?.();
  };

  // --- Så kopplar du in: en anvisning per klient ---------------------------
  const VAL_NYCKEL = 'eskil-mcp-klient';
  let valdKlient = hittaKlient(localStorage.getItem(VAL_NYCKEL)).id;

  const kopplingsKort = document.createElement('section');
  kopplingsKort.className = 'card';
  const sorter = [...new Set(MCP_KLIENTER.map(k => k.sort))];
  kopplingsKort.innerHTML = `
    <h3 class="t-h3" style="margin-top:0;">Så kopplar du in</h3>
    <p class="muted t-sm" style="margin-top:-6px;">Adressen är densamma överallt — det är bara
    stället man klistrar in den som skiljer.</p>
    <label class="field" for="mcp-klient">Vilket verktyg använder du?</label>
    <select class="input" id="mcp-klient">
      ${sorter.map(sort => `
        <option disabled>── ${escapeHtml(sort)} ──</option>
        ${MCP_KLIENTER.filter(k => k.sort === sort).map(k =>
          `<option value="${escapeHtml(k.id)}">${escapeHtml(k.namn)}</option>`).join('')}
      `).join('')}
    </select>
    <div id="mcp-anvisning" style="margin-top:var(--sp-5);"></div>
  `;
  host.appendChild(kopplingsKort);

  const anvisningHost = kopplingsKort.querySelector('#mcp-anvisning');
  const valjaren = kopplingsKort.querySelector('#mcp-klient');

  const ritaKoppling = () => {
    valjaren.value = valdKlient;
    const url = visadUrl || `${bas}/mcp/${cid}/${NYCKEL_PLATS}`;
    const k = medAdress(hittaKlient(valdKlient), url);
    anvisningHost.innerHTML = `
      <p class="muted t-sm">${escapeHtml(k.ingress)}</p>
      <ol style="padding-left:1.2em;margin:var(--sp-3) 0;">
        ${k.steg.map(steg => `<li style="margin-bottom:6px;">${escapeHtml(steg)}</li>`).join('')}
      </ol>
      ${k.fil ? `<p class="t-sm" style="margin:0 0 6px;"><strong>Filen ligger här:</strong>
                 <code>${escapeHtml(k.fil)}</code></p>` : ''}
      <label class="field">${escapeHtml(k.kopiera.etikett)}</label>
      <pre class="kodruta">${escapeHtml(k.kopiera.text)}</pre>
      <div class="btn-row" style="margin-top:var(--sp-3);">
        <button class="btn btn-primary" id="mcp-kopiera-anvisning">Kopiera</button>
      </div>
      ${visadUrl ? '' : `<p class="muted t-sm">Adressen ovan har <code>${NYCKEL_PLATS}</code> där
        nyckeln ska stå — den visas bara när den skapas. Byt ut ordet mot nyckeln du sparade,
        eller skapa en ny ovan så fylls anvisningen i åt dig.</p>`}
      ${k.varning ? `<div class="no-cookies" style="border-left-color: var(--rover-yellow);">
        ${escapeHtml(k.varning)}</div>` : ''}
      <p class="t-sm" style="margin-bottom:0;">
        <a href="${escapeHtml(k.lank.href)}" target="_blank" rel="noopener">${escapeHtml(k.lank.text)}</a>
      </p>
    `;
    anvisningHost.querySelector('#mcp-kopiera-anvisning').addEventListener('click', async () => {
      await copyToClipboard(k.kopiera.text);
      toast(visadUrl ? 'Kopierat' : `Kopierat — byt ut ${NYCKEL_PLATS} mot din nyckel`, 'success');
    });
  };

  valjaren.addEventListener('change', () => {
    valdKlient = valjaren.value;
    try { localStorage.setItem(VAL_NYCKEL, valdKlient); } catch { /* privat läge */ }
    ritaKoppling();
  });
  ritaKoppling();

  ritaStatus();

  // --- Färdiga prompter ---
  const namn = comp.name || 'tävlingen';
  const PROMPTER = [
    { rubrik: 'Kom igång',
      text: `Du är kopplad till ${namn} i ESKIL. Börja med att läsa tävlingens inställningar och `
        + `lista kontrollerna och patrullerna, och sammanfatta för mig vad som är ifyllt och vad `
        + `som saknas inför tävlingsdagen.` },
    { rubrik: 'Lägg ut en bana',
      text: `Skapa kontroller ${'\u2116'}1–10 för ${namn}. Jag ger dig koordinaterna en och en. `
        + `Sätt maxpoäng 25 på varje och lämna dem stängda tills vidare. Bekräfta med en lista `
        + `när du är klar.` },
    { rubrik: 'Skriv kontrollernas uppgifter',
      text: `Skriv instruktionerna till kontrollerna i ${namn} — alltså uppgiften kontrollanten `
        + `läser upp. Jag dikterar en kontroll i taget. Om uppgiften ska skilja sig mellan `
        + `avdelningar säger jag det, annars gäller samma text för alla. Läs tillbaka texten `
        + `när du skrivit den.` },
    { rubrik: 'Sätt start och mål',
      text: `Sätt banans start- och målplats för ${namn}. Jag ger dig koordinater, namn på platsen `
        + `och en anvisning om hur man hittar dit. Säg till om start och mål ska ligga på samma `
        + `plats eller på olika. Anvisningen kan du skriva men inte läsa tillbaka — säg till mig `
        + `att kontrollera den i ESKIL efteråt.` },
    { rubrik: 'Lägg in patrullerna',
      text: `Lägg in de här patrullerna i ${namn}. Format: namn, kår, avdelning. Sätt startordning `
        + `i den ordning jag skriver dem. Läs tillbaka listan när du är klar så jag kan kontrollera `
        + `stavningen.` },
    { rubrik: 'Sätt upp tävlingsledningen',
      text: `Sätt tävlingsledningen för ${namn}. Jag dikterar roller och kontaktuppgifter. Kom ihåg `
        + `att du inte kan läsa tillbaka uppgifterna efteråt — skriv därför hela uppsättningen på `
        + `en gång, och säg till mig att kontrollera dem i ESKIL när du är klar.` },
    { rubrik: 'Kontrollera inför tävlingsdagen',
      text: `Gå igenom ${namn} och säg vad som ser ofullständigt ut: kontroller utan koordinater `
        + `eller poäng, patruller utan kår eller startordning, inställningar som verkar `
        + `motsägelsefulla. Föreslå åtgärder men gör ingenting utan att fråga först.` }
  ];

  const promptKort = document.createElement('section');
  promptKort.className = 'card';
  promptKort.innerHTML = `
    <h3 class="t-h3" style="margin-top:0;">Färdiga prompter</h3>
    <p class="muted t-sm" style="margin-top:-6px;">Klistra in i din assistent och ändra fritt.</p>
    ${PROMPTER.map((p, i) => `
      <div style="margin-bottom:var(--sp-5);">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:var(--sp-3);">
          <strong>${escapeHtml(p.rubrik)}</strong>
          <button class="btn btn-secondary btn-sm" data-prompt="${i}">Kopiera</button>
        </div>
        <p class="muted t-sm" style="margin:6px 0 0;">${escapeHtml(p.text)}</p>
      </div>`).join('')}
  `;
  promptKort.querySelectorAll('[data-prompt]').forEach(b => {
    b.addEventListener('click', async () => {
      await copyToClipboard(PROMPTER[Number(b.dataset.prompt)].text);
      toast('Prompten kopierad', 'success');
    });
  });
  host.appendChild(promptKort);

  if (readOnly) host.setAttribute('inert', '');
  return host;
}
