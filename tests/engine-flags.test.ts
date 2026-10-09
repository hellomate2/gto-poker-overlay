import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0.99); });
afterEach(() => { vi.restoreAllMocks(); resetEngineFlags(); });

vi.mock('../src/storage/db', async () => {
  const actual = await vi.importActual<typeof import('../src/storage/db')>('../src/storage/db');
  return { ...actual, getPlayerStats: async () => null, savePlayerStats: async () => {} };
});

import { DecisionEngine } from '../src/core/engine';
import {
  ENGINE_FLAGS, DEFAULT_ENGINE_FLAGS, parseFlagSpec, setEngineFlags, resetEngineFlags, describeEngineFlags,
} from '../src/core/engine-flags';
import { Action, GameState, Player, Position, Street } from '../src/types/poker';
import { card } from './helpers';

function mkPlayer(name: string, position: Position, seat: number, isHero = false, stack = 1000): Player {
  return {
    name, stack, position, isDealer: false, isSittingOut: false, seatIndex: seat,
    isHero, currentBet: 0, hasActed: false,
  };
}

interface Spot {
  players: Player[];
  heroIndex: number;
  dealerIndex: number;
  street: Street;
  heroCards: [string, string];
  board: string[];
  pot: number;
  currentBet: number;
  history: Partial<Record<Street, Action[]>>;
}

function state(s: Spot): GameState {
  s.players.forEach((p, i) => { p.isDealer = i === s.dealerIndex; });
  return {
    tableId: 't', handNumber: 1, street: s.street, pot: s.pot, sidePots: [],
    heroCards: [card(s.heroCards[0]), card(s.heroCards[1])],
    communityCards: s.board.map(card),
    players: s.players, heroIndex: s.heroIndex, dealerIndex: s.dealerIndex, activePlayerIndex: s.heroIndex,
    currentBet: s.currentBet, minRaise: 2 * s.currentBet || 20, bigBlind: 20, smallBlind: 10,
    actionHistory: { preflop: [], flop: [], turn: [], river: [], ...s.history },
    isOurTurn: true, timestamp: 0,
  };
}

/** 6-max: UTG..CO fold, BTN (hero) opens, SB folds, BB calls. Flop checked to hero. */
function sixMaxHeadsUpFlop(): GameState {
  const names = ['UTGp', 'MPp', 'COp', 'Hero', 'SBp', 'BBp'];
  const pos: Position[] = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
  const players = names.map((n, i) => mkPlayer(n, pos[i], i, n === 'Hero', 1000));
  return state({
    players, heroIndex: 3, dealerIndex: 3, street: 'flop',
    heroCards: ['Ah', 'Kd'], board: ['Ks', '7c', '2d'], pot: 110, currentBet: 0,
    history: {
      preflop: [
        { type: 'fold', playerName: 'UTGp' }, { type: 'fold', playerName: 'MPp' }, { type: 'fold', playerName: 'COp' },
        { type: 'raise', amount: 50, playerName: 'Hero' }, { type: 'fold', playerName: 'SBp' },
        { type: 'call', amount: 50, playerName: 'BBp' },
      ],
      flop: [{ type: 'check', playerName: 'BBp' }],
    },
  });
}

/** Heads-up table: hero on the button opens, BB calls; hero c-bets the flop and gets raised. */
function huFlopFacingRaise(): GameState {
  const hero = mkPlayer('Hero', 'SB', 0, true, 950);
  const vil = mkPlayer('Vil', 'BB', 1, false, 917);
  hero.currentBet = 33;
  vil.currentBet = 83;
  return state({
    players: [hero, vil], heroIndex: 0, dealerIndex: 0, street: 'flop',
    heroCards: ['Ac', '7c'], board: ['Kd', '7h', '2s'], pot: 216, currentBet: 83,
    history: {
      preflop: [{ type: 'raise', amount: 50, playerName: 'Hero' }, { type: 'call', amount: 50, playerName: 'Vil' }],
      flop: [{ type: 'check', playerName: 'Vil' }, { type: 'bet', amount: 33, playerName: 'Hero' }, { type: 'raise', amount: 83, playerName: 'Vil' }],
    },
  });
}

/** Heads-up river: villain leads 100 into 220 after a checked turn. */
function huRiverFacingBet(): GameState {
  const hero = mkPlayer('Hero', 'SB', 0, true, 840);
  const vil = mkPlayer('Vil', 'BB', 1, false, 740);
  vil.currentBet = 100;
  return state({
    players: [hero, vil], heroIndex: 0, dealerIndex: 0, street: 'river',
    heroCards: ['Kh', 'Jh'], board: ['Kd', '8c', '4s', '2h', '9d'], pot: 320, currentBet: 100,
    history: {
      preflop: [{ type: 'raise', amount: 50, playerName: 'Hero' }, { type: 'call', amount: 50, playerName: 'Vil' }],
      flop: [{ type: 'check', playerName: 'Vil' }, { type: 'bet', amount: 60, playerName: 'Hero' }, { type: 'call', amount: 60, playerName: 'Vil' }],
      turn: [{ type: 'check', playerName: 'Vil' }, { type: 'check', playerName: 'Hero' }],
      river: [{ type: 'bet', amount: 100, playerName: 'Vil' }],
    },
  });
}

