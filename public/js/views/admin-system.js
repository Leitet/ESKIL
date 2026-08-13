// Super-admin only: ESKIL "Systemhubb" — a reference console with links to the
// external dashboards where ESKIL is administered (Firebase, Google Cloud,
// Brevo, reCAPTCHA, GitHub), a "who administers what" map, live system info,
// and a few operational settings that are tunable WITHOUT a deploy
// (config/system, read by the Cloud Functions).

import { layout } from '../app.js';
import { getSystemConfig, setSystemConfig } from '../store.js';
import { escapeHtml, toast, withBusy } from '../utils.js';
import { icon } from '../icons.js';
import { navigate } from '../router.js';

const PROJECT = 'eskil-scout';
const FB = `https://console.firebase.google.com/project/${PROJECT}`;
const GH = 'https://github.com/Leitet/ESKIL';

// External dashboards, grouped by service. Each row: [label, url, hint].
const LINK_GROUPS = [
  {
    title: 'Firebase Console', accent: 'var(--avent-orange)',
    links: [
      ['Projektöversikt', `${FB}/overview`, 'Allmän status'],
      ['Firestore-data', `${FB}/firestore/data`, 'Databasen — tävlingar, kontroller, poäng'],
      ['Säkerhetsregler', `${FB}/firestore/rules`, 'Firestore-reglerna (deployas via CI)'],
      ['Authentication', `${FB}/authentication/users`, 'Inloggade konton'],
      ['App Check', `${FB}/appcheck`, 'reCAPTCHA-attestering (framtvingad)'],
      ['Cloud Functions', `${FB}/functions`, 'Mail-funktionerna'],
      ['Functions-loggar', `${FB}/functions/logs`, 'Felsökning av mail/inloggning'],
      ['Hosting', `${FB}/hosting/main`, 'Domäner & driftsättningar'],
      ['Extensions', `${FB}/extensions`, 'Trigger Email (Brevo)'],
    ],
  },
  {
    title: 'Google Cloud', accent: 'var(--scout-blue)',
    links: [
      ['Fakturering & budget', 'https://console.cloud.google.com/billing', 'Budget-alert mot kostnads-DoS'],
      ['Logs Explorer', `https://console.cloud.google.com/logs/query?project=${PROJECT}`, 'Djupare loggar'],
      ['Cloud Functions (gen2)', `https://console.cloud.google.com/functions/list?project=${PROJECT}`, 'Körning & mätvärden'],
      ['Cloud Run', `https://console.cloud.google.com/run?project=${PROJECT}`, 'Functions körs som Run-tjänster'],
    ],
  },
  {
    title: 'Brevo (e-post)', accent: 'var(--spaer-green)',
    links: [
      ['Brevo-dashboard', 'https://app.brevo.com', 'Transaktionsmail'],
      ['E-poststatistik', 'https://app.brevo.com/statistics/email', 'Volym & leverans'],
      ['SMTP & API-nycklar', 'https://app.brevo.com/settings/keys/smtp', 'SMTP-uppgifter (i Trigger Email-ext.)'],
    ],
  },
  {
    title: 'Övrigt', accent: 'var(--utm-pink)',
    links: [
      ['reCAPTCHA-admin', 'https://www.google.com/recaptcha/admin', 'App Check-nyckeln'],
      ['GitHub — repo', GH, 'Källkod'],
      ['GitHub — Actions', `${GH}/actions`, 'Driftsättningar (hosting + regler)'],
      ['GitHub — Secrets', `${GH}/settings/secrets/actions`, 'CI-hemligheter'],
    ],
  },
];

// "Who administers what" — the operational map.
const ADMIN_MAP = [
  ['Driftsättning: hosting + regler', 'GitHub → main', 'Push till main → GitHub Actions driftsätter automatiskt.'],
  ['Driftsättning: Cloud Functions', 'Terminal (manuellt)', '<code>npx firebase-tools deploy --only functions</code> — ingår ej i CI.'],
  ['Transaktionsmail', 'Brevo + Trigger Email', 'Functions skriver till <code>mail</code>-kollektionen; extensionen levererar via Brevo SMTP.'],
  ['App Check', 'Firebase Console → App Check', 'reCAPTCHA v3, framtvingad på Firestore + Functions.'],
  ['Hemligheter', 'GitHub Secrets + Bitwarden', 'Aldrig i koden. Backas upp i Bitwarden.'],
  ['Domän & cert', 'Firebase Hosting + DNS-leverantör', 'eskilscout.se — auto-cert via Hosting.'],
  ['Super-admin-e-post', 'Hårdkodad (store.js + firestore.rules)', 'Kräver kodändring + regel-deploy att byta.'],
  ['Mail-kvoter', 'Denna sida (config/system)', 'Justerbara utan deploy — se nedan.'],
];

