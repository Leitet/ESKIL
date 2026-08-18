// Katalogen över LLM-klienter på AI-kopplingens adminsida.
//
// Katalogen är den enda platsen där inkopplingsinstruktionerna bor, och den
// läses av en kårledare som inte kan felsöka. Två fel är därför värre än de
// ser ut:
//
//  1. En post vars kopieringsknapp saknar platshållaren ger ett kommando UTAN
//     adress. Knappen fungerar, texten ser rätt ut, och felet syns först i
//     terminalen hos någon annan.
//  2. En post som skriver adressen till en fil utan att varna för den
//     PROJEKTLOKALA varianten. Claude Code, Cursor och VS Code har alla en
//     sådan, och alla tre dokumentationerna rekommenderar att den checkas in i
//     Git för att delas med teamet. Hela hemligheten ligger i adressen, så det
//     rådet publicerar tävlingens skrivnyckel i ett kodarkiv.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_KLIENTER, PLATSHALLARE, medAdress, hittaKlient } from '../public/js/mcp-klienter.js';

const ADRESS = 'https://eskilscout.se/mcp/ah26/eskil_hemlig-nyckel';

describe('katalogens form', () => {
  test('varje post har allt vyn renderar', () => {
    for (const k of MCP_KLIENTER) {
      assert.ok(k.id, 'post utan id');
      assert.ok(k.namn, `${k.id}: namn saknas`);
      assert.ok(k.sort, `${k.id}: sort saknas`);
      assert.ok(k.ingress, `${k.id}: ingress saknas`);
      assert.ok(Array.isArray(k.steg) && k.steg.length, `${k.id}: steg saknas`);
      assert.ok(k.kopiera?.etikett && k.kopiera?.text, `${k.id}: kopiera saknas`);
      assert.ok(k.lank?.text && k.lank?.href, `${k.id}: länk saknas`);
    }
  });

  test('id:na är unika — vyn slår upp på dem', () => {
    const ider = MCP_KLIENTER.map(k => k.id);
    assert.equal(new Set(ider).size, ider.length);
  });

  test('varje länk går över https', () => {
    for (const k of MCP_KLIENTER) {
      assert.match(k.lank.href, /^https:\/\//, `${k.id}: ${k.lank.href}`);
    }
  });

  test('klienterna som efterfrågades finns med', () => {
    const ider = MCP_KLIENTER.map(k => k.id);
    for (const id of ['claude-code', 'codex', 'grok', 'chatgpt', 'cursor', 'vscode', 'annan']) {
      assert.ok(ider.includes(id), `${id} saknas i katalogen`);
    }
  });

  test('det finns alltid en väg för en klient vi inte tänkt på', () => {
    // Utan den posten blir en klient som inte står i listan en återvändsgränd,
    // fast servern fungerar med den.
    const sista = MCP_KLIENTER[MCP_KLIENTER.length - 1];
    assert.equal(sista.id, 'annan');
  });
});

describe('platshållaren', () => {
  test('varje kopieringsknapp bär platshållaren', () => {
    for (const k of MCP_KLIENTER) {
      assert.ok(k.kopiera.text.includes(PLATSHALLARE),
        `${k.id}: kopieringsknappen skulle ge ett kommando utan adress`);
    }
  });

  test('medAdress byter ut den överallt — inte bara i kommandot', () => {
    for (const k of MCP_KLIENTER) {
      const ut = medAdress(k, ADRESS);
      const allt = JSON.stringify([ut.steg, ut.fil, ut.kopiera.text]);
      assert.ok(!allt.includes(PLATSHALLARE), `${k.id}: platshållare kvar i ${allt.slice(0, 120)}`);
      assert.ok(ut.kopiera.text.includes(ADRESS), `${k.id}: adressen kom aldrig in`);
    }
  });

  test('medAdress rör inte originalet', () => {
    // Vyn renderar om vid varje byte i väljaren. Muterade den katalogen skulle
    // andra gången ge en adress som redan var utbytt.
    const före = JSON.stringify(MCP_KLIENTER);
    MCP_KLIENTER.forEach(k => medAdress(k, ADRESS));
    assert.equal(JSON.stringify(MCP_KLIENTER), före);
  });

  test('en adress som råkar innehålla platshållaren blir inte en oändlig loop', () => {
    const ut = medAdress(hittaKlient('claude-code'), `x${PLATSHALLARE}y`);
    assert.ok(ut.kopiera.text.includes(`x${PLATSHALLARE}y`));
  });
});

describe('varningarna som skyddar nyckeln', () => {
  test('varje klient med en projektlokal konfigfil varnar för Git', () => {
    // Claude Code (--scope project → .mcp.json), Cursor (.cursor/mcp.json) och
    // VS Code (.vscode/mcp.json) dokumenterar alla den filen som något man
    // checkar in för att dela med teamet.
    for (const id of ['claude-code', 'cursor', 'vscode']) {
      const k = hittaKlient(id);
      assert.match(k.varning, /Git/, `${id}: varnar inte för att nyckeln hamnar i kodarkivet`);
    }
  });

  test('varje post säger uttryckligen att ingen inloggning behövs', () => {
    // Klienterna har alla ett fält för OAuth, token eller headers. Sägs det
    // inte rakt ut att de ska stå TOMMA letar man efter något att fylla i,
    // hittar fälten och felsöker en autentisering som inte finns.
    //
    // Att i stället försöka regex-fånga "en uppmaning att sätta OAuth" gick
    // inte: mönstret träffade den NEKANDE meningen ("sätt varken OAuth …"),
    // alltså precis den formulering som är rätt. En positiv egenskap går att
    // pröva; en negativ språklig avsikt gör det inte.
    for (const k of MCP_KLIENTER) {
      const text = [k.ingress, ...k.steg, k.varning || ''].join(' ');
      assert.match(text, /ingen inloggning|ingen autentisering|No authentication|tomma|varken OAuth/i,
        `${k.id}: nämner aldrig att inloggningsfälten ska lämnas tomma`);
    }
  });

  test('katalogen innehåller ingen riktig nyckel', () => {
    // Ett kopierat exempel ur en fungerande uppsättning är den lättaste vägen
    // att av misstag checka in en skarp nyckel.
    const allt = JSON.stringify(MCP_KLIENTER);
    assert.doesNotMatch(allt, /eskil_[A-Za-z0-9_-]{20,}/, 'ser ut som en riktig nyckel');
  });
});

describe('hittaKlient', () => {
  test('slår upp på id', () => {
    assert.equal(hittaKlient('codex').id, 'codex');
  });

  test('ett okänt id ger första posten i stället för att krascha vyn', () => {
    // Väljaren minns valet i localStorage. Tas en klient bort ur katalogen
    // skulle ett sparat id annars rendera undefined.
    assert.equal(hittaKlient('finns-inte'), MCP_KLIENTER[0]);
    assert.equal(hittaKlient(undefined), MCP_KLIENTER[0]);
  });
});