/** 6-max, three players see the flop (CO opens, hero BTN calls, BB calls); BB bets into both. */
function sixMaxMultiwayFacingBet(): GameState {
  const names = ['UTGp', 'MPp', 'COp', 'Hero', 'SBp', 'BBp'];
  const pos: Position[] = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
  const players = names.map((n, i) => mkPlayer(n, pos[i], i, n === 'Hero', 950));
  players[5].currentBet = 80;
  return state({
    players, heroIndex: 3, dealerIndex: 3, street: 'flop',
    heroCards: ['Qh', 'Qc'], board: ['Js', '8d', '3h'], pot: 240, currentBet: 80,
    history: {
      preflop: [
        { type: 'fold', playerName: 'UTGp' }, { type: 'fold', playerName: 'MPp' },
        { type: 'raise', amount: 50, playerName: 'COp' }, { type: 'call', amount: 50, playerName: 'Hero' },
        { type: 'fold', playerName: 'SBp' }, { type: 'call', amount: 50, playerName: 'BBp' },
      ],
      flop: [{ type: 'bet', amount: 80, playerName: 'BBp' }, { type: 'call', amount: 80, playerName: 'COp' }],
    },
  });
}

describe('engine flag config', () => {
  it('parses flag specs', () => {
    expect(describeEngineFlags(parseFlagSpec('none'))).toBe('none');
    expect(Object.values(parseFlagSpec('all')).every(Boolean)).toBe(true);
    const exact = parseFlagSpec('DEFENSE,range_tracker');
    expect(exact.DEFENSE && exact.RANGE_TRACKER).toBe(true);
    expect(exact.SUBGAME_SOLVER || exact.MULTIWAY_EQUITY || exact.FIX_LIVE_VILLAINS).toBe(false);
    const rel = parseFlagSpec('+SUBGAME_SOLVER -DEFENSE', { ...DEFAULT_ENGINE_FLAGS, DEFENSE: true });
    expect(rel.SUBGAME_SOLVER).toBe(true);
    expect(rel.DEFENSE).toBe(false);
    expect(() => parseFlagSpec('DEFENCE')).toThrow(/unknown engine flag/);
  });

  it('setEngineFlags / resetEngineFlags round-trip', () => {
    setEngineFlags({ SUBGAME_SOLVER: !DEFAULT_ENGINE_FLAGS.SUBGAME_SOLVER });
    expect(ENGINE_FLAGS.SUBGAME_SOLVER).toBe(!DEFAULT_ENGINE_FLAGS.SUBGAME_SOLVER);
    resetEngineFlags();
    expect({ ...ENGINE_FLAGS }).toEqual({ ...DEFAULT_ENGINE_FLAGS });
  });
});

describe('FIX_LIVE_VILLAINS', () => {
  it('routes a heads-up flop at a 6-max table to the heads-up path only when on', async () => {
    setEngineFlags(parseFlagSpec('none'));
    const off = await new DecisionEngine().decide(sixMaxHeadsUpFlop());
    expect(off.reasoning).not.toContain('[lead-policy]');
    setEngineFlags({ FIX_LIVE_VILLAINS: true });
    const on = await new DecisionEngine().decide(sixMaxHeadsUpFlop());
    expect(on.reasoning).toContain('[lead-policy]');
  });
});

describe('DEFENSE', () => {
  it('a mid pair facing a small flop raise goes through defense.ts and does not fold', async () => {
    setEngineFlags(parseFlagSpec('DEFENSE'));
    const d = await new DecisionEngine().decide(huFlopFacingRaise());
    expect(d.reasoning).toContain('[defense]');
    expect(d.action).not.toBe('fold');
  });

  it('multiway facing a bet also uses defense.ts (pot odds, no MDF)', async () => {
    setEngineFlags(parseFlagSpec('DEFENSE,FIX_LIVE_VILLAINS'));
    const d = await new DecisionEngine().decide(sixMaxMultiwayFacingBet());
    expect(d.reasoning).toContain('[defense]');
    expect(['fold', 'call', 'raise', 'allin']).toContain(d.action);
  });
});

describe('RANGE_TRACKER + MULTIWAY_EQUITY', () => {
  it('multiway spot decides with tracker ranges and N-way equity', async () => {
    setEngineFlags(parseFlagSpec('RANGE_TRACKER,MULTIWAY_EQUITY,FIX_LIVE_VILLAINS'));
    const d = await new DecisionEngine().decide(sixMaxMultiwayFacingBet());
    expect(['fold', 'call', 'raise', 'allin']).toContain(d.action);
    expect(d.reasoning.length).toBeGreaterThan(0);
  });

  it('heads-up tracker ranges feed the net anti-punt floor without errors', async () => {
    setEngineFlags(parseFlagSpec('RANGE_TRACKER'));
    const d = await new DecisionEngine().decide(huFlopFacingRaise());
    expect(['fold', 'call', 'raise', 'allin']).toContain(d.action);
  });
});

describe('SUBGAME_SOLVER', () => {
  it('solves a heads-up river spot and returns a legal action', async () => {
    setEngineFlags(parseFlagSpec('SUBGAME_SOLVER'));
    const t0 = Date.now();
    const d = await new DecisionEngine().decide(huRiverFacingBet());
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(d.reasoning).toContain('[subgame]');
    expect(['fold', 'call', 'raise', 'allin']).toContain(d.action);
    const total = d.mixedStrategy.fold + d.mixedStrategy.check + d.mixedStrategy.call +
      d.mixedStrategy.bets.reduce((s, b) => s + b.probability, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('falls back to the normal path on the flop', async () => {
    setEngineFlags(parseFlagSpec('SUBGAME_SOLVER'));
    const d = await new DecisionEngine().decide(huFlopFacingRaise());
    expect(d.reasoning).not.toContain('[subgame]');
  });
});
