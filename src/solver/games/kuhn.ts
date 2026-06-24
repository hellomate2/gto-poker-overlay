/**
 * Kuhn poker — the canonical toy poker game (Kuhn 1950).
 *
 * Rules (3-card, single bet):
 *   - Deck of 3 cards: Jack (0) < Queen (1) < King (2).
 *   - Each player antes 1 chip and is dealt one private card.
 *   - Player 0 acts first: check ("p" = pass) or bet ("b" = bet 1).
 *       - If P0 checks and P1 checks  -> showdown for the 2-chip pot.
 *       - If P0 checks and P1 bets    -> P0 may call ("b") or fold ("p").
 *       - If P0 bets   and P1 calls   -> showdown for the 4-chip pot.
 *       - If P0 bets   and P1 folds   -> P0 wins the 2-chip pot.
 *   - Showdown: higher card wins the pot.
 *
 * Utilities below are expressed as the *net* chip swing for a player (winnings
 * minus contributions), so the game is zero-sum.
 *
 * Known equilibrium facts used as test oracles:
 *   - Game value to player 0 is -1/18 ≈ -0.0556.
 *   - In equilibrium player 0 bets the Jack (bluff) with frequency in [0, 1/3].
 */
import { Game, Player, CHANCE } from '../game';

/** Action indices. PASS = check/fold, BET = bet/call. */
export const PASS = 0;
export const BET = 1;

export interface KuhnHistory {
  /** Cards dealt to [player0, player1]; -1 before dealing. */
  readonly cards: readonly [number, number];
  /** Betting actions taken so far, e.g. "", "p", "pb", "pbp". */
  readonly history: string;
}

/** The 6 equally-likely deals of distinct cards to the two players. */
const DEALS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1],
];

export class KuhnPoker implements Game<KuhnHistory> {
  root(): KuhnHistory {
    return { cards: [-1, -1], history: '' };
  }

  numPlayers(): number {
    return 2;
  }

  isChance(h: KuhnHistory): boolean {
    return h.cards[0] < 0;
  }

  chanceOutcomes(h: KuhnHistory): Array<{ next: KuhnHistory; prob: number }> {
    // The single chance event deals both private cards at once.
    return DEALS.map((deal) => ({
      next: { cards: deal, history: h.history },
      prob: 1 / DEALS.length,
    }));
  }

  currentPlayer(h: KuhnHistory): Player {
    if (this.isChance(h)) return CHANCE;
    // Player to act alternates with the length of the betting history.
    return h.history.length % 2;
  }

  isTerminal(h: KuhnHistory): boolean {
    const p = h.history;
    return p === 'pp' || p === 'bb' || p === 'bp' || p === 'pbp' || p === 'pbb';
  }

  utility(h: KuhnHistory, player: Player): number {
    const u = this.utilityP0(h);
    return player === 0 ? u : -u;
  }

  /** Net chips for player 0 at a terminal history. */
  private utilityP0(h: KuhnHistory): number {
    const p = h.history;
    const p0win = h.cards[0] > h.cards[1] ? 1 : -1;
    switch (p) {
      case 'pp':
        // Both checked: showdown for ante pot. Winner gains 1, loser loses 1.
        return p0win * 1;
      case 'bp':
        // P0 bet, P1 folded: P0 wins the antes.
        return 1;
      case 'pbp':
        // P0 checked, P1 bet, P0 folded: P1 wins the antes.
        return -1;
      case 'bb':
      case 'pbb':
        // A bet was called: showdown for the 2-chip-each pot.
        return p0win * 2;
      default:
        throw new Error(`utility() on non-terminal history "${p}"`);
    }
  }

  actions(_h: KuhnHistory): number[] {
    // Both PASS and BET are always legal at every Kuhn decision node.
    return [PASS, BET];
  }

  next(h: KuhnHistory, a: number): KuhnHistory {
    const symbol = a === PASS ? 'p' : 'b';
    return { cards: h.cards, history: h.history + symbol };
  }

  infoSetKey(h: KuhnHistory): string {
    // The acting player sees only their own card plus the public betting line.
    const player = h.history.length % 2;
    const card = h.cards[player];
    return `${card}:${h.history}`;
  }
}
