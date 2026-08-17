// Sidhuvudets metadata per rutt — canonical, description, Open Graph och
// noindex. Bor bredvid setDocTitle() i nav.js men i en egen fil, eftersom de
// anonyma sidorna (/t) inte laddar nav.js.
//
// VARFÖR CANONICAL ÖVER HUVUD TAGET: fyra värdnamn svarar 200 med
// byte-identiskt innehåll — eskilscout.se, www.eskilscout.se,
// eskil-scout.web.app och eskil-scout.firebaseapp.com. Firebase Hosting kan
// inte omdirigera per värdnamn (redirects matchar bara sökväg) och
// .web.app-domänerna går inte att koppla bort, så taggen är enda spaken för
// att peka ut vilken adress som är sajtens.
//
// DÄRFÖR ÄR ORIGIN HÅRDKODAD. `location.origin` hade skrivit
// eskil-scout.web.app som canonical när sidan nås där — alltså gjort varje
// dubblett självrefererande och upphävt hela poängen. Det ser ut som en
// slarvig konstant; det är motsatsen.
const ORIGIN = 'https://eskilscout.se';

// Skalens statiska värden. Återställningen mellan rutter måste peka tillbaka
// hit, annars läcker en vys description till nästa sida — samma
// läckagemönster som app.js redan hanterar för titeln.
const STANDARD = {
  // Ordagrant samma text som index.html:s statiska <meta name="description">.
  // Håll de två i synk: annars skriver återställningen mellan rutter en
  // description som inte finns i skalet, och de två varianterna konkurrerar om
  // vilken Google visar.
  description: 'Lägg upp och genomför scoutkårens patrulltävling: anmälan på webben, '
    + 'poängrapportering i mobilen även utan täckning och live-resultat för anhöriga.',
  bild: `${ORIGIN}/assets/eskil_design_library/png/eskil-logo-primary-on-white.png`
};

/** Hämtar eller skapar en tagg i <head>. Idempotent: /t:s render() körs om vid
 *  varje snapshot, och appendChild per anrop hade staplat dubbletter. */
function tagg(selektor, skapa) {
  let el = document.head.querySelector(selektor);
  if (!el) { el = skapa(); document.head.appendChild(el); }
  return el;
}

const meta = (namn) => tagg(`meta[name="${namn}"]`, () => {
  const el = document.createElement('meta'); el.setAttribute('name', namn); return el;
});

const ogMeta = (prop) => tagg(`meta[property="${prop}"]`, () => {
  const el = document.createElement('meta'); el.setAttribute('property', prop); return el;
});

/**
 * Sätter sidans metadata. Anropas av vyerna när deras data finns.
 *
 * @param sokvag      absolut sökväg utan värdnamn, t.ex. '/om' eller '/t/ah26'.
 *                    På /t MÅSTE den byggas ur den UPPLÖSTA slugen — aldrig ur
 *                    parsePath()-segmentet. Kommer besökaren in via doc-id
 *                    skulle canonical annars peka ut doc-id-formen som sajtens
 *                    adress, och den formen är den vi vill sluta sprida.
 * @param titel       hela <title>. Utelämna om vyn redan satt den via setDocTitle.
 * @param description max ~155 tecken; längre klipps av Google ändå.
 * @param bild        absolut URL till og:image. Utelämna för standardlogotypen.
 * @param noindex     true för sidor som inte ska i indexet (404-grenen).
 */
export function setSeo({ sokvag, titel, description, bild, noindex = false } = {}) {
  if (titel) document.title = titel;

  if (sokvag) {
    const url = ORIGIN + sokvag;
    tagg('link[rel="canonical"]', () => {
      const el = document.createElement('link'); el.setAttribute('rel', 'canonical'); return el;
    }).setAttribute('href', url);
    // og:url måste följa canonical. I index.html är den hårdkodad till
    // ORIGIN + '/', och samma fil levereras på /om, /kontakt och /app/** —
    // den som delade /kontakt fick ett kort som utgav sig för att vara
    // startsidan och skickade klickaren dit.
    ogMeta('og:url').setAttribute('content', url);
  }

  const text = description || STANDARD.description;
  meta('description').setAttribute('content', text);
  ogMeta('og:description').setAttribute('content', text);
  meta('twitter:description').setAttribute('content', text);

  const t = titel || document.title;
  ogMeta('og:title').setAttribute('content', t);
  meta('twitter:title').setAttribute('content', t);

  ogMeta('og:image').setAttribute('content', bild || STANDARD.bild);

  // Robots-taggen MÄRKS med data-seo, och bara en märkt tagg tas bort igen.
  // Utan märket hade återställningen rivit en STATISK noindex — k.html, s.html,
  // m.html och a.html bär en sådan i filen. De sidorna laddar visserligen inte
  // routern i dag, men skyddet ska inte hänga på att ingen råkar importera
  // seo.js där i framtiden: en tyst borttagen noindex på en hemlig fältlänk
  // är precis det fel som inte upptäcks förrän sidan står i sökresultaten.
  if (noindex) {
    const el = meta('robots');
    el.setAttribute('content', 'noindex');
    el.setAttribute('data-seo', '1');
  } else {
    document.head.querySelector('meta[name="robots"][data-seo]')?.remove();
  }
}

/**
 * Återställer till skalets värden. Anropas från routerns route-change-hook,
 * FÖRE vyns handler — precis som titelnollställningen, och av samma skäl:
 * <head> töms aldrig (layout() återanvänder topbar och sidfot och byter bara
 * <main>), så utan en aktiv återställning bär nästa sida föregående sidas
 * description, canonical och eventuella noindex.
 */
export function resetSeo(sokvag = location.pathname) {
  setSeo({ sokvag, description: STANDARD.description, noindex: false });
}
