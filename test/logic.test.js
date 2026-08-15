// Ren logik — inga beroenden, ingen emulator. Täcker det som räknar fram
// tider och identiteter, där ett fel är tyst men får konsekvenser i skogen.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  courseEta, courseEtaCalibrated, patrolFinishEtaMs, controlEtaWindow, courseLegs,
  waypointInsertIndex, nearestSegmentIndex, pointToSegmentDistance,
  DEFAULT_DWELL_MIN, ETA_MIN_SAMPLES, fmtDist, fmtMin
} from '../public/js/course.js';
import {
  patrolStartDateTime, normSlug, isValidSlug, suggestSlug,
  effectiveIntervalSec, swishAppUrl, swishQrString, patrolLabel
} from '../public/js/utils.js';
import { hasIcon } from '../public/js/icons.js';
import { AVD_FÄRG, textPå, accentMotBlått, hjälte } from '../public/js/share-card.js';

// WCAG-kontrast — testets egen räknare, så det inte mäter med samma kod som
// det granskar.
function kontrastMellan(a, b) {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const k = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * k((n >> 16) & 255) + 0.7152 * k((n >> 8) & 255) + 0.0722 * k(n & 255);
  };
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
import { fitView, niceScale } from '../public/js/pdf.js';
import {
  PLACE_KINDS, PLACE_ICONS, PALETTE, placeColorHex, normPlace, compPlaces, placeToStorage, coursePlaces
} from '../public/js/places.js';
import { patrolHighlights, controlRank, totalRank, rankWorthShowing } from '../public/js/highlights.js';
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

