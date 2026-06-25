/**
 * 169 x 169 preflop all-in equity matrix.
 *
 * `equityMatrix()[i][j]` is the probability that category `i` beats category
 * `j` at an all-in preflop showdown (ties counted as 0.5), averaged over all
 * non-conflicting combo pairs of the two categories and over all 5-card
 * boards. This is the leaf-value source for the heads-up preflop CFR solve:
 * when both players are all-in (or check it down to showdown) the payoff is
 * `equity * pot`.
 *
 * Computation: for each ordered category pair we enumerate the concrete combo
 * pairs (skipping any that share a card) and, for each, Monte-Carlo sample
 * boards with the seeded RNG and score them with the fast evaluator. Combo
 * pairs are weighted equally (each represents the same number of deals), which
 * is exactly the combo-weighted average of specific-hand equities.
 *
 * The matrix is expensive to compute (~1.5M showdowns) so it is cached to a
 * committed JSON file (equity-matrix.json). Pass `forceRecompute` to rebuild.
 *
 * Symmetry: equity[i][j] = 1 - equity[j][i] for i != j (ignoring the small
 * effect of differing card-removal between the two orderings, which we make
 * exact by computing each ordered pair from the same sampled boards). We
 * compute the upper triangle and mirror it so the matrix is exactly
 * antisymmetric, eliminating sampling asymmetry.
 */
/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';
import { CardId } from '../../types/poker';
import { evaluateHand } from '../../core/equity/hand-eval';
import { SeededRng } from '../rng';
import { categories, NUM_CATEGORIES } from './categories';

const CACHE_PATH = path.join(__dirname, 'equity-matrix.json');

/** Boards sampled per combo-pair. Total showdowns ≈ pairs * this. */
const DEFAULT_BOARDS_PER_PAIR = 200;
const DEFAULT_SEED = 0x5eed1234;

export interface EquityMatrixOptions {
  boardsPerPair?: number;
  seed?: number;
  forceRecompute?: boolean;
  /** If true, do not read or write the JSON cache. */
  noCache?: boolean;
  /** Progress callback (0..1). */
  onProgress?: (frac: number) => void;
}

let _matrix: number[][] | null = null;

/**
 * Returns the 169x169 equity matrix, loading from cache if available.
 * On a cache miss it computes the matrix and (unless noCache) writes the cache.
 */
export function equityMatrix(opts: EquityMatrixOptions = {}): number[][] {
  if (_matrix && !opts.forceRecompute) return _matrix;

  if (!opts.forceRecompute && !opts.noCache && fs.existsSync(CACHE_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      if (
        Array.isArray(raw.matrix) &&
        raw.matrix.length === NUM_CATEGORIES &&
        raw.matrix[0].length === NUM_CATEGORIES
      ) {
        _matrix = raw.matrix;
        return _matrix!;
      }
    } catch {
      // fall through to recompute
    }
  }

  _matrix = computeEquityMatrix(opts);
  if (!opts.noCache) {
    fs.writeFileSync(
      CACHE_PATH,
      JSON.stringify({
        boardsPerPair: opts.boardsPerPair ?? DEFAULT_BOARDS_PER_PAIR,
        seed: opts.seed ?? DEFAULT_SEED,
        matrix: _matrix,
      }),
    );
  }
  return _matrix;
}

/** Compute the full matrix from scratch (no caching). */
export function computeEquityMatrix(opts: EquityMatrixOptions = {}): number[][] {
  const boardsPerPair = opts.boardsPerPair ?? DEFAULT_BOARDS_PER_PAIR;
  const seed = opts.seed ?? DEFAULT_SEED;
  const rng = new SeededRng(seed);
  const cats = categories();

  const m: number[][] = Array.from({ length: NUM_CATEGORIES }, () =>
    new Array<number>(NUM_CATEGORIES).fill(0),
  );

  const totalPairs = (NUM_CATEGORIES * (NUM_CATEGORIES + 1)) / 2;
  let donePairs = 0;

  const board: CardId[] = new Array(5).fill(0);
  const hero7: CardId[] = new Array(7).fill(0);
  const vil7: CardId[] = new Array(7).fill(0);
  const used = new Uint8Array(52);

  for (let i = 0; i < NUM_CATEGORIES; i++) {
    for (let j = i; j < NUM_CATEGORIES; j++) {
      const eq = pairEquity(
        cats[i].combos,
        cats[j].combos,
        boardsPerPair,
        rng,
        board,
        hero7,
        vil7,
        used,
      );
      m[i][j] = eq;
      if (i !== j) m[j][i] = 1 - eq; // exact antisymmetry
      donePairs++;
      if (opts.onProgress && donePairs % 500 === 0) {
        opts.onProgress(donePairs / totalPairs);
      }
    }
  }
  if (opts.onProgress) opts.onProgress(1);
  return m;
}

/**
 * Combo-weighted equity of category A vs category B. Iterates all
 * non-conflicting combo pairs; for each, samples `boardsPerPair` random 5-card
 * boards and records win/tie/loss. Returns A's equity (ties = 0.5).
 */
function pairEquity(
  combosA: [CardId, CardId][],
  combosB: [CardId, CardId][],
  boardsPerPair: number,
  rng: SeededRng,
  board: CardId[],
  hero7: CardId[],
  vil7: CardId[],
  used: Uint8Array,
): number {
  let wins = 0;
  let validBoards = 0;

  for (const [a0, a1] of combosA) {
    for (const [b0, b1] of combosB) {
      // Skip combo pairs that share a card (impossible to both be dealt).
      if (a0 === b0 || a0 === b1 || a1 === b0 || a1 === b1) continue;

      used.fill(0);
      used[a0] = 1;
      used[a1] = 1;
      used[b0] = 1;
      used[b1] = 1;
      hero7[0] = a0;
      hero7[1] = a1;
      vil7[0] = b0;
      vil7[1] = b1;

      for (let s = 0; s < boardsPerPair; s++) {
        // Draw 5 distinct unused board cards.
        for (let k = 0; k < 5; k++) {
          let c: number;
          do {
            c = rng.nextInt(52);
          } while (used[c]);
          used[c] = 1;
          board[k] = c;
        }
        for (let k = 0; k < 5; k++) {
          hero7[2 + k] = board[k];
          vil7[2 + k] = board[k];
        }
        const hv = evaluateHand(hero7);
        const vv = evaluateHand(vil7);
        if (hv > vv) wins += 1;
        else if (hv === vv) wins += 0.5;
        validBoards++;

        // Release the board cards for the next sample.
        for (let k = 0; k < 5; k++) used[board[k]] = 0;
      }
    }
  }

  if (validBoards === 0) return 0.5;
  return wins / validBoards;
}

/** Force the in-memory matrix (used by callers that already have it). */
export function setMatrix(m: number[][]): void {
  _matrix = m;
}
