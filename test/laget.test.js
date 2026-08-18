// Läges-härledningen, och vakten mot att de två kopiorna glider isär.
//
// Samma bild finns på två ställen: webbvyn (public/js/laget-core.js, ESM) och
// MCP-kopplingen (functions/mcp/laget.js, CJS). Utan byggsteg kan de inte
// dela fil, så priset är en spegel — och priset för spegeln är det här testet.
//
// Varför det är värre än vanlig dubblering: härledningen besvarar "var står
// det still?" MITT UNDER en tävling. Glider de isär läser sekretariatet en
// siffra på skärmen och hör en annan i chatten, och då är båda värdelösa.
// Testet kör därför BÅDA mot samma indata och kräver identiskt utfall — inte
// "ungefär lika".

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { beraknaLaget as esmBerakna, WARN_SILENT_MIN, CTRL_STALE_MIN } from '../public/js/laget-core.js';
import { patrolStartDateTime as esmStart, effectiveIntervalSec as esmInterval } from '../public/js/utils.js';

const require = createRequire(import.meta.url);
const cjs = require('../functions/mcp/laget.js');

// --- Ett påhittat men realistiskt tävlingsläge ------------------------------
// Kl 10:00. Tio kontroller, sex patruller i olika lägen: en i mål, en som
// köar vid 3, en tyst sedan 80 minuter, en utgången, en sen till start och en
// som inte startat än.

const T = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 8, 12, h, m, 0, 0);
};
const NU = T('10:00');

const controls = [
  { id: 'c1', nummer: 1, name: 'Spårkoll', open: true },
  { id: 'c2', nummer: 2, name: 'Knopar', open: true },
  { id: 'c3', nummer: 3, name: 'Första hjälpen', open: true },
  { id: 'c4', nummer: 4, name: 'Eldning', open: false }
];

const patrols = [
  { id: 'p1', name: 'Ekorrarna', kar: 'Lindsdals Scoutkår', startOrder: 0 },
  { id: 'p2', name: 'Rävarna', kar: 'Nybro Scoutkår', startOrder: 1 },
  { id: 'p3', name: 'Ugglorna', kar: 'Kalmar Scoutkår', startOrder: 2 },
  { id: 'p4', name: 'Bävrarna', kar: 'Lindsdals Scoutkår', startOrder: 3 },
  { id: 'p5', name: 'Vargarna', kar: 'Oskarshamns Scoutkår', startOrder: 4 },
  { id: 'p6', name: 'Älgarna', kar: 'Vimmerby Scoutkår', startOrder: 5, utgatt: { at: T('09:10') } }
];

// Poäng per kontroll. clientReportedAt är passagetiden.
const scoresByCtrl = {
  c1: [
    { patrolId: 'p1', poang: 20, clientReportedAt: T('08:20') },
    { patrolId: 'p2', poang: 18, clientReportedAt: T('08:40') },
    { patrolId: 'p3', poang: 15, clientReportedAt: T('08:30') },
    { patrolId: 'p4', poang: 12, clientReportedAt: T('09:20') }
  ],
  c2: [
    { patrolId: 'p1', poang: 22, clientReportedAt: T('08:35') },
    { patrolId: 'p2', poang: 20, clientReportedAt: T('08:58') },
    { patrolId: 'p4', poang: 14, clientReportedAt: T('09:40') }
  ],
  c3: [
    { patrolId: 'p1', poang: 25, clientReportedAt: T('08:52') },
    { patrolId: 'p2', poang: 21, clientReportedAt: T('09:30') }
  ],
  c4: [
    { patrolId: 'p1', poang: 19, clientReportedAt: T('09:15') }
  ]
};

const passages = {
  p1: { startAt: T('08:00'), finishAt: T('09:20') },
  p2: { startAt: T('08:20') },
  p3: { startAt: T('08:10') },          // tyst sedan 08:30 → 90 min
  p4: { startAt: T('09:00') },
  p6: { startAt: T('08:50') }
};

const comp = {
  name: 'Testet', date: '2026-09-12',
  startTimes: { enabled: true, mode: 'interval', firstStart: '08:00', intervalMinutes: 20 }
};

// Samma stub till BÅDA — parity-testet ska pröva härledningen, inte utils.js.
const plannedStartAt = (p) => {
  const idx = Number(p.startOrder);
  return Number.isFinite(idx) ? new Date(T('08:00').getTime() + idx * 20 * 60000) : null;
};

const indata = { comp, controls, patrols, passages, scoresByCtrl, now: NU, plannedStartAt };

