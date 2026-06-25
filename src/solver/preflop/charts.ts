/**
 * Convert solved per-category strategies into the Cell/Chart format consumed by
 * the GTO advisor (see core/ranges/greenline-gto.ts for the Cell type).
 *
 * The advisor's chart keys for heads-up are:
 *   'SB-RFI'         : SB (button) open decision        <- Node.SB_OPEN
 *   'BB-vs-open-SB'  : BB facing the SB open            <- Node.BB_VS_OPEN
 *   'SB-vs-3bet-BB'  : SB facing the BB 3-bet           <- Node.SB_VS_3BET
 *   'BB-vs-4bet-SB'  : BB facing the SB 4-bet           <- Node.BB_VS_4BET
 *
 * The advisor's Action vocabulary is { fold, call, raise, allin }. We map the
 * tree's node-specific actions onto these:
 *   SB_OPEN     [fold, open, limp, jam] -> fold / raise(open) / call(limp) / allin(jam)
 *   BB_VS_OPEN  [fold, call, 3bet, jam] -> fold / call / raise(3bet) / allin
 *   SB_VS_3BET  [fold, call, 4bet, jam] -> fold / call / raise(4bet) / allin
 *   BB_VS_4BET  [fold, call, jam]       -> fold / call / allin
 *
 * Each category becomes a WeightedCell { weight, actions } where `weight` is the
 * total non-fold frequency (0..100) and `actions` are the non-fold action
 * frequencies that sum to 100 among themselves (the advisor scales them by
 * weight and adds the fold remainder). Pure cells are emitted as plain strings
 * for compactness when a single action has ~100% frequency.
 */
import type { Cell, Chart } from '../../core/ranges/greenline-gto';
import { categories } from './categories';
import { Node } from './tree';
import { NodeStrategy } from './solve';

type AdvAction = 'fold' | 'call' | 'raise' | 'allin';

/** Map a node's positional action index -> advisor action. */
const ACTION_MAP: Record<string, AdvAction[]> = {
  [Node.SB_OPEN]: ['fold', 'raise', 'call', 'allin'],
  [Node.BB_VS_OPEN]: ['fold', 'call', 'raise', 'allin'],
  [Node.SB_VS_3BET]: ['fold', 'call', 'raise', 'allin'],
  [Node.BB_VS_4BET]: ['fold', 'call', 'allin'],
  // Limp-raise line: SB limped, BB raised, SB faces it (= SB-vs-open-BB).
  [Node.SB_VS_BBRAISE]: ['fold', 'call', 'raise', 'allin'],
};

/** Round to 1 decimal then to integer-ish for clean charts. */
function pct(x: number): number {
  return Math.round(x * 1000) / 10; // one decimal place of a percentage
}

/**
 * Build a Cell from an action-probability vector and the node's action mapping.
 * Frequencies below `prune` are dropped and the rest renormalized to remove
 * un-converged noise (e.g. a 1.5% stray "jam" on 72o).
 */
export function cellFromStrategy(
  probs: number[],
  node: Node,
  prune = 0.04,
): Cell {
  const map = ACTION_MAP[node];
  // Aggregate by advisor action (multiple indices could map to the same action;
  // here they don't, but keep it general).
  const agg: Record<string, number> = {};
  for (let i = 0; i < probs.length; i++) {
    const act = map[i];
    agg[act] = (agg[act] ?? 0) + probs[i];
  }

  // Prune small frequencies, then renormalize the whole distribution.
  let total = 0;
  for (const k of Object.keys(agg)) {
    if (agg[k] < prune) agg[k] = 0;
    total += agg[k];
  }
  if (total <= 0) return 'fold';
  for (const k of Object.keys(agg)) agg[k] /= total;

  const fold = agg['fold'] ?? 0;
  const nonFold: Partial<Record<AdvAction, number>> = {};
  let nonFoldTotal = 0;
  for (const k of ['call', 'raise', 'allin'] as AdvAction[]) {
    if (agg[k] && agg[k] > 0) {
      nonFold[k] = agg[k];
      nonFoldTotal += agg[k];
    }
  }

  // Pure fold.
  if (nonFoldTotal <= 1e-9) return 'fold';

  const weight = pct(nonFoldTotal); // overall non-fold frequency 0..100

  // Pure single non-fold action at ~100% weight -> plain string.
  const nfKeys = Object.keys(nonFold) as AdvAction[];
  if (weight >= 99.5 && nfKeys.length === 1) {
    return nfKeys[0];
  }

  // Build the actions block: frequencies among the non-fold actions, summing 100.
  const actions: Partial<Record<AdvAction, number>> = {};
  for (const k of nfKeys) {
    actions[k] = pct((nonFold[k]! / nonFoldTotal) * 1); // share of non-fold, 0..100
  }
  // Normalize rounding so the non-fold shares sum to exactly 100.
  fixSumTo100(actions);

  return { weight, actions };
}

