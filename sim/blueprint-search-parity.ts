// ============================================================
// Parity: `bp serve` "search" against `bp search` on fixed spots.
//
// The serve request and the command line go through the same
// parse_search_request and run_search (blueprint/src/search.cpp), so for the
// same spot and the same fixed iteration count the two must return the same
// action labels and the same probabilities. This script draws N spots with a
// seeded RNG (random cards; a random non-fold, non-all-in walk of the
// checkpoint's tree to a turn or river decision; on every other spot the
// first bet of the current round is replaced by an off-tree pot fraction),
// asks both, and reports the largest probability difference.
//
//   npx tsx sim/blueprint-search-parity.ts --ckpt CKPT [--spots 20] [--seed 7]
//       [--river-iters 300] [--turn-iters 20] [--threads 1]
//   (tree flags from GPO_BP_FLAGS, binary from GPO_BP_BIN, as in
//   sim/blueprint-serve.ts)
// Exit code 1 on any mismatch.
// ============================================================

import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { ServeClient, DEFAULT_BP_FLAGS } from './blueprint-serve';
import { parseTreeDescription, rootState, legalActions, applyAction, AbsState, TreeRules } from '../src/core/blueprint/abstract-tree';
import { makeRng, shuffledDeck } from './ring';
import { Card } from '../src/types/poker';
import { idToCard } from '../src/core/cfr/card-utils';

function arg(name: string, d: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d;
}

interface Spot { street: number; history: string[]; hole: Card[]; board: Card[]; offtree: boolean }

const OFF_FRACS = [0.33, 0.4, 0.75, 0.8, 1.3, 1.7];

function drawSpot(rules: TreeRules, rng: () => number, street: number, offtree: boolean): Spot | null {
  let s: AbsState = rootState(rules);
  const hist: string[] = [];
  let inRound = 0;
  const stopAfter = Math.floor(rng() * 3);  // actions to take inside the target round
  for (let guard = 0; guard < 60; guard++) {
    if (s.type !== 'decision') return null;
    if (s.street > street) return null;
    if (s.street === street) {
      const facing = Math.max(s.c[0], s.c[1]) > s.c[s.player];
      if (offtree && inRound === 0) {
        // the first actor of the round checks or bets an off-tree size
        if (rng() < 0.5) {
          const k = legalActions(rules, s).find(a => a.kind === 'check');
          if (!k) return null;
          hist.push(k.tok); s = applyAction(rules, s, k); inRound++;
          continue;
        }
      }
      if (offtree && !facing && inRound <= 1) {
        const f = OFF_FRACS[Math.floor(rng() * OFF_FRACS.length)];
        const p = s.player, mine = s.c[p], pot = s.c[0] + s.c[1];
        const to = mine + Math.max(rules.minBet, Math.round(f * pot));
        if (to >= rules.stack) return null;
        const legal = legalActions(rules, s);
        if (legal.some(a => a.to === to && a.kind !== 'check')) return null;
        hist.push(`b${f}`);
        s = applyAction(rules, s, { kind: 'bet', to, fracMilli: 0, tok: `b${f}` });
        if (s.type !== 'decision') return null;
        break;  // the opponent of the bettor is the hero
      }
      if (!offtree && inRound >= stopAfter) break;
    }
    const legal = legalActions(rules, s).filter(a => a.kind !== 'fold' && a.kind !== 'allin');
    // stay off the all-in call (terminal) and keep the walk short
    const pick = legal[Math.floor(rng() * legal.length)];
    hist.push(pick.tok);
    const was = s.street;
    s = applyAction(rules, s, pick);
    if (s.type === 'decision' && s.street === street && was === street) inRound++;
  }
  if (s.type !== 'decision' || s.street !== street) return null;
  const deck = shuffledDeck(rng).map(idToCard);
  const n = [0, 3, 4, 5][street];
  return { street, history: hist, hole: deck.slice(0, 2), board: deck.slice(2, 2 + n), offtree };
}

async function main(): Promise<void> {
  const ckpt = resolve(arg('ckpt', ''));
  const nSpots = Number(arg('spots', '20'));
  const seed = Number(arg('seed', '7'));
  const riverIters = Number(arg('river-iters', '300'));
  const turnIters = Number(arg('turn-iters', '20'));
  const threads = Number(arg('threads', '1'));
  const repo = resolve(__dirname, '..');
  const bin = resolve(process.env.GPO_BP_BIN ?? resolve(repo, 'blueprint/bin/bp'));
  const flags = (process.env.GPO_BP_FLAGS ?? DEFAULT_BP_FLAGS).split(/\s+/).filter(Boolean);
  const client = new ServeClient(bin, [...flags, '--ckpt', ckpt], repo);
  const info = await client.info();
  const rules = parseTreeDescription(info.tree);
  const rng = makeRng(seed);
  const spots: Spot[] = [];
  // 12 river (6 on-tree, 6 off-tree) and 8 turn (4 and 4) for --spots 20
  const nRiver = Math.round(nSpots * 0.6);
  while (spots.length < nSpots) {
    const k = spots.length;
    const street = k < nRiver ? 3 : 2;
    const off = (k < nRiver ? k : k - nRiver) % 2 === 1;
    const sp = drawSpot(rules, rng, street, off);
    if (sp) spots.push(sp);
  }
  const cs = (cs: Card[]) => cs.map(c => c.rank + c.suit).join('');
  let worst = 0, bad = 0;
  for (const [i, sp] of spots.entries()) {
    const iters = sp.street === 3 ? riverIters : turnIters;
    const hist = sp.history.join(' ');
    const served = await client.request({
      cmd: 'search', history: hist, hole: cs(sp.hole), board: cs(sp.board),
      'max-iters': iters, 'budget-ms': 1e9, threads,
    });
    const out = execFileSync(bin, ['search', ...flags, '--ckpt', ckpt, '--history', hist, '--hand', cs(sp.hole),
      '--board', cs(sp.board), '--max-iters', String(iters), '--budget-ms', '1e9', '--threads', String(threads), '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const line = out.split('\n').find(l => l.startsWith('json: '));
    if (!line) throw new Error(`no json line from bp search for spot ${i}`);
    const cli = JSON.parse(line.slice(6)) as { labels: string[]; probs: number[]; iters: number };
    let diff = Infinity;
    let note = '';
    if (!served.ok) note = `serve error: ${served.error}`;
    else if ((served.labels as string[]).join(' ') !== cli.labels.join(' ')) note = `labels ${served.labels} vs ${cli.labels}`;
    else if (served.iters !== cli.iters) note = `iterations ${served.iters} vs ${cli.iters}`;
    else diff = Math.max(...cli.probs.map((p, a) => Math.abs(p - (served.probs as number[])[a])));
    if (!(diff <= 1e-12)) bad++;
    if (Number.isFinite(diff)) worst = Math.max(worst, diff);
    console.log(`spot ${String(i + 1).padStart(2)}  ${sp.street === 3 ? 'river' : 'turn '} ${sp.offtree ? 'off-tree' : 'on-tree '}  ` +
      `hole ${cs(sp.hole)} board ${cs(sp.board).padEnd(10)} history '${hist}'  ${cli.iters} iters  ` +
      `labels ${cli.labels.join(',')}  max |diff| ${Number.isFinite(diff) ? diff.toExponential(2) : 'n/a'} ${note}`);
  }
  client.close();
  console.log(`${spots.length} spots, ${bad} mismatches, largest probability difference ${worst.toExponential(2)}`);
  process.exit(bad ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
