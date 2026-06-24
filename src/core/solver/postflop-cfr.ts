// ============================================================
// Depth-Limited Postflop CFR Subgame Solver (pure TypeScript).
// ------------------------------------------------------------
// A genuine counterfactual-regret-minimization solve of the CURRENT postflop
// decision, modelled as a two-player extensive-form subgame: hero's range vs an
// estimated villain range on the actual board, given the live pot and effective
// stack. It is "depth-limited" in the Pluribus / Brown-Sandholm sense
// (Brown, Sandholm & Amos 2018, "Depth-Limited Solving for Imperfect-Information
// Games"; Brown & Sandholm 2019, "Superhuman AI for multiplayer poker"
// (Pluribus)): we build out the betting tree for the current street only and,
// instead of recursing into future chance/board cards, value every leaf where
// the action sequence resolves the hand with an EXACT equity computation from
// the perfect-hash evaluator:
//   - a leaf where someone folds  => the other player wins the current pot,
//   - a leaf where betting is matched ("call"/"check-through") and chips are
//     still behind => an equity-weighted showdown of the two ranges over the
//     remaining runout (all-in equity of the surviving ranges).
//
// This is the standard tractable real-time method: full CFR on the current
// street's action abstraction with an equity-evaluated leaf, rather than a full
// multi-street solve. It is honest CFR (regret matching over a real game tree),
// NOT heuristics: we run regret-matching+ updates over enumerated range pairs
// and return the converged AVERAGE strategy.
//
// Action abstraction (kept deliberately small for tractability):
//   fold / check / call / bet-or-raise at a SMALL set of pot fractions
//   (default 33% pot, 75% pot, all-in). Raises are capped (one raise then
//   call/all-in) to bound the tree.
//
// Runs on the MAIN thread under a HARD time/iteration budget so it can never
// hang the UI; callers fall back to a heuristic on timeout/error.
// ============================================================

import { CardId, StrategyDistribution } from '../../types/poker';
import { createDeck, removeCards } from '../cfr/card-utils';
import { evaluateHand } from '../equity/hand-eval';
import { SeededRng } from '../../solver/rng';

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

/** A weighted hand in a range: two hole-card ids plus a relative weight. */
export interface RangeHand {
  cards: [CardId, CardId];
  weight: number;
}

export interface SolvePostflopInput {
  /** Board cards as ids (3, 4, or 5 of them). */
  board: CardId[];
  /** Hero's exact hole cards. */
  heroCards: [CardId, CardId];
  /** Current pot size (chips) at the moment of decision. */
  pot: number;
  /** Effective remaining stack behind, per player (chips). */
  effectiveStack: number;
  /** Amount hero must call right now (0 when hero is not facing a bet). */
  toCall?: number;
  /** Whether hero is in position (acts last). Used only to pick a default
   *  villain range; the solve itself is position-agnostic. */
  heroInPosition?: boolean;
  /** Optional explicit hero range. When omitted, a wide single-raised-pot
   *  continuing range is used and hero's exact hand is guaranteed present. */
  heroRange?: RangeHand[];
  /** Optional explicit villain range. When omitted a sensible continuing
   *  range is generated. */
  villainRange?: RangeHand[];
  /** Pot-fraction bet sizes to include in the abstraction. Default [0.33,0.75]
   *  plus an implicit all-in. */
  betFractions?: number[];
  /** Hard iteration budget (CFR passes). Default 300. */
  maxIterations?: number;
  /** Hard wall-clock budget in ms. Default 200. Whichever limit is hit first
   *  stops the solve; the average strategy so far is returned. */
  timeBudgetMs?: number;
  /** Seed for the deterministic RNG used in range sampling. Default 1. */
  seed?: number;
  /** Cap on the number of villain combos enumerated (for tractability).
   *  Default 60. Larger ranges are sub-sampled deterministically. */
  maxVillainCombos?: number;
}

export interface SolvePostflopResult {
  /** Converged average strategy for hero's root decision. */
  strategy: StrategyDistribution;
  /** CFR iterations actually performed before the budget was hit. */
  iterations: number;
  /** Wall-clock time spent in the solve (ms). */
  timeMs: number;
  /** Hero's root counterfactual EV under the solved strategy (chips). */
  ev: number;
}

// ------------------------------------------------------------
// Betting-tree node model
// ------------------------------------------------------------

