// ============================================================
// Real-time subgame solve for the live engine (Libratus / Pluribus style).
// ------------------------------------------------------------
// solveSubgame() solves the ACTUAL heads-up spot at decision time: hero's
// perceived range vs villain's tracked range (both WeightedRange, see
// src/core/ranges/weighted-range.ts) on the real board, with the live pot,
// effective stack, position and any bet hero is facing. It runs the
// range-vs-range Discounted CFR in ./postflop-cfr.ts under a wall-clock budget,
// measures exploitability (best-response gap within the abstraction) as it
// goes, stops early once that gap is small, and returns hero's mixed strategy
// for the hand hero actually holds.
//
// Scope: heads-up only. Turn and river are the intended use (the river leaf is
// an exact showdown; the turn leaf enumerates every river card). The flop is
// supported but the single-street equity leaf is the weakest approximation
// there (it assumes the hand checks down after the flop betting), so the
// engine should only use flop results if it opts in. See docs/POSTFLOP_CFR.md.
//
// Chip conventions (all inputs in the same chip units the engine uses):
//   pot             every chip in the middle right now, INCLUDING all bets
//                   made on this street by both players (and so including the
//                   bet hero is facing).
//   toCall          chips hero must add to call (0 if not facing a bet).
//   effectiveStack  chips hero can still put in from now on, capped by what
//                   villain can match: min(heroStack, villainStack + toCall).
// Inside the solve the starting pot is pot - toCall and villain is treated as
// having committed toCall, so a hero call produces a pot of pot + toCall.
// ============================================================

import { ActionType, CardId, StrategyDistribution, Street } from '../../types/poker';
import { WeightedRange, normalizeRange } from '../ranges/weighted-range';
import { evaluateHand } from '../equity/hand-eval';
import {
  BetAbstraction,
  RangeHand,
  RangeVsRangeCfr,
  TreeAction,
  defaultAbstraction,
} from './postflop-cfr';

export interface SubgameInput {
  heroCards: [CardId, CardId];
  /** 3, 4 or 5 board cards. */
  board: CardId[];
  /** Hero's range as villain would perceive it. Hero's exact hand is added
   *  with a negligible weight if absent (its own strategy does not depend on
   *  its weight; see note in pickHeroIndex). */
  heroRange: WeightedRange;
  /** Villain's range from the range tracker. */
  villainRange: WeightedRange;
  pot: number;
  effectiveStack: number;
  toCall: number;
  heroIsIP: boolean;
  /** Optional; validated against the board length when given. */
  street?: Street;
  /** Wall-clock budget for the whole call, including precompute. Default 1500. */
  budgetMs?: number;
  /** Iteration cap. Default 5000 (the time budget normally binds first). */
  maxIterations?: number;
  /** Stop early once exploitability (% of pot) is at or below this.
   *  Default 0.3. Also defines `converged`. */
  targetExploitabilityPct?: number;
  /** Override parts of the per-street default abstraction. */
  abstraction?: Partial<BetAbstraction>;
  /** Cap per side. Larger ranges are thinned by reduceRange (weight-preserving
   *  threshold sampling, stratified by hand strength), never by dropping the
   *  lowest weights. Default 200 on the turn/river and 120 on the flop. */
  maxCombosPerSide?: number;
  /** Chips hero already put in on THIS street (only used to report the
   *  `raiseTo` street total for bet/raise actions). Default 0. */
  heroStreetCommitted?: number;
  /** Bets/raises already made on this street before hero's decision. Default
   *  1 when facing a bet, 0 otherwise. Use 2 when hero faces a raise. */
  priorAggressions?: number;
  /** Flop only: runouts sampled for the equity leaf. Default 300. */
  maxFlopRunouts?: number;
  /** Check exploitability every this many iterations. Default 10. */
  exploitEvery?: number;
  /** When true, record every exploitability check in `trace`. */
  trace?: boolean;
  seed?: number;
}

export interface SubgameAction {
  kind: TreeAction['kind'];
  /** Compact label: 'F', 'X', 'C', 'B33', 'B75', 'B125', 'R70', 'A'. */
  label: string;
  /** Chips hero adds with this action (0 for fold/check). */
  chips: number;
  /** For bet/raise/allin: hero's total street commitment after the action
   *  (heroStreetCommitted + chips), i.e. the "raise to" amount. */
  raiseTo: number;
  /** chips / pot-before-action. */
  potFraction: number;
  /** Solved probability for hero's actual hand. */
  probability: number;
  /** Range-weighted frequency of this action across hero's whole range. */
  rangeFrequency: number;
  /** EV (chips, net from now) of taking this action with hero's hand when
   *  both sides otherwise follow the solved strategies. */
  ev: number;
}

