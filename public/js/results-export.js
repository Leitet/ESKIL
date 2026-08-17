// Official results export — PDF (results + post mortem archive) and CSV.
// Downloaded from the admin scoreboard after the competition: the PDF is the
// document you pin to the notice board, mail to kårer and archive; the CSV
// goes to spreadsheets and förbund. Uses the same lazy-loaded jsPDF and the
// ESKIL colours as the other PDFs.

import { ensureLibs, BLUE, ORANGE, YELLOW } from './pdf.js';
import {
  AVDELNINGAR, rankPatrols, rankKarer, utslagControls, utslagRows,
  RANKING_RULES_TEXT, publicManagement, formatDate, isNumSet
} from './utils.js';
import { courseLegs, courseDistance, fmtDist, fmtMin } from './course.js';

// --- Shared computation --------------------------------------------------------

// scores: flat list with {controlId, patrolId, poang, extraPoang, ...}
function computeTotals(patrols, scores) {
  const map = {};
  for (const p of patrols) map[p.id] = { ...p, total: 0, extra: 0, count: 0, perControl: {} };
  for (const s of scores) {
    const row = map[s.patrolId];
    if (!row) continue;
    row.total += Number(s.poang) || 0;
    row.extra += Number(s.extraPoang) || 0;
    row.count += 1;
    row.perControl[s.controlId] = s;
  }
  for (const r of Object.values(map)) r.grand = r.total + r.extra;
  return Object.values(map);
}

function karRows(ranked) {
  const byKar = {};
  for (const t of ranked) {
    const k = t.kar || '(Okänd)';
    if (!byKar[k]) byKar[k] = { kar: k, total: 0, extra: 0, count: 0, maxedCount: 0, patrols: [] };
    byKar[k].total += t.total; byKar[k].extra += t.extra;
    byKar[k].count += t.count; byKar[k].maxedCount += t.maxedCount || 0;
    byKar[k].patrols.push(t);
  }
  return rankKarer(Object.values(byKar).map(r => ({ ...r, grand: r.total + r.extra })));
}

function fileStem(comp) {
  return `${(comp.shortName || comp.name || 'resultat')}-${comp.year || ''}`
    .toLowerCase().replace(/[^a-z0-9åäö]+/gi, '-').replace(/^-|-$/g, '');
}

// --- CSV -----------------------------------------------------------------------
// Semicolon-separated with BOM so Swedish Excel opens it correctly.
// One row per patrol with per-control point columns for the archive.

