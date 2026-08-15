// Delningsbilden — patrullens resultat som en färdig bild för sociala medier.
//
// Allt ritas i en canvas i klienten. Ingen bild laddas upp någonstans, inget
// tredjepartsanrop görs: patrullen får en fil och bestämmer själv vad som
// händer med den. Det är också anledningen till att kortet inte hämtar
// kartrutor — en patrull som just gått i mål står ofta i skogen med dålig
// täckning, och ett kort som kräver nät är värdelöst just då. En publicerad
// bankarta vore dessutom ett problem så länge andra patruller är kvar ute.
//
// Färgerna är Scouternas, hårdkodade som hex: canvasen kan inte läsa
// CSS-variabler, och kortet ska INTE följa nattläget — en bild som delas ser
// likadan ut oavsett hur telefonen stod inställd när den skapades.

// --- Palett -----------------------------------------------------------------
const BLÅ = '#003660';
const BLÅ_MÖRK = '#00243f';
const SVART = '#282727';
const VIT = '#ffffff';
const PAPPER = '#f8f8f7';

export const AVD_FÄRG = {
  'Spårare': '#41A62A',
  'Upptäckare': '#00A8E1',
  'Äventyrare': '#E95F13',
  'Utmanare': '#DA005E',
  'Rover': '#E2E000',
  'Ledare': '#282727'
};
const STANDARDFÄRG = '#E95F13';

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

// --- Format och design ------------------------------------------------------
// Tre format täcker det folk faktiskt lägger upp: kvadrat i flödet, stående
// i flödet, och story/reel.
export const SHARE_FORMATS = [
  { id: 'kvadrat', label: 'Kvadrat', w: 1080, h: 1080 },
  { id: 'staende', label: 'Stående', w: 1080, h: 1350 },
  { id: 'story', label: 'Story', w: 1080, h: 1920 }
];

export const SHARE_DESIGNS = [
  { id: 'djup', label: 'Djup', beskrivning: 'Scoutblå med resultatet i en ring' },
  { id: 'falt', label: 'Färgfält', beskrivning: 'Avdelningens färg, poängen stort' },
  { id: 'banan', label: 'Banan', beskrivning: 'Varje kontroll som en ring' }
];

// Vad man kan välja bort. Patrullnamnet står kvar — utan det är kortet inte
// patrullens, och då finns ingen anledning att dela det.
export const SHARE_FIELDS = [
  { id: 'kar', label: 'Kårens namn' },
  { id: 'poang', label: 'Poäng' },
  { id: 'placering', label: 'Placering' },
  { id: 'hojdpunkter', label: 'Höjdpunkter' },
  { id: 'tid', label: 'Tid på banan' },
  { id: 'lank', label: 'Adress till tävlingssidan' }
];

export const SHARE_DEFAULTS = {
  kar: true, poang: true, placering: true, hojdpunkter: true, tid: true, lank: true
};

// --- Småverktyg -------------------------------------------------------------
const font = (vikt, px) => `${vikt} ${Math.round(px)}px ${FONT}`;

