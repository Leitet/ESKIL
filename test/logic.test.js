// Ren logik — inga beroenden, ingen emulator. Täcker det som räknar fram
// tider och identiteter, där ett fel är tyst men får konsekvenser i skogen.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  courseEta, courseEtaCalibrated, patrolFinishEtaMs, controlEtaWindow,
  DEFAULT_DWELL_MIN, ETA_MIN_SAMPLES, fmtDist, fmtMin
} from '../public/js/course.js';
import {
  patrolStartDateTime, normSlug, isValidSlug, suggestSlug,
  effectiveIntervalSec, swishAppUrl, swishQrString
} from '../public/js/utils.js';

// Tre kontroller på rad med ~1 km mellan sig.
const CONTROLS = [
  { id: 'c1', nummer: 1, lat: 58.000, lng: 15.0 },
  { id: 'c2', nummer: 2, lat: 58.009, lng: 15.0 },
  { id: 'c3', nummer: 3, lat: 58.018, lng: 15.0 }
];
const PATROLS = [
  { id: 'p1', startOrder: 0 }, { id: 'p2', startOrder: 1 },
  { id: 'p3', startOrder: 2 }, { id: 'p4', startOrder: 3 }
];
const COMP = { startTimes: { enabled: true, firstStart: '09:00', intervalMinutes: 10 } };
const NOW = new Date('2026-08-14T12:00:00');
const at = (h, m) => new Date(`2026-08-14T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`).toISOString();

describe('Starttider', () => {
  test('ankras på TÄVLINGSDAGEN när datum finns', () => {
    // Startkortet öppnas dagar i förväg — nedräkningen ska gå mot rätt dag.
    const d = patrolStartDateTime({ ...COMP, date: '2026-10-04' }, { startOrder: 2 }, NOW, 4);
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 9); // oktober
    assert.equal(d.getDate(), 4);
    assert.equal(d.getHours(), 9);
    assert.equal(d.getMinutes(), 20);
  });

  test('utan datum ankras den på dagens klocka (testtävlingar)', () => {
    const d = patrolStartDateTime(COMP, { startOrder: 1 }, NOW, 4);
    assert.equal(d.getDate(), NOW.getDate());
    assert.equal(d.getMinutes(), 10);
  });

  test('demo rullar med klockan i stället för datumet', () => {
    const d = patrolStartDateTime({ ...COMP, demo: true, date: '2026-10-04' }, { startOrder: 0 }, NOW, 4);
    assert.notEqual(d.getMonth(), 9, 'demo ska inte ankras på tävlingsdatumet');
  });

  test('intervallet härleds ur sluttiden i range-läge', () => {
    const comp = { startTimes: { enabled: true, mode: 'range', firstStart: '09:00', lastStart: '10:00' } };
    assert.equal(effectiveIntervalSec(comp, 5), 900); // 60 min / 4 mellanrum
  });

  test('range över midnatt hanteras', () => {
    const comp = { startTimes: { enabled: true, mode: 'range', firstStart: '22:00', lastStart: '02:00' } };
    assert.equal(effectiveIntervalSec(comp, 5), 3600); // 4 h / 4
  });
});

describe('ETA — modellen', () => {
  test('summerar gångtid och stationstid', () => {
    const eta = courseEta(COMP, CONTROLS, null);
    assert.ok(eta.totalDist > 1800 && eta.totalDist < 2200, 'ca 2 km');
    // c2: ~1 km gång + en stationstid på c1
    assert.ok(eta.byKey.c2.etaMin > DEFAULT_DWELL_MIN);
    assert.ok(eta.finishMin > eta.byKey.c3.etaMin, 'målet ligger efter sista kontrollen');
  });

  test('utan kontroller ger ingen sträcka', () => {
    const eta = courseEta(COMP, [], null);
    assert.equal(eta.totalDist, 0);
  });
});

