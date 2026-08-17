// MCP-serverns verktygsyta.
//
// ═══ TVÅ REGLER SOM STYR HELA FILEN ═══
//
// 1. POSITIV SÖKVÄGS-ALLOWLIST MED DEFAULT-DENY. Servern kör med admin-SDK och
//    går förbi firestore.rules HELT. Tool-gränsen är alltså inte det andra
//    lagret — den är det ENDA. Varje glömd maskering är en fullständig läcka,
//    inte en degraderad. Därför namnger varje verktyg sina sökvägar; det finns
//    inget generiskt firestore_get(path).
//
// 2. INGA DOC-ID I NÅGOT SVAR. Ett kontroll-id ÄR rapportlänken, ett
//    patrull-id ÄR startkortslänken, ett stations-id ÄR /m-länken. Kontroller
//    adresseras med NUMMER, patruller med NAMN + KÅR. Modellen hanterar id:n
//    internt för att kunna skriva, men de lämnar aldrig servern.
//
// ═══ VAD SOM MEDVETET SAKNAS, och varför ═══
//
//  • Backup/export/import — konstruerad för att bära ALLT (raderingsskyddet
//    kräver det). Ett anrop ger anmälningarnas kontaktuppgifter,
//    kompletteringarnas allergier och överlämningsdokumentet.
//  • Alla PDF-generatorer och QR — kontrollens PDF trycker grannkontrollernas
//    telefonnummer, och en QR ÄR en hemlig länk. Får modellen filen är all
//    fältnivåredigering förbi.
//  • Utskick och publika driftmeddelanden — onUtskickCreated fläktar ut
//    LLM-formulerad text till varje anmäld kår, oåterkalleligt, och stämplar
//    tillbaka ett exakt antal mottagare (ett räkneorakel över anmälningarna).
//  • Att utse kontrollansvariga — onControlMetaWritten MAILAR den hemliga
//    rapportlänken till varje ny adress. Skrivrätt hade blivit läsrätt utanför
//    systemet: modellen kunde skicka en fungerande fältlänk till en adress den
//    själv väljer.
//  • Anmälningar, kompletteringar, fälttrådar, papperskorgen, loggen —
//    kontaktuppgifter, allergier om minderåriga, nödrop med GPS, bilder från
//    skogen.
//  • Livscykel (skapa/kopiera/avsluta/radera tävling) — nyckeln är
//    tävlingsbunden, och radering kräver en människa och en färsk backup.
//  • Skrivning av demo, closed, slug, lastBackupAt, admins. `demo: true` öppnar
//    fem läsgrenar i reglerna för hela internet, och "sätt upp ett demo av
//    tävlingen" låter som en rimlig konfigurationsuppgift.
//  • Varje argument som är ett fältnamn, en operator, ett filter eller en
//    sortering. where('contact.email','>=',x).limit(1) är binärsökning tecken
//    för tecken — ~5 anrop per tecken, utan mail och utan spår.

const admin = require('firebase-admin');
const { maskera, skrubba, TAVLING, KONTROLL, PATRULL } = require('./redact.js');
const { delaLedning } = require('./ledning.js');

// ═══ Skrivbara fält, per yta. Allt utanför listan avvisas. ══════════════════

const TAVLING_SKRIVBART = {
  name: 'str', shortName: 'str', date: 'str', location: 'str', organizer: 'str',
  description: 'str', generalInfo: 'str', district: 'str',
  publicScores: 'bool', publicControls: 'bool', controlsAutoReleased: 'bool',
  anonymousControls: 'bool', selfStart: 'bool', selfFinish: 'bool',
  autoFinish: 'bool', fieldMessaging: 'bool', etaDwellMinutes: 'num'
};
// demo, closed, slug, lastBackupAt, admins, createdBy och imported står
// medvetet INTE här. Se filhuvudet.

const KONTROLL_SKRIVBART = {
  name: 'str', lat: 'num', lng: 'num', maxPoang: 'num', minPoang: 'num',
  placement: 'str', open: 'bool', utslag: 'bool', utslagFraga: 'str', utslagSvar: 'str'
};

const PATRULL_SKRIVBART = { name: 'str', kar: 'str', avdelning: 'str', startOrder: 'num' };

