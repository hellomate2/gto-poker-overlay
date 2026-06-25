import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Deterministic sampling so the chart's mixed cells (which include polarized
// "all-in" actions) are exercised; the fix must size them down when deep.
beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0.99); });
afterEach(() => { vi.restoreAllMocks(); });

vi.mock('../src/storage/db', async () => {
  const actual = await vi.importActual<typeof import('../src/storage/db')>('../src/storage/db');
  return { ...actual, getPlayerStats: async () => null, savePlayerStats: async () => {} };
});

import { DecisionEngine } from '../src/core/engine';
import { GameState, Player, Position } from '../src/types/poker';
import { card } from './helpers';

function mkP(name: string, pos: Position, stack: number, currentBet: number, isHero: boolean): Player {
  return { name, stack, position: pos, isDealer: pos === 'SB', isSittingOut: false,
    seatIndex: pos === 'SB' ? 0 : 1, isHero, currentBet, hasActed: true };
}

/** Hero in the BB facing an SB open to `openTo`, both `stackBB` deep. */
function bbVsOpen(hole: [string, string], stackBB: number, openTo = 50): GameState {
  const bb = 20;
  const hero = mkP('Hero', 'BB', stackBB * bb - bb, bb, true);       // posted BB
  const vill = mkP('Villain', 'SB', stackBB * bb - openTo, openTo, false); // opened
  return {
    tableId: 't', handNumber: 1, street: 'preflop', pot: openTo + bb, sidePots: [],
    heroCards: [card(hole[0]), card(hole[1])], communityCards: [],
    players: [hero, vill], heroIndex: 0, dealerIndex: 1, activePlayerIndex: 0,
    currentBet: openTo, minRaise: 2 * openTo, bigBlind: bb, smallBlind: 10,
    actionHistory: { preflop: [{ type: 'raise', amount: openTo, playerName: 'Villain' }], flop: [], turn: [], river: [] },
    isOurTurn: true, timestamp: Date.now(),
  };
}

describe('preflop never jams deep (sized 3-bets, not shoves)', () => {
  const hands: [string, string][] = [
    ['Ah', '6c'], ['Ah', '3c'], ['Kh', 'Jc'], ['7h', '6h'],   // the trashy "why is it jamming" hands
    ['Ah', 'As'], ['Kh', 'Ks'], ['Qh', 'Qs'], ['Th', '9h'],   // strong hands also must not SHOVE deep
  ];

  it('100bb deep, BB facing an open: NEVER returns an all-in (sizes a 3-bet or folds)', async () => {
    for (const h of hands) {
      const d = await new DecisionEngine().decide(bbVsOpen(h, 100));
      expect(d.action, `${h} should not jam 100bb deep`).not.toBe('allin');
      if (d.action === 'raise') expect(d.amount!).toBeLessThan(100 * 20 * 0.6); // a 3-bet, not a stack-off size
    }
  });

  it('~48bb deep (the reported spot): A6o / A3o do NOT shove', async () => {
    for (const h of [['Ah', '6c'], ['Ah', '3c']] as [string, string][]) {
      const d = await new DecisionEngine().decide(bbVsOpen(h, 48));
      expect(d.action, `${h} should not jam 48bb`).not.toBe('allin');
    }
  });

  it('short (12bb): the push/fold game CAN jam (premiums shove)', async () => {
    // At 12bb a wide jam range is correct; AA must be willing to get it in.
    const d = await new DecisionEngine().decide(bbVsOpen(['Ah', 'As'], 12));
    expect(['allin', 'raise', 'call']).toContain(d.action); // not a fold; short-stack play allowed to jam
  });
});
