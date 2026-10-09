/**
 * Micro-benchmark for range-tracker.ts (offline; not bundled).
 *   npx tsx src/core/ranges/range-tracker-bench.ts
 *
 * Times estimateVillainRanges on a 6-max river spot with 3 live villains and a
 * HU river spot with a bet on every street. Reports the first (cold: board
 * feature cache empty) call and the mean of warm calls on a fresh board each
 * iteration (cache miss on every board, the worst realistic case) and on a
 * repeated board (cache hit, what the engine sees when it re-decides a spot).
 */
import { Action, CardId, GameState, Player, Position } from '../../types/poker';
import { idToCard } from '../cfr/card-utils';
import { estimateVillainRanges, heroRangeFor } from './range-tracker';

const P = (name: string, position: Position, isHero = false): Player => ({
  name, stack: 5000, position, isDealer: position === 'BTN', isSittingOut: false,
  seatIndex: 0, isHero, currentBet: 0, hasActed: false,
});
const a = (playerName: string, type: Action['type'], amount?: number): Action => ({ type, playerName, amount });

function sixMaxRiver(board: CardId[]): GameState {
  return {
    tableId: 'b', handNumber: 1, street: 'river', pot: 0, sidePots: [],
    heroCards: [idToCard(51), idToCard(46)], communityCards: board.map(idToCard),
    players: [P('U', 'UTG'), P('M', 'MP'), P('C', 'CO'), P('Bt', 'BTN'), P('S', 'SB'), P('Bb', 'BB', true)],
    heroIndex: 5, dealerIndex: 3, activePlayerIndex: 5, currentBet: 0, minRaise: 0, bigBlind: 20, smallBlind: 10,
    actionHistory: {
      preflop: [a('U', 'raise', 60), a('M', 'fold'), a('C', 'call', 60), a('Bt', 'call', 60), a('S', 'fold'), a('Bb', 'call', 60)],
      flop: [a('Bb', 'check'), a('U', 'bet', 120), a('C', 'call', 120), a('Bt', 'call', 120), a('Bb', 'call', 120)],
      turn: [a('Bb', 'check'), a('U', 'check'), a('C', 'bet', 300), a('Bt', 'call', 300), a('Bb', 'call', 300), a('U', 'call', 300)],
      river: [a('Bb', 'check'), a('U', 'check'), a('C', 'bet', 800), a('Bt', 'call', 800)],
    },
    isOurTurn: true, timestamp: 0,
  };
}

function randomBoard(seed: number): CardId[] {
  // small LCG; avoid hero cards 51 (As) and 46 (Qd)
  let x = seed * 2654435761 >>> 0;
  const out: CardId[] = [];
  while (out.length < 5) {
    x = (x * 1664525 + 1013904223) >>> 0;
    const c = x % 52;
    if (c === 51 || c === 46 || out.includes(c)) continue;
    out.push(c);
  }
  return out;
}

const hero: [CardId, CardId] = [51, 46];
let t = performance.now();
estimateVillainRanges(sixMaxRiver(randomBoard(1)), hero);
console.log(`cold first call (6-max river, 3 villains): ${(performance.now() - t).toFixed(2)} ms`);

const N = 200;
t = performance.now();
for (let i = 0; i < N; i++) estimateVillainRanges(sixMaxRiver(randomBoard(1000 + i)), hero);
console.log(`warm, new board each call: ${((performance.now() - t) / N).toFixed(2)} ms/call over ${N}`);

const fixed = sixMaxRiver(randomBoard(7));
estimateVillainRanges(fixed, hero);
t = performance.now();
for (let i = 0; i < N; i++) estimateVillainRanges(fixed, hero);
console.log(`warm, repeated board: ${((performance.now() - t) / N).toFixed(2)} ms/call over ${N}`);

t = performance.now();
for (let i = 0; i < N; i++) heroRangeFor(sixMaxRiver(randomBoard(5000 + i)));
console.log(`heroRangeFor, new board each call: ${((performance.now() - t) / N).toFixed(2)} ms/call over ${N}`);
