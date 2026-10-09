// ============================================================
// N-player (2-6 seat) No-Limit Hold'em simulation engine with side pots.
//
// Purpose: the heads-up engine (holdem.ts) cannot exercise multiway pots, which
// is exactly where the live bot has known weaknesses (one-villain equity, folded
// players counted as active). This engine plays full rings so those spots get
// measured, and it is also the engine underneath holdem.ts (playHand is a
// 2-seat wrapper over playRingHand), so HU and ring results come from the same
// betting/pot code.
//
// Fidelity to the live scraper (src/content-script/scraper.ts) matters because
// the bot reads GameState, not the sim's internals:
//   - players[] holds EVERY dealt seat in seat order, positions assigned with the
//     same template as scraper.assignPositions (BTN, SB, BB, UTG, MP, CO; HU is
//     SB(=button), BB). heroIndex / dealerIndex are seat indices.
//   - actionHistory uses the scraper's vocabulary: fold / check / call / bet /
//     raise. A first postflop wager is 'bet', anything over a live wager is
//     'raise' (the scraper never emits 'allin'; PokerNow logs a shove as
//     "bets X" / "raises to X"). Blind posts are not logged (the scraper skips
//     them). Folds stay in the history.
//   - minRaise is a raise-TO amount (what the scraper produces and what
//     engine.legalizeDecision reads), not an increment.
//   - Folded players stay in players[] with isSittingOut=false (they were dealt
//     in). Each Player also carries an extra `folded` boolean so an engine that
//     learns to read it (Player has no such field today) gets the truth; the
//     field is ignored by the current engine.
//
// Rules implemented:
//   - Blinds: HU the button posts the SB and acts first preflop / last postflop.
//     3+ handed SB = button+1, BB = button+2, UTG (button+3) opens preflop.
//     Postflop the first live seat left of the button acts first.
//   - A full raise reopens action for everyone. An all-in raise SHORT of a full
//     raise does not: players who already acted may only call or fold
//     (`canRaise=false` in their view; a raise request is coerced to a call).
//   - Side pots are layered by contribution level; each layer goes to the best
//     hand among non-folded seats that contributed to it. Uncalled chips form a
//     layer only their owner is eligible for, so they are returned.
//     Odd chips go to the first winner left of the button.
//
// Correctness: every hand asserts chip conservation (sum of stacks invariant)
// and that each pot layer is fully paid out. ringSelftest() runs these over
// thousands of random hands for every table size 2-6.
// ============================================================

import { GameState, Player, Position, Street, Action, ActionType, Card } from '../src/types/poker';
import { idToCard } from '../src/core/cfr/card-utils';
import { evaluateHand } from '../src/core/equity/hand-eval';

export interface SeatAgent {
  name: string;
  /** Decide an action given the live engine view for THIS seat. */
  act(view: SeatView): Promise<ActResult> | ActResult;
  /** Optional: called at hand end with net result (chips won/lost) for this seat. */
  onHandEnd?(net: number): void;
  /** Optional: called at hand end with the final GameState so the agent can
   *  record opponent stats (enables the bot's exploit adjuster). */
  observe?(finalState: GameState): void | Promise<void>;
  /** Optional: reset the agent's private RNG. Duplicate replays call this with
   *  the same seed so a scripted opponent makes the same random choices when it
   *  sees the same situation. */
  reseed?(seed: number): void;
}

/** What an agent sees on its turn (a superset of GameState plus convenience). */
export interface SeatView {
  state: GameState;       // full GameState as the scraper would produce, hero = this seat
  toCall: number;         // chips needed to call (0 if can check)
  canCheck: boolean;
  /** False when the only legal options are fold/call (an incomplete all-in raise
   *  did not reopen the betting for this seat). */
  canRaise: boolean;
  pot: number;            // total pot (all commitments this hand, incl. this street)
  street: Street;
  hole: [Card, Card];
  board: Card[];
  heroStack: number;      // remaining stack (behind)
  bb: number;
  seat: number;
  numPlayers: number;
  /** Seats that have not folded (includes this seat). */
  liveSeats: number;
}

export interface ActResult {
  action: ActionType;     // 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin'
  /** For bet/raise/allin: the TOTAL chips this seat will have committed THIS STREET
   *  after the action (a "raise-to" amount). Ignored for fold/check/call. */
  toAmount?: number;
}

