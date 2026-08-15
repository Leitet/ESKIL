// Intressepunkter — parkering, sekretariat, toaletter och allt annat en
// tävling behöver peka ut på kartan.
//
// Start och mål ligger INTE här. De är banans ändpunkter: ETA-motorn räknar
// ben från dem, spårdragningen hänger på dem och stationssidan checkar av mot
// dem. En plats är ren utmärkning på en karta och får aldrig blandas ihop med
// bandata. Start/mål sätts därför i kontrollistan (se views/controls.js).
//
// Modell: `competitions/{cid}.places = [{ id, kind, name, lat, lng, note,
// color, icon }]`. `kind` väljer förvald symbol och färg; egna platser
// ('annat') väljer själva. Färgen är alltid en av PALETTE — fritt hex vore
// bara ett sätt att göra kartan oläslig.
//
// Ren logik, inga beroenden — testas i test/logic.test.js.

// Förvalda sorter. Ordningen är den de listas i.
export const PLACE_KINDS = [
  { id: 'parkering',   label: 'Parkering',      icon: 'square-parking', color: 'bla'   },
  { id: 'sekretariat', label: 'Sekretariat',    icon: 'house',          color: 'bla'   },
  { id: 'toalett',     label: 'Toaletter',      icon: 'toilet',         color: 'lila'  },
  { id: 'vatten',      label: 'Vatten',         icon: 'droplet',        color: 'cyan'  },
  { id: 'sjukvard',    label: 'Första hjälpen', icon: 'heart-pulse',    color: 'rod'   },
  { id: 'mat',         label: 'Matplats',       icon: 'utensils',       color: 'orange' },
  { id: 'eldplats',    label: 'Eldplats',       icon: 'flame',          color: 'orange' },
  { id: 'samling',     label: 'Samling',        icon: 'users',          color: 'gron'  },
  { id: 'lager',       label: 'Lägerplats',     icon: 'tent',           color: 'gron'  },
  { id: 'dusch',       label: 'Dusch',          icon: 'shower-head',    color: 'cyan'  },
  { id: 'sopor',       label: 'Sopor',          icon: 'trash-2',        color: 'gra'   },
  { id: 'buss',        label: 'Busshållplats',  icon: 'bus',            color: 'bla'   },
  { id: 'varning',     label: 'Varning',        icon: 'triangle-alert', color: 'rod'   },
  { id: 'annat',       label: 'Egen plats',     icon: 'map-pin',        color: 'lila'  }
];

// Symboler att välja mellan för en egen plats. Alla finns i icons.js.
export const PLACE_ICONS = [
  'map-pin', 'square-parking', 'house', 'toilet', 'droplet', 'heart-pulse',
  'utensils', 'flame', 'users', 'tent', 'shower-head', 'trash-2', 'bus',
  'signpost', 'triangle-alert', 'footprints', 'waves', 'flag', 'star',
  'info', 'circle-help', 'clock', 'target', 'phone'
];

// Fast palett. Namn i stället för hex så färgen kan justeras på ett ställe,
// och så att den aldrig blir oläslig mot kartan.
export const PALETTE = [
  { id: 'bla',    label: 'Blå',      hex: '#003660' },
  { id: 'gron',   label: 'Grön',     hex: '#41A62A' },
  { id: 'orange', label: 'Orange',   hex: '#E95F13' },
  { id: 'rod',    label: 'Röd',      hex: '#C8102E' },
  { id: 'lila',   label: 'Lila',     hex: '#6B4E9B' },
  { id: 'cyan',   label: 'Turkos',   hex: '#0F8B8D' },
  { id: 'brun',   label: 'Brun',     hex: '#7A5C3E' },
  { id: 'gra',    label: 'Grå',      hex: '#5A6672' }
];

const KIND_BY_ID = new Map(PLACE_KINDS.map(k => [k.id, k]));
const COLOR_BY_ID = new Map(PALETTE.map(c => [c.id, c]));

export function placeKind(id) { return KIND_BY_ID.get(String(id || '')) || KIND_BY_ID.get('annat'); }
export function placeColorHex(id) { return (COLOR_BY_ID.get(String(id || '')) || COLOR_BY_ID.get('lila')).hex; }

