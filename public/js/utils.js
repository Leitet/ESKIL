// Small helpers used across the app.

export const AVDELNINGAR = [
  { key: 'Spårare',    short: 'sp', range: '8–10 år',    color: 'var(--spaer-green)'  },
  { key: 'Upptäckare', short: 'up', range: '10–12 år',   color: 'var(--upp-blue)'      },
  { key: 'Äventyrare', short: 'av', range: '12–15 år',   color: 'var(--avent-orange)' },
  { key: 'Utmanare',   short: 'ut', range: '15–18 år',   color: 'var(--utm-pink)'      },
  { key: 'Rover',      short: 'ro', range: '19–25 år',   color: 'var(--rover-yellow)' },
  { key: 'Ledare',     short: 'le', range: '18+',         color: 'var(--black)'         }
];

// --- Permissions --------------------------------------------------------------
// Email-based (people can be invited before their first sign-in); legacy
// uid-based admins are still honored. Mirrors the helpers in firestore.rules.

export function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

export function isCompAdminUser(comp, user) {
  if (!user) return false;
  if (user.role === 'super-admin') return true;
  return (comp?.admins || []).includes(user.uid)
    || (comp?.adminEmails || []).includes(normEmail(user.email));
}

export function isCompMemberUser(comp, user) {
  if (isCompAdminUser(comp, user)) return true;
  return (comp?.userEmails || []).includes(normEmail(user?.email));
}

// May this user edit the given control? Admins always; kontrollansvariga on
// their own control while the competition isn't closed.
export function canEditControl(comp, control, user) {
  if (isCompAdminUser(comp, user)) return true;
  if (comp?.closed) return false;
  return (control?.ansvarigaEmails || []).includes(normEmail(user?.email));
}

// Which avdelningar participate in a competition. Stored as an array of keys
// in comp.avdelningar; a missing/empty value means all (backward compatible).
// Returns entries from AVDELNINGAR so callers get key/short/range/color.
export function allowedAvdelningar(comp) {
  const keys = Array.isArray(comp?.avdelningar) ? comp.avdelningar : null;
  if (!keys || !keys.length) return AVDELNINGAR;
  const filtered = AVDELNINGAR.filter(a => keys.includes(a.key));
  return filtered.length ? filtered : AVDELNINGAR;
}

// Default role presets for new competitions.
export const DEFAULT_MANAGEMENT_ROLES = [
  { id: 'leader',        label: 'Tävlingsledare',          visibility: 'public'   },
  { id: 'registrations', label: 'Anmälningar',             visibility: 'public'   },
  { id: 'economy',       label: 'Ekonomiansvarig / Kassör', visibility: 'public', ekonomi: true },
  { id: 'secretariat',   label: 'Sekretariat',             visibility: 'internal' }
];

function randId() {
  return 'r-' + Math.random().toString(36).slice(2, 10);
}

// Normalize management into a canonical array — handles legacy object-form
// from before we introduced visibility + custom roles.
export function normalizeManagement(comp, { seedDefaults = false } = {}) {
  const raw = comp?.management;
  if (Array.isArray(raw)) {
    return raw.map(r => ({
      id: r.id || randId(),
      label: r.label || '',
      visibility: r.visibility === 'internal' ? 'internal' : 'public',
      ekonomi: r.ekonomi === true,
      name: r.name || '',
      phone: r.phone || '',
      email: r.email || ''
    }));
  }
  if (raw && typeof raw === 'object') {
    // Legacy: { leader: {...}, registrations: {...}, secretariat: {...} }
    return DEFAULT_MANAGEMENT_ROLES.map(d => ({
      id: d.id,
      label: d.label,
      visibility: d.visibility,
      ekonomi: d.ekonomi === true,
      name: raw[d.id]?.name  || '',
      phone: raw[d.id]?.phone || '',
      email: raw[d.id]?.email || ''
    }));
  }
  return seedDefaults
    ? DEFAULT_MANAGEMENT_ROLES.map(d => ({
        id: d.id, label: d.label, visibility: d.visibility,
        ekonomi: d.ekonomi === true,
        name: '', phone: '', email: ''
      }))
    : [];
}

// Roles flagged as ekonomiansvarig (with an email) → the {email, name} list
// whose flat email mirror the rules check payment-write access against.
export function ekonomiFromManagement(management) {
  return (management || [])
    .filter(r => r.ekonomi === true && normEmail(r.email))
    .map(r => ({ email: normEmail(r.email), name: (r.name || '').trim() }));
}

// Signed-in user is ekonomiansvarig for this competition. `ekonomiEmails` is
// merged into comp from the member-only private/access subdoc by
// store.getCompetition, so this works for any signed-in member.
export function isEkonomiUser(comp, user) {
  if (!user) return false;
  return (comp?.ekonomiEmails || []).includes(normEmail(user.email));
}

// Any role with actual contact info filled in.
export function activeManagement(comp) {
  return normalizeManagement(comp)
    .filter(r => (r.name || '').trim() || (r.email || '').trim() || (r.phone || '').trim());
}

// Roles visible on startkort + publika sidan.
export function publicManagement(comp) {
  return activeManagement(comp).filter(r => (r.visibility || 'public') === 'public');
}

// Roles visible on the control report card (reporter page). Shows everything
// active — internal roles are exclusive to this surface, public roles also
// show here for completeness so control runners reach any contact.
//
// `internPii` är de interna rollernas kontaktuppgifter, hämtade från den
// skyddade platsen (se splitManagement nedan). Utan dem visar sidan bara de
// publika rollerna — vilket är exakt vad en fältlänk utan token ska få.
export function internalManagement(comp, internPii) {
  return activeManagement({ ...comp, management: mergeManagement(comp, internPii) });
}

// ---------------------------------------------------------------------------
// Uppdelningen av tävlingsledningen.
//
// VARFÖR: comp.management låg PÅ tävlingsdokumentet, som har
// `allow read: if true`. Kryssrutan "intern" filtrerade bara i UI:t
// (publicManagement ovan), så varje besökare på /t fick sekretariatets och
// banläggarens namn och telefonnummer i svaret — mätt i produktion. Produkten
// lovar med den kryssrutan att uppgiften inte blir publik, och det löftet höll
// inte.
//
// PUBLIKA rollers uppgifter STANNAR på tävlingsdokumentet: de SKA vara
// publika, /t visar dem med flit. Bara de INTERNA rollernas name/phone/email
// flyttas. Det gör att /t, /s och /a inte behöver ändras alls.
//
// Skiljelinjen är inte ny: closeCompetition (store.js) behåller redan exakt
// id, label, visibility och ekonomi och nollar name, phone och email vid
// GDPR-gallringen. Samma fyra fält, samma gräns.
// ---------------------------------------------------------------------------

