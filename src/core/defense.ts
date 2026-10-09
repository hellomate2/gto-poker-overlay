/**
 * defense.ts — how to respond when villain bets or raises into hero, and when
 * hero should keep barreling. Pure functions over WeightedRange (the shared
 * contract in ranges/weighted-range.ts), so they plug into the range tracker.
 *
 * WHY THIS EXISTS (measured, see sim/range-fold.probe.ts): facing a 3x
 * raise, the live engine folded 56-78% of its own betting range across every
 * board/street probed, above the 53-58% at which a ZERO-equity bluff raise
 * breaks even. A villain who raised any two cards printed money. The cause is
 * that every facing-a-bet gate (the net's anti-punt floor, sanityCheck, the
 * soundness gate) measures hero's equity against villainContinuingRange(
 * {aggression:true}), a range that contains ONLY value hands (sets, overpairs,
 * top/second pair, made straights/flushes) and no bluffs, then demands
 * equity >= pot odds against it. Against a range with no bluffs every
 * bluff-catcher is a fold, so the bot over-folds by construction.
 *
 * The fix here is the textbook defense rule set:
 *
 *   1. MINIMUM DEFENSE FREQUENCY. A bet of size s (as a fraction of the pot it
 *      goes into) risks s to win 1, so a zero-equity bluff breaks even when hero
 *      folds s / (1 + s) of the time. Hero must therefore continue with at least
 *          MDF = 1 / (1 + s)  =  potBefore / (potBefore + bet)
 *      of the range it arrived with, or any two cards profit. Hero ranks its OWN
 *      range by equity vs villain's (narrowed) range and continues with roughly
 *      the top MDF share.
 *   2. POT ODDS. Independently, any hand whose equity vs villain's range beats
 *      the price toCall / (pot + toCall) continues.
 *   3. The two combine into one equity threshold: continue when equity is at
 *      least min(potOdds, equity at hero's MDF boundary), never below a floor of
 *      (1 - MDF_RESCUE) * potOdds. The MDF boundary only LOWERS the bar when
 *      hero's range is weak relative to villain's (that is exactly when an
 *      opponent can raise any two), and the floor stops MDF from dragging
 *      hopeless hands along.
 *   4. BLOCKERS. All equities are computed with exact card removal: a hero
 *      combo is compared only against villain combos that share no card with it.
 *      So a river bluff-catcher holding the nut-flush card faces fewer flush
 *      combos and shows higher equity than the same-strength hand without it,
 *      which ranks it higher inside the MDF cut and calls more often. The
 *      blockerScore in the result reports the effect explicitly; it is not added
 *      on top (that would count the same combos twice).
 *   5. RAISES only with clear margins: value-raise when far ahead of villain's
 *      range AND currently ahead at showdown; semibluff-raise (not river) only a
 *      real draw that already has the price to call and gains a lot from the
 *      runout.
 *
 * barrelGate() covers the other half of the tester report (barreling flop, turn
 * and river regardless of what villain called with): it compares the EV of
 * betting against checking given villain's narrowed range, assuming villain
 * continues with every combo that has the pot odds to do so vs hero's range.
 */
import { CardId } from '../types/poker';
import { WeightedRange, normalizeRange } from './ranges/weighted-range';
import { evaluateHand, HAND_CATEGORY } from './equity/hand-eval';
import { leadBetProbability } from './cbet';

export type PostflopStreet = 'flop' | 'turn' | 'river';

// ============================================================
// Tunables (each one documented; all are probability/equity units)
// ============================================================

/**
 * How far below the pot-odds price the MDF rule may pull the continue
 * threshold: threshold >= (1 - MDF_RESCUE) * potOdds. 0 would mean pure pot
 * odds; 1 would let MDF continue any hand in the top-MDF share no matter how
 * little equity it has. 0.35 keeps a bluff-catcher that is a modest underdog to
 * the estimated price (the estimate itself under-counts bluffs) while still
 * folding hands that are near drawing dead.
 */
export const MDF_RESCUE = 0.35;

