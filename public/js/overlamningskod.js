// Överlämningskoden — XXXX-XXXX-XXXX ur ett alfabet utan förväxlingsbara
// tecken: A–Z utom I och O, och 2–9 (ingen nolla, ingen etta). 32 tecken,
// alltså exakt 5 bitar per tecken och 60 bitar per kod: den går inte att
// gissa, och den går att läsa upp i telefon utan att någon frågar "O som i
// Olle eller noll?".
//
// Koden är en VÄRDEHANDLING: den som har den får en kopia av tävlingens
// upplägg. Därför lagras den bara som sha256 i den samling servern slår upp i
// (overlamningskoder/{hash}) — klartexten ligger i tävlingens
// private/overlamning, som bara administratörerna når efter avslut.
// CJS-spegel: functions/overlamning.js, parity-testad.

export const KOD_ALFABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const KOD_LANGD = 12;

// `bytes` injiceras i test; annars webbläsarens CSPRNG. 256 är en multipel av
// 32, så `& 31` ger en LIKFORMIG fördelning — ingen modulo-skevhet.
export function nyOverlamningskod(bytes = null) {
  const b = bytes || globalThis.crypto.getRandomValues(new Uint8Array(KOD_LANGD));
  let ra = '';
  for (let i = 0; i < KOD_LANGD; i++) ra += KOD_ALFABET[b[i] & 31];
  return formateraKod(ra);
}

// Tål det folk faktiskt skriver: gemener, mellanslag, bindestreck på fel ställe.
export function normKod(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
export function arGiltigKod(s) {
  const n = normKod(s);
  return n.length === KOD_LANGD && [...n].every(ch => KOD_ALFABET.includes(ch));
}
export function formateraKod(s) {
  const n = normKod(s);
  return [n.slice(0, 4), n.slice(4, 8), n.slice(8, 12)].filter(Boolean).join('-');
}

// sha256 över den NORMALISERADE koden, som hex. Samma i webbläsare och Node.
export async function kodHash(s) {
  const data = new TextEncoder().encode(normKod(s));
  const buf = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
