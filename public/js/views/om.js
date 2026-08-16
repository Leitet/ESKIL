// Om ESKIL — den officiella sidan om vad systemet är och vem som byggt det.
//
// Biografin är Johans egna uppgifter, ordagrant det han lämnat. Lägg inte till
// meriter, årtal eller kårnamn som inte står här: det är en presentation av en
// verklig person, och den ska stämma.
//
// Den ska inte heller DRA SLUTSATSER åt läsaren. En tidigare version knöt ihop
// meriterna med produkten ("rapportsidan fungerar utan täckning för att jag
// stått på kontrollerna") — sant, men på näsan. Fakta står, läsaren kopplar.

import { publikHeader, publikFooter } from '../publik-nav.js';
import { icon } from '../icons.js';

// Porträttet ligger inte i repot förrän det lagts dit. Filnamnet är fast så
// bilden kan bytas utan kodändring.
const PORTRATT = '/assets/johan-leitet.jpg';

export function renderOm(app, user) {
  document.title = 'Om ESKIL — ESKIL';
  app.innerHTML = `
    ${publikHeader({
      aktiv: 'om',
      titel: 'Om ESKIL',
      ingress: 'Byggt av en scout, för scouter.'
    })}

    <main class="page page-narrow om-sida">
      <section>
        <h2 class="t-h2">Vad ESKIL är</h2>
        <p>ESKIL är ett system för att lägga upp och genomföra ett spår — anmälan, kontroller,
        poängrapportering och live-resultat på ett ställe. Det är byggt för en dag i skogen:
        kontrollanterna rapporterar i mobilen även utan täckning, och sekretariatet ser hela
        banan i realtid. Ska spåret räknas som tävling finns poäng, placeringar och
        prisutdelning — annars låter ni bli.</p>
        <p><a href="/#funktioner" data-link>Se vad ESKIL gör ${icon('arrow-right', { size: 14 })}</a></p>
      </section>

      <section>
        <h2 class="t-h2">Vem står bakom</h2>
        <div class="om-bio">
          <figure class="om-portratt" id="om-portratt">
            <img id="om-foto" src="${PORTRATT}" alt="Johan Leitet i scoutmundering">
            <span class="om-portratt-reserv" aria-hidden="true">JL</span>
          </figure>
          <div class="om-bio-text">
            <h3 class="om-namn">Johan Leitet</h3>
            <p class="om-roll">Scoutledare och utvecklare.</p>

            <p>Jag har varit ledare för spårare, upptäckare och äventyrare. Tävlingsledare
            för DM, suttit i sekretariatet på Älghornsjakter, stått på otaliga kontroller
            och varit kassör i många år.</p>

            <p>Till vardags har jag utvecklat programvara i snart fyrtio år. Jag har
            arbetat som universitetsadjunkt inom datavetenskap med inriktning mot att bygga
            webbaserade system och mot datorsäkerhet och integritetsfrågor. I dag är jag
            nyföretagare med eget bolag inom förnybar energi.</p>

            <p>Jag poddar också om generativ AI i
            <a href="https://generativet.se" target="_blank" rel="noopener">Generativet</a>.</p>
          </div>
        </div>
      </section>

      <section class="om-fraga">
        <p class="om-fraga-q">Använde du AI när du byggde sajten?</p>
        <p class="om-fraga-a">”Är det mörkt i skogen? Gör Kungen raketen? Givetvis.”</p>
      </section>

      <section>
        <h2 class="t-h2">Vad det kostar</h2>
        <p>Ingenting. ESKIL körs inom Google Firebase gratisnivå — den enda löpande kostnaden
        är utskicken av e-post. Det finns ingen licens, inget abonnemang och ingen
        uppsägningstid. Er data är er: hela tävlingen går att ladda ner som en fil när ni vill.</p>
      </section>

      <section>
        <h2 class="t-h2">Personuppgifter</h2>
        <p>ESKIL använder inga cookies och samlar ingen statistik. Kontaktuppgifter, allergier
        och fältets meddelanden raderas automatiskt när tävlingen avslutas.
        <a href="/integritet">Så hanteras personuppgifter</a>.</p>
      </section>

      <section>
        <h2 class="t-h2">Frågor?</h2>
        <p><a href="/kontakt" data-link>Skriv till oss</a> — meddelandet går till dem som
        ansvarar för ESKIL, och du får svar på adressen du anger.</p>
      </section>
    </main>

    ${publikFooter({ extra: user
      ? '<a href="/app" data-link>Dina tävlingar</a>'
      : '<a href="/app" data-link>Logga in</a>' })}
  `;

  // Saknas bildfilen ska sidan inte visa en trasig bildikon — då faller den
  // tillbaka på initialerna. Lyssnaren sätts här, inte som onerror i HTML:en:
  // CSP:n tillåter inga inline-hanterare (samma skäl som sw-register.js).
  const foto = app.querySelector('#om-foto');
  foto?.addEventListener('error', () => {
    app.querySelector('#om-portratt')?.classList.add('om-portratt-tom');
  }, { once: true });
}
