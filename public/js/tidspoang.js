// Tidtagning på en kontroll: kontrollanten rapporterar en TID (mm:ss) i
// stället för poäng, och poängen fördelas i kontrollens intervall när
// kontrollen stängs. Ren logik, ingen Firestore — så den kan testas rakt av.
//
// Fördelningen är RANGBASERAD, inte tidsbaserad: tiderna rangordnas, rangen
// blir en percentil, percentilen en normalfördelning och normalfördelningen
// intervallet. Med tio patruller och 5–10 blir det 10, 9, 8, 8, 8, 7, 7, 7,
// 6, 5: få i ändarna, de flesta i mitten. Rang i stället för sekunder gör
// att en enstaka extremt långsam patrull (hinderbanan gick sönder) inte
// trycker ihop alla andra mot maxpoängen. Snabbast får alltid max och
// långsammast alltid min; samma tid ger samma poäng; "Ej genomförd" ger 0
// oavsett intervallets min.

// Inversa normalfördelningen (Abramowitz & Stegun 26.2.23, fel < 4,5e-4).
// Räcker gott: resultatet avrundas till hela poäng.
export function invNorm(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const q = p < 0.5 ? p : 1 - p;
  const t = Math.sqrt(-2 * Math.log(q));
  const z = t - (2.515517 + 0.802853 * t + 0.010328 * t * t)
    / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
  return p < 0.5 ? -z : z;
}

// Sekunder → "m:ss" (2:05). Minuterna nollfylls inte — "02:05" ser ut som ett
// klockslag, och en hinderbana på över en timme skrivs ändå 61:30.
export function formateraTid(sek) {
  const s = Math.max(0, Math.round(Number(sek) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// "mm:ss", "m:ss", "m.ss" eller rena sekunder → sekunder. null om oläsligt.
// Sekunddelen måste vara < 60: "2:75" är ett skrivfel, inte 2 min 75 s.
export function tolkaTid(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,3})[:.,](\d{1,2})$/);
  if (m) {
    const sek = Number(m[2]);
    if (sek >= 60) return null;
    return Number(m[1]) * 60 + sek;
  }
  if (/^\d{1,5}$/.test(s)) return Number(s);
  return null;
}

// Poängen för varje rapport på en tidtagningskontroll. Returnerar
// [{ patrolId, poang }] — en post per rapport som går att bedöma: tid, eller
// "ej genomförd" (0). Rapporter utan bådadera (trasiga) utelämnas.
export function fordelaTidspoang(control, scores) {
  const min = Number(control?.minPoang) || 0;
  const maxRaw = Number(control?.maxPoang) || 0;
  const max = Math.max(min, maxRaw);
  const ut = [];
  const tidade = [];
  for (const s of (scores || [])) {
    if (!s || !s.patrolId) continue;
    if (s.ejGenomford === true) { ut.push({ patrolId: s.patrolId, poang: 0 }); continue; }
    const t = Number(s.tidSek);
    if (Number.isFinite(t) && t >= 0) tidade.push({ patrolId: s.patrolId, tid: t });
  }
  if (!tidade.length) return ut;
  tidade.sort((a, b) => a.tid - b.tid);
  const n = tidade.length;
  const snabbast = tidade[0].tid;
  const langsammast = tidade[n - 1].tid;
  const mitt = (min + max) / 2;
  const skala = (max - min) / 4;   // ±2 standardavvikelser spänner intervallet
  // Rang med delade platser: lika tider får medelvärdet av sina positioner,
  // och därmed samma poäng.
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && tidade[j + 1].tid === tidade[i].tid) j++;
    const rang = (i + 1 + j + 1) / 2;          // 1-baserad medelposition
    const p = (rang - 0.5) / n;
    const z = invNorm(1 - p);                  // snabb = positiv
    // En ensam patrull står i mitten: approximationen ger −0,0006 vid p = 0,5,
    // vilket hade rundat 7,5 nedåt till 7 i stället för uppåt som Math.round.
    let poang = Math.round(n === 1 ? mitt : mitt + z * skala);
    poang = Math.max(min, Math.min(max, poang));
    // Snabbast får alltid max, långsammast alltid min — ett löfte som gäller
    // oavsett hur få patrullerna är (med två patruller blir det max och min).
    if (n >= 2 && snabbast !== langsammast) {
      if (tidade[i].tid === snabbast) poang = max;
      if (tidade[i].tid === langsammast) poang = min;
    }
    for (let k = i; k <= j; k++) ut.push({ patrolId: tidade[k].patrolId, poang });
    i = j + 1;
  }
  return ut;
}