describe('Höjdpunkter på startkortet', () => {
  // Fyra kontroller, fem patruller. p1 är vår patrull.
  const CTRLS = [
    { id: 'k1', nummer: 1, maxPoang: 10 },
    { id: 'k2', nummer: 2, maxPoang: 10 },
    { id: 'k3', nummer: 3, maxPoang: 10 },
    { id: 'k4', nummer: 4, maxPoang: 10 }
  ];
  const sc = (pid, poang, extra) => ({ patrolId: pid, poang, ...(extra ? { extraPoang: extra } : {}) });
  const FIELD = {
    k1: [sc('p1', 10), sc('p2', 4), sc('p3', 6), sc('p4', 2), sc('p5', 8)],
    k2: [sc('p1', 9),  sc('p2', 3), sc('p3', 5), sc('p4', 1), sc('p5', 7)],
    k3: [sc('p1', 2),  sc('p2', 9), sc('p3', 8), sc('p4', 7), sc('p5', 6)],
    k4: [sc('p1', 7),  sc('p2', 8), sc('p3', 4), sc('p4', 3), sc('p5', 5)]
  };
  const run = (o = {}) => patrolHighlights({ patrolId: 'p1', controls: CTRLS, scoresByControl: FIELD, ...o });
  const texts = (o) => run(o).map(h => h.text);

  test('lyfter topp 3 på enskilda kontroller', () => {
    // p1 är bäst på k1 och k2, sist på k3, tvåa på k4 → topp 3 på tre.
    assert.ok(texts().some(t => t === 'Topp 3 på 3 kontroller! Snyggt!'), texts().join(' | '));
    assert.ok(texts().some(t => t === 'Bäst av alla på 2 kontroller!'));
  });

  test('säger ingenting om det som gick dåligt', () => {
    // k3 är patrullens sämsta kontroll (2 av 10, sist i fältet).
    const alla = texts().join(' ').toLowerCase();
    for (const ord of ['sämst', 'sist', 'bara', 'tyvärr', 'missad', 'noll', 'k3'])
      assert.ok(!alla.includes(ord), `höjdpunkterna nämner "${ord}": ${alla}`);
  });

  test('placeringen visas bara när den är värd att fira', () => {
    // p1 har 28 p, p2 24, p3 23, p5 26, p4 13 → plats 1.
    assert.ok(texts().some(t => t.startsWith('Bäst i tävlingen')), texts().join(' | '));

    // Samma fält, men vår patrull är sist: ingen placeringsrad alls.
    const svag = { patrolId: 'p4', controls: CTRLS, scoresByControl: FIELD };
    const svagaTexter = patrolHighlights(svag).map(h => h.text);
    assert.ok(!svagaTexter.some(t => /^Plats |^Bäst i tävlingen/.test(t)),
      'sista platsen ska inte skrivas ut: ' + svagaTexter.join(' | '));
    assert.ok(svagaTexter.length > 0, 'men det ska ändå stå något positivt');
  });

  test('opublicerade poäng döljer alla jämförelser', () => {
    const t = texts({ showRank: false });
    assert.ok(!t.some(x => /Topp|Plats|snittet|Bäst av alla|Bäst i tävlingen/.test(x)), t.join(' | '));
    assert.ok(t.some(x => x === 'Alla 4 kontroller klara!'), 'egna prestationer visas ändå');
  });

  test('full pott och extrapoäng räknas', () => {
    const t = patrolHighlights({
      patrolId: 'p1', controls: CTRLS,
      scoresByControl: { ...FIELD, k2: [sc('p1', 10, 3), ...FIELD.k2.slice(1)] }
    }).map(h => h.text);
    assert.ok(t.some(x => x === 'Full pott på 2 kontroller'), t.join(' | '));
    assert.ok(t.some(x => x === '3 extrapoäng inhämtade'));
  });

  test('tunt underlag ger ingen placering', () => {
    // Två patruller på kontrollen — "topp 3 av 2" betyder ingenting.
    const tunt = { k1: [sc('p1', 10), sc('p2', 4)] };
    assert.equal(controlRank('p1', tunt.k1), null);
    const t = patrolHighlights({ patrolId: 'p1', controls: [CTRLS[0]], scoresByControl: tunt }).map(h => h.text);
    assert.ok(!t.some(x => /Topp|Bäst av alla/.test(x)), t.join(' | '));
  });

  test('utan poäng finns inget att lyfta', () => {
    assert.deepEqual(patrolHighlights({ patrolId: 'okänd', controls: CTRLS, scoresByControl: FIELD }), []);
  });

  test('noll poäng är ett resultat, inte ett saknat', () => {
    // Number(null) === 0-fällan: en nollrapport ska räknas som avklarad.
    const t = patrolHighlights({
      patrolId: 'p9', controls: [CTRLS[0]],
      scoresByControl: { k1: [sc('p9', 0), sc('p2', 4), sc('p3', 6), sc('p4', 2)] }
    }).map(h => h.text);
    assert.ok(t.length > 0 && t[0].includes('klara'), t.join(' | '));
  });

  test('tid på banan visas när start och mål är kända', () => {
    const t = texts({ startMs: 0, endMs: 3 * 3600e3 + 12 * 60e3 });
    assert.ok(t.some(x => x === '3 h 12 min på banan'), t.join(' | '));
  });

  test('orimligt kort tid är ett datafel, inte en bragd', () => {
    // Prickas start och mål av inom samma minut ska raden utebli — inte
    // stå "0 min på banan" på scoutens minneskort.
    for (const slut of [0, 30e3, 4 * 60e3]) {
      const t = texts({ startMs: 0, endMs: slut });
      assert.ok(!t.some(x => x.includes('på banan')), `${slut} ms gav: ${t.join(' | ')}`);
    }
  });
});

