import { describe, it, expect } from 'vitest';
import {
  anyTwoCardsRange,
  equityVsRanges,
  equityVsVillains,
  MultiwayDealSampler,
  uniformRange,
} from '../src/core/equity/multiway-equity';
import { equityVsRange } from '../src/core/equity/range-equity';
import { evaluateHand } from '../src/core/equity/hand-eval';
import { WeightedRange } from '../src/core/ranges/weighted-range';
import { SeededRng } from '../src/solver/rng';
import { CardId } from '../src/types/poker';
import { cid, ids } from './helpers';

// ============================================================
// equityVsRanges: hero vs N weighted villain ranges at once.
//
// Reference values come from an independent brute-force enumerator written
// below (bruteForce), which walks every disjoint villain deal and every
// runout with plain loops, no sampling. Monte Carlo results are checked
// against it within a few standard errors (the stdErr the function reports),
// with a fixed seed so the tests are deterministic.
// ============================================================

type Combo = [CardId, CardId];

function combos(...pairs: [string, string][]): Combo[] {
  return pairs.map(([a, b]) => [cid(a), cid(b)]);
}

function weighted(cs: Combo[], ws: number[]): WeightedRange {
  return { combos: cs, weights: ws };
}

/**
 * Brute-force exact multiway equity. Enumerates every tuple of pairwise
 * disjoint villain combos (weighted by the product of their weights) and
 * every runout of the remaining deck (at most 2 cards to come here).
 */
function bruteForce(hero: Combo, board: CardId[], ranges: WeightedRange[]): { equity: number; win: number; tie: number } {
  const dead = new Set<CardId>([...hero, ...board]);
  const live = ranges.map(r =>
    r.combos
      .map((c, i) => ({ c, w: r.weights[i] }))
      .filter(({ c, w }) => w > 0 && !dead.has(c[0]) && !dead.has(c[1])),
  );
  let z = 0;
  let eq = 0;
  let win = 0;
  let tie = 0;
  const chosen: Combo[] = [];

  const scoreDeal = (w: number): void => {
    const used = new Set<CardId>([...dead]);
    for (const c of chosen) { used.add(c[0]); used.add(c[1]); }
    const deck: CardId[] = [];
    for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
    const runouts: CardId[][] = [];
    const need = 5 - board.length;
    if (need === 0) runouts.push([]);
    else if (need === 1) for (const c of deck) runouts.push([c]);
    else if (need === 2) for (let i = 0; i < deck.length; i++) for (let j = i + 1; j < deck.length; j++) runouts.push([deck[i], deck[j]]);
    else throw new Error('bruteForce supports <= 2 cards to come');
    for (const ro of runouts) {
      const full = [...board, ...ro];
      const h = evaluateHand([...hero, ...full]);
      const vs = chosen.map(c => evaluateHand([...c, ...full]));
      const best = Math.max(h, ...vs);
      const tied = vs.filter(v => v === best).length;
      const share = h < best ? 0 : 1 / (1 + tied);
      const ww = w / runouts.length;
      z += ww;
      eq += ww * share;
      if (share === 1) win += ww;
      else if (share > 0) tie += ww;
    }
  };

  const recurse = (i: number, w: number, used: Set<CardId>): void => {
    if (i === live.length) { scoreDeal(w); return; }
    for (const { c, w: cw } of live[i]) {
      if (used.has(c[0]) || used.has(c[1])) continue;
      used.add(c[0]); used.add(c[1]);
      chosen.push(c);
      recurse(i + 1, w * cw, used);
      chosen.pop();
      used.delete(c[0]); used.delete(c[1]);
    }
  };
  recurse(0, 1, new Set());
  return { equity: eq / z, win: win / z, tie: tie / z };
}

// Small hand-picked ranges reused below (Kd 7h 2c flop family).
const FLOP = ids('Kd', '7h', '2c');
const TURN = ids('Kd', '7h', '2c', '5s');
const RIVER = ids('Kd', '7h', '2c', '5s', 'Jd');
const HERO_99: Combo = [cid('9h'), cid('9c')];

const TIGHT = combos(['Ks', 'Qs'], ['Kh', 'Jh'], ['Ac', 'Ad'], ['7d', '7s'], ['Ts', 'Td'], ['As', '5d']);
const LOOSE = combos(['Qh', 'Jc'], ['8s', '8d'], ['Ah', '2h'], ['Kc', 'Tc'], ['6s', '4s'], ['9d', '8d'], ['Qd', 'Qc']);
const DRAWS = combos(['6h', '4h'], ['9s', '8s'], ['As', 'Kh'], ['Js', 'Td'], ['3c', '3d']);

