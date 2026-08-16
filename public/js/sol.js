// Solnedgång — ren astronomi (NOAA:s algoritm), inget API och därmed inget
// nätberoende: mörkerlarmet i Läget ska fungera även när sekretariatets
// uppkoppling är seg. Precisionen är ±ett par minuter, vilket är gott nog
// för frågan "hinner patrullerna ur skogen innan det blir mörkt?".
//
// Ren logik — testas i test/logic.test.js.

const RAD = Math.PI / 180;

/**
 * Solnedgången för ett datum på en plats.
 * @param {Date} datum  dagen (lokal tid); klockslaget i objektet ignoreras
 * @param {number} lat
 * @param {number} lng
 * @returns {Date|null} solnedgången, eller null i polarnatt/midnattssol
 */
export function solnedgang(datum, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const start = new Date(datum.getFullYear(), 0, 0);
  const doy = Math.floor((datum - start) / 86400000);

  // NOAA "fractional year" mitt på dagen.
  const g = (2 * Math.PI / 365) * (doy - 1 + 0.5);
  const eqtime = 229.18 * (0.000075
    + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918
    - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);

  // Timvinkeln vid solnedgång (zenit 90,833° — horisonten + refraktion).
  const cosHa = Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(decl))
    - Math.tan(lat * RAD) * Math.tan(decl);
  if (cosHa < -1 || cosHa > 1) return null;   // midnattssol resp. polarnatt
  const ha = Math.acos(cosHa) / RAD;

  // Minus ha ger solNEDgången — plus ha är soluppgången (första försöket gav
  // exakt Stockholms sommarsoluppgång, vilket var så felet upptäcktes).
  const utcMin = 720 - 4 * (lng - ha) - eqtime;
  const d = new Date(Date.UTC(datum.getFullYear(), datum.getMonth(), datum.getDate()));
  d.setUTCMinutes(Math.round(utcMin));
  return d;
}
