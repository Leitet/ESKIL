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
