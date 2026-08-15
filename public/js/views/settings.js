// Global settings page — now a concise dashboard linking to each competition's
// own settings page. Per-competition admin/user management has moved into
// /app/c/:cid/settings under the "Användare" tab.

import { layout } from '../app.js';
import { listCompetitionsForUser } from '../store.js';
import { escapeHtml, isCompAdminUser, toast, withBusy, wireOverlayClose } from '../utils.js';
import { icon } from '../icons.js';
import { crumbs, setDocTitle } from '../nav.js';

export async function renderSettings(app, user) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="muted">Laddar…</div>`;
  layout(wrap, { narrow: true });

  // Don't mask load failures as "you have no competitions" — that reads as
  // data loss to an admin. Surface the error instead.
  let comps = [];
  let loadError = null;
  try { comps = await listCompetitionsForUser(user); }
  catch (e) { console.error(e); loadError = e; }
  const mine = comps.filter(c =>
    isCompAdminUser(c, user)
  );
  if (loadError) {
    wrap.innerHTML = `<div class="empty"><h3>Kunde inte ladda</h3><p>${escapeHtml(loadError.message)} — ladda om sidan för att försöka igen.</p></div>`;
    return;
  }

  setDocTitle('Konto');
  wrap.innerHTML = `
    <div class="page-head">
      <div>
        ${crumbs([{ label: 'Tävlingar', href: '/app' }, { label: 'Konto' }])}
        <h1 class="t-d2">Ditt konto</h1>
      </div>
    </div>

    <div class="card">
      <h3 class="t-h3" style="margin-top:0;">Konto</h3>
      <p class="muted t-sm">${escapeHtml(user.email)} — roll: <strong>${escapeHtml(user.role || 'användare')}</strong></p>
    </div>

    ${user.role === 'super-admin' ? `
      <h2 class="t-h2 mt-6">Super-admin</h2>
      <div class="grid" style="gap:var(--sp-3);">
        <a class="card" style="text-decoration:none;color:inherit;display:flex;align-items:center;justify-content:space-between;gap:var(--sp-4);" href="/app/admin/system" data-link>
          <div>
            <div class="t-over" style="color:var(--avent-orange);">Systemhubb</div>
            <h3 class="t-h4" style="margin:4px 0 0;color:var(--scout-blue);">Dashboards & inställningar</h3>
            <p class="muted t-sm" style="margin:4px 0 0;">Länkar till Firebase, Google Cloud, Brevo m.m., var allt administreras, och mail-kvoter.</p>
          </div>
          <span class="muted t-sm">Öppna ${icon('arrow-right', { size: 14 })}</span>
        </a>
        <a class="card" style="text-decoration:none;color:inherit;display:flex;align-items:center;justify-content:space-between;gap:var(--sp-4);" href="/app/admin/users" data-link>
          <div>
            <div class="t-over" style="color:var(--avent-orange);">Användarhantering</div>
            <h3 class="t-h4" style="margin:4px 0 0;color:var(--scout-blue);">Alla användare</h3>
            <p class="muted t-sm" style="margin:4px 0 0;">Se vem som loggat in, ändra roller, ta bort konton.</p>
          </div>
          <span class="muted t-sm">Öppna ${icon('arrow-right', { size: 14 })}</span>
        </a>
        <a class="card" style="text-decoration:none;color:inherit;display:flex;align-items:center;justify-content:space-between;gap:var(--sp-4);" href="/app/admin/feedback" data-link>
          <div>
            <div class="t-over" style="color:var(--upp-blue);">Meddelanden till ESKIL</div>
            <h3 class="t-h4" style="margin:4px 0 0;color:var(--scout-blue);">Läs och svara <span id="fb-badge"></span></h3>
            <p class="muted t-sm" style="margin:4px 0 0;">Det som skickas via kontaktformuläret. Svaret går ut från ESKIL, inte från din egen adress.</p>
          </div>
          <span class="muted t-sm">Öppna ${icon('arrow-right', { size: 14 })}</span>
        </a>
        <a class="card" style="text-decoration:none;color:inherit;display:flex;align-items:center;justify-content:space-between;gap:var(--sp-4);" href="/app/admin/requests" data-link>
          <div>
            <div class="t-over" style="color:var(--avent-orange);">Tävlingsförfrågningar</div>
            <h3 class="t-h4" style="margin:4px 0 0;color:var(--scout-blue);">Godkänn nya tävlingar <span id="req-badge"></span></h3>
            <p class="muted t-sm" style="margin:4px 0 0;">Användare skapar inte tävlingar själva — de begär, du godkänner eller nekar.</p>
          </div>
          <span class="muted t-sm">Öppna ${icon('arrow-right', { size: 14 })}</span>
        </a>
      </div>
    ` : ''}

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

    <section class="card mt-6" style="border-color:var(--utm-pink);">
      <h3 class="t-h3" style="margin-top:0;color:var(--utm-pink);">Radera mitt konto</h3>
      <p class="muted">Tar bort ditt konto och dina personuppgifter ur ESKIL: inloggningen, din
      e-postadress i tävlingarnas behörighetslistor, som kontrollansvarig och i tävlingsledningens
      kontaktuppgifter. Du får se exakt vad som påverkas innan något raderas. Åtgärden kan inte ångras.</p>
      <button class="btn btn-danger mt-4" id="delete-account">${icon('trash', { size: 16 })} Radera mitt konto…</button>
    </section>
  `;

  wrap.querySelector('#delete-account').addEventListener('click', (e) =>
    withBusy(e.currentTarget, 'Hämtar…', async () => {
      try {
        const { functions, httpsCallable } = await import('../firebase.js');
        const res = await httpsCallable(functions, 'deleteMyAccount')({});
        openDeleteAccountModal(res.data);
      } catch (err) {
        toast(err?.code === 'functions/failed-precondition'
          ? err.message
          : 'Kunde inte läsa kontots uppgifter just nu — försök igen om en stund.', 'error');
      }
    }));

  // Antal väntande tävlingsförfrågningar — så super-adminen ser att något
  // ligger och väntar utan att öppna sidan.
  if (user.role === 'super-admin') {
    import('../store.js').then(({ listCompetitionRequests }) => listCompetitionRequests())
      .then(reqs => {
        const n = reqs.filter(r => r.status === 'vantar').length;
        const badge = wrap.querySelector('#req-badge');
        if (badge && n) badge.outerHTML = `<span class="badge badge-orange">${n} väntar</span>`;
      })
      .catch(() => { /* badgen är en bonus */ });

    // Samma sak för olästa meddelanden till ESKIL.
    import('../store.js').then(({ listNewFeedback }) => listNewFeedback())
      .then(n => {
        const badge = wrap.querySelector('#fb-badge');
        if (badge && n) badge.outerHTML = `<span class="badge badge-green">${n} ny${n === 1 ? 'tt' : 'a'}</span>`;
      })
      .catch(() => { /* badgen är en bonus */ });
  }
}

// Raderingsmodalen. Innehållet kommer från serverns dry run — det är samma
// kod som sedan utför städningen, så listan ljuger aldrig om vad som händer.
function openDeleteAccountModal(fp) {
  const comps = fp.competitions || [];
  const sole = comps.filter(c => c.soleAdmin);
  const shared = comps.filter(c => c.role === 'admin' && !c.soleAdmin);
  const other = comps.filter(c => c.role !== 'admin');
  const ROLE = { admin: 'administratör', ekonomi: 'ekonomiansvarig', las: 'läsbehörig' };
  const label = (c) => escapeHtml(c.shortName || c.name || c.id);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:640px;">
      <div class="modal-head"><h3>Radera kontot ${escapeHtml(fp.email || '')}</h3></div>
      <div class="modal-body">
        ${!comps.length && !fp.requestCount ? `
          <p style="margin-top:0;">Kontot är inte kopplat till någon tävling. Det raderas direkt
          tillsammans med din inloggning — inget annat påverkas.</p>
        ` : `
          <p style="margin-top:0;">Så här ser kontots spår i ESKIL ut. Allt nedan tas bort när du raderar.</p>
        `}

        ${sole.length ? `
          <div style="border:1.5px solid var(--utm-pink);border-radius:10px;padding:12px 14px;margin-bottom:var(--sp-3);">
            <strong style="color:var(--utm-pink);">Du är ensam administratör här</strong>
            <p class="muted t-sm" style="margin:4px 0 10px;">Ange någon som tar över, annars blir tävlingen
            omöjlig att administrera. Personen behöver inte ha loggat in i ESKIL tidigare.</p>
            ${sole.map(c => `
              <div class="mt-2">
                <label class="field" for="repl-${escapeHtml(c.id)}">${escapeHtml(c.name || c.id)}</label>
                <input class="input" id="repl-${escapeHtml(c.id)}" type="email" placeholder="ny.admin@exempel.se" data-repl="${escapeHtml(c.id)}">
              </div>`).join('')}
          </div>` : ''}

        ${shared.length ? `
          <p class="t-sm" style="margin:0 0 8px;"><strong>Du förlorar administratörsrollen</strong> på
          ${shared.map(c => `<span class="badge badge-blue">${label(c)}</span>`).join(' ')} —
          tävlingarna lever vidare med sina övriga administratörer.</p>` : ''}

        ${other.length ? `
          <p class="t-sm" style="margin:0 0 8px;">Du tas bort som
          ${other.map(c => `<span class="badge badge-gray">${label(c)} · ${ROLE[c.role] || 'medlem'}</span>`).join(' ')}.</p>` : ''}

        ${comps.some(c => c.controls?.length) ? `
          <p class="t-sm" style="margin:0 0 8px;"><strong>Kontrollansvar som tas bort:</strong>
          ${comps.flatMap(c => (c.controls || []).map(ct =>
            `<span class="badge badge-gray">${label(c)} · kontroll ${ct.nummer ?? '?'}</span>`)).join(' ')}
          — kontrollerna finns kvar, men utan dig som ansvarig.</p>` : ''}

        ${comps.some(c => c.inManagement) ? `
          <p class="t-sm" style="margin:0 0 8px;">Dina kontaktuppgifter i tävlingsledningen rensas på
          ${comps.filter(c => c.inManagement).map(c => `<span class="badge badge-gray">${label(c)}</span>`).join(' ')}
          (rollen finns kvar, men utan namn, telefon och e-post).</p>` : ''}

        ${fp.requestCount ? `<p class="t-sm" style="margin:0 0 8px;">${fp.requestCount} tävlingsförfrågan/-förfrågningar från dig tas bort.</p>` : ''}

        <p class="t-sm muted" style="margin:12px 0 0;">Patruller, poäng, anmälningar och resultat i
        tävlingarna påverkas inte — de tillhör respektive tävling.</p>

        <div class="mt-4" style="border-top:1px solid var(--border);padding-top:var(--sp-3);">
          <label class="field" for="del-confirm">Skriv <strong>RADERA</strong> för att bekräfta</label>
          <input class="input" id="del-confirm" autocomplete="off" placeholder="RADERA" style="max-width:200px;">
          <p class="t-sm" id="del-error" style="color:var(--utm-pink);display:none;margin:8px 0 0;"></p>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="del-cancel">Avbryt</button>
        <button class="btn btn-danger" id="del-go">Radera kontot permanent</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  wireOverlayClose(overlay, close);
  overlay.querySelector('#del-cancel').addEventListener('click', close);

  const err = overlay.querySelector('#del-error');
  const fail = (msg) => { err.textContent = msg; err.style.display = 'block'; };

  overlay.querySelector('#del-go').addEventListener('click', (e) => withBusy(e.currentTarget, 'Raderar…', async () => {
    err.style.display = 'none';
    if (overlay.querySelector('#del-confirm').value.trim().toUpperCase() !== 'RADERA') {
      fail('Skriv RADERA i rutan för att bekräfta.');
      return;
    }
    const replacements = {};
    for (const inp of overlay.querySelectorAll('[data-repl]')) {
      const v = inp.value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
        fail('Ange en giltig e-postadress för varje tävling där du är ensam administratör.');
        inp.focus();
        return;
      }
      replacements[inp.dataset.repl] = v;
    }
    try {
      const { functions, httpsCallable, auth, signOut } = await import('../firebase.js');
      await httpsCallable(functions, 'deleteMyAccount')({ confirm: true, replacements });
      close();
      await signOut(auth);
      location.href = '/?raderat=1';
    } catch (e2) {
      fail(e2?.code === 'functions/failed-precondition'
        ? e2.message
        : 'Kunde inte radera kontot just nu — försök igen om en stund.');
    }
  }));
}
