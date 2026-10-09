import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// Train/serve parity for the distilled postflop net.
//
// Each case describes ONE spot twice: as a PokerBench CSV row (parsed by
// ml/prep.ts parseRow, exactly how the training tensors were built) and as the
// equivalent live GameState (run through DecisionEngine.decide). The Spot the
// engine hands to predictPostflop is captured and both are run through
// encodeSpot; the feature vectors must be identical.
//
// The dataset's 'Raise X' / 'Bet X' is the size the solver offered; live, the
// offered size is the raise-to / bet the engine itself would make. So each row
// is built with the engine's own size (computed from its sizing helpers), which
// pins the SEMANTICS (raise-to total over a pot that includes this street's
// chips) rather than a particular number.
// ============================================================

const captured = vi.hoisted(() => ({ spots: [] as unknown[] }));

vi.mock('../src/core/ml/policy', async () => {
  const actual = await vi.importActual<typeof import('../src/core/ml/policy')>('../src/core/ml/policy');
  return {
    ...actual,
    predictPostflop: (spot: Parameters<typeof actual.predictPostflop>[0]) => {
      captured.spots.push(spot);
      return actual.predictPostflop(spot);
    },
  };
});

// DecisionEngine loads opponent stats from IndexedDB, absent in node.
vi.mock('../src/storage/db', async () => {
  const actual = await vi.importActual<typeof import('../src/storage/db')>('../src/storage/db');
  return { ...actual, getPlayerStats: async () => null, savePlayerStats: async () => {} };
});

import { DecisionEngine } from '../src/core/engine';
import { parseRow } from '../ml/prep';
import { encodeSpot, Spot } from '../src/core/ml/features';
import { evaluateHand } from '../src/core/equity/hand-eval';
import { cardToId } from '../src/core/cfr/card-utils';
import { Action, GameState, Player, Street } from '../src/types/poker';
import { card } from './helpers';

