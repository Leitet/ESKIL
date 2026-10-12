// Bokföringsunderlag och läsning mot en avslutad tävling.
//
// Kassören ska kunna läsa anmälningar, avgifter, betalningar och ta ut
// underlaget efter avslutet. Verktyg som ändrar data nekas med samma 403
// som förut gällde hela anropet. Belopp hittas inte på: en obetald post
// har inget inbetalt belopp.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import {
  byggUnderlag, tillCsv, tillHtml, avgifterAv
} from '../public/js/bokforing.js';

const require = createRequire(import.meta.url);
const cjs = require('../functions/mcp/bokforing.js');
const verktyg = require('../functions/mcp/verktyg.js');
const { hanteraMcp } = require('../functions/mcp/transport.js');

const GIFT = 'ALLERGI-JORDNOT';
const PATRULLSVAR = 'PATRULLSVAR-HEMLIGT';
const FORHINDER = 'FORHINDER-HEMLIGT';
const SWISH = 'SWISH-HEMLIGT-99';
const MEJL = 'kassor@hemlig.example';
const TELEFON = '070-111 22 33';
const REGID = 'reg-HEMLIG-I-FALTET';
const DOC_ID = 'reg-HEMLIG-LÄNK';
const TOTAL = 'TOTALBELOPP-99999';

const COMP = {
  name: 'Alghornet',
  shortName: 'AH',
  date: '2026-09-12',
  year: 2026,
  slug: 'ah26',
  closed: true,
  registration: {
    enabled: true,
    mode: 'kar',
    opensAt: '2026-01-01',
    closesAt: '2026-08-01',
    pricing: { model: 'patrull', perPatrol: 450, perScout: 80, flat: 0, base: 0, unit: 'patrull', perUnit: 0 },
    methods: [
      { type: 'swish', label: 'Swish', number: SWISH, info: TELEFON },
      { type: 'bankgiro', label: 'Bankgiro', number: '123-4567', info: 'hemlig info om kontot' }
    ]
  }
};

const REGS = [
  {
    id: REGID,
    kar: 'Lindsdals Scoutkår',
    cancelled: false,
    totalAmount: TOTAL,
    contact: { name: 'Ada Admin', email: MEJL, phone: TELEFON },
    answers: { mat: GIFT },
    forhinder: [{ text: FORHINDER, phone: TELEFON }],
    paidRefs: ['AH26-K7PM'],
    paymentClaims: [{ reference: 'AH26-OBET', at: '2026-08-02T12:00:00Z' }],
    payments: [
      { id: 'p1', amount: 900, reference: 'AH26-K7PM', createdAt: '2026-06-01T10:00:00.000Z', paid: false },
      { id: 'p2', amount: 450, reference: 'AH26-OBET', createdAt: '2026-06-02', paid: true }
    ],
    patrols: [
      { name: 'Rävarna', avdelning: 'Spårare', antal: 6, answers: { mat: PATRULLSVAR } },
      { name: 'Ugglorna', avdelning: 'Upptäckare', antal: 4, answers: {} }
    ],
    efteranmalningar: [{
      at: '2026-08-15T12:00:00Z', patrols: ['Lodjuren'],
      andrade: [{ namn: 'Rävarna', fran: 5, till: 6 }],
      amount: 450, reference: 'AH26-EFTER', av: MEJL
    }]
  },
  {
    kar: 'Okända kåren',
    cancelled: true,
    paidRefs: ['AH26-AVAN'],
    payments: [{ amount: 450, reference: 'AH26-AVAN', createdAt: '2026-05-01', paid: true, paidAt: '2026-05-02' }],
    patrols: [{ name: 'Vargarna', avdelning: 'Äventyrare', antal: 5 }]
  },
  {
    kar: 'Gamla kåren',
    payments: [{ amount: 200, reference: 'AH26-GAMMAL', createdAt: '2026-04-01', paid: true, paidAt: '2026-04-03T08:00:00Z' }],
    patrols: [{ name: 'Hararna', avdelning: 'Spårare', antal: 3 }]
  },
  {
    kar: 'Tom belopp',
    paidRefs: ['AH26-UTAN'],
    payments: [{ reference: 'AH26-UTAN', createdAt: '2026-03-01' }],
    patrols: [{ name: 'Bävrarna', avdelning: 'Spårare' }]
  },
  {
    kar: 'Nollan',
    paidRefs: [],
    payments: [{ amount: 0, reference: 'AH26-NOLL', createdAt: '2026-03-02' }],
    patrols: [{ name: 'Myrorna', avdelning: 'Spårare', antal: 0 }]
  }
];

