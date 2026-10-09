// ============================================================
// Print a few hands of BlueprintAgent vs DecisionEngine with the agent's view
// of every decision: real action history, abstract history, sampled token,
// and the real action sent. For eyeballing the state mapping.
//
//   GPO_BP_FLAGS="..." npx tsx sim/blueprint-trace.ts --ckpt C [--hands 4] [--seed 3]
// ============================================================
import './fake-idb';
import { resolve } from 'path';
import { playRingHand, SeatAgent, SeatView, makeRng, mixSeed, shuffledDeck } from './ring';
import { makeBotAgent } from './agents';
import { makeBlueprintSeatAgent, decisionToAct } from './blueprint-serve';

function arg(n: string, d?: string) { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; }

async function main() {
  const repo = resolve(__dirname, '..');
  const seat = await makeBlueprintSeatAgent(`blueprint:${arg('ckpt')}`, 'BP', repo);
  const engine = makeBotAgent('ENG');
  const out: string[] = [];
  const traced: SeatAgent = {
    name: 'BP',
    async act(v: SeatView) {
      const d = await seat.agent.decide(v.state);
      const act = decisionToAct(d, v);
      const real = (['preflop', 'flop', 'turn', 'river'] as const)
        .map(s => v.state.actionHistory[s].map(a => `${a.type[0]}${a.amount ?? ''}`).join(',')).filter(Boolean).join(' / ');
      const pr = d.toks ? d.toks.map((t, i) => `${t}=${d.probs![i].toFixed(2)}`).join(' ') : '';
      out.push(`  ${v.street.padEnd(7)} real[${real}] abs[${(d.history ?? []).join(' ')}] {${pr}} -> ${d.token ?? d.fallback} => ${act.action}${act.toAmount !== undefined ? ' ' + act.toAmount : ''}`);
      return act;
    },
  };
  const log0 = console.log; console.log = () => {};
  const hands = Number(arg('hands', '4')), seed = Number(arg('seed', '3'));
  for (let h = 0; h < hands; h++) {
    Math.random = makeRng(mixSeed(seed, h, 1));
    const deck = shuffledDeck(makeRng(mixSeed(seed, h)));
    const bpSeat = h % 2;
    const seats = bpSeat === 0 ? [traced, engine] : [engine, traced];
    out.push(`hand ${h} (BP is ${bpSeat === 0 ? 'SB/button' : 'BB'})`);
    const r = await playRingHand(seats, 0, { bb: 20, sb: 10, startStackBB: 100, rng: () => 0 }, h + 1, deck);
    const acts = r.actions.map(a => `${a.seat === bpSeat ? 'BP' : 'EN'}:${a.street[0]}:${a.type}${a.amount ?? ''}`).join(' ');
    out.push(`  actions ${acts}`);
    out.push(`  BP net ${r.nets[bpSeat]} chips`);
  }
  console.log = log0;
  console.log(out.join('\n'));
  console.log(JSON.stringify(seat.agent.stats));
  seat.close();
}
main().catch(e => { console.error(e); process.exit(1); });
