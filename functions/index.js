// ESKIL Cloud Functions — transactional email.
//
// These functions never send mail themselves: they compose documents in the
// `mail` collection, and the Trigger Email extension (firestore-send-email,
// configured with Brevo SMTP) picks them up and delivers. Firestore rules
// have no match for /mail/** so clients can never write mail docs — only
// these server-side triggers can, which is what makes anonymous registration
// pages safe to keep fully open.
//
// Triggers:
//  - registration created            → confirmation mail to the contact
//  - payment flips to paid           → receipt mail (PDF attached) to the contact
//  - förhinder appended              → notice to tävlingsledningen
//  - registration cancelled          → notice to tävlingsledningen
//  - kontrollansvarig added          → welcome mail with control + report links

const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const { renderReceiptPdfBase64 } = require('./receipt-pdf');

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

const APP_URL = 'https://eskilscout.se';
const MAIL_COLLECTION = 'mail';
// Where the magic-link lands after sign-in. The action link itself is hosted
// on the Firebase auth domain; once the eskilscout.se certificate is live the
// host can be swapped by setting LOGIN_LINK_HOST = 'eskilscout.se'.
const LOGIN_CONTINUE_URL = 'https://eskil-scout.web.app/app';
const LOGIN_LINK_HOST = null;

// --- Helpers -----------------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function compLabel(comp) {
  return `${comp.shortName || comp.name || 'Tävling'}${comp.year ? ' ' + comp.year : ''}`;
}

async function getComp(cid) {
  const snap = await db.doc(`competitions/${cid}`).get();
  return snap.exists ? { id: cid, ...snap.data() } : null;
}

// Management entries with an email address. Handles both the array form and
// the legacy { leader: {...}, registrations: {...} } object form (mirrors
// normalizeManagement in public/js/utils.js).
function managementEmails(comp) {
  const raw = comp && comp.management;
  let entries = [];
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (raw && typeof raw === 'object') {
    entries = ['leader', 'registrations', 'secretariat']
      .map(id => ({ id, ...(raw[id] || {}) }));
  }
  entries = entries.filter(r => (r.email || '').trim());
  // Prefer the anmälnings-ansvarig role; fall back to everyone with an email.
  const reg = entries.filter(r => r.id === 'registrations' || /anmäl/i.test(r.label || ''));
  return (reg.length ? reg : entries).map(r => r.email.trim());
}

function nScouts(reg) {
  return (reg.patrols || []).reduce((s, p) => s + (Number(p.antal) || 0), 0);
}

function manageUrl(cid, regId) {
  return `${APP_URL}/a/${cid}/${regId}`;
}

// Shared mail chrome — deliberately simple inline-styled HTML that renders
// fine in every mail client. `replyHint` must match whether the message has a
// Reply-To: the sender is noreply@, so never invite replies unless they
// actually land somewhere.
function layout(comp, bodyHtml, replyHint = 'Mailet går inte att svara på.') {
  return `
  <div style="margin:0 auto;max-width:560px;font-family:Helvetica,Arial,sans-serif;color:#282727;">
    <div style="background:#003660;color:#ffffff;padding:22px 26px;border-radius:10px 10px 0 0;">
      <div style="color:#E2E000;font-size:11px;font-weight:bold;letter-spacing:2px;">ESKIL · SCOUTTÄVLING</div>
      <div style="font-size:20px;font-weight:bold;margin-top:6px;">${esc(compLabel(comp))}</div>
    </div>
    <div style="border:1px solid #d2dde8;border-top:none;padding:24px 26px;border-radius:0 0 10px 10px;font-size:15px;line-height:1.55;">
      ${bodyHtml}
      <p style="color:#8a8a8a;font-size:12px;margin-top:28px;border-top:1px solid #e8eef4;padding-top:12px;">
        Detta mail skickades automatiskt av ESKIL för ${esc(comp.organizer || compLabel(comp))}.
        ${esc(replyHint)}
      </p>
    </div>
  </div>`;
}

function button(href, label) {
  return `<p style="margin:22px 0;">
    <a href="${esc(href)}" style="display:inline-block;background:#003660;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px;">${esc(label)}</a>
  </p>
  <p style="font-size:12px;color:#8a8a8a;word-break:break-all;">Fungerar inte knappen? Kopiera länken: ${esc(href)}</p>`;
}

function patrolListHtml(reg) {
  return `<ul style="padding-left:18px;margin:8px 0;">
    ${(reg.patrols || []).map(p =>
      `<li><strong>${esc(p.name)}</strong> — ${esc(p.avdelning || '')}, ${Number(p.antal) || 0} scouter</li>`
    ).join('')}
  </ul>`;
}

async function queueMail(doc) {
  await db.collection(MAIL_COLLECTION).add(doc);
}

// --- Triggers ------------------------------------------------------------------

