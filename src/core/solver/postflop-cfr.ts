// ============================================================
// Depth-Limited Postflop CFR Subgame Solver (pure TypeScript).
// ------------------------------------------------------------
// A genuine counterfactual-regret-minimization solve of the CURRENT postflop
// street, modelled as a two-player extensive-form subgame: hero's weighted range
// vs villain's weighted range on the actual board, given the live pot, the
// effective stack and any bet hero is facing. It is "depth-limited" in the
// Pluribus / Brown-Sandholm sense (Brown, Sandholm & Amos 2018, "Depth-Limited
// Solving for Imperfect-Information Games"; Brown & Sandholm 2019, Pluribus): the
// betting tree is built for the current street only, and every leaf where the
// street's betting resolves is valued exactly from the perfect-hash evaluator:
//   - a leaf where someone folds  => the other player wins the pot,
//   - a leaf where chips are matched => an equity-weighted showdown of the two
//     hands over the remaining runout (exact on the river and turn, exact or
//     deterministically sub-sampled on the flop).
//
// Algorithm: range-vs-range (vectorized) CFR. Every player's information set is
// (betting line, own hand), so each hand in each range gets its own regrets.
// Each iteration traverses the public tree once per player (alternating
// updates), carrying the OPPONENT's reach as a vector over the opponent's
// range; the traverser's counterfactual values come back as a vector over its
// own range. Regrets and average strategies use Discounted CFR (Brown &
// Sandholm 2019, "Solving Imperfect-Information Games via Discounted Regret
// Minimization") with alpha = 1.5, beta = 0.5, gamma = 2.
//
// Range weights enter as CHANCE reach at the root: the probability that hero
// holds combo i and villain holds combo j is proportional to
//   w_hero[i] * w_villain[j] * compatible(i, j)
// where compatible() is 0 when the two combos share a card. Card-conflicting
// pairs are therefore excluded, not counted as ties.
//
// A best-response pass over each player's average strategy gives the
// exploitability of the current solution within the abstraction (NashConv / 2,
// reported as a percentage of the pot), which is what tells us whether a
// time-boxed solve actually converged.
//
// Runs on the MAIN thread under a HARD time/iteration budget so it can never
// hang the UI; callers fall back to a heuristic on timeout/error.
// ============================================================

import { CardId, StrategyDistribution } from '../../types/poker';
import { evaluateHand } from '../equity/hand-eval';
import { SeededRng } from '../../solver/rng';

// ------------------------------------------------------------
// Public types
// ------------------------------------------------------------

/** A weighted hand in a range: two hole-card ids plus a relative weight. */
export interface RangeHand {
  cards: [CardId, CardId];
  weight: number;
}

/**
 * Action abstraction for one street. All sizes are pot-relative and are turned
 * into chip amounts at each node from the pot at that node.
 */
export interface BetAbstraction {
  /** Opening bet sizes as fractions of the pot (e.g. 0.33, 0.75, 1.25). */
  betFractions: number[];
  /** Raise sizes: after matching the bet, add this fraction of the pot that
   *  would exist after the call (1.0 == a "pot-sized" raise). */
  raiseFractions: number[];
  /** Total bets + raises allowed on this street, INCLUDING any bet hero is
   *  already facing at the root. 3 == bet, raise, re-raise. The last allowed
   *  level offers all-in only. */
  maxAggressions: number;
  /** Offer all-in only when (stack behind after calling) / (pot after calling)
   *  is at most this. All-in is also offered when no other size is legal. */
  allInMaxSpr: number;
  /** A size that would commit at least this fraction of the remaining stack is
   *  replaced by all-in (avoids near-all-in bets that leave a sliver behind). */
  allInThreshold: number;
}

/** Defaults by board size. River: three bet sizes, one raise, all-in up to
 *  SPR 4 (the river leaf is an exact showdown, so overbet shoves are sound).
 *  Turn: same sizes, all-in only at SPR <= 2.5 (a single-street equity leaf
 *  over-realizes deep shoves with a card to come). Flop: two bet sizes to keep
 *  the tree small; the flop leaf is the least accurate, see docs. */
export function defaultAbstraction(boardSize: number): BetAbstraction {
  if (boardSize >= 5) {
    return { betFractions: [0.33, 0.75, 1.25], raiseFractions: [0.7], maxAggressions: 3, allInMaxSpr: 4, allInThreshold: 0.8 };
  }
  if (boardSize === 4) {
    return { betFractions: [0.33, 0.75, 1.25], raiseFractions: [0.7], maxAggressions: 3, allInMaxSpr: 2.5, allInThreshold: 0.8 };
  }
  return { betFractions: [0.33, 0.75], raiseFractions: [0.7], maxAggressions: 3, allInMaxSpr: 2.5, allInThreshold: 0.8 };
}

/** One action available at a decision node. */
export interface TreeAction {
  kind: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';
  /** Chips the acting player adds to the pot with this action (0 for fold and
   *  check). For bet/raise/allin this is the increment from what the actor had
   *  already committed in this subgame, i.e. call amount + raise increment. */
  chips: number;
  /** Total chips the actor has committed in this subgame after the action. */
  totalCommitted: number;
  /** For bet/raise/allin: chips added divided by the pot before the action. */
  potFraction: number;
  /** Compact label, e.g. 'X', 'F', 'C', 'B33', 'R70', 'A'. */
  label: string;
}

// ------------------------------------------------------------
// Betting tree
// ------------------------------------------------------------

