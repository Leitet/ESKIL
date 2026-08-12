// Shared course helpers — the single source of truth for how a competition's
// course is sequenced and measured. Used by the Spår editor, the public
// competition map, the startkort overview map and the Läget dashboard, so a
// drawn track always renders the same everywhere.
//
// The leg sequence is derived from control number order (start → 1 → 2 → …
// → mål via startFinishPoints when configured) and never stored; the track
// doc (competitions/<cid>/track/main) only stores waypoints per leg keyed
// "<fromKey>__<toKey>" plus the chosen walking pace.

import { startFinishPoints } from './utils.js';

export const DEFAULT_SPEED_KMH = 4;

export function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Sequence nodes (start, placed controls in number order, mål) and the legs
// between them, with any stored waypoints merged in. `hasDrawn` is true when
// at least one leg has drawn waypoints — the signal that a track exists and
// should be used on maps.
export function courseLegs(comp, controls, track) {
  const placed = (controls || [])
    .filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lng))
    .sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));

  const sf = startFinishPoints(comp);
  const nodes = [];
  if (sf.length) nodes.push({ key: '__start', label: 'S', title: sf[0].title, lat: sf[0].lat, lng: sf[0].lng, kind: 'start' });
  placed.forEach(c => nodes.push({ key: c.id, label: String(c.nummer ?? '?'), title: `Kontroll ${c.nummer ?? '?'} · ${c.name || ''}`, lat: c.lat, lng: c.lng, kind: 'control' }));
  if (sf.length === 2) nodes.push({ key: '__mal', label: 'M', title: sf[1].title, lat: sf[1].lat, lng: sf[1].lng, kind: 'finish' });
  else if (sf.length === 1 && placed.length) nodes.push({ key: '__mal', label: 'M', title: 'Mål', lat: sf[0].lat, lng: sf[0].lng, kind: 'finish' });

  const stored = (track && track.legs) || {};
  const legs = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const key = `${nodes[i].key}__${nodes[i + 1].key}`;
    const wps = (stored[key] || []).map(p => ({ lat: p.lat, lng: p.lng }));
    legs.push({ key, from: nodes[i], to: nodes[i + 1], wps, drawn: wps.length > 0 });
  }
  return { nodes, legs, hasDrawn: legs.some(l => l.drawn) };
}

// Full point sequence of a leg: fixed endpoints with waypoints in between.
export const legPath = (leg) => [leg.from, ...leg.wps, leg.to];
export const legLatLngs = (leg) => legPath(leg).map(p => [p.lat, p.lng]);

export function legDistance(leg) {
  const p = legPath(leg);
  let d = 0;
  for (let i = 0; i < p.length - 1; i++) d += haversine(p[i], p[i + 1]);
  return d;
}

export const courseDistance = (legs) => legs.reduce((s, l) => s + legDistance(l), 0);

export function fmtDist(m) {
  return m < 950 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

export function fmtMin(min) {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

// Draw the course on any Leaflet map: drawn legs solid, undrawn legs as the
// dashed fågelväg. Returns the created layers so callers can clean up.
export function drawCourseOnMap(L, map, legs, { color = '#003660' } = {}) {
  return legs.map(leg => L.polyline(legLatLngs(leg), leg.drawn
    ? { color, weight: 3.5, opacity: 0.85, interactive: false }
    : { color, weight: 3, opacity: 0.7, dashArray: '6 8', interactive: false }
  ).addTo(map));
}

// Small bottom-left chip with track stats ("Spår 3,7 km · ca 56 min gång").
// Only meaningful when a track is drawn — callers guard on hasDrawn.
export function addCourseChip(L, map, legs, speedKmh) {
  const dist = courseDistance(legs);
  const walk = (dist / 1000) / (speedKmh || DEFAULT_SPEED_KMH) * 60;
  const chip = L.control({ position: 'bottomleft' });
  chip.onAdd = () => {
    const div = L.DomUtil.create('div');
    div.style.cssText = 'background:rgba(255,255,255,.92);border:1px solid #d2dde8;border-radius:8px;padding:4px 10px;font:600 12px/1.5 Helvetica,Arial,sans-serif;color:#003660;box-shadow:0 1px 4px rgba(0,0,0,.15);';
    div.textContent = `Spår ${fmtDist(dist)} · ca ${fmtMin(walk)} gång`;
    return div;
  };
  chip.addTo(map);
  return chip;
}