describe('Intressepunkter', () => {
  test('varje symbol finns faktiskt i icons.js', () => {
    // Det här är felet som annars upptäcks först ute i skogen: en kartnål
    // som renderar tomt för att symbolnamnet inte finns.
    for (const namn of PLACE_ICONS) assert.ok(hasIcon(namn), `symbolen saknas: ${namn}`);
    for (const k of PLACE_KINDS) assert.ok(hasIcon(k.icon), `${k.id} pekar på symbolen ${k.icon}`);
  });

  test('varje förvald sort har en färg ur paletten', () => {
    const färger = new Set(PALETTE.map(c => c.id));
    for (const k of PLACE_KINDS) assert.ok(färger.has(k.color), `${k.id}: ${k.color}`);
    const ids = PLACE_KINDS.map(k => k.id);
    assert.equal(new Set(ids).size, ids.length, 'dubblerade sorter');
    assert.equal(new Set(PLACE_ICONS).size, PLACE_ICONS.length, 'dubblerade symboler');
  });

  test('okända värden faller tillbaka i stället för att försvinna', () => {
    // En plats som inte går att rita skulle tyst trilla av kartan.
    const p = normPlace({ id: 'x', kind: 'hittepa', icon: 'hittepa', color: 'hittepa', lat: 58, lng: 15 });
    assert.equal(p.kind, 'annat');
    assert.ok(PLACE_ICONS.includes(p.icon));
    assert.ok(p.colorHex.startsWith('#'));
    assert.equal(p.name, 'Egen plats', 'namnlös plats får sortens namn');
  });

  test('sortens symbol och färg används när inget eget valts', () => {
    const p = normPlace({ id: 'a', kind: 'toalett', lat: 58, lng: 15 });
    assert.equal(p.icon, 'toilet');
    assert.equal(p.colorHex, placeColorHex('lila'));
  });

  test('platser utan position ritas inte', () => {
    const comp = { places: [
      { id: 'a', kind: 'toalett', lat: 58, lng: 15 },
      { id: 'b', kind: 'vatten' },                       // ingen position
      { id: 'c', kind: 'mat', lat: 'x', lng: 'y' }       // skräp
    ] };
    assert.deepEqual(compPlaces(comp).map(p => p.id), ['a']);
  });

  test('gammal comp.parking följer med som plats', () => {
    // Tävlingar som aldrig sparats om ska inte tappa sin parkering.
    const comp = { parking: { enabled: true, name: 'Grusplanen', lat: 58, lng: 15, note: 'Parkera högst upp' } };
    const [p] = compPlaces(comp);
    assert.equal(p.kind, 'parkering');
    assert.equal(p.name, 'Grusplanen');
    assert.equal(p.note, 'Parkera högst upp');
    assert.equal(p.icon, 'square-parking');
  });

  test('men ritas inte två gånger när den flyttats in i listan', () => {
    const comp = {
      parking: { enabled: true, name: 'Gammal', lat: 58, lng: 15 },
      places: [{ id: 'ny', kind: 'parkering', name: 'Ny', lat: 58.1, lng: 15.1 }]
    };
    const ps = compPlaces(comp);
    assert.equal(ps.filter(p => p.kind === 'parkering').length, 1);
    assert.equal(ps[0].name, 'Ny');
  });

  test('avstängd gammal parkering tas inte med', () => {
    assert.deepEqual(compPlaces({ parking: { enabled: false, lat: 58, lng: 15 } }), []);
  });

  test('lagringsformen bär inga härledda fält', () => {
    const s = placeToStorage({ id: 'a', kind: 'vatten', name: 'Kranen', lat: 58, lng: 15 });
    assert.deepEqual(Object.keys(s).sort(), ['color', 'icon', 'id', 'kind', 'lat', 'lng', 'name']);
    assert.equal(s.colorHex, undefined, 'colorHex är en vy-detalj, inte data');
  });
});