/** 0 = hero, 1 = villain. */
export type SubgamePlayer = 0 | 1;

export interface GameNode {
  kind: 'decision' | 'fold' | 'showdown';
  /** Acting player (decision nodes) or the folder (fold leaves). */
  player: SubgamePlayer;
  actions: TreeAction[];
  children: GameNode[];
  /** Betting line from the root, e.g. 'X/B75/C'. */
  line: string;
  /** Pot at this node: starting pot + both players' subgame commitments. */
  pot: number;
  /** Chips each player has committed in this subgame so far. */
  committed: [number, number];
  // Solver storage (decision nodes only). Layout: [action * N + hand].
  regrets?: Float64Array;
  strategySum?: Float64Array;
  /** Scratch: current-iteration strategy, same layout as regrets. */
  current?: Float64Array;
  /** Scratch: per-action reach vectors of the acting player (used when the
   *  actor is not the traverser). */
  reachBuf?: Float64Array[];
  /** Scratch: counterfactual-value buffer per player (index = player). */
  cfvBuf?: [Float64Array, Float64Array];
}

export interface TreeParams {
  /** Pot at the start of the subgame, EXCLUDING any outstanding bet hero faces. */
  startingPot: number;
  /** Max chips either player can commit in this subgame (effective stack). */
  effectiveStack: number;
  /** Outstanding bet hero faces at the root (villain has committed this). */
  toCall: number;
  /** Hero is in position. With toCall == 0 and hero IP, villain has already
   *  checked, so a hero check closes the street. */
  heroIsIP: boolean;
  /** Bets/raises already made this street before the root (0 or more). If
   *  toCall > 0 this should be at least 1. */
  priorAggressions: number;
  abstraction: BetAbstraction;
}

interface BuildState {
  player: SubgamePlayer;
  committed: [number, number];
  toCall: number;
  aggressions: number;
  /** A check by the actor ends the street (actor is IP after an OOP check, or
   *  hero IP at a root where villain already checked). */
  checkCloses: boolean;
  /** Size of the last bet/raise increment, for the min-raise rule. */
  lastIncrement: number;
  line: string;
}

/** Round chips to cents so labels and amounts stay readable. */
function roundChips(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Build the current-street betting tree rooted at hero's decision. */
export function buildSubgameTree(p: TreeParams): GameNode {
  const toCall = Math.min(Math.max(0, p.toCall), p.effectiveStack);
  return buildNode(p, {
    player: 0,
    committed: [0, toCall],
    toCall,
    aggressions: toCall > 0 ? Math.max(1, p.priorAggressions) : p.priorAggressions,
    checkCloses: toCall === 0 && p.heroIsIP,
    lastIncrement: toCall,
    line: '',
  });
}

function buildNode(p: TreeParams, s: BuildState): GameNode {
  const me = s.player;
  const opp: SubgamePlayer = me === 0 ? 1 : 0;
  const pot = p.startingPot + s.committed[0] + s.committed[1];
  const node: GameNode = {
    kind: 'decision',
    player: me,
    actions: [],
    children: [],
    line: s.line,
    pot,
    committed: [s.committed[0], s.committed[1]],
  };
  const sep = s.line ? '/' : '';

  if (s.toCall > 0) {
    // Fold: the folder's commitments stay in the pot.
    node.actions.push({ kind: 'fold', chips: 0, totalCommitted: s.committed[me], potFraction: 0, label: 'F' });
    node.children.push(leaf('fold', me, s.line + sep + 'F', pot, s.committed));
    // Call: match the bet => chips matched => the street ends at a showdown leaf.
    const callTo = s.committed[opp];
    const after: [number, number] = [s.committed[0], s.committed[1]];
    after[me] = callTo;
    node.actions.push({
      kind: 'call', chips: roundChips(callTo - s.committed[me]), totalCommitted: callTo, potFraction: 0, label: 'C',
    });
    node.children.push(leaf('showdown', me, s.line + sep + 'C', p.startingPot + after[0] + after[1], after));
  } else {
    node.actions.push({ kind: 'check', chips: 0, totalCommitted: s.committed[me], potFraction: 0, label: 'X' });
    if (s.checkCloses) {
      node.children.push(leaf('showdown', me, s.line + sep + 'X', pot, s.committed));
    } else {
      node.children.push(buildNode(p, {
        player: opp,
        committed: s.committed,
        toCall: 0,
        aggressions: s.aggressions,
        checkCloses: true,
        lastIncrement: 0,
        line: s.line + sep + 'X',
      }));
    }
  }

  // Aggressive actions.
  for (const a of aggressiveActions(p, s, pot)) {
    const after: [number, number] = [s.committed[0], s.committed[1]];
    after[me] = a.totalCommitted;
    const increment = a.totalCommitted - s.committed[opp];
    node.actions.push(a);
    node.children.push(buildNode(p, {
      player: opp,
      committed: after,
      toCall: a.totalCommitted - s.committed[opp],
      aggressions: s.aggressions + 1,
      checkCloses: false,
      lastIncrement: Math.max(increment, s.lastIncrement),
      line: s.line + sep + a.label,
    }));
  }
  return node;
}

/**
 * Bet/raise/all-in actions at a node. Sizes are de-duplicated, sizes that
 * commit at least `allInThreshold` of the remaining stack collapse into all-in,
 * raises respect the no-limit min-raise rule, and all-in is gated on SPR.
 */
function aggressiveActions(p: TreeParams, s: BuildState, pot: number): TreeAction[] {
  const ab = p.abstraction;
  const me = s.player;
  const opp = me === 0 ? 1 : 0;
  const E = p.effectiveStack;
  const callTo = s.committed[opp];
  // Nobody can raise once the opponent is all-in, or once the cap is reached.
  if (s.aggressions >= ab.maxAggressions) return [];
  if (callTo >= E || s.committed[me] >= E) return [];

  const facing = s.toCall > 0;
  const potAfterCall = pot + s.toCall;
  const behindAfterCall = E - callTo;
  const minTo = facing ? callTo + Math.max(s.lastIncrement, 1e-9) : s.committed[me];
  const fracs = facing ? ab.raiseFractions : ab.betFractions;
  // The last allowed aggression level (re-raise when maxAggressions == 3) is
  // all-in only: a re-raise in practice is almost always a commitment anyway.
  const lastLevel = s.aggressions + 1 >= ab.maxAggressions && s.aggressions >= 2;

  const totals = new Map<number, number>(); // total committed -> pot fraction label
  let sawAllInBySize = false;
  if (!lastLevel) {
    for (const f of fracs) {
      let to = callTo + f * potAfterCall;
      if (facing && to < minTo) to = minTo;
      to = roundChips(to);
      if (to <= callTo) continue;
      const remaining = E - s.committed[me];
      if (to >= E || (to - s.committed[me]) >= ab.allInThreshold * remaining) {
        sawAllInBySize = true;
        continue;
      }
      if (!totals.has(to)) totals.set(to, f);
    }
  }
  const spr = behindAfterCall / Math.max(1e-9, potAfterCall);
  const offerAllIn = sawAllInBySize || lastLevel || spr <= ab.allInMaxSpr || totals.size === 0;

  const out: TreeAction[] = [];
  const sorted = Array.from(totals.keys()).sort((a, b) => a - b);
  for (const to of sorted) {
    const f = totals.get(to)!;
    const chips = roundChips(to - s.committed[me]);
    out.push({
      kind: facing ? 'raise' : 'bet',
      chips,
      totalCommitted: to,
      potFraction: chips / Math.max(1e-9, pot),
      label: `${facing ? 'R' : 'B'}${Math.round(f * 100)}`,
    });
  }
  if (offerAllIn) {
    const chips = roundChips(E - s.committed[me]);
    out.push({ kind: 'allin', chips, totalCommitted: E, potFraction: chips / Math.max(1e-9, pot), label: 'A' });
  }
  return out;
}

function leaf(
  kind: 'fold' | 'showdown',
  player: SubgamePlayer,
  line: string,
  pot: number,
  committed: [number, number],
): GameNode {
  return { kind, player, actions: [], children: [], line, pot, committed: [committed[0], committed[1]] };
}

/** Count decision and terminal nodes (for diagnostics / tests). */
export function countTree(root: GameNode): { decisions: number; terminals: number } {
  let decisions = 0;
  let terminals = 0;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.kind === 'decision') {
      decisions++;
      for (const c of n.children) stack.push(c);
    } else terminals++;
  }
  return { decisions, terminals };
}