export interface SubgameResult {
  /** Action label -> probability for hero's actual hand (sums to 1). */
  strategy: Record<string, number>;
  /** The same in the project's StrategyDistribution shape. Bet amounts are
   *  street "to" totals (raiseTo), the convention BotDecision.amount and
   *  mixedStrategy.bets use in engine.ts. */
  distribution: StrategyDistribution;
  /** Every root action with its size, probability and EV. */
  actions: SubgameAction[];
  /** Chip sizes (chips added) of the bet/raise/all-in options at the root. */
  sizes: number[];
  /** Hero's EV with its actual hand under the solved strategies (chips, net
   *  from now: what hero ends with minus what hero still puts in, plus nothing
   *  for chips already in the pot). */
  heroEv: number;
  /** Best-response gap within the abstraction, NashConv / 2, as % of pot. */
  exploitability: number;
  /** The same gap in chips. */
  exploitabilityChips: number;
  iterations: number;
  ms: number;
  /** exploitability <= targetExploitabilityPct when the solve stopped. */
  converged: boolean;
  street: Street;
  combos: { hero: number; villain: number };
  /** Exploitability checkpoints when input.trace is set. */
  trace?: { iteration: number; ms: number; exploitability: number }[];
}

const STREET_BY_BOARD: Record<number, Street> = { 3: 'flop', 4: 'turn', 5: 'river' };

/**
 * Solve the spot and return hero's strategy. Throws on invalid input (bad
 * board, collisions, empty ranges); the caller falls back to its heuristic.
 */
