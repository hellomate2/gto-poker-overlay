import { CardId, GameState, Player, Position, Street, Action } from '../../types/poker';
import { cardToId, handGroupIndex, handGroupName } from '../cfr/card-utils';
import { evaluateHand, HAND_CATEGORY } from '../equity/hand-eval';
import { charts as greenlineCharts, Cell, Chart } from './greenline-gto';
import { charts as pekarstasCharts } from './pekarstas-gto';
import { charts as headsupSolvedCharts } from './headsup-solved';
import { preflopChartAction, PreflopScenario } from './preflop-charts';
import { PREFLOP_STRENGTH } from './preflop-strength';
import { WeightedRange, VillainRange, normalizeRange } from './weighted-range';

// ============================================================
// Preflop-conditioned villain range tracker.
//
// Replaces "the villain range is whatever the board allows" with a range that
// follows the hand's actual betting:
//
//   1. preflopRangeFor(): each player's preflop line (open / limp / call an
//      open / 3-bet / call a 3-bet / 4-bet / BB check / SB complete ...) is
//      turned into a weight per starting hand. Every preflop action multiplies
//      in P(action | hand) read from the solved charts already in the repo:
//        - heads-up (2 players dealt in): headsup-solved.ts (CFR+ solve, with its
//          mixed frequencies as weights). Cells the solve left degenerate
//          (33/33/33) fall back to the deterministic preflop-charts.ts action.
//        - 6-max (3+ dealt in): greenline-gto.ts and pekarstas-gto.ts, averaged
//          when both packs cover the spot.
//        - lines no chart covers (limps, cold 4-bets, 5-bets) use generic "top
//          X%" bands over a 169-hand preflop strength ranking
//          (preflop-strength.ts, generated from the solver's equity matrix).
//      Multiplying per-action likelihoods is Bayes' rule with a uniform prior
//      over the 1326 combos: P(hand | line) is proportional to
//      prod_i P(action_i | hand, context_i).
//
//   2. narrowRange(): each postflop action reweights every combo by a
//      likelihood P(action | combo, board, size). The likelihood model is
//      documented next to the code (see "Postflop likelihood model").
//
//   3. estimateVillainRanges(): for every villain still in the hand (not
//      folded on any street, not sitting out), preflop range, then each of
//      their postflop actions in order, then normalized against hero cards and
//      the board.
//
// Everything works on a dense Float64Array of 1326 combo weights internally and
// converts to the shared WeightedRange contract (weighted-range.ts) at the end.
// ============================================================

// ------------------------------------------------------------
// Combo tables (built once)
// ------------------------------------------------------------

const NUM_COMBOS = 1326;
/** COMBO_A[i] < COMBO_B[i]: the two cards of combo i. */
const COMBO_A = new Int8Array(NUM_COMBOS);
const COMBO_B = new Int8Array(NUM_COMBOS);
/** 169-class index (handGroupIndex) of combo i. */
const COMBO_CLASS = new Int16Array(NUM_COMBOS);
/** COMBO_INDEX[a * 52 + b] = combo index for a < b (and b < a), else -1. */
const COMBO_INDEX = new Int16Array(52 * 52).fill(-1);
/** Canonical name ('AKs', 'T9o', 'QQ') of each of the 169 classes. */
const CLASS_NAME: string[] = new Array(169);

(function buildComboTables() {
  let i = 0;
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      COMBO_A[i] = a;
      COMBO_B[i] = b;
      const cls = handGroupIndex(a, b);
      COMBO_CLASS[i] = cls;
      CLASS_NAME[cls] = handGroupName(a, b);
      COMBO_INDEX[a * 52 + b] = i;
      COMBO_INDEX[b * 52 + a] = i;
      i++;
    }
  }
})();

/** Combo index of two distinct cards. */
export function comboIndex(a: CardId, b: CardId): number {
  return COMBO_INDEX[a * 52 + b];
}

const CLASS_COMBOS = new Float64Array(169);
for (let i = 0; i < NUM_COMBOS; i++) CLASS_COMBOS[COMBO_CLASS[i]]++;

/**
 * Preflop strength percentile per class, combo-weighted: Q[c] is the fraction
 * of all 1326 combos that rank strictly below class c, plus half of c's own
 * combos (so AA ~ 0.998 and 32o ~ 0.005). "Top X%" bands are q > 1 - X.
 */
const CLASS_Q = new Float64Array(169);
(function buildStrengthPercentiles() {
  const order = [...Array(169).keys()].sort(
    (x, y) => (PREFLOP_STRENGTH[CLASS_NAME[x]] ?? 0) - (PREFLOP_STRENGTH[CLASS_NAME[y]] ?? 0),
  );
  let below = 0;
  for (const c of order) {
    CLASS_Q[c] = (below + CLASS_COMBOS[c] / 2) / NUM_COMBOS;
    below += CLASS_COMBOS[c];
  }
})();

// ------------------------------------------------------------
// Small math helpers
// ------------------------------------------------------------

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Smooth "is in the top `frac` of combos" indicator over preflop strength q. */
function topFrac(q: number, frac: number): number {
  // Logistic step centred at q = 1 - frac; width 0.015 (about 20 combos), so a
  // band edge is soft instead of a hard cliff between adjacent hands.
  return sigmoid((q - (1 - frac)) / 0.015);
}

/**
 * A calling band: hands inside the top `outer` fraction, with the very top
 * `inner` fraction (hands that would usually re-raise) kept only at
 * (1 - trimTop). This is how a flatting range looks: capped but not fully.
 */
function band(q: number, outer: number, inner: number, trimTop: number): number {
  return topFrac(q, outer) * (1 - trimTop * topFrac(q, inner));
}

// ------------------------------------------------------------
// Player / name helpers
// ------------------------------------------------------------

/**
 * Normalize a player name for matching log names to seat names. The PokerNow
 * scraper lowercases the whole log line and the log may carry an " @ id"
 * suffix, while seat names keep their display case. Exact match is tried first.
 */
function normName(n: string): string {
  return n.toLowerCase().replace(/\s*@.*$/, '').trim();
}

