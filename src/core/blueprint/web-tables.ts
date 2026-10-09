// ============================================================
// Card buckets for the in-browser blueprint, computed exactly like the C++
// trainer (blueprint/src/abstraction.{h,cpp}).
//
//   preflop  preflopClass() (loader.ts), the 169 lossless classes.
//   flop     table lookup: [canonical flop id][combo of the suit-permuted hole].
//   turn     same with canonical turns.
//   river    computed on the fly: EHS against all 990 opponent holdings as a
//            float32 with the trainer's exact arithmetic, then the number of
//            river_bounds <= EHS (std::upper_bound). No 178 MB table.
//
// Board isomorphism (BoardIso in abstraction.cpp): a board maps to the
// lexicographically smallest sorted card list over the 24 suit relabelings,
// keeping the FIRST permutation that reaches it (strict <, SUIT_PERMS order);
// the same permutation is applied to the hole cards. Canonical ids are the
// order in which each class first appears when sorted boards are enumerated in
// colex order. enumerateCanonicalBoards() reproduces that enumeration (the
// export script and the tests use it); at run time the ids come from the
// shipped key list (canonical key -> id), so nothing is enumerated in the
// browser.
//
// Card ids are rank * 4 + suit (suits h d c s), the same on both sides.
// ============================================================

import { CardId } from '../../types/poker';
import { evaluateHand } from '../equity/hand-eval';
import { riverBucketFromEhs } from './loader';

export const NUM_COMBOS = 1326;

/** SUIT_PERMS[p][oldSuit] = newSuit, same order as abstraction.cpp. */
export const SUIT_PERMS: readonly (readonly number[])[] = [
  [0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3], [0, 2, 3, 1], [0, 3, 1, 2], [0, 3, 2, 1],
  [1, 0, 2, 3], [1, 0, 3, 2], [1, 2, 0, 3], [1, 2, 3, 0], [1, 3, 0, 2], [1, 3, 2, 0],
  [2, 0, 1, 3], [2, 0, 3, 1], [2, 1, 0, 3], [2, 1, 3, 0], [2, 3, 0, 1], [2, 3, 1, 0],
  [3, 0, 1, 2], [3, 0, 2, 1], [3, 1, 0, 2], [3, 1, 2, 0], [3, 2, 0, 1], [3, 2, 1, 0],
];

export function permCard(c: number, p: number): number {
  return (c & ~3) | SUIT_PERMS[p][c & 3];
}

/** Colex index of a 2-card combo, any order (common.h combo_index). */
export function comboIndex(a: number, b: number): number {
  if (a < b) { const t = a; a = b; b = t; }
  return (a * (a - 1)) / 2 + b;
}

const scratch = [0, 0, 0, 0, 0];

/**
 * Canonical key of a 3- or 4-card board and the permutation that reaches it.
 * key = the permuted, sorted cards packed big-endian, 8 bits each (perm_key).
 */
export function canonicalBoard(board: readonly number[]): { key: number; perm: number } {
  const k = board.length;
  let best = Infinity, bp = 0;
  for (let p = 0; p < 24; p++) {
    const sp = SUIT_PERMS[p];
    for (let i = 0; i < k; i++) scratch[i] = (board[i] & ~3) | sp[board[i] & 3];
    // insertion sort of k <= 5 cards
    for (let i = 1; i < k; i++) {
      const v = scratch[i];
      let j = i - 1;
      while (j >= 0 && scratch[j] > v) { scratch[j + 1] = scratch[j]; j--; }
      scratch[j + 1] = v;
    }
    let key = 0;
    for (let i = 0; i < k; i++) key = key * 256 + scratch[i];
    if (key < best) { best = key; bp = p; }
  }
  return { key: best, perm: bp };
}

/**
 * Canonical keys in C++ id order: enumerate sorted k-card boards in colex
 * order (BoardIso::build) and record each class at its first appearance.
 * 1,755 flops (k = 3) and 16,432 turns (k = 4).
 */
export function enumerateCanonicalBoards(k: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  const cur = new Array<number>(k).fill(0);
  const rec = (pos: number, hi: number): void => {
    if (pos < 0) {
      const { key } = canonicalBoard(cur);
      if (!seen.has(key)) { seen.add(key); out.push(key); }
      return;
    }
    for (let x = pos; x < hi; x++) {
      cur[pos] = x;
      rec(pos - 1, x);
    }
  };
  rec(k - 1, 52);
  return out;
}

const FLOAT_INV_990 = Math.fround(1 / 990);
const hand7: number[] = [0, 0, 0, 0, 0, 0, 0];

