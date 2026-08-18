// MCP-transporten. Ren logik — hanteraMcp() tar en Express-liknande req/res,
// så hela protokollet går att köra utan emulator och utan nätverk.
//
// Det här är SKYDDSNÄTET runt den enda inkopplingsväg som bevisligen fungerar
// i produktion. Transporten är handskriven, och varje klient som ska kopplas
// in (Claude Code, Codex, Cursor, VS Code …) driver den lite olika: en annan
// Accept-header, en annan protokollversion, en GET som sonderar. Bryter man
// legacy-vägen märks det inte i ett verktygstest — bara i att en kårledare
// inte får kontakt.
//
// Testet driver handskakningen ORDAGRANT som en SDK-klient gör den:
// initialize → notifications/initialized → tools/list → tools/call.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hanteraMcp, PROTOKOLL_VI_TALAR, SENASTE } = require('../functions/mcp/transport.js');

// --- Attrapper --------------------------------------------------------------

function fejkRes() {
  const r = {
    kod: 200, kropp: undefined, avslutad: false, headers: {},
    status(k) { r.kod = k; return r; },
    json(v) { r.kropp = v; return r; },
    end() { r.avslutad = true; return r; },
    set(k, v) { r.headers[String(k).toLowerCase()] = v; return r; }
  };
  return r;
}

const SERVER = {
  namn: 'eskil',
  version: '1.0.0',
  instruktioner: 'Du konfigurerar en scouttävling i ESKIL.',
  listaVerktyg: () => ([{ name: 'tavling_las', description: 'Läs tävlingen', inputSchema: { type: 'object' } }]),
  anropaVerktyg: async (namn, args) => (namn === 'tavling_las'
    ? { text: '{"name":"Testet"}' }
    : { text: `Okänt verktyg: ${namn}`, isError: true })
};

/** Kör en förfrågan mot transporten och lämna tillbaka det fejkade svaret. */
async function anrop({ method = 'POST', headers = {}, body } = {}) {
  const res = fejkRes();
  const rubriker = {};
  for (const [k, v] of Object.entries(headers)) rubriker[k.toLowerCase()] = v;
  // Klienter skickar alltid en version; testet sätter 2025-06-18 om inget annat sägs.
  if (!('mcp-protocol-version' in rubriker) && !('__utan_version' in rubriker)) {
    rubriker['mcp-protocol-version'] = '2025-06-18';
  }
  delete rubriker.__utan_version;
  await hanteraMcp({ method, headers: rubriker, body }, res, SERVER);
  return res;
}

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

// --- Handskakningen ---------------------------------------------------------

describe('legacy-handskakningen, ordagrant som en klient kör den', () => {
  test('1. initialize svarar med klientens egen version när vi talar den', async () => {
    const res = await anrop({ body: rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'testklient', version: '1' }
    }) });
    assert.equal(res.kod, 200);
    assert.equal(res.kropp.result.protocolVersion, '2025-06-18');
    assert.deepEqual(res.kropp.result.capabilities, { tools: {} });
    assert.equal(res.kropp.result.serverInfo.name, 'eskil');
    assert.match(res.kropp.result.instructions, /scouttävling/);
  });

  test('en klient som ber om en version vi inte talar får vår senaste', async () => {
    // Alternativet — att neka — hade låst ute varje klient som ligger före
    // oss, i stället för att låta den avgöra om den kan tala vår version.
    const res = await anrop({ body: rpc('initialize', { protocolVersion: '1900-01-01' }) });
    assert.equal(res.kropp.result.protocolVersion, SENASTE);
  });

  test('2. notifications/initialized ger 202 UTAN kropp', async () => {
    // Ett svar med kropp på en notifiering bryter mot specen och får vissa
    // klienter att hänga i väntan på ett svar som aldrig ska komma.
    const res = await anrop({ body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    assert.equal(res.kod, 202);
    assert.equal(res.avslutad, true);
    assert.equal(res.kropp, undefined);
  });

  test('3. tools/list ger verktygen', async () => {
    const res = await anrop({ body: rpc('tools/list') });
    assert.equal(res.kropp.result.tools[0].name, 'tavling_las');
  });

  test('4. tools/call ger innehåll i content-listan', async () => {
    const res = await anrop({ body: rpc('tools/call', { name: 'tavling_las', arguments: {} }) });
    assert.equal(res.kod, 200);
    assert.equal(res.kropp.result.content[0].type, 'text');
    assert.equal(res.kropp.result.isError, false);
  });

  test('ett VERKTYGSFEL är ett lyckat svar med isError — inte ett protokollfel', async () => {
    // Bryter man det här slutar modellen kunna rätta sig själv: klienten
    // avbryter anropet i stället för att låta modellen läsa felet.
    const res = await anrop({ body: rpc('tools/call', { name: 'finns_inte' }) });
    assert.equal(res.kod, 200);
    assert.equal(res.kropp.error, undefined);
    assert.equal(res.kropp.result.isError, true);
  });

  test('ping svarar tomt', async () => {
    const res = await anrop({ body: rpc('ping') });
    assert.deepEqual(res.kropp.result, {});
  });
});

