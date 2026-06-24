import { describe, it, expect, vi } from 'vitest';

// The DecisionEngine loads opponent stats from IndexedDB, which doesn't exist in
// the node test environment. Stub the storage layer so decide() runs with empty
// (no-read) opponent data — postflop decisions don't depend on stats here.
vi.mock('../src/storage/db', async () => {
  const actual = await vi.importActual<typeof import('../src/storage/db')>('../src/storage/db');
  return {
    ...actual,
    getPlayerStats: async () => null,
    savePlayerStats: async () => {},
  };
});

import { DecisionEngine } from '../src/core/engine';
import { GameState, Player, Position, Street, Card } from '../src/types/poker';
import { card } from './helpers';

// ============================================================
// Live postflop decision rule (decidePostflopRanged via decide()).
// These assert the anti-blunder guarantees: never value-bet a hand that is
// behind the continuing range, fold without pot odds, value-bet the nuts, and
// do not bet a medium hand into a monotone board without the flush.
// ============================================================

function mkPlayer(name: string, position: Position, isHero = false, stack = 1000): Player {
  return {
    name, stack, position,
    isDealer: position === 'BTN',
    isSittingOut: false,
    seatIndex: position === 'BTN' ? 0 : 1,
    isHero,
    currentBet: 0,
    hasActed: false,
  };
}

interface Opts {
  heroCards: [string, string];
  community: string[];
  pot: number;
  currentBet?: number; // highest bet this street (0 = checked to hero)
  heroBet?: number;
  street?: Street;
  heroPos?: Position;
  villainPos?: Position;
}

function buildState(o: Opts): GameState {
  const hero = mkPlayer('Hero', o.heroPos ?? 'BTN', true);
  hero.currentBet = o.heroBet ?? 0;
  const villain = mkPlayer('Villain', o.villainPos ?? 'BB', false);
  villain.currentBet = o.currentBet ?? 0;
  const community: Card[] = o.community.map(card);
  return {
    tableId: 't', handNumber: 1, street: o.street ?? 'river',
    pot: o.pot, sidePots: [],
    heroCards: [card(o.heroCards[0]), card(o.heroCards[1])],
    communityCards: community,
    players: [hero, villain],
    heroIndex: 0, dealerIndex: 0, activePlayerIndex: 0,
    currentBet: o.currentBet ?? 0,
    minRaise: 20, bigBlind: 20, smallBlind: 10,
    actionHistory: { preflop: [], flop: [], turn: [], river: [] },
    isOurTurn: true, timestamp: Date.now(),
  };
}

/** Is this decision a bet/raise FOR VALUE (not a labelled bluff/semi-bluff)? */
function isValueBet(reasoning: string, action: string): boolean {
  const aggressive = action === 'bet' || action === 'raise';
  const value = /value/i.test(reasoning);
  return aggressive && value;
}

describe('live postflop decision (range-aware)', () => {
  it('value-bets the nuts (top set on a dry board, checked to hero)', async () => {
    const engine = new DecisionEngine();
    const state = buildState({
      heroCards: ['Ah', 'Ad'],
      community: ['Ac', '7d', '2s'], // top set, dry
      pot: 100, currentBet: 0, street: 'river',
    });
    const d = await engine.decide(state);
    expect(['bet', 'raise']).toContain(d.action);
    expect(d.amount).toBeGreaterThan(0);
  });

  it('does NOT bet a medium hand into a monotone board without the flush', async () => {
    const engine = new DecisionEngine();
    const state = buildState({
      heroCards: ['Ks', 'Qc'], // top two pair, NO heart
      community: ['Kh', 'Qh', '7h'], // monotone hearts
      pot: 100, currentBet: 0, street: 'flop',
    });
    const d = await engine.decide(state);
    // Must not value-bet into the flush board without a flush.
    expect(isValueBet(d.reasoning, d.action)).toBe(false);
    // Strongly expect a check here.
    expect(d.action).toBe('check');
  });

  it('never produces a value bet when equity vs range is below ~0.55', async () => {
    const engine = new DecisionEngine();
    // Run several spots that are behind their continuing ranges.
    const spots: Opts[] = [
      { heroCards: ['Ks', 'Qc'], community: ['Kh', 'Qh', '7h'], pot: 100, currentBet: 0, street: 'flop' },
      { heroCards: ['8c', '8d'], community: ['Ah', 'Kh', 'Qh'], pot: 100, currentBet: 0, street: 'flop' },
      { heroCards: ['7c', '6c'], community: ['Ah', 'Ks', 'Qd'], pot: 80, currentBet: 0, street: 'turn' },
    ];
    for (const s of spots) {
      const d = await engine.decide(buildState(s));
      expect(isValueBet(d.reasoning, d.action)).toBe(false);
    }
  });

  it('folds when facing a bet with equity below the pot odds', async () => {
    const engine = new DecisionEngine();
    // Hero has a weak hand (no pair, no draw of note) facing a big bet on a
    // scary board. Pot odds require ~33%+; hero is below that vs a value range.
    const state = buildState({
      heroCards: ['7c', '2d'],
      community: ['Ah', 'Kd', 'Qs', '9c', '3h'], // river, hero has 7-high
      pot: 100, currentBet: 50, heroBet: 0, street: 'river',
    });
    const d = await engine.decide(state);
    expect(d.action).toBe('fold');
  });

  it('calls facing a bet when equity beats pot odds (strong made hand)', async () => {
    const engine = new DecisionEngine();
    const state = buildState({
      heroCards: ['As', 'Ad'],
      community: ['Ac', 'Kd', '7s', '2c', '3h'], // top set, river
      pot: 100, currentBet: 40, heroBet: 0, street: 'river',
    });
    const d = await engine.decide(state);
    // Should not fold the nuts; calls or raises for value.
    expect(d.action).not.toBe('fold');
  });
});
