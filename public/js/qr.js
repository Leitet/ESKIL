// Shared lazy-loader for QRCode.js (CDN) — same pattern as leaflet.js.
// Returns the global QRCode constructor once ready. Usage:
//   const QRCode = await ensureQRCode();
//   new QRCode(hostEl, { text, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });

let ready = null;

export function ensureQRCode() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    if (window.QRCode) return resolve(window.QRCode);
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.integrity = 'sha384-3zSEDfvllQohrq0PHL1fOXJuC/jSOO34H46t6UQfobFOmxE5BpjjaIJY5F2/bMnU';
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve(window.QRCode);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return ready;
}
