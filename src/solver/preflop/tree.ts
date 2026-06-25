/**
 * Heads-up No-Limit Hold'em PREFLOP game tree for CFR.
 *
 * This implements the standard "preflop model" used to solve preflop
 * equilibria: a range-vs-range (category-vs-category) CFR over a capped
 * preflop betting abstraction whose leaves are valued with the all-in equity
 * matrix plus realization factors that model imperfect equity realization
 * postflop. It is EXACT for all-in / push-fold situations and a strong
 * approximation for deeper spots that end without an all-in (see README).
 *
 * Players / positions (heads-up):
 *   - P0 = Button = Small Blind. Posts the SB, acts FIRST preflop, and is IN
 *     POSITION postflop (acts last on later streets).
 *   - P1 = Big Blind. Posts the BB, acts LAST preflop, OUT OF POSITION postflop.
 *
 * Betting abstraction (sizes in big blinds, parameterized stack `S`):
 *   SB first action:   fold | limp(call to 1bb) | open(2.5bb) | jam(all-in)
 *   BB vs limp:        check | raise(3.5bb) | jam
 *   BB vs open:        fold | call | 3bet(3x = 7.5bb) | jam
 *   SB vs BB-raise/3bet: fold | call | 4bet(2.2x) | jam
 *   BB vs 4bet:        fold | call | jam
 *   vs jam:            fold | call
 *   After a non-aggressive close (call/check that closes the round) -> showdown.
 *
 * The tree is capped at the jam level on each line (open -> 3bet -> 4bet ->
 * jam, with limp -> raise -> jam), which covers essentially all preflop
 * equilibrium play; further re-raises off these sizes have negligible
 * frequency.
 *
 * Leaf valuation (chips are big blinds; utilities are net BB to the player):
 *   - fold: the folder forfeits what they have committed; the other player
 *     wins the pot (their own committed money back plus the folder's commit).
 *   - showdown after a non-all-in close: EV uses a realization factor R to
 *     model that equity is not perfectly realized postflop with stacks behind.
 *     EV(player) = R * equity * finalPot - invested, where finalPot is the
 *     total pot (sum of both commits) and `equity` is the all-in equity of the
 *     player's category vs the opponent's. R_IP (in-position SB) ≈ 0.99,
 *     R_OOP (out-of-position BB) ≈ 0.76, further degraded by the stack-to-pot
 *     ratio left behind (deep flats realize less; see R computation below), and
 *     boosted by a suited/connected playability bonus (nut potential the
 *     all-in-equity leaf can't see). These widths reproduce real heads-up 100bb
 *     GTO: the button opens ~80-88% and the BB defends ~70%+ vs a small open.
 *     When both are all-in (no money behind) R = 1 (equity realized exactly).
 *
 * Info sets: a player sees only their OWN category plus the public betting
 * history (not the opponent's category), exactly as in real play.
 */
import { Game, Player, CHANCE } from '../game';
import { NUM_CATEGORIES, comboWeight, categories } from './categories';

/** Realization factors: imperfect postflop equity realization with money behind.
 *
 * Heads-up postflop equity realization is HIGH: with only one opponent and a
 * positional/initiative edge, even marginal hands realize close to their raw
 * all-in equity. The earlier values (0.92 / 0.85) were too pessimistic and made
 * speculative suited/offsuit-broadway hands look unprofitable, collapsing the SB
 * open to ~66% and the BB defense to ~60% — far tighter than real HU 100bb GTO
 * (button opens ~80-88%, BB defends ~70%+). Raised to realistic HU widths. */
export const R_IP = 0.99; // in position (the SB/button), base (low SPR)
export const R_OOP = 0.76; // out of position (the BB), base (low SPR)
/** Both all-in: equity realized exactly. */
export const R_ALLIN = 1.0;

/**
 * SPR penalty: how much realization degrades per unit of stack-to-pot ratio
 * left behind after a non-all-in showdown. Deeper effective stacks mean more
 * postflop maneuvering and worse equity realization for marginal hands (this is
 * the reverse-implied-odds of flatting deep, especially out of position). The
 * effective factor is `R_base - SPR_PENALTY * min(SPR, SPR_CAP)`, floored at
 * `R_FLOOR`. This is a model parameter (documented in README), not a hand-tuned
 * range: it makes deep flat-calls correctly tighter without touching any ranges.
 */
