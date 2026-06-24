import { CardId, Street, StrategyDistribution, SolverResult } from '../../types/poker';
import { StrategyTable, StrategyCache } from './strategy';
import { buildGameTree, GameTreeNode, TreeConfig, DEFAULT_TREE_CONFIG, infoSetKey } from './game-tree';
import { createDeck, removeCards, shuffleDeck } from './card-utils';
import { evaluateHand } from '../equity/hand-eval';

// ============================================================
// Monte Carlo Counterfactual Regret Minimization (MCCFR)
// External Sampling variant for real-time poker solving
// ============================================================

export interface SolverConfig {
  iterations: number;
  timeLimitMs: number;
  treeConfig: TreeConfig;
  useCfrPlus: boolean; // use CFR+ (clamp negative regrets)
}

export const DEFAULT_SOLVER_CONFIG: SolverConfig = {
  iterations: 10000,
  timeLimitMs: 2000,
  treeConfig: DEFAULT_TREE_CONFIG,
  useCfrPlus: true,
};

/**
 * Bucket hands into clusters based on hand strength.
 * Simple implementation: use equity percentile buckets.
 */
function handBucket(heroCards: [CardId, CardId], board: CardId[], numBuckets: number = 10): number {
  // Quick hand strength evaluation
  if (board.length === 0) {
    // Preflop: use hand rank from card values
    const r1 = Math.floor(heroCards[0] / 4);
    const r2 = Math.floor(heroCards[1] / 4);
    const suited = heroCards[0] % 4 === heroCards[1] % 4;
    const high = Math.max(r1, r2);
    const low = Math.min(r1, r2);
    // Simple bucket: pair rank + high card value
    const strength = high === low ? 100 + high : high * 6 + low + (suited ? 3 : 0);
    return Math.min(numBuckets - 1, Math.floor(strength / (180 / numBuckets)));
  }

  // Postflop: evaluate current hand strength
  const fullHand = [...heroCards, ...board];
  const rank = evaluateHand(fullHand);
  // Map rank to bucket (0-9)
  // Category contributes most (0-8), rest is within-category tiebreaker
  const category = Math.floor(rank / 1_000_000);
  const withinCategory = (rank % 1_000_000) / 1_000_000;
  const rawBucket = category * (numBuckets / 9) + withinCategory * (numBuckets / 9);
  return Math.min(numBuckets - 1, Math.floor(rawBucket));
}

function boardBucket(board: CardId[], numBuckets: number = 5): number {
  if (board.length === 0) return 0;

  // Simple board texture bucketing
  const ranks = board.map(c => Math.floor(c / 4));
  const suits = board.map(c => c % 4);

  let texture = 0;

  // Flush draw potential
  const suitCounts = new Array(4).fill(0);
  for (const s of suits) suitCounts[s]++;
  const maxSuitCount = Math.max(...suitCounts);
  if (maxSuitCount >= 3) texture += 2;

  // Connectivity (straight draw potential)
  const sortedRanks = [...new Set(ranks)].sort((a, b) => a - b);
  let maxRun = 1;
  let run = 1;
  for (let i = 1; i < sortedRanks.length; i++) {
    if (sortedRanks[i] - sortedRanks[i - 1] <= 2) {
      run++;
      maxRun = Math.max(maxRun, run);
    } else {
      run = 1;
    }
  }
  if (maxRun >= 3) texture += 2;

  // Pairing
  if (ranks.length !== new Set(ranks).size) texture += 1;

  return Math.min(numBuckets - 1, texture);
}

export class MCCFRSolver {
  private strategyTable: StrategyTable;
  private cache: StrategyCache;
  private config: SolverConfig;

  constructor(config: SolverConfig = DEFAULT_SOLVER_CONFIG) {
    this.config = config;
    this.strategyTable = new StrategyTable();
    this.cache = new StrategyCache(200);
  }

