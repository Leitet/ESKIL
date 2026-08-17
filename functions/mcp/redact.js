// Redaktionslagret — det som gör att MCP:n kan SÄTTA personuppgifter men aldrig
// LÄSA UT dem.
//
// ═══ REGELN ═══
// Ett värde får lämna servern i klartext bara om båda villkoren håller:
//   (a) det finns kod som redan visar exakt det värdet för allmänheten — på /t,
//       i en publik resultatlista eller på en sida utan inloggning, OCH
//   (b) värdet har en sluten värdemängd: tal, boolean, tidsstämpel, koordinat
//       eller ett uppräkningsvärde.
// Allt annat svarar "(ifyllt)" eller "(saknas)". Ingenting annat.
//
// FRITEXT ÄR DELAD, och gränsen är VAD TEXTEN HANDLAR OM — inte att den är
// fritext:
//   • INNEHÅLL om banan och tävlingen är läsbart med skrubbning: kontrollernas
//     instructions och placement, utslagsfrågan, tävlingens description. Ett
//     produktbeslut, så att modellen kan korrekturläsa och förbättra texter.
//     RESIDUALRISKEN ÄR PERSONNAMN: mönster hittar telefonnummer och
//     e-postadresser, men "Anna står på kontroll 3" går inte att upptäcka. Den
//     begränsningen MÅSTE stå uttryckligen i /integritet.
//   • ANTECKNINGAR OM PERSONER är alltid dolda, hur mycket fritext de än är:
//     utgatt.note (hälsouppgift om ett barn), generalInfo (placeholdern ber om
//     "ansvarig vid olycka"), places[].note ("Markägare Nils: 070-…"),
//     controls.notering, patrols.notering, private/handover.text. Här räddar
//     skrubbningen bara numret, aldrig namnet.
//
// ═══ TRE FÖLJDER, som gör regeln tillämpbar utan att fråga någon ═══
//
// 1. KLASSEN ÄRVS ALDRIG NEDÅT. Ett läsbart objekt ger sina barn ingenting.
//    Varje nivå har sin EGEN lista. Den första versionen av den här filen
//    rekurserade inte, och då kom `registration.methods[].number` (kassörens
//    privata mobil), `utgatt.note` ("Elsa svimmade, hämtad med ambulans"),
//    `instructions[].text`, `places[].note` och `startFinish.start.note` ut i
//    KLARTEXT — ur den funktion som ÄR löftet. Regressionstestat.
//
// 2. LISTAN HÄRLEDS UR SKRIVKODEN, aldrig ur minnet. Första versionen klassade
//    `place`, `number`, `maxPoints`, `sort`, `namn`, `ikon`, `farg` — fälten
//    heter `location`, `nummer`, `maxPoang`, `kind`, `name`, `icon`, `color`.
//    Allt föll åt säkra sidan, men bara av tur: felet syns som att modellen
//    "inte hittar kontrollnummer", och frestelsen blir då att vidga listan i
//    stället för att härleda om den.
//
// 3. "IFYLLT/SAKNAS" ÄR BINÄRT. Ingen längd, ingen mask, ingen sista siffra,
//    inget ANTAL i en array, ingen tidsstämpel per fält, inget eko av ett
//    normaliserat värde, och inget svar som skiljer "lades till" från "fanns
//    redan". Ett antal ÄR ett orakel: e-postlistorna dedupas skiftlägesokänsligt
//    i onControlMetaWritten, så en växande längd bekräftar en gissad adress.
//
// Under regeln, aldrig i stället för den: en POSITIV sökvägs-allowlist med
// default-deny (admin-SDK:n går förbi firestore.rules HELT — tool-gränsen är
// det ENDA lagret, inte det andra), och en utgående mönsterskrubbning av varje
// strängblad som ett nät.

// ═══ Lager 2: mönsterskrubbning ═══════════════════════════════════════════

const EPOST = /[A-Za-z0-9._%+-]+@[A-Za-z0-9À-ÿ.-]+\.[A-Za-zÀ-ÿ]{2,}/g;

// Punkten är UTESLUTEN ur teckenklassen med flit: koordinater skrivs
// "56.6712, 16.3251" och måste vara läsbara — de är hela underlaget för att
// lägga ut en bana. Svenska nummer skrivs med mellanslag och bindestreck.
// Mönstret kräver inledande + / 00 / 0, så datum ("2026-09-18") matchar inte.
const TELEFON = /(?:\+\d|00\d|\b0\d)[\d\s()-]{5,}\d/g;

const siffror = (s) => (String(s).match(/\d/g) || []).length;