export const SPR_PENALTY = 0.004; // gentle: deep flats realize only slightly less
export const SPR_CAP = 6; // beyond ~6:1 SPR the marginal penalty saturates
export const R_FLOOR = 0.55; // never realize below this share (kept low so the
// position factor R_OOP is the binding control of OOP realization rather than
// the floor; a high floor previously clamped R_OOP and made the BB defend far
// too wide, which in turn suppressed the SB open width).

/**
 * Playability bonus to realization for SUITED and CONNECTED hands.
 *
 * The leaves value a category by its raw all-in (showdown) equity. But two
 * hands with the same showdown equity do NOT realize it equally postflop:
 * suited and connected hands make flushes/straights — nutted, low-reverse-
 * implied-odds holdings that can stack an opponent and that barrel profitably —
 * so they realize MORE than their all-in equity, while a same-equity offsuit
 * unconnected holding realizes less. An all-in-equity model is blind to this
 * (it only sees who-wins-at-showdown), which is exactly why pure all-in-equity
 * leaves fold small suited connectors (53s, 64s, suited gappers) and suited
 * kings that real heads-up GTO opens. We add a small, principled per-category
 * realization bonus for suitedness and connectedness (capped), applied on top
 * of the position/SPR factor. This is a model term (a function of the hand's
 * structure), NOT a hand-tuned range edit.
 */
export const SUITED_BONUS = 0.08; // suited realizes more (flush nut potential)
export const CONNECTOR_BONUS = 0.06; // 0-gap connectors realize more (straights)
export const ONE_GAP_BONUS = 0.035; // 1-gappers a bit more
export const TWO_GAP_BONUS = 0.02; // 2-gappers a touch more
export const R_CEIL = 1.0; // realization is never rewarded above 1.0
/**
 * Share of the suited/connected playability bonus that the OUT-OF-POSITION
 * player gets (the in-position player gets the full bonus). Implied-odds and
 * semi-bluff realization need position + initiative; OOP you realize much less
 * of a small-suited-connector's nut potential. Keeping this well below 1
 * widens the (in-position) SB open with speculative suited hands without
 * equally widening the OOP BB's defense of the same hands.
 */
export const IP_PLAYABILITY_OOP_SHARE = 0.35;

/** Rank value 2..14 (T=10, J=11, Q=12, K=13, A=14). */
const RANK_VAL: Record<string, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

/**
 * Per-category additive realization bonus, computed once from the hand name.
 * Pairs get 0 (they don't gain from suitedness/straights the same way). Suited
 * hands get SUITED_BONUS; connectors/one-gappers (suited or offsuit) get a
 * straight bonus on top. Wheel-friendly low aces and connectors are included
 * naturally because the gap, not the rank, drives it.
 */
function buildPlayabilityBonus(): number[] {
  const out = new Array<number>(NUM_CATEGORIES).fill(0);
  for (const c of categories()) {
    if (c.kind === 'pair') continue; // pairs: no suited/straight realization edge
    const r1 = RANK_VAL[c.name[0]];
    const r2 = RANK_VAL[c.name[1]];
    const gap = Math.abs(r1 - r2) - 1; // 0 = connector (e.g. 54), 1 = one-gap
    let bonus = 0;
    if (c.kind === 'suited') bonus += SUITED_BONUS;
    if (gap === 0) bonus += CONNECTOR_BONUS;
    else if (gap === 1) bonus += ONE_GAP_BONUS;
    else if (gap === 2) bonus += TWO_GAP_BONUS;
    out[c.index] = bonus;
  }
  return out;
}

let _playabilityBonus: number[] | null = null;
function playabilityBonus(index: number): number {
  if (!_playabilityBonus) _playabilityBonus = buildPlayabilityBonus();
  return _playabilityBonus[index];
}

