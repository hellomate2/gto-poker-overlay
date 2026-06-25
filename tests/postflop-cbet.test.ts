import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Seed Math.random so the mixed-strategy sampling (the small checking tail of
// the c-bet nudge, and the heuristic bluff frequencies) is deterministic. The
// nudge itself is deterministic given the board/hand; this only fixes the rare
// RNG-driven lines so these assertions are stable.
beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0.01); });
afterEach(() => { vi.restoreAllMocks(); });

// DecisionEngine reads opponent stats from IndexedDB, which doesn't exist under
// node. Stub the storage layer so decide() runs with empty opponent data — these
// c-bet spots don't depend on villain stats.
vi.mock('../src/storage/db', async () => {
  const actual = await vi.importActual<typeof import('../src/storage/db')>('../src/storage/db');
  return {
    ...actual,
    getPlayerStats: async () => null,
    savePlayerStats: async () => {},
  };
});

import { DecisionEngine } from '../src/core/engine';
import { GameState, Player, Position, Street, Card } from '../src/types/poker';
import { card } from './helpers';

// ============================================================
// C-BET NUDGE (decidePostflopNet IP-PFR-checked-to leak fix).
//
// As the IN-POSITION preflop aggressor with the action checked to it, the
// distilled net under-c-bets heads-up and checks back made hands that should bet
// for value/protection. The nudge in decidePostflopNet converts the net's
// 'check' into a board-texture-sized c-bet for qualifying hands, while
// preserving the anti-blunder guards (no betting into a flush board it can't
// beat; pure air / marginal pairs on wet boards keep checking).
//
// These tests drive the REAL decide() (which routes heads-up postflop to the
// net path) on constructed IP, checked-to spots.
// ============================================================

function mkPlayer(name: string, position: Position, isHero = false, stack = 1000): Player {
  return {
    name, stack, position,
    // Hero is the BUTTON (heads-up button = preflop aggressor, in position).
    isDealer: position === 'BTN',
    isSittingOut: false,
    seatIndex: position === 'BTN' ? 0 : 1,
    isHero,
    currentBet: 0,
    hasActed: false,
  };
}

interface Opts {
  heroCards: [string, string];
  community: string[];
  pot: number;
  currentBet?: number; // highest bet this street (0 == checked to hero)
  heroBet?: number;
  street?: Street;
  heroIsDealer?: boolean; // default true (IP); set false to test OOP
}

function buildState(o: Opts): GameState {
  const heroDealer = o.heroIsDealer ?? true;
  const hero = mkPlayer('Hero', heroDealer ? 'BTN' : 'BB', true);
  hero.isDealer = heroDealer;
  hero.currentBet = o.heroBet ?? 0;
  const villain = mkPlayer('Villain', heroDealer ? 'BB' : 'BTN', false);
  villain.isDealer = !heroDealer;
  villain.currentBet = o.currentBet ?? 0;
  const community: Card[] = o.community.map(card);
  return {
    tableId: 't', handNumber: 1, street: o.street ?? 'flop',
    pot: o.pot, sidePots: [],
    heroCards: [card(o.heroCards[0]), card(o.heroCards[1])],
    communityCards: community,
    players: [hero, villain],
    heroIndex: 0, dealerIndex: heroDealer ? 0 : 1, activePlayerIndex: 0,
    currentBet: o.currentBet ?? 0,
    minRaise: 20, bigBlind: 20, smallBlind: 10,
    actionHistory: { preflop: [], flop: [], turn: [], river: [] },
    isOurTurn: true, timestamp: Date.now(),
  };
}

const isBet = (a: string) => a === 'bet' || a === 'raise';