function kontrollera(varden, tillatna, yta) {
  const ut = {};
  for (const [k, v] of Object.entries(varden || {})) {
    const typ = tillatna[k];
    if (!typ) {
      const kanda = Object.keys(tillatna).join(', ');
      throw fel(`Fältet "${k}" går inte att sätta på ${yta}. Tillåtna: ${kanda}.`);
    }
    if (typ === 'num' && typeof v !== 'number') throw fel(`${k} måste vara ett tal.`);
    if (typ === 'bool' && typeof v !== 'boolean') throw fel(`${k} måste vara true eller false.`);
    if (typ === 'str' && typeof v !== 'string') throw fel(`${k} måste vara text.`);
    ut[k] = v;
  }
  if (!Object.keys(ut).length) throw fel('Inga fält att ändra.');
  return ut;
}

/** Fel som är säkert att visa modellen — bär aldrig ett fältvärde. */
function fel(meddelande) {
  const e = new Error(meddelande);
  e.mcpSäkert = meddelande;
  return e;
}

// ═══ Uppslagning på MÄNSKLIGA nycklar, aldrig doc-id ═══════════════════════

async function hittaKontroll(db, cid, nummer) {
  const snap = await db.collection(`competitions/${cid}/controls`).get();
  const träff = snap.docs.filter(d => Number(d.data().nummer) === Number(nummer));
  if (!träff.length) throw fel(`Det finns ingen kontroll med nummer ${nummer}.`);
  if (träff.length > 1) throw fel(`Flera kontroller har nummer ${nummer}. Rätta det i ESKIL först.`);
  return träff[0];
}

async function hittaPatrull(db, cid, namn, kar) {
  const snap = await db.collection(`competitions/${cid}/patrols`).get();
  const n = String(namn || '').trim().toLowerCase();
  let träff = snap.docs.filter(d => String(d.data().name || '').trim().toLowerCase() === n);
  if (kar) {
    const k = String(kar).trim().toLowerCase();
    träff = träff.filter(d => String(d.data().kar || '').trim().toLowerCase() === k);
  }
  if (!träff.length) throw fel(`Ingen patrull heter "${namn}"${kar ? ` i ${kar}` : ''}.`);
  if (träff.length > 1) {
    // Flera kårer döper sina patruller likadant — det är hela skälet till att
    // patrolLabel finns. Be om kåren i stället för att gissa.
    throw fel(`Flera patruller heter "${namn}". Ange kar också för att peka ut rätt.`);
  }
  return träff[0];
}

// ═══ Verktygen ═════════════════════════════════════════════════════════════

