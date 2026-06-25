import { describe, it, expect } from 'vitest';
import { equityVsRange } from '../src/core/equity/range-equity';
import { villainContinuingRange } from '../src/core/postflop-strategy';
import { cid, ids } from './helpers';

// ============================================================
// equityVsRange — the core anti-blunder fix.
// When cardsToCome <= 2 the source ENUMERATES every runout, so flop/turn/river
// spots are fully deterministic (the `iterations` arg is ignored there). The
// expected equities below were verified by independent exhaustive enumeration,
// so the bands are tight enough to catch a real regression — not the ~10x-loose
// bands the first version shipped with.
// ============================================================

describe('equityVsRange', () => {
  it('AA top set has ~99.9% equity vs a tight value range on a dry board', () => {
    // Dry board A72, hero flopped top set. Villain value range = overpairs + a
    // pair-of-7s combo. Exact equity (two cards to come) = 0.9990.
    const hero: [number, number] = [cid('Ah'), cid('Ad')];
    const board = ids('Ac', '7d', '2s');
    const range: [number, number][] = [
      [cid('Kh'), cid('Kd')], // KK
      [cid('Qh'), cid('Qd')], // QQ
      [cid('Kc'), cid('7h')], // K7: a pair of sevens with a king kicker
      [cid('Jd'), cid('Js')], // JJ
    ];
    const { equity } = equityVsRange(hero, board, range, 3000);
    expect(equity).toBeGreaterThan(0.98); // true value 0.999
  });

  it('a non-flush two pair has ~17% equity vs a flush range on a monotone board (the bug)', () => {
    // Monotone hearts, hero holds top two pair with NO heart -> drowning vs an
    // all-made-flush range. The OLD equity-vs-random code mis-read this as ~67%
    // and value-bet. Exact equity = 0.1740 (hero wins only by boating up).
    const hero: [number, number] = [cid('Ks'), cid('Qc')];
    const board = ids('Kh', 'Qh', '7h');
    const range: [number, number][] = [
      [cid('Ah'), cid('2h')],
      [cid('Jh'), cid('Th')],
      [cid('9h'), cid('8h')],
      [cid('6h'), cid('5h')],
      [cid('Ah'), cid('3h')],
    ];
    const { equity } = equityVsRange(hero, board, range, 3000);
    expect(equity).toBeLessThan(0.25); // true value 0.174 (a regression to ~0.4+ trips this)
  });

  it('river spot is an EXACT showdown: nut flush vs a set is exactly 1.0', () => {
    // Full board out (cardsToCome === 0): one evaluateHand per combo, no runout.
    // Hero Ah2h holds the A-high flush on a 3-heart board; villain set of kings
    // has no flush and cannot improve (river is already dealt) -> hero wins 100%.
    const hero: [number, number] = [cid('Ah'), cid('2h')];
    const board = ids('Kh', 'Qh', '7h', '3c', '9s');
    const range: [number, number][] = [[cid('Kc'), cid('Kd')]];
    const r = equityVsRange(hero, board, range, 1000);
    expect(r.equity).toBe(1);
    expect(r.combos).toBe(1);
    expect(r.samples).toBe(1); // exactly one showdown, no enumeration
  });

  it('turn spot enumerates the 1 card to come: made flush vs a set = 34/44', () => {
    // Turn board (cardsToCome === 1). Hero already has the A-high flush; villain
    // KK (trip kings) wins only if the river pairs the board or brings the case K
    // (10 outs of 44). Exact equity = 1 - 10/44 = 34/44 = 0.77272...
    const hero: [number, number] = [cid('Ah'), cid('2h')];
    const board = ids('Kh', 'Qh', '7h', '3c');
    const range: [number, number][] = [[cid('Kc'), cid('Kd')]];
    const r = equityVsRange(hero, board, range, 1000);
    expect(r.equity).toBeCloseTo(34 / 44, 5);
    expect(r.combos).toBe(1);
    expect(r.samples).toBe(44); // 48 - 4 known cards = 44 river runouts enumerated
  });

  it('returns neutral 0.5 when no villain combo is valid', () => {
    const hero: [number, number] = [cid('Ah'), cid('Ad')];
    const board = ids('Kh', '7c', '2d');
    const range: [number, number][] = [[cid('Ah'), cid('Ad')]]; // collides with hero
    const r = equityVsRange(hero, board, range, 1000);
    expect(r.equity).toBe(0.5);
    expect(r.combos).toBe(0);
  });

  it('drops villain combos that collide with hero/board cards (card removal)', () => {
    // River out. One combo reuses a board card (illegal) and must be dropped; only
    // the legal combo is scored. Hero trip nines beat villain's two pair -> 1.0.
    const hero: [number, number] = [cid('9c'), cid('9d')];
    const board = ids('Ad', 'Kc', '9h', '4s', '2c');
    const range: [number, number][] = [
      [cid('9s'), cid('9h')], // illegal: 9h is on the board
      [cid('As'), cid('Ks')], // legal: two pair, loses to trips
    ];
    const r = equityVsRange(hero, board, range, 1000);
    expect(r.combos).toBe(1); // the illegal combo was removed
    expect(r.equity).toBe(1);
  });
});

