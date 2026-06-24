/**
 * Leduc Hold'em — a standard small benchmark for imperfect-information solvers
 * (Southey et al. 2005, "Bayes' Bluff: Opponent Modelling in Poker").
 *
 * Rules:
 *   - Deck: 6 cards = 2 suits x 3 ranks {J, Q, K}. Ranks encoded 0,1,2; suits
 *     are irrelevant except that two cards may share a rank (a pair).
 *   - Each player antes 1. One private card each (round 1). After round-1
 *     betting, one public board card is revealed (round 2), then more betting.
 *   - Betting: check/call/raise/fold, capped at 2 raises per round.
 *     Bet/raise size is 2 in round 1 and 4 in round 2 ("big bet" round).
 *   - Showdown: a player whose private card pairs the board wins. Otherwise the
 *     higher private card wins. Equal ranks (and no pair) split the pot.
 *
 * Full-game exploitability converges toward 0 under CFR; we use it as the
 * convergence oracle for the larger benchmark game.
 */
import { Game, Player, CHANCE } from '../game';

/** Action indices. */
export const FOLD = 0;
export const CALL = 1; // also "check" when there is nothing to call
export const RAISE = 2; // also "bet" when opening

const RANKS = 3; // J, Q, K
const DECK_SIZE = 6; // two suits per rank
const ANTE = 1;
const RAISE_SIZE = [2, 4] as const; // per round
const MAX_RAISES = 2; // per round

/** Full 6-card deck encoded as rank*2 + suit. Rank = floor(card/2). */
const FULL_DECK: number[] = Array.from({ length: DECK_SIZE }, (_, i) => i);

function rankOf(card: number): number {
  return card >> 1;
}

export interface LeducHistory {
  /** Private cards [p0, p1]; -1 before dealt. */
  readonly priv: readonly [number, number];
  /** Public board card; -1 before round 2. */
  readonly board: number;
  /** Current betting round: 0 (pre-board) or 1 (post-board). */
  readonly round: number;
  /** Betting actions in the current round, e.g. "", "r", "rc", "crr". */
  readonly roundHistory: string;
  /** Closed betting history of round 1 (empty during round 1). */
  readonly round0History: string;
  /** Whether a terminal fold occurred. */
  readonly foldedBy: number; // -1 = nobody folded
  /** Chips committed by each player so far (includes antes). */
  readonly committed: readonly [number, number];
}

export class LeducPoker implements Game<LeducHistory> {
  root(): LeducHistory {
    return {
      priv: [-1, -1],
      board: -1,
      round: 0,
      roundHistory: '',
      round0History: '',
      foldedBy: -1,
      committed: [ANTE, ANTE],
    };
  }

  numPlayers(): number {
    return 2;
  }

  isChance(h: LeducHistory): boolean {
    if (h.priv[0] < 0 || h.priv[1] < 0) return true; // need to deal privates
    if (h.round === 1 && h.board < 0) return true; // need to deal board
    return false;
  }

  chanceOutcomes(h: LeducHistory): Array<{ next: LeducHistory; prob: number }> {
    if (h.priv[0] < 0 || h.priv[1] < 0) {
      // Deal two distinct private cards. Enumerate ordered pairs (a != b).
      const out: Array<{ next: LeducHistory; prob: number }> = [];
      const n = FULL_DECK.length;
      const prob = 1 / (n * (n - 1));
      for (const a of FULL_DECK) {
        for (const b of FULL_DECK) {
          if (a === b) continue;
          out.push({ next: { ...h, priv: [a, b] }, prob });
        }
      }
      return out;
    }
    // Deal the public board card from the 4 remaining cards, each equally likely.
    const remaining = FULL_DECK.filter((c) => c !== h.priv[0] && c !== h.priv[1]);
    const prob = 1 / remaining.length;
    return remaining.map((c) => ({ next: { ...h, board: c }, prob }));
  }

  currentPlayer(h: LeducHistory): Player {
    // In each round the first actor is player 0. The acting player alternates
    // with the number of actions taken this round.
    return h.roundHistory.length % 2;
  }

  isTerminal(h: LeducHistory): boolean {
    if (h.foldedBy >= 0) return true;
    // Game ends when round 1 betting closes (after the board round).
    return h.round === 1 && this.roundClosed(h.roundHistory);
  }

