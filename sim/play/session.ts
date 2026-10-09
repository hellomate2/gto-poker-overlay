// ============================================================
// One human-vs-bot heads-up session.
//
// The hand itself is played by the sim engine (playRingHand in sim/ring.ts), so
// betting rules, side pots and showdown are the same code the harness
// measures with. The human is a SeatAgent whose act() returns a promise that
// PlaySession.act() resolves once the requested action passes the engine's own
// strict check (validateAction in sim/ring.ts). The bot is any SeatAgent from
// sim/play/bots.ts.
//
// Seats: the human is always seat 0, the bot seat 1. The button alternates
// every hand, starting with the human on the button (HU: the button posts the
// small blind and acts first preflop). Stacks reset to the configured sizes
// every hand (independent hands, the same cash model the harness uses), so
// bb/100 is a plain mean of per-hand results.
//
// Phases: idle (no hand yet) -> bot | human (hand running) -> done (hand over,
// result shown) -> deal() starts the next hand. error means the engine threw.
//
// Each deal is reproducible: the deck is shuffledDeck(makeRng(mixSeed(seed,
// hand))) and Math.random is reset to makeRng(mixSeed(seed, hand, 1)) before
// the hand, as in sim/match.ts. Both seeds go into the hand history.
// ============================================================

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  playRingHand, RingHandLog, SeatAgent, SeatView, ActResult, makeRng, mixSeed, shuffledDeck,
  validateAction, canRaiseNow,
} from '../ring';
import { idToCard } from '../../src/core/cfr/card-utils';
import { evaluateHand, handCategoryName } from '../../src/core/equity/hand-eval';
import { Street } from '../../src/types/poker';
import { allInAdjustment, AllInInfo } from './allin-ev';
import { bb100CI, RateCI } from './stats';
import { BotInfo } from './bots';

export const HUMAN = 0;
export const BOT = 1;
export const HUMAN_NAME = 'You';
export const BOT_NAME = 'Bot';

export type Phase = 'idle' | 'bot' | 'human' | 'done' | 'error';
export type Who = 'you' | 'bot';

export interface SessionConfig {
  sb: number;
  bb: number;
  /** Starting stack in chips for the human and for the bot (reset each hand). */
  humanStack: number;
  botStack: number;
  seed: number;
  /** Minimum time a bot decision takes, so its actions are readable. */
  botDelayMs: number;
  /** Directory for <date>.jsonl hand histories; null disables logging. */
  historyDir: string | null;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

export interface PublicAction { who: Who; street: Street; type: string; amount?: number }

export interface HandResult {
  /** Human net in chips and bb. */
  net: number;
  netBb: number;
  showdown: boolean;
  /** Hand names at showdown, e.g. "Two Pair". */
  youHand?: string;
  botHand?: string;
  /** All-in EV adjustment, when the money went in with cards to come. */
  allIn: null | { boardCards: number; equity: number; tie: number; evNetBb: number };
  /** Adjusted net used for the all-in EV series (equals netBb when allIn is null). */
  adjNetBb: number;
  summary: string;
}

export interface HandRecord {
  hand: number;
  button: Who;
  log: RingHandLog;
  result: HandResult;
}

export class PlayError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const cardStr = (id: number) => { const c = idToCard(id); return `${c.rank}${c.suit}`; };

export class PlaySession {
  readonly cfg: SessionConfig;
  readonly botInfo: BotInfo;
  private readonly bot: SeatAgent;

  phase: Phase = 'idle';
  version = 0;
  handNo = 0;
  readonly hands: HandRecord[] = [];
  errorMessage: string | null = null;

  private button = 0;
  private deck: number[] = [];
  private lastView: SeatView | null = null;
  private pending: { view: SeatView; resolve: (r: ActResult) => void } | null = null;
  private running: Promise<void> | null = null;
  private waiters: (() => void)[] = [];
  private readonly sessionId: string;

  constructor(cfg: SessionConfig, bot: SeatAgent, botInfo: BotInfo) {
    this.cfg = cfg;
    this.bot = bot;
    this.botInfo = botInfo;
    this.sessionId = (cfg.now ?? (() => new Date()))().toISOString();
  }

  // ---- control --------------------------------------------------------------

