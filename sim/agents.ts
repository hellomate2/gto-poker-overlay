// ============================================================
// Agents for the simulator: the real bot (DecisionEngine) and a set of scripted
// opponent archetypes. Opponents are deliberately simple, threshold-based
// players — NOT GTO — so we can measure how well the bot adapts to and exploits
// each style.
//
// Two families:
//   - Threshold archetypes (nit / tag / lag / fish / station / maniac): act on
//     equity-vs-random against fixed thresholds.
//   - Exploit probes (raiser / barreler / checkraiser): built to attack one
//     specific leak each, with TAG preflop play so they reach postflop with a
//     normal range:
//       raiser      raises a postflop bet at high frequency with any two cards
//                   (punishes over-folding to raises),
//       barreler    bets every street whenever it can open the betting
//                   (punishes folding to turn/river barrels),
//       checkraiser checks when first to act, then check-raises a bet at high
//                   frequency (punishes auto-cbetting / stabbing).
//
// Randomness isolation: every scripted opponent draws ALL of its randomness
// (bluff coin flips AND its Monte-Carlo equity samples) from a private seeded
// RNG, by swapping Math.random for the duration of its act(). Its decisions
// therefore depend only on its seed and what it sees, never on how many random
// numbers the bot consumed. That is what lets a duplicate replay (sim/match.ts)
// reproduce the opponent's behavior when the bot under test acts identically.
// ============================================================

import { SeatAgent, SeatView, ActResult } from './ring';
import { DecisionEngine } from '../src/core/engine';
import { equityVsRandom } from '../src/core/equity/monte-carlo';
import { cardToId, handGroupName } from '../src/core/cfr/card-utils';
import { Card, GameState, BotDecision } from '../src/types/poker';
import { makeRng, mixSeed } from './ring';

const toIds = (h: [Card, Card]) => [cardToId(h[0]), cardToId(h[1])] as [number, number];

/** Minimal surface of DecisionEngine the harness needs. A candidate engine loaded
 *  from another checkout (sim/match.ts) only has to satisfy this. */
export interface EngineLike {
  decide(state: GameState): Promise<BotDecision>;
  processCompletedHand?(state: GameState): Promise<void>;
}
export type EngineCtor = new () => EngineLike;

/**
 * The real bot. With { exploit: true } it TRACKS the opponent across the session
 * (via the real tracker.processHand, backed by the in-memory IndexedDB shim) so
 * its profiler + exploit adjuster engage. With { exploit: false } (default) the
 * stat loader is a no-op so the bot plays pure GTO — useful as the baseline to
 * measure the exploitation lift.
 *
 * `engineClass` lets a caller substitute a DecisionEngine from a different
 * source tree (dynamic import in sim/match.ts); default is this tree's engine.
 */
