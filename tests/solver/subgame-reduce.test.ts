import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { solveSubgame, reduceRange } from '../../src/core/solver/subgame';
import { RangeHand } from '../../src/core/solver/postflop-cfr';
import { estimateVillainRanges, heroRangeFor } from '../../src/core/ranges/range-tracker';
import { evaluateHand } from '../../src/core/equity/hand-eval';
import { cardToId } from '../../src/core/cfr/card-utils';
import { DecisionEngine } from '../../src/core/engine';
import { setEngineFlags, resetEngineFlags } from '../../src/core/engine-flags';
import { Action, CardId, GameState, Player, Position, Street } from '../../src/types/poker';
import { card, cid, ids } from '../helpers';

// ============================================================
// P0-CRIT-1 regression: the subgame solver's per-side combo cap.
//
// The old cap kept the 200 highest-weight combos (120 on the flop). A tracker
// range narrowed by villain's bets holds its value hands at high weight and
// its bluffs and draws at low weight, so the cut removed the bluffs. On the
// reviewer's turn spot below the capped solve folded 99.8% of hero's range,
// A7 included (call EV -93), while the same solve with no cap calls A7 at
// about +109 chips and folds under 10% of the range. reduceRange replaces the
// cut with weight-preserving threshold sampling stratified by hand strength.
// ============================================================

vi.mock('../../src/storage/db', async () => {
  const actual = await vi.importActual<typeof import('../../src/storage/db')>('../../src/storage/db');
  return { ...actual, getPlayerStats: async () => null, savePlayerStats: async () => {} };
});

function mk(name: string, position: Position, isHero: boolean, seat: number, currentBet: number): Player {
  return {
    name, stack: 2000, position, isDealer: position === 'SB', isSittingOut: false,
    seatIndex: seat, isHero, currentBet, hasActed: false,
  };
}

const PREFLOP: Action[] = [
  { type: 'raise', amount: 60, playerName: 'Villain' },
  { type: 'call', amount: 60, playerName: 'Hero' },
];
const FLOP_BET_CALL: Action[] = [
  { type: 'check', playerName: 'Hero' },
  { type: 'bet', amount: 60, playerName: 'Villain' },
  { type: 'call', amount: 60, playerName: 'Hero' },
];

// HU, 10/20 blinds. Villain (SB, button) opens to 60, hero (BB) calls; villain
// bets 60 on Kd 7h 2s and hero calls.
// Turn spot: Qc, villain bets 150 into 240 (pot 390, toCall 150).
// River spot: Qc checks through, 3d river, villain bets 120 into 240.
function spot(street: 'turn' | 'river', hero: [string, string]): GameState {
  const history: Record<Street, Action[]> = {
    preflop: PREFLOP,
    flop: FLOP_BET_CALL,
    turn: street === 'turn'
      ? [{ type: 'check', playerName: 'Hero' }, { type: 'bet', amount: 150, playerName: 'Villain' }]
      : [{ type: 'check', playerName: 'Hero' }, { type: 'check', playerName: 'Villain' }],
    river: street === 'river'
      ? [{ type: 'check', playerName: 'Hero' }, { type: 'bet', amount: 120, playerName: 'Villain' }]
      : [],
  };
  const bet = street === 'turn' ? 150 : 120;
  const board = street === 'turn' ? ['Kd', '7h', '2s', 'Qc'] : ['Kd', '7h', '2s', 'Qc', '3d'];
  return {
    tableId: 't', handNumber: 1, street, pot: 240 + bet, sidePots: [],
    heroCards: [card(hero[0]), card(hero[1])],
    communityCards: board.map(card),
    players: [mk('Hero', 'BB', true, 0, 0), mk('Villain', 'SB', false, 1, bet)],
    heroIndex: 0, dealerIndex: 1, activePlayerIndex: 0,
    currentBet: bet, minRaise: bet, bigBlind: 20, smallBlind: 10,
    actionHistory: history, isOurTurn: true, timestamp: 0,
  };
}

function solveSpot(street: 'turn' | 'river', hero: [string, string], maxCombosPerSide?: number) {
  const s = spot(street, hero);
  const board = s.communityCards.map((c) => cardToId(c));
  const villainRange = estimateVillainRanges(s, [board[0], board[1]])[0].range;
  const heroRange = heroRangeFor(s);
  const toCall = s.currentBet;
  const r = solveSubgame({
    heroCards: [cid(hero[0]), cid(hero[1])], board, heroRange, villainRange,
    pot: s.pot, toCall, effectiveStack: 1880, heroIsIP: false,
    // A generous budget so the solve stops on the exploitability target, not
    // the wall clock: the result does not depend on machine load.
    budgetMs: 30000, seed: 1, maxCombosPerSide,
  });
  const by = (kind: string) => r.actions.find((a) => a.kind === kind)!;
  return { r, villainCombos: villainRange.combos.length, fold: by('fold'), call: by('call') };
}

