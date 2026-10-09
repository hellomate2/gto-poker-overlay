// ============================================================
// Ring-game driver: the real bot at a 3-6 seat table vs scripted archetypes.
//
// Measures what the heads-up sim cannot: multiway pots, positions other than
// SB/BB, and hands where earlier players folded (the engine currently counts
// folded players as live villains). The bot sits in seat 0; the button rotates
// every hand so the bot plays every position equally often. Seeded.
//
// Usage:
//   npx tsx sim/ring-run.ts [hands] [seed] [--seats 6] [--field tag,lag,nit,station,tag]
//                           [--exploit] [--json]
//     --field   comma list of archetypes for seats 1..N-1 (cycled if shorter)
//     --exploit bot tracks opponents (profiler + exploit adjuster on)
//   npx tsx sim/ring-run.ts --selftest
//     chip conservation + pot distribution over random hands at every table
//     size 2..6 with uneven stacks (so side pots actually occur)
// ============================================================

import './fake-idb';
import { resetFakeIdb } from './fake-idb';
import { playRingHand, RingConfig, RingHandLog, SeatAgent, SeatView, ActResult, makeRng, mixSeed, ringPositions } from './ring';
import { makeBotAgent, makeOpponent, archetypeNames } from './agents';
import { PressureStats, emptyPressure, accumulatePressure, pressureLines, Running, bb100WithCI, pct, fmtPct } from './stats';
import { Position } from '../src/types/poker';

const BB = 20, SB = 10, START_BB = 100;
export const DEFAULT_FIELD = ['tag', 'lag', 'nit', 'station', 'tag'];

function seedGlobalRandom(seed: number): void { Math.random = makeRng(seed); }
const realLog = console.log.bind(console);
const silence = () => { console.log = () => {}; };
const unsilence = () => { console.log = realLog; };

export interface RingStats {
  hands: number;
  result: Running;                     // bot net per hand, in bb
  byPosition: Map<Position, Running>;
  vpip: number; pfr: number;
  sawFlop: number;
  multiwayFlops: number;               // bot saw a flop with 3+ players live
  hu: Running; mw: Running;            // bot net (bb) on hands it saw the flop HU / multiway
  wtsd: number; wonSD: number;
  pressure: PressureStats;
}

export function emptyRingStats(): RingStats {
  return {
    hands: 0, result: new Running(), byPosition: new Map(),
    vpip: 0, pfr: 0, sawFlop: 0, multiwayFlops: 0,
    hu: new Running(), mw: new Running(), wtsd: 0, wonSD: 0,
    pressure: emptyPressure(),
  };
}

/** Fold one hand into the stats for `hero`. */
export function accumulateRing(st: RingStats, log: RingHandLog, hero: number, bb: number): void {
  st.hands++;
  const netBb = log.nets[hero] / bb;
  st.result.push(netBb);
  const pos = ringPositions(log.nets.length, log.button)[hero];
  if (!st.byPosition.has(pos)) st.byPosition.set(pos, new Running());
  st.byPosition.get(pos)!.push(netBb);

  const pf = log.actions.filter(a => a.seat === hero && a.street === 'preflop');
  if (pf.some(a => (a.type === 'call' || a.type === 'raise') && a.voluntary)) st.vpip++;
  if (pf.some(a => a.type === 'raise')) st.pfr++;

  const heroFoldedPre = pf.some(a => a.type === 'fold');
  if (log.reachedStreet !== 'preflop' && !heroFoldedPre) {
    st.sawFlop++;
    // players live at the flop = seats that did not fold preflop
    const foldedPre = new Set(log.actions.filter(a => a.street === 'preflop' && a.type === 'fold').map(a => a.seat));
    const liveAtFlop = log.nets.length - foldedPre.size;
    if (liveAtFlop >= 3) { st.multiwayFlops++; st.mw.push(netBb); } else st.hu.push(netBb);
    if (log.wentToShowdown && log.showdownSeats.includes(hero)) {
      st.wtsd++;
      if (log.nets[hero] > 0) st.wonSD++;
    }
  }
  accumulatePressure(st.pressure, log.actions, hero);
}

export function renderRingStats(st: RingStats, label: string): string[] {
  const L: string[] = [];
  const all = bb100WithCI(st.result, 1);
  const sign = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(1);
  L.push(`${label}: ${sign(all.bb100)} bb/100 (±${all.ci95.toFixed(1)} @95%) over ${st.hands} hands`);
  const posOrder: Position[] = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
  const posParts: string[] = [];
  for (const p of posOrder) {
    const r = st.byPosition.get(p);
    if (r) { const x = bb100WithCI(r, 1); posParts.push(`${p} ${sign(x.bb100)}±${x.ci95.toFixed(0)}`); }
  }
  L.push(`  by position (bb/100): ${posParts.join('  ')}`);
  L.push(`  VPIP ${fmtPct(pct(st.vpip, st.hands))}  PFR ${fmtPct(pct(st.pfr, st.hands))}  saw flop ${fmtPct(pct(st.sawFlop, st.hands))}  multiway share of flops ${fmtPct(pct(st.multiwayFlops, st.sawFlop))}`);
  const hu = bb100WithCI(st.hu, 1), mw = bb100WithCI(st.mw, 1);
  L.push(`  net when seeing a flop: HU pots ${sign(hu.bb100)}±${hu.ci95.toFixed(0)} bb/100-of-those-hands (n=${st.hu.n}), multiway ${sign(mw.bb100)}±${mw.ci95.toFixed(0)} (n=${st.mw.n})`);
  L.push(`  WTSD ${fmtPct(pct(st.wtsd, st.sawFlop))}  W$SD ${fmtPct(pct(st.wonSD, st.wtsd))}`);
  const pl = pressureLines(st.pressure);
  L.push(`  ${Object.entries(pl).map(([k, v]) => `${k} ${v}`).join('  |  ')}`);
  return L;
}

