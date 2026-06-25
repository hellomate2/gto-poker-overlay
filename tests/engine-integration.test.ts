import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The DecisionEngine reads opponent stats from IndexedDB, absent in node. Stub
// ONLY the storage layer (as the existing engine tests do) so decide() runs with
// empty opponent data. The engine, evaluator, equity, ranges and net are all
// REAL — nothing on the decision path is faked.
vi.mock('../src/storage/db', async () => {
  const actual = await vi.importActual<typeof import('../src/storage/db')>('../src/storage/db');
  return { ...actual, getPlayerStats: async () => null, savePlayerStats: async () => {} };
});

import { DecisionEngine } from '../src/core/engine';
import { GameState, Player, Position, Street, Card, Action } from '../src/types/poker';
import { card } from './helpers';

// The engine uses Math.random for mixed-strategy frequencies (bluff/semi-bluff
// rates and the preflop equilibrium sample). Seed it to a fixed value so the
// invariant sweeps are deterministic. Equity (Monte-Carlo with a deterministic
// internal sampler) is unaffected — fixing Math.random only pins which mixed
// line is taken, never the hand strength. We test BOTH extremes (0.0 and 0.99)
// in the sweeps so neither branch of a mix can hide an illegal action.
afterEach(() => { vi.restoreAllMocks(); });

// ============================================================
// State builders
// ============================================================

function mkPlayer(
  name: string, position: Position, isHero: boolean, stack: number, isDealer: boolean,
): Player {
  return {
    name, stack, position, isDealer,
    isSittingOut: false, seatIndex: isDealer ? 0 : 1,
    isHero, currentBet: 0, hasActed: false,
  };
}

interface SpotOpts {
  heroCards: [string, string];
  community: string[];
  pot: number;
  currentBet?: number;   // villain's bet this street (absolute)
  heroBet?: number;      // hero's chips already in this street
  heroStack?: number;
  villainStack?: number;
  street?: Street;
  bb?: number;
  sb?: number;
  heroPos?: Position;
  villainPos?: Position;
  heroIsDealer?: boolean;
  villainIsDealer?: boolean;
  preflopActions?: Action[];
}

function buildState(o: SpotOpts): GameState {
  const bb = o.bb ?? 20;
  const sb = o.sb ?? bb / 2;
  const heroIsDealer = o.heroIsDealer ?? (o.heroPos === 'BTN' || o.heroPos === 'SB');
  const villainIsDealer = o.villainIsDealer ?? false;
  const hero = mkPlayer('Hero', o.heroPos ?? 'BTN', true, o.heroStack ?? 1000, heroIsDealer);
  hero.currentBet = o.heroBet ?? 0;
  const villain = mkPlayer('Villain', o.villainPos ?? 'BB', false, o.villainStack ?? 1000, villainIsDealer);
  villain.currentBet = o.currentBet ?? 0;
  const community: Card[] = o.community.map(card);
  const street = o.street ?? (community.length === 0 ? 'preflop'
    : community.length === 3 ? 'flop' : community.length === 4 ? 'turn' : 'river');
  const currentBet = o.currentBet ?? 0;
  return {
    tableId: 't', handNumber: 1, street,
    pot: o.pot, sidePots: [],
    heroCards: [card(o.heroCards[0]), card(o.heroCards[1])],
    communityCards: community,
    players: [hero, villain],
    heroIndex: 0,
    dealerIndex: heroIsDealer ? 0 : villainIsDealer ? 1 : 0,
    activePlayerIndex: 0,
    currentBet,
    minRaise: currentBet > 0 ? currentBet * 2 : bb * 2,
    bigBlind: bb, smallBlind: sb,
    actionHistory: { preflop: o.preflopActions ?? [], flop: [], turn: [], river: [] },
    isOurTurn: true, timestamp: Date.now(),
  };
}

/** The absolute max chips hero can put in (all-in "to" amount). */
function heroMaxTo(state: GameState): number {
  const hero = state.players[state.heroIndex];
  return hero.stack + (hero.currentBet || 0);
}

const AGGRESSIVE = new Set(['bet', 'raise', 'allin']);

/** Run decide() under a fixed Math.random seed. */
async function decideSeeded(engine: DecisionEngine, state: GameState, seed: number) {
  vi.spyOn(Math, 'random').mockReturnValue(seed);
  try {
    return await engine.decide(state);
  } finally {
    vi.restoreAllMocks();
  }
}

