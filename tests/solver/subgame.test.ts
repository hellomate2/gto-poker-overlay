import { describe, it, expect } from 'vitest';
import { solveSubgame, subgameEligibility, pickSubgameAction } from '../../src/core/solver/subgame';
import {
  RangeVsRangeCfr,
  RangeHand,
  buildSubgameTree,
  countTree,
  defaultAbstraction,
  showdownMatrix,
} from '../../src/core/solver/postflop-cfr';
import { CardId } from '../../src/types/poker';
import { cid, ids } from '../helpers';
import { rangeOf, aggressionMass } from './range-spec';

// ============================================================
// Real-time subgame solver (src/core/solver/subgame.ts) and the range-vs-range
// DCFR core it runs on (src/core/solver/postflop-cfr.ts).
// ============================================================

const hand = (a: string, b: string): [CardId, CardId] => [cid(a), cid(b)];

// ------------------------------------------------------------
// (1) The classic river toy game
// ------------------------------------------------------------
//
// Bettor (hero, in position, checked to) holds a POLAR range: a fraction v of
// nut hands and 1 - v of air. Caller (villain) holds only bluff-catchers, which
// beat air and lose to the nuts. One bet size B = s * P (P = pot), all-in, so
// the caller can only fold or call.
//
// Caller indifference (sets the bettor's bluffing frequency). Let the bettor's
// betting range contain value mass V and bluff mass b. Calling wins P + B when
// facing a bluff and loses B when facing value; folding is worth 0. Indifference:
//     b * (P + B) = V * B   =>   b / V = B / (P + B) = s / (1 + s)
// so the bluff:value RATIO is s/(1+s), and the bluff SHARE of the betting range
// is alpha = b / (V + b) = s / (1 + 2s), which equals the pot odds the caller is
// laid, B / (P + 2B). (s = 1: one bluff per two value bets, alpha = 1/3.)
//
// Bettor indifference (sets the calling frequency). A bluff wins P when the
// caller folds and loses B when called; checking air is worth 0. Indifference:
//     (1 - c) * P = c * B   =>   c = P / (P + B) = 1 / (1 + s)
// which is the minimum defence frequency. Value always bets (it can only gain).
//
// With value mass v and air mass 1 - v, air must bluff with probability
//     q = v * (s / (1 + s)) / (1 - v)
// (as long as that is <= 1).
//
// Board Kd Qs 8c 5h 2c (no flush, no straight possible with these holdings).
// Hero value: 88 (3 combos, sets). Hero air: 76 (16 combos, seven-high).
// Villain: 33 (6 combos, a pair of threes). The three card sets are disjoint,
// so there are no blocker effects and the textbook numbers apply exactly.

function toyGame(s: number) {
  const board = ids('Kd', 'Qs', '8c', '5h', '2c');
  const hero: RangeHand[] = [];
  for (const c of [hand('8d', '8h'), hand('8d', '8s'), hand('8h', '8s')]) hero.push({ cards: c, weight: 1 });
  const S = ['h', 'd', 'c', 's'];
  // Value mass 3 (three combos of weight 1); air mass 7 spread over 16 combos.
  for (const a of S) for (const b of S) hero.push({ cards: hand('7' + a, '6' + b), weight: 7 / 16 });
  const villain: RangeHand[] = [];
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) villain.push({ cards: hand('3' + S[i], '3' + S[j]), weight: 1 });
  const solver = new RangeVsRangeCfr({
    board,
    hero,
    villain,
    tree: {
      startingPot: 100,
      effectiveStack: 100 * s, // the single bet size is exactly all-in
      toCall: 0,
      heroIsIP: true,
      priorAggressions: 0,
      abstraction: { betFractions: [s], raiseFractions: [], maxAggressions: 1, allInMaxSpr: 0, allInThreshold: 0.8 },
    },
  });
  return { solver, hero, board };
}

