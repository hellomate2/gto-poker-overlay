import { describe, it, expect } from 'vitest';
import { equityVsRandom, equityVsRange, quickEquity } from '../src/core/equity/monte-carlo';
import { cid, ids } from './helpers';

// Monte Carlo is stochastic; use generous tolerances around known equities.

describe('preflop equity vs a random hand', () => {
  it('AA has roughly 85% equity vs a random hand', () => {
    const { equity } = equityVsRandom([cid('Ah'), cid('Ad')], [], 8000);
    expect(equity).toBeGreaterThan(0.80);
    expect(equity).toBeLessThan(0.90);
  });

  it('72o is a clear underdog vs a random hand (well below 50%)', () => {
    const { equity } = equityVsRandom([cid('7c'), cid('2h')], [], 8000);
    expect(equity).toBeGreaterThan(0.25);
    expect(equity).toBeLessThan(0.45);
  });

  it('a strong hand beats a weak hand head to head', () => {
    const strong = equityVsRandom([cid('Ah'), cid('Ad')], [], 6000).equity;
    const weak = equityVsRandom([cid('7c'), cid('2h')], [], 6000).equity;
    expect(strong).toBeGreaterThan(weak);
  });

  it('win/tie/lose fractions sum to 1', () => {
    const r = equityVsRandom([cid('Ks'), cid('Qs')], [], 4000);
    expect(r.win + r.tie + r.lose).toBeCloseTo(1, 5);
    expect(r.samples).toBe(4000);
  });
});

describe('equity given a board', () => {
  it('a made flush on the board is a heavy favorite vs random', () => {
    const hero: [number, number] = [cid('Ah'), cid('Kh')];
    const board = ids('Qh', 'Jh', '2h'); // hero has the nut flush
    const { equity } = equityVsRandom(hero, board, 4000);
    expect(equity).toBeGreaterThan(0.90);
  });

  it('completes the board correctly on the turn (1 card to come)', () => {
    const r = equityVsRandom([cid('Ah'), cid('Ad')], ids('Kh', '7c', '2d', '9s'), 3000);
    expect(r.win + r.tie + r.lose).toBeCloseTo(1, 5);
    expect(r.equity).toBeGreaterThan(0.5);
  });
});

describe('equity vs a defined range', () => {
  it('AA is favored against a premium {KK, QQ} range', () => {
    const range: [number, number][] = [
      [cid('Kh'), cid('Kd')],
      [cid('Qh'), cid('Qd')],
    ];
    const { equity } = equityVsRange([cid('Ah'), cid('Ad')], [], range, 4000);
    expect(equity).toBeGreaterThan(0.75);
  });

  it('returns neutral equity when the range has no valid combos', () => {
    // Range collides entirely with hero's cards.
    const range: [number, number][] = [[cid('Ah'), cid('Ad')]];
    const r = equityVsRange([cid('Ah'), cid('Ad')], [], range, 1000);
    expect(r.equity).toBe(0.5);
    expect(r.samples).toBe(0);
  });
});

describe('quickEquity', () => {
  it('returns a probability in [0,1] and favors AA', () => {
    const e = quickEquity([cid('Ah'), cid('Ad')], []);
    expect(e).toBeGreaterThanOrEqual(0);
    expect(e).toBeLessThanOrEqual(1);
    expect(e).toBeGreaterThan(0.75);
  });
});
