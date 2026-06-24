// ============================================================
// Throughput benchmark for the perfect-hash hand evaluator.
// Run with: npm run eval:bench
// ============================================================

import { evaluateHand } from './hand-eval';

function makeDeck(): number[] {
  const d: number[] = [];
  for (let i = 0; i < 52; i++) d.push(i);
  return d;
}

function bench(numCards: number, iterations: number): number {
  const deck = makeDeck();
  // Pre-generate random hands so we measure the evaluator, not RNG/alloc.
  const hands: number[][] = [];
  for (let i = 0; i < 10000; i++) {
    const d = deck.slice();
    for (let k = d.length - 1; k > 0; k--) {
      const j = (Math.random() * (k + 1)) | 0;
      [d[k], d[j]] = [d[j], d[k]];
    }
    hands.push(d.slice(0, numCards));
  }

  // Warm up (forces table generation + JIT).
  let sink = 0;
  for (let i = 0; i < 100000; i++) sink += evaluateHand(hands[i % hands.length]);

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    sink += evaluateHand(hands[i % hands.length]);
  }
  const end = performance.now();
  if (sink === -1) console.log(''); // prevent dead-code elimination

  const seconds = (end - start) / 1000;
  return iterations / seconds;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

for (const n of [5, 6, 7]) {
  const iters = n === 7 ? 5_000_000 : 10_000_000;
  const eps = bench(n, iters);
  console.log(`${n}-card: ${fmt(eps)} evaluations/sec`);
}
