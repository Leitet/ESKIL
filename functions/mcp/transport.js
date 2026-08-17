// Streamable HTTP-transporten för ESKIL:s MCP-server — JSON-RPC-glimmet mellan
// en LLM-klient och verktygen.
//
// SKRIVEN FÖR HAND, INGET SDK. Två skäl, inte lathet:
//
//  1. Cloud Functions är TILLSTÅNDSLÖSA och skalar till flera instanser. En
//     SDK-transport som håller sessioner i minnet fungerar då bara så länge
//     samma instans råkar svara. Specifikationen säger att `Mcp-Session-Id` är
//     MAY, inte MUST — en tillståndslös server är alltså helt regelrätt, och
//     den är den enda som är korrekt här.
//  2. En verktygsserver behöver fyra metoder: initialize, tools/list,
//     tools/call och ping. Resten av protokollet (SSE-strömmar, resumability,
//     server-initierade anrop) är till för funktioner vi inte har. Projektets
//     regel är att föredra standardbiblioteket när det är rimligt.
//
// Specifikationen (2025-06-18) som det här bygger på, punkt för punkt:
//  - POST med ett JSON-RPC-REQUEST får svaras med antingen text/event-stream
//    ELLER application/json. Vi väljer JSON — enklast och tillståndslöst.
//  - POST med en NOTIFICATION eller RESPONSE ska svaras med 202 utan kropp.
//  - GET får svaras med 405 om servern inte erbjuder någon SSE-ström.
//  - DELETE får svaras med 405 om klienten inte får avsluta sessioner.
//  - Servern MÅSTE validera Origin-headern (skydd mot DNS-rebinding).
//  - Saknas MCP-Protocol-Version ska 2025-03-26 antas. Är den ogiltig: 400.

const PROTOKOLL_VI_TALAR = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SENASTE = '2025-06-18';
// Saknas headern helt föreskriver specifikationen den här versionen.
const UTAN_HEADER = '2025-03-26';

// JSON-RPC 2.0-koder. -32000 och nedåt är fritt för implementationen.
const FEL = {
  parse: -32700,
  ogiltigForfragan: -32600,
  metodSaknas: -32601,
  ogiltigParam: -32602,
  internt: -32603
};

/**
 * Origin-kontroll.
 *
 * Specifikationens krav finns för att en webbsida inte ska kunna prata med en
 * MCP-server som lyssnar på localhost (DNS-rebinding). En PUBLIK server med
 * token i adressen har ett annat hotläge, och kravet måste tolkas rätt:
 *
 *   - Ingen Origin alls → SLÄPP IGENOM. Native-klienter (Claude Code, Desktop,
 *     Cursor) skickar ingen Origin. Att kräva en hade gjort servern oanvändbar
 *     för precis de klienter den är till för.
 *   - Origin finns → det är en WEBBLÄSARE som anropar oss från en sida. Bara
 *     våra egna ursprung får göra det. Allt annat nekas: en främmande sida ska
 *     inte kunna få webbläsaren att använda en token som ligger i historiken.
 */
function originOk(origin) {
  if (!origin) return true;
  return [
    'https://eskilscout.se',
    'https://www.eskilscout.se',
    'https://eskil-scout.web.app',
    'https://eskil-scout.firebaseapp.com',
    'http://127.0.0.1:5050',
    'http://localhost:5050'
  ].includes(origin);
}

function svaraFel(res, httpStatus, kod, meddelande, id = null) {
  res.status(httpStatus).json({
    jsonrpc: '2.0',
    id,
    error: { code: kod, message: meddelande }
  });
}

/**
 * Hanterar en HTTP-förfrågan mot MCP-endpointen.
 *
 * @param req      Express-liknande request från onRequest
 * @param res      Express-liknande response
 * @param server   { namn, version, instruktioner, listaVerktyg(), anropaVerktyg(namn, args) }
 *                 anropaVerktyg returnerar { text } eller { text, isError }.
 */
