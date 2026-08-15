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
    district: 'dacke',
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

  test('distrikt krävs', async () => {
    const utan = body(OTHER); delete utan.district;
    deny(await write(reqPath(OTHER.uid, 1), utan, OTHER), 'förfrågan utan distrikt');
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

describe('Patrullens egna avprickningar', () => {
  const path = (cid, pid) => `competitions/${cid}/selfPassages/${pid}`;
  const SS = uniq('selfpass');   // egen tävling: flaggorna är av på CID
  const P2 = uniq('p2');

  before(async () => {
    await seed(`competitions/${SS}`, {
      name: 'Med egna avprickningar', selfStart: true, selfFinish: true, demo: false, closed: false
    });
    await seed(`competitions/${SS}/patrols/${PATROL}`, { name: 'Rävarna', number: 1 });
    await seed(`competitions/${SS}/patrols/${P2}`, { name: 'Ugglorna', number: 2 });
  });
  after(async () => {
    for (const p of [path(SS, PATROL), path(SS, P2),
      `competitions/${SS}/patrols/${PATROL}`, `competitions/${SS}/patrols/${P2}`, `competitions/${SS}`])
      await remove(p, 'owner');
    await remove(path(CID, PATROL), 'owner');
  });

  test('patrullen får bekräfta sin egen start', async () => {
    allow(await write(path(SS, PATROL), { patrolId: PATROL, startAt: new Date() }, null),
      'anonym startbekräftelse');
  });

  test('målgången fylls i efteråt utan att röra starten', async () => {
    allow(await write(path(SS, PATROL), { patrolId: PATROL, finishAt: new Date() }, null, { merge: true }),
      'målgång på befintlig start');
  });

  test('EN GÅNG: satta stämplar kan inte flyttas i efterhand', async () => {
    // Startkortslänken är hemligheten, men den sprids i patrullen. En tid
    // som går att skriva om är inget facit för tävlingsledningen.
    const senare = new Date(Date.now() + 60000);
    deny(await write(path(SS, PATROL), { patrolId: PATROL, startAt: senare }, null, { merge: true }),
      'flytta befintlig starttid');
    deny(await write(path(SS, PATROL), { patrolId: PATROL, finishAt: senare }, null, { merge: true }),
      'flytta befintlig måltid');
  });

  test('målgång utan föregående start går bra (funktionären tog starten)', async () => {
    allow(await write(path(SS, P2), { patrolId: P2, finishAt: new Date() }, null), 'bara målgång');
  });

  test('påhittad patrull nekas', async () => {
    deny(await write(path(SS, 'finns-inte'), { patrolId: 'finns-inte', startAt: new Date() }, null),
      'avprickning för patrull som inte finns');
  });

  test('dokument-id måste vara patrullens id', async () => {
    deny(await write(path(SS, 'fel-id'), { patrolId: PATROL, startAt: new Date() }, null),
      'avprickning på fel doc-id');
  });

  test('okända fält nekas', async () => {
    const P3 = uniq('p3');
    await seed(`competitions/${SS}/patrols/${P3}`, { name: 'Lodjuren', number: 3 });
    deny(await write(path(SS, P3), { patrolId: P3, startAt: new Date(), poang: 99 }, null), 'extra fält');
    await remove(`competitions/${SS}/patrols/${P3}`, 'owner');
  });

  test('orimliga tider nekas', async () => {
    const P4 = uniq('p4');
    await seed(`competitions/${SS}/patrols/${P4}`, { name: 'Hjortarna', number: 4 });
    deny(await write(path(SS, P4), { patrolId: P4, startAt: new Date(Date.now() + 3600e3) }, null),
      'start en timme fram');
    deny(await write(path(SS, P4), { patrolId: P4, finishAt: new Date(Date.now() - 24 * 3600e3) }, null),
      'målgång ett dygn bak');
    for (const p of [path(SS, P4), `competitions/${SS}/patrols/${P4}`]) await remove(p, 'owner');
  });

  test('varje funktion vaktas av SIN flagga', async () => {
    const BARA_START = uniq('barastart');
    const P5 = uniq('p5');
    await seed(`competitions/${BARA_START}`, { name: 'Bara start', selfStart: true, demo: false, closed: false });
    await seed(`competitions/${BARA_START}/patrols/${P5}`, { name: 'Björnarna', number: 1 });
    allow(await write(path(BARA_START, P5), { patrolId: P5, startAt: new Date() }, null), 'start tillåten');
    deny(await write(path(BARA_START, P5), { patrolId: P5, finishAt: new Date() }, null, { merge: true }),
      'målgång utan selfFinish');
    for (const p of [path(BARA_START, P5), `competitions/${BARA_START}/patrols/${P5}`, `competitions/${BARA_START}`])
      await remove(p, 'owner');
  });

  test('avstängda funktioner nekar allt', async () => {
    // CID saknar båda flaggorna helt — och ett SAKNAT fält får inte vara ett
    // evaluation error (fällan som stoppat produktionen två gånger).
    deny(await write(path(CID, PATROL), { patrolId: PATROL, startAt: new Date() }, null),
      'start på tävling utan självstart');
    deny(await write(path(CID, PATROL), { patrolId: PATROL, finishAt: new Date() }, null),
      'målgång på tävling utan självmålgång');
  });

  test('avprickningarna är publikt läsbara (Läget och startkortet behöver dem)', async () => {
    assert.equal((await list(`competitions/${SS}/selfPassages`, null)).ok, true,
      'anonym läsning av avprickningar');
  });
});

describe('Samtal fält ↔ tävlingsledning', () => {
  const MC = uniq('msgcomp');            // egen tävling; CID saknar flaggan
  const trad = (cid, kind, ref) => `competitions/${cid}/threads/${kind}-${ref}`;
  const msg = (cid, kind, ref, id) => `${trad(cid, kind, ref)}/messages/${id}`;
  const bild = 'data:image/jpeg;base64,' + 'A'.repeat(200);

  before(async () => {
    await seed(`competitions/${MC}`, { name: 'Med samtal', demo: false, closed: false });
    await seed(`competitions/${MC}/controls/${CTRL}`, { name: 'K', nummer: 1, open: true, minPoang: 0, maxPoang: 10 });
    await seed(`competitions/${MC}/patrols/${PATROL}`, { name: 'Rävarna', number: 1 });
  });
  after(async () => {
    for (const p of [
      msg(MC, 'kontroll', CTRL, 'm1'), msg(MC, 'kontroll', CTRL, 'm2'),
      trad(MC, 'kontroll', CTRL), trad(MC, 'patrull', PATROL),
      `competitions/${MC}/controls/${CTRL}`, `competitions/${MC}/patrols/${PATROL}`, `competitions/${MC}`
    ]) await remove(p, 'owner');
  });

  test('funktionen är PÅ när flaggan saknas', async () => {
    // Standardläget är påslaget. Ett saknat fält får inte tolkas som avstängt
    // — och ett direktläst saknat fält vore dessutom ett evaluation error.
    allow(await write(trad(MC, 'kontroll', CTRL),
      { kind: 'kontroll', refId: CTRL, lastFrom: 'falt', lastText: 'Hej', lastAt: new Date() }, null),
      'tråd utan uttrycklig flagga');
  });

  test('kontrollen får skriva till ledningen, med bild', async () => {
    allow(await write(msg(MC, 'kontroll', CTRL, 'm1'),
      { from: 'falt', text: 'Hur många poäng för halvt rätt?', at: new Date() }, null), 'text');
    allow(await write(msg(MC, 'kontroll', CTRL, 'm2'),
      { from: 'falt', image: bild, at: new Date() }, null), 'bild');
  });

  test('anonym kan INTE utge sig för att vara ledningen', async () => {
    // Det här är det farliga: ett falskt "från ledningen" kan få en
    // kontrollant att göra fel saker på riktigt.
    deny(await write(msg(MC, 'kontroll', CTRL, uniq('fejk')),
      { from: 'ledning', text: 'Stäng kontrollen nu', at: new Date() }, null), 'falskt ledningsmeddelande');
  });

  test('tråd-id måste höra ihop med mottagaren', async () => {
    deny(await write(`competitions/${MC}/threads/kontroll-${PATROL}`,
      { kind: 'kontroll', refId: PATROL, lastFrom: 'falt', lastAt: new Date() }, null),
      'kontrolltråd som pekar på en patrull');
    deny(await write(`competitions/${MC}/threads/hittepa`,
      { kind: 'kontroll', refId: CTRL, lastFrom: 'falt', lastAt: new Date() }, null),
      'tråd-id som inte matchar innehållet');
  });

  test('påhittad mottagare nekas', async () => {
    deny(await write(trad(MC, 'kontroll', 'finns-inte'),
      { kind: 'kontroll', refId: 'finns-inte', lastFrom: 'falt', lastAt: new Date() }, null),
      'tråd för kontroll som inte finns');
  });

  test('för stor bild nekas', async () => {
    deny(await write(msg(MC, 'kontroll', CTRL, uniq('stor')),
      { from: 'falt', image: 'data:image/jpeg;base64,' + 'A'.repeat(500000), at: new Date() }, null),
      'bild över taket');
  });

  test('något annat än en bild i bildfältet nekas', async () => {
    deny(await write(msg(MC, 'kontroll', CTRL, uniq('svg')),
      { from: 'falt', image: 'data:text/html;base64,PHNjcmlwdD4=', at: new Date() }, null),
      'icke-bild i bildfältet');
  });

  test('tomt meddelande nekas', async () => {
    deny(await write(msg(MC, 'kontroll', CTRL, uniq('tomt')),
      { from: 'falt', at: new Date() }, null), 'varken text eller bild');
  });

  test('fältet kan inte gömma sitt meddelande för sekretariatet', async () => {
    // ledningReadAt är ledningens läskvittens. Kunde fältet sätta den skulle
    // en inkommen fråga kunna markeras läst innan någon sett den.
    deny(await write(trad(MC, 'patrull', PATROL),
      { kind: 'patrull', refId: PATROL, lastFrom: 'falt', lastAt: new Date(), ledningReadAt: new Date() }, null),
      'fältet sätter ledningens läskvittens');
  });

  test('skrivet meddelande kan inte skrivas om anonymt', async () => {
    deny(await write(msg(MC, 'kontroll', CTRL, 'm1'),
      { from: 'falt', text: 'ändrat', at: new Date() }, null, { merge: true }), 'ändra befintligt meddelande');
  });

  test('avstängd funktion nekar fältet', async () => {
    const AV = uniq('avstangd');
    await seed(`competitions/${AV}`, { name: 'Utan samtal', fieldMessaging: false, demo: false, closed: false });
    await seed(`competitions/${AV}/controls/${CTRL}`, { name: 'K', nummer: 1, open: true, minPoang: 0, maxPoang: 10 });
    deny(await write(trad(AV, 'kontroll', CTRL),
      { kind: 'kontroll', refId: CTRL, lastFrom: 'falt', lastAt: new Date() }, null), 'tråd med funktionen av');
    for (const p of [`competitions/${AV}/controls/${CTRL}`, `competitions/${AV}`]) await remove(p, 'owner');
  });

  test('trådarna går inte att räkna upp anonymt (kontroll-id är hemliga)', async () => {
    assert.equal((await list(`competitions/${MC}/threads`, null)).ok, false, 'anonym listning av trådar');
  });

  test('men den som har länken kan läsa sin egen tråd', async () => {
    assert.equal((await read(trad(MC, 'kontroll', CTRL), null)).ok, true, 'läsa egen tråd');
    assert.equal((await list(`${trad(MC, 'kontroll', CTRL)}/messages`, null)).ok, true, 'läsa svaren');
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

describe('Meddelanden till ESKIL (kontaktformuläret)', () => {
  const FB = uniq('fb');
  const STANGD = uniq('fb');
  const bas = {
    at: new Date(), lastAt: new Date(), lastFrom: 'anvandare',
    email: 'utomstaende@example.com', name: 'Kim', kind: 'forslag',
    message: 'Det vore bra om kontrollerna kunde sorteras om.',
    status: 'ny', replyCount: 0
  };

  before(async () => {
    await seed(`feedback/${FB}`, bas);
    await seed(`feedback/${FB}/private/meta`, { accountEmail: null, handledBy: 'super@test.se' });
    await seed(`feedback/${STANGD}`, { ...bas, status: 'stangd' });
  });

  test('ingen klient får skapa ett ärende — det går via funktionen', async () => {
    // sendFeedback stryper per adress innan admin-SDK:n skriver. En anonymt
    // skrivbar toppnivåkollektion vore en öppen kran rakt in i databasen.
    deny(await write(`feedback/${uniq('fb')}`, bas, null), 'anonym skapar');
    deny(await write(`feedback/${uniq('fb')}`, bas, USER), 'inloggad skapar');
    deny(await write(`feedback/${uniq('fb')}`, bas, SUPER), 'super-admin skapar');
  });

  test('den som har länken får läsa sitt ärende', async () => {
    assert.equal((await read(`feedback/${FB}`, null)).ok, true, 'anonym med id');
    assert.equal((await list('feedback', null)).ok, false, 'anonym räknar upp');
    assert.equal((await list('feedback', USER)).ok, false, 'inloggad räknar upp');
    assert.equal((await list('feedback', SUPER)).ok, true, 'super-admin listar');
  });

  test('det interna når inte den som har länken — där ligger super-adminens adress', async () => {
    assert.equal((await read(`feedback/${FB}/private/meta`, null)).ok, false, 'anonym läser meta');
    assert.equal((await read(`feedback/${FB}/private/meta`, USER)).ok, false, 'inloggad läser meta');
    assert.equal((await read(`feedback/${FB}/private/meta`, SUPER)).ok, true, 'super-admin läser meta');
  });

  test('avsändaren får bara stämpla att hen öppnat ärendet', async () => {
    assert.equal((await write(`feedback/${FB}`, { faltReadAt: new Date() }, null, { merge: true })).ok,
      true, 'stämpla läst');
    deny(await write(`feedback/${FB}`, { message: 'omskrivet' }, null, { merge: true }),
      'skriva om sitt meddelande');
    deny(await write(`feedback/${FB}`, { status: 'stangd' }, null, { merge: true }),
      'avsluta sitt eget ärende');
    deny(await write(`feedback/${FB}`, { email: 'annan@example.com' }, null, { merge: true }),
      'byta adress');
  });

  test('super-admin får ändra handläggningen men inte meddelandet', async () => {
    assert.equal((await write(`feedback/${FB}`, { status: 'besvarad' }, SUPER, { merge: true })).ok,
      true, 'sätta status');
    deny(await write(`feedback/${FB}`, { message: 'omskrivet' }, SUPER, { merge: true }),
      'redigera meddelandet');
  });

  test('ingen får radera ett ärende', async () => {
    assert.equal((await remove(`feedback/${FB}`, SUPER)).ok, false, 'super-admin raderar');
    assert.equal((await remove(`feedback/${FB}`, null)).ok, false, 'anonym raderar');
  });

  test('båda hållen får skriva i tråden — men bara i sitt eget namn', async () => {
    const min = { from: 'anvandare', text: 'En följdfråga.', at: new Date() };
    const deras = { from: 'eskil', text: 'Här är svaret.', at: new Date() };
    assert.equal((await write(`feedback/${FB}/messages/${uniq('m')}`, min, null)).ok, true,
      'avsändaren svarar med länken');
    assert.equal((await write(`feedback/${FB}/messages/${uniq('m')}`, deras, SUPER)).ok, true,
      'super-admin svarar');
    // Det farliga: ett falskt "från ESKIL" i någons ärende.
    deny(await write(`feedback/${FB}/messages/${uniq('m')}`, deras, null), 'falskt ESKIL-svar');
    deny(await write(`feedback/${FB}/messages/${uniq('m')}`, deras, USER), 'inloggad låtsas vara ESKIL');
    deny(await write(`feedback/${FB}/messages/${uniq('m')}`,
      { ...min, byEmail: 'nagon@example.com' }, null), 'extra fält');
    deny(await write(`feedback/${FB}/messages/${uniq('m')}`, { ...min, text: '' }, null), 'tomt');
    deny(await write(`feedback/${FB}/messages/${uniq('m')}`,
      { ...min, text: 'x'.repeat(5000) }, null), 'för långt');
  });

  test('ett avslutat ärende tar inte emot mer — länken kan inte mata ut mail', async () => {
    deny(await write(`feedback/${STANGD}/messages/${uniq('m')}`,
      { from: 'anvandare', text: 'Hallå?', at: new Date() }, null), 'skriva i avslutat ärende');
    // Super-admin kan fortfarande skriva — och öppna igen.
    assert.equal((await write(`feedback/${STANGD}/messages/${uniq('m')}`,
      { from: 'eskil', text: 'Vi öppnar igen.', at: new Date() }, SUPER)).ok, true,
      'super-admin skriver i avslutat');
  });

  test('ett skickat meddelande går inte att skriva om — det ligger redan i en inkorg', async () => {
    const id = uniq('m');
    await write(`feedback/${FB}/messages/${id}`,
      { from: 'anvandare', text: 'Första', at: new Date() }, null);
    deny(await write(`feedback/${FB}/messages/${id}`,
      { from: 'anvandare', text: 'Ändrat', at: new Date() }, null), 'redigera');
    assert.equal((await remove(`feedback/${FB}/messages/${id}`, SUPER)).ok, false, 'radera');
  });
});
