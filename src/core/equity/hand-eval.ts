import { CardId } from '../../types/poker';
import {
  lookupValue,
  NUM_EQUIV_CLASSES,
  VALUE_TO_CATEGORY,
  VALUE_TO_ORDINAL,
} from './eval-tables';

// ============================================================
// Fast 5-7 Card Hand Evaluator (perfect-hash, lookup-based).
//
// Algorithm ported from phevaluator by Henry Lee,
//   Apache-2.0, https://github.com/HenryRLee/PokerHandEvaluator
//
// Internally we compute the phevaluator strength value (1 == best/royal
// flush .. 7462 == worst 7-high) via two perfect-hash lookups: a flush table
// keyed by the flush suit's 13-bit rank mask, and a rank table keyed by a
// DP perfect hash of the per-rank count ("quinary") vector. See
// eval-tables.ts for table construction and attribution.
//
// PUBLIC API is unchanged from the previous brute-force implementation:
//   evaluateHand(cards) -> number, HIGHER == better.
// We preserve the exact "category * 1e6 + tiebreaker" return shape so all
// existing callers (monte-carlo.ts, cfr-solver.ts) and tests keep working:
//   Math.floor(rank / 1_000_000) === HAND_CATEGORY.*
// ============================================================

export const HAND_CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  THREE_OF_A_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_OF_A_KIND: 7,
  STRAIGHT_FLUSH: 8,
} as const;

const CATEGORY_MULTIPLIER = 1_000_000;

// Map the internal Cat enum (see eval-tables.ts) to public HAND_CATEGORY.
// They share the same numeric values, but we keep an explicit map so the
// two files stay decoupled.
const INTERNAL_TO_PUBLIC: Record<number, number> = {
  0: HAND_CATEGORY.HIGH_CARD,
  1: HAND_CATEGORY.PAIR,
  2: HAND_CATEGORY.TWO_PAIR,
  3: HAND_CATEGORY.THREE_OF_A_KIND,
  4: HAND_CATEGORY.STRAIGHT,
  5: HAND_CATEGORY.FLUSH,
  6: HAND_CATEGORY.FULL_HOUSE,
  7: HAND_CATEGORY.FOUR_OF_A_KIND,
  8: HAND_CATEGORY.STRAIGHT_FLUSH,
};

/**
 * Evaluate the best 5-card hand from 5, 6, or 7 cards.
 * Returns a numeric rank: HIGHER == better hand, encoded as
 * `category * 1_000_000 + tiebreaker`. Ordering is consistent across
 * 5-, 6-, and 7-card inputs.
 */
export function evaluateHand(cards: CardId[]): number {
  const n = cards.length;
  if (n < 5 || n > 7) {
    throw new Error(`Cannot evaluate ${n} cards`);
  }

  // Build per-rank counts (quinary, index 0..12 == rank 2..A) and per-suit
  // rank masks so we can detect a 5+ flush.
  const quinary = new Array(13).fill(0);
  const suitMasks = [0, 0, 0, 0];
  const suitCounts = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    const r = (c / 4) | 0;
    const s = c % 4;
    quinary[r]++;
    suitMasks[s] |= 1 << r;
    suitCounts[s]++;
  }

  // A hand can have at most one suit with >=5 cards (5+5 > 7).
  let flushMask = -1;
  for (let s = 0; s < 4; s++) {
    if (suitCounts[s] >= 5) {
      flushMask = suitMasks[s];
      break;
    }
  }

  const value = lookupValue(quinary, n, flushMask); // 1..7462, lower == better
  return valueToPublicRank(value);
}

/**
 * Convert the internal phevaluator value (1=best..7462=worst) into the
 * project's public rank: `category * 1_000_000 + tiebreaker`, higher better.
 *
 * Within a category the internal ordinal (1 = weakest) IS the tiebreaker, so
 * it is bounded well under 1e6 (largest category has 1277 classes) and the
 * global ordering is preserved exactly.
 */
function valueToPublicRank(value: number): number {
  const cat = INTERNAL_TO_PUBLIC[VALUE_TO_CATEGORY[value]];
  const tiebreak = VALUE_TO_ORDINAL[value];
  return cat * CATEGORY_MULTIPLIER + tiebreak;
}

/**
 * Get hand category name for display.
 */
export function handCategoryName(rank: number): string {
  const category = Math.floor(rank / CATEGORY_MULTIPLIER);
  const names = [
    'High Card', 'Pair', 'Two Pair', 'Three of a Kind',
    'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
  ];
  return names[category] || 'Unknown';
}

/**
 * Compare two hand ranks. Returns positive if a > b, negative if a < b, 0 if equal.
 */
export function compareHands(a: number, b: number): number {
  return a - b;
}

// Re-export for tests/benchmarks that want the raw equivalence-class count.
export { NUM_EQUIV_CLASSES };
