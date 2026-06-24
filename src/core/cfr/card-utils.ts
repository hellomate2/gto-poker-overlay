import { Card, CardId, Rank, Suit } from '../../types/poker';

// ============================================================
// Card Encoding: rank * 4 + suit = 0..51
// Rank: 2=0, 3=1, ..., A=12
// Suit: h=0, d=1, c=2, s=3
// ============================================================

const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS: Suit[] = ['h', 'd', 'c', 's'];

const RANK_TO_INDEX: Record<Rank, number> = {
  '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6,
  '9': 7, 'T': 8, 'J': 9, 'Q': 10, 'K': 11, 'A': 12,
};

const SUIT_TO_INDEX: Record<Suit, number> = { h: 0, d: 1, c: 2, s: 3 };

export function cardToId(card: Card): CardId {
  return RANK_TO_INDEX[card.rank] * 4 + SUIT_TO_INDEX[card.suit];
}

export function idToCard(id: CardId): Card {
  return { rank: RANKS[Math.floor(id / 4)], suit: SUITS[id % 4] };
}

export function cardToString(card: Card): string {
  return `${card.rank}${card.suit}`;
}

export function parseCard(s: string): Card {
  return { rank: s[0] as Rank, suit: s[1] as Suit };
}

export function rankIndex(rank: Rank): number {
  return RANK_TO_INDEX[rank];
}

/** Create a full 52-card deck as card IDs */
export function createDeck(): CardId[] {
  const deck: CardId[] = [];
  for (let i = 0; i < 52; i++) deck.push(i);
  return deck;
}

/** Fisher-Yates shuffle in-place */
export function shuffleDeck(deck: CardId[]): CardId[] {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** Remove known cards from a deck */
export function removeCards(deck: CardId[], known: CardId[]): CardId[] {
  const knownSet = new Set(known);
  return deck.filter(c => !knownSet.has(c));
}

/** Get all 1326 possible 2-card combos */
export function allHoleCombos(): [CardId, CardId][] {
  const combos: [CardId, CardId][] = [];
  for (let i = 0; i < 52; i++) {
    for (let j = i + 1; j < 52; j++) {
      combos.push([i, j]);
    }
  }
  return combos;
}

/**
 * Convert two hole cards to a canonical "hand group" index (0-168).
 * Groups: pairs (13), suited (78), offsuit (78) = 169 total
 * Encoded as: higher_rank * 13 + lower_rank for offsuit/suited
 */
export function handGroupIndex(c1: CardId, c2: CardId): number {
  const r1 = Math.floor(c1 / 4);
  const r2 = Math.floor(c2 / 4);
  const s1 = c1 % 4;
  const s2 = c2 % 4;
  const high = Math.max(r1, r2);
  const low = Math.min(r1, r2);
  const suited = s1 === s2;

  if (high === low) {
    // Pair: index 0-12 (22 through AA)
    return high;
  } else if (suited) {
    // Suited: upper triangle, row = high, col = low
    return 13 + high * (high - 1) / 2 + low;
  } else {
    // Offsuit: lower triangle
    return 13 + 78 + high * (high - 1) / 2 + low;
  }
}

/**
 * Hand group name (e.g., "AKs", "QQ", "T9o")
 */
export function handGroupName(c1: CardId, c2: CardId): string {
  const r1 = Math.floor(c1 / 4);
  const r2 = Math.floor(c2 / 4);
  const s1 = c1 % 4;
  const s2 = c2 % 4;
  const high = Math.max(r1, r2);
  const low = Math.min(r1, r2);
  const highRank = RANKS[high];
  const lowRank = RANKS[low];

  if (high === low) return `${highRank}${lowRank}`;
  return `${highRank}${lowRank}${s1 === s2 ? 's' : 'o'}`;
}

/** Bit mask for a set of cards (64-bit via two 32-bit numbers is overkill, use bigint) */
export function cardSetMask(cards: CardId[]): bigint {
  let mask = 0n;
  for (const c of cards) mask |= 1n << BigInt(c);
  return mask;
}
