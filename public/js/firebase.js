// Firebase bootstrap. Reads config from /__/firebase/init.json when deployed to
// Firebase Hosting, or falls back to /firebase-config.json (gitignored) for local dev.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  getAuth,
  connectAuthEmulator,
  isSignInWithEmailLink, sendSignInLinkToEmail, signInWithEmailLink,
  onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  getFirestore, initializeFirestore,
  persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs, onSnapshot, query, where, orderBy,
  serverTimestamp, deleteField, writeBatch
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

async function loadConfig() {
  // On localhost we always talk to the emulators regardless of the config
  // values — hard-code a stub so we skip the extra network round-trip that
  // bottlenecked every page load.
  if (isLocalHost) {
    return { projectId: 'demo-eskil', apiKey: 'demo-local', appId: '1:0:web:0' };
  }
  try {
    const r = await fetch('/__/firebase/init.json');
    if (r.ok) return r.json();
  } catch {}
  try {
    const r = await fetch('/firebase-config.json');
    if (r.ok) return r.json();
  } catch {}
  throw new Error('Ingen Firebase-konfiguration hittades. Deploya till Firebase Hosting eller skapa public/firebase-config.json.');
}

const config = await loadConfig();
const app = initializeApp(config);

// Initialise App Check before any Firestore/Functions calls so requests carry
// an attestation token. Guarded on appId (App Check needs a registered web
// app) so a missing/propagating config never throws. While App Check is in
// MONITOR mode this only populates metrics — nothing is blocked; enforcement
// is turned on separately in the console once the metrics look clean.
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

const auth = getAuth(app);
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
  serverTimestamp, deleteField, writeBatch
};
