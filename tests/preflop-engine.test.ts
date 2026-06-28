import { describe, it, expect } from 'vitest';
import { expandRange, allHands, preflopChartAction } from '../src/core/ranges/preflop-charts';

describe('expandRange — range-string parser (the deterministic chart foundation)', () => {
  it('pair plus: 22+ = all 13 pairs', () => {
    const s = expandRange('22+');
    expect(s.size).toBe(13);
    expect(s.has('AA')).toBe(true);
    expect(s.has('22')).toBe(true);
    expect(s.has('TT')).toBe(true);
  });
  it('pair range: 55-99', () => {
    expect([...expandRange('55-99')].sort()).toEqual(['55', '66', '77', '88', '99'].sort());
  });
  it('single pair: TT', () => {
    expect([...expandRange('TT')]).toEqual(['TT']);
  });
  it('suited plus: ATs+ = ATs,AJs,AQs,AKs (not AA, not offsuit)', () => {
    expect([...expandRange('ATs+')].sort()).toEqual(['AKs', 'AQs', 'AJs', 'ATs'].sort());
  });
  it('offsuit plus: KTo+ = KTo,KJo,KQo', () => {
    expect([...expandRange('KTo+')].sort()).toEqual(['KQo', 'KJo', 'KTo'].sort());
  });
  it('suited connector run: 76s-54s', () => {
    expect([...expandRange('76s-54s')].sort()).toEqual(['76s', '65s', '54s'].sort());
  });
  it('both suited+offsuit: AK = AKs, AKo', () => {
    expect([...expandRange('AK')].sort()).toEqual(['AKo', 'AKs'].sort());
  });
  it('A2s+ includes the whole suited-ace row up to AKs', () => {
    const s = expandRange('A2s+');
    expect(s.size).toBe(12); // A2s..AKs
    expect(s.has('A2s')).toBe(true);
    expect(s.has('AKs')).toBe(true);
    expect(s.has('A2o')).toBe(false);
  });
  it('combines comma/space separated tokens, dedupes', () => {
    const s = expandRange('22+, AKs, AKs');
    expect(s.has('22')).toBe(true);
    expect(s.has('AKs')).toBe(true);
  });
  it('every produced name is one of the canonical 169', () => {
    const valid = new Set(allHands());
    for (const h of expandRange('22+, A2s+, K5o+, 76s-54s, AK')) expect(valid.has(h)).toBe(true);
  });
});

describe('allHands — complete 169', () => {
  it('produces exactly 169 unique starting hands', () => {
    expect(new Set(allHands()).size).toBe(169);
  });
});

describe('preflopChartAction — deterministic, sane, complete (no noise, no missing cells)', () => {
  it('53o FOLDS facing a 3-bet (the bug that produced 25/25/25/25 spew)', () => {
    expect(preflopChartAction('53o', 'vs-3bet').action).toBe('fold');
  });
  it('72o FOLDS facing a 3-bet', () => {
    expect(preflopChartAction('72o', 'vs-3bet').action).toBe('fold');
  });
  it('QQ/AK 4-BET facing a 3-bet', () => {
    expect(preflopChartAction('QQ', 'vs-3bet').action).toBe('raise');
    expect(preflopChartAction('AKs', 'vs-3bet').action).toBe('raise');
  });
  it('AQs flats a 3-bet (call), does not 4-bet', () => {
    expect(preflopChartAction('AQs', 'vs-3bet').action).toBe('call');
  });
  it('QQ jams over a 4-bet; junk folds', () => {
    expect(preflopChartAction('QQ', 'vs-4bet').action).toBe('allin');
    expect(preflopChartAction('T9s', 'vs-4bet').action).toBe('fold');
  });
  it('SB opens a wide button range (AA and a junky suited both raise)', () => {
    expect(preflopChartAction('AA', 'RFI').action).toBe('raise');
    expect(preflopChartAction('53s', 'RFI').action).toBe('raise');
  });
  it('SB folds the very worst offsuit first-in', () => {
    expect(preflopChartAction('72o', 'RFI').action).toBe('fold');
    expect(preflopChartAction('32o', 'RFI').action).toBe('fold');
  });
  it('EVERY one of the 169 hands gets a definite action in EVERY scenario (no missing cell)', () => {
    for (const sc of ['RFI', 'vs-open', 'vs-3bet', 'vs-4bet'] as const) {
      for (const h of allHands()) {
        const a = preflopChartAction(h, sc).action;
        expect(['raise', 'call', 'fold', 'allin']).toContain(a);
      }
    }
  });
});
