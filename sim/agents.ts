// ============================================================
// Agents for the HU simulator: the real bot (DecisionEngine) and a set of
// scripted opponent archetypes (nit / TAG / LAG / fish / maniac). Opponents are
// deliberately simple, threshold-based players — NOT GTO — so we can measure how
// well the bot adapts to and exploits each style.
// ============================================================

import { SeatAgent, SeatView, ActResult } from './holdem';
import { DecisionEngine } from '../src/core/engine';
import { equityVsRandom } from '../src/core/equity/monte-carlo';
import { cardToId, handGroupName } from '../src/core/cfr/card-utils';
import { Card, GameState } from '../src/types/poker';

const toIds = (h: [Card, Card]) => [cardToId(h[0]), cardToId(h[1])] as [number, number];

/**
 * The real bot. With { exploit: true } it TRACKS the opponent across the session
 * (via the real tracker.processHand, backed by the in-memory IndexedDB shim) so
 * its profiler + exploit adjuster engage. With { exploit: false } (default) the
 * stat loader is a no-op so the bot plays pure GTO — useful as the baseline to
 * measure the exploitation lift.
 */
export function makeBotAgent(name = 'BOT', opts: { exploit?: boolean } = {}): SeatAgent {
  const engine = new DecisionEngine();
  const exploit = !!opts.exploit;
  if (!exploit) {
    (engine as unknown as { tracker: { loadStats: () => Promise<void> } }).tracker.loadStats = async () => {};
  }

  const agent: SeatAgent = {
    name,
    async act(view: SeatView): Promise<ActResult> {
      const d = await engine.decide(view.state);
      switch (d.action) {
        case 'fold': return { action: 'fold' };
        case 'check': return { action: 'check' };
        case 'call': return { action: 'call' };
        case 'allin': return { action: 'allin' };
        case 'bet':
        case 'raise':
          return { action: d.action, toAmount: d.amount };
        default: return { action: view.canCheck ? 'check' : 'fold' };
      }
    },
  };
  if (exploit) {
    agent.observe = async (finalState: GameState) => {
      try { await engine.processCompletedHand(finalState); } catch { /* tracking is best-effort */ }
    };
  }
  return agent;
}

// ---- scripted opponents ----------------------------------------------------

export interface ArchetypeParams {
  // preflop
  openTop: number;       // open/raise hands whose preflop equity-vs-random >= this
  callTop: number;       // cold-call/defend hands with equity >= this (below openTop)
  threeBetTop: number;   // 3-bet/raise-over hands with equity >= this
  foldTo3betBelow: number; // fold to a 3-bet/4-bet when equity < this
  // postflop (equity vs random as a strength proxy)
  valueBet: number;      // bet/raise when equity >= this
  callDown: number;      // call a bet when equity >= this
  bluffFreq: number;     // when checked to with a weak hand, bet anyway this often
  raiseBluffFreq: number;// raise as a bluff this often facing a bet with weak equity
  potFracBet: number;    // bet size as a fraction of pot
}

const ARCHETYPES: Record<string, ArchetypeParams> = {
  // Tight-passive rock: enters ~12%, only continues with the goods.
  nit: { openTop: 0.66, callTop: 0.60, threeBetTop: 0.80, foldTo3betBelow: 0.72,
         valueBet: 0.74, callDown: 0.60, bluffFreq: 0.03, raiseBluffFreq: 0.0, potFracBet: 0.5 },
  // Solid TAG: ~24/19, balanced-ish.
  tag: { openTop: 0.56, callTop: 0.50, threeBetTop: 0.68, foldTo3betBelow: 0.55,
         valueBet: 0.62, callDown: 0.50, bluffFreq: 0.30, raiseBluffFreq: 0.08, potFracBet: 0.6 },
  // Loose-aggressive: ~38/30, lots of pressure and bluffs.
  lag: { openTop: 0.46, callTop: 0.42, threeBetTop: 0.58, foldTo3betBelow: 0.42,
         valueBet: 0.52, callDown: 0.44, bluffFreq: 0.55, raiseBluffFreq: 0.20, potFracBet: 0.75 },
  // Calling station / fish: plays everything, almost never folds, rarely raises.
  fish: { openTop: 0.50, callTop: 0.30, threeBetTop: 0.85, foldTo3betBelow: 0.30,
          valueBet: 0.70, callDown: 0.30, bluffFreq: 0.05, raiseBluffFreq: 0.0, potFracBet: 0.5 },
  // Maniac: raises/bets relentlessly regardless of equity.
  maniac: { openTop: 0.30, callTop: 0.20, threeBetTop: 0.40, foldTo3betBelow: 0.20,
            valueBet: 0.40, callDown: 0.35, bluffFreq: 0.80, raiseBluffFreq: 0.40, potFracBet: 0.9 },
};

export function archetypeNames(): string[] { return Object.keys(ARCHETYPES); }

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function makeOpponent(kind: string, seed: number, opponentSamples = 200): SeatAgent {
  const p = ARCHETYPES[kind];
  if (!p) throw new Error(`unknown archetype ${kind}`);
  const rng = mulberry32(seed);
  const preflopCache = new Map<string, number>();

  function preflopStrength(hole: [Card, Card]): number {
    const name = handGroupName(...toIds(hole));
    let v = preflopCache.get(name);
    if (v === undefined) { v = equityVsRandom(toIds(hole), [], 600).equity; preflopCache.set(name, v); }
    return v;
  }

  return {
    name: `OPP_${kind}`,
    act(view: SeatView): ActResult {
      const eq = view.board.length === 0
        ? preflopStrength(view.hole)
        : equityVsRandom(toIds(view.hole), view.board.map(cardToId), opponentSamples).equity;
      const facing = view.toCall > 0;
      const potOdds = facing ? view.toCall / (view.pot + view.toCall) : 0;
      const raiseTo = (frac: number) => {
        // size relative to pot; "to" amount = current bet matched + raise size
        const size = Math.max(view.bb, Math.round(view.pot * frac));
        return (view.state.currentBet || 0) + size;
      };

      if (view.street === 'preflop') {
        if (!facing) {
          // first in (or BB option). Open the top of the range, else (SB) fold / (BB) check.
          if (eq >= p.openTop) return { action: 'raise', toAmount: raiseTo(view.canCheck ? 1.0 : 1.5) };
          return view.canCheck ? { action: 'check' } : { action: 'fold' };
        }
        // facing a raise: 3-bet premiums, call decent, fold the rest (call more vs maniac).
        if (eq >= p.threeBetTop) return { action: 'raise', toAmount: raiseTo(1.0) };
        if (eq >= p.callTop && eq > potOdds) return { action: 'call' };
        if (eq < p.foldTo3betBelow) return { action: 'fold' };
        return eq > potOdds ? { action: 'call' } : { action: 'fold' };
      }

      // postflop
      if (!facing) {
        if (eq >= p.valueBet) return { action: 'bet', toAmount: raiseTo(p.potFracBet) };
        if (rng() < p.bluffFreq) return { action: 'bet', toAmount: raiseTo(p.potFracBet) };
        return { action: 'check' };
      }
      // facing a bet
      if (eq >= p.valueBet && rng() < 0.6) return { action: 'raise', toAmount: raiseTo(p.potFracBet) };
      if (eq < p.callDown && rng() < p.raiseBluffFreq && view.street !== 'river') return { action: 'raise', toAmount: raiseTo(p.potFracBet) };
      if (eq >= p.callDown || eq > potOdds + 0.02) return { action: 'call' };
      return { action: 'fold' };
    },
  };
}
