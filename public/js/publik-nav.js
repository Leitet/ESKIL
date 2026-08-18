// Gemensamt sidhuvud för ESKIL:s OFFICIELLA sidor — startsidan, Om, Kontakt
// och Integritet.
//
// EN implementation, av samma skäl som nav.js finns för tävlingssidorna: förut
// nåddes de här sidorna bara via en rad i sidfoten, och var och en byggde sitt
// eget huvud. Den som klickade in på Integritet hamnade i en återvändsgränd —
// ingen meny, inga smulor, ingen väg vidare utan att backa.
//
// Modulen används från TVÅ håll: SPA-vyerna (landing, om, kontakt) importerar
// den, och den statiska integritet.html injicerar den med ett litet skript.
// Därför får den inte bero på routern eller på inloggad identitet — den
// renderar ren HTML och länkar med vanliga href.
//
// `data-link` gör att SPA:ns router fångar klicket i stället för att ladda om
// sidan. Integritet.html ligger utanför routern; där är attributet ofarligt.

export const OFFICIELLA_SIDOR = [
  { id: 'start',      href: '/',           label: 'Start' },
  { id: 'om',         href: '/om',         label: 'Om ESKIL' },
  { id: 'kontakt',    href: '/kontakt',    label: 'Kontakt' },
  { id: 'integritet', href: '/integritet', label: 'Integritet' }
];

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// `data-link` sätts bara på det routern faktiskt kan rendera — annars fångar
// den ett klick den inte kan hantera och visar "Sidan hittades inte", medan en
// omladdning av samma adress fungerar.
//
// Villkoret var förut hårdkodat till `href !== '/integritet'`, alltså en lista
// över undantag i stället för en regel. Nästa statiska sida hade gått i samma
// fälla — vilket också hände, på /t-länken i landing.js. arSpaRutt är regeln.
import { arSpaRutt } from './utils.js';
const iSpa = arSpaRutt;

/**
 * Sidhuvudet: varumärke, meny över de officiella sidorna, brödsmulor och
 * sidans rubrik.
 *
 * @param aktiv   id ur OFFICIELLA_SIDOR — markeras i menyn och blir sista smulan.
 *                Smulorna hamnar UNDER hjälten, på den vita ytan: i det blå
 *                blocket konkurrerade de med rubriken om samma uppmärksamhet.
 * @param titel   sidrubrik (h1). Utelämnas på startsidan, som har sin egen hjälte.
 * @param ingress kort brödtext under rubriken
 */
export function publikHeader({ aktiv = '', titel = '', ingress = '' } = {}) {
  const sida = OFFICIELLA_SIDOR.find(s => s.id === aktiv);
  return `
    <header class="pub-hero pub-hero-slim">
      <div class="pub-hero-pattern"></div>
      <div class="page">
        <div class="pub-hero-top">
          <a class="pub-brand" href="/"${iSpa('/') ? ' data-link' : ''} aria-label="Till ESKIL:s startsida">
            <img class="pub-logo" src="/assets/eskil_design_library/svg/eskil-logo-inverted.svg" alt="ESKIL — Där spåret börjar">
          </a>
          <nav class="pub-meny" aria-label="ESKIL:s sidor">
            ${OFFICIELLA_SIDOR.map(s => `
              <a href="${s.href}"${iSpa(s.href) ? ' data-link' : ''}
                 class="${s.id === aktiv ? 'is-aktiv' : ''}"
                 ${s.id === aktiv ? 'aria-current="page"' : ''}>${esc(s.label)}</a>`).join('')}
          </nav>
        </div>
        ${titel ? `<h1 class="t-d2">${esc(titel)}</h1>` : ''}
        ${ingress ? `<p class="lede">${esc(ingress)}</p>` : ''}
      </div>
    </header>
    ${sida && sida.id !== 'start' ? `
      <nav class="pub-smulor" aria-label="Brödsmulor">
        <div class="page">
          <a href="/" data-link>ESKIL</a>
          <span aria-hidden="true">›</span>
          <span>${esc(sida.label)}</span>
        </div>
      </nav>` : ''}`;
}

/**
 * Sidfoten. Samma länkar som menyn plus det som hör hemma längst ned.
 * Tar `extra` för sidor som vill lägga till en rad (t.ex. inloggning).
 */
export function publikFooter({ extra = '' } = {}) {
  return `
    <footer class="pub-foot">
      <div class="page">
        <img class="pub-logo" src="/assets/eskil_design_library/svg/eskil-logo-inverted.svg" alt="ESKIL — Där spåret börjar">
        <nav class="pub-foot-lankar" aria-label="ESKIL:s sidor">
          ${OFFICIELLA_SIDOR.filter(s => s.id !== 'start')
            .map(s => `<a href="${s.href}"${iSpa(s.href) ? ' data-link' : ''}>${esc(s.label)}</a>`).join('')}
          ${extra}
        </nav>
      </div>
    </footer>`;
}