  /** Start the next hand. Allowed in idle, done and error. */
  deal(): void {
    if (this.phase === 'bot' || this.phase === 'human') throw new PlayError('a hand is in progress', 409);
    this.handNo++;
    this.button = (this.handNo - 1) % 2 === 0 ? HUMAN : BOT;
    this.deck = shuffledDeck(makeRng(mixSeed(this.cfg.seed, this.handNo)));
    Math.random = makeRng(mixSeed(this.cfg.seed, this.handNo, 1));
    this.lastView = null;
    this.errorMessage = null;
    this.setPhase(this.button === HUMAN ? 'human' : 'bot'); // provisional until the first act()
    const handNo = this.handNo;
    this.running = this.runHand(handNo);
  }

  /** Apply the human's action. Throws PlayError when it is not legal. */
  act(req: { action: string; amount?: number }): void {
    if (this.phase !== 'human' || !this.pending) throw new PlayError('not your turn', 409);
    const v = validateAction(this.pending.view, req);
    if (!v.ok) throw new PlayError(v.error);
    const p = this.pending;
    this.pending = null;
    this.setPhase('bot');
    p.resolve(v.act);
  }

  /** Resolves once the session is waiting on the human or the hand is over. */
  settled(): Promise<void> {
    if (this.phase !== 'bot') return Promise.resolve();
    return new Promise(r => this.waiters.push(r));
  }

