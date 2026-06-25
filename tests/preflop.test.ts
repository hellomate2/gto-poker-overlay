import { describe, it, expect } from 'vitest';
import {
  RFI_RANGES,
  THREE_BET_RANGES,
  getHandFrequency,
  rangeToHandList,
} from '../src/core/ranges/preflop';
import { cid } from './helpers';

describe('RFI range tables', () => {
  it('defines exactly the five 6-max RFI positions as 13x13 matrices (no BB RFI)', () => {
    // RFI is "raise first in" — the BB has no RFI spot (it has already posted and
    // either checks or 3-bets), so there are five positions, not six.
    expect(Object.keys(RFI_RANGES).sort()).toEqual(['BTN', 'CO', 'MP', 'SB', 'UTG']);
    expect(RFI_RANGES['BB']).toBeUndefined();
    for (const pos of Object.keys(RFI_RANGES)) {
      expect(RFI_RANGES[pos].length).toBe(13);
      for (const row of RFI_RANGES[pos]) expect(row.length).toBe(13);
    }
  });

  it('always opens AA from every position', () => {
    for (const pos of Object.keys(RFI_RANGES)) {
      const freq = getHandFrequency(RFI_RANGES[pos], cid('Ah'), cid('Ad'));
      expect(freq).toBe(1);
    }
  });

  it('UTG never opens 72o, but BTN range is much wider than UTG', () => {
    const utg72o = getHandFrequency(RFI_RANGES.UTG, cid('7c'), cid('2h'));
    expect(utg72o).toBe(0);

    const utgCount = rangeToHandList(RFI_RANGES.UTG).length;
    const btnCount = rangeToHandList(RFI_RANGES.BTN).length;
    expect(btnCount).toBeGreaterThan(utgCount);
  });

  it('open width widens monotonically by position (UTG < MP < CO < BTN; SB > CO)', () => {
    // The product's core claim: later positions open wider. Pins the ordering so a
    // regression that, say, made MP wider than CO is caught.
    const w = (p: string) => rangeToHandList(RFI_RANGES[p]).length;
    expect(w('UTG')).toBeLessThan(w('MP'));
    expect(w('MP')).toBeLessThan(w('CO'));
    expect(w('CO')).toBeLessThan(w('BTN'));
    // SB opens a wide steal/complete range — wider than CO, narrower than BTN.
    expect(w('SB')).toBeGreaterThan(w('CO'));
    expect(w('SB')).toBeLessThan(w('BTN'));
  });

  it('truly distinguishes suited from offsuit (strict, both directions)', () => {
    // The interesting case is a hand the table treats DIFFERENTLY by suitedness.
    // BTN T9s = 1.0, T9o = 0.5  -> strict inequality (not just >=).
    const t9s = getHandFrequency(RFI_RANGES.BTN, cid('Td'), cid('9d'));
    const t9o = getHandFrequency(RFI_RANGES.BTN, cid('Td'), cid('9c'));
    expect(t9s).toBe(1);
    expect(t9o).toBe(0.5);
    expect(t9s).toBeGreaterThan(t9o);
    // 65s is a full BTN open; 65o is a pure fold — proves the suited (upper) and
    // offsuit (lower) triangles route independently.
    expect(getHandFrequency(RFI_RANGES.BTN, cid('6h'), cid('5h'))).toBe(1);
    expect(getHandFrequency(RFI_RANGES.BTN, cid('6h'), cid('5d'))).toBe(0);
  });

  it('pins representative fractional + zero frequencies (catches a mis-typed chart cell)', () => {
    // The product's value IS these mixed frequencies; without pinning a few, a
    // typo flipping 88:0.8 -> 0.08, or dropping a hand, passes the whole suite.
    expect(getHandFrequency(RFI_RANGES.UTG, cid('8c'), cid('8d'))).toBe(0.8); // UTG 88
    expect(getHandFrequency(RFI_RANGES.UTG, cid('7c'), cid('7d'))).toBe(0.5); // UTG 77
    expect(getHandFrequency(RFI_RANGES.UTG, cid('Ah'), cid('9h'))).toBe(0.5); // UTG A9s
    expect(getHandFrequency(RFI_RANGES.BTN, cid('3c'), cid('3d'))).toBe(0.7); // BTN 33
    expect(getHandFrequency(RFI_RANGES.CO, cid('5c'), cid('5d'))).toBe(0.7);  // CO 55
    // Out-of-range hands are exactly 0.
    expect(getHandFrequency(RFI_RANGES.UTG, cid('2c'), cid('2d'))).toBe(0);   // UTG 22
    expect(getHandFrequency(RFI_RANGES.BTN, cid('7c'), cid('2d'))).toBe(0);   // BTN 72o
  });

  it('getHandFrequency is order-independent for suited, offsuit, and pairs', () => {
    // Suited (upper triangle).
    expect(getHandFrequency(RFI_RANGES.BTN, cid('Ah'), cid('Kh')))
      .toBe(getHandFrequency(RFI_RANGES.BTN, cid('Kh'), cid('Ah')));
    // Offsuit (lower triangle) with the lower card passed FIRST — exercises the
    // reversed-order path that the old test never hit.
    expect(getHandFrequency(RFI_RANGES.BTN, cid('9c'), cid('Td'))).toBe(0.5);
    expect(getHandFrequency(RFI_RANGES.BTN, cid('9c'), cid('Td')))
      .toBe(getHandFrequency(RFI_RANGES.BTN, cid('Td'), cid('9c')));
    // Pair.
    expect(getHandFrequency(RFI_RANGES.UTG, cid('8d'), cid('8c')))
      .toBe(getHandFrequency(RFI_RANGES.UTG, cid('8c'), cid('8d')));
  });
});

