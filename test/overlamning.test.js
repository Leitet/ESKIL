// Överlämningskoden och årgångskopian.
//
// TVÅ vägar skapar en kopia av en tävling — webbläsarens "Kopiera till ny
// tävling" (ESM, public/js/argangskopia.js) och serverns inlösning av en
// överlämningskod (CJS, functions/overlamning.js). De ska ge SAMMA tävling, så
// parity-testerna kör båda mot samma indata och kräver identiskt utfall.
// Därefter: vad en NY arrangör uttryckligen INTE får med sig, att guiden i
// rapporten bara påstår det koden gör, och att en kod går att lösa in exakt
// en gång.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as esmKopia from '../public/js/argangskopia.js';
import * as esmKod from '../public/js/overlamningskod.js';
import * as esmUtv from '../public/js/utvardering.js';

const require = createRequire(import.meta.url);
const cjs = require('../functions/overlamning.js');

const KALLA = {
  id: 'kalla1', name: 'Älghornsjakten 2026', shortName: 'Älghornsjakten', year: 2026, date: '2026-10-04',
  location: 'Tinnerö', organizer: 'Lindsdals Scoutkår', description: 'Beskrivning', generalInfo: 'Ring 112',
  district: 'smaland', slug: 'ah26', closed: true, closedAt: '2026-10-12T10:00:00Z', demo: false,
  adminEmails: ['gammal@lindsdal.se'], userEmails: ['funk@lindsdal.se'], lastBackupAt: '2026-10-11',
  avdelningar: ['Spårare', 'Upptäckare'],
  startTimes: { enabled: true, mode: 'interval', firstStart: '09:00', intervalMinutes: 5, published: true, luckor: [3] },
  startFinish: { mode: 'same', start: { lat: 56.7, lng: 16.2 } },
  places: [{ id: 'p1', kind: 'parkering', name: 'Grusplanen', lat: 56.7, lng: 16.2 }],
  management: [
    { id: 'tl', label: 'Tävlingsledare', visibility: 'public', ekonomi: false, name: 'Anna Andersson', phone: '', email: 'anna@lindsdal.se' },
    { id: 'sek', label: 'Sekretariat', visibility: 'internal', ekonomi: true, name: 'Johan', phone: '', email: 'johan@lindsdal.se' }
  ],
  publicScores: true, anonymousControls: false, courseHidden: true, selfStart: false,
  registration: { enabled: true, mode: 'kar', opensAt: '2026-08-01', closesAt: '2026-09-20',
    pricing: { model: 'patrull', perPatrol: 400 }, fields: [{ id: 'f1', label: 'Allergier', scope: 'patrull' }],
    methods: [{ type: 'swish', label: 'Swish', number: '123 456 78 90' }] }
};
const KONTROLLER = [
  { id: 'k1', nummer: 1, name: 'Spårkoll', maxPoang: 10, minPoang: 0, extraPoang: 2, placement: 'Vid stenen', lat: 56.71, lng: 16.21,
    instructions: [{ avdelningar: ['Spårare'], text: 'Följ banden' }], open: true, ansvariga: [{ email: 'x@y.se' }], ansvarigaEmails: ['x@y.se'], telefon: '070' },
  { id: 'k2', nummer: 2, name: 'Tidsbana', maxPoang: 10, minPoang: 5, tidtagning: true, utslag: true, utslagFraga: 'Hur många?', utslagSvar: 42, information: 'Gammal form' },
  { id: 'k3' }
];
const SPAR = { '__start__k1': [{ lat: 1, lng: 2 }], 'k1__k2': [{ lat: 3, lng: 4 }], 'k2__place:p1': [], 'place:p1____mal': [] };
const UTV = [
  null, { text: 'Bara anteckningar' },
  { text: 'Markägare', bra: 'Dubbel bemanning', forbattringar: 'Börja i juni', nyArrangor: true, nyArrangorText: 'Ring Anna',
    bilder: [{ id: 'bildbra01', sektion: 'bra', bildtext: 'Kö' }, { id: 'bildtext1', sektion: 'text', bildtext: '' }],
    foregaende: { namn: 'AH25', ar: 2025, forbattringar: 'Gammalt', bilder: [{ id: 'bildgml01', sektion: 'bra' }] } },
  { nyArrangor: true, foregaende: { ar: 2025, bra: 'x' } },
  { bra: 42, bilder: 'skräp', foregaende: 'nej' }
];