describe('P0-CRIT-1: subgame cap keeps the bluff part of a narrowed range', () => {
  it('turn spot: the tracked villain range is far over the cap', () => {
    expect(solveSpot('turn', ['As', '7c']).villainCombos).toBeGreaterThan(1000);
  });

  it('turn spot: hero defends near MDF and A7 calls at +EV, matching the uncapped solve', () => {
    const capped = solveSpot('turn', ['As', '7c']);
    const full = solveSpot('turn', ['As', '7c'], 5000);
    const mdfFold = 150 / 390; // folding more than this is over-folding
    expect(capped.r.combos.villain).toBeLessThanOrEqual(200);
    expect(capped.fold.rangeFrequency).toBeLessThan(mdfFold);
    expect(Math.abs(capped.fold.rangeFrequency - full.fold.rangeFrequency)).toBeLessThan(0.05);
    expect(capped.call.probability).toBeGreaterThan(0.9);
    expect(capped.call.ev).toBeGreaterThan(0);
    expect(Math.abs(capped.call.ev - full.call.ev)).toBeLessThan(15);
  });

  it('turn spot: draws and bluff-catchers call (OESD, underpair, gutshot, A5)', () => {
    for (const h of [['Jh', 'Th'], ['6s', '6h'], ['7s', '5s'], ['Ad', '5d']] as [string, string][]) {
      const { call } = solveSpot('turn', h);
      expect(call.probability, h.join('')).toBeGreaterThan(0.5);
      expect(call.ev, h.join('')).toBeGreaterThan(0);
    }
  });

  it('river spot: range fold stays near MDF and A7 calls', () => {
    const { fold, call, r } = solveSpot('river', ['As', '7c']);
    expect(r.combos.villain).toBeLessThanOrEqual(200);
    expect(fold.rangeFrequency).toBeLessThan(0.5); // old cap: 0.89, uncapped: about 0.38
    expect(call.probability).toBeGreaterThan(0.9);
    expect(call.ev).toBeGreaterThan(0);
  });
});

describe('P0-CRIT-1: engine with SUBGAME_SOLVER calls the OESD', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    setEngineFlags({ SUBGAME_SOLVER: true, RANGE_TRACKER: true, FIX_LIVE_VILLAINS: true });
  });
  afterEach(() => { vi.restoreAllMocks(); resetEngineFlags(); });

  it('JhTh on Kd7h2sQc facing 150 into 240 is a subgame call, not a fold', async () => {
    const d = await new DecisionEngine().decide(spot('turn', ['Jh', 'Th']));
    expect(d.reasoning).toContain('[subgame]');
    expect(d.action).toBe('call');
  });
});

// ------------------------------------------------------------
// reduceRange unit properties
// ------------------------------------------------------------

const BOARD = ids('Kd', '7h', '2s', 'Qc');

function allCombos(board: CardId[]): [CardId, CardId][] {
  const dead = new Set(board);
  const out: [CardId, CardId][] = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) if (!dead.has(a) && !dead.has(b)) out.push([a, b]);
  return out;
}

// Polar range: the strongest 15% of combos at weight 1, everything else at a
// small weight, so the low-weight part holds most of the combos.
function polarRange(lowWeight: number): RangeHand[] {
  const combos = allCombos(BOARD);
  const str = combos.map((c) => evaluateHand([c[0], c[1], ...BOARD]));
  const sorted = [...str].sort((a, b) => b - a);
  const cut = sorted[Math.floor(combos.length * 0.15)];
  return combos.map((c, i) => ({ cards: c, weight: str[i] > cut ? 1 : lowWeight }));
}

const mass = (r: RangeHand[], pred: (h: RangeHand) => boolean) =>
  r.reduce((s, h) => s + (pred(h) ? h.weight : 0), 0);

describe('reduceRange', () => {
  it('returns the range unchanged when it is within the cap', () => {
    const r = polarRange(0.1).slice(0, 50);
    expect(reduceRange(r, 200, BOARD)).toBe(r);
  });

  it('keeps at most cap combos, the same total weight, and is deterministic', () => {
    const r = polarRange(0.05);
    const a = reduceRange(r, 200, BOARD);
    const b = reduceRange(r, 200, BOARD);
    expect(a.length).toBeLessThanOrEqual(200);
    expect(a.length).toBeGreaterThanOrEqual(199);
    expect(mass(a, () => true)).toBeCloseTo(mass(r, () => true), 9);
    expect(a).toEqual(b);
  });

  it('keeps the low-weight share of the range (a top-weight cut would drop it)', () => {
    const r = polarRange(0.05);
    const total = mass(r, () => true);
    const lowShare = mass(r, (h) => h.weight < 1) / total;
    const lowKeys = new Set(r.filter((h) => h.weight < 1).map((h) => h.cards[0] * 64 + h.cards[1]));
    const red = reduceRange(r, 200, BOARD);
    const redLow = mass(red, (h) => lowKeys.has(h.cards[0] * 64 + h.cards[1])) / mass(red, () => true);
    expect(lowShare).toBeGreaterThan(0.2);
    expect(Math.abs(redLow - lowShare)).toBeLessThan(0.02);
  });

  it('keeps each hand-strength category within one sample of its weight share', () => {
    const r = polarRange(0.05);
    const cat = (h: RangeHand) => Math.floor(evaluateHand([h.cards[0], h.cards[1], ...BOARD]) / 1_000_000);
    const red = reduceRange(r, 200, BOARD);
    const tot = mass(r, () => true);
    const redTot = mass(red, () => true);
    const maxSmall = Math.max(...red.map((h) => h.weight));
    for (let c = 0; c <= 8; c++) {
      const share = mass(r, (h) => cat(h) === c) / tot;
      const redShare = mass(red, (h) => cat(h) === c) / redTot;
      expect(Math.abs(redShare - share), `category ${c}`).toBeLessThanOrEqual(maxSmall / redTot + 1e-9);
    }
  });

  it('keeps every combo at or above the threshold with its own weight', () => {
    const r = polarRange(0.05);
    // Make ten combos heavy: each must survive with its weight ratio intact.
    for (let i = 0; i < 10; i++) r[i * 37].weight = 50;
    const red = reduceRange(r, 200, BOARD);
    const key = (h: RangeHand) => h.cards[0] * 64 + h.cards[1];
    const redMap = new Map(red.map((h) => [key(h), h.weight]));
    const scale = mass(red, () => true) / mass(r, () => true);
    for (let i = 0; i < 10; i++) expect(redMap.get(key(r[i * 37]))).toBeCloseTo(50 * scale, 9);
  });
});
