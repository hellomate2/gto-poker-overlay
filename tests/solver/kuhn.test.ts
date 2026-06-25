import { describe, it, expect } from 'vitest';
import { KuhnPoker, PASS, BET } from '../../src/solver/games/kuhn';
import {
  CfrSolver,
  VANILLA,
  CFR_PLUS,
  LINEAR_CFR,
  DCFR,
  DiscountScheme,
} from '../../src/solver/cfr';
import {
  averageStrategyProfile,
  exploitability,
  gameValueP0,
} from '../../src/solver/exploitability';

/**
 * Kuhn poker is the gold standard for verifying a CFR implementation because its
 * Nash equilibria are known IN CLOSED FORM, not just numerically. Asserting only
 * that the game value or exploitability is right is weak: many wrong strategies
 * still hit value -1/18 against an optimal opponent. We instead pin the converged
 * AVERAGE STRATEGY to the analytic equilibrium family.
 *
 * Analytic equilibrium (Kuhn 1950; see also Hoehn et al. 2005 "Effective
 * short-term opponent exploitation in simplified poker", and the widely-cited
 * summary at https://en.wikipedia.org/wiki/Kuhn_poker):
 *
 * Let the first player be P0 (acts first), second player P1. There is a
 * ONE-PARAMETER family of equilibria indexed by alpha in [0, 1/3]:
 *
 *   PLAYER 0 (P0):
 *     - Jack  (bluff opener):  bet with prob alpha            (info set "0:")
 *     - Queen (opener):        always check                   ("1:")
 *     - King  (value opener):  bet with prob 3*alpha          ("2:")
 *     - Jack, after P0 checked and P1 bet:  always fold       ("0:pb")
 *     - Queen,after P0 checked and P1 bet:  call with prob alpha + 1/3 ("1:pb")
 *     - King, after P0 checked and P1 bet:  always call       ("2:pb")
 *
 *   PLAYER 1 (P1) — strategy is FULLY DETERMINED (no free parameter):
 *     - Facing a bet ("X:b"):
 *         Jack:  always fold       ("0:b")
 *         Queen: call with prob 1/3 ("1:b")
 *         King:  always call       ("2:b")
 *     - Facing a check ("X:p"):
 *         Jack:  bet (bluff) with prob 1/3   ("0:p")
 *         Queen: always check                ("1:p")
 *         King:  always bet                  ("2:p")
 *
 *   GAME VALUE to P0 = -1/18 ≈ -0.05556 for every member of the family.
 *
 * Action indexing in this implementation: actions() returns [PASS, BET] so
 * index 0 = PASS (check/fold), index 1 = BET (bet/call). averageStrategy()[BET]
 * is therefore the "aggressive" frequency at every node.
 */

const KUHN_VALUE_P0 = -1 / 18; // ≈ -0.05556

function trainKuhn(scheme: DiscountScheme, iters: number): CfrSolver<any> {
  const game = new KuhnPoker();
  const solver = new CfrSolver(game, { scheme });
  solver.train(iters);
  return solver;
}

/** Aggressive (BET/CALL) frequency of the average strategy at an info set. */
function betFreq(solver: CfrSolver<any>, key: string): number {
  return solver.store.get(key, 2).averageStrategy()[BET];
}

