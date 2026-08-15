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
//  - utskick created                 → PM fan-out to every active registration

const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const QRCode = require('qrcode');
const { renderReceiptPdfBase64 } = require('./receipt-pdf');

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

const APP_URL = 'https://eskilscout.se';
const MAIL_COLLECTION = 'mail';
// Where the magic-link lands after sign-in. The action link is rewritten to
// eskilscout.se (its cert went live 2026-08-13) — Firebase Hosting serves the
// /__/auth/* handlers on the custom domain, so the whole flow stays on-brand.
const LOGIN_CONTINUE_URL = 'https://eskilscout.se/app';
const LOGIN_LINK_HOST = 'eskilscout.se';

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

// Authoritative paid status — the admin-only paidRefs array (mirror of
// utils.isPaymentPaid). The legacy per-payment paid flag is not trusted.
function isPaidRef(reg, payment) {
  return !!payment && (reg.paidRefs || []).includes(payment.reference);
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

// --- Outbound-mail rate limiting ----------------------------------------------
// Firestore rules deny all client access to `caps/**` (no match) so only these
// admin-SDK functions touch them. These daily caps bound the blast radius of
// the anonymous/self-service mail vectors (registration confirmations, PM
// fan-out, login links) against spam/relay abuse and Brevo quota exhaustion.
// App Check (reCAPTCHA v3) is ENFORCED on Firestore and Functions since
// 2026-08-13 and is the primary defence — these caps are the second line
// behind it. Bump them if a large legitimate day needs more headroom.
// Defaults for the mail rate-limit caps. Super-admin can override them in the
// config/system doc (ESKIL → Super-admin → Systemhubb) without a deploy.
const MAIL_DAILY_CAP = 800;         // transactional mails/day (confirmations, PM, …)
const LOGIN_DAILY_CAP = 150;        // login links/day (separate lane so spam can't starve logins)
const UTSKICK_RECIPIENT_CAP = 500;  // max recipients per single PM fan-out

// Read a cap from config/system, falling back to the constant if unset/invalid.
async function configuredCap(key, fallback) {
  try {
    const snap = await db.doc('config/system').get();
    const v = snap.exists ? snap.data()[key] : undefined;
    return (typeof v === 'number' && v > 0) ? v : fallback;
  } catch { return fallback; }
}

// Atomically reserve `n` sends against today's cap for a lane. Returns true if
// the whole batch fits (and reserves it), false if it would exceed. Fails
// OPEN on a transient infra error so a hiccup never blocks legitimate mail.
async function reserveMail(lane, n) {
  const cap = lane === 'login'
    ? await configuredCap('loginDailyCap', LOGIN_DAILY_CAP)
    : await configuredCap('mailDailyCap', MAIL_DAILY_CAP);
  const ref = db.doc(`caps/${lane}`);
  const today = new Date().toISOString().slice(0, 10);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.exists ? snap.data() : {};
      const count = d.day === today ? (d.count || 0) : 0;
      if (count + n > cap) return false;
      tx.set(ref, { day: today, count: count + n });
      return true;
    });
  } catch (e) {
    logger.warn('reserveMail transaction failed, allowing send', e);
    return true;
  }
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

  // Global backstop: bound total login links/day so an attacker cycling many
  // different addresses can't drain Brevo's quota (the per-email throttle only
  // limits a single address).
  if (!(await reserveMail('login', 1))) {
    throw new HttpsError('resource-exhausted', 'Tjänsten är tillfälligt överbelastad — försök igen om en stund.');
  }

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

// --- Radera mitt konto (GDPR) -------------------------------------------------
// Måste köras server-side: en användare får varken radera sitt eget
// users-dokument eller redigera tävlingar hen bara är medlem i (rules), och
// kontrollansvarig-listorna är append-only. Admin-SDK:n går förbi allt det.
//
// Två lägen: dryRun ger en sanningsenlig sammanställning av VAR kontot
// förekommer (det modalen visar), skarpt läge städar bort det och raderar
// kontot. Ensam administratör måste ange en ersättare per tävling — annars
// blir tävlingen omöjlig att administrera.