// ============================================================
// villainContinuingRange — the realistic continuing-range model. Several
// branches (flush combos, aggression-gated draws, straights) were essentially
// untested; pin the behavioral differences directly.
// ============================================================

describe('villainContinuingRange', () => {
  it('puts exactly the 45 two-heart flush combos in the range on a monotone board', () => {
    const hero: [number, number] = [cid('Ks'), cid('Qc')];
    const board = ids('Kh', 'Qh', '7h');
    const range = villainContinuingRange(hero, board, { aggression: true, multiway: false });
    const flushCombos = range.filter(([a, b]) => a % 4 === 0 && b % 4 === 0); // both hearts
    // 10 live hearts remain (A,J,T,9,8,6,5,4,3,2 of hearts) -> C(10,2) = 45.
    expect(flushCombos.length).toBe(45);
  });

  it('never includes a combo that conflicts with hero or board cards', () => {
    const hero: [number, number] = [cid('Ks'), cid('Qc')];
    const board = ids('Kh', 'Qh', '7h');
    const blocked = new Set([...hero, ...board]);
    const range = villainContinuingRange(hero, board, { aggression: true, multiway: false });
    for (const [a, b] of range) {
      expect(blocked.has(a)).toBe(false);
      expect(blocked.has(b)).toBe(false);
      expect(a).not.toBe(b);
    }
  });

  it('aggression gates the draw-heavy hands: flush draws appear only with no aggression', () => {
    // Two-tone (not monotone) board so a flush DRAW (exactly 2 of a suit) exists.
    const hero: [number, number] = [cid('Ks'), cid('Qc')];
    const board = ids('Ah', 'Th', '5c'); // two hearts on board => flush-draw suit
    const passive = villainContinuingRange(hero, board, { aggression: false, multiway: false });
    const aggressive = villainContinuingRange(hero, board, { aggression: true, multiway: false });
    // The continuing range when nobody has bet is wider (peeling draws) than the
    // tighter range that must withstand aggression.
    expect(passive.length).toBeGreaterThan(aggressive.length);
  });

  it('includes made-straight combos on a connected board', () => {
    // 9-8-7 is highly connected; two hole cards can complete many straights.
    const hero: [number, number] = [cid('Ac'), cid('Ad')];
    const board = ids('9h', '8d', '7c');
    const range = villainContinuingRange(hero, board, { aggression: true, multiway: false });
    // e.g. JT, T6, 65 all make a straight; the range must be non-trivially large.
    expect(range.length).toBeGreaterThan(20);
  });

  it('DOCUMENTS the multiway flag is currently a no-op (same combos either way)', () => {
    // postflop-strategy.ts accepts `multiway` but does `void ctx.multiway` — it does
    // NOT yet tighten the range. This pins that known limitation so a future fix is
    // a conscious, test-visible change rather than silent.
    const hero: [number, number] = [cid('Ks'), cid('Qc')];
    const board = ids('Kh', 'Qh', '7h');
    const hu = villainContinuingRange(hero, board, { aggression: true, multiway: false });
    const mw = villainContinuingRange(hero, board, { aggression: true, multiway: true });
    expect(mw.length).toBe(hu.length);
  });
});
