// ============================================================
// Perfect-hash lookup tables for the poker hand evaluator.
//
// Algorithm ported from phevaluator by Henry Lee,
//   Apache-2.0, https://github.com/HenryRLee/PokerHandEvaluator
//
// This file PORTS the technique (it does not copy verbatim source):
//   * A "rank" lookup for non-flush hands, keyed by a dynamic-programming
//     perfect hash of the quinary (per-rank count) vector.
//   * A "flush" lookup for flush hands, keyed by the 13-bit mask of which
//     ranks are present in the flush suit.
//
// We generate both tables at module load. Generation enumerates the 7462
// distinct 5-card equivalence classes once, ranks them strongest->weakest,
// then fills the lookup tables. Generation is deterministic and fast
// (a few milliseconds), so the tables are reproducible rather than being
// committed as opaque magic numbers.
//
// CONVENTION (internal): a smaller value == a stronger hand, matching
// phevaluator. Values run 1 (royal flush) .. 7462 (7-5-4-3-2 high card).
// The public hand-eval.ts wrapper converts this to the project's
// "higher == better, category*1e6 + tiebreaker" convention.
// ============================================================

export const NUM_EQUIV_CLASSES = 7462;

// Internal hand-category ordering, strongest first. Used only for ranking
// the equivalence classes during table generation.
const enum Cat {
  STRAIGHT_FLUSH = 8,
  QUADS = 7,
  FULL_HOUSE = 6,
  FLUSH = 5,
  STRAIGHT = 4,
  TRIPS = 3,
  TWO_PAIR = 2,
  PAIR = 1,
  HIGH_CARD = 0,
}

// ---- Dynamic-programming perfect hash over the quinary vector ----------
//
// A 5..7 card hand without regard to suit is described by a "quinary"
// vector: for each of the 13 ranks, how many copies are present (0..4),
// with the counts summing to the number of cards. phevaluator assigns each
// such vector a unique, gap-free index via a DP table `dp[c][r][k]` =
// number of quinary vectors using exactly `k` cards drawn from the lowest
// `r` ranks where no single rank exceeds `c` copies.
//
// We use this hash to key the non-flush rank lookup. The table is sized to
// the maximum hash value for 7 cards.

const MAX_CARDS = 7;
const NUM_RANKS = 13;
const MAX_PER_RANK = 4;

// dp[k][r] over a fixed per-rank cap. We build a full dp[cap+1][cards+1][ranks+1].
function buildDP(): number[][][] {
  // dp[c][k][r] = number of ways to choose a quinary vector of total k cards
  // over the first r ranks, with each rank count in [0..c].
  const dp: number[][][] = [];
  for (let c = 0; c <= MAX_PER_RANK; c++) {
    dp[c] = [];
    for (let k = 0; k <= MAX_CARDS; k++) {
      dp[c][k] = new Array(NUM_RANKS + 1).fill(0);
    }
  }
  for (let c = 0; c <= MAX_PER_RANK; c++) {
    // zero ranks -> only k=0 is achievable (1 way)
    dp[c][0][0] = 1;
    for (let r = 1; r <= NUM_RANKS; r++) {
      for (let k = 0; k <= MAX_CARDS; k++) {
        let sum = 0;
        for (let i = 0; i <= Math.min(c, k); i++) {
          sum += dp[c][k - i][r - 1];
        }
        dp[c][k][r] = sum;
      }
    }
  }
  return dp;
}

const DP = buildDP();

/**
 * Perfect hash of a quinary vector (length 13, counts low-rank .. high-rank
 * or any fixed order — we use index 0..12 == rank 2..A) into a dense index.
 *
 * Ported from phevaluator's `hash_quinary`.
 */
export function hashQuinary(quinary: Uint8Array | number[], numCards: number): number {
  let sum = 0;
  let k = numCards;
  // iterate ranks from high index (12) down to 0
  for (let r = NUM_RANKS; r >= 1; r--) {
    const cnt = quinary[r - 1];
    // number of vectors that come "before" this one at this rank position
    for (let i = 0; i < cnt; i++) {
      sum += DP[MAX_PER_RANK][k - i][r - 1];
    }
    k -= cnt;
  }
  return sum;
}

// Largest hash value we can produce for 7 cards, +1 for table size.
function maxHash(numCards: number): number {
  // The maximum index is hashing the lexicographically-last vector; simplest
  // is to take the total count of distinct vectors for `numCards` cards,
  // which equals dp[4][numCards][13].
  return DP[MAX_PER_RANK][numCards][NUM_RANKS];
}

const RANK_TABLE_SIZE = maxHash(MAX_CARDS); // covers 5,6,7-card quinaries