const lower = (s) => String(s || '').trim().toLowerCase();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Läser upp allt kontot rör vid. Returnerar både sammanställningen (till
// modalen) och de referenser städningen behöver, så inget läses två gånger.
async function accountFootprint(uid, email) {
  const comps = await db.collection('competitions').get();
  const rows = [];
  for (const doc of comps.docs) {
    const c = doc.data();
    const accessSnap = await db.doc(`competitions/${doc.id}/private/access`).get();
    const a = accessSnap.exists ? accessSnap.data() : {};

    const adminEmails = (a.adminEmails || c.adminEmails || []).map(lower);
    const adminUids = [...new Set([...(a.admins || []), ...(c.admins || [])])];
    const userEmails = (a.userEmails || c.userEmails || []).map(lower);
    const ekonomiEmails = (a.ekonomiEmails || []).map(lower);

    const isAdmin = adminEmails.includes(email) || adminUids.includes(uid);
    const isEkonomi = ekonomiEmails.includes(email);
    const isUser = userEmails.includes(email);
    const inManagement = (c.management || []).some(r => lower(r.email) === email);

    // Kontrollansvarig — bara värt att läsa när kontot rör tävlingen alls.
    const ansvarigControls = [];
    if (isAdmin || isEkonomi || isUser || inManagement) {
      const ctrls = await db.collection(`competitions/${doc.id}/controls`).get();
      for (const ct of ctrls.docs) {
        const metaSnap = await db.doc(`competitions/${doc.id}/controls/${ct.id}/private/meta`).get();
        const m = metaSnap.exists ? metaSnap.data() : {};
        const emails = (m.ansvarigaEmails || ct.data().ansvarigaEmails || []).map(lower);
        if (emails.includes(email)) {
          ansvarigControls.push({ id: ct.id, nummer: ct.data().nummer ?? null, name: ct.data().name || '' });
        }
      }
    }
    if (!isAdmin && !isEkonomi && !isUser && !inManagement && !ansvarigControls.length) continue;

    // "Ensam admin" = ingen ANNAN admin, varken via e-post eller uid.
    const otherAdminEmails = adminEmails.filter(e => e !== email);
    const otherAdminUids = adminUids.filter(u => u !== uid);
    rows.push({
      id: doc.id,
      name: c.name || '',
      shortName: c.shortName || '',
      role: isAdmin ? 'admin' : isEkonomi ? 'ekonomi' : isUser ? 'las' : null,
      inManagement,
      controls: ansvarigControls,
      soleAdmin: isAdmin && otherAdminEmails.length === 0 && otherAdminUids.length === 0,
      otherAdmins: otherAdminEmails,
      otherAdminCount: otherAdminEmails.length + otherAdminUids.length
    });
  }

  const reqSnap = await db.collection('competitionRequests').where('requestedBy', '==', uid).get();
  return { competitions: rows, requestCount: reqSnap.size, requestIds: reqSnap.docs.map(d => d.id) };
}

exports.deleteMyAccount = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Du måste vara inloggad.');
  const uid = req.auth.uid;
  const email = lower(req.auth.token.email);
  if (!email) throw new HttpsError('failed-precondition', 'Kontot saknar e-postadress.');

  const dryRun = !(req.data && req.data.confirm === true);
  const replacements = {};
  for (const [cid, val] of Object.entries((req.data && req.data.replacements) || {})) {
    const e = lower(val);
    if (e) replacements[String(cid)] = e;
  }

  // Systemets sista super-admin får inte försvinna — då kan ingen längre
  // godkänna tävlingar eller hantera användare.
  const meSnap = await db.doc(`users/${uid}`).get();
  const isSuper = meSnap.exists && meSnap.data().role === 'super-admin';
  if (isSuper) {
    const sa = await db.collection('users').where('role', '==', 'super-admin').get();
    if (sa.size <= 1) {
      throw new HttpsError('failed-precondition',
        'Du är systemets enda super-admin. Utse någon annan till super-admin först.');
    }
  }

  const fp = await accountFootprint(uid, email);
  const sole = fp.competitions.filter(c => c.soleAdmin);

  if (dryRun) {
    return {
      email,
      isSuperAdmin: isSuper,
      requestCount: fp.requestCount,
      competitions: fp.competitions.map(c => ({
        id: c.id, name: c.name, shortName: c.shortName, role: c.role,
        inManagement: c.inManagement, soleAdmin: c.soleAdmin,
        otherAdminCount: c.otherAdminCount, otherAdmins: c.otherAdmins,
        controls: c.controls
      }))
    };
  }

  // Skarpt läge: varje ensam-admin-tävling måste ha en giltig ersättare.
  const missing = sole.filter(c => !EMAIL_RE.test(replacements[c.id] || ''));
  if (missing.length) {
    throw new HttpsError('failed-precondition',
      `Ange en ny administratör för: ${missing.map(c => c.name || c.id).join(', ')}`);
  }

  for (const c of fp.competitions) {
    const accessRef = db.doc(`competitions/${c.id}/private/access`);
    const compRef = db.doc(`competitions/${c.id}`);
    const [accessSnap, compSnap] = await Promise.all([accessRef.get(), compRef.get()]);
    const a = accessSnap.exists ? accessSnap.data() : {};
    const comp = compSnap.exists ? compSnap.data() : {};

    const strip = (arr) => (arr || []).filter(x => lower(x) !== email);
    const stripObjs = (arr) => (arr || []).filter(o => lower(o && o.email) !== email);

    const nextAdminEmails = strip(a.adminEmails || comp.adminEmails);
    // Ersättaren läggs till INNAN kontot städas bort, så tävlingen aldrig
    // står utan administratör ens ett ögonblick.
    const repl = replacements[c.id];
    if (c.soleAdmin && repl && !nextAdminEmails.map(lower).includes(repl)) nextAdminEmails.push(repl);

    await accessRef.set({
      adminEmails: nextAdminEmails,
      userEmails: strip(a.userEmails || comp.userEmails),
      ekonomiEmails: strip(a.ekonomiEmails),
      users: stripObjs(a.users || comp.users),
      ekonomi: stripObjs(a.ekonomi),
      admins: (a.admins || comp.admins || []).filter(u => u !== uid)
    }, { merge: true });

    // Publika dokumentet: uid-listan och tävlingsledningens kontaktuppgifter.
    const compPatch = { admins: (comp.admins || []).filter(u => u !== uid) };
    if (Array.isArray(comp.management) && comp.management.some(r => lower(r.email) === email)) {
      // Samma linje som vid avslutad tävling: rollen kvar, personuppgifterna bort.
      compPatch.management = comp.management.map(r =>
        lower(r.email) === email ? { ...r, name: '', phone: '', email: '' } : r);
    }
    await compRef.update(compPatch);

    // Kontrollansvarig — listorna är append-only för klienter, admin-SDK:n
    // går förbi den spärren.
    for (const ct of c.controls) {
      const metaRef = db.doc(`competitions/${c.id}/controls/${ct.id}/private/meta`);
      const metaSnap = await metaRef.get();
      const m = metaSnap.exists ? metaSnap.data() : {};
      await metaRef.set({
        ansvariga: stripObjs(m.ansvariga),
        ansvarigaEmails: strip(m.ansvarigaEmails)
      }, { merge: true });
      await db.doc(`competitions/${c.id}/controls/${ct.id}`).update({
        ansvarigaEmails: strip((await db.doc(`competitions/${c.id}/controls/${ct.id}`).get()).data()?.ansvarigaEmails)
      }).catch(() => { /* fältet finns inte längre på nya kontroller */ });
    }
  }

  for (const rid of fp.requestIds) {
    await db.doc(`competitionRequests/${rid}`).delete().catch(() => {});
  }
  await db.doc(`users/${uid}`).delete().catch(() => {});
  try { await admin.auth().deleteUser(uid); }
  catch (e) { logger.warn(`Kunde inte radera auth-kontot ${uid}`, e); }

  logger.info(`Konto raderat: ${email} (${fp.competitions.length} tävlingar städade)`);
  return { ok: true, competitions: fp.competitions.length };
});