export function solveSubgame(input: SubgameInput): SubgameResult {
  const start = Date.now();
  const budgetMs = input.budgetMs ?? 1500;
  const street = STREET_BY_BOARD[input.board.length];
  if (!street) throw new Error(`solveSubgame needs a 3-5 card board (got ${input.board.length}).`);
  if (input.street && input.street !== street) {
    throw new Error(`street '${input.street}' does not match a ${input.board.length}-card board.`);
  }
  const boardSet = new Set<number>(input.board);
  if (boardSet.size !== input.board.length) throw new Error('Duplicate board card.');
  const [h1, h2] = input.heroCards;
  if (h1 === h2 || boardSet.has(h1) || boardSet.has(h2)) throw new Error('Hero cards collide with the board.');
  const toCall = Math.max(0, input.toCall);
  if (!(input.pot > 0)) throw new Error('pot must be positive.');
  if (toCall >= input.pot) throw new Error('pot must include the bet hero is facing (pot > toCall).');
  if (!(input.effectiveStack > 0)) throw new Error('effectiveStack must be positive.');

  // Ranges. Only the BOARD is dead for range purposes. Villain combos that
  // share a card with hero's actual hand stay in the solve: villain's strategy
  // must be computed against hero's whole range, and the solver already
  // excludes card-conflicting pairs from every value it computes, so hero's
  // actual hand never "plays against" a combo it blocks.
  const cap = input.maxCombosPerSide ?? (street === 'flop' ? 120 : 200);
  const villain = reduceRange(toRangeHands(normalizeRange(input.villainRange, input.board)), cap, input.board);
  let hero = reduceRange(toRangeHands(normalizeRange(input.heroRange, input.board)), cap, input.board);
  const heroIdx = pickHeroIndex(hero, input.heroCards);
  if (heroIdx < 0) hero = [...hero, { cards: input.heroCards, weight: negligibleWeight(hero) }];
  const hi = heroIdx < 0 ? hero.length - 1 : heroIdx;
  if (villain.length === 0) throw new Error('Villain range is empty after removing board-blocked combos.');

  const abstraction: BetAbstraction = { ...defaultAbstraction(input.board.length), ...(input.abstraction ?? {}) };
  const startingPot = input.pot - toCall;
  const solver = new RangeVsRangeCfr({
    board: input.board,
    hero,
    villain,
    tree: {
      startingPot,
      effectiveStack: input.effectiveStack,
      toCall,
      heroIsIP: input.heroIsIP,
      priorAggressions: input.priorAggressions ?? (toCall > 0 ? 1 : 0),
      abstraction,
    },
    maxFlopRunouts: input.maxFlopRunouts ?? 300,
    seed: input.seed ?? 1,
  });

  // ---- CFR loop under the wall-clock budget ----
  const maxIterations = input.maxIterations ?? 5000;
  const target = input.targetExploitabilityPct ?? 0.3;
  const every = Math.max(1, input.exploitEvery ?? 10);
  const toPct = (chips: number) => (100 * chips) / input.pot;
  const trace: { iteration: number; ms: number; exploitability: number }[] = [];
  let lastExpl = Infinity;
  let lastExplIter = -1;
  let iterMs = 0; // running estimate of one iteration's cost
  let brMs = 0; // running estimate of one exploitability pass
  const measure = () => {
    const t0 = Date.now();
    lastExpl = solver.exploitability();
    brMs = Math.max(brMs, Date.now() - t0);
    lastExplIter = solver.iterations;
    if (input.trace) trace.push({ iteration: solver.iterations, ms: Date.now() - start, exploitability: toPct(lastExpl) });
  };

  while (solver.iterations < maxIterations) {
    const t0 = Date.now();
    solver.iterate();
    const dt = Date.now() - t0;
    iterMs = iterMs === 0 ? dt : 0.8 * iterMs + 0.2 * dt;
    if (solver.iterations % every === 0) {
      measure();
      if (toPct(lastExpl) <= target) break;
    }
    // Stop when another iteration plus the final exploitability pass would
    // overrun the budget.
    if (Date.now() - start + iterMs + brMs >= budgetMs) break;
  }
  if (lastExplIter !== solver.iterations) measure();

  // ---- Read out hero's strategy ----
  const root = solver.root;
  const H = hero.length;
  const avg = solver.averageStrategy(root);
  const probs = root.actions.map((_, a) => avg[a * H + hi]);
  const freqs = solver.rangeFrequencies(root);
  const actionEvs = actionValues(solver, hi);
  const heroEvs = solver.comboValues(0);
  const committed = input.heroStreetCommitted ?? 0;

  const actions: SubgameAction[] = root.actions.map((a, k) => ({
    kind: a.kind,
    label: a.label,
    chips: a.chips,
    raiseTo: a.kind === 'bet' || a.kind === 'raise' || a.kind === 'allin' ? committed + a.chips : 0,
    potFraction: a.potFraction,
    probability: probs[k],
    rangeFrequency: freqs[k],
    ev: actionEvs[k],
  }));
  const strategy: Record<string, number> = {};
  for (const a of actions) strategy[a.label] = a.probability;
  const exploitChips = lastExpl;

  return {
    strategy,
    distribution: toDistribution(actions),
    actions,
    sizes: root.actions.filter((a) => a.chips > 0 && a.kind !== 'call').map((a) => a.chips),
    heroEv: Number.isFinite(heroEvs[hi]) ? heroEvs[hi] : 0,
    exploitability: toPct(exploitChips),
    exploitabilityChips: exploitChips,
    iterations: solver.iterations,
    ms: Date.now() - start,
    converged: toPct(exploitChips) <= target,
    street,
    combos: { hero: H, villain: villain.length },
    trace: input.trace ? trace : undefined,
  };
}

/**
 * EV of each root action for hero combo `hi`: hero takes that action, then
 * everyone follows the solved average strategies. Computed by evaluating each
 * child subtree with the villain reach at the root.
 */
function actionValues(solver: RangeVsRangeCfr, hi: number): number[] {
  // comboValues() evaluates the whole tree under average strategies; to get
  // per-action values we temporarily force hero's root strategy to each pure
  // action in turn. The strategySum is restored afterwards.
  const root = solver.root;
  const S = root.strategySum!;
  const saved = Float64Array.from(S);
  const H = solver.hands[0].length;
  const A = root.actions.length;
  const out: number[] = [];
  for (let a = 0; a < A; a++) {
    for (let k = 0; k < A; k++) S[k * H + hi] = k === a ? 1 : 0;
    const v = solver.comboValues(0)[hi];
    out.push(Number.isFinite(v) ? v : 0);
  }
  S.set(saved);
  return out;
}

function toRangeHands(r: WeightedRange): RangeHand[] {
  return r.combos.map((c, i) => ({ cards: [c[0], c[1]] as [CardId, CardId], weight: r.weights[i] }));
}

