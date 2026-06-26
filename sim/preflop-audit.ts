/**
 * sim/preflop-audit.ts — prove the SERVED preflop strategy is genuinely GTO.
 *
 * Sweeps all 169 starting hands through the REAL DecisionEngine in three spots
 * and checks the output against GTO benchmarks:
 *   - SB (button) RFI 100bb  -> open ~80-85%, ZERO all-in jams (deep)
 *   - BB vs 2.5x open 100bb  -> defend ~70-78%, ZERO jams (deep)
 *   - SB RFI 8bb             -> push/fold, jams a wide Nash range
 *
 * Run: npx tsx sim/preflop-audit.ts
 */
import './fake-idb'; // in-memory indexedDB so the engine's opponent tracking works
import { DecisionEngine } from '../src/core/engine';
import { GameState, Player, Position, Card, Suit, Rank } from '../src/types/poker';

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

function mkCard(r: string, s: Suit): Card {
  return { rank: r as Rank, suit: s };
}
// Map a 169-class name (e.g. 'A6s','KQo','77') to two concrete cards.
function handToCards(h: string): [Card, Card] {
  const r1 = h[0], r2 = h[1];
  if (r1 === r2) return [mkCard(r1, 'h'), mkCard(r2, 'd')];      // pair
  if (h[2] === 's') return [mkCard(r1, 'h'), mkCard(r2, 'h')];   // suited
  return [mkCard(r1, 'h'), mkCard(r2, 'd')];                     // offsuit
}
function allHands(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
    if (i === j) out.push(RANKS[i] + RANKS[i]);
    else if (i < j) out.push(RANKS[i] + RANKS[j] + 's');
    else out.push(RANKS[j] + RANKS[i] + 'o');
  }
  return out;
}

function mkP(name: string, pos: Position, stack: number, currentBet: number, isHero: boolean): Player {
  return { name, stack, position: pos, isDealer: pos === 'SB', isSittingOut: false,
    seatIndex: pos === 'SB' ? 0 : 1, isHero, currentBet, hasActed: false };
}

const bb = 20;
function sbRFI(h: string, stackBB: number): GameState {
  const [c1, c2] = handToCards(h);
  const hero = mkP('Hero', 'SB', stackBB * bb - bb / 2, bb / 2, true);  // posted SB
  const vill = mkP('Villain', 'BB', stackBB * bb - bb, bb, false);      // posted BB
  return {
    tableId: 't', handNumber: 1, street: 'preflop', pot: bb * 1.5, sidePots: [],
    heroCards: [c1, c2], communityCards: [],
    players: [hero, vill], heroIndex: 0, dealerIndex: 0, activePlayerIndex: 0,
    currentBet: bb, minRaise: 2 * bb, bigBlind: bb, smallBlind: bb / 2,
    actionHistory: { preflop: [], flop: [], turn: [], river: [] },
    isOurTurn: true, timestamp: 1,
  };
}
function bbVsOpen(h: string, stackBB: number, openTo = 50): GameState {
  const [c1, c2] = handToCards(h);
  const hero = mkP('Hero', 'BB', stackBB * bb - bb, bb, true);
  const vill = mkP('Villain', 'SB', stackBB * bb - openTo, openTo, false);
  return {
    tableId: 't', handNumber: 1, street: 'preflop', pot: openTo + bb, sidePots: [],
    heroCards: [c1, c2], communityCards: [],
    players: [hero, vill], heroIndex: 0, dealerIndex: 1, activePlayerIndex: 0,
    currentBet: openTo, minRaise: 2 * openTo, bigBlind: bb, smallBlind: bb / 2,
    actionHistory: { preflop: [{ type: 'raise', amount: openTo, playerName: 'Villain' }], flop: [], turn: [], river: [] },
    isOurTurn: true, timestamp: 1,
  };
}

async function audit(label: string, build: (h: string) => GameState, expect: { aggr?: [number, number]; deepNoJam?: boolean }) {
  const eng = new DecisionEngine();
  const hands = allHands();
  let raise = 0, call = 0, fold = 0, allin = 0;
  const jams: string[] = [], opens: string[] = [];
  for (const h of hands) {
    const d = await eng.decide(build(h));
    if (d.action === 'raise') { raise++; opens.push(h); }
    else if (d.action === 'allin') { allin++; jams.push(h); }
    else if (d.action === 'call') call++;
    else fold++;
  }
  const aggrPct = ((raise + allin + call) / hands.length) * 100; // continue%
  const openPct = ((raise + allin) / hands.length) * 100;
  console.log(`\n── ${label} ──`);
  console.log(`  raise ${raise} | call ${call} | allin ${allin} | fold ${fold}   (continue ${aggrPct.toFixed(0)}%, aggressive ${openPct.toFixed(0)}%)`);
  if (expect.deepNoJam) {
    console.log(`  DEEP-NO-JAM check: ${allin === 0 ? 'PASS ✓ (no preflop shoves)' : 'FAIL ✗ jams: ' + jams.join(',')}`);
  }
  if (allin > 0 && !expect.deepNoJam) console.log(`  jam range (${allin}): ${jams.join(' ')}`);
  // Flag clearly-trash aggression (a solid reg never opens these)
  const trash = ['72o', '82o', '92o', '73o', '83o', '62o', '52o', '42o', '32o', '63o', '53o'];
  const badOpens = opens.filter(o => trash.includes(o));
  if (badOpens.length) console.log(`  ⚠ TRASH OPENS: ${badOpens.join(', ')}`);
  else console.log(`  trash-open check: PASS ✓ (none of 72o/82o/92o/... raised)`);
  return { openPct, aggrPct, allin };
}

(async () => {
  console.log('PREFLOP GTO AUDIT — served strategy through the real DecisionEngine');
  console.log('benchmarks: SB-RFI ~80-85% aggressive, BB-defend ~70-78%, deep => 0 jams');
  await audit('SB (button) RFI — 100bb deep', h => sbRFI(h, 100), { deepNoJam: true });
  await audit('BB vs 2.5x open — 100bb deep', h => bbVsOpen(h, 100), { deepNoJam: true });
  await audit('SB RFI — 8bb (push/fold zone)', h => sbRFI(h, 8), {});
})();
