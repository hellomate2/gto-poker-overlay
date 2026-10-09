import { describe, it, expect } from 'vitest';
import {
  defendVsAggression, rangeEquities, balancedAggressorRange, bluffPropensity, barrelGate, blockerScoreOf, rangeFromPolicy, leadPolicyRange, MDF_RESCUE,
} from '../src/core/defense';
import { WeightedRange } from '../src/core/ranges/weighted-range';
import { equityVsRange } from '../src/core/equity/range-equity';
import { CardId } from '../src/types/poker';
import { cid, ids } from './helpers';

// ============================================================
// defense.ts — MDF / pot-odds / blocker-aware response to aggression, and the
// barrel gate. Ranges are built directly from hand-class strings so each test
// states exactly what villain and hero are assumed to hold.
// ============================================================

const SUITS = 'hdcs';

/**
 * Expand hand classes into concrete combos, skipping dead cards.
 * Accepts 'AKs', 'AKo', 'AK' (both), '77', or an exact combo like 'AsKd'.
 */
function combosOf(spec: string, dead: CardId[] = []): [CardId, CardId][] {
  const deadSet = new Set(dead);
  const out: [CardId, CardId][] = [];
  const push = (a: CardId, b: CardId) => {
    if (a === b || deadSet.has(a) || deadSet.has(b)) return;
    out.push([Math.min(a, b), Math.max(a, b)]);
  };
  if (spec.length === 4) { push(cid(spec.slice(0, 2)), cid(spec.slice(2))); return out; }
  const r1 = spec[0], r2 = spec[1], kind = spec[2];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (r1 === r2 && j <= i) continue;
      const suited = i === j;
      if (kind === 's' && !suited) continue;
      if (kind === 'o' && suited) continue;
      push(cid(r1 + SUITS[i]), cid(r2 + SUITS[j]));
    }
  }
  return out;
}

/** Build a WeightedRange from "class:weight" entries (weight defaults to 1). */
function range(entries: string[], dead: CardId[] = []): WeightedRange {
  const seen = new Set<number>();
  const combos: [CardId, CardId][] = [];
  const weights: number[] = [];
  for (const e of entries) {
    const [spec, w] = e.split(':');
    for (const c of combosOf(spec, dead)) {
      const k = c[0] * 52 + c[1];
      if (seen.has(k)) continue;
      seen.add(k);
      combos.push(c);
      weights.push(w === undefined ? 1 : Number(w));
    }
  }
  return { combos, weights };
}

describe('rangeEquities (card-removal-exact range-vs-range equity)', () => {
  it('matches equityVsRange exactly on the river and turn for a uniform range', () => {
    const villain = range(['AK', 'QQ', 'JTs', '98s', 'K7', '22']);
    const heroes: [CardId, CardId][] = [[cid('Kh'), cid('Qh')], [cid('7s'), cid('7d')], [cid('Ah'), cid('5h')]];
    for (const board of [ids('Kd', '7c', '2s', '9h', '4d'), ids('Kd', '7c', '2s', '9h')]) {
      const fast = rangeEquities(heroes, villain, board);
      heroes.forEach((h, i) => {
        const ref = equityVsRange(h, board, villain.combos, 1).equity;
        expect(fast[i]).toBeCloseTo(ref, 9);
      });
    }
  });

  it('respects combo weights (a doubled combo counts twice)', () => {
    const board = ids('Kd', '7c', '2s', '9h', '4d');
    const hero: [CardId, CardId][] = [[cid('Kh'), cid('Qh')]];
    // Villain: one combo hero beats (QJ), one that beats hero (AK). Equal weight -> 50%.
    const even = rangeEquities(hero, { combos: [[cid('Qs'), cid('Jd')], [cid('As'), cid('Kc')]], weights: [1, 1] }, board)[0];
    const skew = rangeEquities(hero, { combos: [[cid('Qs'), cid('Jd')], [cid('As'), cid('Kc')]], weights: [3, 1] }, board)[0];
    expect(even).toBeCloseTo(0.5, 9);
    expect(skew).toBeCloseTo(0.75, 9);
  });

  it('flop sampling is deterministic and close to exhaustive enumeration', () => {
    const board = ids('Js', '9s', '4d');
    const villain = range(['QQ', 'AJ', 'J9s', 'KsQs', '87s', 'T8s']);
    const hero: [CardId, CardId][] = [[cid('Ah'), cid('Jd')], [cid('Ts'), cid('8s')]];
    const a = rangeEquities(hero, villain, board, { runouts: 200 });
    const b = rangeEquities(hero, villain, board, { runouts: 200 });
    const exact = rangeEquities(hero, villain, board, { runouts: 5000 }); // >= 1176 -> all runouts
    expect(Array.from(a)).toEqual(Array.from(b));
    for (let i = 0; i < hero.length; i++) expect(Math.abs(a[i] - exact[i])).toBeLessThan(0.05);
  });
});

