// ============================================================
// Export a trained blueprint for the browser extension.
//
// Inputs: a policy file written by `bp export` (tree + average strategy
// quantized to bytes summing to 255 per infoset) and the run's abstraction
// cache (cache/abs-<id>.bin: uint16 flop and turn bucket tables plus river
// centers). Output directory (default blueprint/web), every file gzipped:
//
//   policy.gpobp.gz  the `bp export` file, unchanged
//   flop.u8.gz       flop buckets as one byte per [canonical flop][combo]
//                    (combos that hit the board hold 255)
//   turn.u8.gz       same for turns
//   boards.u32.gz    canonical flop then turn keys in C++ id order (uint32 LE)
//   meta.json        format, abstraction id, raw file sizes, source checkpoint
//
// River buckets are not exported: the runtime computes EHS per decision and
// applies the river_bounds in the policy header (src/core/blueprint/web-tables.ts).
//
// Usage:
//   npx tsx blueprint/scripts/export-web.ts --policy P.gpobp --abs CACHE/abs-ID.bin [--out DIR] [--note TEXT]
// ============================================================

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { gzipSync } from 'zlib';
import { Blueprint } from '../../src/core/blueprint/loader';
import { NUM_COMBOS, enumerateCanonicalBoards } from '../../src/core/blueprint/web-tables';
import { WEB_FORMAT, WEB_VERSION, WebMeta } from '../../src/core/blueprint/web-blueprint';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function die(msg: string): never {
  console.error(`export-web: ${msg}`);
  process.exit(1);
}

const policyPath = arg('policy') ?? die('--policy required');
const absPath = arg('abs') ?? die('--abs required');
const outDir = resolve(arg('out') ?? resolve(__dirname, '../web'));

const policy = new Uint8Array(readFileSync(policyPath));
const bp = Blueprint.parse(policy);
const h = bp.header;
const absId = h.abstraction?.id;
if (!absId) die('policy header has no abstraction id');
if (h.game.indexOf('holdem') !== 0 || h.streets !== 4) die(`not a hold'em policy: ${h.game}`);

// ---- abstraction cache (abstraction.cpp Abstraction::save) ----
const abs = readFileSync(absPath);
if (abs.toString('latin1', 0, 8) !== 'GPOABS01') die('bad abstraction magic');
const [fk, tk, rk, bins] = [8, 12, 16, 20].map(o => abs.readInt32LE(o));
const seed = abs.readBigUInt64LE(28);
const n1 = Number(abs.readBigUInt64LE(36)), n2 = Number(abs.readBigUInt64LE(44)), n3 = Number(abs.readBigUInt64LE(52));
const id = `f${fk}-t${tk}-r${rk}-b${bins}-s${seed}`;
if (id !== absId) die(`abstraction ${id} does not match the policy's ${absId}`);
if ([fk, tk].some(k => k > 255)) die('more than 255 flop/turn buckets do not fit one byte');
if (h.buckets.join(',') !== `169,${fk},${tk},${rk}`) die(`bucket counts ${h.buckets} vs ${fk}/${tk}/${rk}`);
const flopKeys = enumerateCanonicalBoards(3);
const turnKeys = enumerateCanonicalBoards(4);
if (flopKeys.length !== 1755 || turnKeys.length !== 16432) die('canonical board counts');
if (n1 !== flopKeys.length * NUM_COMBOS || n2 !== turnKeys.length * NUM_COMBOS || n3 !== rk) die('table sizes');
const off = 60;
const toU8 = (start: number, n: number, k: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = abs.readUInt16LE(start + 2 * i);
    if (v < k) out[i] = v;
    else if (v === 0xffff) out[i] = 255;
    else die(`bucket ${v} out of range at ${i}`);
  }
  return out;
};
const flop = toU8(off, n1, fk);
const turn = toU8(off + 2 * n1, n2, tk);
// River bounds as the trainer derives them (0.5f * (c[i] + c[i+1])) must equal the header's.
const centers = Array.from({ length: n3 }, (_, i) => abs.readFloatLE(off + 2 * n1 + 2 * n2 + 4 * i));
const bounds = centers.slice(1).map((c, i) => Math.fround(Math.fround(0.5) * Math.fround(centers[i] + c)));
const hb = (h.abstraction?.river_bounds ?? []).map(x => Math.fround(x));
if (hb.length !== bounds.length || hb.some((x, i) => x !== bounds[i])) die('river bounds differ from the cache');

const boards = new Uint8Array(4 * (flopKeys.length + turnKeys.length));
const dv = new DataView(boards.buffer);
[...flopKeys, ...turnKeys].forEach((k, i) => dv.setUint32(4 * i, k, true));

mkdirSync(outDir, { recursive: true });
const write = (file: string, raw: Uint8Array): number => {
  const gz = gzipSync(raw, { level: 9 });
  writeFileSync(join(outDir, file), gz);
  console.log(`${file}: ${raw.byteLength} bytes raw, ${gz.byteLength} gzipped`);
  return gz.byteLength;
};
const meta: WebMeta = {
  format: WEB_FORMAT,
  version: WEB_VERSION,
  abstraction: { id, buckets: h.buckets },
  iterations: Number(h.iterations ?? 0),
  tree_config: h.tree_config,
  files: {
    policy: { file: 'policy.gpobp.gz', bytes: policy.byteLength },
    flop: { file: 'flop.u8.gz', bytes: flop.byteLength, boards: flopKeys.length },
    turn: { file: 'turn.u8.gz', bytes: turn.byteLength, boards: turnKeys.length },
    boards: { file: 'boards.u32.gz', bytes: boards.byteLength },
  },
  note: arg('note') ?? '',
};
let total = 0;
total += write(meta.files.policy.file, policy);
total += write(meta.files.flop.file, flop);
total += write(meta.files.turn.file, turn);
total += write(meta.files.boards.file, boards);
writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
console.log(`wrote ${outDir}: ${total} bytes of gzipped assets, abstraction ${id}, iteration ${meta.iterations}`);
