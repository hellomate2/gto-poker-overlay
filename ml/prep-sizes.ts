/**
 * ml/prep-sizes.ts — write ONLY the bet-size bucket labels ({split}_sz.u8) for
 * the SIZE head, reusing the exact same parseRow skip logic as prep.ts so the
 * labels line up row-for-row with the already-built {split}_X.f32 / _y.u8 — WITHOUT
 * recomputing the (expensive) feature/equity tensors. It asserts length == shape.n.
 *
 * Run:  npx tsx ml/prep-sizes.ts
 */
import * as fs from 'fs';
import * as readline from 'readline';
import { splitCsv, parseRow } from './prep';

const DATA = `${__dirname}/data`;

async function go(split: 'train' | 'test'): Promise<void> {
  const csv = `${DATA}/postflop_${split}.csv`;
  if (!fs.existsSync(csv)) { console.error(`missing ${csv}`); return; }
  const rl = readline.createInterface({ input: fs.createReadStream(csv), crlfDelay: Infinity });
  let header: Record<string, number> | null = null;
  const szs: number[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = splitCsv(line);
    if (!header) { header = {}; cols.forEach((n, i) => { header![n.trim()] = i; }); continue; }
    try {
      const p = parseRow(cols, header);
      if (!p) continue;
      szs.push(p.szLabel);
    } catch { /* same skip behavior as prep.ts */ }
  }
  const sz = new Uint8Array(szs.length);
  for (let i = 0; i < szs.length; i++) sz[i] = szs[i];
  const shape = JSON.parse(fs.readFileSync(`${DATA}/${split}_shape.json`, 'utf8'));
  if (szs.length !== shape.n) {
    throw new Error(`ALIGNMENT MISMATCH ${split}: sz=${szs.length} but X has ${shape.n} rows`);
  }
  fs.writeFileSync(`${DATA}/${split}_sz.u8`, Buffer.from(sz.buffer));
  const dist: Record<number, number> = {};
  let labeled = 0;
  for (const v of szs) { dist[v] = (dist[v] || 0) + 1; if (v !== 255) labeled++; }
  console.log(`${split}: wrote ${szs.length} sz labels (aligned with X). bet/raise labeled=${labeled}. bucket dist=${JSON.stringify(dist)}`);
}

(async () => { await go('train'); await go('test'); })();
