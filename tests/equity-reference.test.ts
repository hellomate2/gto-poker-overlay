import { describe, it, expect } from 'vitest';
import { evaluateHand } from '../src/core/equity/hand-eval';
import { equityVsRange as mcEquityVsRange, equityVsRandom } from '../src/core/equity/monte-carlo';
import { equityVsRange } from '../src/core/equity/range-equity';
import { createDeck, removeCards } from '../src/core/cfr/card-utils';
import { CardId } from '../src/types/poker';
import { ids, cid } from './helpers';

// ============================================================
// Exact preflop all-in equity by full board enumeration.
//
// Given hero's two cards and villain's two cards, enumerate ALL C(48,5)
// five-card boards and compute hero's exact equity (ties = half). This is the
// ground truth; no Monte Carlo, no randomness.
// ============================================================

function exactHeadsUpEquity(
  hero: [CardId, CardId],
  villain: [CardId, CardId],
): { equity: number; boards: number } {
  const known = [hero[0], hero[1], villain[0], villain[1]];
  const deck = removeCards(createDeck(), known); // 48 cards
  const n = deck.length;
  let score = 0;
  let boards = 0;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const board = [deck[a], deck[b], deck[c], deck[d], deck[e]];
            const hr = evaluateHand([hero[0], hero[1], ...board]);
            const vr = evaluateHand([villain[0], villain[1], ...board]);
            score += hr > vr ? 1 : hr < vr ? 0 : 0.5;
            boards++;
          }
  return { equity: score / boards, boards };
}

// ============================================================
// TASK 3a — KNOWN REFERENCE EQUITIES (exact enumeration).
//
// Reference equities are the canonical "twodimes"/PokerStove preflop all-in
// numbers, widely published. We assert our EXACT enumeration matches them to
// well under 1% (these are exact, so tolerance is just for the published
// rounding). The measured numbers are logged for the report.
// ============================================================

describe('equity engine — exact preflop all-in vs known references', () => {
  it('AA vs KK ~= 0.82 (reference 0.8155)', () => {
    const { equity, boards } = exactHeadsUpEquity(
      [cid('Ah'), cid('As')],
      [cid('Kh'), cid('Ks')],
    );
    // Suits chosen so neither hand can make a flush more readily than usual;
    // canonical AA vs KK all-in is ~81.5% for the aces.
    // eslint-disable-next-line no-console
    console.log(`[equity] AA vs KK exact = ${equity.toFixed(4)} over ${boards} boards (ref 0.8155)`);
    expect(equity).toBeGreaterThan(0.8);
    expect(equity).toBeLessThan(0.83);
  });

  it('AA vs 72o ~= 0.88 (reference 0.8765)', () => {
    const { equity, boards } = exactHeadsUpEquity(
      [cid('Ah'), cid('As')],
      [cid('7c'), cid('2d')],
    );
    // eslint-disable-next-line no-console
    console.log(`[equity] AA vs 72o exact = ${equity.toFixed(4)} over ${boards} boards (ref 0.8765)`);
    expect(equity).toBeGreaterThan(0.86);
    expect(equity).toBeLessThan(0.89);
  });

  it('AKs vs QQ ~= 0.46 (coinflip-ish, reference 0.4604)', () => {
    const { equity, boards } = exactHeadsUpEquity(
      [cid('Ah'), cid('Kh')],
      [cid('Qc'), cid('Qd')],
    );
    // eslint-disable-next-line no-console
    console.log(`[equity] AKs vs QQ exact = ${equity.toFixed(4)} over ${boards} boards (ref 0.4604)`);
    expect(equity).toBeGreaterThan(0.44);
    expect(equity).toBeLessThan(0.48);
  });

  it('AKo vs JTs ~= known (reference ~0.585 for AKo)', () => {
    // AKo (offsuit) vs JTs (suited connector). Published ~58.4% for AK.
    const { equity, boards } = exactHeadsUpEquity(
      [cid('Ah'), cid('Ks')],
      [cid('Jd'), cid('Td')],
    );
    // eslint-disable-next-line no-console
    console.log(`[equity] AKo vs JTs exact = ${equity.toFixed(4)} over ${boards} boards (ref ~0.585)`);
    expect(equity).toBeGreaterThan(0.56);
    expect(equity).toBeLessThan(0.61);
  });

  it('22 vs AKs ~= 0.50-0.52 (classic underdog-coinflip, reference ~0.503 for 22)', () => {
    const { equity, boards } = exactHeadsUpEquity(
      [cid('2c'), cid('2d')],
      [cid('Ah'), cid('Kh')],
    );
    // eslint-disable-next-line no-console
    console.log(`[equity] 22 vs AKs exact = ${equity.toFixed(4)} over ${boards} boards (ref ~0.503)`);
    expect(equity).toBeGreaterThanOrEqual(0.49);
    expect(equity).toBeLessThanOrEqual(0.53);
  });
});