function sameName(a: string, b: string): boolean {
  return a === b || normName(a) === normName(b);
}

function playerByName(state: GameState, name: string): Player | undefined {
  return state.players.find(p => p.name === name) ?? state.players.find(p => sameName(p.name, name));
}

const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river'];

function hasFolded(state: GameState, p: Player): boolean {
  for (const st of STREETS) {
    for (const a of state.actionHistory?.[st] ?? []) {
      if (a.type === 'fold' && sameName(a.playerName, p.name)) return true;
    }
  }
  return false;
}

/** Players dealt into this hand (not sitting out), hero included. */
function dealtIn(state: GameState): Player[] {
  return state.players.filter(p => !p.isSittingOut);
}

/**
 * Indexes of villains still contesting the pot: not hero, not sitting out, and
 * not folded on ANY street of actionHistory. (engine.ts used to count every
 * seated player, so a heads-up flop at a 6-max table looked multiway.)
 */
export function liveVillainIndexes(state: GameState): number[] {
  const out: number[] = [];
  state.players.forEach((p, i) => {
    if (i === state.heroIndex || p.isHero || p.isSittingOut) return;
    if (hasFolded(state, p)) return;
    out.push(i);
  });
  return out;
}

// ------------------------------------------------------------
// Chart access
// ------------------------------------------------------------

type ChartAction = 'raise' | 'call';

/**
 * Frequency in [0, 1] with which a chart cell takes `action`. 'raise' includes
 * 'allin' (an all-in open or 3-bet is still that aggressive action). Weighted
 * cells: weight% of the time the hand plays at all, split by the action mix.
 */
function cellFreq(cell: Cell | undefined, action: ChartAction): number {
  if (cell === undefined) return 0;
  if (typeof cell === 'string') {
    if (action === 'raise') return cell === 'raise' || cell === 'allin' ? 1 : 0;
    return cell === 'call' ? 1 : 0;
  }
  if (Array.isArray(cell)) {
    let f = 0;
    for (const a of cell) {
      if (action === 'raise' ? a === 'raise' || a === 'allin' : a === 'call') f += 0.5;
    }
    return f;
  }
  const acts = cell.actions as Record<string, number | undefined>;
  const total = Object.values(acts).reduce<number>((s, v) => s + (v ?? 0), 0) || 100;
  const part = action === 'raise' ? (acts.raise ?? 0) + (acts.allin ?? 0) : acts.call ?? 0;
  return (cell.weight / 100) * (part / total);
}

/** 3+ near-equal actions = an unconverged solver cell (see gto-advisor.ts). */
function isNoisyCell(cell: Cell): boolean {
  if (typeof cell === 'string' || Array.isArray(cell)) return false;
  const freqs = Object.values(cell.actions as Record<string, number>).filter(f => f > 5);
  if (freqs.length < 3) return false;
  return Math.max(...freqs) - Math.min(...freqs) < 15;
}

function nonFoldCells(chart: Chart | undefined): number {
  if (!chart) return 0;
  let n = 0;
  for (const c of Object.values(chart)) if (c !== 'fold') n++;
  return n;
}

/** Heads-up chart keys -> preflop-charts.ts scenario, for noisy-cell fallback. */
const HU_SCENARIO: Record<string, PreflopScenario> = {
  'SB-RFI': 'RFI',
  'BB-vs-open-SB': 'vs-open',
  'SB-vs-3bet-BB': 'vs-3bet',
  'BB-vs-4bet-SB': 'vs-4bet',
};

/**
 * Per-class likelihood (169 entries) of `action` from the chart at `key`, or
 * null when no chart covers the key.
 *   HU: the solved chart's mixed frequency; degenerate cells use the
 *       deterministic preflop-charts.ts action (1 if it matches, else 0).
 *   6-max: the mean of greenline and pekarstas over every pack whose chart has
 *       at least half the non-fold cells of the fullest one (so a stub chart
 *       never dilutes a complete one).
 */
function chartLikelihood(key: string, action: ChartAction, headsUp: boolean): Float64Array | null {
  const out = new Float64Array(169);
  if (headsUp) {
    const chart = headsupSolvedCharts[key];
    if (!chart) return null;
    const scen = HU_SCENARIO[key];
    for (let c = 0; c < 169; c++) {
      const name = CLASS_NAME[c];
      const cell = chart[name];
      if (cell !== undefined && isNoisyCell(cell) && scen) {
        const det = preflopChartAction(name, scen).action;
        const agg = det === 'raise' || det === 'allin';
        out[c] = action === 'raise' ? (agg ? 1 : 0) : det === 'call' ? 1 : 0;
      } else {
        out[c] = cellFreq(cell, action);
      }
    }
    return out;
  }
  const packs = [greenlineCharts[key], pekarstasCharts[key]].filter(Boolean) as Chart[];
  if (!packs.length) return null;
  const best = Math.max(...packs.map(nonFoldCells));
  if (best === 0) return null;
  const used = packs.filter(p => nonFoldCells(p) * 2 >= best);
  for (let c = 0; c < 169; c++) {
    let s = 0;
    for (const p of used) s += cellFreq(p[CLASS_NAME[c]], action);
    out[c] = s / used.length;
  }
  return out;
}

// ------------------------------------------------------------
// Preflop line parsing
// ------------------------------------------------------------

/** 6-max position order (UTG first to act preflop). */
const POS_ORDER: Position[] = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];

/** Map 9-max labels onto the 6-max chart positions. */
function chartPos(pos: Position, headsUp: boolean): Position {
  if (headsUp) return pos === 'BB' ? 'BB' : 'SB'; // HU: the button IS the SB
  if (pos === 'UTG1') return 'UTG';
  if (pos === 'MP1') return 'MP';
  return pos;
}

/** One preflop action by the player we are building a range for, in context. */
interface PreflopStep {
  kind: 'raise' | 'call' | 'check';
  /** Raises (opens included) made before this action. 0 = unopened pot. */
  raisesBefore: number;
  /** Did anyone limp before the first raise? (ISO vs RFI) */
  limpedPot: boolean;
  /** Position of the first raiser and of the most recent raiser (chart pos). */
  openerPos: Position | null;
  lastRaiserPos: Position | null;
  /** This player's own earlier preflop steps this hand. */
  prior: PreflopStep[];
  /** True when the step was inferred (log gap) rather than read from the log. */
  inferred?: boolean;
}

