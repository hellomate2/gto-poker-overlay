import { describe, it, expect } from 'vitest';
import { KuhnPoker } from '../../src/solver/games/kuhn';
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

const KUHN_VALUE_P0 = -1 / 18; // ≈ -0.05556

function trainKuhn(scheme: DiscountScheme, iters: number): CfrSolver<any> {
  const game = new KuhnPoker();
  const solver = new CfrSolver(game, { scheme });
  solver.train(iters);
  return solver;
}

describe('Kuhn poker — CFR convergence', () => {
  it('vanilla CFR reaches the known game value -1/18 within 0.005', () => {
    const game = new KuhnPoker();
    const solver = trainKuhn(VANILLA, 20000);
    const prof = averageStrategyProfile(solver.store);
    const value = gameValueP0(game, prof);
    expect(Math.abs(value - KUHN_VALUE_P0)).toBeLessThan(0.005);
  });

  it('exploitability drops below 1e-2 for vanilla, CFR+, and DCFR', () => {
    const game = new KuhnPoker();
    for (const scheme of [VANILLA, CFR_PLUS, DCFR]) {
      const solver = trainKuhn(scheme, 20000);
      const prof = averageStrategyProfile(solver.store);
      const expl = exploitability(game, prof);
      expect(expl, `scheme ${scheme.name}`).toBeLessThan(1e-2);
      expect(expl, `scheme ${scheme.name} non-negative`).toBeGreaterThanOrEqual(-1e-12);
    }
  });

  it('exploitability strictly decreases over training (vanilla CFR)', () => {
    const game = new KuhnPoker();
    const solver = new CfrSolver(game, { scheme: VANILLA });
    const checkpoints = [10, 100, 1000, 10000];
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

  it('CFR+ reaches a threshold in fewer iterations than vanilla CFR', () => {
    const game = new KuhnPoker();
    const threshold = 1e-3;
    const itersTo = (scheme: DiscountScheme): number => {
      const solver = new CfrSolver(game, { scheme });
      for (let t = 1; t <= 200000; t++) {
        solver.iterate();
        // Check periodically to keep the test fast.
        if (t % 25 === 0 || t < 25) {
          const expl = exploitability(game, averageStrategyProfile(solver.store));
          if (expl < threshold) return t;
        }
      }
      throw new Error(`${scheme.name} did not reach ${threshold}`);
    };
    const vanillaIters = itersTo(VANILLA);
    const plusIters = itersTo(CFR_PLUS);
    expect(plusIters).toBeLessThan(vanillaIters);
  });

  it('Linear CFR also converges below 1e-2', () => {
    const game = new KuhnPoker();
    const solver = trainKuhn(LINEAR_CFR, 20000);
    const expl = exploitability(game, averageStrategyProfile(solver.store));
    expect(expl).toBeLessThan(1e-2);
  });

  it('every info-set average strategy is a valid probability distribution', () => {
    const solver = trainKuhn(VANILLA, 5000);
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

  it('player-0 Jack bluff frequency lies in the equilibrium range [0, 1/3]', () => {
    // Equilibrium: P0 betting the Jack first-in ("0:") has frequency alpha in
    // [0, 1/3]. Verify the converged average strategy respects this.
    const solver = trainKuhn(VANILLA, 50000);
    const node = solver.store.get('0:', 2); // card=Jack(0), empty history
    const avg = node.averageStrategy();
    const betFreq = avg[1]; // BET index
    expect(betFreq).toBeGreaterThanOrEqual(-1e-9);
    expect(betFreq).toBeLessThanOrEqual(1 / 3 + 1e-2);
  });
});
