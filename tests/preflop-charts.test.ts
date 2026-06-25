import { describe, it, expect } from 'vitest';
import {
  charts as solvedCharts,
} from '../src/core/ranges/headsup-solved';
import type { Cell, Chart } from '../src/core/ranges/greenline-gto';
import {
  shoveRange,
  callRange,
  isShove,
  isCall,
  MIN_PUSHFOLD_BB,
  MAX_PUSHFOLD_BB,
} from '../src/core/ranges/pushfold-nash';
import { getGTOAdvice } from '../src/core/ranges/gto-advisor';
import { GameState, Player, Position, Action } from '../src/types/poker';
import { card } from './helpers';

// ============================================================
// Helpers: hand enumeration + cell -> distribution.
// ============================================================

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;

/** All 169 canonical hand names (e.g. 'AA', 'AKs', 'T9o'). */
function all169(): string[] {
  const names: string[] = [];
  for (let i = RANKS.length - 1; i >= 0; i--) {
    for (let j = RANKS.length - 1; j >= 0; j--) {
      if (i === j) names.push(`${RANKS[i]}${RANKS[j]}`);
      else if (i > j) names.push(`${RANKS[i]}${RANKS[j]}s`);
      else names.push(`${RANKS[j]}${RANKS[i]}o`);
    }
  }
  return names;
}

/** Combinatorial weight of a hand group (pairs=6, suited=4, offsuit=12). */
function comboWeight(hand: string): number {
  if (hand.length === 2) return 6; // pair
  return hand.endsWith('s') ? 4 : 12;
}

interface Dist {
  weight: number; // non-fold percentage of the cell (0..100)
  actions: Record<string, number>; // sums to ~100 over the non-fold mass
}

/** Normalize a chart Cell into { weight, actions } exactly like the advisor. */
function normalizeCell(cell: Cell): Dist {
  if (typeof cell === 'string') {
    return { weight: 100, actions: { [cell]: 100 } };
  }
  if (Array.isArray(cell)) {
    const [a, b] = cell;
    if (a === b) return { weight: 100, actions: { [a]: 100 } };
    return { weight: 100, actions: { [a]: 50, [b]: 50 } };
  }
  return { weight: cell.weight, actions: { ...cell.actions } as Record<string, number> };
}

/**
 * Combinatorially-weighted "non-fold width" of a chart: the fraction of all
 * 1326 starting-hand combos that are NOT a pure fold, weighting each cell by
 * its non-fold mass (weight/100). Hands absent from a chart are pure folds.
 */
function nonFoldWidth(chart: Chart): number {
  let played = 0;
  let total = 0;
  for (const hand of all169()) {
    const w = comboWeight(hand);
    total += w;
    const cell = chart[hand];
    if (!cell) continue; // absent = fold
    const norm = normalizeCell(cell);
    played += w * (norm.weight / 100);
  }
  return played / total;
}

// ============================================================
// TASK 1 — SHIPPED HEADS-UP SOLVED CHARTS
// ============================================================

describe('headsup-solved.ts — shipped equilibrium widths', () => {
  it('SB-RFI non-fold width is in the shipped tight band [0.78, 0.90]', () => {
    const w = nonFoldWidth(solvedCharts['SB-RFI']);
    // Reported in the file header as ~81.4% open freq.
    expect(w).toBeGreaterThanOrEqual(0.78);
    expect(w).toBeLessThanOrEqual(0.9);
  });

  it('BB-vs-open-SB defend width is >= 0.68', () => {
    const w = nonFoldWidth(solvedCharts['BB-vs-open-SB']);
    // Reported in the file header as ~73.6% defend freq.
    expect(w).toBeGreaterThanOrEqual(0.68);
  });
});

