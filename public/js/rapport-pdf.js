// Tävlingsrapporten — EN PDF som samlar utvärderingen och allt systemet redan
// vet om tävlingen: försättsblad, utvärdering med bilder, bana med planerad och
// verklig tid, kontrollerna med instruktioner, anmälningar, start- och
// måltider, kompletta resultat, dagens meddelanden och inställningarna.
//
// Den här filen RITAR bara. Siffrorna räknas i rapport-stat.js (testad),
// resultatdelen är samma kod som den officiella resultat-PDF:en
// (ritaResultat i results-export.js), kartan är courseMapDataUrl och tiderna
// kommer ur course.js — ingen egen ETA, ingen egen rangordning.
//
// Rapporten är LEDNINGENS dokument: den bär även de interna rollernas namn och
// e-post (aldrig telefon — den sprids vidare) och går därför bara att ta ut
// från inställningssidan, som är admin-only. Efter avslut är namnen gallrade;
// rapporten säger det då rakt ut i stället för att visa tomma rader.

import { ensureLibs, BLUE, ORANGE, YELLOW, courseMapDataUrl, renderQrToImg } from './pdf.js';
import { banner, footer, heading, table, computeTotals, ritaResultat, fileStem } from './results-export.js';
import {
  rankPatrols, RANKING_RULES_TEXT, activeManagement, allowedAvdelningar, formatDate,
  allInstructionGroups, isNumSet, startTimeSettings, startTimesPublished, antalStartplatser,
  startlistaLuckor, patrolStartTime, courseHidden, registrationSettings, REG_PRICING_MODELS
} from './utils.js';
import { courseEta, courseEtaCalibrated, fmtDist, fmtMin } from './course.js';
import { compPlaces, placeKind } from './places.js';
import { districtName } from './districts.js';
import { UTV_SEKTIONER, UTV_ANTECKNINGAR, OVERLAMNING_ARRANGOR, OVERLAMNING_ADRESS, normUtvardering, utvarderingBildIds } from './utvardering.js';
import { formateraKod } from './overlamningskod.js';
import {
  anmalningsStatistik, deltagarStatistik, patrullTider, tidsStatistik, kontrollStatistik,
  strackStatistik, tillMs
} from './rapport-stat.js';
import { formateraTid } from './tidspoang.js';

const MORK = '#282727', GRA = '#6b7280';

// jsPDF:s standardtypsnitt är WinAnsi (cp1252). Ett tecken utanför — en emoji
// ur en utvärderingstext, en pil — blir skräptecken och kan förskjuta resten
// av raden. Behåll det som går att sätta, byt de vanligaste, släpp resten.
const CP1252_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
export function ren(v) {
  return String(v ?? '')
    .replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    .replace(/[→⇒➜➔]/g, '->').replace(/[←]/g, '<-').replace(/[✓✔]/g, 'v').replace(/[✗✘]/g, 'x')
    .replace(/[≈]/g, '~').replace(/[≤]/g, '<=').replace(/[≥]/g, '>=').replace(/[−]/g, '-')
    .replace(/[   ]/g, ' ')
    .split('').filter(ch => {
      const c = ch.charCodeAt(0);
      return ch === '\n' || (c >= 0x20 && c <= 0x7E) || (c >= 0xA1 && c <= 0xFF) || CP1252_EXTRA.includes(ch);
    }).join('');
}

const kl = (t) => t == null ? '—' : new Date(t).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
const dag = (t) => t == null ? '—' : new Date(t).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' });
const min = (m) => Number.isFinite(m) ? fmtMin(m) : '—';
const kr = (n) => `${Math.round(Number(n) || 0).toLocaleString('sv-SE')} kr`;
const jaNej = (v) => v ? 'Ja' : 'Nej';

function bildMatt(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 4, h: img.naturalHeight || 3 });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// Logotypen är en SVG med inbakat typsnitt — rastrera den via canvas. Misslyckas
// det (äldre webbläsare, blockerad resurs) får försättsbladet klara sig utan.
async function logotyp() {
  try {
    const img = new Image();
    await new Promise((ok, fel) => { img.onload = ok; img.onerror = fel; img.src = '/assets/eskil_design_library/svg/eskil-logo-inverted.svg'; });
    const c = document.createElement('canvas');
    c.width = 1149; c.height = 418;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } catch { return null; }
}

