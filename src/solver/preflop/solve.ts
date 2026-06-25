/**
 * Offline heads-up preflop equilibrium solve.
 *
 * Runs CFR (DCFR by default) over the {@link PreflopGame} tree for one or more
 * stack depths, measures exploitability (NashConv) to prove convergence, and
 * extracts per-category action strategies for each public node. The extracted
 * strategies are turned into Cell/Chart objects (see charts.ts) and written to
 * src/core/ranges/headsup-solved.ts.
 *
 * Run:  PATH=/opt/homebrew/bin:$PATH npm run solve:preflop
 */
import { CfrSolver, DCFR, DiscountScheme, CFR_PLUS } from '../cfr';
import { averageStrategyProfile, exploitability } from '../exploitability';
import { equityMatrix } from './equity-matrix';
import { PreflopGame, Node, TreeParams } from './tree';
import { NUM_CATEGORIES, categories } from './categories';

export interface NodeStrategy {
  /** node -> categoryIndex -> action-probability vector. */
  [node: string]: number[][];
}

export interface SolveResult {
  stack: number;
  iterations: number;
  exploitability: number;
  /** per-node, per-category average strategy. */
  strategies: NodeStrategy;
  game: PreflopGame;
}

/** Public nodes whose strategies we extract (skip TERMINAL / VS_JAM-by-jammer). */
const EXTRACT_NODES: Node[] = [
  Node.SB_OPEN,
  Node.BB_VS_LIMP,
  Node.BB_VS_OPEN,
  Node.SB_VS_BBRAISE,
  Node.SB_VS_3BET,
  Node.BB_VS_4BET,
];

/**
 * Extract the average strategy for every (node, category) by reading the store
 * directly via the canonical info-set keys. For VS_JAM we additionally extract
 * both the SB-facing and BB-facing variants (keyed by line).
 */
function extractStrategies(game: PreflopGame, solver: CfrSolver<any>): NodeStrategy {
  const prof = averageStrategyProfile(solver.store);
  const out: NodeStrategy = {};
  const cats = categories();

  const numActionsByNode: Record<string, number> = {
    [Node.SB_OPEN]: 4,
    [Node.BB_VS_LIMP]: 3,
    [Node.BB_VS_OPEN]: 4,
    [Node.SB_VS_BBRAISE]: 4,
    [Node.SB_VS_3BET]: 4,
    [Node.BB_VS_4BET]: 3,
  };

  // The canonical line string for each node (matches tree.ts `next`).
  const lineByNode: Record<string, string> = {
    [Node.SB_OPEN]: '',
    [Node.BB_VS_LIMP]: 'l',
    [Node.BB_VS_OPEN]: 'o',
    [Node.SB_VS_BBRAISE]: 'lr',
    [Node.SB_VS_3BET]: 'o3',
    [Node.BB_VS_4BET]: 'o34',
  };
  const playerByNode: Record<string, number> = {
    [Node.SB_OPEN]: 0,
    [Node.BB_VS_LIMP]: 1,
    [Node.BB_VS_OPEN]: 1,
    [Node.SB_VS_BBRAISE]: 0,
    [Node.SB_VS_3BET]: 0,
    [Node.BB_VS_4BET]: 1,
  };

  for (const node of EXTRACT_NODES) {
    const na = numActionsByNode[node];
    const player = playerByNode[node];
    const line = lineByNode[node];
    const grid: number[][] = [];
    for (let cat = 0; cat < NUM_CATEGORIES; cat++) {
      const key = `${player}|${cat}|${node}|${line}`;
      grid.push(prof.get(key, na));
    }
    out[node] = grid;
  }
  return out;
}

export interface SolveOptions {
  stack: number;
  iterations?: number;
  scheme?: DiscountScheme;
  treeParams?: Partial<TreeParams>;
  equity?: number[][];
  /** Called with (iter, exploitability) at checkpoints. */
  onCheckpoint?: (iter: number, expl: number) => void;
  checkpoints?: number[];
}

export function solvePreflop(opts: SolveOptions): SolveResult {
  const equity = opts.equity ?? equityMatrix();
  const params: TreeParams = { stack: opts.stack, ...opts.treeParams };
  const game = new PreflopGame(equity, params);
  const scheme = opts.scheme ?? DCFR;
  const solver = new CfrSolver(game, { scheme });

  const iterations = opts.iterations ?? 400;
  const checkpoints = opts.checkpoints ?? [];
  let done = 0;
  const cps = [...checkpoints].sort((a, b) => a - b);
  for (const cp of cps) {
    if (cp <= done) continue;
    solver.train(cp - done);
    done = cp;
    if (opts.onCheckpoint) {
      const expl = exploitability(game, averageStrategyProfile(solver.store));
      opts.onCheckpoint(done, expl);
    }
  }
  if (done < iterations) {
    solver.train(iterations - done);
    done = iterations;
  }

  const expl = exploitability(game, averageStrategyProfile(solver.store));
  if (opts.onCheckpoint && (cps.length === 0 || cps[cps.length - 1] < iterations)) {
    opts.onCheckpoint(done, expl);
  }

  return {
    stack: opts.stack,
    iterations: done,
    exploitability: expl,
    strategies: extractStrategies(game, solver),
    game,
  };
}
