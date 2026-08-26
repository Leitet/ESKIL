// Offline-hårdning: registrera service workern så fältsidorna (/k, /s, /m)
// kan öppnas utan nät. Egen fil i stället för inline-script så att CSP:n
// kan hålla script-src strikt (utan 'unsafe-inline').
//
// Laddas numera också av /t och /a. Skälet där är inte offline-läge utan
// STARTEN: SW:n förcachar /__/firebase/init.json, som ligger bakom ett
// toppnivå-await i firebase.js. Utan den hämtningen körs inte en enda rad av
// modulgrafen, och sidan blir stående på sin statiska "Laddar…".
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
