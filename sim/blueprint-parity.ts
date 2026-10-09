// ============================================================
// Exact-reference checks for the BlueprintAgent bridge.
//
//   tree    Walk the whole TS abstract tree (src/core/blueprint/abstract-tree.ts)
//           and compare every node with the C++ tree through
//           `bp serve --tree-only`: node type, actor, street, commitments, and
//           every action token with its commitments. The node counts must
//           match too.
//   policy  Read a fixture written by `bp serve --parity-dump N` (infosets
//           drawn from the trainer's own deal sampler, with the trainer's
//           bucket and average strategy) and replay each through the TS
//           ServeClient (TS card objects -> request -> bp serve). Bucket,
//           tokens and probabilities must match.
//   web     The same fixture through the in-browser runtime
//           (src/core/blueprint/web-*.ts over the blueprint/web assets, no
//           `bp serve`): bucket and tokens must match exactly, probabilities
//           within the export's quantization (bytes summing to 255, so each
//           probability is off by less than 1/255).
//
// Usage:
//   npx tsx sim/blueprint-parity.ts tree   [--bin B] [--flags "..."]
//   npx tsx sim/blueprint-parity.ts policy --fixture F --ckpt C [--bin B] [--flags "..."]
//   npx tsx sim/blueprint-parity.ts web    --fixture F [--dir blueprint/web]
// Exit code 0 only when every check passes.
// ============================================================

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseCard } from '../src/core/cfr/card-utils';
import { Card } from '../src/types/poker';
import {
  parseTreeDescription, rootState, legalActions, applyAction, AbsState, walkTokens,
} from '../src/core/blueprint/abstract-tree';
import { ServeClient, DEFAULT_BP_FLAGS } from './blueprint-serve';
import { loadWebBlueprint } from '../src/core/blueprint/web-blueprint';
import { nodeAssetReader } from '../src/core/blueprint/web-assets';
import { cardToId } from '../src/core/cfr/card-utils';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function treeParity(bin: string, flags: string[]): Promise<number> {
  const client = new ServeClient(bin, [...flags, '--tree-only']);
  const info = await client.info();
  const rules = parseTreeDescription(info.tree);
  let nodes = 0, bad = 0;
  const stack: { s: AbsState; toks: string[] }[] = [{ s: rootState(rules), toks: [] }];
  // Batch requests so the pipe stays busy.
  while (stack.length) {
    const batch = stack.splice(Math.max(0, stack.length - 512));
    const replies = await Promise.all(batch.map(b => client.request({ cmd: 'node', history: b.toks.join(' ') })));
    batch.forEach((b, k) => {
      nodes++;
      const r = replies[k] as Record<string, unknown>;
      const fail = (m: string) => { if (bad++ < 10) console.log(`MISMATCH '${b.toks.join(' ')}': ${m}`); };
      if (!r.ok) return fail(String(r.error));
      if (r.type !== b.s.type) return fail(`type ${r.type} vs ${b.s.type}`);
      const contrib = r.contrib as number[];
      if (contrib[0] !== b.s.c[0] || contrib[1] !== b.s.c[1]) return fail(`contrib ${contrib} vs ${b.s.c}`);
      if (b.s.type === 'fold' && r.player !== b.s.folder) return fail(`folder ${r.player} vs ${b.s.folder}`);
      if (b.s.type !== 'decision') return;
      if (r.player !== b.s.player || r.street !== b.s.street) return fail(`player/street ${r.player}/${r.street} vs ${b.s.player}/${b.s.street}`);
      const acts = r.actions as { tok: string; contrib: number[] }[];
      const legal = legalActions(rules, b.s);
      if (acts.length !== legal.length) return fail(`nact ${acts.length} vs ${legal.length}`);
      for (let i = 0; i < legal.length; i++) {
        const child = applyAction(rules, b.s, legal[i]);
        if (acts[i].tok !== legal[i].tok) return fail(`tok ${acts[i].tok} vs ${legal[i].tok}`);
        if (acts[i].contrib[0] !== child.c[0] || acts[i].contrib[1] !== child.c[1]) return fail(`child contrib ${acts[i].contrib} vs ${child.c}`);
        stack.push({ s: child, toks: [...b.toks, legal[i].tok] });
      }
    });
  }
  client.close();
  if (nodes !== info.nodes) { console.log(`MISMATCH node count: TS ${nodes} vs C++ ${info.nodes}`); bad++; }
  console.log(`tree parity (${rules.name}): ${nodes} nodes compared, C++ reports ${info.nodes}, ${bad} mismatches`);
  return bad;
}

interface Fixture { history: string; hole: string; board: string; node: number; street: number; player: number; bucket: number; probs: number[]; toks: string[] }