describe('ETA — kalibrering mot verkliga mellantider', () => {
  const scores = (list) => list.map(([controlId, patrolId, iso, client]) =>
    ({ controlId, patrolId, reportedAt: iso, ...(client ? { clientReportedAt: client } : {}) }));

  test('median ersätter modellen vid minst tre sampel', () => {
    // Kö på c2: 60 min mellantid mot modellens ~30.
    const s = scores([
      ['c1', 'p1', at(9, 20)], ['c1', 'p2', at(9, 30)], ['c1', 'p3', at(9, 40)],
      ['c2', 'p1', at(10, 20)], ['c2', 'p2', at(10, 30)], ['c2', 'p3', at(10, 40)]
    ]);
    const cal = courseEtaCalibrated(COMP, CONTROLS, null, s, PATROLS, NOW);
    assert.equal(cal.byKey.c1.calibrated, true);
    assert.equal(Math.round(cal.byKey.c1.depMin), 20, 'c1 avfärd = observerade 20 min');
    assert.equal(Math.round(cal.byKey.c2.depMin), 80, 'c2 avfärd = 20 + observerade 60');
    assert.ok(cal.finishMin > courseEta(COMP, CONTROLS, null).finishMin, 'kön förlänger banan');
  });

  test(`under ${ETA_MIN_SAMPLES} sampel behålls modellen`, () => {
    const s = scores([['c1', 'p1', at(9, 20)], ['c1', 'p2', at(9, 30)]]);
    const cal = courseEtaCalibrated(COMP, CONTROLS, null, s, PATROLS, NOW);
    assert.equal(cal.byKey.c1.calibrated, false);
    assert.equal(cal.byKey.c1.samples, 2);
  });

  test('clientReportedAt vinner över reportedAt (offline-batchsynk)', () => {
    // Alla synkade 13:00 men trycktes 09:20–09:40.
    const s = scores([
      ['c1', 'p1', at(13, 0), at(9, 20)],
      ['c1', 'p2', at(13, 0), at(9, 30)],
      ['c1', 'p3', at(13, 0), at(9, 40)]
    ]);
    const cal = courseEtaCalibrated(COMP, CONTROLS, null, s, PATROLS, NOW);
    assert.equal(Math.round(cal.byKey.c1.depMin), 20, 'passagetiden, inte synktiden');
  });

  test('orimliga mellantider fångas av plausibilitetsvakten', () => {
    // Gamla poster utan clientReportedAt, alla synkade 13:00 → ~200 min.
    const s = scores([
      ['c1', 'p1', at(9, 20)], ['c1', 'p2', at(9, 30)], ['c1', 'p3', at(9, 40)],
      ['c2', 'p1', at(13, 0)], ['c2', 'p2', at(13, 0)], ['c2', 'p3', at(13, 0)]
    ]);
    const cal = courseEtaCalibrated(COMP, CONTROLS, null, s, PATROLS, NOW);
    assert.equal(cal.byKey.c2.calibrated, false, 'synkklumpen ska inte fånga medianen');
  });

  test('demo kalibrerar inte (frusna seed-tider)', () => {
    const s = scores([
      ['c1', 'p1', at(9, 20)], ['c1', 'p2', at(9, 30)], ['c1', 'p3', at(9, 40)]
    ]);
    const cal = courseEtaCalibrated({ ...COMP, demo: true }, CONTROLS, null, s, PATROLS, NOW);
    assert.equal(cal.calibrated, false);
    assert.equal(cal.demoMode, true);
  });

  test('faktisk starttid används som ankare när den finns', () => {
    const s = scores([
      ['c1', 'p1', at(9, 20)], ['c1', 'p2', at(9, 30)], ['c1', 'p3', at(9, 40)]
    ]);
    const actual = {
      p1: new Date('2026-08-14T09:10:00').getTime(),
      p2: new Date('2026-08-14T09:20:00').getTime(),
      p3: new Date('2026-08-14T09:30:00').getTime()
    };
    const cal = courseEtaCalibrated(COMP, CONTROLS, null, s, PATROLS, NOW, actual);
    assert.equal(Math.round(cal.byKey.c1.depMin), 10, 'mätt från faktisk start, inte planerad');
  });

  test('överhoppade kontroller förgiftar inte medianen', () => {
    const s = scores([
      ['c1', 'p1', at(9, 20)], ['c1', 'p2', at(9, 30)], ['c1', 'p3', at(9, 40)],
      ['c3', 'p1', at(10, 30)] // hoppade c2
    ]);
    const cal = courseEtaCalibrated(COMP, CONTROLS, null, s, PATROLS, NOW);
    assert.equal(cal.byKey.c3.samples, 0, 'saknar föregående rapport → inget sampel');
  });

  test('ordningen i score-listan spelar ingen roll', () => {
    const rows = scores([
      ['c1', 'p1', at(9, 20)], ['c1', 'p2', at(9, 30)], ['c1', 'p3', at(9, 40)]
    ]);
    const a = courseEtaCalibrated(COMP, CONTROLS, null, rows, PATROLS, NOW);
    const b = courseEtaCalibrated(COMP, CONTROLS, null, [...rows].reverse(), PATROLS, NOW);
    assert.equal(a.byKey.c1.depMin, b.byKey.c1.depMin);
  });
});