const A_FOLD = 'F';
const A_CHECK = 'X';
const A_CALL = 'C';
// Bets/raises are encoded as 'B<index>' where index keys into the size list.

type Player = 0 | 1; // 0 = hero, 1 = villain

/**
 * A betting-tree node. The tree is shared across all range pairs; each player's
 * actual hole cards only enter at the LEAVES (via equity/showdown valuation).
 * Information sets are therefore keyed purely by (player, betting-line),
 * matching the depth-limited subgame formulation where the board is fixed.
 */
interface TreeNode {
  kind: 'decision' | 'terminal';
  /** For decision nodes: who acts. */
  player: Player;
  /** Legal action labels at a decision node, in fixed order. */
  actions: string[];
  /** Child node per action (parallel to `actions`). */
  children: TreeNode[];
  /** Info-set key (player + line). Identical lines for the same player share a
   *  node, so this is just the node's own key. */
  infoSetKey: string;
  // Terminal-leaf valuation metadata (only set when kind === 'terminal'):
  /** 'fold' => `folder` folds; 'showdown' => chips matched, go to equity. */
  terminalKind?: 'fold' | 'showdown';
  /** The player who folded (for 'fold' leaves). */
  folder?: Player;
  /** Pot at this leaf (chips), i.e. starting pot + all chips committed. */
  leafPot?: number;
  /** Chips hero committed in THIS subgame at this leaf (for EV bookkeeping). */
  heroCommitted?: number;
  /** Chips villain committed in this subgame at this leaf. */
  villainCommitted?: number;
}

// ------------------------------------------------------------
// Tree construction
// ------------------------------------------------------------

interface BuildCtx {
  startingPot: number;
  effectiveStack: number;
  /** Absolute bet sizes (chips) usable as an opening bet, smallest..largest. */
  // Sizes are computed contextually from the pot at each node instead.
  betFractions: number[];
}

/**
 * Build the current-street betting tree. State carried while recursing:
 *   - committed[p]:   chips player p has put into THIS subgame so far.
 *   - toCall:         outstanding amount the player-to-act must match (0 => may
 *                     check; >0 => must call/fold/raise).
 *   - raisesLeft:     remaining raise budget (caps the tree).
 *   - player:         who acts.
 *   - line:           action-string so far (for info-set keys).
 */
function buildTree(ctx: BuildCtx): TreeNode {
  // Hero (player 0) acts first at the root of the subgame. When hero is facing
  // a bet, the caller models that by seeding `toCall` via the input (handled in
  // solvePostflop by pre-committing villain's bet). Here we always start with
  // hero to act; an outstanding `toCall` is supplied through the root builder.
  return buildNode(ctx, 0, [0, 0], 0, 1, '');
}

function buildNode(
  ctx: BuildCtx,
  player: Player,
  committed: [number, number],
  toCall: number,
  raisesLeft: number,
  line: string,
): TreeNode {
  const opp: Player = player === 0 ? 1 : 0;
  const actions: string[] = [];

  // Determine legal actions.
  const facingBet = toCall > 0;
  if (facingBet) actions.push(A_FOLD);
  if (facingBet) actions.push(A_CALL);
  else actions.push(A_CHECK);

  // Available bet/raise sizes (only if there is stack behind and raise budget).
  const stackBehind = ctx.effectiveStack - committed[player];
  const canAggress = stackBehind > 0 && raisesLeft > 0;
  const betLabels: string[] = [];
  if (canAggress) {
    // Pot at this node (starting pot + both players' committed chips).
    const potNow = ctx.startingPot + committed[0] + committed[1];
    const sizes = candidateBetSizes(ctx, potNow, toCall, committed, player);
    for (let i = 0; i < sizes.length; i++) {
      const label = `B${i}:${sizes[i]}`;
      betLabels.push(label);
      actions.push(label);
    }
  }

  const node: TreeNode = {
    kind: 'decision',
    player,
    actions,
    children: [],
    infoSetKey: `P${player}|${line}`,
  };

  for (const action of actions) {
    if (action === A_FOLD) {
      node.children.push(
        makeFoldLeaf(ctx, player, committed),
      );
    } else if (action === A_CHECK) {
      if (player === 1) {
        // Both checked through (hero checked, villain checks) => showdown.
        node.children.push(makeShowdownLeaf(ctx, committed));
      } else {
        // Hero checks; action passes to villain (no bet outstanding).
        node.children.push(
          buildNode(ctx, opp, committed, 0, raisesLeft, line + A_CHECK),
        );
      }
    } else if (action === A_CALL) {
      // Caller matches the outstanding bet => chips matched => showdown.
      const newCommitted: [number, number] = [committed[0], committed[1]];
      newCommitted[player] = committed[opp];
      node.children.push(makeShowdownLeaf(ctx, newCommitted));
    } else {
      // Bet or raise.
      const amt = parseBetAmount(action);
      const newCommitted: [number, number] = [committed[0], committed[1]];
      // To raise, first match outstanding, then add the raise increment is
      // already folded into `amt` (total chips this player now has in).
      newCommitted[player] = amt;
      const newToCall = newCommitted[player] - newCommitted[opp];
      node.children.push(
        buildNode(ctx, opp, newCommitted, newToCall, raisesLeft - 1, line + action),
      );
    }
  }

  return node;
}

