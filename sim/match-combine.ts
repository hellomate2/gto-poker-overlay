// ============================================================
// Combine `sim/match.ts --shard k/K` outputs into one summary.
//
// The match runner seeds every deal on its own, so running the K shards one
// after another (to keep each process short on a busy machine) gives the
// same numbers as `--workers K`. Each input file holds the @@MATCH_JSON@@
// line a shard prints.
//
//   npx tsx sim/match-combine.ts --mode hu shard-0.json shard-1.json ...
// ============================================================
import { readFileSync } from 'fs';
import { summarize, ShardResult, DealResult, MatchMode } from './match';
import { emptyPressure, addPressure } from './stats';

const argv = process.argv.slice(2);
let mode: MatchMode = 'hu';
const files: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--mode') mode = argv[++i] as MatchMode;
  else files.push(argv[i]);
}
const deals: DealResult[] = [];
const pa = emptyPressure(), pb = emptyPressure();
const notes: string[] = [];
for (const f of files) {
  const line = readFileSync(f, 'utf8').split('\n').find(l => l.startsWith('@@MATCH_JSON@@'));
  if (!line) throw new Error(`${f}: no @@MATCH_JSON@@ line`);
  const r = JSON.parse(line.slice('@@MATCH_JSON@@'.length)) as ShardResult;
  deals.push(...r.deals); addPressure(pa, r.pressureA); addPressure(pb, r.pressureB);
  notes.push(...(r.agentNotes ?? []).map(n => `${f}: ${n}`));
}
const ids = new Set(deals.map(d => d.i));
if (ids.size !== deals.length) throw new Error('duplicate deal indices across shards');
const s = summarize(mode, deals, pa, pb);
const lo = s.diff.bb100 - s.diff.ci95, hi = s.diff.bb100 + s.diff.ci95;
console.log(`${files.length} shards, ${s.deals} deals (${s.hands} hands), deal ids ${Math.min(...ids)}..${Math.max(...ids)}`);
console.log(`A vs B: ${s.diff.bb100 >= 0 ? '+' : ''}${s.diff.bb100.toFixed(2)} bb/100 for A, 95% CI +/-${s.diff.ci95.toFixed(2)} [${lo.toFixed(2)}, ${hi.toFixed(2)}], sd per deal ${s.diff.sdPerDealBb.toFixed(2)} bb`);
for (const n of notes) console.log(`  ${n}`);