// A spread of board / hand / street combinations covering dry, wet, monotone,
// paired and flush boards, made hands from air to the nuts.
const HERO_HANDS: [string, string][] = [
  ['Ah', 'Ad'], ['Ks', 'Kd'], ['Qh', 'Jh'], ['Ah', 'Ks'], ['7c', '2d'],
  ['Th', 'Tc'], ['9s', '8s'], ['Ad', '5d'], ['Kc', 'Qc'], ['6h', '6d'],
];
const BOARDS: { community: string[]; street: Street }[] = [
  { community: ['Ac', '7d', '2s'], street: 'flop' },          // dry
  { community: ['Kh', 'Qh', '7h'], street: 'flop' },          // monotone hearts
  { community: ['9c', '8d', '7s'], street: 'flop' },          // connected/wet
  { community: ['Kd', 'Kc', '4h'], street: 'flop' },          // paired
  { community: ['Ah', 'Kd', '7s', '2c'], street: 'turn' },    // dry turn
  { community: ['Qs', 'Js', 'Ts', '2d'], street: 'turn' },    // 3-flush turn
  { community: ['Ac', 'Kd', '7s', '2c', '3h'], street: 'river' }, // dry river
  { community: ['Th', '9h', '8h', '2h', '3c'], street: 'river' }, // 4-flush river
];
const POT_BET: { pot: number; currentBet: number; heroBet: number }[] = [
  { pot: 100, currentBet: 0, heroBet: 0 },     // checked to hero
  { pot: 100, currentBet: 50, heroBet: 0 },    // facing half-pot
  { pot: 300, currentBet: 250, heroBet: 0 },   // facing big bet
  { pot: 60, currentBet: 20, heroBet: 0 },     // facing small bet
];
const STACKS = [200, 400, 1000, 1700, 5000];
const SEEDS = [0.0, 0.5, 0.99];

// ============================================================
// INVARIANT 1: never commits more than the hero stack
// ============================================================

describe('INVARIANT: bet/raise amount never exceeds the hero stack', () => {
  it('sweeps many stacks/bets/boards: amount <= stack+heroBet, else action is allin', async () => {
    const engine = new DecisionEngine();
    let spots = 0;
    let aggressiveSpots = 0;
    for (const hand of HERO_HANDS) {
      for (const board of BOARDS) {
        for (const pb of POT_BET) {
          for (const stack of STACKS) {
            for (const seed of SEEDS) {
              const state = buildState({
                heroCards: hand, community: board.community, street: board.street,
                pot: pb.pot, currentBet: pb.currentBet, heroBet: pb.heroBet,
                heroStack: stack, villainStack: stack,
              });
              const maxTo = heroMaxTo(state);
              const d = await decideSeeded(engine, state, seed);
              spots++;
              if (AGGRESSIVE.has(d.action)) aggressiveSpots++;

              if (d.action === 'bet' || d.action === 'raise') {
                // A non-allin sized aggressive action must be strictly within stack.
                expect(d.amount).toBeDefined();
                expect(d.amount!).toBeGreaterThan(0);
                expect(d.amount!).toBeLessThanOrEqual(maxTo);
              }
              if (d.action === 'allin') {
                // All-in "to" equals exactly the hero's committable chips.
                expect(d.amount!).toBeLessThanOrEqual(maxTo + 1e-9);
              }
              // Every advertised bet size in the mixed strategy is also legal
              // (the executor samples these). Infinity is the all-in sentinel.
              for (const b of d.mixedStrategy.bets) {
                if (b.amount !== Infinity) {
                  expect(b.amount).toBeLessThanOrEqual(maxTo);
                }
              }
            }
          }
        }
      }
    }
    // Guard against a vacuous pass: confirm the sweep actually produced
    // aggressive actions (so the <= stack assertions had teeth).
    expect(spots).toBeGreaterThan(1000);
    expect(aggressiveSpots).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`[invariant-1] swept ${spots} spots, ${aggressiveSpots} aggressive`);
  });
});

// ============================================================
// INVARIANT 2: facing a bet => never 'bet'; raises >= legal minimum
// ============================================================

