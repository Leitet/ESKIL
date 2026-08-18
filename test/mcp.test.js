// MCP-serverns redaktionslager. Ren logik, ingen emulator.
//
// Det här är testerna som gör integritetslöftet till något annat än en
// avsikt. Två fällor står i centrum:
//
//  1. Skrubbaren får inte äta upp KOORDINATER. Kontrollernas lat/lng skrivs
//     "56.6712" och måste vara läsbara — det är hela underlaget för att lägga
//     ut en bana. En telefonregex som slukar dem gör MCP:n oanvändbar.
//  2. Maskerarens STANDARD måste vara att dölja. Ett nytt fält i datamodellen
//     ska läcka åt den säkra sidan, inte den andra.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// functions/ är CommonJS (Node 20, "main": "index.js"), publikkoden är ESM.
const require = createRequire(import.meta.url);
const {
  skrubba, maskera, narvaro, OPPEN, DOLD, ALDRIG,
  TAVLING, KONTROLL, KONTROLL_META, PATRULL
} = require('../functions/mcp/redact.js');

describe('skrubba: telefonnummer', () => {
  const träffar = [
    '070-123 45 67',
    '0701234567',
    '+46 70 123 45 67',
    '0480-45 30 00',
    '0046701234567',
    '(070) 123 45 67',
    'Ring 0480-45 30 00 vid nödläge'
  ];
  for (const t of träffar) {
    test(`stryker "${t}"`, () => {
      const ut = skrubba(t);
      assert.ok(ut.includes('(telefonnummer borttaget)'), `${t} → ${ut}`);
      assert.ok(!/\d{7}/.test(ut.replace(/\D/g, '')), `siffror kvar i "${ut}"`);
    });
  }
});

describe('skrubba: KOORDINATER ska överleva', () => {
  // Det här är den viktigaste gruppen i filen. Går den sönder kan MCP:n inte
  // längre lägga ut en bana, och felet syns inte som ett fel — bara som att
  // modellen plötsligt inte hittar några positioner.
  const koordinater = [
    '56.6712, 16.3251',
    'Kontrollen ligger på 56.6712, 16.3251',
    'lat 56.671234 lng 16.325123',
    '59.3293, 18.0686',
    '-33.8688, 151.2093'
  ];
  for (const k of koordinater) {
    test(`rör inte "${k}"`, () => {
      assert.equal(skrubba(k), k);
    });
  }
});

describe('skrubba: det som INTE är telefonnummer', () => {
  const oskyldiga = [
    '2026-09-18',                       // datum
    'Kontroll 12',                      // kontrollnummer
    'max 25 poäng',                     // poäng
    'kl 09:30',                         // klockslag
    'Start 08:00, mål senast 16:00',
    'AH26-1234',                        // betalningsreferens
    '1000 meter till nästa kontroll'
  ];
  for (const o of oskyldiga) {
    test(`rör inte "${o}"`, () => {
      assert.equal(skrubba(o), o);
    });
  }
});

describe('skrubba: e-post', () => {
  test('stryker adressen men behåller texten runt', () => {
    const ut = skrubba('Hör av dig till anna.svensson@lindsdalsscoutkar.se om något händer.');
    assert.ok(ut.includes('(e-postadress borttagen)'));
    assert.ok(!ut.includes('@'));
    assert.ok(ut.startsWith('Hör av dig till'));
    assert.ok(ut.endsWith('om något händer.'));
  });

  test('flera adresser i samma text', () => {
    const ut = skrubba('a@b.se och c@d.nu');
    assert.equal(ut, '(e-postadress borttagen) och (e-postadress borttagen)');
  });
});

describe('skrubba: idempotens', () => {
  test('en skrubbad text ändras inte av ytterligare en runda', () => {
    // Markörerna innehåller inga siffror och matchas därför inte igen. Utan
    // den egenskapen hade texten muterats varje gång den passerade ut.
    const en = skrubba('Ring 070-123 45 67 eller mejla a@b.se');
    assert.equal(skrubba(en), en);
  });

  test('tomma och icke-strängar går igenom orörda', () => {
    assert.equal(skrubba(''), '');
    assert.equal(skrubba(null), null);
    assert.equal(skrubba(undefined), undefined);
    assert.equal(skrubba(42), 42);
  });
});

describe('narvaro', () => {
  test('skiljer ifyllt från saknas utan att avslöja värdet', () => {
    assert.equal(narvaro('070-1234567'), '(ifyllt)');
    assert.equal(narvaro(''), '(saknas)');
    assert.equal(narvaro(null), '(saknas)');
    assert.equal(narvaro(undefined), '(saknas)');
  });

  test('INGET ANTAL — en längd är ett orakel', () => {
    // E-postlistor dedupas skiftlägesokänsligt, så "listan växte" bekräftar
    // att den gissade adressen var ny. Med en gissning per anrop ÄR
    // bekräftelsen utläsningen. Därför är svaret binärt.
    const tre = narvaro([{ name: 'Anna' }, { name: 'Bo' }, { name: 'Cid' }]);
    const en = narvaro([{ name: 'Anna' }]);
    assert.equal(tre, '(ifyllt)');
    assert.equal(en, '(ifyllt)', 'en och tre poster måste se IDENTISKA ut');
    assert.equal(narvaro([]), '(saknas)');
    assert.ok(!/\d/.test(tre), `svaret bar en siffra: ${tre}`);
  });

  test('tomt objekt räknas som saknas', () => {
    assert.equal(narvaro({}), '(saknas)');
    assert.equal(narvaro({ epost: 'a@b.se' }), '(ifyllt)');
  });
});

