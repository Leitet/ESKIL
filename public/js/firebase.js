// Firebase bootstrap. Reads config from /__/firebase/init.json when deployed to
// Firebase Hosting, or falls back to /firebase-config.json (gitignored) for local dev.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  initializeAuth, indexedDBLocalPersistence, inMemoryPersistence,
  connectAuthEmulator,
  isSignInWithEmailLink, sendSignInLinkToEmail, signInWithEmailLink,
  onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  getFirestore, initializeFirestore,
  persistentLocalCache, persistentMultipleTabManager, persistentSingleTabManager, memoryLocalCache,
  doc, getDoc, getDocFromServer, setDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs, onSnapshot, query, where, orderBy,
  serverTimestamp, deleteField, writeBatch, Timestamp, arrayRemove
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import {
  getFunctions, httpsCallable, connectFunctionsEmulator
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js';
import {
  initializeAppCheck, ReCaptchaV3Provider
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app-check.js';

import { arAnonymFaltsida, arEnflikssida } from './utils.js';

// Fasmärkning till vakthundens tekniska rad — se field-watchdog.js.
const fas = (n) => { try { window.__eskilFas?.(n); } catch {} };


const isLocalHost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(location.hostname);

// App Check — reCAPTCHA v3. The site key is PUBLIC (it ships in the client by
// design); the secret lives only in the Firebase console. Enable in prod only:
// the emulator doesn't enforce App Check and reCAPTCHA can't attest localhost.
const RECAPTCHA_SITE_KEY = '6LdICIQtAAAAAEGzYf57ZC-J-645Mdp1A5Q2ExWW';

// KONFIGURATIONSHÄMTNINGEN FÅR ALDRIG HÄNGA.
//
// Anropet nedan ligger bakom ett TOPPNIVÅ-AWAIT, så en fetch som varken
// svarar eller felar fryser hela modulgrafen: ingen sida som importerar
// firebase.js kör en enda rad, och användaren blir stående på den statiska
// "Laddar…" som ligger i HTML:en. Inget fel visas, för inget fel inträffar —
// det är väntan som aldrig tar slut.
//
// Det är inte en teoretisk risk. Ett trögflytande mobilnät (TCP uppe, svaret
// kommer aldrig) ger precis det, och fetch har ingen egen tidsgräns; utan tak
// väntar den ut webbläsarens socket-timeout, tiotals sekunder eller längre.
// Service workern löste samma sak för fältsidorna med en 4-sekundersdeadline
// och genom att förcacha init.json — men först BESÖKET efter att den
// installerats, och bara på sidor som registrerar den.
//
// AbortController, inte AbortSignal.timeout: den senare saknas i Safari före
// 16, och de telefonerna finns i kårerna.
function hamtaMedTak(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// EN EMULATORKONFIGURATION FÅR ALDRIG ANVÄNDAS I PRODUKTION.
//
// Reservfilen /firebase-config.json är enligt CLAUDE.md till för lokal
// utveckling — men den låg spårad i git OCH deployad, och innehöll
// emulatorstubben (projectId "demo-eskil"). Före taken var grenen praktiskt
// taget onåbar: ett nät som dödade init.json dödade reservfilen lika snabbt.
// Med taket på 5 s kan init.json avbrytas medan reservfilen svarar direkt ur
// webbläsarens HTTP-cache — och då hade sidan startat mot ett projekt som
// inte finns. Fixen som gjorde en hängning synlig hade alltså öppnat en ny
// väg att gå sönder.
//
// Filen deployas inte längre och cachas inte längre av service workern, men
// den här kontrollen står kvar ändå: en redan installerad service worker och
// en HTTP-cache med en timmes livslängd kan servera den gamla kopian länge
// efter att den försvunnit från servern.
function kontrolleraConfig(c) {
  if (!c || !c.projectId) throw new Error('Konfigurationen saknar projectId.');
  if (c.projectId === 'demo-eskil' || c.apiKey === 'demo-local') {
    throw new Error('Fick en emulatorkonfiguration i produktion — ignorerad.');
  }
  return c;
}

async function loadConfig() {
  // On localhost we always talk to the emulators regardless of the config
  // values — hard-code a stub so we skip the extra network round-trip that
  // bottlenecked every page load.
  if (isLocalHost) {
    return { projectId: 'demo-eskil', apiKey: 'demo-local', appId: '1:0:web:0' };
  }
  // Taken är satta så att BÅDA försöken hinner ge upp före vakthundens
  // 10-sekundersgräns i field-watchdog.js. Då hinner felet nedan bli ett
  // avvisat löfte som vakthunden fångar och visar som teknisk info, i stället
  // för att den bara hinner säga "Sidan kunde inte ladda klart".
  //
  // AVVÄGNINGEN, uttrycklig: ett tak gör ett TRÖGT-MEN-LEVANDE nät till ett
  // hårt fel. En hämtning som förr lyckats efter sju sekunder misslyckas nu
  // efter fem. Det är ändå rätt val, av tre skäl:
  //   - Filen är 339 byte. Tar den mer än fem sekunder är förbindelsen
  //     praktiskt taget död, och Firebase-SDK:n från gstatic (hundratals kB,
  //     hämtas parallellt) kommer ändå aldrig fram i tid.
  //   - Alternativet är inte "långsam men fungerar" utan "tyst för alltid":
  //     utan tak finns ingen övre gräns alls, och det var precis det som
  //     lämnade /a stående på "Laddar anmälan…".
  //   - Felet är nu synligt och har en Försök igen-knapp. Ett andra försök
  //     har varm DNS och TLS och lyckas oftare än det första.
  // Höj alltså inte taken utan att också höja vakthundens deadline — testet
  // i test/boot.test.js kräver att de ryms innanför den.
  try {
    const r = await hamtaMedTak('/__/firebase/init.json', 5000);
    if (r.ok) return kontrolleraConfig(await r.json());
  } catch {}
  try {
    const r = await hamtaMedTak('/firebase-config.json', 3000);
    if (r.ok) return kontrolleraConfig(await r.json());
  } catch {}
  throw new Error('Konfigurationen kunde inte hämtas (ingen kontakt med servern).');
}

fas('config-start');
const config = await loadConfig();
fas('config-klar');
// De anonyma fältsidorna får en EGEN Firebase-app med eget namn, och det är
// ingen kosmetik. Firestores lokala cache och fliksynkronisering nycklas på
// appens namn (persistenceKey): alla flikar med samma namn på samma domän
// bildar en pool där EN flik, den primära, äger serverkontakten och kör de
// andra flikarnas frågor med SINA inloggningsuppgifter. Var /a, /k, /s eller
// /m den första fliken i webbläsaren blev den primär, och admin-flikens
// medlemsläsningar gick då ut utan inloggning: användardokumentet nekades
// (brickan Super-admin försvann, rollen föll till "user") och Anmälan-fliken
// svarade "Missing or insufficient permissions" medan alla publika flikar
// fungerade. Omvänt hade en anonym fliks skrivningar kunnat bli liggande i
// kön, eftersom den primära bara synkar sin egen användares mutationer.
// Återskapat i emulatorn med två flikar; regressionstestat i test/boot.test.js.
// Priset är att fältsidornas cache byter databasnamn en gång: första
// laddningen efter bytet behöver nät, precis som en ny enhet.
const app = initializeApp(config, arAnonymFaltsida(location.pathname) ? 'falt' : undefined);

// Initialise App Check before any Firestore/Functions calls so requests carry
// an attestation token. Guarded on appId (App Check needs a registered web
// app) so a missing/propagating config never throws.
// ENFORCEMENT IS ON for Firestore and Cloud Functions (since 2026-08-13), so
// this is not optional in production: without a token every read and write is
// rejected before the rules even run. Localhost is exempt because the
// emulators are not behind App Check. See SECURITY.md; to unblock a
// production incident: Firebase console → App Check → APIs → un-enforce.
if (!isLocalHost && config.appId) {
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
      isTokenAutoRefreshEnabled: true
    });
  } catch (e) {
    console.warn('[ESKIL] App Check kunde inte initieras:', e);
  }
}

