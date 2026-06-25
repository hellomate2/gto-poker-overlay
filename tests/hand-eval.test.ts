import { describe, it, expect } from 'vitest';
import {
  evaluateHand,
  handCategoryName,
  compareHands,
  HAND_CATEGORY,
} from '../src/core/equity/hand-eval';
import { ids } from './helpers';

const CATEGORY_MULTIPLIER = 1_000_000;
function categoryOf(rank: number): number {
  return Math.floor(rank / CATEGORY_MULTIPLIER);
}

describe('hand category detection (5 cards)', () => {
  it('detects a royal/straight flush', () => {
    const r = evaluateHand(ids('Ah', 'Kh', 'Qh', 'Jh', 'Th'));
    expect(categoryOf(r)).toBe(HAND_CATEGORY.STRAIGHT_FLUSH);
    expect(handCategoryName(r)).toBe('Straight Flush');
  });

  it('detects four of a kind', () => {
    const r = evaluateHand(ids('9h', '9d', '9c', '9s', 'Kh'));
    expect(categoryOf(r)).toBe(HAND_CATEGORY.FOUR_OF_A_KIND);
  });

  it('detects a full house', () => {
    const r = evaluateHand(ids('Qh', 'Qd', 'Qc', '4s', '4h'));
    expect(categoryOf(r)).toBe(HAND_CATEGORY.FULL_HOUSE);
  });

  it('detects a flush', () => {
    const r = evaluateHand(ids('Ah', 'Jh', '8h', '5h', '2h'));
    expect(categoryOf(r)).toBe(HAND_CATEGORY.FLUSH);
  });

  it('detects a straight', () => {
    const r = evaluateHand(ids('9h', '8d', '7c', '6s', '5h'));
    expect(categoryOf(r)).toBe(HAND_CATEGORY.STRAIGHT);
  });

  it('detects the wheel (A-2-3-4-5) as a straight', () => {
    const r = evaluateHand(ids('Ah', '2d', '3c', '4s', '5h'));
    expect(categoryOf(r)).toBe(HAND_CATEGORY.STRAIGHT);
  });

  it('detects three of a kind', () => {
    const r = evaluateHand(ids('7h', '7d', '7c', 'Ks', '2h'));
    expect(categoryOf(r)).toBe(HAND_CATEGORY.THREE_OF_A_KIND);
  });

  it('detects two pair', () => {
    const r = evaluateHand(ids('Ah', 'Ad', '5c', '5s', '2h'));
    expect(categoryOf(r)).toBe(HAND_CATEGORY.TWO_PAIR);
  });

  it('detects a single pair', () => {
    const r = evaluateHand(ids('Ah', 'Ad', 'Kc', '7s', '2h'));
    expect(categoryOf(r)).toBe(HAND_CATEGORY.PAIR);
  });

  it('detects high card', () => {
    const r = evaluateHand(ids('Ah', 'Jd', '8c', '5s', '2h'));
    expect(categoryOf(r)).toBe(HAND_CATEGORY.HIGH_CARD);
  });
});

describe('hand ranking ordering', () => {
  it('royal flush beats a pair AND is the top straight flush', () => {
    const royal = evaluateHand(ids('Ah', 'Kh', 'Qh', 'Jh', 'Th'));
    const pair = evaluateHand(ids('Ah', 'Ad', 'Kc', '7s', '2h'));
    const kingSF = evaluateHand(ids('Kh', 'Qh', 'Jh', 'Th', '9h'));
    expect(royal).toBeGreaterThan(pair);
    expect(compareHands(royal, pair)).toBeGreaterThan(0);
    // A mere "beats a pair" check passes even if the royal were mis-evaluated as a
    // plain flush/straight. Pin that it is actually the strongest straight flush.
    expect(categoryOf(royal)).toBe(HAND_CATEGORY.STRAIGHT_FLUSH);
    expect(royal).toBeGreaterThan(kingSF);
  });

  it('respects the full hand hierarchy', () => {
    const highCard = evaluateHand(ids('Ah', 'Jd', '8c', '5s', '2h'));
    const pair = evaluateHand(ids('Ah', 'Ad', 'Kc', '7s', '2h'));
    const twoPair = evaluateHand(ids('Ah', 'Ad', '5c', '5s', '2h'));
    const trips = evaluateHand(ids('7h', '7d', '7c', 'Ks', '2h'));
    const straight = evaluateHand(ids('9h', '8d', '7c', '6s', '5h'));
    const flush = evaluateHand(ids('Ah', 'Jh', '8h', '5h', '2h'));
    const fullHouse = evaluateHand(ids('Qh', 'Qd', 'Qc', '4s', '4h'));
    const quads = evaluateHand(ids('9h', '9d', '9c', '9s', 'Kh'));
    const straightFlush = evaluateHand(ids('9h', '8h', '7h', '6h', '5h'));

    const ordered = [highCard, pair, twoPair, trips, straight, flush, fullHouse, quads, straightFlush];
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i]).toBeGreaterThan(ordered[i - 1]);
    }
  });

  it('breaks ties by kicker (AK beats AQ on same pair)', () => {
    const aceKing = evaluateHand(ids('Ah', 'Ad', 'Kc', '7s', '2h'));
    const aceQueen = evaluateHand(ids('As', 'Ac', 'Qd', '7h', '2d'));
    expect(aceKing).toBeGreaterThan(aceQueen);
  });

  it('higher straight beats lower straight', () => {
    const broadway = evaluateHand(ids('Ah', 'Kd', 'Qc', 'Js', 'Th'));
    const sixHigh = evaluateHand(ids('6h', '5d', '4c', '3s', '2h'));
    expect(broadway).toBeGreaterThan(sixHigh);
  });

  it('wheel straight loses to a six-high straight', () => {
    const wheel = evaluateHand(ids('Ah', '2d', '3c', '4s', '5h'));
    const sixHigh = evaluateHand(ids('6h', '5d', '4c', '3s', '2h'));
    expect(sixHigh).toBeGreaterThan(wheel);
  });
});

