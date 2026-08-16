// Kalenderfil (iCalendar, RFC 5545) för "påminn mig när patrullen väntas i mål".
//
// Notisen på tävlingssidan kräver att sidan är öppen och att man tillåtit
// notiser. En kalenderpost gör det inte: den ligger i telefonens egen kalender,
// ringer utan täckning och överlever att man stänger fliken. För en förälder
// som ska hämta vid målet är det skillnaden mellan att komma i tid och inte.
//
// Formatet är kinkigare än det ser ut. Tre saker MÅSTE stämma, annars vägrar
// kalenderappar öppna filen — och de säger sällan varför:
//   1. Radsluten är CRLF, inte LF.
//   2. Rader över 75 oktetter ska vikas: bryt och inled nästa rad med ETT
//      mellanslag.
//   3. I textvärden är komma, semikolon och bakstreck reserverade och måste
//      escapas; radbrytning skrivs som \\n.

// Escapning enligt RFC 5545 §3.3.11. Ordningen spelar roll: bakstrecket först,
// annars escapas de bakstreck vi själva just lagt till.
export function icsText(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// UTC-stämpel: 20260816T134500Z. Kalenderposten ska ligga på rätt klockslag
// oavsett vilken tidszon telefonen står i.
export function icsDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
       + `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

// Vikning räknas i OKTETTER, inte tecken: å, ä och ö är två oktetter var i
// UTF-8, och ett patrullnamn med svenska tecken hade annars gett för långa
// rader trots att teckenantalet såg rätt ut.
export function foldLine(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const ut = [];
  let start = 0;
  let gräns = 75;
  while (start < bytes.length) {
    let slut = Math.min(start + gräns, bytes.length);
    // Backa så vi aldrig delar mitt i en flerbytesekvens.
    while (slut < bytes.length && (bytes[slut] & 0xc0) === 0x80) slut--;
    ut.push(new TextDecoder().decode(bytes.slice(start, slut)));
    start = slut;
    gräns = 74;   // följande rader inleds med ett mellanslag
  }
  return ut.join('\r\n ');
}

/**
 * Bygger en komplett .ics med EN händelse och en påminnelse före den.
 * Ren funktion — inga anrop, ingen DOM.
 */
export function buildIcs({ uid, title, description = '', location = '', url = '',
                           start, end, alarmMinutes = 30, now = new Date() }) {
  const slut = end || new Date(start.getTime() + 15 * 60000);
  const rader = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ESKIL//Scouttavlingar//SV',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsText(uid)}`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(slut)}`,
    `SUMMARY:${icsText(title)}`,
    ...(description ? [`DESCRIPTION:${icsText(description)}`] : []),
    ...(location ? [`LOCATION:${icsText(location)}`] : []),
    ...(url ? [`URL:${icsText(url)}`] : []),
    'BEGIN:VALARM',
    `TRIGGER:-PT${Math.max(0, Math.round(alarmMinutes))}M`,
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(title)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ];
  return rader.map(foldLine).join('\r\n') + '\r\n';
}