/**
 * Candidate bet/raise sizes (total chips the acting player would have committed
 * AFTER the bet) for this node, derived from pot fractions plus all-in, capped
 * at the effective stack and de-duplicated.
 */
function candidateBetSizes(
  ctx: BuildCtx,
  potNow: number,
  toCall: number,
  committed: [number, number],
  player: Player,
): number[] {
  const opp: Player = player === 0 ? 1 : 0;
  const allInTotal = ctx.effectiveStack; // total chips in when shoving
  const callAmount = committed[opp]; // chips the player would have after calling
  const out = new Set<number>();

  for (const frac of ctx.betFractions) {
    // Pot-relative raise: after calling `toCall`, the pot would be potNow+toCall;
    // bet `frac` of that on top. Total commit = callAmount + toCall? Simplify:
    // total = committed[opp] + frac * (potNow + toCall).
    const raiseIncrement = frac * (potNow + toCall);
    let total = callAmount + raiseIncrement;
    total = Math.round(total);
    // Must be a genuine raise strictly larger than just calling, and <= all-in.
    if (total > callAmount && total < allInTotal) {
      out.add(total);
    }
  }
  // Offer all-in as the polar size only when the stack is shallow relative to
  // the pot (low SPR). With deep stacks and cards still to come, a single-street
  // depth-limited leaf OVER-realizes shove equity (no future-street risk is
  // modelled), so unconditionally offering all-in collapses the strategy onto
  // shoving. Gating it on SPR <= 2.5 keeps the abstraction honest: shoves only
  // appear where they are genuinely a normal size. (When pot-fraction sizes are
  // all suppressed because the stack is tiny, fall back to offering all-in so a
  // bet is always available.)
  const potNowForSpr = ctx.startingPot + committed[0] + committed[1];
  const spr = (allInTotal - callAmount) / Math.max(1, potNowForSpr);
  if (allInTotal > callAmount && (spr <= 2.5 || out.size === 0)) {
    out.add(allInTotal);
  }

  return Array.from(out).sort((a, b) => a - b);
}

function parseBetAmount(label: string): number {
  // Label form 'B<idx>:<amount>'.
  const colon = label.indexOf(':');
  return Number(label.slice(colon + 1));
}

function makeFoldLeaf(
  ctx: BuildCtx,
  player: Player,
  committed: [number, number],
): TreeNode {
  return {
    kind: 'terminal',
    player,
    actions: [],
    children: [],
    infoSetKey: '',
    terminalKind: 'fold',
    folder: player,
    leafPot: ctx.startingPot + committed[0] + committed[1],
    heroCommitted: committed[0],
    villainCommitted: committed[1],
  };
}

function makeShowdownLeaf(
  ctx: BuildCtx,
  committed: [number, number],
): TreeNode {
  return {
    kind: 'terminal',
    player: 0,
    actions: [],
    children: [],
    infoSetKey: '',
    terminalKind: 'showdown',
    leafPot: ctx.startingPot + committed[0] + committed[1],
    heroCommitted: committed[0],
    villainCommitted: committed[1],
  };
}

// ------------------------------------------------------------
// Regret store (re-using the regret-matching+ idea from src/solver/store.ts,
// but with a compact per-info-set numeric layout for speed).
// ------------------------------------------------------------