describe('headsup-solved.ts — specific hands match GTO direction', () => {
  const sbRfi = solvedCharts['SB-RFI'];

  it('J9o/K9o/Q9o/53s/86s/T9s all OPEN (raise) in SB-RFI', () => {
    for (const hand of ['J9o', 'K9o', 'Q9o', '53s', '86s', 'T9s']) {
      const cell = sbRfi[hand];
      expect(cell, `${hand} should be present in SB-RFI`).toBeDefined();
      const norm = normalizeCell(cell);
      // Raise is the only non-fold action in SB-RFI cells.
      expect(norm.actions.raise ?? 0, `${hand} should raise`).toBeGreaterThan(0);
      // Non-trivially in the open range (not a token frequency).
      expect(norm.weight, `${hand} open weight`).toBeGreaterThan(50);
    }
  });

  it('72o folds the large majority in SB-RFI', () => {
    const cell = sbRfi['72o'];
    expect(cell).toBeDefined();
    const norm = normalizeCell(cell);
    // weight is the non-fold %; folding majority => weight < 50.
    expect(norm.weight).toBeLessThan(50);
  });

  it('AA/KK/AKs are a RAISE (3-bet) with ~0 all-in in BB-vs-open-SB', () => {
    const chart = solvedCharts['BB-vs-open-SB'];
    for (const hand of ['AA', 'KK', 'AKs']) {
      const norm = normalizeCell(chart[hand]);
      expect(norm.actions.raise ?? 0, `${hand} raise%`).toBeGreaterThan(50);
      expect(norm.actions.allin ?? 0, `${hand} allin% ~0`).toBe(0);
      expect(norm.weight, `${hand} never folds`).toBe(100);
    }
  });

  it('AA/KK/AKs are a RAISE with ~0 all-in in SB-vs-3bet-BB', () => {
    const chart = solvedCharts['SB-vs-3bet-BB'];
    for (const hand of ['AA', 'KK', 'AKs']) {
      const norm = normalizeCell(chart[hand]);
      expect(norm.actions.raise ?? 0, `${hand} raise%`).toBeGreaterThan(0);
      expect(norm.actions.allin ?? 0, `${hand} allin% ~0`).toBe(0);
      expect(norm.weight, `${hand} never folds`).toBe(100);
    }
  });

  it('premiums (AA/KK/QQ/AKs) never fold to a 3-bet (SB-vs-3bet-BB weight=100)', () => {
    const chart = solvedCharts['SB-vs-3bet-BB'];
    for (const hand of ['AA', 'KK', 'QQ', 'AKs']) {
      const norm = normalizeCell(chart[hand]);
      expect(norm.weight, `${hand} continues 100%`).toBe(100);
    }
  });
});

describe('headsup-solved.ts — every cell is a valid distribution', () => {
  it('all cells: freqs in [0,100], non-fold mass sums to ~100', () => {
    for (const [key, chart] of Object.entries(solvedCharts)) {
      for (const [hand, cell] of Object.entries(chart)) {
        const norm = normalizeCell(cell);
        expect(norm.weight, `${key}/${hand} weight in [0,100]`).toBeGreaterThanOrEqual(0);
        expect(norm.weight, `${key}/${hand} weight in [0,100]`).toBeLessThanOrEqual(100);
        let sum = 0;
        for (const [act, freq] of Object.entries(norm.actions)) {
          expect(freq, `${key}/${hand}/${act} freq in [0,100]`).toBeGreaterThanOrEqual(0);
          expect(freq, `${key}/${hand}/${act} freq in [0,100]`).toBeLessThanOrEqual(100);
          sum += freq;
        }
        // The non-fold action frequencies are normalized to ~100 within the cell.
        expect(sum, `${key}/${hand} action freqs sum`).toBeCloseTo(100, 1);
      }
    }
  });
});

// ============================================================
// TASK 1 — COVERAGE: sweep all 169 hands x every HU scenario.
//
// We build a heads-up GameState and exercise getGTOAdvice across the producible
// HU scenarios. To force the advisor down the open-raise/3bet charts (not the
// short-stack push/fold override), we use a deep effective stack (200bb) and
// drive scenario detection via currentBet sizing (see detectScenario's
// bet-size inference: ~2.5bb=open, ~6bb=3bet, ~13bb=4bet).
// ============================================================

function handToCards(hand: string): [string, string] {
  // Map a canonical hand name to two concrete cards (suits chosen to match s/o).
  const r1 = hand[0];
  const r2 = hand[1];
  if (hand.length === 2) {
    // pair -> two suits
    return [`${r1}h`, `${r2}d`];
  }
  const suited = hand.endsWith('s');
  return suited ? [`${r1}h`, `${r2}h`] : [`${r1}h`, `${r2}d`];
}

