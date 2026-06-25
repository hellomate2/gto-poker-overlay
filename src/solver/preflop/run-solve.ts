/**
 * CLI entry point: solve the heads-up preflop equilibrium and emit charts.
 *
 *   PATH=/opt/homebrew/bin:$PATH npm run solve:preflop
 *
 * Steps:
 *   1. Load (or compute+cache) the 169x169 all-in equity matrix.
 *   2. Run CFR+ over the preflop tree at 100bb (the primary cash depth) and,
 *      optionally, at shallower depths for depth-tagged variants.
 *   3. Report exploitability (NashConv) and key sanity numbers.
 *   4. Generate src/core/ranges/headsup-solved.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CFR_PLUS } from '../cfr';
import { averageStrategyProfile, exploitability } from '../exploitability';
import { equityMatrix } from './equity-matrix';
import { PreflopGame, Node, TreeParams } from './tree';
import { PreflopCfr } from './fast-cfr';
import { NodeStrategy } from './solve';
import { buildSolvedCharts } from './charts';
import { categories, NUM_CATEGORIES, nameToIndex } from './categories';
import { serializeCharts } from './emit';

const PRIMARY_STACK = 100;
// CFR+ converges extremely fast on this abstraction (the average strategy is
// essentially settled by ~100-150 iterations). Because the realization-factor
// leaves make the payoff slightly non-zero-sum, the zero-sum NashConv metric
// drifts mildly negative as iterations grow past the convergence point, so we
// stop where the average strategy is converged and |NashConv| is smallest.
const ITERATIONS = Number(process.env.PF_ITERS ?? 150);

function extractFromStore(cfr: PreflopCfr): NodeStrategy {
  // Logical action width per node (matches charts.ts ACTION_MAP):
  //   FOLD, LIMP/CALL, OPEN/RAISE, JAM  (4)   except BB_VS_4BET = FOLD/CALL/JAM (3)
  // When the open-jam is gated out (deep stacks) the STORED node has one fewer
  // action; we read the node's real averageStrategy and pad the missing trailing
  // JAM slot with 0 so the chart mapping stays uniform.
  const logicalWidth: Record<string, number> = {
    [Node.SB_OPEN]: 4,
    [Node.BB_VS_OPEN]: 4,
    [Node.SB_VS_3BET]: 4,
    [Node.BB_VS_4BET]: 3,
    [Node.SB_VS_BBRAISE]: 4,
  };
  const lineByNode: Record<string, string> = {
    [Node.SB_OPEN]: '',
    [Node.BB_VS_OPEN]: 'o',
    [Node.SB_VS_3BET]: 'o3',
    [Node.BB_VS_4BET]: 'o34',
    [Node.SB_VS_BBRAISE]: 'lr',
  };
  const playerByNode: Record<string, number> = {
    [Node.SB_OPEN]: 0,
    [Node.BB_VS_OPEN]: 1,
    [Node.SB_VS_3BET]: 0,
    [Node.BB_VS_4BET]: 1,
    [Node.SB_VS_BBRAISE]: 0,
  };
  const out: NodeStrategy = {};
  for (const node of [Node.SB_OPEN, Node.BB_VS_OPEN, Node.SB_VS_3BET, Node.BB_VS_4BET, Node.SB_VS_BBRAISE]) {
    const want = logicalWidth[node];
    const player = playerByNode[node];
    const line = lineByNode[node];
    const grid: number[][] = [];
    for (let cat = 0; cat < NUM_CATEGORIES; cat++) {
      const key = `${player}|${cat}|${node}|${line}`;
      // Read the node's real average strategy (whatever its action count), then
      // pad/truncate to the logical width.
      const stored = cfr.store.has(key)
        ? cfr.store.get(key, want).averageStrategy()
        : new Array<number>(want).fill(1 / want);
      const padded = stored.slice(0, want);
      while (padded.length < want) padded.push(0);
      grid.push(padded);
    }
    out[node] = grid;
  }
  return out;
}

function sbNonFoldPct(strategies: NodeStrategy): number {
  const grid = strategies[Node.SB_OPEN];
  let w = 0;
  let wo = 0;
  for (const c of categories()) {
    const s = grid[c.index];
    w += c.comboCount;
    wo += c.comboCount * (1 - s[0]); // 1 - fold
  }
  return (wo / w) * 100;
}

function bbDefendPct(strategies: NodeStrategy): number {
  const grid = strategies[Node.BB_VS_OPEN];
  let w = 0;
  let wo = 0;
  for (const c of categories()) {
    const s = grid[c.index];
    w += c.comboCount;
    wo += c.comboCount * (1 - s[0]);
  }
  return (wo / w) * 100;
}

function solveAt(stack: number, params?: Partial<TreeParams>) {
  const eq = equityMatrix();
  const game = new PreflopGame(eq, { stack, ...params });
  const cfr = new PreflopCfr(game, CFR_PLUS);
  const t0 = Date.now();
  const checkpoints = [50, 100, 200, 400, ITERATIONS].filter((v, i, a) => a.indexOf(v) === i && v <= ITERATIONS);
  let done = 0;
  for (const cp of checkpoints) {
    cfr.train(cp - done);
    done = cp;
    const expl = exploitability(game, averageStrategyProfile(cfr.store));
    console.log(`  [${stack}bb] iter ${cp}: exploitability = ${expl.toFixed(5)} bb  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  const expl = exploitability(game, averageStrategyProfile(cfr.store));
  const strategies = extractFromStore(cfr);
  return { stack, iterations: done, exploitability: expl, strategies };
}

function main(): void {
  console.log('=== Heads-Up Preflop Equilibrium Solve (CFR+) ===\n');
  console.log('Loading equity matrix...');
  equityMatrix();
  console.log('Matrix ready.\n');

  console.log(`Solving 100bb (${ITERATIONS} iterations)...`);
  const primary = solveAt(PRIMARY_STACK);

  console.log('\n--- Sanity ---');
  console.log(`SB open (non-fold) %: ${sbNonFoldPct(primary.strategies).toFixed(1)}`);
  console.log(`BB defend vs open %:  ${bbDefendPct(primary.strategies).toFixed(1)}`);
  const sb = primary.strategies[Node.SB_OPEN];
  const fmt = (n: string) => {
    const s = sb[nameToIndex(n)];
    return `fold ${(s[0] * 100).toFixed(0)} / limp ${(s[1] * 100).toFixed(0)} / open ${(s[2] * 100).toFixed(0)} / jam ${(s[3] * 100).toFixed(0)}`;
  };
  for (const h of ['AA', 'KK', 'AKs', '72o', '32o', 'K2o', 'A5s']) {
    console.log(`  SB ${h}: ${fmt(h)}`);
  }

  const charts = buildSolvedCharts(primary.strategies);

  const outPath = path.join(__dirname, '../../core/ranges/headsup-solved.ts');
  const src = serializeCharts(charts, {
    exploitability: primary.exploitability,
    iterations: primary.iterations,
    stack: PRIMARY_STACK,
    sbOpenPct: sbNonFoldPct(primary.strategies),
    bbDefendPct: bbDefendPct(primary.strategies),
  });
  fs.writeFileSync(outPath, src);
  console.log(`\nWrote ${outPath}`);
  console.log(`Final exploitability: ${primary.exploitability.toFixed(5)} bb\n`);
}

main();
