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
import { arAnonymFaltsida, arEnflikssida, medOmforsok, arSakertInteFunnen, faltFelHtml } from '../public/js/utils.js';

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
    _timrar: timrar,
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

  test('och samma predikat ger dem en EGEN Firebase-app', () => {
    // Firestores cache och fliksynkronisering nycklas på appens namn. Delar
    // fältsidorna namn med admin-appen bildar de en pool där den primära
    // fliken kör de andras frågor med SINA inloggningsuppgifter — var en
    // anonym sida första fliken nekades admin-flikens medlemsläsningar
    // ("Missing or insufficient permissions" på Anmälan, brickan Super-admin
    // borta). Återskapat i emulatorn med två flikar.
    const fb = las('js/firebase.js');
    assert.match(fb, /initializeApp\(config,\s*arAnonymFaltsida\(location\.pathname\)\s*\?\s*'falt'/,
      'fältsidorna måste initiera en egen namngiven app');
    assert.doesNotMatch(fb, /initializeApp\(config\)/, 'en namnlös app delar pool med admin-flikarna');
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

  test('en fas förlänger tidsfristen — en sida som gör framsteg är inte fast', () => {
    // Uppmätt på /t över mobilnät: tävlingsläsningen tog 7,3 s och sidan blev
    // klar vid 12,7 s, men vakthunden räknade tio sekunder från beväpningen
    // och bytte ut en sida som var på väg. Nu flyttar varje fas fristen.
    const g = kor();
    const fore = g._timrar.filter(t => !t.avbruten);
    assert.equal(fore.length, 1, 'en beväpnad timer');
    g.__eskilFas('tavling-klar');
    assert.equal(fore[0].avbruten, true, 'den gamla timern ska vara rensad');
    const efter = g._timrar.filter(t => !t.avbruten);
    assert.equal(efter.length, 1, 'exakt en ny timer');
    assert.equal(efter[0].ms, 10000, 'ny frist på DEADLINE_MS från fasen');
    // Och står sidan ändå stilla efter den nya fristen fyrar den.
    g._brand();
    assert.match(g._root.innerHTML, /Sidan kunde inte ladda klart/);
    assert.match(g._root.innerHTML, /tavling-klar/, 'fasen ska stå i den tekniska raden');
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

  test('versionsskev efter en deploy laddar om sidan — en gång, och bara för länkfel', () => {
    // Fliken var öppen FÖRE deployen: gamla store.js i module map, färsk vyfil
    // (no-cache) som importerar ett namn som inte fanns då. Länkningen ger ett
    // SyntaxError, och varken andra försöket eller Försök igen hjälper — bara
    // en omladdning ger en ny modulgraf. Hände i produktion när tidtagningen
    // gick ut: varje öppen adminflik fick felskärmen på nästa vybyte.
    const v = src.slice(src.indexOf('const vy ='), src.indexOf('import { renderLogin }'));
    assert.match(v, /laddaOmVidSkev\(e\)/, 'vy() frågar inte skev-vakten');
    assert.ok(v.indexOf('laddaOmVidSkev') < v.indexOf('r=${Date.now()}'),
      'omladdningen måste prövas FÖRE det nya försöket — det nya försöket faller på samma länkning');
    const kod = src.slice(src.indexOf('const OMLADDNING_NYCKEL'), src.indexOf('const vy ='));
    const kor = (lager) => {
      const reloads = [];
      const fabrik = new Function('sessionStorage', 'location', 'console', `${kod}; return laddaOmVidSkev;`);
      return { fn: fabrik(lager, { reload: () => reloads.push(1) }, { warn() {} }), reloads };
    };
    const minne = () => {
      const m = new Map();
      return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, x) => m.set(k, String(x)) };
    };
    const chrome = new SyntaxError("The requested module '../store.js' does not provide an export named 'stangKontroll'");
    const a = kor(minne());
    assert.equal(a.fn(chrome), true);
    assert.equal(a.reloads.length, 1);
    assert.equal(a.fn(chrome), false, 'ett andra länkfel inom en halvminut får inte bli en omladdningsloop');
    assert.equal(a.reloads.length, 1);
    const b = kor(minne());
    assert.equal(b.fn(new TypeError('Failed to fetch dynamically imported module')), false,
      'ett nätfel ska gå till det nya försöket, inte till omladdning');
    assert.equal(b.reloads.length, 0);
    const c = kor(minne());
    assert.equal(c.fn(new SyntaxError("Importing binding name 'stangKontroll' is not found.")), true,
      'Safari formulerar samma länkfel annorlunda');
    const d = kor({ getItem() { throw new Error('privat läge'); }, setItem() { throw new Error('privat läge'); } });
    assert.equal(d.fn(chrome), true, 'ett sessionStorage som kastar får inte stoppa omladdningen');
    assert.equal(d.reloads.length, 1);
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


// ---------------------------------------------------------------------------
// FÄLTSIDOR SOM INTE LADDADE — felsökningen efter en skarp tävling.
//
// Startkort och kontrollkort stod på "Laddar…", vakthunden sa "inget fel — sidan
// väntade", det stod "hittades inte" för sådant som fanns, en omladdning hjälpte
// INTE, men att lägga sidan på hemskärmen gjorde det. Tre orsaker, alla här.
// ---------------------------------------------------------------------------
describe('fältsidorna hänger aldrig på en annan flik', () => {
  const las = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
  const fb = las('firebase.js');

  test('fältsidor kör ENFLIKShantering — med fliksynkronisering äger en bakgrundsflik serverkontakten', () => {
    // Återskapat i emulatorn: en levande flik med dött nät + en ny flik →
    // vakthunden efter 10 s, även efter "Försök igen". Med enflikshantering: 0,19 s.
    assert.match(fb, /persistentLocalCache\(\{ tabManager: persistentSingleTabManager\(\{\}\) \}\)/);
    const gren = fb.slice(fb.indexOf('let localCache;'), fb.indexOf('const db = isLocalHost'));
    assert.match(gren, /if \(!enflikssida\) \{\s*localCache = persistentLocalCache\(\{ tabManager: persistentMultipleTabManager\(\) \}\);/,
      'admin-appen ska behålla den delade cachen');
    const enflik = gren.slice(gren.indexOf('} else {'));
    assert.doesNotMatch(enflik, /persistentMultipleTabManager/, 'fältsidorna och /t har fliksynkronisering igen');
    assert.match(fb, /const enflikssida = arEnflikssida\(location\.pathname\);/);
  });

  test('/t kör enflikshantering men är INTE en anonym fältsida — den behåller appen och inloggningen', () => {
    // Anhöriga har /t på telefoner, ofta i flera flikar (varje delad länk blir
    // en ny). Men sidan läser behörigheter som den inloggade (admin-genvägen),
    // så den får inte hamna i den anonyma "falt"-appen.
    for (const p of ['/t/ah26', '/t/ah26/patrull', '/k/c/x', '/s/c/p', '/m/c/s', '/a/c'])
      assert.equal(arEnflikssida(p), true, p);
    for (const p of ['/app', '/app/c/x/patrols', '/', '/om', '/kontakt', '/t', '/tavling', '/overlamning'])
      assert.equal(arEnflikssida(p), false, p);
    assert.equal(arAnonymFaltsida('/t/ah26'), false);
    assert.match(fb, /initializeApp\(config, arAnonymFaltsida\(location\.pathname\) \? 'falt' : undefined\)/,
      'appnamnet ska följa arAnonymFaltsida, inte arEnflikssida — annars tappar /t inloggningen');
  });

  test('IndexedDB prövas FÖRE Auth — på /t skyddar provet även inloggningens start', () => {
    assert.ok(fb.indexOf('idbOk = await idbSvarar();') < fb.indexOf('const auth = initializeAuth('),
      'Auth med IndexedDB-persistens hänger Firestores kö om databasen är död — provet måste komma först');
    assert.match(fb, /persistence: \(faltsida \|\| !idbOk\)\s*\? inMemoryPersistence/);
  });

  test('aldrig forceOwnership — den dödar den andra flikens Firestore tyst', () => {
    const kod = fb.split('\n').filter(r => !r.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(kod, /forceOwnership/, 'en kontrollant som växlar tillbaka till den gamla fliken sparar poäng som aldrig går iväg');
  });

  test('IndexedDB prövas med en EGEN databas och en tidsgräns — svarar den inte körs minnescache', () => {
    assert.match(fb, /indexedDB\.open\('eskil-idb-prov'\)/);
    assert.doesNotMatch(fb, /indexedDB\.open\('firestore/, 'en tom databas med Firestores namn förstör dess schema');
    assert.match(fb, /const t = setTimeout\(\(\) => svara\(false\), ms\);/);
    assert.match(fb, /: memoryLocalCache\(\);/);
    // Provet får bara kosta de sidor som behöver det; admin ska inte vänta på det.
    assert.match(fb, /if \(enflikssida\) \{\s*fas\('idb-prov'\);\s*idbOk = await idbSvarar\(\);/);
  });

  test('getDocFromServer exporteras — "finns inte" ska kunna bekräftas förbi cachen', () => {
    const exp = fb.slice(fb.lastIndexOf('export {'));
    assert.match(exp, /getDocFromServer/);
  });
});

describe('"hittades inte" sägs bara när servern sagt det', () => {
  const las = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');

  test('ett fel eller ett svar ur cachen är ALDRIG ett "finns inte"', () => {
    assert.equal(arSakertInteFunnen({ fel: null, franCache: false }), true);
    assert.equal(arSakertInteFunnen({ fel: new Error('offline') }), false);
    assert.equal(arSakertInteFunnen({ franCache: true }), false, 'en fråga som inte når servern svarar tomt ur cachen utan att kasta');
    assert.equal(arSakertInteFunnen(), true);
  });

  test('kortadressen sväljer inte längre fel till null', () => {
    const store = las('store.js');
    const f = store.slice(store.indexOf('export async function resolveCompetition'), store.indexOf('// NAMNRYMDSIMPORT'));
    assert.doesNotMatch(f, /\.catch\(\(\) => null\)/, 'varje läsfel blir "Tävlingen hittades inte" — på startkortets normalväg');
    assert.match(f, /bySlug\.metadata\?\.fromCache/);
    assert.match(f, /if \(!arSakertInteFunnen\(\{ fel, franCache \}\)\) throw ingenKontakt\(fel\);/);
    assert.match(store, /await getDocFromServer\(doc\(db, \.\.\.sokvag\)\)/);
  });

  test('kontrollkortet och startkortet bekräftar mot servern innan de säger "hittades inte"', () => {
    const k = las('report.js'), s = las('start.js');
    assert.ok(k.indexOf("storeNs.finnsPaServern('competitions', cid, 'controls', ctrlId)") < k.indexOf("felskarm('Kontrollen hittades inte'"));
    assert.ok(k.indexOf("storeNs.finnsPaServern('competitions', cid, 'controls', ctrlId)") > 0);
    assert.ok(s.indexOf("storeNs.finnsPaServern('competitions', cid, 'patrols', patrolId)") > 0);
    assert.ok(s.indexOf("storeNs.finnsPaServern('competitions', cid, 'patrols', patrolId)") < s.indexOf("renderError('Patrullen hittades inte'"));
  });

  test('de nya namnen importeras ur NAMNRYMDER — en cachad äldre fil får inte döda sidan', () => {
    // Service workern hämtar nät-först med tidsgräns per fil, så en färsk
    // report.js kan paras ihop med en cachad utils.js. Ett namngivet import av
    // ett namn som saknas där är ett SyntaxError vid länkningen.
    for (const f of ['report.js', 'start.js']) {
      const src = las(f);
      const namngivna = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/(?:utils|store)\.js'/g)].map(m => m[1]).join(',');
      for (const namn of ['medOmforsok', 'faltFelHtml', 'finnsPaServern', 'arSakertInteFunnen'])
        assert.ok(!new RegExp(`\\b${namn}\\b`).test(namngivna), `${f} importerar ${namn} med namn`);
      assert.match(src, /import \* as utilsNs from '\.\/utils\.js';/);
      assert.match(src, /utilsNs\.medOmforsok \|\| \(\(fn\) => fn\(1\)\)/, `${f} saknar reserven`);
    }
    const store = las('store.js');
    assert.match(store, /const getDocFromServer = firebaseNs\.getDocFromServer \|\| getDoc;/);
    assert.doesNotMatch(store.slice(0, store.indexOf("import * as firebaseNs")), /getDocFromServer/, 'store.js importerar getDocFromServer med namn');
  });
});

describe('startläsningen: omförsök med tidsgräns', () => {
  const ingenVanta = () => Promise.resolve();

  test('andra försöket går igenom — det vanliga fallet på ett skogsnät', async () => {
    const anrop = []; const marken = [];
    const ut = await medOmforsok(async (n) => { anrop.push(n); if (n < 2) throw new Error('trögt'); return 'klart'; },
      { forsok: 3, vanta: ingenVanta, vidForsok: (n) => marken.push(n) });
    assert.equal(ut, 'klart');
    assert.deepEqual(anrop, [1, 2]);
    assert.deepEqual(marken, [2], 'vakthunden ska få en fas FÖRE varje nytt försök');
  });

  test('ger upp efter sista försöket och kastar det SISTA felet', async () => {
    let n = 0;
    await assert.rejects(() => medOmforsok(async () => { n++; throw new Error('fel ' + n); }, { forsok: 3, vanta: ingenVanta }), /fel 3/);
    assert.equal(n, 3);
  });

  test('nekad behörighet försöks inte om — den blir inte sannare av att upprepas', async () => {
    let n = 0;
    const nekad = Object.assign(new Error('nekad'), { code: 'permission-denied' });
    await assert.rejects(() => medOmforsok(async () => { n++; throw nekad; }, { forsok: 3, vanta: ingenVanta }), /nekad/);
    assert.equal(n, 1);
  });

  // Egen tidsgräns på TESTET: utan den hänger hela sviten om tidsgränsen i
  // medOmforsok försvinner — ett test som hänger i stället för att falla.
  test('en läsning som varken svarar eller felar blir ett fel — och nästa försök går', { timeout: 3000 }, async () => {
    let n = 0;
    const ut = await medOmforsok((forsok) => { n++; return forsok === 1 ? new Promise(() => {}) : Promise.resolve('svar'); },
      { forsok: 2, tidsgransMs: 20, vanta: ingenVanta });
    assert.equal(ut, 'svar');
    assert.equal(n, 2);
  });

  test('en märkning som kastar stoppar aldrig försöket', async () => {
    const ut = await medOmforsok(async (n) => { if (n === 1) throw new Error('x'); return 'ok'; },
      { vanta: ingenVanta, vidForsok: () => { throw new Error('vakthunden saknas'); } });
    assert.equal(ut, 'ok');
  });

  test('felskärmen har en väg vidare, och escapar det den visar', () => {
    const html = faltFelHtml('Kunde inte läsa <b>kontrollen</b>', 'fel & "sånt"');
    assert.match(html, /id="falt-igen"/);
    assert.ok(!html.includes('<b>'), 'rubriken injicerades rått');
    assert.match(html, /fel &amp; /);
  });

  test('båda fältsidorna läser med omförsök, tidsgräns och fas per försök', () => {
    for (const [f, fas] of [['report.js', "fasa('k-las-' + n)"], ['start.js', "fasa('s-las-' + n)"]]) {
      const src = readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
      assert.match(src, /forsok: 3, tidsgransMs: 15000/, f);
      assert.ok(src.includes(fas), `${f}: utan fas byter vakthunden ut en sida som arbetar`);
      assert.match(src, /location\.reload\(\)/);
    }
  });
});

describe('vakthunden laddar om vid blandade modulversioner', () => {
  const medLagring = (fn) => {
    const lager = new Map(); const fore = globalThis.sessionStorage;
    globalThis.sessionStorage = { getItem: (k) => lager.get(k) ?? null, setItem: (k, v) => lager.set(k, String(v)) };
    try { return fn(lager); } finally { if (fore === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = fore; }
  };

  test('känner igen länkfelet i Chrome och Safari — men inte vanliga fel', () => {
    const g = kor();
    const ar = g.__eskilArLankfel;
    assert.ok(ar("The requested module './store.js' does not provide an export named 'finnsPaServern'"), 'Chrome');
    assert.ok(ar("SyntaxError: Importing binding name 'medOmforsok' is not found."), 'Safari');
    assert.ok(!ar('TypeError: undefined is not a function'));
    assert.ok(!ar('Failed to get document because the client is offline.'));
    assert.ok(!ar(''));
  });

  test('laddar om EN gång — ett äkta syntaxfel får aldrig bli en loop', () => medLagring(() => {
    const g = kor();
    let omladdningar = 0;
    g.location.reload = () => { omladdningar++; };
    const fel = { message: "The requested module './utils.js' does not provide an export named 'medOmforsok'" };
    g._lyssnare.error(fel);
    g._lyssnare.error(fel);
    assert.equal(omladdningar, 1);
  }));

  test('går sessionStorage inte att skriva (privat läge) laddas inget om — då går spärren inte att hålla', () => {
    // Uttryckligen en lagring som KASTAR: nyare Node har en egen
    // sessionStorage, så "saknas" går inte att lita på i testmiljön.
    const fore = globalThis.sessionStorage;
    globalThis.sessionStorage = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
    try {
      const g = kor();
      let omladdningar = 0;
      g.location.reload = () => { omladdningar++; };
      g._lyssnare.error({ message: "does not provide an export named 'x'" });
      assert.equal(omladdningar, 0);
    } finally { if (fore === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = fore; }
  });

  test('en modul som inte gick att HÄMTA hamnar i den tekniska raden', () => {
    const g = kor();
    g._lyssnare.error({ target: { tagName: 'SCRIPT', src: 'https://eskilscout.se/js/report.js' } });
    g._brand();
    assert.match(g._root.innerHTML, /Kunde inte hämta report\.js/);
    assert.doesNotMatch(g._root.innerHTML, /inget fel — sidan väntade/);
  });
});