async function hanteraMcp(req, res, server) {
  if (!originOk(req.headers.origin)) {
    // 403, inte 400: det är en behörighetsfråga, inte en formfråga.
    return svaraFel(res, 403, FEL.ogiltigForfragan, 'Otillåtet ursprung.');
  }

  // GET och DELETE: specifikationen tillåter uttryckligen 405 när servern
  // varken erbjuder en SSE-ström eller sessioner att avsluta.
  if (req.method === 'GET' || req.method === 'DELETE') {
    res.set('Allow', 'POST');
    return svaraFel(res, 405, FEL.ogiltigForfragan,
      'Den här servern erbjuder ingen SSE-ström. Använd POST.');
  }
  if (req.method !== 'POST') {
    res.set('Allow', 'POST');
    return svaraFel(res, 405, FEL.ogiltigForfragan, 'Endast POST stöds.');
  }

  const version = req.headers['mcp-protocol-version'] || UTAN_HEADER;
  if (!PROTOKOLL_VI_TALAR.includes(String(version))) {
    // Specifikationen: ogiltig eller ostödd version MÅSTE ge 400.
    return svaraFel(res, 400, FEL.ogiltigForfragan,
      `Protokollversion ${version} stöds inte. Servern talar ${PROTOKOLL_VI_TALAR.join(', ')}.`);
  }

  let meddelande = req.body;
  if (typeof meddelande === 'string') {
    try { meddelande = JSON.parse(meddelande); }
    catch { return svaraFel(res, 400, FEL.parse, 'Kroppen är inte giltig JSON.'); }
  }
  if (!meddelande || typeof meddelande !== 'object' || Array.isArray(meddelande)) {
    // Batchning togs bort ur protokollet i 2025-06-18. En array är alltså
    // inte längre giltig indata.
    return svaraFel(res, 400, FEL.ogiltigForfragan,
      'Kroppen måste vara ett enskilt JSON-RPC-meddelande.');
  }

  const { method, id, params } = meddelande;

  // Saknas id är meddelandet en NOTIFICATION (eller ett svar). Specifikationen
  // säger 202 utan kropp — och det gäller även notifications/initialized, som
  // varje klient skickar direkt efter handskakningen.
  if (id === undefined || id === null) {
    return res.status(202).end();
  }

  try {
    switch (method) {
      case 'initialize': {
        // Versionsförhandling: kan vi klientens föreslagna version svarar vi
        // med DEN, annars med vår senaste och låter klienten avgöra.
        const önskad = params?.protocolVersion;
        const svarsversion = PROTOKOLL_VI_TALAR.includes(önskad) ? önskad : SENASTE;
        return res.json({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: svarsversion,
            // Bara verktyg. Vi utlovar INTE listChanged: servern är
            // tillståndslös och kan inte skicka en notifiering.
            capabilities: { tools: {} },
            serverInfo: { name: server.namn, version: server.version },
            instructions: server.instruktioner
          }
        });
      }

      case 'ping':
        return res.json({ jsonrpc: '2.0', id, result: {} });

      case 'tools/list':
        return res.json({ jsonrpc: '2.0', id, result: { tools: server.listaVerktyg() } });

      case 'tools/call': {
        const namn = params?.name;
        if (!namn) return svaraFel(res, 200, FEL.ogiltigParam, 'params.name saknas.', id);
        const utfall = await server.anropaVerktyg(namn, params?.arguments || {});
        // Ett VERKTYGSFEL är inte ett protokollfel: det ska tillbaka som ett
        // lyckat svar med isError, så att modellen kan läsa felet och rätta
        // sig själv i stället för att klienten bryter anropet.
        return res.json({
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text: utfall.text }],
            isError: !!utfall.isError
          }
        });
      }

      default:
        return svaraFel(res, 200, FEL.metodSaknas, `Okänd metod: ${method}`, id);
    }
  } catch (e) {
    // Fel i verktygslagret får aldrig läcka ut ett stacktrace: det kan bära
    // dokumentsökvägar och i värsta fall fältvärden. Meddelandet är vårt eget.
    return svaraFel(res, 200, FEL.internt, e?.mcpSäkert || 'Internt fel i servern.', id);
  }
}

module.exports = { hanteraMcp, FEL, PROTOKOLL_VI_TALAR, SENASTE, originOk };
