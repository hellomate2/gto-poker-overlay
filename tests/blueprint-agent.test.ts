// ============================================================
// BlueprintAgent bridge (src/core/blueprint/{translate,abstract-tree,agent}.ts,
// sim/blueprint-serve.ts).
//
// Oracles:
//   - the pseudo-harmonic formula's closed-form properties (f(A) = 1,
//     f(B) = 0, f(median) = 1/2, a hand-computed value) and its empirical
//     frequency under a seeded RNG;
//   - the C++ tree: node values below are copied from `bp serve` replies
//     (the whole-tree comparison is sim/blueprint-parity.ts tree);
//   - round trip: two BlueprintAgents play each other in the real simulator
//     at tree-chip scale (SB 50, BB 100, 100 BB). Every real action is then
//     exactly an abstract action, so the history each agent reconstructs
//     must equal the tokens both agents actually chose, with zero
//     off-tree translations and zero fallbacks;
//   - legality: every action the agent returns over 2,000 hands against
//     scripted opponents and a random-size bettor passes the strict
//     validator (sim/ring.ts validateAction).
// A PolicySource stub plays uniformly over the legal abstract actions so
// every branch of the tree gets exercised; the real policy is checked
// against the trainer by sim/blueprint-parity.ts policy.
// ============================================================

import { describe, it, expect } from 'vitest';
import '../sim/fake-idb';
import { pseudoHarmonicProbA, pseudoHarmonicMedian, translateSize } from '../src/core/blueprint/translate';
import {
  holdemRules, parseTreeDescription, rootState, legalActions, walkTokens, potFraction, TreeRules,
} from '../src/core/blueprint/abstract-tree';
import { BlueprintAgent, PolicySource, PolicyAnswer, COMMITTED } from '../src/core/blueprint/agent';
import { decisionToAct } from '../sim/blueprint-serve';
import { playRingHand, SeatAgent, SeatView, ActResult, makeRng, mixSeed, shuffledDeck, validateAction, RingConfig } from '../sim/ring';
import { makeOpponent } from '../sim/agents';
import { Card } from '../src/types/poker';

// Tree description printed by `bp serve` "info" for --preset small.
const SMALL_DESC =
  'name=holdem-small;streets=4;stack=10000;blind=50,100;min_bet=100;' +
  's0:first=0,max_raises=3,bet=0.5/1,raise=0.5/1,allin=1,capped_allin=1;' +
  's1:first=1,max_raises=2,bet=0.5/1,raise=1,allin=1,capped_allin=1;' +
  's2:first=1,max_raises=2,bet=0.5/1,raise=1,allin=1,capped_allin=1;' +
  's3:first=1,max_raises=2,bet=0.5/1,raise=1,allin=1,capped_allin=1';

describe('pseudo-harmonic translation (Ganzfried and Sandholm 2013)', () => {
  it('matches the closed form at the endpoints, the median and a hand-computed point', () => {
    expect(pseudoHarmonicProbA(0.5, 1, 0.5)).toBe(1);
    expect(pseudoHarmonicProbA(0.5, 1, 1)).toBe(0);
    // ((1 - 0.75)(1 + 0.5)) / ((1 - 0.5)(1 + 0.75)) = 0.375 / 0.875 = 3/7
    expect(pseudoHarmonicProbA(0.5, 1, 0.75)).toBeCloseTo(3 / 7, 12);
    for (const [A, B] of [[0.5, 1], [0.33, 0.66], [1, 2], [0.25, 50], [0, 1]]) {
      const m = pseudoHarmonicMedian(A, B);
      expect(m).toBeGreaterThan(A);
      expect(m).toBeLessThan(B);
      expect(pseudoHarmonicProbA(A, B, m)).toBeCloseTo(0.5, 12);
    }
    // A = 0 (check) and B = 1 (pot): median is 1/3, the classic pseudo-harmonic value.
    expect(pseudoHarmonicMedian(0, 1)).toBeCloseTo(1 / 3, 12);
  });

  it('is strictly decreasing in x between A and B', () => {
    let prev = 1;
    for (let x = 0.51; x < 1; x += 0.01) {
      const f = pseudoHarmonicProbA(0.5, 1, x);
      expect(f).toBeLessThan(prev);
      prev = f;
    }
  });

  it('translateSize clamps outside the range, hits exact sizes, and samples at f(x)', () => {
    const sizes = [1, 0.5, 49];  // unsorted on purpose
    const never = () => { throw new Error('rng must not be used'); };
    expect(translateSize(sizes, 0.2, never)).toBe(1);   // below the smallest -> 0.5
    expect(translateSize(sizes, 80, never)).toBe(2);    // above the largest -> 49
    expect(translateSize(sizes, 1, never)).toBe(0);
    expect(translateSize(sizes, 0.5, never)).toBe(1);
    const rng = makeRng(12345);
    let lower = 0;
    const N = 40000;
    for (let i = 0; i < N; i++) if (translateSize(sizes, 0.75, rng) === 1) lower++;
    // Binomial sd at p = 3/7, N = 40,000 is 0.0025; allow 4 sd.
    expect(Math.abs(lower / N - 3 / 7)).toBeLessThan(0.01);
    // Deterministic median rule.
    const m = pseudoHarmonicMedian(0.5, 1);
    expect(translateSize(sizes, m - 1e-9, never, true)).toBe(1);
    expect(translateSize(sizes, m + 1e-9, never, true)).toBe(0);
  });
});