describe('postflop c-bet nudge (IP preflop aggressor, checked to)', () => {
  it('c-bets top pair on a dry board IP (net would check) — does NOT check back', async () => {
    const engine = new DecisionEngine();
    // JT on Jc6d2s: dry, hero flops top pair. The raw net checks this back
    // (~0.75 check) — the exact leak. The nudge must convert it to a c-bet.
    const state = buildState({
      heroCards: ['Js', 'Th'],
      community: ['Jc', '6d', '2s'],
      pot: 100, currentBet: 0, street: 'flop',
    });
    const d = await engine.decide(state);
    expect(isBet(d.action)).toBe(true);
    expect(d.action).not.toBe('check');
    expect(d.amount).toBeGreaterThan(0);
    expect(d.reasoning).toMatch(/cbet-nudge/);
  });

  it('c-bets top-pair-top-kicker on a dry board IP', async () => {
    const engine = new DecisionEngine();
    const state = buildState({
      heroCards: ['As', 'Kd'],
      community: ['Ah', '7d', '2c'], // TPTK, dry
      pot: 100, currentBet: 0, street: 'flop',
    });
    const d = await engine.decide(state);
    expect(isBet(d.action)).toBe(true);
    expect(d.amount).toBeGreaterThan(0);
  });

  it('keeps checking pure air on a wet board IP — does not spew', async () => {
    const engine = new DecisionEngine();
    // 7-6o on AhKh3d: no pair, no real made hand. The nudge requires >= one
    // pair, so air keeps the net's behavior (check here).
    const state = buildState({
      heroCards: ['7c', '6s'],
      community: ['Ah', 'Kh', '3d'],
      pot: 100, currentBet: 0, street: 'flop',
    });
    const d = await engine.decide(state);
    expect(d.action).toBe('check');
    expect(d.reasoning).not.toMatch(/cbet-nudge/);
  });

  it('does NOT bet a made hand into a monotone board without the flush (anti-blunder preserved)', async () => {
    const engine = new DecisionEngine();
    // KQ on Kh7h2h: top pair but a monotone heart board and hero holds NO heart.
    // The dangerous-flush-board guard must suppress the nudge -> check.
    const state = buildState({
      heroCards: ['Ks', 'Qd'],
      community: ['Kh', '7h', '2h'],
      pot: 100, currentBet: 0, street: 'flop',
    });
    const d = await engine.decide(state);
    expect(d.action).toBe('check');
    expect(isBet(d.action)).toBe(false);
    expect(d.reasoning).not.toMatch(/cbet-nudge/);
  });

  it('does NOT nudge a marginal lone pair on a monotone board (pot control)', async () => {
    const engine = new DecisionEngine();
    // QJ on Qh7h2h: lone pair on a monotone board (hero has the Qh, so it is NOT
    // a "dangerous flush board" by the no-flush rule, but still a marginal pair
    // on a monotone texture -> texture suppression keeps it checking).
    const state = buildState({
      heroCards: ['Qd', 'Js'],
      community: ['Qh', '7h', '2h'],
      pot: 100, currentBet: 0, street: 'flop',
    });
    const d = await engine.decide(state);
    expect(d.action).toBe('check');
  });

  it('leaves OOP behavior to the net (no IP c-bet nudge out of position)', async () => {
    const engine = new DecisionEngine();
    // Same JT-on-dry top-pair spot but hero is OOP (not the button). The nudge
    // is IP-only, so it must NOT fire here — the decision is left entirely to the
    // net (whatever the net chose for the OOP spot, unmodified by the nudge).
    const state = buildState({
      heroCards: ['Js', 'Th'],
      community: ['Jc', '6d', '2s'],
      pot: 100, currentBet: 0, street: 'flop',
      heroIsDealer: false,
    });
    const d = await engine.decide(state);
    // The IP c-bet nudge must not have fired.
    expect(d.reasoning).not.toMatch(/cbet-nudge/);
    // The reasoning is a plain net decision (the OOP path is untouched).
    expect(d.reasoning).toMatch(/^net /);
  });

  it('does not bet when facing a bet (nudge is for the checked-to spot only)', async () => {
    const engine = new DecisionEngine();
    // Top pair IP but villain has bet into hero: the nudge requires NOT facing a
    // bet, so it must not fire as a (first-in) bet. Decision is call/raise/fold.
    const state = buildState({
      heroCards: ['Js', 'Th'],
      community: ['Jc', '6d', '2s'],
      pot: 100, currentBet: 40, heroBet: 0, street: 'flop',
    });
    const d = await engine.decide(state);
    expect(d.reasoning).not.toMatch(/cbet-nudge/);
    expect(d.action).not.toBe('bet');
  });
});
