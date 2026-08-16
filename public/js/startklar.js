// Startklar-kontrollen — härledda förkontroller inför tävlingsdagen.
//
// En ensam förstagångsarrangör upptäcker annars felen först när det smäller:
// en kontroll utan position hamnar i havet på kartan, en kontroll utan
// telefon gör nödinfon i fältpaketet tom, ett hål i nummerordningen bryter
// ett ETA-ben, och patruller utan startordning får ingen starttid. Panelen
// räknar fram avvikelserna ur data som redan finns och länkar rakt till
// stället där de rättas.
//
// REN logik (enda beroendet är utils.js, som självt är rent) — testas i
// test/logic.test.js. Vyn hämtar datan (inklusive kontrollernas private/meta
// för telefonkollen) och ritar.

import { startFinishPoints } from './utils.js';

/**
 * @param comp     tävlingsdokumentet
 * @param controls kontrollerna (publika fälten)
 * @param patrols  patrullerna
 * @param metas    kontrollernas private/meta i samma ordning som controls
 *                 (telefonkollen) — utelämnas ⇒ telefonkollen hoppar över sig
 * @returns [{ id, status: 'ok'|'varning', text, flik }] — flik är compTabs-
 *          fliken dit länken ska peka ('controls'|'patrols'|'settings')
 */
export function startklarChecks(comp, controls = [], patrols = [], metas = null) {
  const ut = [];
  const varning = (id, text, flik) => ut.push({ id, status: 'varning', text, flik });
  const ok = (id, text) => ut.push({ id, status: 'ok', text });

  // --- Kontroller -----------------------------------------------------------
  if (!controls.length) {
    varning('inga-kontroller', 'Inga kontroller är upplagda än.', 'controls');
  } else {
    const utanPos = controls.filter(c => !(Number.isFinite(c.lat) && Number.isFinite(c.lng)));
    if (utanPos.length) {
      varning('position',
        `${utanPos.length} kontroll${utanPos.length === 1 ? '' : 'er'} saknar position på kartan (${namnlista(utanPos)}) — de hamnar utanför både fältpaketets kartor och ETA-beräkningen.`,
        'controls');
    } else ok('position', 'Alla kontroller har en position.');

    // Nummerserien: dubbletter förvirrar allt som sorterar på nummer, och ett
    // hål bryter antagandet att banan går i nummerordning (ETA-benen).
    const nummer = controls.map(c => Number(c.nummer)).filter(Number.isFinite).sort((a, b) => a - b);
    const dubbletter = nummer.filter((n, i) => i > 0 && n === nummer[i - 1]);
    if (dubbletter.length) {
      varning('nummer-dubblett',
        `Kontrollnummer ${[...new Set(dubbletter)].join(', ')} används av flera kontroller.`, 'controls');
    }
    const hål = [];
    for (let i = 1; i < nummer.length; i++) {
      for (let n = nummer[i - 1] + 1; n < nummer[i]; n++) hål.push(n);
    }
    if (hål.length) {
      varning('nummer-hal',
        `Nummerserien har hål (saknar ${hål.join(', ')}) — banan antas gå i nummerordning, så ETA:n räknar fel ben.`, 'controls');
    }
    if (!dubbletter.length && !hål.length) ok('nummer', 'Kontrollernas nummerserie är hel.');

    if (Array.isArray(metas)) {
      const utanTel = controls.filter((c, i) => !(metas[i]?.telefon || '').trim());
      if (utanTel.length) {
        varning('telefon',
          `${utanTel.length} kontroll${utanTel.length === 1 ? '' : 'er'} saknar telefonnummer (${namnlista(utanTel)}) — nödinfon i kontrollens PDF blir tom och grannkontroller kan inte ringa.`,
          'controls');
      } else ok('telefon', 'Alla kontroller har ett telefonnummer.');
    }
  }

  // --- Bana -----------------------------------------------------------------
  // startFinishPoints är samma härledning som kartorna och ETA:n använder —
  // en egen tolkning här hade kunnat säga "klart" om något kartan inte ser.
  if (!startFinishPoints(comp).length) {
    varning('startmal', 'Start/mål är inte utsatt — ETA:ns första och sista ben och stationssidans avprickning bygger på den.', 'controls');
  } else ok('startmal', 'Start/mål är utsatt.');

  // --- Patruller ------------------------------------------------------------
  if (!patrols.length) {
    varning('inga-patruller', 'Inga patruller är upplagda än.', 'patrols');
  } else {
    const startTider = comp?.startTimes?.enabled === true;
    if (!startTider) {
      varning('starttider', 'Starttider är inte aktiverade — startkorten kan inte visa när patrullen ska gå, och sen-till-start-larmet är släckt.', 'settings');
    } else {
      const utanOrdning = patrols.filter(p => !Number.isFinite(Number(p.startOrder)) && !p.utgatt);
      if (utanOrdning.length) {
        varning('startordning',
          `${utanOrdning.length} patrull${utanOrdning.length === 1 ? '' : 'er'} saknar startordning (${namnlista(utanOrdning)}) — de får ingen starttid på sina startkort.`,
          'patrols');
      } else ok('startordning', 'Alla patruller har en startordning.');
    }

    const pnummer = patrols.map(p => Number(p.number)).filter(Number.isFinite).sort((a, b) => a - b);
    const pdubbla = [...new Set(pnummer.filter((n, i) => i > 0 && n === pnummer[i - 1]))];
    if (pdubbla.length) {
      varning('patrullnummer',
        `Patrullnummer ${pdubbla.join(', ')} används av flera patruller — kontrollanterna rapporterar på nummer.`, 'patrols');
    }
  }

  if (!comp?.date) {
    varning('datum', 'Tävlingen saknar datum — starttider och nedräkningar ankras då på dagens klocka i stället för tävlingsdagen.', 'settings');
  }

  return ut;
}

function namnlista(rader, max = 3) {
  const namn = rader
    .map(r => r.name || (r.nummer != null ? `nr ${r.nummer}` : null) || (r.number != null ? `#${r.number}` : '?'))
    .slice(0, max);
  return namn.join(', ') + (rader.length > max ? ` +${rader.length - max}` : '');
}
