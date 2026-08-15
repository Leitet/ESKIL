// Ren logik — inga beroenden, ingen emulator. Täcker det som räknar fram
// tider och identiteter, där ett fel är tyst men får konsekvenser i skogen.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  courseEta, courseEtaCalibrated, patrolFinishEtaMs, controlEtaWindow,
  waypointInsertIndex, nearestSegmentIndex, pointToSegmentDistance,
  DEFAULT_DWELL_MIN, ETA_MIN_SAMPLES, fmtDist, fmtMin
} from '../public/js/course.js';
import {
  patrolStartDateTime, normSlug, isValidSlug, suggestSlug,
  effectiveIntervalSec, swishAppUrl, swishQrString
} from '../public/js/utils.js';
import { DISTRICTS, districtById, districtShort, districtName, districtHue, normDistrict } from '../public/js/districts.js';

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

describe('Scoutdistrikt', () => {
  test('listan har unika id:n och namn', () => {
    const ids = DISTRICTS.map(d => d.id);
    assert.equal(new Set(ids).size, ids.length, 'dubblerade id:n');
    const namn = DISTRICTS.map(d => d.name);
    assert.equal(new Set(namn).size, namn.length, 'dubblerade namn');
  });

  test('Scouternas 26 distrikt plus "annat"', () => {
    assert.equal(DISTRICTS.length, 27);
    assert.equal(DISTRICTS.filter(d => d.other).length, 1);
    assert.equal(DISTRICTS[DISTRICTS.length - 1].id, 'annat', '"annat" ligger sist');
  });

  test('kända distrikt går att slå upp', () => {
    assert.equal(districtName('dacke'), 'Dacke Scoutdistrikt');
    assert.equal(districtShort('dacke'), 'Dacke');
    assert.equal(districtShort('orebro'), 'Örebro Län', 'prefixet Scouterna kapas');
    assert.equal(districtShort('annat'), 'Annat');
  });

  test('okänt id ger tomt i stället för att krascha', () => {
    assert.equal(districtById('finns-inte'), null);
    assert.equal(districtShort('finns-inte'), '');
    assert.equal(districtName(undefined), '');
  });

  test('okänt eller tomt distrikt normaliseras till "annat"', () => {
    // En select utan matchande option ger "" — det får inte sparas rakt av,
    // då faller tävlingen ur grupperingen utan synlig orsak.
    assert.equal(normDistrict(''), 'annat');
    assert.equal(normDistrict(null), 'annat');
    assert.equal(normDistrict(undefined), 'annat');
    assert.equal(normDistrict('sodra-skane'), 'annat', 'nästan rätt id är fel id');
    assert.equal(normDistrict('sodraskane'), 'sodraskane');
    assert.equal(normDistrict('dacke'), 'dacke');
  });

  test('färgtonen är stabil och inom gradskalan', () => {
    for (const d of DISTRICTS) {
      const h = districtHue(d.id);
      assert.ok(h >= 0 && h < 360, `${d.id} gav ${h}`);
      assert.equal(h, districtHue(d.id), 'samma id ska ge samma ton');
    }
  });
});

describe('Spårritning — var en ny punkt hamnar', () => {
  const pt = (x, y) => ({ x, y });

  test('avstånd till segment klipps vid ändpunkterna', () => {
    assert.equal(pointToSegmentDistance(pt(50, 10), pt(0, 0), pt(100, 0)), 10);
    assert.equal(pointToSegmentDistance(pt(-30, 0), pt(0, 0), pt(100, 0)), 30, 'bakom starten');
    assert.equal(pointToSegmentDistance(pt(130, 0), pt(0, 0), pt(100, 0)), 30, 'bortom slutet');
  });

  test('REGRESSION: punkten hamnar inte två steg tillbaka när spåret bågar', () => {
    // Benet går A(0,0) → B(400,0). Användaren har satt P1 uppe till vänster
    // och klickar vidare uppåt-höger för att fortsätta bågen.
    const A = { x: 0, y: 0 }, P1 = { x: 100, y: -200 }, B = { x: 400, y: 0 };
    const path = [A, P1, B];
    const klick = { x: 150, y: -300 };

    // Klicket ligger UTANFÖR vinkeln vid P1: det projiceras bortom slutet på
    // A→P1 och före början på P1→B, så båda segmenten klipps till samma hörn
    // och hamnar på exakt samma avstånd. Den gamla regeln tog första bästa
    // minimum och lade därför punkten i segment 0 — alltså FÖRE P1. Spåret
    // hoppade bakåt. Området där det inträffar är stort så fort spåret bågar.
    const dA = pointToSegmentDistance(klick, A, P1);
    const dB = pointToSegmentDistance(klick, P1, B);
    assert.equal(dA, dB, 'oavgjort — det är här den gamla regeln föll');

    assert.equal(nearestSegmentIndex(path, klick).index, 1, 'oavgjort ska vinnas framåt');
    assert.equal(waypointInsertIndex(path, klick), 1, 'punkten läggs EFTER P1, inte före');
  });

  test('klick på linjen justerar spåret där det landar', () => {
    // Samma båge, men klicket ligger PÅ det första segmentet — då är
    // avsikten att förfina just där, inte att förlänga.
    const path = [pt(0, 0), pt(100, -200), pt(400, 0)];
    assert.equal(waypointInsertIndex(path, pt(50, -100)), 0);
  });

  test('första punkten på ett orört ben', () => {
    const path = [pt(0, 0), pt(400, 0)];
    assert.equal(waypointInsertIndex(path, pt(200, -300)), 0, 'långt bort → sist (= enda)');
    assert.equal(waypointInsertIndex(path, pt(200, 5)), 0, 'på linjen → i enda segmentet');
  });

  test('en punkt mitt i en färdig kedja hamnar mellan rätt grannar', () => {
    // Kedja A—P1—P2—P3—B längs en rak linje; klick nära sträckan P2–P3.
    const path = [pt(0, 0), pt(100, 0), pt(200, 0), pt(300, 0), pt(400, 0)];
    assert.equal(waypointInsertIndex(path, pt(250, 8)), 2, 'index i wps: efter P2');
  });

  test('lika avstånd vinns av det senare segmentet (ritningen går framåt)', () => {
    // Klicket ligger rakt ovanför skarven mellan två raka segment.
    const path = [pt(0, 0), pt(100, 0), pt(200, 0)];
    assert.equal(nearestSegmentIndex(path, pt(100, 40)).index, 1);
  });
});
