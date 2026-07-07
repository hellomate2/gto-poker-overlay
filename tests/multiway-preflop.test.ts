import { describe, it, expect } from 'vitest';
import { getGTOAdvice } from '../src/core/ranges/gto-advisor';
import { GameState, Player, Position, Card } from '../src/types/poker';
import { card } from './helpers';

// ============================================================
// REGRESSION: when the preflop core was rebuilt on the deterministic HU engine,
// the advisor routed EVERY table through the HU charts — so at a 6-max table
// UTG "opened" the 78%-wide HU button range (K3o UTG raise = spew). Multiway
// must consume the hand-tuned 6-max packs, not the HU ranges.
// ============================================================

function mkP(name: string, pos: Position, seat: number, hero = false): Player {
  return {
    name, stack: 2000, position: pos, isDealer: pos === 'BTN', isSittingOut: false,
    seatIndex: seat, isHero: hero,
    currentBet: pos === 'SB' ? 10 : pos === 'BB' ? 20 : 0, hasActed: false,
  };
}

/** 6-max table, hero UTG first to act (unopened pot). */
function utgSpot(hole: [string, string]): GameState {
  return {
    tableId: 't', handNumber: 1, street: 'preflop', pot: 30, sidePots: [],
    heroCards: [card(hole[0]), card(hole[1])], communityCards: [],
    players: [
      mkP('hero', 'UTG', 0, true), mkP('a', 'MP', 1), mkP('b', 'CO', 2),
      mkP('c', 'BTN', 3), mkP('d', 'SB', 4), mkP('e', 'BB', 5),
    ],
    heroIndex: 0, dealerIndex: 3, activePlayerIndex: 0,
    currentBet: 20, minRaise: 40, bigBlind: 20, smallBlind: 10,
    actionHistory: { preflop: [], flop: [], turn: [], river: [] },
    isOurTurn: true, timestamp: 1,
  };
}

const top = (h: [string, string]) => getGTOAdvice(utgSpot(h))!.actions[0];

describe('multiway preflop uses 6-max packs, not the HU engine', () => {
  it('UTG folds the trash the HU button would open (K3o, 95o, J6o)', () => {
    for (const h of [['Kh', '3c'], ['9h', '5c'], ['Jh', '6c']] as [string, string][]) {
      expect(top(h).action, `${h.join('')} must fold UTG`).toBe('Fold');
    }
  });

  it('UTG still opens real hands (AA, AQs, TT)', () => {
    for (const h of [['Ah', 'Ad'], ['Ah', 'Qs'], ['Th', 'Td']] as [string, string][]) {
      expect(top(h).action, `${h.join('')} must raise UTG`).toBe('Raise');
    }
  });

  it('every advice action list is non-empty and frequencies are sane', () => {
    for (const h of [['Kh', '3c'], ['Ah', 'Ad'], ['7h', '6h'], ['Qh', 'Jd']] as [string, string][]) {
      const a = getGTOAdvice(utgSpot(h))!;
      expect(a.actions.length).toBeGreaterThan(0);
      for (const act of a.actions) {
        expect(act.frequency).toBeGreaterThan(0);
        expect(act.frequency).toBeLessThanOrEqual(100);
      }
    }
  });
});
