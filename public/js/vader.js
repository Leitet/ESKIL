// Väder för tävlingsdagen — åska, regn och byvind.
//
// Åska upptäcks annars genom fönstret, och den som står på en kontroll i skogen
// har inget fönster. Panelen i Läget visar vad som är på väg och kan förifylla
// ett kritiskt driftmeddelande till fältet.
//
// VAL AV TJÄNST. Förbättringslistan pekade på SMHI:s `pmp3g`. Den svarar 404 —
// hela värden opendata-download-metfcst.smhi.se ger 404 på varje sökväg,
// inklusive API-roten, medan smhi.se svarar 200. MET Norway fungerar men kräver
// en identifierande User-Agent, och den får en webbläsare inte sätta. Kvar blev
// Open-Meteo: nyckelfri, CORS-öppen och utan registrering. Värden är vitlistad
// i firebase.json (connect-src) — utan det blockerar CSP:n anropet.
//
// ALLT HÄR MÅSTE DEGRADERA TYST. En tävlingsdag får aldrig hänga på en extern
// tjänst: kan vi inte hämta väder visas inget kort, och inget larm.

// Enheten på byvinden är km/h som standard. Vi ber uttryckligen om m/s —
// annars ser en normal bris (44 km/h ≈ 12 m/s) ut som halv storm.
const BAS = 'https://api.open-meteo.com/v1/forecast';

// WMO-koder. Bara de vi faktiskt agerar på; resten är "inget särskilt".
// 95 = åska, 96 och 99 = åska med hagel.
const ASKKODER = new Set([95, 96, 99]);
// 65/67/82 = kraftigt regn respektive kraftiga skurar.
const HÄLLREGN = new Set([65, 67, 82]);

export const ASKA_KODER = ASKKODER;

// Trösklar. Byvind i m/s: 15 m/s knäcker grenar och gör tältresning svår —
// det är den nivå en tävlingsledning vill veta om i förväg.
export const BY_VARNING_MS = 15;
export const REGN_VARNING_MM = 5;   // mm under ett dygn

/**
 * Tolkar ett Open-Meteo-svar till det Läget behöver veta.
 * Ren funktion — inga anrop, inga sidoeffekter, testbar utan nät.
 *
 * @param data  hourly-svaret från Open-Meteo
 * @param nu    tidpunkt att räkna "kommande timmar" från
 * @returns null när underlaget saknas — anroparen visar då inget kort alls.
 */
export function tolkaVader(data, nu = new Date()) {
  const h = data?.hourly;
  if (!h || !Array.isArray(h.time) || !h.time.length) return null;

  const nuMs = nu.getTime();
  const timmar = h.time.map((t, i) => ({
    // Open-Meteo returnerar lokal tid utan zon-suffix när timezone anges.
    tid: new Date(t),
    nederbord: Number(h.precipitation?.[i]) || 0,
    kod: Number(h.weather_code?.[i]),
    by: Number(h.wind_gusts_10m?.[i]) || 0
  })).filter(x => Number.isFinite(x.tid.getTime()));

  // Bara framåt. Timmar som passerat säger inget om vad man ska göra nu.
  const kvar = timmar.filter(x => x.tid.getTime() >= nuMs - 3600000);
  if (!kvar.length) return null;

  const aska = kvar.find(x => ASKKODER.has(x.kod)) || null;
  const regn = kvar.reduce((s, x) => s + x.nederbord, 0);
  const maxBy = Math.max(...kvar.map(x => x.by));
  const byTimme = kvar.find(x => x.by === maxBy) || null;

  const larm = [];
  if (aska) {
    larm.push({
      niva: 'kritisk',
      rubrik: 'Åska väntas',
      text: `Åska väntas från cirka kl ${klocka(aska.tid)}.`,
      vid: aska.tid
    });
  }
  if (maxBy >= BY_VARNING_MS) {
    larm.push({
      niva: 'varning',
      rubrik: 'Kraftiga vindbyar',
      text: `Byvindar upp till ${Math.round(maxBy)} m/s kring kl ${klocka(byTimme.tid)}.`,
      vid: byTimme?.tid || null
    });
  }
  if (regn >= REGN_VARNING_MM || kvar.some(x => HÄLLREGN.has(x.kod))) {
    larm.push({
      niva: 'varning',
      rubrik: 'Mycket regn',
      text: `Totalt cirka ${regn.toFixed(1)} mm nederbörd väntas.`,
      vid: null
    });
  }

  return {
    aska: !!aska,
    askaVid: aska?.tid || null,
    regnMm: Math.round(regn * 10) / 10,
    maxByMs: Math.round(maxBy * 10) / 10,
    larm,
    // Åska är det enda som motiverar att bryta ett moment.
    varsta: larm.some(l => l.niva === 'kritisk') ? 'kritisk' : (larm.length ? 'varning' : 'lugnt')
  };
}

function klocka(d) {
  return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}

// Förslag på driftmeddelande. Ledningen får texten förifylld men skickar den
// själv — ett automatiskt utskick till alla kontroller vid varje prognosryck
// vore precis det som får folk att sluta läsa meddelanden.
export function vaderMeddelande(v) {
  if (!v?.aska) return null;
  return v.askaVid
    ? `Åska väntas från cirka kl ${klocka(v.askaVid)}. Avbryt moment med höjdrisk, sök inte skydd under enstaka träd, och invänta besked.`
    : 'Åska är på väg in. Avbryt moment med höjdrisk och invänta besked.';
}

/**
 * Hämtar prognosen. Kastar aldrig — vid fel returneras null och anroparen
 * visar inget kort.
 */
export async function hamtaVader(lat, lng, { signal } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // Högst sex decimaler: fler ger onödigt långa URL:er och sämre cache-träff,
  // och kartklick ger lätt tio–femton.
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lng.toFixed(4),
    hourly: 'precipitation,weather_code,wind_gusts_10m',
    wind_speed_unit: 'ms',
    forecast_days: '1',
    timezone: 'Europe/Stockholm'
  });
  try {
    const r = await fetch(`${BAS}?${q}`, { signal });
    if (!r.ok) return null;
    return tolkaVader(await r.json());
  } catch {
    return null;   // nät nere, CSP, tjänsten borta — panelen syns bara inte
  }
}
