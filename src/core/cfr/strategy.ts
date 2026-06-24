// ============================================================
// Strategy Tables for CFR
// Manages regret sums and cumulative strategy profiles
// ============================================================

export interface InfoSetData {
  regretSum: Float64Array;
  strategySum: Float64Array;
  numActions: number;
}

export class StrategyTable {
  private table: Map<string, InfoSetData> = new Map();

  /**
   * Get or create an information set entry
   */
  getOrCreate(key: string, numActions: number): InfoSetData {
    let data = this.table.get(key);
    if (!data) {
      data = {
        regretSum: new Float64Array(numActions),
        strategySum: new Float64Array(numActions),
        numActions,
      };
      this.table.set(key, data);
    }
    return data;
  }

  /**
   * Get the current strategy via regret matching.
   * Returns a probability distribution over actions.
   */
  getStrategy(key: string, numActions: number): Float64Array {
    const data = this.getOrCreate(key, numActions);
    const strategy = new Float64Array(numActions);
    let normalizingSum = 0;

    // Regret matching: use positive regrets proportionally
    for (let i = 0; i < numActions; i++) {
      strategy[i] = Math.max(0, data.regretSum[i]);
      normalizingSum += strategy[i];
    }

    if (normalizingSum > 0) {
      for (let i = 0; i < numActions; i++) {
        strategy[i] /= normalizingSum;
      }
    } else {
      // Default to uniform
      for (let i = 0; i < numActions; i++) {
        strategy[i] = 1.0 / numActions;
      }
    }

    return strategy;
  }

  /**
   * Get the average strategy (used for the final output).
   * This converges to Nash equilibrium.
   */
  getAverageStrategy(key: string, numActions: number): Float64Array {
    const data = this.getOrCreate(key, numActions);
    const avgStrategy = new Float64Array(numActions);
    let normalizingSum = 0;

    for (let i = 0; i < numActions; i++) {
      normalizingSum += data.strategySum[i];
    }

    if (normalizingSum > 0) {
      for (let i = 0; i < numActions; i++) {
        avgStrategy[i] = data.strategySum[i] / normalizingSum;
      }
    } else {
      for (let i = 0; i < numActions; i++) {
        avgStrategy[i] = 1.0 / numActions;
      }
    }

    return avgStrategy;
  }

  /**
   * Update regrets for an information set
   */
  updateRegrets(key: string, regrets: number[]): void {
    const data = this.getOrCreate(key, regrets.length);
    for (let i = 0; i < regrets.length; i++) {
      data.regretSum[i] += regrets[i];
    }
  }

  /**
   * Accumulate strategy weights
   */
  accumulateStrategy(key: string, strategy: Float64Array, weight: number): void {
    const data = this.getOrCreate(key, strategy.length);
    for (let i = 0; i < strategy.length; i++) {
      data.strategySum[i] += weight * strategy[i];
    }
  }

  /**
   * CFR+ variant: clamp regrets to non-negative after each iteration
   */
  clampRegrets(): void {
    for (const data of this.table.values()) {
      for (let i = 0; i < data.numActions; i++) {
        data.regretSum[i] = Math.max(0, data.regretSum[i]);
      }
    }
  }

  get size(): number {
    return this.table.size;
  }

  /**
   * Serialize the strategy table for caching
   */
  serialize(): string {
    const entries: Record<string, { r: number[]; s: number[]; n: number }> = {};
    for (const [key, data] of this.table.entries()) {
      entries[key] = {
        r: Array.from(data.regretSum),
        s: Array.from(data.strategySum),
        n: data.numActions,
      };
    }
    return JSON.stringify(entries);
  }

  /**
   * Deserialize a strategy table
   */
  static deserialize(json: string): StrategyTable {
    const table = new StrategyTable();
    const entries = JSON.parse(json);
    for (const [key, data] of Object.entries(entries) as [string, any][]) {
      table.table.set(key, {
        regretSum: new Float64Array(data.r),
        strategySum: new Float64Array(data.s),
        numActions: data.n,
      });
    }
    return table;
  }
}

/**
 * LRU Cache for solved strategy tables
 */
export class StrategyCache {
  private cache: Map<string, StrategyTable> = new Map();
  private maxSize: number;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  get(key: string): StrategyTable | undefined {
    const value = this.cache.get(key);
    if (value) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: StrategyTable): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }
}
