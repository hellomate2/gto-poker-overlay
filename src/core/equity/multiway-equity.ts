import { CardId } from '../../types/poker';
import { SeededRng } from '../../solver/rng';
import { evaluateHand } from './hand-eval';
import { normalizeRange, VillainRange, WeightedRange } from '../ranges/weighted-range';

// ============================================================
// True Multiway Equity: hero vs N weighted villain ranges at once.
//
// The older equity helpers (range-equity.ts, monte-carlo.ts) are heads-up:
// they score hero against ONE villain hand at a time. In a 3-way pot that
// overstates hero's equity badly, because hero has to beat EVERY live
// opponent, not just one. A medium pair that is 60% against one range can be
// well under 40% against two copies of that same range.
//
// equityVsRanges() measures the real thing:
//
//   equity = E[ hero's share of the pot at showdown ]
//
// where a sole best hand takes the whole pot (share 1), a k-way tie for best
// that includes hero gives hero 1/k, and anything else gives 0. Side pots are
// out of scope (all players are assumed to see the whole pot).
//
// ---- The joint deal distribution ----------------------------------------
// Each villain i holds a weighted range w_i(combo). The correct joint
// distribution over the villains' holdings, given hero's cards and the board,
// is
//
//   P(c_1, ..., c_N)  proportional to  w_1(c_1) * ... * w_N(c_N) * [all disjoint]
//
// i.e. the product of the individual ranges restricted to deals where no card
// appears twice. We sample it EXACTLY with whole-tuple rejection: draw every
// villain's combo independently from its own weights, and if any two villains
// share a card, throw the WHOLE tuple away and redraw. (Redrawing only the
// later villain would be biased: it lets villain 1 ignore how much of villain
// 2's range its cards block.) In the rare spot where the ranges overlap so
// heavily that whole-tuple rejection keeps failing, we fall back to drawing
// villains one at a time from what is left (an approximation, counted in
// `approxSamples`).
//
// After the villains are dealt, the remaining board cards are drawn uniformly
// from the cards nobody holds.
//
// ---- Exact paths ----------------------------------------------------------
//  - One villain with <= 2 board cards to come: every combo and every runout
//    is enumerated exactly. For uniform weights this equals the existing
//    heads-up equityVsRange() to floating-point precision.
//  - Two villains on the river: every disjoint combo pair is enumerated using
//    per-combo hand ranks computed once (cheap: no runouts left).
// Everything else is seeded Monte Carlo, reproducible for a given seed.
//
// ---- Empty ranges ----------------------------------------------------------
// A villain whose range is empty after card removal (every combo blocked by
// hero/board, or no positive weight) is treated as holding ANY TWO cards
// (uniform over the unblocked combos) and counted in `randomFallbacks`.
// Dropping that villain instead would overstate hero's equity.
// ============================================================

export interface MultiwayEquityOptions {
  /** Monte Carlo samples (deals). Ignored on the exact paths. Default 5000. */
  iterations?: number;
  /** RNG seed for reproducible sampling. Default 1. */
  seed?: number;
  /**
   * Wall-clock cap for Monte Carlo sampling in ms. Checked every 128 samples,
   * so at least 128 samples are always taken. Ignored on the exact paths.
   */
  timeBudgetMs?: number;
  /**
   * Use exact enumeration where it is available (default true). Set false to
   * force Monte Carlo, e.g. a one-villain flop with a 1000+ combo range under a
   * tight time budget (exact costs about combos * 990 villain evaluations).
   */
  exact?: boolean;
}

export interface MultiwayEquityResult {
  /** Expected share of the pot at showdown, 0..1 (ties split among tied players). */
  equity: number;
  /** Probability hero holds the sole best hand. */
  winProb: number;
  /** Probability hero ties for the best hand with at least one villain. */
  tieProb: number;
  /** Showdowns evaluated (Monte Carlo deals, or enumerated runouts on an exact path). */
  samples: number;
  /** Standard error of `equity`. 0 on the exact paths. */
  stdErr: number;
  /** True when the result came from exact enumeration. */
  exact: boolean;
  /** Number of villains in the computation. */
  villains: number;
  /** Villains whose range was empty after card removal and were treated as any two cards. */
  randomFallbacks: number;
  /** Monte Carlo deals that used the approximate sequential fallback (heavy range overlap). */
  approxSamples: number;
}

