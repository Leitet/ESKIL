// Bilder i meddelanden — hämtning från kamera eller filväljare, och
// nedskalning till något som får plats i ett Firestore-dokument.
//
// Projektet har ingen Cloud Storage-bucket, så bilden följer med meddelandet
// som en data-URL. Det är ett medvetet val: ingen ny tjänst att konfigurera
// och härda, och bilden gallras med tävlingen — en bild tagen i skogen kan
// visa scouters ansikten.
//
// Firestore tar 1 MiB per dokument och reglerna sätter taket till 400 000
// tecken data-URL. Därför skalas allt ner här, i klienten, INNAN det skickas.
// Skulle en bild ändå hamna över taket kastar vi hellre än att låta
// skrivningen nekas av reglerna med ett obegripligt felmeddelande.

// Reglernas tak. Håll de här två i synk — sänks taket i firestore.rules
// måste MAX_CHARS ner också, annars nekas skrivningen först på servern.
export const MAX_CHARS = 400000;

// Längsta sida efter nedskalning. 1280 px räcker gott för "titta på det
// här" — texten på en lapp går att läsa, och filen håller sig runt 150 kB.
const MAX_SIDE = 1280;
const KVALITET = [0.72, 0.6, 0.48, 0.38];

function läsFil(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Kunde inte läsa bilden'));
    fr.readAsDataURL(file);
  });
}

function laddaBild(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Filen är inte en bild som går att visa'));
    img.src = src;
  });
}

/**
 * Skalar ner en vald bild till en data-URL som ryms i ett meddelande.
 * @param {File} file
 * @returns {Promise<{ dataUrl: string, bytes: number, width: number, height: number }>}
 */
export async function prepareImage(file) {
  if (!file) throw new Error('Ingen bild vald');
  if (!/^image\//.test(file.type)) throw new Error('Filen är inte en bild');

  const img = await laddaBild(await läsFil(file));
  const skala = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * skala));
  const h = Math.max(1, Math.round(img.naturalHeight * skala));

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  // Vit botten: en PNG med genomskinlighet blir annars svart som JPEG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  // Sänk kvaliteten stegvis tills bilden ryms. Hellre en lite grynig bild
  // som går fram än ett fel som scouten inte kan göra något åt.
  for (const q of KVALITET) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url.length <= MAX_CHARS) return { dataUrl: url, bytes: url.length, width: w, height: h };
  }
  throw new Error('Bilden är för stor även nedskalad — ta en ny bild med mindre detaljer.');
}

/**
 * Öppnar kameran (mobil) eller filväljaren och returnerar en färdig bild.
 * `capture: 'environment'` får telefoner att gå direkt till bakre kameran,
 * vilket är vad man vill när man fotar en lapp eller en plats. På dator
 * ignoreras attributet och man får den vanliga filväljaren.
 * @returns {Promise<object|null>} null om användaren avbröt
 */
export function pickImage({ camera = false } = {}) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (camera) input.capture = 'environment';
    input.style.display = 'none';
    document.body.appendChild(input);

    // Avbryt-fallet ger inget event i alla webbläsare; städa på focus.
    const städa = () => setTimeout(() => input.remove(), 500);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      städa();
      if (!file) return resolve(null);
      try { resolve(await prepareImage(file)); } catch (e) { reject(e); }
    });
    window.addEventListener('focus', () => {
      setTimeout(() => { if (!input.files?.length) { städa(); resolve(null); } }, 400);
    }, { once: true });

    input.click();
  });
}

// Läsbar storlek för gränssnittet.
export function fmtBytes(n) {
  const kb = Math.round((n * 0.75) / 1024);   // data-URL -> ungefärliga bytes
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} kB`;
}
