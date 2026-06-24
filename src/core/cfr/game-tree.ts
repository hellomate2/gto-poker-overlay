import { CardId, Street, StrategyDistribution } from '../../types/poker';

// ============================================================
// Abstracted Game Tree for NLHE Postflop
// Supports configurable bet sizing and action abstraction
// ============================================================

export type NodeType = 'player' | 'chance' | 'terminal';

export interface TreeConfig {
  /** Allowed bet sizes as fractions of pot */
  betSizes: number[];
  /** Maximum number of raises per street */
  maxRaisesPerStreet: number;
  /** Stack sizes (in BBs) for each player */
  stacks: [number, number];
  /** Starting pot (in BBs) */
  startingPot: number;
}

export const DEFAULT_TREE_CONFIG: TreeConfig = {
  betSizes: [0.5, 1.0],
  maxRaisesPerStreet: 2,
  stacks: [100, 100],
  startingPot: 6,
};

export interface GameTreeNode {
  type: NodeType;
  player: number; // 0 = OOP (out of position), 1 = IP (in position)
  street: Street;
  pot: number;
  stacks: [number, number];
  actions: string[]; // available action labels
  children: Map<string, GameTreeNode>;
  isTerminal: boolean;
  terminalValue?: number; // value for player 0 at terminal nodes
  actionHistory: string; // string encoding of actions taken to reach this node
}

/**
 * Build an abstracted game tree for a heads-up postflop spot.
 */
export function buildGameTree(config: TreeConfig = DEFAULT_TREE_CONFIG): GameTreeNode {
  const root: GameTreeNode = {
    type: 'player',
    player: 0, // OOP acts first
    street: 'flop',
    pot: config.startingPot,
    stacks: [...config.stacks] as [number, number],
    actions: [],
    children: new Map(),
    isTerminal: false,
    actionHistory: '',
  };

  buildNode(root, config, 0);
  return root;
}

function buildNode(node: GameTreeNode, config: TreeConfig, raisesThisStreet: number): void {
  if (node.isTerminal) return;

  const actions = getAvailableActions(node, config, raisesThisStreet);
  node.actions = actions;

  for (const action of actions) {
    const child = applyAction(node, action, config, raisesThisStreet);
    node.children.set(action, child);

    if (!child.isTerminal) {
      const newRaises = action.startsWith('raise') || action.startsWith('bet')
        ? raisesThisStreet + 1
        : (action === 'call' && node.street !== child.street ? 0 : raisesThisStreet);
      buildNode(child, config, action === 'call' && node.street !== child.street ? 0 : newRaises);
    }
  }
}

function getAvailableActions(node: GameTreeNode, config: TreeConfig, raisesThisStreet: number): string[] {
  const actions: string[] = [];
  const history = node.actionHistory;
  const lastAction = history.split(':').filter(Boolean).pop() || '';

  // If facing a bet/raise
  if (lastAction.startsWith('bet') || lastAction.startsWith('raise')) {
    actions.push('fold');
    actions.push('call');
    if (raisesThisStreet < config.maxRaisesPerStreet) {
      // Raise options
      for (const size of config.betSizes) {
        const raiseAmount = Math.round(node.pot * size);
        if (raiseAmount < node.stacks[node.player]) {
          actions.push(`raise_${size}`);
        }
      }
      // All-in is always an option
      if (node.stacks[node.player] > 0) {
        actions.push('allin');
      }
    }
  } else {
    // No bet facing us
    actions.push('check');
    // Bet options
    for (const size of config.betSizes) {
      const betAmount = Math.round(node.pot * size);
      if (betAmount < node.stacks[node.player] && betAmount > 0) {
        actions.push(`bet_${size}`);
      }
    }
    if (node.stacks[node.player] > 0) {
      actions.push('allin');
    }
  }

  return actions;
}

function applyAction(
  node: GameTreeNode,
  action: string,
  config: TreeConfig,
  raisesThisStreet: number,
): GameTreeNode {
  const newHistory = node.actionHistory + (node.actionHistory ? ':' : '') + action;
  const newStacks: [number, number] = [...node.stacks] as [number, number];
  let newPot = node.pot;
  let isTerminal = false;
  let terminalValue: number | undefined;
  let nextPlayer = 1 - node.player;
  let nextStreet = node.street;

  if (action === 'fold') {
    isTerminal = true;
    // Folding player loses; value for player 0
    terminalValue = node.player === 0 ? -(node.pot / 2) : (node.pot / 2);
  } else if (action === 'check') {
    // Check-check goes to next street or showdown
    const lastAction = node.actionHistory.split(':').filter(Boolean).pop() || '';
    if (lastAction === 'check' || (node.player === 1 && !lastAction.startsWith('bet') && !lastAction.startsWith('raise'))) {
      // Both checked - advance street
      nextStreet = advanceStreet(node.street);
      if (nextStreet === 'river' && node.street === 'river') {
        // After river check-check: showdown
        isTerminal = true;
        terminalValue = 0; // resolved by equity at showdown
      } else {
        nextPlayer = 0; // OOP acts first on new street
      }
    }
  } else if (action === 'call') {
    // Match the bet
    const callAmount = extractBetAmount(node.actionHistory, node.pot);
    newStacks[node.player] -= callAmount;
    newPot += callAmount;

    // After a call, advance street or showdown
    nextStreet = advanceStreet(node.street);
    if (node.street === 'river') {
      isTerminal = true;
      terminalValue = 0; // showdown
    } else {
      nextPlayer = 0; // OOP acts first
    }
  } else if (action.startsWith('bet_') || action.startsWith('raise_')) {
    const sizeFraction = parseFloat(action.split('_')[1]);
    const betAmount = Math.round(node.pot * sizeFraction);
    newStacks[node.player] -= betAmount;
    newPot += betAmount;
  } else if (action === 'allin') {
    const allinAmount = node.stacks[node.player];
    newStacks[node.player] = 0;
    newPot += allinAmount;
  }

  return {
    type: isTerminal ? 'terminal' : 'player',
    player: nextPlayer,
    street: isTerminal ? node.street : nextStreet,
    pot: newPot,
    stacks: newStacks,
    actions: [],
    children: new Map(),
    isTerminal,
    terminalValue,
    actionHistory: newHistory,
  };
}

function advanceStreet(street: Street): Street {
  switch (street) {
    case 'flop': return 'turn';
    case 'turn': return 'river';
    case 'river': return 'river'; // stays on river
    default: return street;
  }
}

function extractBetAmount(history: string, pot: number): number {
  const actions = history.split(':').filter(Boolean);
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    if (a.startsWith('bet_') || a.startsWith('raise_')) {
      const size = parseFloat(a.split('_')[1]);
      return Math.round(pot * size);
    }
  }
  return 0;
}

/**
 * Generate an information set key from the perspective of a player.
 * Includes: hand bucket, board bucket, and action history.
 */
export function infoSetKey(
  handBucket: number,
  boardBucket: number,
  actionHistory: string,
  player: number,
): string {
  return `${player}:${handBucket}:${boardBucket}:${actionHistory}`;
}

/**
 * Count total nodes in the game tree
 */
export function countNodes(node: GameTreeNode): number {
  let count = 1;
  for (const child of node.children.values()) {
    count += countNodes(child);
  }
  return count;
}
