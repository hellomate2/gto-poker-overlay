import { describe, it, expect } from 'vitest';
import {
  VANILLA,
  CFR_PLUS,
  LINEAR_CFR,
  DCFR,
  discountedCfr,
} from '../../src/solver/cfr';
import { InfoSetNode } from '../../src/solver/store';

/**
 * Unit tests for the pure, closed-form pieces of the solver: the discount
 * schemes (cfr.ts) and regret-matching / averaging (store.ts). These verify the
 * ACTUAL implemented formulas against the equations in:
 *   - Tammelin (2014), CFR+ (regret-matching+, linear strategy averaging);
 *   - Brown & Sandholm (2019), Discounted CFR (DCFR), Eqs. for the (alpha,beta,
 *     gamma) discount weights.
 */

describe('Discount schemes — closed-form weights', () => {
  it('VANILLA applies no discounting and no clamping', () => {
    for (const t of [1, 2, 10, 1000]) {
      expect(VANILLA.regretPos(t)).toBe(1);
      expect(VANILLA.regretNeg(t)).toBe(1);
      expect(VANILLA.strategy(t)).toBe(1);
    }
    expect(VANILLA.clampRegret).toBe(false);
  });

  it('CFR+ clamps regret and uses linear ((t-1)/t) strategy averaging', () => {
    // Tammelin 2014: regret-matching+ (clamp) + weight iteration t by t, which
    // as a running average means scaling the prior cumulative strategy by (t-1)/t.
    expect(CFR_PLUS.clampRegret).toBe(true);
    expect(CFR_PLUS.regretPos(5)).toBe(1); // regrets not discounted, only clamped
    expect(CFR_PLUS.regretNeg(5)).toBe(1);
    expect(CFR_PLUS.strategy(1)).toBe(0); // (1-1)/1 = 0: first iter replaces
    expect(CFR_PLUS.strategy(2)).toBeCloseTo(1 / 2, 12);
    expect(CFR_PLUS.strategy(10)).toBeCloseTo(9 / 10, 12);
  });

  it('Linear CFR weights regrets AND strategy by (t-1)/t, no clamping', () => {
    expect(LINEAR_CFR.clampRegret).toBe(false);
    for (const t of [2, 3, 50]) {
      const w = (t - 1) / t;
      expect(LINEAR_CFR.regretPos(t)).toBeCloseTo(w, 12);
      expect(LINEAR_CFR.regretNeg(t)).toBeCloseTo(w, 12);
      expect(LINEAR_CFR.strategy(t)).toBeCloseTo(w, 12);
    }
  });

  it('DCFR (1.5, 0, 2) matches Brown & Sandholm 2019 formulas exactly', () => {
    const d = discountedCfr(1.5, 0, 2);
    for (const t of [1, 2, 5, 37, 1000]) {
      const ta = Math.pow(t, 1.5);
      expect(d.regretPos(t), `regretPos(${t})`).toBeCloseTo(ta / (ta + 1), 12);
      // beta = 0 => t^0/(t^0+1) = 1/2 for all t.
      expect(d.regretNeg(t), `regretNeg(${t})`).toBeCloseTo(0.5, 12);
      // gamma = 2 => (t/(t+1))^2.
      expect(d.strategy(t), `strategy(${t})`).toBeCloseTo(Math.pow(t / (t + 1), 2), 12);
    }
    expect(d.clampRegret).toBe(false);
    // The exported DCFR is the (1.5,0,2) scheme.
    expect(DCFR.regretPos(10)).toBeCloseTo(d.regretPos(10), 12);
    expect(DCFR.strategy(10)).toBeCloseTo(d.strategy(10), 12);
  });

  it('DCFR positive-regret discount is monotonically increasing toward 1', () => {
    // As documented: positive regret is preserved more and more over time
    // (t^a/(t^a+1) -> 1), letting recent positive regret dominate early noise.
    const d = discountedCfr(1.5, 0, 2);
    let prev = -Infinity;
    for (let t = 1; t <= 200; t++) {
      const v = d.regretPos(t);
      expect(v, `regretPos increasing at t=${t}`).toBeGreaterThan(prev);
      expect(v).toBeLessThan(1);
      prev = v;
    }
    expect(d.regretPos(100000)).toBeGreaterThan(0.99);
  });

  it('DCFR strategy discount is monotonically increasing toward 1', () => {
    const d = discountedCfr(1.5, 0, 2);
    let prev = -Infinity;
    for (let t = 1; t <= 200; t++) {
      const v = d.strategy(t);
      expect(v, `strategy increasing at t=${t}`).toBeGreaterThan(prev);
      expect(v).toBeLessThan(1);
      prev = v;
    }
  });

  it('DCFR negative-regret discount (beta=0) is constant 1/2', () => {
    const d = discountedCfr(1.5, 0, 2);
    for (let t = 1; t <= 500; t++) expect(d.regretNeg(t)).toBeCloseTo(0.5, 12);
  });

  it('custom DCFR params (1,1,1) reduce to a Linear-CFR-like profile', () => {
    const d = discountedCfr(1, 1, 1);
    for (const t of [2, 4, 8]) {
      // a=b=1: t/(t+1) for both regret signs; g=1: t/(t+1) strategy.
      expect(d.regretPos(t)).toBeCloseTo(t / (t + 1), 12);
      expect(d.regretNeg(t)).toBeCloseTo(t / (t + 1), 12);
      expect(d.strategy(t)).toBeCloseTo(t / (t + 1), 12);
    }
  });
});

describe('Regret matching (store.ts)', () => {
  it('strategy is proportional to positive regret (Hart & Mas-Colell 2000)', () => {
    const node = new InfoSetNode(3);
    node.regretSum[0] = 2;
    node.regretSum[1] = -5; // negative regret ignored
    node.regretSum[2] = 6;
    const s = node.strategy();
    expect(s[0]).toBeCloseTo(2 / 8, 12);
    expect(s[1]).toBeCloseTo(0, 12);
    expect(s[2]).toBeCloseTo(6 / 8, 12);
    expect(s[0] + s[1] + s[2]).toBeCloseTo(1, 12);
  });

  it('falls back to uniform when no action has positive regret', () => {
    const node = new InfoSetNode(4);
    node.regretSum[0] = -1;
    node.regretSum[1] = 0;
    node.regretSum[2] = -3;
    node.regretSum[3] = 0;
    const s = node.strategy();
    for (const p of s) expect(p).toBeCloseTo(0.25, 12);
  });

  it('averageStrategy normalizes cumulative strategy sums', () => {
    const node = new InfoSetNode(2);
    node.strategySum[0] = 3;
    node.strategySum[1] = 1;
    const avg = node.averageStrategy();
    expect(avg[0]).toBeCloseTo(0.75, 12);
    expect(avg[1]).toBeCloseTo(0.25, 12);
  });

  it('averageStrategy is uniform before any accumulation', () => {
    const node = new InfoSetNode(3);
    const avg = node.averageStrategy();
    for (const p of avg) expect(p).toBeCloseTo(1 / 3, 12);
  });
});