/** Node kinds in the betting tree (who acts / what they face). */
export enum Node {
  /** Chance root: deal categories to both players. */
  DEAL = 'DEAL',
  /** SB to act first (open decision). */
  SB_OPEN = 'SB_OPEN',
  /** BB faces a limp (SB completed to 1bb). */
  BB_VS_LIMP = 'BB_VS_LIMP',
  /** BB faces an SB open-raise. */
  BB_VS_OPEN = 'BB_VS_OPEN',
  /** SB faces a BB raise after limping (limp-raise line). */
  SB_VS_BBRAISE = 'SB_VS_BBRAISE',
  /** SB faces a BB 3-bet (after SB opened). */
  SB_VS_3BET = 'SB_VS_3BET',
  /** BB faces an SB 4-bet. */
  BB_VS_4BET = 'BB_VS_4BET',
  /** A player faces an all-in jam: call or fold. */
  VS_JAM = 'VS_JAM',
  /** Terminal. */
  TERMINAL = 'TERMINAL',
}

/** How a terminal was reached, for leaf valuation. */
export enum TermKind {
  /** P `folder` folded. */
  FOLD = 'FOLD',
  /** Showdown with money behind (use realization factors). */
  SHOWDOWN = 'SHOWDOWN',
  /** Both all-in (R = 1). */
  ALLIN_SHOWDOWN = 'ALLIN_SHOWDOWN',
}

export interface PreflopHistory {
  node: Node;
  /** P0 (SB) category index, -1 until dealt. */
  catSB: number;
  /** P1 (BB) category index, -1 until dealt. */
  catBB: number;
  /** Chips committed by each player so far, in BB. [SB, BB]. */
  committed: [number, number];
  /** Compact public betting line, e.g. "o" (open), "o3" (open,3bet). */
  line: string;
  /** Terminal bookkeeping. */
  term?: { kind: TermKind; folder?: Player; ipPlayer?: Player };
}

export interface TreeParams {
  /** Effective stack in BB (each player starts with this much). */
  stack: number;
  /** SB open size in BB. */
  openSize?: number;
  /** BB raise-vs-limp size in BB. */
  limpRaiseSize?: number;
  /** BB 3-bet multiple of the open (× open size). */
  threeBetMult?: number;
  /** SB 4-bet multiple of the 3-bet (× 3-bet size). */
  fourBetMult?: number;
  /** Realization factor for the in-position player. */
  rIp?: number;
  /** Realization factor for the out-of-position player. */
  rOop?: number;
  /** Floor on the realized share after SPR degradation (default R_FLOOR). */
  rFloor?: number;
  /** Global multiplier on the suited/connected playability bonus (default 1). */
  playabilityScale?: number;
  /**
   * Max effective stack (bb) at which a non-committing JAM is a legal action at
   * the OPEN / RE-RAISE-OVER-AN-OPEN nodes — i.e. the first-in open (SB_OPEN),
   * the BB defending an open (BB_VS_OPEN), the SB facing a 3-bet (SB_VS_3BET),
   * and the limp-raise lines (BB_VS_LIMP, SB_VS_BBRAISE). Above this depth,
   * jamming 100bb over an open/3-bet is degenerate: the equity-model leaf gives
   * an all-in R=1 (full equity realization), which over-rewards shoving premiums
   * versus 3-betting/4-betting to a size and playing it out (R<1). So the jam is
   * removed from the abstraction at these nodes when deep, and premiums are
   * forced to 3-bet/4-bet to a size instead of open-shoving.
   *
   * A jam is ALWAYS legal as the 5-bet response when FACING A 4-BET
   * (BB_VS_4BET) and at the call-vs-jam nodes (VS_JAM), because by then the pot
   * is huge and a jam is a normal, committed size. Short-stack open/3-bet jams
   * are served separately by the exact push/fold Nash layer
   * (core/ranges/pushfold-nash.ts), so the deep solve does not need them.
   *
   * Default 25bb: at/under this depth the solve may include open/3-bet jams (so
   * a short run still behaves), but the committed 100bb charts never jam premiums
   * over opens/3-bets.
   */
  openJamMaxBB?: number;
  /**
   * Max effective stack (bb) at which LIMPING (the SB completing to 1bb instead
   * of open-raising) is a legal first-in action. Deep heads-up 100bb GTO is
   * essentially a raise-or-fold button game: the equity model over-values the
   * limp (it traps the BB's entire weak check-back range in a tiny pot, which
   * looks profitable per-equity but forgoes building the pot with the button's
   * edge and the fold equity of a raise). Left ungated, even AA/KK "prefer" to
   * limp ~90% — clearly wrong advice. So the limp is removed from the deep
   * abstraction (above this depth), making the SB open-or-fold; the limp-raise
   * lines then become off-path and their charts reuse the closest solved node.
   * Default 25bb: short solves still model the limp; the committed 100bb charts
   * never limp.
   */
  limpMaxBB?: number;
}