// --- Magic-link login mail ----------------------------------------------------
// The client calls this instead of Firebase Auth's own sendSignInLinkToEmail,
// so the login mail goes through Brevo with our branding instead of the
// generic "Sign in to eskil-scout" template from noreply@firebaseapp.com.
// Throttled per address (the endpoint is necessarily unauthenticated — it IS
// the login), state kept in loginRequests/{email} which has no rules match,
// so only this function can touch it.

const LOGIN_MIN_INTERVAL_MS = 60 * 1000; // 1 request/minute per address
const LOGIN_MAX_PER_DAY = 10;

exports.requestLoginLink = onCall(async (req) => {
  const email = String((req.data && req.data.email) || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'Ogiltig e-postadress.');
  }

  // Throttle
  const today = new Date().toISOString().slice(0, 10);
  const throttleRef = db.doc(`loginRequests/${email}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(throttleRef);
    const d = snap.exists ? snap.data() : {};
    const now = Date.now();
    if (d.lastSentAt && now - d.lastSentAt < LOGIN_MIN_INTERVAL_MS) {
      throw new HttpsError('resource-exhausted', 'En länk skickades nyss — vänta en minut och försök igen.');
    }
    const count = d.day === today ? (d.count || 0) : 0;
    if (count >= LOGIN_MAX_PER_DAY) {
      throw new HttpsError('resource-exhausted', 'För många inloggningslänkar idag — försök igen imorgon.');
    }
    tx.set(throttleRef, { lastSentAt: now, day: today, count: count + 1 });
  });

  let link = await admin.auth().generateSignInWithEmailLink(email, {
    url: LOGIN_CONTINUE_URL,
    handleCodeInApp: true
  });
  if (LOGIN_LINK_HOST) {
    link = link.replace(/^https:\/\/[^/]+/, `https://${LOGIN_LINK_HOST}`);
  }

  const body = `
    <p>Hej!</p>
    <p>Klicka på knappen för att logga in i ESKIL. Länken kan bara användas en gång
    och går ut efter en stund — begär en ny från inloggningssidan om den hunnit sluta gälla.</p>
    ${button(link, 'Logga in i ESKIL')}
    <p style="font-size:13px;color:#8a8a8a;">Begärde du inte den här länken kan du tryggt ignorera mailet —
    ingen kan logga in utan åtkomst till din inkorg.</p>
  `;
  await queueMail({
    to: [email],
    message: {
      subject: 'Logga in i ESKIL',
      html: layout({ shortName: 'Logga in', organizer: 'ESKIL' }, body),
      text: `Logga in i ESKIL med den här länken (engångslänk): ${link}`
    }
  });
  logger.info(`Login link mail queued for ${email}`);
  return { ok: true };
});

exports.onRegistrationCreated = onDocumentCreated('competitions/{cid}/registrations/{regId}', async (event) => {
  const { cid, regId } = event.params;
  const reg = event.data && event.data.data();
  if (!reg || !reg.contact || !reg.contact.email) return;

  const comp = await getComp(cid);
  if (!comp || comp.demo) return;

  const unpaid = (reg.payments || []).filter(p => !p.paid);
  const url = manageUrl(cid, regId);
  const replyTo = managementEmails(comp)[0] || undefined;

  const body = `
    <p>Hej ${esc(reg.contact.name || '')}!</p>
    <p>Tack för er anmälan till <strong>${esc(compLabel(comp))}</strong>. Vi har registrerat
    <strong>${(reg.patrols || []).length} patrull${(reg.patrols || []).length === 1 ? '' : 'er'}</strong>
    (${nScouts(reg)} scouter) för <strong>${esc(reg.kar || '')}</strong>:</p>
    ${patrolListHtml(reg)}
    ${unpaid.length ? `
      <p><strong>Betalning:</strong> ${unpaid.map(p => `${p.amount} kr med referens <strong style="font-family:monospace;">${esc(p.reference)}</strong>`).join(' samt ')}.
      Betalningsinstruktioner finns på er anmälningssida. Ett kvitto mailas när tävlingsledningen
      har prickat av betalningen.</p>
    ` : `<p>Ingen avgift återstår att betala.</p>`}
    <p>Med länken nedan kan ni när som helst se er anmälan — och ändra den, lägga till patruller
    eller avanmäla er så länge anmälningsperioden är öppen. <strong>Spara det här mailet.</strong></p>
    ${button(url, 'Visa och ändra er anmälan')}
  `;

  await queueMail({
    to: [reg.contact.email],
    ...(replyTo ? { replyTo } : {}),
    message: {
      subject: `Anmälan mottagen — ${compLabel(comp)}`,
      html: layout(comp, body, replyTo ? 'Svar på mailet går till tävlingsledningen.' : undefined),
      text: `Tack för er anmälan till ${compLabel(comp)}. ${(reg.patrols || []).length} patruller, ${nScouts(reg)} scouter. Se och ändra er anmälan: ${url}`
    }
  });
  logger.info(`Confirmation mail queued for ${cid}/${regId}`);
});