describe('maskera', () => {
  test('öppna fält passerar, närvarofält döljs', () => {
    const ut = maskera({ name: 'Älghornsjakten 2026', date: '2026-09-18', adminEmails: ['a@b.se'] }, TAVLING);
    assert.equal(ut.name, 'Älghornsjakten 2026');
    assert.equal(ut.date, '2026-09-18');
    assert.equal(ut.adminEmails, '(ifyllt)');
    assert.ok(!JSON.stringify(ut).includes('a@b.se'), 'e-postadressen läckte');
  });

  test('management döljs helt — funktionärernas namn är inte MCP:ns sak', () => {
    const ut = maskera({
      name: 'Test',
      management: [{ label: 'Tävlingsledare', visibility: 'public',
                     name: 'Anna Svensson', email: 'anna@x.se', phone: '070-1234567' }]
    }, TAVLING);
    const json = JSON.stringify(ut);
    assert.ok(!json.includes('Anna'), 'ett personnamn läckte');
    assert.ok(!json.includes('anna@x.se'), 'en e-postadress läckte');
    assert.ok(!json.includes('070'), 'ett telefonnummer läckte');
    assert.equal(ut.management[0].label, 'Tävlingsledare', 'rollen är konfiguration och ska synas');
  });

  test('STANDARDEN är att dölja, inte att visa', () => {
    // Ett fält som inte står i klassificeringen måste bli närvaroredovisat.
    // Motsatsen betyder att varje nytt fält i datamodellen läcker tyst.
    const ut = maskera({ heltNyttFalt: 'hemlig@adress.se' }, TAVLING);
    assert.equal(ut.heltNyttFalt, '(ifyllt)');
    assert.ok(!JSON.stringify(ut).includes('hemlig@adress.se'));
  });

  test('ALDRIG tar bort nyckeln helt', () => {
    const KLASSER = { a: OPPEN, b: ALDRIG };
    const ut = maskera({ a: 1, b: 'nyckel' }, KLASSER);
    assert.equal(ut.a, 1);
    assert.ok(!('b' in ut), 'ALDRIG-fältet fanns kvar som nyckel');
  });

  test('öppna strängar skrubbas ändå — lager 2 ovanpå lager 1', () => {
    // Kontrollens NAMN är läsbart, men någon kan ha skrivit ett nummer i det.
    const ut = maskera({ name: 'Vindskyddet, ring 0480-45 30 00' }, KONTROLL);
    assert.ok(ut.name.includes('(telefonnummer borttaget)'));
    assert.ok(ut.name.startsWith('Vindskyddet'));
  });

  test('patrullnamn och kår är LÄSBARA — de publiceras redan på /t', () => {
    const ut = maskera({ name: 'Rävarna', kar: 'Lindsdals Scoutkår', contact: 'Anna Svensson' }, PATRULL);
    assert.equal(ut.name, 'Rävarna');
    assert.equal(ut.kar, 'Lindsdals Scoutkår');
    assert.equal(ut.contact, '(ifyllt)');
  });
});

