import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { forwardLogits } from '../src/core/ml/policy';

// ============================================================
// TRAIN / SERVE SKEW GUARD — the most important silent-bug test.
//
// ml/parity-gen.py loaded the COMMITTED weights + saved mean/std (decoded from
// model.ts) and computed reference logits in numpy for a fixed set of RAW feature
// vectors. Here the COMMITTED TS forward pass (policy.ts forwardLogits) runs on
// the identical raw vectors. If the two agree to a tight float tolerance, the
// shipped TS inference is byte-equivalent to the trained Python model — meaning
// no standardization mismatch, no transposed weight matrix, no layer-order bug.
// ============================================================

const PARITY = path.join(__dirname, 'fixtures', 'parity-vectors.json');
const parity: { inputs: number[][]; expectedLogits: number[][] } =
  JSON.parse(fs.readFileSync(PARITY, 'utf8'));

describe('TS forward pass == numpy reference (train/serve parity)', () => {
  it('reproduces numpy logits within 1e-4 on every fixed vector', () => {
    expect(parity.inputs.length).toBeGreaterThan(5);
    let maxAbs = 0;
    for (let i = 0; i < parity.inputs.length; i++) {
      const got = forwardLogits(parity.inputs[i]);
      const exp = parity.expectedLogits[i];
      expect(got.length).toBe(exp.length);
      for (let k = 0; k < exp.length; k++) {
        const d = Math.abs(got[k] - exp[k]);
        if (d > maxAbs) maxAbs = d;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`\n[ml-parity] vectors=${parity.inputs.length} max abs logit diff = ${maxAbs.toExponential(3)}`);
    expect(maxAbs).toBeLessThan(1e-4);
  });

  it('is deterministic — same input twice gives identical logits', () => {
    const a = forwardLogits(parity.inputs[0]);
    const b = forwardLogits(parity.inputs[0]);
    expect(a).toEqual(b);
  });
});