describe('Platser som ingår i banan', () => {
  // Tre kontroller på rad, plus en matplats efter kontroll 2.
  const comp = (places) => ({
    startTimes: { enabled: true, firstStart: '09:00', intervalMinutes: 10 },
    startFinish: { enabled: true, mode: 'same', start: { name: 'S/M', lat: 57.995, lng: 15.0 } },
    places
  });
  const MAT = {
    id: 'mat1', kind: 'mat', name: 'Matplatsen', lat: 58.0135, lng: 15.0,
    inCourse: true, courseAfter: 2, dwellMinutes: 40
  };

  test('platsen vävs in på rätt ställe i sekvensen', () => {
    const { nodes } = courseLegs(comp([MAT]), CONTROLS, null);
    assert.deepEqual(nodes.map(n => n.kind), ['start', 'control', 'control', 'place', 'control', 'finish']);
    assert.equal(nodes[3].title, 'Matplatsen');
    assert.equal(nodes[3].key, 'place:mat1');
  });

  test('en plats utanför banan påverkar inte sekvensen', () => {
    const utanfor = { ...MAT, inCourse: false };
    const { nodes } = courseLegs(comp([utanfor]), CONTROLS, null);
    assert.deepEqual(nodes.map(n => n.kind), ['start', 'control', 'control', 'control', 'finish']);
  });

  test('platsens stopptid räknas in i banan', () => {
    const utan = courseEta(comp([]), CONTROLS, null);
    const med = courseEta(comp([MAT]), CONTROLS, null);
    // Samma sträcka (matplatsen ligger på linjen), 40 min längre dag.
    assert.ok(Math.abs(med.finishMin - utan.finishMin - 40) < 2,
      `${utan.finishMin} → ${med.finishMin}`);
  });

  test('utan angiven stopptid är platsen bara en punkt att gå förbi', () => {
    const snabb = { ...MAT, dwellMinutes: 0 };
    const utan = courseEta(comp([]), CONTROLS, null);
    const med = courseEta(comp([snabb]), CONTROLS, null);
    assert.ok(Math.abs(med.finishMin - utan.finishMin) < 2, 'ingen gissad tid');
  });

  test('platsen kalibreras aldrig men kostar sin tid', () => {
    // Platser rapporterar inget — de får inte råka räknas som en kontroll
    // som saknar underlag och därmed tappa sin stopptid.
    const cal = courseEtaCalibrated(comp([MAT]), CONTROLS, null, [], PATROLS, NOW);
    const nod = cal.byKey['place:mat1'];
    assert.equal(nod.calibrated, false);
    assert.equal(nod.samples, 0);
    assert.ok(nod.depMin - nod.etaMin >= 39, `stopptiden saknas: ${nod.etaMin} → ${nod.depMin}`);
  });

  test('plats efter en kontroll som inte finns hamnar sist, inte i intet', () => {
    // Kontrollen kan ha raderats eller numrerats om efter att platsen sattes.
    const vilse = { ...MAT, courseAfter: 99 };
    const { nodes } = courseLegs(comp([vilse]), CONTROLS, null);
    assert.equal(nodes.filter(n => n.kind === 'place').length, 1, 'platsen får inte försvinna');
    assert.equal(nodes[nodes.length - 2].kind, 'place', 'den hamnar sist före mål');
  });

  test('flera platser efter samma kontroll behåller sin ordning', () => {
    const a = { ...MAT, id: 'a', name: 'Först' };
    const b = { ...MAT, id: 'b', name: 'Sedan' };
    const { nodes } = courseLegs(comp([a, b]), CONTROLS, null);
    const namn = nodes.filter(n => n.kind === 'place').map(n => n.title);
    assert.deepEqual(namn, ['Först', 'Sedan']);
  });

  test('coursePlaces sorterar efter passageordning', () => {
    const sen = { ...MAT, id: 'sen', name: 'Sent', courseAfter: 3 };
    const tidig = { ...MAT, id: 'tidig', name: 'Tidigt', courseAfter: 0 };
    assert.deepEqual(coursePlaces(comp([sen, MAT, tidig])).map(p => p.name),
      ['Tidigt', 'Matplatsen', 'Sent']);
  });
});