describe('defendVsAggression', () => {
  // Flop K72 rainbow. Hero c-bet 1/3 pot (33 into 100) and villain raised to 83.
  // Pot now 100 + 33 + 83 = 216, toCall 50, villain's raise = 83/133 of the pot it
  // went into -> MDF = 1/(1 + 0.624) = 62%.
  const flop = ids('Kd', '7c', '2s');
  const heroCbetRange = range([
    'AA', 'QQ', 'JJ', 'TT', '99', '88', '77', '22',
    'AK', 'KQ', 'KJ', 'KT', 'K9s', 'K8s',
    'A7s', '87s', '76s', 'A2s',
    'QJ', 'QT', 'JT', 'T9s', 'A5s', 'A4s', 'A3s', '65s', '54s', 'Q9s', 'J9s',
  ], flop);
  // Villain's raising range, already narrowed: value-heavy (sets, two pair, top
  // pair good kicker) with only a few semibluffs.
  const villainRaiseRange = range([
    '77', '22', 'K7s', 'K2s', '72s', 'AK', 'KQ', 'KJ',
    '65s',
  ], flop);

  it('does not fold a medium hand inside the MDF share facing a small raise', () => {
    // A7s: middle pair, top kicker. Not a value raise, but it sits well inside
    // the top 62% of hero's c-bet range.
    const res = defendVsAggression({
      heroCards: [cid('Ah'), cid('7h')], board: flop,
      heroRange: heroCbetRange, villainRange: villainRaiseRange,
      pot: 216, toCall: 50, street: 'flop', villainActionSizeFrac: 83 / 133, facingRaise: true,
    });
    expect(res.mdf).toBeCloseTo(1 / (1 + 83 / 133), 9);
    expect(res.potOdds).toBeCloseTo(50 / 266, 9);
    expect(res.heroRangePercentile).toBeLessThan(res.mdf);
    expect(res.action).not.toBe('fold');
    expect(res.equity).toBeGreaterThanOrEqual(res.continueThreshold);
  });

  it('keeps an underpair that pot odds alone would fold when it is inside the MDF share', () => {
    // 88 is behind most of villain's value-heavy raising range (equity below the
    // 19% price) but is still in the top ~half of hero's c-bet range. Folding it
    // (and everything below it) would let villain raise any two profitably.
    const args = {
      heroCards: [cid('8h'), cid('8s')] as [CardId, CardId], board: flop, villainRange: villainRaiseRange,
      pot: 216, toCall: 50, street: 'flop' as const, villainActionSizeFrac: 83 / 133, facingRaise: true,
    };
    const withRange = defendVsAggression({ ...args, heroRange: heroCbetRange });
    const potOddsOnly = defendVsAggression(args);
    expect(withRange.equity).toBeLessThan(withRange.potOdds);
    expect(withRange.heroRangePercentile).toBeLessThan(withRange.mdf);
    expect(withRange.action).toBe('call');
    expect(withRange.reasoning).toContain('MDF');
    expect(potOddsOnly.action).toBe('fold');
  });

  it('the MDF rule lowers the bar below pot odds when hero\'s range is weak vs villain\'s, but never below the floor', () => {
    // Same spot, but villain's range is pure value: every bluff-catcher is behind.
    const valueOnly = range(['77', '22', 'K7s', 'K2s', '72s', 'AK'], flop);
    const res = defendVsAggression({
      heroCards: [cid('Ah'), cid('7h')], board: flop,
      heroRange: heroCbetRange, villainRange: valueOnly,
      pot: 216, toCall: 50, street: 'flop', villainActionSizeFrac: 83 / 133, facingRaise: true,
    });
    expect(res.continueThreshold).toBeLessThanOrEqual(res.potOdds + 1e-12);
    expect(res.continueThreshold).toBeGreaterThanOrEqual((1 - MDF_RESCUE) * res.potOdds - 1e-12);
  });

  it('without a hero range the decision is pure pot odds', () => {
    const res = defendVsAggression({
      heroCards: [cid('Ah'), cid('7h')], board: flop, villainRange: villainRaiseRange,
      pot: 216, toCall: 50, street: 'flop', villainActionSizeFrac: 83 / 133,
    });
    expect(Number.isNaN(res.heroRangePercentile)).toBe(true);
    expect(res.continueThreshold).toBeCloseTo(res.potOdds, 12);
  });

  it('folds pure air facing a river overbet', () => {
    // River K-7-2-9-4. Villain overbets 1.5x pot (150 into 100) with a polarized
    // range. Hero holds 5-3: no pair, loses to every bluff (all have a higher card).
    const river = ids('Kd', '7c', '2s', '9h', '4d');
    const heroRiverRange = range(['AK', 'KQ', 'KJ', 'K9s', 'A7s', '87s', '99', '77', 'QJ', 'JT', '53s', '65s', 'T8s'], river);
    const villainOverbet = range(['99', '77', '44', 'K9s', 'K7s', '97s', 'AK', 'QJ', 'QT', 'JT', 'T8', '86s', 'A6s'], river);
    const res = defendVsAggression({
      heroCards: [cid('5c'), cid('3c')], board: river,
      heroRange: heroRiverRange, villainRange: villainOverbet,
      pot: 250, toCall: 150, street: 'river', villainActionSizeFrac: 1.5,
    });
    expect(res.mdf).toBeCloseTo(0.4, 9);
    expect(res.heroRangePercentile).toBeGreaterThan(res.mdf);
    expect(res.action).toBe('fold');
  });

  it('a nut-blocker bluff-catcher calls more river bet sizes than the same hand without the blocker', () => {
    // Three-spade river. Villain value = flushes and sets; bluffs = missed
    // non-spade broadway draws. AsKd and AhKd are the same hand at showdown (top
    // pair, ace kicker) but AsKd removes every villain flush containing the As.
    const river = ids('Ks', '8s', '4s', '7d', '2c');
    // Hero's river range: plenty of flushes, sets and two pair above the
    // one-pair bluff-catchers, plus some air, so AK sits near the MDF boundary.
    const heroRange = range([
      'AsQs', 'AsJs', 'AsTs', 'As9s', 'QsJs', 'QsTs', 'JsTs', 'Ts9s', '9s6s', '6s5s', '7s6s', '5s3s',
      '88', '44', '77', '22', 'K8s', 'K7s', '87s',
      'AK', 'KQ', 'KJ', 'KT',
      'QJo', 'JTo', 'T9o', '65o', 'A5o',
    ], river);
    const villain = range([
      // value: any two spades (flushes) and sets
      'AsQs', 'AsJs', 'AsTs', 'As9s', 'As6s', 'As5s', 'As3s', 'QsJs', 'QsTs', 'JsTs', 'Ts9s', '9s6s', '6s5s',
      '88', '44', '77',
      // bluffs: missed draws without a spade
      'QJo:0.12', 'QTo:0.12', 'JTo:0.12', 'T9o:0.12', 'J9o:0.12', 'Q9o:0.12', '65o:0.12', '63o:0.12', 'A5o:0.12', 'A3o:0.12',
    ], river);
    const blocker: [CardId, CardId] = [cid('As'), cid('Kd')];
    const plain: [CardId, CardId] = [cid('Ah'), cid('Kd')];
    expect(blockerScoreOf(blocker, villain, river)).toBeGreaterThan(blockerScoreOf(plain, villain, river));

    let callsBlocker = 0, callsPlain = 0;
    let eqB = 0, eqP = 0;
    for (let frac = 0.25; frac <= 2.5 + 1e-9; frac += 0.05) {
      const bet = Math.round(100 * frac);
      const args = { board: river, heroRange, villainRange: villain, pot: 100 + bet, toCall: bet, street: 'river' as const, villainActionSizeFrac: frac };
      const b = defendVsAggression({ heroCards: blocker, ...args });
      const p = defendVsAggression({ heroCards: plain, ...args });
      eqB = b.equity; eqP = p.equity;
      // Monotone: whenever the plain hand continues, the blocker hand does too.
      if (p.action !== 'fold') expect(b.action).not.toBe('fold');
      if (b.action !== 'fold') callsBlocker++;
      if (p.action !== 'fold') callsPlain++;
    }
    expect(eqB).toBeGreaterThan(eqP);
    expect(callsBlocker).toBeGreaterThan(callsPlain);
  });

  it('raises for value only with a clear margin and semibluffs only real draws', () => {
    const board = ids('Js', '9s', '4d');
    const villain = range(['AJ', 'KJ', 'QJ', 'JT', 'TT', '88', 'QsTs', 'Ks8s', 'A4', '54s', 'T8', '87'], board);
    const heroRange = range(['JJ', '99', '44', 'J9', 'AJ', 'KJ', 'QQ', 'As5s', 'Ts8s', 'KQ', 'A9'], board);
    const common = { board, villainRange: villain, heroRange, pot: 300, toCall: 100, street: 'flop' as const, villainActionSizeFrac: 0.5 };
    const set = defendVsAggression({ heroCards: [cid('Jh'), cid('Jd')], ...common });
    expect(set.action).toBe('raise');
    expect(set.raiseKind).toBe('value');
    const combo = defendVsAggression({ heroCards: [cid('Ts'), cid('8s')], ...common });
    expect(combo.showdownEquity).toBeLessThan(0.35);
    expect(combo.action).not.toBe('fold');
    // Top pair weak kicker is a call, never a raise.
    const tp = defendVsAggression({ heroCards: [cid('Jc'), cid('5c')], ...common });
    expect(tp.action).not.toBe('raise');
    // An all-in call cannot be a raise.
    const allin = defendVsAggression({ heroCards: [cid('Jh'), cid('Jd')], ...common, heroStack: 100 });
    expect(allin.action).toBe('call');
  });

  it('returns a neutral answer for an empty villain range instead of throwing', () => {
    const board = ids('Kd', '7c', '2s');
    const res = defendVsAggression({
      heroCards: [cid('Ah'), cid('7h')], board, villainRange: { combos: [], weights: [] },
      pot: 200, toCall: 100, street: 'flop',
    });
    expect(res.equity).toBe(0.5);
    expect(res.mdf).toBeCloseTo(0.5, 9); // derived size 100/(200-100) = 1x pot
  });
});

