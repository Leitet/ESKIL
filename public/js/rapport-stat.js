// Tävlingsrapportens siffror — rena funktioner, testade. PDF:en (rapport-pdf.js)
// ritar bara; allt som går att räkna fel räknas här.

import { isNumSet, isPaymentPaid, patrolStartDateTime, antalStartplatser } from './utils.js';

const ms = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'object' && Number.isFinite(v.seconds)) return v.seconds * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
export const tillMs = ms;

export function median(tal) {
  const a = (tal || []).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ISO-vecka (år + vecka) för en tidpunkt — anmälningarna per vecka.
export function isoVecka(datum) {
  const d = new Date(Date.UTC(datum.getFullYear(), datum.getMonth(), datum.getDate()));
  const dag = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dag);
  const arStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const vecka = Math.ceil(((d - arStart) / 86400000 + 1) / 7);
  return { ar: d.getUTCFullYear(), vecka };
}

// --- Anmälningarna -------------------------------------------------------------
// Avanmälda räknas för sig och ingår ALDRIG i summorna. Betalt = facit
// (paidRefs via isPaymentPaid), aldrig anmälarens eget påstående.
export function anmalningsStatistik(regs) {
  const alla = Array.isArray(regs) ? regs : [];
  const aktiva = alla.filter(r => !r.cancelled);
  const perKar = new Map(), perAvd = new Map(), perVecka = new Map();
  let patruller = 0, scouter = 0, belopp = 0, betalt = 0, efter = 0;
  const tider = [];
  for (const r of aktiva) {
    const kar = String(r.kar || '(Okänd kår)').trim() || '(Okänd kår)';
    const k = perKar.get(kar) || { kar, anmalningar: 0, patruller: 0, scouter: 0, belopp: 0, betalt: 0 };
    k.anmalningar += 1;
    for (const p of r.patrols || []) {
      const antal = Number(p.antal) || 0;
      patruller += 1; scouter += antal;
      k.patruller += 1; k.scouter += antal;
      const avd = p.avdelning || '(Okänd)';
      const a = perAvd.get(avd) || { avdelning: avd, patruller: 0, scouter: 0 };
      a.patruller += 1; a.scouter += antal;
      perAvd.set(avd, a);
    }
    for (const pay of r.payments || []) {
      const b = Number(pay.amount) || 0;
      belopp += b; k.belopp += b;
      if (isPaymentPaid(r, pay)) { betalt += b; k.betalt += b; }
    }
    efter += (r.efteranmalningar || []).length;
    perKar.set(kar, k);
    const t = ms(r.createdAt);
    if (t != null) {
      tider.push(t);
      const v = isoVecka(new Date(t));
      const nyckel = `${v.ar}-v${String(v.vecka).padStart(2, '0')}`;
      perVecka.set(nyckel, (perVecka.get(nyckel) || 0) + 1);
    }
  }
  return {
    anmalningar: aktiva.length,
    avanmalda: alla.length - aktiva.length,
    patruller, scouter, belopp, betalt, obetalt: belopp - betalt,
    efteranmalningar: efter,
    karer: [...perKar.values()].sort((a, b) => b.scouter - a.scouter || a.kar.localeCompare(b.kar, 'sv')),
    perAvdelning: [...perAvd.values()],
    perVecka: [...perVecka.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([vecka, antal]) => ({ vecka, antal })),
    forsta: tider.length ? Math.min(...tider) : null,
    sista: tider.length ? Math.max(...tider) : null
  };
}

// --- Deltagandet (patrullistan = de som faktiskt stod på startlistan) ----------
export function deltagarStatistik(patrols) {
  const riktiga = (patrols || []).filter(p => !p.genrep);
  const perAvd = new Map(), perKar = new Map();
  let scouter = 0;
  for (const p of riktiga) {
    const antal = Number(p.antal) || 0;
    scouter += antal;
    const a = perAvd.get(p.avdelning || '(Okänd)') || { avdelning: p.avdelning || '(Okänd)', patruller: 0, scouter: 0 };
    a.patruller += 1; a.scouter += antal; perAvd.set(a.avdelning, a);
    const kar = String(p.kar || '(Okänd kår)');
    const k = perKar.get(kar) || { kar, patruller: 0, scouter: 0 };
    k.patruller += 1; k.scouter += antal; perKar.set(kar, k);
  }
  return {
    patruller: riktiga.length, scouter,
    utgatt: riktiga.filter(p => p.utgatt).length,
    karer: [...perKar.values()].sort((a, b) => b.scouter - a.scouter || a.kar.localeCompare(b.kar, 'sv')),
    perAvdelning: [...perAvd.values()]
  };
}

