// ============================================================
// Duplicate-format match runner: engine A vs engine B, in-process.
//
// Loads DecisionEngine from two source trees (dynamic import of
// <dir>/src/core/engine.ts), so a candidate branch's worktree can be compared
// with the baseline checkout without merging anything. Each tree's engine gets
// its own module graph (different absolute paths), so the two never share code
// or module state.
//
// Two modes:
//
//   hu     A vs B heads-up. Every deal is played twice with the same cards and
//          the same button SEAT: game 1 seats A in seat 0 and B in seat 1, game
//          2 swaps them. A's result for the deal is its net over both games, so
//          whoever got the good cards in game 1 gets them again in game 2 and
//          card luck cancels.
//
//   field  A and B each sit in seat 0 of the same table against the same
//          scripted field (2-6 seats), on the same deals. The per-deal
//          difference netA - netB cancels card luck and position (the button
//          rotates with the deal index, so seat 0 cycles through every
//          position). With --seats 2 this is "candidate vs baseline against
//          one archetype"; with --seats 6 it is the multiway comparison.
//
// Statistics: one sample per deal (hu: A's bb over the two games; field: the
// bb difference). bb/100 = 100 * mean / handsPerSample, and the 95% CI
// half-width is 1.96 * SE of that mean, i.e. it comes from the per-deal-pair
// variance, which is what duplicate play shrinks.
//
// Reproducibility: everything random is seeded per deal, never per process:
//   - the deck is shuffledDeck(makeRng(mixSeed(seed, deal))),
//   - Math.random (the bots' mixing + Monte-Carlo) is reset to
//     makeRng(mixSeed(seed, deal, 1)) before EACH game of the deal,
//   - scripted opponents are reseeded with mixSeed(seed, deal, seat) and draw
//     only from their own RNG (see agents.ts).
// So a deal's result does not depend on which deals ran before it, and
// splitting the deals across --workers processes gives the same numbers as one
// process (as long as the engines keep no random-dependent state across hands;
// the self-check below and tests/sim-match.test.ts verify that for this tree).
// Bots run without opponent tracking (the exploit adjuster carries state across
// hands, which would break per-deal independence).
//
// Usage:
//   npx tsx sim/match.ts --a DIR_A --b DIR_B [--mode hu|field] [--deals N] [--seed S]
//                        [--seats N] [--field a,b,c] [--workers K] [--out FILE]
//                        [--flags-a SPEC] [--flags-b SPEC]
//                        [--a-agent SPEC] [--b-agent SPEC] [--start-bb N]
// --flags-a / --flags-b set GPO_ENGINE_FLAGS (src/core/engine-flags.ts syntax)
// for that tree's engine only, so A and B can run different flag configs in one
// process. Without them both trees read the inherited GPO_ENGINE_FLAGS (or
// their own defaults when it is unset).
// --a-agent / --b-agent SPEC: engine (default) or blueprint:<ckpt> (BlueprintAgent
//   over `bp serve`, flags from GPO_BP_FLAGS; see sim/blueprint-serve.ts)
//   npm run sim:match -- --a /path/baseline --b /path/candidate --deals 2000
// Positive bb/100 means A won.
// ============================================================