describe('spegeln: webbläsarens och serverns kopia måste vara IDENTISKA', () => {
  test('tävlingsdokumentet', () => {
    for (const src of [KALLA, { id: 'tom' }, { ...KALLA, startTimes: undefined, registration: undefined, avdelningar: [] }]) {
      const opts = { name: 'Ny', shortName: 'N', year: '2027', date: null };
      assert.deepEqual(cjs.kopiaTavlingsdata(src, opts), esmKopia.kopiaTavlingsdata(src, opts));
    }
    assert.deepEqual(cjs.KOPIERADE_FALT, esmKopia.KOPIERADE_FALT);
  });
  test('kontrollerna, spåret, namnet och den nya arrangörens avdrag', () => {
    for (const c of KONTROLLER) assert.deepEqual(cjs.kopiaKontroll(c), esmKopia.kopiaKontroll(c));
    const idMap = { k1: 'NY1', k2: 'NY2' };
    assert.deepEqual(cjs.remappaSpar(SPAR, idMap), esmKopia.remappaSpar(SPAR, idMap));
    assert.deepEqual(cjs.remappaSpar(null, idMap), esmKopia.remappaSpar(null, idMap));
    for (const [t, a, n] of [['Älghornsjakten 2026', 2026, 2027], ['Utan år', 2026, 2027], ['', null, 2027], [' Mellanslag ', 2026, 2027]]) {
      assert.equal(cjs.nastaArsNamn(t, a, n), esmKopia.nastaArsNamn(t, a, n));
    }
    const data = esmKopia.kopiaTavlingsdata(KALLA, { name: 'Ny', shortName: 'N', year: 2027, date: null });
    assert.deepEqual(cjs.forNyArrangor(data), esmKopia.forNyArrangor(data));
    assert.deepEqual(cjs.forNyArrangor({}), esmKopia.forNyArrangor({}));
  });
  test('utvärderingen som följer med', () => {
    for (const ho of UTV) {
      assert.deepEqual(cjs.normUtvardering(ho), esmUtv.normUtvardering(ho));
      assert.deepEqual(cjs.utvarderingForNastaAr(ho, KALLA), esmUtv.utvarderingForNastaAr(ho, KALLA));
      assert.deepEqual(cjs.utvarderingBildIds(ho), esmUtv.utvarderingBildIds(ho));
      assert.equal(cjs.utvarderingTom(ho), esmUtv.utvarderingTom(ho));
      assert.equal(cjs.harInnehall(cjs.utvarderingForNastaAr(ho, KALLA)), esmUtv.harInnehall(esmUtv.utvarderingForNastaAr(ho, KALLA)));
    }
  });
  test('koden: normalisering, giltighet och hash', async () => {
    assert.equal(cjs.KOD_ALFABET, esmKod.KOD_ALFABET);
    for (const s of ['abcd-efgh-2345', ' ABCD EFGH 2345 ', 'ABCDEFGH2345', 'ABCD-EFGH-IO01', 'kort', '', null, 'ABCD-EFGH-23456']) {
      assert.equal(cjs.normKod(s), esmKod.normKod(s), `normKod(${s})`);
      assert.equal(cjs.arGiltigKod(s), esmKod.arGiltigKod(s), `arGiltigKod(${s})`);
      assert.equal(cjs.kodHash(s), await esmKod.kodHash(s), `kodHash(${s})`);
    }
  });
});

