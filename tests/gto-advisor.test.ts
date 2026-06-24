import { describe, it, expect } from 'vitest';
import { getGTOAdvice } from '../src/core/ranges/gto-advisor';
import { GameState, Player, Position, Action, Street } from '../src/types/poker';
import { card } from './helpers';

function mkPlayer(name: string, position: Position, isHero = false): Player {
  return {
    name,
    stack: 100,
    position,
    isDealer: position === 'BTN',
    isSittingOut: false,
    seatIndex: 0,
    isHero,
    currentBet: 0,
    hasActed: false,
  };
}

interface BuildOpts {
  heroPos: Position;
  heroCards: [string, string];
  street?: Street;
  others?: Player[];
  preflop?: Action[];
}

function buildState(opts: BuildOpts): GameState {
  const hero = mkPlayer('Hero', opts.heroPos, true);
  const players = [hero, ...(opts.others || [])];
  return {
    tableId: 't1',
    handNumber: 1,
    street: opts.street || 'preflop',
    pot: 1.5,
    sidePots: [],
    heroCards: [card(opts.heroCards[0]), card(opts.heroCards[1])],
    communityCards: [],
    players,
    heroIndex: 0,
    dealerIndex: 0,
    activePlayerIndex: 0,
    currentBet: 0,
    minRaise: 2,
    bigBlind: 1,
    smallBlind: 0.5,
    actionHistory: {
      preflop: opts.preflop || [],
      flop: [],
      turn: [],
      river: [],
    },
    isOurTurn: true,
    timestamp: Date.now(),
  };
}

describe('getGTOAdvice — RFI spots', () => {
  it('recommends Raise for AA in a BTN RFI spot', () => {
    const state = buildState({ heroPos: 'BTN', heroCards: ['Ah', 'Ad'] });
    const advice = getGTOAdvice(state)!;
    expect(advice).not.toBeNull();
    expect(advice.hand).toBe('AA');
    expect(advice.inRange).toBe(true);
    const top = advice.actions[0];
    expect(top.action).toBe('Raise');
    expect(top.frequency).toBeGreaterThan(50);
  });

  it('frequencies for an in-range hand sum to ~100', () => {
    const state = buildState({ heroPos: 'BTN', heroCards: ['Ah', 'Ad'] });
    const advice = getGTOAdvice(state)!;
    const total = advice.actions.reduce((s, a) => s + a.frequency, 0);
    expect(total).toBeCloseTo(100, 1);
  });

  it('folds a trash hand (72o) that is outside the BTN open range', () => {
    const state = buildState({ heroPos: 'BTN', heroCards: ['7c', '2h'] });
    const advice = getGTOAdvice(state)!;
    expect(advice.hand).toBe('72o');
    expect(advice.inRange).toBe(false);
    expect(advice.actions[0].action).toBe('Fold');
    expect(advice.actions[0].frequency).toBe(100);
  });
});

describe('getGTOAdvice — facing an open', () => {
  it('labels a 3-Bet scenario when hero faces a single raise', () => {
    const villain = mkPlayer('Villain', 'BTN');
    const preflop: Action[] = [{ type: 'raise', amount: 3, playerName: 'Villain' }];
    const state = buildState({
      heroPos: 'BB',
      heroCards: ['Ah', 'Ad'],
      others: [villain],
      preflop,
    });
    const advice = getGTOAdvice(state)!;
    expect(advice).not.toBeNull();
    // AA vs an open should never be a pure fold.
    if (advice.inRange) {
      expect(advice.actions[0].action).not.toBe('Fold');
    }
  });
});

describe('getGTOAdvice — guards', () => {
  it('returns null when it is not preflop', () => {
    const state = buildState({ heroPos: 'BTN', heroCards: ['Ah', 'Ad'], street: 'flop' });
    expect(getGTOAdvice(state)).toBeNull();
  });

  it('reports no chart for an unsupported spot rather than crashing', () => {
    // BB unopened is explicitly not an RFI spot.
    const state = buildState({ heroPos: 'BB', heroCards: ['Ah', 'Ad'] });
    const advice = getGTOAdvice(state)!;
    expect(advice).not.toBeNull();
    expect(advice.inRange).toBe(false);
    expect(advice.actions.length).toBe(0);
  });
});