// --- Tävlingsförfrågningar ----------------------------------------------------
// Vanliga användare kan inte skapa tävlingar (firestore.rules) utan skickar en
// förfrågan. Här går mailen: ny förfrågan → alla super-admins; beslut →
// sökanden med super-adminens svar. Super-admins hämtas ur users-kollektionen
// via admin-SDK:n (bypassar rules).

async function superAdminEmails() {
  const snap = await db.collection('users').where('role', '==', 'super-admin').get();
  return snap.docs.map(d => (d.data().email || '').trim()).filter(Boolean);
}

const REQ_COMP = { shortName: 'Tävlingsförfrågan', organizer: 'ESKIL' };

exports.onCompetitionRequestCreated = onDocumentCreated('competitionRequests/{reqId}', async (event) => {
  const r = event.data && event.data.data();
  if (!r || r.status !== 'vantar') return;

  const to = await superAdminEmails();
  if (!to.length) { logger.warn('Ingen super-admin att mejla om tävlingsförfrågan'); return; }
  // Självbetjäningsvektor (vem som helst inloggad kan skapa en förfrågan) —
  // håll den innanför den globala mail-kvoten.
  if (!(await reserveMail('mail', to.length))) {
    logger.warn('Daily mail cap reached — hoppar över förfrågningsmail');
    return;
  }

  const body = `
    <p><strong>${esc(r.requestedByEmail || 'En användare')}</strong> har begärt att få skapa en ny tävling i ESKIL.</p>
    <p style="font-size:17px;font-weight:bold;margin:18px 0 4px;">${esc(r.name)}</p>
    ${r.date ? `<p style="margin:0 0 8px;">Datum: ${esc(r.date)}</p>` : ''}
    ${r.description ? `<p style="margin:0 0 8px;">${esc(r.description)}</p>` : ''}
    ${r.message ? `<p style="border-left:3px solid #d2dde8;padding-left:12px;color:#56544f;">${esc(r.message)}</p>` : ''}
    <p>Godkänner du förfrågan skapas tävlingen direkt med sökanden som administratör.
    Nekar du skapas ingen tävling — i båda fallen kan du skicka med ett svar.</p>
    ${button(`${APP_URL}/app/admin/requests`, 'Granska förfrågan')}
  `;
  await queueMail({
    to,
    ...(r.requestedByEmail ? { replyTo: r.requestedByEmail } : {}),
    message: {
      subject: `Tävlingsförfrågan: ${r.name}`,
      html: layout(REQ_COMP, body, 'Svar på mailet går till den som begärde tävlingen.'),
      text: `${r.requestedByEmail} har begärt en ny tävling: ${r.name}. Granska: ${APP_URL}/app/admin/requests`
    }
  });
  logger.info(`Förfrågningsmail köat till ${to.length} super-admin(s)`);
});