// ---- Equivalence-class ranking -----------------------------------------
//
// We enumerate every distinct 5-card hand *shape* and assign a strength
// rank (1 = strongest). Two pieces:
//   (a) flush / straight-flush shapes, keyed by rank-mask
//   (b) non-flush shapes (high card, pair, two pair, trips, straight,
//       full house, quads), keyed by quinary vector.
//
// "Rank value" within a category is computed from the relevant tiebreak
// information, then categories are concatenated in strength order so the
// final value is globally ordered.

// rank index: 2->0 .. A->12. Straights as 5-card rank-masks (high card index).
// 10 straights: A-high(broadway) down to 5-high(wheel).
const STRAIGHT_MASKS: number[] = (() => {
  const masks: number[] = [];
  // broadway A K Q J T -> bits 12,11,10,9,8
  for (let high = 12; high >= 4; high--) {
    let m = 0;
    for (let i = 0; i < 5; i++) m |= 1 << (high - i);
    masks.push(m);
  }
  // wheel: A,5,4,3,2 -> bits 12,3,2,1,0
  masks.push((1 << 12) | (1 << 3) | (1 << 2) | (1 << 1) | (1 << 0));
  return masks; // length 10, index 0 = strongest (broadway)
})();

const STRAIGHT_MASK_SET = new Set(STRAIGHT_MASKS);

// Build the flush lookup: maps a 13-bit rank-mask (popcount>=5 reduced to the
// best 5) to a strength value. We populate masks of popcount exactly 5 here;
// at eval time a >5 flush is reduced to its best-5 sub-mask.
const FLUSH_TABLE = new Int16Array(1 << NUM_RANKS).fill(0);

// Build the non-flush rank lookup keyed by quinary hash.
const RANK_TABLE = new Int16Array(RANK_TABLE_SIZE).fill(0);

// ---- helpers for tiebreak values ----
// Encode a descending list of rank indices into a base-13 number (high first).
function packRanks(ranksDesc: number[]): number {
  let v = 0;
  for (const r of ranksDesc) v = v * 13 + r;
  return v;
}

// Generate all 5-card non-flush "shapes" as quinary vectors and rank them.
// We produce, per category, a list of {quinary, tiebreak} entries, sort the
// whole thing by (category strength, tiebreak), and assign sequential values.

interface Shape {
  cat: number;
  tiebreak: number; // higher = stronger within category
  quinary?: number[]; // for non-flush
  mask?: number; // for flush / straight-flush (13-bit)
}

