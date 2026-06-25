import { GameState, CardId, Card } from '../types/poker';
import { cardToId, handGroupName } from './cfr/card-utils';
import { evaluateHand, HAND_CATEGORY, handCategoryName } from './equity/hand-eval';
import { quickEquity } from './equity/monte-carlo';
import { equityVsRange } from './equity/range-equity';
import { villainContinuingRange } from './postflop-strategy';

// ============================================================
// Poker analysis / explanation engine.
//
// Turns a spot (and the move facing us) into a HUMAN-READABLE read grounded in
// real math — made hand, draws, equity vs villain's range, pot odds, and what
// the action represents — so the bot can actually explain "what's going on here"
// instead of emitting a black-box action. This is the "understand poker" layer:
// every claim is backed by the same equity/range engine the decision uses.
// ============================================================

const RANK_SYM = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUIT_SYM: Record<number, string> = { 0: '♥', 1: '♦', 2: '♣', 3: '♠' };
const rankOf = (c: CardId) => (c / 4) | 0;
const suitOf = (c: CardId) => c % 4;
const cardStr = (c: CardId) => `${RANK_SYM[rankOf(c)]}${SUIT_SYM[suitOf(c)]}`;

export interface DrawInfo { flushDraw: boolean; nutFlushDraw: boolean; oesd: boolean; gutshot: boolean; }

export interface SpotAnalysis {
  hand: string;            // "A♥K♥ (AKs)"
  board: string;           // "K♣ 7♦ 2♠"
  street: string;
  madeHand: string;        // "top pair, top kicker" etc.
  draws: string[];         // ["flush draw", "gutshot"]
  equityVsRange: number;   // 0..1 vs villain's plausible continuing range
  facing: { toCall: number; pot: number; potOdds: number } | null;
  read: string;            // plain-English situation + what the action represents
  recommendation: string;  // what to do and why
}

/** Compact draw detection (flush / straight) from hole + board, cards still to come. */
function detectDraws(hole: [CardId, CardId], board: CardId[], madeCat: number): DrawInfo {
  const d: DrawInfo = { flushDraw: false, nutFlushDraw: false, oesd: false, gutshot: false };
  if (board.length >= 5) return d; // river: no draws
  const hs = [suitOf(hole[0]), suitOf(hole[1])];
  const hr = [rankOf(hole[0]), rankOf(hole[1])];
  const bs = board.map(suitOf);
  const br = board.map(rankOf);
  if (madeCat < HAND_CATEGORY.FLUSH) {
    for (let s = 0; s < 4; s++) {
      const tot = hs.filter(x => x === s).length + bs.filter(x => x === s).length;
      if (hs.includes(s) && tot === 4) {
        d.flushDraw = true;
        if (hr.some((r, i) => hs[i] === s && r === 12)) d.nutFlushDraw = true;
      }
    }
  }
  if (madeCat < HAND_CATEGORY.STRAIGHT) {
    const present = new Set([...hr, ...br]);
    const hole = new Set(hr);
    const has = (r: number) => (r === -1 ? present.has(12) : present.has(r));
    const holeHas = (r: number) => (r === -1 ? hole.has(12) : hole.has(r));
    let outs = 0;
    for (let o = 0; o < 13; o++) {
      if (present.has(o)) continue;
      present.add(o);
      let found = false;
      for (let lo = -1; lo <= 8 && !found; lo++) {
        let ok = true, uh = false, uo = false;
        for (let k = 0; k < 5; k++) { const r = lo + k; if (!has(r)) { ok = false; break; } if (r === o) uo = true; if (holeHas(r)) uh = true; }
        if (ok && uo && uh) found = true;
      }
      present.delete(o);
      if (found) outs++;
    }
    if (outs >= 2) d.oesd = true; else if (outs === 1) d.gutshot = true;
  }
  return d;
}

/** Describe a one-pair hand relative to the board (top pair, overpair, etc.). */
function describePair(hole: [CardId, CardId], board: CardId[]): string {
  const hr = [rankOf(hole[0]), rankOf(hole[1])];
  const br = board.map(rankOf);
  const top = Math.max(...br);
  if (hr[0] === hr[1]) return hr[0] > top ? 'an overpair' : 'an underpair';
  const matched = hr.find(r => br.includes(r));
  const kicker = hr.find(r => !br.includes(r));
  const kStr = kicker !== undefined ? `, ${RANK_SYM[kicker]} kicker` : '';
  if (matched === top) return `top pair${kStr}`;
  const sorted = [...new Set(br)].sort((a, b) => b - a);
  if (matched === sorted[1]) return `second pair${kStr}`;
  return `a weak pair${kStr}`;
}

function describeMadeHand(hole: [CardId, CardId], board: CardId[]): { name: string; cat: number } {
  if (board.length < 3) return { name: 'unmade (preflop)', cat: HAND_CATEGORY.HIGH_CARD };
  const rank = evaluateHand([hole[0], hole[1], ...board]);
  const cat = Math.floor(rank / 1_000_000);
  let name = handCategoryName(rank).toLowerCase();
  if (cat === HAND_CATEGORY.PAIR) name = describePair(hole, board);
  else if (cat === HAND_CATEGORY.HIGH_CARD) {
    const hi = Math.max(rankOf(hole[0]), rankOf(hole[1]));
    name = `${RANK_SYM[hi]}-high (no pair)`;
  }
  return { name, cat };
}

