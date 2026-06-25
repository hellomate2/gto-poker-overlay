import { describe, it, expect } from 'vitest';
import { solvePostflop, RangeHand } from '../../src/core/solver/postflop-cfr';
import { cardToId } from '../../src/core/cfr/card-utils';
import { Card, CardId, Rank, Suit } from '../../src/types/poker';

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function card(s: string): CardId {
  return cardToId({ rank: s[0] as Rank, suit: s[1] as Suit } as Card);
}

function combo(a: string, b: string): [CardId, CardId] {
  return [card(a), card(b)];
}

/** Total probability mass of all bet/raise actions. */
function betMass(strat: { bets: { probability: number }[] }): number {
  return strat.bets.reduce((s, b) => s + b.probability, 0);
}

/** A small capped villain range of medium one-pair / weak holdings — never the
 *  nuts. Used to test that the nuts gets bet/raised aggressively. */
function cappedVillainRange(board: CardId[]): RangeHand[] {
  // Medium pairs and weak top-pair-ish hands, no sets/straights/flushes here.
  const hands: [string, string][] = [
    ['Td', 'Tc'], ['9d', '9c'], ['8d', '8c'], ['7d', '7c'],
    ['Ah', '5h'], ['Kc', 'Qd'], ['Jh', 'Tc'], ['6s', '6h'],
  ];
  const dead = new Set(board);
  return hands
    .map(([a, b]) => ({ cards: combo(a, b) as [CardId, CardId], weight: 1 }))
    .filter(h => !dead.has(h.cards[0]) && !dead.has(h.cards[1]));
}