exports.onRegistrationUpdated = onDocumentUpdated('competitions/{cid}/registrations/{regId}', async (event) => {
  const { cid, regId } = event.params;
  const before = event.data && event.data.before.data();
  const after = event.data && event.data.after.data();
  if (!before || !after) return;

  const comp = await getComp(cid);
  if (!comp || comp.demo) return;

  const jobs = [];

  // 1) Payments that flipped to paid → receipt with PDF attached.
  const wasPaid = new Map((before.payments || []).map(p => [p.id, !!p.paid]));
  const newlyPaid = (after.payments || []).filter(p => p.paid && !wasPaid.get(p.id));
  for (const payment of newlyPaid) {
    if (!after.contact || !after.contact.email) continue;
    const replyTo = managementEmails(comp)[0] || undefined;
    const url = manageUrl(cid, regId);
    const body = `
      <p>Hej ${esc(after.contact.name || '')}!</p>
      <p>Tävlingsledningen har registrerat er betalning på <strong>${payment.amount} kr</strong>
      (referens <strong style="font-family:monospace;">${esc(payment.reference)}</strong>) för
      <strong>${esc(after.kar || '')}</strong>. Kvittot ligger som PDF-bilaga i det här mailet.</p>
      ${button(url, 'Visa er anmälan')}
    `;
    jobs.push(queueMail({
      to: [after.contact.email],
      ...(replyTo ? { replyTo } : {}),
      message: {
        subject: `Kvitto ${payment.reference} — ${compLabel(comp)}`,
        html: layout(comp, body, replyTo ? 'Svar på mailet går till tävlingsledningen.' : undefined),
        text: `Er betalning på ${payment.amount} kr (referens ${payment.reference}) är registrerad. Kvitto bifogas. ${url}`,
        attachments: [{
          filename: `kvitto-${String(payment.reference || 'betalning').replace(/[^\w-]+/g, '_')}.pdf`,
          content: renderReceiptPdfBase64(comp, after, payment),
          encoding: 'base64'
        }]
      }
    }));
  }

  // 2) Förhinder appended → notify tävlingsledningen.
  const beforeCount = (before.forhinder || []).length;
  const newForhinder = (after.forhinder || []).slice(beforeCount);
  if (newForhinder.length) {
    const to = managementEmails(comp);
    if (to.length) {
      const body = `
        <p><strong>${esc(after.kar || '')}</strong> har anmält förhinder:</p>
        <ul style="padding-left:18px;">
          ${newForhinder.map(f => `<li><strong>${esc(f.patrol || 'Hela anmälan')}</strong>: ${esc(f.message || '')}</li>`).join('')}
        </ul>
        <p>Kontakt: ${esc(after.contact && after.contact.name || '')} ·
        ${esc(after.contact && after.contact.email || '')}${after.contact && after.contact.phone ? ' · ' + esc(after.contact.phone) : ''}</p>
        ${button(`${APP_URL}/app/c/${cid}/anmalan`, 'Öppna anmälningsvyn')}
      `;
      jobs.push(queueMail({
        to,
        ...(after.contact && after.contact.email ? { replyTo: after.contact.email } : {}),
        message: {
          subject: `Förhinder — ${after.kar || 'okänd kår'} (${compLabel(comp)})`,
          html: layout(comp, body, after.contact && after.contact.email ? 'Svar på mailet går direkt till anmälaren.' : undefined),
          text: `${after.kar}: ${newForhinder.map(f => `${f.patrol || 'Hela anmälan'}: ${f.message}`).join(' | ')}`
        }
      }));
    } else {
      logger.warn(`Förhinder for ${cid}/${regId} but no management email configured`);
    }
  }

  // 3) Registration cancelled → notify tävlingsledningen.
  if (!before.cancelled && after.cancelled) {
    const to = managementEmails(comp);
    if (to.length) {
      const paid = (after.payments || []).filter(p => p.paid).reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const body = `
        <p><strong>${esc(after.kar || '')}</strong> har avanmält sig från ${esc(compLabel(comp))}
        (${(after.patrols || []).length} patruller, ${nScouts(after)} scouter).</p>
        ${paid > 0 ? `<p><strong>Obs:</strong> ${paid} kr är inbetalt och kan behöva återbetalas.</p>` : ''}
        <p>Kontakt: ${esc(after.contact && after.contact.name || '')} ·
        ${esc(after.contact && after.contact.email || '')}</p>
        ${button(`${APP_URL}/app/c/${cid}/anmalan`, 'Öppna anmälningsvyn')}
      `;
      jobs.push(queueMail({
        to,
        ...(after.contact && after.contact.email ? { replyTo: after.contact.email } : {}),
        message: {
          subject: `Avanmälan — ${after.kar || 'okänd kår'} (${compLabel(comp)})`,
          html: layout(comp, body, after.contact && after.contact.email ? 'Svar på mailet går direkt till anmälaren.' : undefined),
          text: `${after.kar} har avanmält sig. ${paid > 0 ? paid + ' kr inbetalt — ev. återbetalning.' : ''}`
        }
      }));
    }
  }

  await Promise.all(jobs);
  if (jobs.length) logger.info(`${jobs.length} mail(s) queued for ${cid}/${regId}`);
});

