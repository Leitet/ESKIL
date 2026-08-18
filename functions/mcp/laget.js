// CJS-spegel av public/js/laget-core.js — läget som MCP-kopplingen ser det.
//
// SPEGELN ÄR MEDVETEN, INTE SLARV. functions/ är CommonJS och publikkoden är
// ESM utan byggsteg, så samma fil kan inte laddas av båda. Samma val gjordes
// för ledning.js, och priset betalas på samma sätt: ett test kör BÅDA
// implementationerna mot samma indata och kräver identiskt utfall.
//
// Varför det spelar roll här mer än någon annanstans: den här härledningen
// besvarar frågan "var står det still?" mitt under en tävling. Räknar webbvyn
// och assistenten var för sig kan sekretariatet läsa en siffra på skärmen och
// höra en annan i chatten — och då är båda värdelösa.
//
// Ändrar du något i beräkningen: ändra i BÅDA filerna, kör
// `scripts/test.sh logic`. Parity-testet faller annars.

// ═══ Konstanter — måste vara identiska med laget-core.js ════════════════════

const WARN_SILENT_MIN = 60;   // patrull ute utan livstecken → varning
const CTRL_STALE_MIN = 45;    // kontroll tyst MED patruller på väg in → rött

// Livstecknets färskhetsfönster (utils.js FARSK_MS): en enhet som inte hörts
// av på en kvart räknas inte längre in i batteri och kö.
const FARSK_MS = 15 * 60 * 1000;

const toDate = (ts) => {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate();
  return new Date(ts);
};

const minSince = (d, now) => d ? Math.floor((now - d) / 60000) : null;

// ═══ Härledningen — spegel av beraknaLaget() ════════════════════════════════

function beraknaLaget({ comp, controls, patrols, passages, scoresByCtrl, now, plannedStartAt }) {
  const ordered = [...controls].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
  const planerad = plannedStartAt || (() => null);

  const perPatrol = patrols.map(p => {
    const pass = passages[p.id] || {};
    const reports = [];
    for (const c of ordered) {
      const s = (scoresByCtrl[c.id] || []).find(x => x.patrolId === p.id);
      // clientReportedAt = tryckögonblicket, reportedAt = synktiden.
      const t = toDate(s?.clientReportedAt ?? s?.reportedAt);
      if (t) reports.push({ nummer: c.nummer ?? 0, t });
    }
    reports.sort((a, b) => a.nummer - b.nummer);
    const startAt = toDate(pass.startAt);
    const finishAt = toDate(pass.finishAt);
    const position = reports.length ? reports[reports.length - 1].nummer : 0;
    const lastReport = reports.length ? reports.reduce((m, r) => r.t > m ? r.t : m, reports[0].t) : null;
    const lastSeen = [startAt, finishAt, lastReport].filter(Boolean).sort((a, b) => b - a)[0] || null;
    const utgatt = p.utgatt || null;
    const started = !!startAt || reports.length > 0;
    const active = !utgatt && started && !finishAt;
    const silentMin = active ? minSince(lastSeen, now) : null;
    const plannedAt = !started && !utgatt ? planerad(p) : null;
    const lateStartMin = plannedAt ? Math.floor((now - plannedAt) / 60000) : 0;
    const lateStart = !utgatt && !started && lateStartMin >= 3;
    return {
      patrol: p, startAt, finishAt,
      selfStarted: !!pass.selfStarted, selfFinished: !!pass.selfFinished, autoFinished: !!pass.autoFinished,
      reports, position, lastReport, lastSeen,
      started, active, silentMin, lateStart, lateStartMin, utgatt,
      warn: !utgatt && ((active && silentMin != null && silentMin >= WARN_SILENT_MIN) || (!started && lateStartMin >= 3))
    };
  });

  const ctrlStats = ordered.map((c, i) => {
    const prevN = i > 0 ? (ordered[i - 1].nummer ?? 0) : 0;
    const scores = scoresByCtrl[c.id] || [];
    const lastReport = scores
      .map(s => toDate(s.clientReportedAt ?? s.reportedAt)).filter(Boolean)
      .sort((a, b) => b - a)[0] || null;
    const inbound = perPatrol.filter(pp =>
      pp.active && pp.position === prevN && (i > 0 || pp.started)
    ).length;

    const legs = [];
    for (const pp of perPatrol) {
      const here = pp.reports.find(r => r.nummer === (c.nummer ?? 0));
      if (!here) continue;
      const prevT = i > 0
        ? pp.reports.filter(r => r.nummer <= prevN).map(r => r.t).sort((a, b) => b - a)[0] || null
        : pp.startAt;
      if (prevT && here.t > prevT) legs.push({ t: here.t, min: (here.t - prevT) / 60000 });
    }
    legs.sort((a, b) => a.t - b.t);
    const median = (arr) => {
      if (!arr.length) return null;
      const v = arr.map(x => x.min).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)];
    };
    const legMedian = median(legs);
    const recentMedian = median(legs.slice(-3));
    const trendUp = legs.length >= 4 && recentMedian != null && legMedian != null && recentMedian > legMedian * 1.35;

    const silent = minSince(lastReport, now);
    let heat = 'green';
    if (inbound >= 4) heat = 'red';
    else if (inbound >= 2) heat = 'yellow';
    if (inbound > 0 && silent != null && silent >= CTRL_STALE_MIN) heat = 'red';
    if (heat === 'yellow' && trendUp) heat = 'red';

    return { control: c, doneCount: scores.length, lastReport, silent, inbound, legMedian, recentMedian, trendUp, heat };
  });

  return { now, perPatrol, ctrlStats, ordered };
}