describe('subgame CFR: river toy game converges to the textbook equilibrium', () => {
  for (const s of [0.5, 1, 2]) {
    it(`bet size ${s} pot: air bluffs at v*(s/(1+s))/(1-v), caller calls 1/(1+s)`, () => {
      const { solver, hero } = toyGame(s);
      for (let t = 0; t < 1500; t++) solver.iterate();
      const root = solver.root;
      expect(root.actions.map((a) => a.label)).toEqual(['X', 'A']);
      const avg = solver.averageStrategy(root);
      const H = hero.length;
      // Value (indices 0..2) always bets.
      for (let i = 0; i < 3; i++) expect(avg[1 * H + i]).toBeGreaterThan(0.99);
      // Air bluff frequency, weighted over the air combos.
      let bluff = 0;
      let airW = 0;
      for (let i = 3; i < H; i++) {
        bluff += avg[1 * H + i] * hero[i].weight;
        airW += hero[i].weight;
      }
      const v = 0.3;
      const expectedQ = (v * (s / (1 + s))) / (1 - v);
      expect(bluff / airW).toBeCloseTo(expectedQ, 2);
      // Equivalent statement: bluffs are s/(1+2s) of the betting range.
      const bluffShare = (bluff) / (bluff + 3);
      expect(bluffShare).toBeCloseTo(s / (1 + 2 * s), 2);
      // Caller's range-wide calling frequency equals 1/(1+s).
      const facing = solver.nodeAt(['A']);
      expect(facing.actions.map((a) => a.label)).toEqual(['F', 'C']);
      const [, callFreq] = solver.rangeFrequencies(facing);
      expect(callFreq).toBeCloseTo(1 / (1 + s), 2);
      // And the solution is essentially unexploitable.
      expect(solver.exploitability()).toBeLessThan(0.001 * 100);
    });
  }

  it('solveSubgame reports the same mix for one air combo and the size it uses', () => {
    // Through the public API: hero holds 7h6d, the WeightedRange carries the
    // same polar range. One size, all-in, pot = stack = 100 (s = 1).
    const board = ids('Kd', 'Qs', '8c', '5h', '2c');
    const r = solveSubgame({
      heroCards: hand('7h', '6d'),
      board,
      heroRange: rangeOf(['8d8h:16', '8d8s:16', '8h8s:16', '76:7'], board),
      villainRange: rangeOf(['33'], board),
      pot: 100,
      toCall: 0,
      effectiveStack: 100,
      heroIsIP: true,
      abstraction: { betFractions: [1], raiseFractions: [], maxAggressions: 1, allInMaxSpr: 0 },
      targetExploitabilityPct: 0.05,
      budgetMs: 5000,
    });
    expect(r.street).toBe('river');
    expect(r.sizes).toEqual([100]);
    // 3 value combos of weight 16 vs 16 air combos of weight 7: v = 48/160 = 0.3.
    // Individual air combos are interchangeable, so one combo's mix need not
    // equal the range average; check it is a genuine mix and the range average.
    expect(r.strategy.A).toBeGreaterThan(0);
    expect(r.strategy.A).toBeLessThan(1);
    const a = r.actions.find((x) => x.label === 'A')!;
    const valueShare = 0.3;
    // rangeFrequency of the bet = value share * 1 + air share * q = 0.3 + 0.7 q
    const q = (valueShare * 0.5) / (1 - valueShare);
    expect(a.rangeFrequency).toBeCloseTo(valueShare + (1 - valueShare) * q, 2);
    expect(r.converged).toBe(true);
  });
});

// ------------------------------------------------------------
// Realistic river / turn spots used by the convergence and timing tests
// ------------------------------------------------------------

// Hero: a wide in-position continuing range. Villain: a tighter range.
const WIDE = [
  'AA', 'KK', 'QQ', 'JJ', 'TT', '99', '88', '77', '66', '55',
  'AK', 'AQ', 'AJs', 'ATs', 'KQ', 'KJs', 'QJs', 'JTs', 'T9s', '98s', '87s', '76s', 'A5s', 'A4s',
];
const TIGHT = ['AA', 'KK', 'QQ', 'JJ', 'TT', '99', 'AK', 'AQs', 'KQs', 'AJs', 'QJs', 'JTs', 'T9s', '98s', 'A5s'];

