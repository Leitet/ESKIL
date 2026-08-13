// Pre-apply stored day/night mode before first paint to avoid a flash.
// Kept in its own blocking script (not inline) so the CSP can forbid
// inline scripts entirely.
(function () {
  try {
    if (localStorage.getItem('eskil:mode') === 'night') {
      document.documentElement.setAttribute('data-mode', 'night');
    }
  } catch (e) { /* ignore */ }
})();