// ═══ Passagerna — spegel av mergePassages() i laget.js ══════════════════════
//
// Målgång har TRE källor och rangordningen är densamma överallt: en
// funktionär som SETT patrullen väger tyngst, sedan patrullens egen
// knapptryckning, sist den härledda. Den härledda skrivs aldrig — tiden
// ligger redan i poängdatan.

function slaIhopPassager({ comp, controls, patrols, scoresByCtrl, stationPassages, selfPassages }) {
  const passages = {};
  for (const [pid, row] of Object.entries(stationPassages || {})) passages[pid] = { ...row };
  for (const [pid, row] of Object.entries(selfPassages || {})) {
    const cur = passages[pid] || (passages[pid] = {});
    if (!cur.startAt && row.startAt) { cur.startAt = row.startAt; cur.selfStarted = true; }
    if (!cur.finishAt && row.finishAt) { cur.finishAt = row.finishAt; cur.selfFinished = true; }
  }
  if (comp?.autoFinish !== true) return passages;
  if (!controls.length) return passages;
  for (const p of patrols) {
    const cur = passages[p.id] || (passages[p.id] = {});
    if (cur.finishAt) continue;
    let senast = null, antal = 0;
    for (const c of controls) {
      const sc = (scoresByCtrl[c.id] || []).find(x => x.patrolId === p.id);
      if (!sc) break;                       // lucka → inte i mål
      antal++;
      const t = toDate(sc.clientReportedAt ?? sc.reportedAt);
      if (t && (!senast || t > senast)) senast = t;
    }
    if (antal === controls.length && senast) { cur.finishAt = senast; cur.autoFinished = true; }
  }
  return passages;
}

// ═══ Starttidsankaret — spegel av utils.js ══════════════════════════════════

function startTimeSettings(comp) {
  const s = comp?.startTimes || {};
  return {
    enabled: !!s.enabled,
    mode: s.mode === 'range' ? 'range' : 'interval',
    firstStart: s.firstStart || '09:00',
    intervalMinutes: Number(s.intervalMinutes) || 5,
    lastStart: s.lastStart || null
  };
}

function effectiveIntervalSec(comp, totalPatrols) {
  const s = startTimeSettings(comp);
  if (s.mode === 'range' && s.lastStart && totalPatrols >= 2) {
    const toMin = (t) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    const first = toMin(s.firstStart);
    let last = toMin(s.lastStart);
    if (!Number.isFinite(first) || !Number.isFinite(last)) return s.intervalMinutes * 60;
    if (last <= first) last += 24 * 60;             // rullar över midnatt
    return ((last - first) * 60) / (totalPatrols - 1);
  }
  return s.intervalMinutes * 60;
}

