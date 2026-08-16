// Om ESKIL — den officiella sidan om vad systemet är och vem som står bakom.
//
// Sidan är medvetet MAGER just nu. Hellre en ärlig sida med lite innehåll än
// en fylld med påhittade formuleringar om vilka "vi" är — den texten ska
// skrivas av den som faktiskt driver ESKIL. Rubrikerna står kvar som stomme
// så det syns vad som saknas.

import { publikHeader, publikFooter } from '../publik-nav.js';
import { icon } from '../icons.js';

export function renderOm(app, user) {
  document.title = 'Om ESKIL — ESKIL';
  app.innerHTML = `
    ${publikHeader({
      aktiv: 'om',
      titel: 'Om ESKIL',
      ingress: 'Ett tävlingssystem byggt av scouter, för scouter.'
    })}

    <main class="page page-narrow om-sida">
      <section>
        <h2 class="t-h2">Vad ESKIL är</h2>
        <p>ESKIL är ett system för att arrangera scouttävlingar — anmälan, kontroller,
        poängrapportering och live-resultat på ett ställe. Det är byggt för en tävlingsdag
        i skogen: kontrollanterna rapporterar i mobilen även utan täckning, och sekretariatet
        ser hela banan i realtid.</p>
        <p><a href="/#funktioner" data-link>Se vad ESKIL gör ${icon('arrow-right', { size: 14 })}</a></p>
      </section>

      <section>
        <h2 class="t-h2">Vem står bakom</h2>
        <p class="om-tom">Den här texten är inte skriven än.</p>
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
}