/** Gör utfallet jämförbart: Date → ISO, patrull → id. */
function normalisera(res) {
  return {
    perPatrol: res.perPatrol.map(pp => ({
      id: pp.patrol.id,
      startAt: pp.startAt?.toISOString() ?? null,
      finishAt: pp.finishAt?.toISOString() ?? null,
      position: pp.position,
      antalRapporter: pp.reports.length,
      lastSeen: pp.lastSeen?.toISOString() ?? null,
      started: pp.started, active: pp.active,
      silentMin: pp.silentMin, lateStart: pp.lateStart, lateStartMin: pp.lateStartMin,
      utgatt: !!pp.utgatt, warn: pp.warn
    })),
    ctrlStats: res.ctrlStats.map(cs => ({
      id: cs.control.id,
      doneCount: cs.doneCount,
      lastReport: cs.lastReport?.toISOString() ?? null,
      silent: cs.silent, inbound: cs.inbound,
      legMedian: cs.legMedian, recentMedian: cs.recentMedian,
      trendUp: cs.trendUp, heat: cs.heat
    })),
    ordered: res.ordered.map(c => c.id)
  };
}

describe('spegeln: ESM och CJS måste ge IDENTISKT utfall', () => {
  test('hela härledningen, fält för fält', () => {
    const a = normalisera(esmBerakna(indata));
    const b = normalisera(cjs.beraknaLaget(indata));
    assert.deepEqual(b, a);
  });

  test('också när det inte finns någon data alls', () => {
    // Tomma listor är det läge en tävling faktiskt STARTAR i, och den gren
    // som är lättast att råka skriva olika (median av tom lista, inbound på
    // första kontrollen).
    const tomt = { comp, controls, patrols: [], passages: {}, scoresByCtrl: {}, now: NU, plannedStartAt };
    assert.deepEqual(normalisera(cjs.beraknaLaget(tomt)), normalisera(esmBerakna(tomt)));
  });

  test('och när ingen kontroll finns', () => {
    const tomt = { comp, controls: [], patrols, passages, scoresByCtrl: {}, now: NU, plannedStartAt };
    assert.deepEqual(normalisera(cjs.beraknaLaget(tomt)), normalisera(esmBerakna(tomt)));
  });

  test('konstanterna är desamma i båda filerna', () => {
    // Trösklarna ÄR beteendet: en tröskel som glider gör att skärmen larmar
    // och assistenten tiger, om samma kontroll.
    assert.equal(cjs.WARN_SILENT_MIN, WARN_SILENT_MIN);
    assert.equal(cjs.CTRL_STALE_MIN, CTRL_STALE_MIN);
  });

  test('starttidsankaret ger samma tid som utils.js', () => {
    // Egen spegel, egen risk: "sen till start" bygger på den här.
    for (const p of patrols) {
      for (const c of [comp, { ...comp, demo: true }, { ...comp, date: null },
                       { ...comp, startTimes: { enabled: true, mode: 'range', firstStart: '08:00', lastStart: '11:00' } }]) {
        const a = esmStart(c, p, NU, patrols.length);
        const b = cjs.patrolStartDateTime(c, p, NU, patrols.length);
        assert.equal(b?.getTime() ?? null, a?.getTime() ?? null,
          `startOrder ${p.startOrder}, demo=${!!c.demo}, mode=${c.startTimes?.mode}`);
      }
    }
  });

  test('intervallberäkningen likaså', () => {
    for (const n of [0, 1, 2, 5, 30]) {
      const c = { startTimes: { enabled: true, mode: 'range', firstStart: '09:00', lastStart: '12:00' } };
      assert.equal(cjs.effectiveIntervalSec(c, n), esmInterval(c, n), `n=${n}`);
    }
  });
});

describe('härledningen säger rätt saker om det påhittade läget', () => {
  const res = cjs.beraknaLaget(indata);
  const pp = (id) => res.perPatrol.find(x => x.patrol.id === id);
  const cs = (id) => res.ctrlStats.find(x => x.control.id === id);

  test('en patrull i mål är varken aktiv eller tyst', () => {
    assert.equal(pp('p1').active, false);
    assert.equal(pp('p1').silentMin, null);
    assert.equal(pp('p1').position, 4);
  });

  test('en patrull som varit tyst i 90 minuter flaggas', () => {
    // Ugglorna rapporterade kontroll 1 kl 08:30 och inget sedan dess.
    assert.equal(pp('p3').silentMin, 90);
    assert.equal(pp('p3').warn, true);
  });

  test('en UTGÅNGEN patrull räknas bort helt', () => {
    // Annars står den kvar i köer och tystnadslarm hela dagen.
    assert.equal(pp('p6').active, false);
    assert.equal(pp('p6').warn, false);
    assert.equal(pp('p6').silentMin, null);
  });

  test('kön till en kontroll är patruller vars senaste rapport är föregående', () => {
    // p2 står på kontroll 3 → på väg mot 4. p4 på 2 → på väg mot 3.
    assert.equal(cs('c4').inbound, 1);
    assert.equal(cs('c3').inbound, 1);
  });

  test('en patrull som inte startat räknas inte som kö till kontroll 1', () => {
    assert.equal(cs('c1').inbound, 0);
  });
});