describe('Bankartans passning (utskrift)', () => {
  const pt = (lat, lng) => ({ lat, lng });
  const BANA = [pt(58.380, 15.600), pt(58.398, 15.640)];
  const W = 1900, H = 1328, MARGIN = 46;

  // Banans utsträckning i kartrutornas pixlar vid en given zoom.
  const span = (pts, z) => {
    const n = Math.pow(2, z) * 256;
    const xy = pts.map(p => {
      const r = p.lat * Math.PI / 180;
      return { x: (p.lng + 180) / 360 * n,
               y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n };
    });
    return { x: Math.max(...xy.map(q => q.x)) - Math.min(...xy.map(q => q.x)),
             y: Math.max(...xy.map(q => q.y)) - Math.min(...xy.map(q => q.y)) };
  };

  test('banan fyller ytan — inte bara "får plats"', () => {
    // Kärnan i det här: kartrutor finns bara i hela zoomsteg, och varje steg
    // är en fördubbling. Väljer man bara högsta nivå som får plats kan halva
    // bilden bli tom. Efter nedskalningen ska banan fylla minst en av
    // riktningarna nästan helt.
    const { zoom, scale } = fitView(BANA, W, H);
    const sp = span(BANA, zoom);
    const bredd = sp.x * scale, hojd = sp.y * scale;
    const fyllnad = Math.max(bredd / (W - MARGIN * 2), hojd / (H - MARGIN * 2));
    assert.ok(fyllnad > 0.98, `banan fyller bara ${(fyllnad * 100).toFixed(0)} % av ytan`);
  });

  test('banan ryms fortfarande, med marginal för nålarna', () => {
    // Skalan sätts av den TRÅNGASTE riktningen, så banan kan aldrig spilla
    // över kanten — oavsett om den skalas upp eller ner.
    for (const bana of [BANA, [pt(58.30, 15.40), pt(58.50, 15.90)], [pt(58.38, 15.60), pt(58.39, 15.601)]]) {
      const { zoom, scale } = fitView(bana, W, H);
      const sp = span(bana, zoom);
      assert.ok(sp.x * scale <= W - MARGIN * 2 + 0.5, 'bredden spiller över kanten');
      assert.ok(sp.y * scale <= H - MARGIN * 2 + 0.5, 'höjden spiller över kanten');
    }
  });

  test('skalan håller sig nära 1 — skärpa mot antal kartrutor', () => {
    // Antalet rutor växer med kvadraten på 1/skalan. Skalan ska därför ligga
    // inom ett halvt zoomsteg från 1 åt båda håll: högst ~45 % uppskalning
    // (knappt synligt i tryck) mot högst dubbla antalet hämtningar.
    for (const bana of [BANA,
      [pt(58.30, 15.40), pt(58.50, 15.90)],
      [pt(58.38, 15.60), pt(58.381, 15.601)],
      [pt(57.0, 14.0), pt(59.5, 18.5)]]) {
      const { scale } = fitView(bana, W, H);
      assert.ok(scale >= 0.7 && scale <= 1.45, `skalan ${scale.toFixed(3)} ligger för långt från 1`);
    }
  });

  test('en mycket kort bana blåses inte upp till oläslighet', () => {
    // Cirka 100 m mellan ytterpunkterna: det finns ingen mer detaljerad
    // kartdata, så banan ska hellre ligga liten och skarp än stor och suddig.
    const { zoom, scale } = fitView([pt(58.3800, 15.6000), pt(58.3809, 15.6009)], W, H);
    assert.equal(zoom, 18, 'högsta tillgängliga detaljnivå ska användas');
    assert.ok(scale <= 1.45, `blåste upp ${scale.toFixed(2)} gånger`);
  });

  test('en större bana ger lägre zoom', () => {
    const vid = [pt(58.30, 15.40), pt(58.50, 15.90)];
    assert.ok(fitView(vid, W, H).zoom < fitView(BANA, W, H).zoom);
  });

  test('samma bana ger högre zoom i en större bild', () => {
    assert.ok(fitView(BANA, W, H).zoom > fitView(BANA, 600, 400).zoom);
  });

  test('en enda punkt ger en rimlig närzoom', () => {
    assert.deepEqual(fitView([pt(58.4, 15.6)], W, H), { zoom: 16, scale: 1 });
  });

  test('en bana över halva landet låser sig inte', () => {
    const { zoom, scale } = fitView([pt(55.5, 12.9), pt(67.8, 20.3)], W, H);
    assert.ok(zoom >= 3 && zoom <= 18, `zoom utanför skalan: ${zoom}`);
    assert.ok(scale > 0 && scale <= 1.45);
  });
});

