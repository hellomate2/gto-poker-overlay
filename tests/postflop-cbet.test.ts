import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Median RNG (0.5) so a single decide() reflects the lead policy's frequency:
// freq>0.5 -> bets, freq<0.5 -> checks. Frequency tests below sweep RNG instead.
beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0.5); });
afterEach(() => { vi.restoreAllMocks(); });

vi.mock('../src/storage/db', async () => {
  const actual = await vi.importActual<typeof import('../src/storage/db')>('../src/storage/db');
  return { ...actual, getPlayerStats: async () => null, savePlayerStats: async () => {} };
});

import { DecisionEngine } from '../src/core/engine';
import { GameState, Player, Position, Street, Card } from '../src/types/poker';
import { card } from './helpers';

// ============================================================
// LEAD / C-BET POLICY (decidePostflopNet, not-facing-a-bet spot).
//
// The net's bet-or-check decision was inverted (it checked as the aggressor and
// donked air as the caller). The lead policy (cbet.ts) replaces it: the
// aggressor c-bets, the caller checks to the raiser and leads only strong. These
// spots have NO preflop history, so the c-bettor role falls back to POSITION
// (the button is the aggressor); hero on the button = c-bettor, hero in the BB =
// caller.
// ============================================================

function mkPlayer(name: string, position: Position, isHero = false, stack = 1000): Player {
  return { name, stack, position, isDealer: position === 'BTN', isSittingOut: false,
    seatIndex: position === 'BTN' ? 0 : 1, isHero, currentBet: 0, hasActed: false };
}

interface Opts {
  heroCards: [string, string]; community: string[]; pot: number;
  currentBet?: number; heroBet?: number; street?: Street; heroIsDealer?: boolean;
}

function buildState(o: Opts): GameState {
  const heroDealer = o.heroIsDealer ?? true;
  const hero = mkPlayer('Hero', heroDealer ? 'BTN' : 'BB', true);
  hero.isDealer = heroDealer; hero.currentBet = o.heroBet ?? 0;
  const villain = mkPlayer('Villain', heroDealer ? 'BB' : 'BTN', false);
  villain.isDealer = !heroDealer; villain.currentBet = o.currentBet ?? 0;
  return {
    tableId: 't', handNumber: 1, street: o.street ?? 'flop', pot: o.pot, sidePots: [],
    heroCards: [card(o.heroCards[0]), card(o.heroCards[1])], communityCards: o.community.map(card),
    players: [hero, villain], heroIndex: 0, dealerIndex: heroDealer ? 0 : 1, activePlayerIndex: 0,
    currentBet: o.currentBet ?? 0, minRaise: 20, bigBlind: 20, smallBlind: 10,
    actionHistory: { preflop: [], flop: [], turn: [], river: [] }, isOurTurn: true, timestamp: Date.now(),
  };
}

const isBet = (a: string) => a === 'bet' || a === 'raise';

describe('lead/c-bet policy (in-position aggressor, checked to)', () => {
  it('c-bets top pair on a dry board IP (the net would check) — does NOT check back', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['Js', 'Th'], community: ['Jc', '6d', '2s'], pot: 100, currentBet: 0,
    }));
    expect(isBet(d.action)).toBe(true);
    expect(d.amount).toBeGreaterThan(0);
    expect(d.reasoning).toMatch(/lead-policy/);
  });

  it('c-bets top-pair-top-kicker on a dry board IP', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['As', 'Kd'], community: ['Ah', '7d', '2c'], pot: 100, currentBet: 0,
    }));
    expect(isBet(d.action)).toBe(true);
    expect(d.amount).toBeGreaterThan(0);
  });

  it('mostly checks pure air IP (does not spew at median frequency)', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['7c', '6s'], community: ['Ah', 'Kh', '3d'], pot: 100, currentBet: 0,
    }));
    expect(d.action).toBe('check');
  });

  it('does NOT bet a made hand into a monotone board without the flush (anti-blunder preserved)', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['Ks', 'Qd'], community: ['Kh', '7h', '2h'], pot: 100, currentBet: 0,
    }));
    expect(d.action).toBe('check');
  });

  it('checks a marginal lone pair on a monotone board (pot control)', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['Qd', 'Js'], community: ['Qh', '7h', '2h'], pot: 100, currentBet: 0,
    }));
    expect(d.action).toBe('check');
  });

  it('does NOT donk as the OOP caller with top pair (checks to the raiser)', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['Js', 'Th'], community: ['Jc', '6d', '2s'], pot: 100, currentBet: 0, heroIsDealer: false,
    }));
    expect(d.action).toBe('check');
    expect(d.reasoning).toMatch(/check to raiser/);
  });

  it('does not lead when facing a bet (lead policy is for the checked-to spot)', async () => {
    const d = await new DecisionEngine().decide(buildState({
      heroCards: ['Js', 'Th'], community: ['Jc', '6d', '2s'], pot: 100, currentBet: 40, heroBet: 0,
    }));
    expect(d.action).not.toBe('bet'); // facing a bet -> call/raise/fold via the net
  });

  it('FREQUENCY: c-bets top pair IP a clear majority; donks air OOP rarely', async () => {
    const eng = new DecisionEngine();
    let ipBets = 0, oopDonks = 0;
    const N = 40;
    for (let k = 0; k < N; k++) {
      vi.spyOn(Math, 'random').mockReturnValue((k + 0.5) / N); // sweep 0..1
      const ip = await eng.decide(buildState({ heroCards: ['Js', 'Th'], community: ['Jc', '6d', '2s'], pot: 100, currentBet: 0 }));
      const oop = await eng.decide(buildState({ heroCards: ['8c', '5s'], community: ['Qd', '2d', 'Jh'], pot: 100, currentBet: 0, heroIsDealer: false }));
      if (isBet(ip.action)) ipBets++;
      if (isBet(oop.action)) oopDonks++;
    }
    expect(ipBets / N).toBeGreaterThan(0.5);   // aggressor c-bets top pair a lot
    expect(oopDonks / N).toBeLessThan(0.15);   // caller almost never donks air (the leak, fixed)
  });
});
