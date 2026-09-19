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

  test('anonym får ta bort sin egen rapport på öppen kontroll', async () => {
    // Rapportsidans "Ta bort rapport" är anonym. Utan den här grenen NEKADES
    // borttagningen: online ett rättighetsfel, offline en lokal radering som
    // rullades tillbaka vid synk — poängen kom tillbaka utan besked.
    await seed(scorePath, { patrolId: PATROL, poang: 7 });
    allow(await remove(scorePath, null), 'anonym borttagning');
  });

  test('anonym borttagning nekas på stängd kontroll', async () => {
    await seed(scorePath, { patrolId: PATROL, poang: 7 });
    await seed(`competitions/${CID}/controls/${CTRL}`, { open: false });
    deny(await remove(scorePath, null), 'borttagning på stängd kontroll');
    await seed(`competitions/${CID}/controls/${CTRL}`, { open: true });
    await remove(scorePath, 'owner');
  });

  test('anonym borttagning nekas när ledningen rättat poängen', async () => {
    // history är rättelsespåret. Kan det raderas anonymt går det att sopa
    // undan att en poäng justerats.
    await seed(scorePath, { patrolId: PATROL, poang: 7, history: [{ poang: 3 }] });
    deny(await remove(scorePath, null), 'borttagning av rättad poäng');
    await remove(scorePath, 'owner');
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

  test('reporter-id har ett storlekstak (ostryparad textkanal annars)', async () => {
    allow(await write(scorePath, { patrolId: PATROL, poang: 5, reporter: 'r_abc123' }, null),
      'kort reporter-id');
    deny(await write(scorePath, { patrolId: PATROL, poang: 5, reporter: 'x'.repeat(200) }, null),
      '200-teckens reporter');
  });

  test('anonym får inte injicera eller växa ett justeringsspår (history)', async () => {
    // history skrivs bara av admins (adjustScore). En anonym re-rapport får
    // bära med sig en befintlig historik oförändrad, aldrig hitta på en egen.
    await remove(scorePath, 'owner');
    deny(await write(scorePath,
      { patrolId: PATROL, poang: 5, history: [{ note: 'påhittad justering', by: 'angripare' }] }, null),
      'anonym injicerar history på en färsk rapport');

    // Admin lägger ett äkta spår; anon-rapport som bevarar det oförändrat är ok.
    await seed(scorePath, { patrolId: PATROL, poang: 5, history: [{ note: 'äkta', poang: 5 }] });
    allow(await write(scorePath,
      { patrolId: PATROL, poang: 6, history: [{ note: 'äkta', poang: 5 }] }, null),
      'anon-rapport bevarar befintlig history');
    deny(await write(scorePath,
      { patrolId: PATROL, poang: 6, history: [{ note: 'äkta', poang: 5 }, { note: 'tillagd', poang: 9 }] }, null),
      'anon växer history');
    await remove(scorePath, 'owner');
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

  test('kontrollansvarig kan inte skriva om samtalstoken', async () => {
    // Token ligger i tryckta QR-koder. Kunde en ansvarig skriva om den dog
    // kontrollens fältlänk tyst mitt i tävlingen.
    const KC = uniq('tokmeta');
    await seed(`competitions/${KC}`, { name: 'Token', demo: false, closed: false });
    await seed(`competitions/${KC}/private/access`, { adminEmails: ['nan@example.com'], userEmails: [] });
    await seed(`competitions/${KC}/controls/${CTRL}`, { name: 'K', nummer: 1, open: true });
    await seed(`competitions/${KC}/controls/${CTRL}/private/meta`,
      { ansvarigaEmails: [USER.email], threadToken: 'abc123', telefon: '070' });
    deny(await write(`competitions/${KC}/controls/${CTRL}/private/meta`,
      { threadToken: 'kapad' }, USER, { merge: true }), 'ansvarig skriver om token');
    allow(await write(`competitions/${KC}/controls/${CTRL}/private/meta`,
      { telefon: '070-1' }, USER, { merge: true }), 'ansvarig ändrar telefon');
    for (const p of [`competitions/${KC}/controls/${CTRL}/private/meta`,
      `competitions/${KC}/controls/${CTRL}`, `competitions/${KC}/private/access`, `competitions/${KC}`])
      await remove(p, 'owner');
  });

  test('LÄCKAN: den härledda tråden är INTE anonymt läsbar', async () => {
    // 'kontroll-<ctrlId>' går att räkna fram — kontroller och patruller är
    // världsläsbara. Med `allow get: if true` kunde vem som helst läsa fältets
    // samtal med ledningen, inklusive nödropens GPS-position och bilderna
    // från skogen. Reproducerat anonymt mot skarpa regler innan fixen.
    assert.equal((await read(trad(MC, 'kontroll', CTRL), null)).ok, false, 'härledd tråd anonymt');
    assert.equal((await list(`${trad(MC, 'kontroll', CTRL)}/messages`, null)).ok, false,
      'härledda trådens meddelanden anonymt');
  });

  test('radbrytning i tråd-id smiter inte förbi den härledda formen', async () => {
    // RE2:s punkt matchar INTE radbrytning. Utan (?s) föll ett id som
    // 'kontroll-\nsmyg' ur den härledda formen och behandlades som en token
    // — alltså läsbart för vem som helst. Mätt: 200 utan flaggan, 403 med.
    const id = encodeURIComponent('kontroll-\nsmyg');
    await seed(`competitions/${MC}/threads/${id}`, { kind: 'kontroll', refId: CTRL, lastText: 'nödrop' });
    assert.equal((await read(`competitions/${MC}/threads/${id}`, null)).ok, false,
      'tråd-id med radbrytning anonymt');
    await remove(`competitions/${MC}/threads/${id}`, 'owner');
  });

  test('men fältet kan fortfarande SKRIVA på den härledda tråden', async () => {
    // Nödropet på startkortet har EN kanal, och tävlingssidan länkar publikt
    // till startkorten — de flesta patruller står alltså utan token. Krävdes
    // token för att skriva vore nödropet dött för dem.
    allow(await write(trad(MC, 'patrull', PATROL),
      { kind: 'patrull', refId: PATROL, lastFrom: 'falt', lastText: '🆘', lastAt: new Date() }, null),
      'nödrop utan token');
    allow(await write(msg(MC, 'patrull', PATROL, uniq('sos')),
      { from: 'falt', text: '🆘 VI BEHÖVER HJÄLP', at: new Date() }, null), 'nödropets meddelande');
  });

  test('tokentråd: ledningen mintar huvudet, den som har token läser', async () => {
    const TOK = uniq('tok') + uniq('en');            // ~20 tecken, som en riktig token
    await seed(`competitions/${MC}/threads/${TOK}`, { kind: 'kontroll', refId: CTRL });
    allow(await write(`competitions/${MC}/threads/${TOK}/messages/t1`,
      { from: 'falt', text: 'Fråga via tokenlänken', at: new Date() }, null), 'skriva i tokentråd');
    assert.equal((await read(`competitions/${MC}/threads/${TOK}`, null)).ok, true, 'läsa tokentråd');
    assert.equal((await list(`competitions/${MC}/threads/${TOK}/messages`, null)).ok, true,
      'läsa tokentrådens svar');
    for (const p of [`competitions/${MC}/threads/${TOK}/messages/t1`, `competitions/${MC}/threads/${TOK}`])
      await remove(p, 'owner');
  });

  test('anonym kan INTE minta en egen tokentråd', async () => {
    // Kunde fältet skapa en tråd med valfritt id vore hela tokenformen
    // värdelös: lägg upp ett id, skriv i det, läs det.
    const TOK = uniq('egen') + uniq('token');
    deny(await write(`competitions/${MC}/threads/${TOK}`,
      { kind: 'kontroll', refId: CTRL, lastFrom: 'falt', lastAt: new Date() }, null),
      'anonymt mintad tokentråd');
    deny(await write(`competitions/${MC}/threads/${TOK}/messages/x1`,
      { from: 'falt', text: 'hej', at: new Date() }, null),
      'meddelande i tokentråd utan huvud');
  });

  test('fältet kan inte peka om en tokentråd till en annan mottagare', async () => {
    const TOK = uniq('peka') + uniq('om');
    await seed(`competitions/${MC}/threads/${TOK}`, { kind: 'kontroll', refId: CTRL });
    deny(await write(`competitions/${MC}/threads/${TOK}`,
      { kind: 'patrull', refId: PATROL, lastFrom: 'falt', lastAt: new Date() }, null, { merge: true }),
      'ompekad tokentråd');
    await remove(`competitions/${MC}/threads/${TOK}`, 'owner');
  });

  test('fältets läskvittens går fram även när ledningen svarat sist', async () => {
    // Buggen: lastFrom-kravet läste det FÄRDIGA (merge:ade) dokumentet, som
    // bär 'ledning' precis den enda gång kvittensen körs. Varje kvittens
    // nekades, felet slukades av .catch() och oläst-pricken slocknade aldrig.
    const T = trad(MC, 'kontroll', CTRL);
    await seed(T, { kind: 'kontroll', refId: CTRL, lastFrom: 'ledning', lastAt: new Date() });
    allow(await write(T, { kind: 'kontroll', refId: CTRL, faltReadAt: new Date() }, null, { merge: true }),
      'fältets läskvittens');
    deny(await write(T, { kind: 'kontroll', refId: CTRL, faltReadAt: new Date(), lastText: 'smugit in' },
      null, { merge: true }), 'kvittens som samtidigt ändrar texten');
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

describe('Kontrollens livstecken (beacon)', () => {
  const path = `competitions/${CID}/controls/${CTRL}/beacon/status`;
  const ok_data = { at: new Date(), batteri: 78, laddar: false, koade: 2 };

  test('anonym får skriva livstecken på en öppen kontroll', async () => {
    allow(await write(path, ok_data, null), 'anonymt livstecken');
    allow(await write(path, { at: new Date() }, null), 'bara at — batteri/kö är valfria');
  });

  test('ett livstecken per enhet — flera doc-id tillåts, men inte hur långa som helst', async () => {
    // En kontroll bemannas ofta av två telefoner. Med ett delat doc-id skrev
    // den friska över den döende, så id:t är per ENHET numera.
    allow(await write(`competitions/${CID}/controls/${CTRL}/beacon/enhet-abc123`, ok_data, null), 'andra enhetens livstecken');
    deny(await write(`competitions/${CID}/controls/${CTRL}/beacon/${'x'.repeat(65)}`, ok_data, null), 'doc-id över 64 tecken');
  });

  test('formen är hård: kända fält, rimliga värden', async () => {
    deny(await write(path, { ...ok_data, batteri: 150 }, null), 'batteri över 100');
    deny(await write(path, { ...ok_data, batteri: -1 }, null), 'negativt batteri');
    deny(await write(path, { ...ok_data, koade: -1 }, null), 'negativ kö');
    deny(await write(path, { ...ok_data, hittepa: 'x' }, null), 'okänt fält');
    deny(await write(path, { batteri: 50 }, null), 'utan at');
  });

  test('`at` är tidsbunden — annars kan en kontroll se vaken ut för alltid', async () => {
    // `at` är klient-tid (så ett offline-buffrat livstecken bär rätt tidpunkt).
    // Utan spärr kunde den som har den hemliga länken skriva ett `at` långt
    // fram i tiden: kontrollen ser för evigt ut att just ha hörts av, och
    // Läget slutar visa att den tystnat.
    const om = (ms) => new Date(Date.now() + ms);
    deny(await write(path, { ...ok_data, at: om(60 * 60000) }, null), 'at en timme fram');
    deny(await write(path, { ...ok_data, at: om(-13 * 3600 * 1000) }, null), 'at 13 timmar bak');
    allow(await write(path, { ...ok_data, at: om(-2 * 3600 * 1000) }, null), 'at 2 timmar bak (offline-buffrat)');
  });

  test('stängd kontroll tar inte emot livstecken', async () => {
    await seed(`competitions/${CID}/controls/${CTRL}`, { open: false });
    deny(await write(path, ok_data, null), 'livstecken på stängd kontroll');
    await seed(`competitions/${CID}/controls/${CTRL}`, { open: true });
  });

  test('läsning är member-only — batteri och könivå är intern drift', async () => {
    await write(path, ok_data, null);
    assert.equal((await read(path, null)).ok, false, 'anonym läser beacon');
    assert.equal((await read(path, OTHER)).ok, false, 'utomstående läser beacon');
    assert.equal((await read(path, USER)).ok, true, 'medlem läser beacon');
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

describe('Anmälans betalning: påstående kontra facit', () => {
  const RID = uniq('reg');
  const REG_CID = uniq('comp');
  const EKONOM = { uid: uniq('uid-ek'), email: 'kassor@test.se' };

  before(async () => {
    await seed(`users/${EKONOM.uid}`, { email: EKONOM.email, role: 'user' });
    await seed(`competitions/${REG_CID}`, {
      name: 'Anmälningstävling', shortName: 'AT', year: 2026, demo: false, closed: false,
      registration: { enabled: true }
    });
    await seed(`competitions/${REG_CID}/private/access`, {
      adminEmails: [USER.email], userEmails: [], ekonomiEmails: [EKONOM.email]
    });
    await seed(`competitions/${REG_CID}/registrations/${RID}`, {
      kar: 'Lindsdals Scoutkår', contact: { name: 'Kim', email: 'kim@example.com' },
      patrols: [{ name: 'Rävarna' }], totalAmount: 300,
      payments: [{ reference: 'AT26-1', amount: 300 }]
    });
  });

  const bas = { kar: 'Lindsdals Scoutkår', updatedAt: new Date().toISOString() };

  test('länkinnehavaren får påstå att betalningen är gjord', async () => {
    allow(await write(`competitions/${REG_CID}/registrations/${RID}`,
      { ...bas, paymentClaims: [{ reference: 'AT26-1', at: new Date().toISOString() }] },
      null, { merge: true }), 'anonymt påstående');
  });

  test('men ALDRIG röra kassörens facit', async () => {
    // paidRefs är sanningen. Att den inte står i anmälarens hasOnly-lista är
    // hela skyddet — utan det kan vem som helst med länken skriva sig betald.
    deny(await write(`competitions/${REG_CID}/registrations/${RID}`,
      { ...bas, paidRefs: ['AT26-1'] }, null, { merge: true }), 'anonym skriver paidRefs');
    deny(await write(`competitions/${REG_CID}/registrations/${RID}`,
      { ...bas, paidRefs: ['AT26-1'], paymentClaims: [{ reference: 'AT26-1' }] },
      null, { merge: true }), 'paidRefs smyger med i samma skrivning');
  });

  test('kassören prickar av — och rör bara facit', async () => {
    // Prövas på en tävling med STÄNGD anmälan. Med öppen anmälan får vem som
    // helst med länken redigera kar/patrols, så ett "ekonomen ändrade kåren"
    // hade bevisat ingenting om ekonomirollen — bara att länkgrenen finns.
    const STANGD = uniq('comp');
    const R2 = uniq('reg');
    await seed(`competitions/${STANGD}`, {
      name: 'Stängd anmälan', shortName: 'SA', year: 2026, demo: false, closed: false,
      registration: { enabled: false }
    });
    await seed(`competitions/${STANGD}/private/access`, {
      adminEmails: [USER.email], userEmails: [], ekonomiEmails: [EKONOM.email]
    });
    await seed(`competitions/${STANGD}/registrations/${R2}`, {
      kar: 'Lindsdals Scoutkår', payments: [{ reference: 'SA26-1', amount: 300 }]
    });

    allow(await write(`competitions/${STANGD}/registrations/${R2}`,
      { paidRefs: ['SA26-1'] }, EKONOM, { merge: true }), 'ekonomiansvarig prickar av');
    deny(await write(`competitions/${STANGD}/registrations/${R2}`,
      { paidRefs: ['SA26-1'], kar: 'Ändrad kår' }, EKONOM, { merge: true }), 'ekonomi ändrar deltagardata');
    deny(await write(`competitions/${STANGD}/registrations/${R2}`,
      { paymentClaims: [{ reference: 'SA26-1' }] }, EKONOM, { merge: true }),
      'ekonomi skriver ett påstående — det är anmälarens fält, inte kassörens');
    deny(await write(`competitions/${STANGD}/registrations/${R2}`,
      { paidRefs: ['SA26-1'] }, OTHER, { merge: true }), 'utomstående prickar av');
  });

  test('länkinnehavaren får skicka ändringsförfrågan — men listan har tak', async () => {
    allow(await write(`competitions/${REG_CID}/registrations/${RID}`,
      { ...bas, andringar: [{ sort: 'antal', patrol: 'Rävarna', message: 'Vi blir 5 i stället för 6', at: new Date().toISOString() }] },
      null, { merge: true }), 'anonym ändringsförfrågan');
    deny(await write(`competitions/${REG_CID}/registrations/${RID}`,
      { ...bas, andringar: 'inte-en-lista' }, null, { merge: true }), 'sträng i stället för lista');
    deny(await write(`competitions/${REG_CID}/registrations/${RID}`,
      { ...bas, andringar: Array.from({ length: 31 }, (_, i) => ({ sort: 'annat', message: 'x' + i })) },
      null, { merge: true }), '31 förfrågningar');
  });

  test('efteranmälan är ledningens fält — länken får aldrig skriva det', async () => {
    // `efteranmalningar` triggar ett mail till kontakten (Cloud Function).
    // Kunde länkinnehavaren skriva det vore fältet en mailkran, och en post
    // med påhittat belopp hade sett ut som ledningens beslut.
    const post = { at: new Date().toISOString(), patrols: ['Ugglorna'], amount: 300, reference: 'AT26-2' };
    deny(await write(`competitions/${REG_CID}/registrations/${RID}`,
      { ...bas, efteranmalningar: [post] }, null, { merge: true }), 'anonym efteranmäler');
    deny(await write(`competitions/${REG_CID}/registrations/${uniq('reg')}`,
      { ...bas, patrols: [{ name: 'Ugglorna' }], efteranmalningar: [post], createdAt: new Date().toISOString() }, null),
      'anonym skapar en anmälan med efteranmälan');
    allow(await write(`competitions/${REG_CID}/registrations/${RID}`,
      { patrols: [{ name: 'Rävarna' }, { name: 'Ugglorna' }], totalAmount: 600,
        payments: [{ reference: 'AT26-1', amount: 300 }, { reference: 'AT26-2', amount: 300 }],
        efteranmalningar: [post] }, USER, { merge: true }), 'admin efteranmäler');
  });

  test('admin får skapa en anmälan när anmälan är avstängd — det ÄR efteranmälan', async () => {
    // Perioden vaktas bara i UI:t, men `enabled: false` vaktas i reglerna.
    // Ledningens väg går via isCompAdmin och ska fungera oavsett.
    const AVSTANGD = uniq('comp');
    await seed(`competitions/${AVSTANGD}`, {
      name: 'Avstängd anmälan', shortName: 'AA', year: 2026, demo: false, closed: false,
      registration: { enabled: false }
    });
    await seed(`competitions/${AVSTANGD}/private/access`, {
      adminEmails: [USER.email], userEmails: [], ekonomiEmails: []
    });
    const data = {
      kar: 'Lindsdals Scoutkår', contact: { name: 'Kim', email: 'kim@example.com' },
      patrols: [{ name: 'Ugglorna' }], payments: [],
      efteranmalningar: [{ at: new Date().toISOString(), patrols: ['Ugglorna'], amount: 0, reference: null }],
      createdAt: new Date().toISOString()
    };
    allow(await write(`competitions/${AVSTANGD}/registrations/${uniq('reg')}`, data, USER), 'admin skapar efteranmälan');
    deny(await write(`competitions/${AVSTANGD}/registrations/${uniq('reg')}`, data, OTHER), 'utomstående skapar');
    deny(await write(`competitions/${AVSTANGD}/registrations/${uniq('reg')}`, data, null), 'anonym skapar på avstängd anmälan');
  });

  test('formen på påståendet vaktas', async () => {
    deny(await write(`competitions/${REG_CID}/registrations/${RID}`,
      { ...bas, paymentClaims: 'inte-en-lista' }, null, { merge: true }), 'sträng i stället för lista');
    deny(await write(`competitions/${REG_CID}/registrations/${RID}`,
      { ...bas, paymentClaims: Array.from({ length: 21 }, (_, i) => ({ reference: 'r' + i })) },
      null, { merge: true }), '21 påståenden');
  });

  test('en anmälan UTAN fältet går fortfarande att redigera', async () => {
    // .get()-fällan: en direktläsning av paymentClaims på en anmälan som
    // saknar fältet är ett evalueringsfel som tyst nekar HELA redigeringen —
    // alltså varenda befintlig anmälan.
    const UTAN = uniq('reg');
    await seed(`competitions/${REG_CID}/registrations/${UTAN}`, {
      kar: 'Gamla kåren', payments: [{ reference: 'AT26-9', amount: 100 }]
    });
    allow(await write(`competitions/${REG_CID}/registrations/${UTAN}`,
      { kar: 'Nytt namn', updatedAt: new Date().toISOString() }, null, { merge: true }),
      'redigering av anmälan utan paymentClaims');
  });
});

describe('Sekretariatets logg', () => {
  const path = `competitions/${CID}/logg/${uniq('l')}`;
  const bra = { at: new Date(), av: 'user@test.se', vad: 'kontroll-stangd', text: 'Kontroll 4 stängd' };

  test('medlem skriver, utomstående nekas', async () => {
    allow(await write(path, bra, USER), 'medlem loggar');
    deny(await write(`competitions/${CID}/logg/${uniq('l')}`, bra, OTHER), 'utomstående loggar');
    deny(await write(`competitions/${CID}/logg/${uniq('l')}`, bra, null), 'anonym loggar');
  });

  test('loggen går inte att skriva om — det är hela poängen', async () => {
    const p2 = `competitions/${CID}/logg/${uniq('l')}`;
    allow(await write(p2, bra, USER), 'skapa');
    deny(await write(p2, { ...bra, text: 'Något annat' }, USER, { merge: true }), 'skriva om posten');
  });

  test('men admin får gallra — annars överlever loggen tävlingen', async () => {
    const p3 = `competitions/${CID}/logg/${uniq('l')}`;
    await write(p3, bra, USER);
    assert.equal((await remove(p3, USER)).ok, true, 'admin raderar');
  });

  test('list är member-only — loggen namnger patruller', async () => {
    assert.equal((await list(`competitions/${CID}/logg`, null)).ok, false, 'anonym listar');
    assert.equal((await list(`competitions/${CID}/logg`, OTHER)).ok, false, 'utomstående listar');
    assert.equal((await list(`competitions/${CID}/logg`, USER)).ok, true, 'medlem listar');
  });

  test('formen vaktas', async () => {
    const p4 = () => `competitions/${CID}/logg/${uniq('l')}`;
    deny(await write(p4(), { ...bra, hittepa: 'x' }, USER), 'okänt fält');
    deny(await write(p4(), { ...bra, text: 'x'.repeat(501) }, USER), 'för lång text');
    deny(await write(p4(), { at: new Date(), av: 'a', vad: 'b' }, USER), 'utan text');
    deny(await write(p4(), { ...bra, at: new Date(Date.now() + 3600000) }, USER), 'at en timme fram');
  });
});

describe('Ändringsförfrågningar som ärenden', () => {
  // Trådar under anmälan: kåren frågar anonymt med länken, ledningen svarar,
  // en Cloud Function mailar. Sökvägen bär regId, som är hemligheten.
  const C = uniq('comp');
  const R = uniq('reg');
  const A = uniq('arende');
  const bas = { sort: 'antal', patrol: 'Rävarna', message: 'Vi blir 5 i stället för 6', at: new Date().toISOString(),
                status: 'oppen', senastAt: new Date().toISOString(), senastFran: 'kar' };

  before(async () => {
    await seed(`competitions/${C}`, {
      name: 'Ärendetävling', shortName: 'AR', year: 2026, demo: false, closed: false,
      registration: { enabled: true }
    });
    await seed(`competitions/${C}/private/access`, { adminEmails: [USER.email], userEmails: [], ekonomiEmails: [] });
    await seed(`competitions/${C}/registrations/${R}`, { kar: 'Lindsdals Scoutkår', contact: { name: 'Kim', email: 'kim@example.com' } });
    await seed(`competitions/${C}/registrations/${R}/andringar/${A}`, bas);
  });

  test('kåren skapar ärendet anonymt — bara som öppet och som avsändare "kar"', async () => {
    allow(await write(`competitions/${C}/registrations/${R}/andringar/${uniq('a')}`, bas, null), 'anonym skapar ärende');
    deny(await write(`competitions/${C}/registrations/${R}/andringar/${uniq('a')}`, { ...bas, status: 'hanterad' }, null), 'anonym skapar hanterat');
    deny(await write(`competitions/${C}/registrations/${R}/andringar/${uniq('a')}`, { ...bas, senastFran: 'ledning' }, null), 'anonym utger sig för ledningen');
    deny(await write(`competitions/${C}/registrations/${R}/andringar/${uniq('a')}`, { ...bas, message: 'x'.repeat(2001) }, null), 'för långt meddelande');
    deny(await write(`competitions/${C}/registrations/${R}/andringar/${uniq('a')}`, { ...bas, hanteradAt: 'nu' }, null), 'okänt fält');
  });

  test('tråden går att läsa och lista med länken, men aldrig ändras i sak anonymt', async () => {
    assert.equal((await read(`competitions/${C}/registrations/${R}/andringar/${A}`, null)).ok, true, 'anonym läser');
    assert.equal((await list(`competitions/${C}/registrations/${R}/andringar`, null)).ok, true, 'anonym listar under regId');
    deny(await write(`competitions/${C}/registrations/${R}/andringar/${A}`, { message: 'omskrivet' }, null, { merge: true }), 'anonym skriver om frågan');
    deny(await write(`competitions/${C}/registrations/${R}/andringar/${A}`, { status: 'hanterad' }, null, { merge: true }), 'anonym stänger');
    allow(await write(`competitions/${C}/registrations/${R}/andringar/${A}`,
      { status: 'oppen', senastAt: new Date().toISOString(), senastFran: 'kar' }, null, { merge: true }), 'anonym öppnar igen');
    allow(await write(`competitions/${C}/registrations/${R}/andringar/${A}`,
      { status: 'hanterad', hanteradAt: new Date().toISOString() }, USER, { merge: true }), 'admin stänger');
    deny(await write(`competitions/${C}/registrations/${R}/andringar/${A}`, { status: 'hanterad' }, OTHER, { merge: true }), 'utomstående stänger');
  });

  test('svaren: kåren skriver som "kar", ledningen som "ledning" — aldrig tvärtom', async () => {
    const svar = (from) => ({ from, text: 'Hej!', at: new Date().toISOString() });
    allow(await write(`competitions/${C}/registrations/${R}/andringar/${A}/svar/${uniq('m')}`, svar('kar'), null), 'anonym svarar som kår');
    deny(await write(`competitions/${C}/registrations/${R}/andringar/${A}/svar/${uniq('m')}`, svar('ledning'), null), 'anonym utger sig för ledningen');
    allow(await write(`competitions/${C}/registrations/${R}/andringar/${A}/svar/${uniq('m')}`, svar('ledning'), USER), 'admin svarar');
    // Länkgrenen gäller VEM SOM HELST som har länken — även en inloggad
    // admin. Admin-vyn skriver aldrig som kår, men regeln kan inte skilja
    // "admin med länken" från "kåren med länken", och ska inte heller.
    allow(await write(`competitions/${C}/registrations/${R}/andringar/${A}/svar/${uniq('m')}`, svar('kar'), USER), 'admin med länken skriver som kår');
    deny(await write(`competitions/${C}/registrations/${R}/andringar/${A}/svar/${uniq('m')}`, svar('ledning'), OTHER), 'utomstående svarar');
    deny(await write(`competitions/${C}/registrations/${R}/andringar/${A}/svar/${uniq('m')}`, { ...svar('kar'), bild: 'x' }, null), 'okänt fält');
    assert.equal((await list(`competitions/${C}/registrations/${R}/andringar/${A}/svar`, null)).ok, true, 'anonym läser samtalet med länken');
  });

  test('ett skickat svar är skickat', async () => {
    const M = uniq('m');
    await seed(`competitions/${C}/registrations/${R}/andringar/${A}/svar/${M}`, { from: 'kar', text: 'Hej', at: new Date().toISOString() });
    deny(await write(`competitions/${C}/registrations/${R}/andringar/${A}/svar/${M}`, { text: 'ändrat' }, null, { merge: true }), 'anonym ändrar');
    deny(await write(`competitions/${C}/registrations/${R}/andringar/${A}/svar/${M}`, { text: 'ändrat' }, USER, { merge: true }), 'admin ändrar');
    deny(await remove(`competitions/${C}/registrations/${R}/andringar/${A}/svar/${M}`, null), 'anonym raderar');
    allow(await remove(`competitions/${C}/registrations/${R}/andringar/${A}/svar/${M}`, USER), 'admin sopar (avslut/radering)');
  });

  test('avstängd anmälan stänger kårens väg men inte ledningens', async () => {
    const C2 = uniq('comp'); const R2 = uniq('reg');
    await seed(`competitions/${C2}`, { name: 'Av', shortName: 'AV', year: 2026, demo: false, closed: false, registration: { enabled: false } });
    await seed(`competitions/${C2}/private/access`, { adminEmails: [USER.email], userEmails: [], ekonomiEmails: [] });
    await seed(`competitions/${C2}/registrations/${R2}`, { kar: 'Kåren' });
    deny(await write(`competitions/${C2}/registrations/${R2}/andringar/${uniq('a')}`, bas, null), 'anonym med avstängd anmälan');
    allow(await write(`competitions/${C2}/registrations/${R2}/andringar/${uniq('a')}`, { ...bas, migrerad: true }, USER), 'admin migrerar gammal post');
  });
});

describe('Tidtagningskontroll: tid anonymt, poäng bara av ledningen', () => {
  const C = uniq('comp');
  const T = uniq('ctrl');   // tidtagning
  const P = uniq('ctrl');   // vanlig poängkontroll
  const PAT = uniq('patrol');

  before(async () => {
    await seed(`competitions/${C}`, { name: 'Tidtävling', shortName: 'TT', year: 2026, demo: false, closed: false });
    await seed(`competitions/${C}/private/access`, { adminEmails: [USER.email], userEmails: [], ekonomiEmails: [] });
    await seed(`competitions/${C}/controls/${T}`, { nummer: 1, name: 'Hinderbanan', open: true, tidtagning: true, minPoang: 5, maxPoang: 10, extraPoang: 2 });
    await seed(`competitions/${C}/controls/${P}`, { nummer: 2, name: 'Knopar', open: true, minPoang: 0, maxPoang: 10 });
    await seed(`competitions/${C}/patrols/${PAT}`, { name: 'Rävarna' });
  });

  const tid = (extra = {}) => ({ patrolId: PAT, tidSek: 125, extraPoang: 1, note: '', reporter: 'enhet-1', clientReportedAt: new Date(), ...extra });

  test('kontrollanten rapporterar en tid — utan poäng', async () => {
    allow(await write(`competitions/${C}/controls/${T}/scores/${PAT}`, tid(), null), 'anonym tid');
    deny(await write(`competitions/${C}/controls/${T}/scores/${PAT}`, tid({ poang: 10 }), null), 'anonym tid MED poäng — poängen är ledningens');
    deny(await write(`competitions/${C}/controls/${T}/scores/${PAT}`, tid({ poangFranTid: true }), null), 'anonym stämplar fördelningen');
    deny(await write(`competitions/${C}/controls/${T}/scores/${PAT}`, tid({ tidSek: -5 }), null), 'negativ tid');
    deny(await write(`competitions/${C}/controls/${T}/scores/${PAT}`, tid({ tidSek: 90000 }), null), 'över ett dygn');
    deny(await write(`competitions/${C}/controls/${T}/scores/${PAT}`, tid({ tidSek: '2:05' }), null), 'tid som text');
    deny(await write(`competitions/${C}/controls/${T}/scores/${PAT}`, { patrolId: PAT, extraPoang: 1, reporter: 'x' }, null), 'varken tid eller ej genomförd');
  });

  test('"ej genomförd" ger 0 direkt — och bara 0', async () => {
    const ej = { patrolId: PAT, ejGenomford: true, poang: 0, extraPoang: 0, reporter: 'enhet-1' };
    allow(await write(`competitions/${C}/controls/${T}/scores/${PAT}`, ej, null), 'ej genomförd med 0');
    const { poang: _p, ...utanPoang } = ej;
    allow(await write(`competitions/${C}/controls/${T}/scores/${PAT}`, utanPoang, null), 'ej genomförd utan poang-fält');
    deny(await write(`competitions/${C}/controls/${T}/scores/${PAT}`, { ...ej, poang: 5 }, null), 'ej genomförd med poäng');
    deny(await write(`competitions/${C}/controls/${T}/scores/${PAT}`, { ...ej, tidSek: 120 }, null), 'ej genomförd OCH tid');
  });

  test('en vanlig poängkontroll tar inte emot tider', async () => {
    deny(await write(`competitions/${C}/controls/${P}/scores/${PAT}`, { patrolId: PAT, tidSek: 125, reporter: 'x' }, null), 'tid på poängkontroll');
    deny(await write(`competitions/${C}/controls/${P}/scores/${PAT}`, { patrolId: PAT, poang: 7, ejGenomford: true, reporter: 'x' }, null), 'ej genomförd på poängkontroll');
    allow(await write(`competitions/${C}/controls/${P}/scores/${PAT}`, { patrolId: PAT, poang: 7, reporter: 'x' }, null), 'poäng som förut');
  });

  test('ledningen fördelar poängen — även på en stängd kontroll', async () => {
    await seed(`competitions/${C}/controls/${T}/scores/${PAT}`, { patrolId: PAT, tidSek: 125, extraPoang: 1 });
    allow(await write(`competitions/${C}/controls/${T}/scores/${PAT}`, { poang: 8, poangFranTid: true }, USER, { merge: true }), 'admin fördelar');
    deny(await write(`competitions/${C}/controls/${T}/scores/${PAT}`, { poang: 8, poangFranTid: true }, OTHER, { merge: true }), 'utomstående fördelar');
    deny(await write(`competitions/${C}/controls/${T}/scores/${PAT}`, { poang: 8, poangFranTid: true }, null, { merge: true }), 'anonym fördelar');
  });
});

describe('Komplettering per patrull', () => {
  const TOK = uniq('tok');
  const path = `competitions/${CID}/kompletteringar/${TOK}`;
  const bas = { patrol: 'Rävarna', antal: 0, allergier: '', kontakt: '', ovrigt: '' };

  before(async () => { await seed(path, bas); });

  test('den som har token fyller i sin egen patrull', async () => {
    allow(await write(path, { antal: 5, allergier: 'Nötter', ifylltAt: new Date().toISOString() },
      null, { merge: true }), 'anonym komplettering');
  });

  test('patrullnamnet går inte att skriva om', async () => {
    // Namnet är kårledarens. Kunde det skrivas om skulle raden döpas om till
    // en patrull som inte finns i anmälan.
    deny(await write(path, { patrol: 'Någon annan' }, null, { merge: true }), 'byta patrull');
  });

  test('formen vaktas', async () => {
    deny(await write(path, { antal: 99 }, null, { merge: true }), 'orimligt antal');
    deny(await write(path, { antal: -1 }, null, { merge: true }), 'negativt antal');
    deny(await write(path, { allergier: 'x'.repeat(501) }, null, { merge: true }), 'för lång text');
    deny(await write(path, { hittepa: 'x' }, null, { merge: true }), 'okänt fält');
  });

  test('kompletteringen bär ALDRIG regId — annars är token utbytbar mot anmälningslänken', async () => {
    // Doc-id:t är öppet läsbart (token ÄR hemligheten). Låg regId här kunde
    // patrulledaren läsa ut det ur svaret och öppna /a/<cid>/<regId> med läs-
    // OCH skrivrätt till kårens alla patruller, kontakter och betalningar.
    deny(await write(`competitions/${CID}/kompletteringar/${uniq('t')}`,
      { ...bas, regId: 'reg-1' }, null), 'regId i kompletteringen');
    deny(await write(`competitions/${CID}/kompletteringar/${TOK}`,
      { regId: 'reg-1' }, null, { merge: true }), 'smyga in regId efteråt');
  });

  test('kårledaren skapar länkarna anonymt — men bara tomma rader', async () => {
    allow(await write(`competitions/${CID}/kompletteringar/${uniq('t')}`,
      { patrol: 'Rävarna', antal: 0, allergier: '', kontakt: '', ovrigt: '' }, null),
      'anonym skapar tom rad');
    deny(await write(`competitions/${CID}/kompletteringar/${uniq('t')}`,
      { patrol: 'Rävarna', hittepa: 'x' }, null), 'okänt fält');
    assert.equal((await remove(`competitions/${CID}/kompletteringar/${TOK}`, OTHER)).ok, false, 'utomstående raderar');
  });

  test('list är member-only — annars kan varje patrulls allergier räknas upp', async () => {
    assert.equal((await list(`competitions/${CID}/kompletteringar`, null)).ok, false, 'anonym listar');
    assert.equal((await list(`competitions/${CID}/kompletteringar`, OTHER)).ok, false, 'utomstående listar');
    assert.equal((await list(`competitions/${CID}/kompletteringar`, USER)).ok, true, 'medlem listar');
    // ...men den som HAR sin token kommer åt just sin
    assert.equal((await read(path, null)).ok, true, 'anonym med token läser sin egen');
  });
});

describe('Papperskorgen', () => {
  const path = `competitions/${CID}/papperskorg/${uniq('k')}`;
  const post = { sort: 'patrull', ursprungsId: PATROL, raderadAt: new Date(),
                 data: { name: 'Rävarna', number: 1 }, poang: [] };

  test('bara admin når den — en raderad patrull är inte läsbarare än en levande', async () => {
    allow(await write(path, post, USER), 'admin skriver');
    assert.equal((await read(path, USER)).ok, true, 'admin läser');
    assert.equal((await read(path, null)).ok, false, 'anonym läser');
    assert.equal((await read(path, OTHER)).ok, false, 'utomstående läser');
    deny(await write(`competitions/${CID}/papperskorg/${uniq('k')}`, post, null), 'anonym skriver');
    deny(await write(`competitions/${CID}/papperskorg/${uniq('k')}`, post, OTHER), 'utomstående skriver');
  });

  test('en kontroll i papperskorgen tar INTE emot poäng — hela skälet till flytten', async () => {
    // Papperskorgen FLYTTAR dokumentet i stället för att flagga det. En
    // `deleted: true`-flagga hade lämnat kontrolldokumentet kvar, och den
    // anonyma poängvägen vaktas av `open == true` — inte av någon flagga. Den
    // hemliga QR-länken hade alltså fortsatt ta emot rapporter från en
    // kontroll ledningen tagit bort.
    const BORTA = uniq('ctrl');
    deny(await write(`competitions/${CID}/controls/${BORTA}/scores/${PATROL}`,
      { patrolId: PATROL, poang: 5, reportedAt: new Date() }, null),
      'poäng till en kontroll som inte finns');

    // ...och för jämförelse: samma skrivning mot en LEVANDE öppen kontroll går.
    allow(await write(`competitions/${CID}/controls/${CTRL}/scores/${PATROL}`,
      { patrolId: PATROL, poang: 5, reportedAt: new Date() }, null),
      'poäng till en öppen kontroll');
  });

  test('list är inte öppen — korgen namnger patruller och bär telefonnummer', async () => {
    assert.equal((await list(`competitions/${CID}/papperskorg`, null)).ok, false, 'anonym listar');
    assert.equal((await list(`competitions/${CID}/papperskorg`, OTHER)).ok, false, 'utomstående listar');
    assert.equal((await list(`competitions/${CID}/papperskorg`, USER)).ok, true, 'admin listar');
  });
});

describe('Demospårets läsrättigheter', () => {
  // Demot är kontofritt: en besökare utan inloggning ska se ESKIL:s funktioner,
  // inte tomma kolumner. Grenarna hänger på compIsDemo — ALDRIG på ett
  // tävlings-id — och får aldrig läcka över på en riktig tävling.
  const D = uniq('demo');
  const S = uniq('skarp');

  before(async () => {
    for (const [cid, demo] of [[D, true], [S, false]]) {
      await seed(`competitions/${cid}`, { name: 'T', demo, closed: false });
      await seed(`competitions/${cid}/controls/${CTRL}`, { name: 'K', nummer: 1, open: true });
      await seed(`competitions/${cid}/controls/${CTRL}/private/meta`, { telefon: '070-000 00 01' });
      await seed(`competitions/${cid}/controls/${CTRL}/beacon/enhet1`, { batteri: 42 });
      await seed(`competitions/${cid}/patrols/${PATROL}`, { name: 'P', number: 1 });
      await seed(`competitions/${cid}/registrations/r1`, { kar: 'Lindsdals Scoutkår' });
      await seed(`competitions/${cid}/threads/kontroll-${CTRL}`, { kind: 'kontroll', refId: CTRL });
      await seed(`competitions/${cid}/threads/kontroll-${CTRL}/messages/m1`, { from: 'falt', text: 'Hej' });
    }
  });
  after(async () => {
    for (const cid of [D, S]) {
      for (const p of [
        `competitions/${cid}/threads/kontroll-${CTRL}/messages/m1`, `competitions/${cid}/threads/kontroll-${CTRL}`,
        `competitions/${cid}/registrations/r1`, `competitions/${cid}/patrols/${PATROL}`,
        `competitions/${cid}/controls/${CTRL}/beacon/enhet1`, `competitions/${cid}/controls/${CTRL}/private/meta`,
        `competitions/${cid}/controls/${CTRL}`, `competitions/${cid}`
      ]) await remove(p, 'owner');
    }
  });

  const ytor = [
    ['kontrollens telefon (nödinfon)', (cid) => `competitions/${cid}/controls/${CTRL}/private/meta`, 'get'],
    ['kontrollens livstecken', (cid) => `competitions/${cid}/controls/${CTRL}/beacon/enhet1`, 'get'],
    ['fälttrådens huvud', (cid) => `competitions/${cid}/threads/kontroll-${CTRL}`, 'get'],
    ['fälttrådens meddelanden', (cid) => `competitions/${cid}/threads/kontroll-${CTRL}/messages`, 'list'],
    ['anmälningslistan', (cid) => `competitions/${cid}/registrations`, 'list']
  ];

  for (const [namn, väg, op] of ytor) {
    test(`demo visar ${namn}`, async () => {
      const r = op === 'list' ? await list(väg(D), null) : await read(väg(D), null);
      assert.equal(r.ok, true, `${namn} på demospår`);
    });
    test(`men en RIKTIG tävling gör det inte — ${namn}`, async () => {
      const r = op === 'list' ? await list(väg(S), null) : await read(väg(S), null);
      assert.equal(r.ok, false, `${namn} på skarp tävling`);
    });
  }
});

describe('faltinfo — ledningens interna kontakter mot fältet', () => {
  // Spegeln som gör att /k kan visa nödkontakterna medan /t inte kan.
  // Doc-id:t ÄR kontrollens threadToken, alltså "id:t är hemligheten".
  const F = uniq('falt');
  const STANGD = uniq('stangd');
  const DEMO = uniq('fdemo');
  const TOKEN = 'tok-hemlig-abc123';
  // Identiteterna är { uid, email } — helpers.js mintar en osignerad JWT av dem.
  const FADMIN = { uid: uniq('uid-fadmin'), email: 'fadmin@x.se' };
  const FMEDLEM = { uid: uniq('uid-fmedlem'), email: 'fmedlem@x.se' };
  const FUTOM = { uid: uniq('uid-futom'), email: 'futom@x.se' };

  before(async () => {
    for (const [cid, extra] of [[F, {}], [STANGD, { closed: true }], [DEMO, { demo: true }]]) {
      await seed(`competitions/${cid}`, { name: 'T', closed: false, demo: false, ...extra });
      await seed(`competitions/${cid}/private/access`, { adminEmails: [FADMIN.email], userEmails: [FMEDLEM.email] });
      await seed(`competitions/${cid}/faltinfo/${TOKEN}`, {
        internPii: { sekr: { name: 'Bo Berg', phone: '070-444 55 66', email: '' } }
      });
    }
  });
  after(async () => {
    for (const cid of [F, STANGD, DEMO]) {
      await remove(`competitions/${cid}/faltinfo/${TOKEN}`, 'owner');
      await remove(`competitions/${cid}/private/access`, 'owner');
      await remove(`competitions/${cid}`, 'owner');
    }
  });

  test('anonym GET med token fungerar — det ÄR nödvägen på /k', async () => {
    const r = await read(`competitions/${F}/faltinfo/${TOKEN}`, null);
    assert.equal(r.ok, true, 'kontrollanten i skogen måste nå kontakterna');
    assert.ok(JSON.stringify(r.data).includes('070-444'), 'numret ska faktiskt komma med');
  });

  test('anonym LIST är NEKAD — annars räknas nycklarna till fältsamtalen upp', async () => {
    // Det här är testet som bär hela get/list-uppdelningen. Doc-id:t är
    // kontrollens threadToken, så en listbar faltinfo lämnar ut nycklarna till
    // trådarna — nödropens GPS-position och bilderna från skogen. Ett
    // `allow read: if true` hade alltså inte varit en gradskillnad.
    assert.equal((await list(`competitions/${F}/faltinfo`, null)).ok, false,
      'faltinfo gick att räkna upp anonymt');
  });

  test('inloggad utomstående får inte heller lista', async () => {
    assert.equal((await list(`competitions/${F}/faltinfo`, FUTOM)).ok, false);
  });

  test('medlem får lista — fan-outen behöver det', async () => {
    assert.equal((await list(`competitions/${F}/faltinfo`, FMEDLEM)).ok, true,
      'utan list kan speglarna inte skrivas om när ledningen ändras');
  });

  test('anonym skrivning är nekad', async () => {
    assert.equal((await write(`competitions/${F}/faltinfo/${TOKEN}`, { internPii: {} }, null)).ok, false);
  });

  test('anonym radering är nekad', async () => {
    assert.equal((await remove(`competitions/${F}/faltinfo/${TOKEN}`, null)).ok, false);
  });

  test('admin får skriva rätt form', async () => {
    assert.equal((await write(`competitions/${F}/faltinfo/${TOKEN}`,
      { internPii: { sekr: { name: 'Bo', phone: '070', email: '' } }, uppdaterad: '2026-08-17' },
      FADMIN)).ok, true);
  });

  test('formvakten nekar främmande fält', async () => {
    // Utan hasOnly kan en admin lägga vad som helst i ett VÄRLDSLÄSBART
    // dokument — t.ex. anmälningarnas kontaktuppgifter.
    assert.equal((await write(`competitions/${F}/faltinfo/${TOKEN}`,
      { internPii: {}, allergier: 'nötter' }, FADMIN)).ok, false,
      'ett fält utanför formen släpptes in');
  });

  test('en AVSLUTAD tävling tar inte emot skrivningar', async () => {
    // closeCompetition raderar speglarna vid gallringen. Kunde de skrivas
    // tillbaka efteråt vore gallringen meningslös.
    assert.equal((await write(`competitions/${STANGD}/faltinfo/${TOKEN}`,
      { internPii: {} }, FADMIN)).ok, false);
  });

  test('demotävlingen nekar skrivning men TILLÅTER läsning', async () => {
    assert.equal((await write(`competitions/${DEMO}/faltinfo/${TOKEN}`,
      { internPii: {} }, FADMIN)).ok, false, 'demo ska neka varje skrivning');
    assert.equal((await read(`competitions/${DEMO}/faltinfo/${TOKEN}`, null)).ok, true,
      'demots /k måste kunna visa kontakterna — get: if true täcker det utan egen demogren');
  });
});

describe('Överlämningskoder — bara tävlingens admin skapar, bara servern löser in', () => {
  const C = uniq('comp');
  const ANNAN = uniq('comp');
  const DEMO = uniq('comp');
  const hash = () => [...Array(64)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const bas = (cid) => ({ cid, skapad: new Date().toISOString(), skapadAv: USER.email });
  const H = hash();

  before(async () => {
    await seed(`competitions/${C}`, { name: 'Min', demo: false, closed: true });
    await seed(`competitions/${C}/private/access`, { adminEmails: [USER.email], userEmails: [], ekonomiEmails: [] });
    await seed(`competitions/${ANNAN}`, { name: 'Någon annans', demo: false, closed: true });
    await seed(`competitions/${ANNAN}/private/access`, { adminEmails: [OTHER.email], userEmails: [], ekonomiEmails: [] });
    await seed(`competitions/${DEMO}`, { name: 'Demo', demo: true });
    await seed(`competitions/${DEMO}/private/access`, { adminEmails: [USER.email], userEmails: [], ekonomiEmails: [] });
    await seed(`overlamningskoder/${H}`, bas(C));
  });

  test('admin skapar en kod för SIN tävling — aldrig för någon annans, aldrig anonymt', async () => {
    allow(await write(`overlamningskoder/${hash()}`, bas(C), USER), 'admin skapar kod');
    deny(await write(`overlamningskoder/${hash()}`, bas(ANNAN), USER), 'kod som pekar på någon annans tävling');
    deny(await write(`overlamningskoder/${hash()}`, bas(C), OTHER), 'utomstående skapar kod för min tävling');
    deny(await write(`overlamningskoder/${hash()}`, bas(C), null), 'anonym skapar kod');
    deny(await write(`overlamningskoder/${hash()}`, bas(DEMO), USER), 'kod för demotävling');
  });

  test('formen är låst: bara de tre fälten, och id:t måste vara en sha256', async () => {
    deny(await write(`overlamningskoder/${hash()}`, { ...bas(C), anvand: null }, USER), 'eget anvand-fält');
    deny(await write(`overlamningskoder/${hash()}`, { ...bas(C), extra: 1 }, USER), 'okänt fält');
    deny(await write(`overlamningskoder/ABCD-EFGH-2345`, bas(C), USER), 'klartextkod som id');
    deny(await write(`overlamningskoder/${hash().slice(0, 40)}`, bas(C), USER), 'för kort hash');
  });

  test('en kod går aldrig att skriva om från en klient — inte ens av admin', async () => {
    deny(await write(`overlamningskoder/${H}`, { ...bas(C), skapadAv: 'annan@test.se' }, USER), 'admin skriver om koden');
    deny(await write(`overlamningskoder/${H}`, bas(ANNAN), OTHER), 'kapa koden till en annan tävling');
  });

  test('läsning: admin får sin egen, ingen får lista', async () => {
    allow(await read(`overlamningskoder/${H}`, USER), 'admin läser sin kod');
    deny(await read(`overlamningskoder/${H}`, OTHER), 'utomstående läser koden');
    deny(await read(`overlamningskoder/${H}`, null), 'anonym läser koden');
    deny(await list('overlamningskoder', USER), 'admin listar koder');
    deny(await list('overlamningskoder', SUPER), 'super-admin listar koder');
  });

  test('admin drar in sin kod; ingen annan kan', async () => {
    deny(await remove(`overlamningskoder/${H}`, OTHER), 'utomstående drar in koden');
    deny(await remove(`overlamningskoder/${H}`, null), 'anonym drar in koden');
    allow(await remove(`overlamningskoder/${H}`, USER), 'admin drar in koden');
  });
});
