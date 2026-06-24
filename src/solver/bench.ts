/**
 * Runnable convergence benchmark for the CFR solver package.
 *
 * Trains each algorithm on Kuhn and Leduc poker and prints an
 * exploitability-vs-iterations table. Exploitability is reported both in chips
 * per game (NashConv) and in milli-big-blinds per game (mbb/g), the standard
 * unit in the poker-solving literature, taking the big blind = 2 chips for
 * these limit games (the round-1 bet size).
 *
 * Run with:
 *   PATH=/opt/homebrew/bin:$PATH npx tsx src/solver/bench.ts
 *   (or via the package.json "solve:bench" script)
 */
import { Game } from './game';
import { KuhnPoker } from './games/kuhn';
import { LeducPoker } from './games/leduc';
import {
  CfrSolver,
  VANILLA,
  CFR_PLUS,
  LINEAR_CFR,
  DCFR,
  DiscountScheme,
} from './cfr';
import { OutcomeSamplingMccfr, ExternalSamplingMccfr } from './mccfr';
import { SeededRng } from './rng';
import { RegretStore } from './store';
import { averageStrategyProfile, exploitability } from './exploitability';

const BIG_BLIND = 2; // chips

function mbb(chips: number): number {
  return (chips / BIG_BLIND) * 1000;
}

function fmt(x: number, width = 12): string {
  return x.toFixed(6).padStart(width);
}

/** Runs a deterministic (full-tree) CFR-family scheme and prints a table. */
function benchCfr<H>(
  label: string,
  game: Game<H>,
  scheme: DiscountScheme,
  checkpoints: number[],
): void {
  const solver = new CfrSolver(game, { scheme });
  let done = 0;
  console.log(`\n  ${label} (${scheme.name})`);
  console.log(`    ${'iters'.padStart(8)}  ${'exploit(chips)'.padStart(14)}  ${'mbb/g'.padStart(12)}`);
  for (const cp of checkpoints) {
    solver.train(cp - done);
    done = cp;
    const prof = averageStrategyProfile(solver.store);
    const expl = exploitability(game, prof);
    console.log(`    ${String(cp).padStart(8)}  ${fmt(expl, 14)}  ${fmt(mbb(expl), 12)}`);
  }
}

/** Runs an MCCFR variant (seeded) and prints a table. */
function benchMccfr<H>(
  label: string,
  makeSolver: () => { store: RegretStore; train: (n: number) => void },
  game: Game<H>,
  checkpoints: number[],
): void {
  const solver = makeSolver();
  let done = 0;
  console.log(`\n  ${label}`);
  console.log(`    ${'iters'.padStart(8)}  ${'exploit(chips)'.padStart(14)}  ${'mbb/g'.padStart(12)}`);
  for (const cp of checkpoints) {
    solver.train(cp - done);
    done = cp;
    const prof = averageStrategyProfile(solver.store);
    const expl = exploitability(game, prof);
    console.log(`    ${String(cp).padStart(8)}  ${fmt(expl, 14)}  ${fmt(mbb(expl), 12)}`);
  }
}

function main(): void {
  const kuhn = new KuhnPoker();
  const leduc = new LeducPoker();

  console.log('============================================================');
  console.log(' CFR solver convergence benchmark');
  console.log(' exploitability = NashConv (sum of both best-response values)');
  console.log('============================================================');

  const kuhnCps = [10, 100, 1000, 10000];
  console.log('\n### KUHN POKER (game value to P0 = -1/18 ≈ -0.05556)');
  benchCfr('Kuhn', kuhn, VANILLA, kuhnCps);
  benchCfr('Kuhn', kuhn, CFR_PLUS, kuhnCps);
  benchCfr('Kuhn', kuhn, LINEAR_CFR, kuhnCps);
  benchCfr('Kuhn', kuhn, DCFR, kuhnCps);
  benchMccfr(
    'Kuhn  Outcome-Sampling MCCFR (seed=1)',
    () => new OutcomeSamplingMccfr(kuhn, new SeededRng(1)),
    kuhn,
    [1000, 10000, 100000, 500000],
  );
  benchMccfr(
    'Kuhn  External-Sampling MCCFR (seed=1)',
    () => new ExternalSamplingMccfr(kuhn, new SeededRng(1)),
    kuhn,
    [1000, 10000, 100000, 500000],
  );

  const leducCps = [100, 1000, 5000, 20000];
  console.log('\n### LEDUC POKER');
  benchCfr('Leduc', leduc, VANILLA, leducCps);
  benchCfr('Leduc', leduc, CFR_PLUS, leducCps);
  benchCfr('Leduc', leduc, DCFR, leducCps);
  benchMccfr(
    'Leduc External-Sampling MCCFR (seed=1)',
    () => new ExternalSamplingMccfr(leduc, new SeededRng(1)),
    leduc,
    [10000, 50000, 200000, 500000],
  );

  console.log('\nDone.');
}

main();
