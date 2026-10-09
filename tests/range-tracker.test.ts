import { describe, it, expect } from 'vitest';
import { Action, CardId, GameState, Player, Position, Street } from '../src/types/poker';
import { evaluateHand, HAND_CATEGORY } from '../src/core/equity/hand-eval';
import { handGroupName } from '../src/core/cfr/card-utils';
import { WeightedRange } from '../src/core/ranges/weighted-range';
import {
  liveVillainIndexes,
  preflopRangeFor,
  narrowRange,
  estimateVillainRanges,
  heroRangeFor,
  postflopSteps,
  describePreflopLine,
  sampleRangeCombos,
} from '../src/core/ranges/range-tracker';
import { card, cid, ids } from './helpers';

// ============================================================
// Range tracker tests: folded players, preflop-line ranges, postflop narrowing,
// normalization / card removal, and the river performance budget.
// ============================================================

function mkPlayer(name: string, position: Position, isHero = false): Player {
  return {
    name, stack: 2000, position, isDealer: position === 'BTN',
    isSittingOut: false, seatIndex: 0, isHero, currentBet: 0, hasActed: false,
  };
}

type History = Partial<Record<Street, Action[]>>;

function mkState(players: Player[], heroIndex: number, history: History, board: string[] = [], hero: [string, string] = ['2c', '3d']): GameState {
  players.forEach((p, i) => { p.seatIndex = i; p.isHero = i === heroIndex; });
  const street: Street = board.length === 0 ? 'preflop' : board.length === 3 ? 'flop' : board.length === 4 ? 'turn' : 'river';
  return {
    tableId: 't', handNumber: 1, street, pot: 100, sidePots: [],
    heroCards: [card(hero[0]), card(hero[1])],
    communityCards: board.map(card),
    players, heroIndex, dealerIndex: 0, activePlayerIndex: heroIndex,
    currentBet: 0, minRaise: 40, bigBlind: 20, smallBlind: 10,
    actionHistory: { preflop: [], flop: [], turn: [], river: [], ...history },
    isOurTurn: true, timestamp: 0,
  };
}

const sixMax = (): Player[] => [
  mkPlayer('Ulla', 'UTG'), mkPlayer('Mo', 'MP'), mkPlayer('Cleo', 'CO'),
  mkPlayer('Ben', 'BTN'), mkPlayer('Sam', 'SB'), mkPlayer('Bob', 'BB'),
];

const act = (playerName: string, type: Action['type'], amount?: number): Action =>
  amount === undefined ? { type, playerName } : { type, playerName, amount };

/** Total weight per hand class ('AA', '72o', ...). */
function classWeights(r: WeightedRange): Map<string, number> {
  const m = new Map<string, number>();
  r.combos.forEach(([a, b], i) => {
    const n = handGroupName(a, b);
    m.set(n, (m.get(n) ?? 0) + r.weights[i]);
  });
  return m;
}

/** Combo-equivalents in a range: sum of weights relative to the heaviest combo. */
function comboEquivalents(r: WeightedRange): number {
  const max = Math.max(...r.weights);
  return r.weights.reduce((s, w) => s + w / max, 0);
}

/** Top pair (pair using the top board rank) or better, overpairs included. */
function topPairOrBetter(a: CardId, b: CardId, board: CardId[]): boolean {
  const cat = Math.floor(evaluateHand([a, b, ...board]) / 1_000_000);
  if (cat >= HAND_CATEGORY.TWO_PAIR) return true;
  if (cat !== HAND_CATEGORY.PAIR) return false;
  const top = Math.max(...board.map(c => (c / 4) | 0));
  const ra = (a / 4) | 0, rb = (b / 4) | 0;
  if (ra === rb) return ra > top; // overpair
  return ra === top || rb === top;
}

function massWhere(r: WeightedRange, pred: (a: CardId, b: CardId) => boolean): number {
  let s = 0;
  r.combos.forEach(([a, b], i) => { if (pred(a, b)) s += r.weights[i]; });
  return s;
}

function expectNormalizedAndClean(r: WeightedRange, dead: CardId[]) {
  const sum = r.weights.reduce((s, w) => s + w, 0);
  expect(sum).toBeCloseTo(1, 9);
  expect(r.combos.length).toBe(r.weights.length);
  const deadSet = new Set(dead);
  for (const [a, b] of r.combos) {
    expect(a).toBeLessThan(b);
    expect(deadSet.has(a)).toBe(false);
    expect(deadSet.has(b)).toBe(false);
  }
  for (const w of r.weights) expect(w).toBeGreaterThan(0);
}

// ------------------------------------------------------------