/** Equity vs villain's range needed to RAISE for value, by street. */
const VALUE_RAISE_EQ: Record<PostflopStreet, number> = { flop: 0.68, turn: 0.72, river: 0.80 };
/** Extra equity demanded when hero's raise would be a re-raise (hero bet, got raised). */
const RERAISE_PREMIUM = 0.06;
/** A semibluff raise needs at least this much runout equity (and the price to call). */
const SEMIBLUFF_MIN_EQ = 0.33;
/** ...and must be behind NOW (showdown equity on the current board below this)... */
const SEMIBLUFF_MAX_SHOWDOWN_EQ = 0.35;
/** ...and gain at least this much equity from the cards to come. */
const SEMIBLUFF_MIN_DRAW_GAIN = 0.15;
/** No semibluff raise into a bet bigger than this fraction of the pot. */
const SEMIBLUFF_MAX_SIZE_FRAC = 1.0;
/** Default number of sampled (turn, river) runouts on the flop. Turn and river enumerate exactly. */
export const DEFAULT_FLOP_RUNOUTS = 150;

// ============================================================
// Range-vs-range equity with exact card removal
// ============================================================

export interface RangeEquityOptions {
  /** Flop only: number of (turn, river) runouts to sample. Default DEFAULT_FLOP_RUNOUTS. */
  runouts?: number;
  /** Seed for the flop runout sample (deterministic by default). */
  seed?: number;
  /** Ignore the cards to come and compare hands on the current board only. */
  showdownOnly?: boolean;
}

/**
 * Equity of each hero combo vs a weighted villain range, with exact card removal
 * (a hero combo only meets villain combos that share no card with it) and the
 * board run out (river: as is; turn: every river card; flop: a seeded sample of
 * turn+river pairs, or all of them if `runouts` >= 1176).
 *
 * Method, per completed board: evaluate every live villain combo once, sort by
 * strength, and keep prefix sums of weight, both globally and per card. For a
 * hero combo {a, b} with strength r:
 *     below(r) = W_all(<r) - W_a(<r) - W_b(<r)            (villain combos it beats)
 *     equal(r) = W_all(=r) - W_a(=r) - W_b(=r) + w({a,b})  (ties; {a,b} itself was subtracted twice)
 *     total    = W_all - W_a - W_b + w({a,b})
 * where W_c is the weight of villain combos containing card c. This is the
 * standard O((H + V) log V) card-removal trick instead of an O(H * V) loop.
 * Each runout contributes in proportion to the villain weight compatible with
 * it, so the result is the exact joint average over (runout, villain combo).
 *
 * Returns NaN for a hero combo that collides with the board or never meets a
 * compatible villain combo.
 */
export function rangeEquities(
  heroCombos: [CardId, CardId][],
  villainRange: WeightedRange,
  board: CardId[],
  opts: RangeEquityOptions = {},
): Float64Array {
  const vil = normalizeRange(villainRange, board);
  const H = heroCombos.length;
  const num = new Float64Array(H);
  const den = new Float64Array(H);
  const boardSet = new Set(board);

  // Weight of each villain combo by its card pair, for the "identical combo" term.
  const idW = new Float64Array(52 * 52);
  for (let i = 0; i < vil.combos.length; i++) {
    const [a, b] = vil.combos[i];
    idW[a * 52 + b] += vil.weights[i];
  }

  const runouts = opts.showdownOnly ? [[]] : enumerateRunouts(board, opts.runouts ?? DEFAULT_FLOP_RUNOUTS, opts.seed);
  const full: CardId[] = [];
  for (const ro of runouts) {
    full.length = 0;
    full.push(...board, ...ro);
    const roSet = new Set<CardId>(ro);

    // Villain combos live on this runout, with their strength on the full board.
    const vIdx: number[] = [];
    const vRank: number[] = [];
    for (let i = 0; i < vil.combos.length; i++) {
      const [a, b] = vil.combos[i];
      if (roSet.has(a) || roSet.has(b)) continue;
      vIdx.push(i);
      vRank.push(evaluateHand([a, b, ...full]));
    }
    if (vIdx.length === 0) continue;
    const order = vIdx.map((_, k) => k).sort((x, y) => vRank[x] - vRank[y]);

    // Global and per-card sorted rank lists with prefix weight sums.
    const allR: number[] = [];
    const allP: number[] = [0];
    const cardR: number[][] = Array.from({ length: 52 }, () => []);
    const cardP: number[][] = Array.from({ length: 52 }, () => [0]);
    for (const k of order) {
      const i = vIdx[k];
      const w = vil.weights[i];
      const r = vRank[k];
      allR.push(r); allP.push(allP[allP.length - 1] + w);
      for (const c of vil.combos[i]) {
        cardR[c].push(r);
        cardP[c].push(cardP[c][cardP[c].length - 1] + w);
      }
    }
    const Wall = allP[allP.length - 1];

    for (let h = 0; h < H; h++) {
      const [a, b] = heroCombos[h];
      if (a === b || boardSet.has(a) || boardSet.has(b) || roSet.has(a) || roSet.has(b)) continue;
      const r = evaluateHand([a, b, ...full]);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      // The identical villain combo is live on this runout iff the hero combo is.
      const wId = idW[lo * 52 + hi];
      const total = Wall - last(cardP[a]) - last(cardP[b]) + wId;
      if (!(total > 1e-12)) continue;
      const below = sumBelow(allR, allP, r) - sumBelow(cardR[a], cardP[a], r) - sumBelow(cardR[b], cardP[b], r);
      const le = sumAtMost(allR, allP, r) - sumAtMost(cardR[a], cardP[a], r) - sumAtMost(cardR[b], cardP[b], r) + wId;
      const equal = le - below;
      num[h] += below + 0.5 * equal;
      den[h] += total;
    }
  }
  const out = new Float64Array(H);
  for (let h = 0; h < H; h++) out[h] = den[h] > 0 ? num[h] / den[h] : NaN;
  return out;
}