// ------------------------------------------------------------
// Showdown equity matrix
// ------------------------------------------------------------

/**
 * Hero's showdown share for every (hero combo, villain combo) pair, plus the
 * 0/1 compatibility mask. share[i*V + j] in [0,1] (0.5 on a tie), 0 where the
 * combos conflict.
 *
 * River: one comparison. Turn: exact average over every river card. Flop: exact
 * average over every (turn, river) pair when `maxFlopRunouts` allows it,
 * otherwise a deterministic seeded sample of that many runouts. The loop is
 * per runout (evaluate each combo once, then compare all pairs), which costs
 * runouts * (H + V) evaluations instead of runouts * H * V.
 */
export function showdownMatrix(
  board: CardId[],
  hero: [CardId, CardId][],
  villain: [CardId, CardId][],
  maxFlopRunouts = 1200,
  seed = 1,
): { share: Float64Array; compat: Float64Array } {
  const H = hero.length;
  const V = villain.length;
  const compat = new Float64Array(H * V);
  for (let i = 0; i < H; i++) {
    const [a, b] = hero[i];
    for (let j = 0; j < V; j++) {
      const [c, d] = villain[j];
      compat[i * V + j] = a === c || a === d || b === c || b === d ? 0 : 1;
    }
  }

  // Runouts to average over.
  const dead = new Set<number>(board);
  const live: CardId[] = [];
  for (let c = 0; c < 52; c++) if (!dead.has(c)) live.push(c);
  let runouts: CardId[][];
  const toCome = 5 - board.length;
  if (toCome === 0) runouts = [[]];
  else if (toCome === 1) runouts = live.map((c) => [c]);
  else {
    const all: CardId[][] = [];
    for (let x = 0; x < live.length; x++) {
      for (let y = x + 1; y < live.length; y++) all.push([live[x], live[y]]);
    }
    if (all.length <= maxFlopRunouts) runouts = all;
    else {
      // Deterministic partial Fisher-Yates: the first maxFlopRunouts entries.
      const rng = new SeededRng(seed);
      for (let k = 0; k < maxFlopRunouts; k++) {
        const r = k + rng.nextInt(all.length - k);
        const tmp = all[k]; all[k] = all[r]; all[r] = tmp;
      }
      runouts = all.slice(0, maxFlopRunouts);
    }
  }

  const win = new Float64Array(H * V);
  const cnt = new Float64Array(H * V);
  const hs = new Float64Array(H);
  const vs = new Float64Array(V);
  const cards7: CardId[] = new Array(7);
  for (const ro of runouts) {
    const full = board.concat(ro);
    const blocked = new Set<number>(ro);
    for (let k = 0; k < full.length; k++) cards7[2 + k] = full[k];
    cards7.length = 2 + full.length;
    for (let i = 0; i < H; i++) {
      const [a, b] = hero[i];
      if (blocked.has(a) || blocked.has(b)) { hs[i] = -1; continue; }
      cards7[0] = a; cards7[1] = b;
      hs[i] = evaluateHand(cards7);
    }
    for (let j = 0; j < V; j++) {
      const [a, b] = villain[j];
      if (blocked.has(a) || blocked.has(b)) { vs[j] = -1; continue; }
      cards7[0] = a; cards7[1] = b;
      vs[j] = evaluateHand(cards7);
    }
    for (let i = 0; i < H; i++) {
      const h = hs[i];
      if (h < 0) continue;
      const row = i * V;
      for (let j = 0; j < V; j++) {
        const v = vs[j];
        if (v < 0 || compat[row + j] === 0) continue;
        win[row + j] += h > v ? 1 : h < v ? 0 : 0.5;
        cnt[row + j] += 1;
      }
    }
  }
  const share = new Float64Array(H * V);
  for (let k = 0; k < H * V; k++) {
    // A compatible pair with no sampled runout (possible only under flop
    // sampling) falls back to 0.5; it is vanishingly rare with >= 200 samples.
    share[k] = compat[k] === 0 ? 0 : cnt[k] > 0 ? win[k] / cnt[k] : 0.5;
  }
  return { share, compat };
}