function mkPlayer(name: string, position: Position, isHero = false, stack = 200): Player {
  return {
    name,
    stack,
    position,
    isDealer: position === 'BTN' || position === 'SB',
    isSittingOut: false,
    seatIndex: 0,
    isHero,
    currentBet: 0,
    hasActed: false,
  };
}

interface HUSpot {
  heroPos: Position; // SB or BB (heads-up)
  villainPos: Position;
  currentBet: number; // in chips; bb = 1
  preflop: Action[];
  expectScenarioContains: string; // substring expected in the produced scenario label/key path
}

/**
 * Build a 2-handed (heads-up) state at 200bb so the push/fold override never
 * fires and the solved open-raise charts are consulted.
 */
function buildHU(spot: HUSpot, heroCards: [string, string]): GameState {
  const hero = mkPlayer('Hero', spot.heroPos, true);
  const villain = mkPlayer('Villain', spot.villainPos, false);
  return {
    tableId: 't1',
    handNumber: 1,
    street: 'preflop',
    pot: 1.5,
    sidePots: [],
    heroCards: [card(heroCards[0]), card(heroCards[1])],
    communityCards: [],
    players: [hero, villain],
    heroIndex: 0,
    dealerIndex: 0,
    activePlayerIndex: 0,
    currentBet: spot.currentBet,
    minRaise: 2,
    bigBlind: 1,
    smallBlind: 0.5,
    actionHistory: { preflop: spot.preflop, flop: [], turn: [], river: [] },
    isOurTurn: true,
    timestamp: Date.now(),
  };
}

describe('headsup-solved.ts — full 169-hand coverage across HU scenarios', () => {
  // Each spot is constructed so detectScenario lands on a solved HU chart.
  // 200bb effective -> push/fold override disabled.
  const spots: HUSpot[] = [
    {
      // SB open, unopened pot, no raises -> SB-RFI
      heroPos: 'SB',
      villainPos: 'BB',
      currentBet: 1, // just the BB posted
      preflop: [],
      expectScenarioContains: 'RFI',
    },
    {
      // BB facing an SB open (~2.5bb) -> BB-vs-open-SB
      heroPos: 'BB',
      villainPos: 'SB',
      currentBet: 2.5,
      preflop: [{ type: 'raise', amount: 2.5, playerName: 'Villain' }],
      expectScenarioContains: 'vs',
    },
    {
      // SB opened, BB 3-bet (~6bb) -> SB-vs-3bet-BB
      heroPos: 'SB',
      villainPos: 'BB',
      currentBet: 6,
      preflop: [
        { type: 'raise', amount: 2.5, playerName: 'Hero' },
        { type: 'raise', amount: 6, playerName: 'Villain' },
      ],
      expectScenarioContains: '3-Bet',
    },
    {
      // BB 3-bet, SB 4-bet (~13bb) -> BB-vs-4bet-SB
      heroPos: 'BB',
      villainPos: 'SB',
      currentBet: 13,
      preflop: [
        { type: 'raise', amount: 2.5, playerName: 'Villain' },
        { type: 'raise', amount: 6, playerName: 'Hero' },
        { type: 'raise', amount: 13, playerName: 'Villain' },
      ],
      expectScenarioContains: '4-Bet',
    },
  ];

  const validActions = new Set(['Raise', '3-Bet', '4-Bet', 'Call', 'Fold', 'All-In']);

  for (const spot of spots) {
    it(`every hand has a defined in-range action (heroPos=${spot.heroPos}, bet=${spot.currentBet})`, () => {
      let noChartCount = 0;
      for (const hand of all169()) {
        const cards = handToCards(hand);
        const state = buildHU(spot, cards);
        const advice = getGTOAdvice(state);
        expect(advice, `${hand}: advice non-null`).not.toBeNull();
        const a = advice!;
        // No "No GTO chart" gaps.
        expect(
          a.scenario.includes('No GTO chart'),
          `${hand}: scenario was "${a.scenario}" (gap)`,
        ).toBe(false);
        if (a.scenario.includes('No GTO chart')) noChartCount++;
        // At least one action, every action label is valid, freqs sum ~100.
        expect(a.actions.length, `${hand}: has >=1 action`).toBeGreaterThan(0);
        let sum = 0;
        for (const act of a.actions) {
          expect(validActions.has(act.action), `${hand}: action "${act.action}" valid`).toBe(true);
          expect(act.frequency).toBeGreaterThanOrEqual(0);
          expect(act.frequency).toBeLessThanOrEqual(100);
          sum += act.frequency;
        }
        expect(sum, `${hand}: freqs sum ~100`).toBeCloseTo(100, 1);
      }
      expect(noChartCount).toBe(0);
    });
  }
});