describe('liveVillainIndexes (folded players are out of the hand)', () => {
  it('excludes hero, sitting-out seats, and players who folded on any street', () => {
    const ps = sixMax();
    ps[1].isSittingOut = true; // Mo not dealt in
    const s = mkState(ps, 3, {
      preflop: [
        act('Ulla', 'fold'), act('Cleo', 'raise', 50), act('Ben', 'call', 50),
        act('Sam', 'fold'), act('Bob', 'call', 50),
      ],
      flop: [act('Bob', 'check'), act('Cleo', 'bet', 60), act('Ben', 'call', 60), act('Bob', 'fold')],
    }, ['Kd', '7h', '2s']);
    // Hero = Ben (3). Ulla/Sam folded preflop, Bob folded the flop, Mo sat out.
    expect(liveVillainIndexes(s)).toEqual([2]);
  });

  it('matches lowercased log names (the scraper lowercases log lines)', () => {
    const ps = sixMax();
    const s = mkState(ps, 5, {
      preflop: [act('ulla', 'fold'), act('mo @ x1y2', 'fold'), act('cleo', 'raise', 50), act('ben', 'fold'), act('sam', 'fold')],
    });
    expect(liveVillainIndexes(s)).toEqual([2]);
  });

  it('a heads-up flop at a 6-max table has exactly one live villain', () => {
    const ps = sixMax();
    const s = mkState(ps, 5, {
      preflop: [act('Ulla', 'fold'), act('Mo', 'fold'), act('Cleo', 'raise', 50), act('Ben', 'fold'), act('Sam', 'fold'), act('Bob', 'call', 50)],
    }, ['Kd', '7h', '2s']);
    expect(liveVillainIndexes(s)).toHaveLength(1);
  });
});

