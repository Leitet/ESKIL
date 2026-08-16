// PDF generation for a control — two pages:
//   Page 1: Placement — map + placement hint + QR code to reporter URL
//   Page 2: Instructions — one block per avdelning-group
//
// jsPDF and qrcodejs are loaded lazily from CDN on first use.

import {
  reportUrl, startUrl, allInstructionGroups, publicManagement, patrolStartTime, patrolLabel,
  swishQrString
} from './utils.js';
import { legStub, courseLegs } from './course.js';

let jsPDFReady = null;
let qrReady = null;

// Subresource Integrity for the pinned CDN libs — the browser refuses to run
// the script if its bytes don't match the hash, so a compromised CDN/package
// can't inject code that would run with the admin's Firestore permissions.
function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    if (integrity) { s.integrity = integrity; s.crossOrigin = 'anonymous'; }
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

export async function ensureLibs() {
  if (!jsPDFReady) jsPDFReady = loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js', 'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk');
  if (!qrReady)    qrReady    = loadScript('https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js', 'sha384-3zSEDfvllQohrq0PHL1fOXJuC/jSOO34H46t6UQfobFOmxE5BpjjaIJY5F2/bMnU');
  await Promise.all([jsPDFReady, qrReady]);
}

async function qrDataUrl(text, size = 600) {
  await ensureLibs();
  const tmp = document.createElement('div');
  tmp.style.position = 'fixed'; tmp.style.left = '-9999px';
  document.body.appendChild(tmp);
  // eslint-disable-next-line no-undef
  new QRCode(tmp, { text, width: size, height: size, correctLevel: QRCode.CorrectLevel.M });
  // qrcodejs draws its <canvas> synchronously but populates the <img> src
  // asynchronously — reading img.src after a fixed 50 ms lost the race on
  // slower devices and handed jsPDF an empty/corrupt PNG. Read the canvas
  // first; poll briefly only as fallback.
  try {
    for (let i = 0; i < 40; i++) {
      const canvas = tmp.querySelector('canvas');
      if (canvas && canvas.width) return canvas.toDataURL('image/png');
      const img = tmp.querySelector('img');
      if (img && img.src && img.src.startsWith('data:image')) return img.src;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('QR-koden kunde inte genereras.');
  } finally {
    tmp.remove();
  }
}

// Lat/Lon -> tile coordinates (float) at zoom level
function lonLatToTileFloat(lat, lon, zoom) {
  const n = Math.pow(2, zoom);
  const x = (lon + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y };
}

function loadImage(src, crossOrigin = 'anonymous') {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Build a static map PNG centered on (lat, lng) using OSM tiles.
// Returns a dataURL or null on failure (e.g. offline, CORS).
// `widthTiles` × `heightTiles` at 256px each = final image size.
async function staticMapDataUrl(lat, lng, { zoom = 16, widthTiles = 3, heightTiles = 3, paths = [] } = {}) {
  const TILE = 256;
  const { x, y } = lonLatToTileFloat(lat, lng, zoom);
  const canvas = document.createElement('canvas');
  canvas.width = TILE * widthTiles;
  canvas.height = TILE * heightTiles;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e8eef4';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const halfW = widthTiles / 2;
  const halfH = heightTiles / 2;
  const originX = x - halfW; // float tile coord of top-left of canvas
  const originY = y - halfH;
  const firstX = Math.floor(originX);
  const firstY = Math.floor(originY);
  const offsetXpx = (originX - firstX) * TILE; // how much to shift tiles to the left

  const loadAt = async (gridTx, gridTy, drawX, drawY) => {
    const url = `https://tile.openstreetmap.org/${zoom}/${gridTx}/${gridTy}.png`;
    try {
      const img = await loadImage(url);
      ctx.drawImage(img, drawX, drawY);
    } catch (e) {
      // Leave the placeholder tile gray; continue.
    }
  };

  const tasks = [];
  // Enough tiles to fully cover the canvas (+1 in each direction for fractional offsets)
  for (let ty = 0; ty <= heightTiles; ty++) {
    for (let tx = 0; tx <= widthTiles; tx++) {
      const gridTx = firstX + tx;
      const gridTy = firstY + ty;
      const drawX = tx * TILE - offsetXpx;
      const drawY = ty * TILE - ((originY - firstY) * TILE);
      tasks.push(loadAt(gridTx, gridTy, drawX, drawY));
    }
  }
  await Promise.all(tasks);

  // Crop to exact widthTiles×heightTiles from the stitched canvas:
  // our `tasks` actually wrote at drawX/drawY shifted to make the center point
  // land at canvas center. We just need to draw the marker at canvas center.
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  // Course stubs (way in / way out) — drawn under the marker. Each path is
  // { points: [{lat,lng}], color, arrow?, label? } in course order.
  const toPx = (p) => {
    const t = lonLatToTileFloat(p.lat, p.lng, zoom);
    return { px: cx + (t.x - x) * TILE, py: cy + (t.y - y) * TILE };
  };
  for (const path of paths) {
    if (!path || !Array.isArray(path.points) || path.points.length < 2) continue;
    ctx.beginPath();
    ctx.setLineDash([12, 9]);
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = path.color;
    path.points.forEach((p, i) => {
      const { px, py } = toPx(p);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    const end = toPx(path.points[path.points.length - 1]);
    if (path.arrow) {
      const prev = toPx(path.points[path.points.length - 2] || path.points[0]);
      const ang = Math.atan2(end.py - prev.py, end.px - prev.px);
      ctx.save();
      ctx.translate(end.px, end.py);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(-10, -9); ctx.lineTo(15, 0); ctx.lineTo(-10, 9);
      ctx.closePath();
      ctx.fillStyle = path.color;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.restore();
    }
    if (path.label) {
      ctx.font = '700 16px Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center';
      const ly = end.py + (path.arrow ? 30 : -14);
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.strokeText(path.label, end.px, ly);
      ctx.fillStyle = path.color;
      ctx.fillText(path.label, end.px, ly);
      ctx.textAlign = 'start';
    }
  }

  // Marker (orange dot + blue ring)
  ctx.beginPath();
  ctx.arc(cx, cy, 14, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(233, 95, 19, 0.92)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#003660';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // Subtle OSM attribution bottom-right
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(canvas.width - 120, canvas.height - 18, 120, 18);
  ctx.fillStyle = '#333';
  ctx.fillText('© OpenStreetMap', canvas.width - 6, canvas.height - 4);

  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null; // tainted (shouldn't happen since tiles are CORS-ok)
  }
}

// ===========================================================================
// BANKARTA FÖR UTSKRIFT
// Till skillnad från kontrollernas kartor (en punkt, fast tilrutnät) ska den
// här visa HELA banan så stor som möjligt. Zoomen väljs alltså av innehållet,
// inte tvärtom: högsta zoom där allt fortfarande får plats.
//
// Renderas i tryckupplösning (~150 dpi över en A4-sida) och är dyr i tiles —
// därför genereras den EN gång och återanvänds för alla patruller i en
// massutskrift.
// ===========================================================================

const TILE_PX = 256;

const lonLatToWorld = (lat, lng, zoom) => {
  const t = lonLatToTileFloat(lat, lng, zoom);
  return { x: t.x * TILE_PX, y: t.y * TILE_PX };
};

// Hur banan ska ligga i bilden.
//
// Kartrutor finns bara i hela zoomsteg, och varje steg är en fördubbling. Att
// bara välja "högsta zoom som får plats" lämnar därför upp till halva bilden
// tom — banan kan vara nätt och jämnt för stor för nästa nivå. Bilden skalas
// i stället till exakt passning, så banan alltid fyller ytan.
//
// Vilken zoomnivå rutorna hämtas från är en avvägning: nästa nivå upp ger
// skarpare underlag men FYRA gånger så många rutor att hämta. Därför väljs
// den nivå vars skalfaktor ligger närmast 1 — skalan hamnar då mellan ~0,71
// och ~1,41, alltså högst 41 % uppskalning (knappt synligt i tryck) mot högst
// dubbla antalet rutor. Att alltid skala ner hade gett 2–4× rutor och en
// väntan på flera sekunder utan att det syns på papperet.
//
// `margin` är i bildpixlar och ska bara rymma nålarna som ritas i kanten,
// inte vara en andel av bilden: en procentsats blir enorm på en tryckstor
// bild och var hela orsaken till de tomma fälten runt banan.
const MAP_MARGIN_PX = 46;
const MIN_Z = 3, MAX_Z = 18;
// Tak för uppskalning. En riktigt kort bana ryms i ytan även på högsta
// zoomnivån — då FINNS ingen mer kartdata att zooma in på, och att blåsa upp
// den till full bredd ger bara en suddig karta. Bättre med luft runt banan än
// en karta man inte kan läsa.
const MAX_UPSCALE = 1.45;

export function fitView(pts, wPx, hPx, { margin = MAP_MARGIN_PX } = {}) {
  if (pts.length < 2) return { zoom: 16, scale: 1 };
  const usableW = Math.max(50, wPx - margin * 2);
  const usableH = Math.max(50, hPx - margin * 2);
  const skalaVid = (z) => {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const q of pts) {
      const w = lonLatToWorld(q.lat, q.lng, z);
      a = Math.min(a, w.x); b = Math.max(b, w.x);
      c = Math.min(c, w.y); d = Math.max(d, w.y);
    }
    return Math.min(usableW / Math.max(1, b - a), usableH / Math.max(1, d - c));
  };
  let bäst = { zoom: MIN_Z, scale: skalaVid(MIN_Z) };
  for (let z = MIN_Z + 1; z <= MAX_Z; z++) {
    const scale = skalaVid(z);
    if (Math.abs(Math.log(scale)) < Math.abs(Math.log(bäst.scale))) bäst = { zoom: z, scale };
    if (scale < 0.5) break;   // härifrån blir det bara sämre
  }
  return { zoom: bäst.zoom, scale: Math.min(bäst.scale, MAX_UPSCALE) };
}

// Skalstockens längd: en JÄMN sträcka (1, 2 eller 5 × en tiopotens) som ryms
// inom `maxPx`. Stapelns pixelbredd räknas ur den valda sträckan — aldrig
// tvärtom. En skalstock vars streck inte motsvarar sin siffra är värre än
// ingen skalstock alls; scouter mäter i den.
export function niceScale(metersPerPx, maxPx) {
  const råd = metersPerPx * maxPx;
  const pot = Math.pow(10, Math.floor(Math.log10(råd)));
  const jämn = [5, 2, 1].map(k => k * pot).find(v => v <= råd) || pot;
  return {
    meters: jämn,
    barPx: jämn / metersPerPx,
    etikett: jämn >= 1000 ? `${+(jämn / 1000).toFixed(2)} km` : `${jämn} m`
  };
}

// Kompass, skalstock och attribution — ritas på den FÄRDIGA bilden, efter en
// eventuell rotation. Norr är inte uppåt på en roterad karta, och en kompass
// som pekar fel är värre än ingen kompass alls; att räkna om nålen i efterhand
// vore lätt att glömma, så geometrin görs på ett enda ställe.
//
// `northDeg` är den riktning norr faktiskt har i bilden: 0 = uppåt, 90 = höger.
function drawMapChrome(ctx, w, h, { metersPerPx, northDeg }) {
  const { barPx, etikett } = niceScale(metersPerPx, Math.min(300, w * 0.22));

  const bx = 26, by = h - 40, bh = 12;
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.fillRect(bx - 10, by - 30, barPx + 20, 52);
  // Två fält i svart/vitt — läsbart även i gråskala.
  for (let i = 0; i < 2; i++) {
    ctx.fillStyle = i % 2 ? '#ffffff' : '#1c1c1c';
    ctx.fillRect(bx + (barPx / 2) * i, by, barPx / 2, bh);
  }
  ctx.strokeStyle = '#1c1c1c';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, barPx, bh);
  ctx.fillStyle = '#1c1c1c';
  ctx.font = '700 20px Helvetica, Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('0', bx, by - 8);
  ctx.textAlign = 'right';
  ctx.fillText(etikett, bx + barPx, by - 8);

  // --- Kompass ---
  const r = 34, cx = w - r - 26, cy = r + 26;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#1c1c1c';
  ctx.stroke();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(northDeg * Math.PI / 180);
  // Nål: röd norrhalva, vit södra — samma bild som på en riktig kompass.
  const nålL = r - 9, nålB = 8;
  ctx.beginPath();
  ctx.moveTo(0, -nålL); ctx.lineTo(nålB, 0); ctx.lineTo(-nålB, 0);
  ctx.closePath();
  ctx.fillStyle = '#C8102E';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, nålL); ctx.lineTo(nålB, 0); ctx.lineTo(-nålB, 0);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = '#1c1c1c';
  ctx.beginPath();
  ctx.moveTo(0, -nålL); ctx.lineTo(nålB, 0); ctx.lineTo(0, nålL); ctx.lineTo(-nålB, 0);
  ctx.closePath();
  ctx.stroke();
  // N:et roterar med nålen — annars pekar bokstaven åt ett håll och nålen åt
  // ett annat på en roterad karta.
  ctx.font = '800 19px Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#1c1c1c';
  ctx.fillText('N', 0, -r + 1);
  ctx.restore();

  // --- Attribution ---
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fillRect(w - 210, h - 30, 210, 30);
  ctx.fillStyle = '#333';
  ctx.fillText('© OpenStreetMap', w - 10, h - 8);
}

/**
 * Hela banan som en PNG-data-URI.
 * @param comp, controls, track  samma indata som kartorna i appen
 * @param places   normaliserade platser (compPlaces) — parkering och toaletter
 *                 är precis vad man vill ha på ett papper
 * @param wPx/hPx  bildens pixelmått (sätt efter utskriftsytan)
 * @returns { url, rotated } — `rotated` betyder att kartan är lagd på högkant
 *          för att fylla papperet; kortet skriver då ut att man ska vrida det.
 *          null när inget går att rita.
 */
export async function courseMapDataUrl(comp, controls, track, places = [], { wPx = 1800, hPx = 1240 } = {}) {
  const { nodes, legs } = courseLegs(comp, controls, track);
  // Alla punkter som ska rymmas: nodernas, spårets ritade punkter och
  // platserna. En parkering en bit bort ska inte hamna utanför bilden.
  const pts = [
    ...nodes.map(n => ({ lat: n.lat, lng: n.lng })),
    ...legs.flatMap(l => l.wps),
    ...places.map(p => ({ lat: p.lat, lng: p.lng }))
  ].filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!pts.length) return null;

  // En avlång bana i en liggande bild lämnar halva papperet tomt. Passar
  // banan bättre på högkant ritar vi den så och roterar bilden 90° — man
  // vrider papperet i stället, precis som med vilken karta som helst, och
  // banan får hela ytan. Förhållandet är zoom-oberoende, så vilken zoom som
  // helst duger för att mäta det.
  const spanAt = (z) => {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const q of pts) {
      const w = lonLatToWorld(q.lat, q.lng, z);
      a = Math.min(a, w.x); b = Math.max(b, w.x);
      c = Math.min(c, w.y); d = Math.max(d, w.y);
    }
    return { x: Math.max(1, b - a), y: Math.max(1, d - c) };
  };
  const span = spanAt(12);
  const missfit = (aspekt) => Math.abs(Math.log((span.x / span.y) / aspekt));
  const rotera = missfit(wPx / hPx) > missfit(hPx / wPx);
  const cw = rotera ? hPx : wPx;
  const ch = rotera ? wPx : hPx;

  const { zoom, scale } = fitView(pts, cw, ch);
  // Bildens mitt = mitten av innehållets utsträckning, inte medelvärdet:
  // en enstaka avlägsen punkt ska inte dra kartan ur balans.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    const w = lonLatToWorld(p.lat, p.lng, zoom);
    minX = Math.min(minX, w.x); maxX = Math.max(maxX, w.x);
    minY = Math.min(minY, w.y); maxY = Math.max(maxY, w.y);
  }
  const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e8eef4';
  ctx.fillRect(0, 0, cw, ch);

  // Världspixel -> bildpixel. `scale` är nedskalningen från kartrutornas
  // upplösning till bildens; allt annat (nålar, linjer, text) ritas i
  // bildpixlar och påverkas inte.
  const toPx = (p) => {
    const w = lonLatToWorld(p.lat, p.lng, zoom);
    return { px: cw / 2 + (w.x - centerX) * scale, py: ch / 2 + (w.y - centerY) * scale };
  };

  // Tiles: alla som skär bilden. Bilden täcker cw/scale världspixlar.
  const originX = centerX - (cw / 2) / scale, originY = centerY - (ch / 2) / scale;
  const worldW = cw / scale, worldH = ch / scale;
  const firstTx = Math.floor(originX / TILE_PX), lastTx = Math.floor((originX + worldW) / TILE_PX);
  const firstTy = Math.floor(originY / TILE_PX), lastTy = Math.floor((originY + worldH) / TILE_PX);
  const n = Math.pow(2, zoom);
  const step = TILE_PX * scale;
  const jobs = [];
  for (let ty = firstTy; ty <= lastTy; ty++) {
    for (let tx = firstTx; tx <= lastTx; tx++) {
      if (ty < 0 || ty >= n) continue;
      const wrapTx = ((tx % n) + n) % n;                 // världen är rund
      const dx = (tx * TILE_PX - originX) * scale, dy = (ty * TILE_PX - originY) * scale;
      jobs.push(loadImage(`https://tile.openstreetmap.org/${zoom}/${wrapTx}/${ty}.png`)
        .then(img => ctx.drawImage(img, dx, dy, step, step))
        .catch(() => { /* saknad ruta lämnas grå */ }));
    }
  }
  await Promise.all(jobs);

  // --- Spåret ---
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const leg of legs) {
    const path = [leg.from, ...leg.wps, leg.to].map(toPx);
    if (path.length < 2) continue;
    // Vit kontur under linjen: utan den försvinner spåret i skog och vägar
    // när kartan skrivs ut i gråskala.
    for (const [w, col, dash] of [[11, 'rgba(255,255,255,.9)', []], [6, ORANGE, leg.drawn ? [] : [16, 12]]]) {
      ctx.beginPath();
      ctx.setLineDash(dash);
      ctx.lineWidth = w;
      ctx.strokeStyle = col;
      path.forEach((q, i) => i ? ctx.lineTo(q.px, q.py) : ctx.moveTo(q.px, q.py));
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);

  // --- Platser: färgad prick + namn ---
  ctx.textBaseline = 'middle';
  for (const pl of places) {
    const { px, py } = toPx(pl);
    ctx.beginPath();
    ctx.arc(px, py, 13, 0, Math.PI * 2);
    ctx.fillStyle = pl.colorHex || '#5A6672';
    ctx.fill();
    ctx.lineWidth = 3.5; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.font = '600 20px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.strokeText(pl.name, px + 19, py);
    ctx.fillStyle = '#1c1c1c';
    ctx.fillText(pl.name, px + 19, py);
  }

  // --- Noder ---
  ctx.textAlign = 'center';
  for (const nd of nodes) {
    if (nd.kind === 'place') continue;                   // ritad ovan
    const { px, py } = toPx(nd);
    const isCtrl = nd.kind === 'control';
    ctx.beginPath();
    ctx.arc(px, py, isCtrl ? 21 : 24, 0, Math.PI * 2);
    ctx.fillStyle = isCtrl ? BLUE : YELLOW;
    ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.font = `800 ${isCtrl ? 24 : 20}px Helvetica, Arial, sans-serif`;
    ctx.fillStyle = isCtrl ? '#ffffff' : BLUE;
    ctx.fillText(nd.label, px, py + 1);
  }

  try {
    let färdig = canvas;
    if (rotera) {
      // Rotera 90° MEDURS in i den efterfrågade formen. Det som pekade uppåt
      // (norr) pekar därefter åt höger — se northDeg nedan.
      färdig = document.createElement('canvas');
      färdig.width = wPx; färdig.height = hPx;
      const uctx = färdig.getContext('2d');
      // save/restore, inte bara translate+rotate: transformen ligger annars
      // kvar på kontexten, och kompassen och skalstocken nedan ritas roterade
      // i fel hörn.
      uctx.save();
      uctx.translate(wPx, 0);
      uctx.rotate(Math.PI / 2);
      uctx.drawImage(canvas, 0, 0);
      uctx.restore();
    }
    // Meter per bildpixel: markupplösningen vid ekvatorn, korrigerad för
    // breddgraden och för nedskalningen av kartrutorna.
    const mittLat = pts.reduce((a, q) => a + q.lat, 0) / pts.length;
    const metersPerPx =
      156543.03392 * Math.cos(mittLat * Math.PI / 180) / Math.pow(2, zoom) / scale;
    drawMapChrome(färdig.getContext('2d'), wPx, hPx, { metersPerPx, northDeg: rotera ? 90 : 0 });
    return { url: färdig.toDataURL('image/jpeg', 0.86), rotated: rotera };
  } catch { return null; }
}