exports.onCompetitionRequestDecided = onDocumentUpdated('competitionRequests/{reqId}', async (event) => {
  const before = event.data && event.data.before.data();
  const after = event.data && event.data.after.data();
  if (!before || !after) return;
  // Bara övergången väntar → beslut ska mejla (inte varje senare redigering).
  if (before.status !== 'vantar' || after.status === 'vantar') return;
  if (!after.requestedByEmail) return;
  if (!(await reserveMail('mail', 1))) {
    logger.warn('Daily mail cap reached — hoppar över beslutsmail');
    return;
  }

  const approved = after.status === 'godkand';
  const body = approved ? `
    <p>Hej!</p>
    <p>Din förfrågan om tävlingen <strong>${esc(after.name)}</strong> är godkänd — tävlingen är skapad
    och du är administratör för den. Nu kan du fylla i resten: patruller, kontroller, anmälan och allt annat.</p>
    ${after.decisionMessage ? `<p style="border-left:3px solid #d2dde8;padding-left:12px;color:#56544f;">${esc(after.decisionMessage)}</p>` : ''}
    ${button(after.competitionId ? `${APP_URL}/app/c/${after.competitionId}` : `${APP_URL}/app`, 'Öppna tävlingen')}
  ` : `
    <p>Hej!</p>
    <p>Din förfrågan om tävlingen <strong>${esc(after.name)}</strong> har tyvärr inte godkänts,
    och någon tävling har därför inte skapats.</p>
    ${after.decisionMessage ? `<p style="border-left:3px solid #d2dde8;padding-left:12px;color:#56544f;">${esc(after.decisionMessage)}</p>` : ''}
    <p>Har du frågor går det bra att svara på det här mailet.</p>
  `;
  await queueMail({
    to: [after.requestedByEmail],
    ...(after.decidedBy ? { replyTo: after.decidedBy } : {}),
    message: {
      subject: approved ? `Godkänd: ${after.name}` : `Svar på din tävlingsförfrågan: ${after.name}`,
      html: layout(REQ_COMP, body, after.decidedBy ? 'Svar på mailet går till ESKIL:s administratör.' : undefined),
      text: approved
        ? `Din förfrågan om ${after.name} är godkänd. Öppna tävlingen: ${APP_URL}/app`
        : `Din förfrågan om ${after.name} godkändes inte. ${after.decisionMessage || ''}`
    }
  });
  logger.info(`Beslutsmail köat till ${after.requestedByEmail} (${after.status})`);
});

// --- Självbetjäning: skicka ändringslänken igen --------------------------------
// Kårledare som tappat bekräftelsemailet begär om sin ändringslänk från
// anmälningssidan. Svaret är ALLTID neutralt ok — det får aldrig gå att
// enumerera vilka adresser som har anmälningar. Dubbelt strypt: per adress
// (resendRequests/{email}, ingen rules-match så bara admin-SDK når den) och
// mot den globala mail-lanen. Throttlen tas även för adresser utan träff,
// så svarstid/kvot inte läcker om adressen finns.

const RESEND_MIN_INTERVAL_MS = 60 * 1000; // 1 begäran/minut per adress
const RESEND_MAX_PER_DAY = 5;