/**
 * River EHS as the C++ float32 (river_ehs_all):
 * (float(wins) + 0.5f * float(ties)) * (1.f / 990.f), one rounding to float.
 * Checked bit for bit against the C++ expression for every (wins, ties).
 */
export function riverEhsF32(hole: readonly [CardId, CardId], board: readonly CardId[]): number {
  if (board.length !== 5) throw new Error('riverEhsF32: board must have 5 cards');
  const used = new Uint8Array(52);
  for (const c of [...hole, ...board]) {
    if (used[c]) throw new Error('riverEhsF32: duplicate cards');
    used[c] = 1;
  }
  for (let i = 0; i < 5; i++) hand7[2 + i] = board[i];
  hand7[0] = hole[0];
  hand7[1] = hole[1];
  const mine = evaluateHand(hand7);
  let wins = 0, ties = 0;
  for (let a = 0; a < 52; a++) {
    if (used[a]) continue;
    hand7[0] = a;
    for (let b = a + 1; b < 52; b++) {
      if (used[b]) continue;
      hand7[1] = b;
      const theirs = evaluateHand(hand7);
      if (mine > theirs) wins++;
      else if (mine === theirs) ties++;
    }
  }
  return Math.fround(Math.fround(wins + 0.5 * ties) * FLOAT_INV_990);
}

export interface BucketTableData {
  /** uint8 [canonical flop id * 1326 + combo]. */
  flop: Uint8Array;
  /** uint8 [canonical turn id * 1326 + combo]. */
  turn: Uint8Array;
  /** Canonical flop keys in C++ id order. */
  flopKeys: ArrayLike<number>;
  /** Canonical turn keys in C++ id order. */
  turnKeys: ArrayLike<number>;
  /** River bounds (float32 values), ascending. */
  riverBounds: readonly number[];
  /** Buckets per street [169, flop, turn, river]. */
  buckets: readonly number[];
}

export class BucketTables {
  private readonly flopId = new Map<number, number>();
  private readonly turnId = new Map<number, number>();
  private readonly bounds: number[];

  constructor(private readonly d: BucketTableData) {
    if (d.flop.length !== d.flopKeys.length * NUM_COMBOS) throw new Error('blueprint web: flop table size');
    if (d.turn.length !== d.turnKeys.length * NUM_COMBOS) throw new Error('blueprint web: turn table size');
    for (let i = 0; i < d.flopKeys.length; i++) this.flopId.set(d.flopKeys[i], i);
    for (let i = 0; i < d.turnKeys.length; i++) this.turnId.set(d.turnKeys[i], i);
    this.bounds = d.riverBounds.map(x => Math.fround(x));
    if (this.bounds.length + 1 !== d.buckets[3]) throw new Error('blueprint web: river bounds do not match river buckets');
  }

  private table(board: readonly number[], hole: readonly [number, number], ids: Map<number, number>, t: Uint8Array, nb: number): number {
    const { key, perm } = canonicalBoard(board);
    const id = ids.get(key);
    if (id === undefined) throw new Error('blueprint web: board not in canonical list');
    const b = t[id * NUM_COMBOS + comboIndex(permCard(hole[0], perm), permCard(hole[1], perm))];
    if (b >= nb) throw new Error(`blueprint web: bad bucket ${b}`);
    return b;
  }

  /** Card bucket of the acting player's hand on the board's street. */
  bucket(hole: readonly [CardId, CardId], board: readonly CardId[]): number {
    const [a, b] = hole;
    if (a === b || [a, b, ...board].some(c => !Number.isInteger(c) || c < 0 || c > 51)) {
      throw new Error('blueprint web: bad cards');
    }
    if (new Set([a, b, ...board]).size !== board.length + 2) throw new Error('blueprint web: duplicate cards');
    switch (board.length) {
      case 0: {
        const ra = a >> 2, rb = b >> 2, hi = Math.max(ra, rb), lo = Math.min(ra, rb);
        if (hi === lo) return hi * 13 + hi;
        return (a & 3) === (b & 3) ? hi * 13 + lo : lo * 13 + hi;
      }
      case 3: return this.table(board, hole, this.flopId, this.d.flop, this.d.buckets[1]);
      case 4: return this.table(board, hole, this.turnId, this.d.turn, this.d.buckets[2]);
      case 5: return riverBucketFromEhs(riverEhsF32(hole, board), this.bounds);
      default: throw new Error(`blueprint web: board of ${board.length} cards`);
    }
  }
}
