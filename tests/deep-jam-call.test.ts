import { describe, it, expect } from 'vitest';
import { getGTOAdvice } from '../src/core/ranges/gto-advisor';
import { GameState, Player, Position, Action } from '../src/types/poker';
import { card } from './helpers';

// ============================================================
// Reported blunder: facing a ~48bb all-in 3-bet, the bot CALLED OFF the stack
// with T9s (it read the jam as a normal 3-bet and used the chart's "call").
// Facing a jam is call-or-fold: short (<=25bb) uses the wide Nash range; deep
// (>25bb) uses a tight premium stack-off range. T9s must FOLD a deep jam.
// ============================================================

function mkP(name: string, pos: Position, stack: number, currentBet: number, isHero: boolean): Player {
  return { name, stack, position: pos, isDealer: pos === 'SB', isSittingOut: false,
    seatIndex: pos === 'SB' ? 0 : 1, isHero, currentBet, hasActed: true };
}

/** HU spot: hero (SB/button) opened to `open`, villain (BB) made it `villBet`. */
function facingRaise(hole: [string, string], opts: {
  heroStack: number; heroBet: number; villStack: number; villBet: number; villAllIn: boolean;
}): GameState {
  const hero = mkP('Hero', 'SB', opts.heroStack, opts.heroBet, true);
  const vill = mkP('Villain', 'BB', opts.villStack, opts.villBet, false);
  const pf: Action[] = [
    { type: 'raise', amount: opts.heroBet, playerName: 'Hero' },
    { type: opts.villAllIn ? 'allin' : 'raise', amount: opts.villBet, playerName: 'Villain' },
  ];
  return {
    tableId: 't', handNumber: 1, street: 'preflop', pot: opts.heroBet + opts.villBet, sidePots: [],
    heroCards: [card(hole[0]), card(hole[1])], communityCards: [],
    players: [hero, vill], heroIndex: 0, dealerIndex: 0, activePlayerIndex: 0,
    currentBet: opts.villBet, minRaise: 40, bigBlind: 20, smallBlind: 10,
    actionHistory: { preflop: pf, flop: [], turn: [], river: [] },
    isOurTurn: true, timestamp: Date.now(),
  };
}

// Hand 3 from the report: 50bb-ish, hero opened to 50, villain jammed all-in.
const deepJam = (hole: [string, string]) =>
  facingRaise(hole, { heroStack: 920, heroBet: 50, villStack: 0, villBet: 1030, villAllIn: true });

describe('facing a deep preflop all-in (call/fold, not chart "call")', () => {
  it('FOLDS T9s to a ~48bb all-in 3-bet (the exact reported punt)', () => {
    const a = getGTOAdvice(deepJam(['9d', 'Td']))!;
    expect(a.scenario.toLowerCase()).toContain('all-in');
    expect(a.actions[0].action).toBe('Fold');
    expect(a.inRange).toBe(false);
  });

  it('CALLS off only premiums vs the deep jam (AA all-in)', () => {
    const a = getGTOAdvice(deepJam(['Ah', 'Ad']))!;
    expect(a.actions[0].action).toBe('All-In');
    expect(a.inRange).toBe(true);
  });

  it('also folds other trash stack-offs (KJo, 76s) to the deep jam', () => {
    expect(getGTOAdvice(deepJam(['Kh', 'Jc']))!.actions[0].action).toBe('Fold');
    expect(getGTOAdvice(deepJam(['7h', '6h']))!.actions[0].action).toBe('Fold');
  });

  it('does NOT treat a normal small 3-bet as a jam (uses the vs-3bet chart)', () => {
    // 100bb deep, villain 3-bet to 6bb (not all-in). T9s should reach the chart,
    // not the jam call/fold path.
    const a = getGTOAdvice(facingRaise(['9d', 'Td'], {
      heroStack: 1950, heroBet: 50, villStack: 1880, villBet: 120, villAllIn: false,
    }))!;
    expect(a.scenario.toLowerCase()).not.toContain('all-in');
  });
});