/** Adjust the largest entry so the values sum to exactly 100. */
function fixSumTo100(actions: Partial<Record<string, number>>): void {
  const keys = Object.keys(actions);
  let sum = 0;
  for (const k of keys) sum += actions[k]!;
  if (keys.length === 0) return;
  const diff = 100 - sum;
  // Apply the rounding remainder to the largest action.
  let maxK = keys[0];
  for (const k of keys) if (actions[k]! > actions[maxK]!) maxK = k;
  actions[maxK] = Math.round((actions[maxK]! + diff) * 10) / 10;
}

/** Build a full Chart (169 cells) for one node from a NodeStrategy grid. */
export function chartFromNode(strategies: NodeStrategy, node: Node): Chart {
  const grid = strategies[node];
  const chart: Chart = {};
  for (const cat of categories()) {
    chart[cat.name] = cellFromStrategy(grid[cat.index], node);
  }
  return chart;
}

/**
 * The complete set of heads-up chart keys the GTO advisor can produce.
 * Hero is either the SB (button, acts first) or the BB. detectScenario emits:
 *   hero=SB: SB-RFI, SB-vs-open-BB, SB-vs-3bet-BB, SB-vs-4bet-BB
 *   hero=BB: BB-vs-open-SB, BB-vs-3bet-SB, BB-vs-4bet-SB
 * Every one of these maps to a solved node (some lines reuse the closest solved
 * node so there are NO coverage gaps for heads-up).
 */
export type SolvedCharts = Record<string, Chart>;

/** Map the solved node strategies onto ALL of the advisor's HU chart keys. */
export function buildSolvedCharts(strategies: NodeStrategy): SolvedCharts {
  const sbOpen = chartFromNode(strategies, Node.SB_OPEN);
  const bbVsOpen = chartFromNode(strategies, Node.BB_VS_OPEN);
  const sbVs3bet = chartFromNode(strategies, Node.SB_VS_3BET);
  const bbVs4bet = chartFromNode(strategies, Node.BB_VS_4BET);
  const sbVsBBraise = chartFromNode(strategies, Node.SB_VS_BBRAISE);

  return {
    // --- Canonical, natively-solved HU lines ---
    'SB-RFI': sbOpen,
    'BB-vs-open-SB': bbVsOpen,
    'SB-vs-3bet-BB': sbVs3bet,
    'BB-vs-4bet-SB': bbVs4bet,
    // --- SB facing a BB raise after limping (limp-raise line). ---
    'SB-vs-open-BB': sbVsBBraise,
    // --- Degenerate/rare lines the advisor can still key (bet-size inference).
    //     Map each to the closest solved node so coverage is complete. ---
    // BB "3-bets" the SB after a limp/open then SB-as-3bettor: model as the SB
    // facing-a-3bet response.
    'BB-vs-3bet-SB': sbVs3bet,
    // SB facing a BB 4-bet: the strongest continue spot, same shape as facing a
    // 4-bet out of position.
    'SB-vs-4bet-BB': bbVs4bet,
  };
}