beforeEach(() => {
  captured.spots.length = 0;
  vi.spyOn(Math, 'random').mockReturnValue(0.99);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const BB = 20;

const HEADER: Record<string, number> = {
  '': 0, preflop_action: 1, board_flop: 2, board_turn: 3, board_river: 4,
  aggressor_position: 5, postflop_action: 6, evaluation_at: 7, available_moves: 8,
  pot_size: 9, hero_position: 10, holding: 11, correct_decision: 12,
};

interface Case {
  name: string;
  street: Exclude<Street, 'preflop'>;
  board: string[];          // 3-5 cards, flop first
  hole: [string, string];
  heroIP: boolean;
  heroIsPFA: boolean;
  pot: number;              // includes every chip wagered this street
  currentBet: number;       // highest wager this street (raise-to total)
  heroBet: number;          // hero's chips already in on this street
  heroStack: number;        // behind
  villainStack: number;     // behind
  history: Partial<Record<Street, Action[]>>;
  seq: string;              // PokerBench postflop_action for the same line
  /** available_moves for the same spot; SIZE is replaced by the engine's size. */
  moves: string;
}

function playersFor(c: Case): Player[] {
  const mk = (name: string, isHero: boolean, ip: boolean, stack: number, bet: number, seat: number): Player => ({
    name, stack, position: ip ? 'BTN' : 'BB', isDealer: ip, isSittingOut: false,
    seatIndex: seat, isHero, currentBet: bet, hasActed: false,
  });
  return [
    mk('Hero', true, c.heroIP, c.heroStack, c.heroBet, 0),
    mk('Villain', false, !c.heroIP, c.villainStack, c.currentBet, 1),
  ];
}

function stateFor(c: Case): GameState {
  const pfRaiser = c.heroIsPFA ? 'Hero' : 'Villain';
  const pfCaller = c.heroIsPFA ? 'Villain' : 'Hero';
  return {
    tableId: 't', handNumber: 1, street: c.street, pot: c.pot, sidePots: [],
    heroCards: [card(c.hole[0]), card(c.hole[1])],
    communityCards: c.board.map(card),
    players: playersFor(c),
    heroIndex: 0, dealerIndex: c.heroIP ? 0 : 1, activePlayerIndex: 0,
    currentBet: c.currentBet, minRaise: BB, bigBlind: BB, smallBlind: BB / 2,
    actionHistory: {
      preflop: [{ type: 'raise', amount: 50, playerName: pfRaiser }, { type: 'call', amount: 50, playerName: pfCaller }],
      flop: [], turn: [], river: [],
      ...c.history,
    },
    isOurTurn: true, timestamp: 1,
  };
}

/** The bet / raise-to the engine would make in this spot, from its own sizing helpers. */
function engineSizes(engine: DecisionEngine, s: GameState): { betTo: number; raiseTo: number } {
  const e = engine as any;
  const boardIds = s.communityCards.map(cardToId);
  const heroCat = Math.floor(evaluateHand([cardToId(s.heroCards![0]), cardToId(s.heroCards![1]), ...boardIds]) / 1_000_000);
  const bb = s.bigBlind;
  const pot = s.pot > 0 ? s.pot : 1;
  const betTo = e.chooseBetSize(e.analyzeBoard(s.communityCards), pot, s.street, bb, heroCat);
  const raiseTo = Math.max(e.roundToStake(s.currentBet * 2.5, bb), s.currentBet + betTo);
  return { betTo, raiseTo };
}

function rowFor(c: Case, size: number): string[] {
  const cols = new Array(13).fill('');
  // HU single-raised pot in PokerBench's preflop format (prep's threeBetPot is false).
  cols[1] = 'BTN/2.5bb/BB/call';
  cols[2] = c.board.slice(0, 3).join('');
  cols[3] = c.board[3] ?? '';
  cols[4] = c.board[4] ?? '';
  const heroPos = c.heroIP ? 'IP' : 'OOP';
  const vilPos = c.heroIP ? 'OOP' : 'IP';
  cols[5] = c.heroIsPFA ? heroPos : vilPos;
  cols[6] = c.seq;
  cols[7] = c.street[0].toUpperCase() + c.street.slice(1);
  cols[8] = c.moves.replace('SIZE', String(size));
  cols[9] = String(c.pot);
  cols[10] = heroPos;
  cols[11] = c.hole.join('');
  cols[12] = c.currentBet > c.heroBet ? 'Call' : 'Check';
  return cols;
}

const CASES: Case[] = [
  {
    name: 'flop, IP preflop raiser facing a single bet',
    street: 'flop', board: ['Kc', '7d', '2s'], hole: ['Ah', 'Qh'], heroIP: true, heroIsPFA: true,
    pot: 160, currentBet: 60, heroBet: 0, heroStack: 950, villainStack: 890,
    history: { flop: [{ type: 'bet', amount: 60, playerName: 'Villain' }] },
    seq: 'OOP_BET_60',
    moves: "['Fold', 'Call 60', 'Raise SIZE']",
  },
  {
    name: 'turn raised pot: hero bet 40, villain raised to 120',
    street: 'turn', board: ['Kc', '7d', '2s', 'Th'], hole: ['Jh', 'Td'], heroIP: false, heroIsPFA: false,
    pot: 360, currentBet: 120, heroBet: 40, heroStack: 840, villainStack: 760,
    history: {
      flop: [
        { type: 'check', playerName: 'Hero' },
        { type: 'bet', amount: 30, playerName: 'Villain' },
        { type: 'call', amount: 30, playerName: 'Hero' },
      ],
      turn: [
        { type: 'bet', amount: 40, playerName: 'Hero' },
        { type: 'raise', amount: 120, playerName: 'Villain' },
      ],
    },
    seq: 'OOP_CHECK/IP_BET_30/OOP_CALL/dealcards/Th/OOP_BET_40/IP_RAISE_120',
    moves: "['Fold', 'Call 80', 'Raise SIZE']",
  },
  {
    name: 'river, checked to the IP preflop raiser (not facing a bet)',
    street: 'river', board: ['Kc', '7d', '2s', 'Th', '5c'], hole: ['Ah', 'Kd'], heroIP: true, heroIsPFA: true,
    pot: 300, currentBet: 0, heroBet: 0, heroStack: 850, villainStack: 850,
    history: {
      flop: [{ type: 'check', playerName: 'Villain' }, { type: 'check', playerName: 'Hero' }],
      turn: [{ type: 'check', playerName: 'Villain' }, { type: 'check', playerName: 'Hero' }],
      river: [{ type: 'check', playerName: 'Villain' }],
    },
    seq: 'OOP_CHECK/IP_CHECK/dealcards/Th/OOP_CHECK/IP_CHECK/dealcards/5c/OOP_CHECK',
    moves: "['Check', 'Bet SIZE']",
  },
  {
    name: 'flop facing a bet hero cannot raise over (stack 50 < call 60)',
    street: 'flop', board: ['9c', '8d', '2h'], hole: ['Th', 'Js'], heroIP: true, heroIsPFA: true,
    pot: 160, currentBet: 60, heroBet: 0, heroStack: 50, villainStack: 890,
    history: { flop: [{ type: 'bet', amount: 60, playerName: 'Villain' }] },
    seq: 'OOP_BET_60',
    moves: "['Fold', 'Call 50']",
  },
  {
    name: 'flop facing a bet, raise capped at the all-in (stack 100)',
    street: 'flop', board: ['9c', '8d', '2h'], hole: ['9h', '9s'], heroIP: false, heroIsPFA: false,
    pot: 160, currentBet: 60, heroBet: 0, heroStack: 100, villainStack: 890,
    history: { flop: [{ type: 'check', playerName: 'Hero' }, { type: 'bet', amount: 60, playerName: 'Villain' }] },
    seq: 'OOP_CHECK/IP_BET_60',
    moves: "['Fold', 'Call 60', 'Raise SIZE']",
  },
];

async function engineSpot(c: Case): Promise<{ spot: Spot; sizes: { betTo: number; raiseTo: number } }> {
  const engine = new DecisionEngine();
  const state = stateFor(c);
  const sizes = engineSizes(engine, state);
  await engine.decide(state);
  expect(captured.spots.length).toBe(1);
  return { spot: captured.spots[0] as Spot, sizes };
}

describe('distilled net: serve-side Spot matches ml/prep.ts training encoding', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const { spot, sizes } = await engineSpot(c);
      const offered = c.currentBet > c.heroBet
        ? Math.min(sizes.raiseTo, c.heroStack + c.heroBet)
        : Math.min(sizes.betTo, c.heroStack);
      const parsed = parseRow(rowFor(c, offered), HEADER);
      expect(parsed).not.toBeNull();
      expect(spot).toEqual(parsed!.spot);
      expect(Array.from(encodeSpot(spot))).toEqual(Array.from(encodeSpot(parsed!.spot)));
    });
  }

  it('a villain whose stack reads 0 with no chips in front is unread, not all-in: the bet stays offered', async () => {
    const c = { ...CASES[2], villainStack: 0 };
    const { spot } = await engineSpot(c);
    expect(spot.canBet).toBe(true);
    expect(spot.offeredSizeFrac).toBeGreaterThan(0);
  });

  it('a villain with 0 behind and chips in front this street is all-in: no raise is offered', async () => {
    const c = { ...CASES[0], villainStack: 0 };
    const { spot } = await engineSpot(c);
    expect(spot.canRaise).toBe(false);
    expect(spot.offeredSizeFrac).toBe(0);
  });

  it('decimal stakes: the offered bet is sized off the same pot as the features (not a 1-chip floor)', async () => {
    // A $0.01/$0.02 table: the pot is 0.60, under one unit.
    const c = { ...CASES[2], pot: 0.6, heroStack: 1.7, villainStack: 1.7 };
    const engine = new DecisionEngine();
    const state = { ...stateFor(c), bigBlind: 0.02, smallBlind: 0.01, minRaise: 0.02 };
    const { betTo } = engineSizes(engine, state);
    await engine.decide(state);
    const spot = captured.spots[0] as Spot;
    expect(spot.offeredSizeFrac).toBeCloseTo(betTo / 0.6, 9);
    // chooseBetSize never sizes above 0.90 pot, so the fraction must stay at or under that.
    expect(spot.offeredSizeFrac).toBeLessThanOrEqual(0.9 + 1e-9);
  });

  it('facing a bet, the offered size is a raise-to well above the call (holdout p10 ratio is 2.2)', async () => {
    const { spot } = await engineSpot(CASES[0]);
    expect(spot.toCallFrac).toBeCloseTo(60 / 160, 12);
    expect(spot.offeredSizeFrac / spot.toCallFrac).toBeGreaterThanOrEqual(2);
  });
});