describe('preflopRangeFor', () => {
  it('UTG open range includes AA and excludes 72o', () => {
    const s = mkState(sixMax(), 5, { preflop: [act('Ulla', 'raise', 60)] });
    const r = preflopRangeFor(s, 0);
    const w = classWeights(r);
    expect(w.get('AA') ?? 0).toBeGreaterThan(0);
    expect(w.get('72o') ?? 0).toBe(0);
    expect(w.get('KQs') ?? 0).toBeGreaterThan(0);
    // ~14-16% of combos per the chart: well under a quarter of all hands.
    expect(comboEquivalents(r)).toBeLessThan(0.25 * 1326);
    expectNormalizedAndClean(r, []);
  });

  it("a 3-bettor's range is much tighter than a cold-caller's (6-max)", () => {
    // BB facing a CO open: the chart has a real flatting range and a 3-bet range.
    const pre = [act('Ulla', 'fold'), act('Mo', 'fold'), act('Cleo', 'raise', 50), act('Ben', 'fold'), act('Sam', 'fold')];
    const threeBet = mkState(sixMax(), 3, { preflop: [...pre, act('Bob', 'raise', 180)] });
    const flat = mkState(sixMax(), 3, { preflop: [...pre, act('Bob', 'call', 50)] });
    const r3 = comboEquivalents(preflopRangeFor(threeBet, 5));
    const rc = comboEquivalents(preflopRangeFor(flat, 5));
    expect(r3).toBeLessThan(0.6 * rc);
    expect(describePreflopLine(threeBet, 5)).toContain('3-bet');
    expect(describePreflopLine(flat, 5)).toContain('call open');
  });

  it('an in-position flatter of a 3-bet-or-fold chart still gets a real range', () => {
    // BTN vs CO is 3-bet-or-fold in both 6-max packs. A human who flats there
    // must not be read as holding only the 2 hands the chart mixes.
    const flat = mkState(sixMax(), 5, {
      preflop: [act('Ulla', 'fold'), act('Mo', 'fold'), act('Cleo', 'raise', 50), act('Ben', 'call', 50)],
    });
    const threeBet = mkState(sixMax(), 5, {
      preflop: [act('Ulla', 'fold'), act('Mo', 'fold'), act('Cleo', 'raise', 50), act('Ben', 'raise', 160)],
    });
    const rf = preflopRangeFor(flat, 3);
    const r3 = preflopRangeFor(threeBet, 3);
    expect(comboEquivalents(rf)).toBeGreaterThan(100);
    // The re-split puts premiums in the 3-bet range, not the flat range.
    const perCombo = (r: WeightedRange, h: string, n: number) => (classWeights(r).get(h) ?? 0) / n;
    expect(perCombo(r3, 'AA', 6)).toBeGreaterThan(perCombo(r3, '98s', 4));
    expect(perCombo(rf, '98s', 4)).toBeGreaterThan(perCombo(rf, 'AA', 6));
  });

  it("a heads-up 3-bettor's range is much tighter than a flatter's", () => {
    const hu = () => [mkPlayer('Ann', 'SB'), mkPlayer('Bo', 'BB')];
    const threeBet = mkState(hu(), 0, { preflop: [act('Ann', 'raise', 50), act('Bo', 'raise', 150)] });
    const flat = mkState(hu(), 0, { preflop: [act('Ann', 'raise', 50), act('Bo', 'call', 50)] });
    const r3 = comboEquivalents(preflopRangeFor(threeBet, 1));
    const rc = comboEquivalents(preflopRangeFor(flat, 1));
    expect(r3).toBeLessThan(0.5 * rc);
  });

  it('a 4-bettor is tighter than the opener, and calling a 3-bet keeps a middle band', () => {
    const base = [act('Ulla', 'fold'), act('Mo', 'fold'), act('Cleo', 'raise', 50), act('Ben', 'raise', 160), act('Sam', 'fold'), act('Bob', 'fold')];
    const open = preflopRangeFor(mkState(sixMax(), 5, { preflop: base.slice(0, 3) }), 2);
    const fourBet = preflopRangeFor(mkState(sixMax(), 5, { preflop: [...base, act('Cleo', 'raise', 400)] }), 2);
    const call3 = preflopRangeFor(mkState(sixMax(), 5, { preflop: [...base, act('Cleo', 'call', 160)] }), 2);
    expect(comboEquivalents(fourBet)).toBeLessThan(0.3 * comboEquivalents(open));
    expect(comboEquivalents(call3)).toBeLessThan(comboEquivalents(open));
    expect(classWeights(fourBet).get('AA') ?? 0).toBeGreaterThan(0);
  });

  it('a limper is capped: 76s weighs more than AA', () => {
    const s = mkState(sixMax(), 5, { preflop: [act('Ulla', 'fold'), act('Mo', 'call', 20)] });
    const w = classWeights(preflopRangeFor(s, 1));
    // per-combo comparison (AA has 6 combos, 76s has 4)
    expect((w.get('76s') ?? 0) / 4).toBeGreaterThan((w.get('AA') ?? 0) / 6);
  });

  it('BB check in a limped pot keeps weak hands and down-weights premiums', () => {
    const s = mkState(sixMax(), 0, {
      preflop: [act('Ulla', 'call', 20), act('Mo', 'fold'), act('Cleo', 'fold'), act('Ben', 'fold'), act('Sam', 'fold'), act('Bob', 'check')],
    });
    const w = classWeights(preflopRangeFor(s, 5));
    expect((w.get('72o') ?? 0) / 12).toBeGreaterThan((w.get('AA') ?? 0) / 6);
  });

  it('infers a missing call when the log lost the BB action (flop reached)', () => {
    const s = mkState(sixMax(), 2, {
      preflop: [act('Cleo', 'raise', 50)],
    }, ['Kd', '7h', '2s']);
    // BB has no logged action but is not folded: inferred call of the CO open.
    expect(describePreflopLine(s, 5)).toContain('call open (inferred)');
    const w = classWeights(preflopRangeFor(s, 5));
    expect(w.get('72o') ?? 0).toBe(0);
    expect(w.get('T9s') ?? 0).toBeGreaterThan(0);
  });
});