// ------------------------------------------------------------
// The range-vs-range CFR solver
// ------------------------------------------------------------

// Discounted CFR parameters (Brown & Sandholm 2019). Positive regrets are
// scaled by t^a/(t^a+1), negative ones by t^b/(t^b+1), and the average-strategy
// accumulator by (t/(t+1))^g, each iteration.
const DCFR_ALPHA = 1.5;
const DCFR_BETA = 0.5;
const DCFR_GAMMA = 2;

export interface RangeCfrInput {
  board: CardId[];
  /** Hero's range (combos must not touch the board). Weights > 0. */
  hero: RangeHand[];
  /** Villain's range (combos must not touch the board). Weights > 0. */
  villain: RangeHand[];
  tree: TreeParams;
  /** Flop only: cap on runouts in the showdown matrix (default 1200, i.e.
   *  effectively exact: a flop has C(49,2) = 1176 runouts). */
  maxFlopRunouts?: number;
  seed?: number;
}

/**
 * Range-vs-range DCFR over one street's betting tree. Construct, call
 * `iterate()` repeatedly, then read average strategies / exploitability.
 */
export class RangeVsRangeCfr {
  readonly root: GameNode;
  readonly hands: [[CardId, CardId][], [CardId, CardId][]];
  /** Normalized chance weights per player (each sums to 1). */
  readonly weights: [Float64Array, Float64Array];
  readonly startingPot: number;
  /** Number of completed iterations. */
  iterations = 0;

  /** payoff matrices from each player's perspective: share[p][i*No + j]. */
  private share: [Float64Array, Float64Array];
  /** compatibility masks per perspective, same layout. */
  private compat: [Float64Array, Float64Array];
  /** For combo i of player p: index of the identical combo in the opponent's
   *  range, or -1. Used for the O(N) card-removal reach sum. */
  private sameIdx: [Int32Array, Int32Array];
  private N: [number, number];
  /** Joint chance mass Z = sum_ij w0[i] w1[j] compat(i,j). */
  readonly jointMass: number;
  private cardSum = new Float64Array(52);

  constructor(input: RangeCfrInput) {
    const h = input.hero;
    const v = input.villain;
    if (h.length === 0 || v.length === 0) throw new Error('Both ranges must be non-empty.');
    this.hands = [h.map((x) => x.cards), v.map((x) => x.cards)];
    this.N = [h.length, v.length];
    this.weights = [normWeights(h), normWeights(v)];
    this.startingPot = input.tree.startingPot;
    this.root = buildSubgameTree(input.tree);

    const H = h.length;
    const V = v.length;
    const { share, compat } = showdownMatrix(input.board, this.hands[0], this.hands[1], input.maxFlopRunouts ?? 1200, input.seed ?? 1);
    // Villain-perspective matrices are the transposes, with share = 1 - hero's.
    const shareV = new Float64Array(V * H);
    const compatV = new Float64Array(V * H);
    for (let i = 0; i < H; i++) {
      for (let j = 0; j < V; j++) {
        const c = compat[i * V + j];
        compatV[j * H + i] = c;
        shareV[j * H + i] = c === 0 ? 0 : 1 - share[i * V + j];
      }
    }
    this.share = [share, shareV];
    this.compat = [compat, compatV];

    const key = (c: [CardId, CardId]) => Math.min(c[0], c[1]) * 64 + Math.max(c[0], c[1]);
    const idx0 = new Map<number, number>();
    const idx1 = new Map<number, number>();
    this.hands[0].forEach((c, i) => idx0.set(key(c), i));
    this.hands[1].forEach((c, j) => idx1.set(key(c), j));
    this.sameIdx = [
      Int32Array.from(this.hands[0].map((c) => idx1.get(key(c)) ?? -1)),
      Int32Array.from(this.hands[1].map((c) => idx0.get(key(c)) ?? -1)),
    ];

    let z = 0;
    for (let i = 0; i < H; i++) {
      let row = 0;
      for (let j = 0; j < V; j++) row += compat[i * V + j] * this.weights[1][j];
      z += this.weights[0][i] * row;
    }
    if (!(z > 0)) throw new Error('Ranges are fully card-blocked against each other.');
    this.jointMass = z;

    this.allocate(this.root);
  }