describe('NÄSTLADE fält — de fem läckor som fanns när maskera() inte rekurserade', () => {
  // Var och en av de här kom ut i KLARTEXT ur den första versionen. De är
  // regressionstester för verkliga fel, inte hypoteser.

  test('registration.methods[].number — kassörens privata mobil', () => {
    const ut = maskera({
      registration: {
        enabled: true, price: 250,
        methods: [{ kind: 'swish', label: 'Swish', number: '070-123 45 67' }]
      }
    }, TAVLING);
    const json = JSON.stringify(ut);
    assert.ok(!json.includes('070'), `swishnummer i klartext: ${json}`);
    assert.equal(ut.registration.methods[0].number, '(ifyllt)');
    assert.equal(ut.registration.price, 250, 'priset ÄR konfiguration och ska synas');
  });

  test('utgatt.note — en hälsouppgift om ett barn', () => {
    const ut = maskera({
      name: 'Rävarna',
      utgatt: { at: '2026-09-18T12:00:00Z', note: 'Elsa svimmade, hämtad med ambulans' }
    }, PATRULL);
    const json = JSON.stringify(ut);
    assert.ok(!json.includes('Elsa'), `hälsouppgift i klartext: ${json}`);
    assert.ok(!json.includes('ambulans'));
    assert.equal(ut.utgatt.note, '(ifyllt)');
    assert.ok(ut.utgatt.at, 'tidpunkten är fakta om tävlingen och får synas');
  });

  test('places[].note — kontaktuppgifter till den som bemannar platsen', () => {
    const ut = maskera({
      places: [{ id: 'p1', kind: 'parkering', name: 'Parkering', lat: 56.6, lng: 16.3,
                 note: 'Markägare Nils 070-999 88 77' }]
    }, TAVLING);
    const json = JSON.stringify(ut);
    assert.ok(!json.includes('Nils'), `personnamn i klartext: ${json}`);
    assert.ok(!json.includes('070'));
    assert.equal(ut.places[0].name, 'Parkering', 'platsens namn är utmärkning och får synas');
    assert.equal(ut.places[0].lat, 56.6, 'koordinaten behövs för kartan');
  });

  test('startFinish.*.note', () => {
    const ut = maskera({
      startFinish: { start: { lat: 56.6, lng: 16.3, note: 'Ring Anna 070-1234567' } }
    }, TAVLING);
    assert.ok(!JSON.stringify(ut).includes('Anna'));
    assert.equal(ut.startFinish.start.lat, 56.6);
  });

  test('management[] — per UNDERFÄLT, inte hela arrayen', () => {
    // Rollstrukturen är konfiguration och ska synas; personen ska inte.
    // closeCompetition behåller exakt id/label/visibility/ekonomi, så gränsen
    // är redan dragen i produktkoden.
    const ut = maskera({
      management: [
        { id: 'r1', label: 'Tävlingsledare', visibility: 'public', ekonomi: false,
          name: 'Anna Svensson', phone: '070-1234567', email: 'anna@x.se' },
        { id: 'r2', label: 'Kassör', visibility: 'internal', ekonomi: true,
          name: 'Bo Berg', phone: '', email: 'bo@x.se' }
      ]
    }, TAVLING);
    const json = JSON.stringify(ut);
    for (const hemligt of ['Anna', 'Svensson', 'Bo Berg', '070', 'anna@x.se', 'bo@x.se']) {
      assert.ok(!json.includes(hemligt), `${hemligt} läckte: ${json}`);
    }
    assert.equal(ut.management[0].label, 'Tävlingsledare');
    assert.equal(ut.management[1].ekonomi, true);
    assert.equal(ut.management[1].phone, '(saknas)', 'tomt fält ska gå att skilja från ifyllt');
  });

  test('KONTROLL:s legacy-fält på det VÄRLDSLÄSBARA dokumentet är dolda', () => {
    // telefon, notering, ansvariga och ansvarigaEmails lever kvar här; reglerna
    // läser fortfarande en union av båda platserna.
    const ut = maskera({
      nummer: 4, name: 'Vindskyddet', lat: 56.6, lng: 16.3, maxPoang: 25,
      telefon: '070-1234567', notering: 'Bemannas av Anna',
      ansvariga: [{ name: 'Anna', email: 'a@b.se' }], ansvarigaEmails: ['a@b.se']
    }, KONTROLL);
    const json = JSON.stringify(ut);
    for (const hemligt of ['070', 'Anna', 'a@b.se']) {
      assert.ok(!json.includes(hemligt), `${hemligt} läckte: ${json}`);
    }
    assert.equal(ut.nummer, 4);
    assert.equal(ut.maxPoang, 25);
  });

  test('threadToken försvinner HELT — nyckeln är en fungerande fältlänk', () => {
    const ut = maskera({ welcomed: ['a@b.se'], threadToken: 'hemlig-token-123' }, KONTROLL_META);
    assert.ok(!('threadToken' in ut), 'nyckeln fanns kvar som fält');
    assert.ok(!JSON.stringify(ut).includes('hemlig-token'));
    assert.equal(ut.welcomed, '(ifyllt)', 'welcomed är en e-postlista');
  });

  test('ett objekt som av misstag klassas OPPEN maskeras ändå', () => {
    // Skyddsnät mot fel i klasslistan: ett OPPEN på ett objekt får inte
    // släppa igenom barnen.
    const ut = maskera({ x: { hemlig: 'a@b.se' } }, { x: OPPEN });
    assert.equal(ut.x, '(ifyllt)');
    assert.ok(!JSON.stringify(ut).includes('a@b.se'));
  });
});

describe('delaLedning (functions, CJS) och splitManagement (public, ESM)', () => {
  // Den ENDA dubbletten i hela flytten, och den är medveten: functions är
  // CommonJS, publikkoden är ES-moduler. Testet är priset — det bevisar att de
  // två är överens, så att en ändring i den ena inte kan glida isär från den
  // andra tyst.
  const { delaLedning } = require('../functions/mcp/ledning.js');

  const FALL = [
    [],
    null,
    [{ id: 'a', label: 'Ledare', visibility: 'public', name: 'Anna', phone: '070-1', email: 'a@b.se' }],
    [{ id: 'b', label: 'Sekretariat', visibility: 'internal', name: 'Bo', phone: '070-2', email: '' }],
    [{ id: 'c', label: 'Kassör', visibility: 'internal', ekonomi: true, name: '', phone: '', email: '' }],
    [{ label: 'Utan id', visibility: 'internal', name: 'X' }],
    [{ id: 'd', label: 'Blandat', visibility: 'internal', name: '  Cecilia  ', phone: ' 070-3 ', email: '' },
     { id: 'e', label: 'Publik', name: 'Erik', phone: '', email: 'e@f.se' }]
  ];

  test('samma utfall för varje indata', async () => {
    const { splitManagement } = await import('../public/js/utils.js');
    for (const fall of FALL) {
      const cjs = delaLedning(fall);
      const esm = splitManagement(fall);
      assert.deepEqual(cjs, esm, `divergerar för ${JSON.stringify(fall)}`);
    }
  });
});

