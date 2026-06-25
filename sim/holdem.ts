// ============================================================
// Heads-Up No-Limit Hold'em simulation engine.
//
// Purpose: drive the real DecisionEngine.decide() (the shipped bot) against
// scripted opponent archetypes over many hands, so we can measure the bot's
// ACTUAL action frequencies and win-rate (bb/100) and find strategic leaks.
//
// Correctness is load-bearing: a buggy game engine produces garbage strategy
// conclusions. Every hand asserts chip conservation (sum of stacks is invariant)
// and that the pot is fully distributed. Run `npm run sim:selftest` to validate.
// ============================================================

import { GameState, Player, Position, Street, Action, ActionType, Card } from '../src/types/poker';
import { idToCard, cardToId } from '../src/core/cfr/card-utils';
import { evaluateHand } from '../src/core/equity/hand-eval';

export type Seat = 0 | 1;

export interface SeatAgent {
  name: string;
  /** Decide an action given the live engine view for THIS seat. */
  act(view: SeatView): Promise<ActResult> | ActResult;
  /** Optional: called at hand end with net result (chips won/lost) for this seat. */
  onHandEnd?(net: number): void;
  /** Optional: called at hand end with the final GameState so the agent can
   *  record opponent stats (enables the bot's exploit adjuster). */
  observe?(finalState: GameState): void | Promise<void>;
}

/** What an agent sees on its turn (a superset of GameState plus convenience). */
export interface SeatView {
  state: GameState;       // full GameState as the scraper would produce, hero = this seat
  toCall: number;         // chips needed to call (0 if can check)
  canCheck: boolean;
  pot: number;            // total pot (both players' commitments this hand)
  street: Street;
  hole: [Card, Card];
  board: Card[];
  heroStack: number;      // remaining stack (behind)
  bb: number;
}

export interface ActResult {
  action: ActionType;     // 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin'
  /** For bet/raise/allin: the TOTAL chips this seat will have committed THIS STREET
   *  after the action (a "raise-to" amount). Ignored for fold/check/call. */
  toAmount?: number;
}

export interface LoggedAction {
  seat: Seat;
  street: Street;
  type: ActionType;
  voluntary: boolean;
  /** Global monotonic index across the whole hand, so the runner can reconstruct
   *  who acted first on a street, who the preflop aggressor was, etc. — the
   *  sequencing needed for cbet / fold-to-cbet / 3bet spot detection. */
  order: number;
}

export interface HandLog {
  /** net chip change for seat 0 (negative = lost). seat1 = -seat0. */
  net0: number;
  /** per-seat-per-street action records (in global order). */
  actions: LoggedAction[];
  wentToShowdown: boolean;
  reachedStreet: Street;
  /** A GameState snapshot at hand end (full actionHistory + positions) so the
   *  bot can record it for opponent tracking via tracker.processHand. Always set
   *  by playHand before it returns. */
  finalState?: GameState;
}

const RANKS = '23456789TJQKA';
function shortCard(c: Card): string { return `${c.rank}${c.suit}`; }

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

