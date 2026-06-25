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
 *     player's category vs the opponent's. R_IP (in-position SB) ≈ 0.92,
 *     R_OOP (out-of-position BB) ≈ 0.85, further degraded by the stack-to-pot
 *     ratio left behind (deep flats realize less; see R computation below).
 *     When both are all-in (no money behind) R = 1 (equity realized exactly).
 *
 * Info sets: a player sees only their OWN category plus the public betting
 * history (not the opponent's category), exactly as in real play.
 */
import { Game, Player, CHANCE } from '../game';
import { NUM_CATEGORIES, comboWeight } from './categories';

/** Realization factors: imperfect postflop equity realization with money behind. */
export const R_IP = 0.92; // in position (the SB/button), base (low SPR)
export const R_OOP = 0.85; // out of position (the BB), base (low SPR)
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
export const SPR_PENALTY = 0.02;
export const SPR_CAP = 6; // beyond ~6:1 SPR the marginal penalty saturates
export const R_FLOOR = 0.66; // never realize below this share (you keep showdown equity)

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
}

const SB_POST = 0.5;
const BB_POST = 1.0;

// Action indices are positional and fixed per node type. The solver indexes
// regret/strategy vectors by these positions.
//
// SB_OPEN:        [FOLD, LIMP, OPEN, JAM]
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
    switch (h.node) {
      case Node.SB_OPEN:
        return allowOpenJam ? [0, 1, 2, 3] : [0, 1, 2]; // FOLD, LIMP, OPEN, (JAM)
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
        // [FOLD, LIMP, OPEN, JAM]
        if (a === 0) return this.foldTerminal(h, 0);
        if (a === 1) {
          // Limp: SB completes to 1bb.
          return {
            ...h,
            node: Node.BB_VS_LIMP,
            committed: [BB_POST, BB_POST],
            line: 'l',
          };
        }
        if (a === 2) {
          return {
            ...h,
            node: Node.BB_VS_OPEN,
            committed: [this.openSize, BB_POST],
            line: 'o',
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
      R = Math.max(R_FLOOR, base - SPR_PENALTY * Math.min(spr, SPR_CAP));
    }

    // Net EV = R * equity * pot - invested. Note: with R<1 the two players'
    // utilities are not exactly zero-sum (the realization "leak" models EV lost
    // to postflop play); this is intentional in the preflop model. Exploitability
    // is still well-defined as NashConv on this payoff.
    return R * eqP * pot - invested;
  }
}