function patrolStartDateTime(comp, patrol, today = new Date(), totalPatrols = null) {
  const s = startTimeSettings(comp);
  if (!s.enabled) return null;
  const idx = Number(patrol?.startOrder);
  if (!Number.isFinite(idx)) return null;

  const iv = effectiveIntervalSec(comp, totalPatrols);

  if (comp?.demo) {
    const base = new Date(today.getTime() - 15 * iv * 1000);
    base.setSeconds(0, 0);
    base.setMinutes(Math.floor(base.getMinutes() / 5) * 5);
    base.setSeconds(base.getSeconds() + idx * iv);
    return base;
  }

  const [h, m] = s.firstStart.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;

  // Riktiga tävlingar med datum ankras på TÄVLINGSDAGEN.
  if (comp?.date) {
    const [Y, Mo, D] = String(comp.date).split('-').map(Number);
    if ([Y, Mo, D].every(Number.isFinite)) {
      const base = new Date(Y, Mo - 1, D, h, m, 0, 0);
      base.setSeconds(base.getSeconds() + idx * iv);
      return base;
    }
  }

  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  base.setHours(h, m, 0, 0);
  base.setSeconds(base.getSeconds() + idx * iv);
  return base;
}

// ═══ Livstecknet — spegel av mergeBeacons() i utils.js ══════════════════════
//
// En kontroll bemannas ofta av två telefoner. Den friska skrev förut över den
// döende, så Läget lyste grönt medan batteriet som faktiskt rapporterade gick
// mot noll. Senaste `at` vinner, men batteriet är det LÄGSTA bland enheter
// hörda senaste kvarten, och kön den största.

function mergeBeacons(docs, nu = Date.now()) {
  const rader = (docs || []).filter(d => d && d.at);
  if (!rader.length) return null;
  const tid = d => toDate(d.at).getTime();
  const senast = rader.reduce((a, b) => (tid(a) >= tid(b) ? a : b));
  const farska = rader.filter(d => nu - tid(d) < FARSK_MS);
  const medBatt = (farska.length ? farska : [senast]).filter(d => typeof d.batteri === 'number');
  const svagast = medBatt.length ? medBatt.reduce((a, b) => (a.batteri <= b.batteri ? a : b)) : null;
  return {
    at: senast.at,
    batteri: svagast ? svagast.batteri : null,
    laddar: svagast ? !!svagast.laddar : null,
    koade: Math.max(0, ...farska.map(d => Number(d.koade) || 0), 0),
    enheter: farska.length
  };
}

// ═══ Varningarna ═══════════════════════════════════════════════════════════
//
// Det HÄR är vad en biträdande tävlingsledare frågar efter: inte tabellen,
// utan "vad ska jag göra något åt just nu?". Webbvyn färgar celler; en modell
// behöver meningar. Varje varning är därför härledd ur exakt samma fält som
// färgar cellen — aldrig ur en egen tröskel.
//
// Ordningen är severitet först, för att den som läser uppifrån ska träffa det
// viktigaste även om listan kapas.

const ALLVAR_ORDNING = { kritisk: 0, varning: 1, info: 2 };

/** Svensk räkneform: "1 patrull", "3 patruller". */
const patruller = (n) => `${n} ${n === 1 ? 'patrull' : 'patruller'}`;

/**
 * PROVENIENSEN HÅLLS ISÄR I VARJE VARNING.
 *
 * `lage` är serverns EGNA ord och innehåller aldrig ett fältvärde. Namnen —
 * kontrollens och patrullens — ligger i egna nycklar som redaktionen märker
 * med "[data] ", eftersom de är skrivna av människor utanför samtalet:
 * patrullnamnen kommer från deltagande kårer via den anonyma
 * anmälningslänken.
 *
 * Första versionen bakade in namnen i meningen och lade "[data] " först i
 * hela strängen. Det gjorde två fel samtidigt: serverns egna ord såg ut som
 * fältinnehåll, och ett patrullnamn som försöker instruera modellen låg ändå
 * inbäddat i en mening som läses som text. Nu är gränsen synlig i formen.
 */
