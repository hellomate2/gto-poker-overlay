/**
 * cbet.ts — lead / c-bet / donk policy for the "first to act, bet or check" spot.
 *
 * The distilled postflop net is reliable FACING A BET, but the bet-or-check lead
 * decision is rare in its training data (~6% of rows) and it extrapolates badly:
 * it keys on isPreflopAggressor with INVERTED polarity — checking as the
 * aggressor (no c-bet) and donking as the caller (leading air OOP). That produced
 * the visible leak of leading into the raiser with nothing and never c-betting.
 *
 * So when NOT facing a bet we ignore the net's bet/check and use this sound,
 * standard policy: who took the preflop initiative + position + made-hand strength
 * + equity + texture. Pure function -> exhaustively unit-testable. `equity` here
 * is the cheap equity-vs-a-random-hand already computed on the hot path (no extra
 * Monte Carlo), so the thresholds below are calibrated for that scale.
 */
import { HAND_CATEGORY } from './equity/hand-eval';

export interface LeadInput {
  /** Did hero take the preflop initiative (the c-bettor) vs being the caller? */
  isAggressor: boolean;
  /** Is hero in position (acts last postflop)? IP c-bets a touch more than OOP. */
  isIP: boolean;
  /** Hand category = floor(handValue / 1e6) from evaluateHand (PAIR, TWO_PAIR, …). */
  heroCat: number;
  /** Hero equity (0..1) vs a random hand (the cheap hot-path estimate). */
  equity: number;
  /** Very wet or monotone board — pot-control with marginal hands. */
  veryWetOrMono: boolean;
  /** Monotone/4-flush board on which hero cannot beat a flush — never bet. */
  dangerousFlush: boolean;
}

/**
 * Probability of LEADING (betting) when first to act / checked to. Sample against
 * it to decide bet vs check. Always returns a SANE shape: the aggressor c-bets a
 * lot, the caller checks to the raiser and leads only with real strength.
 */
export function leadBetProbability(i: LeadInput): number {
  // Never bet into a flush we can't beat.
  if (i.dangerousFlush && i.heroCat < HAND_CATEGORY.FLUSH) return 0;

  const pos = i.isIP ? 1.0 : 0.82; // OOP leads a little less

  if (!i.isAggressor) {
    // We CALLED preflop — check to the raiser; donk only with real strength.
    if (i.heroCat >= HAND_CATEGORY.TWO_PAIR) return 0.42;            // lead strong sometimes
    if (i.heroCat >= HAND_CATEGORY.PAIR && i.equity >= 0.72) return 0.18; // strong pair/overpair, rarely
    return 0.04;                                                      // air/marginal: essentially always check
  }

  // We ARE the preflop aggressor — c-bet.
  if (i.heroCat >= HAND_CATEGORY.TWO_PAIR) return Math.min(0.92, 0.86 * pos + 0.08); // value
  if (i.heroCat >= HAND_CATEGORY.PAIR) return (i.veryWetOrMono ? 0.35 : 0.70) * pos; // value/protection (pot-control when wet)
  // Air / draws: bluff c-bet — more on dry (aggressor-favored) boards, and with
  // some equity (overcards / a draw). Pure air on a wet board mostly checks.
  const base = (i.veryWetOrMono ? 0.18 : 0.40) * pos;
  if (i.equity >= 0.50) return Math.min(0.72, base + 0.18);
  return base;
}
