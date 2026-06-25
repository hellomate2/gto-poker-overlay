import { describe, it, expect } from 'vitest';
import { predictBetSize, SIZE_ACCURACY } from '../src/core/ml/policy';
import { SIZE_BUCKET_FRACS, NUM_SIZE_BUCKETS, sizeBucketOf, Spot } from '../src/core/ml/features';
import { parseCard, cardToId } from '../src/core/cfr/card-utils';

// ============================================================
// Bet-SIZE head: a second classifier that predicts how big to bet/raise from the
// same 48 features, trained on the solver's actual chosen size (chips/pot). It
// replaces the old flat board-texture sizing, which systematically UNDER-bet
// (0.33-0.66 pot vs the solver's ~0.66-0.9+).
// ============================================================

const id = (s: string) => cardToId(parseCard(s));

function spot(p: Partial<Spot>): Spot {
  return {
    holeCards: [id('Ah'), id('Kh')],
    board: [id('Ks'), id('7h'), id('2d')],
    street: 'flop', heroPos: 'IP',
    facingBet: false, toCallFrac: 0, offeredSizeFrac: 0.66,
    canCheck: true, canBet: true, canCall: false, canRaise: false, canFold: false,
    threeBetPot: false, ...p,
  };
}

describe('bet-size head', () => {
  it('sizeBucketOf maps a raw size fraction to the right bucket', () => {
    expect(sizeBucketOf(0.30)).toBe(0); // small
    expect(sizeBucketOf(0.66)).toBe(1);
    expect(sizeBucketOf(0.85)).toBe(2);
    expect(sizeBucketOf(1.25)).toBe(3);
    expect(sizeBucketOf(3.00)).toBe(4); // overbet / all-in
  });

  it('predictBetSize returns a valid bucket and a representative pot-fraction', () => {
    const spots = [
      spot({}),
      spot({ heroPos: 'OOP' }),
      spot({ street: 'turn', board: [id('Ks'), id('7h'), id('2d'), id('Jc')] }),
      spot({ street: 'river', board: [id('Ks'), id('7h'), id('2d'), id('Jc'), id('7c')] }),
      spot({ facingBet: true, toCallFrac: 0.6, offeredSizeFrac: 0.6, canCheck: false, canCall: true, canRaise: true, canFold: true }),
    ];
    for (const s of spots) {
      const r = predictBetSize(s);
      expect(r.bucket).toBeGreaterThanOrEqual(0);
      expect(r.bucket).toBeLessThan(NUM_SIZE_BUCKETS);
      expect([...SIZE_BUCKET_FRACS]).toContain(r.fraction);
      expect(r.fraction).toBeGreaterThan(0);
    }
  });

  it('the recorded size-head accuracy is far above the majority-bucket baseline', () => {
    // The majority bucket (~0.85 pot) is only ~39% of bet/raise rows; the head is
    // ~92%, so the solver's size is genuinely learnable from the spot.
    expect(SIZE_ACCURACY.val).toBeGreaterThan(0.7);
    expect(SIZE_ACCURACY.train).toBeGreaterThan(0.7);
  });

  it('sizes a value hand within the real betting range (0.4x..2x pot)', () => {
    const r = predictBetSize(spot({ holeCards: [id('Kd'), id('Kc')], board: [id('Ks'), id('7h'), id('2d')] })); // top set
    expect(r.fraction).toBeGreaterThanOrEqual(0.4);
    expect(r.fraction).toBeLessThanOrEqual(2.0);
  });
});