  private allocate(node: GameNode): void {
    node.cfvBuf = [new Float64Array(this.N[0]), new Float64Array(this.N[1])];
    if (node.kind !== 'decision') return;
    const n = this.N[node.player];
    const A = node.actions.length;
    node.regrets = new Float64Array(n * A);
    node.strategySum = new Float64Array(n * A);
    node.current = new Float64Array(n * A);
    // Reach buffers hold the ACTING player's reach split by action; they are
    // used when the actor is the non-traverser.
    node.reachBuf = node.actions.map(() => new Float64Array(n));
    for (const c of node.children) this.allocate(c);
  }

  /** One DCFR iteration: a hero traversal then a villain traversal. */
  iterate(): void {
    const t = this.iterations + 1;
    const ta = Math.pow(t, DCFR_ALPHA);
    const tb = Math.pow(t, DCFR_BETA);
    const dPos = ta / (ta + 1);
    const dNeg = tb / (tb + 1);
    const dStrat = Math.pow(t / (t + 1), DCFR_GAMMA);
    for (const p of [0, 1] as SubgamePlayer[]) {
      const opp = p === 0 ? 1 : 0;
      this.cfr(this.root, p, this.weights[opp], dPos, dNeg, dStrat);
    }
    this.iterations = t;
  }

  /**
   * Vectorized CFR traversal for traverser `p`. `rOpp[j]` is the opponent's
   * reach for its combo j (chance weight times its action probabilities so far).
   * Returns p's counterfactual value per own combo i, i.e.
   *   sum_j rOpp[j] * compat(i,j) * payoff_p(i, j | this subtree).
   */
  private cfr(
    node: GameNode,
    p: SubgamePlayer,
    rOpp: Float64Array,
    dPos: number,
    dNeg: number,
    dStrat: number,
  ): Float64Array {
    if (node.kind !== 'decision') return this.terminal(node, p, rOpp);
    const out = node.cfvBuf![p];
    const A = node.actions.length;

    if (node.player === p) {
      const n = this.N[p];
      const sigma = this.currentStrategy(node);
      out.fill(0);
      const childVals: Float64Array[] = new Array(A);
      for (let a = 0; a < A; a++) {
        const cv = this.cfr(node.children[a], p, rOpp, dPos, dNeg, dStrat);
        childVals[a] = cv;
        const off = a * n;
        for (let i = 0; i < n; i++) out[i] += sigma[off + i] * cv[i];
      }
      // Regret update with DCFR discounting of the accumulated regret.
      const R = node.regrets!;
      for (let a = 0; a < A; a++) {
        const cv = childVals[a];
        const off = a * n;
        for (let i = 0; i < n; i++) {
          const old = R[off + i];
          R[off + i] = old * (old > 0 ? dPos : dNeg) + (cv[i] - out[i]);
        }
      }
      return out;
    }

    // Opponent node: split the opponent reach by its current strategy and
    // accumulate its average strategy (weighted by its own reach, rOpp).
    const no = this.N[node.player];
    const sigma = this.currentStrategy(node);
    const S = node.strategySum!;
    for (let k = 0; k < S.length; k++) S[k] *= dStrat;
    out.fill(0);
    for (let a = 0; a < A; a++) {
      const rChild = node.reachBuf![a];
      const off = a * no;
      for (let j = 0; j < no; j++) {
        const pr = sigma[off + j] * rOpp[j];
        rChild[j] = pr;
        S[off + j] += pr;
      }
      const cv = this.cfr(node.children[a], p, rChild, dPos, dNeg, dStrat);
      const n = this.N[p];
      for (let i = 0; i < n; i++) out[i] += cv[i];
    }
    return out;
  }

  /** Regret-matching strategy per hand at a decision node (into node.current). */
  private currentStrategy(node: GameNode): Float64Array {
    const n = this.N[node.player];
    const A = node.actions.length;
    const R = node.regrets!;
    const cur = node.current!;
    for (let i = 0; i < n; i++) {
      let pos = 0;
      for (let a = 0; a < A; a++) {
        const r = R[a * n + i];
        if (r > 0) pos += r;
      }
      if (pos > 0) {
        for (let a = 0; a < A; a++) {
          const r = R[a * n + i];
          cur[a * n + i] = r > 0 ? r / pos : 0;
        }
      } else {
        for (let a = 0; a < A; a++) cur[a * n + i] = 1 / A;
      }
    }
    return cur;
  }

  /** Average strategy per hand at a decision node: [action * N + hand]. */
  averageStrategy(node: GameNode): Float64Array {
    const n = this.N[node.player];
    const A = node.actions.length;
    const S = node.strategySum!;
    const avg = new Float64Array(n * A);
    for (let i = 0; i < n; i++) {
      let tot = 0;
      for (let a = 0; a < A; a++) tot += S[a * n + i];
      for (let a = 0; a < A; a++) avg[a * n + i] = tot > 0 ? S[a * n + i] / tot : 1 / A;
    }
    return avg;
  }

