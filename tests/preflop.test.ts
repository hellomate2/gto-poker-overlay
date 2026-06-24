import { describe, it, expect } from 'vitest';
import {
  RFI_RANGES,
  THREE_BET_RANGES,
  getHandFrequency,
  rangeToHandList,
} from '../src/core/ranges/preflop';
import { cid } from './helpers';

describe('RFI range tables', () => {
  it('defines ranges for all six positions', () => {
    for (const pos of ['UTG', 'MP', 'CO', 'BTN', 'SB']) {
      expect(RFI_RANGES[pos]).toBeDefined();
      expect(RFI_RANGES[pos].length).toBe(13);
      expect(RFI_RANGES[pos][0].length).toBe(13);
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

  it('distinguishes suited from offsuit (AKs >= AKo in UTG)', () => {
    const aks = getHandFrequency(RFI_RANGES.UTG, cid('Ah'), cid('Kh'));
    const ako = getHandFrequency(RFI_RANGES.UTG, cid('Ah'), cid('Kd'));
    expect(aks).toBe(1);
    expect(ako).toBe(1);
    // 32s vs 32o: UTG opens neither, but generally suited >= offsuit weight
    const t9s = getHandFrequency(RFI_RANGES.BTN, cid('Td'), cid('9d'));
    const t9o = getHandFrequency(RFI_RANGES.BTN, cid('Td'), cid('9c'));
    expect(t9s).toBeGreaterThanOrEqual(t9o);
  });

  it('getHandFrequency is order-independent', () => {
    const a = getHandFrequency(RFI_RANGES.BTN, cid('Ah'), cid('Kh'));
    const b = getHandFrequency(RFI_RANGES.BTN, cid('Kh'), cid('Ah'));
    expect(a).toBe(b);
  });
});

describe('3-bet range tables', () => {
  it('always 3-bets AA in defined matchups', () => {
    for (const key of Object.keys(THREE_BET_RANGES)) {
      expect(getHandFrequency(THREE_BET_RANGES[key], cid('Ah'), cid('Ad'))).toBe(1);
    }
  });

  it('3-bet ranges are tighter than the corresponding RFI ranges', () => {
    const btn3betCount = rangeToHandList(THREE_BET_RANGES.BTN_vs_CO).length;
    const btnRfiCount = rangeToHandList(RFI_RANGES.BTN).length;
    expect(btn3betCount).toBeLessThan(btnRfiCount);
  });
});

describe('rangeToHandList', () => {
  it('expands AA to all 6 combos with full weight', () => {
    // build a matrix that only contains AA = 1
    const list = rangeToHandList(RFI_RANGES.UTG);
    const aceAces = list.filter(({ hand }) => {
      const [c1, c2] = hand;
      return Math.floor(c1 / 4) === 12 && Math.floor(c2 / 4) === 12;
    });
    expect(aceAces.length).toBe(6); // C(4,2) suit combos of AA
    expect(aceAces.every(h => h.weight === 1)).toBe(true);
  });

  it('excludes dead cards from the combo list', () => {
    const withDead = rangeToHandList(RFI_RANGES.BTN, [cid('Ah')]);
    const touchesAh = withDead.some(({ hand }) => hand.includes(cid('Ah')));
    expect(touchesAh).toBe(false);
  });
});