describe('koden: XXXX-XXXX-XXXX ur ett alfabet utan förväxlingsbara tecken', () => {
  test('32 tecken: A–Z utan I och O, 2–9 — aldrig 0 eller 1', () => {
    assert.equal(esmKod.KOD_ALFABET.length, 32);
    assert.equal(new Set(esmKod.KOD_ALFABET).size, 32);
    for (const forbjudet of 'IO01') assert.ok(!esmKod.KOD_ALFABET.includes(forbjudet), `${forbjudet} får inte finnas`);
    assert.match(esmKod.KOD_ALFABET, /^[A-HJ-NP-Z2-9]+$/);
  });
  test('formen, och att varje byte ger ett tecken ur alfabetet utan skevhet', () => {
    for (let i = 0; i < 200; i++) assert.match(esmKod.nyOverlamningskod(), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    // Alla 256 bytevärden: varje tecken ska träffas exakt 8 gånger (256/32).
    const antal = {};
    for (let b = 0; b < 256; b++) { const k = esmKod.nyOverlamningskod(new Uint8Array(12).fill(b)); antal[k[0]] = (antal[k[0]] || 0) + 1; }
    assert.equal(Object.keys(antal).length, 32);
    assert.ok(Object.values(antal).every(n => n === 8), 'modulo-skevhet: något tecken är vanligare än ett annat');
    assert.equal(esmKod.nyOverlamningskod(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])), 'ABCD-EFGH-JKLM');
  });
  test('det folk skriver tolkas rätt; det som inte är en kod avvisas', () => {
    assert.equal(esmKod.formateraKod('abcdefgh2345'), 'ABCD-EFGH-2345');
    assert.equal(esmKod.formateraKod('ab cd-ef'), 'ABCD-EF');
    assert.equal(esmKod.arGiltigKod('abcd efgh 2345'), true);
    for (const fel of ['ABCD-EFGH-234', 'ABCD-EFGH-23456', 'ABCD-EFGH-IIII', 'ABCD-EFGH-0000', '']) assert.equal(esmKod.arGiltigKod(fel), false, fel);
  });
});

describe('en NY arrangör får upplägget — aldrig den gamla arrangörens uppgifter', () => {
  const plan = cjs.planeraOvertag(KALLA, { email: 'ny@oskarshamn.se', uid: 'uidNY', nu: new Date('2026-11-01') });

  test('inlösaren blir ENSAM administratör, och behörigheterna ligger aldrig på det publika dokumentet', () => {
    assert.deepEqual(plan.access.adminEmails, ['ny@oskarshamn.se']);
    assert.deepEqual(plan.access.admins, ['uidNY']);
    assert.deepEqual([plan.access.userEmails, plan.access.users, plan.access.ekonomiEmails], [[], [], []]);
    assert.equal(plan.comp.adminEmails, undefined);
    assert.equal(plan.comp.userEmails, undefined);
    assert.ok(!JSON.stringify(plan).includes('gammal@lindsdal.se'), 'förra arrangörens admin följde med');
    assert.ok(!JSON.stringify(plan).includes('funk@lindsdal.se'));
  });
  test('betalningsuppgifter, namn och arrangör följer INTE med — rollerna och upplägget gör det', () => {
    assert.deepEqual(plan.comp.registration.methods, [], 'Swish-numret skulle skicka nästa års avgifter till FEL kår');
    assert.equal(plan.comp.registration.enabled, false);
    assert.deepEqual(plan.comp.registration.pricing, KALLA.registration.pricing);
    assert.deepEqual(plan.comp.registration.fields, KALLA.registration.fields);
    assert.equal(plan.comp.organizer, '');
    assert.deepEqual(plan.comp.management.map(r => [r.id, r.label, r.visibility, r.ekonomi]), [['tl', 'Tävlingsledare', 'public', false], ['sek', 'Sekretariat', 'internal', true]]);
    const text = JSON.stringify(plan);
    for (const pii of ['Anna Andersson', 'anna@lindsdal.se', 'johan@lindsdal.se', '123 456 78 90', 'Lindsdals Scoutkår']) assert.ok(!text.includes(pii), `${pii} följde med till den nya arrangören`);
  });
  test('nytt år, ingen kortadress, inte avslutad, opublicerade starttider utan luckor, länkad till källan', () => {
    assert.deepEqual([plan.comp.name, plan.comp.shortName, plan.comp.year, plan.comp.date], ['Älghornsjakten 2027', 'Älghornsjakten', 2027, null]);
    assert.equal(plan.comp.slug, undefined);
    assert.equal(plan.comp.closed, false);
    assert.equal(plan.comp.closedAt, undefined);
    assert.equal(plan.comp.lastBackupAt, undefined, 'raderingsskyddet skulle tro att en backup finns');
    assert.deepEqual([plan.comp.startTimes.published, plan.comp.startTimes.luckor], [false, []]);
    assert.equal(plan.comp.copiedFrom, 'kalla1');
    assert.equal(plan.comp.courseHidden, true);
    assert.deepEqual(plan.comp.places, KALLA.places);
  });
  test('kontrollerna: stängda, utan ansvariga och facit — men tidtagningen följer med', () => {
    const [a, b] = KONTROLLER.map(cjs.kopiaKontroll);
    assert.deepEqual([a.open, a.ansvariga, a.ansvarigaEmails, a.telefon], [false, [], [], undefined]);
    assert.deepEqual([b.tidtagning, b.utslag, b.utslagFraga, b.utslagSvar, b.information], [true, true, 'Hur många?', null, 'Gammal form']);
    assert.equal(a.tidtagning, undefined);
  });
});

