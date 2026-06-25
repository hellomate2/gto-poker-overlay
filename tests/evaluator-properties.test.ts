import { describe, it, expect } from 'vitest';
import { evaluateHand, HAND_CATEGORY } from '../src/core/equity/hand-eval';
import { ids } from './helpers';
import { CardId } from '../src/types/poker';

const CATEGORY_MULTIPLIER = 1_000_000;
const categoryOf = (rank: number) => Math.floor(rank / CATEGORY_MULTIPLIER);

// Deterministic, high-quality PRNG (mulberry32) so the property tests are
// reproducible AND unbiased. A plain LCG's low bits are non-random, which would
// skew (rng()*52|0) card draws enough to distort the sampled 7-card category
// distribution; mulberry32 has well-distributed low bits.
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawDistinct(rng: () => number, count: number): CardId[] {
  const chosen = new Set<number>();
  while (chosen.size < count) chosen.add((rng() * 52) | 0);
  return [...chosen];
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============================================================
// TASK 4 — PROPERTY: card order never changes the rank.
// ============================================================

describe('evaluator property — permutation invariance', () => {
  it('permuting card order yields the same rank (5,6,7-card hands)', () => {
    const rng = makeRng(0xc0ffee);
    for (let n of [5, 6, 7]) {
      for (let t = 0; t < 1500; t++) {
        const hand = drawDistinct(rng, n);
        const base = evaluateHand(hand);
        // Try several random permutations.
        for (let p = 0; p < 4; p++) {
          const perm = shuffle(hand, rng);
          expect(evaluateHand(perm), `n=${n} perm`).toBe(base);
        }
      }
    }
  });
});

// ============================================================
// TASK 4 — PROPERTY: adding a card never lowers best-5 strength.
//
// Best-of-N is monotone: the best 5-card hand from N+1 cards is at least as
// strong as the best from any N-card subset of it. We test: rank(5 cards) <=
// rank(those 5 + 1 more), and the same stepping up to 7.
// ============================================================

describe('evaluator property — adding a card is monotone non-decreasing', () => {
  it('rank(5) <= rank(6) <= rank(7) on the same growing hand', () => {
    const rng = makeRng(0x5eed);
    for (let t = 0; t < 3000; t++) {
      const seven = drawDistinct(rng, 7);
      const five = seven.slice(0, 5);
      const six = seven.slice(0, 6);
      const r5 = evaluateHand(five);
      const r6 = evaluateHand(six);
      const r7 = evaluateHand(seven);
      expect(r6, '6 >= 5').toBeGreaterThanOrEqual(r5);
      expect(r7, '7 >= 6').toBeGreaterThanOrEqual(r6);
    }
  });

  it('adding any single card to a fixed 5-card hand never lowers strength', () => {
    const rng = makeRng(0xfeed);
    for (let t = 0; t < 500; t++) {
      const five = drawDistinct(rng, 5);
      const r5 = evaluateHand(five);
      const fiveSet = new Set(five);
      // Try 6 random extra cards.
      let added = 0;
      while (added < 6) {
        const extra = (rng() * 52) | 0;
        if (fiveSet.has(extra)) continue;
        const r6 = evaluateHand([...five, extra]);
        expect(r6, 'adding a card never lowers strength').toBeGreaterThanOrEqual(r5);
        added++;
      }
    }
  });
});

// ============================================================
// TASK 4 — 7-card category distribution sanity (sampled).
//
// We don't hardcode the exact C(52,7) counts (that's a separate, heavier
// enumeration) but assert the SHAPE is sane on a large sample: every category
// appears, and the ordering of frequencies is plausible (pairs & two-pair are
// the most common categories in 7-card poker; straight flush is rarest).
// ============================================================

describe('evaluator — 7-card category distribution sanity (sampled)', () => {
  it('all 9 categories appear; rough frequency ordering is sane', () => {
    const rng = makeRng(0x7c7c7c);
    const counts = new Array(9).fill(0);
    const N = 120000;
    for (let i = 0; i < N; i++) {
      const hand = drawDistinct(rng, 7);
      counts[categoryOf(evaluateHand(hand))]++;
    }
    // Every category must be observed at least once in 120k samples.
    for (let c = 0; c < 9; c++) {
      expect(counts[c], `category ${c} observed`).toBeGreaterThan(0);
    }
    // Known 7-card frequencies (approx, fraction of C(52,7)):
    //   pair 43.8%, two pair 23.5%, high card 17.4%, trips 4.8%,
    //   straight 4.6%, flush 3.0%, full house 2.6%, quads 0.17%, SF 0.031%
    const frac = counts.map(c => c / N);
    // Pair is the most common single category.
    const maxIdx = frac.indexOf(Math.max(...frac));
    expect(maxIdx).toBe(HAND_CATEGORY.PAIR);
    // Two pair beats high card; both beat trips.
    expect(frac[HAND_CATEGORY.TWO_PAIR]).toBeGreaterThan(frac[HAND_CATEGORY.HIGH_CARD]);
    expect(frac[HAND_CATEGORY.HIGH_CARD]).toBeGreaterThan(frac[HAND_CATEGORY.THREE_OF_A_KIND]);
    // Straight flush is the rarest.
    const minIdx = frac.indexOf(Math.min(...frac));
    expect(minIdx).toBe(HAND_CATEGORY.STRAIGHT_FLUSH);
    // Quads rarer than full house; full house rarer than flush.
    expect(frac[HAND_CATEGORY.FOUR_OF_A_KIND]).toBeLessThan(frac[HAND_CATEGORY.FULL_HOUSE]);
    expect(frac[HAND_CATEGORY.FULL_HOUSE]).toBeLessThan(frac[HAND_CATEGORY.FLUSH]);
    // Sanity: pair fraction in a believable band around the known 43.8%.
    expect(frac[HAND_CATEGORY.PAIR]).toBeGreaterThan(0.4);
    expect(frac[HAND_CATEGORY.PAIR]).toBeLessThan(0.47);
    // eslint-disable-next-line no-console
    console.log(
      `[eval7] frac: ` +
        frac.map((f, i) => `${i}:${(f * 100).toFixed(2)}%`).join(' '),
    );
  });
});

// ============================================================
// TASK 4 — wheel straight + steel wheel edge cases.
// ============================================================

describe('evaluator — wheel and steel-wheel edges', () => {
  it('A-2-3-4-5 is a STRAIGHT and the weakest one (below 6-high)', () => {
    const wheel = evaluateHand(ids('Ad', '2c', '3h', '4s', '5d'));
    const sixHigh = evaluateHand(ids('6c', '5d', '4h', '3s', '2c'));
    expect(categoryOf(wheel)).toBe(HAND_CATEGORY.STRAIGHT);
    expect(sixHigh).toBeGreaterThan(wheel);
  });

  it('A-2-3-4-5 same suit is a STRAIGHT FLUSH (steel wheel), weakest SF', () => {
    const steel = evaluateHand(ids('Ah', '2h', '3h', '4h', '5h'));
    const sixSF = evaluateHand(ids('6h', '5h', '4h', '3h', '2h'));
    expect(categoryOf(steel)).toBe(HAND_CATEGORY.STRAIGHT_FLUSH);
    expect(sixSF).toBeGreaterThan(steel);
  });

  it('ace plays low only for the wheel: A-K-Q-J-T is the BEST straight', () => {
    const broadway = evaluateHand(ids('Ad', 'Kc', 'Qh', 'Js', 'Td'));
    const wheel = evaluateHand(ids('Ad', '2c', '3h', '4s', '5d'));
    expect(categoryOf(broadway)).toBe(HAND_CATEGORY.STRAIGHT);
    expect(broadway).toBeGreaterThan(wheel);
  });

  it('wheel does NOT outrank a higher straight in a 7-card hand', () => {
    // 7 cards containing both a wheel and a 6-high straight: best-5 is 6-high.
    const r = evaluateHand(ids('Ad', '2c', '3h', '4s', '5d', '6c', 'Kh'));
    const sixHigh = evaluateHand(ids('6c', '5d', '4s', '3h', '2c'));
    expect(categoryOf(r)).toBe(HAND_CATEGORY.STRAIGHT);
    expect(r).toBe(sixHigh);
  });
});

// ============================================================
// TASK 4 — correct ordering across all 9 categories.
//
// One representative hand per category, asserted strictly increasing, including
// that the within-category encoding never collides across categories.
// ============================================================

describe('evaluator — strict ordering across all 9 categories', () => {
  it('high < pair < two-pair < trips < straight < flush < boat < quads < SF', () => {
    const reps: Record<string, CardId[]> = {
      high: ids('Ah', 'Jd', '8c', '5s', '2h'),
      pair: ids('Ah', 'Ad', 'Kc', '7s', '2h'),
      twoPair: ids('Ah', 'Ad', '5c', '5s', '2h'),
      trips: ids('7h', '7d', '7c', 'Ks', '2h'),
      straight: ids('9h', '8d', '7c', '6s', '5h'),
      flush: ids('Ah', 'Jh', '8h', '5h', '2h'),
      boat: ids('Qh', 'Qd', 'Qc', '4s', '4h'),
      quads: ids('9h', '9d', '9c', '9s', 'Kh'),
      straightFlush: ids('9h', '8h', '7h', '6h', '5h'),
    };
    const order = [
      'high', 'pair', 'twoPair', 'trips', 'straight',
      'flush', 'boat', 'quads', 'straightFlush',
    ];
    const cats = [
      HAND_CATEGORY.HIGH_CARD, HAND_CATEGORY.PAIR, HAND_CATEGORY.TWO_PAIR,
      HAND_CATEGORY.THREE_OF_A_KIND, HAND_CATEGORY.STRAIGHT, HAND_CATEGORY.FLUSH,
      HAND_CATEGORY.FULL_HOUSE, HAND_CATEGORY.FOUR_OF_A_KIND, HAND_CATEGORY.STRAIGHT_FLUSH,
    ];
    const ranks = order.map(k => evaluateHand(reps[k]));
    for (let i = 0; i < order.length; i++) {
      expect(categoryOf(ranks[i]), `${order[i]} category`).toBe(cats[i]);
    }
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i], `${order[i]} > ${order[i - 1]}`).toBeGreaterThan(ranks[i - 1]);
    }
  });
});
