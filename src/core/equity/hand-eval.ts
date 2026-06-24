import { CardId } from '../../types/poker';

// ============================================================
// Fast 5-7 Card Hand Evaluator
// Uses a rank-based evaluation with bit manipulation.
// Returns a numeric hand rank where higher = better.
// Hand categories: 0=High Card, 1=Pair, 2=TwoPair, 3=Trips,
//   4=Straight, 5=Flush, 6=FullHouse, 7=Quads, 8=StraightFlush
// Final rank = category * 10^6 + tiebreaker
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

/**
 * Evaluate the best 5-card hand from up to 7 cards.
 * Returns a numeric rank: higher = better hand.
 */
export function evaluateHand(cards: CardId[]): number {
  if (cards.length === 5) return evaluate5(cards);
  if (cards.length === 6) return bestOf6(cards);
  if (cards.length === 7) return bestOf7(cards);
  throw new Error(`Cannot evaluate ${cards.length} cards`);
}

function bestOf7(cards: CardId[]): number {
  let best = 0;
  // C(7,5) = 21 combinations
  for (let i = 0; i < 7; i++) {
    for (let j = i + 1; j < 7; j++) {
      // Exclude cards[i] and cards[j]
      const hand: CardId[] = [];
      for (let k = 0; k < 7; k++) {
        if (k !== i && k !== j) hand.push(cards[k]);
      }
      const rank = evaluate5(hand);
      if (rank > best) best = rank;
    }
  }
  return best;
}

function bestOf6(cards: CardId[]): number {
  let best = 0;
  for (let i = 0; i < 6; i++) {
    const hand: CardId[] = [];
    for (let j = 0; j < 6; j++) {
      if (j !== i) hand.push(cards[j]);
    }
    const rank = evaluate5(hand);
    if (rank > best) best = rank;
  }
  return best;
}

function evaluate5(cards: CardId[]): number {
  // Extract ranks and suits
  const ranks = cards.map(c => Math.floor(c / 4)).sort((a, b) => b - a);
  const suits = cards.map(c => c % 4);

  // Count ranks
  const rankCounts = new Array(13).fill(0);
  for (const r of ranks) rankCounts[r]++;

  // Check flush
  const suitCounts = new Array(4).fill(0);
  for (const s of suits) suitCounts[s]++;
  const isFlush = suitCounts.some(c => c >= 5);

  // Check straight
  const straightHigh = findStraight(ranks);
  const isStraight = straightHigh >= 0;

  // Straight flush
  if (isFlush && isStraight) {
    // Verify the straight cards are all same suit
    const flushSuit = suitCounts.findIndex(c => c >= 5);
    const flushCards = cards.filter(c => c % 4 === flushSuit).map(c => Math.floor(c / 4)).sort((a, b) => b - a);
    const sfHigh = findStraight(flushCards);
    if (sfHigh >= 0) {
      return HAND_CATEGORY.STRAIGHT_FLUSH * CATEGORY_MULTIPLIER + sfHigh;
    }
  }

  // Collect groups: [count, rank] sorted by count desc, rank desc
  const groups: [number, number][] = [];
  for (let r = 12; r >= 0; r--) {
    if (rankCounts[r] > 0) groups.push([rankCounts[r], r]);
  }
  groups.sort((a, b) => b[0] - a[0] || b[1] - a[1]);

  // Four of a kind
  if (groups[0][0] === 4) {
    return HAND_CATEGORY.FOUR_OF_A_KIND * CATEGORY_MULTIPLIER +
      groups[0][1] * 13 + groups[1][1];
  }

  // Full house
  if (groups[0][0] === 3 && groups[1][0] >= 2) {
    return HAND_CATEGORY.FULL_HOUSE * CATEGORY_MULTIPLIER +
      groups[0][1] * 13 + groups[1][1];
  }

  // Flush
  if (isFlush) {
    const flushSuit = suitCounts.findIndex(c => c >= 5);
    const flushRanks = cards.filter(c => c % 4 === flushSuit)
      .map(c => Math.floor(c / 4)).sort((a, b) => b - a).slice(0, 5);
    return HAND_CATEGORY.FLUSH * CATEGORY_MULTIPLIER + ranksToTiebreaker(flushRanks);
  }

  // Straight
  if (isStraight) {
    return HAND_CATEGORY.STRAIGHT * CATEGORY_MULTIPLIER + straightHigh;
  }

  // Three of a kind
  if (groups[0][0] === 3) {
    const kickers = groups.filter(g => g[0] < 3).map(g => g[1]).slice(0, 2);
    return HAND_CATEGORY.THREE_OF_A_KIND * CATEGORY_MULTIPLIER +
      groups[0][1] * 169 + kickers[0] * 13 + (kickers[1] || 0);
  }

  // Two pair
  if (groups[0][0] === 2 && groups[1][0] === 2) {
    const highPair = Math.max(groups[0][1], groups[1][1]);
    const lowPair = Math.min(groups[0][1], groups[1][1]);
    const kicker = groups.find(g => g[0] === 1)?.[1] || 0;
    return HAND_CATEGORY.TWO_PAIR * CATEGORY_MULTIPLIER +
      highPair * 169 + lowPair * 13 + kicker;
  }

  // Pair
  if (groups[0][0] === 2) {
    const kickers = groups.filter(g => g[0] === 1).map(g => g[1]).slice(0, 3);
    return HAND_CATEGORY.PAIR * CATEGORY_MULTIPLIER +
      groups[0][1] * 2197 + kickers[0] * 169 + (kickers[1] || 0) * 13 + (kickers[2] || 0);
  }

  // High card
  return HAND_CATEGORY.HIGH_CARD * CATEGORY_MULTIPLIER + ranksToTiebreaker(ranks.slice(0, 5));
}

/** Find highest straight top-card from sorted (desc) rank array. Returns -1 if no straight. */
function findStraight(sortedRanks: number[]): number {
  const unique = [...new Set(sortedRanks)].sort((a, b) => b - a);

  // Check for A-2-3-4-5 (wheel)
  // A=12, 5=3, 4=2, 3=1, 2=0
  if (unique.includes(12) && unique.includes(0) && unique.includes(1) &&
      unique.includes(2) && unique.includes(3)) {
    return 3; // 5-high straight
  }

  for (let i = 0; i <= unique.length - 5; i++) {
    if (unique[i] - unique[i + 4] === 4) {
      return unique[i];
    }
  }
  return -1;
}

function ranksToTiebreaker(ranks: number[]): number {
  let val = 0;
  for (let i = 0; i < ranks.length; i++) {
    val = val * 13 + ranks[i];
  }
  return val;
}

/**
 * Get hand category name for display
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