describe('3-bet range tables', () => {
  it('3-bets premiums and a polarized bluff, never trash', () => {
    for (const key of Object.keys(THREE_BET_RANGES)) {
      // Premiums always 3-bet.
      expect(getHandFrequency(THREE_BET_RANGES[key], cid('Ah'), cid('Ad'))).toBe(1); // AA
      expect(getHandFrequency(THREE_BET_RANGES[key], cid('Kc'), cid('Kd'))).toBe(1); // KK
      // Pure trash is never a 3-bet.
      expect(getHandFrequency(THREE_BET_RANGES[key], cid('7c'), cid('2d'))).toBe(0); // 72o
    }
    // The polarized structure includes a suited-wheel-ace bluff (A5s) at a mixed
    // frequency in BB vs BTN — not just the linear value top.
    expect(getHandFrequency(THREE_BET_RANGES.BB_vs_BTN, cid('Ah'), cid('5h'))).toBe(0.7);
  });

  it('3-bet ranges are tighter than the corresponding RFI ranges', () => {
    for (const key of Object.keys(THREE_BET_RANGES)) {
      const threeBetCount = rangeToHandList(THREE_BET_RANGES[key]).length;
      const btnRfiCount = rangeToHandList(RFI_RANGES.BTN).length;
      expect(threeBetCount, `${key} tighter than BTN RFI`).toBeLessThan(btnRfiCount);
    }
  });
});

describe('rangeToHandList', () => {
  it('expands AA to all 6 combos with full weight', () => {
    const list = rangeToHandList(RFI_RANGES.UTG);
    const aceAces = list.filter(({ hand }) => {
      const [c1, c2] = hand;
      return Math.floor(c1 / 4) === 12 && Math.floor(c2 / 4) === 12;
    });
    expect(aceAces.length).toBe(6); // C(4,2) suit combos of AA
    expect(aceAces.every(h => h.weight === 1)).toBe(true);
  });

  it('propagates fractional weights (a 0.5 hand appears with weight 0.5)', () => {
    // UTG A9s = 0.5. Its 4 suited combos must surface with weight 0.5 (not 1).
    const list = rangeToHandList(RFI_RANGES.UTG);
    const a9s = list.filter(({ hand }) => {
      const [c1, c2] = hand;
      const ranks = [Math.floor(c1 / 4), Math.floor(c2 / 4)].sort((a, b) => a - b);
      return ranks[0] === 7 && ranks[1] === 12 && c1 % 4 === c2 % 4; // 9 & A, same suit
    });
    expect(a9s.length).toBe(4);            // 4 suited combos
    expect(a9s.every(h => h.weight === 0.5)).toBe(true);
  });

  it('excludes dead cards from the combo list', () => {
    const withDead = rangeToHandList(RFI_RANGES.BTN, [cid('Ah')]);
    const touchesAh = withDead.some(({ hand }) => hand.includes(cid('Ah')));
    expect(touchesAh).toBe(false);
  });
});