// --- Dokumentet: y-markör, sidbrytning, kapitel ----------------------------------
function skapaDok(pdf, comp) {
  const W = pdf.internal.pageSize.getWidth(), H = pdf.internal.pageSize.getHeight();
  const ctx = { W, H, comp, subtitle: '' };
  const d = { pdf, ctx, W, H, y: 46, toc: [] };
  const BOTTEN = H - 18;

  d.nySida = (subtitle) => {
    footer(pdf, W, H);
    pdf.addPage();
    if (subtitle) ctx.subtitle = subtitle;
    banner(pdf, W, comp, ctx.subtitle);
    d.y = 46;
  };
  d.kapitel = (titel) => { d.nySida(titel); d.toc.push({ titel, sida: pdf.getNumberOfPages() }); };
  d.plats = (h) => { if (d.y + h > BOTTEN) d.nySida(); };

  d.rubrik = (text, color = BLUE) => { d.plats(18); d.y = heading(pdf, d.y + 3, ren(text), color) + 4; };
  d.underrubrik = (text) => {
    d.plats(12);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10.5); pdf.setTextColor(BLUE);
    pdf.text(ren(text), 15, d.y + 2); d.y += 7;
  };
  d.stycke = (text, { size = 10, color = MORK, style = 'normal', indent = 0, gap = 3, lh = null } = {}) => {
    const hojd = lh || size * 0.47;
    pdf.setFont('helvetica', style); pdf.setFontSize(size);
    const rader = pdf.splitTextToSize(ren(text), W - 30 - indent);
    for (const r of rader) {
      if (d.y + hojd > BOTTEN) d.nySida();
      pdf.setFont('helvetica', style); pdf.setFontSize(size); pdf.setTextColor(color);
      pdf.text(r, 15 + indent, d.y);
      d.y += hojd;
    }
    d.y += gap;
  };
  d.not = (text) => d.stycke(text, { size: 8.5, color: GRA, style: 'italic', gap: 4 });
  // Höjden en punktlista tar — så att rubrik + lista kan hållas ihop på en
  // sida i stället för att sista punkten hamnar ensam på nästa.
  d.punkterHojd = (rader) => {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10);
    return rader.reduce((h, r) => h + pdf.splitTextToSize(ren(r), W - 30 - 7).length * 4.7 + 1.5, 3);
  };
  d.rubrikMedPunkter = (rubrik, rader, { color = BLUE, numrerad = false } = {}) => {
    const hojd = 18 + d.punkterHojd(rader);
    if (hojd < BOTTEN - 46) d.plats(hojd);      // en lista längre än en sida får brytas som vanligt
    d.rubrik(rubrik, color);
    d.punkter(rader, { numrerad });
  };
  // Punktlista med hängande indrag.
  d.punkter = (rader, { numrerad = false } = {}) => {
    rader.forEach((r, i) => {
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10);
      const delar = pdf.splitTextToSize(ren(r), W - 30 - 7);
      d.plats(delar.length * 4.7 + 1.5);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10); pdf.setTextColor(MORK);
      pdf.text(numrerad ? `${i + 1}.` : '•', 15 + (numrerad ? 0 : 1.2), d.y);
      pdf.text(delar, 22, d.y);
      d.y += delar.length * 4.7 + 1.5;
    });
    d.y += 3;
  };
  // Etikett : värde, en rad per faktum. Långa värden radbryts under sig själva.
  d.fakta = (rader, { etikettB = 52 } = {}) => {
    for (const [etikett, varde] of rader.filter(r => r && r[1] != null && String(r[1]).trim() !== '')) {
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10);
      const delar = pdf.splitTextToSize(ren(varde), W - 30 - etikettB);
      d.plats(delar.length * 4.8 + 1);
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10); pdf.setTextColor(GRA);
      pdf.text(ren(etikett), 15, d.y);
      pdf.setFont('helvetica', 'normal'); pdf.setTextColor(MORK);
      pdf.text(delar, 15 + etikettB, d.y);
      d.y += delar.length * 4.8 + 1.2;
    }
    d.y += 3;
  };
  d.tabell = (cols, rows, opts) => {
    d.plats(22);
    const sanerade = cols.map(c => ({ ...c, get: (r) => ren(c.get(r)) }));
    d.y = table(pdf, ctx, d.y + 3, sanerade, rows, opts);
  };
  // Bilder två i bredd; en ensam bild får mer plats.
  d.bilder = async (lista) => {
    const giltiga = [];
    for (const b of lista) {
      if (!b.dataUrl) continue;
      const m = await bildMatt(b.dataUrl);
      if (m) giltiga.push({ ...b, m });
    }
    const ensam = giltiga.length === 1;
    const kolB = ensam ? 120 : (W - 30 - 6) / 2, maxH = ensam ? 85 : 68;
    for (let i = 0; i < giltiga.length; i += 2) {
      const par = giltiga.slice(i, i + 2);
      const matt = par.map(b => {
        let w = kolB, h = kolB * b.m.h / b.m.w;
        if (h > maxH) { h = maxH; w = maxH * b.m.w / b.m.h; }
        pdf.setFont('helvetica', 'italic'); pdf.setFontSize(8.5);
        const text = b.bildtext ? pdf.splitTextToSize(ren(b.bildtext), kolB).slice(0, 3) : [];
        return { w, h, text };
      });
      const radH = Math.max(...matt.map(m => m.h + (m.text.length ? 3 + m.text.length * 3.8 : 0))) + 5;
      d.plats(radH);
      par.forEach((b, j) => {
        const x = 15 + j * (kolB + 6), m = matt[j];
        try { pdf.addImage(b.dataUrl, 'JPEG', x, d.y, m.w, m.h, undefined, 'FAST'); }
        catch { pdf.setDrawColor('#cccccc'); pdf.rect(x, d.y, m.w, m.h); }
        if (m.text.length) {
          pdf.setFont('helvetica', 'italic'); pdf.setFontSize(8.5); pdf.setTextColor(GRA);
          pdf.text(m.text, x, d.y + m.h + 4);
        }
      });
      d.y += radH;
    }
  };
  // Liggande staplar: etikett, stapel, tal.
  d.staplar = (rader, { etikettB = 34 } = {}) => {
    const max = Math.max(1, ...rader.map(r => r.varde));
    const stapelB = W - 30 - etikettB - 16;
    for (const r of rader) {
      d.plats(6);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(MORK);
      pdf.text(ren(r.etikett), 15, d.y);
      pdf.setFillColor(BLUE);
      pdf.rect(15 + etikettB, d.y - 3.2, Math.max(0.6, stapelB * r.varde / max), 4, 'F');
      pdf.text(String(r.varde), 15 + etikettB + stapelB * r.varde / max + 2.5, d.y);
      d.y += 5.6;
    }
    d.y += 4;
  };
  return d;
}