// initializeAuth, INTE getAuth. getAuth drar in popup/redirect-resolvern, och
// den laddar https://apis.google.com/js/api.js för sin osynliga iframe. CSP:n
// tillåter inte den värden, så skriptet blockerades — och Auth svarade inte
// förrän försöket gett upp. Det var därför /app stod på "Laddar…" i sekunder
// på en kall klient (syntes som upprepade CSP-fel i konsolen).
//
// ESKIL loggar in med e-postlänk (signInWithEmailLink) och använder aldrig
// popup eller redirect, så resolvern behövs inte. Att inte ladda det vi inte
// använder är både snabbare och en CSP-överträdelse mindre.
//
// Persistensen anges uttryckligen här eftersom initializeAuth kräver det;
// indexedDBLocalPersistence är samma förval som getAuth hade gett.
// Persistensen väljs efter sida. Se arAnonymFaltsida() i utils.js för hela
// kedjan: på /a, /k, /s och /m kan en avstannad indexedDB.open() annars
// blockera Firestores kö för alltid, och sidan blir stående på "Laddar…"
// utan att något fel inträffar. De sidorna loggar aldrig in, så
// minnespersistens kostar ingenting där.
//
// IndexedDB PRÖVAS FÖRST på de sidor som kör enflikshantering (fältsidorna och
// /t) — se idbSvarar nedan. Svarar den inte får även Auth minnespersistens:
// /t behåller annars IndexedDB för inloggningen (admin-genvägen), och då hade
// samma hängning som beskrivs ovan slagit till just där anhöriga öppnar länken
// — i Facebooks och WhatsApps inbyggda webbläsare. Priset är att genvägen inte
// visas i en sådan webbläsare; sidan fungerar.
const faltsida = arAnonymFaltsida(location.pathname);
const enflikssida = arEnflikssida(location.pathname);
let idbOk = true;
if (enflikssida) {
  fas('idb-prov');
  idbOk = await idbSvarar();
  fas(idbOk ? 'idb-ok' : 'idb-dod');
}
fas('auth-init');
const auth = initializeAuth(app, {
  persistence: (faltsida || !idbOk)
    ? inMemoryPersistence
    : indexedDBLocalPersistence
});
// All Firebase-sent emails (magic links, anmälan manage-links/receipt
// notifications) use the Swedish template instead of the English default.
auth.languageCode = 'sv';

