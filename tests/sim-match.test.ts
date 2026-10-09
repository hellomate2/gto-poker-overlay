// ============================================================
// Duplicate match runner (sim/match.ts) and the exploit-probe archetypes.
//
// The match runner is the yardstick every engine change is judged by, so its
// invariants are pinned here:
//   - identical engines produce EXACTLY zero (duplicate cancels everything),
//   - a known matchup produces its exact analytic value,
//   - splitting deals across shards changes nothing,
//   - engines load from a source directory.
// ============================================================

import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import '../sim/fake-idb';
import { runMatchShard, summarize, loadEngine, MatchOptions } from '../sim/match';
import { EngineCtor, makeOpponent } from '../sim/agents';
import { playRingHand, SeatAgent, SeatView, makeRng, RingConfig } from '../sim/ring';
import { DecisionEngine } from '../src/core/engine';
import { BotDecision, GameState } from '../src/types/poker';

const quiet = <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  return fn().finally(() => { console.log = log; console.warn = warn; });
};

const decision = (action: BotDecision['action']): BotDecision => ({
  action, confidence: 1, reasoning: 'test', mixedStrategy: { fold: 0, check: 0, call: 0, bets: [] },
});
class JamEngine { async decide(_s: GameState) { return decision('allin'); } }
class FoldEngine {
  async decide(s: GameState) {
    const hero = s.players[s.heroIndex];
    return decision(s.currentBet > (hero.currentBet || 0) ? 'fold' : 'check');
  }
}

describe('duplicate match runner', () => {
  it('jam vs fold heads-up is exactly +75 bb/100 with zero variance', async () => {
    const opts: MatchOptions = { mode: 'hu', deals: 20, seed: 1, seats: 2, field: [] };
    const r = await runMatchShard(JamEngine as unknown as EngineCtor, FoldEngine as unknown as EngineCtor, opts);
    const s = summarize('hu', r.deals, r.pressureA, r.pressureB);
    // Per deal the jammer is SB once (steals the BB: +20) and BB once (SB folds: +10)
    // = 30 chips over 2 hands = 0.75 bb/hand.
    expect(s.diff.bb100).toBeCloseTo(75, 9);
    expect(s.diff.ci95).toBe(0);
    expect(s.hands).toBe(40);
  });

  it('the real engine against itself scores exactly zero in hu and field mode', async () => {
    const E = DecisionEngine as unknown as EngineCtor;
    const hu = await quiet(() => runMatchShard(E, E, { mode: 'hu', deals: 4, seed: 7, seats: 2, field: [] }));
    expect(hu.deals.map(d => d.a)).toEqual([0, 0, 0, 0]);
    const field = await quiet(() => runMatchShard(E, E, { mode: 'field', deals: 3, seed: 7, seats: 3, field: ['tag', 'station'] }));
    for (const d of field.deals) expect(d.a).toBe(d.b);
    expect(field.pressureA).toEqual(field.pressureB);
  }, 60_000);

  it('sharding the deals gives the same per-deal results as one process', async () => {
    const E = DecisionEngine as unknown as EngineCtor;
    const opts: MatchOptions = { mode: 'field', deals: 6, seed: 11, seats: 3, field: ['lag', 'nit'] };
    const whole = await quiet(() => runMatchShard(E, JamEngine as unknown as EngineCtor, opts));
    const s0 = await quiet(() => runMatchShard(E, JamEngine as unknown as EngineCtor, opts, 0, 2));
    const s1 = await quiet(() => runMatchShard(E, JamEngine as unknown as EngineCtor, opts, 1, 2));
    const merged = [...s0.deals, ...s1.deals].sort((x, y) => x.i - y.i);
    expect(merged).toEqual(whole.deals);
  }, 60_000);

  it('--stacks: seat 0 starts every deal at its own depth (a 10bb jammer never loses more than 10bb)', async () => {
    const Jam = JamEngine as unknown as EngineCtor, Fold = FoldEngine as unknown as EngineCtor;
    const opts: MatchOptions = { mode: 'field', deals: 30, seed: 3, seats: 3, field: ['station', 'lag'], stacksBB: [10, 100, 100] };
    const r = await quiet(() => runMatchShard(Jam, Fold, opts));
    const losses = r.deals.map(d => d.a);
    expect(Math.min(...losses)).toBeGreaterThanOrEqual(-200);  // 10bb at bb = 20
    expect(Math.min(...losses)).toBeLessThan(-100);            // and it does get called and lose
    await expect(runMatchShard(Jam, Fold, { ...opts, stacksBB: [10, 100] })).rejects.toThrow(/--stacks needs 3/);
  });

  it('a scripted opponent at 15bb or less shoves instead of raising preflop', () => {
    const opp = makeOpponent('lag', 1, 50, 'L');
    const view = (stackBB: number, hole: [string, string]): SeatView => ({
      state: { actionHistory: { preflop: [], flop: [], turn: [], river: [] }, currentBet: 20 } as unknown as GameState,
      toCall: 20, canCheck: false, canRaise: true, pot: 30, street: 'preflop',
      hole: hole.map(c => ({ rank: c[0], suit: c[1] })) as SeatView['hole'], board: [],
      heroStack: stackBB * 20, bb: 20, seat: 3, numPlayers: 6, liveSeats: 6, minTo: 40, maxTo: stackBB * 20,
    });
    expect(opp.act(view(12, ['Ah', 'Ad']))).toEqual({ action: 'allin' });
    expect((opp.act(view(100, ['Ah', 'Ad'])) as { action: string }).action).toBe('raise');
  });

  it('loads DecisionEngine from a source directory and rejects a missing one', async () => {
    const Ctor = await loadEngine(resolve(__dirname, '..'));
    expect(typeof Ctor).toBe('function');
    await expect(loadEngine('/nonexistent/dir')).rejects.toThrow(/no engine/);
  });
});