const MGMT_STRUKTUR = ['id', 'label', 'visibility', 'ekonomi'];
const MGMT_PII = ['name', 'phone', 'email'];

/**
 * Delar en management-array i det som får ligga publikt och det som inte får.
 *
 * @returns { publikt, internPii }
 *   publikt   – hela rollstrukturen; PII kvar bara för publika roller.
 *   internPii – { [rollId]: {name, phone, email} } för de interna rollerna,
 *               och bara för dem som har något ifyllt.
 */
export function splitManagement(management) {
  const roller = Array.isArray(management) ? management : [];
  const publikt = [];
  const internPii = {};
  for (const r of roller) {
    const bas = {};
    for (const k of MGMT_STRUKTUR) bas[k] = k === 'ekonomi' ? (r.ekonomi === true) : (r[k] ?? '');
    bas.visibility = r.visibility === 'internal' ? 'internal' : 'public';
    if (bas.visibility === 'internal') {
      const pii = {};
      let nagot = false;
      for (const k of MGMT_PII) {
        const v = (r[k] || '').trim();
        pii[k] = v;
        if (v) nagot = true;
      }
      if (nagot && bas.id) internPii[bas.id] = pii;
      // PII:n läggs medvetet INTE på bas — det är hela poängen.
    } else {
      for (const k of MGMT_PII) bas[k] = r[k] || '';
    }
    publikt.push(bas);
  }
  return { publikt, internPii };
}

/**
 * Sätter ihop igen. Används av ytor som FÅR se allt: rapportsidan (via sin
 * token), inställningarna och utskriftscentralen (inloggade).
 *
 * Saknas internPii returneras den publika halvan orörd — då visar ytan bara
 * de publika rollerna, i stället för att visa tomma rader för de interna.
 */
export function mergeManagement(comp, internPii) {
  const roller = normalizeManagement(comp);
  if (!internPii || typeof internPii !== 'object') return roller;
  return roller.map(r => {
    const pii = internPii[r.id];
    return pii ? { ...r, name: pii.name || '', phone: pii.phone || '', email: pii.email || '' } : r;
  });
}

export function avdShort(avd) {
  const a = AVDELNINGAR.find(x => x.key === avd);
  return a ? a.short : 'le';
}

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Escapar text OCH gör http(s)-länkar klickbara. Finns för nödropet från
// patrullens startkort: det bär en kartlänk till positionen, och i ledningens
// inkorg stod den som blå-lös text man fick markera och klistra in för hand
// — precis när minuterna räknas. Escapningen görs styckvis så att en URL med
// & inte förvanskas, och regexen tar bara http/https (aldrig javascript:).
const URL_RE = /https?:\/\/[^\s<>"']+/g;
export function linkifyText(s) {
  if (s == null) return '';
  const text = String(s);
  let ut = '', sist = 0;
  for (const m of text.matchAll(URL_RE)) {
    ut += escapeHtml(text.slice(sist, m.index));
    const url = m[0].replace(/[.,;:)]+$/, '');       // skiljetecken hör till meningen
    const svans = m[0].slice(url.length);
    ut += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
       + escapeHtml(svans);
    sist = m.index + m[0].length;
  }
  return ut + escapeHtml(text.slice(sist));
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    }
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function toast(msg, kind = '') {
  // Wrapen är det som gör toasten fixed och centrerad. Sidor som saknade den
  // (t.html, a.html) fick i stället ett statiskt block sist i dokumentet —
  // på en lång anmälningssida långt utanför skärmen. Skapa den hellre än att
  // lita på att varje ny sida minns att lägga in den.
  let wrap = document.getElementById('toasts');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    wrap.id = 'toasts';
    document.body.appendChild(wrap);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; }, 2600);
  setTimeout(() => t.remove(), 3000);
}

// Close a modal/sheet when the user taps the dimmed backdrop — but ONLY when
// the gesture both starts and ends on the backdrop, without moving. A plain
// click handler fires on the overlay whenever a drag/scroll starts inside the
// dialog and the pointer is released outside it (the click event targets the
// common ancestor of down+up), which closed modals mid-edit and lost data.
export function wireOverlayClose(overlay, close) {
  let down = null;
  overlay.addEventListener('pointerdown', (e) => {
    down = e.target === overlay ? { x: e.clientX, y: e.clientY } : null;
  });
  overlay.addEventListener('pointerup', (e) => {
    const moved = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12;
    if (down && !moved && e.target === overlay) close();
    down = null;
  });
}

export function confirmDialog(message, { okLabel = 'Ta bort', danger = true } = {}) {
  return new Promise(resolve => {
    const overlay = el('div', { class: 'modal-overlay' });
    const modal = el('div', { class: 'modal' });
    modal.innerHTML = `
      <div class="modal-head"><h3>Bekräfta</h3></div>
      <div class="modal-body is-text">${escapeHtml(message)}</div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-cancel>Avbryt</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${escapeHtml(okLabel)}</button>
      </div>`;
    overlay.appendChild(modal);
    wireOverlayClose(overlay, () => { overlay.remove(); resolve(false); });
    modal.querySelector('[data-cancel]').onclick = () => { overlay.remove(); resolve(false); };
    modal.querySelector('[data-ok]').onclick = () => { overlay.remove(); resolve(true); };
    document.body.appendChild(overlay);
  });
}

