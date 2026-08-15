// Säkerhetsreglerna — den del av ESKIL som tyst kan gå sönder.
//
// Fältsidorna är anonyma och skriver direkt mot Firestore, så reglerna ÄR
// åtkomstkontrollen. Två gånger har samma fälla slagit till i produktion: en
// direktläsning av ett saknat fält (`demo`) är ett evaluation ERROR som nekar
// skrivningen — först för poängrapportering, sedan för tävlingsskapande.
// Därav testerna "saknat demo-fält" nedan.
//
// Kräver igång-varande emulator (se helpers.js).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { seed, write, read, list, remove, uniq, emulatorRunning } from './helpers.js';

const SUPER = { uid: uniq('uid-super'), email: 'super@test.se' };
const USER = { uid: uniq('uid-user'), email: 'user@test.se' };
const OTHER = { uid: uniq('uid-other'), email: 'other@test.se' };
const CID = uniq('comp');
const CTRL = uniq('ctrl');
const PATROL = uniq('patrol');
const STATION = uniq('station');

const allow = (r, what) => assert.equal(r.ok, true, `${what} skulle TILLÅTAS (fick ${r.status})`);
const deny = (r, what) => assert.equal(r.ok, false, `${what} skulle NEKAS (men tilläts)`);

before(async () => {
  assert.ok(await emulatorRunning(),
    'Firestore-emulatorn svarar inte — starta den först (se scripts/test.sh).');

  await seed(`users/${SUPER.uid}`, { email: SUPER.email, role: 'super-admin' });
  await seed(`users/${USER.uid}`, { email: USER.email, role: 'user' });
  await seed(`users/${OTHER.uid}`, { email: OTHER.email, role: 'user' });

  await seed(`competitions/${CID}`, {
    name: 'Testtävling', shortName: 'TT', year: 2026, admins: [], demo: false, closed: false
  });
  await seed(`competitions/${CID}/private/access`, { adminEmails: [USER.email], userEmails: [] });
  await seed(`competitions/${CID}/patrols/${PATROL}`, { name: 'Rävarna', number: 1 });
  await seed(`competitions/${CID}/controls/${CTRL}`, {
    name: 'Knopar', nummer: 1, open: true, minPoang: 0, maxPoang: 10, extraPoang: 2
  });
  await seed(`competitions/${CID}/stations/${STATION}`, { name: 'Start/Mål' });
});

after(async () => {
  for (const p of [
    `competitions/${CID}/controls/${CTRL}`, `competitions/${CID}/patrols/${PATROL}`,
    `competitions/${CID}/stations/${STATION}`, `competitions/${CID}/private/access`,
    `competitions/${CID}`,
    `users/${SUPER.uid}`, `users/${USER.uid}`, `users/${OTHER.uid}`
  ]) await remove(p, 'owner');
});

describe('Poängrapportering (anonym)', () => {
  const scorePath = `competitions/${CID}/controls/${CTRL}/scores/${PATROL}`;

  test('anonym får rapportera på öppen kontroll', async () => {
    allow(await write(scorePath, { patrolId: PATROL, poang: 7 }, null), 'anonym poäng');
  });

  test('dokument-id måste vara patrullens id', async () => {
    deny(await write(`competitions/${CID}/controls/${CTRL}/scores/fel-id`,
      { patrolId: PATROL, poang: 7 }, null), 'poäng på fel doc-id');
  });

  test('poäng utanför kontrollens intervall nekas', async () => {
    deny(await write(scorePath, { patrolId: PATROL, poang: 99 }, null), 'poäng över max');
    deny(await write(scorePath, { patrolId: PATROL, poang: -1 }, null), 'poäng under min');
  });

  test('okända fält nekas', async () => {
    deny(await write(scorePath, { patrolId: PATROL, poang: 5, hittepa: 'x' }, null), 'okänt fält');
  });

  test('clientReportedAt tillåts (passagetiden)', async () => {
    allow(await write(scorePath,
      { patrolId: PATROL, poang: 5, clientReportedAt: new Date() }, null), 'klienttid');
  });

  test('stängd kontroll nekar anonym rapport', async () => {
    await seed(`competitions/${CID}/controls/${CTRL}`, { open: false });
    deny(await write(scorePath, { patrolId: PATROL, poang: 5 }, null), 'poäng på stängd kontroll');
    await seed(`competitions/${CID}/controls/${CTRL}`, { open: true });
  });

  test('REGRESSION: tävling UTAN demo-fält blockerar inte rapportering', async () => {
    // Fällan som en gång stoppade all rapportering: compIsDemo() läste
    // `demo` direkt i stället för med .get(default).
    const bare = uniq('bare');
    await seed(`competitions/${bare}`, { name: 'Utan demo-fält' });
    await seed(`competitions/${bare}/patrols/${PATROL}`, { name: 'P', number: 1 });
    await seed(`competitions/${bare}/controls/${CTRL}`,
      { name: 'K', nummer: 1, open: true, minPoang: 0, maxPoang: 10 });
    allow(await write(`competitions/${bare}/controls/${CTRL}/scores/${PATROL}`,
      { patrolId: PATROL, poang: 5 }, null), 'poäng på tävling utan demo-fält');
    for (const p of [`competitions/${bare}/controls/${CTRL}/scores/${PATROL}`,
      `competitions/${bare}/controls/${CTRL}`, `competitions/${bare}/patrols/${PATROL}`,
      `competitions/${bare}`]) await remove(p, 'owner');
  });
});

