// ============================================================
// Node client for `bp serve` and the BlueprintAgent as a SeatAgent.
//
// ServeClient spawns blueprint/bin/bp serve with the checkpoint's tree and
// abstraction flags, writes one JSON request per line and resolves replies in
// order. makeBlueprintSeatAgent wraps src/core/blueprint/agent.ts for the
// simulator (sim/ring.ts SeatAgent): the duplicate match runner resets
// Math.random per game, and the agent draws its randomness from Math.random
// unless reseed() gives it a private stream.
//
// Spec strings (sim/match.ts --a-agent, sim/play/bots.ts):
//   blueprint:<ckpt>   with tree/abstraction flags from GPO_BP_FLAGS, the
//                      binary from GPO_BP_BIN (default blueprint/bin/bp in
//                      this checkout). Default flags are the overnight run's:
//                      --preset small --flop 200 --turn 200 --river 200
//                      --bins 50 --abs-seed 7 --cache blueprint/cache
//   blueprint+search:<ckpt>
//                      the same agent with real-time search on the river
//                      (`bp serve` "search", the code of `bp search`).
//                      Environment knobs, all optional:
//                        GPO_BP_SEARCH          river (default) | turn+river
//                        GPO_BP_SEARCH_MS       river budget, default 1500
//                        GPO_BP_SEARCH_TURN_MS  turn budget, default 2500
//                        GPO_BP_SEARCH_MIN_ITERS  default 100
//                        GPO_BP_SEARCH_MAX_ITERS  default none (budget only)
//                        GPO_BP_SEARCH_THREADS  default 1 (river solves do
//                                               not use threads; the turn does)
//                        GPO_BP_SEARCH_LOG      append one JSON line per search
// ============================================================

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { createInterface } from 'readline';
import { Card } from '../src/types/poker';
import { appendFileSync } from 'fs';
import {
  BlueprintAgent, PolicySource, PolicyAnswer, SearchSource, SearchRequest, SearchAnswer, SearchMode,
} from '../src/core/blueprint/agent';
import { parseTreeDescription, TreeRules } from '../src/core/blueprint/abstract-tree';
import { SeatAgent, SeatView, ActResult, makeRng, canRaiseNow, validateAction } from './ring';

export const DEFAULT_BP_FLAGS =
  '--preset small --flop 200 --turn 200 --river 200 --bins 50 --abs-seed 7 --cache blueprint/cache';

export interface ServeInfo {
  tree: string;
  abs: string;
  iterations: number;
  stack: number;
  blinds: [number, number];
  min_bet: number;
  buckets: number[];
  nodes: number;
}

type Reply = Record<string, unknown> & { ok: boolean; error?: string };

export class ServeClient implements PolicySource, SearchSource {
  private proc: ChildProcessWithoutNullStreams;
  private pending: { res: (r: Reply) => void; rej: (e: Error) => void }[] = [];
  private closed = false;
  private stderrTail: string[] = [];
  requests = 0;

  constructor(bin: string, args: string[], cwd?: string) {
    this.proc = spawn(bin, ['serve', ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      const p = this.pending.shift();
      if (!p) return;
      try { p.res(JSON.parse(line) as Reply); } catch (e) { p.rej(new Error(`bad reply from bp serve: ${line}`)); }
    });
    this.proc.stderr.on('data', (d: Buffer) => {
      for (const l of d.toString().split('\n')) if (l) { this.stderrTail.push(l); if (this.stderrTail.length > 20) this.stderrTail.shift(); }
    });
    this.proc.on('close', (code) => {
      this.closed = true;
      const err = new Error(`bp serve exited (code ${code}): ${this.stderrTail.join(' | ')}`);
      for (const p of this.pending.splice(0)) p.rej(err);
    });
  }

  request(obj: Record<string, string | number>): Promise<Reply> {
    if (this.closed) return Promise.reject(new Error(`bp serve is not running: ${this.stderrTail.join(' | ')}`));
    this.requests++;
    return new Promise((res, rej) => {
      this.pending.push({ res, rej });
      this.proc.stdin.write(JSON.stringify(obj) + '\n');
    });
  }

  async info(): Promise<ServeInfo> {
    const r = await this.request({ cmd: 'info' });
    if (!r.ok) throw new Error(`bp serve info failed: ${r.error}`);
    return r as unknown as ServeInfo;
  }

  async policy(history: readonly string[], hole: readonly [Card, Card], board: readonly Card[]): Promise<PolicyAnswer> {
    const r = await this.request({
      cmd: 'policy', history: history.join(' '),
      hole: hole.map(c => c.rank + c.suit).join(''), board: board.map(c => c.rank + c.suit).join(''),
    });
    if (!r.ok) throw new Error(`bp serve policy failed: ${r.error} (history '${history.join(' ')}')`);
    const actions = r.actions as { tok: string }[];
    return { toks: actions.map(a => a.tok), probs: r.probs as number[], bucket: r.bucket as number };
  }