// Relativ luminans (WCAG) — avgör om texten på en färgad botten ska vara
// svart eller vit. Rovergult med vit text går inte att läsa.
//
// Valet är "den av de två som ger högst kontrast", inte "den som passerar
// 4,5:1". Äventyrarorange (#E95F13) når nämligen inte 4,5 mot vare sig vit
// eller svart — en fast gräns hade tvingat fram ett godtyckligt val där.
// All text på kortet är stor (minsta graden är ~30 px), och för stor text är
// WCAG-kravet 3:1, vilket varje åldersfärg klarar med marginal.
function luminans(hex) {
  const n = parseInt(hex.slice(1), 16);
  const kanal = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * kanal((n >> 16) & 255) + 0.7152 * kanal((n >> 8) & 255) + 0.0722 * kanal(n & 255);
}
const kontrast = (a, b) => {
  const la = luminans(a), lb = luminans(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
export const textPå = (bakgrund) => (kontrast(bakgrund, VIT) >= kontrast(bakgrund, SVART) ? VIT : SVART);

// Avdelningens färg mot den mörkblå bottnen. Ledarsvart försvinner där, så
// den byts mot en ljus ton i stället för att bli en osynlig accent.
export function accentMotBlått(avdelning) {
  const f = AVD_FÄRG[avdelning] || STANDARDFÄRG;
  return kontrast(f, BLÅ) >= 3 ? f : '#a7bccf';
}

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Krymper texten tills den ryms på bredden. Returnerar vald storlek.
function passaIn(ctx, text, maxBredd, start, vikt, minsta = 20) {
  let px = start;
  for (;;) {
    ctx.font = font(vikt, px);
    if (ctx.measureText(text).width <= maxBredd || px <= minsta) return px;
    px -= Math.max(1, Math.round(px * 0.04));
  }
}

function bryt(ctx, text, maxBredd) {
  const ord = String(text).split(/\s+/).filter(Boolean);
  const rader = [];
  let rad = '';
  for (const o of ord) {
    const test = rad ? rad + ' ' + o : o;
    if (rad && ctx.measureText(test).width > maxBredd) { rader.push(rad); rad = o; }
    else rad = test;
  }
  if (rad) rader.push(rad);
  return rader;
}

// Rubrik som får ta högst `maxRader` rader: krymp tills den gör det.
function ritaRubrik(ctx, text, x, y, maxBredd, start, { vikt = 800, maxRader = 2, mitt = false, färg = VIT }) {
  let px = start, rader;
  for (;;) {
    ctx.font = font(vikt, px);
    rader = bryt(ctx, text, maxBredd);
    if (rader.length <= maxRader || px <= 28) break;
    px -= Math.max(1, Math.round(px * 0.05));
  }
  rader = rader.slice(0, maxRader);
  ctx.fillStyle = färg;
  ctx.textAlign = mitt ? 'center' : 'left';
  const radhöjd = px * 1.06;
  rader.forEach((r, i) => ctx.fillText(r, x, y + i * radhöjd));
  ctx.textAlign = 'left';
  return y + rader.length * radhöjd;
}

function ritaEtikett(ctx, text, x, y, px, färg, { mitt = false } = {}) {
  ctx.font = font(800, px);
  ctx.fillStyle = färg;
  ctx.textAlign = mitt ? 'center' : 'left';
  // Versaler med spärrad text — canvas har ingen letter-spacing, så
  // tecknen sätts ett i taget.
  const tecken = [...String(text).toUpperCase()];
  const spärr = px * 0.14;
  const bredd = tecken.reduce((s, t) => s + ctx.measureText(t).width + spärr, -spärr);
  let cx = mitt ? x - bredd / 2 : x;
  ctx.textAlign = 'left';
  for (const t of tecken) {
    ctx.fillText(t, cx, y);
    cx += ctx.measureText(t).width + spärr;
  }
  return bredd;
}

function rundadRuta(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function fmtVaraktighet(ms) {
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  return h > 0 ? `${h} h ${min % 60} min` : `${min} min`;
}

const ordningstal = (n) => `${n}:a`;

// Raderna under hjälten: höjdpunkter först, sedan tid. Delad av alla
// designer så valen betyder samma sak oavsett vilken man valt.
function punktrader(data, val) {
  const rader = [];
  if (val.hojdpunkter) rader.push(...(data.highlights || []).map(h => h.text));
  if (val.tid && data.courseMs) rader.push(`${fmtVaraktighet(data.courseMs)} på banan`);
  return rader.slice(0, 4);
}

function fot(data, val) {
  const bitar = [];
  if (data.compDate) bitar.push(data.compDate);
  if (val.lank && data.tavlingUrl) bitar.push(data.tavlingUrl);
  return bitar.join('  ·  ');
}

// Foten sätts som den är — versalisering skulle förvanska adressen, och
// slugen i den är skiftlägeskänslig.
function ritaFot(ctx, text, x, y, px, färg, { mitt = false } = {}) {
  if (!text) return;
  ctx.font = font(600, px);
  ctx.fillStyle = färg;
  ctx.textAlign = mitt ? 'center' : 'left';
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
}

// En stapel av block som MÄTS innan den ritas. Varje block känner sin höjd,
// så kompositionen kan centreras och kapas innan en enda pixel hamnar fel.
// Utan den här ordningen ritade ett block med fast y-position rätt i ett
// format och över etiketten i nästa.
function stapla(block, topp, golv, { centrera = true } = {}) {
  const h = block.reduce((a, b) => a + b.h, 0);
  let y = centrera ? topp + Math.max(0, (golv - topp - h) / 2) : topp;
  for (const b of block) { b.rita(y); y += b.h; }
  return y;
}
const höjd = (block) => block.reduce((a, b) => a + b.h, 0);

// Hur många punktrader som ryms mellan `y` och `botten`. Att räkna först och
// rita sedan är skillnaden mellan ett kort som saknar en rad och ett kort där
// en rad ligger halvt utanför bilden.
function ryms(y, botten, radhöjd) {
  return Math.max(0, Math.floor((botten - y) / radhöjd));
}

// --- Design 1: Djup ---------------------------------------------------------
// Scoutblått med resultatet i en ring — en medalj. Centrerad och lugn;
// den fungerar för vilken tävling och vilket resultat som helst.
//
// Kompositionen MÄTS innan den ritas: ringen, rubriken, kåren, poängraden och
// punktraderna staplas och centreras i utrymmet mellan etiketten och foten.
// Ett fast y per block såg rätt ut i ett format och tappade höjdpunkterna i
// nästa — här får de plats i alla tre, eller så krymper ringen först.
function ritaDjup(ctx, W, H, data, val) {
  const accent = accentMotBlått(data.avdelning);
  const P = W * 0.09;

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, BLÅ);
  g.addColorStop(1, BLÅ_MÖRK);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = rgba(accent, 0.13);
  ctx.lineWidth = W * 0.012;
  ctx.beginPath(); ctx.arc(W * 1.02, H * 0.06, W * 0.42, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(W * -0.06, H * 0.99, W * 0.3, 0, Math.PI * 2); ctx.stroke();

  ritaEtikett(ctx, `${data.compName}${data.compYear ? ' · ' + data.compYear : ''}`,
    W / 2, P + W * 0.03, W * 0.031, accent, { mitt: true });

  const visaRank = val.placering && !!data.rank;
  const visaPoäng = val.poang && data.points != null;
  const harHjälte = visaRank || visaPoäng;
  const maxB = W - P * 2;

  // --- Mät ------------------------------------------------------------------
  const rubrikPx = (() => {
    let px = W * 0.115;
    for (;;) {
      ctx.font = font(800, px);
      if (bryt(ctx, data.patrolName, maxB).length <= 2 || px <= 34) return px;
      px -= Math.max(1, Math.round(px * 0.05));
    }
  })();
  ctx.font = font(800, rubrikPx);
  const rubrikRader = bryt(ctx, data.patrolName, maxB).slice(0, 2);
  // Kåren och poängen på SAMMA rad när ringen redan visar placeringen.
  // Två separata rader åt 150 px höjd som kvadratformatet inte har, och då
  // föll höjdpunkterna bort — de är det kortet egentligen handlar om.
  const underrad = [val.kar && data.kar ? data.kar : null,
                    (visaRank && visaPoäng) ? `${data.points} poäng` : null].filter(Boolean).join('  ·  ');
  const underradH = underrad ? W * 0.068 : 0;
  const punktH = W * 0.06;
  const alla = punktrader(data, val);

  const topp = P + W * 0.09;
  const fotY = H - P;
  const golv = fotY - W * 0.06;

  const textH = () => rubrikRader.length * rubrikPx * 1.06 + underradH;
  // Ringen får det som blir över, inom rimliga gränser. Krymper hellre än
  // att knuffa ut en höjdpunkt.
  let antalPunkter = alla.length;
  let r = W * 0.215;
  const behov = () => (harHjälte ? r * 2.24 + W * 0.05 : 0) + textH() + (antalPunkter ? W * 0.03 + antalPunkter * punktH : 0);
  while (behov() > golv - topp && r > W * 0.115) r -= W * 0.008;
  while (behov() > golv - topp && antalPunkter > 0) antalPunkter--;
  // Kapningen ovan krymper ringen FÖRST och punkterna sedan. När båda gett
  // vika finns ofta luft kvar — ge ringen tillbaka det som blev över, annars
  // står en liten ring mitt i ett halvtomt kort.
  while (r < W * 0.215 && behov() + W * 0.018 <= golv - topp) r += W * 0.008;

  // --- Rita -----------------------------------------------------------------
  let y = topp + Math.max(0, (golv - topp - behov()) / 2);

  if (harHjälte) {
    const cy = y + r * 1.12;
    ctx.strokeStyle = accent;
    ctx.lineWidth = W * 0.014;
    ctx.beginPath(); ctx.arc(W / 2, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = rgba(accent, 0.28);
    ctx.lineWidth = W * 0.005;
    ctx.beginPath(); ctx.arc(W / 2, cy, r * 1.12, 0, Math.PI * 2); ctx.stroke();

    const stort = visaRank ? ordningstal(data.rank.rank) : String(data.points);
    const under = visaRank ? `av ${data.rank.of}` : 'poäng';
    ctx.fillStyle = VIT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = font(800, passaIn(ctx, stort, r * 1.5, r * 0.95, 800));
    ctx.fillText(stort, W / 2, cy - r * 0.1);
    ctx.textBaseline = 'alphabetic';
    ritaEtikett(ctx, under, W / 2, cy + r * 0.48, W * 0.033, rgba(VIT, 0.72), { mitt: true });
    ctx.textAlign = 'left';
    y = cy + r * 1.12 + W * 0.05;
  }

  ctx.font = font(800, rubrikPx);
  ctx.fillStyle = VIT;
  ctx.textAlign = 'center';
  rubrikRader.forEach((rad, i) => ctx.fillText(rad, W / 2, y + rubrikPx * 0.82 + i * rubrikPx * 1.06));
  ctx.textAlign = 'left';
  y += rubrikRader.length * rubrikPx * 1.06;

  if (underradH) {
    ctx.font = font(500, W * 0.041);
    ctx.fillStyle = rgba(VIT, 0.72);
    ctx.textAlign = 'center';
    ctx.fillText(underrad, W / 2, y + W * 0.045);
    ctx.textAlign = 'left';
    y += underradH;
  }

  if (antalPunkter) {
    y += W * 0.03;
    ctx.font = font(600, W * 0.039);
    ctx.textAlign = 'center';
    for (const rad of alla.slice(0, antalPunkter)) {
      y += punktH;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(W / 2 - ctx.measureText(rad).width / 2 - W * 0.032, y - W * 0.013, W * 0.009, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba(VIT, 0.92);
      ctx.fillText(rad, W / 2, y);
    }
    ctx.textAlign = 'left';
  }

  ritaFot(ctx, fot(data, val), W / 2, fotY, W * 0.028, rgba(VIT, 0.5), { mitt: true });
}

// --- Design 2: Färgfält -----------------------------------------------------
// Avdelningens färg över hela ytan och poängen som hjälte. Rak, ung, syns
// i ett flöde.
function ritaFalt(ctx, W, H, data, val) {
  const botten = AVD_FÄRG[data.avdelning] || STANDARDFÄRG;
  const bläck = textPå(botten);
  const dämpad = rgba(bläck, 0.72);
  const P = W * 0.085;
  const fotY = H - P;

  ctx.fillStyle = botten;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = rgba(bläck, 0.06);
  ctx.beginPath();
  ctx.moveTo(0, H); ctx.lineTo(W, H * 0.62); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();

  ritaEtikett(ctx, `${data.compName}${data.compYear ? ' · ' + data.compYear : ''}`,
    P, P + W * 0.03, W * 0.031, dämpad);

  const maxB = W - P * 2;
  const block = [];

  if (val.poang && data.points != null) {
    const tal = String(data.points);
    const px = passaIn(ctx, tal, maxB * 0.78, W * 0.32, 800);
    ctx.font = font(800, px);
    // Talets VERSALHÖJD, inte teckengraden: siffrorna har varken över- eller
    // underhäng, och en höjd räknad på teckengraden lämnade ett synligt glapp.
    const cap = ctx.measureText(tal).actualBoundingBoxAscent;
    const bredd = ctx.measureText(tal).width;
    block.push({ h: cap + W * 0.05, rita: (y) => {
      ctx.font = font(800, px);
      ctx.fillStyle = bläck;
      ctx.fillText(tal, P, y + cap);
      ritaEtikett(ctx, 'poäng', P + bredd + W * 0.028, y + cap - W * 0.012, W * 0.036, dämpad);
    }});
  }

  block.push({ h: W * 0.016 + W * 0.055, rita: (y) => {
    ctx.fillStyle = rgba(bläck, 0.85);
    rundadRuta(ctx, P, y, W * 0.19, W * 0.016, W * 0.008);
    ctx.fill();
  }});

  const rubrikPx = (() => {
    let px = W * 0.105;
    for (;;) {
      ctx.font = font(800, px);
      if (bryt(ctx, data.patrolName, maxB).length <= 2 || px <= 34) return px;
      px -= Math.max(1, Math.round(px * 0.05));
    }
  })();
  ctx.font = font(800, rubrikPx);
  const rubrikRader = bryt(ctx, data.patrolName, maxB).slice(0, 2);
  block.push({ h: rubrikRader.length * rubrikPx * 1.06, rita: (y) => {
    ctx.font = font(800, rubrikPx);
    ctx.fillStyle = bläck;
    rubrikRader.forEach((r, i) => ctx.fillText(r, P, y + rubrikPx * 0.82 + i * rubrikPx * 1.06));
  }});

  if (val.kar && data.kar) {
    block.push({ h: W * 0.062, rita: (y) => {
      ctx.font = font(500, W * 0.04);
      ctx.fillStyle = dämpad;
      ctx.fillText(data.kar, P, y + W * 0.04);
    }});
  }
  if (val.placering && data.rank) {
    block.push({ h: W * 0.062, rita: (y) => {
      ritaEtikett(ctx, `Plats ${data.rank.rank} av ${data.rank.of}`, P, y + W * 0.038, W * 0.034, bläck);
    }});
  }

  const punkter = punktrader(data, val);
  const radhöjd = W * 0.06;
  const topp = P + W * 0.1;
  const golv = fotY - W * 0.055;
  // Kapa höjdpunkterna tills stapeln får plats. Hellre en punkt mindre än en
  // punkt som ligger halvt utanför bilden.
  let n = punkter.length;
  const punktBlock = () => ({ h: n ? W * 0.03 + n * radhöjd : 0, rita: (y) => {
    ctx.font = font(600, W * 0.038);
    let ry = y + W * 0.03;
    for (const rad of punkter.slice(0, n)) {
      ry += radhöjd;
      ctx.fillStyle = rgba(bläck, 0.55);
      ctx.beginPath(); ctx.arc(P + W * 0.008, ry - W * 0.012, W * 0.008, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = rgba(bläck, 0.9);
      ctx.fillText(rad, P + W * 0.033, ry);
    }
  }});
  while (n > 0 && höjd([...block, punktBlock()]) > golv - topp) n--;

  stapla([...block, punktBlock()], topp, golv);
  ritaFot(ctx, fot(data, val), P, fotY, W * 0.028, rgba(bläck, 0.6));
}

// --- Design 3: Banan --------------------------------------------------------
// Varje kontroll som en ring, fylld i förhållande till poängen. Det här är
// patrullens egen dag — inte en generisk platta med ett tal på.
function ritaBanan(ctx, W, H, data, val) {
  const accent = AVD_FÄRG[data.avdelning] || STANDARDFÄRG;
  const P = W * 0.085;
  const fotY = H - P;
  const maxB = W - P * 2;

  ctx.fillStyle = PAPPER;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, W, W * 0.018);

  ritaEtikett(ctx, `${data.compName}${data.compYear ? ' · ' + data.compYear : ''}`,
    P, P + W * 0.045, W * 0.031, accent);

  const block = [];

  const rubrikPx = (() => {
    let px = W * 0.1;
    for (;;) {
      ctx.font = font(800, px);
      if (bryt(ctx, data.patrolName, maxB).length <= 2 || px <= 32) return px;
      px -= Math.max(1, Math.round(px * 0.05));
    }
  })();
  ctx.font = font(800, rubrikPx);
  const rubrikRader = bryt(ctx, data.patrolName, maxB).slice(0, 2);
  block.push({ h: rubrikRader.length * rubrikPx * 1.06, rita: (y) => {
    ctx.font = font(800, rubrikPx);
    ctx.fillStyle = SVART;
    rubrikRader.forEach((r, i) => ctx.fillText(r, P, y + rubrikPx * 0.82 + i * rubrikPx * 1.06));
  }});
  if (val.kar && data.kar) {
    block.push({ h: W * 0.058, rita: (y) => {
      ctx.font = font(500, W * 0.038);
      ctx.fillStyle = rgba(SVART, 0.6);
      ctx.fillText(data.kar, P, y + W * 0.038);
    }});
  }

  // Ringarna. Storleken räknas ut så hela banan får plats, hur många
  // kontroller den än har — en bana med 30 kontroller ska inte rita utanför
  // kortet, den ska bara få mindre ringar.
  const legs = (data.legs || []).filter(l => l.poang != null);
  // Ringarnas storlek är det som får ge vika när kortet är kort — annars
  // trycktes talen och foten ihop i kvadratformatet.
  let ringSkala = 1;
  if (legs.length) {
    const perRad = legs.length <= 12 ? Math.min(5, legs.length) : 6;
    const antalRader = Math.ceil(legs.length / perRad);
    const lucka = W * 0.028;
    const dMax = Math.min((maxB - lucka * (perRad - 1)) / perRad, W * 0.135);
    const bildtext = `${legs.length} kontroller`;
    block.push({
      get h() { return W * 0.05 + antalRader * (dMax * ringSkala + lucka) + W * 0.045; },
      rita: (y0) => {
      const d = dMax * ringSkala;
      const r = d / 2;
      const y = y0 + W * 0.05;
      for (let i = 0; i < legs.length; i++) {
        const kol = i % perRad, rad = Math.floor(i / perRad);
        const påRaden = Math.min(perRad, legs.length - rad * perRad);
        const radbredd = påRaden * d + (påRaden - 1) * lucka;
        const cx = P + (maxB - radbredd) / 2 + kol * (d + lucka) + r;
        const cy = y + rad * (d + lucka) + r;
        const l = legs[i];
        const andel = l.max > 0 ? Math.max(0, Math.min(1, l.poang / l.max)) : 0;

        ctx.lineWidth = W * 0.008;
        ctx.strokeStyle = rgba(SVART, 0.14);
        ctx.beginPath(); ctx.arc(cx, cy, r - ctx.lineWidth / 2, 0, Math.PI * 2); ctx.stroke();
        if (andel > 0) {
          ctx.strokeStyle = accent;
          ctx.beginPath();
          ctx.arc(cx, cy, r - ctx.lineWidth / 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * andel);
          ctx.stroke();
        }
        ctx.fillStyle = SVART;
        ctx.font = font(700, d * 0.34);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(l.nummer ?? i + 1), cx, cy);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      }
      // Bildtexten spärras — den måste rymmas på bredden, annars skärs den av
      // vid kanten.
      let px = W * 0.024;
      ctx.font = font(800, px);
      while (px > W * 0.016 && ctx.measureText(bildtext).width * 1.14 > maxB) {
        px -= 1; ctx.font = font(800, px);
      }
      ritaEtikett(ctx, bildtext, P, y + antalRader * (d + lucka) + W * 0.025, px, rgba(SVART, 0.42));
    }});
  }

  const tal = [];
  if (val.poang && data.points != null) tal.push({ v: String(data.points), l: 'poäng' });
  if (val.placering && data.rank) tal.push({ v: ordningstal(data.rank.rank), l: `av ${data.rank.of}` });
  if (tal.length) {
    block.push({ h: W * 0.16, rita: (y) => {
      let x = P;
      for (const t of tal) {
        ctx.font = font(800, W * 0.105);
        ctx.fillStyle = SVART;
        ctx.fillText(t.v, x, y + W * 0.095);
        const b2 = ctx.measureText(t.v).width;
        ritaEtikett(ctx, t.l, x, y + W * 0.133, W * 0.026, rgba(SVART, 0.5));
        x += b2 + W * 0.09;
      }
    }});
  }

  const punkter = punktrader(data, val);
  const radhöjd = W * 0.057;
  const topp = P + W * 0.115;
  const golv = fotY - W * 0.055;
  let n = punkter.length;
  const punktBlock = () => ({ h: n ? W * 0.02 + n * radhöjd : 0, rita: (y) => {
    ctx.font = font(600, W * 0.036);
    let ry = y + W * 0.02;
    for (const rad of punkter.slice(0, n)) {
      ry += radhöjd;
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(P + W * 0.008, ry - W * 0.011, W * 0.008, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = rgba(SVART, 0.82);
      ctx.fillText(rad, P + W * 0.032, ry);
    }
  }});
  while (n > 0 && höjd([...block, punktBlock()]) > golv - topp) n--;
  while (ringSkala > 0.55 && höjd([...block, punktBlock()]) > golv - topp) ringSkala -= 0.04;
  // Krympta ringar frigör utrymme — låt höjdpunkterna komma tillbaka i det.
  while (n < punkter.length && höjd([...block, { h: W * 0.02 + (n + 1) * radhöjd }]) <= golv - topp) n++;

  // Toppankrad: rubriken ska sitta under den färgade remsan, inte sväva.
  stapla([...block, punktBlock()], topp, golv, { centrera: false });
  ritaFot(ctx, fot(data, val), P, fotY, W * 0.028, rgba(SVART, 0.45));
}

const RITARE = { djup: ritaDjup, falt: ritaFalt, banan: ritaBanan };

/**
 * Ritar kortet i en canvas.
 * @param canvas  målet — storleken sätts här
 * @param data    { compName, compYear, compDate, tavlingUrl, patrolName, kar,
 *                  avdelning, points, rank: {rank, of}|null, courseMs,
 *                  highlights: [{text}], legs: [{nummer, poang, max}] }
 * @param opts    { design, format, fields }
 */
export function renderShareCard(canvas, data, { design = 'djup', format = 'staende', fields = SHARE_DEFAULTS } = {}) {
  const f = SHARE_FORMATS.find(x => x.id === format) || SHARE_FORMATS[1];
  canvas.width = f.w;
  canvas.height = f.h;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';
  (RITARE[design] || ritaDjup)(ctx, f.w, f.h, data, { ...SHARE_DEFAULTS, ...fields });
  return canvas;
}

/** Canvasen som en delbar fil. PNG — kortet är plana färger och text. */
export function shareCardFile(canvas, filnamn) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(new File([blob], filnamn, { type: 'image/png' })) : reject(new Error('Kunde inte skapa bilden'))),
      'image/png'
    );
  });
}
