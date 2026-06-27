/**
 * cbet.ts — lead / c-bet / barrel policy for the "first to act, bet or check" spot.
 *
 * The distilled postflop net is reliable FACING A BET, but the bet-or-check lead
 * decision is rare in its training data (~6% of rows) and it extrapolates badly:
 * it keyed on isPreflopAggressor with INVERTED polarity (checking as the
 * aggressor, donking air as the caller). So when NOT facing a bet we use this
 * sound policy instead: who took the initiative + position + made-hand strength +
 * equity + texture + STREET. Pure function -> exhaustively unit-testable.
 *
 * Street matters: you c-bet wide on the flop, barrel more selectively on the
 * turn, and POLARIZE on the river — bet strong hands and some bluffs, but CHECK
 * one-pair showdown value (betting it only folds worse and gets called by better).
 * `equity` is the cheap equity-vs-a-random-hand already on the hot path.
 */
import { HAND_CATEGORY } from './equity/hand-eval';

export interface LeadInput {
  /** Did hero take the preflop initiative (the c-bettor) vs being the caller? */
  isAggressor: boolean;
  /** Is hero in position (acts last postflop)? IP bets a touch more than OOP. */
  isIP: boolean;
  /** Hand category = floor(handValue / 1e6) from evaluateHand (PAIR, TWO_PAIR, …). */
  heroCat: number;
  /** Hero equity (0..1) vs a random hand (the cheap hot-path estimate). */
  equity: number;
  /** Board street we're acting on. */
  street: 'flop' | 'turn' | 'river';
  /** Very wet or monotone board — pot-control with marginal hands. */
  veryWetOrMono: boolean;
  /** Monotone/4-flush board on which hero cannot beat a flush — never bet. */
  dangerousFlush: boolean;
}

/**
 * Probability of LEADING (betting) when first to act / checked to. Sample against
 * it to decide bet vs check. The aggressor c-bets/barrels, the caller checks to
 * the raiser, and the river is polarized (value + bluffs, not thin one-pair bets).
 */
export function leadBetProbability(i: LeadInput): number {
  // Never bet into a flush we can't beat.
  if (i.dangerousFlush && i.heroCat < HAND_CATEGORY.FLUSH) return 0;

  const pos = i.isIP ? 1.0 : 0.82; // OOP leads a little less
  const river = i.street === 'river';
  const turn = i.street === 'turn';

  if (!i.isAggressor) {
    // We CALLED preflop — check to the raiser; donk only with real strength.
    if (i.heroCat >= HAND_CATEGORY.TWO_PAIR) return 0.42;
    if (i.heroCat >= HAND_CATEGORY.PAIR && i.equity >= 0.72) return 0.16; // strong pair/overpair, rarely
    return 0.04;                                                          // air/marginal: check
  }

  // We ARE the aggressor.
  if (i.heroCat >= HAND_CATEGORY.TWO_PAIR) return Math.min(0.92, 0.86 * pos + 0.08); // value, every street

  if (i.heroCat >= HAND_CATEGORY.PAIR) {
    // One pair. Flop/turn: value/protection (worse hands call, draws pay). River:
    // it's a showdown / bluff-catch hand, not a value bet (worse folds, better
    // calls) — mostly CHECK. Wet textures get pot-control.
    if (river) return 0.18 * pos;
    if (turn) return (i.veryWetOrMono ? 0.30 : 0.50) * pos;
    return (i.veryWetOrMono ? 0.35 : 0.70) * pos;
  }

  // Air / draws — bluff.
  if (river) return (i.veryWetOrMono ? 0.12 : 0.26) * pos; // no draws left: pure bluff, controlled
  let base = (i.veryWetOrMono ? 0.18 : 0.40) * pos;
  if (turn) base *= 0.85;
  if (i.equity >= 0.50) return Math.min(0.70, base + 0.18); // a real draw / live overcards: barrel
  return base;
}