function linkRow([label, url, hint]) {
  return `
    <a class="sys-link" href="${url}" target="_blank" rel="noopener">
      <div>
        <div class="sys-link-label">${escapeHtml(label)} ${icon('external', { size: 13 })}</div>
        <div class="muted t-sm">${escapeHtml(hint)}</div>
      </div>
    </a>`;
}

export async function renderAdminSystem(app, user) {
  if (user?.role !== 'super-admin') {
    navigate('/app', true);
    return;
  }

  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="card"><div class="muted">Laddar…</div></div>`;
  layout(wrap, { narrow: true });

  let config = {};
  try { config = await getSystemConfig(); } catch (e) { console.warn('[ESKIL] kunde inte läsa config:', e); }

  wrap.innerHTML = `
    <div class="page-head">
      <div>
        <div class="t-over">Super-admin</div>
        <h1 class="t-d2">Systemhubb</h1>
        <p class="muted">Var ESKIL administreras — dashboards, driftsättning och inställningar som inte är hårdkodade.</p>
      </div>
      <div class="btn-row"><a class="btn btn-ghost btn-sm" href="/app/admin/users" data-link>Användare ${icon('arrow-right', { size: 14 })}</a></div>
    </div>

    <div class="card">
      <h3 class="t-h3" style="margin-top:0;">Systemstatus</h3>
      <div class="sys-info">
        <div><span class="muted t-sm">Produktionsdomän</span><strong>eskilscout.se</strong></div>
        <div><span class="muted t-sm">Firebase-projekt</span><strong>${PROJECT}</strong></div>
        <div><span class="muted t-sm">Inloggad super-admin</span><strong>${escapeHtml(user.email || '')}</strong></div>
        <div><span class="muted t-sm">App Check</span><strong style="color:var(--spaer-green);">Framtvingad</strong></div>
        <div><span class="muted t-sm">E-post</span><strong>Brevo (Trigger Email)</strong></div>
        <div><span class="muted t-sm">Driftsättning</span><strong>CI: hosting+regler · manuell: functions</strong></div>
      </div>
    </div>

    ${LINK_GROUPS.map(g => `
      <div class="card">
        <h3 class="t-h4" style="margin:0 0 var(--sp-3);color:${g.accent};">${escapeHtml(g.title)}</h3>
        <div class="sys-links">${g.links.map(linkRow).join('')}</div>
      </div>
    `).join('')}

    <div class="card">
      <h3 class="t-h3" style="margin-top:0;">Var administreras vad</h3>
      <div class="table-wrap">
        <table class="t sys-map">
          <tbody>
            ${ADMIN_MAP.map(([what, where, how]) => `
              <tr>
                <td><strong>${escapeHtml(what)}</strong></td>
                <td class="muted t-sm">${escapeHtml(where)}</td>
                <td class="t-sm">${how}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3 class="t-h3" style="margin-top:0;">Mail-kvoter (justerbart utan deploy)</h3>
      <p class="muted t-sm">Cloud Functions läser dessa från <code>config/system</code>. Lämna tomt för att använda standardvärdet. Höj t.ex. tillfälligt inför en stor tävlingsdag.</p>
      <div class="sys-config">
        <label class="field">Transaktionsmail / dygn
          <input class="input" id="cfg-mail" type="number" min="1" placeholder="standard: 800" value="${config.mailDailyCap ?? ''}">
        </label>
        <label class="field">Inloggningslänkar / dygn
          <input class="input" id="cfg-login" type="number" min="1" placeholder="standard: 150" value="${config.loginDailyCap ?? ''}">
        </label>
        <label class="field">Mottagare / PM-utskick
          <input class="input" id="cfg-utskick" type="number" min="1" placeholder="standard: 500" value="${config.utskickRecipientCap ?? ''}">
        </label>
      </div>
      <div class="btn-row" style="margin-top:var(--sp-4);">
        <button class="btn btn-primary btn-sm" id="cfg-save">Spara kvoter</button>
      </div>
    </div>
  `;

  wrap.querySelector('#cfg-save').addEventListener('click', (e) => withBusy(e.currentTarget, 'Sparar…', async () => {
    const num = (id) => {
      const v = wrap.querySelector(id).value.trim();
      return v === '' ? null : (Number(v) > 0 ? Math.round(Number(v)) : null);
    };
    try {
      await setSystemConfig({
        mailDailyCap: num('#cfg-mail'),
        loginDailyCap: num('#cfg-login'),
        utskickRecipientCap: num('#cfg-utskick'),
      });
      toast('Kvoterna sparade — gäller nästa mailutskick', 'success');
    } catch (err) {
      toast('Kunde inte spara: ' + err.message, 'error');
    }
  }));
}
