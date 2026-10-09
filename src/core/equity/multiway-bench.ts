// ============================================================
// Timing benchmark for equityVsRanges (multiway-equity.ts).
// Run with: npx tsx src/core/equity/multiway-bench.ts
//
// Ranges are the first N unblocked combos of a fixed shuffle (seeded), with
// random weights, so every run measures the same workload. Each case is
// warmed up once (JIT + evaluator memo tables), then timed over several
// repetitions with different seeds; we print the median.
// ============================================================

import { CardId } from '../../types/poker';
import { SeededRng } from '../../solver/rng';
import { WeightedRange } from '../ranges/weighted-range';
import { equityVsRanges } from './multiway-equity';

function rangeOf(size: number, seed: number, dead: CardId[]): WeightedRange {
  const rng = new SeededRng(seed);
  const blocked = new Set(dead);
  const all: [CardId, CardId][] = [];
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) if (!blocked.has(a) && !blocked.has(b)) all.push([a, b]);
  }
  for (let i = all.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    [all[i], all[j]] = [all[j], all[i]];
  }
  const combos = all.slice(0, size);
  return { combos, weights: combos.map(() => 0.1 + rng.next()) };
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function bench(label: string, hero: [CardId, CardId], board: CardId[], ranges: WeightedRange[], iterations: number, reps = 9): void {
  equityVsRanges(hero, board, ranges, { iterations, seed: 999 }); // warm-up
  const times: number[] = [];
  let last = equityVsRanges(hero, board, ranges, { iterations, seed: 1 });
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    last = equityVsRanges(hero, board, ranges, { iterations, seed: r + 1 });
    times.push(performance.now() - t0);
  }
  console.log(
    `${label}: median ${median(times).toFixed(2)} ms (min ${Math.min(...times).toFixed(2)}, max ${Math.max(...times).toFixed(2)}), ` +
      `equity ${last.equity.toFixed(4)} +/- ${last.stdErr.toFixed(4)}, samples ${last.samples}, exact ${last.exact}`,
  );
}

// Hero 9h9c. Card ids: rank*4 + suit (h=0,d=1,c=2,s=3); 9 = rank index 7.
const hero: [CardId, CardId] = [7 * 4 + 0, 7 * 4 + 2];
const flop: CardId[] = [11 * 4 + 1, 5 * 4 + 0, 0 * 4 + 2]; // Kd 7h 2c
const turn: CardId[] = [...flop, 3 * 4 + 3]; // + 5s
const river: CardId[] = [...turn, 9 * 4 + 1]; // + Jd
const deadFlop = [...hero, ...flop];
const deadRiver = [...hero, ...river];

bench('3 villains, flop, 300 combos each, 5000 samples', hero, flop, [1, 2, 3].map(s => rangeOf(300, s, deadFlop)), 5000);
bench('3 villains, flop, any-two (1081 combos each), 5000 samples', hero, flop, [1, 2, 3].map(s => rangeOf(1081, s, deadFlop)), 5000);
bench('2 villains, turn, 300 combos each, 5000 samples', hero, turn, [1, 2].map(s => rangeOf(300, s, deadFlop)), 5000);
bench('1 villain, river, 300 combos, exact', hero, river, [rangeOf(300, 1, deadRiver)], 0);
bench('1 villain, turn, 300 combos, exact', hero, turn, [rangeOf(300, 1, deadRiver)], 0);
bench('1 villain, flop, 300 combos, exact', hero, flop, [rangeOf(300, 1, deadRiver)], 0, 5);
bench('2 villains, river, 300 combos each, exact', hero, river, [1, 2].map(s => rangeOf(300, s, deadRiver)), 0);
bench('5 villains, preflop, any-two, 5000 samples', hero, [], [1, 2, 3, 4, 5].map(s => rangeOf(1326, s, hero)), 5000);