/** Stryker telefonnummer och e-postadresser ur fri text. Idempotent. */
function skrubba(text) {
  if (typeof text !== 'string' || !text) return text;
  let ut = text.replace(EPOST, '(e-postadress borttagen)');
  ut = ut.replace(TELEFON, (m) => {
    const n = siffror(m);
    // 7–15 siffror är ett telefonnummer. Färre är ett kontrollnummer, en poäng
    // eller ett klockslag; fler är inget nummer någon ringer.
    return (n < 7 || n > 15) ? m : '(telefonnummer borttaget)';
  });
  return ut;
}

// ═══ Lager 1: klassificering ══════════════════════════════════════════════

const OPPEN = 'oppen';      // värdet får läsas (sluten värdemängd + redan publikt)
const DOLD = 'dold';        // bara "(ifyllt)" / "(saknas)" — BINÄRT
const ALDRIG = 'aldrig';    // nyckeln försvinner helt ur svaret

/**
 * BINÄR närvaro. Inget antal, ingen längd, ingen typ.
 *
 * Att en array här inte får avslöja sin längd är inte överdrift: e-postlistor
 * dedupas skiftlägesokänsligt, så "listan växte" bekräftar att den gissade
 * adressen var ny. Med en gissning per anrop ÄR bekräftelsen utläsningen.
 */
function narvaro(v) {
  const tomt = v === undefined || v === null || v === ''
    || (Array.isArray(v) && v.length === 0)
    || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
  return tomt ? '(saknas)' : '(ifyllt)';
}

/**
 * Maskerar rekursivt.
 *
 * @param varde    rådatat ur Firestore
 * @param klasser  { falt: OPPEN | DOLD | ALDRIG | { ...underklasser } }
 *                 Ett OBJEKT som klass betyder "gå ner en nivå med den här
 *                 listan". Objekt och arrayer får ALDRIG klassen OPPEN — då
 *                 skulle barnen ärva läsbarhet, vilket är följd 1 ovan.
 */
function maskera(varde, klasser) {
  if (Array.isArray(varde)) return varde.map(v => maskera(v, klasser));
  if (!varde || typeof varde !== 'object') {
    return typeof varde === 'string' ? skrubba(varde) : varde;
  }
  const ut = {};
  for (const [k, v] of Object.entries(varde)) {
    // DEFAULT-DENY: ett fält som inte står i listan är dolt. Ett nytt fält i
    // datamodellen ska falla åt säkra sidan utan att någon behöver minnas det.
    const klass = Object.prototype.hasOwnProperty.call(klasser, k) ? klasser[k] : DOLD;
    if (klass === ALDRIG) continue;
    if (klass === DOLD) { ut[k] = narvaro(v); continue; }
    if (klass && typeof klass === 'object') { ut[k] = maskera(v, klass); continue; }
    // OPPEN: bara skalärer och strängar hamnar här. Ett objekt med klassen
    // OPPEN vore ett fel i listan — maskera det som dolt hellre än att gissa.
    if (v && typeof v === 'object') { ut[k] = narvaro(v); continue; }
    ut[k] = typeof v === 'string' ? skrubba(v) : v;
  }
  return ut;
}

// ═══ Klasslistorna, härledda ur skrivkoden ════════════════════════════════
// Sökhänvisningarna står kvar med flit: nästa läsare ska kunna kontrollera
// listan mot koden i stället för att lita på den.

