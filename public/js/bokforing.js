// ESM-spegel av functions/mcp/bokforing.js. Webbläsaren kan inte ladda
// functions/, och Cloud Functions deployar inte public/. Beräkningen ska
// vara identisk — test/bokforing.test.js kräver det. Ändra båda filerna.

// Bokföringsunderlag — ren beräkning, ingen Firestore.
//
// Spegel: public/js/bokforing.js är samma funktioner som ESM, eftersom
// Cloud Functions bara deployar functions/ och webbläsaren bara laddar
// public/. test/bokforing.test.js kräver identiskt utfall. Ändra båda.
//
// VAD SOM INTE FÅR MED. Anmälningsdokumentet bär kontaktperson, fritextsvar
// (allergier), förhinder, Swish-nummer och doc-id som ÄR ändringslänken.
// Funktionen plockar fält för fält. Ett okänt fält faller inte igenom.
//
// BELOPP. ESKIL lagrar inte ett inbetalt belopp. Posten har ett förväntat
// belopp (`payments[].amount`) och en status: referensen ligger i `paidRefs`
// eller inte. `paid`/`paidAt` på posten är arv och räknas bara när paidRefs
// saknas helt — samma gräns som isPaymentPaid i utils.js. En obetald post
// får betaltBelopp null, aldrig 0: en nolla vore ett påhittat belopp.

const FORKLARING = 'ESKIL lagrar inte ett separat inbetalt belopp. Varje betalningspost har ett förväntat belopp, och statusen är om kassören prickat av referensen (paidRefs). När referensen är avprickad räknas hela det förväntade beloppet som betalt. En post som inte är avprickad har inget inbetalt belopp — det visas tomt, inte som 0 kr. Kårens egen markering är ett påstående, inte ett facit. Datum för avprickningen lagras inte i det nuvarande flödet.';

const ATTEST = 'Jag har stämt av underlaget mot inbetalningarna och intygar att de avprickade referenserna stämmer. Underlaget är inte ett kontoutdrag.';

const PRISMODELL = {
  patrull: 'Per patrull',
  scout: 'Per scout',
  kar: 'Fast avgift per kår',
  dynamisk: 'Grundavgift plus pris per enhet'
};

const STATUS_TEXT = {
  betald: 'Betald',
  vantar: 'Väntar',
  karan_sager_betald: 'Kåren säger betald',
  saknar_referens: 'Saknar referens'
};