export const BLUE   = '#003660';
export const ORANGE = '#E95F13';
export const YELLOW = '#E2E000';

// Slim banner for page 2 (instructions) — no control title.
function drawBannerSlim(pdf, W, comp) {
  pdf.setFillColor(BLUE);
  pdf.rect(0, 0, W, 30, 'F');
  pdf.setTextColor(YELLOW);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.text('ESKIL · SCOUTTÄVLING', 15, 12);
  pdf.setTextColor('#ffffff');
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(16);
  pdf.text(`${comp.shortName || comp.name} ${comp.year ? '· ' + comp.year : ''}`, 15, 21);
  if (comp.location) {
    pdf.setFontSize(10);
    pdf.setTextColor('#a7bccf');
    pdf.text(comp.location, 15, 27);
  }
}

// Tall banner for page 1. Proportions:
//   ┌─────────────────────────────────────────────────┐
//   │                     ESKIL · Älghornsjakten 2026 · …  │  eyebrow right-aligned
//   │        ┌──┐                                     │
//   │        │  │   KNOP OCH SURRNING                 │
//   │        │ 2│                                     │
//   │        │  │   POÄNG                             │
//   │        └──┘   Max 10  ·  Min 0                  │
//   └─────────────────────────────────────────────────┘
function drawBannerWithTitle(pdf, W, comp, control) {
  const bannerH = 72;
  pdf.setFillColor(BLUE);
  pdf.rect(0, 0, W, bannerH, 'F');

  // Eyebrow (top-right)
  pdf.setTextColor(YELLOW);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  const eyebrowParts = ['ESKIL'];
  const compLabel = `${comp.shortName || comp.name}${comp.year ? ' ' + comp.year : ''}`;
  if (compLabel.trim()) eyebrowParts.push(compLabel);
  if (comp.location) eyebrowParts.push(comp.location);
  pdf.text(eyebrowParts.join(' · '), W - 15, 12, { align: 'right' });

  // Giant control number — vertically centered in the banner
  const numStr = `${control.nummer ?? ''}`;
  const numFontSize = 130;  // points; cap height ≈ 34mm, fits banner with padding
  pdf.setTextColor('#ffffff');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(numFontSize);
  // jsPDF text baseline: center digits vertically in the banner. Cap top is
  // roughly fontSize * 0.72 above the baseline (in pts, convert via 1pt ≈ 0.353mm).
  const capHeightMm = numFontSize * 0.72 * 0.3528;
  const baselineY = (bannerH + capHeightMm) / 2 + 1;
  pdf.text(numStr, 15, baselineY);
  const numWidth = pdf.getTextWidth(numStr);

  // Divider line between number and text block (subtle, scout-blue-500 reads as
  // a soft white tint over the banner).
  const textX = 15 + numWidth + 12;
  pdf.setDrawColor('#3a6389');
  pdf.setLineWidth(0.4);
  pdf.line(textX - 6, 18, textX - 6, bannerH - 14);

  // Name (upper right of number)
  const textW = W - 15 - textX;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(22);
  pdf.setTextColor('#ffffff');
  const nameLines = pdf.splitTextToSize(control.name || '', textW);
  pdf.text(nameLines.slice(0, 2), textX, 32);

  // POÄNG label + values
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(YELLOW);
  pdf.text('POÄNG', textX, 52);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(12);
  pdf.setTextColor('#ffffff');
  const parts = [];
  if (control.maxPoang != null) parts.push(`Max ${control.maxPoang}`);
  if (control.minPoang != null) parts.push(`Min ${control.minPoang}`);
  if (control.extraPoang) parts.push(`Extra ${control.extraPoang}`);
  pdf.text(parts.join('   ·   ') || '—', textX, 60);
}

