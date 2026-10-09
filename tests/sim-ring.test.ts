// ============================================================
// N-player ring engine (sim/ring.ts): pot distribution, positions, betting
// order, incomplete-raise rule, chip conservation, and the GameState the bot
// receives. The bot reads GameState, so its shape must match what the live
// scraper produces (positions template, bet/raise vocabulary, folds in history,
// raise-to minRaise).
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  distributePot, ringPositions, blindSeats, playRingHand, RingConfig, SeatAgent, SeatView, ActResult, makeRng,
} from '../sim/ring';
import { playHand, HUConfig, Seat } from '../sim/holdem';
import { ringSelftest } from '../sim/ring-run';
import { assignPositions } from '../src/content-script/scraper';
import { GameState } from '../src/types/poker';

const BB = 20, SB = 10;

/** Agent that plays a fixed script of actions and records every view it got. */
function scripted(name: string, script: ActResult[]): SeatAgent & { views: SeatView[] } {
  const views: SeatView[] = [];
  let k = 0;
  return {
    name, views,
    act(v: SeatView) {
      views.push(JSON.parse(JSON.stringify(v)) as SeatView);
      const a = script[k++];
      if (!a) throw new Error(`${name} ran out of script at view ${k}`);
      return a;
    },
  };
}

describe('distributePot (side pots)', () => {
  it('main pot to the short all-in, side pot between the deeper stacks', () => {
    // seat0 all-in for 100 with the best hand; seats 1,2 put in 300 each, seat2 beats seat1
    expect(distributePot([100, 300, 300], [false, false, false], [3, 1, 2], 0)).toEqual([300, 0, 400]);
  });
  it('returns an uncalled excess to its owner', () => {
    // seat0 shoved 500, seat1 called 200 all-in and won: 400 to seat1, 300 back to seat0
    expect(distributePot([500, 200], [false, false], [1, 2], 0)).toEqual([300, 400]);
  });
  it('folded chips go to the winners of the layers they were in', () => {
    expect(distributePot([50, 200, 200], [true, false, false], [0, 5, 5], 0)).toEqual([0, 225, 225]);
  });
  it('odd chip goes to the first winner left of the button', () => {
    // 45 chips split two ways; button is seat 2 so seat 0 is first to its left
    expect(distributePot([15, 15, 15], [false, false, true], [7, 7, 0], 2)).toEqual([23, 22, 0]);
    // button seat 0: seat 1 is first left of the button
    expect(distributePot([15, 15, 15], [false, false, true], [7, 7, 0], 0)).toEqual([22, 23, 0]);
  });
  it('throws when a layer has no eligible winner (impossible in legal betting)', () => {
    expect(() => distributePot([100, 50], [true, false], [0, 1], 0)).toThrow(/no eligible/);
  });
});

describe('positions and blinds', () => {
  it('matches scraper.assignPositions for every table size and button', () => {
    for (let n = 2; n <= 6; n++) {
      for (let b = 0; b < n; b++) expect(ringPositions(n, b)).toEqual(assignPositions(n, b));
    }
  });
  it('HU: button posts SB and opens; 3+: UTG (button+3) opens', () => {
    expect(blindSeats(2, 1)).toEqual({ sbSeat: 1, bbSeat: 0, firstPreflop: 1 });
    expect(blindSeats(6, 4)).toEqual({ sbSeat: 5, bbSeat: 0, firstPreflop: 1 });
    expect(blindSeats(3, 0)).toEqual({ sbSeat: 1, bbSeat: 2, firstPreflop: 0 });
  });
});

describe('playRingHand: a scripted 4-handed hand', () => {
  // button 0 -> positions BTN(0) SB(1) BB(2) CO(3); CO opens preflop.
  // Preflop: CO raises to 60, BTN folds, SB folds, BB calls.
  // Flop: BB checks, CO bets 80, BB raises to 240, CO calls.
  // Turn: BB bets 300, CO folds.
  const mk = () => ({
    btn: scripted('btn', [{ action: 'fold' }]),
    sb: scripted('sb', [{ action: 'fold' }]),
    bb: scripted('bb', [{ action: 'call' }, { action: 'check' }, { action: 'raise', toAmount: 240 }, { action: 'bet', toAmount: 300 }]),
    co: scripted('co', [{ action: 'raise', toAmount: 60 }, { action: 'bet', toAmount: 80 }, { action: 'call' }, { action: 'fold' }]),
  });
  const cfg: RingConfig = { bb: BB, sb: SB, startStackBB: 100, rng: makeRng(1) };

  it('plays the expected order, nets, and logs scraper vocabulary', async () => {
    const a = mk();
    const log = await playRingHand([a.btn, a.sb, a.bb, a.co], 0, cfg, 1);
    // BB wins: SB's 10 + CO's 60 + 240 = 310
    expect(log.nets).toEqual([0, -10, 310, -300]);
    expect(log.reachedStreet).toBe('turn');
    expect(log.wentToShowdown).toBe(false);
    const fs = log.finalState;
    expect(fs.actionHistory.preflop.map(x => `${x.playerName}:${x.type}`)).toEqual(['co:raise', 'btn:fold', 'sb:fold', 'bb:call']);
    expect(fs.actionHistory.flop.map(x => `${x.playerName}:${x.type}`)).toEqual(['bb:check', 'co:bet', 'bb:raise', 'co:call']);
    expect(fs.actionHistory.turn.map(x => `${x.playerName}:${x.type}`)).toEqual(['bb:bet', 'co:fold']);
    // the stats log carries the same classification
    expect(log.actions.filter(x => x.street === 'flop').map(x => x.type)).toEqual(['check', 'bet', 'raise', 'call']);
  });

  it('hands the acting seat a GameState shaped like the scraper output', async () => {
    const a = mk();
    await playRingHand([a.btn, a.sb, a.bb, a.co], 0, cfg, 1);
    // BB facing CO's flop bet of 80
    const v = a.bb.views[2];
    const st: GameState = v.state;
    expect(v.seat).toBe(2);
    expect(st.heroIndex).toBe(2);
    expect(st.dealerIndex).toBe(0);
    expect(st.players.map(p => p.position)).toEqual(['BTN', 'SB', 'BB', 'CO']);
    expect(st.players.map(p => p.isDealer)).toEqual([true, false, false, false]);
    expect(st.players.every(p => p.isSittingOut === false)).toBe(true);
    expect(st.players.map(p => (p as unknown as { folded: boolean }).folded)).toEqual([true, true, false, false]);
    expect(st.players[2].isHero).toBe(true);
    expect(st.street).toBe('flop');
    expect(st.communityCards).toHaveLength(3);
    expect(st.currentBet).toBe(80);
    expect(st.minRaise).toBe(160);          // raise-TO: 80 + an 80 increment
    expect(v.toCall).toBe(80);
    expect(st.pot).toBe(10 + 60 + 60 + 80);  // blinds/calls preflop + CO's bet
    expect(v.liveSeats).toBe(2);
    expect(st.actionHistory.preflop.filter(x => x.type === 'fold')).toHaveLength(2);
    // hero sees its own cards only
    expect(st.heroCards).toHaveLength(2);
  });
});