import './fake-idb';
import { spawn, execFileSync } from 'child_process';
import { resolve } from 'path';
import { existsSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { playRingHand, RingConfig, SeatAgent, SeatView, makeRng, mixSeed, shuffledDeck } from './ring';
import { makeBotAgent, makeOpponent, archetypeNames, EngineCtor } from './agents';
import { PressureStats, emptyPressure, accumulatePressure, addPressure, pressureLines, pressureDiffLines, Running, bb100WithCI } from './stats';
import { DEFAULT_FIELD } from './ring-run';
import { makeSeatAgent, ClosableSeat, withEngineValidator } from './seat-agents';

const BB = 20, SB = 10, START_BB = 100;
const JSON_TAG = '@@MATCH_JSON@@';

const realLog = console.log.bind(console);
const realWarn = console.warn.bind(console);
const silence = () => { console.log = () => {}; console.warn = () => {}; };
const unsilence = () => { console.log = realLog; console.warn = realWarn; };

export type MatchMode = 'hu' | 'field';

export interface MatchOptions {
  mode: MatchMode;
  deals: number;
  seed: number;
  seats: number;          // field mode only (hu is always 2)
  field: string[];        // field mode: archetypes for seats 1..N-1 (cycled)
  // ---- seat agents (sim/seat-agents.ts) ----
  /** Agent spec for side A / B: undefined or 'engine' = the DecisionEngine
   *  passed in; 'blueprint:<ckpt>' = BlueprintAgent over `bp serve`. */
  aAgent?: string;
  bAgent?: string;
  /** Starting stack in big blinds (default START_BB = 100). */
  startBB?: number;
}

/** Per-deal outcome in chips. hu: a = A's net over both games, b = -a.
 *  field: a, b = each engine's net on its replay of the deal. */
export interface DealResult { i: number; a: number; b: number }

export interface ShardResult {
  deals: DealResult[];
  pressureA: PressureStats;
  pressureB: PressureStats;
  /** Notes from non-engine agents (e.g. blueprint fallback counts). */
  agentNotes?: string[];
}

/** Load DecisionEngine and give that tree's engine the flag spec `spec`
 *  (GPO_ENGINE_FLAGS syntax, resolved against the tree's own defaults). The
 *  variable is set while the tree's modules are first evaluated, and the flags
 *  are also set explicitly afterwards, because a tree whose engine-flags module
 *  was already imported (this script's own tree) would not re-read it.
 *  `spec` undefined keeps the inherited environment. */
export async function loadEngineWithFlags(dir: string, spec: string | undefined): Promise<EngineCtor> {
  if (spec === undefined) return loadEngine(dir);
  const saved = process.env.GPO_ENGINE_FLAGS;
  process.env.GPO_ENGINE_FLAGS = spec;
  try {
    const ctor = await loadEngine(dir);
    const flagsFile = resolve(dir, 'src/core/engine-flags.ts');
    if (!existsSync(flagsFile)) throw new Error(`--flags given but ${dir} has no src/core/engine-flags.ts`);
    const fm = await import(pathToFileURL(flagsFile).href);
    fm.setEngineFlags(fm.parseFlagSpec(spec));
    return ctor;
  } finally {
    if (saved === undefined) delete process.env.GPO_ENGINE_FLAGS;
    else process.env.GPO_ENGINE_FLAGS = saved;
  }
}

/** Load DecisionEngine from <dir>/src/core/engine.ts (each dir its own module graph). */
export async function loadEngine(dir: string): Promise<EngineCtor> {
  const file = resolve(dir, 'src/core/engine.ts');
  if (!existsSync(file)) throw new Error(`no engine at ${file}`);
  const mod = await import(pathToFileURL(file).href);
  const Ctor = mod.DecisionEngine ?? mod.default?.DecisionEngine;
  if (typeof Ctor !== 'function') throw new Error(`${file} does not export DecisionEngine`);
  return Ctor as EngineCtor;
}

/** Give an agent a fixed seat name, so both engines see identical player names. */
function seatProxy(inner: SeatAgent, name: string): SeatAgent {
  return { name, act: (v: SeatView) => inner.act(v) };
}

/**
 * Play deals i in [0, deals) with i % shardCount === shardIndex.
 * `engA`/`engB` are DecisionEngine classes (may be the same class).
 */
export async function runMatchShard(
  engA: EngineCtor, engB: EngineCtor, opts: MatchOptions, shardIndex = 0, shardCount = 1,
): Promise<ShardResult> {
  // Seat agents: DecisionEngine by default, or another agent kind by spec.
  const repoDir = resolve(__dirname, '..');
  const botA: ClosableSeat = opts.aAgent ? await makeSeatAgent(opts.aAgent, 'A', engA, repoDir) : withEngineValidator(makeBotAgent('A', { engineClass: engA }));
  const botB: ClosableSeat = opts.bAgent ? await makeSeatAgent(opts.bAgent, 'B', engB, repoDir) : withEngineValidator(makeBotAgent('B', { engineClass: engB }));
  const pressureA = emptyPressure(), pressureB = emptyPressure();
  const deals: DealResult[] = [];
  const cfg: RingConfig = { bb: BB, sb: SB, startStackBB: opts.startBB ?? START_BB, rng: () => { throw new Error('deck is always supplied'); } };

  const n = opts.mode === 'hu' ? 2 : opts.seats;
  const field: SeatAgent[] = [];
  if (opts.mode === 'field') {
    for (let s = 1; s < n; s++) {
      const kind = opts.field[(s - 1) % opts.field.length];
      field.push(makeOpponent(kind, 0, 200, `F${s}_${kind}`));
    }
  }

  for (let i = shardIndex; i < opts.deals; i += shardCount) {
    const deck = shuffledDeck(makeRng(mixSeed(opts.seed, i)));
    const button = i % n;
    const reseedAll = () => {
      Math.random = makeRng(mixSeed(opts.seed, i, 1));
      field.forEach((f, k) => f.reseed?.(mixSeed(opts.seed, i, 100 + k)));
    };

    if (opts.mode === 'hu') {
      reseedAll();
      const g1 = await playRingHand([seatProxy(botA, 'P0'), seatProxy(botB, 'P1')], button, cfg, 2 * i + 1, deck);
      reseedAll();
      const g2 = await playRingHand([seatProxy(botB, 'P0'), seatProxy(botA, 'P1')], button, cfg, 2 * i + 2, deck);
      const a = g1.nets[0] + g2.nets[1];
      deals.push({ i, a, b: -a });
      accumulatePressure(pressureA, g1.actions, 0); accumulatePressure(pressureA, g2.actions, 1);
      accumulatePressure(pressureB, g1.actions, 1); accumulatePressure(pressureB, g2.actions, 0);
    } else {
      reseedAll();
      const ga = await playRingHand([seatProxy(botA, 'P0'), ...field], button, cfg, i + 1, deck);
      reseedAll();
      const gb = await playRingHand([seatProxy(botB, 'P0'), ...field], button, cfg, i + 1, deck);
      deals.push({ i, a: ga.nets[0], b: gb.nets[0] });
      accumulatePressure(pressureA, ga.actions, 0);
      accumulatePressure(pressureB, gb.actions, 0);
    }
  }
  const agentNotes: string[] = [];
  for (const [side, b] of [['A', botA], ['B', botB]] as const) {
    if (b.describe) agentNotes.push(`${side}: ${b.describe()}`);
    b.close?.();
  }
  return agentNotes.length ? { deals, pressureA, pressureB, agentNotes } : { deals, pressureA, pressureB };
}

export interface MatchSummary {
  mode: MatchMode;
  deals: number;
  hands: number;            // hands played per engine
  /** hu: A's bb/100 vs B. field: (A - B) bb/100 against the same field. */
  diff: { bb100: number; ci95: number; sdPerDealBb: number };
  /** field only: each engine's own bb/100 vs the field (per-hand variance). */
  a?: { bb100: number; ci95: number };
  b?: { bb100: number; ci95: number };
  pressureA: PressureStats;
  pressureB: PressureStats;
}

export function summarize(mode: MatchMode, deals: DealResult[], pressureA: PressureStats, pressureB: PressureStats): MatchSummary {
  const diff = new Running(), ra = new Running(), rb = new Running();
  for (const d of [...deals].sort((x, y) => x.i - y.i)) {
    if (mode === 'hu') diff.push(d.a / BB);
    else { diff.push((d.a - d.b) / BB); ra.push(d.a / BB); rb.push(d.b / BB); }
  }
  const handsPerSample = mode === 'hu' ? 2 : 1;
  const dd = bb100WithCI(diff, handsPerSample);
  const out: MatchSummary = {
    mode, deals: deals.length, hands: deals.length * handsPerSample,
    diff: { ...dd, sdPerDealBb: Math.sqrt(diff.variance()) },
    pressureA, pressureB,
  };
  if (mode === 'field') { out.a = bb100WithCI(ra, 1); out.b = bb100WithCI(rb, 1); }
  return out;
}

function gitDescribe(dir: string): string {
  try {
    const sha = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
    const branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    return `${branch}@${sha}${dirty ? '+dirty' : ''}`;
  } catch { return 'not a git checkout'; }
}

function renderSummary(s: MatchSummary, opts: MatchOptions, dirA: string, dirB: string, secs: number): string[] {
  const sign = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
  const L: string[] = [];
  const what = s.mode === 'hu'
    ? `heads-up duplicate, ${s.deals} deals x 2 seatings = ${s.hands} hands`
    : `field duplicate, ${opts.seats} seats vs [${opts.field.join(',')}], ${s.deals} deals, each engine plays every deal`;
  L.push(`=== MATCH (${what}), seed ${opts.seed}, ${opts.startBB ?? START_BB}bb, blinds ${SB}/${BB} ===`);
  L.push(`A = ${opts.aAgent && opts.aAgent !== 'engine' ? opts.aAgent : `${dirA} (${gitDescribe(dirA)})`}`);
  L.push(`B = ${opts.bAgent && opts.bAgent !== 'engine' ? opts.bAgent : `${dirB} (${gitDescribe(dirB)})`}`);
  if (s.mode === 'hu') {
    L.push(`A vs B: ${sign(s.diff.bb100)} bb/100 for A, 95% CI ±${s.diff.ci95.toFixed(2)}  (sd per deal pair ${s.diff.sdPerDealBb.toFixed(2)} bb)`);
  } else {
    L.push(`A vs field: ${sign(s.a!.bb100)} bb/100 (±${s.a!.ci95.toFixed(1)})   B vs field: ${sign(s.b!.bb100)} bb/100 (±${s.b!.ci95.toFixed(1)})`);
    L.push(`A - B (paired): ${sign(s.diff.bb100)} bb/100, 95% CI ±${s.diff.ci95.toFixed(2)}  (sd per deal ${s.diff.sdPerDealBb.toFixed(2)} bb)`);
  }
  const lo = s.diff.bb100 - s.diff.ci95, hi = s.diff.bb100 + s.diff.ci95;
  L.push(`  -> ${lo > 0 ? 'A is better (CI excludes 0)' : hi < 0 ? 'B is better (CI excludes 0)' : 'no significant difference at 95%'}`);
  const pa = pressureLines(s.pressureA), pb = pressureLines(s.pressureB), pd = pressureDiffLines(s.pressureA, s.pressureB);
  for (const k of Object.keys(pa)) L.push(`  ${k.padEnd(26)} A ${pa[k].padEnd(22)} B ${pb[k].padEnd(22)} A-B ${pd[k]}`);
  L.push(`(${secs.toFixed(0)}s wall, ${(2 * s.deals / Math.max(secs, 1e-9)).toFixed(1)} games/s)`);
  return L;
}

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
    else out[a.slice(2)] = true;
  }
  return out;
}

