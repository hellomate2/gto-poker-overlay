/**
 * Optimized CFR traversal specialized to the heads-up preflop tree.
 *
 * The generic CfrSolver re-slices a reach array at every node and rebuilds the
 * 28,561-entry chance-outcome list each iteration. For this two-player tree we
 * can do much better: track reach as two scalars (traverser, opponent) and walk
 * the deal grid directly. The produced {@link RegretStore} is byte-for-byte
 * compatible with the generic solver's store, so the verified exploitability /
 * average-strategy code is reused unchanged.
 *
 * Algorithm is standard vanilla/DCFR CFR with alternating-traverser updates and
 * the same {@link DiscountScheme} discounting as cfr.ts.
 */
import { DiscountScheme } from '../cfr';
import { RegretStore, InfoSetNode } from '../store';
import { PreflopGame, PreflopHistory } from './tree';
import { NUM_CATEGORIES, comboWeight } from './categories';

export class PreflopCfr {
  readonly store = new RegretStore();
  private t = 0;
  private readonly scheme: DiscountScheme;
  private readonly game: PreflopGame;
  /** Precomputed deal grid: prob[i][j] and combo weights. */
  private readonly dealProb: number[];
  private readonly catWeight: number[];

  constructor(game: PreflopGame, scheme: DiscountScheme) {
    this.game = game;
    this.scheme = scheme;
    this.catWeight = new Array(NUM_CATEGORIES);
    let total = 0;
    for (let i = 0; i < NUM_CATEGORIES; i++) {
      this.catWeight[i] = comboWeight(i);
      total += this.catWeight[i];
    }
    // Marginal category probability (sum to 1).
    this.dealProb = this.catWeight.map((w) => w / total);
  }

  get iterations(): number {
    return this.t;
  }

  iterate(): void {
    this.t += 1;
    // Alternating updates: one traversal per traverser, like CfrSolver.iterate.
    for (let traverser = 0; traverser < 2; traverser++) {
      // Walk the deal grid. For the traverser's regret update the
      // counterfactual reach is the OPPONENT's reach, which here is the
      // opponent-category deal probability (chance reach). The traverser's own
      // reach starts at 1 (their card is fixed in their info set).
      for (let cSB = 0; cSB < NUM_CATEGORIES; cSB++) {
        for (let cBB = 0; cBB < NUM_CATEGORIES; cBB++) {
          const root = this.game.root();
          const h: PreflopHistory = {
            ...root,
            node: rootNext(root),
            catSB: cSB,
            catBB: cBB,
          };
          // Reach probabilities: each player's own card deal prob is part of
          // their reach; chance reach (the joint deal prob) is split so that
          // the opponent's category prob is in the opponent reach and the
          // traverser's category prob in the traverser reach.
          const piSB = this.dealProb[cSB];
          const piBB = this.dealProb[cBB];
          this.cfr(h, traverser, piSB, piBB);
        }
      }
    }
  }

  train(n: number): void {
    for (let i = 0; i < n; i++) this.iterate();
  }

  /**
   * Two-scalar-reach CFR recursion over the betting subtree (post-deal).
   * `piSB`/`piBB` are the reach probabilities of players 0/1 to this node
   * (including the deal probabilities). Returns expected utility to traverser.
   */
  private cfr(
    h: PreflopHistory,
    traverser: number,
    piSB: number,
    piBB: number,
  ): number {
    const game = this.game;
    if (game.isTerminal(h)) {
      return game.utility(h, traverser);
    }
    const player = game.currentPlayer(h);
    const actions = game.actions(h);
    const key = game.infoSetKey(h);
    const node = this.store.get(key, actions.length);
    const strategy = node.strategy();

    const actionValues = new Array<number>(actions.length).fill(0);
    let nodeValue = 0;

    for (let i = 0; i < actions.length; i++) {
      const child = game.next(h, actions[i]);
      let cv: number;
      if (player === 0) {
        cv = this.cfr(child, traverser, piSB * strategy[i], piBB);
      } else {
        cv = this.cfr(child, traverser, piSB, piBB * strategy[i]);
      }
      actionValues[i] = cv;
      nodeValue += strategy[i] * cv;
    }

    if (player === traverser) {
      const cfReach = player === 0 ? piBB : piSB; // opponent reach
      const ownReach = player === 0 ? piSB : piBB;
      this.applyRegretUpdate(node, actionValues, nodeValue, cfReach);
      this.applyStrategyUpdate(node, strategy, ownReach);
    }
    return nodeValue;
  }

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

/** The DEAL node's only transition is to SB_OPEN. */
function rootNext(_root: PreflopHistory): PreflopHistory['node'] {
  // import lazily to avoid cycle in typing; SB_OPEN value:
  return 'SB_OPEN' as PreflopHistory['node'];
}