// --- Metoder och versioner --------------------------------------------------

describe('metoder, versioner och former', () => {
  test('GET svarar 405 med Allow: POST', async () => {
    // Specen tillåter uttryckligen 405 när servern inte erbjuder någon
    // SSE-ström. En dual-era-klient använder dessutom svaret för att avgöra
    // vilken sorts server den pratar med.
    const res = await anrop({ method: 'GET' });
    assert.equal(res.kod, 405);
    assert.equal(res.headers.allow, 'POST');
  });

  test('DELETE svarar 405', async () => {
    const res = await anrop({ method: 'DELETE' });
    assert.equal(res.kod, 405);
  });

  test('utan MCP-Protocol-Version antas 2025-03-26 och förfrågan går igenom', async () => {
    // Specen föreskriver den defaulten. Att i stället neka hade brutit varje
    // klient som ligger före headern.
    const res = await anrop({ headers: { __utan_version: '1' }, body: rpc('ping') });
    assert.equal(res.kod, 200);
    assert.deepEqual(res.kropp.result, {});
  });

  test('varje version vi säger oss tala fungerar också', async () => {
    for (const v of PROTOKOLL_VI_TALAR) {
      const res = await anrop({ headers: { 'MCP-Protocol-Version': v }, body: rpc('ping') });
      assert.equal(res.kod, 200, `version ${v} nekades`);
    }
  });

  test('en okänd version ger 400', async () => {
    const res = await anrop({ headers: { 'MCP-Protocol-Version': '1900-01-01' }, body: rpc('ping') });
    assert.equal(res.kod, 400);
  });

  test('en array som kropp avvisas — batchning finns inte längre', async () => {
    const res = await anrop({ body: [rpc('ping')] });
    assert.equal(res.kod, 400);
  });

  test('en kropp som sträng tolkas, och trasig JSON ger parsefel', async () => {
    const ok = await anrop({ body: JSON.stringify(rpc('ping')) });
    assert.equal(ok.kod, 200);
    const trasig = await anrop({ body: '{inte json' });
    assert.equal(trasig.kod, 400);
    assert.equal(trasig.kropp.error.code, -32700);
  });

  test('en okänd metod ger -32601 men HTTP 200', async () => {
    const res = await anrop({ body: rpc('resources/list') });
    assert.equal(res.kod, 200);
    assert.equal(res.kropp.error.code, -32601);
  });

  test('tools/call utan namn ger -32602', async () => {
    const res = await anrop({ body: rpc('tools/call', {}) });
    assert.equal(res.kropp.error.code, -32602);
  });
});

// --- Ursprung ---------------------------------------------------------------

describe('Origin-kontrollen', () => {
  test('ingen Origin släpps igenom — native-klienter skickar ingen', async () => {
    // Att kräva en Origin hade gjort servern oanvändbar för precis de
    // klienter den finns till för: Claude Code, Codex, Cursor.
    const res = await anrop({ body: rpc('ping') });
    assert.equal(res.kod, 200);
  });

  test('våra egna ursprung släpps igenom', async () => {
    for (const o of ['https://eskilscout.se', 'https://www.eskilscout.se', 'http://localhost:5050']) {
      const res = await anrop({ headers: { Origin: o }, body: rpc('ping') });
      assert.equal(res.kod, 200, `${o} nekades`);
    }
  });

  test('en främmande sida nekas med 403', async () => {
    const res = await anrop({ headers: { Origin: 'https://elak.example' }, body: rpc('ping') });
    assert.equal(res.kod, 403);
  });
});

// --- Läckage ----------------------------------------------------------------

