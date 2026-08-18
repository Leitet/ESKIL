// Katalog över LLM-klienter och hur var och en kopplar in ESKIL:s MCP-server.
//
// VARFÖR EN EGEN FIL: adminsidan visade en enda rad — `claude mcp add …` — och
// den raden gäller ETT program. En kårledare som kör ChatGPT, Codex eller
// Cursor fick ingen väg alls, fast servern fungerar med alla. Katalogen är
// data, inte vy, så den går att testa och att utöka utan att röra sidan.
//
// TVÅ SAKER SOM MÅSTE STÄMMA I VARJE POST, och som testet vaktar:
//
//  1. `kopiera.text` innehåller PLATSHALLARE exakt en gång. Vyn ersätter den
//     med den riktiga adressen; en post utan platshållare ger en knapp som
//     kopierar ett kommando utan adress, och felet syns först i terminalen
//     hos den som ska följa instruktionen.
//  2. Varje post som skriver adressen till en FIL varnar för projektfilen.
//     Claude Code (`--scope project` → .mcp.json), Cursor (.cursor/mcp.json)
//     och VS Code (.vscode/mcp.json) har alla en projektlokal variant som
//     enligt respektive dokumentation är TÄNKT att checkas in i Git för att
//     delas med teamet. Hela hemligheten ligger i adressen, så det rådet är
//     rakt fel här: det publicerar tävlingens skrivnyckel i ett kodarkiv.
//
// Uppgifterna är hämtade ur klienternas officiella dokumentation i augusti
// 2026 och kontrollerade en gång till av en oberoende genomgång. Området
// ändras snabbt — står en instruktion fel är det den här filen som ska rättas,
// på ett ställe.

/** Ersätts av tävlingens riktiga inkopplingsadress när sidan renderar. */
export const PLATSHALLARE = '<ADRESS>';