// --- Försättsbladet ---------------------------------------------------------------
async function ritaForsattsblad(d, { comp, user, nyckeltal, ledning }) {
  const { pdf, W, H } = d;
  // Huvudet är 84 mm, inte högre: försättsbladet ska rymma fakta, ledning OCH
  // gallringsbeskedet på EN sida. Med 112 mm svämmade beskedet över till en
  // nästan tom sida två.
  const HUVUD = 84;
  pdf.setFillColor(BLUE); pdf.rect(0, 0, W, HUVUD, 'F');
  pdf.setFillColor(YELLOW); pdf.rect(0, HUVUD, W, 2.2, 'F');
  const logo = await logotyp();
  if (logo) { try { pdf.addImage(logo, 'PNG', W - 15 - 46, 10, 46, 16.7, undefined, 'FAST'); } catch { /* utan logotyp */ } }

  pdf.setTextColor(YELLOW); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10);
  pdf.text('TÄVLINGSRAPPORT', 15, 20);
  pdf.setTextColor('#ffffff'); pdf.setFontSize(27);
  const titel = pdf.splitTextToSize(ren(comp.name || comp.shortName || 'Tävling'), W - 30).slice(0, 2);
  pdf.text(titel, 15, 42);
  let y = 42 + titel.length * 11;
  // Årtalet står ofta redan i namnet ("Älghornsjakten 2026") — skriv det inte två gånger.
  const arINamnet = comp.year && String(comp.name || '').includes(String(comp.year));
  pdf.setTextColor(YELLOW); pdf.setFontSize(17);
  if (comp.year && !arINamnet) { pdf.text(String(comp.year), 15, y); y += 10; }
  else y += 2;
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(11.5); pdf.setTextColor('#d5e1ec');
  const meta = [comp.date ? formatDate(comp.date) : '', comp.location || ''].filter(Boolean).join('  ·  ');
  if (meta) { pdf.text(ren(meta), 15, y); y += 6.5; }
  if (comp.organizer) pdf.text(ren(`Arrangör: ${comp.organizer}`), 15, y);

  // Nyckeltal
  const n = nyckeltal.length, mellan = 4, b = (W - 30 - mellan * (n - 1)) / n;
  nyckeltal.forEach((k, i) => {
    const x = 15 + i * (b + mellan);
    pdf.setFillColor('#eef2f6'); pdf.roundedRect(x, HUVUD + 10, b, 21, 2, 2, 'F');
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(GRA);
    pdf.text(ren(k.etikett).toUpperCase(), x + 4, HUVUD + 17);
    pdf.setFontSize(15); pdf.setTextColor(BLUE);
    pdf.text(ren(k.varde), x + 4, HUVUD + 26.5);
  });

  d.y = HUVUD + 42;
  d.rubrik('Om tävlingen');
  const st = startTimeSettings(comp);
  const reg = registrationSettings(comp);
  d.fakta([
    ['Tävling', arINamnet ? comp.name : [comp.name, comp.year].filter(Boolean).join(' ')],
    ['Datum', comp.date ? formatDate(comp.date) : ''],
    ['Plats', comp.location],
    ['Arrangör', comp.organizer],
    ['Scoutdistrikt', comp.district ? districtName(comp.district) : ''],
    ['Avdelningar', allowedAvdelningar(comp).map(a => `${a.key} (${a.range})`).join(', ')],
    ['Starttider', st.enabled
      ? (st.mode === 'range' && st.lastStart ? `Första start ${st.firstStart}, sista start ${st.lastStart}` : `Första start ${st.firstStart}, ${st.intervalMinutes} min intervall`)
      : 'Inga schemalagda starttider'],
    ['Anmälan', reg.opensAt || reg.closesAt ? `${reg.opensAt || '—'} till ${reg.closesAt || '—'}` : ''],
    ['Tävlingssida', `eskilscout.se/t/${comp.slug || comp.id || ''}`],
    ['Status', comp.closed ? `Avslutad${comp.closedAt ? ' ' + dag(tillMs(comp.closedAt)) : ''}` : 'Inte avslutad']
  ]);
  if (comp.description) d.stycke(comp.description, { color: GRA });

  d.rubrik('Tävlingsledning');
  const medNamn = ledning.filter(r => (r.name || '').trim() || (r.email || '').trim());
  if (medNamn.length) {
    d.fakta(medNamn.map(r => [r.label || 'Roll', [r.name, r.email].filter(x => (x || '').trim()).join('  ·  ')]));
  } else if (ledning.length) {
    d.fakta(ledning.map(r => [r.label || 'Roll', '(uppgiften är gallrad)']));
    d.not('Tävlingen avslutades innan ESKIL började spara tävlingsledningens namn och e-post vid avslut — de gallrades då tillsammans med allt annat.');
  } else {
    d.not('Ingen tävlingsledning är registrerad i ESKIL.');
  }

  // Gallringsbeskedet hålls ihop som ETT block. Får det inte plats här (en
  // ledning med många roller) ritas det på innehållssidan i stället, som
  // alltid har utrymme — hellre där än utspritt över en sidbrytning.
  const besked = personuppgiftsbesked(comp);
  const fickPlats = d.y + besked.hojd(pdf, W) <= H - 16;
  if (fickPlats) d.y = besked.rita(pdf, W, d.y);

  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.setTextColor('#8a8a8a');
  pdf.text(ren(`Genererad ${new Date().toLocaleString('sv-SE', { dateStyle: 'long', timeStyle: 'short' })}${user?.email ? ' av ' + user.email : ''} · ESKIL — eskilscout.se`), 15, H - 8);
  pdf.text('Internt dokument för tävlingsledningen', W - 15, H - 8, { align: 'right' });
  return { beskedKvar: !fickPlats, besked };
}