describe('playRingHand: rules', () => {
  it('an incomplete all-in raise does not reopen betting for seats that already acted', async () => {
    // 3-handed, button 0: BTN opens to 100, SB calls, BB (130 total) shoves for 130:
    // a 30 raise, short of the 80 minimum, so BTN and SB may only call or fold.
    const btn = scripted('btn', [{ action: 'raise', toAmount: 100 }, { action: 'raise', toAmount: 400 }]);
    const sb = scripted('sb', [{ action: 'call' }, { action: 'call' }]);
    const bb = scripted('bb', [{ action: 'allin' }]);
    const cfg: RingConfig = { bb: BB, sb: SB, startStackBB: 100, rng: makeRng(2), seatStacks: [1000, 1000, 130] };
    // after preflop BTN and SB are not all-in, so postflop they keep acting; give them checks
    btn.act = ((orig) => (v: SeatView) => (v.street === 'preflop' ? orig(v) : { action: 'check' as const }))(btn.act);
    sb.act = ((orig) => (v: SeatView) => (v.street === 'preflop' ? orig(v) : { action: 'check' as const }))(sb.act);
    const log = await playRingHand([btn, sb, bb], 0, cfg, 1);
    expect(btn.views[1].canRaise).toBe(false);
    expect(btn.views[1].toCall).toBe(30);
    // BTN's raise request was coerced to a call of the extra 30
    const pf = log.finalState.actionHistory.preflop.map(x => `${x.playerName}:${x.type}`);
    expect(pf).toEqual(['btn:raise', 'sb:call', 'bb:raise', 'btn:call', 'sb:call']);
    expect(log.nets.reduce((x, y) => x + y, 0)).toBe(0);
  });

  it('postflop the first live seat left of the button acts first', async () => {
    const seen: number[] = [];
    const mk = (name: string): SeatAgent => ({
      name, act: (v: SeatView) => { if (v.street === 'flop') seen.push(v.seat); return { action: v.canCheck ? 'check' : 'call' }; },
    });
    const agents = [mk('a'), mk('b'), mk('c'), mk('d'), mk('e'), mk('f')];
    await playRingHand(agents, 3, { bb: BB, sb: SB, startStackBB: 100, rng: makeRng(3) }, 1);
    expect(seen).toEqual([4, 5, 0, 1, 2, 3]);
  });

  it('a deal is fully determined by the supplied deck', async () => {
    const deck = Array.from({ length: 52 }, (_, i) => 51 - i);
    const passive = (name: string): SeatAgent => ({ name, act: (v: SeatView) => ({ action: v.canCheck ? 'check' : 'call' }) });
    const log = await playRingHand([passive('a'), passive('b'), passive('c')], 0, { bb: BB, sb: SB, startStackBB: 100, rng: makeRng(0) }, 1, deck);
    expect(log.holes).toEqual([[51, 48], [50, 47], [49, 46]]);
    expect(log.board).toEqual([45, 44, 43, 42, 41]);
  });

  it('chip conservation and pot distribution hold over random hands at every size, with side pots', async () => {
    const r = await ringSelftest(400);
    expect(r.hands).toBe(2000);
    expect(r.sidePotHands).toBeGreaterThan(100);
    expect(r.showdowns).toBeGreaterThan(500);
  });
});

describe('holdem.ts wrapper (heads-up)', () => {
  it('always-jam vs always-fold is exactly +75 bb/100 for the jammer', async () => {
    const fold: SeatAgent = { name: 'FOLD', act: (v) => (v.canCheck ? { action: 'check' } : { action: 'fold' }) };
    const jam: SeatAgent = { name: 'JAM', act: () => ({ action: 'allin' }) };
    const cfg: HUConfig = { bb: BB, sb: SB, startStackBB: 100, rng: makeRng(9) };
    let net = 0;
    for (let h = 0; h < 400; h++) net += (await playHand([jam, fold], (h % 2) as Seat, cfg, h + 1)).net0;
    expect((net / BB) / 400 * 100).toBe(75);
  });
});