describe('felsvaren läcker ingenting', () => {
  test('ett kastat fel utan mcpSäkert blir ett generiskt meddelande', async () => {
    // Ett stacktrace kan bära dokumentsökvägar och i värsta fall fältvärden.
    const res = fejkRes();
    await hanteraMcp(
      { method: 'POST', headers: { 'mcp-protocol-version': '2025-06-18' }, body: rpc('tools/call', { name: 'x' }) },
      res,
      { ...SERVER, anropaVerktyg: async () => { throw new Error('competitions/hemligt/private/ledning'); } }
    );
    assert.equal(res.kropp.error.message, 'Internt fel i servern.');
    assert.doesNotMatch(JSON.stringify(res.kropp), /hemligt/);
  });

  test('ett fel märkt mcpSäkert visas som det är', async () => {
    const res = fejkRes();
    const e = new Error('x'); e.mcpSäkert = 'Kontroll 3 finns inte.';
    await hanteraMcp(
      { method: 'POST', headers: { 'mcp-protocol-version': '2025-06-18' }, body: rpc('tools/call', { name: 'x' }) },
      res,
      { ...SERVER, anropaVerktyg: async () => { throw e; } }
    );
    assert.equal(res.kropp.error.message, 'Kontroll 3 finns inte.');
  });
});

describe('protokollrevisionerna — vilka klienter som släpps in', () => {
  test('2025-11-25 släpps in: det är versionen claude.ai och Desktop talar', async () => {
    // Anthropics HOSTADE connector-yta (claude.ai, Claude Desktop, Cowork)
    // förhandlar 2025-11-25 och skickar den i headern. Den saknades i
    // allowlistan, och kontrollen ligger före både body-parsning och
    // metod-dispatch — anslutningen dog alltså på 400 vid FÖRSTA anropet,
    // oavsett nyckel. Claude Code talar 2025-06-18 och fungerade hela tiden,
    // vilket är precis det som gjorde felet svårt att se.
    const res = await anrop({ headers: { 'MCP-Protocol-Version': '2025-11-25' }, body: rpc('tools/list') });
    assert.equal(res.kod, 200);
    assert.ok(res.kropp.result.tools.length);
  });

  test('och handskakningen svarar med samma version tillbaka', async () => {
    const res = await anrop({ body: rpc('initialize', { protocolVersion: '2025-11-25' }) });
    assert.equal(res.kropp.result.protocolVersion, '2025-11-25');
  });

  test('hela sekvensen från en hostad connector går igenom', async () => {
    // Ordagrant som spåret i anthropics/claude-ai-mcp#831: initialize utan
    // versionsheader, sedan notifications/initialized MED den, sedan
    // tools/list. Det andra anropet var det som föll.
    const init = await anrop({ headers: { __utan_version: '1' },
      body: rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {} }) });
    assert.equal(init.kod, 200);
    const notis = await anrop({ headers: { 'MCP-Protocol-Version': '2025-11-25' },
      body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    assert.equal(notis.kod, 202);
    const lista = await anrop({ headers: { 'MCP-Protocol-Version': '2025-11-25' }, body: rpc('tools/list') });
    assert.equal(lista.kod, 200);
  });

  test('2026-07-28 nekas — och MÅSTE nekas med -32600, inte -32022', async () => {
    // Den revisionen är en annan ERA (ingen initialize, per-anrops-_meta,
    // server/discover, resultType i svaret). Vi implementerar inget av det.
    //
    // Koden är fallbackmekanismen, inte en detalj: specen säger att en
    // dual-era-klient ska läsa kroppen på ett 400-svar och backa till
    // initialize BARA om den inte är ett känt modernt fel. Med -32022
    // (UnsupportedProtocolVersionError) läses vi i stället som en modern
    // server, och klienten fortsätter i modernt läge — raka motsatsen till
    // vad bytet var tänkt att åstadkomma.
    const res = await anrop({ headers: { 'MCP-Protocol-Version': '2026-07-28' }, body: rpc('tools/list') });
    assert.equal(res.kod, 400);
    assert.equal(res.kropp.error.code, -32600);
    assert.notEqual(res.kropp.error.code, -32022);
  });

  test('felet räknar upp vad vi FAKTISKT talar, så en människa kan felsöka', async () => {
    const res = await anrop({ headers: { 'MCP-Protocol-Version': '2027-01-01' }, body: rpc('ping') });
    for (const v of PROTOKOLL_VI_TALAR) {
      assert.ok(res.kropp.error.message.includes(v), `${v} nämns inte i felmeddelandet`);
    }
  });

  test('alla revisioner vi talar är initialize-baserade (legacy)', () => {
    // Vaktar mot att någon lägger till en modern revision i listan utan att
    // implementera eran. Serien tar slut före 2026-07-28.
    for (const v of PROTOKOLL_VI_TALAR) {
      assert.ok(v < '2026-01-01', `${v} tillhör en era transporten inte implementerar`);
    }
    assert.equal(SENASTE, PROTOKOLL_VI_TALAR[0]);
  });
});
