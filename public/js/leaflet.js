// Shared lazy-loader for Leaflet (CDN). Returns the global L once ready.

let ready = null;

const LAYERS_ICON = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23003660%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M12.83%202.18a2%202%200%200%200-1.66%200L2.6%206.08a1%201%200%200%200%200%201.83l8.58%203.91a2%202%200%200%200%201.66%200l8.58-3.9a1%201%200%200%200%200-1.83z%22%2F%3E%3Cpath%20d%3D%22M2%2012a1%201%200%200%200%20.58.91l8.6%203.91a2%202%200%200%200%201.65%200l8.58-3.9A1%201%200%200%200%2022%2012%22%2F%3E%3Cpath%20d%3D%22M2%2017a1%201%200%200%200%20.58.91l8.6%203.91a2%202%200%200%200%201.65%200l8.58-3.9A1%201%200%200%200%2022%2017%22%2F%3E%3C%2Fsvg%3E';

// Leaflet derives its default marker-image path from the script src (unpkg),
// which the CSP img-src blocks. The three PNGs are self-hosted instead —
// must be set before the first L.marker() is created.
function useLocalMarkerImages(L) {
  L.Icon.Default.imagePath = '/assets/leaflet/';
  return L;
}

export function ensureLeaflet() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    // Contain Leaflet's internal z-indexes (panes 400–700, controls 1000)
    // inside the map element. Without this an inline map paints on top of
    // any overlay/modal with a lower z-index than the panes.
    if (!document.querySelector('style[data-leaflet-fix]')) {
      const st = document.createElement('style');
      st.setAttribute('data-leaflet-fix', '');
      // Leaflets CSS hämtar lagerkontrollens ikon från unpkg (images/layers.png),
      // vilket CSP:ns img-src blockerar — knappen blev en tom ruta. Markörernas
      // PNG:er är självhostade (se ovan), men den här ligger i CSS:en och nås
      // inte den vägen. Ersätts med en inbäddad Lucide-symbol: samma ikonspråk
      // som resten av gränssnittet, skalar skarpt och behöver ingen @2x.
      //
      // Selektorn är medvetet på tre klasser. Leaflets egna regler är två
      // (.leaflet-touch .leaflet-control-layers-toggle) och deras CSS läggs i
      // <head> EFTER den här stiltaggen — vid lika specificitet vinner de.
      // Storleken lämnas orörd: 44 px på pekskärm är rätt träffyta.
      st.textContent = `
        .leaflet-container { isolation: isolate; }
        .leaflet-container .leaflet-control-layers .leaflet-control-layers-toggle {
          background-image: url("${LAYERS_ICON}");
          background-size: 20px 20px;
          background-position: center;
          background-repeat: no-repeat;
        }`;
      document.head.appendChild(st);
    }
    if (window.L) return resolve(useLocalMarkerImages(window.L));
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
    s.onload = () => resolve(useLocalMarkerImages(window.L));
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return ready;
}
