/**
 * ml/export-weights.ts — decode the COMMITTED model.ts weights (base64 Float32)
 * into a plain JSON of number arrays so ml/parity-gen.py (numpy) can load the
 * EXACT same trained weights + standardization and recompute reference logits.
 *
 * This does NOT retrain or alter weights — it only base64-decodes what is already
 * committed in src/core/ml/model.ts. Output goes to ml/_weights.json (gitignored;
 * a build artifact for parity-gen.py).
 *
 * Run:  npx tsx ml/export-weights.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { MODEL } from '../src/core/ml/model';

function b64ToArray(b64: string): number[] {
  const bin = Buffer.from(b64, 'base64');
  const f32 = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  return Array.from(f32);
}

const out = {
  dims: MODEL.dims,
  accuracy: MODEL.accuracy,
  mean: b64ToArray(MODEL.mean),
  std: b64ToArray(MODEL.std),
  weights: Object.fromEntries(
    Object.entries(MODEL.weights).map(([k, v]) => [k, b64ToArray(v)])
  ),
};

const OUT = path.join(__dirname, '_weights.json');
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${OUT}`);