/** Facts about the whole preflop betting used by both parsing and pot math. */
interface PreflopWalk {
  steps: Map<number, PreflopStep[]>; // player index -> steps
  finalRaises: number;
  lastRaiserIdx: number;
}

function walkPreflop(state: GameState, headsUp: boolean): PreflopWalk {
  const steps = new Map<number, PreflopStep[]>();
  const actions = state.actionHistory?.preflop ?? [];
  const bb = state.bigBlind || 1;
  let level = bb; // chips to match: the big blind before any raise
  let raises = 0;
  let limpers = 0;
  let openerPos: Position | null = null;
  let lastRaiserPos: Position | null = null;
  let lastRaiserIdx = -1;

  for (const a of actions) {
    const p = playerByName(state, a.playerName);
    if (!p) continue;
    const idx = state.players.indexOf(p);
    const pos = chartPos(p.position, headsUp);
    const mine = steps.get(idx) ?? [];
    const ctx = {
      raisesBefore: raises,
      limpedPot: limpers > 0,
      openerPos,
      lastRaiserPos,
      prior: mine.slice(),
    };
    const amt = a.amount ?? 0;
    // An all-in for no more than the current level is a call; a bet/raise/allin
    // above it (or with no amount logged) is a raise.
    const aggressive =
      a.type === 'raise' || a.type === 'bet' || (a.type === 'allin' && !(amt > 0 && amt <= level));
    if (aggressive) {
      mine.push({ kind: 'raise', ...ctx });
      raises++;
      if (raises === 1) openerPos = pos;
      lastRaiserPos = pos;
      lastRaiserIdx = idx;
      level = amt > level ? amt : level * 3;
    } else if (a.type === 'call' || a.type === 'allin') {
      mine.push({ kind: 'call', ...ctx });
      if (raises === 0 && pos !== 'BB') limpers++;
    } else if (a.type === 'check') {
      mine.push({ kind: 'check', ...ctx });
    } else {
      continue; // folds carry no range information for a live player
    }
    steps.set(idx, mine);
  }
  return { steps, finalRaises: raises, lastRaiserIdx };
}

/**
 * The player's preflop steps, with a log-gap repair: once the flop is out, a
 * live player whose last logged step is behind the final raise level must have
 * called it (PokerNow only shows recent log lines, so early actions can be
 * missing). A live player with no steps at all is inferred to have checked the
 * BB, limped, or called the final raise.
 */
function stepsFor(state: GameState, idx: number, walk: PreflopWalk, headsUp: boolean): PreflopStep[] {
  const logged = walk.steps.get(idx) ?? [];
  if ((state.communityCards?.length ?? 0) < 3) return logged;
  if (idx === walk.lastRaiserIdx) return logged;
  const p = state.players[idx];
  const last = logged[logged.length - 1];
  const levelReached = last ? last.raisesBefore + (last.kind === 'raise' ? 1 : 0) : 0;
  if (last && levelReached >= walk.finalRaises) return logged;
  if (walk.finalRaises === 0 && last) return logged;
  const lastRaiser = walk.lastRaiserIdx >= 0 ? state.players[walk.lastRaiserIdx] : undefined;
  const lrPos = lastRaiser ? chartPos(lastRaiser.position, headsUp) : null;
  const isBB = chartPos(p.position, headsUp) === 'BB';
  const kind: PreflopStep['kind'] = walk.finalRaises === 0 ? (isBB ? 'check' : 'call') : 'call';
  return [
    ...logged,
    {
      kind,
      raisesBefore: walk.finalRaises,
      limpedPot: false,
      // With a single raise the last raiser is the opener.
      openerPos: walk.finalRaises === 1 ? lrPos : null,
      lastRaiserPos: lrPos,
      prior: logged.slice(),
      inferred: true,
    },
  ];
}

/** Positions to try (nearest first) when a "pos-vs-open-X" chart is missing. */
function openerFallbacks(opener: Position): Position[] {
  const i = POS_ORDER.indexOf(opener);
  const out: Position[] = [opener];
  for (let d = 1; d < POS_ORDER.length; d++) {
    if (i - d >= 0) out.push(POS_ORDER[i - d]);
    if (i + d < POS_ORDER.length) out.push(POS_ORDER[i + d]);
  }
  return out;
}

/**
 * P(call) or P(3-bet) facing a single open, from the "pos-vs-open-X" chart.
 *
 * Several 6-max in-position charts (BTN/SB/CO vs an open) are 3-bet-or-fold:
 * they continue with ~15% of hands and flat almost none. Read literally, a
 * player who flats there would hold only the 2-3 hands the chart mixes, which
 * is wrong for the human opponents this models (people flat a lot in those
 * seats). So when the chart's flat share of its continuing range is under 40%
 * we keep the chart's CONTINUING range (raise + call frequency per hand) and
 * re-split it: the top 40% of that range (by preflop strength) 3-bets, the
 * rest 3-bets only 15% of the time and flats otherwise. Flats also get a small
 * extra band (25%) of the next-best hands the chart folds, since flatting
 * ranges are wider than 3-bet-or-fold ranges. Charts with a real flatting
 * range (BB/HU defence) are used as-is.
 */
function vsOpenLikelihood(key: string, action: ChartAction, headsUp: boolean): Float64Array | null {
  const raise = chartLikelihood(key, 'raise', headsUp);
  const call = chartLikelihood(key, 'call', headsUp);
  if (!raise || !call) return null;
  let callMass = 0;
  let contMass = 0;
  for (let c = 0; c < 169; c++) {
    callMass += CLASS_COMBOS[c] * call[c];
    contMass += CLASS_COMBOS[c] * Math.min(1, call[c] + raise[c]);
  }
  if (contMass <= 0) return null;
  if (callMass / contMass >= 0.4) return action === 'raise' ? raise : call;

  const contFrac = contMass / NUM_COMBOS;
  const out = new Float64Array(169);
  for (let c = 0; c < 169; c++) {
    const cont = Math.min(1, call[c] + raise[c]);
    const q = CLASS_Q[c];
    const threeBetShare = 0.15 + 0.85 * topFrac(q, 0.4 * contFrac);
    if (action === 'raise') out[c] = cont * threeBetShare;
    else out[c] = cont * (1 - threeBetShare) + 0.25 * (1 - cont) * topFrac(q, 1.6 * contFrac);
  }
  return out;
}

