// Ingen sida får kunna bli stående på "Laddar…".
//
// Buggen som gav upphov till testet: /a (Anmälan) bootar med en STATISK
// "Laddar anmälan…" i HTML:en, och den byts först när modulen renderat. Två
// oberoende saker kan göra att den aldrig gör det:
//
//  1. firebase.js hämtar /__/firebase/init.json bakom ett TOPPNIVÅ-AWAIT.
//     En fetch som varken svarar eller felar — trögt mobilnät, TCP uppe men
//     tyst — fryser hela modulgrafen. Inget fel inträffar, så inget fel visas.
//  2. App Check (reCAPTCHA v3) är enforced. Blockeras www.google.com av en
//     innehållsblockerare får Firestore aldrig någon token, och läsningen
//     ligger kvar som pending.
//
// Mot BÅDA finns bara ett skydd som fungerar: field-watchdog.js, ett vanligt
// (icke-modul) skript som byter ut laddskärmen mot ett riktigt meddelande om
// ingenting hänt inom deadline. Den fanns redan — men bara på k/s/m.
//
// Testet är statiskt med flit: det läser filerna, kräver ingen webbläsare, och
// faller den dag någon lägger till en ny sida med laddskärm utan vakthund.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const las = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const SIDOR = readdirSync(new URL('../public/', import.meta.url)).filter(f => f.endsWith('.html'));

/** En sida som bootar på en laddskärm: har en behållare OCH texten "Laddar". */
function harLaddskarm(html) {
  const behallare = /id="(root|app)"/.test(html);
  return behallare && /Laddar/i.test(html);
}

