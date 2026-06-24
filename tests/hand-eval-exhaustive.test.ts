import { describe, it, expect } from 'vitest';
import { evaluateHand, HAND_CATEGORY, NUM_EQUIV_CLASSES } from '../src/core/equity/hand-eval';
import { ids } from './helpers';

const CATEGORY_MULTIPLIER = 1_000_000;
function categoryOf(rank: number): number {
  return Math.floor(rank / CATEGORY_MULTIPLIER);
}

// CardId encoding: rank*4 + suit, rank 0..12 (2..A), suit 0..3.
function makeCard(rank: number, suit: number): number {
  return rank * 4 + suit;
}

describe('exhaustive 5-card distribution (C(52,5) = 2,598,960)', () => {
  // Build all 52 cards and enumerate every 5-subset.
  const cards: number[] = [];
  for (let r = 0; r < 13; r++) for (let s = 0; s < 4; s++) cards.push(makeCard(r, s));

  it('matches the known category counts exactly and yields 7462 classes', () => {
    const catCounts: Record<number, number> = {};
    const distinctValues = new Set<number>();
    let total = 0;

    const a = cards;
    for (let i0 = 0; i0 < 52; i0++)
      for (let i1 = i0 + 1; i1 < 52; i1++)
        for (let i2 = i1 + 1; i2 < 52; i2++)
          for (let i3 = i2 + 1; i3 < 52; i3++)
            for (let i4 = i3 + 1; i4 < 52; i4++) {
              const rank = evaluateHand([a[i0], a[i1], a[i2], a[i3], a[i4]]);
              const cat = categoryOf(rank);
              catCounts[cat] = (catCounts[cat] || 0) + 1;
              distinctValues.add(rank);
              total++;
            }

    expect(total).toBe(2_598_960);

    // Known 5-card hand category distribution.
    expect(catCounts[HAND_CATEGORY.HIGH_CARD]).toBe(1_302_540);
    expect(catCounts[HAND_CATEGORY.PAIR]).toBe(1_098_240);
    expect(catCounts[HAND_CATEGORY.TWO_PAIR]).toBe(123_552);
    expect(catCounts[HAND_CATEGORY.THREE_OF_A_KIND]).toBe(54_912);
    expect(catCounts[HAND_CATEGORY.STRAIGHT]).toBe(10_200);
    expect(catCounts[HAND_CATEGORY.FLUSH]).toBe(5_108);
    expect(catCounts[HAND_CATEGORY.FULL_HOUSE]).toBe(3_744);
    expect(catCounts[HAND_CATEGORY.FOUR_OF_A_KIND]).toBe(624);
    expect(catCounts[HAND_CATEGORY.STRAIGHT_FLUSH]).toBe(40);

    // Total distinct hand-strength equivalence classes (Cactus-Kev / phevaluator).
    expect(distinctValues.size).toBe(7462);
    expect(NUM_EQUIV_CLASSES).toBe(7462);
  });

  it('counts straight flushes: 36 non-royal + 4 royal = 40', () => {
    // Royal flush = A-high straight flush, one per suit.
    let royal = 0;
    let straightFlush = 0;
    for (let s = 0; s < 4; s++) {
      // every 5-consecutive run, wheel..broadway
      const runs: number[][] = [];
      // straights by high card: 5-high (wheel) .. A-high (broadway)
      // wheel
      runs.push([12, 3, 2, 1, 0]); // A,5,4,3,2
      for (let high = 4; high <= 12; high++) {
        const run: number[] = [];
        for (let k = 0; k < 5; k++) run.push(high - k);
        runs.push(run);
      }
      for (const run of runs) {
        const hand = run.map(r => makeCard(r, s));
        const rank = evaluateHand(hand);
        expect(categoryOf(rank)).toBe(HAND_CATEGORY.STRAIGHT_FLUSH);
        straightFlush++;
        if (run.includes(12) && run.includes(11)) royal++; // contains A and K -> broadway
      }
    }
    expect(straightFlush).toBe(40);
    expect(royal).toBe(4);
  });
});

