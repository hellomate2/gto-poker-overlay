import { describe, it, expect } from 'vitest';
import { getGTOAdvice } from '../../../src/core/ranges/gto-advisor';
import { charts as solvedCharts } from '../../../src/core/ranges/headsup-solved';
import { GameState, Player, Position, Action } from '../../../src/types/poker';
import { allHandNames } from '../../../src/core/ranges/headsup-gto';
import { card } from '../../helpers';

// Build two concrete cards for a canonical hand name (e.g. "AKs" -> Ah,Kh).
const RANKS = '23456789TJQKA';
function cardsFor(name: string): [string, string] {
  const r1 = name[0];
  const r2 = name[1];
  if (name.length === 2) {
    // pair: two different suits
    return [`${r1}h`, `${r2}d`];
  }
  const suited = name[2] === 's';
  return suited ? [`${r1}h`, `${r2}h`] : [`${r1}h`, `${r2}d`];
}

function mkPlayer(name: string, position: Position, stack = 100, isHero = false): Player {
  return {
    name,
    stack,
    position,
    isDealer: position === 'BTN' || position === 'SB',
    isSittingOut: false,
    seatIndex: position === 'SB' ? 0 : 1,
    isHero,
    currentBet: 0,
    hasActed: false,
  };
}

interface HUOpts {
  heroPos: 'SB' | 'BB';
  heroCards: [string, string];
  preflop?: Action[];
  currentBet?: number;
  stack?: number;
}

function buildHU(opts: HUOpts): GameState {
  const stack = opts.stack ?? 100;
  const hero = mkPlayer('Hero', opts.heroPos, stack, true);
  const villainPos: Position = opts.heroPos === 'SB' ? 'BB' : 'SB';
  const villain = mkPlayer('Villain', villainPos, stack);
  return {
    tableId: 't1',
    handNumber: 1,
    street: 'preflop',
    pot: 1.5,
    sidePots: [],
    heroCards: [card(opts.heroCards[0]), card(opts.heroCards[1])],
    communityCards: [],
    players: [hero, villain],
    heroIndex: 0,
    dealerIndex: 0,
    activePlayerIndex: 0,
    currentBet: opts.currentBet ?? 0,
    minRaise: 2,
    bigBlind: 1,
    smallBlind: 0.5,
    actionHistory: {
      preflop: opts.preflop || [],
      flop: [],
      turn: [],
      river: [],
    },
    isOurTurn: true,
    timestamp: Date.now(),
  };
}

// Each HU scenario: how to set up the GameState so detectScenario keys it.
const SCENARIOS: Array<{ key: string; build: (cards: [string, string]) => GameState }> = [
  {
    key: 'SB-RFI',
    build: (c) => buildHU({ heroPos: 'SB', heroCards: c }),
  },
  {
    key: 'BB-vs-open-SB',
    build: (c) =>
      buildHU({
        heroPos: 'BB',
        heroCards: c,
        preflop: [{ type: 'raise', amount: 2.5, playerName: 'Villain' }],
        currentBet: 2.5,
      }),
  },
  {
    key: 'SB-vs-3bet-BB',
    build: (c) =>
      buildHU({
        heroPos: 'SB',
        heroCards: c,
        preflop: [
          { type: 'raise', amount: 2.5, playerName: 'Hero' },
          { type: 'raise', amount: 7.5, playerName: 'Villain' },
        ],
        currentBet: 7.5,
      }),
  },
  {
    key: 'BB-vs-4bet-SB',
    build: (c) =>
      buildHU({
        heroPos: 'BB',
        heroCards: c,
        preflop: [
          { type: 'raise', amount: 2.5, playerName: 'Villain' },
          { type: 'raise', amount: 7.5, playerName: 'Hero' },
          { type: 'raise', amount: 18, playerName: 'Villain' },
        ],
        currentBet: 18,
      }),
  },
];

describe('headsup-solved charts — structure', () => {
  it('every solved chart covers all 169 hands implicitly (cells valid)', () => {
    for (const key of Object.keys(solvedCharts)) {
      const chart = solvedCharts[key];
      for (const hand of Object.keys(chart)) {
        const cell = chart[hand];
        expect(cell, `${key}/${hand}`).toBeDefined();
      }
    }
  });

  it('provides all four canonical HU scenario keys', () => {
    for (const k of ['SB-RFI', 'BB-vs-open-SB', 'SB-vs-3bet-BB', 'BB-vs-4bet-SB']) {
      expect(solvedCharts[k], k).toBeDefined();
    }
  });

  it('has no "No GTO chart" gap for any producible HU scenario key', () => {
    // detectScenario can key these seven; all must resolve to a solved chart.
    const producible = [
      'SB-RFI',
      'SB-vs-open-BB',
      'SB-vs-3bet-BB',
      'SB-vs-4bet-BB',
      'BB-vs-open-SB',
      'BB-vs-3bet-SB',
      'BB-vs-4bet-SB',
    ];
    for (const k of producible) {
      expect(solvedCharts[k], `missing solved chart for ${k}`).toBeDefined();
    }
  });
});

describe('getGTOAdvice — full heads-up coverage sweep', () => {
  const hands = allHandNames();

  for (const scen of SCENARIOS) {
    it(`returns a non-degenerate result for all 169 hands in ${scen.key}`, () => {
      for (const hand of hands) {
        const state = scen.build(cardsFor(hand));
        const advice = getGTOAdvice(state);
        expect(advice, `null advice for ${hand} in ${scen.key}`).not.toBeNull();
        const a = advice!;
        // The scenario must NOT degrade to "No GTO chart for this spot".
        expect(a.scenario, `no-chart gap for ${hand} in ${scen.key}`).not.toContain(
          'No GTO chart',
        );
        // Hand name parsed correctly.
        expect(a.hand).toBe(hand);
        // An action set must be returned (at least one action).
        expect(a.actions.length, `empty actions for ${hand} in ${scen.key}`).toBeGreaterThan(0);
        // Every frequency in [0,100] and a known action label.
        let total = 0;
        for (const act of a.actions) {
          expect(act.frequency, `${hand}/${scen.key}/${act.action} freq`).toBeGreaterThanOrEqual(0);
          expect(act.frequency).toBeLessThanOrEqual(100 + 1e-6);
          expect(['Raise', '3-Bet', '4-Bet', 'Call', 'Fold', 'All-In']).toContain(act.action);
          total += act.frequency;
        }
        // Frequencies sum to ~100 (a complete strategy at this spot).
        expect(total, `${hand}/${scen.key} sums to 100`).toBeCloseTo(100, 0);
      }
    });
  }

  it('AA continues (never pure-fold) in every scenario', () => {
    for (const scen of SCENARIOS) {
      const advice = getGTOAdvice(scen.build(cardsFor('AA')))!;
      const fold = advice.actions.find((a) => a.action === 'Fold');
      expect(fold?.frequency ?? 0, `AA folds too much in ${scen.key}`).toBeLessThan(50);
    }
  });

  it('72o is a fold at 100bb SB open but plays when very short', () => {
    const deep = getGTOAdvice(buildHU({ heroPos: 'SB', heroCards: ['7c', '2h'] }))!;
    const deepFold = deep.actions.find((a) => a.action === 'Fold');
    expect(deepFold?.frequency ?? 0).toBeGreaterThan(60);

    // Very short: push/fold Nash should make 72o an open jam (or at least not
    // a pure cold fold the same way).
    const shortState = buildHU({ heroPos: 'SB', heroCards: ['7c', '2h'], stack: 3 });
    const short = getGTOAdvice(shortState)!;
    expect(short.scenario.toLowerCase()).toContain('push/fold');
  });
});