describe('Skalstocken på den utskrivna kartan', () => {
  test('stapeln motsvarar sin siffra', () => {
    // Det tysta felet: en stapel vars längd inte hänger ihop med etiketten.
    // Scouter mäter i den, så pixelbredden MÅSTE räknas ur den valda sträckan.
    for (const mpp of [0.2, 0.6, 1.4, 3.7, 12, 55, 400]) {
      const { meters, barPx } = niceScale(mpp, 300);
      assert.ok(Math.abs(barPx * mpp - meters) < 1e-6,
        `${meters} m ritas som ${(barPx * mpp).toFixed(1)} m`);
    }
  });

  test('sträckan är alltid ett jämnt tal man kan räkna med', () => {
    for (const mpp of [0.2, 0.6, 1.4, 3.7, 12, 55, 400]) {
      const { meters } = niceScale(mpp, 300);
      const pot = Math.pow(10, Math.floor(Math.log10(meters)));
      assert.ok([1, 2, 5].includes(Math.round(meters / pot)),
        `${meters} m är inte 1/2/5 × tiopotens`);
    }
  });

  test('stapeln ryms i utrymmet den fått', () => {
    for (const mpp of [0.2, 0.6, 1.4, 3.7, 12, 55, 400]) {
      assert.ok(niceScale(mpp, 300).barPx <= 300, 'stapeln spiller över');
    }
  });

  test('långa sträckor visas i kilometer', () => {
    assert.equal(niceScale(20, 300).etikett, '5 km');
    assert.equal(niceScale(1.5, 300).etikett, '200 m');
  });
});

describe('Patrullens etikett', () => {
  test('namn och kår sätts ihop på överenskommen form', () => {
    assert.equal(patrolLabel({ name: 'Rävarna', kar: 'Lindsdals Scoutkår' }),
      'Rävarna (Lindsdals Scoutkår)');
  });

  test('utan kår står bara namnet — ingen tom parentes', () => {
    for (const p of [{ name: 'Rävarna' }, { name: 'Rävarna', kar: '' }, { name: 'Rävarna', kar: '   ' }])
      assert.equal(patrolLabel(p), 'Rävarna');
  });

  test('utan namn faller den tillbaka på kåren i stället för tomt', () => {
    assert.equal(patrolLabel({ kar: 'Lindsdals Scoutkår' }), 'Lindsdals Scoutkår');
    assert.equal(patrolLabel({}), '');
    assert.equal(patrolLabel(null), '');
  });

  test('blanksteg runt om städas bort', () => {
    assert.equal(patrolLabel({ name: '  Rävarna ', kar: ' Lindsdals Scoutkår  ' }),
      'Rävarna (Lindsdals Scoutkår)');
  });
});

