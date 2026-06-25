import { describe, it, expect } from 'vitest';
import { KuhnPoker, BET } from '../../src/solver/games/kuhn';
import { OutcomeSamplingMccfr, ExternalSamplingMccfr } from '../../src/solver/mccfr';
import { SeededRng } from '../../src/solver/rng';
import {
  averageStrategyProfile,
  exploitability,
  gameValueP0,
} from '../../src/solver/exploitability';

/**
 * MCCFR tests. Monte-Carlo CFR (Lanctot, Waugh, Zinkevich, Bowling 2009) only
 * converges to equilibrium IN EXPECTATION, so its assertions are necessarily
 * looser than vanilla CFR's. We still verify real properties, not just "expl
 * went down":
 *   - seeded determinism is EXACT (same seed -> bit-identical regret/strategy
 *     sums), which is the property the whole reproducibility story depends on;
 *   - external sampling actually approaches the analytic Kuhn equilibrium;
 *   - both samplers reduce exploitability monotonically across a long run;
 *   - strategies stay valid distributions throughout.
 */

describe('SeededRng (mulberry32)', () => {
  it('is deterministic for a given seed', () => {
    const a = new SeededRng(42);
    const b = new SeededRng(42);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('produces values strictly in [0,1) and distinct streams for distinct seeds', () => {
    const r = new SeededRng(7);
    for (let i = 0; i < 10000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(new SeededRng(1).next()).not.toBe(new SeededRng(2).next());
  });

  it('sampleFromWeights respects the weight distribution (chi-square-ish)', () => {
    // Weights [1,3] -> expect roughly 25% / 75%. Loose bound, just guards a
    // grossly wrong sampler.
    const r = new SeededRng(2024);
    const counts = [0, 0];
    const N = 40000;
    for (let i = 0; i < N; i++) counts[r.sampleFromWeights([1, 3])]++;
    expect(counts[0] / N).toBeGreaterThan(0.22);
    expect(counts[0] / N).toBeLessThan(0.28);
  });

  it('sampleFromWeights falls back to uniform when all weights are zero', () => {
    const r = new SeededRng(3);
    const counts = [0, 0, 0];
    for (let i = 0; i < 30000; i++) counts[r.sampleFromWeights([0, 0, 0])]++;
    for (const c of counts) expect(c).toBeGreaterThan(8000); // ~10000 each
  });
});

describe('MCCFR — external sampling', () => {
  it('approaches the analytic Kuhn equilibrium (value & strategy)', () => {
    const game = new KuhnPoker();
    const solver = new ExternalSamplingMccfr(game, new SeededRng(123));
    solver.train(200000);
    const prof = averageStrategyProfile(solver.store);

    // Measured: expl ≈ 0.0014, value ≈ -0.0556, alpha ≈ 0.26, Kbet ≈ 0.785.
    expect(exploitability(game, prof), 'NashConv small under sampling').toBeLessThan(1e-2);
    expect(Math.abs(gameValueP0(game, prof) - -1 / 18)).toBeLessThan(5e-3);

    const alpha = solver.store.get('0:', 2).averageStrategy()[BET];
    expect(alpha, 'Jack bluff alpha in [0,1/3]').toBeGreaterThanOrEqual(-1e-3);
    expect(alpha).toBeLessThanOrEqual(1 / 3 + 0.02);
    const kingBet = solver.store.get('2:', 2).averageStrategy()[BET];
    // Looser than vanilla (sampling noise): K-bet should track ~3*alpha.
    expect(kingBet).toBeCloseTo(3 * alpha, 1);
  });

  it('reduces Kuhn exploitability over a long run', () => {
    const game = new KuhnPoker();
    const solver = new ExternalSamplingMccfr(game, new SeededRng(123));
    solver.train(2000);
    const early = exploitability(game, averageStrategyProfile(solver.store));
    solver.train(98000); // total 100k
    const late = exploitability(game, averageStrategyProfile(solver.store));
    expect(late).toBeLessThan(early);
    expect(late).toBeLessThan(0.02);
  });

  it('is EXACTLY reproducible: same seed -> bit-identical regret & strategy sums', () => {
    const game = new KuhnPoker();
    const run = () => {
      const s = new ExternalSamplingMccfr(game, new SeededRng(99));
      s.train(5000);
      return s.store;
    };
    const a = run();
    const b = run();
    expect(a.size).toBe(b.size);
    for (const [key, node] of a.entries()) {
      const other = b.get(key, node.numActions);
      for (let i = 0; i < node.numActions; i++) {
        expect(node.regretSum[i], `regretSum[${i}] @ ${key}`).toBe(other.regretSum[i]);
        expect(node.strategySum[i], `strategySum[${i}] @ ${key}`).toBe(other.strategySum[i]);
      }
    }
  });

  it('different seeds give different (but both valid) trajectories', () => {
    const game = new KuhnPoker();
    const expl = (seed: number) => {
      const s = new ExternalSamplingMccfr(game, new SeededRng(seed));
      s.train(2000);
      return exploitability(game, averageStrategyProfile(s.store));
    };
    expect(expl(1)).not.toBe(expl(2));
  });
});

describe('MCCFR — outcome sampling', () => {
  it('reduces Kuhn exploitability below a looser threshold', () => {
    const game = new KuhnPoker();
    const solver = new OutcomeSamplingMccfr(game, new SeededRng(123));
    solver.train(5000);
    const early = exploitability(game, averageStrategyProfile(solver.store));
    solver.train(495000); // total 500k
    const late = exploitability(game, averageStrategyProfile(solver.store));
    expect(late).toBeLessThan(early);
    // Outcome sampling is higher variance; measured ≈ 0.004 at 500k.
    expect(late).toBeLessThan(0.05);
  });

  it('is exactly reproducible under a fixed seed', () => {
    const game = new KuhnPoker();
    const run = () => {
      const s = new OutcomeSamplingMccfr(game, new SeededRng(7));
      s.train(5000);
      return exploitability(game, averageStrategyProfile(s.store));
    };
    expect(run()).toBe(run());
  });
});

describe('MCCFR — strategy validity', () => {
  it('external-sampling average strategies are valid distributions', () => {
    const game = new KuhnPoker();
    const solver = new ExternalSamplingMccfr(game, new SeededRng(5));
    solver.train(10000);
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