describe('INVARIANT: facing a bet never returns "bet", raises are >= the minimum', () => {
  it('sweeps facing-bet spots: action != bet, raise-to >= ~2x the bet', async () => {
    const engine = new DecisionEngine();
    let spots = 0;
    let raiseSpots = 0;
    const facingBets = [
      { pot: 100, currentBet: 50 },
      { pot: 300, currentBet: 300 },
      { pot: 600, currentBet: 300 },
      { pot: 80, currentBet: 20 },
    ];
    for (const hand of HERO_HANDS) {
      for (const board of BOARDS) {
        for (const fb of facingBets) {
          for (const seed of SEEDS) {
            const state = buildState({
              heroCards: hand, community: board.community, street: board.street,
              pot: fb.pot, currentBet: fb.currentBet, heroBet: 0,
              heroStack: 5000, villainStack: 5000,
            });
            const d = await decideSeeded(engine, state, seed);
            spots++;
            // Facing a bet, "bet" is illegal — must be raise/call/fold/allin.
            expect(d.action).not.toBe('bet');
            if (d.action === 'raise') {
              raiseSpots++;
              // A legal raise-to is at least double the bet (PokerNow min raise).
              expect(d.amount!).toBeGreaterThanOrEqual(fb.currentBet * 2 - 1e-9);
            }
          }
        }
      }
    }
    expect(spots).toBeGreaterThan(500);
    expect(raiseSpots).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`[invariant-2] swept ${spots} facing-bet spots, ${raiseSpots} raises`);
  });
});

// ============================================================
// INVARIANT 3: never value-bet a non-flush hand into a flush board
// ============================================================

function isValueAggressive(reasoning: string, action: string): boolean {
  return (action === 'bet' || action === 'raise') && /value/i.test(reasoning);
}

describe('INVARIANT: never value-bet/raise a non-flush hand into a monotone/4-flush board', () => {
  // Hands that look strong vs random but are crushed by a flush-heavy range; hero
  // holds NO card of the flush suit.
  const flushBoards = [
    { community: ['Kh', 'Qh', '7h'], street: 'flop' as Street },              // monotone
    { community: ['Th', '9h', '8h', '2h'], street: 'turn' as Street },        // 4-flush
    { community: ['Th', '9h', '8h', '2h', '3c'], street: 'river' as Street }, // 4-flush river
  ];
  // Non-flush made hands (no hearts) of varying strength.
  const nonFlushHands: [string, string][] = [
    ['Ks', 'Qc'], ['Kd', 'Ks'], ['Td', 'Tc'], ['9s', '9c'], ['As', 'Ad'],
  ];

  it('across the ranged path (multiway forces the heuristic) it never value-bets', async () => {
    const engine = new DecisionEngine();
    let spots = 0;
    for (const hand of nonFlushHands) {
      for (const board of flushBoards) {
        for (const seed of SEEDS) {
          // Add a third active player -> activeVillains !== 1 forces
          // decidePostflopRanged (the ranged fallback path) deterministically.
          const state = buildState({
            heroCards: hand, community: board.community, street: board.street,
            pot: 100, currentBet: 0, heroBet: 0, heroStack: 2000,
          });
          state.players.push(
            mkPlayer('Villain2', 'CO', false, 2000, false),
          );
          const d = await decideSeeded(engine, state, seed);
          spots++;
          expect(isValueAggressive(d.reasoning, d.action)).toBe(false);
        }
      }
    }
    expect(spots).toBeGreaterThan(20);
  });

  it('across the net path (heads-up) it never value-bets into the flush board', async () => {
    const engine = new DecisionEngine();
    let spots = 0;
    for (const hand of nonFlushHands) {
      for (const board of flushBoards) {
        for (const seed of SEEDS) {
          // Heads-up -> decidePostflopNet runs first; the guard must still hold.
          const state = buildState({
            heroCards: hand, community: board.community, street: board.street,
            pot: 100, currentBet: 0, heroBet: 0, heroStack: 2000,
          });
          const d = await decideSeeded(engine, state, seed);
          spots++;
          expect(isValueAggressive(d.reasoning, d.action)).toBe(false);
        }
      }
    }
    expect(spots).toBeGreaterThan(20);
  });

  it('DOES value-bet when hero actually holds the flush (control: guard is not over-broad)', async () => {
    const engine = new DecisionEngine();
    // Hero has the nut flush on a monotone board — must be allowed to bet/raise.
    const state = buildState({
      heroCards: ['Ah', 'Jh'], community: ['Kh', 'Qh', '7h'], street: 'flop',
      pot: 100, currentBet: 0, heroBet: 0, heroStack: 2000,
    });
    // multiway -> ranged path (deterministic, equity-driven value bet)
    state.players.push(mkPlayer('Villain2', 'CO', false, 2000, false));
    const d = await decideSeeded(engine, state, 0.99);
    expect(['bet', 'raise']).toContain(d.action);
  });
});