exports.resendManageLink = onCall(async (req) => {
  const email = String((req.data && req.data.email) || '').trim().toLowerCase();
  const cid = String((req.data && req.data.cid) || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !cid || cid.length > 64 || /[/.]/.test(cid)) {
    throw new HttpsError('invalid-argument', 'Ogiltig begäran.');
  }

  const today = new Date().toISOString().slice(0, 10);
  const throttleRef = db.doc(`resendRequests/${email}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(throttleRef);
    const d = snap.exists ? snap.data() : {};
    const now = Date.now();
    if (d.lastSentAt && now - d.lastSentAt < RESEND_MIN_INTERVAL_MS) {
      throw new HttpsError('resource-exhausted', 'En begäran gjordes nyss — vänta en minut och försök igen.');
    }
    const count = d.day === today ? (d.count || 0) : 0;
    if (count >= RESEND_MAX_PER_DAY) {
      throw new HttpsError('resource-exhausted', 'För många försök idag — kontakta tävlingsledningen direkt.');
    }
    tx.set(throttleRef, { lastSentAt: now, day: today, count: count + 1 });
  });

  // Allt nedanför svarar neutralt ok oavsett utfall.
  const comp = await getComp(cid);
  if (!comp || comp.demo || comp.closed) return { ok: true };

  const snap = await db.collection(`competitions/${cid}/registrations`)
    .where('contact.email', '==', email).get();
  const regs = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(r => !r.cancelled && !r.imported);
  if (!regs.length) {
    logger.info(`resendManageLink: ingen träff för adressen på ${cid} (neutralt ok)`);
    return { ok: true };
  }

  if (!(await reserveMail('mail', regs.length))) {
    logger.warn('Daily mail cap reached — skipping resend');
    return { ok: true };
  }

  const replyTo = managementEmails(comp)[0] || undefined;
  for (const reg of regs) {
    const url = manageUrl(cid, reg.id);
    const body = `
      <p>Hej ${esc(reg.contact?.name || '')}!</p>
      <p>Här är ändringslänken till er anmälan för <strong>${esc(reg.kar || '')}</strong>
      till <strong>${esc(compLabel(comp))}</strong> — någon begärde att få den skickad igen
      från anmälningssidan.</p>
      ${patrolListHtml(reg)}
      ${button(url, 'Visa och ändra er anmälan')}
      <p style="font-size:13px;color:#8a8a8a;">Begärde ni inte det här mailet kan ni tryggt ignorera det —
      länken har inte delats med någon annan.</p>
    `;
    await queueMail({
      to: [email],
      ...(replyTo ? { replyTo } : {}),
      message: {
        subject: `Er ändringslänk — ${compLabel(comp)}`,
        html: layout(comp, body, replyTo ? 'Svar på mailet går till tävlingsledningen.' : undefined),
        text: `Ändringslänk till er anmälan (${reg.kar || ''}) för ${compLabel(comp)}: ${url}`
      }
    });
  }
  logger.info(`resendManageLink: ${regs.length} mail köade för ${cid}`);
  return { ok: true };
});

// --- Meddelanden till ESKIL (kontaktformuläret på /kontakt) -------------------
// Formuläret är öppet för vem som helst — App Check är förstahandsförsvaret,
// de här taken är andra linjen. Skrivningen går via en funktion i stället för
// direkt mot Firestore: rules kan inte räkna anrop, och en anonymt skrivbar
// toppnivåkollektion vore en öppen kran rakt in i databasen.
const FEEDBACK_COMP = { shortName: 'Meddelande till ESKIL', organizer: 'ESKIL' };
const FEEDBACK_MIN_INTERVAL_MS = 60 * 1000;   // ett meddelande/minut per adress
const FEEDBACK_MAX_PER_DAY = 10;
const FEEDBACK_MAX_LEN = 4000;

const FEEDBACK_KINDS = {
  forslag: 'Förbättringsförslag',
  fel: 'Något fungerar inte',
  fraga: 'Fråga',
  annat: 'Annat'
};

exports.sendFeedback = onCall(async (req) => {
  const d = req.data || {};
  const email = String(d.email || '').trim().toLowerCase();
  const name = String(d.name || '').trim().slice(0, 120);
  const kind = FEEDBACK_KINDS[d.kind] ? String(d.kind) : 'annat';
  const message = String(d.message || '').trim();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'Ange en giltig e-postadress så vi kan svara.');
  }
  if (message.length < 10) {
    throw new HttpsError('invalid-argument', 'Skriv några rader till så vi förstår vad du menar.');
  }
  if (message.length > FEEDBACK_MAX_LEN) {
    throw new HttpsError('invalid-argument', 'Meddelandet är för långt — korta ner det lite.');
  }

  const today = new Date().toISOString().slice(0, 10);
  const throttleRef = db.doc(`feedbackRequests/${email}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(throttleRef);
    const t = snap.exists ? snap.data() : {};
    const now = Date.now();
    if (t.lastSentAt && now - t.lastSentAt < FEEDBACK_MIN_INTERVAL_MS) {
      throw new HttpsError('resource-exhausted', 'Du skickade nyss ett meddelande — vänta en minut.');
    }
    const count = t.day === today ? (t.count || 0) : 0;
    if (count >= FEEDBACK_MAX_PER_DAY) {
      throw new HttpsError('resource-exhausted', 'För många meddelanden idag. Försök igen imorgon.');
    }
    tx.set(throttleRef, { lastSentAt: now, day: today, count: count + 1 });
  });

  const ref = await db.collection('feedback').add({
    at: FieldValue.serverTimestamp(),
    lastAt: FieldValue.serverTimestamp(),
    email, name, kind, message,
    // Inloggad avsändare: super-admin ser vem det är utan att behöva gissa.
    // Adressen ovan är den hen bad oss svara på och kan vara en annan.
    accountEmail: (req.auth && req.auth.token && req.auth.token.email) || null,
    status: 'ny',
    replyCount: 0
  });
  logger.info(`Meddelande till ESKIL mottaget (${kind}) — ${ref.id}`);

  // Notisen till super-admins. Meddelandet står med i mailet så de ser vad
  // det gäller direkt, men det finns INGET Reply-To: svaret skrivs i ESKIL
  // så det går ut från ESKIL och inte från någons privata adress.
  const to = await superAdminEmails();
  if (!to.length) { logger.warn('Ingen super-admin att notifiera om meddelandet'); return { ok: true }; }
  if (!(await reserveMail('mail', to.length))) {
    logger.warn('Daily mail cap reached — hoppar över notis om meddelande');
    return { ok: true };
  }

  const body = `
    <p><strong>${esc(name || email)}</strong> har skickat ett meddelande till ESKIL.</p>
    <p style="margin:0 0 4px;"><span style="display:inline-block;background:#e8eef4;color:#003660;font-size:12px;font-weight:bold;padding:3px 10px;border-radius:99px;">${esc(FEEDBACK_KINDS[kind])}</span></p>
    <p style="border-left:3px solid #d2dde8;padding-left:12px;color:#56544f;white-space:pre-wrap;">${esc(message)}</p>
    <p style="font-size:13px;color:#8a8a8a;">Svara till: ${esc(email)}</p>
    ${button(`${APP_URL}/app/admin/feedback`, 'Läs och svara i ESKIL')}
    <p style="font-size:13px;color:#8a8a8a;">Svara inte på det här mailet — skriv svaret i ESKIL,
    så går det ut därifrån i stället för från din egen adress.</p>
  `;
  await queueMail({
    to,
    message: {
      subject: `${FEEDBACK_KINDS[kind]}: ${message.slice(0, 60)}${message.length > 60 ? '…' : ''}`,
      html: layout(FEEDBACK_COMP, body, 'Mailet går inte att svara på — svara i ESKIL.'),
      text: `${name || email} (${email}) skrev till ESKIL [${FEEDBACK_KINDS[kind]}]:\n\n${message}\n\nSvara i ESKIL: ${APP_URL}/app/admin/feedback`
    }
  });
  return { ok: true };
});