export const MCP_KLIENTER = [
  // ── Webb och app: inget att installera, lägst tröskel ────────────────────
  {
    id: 'claude-ai',
    namn: 'claude.ai (webbläsaren)',
    sort: 'Webb',
    ingress: 'Inget att installera. Fungerar även på gratiskonto, men då bara med en egen koppling totalt.',
    steg: [
      'Logga in på claude.ai på en dator.',
      'Gå till Customize → Connectors (Anpassa → Kopplingar).',
      'Klicka på + och välj ”Add custom connector”.',
      'Klistra in adressen. Lämna ”Advanced settings” och OAuth-fälten tomma — ESKIL har ingen inloggning, och det ska inte komma någon inloggningsruta.',
      'Öppna ett nytt samtal, klicka på + i skrivrutan → Connectors och slå på eskil. Det måste göras i varje nytt samtal.'
    ],
    kopiera: { etikett: 'Adress att klistra in', text: PLATSHALLARE },
    varning: 'Har kåren Team eller Enterprise måste en ägare lägga till kopplingen centralt först. En koppling går inte att redigera efteråt — byter du nyckel får du ta bort den och lägga till den på nytt.',
    lank: { text: 'Anthropics guide för egna kopplingar',
            href: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp' }
  },
  {
    id: 'claude-desktop',
    namn: 'Claude Desktop (Mac/Windows)',
    sort: 'App',
    ingress: 'Samma koppling som på claude.ai — den sparas på kontot och följer med till webben och mobilen.',
    steg: [
      'Öppna inställningarna inne i Claude-fönstret: menyikonen uppe till vänster → File → Settings.',
      'Välj Connectors i vänsterspalten och klicka Add → ”Add custom connector”.',
      'Frågar Claude vilken sorts koppling det är: välj Web, aldrig Desktop. ESKIL ligger på internet, inte i datorn.',
      'Klistra in adressen och klicka Add. Lämna OAuth-fälten tomma.',
      'I ett nytt samtal: klicka på + vid skrivrutan → Connectors och slå på eskil.'
    ],
    kopiera: { etikett: 'Adress att klistra in', text: PLATSHALLARE },
    varning: 'Filen claude_desktop_config.json är något helt annat — den är bara för program som körs på din egen dator och fungerar inte här.',
    lank: { text: 'Anthropics guide för egna kopplingar',
            href: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp' }
  },
  {
    id: 'chatgpt',
    namn: 'ChatGPT (webbläsaren)',
    sort: 'Webb',
    ingress: 'Kräver ett betalt konto (Plus, Pro, Business, Enterprise eller Edu) och en dator. Gratiskontot kan inte lägga till egna kopplingar.',
    steg: [
      'Logga in på chatgpt.com och öppna Inställningar → Säkerhet och inloggning (Security and login).',
      'Slå på ”Developer mode”. Hittar du det inte: sök på ”Developer” i inställningarnas sökruta — menyn har bytt namn flera gånger.',
      'Gå till chatgpt.com/plugins och klicka på +.',
      'Skriv namnet eskil, klistra in adressen och välj ”No authentication” när den frågar om inloggning.',
      'I varje nytt samtal: klicka på + i skrivrutan, välj Developer mode och bocka i eskil.'
    ],
    kopiera: { etikett: 'Adress att klistra in', text: PLATSHALLARE },
    varning: 'Den här vägen är läst ur OpenAI:s dokumentation men inte provad mot ESKIL — räkna med att den kan strula, och ha planen att göra ändringen för hand i ESKIL. Har du ChatGPT via jobbet eller skolan kan en administratör dessutom ha stängt av utvecklarläget. Låt bli att låta ChatGPT ”komma ihåg” ett ja för resten av samtalet på en skarp tävling — då sparas ändringar utan att du ser dem.',
    lank: { text: 'OpenAI: Developer mode',
            href: 'https://developers.openai.com/api/docs/guides/developer-mode' }
  },
  {
    id: 'grok',
    namn: 'Grok (grok.com)',
    sort: 'Webb',
    ingress: 'Läggs till som en egen koppling på grok.com. Görs på dator — mobilapparna beskrivs inte i dokumentationen.',
    steg: [
      'Logga in på grok.com och gå till grok.com/connectors.',
      'Klicka ”New Connector” och välj ”Custom”.',
      'Klistra in adressen och döp kopplingen till eskil.',
      'Lämna fälten för inloggning, token och API-nyckel tomma.',
      'Spara. Grok läser då av vilka verktyg servern erbjuder och använder dem när frågan gäller tävlingen.'
    ],
    kopiera: { etikett: 'Adress att klistra in', text: PLATSHALLARE },
    varning: 'Den här vägen är läst ur xAI:s dokumentation men inte provad mot ESKIL. Har kåren Grok Business eller Enterprise måste en teamadministratör dessutom lägga in servern på console.x.ai först.',
    lank: { text: 'xAI: Connectors', href: 'https://docs.x.ai/docs/guides/connectors' }
  },

  // ── Kodverktyg: konfigurationsfil ────────────────────────────────────────
  {
    id: 'cursor',
    namn: 'Cursor',
    sort: 'Kodverktyg',
    ingress: 'Läggs in i en fil i din hemmapp.',
    fil: '~/.cursor/mcp.json   (Windows: %USERPROFILE%\\.cursor\\mcp.json)',
    steg: [
      'Öppna mappen .cursor i din hemmapp. På Mac: Finder → Skift+Cmd+G → skriv ~/.cursor. Finns den inte, skapa den.',
      'Öppna eller skapa filen mcp.json där och klistra in innehållet nedan.',
      'Innehöll filen redan andra servrar: lägg in eskil-blocket inuti den mcpServers-klammer som redan finns, med ett komma emellan. Ha aldrig två mcpServers i samma fil.',
      'Spara och starta om Cursor. Sätt varken headers eller auth — ESKIL har ingen inloggning, hemligheten ligger i adressen.',
      'Kontrollera under Customize → MCPs att eskil står i listan med sina verktyg.'
    ],
    kopiera: {
      etikett: 'Innehåll till mcp.json',
      text: `{
  "mcpServers": {
    "eskil": {
      "url": "${PLATSHALLARE}"
    }
  }
}`
    },
    varning: 'Lägg filen i hemmappen, aldrig som .cursor/mcp.json i ett projekt — den varianten är enligt Cursors dokumentation tänkt att checkas in i Git, och då hamnar tävlingens nyckel i kodarkivet.',
    lank: { text: 'Cursor: MCP', href: 'https://cursor.com/docs/context/mcp' },
    // Sätt inte "type": "http" här. Cursor dokumenterar `type` ENBART för
    // lokala stdio-servrar; för fjärrservrar visar varje exempel bara `url`.
    // VS Code är tvärtom — där KRÄVS "type": "http". Att de skiljer sig är
    // hela skälet till att katalogen bär en färdig snutt per klient i stället
    // för en gemensam.
    utanTyp: true
  },
  {
    id: 'vscode',
    namn: 'VS Code med GitHub Copilot',
    sort: 'Kodverktyg',
    ingress: 'Verktygen syns bara när chatten står i agentläge.',
    steg: [
      'Öppna kommandopaletten: Ctrl+Skift+P (Windows) eller Skift+Cmd+P (Mac).',
      'Kör ”MCP: Open User Configuration”. Då öppnas mcp.json i din användarprofil — välj den, inte arbetsytans fil.',
      'Klistra in innehållet nedan och spara. Lägg inte till headers eller inloggning — ESKIL har ingen autentisering utöver adressen.',
      'Klicka på Start som dyker upp ovanför raden ”eskil”, och svara ja på frågan om du litar på servern. Svarar du nej startas den aldrig, helt tyst.',
      'Ställ chatten i agentläge och kontrollera under ”Configure Tools” att ESKIL:s verktyg finns med.'
    ],
    kopiera: {
      etikett: 'Innehåll till mcp.json',
      text: `{
  "servers": {
    "eskil": {
      "type": "http",
      "url": "${PLATSHALLARE}"
    }
  }
}`
    },
    varning: 'Välj användarprofilen, inte arbetsytans .vscode/mcp.json — den filen är enligt VS Code:s dokumentation tänkt att delas i Git. Har du Settings Sync påslaget följer adressen dessutom med till varje dator du är inloggad på.',
    lank: { text: 'VS Code: MCP-servrar',
            href: 'https://code.visualstudio.com/docs/agent-customization/mcp-servers' }
  },

  // ── Terminal ─────────────────────────────────────────────────────────────
  {
    id: 'claude-code',
    namn: 'Claude Code (terminal)',
    sort: 'Terminal',
    ingress: 'Ett kommando i terminalen. Kräver att Claude Code är installerat och ett betalt Claude-konto.',
    steg: [
      'Öppna Terminal (Mac) eller PowerShell (Windows).',
      'Kör raden nedan. Lägg inte till --header eller någon inloggning — ESKIL har ingen autentisering utöver adressen.',
      'Kontrollera med kommandot claude mcp list — raden för eskil ska sluta med ”Connected”. Kommandot kontrollerar ingenting när du lägger till servern, så en felstavad adress ser ut att lyckas och visar sig först här.',
      'Blev det fel: ta bort med claude mcp remove eskil -s user och gör om. Kör du add igen med samma namn svarar den bara att servern redan finns, utan att ändra något.'
    ],
    kopiera: { etikett: 'Kommando', text: `claude mcp add --transport http --scope user eskil ${PLATSHALLARE}` },
    varning: 'claude mcp list och claude mcp get skriver ut HELA adressen, nyckeln inkluderad — klistra aldrig in svaret i ett supportärende eller en chatt utan att stryka den. Behåll också --scope user: utan flaggan gäller kopplingen bara den mapp du råkade stå i, och --scope project skriver adressen till en .mcp.json som är tänkt att delas i Git.',
    lank: { text: 'Claude Code: MCP', href: 'https://code.claude.com/docs/en/mcp' }
  },
  {
    id: 'codex',
    namn: 'Codex CLI (terminal)',
    sort: 'Terminal',
    ingress: 'Ett kommando i terminalen. Kräver en någorlunda ny Codex — uppdatera med npm install -g @openai/codex@latest om kommandot inte känns igen.',
    fil: '~/.codex/config.toml',
    steg: [
      'Öppna Terminal och kör raden nedan.',
      'Svarar Codex något om att servern kan kräva inloggning: strunta i det. Kör inte codex mcp login — ESKIL har ingen inloggning.',
      'Kontrollera med codex mcp list att eskil står med.',
      'Öppna ~/.codex/config.toml och lägg till raderna startup_timeout_sec = 30 och tool_timeout_sec = 120 under [mcp_servers.eskil]. ESKIL:s server kallstartar, och Codex väntar bara 10 respektive 60 sekunder som standard.',
      'Starta codex och skriv /mcp för att se att verktygen finns.'
    ],
    kopiera: { etikett: 'Kommando', text: `codex mcp add eskil --url ${PLATSHALLARE}` },
    varning: 'Sätt inte bearer_token_env_var eller http_headers. Hemligheten ligger redan i adressen, och en extra header gör bara konfigurationen skörare.',
    lank: { text: 'Codex: MCP', href: 'https://developers.openai.com/codex/mcp' }
  },
  {
    id: 'gemini-cli',
    namn: 'Gemini CLI (terminal)',
    sort: 'Terminal',
    ingress: 'Ett kommando i terminalen.',
    fil: '~/.gemini/settings.json',
    steg: [
      'Öppna Terminal och kör raden nedan. Ingen inloggning behövs — hemligheten ligger i adressen.',
      'Kontrollera med gemini mcp list att eskil står med.',
      'Starta gemini och skriv /mcp för att se verktygen.'
    ],
    kopiera: { etikett: 'Kommando', text: `gemini mcp add --transport http --scope user eskil ${PLATSHALLARE}` },
    varning: 'Behåll --scope user, annars gäller kopplingen bara den mapp du står i.',
    lank: { text: 'Gemini CLI: MCP',
            href: 'https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html' }
  },

  // ── Sista utvägen: allt annat ────────────────────────────────────────────
  {
    id: 'annan',
    namn: 'Någon annan klient',
    sort: 'Övrigt',
    ingress: 'Servern följer MCP:s Streamable HTTP. De flesta klienter behöver bara adressen.',
    steg: [
      'Lägg till en fjärrserver (”remote MCP server”, ”Streamable HTTP” eller bara ”HTTP”) och klistra in adressen.',
      'Välj ingen autentisering. Hemligheten ligger i adressen — sätt varken OAuth, Bearer-token eller egna headers.',
      'Kräver klienten ett program att köra i stället för en adress, går det via bryggan mcp-remote: npx -y mcp-remote ' + PLATSHALLARE,
      'Säger klienten att den inte kan nå servern, eller att protokollversionen inte stöds: säg till oss. Det är då sannolikt ESKIL som behöver släppa in klientens version, och det går inte att lösa i din inställningsfil.'
    ],
    kopiera: { etikett: 'Adress', text: PLATSHALLARE },
    varning: 'Servern är tillståndslös: den svarar JSON på POST, sätter inget Mcp-Session-Id och svarar 405 på GET eftersom den inte erbjuder någon SSE-ström. Allt tre är tillåtet enligt specifikationen och ska inte hindra en klient.',
    lank: { text: 'Om MCP', href: 'https://modelcontextprotocol.io/' }
  }
];

/**
 * Posten med den riktiga adressen isatt överallt där platshållaren står.
 * Vyn ska aldrig ersätta för hand — då är det lätt att missa ett fält, och
 * bara ett av dem syns på skärmen.
 */
export function medAdress(klient, adress) {
  const byt = (s) => String(s).split(PLATSHALLARE).join(adress);
  return {
    ...klient,
    steg: klient.steg.map(byt),
    fil: klient.fil ? byt(klient.fil) : '',
    kopiera: { ...klient.kopiera, text: byt(klient.kopiera.text) }
  };
}

/** Uppslagning på id, med första posten som reserv. */
export function hittaKlient(id) {
  return MCP_KLIENTER.find(k => k.id === id) || MCP_KLIENTER[0];
}
