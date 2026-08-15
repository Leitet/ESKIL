// Scoutdistrikt — Scouternas 26 distrikt plus ett "annat" för det som inte
// hör hemma i något av dem (fristående kårer, samarrangemang, andra förbund).
//
// Källa: Scouternas egen förteckning över distrikt
// (scouterna.se/scout-ledare-kar/leda-kar/lokalt-stod/natverk-distrikt/),
// hämtad 2026-08-15. Distrikt slås ihop och byter namn med jämna mellanrum —
// stäm av listan mot källan när något ser inaktuellt ut.
//
// FÄRGER: distrikten har INGEN officiell färgsättning. Scouternas
// varumärkesfärger tillhör åldersgrupperna (Spårare grön, Upptäckare blå …)
// och används redan för avdelningarna. Punkten intill distriktsnamnet får
// därför en färgton uträknad ur namnet — enbart för att listor ska gå att
// skumma, aldrig som en officiell märkning.

export const DISTRICTS = [
  { id: 'birka',            name: 'Birka Scoutdistrikt' },
  { id: 'dacke',            name: 'Dacke Scoutdistrikt' },
  { id: 'dalarna',          name: 'Dalarnas Scoutdistrikt' },
  { id: 'gastrike',         name: 'Gästrike Scoutdistrikt' },
  { id: 'goteborg',         name: 'Göteborgs Scoutdistrikt' },
  { id: 'halland',          name: 'Hallands Scoutdistrikt' },
  { id: 'mitt',             name: 'Mitt Scoutdistrikt' },
  { id: 'nvskane',          name: 'Nordvästra Skånes Scoutdistrikt' },
  { id: 'nogotaland',       name: 'Nordöstra Götalands Scoutdistrikt' },
  { id: 'norrasmaland',     name: 'Norra Smålands Scoutdistrikt' },
  { id: 'norrbotten',       name: 'Norrbottens Scoutdistrikt' },
  { id: 'roslagen',         name: 'Roslagens Scoutdistrikt' },
  { id: 'orebro',           name: 'Scouterna Örebro Län' },
  { id: 'skaraborg',        name: 'Skaraborgs Scoutdistrikt' },
  { id: 'snapphane',        name: 'Snapphane Scoutdistrikt' },
  { id: 'staffan',          name: 'Staffans Scoutdistrikt' },
  { id: 'stockholm',        name: 'Stockholms Scoutdistrikt' },
  { id: 'sodermanland',     name: 'Södermanlands Scoutdistrikt' },
  { id: 'sodertorn',        name: 'Södertörns Scoutdistrikt' },
  { id: 'sodraskane',       name: 'Södra Skånes Scoutdistrikt' },
  { id: 'upplandsslatten',  name: 'Upplandsslättens Scoutdistrikt' },
  { id: 'varmland',         name: 'Värmlands Scoutdistrikt' },
  { id: 'vastbodal',        name: 'Västbodals Scoutdistrikt' },
  { id: 'vasterbotten',     name: 'Västerbotten-Ångermanlands Scoutdistrikt' },
  { id: 'vastgotasodra',    name: 'Västgöta Södra Scoutdistrikt' },
  { id: 'vastmanland',      name: 'Västmanlands Scoutdistrikt' },
  { id: 'annat',            name: 'Annat / inget distrikt', other: true }
];

const BY_ID = new Map(DISTRICTS.map(d => [d.id, d]));

export function districtById(id) {
  return BY_ID.get(String(id || '')) || null;
}

// Allt som skrivs till Firestore ska gå genom den här: ett tomt eller okänt
// id (gammalt distrikt, hopslaget distrikt, en select utan matchande option)
// ska landa på "annat" i stället för att tyst bli en tom sträng — annars
// försvinner tävlingen ur grupperingen utan att någon ser varför.
export function normDistrict(id) {
  return districtById(id) ? String(id) : 'annat';
}

// Namnet som visas i listor: distrikten heter "X Scoutdistrikt" nästan
// genomgående, och suffixet bär ingen information när rubriken redan är
// "Distrikt".
export function districtShort(id) {
  const d = districtById(id);
  if (!d) return '';
  if (d.other) return 'Annat';
  return d.name.replace(/\s*Scoutdistrikt$/i, '').replace(/^Scouterna\s+/i, '');
}

export function districtName(id) {
  return districtById(id)?.name || '';
}

// Stabil färgton ur id:t — se noten om färger överst. Guldiga/gröna toner
// undviks inte medvetet; poängen är bara att grannar i en lista skiljer sig åt.
export function districtHue(id) {
  const s = String(id || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

// Liten färgpunkt att sätta framför distriktsnamnet.
export function districtDot(id) {
  const hue = districtHue(id);
  return `<span class="district-dot" style="background:hsl(${hue} 55% 48%);" aria-hidden="true"></span>`;
}
