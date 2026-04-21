// Magic-link authentication. Email link is emailed by Firebase Auth;
// clicking it returns the user to /auth-callback where we finalize sign-in.

import {
  auth,
  isSignInWithEmailLink, sendSignInLinkToEmail, signInWithEmailLink,
  onAuthStateChanged, signOut
} from './firebase.js';

const EMAIL_KEY = 'eskil:signin-email';

export function watchAuth(cb) {
  return onAuthStateChanged(auth, cb);
}

export async function sendMagicLink(email) {
  const actionCodeSettings = {
    url: `${location.origin}/app`,
    handleCodeInApp: true
  };
  await sendSignInLinkToEmail(auth, email, actionCodeSettings);
  localStorage.setItem(EMAIL_KEY, email);
}

export async function completeMagicLinkIfPresent() {
  if (!isSignInWithEmailLink(auth, location.href)) return null;
  let email = localStorage.getItem(EMAIL_KEY);
  if (!email) {
    email = window.prompt('Bekräfta din e-postadress för att slutföra inloggning:');
    if (!email) return null;
  }
  const res = await signInWithEmailLink(auth, email, location.href);
  localStorage.removeItem(EMAIL_KEY);
  // Strip the sign-in params out of the URL so reloads don't retry.
  history.replaceState({}, '', location.pathname);
  return res.user;
}

export function doSignOut() {
  return signOut(auth);
}
