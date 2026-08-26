// Firebase bootstrap. Reads config from /__/firebase/init.json when deployed to
// Firebase Hosting, or falls back to /firebase-config.json (gitignored) for local dev.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  initializeAuth, indexedDBLocalPersistence,
  connectAuthEmulator,
  isSignInWithEmailLink, sendSignInLinkToEmail, signInWithEmailLink,
  onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  getFirestore, initializeFirestore,
  persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs, onSnapshot, query, where, orderBy,
  serverTimestamp, deleteField, writeBatch, Timestamp
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import {
  getFunctions, httpsCallable, connectFunctionsEmulator
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js';
import {
  initializeAppCheck, ReCaptchaV3Provider
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app-check.js';

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
  try {
    const r = await hamtaMedTak('/__/firebase/init.json', 5000);
    if (r.ok) return r.json();
  } catch {}
  try {
    const r = await hamtaMedTak('/firebase-config.json', 3000);
    if (r.ok) return r.json();
  } catch {}
  throw new Error('Konfigurationen kunde inte hämtas (ingen kontakt med servern).');
}

const config = await loadConfig();
const app = initializeApp(config);

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
const auth = initializeAuth(app, { persistence: indexedDBLocalPersistence });
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
// service worker serves the page shell and this serves the data. Multi-tab
// manager so several open ESKIL tabs share the cache instead of erroring.
const db = isLocalHost
  ? initializeFirestore(app, {
      host: `${EMU_HOST}:8080`,
      ssl: false,
      experimentalForceLongPolling: true,
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    })
  : initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });

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
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs, onSnapshot, query, where, orderBy,
  serverTimestamp, deleteField, writeBatch, Timestamp
};
