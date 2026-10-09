/**
 * CLI: emit src/core/ranges/jam-equity.ts, the per-hand all-in equity of every
 * one of the 169 hand classes against each 6-max chart's AGGRESSIVE range
 * (raise + allin share of every cell). gto-advisor.ts uses it to decide
 * call-or-fold against a short (<= 25bb) jam at a 6-max table, where the
 * heads-up SB-vs-BB Nash call table (pushfold-nash.ts) does not apply because
 * the jammer is not a heads-up small blind and players may be left to act.
 *
 *   npx tsx src/solver/preflop/build-jam-equity.ts
 *
 * Sources:
 *   - Jammer ranges: the repo's 6-max chart packs, looked up the same way
 *     gto-advisor.ts lookupChart(key, false) does (greenline-gto.ts first, then
 *     pekarstas-gto.ts). A jam with no raise before it is modelled with the
 *     jammer's RFI chart, a jam over one raise with its "vs-open" 3-bet portion,
 *     a jam over a 3-bet with its "vs-3bet" 4-bet portion. range-tracker.ts
 *     models a shove the same way (the scraper logs it as a raise).
 *   - Equity: the cached 169x169 all-in equity matrix (equity-matrix.json,
 *     Monte-Carlo, seeded; see equity-matrix.ts). Equity of class i vs a range
 *     = sum_j w_j * combos_j * M[i][j] / sum_j w_j * combos_j. Card removal
 *     between hero's class and the range is ignored (the same approximation the
 *     heads-up preflop solve and preflop-strength.ts make).
 *
 *
 * It also emits TOP_EQUITY: equity of every class against the top X% of
 * combos (ordered by PREFLOP_STRENGTH, the order range-tracker.ts uses for
 * "top X%" ranges; the boundary class is weighted fractionally) on the grid
 * TOP_FRACTIONS. gto-advisor.ts uses it for hero's share of a pot that a
 * player behind overcalls.
 *
 * The output is a plain data module with no node dependencies so the browser
 * engine can import it. Values are stored as integers in thousandths.
 */
/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';
import { equityMatrix } from './equity-matrix';
import { categories, NUM_CATEGORIES } from './categories';
import { charts as greenlineCharts, Cell, Chart } from '../../core/ranges/greenline-gto';
import { charts as pekarstasCharts } from '../../core/ranges/pekarstas-gto';
import { PREFLOP_STRENGTH } from '../../core/ranges/preflop-strength';

const OUT = path.join(__dirname, '..', '..', 'core', 'ranges', 'jam-equity.ts');

const m = equityMatrix();
const cats = categories();

/** Aggressive (raise + allin) share of a chart cell, 0..1. Mirrors normalizeCell in gto-advisor.ts. */
function aggressiveShare(cell: Cell | undefined): number {
  if (cell === undefined) return 0;
  if (typeof cell === 'string') return cell === 'raise' || cell === 'allin' ? 1 : 0;
  if (Array.isArray(cell)) {
    const [a, b] = cell;
    const agg = (x: string) => (x === 'raise' || x === 'allin' ? 1 : 0);
    return a === b ? agg(a) : 0.5 * agg(a) + 0.5 * agg(b);
  }
  const w = (cell.weight ?? 100) / 100;
  const acts = cell.actions as Record<string, number>;
  return w * (((acts.raise ?? 0) + (acts.allin ?? 0)) / 100);
}

const keys = new Set<string>([...Object.keys(greenlineCharts), ...Object.keys(pekarstasCharts)]);
const wanted = [...keys]
  .filter(k => /-RFI$/.test(k) || /-vs-open-/.test(k) || /-vs-3bet-/.test(k))
  .sort();

