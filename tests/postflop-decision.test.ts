import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The ranged path uses Math.random for its low-frequency semi-bluff/bluff lines.
// Seeding it to 0.99 suppresses those random bluffs so the anti-blunder / value
// assertions are deterministic. (The distilled-net path is pure argmax and uses
// no randomness, so this only affects the multiway ranged section below.)
beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0.99); });
afterEach(() => { vi.restoreAllMocks(); });

// DecisionEngine loads opponent stats from IndexedDB, absent in node. Stub the
// storage layer so decide() runs with empty opponent data.
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
// IMPORTANT routing note (this is what the previous version of this file got
// wrong): decide() routes a HEADS-UP postflop spot (exactly one active villain)
// to the distilled NEURAL-NET path (decidePostflopNet), and a MULTIWAY spot
// (>=2 active villains) to the range-aware heuristic (decidePostflopRanged).
// Both paths must honor the same anti-blunder guarantees, so we test BOTH
// explicitly and label each correctly. The net path's reasoning is "net ...";
// the ranged path's value line literally contains the word "value", so the
// isValueBet() helper below is only meaningful on the ranged (multiway) path.
// ============================================================

function mkPlayer(name: string, position: Position, isHero = false, stack = 1000, seat = 0): Player {
  return {
    name, stack, position,
    isDealer: position === 'BTN',
    isSittingOut: false,
    seatIndex: seat,
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
  multiway?: boolean;  // add a second villain so decide() takes the ranged path
}

function buildState(o: Opts): GameState {
  const hero = mkPlayer('Hero', 'BTN', true, 1000, 0);
  hero.currentBet = o.heroBet ?? 0;
  const villain = mkPlayer('Villain', 'BB', false, 1000, 1);
  villain.currentBet = o.currentBet ?? 0;
  const players: Player[] = [hero, villain];
  if (o.multiway) {
    const v2 = mkPlayer('Villain2', 'CO', false, 1000, 2);
    v2.currentBet = o.currentBet ?? 0;
    players.push(v2);
  }
  const community: Card[] = o.community.map(card);
  return {
    tableId: 't', handNumber: 1, street: o.street ?? 'river',
    pot: o.pot, sidePots: [],
    heroCards: [card(o.heroCards[0]), card(o.heroCards[1])],
    communityCards: community,
    players,
    heroIndex: 0, dealerIndex: 0, activePlayerIndex: 0,
    currentBet: o.currentBet ?? 0,
    minRaise: 20, bigBlind: 20, smallBlind: 10,
    actionHistory: { preflop: [], flop: [], turn: [], river: [] },
    isOurTurn: true, timestamp: Date.now(),
  };
}

/** Is this decision an aggressive bet/raise labelled FOR VALUE (ranged path)? */
function isValueBet(reasoning: string, action: string): boolean {
  const aggressive = action === 'bet' || action === 'raise';
  return aggressive && /value/i.test(reasoning);
}

// ============================================================
// A) Heads-up live decision — the distilled NET path (decidePostflopNet).
// Assertions are on the ACTION (net reasoning never says "value"), so they are
// not vacuous. These are the guarantees that matter when the bot actually plays
// heads-up.
// ============================================================
describe('live heads-up postflop decision (distilled net path)', () => {
  it('routes heads-up postflop to the net path (reasoning says "net ...")', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['Ah', 'Ad'], community: ['Ac', '7d', '2s'], pot: 100, currentBet: 0, street: 'flop',
    }));
    // Guards the routing assumption this whole section depends on.
    expect(d.reasoning.toLowerCase()).toContain('net');
  });

  it('bets/raises the nuts (top set on a dry board, checked to hero)', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['Ah', 'Ad'], community: ['Ac', '7d', '2s'], pot: 100, currentBet: 0, street: 'flop',
    }));
    expect(['bet', 'raise']).toContain(d.action);
    expect(d.amount).toBeGreaterThan(0);
  });

  it('does NOT bet top two pair into a monotone board without the flush (anti-blunder guard)', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['Ks', 'Qc'], community: ['Kh', 'Qh', '7h'], pot: 100, currentBet: 0, street: 'flop',
    }));
    // The dangerous-flush-board guard must fire on the net path too: a non-flush
    // hand is crushed by villain's flush-heavy range, so never bet — check.
    expect(d.action).toBe('check');
  });

  it('folds 7-high facing a big bet on a scary river (below pot odds)', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['7c', '2d'], community: ['Ah', 'Kd', 'Qs', '9c', '3h'],
      pot: 100, currentBet: 50, heroBet: 0, street: 'river',
    }));
    expect(d.action).toBe('fold');
  });

  it('never folds the nuts facing a bet (top set on the river)', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['As', 'Ad'], community: ['Ac', 'Kd', '7s', '2c', '3h'],
      pot: 100, currentBet: 40, heroBet: 0, street: 'river',
    }));
    expect(d.action).not.toBe('fold');
    expect(['call', 'raise']).toContain(d.action);
  });
});