describe('varningarna', () => {
  const res = cjs.beraknaLaget(indata);
  const etikett = (p) => `${p.name} (${p.kar})`;

  test('en stängd kontroll med patruller på väg dit är KRITISK', () => {
    // Den syns inte som en flaskhals och inte i någon färg — men patrullerna
    // som står där kan inte rapportera.
    const v = cjs.varningar({ ...res, beaconByCtrl: {}, patrullEtikett: etikett });
    const rad = v.find(x => x.sort === 'stangd_med_ko');
    assert.ok(rad, 'ingen varning för den stängda kontrollen');
    assert.equal(rad.allvar, 'kritisk');
    assert.match(rad.lage, /STÄNGD/);
    assert.equal(rad.kontroll, 4);
  });

  test('den tysta patrullen får en varning med kårnamn och position', () => {
    const v = cjs.varningar({ ...res, beaconByCtrl: {}, patrullEtikett: etikett });
    const rad = v.find(x => x.sort === 'tyst_patrull');
    assert.equal(rad.patrull, 'Ugglorna (Kalmar Scoutkår)');
    assert.match(rad.lage, /90 minuter/);
    assert.match(rad.lage, /kontroll 1/);
  });

  test('köade offline-rapporter i en telefon är KRITISKT', () => {
    // De finns inte på servern. Ingen annan yta visar det.
    const v = cjs.varningar({
      ...res,
      beaconByCtrl: { c2: cjs.mergeBeacons([{ at: NU, batteri: 80, koade: 3 }], NU.getTime()) },
      patrullEtikett: etikett
    });
    const rad = v.find(x => x.sort === 'poang_i_ko');
    assert.equal(rad.allvar, 'kritisk');
    assert.match(rad.lage, /3 rapporter/);
  });

  test('lågt batteri varnar — men inte när telefonen laddar', () => {
    const med = cjs.varningar({
      ...res, patrullEtikett: etikett,
      beaconByCtrl: { c1: cjs.mergeBeacons([{ at: NU, batteri: 11, laddar: false }], NU.getTime()) }
    });
    assert.ok(med.some(x => x.sort === 'lagt_batteri'));
    const laddar = cjs.varningar({
      ...res, patrullEtikett: etikett,
      beaconByCtrl: { c1: cjs.mergeBeacons([{ at: NU, batteri: 11, laddar: true }], NU.getTime()) }
    });
    assert.ok(!laddar.some(x => x.sort === 'lagt_batteri'), 'varnar fast telefonen laddar');
  });

  test('kritiska varningar står först', () => {
    const v = cjs.varningar({
      ...res, patrullEtikett: etikett,
      beaconByCtrl: { c1: cjs.mergeBeacons([{ at: NU, batteri: 5, laddar: false }], NU.getTime()) }
    });
    const forstaVarning = v.findIndex(x => x.allvar === 'varning');
    const sistaKritiska = v.map(x => x.allvar).lastIndexOf('kritisk');
    assert.ok(sistaKritiska < forstaVarning || forstaVarning === -1, 'ordningen är inte severitet först');
  });

  test('en utgången patrull ger aldrig en varning', () => {
    const v = cjs.varningar({ ...res, beaconByCtrl: {}, patrullEtikett: etikett });
    assert.ok(!v.some(x => (x.patrull || '').includes('Älgarna')), 'utgången patrull larmar');
  });

  test('PROVENIENSEN: serverns ord bär aldrig ett fältvärde', () => {
    // `lage` är serverns egna ord; namnen ligger i egna nycklar som
    // redaktionen märker med "[data] ". Bakar man in dem i meningen ser
    // serverns text ut som fältinnehåll, och ett patrullnamn som försöker
    // instruera modellen hamnar inbäddat i något som läses som text.
    const v = cjs.varningar({
      ...res, patrullEtikett: etikett,
      beaconByCtrl: { c1: cjs.mergeBeacons([{ at: NU, batteri: 5, laddar: false }], NU.getTime()) }
    });
    assert.ok(v.length, 'inga varningar att pröva');
    for (const rad of v) {
      assert.ok(rad.lage, `${rad.sort} saknar lage`);
      for (const namn of ['Ugglorna', 'Kalmar Scoutkår', 'Spårkoll', 'Knopar', 'Eldning', 'Första hjälpen']) {
        assert.ok(!rad.lage.includes(namn),
          `${rad.sort}: fältvärdet "${namn}" ligger inbäddat i serverns text`);
      }
      // …och namnet finns kvar, i sin egen nyckel.
      assert.ok(rad.name !== undefined || rad.patrull !== undefined,
        `${rad.sort} pekar inte ut vad den gäller`);
    }
  });

  test('räkneformen böjs: 1 patrull, 2 patruller', () => {
    const en = cjs.varningar({
      perPatrol: [], patrullEtikett: etikett, beaconByCtrl: {}, now: NU,
      ctrlStats: [{ control: { id: 'x', nummer: 9, name: 'X', open: false }, inbound: 1,
                    heat: 'green', silent: null, doneCount: 0, legMedian: null, recentMedian: null, trendUp: false }]
    });
    assert.match(en[0].lage, /1 patrull /);
    const flera = cjs.varningar({
      perPatrol: [], patrullEtikett: etikett, beaconByCtrl: {}, now: NU,
      ctrlStats: [{ control: { id: 'x', nummer: 9, name: 'X', open: false }, inbound: 3,
                    heat: 'green', silent: null, doneCount: 0, legMedian: null, recentMedian: null, trendUp: false }]
    });
    assert.match(flera[0].lage, /3 patruller/);
  });

  test('en TYST kontroll och en ÖVERBELASTAD kontroll säger olika saker', () => {
    // Båda är röda i Läget, men åtgärden skiljer sig: många på väg in är en
    // bemanningsfråga, en tyst kontroll är ett telefonsamtal.
    const grund = { control: { id: 'x', nummer: 9, name: 'X', open: true }, heat: 'red',
                    doneCount: 5, legMedian: 10, recentMedian: 10, trendUp: false };
    const tyst = cjs.varningar({ perPatrol: [], beaconByCtrl: {}, now: NU, patrullEtikett: etikett,
      ctrlStats: [{ ...grund, inbound: 1, silent: 60 }] });
    assert.equal(tyst[0].sort, 'kontroll_tyst');
    assert.match(tyst[0].lage, /ring den/i);
    const full = cjs.varningar({ perPatrol: [], beaconByCtrl: {}, now: NU, patrullEtikett: etikett,
      ctrlStats: [{ ...grund, inbound: 5, silent: 2 }] });
    assert.equal(full[0].sort, 'flaskhals');
    assert.match(full[0].lage, /Flaskhals/);
  });
});