  /**
   * Leaf values for player p. Net chips relative to the start of the subgame:
   *   p folded:          -committed[p]
   *   opponent folded:    pot - committed[p]
   *   showdown:           share * pot - committed[p]
   * each weighted by the compatible opponent reach. Both players' payoffs sum
   * to the starting pot at every leaf, so the game is constant-sum.
   */
  private terminal(node: GameNode, p: SubgamePlayer, rOpp: Float64Array): Float64Array {
    const out = node.cfvBuf![p];
    const n = this.N[p];
    const c = node.committed[p];
    const mass = this.compatibleMass(p, rOpp, out);
    if (node.kind === 'fold') {
      const payoff = node.player === p ? -c : node.pot - c;
      for (let i = 0; i < n; i++) out[i] = payoff * mass[i];
      return out;
    }
    // Showdown: pot * (share-weighted opponent reach) - c * (compatible reach).
    const no = this.N[p === 0 ? 1 : 0];
    const M = this.share[p];
    const pot = node.pot;
    for (let i = 0; i < n; i++) {
      let s = 0;
      const row = i * no;
      for (let j = 0; j < no; j++) s += M[row + j] * rOpp[j];
      out[i] = pot * s - c * mass[i];
    }
    return out;
  }

  /**
   * sum_j compat(i,j) * r[j] for each of p's combos i, in O(N + 52) via card
   * removal: total - (reach of opponent combos containing card a) - (the same for card b)
   * + (reach of the identical combo, which was subtracted twice).
   * Writes into `out` and returns it.
   */
  private compatibleMass(p: SubgamePlayer, r: Float64Array, out: Float64Array): Float64Array {
    const opp = p === 0 ? 1 : 0;
    const oppHands = this.hands[opp];
    const cs = this.cardSum;
    cs.fill(0);
    let total = 0;
    for (let j = 0; j < oppHands.length; j++) {
      const w = r[j];
      total += w;
      cs[oppHands[j][0]] += w;
      cs[oppHands[j][1]] += w;
    }
    const mine = this.hands[p];
    const same = this.sameIdx[p];
    for (let i = 0; i < mine.length; i++) {
      const s = same[i];
      out[i] = total - cs[mine[i][0]] - cs[mine[i][1]] + (s >= 0 ? r[s] : 0);
    }
    return out;
  }

  /**
   * Value vector for player p when p plays a best response (mode 'br') or its
   * own average strategy (mode 'avg'), and the opponent plays its average
   * strategy. Same vector convention as cfr().
   */
  private evaluate(node: GameNode, p: SubgamePlayer, rOpp: Float64Array, mode: 'br' | 'avg'): Float64Array {
    if (node.kind !== 'decision') return Float64Array.from(this.terminal(node, p, rOpp));
    const A = node.actions.length;
    const n = this.N[p];
    const out = new Float64Array(n);
    if (node.player === p) {
      const avg = mode === 'avg' ? this.averageStrategy(node) : null;
      if (mode === 'br') out.fill(-Infinity);
      for (let a = 0; a < A; a++) {
        const cv = this.evaluate(node.children[a], p, rOpp, mode);
        if (avg) {
          for (let i = 0; i < n; i++) out[i] += avg[a * n + i] * cv[i];
        } else {
          for (let i = 0; i < n; i++) if (cv[i] > out[i]) out[i] = cv[i];
        }
      }
      return out;
    }
    const no = this.N[node.player];
    const avg = this.averageStrategy(node);
    for (let a = 0; a < A; a++) {
      const rChild = new Float64Array(no);
      for (let j = 0; j < no; j++) rChild[j] = avg[a * no + j] * rOpp[j];
      const cv = this.evaluate(node.children[a], p, rChild, mode);
      for (let i = 0; i < n; i++) out[i] += cv[i];
    }
    return out;
  }

  /** Expected value (chips, net from subgame start) of player p's whole range
   *  under the given mode, normalized by the joint chance mass. */
  private rangeValue(p: SubgamePlayer, mode: 'br' | 'avg'): number {
    const opp = p === 0 ? 1 : 0;
    const cv = this.evaluate(this.root, p, this.weights[opp], mode);
    const w = this.weights[p];
    let s = 0;
    for (let i = 0; i < cv.length; i++) s += w[i] * cv[i];
    return s / this.jointMass;
  }

  /**
   * Exploitability of the current average strategies within the abstraction:
   *   NashConv = BRvalue(hero vs avg villain) + BRvalue(villain vs avg hero) - P0
   * where P0 is the constant sum of payoffs (the subgame's starting pot).
   * Returns NashConv / 2 in chips (the average amount a best-responder gains).
   */
  exploitability(): number {
    const br0 = this.rangeValue(0, 'br');
    const br1 = this.rangeValue(1, 'br');
    return Math.max(0, (br0 + br1 - this.startingPot) / 2);
  }

  /** Per-combo EV (chips, net from subgame start) of player p's combos when
   *  both players follow their average strategies. NaN for a combo that is
   *  fully card-blocked. */
  comboValues(p: SubgamePlayer): Float64Array {
    const opp = p === 0 ? 1 : 0;
    const cv = this.evaluate(this.root, p, this.weights[opp], 'avg');
    const mass = this.compatibleMass(p, this.weights[opp], new Float64Array(this.N[p]));
    const out = new Float64Array(cv.length);
    for (let i = 0; i < cv.length; i++) out[i] = mass[i] > 0 ? cv[i] / mass[i] : NaN;
    return out;
  }