export async function generateControlPdf(comp, control, {
  legIn = null, legOut = null, etaWindow = null,
  patrols = [], mgmt = [], allControls = [], pdf: existing = null
} = {}) {
  await ensureLibs();
  const url = reportUrl(comp.id, control.id);
  // Course stubs on the map: gray dashed = patrols arrive from there, orange
  // dashed with arrow = send them onward that way.
  const stubPaths = [];
  if (legIn) {
    const s = legStub(legIn, 'to', 160);
    if (s) stubPaths.push({ points: s, color: '#8a8a8a', label: `från ${legIn.from.label}` });
  }
  if (legOut) {
    const s = legStub(legOut, 'from', 160);
    if (s) stubPaths.push({ points: s, color: '#E95F13', arrow: true, label: `till ${legOut.to.label}` });
  }
  const [qr, mapImg] = await Promise.all([
    qrDataUrl(url, 700),
    (control.lat && control.lng) ? staticMapDataUrl(control.lat, control.lng, { paths: stubPaths }) : Promise.resolve(null)
  ]);

  // eslint-disable-next-line no-undef
  const { jsPDF } = window.jspdf;
  const pdf = existing || new jsPDF({ unit: 'mm', format: 'a4' });
  if (existing) pdf.addPage();
  const W = 210, H = 297;

  // ==========================================================================
  // PAGE 1 — Placement (map + hint + QR)
  //
  //  ┌──────────────────────────────────────┐
  //  │ [banner with kontroll# + name]       │
  //  ├──────────────────────────────────────┤
  //  │ ┌────────────┐  PLACERING            │
  //  │ │  square    │  On öppen gräsplan…   │
  //  │ │   map      │                       │
  //  │ │            │  Position 58.4, 15.6  │
  //  │ └────────────┘                       │
  //  │                                      │
  //  │         ┌───────────┐                │
  //  │         │    QR     │                │
  //  │         └───────────┘                │
  //  │        Skanna för …                  │
  //  └──────────────────────────────────────┘
  // ==========================================================================
  drawBannerWithTitle(pdf, W, comp, control);

  // Map: square, left-aligned under banner
  const bodyTop = 86;           // below the 72mm banner with breathing room
  const mapSize = 90;           // square side in mm
  const mapX = 15;
  const mapY = bodyTop;
  if (mapImg) {
    pdf.addImage(mapImg, 'PNG', mapX, mapY, mapSize, mapSize);
    pdf.setDrawColor('#e5e5e5');
    pdf.setLineWidth(0.3);
    pdf.rect(mapX, mapY, mapSize, mapSize);
  } else {
    pdf.setFillColor('#f8f8f7');
    pdf.rect(mapX, mapY, mapSize, mapSize, 'F');
    pdf.setDrawColor('#e5e5e5');
    pdf.rect(mapX, mapY, mapSize, mapSize);
    pdf.setTextColor('#8a8a8a');
    pdf.setFontSize(11);
    pdf.text('Ingen karta tillgänglig', mapX + mapSize / 2, mapY + mapSize / 2, { align: 'center' });
  }

  // Placement text block to the right of the map
  const textX = mapX + mapSize + 10;
  const textW = W - 15 - textX;
  let ty = mapY + 4;

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(ORANGE);
  pdf.text('PLACERING', textX, ty);
  ty += 7;

  if (control.placement) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    pdf.setTextColor('#282727');
    const lines = pdf.splitTextToSize(control.placement, textW);
    pdf.text(lines, textX, ty);
    ty += lines.length * 5.3 + 4;
  } else {
    pdf.setFont('helvetica', 'italic');
    pdf.setFontSize(10);
    pdf.setTextColor('#8a8a8a');
    pdf.text('Ingen placeringsbeskrivning angiven.', textX, ty);
    ty += 8;
  }

  if (control.lat && control.lng) {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor('#8a8a8a');
    pdf.text('POSITION', textX, ty);
    ty += 5;
    pdf.setFont('courier', 'normal');
    pdf.setFontSize(10);
    pdf.setTextColor('#282727');
    pdf.text(`${control.lat.toFixed(5)}, ${control.lng.toFixed(5)}`, textX, ty);
    ty += 9;
  }

  // ETA-fönstret: när första resp. sista patrullen väntas hit, beräknat på
  // starttider + gångtid längs spåret + stationstid per tidigare kontroll.
  if (etaWindow) {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor('#8a8a8a');
    pdf.text('PATRULLER VÄNTAS', textX, ty);
    ty += 5;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.setTextColor('#282727');
    pdf.text(etaWindow.lo === etaWindow.hi ? `ca ${etaWindow.lo}` : `ca ${etaWindow.lo}–${etaWindow.hi}`, textX, ty);
  }

  // Second row: QR on the left, instructions text on the right (same 2-col
  // grid as the map + placement row above).
  const qrY = mapY + mapSize + 12;
  const qrSize = mapSize;                  // match map width for visual rhythm
  const qrX = mapX;

  pdf.addImage(qr, 'PNG', qrX, qrY, qrSize, qrSize);

  // Right column for the QR — mirrors the placement block
  let qy = qrY + 4;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(ORANGE);
  pdf.text('POÄNGRAPPORTERING', textX, qy);
  qy += 7;

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(12);
  pdf.setTextColor('#282727');
  const qrLines = pdf.splitTextToSize('Skanna QR-koden för att rapportera poäng.', textW);
  pdf.text(qrLines, textX, qy);
  qy += qrLines.length * 6 + 6;

  // Secrecy warning — whoever holds the link can report scores.
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor('#DA005E');
  const warnLines = pdf.splitTextToSize('Håll QR-koden och länken dold för scouterna! Länken är hemlig — alla som har den kan rapportera poäng.', textW);
  pdf.text(warnLines, textX, qy);

  // Footer
  pdf.setTextColor('#a7bccf');
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.text('ESKIL — scouttävlingssystem', 15, H - 10);
  pdf.text('Sida 1 · Placering', W - 15, H - 10, { align: 'right' });

  // ==========================================================================
  // PAGE 2 — Instructions
  // ==========================================================================
  pdf.addPage();
  drawBannerSlim(pdf, W, comp);

  pdf.setTextColor(BLUE);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(22);
  pdf.text(`${control.nummer ?? ''}. ${control.name || ''}`, 15, 46, { maxWidth: W - 30 });

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(12);
  pdf.setTextColor(ORANGE);
  pdf.text('INSTRUKTIONER TILL KONTROLLANT', 15, 58);

  // Draw each group
  const groups = allInstructionGroups(control);
  let cursorY = 68;
  const leftX = 15;
  const rightX = W - 15;
  const bodyWidth = W - 30;

  const drawGroup = (g) => {
    const heading = (g.avdelningar || []).length ? g.avdelningar.join(' · ') : 'Default — alla andra avdelningar';
    // Measure text so we can page-break if needed
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    const headingHeight = 6;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    const lines = pdf.splitTextToSize(g.text || '', bodyWidth - 6);
    const textHeight = lines.length * 5.5;
    const blockHeight = headingHeight + textHeight + 10;

    if (cursorY + blockHeight > H - 20) {
      pdf.addPage();
      drawBannerSlim(pdf, W, comp);
      cursorY = 46;
    }

    // Tag pill background
    const tagFill = (g.avdelningar || []).length ? '#e8eef4' : '#f2f2f2';
    const tagText = (g.avdelningar || []).length ? BLUE     : '#525252';
    pdf.setFillColor(tagFill);
    pdf.roundedRect(leftX, cursorY - 4, bodyWidth, 7, 2, 2, 'F');
    pdf.setTextColor(tagText);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.text(heading, leftX + 3, cursorY);
    cursorY += 10;

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    pdf.setTextColor('#282727');
    pdf.text(lines, leftX + 3, cursorY);
    cursorY += textHeight + 8;
  };

  if (groups.length) {
    for (const g of groups) drawGroup(g);
  } else {
    pdf.setFont('helvetica', 'italic');
    pdf.setFontSize(11);
    pdf.setTextColor('#8a8a8a');
    pdf.text('Inga instruktioner angivna.', leftX, 70);
  }

  // Footer
  pdf.setTextColor('#a7bccf');
  pdf.setFontSize(8);
  pdf.text('ESKIL — scouttävlingssystem', 15, H - 10);
  pdf.text(new Date().toLocaleDateString('sv-SE'), W - 15, H - 10, { align: 'right' });

  // ==========================================================================
  // Nödinfo och reservprotokoll — pappersdelen av kontrollens paket. Låg
  // tidigare i ett separat "fältpaket"; nu följer den med varje kontroll, så
  // det som lämnas över till kontrollanten är komplett i sig.
  // ==========================================================================
  drawControlEmergencyPage(pdf, comp, control, { mgmt, allControls });
  drawControlProtocolPage(pdf, comp, control, patrols);

  return pdf;
}