// --- Kontrollansvarig utsedd ---------------------------------------------------
// When an email appears in a control's ansvarigaEmails (assigned under
// Inställningar → Användare or on the control itself), the appointee gets a
// welcome mail: what the role means, how to sign in (their address IS the
// permission), a link to the control in the admin, and the report page as
// link + QR so they can hand it to the control crew on race day.

exports.onControlWritten = onDocumentWritten('competitions/{cid}/controls/{ctrlId}', async (event) => {
  const { cid, ctrlId } = event.params;
  const before = event.data && event.data.before.exists ? event.data.before.data() : null;
  const after = event.data && event.data.after.exists ? event.data.after.data() : null;
  if (!after) return; // control deleted

  const norm = (arr) => (arr || []).map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
  const prev = new Set(norm(before && before.ansvarigaEmails));
  const added = [...new Set(norm(after.ansvarigaEmails))].filter(e => !prev.has(e));
  if (!added.length) return;

  const comp = await getComp(cid);
  if (!comp || comp.demo || comp.closed) return;

  const ctrlLabel = `kontroll ${after.nummer ?? '?'} · ${after.name || 'utan namn'}`;
  const ctrlUrl = `${APP_URL}/app/c/${cid}/controls/${ctrlId}`;
  const reportUrl = `${APP_URL}/k/${cid}/${ctrlId}`;
  const qrBase64 = (await QRCode.toBuffer(reportUrl, { width: 240, margin: 1 })).toString('base64');
  const replyTo = managementEmails(comp)[0] || undefined;

  const nameOf = (email) => {
    const hit = (after.ansvariga || []).find(a =>
      String(a && a.email || '').trim().toLowerCase() === email);
    return (hit && hit.name || '').trim();
  };

  await Promise.all(added.map(email => {
    const body = `
      <p>Hej ${esc(nameOf(email) || '')}!</p>
      <p>Du har utsetts till <strong>kontrollansvarig</strong> för
      <strong>${esc(ctrlLabel)}</strong> på ${esc(compLabel(comp))}.</p>
      <p>Som kontrollansvarig kan du se hela tävlingen i ESKIL och redigera din
      kontroll — uppgifter, poäng och instruktioner — samt öppna och stänga
      poängrapporteringen på tävlingsdagen.</p>
      <p>Logga in med just den här e-postadressen (<strong>${esc(email)}</strong>) —
      adressen är din behörighet. Ingen registrering behövs: du får en
      engångslänk via mail när du loggar in.</p>
      ${button(ctrlUrl, 'Öppna din kontroll i ESKIL')}
      <p style="margin-top:26px;"><strong>Rapportsidan för tävlingsdagen</strong><br>
      Poängen rapporteras från kontrollens rapportsida — den kräver ingen
      inloggning och funkar i mobilen. Skanna QR-koden eller öppna länken,
      och dela den bara med kontrollens funktionärer (adressen är hemlig):</p>
      <p style="margin:14px 0;"><img src="cid:report-qr" width="120" height="120" alt="QR till rapportsidan" style="display:block;border:1px solid #d2dde8;border-radius:8px;"></p>
      <p style="font-size:12px;color:#8a8a8a;word-break:break-all;">${esc(reportUrl)}</p>
    `;
    return queueMail({
      to: [email],
      ...(replyTo ? { replyTo } : {}),
      message: {
        subject: `Du är kontrollansvarig — ${ctrlLabel} (${compLabel(comp)})`,
        html: layout(comp, body, replyTo ? 'Svar på mailet går till tävlingsledningen.' : undefined),
        text: `Du har utsetts till kontrollansvarig för ${ctrlLabel} på ${compLabel(comp)}. `
          + `Logga in med ${email} på ${APP_URL} (engångslänk via mail). `
          + `Din kontroll: ${ctrlUrl} · Rapportsidan (hemlig, för tävlingsdagen): ${reportUrl}`,
        attachments: [{
          filename: 'rapportsida-qr.png',
          content: qrBase64,
          encoding: 'base64',
          cid: 'report-qr'
        }]
      }
    });
  }));
  logger.info(`Kontrollansvarig mail queued for ${added.join(', ')} (${cid}/${ctrlId})`);
});
