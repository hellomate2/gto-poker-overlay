/**
 * CLI: emit src/core/ranges/preflop-strength.ts, a 169-entry preflop hand
 * strength table used by the villain range tracker for generic (chart-less)
 * preflop lines such as limps, cold 4-bets and 5-bets.
 *
 *   npx tsx src/solver/preflop/build-strength.ts
 *
 * Score per category i (higher = stronger):
 *   score(i) = 0.5 * eqVsRandom(i) + 0.5 * eqVsTop20(i)
 * where eqVsRandom is the combo-weighted mean of row i of the cached all-in
 * equity matrix (equity-matrix.json), and eqVsTop20 is the same mean taken only
 * over the top 20% of combos ranked by eqVsRandom. Equity vs random alone
 * over-ranks small pairs (77 above AKs); blending in equity vs a raising range
 * moves big broadway hands up, which is what a "top X%" preflop range should
 * look like. The output is a plain data module with no node dependencies so the
 * browser engine can import it.
 */
/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';
import { equityMatrix } from './equity-matrix';
import { categories, NUM_CATEGORIES } from './categories';

const OUT = path.join(__dirname, '..', '..', 'core', 'ranges', 'preflop-strength.ts');

const m = equityMatrix();
const cats = categories();

/** Combo-weighted equity of every category vs a category-weight vector w. */
function equityVs(w: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < NUM_CATEGORIES; i++) {
    let s = 0;
    let t = 0;
    for (let j = 0; j < NUM_CATEGORIES; j++) {
      const cw = w[j] * cats[j].comboCount;
      s += m[i][j] * cw;
      t += cw;
    }
    out.push(t > 0 ? s / t : 0.5);
  }
  return out;
}

const vsRandom = equityVs(cats.map(() => 1));
const order = [...vsRandom.keys()].sort((a, b) => vsRandom[b] - vsRandom[a]);
const top20 = new Array<number>(NUM_CATEGORIES).fill(0);
let cum = 0;
for (const i of order) {
  if (cum >= 0.2 * 1326) break;
  top20[i] = 1;
  cum += cats[i].comboCount;
}
const vsTop = equityVs(top20);
const score = vsRandom.map((x, i) => 0.5 * x + 0.5 * vsTop[i]);

const ranked = [...score.keys()].sort((a, b) => score[b] - score[a]);
const lines = ranked.map(i => `  '${cats[i].name}': ${score[i].toFixed(4)},`);

const src = `// ============================================================
// AUTO-GENERATED preflop hand strength table. DO NOT EDIT BY HAND.
//
// Produced by: npx tsx src/solver/preflop/build-strength.ts
//
// score = 0.5 * (all-in equity vs a random hand)
//       + 0.5 * (all-in equity vs the top 20% of hands)
// computed from the cached 169x169 equity matrix (src/solver/preflop/
// equity-matrix.json). Higher = stronger. Listed strongest first. Used by
// range-tracker.ts to build generic preflop ranges ("top X%", limp bands) for
// lines the solved/6-max charts do not cover.
// ============================================================

export const PREFLOP_STRENGTH: Record<string, number> = {
${lines.join('\n')}
};
`;

fs.writeFileSync(OUT, src);
console.log(`wrote ${OUT} (${ranked.length} hands); top: ${ranked.slice(0, 8).map(i => cats[i].name).join(' ')}`);