describe('balancedAggressorRange', () => {
  const share = (r: WeightedRange, n: number) => {
    const tot = r.weights.reduce((a, b) => a + b, 0);
    const v = r.weights.slice(0, n).reduce((a, b) => a + b, 0);
    return 1 - v / tot;
  };

  it('gives the bluff block the s/(1+2s) share on the river and more on earlier streets', () => {
    const river = ids('Kd', '7c', '2s', '9h', '4d');
    const value = combosOf('99', river).concat(combosOf('77', river), combosOf('K9s', river));
    const r = balancedAggressorRange(value, river, 'river', 1);
    expect(share(r, value.length)).toBeCloseTo(1 / 3, 9);
    const t = balancedAggressorRange(value, river.slice(0, 4), 'turn', 1);
    expect(share(t, value.length)).toBeCloseTo(1.2 / 3, 9);
  });

  it('weights flop bluffs toward draws, not random air', () => {
    const flop = ids('Js', '9s', '4d');
    const value = combosOf('JJ', flop).concat(combosOf('99', flop));
    const r = balancedAggressorRange(value, flop, 'flop', 0.75);
    const w = (a: string, b: string) => {
      const x = Math.min(cid(a), cid(b)), y = Math.max(cid(a), cid(b));
      return r.weights[r.combos.findIndex(([p, q]) => p === x && q === y)];
    };
    expect(w('Ts', '8s')).toBeGreaterThan(w('As', '5s')); // combo draw > flush draw
    expect(w('As', '5s')).toBeGreaterThan(w('Qh', 'Td'));  // flush draw > open-ender
    expect(w('Qh', 'Td')).toBeGreaterThan(w('6h', '2c'));  // open-ender > air
  });

  it('bluffPropensity: on the river no-pair hands bluff, pairs rarely', () => {
    const river = ids('Js', '9s', '4d', '2h', '7c');
    expect(bluffPropensity([cid('As'), cid('5s')], river, 'river')).toBe(1);
    expect(bluffPropensity([cid('9h'), cid('5c')], river, 'river')).toBeCloseTo(0.15, 9);
    expect(bluffPropensity([cid('Ts'), cid('8s')], ids('Js', '9s', '4d'), 'flop')).toBe(4);
  });
});