// Nödinfo för EN kontroll. Koordinaterna står här, inte "se annan sida" —
// det är den här sidan man river loss och sätter i kontrollens pärm.
function drawControlEmergencyPage(pdf, comp, control, { mgmt = [], allControls = [] } = {}) {
  const W = 210, H = 297;
  pdf.addPage();
  drawBannerSlim(pdf, W, comp);
  const footer = () => {
    pdf.setTextColor('#a7bccf');
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.text('ESKIL — nödinfo & kontakter', 15, H - 10);
    pdf.text(`Kontroll ${control.nummer ?? '?'}`, W - 15, H - 10, { align: 'right' });
  };

  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(20); pdf.setTextColor(BLUE);
  pdf.text(`${control.nummer ?? ''}. ${control.name || ''}`, 15, 46, { maxWidth: W - 30 });

  let y = 60;
  const heading = (t) => {
    if (y > H - 40) { footer(); pdf.addPage(); drawBannerSlim(pdf, W, comp); y = 44; }
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12); pdf.setTextColor(ORANGE);
    pdf.text(t, 15, y); y += 7;
  };
  const line = (t, opts = {}) => {
    if (y > H - 24) { footer(); pdf.addPage(); drawBannerSlim(pdf, W, comp); y = 44; }
    pdf.setFont('helvetica', opts.bold ? 'bold' : 'normal');
    pdf.setFontSize(opts.size || 10.5);
    pdf.setTextColor(opts.color || '#282727');
    const rows = pdf.splitTextToSize(t, W - 30);
    pdf.text(rows, 15, y);
    y += rows.length * 5.2 + (opts.gap ?? 1.5);
  };

  pdf.setFillColor('#fdecec');
  pdf.rect(15, y - 6, W - 30, 26, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(13); pdf.setTextColor('#c8102e');
  pdf.text('VID NÖDLÄGE: RING 112', 20, y + 2);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10); pdf.setTextColor('#282727');
  const koord = Number.isFinite(control.lat)
    ? `${control.lat.toFixed(5)}, ${control.lng.toFixed(5)}`
    : 'position ej satt';
  pdf.text(`Ange scouttävling, kontroll ${control.nummer ?? '?'} och koordinaterna: ${koord}`, 20, y + 10);
  pdf.text('Meddela därefter tävlingsledningen.', 20, y + 15.5);
  y += 32;

  if (mgmt.length) {
    heading('TÄVLINGSLEDNING');
    for (const r of mgmt) {
      line(`${r.label || 'Roll'}: ${r.name || '—'}${r.phone ? '  ·  ' + r.phone : ''}${r.email ? '  ·  ' + r.email : ''}`);
    }
    y += 4;
  }

  const andra = (allControls || []).filter(c => c.id !== control.id);
  if (andra.length) {
    heading('ÖVRIGA KONTROLLER');
    for (const c of andra) line(`${c.nummer ?? '?'}. ${c.name || '—'}: ${c.telefon || '—'}`);
    y += 4;
  }

  if ((comp.generalInfo || '').trim()) {
    heading('ALLMÄN INFORMATION');
    line(comp.generalInfo.trim());
  }
  footer();
}

