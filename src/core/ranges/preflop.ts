// ============================================================
// GTO Preflop Ranges for 6-max NLHE
// Each range is a 13x13 matrix (higher rank rows, lower rank cols)
// Upper triangle = suited, diagonal = pairs, lower triangle = offsuit
// Values are frequencies 0-1 (1 = always play, 0 = never)
// ============================================================

// Hand notation: rows = first rank (A=0, K=1, ..., 2=12), cols = second rank
// Matrix[row][col] where row >= col means offsuit/pair, row < col means suited

export type RangeMatrix = number[][];

/** Create empty 13x13 range */
function emptyRange(): RangeMatrix {
  return Array.from({ length: 13 }, () => new Array(13).fill(0));
}

/** Rank index for range matrix: A=0, K=1, Q=2, ..., 2=12 */
function ri(rank: string): number {
  const map: Record<string, number> = {
    A: 0, K: 1, Q: 2, J: 3, T: 4, '9': 5, '8': 6, '7': 7, '6': 8, '5': 9, '4': 10, '3': 11, '2': 12,
  };
  return map[rank];
}

/** Parse a hand list into a range matrix. Format: "AKs:1,AQs:0.8,QQ:1,ATo:0.5" */
function parseRange(hands: string): RangeMatrix {
  const range = emptyRange();
  for (const entry of hands.split(',')) {
    const [hand, freqStr] = entry.trim().split(':');
    const freq = parseFloat(freqStr);
    if (hand.length === 2) {
      // Pair: e.g., "AA", "KK"
      const r = ri(hand[0]);
      range[r][r] = freq;
    } else if (hand[2] === 's') {
      // Suited: store in upper triangle (row < col would be weird, use row=high, col=low for suited)
      const r1 = ri(hand[0]); // higher rank = lower index
      const r2 = ri(hand[1]);
      const high = Math.min(r1, r2); // lower index = higher rank
      const low = Math.max(r1, r2);
      range[high][low] = freq; // upper triangle: row < col (but we use row=high_rank_idx, col=low_rank_idx)
      // Actually let's use: suited = range[row][col] where row < col
      // Offsuit = range[row][col] where row > col
      // Pair = range[row][col] where row === col
      // With row = higher rank index (lower number), col = lower rank index (higher number)
      // So AKs: row=0(A), col=1(K), and row < col → suited ✓
      // AKo: row=1(K), col=0(A)? No, let's standardize:
      // range[smaller_index][larger_index] = suited
      // range[larger_index][smaller_index] = offsuit
      range[Math.min(r1, r2)][Math.max(r1, r2)] = freq;
    } else {
      // Offsuit
      const r1 = ri(hand[0]);
      const r2 = ri(hand[1]);
      range[Math.max(r1, r2)][Math.min(r1, r2)] = freq;
    }
  }
  return range;
}

// ============================================================
// 6-Max GTO Open Raising Ranges (RFI) by Position
// Frequencies represent raise-first-in percentages
// ============================================================

