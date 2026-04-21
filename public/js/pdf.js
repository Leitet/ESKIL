// PDF generation for a control — two pages:
//   Page 1: Placement — map + placement hint + QR code to reporter URL
//   Page 2: Instructions — one block per avdelning-group
//
// jsPDF and qrcodejs are loaded lazily from CDN on first use.

import { reportUrl, startUrl, allInstructionGroups, publicManagement } from './utils.js';

let jsPDFReady = null;
let qrReady = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function ensureLibs() {
  if (!jsPDFReady) jsPDFReady = loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
  if (!qrReady)    qrReady    = loadScript('https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js');
  await Promise.all([jsPDFReady, qrReady]);
}

async function qrDataUrl(text, size = 600) {
  await ensureLibs();
  const tmp = document.createElement('div');
  tmp.style.position = 'fixed'; tmp.style.left = '-9999px';
  document.body.appendChild(tmp);
  // eslint-disable-next-line no-undef
  new QRCode(tmp, { text, width: size, height: size, correctLevel: QRCode.CorrectLevel.M });
  await new Promise(r => setTimeout(r, 50));
  const img = tmp.querySelector('img');
  const canvas = tmp.querySelector('canvas');
  const url = img ? img.src : canvas?.toDataURL('image/png');
  tmp.remove();
  return url;
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
async function staticMapDataUrl(lat, lng, { zoom = 16, widthTiles = 3, heightTiles = 3 } = {}) {
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

const BLUE   = '#003660';
const ORANGE = '#E95F13';
const YELLOW = '#E2E000';

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
//   │                     ESKIL · Älgjakten 2026 · …  │  eyebrow right-aligned
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

export async function generateControlPdf(comp, control) {
  await ensureLibs();
  const url = reportUrl(comp.id, control.id);
  const [qr, mapImg] = await Promise.all([
    qrDataUrl(url, 700),
    (control.lat && control.lng) ? staticMapDataUrl(control.lat, control.lng) : Promise.resolve(null)
  ]);

  // eslint-disable-next-line no-undef
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
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

  return pdf;
}

export async function downloadControlPdf(comp, control) {
  const pdf = await generateControlPdf(comp, control);
  const safe = (control.name || 'kontroll').replace(/[^\w\-åäöÅÄÖ]+/g, '_');
  pdf.save(`kontroll-${control.nummer ?? ''}-${safe}.pdf`);
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

export async function renderQrToImg(url, size = 256) {
  const data = await qrDataUrl(url, size);
  const img = new Image();
  img.src = data;
  img.width = size; img.height = size;
  img.alt = 'QR-kod till kontrollen';
  img.style.borderRadius = '8px';
  return img;
}