describe('best-of-N selection', () => {
  it('finds the flush among 7 cards', () => {
    // 5 hearts present plus two off-suit cards
    const r = evaluateHand(ids('Ah', 'Kh', '8h', '5h', '2h', 'Qs', 'Jd'));
    expect(categoryOf(r)).toBe(HAND_CATEGORY.FLUSH);
  });

  it('picks the straight flush over a lower-category hand in 7 cards', () => {
    const r = evaluateHand(ids('9h', '8h', '7h', '6h', '5h', 'Ad', 'Ac'));
    expect(categoryOf(r)).toBe(HAND_CATEGORY.STRAIGHT_FLUSH);
  });

  it('matches the equivalent best 5-card hand from 6 cards', () => {
    const six = evaluateHand(ids('Ah', 'Ad', 'Kc', '7s', '2h', '3d'));
    const five = evaluateHand(ids('Ah', 'Ad', 'Kc', '7s', '3d'));
    expect(six).toBe(five);
  });

  it('throws on an invalid card count (too few and too many)', () => {
    expect(() => evaluateHand(ids('Ah', 'Kd'))).toThrow();                       // 2
    expect(() => evaluateHand(ids('Ah', 'Kd', 'Qc', 'Js'))).toThrow();          // 4
    expect(() => evaluateHand(ids('Ah', 'Kd', 'Qc', 'Js', 'Th', '9h', '8c', '7d'))).toThrow(); // 8
    expect(() => evaluateHand(ids('Ah', 'Kd', 'Qc', 'Js', 'Th', '9h'))).not.toThrow();         // 6 ok
  });
});

describe('handCategoryName & compareHands helpers', () => {
  // One representative hand per category, paired with its expected display name.
  const fixtures: Array<[string, number[], string]> = [
    ['high card', ids('Ah', 'Jd', '8c', '5s', '2h'), 'High Card'],
    ['pair', ids('Ah', 'Ad', 'Kc', '7s', '2h'), 'Pair'],
    ['two pair', ids('Ah', 'Ad', '5c', '5s', '2h'), 'Two Pair'],
    ['trips', ids('7h', '7d', '7c', 'Ks', '2h'), 'Three of a Kind'],
    ['straight', ids('9h', '8d', '7c', '6s', '5h'), 'Straight'],
    ['flush', ids('Ah', 'Jh', '8h', '5h', '2h'), 'Flush'],
    ['full house', ids('Qh', 'Qd', 'Qc', '4s', '4h'), 'Full House'],
    ['quads', ids('9h', '9d', '9c', '9s', 'Kh'), 'Four of a Kind'],
    ['straight flush', ids('9h', '8h', '7h', '6h', '5h'), 'Straight Flush'],
  ];

  it('handCategoryName returns the correct label for all nine categories', () => {
    for (const [, hand, name] of fixtures) {
      expect(handCategoryName(evaluateHand(hand))).toBe(name);
    }
  });

  it('handCategoryName returns "Unknown" for an out-of-range category', () => {
    expect(handCategoryName(99 * 1_000_000)).toBe('Unknown');
  });

  it('compareHands gives sign of a-b (positive, negative, and zero)', () => {
    const royal = evaluateHand(ids('Ah', 'Kh', 'Qh', 'Jh', 'Th'));
    const pair = evaluateHand(ids('Ah', 'Ad', 'Kc', '7s', '2h'));
    expect(compareHands(royal, pair)).toBeGreaterThan(0);
    expect(compareHands(pair, royal)).toBeLessThan(0);
    expect(compareHands(pair, pair)).toBe(0);
  });
});
