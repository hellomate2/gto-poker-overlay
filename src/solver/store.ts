/**
 * Common regret / strategy store shared by every CFR variant.
 *
 * For each information set we keep:
 *   - `regretSum`:   the cumulative (possibly discounted) counterfactual regret
 *                    for each action. Regret-matching turns this into the
 *                    current strategy.
 *   - `strategySum`: the cumulative (possibly weighted) strategy, whose
 *                    normalization is the *average strategy* that converges to
 *                    a Nash equilibrium (Zinkevich et al. 2007).
 *
 * The store is intentionally algorithm-neutral: discounting/clamping schemes
 * (CFR+, Linear CFR, DCFR) are applied by the solvers, not here.
 */
export class InfoSetNode {
  readonly regretSum: number[];
  readonly strategySum: number[];
  /** Scratch buffer reused to avoid per-visit allocation. */
  private readonly currentStrategy: number[];

  constructor(readonly numActions: number) {
    this.regretSum = new Array<number>(numActions).fill(0);
    this.strategySum = new Array<number>(numActions).fill(0);
    this.currentStrategy = new Array<number>(numActions).fill(0);
  }

  /**
   * Regret-matching: the current strategy is proportional to positive regret.
   * If no action has positive regret, play uniformly. This is the standard
   * regret-matching rule (Hart & Mas-Colell 2000) used by vanilla CFR.
   *
   * NOTE: the returned array is a shared scratch buffer; copy it if you need to
   * retain the values past the next call.
   */
  strategy(): number[] {
    const n = this.numActions;
    let positiveSum = 0;
    for (let i = 0; i < n; i++) {
      const r = this.regretSum[i];
      this.currentStrategy[i] = r > 0 ? r : 0;
      positiveSum += this.currentStrategy[i];
    }
    if (positiveSum > 0) {
      for (let i = 0; i < n; i++) this.currentStrategy[i] /= positiveSum;
    } else {
      const u = 1 / n;
      for (let i = 0; i < n; i++) this.currentStrategy[i] = u;
    }
    return this.currentStrategy;
  }

  /** The normalized average strategy (converges to equilibrium). */
  averageStrategy(): number[] {
    const n = this.numActions;
    const avg = new Array<number>(n).fill(0);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.strategySum[i];
    if (sum > 0) {
      for (let i = 0; i < n; i++) avg[i] = this.strategySum[i] / sum;
    } else {
      const u = 1 / n;
      for (let i = 0; i < n; i++) avg[i] = u;
    }
    return avg;
  }
}

/** Map from information-set key to its node, created lazily on first visit. */
export class RegretStore {
  private readonly nodes = new Map<string, InfoSetNode>();

  /** Returns the node for `key`, creating it with `numActions` if absent. */
  get(key: string, numActions: number): InfoSetNode {
    let node = this.nodes.get(key);
    if (node === undefined) {
      node = new InfoSetNode(numActions);
      this.nodes.set(key, node);
    }
    return node;
  }

  /** All info-set keys currently known to the store. */
  keys(): IterableIterator<string> {
    return this.nodes.keys();
  }

  /** All (key, node) entries. */
  entries(): IterableIterator<[string, InfoSetNode]> {
    return this.nodes.entries();
  }

  has(key: string): boolean {
    return this.nodes.has(key);
  }

  get size(): number {
    return this.nodes.size;
  }
}
