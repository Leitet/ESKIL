// Autentisering för MCP-servern.
//
// ADRESSEN ÄR HEMLIGHETEN: /mcp/<cid>/<nyckel>. Samma idiom som resten av
// ESKIL (/k/<cid>/<ctrlId>, /a/<cid>/<regId>, /s/<cid>/<patrolId>/<token>) och
// ett medvetet val, inte en genväg — Claude.ai:s webbkoppling kan inte sätta en
// Authorization-header alls, bara OAuth, medan Claude Code och Desktop kan.
// Ska en kårledare kunna koppla in det oavsett klient måste hemligheten ligga i
// URL:en. Priset är att adressen hamnar i klientens konfigurationsfil och i
// eventuella loggar; därför är nyckeln återkallningsbar och tävlingsbunden.
//
// Att cid står i klartext i adressen är avsiktligt: det är inte en hemlighet
// (tävlingssidan /t är publik), och det gör att en nyckel kan verifieras med EN
// dokumentläsning i stället för en uppräkning av alla tävlingar.
//
// NYCKELN LAGRAS BARA SOM HASH. Skälet är en escalation jag mätte i reglerna:
// `competitions/{cid}/private/{doc}` har `allow read: if isCompMember(cid)` —
// alltså läsbar för VARJE funktionär, inte bara admin. En nyckel i klartext där
// hade låtit en vanlig medlem läsa ut den och sedan skriva som admin via
// servern. En hash ger dem ingenting.

const crypto = require('crypto');
const admin = require('firebase-admin');

const NYCKEL_DOK = 'mcp';           // competitions/{cid}/private/mcp
const PREFIX = 'eskil_';
// 32 byte base64url ≈ 43 tecken. Räcker gott: en gissning per läsning mot en
// endpoint som svarar 401 ger ingen praktisk väg in.
const BYTES = 32;

/** Slumpar en ny nyckel. Returneras EN gång — bara hashen sparas. */
function myntaNyckel() {
  return PREFIX + crypto.randomBytes(BYTES).toString('base64url');
}

function hasha(nyckel) {
  return crypto.createHash('sha256').update(String(nyckel)).digest('hex');
}

/**
 * Jämför två hashar utan att läcka via svarstid. crypto.timingSafeEqual kastar
 * om längderna skiljer, så längden kontrolleras först — den är konstant för
 * sha256 och avslöjar därför inget.
 */
function likaHash(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * Plockar { cid, nyckel } ur sökvägen. Tolererar att Hosting-rewriten och en
 * direkt funktionsadress ger olika prefix:
 *   /mcp/<cid>/<nyckel>   (via hosting)
 *   /<cid>/<nyckel>       (funktionen direkt)
 */
function tolkaSokvag(sokvag) {
  const delar = String(sokvag || '').split('/').filter(Boolean);
  if (delar[0] === 'mcp') delar.shift();
  if (delar.length < 2) return null;
  return { cid: delar[0], nyckel: delar[1] };
}

/**
 * Verifierar nyckeln och returnerar tävlingens kontext.
 *
 * @returns { ok: true, cid, comp } eller { ok: false, status, meddelande }
 */
async function verifiera(sokvag) {
  const tolkad = tolkaSokvag(sokvag);
  if (!tolkad) {
    return { ok: false, status: 401, meddelande: 'Adressen saknar tävling och nyckel.' };
  }
  const { cid, nyckel } = tolkad;
  if (!nyckel.startsWith(PREFIX)) {
    return { ok: false, status: 401, meddelande: 'Ogiltig nyckel.' };
  }

  const db = admin.firestore();
  const [nyckelSnap, compSnap] = await Promise.all([
    db.doc(`competitions/${cid}/private/${NYCKEL_DOK}`).get(),
    db.doc(`competitions/${cid}`).get()
  ]);

  // SAMMA svar för "tävlingen finns inte", "ingen nyckel skapad" och "fel
  // nyckel". Skillnaden hade gjort endpointen till ett orakel som avslöjar
  // vilka tävlings-id som finns och vilka som har MCP påslaget.
  const avvisa = { ok: false, status: 401, meddelande: 'Ogiltig nyckel.' };
  if (!compSnap.exists || !nyckelSnap.exists) return avvisa;

  const d = nyckelSnap.data() || {};
  if (!d.hash || !likaHash(d.hash, hasha(nyckel))) return avvisa;
  if (d.revokedAt) return avvisa;

  const comp = compSnap.data() || {};
  // En avslutad tävling är läsbar men oföränderlig för alla utom admin — och
  // stängningen sveper personuppgifterna. Att låta en MCP skriva där hade
  // kringgått både.
  if (comp.closed) {
    return { ok: false, status: 403, meddelande: 'Tävlingen är avslutad och kan inte ändras.' };
  }
  // Demotävlingen nekar varje skrivning i reglerna. Att svara med ett tydligt
  // besked är hela mönstret från report.js och station.js: ett demo som svarar
  // PERMISSION_DENIED är värre än inget demo.
  if (comp.demo) {
    return { ok: false, status: 403, meddelande: 'Det här är demotävlingen. Den går att utforska men inte att ändra.' };
  }

  return { ok: true, cid, comp };
}

/**
 * Stämplar att nyckeln använts, men HÖGST en gång per timme.
 * En skrivning per anrop hade betalat en Firestore-write för varje
 * verktygslistning en LLM gör — och de görs ofta. Samma strypningsresonemang
 * som kontrollernas beacon.
 */
async function stamplaAnvand(cid, tidigare) {
  const nu = Date.now();
  const senast = tidigare?.lastUsedAt?.toMillis?.() ?? 0;
  if (nu - senast < 3600 * 1000) return;
  await admin.firestore().doc(`competitions/${cid}/private/${NYCKEL_DOK}`)
    .set({ lastUsedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true })
    .catch(() => { /* en utebliven stämpel får aldrig stoppa anropet */ });
}

module.exports = { myntaNyckel, hasha, verifiera, stamplaAnvand, tolkaSokvag, NYCKEL_DOK, PREFIX };