describe('equityVsRanges: exact agreement', () => {
  it('one villain, uniform weights: matches the heads-up equityVsRange on flop, turn and river', () => {
    const range = [...TIGHT, ...LOOSE];
    for (const board of [FLOP, TURN, RIVER]) {
      const ref = equityVsRange(HERO_99, board, range, 3000).equity;
      const r = equityVsRanges(HERO_99, board, [uniformRange(range)]);
      expect(r.exact).toBe(true);
      expect(r.stdErr).toBe(0);
      expect(r.equity).toBeCloseTo(ref, 12);
    }
  });

  it('one villain, weighted: matches brute force exactly (turn) and win/tie split adds up', () => {
    const range = weighted([...TIGHT, ...DRAWS], [3, 1, 2, 0.5, 1, 1, 4, 1, 2, 1, 0.25]);
    const bf = bruteForce(HERO_99, TURN, [range]);
    const r = equityVsRanges(HERO_99, TURN, [range]);
    expect(r.equity).toBeCloseTo(bf.equity, 12);
    expect(r.winProb).toBeCloseTo(bf.win, 12);
    expect(r.tieProb).toBeCloseTo(bf.tie, 12);
    // Heads-up: equity = win + tie/2.
    expect(r.equity).toBeCloseTo(r.winProb + r.tieProb / 2, 12);
  });

  it('two villains on the river: exact path matches brute force', () => {
    const ranges = [uniformRange([...TIGHT, ...LOOSE]), weighted(DRAWS.concat(TIGHT), [1, 2, 3, 4, 5, 1, 1, 1, 1, 1, 1])];
    const bf = bruteForce(HERO_99, RIVER, ranges);
    const r = equityVsRanges(HERO_99, RIVER, ranges);
    expect(r.exact).toBe(true);
    expect(r.equity).toBeCloseTo(bf.equity, 12);
    expect(r.winProb).toBeCloseTo(bf.win, 12);
    expect(r.tieProb).toBeCloseTo(bf.tie, 12);
  });

  it('two villains on the turn (Monte Carlo) agree with brute force within 4 standard errors', () => {
    const ranges = [uniformRange(TIGHT), uniformRange([...LOOSE, ...DRAWS])];
    const bf = bruteForce(HERO_99, TURN, ranges);
    const r = equityVsRanges(HERO_99, TURN, ranges, { iterations: 40000, seed: 7 });
    expect(r.exact).toBe(false);
    expect(r.samples).toBe(40000);
    expect(Math.abs(r.equity - bf.equity)).toBeLessThan(4 * r.stdErr);
    // Win/tie probabilities are binomial proportions; same 4-sigma idea.
    const seWin = Math.sqrt((bf.win * (1 - bf.win)) / r.samples);
    expect(Math.abs(r.winProb - bf.win)).toBeLessThan(4 * seWin + 1e-9);
  });

  it('three villains on the river (Monte Carlo) agree with brute force within 4 standard errors', () => {
    const ranges = [uniformRange(TIGHT), uniformRange(LOOSE), weighted(DRAWS, [1, 3, 1, 2, 1])];
    const bf = bruteForce(HERO_99, RIVER, ranges);
    const r = equityVsRanges(HERO_99, RIVER, ranges, { iterations: 40000, seed: 11 });
    expect(Math.abs(r.equity - bf.equity)).toBeLessThan(4 * r.stdErr);
  });

  it('one villain on the flop with exact disabled: Monte Carlo agrees with the exact answer', () => {
    const range = uniformRange([...TIGHT, ...DRAWS]);
    const exact = equityVsRanges(HERO_99, FLOP, [range]);
    const mc = equityVsRanges(HERO_99, FLOP, [range], { exact: false, iterations: 40000, seed: 3 });
    expect(exact.exact).toBe(true);
    expect(mc.exact).toBe(false);
    expect(Math.abs(mc.equity - exact.equity)).toBeLessThan(4 * mc.stdErr);
  });
});