  /** Follow a sequence of action labels from the root ('X', 'B75', 'C', ...). */
  nodeAt(labels: string[]): GameNode {
    let n = this.root;
    for (const l of labels) {
      const k = n.actions.findIndex((a) => a.label === l);
      if (k < 0) throw new Error(`No action '${l}' at line '${n.line}' (have ${n.actions.map((a) => a.label).join(',')})`);
      n = n.children[k];
    }
    return n;
  }

  /**
   * Range-weighted frequency of each action at a decision node: each combo's
   * average strategy weighted by its chance weight times its own reach along the
   * line (from strategySum, which is accumulated with exactly that reach).
   */
  rangeFrequencies(node: GameNode): number[] {
    const n = this.N[node.player];
    const A = node.actions.length;
    const S = node.strategySum!;
    const f = new Array<number>(A).fill(0);
    let tot = 0;
    for (let a = 0; a < A; a++) {
      for (let i = 0; i < n; i++) f[a] += S[a * n + i];
      tot += f[a];
    }
    return f.map((x) => (tot > 0 ? x / tot : 1 / A));
  }
}

function normWeights(r: RangeHand[]): Float64Array {
  const w = new Float64Array(r.length);
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const x = r[i].weight > 0 ? r[i].weight : 0;
    w[i] = x;
    s += x;
  }
  if (!(s > 0)) throw new Error('Range has no positive weight.');
  for (let i = 0; i < r.length; i++) w[i] /= s;
  return w;
}

// ------------------------------------------------------------
// Default range construction (used only when no range is supplied)
// ------------------------------------------------------------

/**
 * A reasonable wide single-raised-pot continuing range: all pocket pairs, all
 * suited broadways/connectors, and strong offsuit broadways. We materialize it
 * as concrete combos that do not conflict with the board. One representative
 * combo per hand class keeps it small.
 */
function defaultRangeCombos(board: CardId[], exclude: CardId[]): RangeHand[] {
  const dead = new Set<number>([...board, ...exclude]);
  const out: RangeHand[] = [];
  for (let r1 = 12; r1 >= 0; r1--) {
    for (let r2 = r1; r2 >= 0; r2--) {
      const isPair = r1 === r2;
      const keep = handGroupKeep(r1, r2);
      if (!keep.weight) continue;
      const combos = pickCombos(r1, r2, isPair, dead, keep.suitedOnly);
      for (const c of combos) out.push({ cards: c, weight: keep.weight });
    }
  }
  return out;
}

function handGroupKeep(r1: number, r2: number): { weight: number; suitedOnly: boolean } {
  const high = Math.max(r1, r2);
  const low = Math.min(r1, r2);
  const gap = high - low;
  if (r1 === r2) return { weight: high >= 8 ? 1 : 0.8, suitedOnly: false };
  if (low >= 8) return { weight: 1, suitedOnly: false };
  if (high >= 10 && low >= 5) return { weight: 0.7, suitedOnly: false };
  if (high >= 8 && gap <= 1) return { weight: 0.6, suitedOnly: true };
  if (gap <= 2 && low >= 3 && high <= 11) return { weight: 0.5, suitedOnly: true };
  if (high === 12) return { weight: 0.5, suitedOnly: true };
  return { weight: 0, suitedOnly: false };
}