describe('verktygsytan', () => {
  const v = require('../functions/mcp/verktyg.js');
  const namn = v.VERKTYG.map(x => x.namn);

  test('inga förbjudna verktyg finns', () => {
    // Var och en av de här skulle vara en fullständig läcka. Listan står i
    // filhuvudet till verktyg.js med skälen.
    const förbjudna = [
      'backup', 'export', 'import', 'dump',
      'pdf', 'qr', 'utskick', 'broadcast',
      'anmalan', 'registration', 'komplettering',
      'papperskorg', 'logg', 'thread', 'trad', 'meddelande',
      'ansvarig', 'station', 'radera_tavling', 'avsluta'
    ];
    for (const n of namn) {
      for (const f of förbjudna) {
        assert.ok(!n.toLowerCase().includes(f),
          `verktyget "${n}" ser ut att röra en förbjuden yta ("${f}")`);
      }
    }
  });

  test('inget verktyg tar ett fritt fältnamn, filter eller sortering', () => {
    // where('contact.email','>=',x).limit(1) är binärsökning tecken för tecken.
    const farliga = ['falt', 'field', 'filter', 'sok', 'query', 'where', 'operator', 'sortera', 'orderby', 'path', 'sokvag'];
    for (const verk of v.VERKTYG) {
      const nycklar = Object.keys(verk.schema.properties || {});
      for (const k of nycklar) {
        assert.ok(!farliga.includes(k.toLowerCase()),
          `${verk.namn} tar argumentet "${k}" — ett fritt fältnamn eller filter`);
      }
    }
  });

  test('alla scheman är stängda (additionalProperties: false)', () => {
    // Ett öppet schema låter modellen skicka fält som kontrollera() aldrig ser.
    for (const verk of v.VERKTYG) {
      assert.equal(verk.schema.additionalProperties, false,
        `${verk.namn} har ett öppet schema`);
    }
  });

  test('kontrollera() avvisar fält utanför listan', () => {
    assert.throws(() => v.kontrollera({ demo: true }, { name: 'str' }, 'tävlingen'),
      /går inte att sätta/);
    assert.throws(() => v.kontrollera({ closed: true }, { name: 'str' }, 'tävlingen'));
    assert.throws(() => v.kontrollera({ slug: 'x' }, { name: 'str' }, 'tävlingen'));
    assert.throws(() => v.kontrollera({ lastBackupAt: 'x' }, { name: 'str' }, 'tävlingen'));
  });

  test('tavling_uppdatera kan INTE sätta demo, closed, slug eller lastBackupAt', () => {
    // demo: true öppnar fem läsgrenar i reglerna för hela internet, och
    // "sätt upp ett demo av tävlingen" låter som konfiguration.
    const p = v.VERKTYG.find(x => x.namn === 'tavling_uppdatera').schema.properties;
    for (const spärrat of ['demo', 'closed', 'slug', 'lastBackupAt', 'admins', 'createdBy', 'imported']) {
      assert.ok(!(spärrat in p), `${spärrat} går att sätta via MCP`);
    }
  });

  test('varje verktyg har en beskrivning som modellen kan agera på', () => {
    for (const verk of v.VERKTYG) {
      assert.ok(verk.beskrivning && verk.beskrivning.length > 20, `${verk.namn} saknar beskrivning`);
    }
  });

  test('instruktionerna säger rakt ut vad som INTE går att läsa', () => {
    // Utan det försöker modellen om och om igen, och kårledaren tror att något
    // är sönder.
    const i = v.INSTRUKTIONER;
    assert.ok(/telefonnummer/i.test(i) && /e-postadress/i.test(i));
    assert.ok(/\(ifyllt\)/.test(i), 'nämner inte det faktiska svaret');
    assert.ok(/patrullnamn/i.test(i), 'säger inte vad som ÄR läsbart');
  });
});

describe('klasslistan mot SKRIVKODEN — vakten mot listor skrivna ur minnet', () => {
  // Första versionen av redact.js klassade `place`, `maxPoints`, `namn` och
  // `ikon` — fält som inte finns. Allt föll åt säkra sidan, men bara av tur,
  // och felet syns bara som att modellen "inte hittar" något. Frestelsen blir
  // då att vidga OPPEN i stället för att härleda om listan.
  //
  // Testet läser fältnamnen ur den KOD SOM SKRIVER dem och kräver att var och
  // en har en klass. Det faller när någon lägger till ett fält utan att
  // bestämma om det är läsbart.
  const { readFileSync } = require('node:fs');
  const { KONTROLL, PATRULL, TAVLING } = require('../functions/mcp/redact.js');

  const las = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');

  test('kontrollens fält i copyCompetition har alla en klass', () => {
    // store.js kopierar kontrollen fält för fält vid årgångskopiering — den
    // listan ÄR kontrollens form.
    const src = las('store.js');
    const block = src.slice(src.indexOf('nummer: c.nummer'), src.indexOf('nummer: c.nummer') + 500);
    const falt = [...block.matchAll(/^\s{8}([a-zA-Z]+):/gm)].map(m => m[1]);
    assert.ok(falt.length >= 5, `hittade bara ${falt.length} fält — har koden ändrats?`);
    for (const f of falt) {
      assert.ok(f in KONTROLL, `kontrollfältet "${f}" saknar klass i redact.js`);
    }
  });

  test('patrullformulärets fält har alla en klass', () => {
    const src = las('views/patrols.js');
    const i = src.indexOf('number: overlay.querySelector');
    const falt = [...src.slice(i, i + 600).matchAll(/^\s+([a-zA-Z]+):\s*overlay/gm)].map(m => m[1]);
    assert.ok(falt.length >= 4, `hittade bara ${falt.length} fält`);
    for (const f of falt) {
      assert.ok(f in PATRULL, `patrullfältet "${f}" saknar klass i redact.js`);
    }
  });

  test('de tre fält som föll till default-deny är nu klassade', () => {
    // Hittade genom att jämföra klasslistan mot VERKLIGT data i emulatorn.
    assert.equal(KONTROLL.extraPoang, 'oppen');
    assert.equal(PATRULL.number, 'oppen');
    assert.equal(PATRULL.antal, 'oppen');
  });

  test('och de PII-bärande fälten är fortfarande dolda', () => {
    // Vaktar mot att vidgningen ovan svepte med något den inte skulle.
    for (const f of ['telefon', 'notering', 'ansvariga', 'ansvarigaEmails']) {
      assert.equal(KONTROLL[f], 'dold', `${f} blev läsbar`);
    }
    for (const f of ['contact', 'members', 'epost', 'telefon', 'notering']) {
      assert.equal(PATRULL[f], 'dold', `${f} blev läsbar`);
    }
    assert.equal(TAVLING.generalInfo, 'dold');
  });
});