describe('narrowRange', () => {
  const board = ids('Kd', '7h', '2s');
  const wide = (): WeightedRange => {
    const s = mkState([mkPlayer('Ann', 'SB'), mkPlayer('Bo', 'BB')], 1, { preflop: [act('Ann', 'raise', 50)] });
    return preflopRangeFor(s, 0);
  };
  const strongMass = (r: WeightedRange) => massWhere(r, (a, b) => topPairOrBetter(a, b, board));

  it('a check caps the range (less top-pair+ than before)', () => {
    const r0 = narrowRange(wide(), board, 'check', 0, 'flop');
    const before = strongMass(normalized(wide(), board));
    expect(strongMass(r0)).toBeLessThan(before);
  });

  it('a bet raises the strong share; a bigger bet is more polarized', () => {
    const base = strongMass(normalized(wide(), board));
    const smallR = narrowRange(wide(), board, 'bet', 0.33, 'flop');
    const bigR = narrowRange(wide(), board, 'bet', 1.25, 'flop');
    expect(strongMass(smallR)).toBeGreaterThan(base);
    expect(strongMass(bigR)).toBeGreaterThan(base);
    // Medium made hands (a pair below top pair) thin out as the size grows:
    // big bets are value + bluffs, small bets also carry thin value.
    const medium = (r: WeightedRange) => massWhere(r, (a, b) => {
      const cat = Math.floor(evaluateHand([a, b, ...board]) / 1_000_000);
      return cat === HAND_CATEGORY.PAIR && !topPairOrBetter(a, b, board);
    });
    expect(medium(bigR)).toBeLessThan(medium(smallR));
  });

  it('a flop bet keeps flush draws as semi-bluffs', () => {
    const fdBoard = ids('Kd', '7d', '2s');
    const r = narrowRange(wide(), fdBoard, 'bet', 0.66, 'flop');
    const w = new Map<string, number>();
    r.combos.forEach(([a, b], i) => w.set(`${a},${b}`, r.weights[i]));
    const key = (x: string, y: string) => { const p = [cid(x), cid(y)].sort((m, n) => m - n); return `${p[0]},${p[1]}`; };
    // Qd9d (flush draw, no pair) should outweigh Qc9h (same ranks, no draw).
    expect(w.get(key('Qd', '9d'))!).toBeGreaterThan(3 * w.get(key('Qc', '9h'))!);
  });

  it('a call trims the nuts partially and air heavily, keeping medium hands', () => {
    const r = narrowRange(wide(), board, 'call', 0.66, 'flop');
    const per = (x: string, y: string) => {
      const p = [cid(x), cid(y)].sort((m, n) => m - n);
      const i = r.combos.findIndex(c => c[0] === p[0] && c[1] === p[1]);
      return i >= 0 ? r.weights[i] : 0;
    };
    const set = per('7c', '7d');   // bottom set: near the top, partially trimmed
    const tp = per('Kc', 'Ts');    // top pair
    const air = per('5c', '3d');   // nothing
    expect(tp).toBeGreaterThan(5 * air);
    expect(set).toBeGreaterThan(air);
    expect(set).toBeLessThan(tp * 1.01); // not boosted above top pair
  });

  it('never returns board cards and is normalized', () => {
    const r = narrowRange(wide(), board, 'raise', 1, 'flop');
    expectNormalizedAndClean(r, board);
  });
});

function normalized(r: WeightedRange, dead: CardId[]): WeightedRange {
  // same as normalizeRange, inline to keep the test self-explanatory
  const blocked = new Set(dead);
  const combos: [CardId, CardId][] = [];
  const weights: number[] = [];
  r.combos.forEach((c, i) => { if (!blocked.has(c[0]) && !blocked.has(c[1])) { combos.push(c); weights.push(r.weights[i]); } });
  const t = weights.reduce((s, w) => s + w, 0);
  return { combos, weights: weights.map(w => w / t) };
}

