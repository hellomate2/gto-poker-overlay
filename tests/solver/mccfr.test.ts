import { describe, it, expect } from 'vitest';
import { KuhnPoker } from '../../src/solver/games/kuhn';
import { OutcomeSamplingMccfr, ExternalSamplingMccfr } from '../../src/solver/mccfr';
import { SeededRng } from '../../src/solver/rng';
import { averageStrategyProfile, exploitability } from '../../src/solver/exploitability';

describe('SeededRng', () => {
  it('is deterministic for a given seed', () => {
    const a = new SeededRng(42);
    const b = new SeededRng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('produces values in [0,1) and different streams for different seeds', () => {
    const r = new SeededRng(7);
    for (let i = 0; i < 1000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(new SeededRng(1).next()).not.toBe(new SeededRng(2).next());
  });
});

describe('MCCFR — sampling variants reduce exploitability', () => {
  it('external-sampling MCCFR reduces Kuhn exploitability over iterations', () => {
    const game = new KuhnPoker();
    const solver = new ExternalSamplingMccfr(game, new SeededRng(123));
    solver.train(2000);
    const early = exploitability(game, averageStrategyProfile(solver.store));
    solver.train(98000); // total 100k
    const late = exploitability(game, averageStrategyProfile(solver.store));
    expect(late).toBeLessThan(early);
    // Looser threshold due to sampling variance.
    expect(late).toBeLessThan(0.05);
  });

  it('outcome-sampling MCCFR reduces Kuhn exploitability over iterations', () => {
    const game = new KuhnPoker();
    const solver = new OutcomeSamplingMccfr(game, new SeededRng(123));
    solver.train(5000);
    const early = exploitability(game, averageStrategyProfile(solver.store));
    solver.train(495000); // total 500k
    const late = exploitability(game, averageStrategyProfile(solver.store));
    expect(late).toBeLessThan(early);
    expect(late).toBeLessThan(0.1);
  });

  it('MCCFR is reproducible: same seed yields identical exploitability', () => {
    const game = new KuhnPoker();
    const run = (): number => {
      const s = new ExternalSamplingMccfr(game, new SeededRng(99));
      s.train(5000);
      return exploitability(game, averageStrategyProfile(s.store));
    };
    expect(run()).toBe(run());
  });

  it('MCCFR average strategies are valid probability distributions', () => {
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