describe('FYNDEN från den fientliga granskningen', () => {
  const v = require('../functions/mcp/verktyg.js');
  const { maskera, skrubba, TAVLING } = require('../functions/mcp/redact.js');

  describe('1. schemat valideras serversidan', () => {
    // Roten till det värsta fyndet: anropaVerktyg körde kor() utan att läsa
    // inputSchema, så ledning_satt med arguments:{} gav isError:false och
    // RADERADE hela tävlingsledningen inklusive nödnumren i fältet.
    const led = v.VERKTYG.find(x => x.namn === 'ledning_satt');

    test('required krävs på riktigt', () => {
      assert.throws(() => v.validera(led.schema, {}), /roller krävs/);
    });

    test('en roll utan visibility avvisas', () => {
      // Utelämnad visibility blev PUBLIC, och namn/telefon/e-post hamnade på
      // det världsläsbara tävlingsdokumentet. Läst anonymt i granskningen.
      assert.throws(
        () => v.validera(led.schema, { roller: [{ label: 'Sekretariat', name: 'Bo', phone: '070-1' }] }),
        /visibility krävs/);
    });

    test('enum hålls', () => {
      assert.throws(
        () => v.validera(led.schema, { roller: [{ label: 'X', visibility: 'kanske' }] }),
        /måste vara ett av/);
    });

    test('fel typ avvisas', () => {
      const k = v.VERKTYG.find(x => x.namn === 'kontroll_skapa');
      assert.throws(() => v.validera(k.schema, { nummer: { a: 1 }, name: 'X' }), /måste vara ett tal/);
      assert.throws(() => v.validera(k.schema, { nummer: 1, name: 42 }), /måste vara text/);
    });

    test('okänt fält avvisas', () => {
      const k = v.VERKTYG.find(x => x.namn === 'kontroll_skapa');
      assert.throws(() => v.validera(k.schema, { nummer: 1, name: 'X', demo: true }),
        /inte ett giltigt fält/);
    });

    test('prototypnycklar räknas inte som angivna', () => {
      // {"constructor": …} ska inte kunna se ut att uppfylla required.
      assert.throws(() => v.validera({ type: 'object', required: ['x'], properties: {} }, {}),
        /x krävs/);
      assert.throws(() => v.kontrollera({ constructor: 'x' }, { name: 'str' }, 'y'),
        /går inte att sätta/);
    });
  });

  describe('2. ledning_satt är ADDITIV', () => {
    const led = v.VERKTYG.find(x => x.namn === 'ledning_satt');
    test('ta_bort finns och är enda vägen att ta bort en roll', () => {
      assert.ok('ta_bort' in led.schema.properties, 'ingen uttrycklig borttagningsväg');
    });
    test('beskrivningen säger att den är additiv', () => {
      assert.match(led.beskrivning, /ADDITIVT/);
    });

    test('visibility public går INTE via MCP alls', () => {
      // Det avgörande fyndet i omgranskningen: ett anrop med bara
      // {id,label,visibility:"public"} återfuktade den karantänsatta PII:n ur
      // private/ledning och kopierade den till det VÄRLDSLÄSBARA
      // tävlingsdokumentet — läst tillbaka utan auth-header, medan svaret sa
      // "(ifyllt)" så varken modellen eller en människa i samtalet såg vad som
      // gick ut. Skrivrättighet blev alltså UTLÄMNANDE av data modellen inte
      // får läsa. Enum:en är enda platsen där det stoppas strukturellt.
      const vis = led.schema.properties.roller.items.properties.visibility;
      assert.deepEqual(vis.enum, ['internal'],
        'public är tillåtet igen — då kan MCP publicera PII till internet');
      assert.throws(
        () => v.validera(led.schema, { roller: [{ label: 'X', visibility: 'public' }] }),
        /måste vara ett av/);
      assert.match(led.beskrivning, /i ESKIL/, 'säger inte vart människan ska gå i stället');
    });

    test('publicScores, publicControls och anonymousControls är inte skrivbara', () => {
      // Avklassificering är publicering: en medvetet dold tävling gick att
      // avslöja i ett enda ogrindat anrop.
      const p2 = v.VERKTYG.find(x => x.namn === 'tavling_uppdatera').schema.properties;
      for (const f of ['publicScores', 'publicControls', 'anonymousControls']) {
        assert.ok(!(f in p2), `${f} går att ändra via MCP`);
      }
    });
  });

  describe('3. skrubbaren tar flera skrivformer', () => {
    const laecker = [
      ['070–111 22 33', 'tankstreck (Word/iOS autokorrigerar hit)'],
      ['070.444.55.66', 'punkt'],
      ['070/111 22 33', 'snedstreck (svensk växelform)'],
      ['070 111 22 33', 'hårda mellanslag'],
      ['anna (at) lindsdal.se', 'obfuskerad e-post'],
      ['bo [at] kar [dot] se', 'obfuskerad e-post, hakparenteser']
    ];
    for (const [t, vad] of laecker) {
      test(`stryker ${vad}`, () => {
        const u = skrubba(t);
        assert.notEqual(u, t, `${vad} gick rakt igenom: ${u}`);
        assert.ok(!/\d{7}/.test(u.replace(/\D/g, '')) || !u.includes('@'), u);
      });
    }
    test('KOORDINATER överlever fortfarande', () => {
      // Den viktigaste raden i filen. Går den sönder kan MCP:n inte lägga ut
      // en bana, och felet syns inte som ett fel.
      for (const k of ['56.6712, 16.3251', '59.3293, 18.0686', 'lat 56.671234 lng 16.325123']) {
        assert.equal(skrubba(k), k, `koordinaten åts upp: ${k}`);
      }
    });
    test('datum och klockslag rörs inte', () => {
      assert.equal(skrubba('2026-09-18'), '2026-09-18');
      assert.equal(skrubba('kl 09:30'), 'kl 09:30');
    });
  });

  describe('4. maskera() faller STÄNGT vid typkrock', () => {
    // Klassen är en underlista men värdet är en sträng — maskera() returnerade
    // då värdet självt. Mätt: startFinish som sträng gav "Nils Nilsson".
    const fall = [
      ['startFinish', 'Nils Nilsson 070-1234567'],
      ['registration', 'swish 123 456 78 90'],
      ['places', 'Markägare Nils 070-999'],
      ['management', 'Anna Svensson']
    ];
    for (const [falt, varde] of fall) {
      test(`${falt} som sträng ger (ifyllt)`, () => {
        const ut = maskera({ [falt]: varde }, TAVLING);
        assert.equal(ut[falt], '(ifyllt)', `${falt} läckte: ${JSON.stringify(ut[falt])}`);
      });
      test(`${falt} som array av strängar ger (ifyllt)`, () => {
        const ut = maskera({ [falt]: [varde] }, TAVLING);
        assert.ok(!JSON.stringify(ut).includes('Nils') && !JSON.stringify(ut).includes('Anna')
          && !JSON.stringify(ut).includes('123 456'), JSON.stringify(ut));
      });
    }
  });

  describe('5. säkerhetsgrindar går inte att stänga via MCP', () => {
    test('fieldMessaging, selfStart och selfFinish är inte skrivbara', () => {
      // fieldMessaging av tar bort fältets ENDA kanal till ledningen — samma
      // kanal som nödropet går i.
      const p = v.VERKTYG.find(x => x.namn === 'tavling_uppdatera').schema.properties;
      for (const grind of ['fieldMessaging', 'selfStart', 'selfFinish']) {
        assert.ok(!(grind in p), `${grind} går att ändra via MCP`);
      }
    });
  });

  describe('6. startFinish-nyckeln matchar datamodellen', () => {
    test('finish, inte mal', () => {
      assert.ok('finish' in TAVLING.startFinish, 'målpunkten är oläsbar — fel nyckelnamn');
      assert.ok(!('mal' in TAVLING.startFinish));
      assert.equal(TAVLING.startFinish.finish.lat, 'oppen');
    });
  });
});