describe('barrelGate', () => {
  const river = ids('Kd', '7c', '2s', '9h', '4d');

  it('cuts a river bluff into a range that called twice with strong hands', () => {
    // Villain called flop and turn: top pair+, sets, two pair. Nothing folds to a bluff.
    const strong = range(['AK', 'KQ', 'KJ', 'KT', 'K9s', '99', '77', '22', 'K7s', '97s'], river);
    const res = barrelGate({ heroCards: [cid('6h'), cid('5h')], board: river, villainRange: strong, pot: 200, bet: 150, street: 'river', baseProbability: 0.26 });
    expect(res.foldShare).toBeLessThan(0.2);
    expect(res.probability).toBeLessThan(0.26);
  });

  it('keeps the bluff into a capped, weak range that folds a lot', () => {
    const weak = range(['QJ', 'QT', 'JT', 'T8', '86s', '65s', 'A3s', '53s', '33', '55'], river);
    const res = barrelGate({ heroCards: [cid('6h'), cid('5h')], board: river, villainRange: weak, pot: 200, bet: 150, street: 'river', baseProbability: 0.26 });
    expect(res.foldShare).toBeGreaterThan(0.5);
    expect(res.probability).toBe(0.26);
  });

  it('keeps a value bet that is ahead of the calling range', () => {
    const mixed = range(['KQ', 'KJ', 'KT', 'QJ', '98s', '87s', 'A9', 'A7s'], river);
    const res = barrelGate({ heroCards: [cid('Kh'), cid('9c')], board: river, villainRange: mixed, pot: 200, bet: 130, street: 'river', baseProbability: 0.9 });
    expect(res.equityVsContinue).toBeGreaterThan(0.5);
    expect(res.probability).toBe(0.9);
  });
});

