import { describe, it, expect } from 'vitest';
import {
  cardToId,
  idToCard,
  parseCard,
  cardToString,
  rankIndex,
  createDeck,
  removeCards,
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

  it('rankIndex orders ranks from 2 (low) to A (high)', () => {
    expect(rankIndex('2')).toBe(0);
    expect(rankIndex('A')).toBe(12);
    expect(rankIndex('K')).toBe(11);
    expect(rankIndex('A')).toBeGreaterThan(rankIndex('K'));
    expect(rankIndex('T')).toBeGreaterThan(rankIndex('9'));
  });

  it('parseCard and cardToString are inverses', () => {
    for (const s of ['Ah', 'Kd', 'Tc', '2s', '9h']) {
      expect(cardToString(parseCard(s))).toBe(s);
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

  it('all 13 pairs map to indices 0..12', () => {
    const pairIdx = new Set<number>();
    for (const r of RANKS) {
      const idx = handGroupIndex(cardToId({ rank: r, suit: 'h' }), cardToId({ rank: r, suit: 'd' }));
      pairIdx.add(idx);
      expect(idx).toBeLessThan(13);
    }
    expect(pairIdx.size).toBe(13);
  });
});