describe('subgame CFR: exploitability', () => {
  it('falls (monotonically-ish) with iterations and ends below 1% pot on the river', () => {
    const board = ids('Kd', '9h', '4c', '2s', '7h');
    const heroRange = rangeOf(WIDE, board);
    const villainRange = rangeOf(TIGHT, board);
    const r = solveSubgame({
      heroCards: hand('Ac', 'Kc'),
      board,
      heroRange,
      villainRange,
      pot: 100,
      toCall: 0,
      effectiveStack: 250,
      heroIsIP: false,
      targetExploitabilityPct: 0, // never stop early: we want the whole curve
      maxIterations: 200,
      exploitEvery: 5,
      trace: true,
      budgetMs: 30_000,
    });
    const tr = r.trace!.map((x) => x.exploitability);
    expect(tr.length).toBeGreaterThanOrEqual(40);
    // Big overall drop.
    expect(tr[tr.length - 1]).toBeLessThan(tr[0] / 10);
    // Monotone-ish: no checkpoint is more than 25% above the best seen so far,
    // and the running best strictly improves across each quarter of the run.
    let best = Infinity;
    for (const e of tr) {
      expect(e).toBeLessThanOrEqual(best * 1.25 + 1e-9);
      best = Math.min(best, e);
    }
    const q = Math.floor(tr.length / 4);
    const bestUpTo = (k: number) => Math.min(...tr.slice(0, k));
    expect(bestUpTo(2 * q)).toBeLessThan(bestUpTo(q));
    expect(bestUpTo(3 * q)).toBeLessThan(bestUpTo(2 * q));
    expect(bestUpTo(tr.length)).toBeLessThan(bestUpTo(3 * q));
    expect(tr[tr.length - 1]).toBeLessThan(1);
  });

  it('with the default 1500 ms budget a river spot converges below 1% pot', () => {
    const board = ids('Qs', 'Jh', '6d', '3c', '2h');
    const r = solveSubgame({
      heroCards: hand('Kh', 'Qh'),
      board,
      heroRange: rangeOf(WIDE, board),
      villainRange: rangeOf(TIGHT, board),
      pot: 100,
      toCall: 0,
      effectiveStack: 300,
      heroIsIP: false,
    });
    expect(r.exploitability).toBeLessThan(1);
    expect(r.converged).toBe(true);
    // Leave slack for a loaded CI machine: the loop stops on the budget itself.
    expect(r.ms).toBeLessThan(1500 + 500);
  });

  it('exploitability of a uniform-random start is large (the metric is not vacuous)', () => {
    const { solver } = toyGame(1);
    solver.iterate(); // one iteration: strategies are still near uniform
    expect(solver.exploitability()).toBeGreaterThan(2); // chips, in a 100 pot
  });
});

// ------------------------------------------------------------
// (3) The bug that got the old solver disconnected
// ------------------------------------------------------------
//
// Board Kh 9h 4c 2s, river 7h completes the flush. Hero holds Ks9c (top two
// pair, no heart). Villain's range is what calls flop and turn on a two-heart
// board: mostly flush draws (now flushes) plus sets, with a little top pair.
// Two pair beats only the top pairs, so it must never be bet for value.

const FLUSHY_VILLAIN = [
  'AhQh', 'AhJh', 'AhTh', 'Ah8h', 'Ah6h', 'Ah5h', 'Ah3h', 'QhJh', 'QhTh', 'JhTh',
  'Th8h', '8h6h', '6h5h', '5h3h', 'Qh8h', 'Jh8h', '44', '22', '77', 'AK:0.3', 'KQ:0.3',
];
const HERO_BARREL_RANGE = ['K9', 'K7:0.5', 'AK', 'KQ', 'KJ', 'AhJh', 'QhTh', 'Ah5h', '99', 'JT', 'T8', '86', '65'];

