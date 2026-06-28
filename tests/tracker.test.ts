import { describe, it, expect } from 'vitest';
import '../sim/fake-idb'; // installs an in-memory IndexedDB so processHand's persistence works
import { OpponentTracker } from '../src/core/exploit/tracker';
import { GameState, Player, Position, Action } from '../src/types/poker';

function P(name: string, position: Position): Player {
  return {
    name, position, stack: 1000, isDealer: position === 'BTN' || position === 'SB',
    isSittingOut: false, seatIndex: 0, isHero: false, currentBet: 0, hasActed: false,
  };
}

function mkState(players: Player[], preflop: Action[] = [], flop: Action[] = []): GameState {
  return {
    tableId: 't', handNumber: 1, street: 'preflop', pot: 0, sidePots: [],
    heroCards: null, communityCards: [], players, heroIndex: 0, dealerIndex: 0,
    activePlayerIndex: 0, currentBet: 0, minRaise: 40, bigBlind: 20, smallBlind: 10,
    actionHistory: { preflop, flop, turn: [], river: [] }, isOurTurn: false, timestamp: 1,
  } as unknown as GameState;
}

describe('OpponentTracker.processHand — VPIP / PFR (the inputs that drive classification)', () => {
  it('a preflop CALL counts as VPIP (not PFR)', async () => {
    const t = new OpponentTracker();
    await t.processHand(mkState([P('A', 'BTN'), P('B', 'BB')], [{ type: 'call', playerName: 'A', amount: 20 }]));
    expect(t.getStats('A')?.vpipCount).toBe(1);
    expect(t.getStats('A')?.pfrCount).toBe(0);
  });

  it('a preflop RAISE counts as both VPIP and PFR', async () => {
    const t = new OpponentTracker();
    await t.processHand(mkState([P('A', 'BTN'), P('B', 'BB')], [{ type: 'raise', playerName: 'A', amount: 60 }]));
    expect(t.getStats('A')?.vpipCount).toBe(1);
    expect(t.getStats('A')?.pfrCount).toBe(1);
  });

  it('a BB who only CHECKS is NOT VPIP (forced post is not voluntary)', async () => {
    const t = new OpponentTracker();
    await t.processHand(mkState([P('A', 'BTN'), P('B', 'BB')],
      [{ type: 'call', playerName: 'A', amount: 20 }, { type: 'check', playerName: 'B' }]));
    expect(t.getStats('B')?.vpipCount).toBe(0);
    expect(t.getStats('B')?.pfrCount).toBe(0);
  });
});

describe('OpponentTracker.processHand — 3-bet attribution (feeds the TAG/LAG exploit)', () => {
  it('the re-raiser gets the 3-bet; the opener gets a fold-to-3bet OPPORTUNITY (called, did not fold)', async () => {
    const t = new OpponentTracker();
    // A opens, B 3-bets, A calls.
    await t.processHand(mkState([P('A', 'BTN'), P('B', 'BB')], [
      { type: 'raise', playerName: 'A', amount: 60 },
      { type: 'raise', playerName: 'B', amount: 180 },
      { type: 'call', playerName: 'A', amount: 180 },
    ]));
    expect(t.getStats('B')?.threeBetCount).toBe(1);
    expect(t.getStats('B')?.threeBetOpportunity).toBe(1);
    // A was the initial raiser -> faced a 3-bet but did NOT fold (called).
    expect(t.getStats('A')?.foldToThreeBetOpportunity).toBe(1);
    expect(t.getStats('A')?.foldToThreeBetCount).toBe(0);
    expect(t.getStats('A')?.threeBetCount).toBe(0); // the opener didn't 3-bet
  });
});

describe('OpponentTracker.processHand — c-bet attribution (feeds the c-bet exploit)', () => {
  it('the preflop aggressor c-betting the flop counts; the caller gets a fold-to-cbet opportunity', async () => {
    const t = new OpponentTracker();
    await t.processHand(mkState(
      [P('A', 'BTN'), P('B', 'BB')],
      [{ type: 'raise', playerName: 'A', amount: 60 }, { type: 'call', playerName: 'B', amount: 60 }],
      [{ type: 'bet', playerName: 'A', amount: 80 }, { type: 'fold', playerName: 'B' }],
    ));
    expect(t.getStats('A')?.cbetFlopCount).toBe(1);
    expect(t.getStats('A')?.cbetFlopOpportunity).toBe(1);
    expect(t.getStats('B')?.foldToCbetFlopCount).toBe(1);
    expect(t.getStats('B')?.foldToCbetFlopOpportunity).toBe(1);
  });
});