describe('Tävlingar — vem får skapa', () => {
  test('REGRESSION: vanlig användare nekas skapa fritt', async () => {
    deny(await write(`competitions/${uniq('x')}`, { name: 'Egen tävling' }, USER),
      'vanlig användare skapar tävling');
  });

  test('super-admin får skapa', async () => {
    const id = uniq('sa');
    allow(await write(`competitions/${id}`, { name: 'Super' }, SUPER), 'super-admin skapar');
    await remove(`competitions/${id}`, 'owner');
  });

  test('anonym nekas skapa', async () => {
    deny(await write(`competitions/${uniq('anon')}`, { name: 'Anon' }, null), 'anonym skapar');
  });

  test('årgångskopiering tillåts för tävlingens admin', async () => {
    const id = uniq('copy');
    allow(await write(`competitions/${id}`, { name: 'Nästa år', copiedFrom: CID }, USER),
      'admin kopierar sin tävling');
    await remove(`competitions/${id}`, 'owner');
  });

  test('kopiering nekas för utomstående', async () => {
    deny(await write(`competitions/${uniq('steal')}`, { name: 'Kapning', copiedFrom: CID }, OTHER),
      'utomstående kopierar');
  });

  test('kopiering nekas med påhittad källa', async () => {
    deny(await write(`competitions/${uniq('fake')}`, { name: 'Fejk', copiedFrom: 'finns-inte' }, USER),
      'påhittad copiedFrom');
  });

  test('demo-tävling kan bara skapas av super-admin', async () => {
    deny(await write(`competitions/${uniq('demo')}`, { name: 'D', demo: true, copiedFrom: CID }, USER),
      'vanlig användare skapar demo');
  });
});

describe('Tävlingsförfrågningar', () => {
  const reqPath = (uid, slot) => `competitionRequests/${uid}-${slot}`;
  const body = (u, extra = {}) => ({
    name: 'Vårruset', description: '', date: null, message: 'Hej',
    requestedBy: u.uid, requestedByEmail: u.email, status: 'vantar',
    createdAt: new Date().toISOString(), ...extra
  });

  after(async () => {
    for (let i = 0; i < 4; i++) {
      await remove(reqPath(USER.uid, i), 'owner');
      await remove(reqPath(OTHER.uid, i), 'owner');
    }
  });

  test('användare får skapa i egen plats', async () => {
    allow(await write(reqPath(USER.uid, 0), body(USER), USER), 'egen förfrågan');
  });

  test('MAX TRE: plats 3 finns inte', async () => {
    allow(await write(reqPath(USER.uid, 1), body(USER), USER), 'plats 1');
    allow(await write(reqPath(USER.uid, 2), body(USER), USER), 'plats 2');
    deny(await write(reqPath(USER.uid, 3), body(USER), USER), 'plats 3 (fjärde förfrågan)');
  });

  test('kan inte skriva i någon annans plats', async () => {
    deny(await write(reqPath(OTHER.uid, 0), body(USER), USER), 'förfrågan i annans plats');
  });

  test('kan inte begära i annans namn', async () => {
    deny(await write(reqPath(USER.uid, 0), body(USER, { requestedBy: OTHER.uid }), USER),
      'förfrågan i annans namn');
  });

  test('kan inte skapa redan godkänd', async () => {
    deny(await write(reqPath(OTHER.uid, 0), body(OTHER, { status: 'godkand' }), OTHER),
      'självgodkänd förfrågan');
  });

  test('sökanden kan inte sätta beslutet', async () => {
    deny(await write(reqPath(USER.uid, 0), { status: 'godkand' }, USER, { merge: true }),
      'sökanden godkänner sig själv');
  });

  test('super-admin beslutar', async () => {
    allow(await write(reqPath(USER.uid, 0), { status: 'nekad', decisionMessage: 'Nej' },
      SUPER, { merge: true }), 'super-admin nekar');
  });

  test('sökanden ser bara sina egna', async () => {
    const mine = await list('competitionRequests', USER);
    assert.equal(mine.ok, false, 'obegränsad list ska nekas för vanlig användare');
    assert.equal((await list('competitionRequests', SUPER)).ok, true, 'super-admin får lista alla');
  });
});

