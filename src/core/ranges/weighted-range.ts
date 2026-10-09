import { CardId } from '../../types/poker';

// ============================================================
// Shared contract for the range-conditioned postflop work.
//
// A WeightedRange is a villain's hole-card distribution: concrete combos plus a
// relative weight per combo (not required to sum to 1). Producers:
//   - src/core/ranges/range-tracker.ts  (preflop action -> range, narrowed by
//     each postflop action)
// Consumers:
//   - src/core/equity/multiway-equity.ts (hero vs N weighted ranges at once)
//   - src/core/solver/subgame.ts         (HU turn/river CFR subgame solve)
//   - src/core/defense.ts                (MDF / bluff-catch policy)
// Combos are [lo, hi] with lo < hi. Callers must drop combos that collide with
// hero cards or the board before use (see normalizeRange).
// ============================================================

export interface WeightedRange {
  combos: [CardId, CardId][];
  weights: number[];
}

/** A villain still in the hand, with the range we believe they hold. */
export interface VillainRange {
  playerIndex: number;
  range: WeightedRange;
}

/** Drop blocked / zero-weight combos and renormalize weights to sum to 1. */
export function normalizeRange(range: WeightedRange, dead: Iterable<CardId>): WeightedRange {
  const blocked = new Set<CardId>(dead);
  const combos: [CardId, CardId][] = [];
  const weights: number[] = [];
  let total = 0;
  for (let i = 0; i < range.combos.length; i++) {
    const [a, b] = range.combos[i];
    const w = range.weights[i];
    if (!(w > 0) || a === b || blocked.has(a) || blocked.has(b)) continue;
    combos.push([Math.min(a, b), Math.max(a, b)]);
    weights.push(w);
    total += w;
  }
  if (total > 0) for (let i = 0; i < weights.length; i++) weights[i] /= total;
  return { combos, weights };
}