// Reservprotokoll: papperslivlinan när tekniken dör.
function drawControlProtocolPage(pdf, comp, control, patrols = []) {
  const W = 210, H = 297;
  const pats = [...patrols].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  pdf.addPage();
  drawBannerSlim(pdf, W, comp);
  const footer = () => {
    pdf.setTextColor('#a7bccf');
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.text('ESKIL — reservprotokoll (fylls i för hand)', 15, H - 10);
    pdf.text(`Kontroll ${control.nummer ?? '?'}`, W - 15, H - 10, { align: 'right' });
  };

  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(15); pdf.setTextColor(BLUE);
  pdf.text(`Reservprotokoll — kontroll ${control.nummer ?? '?'} · ${control.name || ''}`, 15, 42);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9.5); pdf.setTextColor('#8a8a8a');
  pdf.text(`Max ${control.maxPoang ?? 0} p · Min ${control.minPoang ?? 0} p${control.extraPoang ? ` · Extra max ${control.extraPoang} p` : ''}${control.utslag && control.utslagFraga ? ' · Utslagsfråga: ' + control.utslagFraga : ''}`, 15, 48);
  pdf.text('Fyll i för hand om rapporteringen inte fungerar — lämna protokollet till sekretariatet efter tävlingen.', 15, 53);

  const x = { num: 15, name: 27, avd: 95, poang: 130, extra: 150, utslag: 168, sign: 188 };
  let ty = 62;
  const tabellhuvud = () => {
    pdf.setFillColor('#f0f4f8');
    pdf.rect(15, ty - 5, 180, 8, 'F');
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); pdf.setTextColor(BLUE);
    pdf.text('#', x.num + 1, ty); pdf.text('Patrull', x.name, ty); pdf.text('Avdelning', x.avd, ty);
    pdf.text('Poäng', x.poang, ty); pdf.text('Extra', x.extra, ty); pdf.text('Utslag', x.utslag, ty); pdf.text('Sign', x.sign, ty);
    ty += 6;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9.5); pdf.setTextColor('#282727');
  };
  tabellhuvud();
  if (!pats.length) {
    pdf.setFont('helvetica', 'italic'); pdf.setTextColor('#8a8a8a');
    pdf.text('Inga patruller registrerade än — skriv ut igen när startlistan är klar.', 15, ty + 4);
  }
  for (const p of pats) {
    pdf.setDrawColor('#d8dee5');
    pdf.setLineWidth(0.25);
    pdf.line(15, ty + 3, 195, ty + 3);
    pdf.text(String(p.number ?? ''), x.num + 1, ty);
    pdf.text(patrolLabel(p).slice(0, 46), x.name, ty);
    pdf.text(String(p.avdelning || '').slice(0, 16), x.avd, ty);
    ty += 8.4;
    if (ty > H - 22) { footer(); pdf.addPage(); drawBannerSlim(pdf, W, comp); ty = 44; tabellhuvud(); }
  }
  footer();
}

export async function downloadControlPdf(comp, control, courseCtx = {}) {
  const pdf = await generateControlPdf(comp, control, courseCtx);
  const safe = (control.name || 'kontroll').replace(/[^\w\-åäöÅÄÖ]+/g, '_');
  pdf.save(`kontroll-${control.nummer ?? ''}-${safe}.pdf`);
}

// ===========================================================================
// FÄLTPAKET — alla kontrollers KOMPLETTA paket i en enda fil att skriva ut.
// Varje kontroll bidrar med samma sidor som dess egen PDF: placering med
// karta och QR, instruktioner, nödinfo och reservprotokoll.
//
// Varje kontroll måste börja på en UDDA sida. Skrivs bunten ut dubbelsidigt
// hamnar annars en kontrolls första sida på baksidan av föregående kontrolls
// sista — och den som river isär bunten till kontrollernas pärmar får
// halva paket. En blank sida skjuts därför in när det behövs.
// ===========================================================================

// Sant när nästa sida skulle bli en jämn sida — dvs. en baksida.
const behöverUtfyllnad = (pdf) => pdf.getNumberOfPages() % 2 === 1;

function drawBlankFillerPage(pdf) {
  pdf.addPage();
  pdf.setFont('helvetica', 'italic');
  pdf.setFontSize(8);
  pdf.setTextColor('#c8d2dc');
  pdf.text('Denna sida är avsiktligt tom — nästa kontroll börjar på en ny framsida.', 105, 148, { align: 'center' });
}

export async function generateFieldPackPdf(comp, controls, patrols, mgmt = [], { onProgress = null, track = null } = {}) {
  await ensureLibs();
  const ordered = [...controls].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
  // Banans ben ger kartorna sin "väg in / väg ut"-kontext, precis som när en
  // enskild kontroll skrivs ut från sin egen sida.
  const { nodes, legs } = courseLegs(comp, ordered, track);

  let pdf = null;
  for (const [i, c] of ordered.entries()) {
    onProgress?.(i + 1, ordered.length);
    if (pdf && behöverUtfyllnad(pdf)) drawBlankFillerPage(pdf);
    const idx = nodes.findIndex(n => n.key === c.id);
    pdf = await generateControlPdf(comp, c, {
      legIn: idx > 0 ? legs[idx - 1] : null,
      legOut: idx >= 0 && idx < legs.length ? legs[idx] : null,
      patrols, mgmt, allControls: ordered, pdf
    });
  }
  return pdf;
}

export async function downloadFieldPackPdf(comp, controls, patrols, mgmt, opts = {}) {
  const pdf = await generateFieldPackPdf(comp, controls, patrols, mgmt, opts);
  if (!pdf) throw new Error('Inga kontroller att skriva ut.');
  pdf.save(`faltpaket-${(comp.shortName || 'tavling').toLowerCase().replace(/[^\wåäö-]+/gi, '-')}${comp.year ? '-' + comp.year : ''}.pdf`);
}

// ===========================================================================
// STARTKORT — a one-page handout for a patrol with QR to their scout-side
// landing page. Same visual language as the control PDF.
// ===========================================================================
const AVD_COLOR = {
  'Spårare':    '#41A62A',
  'Upptäckare': '#00A8E1',
  'Äventyrare': '#E95F13',
  'Utmanare':   '#DA005E',
  'Rover':      '#E2E000',
  'Ledare':     '#282727'
};

function drawStartBanner(pdf, W, comp, patrol) {
  const bannerH = 72;
  const accent = AVD_COLOR[patrol.avdelning] || '#003660';
  pdf.setFillColor(BLUE);
  pdf.rect(0, 0, W, bannerH, 'F');
  pdf.setFillColor(accent);
  pdf.rect(0, 0, 8, bannerH, 'F');  // thin avdelnings-färg-remsa

  pdf.setTextColor(YELLOW);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  const eyebrowParts = ['ESKIL · STARTKORT'];
  const compLabel = `${comp.shortName || comp.name}${comp.year ? ' ' + comp.year : ''}`;
  if (compLabel.trim()) eyebrowParts.push(compLabel);
  if (comp.location) eyebrowParts.push(comp.location);
  pdf.text(eyebrowParts.join(' · '), W - 15, 12, { align: 'right' });

  // Huge patrol number
  const numStr = `#${patrol.number ?? ''}`;
  const numFont = 110;
  pdf.setTextColor('#ffffff');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(numFont);
  const capHeight = numFont * 0.72 * 0.3528;
  const baselineY = (bannerH + capHeight) / 2 + 1;
  pdf.text(numStr, 18, baselineY);
  const numWidth = pdf.getTextWidth(numStr);

  const textX = 18 + numWidth + 12;
  pdf.setDrawColor('#3a6389');
  pdf.setLineWidth(0.4);
  pdf.line(textX - 6, 18, textX - 6, bannerH - 14);

  // Patrol name
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(22);
  pdf.setTextColor('#ffffff');
  pdf.text(patrol.name || '', textX, 32, { maxWidth: W - 15 - textX });

  // Avdelning label (pill-esque)
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(YELLOW);
  pdf.text('AVDELNING', textX, 48);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(12);
  pdf.setTextColor('#ffffff');
  const meta = [];
  if (patrol.avdelning) meta.push(patrol.avdelning);
  if (patrol.antal) meta.push(`${patrol.antal} deltagare`);
  pdf.text(meta.join('   ·   ') || '—', textX, 56);

  // Kår on a third line if present
  if (patrol.kar) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.setTextColor('#a7bccf');
    pdf.text(patrol.kar, textX, 64);
  }
}

export async function generateStartPdf(comp, patrol) {
  await ensureLibs();
  const url = startUrl(comp.id, patrol.id);
  const qr = await qrDataUrl(url, 700);

  // eslint-disable-next-line no-undef
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, H = 297;

  drawStartBanner(pdf, W, comp, patrol);

  // Body: QR left, info right (mirrors the control PDF rhythm)
  const bodyTop = 86;
  const qrSize = 90;

  pdf.addImage(qr, 'PNG', 15, bodyTop, qrSize, qrSize);

  const textX = 15 + qrSize + 10;
  const textW = W - 15 - textX;
  let ty = bodyTop + 4;

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(ORANGE);
  pdf.text('STARTKORT', textX, ty);
  ty += 7;

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(12);
  pdf.setTextColor('#282727');
  const lines = pdf.splitTextToSize('Skanna QR-koden för att öppna patrullens digitala startkort — kontroller, karta och poäng.', textW);
  pdf.text(lines, textX, ty);
  ty += lines.length * 5.3 + 6;

  if (comp.date) {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor('#8a8a8a');
    pdf.text('DATUM', textX, ty);
    ty += 5;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    pdf.setTextColor('#282727');
    pdf.text(String(comp.date), textX, ty);
    ty += 8;
  }

  // Management contacts if present (public roles only on startkort)
  const active = publicManagement(comp);
  if (active.length) {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.setTextColor(ORANGE);
    pdf.text('KONTAKTER', 15, bodyTop + qrSize + 18);
    let my = bodyTop + qrSize + 26;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    for (const r of active) {
      pdf.setTextColor('#8a8a8a');
      pdf.text(r.label.toUpperCase(), 15, my);
      pdf.setTextColor('#282727');
      const parts = [];
      if (r.name) parts.push(r.name);
      if (r.phone) parts.push(r.phone);
      if (r.email) parts.push(r.email);
      pdf.text(parts.join('  ·  '), 50, my);
      my += 6;
    }
  }

  // Footer
  pdf.setTextColor('#a7bccf');
  pdf.setFontSize(8);
  pdf.text('ESKIL — scouttävlingssystem', 15, H - 10);
  pdf.text('Startkort', W - 15, H - 10, { align: 'right' });

  return pdf;
}

