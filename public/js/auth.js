// Magic-link authentication. Email link is emailed by Firebase Auth;
// clicking it returns the user to the app where app.js finalizes sign-in.
//
// The flow is split into small pieces (pending? saved email? complete!) so
// app.js can drive a proper UI around it — the old all-in-one helper used
// window.prompt(), which is blocked or auto-dismissed in several mobile
// browsers and left users stuck on the loading splash.

import {
  auth, functions, httpsCallable,
  isSignInWithEmailLink, sendSignInLinkToEmail, signInWithEmailLink,
  onAuthStateChanged, signOut
} from './firebase.js';

const EMAIL_KEY = 'eskil:signin-email';

export function watchAuth(cb) {
  return onAuthStateChanged(auth, cb);
}

export async function sendMagicLink(email) {
  // The login mail is sent by our requestLoginLink function through Brevo
  // (branded, from noreply@eskilscout.se) instead of Firebase Auth's generic
  // template. Throttle errors ("vänta en minut") must reach the user, so only
  // unexpected failures fall back to Firebase's own email channel.
  try {
    await httpsCallable(functions, 'requestLoginLink')({ email });
  } catch (e) {
    if (e.code === 'functions/resource-exhausted' || e.code === 'functions/invalid-argument') throw e;
    console.warn('[ESKIL] requestLoginLink failed — falling back to Firebase mail:', e);
    await sendSignInLinkToEmail(auth, email, {
      url: `${location.origin}/app`,
      handleCodeInApp: true
    });
  }
  try { localStorage.setItem(EMAIL_KEY, email); } catch {}
}

// True when the current URL carries magic-link sign-in params.
export function pendingMagicLink() {
  return isSignInWithEmailLink(auth, location.href);
}

// The email the link was requested for — null when the link is opened in a
// different browser/device than where it was requested.
export function savedSigninEmail() {
  try { return localStorage.getItem(EMAIL_KEY); } catch { return null; }
}

// Remove the oobCode params so reloads don't retry a consumed link.
export function clearMagicLinkParams() {
  history.replaceState({}, '', location.pathname);
}

export async function completeMagicLink(email) {
  const res = await signInWithEmailLink(auth, email, location.href);
  try { localStorage.removeItem(EMAIL_KEY); } catch {}
  clearMagicLinkParams();
  return res.user;
}

export function doSignOut() {
  return signOut(auth);
}
