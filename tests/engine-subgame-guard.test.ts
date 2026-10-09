import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DecisionEngine } from '../src/core/engine';
import { setEngineFlags, resetEngineFlags } from '../src/core/engine-flags';
import { Action, GameState, Player, Position, Street } from '../src/types/poker';
import { card } from './helpers';

// The SUBGAME_SOLVER path must only run when the action log explains the spot.
// Without the log, the range tracker cannot narrow villain's range, and a solve
// against the wide unnarrowed range bluff-raised 72o on the river 97% of the time.

// DecisionEngine loads opponent stats from IndexedDB, absent in node.
vi.mock('../src/storage/db', async () => {
  const actual = await vi.importActual<typeof import('../src/storage/db')>('../src/storage/db');
  return { ...actual, getPlayerStats: async () => null, savePlayerStats: async () => {} };
});

function mk(name: string, position: Position, isHero: boolean, seat: number, currentBet: number): Player {
  return {
    name, stack: 1000, position, isDealer: position === 'BTN', isSittingOut: false,
    seatIndex: seat, isHero, currentBet, hasActed: false,
  };
}

function riverState(history: Record<Street, Action[]>): GameState {
  return {
    tableId: 't', handNumber: 1, street: 'river', pot: 100, sidePots: [],
    heroCards: [card('7c'), card('2d')],
    communityCards: ['Ah', 'Kd', 'Qs', '9c', '3h'].map(card),
    players: [mk('Hero', 'BTN', true, 0, 0), mk('Villain', 'BB', false, 1, 50)],
    heroIndex: 0, dealerIndex: 0, activePlayerIndex: 0,
    currentBet: 50, minRaise: 20, bigBlind: 20, smallBlind: 10,
    actionHistory: history, isOurTurn: true, timestamp: 0,
  };
}

describe('subgame solver log guard', () => {
  // Math.random 0.99 samples the raise in the unguarded solve's 97% raise mix.
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    setEngineFlags({ SUBGAME_SOLVER: true, RANGE_TRACKER: true, FIX_LIVE_VILLAINS: true });
  });
  afterEach(() => { vi.restoreAllMocks(); resetEngineFlags(); });

  it('falls back to the default path when the log does not show the bet hero faces', async () => {
    const d = await new DecisionEngine().decide(riverState({ preflop: [], flop: [], turn: [], river: [] }));
    expect(d.reasoning).not.toContain('[subgame]');
    expect(d.action).toBe('fold');
  });

  it('solves when the log is complete, and folds 7-high to a river bet', async () => {
    const d = await new DecisionEngine().decide(riverState({
      preflop: [
        { type: 'raise', amount: 60, playerName: 'Hero' },
        { type: 'call', amount: 60, playerName: 'Villain' },
      ],
      flop: [{ type: 'check', playerName: 'Villain' }, { type: 'check', playerName: 'Hero' }],
      turn: [{ type: 'check', playerName: 'Villain' }, { type: 'check', playerName: 'Hero' }],
      river: [{ type: 'bet', amount: 50, playerName: 'villain' }],
    }));
    expect(d.reasoning).toContain('[subgame]');
    expect(d.action).toBe('fold');
  });
});