describe('equityVsRanges: poker sanity', () => {
  const AA: Combo = [cid('Ah'), cid('As')];

  it('AA vs two any-two ranges preflop lands in the expected band, and the flop moves it sensibly', () => {
    const anyTwo = anyTwoCardsRange();
    const pre = equityVsRanges(AA, [], [anyTwo, anyTwo], { iterations: 40000, seed: 5 });
    // AA vs two random hands is a little under three quarters of the pot.
    expect(pre.equity).toBeGreaterThan(0.70);
    expect(pre.equity).toBeLessThan(0.77);
    // Cross-check heads-up against the independent equityVsRandom-style number:
    // AA vs one random hand is about 85%.
    const hu = equityVsRanges(AA, [], [anyTwo], { iterations: 40000, seed: 5 });
    expect(hu.equity).toBeGreaterThan(0.83);
    expect(hu.equity).toBeLessThan(0.87);
    expect(pre.equity).toBeLessThan(hu.equity);

    // Top set on a rainbow flop: AA gains a lot.
    const set = equityVsRanges(AA, ids('Ad', '7c', '2s'), [anyTwo, anyTwo], { iterations: 20000, seed: 6 });
    expect(set.equity).toBeGreaterThan(pre.equity + 0.15);
    // Monotone diamond flop, hero has no diamond: AA loses ground.
    const wet = equityVsRanges(AA, ids('8d', '9d', 'Td'), [anyTwo, anyTwo], { iterations: 20000, seed: 6 });
    expect(wet.equity).toBeLessThan(pre.equity - 0.1);
  });

  it('preflop equity equals the average flop equity over random flops (martingale check)', () => {
    // Dealing the flop first and then computing equity must average back to
    // the preflop number, because the sampler deals boards uniformly from the
    // cards nobody holds. Per-flop estimates are i.i.d. with that mean, so
    // their empirical spread gives the standard error of the average.
    const anyTwo = anyTwoCardsRange();
    const pre = equityVsRanges(AA, [], [anyTwo, anyTwo], { iterations: 60000, seed: 41 });
    const rng = new SeededRng(77);
    const deck = Array.from({ length: 52 }, (_, i) => i).filter(c => !AA.includes(c));
    const flopEqs: number[] = [];
    for (let f = 0; f < 300; f++) {
      const d = deck.slice();
      for (let i = 0; i < 3; i++) {
        const j = i + rng.nextInt(d.length - i);
        [d[i], d[j]] = [d[j], d[i]];
      }
      flopEqs.push(equityVsRanges(AA, d.slice(0, 3), [anyTwo, anyTwo], { iterations: 400, seed: 500 + f }).equity);
    }
    const mean = flopEqs.reduce((a, b) => a + b, 0) / flopEqs.length;
    const sd = Math.sqrt(flopEqs.reduce((a, b) => a + (b - mean) ** 2, 0) / (flopEqs.length - 1));
    const se = Math.hypot(sd / Math.sqrt(flopEqs.length), pre.stdErr);
    expect(Math.abs(mean - pre.equity)).toBeLessThan(4 * se);
  });

  it('a medium hand loses equity strictly as villains are added', () => {
    const anyTwo = anyTwoCardsRange();
    const results = [1, 2, 3, 4].map(n =>
      equityVsRanges(HERO_99, FLOP, Array(n).fill(anyTwo), { iterations: 30000, seed: 21 }),
    );
    for (let i = 1; i < results.length; i++) {
      const gap = results[i - 1].equity - results[i].equity;
      const se = Math.hypot(results[i - 1].stdErr, results[i].stdErr);
      expect(gap).toBeGreaterThan(4 * se);
    }
  });

  it('identical any-two ranges: hero holding a random hand gets ~1/(N+1)', () => {
    // With every player holding any two cards, the seats are exchangeable, so
    // hero's expected share is exactly 1/(N+1). We average over random hero
    // hands (preflop, so the board is dealt by the sampler too).
    const anyTwo = anyTwoCardsRange();
    const rng = new SeededRng(99);
    for (const n of [1, 2, 3]) {
      let sum = 0;
      let varSum = 0;
      const heroes = 300;
      for (let h = 0; h < heroes; h++) {
        const a = rng.nextInt(52);
        let b = rng.nextInt(51);
        if (b >= a) b++;
        const r = equityVsRanges([a, b], [], Array(n).fill(anyTwo), { iterations: 200, seed: 1000 + h });
        sum += r.equity;
        varSum += r.stdErr * r.stdErr;
      }
      const mean = sum / heroes;
      // Spread across heroes dominates the error; 0.5/sqrt(heroes) bounds the
      // share's standard deviation, plus the within-hero sampling error.
      const se = Math.sqrt(0.25 / heroes + varSum / (heroes * heroes));
      expect(Math.abs(mean - 1 / (n + 1))).toBeLessThan(4 * se);
    }
  });

  it('identical narrow ranges: hero drawn from the same joint deal gets ~1/(N+1)', () => {
    // A medium range (pairs 77+, broadways). To make hero exchangeable with the
    // villains, we draw hero AND N villains as one disjoint tuple from the
    // range (whole-tuple rejection), then ask for hero's equity on a fixed flop.
    const ranks = ['A', 'K', 'Q', 'J', 'T'];
    const suits = ['h', 'd', 'c', 's'];
    const cs: Combo[] = [];
    for (const r of ['A', 'K', 'Q', 'J', 'T', '9', '8', '7']) {
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) cs.push([cid(r + suits[i]), cid(r + suits[j])]);
    }
    for (let x = 0; x < ranks.length; x++) {
      for (let y = x + 1; y < ranks.length; y++) {
        for (const s1 of suits) for (const s2 of suits) cs.push([cid(ranks[x] + s1), cid(ranks[y] + s2)]);
      }
    }
    const board = ids('4c', '3d', '2h'); // blocks nothing in the range
    const range = uniformRange(cs);
    const rng = new SeededRng(4242);
    for (const n of [1, 2]) {
      let sum = 0;
      const deals = 400;
      for (let d = 0; d < deals; d++) {
        let hero: Combo;
        for (;;) {
          const tuple = Array.from({ length: n + 1 }, () => cs[rng.nextInt(cs.length)]);
          const flat = tuple.flat();
          if (new Set(flat).size === flat.length) { hero = tuple[0]; break; }
        }
        sum += equityVsRanges(hero, board, Array(n).fill(range), { iterations: 300, seed: d + 1, exact: false }).equity;
      }
      const mean = sum / deals;
      expect(Math.abs(mean - 1 / (n + 1))).toBeLessThan(4 * Math.sqrt(0.25 / deals));
    }
  });

  it('a board that plays for everyone splits the pot N+1 ways', () => {
    // Royal flush on board: every player ties, hero gets exactly 1/(N+1).
    const board = ids('Ah', 'Kh', 'Qh', 'Jh', 'Th');
    const r2 = equityVsRanges(HERO_99, board, [uniformRange(LOOSE.filter(c => !c.includes(cid('Ah')))), uniformRange(DRAWS)]);
    expect(r2.exact).toBe(true);
    expect(r2.equity).toBeCloseTo(1 / 3, 12);
    expect(r2.tieProb).toBeCloseTo(1, 12);
    const r3 = equityVsRanges(HERO_99, board, [uniformRange(TIGHT), uniformRange(DRAWS), uniformRange(LOOSE)], { iterations: 500 });
    expect(r3.equity).toBeCloseTo(1 / 4, 12);
    expect(r3.stdErr).toBeCloseTo(0, 12);
  });
});

