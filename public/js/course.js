// Shared course helpers — the single source of truth for how a competition's
// course is sequenced and measured. Used by the Spår editor, the public
// competition map, the startkort overview map and the Läget dashboard, so a
// drawn track always renders the same everywhere.
//
// The leg sequence is derived from control number order (start → 1 → 2 → …
// → mål via startFinishPoints when configured) and never stored; the track
// doc (competitions/<cid>/track/main) only stores waypoints per leg keyed
// "<fromKey>__<toKey>" plus the chosen walking pace.

import { startFinishPoints, patrolStartDateTime } from './utils.js';
import { coursePlaces } from './places.js';

export const DEFAULT_SPEED_KMH = 4;

export function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Initial bäring i grader från norr (0–360), medurs. Används av startkortets
// "nästa kontroll"-kort. Storcirkelbäring, inte enkel atan2 på lat/lng-skillnad
// — på svenska breddgrader är en longitudgrad ungefär halva en latitudgrads
// längd, och den naiva varianten pekar märkbart fel.
export function bearingDeg(from, to) {
  const rad = Math.PI / 180;
  const f1 = from.lat * rad, f2 = to.lat * rad;
  const dl = (to.lng - from.lng) * rad;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

// Väderstreck på svenska. Detta är vad patrullen får när telefonen INTE kan
// säga åt vilket håll den själv pekar: en pil som inte vet var norr är skulle
// ljuga, men "mot nordost" går att använda med en riktig kompass — och scouter
// har kompass.
const STRECK = ['norr', 'nordost', 'öster', 'sydost', 'söder', 'sydväst', 'väster', 'nordväst'];
export function kompassnamn(deg) {
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return STRECK[i];
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

  // Platser som ingår i banan (matplats, rastplats …) vävs in mellan
  // kontrollerna: Start → 1 → 2 → 3 → Matplats → 4. De är noder i spåret men
  // INTE kontroller — de har inga poäng, ingen rapportsida och räknas aldrig
  // som avklarade. Deras dwellMin är arrangörens uppgift, inte vår gissning.
  const platser = coursePlaces(comp);
  const efter = new Map();                       // kontrollnummer -> platser
  for (const pl of platser) {
    if (!efter.has(pl.courseAfter)) efter.set(pl.courseAfter, []);
    efter.get(pl.courseAfter).push(pl);
  }
  const placeNode = (pl) => ({
    key: `place:${pl.id}`, label: '', title: pl.name,
    lat: pl.lat, lng: pl.lng, kind: 'place',
    dwellMin: pl.dwellMinutes, icon: pl.icon, colorHex: pl.colorHex
  });
  // courseAfter 0 = direkt efter start (även när ingen start är satt: då
  // öppnar platsen banan).
  (efter.get(0) || []).forEach(pl => nodes.push(placeNode(pl)));
  placed.forEach(c => {
    nodes.push({ key: c.id, label: String(c.nummer ?? '?'), title: `Kontroll ${c.nummer ?? '?'} · ${c.name || ''}`, lat: c.lat, lng: c.lng, kind: 'control' });
    (efter.get(Number(c.nummer)) || []).forEach(pl => nodes.push(placeNode(pl)));
  });
  // Platser som pekar på ett kontrollnummer som inte finns (kontrollen
  // raderad eller omnumrerad) hamnar sist före mål i stället för att tyst
  // falla ur banan.
  const nummerFinns = new Set([0, ...placed.map(c => Number(c.nummer))]);
  platser.filter(pl => !nummerFinns.has(pl.courseAfter)).forEach(pl => nodes.push(placeNode(pl)));

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

// A short piece of a leg measured from one of its ends, following any drawn
// waypoints. end: 'to' walks backwards from leg.to (the way IN to a control),
// 'from' walks forwards from leg.from (the way OUT). The returned points
// always START at the control end and extend outward along the course.
export function legStub(leg, end, meters = 140) {
  const path = legPath(leg).map(p => ({ lat: p.lat, lng: p.lng }));
  const pts = end === 'to' ? [...path].reverse() : path;
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length && acc < meters; i++) {
    const d = haversine(pts[i - 1], pts[i]);
    if (!d) continue;
    if (acc + d <= meters) { out.push(pts[i]); acc += d; }
    else {
      const t = (meters - acc) / d;
      out.push({
        lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t,
        lng: pts[i - 1].lng + (pts[i].lng - pts[i - 1].lng) * t
      });
      acc = meters;
    }
  }
  return out.length > 1 ? out : null;
}

export const DEFAULT_DWELL_MIN = 15;

// ETA engine — walking pace along the course plus a fixed "stationstid" per
// besökt kontroll. byKey[nodeKey] answers "minutes after start until arrival
// here"; finishMin is the whole course including the last control's dwell.
// Works without a drawn track too (fågelväg between placed controls), so
// estimates exist as soon as positions are set. These are estimates — every
// view phrases them with "ca".
export function courseEta(comp, controls, track) {
  const { nodes, legs, hasDrawn } = courseLegs(comp, controls, track);
  const speedKmh = Number(track?.speedKmh) || DEFAULT_SPEED_KMH;
  const dwellMin = Number(comp?.etaDwellMinutes) || DEFAULT_DWELL_MIN;
  // Stopptiden per nod: kontroller kostar tävlingens stationstid, banplatser
  // sin egen (0 om arrangören inte angett någon — då är de bara en punkt att
  // gå förbi).
  const stopAt = (n) => n.kind === 'control' ? dwellMin
    : n.kind === 'place' ? (Number(n.dwellMin) || 0) : 0;

  const byKey = {};
  let dist = 0, before = 0, stopped = 0;
  nodes.forEach((n, i) => {
    if (i > 0) {
      dist += legDistance(legs[i - 1]);
      if (nodes[i - 1].kind === 'control') before += 1;
      stopped += stopAt(nodes[i - 1]);
    }
    const walkMin = (dist / 1000) / speedKmh * 60;
    byKey[n.key] = { node: n, dist, walkMin, controlsBefore: before, stopMin: stopped, etaMin: walkMin + stopped };
  });
  const last = nodes[nodes.length - 1];
  const atLast = last ? byKey[last.key] : null;
  // A course that ends at a control (no mål configured) still spends the
  // dwell there before the day is over.
  const finishMin = atLast ? atLast.etaMin + stopAt(last) : null;
  return { nodes, legs, hasDrawn, speedKmh, dwellMin, byKey, totalDist: dist, finishMin };
}

// --- Självkalibrerande ETA -------------------------------------------------
// Modellantagandet (gångtid + fast stationstid) är bra på morgonen men vet
// inget om köer. Verkligheten finns dock redan i poängdatan: tiden mellan en
// patrulls två på varandra följande rapporter ÄR gångtid + kö + uppgift för
// den sträckan. När minst ETA_MIN_SAMPLES patruller passerat en sträcka ersätter
// medianen av deras mellantider modellantagandet för just den sträckan — kön
// bakas in automatiskt, och estimatet skärps ju längre dagen går. Sträckor utan
// underlag behåller modellen, så motorn är alltid definierad.
//
// Semantik per nod i byKey:
//   etaMin = minuter från start till ANKOMST (avfärd från förra noden + ren
//            gångtid — kö/uppgift på noden ligger efter ankomsten)
//   depMin = minuter från start till AVFÄRD (ankomst + kö + uppgift)
// finishMin = målgång (avfärd från sista kontrollen + gångtid till mål).
export const ETA_MIN_SAMPLES = 3;

const tsToMs = (ts) => {
  if (!ts) return null;
  const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
};

// `startMsByPatrol` (valfri, {pid: ms}): FAKTISKA starttider när anroparen
// har dem (station/Läget via passages). Utan den mäts första sträckan från
// planerad start, och en systematisk startförsening skulle dubbelräknas för
// patruller som ankras i sin faktiska start.
export function courseEtaCalibrated(comp, controls, track, scores = [], patrols = [], now = new Date(), startMsByPatrol = null) {
  const base = courseEta(comp, controls, track);
  const { nodes, legs, speedKmh, dwellMin } = base;
  // Demotävlingar: planerade starter rullar med klockan men seed-rapporterna
  // är frusna — kalibrering mot dem ger nonsens. Kör ren modell, och flagga
  // demoMode så patrolFinishEtaMs ignorerar de frusna rapportankarna.
  const demoMode = !!comp?.demo;
  if (!nodes.length) return { ...base, calibrated: false, demoMode };

  // Rapporttid per patrull och kontroll (nyckel = kontroll-id = nod-nyckel).
  // clientReportedAt (tryck-ögonblicket) före reportedAt (synkögonblicket) —
  // offlineköade rapporter ska bära passagetiden, inte när nätet kom tillbaka.
  const repByPatrol = new Map();
  if (!demoMode) {
    for (const s of scores || []) {
      const t = tsToMs(s.clientReportedAt ?? s.reportedAt);
      if (t == null || !s.patrolId || !s.controlId) continue;
      if (!repByPatrol.has(s.patrolId)) repByPatrol.set(s.patrolId, new Map());
      repByPatrol.get(s.patrolId).set(s.controlId, t);
    }
  }
  // Startankare för första benets mellantid: faktisk start när den finns,
  // annars planerad.
  const plannedMs = new Map();
  const total = (patrols || []).length;
  for (const p of patrols || []) {
    const actual = startMsByPatrol?.[p.id];
    if (actual != null) { plannedMs.set(p.id, actual); continue; }
    const d = patrolStartDateTime(comp, p, now, total);
    if (d) plannedMs.set(p.id, d.getTime());
  }

  const median = (arr) => {
    const v = [...arr].sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };

  // Observerad mellantid fram till en kontrollnod: från förra kontrollens
  // rapport (eller start när sträckan börjar vid start/första nod). `capMin`
  // är plausibilitetsvakten: deltan långt över modellens förväntan är nästan
  // alltid dataartefakter (kvarvarande synkklumpar, klockfel) — de får inte
  // fånga medianen.
  const observedSeg = (node, prev, capMin) => {
    // En sträcka som börjar vid en banplats går inte att kalibrera: platsen
    // rapporterar inget, och att då ankra mot starttiden ger den KUMULATIVA
    // tiden från start — som huvudloopen felaktigt skulle addera som ett
    // inkrement ovanpå ett cum som redan passerat platsen (dubbelräkning av
    // hela banan före platsen). Låt modellen (gång + stationstid) gälla där.
    if (prev && prev.kind === 'place') return { obsMin: null, samples: 0 };
    const deltas = [];
    for (const [pid, reps] of repByPatrol) {
      const here = reps.get(node.key);
      if (here == null) continue;
      const from = prev && prev.kind === 'control' ? reps.get(prev.key) : plannedMs.get(pid);
      if (from == null) continue;
      const min = (here - from) / 60000;
      if (min > 0 && min <= capMin) deltas.push(min);
    }
    return deltas.length >= ETA_MIN_SAMPLES
      ? { obsMin: median(deltas), samples: deltas.length }
      : { obsMin: null, samples: deltas.length };
  };

  const byKey = {};
  // Första noden: ankomst 0. Är den en kontroll kostar den ändå kö + uppgift
  // innan avfärd — kalibrerbar mot start när rapporter finns. Utan känd
  // gångväg fram är capen generösare (6× stationstid).
  let cum = 0;
  {
    const first = nodes[0];
    let obsMin = null, samples = 0;
    if (first.kind === 'control') {
      ({ obsMin, samples } = observedSeg(first, null, 6 * dwellMin));
      cum = obsMin ?? dwellMin;
    } else if (first.kind === 'place') {
      cum = Number(first.dwellMin) || 0;
    }
    byKey[first.key] = { ...base.byKey[first.key], etaMin: 0, depMin: cum, obsMin, samples, calibrated: obsMin != null };
  }
  for (let i = 1; i < nodes.length; i++) {
    const node = nodes[i], prev = nodes[i - 1];
    const walkMin = (legDistance(legs[i - 1]) / 1000) / speedKmh * 60;
    const arriveMin = cum + walkMin;
    let obsMin = null, samples = 0, segMin = walkMin;
    if (node.kind === 'control') {
      ({ obsMin, samples } = observedSeg(node, prev, 3 * (walkMin + dwellMin)));
      segMin = obsMin ?? (walkMin + dwellMin);
    } else if (node.kind === 'place') {
      // Banplatser rapporterar inget, så de kan aldrig kalibreras — men de
      // kostar den tid arrangören angett.
      segMin = walkMin + (Number(node.dwellMin) || 0);
    }
    cum += segMin;
    byKey[node.key] = { ...base.byKey[node.key], etaMin: arriveMin, depMin: cum, obsMin, samples, calibrated: obsMin != null };
  }

  const last = nodes[nodes.length - 1];
  const finishMin = (last.kind === 'control' || last.kind === 'place')
    ? byKey[last.key].depMin : byKey[last.key].etaMin;
  return {
    ...base, byKey, finishMin, demoMode,
    calibrated: nodes.some(n => byKey[n.key].calibrated)
  };
}

// Beräknad målgång (ms-epok) för EN patrull, ankrad i verkligheten: senaste
// rapporterade kontrollen är patrullens senaste kända avfärd, och kvarvarande
// sträckor summeras ur den (kalibrerade) motorn. Utan rapporter: startMs + hela
// banan. Returnerar RÅTT värde — kan ligga i det förflutna, vilket betyder
// "borde redan vara här". Varje vy väljer själv hur det visas (förseningsflagg
// på stationen, "väntas i mål" för anhöriga).
export function patrolFinishEtaMs(eta, patrolReports, startMs) {
  if (eta?.finishMin == null) return null;
  // Demo: frusna seed-rapporter är inte giltiga ankare — utgå från starttiden.
  const reports = eta.demoMode ? null : patrolReports;
  let anchorKey = null, anchorMs = null;
  for (const n of eta.nodes) {
    if (n.kind !== 'control') continue;
    const t = tsToMs(reports?.[n.key] ?? reports?.get?.(n.key));
    if (t != null) { anchorKey = n.key; anchorMs = t; }
  }
  if (anchorKey != null) {
    return anchorMs + Math.max(0, eta.finishMin - eta.byKey[anchorKey].depMin) * 60000;
  }
  if (startMs != null) return startMs + eta.finishMin * 60000;
  return null;
}

// "Patruller väntas ca X–Y" för en kontroll: första resp. sista patrullens
// starttid + ETA fram till kontrollen. null när starttider inte är påslagna,
// kontrollen saknar position eller inga patruller har startordning.
// Med `scores` kalibreras ankomsten mot verkliga mellantider (inkl. köer).
export function controlEtaWindow(comp, controls, track, patrols, ctrlId, now = new Date(), scores = null) {
  if (!comp?.startTimes?.enabled) return null;
  const eta = scores
    ? courseEtaCalibrated(comp, controls, track, scores, patrols, now)
    : courseEta(comp, controls, track);
  const entry = eta.byKey[ctrlId];
  if (!entry || !(entry.dist > 0)) return null;
  const times = (patrols || [])
    .map(p => patrolStartDateTime(comp, p, now, patrols.length))
    .filter(Boolean).map(d => d.getTime());
  if (!times.length) return null;
  const fmt = (t) => new Date(t + entry.etaMin * 60000)
    .toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  return { lo: fmt(Math.min(...times)), hi: fmt(Math.max(...times)), calibrated: !!entry.calibrated };
}

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

// Convex hull (Andrew's monotone chain) of {lat,lng} points, buffered
// outward from the centroid by ~`marginM` meters. Used to shade a
// "Tävlingsområde" on public maps when control positions are hidden —
// communicates where the competition happens without revealing any control.
export function competitionArea(points, marginM = 120) {
  const pts = points.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (pts.length < 3) return null;
  const sorted = [...pts].sort((a, b) => a.lng - b.lng || a.lat - b.lat);
  const cross = (o, a, b) => (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng);
  const lower = [], upper = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (const p of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (hull.length < 3) return null;

  const cLat = hull.reduce((s, p) => s + p.lat, 0) / hull.length;
  const cLng = hull.reduce((s, p) => s + p.lng, 0) / hull.length;
  const mLat = marginM / 111320;
  const mLng = marginM / (111320 * Math.cos(cLat * Math.PI / 180));
  return hull.map(p => {
    const dLat = p.lat - cLat, dLng = p.lng - cLng;
    const n = Math.hypot(dLat / mLat, dLng / mLng) || 1;
    return [p.lat + dLat / n, p.lng + dLng / n];
  });
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

// --- Spårritning: var hör en ny punkt hemma i benets sekvens? ---------------
//
// Ligger här (och inte i vyn) för att kunna testas utan karta — det här är
// logik som gick sönder tyst och gjorde spårritningen svårhanterlig.
//
// Avstånd i skärmpixlar från punkten p till sträckan a–b, klippt vid
// ändpunkterna. Egen implementation för att hålla course.js beroendefri
// (Leaflet har en motsvarighet, men modulen ska gå att köra i Node).
export function pointToSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Närmaste segment på en punktkedja. Lika avstånd vinns av det SENARE
// segmentet — ritningen går framåt, så det är den troligare avsikten.
export function nearestSegmentIndex(path, click) {
  let index = 0, dist = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const d = pointToSegmentDistance(click, path[i], path[i + 1]);
    if (d <= dist) { dist = d; index = i; }
  }
  return { index, dist };
}

export const REFINE_PX = 24;

// path = benets HELA punktkedja i skärmkoordinater (från, ...punkter, till),
// click = klickets skärmkoordinat. Returnerar indexet i leg.wps.
//
// Ett klick PÅ linjen justerar spåret där det landar. Ett klick bredvid
// förlänger från slutet. Skillnaden är hela poängen: utan den gick punkten
// alltid till närmaste segment, och så fort spåret bågade pekade "närmaste
// segment" bakåt — nästa punkt hamnade två steg tillbaka i sekvensen och
// linjen hoppade.
export function waypointInsertIndex(path, click, refinePx = REFINE_PX) {
  const { index, dist } = nearestSegmentIndex(path, click);
  return dist <= refinePx ? index : Math.max(0, path.length - 2);
}