describe('Delningsbildens färgval', () => {
  test('texten på avdelningens färg är läsbar för varje avdelning', () => {
    // 3:1 är WCAG-kravet för stor text, och all text på kortet är stor.
    // Äventyrarorange når inte 4,5 mot vare sig vit eller svart — därför är
    // regeln "bäst av de två", inte "passerar 4,5".
    for (const [avd, hex] of Object.entries(AVD_FÄRG)) {
      const bläck = textPå(hex);
      const k = kontrastMellan(hex, bläck);
      assert.ok(k >= 3, `${avd} (${hex}) fick ${bläck} med kontrast ${k.toFixed(2)}`);
      const andra = bläck === '#ffffff' ? '#282727' : '#ffffff';
      assert.ok(k >= kontrastMellan(hex, andra), `${avd}: ${andra} hade varit läsbarare`);
    }
  });

  test('rovergult får svart text, inte vit', () => {
    // Den här är hela poängen med regeln: vit text på #E2E000 går inte att
    // läsa, och rovergult är en av Scouternas åldersfärger.
    assert.equal(textPå(AVD_FÄRG['Rover']), '#282727');
  });

  test('accenten syns mot den mörkblå bottnen — även ledarsvart', () => {
    for (const avd of Object.keys(AVD_FÄRG)) {
      const a = accentMotBlått(avd);
      assert.ok(kontrastMellan(a, '#003660') >= 3, `${avd} gav accenten ${a}`);
    }
    // Ledarsvart mot mörkblått är osynligt och MÅSTE bytas ut.
    assert.notEqual(accentMotBlått('Ledare'), AVD_FÄRG['Ledare']);
  });

  test('okänd avdelning ger en accent i stället för att försvinna', () => {
    assert.ok(kontrastMellan(accentMotBlått('Nyfikna'), '#003660') >= 3);
    assert.ok(kontrastMellan(accentMotBlått(undefined), '#003660') >= 3);
  });
});

describe('Extremfallet: noll poäng och sist', () => {
  // Fältet: en patrull med 0 på allt, elva andra med poäng.
  const controls = Array.from({ length: 10 }, (_, i) => ({ id: 'c' + i, nummer: i + 1, maxPoang: 12 }));
  const scoresByControl = {};
  for (const c of controls) {
    scoresByControl[c.id] = [
      { patrolId: 'sist', poang: 0, extraPoang: 0 },
      ...Array.from({ length: 11 }, (_, j) => ({ patrolId: 'p' + j, poang: 4 + (j % 6), extraPoang: 0 }))
    ];
  }

  test('höjdpunkterna nämner varken placering eller poäng', () => {
    const rader = patrolHighlights({ patrolId: 'sist', controls, scoresByControl, showRank: true })
      .map(h => h.text);
    assert.deepEqual(rader, ['Alla 10 kontroller klara!']);
  });

  test('sistaplatsen passerar inte grinden', () => {
    const tr = totalRank('sist', controls, scoresByControl);
    assert.equal(tr.rank, 12);
    assert.equal(rankWorthShowing(tr), false, 'en sistaplats får aldrig visas');
  });

  test('grinden släpper igenom topp 3 och övre halvan', () => {
    assert.equal(rankWorthShowing({ rank: 1, of: 40 }), true);
    assert.equal(rankWorthShowing({ rank: 3, of: 4 }), true, 'topp 3 gäller även i ett litet fält');
    assert.equal(rankWorthShowing({ rank: 6, of: 12 }), true, 'övre halvan');
    assert.equal(rankWorthShowing({ rank: 7, of: 12 }), false);
    assert.equal(rankWorthShowing(null), false);
  });

  test('delningsbildens stora tal blir aldrig en nolla eller en sistaplats', () => {
    // Så som start.js bygger det: rank grindas bort innan den når kortet.
    const data = { points: 0, rank: null, legs: controls.map(c => ({ nummer: c.nummer, poang: 0, max: 12 })) };
    const val = { placering: true, poang: true };
    assert.deepEqual(hjälte(data, val), { v: '10', l: 'kontroller' });
  });

  test('med poäng är poängen hjälten, med placering är placeringen det', () => {
    const legs = [{ nummer: 1, poang: 5, max: 10 }];
    assert.deepEqual(hjälte({ points: 5, rank: null, legs }, { placering: true, poang: true }),
      { v: '5', l: 'poäng' });
    assert.deepEqual(hjälte({ points: 5, rank: { rank: 2, of: 9 }, legs }, { placering: true, poang: true }),
      { v: '2:a', l: 'av 9' });
  });

  test('utan något alls finns ingen hjälte att rita', () => {
    assert.equal(hjälte({ points: 0, rank: null, legs: [] }, { placering: true, poang: true }), null);
  });
});