describe('ETA — per patrull', () => {
  test('ankras i senaste rapporten, inte i starttiden', () => {
    const eta = courseEtaCalibrated(COMP, CONTROLS, null, [], PATROLS, NOW);
    const fin = patrolFinishEtaMs(eta, { c1: at(10, 0) }, null);
    const kvar = eta.finishMin - eta.byKey.c1.depMin;
    assert.equal(fin, new Date(at(10, 0)).getTime() + kvar * 60000);
  });

  test('utan rapporter räknas hela banan från starten', () => {
    const eta = courseEtaCalibrated(COMP, CONTROLS, null, [], PATROLS, NOW);
    const start = new Date('2026-08-14T09:30:00').getTime();
    assert.equal(patrolFinishEtaMs(eta, {}, start), start + eta.finishMin * 60000);
  });

  test('demo ignorerar rapportankare', () => {
    const eta = courseEtaCalibrated({ ...COMP, demo: true }, CONTROLS, null, [], PATROLS, NOW);
    const start = new Date('2026-08-14T11:00:00').getTime();
    assert.equal(patrolFinishEtaMs(eta, { c1: at(9, 0) }, start), start + eta.finishMin * 60000);
  });

  test('null-säkert', () => {
    assert.equal(patrolFinishEtaMs(null, {}, 0), null);
    assert.equal(patrolFinishEtaMs(courseEta(COMP, CONTROLS, null), null, null), null);
  });

  test('fönstret "patruller väntas" spänner första till sista start', () => {
    const w = controlEtaWindow(COMP, CONTROLS, null, PATROLS, 'c2', NOW);
    assert.ok(w && w.lo && w.hi);
    assert.notEqual(w.lo, w.hi, 'fyra patruller med 10 min mellanrum ger ett spann');
  });

  test('inget fönster utan starttider', () => {
    assert.equal(controlEtaWindow({ startTimes: { enabled: false } }, CONTROLS, null, PATROLS, 'c2', NOW), null);
  });
});

describe('Kortadress (slug)', () => {
  test('normalisering', () => {
    assert.equal(normSlug('AH 26'), 'ah-26');
    assert.equal(normSlug('Älghornsjakten!'), 'alghornsjakten');
    assert.equal(normSlug('  Öst/Väst  '), 'ostvast');
  });

  test('validering', () => {
    assert.equal(isValidSlug('ah26'), true);
    assert.equal(isValidSlug('a'), false, 'för kort');
    assert.equal(isValidSlug('AH26'), false, 'versaler');
    assert.equal(isValidSlug('ah 26'), false, 'mellanslag');
  });

  test('förslag bygger på ordinitialer + år', () => {
    assert.equal(suggestSlug('Dalslands Mästerskap', 2026), 'dm26');
  });

  test('ett enda ord ger de två första gångbara bokstäverna', () => {
    // Referensalfabetet utesluter förväxlingsbara tecken (bl.a. I, L, O),
    // så "Älghornsjakten" ger AG — inte AL. Produktionens "ah26" är ett
    // manuellt val, inte förslaget.
    assert.equal(suggestSlug('Älghornsjakten', 2026), 'ag26');
  });
});

describe('Swish', () => {
  test('QR-strängen låser belopp och meddelande', () => {
    assert.equal(swishQrString('123 456 78 90', 300, 'AH26-1234'), 'C1234567890;300;AH26-1234;0');
  });

  test('deep-länken bär samma fält', () => {
    const url = new URL(swishAppUrl('123 456 78 90', 300, 'AH26-1234'));
    assert.equal(url.searchParams.get('sw'), '1234567890');
    assert.equal(url.searchParams.get('amt'), '300');
    assert.equal(url.searchParams.get('cur'), 'SEK');
    assert.equal(url.searchParams.get('msg'), 'AH26-1234');
  });
});

describe('Formatering', () => {
  test('avstånd', () => {
    assert.equal(fmtDist(500), '500 m');
    assert.equal(fmtDist(2300), '2,3 km');
  });
  test('tid', () => {
    assert.equal(fmtMin(45), '45 min');
    assert.equal(fmtMin(184), '3 h 04 min');
  });
});
