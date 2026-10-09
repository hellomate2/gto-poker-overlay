// ============================================================
// Pressure / barrel metric definitions (sim/stats.ts) on hand-built action
// logs, plus the bb/100 confidence-interval math.
// ============================================================

import { describe, it, expect } from 'vitest';
import { accumulatePressure, emptyPressure, MinimalAction, Running, bb100WithCI } from '../sim/stats';
import { Street } from '../src/types/poker';

/** Build a log from "seat:street:type" tokens in order. */
function L(...tokens: string[]): MinimalAction[] {
  const streets: Record<string, Street> = { p: 'preflop', f: 'flop', t: 'turn', r: 'river' };
  return tokens.map((t, order) => {
    const [seat, st, type] = t.split(':');
    return { seat: Number(seat), street: streets[st], type, order };
  });
}

describe('accumulatePressure', () => {
  it('fold-to-raise: hero bets the flop, villain raises, hero folds', () => {
    const st = emptyPressure();
    accumulatePressure(st, L('0:p:raise', '1:p:call', '1:f:check', '0:f:bet', '1:f:raise', '0:f:fold'), 0);
    expect([st.foldToRaise, st.foldToRaiseOpp]).toEqual([1, 1]);
    // villain's perspective: it faced a flop bet (the first flop wager) and raised
    const v = emptyPressure();
    accumulatePressure(v, L('0:p:raise', '1:p:call', '1:f:check', '0:f:bet', '1:f:raise', '0:f:fold'), 1);
    expect([v.foldToFlopBet, v.foldToFlopBetOpp]).toEqual([0, 1]);
    expect(v.foldToRaiseOpp).toBe(0);
  });

  it('a call against a check-raise counts as an opportunity without a fold', () => {
    const st = emptyPressure();
    accumulatePressure(st, L('1:f:check', '0:f:bet', '1:f:raise', '0:f:call', '1:t:check', '0:t:check'), 0);
    expect([st.foldToRaise, st.foldToRaiseOpp]).toEqual([0, 1]);
  });

  it('fold-to-turn-barrel: villain bets flop, hero calls, villain bets turn, hero folds', () => {
    const st = emptyPressure();
    accumulatePressure(st, L('0:f:check', '1:f:bet', '0:f:call', '0:t:check', '1:t:bet', '0:t:fold'), 0);
    expect([st.foldToTurnBarrel, st.foldToTurnBarrelOpp]).toEqual([1, 1]);
    expect([st.foldToFlopBet, st.foldToFlopBetOpp]).toEqual([0, 1]);
  });

  it('no turn-barrel opportunity when hero raised the flop or a different player bets the turn', () => {
    const a = emptyPressure();
    accumulatePressure(a, L('0:f:check', '1:f:bet', '0:f:raise', '1:f:call', '0:t:check', '1:t:bet', '0:t:fold'), 0);
    expect(a.foldToTurnBarrelOpp).toBe(0);
    const b = emptyPressure();
    accumulatePressure(b, L('0:f:check', '1:f:bet', '2:f:call', '0:f:call', '0:t:check', '2:t:bet', '1:t:fold', '0:t:fold'), 0);
    expect(b.foldToTurnBarrelOpp).toBe(0);
  });

  it('fold-to-river-bet in a multiway pot: response is hero\'s next action after the bet', () => {
    const st = emptyPressure();
    accumulatePressure(st, L('0:r:check', '1:r:check', '2:r:bet', '0:r:fold', '1:r:call'), 0);
    expect([st.foldToRiverBet, st.foldToRiverBetOpp]).toEqual([1, 1]);
  });

  it('turn / river barrel: hero made the last wager and bets again when first to wager', () => {
    const st = emptyPressure();
    accumulatePressure(st, L('1:f:check', '0:f:bet', '1:f:call', '1:t:check', '0:t:bet', '1:t:call', '1:r:check', '0:r:check'), 0);
    expect([st.turnBarrel, st.turnBarrelOpp]).toEqual([1, 1]);
    expect([st.riverBarrel, st.riverBarrelOpp]).toEqual([0, 1]);
  });

  it('no barrel opportunity when the villain leads into the hero first', () => {
    const st = emptyPressure();
    accumulatePressure(st, L('1:f:check', '0:f:bet', '1:f:call', '1:t:bet', '0:t:call'), 0);
    expect(st.turnBarrelOpp).toBe(0);
  });
});

describe('Running / bb100WithCI', () => {
  it('matches the textbook mean and standard error', () => {
    const r = new Running();
    for (const x of [1, 2, 3, 4, 5]) r.push(x);
    expect(r.mean).toBeCloseTo(3, 12);
    expect(r.variance()).toBeCloseTo(2.5, 12);          // sample variance
    expect(r.se()).toBeCloseTo(Math.sqrt(2.5 / 5), 12);
    // duplicate pairs: each sample covers 2 hands
    const s = bb100WithCI(r, 2);
    expect(s.bb100).toBeCloseTo(150, 9);
    expect(s.ci95).toBeCloseTo(1.96 * 100 * Math.sqrt(0.5) / 2, 9);
  });
});