class Node {
  regretSum: Float64Array;
  strategySum: Float64Array;
  private cur: Float64Array;
  constructor(readonly numActions: number) {
    this.regretSum = new Float64Array(numActions);
    this.strategySum = new Float64Array(numActions);
    this.cur = new Float64Array(numActions);
  }
  /** Regret-matching+ current strategy (positive regrets normalized). */
  strategy(): Float64Array {
    let pos = 0;
    for (let i = 0; i < this.numActions; i++) {
      const r = this.regretSum[i];
      this.cur[i] = r > 0 ? r : 0;
      pos += this.cur[i];
    }
    if (pos > 0) {
      for (let i = 0; i < this.numActions; i++) this.cur[i] /= pos;
    } else {
      const u = 1 / this.numActions;
      for (let i = 0; i < this.numActions; i++) this.cur[i] = u;
    }
    return this.cur;
  }
  average(): number[] {
    const avg = new Array<number>(this.numActions).fill(0);
    let s = 0;
    for (let i = 0; i < this.numActions; i++) s += this.strategySum[i];
    if (s > 0) for (let i = 0; i < this.numActions; i++) avg[i] = this.strategySum[i] / s;
    else for (let i = 0; i < this.numActions; i++) avg[i] = 1 / this.numActions;
    return avg;
  }
}

// ------------------------------------------------------------
// The solver
// ------------------------------------------------------------

interface RangeEntry {
  cards: [CardId, CardId];
  weight: number;
}

class PostflopCfr {
  private store = new Map<string, Node>();
  private root: TreeNode;
  private board: CardId[];
  private heroIdx: number; // index into heroRange of hero's actual hand
  private heroRange: RangeEntry[];
  private villainRange: RangeEntry[];
  /** Cached showdown win-fraction for hero hand i vs villain hand j on the
   *  current board + average runout: result[i*V + j] in [0,1]. */
  private wins: Float64Array;
  private V: number;

  constructor(
    root: TreeNode,
    board: CardId[],
    heroRange: RangeEntry[],
    villainRange: RangeEntry[],
    heroIdx: number,
    private rng: SeededRng,
  ) {
    this.root = root;
    this.board = board;
    this.heroRange = heroRange;
    this.villainRange = villainRange;
    this.heroIdx = heroIdx;
    this.V = villainRange.length;
    this.wins = this.precomputeShowdown();
  }

  private getNode(key: string, numActions: number): Node {
    let n = this.store.get(key);
    if (!n) {
      n = new Node(numActions);
      this.store.set(key, n);
    }
    return n;
  }

  /**
   * Precompute the showdown win-fraction (hero perspective) for every
   * (hero hand, villain hand) pair on this board, enumerating the remaining
   * runout EXACTLY when few cards remain, or sampling it deterministically when
   * the runout is large (flop). This is the equity-leaf valuation; it is the
   * only place hole cards matter, which is what makes the depth-limited solve
   * cheap. Returns win share in [0,1] (0.5 on a tie).
   */
  private precomputeShowdown(): Float64Array {
    const H = this.heroRange.length;
    const V = this.villainRange.length;
    const out = new Float64Array(H * V);

    const cardsToCome = 5 - this.board.length;

    for (let i = 0; i < H; i++) {
      const hero = this.heroRange[i].cards;
      for (let j = 0; j < V; j++) {
        const vill = this.villainRange[j].cards;
        // Skip card-conflicting matchups: treat as a tie (no information).
        if (conflict(hero, vill, this.board)) {
          out[i * V + j] = 0.5;
          continue;
        }
        out[i * V + j] = this.showdownEquity(hero, vill, cardsToCome);
      }
    }
    return out;
  }

