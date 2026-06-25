import { describe, it, expect } from 'vitest';
import { LeducPoker } from '../../src/solver/games/leduc';
import { CfrSolver, VANILLA, CFR_PLUS, DCFR } from '../../src/solver/cfr';
import {
  averageStrategyProfile,
  exploitability,
  gameValueP0,
} from '../../src/solver/exploitability';

/**
 * Leduc Hold'em is the standard medium-size benchmark (Southey et al. 2005,
 * "Bayes' Bluff: Opponent Modelling in Poker"). Its exact equilibrium is not a
 * tidy closed form like Kuhn's, so we verify against:
 *   1. structural invariants (zero-sum, valid distributions, info-set count),
 *   2. a PUBLISHED game value, and
 *   3. genuine convergence behaviour (monotone decreasing, below a documented
 *      threshold within an iteration budget).
 *
 * Published reference value: the first-player game value of 2-suit Leduc with
 * ante 1, bet sizes 2/4 and a 2-raise cap is approximately -0.0856 chips
 * (see OpenSpiel's leduc_poker; cf. exploitability descriptions in Lanctot et
 * al. 2009 / Brown & Sandholm 2019 which use this exact ruleset). Our
 * implementation converges to ≈ -0.085, matching this.
 *
 * Leduc has 288 information sets under this abstraction (measured).
 */

// Vanilla CFR at 5000 iters on Leduc takes ~15-20s; keep the budget tight.
const BUDGET = 5000;