/**
 * Analyze the hero's spot: what we have, our equity vs villain's range, the price
 * we're being offered, and what the correct read/decision is — all in plain
 * English backed by the real equity engine.
 */
export function analyzeSpot(state: GameState): SpotAnalysis {
  const hole: [CardId, CardId] = [cardToId(state.heroCards![0]), cardToId(state.heroCards![1])];
  const board = state.communityCards.map(c => cardToId(c));
  const heroBet = state.players[state.heroIndex]?.currentBet || 0;
  const toCall = Math.max(0, (state.currentBet || 0) - heroBet);
  const pot = Math.max(1, state.pot);
  const facingBet = toCall > 0;

  const { name: madeHand, cat } = describeMadeHand(hole, board);
  const dr = board.length >= 3 ? detectDraws(hole, board, cat) : { flushDraw: false, nutFlushDraw: false, oesd: false, gutshot: false };
  const draws: string[] = [];
  if (dr.nutFlushDraw) draws.push('nut flush draw'); else if (dr.flushDraw) draws.push('flush draw');
  if (dr.oesd) draws.push('open-ended straight draw'); else if (dr.gutshot) draws.push('gutshot');

  // Equity vs a plausible continuing/betting range (postflop) or vs random (preflop).
  let eqR: number;
  if (board.length >= 3) {
    const range = villainContinuingRange(hole, board, { aggression: facingBet, multiway: false });
    eqR = range.length ? equityVsRange(hole, board, range, 1500).equity : quickEquity(hole, board);
  } else {
    eqR = quickEquity(hole, board);
  }

  const potOdds = facingBet ? toCall / (pot + toCall) : 0;
  const facing = facingBet ? { toCall, pot, potOdds } : null;

  // ---- the read + recommendation ----
  const eqPct = (x: number) => `${(x * 100).toFixed(0)}%`;
  let read: string;
  let recommendation: string;

  if (facingBet) {
    const sizeFrac = toCall / pot;
    const sizeDesc = sizeFrac >= 1.3 ? 'an overbet' : sizeFrac >= 0.75 ? 'a big bet' : sizeFrac >= 0.45 ? 'a ~half-to-2/3 pot bet' : 'a small bet';
    read = `Villain put in ${sizeDesc} (${eqPct(sizeFrac)} of pot). You hold ${madeHand}` +
      (draws.length ? ` with ${draws.join(' + ')}` : '') +
      `, ~${eqPct(eqR)} equity vs the range that bets here. You're getting ${eqPct(potOdds)} pot odds, so you need ${eqPct(potOdds)} equity to call.`;
    if (eqR >= 0.70) recommendation = `Strong: raise for value — you crush this betting range (${eqPct(eqR)} > 70%).`;
    else if (eqR >= potOdds + 0.02) recommendation = `Call — your ${eqPct(eqR)} clears the ${eqPct(potOdds)} you need (${draws.length ? 'the draw has the price' : 'a profitable bluff-catch'}).`;
    else recommendation = `Fold — ${eqPct(eqR)} is below the ${eqPct(potOdds)} you need; calling here is -EV (this is the "don't punt" line).`;
  } else if (board.length >= 3) {
    read = `Checked to you. You hold ${madeHand}` + (draws.length ? ` with ${draws.join(' + ')}` : '') +
      `, ~${eqPct(eqR)} equity vs villain's continuing range.`;
    if (eqR >= 0.62) recommendation = `Bet for value — ${eqPct(eqR)} is ahead of the calling range; size up on this texture.`;
    else if (draws.length) recommendation = `Semi-bluff candidate — you're behind now (${eqPct(eqR)}) but the ${draws.join('/')} gives you outs to barrel.`;
    else recommendation = `Check — ${eqPct(eqR)} is marginal with no draw; pot-control, don't bloat the pot.`;
  } else {
    const name = handGroupName(hole[0], hole[1]);
    read = `Preflop: ${name}, ~${eqPct(eqR)} equity vs a random hand.`;
    recommendation = `Use the solved preflop chart for this position/scenario.`;
  }

  return {
    hand: `${cardStr(hole[0])}${cardStr(hole[1])} (${handGroupName(hole[0], hole[1])})`,
    board: board.map(cardStr).join(' ') || '(preflop)',
    street: state.street,
    madeHand, draws, equityVsRange: eqR, facing, read, recommendation,
  };
}

/** Render a SpotAnalysis as a readable multi-line block. */
export function formatAnalysis(a: SpotAnalysis): string {
  const lines = [
    `Hand:   ${a.hand}`,
    `Board:  ${a.board}  (${a.street})`,
    `Made:   ${a.madeHand}${a.draws.length ? ' + ' + a.draws.join(', ') : ''}`,
    `Equity: ${(a.equityVsRange * 100).toFixed(0)}% vs range`,
    a.facing ? `Facing: ${a.facing.toCall} into ${a.facing.pot} (need ${(a.facing.potOdds * 100).toFixed(0)}% to call)` : `Facing: nothing (checked to you / first in)`,
    `Read:   ${a.read}`,
    `Play:   ${a.recommendation}`,
  ];
  return lines.join('\n');
}