  /**
   * Solve for the optimal strategy at a given game state.
   * This is the main entry point for the bot.
   */
  solve(
    heroCards: [CardId, CardId],
    board: CardId[],
    pot: number,
    heroStack: number,
    villainStack: number,
    heroPosition: number, // 0 = OOP, 1 = IP
    actionHistory: string = '',
  ): SolverResult {
    const startTime = performance.now();

    // Check cache
    const cacheKey = `${heroCards.join(',')}-${board.join(',')}-${pot}-${actionHistory}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.strategyTable = cached;
      return this.extractResult(heroCards, board, actionHistory, heroPosition, startTime);
    }

    // Build game tree for this spot
    const treeConfig: TreeConfig = {
      ...this.config.treeConfig,
      stacks: [heroPosition === 0 ? heroStack : villainStack, heroPosition === 0 ? villainStack : heroStack],
      startingPot: pot,
    };
    const root = buildGameTree(treeConfig);

    // Reset strategy table for new solve
    this.strategyTable = new StrategyTable();

    // Run MCCFR iterations
    let iterations = 0;
    const deadline = startTime + this.config.timeLimitMs;

    while (iterations < this.config.iterations && performance.now() < deadline) {
      // Sample random cards for chance nodes
      const deck = removeCards(createDeck(), [...heroCards, ...board]);
      const shuffled = shuffleDeck([...deck]);

      // Sample villain hand
      const villainCards: [CardId, CardId] = [shuffled[0], shuffled[1]];

      // Sample remaining board cards
      const remainingBoard = [...board];
      let deckIdx = 2;
      while (remainingBoard.length < 5) {
        remainingBoard.push(shuffled[deckIdx++]);
      }

      // Assign cards: player 0 = OOP, player 1 = IP
      const hands: [[CardId, CardId], [CardId, CardId]] = heroPosition === 0
        ? [heroCards, villainCards]
        : [villainCards, heroCards];

      // Run one iteration of external sampling MCCFR
      for (let traverser = 0; traverser < 2; traverser++) {
        this.externalSamplingCFR(
          root,
          hands,
          board,
          remainingBoard,
          traverser,
          1.0,
          1.0,
        );
      }

      if (this.config.useCfrPlus) {
        this.strategyTable.clampRegrets();
      }

      iterations++;
    }

    // Cache the result
    this.cache.set(cacheKey, this.strategyTable);

    return this.extractResult(heroCards, board, actionHistory, heroPosition, startTime, iterations);
  }

  /**
   * External Sampling MCCFR traversal
   */
  private externalSamplingCFR(
    node: GameTreeNode,
    hands: [[CardId, CardId], [CardId, CardId]],
    currentBoard: CardId[],
    fullBoard: CardId[],
    traverser: number,
    pi0: number, // reach probability for player 0
    pi1: number, // reach probability for player 1
  ): number {
    if (node.isTerminal) {
      return this.getTerminalValue(node, hands, fullBoard, traverser);
    }

    const player = node.player;
    const actions = node.actions;
    const numActions = actions.length;

    if (numActions === 0) return 0;

    // Compute information set key
    const boardForStreet = this.getBoardForStreet(node.street, currentBoard, fullBoard);
    const hBucket = handBucket(hands[player], boardForStreet);
    const bBucket = boardBucket(boardForStreet);
    const isKey = infoSetKey(hBucket, bBucket, node.actionHistory, player);

    // Get current strategy
    const strategy = this.strategyTable.getStrategy(isKey, numActions);

    if (player === traverser) {
      // Traverser node: compute counterfactual values for all actions
      const actionValues = new Float64Array(numActions);
      let nodeValue = 0;

      for (let i = 0; i < numActions; i++) {
        const child = node.children.get(actions[i]);
        if (!child) continue;

        const newPi0 = player === 0 ? pi0 * strategy[i] : pi0;
        const newPi1 = player === 1 ? pi1 * strategy[i] : pi1;

        actionValues[i] = this.externalSamplingCFR(
          child, hands, currentBoard, fullBoard, traverser, newPi0, newPi1,
        );
        nodeValue += strategy[i] * actionValues[i];
      }

      // Update regrets
      const opponentReach = player === 0 ? pi1 : pi0;
      const regrets: number[] = [];
      for (let i = 0; i < numActions; i++) {
        regrets.push(opponentReach * (actionValues[i] - nodeValue));
      }
      this.strategyTable.updateRegrets(isKey, regrets);

      return nodeValue;
    } else {
      // Opponent node: sample one action according to strategy
      const r = Math.random();
      let cumProb = 0;
      let sampledAction = 0;

      for (let i = 0; i < numActions; i++) {
        cumProb += strategy[i];
        if (r < cumProb) {
          sampledAction = i;
          break;
        }
      }

      // Accumulate strategy
      const playerReach = player === 0 ? pi0 : pi1;
      this.strategyTable.accumulateStrategy(isKey, strategy, playerReach);

      const child = node.children.get(actions[sampledAction]);
      if (!child) return 0;

      const newPi0 = player === 0 ? pi0 * strategy[sampledAction] : pi0;
      const newPi1 = player === 1 ? pi1 * strategy[sampledAction] : pi1;

      return this.externalSamplingCFR(
        child, hands, currentBoard, fullBoard, traverser, newPi0, newPi1,
      );
    }
  }

  /**
   * Get the board cards revealed up to a given street
   */
  private getBoardForStreet(street: Street, currentBoard: CardId[], fullBoard: CardId[]): CardId[] {
    switch (street) {
      case 'preflop': return [];
      case 'flop': return fullBoard.slice(0, Math.max(3, currentBoard.length));
      case 'turn': return fullBoard.slice(0, Math.max(4, currentBoard.length));
      case 'river': return fullBoard.slice(0, 5);
      default: return currentBoard;
    }
  }

  /**
   * Compute terminal node value
   */
  private getTerminalValue(
    node: GameTreeNode,
    hands: [[CardId, CardId], [CardId, CardId]],
    fullBoard: CardId[],
    traverser: number,
  ): number {
    if (node.terminalValue !== undefined && node.terminalValue !== 0) {
      // Fold: value is already computed
      return traverser === 0 ? node.terminalValue : -node.terminalValue;
    }

    // Showdown: evaluate both hands
    const hand0 = evaluateHand([...hands[0], ...fullBoard]);
    const hand1 = evaluateHand([...hands[1], ...fullBoard]);

    let value: number;
    if (hand0 > hand1) {
      value = node.pot / 2; // Player 0 wins
    } else if (hand0 < hand1) {
      value = -node.pot / 2; // Player 1 wins
    } else {
      value = 0; // Tie
    }

    return traverser === 0 ? value : -value;
  }

  /**
   * Extract the final strategy result for the hero
   */
  private extractResult(
    heroCards: [CardId, CardId],
    board: CardId[],
    actionHistory: string,
    heroPosition: number,
    startTime: number,
    iterations?: number,
  ): SolverResult {
    const hBucket = handBucket(heroCards, board);
    const bBucket = boardBucket(board);
    const isKey = infoSetKey(hBucket, bBucket, actionHistory, heroPosition);

    // Build game tree to get available actions
    const root = buildGameTree(this.config.treeConfig);
    const actions = this.getActionsAtHistory(root, actionHistory);
    const numActions = actions.length;

    const avgStrategy = this.strategyTable.getAverageStrategy(isKey, numActions);

    // Convert to StrategyDistribution
    const distribution: StrategyDistribution = {
      fold: 0,
      check: 0,
      call: 0,
      bets: [],
    };

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const prob = avgStrategy[i];

      if (action === 'fold') distribution.fold = prob;
      else if (action === 'check') distribution.check = prob;
      else if (action === 'call') distribution.call = prob;
      else if (action.startsWith('bet_') || action.startsWith('raise_')) {
        const size = parseFloat(action.split('_')[1]);
        distribution.bets.push({ amount: size, probability: prob });
      } else if (action === 'allin') {
        distribution.bets.push({ amount: Infinity, probability: prob });
      }
    }

    // Compute approximate EV
    const ev = this.computeEV(avgStrategy, actions);

    return {
      strategy: distribution,
      ev,
      iterations: iterations || 0,
      timeMs: performance.now() - startTime,
    };
  }

  private getActionsAtHistory(root: GameTreeNode, history: string): string[] {
    if (!history) return root.actions;

    let node = root;
    const parts = history.split(':').filter(Boolean);
    for (const part of parts) {
      const child = node.children.get(part);
      if (!child) return node.actions;
      node = child;
    }
    return node.actions;
  }

  private computeEV(strategy: Float64Array, actions: string[]): number {
    // Simplified EV estimate — in practice this comes from the CFR values
    let ev = 0;
    for (let i = 0; i < actions.length; i++) {
      if (actions[i] === 'fold') ev += strategy[i] * -1;
      else ev += strategy[i] * 0.5; // placeholder
    }
    return ev;
  }
}
