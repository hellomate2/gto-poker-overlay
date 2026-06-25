import { describe, it, expect } from 'vitest';
import { predictPostflop } from '../src/core/ml/policy';
import { ACTIONS, Spot } from '../src/core/ml/features';
import { parseCard, cardToId } from '../src/core/cfr/card-utils';

// ============================================================
// Sanity checks on the net itself (committed weights, committed forward pass):
//   - probabilities non-negative and sum to 1
//   - the legal-action mask zeroes illegal actions exactly
//   - hand-built spots are DIRECTIONALLY correct (the nuts is aggressive,
//     a busted bluff facing a big bet is not a call-everything machine).
// ============================================================

const id = (s: string) => cardToId(parseCard(s));

function spot(p: Partial<Spot>): Spot {
  return {
    holeCards: [id('Ah'), id('Kh')],
    board: [id('Ks'), id('7h'), id('2d')],
    street: 'flop',
    heroPos: 'IP',
    facingBet: false,
    toCallFrac: 0,
    offeredSizeFrac: 0.66,
    canCheck: true, canBet: true, canCall: false, canRaise: false, canFold: false,
    threeBetPot: false,
    ...p,
  };
}

const sum = (p: Record<string, number>) => ACTIONS.reduce((a, k) => a + p[k], 0);

describe('postflop net — probability axioms', () => {
  it('probs are non-negative and sum to 1 across many random-ish spots', () => {
    const spots: Spot[] = [
      spot({}),
      spot({ heroPos: 'OOP' }),
      spot({ street: 'turn', board: [id('Ks'), id('7h'), id('2d'), id('Jc')] }),
      spot({ street: 'river', board: [id('Ks'), id('7h'), id('2d'), id('Jc'), id('7c')] }),
      spot({
        facingBet: true, toCallFrac: 0.6, offeredSizeFrac: 0.6,
        canCheck: false, canBet: false, canCall: true, canRaise: true, canFold: true,
      }),
    ];
    for (const s of spots) {
      const { probs } = predictPostflop(s);
      for (const a of ACTIONS) {
        expect(probs[a]).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(probs[a])).toBe(true);
      }
      expect(sum(probs)).toBeCloseTo(1, 6);
    }
  });

  it('the legal mask zeroes illegal actions exactly', () => {
    // Not facing a bet: only check/bet legal.
    const notFacing = predictPostflop(spot({}));
    expect(notFacing.probs.fold).toBe(0);
    expect(notFacing.probs.call).toBe(0);
    expect(notFacing.probs.raise).toBe(0);

    // Facing a bet: only fold/call/raise legal.
    const facing = predictPostflop(spot({
      facingBet: true, toCallFrac: 0.5, offeredSizeFrac: 0.5,
      canCheck: false, canBet: false, canCall: true, canRaise: true, canFold: true,
    }));
    expect(facing.probs.check).toBe(0);
    expect(facing.probs.bet).toBe(0);

    // Fold-only-vs-call (huge bet, no raise allowed): bet/check/raise zero.
    const callOrFold = predictPostflop(spot({
      facingBet: true, toCallFrac: 1.5, offeredSizeFrac: 1.5,
      canCheck: false, canBet: false, canCall: true, canRaise: false, canFold: true,
    }));
    expect(callOrFold.probs.check).toBe(0);
    expect(callOrFold.probs.bet).toBe(0);
    expect(callOrFold.probs.raise).toBe(0);
    expect(callOrFold.probs.fold + callOrFold.probs.call).toBeCloseTo(1, 6);
  });

  it('argmax is always a legal action', () => {
    const facing = predictPostflop(spot({
      facingBet: true, toCallFrac: 0.5, offeredSizeFrac: 0.5,
      canCheck: false, canBet: false, canCall: true, canRaise: true, canFold: true,
    }));
    expect(['fold', 'call', 'raise']).toContain(facing.action);

    const open = predictPostflop(spot({}));
    expect(['check', 'bet']).toContain(open.action);
  });
});

describe('postflop net — directional behavior', () => {
  it('the nuts on the river (when we can lead) is aggression-heavy, not a pure check', () => {
    // T9 of hearts makes a royal flush on AhKhQhJh — the literal nuts.
    const royal = predictPostflop(spot({
      holeCards: [id('Th'), id('9h')],
      board: [id('Ah'), id('Kh'), id('Qh'), id('Jh'), id('2d')],
      street: 'river',
      canCheck: true, canBet: true, canCall: false, canRaise: false, canFold: false,
    }));
    // With the nuts and the option to bet, the net should put real weight on bet.
    expect(royal.probs.bet).toBeGreaterThan(0.25);
  });

  it('with the nuts facing a bet, the net is raise/call (not fold)', () => {
    const royalFacing = predictPostflop(spot({
      holeCards: [id('Th'), id('9h')],
      board: [id('Ah'), id('Kh'), id('Qh'), id('Jh'), id('2d')],
      street: 'river',
      facingBet: true, toCallFrac: 0.6, offeredSizeFrac: 0.6,
      canCheck: false, canBet: false, canCall: true, canRaise: true, canFold: true,
    }));
    // Never fold the nuts. Fold probability must be tiny.
    expect(royalFacing.probs.fold).toBeLessThan(0.05);
    expect(royalFacing.probs.call + royalFacing.probs.raise).toBeGreaterThan(0.95);
  });

  it('trash facing a large river bet is not a call-everything machine', () => {
    // King-high no-pair on a wet board, facing a pot-sized bet -> fold should be
    // a live, substantial option (directional: weak hand -> meaningful fold mass).
    const trash = predictPostflop(spot({
      holeCards: [id('Kc'), id('3d')],
      board: [id('Ah'), id('Qs'), id('9h'), id('8c'), id('5d')],
      street: 'river',
      facingBet: true, toCallFrac: 1.0, offeredSizeFrac: 1.0,
      canCheck: false, canBet: false, canCall: true, canRaise: true, canFold: true,
    }));
    expect(trash.probs.fold).toBeGreaterThan(0.2);
  });
});
