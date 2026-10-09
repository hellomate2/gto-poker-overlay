import { CardId, GameState } from '../../types/poker';
import { cardToId } from '../cfr/card-utils';
import { Spot } from './features';

// ============================================================
// Serve-side Spot builder for the distilled postflop net.
//
// The net was trained on Spots that ml/prep.ts parsed from PokerBench rows. This
// module builds the Spot for a live GameState with the SAME definitions, so
// encodeSpot() sees the same numbers at train and serve time for the same spot.
// tests/ml-serve-parity.test.ts pins this by encoding hand-built PokerBench rows
// through parseRow and the equivalent GameStates through the engine and
// asserting identical feature vectors.
//
// Training definitions (ml/prep.ts parseRow), and how they map to GameState:
//
//   pot              PokerBench pot_size. It includes the chips already wagered
//                    on the current street: in tests/fixtures/postflop-holdout.json
//                    the hero's own offered bet is ~0.77 pot (median, 711 rows not
//                    facing a bet) while the bet hero faces is ~0.43 pot (median,
//                    694 rows with one wager this street), which is 0.75/1.75.
//                    GameState.pot has the same meaning (sim/ring.ts: "all
//                    commitments this hand, incl. this street").
//   toCallFrac       lastWagerAmount(postflop_action) / pot: the latest BET_x /
//                    RAISE_x amount, a raise-TO total, with hero's own chips on
//                    this street NOT subtracted. On GameState that is
//                    state.currentBet / pot (not (currentBet - heroBet) / pot).
//   offeredSizeFrac  the single 'Bet X' / 'Raise X' in available_moves over pot,
//                    0 when no bet/raise is offered. Facing a wager it is the
//                    raise-TO total (holdout median offered/toCall = 3.17 with one
//                    wager this street). On GameState it is the raise-to (or bet)
//                    the engine would actually make, capped at hero's all-in.
//   canRaise/canBet  true only when the move is offered. Live: false when hero
//                    cannot cover more than the call, or every live villain is
//                    all-in (stack 0 with chips in front this street). Hero's
//                    stack of 0 is treated as unread (no restriction), matching
//                    legalizeDecision.
//   pot (serve)      the caller's pot (GameState.pot, or 1 chip when it is not
//                    positive), the same value the engine sizes bets and prices
//                    pot odds with.
//
// Known remaining differences (documented, not fixable on the serve side):
//   - The dataset's offered size is the solver's own sizing; the live value is
//     the engine's sizing for the same spot (same semantics, different number).
//   - threeBetPot: prep's regex never fires on PokerBench preflop strings (0 of
//     2000 holdout rows are true), and the trained net's first-layer weights for
//     feature 31 are all zero with mean 0 / std 1, so the net ignores it.
//   - 77 of the 711 not-facing holdout rows list a 'Raise' move with no wager to
//     face; the live builder never sets canRaise without a wager.
// ============================================================

export interface NetSpotContext {
  heroCards: [CardId, CardId];
  isIP: boolean;
  threeBetPot: boolean;
  /** Bet the engine would make when not facing a wager (chips). */
  betTo: number;
  /** Raise-TO total the engine would make when facing a wager (chips). */
  raiseTo: number;
  /** The live villains still in the hand: stack behind and chips in front on
   *  this street. */
  liveVillains: { stack: number; currentBet: number }[];
  /** The pot the engine uses for its own sizing and pot odds. Passed in so the
   *  feature fractions and the sizes they describe use one and the same pot. */
  pot: number;
}

export function buildNetSpot(state: GameState, ctx: NetSpotContext): Spot | null {
  const street = state.street;
  if (street !== 'flop' && street !== 'turn' && street !== 'river') return null;
  if (state.communityCards.length < 3) return null;

  const hero = state.players[state.heroIndex];
  const heroBet = hero?.currentBet || 0;
  const heroStack = hero?.stack || 0;
  const currentBet = state.currentBet || 0;
  const toCall = Math.max(0, currentBet - heroBet);
  const facingBet = toCall > 0;
  const pot = ctx.pot;

  // A villain counts as all-in only when its stack reads 0 AND it has chips in
  // front on this street. The scraper returns 0 for an unreadable stack as well
  // as for an all-in one, so a 0 alone is not enough: a villain who has not put
  // chips in this street with a 0 stack is treated as unread (no restriction).
  // A wrong read is still possible for a villain who bet and whose stack fails
  // to parse; GameState has no field that tells the two apart. Hero's stack of
  // 0 is treated as unread, the same way legalizeDecision treats it.
  const stacksKnown = heroStack > 0;
  const villainsAllIn = stacksKnown && ctx.liveVillains.length > 0
    && ctx.liveVillains.every(v => v.stack <= 0 && v.currentBet > 0);
  const canRaise = facingBet && !villainsAllIn && (!stacksKnown || heroStack > toCall);
  const canBet = !facingBet && !villainsAllIn;
  const maxTo = stacksKnown ? heroStack + heroBet : Infinity;

  let offered = 0;
  if (canRaise) offered = Math.min(ctx.raiseTo, maxTo);
  else if (canBet) offered = Math.min(ctx.betTo, maxTo);

  // Betting-action context, mirroring prep: preflop aggressor + this-street
  // bet/raise counts.
  const pfActions = state.actionHistory.preflop || [];
  let pfAggressor: string | null = null;
  for (const a of pfActions) if (a.type === 'raise' || a.type === 'allin') pfAggressor = a.playerName;
  const isPreflopAggressor = !!hero && pfAggressor === hero.name;
  let streetBetCount = 0;
  let facedRaiseThisStreet = false;
  for (const a of state.actionHistory[street] || []) {
    if (a.type === 'bet') streetBetCount++;
    else if (a.type === 'raise' || a.type === 'allin') { streetBetCount++; facedRaiseThisStreet = true; }
  }

  return {
    holeCards: ctx.heroCards,
    board: state.communityCards.map(c => cardToId(c)),
    street,
    heroPos: ctx.isIP ? 'IP' : 'OOP',
    facingBet,
    isPreflopAggressor, facedRaiseThisStreet, streetBetCount,
    toCallFrac: facingBet ? currentBet / pot : 0,
    offeredSizeFrac: offered / pot,
    canCheck: !facingBet,
    canBet,
    canCall: facingBet,
    canRaise,
    canFold: facingBet,
    threeBetPot: ctx.threeBetPot,
  };
}