export interface RingLoggedAction {
  seat: number;
  street: Street;
  /** 'bet' = first wager on a postflop street; 'raise' = any preflop raise or a
   *  wager over a live bet. Shoves are logged as bet/raise/call by what they did. */
  type: ActionType;
  voluntary: boolean;
  /** Raise-to amount for bet/raise, chips paid for call. */
  amount?: number;
  /** Global monotonic index across the whole hand. */
  order: number;
}

export interface RingHandLog {
  /** Net chip change per seat (sums to 0). */
  nets: number[];
  actions: RingLoggedAction[];
  /** True when two or more seats were still in at the end (cards were compared). */
  wentToShowdown: boolean;
  /** Seats that reached showdown (empty when the hand ended on a fold). */
  showdownSeats: number[];
  /** True when the seats still in at the end committed different amounts (a
   *  short all-in), i.e. the pot had to be split into a main pot + side pot(s). */
  sidePot: boolean;
  reachedStreet: Street;
  button: number;
  holes: [number, number][];
  board: number[];
  /** GameState snapshot at hand end (full actionHistory + positions), for
   *  opponent tracking via tracker.processHand. */
  finalState: GameState;
}

export interface RingConfig {
  bb: number;
  sb: number;
  startStackBB: number;   // every seat starts every hand with this many bb (cash, no drift)
  rng: () => number;      // used to shuffle when no deck is supplied
  /** Optional per-seat starting stacks in CHIPS, overriding startStackBB. Equal
   *  stacks never produce side pots, so the self-test uses uneven ones. */
  seatStacks?: number[];
}

// ---- deterministic RNG (mulberry32) so runs are reproducible per seed --------
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix integers into one 32-bit seed (for per-deal / per-replay seeding). */
export function mixSeed(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= p >>> 0; h = Math.imul(h, 0x01000193);
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  }
  return h >>> 0;
}

