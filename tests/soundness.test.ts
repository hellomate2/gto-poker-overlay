import { describe, it, expect } from 'vitest';
import { evaluateSoundness, SoundnessInput } from '../src/core/soundness';

// Base: a postflop call facing a bet. Override fields per case.
const base: SoundnessInput = {
  action: 'call', street: 'river', facingBet: true,
  potOdds: 0.33, commit: 0.2, effStackBB: 50, isPremium: false, eqVsRange: 0.5,
};
const S = (o: Partial<SoundnessInput>): SoundnessInput => ({ ...base, ...o });

describe('soundness gate — RULE 1: price/commitment floor on calls', () => {
  it('FOLDS king-high calling a river jam (15% eq vs 35% price, half stack)', () => {
    const r = evaluateSoundness(S({ eqVsRange: 0.15, potOdds: 0.35, commit: 0.5 }));
    expect(r.override).toBe(true);
    expect(r.action).toBe('fold');
  });

  it('KEEPS a profitable bluff-catch (45% eq getting 30% price)', () => {
    expect(evaluateSoundness(S({ eqVsRange: 0.45, potOdds: 0.30, commit: 0.15 })).override).toBe(false);
  });

  it('KEEPS a cheap marginal peel (40% eq, 33% price, small commit)', () => {
    expect(evaluateSoundness(S({ eqVsRange: 0.40, potOdds: 0.33, commit: 0.05 })).override).toBe(false);
  });

  it('demands MORE edge when stacking off: 40% eq vs 36% price all-in -> fold', () => {
    const cheap = evaluateSoundness(S({ eqVsRange: 0.40, potOdds: 0.36, commit: 0.05 }));
    const allin = evaluateSoundness(S({ eqVsRange: 0.40, potOdds: 0.36, commit: 1.0 }));
    expect(cheap.override).toBe(false);   // small commit: the thin call is fine
    expect(allin.override).toBe(true);    // huge commit: needs a real edge
  });

  it('NEVER folds a hand clearly ahead of the range (>=60% eq), even priced in', () => {
    expect(evaluateSoundness(S({ eqVsRange: 0.62, potOdds: 0.70, commit: 0.8 })).override).toBe(false);
  });

  it('does not touch a call when not facing a bet', () => {
    expect(evaluateSoundness(S({ facingBet: false, potOdds: 0, eqVsRange: 0.1 })).override).toBe(false);
  });

  it('DEFERS to a confident bluff-heavy read: a thin call vs a maniac stands', () => {
    const noRead = evaluateSoundness(S({ eqVsRange: 0.20, potOdds: 0.35, commit: 0.4 }));
    const withRead = evaluateSoundness(S({ eqVsRange: 0.20, potOdds: 0.35, commit: 0.4, trustExploitRead: true }));
    expect(noRead.override).toBe(true);    // no read: fold the thin call
    expect(withRead.override).toBe(false); // confirmed bluffer: bluff-catch stands
  });
});

describe('soundness gate — RULE 2: no deep preflop stack-off with trash', () => {
  const jam = (o: Partial<SoundnessInput>) =>
    evaluateSoundness(S({ action: 'allin', street: 'preflop', facingBet: true, ...o }));

  it('FOLDS a non-premium deep all-in stack-off (48bb)', () => {
    expect(jam({ effStackBB: 48, isPremium: false }).override).toBe(true);
  });

  it('KEEPS a premium deep all-in (AA-class)', () => {
    expect(jam({ effStackBB: 48, isPremium: true }).override).toBe(false);
  });

  it('KEEPS a short-stack jam (12bb push/fold zone), even non-premium', () => {
    expect(jam({ effStackBB: 12, isPremium: false }).override).toBe(false);
  });

  it('does NOT touch a first-in open-jam (not facing a bet)', () => {
    expect(jam({ effStackBB: 48, isPremium: false, facingBet: false }).override).toBe(false);
  });
});

describe('soundness gate — never adds aggression (low-commit actions untouched)', () => {
  for (const action of ['bet', 'raise', 'check', 'fold'] as const) {
    it(`leaves a low-commit '${action}' untouched`, () => {
      expect(evaluateSoundness(S({ action, commit: 0.2, eqVsRange: 0.01, potOdds: 0.9 })).override).toBe(false);
    });
  }
});

describe('soundness gate — RULE 3: do not stack off as the aggressor with air', () => {
  // The exact hand-6 punt: triple-barrel nine-high, then jam the river with a
  // crushed pair. The gate must turn a stack-committing air bet into check/fold.
  it('vetoes JAMMING the river with a crushed hand (commit ~1, ~12% eq) -> CHECK', () => {
    const r = evaluateSoundness(S({ action: 'allin', facingBet: false, commit: 1, eqVsRange: 0.12 }));
    expect(r.override).toBe(true);
    expect(r.action).toBe('check');
  });
  it('vetoes a big over-bet barrel with air -> CHECK', () => {
    const r = evaluateSoundness(S({ action: 'bet', facingBet: false, commit: 0.7, eqVsRange: 0.20 }));
    expect(r.override).toBe(true);
    expect(r.action).toBe('check');
  });
  it('a stack-commit shove that FACES a bet folds (cannot check)', () => {
    const r = evaluateSoundness(S({ action: 'raise', facingBet: true, commit: 0.8, eqVsRange: 0.20 }));
    expect(r.override).toBe(true);
    expect(r.action).toBe('fold');
  });
  it('KEEPS a value stack-off (commit ~1, 70% eq vs range)', () => {
    expect(evaluateSoundness(S({ action: 'allin', facingBet: false, commit: 1, eqVsRange: 0.70 })).override).toBe(false);
  });
  it('KEEPS a normal-sized c-bet / bluff (low commit) even with low eq', () => {
    expect(evaluateSoundness(S({ action: 'bet', facingBet: false, commit: 0.25, eqVsRange: 0.20 })).override).toBe(false);
  });
  it('does NOT touch preflop aggression (RULE 3 is postflop-only)', () => {
    expect(evaluateSoundness(S({ action: 'allin', street: 'preflop', facingBet: false, commit: 1, eqVsRange: 0.20 })).override).toBe(false);
  });
});

// (A turn "give up hopeless air" rule was prototyped and rejected by the behavioral
// audit — it pushed turn-barrel below the GTO band. See the note in soundness.ts.)