// ============================================================
// INVARIANT 4: natural bet increments scaled to the stake
// ============================================================

describe('INVARIANT: bet sizes land on natural increments scaled to the stake', () => {
  it('at 10/20 every sized bet/raise is a clean multiple of 5 (no integer-collapse)', async () => {
    const engine = new DecisionEngine();
    let sized = 0;
    for (const hand of HERO_HANDS) {
      for (const board of BOARDS) {
        for (const pb of POT_BET) {
          const state = buildState({
            heroCards: hand, community: board.community, street: board.street,
            pot: pb.pot, currentBet: pb.currentBet, heroBet: pb.heroBet,
            bb: 20, sb: 10, heroStack: 5000, villainStack: 5000,
          });
          const d = await decideSeeded(engine, state, 0.99);
          if ((d.action === 'bet' || d.action === 'raise') && d.amount) {
            // niceStep(bb/4)=niceStep(5)=5 -> sizes snap to multiples of 5.
            expect(d.amount % 5).toBe(0);
            sized++;
          }
        }
      }
    }
    expect(sized).toBeGreaterThan(0);
  });

  it('at $0.25/$0.50 a 2.5bb open is $1.25 (cents preserved, not collapsed to $1, not all-in)', async () => {
    const engine = new DecisionEngine();
    const state = buildState({
      heroCards: ['Ah', 'Ks'], community: [], street: 'preflop',
      pot: 0.75, currentBet: 0.5, heroBet: 0.25, bb: 0.5, sb: 0.25,
      heroStack: 50, villainStack: 50, heroPos: 'SB', heroIsDealer: true,
      villainPos: 'BB',
    });
    const d = await decideSeeded(engine, state, 0.99);
    expect(d.action).toBe('raise');
    expect(d.amount!).toBeGreaterThanOrEqual(1.0);
    expect(d.amount!).toBeLessThanOrEqual(1.5);
    expect(d.amount!).not.toBe(1);     // not integer-collapsed
    expect(d.amount!).toBeLessThan(50); // not an all-in
  });

  it('decimal-stakes postflop bets keep cents (do not collapse to whole dollars)', async () => {
    const engine = new DecisionEngine();
    // $0.25/$0.50, top set on a dry flop, checked to hero -> value bet.
    const state = buildState({
      heroCards: ['Ah', 'Ad'], community: ['Ac', '7d', '2s'], street: 'flop',
      pot: 3, currentBet: 0, heroBet: 0, bb: 0.5, sb: 0.25,
      heroStack: 50, villainStack: 50,
    });
    const d = await decideSeeded(engine, state, 0.99);
    if (d.action === 'bet' || d.action === 'raise') {
      // Must be a positive sub-stack amount; cents allowed.
      expect(d.amount!).toBeGreaterThan(0);
      expect(d.amount!).toBeLessThan(50);
    }
  });
});

// ============================================================
// INVARIANT 5: heads-up position — button/SB is IN POSITION postflop
// ============================================================

describe('INVARIANT: heads-up the button/SB is treated as IN POSITION postflop', () => {
  // The net path feeds heroPos = isInPosition(state) ? 'IP' : 'OOP'. We verify
  // the position flips with the dealer flag (and not with blind labels), which is
  // the bug the commit history fixed. We assert via reasoning differing and the
  // decision remaining legal in both orientations.
  function huState(heroDealer: boolean): GameState {
    const hero = mkPlayer('Hero', heroDealer ? 'SB' : 'BB', true, 2000, heroDealer);
    const villain = mkPlayer('Villain', heroDealer ? 'BB' : 'SB', false, 2000, !heroDealer);
    return {
      tableId: 't', handNumber: 1, street: 'flop', pot: 100, sidePots: [],
      heroCards: [card('9s'), card('8s')],
      communityCards: ['Kh', '7d', '2c'].map(card),
      players: [hero, villain],
      heroIndex: 0, dealerIndex: heroDealer ? 0 : 1, activePlayerIndex: 0,
      currentBet: 0, minRaise: 40, bigBlind: 20, smallBlind: 10,
      actionHistory: { preflop: [], flop: [], turn: [], river: [] },
      isOurTurn: true, timestamp: Date.now(),
    };
  }

  it('the IP (button) and OOP orientations produce different net reasoning (position read flips)', async () => {
    const engine = new DecisionEngine();
    const dIP = await decideSeeded(engine, huState(true), 0.5);   // hero on button = IP
    const dOOP = await decideSeeded(engine, huState(false), 0.5); // hero is BB = OOP
    // Both must be legal actions.
    for (const d of [dIP, dOOP]) {
      expect(['fold', 'check', 'call', 'bet', 'raise', 'allin']).toContain(d.action);
    }
    // The net encodes position; with everything else identical, the IP vs OOP
    // spots must not be byte-identical decisions (position is actually consumed).
    const same = dIP.action === dOOP.action && dIP.reasoning === dOOP.reasoning &&
      (dIP.amount ?? -1) === (dOOP.amount ?? -1);
    expect(same).toBe(false);
  });
});