// On localhost, point Firestore at the emulator directly via init settings.
// IMPORTANT: we pin to 127.0.0.1 (IPv4) instead of `localhost`. On macOS,
// `localhost` resolves to ::1 (IPv6) first — the emulator only listens on
// IPv4, so every request waits out the IPv6 timeout before falling back.
// That was the ~30s-per-save pain, not WebChannel.
const EMU_HOST = '127.0.0.1';
// Persistent local cache (IndexedDB): reporter/startkort pages can render
// their data with no network at all — critical in the woods, where the
// service worker serves the page shell and this serves the data.
//
// FÄLTSIDORNA FÅR ALDRIG HÄNGA PÅ EN ANNAN FLIK.
//
// Med fliksynkronisering (persistentMultipleTabManager) äger EN flik
// serverkontakten, och alla andra flikar på samma domän läser GENOM den. SDK:n
// låter ägaren behålla ägarskapet så länge den förnyar det (var fjärde sekund)
// — och en BAKGRUNDSFLIK på en telefon gör just det: timrarna tickar, men
// nätet är strypt. Varje ny flik hänger då på en flik som inte kan nå servern.
// Det slog till på en skarp tävling: kontrollkort och startkort som stod på
// "Laddar…", vakthunden med "inget fel — sidan väntade", "hittades inte" för
// något som fanns — och en omladdning hjälpte INTE, för den gamla fliken levde
// kvar. Att lägga sidan på hemskärmen hjälpte: den har egen lagring och därmed
// inga andra flikar. Återskapat i emulatorn: en levande flik med dött nät, en
// ny flik → vakthunden efter 10 s, även efter "Försök igen". Och gamla flikar
// finns ALLTID: varje tryck på maillänken och varje QR-skanning öppnar en ny.
//
// Med enflikshantering (persistentSingleTabManager) äger första fliken
// IndexedDB-cachen, och varje YTTERLIGARE flik faller tillbaka på minnescache
// — SDK:n gör det själv (FAILED_PRECONDITION → "Falling back to memory cache",
// verifierat i firebase-firestore.js 10.12.5). Varje flik har då sin EGEN
// serverkontakt. Priset: en extra flik har ingen cache som överlever en
// omladdning utan täckning. Det är rätt byte — att sidan öppnas när det finns
// nät är det som inte får fallera. Använd ALDRIG forceOwnership här: den
// dödar den andra flikens Firestore tyst, och en kontrollant som växlar
// tillbaka dit sparar poäng som aldrig går iväg.
//
// Admin-SPA:n behåller fliksynkroniseringen: den används på datorer, där
// bakgrundsflikar har fungerande nät, och där en delad cache sparar läsningar.
//
// /t KÖR OCKSÅ ENFLIKSHANTERING, fast den delar lagring med admin-appen
// (standardappen, för admin-genvägens skull). Att de två har OLIKA hanterare
// är ofarligt, och det är SDK:n som ser till det: den som kommer tvåa faller
// tillbaka på minnescache åt vilket håll det än är. Admin först → /t får
// minnescache (start(): "!isPrimary && !allowTabSynchronization" →
// FAILED_PRECONDITION). /t först → admin får minnescache (canActAsPrimary:
// ägarens allowTabSynchronization är false → FAILED_PRECONDITION). Båda
// fungerar; den som kom tvåa saknar bara lokal kopia den sessionen. Verifierat
// i emulatorn åt båda håll. /t behåller PERSISTENSEN med flit (minnescache
// rakt av hade varit enklare): med en lokal kopia kostar en omladdning bara
// det som ändrats, och anhöriga laddar om resultatsidan hela dagen — utan den
// läses varje patrull och varje poäng om varje gång, mot en delad gratiskvot.
//
// IndexedDB KAN DESSUTOM VARA DÖD: i inbyggda webbläsare (QR-läsare, mailappar)
// och när iOS tappat sin IDB-anslutning svarar indexedDB.open() varken success
// eller error, och då hänger Firestores start för alltid — samma fel som
// inMemoryPersistence ovan löste för Auth. Pröva därför IndexedDB med en EGEN
// databas (aldrig Firestores — en tom databas där förstör dess schema) och en
// tidsgräns; svarar den inte körs sidan med minnescache.
function idbSvarar(ms = 1500) {
  return new Promise((resolve) => {
    let klar = false;
    const svara = (v) => { if (!klar) { klar = true; resolve(v); } };
    const t = setTimeout(() => svara(false), ms);
    try {
      const req = indexedDB.open('eskil-idb-prov');
      req.onsuccess = () => { clearTimeout(t); try { req.result.close(); } catch {} svara(true); };
      req.onerror = () => { clearTimeout(t); svara(false); };
      req.onblocked = () => { clearTimeout(t); svara(false); };
    } catch { clearTimeout(t); svara(false); }
  });
}