const SB_POST = 0.5;
const BB_POST = 1.0;

// Action indices are positional and fixed per node type. The solver indexes
// regret/strategy vectors by these positions.
//
// SB_OPEN:        [FOLD, OPEN, LIMP, JAM]   (OPEN before LIMP so both LIMP and
//                 the open-JAM are *trailing* actions that can be gated out deep;
//                 deep -> [FOLD, OPEN] = a clean raise-or-fold button.)
// BB_VS_LIMP:     [CHECK, RAISE, JAM]
// BB_VS_OPEN:     [FOLD, CALL, THREEBET, JAM]
// SB_VS_BBRAISE:  [FOLD, CALL, FOURBET, JAM]   (limp-raise line; "4bet"≈reraise)
// SB_VS_3BET:     [FOLD, CALL, FOURBET, JAM]
// BB_VS_4BET:     [FOLD, CALL, JAM]
// VS_JAM:         [FOLD, CALL]

export class PreflopGame implements Game<PreflopHistory> {
  readonly stack: number;
  private readonly openSize: number;
  private readonly limpRaiseSize: number;
  private readonly threeBetSize: number;
  private readonly rIp: number;
  private readonly rOop: number;
  private readonly fourBetMult: number;
  private readonly threeBetMult: number;
  private readonly openJamMaxBB: number;
  private readonly limpMaxBB: number;
  private readonly rFloor: number;
  private readonly playabilityScale: number;
  private readonly equity: number[][];
  private _chanceCache: Array<{ next: PreflopHistory; prob: number }> | null = null;

  constructor(equity: number[][], params: TreeParams) {
    this.equity = equity;
    this.stack = params.stack;
    this.openSize = Math.min(params.openSize ?? 2.5, params.stack);
    this.limpRaiseSize = Math.min(params.limpRaiseSize ?? 3.5, params.stack);
    this.threeBetMult = params.threeBetMult ?? 3.0;
    this.fourBetMult = params.fourBetMult ?? 2.2;
    this.threeBetSize = Math.min(this.openSize * this.threeBetMult, params.stack);
    this.rIp = params.rIp ?? R_IP;
    this.rOop = params.rOop ?? R_OOP;
    this.openJamMaxBB = params.openJamMaxBB ?? 25;
    this.limpMaxBB = params.limpMaxBB ?? 25;
    this.rFloor = params.rFloor ?? R_FLOOR;
    this.playabilityScale = params.playabilityScale ?? 1;
  }

  numPlayers(): number {
    return 2;
  }

  root(): PreflopHistory {
    return {
      node: Node.DEAL,
      catSB: -1,
      catBB: -1,
      committed: [SB_POST, BB_POST],
      line: '',
    };
  }

  isChance(h: PreflopHistory): boolean {
    return h.node === Node.DEAL;
  }

  isTerminal(h: PreflopHistory): boolean {
    return h.node === Node.TERMINAL;
  }

  currentPlayer(h: PreflopHistory): Player {
    switch (h.node) {
      case Node.SB_OPEN:
      case Node.SB_VS_BBRAISE:
      case Node.SB_VS_3BET:
        return 0; // SB
      case Node.BB_VS_LIMP:
      case Node.BB_VS_OPEN:
      case Node.BB_VS_4BET:
        return 1; // BB
      case Node.VS_JAM:
        // The player facing the jam is the one who is NOT all-in. The jammer
        // is encoded by whose committed == stack; the other acts.
        return h.committed[0] >= this.stack - 1e-9 ? 1 : 0;
      default:
        return CHANCE;
    }
  }

