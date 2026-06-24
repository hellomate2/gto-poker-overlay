import { describe, it, expect } from 'vitest';
import {
  clampRaiseAmount,
  amountMatches,
  parseInputAmount,
  spotSignatureKey,
  sameSpot,
  sampleActionFromStrategy,
  SpotSignature,
} from '../src/content-script/executor';
import { StrategyDistribution } from '../src/types/poker';

// ============================================================
// clampRaiseAmount — clamp to table min/max, reject garbage
// ============================================================

describe('clampRaiseAmount', () => {
  it('rounds a valid in-range amount to whole chips', () => {
    const r = clampRaiseAmount(123.4, { min: 10, max: 1000 });
    expect(r.invalid).toBe(false);
    expect(r.amount).toBe(123);
  });

  it('clamps up to min when below the table minimum', () => {
    const r = clampRaiseAmount(5, { min: 40, max: 1000 });
    expect(r.invalid).toBe(false);
    expect(r.amount).toBe(40);
  });

  it('clamps down to max when above the table maximum (cap at stack)', () => {
    const r = clampRaiseAmount(99999, { min: 40, max: 1500 });
    expect(r.invalid).toBe(false);
    expect(r.amount).toBe(1500);
  });

  it('treats unknown bounds (null) as no clamp', () => {
    const r = clampRaiseAmount(250, { min: null, max: null });
    expect(r.invalid).toBe(false);
    expect(r.amount).toBe(250);
  });

  it('clamps with only a max known', () => {
    expect(clampRaiseAmount(500, { min: null, max: 300 }).amount).toBe(300);
  });

  it('clamps with only a min known', () => {
    expect(clampRaiseAmount(10, { min: 50, max: null }).amount).toBe(50);
  });

  it('rejects undefined / zero / negative / NaN / Infinity as invalid', () => {
    expect(clampRaiseAmount(undefined, { min: 10, max: 100 }).invalid).toBe(true);
    expect(clampRaiseAmount(0, { min: 10, max: 100 }).invalid).toBe(true);
    expect(clampRaiseAmount(-5, { min: 10, max: 100 }).invalid).toBe(true);
    expect(clampRaiseAmount(NaN, { min: 10, max: 100 }).invalid).toBe(true);
    expect(clampRaiseAmount(Infinity, { min: 10, max: 100 }).invalid).toBe(true);
  });

  it('returns invalid when min exceeds max (impossible range)', () => {
    const r = clampRaiseAmount(100, { min: 500, max: 200 });
    expect(r.invalid).toBe(true);
    expect(r.amount).toBeNull();
  });
});

// ============================================================
// amountMatches — read-back verification tolerance
// ============================================================

describe('amountMatches', () => {
  it('matches exact values', () => {
    expect(amountMatches(200, 200)).toBe(true);
  });

  it('matches within rounding tolerance of 1 chip', () => {
    expect(amountMatches(200, 201)).toBe(true);
    expect(amountMatches(200, 199)).toBe(true);
  });

  it('rejects values outside tolerance', () => {
    expect(amountMatches(200, 250)).toBe(false);
    expect(amountMatches(200, 0)).toBe(false);
  });

  it('rejects NaN read-back (input parse failure)', () => {
    expect(amountMatches(200, NaN)).toBe(false);
  });

  it('honors a custom tolerance', () => {
    expect(amountMatches(200, 205, 5)).toBe(true);
    expect(amountMatches(200, 206, 5)).toBe(false);
  });
});

// ============================================================
// parseInputAmount — strip $/commas/spaces
// ============================================================

describe('parseInputAmount', () => {
  it('parses plain numbers', () => {
    expect(parseInputAmount('250')).toBe(250);
  });

  it('strips commas and currency symbols', () => {
    expect(parseInputAmount('$1,250')).toBe(1250);
    expect(parseInputAmount(' 2,000 ')).toBe(2000);
  });

  it('returns NaN for empty / null / non-numeric', () => {
    expect(Number.isNaN(parseInputAmount(''))).toBe(true);
    expect(Number.isNaN(parseInputAmount(null))).toBe(true);
    expect(Number.isNaN(parseInputAmount(undefined))).toBe(true);
    expect(Number.isNaN(parseInputAmount('abc'))).toBe(true);
  });
});