// Hård radering av något med poäng i sig (tävling, kontroll) går genom den
// här grinden: en FÄRSK backup måste laddas ner och namnet skrivas in innan
// knappen ens tänds. Ett felklick i farliga zonen mitt under tävlingsdagen
// raderade annars data utan kopia och utan spår — och "är du säker?" har
// aldrig stoppat en stressad tumme. Backupen är obligatorisk med flit: den
// är enda vägen tillbaka när raderingen ändå var fel.
export function confirmHardDelete({ what, name, hint = '', onBackup }) {
  return new Promise(resolve => {
    const overlay = el('div', { class: 'modal-overlay' });
    const modal = el('div', { class: 'modal' });
    modal.innerHTML = `
      <div class="modal-head"><h3 style="color:var(--utm-pink);">Ta bort ${escapeHtml(what)}</h3></div>
      <div class="modal-body field-group">
        <p style="margin:0;">Det här går inte att ångra.${hint ? ' ' + escapeHtml(hint) : ''}</p>
        <div class="hd-step">
          <div class="hd-step-head"><span class="hd-num">1</span> Ladda ner en färsk backup</div>
          <p class="muted t-sm" style="margin:2px 0 8px;">Backupen är enda vägen tillbaka om det här visar sig vara fel. Den går att återskapa från under Inställningar → Backup.</p>
          <button type="button" class="btn btn-secondary btn-sm" data-backup>Ladda ner backup</button>
          <span class="t-sm" data-backup-status style="margin-left:8px;"></span>
        </div>
        <div class="hd-step">
          <div class="hd-step-head"><span class="hd-num">2</span> Skriv namnet för att bekräfta</div>
          <input class="input mono" data-name autocomplete="off" spellcheck="false"
            placeholder="${escapeHtml(name)}">
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-cancel>Avbryt</button>
        <button class="btn btn-danger" data-ok disabled>Ta bort permanent</button>
      </div>`;
    overlay.appendChild(modal);

    let backupKlar = false;
    const ok = modal.querySelector('[data-ok]');
    const inp = modal.querySelector('[data-name]');
    const uppdatera = () => {
      ok.disabled = !(backupKlar && inp.value.trim() === String(name).trim());
    };
    inp.addEventListener('input', uppdatera);

    modal.querySelector('[data-backup]').addEventListener('click', async (e) => {
      const b = e.currentTarget, st = modal.querySelector('[data-backup-status]');
      b.disabled = true; st.textContent = 'Skapar…'; st.style.color = '';
      try {
        await onBackup();
        backupKlar = true;
        st.textContent = 'Nedladdad ✓'; st.style.color = 'var(--spaer-green)';
      } catch (err) {
        st.textContent = 'Misslyckades: ' + (err?.message || err); st.style.color = 'var(--utm-pink)';
        b.disabled = false;
      }
      uppdatera();
    });

    wireOverlayClose(overlay, () => { overlay.remove(); resolve(false); });
    modal.querySelector('[data-cancel]').onclick = () => { overlay.remove(); resolve(false); };
    ok.onclick = () => { overlay.remove(); resolve(true); };
    document.body.appendChild(overlay);
    setTimeout(() => inp.focus(), 40);
  });
}

// Like confirmDialog but with a text input. Resolves the entered string on
// OK (possibly ''), or null on cancel — callers must check for null.
export function promptDialog(message, { okLabel = 'Spara', placeholder = '', value = '', danger = false } = {}) {
  return new Promise(resolve => {
    const overlay = el('div', { class: 'modal-overlay' });
    const modal = el('div', { class: 'modal' });
    modal.innerHTML = `
      <div class="modal-head"><h3>Bekräfta</h3></div>
      <div class="modal-body">
        <p style="margin-top:0;">${escapeHtml(message)}</p>
        <input class="input" data-input placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}">
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-cancel>Avbryt</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${escapeHtml(okLabel)}</button>
      </div>`;
    overlay.appendChild(modal);
    const input = modal.querySelector('[data-input]');
    wireOverlayClose(overlay, () => { overlay.remove(); resolve(null); });
    modal.querySelector('[data-cancel]').onclick = () => { overlay.remove(); resolve(null); };
    modal.querySelector('[data-ok]').onclick = () => { const v = input.value.trim(); overlay.remove(); resolve(v); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') modal.querySelector('[data-ok]').click(); });
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 30);
  });
}