let localCache;
if (!enflikssida) {
  localCache = persistentLocalCache({ tabManager: persistentMultipleTabManager() });
} else {
  // idbOk prövades före Auth, längre upp.
  localCache = idbOk
    ? persistentLocalCache({ tabManager: persistentSingleTabManager({}) })
    : memoryLocalCache();
}
const db = isLocalHost
  ? initializeFirestore(app, {
      host: `${EMU_HOST}:8080`,
      ssl: false,
      experimentalForceLongPolling: true,
      localCache
    })
  : initializeFirestore(app, { localCache });

// Cloud Functions (callables) — deployed in europe-west1.
const functions = getFunctions(app, 'europe-west1');
if (isLocalHost) {
  try { connectFunctionsEmulator(functions, EMU_HOST, 5001); } catch {}
}

if (isLocalHost && !window.__eskilAuthEmulatorConnected) {
  try {
    connectAuthEmulator(auth, `http://${EMU_HOST}:9099`, { disableWarnings: true });
    window.__eskilAuthEmulatorConnected = true;
  } catch (e) {
    console.warn('[ESKIL] Auth emulator connect failed:', e);
  }
}

// Firebase Auth v10 defaults to indexedDBLocalPersistence in browsers — that
// already survives restarts, so we don't need an extra awaited round-trip
// here. Calling setPersistence explicitly added ~200–500ms to every cold
// load. Dropping it.

export {
  app, auth, db, functions, httpsCallable,
  isSignInWithEmailLink, sendSignInLinkToEmail, signInWithEmailLink,
  onAuthStateChanged, signOut,
  doc, getDoc, getDocFromServer, setDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs, onSnapshot, query, where, orderBy,
  serverTimestamp, deleteField, writeBatch, Timestamp, arrayRemove
};