// ============================================================
// B) Range-aware path (decidePostflopRanged) — exercised by making the pot
// MULTIWAY (two villains), which is how decide() reaches the heuristic. Here the
// engine measures hero equity vs a concrete continuing range and labels true
// value bets "value bet ...", so isValueBet() is meaningful. This is the path
// the old file CLAIMED to test but never actually reached.
// ============================================================
describe('range-aware postflop decision (decidePostflopRanged, multiway)', () => {
  it('actually takes the ranged path (reasoning is not the "net ..." path)', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['Ah', 'Ad'], community: ['Ac', '7d', '2s'], pot: 100, currentBet: 0,
      street: 'flop', multiway: true,
    }));
    expect(d.reasoning.toLowerCase()).not.toContain('net ');
  });

  it('value-bets the nuts vs the continuing range (top set, dry board)', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['Ah', 'Ad'], community: ['Ac', '7d', '2s'], pot: 100, currentBet: 0,
      street: 'flop', multiway: true,
    }));
    expect(isValueBet(d.reasoning, d.action)).toBe(true);
  });

  it('never VALUE-bets a hand crushed by the range (dominated flush boards)', async () => {
    // These spots are behind their continuing ranges; the ranged path CAN label a
    // bet "value" (so the assertion is non-vacuous) and must not here.
    const spots: Opts[] = [
      { heroCards: ['Ks', 'Qc'], community: ['Kh', 'Qh', '7h'], pot: 100, currentBet: 0, street: 'flop', multiway: true },
      { heroCards: ['8c', '8d'], community: ['Ah', 'Kh', 'Qh'], pot: 100, currentBet: 0, street: 'flop', multiway: true },
      { heroCards: ['7c', '6c'], community: ['Ah', 'Ks', 'Qd'], pot: 80, currentBet: 0, street: 'turn', multiway: true },
    ];
    for (const s of spots) {
      const d = await new DecisionEngine().decide(buildState(s));
      expect(isValueBet(d.reasoning, d.action), `${s.heroCards} on ${s.community}`).toBe(false);
    }
  });

  it('checks (does not value-bet) top two pair on a monotone board without the flush', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['Ks', 'Qc'], community: ['Kh', 'Qh', '7h'], pot: 100, currentBet: 0,
      street: 'flop', multiway: true,
    }));
    expect(isValueBet(d.reasoning, d.action)).toBe(false);
    expect(d.action).toBe('check');
  });

  it('folds facing a bet with equity below the pot odds (7-high river)', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['7c', '2d'], community: ['Ah', 'Kd', 'Qs', '9c', '3h'],
      pot: 100, currentBet: 50, heroBet: 0, street: 'river', multiway: true,
    }));
    expect(d.action).toBe('fold');
  });

  it('does not fold the nuts facing a bet (top set river, calls or raises for value)', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['As', 'Ad'], community: ['Ac', 'Kd', '7s', '2c', '3h'],
      pot: 100, currentBet: 40, heroBet: 0, street: 'river', multiway: true,
    }));
    expect(d.action).not.toBe('fold');
  });
});