export async function downloadStartPdf(comp, patrol) {
  const pdf = await generateStartPdf(comp, patrol);
  const safe = (patrol.name || 'patrull').replace(/[^\w\-åäöÅÄÖ]+/g, '_');
  pdf.save(`startkort-${patrol.number ?? ''}-${safe}.pdf`);
}

// ===========================================================================
// MANUELLT STARTKORT — för patruller utan mobil.
//
// A4 liggande, avsett att vikas på mitten till A5. Utskrivet dubbelsidigt ger
// det ett A5-häfte: kartan invikt (vik ut för att navigera), information och
// poängkort utåt (att fylla i vid kontrollerna).
//
//   Sida 1   hela A4 = bankartan, så stor som papperet tillåter
//   Sida 2   vänster halva = information, höger halva = poängkort
//
// ANONYMA KONTROLLER: när comp.anonymousControls är på får poängkortet INTE
// avslöja kontrollernas namn — patrullen bär kortet hela dagen, och namnet
// säger vad uppgiften handlar om. Då blir namnkolumnen en skrivrad i stället.
// ===========================================================================

const A4L = { W: 297, H: 210 };
const FOLD_X = A4L.W / 2;

function drawFoldLine(pdf) {
  pdf.setDrawColor('#c8d2dc');
  pdf.setLineWidth(0.2);
  pdf.setLineDashPattern([2, 2], 0);
  pdf.line(FOLD_X, 0, FOLD_X, A4L.H);
  pdf.setLineDashPattern([], 0);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(6);
  pdf.setTextColor('#9fb0c0');
  pdf.text('VIK HÄR', FOLD_X - 1, A4L.H / 2, { angle: 90, align: 'center' });
}

// Vänstra halvan på sida 2: allt patrullen behöver veta utan telefon.
function drawManualInfo(pdf, comp, patrol, places, startTid, maxMin) {
  const L = 12, R = FOLD_X - 10, w = R - L;
  const tomt = !patrol;                 // reservkort: fylls i för hand
  let y = 16;

  // Skrivrad med etikett — reservkortens motsvarighet till en tryckt uppgift.
  const skrivrad = (etikett, x, bredd, yy) => {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.5);
    pdf.setTextColor('#9fb0c0');
    pdf.text(etikett.toUpperCase(), x, yy - 4.5);
    pdf.setDrawColor('#b9c6d2');
    pdf.setLineWidth(0.3);
    pdf.line(x, yy, x + bredd, yy);
  };

  pdf.setFillColor(BLUE);
  pdf.rect(0, 0, FOLD_X, 26, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(13);
  pdf.setTextColor('#ffffff');
  pdf.text(String(comp.shortName || comp.name || 'Tävling'), L, 13);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor('#a7bccf');
  pdf.text([comp.year, comp.date, comp.location].filter(Boolean).join('  ·  '), L, 20);
  y = 36;

  if (tomt) {
    skrivrad('Patrull', L, 22, y);
    skrivrad('Namn', L + 26, w - 26, y);
    y += 12;
    skrivrad('Avdelning', L, 40, y);
    skrivrad('Kår', L + 44, w - 44, y);
    y += 12;
  } else {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(19);
    pdf.setTextColor('#282727');
    pdf.text(`#${patrol.number ?? ''}  ${patrol.name || ''}`, L, y);
    y += 6;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9.5);
    pdf.setTextColor('#6b7684');
    pdf.text([patrol.avdelning, patrol.kar, patrol.antal ? `${patrol.antal} deltagare` : null]
      .filter(Boolean).join('  ·  '), L, y);
    y += 10;
  }

  // Starttid — den viktigaste raden på hela kortet. På reservkortet är den
  // en ruta att skriva i: kortet delas ut i stunden och tiden är inte känd
  // när det trycks.
  if (tomt) {
    pdf.setFillColor('#eef3f8');
    pdf.rect(L, y - 5, w, 14, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(ORANGE);
    pdf.text('STARTTID', L + 3, y + 1);
    pdf.setDrawColor('#9fb0c0');
    pdf.setLineWidth(0.4);
    pdf.line(L + 32, y + 3.5, L + 74, y + 3.5);
    if (maxMin > 0) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8.5);
      pdf.setTextColor('#6b7684');
      const h = Math.floor(maxMin / 60), m = maxMin % 60;
      pdf.text(`Maxtid ${[h ? h + ' h' : '', m ? m + ' min' : ''].filter(Boolean).join(' ')}`, L + 80, y + 2.5);
    }
    y += 16;
  } else if (startTid) {
    pdf.setFillColor('#eef3f8');
    pdf.rect(L, y - 5, w, 14, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(ORANGE);
    pdf.text('STARTTID', L + 3, y + 1);
    pdf.setFontSize(16);
    pdf.setTextColor('#282727');
    pdf.text(startTid, L + 32, y + 2.5);
    if (maxMin > 0) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8.5);
      pdf.setTextColor('#6b7684');
      const h = Math.floor(maxMin / 60), m = maxMin % 60;
      pdf.text(`Maxtid ${[h ? h + ' h' : '', m ? m + ' min' : ''].filter(Boolean).join(' ')}`, L + 62, y + 2.5);
    }
    y += 16;
  }

  const rubrik = (t) => {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(ORANGE);
    pdf.text(t.toUpperCase(), L, y);
    y += 4.5;
  };
  const brodtext = (t, size = 9) => {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(size);
    pdf.setTextColor('#282727');
    const lines = pdf.splitTextToSize(String(t), w);
    pdf.text(lines, L, y);
    y += lines.length * (size * 0.42) + 3;
  };

  const vagen = places.filter(p => !p.inCourse);
  if (vagen.length) {
    rubrik('Hitta till starten');
    for (const pl of vagen.slice(0, 5)) {
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor('#282727');
      pdf.text(pl.name, L, y);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor('#6b7684');
      pdf.text(`${pl.lat.toFixed(5)}, ${pl.lng.toFixed(5)}`, R, y, { align: 'right' });
      y += 4.6;
    }
    y += 2;
  }

  const mgmt = publicManagement(comp).filter(r => r.phone || r.name);
  if (mgmt.length) {
    rubrik('Tävlingsledning');
    for (const r of mgmt.slice(0, 6)) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor('#6b7684');
      pdf.text(r.label, L, y);
      pdf.setTextColor('#282727');
      pdf.text([r.name, r.phone].filter(Boolean).join('  ·  '), L + 34, y);
      y += 4.6;
    }
    y += 2;
  }

  const info = String(comp.generalInfo || '').trim();
  if (info && y < 150) {
    rubrik('Allmän information');
    brodtext(info.slice(0, 700), 8.5);
  }

  // Nödraden sist och alltid — den ska sitta där ögat landar.
  pdf.setFillColor('#fdecec');
  pdf.rect(L, A4L.H - 26, w, 12, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor('#c8102e');
  pdf.text('Vid olycka: ring 112 först — sedan tävlingsledningen.', L + 3, A4L.H - 18.5);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(6.5);
  pdf.setTextColor('#a7bccf');
  pdf.text('ESKIL — manuellt startkort', L, A4L.H - 8);
}