describe('subgame CFR: dominated two pair on a flush-completing river', () => {
  const flushBoard = ids('Kh', '9h', '4c', '2s', '7h');
  const base = {
    heroCards: hand('Ks', '9c'),
    board: flushBoard,
    heroRange: rangeOf(HERO_BARREL_RANGE, flushBoard),
    villainRange: rangeOf(FLUSHY_VILLAIN, flushBoard),
    effectiveStack: 300,
  };

  it('never value-bets out of position', () => {
    const r = solveSubgame({ ...base, pot: 100, toCall: 0, heroIsIP: false });
    expect(aggressionMass(r.strategy)).toBeLessThan(0.02);
    expect(r.strategy.X).toBeGreaterThan(0.98);
  });

  it('never value-bets in position when checked to', () => {
    const r = solveSubgame({ ...base, pot: 100, toCall: 0, heroIsIP: true });
    expect(aggressionMass(r.strategy)).toBeLessThan(0.02);
  });

  it('never raises facing a bet', () => {
    const r = solveSubgame({ ...base, pot: 175, toCall: 75, heroIsIP: false });
    expect(aggressionMass(r.strategy)).toBeLessThan(0.02);
    // 75 into 100 asks for 30% equity; two pair is well short of that here.
    expect(r.strategy.F).toBeGreaterThan(0.9);
  });

  it('control: on a brick river the same hand vs the same range bets for value', () => {
    const brick = ids('Kh', '9h', '4c', '2s', '3c');
    const r = solveSubgame({
      ...base,
      board: brick,
      heroRange: rangeOf(HERO_BARREL_RANGE, brick),
      villainRange: rangeOf(FLUSHY_VILLAIN, brick),
      pot: 100,
      toCall: 0,
      heroIsIP: false,
    });
    expect(aggressionMass(r.strategy)).toBeGreaterThan(0.8);
  });
});

// ------------------------------------------------------------
// (4) Timing with 100-200 combos per side
// ------------------------------------------------------------

/** First `n` board-free combos of a fixed, deterministic strength ordering. */
function topCombos(board: CardId[], n: number, salt: number) {
  const dead = new Set(board);
  const all: { c: [CardId, CardId]; score: number }[] = [];
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      if (dead.has(a) || dead.has(b)) continue;
      const ra = a >> 2;
      const rb = b >> 2;
      const suited = (a & 3) === (b & 3);
      // Pairs first, then high cards, suited bonus, plus a deterministic jitter
      // so the two sides are different ranges.
      const score = (ra === rb ? 30 + ra : ra + rb + (suited ? 4 : 0)) + ((a * 7 + b * 13 + salt) % 11) / 2;
      all.push({ c: [a, b], score });
    }
  }
  all.sort((x, y) => y.score - x.score);
  const top = all.slice(0, n);
  return { combos: top.map((x) => x.c), weights: top.map(() => 1) };
}

describe('subgame CFR: timing', () => {
  const cases: { street: string; board: string[]; n: number }[] = [
    { street: 'river', board: ['Kd', '9h', '4c', '2s', '7h'], n: 100 },
    { street: 'river', board: ['Kd', '9h', '4c', '2s', '7h'], n: 200 },
    { street: 'turn', board: ['Kd', '9h', '4c', '2s'], n: 100 },
    { street: 'turn', board: ['Kd', '9h', '4c', '2s'], n: 200 },
  ];
  for (const cs of cases) {
    it(`${cs.street} with ${cs.n} combos per side finishes within the budget`, () => {
      const board = ids(...cs.board);
      const heroRange = topCombos(board, cs.n, 1);
      const villainRange = topCombos(board, cs.n, 5);
      const heroCards = heroRange.combos[10];
      const r = solveSubgame({
        heroCards,
        board,
        heroRange,
        villainRange,
        pot: 100,
        toCall: 0,
        effectiveStack: 300,
        heroIsIP: false,
        budgetMs: 1500,
      });
      // Reported so the numbers are visible in the test log.
      // eslint-disable-next-line no-console
      console.log(
        `[subgame timing] ${cs.street} ${r.combos.hero}x${r.combos.villain} combos: ` +
          `${r.ms} ms, ${r.iterations} iterations, exploitability ${r.exploitability.toFixed(3)}% pot, ` +
          `converged=${r.converged}`,
      );
      expect(r.combos.villain).toBe(cs.n);
      expect(r.ms).toBeLessThan(1500 + 500);
      expect(r.exploitability).toBeLessThan(1);
    });
  }
});

