import { DecisionEngine } from '../src/core/engine';
import { BotDecision, GameState, Card } from '../src/types/poker';
import { cardToId } from '../src/core/cfr/card-utils';
import { villainContinuingRange } from '../src/core/postflop-strategy';
import { defendVsAggression, balancedAggressorRange, leadPolicyRange, PostflopStreet } from '../src/core/defense';

// ============================================================
// Defense shim: wires src/core/defense.ts into a DecisionEngine INSTANCE by
// patching two private methods, so probes and the simulator can measure the
// effect without editing engine.ts. defenseFacingBet() below is the reference
// implementation of the engine wiring described in the workstream notes: the
// integrator can move it into DecisionEngine as a method nearly verbatim.
//
//   decidePostflop      facing a bet postflop -> defenseFacingBet(); else unchanged
//   applySoundnessGate  a '[defense]' call skips RULE 1's bluff-free re-check
//                       (equivalent to evaluateSoundness({... rangeDefended:true,
//                       eqVsRange: defense equity}) for commits < 0.5)
// ============================================================

interface Internals {
  decidePostflop: (s: GameState, h: [number, number], e: number) => BotDecision;
  applySoundnessGate: (d: BotDecision, s: GameState, e: number, t?: boolean) => BotDecision;
  analyzeBoard: (cards: Card[]) => { texture: string; isMonotone: boolean };
  isInPosition: (s: GameState) => boolean;
  roundToStake: (amount: number, bb: number) => number;
}

/** Facing a bet or raise postflop: fold / call / raise via defendVsAggression. */
export function defenseFacingBet(engine: DecisionEngine, state: GameState, heroCards: [number, number]): BotDecision {
  const eng = engine as unknown as Internals;
  const street = state.street as PostflopStreet;
  const board = state.communityCards.map(cardToId);
  const hero = state.players[state.heroIndex];
  const heroBet = hero?.currentBet || 0;
  const toCall = Math.max(0, state.currentBet - heroBet);
  const pot = Math.max(1, state.pot);
  // Villain's street commitment is state.currentBet; the pot it went into is
  // everything else. Raise to R over hero's b (P before): R / (P + b).
  const villainStreet = state.currentBet;
  const sizeFrac = villainStreet / Math.max(1, pot - villainStreet);
  const facingRaise = heroBet > 0;

  // Villain range: value from the existing continuing-range model, built with
  // two BOARD cards as the "hero" argument so no hero card is removed (hero's
  // own blockers are applied per combo inside defendVsAggression), plus a
  // balanced bluff block for this size. Replace with the range tracker's range.
  const value = villainContinuingRange([board[0], board[1]], board, { aggression: true, multiway: false });
  const villainRange = balancedAggressorRange(value, board, street, sizeFrac);

  // Hero range: the lead policy's betting range (hero bet and got raised) or
  // checking range (hero checked, villain bet). Preflop weight uniform for now.
  const pfRaise = (state.actionHistory.preflop || []).filter(a => a.type === 'raise' || a.type === 'allin');
  const isIP = eng.isInPosition(state);
  const isAggressor = pfRaise.length ? pfRaise[pfRaise.length - 1].playerName === hero?.name : isIP;
  const tex = eng.analyzeBoard(state.communityCards);
  const heroRange = leadPolicyRange(board, street, {
    isAggressor, isIP, veryWetOrMono: tex.texture === 'very_wet' || tex.isMonotone, line: facingRaise ? 'bet' : 'check',
  });

  const d = defendVsAggression({
    heroCards, board, heroRange, villainRange, pot, toCall, street,
    villainActionSizeFrac: sizeFrac, facingRaise, heroStack: hero?.stack,
  });
  if (d.action === 'fold') {
    return { action: 'fold', confidence: 1 - d.equity, reasoning: d.reasoning, mixedStrategy: { fold: 1, check: 0, call: 0, bets: [] } };
  }
  if (d.action === 'raise') {
    const bb = state.bigBlind || 1;
    const raiseTo = eng.roundToStake(state.currentBet * 2.5, bb);
    return { action: 'raise', amount: raiseTo, confidence: d.equity, reasoning: d.reasoning, mixedStrategy: { fold: 0, check: 0, call: 0, bets: [{ amount: raiseTo, probability: 1 }] } };
  }
  return { action: 'call', confidence: d.equity, reasoning: d.reasoning, mixedStrategy: { fold: 0, check: 0, call: 1, bets: [] } };
}

/** Patch an engine instance so facing-a-bet postflop spots go through defense.ts. */
export function installDefense(engine: DecisionEngine): void {
  const eng = engine as unknown as Internals;
  const origDecide = eng.decidePostflop.bind(engine);
  const origGate = eng.applySoundnessGate.bind(engine);
  eng.decidePostflop = (state, heroCards, eq) => {
    const heroBet = state.players[state.heroIndex]?.currentBet || 0;
    if (state.currentBet > heroBet && state.communityCards.length >= 3) return defenseFacingBet(engine, state, heroCards);
    return origDecide(state, heroCards, eq);
  };
  eng.applySoundnessGate = (d, s, e, t) => {
    if (d.action === 'call' && d.reasoning.includes('[defense]')) return d;
    return origGate(d, s, e, t);
  };
}