const DEFAULT_ITERATIONS = 5000;
const DEFAULT_SEED = 1;
/** Whole-tuple redraws before switching to the sequential fallback for one deal. */
const MAX_TUPLE_TRIES = 200;
/** Above this many combo pairs the 2-villain river spot is sampled instead. */
const RIVER_PAIR_EXACT_LIMIT = 250_000;
/** How often (in samples) the time budget is checked. */
const BUDGET_CHECK_EVERY = 128;

// ------------------------------------------------------------
// Range helpers
// ------------------------------------------------------------

/** Wrap a plain combo list (the old `[CardId, CardId][]` ranges) as a uniform WeightedRange. */
export function uniformRange(combos: [CardId, CardId][]): WeightedRange {
  return { combos: combos.slice(), weights: combos.map(() => 1) };
}

/** All 1326 two-card combos with equal weight: a villain who could hold anything. */
export function anyTwoCardsRange(): WeightedRange {
  const combos: [CardId, CardId][] = [];
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) combos.push([a, b]);
  }
  return uniformRange(combos);
}

// ------------------------------------------------------------
// Internal prepared form of the inputs
// ------------------------------------------------------------

interface PreparedRange {
  lo: Int8Array; // first card of each combo
  hi: Int8Array; // second card of each combo
  weights: Float64Array; // normalized to sum 1
  cumulative: Float64Array; // running sum of weights, last entry ~1
}

interface Prepared {
  hero: [CardId, CardId];
  board: CardId[];
  cardsToCome: number;
  ranges: PreparedRange[];
  /** Cards not held by hero and not on the board. */
  live: CardId[];
  randomFallbacks: number;
}

function prepareRange(range: WeightedRange, dead: CardId[]): PreparedRange | null {
  const norm = normalizeRange(range, dead);
  const n = norm.combos.length;
  if (n === 0) return null;
  const lo = new Int8Array(n);
  const hi = new Int8Array(n);
  const weights = new Float64Array(n);
  const cumulative = new Float64Array(n);
  let run = 0;
  for (let i = 0; i < n; i++) {
    lo[i] = norm.combos[i][0];
    hi[i] = norm.combos[i][1];
    weights[i] = norm.weights[i];
    run += norm.weights[i];
    cumulative[i] = run;
  }
  return { lo, hi, weights, cumulative };
}

function prepare(
  heroCards: [CardId, CardId],
  board: CardId[],
  ranges: WeightedRange[],
): Prepared {
  if (board.length > 5) throw new RangeError(`board has ${board.length} cards (max 5)`);
  const dead = [heroCards[0], heroCards[1], ...board];
  const seen = new Set<CardId>();
  for (const c of dead) {
    if (!(c >= 0 && c < 52) || !Number.isInteger(c)) throw new RangeError(`invalid card id ${c}`);
    if (seen.has(c)) throw new RangeError(`duplicate card ${c} in hero cards + board`);
    seen.add(c);
  }

  let randomFallbacks = 0;
  let anyTwo: WeightedRange | null = null;
  const prepared: PreparedRange[] = [];
  for (const r of ranges) {
    let p = prepareRange(r, dead);
    if (!p) {
      // Empty after card removal: assume any two unblocked cards.
      anyTwo = anyTwo ?? anyTwoCardsRange();
      p = prepareRange(anyTwo, dead)!;
      randomFallbacks++;
    }
    prepared.push(p);
  }

  // Hero (2) + full board (5) + 2 per villain must fit in one deck.
  if (7 + 2 * ranges.length > 52) throw new RangeError(`too many villains (${ranges.length}) for one deck`);

  const live: CardId[] = [];
  for (let c = 0; c < 52; c++) if (!seen.has(c)) live.push(c);

  return { hero: heroCards, board: board.slice(), cardsToCome: 5 - board.length, ranges: prepared, live, randomFallbacks };
}

