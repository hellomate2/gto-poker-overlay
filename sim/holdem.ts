// ============================================================
// Heads-Up No-Limit Hold'em simulation engine.
//
// Purpose: drive the real DecisionEngine.decide() (the shipped bot) against
// scripted opponent archetypes over many hands, so we can measure the bot's
// ACTUAL action frequencies and win-rate (bb/100) and find strategic leaks.
//
// Since the ring engine landed, this file is a thin 2-seat wrapper over
// sim/ring.ts (playRingHand), so heads-up and multiway results come from the
// same betting / pot / showdown code. The public API (playHand, HandLog with
// net0, Seat 0|1) is unchanged for run.ts and the tests.
//
// Deal layout is the same as the original HU engine (seat 0 gets deck[0] and
// deck[2], seat 1 gets deck[1] and deck[3], board from deck[4]), so a given rng
// seed produces the same cards as before.
//
// Correctness is load-bearing: a buggy game engine produces garbage strategy
// conclusions. Every hand asserts chip conservation (sum of stacks is invariant)
// and that the pot is fully distributed. Run `npm run sim:selftest` to validate.
// ============================================================

import { GameState, Street, ActionType, Card } from '../src/types/poker';
import { playRingHand, SeatAgent, SeatView, ActResult, makeRng } from './ring';

export type { SeatAgent, SeatView, ActResult };
export { makeRng };

export type Seat = 0 | 1;

export interface LoggedAction {
  seat: Seat;
  street: Street;
  type: ActionType;
  voluntary: boolean;
  /** Raise-to amount for bet/raise, chips paid for call. */
  amount?: number;
  /** Global monotonic index across the whole hand, so the runner can reconstruct
   *  who acted first on a street, who the preflop aggressor was, etc. — the
   *  sequencing needed for cbet / fold-to-cbet / 3bet spot detection. */
  order: number;
}

export interface HandLog {
  /** net chip change for seat 0 (negative = lost). seat1 = -seat0. */
  net0: number;
  /** per-seat-per-street action records (in global order). */
  actions: LoggedAction[];
  wentToShowdown: boolean;
  reachedStreet: Street;
  /** A GameState snapshot at hand end (full actionHistory + positions) so the
   *  bot can record it for opponent tracking via tracker.processHand. Always set
   *  by playHand before it returns. */
  finalState?: GameState;
}

export interface HUConfig {
  bb: number;
  sb: number;
  startStackBB: number;   // each seat starts each hand with this many bb (reset per hand = cash-game "deep")
  rng: () => number;
}

const RANKS = '23456789TJQKA';
function shortCard(c: Card): string { return `${c.rank}${c.suit}`; }

/**
 * Play ONE heads-up hand. seat `button` is the SB/dealer (acts first preflop,
 * last postflop). Returns a HandLog. Stacks are reset to startStack each hand
 * (independent-hand cash-game model), which is the right model for measuring
 * per-hand win-rate and frequencies without stack-depth drift.
 */
export async function playHand(
  agents: [SeatAgent, SeatAgent],
  button: Seat,
  cfg: HUConfig,
  handNumber: number,
  deck?: number[],
): Promise<HandLog> {
  const r = await playRingHand(agents, button, cfg, handNumber, deck);
  return {
    net0: r.nets[0],
    actions: r.actions.map(a => ({ ...a, seat: a.seat as Seat })),
    wentToShowdown: r.wentToShowdown,
    reachedStreet: r.reachedStreet,
    finalState: r.finalState,
  };
}

export { shortCard, RANKS };