function varningar({ perPatrol, ctrlStats, beaconByCtrl, now, patrullEtikett }) {
  const ut = [];
  const etikett = patrullEtikett || (p => p.name || 'Okänd patrull');

  for (const cs of ctrlStats) {
    const nr = cs.control.nummer ?? null;
    const namn = cs.control.name || '';
    const b = (beaconByCtrl || {})[cs.control.id] || null;
    const bas = { kontroll: nr, name: namn };

    if (cs.heat === 'red' && cs.inbound > 0) {
      // Rött uppstår på två sätt, och åtgärden skiljer sig: många på väg in
      // är en bemanningsfråga, en tyst kontroll är ett telefonsamtal. Läget
      // färgar båda röda; här skiljs de åt i orden.
      const tyst = cs.silent != null && cs.silent >= CTRL_STALE_MIN;
      const delar = [];
      if (tyst) {
        delar.push(`Ingen rapport på ${cs.silent} minuter, och ${patruller(cs.inbound)} är på väg in.`);
        delar.push('Kontrollen kan vara obemannad eller utan täckning — ring den.');
      } else {
        delar.push(`Flaskhals: ${patruller(cs.inbound)} är på väg in.`);
      }
      if (cs.trendUp) {
        delar.push(`Mellantiden stiger: ${Math.round(cs.recentMedian)} minuter senast mot ${Math.round(cs.legMedian)} normalt.`);
      }
      ut.push({ allvar: 'kritisk', sort: tyst ? 'kontroll_tyst' : 'flaskhals', ...bas, lage: delar.join(' ') });
    } else if (cs.heat === 'yellow') {
      ut.push({
        allvar: 'varning', sort: 'ko_byggs_upp', ...bas,
        lage: `Kö byggs upp: ${patruller(cs.inbound)} är på väg in.`
      });
    }

    // En STÄNGD kontroll med patruller på väg in kan inte ta emot rapporter.
    // Det syns inte som en flaskhals och inte i någon färg — det syns först
    // när patrullerna står där.
    if (cs.control.open !== true && cs.inbound > 0) {
      ut.push({
        allvar: 'kritisk', sort: 'stangd_med_ko', ...bas,
        lage: `Kontrollen är STÄNGD men ${patruller(cs.inbound)} är på väg dit och kan inte rapportera.`
      });
    }

    if (b) {
      if (b.koade > 0) {
        ut.push({
          allvar: 'kritisk', sort: 'poang_i_ko', ...bas,
          lage: `${b.koade} rapporter ligger kvar i telefonen och har inte nått servern.`
        });
      }
      if (typeof b.batteri === 'number' && b.batteri <= 20 && !b.laddar) {
        ut.push({
          allvar: 'varning', sort: 'lagt_batteri', ...bas,
          lage: `Batteriet är på ${b.batteri} % och laddar inte.`
        });
      }
    }
  }

  for (const pp of perPatrol) {
    if (pp.utgatt) continue;
    if (pp.active && pp.silentMin != null && pp.silentMin >= WARN_SILENT_MIN) {
      ut.push({
        allvar: 'kritisk', sort: 'tyst_patrull', patrull: etikett(pp.patrol),
        lage: pp.position
          ? `Inget livstecken på ${pp.silentMin} minuter. Senast sedd vid kontroll ${pp.position}.`
          : `Inget livstecken på ${pp.silentMin} minuter. Har inte rapporterat någon kontroll sedan starten.`
      });
    }
    if (pp.lateStart) {
      ut.push({
        allvar: 'varning', sort: 'sen_till_start', patrull: etikett(pp.patrol),
        lage: `${pp.lateStartMin} minuter sen till start.`
      });
    }
  }

  ut.sort((a, b) => (ALLVAR_ORDNING[a.allvar] - ALLVAR_ORDNING[b.allvar])
    || String(a.sort).localeCompare(b.sort, 'sv'));
  return ut;
}

module.exports = {
  beraknaLaget, slaIhopPassager, varningar,
  patrolStartDateTime, startTimeSettings, effectiveIntervalSec, mergeBeacons,
  toDate, minSince, WARN_SILENT_MIN, CTRL_STALE_MIN
};