describe('TS port of the C++ abstract tree', () => {
  it('parses the served tree description into the small preset', () => {
    const r = parseTreeDescription(SMALL_DESC);
    expect(r).toEqual(holdemRules('small'));
  });

  it('reproduces known C++ nodes', () => {
    const r = holdemRules('small');
    // Root (bp serve node ''): f c r0.5 r1 a with contribs 50/100, 100/100, 200/100, 300/100, 10000/100.
    const root = legalActions(r, rootState(r));
    expect(root.map(a => a.tok)).toEqual(['f', 'c', 'r0.5', 'r1', 'a']);
    expect(root.map(a => a.to)).toEqual([50, 100, 200, 300, 10000]);
    // bp serve node 'r0.5 c': BB first on the flop, pot 400: k b0.5 b1 a (to 200, 400, 600, 10000).
    const flop = walkTokens(r, ['r0.5', 'c'])!;
    expect(flop.street).toBe(1);
    expect(flop.player).toBe(1);
    const fl = legalActions(r, flop);
    expect(fl.map(a => a.tok)).toEqual(['k', 'b0.5', 'b1', 'a']);
    expect(fl.map(a => a.to)).toEqual([200, 400, 600, 10000]);
    // Pot fractions as the tree defines them.
    expect(potFraction(flop.c, 1, 400)).toBeCloseTo(0.5, 12);
    expect(potFraction([50, 100], 0, 200)).toBeCloseTo(0.5, 12);   // (200 - 100) / (150 + 50)
    expect(potFraction([50, 100], 0, 300)).toBeCloseTo(1, 12);
    // Capped node keeps the all-in (M0 change): three preflop raises then f c a.
    const capped = walkTokens(r, ['r0.5', 'r0.5', 'r0.5'])!;
    expect(legalActions(r, capped).map(a => a.tok)).toEqual(['f', 'c', 'a']);
    expect(walkTokens(r, ['r0.7'])).toBeNull();
  });
});

/** Uniform policy over the legal abstract actions; records every query. */
class UniformSource implements PolicySource {
  queries: string[][] = [];
  constructor(private rules: TreeRules) {}
  async policy(history: readonly string[], _hole: readonly [Card, Card], board: readonly Card[]): Promise<PolicyAnswer> {
    const s = walkTokens(this.rules, history);
    if (!s || s.type !== 'decision') throw new Error(`stub: history not at a decision: ${history.join(' ')}`);
    const need = [0, 3, 4, 5][s.street];
    if (board.length !== need) throw new Error(`stub: board ${board.length} cards on street ${s.street}`);
    this.queries.push([...history]);
    const toks = legalActions(this.rules, s).map(a => a.tok);
    return { toks, probs: toks.map(() => 1 / toks.length) };
  }
}

interface Probe { agent: BlueprintAgent; seat: SeatAgent; illegal: string[] }