/** Generic likelihood over the 169 classes from a function of strength q. */
function generic(f: (q: number) => number): Float64Array {
  const out = new Float64Array(169);
  for (let c = 0; c < 169; c++) out[c] = f(CLASS_Q[c]);
  return out;
}

/** Human-readable label for a step, used by describePreflopLine. */
function stepLabel(s: PreflopStep, pos: Position): string {
  if (s.kind === 'check') return 'BB check';
  if (s.kind === 'call') {
    if (s.raisesBefore === 0) return pos === 'SB' ? 'SB complete' : 'limp';
    const iLimped = s.prior.some(p => p.kind === 'call' && p.raisesBefore === 0);
    if (s.raisesBefore === 1) return iLimped ? 'limp-call' : 'call open';
    if (s.raisesBefore === 2) return s.prior.some(p => p.kind === 'raise') ? 'call 3-bet' : 'cold-call 3-bet';
    if (s.raisesBefore === 3) return 'call 4-bet';
    return 'call 5-bet+';
  }
  if (s.raisesBefore === 0) return s.limpedPot ? 'iso-raise' : 'open';
  if (s.raisesBefore === 1) return s.prior.some(p => p.kind === 'call' && p.raisesBefore === 0) ? 'limp-raise' : '3-bet';
  if (s.raisesBefore === 2) return '4-bet';
  return '5-bet+';
}

/**
 * P(step | hand) for all 169 classes. Chart-backed where the repo has a chart
 * for the exact spot; generic preflop-strength bands otherwise. The band widths
 * are modelling choices (documented inline), not solver output.
 */
function stepLikelihood(s: PreflopStep, pos: Position, headsUp: boolean): Float64Array {
  const r = s.raisesBefore;
  const iRaised = s.prior.some(p => p.kind === 'raise');
  const iLimped = s.prior.some(p => p.kind === 'call' && p.raisesBefore === 0);

  if (s.kind === 'check') {
    // BB checking its option in a limped pot: everything except the hands that
    // raise a limp (BB-ISO), and those still check ~15% of the time (traps).
    const iso = chartLikelihood('BB-ISO', 'raise', false);
    if (iso) return iso.map(f => 1 - 0.85 * f);
    return generic(q => 1 - 0.85 * topFrac(q, 0.15));
  }

  if (s.kind === 'call') {
    if (r === 0) {
      // Limp / SB complete. No chart in the repo limps, so this is a generic
      // recreational limping band: most playable hands, premiums mostly raised
      // (kept at 30% for traps), the worst trash rarely limps. HU SBs play far
      // wider, so their band is wider.
      return headsUp
        ? generic(q => 0.05 + band(q, 0.85, 0.15, 0.6))
        : generic(q => 0.05 + band(q, 0.7, 0.06, 0.7));
    }
    if (r === 1) {
      if (iLimped) return generic(q => band(q, 0.45, 0.04, 0.5)); // limp-call a raise
      const opener = s.openerPos ?? s.lastRaiserPos;
      if (headsUp && pos === 'BB') {
        const l = vsOpenLikelihood('BB-vs-open-SB', 'call', true);
        if (l) return l;
      }
      if (!headsUp && opener) {
        for (const o of openerFallbacks(opener)) {
          if (o === pos) continue;
          const l = vsOpenLikelihood(`${pos}-vs-open-${o}`, 'call', false);
          if (l) return l;
        }
      }
      return generic(q => band(q, 0.25, 0.04, 0.7)); // generic flat of an open
    }
    if (r === 2) {
      if (iRaised && s.lastRaiserPos) {
        // The opener calling a 3-bet. Chart cells are conditional on reaching
        // the node, and the RFI likelihood from the open is already multiplied in.
        const key = headsUp ? 'SB-vs-3bet-BB' : `${pos}-vs-3bet-${s.lastRaiserPos}`;
        const l = chartLikelihood(key, 'call', headsUp);
        if (l) return l;
        return generic(q => band(q, 0.12, 0.025, 0.6));
      }
      return generic(q => band(q, 0.08, 0.02, 0.6)); // cold-call (or flat a squeeze)
    }
    if (r === 3) {
      if (iRaised && s.lastRaiserPos) {
        const key = headsUp ? 'BB-vs-4bet-SB' : `${pos}-vs-4bet-${s.lastRaiserPos}`;
        let l = chartLikelihood(key, 'call', headsUp);
        if (!l && pos === 'SB') l = chartLikelihood(`BB-vs-4bet-${s.lastRaiserPos}`, 'call', false);
        if (l) return l;
        return generic(q => band(q, 0.05, 0.015, 0.6));
      }
      return generic(q => band(q, 0.03, 0.012, 0.5));
    }
    return generic(q => topFrac(q, 0.02)); // calling a 5-bet+
  }

  // kind === 'raise'
  if (r === 0) {
    if (s.limpedPot) {
      const l = chartLikelihood(`${headsUp ? 'BB' : pos}-ISO`, 'raise', false);
      if (l) return l;
      return generic(q => topFrac(q, 0.15));
    }
    const l = chartLikelihood(`${pos}-RFI`, 'raise', headsUp);
    if (l) return l;
    return generic(q => topFrac(q, 0.2));
  }
  if (r === 1) {
    if (iLimped) return generic(q => topFrac(q, 0.05)); // limp-raise is strong
    const opener = s.openerPos ?? s.lastRaiserPos;
    if (headsUp && pos === 'BB') {
      const l = vsOpenLikelihood('BB-vs-open-SB', 'raise', true);
      if (l) return l;
    }
    if (!headsUp && opener) {
      for (const o of openerFallbacks(opener)) {
        if (o === pos) continue;
        const l = vsOpenLikelihood(`${pos}-vs-open-${o}`, 'raise', false);
        if (l) return l;
      }
    }
    return generic(q => topFrac(q, 0.06));
  }
  if (r === 2) {
    if (iRaised && s.lastRaiserPos) {
      const key = headsUp ? 'SB-vs-3bet-BB' : `${pos}-vs-3bet-${s.lastRaiserPos}`;
      const l = chartLikelihood(key, 'raise', headsUp);
      if (l) return l;
    }
    return generic(q => topFrac(q, iRaised ? 0.03 : 0.025)); // 4-bet / cold 4-bet
  }
  if (r === 3 && iRaised && s.lastRaiserPos) {
    const key = headsUp ? 'BB-vs-4bet-SB' : `${pos}-vs-4bet-${s.lastRaiserPos}`;
    let l = chartLikelihood(key, 'raise', headsUp);
    if (!l && pos === 'SB') l = chartLikelihood(`BB-vs-4bet-${s.lastRaiserPos}`, 'raise', false);
    if (l) return l;
  }
  return generic(q => topFrac(q, 0.015)); // 5-bet+ jams
}