// --- Patrullernas tider ----------------------------------------------------------
// Start och mål har flera källor; företrädet är detsamma som i Läget:
// funktionär > patrullen själv > härlett. Start faller sist tillbaka på den
// PLANERADE tiden, mål på sista rapporten om ALLA kontroller är rapporterade.
export function patrullTider({ comp, patrols, controls, scores, stationPassages = [], selfPassages = [] }) {
  const stn = new Map(), sjalv = new Map(), sista = new Map(), antal = new Map();
  for (const p of stationPassages) {
    const id = p.patrolId || p.id;
    const cur = stn.get(id) || {};
    const s = ms(p.startAt), f = ms(p.finishAt);
    if (s != null && (cur.start == null || s < cur.start)) cur.start = s;
    if (f != null && (cur.mal == null || f > cur.mal)) cur.mal = f;
    stn.set(id, cur);
  }
  for (const p of selfPassages) sjalv.set(p.patrolId || p.id, { start: ms(p.startAt), mal: ms(p.finishAt) });
  for (const s of scores || []) {
    const t = ms(s.clientReportedAt) ?? ms(s.reportedAt);
    antal.set(s.patrolId, (antal.get(s.patrolId) || 0) + 1);
    if (t != null && (sista.get(s.patrolId) == null || t > sista.get(s.patrolId))) sista.set(s.patrolId, t);
  }
  const nKontroller = (controls || []).length;
  const platser = antalStartplatser(comp, patrols);
  return (patrols || []).filter(p => !p.genrep).map(p => {
    const a = stn.get(p.id) || {}, b = sjalv.get(p.id) || {};
    const planerad = patrolStartDateTime(comp, p, new Date(), platser);
    let startMs = null, startKalla = null, malMs = null, malKalla = null;
    if (a.start != null) { startMs = a.start; startKalla = 'funktionär'; }
    else if (b.start != null) { startMs = b.start; startKalla = 'själv'; }
    else if (planerad) { startMs = planerad.getTime(); startKalla = 'planerad'; }
    if (a.mal != null) { malMs = a.mal; malKalla = 'funktionär'; }
    else if (b.mal != null) { malMs = b.mal; malKalla = 'själv'; }
    else if (nKontroller > 0 && (antal.get(p.id) || 0) >= nKontroller && sista.get(p.id) != null) {
      malMs = sista.get(p.id); malKalla = 'sista rapport';
    }
    const minuter = (startMs != null && malMs != null && malMs > startMs) ? (malMs - startMs) / 60000 : null;
    return { patrol: p, planeradMs: planerad ? planerad.getTime() : null, startMs, startKalla, malMs, malKalla, minuter,
             rapporter: antal.get(p.id) || 0 };
  });
}

// Planerad tid mot verklig. En planerad start som "källa" ger ingen verklig
// tid på banan att lita på i medianen? Jo — starten är då schemat, och det är
// vad sekretariatet hade. Men en tid över 24 h är ett datumfel (tävling utan
// datum ankras på idag) och räknas bort.
export function tidsStatistik(tider, planeradMin = null) {
  const giltiga = (tider || []).map(t => t.minuter).filter(m => Number.isFinite(m) && m > 0 && m < 24 * 60);
  const med = median(giltiga);
  return {
    antal: giltiga.length,
    medianMin: med,
    snabbastMin: giltiga.length ? Math.min(...giltiga) : null,
    langsammastMin: giltiga.length ? Math.max(...giltiga) : null,
    planeradMin: Number.isFinite(planeradMin) ? planeradMin : null,
    diffMin: (med != null && Number.isFinite(planeradMin)) ? med - planeradMin : null
  };
}

// --- Kontrollerna i siffror ------------------------------------------------------
export function kontrollStatistik(controls, scores) {
  const per = new Map();
  for (const s of scores || []) { if (!per.has(s.controlId)) per.set(s.controlId, []); per.get(s.controlId).push(s); }
  return [...(controls || [])].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0)).map(c => {
    const lista = per.get(c.id) || [];
    const medPoang = lista.filter(s => isNumSet(s.poang));
    const max = Number(c.maxPoang) || 0;
    const tider = lista.map(s => Number(s.tidSek)).filter(t => Number.isFinite(t) && t >= 0);
    return {
      control: c,
      rapporter: lista.length,
      snitt: medPoang.length ? medPoang.reduce((x, s) => x + Number(s.poang), 0) / medPoang.length : null,
      maxade: max > 0 ? medPoang.filter(s => Number(s.poang) >= max).length : 0,
      nollor: medPoang.filter(s => Number(s.poang) === 0).length,
      extraSnitt: lista.length ? lista.reduce((x, s) => x + (Number(s.extraPoang) || 0), 0) / lista.length : null,
      tidMedianSek: median(tider),
      tidBastSek: tider.length ? Math.min(...tider) : null,
      ejGenomford: lista.filter(s => s.ejGenomford === true).length
    };
  });
}

// --- Sträckorna: modell mot verklighet --------------------------------------------
// `eta` är courseEtaCalibrated(...) — byKey[nod].obsMin är medianen av verkliga
// mellantider (gång + kö + uppgift) när minst ETA_MIN_SAMPLES patruller passerat.
export function strackStatistik(eta) {
  if (!eta?.nodes?.length) return [];
  const ut = [];
  for (let i = 1; i < eta.nodes.length; i++) {
    const fran = eta.nodes[i - 1], till = eta.nodes[i];
    const a = eta.byKey[fran.key], b = eta.byKey[till.key];
    if (!a || !b) continue;
    const langd = Math.max(0, (b.dist || 0) - (a.dist || 0));
    const gangMin = (langd / 1000) / (eta.speedKmh || 4) * 60;
    const stopp = till.kind === 'control' ? (eta.dwellMin || 0) : till.kind === 'place' ? (Number(till.dwellMin) || 0) : 0;
    ut.push({
      // Kort etikett för de smala kolumnerna: kontrollnummer, S, M — och "P"
      // för en plats i banan, vars namn står i franNamn/tillNamn.
      fran: fran.label || (fran.kind === 'place' ? 'P' : fran.key), till: till.label || (till.kind === 'place' ? 'P' : till.key),
      franNamn: fran.title || '', tillNamn: till.title || '',
      langdM: langd, modellMin: gangMin + stopp,
      verkligMin: Number.isFinite(b.obsMin) ? b.obsMin : null,
      matningar: b.samples || 0
    });
  }
  return ut;
}