// ---- exploit-probe archetypes ----------------------------------------------

/** Counterpart that bets 1/2 pot whenever it can open postflop, else calls. */
const bettor = (name: string): SeatAgent => ({
  name,
  act: (v: SeatView) => {
    if (v.street !== 'preflop' && v.canCheck) return { action: 'bet', toAmount: Math.round(v.pot / 2) };
    return { action: v.canCheck ? 'check' : 'call' };
  },
});
/** Counterpart that never bets: checks or calls. */
const passive = (name: string): SeatAgent => ({ name, act: (v: SeatView) => ({ action: v.canCheck ? 'check' : 'call' }) });

async function probe(kind: string, other: SeatAgent, hands: number) {
  const opp = makeOpponent(kind, 5, 100, 'PROBE');
  const cfg: RingConfig = { bb: 20, sb: 10, startStackBB: 100, rng: makeRng(17) };
  const logs = [];
  for (let h = 0; h < hands; h++) logs.push(await playRingHand([opp, other], h % 2, cfg, h + 1));
  return logs;
}

describe('exploit-probe archetypes', () => {
  it('raiser raises most postflop bets it faces', async () => {
    let faced = 0, raised = 0;
    for (const log of await probe('raiser', bettor('X'), 300)) {
      for (const st of ['flop', 'turn', 'river'] as const) {
        const acts = log.actions.filter(a => a.street === st);
        const bet = acts.find(a => a.seat === 1 && a.type === 'bet');
        if (!bet) continue;
        const resp = acts.find(a => a.seat === 0 && a.order > bet.order);
        if (!resp) continue;
        faced++;
        if (resp.type === 'raise') raised++;
      }
    }
    expect(faced).toBeGreaterThan(50);
    expect(raised / faced).toBeGreaterThan(0.65);
  });

  it('barreler bets every time it can open the betting postflop', async () => {
    let opens = 0, bets = 0;
    for (const log of await probe('barreler', passive('X'), 200)) {
      for (const st of ['flop', 'turn', 'river'] as const) {
        const acts = log.actions.filter(a => a.street === st);
        const first = acts.find(a => a.seat === 0);
        const wagerBefore = first && acts.some(a => a.order < first.order && (a.type === 'bet' || a.type === 'raise'));
        if (!first || wagerBefore) continue;
        opens++;
        if (first.type === 'bet') bets++;
      }
    }
    expect(opens).toBeGreaterThan(50);
    expect(bets).toBe(opens);
  });

  it('checkraiser checks when first to act and check-raises bets often', async () => {
    let firstToAct = 0, checks = 0, faced = 0, raised = 0;
    for (const log of await probe('checkraiser', bettor('X'), 300)) {
      for (const st of ['flop', 'turn', 'river'] as const) {
        const acts = log.actions.filter(a => a.street === st);
        if (acts.length === 0) continue;
        if (acts[0].seat === 0) {
          firstToAct++;
          if (acts[0].type === 'check') checks++;
          const bet = acts.find(a => a.seat === 1 && a.type === 'bet');
          const resp = bet && acts.find(a => a.seat === 0 && a.order > bet.order);
          if (resp) { faced++; if (resp.type === 'raise') raised++; }
        }
      }
    }
    expect(firstToAct).toBeGreaterThan(50);
    expect(checks).toBe(firstToAct);
    expect(raised / faced).toBeGreaterThan(0.5);
  });

  it('scripted opponents are reproducible after reseed regardless of global Math.random', () => {
    const a = makeOpponent('lag', 1);
    const view = {
      state: { currentBet: 0, actionHistory: { preflop: [], flop: [], turn: [], river: [] } },
      toCall: 0, canCheck: true, canRaise: true, pot: 100, street: 'flop',
      hole: [{ rank: '7', suit: 'h' }, { rank: '2', suit: 'c' }],
      board: [{ rank: 'K', suit: 's' }, { rank: '9', suit: 'd' }, { rank: '4', suit: 'c' }],
      heroStack: 1000, bb: 20, seat: 0, numPlayers: 2, liveSeats: 2,
    } as unknown as SeatView;
    const run = () => { a.reseed!(99); return Array.from({ length: 20 }, () => (a.act(view) as { action: string }).action).join(','); };
    const first = run();
    Math.random = makeRng(12345);
    expect(run()).toBe(first);
  });
});