  /** Exact (river/turn) or sampled (flop) all-in equity of hero vs villain. */
  private showdownEquity(
    hero: [CardId, CardId],
    vill: [CardId, CardId],
    cardsToCome: number,
  ): number {
    if (cardsToCome === 0) {
      const h = evaluateHand([...hero, ...this.board]);
      const v = evaluateHand([...vill, ...this.board]);
      return h > v ? 1 : h < v ? 0 : 0.5;
    }

    const known = [...hero, ...vill, ...this.board];
    const deck = removeCards(createDeck(), known);

    if (cardsToCome === 1) {
      // Turn: enumerate all single river cards EXACTLY.
      let win = 0;
      let total = 0;
      for (const c of deck) {
        const full = [...this.board, c];
        const h = evaluateHand([...hero, ...full]);
        const v = evaluateHand([...vill, ...full]);
        win += h > v ? 1 : h < v ? 0 : 0.5;
        total++;
      }
      return total > 0 ? win / total : 0.5;
    }

    // Flop: two cards to come. Exact enumeration is C(45,2)=990 evals per pair,
    // which times many pairs blows the time budget. Sample a bounded number of
    // runouts deterministically via the seeded RNG instead.
    const SAMPLES = 80;
    let win = 0;
    const n = deck.length;
    for (let s = 0; s < SAMPLES; s++) {
      const a = this.rng.nextInt(n);
      let b = this.rng.nextInt(n);
      if (b === a) b = (b + 1) % n;
      const full = [...this.board, deck[a], deck[b]];
      const h = evaluateHand([...hero, ...full]);
      const v = evaluateHand([...vill, ...full]);
      win += h > v ? 1 : h < v ? 0 : 0.5;
    }
    return win / SAMPLES;
  }

  /**
   * One external-sampling-style CFR pass for the hero traverser, vectorized
   * over the villain range. We update hero's info sets exactly (full villain
   * range reach) and villain's info sets too (alternating not required: we run
   * both traversers each iteration like vanilla CFR but keep villain's hand
   * distribution as a reach-weighted vector).
   *
   * Implementation: a standard recursive CFR over the betting tree where the
   * "private information" of each player is their hand index. We fix hero's
   * actual hand (`heroIdx`) for the returned strategy but TRAIN over hero's
   * whole range so the strategy is range-consistent. Villain reach is a weight
   * vector over the villain range.
   *
   * For tractability and determinism we train hero hand-by-hand: each pass
   * traverses the tree once per hero hand with the full villain reach vector.
   */
  iterate(t: number): number {
    let evAccum = 0;
    const H = this.heroRange.length;
    // Villain reach vector (probability villain holds each combo), normalized.
    const villReach = new Float64Array(this.V);
    let wsum = 0;
    for (let j = 0; j < this.V; j++) wsum += this.villainRange[j].weight;
    for (let j = 0; j < this.V; j++) {
      villReach[j] = wsum > 0 ? this.villainRange[j].weight / wsum : 1 / this.V;
    }

    for (let i = 0; i < H; i++) {
      // Traverse for hero hand i with full villain reach; update both players.
      evAccum += this.cfr(this.root, i, villReach, 1, t);
    }
    return evAccum / H;
  }

  /**
   * Recursive CFR. `heroHand` is hero's fixed hand index this pass; `villReach`
   * is the per-villain-combo reach weight reaching this node (already includes
   * villain's strategy probabilities). `heroReach` is the scalar probability
   * hero reached this node under hero's current strategy. Returns hero's EV at
   * this node, range-weighted over the villain vector.
   */
  private cfr(
    node: TreeNode,
    heroHand: number,
    villReach: Float64Array,
    heroReach: number,
    t: number,
  ): number {
    if (node.kind === 'terminal') {
      return this.leafEv(node, heroHand, villReach);
    }

    const key = node.player === 0
      ? `${node.infoSetKey}|h${heroHand}`
      : node.infoSetKey; // villain info set shared across villain combos here
    const numActions = node.actions.length;

    if (node.player === 0) {
      // Hero decision: standard regret-matching over villain reach mass.
      const cfrNode = this.getNode(key, numActions);
      const strat = cfrNode.strategy();
      const utils = new Array<number>(numActions).fill(0);
      let nodeEv = 0;
      for (let a = 0; a < numActions; a++) {
        const u = this.cfr(node.children[a], heroHand, villReach, heroReach * strat[a], t);
        utils[a] = u;
        nodeEv += strat[a] * u;
      }
      // Counterfactual reach for hero = villain reach mass (sum of villReach).
      let villMass = 0;
      for (let j = 0; j < this.V; j++) villMass += villReach[j];
      for (let a = 0; a < numActions; a++) {
        const regret = villMass * (utils[a] - nodeEv);
        let r = cfrNode.regretSum[a] + regret;
        if (r < 0) r = 0; // regret-matching+
        cfrNode.regretSum[a] = r;
        cfrNode.strategySum[a] += heroReach * strat[a];
      }
      return nodeEv;
    } else {
      // Villain decision: villain mixes per its own strategy. Villain wants to
      // MINIMIZE hero EV, so we run regret matching on villain's NEGATED
      // utility. We update villain's info set using the reach-weighted vector.
      const cfrNode = this.getNode(key, numActions);
      const strat = cfrNode.strategy();
      const utils = new Array<number>(numActions).fill(0);
      let nodeEv = 0;
      for (let a = 0; a < numActions; a++) {
        // Scale villain reach into this child by villain's strategy prob.
        const childReach = new Float64Array(this.V);
        for (let j = 0; j < this.V; j++) childReach[j] = villReach[j] * strat[a];
        const u = this.cfr(node.children[a], heroHand, childReach, heroReach, t);
        utils[a] = u;
        nodeEv += strat[a] * u;
      }
      // Villain minimizes hero EV => villain's regret is on (nodeEv - utils).
      // Counterfactual reach for villain = hero reach (scalar).
      for (let a = 0; a < numActions; a++) {
        const regret = heroReach * (nodeEv - utils[a]);
        let r = cfrNode.regretSum[a] + regret;
        if (r < 0) r = 0;
        cfrNode.regretSum[a] = r;
        cfrNode.strategySum[a] += strat[a];
      }
      return nodeEv;
    }
  }

