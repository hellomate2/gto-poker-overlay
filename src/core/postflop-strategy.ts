import { CardId } from '../types/poker';
import { createDeck } from './cfr/card-utils';

// ============================================================
// Transparent Villain Continuing-Range Model
//
// Given a board and a coarse context (was there aggression? heads-up vs
// multiway?), enumerate a plausible list of villain hole-card combos that would
// "continue" — i.e. the hands villain would keep betting/calling with. The
// point is NOT to be a perfect solver range; it just has to be REALISTIC so
// that, e.g., a flush board actually contains made-flush combos. Hero's equity
// is then measured against THIS range (range-equity.ts), which is what stops
// the bot from value-betting hands that are crushed.
//
// Everything here is explicit and commented so it is easy to debug.
// ============================================================

export interface RangeContext {
  /** Was there aggression to react to (villain bet, or hero faces a bet)? A
   *  betting/continuing range is tighter and more made-hand heavy. */
  aggression: boolean;
  /** Multiway pots tighten the continuing range further (more hands beat you). */
  multiway: boolean;
}

const SUITS = [0, 1, 2, 3];

/** rank index of a card id (0=2 .. 12=A) */
function rankOf(c: CardId): number {
  return (c / 4) | 0;
}
/** suit index of a card id (0..3) */
function suitOf(c: CardId): number {
  return c % 4;
}

/**
 * Build the villain continuing range as a concrete list of [CardId, CardId]
 * combos, excluding any card already used by hero or visible on the board.
 *
 * Categories included (each commented):
 *   - made flushes (only when the board makes a flush possible)
 *   - sets / two pair / trips that use board ranks
 *   - top-pair-or-better one-pair hands (pairs that pair a board card with a
 *     reasonable kicker, plus overpairs)
 *   - pocket pairs (incl. board-paired full-house/quads candidates)
 *   - made straights when the board is connected enough
 *   - strong draws (flush draws, open-enders) — only when no aggression yet,
 *     since a draw "continues" by calling but is folded out of a betting range
 *     more often.
 */