function last(a: number[]): number { return a[a.length - 1]; }
/** Sum of weights with rank < r (ranks ascending, prefix[0] = 0). */
function sumBelow(ranks: number[], prefix: number[], r: number): number {
  let lo = 0, hi = ranks.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ranks[m] < r) lo = m + 1; else hi = m; }
  return prefix[lo];
}
/** Sum of weights with rank <= r. */
function sumAtMost(ranks: number[], prefix: number[], r: number): number {
  let lo = 0, hi = ranks.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ranks[m] <= r) lo = m + 1; else hi = m; }
  return prefix[lo];
}

/** Cards to come: river -> [[]]; turn -> each live river card; flop -> sampled (turn, river) pairs. */
function enumerateRunouts(board: CardId[], flopRunouts: number, seed?: number): CardId[][] {
  const dead = new Set(board);
  const live: CardId[] = [];
  for (let c = 0; c < 52; c++) if (!dead.has(c)) live.push(c);
  if (board.length >= 5) return [[]];
  if (board.length === 4) return live.map(c => [c]);
  if (board.length !== 3) throw new Error(`defense: board must have 3-5 cards, got ${board.length}`);
  const pairs: CardId[][] = [];
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) pairs.push([live[i], live[j]]);
  if (flopRunouts >= pairs.length) return pairs;
  // Deterministic partial Fisher-Yates keyed on the board, so the same spot
  // always gives the same answer (stable decisions, reproducible tests).
  const rng = mulberry32(seed ?? board.reduce((h, c) => (h * 53 + c + 1) >>> 0, 2166136261));
  for (let i = 0; i < flopRunouts; i++) {
    const j = i + Math.floor(rng() * (pairs.length - i));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  return pairs.slice(0, flopRunouts);
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
// Facing aggression: fold / call / raise
// ============================================================

export interface DefenseInput {
  heroCards: [CardId, CardId];
  /** 3 to 5 community cards. */
  board: CardId[];
  /**
   * Hero's range for the line hero took (what villain should think hero holds).
   * Used to place hero's hand within it for the MDF rule. Optional: without it
   * the decision is pure pot odds and heroRangePercentile is NaN.
   */
  heroRange?: WeightedRange | null;
  /** Villain's range, already narrowed by villain's actions (including this bet/raise). */
  villainRange: WeightedRange;
  /**
   * Chips in the middle NOW: everything from earlier streets plus both players'
   * chips this street, including villain's bet/raise, excluding hero's call.
   * (Same convention as GameState.pot in the engine and the simulator.)
   */
  pot: number;
  /** Chips hero must add to call. */
  toCall: number;
  street: PostflopStreet;
  /**
   * Villain's aggressive action as a fraction of the pot it went into: a bet B
   * into P is B/P; a raise to R over hero's bet b with P before hero's bet is
   * R/(P + b). Sets MDF = 1/(1 + frac). When omitted it is derived from pot and
   * toCall assuming villain bet into an unbet pot: toCall / (pot - toCall).
   */
  villainActionSizeFrac?: number;
  /** Hero already bet/raised this street and is facing a raise (re-raising is a 3-bet+). */
  facingRaise?: boolean;
  /** Hero's chips behind before acting. A call of the whole stack cannot be a raise. */
  heroStack?: number;
  /** Flop runout sample size (see rangeEquities). */
  runouts?: number;
}

export interface DefenseResult {
  action: 'fold' | 'call' | 'raise';
  /** Minimum equity vs villain's range at which hero continues in this spot. */
  continueThreshold: number;
  /** Minimum defense frequency 1/(1 + villainActionSizeFrac). */
  mdf: number;
  /** Hero's position in its own range by equity: 0 = strongest, 1 = weakest. NaN without heroRange. */
  heroRangePercentile: number;
  /** Hero equity vs villain's range (card removal exact, board run out). */
  equity: number;
  reasoning: string;
  /** toCall / (pot + toCall). */
  potOdds: number;
  /** Equity of the hero-range combo at the MDF boundary. NaN without heroRange. */
  mdfEquity: number;
  /** Hero equity vs villain's range on the CURRENT board (no cards to come). */
  showdownEquity: number;
  /**
   * Share of villain's value (combos beating hero now) that hero's cards block,
   * minus the share of villain's bluffs (combos hero beats now) they block.
   * Positive = good bluff-catcher blockers. Informational; already inside equity.
   */
  blockerScore: number;
  raiseKind?: 'value' | 'semibluff';
}

/**
 * Decide fold / call / raise facing a bet or raise. See the file header for the
 * rules; the reasoning string spells out the numbers that drove the decision.
 */
export function defendVsAggression(input: DefenseInput): DefenseResult {
  const { heroCards, board, street } = input;
  const pot = Math.max(0, input.pot);
  const toCall = Math.max(0, input.toCall);
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
  const sizeFrac = input.villainActionSizeFrac ?? (pot > toCall ? toCall / (pot - toCall) : 1);
  const mdf = 1 / (1 + Math.max(0, sizeFrac));
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const runoutOpts: RangeEquityOptions = { runouts: input.runouts };

  // Hero's own combo first, then (optionally) the hero range, evaluated in one pass.
  const heroCombo: [CardId, CardId] = [Math.min(...heroCards), Math.max(...heroCards)];
  const heroR = input.heroRange ? normalizeRange(input.heroRange, board) : null;
  const combos: [CardId, CardId][] = [heroCombo, ...(heroR ? heroR.combos : [])];
  const eqs = rangeEquities(combos, input.villainRange, board, runoutOpts);
  const equity = Number.isFinite(eqs[0]) ? eqs[0] : 0.5; // empty villain range: neutral
  const showdownEquity = board.length >= 5
    ? equity
    : valueOr(rangeEquities([heroCombo], input.villainRange, board, { showdownOnly: true })[0], equity);
  const blockerScore = blockerScoreOf(heroCombo, input.villainRange, board);

  // ---- MDF: where does hero sit in its own range? ----
  let heroRangePercentile = NaN;
  let mdfEquity = NaN;
  if (heroR && heroR.combos.length > 0) {
    const entries: { eq: number; w: number }[] = [];
    let total = 0;
    for (let i = 0; i < heroR.combos.length; i++) {
      const e = eqs[i + 1];
      if (!Number.isFinite(e)) continue;
      entries.push({ eq: e, w: heroR.weights[i] });
      total += heroR.weights[i];
    }
    if (total > 0) {
      entries.sort((x, y) => y.eq - x.eq);
      // Percentile: weight strictly stronger + half the ties, over the total.
      let above = 0, tie = 0;
      for (const en of entries) {
        if (en.eq > equity + 1e-9) above += en.w;
        else if (en.eq >= equity - 1e-9) tie += en.w;
      }
      heroRangePercentile = (above + 0.5 * tie) / total;
      // Equity of the combo where the cumulative share from the top reaches MDF.
      let cum = 0;
      mdfEquity = entries[entries.length - 1].eq;
      for (const en of entries) {
        cum += en.w;
        if (cum >= mdf * total - 1e-12) { mdfEquity = en.eq; break; }
      }
    }
  }

  // ---- Continue threshold: pot odds, lowered toward the MDF boundary, floored ----
  const floor = (1 - MDF_RESCUE) * potOdds;
  const continueThreshold = Number.isFinite(mdfEquity)
    ? Math.max(floor, Math.min(potOdds, mdfEquity))
    : potOdds;
  const continues = equity >= continueThreshold - 1e-12;
  const mdfRescued = continues && equity < potOdds;

  const allInCall = input.heroStack !== undefined && toCall >= input.heroStack;
  const base = {
    continueThreshold, mdf, heroRangePercentile, equity, potOdds, mdfEquity, showdownEquity, blockerScore,
  };
  const where = Number.isFinite(heroRangePercentile)
    ? `top ${pct(heroRangePercentile)} of range, MDF ${pct(mdf)}`
    : `no hero range, MDF ${pct(mdf)}`;
  const blk = street === 'river' && Math.abs(blockerScore) >= 0.05
    ? `, blockers ${blockerScore > 0 ? '+' : ''}${blockerScore.toFixed(2)}` : '';

  // ---- Raises (clear margins only) ----
  if (!allInCall) {
    const valueBar = VALUE_RAISE_EQ[street] + (input.facingRaise ? RERAISE_PREMIUM : 0);
    if (equity >= valueBar && showdownEquity >= 0.5) {
      return {
        ...base, action: 'raise', raiseKind: 'value',
        reasoning: `value raise: ${pct(equity)} vs range >= ${pct(valueBar)} (${where}) [defense]`,
      };
    }
    const semiBar = Math.max(potOdds, SEMIBLUFF_MIN_EQ + (input.facingRaise ? RERAISE_PREMIUM : 0));
    if (
      street !== 'river' &&
      sizeFrac <= SEMIBLUFF_MAX_SIZE_FRAC &&
      equity >= semiBar &&
      showdownEquity < SEMIBLUFF_MAX_SHOWDOWN_EQ &&
      equity - showdownEquity >= SEMIBLUFF_MIN_DRAW_GAIN
    ) {
      return {
        ...base, action: 'raise', raiseKind: 'semibluff',
        reasoning: `semibluff raise: draw ${pct(showdownEquity)} now -> ${pct(equity)} with runouts, price ${pct(potOdds)} [defense]`,
      };
    }
  }

  if (continues) {
    return {
      ...base, action: 'call',
      reasoning: mdfRescued
        ? `call (MDF): ${pct(equity)} vs range < ${pct(potOdds)} odds but ${where}, threshold ${pct(continueThreshold)}${blk} [defense]`
        : `call: ${pct(equity)} vs range >= ${pct(continueThreshold)} needed (${where})${blk} [defense]`,
    };
  }
  return {
    ...base, action: 'fold',
    reasoning: `fold: ${pct(equity)} vs range < ${pct(continueThreshold)} needed (odds ${pct(potOdds)}, ${where})${blk} [defense]`,
  };
}

function valueOr(x: number, fallback: number): number { return Number.isFinite(x) ? x : fallback; }

/**
 * (share of villain value combos containing a hero card) - (share of villain
 * bluff combos containing a hero card), on the current board. "Value" = beats
 * hero now, "bluff" = loses to hero now. Uses villain's range with only the
 * board removed, i.e. before hero's cards are taken out.
 */
export function blockerScoreOf(heroCombo: [CardId, CardId], villainRange: WeightedRange, board: CardId[]): number {
  if (board.length < 3) return 0;
  const vil = normalizeRange(villainRange, board);
  const hr = evaluateHand([heroCombo[0], heroCombo[1], ...board]);
  let valueW = 0, valueBlocked = 0, bluffW = 0, bluffBlocked = 0;
  for (let i = 0; i < vil.combos.length; i++) {
    const [a, b] = vil.combos[i];
    const w = vil.weights[i];
    const blocked = a === heroCombo[0] || a === heroCombo[1] || b === heroCombo[0] || b === heroCombo[1];
    const vr = evaluateHand([a, b, ...board]);
    if (vr > hr) { valueW += w; if (blocked) valueBlocked += w; }
    else if (vr < hr) { bluffW += w; if (blocked) bluffBlocked += w; }
  }
  return (valueW > 0 ? valueBlocked / valueW : 0) - (bluffW > 0 ? bluffBlocked / bluffW : 0);
}

// ============================================================
// Fallback ranges (until the range tracker supplies real ones)
// ============================================================

/**
 * A balanced-aggressor fallback for villain's range when no tracked range is
 * available: the given VALUE combos (e.g. villainContinuingRange with
 * aggression:true) at weight 1, plus every other live combo as a potential
 * bluff, with the bluff block scaled to the share a balanced bettor uses at
 * this size:
 *
 *   river bluff share  = s / (1 + 2s)      (makes hero's bluff-catchers indifferent)
 *   turn               = 1.2 x river share (semibluffs still have equity)
 *   flop               = 1.4 x river share
 * all capped at BLUFF_SHARE_CAP.
 *
 * Inside the bluff block, combos are weighted by how likely a real player is to
 * choose them as a bluff (bluffPropensity): on the flop/turn draws dominate and
 * pure air is rare; on the river missed draws / no-pair hands bluff and hands
 * with showdown value mostly do not. Spreading the bluffs uniformly over all
 * non-value combos instead would hand hero's air far too much equity on the
 * flop (random hands are much weaker vs ace-high than real semibluffs are).
 *
 * This ASSUMES villain is balanced. It is a better default than the value-only
 * range (which assumes villain never bluffs and makes every bluff-catcher a
 * fold), but the range tracker's estimate should replace it.
 */
export function balancedAggressorRange(
  valueCombos: [CardId, CardId][],
  board: CardId[],
  street: PostflopStreet,
  sizeFrac: number,
): WeightedRange {
  const s = Math.max(0, sizeFrac);
  const riverShare = s / (1 + 2 * s);
  const mult = street === 'river' ? 1 : street === 'turn' ? 1.2 : 1.4;
  const bluffShare = Math.min(BLUFF_SHARE_CAP, riverShare * mult);
  const dead = new Set(board);
  const valueKeys = new Set<number>();
  const combos: [CardId, CardId][] = [];
  const weights: number[] = [];
  for (const [x, y] of valueCombos) {
    const a = Math.min(x, y), b = Math.max(x, y);
    if (a === b || dead.has(a) || dead.has(b) || valueKeys.has(a * 52 + b)) continue;
    valueKeys.add(a * 52 + b);
    combos.push([a, b]);
    weights.push(1);
  }
  const nValue = combos.length;
  const bluffs: [CardId, CardId][] = [];
  const prop: number[] = [];
  let propSum = 0;
  for (let a = 0; a < 52; a++) {
    if (dead.has(a)) continue;
    for (let b = a + 1; b < 52; b++) {
      if (dead.has(b) || valueKeys.has(a * 52 + b)) continue;
      const p = bluffPropensity([a, b], board, street);
      if (p <= 0) continue;
      bluffs.push([a, b]);
      prop.push(p);
      propSum += p;
    }
  }
  if (nValue === 0 || bluffs.length === 0) {
    return { combos: [...combos, ...bluffs], weights: [...weights, ...prop] };
  }
  // Total bluff weight B with B / (nValue + B) = bluffShare, split by propensity.
  const B = (bluffShare * nValue) / (1 - bluffShare);
  for (let i = 0; i < bluffs.length; i++) { combos.push(bluffs[i]); weights.push((B * prop[i]) / propSum); }
  return { combos, weights };
}

/** Upper bound on the bluff share of the fallback aggressor range. */
const BLUFF_SHARE_CAP = 0.45;

/**
 * Relative likelihood that a non-value combo is used as a bluff. Flop/turn:
 * combo draws 4, flush draws 3, open-enders 2.5, gutshots 1.5, two overcards 1,
 * weak made pairs 0.4, other air 0.25. River: no pair 1, one pair 0.15, better 0.05.
 */
export function bluffPropensity(combo: [CardId, CardId], board: CardId[], street: PostflopStreet): number {
  const cat = Math.floor(evaluateHand([combo[0], combo[1], ...board]) / 1_000_000);
  if (street === 'river') return cat === HAND_CATEGORY.HIGH_CARD ? 1 : cat === HAND_CATEGORY.PAIR ? 0.15 : 0.05;
  // Flush draw: four of a suit counting at least one hole card.
  const suit = [0, 0, 0, 0];
  for (const c of board) suit[c % 4]++;
  let fd = false;
  for (const h of combo) if (suit[h % 4] + (combo[0] % 4 === combo[1] % 4 ? 2 : 1) === 4) fd = true;
  // Straight draw: ranks that would complete a straight with the hole cards but
  // not with the board alone. Two or more such ranks ~ open-ender, one ~ gutshot.
  const outs = straightOuts([...board, ...combo]).filter(r => !straightOuts(board).includes(r)).length;
  const sd = outs >= 2 ? 2 : outs === 1 ? 1 : 0;
  const top = Math.max(...board.map(c => c >> 2));
  const overcards = (combo[0] >> 2) > top && (combo[1] >> 2) > top;
  if (fd && sd) return 4;
  if (fd) return 3;
  if (sd === 2) return 2.5;
  if (sd === 1) return 1.5;
  if (cat === HAND_CATEGORY.HIGH_CARD && overcards) return 1;
  if (cat === HAND_CATEGORY.PAIR) return 0.4;
  if (cat === HAND_CATEGORY.HIGH_CARD) return 0.25;
  return 0.1;
}

/** Ranks (0..12) that would give a five-card straight together with `cards`. Ace plays low too. */
function straightOuts(cards: CardId[]): number[] {
  const has = new Array(13).fill(false);
  for (const c of cards) has[c >> 2] = true;
  const present = (r: number) => (r === -1 ? has[12] : has[r]);
  const out: number[] = [];
  for (let r = 0; r < 13; r++) {
    if (has[r]) continue;
    // Windows low..low+4 containing r; low = -1 is the wheel (A-2-3-4-5).
    for (let low = Math.max(-1, r - 4); low <= Math.min(8, r); low++) {
      let ok = true;
      for (let k = low; k <= low + 4; k++) if (k !== r && !present(k)) { ok = false; break; }
      if (ok) { out.push(r); break; }
    }
  }
  return out;
}

/**
 * Build a WeightedRange over every live combo (board removed) from a per-combo
 * weight function, e.g. preflop frequency times the lead policy's bet
 * probability. `eqVsRandom` is each combo's equity vs a uniform random hand on
 * this board (runouts sampled like rangeEquities), for policies that need it.
 */
export function rangeFromPolicy(
  board: CardId[],
  weight: (combo: [CardId, CardId], heroCat: number, eqVsRandom: number) => number,
  opts: RangeEquityOptions = {},
): WeightedRange {
  const dead = new Set(board);
  const all: [CardId, CardId][] = [];
  for (let a = 0; a < 52; a++) {
    if (dead.has(a)) continue;
    for (let b = a + 1; b < 52; b++) if (!dead.has(b)) all.push([a, b]);
  }
  const uniform: WeightedRange = { combos: all, weights: all.map(() => 1) };
  const eqs = rangeEquities(all, uniform, board, { runouts: opts.runouts ?? 60, seed: opts.seed });
  const combos: [CardId, CardId][] = [];
  const weights: number[] = [];
  for (let i = 0; i < all.length; i++) {
    const cat = Math.floor(evaluateHand([all[i][0], all[i][1], ...board]) / 1_000_000);
    const w = weight(all[i], cat, valueOr(eqs[i], 0.5));
    if (w > 0) { combos.push(all[i]); weights.push(w); }
  }
  return { combos, weights };
}

/**
 * Hero's range for the line hero took this street, as the live lead policy
 * (cbet.ts leadBetProbability) actually plays it: every live combo weighted by
 * preflopWeight(combo) x P(bet | combo) for line 'bet' (default), or
 * x (1 - P(bet | combo)) for line 'check'. After hero bet and got raised this is
 * the range the raiser is attacking, so it is the right heroRange for
 * defendVsAggression until the range tracker supplies hero's range directly.
 * preflopWeight defaults to uniform (1). Dangerous-flush combos (monotone or
 * 4-flush board, combo holds no flush) get the policy's zero bet probability.
 */
export function leadPolicyRange(
  board: CardId[],
  street: PostflopStreet,
  ctx: { isAggressor: boolean; isIP: boolean; veryWetOrMono: boolean; line?: 'bet' | 'check' },
  preflopWeight: (combo: [CardId, CardId]) => number = () => 1,
  opts: RangeEquityOptions = {},
): WeightedRange {
  const suitCount = [0, 0, 0, 0];
  for (const c of board) suitCount[c % 4]++;
  const flushSuit = suitCount.findIndex(n => n >= 3);
  return rangeFromPolicy(board, (combo, heroCat, eq) => {
    const pw = preflopWeight(combo);
    if (!(pw > 0)) return 0;
    let dangerousFlush = false;
    if (flushSuit >= 0) {
      const held = (combo[0] % 4 === flushSuit ? 1 : 0) + (combo[1] % 4 === flushSuit ? 1 : 0);
      dangerousFlush = held < (suitCount[flushSuit] >= 4 ? 1 : 2);
    }
    const pBet = leadBetProbability({
      isAggressor: ctx.isAggressor, isIP: ctx.isIP, veryWetOrMono: ctx.veryWetOrMono,
      heroCat, equity: eq, street, dangerousFlush,
    });
    return pw * (ctx.line === 'check' ? 1 - pBet : pBet);
  }, opts);
}

// ============================================================
// Barrel gate: should hero keep betting into villain's narrowed range?
// ============================================================

export interface BarrelInput {
  heroCards: [CardId, CardId];
  board: CardId[];
  /** Villain's range narrowed by the hand so far (e.g. after calling flop and turn). */
  villainRange: WeightedRange;
  /** Hero's betting range, used to model villain's calls. Optional: uniform if absent. */
  heroRange?: WeightedRange | null;
  /** Pot before hero's bet. */
  pot: number;
  /** Hero's intended bet. */
  bet: number;
  street: PostflopStreet;
  /** The lead policy's bet probability (e.g. leadBetProbability). */
  baseProbability: number;
  runouts?: number;
}

export interface BarrelResult {
  /** Adjusted bet probability. */
  probability: number;
  /** Share of villain's range that folds (equity vs hero's range below villain's pot odds). */
  foldShare: number;
  /** Hero equity vs the part of villain's range that continues. */
  equityVsContinue: number;
  /** Hero equity vs villain's whole range. */
  equity: number;
  /** EV of betting and of checking, in chips (pot-relative model, see below). */
  evBet: number;
  evCheck: number;
  reasoning: string;
}

/** When betting is worse than checking, keep this share of the bet frequency (balance, not EV). */
const BARREL_KEEP_WHEN_NEGATIVE = 0.2;

/**
 * EV(bet) vs EV(check) against villain's narrowed range:
 *   villain continues with every combo whose equity vs hero's (betting) range is
 *   at least villain's price bet / (pot + 2 bet) — a pot-odds caller;
 *   EV(bet)   = fold * pot + (1 - fold) * (eqC * (pot + 2 bet) - bet)
 *   EV(check) = eq * pot      (realizing raw equity; generous to checking draws)
 * If betting is not worse, the lead policy's probability stands; otherwise it
 * is cut to BARREL_KEEP_WHEN_NEGATIVE of itself. A villain range that got
 * stronger by calling flop and turn shows up as a lower fold share and a lower
 * eqC, which is exactly the "barreling without accounting for villain's
 * strength" leak.
 */
export function barrelGate(input: BarrelInput): BarrelResult {
  const { heroCards, board, pot, bet } = input;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const vil = normalizeRange(input.villainRange, [...board, ...heroCards]);
  const heroCombo: [CardId, CardId] = [Math.min(...heroCards), Math.max(...heroCards)];
  if (vil.combos.length === 0 || bet <= 0) {
    return { probability: input.baseProbability, foldShare: 0, equityVsContinue: 0.5, equity: 0.5, evBet: 0, evCheck: 0, reasoning: 'barrel: no villain range, policy stands' };
  }
  const opts: RangeEquityOptions = { runouts: input.runouts ?? 80 };
  // Villain's view: each villain combo's equity vs hero's range.
  const heroRange = input.heroRange && input.heroRange.combos.length > 0 ? input.heroRange : uniformRange(board);
  const vEq = rangeEquities(vil.combos, heroRange, board, opts);
  const villainPrice = bet / (pot + 2 * bet);
  const cont: WeightedRange = { combos: [], weights: [] };
  let foldW = 0;
  for (let i = 0; i < vil.combos.length; i++) {
    if (valueOr(vEq[i], 0) >= villainPrice) { cont.combos.push(vil.combos[i]); cont.weights.push(vil.weights[i]); }
    else foldW += vil.weights[i];
  }
  const foldShare = foldW; // vil.weights sum to 1
  const equity = valueOr(rangeEquities([heroCombo], vil, board, opts)[0], 0.5);
  const equityVsContinue = cont.combos.length > 0 ? valueOr(rangeEquities([heroCombo], cont, board, opts)[0], 0.5) : 1;
  const evBet = foldShare * pot + (1 - foldShare) * (equityVsContinue * (pot + 2 * bet) - bet);
  const evCheck = equity * pot;
  const ok = evBet >= evCheck;
  const probability = ok ? input.baseProbability : input.baseProbability * BARREL_KEEP_WHEN_NEGATIVE;
  return {
    probability, foldShare, equityVsContinue, equity, evBet, evCheck,
    reasoning: `barrel ${ok ? 'ok' : 'cut'}: folds ${pct(foldShare)}, ${pct(equityVsContinue)} vs callers, EV bet ${evBet.toFixed(1)} vs check ${evCheck.toFixed(1)} [barrel-gate]`,
  };
}

function uniformRange(board: CardId[]): WeightedRange {
  const dead = new Set(board);
  const combos: [CardId, CardId][] = [];
  for (let a = 0; a < 52; a++) {
    if (dead.has(a)) continue;
    for (let b = a + 1; b < 52; b++) if (!dead.has(b)) combos.push([a, b]);
  }
  return { combos, weights: combos.map(() => 1) };
}

/** Hand category helper re-exported for callers building policies. */
export { HAND_CATEGORY };