// Högra halvan: poängkortet patrullen fyller i vid varje kontroll.
function drawScoreCard(pdf, comp, patrol, controls, coursePlaceNodes) {
  const L = FOLD_X + 10, R = A4L.W - 12, w = R - L;
  const anonym = comp.anonymousControls !== false;

  pdf.setFillColor(BLUE);
  pdf.rect(FOLD_X, 0, FOLD_X, 26, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(13);
  pdf.setTextColor('#ffffff');
  pdf.text('POÄNGKORT', L, 13);
  if (patrol) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor('#a7bccf');
    pdf.text(`#${patrol.number ?? ''}  ${patrol.name || ''}`, L, 20);
  } else {
    // Reservkortets poänghalva måste också gå att identifiera — den lämnas
    // in separat vid målgång.
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.5);
    pdf.setTextColor('#a7bccf');
    pdf.text('PATRULL', L, 17);
    pdf.setDrawColor('#7d99b3');
    pdf.setLineWidth(0.3);
    pdf.line(L + 22, 20, R, 20);
  }

  // Raderna: kontroller i nummerordning, med banplatser inflätade så kortet
  // följer samma ordning som kartan.
  const rader = [];
  const efter = new Map();
  for (const nd of coursePlaceNodes) {
    const k = nd.afterNummer ?? -1;
    if (!efter.has(k)) efter.set(k, []);
    efter.get(k).push(nd);
  }
  (efter.get(0) || []).forEach(nd => rader.push({ plats: nd }));
  for (const c of controls) {
    rader.push({ ctrl: c });
    (efter.get(Number(c.nummer)) || []).forEach(nd => rader.push({ plats: nd }));
  }

  const top = 34, bottom = A4L.H - 40;
  // INGET golv på radhöjden. Ett golv får raderna att rita utanför sidan när
  // banan har många kontroller — och då försvinner de sista tyst, vilket är
  // det värsta ett poängkort kan göra. Hellre trångt än ofullständigt; taket
  // håller raderna luftiga när kontrollerna är få.
  const rowH = Math.min(11, (bottom - top - 8) / Math.max(1, rader.length));
  const fs = Math.max(5.5, Math.min(10, rowH * 0.82));

  // Kolumner: nr, namn/skrivrad, poäng, extra, sign
  const cNr = L + 6, cNamn = L + 13, cPo = R - 46, cEx = R - 30, cSi = R - 14;

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(7);
  pdf.setTextColor('#6b7684');
  pdf.text('NR', cNr, top - 3, { align: 'center' });
  pdf.text(anonym ? 'KONTROLL' : 'KONTROLL', cNamn, top - 3);
  pdf.text('POÄNG', cPo, top - 3, { align: 'center' });
  pdf.text('EXTRA', cEx, top - 3, { align: 'center' });
  pdf.text('SIGN', cSi, top - 3, { align: 'center' });
  pdf.setDrawColor('#003660');
  pdf.setLineWidth(0.4);
  pdf.line(L, top - 1, R, top - 1);

  let y = top;
  pdf.setLineWidth(0.15);
  for (const rad of rader) {
    const mitt = y + rowH / 2 + fs * 0.12;
    if (rad.plats) {
      // Banplats: ingen poängruta — den ger inga poäng och ska inte se ut
      // som en kontroll man kan glömma att fylla i.
      pdf.setFillColor('#f3f6f9');
      pdf.rect(L, y, w, rowH, 'F');
      pdf.setFont('helvetica', 'italic');
      pdf.setFontSize(fs - 0.5);
      pdf.setTextColor('#6b7684');
      pdf.text(rad.plats.title || 'Plats', cNamn, mitt);
    } else {
      const c = rad.ctrl;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(fs);
      pdf.setTextColor('#282727');
      pdf.text(String(c.nummer ?? '?'), cNr, mitt, { align: 'center' });
      pdf.setFont('helvetica', 'normal');
      if (anonym) {
        // Skrivrad i stället för namn: kontrollanten fyller i, kortet
        // avslöjar ingenting i förväg.
        pdf.setDrawColor('#dbe3ea');
        pdf.line(cNamn, mitt + 1.2, cPo - 12, mitt + 1.2);
      } else {
        pdf.setTextColor('#282727');
        pdf.text(pdf.splitTextToSize(c.name || '', cPo - 14 - cNamn)[0] || '', cNamn, mitt);
        if (Number.isFinite(Number(c.maxPoang))) {
          pdf.setTextColor('#9fb0c0');
          pdf.setFontSize(fs - 1.5);
          pdf.text(`max ${c.maxPoang}`, cPo - 13, mitt, { align: 'right' });
        }
      }
      // Ifyllnadsrutor
      pdf.setDrawColor('#b9c6d2');
      pdf.setLineWidth(0.25);
      const boxH = Math.max(2.4, rowH - 1.6);
      for (const cx of [cPo, cEx, cSi]) pdf.rect(cx - 7, y + (rowH - boxH) / 2, 14, boxH);
      pdf.setLineWidth(0.15);
    }
    pdf.setDrawColor('#e6ecf2');
    pdf.line(L, y + rowH, R, y + rowH);
    y += rowH;
  }

  // Summering + start/mål-tider
  const fy = Math.min(y + 8, A4L.H - 32);
  pdf.setDrawColor('#003660');
  pdf.setLineWidth(0.4);
  pdf.line(L, fy - 4, R, fy - 4);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor('#282727');
  pdf.text('SUMMA', L, fy + 2);
  pdf.setDrawColor('#b9c6d2');
  pdf.setLineWidth(0.3);
  pdf.rect(cPo - 7, fy - 3, 14, 8);
  pdf.rect(cEx - 7, fy - 3, 14, 8);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor('#6b7684');
  const ty = fy + 14;
  pdf.text('Start kl', L, ty);
  pdf.line(L + 14, ty + 0.8, L + 40, ty + 0.8);
  pdf.text('Mål kl', L + 46, ty);
  pdf.line(L + 58, ty + 0.8, L + 84, ty + 0.8);

  pdf.setFontSize(6.5);
  pdf.setTextColor('#a7bccf');
  pdf.text('Lämnas till sekretariatet vid målgång.', L, A4L.H - 8);
}

/**
 * @param mapUrl  förrenderad bankarta (courseMapDataUrl) — skickas in så en
 *                massutskrift kan återanvända samma bild för alla patruller
 *                i stället för att hämta tiles per patrull.
 */
export async function generateManualStartPdf(comp, patrol, controls, opts = {}) {
  await ensureLibs();
  const { mapUrl = null, places = [], coursePlaceNodes = [], startTid = null, pdf: existing = null } = opts;
  // eslint-disable-next-line no-undef
  const { jsPDF } = window.jspdf;
  const pdf = existing || new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  if (existing) pdf.addPage('a4', 'landscape');

  // --- Sida 1: kartan, så stor papperet tillåter ---
  if (mapUrl) {
    pdf.addImage(mapUrl, 'JPEG', 4, 4, A4L.W - 8, A4L.H - 8);
  } else {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    pdf.setTextColor('#6b7684');
    pdf.text('Ingen karta kunde ritas — kontrollerna saknar positioner.', A4L.W / 2, A4L.H / 2, { align: 'center' });
  }
  // Ingen patrulluppgift här — kartsidan är bara karta. Patrullen står på
  // andra sidan, och kompassen och skalstocken ligger i bilden.
  drawFoldLine(pdf);

  // --- Sida 2: information + poängkort ---
  pdf.addPage('a4', 'landscape');
  drawManualInfo(pdf, comp, patrol, places, startTid,
    Number(comp.startTimes?.maxTimeMinutes) || 0);
  drawScoreCard(pdf, comp, patrol, controls, coursePlaceNodes);
  drawFoldLine(pdf);

  return pdf;
}

// Ett kort, eller alla patrullers i EN fil. Kartan renderas en gång: den
// kostar ~50 kartrutor, och 30 patruller ska inte bli 1500 hämtningar.
/**
 * @param patrols  en patrull, en lista patruller, eller ANTALET tomma
 *                 reservkort (ett tal). Reservkorten har inga namn och ingen
 *                 starttid — sekretariatet fyller i för hand när ett behövs.
 */
export async function downloadManualStartPdf(comp, patrols, controls, track, places = []) {
  await ensureLibs();
  const reserv = typeof patrols === 'number';
  const lista = reserv
    ? Array.from({ length: Math.max(1, Math.min(50, Math.round(patrols))) }, () => null)
    : (Array.isArray(patrols) ? patrols : [patrols]);
  const ordered = [...(controls || [])]
    .filter(c => Number.isFinite(Number(c.nummer)))
    .sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));

  const karta = await courseMapDataUrl(comp, controls, track, places, { wPx: 1900, hPx: 1328 });

  // Banplatserna som rader i poängkortet, med kontrollnumret de följer.
  const coursePlaceNodes = places
    .filter(pl => pl.inCourse)
    .map(pl => ({ title: pl.name, afterNummer: pl.courseAfter }));

  let pdf = null;
  for (const patrol of lista) {
    pdf = await generateManualStartPdf(comp, patrol, ordered, {
      mapUrl: karta?.url || null, places, coursePlaceNodes,
      startTid: patrol ? patrolStartTime(comp, patrol, lista.length > 1 ? lista.length : null) : null,
      pdf
    });
  }
  const tavling = (comp.shortName || 'tavling').replace(/[^\w\-åäöÅÄÖ]+/g, '_');
  const namn = reserv
    ? `reservkort-${tavling}.pdf`
    : (lista.length === 1
      ? `manuellt-startkort-${lista[0].number ?? ''}-${(lista[0].name || 'patrull').replace(/[^\w\-åäöÅÄÖ]+/g, '_')}.pdf`
      : `manuella-startkort-${tavling}.pdf`);
  pdf.save(namn);
}