describe('mergeBeacons: två telefoner på samma kontroll', () => {
  test('batteriet är den SVAGASTE, inte den senaste', () => {
    // Den friska skrev förut över den döende, och Läget lyste grönt medan
    // batteriet som faktiskt rapporterade gick mot noll.
    const nu = NU.getTime();
    const b = cjs.mergeBeacons([
      { at: new Date(nu - 60000), batteri: 90 },
      { at: new Date(nu - 30000), batteri: 12 }
    ], nu);
    assert.equal(b.batteri, 12);
    assert.equal(b.enheter, 2);
  });

  test('kön är den STÖRSTA bland färska enheter', () => {
    const nu = NU.getTime();
    const b = cjs.mergeBeacons([
      { at: new Date(nu - 60000), koade: 1 },
      { at: new Date(nu - 30000), koade: 4 }
    ], nu);
    assert.equal(b.koade, 4);
  });

  test('en enhet äldre än en kvart räknas inte in', () => {
    const nu = NU.getTime();
    const b = cjs.mergeBeacons([
      { at: new Date(nu - 20 * 60000), batteri: 3, koade: 9 },
      { at: new Date(nu - 60000), batteri: 80, koade: 0 }
    ], nu);
    assert.equal(b.batteri, 80);
    assert.equal(b.koade, 0);
    assert.equal(b.enheter, 1);
  });

  test('utan livstecken alls blir det null, inte en tom rad', () => {
    assert.equal(cjs.mergeBeacons([], NU.getTime()), null);
    assert.equal(cjs.mergeBeacons([{ batteri: 50 }], NU.getTime()), null);
  });
});