// ── Inlösningen mot en databasattrapp ──────────────────────────────────────
// Minsta möjliga Firestore: dokument i en Map, transaktioner som körs rakt av.
function attrapp(start = {}) {
  const docs = new Map(Object.entries(start));
  let nasta = 0;
  const RADERA = Symbol('radera'), NU = Symbol('nu');
  const lagra = (path, data, merge) => {
    const bas = merge ? { ...(docs.get(path) || {}) } : {};
    for (const [k, v] of Object.entries(data)) { if (v === RADERA) delete bas[k]; else bas[k] = v === NU ? 'NU' : v; }
    docs.set(path, bas);
  };
  const ref = (path) => ({
    path, id: path.split('/').pop(),
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path), id: path.split('/').pop() }),
    set: async (data, opts) => lagra(path, data, opts?.merge),
    update: async (data) => { if (!docs.has(path)) throw new Error('NOT_FOUND ' + path); lagra(path, data, true); },
    collection: (namn) => col(`${path}/${namn}`)
  });
  const col = (path) => ({
    doc: (id) => ref(`${path}/${id || 'auto' + (++nasta)}`),
    get: async () => {
      const djup = path.split('/').length + 1;
      const d = [...docs.keys()].filter(k => k.startsWith(path + '/') && k.split('/').length === djup)
        .map(k => ({ id: k.split('/').pop(), data: () => docs.get(k) }));
      return { docs: d, size: d.length };
    }
  });
  const db = {
    doc: ref, collection: col,
    batch: () => { const ops = []; return { set: (r, d) => ops.push(() => r.set(d)), commit: async () => { for (const o of ops) await o(); } }; },
    runTransaction: async (fn) => fn({ get: (r) => r.get(), update: (r, d) => r.update(d), set: (r, d) => r.set(d) })
  };
  return { db, docs, FieldValue: { serverTimestamp: () => NU, delete: () => RADERA } };
}