/**
 * Shrink a range to at most `cap` combos without biasing its composition.
 *
 * The old rule kept the `cap` highest-weight combos. A tracker range that has
 * been narrowed by villain's bets carries its value hands at high weight and
 * its bluffs and draws at low weight, so a top-weight cut deleted the bluffs
 * and the solver folded bluff-catchers against a value-only range.
 *
 * This is threshold sampling, the resampling rule of Fearnhead and Clifford,
 * "On-line inference for hidden Markov models via particle filters", JRSS-B
 * 2003. A threshold tau is chosen so that the expected number of kept combos
 * is exactly `cap`:
 *   - a combo with weight >= tau is kept with its own weight;
 *   - a combo with weight w < tau is kept with probability w / tau and, when
 *     kept, gets weight tau.
 * Every combo's expected kept weight therefore equals its original weight.
 * The small combos are drawn by systematic sampling (one fixed offset, no RNG)
 * along an order sorted by made-hand strength on this board, which stratifies
 * the draw: each made-hand strength band (air, bluff-catchers, value) keeps
 * its share of the weight to within one combo of weight tau. Draws are not a
 * separate band; they sit with the made hands of the same rank and are thinned
 * with them. The result is deterministic for a given range and board.
 *
 * Kept weights are rescaled so the kept total equals the input total. Hero's
 * exact hand is not forced in: solveSubgame adds hero's exact hand with a negligible
 * weight when it is missing (its own weight does not change its strategy).
 */
export function reduceRange(r: RangeHand[], cap: number, board: CardId[]): RangeHand[] {
  if (r.length <= cap) return r;
  if (cap < 1) throw new Error('reduceRange needs cap >= 1.');
  const n = r.length;
  const w = r.map((h) => (h.weight > 0 ? h.weight : 0));
  let total = 0;
  for (const x of w) total += x;
  if (!(total > 0)) throw new Error('Range has no positive weight.');

  // Threshold: walk the weights from largest down. With the k largest kept
  // whole, tau_k = (mass of the rest) / (cap - k); stop at the first k whose
  // next weight is below tau_k.
  const desc = w.map((_, i) => i).sort((a, b) => w[b] - w[a] || a - b);
  let rest = total;
  let k = 0;
  let tau = rest / cap;
  while (k < cap - 1 && w[desc[k]] >= tau) {
    rest -= w[desc[k]];
    k++;
    tau = rest / (cap - k);
  }
  // If every slot but one went to a big combo, the last slot covers the rest.
  if (w[desc[k]] >= tau) tau = Math.max(tau, w[desc[k]]);

  const big = new Set<number>();
  for (let i = 0; i < k; i++) big.add(desc[i]);
  const out: { i: number; weight: number }[] = [];
  for (const i of big) out.push({ i, weight: w[i] });

  // Small combos, ordered by made-hand strength (ties keep input order), then
  // systematic sampling with offset 0.5 at inclusion probabilities w / tau.
  const small: number[] = [];
  for (let i = 0; i < n; i++) if (!big.has(i) && w[i] > 0) small.push(i);
  const strength = new Map<number, number>();
  for (const i of small) strength.set(i, handStrength(r[i].cards, board));
  small.sort((a, b) => strength.get(a)! - strength.get(b)! || a - b);
  let cum = 0;
  let next = 0.5;
  for (const i of small) {
    cum += w[i] / tau;
    if (cum > next) {
      out.push({ i, weight: tau });
      next += 1;
    }
  }

  let kept = 0;
  for (const o of out) kept += o.weight;
  const scale = kept > 0 ? total / kept : 1;
  out.sort((a, b) => a.i - b.i);
  return out.map((o) => ({ cards: r[o.i].cards, weight: o.weight * scale }));
}

/** Made-hand rank of a combo on the board (higher is stronger). */
function handStrength(cards: [CardId, CardId], board: CardId[]): number {
  if (board.length < 3) return 0;
  return evaluateHand([cards[0], cards[1], ...board]);
}

function sameHand(a: [CardId, CardId], b: [CardId, CardId]): boolean {
  return (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);
}

/**
 * Index of hero's exact hand in hero's range, or -1. When absent it is added
 * with a negligible weight: a combo's regrets depend only on the OPPONENT's
 * reach, and its average strategy is a ratio of reach-weighted sums in which
 * its own chance weight cancels, so the weight changes nothing about hero's
 * own strategy while leaving villain's view of hero's range intact.
 */