function isHeadsUpTable(state: GameState): boolean {
  return dealtIn(state).length === 2;
}

/**
 * 169-class preflop weights for a player: product of the likelihoods of every
 * preflop step they took. A player with no recorded line and no inferable one
 * (preflop, not yet acted) gets a flat range.
 */
function preflopClassWeights(state: GameState, playerIndex: number): { w: Float64Array; line: string } {
  const headsUp = isHeadsUpTable(state);
  const walk = walkPreflop(state, headsUp);
  const p = state.players[playerIndex];
  const pos = chartPos(p.position, headsUp);
  const steps = stepsFor(state, playerIndex, walk, headsUp);
  const w = new Float64Array(169).fill(1);
  const labels: string[] = [];
  for (const s of steps) {
    const l = stepLikelihood(s, pos, headsUp);
    for (let c = 0; c < 169; c++) w[c] *= l[c];
    labels.push(stepLabel(s, pos) + (s.inferred ? ' (inferred)' : ''));
  }
  // A line no hand plays (cannot happen with the generic floors, but guard):
  // fall back to a flat range rather than an empty one.
  let total = 0;
  for (let c = 0; c < 169; c++) total += w[c] * CLASS_COMBOS[c];
  if (!(total > 0)) w.fill(1);
  return { w, line: `${pos}${headsUp ? ' (HU)' : ''}: ${labels.length ? labels.join(', ') : 'no action'}` };
}

/** Expand class weights to a dense 1326 combo weight vector. */
function expandClasses(w: Float64Array): Float64Array {
  const out = new Float64Array(NUM_COMBOS);
  for (let i = 0; i < NUM_COMBOS; i++) out[i] = w[COMBO_CLASS[i]];
  return out;
}

function toWeightedRange(dense: Float64Array, dead: Iterable<CardId>): WeightedRange {
  const combos: [CardId, CardId][] = [];
  const weights: number[] = [];
  for (let i = 0; i < NUM_COMBOS; i++) {
    if (dense[i] > 0) {
      combos.push([COMBO_A[i], COMBO_B[i]]);
      weights.push(dense[i]);
    }
  }
  return normalizeRange({ combos, weights }, dead);
}

function fromWeightedRange(range: WeightedRange): Float64Array {
  const dense = new Float64Array(NUM_COMBOS);
  for (let i = 0; i < range.combos.length; i++) {
    const [a, b] = range.combos[i];
    if (a === b) continue;
    const idx = COMBO_INDEX[a * 52 + b];
    if (idx >= 0) dense[idx] += range.weights[i];
  }
  return dense;
}

/**
 * The range a player's preflop line represents, as a WeightedRange over all
 * combos (no card removal applied; weights sum to 1).
 */
export function preflopRangeFor(state: GameState, playerIndex: number): WeightedRange {
  const { w } = preflopClassWeights(state, playerIndex);
  return toWeightedRange(expandClasses(w), []);
}

/** Short description of the parsed preflop line, e.g. "CO: open, call 3-bet". */
export function describePreflopLine(state: GameState, playerIndex: number): string {
  return preflopClassWeights(state, playerIndex).line;
}

// ------------------------------------------------------------
// Board features: made-hand strength and draw strength per combo
// ------------------------------------------------------------

interface BoardFeatures {
  /** evaluateHand value per combo; -1 when the combo collides with the board. */
  value: Float64Array;
  /** Percentile of the combo's made hand among all live combos (0..1). */
  sAbs: Float64Array;
  /** Normalized draw strength 0..1 (0 on the river and for made straights+). */
  draw: Float64Array;
  /** Live combo indexes sorted by value ascending (for range-relative strength). */
  sorted: Int16Array;
}

const featureCache = new Map<string, BoardFeatures>();
const FEATURE_CACHE_MAX = 16;

/** Does a 14-bit rank mask (bit 0 = ace-low, bit r+1 = rank r) hold 5 in a row? */
function hasStraight(mask: number): boolean {
  for (let lo = 0; lo <= 9; lo++) {
    if (((mask >> lo) & 0x1f) === 0x1f) return true;
  }
  return false;
}

function rankBit(r: number): number {
  // Ace (12) sets both its own bit and the ace-low bit.
  return r === 12 ? (1 << 13) | 1 : 1 << (r + 1);
}