function pickCombos(
  r1: number,
  r2: number,
  isPair: boolean,
  dead: Set<number>,
  suitedOnly: boolean,
): [CardId, CardId][] {
  const out: [CardId, CardId][] = [];
  if (isPair) {
    const cards: CardId[] = [];
    for (let s = 0; s < 4 && cards.length < 2; s++) {
      const id = r1 * 4 + s;
      if (!dead.has(id)) cards.push(id);
    }
    if (cards.length === 2) out.push([cards[0], cards[1]]);
    return out;
  }
  const high = Math.max(r1, r2);
  const low = Math.min(r1, r2);
  for (let s = 0; s < 4; s++) {
    const a = high * 4 + s;
    const b = low * 4 + s;
    if (!dead.has(a) && !dead.has(b)) { out.push([a, b]); break; }
  }
  if (!suitedOnly) {
    outer: for (let sa = 0; sa < 4; sa++) {
      for (let sb = 0; sb < 4; sb++) {
        if (sa === sb) continue;
        const a = high * 4 + sa;
        const b = low * 4 + sb;
        if (!dead.has(a) && !dead.has(b)) { out.push([a, b]); break outer; }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------
// Legacy entry point: solvePostflop (RangeHand[] ranges, optional defaults)
// ------------------------------------------------------------

export interface SolvePostflopInput {
  /** Board cards as ids (3, 4, or 5 of them). */
  board: CardId[];
  /** Hero's exact hole cards. */
  heroCards: [CardId, CardId];
  /** Pot at the moment of decision, EXCLUDING any bet hero is facing. */
  pot: number;
  /** Effective remaining stack behind, per player (chips). */
  effectiveStack: number;
  /** Amount hero must call right now (0 when hero is not facing a bet). */
  toCall?: number;
  /** Whether hero is in position. With no bet to face, IP means villain has
   *  checked, so hero checking ends the street. Default false (hero OOP). */
  heroInPosition?: boolean;
  /** Optional explicit hero range. Hero's exact hand is always added. */
  heroRange?: RangeHand[];
  /** Optional explicit villain range; a wide default is used otherwise. */
  villainRange?: RangeHand[];
  /** Opening bet sizes (pot fractions). Default per street, see
   *  defaultAbstraction(). */
  betFractions?: number[];
  /** Hard iteration budget. Default 300. */
  maxIterations?: number;
  /** Hard wall-clock budget in ms. Default 1500. */
  timeBudgetMs?: number;
  /** Seed for deterministic range sub-sampling. Default 1. */
  seed?: number;
  /** Cap on villain combos (sub-sampled deterministically). Default 60. */
  maxVillainCombos?: number;
}

export interface SolvePostflopResult {
  /** Converged average strategy for hero's root decision. */
  strategy: StrategyDistribution;
  /** CFR iterations actually performed before the budget was hit. */
  iterations: number;
  /** Wall-clock time spent in the solve (ms). */
  timeMs: number;
  /** Hero's EV with its actual hand under the average strategies (chips, net
   *  from the start of the subgame). */
  ev: number;
}

/**
 * Solve the current postflop spot and return hero's mixed strategy as a
 * {@link StrategyDistribution}. Kept for back-compatibility; new callers with
 * real weighted ranges should use solveSubgame() in ./subgame.ts. Throws on bad
 * input; callers catch and fall back.
 */
export function solvePostflop(input: SolvePostflopInput): SolvePostflopResult {
  const start = Date.now();
  if (input.board.length < 3 || input.board.length > 5) {
    throw new Error(`Postflop solver needs a 3-5 card board (got ${input.board.length}).`);
  }
  const seen = new Set<number>(input.board);
  for (const c of input.heroCards) {
    if (seen.has(c)) throw new Error('Hero card collides with the board.');
    seen.add(c);
  }
  const pot = Math.max(1, input.pot);
  const effectiveStack = Math.max(1, input.effectiveStack);
  const maxIterations = input.maxIterations ?? 300;
  const timeBudgetMs = input.timeBudgetMs ?? 1500;
  const rng = new SeededRng(input.seed ?? 1);

  const dead = new Set<number>(input.board);
  const okBoard = (h: RangeHand) => !dead.has(h.cards[0]) && !dead.has(h.cards[1]) && h.cards[0] !== h.cards[1];
  let heroRange = (input.heroRange ?? defaultRangeCombos(input.board, [])).filter(okBoard);
  if (!heroRange.some((h) => sameHand(h.cards, input.heroCards))) {
    heroRange = [...heroRange, { cards: input.heroCards, weight: 1 }];
  }
  let villainRange = (input.villainRange ?? defaultRangeCombos(input.board, [...input.heroCards])).filter(okBoard);
  villainRange = capRandom(villainRange, input.maxVillainCombos ?? 60, rng);
  if (villainRange.length === 0) throw new Error('Villain range is empty after board filtering.');

  const abstraction = defaultAbstraction(input.board.length);
  if (input.betFractions) abstraction.betFractions = input.betFractions;
  const toCall = input.toCall ?? 0;
  const solver = new RangeVsRangeCfr({
    board: input.board,
    hero: heroRange,
    villain: villainRange,
    tree: {
      startingPot: pot,
      effectiveStack,
      toCall,
      heroIsIP: !!input.heroInPosition,
      priorAggressions: toCall > 0 ? 1 : 0,
      abstraction,
    },
    seed: input.seed ?? 1,
    maxFlopRunouts: 300,
  });

  while (solver.iterations < maxIterations) {
    solver.iterate();
    if (Date.now() - start >= timeBudgetMs) break;
  }
  const heroIdx = heroRange.findIndex((h) => sameHand(h.cards, input.heroCards));
  const avg = solver.averageStrategy(solver.root);
  const probs = solver.root.actions.map((_, a) => avg[a * heroRange.length + heroIdx]);
  const ev = solver.comboValues(0)[heroIdx];
  return {
    strategy: toStrategyDistribution(solver.root.actions, probs),
    iterations: solver.iterations,
    timeMs: Date.now() - start,
    ev: Number.isFinite(ev) ? ev : 0,
  };
}

function sameHand(a: [CardId, CardId], b: [CardId, CardId]): boolean {
  return (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);
}

/** Deterministic seeded sub-sample to at most `cap` combos. */
function capRandom(range: RangeHand[], cap: number, rng: SeededRng): RangeHand[] {
  if (range.length <= cap) return range;
  const idx = range.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, cap).map((i) => range[i]);
}

/**
 * Convert per-action probabilities into the project's
 * {@link StrategyDistribution}. Bet/raise/all-in actions go into `bets` keyed by
 * the chips hero adds with that action; fold/check/call map to scalars.
 */
export function toStrategyDistribution(actions: TreeAction[], probs: number[]): StrategyDistribution {
  let fold = 0;
  let check = 0;
  let call = 0;
  const bets: { amount: number; probability: number }[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const p = probs[i];
    if (a.kind === 'fold') fold += p;
    else if (a.kind === 'check') check += p;
    else if (a.kind === 'call') call += p;
    else bets.push({ amount: a.chips, probability: p });
  }
  let total = fold + check + call;
  for (const b of bets) total += b.probability;
  if (total > 0 && Math.abs(total - 1) > 1e-9) {
    fold /= total; check /= total; call /= total;
    for (const b of bets) b.probability /= total;
  }
  return { fold, check, call, bets };
}
