#!/usr/bin/env node
// ============================================================
// TexasSolver adapter
//
// Turns a small spot config (JSON) into a real GTO solution by
// driving the TexasSolver *console* binary, then normalizes the
// solver's dump into the trainer's SolvedSpot format and writes it
// to src/trainer/spots/<id>.json (picked up automatically by the
// trainer build).
//
// Usage:
//   node solver/solve.mjs <spot-config.json> --solver /path/to/console_solver
//   (or set TEXAS_SOLVER=/path/to/console_solver)
//
// Get the prebuilt console binary from:
//   https://github.com/bupticybee/TexasSolver/releases   (console branch build)
//
// Example config: solver/example_spot.json
// ============================================================

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SPOTS_DIR = join(ROOT, 'src', 'trainer', 'spots');

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const configPath = process.argv[2];
if (!configPath || configPath.startsWith('--')) {
  console.error('Usage: node solver/solve.mjs <spot-config.json> --solver /path/to/console_solver');
  process.exit(1);
}
const solverBin = arg('--solver') || process.env.TEXAS_SOLVER;
if (!solverBin || !existsSync(solverBin)) {
  console.error('TexasSolver console binary not found. Pass --solver <path> or set TEXAS_SOLVER.');
  console.error('Download it from https://github.com/bupticybee/TexasSolver/releases');
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(configPath, 'utf8'));

// ---- build the TexasSolver input file ----
const tmpOut = join(__dirname, `_out_${cfg.id}.json`);
const lines = [];
lines.push(`set_pot ${cfg.pot}`);
lines.push(`set_effective_stack ${cfg.effectiveStack}`);
lines.push(`set_board ${cfg.board.join(',')}`);
lines.push(`set_range_oop ${cfg.rangeOop}`);
lines.push(`set_range_ip ${cfg.rangeIp}`);
for (const pos of ['oop', 'ip']) {
  if (cfg.betSizes?.bet) lines.push(`set_bet_sizes ${pos},${cfg.street},bet,${cfg.betSizes.bet.join(',')}`);
  if (cfg.betSizes?.raise) lines.push(`set_bet_sizes ${pos},${cfg.street},raise,${cfg.betSizes.raise.join(',')}`);
}
lines.push(`set_allin_threshold ${cfg.allinThreshold ?? 0.67}`);
lines.push(`set_thread_num ${cfg.threads ?? 8}`);
lines.push(`set_accuracy ${cfg.accuracy ?? 0.5}`);
lines.push(`set_max_iteration ${cfg.maxIteration ?? 200}`);
lines.push(`set_use_isomorphism 1`);
lines.push(`build_tree`);
lines.push(`start_solve`);
lines.push(`set_dump_rounds 1`);
lines.push(`dump_result ${tmpOut}`);

const inputFile = join(__dirname, `_in_${cfg.id}.txt`);
writeFileSync(inputFile, lines.join('\n') + '\n');

console.log(`Solving ${cfg.id} … (this can take a while)`);
const run = spawnSync(solverBin, ['-i', inputFile], { stdio: 'inherit', cwd: dirname(solverBin) });
if (run.status !== 0) {
  console.error('Solver exited non-zero. Check the input above and your binary.');
  process.exit(1);
}

// ---- parse the solver dump into SolvedSpot ----
const raw = JSON.parse(readFileSync(tmpOut, 'utf8'));

// TexasSolver dumps a recursive tree. Find the first node that holds a
// player strategy: { actions: [...], strategy: { combo: [freqs...] } }.
// Schema varies slightly between builds, so we search defensively.
function findStrategyNode(node) {
  if (!node || typeof node !== 'object') return null;
  const s = node.strategy;
  if (s && Array.isArray(s.actions) && s.strategy && typeof s.strategy === 'object') return s;
  for (const k of Object.keys(node)) {
    const found = findStrategyNode(node[k]);
    if (found) return found;
  }
  return null;
}
const strat = findStrategyNode(raw);
if (!strat) {
  console.error('Could not locate a strategy node in the solver output.');
  console.error('Your TexasSolver build may use a different JSON schema — inspect', tmpOut,
    'and adjust findStrategyNode().');
  process.exit(1);
}

// normalize action strings -> keys + labels
function actionKey(a) {
  const t = a.trim().toUpperCase();
  if (t === 'CHECK') return ['check', 'Check'];
  if (t === 'CALL') return ['call', 'Call'];
  if (t === 'FOLD') return ['fold', 'Fold'];
  const m = t.match(/^(BET|RAISE|ALLIN)\s*([\d.]*)/);
  if (m) {
    const verb = m[1].toLowerCase();
    const size = m[2] ? `_${m[2].replace('.', '')}` : '';
    const label = m[2] ? `${m[1][0]}${m[1].slice(1).toLowerCase()} ${m[2]}` : 'All-in';
    return [`${verb}${size}`, label];
  }
  return [t.toLowerCase().replace(/\s+/g, '_'), a];
}

const keyed = strat.actions.map(actionKey);
const actions = keyed.map(k => k[0]);
const actionLabels = Object.fromEntries(keyed);

const hands = Object.entries(strat.strategy).map(([combo, freqs]) => {
  const f = {};
  actions.forEach((a, i) => { f[a] = Math.round((freqs[i] ?? 0) * 1000) / 1000; });
  return { hand: combo, freqs: f };
});

const solved = {
  id: cfg.id,
  title: cfg.title ?? cfg.id,
  street: cfg.street,
  board: cfg.board,
  pot: cfg.pot,
  effectiveStack: cfg.effectiveStack,
  toAct: cfg.toAct,
  actions,
  actionLabels,
  hands,
  source: 'TexasSolver',
};

if (!existsSync(SPOTS_DIR)) mkdirSync(SPOTS_DIR, { recursive: true });
const outPath = join(SPOTS_DIR, `${cfg.id}.json`);
writeFileSync(outPath, JSON.stringify(solved, null, 2));
console.log(`✓ wrote ${outPath} (${hands.length} combos). Rebuild the trainer to include it.`);