  /**
   * Chance root: deal an (SB category, BB category) pair. Probability is the
   * combo-weighted joint frequency. Card removal between the two categories is
   * ignored at the deal level (combo counts use the unconditional 6/4/12) — a
   * standard, negligible approximation for preflop range modeling; the equity
   * leaves themselves already account for card removal on the board.
   */
  chanceOutcomes(h: PreflopHistory): Array<{ next: PreflopHistory; prob: number }> {
    if (this._chanceCache) return this._chanceCache;
    const out: Array<{ next: PreflopHistory; prob: number }> = [];
    // Total weight = sum_i sum_j w_i * w_j = (sum w)^2.
    let totalW = 0;
    for (let i = 0; i < NUM_CATEGORIES; i++) totalW += comboWeight(i);
    const denom = totalW * totalW;
    for (let i = 0; i < NUM_CATEGORIES; i++) {
      const wi = comboWeight(i);
      for (let j = 0; j < NUM_CATEGORIES; j++) {
        const wj = comboWeight(j);
        out.push({
          prob: (wi * wj) / denom,
          next: { ...h, node: Node.SB_OPEN, catSB: i, catBB: j },
        });
      }
    }
    this._chanceCache = out;
    return out;
  }

  infoSetKey(h: PreflopHistory): string {
    const player = this.currentPlayer(h);
    const cat = player === 0 ? h.catSB : h.catBB;
    return `${player}|${cat}|${h.node}|${h.line}`;
  }

  actions(h: PreflopHistory): number[] {
    // A JAM at an OPEN / RE-RAISE-OVER-AN-OPEN node (the first-in open, the BB
    // defending an open, the SB facing a 3-bet, and the limp-raise lines) is
    // only a sane abstraction action when stacks are shallow enough that jamming
    // is in the ballpark of a normal raise. Deep (e.g. 100bb), jamming over an
    // open/3-bet is degenerate and the equity-model leaves would over-reward it
    // (a jam realizes 100% of equity while a sized raise that gets played out
    // realizes < 1), so premiums would wrongly prefer to open-shove. We gate
    // those jams behind a stack threshold. The JAM facing a 4-bet (the 5-bet
    // response, BB_VS_4BET) and the call-vs-jam nodes (VS_JAM) are ALWAYS legal,
    // because by then the pot has grown and a jam is a normal committed size.
    // Short-stack open/3-bet jams are served by the exact push/fold Nash layer.
    const allowOpenJam = this.stack <= this.openJamMaxBB;
    const allowLimp = this.stack <= this.limpMaxBB;
    switch (h.node) {
      case Node.SB_OPEN:
        // [FOLD, OPEN, LIMP, JAM]; LIMP and JAM are trailing and gated deep.
        // Deep (100bb) -> [FOLD, OPEN] = raise-or-fold button.
        if (allowLimp && allowOpenJam) return [0, 1, 2, 3];
        if (allowLimp) return [0, 1, 2]; // FOLD, OPEN, LIMP
        if (allowOpenJam) return [0, 1, 3]; // FOLD, OPEN, JAM (limp gated, jam ok)
        return [0, 1]; // FOLD, OPEN
      case Node.BB_VS_LIMP:
        return allowOpenJam ? [0, 1, 2] : [0, 1]; // CHECK, RAISE, (JAM)
      case Node.BB_VS_OPEN:
        return allowOpenJam ? [0, 1, 2, 3] : [0, 1, 2]; // FOLD, CALL, THREEBET, (JAM)
      case Node.SB_VS_BBRAISE:
      case Node.SB_VS_3BET:
        return allowOpenJam ? [0, 1, 2, 3] : [0, 1, 2]; // FOLD, CALL, FOURBET, (JAM)
      case Node.BB_VS_4BET:
        return [0, 1, 2]; // FOLD, CALL, JAM (5-bet jam facing a 4-bet — always legal)
      case Node.VS_JAM:
        return [0, 1]; // FOLD, CALL
      default:
        return [];
    }
  }