describe('equityVsRanges: card removal', () => {
  it('sampled deals never reuse a card across hero, board, villains and runout', () => {
    const anyTwo = anyTwoCardsRange();
    const sampler = new MultiwayDealSampler(HERO_99, FLOP, [anyTwo, uniformRange(TIGHT), anyTwo], 17);
    for (let i = 0; i < 20000; i++) {
      const d = sampler.deal();
      const all = [...HERO_99, ...FLOP, ...d.villains.flat(), ...d.runout];
      expect(new Set(all).size).toBe(all.length);
      expect(d.runout.length).toBe(2);
    }
  });

  it('villain combos that share a card with hero or the board are excluded', () => {
    // Adding combos blocked by hero (9h) or the board (Kd) must not move equity.
    const base = [...TIGHT, ...LOOSE];
    const blocked = combos(['9h', '9d'], ['Kd', 'Kh'], ['9h', 'Ac'], ['Kd', '2d']);
    const a = equityVsRanges(HERO_99, TURN, [uniformRange(base)]);
    const b = equityVsRanges(HERO_99, TURN, [weighted([...base, ...blocked], [...base.map(() => 1), 50, 50, 50, 50])]);
    expect(b.equity).toBeCloseTo(a.equity, 12);
  });

  it('samples the exact joint distribution, not villain-by-villain', () => {
    // V1 holds AhAd or AcAs; V2 holds AhKh or KcKd (all equal weight). The
    // disjoint deals are (AhAd,KcKd), (AcAs,AhKh), (AcAs,KcKd), equally likely,
    // so each has probability 1/3. Sampling V1 first and then rejecting only V2
    // would give (AhAd,KcKd) probability 1/2 instead.
    const v1 = uniformRange(combos(['Ah', 'Ad'], ['Ac', 'As']));
    const v2 = uniformRange(combos(['Ah', 'Kh'], ['Kc', 'Kd']));
    const board = ids('4s', '5s', '6c'); // blocks none of these cards
    const sampler = new MultiwayDealSampler(HERO_99, board, [v1, v2], 5);
    const counts = new Map<string, number>();
    const N = 30000;
    for (let i = 0; i < N; i++) {
      const d = sampler.deal();
      expect(d.approx).toBe(false);
      const key = d.villains.map(c => c.join('-')).join('|');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(3);
    const se = Math.sqrt((1 / 3) * (2 / 3) / N);
    for (const c of counts.values()) expect(Math.abs(c / N - 1 / 3)).toBeLessThan(4 * se);
  });

  it('ranges that cannot be dealt together fall back without hanging', () => {
    // Both villains can only hold AhAd: no disjoint deal exists.
    const only = uniformRange(combos(['Ah', 'Ad']));
    const r = equityVsRanges(HERO_99, TURN, [only, only], { iterations: 300, seed: 2 });
    expect(r.samples).toBe(300);
    expect(r.approxSamples).toBe(300);
    expect(r.equity).toBeGreaterThanOrEqual(0);
    expect(r.equity).toBeLessThanOrEqual(1);
    // Same on the river, where the exact pair path finds no disjoint pair.
    const rr = equityVsRanges(HERO_99, RIVER, [only, only], { iterations: 300, seed: 2 });
    expect(rr.exact).toBe(false);
    expect(rr.approxSamples).toBe(300);
  });

  it('an empty range (all combos blocked) is treated as any two cards and reported', () => {
    const allBlocked = uniformRange(combos(['9h', 'Ac'], ['Kd', 'Qs']));
    const r = equityVsRanges(HERO_99, FLOP, [allBlocked, uniformRange(TIGHT)], { iterations: 20000, seed: 8 });
    expect(r.randomFallbacks).toBe(1);
    const ref = equityVsRanges(HERO_99, FLOP, [anyTwoCardsRange(), uniformRange(TIGHT)], { iterations: 20000, seed: 8 });
    expect(r.equity).toBeCloseTo(ref.equity, 12); // identical prepared ranges + seed
    const empty = equityVsRanges(HERO_99, FLOP, [{ combos: [], weights: [] }], { iterations: 100 });
    expect(empty.randomFallbacks).toBe(1);
  });
});

describe('equityVsRanges: weights', () => {
  it('a 99%-weight combo dominates (exact heads-up mix)', () => {
    // KK vs {AA at 99, 72o at 1} on a turn: equity is exactly the weighted mix.
    const hero: Combo = [cid('Kh'), cid('Ks')];
    const board = ids('Jc', '8d', '4s', '3h');
    const aa = combos(['Ah', 'Ad']);
    const junk = combos(['7c', '2d']);
    const eqAA = equityVsRanges(hero, board, [uniformRange(aa)]).equity;
    const eqJunk = equityVsRanges(hero, board, [uniformRange(junk)]).equity;
    const mix = equityVsRanges(hero, board, [weighted([...aa, ...junk], [99, 1])]).equity;
    expect(mix).toBeCloseTo(0.99 * eqAA + 0.01 * eqJunk, 12);
    expect(eqAA).toBeLessThan(0.1);
    expect(eqJunk).toBeGreaterThan(0.9);
    expect(mix).toBeLessThan(0.11);
  });

  it('a 99%-weight combo dominates multiway (Monte Carlo)', () => {
    const hero: Combo = [cid('Kh'), cid('Ks')];
    const board = ids('Jc', '8d', '4s');
    const heavyAA = weighted(combos(['Ah', 'Ad'], ['7c', '2d']), [99, 1]);
    const otherV = uniformRange(LOOSE);
    const r = equityVsRanges(hero, board, [heavyAA, otherV], { iterations: 30000, seed: 31 });
    const onlyAA = equityVsRanges(hero, board, [uniformRange(combos(['Ah', 'Ad'])), otherV], { iterations: 30000, seed: 32 });
    const onlyJunk = equityVsRanges(hero, board, [uniformRange(combos(['7c', '2d'])), otherV], { iterations: 30000, seed: 33 });
    // Within noise of the 99/1 mix, and far from the junk-only number.
    const target = 0.99 * onlyAA.equity + 0.01 * onlyJunk.equity;
    expect(Math.abs(r.equity - target)).toBeLessThan(4 * Math.hypot(r.stdErr, onlyAA.stdErr, onlyJunk.stdErr));
    expect(onlyJunk.equity - r.equity).toBeGreaterThan(0.3);
  });
});

describe('equityVsRanges: API behaviour', () => {
  it('is reproducible for a seed and varies across seeds', () => {
    const ranges = [anyTwoCardsRange(), uniformRange(LOOSE)];
    const a = equityVsRanges(HERO_99, FLOP, ranges, { iterations: 2000, seed: 123 });
    const b = equityVsRanges(HERO_99, FLOP, ranges, { iterations: 2000, seed: 123 });
    const c = equityVsRanges(HERO_99, FLOP, ranges, { iterations: 2000, seed: 124 });
    expect(b).toEqual(a);
    expect(c.equity).not.toBe(a.equity);
  });

  it('reports a sane standard error that shrinks with more samples', () => {
    const ranges = [anyTwoCardsRange(), anyTwoCardsRange()];
    const small = equityVsRanges(HERO_99, FLOP, ranges, { iterations: 1000, seed: 1 });
    const big = equityVsRanges(HERO_99, FLOP, ranges, { iterations: 16000, seed: 1 });
    expect(small.stdErr).toBeGreaterThan(0);
    expect(small.stdErr).toBeLessThan(0.5 / Math.sqrt(1000) + 1e-9);
    // 16x the samples -> about a quarter of the standard error.
    expect(big.stdErr / small.stdErr).toBeGreaterThan(0.2);
    expect(big.stdErr / small.stdErr).toBeLessThan(0.3);
  });

  it('honours the time budget', () => {
    const anyTwo = anyTwoCardsRange();
    const r = equityVsRanges(HERO_99, [], [anyTwo, anyTwo, anyTwo], { iterations: 10_000_000, timeBudgetMs: 20, seed: 1 });
    expect(r.samples).toBeGreaterThanOrEqual(128);
    expect(r.samples).toBeLessThan(10_000_000);
  });

  it('no villains means hero takes the pot; bad input throws', () => {
    expect(equityVsRanges(HERO_99, FLOP, []).equity).toBe(1);
    expect(() => equityVsRanges(HERO_99, [cid('9h'), cid('2c'), cid('3d')], [anyTwoCardsRange()])).toThrow(RangeError);
    expect(() => equityVsRanges(HERO_99, FLOP, Array(23).fill(anyTwoCardsRange()))).toThrow(RangeError);
  });

  it('equityVsVillains is a thin wrapper over VillainRange records', () => {
    const villains = [
      { playerIndex: 2, range: uniformRange(TIGHT) },
      { playerIndex: 4, range: uniformRange(LOOSE) },
    ];
    const a = equityVsVillains(HERO_99, RIVER, villains);
    const b = equityVsRanges(HERO_99, RIVER, villains.map(v => v.range));
    expect(a).toEqual(b);
  });

  it('meets the latency targets (loose bounds; see multiway-bench.ts for timings)', () => {
    // Warm up the evaluator memo tables and JIT first.
    const anyTwo = anyTwoCardsRange();
    equityVsRanges(HERO_99, FLOP, [anyTwo, anyTwo, anyTwo], { iterations: 5000, seed: 1 });
    let t0 = performance.now();
    equityVsRanges(HERO_99, FLOP, [anyTwo, anyTwo, anyTwo], { iterations: 5000, seed: 2 });
    const flop3 = performance.now() - t0;
    const river300 = uniformRange(anyTwoCardsRange().combos.filter(c => !c.some(x => [...HERO_99, ...RIVER].includes(x))).slice(0, 300));
    equityVsRanges(HERO_99, RIVER, [river300]);
    t0 = performance.now();
    equityVsRanges(HERO_99, RIVER, [river300]);
    const river1 = performance.now() - t0;
    // Targets are 30 ms and 10 ms; allow 4x headroom for a loaded CI machine.
    expect(flop3).toBeLessThan(120);
    expect(river1).toBeLessThan(40);
  });
});