  /** Wait until the version moves past `since` and the bot is not thinking, or timeout. */
  async waitFor(since: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.version <= since || this.phase === 'bot') && Date.now() < deadline) {
      await Promise.race([
        new Promise<void>(r => this.waiters.push(r)),
        sleep(Math.max(1, deadline - Date.now())),
      ]);
    }
  }

  /** For tests and shutdown: the promise of the hand currently running. */
  get handPromise(): Promise<void> | null { return this.running; }

  // ---- hand loop ------------------------------------------------------------

  private setPhase(p: Phase): void {
    this.phase = p;
    this.version++;
    if (p !== 'bot') { const w = this.waiters; this.waiters = []; w.forEach(f => f()); }
  }

  private async runHand(handNo: number): Promise<void> {
    const human: SeatAgent = {
      name: HUMAN_NAME,
      act: (view: SeatView) => new Promise<ActResult>((resolve) => {
        this.lastView = view;
        this.pending = { view, resolve };
        this.setPhase('human');
      }),
    };
    const delay = this.cfg.botDelayMs;
    const bot: SeatAgent = {
      name: BOT_NAME,
      act: async (view: SeatView) => {
        this.lastView = view;
        this.setPhase('bot');
        const t0 = Date.now();
        const r = await this.bot.act(view);
        const left = delay - (Date.now() - t0);
        if (left > 0) await sleep(left);
        return r;
      },
    };
    try {
      const seatStacks = [this.cfg.humanStack, this.cfg.botStack];
      const log = await playRingHand([human, bot], this.button, {
        bb: this.cfg.bb, sb: this.cfg.sb, startStackBB: 0, seatStacks,
        rng: () => { throw new Error('deck is always supplied'); },
      }, handNo, this.deck);
      const result = this.scoreHand(log);
      const rec: HandRecord = { hand: handNo, button: this.button === HUMAN ? 'you' : 'bot', log, result };
      this.hands.push(rec);
      this.writeHistory(rec);
      try { await this.bot.observe?.(log.finalState); } catch { /* tracking is best-effort */ }
      this.pending = null;
      this.setPhase('done');
    } catch (e) {
      this.pending = null;
      this.errorMessage = (e as Error).message;
      this.setPhase('error');
    }
  }

  private scoreHand(log: RingHandLog): HandResult {
    const bb = this.cfg.bb;
    const net = log.nets[HUMAN];
    const netBb = net / bb;
    let youHand: string | undefined, botHand: string | undefined;
    if (log.wentToShowdown) {
      youHand = handCategoryName(evaluateHand([...log.holes[HUMAN], ...log.board]));
      botHand = handCategoryName(evaluateHand([...log.holes[BOT], ...log.board]));
    }
    const ai: AllInInfo | null = allInAdjustment(log, HUMAN);
    const adjNetBb = ai ? ai.evNet / bb : netBb;
    const fmt = (x: number) => `${x >= 0 ? '+' : ''}${Number(x.toFixed(2))}`;
    let summary: string;
    const lastFold = log.actions.length && log.actions[log.actions.length - 1].type === 'fold'
      ? log.actions[log.actions.length - 1] : null;
    if (!log.wentToShowdown && lastFold) summary = lastFold.seat === HUMAN ? 'You folded' : 'Bot folded';
    else if (net > 0) summary = `You win with ${youHand}`;
    else if (net < 0) summary = `Bot wins with ${botHand}`;
    else summary = `Split pot (${youHand})`;
    summary += ` (${fmt(netBb)} bb)`;
    return {
      net, netBb, showdown: log.wentToShowdown, youHand, botHand,
      allIn: ai ? { boardCards: ai.boardCards, equity: ai.equity.win + ai.equity.tie / 2, tie: ai.equity.tie, evNetBb: ai.evNet / bb } : null,
      adjNetBb, summary,
    };
  }

  private writeHistory(rec: HandRecord): void {
    if (!this.cfg.historyDir) return;
    const now = (this.cfg.now ?? (() => new Date()))();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    mkdirSync(this.cfg.historyDir, { recursive: true });
    const { log, result } = rec;
    const line = {
      ts: now.toISOString(),
      session: this.sessionId,
      hand: rec.hand,
      seed: this.cfg.seed,
      deckSeed: mixSeed(this.cfg.seed, rec.hand),
      randomSeed: mixSeed(this.cfg.seed, rec.hand, 1),
      blinds: [this.cfg.sb, this.cfg.bb],
      stacks: { you: this.cfg.humanStack, bot: this.cfg.botStack },
      button: rec.button,
      bot: this.botInfo,
      you: log.holes[HUMAN].map(cardStr),
      botCards: log.holes[BOT].map(cardStr),
      board: log.board.map(cardStr),
      actions: log.actions.map(a => ({ who: a.seat === HUMAN ? 'you' : 'bot', street: a.street, type: a.type, amount: a.amount })),
      committed: { you: log.committed[HUMAN], bot: log.committed[BOT] },
      showdown: log.wentToShowdown,
      net: result.net,
      netBb: result.netBb,
      allIn: result.allIn,
      adjNetBb: result.adjNetBb,
    };
    appendFileSync(join(this.cfg.historyDir, `${day}.jsonl`), JSON.stringify(line) + '\n', 'utf8');
  }

  // ---- views ----------------------------------------------------------------

  stats(): { hands: number; net: RateCI; allInAdj: RateCI; luckBb: number } {
    const net = bb100CI(this.hands.map(h => h.result.netBb));
    const allInAdj = bb100CI(this.hands.map(h => h.result.adjNetBb));
    return { hands: this.hands.length, net, allInAdj, luckBb: net.total - allInAdj.total };
  }

  /** Raise-to presets for the current decision, clamped and de-duplicated. */
  static presets(view: SeatView): { label: string; to: number }[] {
    if (!canRaiseNow(view)) return [];
    const st = view.state;
    const bb = view.bb;
    const lo = Math.min(view.minTo, view.maxTo), hi = view.maxTo;
    const raw: { label: string; to: number }[] = [];
    const potAfterCall = view.pot + view.toCall;
    if (view.street === 'preflop') {
      if (st.currentBet <= bb) {
        raw.push({ label: '2.5x', to: Math.round(2.5 * bb) }, { label: '3x', to: 3 * bb }, { label: '4x', to: 4 * bb });
      } else {
        raw.push({ label: '3x', to: 3 * st.currentBet }, { label: '4x', to: 4 * st.currentBet });
      }
      raw.push({ label: 'pot', to: st.currentBet + potAfterCall });
    } else {
      for (const [label, f] of [['33%', 1 / 3], ['50%', 0.5], ['75%', 0.75], ['pot', 1]] as [string, number][]) {
        raw.push({ label, to: Math.round(st.currentBet + f * potAfterCall) });
      }
    }
    const out: { label: string; to: number }[] = [];
    for (const p of raw) {
      const to = Math.min(hi, Math.max(lo, p.to));
      if (to < hi && !out.some(o => o.to === to)) out.push({ label: p.label, to });
    }
    out.push({ label: 'all-in', to: hi });
    return out;
  }

  snapshot(): Record<string, unknown> {
    const cfg = this.cfg;
    const rec = this.phase === 'done' && this.hands.length ? this.hands[this.hands.length - 1] : null;
    const inHand = this.phase === 'bot' || this.phase === 'human';
    const v = this.lastView;

    let street: Street | null = null, pot = 0, board: string[] = [];
    let stacks = [cfg.humanStack, cfg.botStack], bets = [0, 0];
    let actions: PublicAction[] = [];
    let youHole: string[] = [], botHole: string[] | null = null;
    if (this.handNo > 0 && this.deck.length) youHole = [this.deck[HUMAN], this.deck[2 + HUMAN]].map(cardStr);
    if (rec) {
      const log = rec.log;
      street = log.reachedStreet;
      pot = 2 * Math.min(log.committed[0], log.committed[1]); // the uncalled excess went back
      board = log.board.map(cardStr);
      stacks = [cfg.humanStack + log.nets[HUMAN], cfg.botStack + log.nets[BOT]];
      bets = [0, 0];
      actions = log.actions.map(a => ({ who: a.seat === HUMAN ? 'you' : 'bot', street: a.street, type: a.type, amount: a.amount }));
      if (log.wentToShowdown) botHole = log.holes[BOT].map(cardStr);
    } else if (inHand && v) {
      street = v.street;
      pot = v.pot;
      board = v.board.map(c => `${c.rank}${c.suit}`);
      stacks = v.state.players.map(p => p.stack);
      bets = v.state.players.map(p => p.currentBet);
      for (const s of ['preflop', 'flop', 'turn', 'river'] as Street[]) {
        for (const a of v.state.actionHistory[s]) {
          actions.push({ who: a.playerName === HUMAN_NAME ? 'you' : 'bot', street: s, type: a.type, amount: a.amount });
        }
      }
    } else if (inHand) {
      // Hand just dealt, nobody has been asked yet: blinds are posted.
      street = 'preflop';
      const sbSeat = this.button, bbSeat = 1 - this.button;
      bets = [0, 0];
      bets[sbSeat] = Math.min(cfg.sb, stacks[sbSeat]);
      bets[bbSeat] = Math.min(cfg.bb, stacks[bbSeat]);
      stacks = stacks.map((s, i) => s - bets[i]);
      pot = bets[0] + bets[1];
    }

    let legal: Record<string, unknown> | null = null;
    if (this.phase === 'human' && this.pending) {
      const pv = this.pending.view;
      const raise = canRaiseNow(pv);
      legal = {
        fold: !pv.canCheck,
        check: pv.canCheck,
        call: !pv.canCheck,
        callAmount: Math.min(pv.toCall, pv.heroStack),
        raise: raise ? {
          kind: pv.street !== 'preflop' && pv.state.currentBet === 0 ? 'bet' : 'raise',
          minTo: Math.min(pv.minTo, pv.maxTo), maxTo: pv.maxTo,
          committed: pv.state.players[HUMAN].currentBet,
          presets: PlaySession.presets(pv),
        } : null,
      };
    }

    const s = this.stats();
    return {
      version: this.version,
      phase: this.phase,
      error: this.errorMessage,
      hand: this.handNo,
      button: this.handNo ? (this.button === HUMAN ? 'you' : 'bot') : null,
      blinds: { sb: cfg.sb, bb: cfg.bb },
      startStacks: { you: cfg.humanStack, bot: cfg.botStack },
      street, pot, board,
      you: { name: HUMAN_NAME, stack: stacks[HUMAN], bet: bets[HUMAN], hole: youHole },
      bot: { name: BOT_NAME, stack: stacks[BOT], bet: bets[BOT], hole: botHole, info: this.botInfo },
      actions,
      legal,
      result: rec ? rec.result : null,
      session: s,
      recent: this.hands.slice(-12).reverse().map(h => ({
        hand: h.hand, netBb: h.result.netBb, adjNetBb: h.result.adjNetBb, summary: h.result.summary,
      })),
    };
  }
}