export const RFI_RANGES: Record<string, RangeMatrix> = {
  // UTG (Under the Gun) - ~15% of hands
  UTG: parseRange([
    'AA:1,KK:1,QQ:1,JJ:1,TT:1,99:1,88:0.8,77:0.5',
    'AKs:1,AQs:1,AJs:1,ATs:1,A9s:0.5,A5s:0.5,A4s:0.5',
    'KQs:1,KJs:1,KTs:0.7',
    'QJs:1,QTs:0.7',
    'JTs:1,J9s:0.3',
    'T9s:0.7,98s:0.5,87s:0.3,76s:0.3',
    'AKo:1,AQo:1,AJo:0.7',
    'KQo:0.5',
  ].join(',')),

  // MP (Middle Position) - ~18% of hands
  MP: parseRange([
    'AA:1,KK:1,QQ:1,JJ:1,TT:1,99:1,88:1,77:0.7,66:0.5',
    'AKs:1,AQs:1,AJs:1,ATs:1,A9s:0.7,A8s:0.5,A5s:0.7,A4s:0.6,A3s:0.5',
    'KQs:1,KJs:1,KTs:1,K9s:0.3',
    'QJs:1,QTs:1,Q9s:0.3',
    'JTs:1,J9s:0.5',
    'T9s:1,98s:0.7,87s:0.5,76s:0.5,65s:0.3',
    'AKo:1,AQo:1,AJo:1,ATo:0.5',
    'KQo:0.7,KJo:0.3',
  ].join(',')),

  // CO (Cutoff) - ~27% of hands
  CO: parseRange([
    'AA:1,KK:1,QQ:1,JJ:1,TT:1,99:1,88:1,77:1,66:1,55:0.7,44:0.5',
    'AKs:1,AQs:1,AJs:1,ATs:1,A9s:1,A8s:1,A7s:0.8,A6s:0.7,A5s:1,A4s:1,A3s:0.8,A2s:0.7',
    'KQs:1,KJs:1,KTs:1,K9s:0.8,K8s:0.5,K7s:0.3',
    'QJs:1,QTs:1,Q9s:0.8,Q8s:0.3',
    'JTs:1,J9s:1,J8s:0.5',
    'T9s:1,T8s:0.7,98s:1,97s:0.5,87s:1,86s:0.3,76s:0.8,75s:0.3,65s:0.7,54s:0.5',
    'AKo:1,AQo:1,AJo:1,ATo:1,A9o:0.5,A8o:0.3',
    'KQo:1,KJo:0.8,KTo:0.5',
    'QJo:0.7,QTo:0.3',
    'JTo:0.5',
  ].join(',')),

  // BTN (Button) - ~40% of hands
  BTN: parseRange([
    'AA:1,KK:1,QQ:1,JJ:1,TT:1,99:1,88:1,77:1,66:1,55:1,44:1,33:0.7,22:0.7',
    'AKs:1,AQs:1,AJs:1,ATs:1,A9s:1,A8s:1,A7s:1,A6s:1,A5s:1,A4s:1,A3s:1,A2s:1',
    'KQs:1,KJs:1,KTs:1,K9s:1,K8s:1,K7s:0.8,K6s:0.7,K5s:0.5,K4s:0.5',
    'QJs:1,QTs:1,Q9s:1,Q8s:0.8,Q7s:0.5,Q6s:0.3',
    'JTs:1,J9s:1,J8s:0.8,J7s:0.5',
    'T9s:1,T8s:1,T7s:0.5,98s:1,97s:0.8,96s:0.3,87s:1,86s:0.5,76s:1,75s:0.5,65s:1,64s:0.3,54s:1,53s:0.3,43s:0.3',
    'AKo:1,AQo:1,AJo:1,ATo:1,A9o:1,A8o:0.7,A7o:0.5,A6o:0.3,A5o:0.5,A4o:0.3',
    'KQo:1,KJo:1,KTo:1,K9o:0.5,K8o:0.3',
    'QJo:1,QTo:0.8,Q9o:0.3',
    'JTo:1,J9o:0.5',
    'T9o:0.5,98o:0.3',
  ].join(',')),

  // SB (Small Blind) - ~35% of hands (open raise or fold)
  SB: parseRange([
    'AA:1,KK:1,QQ:1,JJ:1,TT:1,99:1,88:1,77:1,66:1,55:0.8,44:0.7,33:0.5,22:0.5',
    'AKs:1,AQs:1,AJs:1,ATs:1,A9s:1,A8s:1,A7s:1,A6s:1,A5s:1,A4s:1,A3s:1,A2s:1',
    'KQs:1,KJs:1,KTs:1,K9s:1,K8s:0.8,K7s:0.7,K6s:0.5,K5s:0.5,K4s:0.3',
    'QJs:1,QTs:1,Q9s:0.8,Q8s:0.5,Q7s:0.3',
    'JTs:1,J9s:1,J8s:0.5,J7s:0.3',
    'T9s:1,T8s:0.8,98s:1,97s:0.5,87s:1,86s:0.3,76s:0.8,75s:0.3,65s:0.8,54s:0.5,43s:0.3',
    'AKo:1,AQo:1,AJo:1,ATo:1,A9o:0.7,A8o:0.5,A7o:0.3,A5o:0.3',
    'KQo:1,KJo:1,KTo:0.7,K9o:0.3',
    'QJo:0.8,QTo:0.5',
    'JTo:0.7,J9o:0.3',
    'T9o:0.3',
  ].join(',')),
};