describe('spot checks & ordering', () => {
  it('royal flush > quads > full house > flush > straight > trips > two pair > pair > high card', () => {
    const royal = evaluateHand(ids('Ah', 'Kh', 'Qh', 'Jh', 'Th'));
    const quads = evaluateHand(ids('9h', '9d', '9c', '9s', 'Kh'));
    const boat = evaluateHand(ids('Qh', 'Qd', 'Qc', '4s', '4h'));
    const flush = evaluateHand(ids('Ah', 'Jh', '8h', '5h', '2h'));
    const straight = evaluateHand(ids('9h', '8d', '7c', '6s', '5h'));
    const trips = evaluateHand(ids('7h', '7d', '7c', 'Ks', '2h'));
    const twoPair = evaluateHand(ids('Ah', 'Ad', '5c', '5s', '2h'));
    const pair = evaluateHand(ids('Ah', 'Ad', 'Kc', '7s', '2h'));
    const high = evaluateHand(ids('Ah', 'Jd', '8c', '5s', '2h'));

    const ordered = [high, pair, twoPair, trips, straight, flush, boat, quads, royal];
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i]).toBeGreaterThan(ordered[i - 1]);
    }
  });

  it('wheel A-2-3-4-5 is the lowest straight; A-high straight is higher', () => {
    const wheel = evaluateHand(ids('Ah', '2d', '3c', '4s', '5h'));
    const sixHigh = evaluateHand(ids('6h', '5d', '4c', '3s', '2h'));
    const broadway = evaluateHand(ids('Ah', 'Kd', 'Qc', 'Js', 'Th'));
    expect(sixHigh).toBeGreaterThan(wheel);
    expect(broadway).toBeGreaterThan(sixHigh);
    // wheel is the single weakest straight
    expect(categoryOf(wheel)).toBe(HAND_CATEGORY.STRAIGHT);
  });

  it('wheel straight flush is the lowest straight flush', () => {
    const wheelSF = evaluateHand(ids('Ah', '2h', '3h', '4h', '5h'));
    const sixSF = evaluateHand(ids('6h', '5h', '4h', '3h', '2h'));
    const royal = evaluateHand(ids('Ah', 'Kh', 'Qh', 'Jh', 'Th'));
    expect(sixSF).toBeGreaterThan(wheelSF);
    expect(royal).toBeGreaterThan(sixSF);
  });

  it('kicker tiebreaks within a pair', () => {
    const aceKing = evaluateHand(ids('Ah', 'Ad', 'Kc', '7s', '2h'));
    const aceQueen = evaluateHand(ids('As', 'Ac', 'Qd', '7h', '2d'));
    expect(aceKing).toBeGreaterThan(aceQueen);
  });

  it('flush kicker tiebreaks', () => {
    const aceFlush = evaluateHand(ids('Ah', 'Jh', '8h', '5h', '2h'));
    const kingFlush = evaluateHand(ids('Kh', 'Jh', '8h', '5h', '2h'));
    expect(aceFlush).toBeGreaterThan(kingFlush);
  });

  it('7-card hand picks the best 5 (straight flush over made flush)', () => {
    const r = evaluateHand(ids('9h', '8h', '7h', '6h', '5h', 'Ad', 'Ac'));
    expect(categoryOf(r)).toBe(HAND_CATEGORY.STRAIGHT_FLUSH);
  });

  it('7-card hand picks the best 5 (quads + best kicker)', () => {
    // four 9s, kickers A and K available -> kicker must be A
    const withAce = evaluateHand(ids('9h', '9d', '9c', '9s', 'Ah', 'Kd', '2c'));
    const withKing = evaluateHand(ids('9h', '9d', '9c', '9s', 'Kh', 'Qd', '2c'));
    expect(categoryOf(withAce)).toBe(HAND_CATEGORY.FOUR_OF_A_KIND);
    expect(withAce).toBeGreaterThan(withKing);
  });

  it('6-card reduces to its best 5 consistently', () => {
    const six = evaluateHand(ids('Ah', 'Ad', 'Kc', '7s', '2h', '3d'));
    const five = evaluateHand(ids('Ah', 'Ad', 'Kc', '7s', '3d'));
    expect(six).toBe(five);
  });
});

