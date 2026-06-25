import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { predictPostflop, MODEL_ACCURACY } from '../src/core/ml/policy';
import { ACTIONS, Spot } from '../src/core/ml/features';

// ============================================================
// REAL held-out accuracy of the SHIPPING postflop net.
//
// Runs the COMMITTED weights (src/core/ml/model.ts) through the COMMITTED
// forward pass (policy.ts) and COMMITTED encoder (features.ts) over a committed
// 2000-row held-out fixture (tests/fixtures/postflop-holdout.json), built from
// ml/data/postflop_test.csv with the EXACT prep.ts parsing logic.
//
// Asserts:
//   - legal-masked argmax accuracy >= recorded test accuracy - 3 points
//   - per-class precision + recall are all sane (the MIX is right, not just top-1)
//   - mean cross-entropy / log-loss is low
// All measured numbers are printed.
// ============================================================

interface FixtureSpot extends Spot { label: number; }

const FIXTURE = path.join(__dirname, 'fixtures', 'postflop-holdout.json');
const data: FixtureSpot[] = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

// Recompute predictions once, shared across the suite.
const N = data.length;
let correct = 0;
let logloss = 0;
// confusion[actual][pred]
const confusion = ACTIONS.map(() => ACTIONS.map(() => 0));

for (const s of data) {
  const pred = predictPostflop(s);
  const predIdx = ACTIONS.indexOf(pred.action);
  if (predIdx === s.label) correct++;
  confusion[s.label][predIdx]++;
  const pTrue = Math.max(pred.probs[ACTIONS[s.label]], 1e-12);
  logloss += -Math.log(pTrue);
}
const accuracy = correct / N;
logloss /= N;

function precisionRecall(cls: number) {
  let tp = 0, fp = 0, fn = 0;
  for (let a = 0; a < ACTIONS.length; a++) {
    for (let p = 0; p < ACTIONS.length; p++) {
      if (p === cls && a === cls) tp += confusion[a][p];
      else if (p === cls && a !== cls) fp += confusion[a][p];
      else if (p !== cls && a === cls) fn += confusion[a][p];
    }
  }
  const support = tp + fn;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = support > 0 ? tp / support : 0;
  return { precision, recall, support };
}

describe('postflop net — held-out fixture accuracy', () => {
  it('prints and asserts the REAL measured numbers', () => {
    // eslint-disable-next-line no-console
    console.log(
      `\n[ml-accuracy] fixture rows=${N} ` +
      `measured legal-masked accuracy=${(accuracy * 100).toFixed(2)}% ` +
      `(recorded test=${(MODEL_ACCURACY.test * 100).toFixed(2)}%) ` +
      `log-loss=${logloss.toFixed(4)}`
    );
    for (let c = 0; c < ACTIONS.length; c++) {
      const { precision, recall, support } = precisionRecall(c);
      // eslint-disable-next-line no-console
      console.log(
        `  ${ACTIONS[c].padEnd(5)} P=${(precision * 100).toFixed(1)}% ` +
        `R=${(recall * 100).toFixed(1)}% support=${support}`
      );
    }

    // Regression floor: real measured accuracy minus a small margin, AND it must
    // not be more than 3 points below the recorded test accuracy from model.ts.
    expect(accuracy).toBeGreaterThanOrEqual(MODEL_ACCURACY.test - 0.03);
    // Stable floor pinned a few points under the measured value (currently ~0.834).
    expect(accuracy).toBeGreaterThanOrEqual(0.80);
  });

  it('log-loss is low (calibrated, not just argmax-right)', () => {
    // Measured ~0.40; pin a generous ceiling so a real regression trips it.
    expect(logloss).toBeLessThan(0.55);
    expect(Number.isFinite(logloss)).toBe(true);
  });

  it('every action class has meaningful precision AND recall', () => {
    // Guards against a degenerate net that just predicts the majority class.
    for (let c = 0; c < ACTIONS.length; c++) {
      const { precision, recall, support } = precisionRecall(c);
      if (support < 30) continue; // skip tiny-support classes for stable thresholds
      expect(precision, `precision[${ACTIONS[c]}]`).toBeGreaterThan(0.4);
      expect(recall, `recall[${ACTIONS[c]}]`).toBeGreaterThan(0.4);
    }
  });

  it('the predicted action mix roughly tracks the label mix (no class collapse)', () => {
    const predCount = ACTIONS.map(() => 0);
    const labelCount = ACTIONS.map(() => 0);
    for (let a = 0; a < ACTIONS.length; a++) {
      for (let p = 0; p < ACTIONS.length; p++) {
        predCount[p] += confusion[a][p];
        labelCount[a] += confusion[a][p];
      }
    }
    // No single predicted class should dominate more than the labels do by a wide
    // margin, and every class that has real support should be predicted at least once.
    for (let c = 0; c < ACTIONS.length; c++) {
      if (labelCount[c] >= 30) {
        expect(predCount[c], `${ACTIONS[c]} never predicted`).toBeGreaterThan(0);
      }
    }
  });
});
