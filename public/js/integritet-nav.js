// Sätter det gemensamma huvudet och sidfoten på den STATISKA integritetssidan.
//
// Egen fil, inte ett inline-script: CSP:n håller script-src strikt utan
// 'unsafe-inline' (samma skäl som sw-register.js finns). Ett inline-script här
// blockeras och sidan står utan huvud.
import { publikHeader, publikFooter } from './publik-nav.js';

document.getElementById('pub-topp').outerHTML = publikHeader({
  aktiv: 'integritet',
  titel: 'Integritet & GDPR',
  ingress: 'Så hanterar ESKIL personuppgifter — och därför behövs ingen cookie-banner.'
});
document.getElementById('pub-botten').outerHTML = publikFooter();