  next(h: PreflopHistory, a: number): PreflopHistory {
    const S = this.stack;
    switch (h.node) {
      case Node.SB_OPEN: {
        // [FOLD, OPEN, LIMP, JAM]
        if (a === 0) return this.foldTerminal(h, 0);
        if (a === 1) {
          // Open-raise to openSize.
          return {
            ...h,
            node: Node.BB_VS_OPEN,
            committed: [this.openSize, BB_POST],
            line: 'o',
          };
        }
        if (a === 2) {
          // Limp: SB completes to 1bb.
          return {
            ...h,
            node: Node.BB_VS_LIMP,
            committed: [BB_POST, BB_POST],
            line: 'l',
          };
        }
        // JAM
        return {
          ...h,
          node: Node.VS_JAM,
          committed: [S, BB_POST],
          line: 'J',
        };
      }

      case Node.BB_VS_LIMP: {
        // [CHECK, RAISE, JAM]
        if (a === 0) {
          // Check: limped pot goes to showdown, both committed 1bb. IP = SB.
          return this.showdownTerminal(h, [BB_POST, BB_POST], 0, false);
        }
        if (a === 1) {
          return {
            ...h,
            node: Node.SB_VS_BBRAISE,
            committed: [BB_POST, this.limpRaiseSize],
            line: 'lr',
          };
        }
        // JAM
        return {
          ...h,
          node: Node.VS_JAM,
          committed: [BB_POST, S],
          line: 'lJ',
        };
      }

      case Node.BB_VS_OPEN: {
        // [FOLD, CALL, THREEBET, JAM]
        if (a === 0) return this.foldTerminal(h, 1);
        if (a === 1) {
          // Call: both at open size -> showdown, IP = SB.
          return this.showdownTerminal(h, [this.openSize, this.openSize], 0, false);
        }
        if (a === 2) {
          return {
            ...h,
            node: Node.SB_VS_3BET,
            committed: [this.openSize, this.threeBetSize],
            line: 'o3',
          };
        }
        // JAM
        return {
          ...h,
          node: Node.VS_JAM,
          committed: [this.openSize, S],
          line: 'oJ',
        };
      }

      case Node.SB_VS_BBRAISE: {
        // [FOLD, CALL, RERAISE(4bet-like), JAM] — limp-raise line.
        if (a === 0) return this.foldTerminal(h, 0);
        if (a === 1) {
          const amt = this.limpRaiseSize;
          return this.showdownTerminal(h, [amt, amt], 0, false);
        }
        if (a === 2) {
          const reraise = Math.min(this.limpRaiseSize * this.fourBetMult, S);
          return {
            ...h,
            node: Node.BB_VS_4BET,
            committed: [reraise, this.limpRaiseSize],
            line: 'lr4',
          };
        }
        // JAM
        return {
          ...h,
          node: Node.VS_JAM,
          committed: [S, this.limpRaiseSize],
          line: 'lrJ',
        };
      }

      case Node.SB_VS_3BET: {
        // [FOLD, CALL, FOURBET, JAM]
        if (a === 0) return this.foldTerminal(h, 0);
        if (a === 1) {
          const amt = this.threeBetSize;
          return this.showdownTerminal(h, [amt, amt], 0, false);
        }
        if (a === 2) {
          const fourBet = Math.min(this.threeBetSize * this.fourBetMult, S);
          return {
            ...h,
            node: Node.BB_VS_4BET,
            committed: [fourBet, this.threeBetSize],
            line: 'o34',
          };
        }
        // JAM
        return {
          ...h,
          node: Node.VS_JAM,
          committed: [S, this.threeBetSize],
          line: 'o3J',
        };
      }

      case Node.BB_VS_4BET: {
        // [FOLD, CALL, JAM]
        if (a === 0) return this.foldTerminal(h, 1);
        if (a === 1) {
          const amt = h.committed[0]; // call the 4-bet size
          return this.showdownTerminal(h, [amt, amt], 0, false);
        }
        // JAM
        return {
          ...h,
          node: Node.VS_JAM,
          committed: [h.committed[0], S],
          line: h.line + 'J',
        };
      }

      case Node.VS_JAM: {
        // [FOLD, CALL]
        const jammer = h.committed[0] >= S - 1e-9 ? 0 : 1;
        const caller: Player = jammer === 0 ? 1 : 0;
        if (a === 0) return this.foldTerminal(h, caller);
        // Call the jam: both all-in for the full stack (caller matches).
        const both: [number, number] = [S, S];
        // IP for an all-in showdown is irrelevant (R=1) but set SB as IP.
        return this.showdownTerminal(h, both, 0, true);
      }

      default:
        return h;
    }
  }

