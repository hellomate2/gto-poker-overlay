// ============================================================
// Decision latency per engine-flag config.
//
// Plays seeded ring hands with this tree's DecisionEngine in seat 0 against a
// scripted field and times every decide() call (wall clock, includes the
// equity work, range tracking, defense and subgame solves). Reports p50 / p95 /
// p99 / max overall and per street, plus how often each decision path fired
// (read from the reasoning tags).
//
// Flags come from GPO_ENGINE_FLAGS (see src/core/engine-flags.ts), e.g.
//   GPO_ENGINE_FLAGS=all  npx tsx sim/latency.ts 300 1 --seats 6
//   GPO_ENGINE_FLAGS=none npx tsx sim/latency.ts 300 1 --seats 2 --field tag
// Timings depend on machine load; run configs you compare under the same load.
// ============================================================

import './fake-idb';
import { playRingHand, RingConfig, SeatAgent, makeRng, mixSeed, shuffledDeck } from './ring';
import { makeBotAgent, makeOpponent, EngineCtor } from './agents';
import { DecisionEngine } from '../src/core/engine';
import { describeEngineFlags, ENGINE_FLAGS } from '../src/core/engine-flags';
import { getWebBlueprint, lastLoadMs } from '../src/core/blueprint/web-assets';
import { GameState, BotDecision } from '../src/types/poker';
import { DEFAULT_FIELD } from './ring-run';

const BB = 20, SB = 10, START_BB = 100;
const realLog = console.log.bind(console);
const realWarn = console.warn.bind(console);

interface Sample { ms: number; street: string; path: string }
const samples: Sample[] = [];

function pathOf(d: BotDecision, s: GameState): string {
  const r = d.reasoning || '';
  if (r.startsWith('blueprint ')) return 'blueprint';
  if (s.street === 'preflop') return 'preflop';
  if (r.includes('[subgame]')) return 'subgame';
  if (r.includes('[defense]')) return 'defense';
  if (r.includes('[lead-policy]')) return 'lead-policy';
  if (r.startsWith('net ') || r.includes('[anti-punt]')) return 'net';
  return 'ranged/other';
}

class TimedEngine extends DecisionEngine {
  async decide(state: GameState): Promise<BotDecision> {
    const t0 = performance.now();
    const d = await super.decide(state);
    const ms = performance.now() - t0;
    if (state.isOurTurn && state.heroCards) samples.push({ ms, street: state.street, path: pathOf(d, state) });
    return d;
  }
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}

function row(label: string, xs: number[]): string {
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(2).padStart(7) : '      -');
  return `${label.padEnd(14)} n=${String(xs.length).padStart(5)}  p50 ${f(quantile(xs, 0.5))}  p95 ${f(quantile(xs, 0.95))}  p99 ${f(quantile(xs, 0.99))}  max ${f(xs.length ? Math.max(...xs) : NaN)} ms`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  const hands = parseInt(pos[0] ?? '300', 10);
  const seed = parseInt(pos[1] ?? '1', 10);
  const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const seats = parseInt(opt('seats', '6'), 10);
  const field = opt('field', DEFAULT_FIELD.join(',')).split(',');

  // BLUEPRINT: load the assets before the clock starts and report the load
  // separately, so the first decision does not carry it.
  if (ENGINE_FLAGS.BLUEPRINT) {
    const tl = performance.now();
    const web = await getWebBlueprint();
    realLog(`blueprint assets loaded in ${(performance.now() - tl).toFixed(0)} ms (loader ${lastLoadMs} ms): ${web.meta.abstraction.id}, iteration ${web.meta.iterations}`);
  }
  const bot = makeBotAgent('BOT', { engineClass: TimedEngine as unknown as EngineCtor });
  const opps: SeatAgent[] = [];
  for (let s = 1; s < seats; s++) {
    const kind = field[(s - 1) % field.length];
    opps.push(makeOpponent(kind, 0, 200, `F${s}_${kind}`));
  }
  const cfg: RingConfig = { bb: BB, sb: SB, startStackBB: START_BB, rng: () => 0 };
  console.log = () => {}; console.warn = () => {};
  const t0 = Date.now();
  for (let i = 0; i < hands; i++) {
    Math.random = makeRng(mixSeed(seed, i, 1));
    opps.forEach((o, k) => o.reseed?.(mixSeed(seed, i, 100 + k)));
    const deck = shuffledDeck(makeRng(mixSeed(seed, i)));
    await playRingHand([bot, ...opps], i % seats, cfg, i + 1, deck);
  }
  console.log = realLog; console.warn = realWarn;

  realLog(`=== decision latency: flags ${describeEngineFlags()}, ${hands} hands, ${seats} seats vs [${field.join(',')}], seed ${seed} (${((Date.now() - t0) / 1000).toFixed(0)}s wall) ===`);
  realLog(row('all', samples.map(s => s.ms)));
  for (const st of ['preflop', 'flop', 'turn', 'river']) realLog(row(st, samples.filter(s => s.street === st).map(s => s.ms)));
  const paths = [...new Set(samples.map(s => s.path))].sort();
  for (const p of paths) realLog(row(`path:${p}`, samples.filter(s => s.path === p).map(s => s.ms)));
}

main().catch(e => { console.error(e); process.exit(1); });
