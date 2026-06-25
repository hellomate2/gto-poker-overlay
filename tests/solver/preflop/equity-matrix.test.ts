import { describe, it, expect } from 'vitest';
import { equityMatrix } from '../../../src/solver/preflop/equity-matrix';
import { nameToIndex, NUM_CATEGORIES, categories } from '../../../src/solver/preflop/categories';

const M = equityMatrix(); // cached
const eq = (a: string, b: string) => M[nameToIndex(a)][nameToIndex(b)];

describe('preflop all-in equity matrix', () => {
  it('is 169x169', () => {
    expect(M.length).toBe(NUM_CATEGORIES);
    for (const row of M) expect(row.length).toBe(NUM_CATEGORIES);
  });

  it('every entry is a probability in [0,1]', () => {
    for (let i = 0; i < NUM_CATEGORIES; i++) {
      for (let j = 0; j < NUM_CATEGORIES; j++) {
        expect(M[i][j]).toBeGreaterThanOrEqual(0);
        expect(M[i][j]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is exactly antisymmetric: eq[i][j] + eq[j][i] === 1 (i != j)', () => {
    for (let i = 0; i < NUM_CATEGORIES; i++) {
      for (let j = i + 1; j < NUM_CATEGORIES; j++) {
        expect(M[i][j] + M[j][i]).toBeCloseTo(1, 9);
      }
    }
  });

  it('matches known hand-vs-hand equities within sampling tolerance', () => {
    expect(eq('AA', 'KK')).toBeCloseTo(0.82, 1); // ~82%
    expect(eq('AA', '72o')).toBeGreaterThan(0.85); // ~87%
    expect(eq('AKs', '22')).toBeCloseTo(0.5, 1); // coinflip-ish
    expect(eq('AKo', 'QQ')).toBeCloseTo(0.43, 1); // ~43%
    expect(eq('JTs', 'AKo')).toBeGreaterThan(0.38);
    expect(eq('JTs', 'AKo')).toBeLessThan(0.45);
  });

  it('a hand vs itself is ~50% (mirror equity)', () => {
    // Same category vs same category: by symmetry the diagonal should be ~0.5.
    for (const c of categories()) {
      expect(M[c.index][c.index]).toBeCloseTo(0.5, 1);
    }
  });

  it('dominant hands beat dominated ones', () => {
    expect(eq('AA', 'AKo')).toBeGreaterThan(0.8);
    expect(eq('KK', 'QQ')).toBeGreaterThan(0.75);
    expect(eq('AKs', 'AQs')).toBeGreaterThan(0.65);
  });
});

describe('categories', () => {
  it('has 13 pairs, 78 suited, 78 offsuit', () => {
    const cats = categories();
    expect(cats.filter((c) => c.kind === 'pair').length).toBe(13);
    expect(cats.filter((c) => c.kind === 'suited').length).toBe(78);
    expect(cats.filter((c) => c.kind === 'offsuit').length).toBe(78);
  });

  it('combo counts are pair=6, suited=4, offsuit=12', () => {
    for (const c of categories()) {
      if (c.kind === 'pair') expect(c.comboCount).toBe(6);
      else if (c.kind === 'suited') expect(c.comboCount).toBe(4);
      else expect(c.comboCount).toBe(12);
      expect(c.combos.length).toBe(c.comboCount);
    }
  });

  it('names round-trip with nameToIndex', () => {
    for (const c of categories()) {
      expect(nameToIndex(c.name)).toBe(c.index);
    }
  });
});