// ===========================================================================
// KVITTO — one-page payment receipt for a registration payment. Generated
// client-side when the contact opens their manage page (or by the admin) —
// no server-side mailing exists on the Spark plan.
// ===========================================================================
export async function generateReceiptPdf(comp, reg, payment) {
  await ensureLibs();
  // eslint-disable-next-line no-undef
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, H = 297;

  // Banner
  const bannerH = 46;
  pdf.setFillColor(BLUE);
  pdf.rect(0, 0, W, bannerH, 'F');
  pdf.setTextColor(YELLOW);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.text('ESKIL · SCOUTTÄVLING', 15, 13);
  pdf.setTextColor('#ffffff');
  pdf.setFontSize(26);
  pdf.text('Kvitto', 15, 28);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(11);
  pdf.setTextColor('#a7bccf');
  const compLabel = `${comp.shortName || comp.name || ''}${comp.year ? ' · ' + comp.year : ''}${comp.location ? ' · ' + comp.location : ''}`;
  pdf.text(compLabel, 15, 38);

  // Amount panel
  let y = 62;
  pdf.setFillColor('#f3f6fa');
  pdf.roundedRect(15, y - 8, W - 30, 26, 2, 2, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(ORANGE);
  pdf.text('BETALT BELOPP', 21, y);
  pdf.setFontSize(24);
  pdf.setTextColor(BLUE);
  pdf.text(`${payment.amount} kr`, 21, y + 11);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor('#8a8a8a');
  pdf.text('BETALNINGSREFERENS', W - 21, y, { align: 'right' });
  pdf.setFont('courier', 'bold');
  pdf.setFontSize(16);
  pdf.setTextColor('#282727');
  pdf.text(payment.reference || '', W - 21, y + 10, { align: 'right' });

  // Details
  y += 34;
  const row = (label, value) => {
    if (!value) return;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor('#8a8a8a');
    pdf.text(label.toUpperCase(), 15, y);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    pdf.setTextColor('#282727');
    pdf.text(String(value), 70, y);
    y += 8;
  };
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('sv-SE', { year: 'numeric', month: 'long', day: 'numeric' }) : '';

  row('Registrerad betald', fmtDate(payment.paidAt) || fmtDate(new Date().toISOString()));
  row('Betalning skapad', fmtDate(payment.createdAt));
  row('Kår', reg.kar);
  row('Anmälningsansvarig', reg.contact?.name);
  row('E-post', reg.contact?.email);

  // Patrols summary
  y += 4;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(ORANGE);
  pdf.text('ANMÄLAN OMFATTAR', 15, y);
  y += 8;
  const patrols = reg.patrols || [];
  for (const p of patrols) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    pdf.setTextColor('#282727');
    pdf.text(`• ${p.name}`, 18, y);
    pdf.setTextColor('#8a8a8a');
    pdf.text(`${p.avdelning || ''} · ${p.antal || 0} scouter`, W - 15, y, { align: 'right' });
    y += 7;
  }
  const nScouts = patrols.reduce((s, p) => s + (Number(p.antal) || 0), 0);
  pdf.setDrawColor('#e5e5e5');
  pdf.setLineWidth(0.3);
  pdf.line(15, y - 2, W - 15, y - 2);
  y += 4;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(BLUE);
  pdf.text(`${patrols.length} patrull${patrols.length === 1 ? '' : 'er'} · ${nScouts} scouter`, 15, y);

  // All payments for context (if more than one)
  const payments = reg.payments || [];
  if (payments.length > 1) {
    y += 12;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.setTextColor(ORANGE);
    pdf.text('SAMTLIGA BETALNINGAR FÖR ANMÄLAN', 15, y);
    y += 8;
    for (const p of payments) {
      pdf.setFont('courier', 'normal');
      pdf.setFontSize(10);
      pdf.setTextColor('#282727');
      pdf.text(p.reference || '', 18, y);
      pdf.setFont('helvetica', 'normal');
      pdf.text(`${p.amount} kr`, 80, y);
      pdf.setTextColor(p.paid ? '#2d7a1c' : '#8a6d00');
      pdf.text(p.paid ? `Betald ${fmtDate(p.paidAt)}` : 'Väntar på betalning', W - 15, y, { align: 'right' });
      y += 6;
    }
  }

  // Issuer + footer
  y = Math.max(y + 14, 200);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor('#525252');
  const issuer = comp.organizer ? `Betalningen är mottagen och registrerad av ${comp.organizer}.` : 'Betalningen är mottagen och registrerad av tävlingsledningen.';
  pdf.text(pdf.splitTextToSize(`${issuer} Detta kvitto är genererat av ESKIL och gäller som bekräftelse på inbetald anmälningsavgift.`, W - 30), 15, y);

  pdf.setTextColor('#a7bccf');
  pdf.setFontSize(8);
  pdf.text('ESKIL — scouttävlingssystem', 15, H - 10);
  pdf.text(`Kvitto · ${payment.reference || ''}`, W - 15, H - 10, { align: 'right' });

  return pdf;
}

// Betalningsunderlag — för vidarebefordran till den som faktiskt betalar
// (kassören är sällan den som anmäler). Bär belopp, referens och
// betalningssätt inklusive Swish-QR, men ALDRIG den hemliga ändringslänken:
// hela poängen är att underlaget ska kunna mejlas vidare utan att ge
// mottagaren makt över anmälan.
export async function generatePaymentSlipPdf(comp, reg, payment, methods = []) {
  await ensureLibs();
  // eslint-disable-next-line no-undef
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210;

  // Banner — samma kostym som kvittot.
  pdf.setFillColor(BLUE);
  pdf.rect(0, 0, W, 46, 'F');
  pdf.setTextColor(YELLOW);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.text('ESKIL · SCOUTTÄVLING', 15, 13);
  pdf.setTextColor('#ffffff');
  pdf.setFontSize(26);
  pdf.text('Betalningsunderlag', 15, 28);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(11);
  pdf.setTextColor('#a7bccf');
  pdf.text(`${comp.shortName || comp.name || ''}${comp.year ? ' · ' + comp.year : ''}${comp.location ? ' · ' + comp.location : ''}`, 15, 38);

  // Belopp + referens
  let y = 62;
  pdf.setFillColor('#f3f6fa');
  pdf.roundedRect(15, y - 8, W - 30, 26, 2, 2, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(ORANGE);
  pdf.text('ATT BETALA', 21, y);
  pdf.setFontSize(24);
  pdf.setTextColor(BLUE);
  pdf.text(`${payment.amount} kr`, 21, y + 11);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor('#8a8a8a');
  pdf.text('BETALNINGSREFERENS — MÅSTE ANGES', W - 21, y, { align: 'right' });
  pdf.setFont('courier', 'bold');
  pdf.setFontSize(16);
  pdf.setTextColor('#282727');
  pdf.text(payment.reference || '', W - 21, y + 10, { align: 'right' });

  // Vem betalningen gäller
  y += 32;
  const rad = (label, value) => {
    if (!value) return;
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); pdf.setTextColor('#8a8a8a');
    pdf.text(label.toUpperCase(), 15, y);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(11); pdf.setTextColor('#282727');
    // Bryt mot högermarginalen. En kår som anmäler åtta patruller fick annars
    // raden utskriven rakt ut över sidkanten — namnen fanns i filen men syntes
    // inte på papperet, och kassören såg en till synes kortare anmälan.
    const rader = pdf.splitTextToSize(String(value), W - 70 - 15);
    pdf.text(rader, 70, y);
    y += 8 + (rader.length - 1) * 5.5;
  };
  rad('Kår', reg.kar);
  rad('Patruller', (reg.patrols || []).map(p => p.name).filter(Boolean).join(', '));
  rad('Anmäld av', reg.contact?.name);

  // Ett underlag för en anmälan som ännu inte är bekräftad bär en referens som
  // inte finns i systemet. Betalar kåren på den hamnar pengarna hos kassören
  // utan anmälan att para ihop dem med — säg det, i stället för att låta
  // underlaget se färdigt ut.
  if (payment.preliminar) {
    y += 2;
    pdf.setFillColor('#fff4e5');
    pdf.roundedRect(15, y - 5, W - 30, 16, 2, 2, 'F');
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10); pdf.setTextColor(ORANGE);
    pdf.text('PRELIMINÄRT — anmälan är inte bekräftad än', 21, y + 1);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor('#282727');
    pdf.text('Slutför anmälan i ESKIL innan ni betalar, annars går referensen inte att para ihop.', 21, y + 7);
    y += 18;
  }

  // Betalningssätt
  y += 4;
  for (const m of methods) {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.setTextColor(BLUE);
    if (m.type === 'swish') {
      pdf.text(m.label || 'Swish', 15, y);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(11); pdf.setTextColor('#282727');
      pdf.text(`Swisha ${payment.amount} kr till ${m.number || ''} med referensen ${payment.reference}.`, 15, y + 7);
      // QR med belopp och referens låsta — skanna direkt ur pappret/mejlet.
      try {
        const qr = await qrDataUrl(swishQrString(m.number, payment.amount, payment.reference), 300);
        pdf.addImage(qr, 'PNG', 15, y + 12, 42, 42);
        pdf.setFontSize(9); pdf.setTextColor('#8a8a8a');
        pdf.text('Skanna med Swish-appen — belopp och referens är ifyllda.', 62, y + 32);
        y += 62;
      } catch { y += 14; }
    } else if (m.type === 'bankgiro') {
      pdf.text(m.label || 'Bankgiro', 15, y);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(11); pdf.setTextColor('#282727');
      pdf.text(`Bankgiro ${m.number || ''} — ange referensen ${payment.reference} som meddelande.`, 15, y + 7);
      y += 18;
    } else {
      pdf.text(m.label || 'Faktura', 15, y);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(11); pdf.setTextColor('#282727');
      const info = pdf.splitTextToSize(`${m.info || 'Kontakta tävlingsledningen.'} Uppge referensen ${payment.reference}.`, W - 30);
      pdf.text(info, 15, y + 7);
      y += 12 + info.length * 5;
    }
  }
  if (!methods.length) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(11); pdf.setTextColor('#282727');
    pdf.text('Tävlingsledningen skickar betalningsinstruktioner separat — uppge referensen ovan.', 15, y);
    y += 10;
  }

  // Fot: varför det här papperet är säkert att skicka vidare.
  pdf.setFontSize(9);
  pdf.setTextColor('#8a8a8a');
  pdf.text(pdf.splitTextToSize(
    'Underlaget kan vidarebefordras till den som betalar (t.ex. kårens kassör). Det innehåller ingen personlig länk och ger ingen åtkomst till anmälan. Betalningen bekräftas av tävlingsledningen när den kommit in.',
    W - 30), 15, 282);
  return pdf;
}

export async function downloadPaymentSlipPdf(comp, reg, payment, methods) {
  const pdf = await generatePaymentSlipPdf(comp, reg, payment, methods);
  const safeRef = (payment.reference || 'betalning').replace(/[^\w\-]+/g, '_');
  pdf.save(`betalningsunderlag-${safeRef}.pdf`);
}

export async function downloadReceiptPdf(comp, reg, payment) {
  const pdf = await generateReceiptPdf(comp, reg, payment);
  const safeRef = (payment.reference || 'betalning').replace(/[^\w\-]+/g, '_');
  pdf.save(`kvitto-${safeRef}.pdf`);
}

export async function renderQrToImg(url, size = 256) {
  const data = await qrDataUrl(url, size);
  const img = new Image();
  img.src = data;
  img.width = size; img.height = size;
  img.alt = 'QR-kod till kontrollen';
  img.style.borderRadius = '8px';
  return img;
}
