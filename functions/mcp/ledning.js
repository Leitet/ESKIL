// Uppdelningen av tävlingsledningen, serversidan.
//
// DETTA ÄR EN DUBBLETT av splitManagement() i public/js/utils.js, och det är
// ett medvetet men motvilligt val: functions är CommonJS (Node 20,
// "main": "index.js") medan publikkoden är ES-moduler, och en dynamisk import
// av en ESM-fil in i en trigger är mer maskineri än den här funktionen är värd.
//
// DUBBLETTEN ÄR INTE OBEVAKAD. `test/mcp.test.js` kör BÅDA implementationerna
// mot samma indata och kräver identiskt utfall. Divergerar de faller testet.
// Ändrar du den ena: ändra den andra, och låt testet bevisa att du gjorde det.
//
// Gränsen mellan struktur och personuppgift är densamma som closeCompetition
// redan drar vid GDPR-gallringen: id, label, visibility och ekonomi stannar;
// name, phone och email flyttas.

const STRUKTUR = ['id', 'label', 'visibility', 'ekonomi'];
const PII = ['name', 'phone', 'email'];

/**
 * @returns { publikt, internPii }
 *   publikt   – hela rollstrukturen; PII kvar bara för PUBLIKA roller.
 *   internPii – { rollId: {name, phone, email} } för interna roller med något ifyllt.
 */
function delaLedning(management) {
  const roller = Array.isArray(management) ? management : [];
  const publikt = [];
  const internPii = {};
  for (const r of roller) {
    const bas = {};
    for (const k of STRUKTUR) bas[k] = k === 'ekonomi' ? (r.ekonomi === true) : (r[k] ?? '');
    bas.visibility = r.visibility === 'internal' ? 'internal' : 'public';
    if (bas.visibility === 'internal') {
      const pii = {};
      let nagot = false;
      for (const k of PII) {
        const v = (r[k] || '').trim();
        pii[k] = v;
        if (v) nagot = true;
      }
      if (nagot && bas.id) internPii[bas.id] = pii;
    } else {
      for (const k of PII) bas[k] = r[k] || '';
    }
    publikt.push(bas);
  }
  return { publikt, internPii };
}

module.exports = { delaLedning, STRUKTUR, PII };
