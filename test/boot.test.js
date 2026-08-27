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
import { arAnonymFaltsida } from '../public/js/utils.js';

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

  test('och den SERVERAR konfigurationen — inte bara förcachar den', () => {
    // Den här kontrollen letade förut bara efter strängen i PRECACHE_URLS och
    // efter undantaget från /__/-spärren. Båda fanns — och filen serverades
    // ändå aldrig, för fetch-lyssnarens predikat matchade inte '/__/'-vägar
    // alls, så respondWith kördes inte. Testet var grönt på ett löfte koden
    // inte höll, och /k, /s och /m gick inte att öppna offline så fort
    // HTTP-cachens timme runnit ut. Därför KÖRS predikatet nu.
    const sw = las('sw.js');
    assert.match(sw, /'\/__\/firebase\/init\.json'/, 'inte längre förcachad');
    const kalla = sw.match(/function skaCachas[\s\S]*?\n}/);
    assert.ok(kalla, 'skaCachas() finns inte — predikatet går inte att pröva');
    const skaCachas = new Function(kalla[0] + '; return skaCachas;')();

    assert.equal(skaCachas('/__/firebase/init.json'), true,
      'konfigurationen serveras inte ur cachen — fältsidorna startar inte offline');
    for (const p of ['/js/app.js', '/assets/tokens.css', '/k.html']) {
      assert.equal(skaCachas(p), true, `${p} borde cachas`);
    }
    // Firebases ÖVRIGA hjälpvägar ska fortfarande gå förbi cachen.
    assert.equal(skaCachas('/__/auth/handler'), false);
    // Och reservkonfigurationen ska inte cachas — se emulatorstubben nedan.
    assert.equal(skaCachas('/firebase-config.json'), false);
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
  // FLERA timrar, inte en. Med bara den senaste kunde attrappen inte skilja
  // "beväpnade om och rensade den gamla" från "beväpnade om och lät den ligga
  // kvar" — och mutationstestet för just det var därför grönt oavsett.
  const timrar = [];
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
    setTimeout: (fn, ms) => { timrar.push({ fn, ms, id: timrar.length + 1 }); return timrar.length; },
    clearTimeout: (id) => { const t = timrar.find(x => x.id === id); if (t) t.avbruten = true; },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; g._obs = this; }
      observe() { this._pa = true; }
      disconnect() { this._pa = false; }
    },
    location: { reload() {} },
    _lyssnare: lyssnare,
    _brand: () => { timrar.filter(t => !t.avbruten).forEach(t => t.fn()); },
    _root: root
  };
  return g;
}