export function downloadResultsCsv(comp, patrols, controls, scores) {
  const ranked = rankPatrols(computeTotals(patrols, scores), controls);
  const ordered = [...controls].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
  const q = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // block CSV formula injection
    return `"${s.replaceAll('"', '""')}"`;
  };
  const head = [
    'Placering', 'Patrull', 'Nummer', 'Avdelning', 'Kår', 'Kontroller',
    'Maxade', 'Poäng', 'Extrapoäng', 'Totalpoäng',
    ...ordered.map(c => q(`K${c.nummer ?? '?'} ${c.name || ''}`))
  ];
  const rows = ranked.map(r => [
    r.rank, q(r.name), r.number ?? '', q(r.avdelning), q(r.kar), r.count,
    r.maxedCount || 0, r.total, r.extra, r.grand,
    ...ordered.map(c => {
      const s = r.perControl[c.id];
      return s ? (Number(s.poang) || 0) + (Number(s.extraPoang) || 0) : '';
    })
  ]);
  const csv = '﻿' + [head, ...rows].map(r => r.join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `resultat-${fileStem(comp)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- PDF -----------------------------------------------------------------------

function banner(pdf, W, comp, subtitle) {
  pdf.setFillColor(BLUE);
  pdf.rect(0, 0, W, 34, 'F');
  pdf.setTextColor(YELLOW);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.text('ESKIL · SCOUTTÄVLING', 15, 11);
  pdf.setTextColor('#ffffff');
  pdf.setFontSize(17);
  pdf.text(`${comp.shortName || comp.name || ''} ${comp.year ? '· ' + comp.year : ''}`, 15, 20);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(11);
  pdf.setTextColor(YELLOW);
  pdf.text(subtitle, 15, 28);
  const meta = [comp.date ? formatDate(comp.date) : '', comp.location || ''].filter(Boolean).join(' · ');
  if (meta) {
    pdf.setFontSize(9);
    pdf.setTextColor('#a7bccf');
    pdf.text(meta, W - 15, 28, { align: 'right' });
  }
}

function footer(pdf, W, H) {
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor('#8a8a8a');
  pdf.text(`ESKIL — scouttävlingssystem · genererad ${new Date().toLocaleDateString('sv-SE')}`, 15, H - 8);
  pdf.text(`Sida ${pdf.getNumberOfPages()}`, W - 15, H - 8, { align: 'right' });
}

// Section heading; returns new y.
function heading(pdf, y, text, color = BLUE) {
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(13);
  pdf.setTextColor(color);
  pdf.text(text, 15, y);
  return y + 3;
}

// Simple table renderer with page breaks. cols: [{label, w, align?, get}]
function table(pdf, ctx, y, cols, rows, { highlightTop3 = false } = {}) {
  const { W, H, comp } = ctx;
  const x0 = 15;
  const drawHead = (yy) => {
    pdf.setFillColor('#eef2f6');
    pdf.rect(x0, yy - 4.5, W - 30, 6.5, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(BLUE);
    let x = x0 + 2;
    for (const c of cols) {
      pdf.text(c.label, c.align === 'right' ? x + c.w - 2 : x, yy, c.align === 'right' ? { align: 'right' } : undefined);
      x += c.w;
    }
    return yy + 7;
  };
  y = drawHead(y);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  for (const r of rows) {
    if (y > H - 20) {
      footer(pdf, W, H);
      pdf.addPage();
      banner(pdf, W, comp, ctx.subtitle);
      y = drawHead(46);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
    }
    if (highlightTop3 && r._rank <= 3) {
      pdf.setFillColor(r._rank === 1 ? '#fdf6d8' : '#f4f6f8');
      pdf.rect(x0, y - 4, W - 30, 5.8, 'F');
    }
    pdf.setTextColor('#282727');
    let x = x0 + 2;
    for (const c of cols) {
      const v = String(c.get(r) ?? '');
      if (c.bold) pdf.setFont('helvetica', 'bold'); else pdf.setFont('helvetica', 'normal');
      pdf.text(v, c.align === 'right' ? x + c.w - 2 : x, y, c.align === 'right' ? { align: 'right' } : undefined);
      x += c.w;
    }
    y += 5.8;
  }
  return y + 4;
}

function patrolCols(withAvd = true) {
  return [
    { label: '#', w: 10, get: r => r.rank, bold: true },
    { label: 'Patrull', w: withAvd ? 44 : 56, get: r => `${r.name || ''}`.slice(0, 30), bold: true },
    ...(withAvd ? [{ label: 'Avdelning', w: 24, get: r => r.avdelning || '' }] : []),
    { label: 'Kår', w: 46, get: r => (r.kar || '').slice(0, 30) },
    { label: 'Kontr.', w: 14, align: 'right', get: r => r.count },
    { label: 'Max', w: 12, align: 'right', get: r => r.maxedCount || 0 },
    { label: 'Extra', w: 14, align: 'right', get: r => r.extra || 0 },
    { label: 'Totalt', w: 16, align: 'right', get: r => r.grand, bold: true }
  ];
}

// The official results + post mortem archive in one document:
//   Resultat overall → per avdelning → per kår → utslagsfrågor →
//   kontrollerna i siffror → tävlingsfakta & ledning → placeringsregler.
export async function downloadResultsPdf(comp, patrols, controls, scores, registrations = null) {
  await ensureLibs();
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  const ctx = { W, H, comp, subtitle: 'Officiella resultat' };

  const totals = computeTotals(patrols, scores);
  const ranked = rankPatrols(totals, controls).map(r => ({ ...r, _rank: r.rank }));

  banner(pdf, W, comp, 'Officiella resultat');
  let y = 46;

  // Overall
  y = heading(pdf, y, 'Overall — samtliga patruller');
  y = table(pdf, ctx, y + 4, patrolCols(true), ranked, { highlightTop3: true });

  // Per avdelning
  for (const a of AVDELNINGAR) {
    const rows = rankPatrols(totals.filter(t => t.avdelning === a.key), controls)
      .map(r => ({ ...r, _rank: r.rank }));
    if (!rows.length) continue;
    if (y > H - 60) { footer(pdf, W, H); pdf.addPage(); banner(pdf, W, comp, ctx.subtitle); y = 46; }
    y = heading(pdf, y, `${a.key} (${a.range})`, ORANGE);
    y = table(pdf, ctx, y + 4, patrolCols(false), rows, { highlightTop3: true });
  }

  // Per kår
  const kRows = karRows(ranked).map(r => ({ ...r, _rank: r.rank }));
  if (kRows.length) {
    if (y > H - 60) { footer(pdf, W, H); pdf.addPage(); banner(pdf, W, comp, ctx.subtitle); y = 46; }
    y = heading(pdf, y, 'Per kår');
    y = table(pdf, ctx, y + 4, [
      { label: '#', w: 10, get: r => r.rank, bold: true },
      { label: 'Kår', w: 70, get: r => r.kar, bold: true },
      { label: 'Patruller', w: 20, align: 'right', get: r => r.patrols.length },
      { label: 'Kontr.', w: 16, align: 'right', get: r => r.count },
      { label: 'Max', w: 14, align: 'right', get: r => r.maxedCount || 0 },
      { label: 'Extra', w: 16, align: 'right', get: r => r.extra || 0 },
      { label: 'Totalt', w: 18, align: 'right', get: r => r.grand, bold: true }
    ], kRows, { highlightTop3: true });
  }

  // Utslagsfrågor
  for (const c of controls.filter(x => x.utslag && (x.utslagFraga || isNumSet(x.utslagSvar)))) {
    if (y > H - 60) { footer(pdf, W, H); pdf.addPage(); banner(pdf, W, comp, ctx.subtitle); y = 46; }
    y = heading(pdf, y, `Utslagsfråga — kontroll ${c.nummer ?? '?'} · ${c.name || ''}`);
    pdf.setFont('helvetica', 'italic');
    pdf.setFontSize(10);
    pdf.setTextColor('#282727');
    if (c.utslagFraga) { pdf.text(`"${c.utslagFraga}"`, 15, y + 5); y += 6; }
    if (isNumSet(c.utslagSvar)) {
      pdf.setFont('helvetica', 'bold');
      pdf.text(`Rätt svar: ${Number(c.utslagSvar)}`, 15, y + 5); y += 5;
      const per = {};
      for (const t of totals) { const s = t.perControl[c.id]; if (s) per[t.id] = s; }
      const uRows = utslagRows(c, patrols, per).filter(r => r.gissning != null);
      y = table(pdf, ctx, y + 6, [
        { label: 'Patrull', w: 60, get: r => r.patrol.name || '', bold: true },
        { label: 'Kår', w: 60, get: r => r.patrol.kar || '' },
        { label: 'Svar', w: 20, align: 'right', get: r => r.gissning },
        { label: 'Från facit', w: 24, align: 'right', get: r => r.diff === 0 ? 'Rätt!' : '±' + r.diff }
      ], uRows);
    } else { y += 8; }
  }

  // --- Post mortem: tävlingen i siffror -------------------------------------
  footer(pdf, W, H);
  pdf.addPage();
  ctx.subtitle = 'Tävlingsarkiv';
  banner(pdf, W, comp, 'Tävlingsarkiv');
  y = 46;

  const nScouts = patrols.reduce((s, p) => s + (Number(p.antal) || 0), 0);
  const karer = new Set(patrols.map(p => p.kar).filter(Boolean));
  const track = ctx.track;
  y = heading(pdf, y, 'Tävlingen i siffror');
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor('#282727');
  const facts = [
    `${patrols.length} patruller · ${nScouts} scouter · ${karer.size} kårer`,
    `${controls.length} kontroller · ${scores.length} poängrapporter`
  ];
  if (registrations) {
    const active = registrations.filter(r => !r.cancelled);
    const paid = active.reduce((s, r) => s + (r.payments || []).filter(p => p.paid).reduce((x, p) => x + (Number(p.amount) || 0), 0), 0);
    facts.push(`${active.length} anmälningar · ${paid} kr i anmälningsavgifter`);
  }
  if (comp._trackDist) facts.push(`Spårlängd ${fmtDist(comp._trackDist)} (gångtid ca ${fmtMin(comp._trackWalkMin)})`);
  for (const f of facts) { pdf.text('•  ' + f, 15, y + 5); y += 6; }
  y += 6;

  // Kontrollerna i siffror
  const ordered = [...controls].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
  const byCtrl = {};
  for (const s of scores) (byCtrl[s.controlId] ||= []).push(s);
  y = heading(pdf, y, 'Kontrollerna');
  y = table(pdf, ctx, y + 4, [
    { label: 'Nr', w: 10, align: 'right', get: r => r.nummer ?? '' },
    { label: 'Kontroll', w: 64, get: r => (r.name || '').slice(0, 40), bold: true },
    { label: 'Max', w: 14, align: 'right', get: r => r.maxPoang ?? '' },
    { label: 'Rapporter', w: 20, align: 'right', get: r => (byCtrl[r.id] || []).length },
    { label: 'Snitt', w: 16, align: 'right', get: r => {
        const list = byCtrl[r.id] || [];
        return list.length ? (list.reduce((s, x) => s + (Number(x.poang) || 0), 0) / list.length).toFixed(1) : '—';
      } },
    { label: 'Maxade', w: 18, align: 'right', get: r => (byCtrl[r.id] || []).filter(x => (Number(x.poang) || 0) >= (Number(r.maxPoang) || Infinity)).length }
  ], ordered);

  // Tävlingsfakta + ledning
  if (y > H - 70) { footer(pdf, W, H); pdf.addPage(); banner(pdf, W, comp, ctx.subtitle); y = 46; }
  y = heading(pdf, y, 'Om tävlingen');
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor('#282727');
  const om = [
    comp.date ? `Datum: ${formatDate(comp.date)}` : null,
    comp.location ? `Plats: ${comp.location}` : null,
    comp.organizer ? `Arrangör: ${comp.organizer}` : null
  ].filter(Boolean);
  for (const f of om) { pdf.text(f, 15, y + 5); y += 6; }
  if (comp.description) {
    const lines = pdf.splitTextToSize(comp.description, W - 30);
    pdf.text(lines, 15, y + 5); y += lines.length * 5 + 2;
  }
  // publicManagement, INTE activeManagement: den senare filtrerar inte
  // visibility (utils.js:115-122), så en intern rolls privata mobilnummer
  // följde med i en "resultatlista" som delas ut och läggs upp. De interna
  // rollerna finns just för att INTE stå på papper som sprids.
  const mgmt = publicManagement(comp);
  if (mgmt.length) {
    y += 4;
    y = heading(pdf, y, 'Tävlingsledning');
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.setTextColor('#282727');
    for (const r of mgmt) {
      pdf.text(`${r.label}: ${[r.name, r.phone, r.email].filter(Boolean).join(' · ')}`, 15, y + 5);
      y += 6;
    }
  }

  // Placeringsregler
  y += 4;
  if (y > H - 50) { footer(pdf, W, H); pdf.addPage(); banner(pdf, W, comp, ctx.subtitle); y = 46; }
  y = heading(pdf, y, 'Placeringsregler');
  pdf.setFontSize(9);
  pdf.setTextColor('#282727');
  RANKING_RULES_TEXT.forEach((r, i) => {
    pdf.setFont('helvetica', 'bold');
    pdf.text(`${i + 1}. ${r.title}`, 15, y + 5);
    pdf.setFont('helvetica', 'normal');
    const lines = pdf.splitTextToSize(r.rule, W - 30);
    pdf.text(lines, 20, y + 9.5);
    y += 5 + lines.length * 4.2 + 2.5;
  });

  footer(pdf, W, H);
  pdf.save(`resultat-${fileStem(comp)}.pdf`);
}

// Helper for callers that want track stats in the archive section.
export function attachTrackStats(comp, controls, track) {
  if (!track) return comp;
  const { legs, hasDrawn } = courseLegs(comp, controls, track);
  if (!hasDrawn) return comp;
  const dist = courseDistance(legs);
  return { ...comp, _trackDist: dist, _trackWalkMin: (dist / 1000) / (track.speedKmh || 4) * 60 };
}
