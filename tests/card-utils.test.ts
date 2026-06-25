import { describe, it, expect } from 'vitest';
import {
  cardToId,
  idToCard,
  parseCard,
  cardToString,
  rankIndex,
  createDeck,
  removeCards,
  shuffleDeck,
  cardSetMask,
  allHoleCombos,
  handGroupName,
  handGroupIndex,
} from '../src/core/cfr/card-utils';
import { Rank, Suit } from '../src/types/poker';
import { cid } from './helpers';

const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS: Suit[] = ['h', 'd', 'c', 's'];

describe('card encoding', () => {
  it('cardToId/idToCard round-trips for all 52 cards', () => {
    const seen = new Set<number>();
    for (const rank of RANKS) {
      for (const suit of SUITS) {
        const id = cardToId({ rank, suit });
        expect(id).toBeGreaterThanOrEqual(0);
        expect(id).toBeLessThan(52);
        expect(seen.has(id)).toBe(false); // every card maps to a unique id
        seen.add(id);
        const back = idToCard(id);
        expect(back.rank).toBe(rank);
        expect(back.suit).toBe(suit);
      }
    }
    expect(seen.size).toBe(52);
  });

  it('uses rank*4 + suit encoding (2h = 0, As = 51)', () => {
    expect(cardToId({ rank: '2', suit: 'h' })).toBe(0);
    expect(cardToId({ rank: 'A', suit: 's' })).toBe(51);
    expect(cardToId({ rank: 'A', suit: 'h' })).toBe(48);
  });

  it('rankIndex is strictly monotonic 2..A across ALL 13 ranks', () => {
    // Pin the full ordering, not just spot values — a transposition of two
    // interior ranks (e.g. 5<->6) would slip past 2=0/A=12 checks.
    expect(RANKS.map(rankIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (let i = 1; i < RANKS.length; i++) {
      expect(rankIndex(RANKS[i])).toBe(rankIndex(RANKS[i - 1]) + 1);
    }
  });

  it('parseCard and cardToString round-trip in BOTH directions for all 52 cards', () => {
    for (const rank of RANKS) {
      for (const suit of SUITS) {
        const s = `${rank}${suit}`;
        expect(cardToString(parseCard(s))).toBe(s);            // string -> card -> string
        const c = { rank, suit };
        expect(parseCard(cardToString(c))).toEqual(c);          // card -> string -> card
      }
    }
  });
});

describe('deck construction', () => {
  it('createDeck returns 52 unique ids covering 0..51', () => {
    const deck = createDeck();
    expect(deck.length).toBe(52);
    expect(new Set(deck).size).toBe(52);
    expect(Math.min(...deck)).toBe(0);
    expect(Math.max(...deck)).toBe(51);
  });

  it('removeCards strips known cards out of the deck', () => {
    const deck = createDeck();
    const known = [cid('Ah'), cid('Kd')];
    const remaining = removeCards(deck, known);
    expect(remaining.length).toBe(50);
    expect(remaining).not.toContain(cid('Ah'));
    expect(remaining).not.toContain(cid('Kd'));
  });

  it('removeCards edge cases: empty list, absent card, duplicate known id', () => {
    const deck = createDeck();
    expect(removeCards(deck, []).length).toBe(52);          // remove nothing
    // A duplicate in the known list still removes only that one slot.
    expect(removeCards(deck, [cid('Ah'), cid('Ah')]).length).toBe(51);
    // Removing the same id twice over an already-pruned deck is a no-op.
    const once = removeCards(deck, [cid('Ah')]);
    expect(removeCards(once, [cid('Ah')]).length).toBe(51);
  });

  it('shuffleDeck returns a permutation of the same 52 ids (in place)', () => {
    const deck = createDeck();
    const ref = new Set(deck);
    const out = shuffleDeck(deck);
    expect(out).toBe(deck);                 // mutates and returns the same array
    expect(out.length).toBe(52);
    expect(new Set(out)).toEqual(ref);      // exactly the same multiset, reordered
  });

  it('allHoleCombos enumerates exactly 1326 unique unordered pairs', () => {
    const combos = allHoleCombos();
    expect(combos.length).toBe(1326); // C(52,2)
    const keys = new Set(combos.map(([a, b]) => `${a}-${b}`));
    expect(keys.size).toBe(1326);
    // every combo is ordered low..high so each unordered pair appears once
    expect(combos.every(([a, b]) => a < b)).toBe(true);
  });
});

describe('hand group naming', () => {
  it('names suited, offsuit, and pairs correctly', () => {
    expect(handGroupName(cid('Ah'), cid('Kh'))).toBe('AKs');
    expect(handGroupName(cid('Ah'), cid('Kd'))).toBe('AKo');
    expect(handGroupName(cid('Ah'), cid('Ad'))).toBe('AA');
    expect(handGroupName(cid('Td'), cid('9d'))).toBe('T9s');
    expect(handGroupName(cid('7c'), cid('2h'))).toBe('72o');
  });

  it('is order-independent (high rank always first)', () => {
    expect(handGroupName(cid('Kh'), cid('Ah'))).toBe('AKs');
    expect(handGroupName(cid('9d'), cid('Td'))).toBe('T9s');
    expect(handGroupName(cid('2h'), cid('7c'))).toBe('72o');
  });

  it('handGroupIndex yields 169 distinct buckets across all combos', () => {
    const indices = new Set<number>();
    for (const [a, b] of allHoleCombos()) {
      const idx = handGroupIndex(a, b);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(169);
      indices.add(idx);
    }
    expect(indices.size).toBe(169); // 13 pairs + 78 suited + 78 offsuit
  });

  it('all 13 pairs map to EXACTLY the set {0..12}', () => {
    const pairIdx = RANKS.map(r =>
      handGroupIndex(cardToId({ rank: r, suit: 'h' }), cardToId({ rank: r, suit: 'd' })),
    ).sort((a, b) => a - b);
    // Exact set pins both bounds and the bijection; a {-1,0..11} bug would pass a
    // bare `<13` check but fail this.
    expect(pairIdx).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('handGroupIndex partitions into pairs [0,13), suited [13,91), offsuit [91,169)', () => {
    // Downstream strategy tables rely on this layout; a swapped suited/offsuit base
    // would still yield 169 distinct buckets but break the range semantics.
    for (const [a, b] of allHoleCombos()) {
      const idx = handGroupIndex(a, b);
      const r1 = Math.floor(a / 4), r2 = Math.floor(b / 4);
      const suited = a % 4 === b % 4;
      if (r1 === r2) expect(idx, 'pair < 13').toBeLessThan(13);
      else if (suited) {
        expect(idx, 'suited >= 13').toBeGreaterThanOrEqual(13);
        expect(idx, 'suited < 91').toBeLessThan(91);
      } else {
        expect(idx, 'offsuit >= 91').toBeGreaterThanOrEqual(91);
        expect(idx, 'offsuit < 169').toBeLessThan(169);
      }
    }
    // Spot-check the canonical corners.
    expect(handGroupIndex(cid('Ah'), cid('Kh'))).toBe(90);  // AKs (top of suited range)
    expect(handGroupIndex(cid('Ah'), cid('Kd'))).toBe(168); // AKo (top of offsuit range)
  });
});

describe('cardSetMask', () => {
  it('sets bit c for each card id', () => {
    expect(cardSetMask([cid('2h')])).toBe(1n);            // id 0 -> bit 0
    expect(cardSetMask([cid('As')])).toBe(1n << 51n);     // id 51 -> bit 51
  });

  it('ORs distinct cards and equals the OR of singletons', () => {
    const a = cid('Ah'), b = cid('Kd');
    expect(cardSetMask([a, b])).toBe((1n << BigInt(a)) | (1n << BigInt(b)));
  });

  it('a full deck mask has exactly 52 bits set (2^52 - 1)', () => {
    expect(cardSetMask(createDeck())).toBe((1n << 52n) - 1n);
  });

  it('the empty set is 0n', () => {
    expect(cardSetMask([])).toBe(0n);
  });
});