// competitions/{cid} — allow read: if true (firestore.rules:271)
const TAVLING = {
  // Grunduppgifter: publiceras på /t och på landningssidan (listAllCompetitions
  // körs oautentiserat). Sluten värdemängd eller redan publikt.
  name: OPPEN, shortName: OPPEN, year: OPPEN, date: OPPEN,
  location: OPPEN,                    // competition-settings.js:190 — INTE "place"
  organizer: OPPEN,                   // arrangerande kår, inte en person
  district: OPPEN, slug: OPPEN,
  demo: OPPEN, closed: OPPEN,
  publicScores: OPPEN, publicControls: OPPEN, controlsAutoReleased: OPPEN,
  anonymousControls: OPPEN, selfStart: OPPEN, selfFinish: OPPEN,
  autoFinish: OPPEN, fieldMessaging: OPPEN, etaDwellMinutes: OPPEN,
  copiedFrom: OPPEN, lastBackupAt: OPPEN,

  // Tävlingsbeskrivningen publiceras på /t och handlar om arrangemanget.
  // Läsbar med skrubbning, så modellen kan korrekturläsa den.
  description: OPPEN,
  // generalInfo är däremot INTE beskrivning: placeholdern ber uttryckligen om
  // "akutrutiner, ansvarig vid olycka" — alltså ett namn och ett nummer.
  generalInfo: DOLD,

  // Tävlingsledningen. Rollstrukturen är konfiguration; personerna är inte
  // MCP:ns sak. closeCompetition (store.js:542) behåller exakt id, label,
  // visibility och ekonomi och nollar name/phone/email — gränsen är alltså
  // redan dragen i koden.
  management: { id: OPPEN, label: OPPEN, visibility: OPPEN, ekonomi: OPPEN,
                name: DOLD, phone: DOLD, email: DOLD },

  // placeToStorage (places.js:111) ger exakt dessa nycklar.
  places: { id: OPPEN, kind: OPPEN, name: OPPEN, icon: OPPEN, color: OPPEN,
            lat: OPPEN, lng: OPPEN, inCourse: OPPEN, courseAfter: OPPEN,
            dwellMinutes: OPPEN, note: DOLD },

  startTimes: { first: OPPEN, intervalSec: OPPEN, maxTimeMinutes: OPPEN },

  // Banans ändpunkter. note är fritext.
  startFinish: { start: { lat: OPPEN, lng: OPPEN, name: OPPEN, note: DOLD },
                 mal:   { lat: OPPEN, lng: OPPEN, name: OPPEN, note: DOLD } },

  // methods[].number är ett SWISHNUMMER, alltså oftast kassörens privata
  // mobil (competition-settings.js:1004). Det heter inte "telefon" — därför
  // duger ingen denylist på fältnamn.
  registration: { enabled: OPPEN, opensAt: OPPEN, closesAt: OPPEN,
                  price: OPPEN, currency: OPPEN, maxPatrols: OPPEN,
                  info: DOLD,
                  methods: { kind: OPPEN, label: OPPEN, number: DOLD, ref: DOLD } },

  // Spegelfälten för behörigheter är rena e-postlistor.
  adminEmails: DOLD, userEmails: DOLD, ekonomiEmails: DOLD,
  users: DOLD, ekonomi: DOLD, admins: DOLD,
  broadcast: DOLD
};

// controls/{ctrlId} — världsläsbar. Tre LEGACY-fält lever kvar här och måste
// vara uttryckligt dolda: telefon, notering, ansvariga, ansvarigaEmails
// (reglerna läser fortfarande en union av båda platserna, firestore.rules:102).
const KONTROLL = {
  nummer: OPPEN, name: OPPEN, lat: OPPEN, lng: OPPEN,
  maxPoang: OPPEN, minPoang: OPPEN, open: OPPEN, kind: OPPEN,
  // Innehåll om uppgiften: läsbart med skrubbning.
  utslag: OPPEN, utslagFraga: OPPEN, utslagSvar: OPPEN,
  placement: OPPEN,
  instructions: { text: OPPEN, rubrik: OPPEN, title: OPPEN },
  // Anteckningar och kontaktuppgifter: alltid dolda. De tre första är LEGACY
  // som lever kvar på det världsläsbara dokumentet.
  telefon: DOLD, notering: DOLD, ansvariga: DOLD, ansvarigaEmails: DOLD
};

// controls/{ctrlId}/private/meta
const KONTROLL_META = {
  telefon: DOLD, ansvariga: DOLD, ansvarigaEmails: DOLD,
  // welcomed är en LISTA MED E-POSTADRESSER (functions/index.js:1059) och står
  // inte i CLAUDE.md:s fältlistor. Lager 2 räddar ASCII-adresser men inte
  // icke-ASCII-domäner (kår.se matchar inte regexen).
  welcomed: DOLD,
  // Samtalsnyckeln är en fungerande fältlänk in i ett pågående samtal.
  // dumpCompetition strippar den redan av samma skäl (backup.js:99).
  threadToken: ALDRIG
};

// patrols/{pid} — världsläsbar. name och kar publiceras på /t (public.js:951,
// 1046, 1127, 1296) och i resultatlistor: uttryckligt produktbeslut att de är
// läsbara, annars kan modellen inte rätta ett stavfel eller hitta en dubblett.
const PATRULL = {
  name: OPPEN, kar: OPPEN, klass: OPPEN, avdelning: OPPEN,
  startOrder: OPPEN, startNumber: OPPEN, nummer: OPPEN, genrep: OPPEN,
  // utgatt bär en anteckning om VARFÖR patrullen bröt — i praktiken en
  // hälsouppgift om ett barn.
  utgatt: { at: OPPEN, note: DOLD },
  notering: DOLD, contact: DOLD, members: DOLD, epost: DOLD, telefon: DOLD
};

module.exports = {
  skrubba, maskera, narvaro,
  OPPEN, DOLD, ALDRIG,
  TAVLING, KONTROLL, KONTROLL_META, PATRULL
};