// Vad som finns kvar — och vad som inte gör det. Rapporten tas ut EFTER
// avslutet (formuläret är låst dessförinnan), så påståendet är sant när det
// skrivs. Texten följer closeCompetition i store.js; ändras gallringen där ska
// den ändras här och i /integritet.
function personuppgiftsbesked(comp) {
  const text = comp.closed
    ? `Tävlingen är avslutad${comp.closedAt ? ' (' + dag(tillMs(comp.closedAt)) + ')' : ''}. I och med avslutet har alla personuppgifter raderats ur ESKIL: användare, kontrollansvariga och ekonomiansvariga; telefonnummer till tävlingsledning och kontroller; anmälningarnas kontaktuppgifter och fritextsvar; kompletteringar per patrull och ändringsärenden; samtal och bilder mellan fältet och ledningen; sekretariatets logg samt papperskorgen. Det enda personliga som sparas är tävlingsledningens namn och e-postadresser. I övrigt innehåller rapporten bara patrullnamn, kårer, resultat och statistik.`
    : 'Tävlingen är INTE avslutad. Personuppgifterna i ESKIL är därför inte gallrade ännu — avsluta tävlingen under Inställningar -> Grund när den är genomförd.';
  const rader = (pdf, W) => { pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9.5); return pdf.splitTextToSize(ren(text), W - 30); };
  return {
    hojd: (pdf, W) => 12 + rader(pdf, W).length * 4.5 + 2,
    rita: (pdf, W, y) => {
      const r = rader(pdf, W);
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(13); pdf.setTextColor(BLUE);
      pdf.text('Personuppgifter', 15, y + 3);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9.5); pdf.setTextColor(comp.closed ? GRA : '#c8102e');
      pdf.text(r, 15, y + 11);
      return y + 11 + r.length * 4.5 + 2;
    }
  };
}

// Överlämningskoden — stor, i mitten av blicken, med QR rakt in på inlösningssidan.
// Koden är en nyckel: rapporten säger det, och säger ärligt om den saknas eller
// redan är använd i stället för att trycka en kod som inte fungerar.
async function ritaKodruta(d, ovl) {
  const { pdf, W } = d;
  if (!ovl?.kod) {
    d.not('Ingen överlämningskod är skapad. Skapa den under Inställningar -> Grund -> Utvärdering och överlämning och ta ut rapporten igen — då står koden här.');
    return;
  }
  if (ovl.anvand) {
    d.stycke(`Överlämningskoden löstes in ${dag(tillMs(ovl.anvand.at))} — nästa arrangör har redan fått sin tävling. Koden gäller inte längre och skrivs därför inte ut.`, { style: 'bold', gap: 5 });
    return;
  }
  const kod = formateraKod(ovl.kod);
  const hojd = 46;
  d.plats(hojd + 6);
  const y0 = d.y;
  pdf.setFillColor('#eef2f6'); pdf.roundedRect(15, y0, W - 30, hojd, 3, 3, 'F');
  pdf.setFillColor(BLUE); pdf.rect(15, y0, 2.2, hojd, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5); pdf.setTextColor(GRA);
  pdf.text('ÖVERLÄMNINGSKOD', 24, y0 + 9);
  pdf.setFont('courier', 'bold'); pdf.setFontSize(27); pdf.setTextColor(BLUE);
  pdf.text(kod, 24, y0 + 22);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9.5); pdf.setTextColor(MORK);
  const rader = pdf.splitTextToSize(`Gå till ${OVERLAMNING_ADRESS} — eller skanna rutan — skriv koden och din e-postadress. Du får en inloggningslänk i mejlen och landar i en färdig tävling för nästa år.`, W - 30 - 56);
  pdf.text(rader, 24, y0 + 30);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5); pdf.setTextColor('#c8102e');
  pdf.text('Gäller en gång. Behandla koden som en nyckel.', 24, y0 + hojd - 4);
  try {
    const img = await renderQrToImg(`https://${OVERLAMNING_ADRESS}/${kod}`, 300);
    pdf.addImage(img.src, 'PNG', W - 15 - 40, y0 + 3, 37, 37, undefined, 'FAST');
  } catch { /* utan QR går koden fortfarande att skriva in */ }
  d.y = y0 + hojd + 8;
}

function ritaInnehall(d, innehallSida) {
  const { pdf, W } = d;
  pdf.setPage(innehallSida);
  let y = 50;
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(13); pdf.setTextColor(BLUE);
  pdf.text('Innehåll', 15, y); y += 10;
  d.toc.forEach((t, i) => {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(11); pdf.setTextColor(MORK);
    const vanster = `${i + 1}.  ${ren(t.titel)}`;
    pdf.text(vanster, 15, y);
    pdf.text(String(t.sida), W - 15, y, { align: 'right' });
    const x1 = 15 + pdf.getTextWidth(vanster) + 3, x2 = W - 15 - pdf.getTextWidth(String(t.sida)) - 3;
    if (x2 > x1) { pdf.setDrawColor('#c9d2db'); pdf.setLineDashPattern([0.6, 1.4], 0); pdf.line(x1, y - 1, x2, y - 1); pdf.setLineDashPattern([], 0); }
    y += 8;
  });
  pdf.setPage(pdf.getNumberOfPages());
}