describe('vakthunden täcker varje sida som bootar på en laddskärm', () => {
  test('minst fem sidor har en laddskärm — annars mäter testet fel sak', () => {
    const med = SIDOR.filter(f => harLaddskarm(las(f)));
    assert.ok(med.length >= 5, `hittade bara ${med.length} sidor med laddskärm: ${med}`);
  });

  test('var och en av dem laddar field-watchdog.js', () => {
    for (const f of SIDOR) {
      const html = las(f);
      if (!harLaddskarm(html)) continue;
      assert.match(html, /src="\/js\/field-watchdog\.js"/,
        `${f} kan bli stående på "Laddar…" utan att säga varför`);
    }
  });

  test('vakthunden laddas som VANLIGT skript, aldrig som modul', () => {
    // Hela poängen är att den kör när modulgrafen inte gör det. Ett
    // type="module" här hade gjort skyddet beroende av det som är trasigt.
    for (const f of SIDOR) {
      const html = las(f);
      const rad = html.split('\n').find(l => l.includes('field-watchdog.js'));
      if (!rad) continue;
      assert.ok(!/type="module"/.test(rad), `${f}: vakthunden laddas som modul`);
    }
  });

  test('vakthunden hittar båda behållarnamnen', () => {
    // De publika sidorna använder #root, admin-SPA:n #app. Tappar den ena
    // gör vakthunden ingenting alls — tyst, vilket är det värsta sättet att
    // sluta fungera på.
    const wd = las('js/field-watchdog.js');
    assert.match(wd, /getElementById\('root'\)/);
    assert.match(wd, /getElementById\('app'\)/);
  });

  test('vakthunden avväpnas av vilken rendering som helst', () => {
    // Både lyckad rendering och en hanterad felskärm byter ut laddskärmen.
    // Vore villkoret snävare skulle meddelandet slå till ovanpå en sida som
    // fungerar.
    const wd = las('js/field-watchdog.js');
    assert.match(wd, /MutationObserver/);
    assert.match(wd, /childList:\s*true/);
  });

  test('vakthunden fångar felet och visar det', () => {
    // Utan den tekniska raden går felet inte att felsöka från ett foto av en
    // telefonskärm, vilket är precis så de här rapporterna kommer in.
    const wd = las('js/field-watchdog.js');
    assert.match(wd, /addEventListener\('error'/);
    assert.match(wd, /addEventListener\('unhandledrejection'/);
    assert.match(wd, /wd-retry/);
  });
});

describe('konfigurationshämtningen kan inte hänga', () => {
  const fb = las('js/firebase.js');

  test('den ligger bakom ett toppnivå-await — därför måste den ha ett tak', () => {
    // Om den här raden försvinner är resten av beskrivningen inte längre sann,
    // och då ska testet läsas om snarare än lagas.
    assert.match(fb, /^const config = await loadConfig\(\);/m);
  });

  test('båda hämtningarna går genom taket', () => {
    const rader = fb.split('\n').filter(l => /fetch\('\/(__\/firebase\/init|firebase-config)/.test(l));
    assert.equal(rader.length, 0, `rå fetch utan tak kvar: ${rader.join(' | ')}`);
    assert.match(fb, /hamtaMedTak\('\/__\/firebase\/init\.json',\s*\d+\)/);
    assert.match(fb, /hamtaMedTak\('\/firebase-config\.json',\s*\d+\)/);
  });

  test('taken hinner ge upp före vakthundens deadline', () => {
    // Annars hinner vakthunden bara säga "kunde inte ladda klart" utan att
    // kunna berätta varför — felet har inte kastats än.
    const tak = [...fb.matchAll(/hamtaMedTak\([^,]+,\s*(\d+)\)/g)].map(m => Number(m[1]));
    assert.equal(tak.length, 2);
    const deadline = Number(las('js/field-watchdog.js').match(/DEADLINE_MS\s*=\s*(\d+)/)[1]);
    assert.ok(tak[0] + tak[1] < deadline,
      `${tak[0]} + ${tak[1]} ms ryms inte före vakthundens ${deadline} ms`);
  });

  test('AbortController, inte AbortSignal.timeout', () => {
    // AbortSignal.timeout saknas i Safari före 16, och de telefonerna finns
    // i kårerna.
    assert.match(fb, /new AbortController\(\)/);
    // Anropsformen, inte ordet: kommentaren i firebase.js NÄMNER
    // AbortSignal.timeout för att förklara varför den inte används.
    assert.ok(!/AbortSignal\.timeout\(/.test(fb), 'AbortSignal.timeout når inte äldre Safari');
  });
});

describe('service workern täcker anmälningssidan', () => {
  test('/a registrerar den, som övriga publika sidor', () => {
    assert.match(las('a.html'), /src="\/js\/sw-register\.js"/);
  });

  test('och den förcachar konfigurationen som annars blockerar starten', () => {
    const sw = las('sw.js');
    assert.match(sw, /'\/__\/firebase\/init\.json'/);
    // …och undantar den från den generella /__/-förbigången.
    assert.match(sw, /url\.pathname !== '\/__\/firebase\/init\.json'/);
  });

  test('vakthunden är förcachad — den behövs mest när nätet är dåligt', () => {
    assert.match(las('sw.js'), /'\/js\/field-watchdog\.js'/);
  });
});

// --- Vakthunden KÖRD, inte bara läst ----------------------------------------
//
// De statiska kontrollerna ovan säger att skriptet finns på sidan. Det här
// kör det: en minimal DOM-attrapp (ingen jsdom — projektet har noll
// beroenden) räcker för de fem API:er vakthunden rör.
//
// Utan det här testet vilar hela skyddet på att någon minns att öppna en sida
// med trasigt nät och vänta i tio sekunder.

function fejkDom() {
  const lyssnare = {};
  let timer = null;
  const el = (id) => ({
    id, innerHTML: '', _barn: [],
    addEventListener() {}
  });
  const root = el('root');
  let retry = null;
  const doc = {
    readyState: 'loading',
    getElementById: (id) => (id === 'root' ? root : id === 'wd-retry' ? retry : null),
    addEventListener: (namn, fn) => { lyssnare[namn] = fn; }
  };
  // innerHTML-sättning på root skapar retry-knappen, som vakthunden slår upp.
  Object.defineProperty(root, 'innerHTML', {
    get() { return this._html || ''; },
    set(v) { this._html = v; if (v.includes('wd-retry')) retry = { addEventListener() {} }; }
  });
  const g = {
    document: doc,
    addEventListener: (namn, fn) => { lyssnare[namn] = fn; },
    setTimeout: (fn, ms) => { timer = { fn, ms }; return 1; },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; g._obs = this; }
      observe() { this._pa = true; }
      disconnect() { this._pa = false; }
    },
    location: { reload() {} },
    _lyssnare: lyssnare,
    _brand: () => { if (timer) timer.fn(); },
    _root: root
  };
  return g;
}

/** Kör vakthundens källa i en attrapp-DOM och lämna tillbaka världen. */
function kor() {
  const g = fejkDom();
  const src = readFileSync(new URL('../public/js/field-watchdog.js', import.meta.url), 'utf8');
  // Skriptet är en IIFE som pratar med window/document/setTimeout.
  new Function('window', 'document', 'setTimeout', 'MutationObserver', 'location', src)
    .call(g, g, g.document, g.setTimeout, g.MutationObserver, g.location);
  g.document.readyState = 'complete';
  g._lyssnare.DOMContentLoaded?.();     // armera
  return g;
}

describe('vakthunden när den faktiskt körs', () => {
  test('byter ut laddskärmen när ingenting hänt inom deadline', () => {
    const g = kor();
    assert.equal(g._root.innerHTML, '', 'skrev innan deadline');
    g._brand();
    assert.match(g._root.innerHTML, /Sidan kunde inte ladda klart/);
    assert.match(g._root.innerHTML, /wd-retry/);
  });

  test('håller tyst när sidan HAR renderat', () => {
    // Avväpningen är det som gör att en fungerande sida aldrig får
    // felmeddelandet slängt över sig.
    const g = kor();
    g._obs.cb();          // en rendering skedde
    g._brand();
    assert.equal(g._root.innerHTML, '', 'skrev över en sida som redan renderat');
  });

  test('tar med felorsaken så den går att felsöka från ett foto', () => {
    const g = kor();
    g._lyssnare.unhandledrejection({ reason: new Error('Konfigurationen kunde inte hämtas') });
    g._brand();
    assert.match(g._root.innerHTML, /Konfigurationen kunde inte hämtas/);
  });

  test('och escapar felet — det kan bära fältdata', () => {
    const g = kor();
    g._lyssnare.error({ message: '<img src=x onerror=alert(1)>', filename: '/js/a.js', lineno: 3 });
    g._brand();
    assert.ok(!g._root.innerHTML.includes('<img src=x'), 'felmeddelandet injicerades rått');
    assert.match(g._root.innerHTML, /&lt;img/);
  });
});
