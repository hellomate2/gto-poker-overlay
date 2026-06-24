/**
 * The CFR algorithm family: Vanilla CFR, CFR+, Linear CFR, and Discounted CFR.
 *
 * All four share the same recursive counterfactual-value traversal of the game
 * tree and the same regret/strategy store; they differ only in how cumulative
 * regrets and strategies are *discounted* between iterations and whether
 * regrets are clamped to be non-negative. We therefore implement one traversal
 * parameterized by a {@link DiscountScheme}.
 *
 * References:
 *   - Vanilla CFR:  Zinkevich, Johanson, Bowling, Piccione (2007),
 *                   "Regret Minimization in Games with Incomplete Information".
 *   - CFR+:         Tammelin (2014), "Solving Large Imperfect Information Games
 *                   Using CFR+" (regret-matching+, i.e. regrets floored at 0,
 *                   plus linear averaging of the strategy).
 *   - Linear CFR &
 *     Discounted
 *     CFR (DCFR):   Brown & Sandholm (2019), "Solving Imperfect-Information
 *                   Games via Discounted Regret Minimization". DCFR weights
 *                   positive regrets by t^a/(t^a+1), negative regrets by
 *                   t^b/(t^b+1), and the strategy contribution by (t/(t+1))^g.
 *                   Linear CFR is the special case a=b=1, g=1 applied as a
 *                   linear (t) weighting.
 */
import { Game, CHANCE, Player } from './game';
import { RegretStore, InfoSetNode } from './store';

/**
 * Per-iteration discounting of accumulated regrets and strategy.
 *
 * `regretPos(t)` / `regretNeg(t)` multiply the *existing* cumulative positive /
 * negative regret before this iteration's regret is added. `strategy(t)`
 * multiplies the existing cumulative strategy before this iteration's
 * contribution is added. `clampRegret` floors cumulative regret at 0 after the
 * update (regret-matching+).
 */
export interface DiscountScheme {
  readonly name: string;
  regretPos(t: number): number;
  regretNeg(t: number): number;
  strategy(t: number): number;
  readonly clampRegret: boolean;
}

/** Vanilla CFR: no discounting, no clamping (Zinkevich et al. 2007). */
export const VANILLA: DiscountScheme = {
  name: 'CFR',
  regretPos: () => 1,
  regretNeg: () => 1,
  strategy: () => 1,
  clampRegret: false,
};

/**
 * CFR+ (Tammelin 2014): regret-matching+ (regrets floored at 0 each step) with
 * linear averaging of the strategy (iteration t contributes weight t, so the
 * cumulative strategy is scaled by (t-1)/t before adding the new one — handled
 * by using the linear strategy weight below).
 */
export const CFR_PLUS: DiscountScheme = {
  name: 'CFR+',
  regretPos: () => 1,
  regretNeg: () => 1,
  // Linear (weight-t) averaging: scale prior cumulative strategy by (t-1)/t.
  strategy: (t) => (t - 1) / t,
  clampRegret: true,
};

/**
 * Linear CFR (Brown & Sandholm 2019): both regrets and the strategy on
 * iteration t are weighted linearly by t. Implemented by scaling the existing
 * cumulative quantities by (t-1)/t before adding the new (unit-weighted)
 * contribution, which is algebraically identical to weighting iteration t by t.
 */
export const LINEAR_CFR: DiscountScheme = {
  name: 'LinearCFR',
  regretPos: (t) => (t - 1) / t,
  regretNeg: (t) => (t - 1) / t,
  strategy: (t) => (t - 1) / t,
  clampRegret: false,
};

/**
 * Discounted CFR (DCFR) with the recommended parameters a=1.5, b=0, g=2 from
 * Brown & Sandholm (2019). Positive cumulative regret is multiplied by
 * t^a/(t^a+1); negative cumulative regret by t^b/(t^b+1); the cumulative
 * strategy by (t/(t+1))^g, each before the new iteration's contribution.
 */
export function discountedCfr(alpha = 1.5, beta = 0, gamma = 2): DiscountScheme {
  return {
    name: 'DCFR',
    regretPos: (t) => {
      const ta = Math.pow(t, alpha);
      return ta / (ta + 1);
    },
    regretNeg: (t) => {
      const tb = Math.pow(t, beta);
      return tb / (tb + 1);
    },
    strategy: (t) => Math.pow(t / (t + 1), gamma),
    clampRegret: false,
  };
}

export const DCFR: DiscountScheme = discountedCfr();

