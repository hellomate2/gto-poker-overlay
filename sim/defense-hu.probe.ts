import './fake-idb';
import { it } from 'vitest';
import { resetFakeIdb } from './fake-idb';
import { playHand, HUConfig, makeRng, SeatAgent, SeatView, ActResult, Seat } from './holdem';
import { makeOpponent } from './agents';
import { DecisionEngine } from '../src/core/engine';
import { installDefense } from './defense-shim';

// ============================================================
// HU A/B: the real bot with and without src/core/defense.ts wired in (via
// sim/defense-shim.ts), vs scripted archetypes, SAME deck sequence and SAME
// global Math.random seed for both arms (paired comparison). Reports bb/100 with
// a 95% half-width per arm and the paired difference, plus how often the bot
// folded when it bet and got raised.
//
//   PROBE_HANDS=2000 PROBE_OPPS=maniac,lag,tag npx vitest run --config sim/vitest.probe.config.ts sim/defense-hu
// ============================================================

const BB = 20, SB = 10, START_BB = 100;
const HANDS = Number(process.env.PROBE_HANDS || 1000);
const OPPS = (process.env.PROBE_OPPS || 'maniac,lag,tag').split(',');

function seedGlobalRandom(seed: number): void {
  let s = seed >>> 0;
  Math.random = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Same as sim/agents.ts makeBotAgent (exploit:false), optionally with defense installed. */
function botAgent(defense: boolean, counters: { betRaised: number; foldedToRaise: number }): SeatAgent {
  const engine = new DecisionEngine();
  (engine as unknown as { tracker: { loadStats: () => Promise<void> } }).tracker.loadStats = async () => {};
  if (defense) installDefense(engine);
  return {
    name: 'BOT',
    async act(view: SeatView): Promise<ActResult> {
      const st = view.state;
      const heroBet = st.players[st.heroIndex]?.currentBet || 0;
      const raisedAfterOurBet = st.street !== 'preflop' && heroBet > 0 && st.currentBet > heroBet;
      const d = await engine.decide(st);
      if (raisedAfterOurBet) { counters.betRaised++; if (d.action === 'fold') counters.foldedToRaise++; }
      switch (d.action) {
        case 'fold': return { action: 'fold' };
        case 'check': return { action: 'check' };
        case 'call': return { action: 'call' };
        case 'allin': return { action: 'allin' };
        case 'bet': case 'raise': return { action: d.action, toAmount: d.amount };
        default: return { action: view.canCheck ? 'check' : 'fold' };
      }
    },
  };
}

async function arm(opp: string, defense: boolean, seed: number) {
  resetFakeIdb();
  seedGlobalRandom(seed);
  const cfg: HUConfig = { bb: BB, sb: SB, startStackBB: START_BB, rng: makeRng(seed) };
  const counters = { betRaised: 0, foldedToRaise: 0 };
  const bot = botAgent(defense, counters);
  const villain = makeOpponent(opp, seed + 1);
  const perHand: number[] = [];
  for (let h = 0; h < HANDS; h++) {
    const log = await playHand([bot, villain], (h % 2) as Seat, cfg, h + 1);
    perHand.push(log.net0 / BB);
  }
  return { perHand, ...counters };
}

function stats(xs: number[]) {
  const n = xs.length, mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { bb100: mean * 100, hw: 1.96 * sd / Math.sqrt(n) * 100 };
}

it('probe: HU A/B with and without defense.ts', async () => {
  const out = (s: string) => process.stdout.write(s + '\n');
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  const t0 = Date.now();
  const rows: string[] = [];
  try {
    for (const opp of OPPS) {
      const base = await arm(opp, false, 42);
      const def = await arm(opp, true, 42);
      const a = stats(base.perHand), b = stats(def.perHand);
      const d = stats(def.perHand.map((x, i) => x - base.perHand[i]));
      rows.push(`${opp}\tbase ${a.bb100.toFixed(1)} +/- ${a.hw.toFixed(1)}\tdefense ${b.bb100.toFixed(1)} +/- ${b.hw.toFixed(1)}\tdiff ${d.bb100.toFixed(1)} +/- ${d.hw.toFixed(1)}\t` +
        `fold-after-bet-raised base ${base.foldedToRaise}/${base.betRaised} defense ${def.foldedToRaise}/${def.betRaised}`);
    }
  } finally { console.log = log; console.warn = warn; }
  out(`opponent\tbb/100 baseline\tbb/100 with defense\tpaired diff (bb/100)\tfold when bet and raised`);
  for (const r of rows) out(r);
  out(`probe: ${HANDS} hands per arm, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}, 7_200_000);
