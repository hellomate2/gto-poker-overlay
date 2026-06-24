import { CardId } from '../../types/poker';
import { createDeck, removeCards, shuffleDeck } from '../cfr/card-utils';
import { evaluateHand } from './hand-eval';

// ============================================================
// Monte Carlo Equity Calculator
// Simulates random runouts to estimate hand equity vs a range
// ============================================================

export interface EquityResult {
  equity: number; // 0-1, our win probability
  win: number;
  tie: number;
  lose: number;
  samples: number;
}

/**
 * Calculate equity of our hand vs a random opponent hand.
 * @param heroCards Our 2 hole cards
 * @param board Community cards (0-5)
 * @param numSimulations Number of Monte Carlo iterations
 */
export function equityVsRandom(
  heroCards: [CardId, CardId],
  board: CardId[],
  numSimulations: number = 5000,
): EquityResult {
  const knownCards = [...heroCards, ...board];
  const remainingDeck = removeCards(createDeck(), knownCards);
  const cardsNeeded = 5 - board.length; // cards to complete the board
  let wins = 0;
  let ties = 0;
  let losses = 0;

  for (let i = 0; i < numSimulations; i++) {
    const shuffled = shuffleDeck([...remainingDeck]);
    // Deal villain cards
    const villainCards: [CardId, CardId] = [shuffled[0], shuffled[1]];
    // Complete the board
    const fullBoard = [...board];
    for (let j = 0; j < cardsNeeded; j++) {
      fullBoard.push(shuffled[2 + j]);
    }

    const heroHand = [...heroCards, ...fullBoard];
    const villainHand = [...villainCards, ...fullBoard];

    const heroRank = evaluateHand(heroHand);
    const villainRank = evaluateHand(villainHand);

    if (heroRank > villainRank) wins++;
    else if (heroRank < villainRank) losses++;
    else ties++;
  }

  return {
    equity: (wins + ties * 0.5) / numSimulations,
    win: wins / numSimulations,
    tie: ties / numSimulations,
    lose: losses / numSimulations,
    samples: numSimulations,
  };
}

/**
 * Calculate equity vs a specific range of hands.
 * @param heroCards Our 2 hole cards
 * @param board Community cards
 * @param villainRange Array of possible villain hands (each is [CardId, CardId])
 * @param numSimulations Per villain hand combo
 */
export function equityVsRange(
  heroCards: [CardId, CardId],
  board: CardId[],
  villainRange: [CardId, CardId][],
  numSimulations: number = 2000,
): EquityResult {
  const knownCards = new Set([...heroCards, ...board]);
  // Filter range to valid combos (no overlap with known cards)
  const validRange = villainRange.filter(
    ([c1, c2]) => !knownCards.has(c1) && !knownCards.has(c2),
  );

  if (validRange.length === 0) {
    return { equity: 0.5, win: 0, tie: 0, lose: 0, samples: 0 };
  }

  let totalWins = 0;
  let totalTies = 0;
  let totalLosses = 0;
  let totalSamples = 0;

  // Sample from the range
  const simsPerCombo = Math.max(1, Math.floor(numSimulations / validRange.length));

  for (const villainCards of validRange) {
    const allKnown = [...heroCards, ...board, ...villainCards];
    const remaining = removeCards(createDeck(), allKnown);
    const cardsNeeded = 5 - board.length;

    for (let i = 0; i < simsPerCombo; i++) {
      const shuffled = shuffleDeck([...remaining]);
      const fullBoard = [...board];
      for (let j = 0; j < cardsNeeded; j++) {
        fullBoard.push(shuffled[j]);
      }

      const heroRank = evaluateHand([...heroCards, ...fullBoard]);
      const villainRank = evaluateHand([...villainCards, ...fullBoard]);

      if (heroRank > villainRank) totalWins++;
      else if (heroRank < villainRank) totalLosses++;
      else totalTies++;
      totalSamples++;
    }
  }

  return {
    equity: (totalWins + totalTies * 0.5) / totalSamples,
    win: totalWins / totalSamples,
    tie: totalTies / totalSamples,
    lose: totalLosses / totalSamples,
    samples: totalSamples,
  };
}

/**
 * Quick equity estimate using fewer simulations (for real-time use)
 */
export function quickEquity(
  heroCards: [CardId, CardId],
  board: CardId[],
): number {
  return equityVsRandom(heroCards, board, 1000).equity;
}
