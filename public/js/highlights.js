// Positiva höjdpunkter för en patrull — det startkortet visar när banan är
// avklarad.
//
// Regeln är enkel och absolut: HÄR FINNS INGET NEGATIVT. Funktionen räknar
// fram sådant som gick bra och returnerar bara det. Gick något dåligt sägs
// ingenting om det — vi hittar aldrig på beröm, men vi tystar det tråkiga.
// Kortet är det scouten läser i bilen hem.
//
// Placeringen är den enda siffran som kan svida. Den visas därför bara när
// den är något att glädjas åt (topp 3 eller övre halvan). Hela resultatlistan
// ligger ändå ett tryck bort på tävlingssidan — vi döljer ingenting, vi väljer
// bara vad startkortet lyfter fram.
//
// Ren logik, inga beroenden — testas i test/logic.test.js.

import { isNumSet } from './utils.js';

const TOP_N = 3;
// Under så här många rapporterade patruller på en kontroll säger en
// placering ingenting — "topp 3 av 3" är inte en bragd.
const MIN_FIELD = 4;
// Kortare än så är ingen bana, utan en tidsstämpel som blivit fel.
const MIN_COURSE_MS = 10 * 60000;

function scoreOf(s) {
  if (!s) return null;
  const p = isNumSet(s.poang) ? Number(s.poang) : null;
  if (p == null) return null;
  return p + (Number(s.extraPoang) || 0);
}

// Patrullens placering på EN kontroll: 1 = bäst. null när underlaget är för
// tunt för att placeringen ska betyda något.
export function controlRank(patrolId, scores) {
  const vals = [];
  let own = null;
  for (const s of scores || []) {
    const v = scoreOf(s);
    if (v == null) continue;
    vals.push(v);
    if (s.patrolId === patrolId) own = v;
  }
  if (own == null || vals.length < MIN_FIELD) return null;
  return { rank: vals.filter(v => v > own).length + 1, of: vals.length, mean: vals.reduce((a, b) => a + b, 0) / vals.length, own };
}

// Totalplacering bland patruller som rapporterat något alls.
export function totalRank(patrolId, controls, scoresByControl) {
  const totals = new Map();
  for (const c of controls || []) {
    for (const s of scoresByControl[c.id] || []) {
      const v = scoreOf(s);
      if (v == null) continue;
      totals.set(s.patrolId, (totals.get(s.patrolId) || 0) + v);
    }
  }
  const own = totals.get(patrolId);
  if (own == null || totals.size < 2) return null;
  const better = [...totals.values()].filter(v => v > own).length;
  return { rank: better + 1, of: totals.size, points: own };
}

// Placeringen är den enda siffran som kan svida, så den visas bara när den är
// något att glädjas åt: topp 3 eller övre halvan.
//
// EXPORTERAD därför att delningsbilden måste lyda exakt samma regel. Den
// hämtade förr totalRank rakt av och tryckte "12:a av 12" stort i en ring —
// precis det den här filen finns för att förhindra, och till skillnad från
// startkortet ligger den bilden kvar i ett offentligt flöde.
export function rankWorthShowing(tr) {
  return !!tr && (tr.rank <= TOP_N || tr.rank <= Math.ceil(tr.of / 2));
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  return h > 0 ? `${h} h ${min % 60} min` : `${min} min`;
}

/**
 * @param patrolId      patrullens id
 * @param controls      alla kontroller i tävlingen
 * @param scoresByControl  { controlId: score[] } — alla patrullers poäng
 * @param showRank      false när poängen inte är publicerade ännu
 * @param startMs/endMs  valfria; ger raden om tid på banan
 * @returns [{ icon, text }] — kan vara tom
 */
export function patrolHighlights({ patrolId, controls = [], scoresByControl = {}, showRank = true, startMs = null, endMs = null }) {
  const out = [];
  const own = {};
  for (const c of controls) {
    const s = (scoresByControl[c.id] || []).find(x => x.patrolId === patrolId);
    if (s && scoreOf(s) != null) own[c.id] = s;
  }
  const doneIds = Object.keys(own);
  if (!doneIds.length) return out;

  // Hela banan avklarad.
  if (controls.length && doneIds.length === controls.length) {
    out.push({ icon: 'flag', text: `Alla ${controls.length} kontroller klara!` });
  }

  // Totalplacering — bara när den är värd att fira (se filhuvudet).
  if (showRank) {
    const tr = totalRank(patrolId, controls, scoresByControl);
    if (rankWorthShowing(tr)) {
      out.push({
        icon: 'trophy',
        text: tr.rank === 1 ? `Bäst i tävlingen — ${tr.points} poäng!`
            : `Plats ${tr.rank} av ${tr.of} — ${tr.points} poäng`
      });
    }
  }

  // Topp 3 på enskilda kontroller. Det här är den mening användaren bad om.
  if (showRank) {
    let topp = 0, vinster = 0;
    for (const id of doneIds) {
      const r = controlRank(patrolId, scoresByControl[id]);
      if (!r) continue;
      if (r.rank === 1) vinster++;
      if (r.rank <= TOP_N) topp++;
    }
    if (vinster > 0) {
      out.push({ icon: 'trophy', text: `Bäst av alla på ${vinster} kontroll${vinster === 1 ? '' : 'er'}!` });
    }
    if (topp > 0) {
      out.push({ icon: 'star', text: `Topp ${TOP_N} på ${topp} kontroll${topp === 1 ? '' : 'er'}! Snyggt!` });
    }
  }

  // Full pott.
  const fulla = doneIds.filter(id => {
    const c = controls.find(x => x.id === id);
    const max = Number(c?.maxPoang);
    return max > 0 && Number(own[id].poang) >= max;
  }).length;
  if (fulla > 0) {
    out.push({ icon: 'party-popper', text: `Full pott på ${fulla} kontroll${fulla === 1 ? '' : 'er'}` });
  }

  // Över snittet — också en jämförelse mot fältet, så samma grind.
  if (showRank) {
    const over = doneIds.filter(id => {
      const r = controlRank(patrolId, scoresByControl[id]);
      return r && r.own > r.mean;
    }).length;
    if (over > 1) {
      out.push({ icon: 'target', text: `Över snittet på ${over} av ${doneIds.length} kontroller` });
    }
  }

  // Extrapoäng.
  const extra = doneIds.reduce((a, id) => a + (Number(own[id].extraPoang) || 0), 0);
  if (extra > 0) {
    out.push({ icon: 'plus', text: `${extra} extrapoäng inhämtade` });
  }

  // Tid på banan. En orimligt kort tid är ingen bragd utan ett datafel —
  // t.ex. en patrull som prickats av på start och mål inom samma minut.
  if (startMs != null && endMs != null && endMs - startMs >= MIN_COURSE_MS) {
    out.push({ icon: 'clock', text: `${fmtDuration(endMs - startMs)} på banan` });
  }

  // Ingen bragd att lyfta? Då säger vi det som ändå alltid är sant.
  if (!out.length) {
    out.push({ icon: 'flag', text: `${doneIds.length} kontroller klara — bra jobbat!` });
  }
  return out;
}