function pickHeroIndex(r: RangeHand[], hand: [CardId, CardId]): number {
  return r.findIndex((h) => sameHand(h.cards, hand));
}

function negligibleWeight(r: RangeHand[]): number {
  let s = 0;
  for (const h of r) s += h.weight;
  return s > 0 ? s * 1e-6 : 1;
}

/** StrategyDistribution with bet amounts as street totals (raiseTo). */
function toDistribution(actions: SubgameAction[]): StrategyDistribution {
  const d: StrategyDistribution = { fold: 0, check: 0, call: 0, bets: [] };
  for (const a of actions) {
    if (a.kind === 'fold') d.fold += a.probability;
    else if (a.kind === 'check') d.check += a.probability;
    else if (a.kind === 'call') d.call += a.probability;
    else d.bets.push({ amount: a.raiseTo, probability: a.probability });
  }
  return d;
}

// ------------------------------------------------------------
// Engine helpers: when to solve, and how to turn the result into an action
// ------------------------------------------------------------

export interface SubgameEligibilityInput {
  street: Street;
  /** Opponents still in the hand (not folded, not sitting out). */
  opponentsInHand: number;
  /** Combos in each range after removing board-blocked and zero-weight ones. */
  heroCombos: number;
  villainCombos: number;
  pot: number;
  toCall: number;
  effectiveStack: number;
  /** Allow flop solves (default false: the flop equity leaf is the weakest). */
  allowFlop?: boolean;
}

/** Turn SPR cap. The turn leaf values a called bet as if the hand checks down
 *  the river, which matters more the deeper the stacks; above this SPR the
 *  engine's other paths are preferred. A conservative default, not a tuned
 *  value. */
export const SUBGAME_MAX_TURN_SPR = 6;
/** Below this many villain combos the range is too thin to trust (a tracker
 *  that narrowed to almost nothing is more likely wrong than precise). */
export const SUBGAME_MIN_VILLAIN_COMBOS = 5;

/**
 * Whether the engine should call solveSubgame for this spot. Returns the
 * reason when it should not, for the decision log.
 */
export function subgameEligibility(x: SubgameEligibilityInput): { ok: boolean; reason: string } {
  if (x.opponentsInHand !== 1) return { ok: false, reason: `not heads-up (${x.opponentsInHand} opponents)` };
  if (x.street === 'preflop') return { ok: false, reason: 'preflop' };
  if (x.street === 'flop' && !x.allowFlop) return { ok: false, reason: 'flop solves disabled' };
  if (x.villainCombos < SUBGAME_MIN_VILLAIN_COMBOS) return { ok: false, reason: `villain range too thin (${x.villainCombos})` };
  if (x.heroCombos < 1) return { ok: false, reason: 'no hero range' };
  if (!(x.pot > x.toCall) || !(x.effectiveStack > 0)) return { ok: false, reason: 'degenerate pot/stack' };
  const spr = (x.effectiveStack - x.toCall) / (x.pot + x.toCall);
  if (x.street === 'turn' && spr > SUBGAME_MAX_TURN_SPR) return { ok: false, reason: `turn SPR ${spr.toFixed(1)} > ${SUBGAME_MAX_TURN_SPR}` };
  return { ok: true, reason: 'ok' };
}

/**
 * Pick one action from the solved mix. With `u` in [0,1) the action is sampled
 * (so the bot actually plays the equilibrium mix); without it the most likely
 * action is returned. `amount` is the street total (raiseTo) for bet/raise/
 * allin, and the call amount for a call.
 */
export function pickSubgameAction(
  result: SubgameResult,
  u?: number,
): { action: ActionType; amount?: number; label: string; probability: number } {
  const acts = result.actions;
  let k = 0;
  if (u === undefined) {
    for (let i = 1; i < acts.length; i++) if (acts[i].probability > acts[k].probability) k = i;
  } else {
    let acc = 0;
    k = acts.length - 1;
    for (let i = 0; i < acts.length; i++) {
      acc += acts[i].probability;
      if (u < acc) { k = i; break; }
    }
  }
  const a = acts[k];
  const action: ActionType = a.kind === 'allin' ? 'allin' : a.kind;
  const amount = a.kind === 'call' ? a.chips : a.kind === 'fold' || a.kind === 'check' ? undefined : a.raiseTo;
  return { action, amount, label: a.label, probability: a.probability };
}