/** A freshly shuffled 52-card deck (card ids 0..51). */
export function shuffledDeck(rng: () => number): number[] {
  const d: number[] = [];
  for (let i = 0; i < 52; i++) d.push(i);
  for (let i = d.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/**
 * Position labels by seat, mirroring scraper.assignPositions(numPlayers, dealer):
 * offset 0 from the dealer is BTN (HU: SB), then SB, BB, UTG, MP, CO.
 */
export function ringPositions(numPlayers: number, button: number): Position[] {
  const templates: Record<number, Position[]> = {
    2: ['SB', 'BB'],
    3: ['BTN', 'SB', 'BB'],
    4: ['BTN', 'SB', 'BB', 'CO'],
    5: ['BTN', 'SB', 'BB', 'UTG', 'CO'],
    6: ['BTN', 'SB', 'BB', 'UTG', 'MP', 'CO'],
  };
  const t = templates[numPlayers];
  if (!t) throw new Error(`ringPositions: unsupported table size ${numPlayers}`);
  const out: Position[] = [];
  for (let i = 0; i < numPlayers; i++) out.push(t[(i - button + numPlayers) % numPlayers]);
  return out;
}

/** Blind seats and the first preflop actor for a table size and button. */
export function blindSeats(n: number, button: number): { sbSeat: number; bbSeat: number; firstPreflop: number } {
  if (n === 2) return { sbSeat: button, bbSeat: (button + 1) % 2, firstPreflop: button };
  return { sbSeat: (button + 1) % n, bbSeat: (button + 2) % n, firstPreflop: (button + 3) % n };
}

/**
 * Split the pot into contribution layers and pay each layer to the best hand
 * among non-folded seats that put chips into it.
 *
 * A layer between contribution levels [prev, L) holds, from every seat i,
 * min(c_i, L) - min(c_i, prev) chips. Only non-folded seats with c_i >= L can win
 * it. `strength[i]` is a comparable hand value (higher wins); it is only read for
 * eligible seats. Returns the chips paid to each seat.
 */
export function distributePot(
  contrib: number[], folded: boolean[], strength: number[], button: number,
): number[] {
  const n = contrib.length;
  const payout = new Array<number>(n).fill(0);
  const levels = [...new Set(contrib.filter(c => c > 0))].sort((a, b) => a - b);
  let prev = 0;
  for (const L of levels) {
    let layer = 0;
    for (let i = 0; i < n; i++) layer += Math.min(contrib[i], L) - Math.min(contrib[i], prev);
    const eligible: number[] = [];
    for (let i = 0; i < n; i++) if (!folded[i] && contrib[i] >= L) eligible.push(i);
    if (eligible.length === 0) {
      // Impossible in legal betting (the largest contributor can only have folded
      // to an even larger wager), so surface it as an engine bug.
      throw new Error(`distributePot: layer ${prev}..${L} has no eligible seat (contrib=${contrib} folded=${folded})`);
    }
    let best = -Infinity;
    for (const s of eligible) best = Math.max(best, strength[s]);
    const winners = eligible.filter(s => strength[s] === best);
    // Odd chips: one each to winners in seat order starting left of the button.
    winners.sort((a, b) => ((a - button - 1 + n) % n) - ((b - button - 1 + n) % n));
    const share = Math.floor(layer / winners.length);
    let rem = layer - share * winners.length;
    for (const w of winners) {
      payout[w] += share;
      if (rem > 0) { payout[w] += 1; rem--; }
    }
    prev = L;
  }
  return payout;
}

/**
 * Play ONE hand at an N-seat table (2 <= N <= 6). Stacks reset to startStack each
 * hand (independent-hand cash model). Pass `deck` (52 ids, already shuffled) to
 * replay an exact deal; otherwise cfg.rng shuffles. Seat i receives hole cards
 * deck[i] and deck[N + i]; the board is deck[2N .. 2N+4], so a deal is fully
 * determined by (deck, N) regardless of the betting.
 */
export async function playRingHand(
  agents: SeatAgent[],
  button: number,
  cfg: RingConfig,
  handNumber: number,
  deck?: number[],
): Promise<RingHandLog> {
  const n = agents.length;
  if (n < 2 || n > 6) throw new Error(`playRingHand: table size ${n} not in 2..6`);
  const { bb, sb, startStackBB } = cfg;
  if (cfg.seatStacks && cfg.seatStacks.length !== n) throw new Error('seatStacks length must equal the number of seats');
  const startStacks = cfg.seatStacks ? cfg.seatStacks.slice() : new Array<number>(n).fill(startStackBB * bb);
  const totalChips = startStacks.reduce((a, b) => a + b, 0);
  const d = deck ?? shuffledDeck(cfg.rng);

  const holes: [number, number][] = [];
  for (let i = 0; i < n; i++) holes.push([d[i], d[n + i]]);
  const fullBoard = d.slice(2 * n, 2 * n + 5);
  const boardIds: number[] = [];

  const stack = startStacks.slice();
  const committedHand = new Array<number>(n).fill(0);
  const committedStreet = new Array<number>(n).fill(0);
  const folded = new Array<boolean>(n).fill(false);
  const allIn = new Array<boolean>(n).fill(false);
  const positions = ringPositions(n, button);
  const { sbSeat, bbSeat, firstPreflop } = blindSeats(n, button);

  const actionHistory: Record<Street, Action[]> = { preflop: [], flop: [], turn: [], river: [] };
  const actions: RingLoggedAction[] = [];
  let orderCounter = 0;
  let street: Street = 'preflop';
  let reachedStreet: Street = 'preflop';
  let currentBet = 0;   // highest committed-this-street
  let minRaise = bb;    // minimum raise INCREMENT

  const potTotal = () => committedHand.reduce((a, b) => a + b, 0);
  const liveCount = () => folded.filter(f => !f).length;

  const pay = (s: number, amt: number) => {
    const a = Math.min(amt, stack[s]);
    stack[s] -= a; committedStreet[s] += a; committedHand[s] += a;
    if (stack[s] === 0) allIn[s] = true;
    return a;
  };

  pay(sbSeat, sb);
  pay(bbSeat, bb);
  currentBet = bb;

  function buildState(hero: number, final = false): GameState {
    const players: Player[] = [];
    for (let s = 0; s < n; s++) {
      const p: Player & { folded: boolean } = {
        name: agents[s].name,
        stack: stack[s],
        position: positions[s],
        isDealer: s === button,
        isSittingOut: false,
        seatIndex: s,
        isHero: !final && s === hero,
        currentBet: final ? 0 : committedStreet[s],
        hasActed: final,
        folded: folded[s],
      };
      players.push(p);
    }
    return {
      tableId: 'sim', handNumber, street: final ? reachedStreet : street,
      pot: potTotal(),
      sidePots: [],
      heroCards: final ? null : [idToCard(holes[hero][0]), idToCard(holes[hero][1])],
      communityCards: boardIds.map(idToCard),
      players,
      heroIndex: hero,
      dealerIndex: button,
      activePlayerIndex: hero,
      currentBet: final ? 0 : currentBet,
      // Raise-TO amount, matching the scraper (and engine.legalizeDecision).
      minRaise: final ? bb : currentBet + minRaise,
      bigBlind: bb, smallBlind: sb,
      actionHistory,
      isOurTurn: !final,
      timestamp: 0,
    };
  }

  const log = (s: number, type: ActionType, voluntary: boolean, amount?: number) => {
    actions.push({ seat: s, street, type, voluntary, amount, order: orderCounter++ });
    const histType: ActionType = type;
    actionHistory[street].push(amount !== undefined
      ? { type: histType, amount, playerName: agents[s].name }
      : { type: histType, playerName: agents[s].name });
  };

  /**
   * One betting round. `acted[s]` = s has acted since the last full raise;
   * `canRaise[s]` = s may still raise (false after an incomplete all-in raise
   * reached a seat that had already acted). The round closes when every seat
   * that can still act has acted and matched the current bet.
   */
  async function bettingRound(first: number): Promise<void> {
    const acted = new Array<boolean>(n).fill(false);
    const canRaise = new Array<boolean>(n).fill(true);
    const isActor = (s: number) => !folded[s] && !allIn[s];
    const needsToAct = (s: number) => isActor(s) && (!acted[s] || committedStreet[s] < currentBet);

    let p = first;
    let guard = 0;
    while (true) {
      if (liveCount() <= 1) return;
      const actors: number[] = [];
      for (let s = 0; s < n; s++) if (isActor(s)) actors.push(s);
      if (actors.length === 0) return;
      // Nobody left to bet against: a lone actor who has matched everything.
      if (actors.length === 1 && committedStreet[actors[0]] >= currentBet) return;
      if (!actors.some(needsToAct)) return;
      if (++guard > 1000) throw new Error(`betting round did not terminate (hand #${handNumber})`);

      while (!needsToAct(p)) p = (p + 1) % n;
      const s = p;
      p = (p + 1) % n;

      const toCall = Math.max(0, currentBet - committedStreet[s]);
      const canCheck = toCall === 0;
      const view: SeatView = {
        state: buildState(s),
        toCall, canCheck,
        canRaise: canRaise[s],
        pot: potTotal(),
        street,
        hole: [idToCard(holes[s][0]), idToCard(holes[s][1])],
        board: boardIds.map(idToCard),
        heroStack: stack[s],
        bb,
        seat: s,
        numPlayers: n,
        liveSeats: liveCount(),
      };

      let res: ActResult;
      try {
        res = await agents[s].act(view);
      } catch (e) {
        res = { action: canCheck ? 'check' : 'fold' };
        process.stderr.write(`[sim] agent ${agents[s].name} threw: ${(e as Error).message}\n`);
      }

      let type = res.action;
      // BB checking its option preflop is not a voluntary action.
      const voluntary = !(street === 'preflop' && s === bbSeat && type === 'check' && canCheck);

      // Normalize illegal actions.
      if (type === 'fold' && canCheck) type = 'check';            // never fold for free
      if (type === 'check' && !canCheck) type = 'call';           // can't check facing a bet
      if ((type === 'bet' || type === 'raise' || type === 'allin') && !canRaise[s]) {
        type = canCheck ? 'check' : 'call';                       // betting not reopened
      }

      if (type === 'fold') {
        folded[s] = true; acted[s] = true;
        log(s, 'fold', true);
        continue;
      }
      if (type === 'check') {
        acted[s] = true;
        log(s, 'check', voluntary);
        continue;
      }
      if (type === 'call') {
        const paid = pay(s, toCall);
        acted[s] = true;
        log(s, 'call', voluntary, paid);
        continue;
      }

      // bet / raise / allin -> a raise-TO target, clamped to legal bounds.
      const maxTo = committedStreet[s] + stack[s];
      let target: number;
      if (type === 'allin') target = maxTo;
      else {
        const req = res.toAmount;
        target = req === undefined || !Number.isFinite(req) ? (req === Infinity ? maxTo : currentBet + minRaise) : Math.round(req);
      }
      const minTo = currentBet + minRaise;
      if (target >= maxTo) target = maxTo;                         // all-in
      else if (target < minTo) target = Math.min(minTo, maxTo);    // floor to a legal raise

      if (target <= currentBet) {
        // Degenerate "raise" that doesn't exceed the live bet (e.g. a short stack
        // that can only call): treat as call / check.
        if (canCheck) { acted[s] = true; log(s, 'check', voluntary); continue; }
        const paid = pay(s, toCall);
        acted[s] = true;
        log(s, 'call', voluntary, paid);
        continue;
      }

      const increment = target - currentBet;
      const fullRaise = increment >= minRaise;
      pay(s, target - committedStreet[s]);
      const wasOpen = currentBet === 0;
      currentBet = target;
      acted[s] = true;
      if (fullRaise) {
        minRaise = increment;
        for (let o = 0; o < n; o++) if (o !== s) { acted[o] = false; canRaise[o] = true; }
      } else {
        // Incomplete all-in raise: seats that already acted may only call/fold.
        for (let o = 0; o < n; o++) if (o !== s && acted[o]) canRaise[o] = false;
      }
      // Scraper vocabulary: an opening postflop wager is a 'bet', else 'raise'.
      const histType: ActionType = street !== 'preflop' && wasOpen ? 'bet' : 'raise';
      log(s, histType, true, target);
    }
  }

  // ---- preflop ----
  await bettingRound(firstPreflop);

  const streets: [Street, number][] = [['flop', 3], ['turn', 1], ['river', 1]];
  for (const [next, k] of streets) {
    if (liveCount() <= 1) break;
    street = next; reachedStreet = next;
    for (let s = 0; s < n; s++) committedStreet[s] = 0;
    currentBet = 0; minRaise = bb;
    for (let j = 0; j < k; j++) boardIds.push(fullBoard[boardIds.length]);
    const actors = folded.filter((f, s) => !f && !allIn[s]).length;
    if (actors >= 2) await bettingRound((button + 1) % n);
    // else: at most one seat can still bet, so the board just runs out.
  }

  // ---- resolve ----
  const live: number[] = [];
  for (let s = 0; s < n; s++) if (!folded[s]) live.push(s);
  const strength = new Array<number>(n).fill(0);
  let wentToShowdown = false;
  if (live.length >= 2) {
    while (boardIds.length < 5) boardIds.push(fullBoard[boardIds.length]);
    wentToShowdown = true;
    for (const s of live) strength[s] = evaluateHand([holes[s][0], holes[s][1], ...boardIds]);
  }
  const pot = potTotal();
  const payout = distributePot(committedHand, folded, strength, button);
  const paidOut = payout.reduce((a, b) => a + b, 0);
  if (paidOut !== pot) throw new Error(`POT NOT DISTRIBUTED hand#${handNumber}: pot=${pot} paid=${paidOut}`);
  for (let s = 0; s < n; s++) stack[s] += payout[s];

  // ---- invariant: chips conserved ----
  const totalAfter = stack.reduce((a, b) => a + b, 0);
  if (totalAfter !== totalChips) {
    throw new Error(`CHIP LEAK hand#${handNumber}: after=${totalAfter} expected=${totalChips} stacks=${stack} committed=${committedHand}`);
  }
  if (stack.some(x => x < 0)) throw new Error(`NEGATIVE STACK hand#${handNumber}: ${stack}`);

  const nets = stack.map((x, s) => x - startStacks[s]);
  const finalState = buildState(0, true);
  finalState.pot = pot;
  for (let s = 0; s < n; s++) agents[s].onHandEnd?.(nets[s]);
  return {
    nets, actions, wentToShowdown,
    showdownSeats: wentToShowdown ? live : [],
    sidePot: live.length >= 2 && new Set(live.map(s => committedHand[s])).size > 1,
    reachedStreet, button, holes, board: boardIds.slice(), finalState,
  };
}