/** Bot in seat 0 vs a scripted field, button rotating every hand. */
export async function runRing(opts: {
  hands: number; seed: number; seats: number; field: string[]; exploit: boolean; progress?: boolean;
}): Promise<RingStats> {
  const { hands, seed, seats, field, exploit } = opts;
  resetFakeIdb();
  const bot = makeBotAgent('BOT', { exploit });
  const agents: SeatAgent[] = [bot];
  for (let s = 1; s < seats; s++) {
    const kind = field[(s - 1) % field.length];
    agents.push(makeOpponent(kind, mixSeed(seed, 1000 + s), 200, `OPP${s}_${kind}`));
  }
  const cfg: RingConfig = { bb: BB, sb: SB, startStackBB: START_BB, rng: makeRng(mixSeed(seed, 31)) };
  const st = emptyRingStats();
  for (let h = 0; h < hands; h++) {
    const log = await playRingHand(agents, h % seats, cfg, h + 1);
    accumulateRing(st, log, 0, BB);
    if (exploit) await bot.observe?.(log.finalState);
    if (opts.progress && (h + 1) % 500 === 0) process.stderr.write(`[ring] ${h + 1}/${hands} hands\n`);
  }
  return st;
}

// ---- self-test -------------------------------------------------------------

/** A legal-random agent: folds, calls, min-raises, pot-raises and shoves. */
function randomAgent(name: string, rng: () => number): SeatAgent {
  return {
    name,
    act(v: SeatView): ActResult {
      const r = rng();
      if (r < 0.15) return { action: 'fold' };
      if (r < 0.55) return { action: v.canCheck ? 'check' : 'call' };
      if (r < 0.75) return { action: 'raise', toAmount: v.state.currentBet + v.bb };         // min-ish
      if (r < 0.92) return { action: 'raise', toAmount: v.state.currentBet + v.pot };        // pot
      return { action: 'allin' };
    },
  };
}

export async function ringSelftest(handsPerSize = 3000): Promise<{ hands: number; sidePotHands: number; showdowns: number }> {
  let hands = 0, sidePotHands = 0, showdowns = 0;
  for (let n = 2; n <= 6; n++) {
    const rng = makeRng(4242 + n);
    const agents = Array.from({ length: n }, (_, i) => randomAgent(`R${i}`, makeRng(97 * n + i)));
    for (let h = 0; h < handsPerSize; h++) {
      // uneven stacks 5bb..150bb so all-ins create side pots
      const seatStacks = agents.map(() => BB * (5 + Math.floor(rng() * 146)));
      const cfg: RingConfig = { bb: BB, sb: SB, startStackBB: START_BB, rng, seatStacks };
      const log = await playRingHand(agents, h % n, cfg, h + 1); // throws on any leak
      hands++;
      if (log.nets.reduce((a, b) => a + b, 0) !== 0) throw new Error('nets do not sum to zero');
      if (log.wentToShowdown) showdowns++;
      if (log.sidePot) sidePotHands++;
    }
  }
  return { hands, sidePotHands, showdowns };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--selftest') {
    const r = await ringSelftest();
    realLog(`ring selftest: ${r.hands} hands at table sizes 2..6 with uneven stacks, ${r.showdowns} showdowns, ` +
      `${r.sidePotHands} hands needed a side pot. ` +
      `Chip conservation and full pot distribution asserted every hand: PASS`);
    return;
  }
  const VALUE_FLAGS = new Set(['--seats', '--field']);
  const flag = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(args[i - 1])));
  const hands = parseInt(positional[0] || '3000', 10);
  const seed = parseInt(positional[1] || '42', 10);
  const seats = parseInt(flag('--seats') || '6', 10);
  const field = (flag('--field') || DEFAULT_FIELD.join(',')).split(',').filter(Boolean);
  for (const f of field) if (!archetypeNames().includes(f)) throw new Error(`unknown archetype ${f}`);
  const exploit = args.includes('--exploit');

  seedGlobalRandom(seed);
  realLog(`=== RING: bot (seat 0) vs ${field.join(',')} — ${seats} seats, ${hands} hands, ${START_BB}bb, blinds ${SB}/${BB}, seed ${seed}${exploit ? ', exploit ON' : ''} ===`);
  const t0 = Date.now();
  silence();
  const st = await runRing({ hands, seed, seats, field, exploit, progress: true });
  unsilence();
  const secs = (Date.now() - t0) / 1000;
  for (const l of renderRingStats(st, 'BOT')) realLog(l);
  realLog(`(${secs.toFixed(0)}s, ${(hands / secs).toFixed(1)} hands/s)`);
  if (args.includes('--json')) {
    realLog(JSON.stringify({ hands, seed, seats, field, bb100: bb100WithCI(st.result, 1), pressure: st.pressure }));
  }
}

if (require.main === module) {
  main().catch(e => { unsilence(); console.error(e); process.exit(1); });
}
