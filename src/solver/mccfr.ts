/**
 * Monte-Carlo Counterfactual Regret Minimization (MCCFR).
 *
 * Instead of traversing the whole game tree on every iteration (vanilla CFR),
 * MCCFR samples part of the tree and forms unbiased estimates of the
 * counterfactual regrets. Two classic variants are implemented:
 *
 *   - Outcome sampling: sample a single terminal history per iteration and
 *     update only the info sets along it, importance-weighting by the sampling
 *     probability. High variance, very cheap per iteration.
 *   - External sampling: for the traverser, recurse on ALL of its actions; for
 *     the opponent and chance, sample a single action. Lower variance than
 *     outcome sampling and the most widely used MCCFR variant in practice.
 *
 * Both converge to a Nash equilibrium in the average strategy.
 *
 * Reference: Lanctot, Waugh, Zinkevich, Bowling (2009), "Monte Carlo Sampling
 * for Regret Minimization in Extensive Games" (NeurIPS).
 */
import { Game, Player } from './game';
import { RegretStore, InfoSetNode } from './store';
import { SeededRng } from './rng';

/** Returns the current regret-matching strategy as a fresh copy. */
function currentStrategy(node: InfoSetNode): number[] {
  return node.strategy().slice();
}

/** Shared base providing the average-strategy store. */
abstract class MccfrSolver<H> {
  readonly store = new RegretStore();
  protected t = 0;

  constructor(
    protected readonly game: Game<H>,
    protected readonly rng: SeededRng,
  ) {}

  get iterations(): number {
    return this.t;
  }

  train(n: number): void {
    for (let i = 0; i < n; i++) this.iterate();
  }

  abstract iterate(): void;
}

/**
 * Outcome-sampling MCCFR (Lanctot et al. 2009, Algorithm "OS").
 *
 * Each iteration, for each traverser, samples a single terminal history using a
 * behaviour policy that mixes the current strategy with epsilon-uniform
 * exploration at the traverser's nodes (and follows the current strategy / true
 * chance probabilities elsewhere). The recursion returns a pair (u, piTail):
 *   - `u`      = sampled terminal utility to the traverser divided by the full
 *                sample probability q of the chosen leaf (an unbiased estimate);
 *   - `piTail` = product of the traverser's strategy probabilities from the
 *                current node down to the leaf.
 *
 * At a traverser node the sampled counterfactual regret of the chosen action a
 * is  w * (piTail_after - piTail_before) style terms; concretely (per the paper)
 * for the sampled action  cfRegret += W*(1-s[a])*tail_child  and for the others
 * cfRegret += -W*s[a]*tail_child, where W = piOpp_to_node * u and tail_child is
 * the strategy-reach of the subtree below. The average strategy is updated at
 * the OPPONENT's nodes weighted by  piOpp/q.
 *
 * Reference: Lanctot, Waugh, Zinkevich, Bowling (2009), §4 (Outcome Sampling).
 */
export class OutcomeSamplingMccfr<H> extends MccfrSolver<H> {
  constructor(game: Game<H>, rng: SeededRng, private readonly epsilon = 0.6) {
    super(game, rng);
  }

  iterate(): void {
    this.t += 1;
    for (let p = 0; p < this.game.numPlayers(); p++) {
      this.sample(this.game.root(), p, 1, 1, 1);
    }
  }