function boardFeatures(board: CardId[]): BoardFeatures {
  const key = board.join(',');
  const hit = featureCache.get(key);
  if (hit) return hit;

  const value = new Float64Array(NUM_COMBOS).fill(-1);
  const draw = new Float64Array(NUM_COMBOS);
  const boardSet = new Set(board);
  const cards: CardId[] = [0, 0, ...board];

  // Board-only facts for the draw detector.
  const boardSuit = [0, 0, 0, 0];
  let boardMask = 0;
  for (const c of board) {
    boardSuit[c % 4]++;
    boardMask |= rankBit((c / 4) | 0);
  }
  const street = board.length === 3 ? 'flop' : board.length === 4 ? 'turn' : 'river';

  const live: number[] = [];
  for (let i = 0; i < NUM_COMBOS; i++) {
    const a = COMBO_A[i];
    const b = COMBO_B[i];
    if (boardSet.has(a) || boardSet.has(b)) continue;
    cards[0] = a;
    cards[1] = b;
    const v = evaluateHand(cards);
    value[i] = v;
    live.push(i);

    if (street === 'river') continue;
    const cat = Math.floor(v / 1_000_000);
    if (cat >= HAND_CATEGORY.STRAIGHT) continue; // already made: no draw term
    // ---- Draw outs (a standard "outs" count, then normalized) ----
    // Flush draw: 4 to a suit using at least one hole card -> 9 outs.
    // Backdoor flush on the flop (two suited hole cards + one on board) ~1.5 outs.
    let outs = 0;
    let fd = false;
    for (let s = 0; s < 4; s++) {
      const hole = (a % 4 === s ? 1 : 0) + (b % 4 === s ? 1 : 0);
      if (hole === 0) continue;
      const tot = boardSuit[s] + hole;
      if (tot === 4) fd = true;
      else if (tot === 3 && hole === 2 && street === 'flop') outs += 1.5;
    }
    if (fd) outs += 9;
    // Straight draw: count ranks x whose arrival completes a straight that the
    // board plus x alone would not (so the hole cards are part of it).
    // 2+ such ranks = open-ender / double gutter (8 outs), 1 = gutshot (4).
    const mask = boardMask | rankBit((a / 4) | 0) | rankBit((b / 4) | 0);
    if (!hasStraight(mask)) {
      let n = 0;
      for (let x = 0; x < 13; x++) {
        const bit = rankBit(x);
        if (hasStraight(mask | bit) && !hasStraight(boardMask | bit)) n++;
      }
      const so = n >= 2 ? 8 : n === 1 ? 4 : 0;
      // Overlap: two of the straight outs are usually flush cards too.
      outs += fd && so > 0 ? so - 2 : so;
    }
    // 12 outs (flush draw + gutter) saturates at 1. The turn has one card to
    // come, so the same outs are worth less: scale by 0.8.
    draw[i] = Math.min(1, outs / 12) * (street === 'turn' ? 0.8 : 1);
  }

  // Made-hand percentile among live combos (ties count half).
  live.sort((x, y) => value[x] - value[y]);
  const sAbs = new Float64Array(NUM_COMBOS);
  const n = live.length;
  for (let k = 0; k < n; ) {
    let j = k;
    while (j < n && value[live[j]] === value[live[k]]) j++;
    const pct = (k + (j - k) / 2) / n;
    for (let t = k; t < j; t++) sAbs[live[t]] = pct;
    k = j;
  }

  const feats: BoardFeatures = { value, sAbs, draw, sorted: Int16Array.from(live) };
  if (featureCache.size >= FEATURE_CACHE_MAX) {
    const first = featureCache.keys().next().value;
    if (first !== undefined) featureCache.delete(first);
  }
  featureCache.set(key, feats);
  return feats;
}

/**
 * Effective strength per combo: half absolute made-hand percentile, half the
 * percentile WITHIN the current weighted range. Players bet the top of their
 * own range, so a tight preflop range (all overpairs) does not bet all of its
 * combos just because each is strong in absolute terms; the absolute half keeps
 * a weak range from treating its best junk as the nuts.
 */
function effectiveStrength(dense: Float64Array, f: BoardFeatures): Float64Array {
  const s = new Float64Array(NUM_COMBOS);
  let total = 0;
  for (let k = 0; k < f.sorted.length; k++) total += dense[f.sorted[k]];
  const sorted = f.sorted;
  let below = 0;
  for (let k = 0; k < sorted.length; ) {
    let j = k;
    let tie = 0;
    const v = f.value[sorted[k]];
    while (j < sorted.length && f.value[sorted[j]] === v) {
      tie += dense[sorted[j]];
      j++;
    }
    const rel = total > 0 ? (below + tie / 2) / total : 0.5;
    for (let t = k; t < j; t++) {
      const i = sorted[t];
      s[i] = 0.5 * f.sAbs[i] + 0.5 * rel;
    }
    below += tie;
    k = j;
  }
  return s;
}

// ------------------------------------------------------------
// Postflop likelihood model
// ------------------------------------------------------------
//
// narrowRange multiplies each combo's weight by L(action | combo). Inputs per
// combo: s = effective strength (0..1, see effectiveStrength) and d = draw
// strength (0..1; 0 on the river). Size f = the bet as a fraction of the pot it
// went into (for a raise: the raise increment over the pot after calling).
//
//   EPS = 0.03 floor on every likelihood: no combo is ever fully excluded, so a
//   misread or an unbalanced human line cannot zero out the hand they hold.
//
//   BET (size f):
//     value(s)  = sigmoid((s - tV) / 0.04),  tV = 0.50 + 0.12 * min(f, 2) + off
//                 (bigger bets need stronger hands: 1/3 pot ~0.54, pot ~0.62;
//                 off = 0 flop, 0.05 turn, 0.10 river, because the hands that
//                 call a later-street bet are stronger, so second pair stops
//                 being a value bet by the river)
//     semi(d)   = 0.8 * d                    (draws bet as semi-bluffs)
//     shape(s)  = 1 - sigmoid((s - 0.35) / 0.05)   (the "air" region)
//     L = EPS + value + (1 - value) * min(1, semi + beta * shape)
//     beta is solved per call so the bluff mass (draws + air) over the value
//     mass equals the pot-odds ratio a bettor needs to make calls indifferent,
//     f / (1 + f) (i.e. bluffs are f / (1 + 2f) of the betting range), times a
//     street multiplier (flop 1.6, turn 1.3, river 1.0: earlier-street bluffs
//     have equity, so ranges carry more of them). beta is clamped to [0, 1].
//
//   RAISE (size f): as BET with tR = 0.72 + 0.08 * min(f, 2) + off / 2, width 0.035,
//     semi = 0.6 * d, and half the bet bluff ratio (raises are value-heavier).
//
//   CALL (facing size f):
//     cont(s) = sigmoid((s - tC) / 0.05),  tC = 0.30 + 0.12 * min(f, 2)
//     trim(s) = 1 - 0.45 * sigmoid((s - 0.93) / 0.02)  (the nuts often raise)
//     L = EPS + max(cont * trim, 0.9 * d)
//     Medium hands and draws survive; the very top is trimmed partially; air
//     falls to EPS.
//
//   CHECK:
//     strong(s) = sigmoid((s - 0.80) / 0.04)
//     L = max(EPS, 1 - k * strong - 0.35 * d - 0.15 * shape(s)),
//     k = 0.55 flop, 0.65 turn, 0.75 river (slow-playing gets rarer by street).
//     A check caps the range: strong hands are down-weighted, not removed.
// ------------------------------------------------------------

