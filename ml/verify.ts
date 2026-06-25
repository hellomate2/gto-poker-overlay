/**
 * ml/verify.ts — re-measure the SHIPPING postflop net on the FULL 10k held-out
 * test set, any time. Reuses the committed prep.ts parser + committed encodeSpot
 * + committed weights/forward pass, so the number it prints is the genuine
 * end-to-end accuracy of what ships.
 *
 * Run:  npm run ml:verify   (needs ml/data/postflop_test.csv present)
 */
import * as fs from 'fs';
import * as path from 'path';
import { predictPostflop, MODEL_ACCURACY } from '../src/core/ml/policy';
import { ACTIONS } from '../src/core/ml/features';
import { splitCsv, parseRow } from './prep';

const CSV = path.join(__dirname, 'data', 'postflop_test.csv');

function main(): void {
  if (!fs.existsSync(CSV)) {
    console.error(`missing ${CSV} — the raw test set is gitignored; cannot run full verify.`);
    process.exit(1);
  }
  const lines = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter(l => l.trim());
  const hc = splitCsv(lines[0]);
  const header: Record<string, number> = {};
  hc.forEach((n, i) => { header[n.trim()] = i; });

  let correct = 0, logloss = 0, n = 0;
  const confusion = ACTIONS.map(() => ACTIONS.map(() => 0));

  for (let i = 1; i < lines.length; i++) {
    const p = parseRow(splitCsv(lines[i]), header);
    if (!p) continue;
    const pred = predictPostflop(p.spot);
    const predIdx = ACTIONS.indexOf(pred.action);
    if (predIdx === p.label) correct++;
    confusion[p.label][predIdx]++;
    logloss += -Math.log(Math.max(pred.probs[ACTIONS[p.label]], 1e-12));
    n++;
  }
  const acc = correct / n;
  logloss /= n;

  console.log(`\n=== ml:verify — FULL test set (${n} rows) ===`);
  console.log(`legal-masked accuracy = ${(acc * 100).toFixed(4)}%`);
  console.log(`recorded model.ts test = ${(MODEL_ACCURACY.test * 100).toFixed(4)}%`);
  console.log(`mean log-loss          = ${logloss.toFixed(4)}`);
  console.log(`\nper-class precision / recall:`);
  for (let c = 0; c < ACTIONS.length; c++) {
    let tp = 0, fp = 0, fn = 0;
    for (let a = 0; a < ACTIONS.length; a++) {
      for (let pr = 0; pr < ACTIONS.length; pr++) {
        if (pr === c && a === c) tp += confusion[a][pr];
        else if (pr === c) fp += confusion[a][pr];
        else if (a === c) fn += confusion[a][pr];
      }
    }
    const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
    const rec = tp + fn > 0 ? tp / (tp + fn) : 0;
    console.log(`  ${ACTIONS[c].padEnd(5)} P=${(prec * 100).toFixed(1)}% R=${(rec * 100).toFixed(1)}% support=${tp + fn}`);
  }
}

main();