const GIFTIGA = [GIFT, PATRULLSVAR, FORHINDER, SWISH, MEJL, TELEFON, REGID, DOC_ID, TOTAL, '123-4567', 'hemlig info'];

function underlag(nu = '2026-10-12') {
  return byggUnderlag(COMP, REGS, { nu });
}

function finn(u, kar) {
  return u.karer.find(k => k.kar === kar);
}

describe('bokföringsunderlag: belopp hittas inte på', () => {
  test('ESM och CJS ger identiskt underlag, CSV och HTML', () => {
    const a = underlag();
    const b = cjs.byggUnderlag(COMP, REGS, { nu: '2026-10-12' });
    assert.deepEqual(a, b);
    assert.equal(tillCsv(a), cjs.tillCsv(b));
    assert.equal(tillHtml(a), cjs.tillHtml(b));
    assert.deepEqual(avgifterAv(COMP), cjs.avgifterAv(COMP));
  });

  test('avprickad referens är hela det förväntade beloppet, obetald är tom', () => {
    const lind = finn(underlag(), 'Lindsdals Scoutkår');
    const betald = lind.betalningar.find(b => b.referens === 'AH26-K7PM');
    const obetald = lind.betalningar.find(b => b.referens === 'AH26-OBET');
    assert.equal(betald.status, 'betald');
    assert.equal(betald.forvantatBelopp, 900);
    assert.equal(betald.betaltBelopp, 900);
    assert.match(betald.betaltBeloppKalla, /hela det förväntade beloppet/);
    assert.equal(betald.avprickadDatum, null);
    assert.match(betald.noteringar.join(' '), /Datum för avprickningen är inte lagrat/);
    assert.equal(obetald.status, 'karan_sager_betald');
    assert.equal(obetald.betaltBelopp, null);
    assert.notEqual(obetald.betaltBelopp, 0);
    assert.match(obetald.betaltBeloppKalla, /Inte lagrat/);
    assert.match(obetald.noteringar.join(' '), /äldre paid-flagga/);
    assert.match(obetald.noteringar.join(' '), /påstående/);
  });

  test('paidRefs vinner över den äldre flaggan, och utan paidRefs gäller flaggan', () => {
    const gammal = finn(underlag(), 'Gamla kåren');
    const post = gammal.betalningar[0];
    assert.equal(post.status, 'betald');
    assert.equal(post.betaltBelopp, 200);
    assert.equal(post.avprickadDatum, '2026-04-03');
    assert.match(post.noteringar.join(' '), /äldre paid-flaggan/);
  });

  test('saknat belopp förblir null, lagrad nolla förblir noll, totalAmount används inte', () => {
    const tom = finn(underlag(), 'Tom belopp');
    assert.equal(tom.betalningar[0].forvantatBelopp, null);
    assert.equal(tom.betalningar[0].betaltBelopp, null);
    assert.equal(tom.patruller[0].antal, null);
    assert.equal(tom.antalScouter, null);
    assert.match(tom.betalningar[0].noteringar.join(' '), /saknar belopp/);
    const noll = finn(underlag(), 'Nollan');
    assert.equal(noll.betalningar[0].forvantatBelopp, 0);
    assert.equal(noll.betalningar[0].betaltBelopp, null);
    const u = underlag();
    assert.equal(u.totaler.forvantat, 1550);
    assert.equal(u.totaler.inbetalt, 1100);
    assert.equal(u.totaler.kvar, 450);
    assert.equal(u.totaler.aterbetalning, 450);
    assert.equal(u.totaler.anmalningar, 4);
    assert.equal(u.totaler.avanmalda, 1);
    assert.equal(u.totaler.patruller, 5);
    assert.equal(u.totaler.scouter, 13);
  });

  test('avanmäld ingår i listan men inte i totalerna', () => {
    const av = finn(underlag(), 'Okända kåren');
    assert.equal(av.avanmald, true);
    assert.equal(av.inbetalt, 450);
    assert.match(av.noteringar.join(' '), /Avanmäld/);
    assert.equal(underlag().totaler.forvantat, 1550);
  });

  test('kontakt, allergi, Swish-nummer, länk och totalAmount följer inte med', () => {
    const u = underlag();
    const text = JSON.stringify(u) + tillCsv(u) + tillHtml(u);
    for (const gift of GIFTIGA) assert.equal(text.includes(gift), false, gift);
    assert.equal(text.includes('(e-postadress borttagen)'), false);
    assert.equal(text.includes('(telefonnummer borttaget)'), false);
  });

  test('avgifter är de sparade inställningarna, utan kontonummer', () => {
    const a = avgifterAv(COMP);
    assert.equal(a.prismodell, 'patrull');
    assert.equal(a.belopp.perPatrull, 450);
    assert.equal(a.satt, 'kar');
    assert.deepEqual(a.betalningssatt, [
      { typ: 'swish', etikett: 'Swish' },
      { typ: 'bankgiro', etikett: 'Bankgiro' }
    ]);
    assert.match(a.obs, /Kontonummer och Swish-nummer lämnas inte ut/);
    const tom = avgifterAv({});
    assert.equal(tom.konfigurerad, false);
    assert.equal(JSON.stringify(tom).includes('0 kr'), false);
  });

  test('CSV har BOM, semikolon, tomt betalt belopp och attestrad', () => {
    const csv = tillCsv(underlag());
    assert.equal(csv.charCodeAt(0), 0xfeff);
    assert.match(csv, /Förväntat belopp \(kr\);Betalt belopp \(kr\)/);
    assert.match(csv, /AH26-K7PM;900;900;/);
    assert.match(csv, /AH26-OBET;450;;Inte lagrat/);
    assert.match(csv, /AH26-UTAN;;;Avprickad, men posten saknar belopp/);
    assert.match(csv, /Attest;Kassör/);
    assert.match(csv, /Attest;Datum/);
    assert.match(csv, /Attest;Signatur/);
    assert.match(csv, /Rävarna/);
    assert.match(csv, /Efteranmälan 2026-08-15/);
  });

  test('HTML är en A4-sida med sammanfattning, kår och attest', () => {
    const html = tillHtml(underlag());
    assert.match(html, /@page \{ size: A4/);
    assert.match(html, /<h2>Sammanfattning<\/h2>/);
    assert.match(html, /Lindsdals Scoutkår/);
    assert.match(html, /2 patruller · 10 scouter/);
    assert.match(html, /1 patrull · 5 scouter/);
    assert.equal(html.includes('1 patruller'), false);
    assert.match(html, /<h2>Attest<\/h2>/);
    assert.match(html, /Kassör <span class="linje">/);
    assert.match(html, /Signatur <span class="linje">/);
    assert.match(html, /Skriv ut \/ PDF/);
    assert.match(html, /noindex/);
    assert.match(html, /1[\u00a0\s]?100 kr/);
  });

  test('formelinjektion och HTML-tecken i kårnamn stoppas', () => {
    const u = byggUnderlag(
      { name: 'T' },
      [{ kar: '=cmd|calc', patrols: [{ name: '<script>', antal: 1 }], payments: [] }],
      { nu: '2026-10-12' }
    );
    assert.match(tillCsv(u), /'=cmd\|calc/);
    const html = tillHtml(u);
    assert.match(html, /&lt;script&gt;/);
    assert.equal(html.includes('<script>'), false);
    assert.deepEqual(tillCsv(u), cjs.tillCsv(cjs.byggUnderlag(
      { name: 'T' },
      [{ kar: '=cmd|calc', patrols: [{ name: '<script>', antal: 1 }], payments: [] }],
      { nu: '2026-10-12' }
    )));
  });
});

function tomSnap(docs = []) {
  return { docs, empty: docs.length === 0 };
}

function fejkDb(comp, regs) {
  const skrivningar = [];
  const regDocs = regs.map((data, i) => ({
    id: `${DOC_ID}-${i}`,
    data: () => data,
    ref: { update: async (p) => { skrivningar.push({ typ: 'update', p }); } }
  }));
  const db = {
    collection(path) {
      const p = String(path);
      return {
        get: async () => tomSnap(p.includes('/registrations') ? regDocs : []),
        add: async (d) => { skrivningar.push({ typ: 'add', path: p, d }); return { id: 'nytt' }; },
        doc: () => ({
          get: async () => ({ exists: false, data: () => ({}) }),
          update: async (x) => { skrivningar.push({ typ: 'update', x }); }
        })
      };
    },
    doc(path) {
      return {
        get: async () => ({ exists: true, data: () => String(path) === 'competitions/c' ? comp : {} }),
        update: async (p) => { skrivningar.push({ typ: 'doc-update', path, p }); },
        set: async (p) => { skrivningar.push({ typ: 'set', p }); }
      };
    }
  };
  return { db, skrivningar };
}

function fejkRes() {
  const r = {
    kod: 200, kropp: undefined, headers: {},
    status(k) { r.kod = k; return r; },
    json(v) { r.kropp = v; return r; },
    end() { return r; },
    set(k, v) { r.headers[String(k).toLowerCase()] = v; return r; }
  };
  return r;
}

async function anrop(server, method, params, id = 1) {
  const res = fejkRes();
  await hanteraMcp({
    method: 'POST',
    headers: { 'mcp-protocol-version': '2025-06-18' },
    body: { jsonrpc: '2.0', id, method, params }
  }, res, server);
  return res;
}

function serverFor(comp, db) {
  return {
    namn: 'eskil',
    version: '1.0.0',
    instruktioner: verktyg.INSTRUKTIONER,
    listaVerktyg: () => verktyg.listaVerktyg(),
    nekasVerktyg: (namn) => verktyg.stangdNekande(comp, namn),
    anropaVerktyg: (namn, args) => verktyg.anropaVerktyg(namn, args, { db, cid: 'c', comp })
  };
}

describe('avslutad tävling: läsning går, skrivning nekas', () => {
  const stangd = { ...COMP, closed: true };

  test('varje läsverktyg finns och är märkt readOnly, och inget annat', () => {
    const namn = new Set(verktyg.VERKTYG.map(v => v.namn));
    for (const n of verktyg.LASVERKTYG) assert.equal(namn.has(n), true, n);
    for (const t of verktyg.listaVerktyg()) {
      assert.equal(t.annotations.readOnlyHint, verktyg.LASVERKTYG.has(t.name), t.name);
    }
    for (const n of ['anmalningar_las', 'avgifter_las', 'betalningar_las', 'bokforing_underlag',
      'tavling_las', 'patruller_lista', 'laget_las', 'poang_las', 'kontroller_lista']) {
      assert.equal(verktyg.LASVERKTYG.has(n), true, n);
    }
  });

  test('stangdNekande släpper läsning och nekar skrivning med samma meddelande', () => {
    for (const n of verktyg.LASVERKTYG) assert.equal(verktyg.stangdNekande(stangd, n), null, n);
    for (const v of verktyg.VERKTYG) {
      if (verktyg.LASVERKTYG.has(v.namn)) continue;
      const nekad = verktyg.stangdNekande(stangd, v.namn);
      assert.equal(nekad.status, 403, v.namn);
      assert.equal(nekad.kod, -32001, v.namn);
      assert.equal(nekad.meddelande, 'Tävlingen är avslutad och kan inte ändras.');
    }
    assert.equal(verktyg.stangdNekande(stangd, 'okant_verktyg').status, 403);
    assert.equal(verktyg.stangdNekande({ name: 'öppen' }, 'tavling_uppdatera'), null);
    assert.equal(verktyg.stangdNekande({}, 'tavling_uppdatera'), null);
    assert.equal(verktyg.stangdNekande(null, 'tavling_uppdatera'), null);
  });

  test('initialize och tools/list fungerar, skrivverktyg får 403 och rör ingen data', async () => {
    const { db, skrivningar } = fejkDb(stangd, REGS);
    const server = serverFor(stangd, db);
    const init = await anrop(server, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal(init.kod, 200);
    assert.equal(init.kropp.result.serverInfo.name, 'eskil');
    const lista = await anrop(server, 'tools/list', {});
    assert.equal(lista.kod, 200);
    const verktygsnamn = lista.kropp.result.tools.map(t => t.name);
    assert.ok(verktygsnamn.includes('bokforing_underlag'));
    assert.equal(lista.kropp.result.tools.find(t => t.name === 'tavling_uppdatera').annotations.readOnlyHint, false);

    for (const v of verktyg.VERKTYG) {
      if (verktyg.LASVERKTYG.has(v.namn)) continue;
      const res = await anrop(server, 'tools/call', { name: v.namn, arguments: { name: 'X', nummer: 1, format: 'csv' } });
      assert.equal(res.kod, 403, v.namn);
      assert.equal(res.kropp.error.code, -32001, v.namn);
      assert.equal(res.kropp.error.message, 'Tävlingen är avslutad och kan inte ändras.');
      assert.equal(res.kropp.id, 1);
    }
    assert.equal(skrivningar.length, 0);
  });

  test('läsverktyg och export fungerar mot den stängda tävlingen', async () => {
    const { db, skrivningar } = fejkDb(stangd, REGS);
    const server = serverFor(stangd, db);
    const las = ['tavling_las', 'kontroller_lista', 'patruller_lista', 'laget_las', 'poang_las',
      'anmalningar_las', 'avgifter_las', 'betalningar_las'];
    for (const namn of las) {
      const res = await anrop(server, 'tools/call', { name: namn, arguments: {} });
      assert.equal(res.kod, 200, namn);
      assert.equal(res.kropp.result.isError, false, `${namn}: ${res.kropp.result?.content?.[0]?.text}`);
    }
    const betal = await anrop(server, 'tools/call', { name: 'betalningar_las', arguments: {} });
    const betalText = betal.kropp.result.content[0].text;
    assert.match(betalText, /AH26-K7PM/);
    assert.match(betalText, /Inte lagrat/);
    for (const gift of GIFTIGA) assert.equal(betalText.includes(gift), false, gift);

    for (const format of ['csv', 'html']) {
      const res = await anrop(server, 'tools/call', { name: 'bokforing_underlag', arguments: { format } });
      assert.equal(res.kod, 200, format);
      assert.equal(res.kropp.result.isError, false, format);
      const svar = JSON.parse(res.kropp.result.content[0].text);
      assert.equal(svar.format, format);
      assert.equal(svar.dokument.startsWith('[data]'), false);
      if (format === 'csv') {
        assert.equal(svar.dokument.charCodeAt(0), 0xfeff);
        assert.match(svar.dokument, /AH26-K7PM;900;900;/);
        assert.match(svar.dokument, /AH26-OBET;450;;/);
        assert.match(svar.dokument, /Attest/);
      } else {
        assert.match(svar.dokument, /@page \{ size: A4/);
        assert.match(svar.dokument, /Attest/);
        assert.match(svar.dokument, /Kassör/);
      }
      for (const gift of GIFTIGA) assert.equal(svar.dokument.includes(gift), false, `${format} ${gift}`);
    }
    assert.equal(skrivningar.length, 0);
  });

  test('reservspärren i anropaVerktyg skriver inte om transporten glömmer 403', async () => {
    const { db, skrivningar } = fejkDb(stangd, REGS);
    const svar = await verktyg.anropaVerktyg('tavling_uppdatera', { name: 'Nytt namn' }, { db, cid: 'c', comp: stangd });
    assert.equal(svar.isError, true);
    assert.equal(svar.text, 'Tävlingen är avslutad och kan inte ändras.');
    assert.equal(skrivningar.length, 0);
  });

  test('en öppen tävling kan fortfarande skrivas', async () => {
    const oppen = { ...COMP, closed: false };
    const { db, skrivningar } = fejkDb(oppen, REGS);
    const svar = await verktyg.anropaVerktyg('tavling_uppdatera', { name: 'Nytt namn' }, { db, cid: 'c', comp: oppen });
    assert.equal(svar.isError, undefined);
    assert.equal(skrivningar.length, 1);
    assert.equal(skrivningar[0].p.name, 'Nytt namn');
  });
});

describe('nyckeln och löftet följer med avslutet', () => {
  test('closeCompetition raderar inte MCP-nyckeln', () => {
    const store = readFileSync(new URL('../public/js/store.js', import.meta.url), 'utf8');
    const avslut = store.slice(store.indexOf('export async function closeCompetition'), store.indexOf('export async function deleteThreads'));
    assert.match(avslut, /MCP-nyckeln LIGGER KVAR/);
    assert.equal(/private',\s*'mcp'/.test(avslut), false);
    const radera = store.slice(store.indexOf('export async function deleteCompetition'), store.indexOf('export async function loggHandelse'));
    assert.match(radera, /collection\(db, 'competitions', cid, 'private'\)/);
  });

  test('auth släpper avslutad tävling och nekar fortfarande demot', () => {
    const auth = readFileSync(new URL('../functions/mcp/auth.js', import.meta.url), 'utf8');
    assert.equal(/comp\.closed/.test(auth), false);
    assert.equal(auth.includes('Tävlingen är avslutad'), false);
    assert.match(auth, /if \(comp\.demo\)/);
  });

  test('HTTP-lagret frågar stangdNekande innan verktyget körs', () => {
    const index = readFileSync(new URL('../functions/index.js', import.meta.url), 'utf8');
    assert.match(index, /nekasVerktyg: \(namn\) => mcpVerktyg\.stangdNekande\(kontroll\.comp, namn\)/);
    const transport = readFileSync(new URL('../functions/mcp/transport.js', import.meta.url), 'utf8');
    assert.match(transport, /server\.nekasVerktyg\(namn\)/);
  });

  test('adminvyerna laddar ner samma underlag, och integritet säger att läsningen ligger kvar', () => {
    const anmalan = readFileSync(new URL('../public/js/views/anmalan-admin.js', import.meta.url), 'utf8');
    assert.match(anmalan, /laddaNerBokforingCsv\(comp, regs\)/);
    assert.match(anmalan, /oppnaBokforingSida\(comp, regs\)/);
    assert.match(anmalan, /id="bok-csv"/);
    const utskrifter = readFileSync(new URL('../public/js/views/utskrifter.js', import.meta.url), 'utf8');
    assert.match(utskrifter, /oppnaBokforingSida\(comp, regs\)/);
    assert.match(utskrifter, /id: 'bokforing'/);
    assert.match(utskrifter, /if \(isAdmin\) poster\.push/);
    const installningar = readFileSync(new URL('../public/js/views/competition-settings.js', import.meta.url), 'utf8');
    assert.match(installningar, /comp\?\.closed/);
    assert.match(installningar, /bokföringsunderlaget/);
    const html = readFileSync(new URL('../public/integritet.html', import.meta.url), 'utf8');
    const ai = html.slice(html.indexOf('AI-koppling (MCP)'), html.indexOf('Startdiagnostik'));
    assert.match(ai, /bokföringsunderlag/);
    assert.match(ai, /tills nyckeln återkallas/);
    assert.match(ai, /anmälningslänkar/);
    assert.equal(/når heller inte anmälningar,/.test(ai), false);
    assert.equal(/automatiskt när\s*tävlingen avslutas/.test(ai), false);
  });

  test('instruktionerna säger att avslutad tävling går att läsa men inte att ändra', () => {
    assert.match(verktyg.INSTRUKTIONER, /AVSLUTAD TÄVLING/);
    assert.match(verktyg.INSTRUKTIONER, /anmalningar_las/);
    assert.match(verktyg.INSTRUKTIONER, /inte 0 kr/);
  });
});
