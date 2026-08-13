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
      css.integrity = 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H';
      css.crossOrigin = 'anonymous';
      css.setAttribute('data-leaflet', '');
      document.head.appendChild(css);
    }
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.integrity = 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH';
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve(window.L);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return ready;
}