export function makeBotAgent(
  name = 'BOT',
  opts: { exploit?: boolean; engineClass?: EngineCtor } = {},
): SeatAgent {
  const Ctor: EngineCtor = opts.engineClass ?? (DecisionEngine as unknown as EngineCtor);
  const engine = new Ctor();
  const exploit = !!opts.exploit;
  if (!exploit) {
    // Engines that keep the tracker private still expose it at runtime; if a
    // candidate engine has no tracker there is nothing to disable.
    const tr = (engine as unknown as { tracker?: { loadStats: () => Promise<void> } }).tracker;
    if (tr) tr.loadStats = async () => {};
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
  // The engine instance, for agents that report its stats (sim/seat-agents.ts).
  Object.assign(agent, { engine });
  if (exploit) {
    agent.observe = async (finalState: GameState) => {
      try { await engine.processCompletedHand?.(finalState); } catch { /* tracking is best-effort */ }
    };
  }
  return agent;
}

// ---- scripted opponents ----------------------------------------------------

export type ArchetypeStyle = 'threshold' | 'raiser' | 'barreler' | 'checkraiser';

export interface ArchetypeParams {
  style?: ArchetypeStyle; // default 'threshold'
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
  /** Probe styles: frequency of the signature move (raise a bet / check-raise). */
  probeFreq?: number;
}

const TAG_PREFLOP = { openTop: 0.56, callTop: 0.50, threeBetTop: 0.68, foldTo3betBelow: 0.55 };

const ARCHETYPES: Record<string, ArchetypeParams> = {
  // Tight-passive rock: enters ~12%, only continues with the goods.
  nit: { openTop: 0.66, callTop: 0.60, threeBetTop: 0.80, foldTo3betBelow: 0.72,
         valueBet: 0.74, callDown: 0.60, bluffFreq: 0.03, raiseBluffFreq: 0.0, potFracBet: 0.5 },
  // Solid TAG: ~24/19, balanced-ish.
  tag: { ...TAG_PREFLOP,
         valueBet: 0.62, callDown: 0.50, bluffFreq: 0.30, raiseBluffFreq: 0.08, potFracBet: 0.6 },
  // Loose-aggressive: ~38/30, lots of pressure and bluffs.
  lag: { openTop: 0.46, callTop: 0.42, threeBetTop: 0.58, foldTo3betBelow: 0.42,
         valueBet: 0.52, callDown: 0.44, bluffFreq: 0.55, raiseBluffFreq: 0.20, potFracBet: 0.75 },
  // Calling station / fish: plays everything, almost never folds, rarely raises.
  fish: { openTop: 0.50, callTop: 0.30, threeBetTop: 0.85, foldTo3betBelow: 0.30,
          valueBet: 0.70, callDown: 0.30, bluffFreq: 0.05, raiseBluffFreq: 0.0, potFracBet: 0.5 },
  // Pure calling station: calls almost anything, essentially never folds postflop,
  // almost never raises. Even weaker fold thresholds than `fish` so "never folds"
  // is unmistakable in the stats (the canonical "vs station, stop bluffing" target).
  station: { openTop: 0.52, callTop: 0.18, threeBetTop: 0.92, foldTo3betBelow: 0.16,
             valueBet: 0.78, callDown: 0.18, bluffFreq: 0.02, raiseBluffFreq: 0.0, potFracBet: 0.5 },
  // Maniac: raises/bets relentlessly regardless of equity.
  maniac: { openTop: 0.30, callTop: 0.20, threeBetTop: 0.40, foldTo3betBelow: 0.20,
            valueBet: 0.40, callDown: 0.35, bluffFreq: 0.80, raiseBluffFreq: 0.40, potFracBet: 0.9 },

  // ---- exploit probes (TAG preflop) ----
  // Raises 75% of postflop bets it faces with any two cards (always with value);
  // when re-raised it continues only with real equity. Opens the betting itself
  // like a TAG.
  raiser: { style: 'raiser', ...TAG_PREFLOP, probeFreq: 0.75,
            valueBet: 0.70, callDown: 0.55, bluffFreq: 0.30, raiseBluffFreq: 0, potFracBet: 0.6 },
  // Bets 2/3 pot every time it can open the betting on a postflop street, any
  // two cards. Facing a bet it plays straightforwardly (raise value, call
  // decent equity or a good price, else fold).
  barreler: { style: 'barreler', ...TAG_PREFLOP, probeFreq: 1.0,
              valueBet: 0.80, callDown: 0.50, bluffFreq: 1.0, raiseBluffFreq: 0, potFracBet: 0.66 },
  // Checks whenever it is first to act on a street, then check-raises a bet 60%
  // of the time with any two cards (always with value). When checked to it bets
  // value plus some bluffs.
  checkraiser: { style: 'checkraiser', ...TAG_PREFLOP, probeFreq: 0.60,
                 valueBet: 0.68, callDown: 0.50, bluffFreq: 0.25, raiseBluffFreq: 0, potFracBet: 0.6 },
};

export function archetypeNames(): string[] { return Object.keys(ARCHETYPES); }

/**
 * Stack depth (big blinds, chips this seat can still put in preflop) at or
 * below which a scripted opponent turns every preflop raise into an all-in, so
 * a short-stack table (sim/match.ts --stacks) produces real jams for the bot to
 * face. A sim modelling choice, not a measured threshold: it sits inside the
 * 25bb band the repo's push/fold tables cover (pushfold-nash.ts
 * MAX_PUSHFOLD_BB) and well below the 100bb default, so default runs never
 * reach it.
 */
export const SHORT_JAM_BB = 15;

/** Preflop equity-vs-random per hand class, shared across agents. Each entry is
 *  computed with an RNG seeded by the hand class itself, so the cached value does
 *  not depend on which agent or process computed it first (shard-reproducible). */
const PREFLOP_CACHE = new Map<string, number>();
function preflopStrength(hole: [Card, Card]): number {
  const name = handGroupName(...toIds(hole));
  let v = PREFLOP_CACHE.get(name);
  if (v === undefined) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = mixSeed(h, name.charCodeAt(i));
    v = withRandom(makeRng(h), () => equityVsRandom(toIds(hole), [], 600).equity);
    PREFLOP_CACHE.set(name, v);
  }
  return v;
}

/** Run fn with Math.random temporarily replaced by rng. */
function withRandom<T>(rng: () => number, fn: () => T): T {
  const saved = Math.random;
  Math.random = rng;
  try { return fn(); } finally { Math.random = saved; }
}

/** How many bet/raise actions this player already made on the current street. */
function myAggressionThisStreet(view: SeatView, myName: string): { wagers: number; checked: boolean } {
  const acts = view.state.actionHistory[view.street] || [];
  let wagers = 0; let checked = false;
  for (const a of acts) {
    if (a.playerName !== myName) continue;
    if (a.type === 'bet' || a.type === 'raise' || a.type === 'allin') wagers++;
    if (a.type === 'check') checked = true;
  }
  return { wagers, checked };
}

