import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// Net path, facing a bet: the raise/call split after the anti-punt floor.
// predictPostflop is forced to answer 'call' so the test pins the engine's own
// rule: a continuing hand with equity vs villain's betting range at or above
// NET_RAISE_MIN_EQ (0.60) is raised for value, unless no raise is offered or the
// board is a flush board hero does not have a flush on.
// ============================================================

vi.mock('../src/core/ml/policy', async () => {
  const actual = await vi.importActual<typeof import('../src/core/ml/policy')>('../src/core/ml/policy');
  return {
    ...actual,
    predictPostflop: () => ({
      action: 'call' as const,
      probs: { fold: 0.1, check: 0, call: 0.8, bet: 0, raise: 0.1 },
    }),
  };
});

vi.mock('../src/storage/db', async () => {
  const actual = await vi.importActual<typeof import('../src/storage/db')>('../src/storage/db');
  return { ...actual, getPlayerStats: async () => null, savePlayerStats: async () => {} };
});

import { DecisionEngine } from '../src/core/engine';
import { GameState, Player } from '../src/types/poker';
import { card } from './helpers';

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0.99);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

function facingFlopBet(hole: [string, string], board: string[], heroStack = 950): GameState {
  const mk = (name: string, isHero: boolean, stack: number, bet: number, seat: number): Player => ({
    name, stack, position: isHero ? 'BTN' : 'BB', isDealer: isHero, isSittingOut: false,
    seatIndex: seat, isHero, currentBet: bet, hasActed: false,
  });
  return {
    tableId: 't', handNumber: 1, street: 'flop', pot: 160, sidePots: [],
    heroCards: [card(hole[0]), card(hole[1])],
    communityCards: board.map(card),
    players: [mk('Hero', true, heroStack, 0, 0), mk('Villain', false, 890, 60, 1)],
    heroIndex: 0, dealerIndex: 0, activePlayerIndex: 0,
    currentBet: 60, minRaise: 20, bigBlind: 20, smallBlind: 10,
    actionHistory: {
      preflop: [{ type: 'raise', amount: 50, playerName: 'Hero' }, { type: 'call', amount: 50, playerName: 'Villain' }],
      flop: [{ type: 'bet', amount: 60, playerName: 'Villain' }], turn: [], river: [],
    },
    isOurTurn: true, timestamp: 1,
  };
}

describe('net path facing a bet: value raise over a net call', () => {
  it('raises top set when the net says call', async () => {
    const d = await new DecisionEngine().decide(facingFlopBet(['Kh', 'Kd'], ['Kc', '7d', '2s']));
    expect(d.action).toBe('raise');
    expect(d.reasoning).toContain('value raise');
    expect(d.mixedStrategy.call).toBe(0);
    expect(d.mixedStrategy.bets.length).toBe(1);
  });

  it('calls when the raise is not offered (hero cannot cover more than the call)', async () => {
    const d = await new DecisionEngine().decide(facingFlopBet(['Kh', 'Kd'], ['Kc', '7d', '2s'], 50));
    expect(d.action).not.toBe('raise');
  });

  it('does not raise on a monotone board without a flush', async () => {
    const d = await new DecisionEngine().decide(facingFlopBet(['Kh', 'Kd'], ['Kc', '7c', '2c']));
    expect(d.action).not.toBe('raise');
  });
});
