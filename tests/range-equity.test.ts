import { describe, it, expect } from 'vitest';
import { equityVsRange } from '../src/core/equity/range-equity';
import { villainContinuingRange } from '../src/core/postflop-strategy';
import { cid, ids } from './helpers';

// ============================================================
// equityVsRange — the core anti-blunder fix.
// River spots are exact enumerations (cardsToCome === 0), so these are
// deterministic.
// ============================================================

describe('equityVsRange', () => {
  it('AA has high equity vs a tight value range on a dry board', () => {
    // Dry board, hero has top set. Villain value range = top pairs / overpairs.
    const hero: [number, number] = [cid('Ah'), cid('Ad')];
    const board = ids('Ac', '7d', '2s'); // hero flopped top set of aces
    const range: [number, number][] = [
      [cid('Kh'), cid('Kd')], // KK
      [cid('Qh'), cid('Qd')], // QQ
      [cid('Kc'), cid('7h')], // pair of 7s top kicker-ish
      [cid('Jd'), cid('Js')], // JJ
    ];
    const { equity } = equityVsRange(hero, board, range, 3000);
    expect(equity).toBeGreaterThan(0.9);
  });

  it('a non-flush two pair has LOW equity vs a flush range on a monotone board (the bug)', () => {
    // Monotone heart board. Hero holds two pair with NO heart -> drowning vs a
    // range made entirely of made flushes. This is exactly the spot the old
    // equity-vs-random code mis-evaluated as ~67% and value-bet.
    const hero: [number, number] = [cid('Ks'), cid('Qc')]; // K & Q, no hearts
    const board = ids('Kh', 'Qh', '7h'); // monotone hearts, hero has top two pair
    // Villain range = made flushes (two hearts), excluding board hearts.
    const range: [number, number][] = [
      [cid('Ah'), cid('2h')],
      [cid('Jh'), cid('Th')],
      [cid('9h'), cid('8h')],
      [cid('6h'), cid('5h')],
      [cid('Ah'), cid('3h')],
    ];
    const { equity } = equityVsRange(hero, board, range, 3000);
    // Two pair can still boat up by the river, but vs an all-flush range it must
    // be a clear underdog (well under 50%).
    expect(equity).toBeLessThan(0.45);
  });

  it('returns neutral 0.5 when no villain combo is valid', () => {
    const hero: [number, number] = [cid('Ah'), cid('Ad')];
    const board = ids('Kh', '7c', '2d');
    // Range collides entirely with hero's cards.
    const range: [number, number][] = [[cid('Ah'), cid('Ad')]];
    const r = equityVsRange(hero, board, range, 1000);
    expect(r.equity).toBe(0.5);
    expect(r.combos).toBe(0);
  });

  it('the monotone flush board is reflected in the modeled continuing range', () => {
    // Sanity: the range model actually puts flush combos in the range on a
    // monotone board, so the equity drop above is caused by real flushes.
    const hero: [number, number] = [cid('Ks'), cid('Qc')];
    const board = ids('Kh', 'Qh', '7h');
    const range = villainContinuingRange(hero, board, { aggression: true, multiway: false });
    const flushCombos = range.filter(
      ([a, b]) => a % 4 === 0 && b % 4 === 0, // both hearts (suit 0)
    );
    expect(flushCombos.length).toBeGreaterThan(5);
  });
});