import { enqueue, listQueue, removeFromQueue, flushQueue, isPermanentError } from '../public/js/offline-queue.js';

// Node har ingen fungerande localStorage i testmiljön (setItem kastar).
// offline-queue sväljer felet tyst, så utan en shim blir kön alltid tom och
// testet mäter ingenting. Ge oss en i minnet.
{
  let ok = false;
  try { localStorage.setItem('__probe', '1'); ok = localStorage.getItem('__probe') === '1'; localStorage.removeItem('__probe'); } catch {}
  if (!ok) {
    const store = new Map();
    globalThis.localStorage = {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    };
  }
}

describe('Offline-kön: förlegad flush får inte skriva över en rättelse', () => {
  const CID = 'testcomp', CTRL = 'testctrl';
  const rensa = () => {
    for (const p of ['A', 'P']) removeFromQueue(CID, CTRL, p);
    // säkra tomt
    listQueue(CID, CTRL).forEach(x => removeFromQueue(CID, CTRL, x.patrolId, x.queuedAt));
  };

  test('en post som ersatts under en pågående flush skickas inte', async () => {
    rensa();
    enqueue(CID, CTRL, { patrolId: 'A', poang: 1 });
    enqueue(CID, CTRL, { patrolId: 'P', poang: 5 });   // gammal poäng
    const gammalP = listQueue(CID, CTRL).find(x => x.patrolId === 'P').queuedAt;

    const skickade = [];
    // syncOne: när A synkas (första posten, "långsam"), simulera att en
    // direktsparning rättar P till 8 och tar bort den gamla kö-posten —
    // exakt kapplöpningen: färsk skrivning, sedan förlegad snapshot.
    const syncOne = async (item) => {
      skickade.push({ patrolId: item.patrolId, poang: item.poang });
      if (item.patrolId === 'A') {
        // Direktsparningen sker sekunder efter den ursprungliga köningen i
        // verkligheten; en liten fördröjning här ger ett distinkt queuedAt
        // (Date.now har ms-upplösning) precis som på riktigt.
        await new Promise(r => setTimeout(r, 3));
        removeFromQueue(CID, CTRL, 'P');                 // direktsparningens städning
        enqueue(CID, CTRL, { patrolId: 'P', poang: 8 }); // nyare rapport i kön
      }
    };

    const { synced } = await flushQueue(CID, CTRL, syncOne, { timeoutMs: 1000 });

    // Den förlegade P(5) skickades ALDRIG.
    assert.ok(!skickade.some(s => s.patrolId === 'P' && s.poang === 5),
      'förlegad P(5) skickades — skulle skrivit över rättelsen');
    assert.ok(skickade.some(s => s.patrolId === 'A'), 'A skulle synkats');
    // Den nyare P(8) ligger kvar i kön för nästa flush.
    const kvar = listQueue(CID, CTRL).filter(x => x.patrolId === 'P');
    assert.equal(kvar.length, 1, 'nyare P ska ligga kvar i kön');
    assert.equal(kvar[0].poang, 8, 'det är den nyare poängen som ligger kvar');
    assert.notEqual(kvar[0].queuedAt, gammalP, 'och det är inte den gamla posten');
    rensa();
  });

  test('permanenta fel plockas ur kön, transienta stoppar flushen', async () => {
    rensa();
    enqueue(CID, CTRL, { patrolId: 'A', poang: 1 });
    const { synced, failed } = await flushQueue(CID, CTRL,
      async () => { const e = new Error('stängd'); e.code = 'permission-denied'; throw e; },
      { timeoutMs: 1000 });
    assert.equal(failed.length, 1, 'permanent fel rapporteras som failed');
    assert.equal(listQueue(CID, CTRL).length, 0, 'och plockas ur kön');
    assert.ok(isPermanentError({ code: 'permission-denied' }));
    assert.ok(!isPermanentError({ code: 'unavailable' }));
    rensa();
  });
});