export function formatDate(ts) {
  if (!ts) return '—';
  const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('sv-SE', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatTime(ts) {
  if (!ts) return '—';
  const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch {}
  ta.remove();
  return Promise.resolve();
}

// Fältlänkarna. Den frivilliga fjärde delen är samtalstoken: den som har den
// kan LÄSA tråden mellan fältet och ledningen. Utan token fungerar länken i
// övrigt precis som förr — poäng rapporteras, nödrop går fram — men svaren
// syns inte. Se `harledd()` i firestore.rules för varför.
//
// Token läggs i sökvägen, inte i frågesträngen: en frågesträng tappas oftare
// vid klipp-och-klistra, och hamnar i Referer när sidan hämtar något externt.
export function reportUrl(competitionId, controlId, token) {
  return `${location.origin}/k/${competitionId}/${controlId}`
    + (token ? `/${encodeURIComponent(token)}` : '');
}

export function startUrl(competitionId, patrolId, token) {
  return `${location.origin}/s/${competitionId}/${patrolId}`
    + (token ? `/${encodeURIComponent(token)}` : '');
}

/**
 * Delar upp en fältsidas sökväg. EN parser för /k och /s i stället för tre
 * handrullade kopior — det är den här som avgör om en länk bär token, och den
 * var det enda otestade steget i hela kedjan.
 *
 * Returnerar null när sökvägen inte hör till sidan. `id` är RÅTT segment: på
 * /s är det ofta kortadressen (slugen), aldrig ett upplöst tävlings-id.
 */
export function parseFieldPath(pathname, prefix) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (parts[0] !== prefix || !parts[1] || !parts[2]) return null;
  return { cid: parts[1], id: parts[2], token: parts[3] || null };
}

// --- Ranking rules (delad placering vid total tie) --------------------------
// 1. Totalpoäng (poang + extraPoang)
// 2. Högst ordningspoäng (summa extraPoang)
// 3. Flest kontroller där patrullen slog kontrollens maxpoäng
// Om alla tre är lika → delad placering.
export const RANKING_RULES_TEXT = [
  { title: 'Totalpoäng',                rule: 'Summan av kontrollpoäng och ordningspoäng.' },
  { title: 'Högst ordningspoäng',       rule: 'Vid lika totalpoäng jämförs extrapoängen.' },
  { title: 'Flest maxade kontroller',   rule: 'Vid lika ordningspoäng: den som tagit full maxpoäng på flest kontroller.' },
  { title: 'Utslagsfråga',              rule: 'Har tävlingen en utslagskontroll vinner den vars svar ligger närmast rätt svar (ett svar slår inget svar). Räknas först när tävlingsledningen angett rätt svar.' },
  { title: 'Delad placering',           rule: 'Går det inte att avgöra efter detta får de inblandade dela på platsen.' }
];

// Strict numeric check — Number(null) and Number('') are 0, so a missing
// facit/guess must never slip through as the number zero.
export const isNumSet = (v) => v != null && v !== '' && Number.isFinite(Number(v));

// Tiebreaker controls whose facit is set — only these participate in the
// ranking. Sorted by control number so the first utslagskontroll decides
// before the next.
export function utslagControls(controls) {
  return (controls || [])
    .filter(c => c.utslag && isNumSet(c.utslagSvar))
    .sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
}

// Rows for an utslagsfråga panel: every patrol's guess on one tiebreaker
// control sorted by closeness to the facit (patrols without a guess last).
// `perPatrolScore` maps patrolId → that control's score doc.
export function utslagRows(control, patrols, perPatrolScore) {
  const hasFacit = isNumSet(control.utslagSvar);
  const svar = hasFacit ? Number(control.utslagSvar) : null;
  return patrols.map(p => {
    const g = perPatrolScore[p.id]?.utslagGissning;
    const gissning = isNumSet(g) ? Number(g) : null;
    const diff = hasFacit && gissning != null ? Math.abs(gissning - svar) : null;
    return { patrol: p, gissning, diff };
  }).sort((a, b) => {
    if ((a.gissning == null) !== (b.gissning == null)) return a.gissning == null ? 1 : -1;
    if (a.diff != null && b.diff != null && a.diff !== b.diff) return a.diff - b.diff;
    return (a.patrol.number ?? 0) - (b.patrol.number ?? 0);
  });
}

// Rank an array of "total" rows. Each row must have: grand, extra, perControl
// (ctrlId → score doc). `controls` supplies each control's maxPoang and any
// utslagskontroller. Returns a new array with { ...row, rank, maxedCount,
// utslagDiffs } sorted by the rules in RANKING_RULES_TEXT.
export function rankPatrols(totals, controls) {
  const ctrlMax = Object.fromEntries(controls.map(c => [c.id, Number(c.maxPoang) || 0]));
  const utslag = utslagControls(controls);
  const enriched = totals.map(r => {
    let maxedCount = 0;
    for (const [ctrlId, s] of Object.entries(r.perControl || {})) {
      const max = ctrlMax[ctrlId];
      if (max > 0 && (Number(s.poang) || 0) >= max) maxedCount++;
    }
    // Distance from facit per utslagskontroll; no guess = Infinity, so a
    // patrol that answered always beats one that didn't.
    const utslagDiffs = utslag.map(c => {
      const g = r.perControl?.[c.id]?.utslagGissning;
      return isNumSet(g) ? Math.abs(Number(g) - Number(c.utslagSvar)) : Infinity;
    });
    return { ...r, maxedCount, utslagDiffs };
  });
  const sameDiffs = (a, b) =>
    (a.utslagDiffs || []).every((d, i) => d === (b.utslagDiffs || [])[i]);
  enriched.sort((a, b) => {
    if ((b.grand || 0) !== (a.grand || 0)) return (b.grand || 0) - (a.grand || 0);
    if ((b.extra || 0) !== (a.extra || 0)) return (b.extra || 0) - (a.extra || 0);
    if ((b.maxedCount || 0) !== (a.maxedCount || 0)) return (b.maxedCount || 0) - (a.maxedCount || 0);
    for (let i = 0; i < (a.utslagDiffs || []).length; i++) {
      if (a.utslagDiffs[i] !== b.utslagDiffs[i]) return a.utslagDiffs[i] < b.utslagDiffs[i] ? -1 : 1;
    }
    return 0;
  });
  // Standard competition ranking (1, 2, 2, 4): tied rows share rank.
  let prev = null, prevRank = 0;
  enriched.forEach((r, i) => {
    const tied = prev
      && (r.grand       || 0) === (prev.grand       || 0)
      && (r.extra       || 0) === (prev.extra       || 0)
      && (r.maxedCount  || 0) === (prev.maxedCount  || 0)
      && sameDiffs(r, prev);
    r.rank = tied ? prevRank : i + 1;
    if (!tied) prevRank = i + 1;
    prev = r;
  });
  return enriched;
}

// Same tiebreaker logic applied to kår-aggregated rows. Each row must carry
// `grand`, `extra`, and a pre-computed `maxedCount` (sum across the kår's
// patrols).
export function rankKarer(rows) {
  const arr = rows.slice().sort((a, b) => {
    if ((b.grand || 0) !== (a.grand || 0)) return (b.grand || 0) - (a.grand || 0);
    if ((b.extra || 0) !== (a.extra || 0)) return (b.extra || 0) - (a.extra || 0);
    if ((b.maxedCount || 0) !== (a.maxedCount || 0)) return (b.maxedCount || 0) - (a.maxedCount || 0);
    return 0;
  });
  let prev = null, prevRank = 0;
  arr.forEach((r, i) => {
    const tied = prev
      && (r.grand      || 0) === (prev.grand      || 0)
      && (r.extra      || 0) === (prev.extra      || 0)
      && (r.maxedCount || 0) === (prev.maxedCount || 0);
    r.rank = tied ? prevRank : i + 1;
    if (!tied) prevRank = i + 1;
    prev = r;
  });
  return arr;
}

// Resolve starttime settings on a competition. Shape:
//   competitions/{cid}.startTimes = {
//     enabled, mode: 'interval' | 'range',
//     firstStart: "HH:MM",
//     intervalMinutes: number,   // used when mode='interval'
//     lastStart: "HH:MM"          // used when mode='range'
//   }
// When hidden control positions should be auto-released on the public page:
// 5 minutes before the first patrol's start, anchored on the competition
// DATE (comp.date + firstStart). Deliberately NOT the wall-clock anchoring
// patrolStartDateTime uses for countdowns — the course must not "release"
// the evening before just because today's HH:MM has passed. Returns a Date,
// or null when auto-release is off or date/start times aren't configured.
export function controlsReleaseTime(comp) {
  if (!comp?.autoReleaseControls) return null;
  const s = startTimeSettings(comp);
  if (!s.enabled || !comp.date) return null;
  const [h, m] = String(s.firstStart || '').split(':').map(Number);
  const [Y, Mo, D] = String(comp.date).split('-').map(Number);
  if (![h, m, Y, Mo, D].every(Number.isFinite)) return null;
  return new Date(Y, Mo - 1, D, h, m - 5);
}

export function controlsAutoReleased(comp, now = new Date()) {
  const t = controlsReleaseTime(comp);
  return !!t && now >= t;
}

export function startTimeSettings(comp) {
  const s = comp?.startTimes || {};
  return {
    enabled: !!s.enabled,
    mode: s.mode === 'range' ? 'range' : 'interval',
    firstStart: s.firstStart || '09:00',
    intervalMinutes: Number(s.intervalMinutes) || 5,
    lastStart: s.lastStart || null
  };
}

// Effective seconds between patrol starts. In interval mode this is just
// intervalMinutes × 60. In range mode it's derived from (lastStart - firstStart)
// / (N - 1), with an over-midnight wrap: if lastStart ≤ firstStart we add 24 h
// so a competition that runs 22:00 → 02:00 works correctly.
export function effectiveIntervalSec(comp, totalPatrols) {
  const s = startTimeSettings(comp);
  if (s.mode === 'range' && s.lastStart && totalPatrols >= 2) {
    const toMin = (t) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    const first = toMin(s.firstStart);
    let last = toMin(s.lastStart);
    if (!Number.isFinite(first) || !Number.isFinite(last)) return s.intervalMinutes * 60;
    if (last <= first) last += 24 * 60;             // rolls past midnight
    return ((last - first) * 60) / (totalPatrols - 1);
  }
  return s.intervalMinutes * 60;
}

// Resolve the competition's start and finish points, normalizing legacy data.
// Returns an array of 1 or 2 entries — use .length to decide whether start and
// finish share the same marker ("S/M") or show two ("S" and "M").
//
//   startFinish legacy:    { enabled, name, lat, lng }
//   startFinish new same:  { enabled, mode:'same',    start: {...} }
//   startFinish new split: { enabled, mode:'separate', start:{...}, finish:{...} }
export function startFinishPoints(comp) {
  const sf = comp?.startFinish;
  if (!sf?.enabled) return [];
  const start = sf.start
    ?? (Number.isFinite(sf.lat) ? { name: sf.name, lat: sf.lat, lng: sf.lng } : null);
  if (!start || !Number.isFinite(start.lat) || !Number.isFinite(start.lng)) return [];

  if (sf.mode === 'separate'
    && sf.finish
    && Number.isFinite(sf.finish.lat)
    && Number.isFinite(sf.finish.lng)) {
    return [
      { ...start,      kind: 'start',  label: 'S',   title: 'Start' },
      { ...sf.finish,  kind: 'finish', label: 'M',   title: 'Mål'   }
    ];
  }
  return [{ ...start, kind: 'startfinish', label: 'S/M', title: 'Start / Mål' }];
}

// Legacy: parkeringen som eget fält på tävlingen, från tiden före platslistan.
// Vyerna använder compPlaces() i places.js — den tar med den här formen som en
// plats så gamla tävlingar behåller sin parkering. Behålls för backupfiler och
// äldre exporter; ta inte bort utan att kontrollera dem.
export function parkingPoint(comp) {
  const p = comp?.parking;
  if (!p?.enabled) return null;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null;
  return {
    kind: 'parking',
    label: 'P',
    title: 'Parkering',
    name: p.name || 'Parkering',
    lat: p.lat,
    lng: p.lng,
    note: p.note || ''
  };
}

// Full Date for a patrol's start moment, anchored on TODAY + firstStart +
// startOrder × effectiveInterval. Pass `totalPatrols` for range mode so the
// derived interval is correct. Anchored on the wall clock (not comp.date) so
// demos + countdowns work on any day.
// Patrullens namn i den form som gäller överallt där den visas som EN etikett:
//
//   Rävarna (Lindsdals Scoutkår)
//
// Flera kårer döper gärna sina patruller likadant, och i sekretariatets vyer
// under tävlingsdagen finns ingen kårkolumn att jämföra med. Utan kåren går
// två "Rävarna" inte att skilja åt när det är bråttom.
//
// Används INTE där kåren redan står bredvid i en egen kolumn eller underrad —
// då blir den bara dubblerad.
export function patrolLabel(patrol) {
  const namn = String(patrol?.name || '').trim();
  const kar = String(patrol?.kar || '').trim();
  if (!namn) return kar || '';
  return kar ? `${namn} (${kar})` : namn;
}

export function patrolStartDateTime(comp, patrol, today = new Date(), totalPatrols = null) {
  const s = startTimeSettings(comp);
  if (!s.enabled) return null;
  const idx = Number(patrol?.startOrder);
  if (!Number.isFinite(idx)) return null;

  const iv = effectiveIntervalSec(comp, totalPatrols);

  // Demo competitions ignore the stored HH:MM and roll the whole schedule
  // so that the current moment always sits ~15 intervals into the start
  // window — half the field has started, half is upcoming, regardless of
  // what time of day someone opens the demo. The offset matches the seeded
  // station passages in scripts/seed-demo.sh (check-outs 150–20 min ago at
  // 10-min intervals), so planned and actual times line up on the station
  // page and the Läget dashboard.
  if (comp?.demo) {
    const base = new Date(today.getTime() - 15 * iv * 1000);
    base.setSeconds(0, 0);
    base.setMinutes(Math.floor(base.getMinutes() / 5) * 5);
    base.setSeconds(base.getSeconds() + idx * iv);
    return base;
  }

  const [h, m] = s.firstStart.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;

  // Riktiga tävlingar med datum ankras på TÄVLINGSDAGEN. Startkorten öppnas
  // dagar i förväg — nedräkningen ska gå mot rätt dag, inte mot dagens HH:MM
  // ("om 4 timmar" fast starten är om tre veckor). Utan datum (testtävlingar)
  // behålls dagens klocka som ankare, och demo-grenen ovan är opåverkad.
  if (comp?.date) {
    const [Y, Mo, D] = String(comp.date).split('-').map(Number);
    if ([Y, Mo, D].every(Number.isFinite)) {
      const base = new Date(Y, Mo - 1, D, h, m, 0, 0);
      base.setSeconds(base.getSeconds() + idx * iv);
      return base;
    }
  }

  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  base.setHours(h, m, 0, 0);
  base.setSeconds(base.getSeconds() + idx * iv);
  return base;
}

// Compute the derived start time for a patrol given its startOrder (0-based).
// Returns "HH:MM" or null if start times are disabled or inputs invalid.
// `today` lets demo views pass their pinned virtual clock so planned times
// stay consistent with the frozen demo snapshot.
export function patrolStartTime(comp, patrol, totalPatrols = null, today = new Date()) {
  const d = patrolStartDateTime(comp, patrol, today, totalPatrols);
  if (!d) return null;
  return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}

// Pick the instruction text that applies to an avdelning.
// Returns { text, avdelningar } — falls back to the default (empty avdelningar) group.
// Legacy controls with a plain `information` string are treated as a single default group.
export function pickInstruction(control, avdelning) {
  const groups = Array.isArray(control?.instructions) && control.instructions.length
    ? control.instructions
    : (control?.information ? [{ avdelningar: [], text: control.information }] : []);
  if (!groups.length) return { text: '', avdelningar: [] };
  if (avdelning) {
    const specific = groups.find(g => (g.avdelningar || []).includes(avdelning));
    if (specific) return specific;
  }
  const fallback = groups.find(g => !g.avdelningar || g.avdelningar.length === 0) || groups[0];
  return fallback;
}

export function allInstructionGroups(control) {
  return Array.isArray(control?.instructions) && control.instructions.length
    ? control.instructions
    : (control?.information ? [{ avdelningar: [], text: control.information }] : []);
}

// Put a button into a disabled + spinner "busy" state while an async action
// runs. Returns a `reset()` to call in a finally block to restore.
export function busyButton(btn, label = 'Sparar…') {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.dataset.busy = '1';
  // .busy-label så en långkörande åtgärd kan skriva ut sitt läge i knappen
  // i stället för att bara låta spinnaren snurra.
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span class="busy-label">${label}</span>`;
  return () => {
    btn.disabled = false;
    delete btn.dataset.busy;
    btn.innerHTML = original;
  };
}

// Convenience: wrap an async handler so we never double-submit and the button
// always resets, even on failure.
export async function withBusy(btn, label, fn) {
  if (btn.disabled) return;
  const reset = busyButton(btn, label);
  try { return await fn(); }
  finally { reset(); }
}

// --- Registration (Anmälan) -------------------------------------------------

export const REG_PRICING_MODELS = [
  { key: 'patrull',  label: 'Patrullvis',  hint: 'Fast kostnad per anmäld patrull.' },
  { key: 'scout',    label: 'Scoutvis',    hint: 'Fast kostnad per anmäld person, oavsett antal patruller.' },
  { key: 'kar',      label: 'Kårvis',      hint: 'En fast anmälningskostnad för hela kåren.' },
  { key: 'dynamisk', label: 'Dynamisk',    hint: 'Fast grundkostnad plus avgift per patrull eller per person.' }
];

// Normalized registration settings with defaults. `mode` is how kårer anmäler
// sig (kårvis = one registration per kår covering all patrols; patrullvis =
// each patrol registers and pays on its own).
// Authoritative payment status. `paidRefs` on the registration is an
// admin-only list of references the kassör has ticked off — anonymous manage-
// link holders cannot write it (Firestore rules), so it cannot be forged. The
// legacy per-payment `paid` flag is NOT trusted for the paid decision.
export function isPaymentPaid(reg, payment) {
  return !!payment && (reg?.paidRefs || []).includes(payment.reference);
}

// Anmälarens PÅSTÅENDE att en betalning är gjord. Detta är INTE ett facit —
// isPaymentPaid är den enda sanningen, och de två får aldrig blandas ihop.
// Påståendet finns för att stoppa "har ni fått vår Swish?"-mejlen: kassören
// ser vad kåren säger, och kåren ser att någon vet om det.
export function isPaymentClaimed(reg, payment) {
  if (!payment) return false;
  return (reg?.paymentClaims || []).some(c => c && c.reference === payment.reference);
}

export function paymentClaimAt(reg, payment) {
  const c = (reg?.paymentClaims || []).find(x => x && x.reference === payment?.reference);
  return c?.at || null;
}

export function registrationSettings(comp) {
  const r = comp?.registration || {};
  return {
    enabled: r.enabled === true,
    mode: r.mode === 'patrull' ? 'patrull' : 'kar',
    opensAt: r.opensAt || null,   // 'YYYY-MM-DD', inclusive
    closesAt: r.closesAt || null, // 'YYYY-MM-DD', inclusive
    info: r.info || '',
    pricing: {
      model: ['patrull','scout','kar','dynamisk'].includes(r.pricing?.model) ? r.pricing.model : 'patrull',
      perPatrol: Number(r.pricing?.perPatrol) || 0,
      perScout: Number(r.pricing?.perScout) || 0,
      flat: Number(r.pricing?.flat) || 0,
      base: Number(r.pricing?.base) || 0,
      unit: r.pricing?.unit === 'scout' ? 'scout' : 'patrull',
      perUnit: Number(r.pricing?.perUnit) || 0
    },
    methods: Array.isArray(r.methods) ? r.methods : [],
    // Custom free-text fields on the registration form. scope 'anmalan' asks
    // once per registration, 'patrull' asks per patrol (e.g. allergies).
    fields: (Array.isArray(r.fields) ? r.fields : [])
      .filter(f => f && f.id && (f.label || '').trim())
      .map(f => ({
        id: f.id,
        label: f.label.trim(),
        // Hjälptext under rubriken — t.ex. ingredienslista för matfrågan.
        description: (f.description || '').trim(),
        scope: f.scope === 'patrull' ? 'patrull' : 'anmalan',
        required: f.required === true
      }))
  };
}

// Where in the registration window we are right now: 'unconfigured' | 'before'
// | 'open' | 'closed'. Dates compared as local YYYY-MM-DD strings, inclusive.
export function registrationState(comp, today = new Date()) {
  const s = registrationSettings(comp);
  if (!s.enabled) return 'unconfigured';
  if (comp?.closed) return 'closed'; // avslutad tävling tar inte emot något
  const d = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0')
  ].join('-');
  if (s.opensAt && d < s.opensAt) return 'before';
  if (s.closesAt && d > s.closesAt) return 'closed';
  return 'open';
}

// Compute the price for a set of patrols under the competition's pricing
// model. Returns { total, rows } where rows explain the sum line by line.
export function computeRegistrationPrice(pricing, patrols) {
  const nPatrols = patrols.length;
  const nScouts = patrols.reduce((s, p) => s + (Number(p.antal) || 0), 0);
  const kr = (n) => `${n} kr`;
  const rows = [];
  let total = 0;
  switch (pricing.model) {
    case 'scout':
      total = pricing.perScout * nScouts;
      rows.push({ label: `${nScouts} scouter × ${kr(pricing.perScout)}`, amount: total });
      break;
    case 'kar':
      total = nPatrols > 0 ? pricing.flat : 0;
      rows.push({ label: 'Fast avgift för kåren', amount: total });
      break;
    case 'dynamisk': {
      const n = pricing.unit === 'scout' ? nScouts : nPatrols;
      const per = pricing.perUnit * n;
      total = (n > 0 ? pricing.base : 0) + per;
      if (n > 0) rows.push({ label: 'Grundavgift', amount: pricing.base });
      rows.push({ label: `${n} ${pricing.unit === 'scout' ? 'scouter' : 'patruller'} × ${kr(pricing.perUnit)}`, amount: per });
      break;
    }
    case 'patrull':
    default:
      total = pricing.perPatrol * nPatrols;
      rows.push({ label: `${nPatrols} patruller × ${kr(pricing.perPatrol)}`, amount: total });
      break;
  }
  return { total, rows, nPatrols, nScouts };
}

// Payment reference like "AH26-K7PM": competition initials + 2-digit year +
// 4 random chars. EVERY character (prefix included) is restricted to an
// alphabet without lookalikes — no 0/O, 1/I/L — so references survive
// handwriting and being read aloud. Year is dropped from the prefix when its
// digits aren't safe (e.g. 2030/2031); uniqueness lives in the random part.
const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const refSafe = (s) => [...String(s).toUpperCase()].filter(ch => REF_ALPHABET.includes(ch)).join('');

// The reference prefix ("AH26"): the competition's fixed slug when set (so
// payment references and the short URL /t/<slug> are the same identifier),
// otherwise derived from shortName initials + 2-digit year.
export function refPrefix(comp) {
  const fromSlug = refSafe(comp?.slug || '');
  if (fromSlug.length >= 2) return fromSlug.slice(0, 8);
  const src = (comp?.shortName || comp?.name || 'ES')
    .replace(/[åä]/gi, 'a').replace(/[ö]/gi, 'o')
    .replace(/[0-9]/g, '');
  const fromWords = refSafe(src.split(/\s+/).map(w => w[0] || '').join(''));
  // Prefer word initials; if they don't yield 2 safe letters, take the first
  // safe letters of the name instead (e.g. "Lindsdalsjakten" → "ND").
  const initials = (fromWords.length >= 2 ? fromWords : refSafe(src.replace(/\s+/g, ''))).slice(0, 2) || 'ES';
  const yyRaw = refSafe(String(comp?.year || '').slice(-2));
  const yy = yyRaw.length === 2 ? yyRaw : '';
  return `${initials}${yy}`;
}

export function makePaymentReference(comp) {
  const rnd = new Uint32Array(4);
  crypto.getRandomValues(rnd);
  const code = [...rnd].map(v => REF_ALPHABET[v % REF_ALPHABET.length]).join('');
  return `${refPrefix(comp)}-${code}`;
}

// --- Competition slug (kortadress) ------------------------------------------
// Fixed human identifier set at creation: /t/<slug> and /a/<slug> resolve to
// the competition, and payment references use it as prefix. Lowercase a-z0-9
// (åäö folded), 2–24 chars, hyphen allowed inside.
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;

export function normSlug(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[åä]/g, 'a').replace(/ö/g, 'o')
    .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

export function isValidSlug(s) {
  return SLUG_RE.test(s) && s.length >= 2;
}

// Suggestion for a new competition: same identity as the payment-reference
// prefix — "Älghornsjakten" + 2026 → "ah26".
export function suggestSlug(shortName, year) {
  return normSlug(refPrefix({ shortName, year }));
}

// Swish prefilled-QR payload. Format: C<number>;<amount>;<message>;<mask>
// where the trailing mask lists which fields stay EDITABLE in the app
// (0 = everything locked — number, amount and message are all fixed).
export function swishQrString(number, amount, message) {
  const digits = String(number || '').replace(/[^0-9]/g, '');
  const amt = Number.isInteger(amount) ? String(amount) : Number(amount).toFixed(2);
  return `C${digits};${amt};${message};0`;
}

// Deep link that opens the Swish app with number, amount and reference
// prefilled — the mobile counterpart to the QR (which suits a second screen).
// Same fields as swishQrString, but as the official app.swish.nu URL.
export function swishAppUrl(number, amount, message) {
  const digits = String(number || '').replace(/[^0-9]/g, '');
  const amt = Number.isInteger(amount) ? String(amount) : Number(amount).toFixed(2);
  return `https://app.swish.nu/1/p/sw/?sw=${encodeURIComponent(digits)}&amt=${encodeURIComponent(amt)}&cur=SEK&msg=${encodeURIComponent(message || '')}&src=qr`;
}

export function registrationUrl(competitionId, regId = null) {
  return `${location.origin}/a/${competitionId}${regId ? '/' + regId : ''}`;
}

// Slår ihop enheternas livstecken till en rad för Läget. Reglerna: senaste
// `at` vinner (någon är vaken), men batteriet är det LÄGSTA bland enheter som
// hörts av den senaste kvarten — annars vore sammanslagningen bara ett nytt
// sätt att dölja den döende telefonen. Kön är den största: det är den mängd
// poäng som ännu inte nått servern.
const FARSK_MS = 15 * 60000;
export function mergeBeacons(docs, nu = Date.now()) {
  const rader = docs.filter(d => d && d.at);
  if (!rader.length) return null;
  const tid = d => (d.at?.toDate ? d.at.toDate() : new Date(d.at)).getTime();
  const senast = rader.reduce((a, b) => (tid(a) >= tid(b) ? a : b));
  const farska = rader.filter(d => nu - tid(d) < FARSK_MS);
  const medBatt = (farska.length ? farska : [senast]).filter(d => typeof d.batteri === 'number');
  const svagast = medBatt.length ? medBatt.reduce((a, b) => (a.batteri <= b.batteri ? a : b)) : null;
  return {
    at: senast.at,
    batteri: svagast ? svagast.batteri : null,
    laddar: svagast ? !!svagast.laddar : null,
    koade: Math.max(0, ...farska.map(d => Number(d.koade) || 0), 0),
    enheter: farska.length
  };
}

// --- Snabbnoteringar på rapportsidan -----------------------------------------
// Kontrollantens fritextfält fylls sällan i: att skriva på en telefon i regn,
// med vantar, mellan två patruller, kostar för mycket.
//
// VAR NOTERINGEN SYNS (verifierat, inte antaget): kontrollens detaljvy i admin
// (member-only) OCH patrullmodalen på den PUBLIKA tävlingssidan. Den går
// INTE till exporten och INTE till reservprotokollet. Att standardisera
// etiketterna gör att de publiceras systematiskt bredvid patrullnamn och kår —
// därför får listan bara innehålla sådant som tål att stå på en anslagstavla.
// Inget om hälsa, skada eller enskilda scouters uppförande: det hör hemma i
// fälttråden till ledningen, som är member-only.
//
// Etiketterna får ALDRIG innehålla '. ' — det är separatorn i notDelar().
export const NOTE_CHIPS = [
  'Regelbrott',
  'Sen ankomst',
  'Utrustning saknades',
  'Fick hjälp utifrån',
  'Bra samarbete'
];

// Etiketten avgränsas av punkt+mellanslag. Matchningen är på hela stycken så
// att ett ord inne i en fritext inte råkar tända ett chip.
const notDelar = (text) => String(text || '').split('. ').map(d => d.trim()).filter(Boolean);

export function harNotering(text, etikett) {
  return notDelar(text).includes(etikett);
}

export function laggTillNotering(text, etikett) {
  if (harNotering(text, etikett)) return String(text || '');
  const delar = notDelar(text);
  // Etiketterna först, fritexten sist — den som läser noteringen ska se
  // avvikelsen direkt, inte leta i slutet av en mening.
  const kanda = NOTE_CHIPS.filter(t => delar.includes(t) || t === etikett);
  const ovrigt = delar.filter(d => !NOTE_CHIPS.includes(d));
  return [...kanda, ...ovrigt].join('. ');
}

// Kapar FRITEXTEN, aldrig en etikett. En rak slice(0, 500) hade kapat i
// fritexten först när chipsen låg först i strängen — och tyst, mitt i ett ord.
export function kapaNotering(text, max = 500) {
  const t = String(text || '');
  if (t.length <= max) return t;
  const delar = notDelar(t);
  const kanda = delar.filter(d => NOTE_CHIPS.includes(d));
  const ovrigt = delar.filter(d => !NOTE_CHIPS.includes(d));
  const prefix = kanda.join('. ');
  const kvar = max - prefix.length - (prefix && ovrigt.length ? 2 : 0);
  if (kvar <= 0) return prefix.slice(0, max);
  const fritext = ovrigt.join('. ').slice(0, kvar);
  return [prefix, fritext].filter(Boolean).join('. ');
}

export function taBortNotering(text, etikett) {
  return notDelar(text).filter(d => d !== etikett).join('. ');
}

// --- Publik anslagstavla på tävlingssidan -------------------------------------
// Anhöriga såg ingenting när starten försenades. Anslagen återanvänder
// driftmeddelandena (competitions/{cid}/messages) med en TREDJE mottagarkanal,
// `target.publikt`, i stället för en egen kollektion — de är redan publikt
// läsbara och admin-skrivna, så ingen ny regelyta öppnas.
//
// Grinden är `=== true`, ALDRIG `!== false`. Ett fältmeddelande till
// kontrollerna saknar fältet helt, och med den slappa jämförelsen hade det
// hamnat på en sida som vem som helst med länken kan läsa.
const ANSLAG_VIKT = { kritisk: 0, varning: 1, info: 2 };

export function publicNotices(msgs) {
  return (msgs || [])
    .filter(m => m && m.target && m.target.publikt === true
                 && m.active !== false && String(m.text || '').trim())
    .sort((a, b) =>
      (ANSLAG_VIKT[a.level] ?? 2) - (ANSLAG_VIKT[b.level] ?? 2)
      || String(b.at || '').localeCompare(String(a.at || '')))
    // VITLISTNING, inte spridning. `target` bär kontroll- och patrull-id:n,
    // och ett id ÄR den hemliga länken — det får aldrig nå den publika DOM:en.
    .map(m => ({
      id: m.id,
      text: String(m.text),
      level: ANSLAG_VIKT[m.level] != null ? m.level : 'info',
      at: m.at || null
    }));
}

// Tavlan tar plats på sidan, så den visas inte i onödan: finns det anslag syns
// den alltid, annars bara på och kring tävlingsdagen (då "allt lugnt" faktiskt
// betyder något). Utan datum, och för demo, visas den alltid.
export function anslagSynlig(comp, anslag, nu = new Date()) {
  if ((anslag || []).length) return true;
  if (!comp || comp.demo) return true;
  if (!comp.date) return true;
  const dag = new Date(comp.date + 'T00:00:00');
  const diff = Math.round((dag - new Date(nu.getFullYear(), nu.getMonth(), nu.getDate())) / 86400000);
  return diff >= 0 && diff <= 1;
}

// --- Sparläge vid lågt batteri på rapportsidan --------------------------------
// En kontroll längst ut på banan har ingen laddning och telefonen ska räcka
// hela dagen. Beslutet är rent så det går att testa utan ett batteri-API.
//
// HYSTERES: läget slår PÅ vid 20 % men AV först vid 30 %. Med en enda tröskel
// fladdrar det fram och tillbaka kring gränsen — skärmlåset tas och släpps om
// vartannat, vilket kostar mer ström än det sparar och dessutom blinkar för
// kontrollanten.
export const SPAR_PA_UNDER = 0.20;
export const SPAR_AV_VID = 0.30;

export function sparlagesBeslut(nuvarande, { level, charging } = {}) {
  // Laddar telefonen finns ingen anledning att spara — oavsett nivå.
  if (charging) return false;
  if (!Number.isFinite(level)) return nuvarande;   // okänt batteri ändrar inget
  if (!nuvarande && level <= SPAR_PA_UNDER) return true;
  if (nuvarande && level >= SPAR_AV_VID) return false;
  return nuvarande;
}