// ------------------------------------------------------------
// Tree semantics, conventions and validation
// ------------------------------------------------------------

describe('subgame CFR: betting tree and conventions', () => {
  it('hero OOP: a check passes action to villain; hero IP vs a check: a check ends the street', () => {
    const ab = defaultAbstraction(5);
    const oop = buildSubgameTree({ startingPot: 100, effectiveStack: 300, toCall: 0, heroIsIP: false, priorAggressions: 0, abstraction: ab });
    expect(oop.children[0].kind).toBe('decision');
    expect(oop.children[0].player).toBe(1);
    const ip = buildSubgameTree({ startingPot: 100, effectiveStack: 300, toCall: 0, heroIsIP: true, priorAggressions: 0, abstraction: ab });
    expect(ip.children[0].kind).toBe('showdown');
  });

  it('river abstraction offers 33/75/125% pot and all-in under SPR 4, then one raise size, then all-in only', () => {
    const ab = defaultAbstraction(5);
    const root = buildSubgameTree({ startingPot: 100, effectiveStack: 300, toCall: 0, heroIsIP: false, priorAggressions: 0, abstraction: ab });
    expect(root.actions.map((a) => a.label)).toEqual(['X', 'B33', 'B75', 'B125', 'A']);
    expect(root.actions.map((a) => a.chips)).toEqual([0, 33, 75, 125, 300]);
    const facingB33 = root.children[1];
    expect(facingB33.actions.map((a) => a.label)).toEqual(['F', 'C', 'R70', 'A']);
    // Raise to 33 + 0.7 * (100 + 33 + 33) = 149.2
    expect(facingB33.actions[2].totalCommitted).toBeCloseTo(149.2, 5);
    const facingRaise = facingB33.children[2];
    expect(facingRaise.actions.map((a) => a.label)).toEqual(['F', 'C', 'A']);
    expect(countTree(root).decisions).toBeGreaterThan(5);
  });

  it('deep stacks on the turn: no all-in at SPR above 2.5', () => {
    const root = buildSubgameTree({ startingPot: 100, effectiveStack: 1000, toCall: 0, heroIsIP: false, priorAggressions: 0, abstraction: defaultAbstraction(4) });
    expect(root.actions.map((a) => a.label)).toEqual(['X', 'B33', 'B75', 'B125']);
  });

  it('facing a bet: call adds exactly toCall, raiseTo includes chips already in on this street', () => {
    const board = ids('Qs', 'Jh', '6d', '3c', '2h');
    const r = solveSubgame({
      heroCards: hand('Qh', 'Qd'),
      board,
      heroRange: rangeOf(WIDE, board),
      villainRange: rangeOf(TIGHT, board),
      pot: 160, // 100 from earlier streets plus villain's 60 bet
      toCall: 60,
      effectiveStack: 400,
      heroIsIP: true,
      heroStreetCommitted: 0,
    });
    const call = r.actions.find((a) => a.kind === 'call')!;
    expect(call.chips).toBe(60);
    const raises = r.actions.filter((a) => a.kind === 'raise' || a.kind === 'allin');
    expect(raises.length).toBeGreaterThan(0);
    for (const a of raises) expect(a.raiseTo).toBe(a.chips);
    // Top set facing a bet never folds.
    expect(r.strategy.F).toBeLessThan(0.01);
    let total = 0;
    for (const p of Object.values(r.strategy)) total += p;
    expect(total).toBeCloseTo(1, 9);
    expect(r.distribution.fold).toBeCloseTo(r.strategy.F, 12);
  });

  it('card removal: conflicting combos are excluded from showdown, not scored as ties', () => {
    const board = ids('2c', '3d', '4h', '8s', '9s');
    const { share, compat } = showdownMatrix(board, [hand('Ah', 'Ad')], [hand('Ah', 'Kd'), hand('Ks', 'Kc')]);
    expect(compat[0]).toBe(0);
    expect(share[0]).toBe(0);
    expect(compat[1]).toBe(1);
    expect(share[1]).toBe(1);
  });

  it('turn equity enumerates every river card exactly', () => {
    // AhKh vs QsQc on 2h 7h 9c Jd: hero wins with any heart, an A or a K.
    const board = ids('2h', '7h', '9c', 'Jd');
    const { share } = showdownMatrix(board, [hand('Ah', 'Kh')], [hand('Qs', 'Qc')]);
    // 44 unseen cards. Outs: 9 hearts + 3 aces + 3 kings = 15. A ten (4 cards)
    // gives hero nothing (QJT9 needs an 8 or K); no ties possible.
    expect(share[0]).toBeCloseTo(15 / 44, 10);
  });

  it('villain weights matter: the same combos with flush-heavy weights change the decision', () => {
    const board = ids('Kh', '9h', '4c', '2s', '7h');
    const combos = ['AhQh', 'AhJh', 'QhJh', 'JhTh', 'Th8h', 'AK', 'KQ', 'KJ'];
    const flushHeavy = rangeOf(combos.map((c) => (c.length === 4 ? `${c}:5` : `${c}:0.1`)), board);
    const pairHeavy = rangeOf(combos.map((c) => (c.length === 4 ? `${c}:0.05` : `${c}:1`)), board);
    const common = {
      heroCards: hand('Ks', '9c'),
      board,
      heroRange: rangeOf(HERO_BARREL_RANGE, board),
      pot: 100,
      toCall: 0,
      effectiveStack: 300,
      heroIsIP: false,
    };
    const a = solveSubgame({ ...common, villainRange: flushHeavy });
    const b = solveSubgame({ ...common, villainRange: pairHeavy });
    expect(aggressionMass(a.strategy)).toBeLessThan(0.05);
    expect(aggressionMass(b.strategy)).toBeGreaterThan(0.5);
  });

  it('rejects bad input so the engine can fall back', () => {
    const board = ids('Kd', '9h', '4c', '2s', '7h');
    const ok = {
      heroCards: hand('Ac', 'Kc'),
      board,
      heroRange: rangeOf(WIDE, board),
      villainRange: rangeOf(TIGHT, board),
      pot: 100,
      toCall: 0,
      effectiveStack: 300,
      heroIsIP: false,
    };
    expect(() => solveSubgame({ ...ok, board: ids('Kd', '9h') })).toThrow();
    expect(() => solveSubgame({ ...ok, heroCards: hand('Kd', 'Ac') })).toThrow();
    expect(() => solveSubgame({ ...ok, street: 'turn' })).toThrow();
    expect(() => solveSubgame({ ...ok, toCall: 100 })).toThrow();
    expect(() => solveSubgame({ ...ok, villainRange: { combos: [], weights: [] } })).toThrow();
  });

  it('solves when hero\'s exact hand is missing from hero\'s range', () => {
    const board = ids('Kd', '9h', '4c', '2s', '7h');
    const r = solveSubgame({
      heroCards: hand('3c', '3d'),
      board,
      heroRange: rangeOf(TIGHT, board),
      villainRange: rangeOf(TIGHT, board),
      pot: 100,
      toCall: 0,
      effectiveStack: 300,
      heroIsIP: false,
    });
    let total = 0;
    for (const p of Object.values(r.strategy)) total += p;
    expect(total).toBeCloseTo(1, 9);
  });

  it('flop spots solve within the budget (sampled runouts)', () => {
    const board = ids('Kd', '9h', '4c');
    const r = solveSubgame({
      heroCards: hand('Ac', 'Kc'),
      board,
      heroRange: rangeOf(WIDE, board),
      villainRange: rangeOf(TIGHT, board),
      pot: 100,
      toCall: 0,
      effectiveStack: 300,
      heroIsIP: false,
    });
    expect(r.street).toBe('flop');
    expect(r.ms).toBeLessThan(1500 + 500);
    expect(r.exploitability).toBeLessThan(1);
  });

  it('is deterministic', () => {
    const board = ids('Kd', '9h', '4c', '2s', '7h');
    const args = {
      heroCards: hand('Ac', 'Kc'),
      board,
      heroRange: rangeOf(WIDE, board),
      villainRange: rangeOf(TIGHT, board),
      pot: 100,
      toCall: 0,
      effectiveStack: 300,
      heroIsIP: false,
      maxIterations: 60,
      targetExploitabilityPct: 0,
      budgetMs: 60_000,
    };
    const a = solveSubgame(args);
    const b = solveSubgame(args);
    expect(a.iterations).toBe(60);
    for (const k of Object.keys(a.strategy)) expect(a.strategy[k]).toBe(b.strategy[k]);
  });

  it('facing a raise: re-raise is all-in only and amounts are street totals', () => {
    // Hero bet 20 into 100, villain raised to 60: pot 180, hero must add 40.
    const board = ids('Qs', 'Jh', '6d', '3c', '2h');
    const r = solveSubgame({
      heroCards: hand('Qh', 'Qd'),
      board,
      heroRange: rangeOf(WIDE, board),
      villainRange: rangeOf(TIGHT, board),
      pot: 180,
      toCall: 40,
      effectiveStack: 380,
      heroIsIP: false,
      heroStreetCommitted: 20,
      priorAggressions: 2,
    });
    expect(r.actions.map((a) => a.label)).toEqual(['F', 'C', 'A']);
    const allin = r.actions[2];
    expect(allin.chips).toBe(380);
    expect(allin.raiseTo).toBe(400);
    expect(r.distribution.bets).toEqual([{ amount: 400, probability: allin.probability }]);
  });
});