function bpSeat(name: string, rules: TreeRules, seed: number, played?: string[], mismatches?: string[]): Probe {
  const rng = makeRng(seed);
  const agent = new BlueprintAgent({ rules, source: new UniformSource(rules), rng });
  const illegal: string[] = [];
  const seat: SeatAgent = {
    name,
    async act(view: SeatView): Promise<ActResult> {
      const d = await agent.decide(view.state);
      if (played && mismatches && d.history && d.history.join(' ') !== played.join(' ')) {
        mismatches.push(`saw '${d.history.join(' ')}' but played '${played.join(' ')}'`);
      }
      if (played && d.token) played.push(d.token);
      const act = decisionToAct(d, view);
      const v = validateAction(view, { action: act.action, amount: act.toAmount });
      if (!v.ok) illegal.push(`${v.error} (${JSON.stringify(act)})`);
      return act;
    },
  };
  return { agent, seat, illegal };
}

describe('BlueprintAgent round trip at tree-chip scale', () => {
  it('reconstructs exactly the abstract history both agents played, over 1,500 hands', async () => {
    const rules = holdemRules('small');
    const played: string[] = [];
    const mismatches: string[] = [];
    const a = bpSeat('A', rules, 1, played, mismatches), b = bpSeat('B', rules, 2, played, mismatches);
    const cfg: RingConfig = { bb: 100, sb: 50, startStackBB: 100, rng: () => 0 };
    let decisions = 0, streetsSeen = new Set<string>();
    for (let h = 0; h < 1500; h++) {
      played.length = 0;
      const deck = shuffledDeck(makeRng(mixSeed(77, h)));
      const log = await playRingHand([a.seat, b.seat], h % 2, cfg, h + 1, deck);
      decisions += log.actions.length;
      streetsSeen.add(log.reachedStreet);
      // The real action sequence must be the abstract one: same length.
      expect(log.actions.length).toBe(played.length);
    }
    expect(mismatches).toEqual([]);
    for (const p of [a, b]) {
      expect(p.agent.stats.fallbacks).toBe(0);
      expect(p.agent.stats.offTreeTranslations).toBe(0);
      expect(p.illegal).toEqual([]);
    }
    expect(a.agent.stats.translations + b.agent.stats.translations).toBeGreaterThan(500);
    expect(decisions).toBeGreaterThan(4000);
    expect(streetsSeen.has('river')).toBe(true);
  });
});

/** Bets or raises a uniformly random legal amount half the time it can. */
function randomSizer(seed: number): SeatAgent {
  const rng = makeRng(seed);
  return {
    name: 'RND',
    act(v: SeatView): ActResult {
      const r = rng();
      if (v.canRaise && v.maxTo > v.state.currentBet && r < 0.5) {
        const lo = Math.min(v.minTo, v.maxTo);
        return { action: 'raise', toAmount: lo + Math.floor(rng() * (v.maxTo - lo + 1)) };
      }
      if (r < 0.65 && !v.canCheck) return { action: 'fold' };
      return { action: v.canCheck ? 'check' : 'call' };
    },
  };
}

describe('BlueprintAgent legality', () => {
  it('returns only legal actions over 2,000 hands at 10/20 blinds against varied opponents', async () => {
    const rules = holdemRules('small');
    const p = bpSeat('BP', rules, 3);
    const kinds = ['lag', 'maniac', 'raiser', 'station', 'checkraiser', 'barreler'];
    const opps: SeatAgent[] = [randomSizer(9), ...kinds.map((k, i) => makeOpponent(k, 100 + i, 50, `O_${k}`))];
    const cfg: RingConfig = { bb: 20, sb: 10, startStackBB: 100, rng: () => 0 };
    const reached = new Set<string>();
    for (let h = 0; h < 2000; h++) {
      const opp = opps[h % opps.length];
      const deck = shuffledDeck(makeRng(mixSeed(5, h)));
      const seats: SeatAgent[] = h % 2 ? [p.seat, opp] : [opp, p.seat];
      const log = await playRingHand(seats, (h >> 1) % 2, cfg, h + 1, deck);
      reached.add(log.reachedStreet);
    }
    expect(p.illegal).toEqual([]);
    expect(p.agent.stats.decisions).toBeGreaterThan(3000);
    expect(p.agent.stats.offTreeTranslations).toBeGreaterThan(100);
    // The only fallback allowed is the committed line (an off-tree raise
    // translated to the abstract all-in and called); it plays check/call.
    expect(Object.keys(p.agent.stats.fallbackReasons).filter(k => k !== COMMITTED)).toEqual([]);
    expect(reached.has('river')).toBe(true);
  }, 120_000);
});