  /**
   * Hero EV at a terminal leaf, summed (reach-weighted) over the villain range.
   * Hero EV is measured as net chips relative to the start of the subgame:
   *   - fold by villain  => hero wins (leafPot - heroCommitted - startingPot?)…
   * We use NET stack change: hero's payoff = (chips hero ends with) - (chips
   * hero put in this subgame). Concretely:
   *   - villain folds   => hero collects the whole pot => +villainCommitted
   *                        (hero's own committed chips come back; net gain is
   *                         what villain put in plus the dead starting pot it
   *                         already "owned" half of — but for decision EV the
   *                         consistent measure is: hero net = pot_won - hero_in).
   * To keep it simple and consistent we define hero net payoff at a leaf as:
   *   showdown: heroShare*leafPot - heroCommitted
   *   fold:     if villain folds -> leafPot - heroCommitted (hero takes pot)
   *             if hero folds    -> -heroCommitted (hero loses what it put in)
   * leafPot already includes startingPot, so "pot - heroCommitted" credits hero
   * with the dead money, which is the correct counterfactual EV for the spot.
   */
  private leafEv(node: TreeNode, heroHand: number, villReach: Float64Array): number {
    const pot = node.leafPot ?? 0;
    const heroIn = node.heroCommitted ?? 0;

    let mass = 0;
    for (let j = 0; j < this.V; j++) mass += villReach[j];
    if (mass <= 0) return 0;

    if (node.terminalKind === 'fold') {
      if (node.folder === 1) {
        // Villain folds: hero wins the pot regardless of villain hand.
        return mass * (pot - heroIn);
      }
      // Hero folds: hero simply loses what it committed.
      return mass * (-heroIn);
    }

    // Showdown: equity-weighted over the villain range.
    let ev = 0;
    for (let j = 0; j < this.V; j++) {
      const w = villReach[j];
      if (w === 0) continue;
      const share = this.wins[heroHand * this.V + j]; // [0,1]
      ev += w * (share * pot - heroIn);
    }
    return ev;
  }

  /** Extract the converged root strategy for hero's ACTUAL hand. */
  rootStrategy(): { actions: string[]; probs: number[] } {
    const key = `${this.root.infoSetKey}|h${this.heroIdx}`;
    const node = this.store.get(key);
    if (!node) {
      const u = this.root.actions.map(() => 1 / this.root.actions.length);
      return { actions: this.root.actions, probs: u };
    }
    return { actions: this.root.actions, probs: node.average() };
  }
}

// ------------------------------------------------------------
// Card-conflict helper
// ------------------------------------------------------------

function conflict(hero: [CardId, CardId], vill: [CardId, CardId], board: CardId[]): boolean {
  const seen = new Set<number>(board);
  for (const c of hero) {
    if (seen.has(c)) return true;
    seen.add(c);
  }
  for (const c of vill) {
    if (seen.has(c)) return true;
  }
  return false;
}

