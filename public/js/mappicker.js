// Shared interactive map picker built on Leaflet. Click or drag to set a
// coordinate; optional geolocation to jump to the user's current position.
//
// Usage:
//   const picker = await initMapPicker({
//     container: hostEl,
//     lat: 56.7380, lng: 16.3280,
//     onChange: ({ lat, lng }) => { ... }
//   });
//   picker.useGeolocation();  // returns Promise<{lat, lng}>
//   picker.setPosition(lat, lng);
//   picker.destroy();

import { ensureLeaflet } from './leaflet.js';

const DEFAULT_CENTER = [56.7167, 16.3500];   // Kalmar
const DEFAULT_ZOOM = 11;
const ZOOMED_IN = 17;

export async function initMapPicker({
  container,
  lat,
  lng,
  onChange,
  defaultCenter = DEFAULT_CENTER,
  defaultZoom = DEFAULT_ZOOM
} = {}) {
  if (!container) throw new Error('initMapPicker: container required');
  const L = await ensureLeaflet();

  const hasInitial = Number.isFinite(lat) && Number.isFinite(lng);
  const map = L.map(container, { zoomControl: true, scrollWheelZoom: true })
    .setView(hasInitial ? [lat, lng] : defaultCenter, hasInitial ? 16 : defaultZoom);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(map);

  let marker = null;
  const place = (la, ln) => {
    if (!marker) {
      marker = L.marker([la, ln], { draggable: true }).addTo(map);
      marker.on('dragend', () => {
        const p = marker.getLatLng();
        onChange && onChange({ lat: p.lat, lng: p.lng });
      });
    } else {
      marker.setLatLng([la, ln]);
    }
  };

  if (hasInitial) place(lat, lng);

  map.on('click', (e) => {
    place(e.latlng.lat, e.latlng.lng);
    onChange && onChange({ lat: e.latlng.lat, lng: e.latlng.lng });
  });

  // Leaflet can mis-size inside a just-revealed container — nudge it after paint.
  setTimeout(() => map.invalidateSize(), 120);

  return {
    map,
    setPosition(la, ln, zoom = 16) {
      place(la, ln);
      map.setView([la, ln], zoom);
    },
    useGeolocation() {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error('Platstjänster stöds inte'));
        navigator.geolocation.getCurrentPosition((pos) => {
          const { latitude, longitude } = pos.coords;
          place(latitude, longitude);
          map.setView([latitude, longitude], ZOOMED_IN);
          onChange && onChange({ lat: latitude, lng: longitude });
          resolve({ lat: latitude, lng: longitude });
        }, (err) => reject(err), { enableHighAccuracy: true, timeout: 10000 });
      });
    },
    invalidateSize() { map.invalidateSize(); },
    destroy() { try { map.remove(); } catch {} }
  };
}