const VERKTYG = [
  {
    namn: 'tavling_las',
    beskrivning: 'Läs tävlingens inställningar. Kontaktuppgifter och personnamn '
      + 'visas som "(ifyllt)" eller "(saknas)" — aldrig värdet.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async kor(_a, { db, cid }) {
      const snap = await db.doc(`competitions/${cid}`).get();
      const d = snap.data() || {};
      delete d.admins; delete d.createdBy;
      return maskera(d, TAVLING);
    }
  },
  {
    namn: 'tavling_uppdatera',
    beskrivning: 'Ändra tävlingens inställningar. Kan inte sätta demo, closed, '
      + 'slug eller behörigheter.',
    schema: {
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries(Object.entries(TAVLING_SKRIVBART).map(([k, t]) =>
        [k, { type: t === 'num' ? 'number' : t === 'bool' ? 'boolean' : 'string' }]))
    },
    async kor(a, { db, cid }) {
      const patch = kontrollera(a, TAVLING_SKRIVBART, 'tävlingen');
      await db.doc(`competitions/${cid}`).update(patch);
      return { andrade: Object.keys(patch) };
    }
  },
  {
    namn: 'kontroller_lista',
    beskrivning: 'Alla kontroller med nummer, namn, koordinater och poäng. '
      + 'Kontroller adresseras med NUMMER i alla andra verktyg.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async kor(_a, { db, cid }) {
      const snap = await db.collection(`competitions/${cid}/controls`).get();
      return snap.docs
        .map(d => maskera(d.data(), KONTROLL))   // doc-id lämnar ALDRIG servern
        .sort((x, y) => (x.nummer ?? 999) - (y.nummer ?? 999));
    }
  },
  {
    namn: 'kontroll_skapa',
    beskrivning: 'Skapa en kontroll. Numret måste vara ledigt.',
    schema: {
      type: 'object', additionalProperties: false,
      required: ['nummer', 'name'],
      properties: {
        nummer: { type: 'number' }, name: { type: 'string' },
        lat: { type: 'number' }, lng: { type: 'number' },
        maxPoang: { type: 'number' }, placement: { type: 'string' }
      }
    },
    async kor(a, { db, cid }) {
      const snap = await db.collection(`competitions/${cid}/controls`).get();
      if (snap.docs.some(d => Number(d.data().nummer) === Number(a.nummer))) {
        throw fel(`Kontroll ${a.nummer} finns redan.`);
      }
      const { nummer, ...rest } = a;
      const data = { nummer, open: false, ...kontrollera(rest, KONTROLL_SKRIVBART, 'kontrollen') };
      await db.collection(`competitions/${cid}/controls`).add(data);
      return { skapad: `kontroll ${nummer}` };
    }
  },
  {
    namn: 'kontroll_uppdatera',
    beskrivning: 'Ändra en kontroll, utpekad med sitt nummer.',
    schema: {
      type: 'object', additionalProperties: false, required: ['nummer'],
      properties: {
        nummer: { type: 'number' },
        andra: {
          type: 'object', additionalProperties: false,
          properties: Object.fromEntries(Object.entries(KONTROLL_SKRIVBART).map(([k, t]) =>
            [k, { type: t === 'num' ? 'number' : t === 'bool' ? 'boolean' : 'string' }]))
        }
      }
    },
    async kor(a, { db, cid }) {
      const doc = await hittaKontroll(db, cid, a.nummer);
      const patch = kontrollera(a.andra, KONTROLL_SKRIVBART, 'kontrollen');
      await doc.ref.update(patch);
      return { andrade: Object.keys(patch), kontroll: a.nummer };
    }
  },
  {
    namn: 'patruller_lista',
    beskrivning: 'Alla patruller med namn, kår och avdelning. Patruller '
      + 'adresseras med NAMN (och kår när flera heter lika).',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async kor(_a, { db, cid }) {
      const snap = await db.collection(`competitions/${cid}/patrols`).get();
      return snap.docs
        .map(d => maskera(d.data(), PATRULL))
        .sort((x, y) => (x.startOrder ?? 999) - (y.startOrder ?? 999));
    }
  },
  {
    namn: 'patrull_skapa',
    beskrivning: 'Lägg till en patrull.',
    schema: {
      type: 'object', additionalProperties: false, required: ['name'],
      properties: {
        name: { type: 'string' }, kar: { type: 'string' },
        avdelning: { type: 'string' }, startOrder: { type: 'number' }
      }
    },
    async kor(a, { db, cid }) {
      const data = kontrollera(a, PATRULL_SKRIVBART, 'patrullen');
      await db.collection(`competitions/${cid}/patrols`).add(data);
      return { skapad: `${a.name}${a.kar ? ' (' + a.kar + ')' : ''}` };
    }
  },
  {
    namn: 'patrull_uppdatera',
    beskrivning: 'Ändra en patrull, utpekad med namn (och kår vid dubbletter).',
    schema: {
      type: 'object', additionalProperties: false, required: ['name'],
      properties: {
        name: { type: 'string' }, kar: { type: 'string' },
        andra: {
          type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string' }, kar: { type: 'string' },
            avdelning: { type: 'string' }, startOrder: { type: 'number' }
          }
        }
      }
    },
    async kor(a, { db, cid }) {
      const doc = await hittaPatrull(db, cid, a.name, a.kar);
      const patch = kontrollera(a.andra, PATRULL_SKRIVBART, 'patrullen');
      await doc.ref.update(patch);
      return { andrade: Object.keys(patch), patrull: a.name };
    }
  },
  {
    namn: 'ledning_satt',
    beskrivning: 'Sätt tävlingsledningens roller och kontaktuppgifter. '
      + 'VIKTIGT: uppgifterna går INTE att läsa tillbaka — servern svarar bara '
      + '"(ifyllt)" eller "(saknas)". Skriv därför hela uppsättningen på en gång, '
      + 'och be människan kontrollera i ESKIL efteråt.',
    schema: {
      type: 'object', additionalProperties: false, required: ['roller'],
      properties: {
        roller: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['label'],
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              visibility: { type: 'string', enum: ['public', 'internal'] },
              ekonomi: { type: 'boolean' },
              name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }
            }
          }
        }
      }
    },
    async kor(a, { db, cid }) {
      const roller = (a.roller || []).map((r, i) => ({ ...r, id: r.id || `r-mcp-${i}-${Date.now().toString(36)}` }));
      const { publikt, internPii } = delaLedning(roller);
      await db.doc(`competitions/${cid}`).update({ management: publikt });
      const ledRef = db.doc(`competitions/${cid}/private/ledning`);
      if (Object.keys(internPii).length) await ledRef.set({ internPii });
      else await ledRef.delete().catch(() => {});
      await syncSpeglar(db, cid, internPii);
      // Svaret bekräftar STRUKTUREN, aldrig värdena.
      return {
        roller: publikt.map(r => ({
          label: r.label, visibility: r.visibility, ekonomi: r.ekonomi,
          kontaktuppgifter: (r.name || r.phone || r.email || internPii[r.id]) ? '(ifyllt)' : '(saknas)'
        }))
      };
    }
  }
];