  /**
   * @param h          current history
   * @param traverser  player whose regrets we update this pass
   * @param piTrav     reach of `traverser` to `h` under the current strategy
   * @param piOpp      reach of everyone else (opponent * chance) to `h`
   * @param q          probability `h` was sampled under the behaviour policy
   * @returns [u, piTail] where u = (leaf utility to traverser)/q and piTail is
   *          the traverser's strategy-reach from `h` to the sampled leaf.
   */
  private sample(
    h: H,
    traverser: Player,
    piTrav: number,
    piOpp: number,
    q: number,
  ): [number, number] {
    const game = this.game;
    if (game.isTerminal(h)) {
      return [game.utility(h, traverser) / q, 1];
    }
    if (game.isChance(h)) {
      const outcomes = game.chanceOutcomes(h);
      const idx = this.rng.sampleFromWeights(outcomes.map((o) => o.prob));
      const { next, prob } = outcomes[idx];
      return this.sample(next, traverser, piTrav, piOpp * prob, q * prob);
    }

    const player = game.currentPlayer(h);
    const key = game.infoSetKey(h);
    const actions = game.actions(h);
    const node = this.store.get(key, actions.length);
    const strategy = currentStrategy(node);
    const n = actions.length;

    // Behaviour (sampling) distribution: epsilon-uniform mix at traverser nodes.
    let sampleDist: number[];
    if (player === traverser) {
      sampleDist = new Array<number>(n);
      const u = this.epsilon / n;
      for (let i = 0; i < n; i++) sampleDist[i] = u + (1 - this.epsilon) * strategy[i];
    } else {
      sampleDist = strategy;
    }

    const ai = this.rng.sampleFromWeights(sampleDist);
    const qNode = q * sampleDist[ai];

    if (player === traverser) {
      const [util, tail] = this.sample(
        game.next(h, actions[ai]),
        traverser,
        piTrav * strategy[ai],
        piOpp,
        qNode,
      );
      // Counterfactual regret of the sampled action's subtree (Lanctot 2009).
      const W = util * piOpp;
      for (let i = 0; i < n; i++) {
        const regret = i === ai
          ? W * tail * (1 - strategy[ai])
          : -W * tail * strategy[ai];
        node.regretSum[i] += regret;
      }
      return [util, strategy[ai] * tail];
    }

    // Opponent (or other) node. The average strategy converging to equilibrium
    // is accumulated at the OPPONENT's info sets, weighted by the opponent's
    // reach divided by the sampling reach to this node (unbiased estimator of
    // the reach-weighted strategy contribution).
    const w = piOpp / q;
    for (let i = 0; i < n; i++) node.strategySum[i] += w * strategy[i];
    const [util, tail] = this.sample(
      game.next(h, actions[ai]),
      traverser,
      piTrav,
      piOpp * strategy[ai],
      qNode,
    );
    return [util, strategy[ai] * tail];
  }
}

/**
 * External-sampling MCCFR (Lanctot et al. 2009).
 *
 * For the traverser's nodes we recurse on every action (exact expectation over
 * the traverser's choices); for chance and the opponent we sample a single
 * action. This gives lower-variance regret estimates than outcome sampling.
 */
export class ExternalSamplingMccfr<H> extends MccfrSolver<H> {
  iterate(): void {
    this.t += 1;
    for (let p = 0; p < this.game.numPlayers(); p++) {
      this.traverse(this.game.root(), p);
    }
  }

  /**
   * Returns the sampled counterfactual value of `h` to `traverser`. Regrets are
   * updated at traverser nodes; the average strategy is updated at the
   * opponent's nodes (each visited once per iteration under sampling).
   */
  private traverse(h: H, traverser: Player): number {
    const game = this.game;
    if (game.isTerminal(h)) return game.utility(h, traverser);
    if (game.isChance(h)) {
      const outcomes = game.chanceOutcomes(h);
      const idx = this.rng.sampleFromWeights(outcomes.map((o) => o.prob));
      return this.traverse(outcomes[idx].next, traverser);
    }

    const player = game.currentPlayer(h);
    const key = game.infoSetKey(h);
    const actions = game.actions(h);
    const node = this.store.get(key, actions.length);
    const strategy = currentStrategy(node);
    const n = actions.length;

    if (player === traverser) {
      // Recurse on all actions; compute counterfactual regret directly.
      const util = new Array<number>(n).fill(0);
      let nodeUtil = 0;
      for (let i = 0; i < n; i++) {
        util[i] = this.traverse(game.next(h, actions[i]), traverser);
        nodeUtil += strategy[i] * util[i];
      }
      for (let i = 0; i < n; i++) {
        node.regretSum[i] += util[i] - nodeUtil;
      }
      return nodeUtil;
    }

    // Opponent (or other player): sample one action, update average strategy.
    const ai = this.rng.sampleFromWeights(strategy);
    for (let i = 0; i < n; i++) node.strategySum[i] += strategy[i];
    return this.traverse(game.next(h, actions[ai]), traverser);
  }
}