/**
 * Build a scripted opponent. `name` defaults to OPP_<kind>; ring tables pass a
 * unique name per seat (the bot tracks opponents by name).
 */
export function makeOpponent(kind: string, seed: number, opponentSamples = 200, name?: string): SeatAgent {
  const p = ARCHETYPES[kind];
  if (!p) throw new Error(`unknown archetype ${kind}`);
  let rng = makeRng(seed);
  const myName = name ?? `OPP_${kind}`;
  const style: ArchetypeStyle = p.style ?? 'threshold';

  function decide(view: SeatView): ActResult {
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
      // Short stack (sim/match.ts --stacks): every preflop raise is a shove.
      // At 100bb this never fires, so default runs are unchanged.
      const shortJam = view.maxTo <= SHORT_JAM_BB * view.bb;
      const pfRaise = (frac: number): ActResult =>
        shortJam ? { action: 'allin' } : { action: 'raise', toAmount: raiseTo(frac) };
      if (!facing) {
        // first in (or BB option). Open the top of the range, else (SB) fold / (BB) check.
        if (eq >= p.openTop) return pfRaise(view.canCheck ? 1.0 : 1.5);
        return view.canCheck ? { action: 'check' } : { action: 'fold' };
      }
      // facing a raise: 3-bet premiums, call decent, fold the rest (call more vs maniac).
      if (eq >= p.threeBetTop) return pfRaise(1.0);
      if (eq >= p.callTop && eq > potOdds) return { action: 'call' };
      if (eq < p.foldTo3betBelow) return { action: 'fold' };
      return eq > potOdds ? { action: 'call' } : { action: 'fold' };
    }

    // Straightforward response to a bet, shared by the probes once their
    // signature move is spent: raise strong value, call equity or price, fold.
    const plainResponse = (callFloor: number): ActResult => {
      if (eq >= 0.85) return { action: 'raise', toAmount: raiseTo(1.0) };
      if (eq >= callFloor || eq > potOdds + 0.05) return { action: 'call' };
      return { action: 'fold' };
    };

    if (style === 'raiser') {
      if (!facing) {
        if (eq >= p.valueBet || rng() < p.bluffFreq) return { action: 'bet', toAmount: raiseTo(p.potFracBet) };
        return { action: 'check' };
      }
      const me = myAggressionThisStreet(view, myName);
      if (me.wagers === 0 && (eq >= p.valueBet || rng() < (p.probeFreq ?? 0.75))) {
        // raise to ~3x the live bet (a standard postflop raise size)
        return { action: 'raise', toAmount: Math.round((view.state.currentBet || view.bb) * 3) };
      }
      return plainResponse(p.callDown);
    }

    if (style === 'barreler') {
      if (!facing) return { action: 'bet', toAmount: raiseTo(p.potFracBet) };
      return plainResponse(p.callDown);
    }

    if (style === 'checkraiser') {
      const me = myAggressionThisStreet(view, myName);
      if (!facing) {
        // First to act on this street (nobody has acted yet): always check.
        const streetActs = view.state.actionHistory[view.street] || [];
        if (streetActs.length === 0) return { action: 'check' };
        if (eq >= p.valueBet || rng() < p.bluffFreq) return { action: 'bet', toAmount: raiseTo(p.potFracBet) };
        return { action: 'check' };
      }
      if (me.checked && me.wagers === 0 && (eq >= p.valueBet || rng() < (p.probeFreq ?? 0.6))) {
        return { action: 'raise', toAmount: Math.round((view.state.currentBet || view.bb) * 3) };
      }
      return plainResponse(p.callDown);
    }

    // threshold archetypes (original behavior)
    if (!facing) {
      if (eq >= p.valueBet) return { action: 'bet', toAmount: raiseTo(p.potFracBet) };
      if (rng() < p.bluffFreq) return { action: 'bet', toAmount: raiseTo(p.potFracBet) };
      return { action: 'check' };
    }
    if (eq >= p.valueBet && rng() < 0.6) return { action: 'raise', toAmount: raiseTo(p.potFracBet) };
    if (eq < p.callDown && rng() < p.raiseBluffFreq && view.street !== 'river') return { action: 'raise', toAmount: raiseTo(p.potFracBet) };
    if (eq >= p.callDown || eq > potOdds + 0.02) return { action: 'call' };
    return { action: 'fold' };
  }

  return {
    name: myName,
    act(view: SeatView): ActResult {
      return withRandom(rng, () => decide(view));
    },
    reseed(s: number) { rng = makeRng(s); },
  };
}
