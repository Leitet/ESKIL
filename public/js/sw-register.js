// Offline-hårdning: registrera service workern så fältsidorna (/k, /s, /m)
// kan öppnas utan nät. Egen fil i stället för inline-script så att CSP:n
// kan hålla script-src strikt (utan 'unsafe-inline').
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