// ============================================================
// 3-Bet Ranges (vs open raise)
// ============================================================

export const THREE_BET_RANGES: Record<string, RangeMatrix> = {
  // 3-bet from BB vs BTN open
  BB_vs_BTN: parseRange([
    'AA:1,KK:1,QQ:1,JJ:1,TT:0.5,99:0.3',
    'AKs:1,AQs:1,AJs:0.8,ATs:0.5,A9s:0.3,A5s:0.7,A4s:0.5,A3s:0.3',
    'KQs:0.7,KJs:0.5,KTs:0.3',
    'QJs:0.3',
    'AKo:1,AQo:0.7,AJo:0.3',
    'KQo:0.3',
  ].join(',')),

  // 3-bet from CO vs MP open
  CO_vs_MP: parseRange([
    'AA:1,KK:1,QQ:1,JJ:0.8,TT:0.3',
    'AKs:1,AQs:1,AJs:0.5,A5s:0.5,A4s:0.3',
    'KQs:0.5',
    'AKo:1,AQo:0.5',
  ].join(',')),

  // 3-bet from BTN vs CO open
  BTN_vs_CO: parseRange([
    'AA:1,KK:1,QQ:1,JJ:0.7,TT:0.3',
    'AKs:1,AQs:1,AJs:0.6,ATs:0.3,A5s:0.5,A4s:0.3',
    'KQs:0.6,KJs:0.3',
    'QJs:0.3',
    'AKo:1,AQo:0.6,AJo:0.3',
  ].join(',')),
};

// ============================================================
// Range Utilities
// ============================================================

import { CardId, Card, Rank } from '../../types/poker';
import { rankIndex } from '../cfr/card-utils';

/**
 * Look up the frequency for a specific hand in a range matrix
 */
export function getHandFrequency(range: RangeMatrix, c1: CardId, c2: CardId): number {
  // Convert card IDs to range matrix indices
  const r1 = Math.floor(c1 / 4);
  const r2 = Math.floor(c2 / 4);
  const s1 = c1 % 4;
  const s2 = c2 % 4;

  // Map from card rank (2=0..A=12) to matrix index (A=0..2=12)
  const mi1 = 12 - r1;
  const mi2 = 12 - r2;
  const suited = s1 === s2;

  if (mi1 === mi2) {
    // Pair
    return range[mi1][mi2];
  } else if (suited) {
    // Suited: upper triangle (smaller index first)
    return range[Math.min(mi1, mi2)][Math.max(mi1, mi2)];
  } else {
    // Offsuit: lower triangle (larger index first)
    return range[Math.max(mi1, mi2)][Math.min(mi1, mi2)];
  }
}

/**
 * Convert a range matrix to a list of hand combos with their weights
 */
export function rangeToHandList(range: RangeMatrix, deadCards: CardId[] = []): { hand: [CardId, CardId]; weight: number }[] {
  const dead = new Set(deadCards);
  const hands: { hand: [CardId, CardId]; weight: number }[] = [];

  for (let c1 = 0; c1 < 52; c1++) {
    if (dead.has(c1)) continue;
    for (let c2 = c1 + 1; c2 < 52; c2++) {
      if (dead.has(c2)) continue;
      const freq = getHandFrequency(range, c1, c2);
      if (freq > 0) {
        hands.push({ hand: [c1, c2], weight: freq });
      }
    }
  }

  return hands;
}