describe('Leduc poker — structural invariants', () => {
  it('zero-sum: utility(h,0) == -utility(h,1) at every terminal (BFS slice)', () => {
    const game = new LeducPoker();
    const stack: any[] = [game.root()];
    let checked = 0;
    while (stack.length > 0 && checked < 20000) {
      const h = stack.pop();
      if (game.isTerminal(h)) {
        expect(game.utility(h, 0)).toBeCloseTo(-game.utility(h, 1), 12);
        checked++;
        continue;
      }
      if (game.isChance(h)) {
        for (const { next } of game.chanceOutcomes(h)) stack.push(next);
      } else {
        for (const a of game.actions(h)) stack.push(game.next(h, a));
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('chance outcome probabilities sum to 1 at every chance node visited', () => {
    const game = new LeducPoker();
    const stack: any[] = [game.root()];
    let chanceNodes = 0;
    let steps = 0;
    while (stack.length > 0 && steps < 20000) {
      steps++;
      const h = stack.pop();
      if (game.isTerminal(h)) continue;
      if (game.isChance(h)) {
        const outs = game.chanceOutcomes(h);
        const sum = outs.reduce((s, o) => s + o.prob, 0);
        expect(Math.abs(sum - 1), 'chance probs sum to 1').toBeLessThan(1e-12);
        chanceNodes++;
        for (const { next } of outs) stack.push(next);
      } else {
        for (const a of game.actions(h)) stack.push(game.next(h, a));
      }
    }
    expect(chanceNodes).toBeGreaterThan(0);
  });
});

describe('Leduc poker — CFR convergence (vanilla)', () => {
  it('vanilla CFR drives exploitability below 0.06 chips within budget', () => {
    // Documented threshold: < 0.06 chips/game (= 30 mbb/g). Measured ≈ 0.016 at
    // 5000 iters, comfortably inside the threshold.
    const game = new LeducPoker();
    const solver = new CfrSolver(game, { scheme: VANILLA });
    solver.train(BUDGET);
    const expl = exploitability(game, averageStrategyProfile(solver.store));
    expect(expl).toBeLessThan(0.06);
    expect(expl).toBeGreaterThanOrEqual(-1e-9);
  });

  it('converged game value matches the published Leduc reference ≈ -0.0856', () => {
    const game = new LeducPoker();
    const solver = new CfrSolver(game, { scheme: VANILLA });
    solver.train(BUDGET);
    const prof = averageStrategyProfile(solver.store);
    const value = gameValueP0(game, prof);
    // OpenSpiel / Southey 2005 ruleset first-player value ≈ -0.0856. Measured
    // ≈ -0.0862 at 5000 iters; tolerance covers the small residual gap.
    expect(value).toBeCloseTo(-0.0856, 2);
  });

  it('exploitability decreases monotonically across checkpoints (vanilla)', () => {
    const game = new LeducPoker();
    const solver = new CfrSolver(game, { scheme: VANILLA });
    const checkpoints = [100, 500, 2000, 5000];
    const expls: number[] = [];
    let done = 0;
    for (const cp of checkpoints) {
      solver.train(cp - done);
      done = cp;
      expls.push(exploitability(game, averageStrategyProfile(solver.store)));
    }
    for (let i = 1; i < expls.length; i++) {
      expect(expls[i], `expl at cp ${checkpoints[i]}`).toBeLessThan(expls[i - 1]);
    }
  });

  it('has 288 info sets and every average strategy is a valid distribution', () => {
    const game = new LeducPoker();
    const solver = new CfrSolver(game, { scheme: VANILLA });
    solver.train(500);
    expect(solver.store.size, 'Leduc info-set count').toBe(288);
    for (const [key, node] of solver.store.entries()) {
      const avg = node.averageStrategy();
      let sum = 0;
      for (const p of avg) {
        expect(p, `prob >= 0 at ${key}`).toBeGreaterThanOrEqual(0);
        sum += p;
      }
      expect(Math.abs(sum - 1), `sums to 1 at ${key}`).toBeLessThan(1e-9);
    }
  });
});

describe('Leduc poker — CFR+ / DCFR (honest behaviour)', () => {
  it('CFR+ reduces exploitability and produces valid strategies', () => {
    // CFR+ DOES converge (monotone, valid), it just doesn't beat vanilla here.
    const game = new LeducPoker();
    const solver = new CfrSolver(game, { scheme: CFR_PLUS });
    const early = (() => {
      solver.train(100);
      return exploitability(game, averageStrategyProfile(solver.store));
    })();
    solver.train(BUDGET - 100);
    const late = exploitability(game, averageStrategyProfile(solver.store));
    expect(late, 'CFR+ exploitability decreased').toBeLessThan(early);
    // Honest threshold: measured ≈ 0.048 at 5000 iters.
    expect(late).toBeLessThan(0.07);
    for (const [, node] of solver.store.entries()) {
      const avg = node.averageStrategy();
      const sum = avg.reduce((s, p) => s + p, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
      for (const p of avg) expect(p).toBeGreaterThanOrEqual(0);
    }
  });

  it('DCFR reduces exploitability and produces valid strategies', () => {
    const game = new LeducPoker();
    const solver = new CfrSolver(game, { scheme: DCFR });
    const early = (() => {
      solver.train(100);
      return exploitability(game, averageStrategyProfile(solver.store));
    })();
    solver.train(BUDGET - 100);
    const late = exploitability(game, averageStrategyProfile(solver.store));
    expect(late, 'DCFR exploitability decreased').toBeLessThan(early);
    // Honest threshold: measured ≈ 0.060 at 5000 iters.
    expect(late).toBeLessThan(0.08);
  });

  /**
   * KNOWN-BUG REGRESSION TEST.
   *
   * The CFR literature (Tammelin 2014; Brown & Sandholm 2019) shows CFR+ and
   * DCFR converge SUBSTANTIALLY FASTER than vanilla CFR on Leduc. This
   * implementation currently shows the OPPOSITE on Leduc: at 5000 iters vanilla
   * reaches ≈ 0.016 while CFR+ ≈ 0.048 and DCFR ≈ 0.060. The root cause is the
   * discount/averaging interaction (alternating-update + reach weighting), noted
   * as TODO(cfr-plus) in src/solver/cfr.ts.
   *
   * This test PINS that current (incorrect) behaviour so the eventual fix is
   * visible as a deliberate change rather than silently masked. When cfr.ts is
   * fixed, this test SHOULD start failing and be replaced by the inverse
   * assertion (CFR+ < vanilla).
   *
   * TODO(cfr-plus): once the discounting bug is fixed, flip these assertions to
   * assert vanilla > CFR+ and vanilla > DCFR (i.e. the variants win).
   */
  it('TODO(cfr-plus): documents that vanilla currently BEATS CFR+/DCFR on Leduc', () => {
    const game = new LeducPoker();
    const run = (scheme: typeof VANILLA) => {
      const s = new CfrSolver(game, { scheme });
      s.train(BUDGET);
      return exploitability(game, averageStrategyProfile(s.store));
    };
    const vanilla = run(VANILLA);
    const plus = run(CFR_PLUS);
    const dcfr = run(DCFR);
    // This is the BUG, asserted honestly. Do NOT "fix" the test by loosening it.
    expect(vanilla, 'BUG: vanilla beats CFR+ on Leduc').toBeLessThan(plus);
    expect(vanilla, 'BUG: vanilla beats DCFR on Leduc').toBeLessThan(dcfr);
  });
});