export type PostflopActionKind = 'bet' | 'raise' | 'call' | 'check';

const EPS = 0.03;
const STREET_BLUFF_MULT: Record<Street, number> = { preflop: 1, flop: 1.6, turn: 1.3, river: 1 };
const CHECK_STRONG_K: Record<Street, number> = { preflop: 0.5, flop: 0.55, turn: 0.65, river: 0.75 };
/** Value-threshold offset by street: later streets need a stronger hand to bet for value. */
const VALUE_STREET_OFFSET: Record<Street, number> = { preflop: 0, flop: 0, turn: 0.05, river: 0.1 };

const airShape = (s: number): number => 1 - sigmoid((s - 0.35) / 0.05);

function narrowDense(
  dense: Float64Array,
  board: CardId[],
  action: PostflopActionKind,
  sizeFracOfPot: number,
  street: Street,
): Float64Array {
  if (board.length < 3) return dense;
  const f = boardFeatures(board);
  const s = effectiveStrength(dense, f);
  const size = clamp(Number.isFinite(sizeFracOfPot) ? sizeFracOfPot : 0.66, 0.05, 3);
  const out = new Float64Array(NUM_COMBOS);
  const d = street === 'river' ? null : f.draw;
  const live = f.sorted;

  if (action === 'check') {
    const k = CHECK_STRONG_K[street];
    for (let t = 0; t < live.length; t++) {
      const i = live[t];
      if (!(dense[i] > 0)) continue;
      const strong = sigmoid((s[i] - 0.8) / 0.04);
      const di = d ? d[i] : 0;
      const L = Math.max(EPS, 1 - k * strong - 0.35 * di - 0.15 * airShape(s[i]));
      out[i] = dense[i] * L;
    }
    return out;
  }

  if (action === 'call') {
    const tC = 0.3 + 0.12 * Math.min(size, 2);
    for (let t = 0; t < live.length; t++) {
      const i = live[t];
      if (!(dense[i] > 0)) continue;
      const cont = sigmoid((s[i] - tC) / 0.05);
      const trim = 1 - 0.45 * sigmoid((s[i] - 0.93) / 0.02);
      const di = d ? d[i] : 0;
      out[i] = dense[i] * (EPS + Math.max(cont * trim, 0.9 * di));
    }
    return out;
  }

  // bet / raise: value + semi-bluff draws + air bluffs calibrated to the size.
  const isRaise = action === 'raise';
  const tV =
    (isRaise ? 0.72 + 0.08 * Math.min(size, 2) : 0.5 + 0.12 * Math.min(size, 2)) +
    VALUE_STREET_OFFSET[street] * (isRaise ? 0.5 : 1);
  const width = isRaise ? 0.035 : 0.04;
  const semiK = isRaise ? 0.6 : 0.8;
  const ratio = (size / (1 + size)) * STREET_BLUFF_MULT[street] * (isRaise ? 0.5 : 1);

  const val = new Float64Array(NUM_COMBOS);
  let V = 0; // value mass
  let D = 0; // draw (semi-bluff) mass
  let A = 0; // air mass available to bluff with
  for (let t = 0; t < live.length; t++) {
    const i = live[t];
    const w = dense[i];
    if (!(w > 0)) continue;
    const v = sigmoid((s[i] - tV) / width);
    val[i] = v;
    const semi = d ? semiK * d[i] : 0;
    V += w * v;
    D += w * (1 - v) * Math.min(1, semi);
    A += w * (1 - v) * airShape(s[i]);
  }
  const needed = Math.max(0, ratio * V - D);
  const beta = A > 0 ? clamp(needed / A, 0, 1) : 0;
  for (let t = 0; t < live.length; t++) {
    const i = live[t];
    const w = dense[i];
    if (!(w > 0)) continue;
    const v = val[i];
    const semi = d ? semiK * d[i] : 0;
    out[i] = w * (EPS + v + (1 - v) * Math.min(1, semi + beta * airShape(s[i])));
  }
  return out;
}

/**
 * Reweight a range by one postflop action on `board`. Returns a new range
 * (weights normalized to 1, board-blocked combos dropped). `sizeFracOfPot` is
 * the bet faced/made as a fraction of the pot before it (ignored for checks).
 */
export function narrowRange(
  range: WeightedRange,
  board: CardId[],
  action: PostflopActionKind,
  sizeFracOfPot: number,
  street: Street,
): WeightedRange {
  const dense = fromWeightedRange(range);
  return toWeightedRange(narrowDense(dense, board, action, sizeFracOfPot, street), board);
}

// ------------------------------------------------------------
// Postflop action extraction (with pot reconstruction for sizing)
// ------------------------------------------------------------

export interface PostflopStep {
  street: Street;
  playerIndex: number;
  kind: PostflopActionKind;
  /** Bet as a fraction of the pot it went into (raise: increment / pot after call). */
  sizeFracOfPot: number;
}

/**
 * Walk the hand and classify every postflop action by context (the sim logs
 * postflop bets as 'raise', the scraper as 'bet'; what matters is whether a bet
 * was already in front). Pot sizes are rebuilt from the log: blinds, then each
 * player's per-street commitment ('raise'/'bet' amounts are the street total
 * raised TO; a call matches the current level). Missing amounts fall back to a
 * 0.6-pot bet or a 3x raise.
 */