// ============================================================
// Spot signature dedupe — never act twice on the same spot
// ============================================================

describe('spot signature dedupe', () => {
  const base: SpotSignature = { isOurTurn: true, boardLength: 3, currentBet: 50 };

  it('produces a stable key for the same spot', () => {
    expect(spotSignatureKey(base)).toBe(spotSignatureKey({ ...base }));
  });

  it('sameSpot is true for identical spots', () => {
    expect(sameSpot(base, { ...base })).toBe(true);
  });

  it('distinguishes a new street (board length changed)', () => {
    expect(sameSpot(base, { ...base, boardLength: 4 })).toBe(false);
  });

  it('distinguishes a new bet to call (re-raise, same street)', () => {
    expect(sameSpot(base, { ...base, currentBet: 150 })).toBe(false);
  });

  it('distinguishes turn vs not-our-turn', () => {
    expect(sameSpot(base, { ...base, isOurTurn: false })).toBe(false);
  });

  it('treats a null signature as never-equal (no prior spot)', () => {
    expect(sameSpot(null, base)).toBe(false);
    expect(sameSpot(base, null)).toBe(false);
    expect(sameSpot(null, null)).toBe(false);
  });
});

// ============================================================
// sampleActionFromStrategy — seedable mixed-strategy sampling
// ============================================================

function strat(over: Partial<StrategyDistribution>): StrategyDistribution {
  return { fold: 0, check: 0, call: 0, bets: [], ...over };
}

describe('sampleActionFromStrategy', () => {
  const fallback = { action: 'check' as const };

  it('picks fold/check/call in order by cumulative probability', () => {
    const s = strat({ fold: 0.3, check: 0.3, call: 0.4 });
    expect(sampleActionFromStrategy(s, 0.0, fallback).type).toBe('fold');
    expect(sampleActionFromStrategy(s, 0.29, fallback).type).toBe('fold');
    expect(sampleActionFromStrategy(s, 0.3, fallback).type).toBe('check');
    expect(sampleActionFromStrategy(s, 0.59, fallback).type).toBe('check');
    expect(sampleActionFromStrategy(s, 0.6, fallback).type).toBe('call');
    expect(sampleActionFromStrategy(s, 0.99, fallback).type).toBe('call');
  });

  it('returns a sized raise from the bets array', () => {
    const s = strat({ call: 0.5, bets: [{ amount: 200, probability: 0.5 }] });
    const a = sampleActionFromStrategy(s, 0.75, fallback);
    expect(a.type).toBe('raise');
    expect(a.amount).toBe(200);
  });

  it('maps an Infinity bet amount to allin', () => {
    const s = strat({ bets: [{ amount: Infinity, probability: 1 }] });
    const a = sampleActionFromStrategy(s, 0.5, fallback);
    expect(a.type).toBe('allin');
    expect(a.amount).toBeUndefined();
  });

  it('walks multiple bet sizes by cumulative probability', () => {
    const s = strat({
      check: 0.2,
      bets: [
        { amount: 100, probability: 0.3 },
        { amount: 300, probability: 0.5 },
      ],
    });
    expect(sampleActionFromStrategy(s, 0.1, fallback).type).toBe('check');
    expect(sampleActionFromStrategy(s, 0.4, fallback)).toEqual({ type: 'raise', amount: 100 });
    expect(sampleActionFromStrategy(s, 0.9, fallback)).toEqual({ type: 'raise', amount: 300 });
  });

  it('falls back when probabilities do not cover r (rounding gaps)', () => {
    const s = strat({ fold: 0.1 });
    const a = sampleActionFromStrategy(s, 0.99, { action: 'fold' });
    expect(a.type).toBe('fold');
  });

  it('is deterministic for a fixed r (seedable distribution)', () => {
    const s = strat({ fold: 0.25, check: 0.25, call: 0.5 });
    // Seeded sampling over a grid reproduces the analytic distribution.
    const counts: Record<string, number> = { fold: 0, check: 0, call: 0 };
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const r = (i + 0.5) / N; // deterministic, evenly spaced "seed"
      counts[sampleActionFromStrategy(s, r, fallback).type]++;
    }
    expect(counts.fold).toBe(250);
    expect(counts.check).toBe(250);
    expect(counts.call).toBe(500);
  });
});
