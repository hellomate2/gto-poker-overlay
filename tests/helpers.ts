import { Card, CardId, Rank, Suit } from '../src/types/poker';
import { cardToId } from '../src/core/cfr/card-utils';

/** Build a Card from a 2-char string like "Ah", "Td", "2c". */
export function card(s: string): Card {
  return { rank: s[0] as Rank, suit: s[1] as Suit };
}

/** Build a CardId from a 2-char string like "Ah". */
export function cid(s: string): CardId {
  return cardToId(card(s));
}

/** Build an array of CardIds from strings: ids('Ah', 'Kd'). */
export function ids(...ss: string[]): CardId[] {
  return ss.map(cid);
}