export function villainContinuingRange(
  heroCards: [CardId, CardId],
  board: CardId[],
  ctx: RangeContext,
): [CardId, CardId][] {
  const blocked = new Set<CardId>([...heroCards, ...board]);
  const deck = createDeck().filter(c => !blocked.has(c));

  const boardRanks = board.map(rankOf);
  const boardRankSet = new Set(boardRanks);

  // Suit counts on the board -> is a flush possible, and in which suit.
  const boardSuitCount = [0, 0, 0, 0];
  for (const c of board) boardSuitCount[suitOf(c)]++;
  // A villain flush is possible if any suit already has >=3 on the board (they
  // hold two of that suit) OR >=4 on the board (they hold one). We model the
  // common case: board has 3+ of a suit (monotone/flush board) or 4+.
  const flushSuit = boardSuitCount.findIndex(n => n >= 3);
  const flushBoard = flushSuit >= 0;

  // Board connectivity for straight plausibility.
  const sortedBoardRanks = [...new Set(boardRanks)].sort((a, b) => a - b);
  const boardSpan =
    sortedBoardRanks.length >= 2
      ? sortedBoardRanks[sortedBoardRanks.length - 1] - sortedBoardRanks[0]
      : 0;
  // "Straighty" if the three+ board cards are within a 4-rank window (so two
  // hole cards can complete a straight).
  const straightBoard = sortedBoardRanks.length >= 3 && boardSpan <= 4;

  const combos: [CardId, CardId][] = [];
  const seen = new Set<string>();
  const add = (a: CardId, b: CardId) => {
    if (a === b) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo},${hi}`;
    if (seen.has(key)) return;
    seen.add(key);
    combos.push([lo, hi]);
  };

  // -------- 1. Made flushes (only on a flush board) --------
  // Villain holds two cards of the flush suit. This is the category the old
  // random-hand model ignored, which caused the two-pair-on-flush-board blunder.
  if (flushBoard) {
    const flushCards = deck.filter(c => suitOf(c) === flushSuit);
    for (let i = 0; i < flushCards.length; i++) {
      for (let j = i + 1; j < flushCards.length; j++) {
        add(flushCards[i], flushCards[j]);
      }
    }
    // On a 4-flush board villain only needs ONE card of the suit to have a
    // flush, so include one-card flushes too.
    if (boardSuitCount[flushSuit] >= 4) {
      const offSuit = deck.filter(c => suitOf(c) !== flushSuit);
      for (const fc of flushCards) {
        for (const oc of offSuit) add(fc, oc);
      }
    }
  }

  // -------- 2. Pocket pairs (sets on paired-with-board, overpairs, etc.) --------
  // Every pocket pair continues some of the time: it is either a set (matches a
  // board rank), an overpair, or a strong underpair. Cheap to enumerate.
  for (let r = 0; r < 13; r++) {
    const ofRank = deck.filter(c => rankOf(c) === r);
    for (let i = 0; i < ofRank.length; i++) {
      for (let j = i + 1; j < ofRank.length; j++) {
        // Sets always continue. Overpairs (pair higher than every board card)
        // continue. Lower pocket pairs continue when there's no aggression
        // (they peel) but fold to aggression on scary boards.
        const isSet = boardRankSet.has(r);
        const isOverpair = boardRanks.every(br => r > br);
        if (isSet || isOverpair) {
          add(ofRank[i], ofRank[j]);
        } else if (!ctx.aggression) {
          // medium/low pairs peel without aggression
          add(ofRank[i], ofRank[j]);
        }
      }
    }
  }

  // -------- 3. Hands that pair the board (top pair+, two pair, trips) --------
  // Villain holds one card matching a board rank (a "made pair") plus a kicker.
  // We restrict the matched board rank to the TOP couple of board ranks for the
  // aggression case (weak pairs fold), and allow any board pair otherwise.
  const topBoardRank = sortedBoardRanks[sortedBoardRanks.length - 1] ?? -1;
  const secondBoardRank = sortedBoardRanks[sortedBoardRanks.length - 2] ?? -1;
  for (const br of sortedBoardRanks) {
    // Under aggression, only top-pair / second-pair continue as one-pair hands.
    if (ctx.aggression && br !== topBoardRank && br !== secondBoardRank) continue;
    const pairCards = deck.filter(c => rankOf(c) === br);
    for (const pc of pairCards) {
      // Kicker: any other live card. Restrict to a decent kicker (>= rank 6 i.e.
      // "8" or better) to keep the range plausible and bounded.
      const kickers = deck.filter(
        c => c !== pc && (rankOf(c) >= 6 || boardRankSet.has(rankOf(c))),
      );
      for (const k of kickers) add(pc, k);
    }
  }

  // -------- 4. Made straights (only on connected boards) --------
  // Two hole cards filling the straight window. Bounded because we only do this
  // on straighty boards.
  if (straightBoard) {
    const lowEnd = Math.max(0, sortedBoardRanks[0] - 2);
    const highEnd = Math.min(12, sortedBoardRanks[sortedBoardRanks.length - 1] + 2);
    const windowCards = deck.filter(c => {
      const r = rankOf(c);
      return r >= lowEnd && r <= highEnd && !boardRankSet.has(r);
    });
    for (let i = 0; i < windowCards.length; i++) {
      for (let j = i + 1; j < windowCards.length; j++) {
        add(windowCards[i], windowCards[j]);
      }
    }
  }

  // -------- 5. Strong draws (only when no aggression to face) --------
  // Flush draws (two of a two-tone suit) and overcard+gapper combos. These
  // "continue" by calling but are not part of a tight betting range, so we omit
  // them when there is aggression.
  if (!ctx.aggression) {
    // flush draws: a suit with exactly 2 on board
    const drawSuit = boardSuitCount.findIndex(n => n === 2);
    if (drawSuit >= 0) {
      const fd = deck.filter(c => suitOf(c) === drawSuit);
      for (let i = 0; i < fd.length; i++) {
        for (let j = i + 1; j < fd.length; j++) add(fd[i], fd[j]);
      }
    }
  }

  // In multiway pots the continuing range is effectively wider/stronger; we keep
  // the same combos but the caller can interpret a higher bar. (No structural
  // change needed — more opponents = more of these combos are live.) The flag is
  // accepted for future tuning and documented intent.
  void ctx.multiway;

  return combos;
}