/** Kör vakthundens källa i en attrapp-DOM och lämna tillbaka världen. */
function kor() {
  const g = fejkDom();
  const src = readFileSync(new URL('../public/js/field-watchdog.js', import.meta.url), 'utf8');
  // Skriptet är en IIFE som pratar med window/document/setTimeout.
  new Function('window', 'document', 'setTimeout', 'clearTimeout', 'MutationObserver', 'location', src)
    .call(g, g, g.document, g.setTimeout, g.clearTimeout, g.MutationObserver, g.location);
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

  test('tar med STARTFASERNA — svaret på "vad väntade den på?"', () => {
    // Det här är vad som gör en morgonrapport användbar utan att någon
    // behöver sitta och testa strukturerat: meddelandet säger hur långt
    // starten kom, inte bara att den inte kom fram.
    const g = kor();
    g._brand();
    assert.match(g._root.innerHTML, /Kom till:/);
    assert.match(g._root.innerHTML, /start:/);
  });

  test('faserna går att märka utan att vakthunden kastar', () => {
    // Modulerna anropar window.__eskilFas() genom en try/catch, men funktionen
    // måste finnas — annars registreras ingenting och tidslinjen blir tom.
    const g = kor();
    assert.equal(typeof g.__eskilFas, 'function');
    g.__eskilFas('prov');
    g._brand();
    assert.match(g._root.innerHTML, /prov:/);
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

// --- Vilka sidor som får ha IndexedDB i startvägen --------------------------
//
// Auth initieras med IndexedDB-persistens, och Firestore lägger en spärr i sin
// FIFO-kö som väntar på auth-tokenlyssnaren (`awaitNextToken` →
// `enqueueRetryable` → `await deferred.promise`, verifierat i
// firebase-firestore.js 10.12.5). Fyras lyssnaren aldrig — därför att
// `indexedDB.open()` varken svarar success eller error, vilket händer i
// inbyggda webbläsare och när iOS tappar IDB-anslutningen — blockeras HELA
// kön, inklusive Firestores egen 10-sekundersräddning. Läsningen blir varken
// uppfylld eller avvisad och sidan står kvar på "Laddar…".
//
// Därför kör de fyra sidor som ALDRIG loggar in med minnespersistens.
// Gränsdragningen är den farliga delen: en för bred matchning slår ut
// inloggningen i hela admingränssnittet, en för smal återinför hängningen.

describe('anonyma sidor håller IndexedDB borta från startvägen', () => {
  test('de fyra sidor som aldrig loggar in matchar', () => {
    for (const p of ['/a/ah26', '/a/ah26/reg123', '/a/ah26/k/tok',
                     '/k/ah26/ctrl', '/s/ah26/p1', '/s/ah26/p1/tok', '/m/ah26/st1']) {
      assert.equal(arAnonymFaltsida(p), true, `${p} borde vara anonym`);
    }
  });

  test('SPA:n och de publika sidorna gör det INTE', () => {
    // /app börjar på "a" — utan det avslutande snedstrecket i mönstret hade
    // hela admingränssnittet tappat sin långlivade session.
    for (const p of ['/app', '/app/c/ah26', '/app/c/ah26/laget', '/om', '/kontakt',
                     '/', '/integritet', '/t/ah26']) {
      assert.equal(arAnonymFaltsida(p), false, `${p} får inte behandlas som anonym`);
    }
  });

  test('/t står utanför med flit — den använder onAuthStateChanged', () => {
    // public.js:140 har admin-genvägen på tävlingssidan. Tas /t in i listan
    // slutar den känna igen en inloggad tävlingsledare.
    assert.equal(arAnonymFaltsida('/t/ah26'), false);
    const pub = readFileSync(new URL('../public/js/public.js', import.meta.url), 'utf8');
    assert.match(pub, /onAuthStateChanged/, 'public.js slutade använda auth — läs om undantaget');
  });

  test('firebase.js väljer persistens efter den här predikaten', () => {
    const fb = las('js/firebase.js');
    assert.match(fb, /arAnonymFaltsida\(location\.pathname\)/);
    assert.match(fb, /\?\s*inMemoryPersistence/);
    assert.match(fb, /:\s*indexedDBLocalPersistence/);
  });

  test('och de fyra sidorna rör faktiskt aldrig auth', () => {
    // Premissen för hela undantaget. Slutar den gälla måste undantaget bort,
    // annars överlever ingen session en omladdning.
    for (const f of ['anmalan', 'report', 'start', 'station']) {
      const src = readFileSync(new URL(`../public/js/${f}.js`, import.meta.url), 'utf8');
      const rader = src.split('\n')
        .filter(l => !l.trim().startsWith('//'))
        .filter(l => /\bsignIn|onAuthStateChanged|currentUser/.test(l));
      assert.equal(rader.length, 0, `${f}.js använder auth: ${rader.join(' | ')}`);
    }
  });
});

// --- Reservkonfigurationen får inte peka på emulatorn ------------------------
//
// /firebase-config.json är en lokal utvecklingsfil, men den låg spårad i git
// OCH deployad, med projectId "demo-eskil" i sig. Grenen som läser den var
// praktiskt taget onåbar tills konfigurationshämtningen fick ett tak: då kunde
// init.json avbrytas på 5 s medan reservfilen svarade direkt ur HTTP-cachen,
// och sidan hade startat mot ett projekt som inte finns. Fixen som gjorde en
// hängning synlig öppnade alltså en ny väg att gå sönder.

describe('reservkonfigurationen', () => {
  const fb = las('js/firebase.js');

  test('varje hämtad config kontrolleras innan den används', () => {
    assert.match(fb, /function kontrolleraConfig/);
    const anrop = [...fb.matchAll(/return kontrolleraConfig\(await r\.json\(\)\)/g)];
    assert.equal(anrop.length, 2, 'någon gren använder configen okontrollerad');
  });

  test('en emulatorkonfiguration avvisas', () => {
    assert.match(fb, /demo-eskil/);
    assert.match(fb, /demo-local/);
    assert.match(fb, /emulatorkonfiguration i produktion/);
  });

  test('filen deployas inte', () => {
    const conf = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf8'));
    assert.ok(conf.hosting.ignore.some(m => m.includes('firebase-config.json')),
      'firebase-config.json deployas fortfarande');
  });

  test('och service workern cachar den inte', () => {
    // En cachad kopia överlever länge efter att den slutat deployas.
    const sw = las('sw.js');
    const skaCachas = new Function(sw.match(/function skaCachas[\s\S]*?\n}/)[0] + '; return skaCachas;')();
    assert.equal(skaCachas('/firebase-config.json'), false, 'SW:n cachar reservfilen');
  });

  test('den är gitignorerad', () => {
    const gi = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
    assert.match(gi, /^public\/firebase-config\.json$/m);
  });
});

// --- Vakthunden måste kunna beväpnas om -------------------------------------
//
// Första versionen kopplade ner sig vid första barnändringen i behållaren och
// kom aldrig tillbaka. I SPA:n betyder det att allt EFTER landningssidans
// rendering var oskyddat — alltså precis de vyer som laddas dynamiskt och kan
// misslyckas tyst. Skyddet fanns, men bara för den första skärmen.

describe('vakthunden efter första renderingen', () => {
  test('går att beväpna om', () => {
    const g = kor();
    assert.equal(typeof g.__eskilVakt, 'function');
  });

  test('och fyrar då igen om nästa vy aldrig renderar', () => {
    const g = kor();
    g._obs.cb();            // landningssidan renderade → avväpnad
    g._brand();
    assert.equal(g._root.innerHTML, '', 'fyrade fast sidan renderat');
    g.__eskilVakt();        // ruttbyte
    g._brand();             // och inget renderades den här gången
    assert.match(g._root.innerHTML, /Sidan kunde inte ladda klart/);
  });

  test('en gammal timer får inte fyra på en sida som fungerar', () => {
    // Utan att den föregående beväpningen rensas kunde en timer från förra
    // ruttbytet slå till mitt i en vy som sedan länge renderat.
    const g = kor();
    g.__eskilVakt();        // beväpnar om — den gamla timern ska vara rensad
    g._obs.cb();            // den nya vyn renderade
    g._brand();
    assert.equal(g._root.innerHTML, '', 'en gammal timer fyrade av');
  });

  test('app.js beväpnar om vid varje ruttbyte', () => {
    const src = las('js/app.js');
    const hook = src.slice(src.indexOf('setRouteChangeHandler(('), src.indexOf('// ---- Topbar'));
    assert.match(hook, /__eskilVakt/, 'route-change-hooken beväpnar inte om vakthunden');
  });
});

describe('SPA:n visar när en vy inte kunde laddas', () => {
  const src = las('js/app.js');

  test('render() anropas inte längre utan felhantering', () => {
    // Förut: `render();` — ett avvisat löfte blev en ohanterad rejection som
    // ingen visade. Föregående vy stod kvar, frusen, utan förklaring.
    const g = src.slice(src.indexOf('async function guard'), src.indexOf('// ---- Topbar'));
    assert.ok(!/^\s*render\(\);\s*$/m.test(g), 'render() anropas fortfarande oskyddat');
    assert.match(g, /Promise\.resolve\(render\(\)\)\.catch/);
    assert.match(g, /Försök igen/);
  });

  test('ett misslyckat import() görs om med NY specificerare', () => {
    // Module map memoiserar ett avvisat import(): samma specificerare ger
    // samma fel resten av dokumentets livstid, även efter att filen blivit
    // tillgänglig igen. Bara ett nytt namn ger en färsk post.
    const v = src.slice(src.indexOf('const vy ='), src.indexOf('import { renderLogin }'));
    assert.match(v, /catch/);
    assert.match(v, /\?|&/);
    assert.match(v, /r=\$\{Date\.now\(\)\}/);
  });
});

describe('cache-reglerna säger vad de gör', () => {
  test('ingen regel för /js/** som ändå överskuggas av **/*.js', () => {
    // Den fanns och lovade max-age=3600 på modulerna. Mätt i produktion
    // svarade de no-cache — den senare regeln vann. En död regel är värre än
    // ingen: den fick mig att felaktigt tro att en kall morgoncache förklarade
    // en långsam start, och att resonera vidare på det.
    const conf = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf8'));
    const kallor = conf.hosting.headers.map(h => h.source);
    const jsRegler = kallor.filter(s => s.includes('js'));
    assert.ok(!jsRegler.includes('/js/**'),
      `/js/** överskuggas av ${jsRegler.filter(s => s !== '/js/**').join(', ')} — ta bort den i stället för att låta den ljuga`);
  });
});