async function policyParity(bin: string, flags: string[], fixture: string, ckpt: string): Promise<number> {
  const lines = readFileSync(fixture, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Fixture);
  const client = new ServeClient(bin, [...flags, '--ckpt', resolve(ckpt)]);
  const info = await client.info();
  const rules = parseTreeDescription(info.tree);
  const cards = (s: string): Card[] => { const o: Card[] = []; for (let i = 0; i < s.length; i += 2) o.push(parseCard(s.slice(i, i + 2))); return o; };
  let bad = 0, maxDiff = 0;
  const byStreet = [0, 0, 0, 0];
  for (const f of lines) {
    const hist = f.history ? f.history.split(' ') : [];
    const fail = (m: string) => { if (bad++ < 10) console.log(`MISMATCH '${f.history}' ${f.hole}/${f.board}: ${m}`); };
    const st = walkTokens(rules, hist);
    if (!st || st.type !== 'decision' || st.street !== f.street || st.player !== f.player) { fail('TS tree walk'); continue; }
    const tsToks = legalActions(rules, st).map(a => a.tok);
    if (tsToks.join(',') !== f.toks.join(',')) { fail(`TS toks ${tsToks} vs ${f.toks}`); continue; }
    const h = cards(f.hole);
    const ans = await client.policy(hist, [h[0], h[1]], cards(f.board));
    if (ans.bucket !== f.bucket) { fail(`bucket ${ans.bucket} vs trainer ${f.bucket}`); continue; }
    if (ans.toks.join(',') !== f.toks.join(',')) { fail(`toks ${ans.toks} vs ${f.toks}`); continue; }
    let d = 0;
    for (let i = 0; i < f.probs.length; i++) d = Math.max(d, Math.abs(ans.probs[i] - f.probs[i]));
    maxDiff = Math.max(maxDiff, d);
    if (d > 1e-6) { fail(`probs differ by ${d}`); continue; }
    byStreet[f.street]++;
  }
  client.close();
  console.log(`policy parity: ${lines.length} infosets (passing per street ${byStreet.join('/')}), max |dp| ${maxDiff.toExponential(2)}, ${bad} mismatches`);
  return bad;
}

/** Fixture through the browser runtime. Exported for tests/blueprint-web.test.ts. */
export async function webParity(fixture: string, dir?: string, log = console.log): Promise<{ n: number; bad: number; maxDiff: number; byStreet: number[]; maxDiffByStreet: number[] }> {
  const lines = readFileSync(fixture, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Fixture);
  const web = await loadWebBlueprint(nodeAssetReader(dir)!);
  const ids = (s: string): number[] => { const o: number[] = []; for (let i = 0; i < s.length; i += 2) o.push(cardToId(parseCard(s.slice(i, i + 2)))); return o; };
  let bad = 0, maxDiff = 0;
  const byStreet = [0, 0, 0, 0], maxDiffByStreet = [0, 0, 0, 0];
  const tol = 1 / 255 + 1e-6;  // quantization bound plus the fixture's 9-digit printing
  for (const f of lines) {
    const fail = (m: string) => { if (bad++ < 10) log(`MISMATCH '${f.history}' ${f.hole}/${f.board}: ${m}`); };
    const h = ids(f.hole);
    let ans;
    try { ans = web.source.lookup(f.history ? f.history.split(' ') : [], [h[0], h[1]], ids(f.board)); } catch (e) { fail(String(e)); continue; }
    if (ans.node !== f.node) { fail(`node ${ans.node} vs ${f.node}`); continue; }
    if (ans.bucket !== f.bucket) { fail(`bucket ${ans.bucket} vs trainer ${f.bucket}`); continue; }
    if (ans.toks.join(',') !== f.toks.join(',')) { fail(`toks ${ans.toks} vs ${f.toks}`); continue; }
    let d = 0;
    for (let i = 0; i < f.probs.length; i++) d = Math.max(d, Math.abs(ans.probs[i] - f.probs[i]));
    maxDiff = Math.max(maxDiff, d);
    maxDiffByStreet[f.street] = Math.max(maxDiffByStreet[f.street], d);
    if (d > tol) { fail(`probs differ by ${d}`); continue; }
    byStreet[f.street]++;
  }
  log(`web parity: ${lines.length} infosets (passing per street ${byStreet.join('/')}), bucket and tokens exact, max |dp| ${maxDiff.toExponential(3)} (per street ${maxDiffByStreet.map(x => x.toExponential(2)).join(' / ')}; bound 1/255 = ${(1 / 255).toExponential(3)}), ${bad} mismatches`);
  return { n: lines.length, bad, maxDiff, byStreet, maxDiffByStreet };
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const repo = resolve(__dirname, '..');
  const bin = resolve(arg('bin', resolve(repo, 'blueprint/bin/bp'))!);
  const flags = (arg('flags', process.env.GPO_BP_FLAGS ?? DEFAULT_BP_FLAGS)!).split(/\s+/).filter(Boolean);
  let bad: number;
  if (mode === 'tree') bad = await treeParity(bin, flags);
  else if (mode === 'policy') bad = await policyParity(bin, flags, arg('fixture')!, arg('ckpt')!);
  else if (mode === 'web') bad = (await webParity(arg('fixture')!, arg('dir'))).bad;
  else throw new Error('usage: blueprint-parity.ts tree|policy|web ...');
  process.exit(bad === 0 ? 0 : 1);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
