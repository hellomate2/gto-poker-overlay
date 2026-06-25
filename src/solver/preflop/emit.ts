/**
 * Serialize solved Cell/Chart objects into the generated TypeScript source for
 * src/core/ranges/headsup-solved.ts. The output is a plain data module that the
 * advisor imports; it carries no solver dependencies.
 */
import type { Cell, Chart } from '../../core/ranges/greenline-gto';
import { allHandNames } from '../../core/ranges/headsup-gto';
import type { SolvedCharts } from './charts';

export interface SolveMeta {
  exploitability: number;
  iterations: number;
  stack: number;
  sbOpenPct: number;
  bbDefendPct: number;
}

function cellLiteral(cell: Cell): string {
  if (typeof cell === 'string') return `'${cell}'`;
  if (Array.isArray(cell)) return `['${cell[0]}', '${cell[1]}']`;
  // WeightedCell
  const acts = Object.entries(cell.actions)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  return `{ weight: ${cell.weight}, actions: { ${acts} } }`;
}

function chartLiteral(name: string, chart: Chart): string {
  const lines: string[] = [];
  lines.push(`const ${name}: Chart = {`);
  // Emit in canonical hand order for readability; skip pure folds to keep the
  // file compact (the advisor treats a missing hand as fold).
  for (const hand of allHandNames()) {
    const cell = chart[hand];
    if (cell === undefined) continue;
    if (cell === 'fold') continue; // folds are the implicit default
    lines.push(`  '${hand}': ${cellLiteral(cell)},`);
  }
  lines.push('};');
  return lines.join('\n');
}

export function serializeCharts(charts: SolvedCharts, meta: SolveMeta): string {
  const header = `// ============================================================
// AUTO-GENERATED heads-up preflop equilibrium charts. DO NOT EDIT BY HAND.
//
// Produced by the offline CFR+ solver in src/solver/preflop/ via:
//     PATH=/opt/homebrew/bin:$PATH npm run solve:preflop
//
// This is a real Nash solve (counterfactual regret minimization, CFR+) over a
// heads-up preflop betting abstraction with all-in-equity leaves and
// realization factors (in-position 0.92, out-of-position 0.85). It is EXACT for
// push/fold and a strong approximation deep; see src/solver/preflop/README.md.
//
// Solve metadata (${meta.stack}bb effective):
//   iterations:      ${meta.iterations}
//   exploitability:  ${meta.exploitability.toFixed(5)} bb (NashConv; lower = closer to equilibrium)
//   SB open freq:    ${meta.sbOpenPct.toFixed(1)}%
//   BB defend freq:  ${meta.bbDefendPct.toFixed(1)}% (vs the SB open)
//
// Cell format matches greenline-gto.ts:
//   'raise'|'call'|'fold'|'allin'           pure action (100%)
//   ['raise','fold']                        50/50 mix
//   { weight, actions: { raise, call, ...}} weighted mix (weight = non-fold %)
//
// Folds are omitted: any hand not present in a chart is a pure fold.
// ============================================================

import type { Cell, Chart } from './greenline-gto';

/** Measured exploitability of this solve, in big blinds (NashConv). */
export const SOLVE_EXPLOITABILITY_BB = ${meta.exploitability.toFixed(6)};
/** CFR+ iterations used. */
export const SOLVE_ITERATIONS = ${meta.iterations};
/** Effective stack depth the primary solve was run at. */
export const SOLVE_STACK_BB = ${meta.stack};
`;

  // Emit each DISTINCT chart object once as a const, then map every advisor key
  // (including the lines that reuse a solved node) to its const so coverage is
  // complete with no duplication.
  const constNameByKey: Record<string, string> = {
    'SB-RFI': 'SB_RFI',
    'BB-vs-open-SB': 'BB_VS_OPEN_SB',
    'SB-vs-3bet-BB': 'SB_VS_3BET_BB',
    'BB-vs-4bet-SB': 'BB_VS_4BET_SB',
    'SB-vs-open-BB': 'SB_VS_BBRAISE',
  };

  // Determine which keys are aliases (same chart object as a primary key).
  const emittedConsts: string[] = [];
  const seen = new Map<Chart, string>();
  const keyToConst: Record<string, string> = {};
  for (const key of Object.keys(charts)) {
    const chart = charts[key];
    if (seen.has(chart)) {
      keyToConst[key] = seen.get(chart)!;
      continue;
    }
    const cname = constNameByKey[key] ?? key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
    seen.set(chart, cname);
    keyToConst[key] = cname;
    emittedConsts.push(chartLiteral(cname, chart));
  }

  const mapLines = Object.keys(charts)
    .map((key) => `  '${key}': ${keyToConst[key]},`)
    .join('\n');

  const footer = `
// Exported under the advisor's heads-up chart keys. In heads-up the Button is
// the Small Blind and acts first preflop, so 'SB-*' keys are the button lines.
// Every HU scenario key the advisor can produce is covered here (no gaps);
// rare/degenerate lines reuse the closest solved node.
export const charts: Record<string, Chart> = {
${mapLines}
};
`;

  return [header, emittedConsts.join('\n\n'), footer].join('\n') + '\n';
}