describe('Kuhn poker — analytic equilibrium verification', () => {
  // Sanity: confirm the action ordering we rely on throughout.
  it('actions are [PASS, BET] with PASS=0, BET=1', () => {
    const game = new KuhnPoker();
    expect(PASS).toBe(0);
    expect(BET).toBe(1);
    expect(game.actions(game.root())).toEqual([PASS, BET]);
  });

  it('vanilla CFR reaches the known game value -1/18 (±0.003)', () => {
    const game = new KuhnPoker();
    const solver = trainKuhn(VANILLA, 100000);
    const prof = averageStrategyProfile(solver.store);
    const value = gameValueP0(game, prof);
    // Measured ≈ -0.05556. Tight tolerance — the exact value is structural.
    expect(Math.abs(value - KUHN_VALUE_P0)).toBeLessThan(0.003);
  });

  it('full exploitability (NashConv) converges below 1e-2 (vanilla)', () => {
    const game = new KuhnPoker();
    const solver = trainKuhn(VANILLA, 100000);
    const expl = exploitability(game, averageStrategyProfile(solver.store));
    // Measured ≈ 1.4e-3 at 100k. NashConv is exactly 0 at equilibrium.
    expect(expl).toBeLessThan(1e-2);
    expect(expl).toBeGreaterThanOrEqual(-1e-12);
  });

  it("P0's converged average strategy matches the analytic equilibrium family", () => {
    const solver = trainKuhn(VANILLA, 200000);

    // The free parameter alpha is read off the Jack-bluff frequency and must lie
    // in [0, 1/3]. (Measured ≈ 0.234.)
    const alpha = betFreq(solver, '0:');
    expect(alpha, 'P0 Jack bluff alpha in [0,1/3]').toBeGreaterThanOrEqual(-1e-6);
    expect(alpha).toBeLessThanOrEqual(1 / 3 + 5e-3);

    // King opener must bet at 3*alpha (value-bet exactly thrice the bluff).
    const kingBet = betFreq(solver, '2:');
    expect(kingBet, 'P0 King-bet ≈ 3*alpha').toBeCloseTo(3 * alpha, 2);

    // Queen never opens for a bet.
    expect(betFreq(solver, '1:'), 'P0 never bets the Queen first-in').toBeLessThan(5e-3);

    // P0's responses after checking and being bet into.
    expect(betFreq(solver, '0:pb'), 'P0 always folds Jack to a bet').toBeLessThan(5e-3);
    expect(betFreq(solver, '2:pb'), 'P0 always calls King').toBeGreaterThan(1 - 5e-3);
    // The Queen call frequency is the famous alpha + 1/3 relation, which makes P1
    // indifferent to bluffing the Jack. (Measured ≈ 0.567 ≈ 0.234 + 0.333.)
    expect(betFreq(solver, '1:pb'), 'P0 calls Queen at alpha + 1/3').toBeCloseTo(
      alpha + 1 / 3,
      2,
    );
  });

  it("P1's converged average strategy matches the FIXED analytic frequencies", () => {
    const solver = trainKuhn(VANILLA, 200000);

    // P1 facing a bet (index BET = call):
    expect(betFreq(solver, '0:b'), 'P1 folds Jack to a bet').toBeLessThan(5e-3);
    expect(betFreq(solver, '1:b'), 'P1 calls Queen at exactly 1/3').toBeCloseTo(1 / 3, 2);
    expect(betFreq(solver, '2:b'), 'P1 always calls King').toBeGreaterThan(1 - 5e-3);

    // P1 facing a check (index BET = bet):
    expect(betFreq(solver, '0:p'), 'P1 bluffs Jack at exactly 1/3').toBeCloseTo(1 / 3, 2);
    expect(betFreq(solver, '1:p'), 'P1 never bets the Queen after a check').toBeLessThan(5e-3);
    expect(betFreq(solver, '2:p'), 'P1 always bets King after a check').toBeGreaterThan(
      1 - 5e-3,
    );
  });

  it('exploitability strictly decreases across training checkpoints (vanilla)', () => {
    const game = new KuhnPoker();
    const solver = new CfrSolver(game, { scheme: VANILLA });
    const checkpoints = [10, 100, 1000, 10000, 50000];
    const expls: number[] = [];
    let done = 0;
    for (const cp of checkpoints) {
      solver.train(cp - done);
      done = cp;
      expls.push(exploitability(game, averageStrategyProfile(solver.store)));
    }
    for (let i = 1; i < expls.length; i++) {
      expect(expls[i], `expl at cp ${checkpoints[i]} < cp ${checkpoints[i - 1]}`).toBeLessThan(
        expls[i - 1],
      );
    }
  });

  it('every info-set average strategy is a valid probability distribution', () => {
    const solver = trainKuhn(VANILLA, 5000);
    expect(solver.store.size, 'Kuhn has 12 info sets').toBe(12);
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

  it('Linear CFR and DCFR also converge below 1e-2 with valid strategies', () => {
    const game = new KuhnPoker();
    for (const scheme of [LINEAR_CFR, DCFR]) {
      const solver = trainKuhn(scheme, 50000);
      const prof = averageStrategyProfile(solver.store);
      const expl = exploitability(game, prof);
      expect(expl, `${scheme.name} exploitability`).toBeLessThan(1e-2);
      // Game value should still be ≈ -1/18.
      expect(
        Math.abs(gameValueP0(game, prof) - KUHN_VALUE_P0),
        `${scheme.name} game value`,
      ).toBeLessThan(0.005);
    }
  });

  it('CFR+ and DCFR reach 1e-3 in FEWER iterations than vanilla CFR (Kuhn)', () => {
    // On Kuhn the literature's speedup DOES hold (unlike Leduc; see leduc.test.ts
    // TODO(cfr-plus)). Measured iters-to-1e-3: vanilla≈186k, CFR+≈76k, DCFR≈60k.
    const game = new KuhnPoker();
    const threshold = 1e-3;
    const itersTo = (scheme: DiscountScheme): number => {
      const solver = new CfrSolver(game, { scheme });
      for (let t = 1; t <= 250000; t++) {
        solver.iterate();
        if (t % 25 === 0 || t < 25) {
          const expl = exploitability(game, averageStrategyProfile(solver.store));
          if (expl < threshold) return t;
        }
      }
      throw new Error(`${scheme.name} did not reach ${threshold}`);
    };
    const vanillaIters = itersTo(VANILLA);
    const plusIters = itersTo(CFR_PLUS);
    const dcfrIters = itersTo(DCFR);
    expect(plusIters, 'CFR+ faster than vanilla on Kuhn').toBeLessThan(vanillaIters);
    expect(dcfrIters, 'DCFR faster than vanilla on Kuhn').toBeLessThan(vanillaIters);
  });

  it('vanilla CFR is deterministic: identical runs give identical strategy sums', () => {
    // Vanilla CFR has no randomness; this guards against accidental nondeterminism
    // (e.g. Map iteration order leaking into the math).
    const game = new KuhnPoker();
    const run = () => {
      const s = new CfrSolver(game, { scheme: VANILLA });
      s.train(3000);
      return s.store;
    };
    const a = run();
    const b = run();
    for (const [key, node] of a.entries()) {
      const other = b.get(key, node.numActions);
      for (let i = 0; i < node.numActions; i++) {
        expect(node.strategySum[i], `strategySum[${i}] @ ${key}`).toBe(other.strategySum[i]);
        expect(node.regretSum[i], `regretSum[${i}] @ ${key}`).toBe(other.regretSum[i]);
      }
    }
  });
});