// Super-admin skriver svaret i ESKIL — här går det ut som mail FRÅN ESKIL.
// Inget Reply-To: svararens egen adress ska aldrig lämna systemet, och den
// som får svaret hänvisas till formuläret om hen vill skriva igen.
exports.onFeedbackReplyCreated = onDocumentCreated('feedback/{fbId}/replies/{replyId}', async (event) => {
  const { fbId } = event.params;
  const reply = event.data && event.data.data();
  if (!reply || !reply.text) return;

  const parent = await db.doc(`feedback/${fbId}`).get();
  const fb = parent.exists ? parent.data() : null;
  if (!fb || !fb.email) { logger.warn(`Svar på okänt meddelande ${fbId}`); return; }

  await parent.ref.update({
    status: 'besvarad',
    lastAt: FieldValue.serverTimestamp(),
    replyCount: FieldValue.increment(1)
  });

  if (!(await reserveMail('mail', 1))) {
    logger.warn('Daily mail cap reached — svaret ligger kvar i ESKIL men mailas inte');
    return;
  }

  const body = `
    <p>Hej ${esc(fb.name || '')}!</p>
    <p>Du skrev till ESKIL${fb.kind && FEEDBACK_KINDS[fb.kind] ? ` (${esc(FEEDBACK_KINDS[fb.kind])})` : ''}. Här är svaret:</p>
    <p style="border-left:3px solid #003660;padding-left:14px;white-space:pre-wrap;">${esc(reply.text)}</p>
    <p style="font-size:13px;color:#8a8a8a;border-top:1px solid #e8eef4;padding-top:12px;">Ditt meddelande:</p>
    <p style="font-size:13px;color:#8a8a8a;white-space:pre-wrap;">${esc(fb.message || '')}</p>
    ${button(`${APP_URL}/kontakt`, 'Skriv till oss igen')}
  `;
  await queueMail({
    to: [fb.email],
    message: {
      subject: 'Svar från ESKIL',
      html: layout(FEEDBACK_COMP, body, 'Mailet går inte att svara på — använd formuläret om du vill skriva igen.'),
      text: `Svar från ESKIL:\n\n${reply.text}\n\nSkriv till oss igen: ${APP_URL}/kontakt`
    }
  });
  logger.info(`Svar på meddelande ${fbId} köat till ${fb.email}`);
});