// --- Huvudfunktionen ----------------------------------------------------------------
export async function byggTavlingsrapport({ cid, comp: compIn, user, utvardering = null, bildData = null, overlamning = undefined }, { onProgress = null, spara = true } = {}) {
  const steg = (t) => { try { onProgress?.(t); } catch { /* bara en etikett */ } };
  steg('Hämtar underlag…');
  await ensureLibs();
  const store = await import('./store.js');

  // Färsk tävling: den hydrerade bär ledningens interna roller, och `compIn`
  // kan vara minuter gammal.
  const comp = { ...(compIn || {}), ...((await store.getCompetition(cid).catch(() => null)) || {}), id: cid };
  const [patrols, controls, track, regs, stations, selfPassages, messages] = await Promise.all([
    store.listPatrols(cid), store.listControls(cid), store.getTrack(cid).catch(() => null),
    store.listRegistrations(cid).catch(() => []), store.listStations(cid).catch(() => []),
    store.listSelfPassages(cid).catch(() => []), store.listBroadcastMessages(cid).catch(() => [])
  ]);
  const scores = await store.listAllScores(cid, controls).catch(() => []);
  const stationPassages = (await Promise.all(stations.map(s => store.listPassages(cid, s.id).catch(() => [])))).flat();

  const u = normUtvardering(utvardering || await store.getHandover(cid).catch(() => null));
  const bilder = bildData || await store.hamtaUtvarderingBilder(cid, utvarderingBildIds(u)).catch(() => ({}));
  const ovl = overlamning !== undefined ? overlamning : await store.getOverlamning(cid).catch(() => null);

  // --- Siffrorna ---
  const riktiga = patrols.filter(p => !p.genrep);
  const ordnade = [...controls].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
  const delt = deltagarStatistik(patrols);
  const anm = anmalningsStatistik(regs);
  const tider = patrullTider({ comp, patrols, controls, scores, stationPassages, selfPassages });
  const startMsByPatrol = Object.fromEntries(tider.filter(t => t.startMs != null && t.startKalla !== 'planerad').map(t => [t.patrol.id, t.startMs]));
  const modell = courseEta(comp, controls, track);
  const kalibrerad = courseEtaCalibrated({ ...comp, demo: false }, controls, track, scores, patrols, new Date(), startMsByPatrol);
  const tidStat = tidsStatistik(tider, modell.finishMin);
  const ktrlStat = kontrollStatistik(controls, scores);
  const strackor = strackStatistik(kalibrerad);
  const places = compPlaces(comp);

  steg('Ritar kartan…');
  let karta = null;
  if (ordnade.some(c => Number.isFinite(c.lat))) {
    karta = await courseMapDataUrl(comp, controls, track, places, { wPx: 1800, hPx: 1150 }).catch(() => null);
  }

  steg('Bygger rapporten…');
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const d = skapaDok(pdf, comp);

  const forsatt = await ritaForsattsblad(d, {
    comp, user,
    ledning: activeManagement(comp),
    nyckeltal: [
      { etikett: 'Patruller', varde: String(delt.patruller) },
      { etikett: 'Deltagare', varde: String(delt.scouter) },
      { etikett: 'Kårer', varde: String(delt.karer.length) },
      { etikett: 'Kontroller', varde: String(controls.length) },
      { etikett: 'Spårlängd', varde: modell.totalDist > 0 ? fmtDist(modell.totalDist) : '—' }
    ]
  });

  // Sida 2 reserveras för innehållsförteckningen; den fylls i sist, när
  // kapitlens sidnummer är kända. Sidfoten ritas NU, medan sidan är sist.
  pdf.addPage();
  d.ctx.subtitle = 'Innehåll';
  banner(pdf, d.W, comp, 'Innehåll');
  const innehallSida = pdf.getNumberOfPages();
  if (forsatt.beskedKvar) forsatt.besked.rita(pdf, d.W, 170);

  // ===== 1. Utvärdering =====
  d.kapitel('Utvärdering');
  const ordning = ['sammanfattning', 'bra', 'mindreBra', 'forbattringar'];
  let skrivet = false;
  for (const k of ordning) {
    const s = UTV_SEKTIONER.find(x => x.key === k);
    const sb = u.bilder.filter(b => b.sektion === k).map(b => ({ ...b, dataUrl: bilder[b.id] }));
    if (!u[k].trim() && !sb.length) continue;
    skrivet = true;
    d.rubrik(s.titel, k === 'forbattringar' ? ORANGE : BLUE);
    if (u[k].trim()) d.stycke(u[k], { size: 10.5, gap: 4 });
    if (sb.length) await d.bilder(sb);
  }
  if (!skrivet) d.not('Ingen utvärdering är ifylld ännu. Den skrivs under Inställningar -> Grund -> Utvärdering och överlämning, och går att fylla i även efter att tävlingen avslutats.');
  const antB = u.bilder.filter(b => b.sektion === 'text').map(b => ({ ...b, dataUrl: bilder[b.id] }));
  if (u.text.trim() || antB.length) {
    d.rubrik(UTV_ANTECKNINGAR.titel);
    if (u.text.trim()) d.stycke(u.text, { size: 10.5, gap: 4 });
    if (antB.length) await d.bilder(antB);
  }
  if (u.foregaende && (u.foregaende.forbattringar.trim() || u.foregaende.mindreBra.trim())) {
    const f = u.foregaende;
    d.rubrik(`Att följa upp: förra årets utvärdering${f.namn || f.ar ? ' (' + [f.namn, f.ar].filter(Boolean).join(' ') + ')' : ''}`, GRA);
    if (f.forbattringar.trim()) { d.underrubrik('Förbättringsförslagen då'); d.stycke(f.forbattringar, { color: GRA }); }
    if (f.mindreBra.trim()) { d.underrubrik('Det som fungerade mindre bra då'); d.stycke(f.mindreBra, { color: GRA }); }
  }

  // ===== Överlämning till nästa arrangör (bara när kryssrutan är i) =====
  if (u.nyArrangor) {
    const o = OVERLAMNING_ARRANGOR;
    d.kapitel(o.titel);
    d.stycke(o.ingress, { color: GRA, gap: 5 });
    await ritaKodruta(d, ovl);
    if (u.nyArrangorText.trim()) { d.rubrik('Från årets arrangör', ORANGE); d.stycke(u.nyArrangorText, { size: 10.5, gap: 4 }); }
    d.rubrik('Så tar nästa arrangör över tävlingen i ESKIL');
    o.steg.forEach((s, i) => { d.underrubrik(`${i + 1}. ${s.rubrik}`); d.stycke(s.text, { indent: 4, gap: 3 }); });
    d.rubrikMedPunkter('Följer med i kopian', o.foljerMed);
    d.rubrikMedPunkter('Följer inte med', o.foljerInteMed);
    d.rubrikMedPunkter('Det första nästa arrangör gör i den nya tävlingen', o.attGoraForst, { color: ORANGE, numrerad: true });
  }

  // ===== 2. Banan =====
  d.kapitel('Banan');
  if (karta?.url) {
    const b = d.W - 30, h = b * 1150 / 1800;
    d.plats(h + 8);
    try { pdf.addImage(karta.url, 'JPEG', 15, d.y, b, h, undefined, 'FAST'); } catch { /* utan karta */ }
    d.y += h + 3;
    d.not(`${karta.rotated ? 'Kartan är vriden 90 grader — följ kompassnålen. ' : ''}Heldragen linje är ritat spår, streckad är fågelvägen. Kartdata © OpenStreetMap.`);
  } else {
    d.not('Ingen bankarta: kontrollerna saknar positioner eller kartrutorna gick inte att hämta.');
  }
  d.rubrik('Banan i siffror');
  const forstaStart = Math.min(...tider.map(t => t.startMs).filter(Number.isFinite));
  const sistaMal = Math.max(...tider.map(t => t.malMs).filter(Number.isFinite));
  d.fakta([
    ['Spårlängd', modell.totalDist > 0 ? `${fmtDist(modell.totalDist)}${modell.hasDrawn ? '' : ' (fågelvägen — inget spår ritat)'}` : ''],
    ['Kontroller', `${controls.length}${places.filter(p => p.inCourse).length ? ` + ${places.filter(p => p.inCourse).length} plats(er) i banan` : ''}`],
    ['Gångtempo i modellen', `${modell.speedKmh} km/h`],
    ['Stationstid i modellen', `${modell.dwellMin} min per kontroll`],
    ['Planerad tid på banan', min(modell.finishMin)],
    ['Verklig tid (median)', tidStat.antal ? `${min(tidStat.medianMin)} — ${tidStat.antal} patruller med start- och måltid` : 'Inga patruller har både start- och måltid'],
    ['Snabbast / långsammast', tidStat.antal ? `${min(tidStat.snabbastMin)} / ${min(tidStat.langsammastMin)}` : ''],
    ['Verklig mot planerad', tidStat.diffMin != null ? `${tidStat.diffMin >= 0 ? '+' : '-'}${min(Math.abs(tidStat.diffMin))} (${tidStat.diffMin >= 0 ? 'banan tog längre tid än planerat' : 'banan gick fortare än planerat'})` : ''],
    ['Första start – sista målgång', Number.isFinite(forstaStart) && Number.isFinite(sistaMal) ? `${kl(forstaStart)} – ${kl(sistaMal)}` : ''],
    ['Spåret för scouterna', courseHidden(comp) ? 'Hemligt — scouterna såg bara tävlingsområdet' : 'Synligt på startkort och tävlingssida']
  ]);
  if (strackor.length) {
    d.rubrik('Sträcka för sträcka: modell mot verklighet');
    d.tabell([
      { label: 'Från', w: 16, get: r => r.fran, bold: true },
      { label: 'Till', w: 16, get: r => r.till, bold: true },
      { label: 'Mot', w: 66, get: r => String(r.tillNamn || '').slice(0, 42) },
      { label: 'Längd', w: 22, align: 'right', get: r => fmtDist(r.langdM) },
      { label: 'Modell', w: 22, align: 'right', get: r => min(r.modellMin) },
      { label: 'Verklig', w: 22, align: 'right', get: r => r.verkligMin != null ? min(r.verkligMin) : '—' },
      { label: 'Mätn.', w: 14, align: 'right', get: r => r.matningar || '' }
    ], strackor);
    d.not('Modell = gångtid + stationstid. Verklig = medianen av tiden mellan två rapporter, alltså gång + kö + uppgift; den visas när minst tre patruller passerat sträckan. Stora skillnader pekar på kö eller en kontroll som tar längre tid än väntat.');
  }

  // ===== 3. Kontrollerna =====
  d.kapitel('Kontrollerna');
  d.rubrik('Översikt');
  d.tabell([
    { label: 'Nr', w: 10, align: 'right', get: r => r.control.nummer ?? '' },
    { label: 'Kontroll', w: 58, get: r => String(r.control.name || '').slice(0, 36), bold: true },
    { label: 'Bedömning', w: 22, get: r => r.control.tidtagning ? 'Tid' : 'Poäng' },
    { label: 'Poäng', w: 20, get: r => `${r.control.minPoang ?? 0}–${r.control.maxPoang ?? 0}${r.control.extraPoang ? ' +' + r.control.extraPoang : ''}` },
    { label: 'Rapp.', w: 14, align: 'right', get: r => r.rapporter },
    { label: 'Snitt', w: 16, align: 'right', get: r => r.snitt != null ? r.snitt.toFixed(1) : '—' },
    { label: 'Maxade', w: 18, align: 'right', get: r => r.maxade },
    { label: 'Nollor', w: 16, align: 'right', get: r => r.nollor }
  ], ktrlStat);
  for (const k of ktrlStat) {
    const c = k.control;
    d.rubrik(`${c.nummer ?? '?'}. ${c.name || 'Kontroll'}`);
    d.fakta([
      ['Bedömning', c.tidtagning ? `Tidtagning — poäng ${c.minPoang ?? 0}–${c.maxPoang ?? 0} fördelas efter tid` : `Poäng ${c.minPoang ?? 0}–${c.maxPoang ?? 0}${c.extraPoang ? `, extra upp till ${c.extraPoang}` : ''}`],
      ['Utfall', k.rapporter ? `${k.rapporter} rapporter, snitt ${k.snitt != null ? k.snitt.toFixed(1) : '—'} p, ${k.maxade} maxade, ${k.nollor} nollor` : 'Inga rapporter'],
      ['Tider', c.tidtagning && k.tidMedianSek != null ? `Median ${formateraTid(Math.round(k.tidMedianSek))}, bäst ${formateraTid(k.tidBastSek)}${k.ejGenomford ? `, ${k.ejGenomford} ej genomförda` : ''}` : ''],
      ['Utslagsfråga', c.utslag ? `${c.utslagFraga || '(ingen fråga angiven)'}${isNumSet(c.utslagSvar) ? ` — rätt svar: ${Number(c.utslagSvar)}` : ''}` : ''],
      ['Position', Number.isFinite(c.lat) && Number.isFinite(c.lng) ? `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}` : ''],
      ['Placering', c.placement]
    ]);
    for (const g of allInstructionGroups(c)) {
      if (!(g.text || '').trim()) continue;
      d.underrubrik(`Instruktion — ${(g.avdelningar || []).length ? g.avdelningar.join(', ') : 'alla övriga'}`);
      d.stycke(g.text, { gap: 4 });
    }
  }

  // ===== 4. Anmälningar och deltagande =====
  d.kapitel('Anmälningar och deltagande');
  const reg = registrationSettings(comp);
  if (regs.length) {
    d.rubrik('Anmälningarna');
    const prisM = REG_PRICING_MODELS.find(m => m.key === reg.pricing.model);
    d.fakta([
      ['Anmälningar', `${anm.anmalningar}${anm.avanmalda ? ` (+ ${anm.avanmalda} avanmälda)` : ''}`],
      ['Anmälda', `${anm.patruller} patruller, ${anm.scouter} scouter, ${anm.karer.length} kårer`],
      ['Efteranmälningar', anm.efteranmalningar ? String(anm.efteranmalningar) : ''],
      ['Anmälningsperiod', reg.opensAt || reg.closesAt ? `${reg.opensAt || '—'} till ${reg.closesAt || '—'}` : ''],
      ['Första / sista anmälan', anm.forsta != null ? `${dag(anm.forsta)} / ${dag(anm.sista)}` : ''],
      ['Prismodell', prisM ? prisM.label : ''],
      ['Avgifter', `${kr(anm.belopp)} debiterat, ${kr(anm.betalt)} inbetalt${anm.obetalt > 0 ? `, ${kr(anm.obetalt)} utestående` : ''}`]
    ]);
    d.rubrik('Per kår');
    d.tabell([
      { label: 'Kår', w: 70, get: r => String(r.kar).slice(0, 44), bold: true },
      { label: 'Anm.', w: 14, align: 'right', get: r => r.anmalningar },
      { label: 'Patruller', w: 20, align: 'right', get: r => r.patruller },
      { label: 'Scouter', w: 20, align: 'right', get: r => r.scouter },
      { label: 'Debiterat', w: 26, align: 'right', get: r => kr(r.belopp) },
      { label: 'Inbetalt', w: 26, align: 'right', get: r => kr(r.betalt) }
    ], anm.karer);
    if (anm.perVecka.length > 1) {
      d.rubrik('När kom anmälningarna?');
      d.staplar(anm.perVecka.map(v => ({ etikett: v.vecka.replace('-v', ' vecka '), varde: v.antal })));
      d.not('Antal anmälningar per vecka. Toppen brukar ligga precis före sista anmälningsdag — planera påminnelser efter det.');
    }
  } else {
    d.not('Tävlingen har inga anmälningar i ESKIL — patrullerna lades upp direkt i patrullistan.');
  }
  d.rubrik('Deltagande per avdelning');
  const avdRader = allowedAvdelningar(comp).map(a => {
    const an = anm.perAvdelning.find(x => x.avdelning === a.key), st = delt.perAvdelning.find(x => x.avdelning === a.key);
    return { avd: `${a.key} (${a.range})`, ap: an?.patruller || 0, as: an?.scouter || 0, sp: st?.patruller || 0, ss: st?.scouter || 0 };
  }).filter(r => r.ap || r.sp);
  d.tabell([
    { label: 'Avdelning', w: 60, get: r => r.avd, bold: true },
    { label: 'Anmälda patr.', w: 30, align: 'right', get: r => r.ap },
    { label: 'Anmälda scouter', w: 32, align: 'right', get: r => r.as },
    { label: 'I startlistan', w: 28, align: 'right', get: r => r.sp },
    { label: 'Scouter', w: 24, align: 'right', get: r => r.ss }
  ], avdRader);
  if (!regs.length && delt.karer.length) {
    d.rubrik('Per kår (patrullistan)');
    d.tabell([
      { label: 'Kår', w: 100, get: r => String(r.kar).slice(0, 60), bold: true },
      { label: 'Patruller', w: 30, align: 'right', get: r => r.patruller },
      { label: 'Scouter', w: 30, align: 'right', get: r => r.scouter }
    ], delt.karer);
  }

  // ===== 5. Start och målgång =====
  d.kapitel('Start och målgång');
  const startlista = [...tider].sort((a, b) => (Number(a.patrol.startOrder) ?? 999) - (Number(b.patrol.startOrder) ?? 999) || (a.patrol.number ?? 0) - (b.patrol.number ?? 0));
  d.tabell([
    { label: 'Nr', w: 10, align: 'right', get: r => r.patrol.number ?? '' },
    { label: 'Patrull', w: 42, get: r => String(r.patrol.name || '').slice(0, 26), bold: true },
    { label: 'Kår', w: 42, get: r => String(r.patrol.kar || '').slice(0, 27) },
    { label: 'Planerad', w: 18, align: 'right', get: r => r.planeradMs != null ? kl(r.planeradMs) : '—' },
    { label: 'Start', w: 16, align: 'right', get: r => r.startKalla && r.startKalla !== 'planerad' ? kl(r.startMs) : '—' },
    { label: 'Mål', w: 16, align: 'right', get: r => r.malMs != null ? kl(r.malMs) : '—' },
    { label: 'På banan', w: 20, align: 'right', get: r => r.minuter != null ? min(r.minuter) : '—' },
    { label: 'Anm.', w: 14, get: r => r.patrol.utgatt ? 'Utgått' : (r.malKalla === 'sista rapport' ? 'auto' : r.malKalla === 'själv' ? 'själv' : '') }
  ], startlista);
  const luckor = startlistaLuckor(comp, patrols);
  d.not(`Start och mål kommer i första hand från start- och målstationen, i andra hand från patrullens egen bekräftelse ("själv"), och sist från sista rapporten när alla kontroller är klara ("auto").${luckor.length ? ` Startlistan hade ${luckor.length} lucka/luckor: ${luckor.map(i => patrolStartTime(comp, { startOrder: i }, antalStartplatser(comp, patrols))).filter(Boolean).join(', ')}.` : ''}${delt.utgatt ? ` ${delt.utgatt} patrull(er) utgick.` : ''}`);

  // ===== 6. Resultat =====
  d.kapitel('Resultat');
  const totals = computeTotals(riktiga, scores);
  const ranked = rankPatrols(totals, controls).map(r => ({ ...r, _rank: r.rank }));
  d.y = ritaResultat(pdf, d.ctx, d.y + 3, { patrols: riktiga, controls, totals, ranked });
  d.rubrik('Placeringsregler');
  RANKING_RULES_TEXT.forEach((r, i) => { d.underrubrik(`${i + 1}. ${r.title}`); d.stycke(r.rule, { size: 9.5, indent: 4, gap: 2 }); });

  // ===== 7. Dagen i korthet =====
  const meddelanden = messages.filter(m => (m.text || '').trim()).sort((a, b) => (tillMs(a.at) ?? 0) - (tillMs(b.at) ?? 0));
  // Sekretariatets logg skrivs medvetet INTE ut: den är ett arbetsredskap för
  // dagen (vem stängde vad, vem flyttade vem) och hör inte hemma i ett dokument
  // som arkiveras och lämnas vidare.
  if (meddelanden.length) {
    d.kapitel('Dagen i korthet');
    if (meddelanden.length) {
      d.rubrik('Driftmeddelanden');
      const niva = { info: 'Info', varning: 'Varning', kritisk: 'KRITISKT' };
      for (const m of meddelanden) {
        const till = [m.target?.kontroller ? 'kontroller' : '', m.target?.patruller ? 'patruller' : '', m.target?.publikt ? 'tävlingssidan' : ''].filter(Boolean).join(' + ') || 'alla';
        const t = tillMs(m.at);
        d.plats(12);
        d.stycke(`${t != null ? new Date(t).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) : '—'}  ·  ${niva[m.level] || 'Info'}  ·  till ${till}`, { size: 9, style: 'bold', color: m.level === 'kritisk' ? '#c8102e' : GRA, gap: 0.5 });
        d.stycke(m.text, { gap: 4 });
      }
    }
  }

  // ===== 8. Inställningar =====
  d.kapitel('Inställningar');
  const st = startTimeSettings(comp);
  d.rubrik('Så var tävlingen inställd');
  d.fakta([
    ['Starttider', st.enabled ? (st.mode === 'range' && st.lastStart ? `${st.firstStart}–${st.lastStart}, intervallet räknas ur antalet startplatser` : `${st.firstStart}, ${st.intervalMinutes} min intervall`) : 'Av'],
    ['Starttiderna publicerade', st.enabled ? jaNej(startTimesPublished(comp)) : ''],
    ['Maxtid på banan', st.maxTimeMinutes ? `${st.maxTimeMinutes} min` : 'Ingen'],
    ['Patrullen bekräftar start själv', jaNej(comp.selfStart)],
    ['Patrullen bekräftar mål själv', jaNej(comp.selfFinish)],
    ['Automatisk målgång', jaNej(comp.autoFinish)],
    ['Anonyma kontroller', jaNej(comp.anonymousControls !== false)],
    ['Poängen publika', jaNej(comp.publicScores !== false)],
    ['Kontrollplatserna publika', `${jaNej(comp.publicControls !== false)}${comp.autoReleaseControls ? ' (automatiskt släpp 5 min före första start)' : ''}`],
    ['Hemligt spår', jaNej(courseHidden(comp))],
    ['Kontroller stängs automatiskt', jaNej(comp.autoCloseControls)],
    ['Samtal fält–ledning', jaNej(comp.fieldMessaging !== false)],
    ['Anmälan', reg.enabled || regs.length ? `${reg.mode === 'patrull' ? 'Patrullvis' : 'Kårvis'}${reg.methods.length ? ', betalning via ' + reg.methods.map(m => m.label || m.type).join(', ') : ''}` : 'Användes inte']
  ], { etikettB: 62 });
  if (places.length) {
    d.rubrik('Platser');
    d.tabell([
      { label: 'Plats', w: 80, get: r => String(r.name || '').slice(0, 50), bold: true },
      { label: 'Sort', w: 40, get: r => placeKind(r.kind)?.label || r.kind || '' },
      { label: 'I banan', w: 30, get: r => r.inCourse ? (r.courseAfter ? `efter kontroll ${r.courseAfter}` : 'efter start') : '' },
      { label: 'Stopp', w: 30, align: 'right', get: r => r.inCourse && r.dwellMinutes ? `${r.dwellMinutes} min` : '' }
    ], places);
  }
  if ((comp.generalInfo || '').trim()) { d.rubrik('Allmän information till patrullerna'); d.stycke(comp.generalInfo); }

  footer(pdf, d.W, d.H);
  ritaInnehall(d, innehallSida);

  const filnamn = `tavlingsrapport-${fileStem(comp)}.pdf`;
  if (spara) pdf.save(filnamn);
  return { pdf, filnamn, sidor: pdf.getNumberOfPages(), kapitel: d.toc };
}
