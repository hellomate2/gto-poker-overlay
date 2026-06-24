/**
 * A small, deterministic, seedable pseudo-random number generator.
 *
 * We deliberately avoid `Math.random()` so that Monte-Carlo CFR runs and
 * their associated tests are fully reproducible. The generator is `mulberry32`,
 * a well-known 32-bit PRNG with good statistical properties for simulation
 * purposes (period 2^32, fast, no external state).
 *
 * Reference: Tommy Ettinger / "mulberry32" public-domain generator.
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    // Force the seed into an unsigned 32-bit integer.
    this.state = seed >>> 0;
  }

  /** Returns a float in the half-open interval [0, 1). */
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns an integer in [0, n). */
  nextInt(n: number): number {
    return Math.floor(this.next() * n);
  }

  /**
   * Samples an index from a (non-normalized) array of non-negative weights.
   * If all weights are zero, falls back to a uniform choice.
   */
  sampleFromWeights(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    if (total <= 0) {
      return this.nextInt(weights.length);
    }
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }
}