describe('depth-limited postflop CFR solver', () => {
  it('returns a valid StrategyDistribution (probabilities sum to ~1, all >= 0)', () => {
    const board = [card('As'), card('Kd'), card('7c')];
    const res = solvePostflop({
      board,
      heroCards: combo('Ah', 'Qh'),
      pot: 100,
      effectiveStack: 400,
      seed: 7,
      maxIterations: 150,
      timeBudgetMs: 200,
    });
    const s = res.strategy;
    let total = s.fold + s.check + s.call;
    for (const b of s.bets) {
      expect(b.probability).toBeGreaterThanOrEqual(-1e-9);
      total += b.probability;
    }
    expect(s.fold).toBeGreaterThanOrEqual(-1e-9);
    expect(s.check).toBeGreaterThanOrEqual(-1e-9);
    expect(s.call).toBeGreaterThanOrEqual(-1e-9);
    expect(Math.abs(total - 1)).toBeLessThan(1e-6);
  });

  it('bets/raises the nuts at high frequency vs a capped range', () => {
    // Board: As Ks 7c. Hero has AsAh-ish? Use a set of 7s on a dry-ish board so
    // hero crushes the capped villain range.
    const board = [card('As'), card('Kd'), card('7c')];
    const heroNuts = combo('7s', '7h'); // bottom set, crushes capped villain
    const res = solvePostflop({
      board,
      heroCards: heroNuts,
      pot: 100,
      effectiveStack: 400,
      villainRange: cappedVillainRange(board),
      heroRange: [{ cards: heroNuts, weight: 1 }],
      seed: 3,
      maxIterations: 300,
      timeBudgetMs: 400,
    });
    // With a near-nut hand vs a capped range, equilibrium puts heavy mass on
    // betting (value). Allow check-raise lines to count toward aggression too.
    expect(betMass(res.strategy)).toBeGreaterThan(0.5);
  });

  it('does not over-bluff pure air on a dry board (checks back at high frequency)', () => {
    // Dry board, hero holds total air (no pair, no draw). The OLD version of this
    // test claimed the solver "mixes" bluffs and checks, but its loose bounds
    // (betMass<0.95, checkOrFold>0.05) were satisfied by a 100% check — vacuous.
    // In this depth-limited solver, all-in is gated at SPR>2.5 and the leaf models
    // no future-street fold equity, so air finds no profitable bluff size and
    // PURE-CHECKS (~0.4% bet across seeds). The honest, non-vacuous guarantee is
    // therefore "does not over-bluff": air must not be firing a high-frequency
    // bluff. (See suspected source note: a true balanced bluff range would require
    // un-gating all-in / modelling future streets.)
    const board = [card('As'), card('Kd'), card('7c')];
    const air = combo('3h', '2d');
    const res = solvePostflop({
      board,
      heroCards: air,
      pot: 100,
      effectiveStack: 400,
      seed: 11,
      maxIterations: 300,
      timeBudgetMs: 400,
    });
    const bm = betMass(res.strategy);
    const checkOrFold = res.strategy.check + res.strategy.fold + res.strategy.call;
    // A regression that made air bluff at high frequency (or always) trips this.
    expect(bm).toBeLessThan(0.2);
    expect(checkOrFold).toBeGreaterThan(0.8);
  });

  it('stronger hands bet/raise more than weaker hands on the same board (monotonicity)', () => {
    const board = [card('As'), card('Kd'), card('7c')];
    const common = {
      board,
      pot: 100,
      effectiveStack: 400,
      villainRange: cappedVillainRange(board),
      seed: 5,
      maxIterations: 300,
      timeBudgetMs: 400,
    };
    const strong = solvePostflop({ ...common, heroCards: combo('7s', '7h'), heroRange: [{ cards: combo('7s', '7h'), weight: 1 }] });
    const weak = solvePostflop({ ...common, heroCards: combo('4h', '3d'), heroRange: [{ cards: combo('4h', '3d'), weight: 1 }] });
    expect(betMass(strong.strategy)).toBeGreaterThan(betMass(weak.strategy));
  });

  it('respects the iteration budget', () => {
    const board = [card('As'), card('Kd'), card('7c')];
    const res = solvePostflop({
      board,
      heroCards: combo('Ah', 'Qh'),
      pot: 100,
      effectiveStack: 400,
      seed: 1,
      maxIterations: 50,
      timeBudgetMs: 10_000, // large so the iteration cap is the binding limit
    });
    expect(res.iterations).toBeLessThanOrEqual(50);
    expect(res.iterations).toBeGreaterThan(0);
  });

  it('respects the wall-clock time budget', () => {
    const board = [card('As'), card('Kd'), card('7c')];
    const t0 = Date.now();
    const res = solvePostflop({
      board,
      heroCards: combo('Ah', 'Qh'),
      pot: 100,
      effectiveStack: 1000,
      seed: 1,
      maxIterations: 1_000_000, // effectively unbounded; time must stop it
      timeBudgetMs: 120,
    });
    const elapsed = Date.now() - t0;
    // Allow generous slack for the amortized time check (checkEvery=16) and one
    // final iteration, but it must not run anywhere near the iteration cap.
    expect(elapsed).toBeLessThan(1500);
    expect(res.iterations).toBeLessThan(1_000_000);
  });

  it('facing a bet, a strong hand calls or raises rather than folding', () => {
    const board = [card('As'), card('Kd'), card('7c')];
    const heroNuts = combo('7s', '7h');
    const res = solvePostflop({
      board,
      heroCards: heroNuts,
      pot: 100,
      effectiveStack: 400,
      toCall: 50, // facing a half-pot bet
      villainRange: cappedVillainRange(board),
      heroRange: [{ cards: heroNuts, weight: 1 }],
      seed: 9,
      maxIterations: 300,
      timeBudgetMs: 400,
    });
    // Strong hand should almost never fold to a half-pot bet.
    expect(res.strategy.fold).toBeLessThan(0.2);
    expect(res.strategy.call + betMass(res.strategy)).toBeGreaterThan(0.8);
  });

  it('is deterministic given the same seed', () => {
    const board = [card('As'), card('Kd'), card('7c')];
    const args = {
      board,
      heroCards: combo('Ah', 'Qh') as [CardId, CardId],
      pot: 100,
      effectiveStack: 400,
      seed: 42,
      maxIterations: 120,
      timeBudgetMs: 10_000,
    };
    const a = solvePostflop(args);
    const b = solvePostflop(args);
    expect(a.strategy.fold).toBeCloseTo(b.strategy.fold, 10);
    expect(a.strategy.check).toBeCloseTo(b.strategy.check, 10);
    expect(betMass(a.strategy)).toBeCloseTo(betMass(b.strategy), 10);
  });
});