function freshDeck(): number[] {
  const d: number[] = [];
  for (let i = 0; i < 52; i++) d.push(i);
  return d;
}
function shuffle(deck: number[], rng: () => number): void {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

export interface HUConfig {
  bb: number;
  sb: number;
  startStackBB: number;   // each seat starts each hand with this many bb (reset per hand = cash-game "deep")
  rng: () => number;
}

/**
 * Play ONE heads-up hand. seat `button` is the SB/dealer (acts first preflop,
 * last postflop). Returns a HandLog. Stacks are reset to startStack each hand
 * (independent-hand cash-game model), which is the right model for measuring
 * per-hand win-rate and frequencies without stack-depth drift.
 */
export async function playHand(
  agents: [SeatAgent, SeatAgent],
  button: Seat,
  cfg: HUConfig,
  handNumber: number,
): Promise<HandLog> {
  const { bb, sb, startStackBB, rng } = cfg;
  const startStack = startStackBB * bb;

  const deck = freshDeck();
  shuffle(deck, rng);
  let di = 0;
  const draw = (): number => deck[di++];

  const holes: [number, number][] = [[0, 0], [0, 0]];
  // standard deal: one card to each, twice
  holes[0][0] = draw(); holes[1][0] = draw();
  holes[0][1] = draw(); holes[1][1] = draw();
  const boardIds: number[] = [];

  const stack: [number, number] = [startStack, startStack];
  const committedHand: [number, number] = [0, 0];   // total put in this hand
  const committedStreet: [number, number] = [0, 0]; // put in this street
  const folded: [boolean, boolean] = [false, false];
  const allIn: [boolean, boolean] = [false, false];

  const bbSeat: Seat = button === 0 ? 1 : 0; // HU: non-button posts BB
  const sbSeat: Seat = button;

  const actionHistory: Record<Street, Action[]> = { preflop: [], flop: [], turn: [], river: [] };
  const log: HandLog = { net0: 0, actions: [], wentToShowdown: false, reachedStreet: 'preflop' };
  let orderCounter = 0;
  const pushAction = (seat: Seat, st: Street, type: ActionType, voluntary: boolean) => {
    log.actions.push({ seat, street: st, type, voluntary, order: orderCounter++ });
  };

  // post blinds
  const post = (seat: Seat, amt: number) => {
    const a = Math.min(amt, stack[seat]);
    stack[seat] -= a; committedStreet[seat] += a; committedHand[seat] += a;
    if (stack[seat] === 0) allIn[seat] = true;
  };
  post(sbSeat, sb);
  post(bbSeat, bb);

  let street: Street = 'preflop';
  let currentBet = bb;            // highest committed-this-street
  let minRaise = bb;             // minimum raise increment

  const potTotal = () => committedHand[0] + committedHand[1];

  function positions(): [Position, Position] {
    // HU: button = SB (dealer), other = BB.
    const p: [Position, Position] = ['BB', 'BB'];
    p[sbSeat] = 'SB'; p[bbSeat] = 'BB';
    return p;
  }

  function buildState(hero: Seat): GameState {
    const pos = positions();
    const villain: Seat = hero === 0 ? 1 : 0;
    const mkP = (s: Seat, isHero: boolean): Player => ({
      name: agents[s].name,
      stack: stack[s],
      position: pos[s],
      isDealer: s === sbSeat,
      isSittingOut: false,
      seatIndex: s,
      isHero,
      currentBet: committedStreet[s],
      hasActed: false,
    });
    const players: Player[] = [];
    players[hero] = mkP(hero, true);
    players[villain] = mkP(villain, false);
    return {
      tableId: 'sim', handNumber, street,
      pot: potTotal(),
      sidePots: [],
      heroCards: [idToCard(holes[hero][0]), idToCard(holes[hero][1])],
      communityCards: boardIds.map(idToCard),
      players,
      heroIndex: hero,
      dealerIndex: sbSeat,
      activePlayerIndex: hero,
      currentBet,
      minRaise,
      bigBlind: bb, smallBlind: sb,
      actionHistory,
      isOurTurn: true,
      timestamp: 0,
    };
  }

  // Run a betting round. Returns true if the hand continues (no fold ended it).
  // Clean model: `toActCount` = how many players still need to act before the
  // round closes. Starts at 2 (both, incl. BB option preflop). A check or call
  // decrements it; a bet/raise reopens action by setting it to 1 (the opponent
  // must respond). The round ends when toActCount hits 0, a player folds, or
  // both are all-in.
  async function bettingRound(firstToAct: Seat): Promise<boolean> {
    let toAct: Seat = firstToAct;
    let toActCount = 2;

    const canAct = (s: Seat) => !folded[s] && !allIn[s];

    while (toActCount > 0) {
      if (folded[0] || folded[1]) return false;
      if (allIn[0] && allIn[1]) return true;
      if (!canAct(0) && !canAct(1)) return true;

      const other: Seat = toAct === 0 ? 1 : 0;
      if (!canAct(toAct)) { toAct = other; continue; } // all-in/folded seat can't act

      const toCall = Math.max(0, currentBet - committedStreet[toAct]);
      const canCheck = toCall === 0;

      const view: SeatView = {
        state: buildState(toAct),
        toCall, canCheck,
        pot: potTotal(),
        street,
        hole: [idToCard(holes[toAct][0]), idToCard(holes[toAct][1])],
        board: boardIds.map(idToCard),
        heroStack: stack[toAct],
        bb,
      };

      let res: ActResult;
      try {
        res = await agents[toAct].act(view);
      } catch (e) {
        res = { action: canCheck ? 'check' : 'fold' };
        process.stderr.write(`[sim] agent ${agents[toAct].name} threw: ${(e as Error).message}\n`);
      }

      let type = res.action;
      const voluntary = !(street === 'preflop' && toAct === bbSeat && (type === 'check'));

      // Normalize illegal actions.
      if (type === 'fold' && canCheck) type = 'check';        // never fold for free
      if (type === 'check' && !canCheck) type = 'call';       // can't check facing a bet

      if (type === 'fold') {
        folded[toAct] = true;
        actionHistory[street].push({ type: 'fold', playerName: agents[toAct].name });
        pushAction(toAct, street, 'fold', true);
        return false;
      }

      if (type === 'check') {
        actionHistory[street].push({ type: 'check', playerName: agents[toAct].name });
        pushAction(toAct, street, 'check', voluntary);
        toActCount--; toAct = other; continue;
      }

      if (type === 'call') {
        const pay = Math.min(toCall, stack[toAct]);
        stack[toAct] -= pay; committedStreet[toAct] += pay; committedHand[toAct] += pay;
        if (stack[toAct] === 0) allIn[toAct] = true;
        actionHistory[street].push({ type: 'call', amount: pay, playerName: agents[toAct].name });
        pushAction(toAct, street, 'call', voluntary);
        toActCount--; toAct = other; continue;
      }

      // bet / raise / allin
      let target: number;
      if (type === 'allin') target = committedStreet[toAct] + stack[toAct];
      else target = res.toAmount ?? (currentBet + Math.max(minRaise, bb));
      const maxTo = committedStreet[toAct] + stack[toAct];
      const minTo = currentBet + minRaise;
      if (target >= maxTo) target = maxTo;                    // all-in
      else if (target < minTo) target = Math.min(minTo, maxTo); // floor to a legal raise

      const pay = target - committedStreet[toAct];
      if (pay <= 0) {
        // Degenerate "raise" that isn't actually more chips -> check or call.
        if (canCheck) {
          actionHistory[street].push({ type: 'check', playerName: agents[toAct].name });
          pushAction(toAct, street, 'check', voluntary);
          toActCount--; toAct = other; continue;
        }
        const cp = Math.min(toCall, stack[toAct]);
        stack[toAct] -= cp; committedStreet[toAct] += cp; committedHand[toAct] += cp;
        if (stack[toAct] === 0) allIn[toAct] = true;
        actionHistory[street].push({ type: 'call', amount: cp, playerName: agents[toAct].name });
        pushAction(toAct, street, 'call', voluntary);
        toActCount--; toAct = other; continue;
      }

      const raiseIncrement = target - currentBet;
      stack[toAct] -= pay; committedStreet[toAct] += pay; committedHand[toAct] += pay;
      if (stack[toAct] === 0) allIn[toAct] = true;
      if (raiseIncrement >= minRaise) minRaise = raiseIncrement;
      currentBet = Math.max(currentBet, committedStreet[toAct]);
      // Classify for stats: a first aggressive action on a street with nothing to
      // call is a "bet"; otherwise a "raise".
      const statType: ActionType = canCheck && street !== 'preflop' ? 'bet' : 'raise';
      actionHistory[street].push({ type: type === 'allin' ? 'allin' : 'raise', amount: target, playerName: agents[toAct].name });
      pushAction(toAct, street, statType, true);
      toActCount = 1; // opponent must respond
      toAct = other;
    }
    return true;
  }

  // ---- preflop ----
  log.reachedStreet = 'preflop';
  await bettingRound(sbSeat); // SB acts first preflop
  const alive = !(folded[0] || folded[1]);

  async function dealAndBet(next: Street, n: number): Promise<boolean> {
    street = next; log.reachedStreet = next;
    committedStreet[0] = 0; committedStreet[1] = 0;
    currentBet = 0; minRaise = bb;
    for (let k = 0; k < n; k++) boardIds.push(draw());
    if (allIn[0] || allIn[1]) return true; // no betting, just run it out
    return bettingRound(bbSeat); // BB (out of position) acts first postflop
  }

  if (alive) {
    // flop, turn, river
    if (await stillIn()) await dealAndBet('flop', 3);
    if (await stillIn()) await dealAndBet('turn', 1);
    if (await stillIn()) await dealAndBet('river', 1);
  }

  async function stillIn(): Promise<boolean> { return !(folded[0] || folded[1]); }

  // ---- resolve ----
  const pot = potTotal();
  let net0: number;
  if (folded[0] || folded[1]) {
    const winner: Seat = folded[0] ? 1 : 0;
    stack[winner] += pot;
    net0 = stack[0] - startStack;
  } else {
    // showdown: complete the board to 5 if not already (all-in earlier streets)
    while (boardIds.length < 5) boardIds.push(draw());
    log.wentToShowdown = true;
    const h0 = evaluateHand([holes[0][0], holes[0][1], ...boardIds]);
    const h1 = evaluateHand([holes[1][0], holes[1][1], ...boardIds]);
    if (h0 > h1) stack[0] += pot;
    else if (h1 > h0) stack[1] += pot;
    else { stack[0] += Math.floor(pot / 2); stack[1] += pot - Math.floor(pot / 2); }
    net0 = stack[0] - startStack;
  }

  // ---- invariant: chips conserved ----
  const totalAfter = stack[0] + stack[1];
  const totalExpected = 2 * startStack;
  if (Math.abs(totalAfter - totalExpected) > 1e-6) {
    throw new Error(`CHIP LEAK hand#${handNumber}: after=${totalAfter} expected=${totalExpected} pot=${pot} stacks=${stack} committed=${committedHand}`);
  }

  // Final-state snapshot for opponent tracking (tracker.processHand reads
  // actionHistory, players[name/position/isSittingOut], and street).
  {
    const pos = positions();
    const snapPlayer = (s: Seat): Player => ({
      name: agents[s].name, stack: stack[s], position: pos[s],
      isDealer: s === sbSeat, isSittingOut: false, seatIndex: s,
      isHero: false, currentBet: 0, hasActed: true,
    });
    log.finalState = {
      tableId: 'sim', handNumber, street: log.reachedStreet, pot, sidePots: [],
      heroCards: null, communityCards: boardIds.map(idToCard),
      players: [snapPlayer(0), snapPlayer(1)],
      heroIndex: 0, dealerIndex: sbSeat, activePlayerIndex: 0,
      currentBet: 0, minRaise: bb, bigBlind: bb, smallBlind: sb,
      actionHistory, isOurTurn: false, timestamp: 0,
    };
  }

  log.net0 = net0;
  agents[0].onHandEnd?.(net0);
  agents[1].onHandEnd?.(-net0);
  return log;
}

export { shortCard, RANKS };