describe('inlösningen: en kod, en tävling', () => {
  const KOD = 'ABCD-EFGH-2345';
  const grund = () => ({
    [`overlamningskoder/${cjs.kodHash(KOD)}`]: { cid: 'kalla1', skapad: '2026-10-13', skapadAv: 'anna@lindsdal.se' },
    'competitions/kalla1': { ...KALLA, id: undefined },
    'competitions/kalla1/private/handover': UTV[2],
    'competitions/kalla1/private/utv-bild-bildbra01': { dataUrl: 'data:bra', sektion: 'bra' },
    'competitions/kalla1/private/utv-bild-bildtext1': { dataUrl: 'data:text', sektion: 'text' },
    'competitions/kalla1/private/overlamning': { kod: 'ABCDEFGH2345', skapad: '2026-10-13' },
    'competitions/kalla1/controls/k1': KONTROLLER[0],
    'competitions/kalla1/controls/k2': KONTROLLER[1],
    'competitions/kalla1/track/main': { speedKmh: 5, legs: SPAR }
  });

  test('skapar tävlingen, kopierar utvärdering, bilder, kontroller och spår — och märker koden använd', async () => {
    const a = attrapp(grund());
    const ut = await cjs.losInKod(a.db, a.FieldValue, { kod: 'abcd efgh 2345', email: 'ny@oskarshamn.se', uid: 'uidNY' });
    assert.equal(ut.name, 'Älghornsjakten 2027');
    assert.equal(ut.kontroller, 2);
    const ny = `competitions/${ut.cid}`;
    assert.deepEqual(a.docs.get(`${ny}/private/access`).adminEmails, ['ny@oskarshamn.se']);
    assert.equal(a.docs.get(ny).overtagenMedKod, true);
    assert.equal(a.docs.get(`${ny}/private/handover`).foregaende.forbattringar, 'Börja i juni');
    assert.equal(a.docs.get(`${ny}/private/handover`).foregaende.nyArrangor, true);
    assert.equal(a.docs.get(`${ny}/private/utv-bild-bildbra01`).dataUrl, 'data:bra');
    assert.equal(a.docs.get(`${ny}/private/utv-bild-bildtext1`).dataUrl, 'data:text');
    const nyaKontroller = [...a.docs.keys()].filter(k => k.startsWith(`${ny}/controls/`));
    assert.equal(nyaKontroller.length, 2);
    assert.ok(nyaKontroller.every(k => a.docs.get(k).open === false));
    const spar = a.docs.get(`${ny}/track/main`);
    assert.equal(spar.speedKmh, 5);
    assert.ok(!Object.keys(spar.legs).some(k => /\bk1\b|\bk2\b/.test(k)), 'spåret pekar kvar på källans kontroll-id:n');
    assert.equal(Object.keys(spar.legs).length, 4);
    assert.equal(a.docs.get(`overlamningskoder/${cjs.kodHash(KOD)}`).anvand.nyCid, ut.cid);
    assert.deepEqual([a.docs.get('competitions/kalla1/private/overlamning').anvand.av, a.docs.get('competitions/kalla1/private/overlamning').anvand.nyCid], ['ny@oskarshamn.se', ut.cid]);
    // Källan är orörd
    assert.deepEqual(a.docs.get('competitions/kalla1/controls/k1'), KONTROLLER[0]);
    assert.equal(a.docs.get('competitions/kalla1').closed, true);
  });

  test('en kod går att lösa in EN gång', async () => {
    const a = attrapp(grund());
    await cjs.losInKod(a.db, a.FieldValue, { kod: KOD, email: 'ny@oskarshamn.se', uid: 'u1' });
    await assert.rejects(() => cjs.losInKod(a.db, a.FieldValue, { kod: KOD, email: 'tjuv@example.com', uid: 'u2' }), cjs.KodFel);
    assert.equal([...a.docs.keys()].filter(k => /^competitions\/auto\d+$/.test(k)).length, 1, 'den andra inlösningen skapade en tävling');
  });

  test('fel kod, okänd kod och en kod vars tävling är borta ger KodFel — aldrig en tävling', async () => {
    const a = attrapp(grund());
    await assert.rejects(() => cjs.losInKod(a.db, a.FieldValue, { kod: 'kort', email: 'x@y.se', uid: 'u' }), cjs.KodFel);
    await assert.rejects(() => cjs.losInKod(a.db, a.FieldValue, { kod: 'ZZZZ-ZZZZ-ZZZZ', email: 'x@y.se', uid: 'u' }), cjs.KodFel);
    a.docs.delete('competitions/kalla1');
    await assert.rejects(() => cjs.losInKod(a.db, a.FieldValue, { kod: KOD, email: 'x@y.se', uid: 'u' }), cjs.KodFel);
    assert.equal([...a.docs.keys()].filter(k => /^competitions\/auto/.test(k)).length, 0);
  });

  test('havererar kopian släpps koden igen — ett fel får inte bränna en kod som står tryckt i en rapport', async () => {
    const a = attrapp(grund());
    const riktig = a.db.collection;
    a.db.collection = (p) => { if (p === 'competitions/kalla1/controls') return { get: async () => { throw new Error('nätet dog'); } }; return riktig(p); };
    await assert.rejects(() => cjs.losInKod(a.db, a.FieldValue, { kod: KOD, email: 'ny@oskarshamn.se', uid: 'u1' }), /nätet dog/);
    assert.equal(a.docs.get(`overlamningskoder/${cjs.kodHash(KOD)}`).anvand, undefined, 'koden står kvar som använd');
    a.db.collection = riktig;
    const ut = await cjs.losInKod(a.db, a.FieldValue, { kod: KOD, email: 'ny@oskarshamn.se', uid: 'u1' });
    assert.ok(ut.cid);
  });
});