describe('estimateVillainRanges', () => {
  // HU: villain (SB/button) opens, hero (BB) calls; board Kd 7h 2s Qc 5d.
  const river = ['Kd', '7h', '2s', 'Qc', '5d'];
  const hu = () => [mkPlayer('Hero', 'BB'), mkPlayer('Vil', 'SB')];
  const pre = [act('Vil', 'raise', 50), act('Hero', 'call', 50)];

  const betBetBet = () => mkState(hu(), 0, {
    preflop: pre,
    flop: [act('Hero', 'check'), act('Vil', 'bet', 60), act('Hero', 'call', 60)],
    turn: [act('Hero', 'check'), act('Vil', 'bet', 150), act('Hero', 'call', 150)],
    river: [act('Hero', 'check'), act('Vil', 'bet', 400)],
  }, river, ['Ah', '3h']);
  const checkCheckCheck = () => mkState(hu(), 0, {
    preflop: pre,
    flop: [act('Hero', 'check'), act('Vil', 'check')],
    turn: [act('Hero', 'check'), act('Vil', 'check')],
    river: [act('Hero', 'check')],
  }, river, ['Ah', '3h']);

  it('after bet-bet-bet the top-pair+ share is clearly higher than after check-check-check', () => {
    const b = ids(...river);
    const heroCards = ids('Ah', '3h') as [CardId, CardId];
    const [vb] = estimateVillainRanges(betBetBet(), heroCards);
    const [vc] = estimateVillainRanges(checkCheckCheck(), heroCards);
    const pb = massWhere(vb.range, (x, y) => topPairOrBetter(x, y, b));
    const pc = massWhere(vc.range, (x, y) => topPairOrBetter(x, y, b));
    expect(pb).toBeGreaterThan(0.45);
    expect(pb).toBeGreaterThan(pc + 0.3);
    expect(pb).toBeGreaterThan(3 * pc);
  });

  it('outputs are normalized and never contain hero or board cards', () => {
    const heroCards = ids('Ah', '3h') as [CardId, CardId];
    for (const st of [betBetBet(), checkCheckCheck()]) {
      const vr = estimateVillainRanges(st, heroCards);
      expect(vr.map(v => v.playerIndex)).toEqual([1]);
      for (const v of vr) expectNormalizedAndClean(v.range, [...heroCards, ...ids(...river)]);
      expectNormalizedAndClean(heroRangeFor(st), ids(...river));
    }
  });

  it('multiway: one range per live villain, folded villains dropped', () => {
    const ps = sixMax();
    const s = mkState(ps, 5, {
      preflop: [act('Ulla', 'raise', 60), act('Mo', 'fold'), act('Cleo', 'call', 60), act('Ben', 'call', 60), act('Sam', 'fold'), act('Bob', 'call', 60)],
      flop: [act('Bob', 'check'), act('Ulla', 'bet', 120), act('Cleo', 'fold'), act('Ben', 'call', 120), act('Bob', 'call', 120)],
    }, ['Kd', '7h', '2s', 'Qc'], ['Ah', 'Jh']);
    const heroCards = ids('Ah', 'Jh') as [CardId, CardId];
    const vr = estimateVillainRanges(s, heroCards);
    expect(vr.map(v => v.playerIndex)).toEqual([0, 3]);
    for (const v of vr) expectNormalizedAndClean(v.range, [...heroCards, ...ids('Kd', '7h', '2s', 'Qc')]);
  });

  it('postflop sizing: sim-style "raise"/"allin" postflop bets are classified by context', () => {
    const s = mkState(hu(), 0, {
      preflop: pre,
      flop: [act('Hero', 'check'), act('Vil', 'raise', 50), act('Hero', 'raise', 200), act('Vil', 'allin', 1950)],
    }, ['Kd', '7h', '2s']);
    const steps = postflopSteps(s);
    expect(steps.map(x => `${x.playerIndex}:${x.kind}`)).toEqual(['0:check', '1:bet', '0:raise', '1:raise']);
    // pot 100 (50 + 50) -> villain bets 50 = 0.5 pot
    expect(steps[1].sizeFracOfPot).toBeCloseTo(0.5, 6);
    // hero raises to 200: pot after calling 50 = 200, increment 150 -> 0.75
    expect(steps[2].sizeFracOfPot).toBeCloseTo(0.75, 6);
  });

  it('runs a river spot (3 live villains) well under the 30 ms budget', () => {
    const ps = sixMax();
    const board = ['Kd', '7h', '2s', 'Qc', '5d'];
    const mk = () => mkState(ps, 5, {
      preflop: [act('Ulla', 'raise', 60), act('Mo', 'fold'), act('Cleo', 'call', 60), act('Ben', 'call', 60), act('Sam', 'fold'), act('Bob', 'call', 60)],
      flop: [act('Bob', 'check'), act('Ulla', 'bet', 120), act('Cleo', 'call', 120), act('Ben', 'call', 120), act('Bob', 'call', 120)],
      turn: [act('Bob', 'check'), act('Ulla', 'check'), act('Cleo', 'bet', 300), act('Ben', 'call', 300), act('Bob', 'call', 300), act('Ulla', 'call', 300)],
      river: [act('Bob', 'check'), act('Ulla', 'check'), act('Cleo', 'bet', 800), act('Ben', 'call', 800)],
    }, board, ['Ah', 'Jh']);
    const heroCards = ids('Ah', 'Jh') as [CardId, CardId];
    estimateVillainRanges(mk(), heroCards); // warm-up (JIT + board cache)
    const N = 20;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) estimateVillainRanges(mk(), heroCards);
    const per = (performance.now() - t0) / N;
    // Budget is 30 ms; allow headroom for a loaded CI machine.
    expect(per).toBeLessThan(60);
  });
});

describe('sampleRangeCombos', () => {
  it('matches the weights deterministically', () => {
    const r: WeightedRange = { combos: [[0, 1], [2, 3], [4, 5]], weights: [0.5, 0.3, 0.2] };
    const s = sampleRangeCombos(r, 100);
    expect(s).toHaveLength(100);
    const count = (a: number) => s.filter(c => c[0] === a).length;
    expect(count(0)).toBe(50);
    expect(count(2)).toBe(30);
    expect(count(4)).toBe(20);
    expect(sampleRangeCombos(r, 100)).toEqual(s);
  });

  it('returns an empty list for an empty range', () => {
    expect(sampleRangeCombos({ combos: [], weights: [] }, 50)).toEqual([]);
  });
});