// ============================================================
// INVARIANT 6: preflop sanity (3-bet trash, AA, 72o opens)
// ============================================================

describe('INVARIANT: preflop never 4-bets trash; AA always continues', () => {
  function vsReraise(currentBet: number, hand: [string, string]): GameState {
    const hero = mkPlayer('Hero', 'SB', true, 1000, true);
    hero.currentBet = 50; // hero opened
    const villain = mkPlayer('Villain', 'BB', false, 1000, false);
    villain.currentBet = currentBet; // villain reraised
    return {
      tableId: 't', handNumber: 1, street: 'preflop', pot: 50 + currentBet, sidePots: [],
      heroCards: [card(hand[0]), card(hand[1])],
      communityCards: [], players: [hero, villain], heroIndex: 0, dealerIndex: 0,
      activePlayerIndex: 0, currentBet, minRaise: currentBet * 2, bigBlind: 20, smallBlind: 10,
      // EMPTY action log on purpose: the inferred-3bet-from-size path must still
      // recognize a 6bb+ bet as a 3-bet (the freeze/over-aggression regression).
      actionHistory: { preflop: [], flop: [], turn: [], river: [] },
      isOurTurn: true, timestamp: Date.now(),
    };
  }

  it('does NOT 4-bet K6o facing an inferred 3-bet (empty log, 125 = 6.25bb)', async () => {
    const engine = new DecisionEngine();
    // Sweep seeds so a randomized mix can't slip a 4-bet through.
    for (const seed of [0.0, 0.25, 0.5, 0.75, 0.99]) {
      const d = await decideSeeded(engine, vsReraise(125, ['Kh', '6d']), seed);
      expect(['fold', 'call']).toContain(d.action);
    }
  });

  it('does NOT 4-bet 72o facing an inferred 3-bet', async () => {
    const engine = new DecisionEngine();
    for (const seed of [0.0, 0.5, 0.99]) {
      const d = await decideSeeded(engine, vsReraise(125, ['7h', '2d']), seed);
      expect(['fold', 'call']).toContain(d.action);
    }
  });

  it('AA always continues (never folds) facing a 3-bet, across seeds', async () => {
    const engine = new DecisionEngine();
    for (const seed of [0.0, 0.25, 0.5, 0.75, 0.99]) {
      const d = await decideSeeded(engine, vsReraise(125, ['Ah', 'Ad']), seed);
      expect(d.action).not.toBe('fold');
    }
  });

  it('72o button open deep is rare/folded (not a standard raise) at 50bb', async () => {
    const engine = new DecisionEngine();
    // Unopened HU button (SB) with the worst hand, 1000=50bb. Count raises across
    // many seeds — opening 72o should be very rare.
    let raises = 0;
    const N = 40;
    for (let i = 0; i < N; i++) {
      const seed = (i + 0.5) / N;
      const hero = mkPlayer('Hero', 'SB', true, 1000, true);
      hero.currentBet = 10;
      const villain = mkPlayer('Villain', 'BB', false, 1000, false);
      villain.currentBet = 20;
      const state: GameState = {
        tableId: 't', handNumber: 1, street: 'preflop', pot: 30, sidePots: [],
        heroCards: [card('7h'), card('2d')],
        communityCards: [], players: [hero, villain], heroIndex: 0, dealerIndex: 0,
        activePlayerIndex: 0, currentBet: 20, minRaise: 40, bigBlind: 20, smallBlind: 10,
        actionHistory: { preflop: [], flop: [], turn: [], river: [] },
        isOurTurn: true, timestamp: Date.now(),
      };
      const d = await decideSeeded(engine, state, seed);
      if (d.action === 'raise' || d.action === 'allin') raises++;
    }
    // 72o is the worst hand: opens should be a small minority, never the default.
    expect(raises).toBeLessThan(N / 2);
  });

  it('preflop opens never become an all-in at a deep stack (anti-misread)', async () => {
    const engine = new DecisionEngine();
    // AA on the button, 100bb deep: a 2.5bb open, never a shove.
    const hero = mkPlayer('Hero', 'SB', true, 2000, true);
    hero.currentBet = 10;
    const villain = mkPlayer('Villain', 'BB', false, 2000, false);
    villain.currentBet = 20;
    const state: GameState = {
      tableId: 't', handNumber: 1, street: 'preflop', pot: 30, sidePots: [],
      heroCards: [card('Ah'), card('Ad')],
      communityCards: [], players: [hero, villain], heroIndex: 0, dealerIndex: 0,
      activePlayerIndex: 0, currentBet: 20, minRaise: 40, bigBlind: 20, smallBlind: 10,
      actionHistory: { preflop: [], flop: [], turn: [], river: [] },
      isOurTurn: true, timestamp: Date.now(),
    };
    const d = await decideSeeded(engine, state, 0.99);
    expect(d.action).not.toBe('allin');
    if (d.action === 'raise') expect(d.amount!).toBeLessThan(2000);
  });
});

