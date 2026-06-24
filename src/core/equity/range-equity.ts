import { CardId } from '../../types/poker';
import { createDeck, removeCards, shuffleDeck } from '../cfr/card-utils';
import { evaluateHand } from './hand-eval';

// ============================================================
// Range-vs-Hand Equity
//
// This is the KEY FIX for the postflop blunder bug. The old live logic
// computed equity vs a RANDOM hand (equityVsRandom / quickEquity). Against a
// random hand, a non-nut two pair on a three-flush board still shows ~65-70%
// equity, so the bot value-bet hands that are crushed by villain's actual
// continuing range (e.g. made flushes).
//
// equityVsRange below measures hero's equity averaged over a CONCRETE list of
// villain hole-card combos (the "continuing range"). On a monotone board where
// hero holds no flush, a flush-heavy villain range drags hero's equity far
// below 50%, so the decision logic will check/fold instead of value-betting.
//
// Board completion:
//  - If <=2 board cards remain to come, we ENUMERATE every runout exactly
//    (deterministic, no variance). 1 card -> <=44 runouts, 2 cards -> <=990.
//  - If 3+ remain (flop with no board yet is preflop, not our concern here),
//    we Monte-Carlo sample runouts per combo.
// ============================================================

export interface RangeEquityResult {
  equity: number; // hero win probability (ties count as half), 0..1
  combos: number; // number of villain combos actually evaluated
  samples: number; // total hero-vs-villain showdowns evaluated
}

/**
 * Hero's equity against a defined villain range.
 *
 * @param heroCards    Hero's two hole cards.
 * @param board        Community cards so far (3=flop, 4=turn, 5=river).
 * @param villainCombos Candidate villain hole-card combos (the continuing
 *                      range). Combos that conflict with hero/board cards are
 *                      skipped automatically.
 * @param iterations   Soft budget on total showdowns. Used only when runouts
 *                      are sampled (3+ board cards to come); enumeration ignores
 *                      it because it is already exact.
 * @returns RangeEquityResult. If no valid combo remains, returns 0.5 (neutral)
 *          so callers never divide by zero or treat an empty range as a lock.
 */
export function equityVsRange(
  heroCards: [CardId, CardId],
  board: CardId[],
  villainCombos: [CardId, CardId][],
  iterations: number = 3000,
): RangeEquityResult {
  const blocked = new Set<CardId>([...heroCards, ...board]);

  // Drop combos that share a card with hero or the board.
  const valid = villainCombos.filter(
    ([a, b]) => a !== b && !blocked.has(a) && !blocked.has(b),
  );
  if (valid.length === 0) {
    return { equity: 0.5, combos: 0, samples: 0 };
  }

  const cardsToCome = 5 - board.length;
  let totalScore = 0; // win=1, tie=0.5, lose=0
  let totalSamples = 0;

  // Decide enumerate vs sample once for the whole call (board cards to come is
  // constant across combos).
  const enumerate = cardsToCome <= 2;
  // When sampling, split the budget evenly across combos.
  const samplesPerCombo = Math.max(1, Math.floor(iterations / valid.length));

  for (const villain of valid) {
    const known = [...heroCards, ...board, villain[0], villain[1]];
    const remaining = removeCards(createDeck(), known);

    if (cardsToCome === 0) {
      // River already out: one exact showdown.
      const hero = evaluateHand([...heroCards, ...board]);
      const vill = evaluateHand([...villain, ...board]);
      totalScore += hero > vill ? 1 : hero < vill ? 0 : 0.5;
      totalSamples += 1;
    } else if (enumerate && cardsToCome === 1) {
      // Enumerate every single river card exactly.
      for (const c of remaining) {
        const full = [...board, c];
        const hero = evaluateHand([...heroCards, ...full]);
        const vill = evaluateHand([...villain, ...full]);
        totalScore += hero > vill ? 1 : hero < vill ? 0 : 0.5;
        totalSamples += 1;
      }
    } else if (enumerate && cardsToCome === 2) {
      // Enumerate every turn+river pair exactly (order-independent).
      for (let i = 0; i < remaining.length; i++) {
        for (let j = i + 1; j < remaining.length; j++) {
          const full = [...board, remaining[i], remaining[j]];
          const hero = evaluateHand([...heroCards, ...full]);
          const vill = evaluateHand([...villain, ...full]);
          totalScore += hero > vill ? 1 : hero < vill ? 0 : 0.5;
          totalSamples += 1;
        }
      }
    } else {
      // 3+ cards to come: sample runouts.
      for (let s = 0; s < samplesPerCombo; s++) {
        const shuffled = shuffleDeck([...remaining]);
        const full = [...board];
        for (let k = 0; k < cardsToCome; k++) full.push(shuffled[k]);
        const hero = evaluateHand([...heroCards, ...full]);
        const vill = evaluateHand([...villain, ...full]);
        totalScore += hero > vill ? 1 : hero < vill ? 0 : 0.5;
        totalSamples += 1;
      }
    }
  }

  return {
    equity: totalSamples > 0 ? totalScore / totalSamples : 0.5,
    combos: valid.length,
    samples: totalSamples,
  };
}