// En plats i visningsbart skick. Allt som skrivs eller läses går genom den
// här: ett okänt kind, en okänd symbol eller en okänd färg ska falla tillbaka
// på något som går att rita, inte försvinna från kartan.
export function normPlace(raw, index = 0) {
  const kind = placeKind(raw?.kind);
  const icon = PLACE_ICONS.includes(raw?.icon) ? raw.icon : kind.icon;
  const color = COLOR_BY_ID.has(raw?.color) ? raw.color : kind.color;
  const lat = Number(raw?.lat), lng = Number(raw?.lng);
  const after = Number(raw?.courseAfter);
  const dwell = Number(raw?.dwellMinutes);
  return {
    id: String(raw?.id || `p${index}`),
    kind: kind.id,
    name: String(raw?.name || '').trim() || kind.label,
    note: String(raw?.note || '').trim(),
    icon, color, colorHex: placeColorHex(color),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    // Ingår platsen i banan? En matplats mellan kontroll 3 och 4 är en nod i
    // spåret, inte bara en nål. `courseAfter` är NUMRET på kontrollen den
    // följer (0 = direkt efter start), `dwellMinutes` hur länge patrullen
    // står still där — arrangören vet, vi gissar inte.
    inCourse: raw?.inCourse === true,
    courseAfter: Number.isFinite(after) ? Math.max(0, Math.round(after)) : 0,
    dwellMinutes: Number.isFinite(dwell) && dwell > 0 ? Math.round(dwell) : 0
  };
}

// Tävlingens platser, placerade och färdignormaliserade.
//
// Den gamla `comp.parking` (ett enda objekt, före platslistan) räknas med som
// en plats så att kartorna inte tappar parkeringen på tävlingar som aldrig
// sparats om. Ligger parkeringen redan i listan används den i stället — annars
// hade den ritats två gånger.
export function compPlaces(comp) {
  const list = Array.isArray(comp?.places) ? comp.places : [];
  const out = list.map(normPlace).filter(p => p.lat != null && p.lng != null);
  const legacy = comp?.parking;
  if (legacy?.enabled && Number.isFinite(legacy.lat) && Number.isFinite(legacy.lng)
      && !out.some(p => p.kind === 'parkering')) {
    out.unshift(normPlace({
      id: '__parking', kind: 'parkering',
      name: legacy.name || 'Parkering', note: legacy.note || '',
      lat: legacy.lat, lng: legacy.lng
    }));
  }
  return out;
}

// Det som sparas till Firestore — inga härledda fält, inga tomma strängar.
export function placeToStorage(p) {
  const n = normPlace(p);
  return {
    id: n.id, kind: n.kind, name: n.name, icon: n.icon, color: n.color,
    lat: n.lat, lng: n.lng,
    ...(n.note ? { note: n.note } : {}),
    ...(n.inCourse ? { inCourse: true, courseAfter: n.courseAfter } : {}),
    ...(n.dwellMinutes ? { dwellMinutes: n.dwellMinutes } : {})
  };
}

// Platserna som ingår i banan, i den ordning de passeras. Sorteringen är
// stabil: två platser efter samma kontroll behåller listans ordning.
export function coursePlaces(comp) {
  return compPlaces(comp)
    .filter(p => p.inCourse)
    .map((p, i) => ({ ...p, __i: i }))
    .sort((a, b) => a.courseAfter - b.courseAfter || a.__i - b.__i)
    .map(({ __i, ...p }) => p);
}

// --- Kartritning --------------------------------------------------------------
// Alla kartor ritar platserna på samma sätt: en färgad rund nål med sin
// symbol. Ligger här och inte i varje vy — annars driver de isär och samma
// toalett ser olika ut på tävlingssidan och startkortet.
//
// `iconHtml` skickas in (icons.js hör hemma i vyerna, inte i datamodellen) och
// `onPopup` får returnera popup-HTML; utan den blir nålen bara en markör.
export function drawPlaces(L, map, places, { iconHtml, onPopup } = {}) {
  const out = [];
  for (const p of places) {
    const m = L.circleMarker([p.lat, p.lng], {
      radius: 15, color: '#ffffff', weight: 3, fillColor: p.colorHex, fillOpacity: 1
    }).bindTooltip(iconHtml ? iconHtml(p.icon) : p.name, {
      permanent: true, direction: 'center', className: 'map-label map-label-place'
    });
    const html = onPopup?.(p);
    if (html) m.bindPopup(html, { offset: [0, -8] });
    m.addTo(map);
    out.push(m);
  }
  return out;
}