export function postflopSteps(state: GameState): PostflopStep[] {
  const headsUp = isHeadsUpTable(state);
  const bb = state.bigBlind || 1;
  const sb = state.smallBlind || bb / 2;
  const out: PostflopStep[] = [];

  // ---- preflop pot ----
  const contrib = new Map<number, number>();
  state.players.forEach((p, i) => {
    if (p.isSittingOut) return;
    const pos = chartPos(p.position, headsUp);
    if (pos === 'BB') contrib.set(i, bb);
    else if (pos === 'SB') contrib.set(i, sb);
  });
  let level = bb;
  for (const a of state.actionHistory?.preflop ?? []) {
    const p = playerByName(state, a.playerName);
    if (!p) continue;
    const i = state.players.indexOf(p);
    const amt = a.amount ?? 0;
    const agg = a.type === 'raise' || a.type === 'bet' || (a.type === 'allin' && !(amt > 0 && amt <= level));
    if (agg) {
      level = amt > level ? amt : level * 3;
      contrib.set(i, level);
    } else if (a.type === 'call' || a.type === 'allin') {
      contrib.set(i, Math.max(contrib.get(i) ?? 0, level));
    }
  }
  let pot = 0;
  for (const v of contrib.values()) pot += v;
  if (!(pot > 0)) pot = bb * 2.5;

  // ---- postflop streets ----
  for (const street of ['flop', 'turn', 'river'] as Street[]) {
    const acts: Action[] = state.actionHistory?.[street] ?? [];
    const c = new Map<number, number>();
    let lvl = 0;
    for (const a of acts) {
      const p = playerByName(state, a.playerName);
      if (!p) continue;
      const i = state.players.indexOf(p);
      const prev = c.get(i) ?? 0;
      const amt = a.amount ?? 0;
      const agg = a.type === 'raise' || a.type === 'bet' || (a.type === 'allin' && !(amt > 0 && amt <= lvl));
      if (agg) {
        const to = amt > lvl ? amt : lvl > 0 ? lvl * 3 : Math.max(bb, 0.6 * pot);
        if (lvl === 0) {
          out.push({ street, playerIndex: i, kind: 'bet', sizeFracOfPot: (to - prev) / pot });
        } else {
          const potAfterCall = pot + (lvl - prev);
          out.push({ street, playerIndex: i, kind: 'raise', sizeFracOfPot: (to - lvl) / potAfterCall });
        }
        pot += to - prev;
        c.set(i, to);
        lvl = to;
      } else if (a.type === 'call' || a.type === 'allin') {
        const toCall = Math.max(0, lvl - prev);
        const before = pot - toCall > 0 ? pot - toCall : pot; // pot the bet went into (approx.)
        out.push({ street, playerIndex: i, kind: 'call', sizeFracOfPot: lvl > 0 ? toCall / before : 0 });
        pot += toCall;
        c.set(i, lvl);
      } else if (a.type === 'check') {
        out.push({ street, playerIndex: i, kind: 'check', sizeFracOfPot: 0 });
      }
    }
  }
  return out;
}

function boardIds(state: GameState): CardId[] {
  return (state.communityCards ?? []).map(cardToId);
}

const BOARD_LEN: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };

/** Dense combo weights for a player's full line: preflop range, then narrowing. */
function lineDense(state: GameState, playerIndex: number, steps: PostflopStep[], board: CardId[]): Float64Array {
  let dense = expandClasses(preflopClassWeights(state, playerIndex).w);
  for (const st of steps) {
    if (st.playerIndex !== playerIndex) continue;
    const n = BOARD_LEN[st.street];
    if (board.length < n) continue; // board not visible for that street
    dense = narrowDense(dense, board.slice(0, n), st.kind, st.sizeFracOfPot, st.street);
  }
  return dense;
}

/**
 * Ranges for every live villain: preflop line, narrowed by each of their
 * postflop actions in order, normalized against hero cards + board.
 */
export function estimateVillainRanges(state: GameState, heroCards: [CardId, CardId]): VillainRange[] {
  const board = boardIds(state);
  const dead = [...heroCards, ...board];
  const steps = postflopSteps(state);
  return liveVillainIndexes(state).map(playerIndex => ({
    playerIndex,
    range: toWeightedRange(lineDense(state, playerIndex, steps, board), dead),
  }));
}

/**
 * Hero's range as the villains perceive it (hero's own line run through the
 * same model), normalized against the board only. The subgame solver needs it
 * for the hero side of a range-vs-range solve.
 */
export function heroRangeFor(state: GameState): WeightedRange {
  const board = boardIds(state);
  const steps = postflopSteps(state);
  return toWeightedRange(lineDense(state, state.heroIndex, steps, board), board);
}

/**
 * Deterministic systematic resample of a weighted range into `n` unweighted
 * combos (repeats allowed), for consumers that take a plain combo list such as
 * equity/range-equity.ts equityVsRange. Point k sits at cumulative weight
 * (k + 0.5) / n, so a combo with weight w appears about w * n times and the
 * empirical distribution matches the weights to within 1/n per combo. No RNG:
 * the same range always yields the same list.
 */
export function sampleRangeCombos(range: WeightedRange, n: number): [CardId, CardId][] {
  const out: [CardId, CardId][] = [];
  const total = range.weights.reduce((s, w) => s + (w > 0 ? w : 0), 0);
  if (!(total > 0) || n <= 0) return out;
  let cum = 0;
  let k = 0;
  for (let i = 0; i < range.combos.length && k < n; i++) {
    const w = range.weights[i];
    if (!(w > 0)) continue;
    cum += w / total;
    while (k < n && (k + 0.5) / n <= cum) {
      out.push(range.combos[i]);
      k++;
    }
  }
  // Floating-point shortfall on the last point: pad with the final combo.
  while (k < n && range.combos.length) {
    out.push(range.combos[range.combos.length - 1]);
    k++;
  }
  return out;
}
