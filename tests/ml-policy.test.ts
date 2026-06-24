import { describe, it, expect } from 'vitest';
import { predictPostflop, MODEL_ACCURACY } from '../src/core/ml/policy';
import { encodeSpot, Spot, FEATURE_DIM, ACTIONS } from '../src/core/ml/features';
import { ids } from './helpers';

// ============================================================
// Distilled postflop policy: forward-pass sanity.
//   - feature vector has the documented length
//   - probabilities sum to 1
//   - illegal actions get exactly 0 probability (legal mask respected)
//   - argmax is always a legal action
// Also pins the held-out TEST accuracy baked into model.ts.
// ============================================================

function spot(partial: Partial<Spot>): Spot {
  return {
    holeCards: [ids('Ah')[0], ids('Kh')[0]] as [number, number],
    board: ids('Ks', '7h', '2d'),
    street: 'flop',
    heroPos: 'IP',
    facingBet: false,
    toCallFrac: 0,
    offeredSizeFrac: 0.66,
    canCheck: true,
    canBet: true,
    canCall: false,
    canRaise: false,
    canFold: false,
    threeBetPot: false,
    ...partial,
  };
}

describe('ml feature encoder', () => {
  it('produces a fixed-length deterministic feature vector', () => {
    const s = spot({});
    const a = encodeSpot(s);
    const b = encodeSpot(s);
    expect(a.length).toBe(FEATURE_DIM);
    expect(Array.from(a)).toEqual(Array.from(b)); // deterministic
  });
});

describe('predictPostflop forward pass', () => {
  it('probabilities sum to 1 and respect the legal mask (not facing a bet)', () => {
    const p = predictPostflop(spot({}));
    const sum = ACTIONS.reduce((acc, a) => acc + p.probs[a], 0);
    expect(sum).toBeCloseTo(1, 5);
    // Only check/bet are legal here -> fold/call/raise must be exactly 0.
    expect(p.probs.fold).toBe(0);
    expect(p.probs.call).toBe(0);
    expect(p.probs.raise).toBe(0);
    expect(p.probs.check).toBeGreaterThan(0);
    expect(['check', 'bet']).toContain(p.action);
  });

  it('respects the legal mask when facing a bet', () => {
    const p = predictPostflop(spot({
      facingBet: true,
      toCallFrac: 0.5,
      offeredSizeFrac: 0.5,
      canCheck: false,
      canBet: false,
      canCall: true,
      canRaise: true,
      canFold: true,
    }));
    const sum = ACTIONS.reduce((acc, a) => acc + p.probs[a], 0);
    expect(sum).toBeCloseTo(1, 5);
    // check / bet illegal here.
    expect(p.probs.check).toBe(0);
    expect(p.probs.bet).toBe(0);
    expect(['fold', 'call', 'raise']).toContain(p.action);
  });

  it('all probabilities are finite and non-negative', () => {
    const p = predictPostflop(spot({ street: 'river', board: ids('Ks', '7h', '2d', 'Jc', '7c') }));
    for (const a of ACTIONS) {
      expect(Number.isFinite(p.probs[a])).toBe(true);
      expect(p.probs[a]).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports a respectable held-out TEST accuracy', () => {
    // Baked into model.ts by ml/train.py (legal-masked argmax on PokerBench test).
    expect(MODEL_ACCURACY.test).toBeGreaterThan(0.75);
  });
});
