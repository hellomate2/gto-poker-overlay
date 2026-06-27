import { describe, it, expect } from 'vitest';
import { leadBetProbability, LeadInput } from '../src/core/cbet';
import { HAND_CATEGORY } from '../src/core/equity/hand-eval';

const base: LeadInput = {
  isAggressor: true, isIP: true, heroCat: HAND_CATEGORY.HIGH_CARD,
  equity: 0.4, street: 'flop', veryWetOrMono: false, dangerousFlush: false,
};
const L = (o: Partial<LeadInput>) => leadBetProbability({ ...base, ...o });

describe('lead/c-bet policy (fixes the inverted net)', () => {
  it('aggressor c-bets a real value hand at high freq', () => {
    expect(L({ isAggressor: true, heroCat: HAND_CATEGORY.TWO_PAIR })).toBeGreaterThan(0.8);
  });

  it('caller checks air to the raiser (very low lead freq)', () => {
    expect(L({ isAggressor: false, heroCat: HAND_CATEGORY.HIGH_CARD, equity: 0.3 })).toBeLessThan(0.1);
  });

  it('the aggressor leads FAR more than the caller with the same hand (inversion gone)', () => {
    const agg = L({ isAggressor: true, heroCat: HAND_CATEGORY.PAIR, equity: 0.6 });
    const call = L({ isAggressor: false, heroCat: HAND_CATEGORY.PAIR, equity: 0.6 });
    expect(agg).toBeGreaterThan(call + 0.3);
  });

  it('caller leads strong hands sometimes (two pair+)', () => {
    expect(L({ isAggressor: false, heroCat: HAND_CATEGORY.TWO_PAIR })).toBeGreaterThan(0.3);
  });

  it('aggressor c-bets a marginal pair LESS on a very wet board (pot control)', () => {
    expect(L({ heroCat: HAND_CATEGORY.PAIR, veryWetOrMono: false }))
      .toBeGreaterThan(L({ heroCat: HAND_CATEGORY.PAIR, veryWetOrMono: true }));
  });

  it('aggressor c-bets a touch more IN POSITION than out of position', () => {
    expect(L({ heroCat: HAND_CATEGORY.PAIR, isIP: true }))
      .toBeGreaterThan(L({ heroCat: HAND_CATEGORY.PAIR, isIP: false }));
  });

  it('pure air on a wet board mostly checks (low freq)', () => {
    expect(L({ heroCat: HAND_CATEGORY.HIGH_CARD, equity: 0.32, veryWetOrMono: true })).toBeLessThan(0.25);
  });

  it('polarizes the river: bets value, but mostly CHECKS one pair (showdown value)', () => {
    const valueRiver = L({ heroCat: HAND_CATEGORY.TWO_PAIR, street: 'river' });
    const pairRiver = L({ heroCat: HAND_CATEGORY.PAIR, street: 'river' });
    const pairFlop = L({ heroCat: HAND_CATEGORY.PAIR, street: 'flop' });
    expect(valueRiver).toBeGreaterThan(0.7);   // still value-bets the river
    expect(pairRiver).toBeLessThan(0.3);        // one pair on the river mostly checks
    expect(pairRiver).toBeLessThan(pairFlop);   // and far less than a flop protection c-bet
  });

  it('barrels the turn less than the flop with a marginal pair', () => {
    expect(L({ heroCat: HAND_CATEGORY.PAIR, street: 'turn' }))
      .toBeLessThan(L({ heroCat: HAND_CATEGORY.PAIR, street: 'flop' }));
  });

  it('never bets into a flush it cannot beat; a made flush still can', () => {
    expect(L({ heroCat: HAND_CATEGORY.PAIR, dangerousFlush: true })).toBe(0);
    expect(L({ heroCat: HAND_CATEGORY.FLUSH, dangerousFlush: true })).toBeGreaterThan(0);
  });

  it('every probability stays in [0,1]', () => {
    for (const agg of [true, false]) for (const ip of [true, false])
      for (const cat of Object.values(HAND_CATEGORY) as number[])
        for (const eq of [0, 0.3, 0.5, 0.72, 1]) for (const wet of [true, false]) {
          const p = L({ isAggressor: agg, isIP: ip, heroCat: cat, equity: eq, veryWetOrMono: wet });
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
        }
  });
});
