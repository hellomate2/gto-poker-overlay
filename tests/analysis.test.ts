import { describe, it, expect } from 'vitest';
import { analyzeSpot, formatAnalysis } from '../src/core/analysis';
import { GameState, Player, Position, Street } from '../src/types/poker';
import { card } from './helpers';

// ============================================================
// The poker-analysis engine: it should read a spot the way a player would —
// name the made hand + draws, compute equity vs villain's range and the pot odds,
// and give the correct call/fold/value read. These assertions pin that the
// reasoning is RIGHT (and the console output shows it explaining each spot).
// ============================================================

function mkPlayer(name: string, pos: Position, isHero = false, currentBet = 0): Player {
  return { name, stack: 1000, position: pos, isDealer: pos === 'BTN', isSittingOut: false,
    seatIndex: pos === 'BTN' ? 0 : 1, isHero, currentBet, hasActed: false };
}

function st(o: { hole: [string, string]; board: string[]; pot: number; currentBet?: number; street: Street }): GameState {
  const hero = mkPlayer('Hero', 'BTN', true, 0);
  const villain = mkPlayer('Villain', 'BB', false, o.currentBet ?? 0);
  return {
    tableId: 't', handNumber: 1, street: o.street, pot: o.pot, sidePots: [],
    heroCards: [card(o.hole[0]), card(o.hole[1])],
    communityCards: o.board.map(card),
    players: [hero, villain], heroIndex: 0, dealerIndex: 0, activePlayerIndex: 0,
    currentBet: o.currentBet ?? 0, minRaise: 20, bigBlind: 20, smallBlind: 10,
    actionHistory: { preflop: [], flop: [], turn: [], river: [] },
    isOurTurn: true, timestamp: Date.now(),
  };
}

describe('poker analysis engine', () => {
  it('reads king-high facing a river jam as a FOLD (below pot odds)', () => {
    const a = analyzeSpot(st({ hole: ['Kc', '9d'], board: ['Ah', 'Qs', 'Jd', '5c', '2h'], pot: 200, currentBet: 200, street: 'river' }));
    // eslint-disable-next-line no-console
    console.log('\n' + formatAnalysis(a));
    expect(a.madeHand).toMatch(/high/i);
    expect(a.equityVsRange).toBeLessThan(a.facing!.potOdds);
    expect(a.recommendation).toMatch(/fold/i);
  });

  it('reads the nuts facing a bet as raise-for-value', () => {
    const a = analyzeSpot(st({ hole: ['Ad', 'As'], board: ['Ah', 'Ts', '8d', '4c', '2s'], pot: 150, currentBet: 100, street: 'river' }));
    // eslint-disable-next-line no-console
    console.log('\n' + formatAnalysis(a));
    expect(a.equityVsRange).toBeGreaterThan(0.7);
    expect(a.recommendation).toMatch(/value|raise/i);
  });

  it('recognizes a flush draw and that it has the price to call a small bet', () => {
    const a = analyzeSpot(st({ hole: ['Ah', 'Th'], board: ['Kh', '7h', '2c'], pot: 100, currentBet: 25, street: 'flop' }));
    // eslint-disable-next-line no-console
    console.log('\n' + formatAnalysis(a));
    expect(a.draws.join(' ')).toMatch(/flush draw/i);
    expect(a.recommendation).toMatch(/call/i);
  });

  it('reads top pair checked-to as a value bet', () => {
    const a = analyzeSpot(st({ hole: ['Ah', 'Kd'], board: ['Ks', '7d', '2c'], pot: 100, currentBet: 0, street: 'flop' }));
    // eslint-disable-next-line no-console
    console.log('\n' + formatAnalysis(a));
    expect(a.madeHand).toMatch(/top pair/i);
    expect(a.recommendation).toMatch(/value|bet/i);
  });

  it('formatAnalysis renders a readable multi-line block', () => {
    const a = analyzeSpot(st({ hole: ['Kc', '9d'], board: ['Ah', 'Qs', 'Jd', '5c', '2h'], pot: 200, currentBet: 200, street: 'river' }));
    const out = formatAnalysis(a);
    expect(out).toMatch(/Hand:/);
    expect(out).toMatch(/Equity:/);
    expect(out).toMatch(/Play:/);
  });
});