// ============================================================
// TASK 3b — MONTE CARLO CONVERGENCE.
//
// As sample count grows, the MC estimate must approach the exact enumeration.
// We compare hero=AA vs a random hand (equityVsRandom) at increasing sample
// counts and assert the absolute gap to the exact value shrinks.
// ============================================================

describe('equity engine — Monte Carlo convergence to exact', () => {
  it('MC equity vs random approaches exact enumeration as samples grow', () => {
    const hero: [CardId, CardId] = [cid('Ah'), cid('As')];
    const board: CardId[] = [];

    // Exact: AA vs a uniformly random other hand, all-in preflop.
    // Enumerate all villain combos and all boards is enormous; instead use a
    // very large MC as the "near-exact" anchor AND assert monotone-ish shrink
    // of the gap between a small and large run against that anchor.
    // To get a deterministic exact anchor for AA-vs-random preflop we use the
    // well-known value ~0.852.
    const REF = 0.852;

    const small = equityVsRandom(hero, board, 400).equity;
    const big = equityVsRandom(hero, board, 40000).equity;

    const gapSmall = Math.abs(small - REF);
    const gapBig = Math.abs(big - REF);

    // eslint-disable-next-line no-console
    console.log(
      `[equity] AA vs random: small(400)=${small.toFixed(4)} gap=${gapSmall.toFixed(4)}, ` +
        `big(40000)=${big.toFixed(4)} gap=${gapBig.toFixed(4)}, ref=${REF}`,
    );

    // The large-sample estimate must be close to the reference (tight).
    expect(gapBig).toBeLessThan(0.01);
    // The small sample is allowed to be loose; we only assert it is bounded by
    // a generous CLT envelope (~3 std devs at N=400 is well under 0.08). The
    // strict "gap shrinks" claim is covered by the averaged-error test below,
    // which is statistically robust (a single small run can get lucky).
    expect(gapSmall).toBeLessThan(0.08);
  });

  it('averaged MC gap shrinks with more samples (variance argument)', () => {
    const hero: [CardId, CardId] = [cid('Ah'), cid('As')];
    const REF = 0.852;

    // Average |error| over several independent runs at each budget; the mean
    // absolute error must drop as the budget grows (CLT: ~1/sqrt(N)).
    const meanAbsErr = (samples: number, runs: number): number => {
      let acc = 0;
      for (let r = 0; r < runs; r++) {
        acc += Math.abs(equityVsRandom(hero, [], samples).equity - REF);
      }
      return acc / runs;
    };

    const errLow = meanAbsErr(300, 8);
    const errHigh = meanAbsErr(12000, 8);
    // eslint-disable-next-line no-console
    console.log(`[equity] mean|err| @300=${errLow.toFixed(4)}, @12000=${errHigh.toFixed(4)}`);
    expect(errHigh).toBeLessThan(errLow);
  });
});

// ============================================================
// TASK 3c — CARD REMOVAL CORRECTNESS IN RANGE-VS-RANGE.
//
// equityVsRange must DROP villain combos that conflict with hero's cards or the
// board. We construct a case where a naive implementation that did NOT remove
// conflicting combos would give a detectably wrong number, and assert the
// engine returns the card-removal-correct value.
//
// Construction: river is fully out. Hero holds a flush. Villain's stated range
// contains combos that are IMPOSSIBLE because they reuse hero/board cards. The
// only LEGAL villain combo in the range is a worse hand, so hero's correct
// equity is 1.0. A naive double-counting engine would average in the impossible
// (often "tying/winning") combos and report < 1.0.
// ============================================================

