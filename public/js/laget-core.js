// Läges-härledningen — den rena kärnan bakom sekretariatets tävlingsdagsvy.
//
// VARFÖR EN EGEN FIL: samma bild ska nu finnas på TVÅ ställen — i webbvyn
// (views/laget.js) och via MCP-kopplingen, där en biträdande tävlingsledares
// assistent frågar efter läget. Räknar de två var för sig får den som frågar
// två sanningar på tävlingsdagen, och den ena är fel. Härledningen bor därför
// här, och `functions/mcp/laget.js` är en CJS-spegel av exakt den här filen
// (functions/ är CommonJS, publikkoden är ESM — samma skäl som ledning.js).
// Ett test kör BÅDA mot samma indata och kräver identiskt utfall.
//
// Kärnan är AVSIKTLIGT beroendefri: inga imports, ingen DOM, inga timers.
// Starttidsankaret skickas in som funktion (`plannedStartAt`) i stället för
// att importeras, så att parity-testet kan mata båda implementationerna med
// exakt samma stub och därmed pröva den här logiken — inte utils.js.
//
// ETA-berikningen ligger KVAR i vyn. Den hänger på course.js kalibrerade
// motor, och laget.js kallar den redan "en bonus — aldrig ett fel". Att
// porta den till CJS vore stor kod för litet värde; MCP:n rapporterar därför
// position och tryck, aldrig en egen måltidsgissning som kan säga emot
// skärmen.

/** Patrull ute utan livstecken så här länge → varning. */
export const WARN_SILENT_MIN = 60;
/** Kontroll tyst så här länge MED patruller på väg in → rött. */
export const CTRL_STALE_MIN = 45;

export const HEAT = {
  green:  { fill: '#41A62A', label: 'Lugnt' },
  yellow: { fill: '#E2B100', label: 'Kö byggs upp' },
  red:    { fill: '#DA005E', label: 'Flaskhals' }
};

export const toDate = (ts) =>
  ts && typeof ts.toDate === 'function' ? ts.toDate() : (ts ? new Date(ts) : null);

export const minSince = (d, now) => d ? Math.floor((now - d) / 60000) : null;

/**
 * Härleder hela läget ur råa ögonblicksbilder.
 *
 * @param comp           tävlingsdokumentet
 * @param controls       kontrollerna (osorterade)
 * @param patrols        patrullerna
 * @param passages       { patrolId: { startAt, finishAt, selfStarted?, ... } }
 *                       — redan sammanslagen ur station, självavprickning och
 *                       härledd målgång. Rangordningen görs av anroparen.
 * @param scoresByCtrl   { controlId: [poängdokument] }
 * @param now            Date — anroparen äger klockan (demo pinnar sin egen)
 * @param plannedStartAt (patrull) => Date|null — planerad starttid, injicerad
 */
export function beraknaLaget({ comp, controls, patrols, passages, scoresByCtrl, now, plannedStartAt }) {
  const ordered = [...controls].sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));
  const planerad = plannedStartAt || (() => null);

  // Per patrull: rapporter per kontrollnummer, position, tidsstämplar.
  const perPatrol = patrols.map(p => {
    const pass = passages[p.id] || {};
    const reports = [];
    for (const c of ordered) {
      const s = (scoresByCtrl[c.id] || []).find(x => x.patrolId === p.id);
      // clientReportedAt = tryckögonblicket, reportedAt = synktiden. En
      // offline-kö som flushas tre timmar senare gör den senare till en lögn:
      // patrullen såg "nyss sedd" ut fast ingen sett den sedan kl 11.
      const t = toDate(s?.clientReportedAt ?? s?.reportedAt);
      if (t) reports.push({ nummer: c.nummer ?? 0, t });
    }
    reports.sort((a, b) => a.nummer - b.nummer);
    const startAt = toDate(pass.startAt);
    const finishAt = toDate(pass.finishAt);
    const position = reports.length ? reports[reports.length - 1].nummer : 0;
    const lastReport = reports.length ? reports.reduce((m, r) => r.t > m ? r.t : m, reports[0].t) : null;
    const lastSeen = [startAt, finishAt, lastReport].filter(Boolean).sort((a, b) => b - a)[0] || null;
    // DNF: en utgått patrull är per definition inte ute i skogen — den
    // räknas bort ur köer, tystnadsvarningar och sen-till-start-larm.
    const utgatt = p.utgatt || null;
    const started = !!startAt || reports.length > 0;
    const active = !utgatt && started && !finishAt;
    const silentMin = active ? minSince(lastSeen, now) : null;
    // Sen till start: planerad tid passerad (3 min marginal) utan livstecken.
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

  // Per kontroll: antal klara, senaste aktivitet, kö på väg in, mellantider.
  const ctrlStats = ordered.map((c, i) => {
    const prevN = i > 0 ? (ordered[i - 1].nummer ?? 0) : 0;
    const scores = scoresByCtrl[c.id] || [];
    const lastReport = scores
      .map(s => toDate(s.clientReportedAt ?? s.reportedAt)).filter(Boolean)
      .sort((a, b) => b - a)[0] || null;
    // Kötrycket ÄR en skattning: banan går start → 1 → 2 → … → mål, så en
    // aktiv patrull vars senaste rapport är kontroll N-1 går mot eller står
    // i kö vid kontroll N.
    const inbound = perPatrol.filter(pp =>
      pp.active && pp.position === prevN && (i > 0 || pp.started)
    ).length;

    // Mellantid: minuter från föregående avstämning (föregående kontrolls
    // rapport, eller startavprickningen för första kontrollen) till den här.
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
