/**
 * soundness.ts — the SOUNDNESS GATE.
 *
 * A single, principled "would a competent player actually do this?" check that
 * every decision passes through before it's executed. It does not try to be a
 * solver; it encodes the handful of concrete things a good player verifies on
 * every hand — am I getting the right price, am I committing chips I can't
 * justify, is this a hand I can stack off with — and VETOES anything that fails.
 *
 * This generalizes the previously scattered, hand-coded guards (the postflop
 * anti-punt fold, the no-deep-jam preflop fix) into one law that covers EVERY
 * decision path (solved charts, the distilled net, and the heuristic fallbacks)
 * at once. It is the closest a fast, offline bot gets to a sanity check.
 *
 * Pure on scalars so it is exhaustively unit-testable without the equity engine:
 * the caller computes equity-vs-a-realistic-range and the commitment metrics, and
 * this decides whether the action stands or must be corrected.
 */
import { ActionType } from '../types/poker';

export interface SoundnessInput {
  /** The action the engine wants to take. */
  action: ActionType;
  street: 'preflop' | 'flop' | 'turn' | 'river';
  /** Is there a live bet to call? */
  facingBet: boolean;
  /** toCall / (pot + toCall) — the price we're being laid, 0 if not facing a bet. */
  potOdds: number;
  /** Fraction (0..1) of our remaining stack this action puts at risk. */
  commit: number;
  /** Effective stack in big blinds (committed-chip aware). */
  effStackBB: number;
  /** Is hero a premium hand strong enough to stack off deep preflop? */
  isPremium: boolean;
  /** Hero equity (0..1) vs the REALISTIC continuing/value range — not vs random. */
  eqVsRange: number;
  /**
   * A confident exploit read (e.g. villain is a confirmed bluff-heavy maniac) has
   * already justified this call. When set, the price floor (RULE 1) is relaxed:
   * calling light vs a known bluffer is sound, so the gate must not clip it. The
   * hard deep-stack-off floor (RULE 2) still applies.
   */
  trustExploitRead?: boolean;
}

export interface SoundnessResult {
  override: boolean;
  action?: ActionType;
  reason?: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Decide whether a proposed action is sound. Returns `{override:false}` to let it
 * stand, or an override action (always a SAFER action — a fold) with a reason.
 *
 * The gate only ever makes a decision MORE conservative; it never invents
 * aggression. That keeps it a safety net, not a second strategy that could fight
 * the solver.
 */
export function evaluateSoundness(i: SoundnessInput): SoundnessResult {
  // RULE 1 — PRICE / COMMITMENT FLOOR ON CALLS (postflop).
  // Never call when our equity vs the range that is actually betting can't beat
  // the price. The required margin grows with how much of the stack we're putting
  // in: peeling 3bb on the flop needs a hair of edge; stacking off 80bb needs a
  // real one. This is the universal anti-punt rule — it stops calling a river jam
  // with king-high. POSTFLOP ONLY: preflop calls are governed by the solved
  // charts (and RULE 2 below for deep all-ins); applying a pot-odds-vs-random
  // floor preflop would wrongly fold sound chart-defends if the pot is read low.
  if (i.action === 'call' && i.facingBet && i.street !== 'preflop' && !i.trustExploitRead) {
    const margin = 0.01 + 0.06 * clamp01(i.commit);
    // Never fold a hand that's clearly ahead of the range (>=60%), regardless of
    // price — that would only ever be a mistake.
    if (i.eqVsRange < 0.60 && i.eqVsRange < i.potOdds + margin) {
      return {
        override: true,
        action: 'fold',
        reason: `fold: ${pct(i.eqVsRange)} eq vs range < ${pct(i.potOdds)} price +${pct(margin)} (commits ${pct(i.commit)} stack) [soundness]`,
      };
    }
  }

  // RULE 2 — NO DEEP PREFLOP STACK-OFF WITH A NON-PREMIUM HAND (backstop to the
  // solved charts). Getting all-in for 25bb+ preflop is a premiums-only decision;
  // a weak hand jamming or calling a jam that deep is a punt. (First-in opens are
  // not touched — only stack-offs that face a bet.)
  if (
    i.action === 'allin' &&
    i.street === 'preflop' &&
    i.facingBet &&
    i.effStackBB > 25 &&
    !i.isPremium
  ) {
    return {
      override: true,
      action: 'fold',
      reason: `fold: non-premium all-in stack-off at ${i.effStackBB.toFixed(0)}bb deep [soundness]`,
    };
  }

  return { override: false };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