const tables: { key: string; frac: number; eq: number[] }[] = [];
for (const key of wanted) {
  const chart: Chart = greenlineCharts[key] || pekarstasCharts[key];
  const w = cats.map(c => aggressiveShare(chart[c.name]));
  let total = 0;
  for (let j = 0; j < NUM_CATEGORIES; j++) total += w[j] * cats[j].comboCount;
  if (total <= 0) continue; // a chart with no aggressive cells cannot describe a jam
  const eq: number[] = [];
  for (let i = 0; i < NUM_CATEGORIES; i++) {
    let s = 0;
    for (let j = 0; j < NUM_CATEGORIES; j++) s += m[i][j] * w[j] * cats[j].comboCount;
    eq.push(Math.round((1000 * s) / total));
  }
  tables.push({ key, frac: total / 1326, eq });
}

// ---- equity vs the top X% of hands --------------------------------------
const TOP_FRACTIONS = [0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85, 1];
const byStrength = [...cats].sort((a, b) => (PREFLOP_STRENGTH[b.name] ?? 0) - (PREFLOP_STRENGTH[a.name] ?? 0));
const topRows: number[][] = []; // [class][fraction]
for (let i = 0; i < NUM_CATEGORIES; i++) topRows.push([]);
for (const f of TOP_FRACTIONS) {
  const w = new Array<number>(NUM_CATEGORIES).fill(0);
  let left = f * 1326;
  for (const c of byStrength) {
    if (left <= 0) break;
    const take = Math.min(c.comboCount, left);
    w[c.index] = take / c.comboCount;
    left -= take;
  }
  let total = 0;
  for (let j = 0; j < NUM_CATEGORIES; j++) total += w[j] * cats[j].comboCount;
  for (let i = 0; i < NUM_CATEGORIES; i++) {
    let s2 = 0;
    for (let j = 0; j < NUM_CATEGORIES; j++) s2 += m[i][j] * w[j] * cats[j].comboCount;
    topRows[i].push(Math.round((1000 * s2) / total));
  }
}

const body = tables
  .map(t => `  // ${(100 * t.frac).toFixed(1)}% of combos\n  '${t.key}': [${t.eq.join(',')}],`)
  .join('\n');
const fracs = tables.map(t => `  '${t.key}': ${t.frac.toFixed(4)},`).join('\n');

const src = `// ============================================================
// AUTO-GENERATED jam-call equity tables. DO NOT EDIT BY HAND.
//
// Produced by: npx tsx src/solver/preflop/build-jam-equity.ts
//
// JAM_EQUITY[key][i] = all-in equity (thousandths) of hand class i (index
// order of handGroupIndex in core/cfr/card-utils.ts) against the aggressive
// (raise + allin) part of the 6-max chart \`key\` (greenline-gto.ts first, then
// pekarstas-gto.ts, as gto-advisor.ts looks charts up). Equities come from the
// cached 169x169 matrix in src/solver/preflop/equity-matrix.json. Card removal
// between hero's class and the range is ignored.
// ============================================================

export const JAM_EQUITY: Record<string, number[]> = {
${body}
};

/** Share of all 1326 combos in each key's aggressive range. */
export const JAM_RANGE_FRACTION: Record<string, number> = {
${fracs}
};

/** Grid of range widths (share of the 1326 combos) for TOP_EQUITY. */
export const TOP_FRACTIONS: number[] = [${TOP_FRACTIONS.join(', ')}];

/**
 * TOP_EQUITY[i][g] = all-in equity (thousandths) of hand class i against the
 * strongest TOP_FRACTIONS[g] of combos, ordered by PREFLOP_STRENGTH
 * (preflop-strength.ts), boundary class weighted fractionally.
 */
export const TOP_EQUITY: number[][] = [
${topRows.map((r, i) => `  [${r.join(',')}], // ${cats[i].name}`).join('\n')}
];
`;

fs.writeFileSync(OUT, src);
console.log(`wrote ${OUT}: ${tables.length} ranges`);
for (const t of tables) console.log(`  ${t.key.padEnd(18)} ${(100 * t.frac).toFixed(1)}%`);