describe('OMGRANSKNINGENS fynd', () => {
  const v = require('../functions/mcp/verktyg.js');
  const { skrubba } = require('../functions/mcp/redact.js');

  test('längdtak: en description som murar servern avvisas', () => {
    // skrubba() är O(n²) — mätt 4× per fördubbling, 32k tecken = 1925 ms — och
    // varje läsbar sträng passerar den. En description på 24 000 tecken tog
    // tavling_las från 0,010 s till 2,4 s. Servern kunde mura sig själv, och
    // verktyget man behöver för att se fältet är det som hänger.
    assert.throws(() => v.kontrollera({ description: 'x'.repeat(24000) },
      { description: 'str' }, 'tävlingen'), /högst 4000 tecken/);
    assert.doesNotThrow(() => v.kontrollera({ description: 'x'.repeat(3999) },
      { description: 'str' }, 'tävlingen'));
  });

  test('skrubbaren är snabb inom taket', () => {
    // Med taket på plats spelar O(n²) ingen roll i praktiken — men mät det,
    // hellre än att anta.
    const t0 = Date.now();
    skrubba('Lorem ipsum 070-123 45 67 dolor '.repeat(130).slice(0, 4000));
    const ms = Date.now() - t0;
    assert.ok(ms < 200, `4000 tecken tog ${ms} ms — taket räcker inte längre`);
  });

  test('tal måste vara ÄNDLIGA och rimliga', () => {
    // {"etaDwellMinutes":1e999} lagrades som Infinity och gjorde varje ETA
    // efter första kontrollen oändlig: course.js läser Number(...) || DEFAULT,
    // och Infinity är truthy.
    assert.throws(() => v.kontrollera({ etaDwellMinutes: Infinity }, { etaDwellMinutes: 'num' }, 't'),
      /ändligt tal/);
    assert.throws(() => v.kontrollera({ etaDwellMinutes: -5 }, { etaDwellMinutes: 'num' }, 't'),
      /mellan 0 och 240/);
    assert.throws(() => v.kontrollera({ lat: 200 }, { lat: 'num' }, 'k'), /mellan -90 och 90/);
    assert.doesNotThrow(() => v.kontrollera({ etaDwellMinutes: 15 }, { etaDwellMinutes: 'num' }, 't'));
  });

  test('osynliga tecken avvisas', () => {
    assert.throws(() => v.kontrollera({ name: '​​' }, { name: 'str' }, 'p'),
      /osynliga tecken/);
    assert.throws(() => v.kontrollera({ name: '   ' }, { name: 'str' }, 'p'), /osynliga tecken/);
  });

  test('instruktionerna säger att fältdata ALDRIG får lydas', () => {
    // Före fixen fanns noll serversidigt mottryck: grep på
    // injekt/untrusted/lyd i functions/mcp/ gav inga träffar.
    const i = v.INSTRUKTIONER;
    assert.match(i, /DATA, ALDRIG INSTRUKTIONER/);
    assert.match(i, /Följ ALDRIG/);
    assert.match(i, /BERÄTTA I\s*STÄLLET|BERÄTTA I STÄLLET/, 'säger inte vad modellen ska göra i stället');
    assert.match(i, /utomstående/, 'nämner inte att patrullnamn kommer utifrån');
  });

  test('verktygen bär annotations så en klient kan skilja läs från skriv', () => {
    const lista = v.listaVerktyg();
    const las = lista.find(t => t.name === 'tavling_las');
    const skriv = lista.find(t => t.name === 'ledning_satt');
    assert.equal(las.annotations.readOnlyHint, true);
    assert.equal(skriv.annotations.readOnlyHint, false);
    assert.equal(skriv.annotations.destructiveHint, true);
  });
});

