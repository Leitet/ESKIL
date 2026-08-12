// Shared lazy-loader for Leaflet (CDN). Returns the global L once ready.

let ready = null;

export function ensureLeaflet() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    // Contain Leaflet's internal z-indexes (panes 400–700, controls 1000)
    // inside the map element. Without this an inline map paints on top of
    // any overlay/modal with a lower z-index than the panes.
    if (!document.querySelector('style[data-leaflet-fix]')) {
      const st = document.createElement('style');
      st.setAttribute('data-leaflet-fix', '');
      st.textContent = '.leaflet-container { isolation: isolate; }';
      document.head.appendChild(st);
    }
    if (window.L) return resolve(window.L);
    if (!document.querySelector('link[data-leaflet]')) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      css.setAttribute('data-leaflet', '');
      document.head.appendChild(css);
    }
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.onload = () => resolve(window.L);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return ready;
}
