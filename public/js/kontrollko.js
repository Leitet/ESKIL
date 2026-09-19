// Kontrollkortets patrullordning — ren, så att den går att testa utan sida.
//
// Rutnätet på /k sorterades på patrullnummer, med rapporterade sist. Men den
// som står på kontroll 4 vill inte läsa en lista: hen vill hitta patrullen som
// just kom ut ur skogen. Och den patrullen går nästan alltid att förutse —
// det är en av dem som lämnat kontroll 3 men inte rapporterats här.
//
// Fyra grupper, i den här ordningen:
//
//   vantas  — på väg hit. Har lämnat föregående kontroll (för banans första
//             kontroll: har startat) och är inte rapporterad här. Sorterade
//             efter NÄR de lämnade, tidigast först: det är ankomstordningen.
//   ovriga  — inte rapporterade och inte väntade än. Startordning.
//   klara   — rapporterade här. Startordning.
//   utgatt  — har brutit. Sist; de kommer inte, men går att rapportera om de
//             hann göra kontrollen innan de bröt.
//
// "Väntas" är en GISSNING och får aldrig bli en spärr: en patrull som hoppat
// över föregående kontroll, eller vars rapport därifrån ligger i en telefon
// utan täckning, står under "övriga" och går att rapportera precis som förut.
// Banan antas gå i nummerordning — samma antagande som Läget och ETA-motorn.

const arTal = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

// Firestore-Timestamp, Date, ISO-sträng eller millisekunder → ms (eller null).
export function tillMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'object' && Number.isFinite(v.seconds)) return v.seconds * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// Var i banan ligger kontrollen? `foregaende` är kontrollen med närmast LÄGRE
// nummer — inte "raden ovanför": två kontroller med samma nummer (startklar.js
// varnar för det) får då samma föregångare i stället för att peka på varandra.
// `kand: false` när kontrollen saknar nummer; då går inget att förutse.
export function platsIBanan(controls, ctrlId) {
  const jag = (controls || []).find(c => c.id === ctrlId);
  if (!jag || !arTal(jag.nummer)) return { kand: false, forsta: false, foregaende: null };
  const mitt = Number(jag.nummer);
  let fore = null;
  for (const c of controls) {
    if (c.id === ctrlId || !arTal(c.nummer)) continue;
    const n = Number(c.nummer);
    if (n >= mitt) continue;
    if (!fore || n > Number(fore.nummer) || (n === Number(fore.nummer) && String(c.id) < String(fore.id))) fore = c;
  }
  return { kand: true, forsta: !fore, foregaende: fore };
}

// När passerade patrullen? Knapptryckets tid före synkögonblicket — en
// offline-kö som töms i klump ger alla samma reportedAt (se CLAUDE.md).
export const passertid = (score) => tillMs(score?.clientReportedAt) ?? tillMs(score?.reportedAt);

// Startordningen: platsen i startlistan, sedan patrullnummer, sedan namn.
// En patrull utan plats (nyss tillagd, startlistan inte satt) hamnar sist i
// sin grupp i stället för först — Number(undefined) är NaN, och NaN i en
// jämförelse gör sorteringen godtycklig.
export function iStartordning(a, b) {
  const ao = arTal(a?.startOrder) ? Number(a.startOrder) : Infinity;
  const bo = arTal(b?.startOrder) ? Number(b.startOrder) : Infinity;
  if (ao !== bo) return ao - bo;
  const an = arTal(a?.number) ? Number(a.number) : Infinity;
  const bn = arTal(b?.number) ? Number(b.number) : Infinity;
  if (an !== bn) return an - bn;
  return String(a?.name || '').localeCompare(String(b?.name || ''), 'sv');
}

/**
 * @param patrols      patrullerna (redan filtrerade på avdelning/sökning)
 * @param rapporterade Set med patrolId som har en rapport HÄR (även köade)
 * @param lamnat       Map patrolId → ms då patrullen lämnade föregående
 *                     kontroll / startade. null = vi vet inget → ingen väntas.
 * @param nu           ms; en tid i FRAMTIDEN räknas inte (planerad start som
 *                     inte inträffat än)
 * @returns [{ patrol, grupp, sedanMs }] i visningsordning
 */
export function ordnaPatruller({ patrols = [], rapporterade = new Set(), lamnat = null, nu = Date.now() } = {}) {
  const rader = patrols.map((patrol) => {
    if (patrol.utgatt) return { patrol, grupp: 'utgatt', sedanMs: null };
    if (rapporterade.has(patrol.id)) return { patrol, grupp: 'klara', sedanMs: null };
    const t = lamnat ? lamnat.get(patrol.id) : null;
    if (Number.isFinite(t) && t <= nu) return { patrol, grupp: 'vantas', sedanMs: t };
    return { patrol, grupp: 'ovriga', sedanMs: null };
  });
  const rang = { vantas: 0, ovriga: 1, klara: 2, utgatt: 3 };
  return rader.sort((a, b) => {
    if (a.grupp !== b.grupp) return rang[a.grupp] - rang[b.grupp];
    if (a.grupp === 'vantas' && a.sedanMs !== b.sedanMs) return a.sedanMs - b.sedanMs;
    return iStartordning(a.patrol, b.patrol);
  });
}

// "för 12 min sedan" — kort nog för en ruta i rutnätet.
export function sedanText(sedanMs, nu = Date.now()) {
  if (!Number.isFinite(sedanMs)) return '';
  const min = Math.max(0, Math.round((nu - sedanMs) / 60000));
  if (min < 1) return 'nyss';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// Samma sak som en fras: "lämnade 1:an för 12 min sedan" / "… nyss". Egen
// funktion för att "för nyss sedan" inte ska gå att skriva av misstag.
export function sedanFras(sedanMs, nu = Date.now()) {
  const t = sedanText(sedanMs, nu);
  return !t || t === 'nyss' ? t : `för ${t} sedan`;
}

// Demospårets klocka. Demot är EN frusen ögonblicksbild mitt i en tävling, och
// dess tidsstämplar åldras: mot den riktiga klockan hade "lämnade 5:an" stått
// som "för 900 h sedan" i produktion. Samma lösning som Läget och
// stationssidan — klockan pinnas fem minuter efter det senaste som hänt.
// Utan en enda tidsstämpel finns inget att pinna mot; då gäller riktig tid.
export function demoNu(tidsstamplar, riktigNu = Date.now()) {
  let max = null;
  for (const t of tidsstamplar || []) if (Number.isFinite(t) && (max === null || t > max)) max = t;
  return max === null ? riktigNu : max + 5 * 60000;
}
