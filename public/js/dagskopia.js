// Dagskopia — en lokal ögonblicksbild av tävlingsdagen medan Läget är öppet.
//
// Ingen hinner ladda ner en backup mitt i kaoset, och det är just då datan är
// som mest oersättlig: en dags poängrapportering går inte att göra om.
//
// DEN HÄR ÄR INTE EN BACKUP, och får aldrig kallas så i gränssnittet.
// Den byggs ur de snapshots Läget REDAN prenumererar på — patruller,
// kontroller, poäng, avprickningar — vilket gör den gratis i läskvot men också
// ofullständig: anmälningar, utskick, överlämningsdokument, patrullernas
// private/meta och andra stationers passeringar finns inte med. Den ersätter
// alltså inte dumpCompetition().
//
// Därför stämplar den ALDRIG comp.lastBackupAt. Gjorde den det skulle
// avsluta-dialogen och raderingsskyddet tro att en riktig backup finns, och
// den som raderar tävlingen skulle förlora allt det som saknas ovan.

const DB = 'eskil-dagskopia';
const STORE = 'kopior';
const BEHALL = 8;            // rullande fönster — äldre kastas
export const KOPIA_INTERVALL_MS = 5 * 60000;

function öppna() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'nyckel' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const tx = (db, läge) => db.transaction(STORE, läge).objectStore(STORE);

/**
 * Bygger ögonblicksbilden ur det vyn redan har i minnet.
 * Ren funktion — inga anrop, inga sidoeffekter, testbar.
 */
export function byggDagskopia({ comp, patrols, controls, scoresByCtrl, passages, selfPassages }, nu = new Date()) {
  return {
    sort: 'dagskopia',          // INTE 'backup' — se filhuvudet
    version: 1,
    skapad: nu.toISOString(),
    ofullstandig: [
      'anmälningar', 'utskick', 'överlämningsdokument',
      'patrullernas noteringar', 'kontrollernas telefonnummer'
    ],
    tavling: comp ? { id: comp.id, name: comp.name, shortName: comp.shortName, year: comp.year, date: comp.date } : null,
    patruller: (patrols || []).map(p => ({
      id: p.id, number: p.number, name: p.name, avdelning: p.avdelning, kar: p.kar,
      utgatt: p.utgatt || null
    })),
    kontroller: (controls || []).map(c => ({
      id: c.id, nummer: c.nummer, name: c.name, open: c.open,
      maxPoang: c.maxPoang, minPoang: c.minPoang, extraPoang: c.extraPoang
    })),
    poang: Object.entries(scoresByCtrl || {}).flatMap(([ctrlId, rader]) =>
      (rader || []).map(s => ({
        controlId: ctrlId, patrolId: s.patrolId,
        poang: s.poang, extraPoang: s.extraPoang,
        note: s.note || '', reporter: s.reporter || '',
        utslagGissning: s.utslagGissning ?? null,
        clientReportedAt: iso(s.clientReportedAt),
        reportedAt: iso(s.reportedAt)
      }))),
    avprickningar: Object.entries(passages || {}).map(([patrolId, p]) => ({
      patrolId, startAt: iso(p?.startAt), finishAt: iso(p?.finishAt),
      selfStarted: !!p?.selfStarted, selfFinished: !!p?.selfFinished, autoFinished: !!p?.autoFinished
    })),
    egnaAvprickningar: Object.entries(selfPassages || {}).map(([patrolId, p]) => ({
      patrolId, startAt: iso(p?.startAt), finishAt: iso(p?.finishAt)
    }))
  };
}

function iso(v) {
  if (!v) return null;
  const d = v?.toDate ? v.toDate() : new Date(v);
  return Number.isFinite(d?.getTime?.()) ? d.toISOString() : null;
}

export async function sparaDagskopia(cid, kopia) {
  const db = await öppna();
  await new Promise((res, rej) => {
    // Nyckeln har MINUTupplösning. Poängen droppar in en kontroll i taget, och
    // varje sådan berikning sparar en kopia — med sekundupplösning fylldes hela
    // det rullande fönstret på nio sekunder, och "8 sparade" såg ut som en
    // historik över dagen fast alla var från samma ögonblick. Samma minut
    // skriver nu över sig själv, så fönstret spänner över riktig tid.
    const minut = kopia.skapad.slice(0, 16);
    const r = tx(db, 'readwrite').put({ nyckel: `${cid}:${minut}`, cid, skapad: kopia.skapad, kopia });
    r.onsuccess = res; r.onerror = () => rej(r.error);
  });
  // Rullande fönster: en tävlingsdag ska inte fylla telefonens lagring.
  const alla = await listaDagskopior(cid);
  const gamla = alla.slice(BEHALL);
  if (gamla.length) {
    const store = tx(await öppna(), 'readwrite');
    gamla.forEach(k => store.delete(k.nyckel));
  }
  db.close();
}

export async function listaDagskopior(cid) {
  const db = await öppna();
  const rader = await new Promise((res, rej) => {
    const r = tx(db, 'readonly').getAll();
    r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
  });
  db.close();
  return rader.filter(r => r.cid === cid).sort((a, b) => String(b.skapad).localeCompare(String(a.skapad)));
}

export async function taBortDagskopior(cid) {
  const alla = await listaDagskopior(cid);
  const db = await öppna();
  const store = tx(db, 'readwrite');
  alla.forEach(k => store.delete(k.nyckel));
  db.close();
}