exports.onRegistrationCreated = onDocumentCreated('competitions/{cid}/registrations/{regId}', async (event) => {
  const { cid, regId } = event.params;
  const reg = event.data && event.data.data();
  if (!reg || !reg.contact || !reg.contact.email) return;
  if (reg.imported) return; // backup restore — never re-send confirmations

  const comp = await getComp(cid);
  if (!comp || comp.demo) return;

  // Anonymous registration create is an open door — bound the confirmation
  // mail so it can't be scripted into a branded spam relay / quota-drain.
  if (!(await reserveMail('mail', 1))) {
    logger.warn(`Daily mail cap reached — skipping confirmation for ${cid}/${regId}`);
    return;
  }

  const unpaid = (reg.payments || []).filter(p => !isPaidRef(reg, p));
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
  if (after.imported) return; // backup-restored/archived reg — never mail its (old) contact

  const comp = await getComp(cid);
  if (!comp || comp.demo) return;

  const jobs = [];

  // 1) Payments newly ticked off in the admin-only paidRefs → receipt with
  // PDF attached. Driven by paidRefs (not the client-writable paid flag) so
  // a manage-link holder cannot self-issue an official receipt.
  const beforeRefs = new Set(before.paidRefs || []);
  const newlyPaid = (after.payments || [])
    .filter(p => isPaidRef(after, p) && !beforeRefs.has(p.reference));
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

  // 1b) Payment reminder requested by the kassör (reminderRequestedAt stamped
  // by the admin UI) → mail the contact the unpaid references with the manage
  // link, and stamp reminderSentAt back so the UI shows when.
  if (after.reminderRequestedAt && after.reminderRequestedAt !== before.reminderRequestedAt) {
    const unpaid = (after.payments || []).filter(p => !isPaidRef(after, p));
    if (!after.cancelled && unpaid.length && after.contact && after.contact.email) {
      const replyTo = managementEmails(comp)[0] || undefined;
      const url = manageUrl(cid, regId);
      const totalDue = unpaid.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const body = `
        <p>Hej ${esc(after.contact.name || '')}!</p>
        <p>En vänlig påminnelse: er anmälan${after.kar ? ` för <strong>${esc(after.kar)}</strong>` : ''} till
        <strong>${esc(compLabel(comp))}</strong> har betalningar som ännu inte prickats av:</p>
        <ul style="padding-left:18px;">
          ${unpaid.map(p => `<li><strong>${Number(p.amount) || 0} kr</strong> — referens <strong style="font-family:monospace;">${esc(p.reference || '')}</strong></li>`).join('')}
        </ul>
        <p>Totalt att betala: <strong>${totalDue} kr</strong>. Betalningsinstruktionerna finns på er
        anmälningssida — ange referensen vid betalning så prickas den av. Har ni redan betalt de
        senaste dagarna kan ni bortse från denna påminnelse.</p>
        ${button(url, 'Visa anmälan och betalningsinstruktioner')}
      `;
      jobs.push(queueMail({
        to: [after.contact.email],
        ...(replyTo ? { replyTo } : {}),
        message: {
          subject: `Påminnelse: betalning för ${compLabel(comp)}`,
          html: layout(comp, body, replyTo ? 'Svar på mailet går till tävlingsledningen.' : undefined),
          text: `Påminnelse: ${unpaid.map(p => `${p.amount} kr (ref ${p.reference})`).join(', ')} är inte betalt för ${compLabel(comp)}. Instruktioner: ${url}`
        }
      }).then(() => event.data.after.ref.update({ reminderSentAt: FieldValue.serverTimestamp() })));
    }
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
      const paid = (after.payments || []).filter(p => isPaidRef(after, p)).reduce((s, p) => s + (Number(p.amount) || 0), 0);
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

// kontrollansvariga (ansvarigaEmails/ansvariga) live in the control's
// member-only private/meta subdoc (Fas 3c), so the welcome-mail trigger fires
// on that doc. The control doc is fetched for the label + imported guard.
exports.onControlMetaWritten = onDocumentWritten('competitions/{cid}/controls/{ctrlId}/private/meta', async (event) => {
  const { cid, ctrlId } = event.params;
  const before = event.data && event.data.before.exists ? event.data.before.data() : null;
  const after = event.data && event.data.after.exists ? event.data.after.data() : null;
  if (!after) return; // meta deleted

  const norm = (arr) => (arr || []).map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
  // `welcomed` records who has already had a welcome mail — the migration
  // seeds it with the existing ansvariga so a data move never re-welcomes
  // them. Only genuinely new, never-welcomed emails get a mail.
  const welcomed = new Set(norm(after.welcomed));
  const added = [...new Set(norm(after.ansvarigaEmails))].filter(e => !welcomed.has(e));
  if (!added.length) return;

  const ctrlSnap = await db.doc(`competitions/${cid}/controls/${ctrlId}`).get();
  const ctrl = ctrlSnap.exists ? ctrlSnap.data() : null;
  if (!ctrl) return;
  if (!before && ctrl.imported) return; // backup restore — no welcome mail

  const comp = await getComp(cid);
  if (!comp || comp.demo || comp.closed) return;

  const ctrlLabel = `kontroll ${ctrl.nummer ?? '?'} · ${ctrl.name || 'utan namn'}`;
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
  // Mark them welcomed so a later meta write (or migration) never re-mails.
  await event.data.after.ref.set(
    { welcomed: [...welcomed, ...added] }, { merge: true });
  logger.info(`Kontrollansvarig mail queued for ${added.join(', ')} (${cid}/${ctrlId})`);
});

// --- PM-utskick till anmälda kårer ---------------------------------------------
// An admin composes ämne + text in the Anmälan tab; the client creates a doc
// in competitions/{cid}/utskick (rules: admin-only, exact keys). This trigger
// fans it out: one mail per active registration (skipping cancelled and those
// without a contact email), each with its own secret manage link, and stamps
// sentAt + recipients back on the utskick doc as the receipt the UI shows.

exports.onUtskickCreated = onDocumentCreated('competitions/{cid}/utskick/{utskickId}', async (event) => {
  const { cid, utskickId } = event.params;
  const utskick = event.data && event.data.data();
  if (!utskick || !(utskick.subject || '').trim() || !(utskick.body || '').trim()) return;

  const comp = await getComp(cid);
  if (!comp || comp.demo) return;

  const regsSnap = await db.collection(`competitions/${cid}/registrations`).get();
  let regs = regsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(r => !r.cancelled && r.contact && (r.contact.email || '').trim());

  // Bound a single fan-out, and reserve the batch against the daily cap, so a
  // PM can never be scripted into a mass mail relay / quota-drain.
  const recipientCap = await configuredCap('utskickRecipientCap', UTSKICK_RECIPIENT_CAP);
  if (regs.length > recipientCap) {
    logger.warn(`Utskick ${utskickId} has ${regs.length} recipients — capping at ${recipientCap} (${cid})`);
    regs = regs.slice(0, recipientCap);
  }
  if (!regs.length) return;
  if (!(await reserveMail('mail', regs.length))) {
    logger.warn(`Daily mail cap reached — skipping utskick ${utskickId} fan-out (${cid})`);
    await event.data.ref.update({ sentAt: FieldValue.serverTimestamp(), recipients: 0, capped: true });
    return;
  }

  const replyTo = managementEmails(comp)[0] || undefined;
  const bodyHtml = esc(utskick.body).replaceAll('\n', '<br>');

  await Promise.all(regs.map(r => {
    const url = manageUrl(cid, r.id);
    const html = layout(comp, `
      <div style="white-space:normal;">${bodyHtml}</div>
      ${button(url, 'Visa er anmälan')}
      <p style="font-size:13px;color:#8a8a8a;">Ni får detta utskick som anmälningsansvarig${r.kar ? ' för ' + esc(r.kar) : ''}.</p>
    `, replyTo ? 'Svar på mailet går till tävlingsledningen.' : undefined);
    return queueMail({
      to: [r.contact.email.trim()],
      ...(replyTo ? { replyTo } : {}),
      message: {
        subject: utskick.subject,
        html,
        text: `${utskick.body}\n\nEr anmälan: ${url}`
      }
    });
  }));

  await event.data.ref.update({
    sentAt: FieldValue.serverTimestamp(),
    recipients: regs.length
  });
  logger.info(`Utskick ${utskickId} queued to ${regs.length} recipient(s) (${cid})`);
});