describe('guiden i rapporten påstår bara det koden gör', () => {
  const o = esmUtv.OVERLAMNING_ARRANGOR;
  const las = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

  test('betalningsuppgifterna står FÖRST bland det nya arrangören gör', () => {
    assert.match(o.attGoraForst[0], /betalningsuppgifterna/i);
    assert.ok(o.foljerInteMed.some(r => /Swish/.test(r)));
    assert.ok(o.foljerInteMed.some(r => /namn, telefonnummer och e-postadresser/.test(r)));
    assert.ok(o.foljerMed.some(r => /roller — utan namn/.test(r)));
  });
  test('adressen i guiden är rutten som finns, med rewrite, och den anropar rätt funktion', () => {
    assert.equal(esmUtv.OVERLAMNING_ADRESS, 'eskilscout.se/overlamning');
    assert.match(las('../public/js/app.js'), /route\('\/overlamning',/);
    assert.match(las('../public/js/app.js'), /route\('\/overlamning\/:kod',/);
    const rw = JSON.parse(las('../firebase.json')).hosting.rewrites.map(r => r.source);
    assert.ok(rw.includes('/overlamning') && rw.includes('/overlamning/**'));
    assert.match(las('../public/js/views/overlamning.js'), /httpsCallable\(functions, 'losInOverlamningskod'\)/);
    assert.match(las('../functions/index.js'), /exports\.losInOverlamningskod = onCall\(/);
    assert.match(las('../public/js/rapport-pdf.js'), /https:\/\/\$\{OVERLAMNING_ADRESS\}\/\$\{kod\}/, 'QR-koden ska peka på inlösningssidan med koden ifylld');
  });
  test('servern tar ALDRIG en adress ur anropet — bara den verifierade ur inloggningen', () => {
    const src = las('../functions/index.js');
    const fn = src.slice(src.indexOf('exports.losInOverlamningskod'), src.indexOf('exports.resendManageLink'));
    assert.match(fn, /req\.auth\?\.token\?\.email/);
    assert.ok(!/req\.data\??\.email/.test(fn), 'ett stavfel i ett formulär hade skapat en tävling åt ingen och bränt koden');
    assert.match(fn, /'unauthenticated'/);
  });
  test('webbläsarens kopia går genom samma rena regler som servern', () => {
    const store = las('../public/js/store.js');
    const kopia = store.slice(store.indexOf('export async function copyCompetition'), store.indexOf('// --- Controls'));
    assert.match(kopia, /kopiaTavlingsdata\(\{ \.\.\.src, id: cid \}/);
    assert.match(kopia, /kopiaKontroll\(c\)/);
    assert.match(kopia, /remappaSpar\(track\.legs, idMap\)/);
  });
  test('koden följer aldrig med i backup eller årgångskopia', () => {
    assert.ok(!/overlamning/i.test(las('../public/js/backup.js').replace(/\/\/.*$/gm, '')), 'en kod i en backupfil som mailas runt är en fungerande nyckel');
    assert.ok(!/kod|overlamning/i.test(JSON.stringify(cjs.utvarderingForNastaAr({ bra: 'x', nyArrangor: true }, KALLA)).replace(/nyArrangor/g, '')));
  });
});