describe('rangeFromPolicy', () => {
  it('weights combos by the policy and drops zero-weight combos', () => {
    const board = ids('Kd', '7c', '2s');
    const r = rangeFromPolicy(board, (_c, cat) => (cat >= 1 ? 1 : 0), { runouts: 20 });
    expect(r.combos.length).toBeGreaterThan(0);
    for (const [a, b] of r.combos) {
      // every kept combo pairs the board or is a pocket pair
      const ranks = [a >> 2, b >> 2];
      const boardRanks = board.map(c => c >> 2);
      expect(ranks[0] === ranks[1] || ranks.some(x => boardRanks.includes(x))).toBe(true);
    }
  });
});

describe('leadPolicyRange', () => {
  it('weights two pair+ above air and zeroes non-flush combos on a monotone board', () => {
    const dry = ids('Kd', '7c', '2s');
    const r = leadPolicyRange(dry, 'flop', { isAggressor: true, isIP: true, veryWetOrMono: false }, undefined, { runouts: 20 });
    const w = (a: string, b: string) => {
      const x = Math.min(cid(a), cid(b)), y = Math.max(cid(a), cid(b));
      const i = r.combos.findIndex(([p, q]) => p === x && q === y);
      return i < 0 ? 0 : r.weights[i];
    };
    expect(w('Kh', '7h')).toBeGreaterThan(w('6h', '3d'));
    const mono = ids('Ks', '8s', '4s');
    const m = leadPolicyRange(mono, 'flop', { isAggressor: true, isIP: true, veryWetOrMono: true }, undefined, { runouts: 20 });
    for (let i = 0; i < m.combos.length; i++) {
      const spades = m.combos[i].filter(c => c % 4 === cid('As') % 4).length;
      // On a three-spade flop only a made flush (two spades) may be bet.
      if (m.weights[i] > 0) expect(spades).toBe(2);
    }
  });
});