  private foldTerminal(h: PreflopHistory, folder: Player): PreflopHistory {
    return {
      ...h,
      node: Node.TERMINAL,
      term: { kind: TermKind.FOLD, folder },
    };
  }

  private showdownTerminal(
    h: PreflopHistory,
    committed: [number, number],
    ipPlayer: Player,
    allIn: boolean,
  ): PreflopHistory {
    return {
      ...h,
      node: Node.TERMINAL,
      committed,
      term: {
        kind: allIn ? TermKind.ALLIN_SHOWDOWN : TermKind.SHOWDOWN,
        ipPlayer,
      },
    };
  }

  utility(h: PreflopHistory, player: Player): number {
    const term = h.term!;
    const other: Player = player === 0 ? 1 : 0;
    const invested = h.committed[player];

    if (term.kind === TermKind.FOLD) {
      // Folder loses their commit; the other wins the pot (gains opp's commit).
      if (term.folder === player) return -h.committed[player];
      return h.committed[other];
    }

    // Showdown: equity of player's category vs opponent's.
    const eqP = this.equity[
      player === 0 ? h.catSB : h.catBB
    ][player === 0 ? h.catBB : h.catSB];
    const pot = h.committed[0] + h.committed[1];

    let R: number;
    if (term.kind === TermKind.ALLIN_SHOWDOWN) {
      R = R_ALLIN;
    } else {
      // In-position player realizes more equity.
      const ip = term.ipPlayer ?? 0;
      const base = player === ip ? this.rIp : this.rOop;
      // SPR-aware degradation: the deeper the effective stack left behind
      // relative to the pot, the less of the raw all-in equity is realized
      // (reverse implied odds of flatting deep). behind/pot is the stack-to-pot
      // ratio after the call. All-in lines (behind ~ 0) keep the base factor.
      const behind = Math.max(0, this.stack - invested);
      const spr = pot > 0 ? behind / pot : 0;
      // Suited/connected hands realize MORE than their raw all-in equity (nut
      // flush/straight potential the showdown-equity leaf can't see). The bonus
      // grows with the money behind (more board to hit, more to win), so it is
      // scaled by the same SPR factor and vanishes when all-in. Crucially the
      // playability edge is much larger IN POSITION (you realize implied odds
      // with the betting lead and last action) than OUT OF POSITION, so it is
      // weighted by position. This asymmetry is what actually widens the SB
      // OPEN with small suited connectors / suited kings (53s, 64s, K2s) without
      // simultaneously inflating the OOP BB's defense of the same junk — a pure
      // all-in-equity leaf folds these, and a symmetric bonus is a wash.
      const ipWeight = player === ip ? 1.0 : IP_PLAYABILITY_OOP_SHARE;
      const myCat = player === 0 ? h.catSB : h.catBB;
      const playBonus =
        playabilityBonus(myCat) *
        this.playabilityScale *
        ipWeight *
        (Math.min(spr, SPR_CAP) / SPR_CAP);
      R = Math.max(
        this.rFloor,
        Math.min(R_CEIL, base - SPR_PENALTY * Math.min(spr, SPR_CAP) + playBonus),
      );
    }

    // Net EV = R * equity * pot - invested. Note: with R<1 the two players'
    // utilities are not exactly zero-sum (the realization "leak" models EV lost
    // to postflop play); this is intentional in the preflop model. Exploitability
    // is still well-defined as NashConv on this payoff.
    return R * eqP * pot - invested;
  }
}
