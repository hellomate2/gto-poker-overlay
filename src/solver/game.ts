/**
 * Generic extensive-form game interface for the CFR algorithm family.
 *
 * The abstraction follows the standard formulation used in the CFR literature
 * (Zinkevich et al. 2007, "Regret Minimization in Games with Incomplete
 * Information"). A game is a tree of *histories*. Each non-terminal history is
 * either a *chance node* (nature acts according to a fixed distribution) or a
 * *decision node* belonging to one player. Players cannot distinguish histories
 * that share the same *information set* (info set), and must therefore use the
 * same strategy at all of them.
 *
 * Implementations are responsible only for describing the game's rules; the CFR
 * solvers operate purely against this interface and are completely
 * game-agnostic.
 */

/** Player identifier. Two-player zero-sum games use 0 and 1. */
export type Player = number;

/** Sentinel player id for chance ("nature") nodes. */
export const CHANCE: Player = -1;

/**
 * A node in the game tree. `H` is the concrete history type chosen by the
 * implementing game (e.g. a struct describing dealt cards and the action
 * sequence). Histories are treated as immutable values by the solvers.
 */
export interface Game<H> {
  /** The initial (root) history of the game. */
  root(): H;

  /** True if `h` is a terminal history (no further actions). */
  isTerminal(h: H): boolean;

  /**
   * Utility to player `player` at a terminal history, in chips (or whatever
   * unit the game defines). For two-player zero-sum games,
   * `utility(h, 0) === -utility(h, 1)`.
   */
  utility(h: H, player: Player): number;

  /** True if `h` is a chance node (nature to act). */
  isChance(h: H): boolean;

  /**
   * The outcomes available at a chance node, as (next-history, probability)
   * pairs. Probabilities must sum to 1. Only called when `isChance(h)`.
   */
  chanceOutcomes(h: H): Array<{ next: H; prob: number }>;

  /** The player to act at a non-terminal, non-chance history. */
  currentPlayer(h: H): Player;

  /**
   * The legal actions at `h`, as opaque action indices. The CFR solvers index
   * regret/strategy vectors positionally, so the returned order must be
   * deterministic for a given information set.
   */
  actions(h: H): number[];

  /** Applies action `a` to history `h`, returning the resulting history. */
  next(h: H, a: number): H;

  /**
   * A string key uniquely identifying the information set that `h` belongs to,
   * from the perspective of the player to act. Two histories return the same
   * key iff the acting player cannot tell them apart.
   */
  infoSetKey(h: H): string;

  /** Number of players (2 for the benchmark games). */
  numPlayers(): number;
}