  /**
   * A betting round is closed when:
   *   - both players checked ("cc"), or
   *   - a bet/raise was ultimately called (history ends in "c" and contains "r").
   * A lone leading "c" (check) does NOT close the round (opponent may still bet).
   */
  private roundClosed(rh: string): boolean {
    if (rh.length === 0) return false;
    if (rh === 'cc') return true;
    const last = rh[rh.length - 1];
    return last === 'c' && rh.includes('r');
  }

  private numRaises(rh: string): number {
    let n = 0;
    for (const ch of rh) if (ch === 'r') n++;
    return n;
  }

  actions(h: LeducHistory): number[] {
    const rh = h.roundHistory;
    const acts: number[] = [];
    const facingBet = rh.length > 0 && rh[rh.length - 1] === 'r';

    if (facingBet) {
      acts.push(FOLD); // fold only makes sense when facing a bet/raise
    }
    acts.push(CALL); // check (no bet) or call (facing bet) — always available
    if (this.numRaises(rh) < MAX_RAISES) {
      acts.push(RAISE); // bet or raise while under the cap
    }
    return acts;
  }

  next(h: LeducHistory, a: number): LeducHistory {
    const player = this.currentPlayer(h);
    const rh = h.roundHistory;
    const facingBet = rh.length > 0 && rh[rh.length - 1] === 'r';
    const committed: [number, number] = [h.committed[0], h.committed[1]];

    if (a === FOLD) {
      return { ...h, roundHistory: rh + 'f', foldedBy: player, committed };
    }

    if (a === CALL) {
      if (facingBet) {
        // Match the opponent's outstanding amount.
        const opp = 1 - player;
        committed[player] = committed[opp];
      }
      const newRh = rh + 'c';
      return this.advanceIfClosed({ ...h, roundHistory: newRh, committed });
    }

    // RAISE / BET
    const opp = 1 - player;
    const size = RAISE_SIZE[h.round];
    // To raise: first match any outstanding bet, then add a raise increment.
    committed[player] = committed[opp] + size;
    const newRh = rh + 'r';
    return { ...h, roundHistory: newRh, committed };
  }

  /** If the betting round just closed, advance to round 2 (deal board) or end. */
  private advanceIfClosed(h: LeducHistory): LeducHistory {
    if (!this.roundClosed(h.roundHistory)) return h;
    if (h.round === 0) {
      // Move to round 2; board will be dealt by a chance node. Preserve the
      // closed round-1 line so it remains part of every round-2 info set.
      return { ...h, round: 1, round0History: h.roundHistory, roundHistory: '', board: -1 };
    }
    // Round 2 closed: terminal; nothing to change (isTerminal handles it).
    return h;
  }

  utility(h: LeducHistory, player: Player): number {
    const u = this.utilityP0(h);
    return player === 0 ? u : -u;
  }

  /** Net chips for player 0 at a terminal history. */
  private utilityP0(h: LeducHistory): number {
    if (h.foldedBy >= 0) {
      // The folder loses what they committed; the other wins that amount.
      const winner = 1 - h.foldedBy;
      const loserContribution = h.committed[h.foldedBy];
      return winner === 0 ? loserContribution : -loserContribution;
    }
    // Showdown. Pot is split / awarded based on hand strength. Net for P0 is
    // determined by the smaller of the two contributions at stake.
    const stake = Math.min(h.committed[0], h.committed[1]);
    const result = this.showdownWinner(h); // 0 => P0, 1 => P1, -1 => tie
    if (result === 0) return stake;
    if (result === 1) return -stake;
    return 0;
  }

  /** Returns 0 if P0 wins, 1 if P1 wins, -1 on a tie. */
  private showdownWinner(h: LeducHistory): number {
    const r0 = rankOf(h.priv[0]);
    const r1 = rankOf(h.priv[1]);
    const board = rankOf(h.board);
    const p0Pair = r0 === board;
    const p1Pair = r1 === board;
    if (p0Pair && !p1Pair) return 0;
    if (p1Pair && !p0Pair) return 1;
    // Either both pair (impossible with distinct ranks/one board) or neither:
    // compare private ranks.
    if (r0 > r1) return 0;
    if (r1 > r0) return 1;
    return -1;
  }

  infoSetKey(h: LeducHistory): string {
    const player = this.currentPlayer(h);
    const priv = rankOf(h.priv[player]);
    const board = h.board >= 0 ? rankOf(h.board) : -1;
    // The acting player observes: own private rank, the board (if revealed),
    // the round, the closed round-1 betting line, and the current round's line.
    // Including round0History keeps round-2 info sets distinct across the
    // different ways round 1 could have been played.
    return `${priv}|${board}|r${h.round}|${h.round0History}|${h.roundHistory}`;
  }
}