export interface CfrOptions {
  readonly scheme: DiscountScheme;
}

/**
 * A trainer running one of the CFR-family algorithms over a {@link Game}.
 *
 * Call {@link iterate} repeatedly; the converging solution is the *average*
 * strategy obtainable from {@link store}.
 */
export class CfrSolver<H> {
  readonly store = new RegretStore();
  private t = 0; // iterations completed
  private readonly scheme: DiscountScheme;

  constructor(private readonly game: Game<H>, opts: CfrOptions) {
    this.scheme = opts.scheme;
  }

  /** Number of iterations completed. */
  get iterations(): number {
    return this.t;
  }

  /**
   * Runs one full CFR iteration (a traversal updating every player).
   *
   * TODO(cfr-plus): CFR+ and DCFR currently do not converge faster than vanilla
   * on Leduc, which contradicts the literature and points to a bug in the
   * discount/averaging interaction (likely the update scheme: alternating vs
   * simultaneous, and how the per-iteration weight is applied). Being fixed
   * against reference implementations (OpenSpiel, noambrown/poker_solver).
   */
  iterate(): void {
    this.t += 1;
    const root = this.game.root();
    const reach = new Array<number>(this.game.numPlayers()).fill(1);
    for (let p = 0; p < this.game.numPlayers(); p++) {
      this.cfr(root, p, reach);
    }
  }

  /** Convenience: run `n` iterations. */
  train(n: number): void {
    for (let i = 0; i < n; i++) this.iterate();
  }

  /**
   * Recursive counterfactual-value computation for the `traverser`.
   *
   * `reach[p]` is the probability that player p (and chance, folded into the
   * traverser's counterfactual reach as usual) plays to reach `h`. Returns the
   * expected utility of `h` to the traverser under the current strategy.
   */
  private cfr(h: H, traverser: Player, reach: number[]): number {
    const game = this.game;

    if (game.isTerminal(h)) {
      return game.utility(h, traverser);
    }

    if (game.isChance(h)) {
      let value = 0;
      for (const { next, prob } of game.chanceOutcomes(h)) {
        const childReach = reach.slice();
        // Chance reach is folded into every player's reach probability.
        for (let p = 0; p < childReach.length; p++) childReach[p] *= prob;
        value += prob * this.cfr(next, traverser, childReach);
      }
      return value;
    }

    const player = game.currentPlayer(h);
    const key = game.infoSetKey(h);
    const actions = game.actions(h);
    const node = this.store.get(key, actions.length);
    const strategy = node.strategy(); // shared scratch buffer

    const actionValues = new Array<number>(actions.length).fill(0);
    let nodeValue = 0;

    for (let i = 0; i < actions.length; i++) {
      const childReach = reach.slice();
      childReach[player] *= strategy[i];
      const childVal = this.cfr(game.next(h, actions[i]), traverser, childReach);
      actionValues[i] = childVal;
      nodeValue += strategy[i] * childVal;
    }

    if (player === traverser) {
      // Counterfactual reach = product of *other* players' reach probabilities.
      let cfReach = 1;
      for (let p = 0; p < reach.length; p++) if (p !== player) cfReach *= reach[p];

      this.applyRegretUpdate(node, actionValues, nodeValue, cfReach);
      this.applyStrategyUpdate(node, strategy, reach[player]);
    }

    return nodeValue;
  }

  /** Discounts existing regret then accumulates this iteration's regret. */
  private applyRegretUpdate(
    node: InfoSetNode,
    actionValues: number[],
    nodeValue: number,
    cfReach: number,
  ): void {
    const posD = this.scheme.regretPos(this.t);
    const negD = this.scheme.regretNeg(this.t);
    for (let i = 0; i < node.numActions; i++) {
      const prior = node.regretSum[i];
      const discounted = prior > 0 ? prior * posD : prior * negD;
      let updated = discounted + cfReach * (actionValues[i] - nodeValue);
      if (this.scheme.clampRegret && updated < 0) updated = 0;
      node.regretSum[i] = updated;
    }
  }

  /** Discounts existing cumulative strategy then accumulates this iteration's. */
  private applyStrategyUpdate(
    node: InfoSetNode,
    strategy: number[],
    playerReach: number,
  ): void {
    const strD = this.scheme.strategy(this.t);
    for (let i = 0; i < node.numActions; i++) {
      node.strategySum[i] = node.strategySum[i] * strD + playerReach * strategy[i];
    }
  }
}
