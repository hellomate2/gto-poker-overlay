// ============================================================
// All-in EV adjustment for heads-up hands.
//
// When both players are all-in (or one is all-in and called) before the river,
// the rest of the board is dealt with no more decisions, so the realized result
// is mostly run-out luck. The adjusted result replaces the realized net with its
// expectation over every possible run-out:
//
//   matched = min(committed[0], committed[1])   (the uncalled excess goes back)
//   EV net for seat s = matched * (P(s wins) - P(s loses))
//
// which is exact for heads-up, where the pot is only the two contributions.
// P(win) / P(lose) come from enumerating every remaining board exactly: 44
// run-outs from the turn, 990 from the flop, 1,712,304 preflop. The preflop
// case took 511 to 574 ms per call on Dev's Mac (3 calls of exactEquity on
// 2026-10-09 with tsx, machine load average about 12).
// Hands that end on a fold or reach a river showdown keep their realized net.
// ============================================================

import { evaluateHand } from '../../src/core/equity/hand-eval';
import { RingHandLog } from '../ring';
import { Street } from '../../src/types/poker';

const BOARD_AT: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };

export interface RunoutEquity { win: number; tie: number; lose: number; runouts: number }

/** Exact equity of hole `a` vs hole `b` over every completion of `board` (0-5 cards). */
export function exactEquity(a: [number, number], b: [number, number], board: number[]): RunoutEquity {
  const used = new Set<number>([...a, ...b, ...board]);
  if (used.size !== 4 + board.length) throw new Error('exactEquity: duplicate cards');
  const rest: number[] = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c);
  const need = 5 - board.length;
  let win = 0, tie = 0, lose = 0;
  const ha = [a[0], a[1], ...board, 0, 0, 0, 0, 0].slice(0, 7);
  const hb = [b[0], b[1], ...board, 0, 0, 0, 0, 0].slice(0, 7);
  const base = 2 + board.length;
  const m = rest.length;
  const idx = new Array<number>(need).fill(0);
  const rec = (depth: number, from: number) => {
    if (depth === need) {
      const x = evaluateHand(ha), y = evaluateHand(hb);
      if (x > y) win++; else if (x < y) lose++; else tie++;
      return;
    }
    for (let i = from; i <= m - (need - depth); i++) {
      idx[depth] = i;
      ha[base + depth] = rest[i];
      hb[base + depth] = rest[i];
      rec(depth + 1, i + 1);
    }
  };
  rec(0, 0);
  const runouts = win + tie + lose;
  return { win: win / runouts, tie: tie / runouts, lose: lose / runouts, runouts };
}

export interface AllInInfo {
  /** Board cards known when the money went in (0, 3 or 4). */
  boardCards: number;
  /** Equity of `seat` over the remaining run-outs. */
  equity: RunoutEquity;
  /** Chips each player had at risk against the other. */
  matched: number;
  /** Expected net for `seat` in chips. */
  evNet: number;
}

/**
 * All-in adjustment for `seat` in a heads-up hand log, or null when the hand
 * did not go to showdown with cards still to come.
 */
export function allInAdjustment(log: RingHandLog, seat: number): AllInInfo | null {
  if (log.holes.length !== 2) throw new Error('allInAdjustment is heads-up only');
  if (!log.wentToShowdown) return null;
  // Board size at the last decision. With no decision at all (a blind put a
  // player all-in) the money went in preflop.
  const last = log.actions.length ? log.actions[log.actions.length - 1] : undefined;
  const boardCards = last ? BOARD_AT[last.street] : 0;
  if (boardCards >= 5) return null;
  const other = 1 - seat;
  const equity = exactEquity(log.holes[seat], log.holes[other], log.board.slice(0, boardCards));
  const matched = Math.min(log.committed[0], log.committed[1]);
  return { boardCards, equity, matched, evNet: matched * (equity.win - equity.lose) };
}