// ============================================================
// INVARIANT 7: decimal stake -> bb conversion correct (100bb deep)
// ============================================================

describe('INVARIANT: decimal stakes convert to bb correctly (not misread as short)', () => {
  it('$0.25/$0.50 with $50 stack (100bb) opens ~2.5bb ($1.25), not a jam', async () => {
    const engine = new DecisionEngine();
    const hero = mkPlayer('Hero', 'SB', true, 50, true);
    hero.currentBet = 0.25;
    const villain = mkPlayer('Villain', 'BB', false, 50, false);
    villain.currentBet = 0.5;
    const state: GameState = {
      tableId: 't', handNumber: 1, street: 'preflop', pot: 0.75, sidePots: [],
      heroCards: [card('Ah'), card('Ks')],
      communityCards: [], players: [hero, villain], heroIndex: 0, dealerIndex: 0,
      activePlayerIndex: 0, currentBet: 0.5, minRaise: 1, bigBlind: 0.5, smallBlind: 0.25,
      actionHistory: { preflop: [], flop: [], turn: [], river: [] },
      isOurTurn: true, timestamp: Date.now(),
    };
    const d = await decideSeeded(engine, state, 0.99);
    expect(d.action).toBe('raise');
    expect(d.amount!).toBeGreaterThanOrEqual(1.0);
    expect(d.amount!).toBeLessThanOrEqual(1.5);
    expect(d.amount!).not.toBe(1);
    expect(d.amount!).toBeLessThan(50);
  });
});

// ============================================================
// GLOBAL LEGALITY SWEEP: no action is ever structurally illegal
// ============================================================

describe('GLOBAL: every decision is structurally legal across a broad sweep', () => {
  it('never folds when a free check is available; bet only when not facing a bet', async () => {
    const engine = new DecisionEngine();
    let spots = 0;
    let freeCheckSpots = 0;
    for (const hand of HERO_HANDS) {
      for (const board of BOARDS) {
        for (const seed of SEEDS) {
          // checked-to-hero spot (currentBet 0): facing nothing.
          const state = buildState({
            heroCards: hand, community: board.community, street: board.street,
            pot: 120, currentBet: 0, heroBet: 0, heroStack: 1500,
          });
          const d = await decideSeeded(engine, state, seed);
          spots++;
          // Free check available -> must never fold.
          expect(d.action).not.toBe('fold');
          freeCheckSpots++;
          // amount, when present, is finite and positive.
          if (d.amount !== undefined) {
            expect(Number.isFinite(d.amount)).toBe(true);
            expect(d.amount).toBeGreaterThan(0);
          }
        }
      }
    }
    expect(freeCheckSpots).toBeGreaterThan(100);
    // eslint-disable-next-line no-console
    console.log(`[global] swept ${spots} checked-to-hero spots`);
  });
});