function kronor(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function summa(tal) {
  const a = (tal || []).filter(n => typeof n === 'number');
  return a.length ? a.reduce((s, n) => s + n, 0) : null;
}

function datum(v) {
  if (v == null || v === '') return null;
  let s = null;
  if (typeof v === 'string') s = v;
  else if (typeof v?.toDate === 'function') {
    try { s = v.toDate().toISOString(); } catch { s = null; }
  } else if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object' && Number.isFinite(v.seconds)) {
    s = new Date(v.seconds * 1000).toISOString();
  }
  if (!s) return null;
  const d = String(s).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

function rapportDatum(nu) {
  if (typeof nu === 'string' && /^\d{4}-\d{2}-\d{2}/.test(nu)) return nu.slice(0, 10);
  const d = nu instanceof Date ? nu : new Date();
  if (Number.isNaN(d.getTime())) return datum(new Date());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dag = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dag}`;
}

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function innebord(betald, forvantat) {
  if (!betald) return 'Inte lagrat';
  if (forvantat == null) return 'Avprickad, men posten saknar belopp';
  return 'Avprickad referens — hela det förväntade beloppet';
}

function avgifterAv(comp) {
  const r = comp?.registration;
  if (!r || typeof r !== 'object') {
    return { konfigurerad: false, obs: 'Inga avgiftsinställningar är sparade.' };
  }
  const p = r.pricing && typeof r.pricing === 'object' ? r.pricing : null;
  const model = p && Object.prototype.hasOwnProperty.call(PRISMODELL, p.model) ? p.model : null;
  const methods = Array.isArray(r.methods) ? r.methods : [];
  return {
    konfigurerad: true,
    aktiverad: r.enabled === true,
    satt: r.mode === 'patrull' || r.mode === 'kar' ? r.mode : null,
    oppnar: text(r.opensAt) || null,
    stanger: text(r.closesAt) || null,
    prismodell: model,
    prismodellText: model ? PRISMODELL[model] : null,
    belopp: p ? {
      perPatrull: kronor(p.perPatrol),
      perScout: kronor(p.perScout),
      fast: kronor(p.flat),
      grund: kronor(p.base),
      enhet: p.unit === 'scout' ? 'scout' : (p.unit === 'patrull' ? 'patrull' : null),
      perEnhet: kronor(p.perUnit)
    } : null,
    // type och label — aldrig number eller info. Swish-numret är oftast
    // kassörens privata mobil (competition-settings.js).
    betalningssatt: methods.map(m => ({
      typ: ['swish', 'bankgiro', 'faktura'].includes(m?.type) ? m.type : null,
      etikett: text(m?.label) || null
    })),
    obs: 'Kontonummer och Swish-nummer lämnas inte ut. Beloppen är de sparade avgiftsinställningarna, inte en beräkning per kår.'
  };
}

function relevantaBelopp(a) {
  if (!a?.konfigurerad || !a.belopp || !a.prismodell) return [];
  const b = a.belopp;
  if (a.prismodell === 'scout') return [['per scout', b.perScout]];
  if (a.prismodell === 'kar') return [['fast avgift', b.fast]];
  if (a.prismodell === 'dynamisk') {
    return [['grundavgift', b.grund], [`per ${b.enhet || 'enhet'}`, b.perEnhet]];
  }
  return [['per patrull', b.perPatrull]];
}

function avgiftSammanfattning(a) {
  if (!a?.konfigurerad) return 'Inga avgiftsinställningar är sparade.';
  const delar = [];
  if (a.aktiverad === false) delar.push('Anmälan är inte aktiverad');
  if (a.satt === 'patrull') delar.push('Patrullvis anmälan');
  else if (a.satt === 'kar') delar.push('Kårvis anmälan');
  if (a.prismodellText) delar.push(a.prismodellText);
  else delar.push('Prismodell är inte ifylld');
  for (const [etikett, belopp] of relevantaBelopp(a)) {
    delar.push(belopp == null ? `${etikett}: belopp är inte ifyllt` : `${etikett}: ${belopp} kr`);
  }
  if (a.oppnar || a.stanger) delar.push(`Period ${a.oppnar || '—'}–${a.stanger || '—'}`);
  const satt = (a.betalningssatt || []).map(m => m.etikett || m.typ).filter(Boolean);
  if (satt.length) delar.push(`Betalningssätt: ${satt.join(', ')}. Kontonummer lämnas inte ut`);
  return delar.join('. ') + '.';
}

/**
 * Status ur facit. paidRefs är kassörens avprickning. Saknas fältet helt
 * gäller den äldre paid-flaggan på posten — finns listan, även tom, vinner den.
 */
function lasStatus(reg, payment) {
  const referens = text(payment?.reference) || null;
  if (!referens) {
    return { referens: null, status: 'saknar_referens', betald: false, pastadd: false, kalla: null };
  }
  const harFacit = Array.isArray(reg?.paidRefs);
  const betald = harFacit ? reg.paidRefs.includes(referens) : payment?.paid === true;
  const pastadd = (reg?.paymentClaims || []).some(c => c && c.reference === referens);
  let status = 'vantar';
  if (betald) status = 'betald';
  else if (pastadd) status = 'karan_sager_betald';
  return { referens, status, betald, pastadd, kalla: harFacit ? 'paidRefs' : 'legacy_paid' };
}

function betalNoteringar(reg, payment, st, forvantat) {
  const ut = [];
  const harFacit = Array.isArray(reg?.paidRefs);
  if (!harFacit && st.betald) {
    ut.push('Avprickningen lästes från den äldre paid-flaggan. paidRefs saknas på anmälan.');
  }
  if (harFacit && payment?.paid === true && !st.betald) {
    ut.push('Posten har en äldre paid-flagga. Den räknas inte: facit är paidRefs och referensen är inte avprickad.');
  }
  if (st.pastadd && !st.betald) {
    ut.push('Kåren har själv markerat referensen som betald. Det är ett påstående, inte kassörens avprickning.');
  }
  if (st.betald && !datum(payment?.paidAt)) ut.push('Datum för avprickningen är inte lagrat.');
  if (st.betald && forvantat == null) ut.push('Referensen är avprickad men posten saknar belopp. Inget inbetalt belopp visas.');
  if (!st.referens) ut.push('Posten saknar referens och kan inte stämmas av.');
  return ut;
}

function efteranmalanNotering(e) {
  if (!e || typeof e !== 'object') return null;
  const delar = [];
  const nya = Array.isArray(e.patrols) ? e.patrols.map(text).filter(Boolean) : [];
  if (nya.length) delar.push(`nya patruller: ${nya.join(', ')}`);
  for (const a of (Array.isArray(e.andrade) ? e.andrade : [])) {
    if (a && text(a.namn)) delar.push(`${text(a.namn)}: ${a.fran ?? '?'} → ${a.till ?? '?'}`);
  }
  const belopp = kronor(e.amount);
  const pengar = [];
  if (belopp != null) pengar.push(`${belopp} kr`);
  if (text(e.reference)) pengar.push(`referens ${text(e.reference)}`);
  const kropp = [delar.join('; '), pengar.join(', ')].filter(Boolean).join(' — ');
  const dag = datum(e.at);
  return `Efteranmälan${dag ? ' ' + dag : ''}${kropp ? ': ' + kropp : ''}.`;
}

function patrullerAv(reg) {
  return (Array.isArray(reg?.patrols) ? reg.patrols : []).map(p => ({
    name: text(p?.name),
    avdelning: text(p?.avdelning),
    antal: kronor(p?.antal) == null ? null : kronor(p?.antal)
  }));
}

function betalningarAv(reg) {
  return (Array.isArray(reg?.payments) ? reg.payments : []).map(p => {
    const st = lasStatus(reg, p);
    const forvantatBelopp = kronor(p?.amount);
    // Bara en avprickad post har ett inbetalt belopp, och då är det postens
    // eget förväntade belopp — inte en andel och inte totalAmount.
    const betaltBelopp = st.betald ? forvantatBelopp : null;
    return {
      referens: st.referens,
      forvantatBelopp,
      betaltBelopp,
      betaltBeloppKalla: innebord(st.betald, forvantatBelopp),
      status: st.status,
      statusText: STATUS_TEXT[st.status] || st.status,
      skapad: datum(p?.createdAt),
      avprickadDatum: st.betald ? datum(p?.paidAt) : null,
      noteringar: betalNoteringar(reg, p, st, forvantatBelopp)
    };
  });
}

function karAv(reg) {
  const patruller = patrullerAv(reg);
  const betalningar = betalningarAv(reg);
  const avanmald = reg?.cancelled === true;
  const noteringar = [];
  if (avanmald) noteringar.push('Avanmäld — ingår inte i totalerna.');
  for (const e of (Array.isArray(reg?.efteranmalningar) ? reg.efteranmalningar : [])) {
    const rad = efteranmalanNotering(e);
    if (rad) noteringar.push(rad);
  }
  const antalScouter = summa(patruller.map(p => p.antal));
  return {
    kar: text(reg?.kar) || '(okänd kår)',
    avanmald,
    patruller,
    antalPatruller: patruller.length,
    antalScouter,
    betalningar,
    noteringar,
    forvantat: summa(betalningar.map(b => b.forvantatBelopp)),
    inbetalt: summa(betalningar.map(b => b.betaltBelopp))
  };
}

function byggUnderlag(comp, regs, opts) {
  const lista = Array.isArray(regs) ? regs : [];
  const karer = lista.map(karAv).sort((a, b) => a.kar.localeCompare(b.kar, 'sv')
    || (a.avanmald === b.avanmald ? 0 : a.avanmald ? 1 : -1));
  const aktiva = karer.filter(k => !k.avanmald);
  const avanmalda = karer.filter(k => k.avanmald);
  const forvantat = summa(aktiva.map(k => k.forvantat));
  const inbetalt = summa(aktiva.map(k => k.inbetalt));
  const ater = summa(avanmalda.map(k => k.inbetalt));
  const noteringar = [];
  if (avanmalda.length) {
    noteringar.push('Avanmälda anmälningar ingår inte i totalerna.');
  }
  if (ater != null) {
    noteringar.push(`Avanmälda har avprickade poster på ${ater} kr. Det är samma förväntade belopp, inte ett separat återbetalt belopp, och kan behöva återbetalas.`);
  }
  return {
    skapad: rapportDatum(opts?.nu),
    tavling: {
      namn: text(comp?.name) || null,
      kortnamn: text(comp?.shortName) || null,
      datum: text(comp?.date) || null,
      ar: kronor(comp?.year)
    },
    forklaring: FORKLARING,
    avgifter: avgifterAv(comp),
    karer,
    totaler: {
      anmalningar: aktiva.length,
      avanmalda: avanmalda.length,
      patruller: aktiva.reduce((s, k) => s + k.antalPatruller, 0),
      scouter: summa(aktiva.map(k => k.antalScouter)),
      forvantat,
      inbetalt,
      kvar: typeof forvantat === 'number' ? forvantat - (typeof inbetalt === 'number' ? inbetalt : 0) : null,
      aterbetalning: ater
    },
    noteringar,
    attest: ATTEST
  };
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[;"\r\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function csvBelopp(n) {
  if (typeof n !== 'number') return '';
  return Number.isInteger(n) ? String(n) : String(n);
}

function tillCsv(underlag) {
  const huvud = ['Rad', 'Kår', 'Avanmäld', 'Patrull', 'Avdelning', 'Antal scouter',
    'Referens', 'Förväntat belopp (kr)', 'Betalt belopp (kr)', 'Innebörd', 'Status',
    'Skapad', 'Avprickad', 'Notering'];
  const rader = [huvud];
  const rad = (o) => huvud.map((_, i) => csvCell(o[i]));
  rader.push(rad(['Förklaring', '', '', '', '', '', '', '', '', '', '', '', '', underlag.forklaring]));
  rader.push(rad(['Avgift', '', '', '', '', '', '', '', '', '', '', '', '', avgiftSammanfattning(underlag.avgifter)]));
  for (const k of underlag.karer) {
    const av = k.avanmald ? 'ja' : 'nej';
    if (!k.patruller.length) {
      rader.push(rad(['Patrull', k.kar, av, '', '', '', '', '', '', '', '', '', '', 'Inga patruller i anmälan.']));
    }
    for (const p of k.patruller) {
      rader.push(rad(['Patrull', k.kar, av, p.name, p.avdelning, p.antal, '', '', '', '', '', '', '', '']));
    }
    if (!k.betalningar.length) {
      rader.push(rad(['Betalning', k.kar, av, '', '', '', '', '', '', 'Inte lagrat', '', '', '',
        'Ingen betalningspost. Inget förväntat eller inbetalt belopp är lagrat.']));
    }
    for (const b of k.betalningar) {
      rader.push(rad(['Betalning', k.kar, av, '', '', '', b.referens, csvBelopp(b.forvantatBelopp),
        csvBelopp(b.betaltBelopp), b.betaltBeloppKalla, b.statusText, b.skapad, b.avprickadDatum,
        b.noteringar.join(' ')]));
    }
    for (const n of k.noteringar) rader.push(rad(['Notering', k.kar, av, '', '', '', '', '', '', '', '', '', '', n]));
  }
  const t = underlag.totaler;
  rader.push(rad(['Total', 'Aktiva', '', '', '', t.scouter, '', csvBelopp(t.forvantat), csvBelopp(t.inbetalt),
    '', '', '', '',
    `Anmälningar ${t.anmalningar}, patruller ${t.patruller}. Kvar att pricka av: ${t.kvar == null ? '—' : t.kvar} kr. Tomt betalt belopp betyder att inget inbetalt belopp är lagrat.`]));
  if (t.aterbetalning != null) {
    rader.push(rad(['Total', 'Avanmälda, avprickat', '', '', '', '', '', '', csvBelopp(t.aterbetalning),
      'Avprickad referens — hela det förväntade beloppet', '', '', '',
      'Ingår inte i totalen ovan.']));
  }
  for (const n of underlag.noteringar) rader.push(rad(['Notering', '', '', '', '', '', '', '', '', '', '', '', '', n]));
  rader.push(rad(['Attest', '', '', '', '', '', '', '', '', '', '', '', '', underlag.attest]));
  rader.push(rad(['Attest', 'Kassör', '', '', '', '', '', '', '', '', '', '', '', '']));
  rader.push(rad(['Attest', 'Datum', '', '', '', '', '', '', '', '', '', '', '', '']));
  rader.push(rad(['Attest', 'Signatur', '', '', '', '', '', '', '', '', '', '', '', '']));
  return '﻿' + rader.map(r => r.join(';')).join('\r\n');
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function kr(n) {
  if (typeof n !== 'number') return '—';
  const negativ = n < 0;
  const abs = Math.abs(n);
  const hel = Number.isInteger(abs);
  const s = hel ? String(abs) : abs.toFixed(2).replace('.', ',');
  const [a, b] = s.split(',');
  const med = a.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return (negativ ? '−' : '') + (b ? `${med},${b}` : med);
}

function krCell(n) {
  return `<td class="num">${escapeHtml(kr(n))}${typeof n === 'number' ? ' kr' : ''}</td>`;
}

function antalText(n, en, flera) {
  if (n == null) return `— ${flera}`;
  return `${n} ${Number(n) === 1 ? en : flera}`;
}

function tabell(huvud, rader) {
  return `<table>
    <thead><tr>${huvud.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${rader.join('')}</tbody>
  </table>`;
}

function tillHtml(underlag) {
  const t = underlag.totaler;
  const tavling = underlag.tavling || {};
  const rubrik = tavling.namn || tavling.kortnamn || 'Tävling';
  const underrad = [tavling.kortnamn, tavling.datum, tavling.ar].filter(v => v != null && v !== '' && v !== tavling.namn).join(' · ');
  const summaRader = [
    ['Anmälningar (aktiva)', String(t.anmalningar)],
    ['Avanmälda', String(t.avanmalda)],
    ['Patruller', String(t.patruller)],
    ['Scouter', t.scouter == null ? '—' : String(t.scouter)],
    ['Förväntat belopp', kr(t.forvantat) + (typeof t.forvantat === 'number' ? ' kr' : '')],
    ['Inbetalt enligt avprickning', kr(t.inbetalt) + (typeof t.inbetalt === 'number' ? ' kr' : '')],
    ['Kvar att pricka av', kr(t.kvar) + (typeof t.kvar === 'number' ? ' kr' : '')]
  ];
  if (t.aterbetalning != null) {
    summaRader.push(['Avprickat på avanmälda (möjlig återbetalning)', `${kr(t.aterbetalning)} kr`]);
  }
  const karHtml = underlag.karer.map(k => {
    const patrullRader = k.patruller.length
      ? k.patruller.map(p => `<tr><td>${escapeHtml(p.name || '—')}</td><td>${escapeHtml(p.avdelning || '—')}</td><td class="num">${p.antal == null ? '—' : escapeHtml(String(p.antal))}</td></tr>`).join('')
      : '<tr><td colspan="3">Inga patruller i anmälan.</td></tr>';
    const betalRader = k.betalningar.length
      ? k.betalningar.map(b => `<tr>
          <td>${escapeHtml(b.referens || '—')}</td>
          ${krCell(b.forvantatBelopp)}
          ${krCell(b.betaltBelopp)}
          <td>${escapeHtml(b.betaltBeloppKalla)}</td>
          <td>${escapeHtml(b.statusText)}</td>
          <td>${escapeHtml(b.skapad || '—')}</td>
          <td>${escapeHtml(b.avprickadDatum || '—')}</td>
          <td>${escapeHtml(b.noteringar.join(' '))}</td>
        </tr>`).join('')
      : '<tr><td colspan="8">Ingen betalningspost. Inget förväntat eller inbetalt belopp är lagrat.</td></tr>';
    const noter = k.noteringar.length
      ? `<ul>${k.noteringar.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
      : '';
    return `<section class="kar">
      <h2>${escapeHtml(k.kar)}${k.avanmald ? ' (avanmäld)' : ''}</h2>
      <p class="muted">${antalText(k.antalPatruller, 'patrull', 'patruller')} · ${antalText(k.antalScouter, 'scout', 'scouter')}</p>
      ${tabell(['Patrull', 'Avdelning', 'Antal scouter'], [patrullRader])}
      ${tabell(['Referens', 'Förväntat', 'Betalt', 'Innebörd', 'Status', 'Skapad', 'Avprickad', 'Notering'], [betalRader])}
      ${noter}
    </section>`;
  }).join('');

  const noter = underlag.noteringar.length
    ? `<h2>Noteringar</h2><ul>${underlag.noteringar.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
    : '';

  return `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>Bokföringsunderlag — ${escapeHtml(rubrik)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #1a1a1a; font: 11pt/1.35 Arial, Helvetica, sans-serif; }
  h1 { font-size: 16pt; margin: 0 0 2px; }
  h2 { font-size: 13pt; margin: 16px 0 6px; break-after: avoid; }
  p { margin: 4px 0; }
  .kicker { color: #003660; font-size: 9pt; font-weight: 700; letter-spacing: .04em; margin: 0; }
  .muted { color: #444; }
  table { border-collapse: collapse; margin: 4px 0 10px; width: 100%; }
  th, td { border: 1px solid #bbb; padding: 3px 6px; text-align: left; vertical-align: top; }
  th { background: #e8eef4; }
  .num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  .kar { margin-top: 8px; }
  .attest { border-top: 1.5px solid #003660; margin-top: 22px; padding-top: 10px; }
  .sign { margin-top: 18px; }
  .linje { border-bottom: 1px solid #222; display: inline-block; height: 1.1em; margin-right: 18px; min-width: 220px; }
  @media print { .no-print { display: none; } }
</style>
</head>
<body>
<p class="no-print">A4. Använd webbläsarens utskrift för att spara en PDF. <button type="button" onclick="window.print()">Skriv ut / PDF</button></p>
<p class="kicker">ESKIL · BOKFÖRINGSUNDERLAG</p>
<h1>${escapeHtml(rubrik)}</h1>
${underrad ? `<p class="muted">${escapeHtml(underrad)}</p>` : ''}
<p class="muted">Sammanställt ${escapeHtml(underlag.skapad)}. Kontaktpersoner, e-post, telefon, fritextsvar och kontonummer ingår inte.</p>
<h2>Sammanfattning</h2>
${tabell(['', ''], summaRader.map(([e, v]) => `<tr><th>${escapeHtml(e)}</th><td>${escapeHtml(v)}</td></tr>`))}
<p class="muted">${escapeHtml(underlag.forklaring)}</p>
<h2>Avgifter</h2>
<p>${escapeHtml(avgiftSammanfattning(underlag.avgifter))}</p>
<h2>Per kår</h2>
${karHtml || '<p>Inga anmälningar.</p>'}
${noter}
<section class="attest">
  <h2>Attest</h2>
  <p>${escapeHtml(underlag.attest)}</p>
  <p class="sign">Kassör <span class="linje"></span></p>
  <p class="sign">Datum <span class="linje"></span></p>
  <p class="sign">Signatur <span class="linje"></span></p>
</section>
</body>
</html>`;
}

export {
  FORKLARING, ATTEST, STATUS_TEXT,
  byggUnderlag, tillCsv, tillHtml, avgifterAv, avgiftSammanfattning
};

function filnamn(comp, ext) {
  const stam = String(comp?.slug || comp?.shortName || comp?.name || 'tavling')
    .toLowerCase()
    .replace(/[^a-z0-9åäö]+/gi, '-')
    .replace(/^-|-$/g, '') || 'tavling';
  return `bokforing-${stam}.${ext}`;
}

function spara(blob, namn) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = namn;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Semikolonseparerad CSV med BOM, samma fil som MCP-verktyget lämnar. */
export function laddaNerBokforingCsv(comp, regs) {
  const csv = tillCsv(byggUnderlag(comp, regs));
  spara(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filnamn(comp, 'csv'));
}

/**
 * Öppnar den utskrivbara A4-sidan. Webbläsarens utskrift sparar den som PDF.
 * Blockeras fönstret laddas sidan ner i stället.
 */
export function oppnaBokforingSida(comp, regs) {
  const html = tillHtml(byggUnderlag(comp, regs));
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank');
  if (!w) spara(blob, filnamn(comp, 'html'));
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
