// ============================================================
// Action translation for off-tree bet sizes.
//
// Pseudo-harmonic mapping, S. Ganzfried and T. Sandholm, "Action Translation
// in Extensive-Form Games with Large Action Spaces: Axioms, Paradoxes, and the
// Pseudo-Harmonic Mapping", IJCAI 2013,
// https://www.ijcai.org/Proceedings/13/Papers/028.pdf (section 5). Sizes are
// pot fractions. For an opponent bet x with A < x < B (the neighboring
// abstract sizes) the randomized mapping picks A with probability
//
//     f(x) = ((B - x)(1 + A)) / ((B - A)(1 + x))
//
// and B otherwise. The deterministic version maps to A when x is below the
// median x* = (A + B + 2AB) / (A + B + 2) (where f = 1/2), else to B.
// Pluribus used the randomized version for off-tree preflop bets (research
// note ~/Downloads/gpo-research/pluribus.md, "Pseudo-harmonic mapping").
//
// Outside the abstract range there is nothing to interpolate: x at or below
// the smallest size maps to the smallest, x at or above the largest maps to
// the largest.
// ============================================================

/** Probability of mapping x to the LOWER size A (A < B, A <= x <= B). */
export function pseudoHarmonicProbA(A: number, B: number, x: number): number {
  if (!(B > A)) throw new Error(`pseudoHarmonicProbA: need A < B (got ${A}, ${B})`);
  if (x <= A) return 1;
  if (x >= B) return 0;
  return ((B - x) * (1 + A)) / ((B - A) * (1 + x));
}

/** Median of the pseudo-harmonic mapping between A and B (f(x*) = 1/2). */
export function pseudoHarmonicMedian(A: number, B: number): number {
  return (A + B + 2 * A * B) / (A + B + 2);
}

/**
 * Pick one of `sizes` (pot fractions, any order, at least one) for a real size
 * x. Returns the index into `sizes`. `rng` supplies the coin for the
 * randomized mapping; pass `deterministic` to use the median rule instead.
 */
export function translateSize(
  sizes: readonly number[], x: number, rng: () => number, deterministic = false,
): number {
  if (sizes.length === 0) throw new Error('translateSize: no abstract sizes');
  const order = sizes.map((s, i) => i).sort((i, j) => sizes[i] - sizes[j]);
  const lo = order[0], hi = order[order.length - 1];
  if (x <= sizes[lo]) return lo;
  if (x >= sizes[hi]) return hi;
  for (let k = 0; k + 1 < order.length; k++) {
    const ia = order[k], ib = order[k + 1];
    const A = sizes[ia], B = sizes[ib];
    if (x === B) return ib;
    if (x > A && x < B) {
      if (deterministic) return x < pseudoHarmonicMedian(A, B) ? ia : ib;
      return rng() < pseudoHarmonicProbA(A, B, x) ? ia : ib;
    }
    if (x === A) return ia;
  }
  return hi;  // unreachable for finite x
}