describe('subgame CFR: engine helpers', () => {
  const base = { street: 'river' as const, opponentsInHand: 1, heroCombos: 150, villainCombos: 120, pot: 100, toCall: 0, effectiveStack: 300 };

  it('eligibility: heads-up turn/river only, flop opt-in, thin ranges and deep turns rejected', () => {
    expect(subgameEligibility(base).ok).toBe(true);
    expect(subgameEligibility({ ...base, street: 'turn' }).ok).toBe(true);
    expect(subgameEligibility({ ...base, opponentsInHand: 2 }).ok).toBe(false);
    expect(subgameEligibility({ ...base, street: 'flop' }).ok).toBe(false);
    expect(subgameEligibility({ ...base, street: 'flop', allowFlop: true }).ok).toBe(true);
    expect(subgameEligibility({ ...base, street: 'preflop' }).ok).toBe(false);
    expect(subgameEligibility({ ...base, villainCombos: 3 }).ok).toBe(false);
    expect(subgameEligibility({ ...base, street: 'turn', effectiveStack: 1000 }).ok).toBe(false);
    expect(subgameEligibility({ ...base, effectiveStack: 1000 }).ok).toBe(true); // river: any SPR
  });

  it('pickSubgameAction samples by probability and returns street-total amounts', () => {
    const board = ids('Kd', '9h', '4c', '2s', '3c');
    const r = solveSubgame({
      heroCards: hand('Ks', '9c'),
      board,
      heroRange: rangeOf(HERO_BARREL_RANGE, board),
      villainRange: rangeOf(FLUSHY_VILLAIN, board),
      pot: 100,
      toCall: 0,
      effectiveStack: 300,
      heroIsIP: false,
      heroStreetCommitted: 0,
    });
    const top = pickSubgameAction(r);
    const best = r.actions.reduce((x, y) => (y.probability > x.probability ? y : x));
    expect(top.label).toBe(best.label);
    // u = 0 picks the first action with any probability.
    const first = pickSubgameAction(r, 0);
    expect(first.label).toBe(r.actions.find((a) => a.probability > 0)!.label);
    for (const u of [0.1, 0.5, 0.9]) {
      const p = pickSubgameAction(r, u);
      const a = r.actions.find((x) => x.label === p.label)!;
      if (p.action === 'bet' || p.action === 'raise' || p.action === 'allin') expect(p.amount).toBe(a.raiseTo);
      else expect(p.amount).toBeUndefined();
    }
  });
});