describe('Meddelanden och kvittenser', () => {
  const MSG = uniq('msg');
  const ackPath = (kind, ref) => `competitions/${CID}/messages/${MSG}/acks/${kind}-${ref}`;

  before(async () => {
    await seed(`competitions/${CID}/messages/${MSG}`, {
      text: 'Ta skydd', level: 'kritisk', requireAck: true, active: true,
      at: new Date().toISOString(), target: { kontroller: true, patruller: true }
    });
  });
  after(async () => {
    await remove(ackPath('patrull', PATROL), 'owner');
    await remove(`competitions/${CID}/messages/${MSG}`, 'owner');
  });

  test('anonym kan inte skapa meddelanden', async () => {
    deny(await write(`competitions/${CID}/messages/${uniq('spam')}`, { text: 'spam' }, null),
      'anonymt meddelande');
  });

  test('kvittens från existerande patrull tillåts', async () => {
    allow(await write(ackPath('patrull', PATROL),
      { kind: 'patrull', refId: PATROL, seenAt: new Date() }, null), 'kvittens');
  });

  test('kvittens för påhittad mottagare nekas', async () => {
    deny(await write(ackPath('patrull', 'finns-inte'),
      { kind: 'patrull', refId: 'finns-inte', seenAt: new Date() }, null), 'påhittad mottagare');
  });

  test('kvittens på påhittat meddelande nekas (dokument-DoS)', async () => {
    deny(await write(`competitions/${CID}/messages/hittepa/acks/patrull-${PATROL}`,
      { kind: 'patrull', refId: PATROL, seenAt: new Date() }, null), 'kvittens utan meddelande');
  });

  test('APPEND-ONLY: befintlig stämpel kan inte ändras', async () => {
    await write(ackPath('patrull', PATROL), { ackAt: new Date() }, null, { merge: true });
    deny(await write(ackPath('patrull', PATROL), { ackAt: new Date(Date.now() + 60000) },
      null, { merge: true }), 'ändra befintlig ackAt');
  });

  test('framtida stämpel nekas', async () => {
    deny(await write(ackPath('kontroll', CTRL),
      { kind: 'kontroll', refId: CTRL, seenAt: new Date(Date.now() + 3600e3) }, null),
      'stämpel en timme fram');
  });

  test('kvittenser är inte anonymt läsbara (stations-id är hemligt)', async () => {
    assert.equal((await list(`competitions/${CID}/messages/${MSG}/acks`, null)).ok, false,
      'anonym läsning av kvittenser');
  });
});

describe('Behörighetsdata (PII)', () => {
  test('access-dokumentet är inte anonymt läsbart', async () => {
    assert.equal((await read(`competitions/${CID}/private/access`, null)).ok, false,
      'anonym läsning av access');
  });

  test('medlem får läsa access', async () => {
    assert.equal((await read(`competitions/${CID}/private/access`, USER)).ok, true,
      'admin läser access');
  });

  test('utomstående får inte läsa access', async () => {
    assert.equal((await read(`competitions/${CID}/private/access`, OTHER)).ok, false,
      'utomstående läser access');
  });

  test('utomstående kan inte skriva sig själv till admin', async () => {
    deny(await write(`competitions/${CID}/private/access`,
      { adminEmails: [OTHER.email] }, OTHER), 'självutnämnd admin');
  });
});

describe('Användarkonton', () => {
  test('en användare kan inte läsa andras konton', async () => {
    assert.equal((await read(`users/${OTHER.uid}`, USER)).ok, false, 'läsa annans konto');
    assert.equal((await read(`users/${USER.uid}`, USER)).ok, true, 'läsa sitt eget');
  });

  test('super-admin får läsa alla', async () => {
    assert.equal((await read(`users/${USER.uid}`, SUPER)).ok, true, 'super-admin läser');
  });

  test('en användare kan inte höja sin egen roll', async () => {
    deny(await write(`users/${USER.uid}`, { email: USER.email, role: 'super-admin' }, USER),
      'självbefordran');
  });

  test('en användare kan inte radera sitt konto direkt (går via funktionen)', async () => {
    assert.equal((await remove(`users/${USER.uid}`, USER)).ok, false, 'självradering');
  });
});