async function runChild(script: string, baseArgs: string[], k: number, K: number): Promise<ShardResult> {
  return new Promise((res, rej) => {
    const child = spawn('npx', ['tsx', script, ...baseArgs, '--shard', `${k}/${K}`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d.toString(); });
    child.on('error', rej);
    child.on('close', (code) => {
      const line = buf.split('\n').find(l => l.startsWith(JSON_TAG));
      if (code !== 0 || !line) return rej(new Error(`shard ${k}/${K} failed (exit ${code})`));
      res(JSON.parse(line.slice(JSON_TAG.length)) as ShardResult);
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const repoRoot = resolve(__dirname, '..');
  const dirA = resolve(String(args.a ?? repoRoot));
  const dirB = resolve(String(args.b ?? dirA));
  const mode = String(args.mode ?? 'hu') as MatchMode;
  if (mode !== 'hu' && mode !== 'field') throw new Error(`--mode must be hu or field`);
  const seats = mode === 'hu' ? 2 : parseInt(String(args.seats ?? '6'), 10);
  if (seats < 2 || seats > 6) throw new Error('--seats must be 2..6');
  const field = String(args.field ?? DEFAULT_FIELD.join(',')).split(',').filter(Boolean);
  for (const f of field) if (!archetypeNames().includes(f)) throw new Error(`unknown archetype ${f}`);
  const opts: MatchOptions = {
    mode, seats, field,
    deals: parseInt(String(args.deals ?? '2000'), 10),
    seed: parseInt(String(args.seed ?? '1'), 10),
    aAgent: typeof args['a-agent'] === 'string' ? args['a-agent'] : undefined,
    bAgent: typeof args['b-agent'] === 'string' ? args['b-agent'] : undefined,
    startBB: typeof args['start-bb'] === 'string' ? parseInt(args['start-bb'], 10) : undefined,
  };
  const workers = Math.max(1, parseInt(String(args.workers ?? '1'), 10));
  const flagsA = typeof args['flags-a'] === 'string' ? args['flags-a'] : undefined;
  const flagsB = typeof args['flags-b'] === 'string' ? args['flags-b'] : undefined;
  const loadBoth = async () => [await loadEngineWithFlags(dirA, flagsA), await loadEngineWithFlags(dirB, flagsB)];

  // Child process: play one shard, emit JSON, exit.
  if (typeof args.shard === 'string') {
    const [k, K] = args.shard.split('/').map(x => parseInt(x, 10));
    const [A, B] = await loadBoth();
    silence();
    const r = await runMatchShard(A, B, opts, k, K);
    unsilence();
    realLog(JSON_TAG + JSON.stringify(r));
    return;
  }

  const t0 = Date.now();
  let deals: DealResult[] = [];
  const agentNotes: string[] = [];
  const pressureA = emptyPressure(), pressureB = emptyPressure();
  if (workers === 1) {
    const [A, B] = await loadBoth();
    silence();
    const r = await runMatchShard(A, B, opts);
    unsilence();
    deals = r.deals; addPressure(pressureA, r.pressureA); addPressure(pressureB, r.pressureB);
    agentNotes.push(...(r.agentNotes ?? []));
  } else {
    const base = ['--a', dirA, '--b', dirB, '--mode', mode, '--seats', String(seats), '--field', field.join(','),
      '--deals', String(opts.deals), '--seed', String(opts.seed),
      ...(flagsA !== undefined ? ['--flags-a', flagsA] : []), ...(flagsB !== undefined ? ['--flags-b', flagsB] : [])];
    if (opts.aAgent) base.push('--a-agent', opts.aAgent);
    if (opts.bAgent) base.push('--b-agent', opts.bAgent);
    if (opts.startBB !== undefined) base.push('--start-bb', String(opts.startBB));
    const parts = await Promise.all(Array.from({ length: workers }, (_, k) => runChild(__filename, base, k, workers)));
    for (const r of parts) {
      deals.push(...r.deals); addPressure(pressureA, r.pressureA); addPressure(pressureB, r.pressureB);
      agentNotes.push(...(r.agentNotes ?? []));
    }
  }
  const secs = (Date.now() - t0) / 1000;
  const s = summarize(mode, deals, pressureA, pressureB);
  const lines = renderSummary(s, opts, dirA, dirB, secs);
  if (flagsA !== undefined || flagsB !== undefined) {
    lines.splice(1, 0, `flags: A = ${flagsA ?? '(inherited)'}, B = ${flagsB ?? '(inherited)'}`);
  }
  for (const n of agentNotes) lines.push(`  agent ${n}`);
  for (const l of lines) realLog(l);
  if (typeof args.out === 'string') {
    writeFileSync(args.out, ['```', ...lines, '```', '', JSON.stringify(s)].join('\n') + '\n', 'utf8');
    realLog(`written ${args.out}`);
  }
}

if (require.main === module) {
  main().catch(e => { unsilence(); console.error(e); process.exit(1); });
}