// ============================================================
// TASK 2 — PUSH/FOLD NASH (pushfold-nash.ts)
//
// Source: HeadsUp Push/Fold Nash equilibrium charts (HoldemResources /
// SnapShove), and Sklansky-Chubukov unexploitable jam ordering, as cited in
// the file header. Premiums always jam/call; trash only enters near 2bb.
// ============================================================

describe('pushfold-nash.ts — Nash jam/call ranges', () => {
  it('AA is in every shove range across the supported stack band', () => {
    for (let s = MIN_PUSHFOLD_BB; s <= MAX_PUSHFOLD_BB; s++) {
      expect(isShove('AA', s), `AA shove at ${s}bb`).toBe(true);
      expect(shoveRange(s).has('AA')).toBe(true);
    }
  });

  it('AA is in every call range across the supported stack band', () => {
    for (let s = MIN_PUSHFOLD_BB; s <= MAX_PUSHFOLD_BB; s++) {
      expect(isCall('AA', s), `AA call at ${s}bb`).toBe(true);
      expect(callRange(s).has('AA')).toBe(true);
    }
  });

  it('72o folds deep (15bb) but jams when very short (~2bb)', () => {
    expect(isShove('72o', 15)).toBe(false);
    expect(isShove('72o', 2)).toBe(true);
  });

  it('shove ranges are monotonic: shorter stacks are supersets of deeper ones', () => {
    for (let s = MIN_PUSHFOLD_BB; s < MAX_PUSHFOLD_BB; s++) {
      const shorter = shoveRange(s);
      const deeper = shoveRange(s + 1);
      for (const h of deeper) {
        expect(shorter.has(h), `shove ${h}: ${s}bb superset of ${s + 1}bb`).toBe(true);
      }
      expect(shorter.size).toBeGreaterThanOrEqual(deeper.size);
    }
  });

  it('call ranges are monotonic: shorter stacks are supersets of deeper ones', () => {
    for (let s = MIN_PUSHFOLD_BB; s < MAX_PUSHFOLD_BB; s++) {
      const shorter = callRange(s);
      const deeper = callRange(s + 1);
      for (const h of deeper) {
        expect(shorter.has(h), `call ${h}: ${s}bb superset of ${s + 1}bb`).toBe(true);
      }
      expect(shorter.size).toBeGreaterThanOrEqual(deeper.size);
    }
  });

  it('known thresholds are directionally correct', () => {
    // At 10bb HU, the SB jams a wide range (more than half of all 169 hands).
    const wide = shoveRange(10);
    expect(wide.size).toBeGreaterThan(84); // > 50% of 169 (measured 98)

    // At 2bb, the jam range is any-two (complete).
    const veryShort = shoveRange(2);
    expect(veryShort.size).toBe(169);

    // Calling ranges are tighter than shoving ranges at the same depth.
    expect(callRange(10).size).toBeLessThan(shoveRange(10).size);

    // A strong-but-not-premium offsuit ace jams deeper than a weak one.
    expect(isShove('A9o', 25)).toBe(true); // A9o threshold 25
    expect(isShove('A2o', 25)).toBe(false); // A2o threshold 19, folds at 25

    // Big suited connectors jam deeper than small offsuit junk.
    expect(isShove('K9s', 25)).toBe(true);
    expect(isShove('K2o', 25)).toBe(false);
  });

  it('ranges clamp outside the supported band (deep stacks reuse the deepest grid)', () => {
    // Above MAX, behavior equals MAX (clamped).
    expect(shoveRange(100).size).toBe(shoveRange(MAX_PUSHFOLD_BB).size);
    // Below MIN, behavior equals MIN.
    expect(shoveRange(0.5).size).toBe(shoveRange(MIN_PUSHFOLD_BB).size);
  });
});