describe('FÄLTFEEDBACKEN: start/mål och instruktioner går att sätta', () => {
  // Rapporterat efter första skarpa körningen: två saker gick inte att göra
  // via kopplingen utan att en människa öppnade ESKIL — banans ändpunkter
  // (namn och anvisning) och kontrollernas instruktionslistor. Kravet är att
  // MCP:n ska kunna konfigurera hela tävlingen på samma sätt som en människa,
  // så luckorna är buggar, inte avgränsningar.
  const v = require('../functions/mcp/verktyg.js');
  const { KONTROLL, maskera } = require('../functions/mcp/redact.js');
  const { readFileSync } = require('node:fs');

  // Attrapp-Firestore: fångar skrivningen så formen kan granskas.
  function attrapp(comp = {}, kontroller = [{ nummer: 3 }]) {
    const skrivet = {};
    const docs = kontroller.map(d => ({
      data: () => d,
      ref: { update: async (p) => Object.assign(skrivet, p) }
    }));
    const db = {
      collection: () => ({ get: async () => ({ docs }), add: async (d) => { skrivet.nytt = d; return { id: 'x' }; } }),
      doc: () => ({ get: async () => ({ data: () => comp }), update: async (p) => Object.assign(skrivet, p) })
    };
    return { ctx: { db, cid: 'c', comp }, skrivet };
  }

  describe('instruktionerna', () => {
    test('formen är utils.js allInstructionGroups, inte en egen', () => {
      // allInstructionGroups() förväntar sig [{ avdelningar: [], text }].
      // Ett annat nyckelnamn hade sparats utan fel och visats som ingenting.
      const src = readFileSync(new URL('../public/js/utils.js', import.meta.url), 'utf8');
      assert.match(src, /avdelningar: \[\], text: control\.information/,
        'utils.js har ändrat form — MCP-verktyget skriver då fel nycklar');
    });

    test('grupperna skrivs till instructions', async () => {
      const { ctx, skrivet } = attrapp();
      const svar = await v.anropaVerktyg('kontroll_instruktioner_satt',
        { nummer: 3, grupper: [{ avdelningar: ['Spårare'], text: 'Slå en råbandsknop' },
                               { text: 'Slå en pålstek' }] }, ctx);
      assert.equal(svar.isError, undefined);
      assert.deepEqual(skrivet.instructions, [
        { avdelningar: ['Spårare'], text: 'Slå en råbandsknop' },
        { avdelningar: [], text: 'Slå en pålstek' }
      ]);
    });

    test('samma avdelning i två grupper avvisas', async () => {
      // Visningen tar första träffen, så den andra instruktionen hade tyst
      // aldrig nått fram till kontrollanten.
      const { ctx } = attrapp();
      const svar = await v.anropaVerktyg('kontroll_instruktioner_satt',
        { nummer: 3, grupper: [{ avdelningar: ['Rover'], text: 'A' }, { avdelningar: ['Rover'], text: 'B' }] }, ctx);
      assert.equal(svar.isError, true);
      assert.match(svar.text, /Rover står i två grupper/);
    });

    test('en avdelning som inte finns avvisas av schemat', async () => {
      const { ctx } = attrapp();
      const svar = await v.anropaVerktyg('kontroll_instruktioner_satt',
        { nummer: 3, grupper: [{ avdelningar: ['Björnar'], text: 'A' }] }, ctx);
      assert.equal(svar.isError, true);
    });

    test('en avdelning som inte deltar i TÄVLINGEN avvisas', async () => {
      // comp.avdelningar begränsar vilka som deltar (utils.allowedAvdelningar).
      // En instruktion till en avdelning utanför listan visas för ingen.
      const { ctx } = attrapp({ avdelningar: ['Spårare', 'Upptäckare'] });
      const svar = await v.anropaVerktyg('kontroll_instruktioner_satt',
        { nummer: 3, grupper: [{ avdelningar: ['Rover'], text: 'A' }] }, ctx);
      assert.equal(svar.isError, true);
      assert.match(svar.text, /deltar inte i den här tävlingen/);
    });

    test('kontroll_skapa tar instruktionerna direkt', async () => {
      const { ctx, skrivet } = attrapp({}, []);
      await v.anropaVerktyg('kontroll_skapa',
        { nummer: 7, name: 'Knopar', instruktioner: [{ text: 'Slå en knop' }] }, ctx);
      assert.deepEqual(skrivet.nytt.instructions, [{ avdelningar: [], text: 'Slå en knop' }]);
      assert.equal(skrivet.nytt.open, false, 'en ny kontroll ska inte vara öppen direkt');
    });

    test('avdelningarna i MCP:ns lista är exakt utils.js AVDELNINGAR', () => {
      // Listan är hårdkodad i CJS-koden (utils.js är ESM). Ett namn som glider
      // isär ger en enum som avvisar giltiga avdelningar, eller tvärtom.
      const src = readFileSync(new URL('../public/js/utils.js', import.meta.url), 'utf8');
      const block = src.slice(src.indexOf('export const AVDELNINGAR'), src.indexOf('// --- Permissions'));
      const iUtils = [...block.matchAll(/key:\s*'([^']+)'/g)].map(m => m[1]);
      const schema = v.listaVerktyg().find(t => t.name === 'kontroll_instruktioner_satt');
      const iMcp = schema.inputSchema.properties.grupper.items.properties.avdelningar.items.enum;
      assert.deepEqual(iMcp, iUtils);
    });

    test('avdelningarna går att LÄSA tillbaka, inte bara "(ifyllt)"', () => {
      // De föll förut på default-deny: avdelningsnamn är sluten värdemängd och
      // ingen personuppgift, men utan klass kunde modellen inte se VEM en
      // instruktion gällde. En array är ett objekt, så klassen OPPEN räckte
      // inte — den fastnade på objektvakten.
      const ut = maskera({ instructions: [{ avdelningar: ['Spårare'], text: 'A' }] }, KONTROLL);
      assert.deepEqual(ut.instructions[0].avdelningar, ['Spårare']);
    });

    test('men en avdelningslista som INTE är en lista faller åt säkra sidan', () => {
      const ut = maskera({ instructions: [{ avdelningar: 'Bo Ek 070-123 45 67', text: 'A' }] }, KONTROLL);
      assert.equal(ut.instructions[0].avdelningar, '(ifyllt)');
    });
  });

  describe('start och mål', () => {
    test('formen är den controls.js skriver', async () => {
      const { ctx, skrivet } = attrapp();
      await v.anropaVerktyg('start_mal_satt',
        { start: { name: 'Klubbstugan', lat: 56.7, lng: 16.3, note: 'Skylt vid vägen' } }, ctx);
      assert.deepEqual(skrivet.startFinish, {
        enabled: true, mode: 'same',
        start: { name: 'Klubbstugan', lat: 56.7, lng: 16.3, note: 'Skylt vid vägen' }
      });
    });

    test('anvisningen kan sättas men inte läsas tillbaka', async () => {
      // note är fritext och placeholdern bjuder in till "ring X på 070-…".
      const { ctx } = attrapp();
      const svar = await v.anropaVerktyg('start_mal_satt',
        { start: { name: 'Klubbstugan', lat: 56.7, lng: 16.3, note: 'Ring Bo 070-123 45 67' } }, ctx);
      assert.match(svar.text, /"anvisning": "\(ifyllt\)"/);
      assert.doesNotMatch(svar.text, /070/);
      assert.doesNotMatch(svar.text, /Bo/);
    });

    test('ett målpunkt utan koordinater avvisas i stället för att bli osynlig', async () => {
      // startFinishPoints kräver ändliga lat/lng på BÅDA i läget separate —
      // annars faller den tillbaka på en gemensam S/M-nål och målet blir
      // liggande data ingen ser.
      const { ctx } = attrapp({ startFinish: { enabled: true, start: { name: 'S', lat: 56.7, lng: 16.3 } } });
      const svar = await v.anropaVerktyg('start_mal_satt', { finish: { name: 'Ängen' } }, ctx);
      assert.equal(svar.isError, true);
      assert.match(svar.text, /koordinater/);
    });

    test('att skriva ett mål sätter läget separate automatiskt', async () => {
      const { ctx, skrivet } = attrapp({ startFinish: { enabled: true, mode: 'same', start: { name: 'S', lat: 56.7, lng: 16.3 } } });
      await v.anropaVerktyg('start_mal_satt', { finish: { name: 'Ängen', lat: 56.71, lng: 16.31 } }, ctx);
      assert.equal(skrivet.startFinish.mode, 'separate');
      assert.equal(skrivet.startFinish.start.name, 'S', 'starten skrevs över');
    });

    test('mode "same" plockar bort målpunkten, precis som knappen i ESKIL', async () => {
      const { ctx, skrivet } = attrapp({ startFinish: { enabled: true, mode: 'separate',
        start: { name: 'S', lat: 56.7, lng: 16.3 }, finish: { name: 'M', lat: 56.71, lng: 16.31 } } });
      await v.anropaVerktyg('start_mal_satt', { mode: 'same' }, ctx);
      assert.equal(skrivet.startFinish.mode, 'same');
      assert.equal(skrivet.startFinish.finish, null);
    });

    test('start utan koordinater avvisas — namnet ensamt syns ingenstans', async () => {
      const { ctx } = attrapp();
      const svar = await v.anropaVerktyg('start_mal_satt', { start: { name: 'Klubbstugan' } }, ctx);
      assert.equal(svar.isError, true);
    });

    test('koordinaterna kontrolleras som alla andra tal', async () => {
      const { ctx } = attrapp();
      const svar = await v.anropaVerktyg('start_mal_satt', { start: { lat: 1e999, lng: 16.3 } }, ctx);
      assert.equal(svar.isError, true);
    });
  });
});