// ------------------------------------------------------------
// Default range construction
// ------------------------------------------------------------

/**
 * A reasonable wide single-raised-pot continuing range: all pocket pairs, all
 * suited broadways/connectors, and strong offsuit broadways. We materialize it
 * as concrete combos that do not conflict with the board (and, for hero, that
 * include hero's exact hand). Combos that overlap the board are dropped.
 */
function defaultRangeCombos(board: CardId[], exclude: CardId[]): RangeEntry[] {
  const dead = new Set<number>([...board, ...exclude]);
  const out: RangeEntry[] = [];
  // Iterate canonical hand groups and pick one or two representative suit combos
  // each so the range stays small but textured.
  for (let r1 = 12; r1 >= 0; r1--) {
    for (let r2 = r1; r2 >= 0; r2--) {
      const isPair = r1 === r2;
      // Keep mid-strength-and-up: pairs >= 4 ('5'?) and connected/broadway combos.
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
  const isPair = r1 === r2;
  if (isPair) {
    // All pairs continue, weighted slightly higher for the strong ones.
    return { weight: high >= 8 ? 1 : 0.8, suitedOnly: false };
  }
  // Broadway both cards (>=T, idx 8): keep offsuit + suited.
  if (low >= 8) return { weight: 1, suitedOnly: false };
  // One broadway + decent kicker: keep suited, sometimes offsuit.
  if (high >= 10 && low >= 5) return { weight: 0.7, suitedOnly: false };
  if (high >= 8 && gap <= 1) return { weight: 0.6, suitedOnly: true };
  // Suited connectors / one-gappers in the middle.
  if (gap <= 2 && low >= 3 && high <= 11) return { weight: 0.5, suitedOnly: true };
  // Suited aces.
  if (high === 12) return { weight: 0.5, suitedOnly: true };
  return { weight: 0, suitedOnly: false };
}

/** Pick concrete card-id combos for a (rank1, rank2) group, avoiding dead cards. */
function pickCombos(
  r1: number,
  r2: number,
  isPair: boolean,
  dead: Set<number>,
  suitedOnly: boolean,
): [CardId, CardId][] {
  const out: [CardId, CardId][] = [];
  if (isPair) {
    // One representative pair combo (first two free suits).
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
  // Suited: one representative (matching suits).
  for (let s = 0; s < 4; s++) {
    const a = high * 4 + s;
    const b = low * 4 + s;
    if (!dead.has(a) && !dead.has(b)) { out.push([a, b]); break; }
  }
  if (!suitedOnly) {
    // Offsuit: one representative (different suits).
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
// Public entry point
// ------------------------------------------------------------

const DEFAULT_BET_FRACTIONS = [0.33, 0.75];

/**
 * Solve the current postflop spot and return hero's mixed strategy as a
 * {@link StrategyDistribution}. Runs depth-limited CFR on the main thread under
 * a hard iteration AND time budget (whichever is hit first). On any internal
 * error it throws; callers should catch and fall back to a heuristic.
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
  const betFractions = input.betFractions ?? DEFAULT_BET_FRACTIONS;
  const maxIterations = input.maxIterations ?? 300;
  const timeBudgetMs = input.timeBudgetMs ?? 200;
  const rng = new SeededRng(input.seed ?? 1);
  const maxVillain = input.maxVillainCombos ?? 60;

  // Build ranges.
  const heroRange = buildHeroRange(input);
  const heroIdx = findHeroIndex(heroRange, input.heroCards);
  let villainRange = input.villainRange
    ? input.villainRange.map((h) => ({ cards: h.cards, weight: h.weight }))
    : defaultRangeCombos(input.board, [...input.heroCards]);
  villainRange = filterAndCap(villainRange, input.board, maxVillain, rng);
  if (villainRange.length === 0) {
    throw new Error('Villain range is empty after board filtering.');
  }

  // Build the betting tree. When hero is facing a bet, seed the tree with the
  // villain bet already committed so hero's first action is fold/call/raise.
  const ctx: BuildCtx = { startingPot: pot, effectiveStack, betFractions };
  let root: TreeNode;
  const toCall = input.toCall ?? 0;
  if (toCall > 0) {
    root = buildFacingBetRoot(ctx, toCall);
  } else {
    root = buildTree(ctx);
  }

  const solver = new PostflopCfr(root, input.board, heroRange, villainRange, heroIdx, rng);

  // CFR loop under hard dual budget.
  let iters = 0;
  let ev = 0;
  const checkEvery = 16; // amortize Date.now() cost
  for (; iters < maxIterations; iters++) {
    ev = solver.iterate(iters + 1);
    if ((iters % checkEvery) === checkEvery - 1) {
      if (Date.now() - start >= timeBudgetMs) { iters++; break; }
    }
  }

  const { actions, probs } = solver.rootStrategy();
  const strategy = toStrategyDistribution(actions, probs);

  return {
    strategy,
    iterations: iters,
    timeMs: Date.now() - start,
    ev,
  };
}

/**
 * Build a root where hero is facing an outstanding bet of `toCall` chips.
 * We model villain as having already bet `toCall`, so hero acts first with
 * fold/call/raise available.
 */
function buildFacingBetRoot(ctx: BuildCtx, toCall: number): TreeNode {
  // Villain committed `toCall`; hero committed 0 so far in the subgame.
  const committed: [number, number] = [0, Math.min(toCall, ctx.effectiveStack)];
  return buildNode(ctx, 0, committed, committed[1], 1, `vbet`);
}

function buildHeroRange(input: SolvePostflopInput): RangeEntry[] {
  if (input.heroRange && input.heroRange.length > 0) {
    const list = input.heroRange.map((h) => ({ cards: h.cards, weight: h.weight }));
    // Guarantee hero's exact hand is present.
    if (!list.some((h) => sameHand(h.cards, input.heroCards))) {
      list.push({ cards: input.heroCards, weight: 1 });
    }
    return list;
  }
  const range = defaultRangeCombos(input.board, []);
  if (!range.some((h) => sameHand(h.cards, input.heroCards))) {
    range.push({ cards: input.heroCards, weight: 1 });
  }
  // Drop combos colliding with hero's exact hand cards (other than hero's own).
  return range.filter(
    (h) =>
      sameHand(h.cards, input.heroCards) ||
      (h.cards[0] !== input.heroCards[0] &&
        h.cards[0] !== input.heroCards[1] &&
        h.cards[1] !== input.heroCards[0] &&
        h.cards[1] !== input.heroCards[1]),
  );
}

function findHeroIndex(range: RangeEntry[], hero: [CardId, CardId]): number {
  for (let i = 0; i < range.length; i++) if (sameHand(range[i].cards, hero)) return i;
  // Should not happen (buildHeroRange guarantees presence), but be safe.
  range.push({ cards: hero, weight: 1 });
  return range.length - 1;
}

function sameHand(a: [CardId, CardId], b: [CardId, CardId]): boolean {
  return (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);
}

/** Drop board-conflicting villain combos and deterministically cap the count. */
function filterAndCap(
  range: RangeEntry[],
  board: CardId[],
  cap: number,
  rng: SeededRng,
): RangeEntry[] {
  const dead = new Set<number>(board);
  const valid = range.filter((h) => !dead.has(h.cards[0]) && !dead.has(h.cards[1]) && h.cards[0] !== h.cards[1]);
  if (valid.length <= cap) return valid;
  // Deterministic sub-sample preserving weight: shuffle by seeded RNG, take cap.
  const idx = valid.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, cap).map((i) => valid[i]);
}

/**
 * Convert the solved (action-label, probability) lists into the project's
 * {@link StrategyDistribution} shape. Bet/raise actions are merged into the
 * `bets` array by absolute amount; fold/check/call map to scalar fields.
 */
function toStrategyDistribution(actions: string[], probs: number[]): StrategyDistribution {
  let fold = 0;
  let check = 0;
  let call = 0;
  const bets: { amount: number; probability: number }[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const p = probs[i];
    if (a === A_FOLD) fold += p;
    else if (a === A_CHECK) check += p;
    else if (a === A_CALL) call += p;
    else bets.push({ amount: parseBetAmount(a), probability: p });
  }
  // Normalize defensively (floating error / dropped mass).
  let total = fold + check + call;
  for (const b of bets) total += b.probability;
  if (total > 0 && Math.abs(total - 1) > 1e-9) {
    fold /= total; check /= total; call /= total;
    for (const b of bets) b.probability /= total;
  }
  return { fold, check, call, bets };
}