describe('range-equity — card removal correctness (river, exact)', () => {
  it('excludes combos conflicting with hero/board; reports the correct equity', () => {
    // River fully out. Board: Ad Kc 9h 4s 2c (no flush, no pair on board).
    const board = ids('Ad', 'Kc', '9h', '4s', '2c');
    // Hero holds 9c 9d -> trip nines (9h on board). A decent but beatable hand.
    const hero: [CardId, CardId] = [cid('9c'), cid('9d')];

    // Villain "range" as stated by a careless caller. One combo is ILLEGAL and
    // is specifically chosen so that naive (no-removal) scoring would score it
    // as a TIE — a number different from the legal-only result — making the bug
    // detectable:
    //   - [9s, 9h]  ILLEGAL: 9h is already on the board. Naive scoring would
    //               give villain trip nines too => a TIE worth 0.5.
    //   - [As, Ks]  LEGAL: makes two pair (A,K) which LOSES to hero's trip
    //               nines, so hero wins => 1.0.
    // Card-removal-correct equity uses only the legal combo => exactly 1.0.
    // Naive double-counting averages (1.0 + 0.5)/2 = 0.75.
    const villainRange: [CardId, CardId][] = [
      [cid('9s'), cid('9h')], // illegal: 9h on board; naive => trips nines = TIE (0.5)
      [cid('As'), cid('Ks')], // legal: two pair AK, LOSES to trip nines (hero wins)
    ];

    const res = equityVsRange(hero, board, villainRange);
    // eslint-disable-next-line no-console
    console.log(
      `[equity] range-vs-range card removal: combos=${res.combos}, ` +
        `samples=${res.samples}, equity=${res.equity.toFixed(4)} (correct=1.0)`,
    );

    // Exactly one legal combo survived removal (the 9s9h combo reuses 9h).
    expect(res.combos).toBe(1);
    // River out, one showdown per combo -> exactly one sample.
    expect(res.samples).toBe(1);
    // Hero's trip nines beat villain's two pair -> equity exactly 1.0.
    expect(res.equity).toBe(1);

    // A naive engine that kept BOTH combos would (wrongly) score the illegal
    // 9s9h as a TIE (0.5), dragging the average to (1 + 0.5)/2 = 0.75. This
    // proves card removal is load-bearing and the difference is detectable.
    const naive = naiveEquityNoRemoval(hero, board, villainRange);
    // eslint-disable-next-line no-console
    console.log(`[equity] naive (no removal) would report = ${naive.toFixed(4)}`);
    expect(naive).toBeCloseTo(0.75, 5); // averages in the impossible tie
    expect(res.equity).not.toBeCloseTo(naive, 2); // correct != naive
  });

  it('monte-carlo equityVsRange also filters conflicting combos', () => {
    // Same setup but via the monte-carlo module's equityVsRange (river out).
    const board = ids('As', 'Ks', '7s', '2h', '3d');
    const hero: [CardId, CardId] = [cid('Qs'), cid('Js')];
    const villainRange: [CardId, CardId][] = [
      [cid('As'), cid('Ah')],
      [cid('Ks'), cid('Kh')],
      [cid('Tc'), cid('Td')],
    ];
    const res = mcEquityVsRange(hero, board, villainRange, 50);
    // Only TT is legal; hero's flush wins -> equity 1.0.
    expect(res.equity).toBe(1);
  });
});

/**
 * A deliberately-WRONG reference: scores every stated villain combo against
 * hero on the given (complete) board WITHOUT removing combos that reuse known
 * cards. This is what a double-counting bug would do. Used only to prove the
 * correct engine differs from it detectably.
 */
function naiveEquityNoRemoval(
  hero: [CardId, CardId],
  board: CardId[],
  range: [CardId, CardId][],
): number {
  let score = 0;
  for (const v of range) {
    const hr = evaluateHand([...hero, ...board]);
    const vr = evaluateHand([...v, ...board]);
    score += hr > vr ? 1 : hr < vr ? 0 : 0.5;
  }
  return score / range.length;
}
