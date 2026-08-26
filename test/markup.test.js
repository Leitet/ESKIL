// Klasser som sätts i markupen måste finnas i en CSS-fil sidan faktiskt laddar.
//
// Buggen som gav upphov till filen: anmälningssidan satte class="pub-logo" på
// logotypen — i a.html och i anmalan.js hero() och renderFatal() — men
// regeln bodde bara i public.css, som /a inte laddar. Klassen fanns alltså i
// koden och saknade verkan på skärmen, så bilden renderades i sin NATURLIGA
// storlek: 1149×418 px för låsningen, 400×480 för symbolen. Resultatet var en
// enorm logotyp längst upp på sidan.
//
// Det är den värsta sortens fel att upptäcka genom läsning: markupen ser rätt
// ut, klassnamnet är rättstavat, och inget verktyg klagar.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const las = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const SIDOR = readdirSync(new URL('../public/', import.meta.url)).filter(f => f.endsWith('.html'));

/** Stilmallarna en sida laddar, i ordning. */
function stilmallar(html) {
  return [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/assets\/([^"]+)"/g)].map(m => m[1]);
}

/** Skripten en sida laddar från /js/. */
function skript(html) {
  return [...html.matchAll(/<script[^>]+src="\/js\/([^"]+)"/g)].map(m => m[1]);
}

describe('.pub-logo — logotyplåsningen', () => {
  test('definieras på EXAKT ett ställe', () => {
    // Två definitioner är samma fälla åt andra hållet: den ena vinner
    // beroende på laddningsordning, och det syns bara på vissa sidor.
    const filer = readdirSync(new URL('../public/assets/', import.meta.url))
      .filter(f => f.endsWith('.css'))
      .filter(f => /^\.pub-logo\s*\{/m.test(readFileSync(new URL(`../public/assets/${f}`, import.meta.url), 'utf8')));
    assert.deepEqual(filer, ['tokens.css'],
      `.pub-logo definieras i ${filer.join(', ')} — den ska bo i tokens.css, som varje sida som använder den laddar`);
  });

  test('varje sida som använder klassen laddar också tokens.css', () => {
    // Inklusive via sina skript: hero() i anmalan.js sätter klassen, och det
    // var precis den vägen som saknade regel.
    for (const sida of SIDOR) {
      const html = las(sida);
      const anvander = html.includes('pub-logo')
        || skript(html).some(s => {
          try { return las(`js/${s}`).includes('pub-logo'); } catch { return false; }
        });
      if (!anvander) continue;
      assert.ok(stilmallar(html).includes('tokens.css'),
        `${sida} sätter pub-logo men laddar inte tokens.css — klassen blir verkningslös`);
    }
  });

  test('anmälningssidans laddskärm visar LÅSNINGEN, inte den nakna symbolen', () => {
    // CLAUDE.md: logotypen är EN fil som bär symbol, ordbild och tagline.
    // Symbolen ensam är inte logotypen.
    const html = las('a.html');
    assert.match(html, /eskil-logo-inverted\.svg/, 'laddskärmen saknar låsningen');
    assert.ok(!/eskil-symbol[^"]*\.svg/.test(html),
      'laddskärmen använder den nakna symbolen i stället för låsningen');
  });

  test('och den märks med hela ordbilden i alt-texten', () => {
    // Skärmläsaren ska höra samma sak som ögat ser.
    assert.match(las('a.html'), /alt="ESKIL — Där spåret börjar"/);
  });

  test('höjden håller sig på eller över mobilens 40 px', () => {
    // Taglinen är 98/418 av höjden. Vid 40 px blir den 9,4 px — dekor, vilket
    // är ett medvetet val. Under det blir den gröt, och då ska man använda
    // symbolen i stället för att krympa låsningen.
    const css = las('assets/tokens.css');
    const grund = Number(css.match(/\.pub-logo \{ height: (\d+)px/)[1]);
    const mobil = Number(css.match(/max-width: 560px\) \{ \.pub-logo \{ height: (\d+)px/)[1]);
    assert.ok(grund >= 48, `grundhöjden ${grund}px gör taglinen oläslig`);
    assert.ok(mobil >= 40, `mobilhöjden ${mobil}px är under det låsningen tål`);
  });
});
