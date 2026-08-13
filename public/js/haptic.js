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

// Fast, scroll-safe tap (the FastClick pattern). The old version fired on
// touchstart with preventDefault — instant, but a scroll gesture STARTING on
// the button both triggered the action and blocked the scroll (dragging on a
// +/- stepper in the score sheet bumped the score instead of scrolling).
// Now: touchstart stays passive so scrolling works from anywhere; the handler
// fires on touchend only when the finger hasn't moved. preventDefault on
// touchend still suppresses the synthetic click AND iOS's double-tap-zoom
// heuristic on fast successive taps. Falls back to click for mouse/keyboard.
const TAP_SLOP_PX = 12;
export function bindTap(el, handler, pattern = 10) {
  if (!el) return;
  let touchHandled = false;
  let startX = 0, startY = 0, moved = true;
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    moved = false;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > TAP_SLOP_PX
     || Math.abs(t.clientY - startY) > TAP_SLOP_PX) moved = true;
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (moved) return; // it was a scroll/drag — never treat as a tap
    if (e.cancelable) e.preventDefault();
    touchHandled = true;
    haptic(pattern);
    handler(e);
  }, { passive: false });
  el.addEventListener('touchcancel', () => { moved = true; }, { passive: true });
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