/** Speglarna är härledda — skrivs om när ledningen ändras. */
async function syncSpeglar(db, cid, internPii) {
  const snap = await db.collection(`competitions/${cid}/faltinfo`).get();
  if (snap.empty) return;
  let batch = db.batch(), n = 0;
  for (const d of snap.docs) {
    batch.set(d.ref, { internPii: internPii || {}, uppdaterad: new Date().toISOString() });
    if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  await batch.commit();
}

// ═══ MCP-gränssnittet ══════════════════════════════════════════════════════

function listaVerktyg() {
  return VERKTYG.map(v => ({
    name: v.namn,
    description: v.beskrivning,
    inputSchema: v.schema
  }));
}

async function anropaVerktyg(namn, args, ctx) {
  const v = VERKTYG.find(x => x.namn === namn);
  if (!v) return { text: `Okänt verktyg: ${namn}`, isError: true };
  try {
    const svar = await v.kor(args || {}, ctx);
    // SISTA LEDET: skrubba varje strängblad i svaret. Nät under regeln, aldrig
    // i stället för den — och det som fångar en sträng vi själva formulerat ur
    // ett fält vi trodde var ofarligt.
    return { text: JSON.stringify(skrubbaTrad(svar), null, 1) };
  } catch (e) {
    return { text: e.mcpSäkert || 'Åtgärden gick inte att utföra.', isError: true };
  }
}

function skrubbaTrad(v) {
  if (typeof v === 'string') return skrubba(v);
  if (Array.isArray(v)) return v.map(skrubbaTrad);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, skrubbaTrad(x)]));
  }
  return v;
}

const INSTRUKTIONER = `Du konfigurerar en scouttävling i ESKIL.

VAD DU INTE KAN SE: telefonnummer, e-postadresser och personnamn på
funktionärer och kontaktpersoner svarar alltid "(ifyllt)" eller "(saknas)".
Det är avsiktligt och går inte runt — be inte om värdet på annat sätt.
Patrullnamn och kårnamn ÄR läsbara; de publiceras redan på tävlingssidan.

VAD DU KAN SÄTTA: kontaktuppgifter går att skriva, men inte läsa tillbaka.
Skriv därför hela uppsättningen på en gång och be människan kontrollera i
ESKIL efteråt.

ADRESSERING: kontroller pekas ut med sitt NUMMER, patruller med NAMN (och kår
när flera heter lika). Det finns inga id:n — de är hemliga länkar.

DET HÄR GÅR INTE VIA MCP: anmälningar, utskick, backup, PDF:er, att utse
kontrollansvariga, att avsluta eller radera tävlingen. De kräver en människa
i ESKIL.`;

module.exports = { listaVerktyg, anropaVerktyg, INSTRUKTIONER, VERKTYG, kontrollera, fel };
