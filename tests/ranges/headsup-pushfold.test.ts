import { describe, it, expect } from 'vitest';
import { getGTOAdvice } from '../../src/core/ranges/gto-advisor';
import { charts as headsupCharts, allHandNames } from '../../src/core/ranges/headsup-gto';
import {
  shoveRange,
  callRange,
  MAX_PUSHFOLD_BB,
  MIN_PUSHFOLD_BB,
} from '../../src/core/ranges/pushfold-nash';
import { GameState, Player, Position, Action, Street } from '../../src/types/poker';
import { card } from '../helpers';

function mkPlayer(name: string, position: Position, stack: number, isHero = false): Player {
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

interface BuildOpts {
  heroPos: Position;
  heroCards: [string, string];
  heroStack?: number;
  bigBlind?: number;
  others?: Player[];
  preflop?: Action[];
  street?: Street;
}

function buildState(opts: BuildOpts): GameState {
  const bb = opts.bigBlind ?? 1;
  const hero = mkPlayer('Hero', opts.heroPos, opts.heroStack ?? 100, true);
  const players = [hero, ...(opts.others || [])];
  return {
    tableId: 't1',
    handNumber: 1,
    street: opts.street || 'preflop',
    pot: bb * 1.5,
    sidePots: [],
    heroCards: [card(opts.heroCards[0]), card(opts.heroCards[1])],
    communityCards: [],
    players,
    heroIndex: 0,
    dealerIndex: 0,
    activePlayerIndex: 0,
    currentBet: 0,
    minRaise: bb * 2,
    bigBlind: bb,
    smallBlind: bb / 2,
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

// ============================================================
// Push/Fold Nash range structural properties
// ============================================================

describe('pushfold-nash — range contents', () => {
  it('AA is in every shove range across all stack depths', () => {
    for (let bb = MIN_PUSHFOLD_BB; bb <= MAX_PUSHFOLD_BB; bb++) {
      expect(shoveRange(bb).has('AA')).toBe(true);
    }
  });

  it('AA is in every call range across all stack depths', () => {
    for (let bb = MIN_PUSHFOLD_BB; bb <= MAX_PUSHFOLD_BB; bb++) {
      expect(callRange(bb).has('AA')).toBe(true);
    }
  });

  it('72o is NOT a shove at deep (100bb) but IS an SB jam at 2bb', () => {
    // At 100bb (clamped to max table depth) 72o should not be jammed.
    expect(shoveRange(100).has('72o')).toBe(false);
    // At 2bb the SB jams essentially any two cards including 72o.
    expect(shoveRange(2).has('72o')).toBe(true);
  });

  it('shove ranges are monotonic: 5bb range is a superset of 15bb range', () => {
    const deep = shoveRange(15);
    const short = shoveRange(5);
    for (const h of deep) {
      expect(short.has(h)).toBe(true);
    }
    // And strictly wider (short stack jams more hands).
    expect(short.size).toBeGreaterThan(deep.size);
  });

  it('call ranges are monotonic: shorter stack is a superset', () => {
    const deep = callRange(15);
    const short = callRange(5);
    for (const h of deep) {
      expect(short.has(h)).toBe(true);
    }
    expect(short.size).toBeGreaterThanOrEqual(deep.size);
  });

  it('shove range is at least as wide as the call range at the same depth', () => {
    for (const bb of [3, 8, 15]) {
      expect(shoveRange(bb).size).toBeGreaterThanOrEqual(callRange(bb).size);
    }
  });
});

// ============================================================
// Heads-up chart structural properties
// ============================================================

describe('headsup-gto — charts', () => {
  it("HU 'SB-RFI' opens more than 70% of all hands", () => {
    const chart = headsupCharts['SB-RFI'];
    expect(chart).toBeTruthy();
    const all = allHandNames();
    let raiseFreq = 0;
    for (const h of all) {
      const cell = chart[h];
      if (cell === 'raise') raiseFreq += 1;
      else if (Array.isArray(cell)) raiseFreq += 0.5; // ['raise','fold']
    }
    const pct = (raiseFreq / all.length) * 100;
    expect(pct).toBeGreaterThan(70);
  });

  it('exposes the three expected heads-up keys', () => {
    expect(headsupCharts['SB-RFI']).toBeTruthy();
    expect(headsupCharts['BB-vs-open-SB']).toBeTruthy();
    expect(headsupCharts['SB-vs-3bet-BB']).toBeTruthy();
  });

  it('allHandNames returns all 169 canonical hands', () => {
    expect(new Set(allHandNames()).size).toBe(169);
  });
});

// ============================================================
// getGTOAdvice integration — heads-up + push/fold
// ============================================================

describe('getGTOAdvice — heads-up integration', () => {
  it('returns a heads-up label on a 2-handed deep-stacked spot', () => {
    // Deep stacks (100bb) so the push/fold override does not fire.
    const villain = mkPlayer('Villain', 'BB', 100);
    const state = buildState({
      heroPos: 'SB',
      heroCards: ['Ah', 'Kd'],
      heroStack: 100,
      others: [villain],
    });
    const advice = getGTOAdvice(state)!;
    expect(advice).not.toBeNull();
    expect(advice.scenario).toMatch(/HU/);
  });

  it('a short-stack 2-handed AA spot recommends an all-in jam', () => {
    const villain = mkPlayer('Villain', 'BB', 10);
    const state = buildState({
      heroPos: 'SB',
      heroCards: ['Ah', 'Ad'],
      heroStack: 10, // 10bb effective
      others: [villain],
    });
    const advice = getGTOAdvice(state)!;
    expect(advice).not.toBeNull();
    expect(advice.hand).toBe('AA');
    expect(advice.actions[0].action).toBe('All-In');
    expect(advice.inRange).toBe(true);
  });

  it('a short-stack 2-handed AA facing a jam recommends calling all-in', () => {
    const villain = mkPlayer('Villain', 'SB', 12);
    const preflop: Action[] = [{ type: 'allin', amount: 12, playerName: 'Villain' }];
    const state = buildState({
      heroPos: 'BB',
      heroCards: ['As', 'Ac'],
      heroStack: 12,
      others: [villain],
      preflop,
    });
    const advice = getGTOAdvice(state)!;
    expect(advice.actions[0].action).toBe('All-In');
    expect(advice.inRange).toBe(true);
  });
});