function allShapes(): Shape[] {
  const shapes: Shape[] = [];

  // ---- straight flushes (10) ----
  for (let i = 0; i < STRAIGHT_MASKS.length; i++) {
    // tiebreak: broadway strongest. i=0 strongest -> larger tiebreak.
    shapes.push({ cat: Cat.STRAIGHT_FLUSH, tiebreak: STRAIGHT_MASKS.length - i, mask: STRAIGHT_MASKS[i] });
  }

  // ---- quads (156) : quad rank q, kicker k != q ----
  for (let q = 12; q >= 0; q--) {
    for (let k = 12; k >= 0; k--) {
      if (k === q) continue;
      const quin = new Array(13).fill(0);
      quin[q] = 4;
      quin[k] = 1;
      shapes.push({ cat: Cat.QUADS, tiebreak: q * 13 + k, quinary: quin });
    }
  }

  // ---- full houses (156): trips t, pair p != t ----
  for (let t = 12; t >= 0; t--) {
    for (let p = 12; p >= 0; p--) {
      if (p === t) continue;
      const quin = new Array(13).fill(0);
      quin[t] = 3;
      quin[p] = 2;
      shapes.push({ cat: Cat.FULL_HOUSE, tiebreak: t * 13 + p, quinary: quin });
    }
  }

  // ---- flushes (non straight-flush): 5-rank masks, popcount 5, not a straight ----
  for (let mask = 0; mask < (1 << NUM_RANKS); mask++) {
    if (popcount(mask) !== 5) continue;
    if (STRAIGHT_MASK_SET.has(mask)) continue;
    shapes.push({ cat: Cat.FLUSH, tiebreak: packRanks(maskToDesc(mask)), mask });
  }

  // ---- straights (non flush) (10) ----
  for (let i = 0; i < STRAIGHT_MASKS.length; i++) {
    const quin = new Array(13).fill(0);
    for (const r of maskToDesc(STRAIGHT_MASKS[i])) quin[r] = 1;
    shapes.push({ cat: Cat.STRAIGHT, tiebreak: STRAIGHT_MASKS.length - i, quinary: quin });
  }

  // ---- trips (non full-house): trip rank t, two distinct kickers ----
  for (let t = 12; t >= 0; t--) {
    for (let k1 = 12; k1 >= 0; k1--) {
      if (k1 === t) continue;
      for (let k2 = k1 - 1; k2 >= 0; k2--) {
        if (k2 === t) continue;
        const quin = new Array(13).fill(0);
        quin[t] = 3;
        quin[k1] = 1;
        quin[k2] = 1;
        shapes.push({ cat: Cat.TRIPS, tiebreak: packRanks([t, k1, k2]), quinary: quin });
      }
    }
  }

  // ---- two pair: high pair hp, low pair lp < hp, kicker k != hp,lp ----
  for (let hp = 12; hp >= 0; hp--) {
    for (let lp = hp - 1; lp >= 0; lp--) {
      for (let k = 12; k >= 0; k--) {
        if (k === hp || k === lp) continue;
        const quin = new Array(13).fill(0);
        quin[hp] = 2;
        quin[lp] = 2;
        quin[k] = 1;
        shapes.push({ cat: Cat.TWO_PAIR, tiebreak: packRanks([hp, lp, k]), quinary: quin });
      }
    }
  }

  // ---- one pair: pair p, three distinct kickers ----
  for (let p = 12; p >= 0; p--) {
    for (let k1 = 12; k1 >= 0; k1--) {
      if (k1 === p) continue;
      for (let k2 = k1 - 1; k2 >= 0; k2--) {
        if (k2 === p) continue;
        for (let k3 = k2 - 1; k3 >= 0; k3--) {
          if (k3 === p) continue;
          const quin = new Array(13).fill(0);
          quin[p] = 2;
          quin[k1] = 1;
          quin[k2] = 1;
          quin[k3] = 1;
          shapes.push({ cat: Cat.PAIR, tiebreak: packRanks([p, k1, k2, k3]), quinary: quin });
        }
      }
    }
  }

  // ---- high card: 5 distinct ranks, not a straight, (mask used as a quinary of 1s) ----
  for (let mask = 0; mask < (1 << NUM_RANKS); mask++) {
    if (popcount(mask) !== 5) continue;
    if (STRAIGHT_MASK_SET.has(mask)) continue;
    const quin = new Array(13).fill(0);
    for (const r of maskToDesc(mask)) quin[r] = 1;
    shapes.push({ cat: Cat.HIGH_CARD, tiebreak: packRanks(maskToDesc(mask)), quinary: quin });
  }

  return shapes;
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

// ranks present in mask, descending (high rank index first)
function maskToDesc(mask: number): number[] {
  const out: number[] = [];
  for (let r = 12; r >= 0; r--) if (mask & (1 << r)) out.push(r);
  return out;
}

// value (1..7462) -> internal category (Cat) and within-category ordinal
// (1 = weakest in that category). These let the public wrapper produce the
// project's "category * 1e6 + tiebreak, higher == better" rank.
export const VALUE_TO_CATEGORY = new Int8Array(NUM_EQUIV_CLASSES + 1);
export const VALUE_TO_ORDINAL = new Int32Array(NUM_EQUIV_CLASSES + 1);

// Assign strength values 1..7462 and fill the lookup tables.
let generated = false;
function generateTables(): void {
  if (generated) return;
  generated = true;

  const shapes = allShapes();
  // Sort strongest first: higher category first, then higher tiebreak.
  shapes.sort((a, b) => (b.cat - a.cat) || (b.tiebreak - a.tiebreak));

  // Count classes per category so we can assign an ascending within-category
  // ordinal (1 = weakest) from the descending global order.
  const catCount: Record<number, number> = {};
  for (const s of shapes) catCount[s.cat] = (catCount[s.cat] || 0) + 1;
  const catSeen: Record<number, number> = {};

  for (let i = 0; i < shapes.length; i++) {
    const value = i + 1; // 1 = strongest
    const s = shapes[i];
    // shapes are strongest-first, so the k-th seen in a category is the
    // k-th strongest; ordinal (1=weakest) = catCount - k + 1.
    catSeen[s.cat] = (catSeen[s.cat] || 0) + 1;
    VALUE_TO_CATEGORY[value] = s.cat;
    VALUE_TO_ORDINAL[value] = catCount[s.cat] - catSeen[s.cat] + 1;

    if (s.mask !== undefined && (s.cat === Cat.FLUSH || s.cat === Cat.STRAIGHT_FLUSH)) {
      FLUSH_TABLE[s.mask] = value;
    } else if (s.quinary) {
      const h = hashQuinary(s.quinary, 5);
      RANK_TABLE[h] = value;
    }
  }

  // NUM_EQUIV_CLASSES sanity: shapes.length must be 7462.
  if (shapes.length !== NUM_EQUIV_CLASSES) {
    throw new Error(
      `eval-tables: generated ${shapes.length} equivalence classes, expected ${NUM_EQUIV_CLASSES}`,
    );
  }
}

// ---- 6/7-card non-flush handling ----------------------------------------
//
// The RANK_TABLE is keyed only by 5-card quinaries. For 6 and 7 cards we
// instead reduce the multiset to its best 5-card non-flush value by table
// lookup over the full 6/7-card quinary. To keep the footprint small we
// derive the 6/7 values lazily on first lookup and memoize them, computing
// the best 5-card sub-quinary directly.
//
// (A 7-card quinary has at most C(7+12,12)-ish entries; we memoize sparsely
// in a Map keyed by the quinary hash so memory stays tiny in practice.)

const memo6 = new Map<number, number>();
const memo7 = new Map<number, number>();

// Reduce a quinary of N cards to the best (lowest value) 5-card non-flush
// value by choosing the strongest 5-card sub-multiset. We enumerate sub-
// multisets by removing (N-5) cards. Simpler: directly score using the
// canonical "best 5 of the rank multiset" rules, which for non-flush hands
// is deterministic. We compute it by trying all ways to reduce each rank's
// count, but bounded and cheap.
function bestNonFlushValue(quinary: number[], numCards: number): number {
  generateTables();
  if (numCards === 5) {
    return RANK_TABLE[hashQuinary(quinary, 5)];
  }
  const memo = numCards === 6 ? memo6 : memo7;
  const key = hashQuinary(quinary, numCards);
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  // Reduce to best 5: enumerate which (numCards-5) cards to drop, but we only
  // care about rank counts. Try lowering counts across ranks.
  let best = Number.POSITIVE_INFINITY;
  const toRemove = numCards - 5;

  // Recursive enumeration of removals across the 13 ranks.
  const work = quinary.slice();
  const recurse = (rank: number, remaining: number): void => {
    if (remaining === 0) {
      const v = RANK_TABLE[hashQuinary(work, 5)];
      if (v > 0 && v < best) best = v; // v>0 guards non-classified (shouldn't happen)
      return;
    }
    if (rank < 0) return;
    const max = Math.min(work[rank], remaining);
    for (let drop = 0; drop <= max; drop++) {
      work[rank] -= drop;
      recurse(rank - 1, remaining - drop);
      work[rank] += drop;
    }
  };
  recurse(12, toRemove);

  memo.set(key, best);
  return best;
}

// ---- public lookups used by hand-eval.ts ---------------------------------

/**
 * Evaluate up to 7 cards given as a quinary (per-rank counts, index 0..12 ==
 * rank 2..A) plus the suit information needed to detect flushes.
 *
 * @param quinary    per-rank counts (length 13)
 * @param numCards   total cards (5,6,7)
 * @param flushMask  13-bit rank mask of the flush suit if a 5+ flush exists,
 *                   else -1. Caller is responsible for choosing the flush suit.
 * @returns value in 1..7462, lower == stronger.
 */
export function lookupValue(quinary: number[], numCards: number, flushMask: number): number {
  generateTables();
  const nonFlush = bestNonFlushValue(quinary, numCards);
  if (flushMask < 0) return nonFlush;

  // Reduce a 5..7 wide flush mask to its best 5-card sub-mask value.
  const flushValue = bestFlushValue(flushMask);
  return Math.min(nonFlush, flushValue);
}

function bestFlushValue(flushMask: number): number {
  const n = popcount(flushMask);
  if (n === 5) return FLUSH_TABLE[flushMask];
  // n is 6 or 7: pick best (lowest) 5-rank sub-mask. The best flush always
  // takes the highest ranks, so dropping the lowest set bits is optimal for
  // plain flushes, BUT a straight flush may use a different 5 — so enumerate.
  let best = Number.POSITIVE_INFINITY;
  const bits: number[] = [];
  for (let r = 0; r < NUM_RANKS; r++) if (flushMask & (1 << r)) bits.push(r);
  // choose 5 of the set bits
  const choose = (start: number, picked: number[]): void => {
    if (picked.length === 5) {
      let m = 0;
      for (const b of picked) m |= 1 << b;
      const v = FLUSH_TABLE[m];
      if (v > 0 && v < best) best = v;
      return;
    }
    for (let i = start; i < bits.length; i++) {
      picked.push(bits[i]);
      choose(i + 1, picked);
      picked.pop();
    }
  };
  choose(0, []);
  return best;
}

// Eagerly build tables at module load so first eval is fast and the count
// invariant (7462) is checked immediately.
generateTables();