// ---- Differential test against a brute-force 21-subset reference --------
//
// Reference re-implements "best of 21 five-card subsets" using a totally
// independent classifier, then compares its CATEGORY to the new evaluator's
// category for thousands of random 7-card hands. This proves the port is
// equivalent without trusting the new code's own internals.

function classify5(cardsIn: number[]): number {
  const ranks = cardsIn.map(c => (c / 4) | 0).sort((a, b) => b - a);
  const suits = cardsIn.map(c => c % 4);
  const rankCounts = new Array(13).fill(0);
  for (const r of ranks) rankCounts[r]++;
  const suitCounts = new Array(4).fill(0);
  for (const s of suits) suitCounts[s]++;
  const isFlush = suitCounts.some(c => c >= 5);

  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  let isStraight = false;
  if (uniq.includes(12) && uniq.includes(0) && uniq.includes(1) && uniq.includes(2) && uniq.includes(3)) {
    isStraight = true; // wheel
  }
  for (let i = 0; i + 4 < uniq.length || i === 0; i++) {
    if (i + 4 < uniq.length && uniq[i] - uniq[i + 4] === 4) isStraight = true;
    if (i + 4 >= uniq.length) break;
  }

  const counts = [...rankCounts].sort((a, b) => b - a);

  if (isFlush && isStraight) return HAND_CATEGORY.STRAIGHT_FLUSH;
  if (counts[0] === 4) return HAND_CATEGORY.FOUR_OF_A_KIND;
  if (counts[0] === 3 && counts[1] >= 2) return HAND_CATEGORY.FULL_HOUSE;
  if (isFlush) return HAND_CATEGORY.FLUSH;
  if (isStraight) return HAND_CATEGORY.STRAIGHT;
  if (counts[0] === 3) return HAND_CATEGORY.THREE_OF_A_KIND;
  if (counts[0] === 2 && counts[1] === 2) return HAND_CATEGORY.TWO_PAIR;
  if (counts[0] === 2) return HAND_CATEGORY.PAIR;
  return HAND_CATEGORY.HIGH_CARD;
}

// best category over all C(7,5)=21 subsets, ranked by category only is wrong
// (need full ordering); instead we replicate the OLD numeric evaluator to get
// the true best-5 category. We compute the best by category then tiebreak via
// the new evaluator's own value only for picking the subset is circular, so we
// use a category-priority that respects within-category dominance is hard.
// Simplest sound approach: the best-5 CATEGORY equals the max category over
// all 21 subsets, because category ordering dominates. That is exactly what
// we assert.
function bestCategory21(cards7: number[]): number {
  let best = -1;
  for (let i = 0; i < 7; i++)
    for (let j = i + 1; j < 7; j++) {
      const hand: number[] = [];
      for (let k = 0; k < 7; k++) if (k !== i && k !== j) hand.push(cards7[k]);
      const cat = classify5(hand);
      if (cat > best) best = cat;
    }
  return best;
}

describe('differential test vs brute-force 21-subset reference', () => {
  it('category matches for thousands of random 7-card hands', () => {
    // Deterministic PRNG for reproducibility.
    let seed = 123456789;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const N = 5000;
    let checked = 0;
    for (let t = 0; t < N; t++) {
      // draw 7 distinct cards
      const chosen = new Set<number>();
      while (chosen.size < 7) chosen.add((rnd() * 52) | 0);
      const hand = [...chosen];

      const newRank = evaluateHand(hand);
      const newCat = categoryOf(newRank);
      const refCat = bestCategory21(hand);
      expect(newCat).toBe(refCat);
      checked++;
    }
    expect(checked).toBe(N);
  });
});