/** Index of the combo whose cumulative-weight bucket contains u (u in [0,1)). */
function pickWeighted(r: PreparedRange, u: number): number {
  const cum = r.cumulative;
  const target = u * cum[cum.length - 1];
  // Binary search for the first index with cumulative > target.
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Hero's pot share for one showdown, given hero's rank and the villains'
 * ranks (higher rank == better hand). Returns 1 for a sole win, 1/k for a
 * k-way tie for best that includes hero, 0 otherwise.
 */
function potShare(heroRank: number, villainRanks: ArrayLike<number>, n: number): number {
  let tied = 1;
  for (let i = 0; i < n; i++) {
    const v = villainRanks[i];
    if (v > heroRank) return 0;
    if (v === heroRank) tied++;
  }
  return 1 / tied;
}

// ------------------------------------------------------------
// Deal sampler (exported for tests and for callers that want raw deals)
// ------------------------------------------------------------

export interface SampledDeal {
  /** villains[i] = [lo, hi] combo dealt to villain i. */
  villains: [CardId, CardId][];
  /** The board cards dealt to complete the board (length 5 - board.length). */
  runout: CardId[];
  /** True if this deal came from the sequential fallback (approximate). */
  approx: boolean;
}

/**
 * Seeded sampler of complete deals (one combo per villain plus a runout) from
 * the joint distribution described in the header. Allocation-free on the hot
 * path: `next()` writes into internal typed arrays; `deal()` copies them out.
 */
export class MultiwayDealSampler {
  readonly prepared: Prepared;
  private readonly rng: SeededRng;
  /** villainCards[2i], villainCards[2i+1] = villain i's cards after next(). */
  readonly villainCards: Int8Array;
  /** Picked combo index per villain after next() (into prepared.ranges[i]). */
  readonly comboIndex: Int32Array;
  /** Runout cards after next(). */
  readonly runout: Int8Array;
  /** Stamp per card id: equals `stamp` when the card is used in the current deal. */
  private readonly used: Int32Array;
  private stamp = 0;

  constructor(heroCards: [CardId, CardId], board: CardId[], ranges: WeightedRange[], seed = DEFAULT_SEED) {
    this.prepared = prepare(heroCards, board, ranges);
    this.rng = new SeededRng(seed);
    const n = this.prepared.ranges.length;
    this.villainCards = new Int8Array(2 * n);
    this.comboIndex = new Int32Array(n);
    this.runout = new Int8Array(this.prepared.cardsToCome);
    this.used = new Int32Array(52);
  }

  /**
   * Deal the next sample into the internal buffers.
   * @returns true if the deal is from the approximate sequential fallback.
   */
  next(): boolean {
    const ranges = this.prepared.ranges;
    const n = ranges.length;
    const used = this.used;
    let approx = false;
    // Stamps grow by up to MAX_TUPLE_TRIES + 1 per deal; recycle them long
    // before they could overflow the Int32Array.
    if (this.stamp > 1 << 30) {
      used.fill(0);
      this.stamp = 0;
    }

    // ---- Villains: whole-tuple rejection (exact joint distribution) ----
    let ok = false;
    for (let attempt = 0; attempt < MAX_TUPLE_TRIES && !ok; attempt++) {
      const s = ++this.stamp;
      ok = true;
      for (let i = 0; i < n; i++) {
        const r = ranges[i];
        const k = pickWeighted(r, this.rng.next());
        const a = r.lo[k];
        const b = r.hi[k];
        if (used[a] === s || used[b] === s) {
          ok = false;
          break;
        }
        used[a] = s;
        used[b] = s;
        this.comboIndex[i] = k;
        this.villainCards[2 * i] = a;
        this.villainCards[2 * i + 1] = b;
      }
    }

    if (!ok) {
      // ---- Sequential fallback: each villain from what is left ----
      // Approximate (ignores how earlier villains' cards shrink later ranges'
      // total mass), but always produces a valid deal.
      approx = true;
      const s = ++this.stamp;
      for (let i = 0; i < n; i++) {
        const r = ranges[i];
        // Collect the still-available combos' weights.
        let total = 0;
        for (let k = 0; k < r.lo.length; k++) {
          if (used[r.lo[k]] !== s && used[r.hi[k]] !== s) total += r.weights[k];
        }
        let a = -1;
        let b = -1;
        if (total > 0) {
          let target = this.rng.next() * total;
          for (let k = 0; k < r.lo.length; k++) {
            if (used[r.lo[k]] === s || used[r.hi[k]] === s) continue;
            target -= r.weights[k];
            a = r.lo[k];
            b = r.hi[k];
            this.comboIndex[i] = k;
            if (target < 0) break;
          }
        } else {
          // Nothing in this range survives: deal two random live cards.
          a = this.drawLiveCard(s);
          used[a] = s;
          b = this.drawLiveCard(s);
          if (a > b) [a, b] = [b, a];
          this.comboIndex[i] = -1;
        }
        used[a] = s;
        used[b] = s;
        this.villainCards[2 * i] = a;
        this.villainCards[2 * i + 1] = b;
      }
    }

    // ---- Runout: uniform over cards nobody holds ----
    const s = this.stamp;
    for (let j = 0; j < this.runout.length; j++) {
      const c = this.drawLiveCard(s);
      used[c] = s;
      this.runout[j] = c;
    }
    return approx;
  }

  /** next() plus a copy of the deal as plain arrays (convenient for tests). */
  deal(): SampledDeal {
    const approx = this.next();
    const villains: [CardId, CardId][] = [];
    for (let i = 0; i < this.comboIndex.length; i++) {
      villains.push([this.villainCards[2 * i], this.villainCards[2 * i + 1]]);
    }
    return { villains, runout: Array.from(this.runout), approx };
  }

  /** Uniform live card not stamped `s`, by rejection (few cards are ever used). */
  private drawLiveCard(s: number): CardId {
    const live = this.prepared.live;
    for (;;) {
      const c = live[this.rng.nextInt(live.length)];
      if (this.used[c] !== s) return c;
    }
  }
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

/**
 * Hero's equity (expected pot share at showdown) against every villain at once.
 *
 * @param heroCards Hero's two hole cards.
 * @param board     Community cards so far (0, 3, 4 or 5; any 0..5 is accepted).
 * @param ranges    One WeightedRange per villain still in the hand. Weights are
 *                  relative; combos blocked by hero/board are dropped. Pass []
 *                  for "no opponents" (hero takes the pot: equity 1).
 * @param opts      iterations / seed / timeBudgetMs / exact (see MultiwayEquityOptions).
 * @throws RangeError if hero cards + board contain a duplicate or invalid card.
 */
export function equityVsRanges(
  heroCards: [CardId, CardId],
  board: CardId[],
  ranges: WeightedRange[],
  opts: MultiwayEquityOptions = {},
): MultiwayEquityResult {
  const sampler = new MultiwayDealSampler(heroCards, board, ranges, opts.seed ?? DEFAULT_SEED);
  const p = sampler.prepared;
  const n = p.ranges.length;

  if (n === 0) {
    return {
      equity: 1, winProb: 1, tieProb: 0, samples: 0, stdErr: 0,
      exact: true, villains: 0, randomFallbacks: 0, approxSamples: 0,
    };
  }
  const allowExact = opts.exact ?? true;
  if (allowExact && n === 1 && p.cardsToCome <= 2) return exactHeadsUp(p);
  if (allowExact && n === 2 && p.cardsToCome === 0) {
    const pairs = p.ranges[0].lo.length * p.ranges[1].lo.length;
    if (pairs <= RIVER_PAIR_EXACT_LIMIT) {
      const exact = exactRiverTwoVillains(p);
      if (exact) return exact;
    }
  }
  return monteCarlo(sampler, opts);
}

/** Convenience overload for callers holding VillainRange records. */
export function equityVsVillains(
  heroCards: [CardId, CardId],
  board: CardId[],
  villains: VillainRange[],
  opts: MultiwayEquityOptions = {},
): MultiwayEquityResult {
  return equityVsRanges(heroCards, board, villains.map(v => v.range), opts);
}

// ------------------------------------------------------------
// Monte Carlo path
// ------------------------------------------------------------

function monteCarlo(sampler: MultiwayDealSampler, opts: MultiwayEquityOptions): MultiwayEquityResult {
  const p = sampler.prepared;
  const n = p.ranges.length;
  const iterations = Math.max(1, Math.floor(opts.iterations ?? DEFAULT_ITERATIONS));
  const budget = opts.timeBudgetMs;
  const t0 = budget !== undefined ? performance.now() : 0;
  const boardLen = p.board.length;

  // Reusable 7-card hands: [hole0, hole1, board0..board4].
  const heroHand: number[] = [p.hero[0], p.hero[1], 0, 0, 0, 0, 0];
  const villHand: number[] = [0, 0, 0, 0, 0, 0, 0];
  const fullBoard: number[] = [0, 0, 0, 0, 0];
  for (let j = 0; j < boardLen; j++) fullBoard[j] = p.board[j];
  const villRanks = new Float64Array(n);

  // On the river nothing is left to deal, so every combo's rank is fixed:
  // compute it once per combo instead of once per sample.
  let riverRanks: Int32Array[] | null = null;
  let heroRiverRank = 0;
  if (p.cardsToCome === 0) {
    heroRiverRank = evaluateHand([p.hero[0], p.hero[1], ...p.board]);
    riverRanks = p.ranges.map(r => {
      const out = new Int32Array(r.lo.length);
      for (let k = 0; k < r.lo.length; k++) out[k] = evaluateHand([r.lo[k], r.hi[k], ...p.board]);
      return out;
    });
  }

  let sum = 0; // sum of shares
  let sumSq = 0; // sum of squared shares (for the standard error)
  let wins = 0;
  let ties = 0;
  let approxSamples = 0;
  let samples = 0;

  for (let s = 0; s < iterations; s++) {
    if (budget !== undefined && s > 0 && s % BUDGET_CHECK_EVERY === 0 && performance.now() - t0 > budget) break;
    const approx = sampler.next();
    if (approx) approxSamples++;

    let heroRank: number;
    const comboIdx = sampler.comboIndex;
    // A fallback deal may hold random cards outside the range (index -1).
    let cached = riverRanks !== null;
    if (cached && approx) for (let i = 0; i < n; i++) if (comboIdx[i] < 0) cached = false;
    if (riverRanks && cached) {
      heroRank = heroRiverRank;
      for (let i = 0; i < n; i++) villRanks[i] = riverRanks[i][comboIdx[i]];
    } else {
      for (let j = boardLen; j < 5; j++) fullBoard[j] = sampler.runout[j - boardLen];
      for (let j = 0; j < 5; j++) {
        heroHand[2 + j] = fullBoard[j];
        villHand[2 + j] = fullBoard[j];
      }
      heroRank = evaluateHand(heroHand);
      for (let i = 0; i < n; i++) {
        villHand[0] = sampler.villainCards[2 * i];
        villHand[1] = sampler.villainCards[2 * i + 1];
        villRanks[i] = evaluateHand(villHand);
      }
    }

    const share = potShare(heroRank, villRanks, n);
    sum += share;
    sumSq += share * share;
    if (share === 1) wins++;
    else if (share > 0) ties++;
    samples++;
  }

  const mean = sum / samples;
  // Sample variance of the per-deal share (Bessel-corrected), then SE of the mean.
  const variance = samples > 1 ? Math.max(0, (sumSq - samples * mean * mean) / (samples - 1)) : 0.25;
  return {
    equity: mean,
    winProb: wins / samples,
    tieProb: ties / samples,
    samples,
    stdErr: Math.sqrt(variance / samples),
    exact: false,
    villains: n,
    randomFallbacks: p.randomFallbacks,
    approxSamples,
  };
}

// ------------------------------------------------------------
// Exact path: one villain, <= 2 board cards to come
// ------------------------------------------------------------

/**
 * Enumerates every (combo, runout). Each combo's showdown outcomes are
 * averaged over its runouts, then combos are mixed by their normalized
 * weights. Every combo has the same number of runouts (the deck minus the
 * same count of known cards), so with uniform weights this is the plain
 * average over all showdowns, which is exactly what range-equity.ts computes.
 *
 * Hero's rank depends only on the runout, so it is cached per runout
 * (river card, or turn+river pair) and evaluated once instead of per combo.
 */
function exactHeadsUp(p: Prepared): MultiwayEquityResult {
  const r = p.ranges[0];
  const live = p.live;
  const board = p.board;
  const ctc = p.cardsToCome;
  const bl = board.length; // 3, 4 or 5 here
  // Reusable 7-card hands: [hole0, hole1, board..., runout...].
  const heroHand: number[] = [p.hero[0], p.hero[1], 0, 0, 0, 0, 0];
  const villHand: number[] = [0, 0, 0, 0, 0, 0, 0];
  for (let j = 0; j < bl; j++) {
    heroHand[2 + j] = board[j];
    villHand[2 + j] = board[j];
  }

  // Hero rank per runout: index c (1 card to come) or a*52+b (2 to come).
  // 0 means "not computed yet" (every real rank is >= 1).
  const heroRankCache = new Int32Array(ctc === 2 ? 52 * 52 : 52);
  const heroRiverRank = ctc === 0 ? evaluateHand(heroHand) : 0;
  const heroRankFor = (a: number, b: number): number => {
    const key = ctc === 2 ? a * 52 + b : a;
    let v = heroRankCache[key];
    if (v === 0) {
      heroHand[2 + bl] = a;
      if (ctc === 2) heroHand[3 + bl] = b;
      v = evaluateHand(heroHand);
      heroRankCache[key] = v;
    }
    return v;
  };

  let equity = 0;
  let winProb = 0;
  let tieProb = 0;
  let samples = 0;

  for (let k = 0; k < r.lo.length; k++) {
    const va = r.lo[k];
    const vb = r.hi[k];
    villHand[0] = va;
    villHand[1] = vb;
    // Per-combo tallies over its runouts.
    let cWin = 0;
    let cTie = 0;
    let count = 0;

    if (ctc === 0) {
      const v = evaluateHand(villHand);
      if (heroRiverRank > v) cWin++;
      else if (heroRiverRank === v) cTie++;
      count = 1;
    } else if (ctc === 1) {
      for (let i = 0; i < live.length; i++) {
        const c = live[i];
        if (c === va || c === vb) continue;
        villHand[2 + bl] = c;
        const h = heroRankFor(c, 0);
        const v = evaluateHand(villHand);
        if (h > v) cWin++;
        else if (h === v) cTie++;
        count++;
      }
    } else {
      for (let i = 0; i < live.length; i++) {
        const a = live[i];
        if (a === va || a === vb) continue;
        villHand[2 + bl] = a;
        for (let j = i + 1; j < live.length; j++) {
          const b = live[j];
          if (b === va || b === vb) continue;
          villHand[3 + bl] = b;
          const h = heroRankFor(a, b);
          const v = evaluateHand(villHand);
          if (h > v) cWin++;
          else if (h === v) cTie++;
          count++;
        }
      }
    }

    // Heads-up a tie splits the pot in two, so it is worth half.
    const w = r.weights[k] / count;
    equity += w * (cWin + 0.5 * cTie);
    winProb += w * cWin;
    tieProb += w * cTie;
    samples += count;
  }

  return {
    equity, winProb, tieProb, samples, stdErr: 0,
    exact: true, villains: 1, randomFallbacks: p.randomFallbacks, approxSamples: 0,
  };
}

// ------------------------------------------------------------
// Exact path: two villains on the river
// ------------------------------------------------------------

/**
 * With the board complete every combo's rank is fixed, so the exact joint
 * expectation is a double sum over disjoint combo pairs:
 *
 *   equity = sum_{a,b disjoint} w1(a) w2(b) share(h, r1(a), r2(b)) / Z
 *   Z      = sum_{a,b disjoint} w1(a) w2(b)
 *
 * (Z < 1 because pairs sharing a card are excluded and the rest renormalized.)
 */
function exactRiverTwoVillains(p: Prepared): MultiwayEquityResult | null {
  const [r1, r2] = p.ranges;
  const board = p.board;
  const h = evaluateHand([p.hero[0], p.hero[1], ...board]);
  const rank1 = new Int32Array(r1.lo.length);
  const rank2 = new Int32Array(r2.lo.length);
  for (let a = 0; a < r1.lo.length; a++) rank1[a] = evaluateHand([r1.lo[a], r1.hi[a], ...board]);
  for (let b = 0; b < r2.lo.length; b++) rank2[b] = evaluateHand([r2.lo[b], r2.hi[b], ...board]);

  const pair = new Float64Array(2);
  let z = 0;
  let eq = 0;
  let win = 0;
  let tie = 0;
  let samples = 0;
  for (let a = 0; a < r1.lo.length; a++) {
    const a0 = r1.lo[a];
    const a1 = r1.hi[a];
    const wa = r1.weights[a];
    pair[0] = rank1[a];
    for (let b = 0; b < r2.lo.length; b++) {
      const b0 = r2.lo[b];
      const b1 = r2.hi[b];
      if (b0 === a0 || b0 === a1 || b1 === a0 || b1 === a1) continue;
      const w = wa * r2.weights[b];
      pair[1] = rank2[b];
      const share = potShare(h, pair, 2);
      z += w;
      eq += w * share;
      if (share === 1) win += w;
      else if (share > 0) tie += w;
      samples++;
    }
  }

  // Every pair collides: the two ranges cannot be dealt together at all. The
  // caller falls back to sampling (which uses the sequential approximation).
  if (z <= 0) return null;
  return {
    equity: eq / z, winProb: win / z, tieProb: tie / z, samples, stdErr: 0,
    exact: true, villains: 2, randomFallbacks: p.randomFallbacks, approxSamples: 0,
  };
}