  /** Real-time search at the hero's decision (`bp serve` "search"). */
  async search(req: SearchRequest): Promise<SearchAnswer> {
    const o: Record<string, string | number> = {
      cmd: 'search', history: req.history.join(' '),
      hole: req.hole.map(c => c.rank + c.suit).join(''), board: req.board.map(c => c.rank + c.suit).join(''),
      'budget-ms': req.budgetMs, 'min-iters': req.minIters,
    };
    if (req.maxIters !== undefined) o['max-iters'] = req.maxIters;
    if (req.threads !== undefined) o.threads = req.threads;
    const r = await this.request(o);
    if (!r.ok) throw new Error(`bp serve search failed: ${r.error} (history '${req.history.join(' ')}')`);
    return {
      labels: r.labels as string[], probs: r.probs as number[], iters: r.iters as number,
      complete: r.complete as boolean, ms: r.ms as number, offtree: r.offtree as boolean,
    };
  }

  close(): void {
    if (!this.closed) this.proc.stdin.end();
  }
}

/** p-th percentile (nearest rank) of a list of numbers. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return NaN;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))];
}

export interface BlueprintSpec {
  ckpt: string;
  bin: string;
  flags: string[];
  cwd: string;
}

/** Resolve "blueprint:<ckpt>" (plus GPO_BP_FLAGS / GPO_BP_BIN) for a checkout. */
export function parseBlueprintSpec(spec: string, repoDir: string): BlueprintSpec & { search: SearchMode } {
  const m = /^(blueprint|blueprint\+search):(.+)$/.exec(spec);
  if (!m) throw new Error(`not a blueprint spec: ${spec} (blueprint:<ckpt> or blueprint+search:<ckpt>)`);
  let search: SearchMode = 'off';
  if (m[1] === 'blueprint+search') {
    const env = process.env.GPO_BP_SEARCH ?? 'river';
    if (env !== 'river' && env !== 'turn+river') throw new Error(`GPO_BP_SEARCH must be river or turn+river, got ${env}`);
    search = env;
  }
  const ckpt = resolve(m[2]);
  if (!existsSync(ckpt)) throw new Error(`blueprint checkpoint not found: ${ckpt}`);
  const bin = resolve(process.env.GPO_BP_BIN ?? resolve(repoDir, 'blueprint/bin/bp'));
  if (!existsSync(bin)) throw new Error(`bp binary not found: ${bin} (cd blueprint && make)`);
  const flags = (process.env.GPO_BP_FLAGS ?? DEFAULT_BP_FLAGS).split(/\s+/).filter(Boolean);
  return { ckpt, bin, flags: [...flags, '--ckpt', ckpt], cwd: resolve(repoDir), search };
}

/** BlueprintDecision -> simulator action. Betting closed (an incomplete
 *  all-in did not reopen it) turns a raise into a call. */
export function decisionToAct(d: { action: string; toAmount?: number }, view: SeatView): ActResult {
  if ((d.action === 'raise' || d.action === 'allin') && !canRaiseNow(view)) {
    return { action: view.canCheck ? 'check' : 'call' };
  }
  switch (d.action) {
    case 'fold': return { action: view.canCheck ? 'check' : 'fold' };
    case 'check': return { action: view.canCheck ? 'check' : 'call' };
    case 'call': return { action: view.canCheck ? 'check' : 'call' };
    case 'allin': return { action: 'raise', toAmount: view.maxTo };
    default: return { action: 'raise', toAmount: d.toAmount };
  }
}

export interface BlueprintSeat extends SeatAgent {
  /** Actions that failed the strict validator (sim/ring.ts validateAction). */
  illegal: number;
  agent: BlueprintAgent;
  client: ServeClient;
  info: ServeInfo;
  close(): void;
}

/** Start `bp serve` and wrap a BlueprintAgent as a simulator seat. */
export async function makeBlueprintSeatAgent(spec: string, name: string, repoDir: string): Promise<BlueprintSeat> {
  const s = parseBlueprintSpec(spec, repoDir);
  const client = new ServeClient(s.bin, s.flags, s.cwd);
  const info = await client.info();
  const rules: TreeRules = parseTreeDescription(info.tree);
  let privateRng: (() => number) | null = null;
  const envNum = (k: string): number | undefined => {
    const v = process.env[k];
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${k} must be a positive number, got ${v}`);
    return n;
  };
  const log = process.env.GPO_BP_SEARCH_LOG;
  const agent = new BlueprintAgent({
    rules, source: client, rng: () => (privateRng ?? Math.random)(),
    search: s.search, searchSource: s.search === 'off' ? undefined : client,
    searchBudgetMs: envNum('GPO_BP_SEARCH_MS'), searchTurnBudgetMs: envNum('GPO_BP_SEARCH_TURN_MS'),
    searchMinIters: envNum('GPO_BP_SEARCH_MIN_ITERS'), searchMaxIters: envNum('GPO_BP_SEARCH_MAX_ITERS'),
    searchThreads: envNum('GPO_BP_SEARCH_THREADS') ?? 1,
    onSearch: log ? (rec) => { try { appendFileSync(log, JSON.stringify({ seat: name, ...rec }) + '\n'); } catch { /* log only */ } } : undefined,
  });
  const seat: BlueprintSeat = {
    name, agent, client, info, illegal: 0,
    reseed(seed: number) { privateRng = makeRng(seed); },
    async act(view: SeatView): Promise<ActResult> {
      const act = decisionToAct(await agent.decide(view.state), view);
      if (!validateAction(view, { action: act.action, amount: act.toAmount }).ok) seat.illegal++;
      return act;
    },
    close() { client.close(); },
  };
  return seat;
}
