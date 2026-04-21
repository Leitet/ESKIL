// Mobile UX helpers shared by the reporter (k.html) and startkort (s.html).
//
// haptic()        — a short buzz on Android; silent no-op where unsupported
//                   (iOS Safari has no web haptics API).
// bindHaptic(el)  — attach haptic() to pointerdown so the buzz fires at touch
//                   rather than on click release — feels more native.
// lockScroll()    — freeze the page behind a modal/sheet. Uses the
//                   position:fixed trick to prevent iOS rubber-band, restores
//                   scroll position on unlock.
// unlockScroll()  — inverse of lockScroll.

export function haptic(pattern = 10) {
  try { navigator.vibrate?.(pattern); } catch {}
}

export function bindHaptic(el, pattern = 10) {
  if (!el) return;
  el.addEventListener('pointerdown', () => haptic(pattern), { passive: true });
}

// Fire a handler on the first touchstart and preventDefault so iOS never
// enters the double-tap-zoom heuristic (which happens even when
// touch-action: manipulation is set on fast successive taps in the +/-
// steppers). Falls back to click for mouse / stylus / keyboard.
export function bindTap(el, handler, pattern = 10) {
  if (!el) return;
  let touchHandled = false;
  el.addEventListener('touchstart', (e) => {
    if (e.cancelable) e.preventDefault();
    touchHandled = true;
    haptic(pattern);
    handler(e);
  }, { passive: false });
  el.addEventListener('click', (e) => {
    if (touchHandled) { touchHandled = false; return; }
    haptic(pattern);
    handler(e);
  });
}

let lockedY = 0;
let lockDepth = 0;

export function lockScroll() {
  lockDepth++;
  if (lockDepth > 1) return;
  lockedY = window.scrollY || window.pageYOffset || 0;
  const b = document.body;
  b.style.position = 'fixed';
  b.style.top = `-${lockedY}px`;
  b.style.left = '0';
  b.style.right = '0';
  b.style.width = '100%';
}

export function unlockScroll() {
  lockDepth = Math.max(0, lockDepth - 1);
  if (lockDepth > 0) return;
  const b = document.body;
  b.style.position = '';
  b.style.top = '';
  b.style.left = '';
  b.style.right = '';
  b.style.width = '';
  window.scrollTo(0, lockedY);
}
