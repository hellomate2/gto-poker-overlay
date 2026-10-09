// ============================================================
// BlueprintAgent: plays heads-up hands with the C++ blueprint's average
// policy, no search.
//
// Each decision:
//   1. Replay the real hand from GameState.actionHistory (HU, the button is
//      the small blind and abstract player 0) into real chip commitments.
//   2. Walk the abstract tree (abstract-tree.ts, a port of the trainer's
//      tree) in step: every real action maps to one abstract action of the
//      same class. Fold, check and call map to themselves; an all-in maps to
//      the abstract all-in; any other bet or raise is measured as a pot
//      fraction of the REAL pot and mapped with the randomized pseudo-harmonic
//      translation (translate.ts) onto the abstract sizes, each measured the
//      same way in the ABSTRACT state. Translations and our own chosen
//      abstract actions are memoized per hand, so a mapping drawn once is not
//      redrawn at the next decision.
//   3. Ask the PolicySource for the average strategy at (abstract history,
//      hole, board); the source computes the card bucket with the trainer's
//      own tables (`bp serve`).
//   4. Sample an abstract action and map it back to a legal real action:
//      the same pot fraction and the same sizing rule as the tree, applied to
//      the real pot, clamped into [minTo, maxTo], all-in when it reaches the
//      stack.
//
// When the abstract walk cannot follow the real hand (it reached a terminal
// node, the street or actor disagrees, or no abstract raise exists for a real
// raise) the agent falls back to check, else call, and counts it in stats.
// In practice the one common case is COMMITTED below.
// The blueprint was trained at 100 BB; other depths still play but the
// abstraction no longer matches the stacks.
//
// The agent does no I/O: the PolicySource is injected (sim/blueprint-serve.ts
// implements it over a `bp serve` child process).
// ============================================================

import { Card, GameState, Street, Action } from '../../types/poker';
import {
  TreeRules, AbsState, AbsAction, rootState, legalActions, applyAction, potFraction,
} from './abstract-tree';
import { translateSize } from './translate';

export interface PolicyAnswer {
  /** Abstract action tokens at the node, in the C++ child order. */
  toks: string[];
  probs: number[];
  bucket?: number;
}

export interface PolicySource {
  policy(history: readonly string[], hole: readonly [Card, Card], board: readonly Card[]): Promise<PolicyAnswer>;
}

export interface BlueprintDecision {
  action: 'fold' | 'check' | 'call' | 'raise' | 'allin';
  /** Street-level raise-to amount (real chips) for raise / allin. */
  toAmount?: number;
  /** The abstract token chosen (undefined on a fallback). */
  token?: string;
  /** Abstract history at the decision (undefined on a fallback). */
  history?: string[];
  probs?: number[];
  toks?: string[];
  fallback?: string;
}

export interface BlueprintAgentStats {
  decisions: number;
  fallbacks: number;
  fallbackReasons: Record<string, number>;
  /** Opponent bets/raises that matched no abstract size exactly. */
  offTreeTranslations: number;
  /** Opponent bets/raises translated in total. */
  translations: number;
}

export interface BlueprintAgentOptions {
  rules: TreeRules;
  source: PolicySource;
  /** Randomness for translation and action sampling (default Math.random). */
  rng?: () => number;
  /** Use the deterministic pseudo-harmonic median rule instead of the coin. */
  deterministicTranslation?: boolean;
}

const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river'];

type RealClass = 'fold' | 'passive' | 'aggressive';

interface RealAct {
  street: number;
  idx: number;
  actor: number;     // abstract seat (0 = SB/button)
  cls: RealClass;
  type: Action['type'];
  /** Actor's hand-total commitment after the action (real chips). */
  toTotal: number;
}

/** Replayed real hand: per-action records plus the state at the decision. */
interface RealReplay {
  acts: RealAct[];
  c: [number, number];
  lastInc: number;
  streetBase: number;
  ok: boolean;
  why?: string;
}

const tokClass = (tok: string): RealClass =>
  tok === 'f' ? 'fold' : tok === 'k' || tok === 'c' ? 'passive' : 'aggressive';

function fracOfToken(tok: string): number | null {
  if (tok[0] !== 'b' && tok[0] !== 'r') return null;
  const v = Number(tok.slice(1));
  return Number.isFinite(v) ? v : null;
}

/**
 * Replay the real HU hand. Actors alternate within a street (heads-up the
 * player who is all-in never acts again, and nobody is skipped otherwise);
 * the small blind / button acts first preflop, the big blind first after.
 */
export function replayRealHand(state: GameState, heroSeat: number): RealReplay {
  const sb = state.smallBlind, bb = state.bigBlind;
  const c: [number, number] = [sb, bb];
  let lastInc = bb;
  let base = 0;
  const acts: RealAct[] = [];
  const curStreet = STREETS.indexOf(state.street);
  if (curStreet < 0) return { acts, c, lastInc, streetBase: 0, ok: false, why: 'unknown street' };
  const heroName = state.players[state.heroIndex]?.name;
  for (let si = 0; si <= curStreet; si++) {
    const hist = state.actionHistory[STREETS[si]] ?? [];
    if (si > 0) {
      if (c[0] !== c[1]) {
        // Unmatched commitments at a street change happen only with an all-in
        // (then nobody acts again), so a decision after this is a desync.
        return { acts, c, lastInc, streetBase: base, ok: false, why: 'unmatched street start' };
      }
      base = c[0];
      lastInc = bb;
    }
    let actor = si === 0 ? 0 : 1;
    for (let k = 0; k < hist.length; k++) {
      const a = hist[k];
      // Trust the logged name when it identifies a seat unambiguously.
      if (heroName !== undefined && state.players.length === 2 && state.players[0].name !== state.players[1].name) {
        const byName = a.playerName === heroName ? heroSeat : 1 - heroSeat;
        if (byName !== actor) return { acts, c, lastInc, streetBase: base, ok: false, why: 'actor order' };
      }
      const maxc = Math.max(c[0], c[1]);
      let cls: RealClass;
      let toTotal = c[actor];
      if (a.type === 'fold') {
        cls = 'fold';
      } else if (a.type === 'check') {
        cls = 'passive';
      } else if (a.type === 'call') {
        cls = 'passive';
        toTotal = a.amount !== undefined ? c[actor] + a.amount : maxc;
        if (toTotal > maxc) toTotal = maxc;
      } else {
        // bet / raise / allin: amount is the street-level raise-to.
        const amt = a.amount;
        if (amt === undefined) return { acts, c, lastInc, streetBase: base, ok: false, why: 'raise without amount' };
        const t = base + amt;
        if (t <= maxc) {
          cls = 'passive';  // an 'allin' that only calls
          toTotal = t;
        } else {
          cls = 'aggressive';
          toTotal = t;
          const inc = t - maxc;
          if (inc >= lastInc) lastInc = inc;
        }
      }
      acts.push({ street: si, idx: k, actor, cls, type: a.type, toTotal });
      c[actor] = toTotal;
      actor = 1 - actor;
    }
  }
  return { acts, c, lastInc, streetBase: base, ok: true };
}

/**
 * Why the abstract walk ended while the real hand goes on. The usual case: a
 * real raise short of all-in was translated to the abstract all-in (the
 * largest abstract size, or the only raise left at a capped node) and got
 * called, so the abstract hand is at showdown with real chips still behind.
 * The fallback then checks and calls, which continues the abstract line
 * (both players committed); it never folds a hand the blueprint chose to
 * get all in with.
 */
export const COMMITTED = 'committed: abstract all-in was called, real chips behind';
function terminalReason(s: AbsState): string {
  return s.type === 'showdown' ? COMMITTED : 'abstract fold terminal before real decision';
}

export class BlueprintAgent {
  readonly rules: TreeRules;
  readonly source: PolicySource;
  readonly stats: BlueprintAgentStats = {
    decisions: 0, fallbacks: 0, fallbackReasons: {}, offTreeTranslations: 0, translations: 0,
  };
  private rng: () => number;
  private deterministic: boolean;
  private handKey = '';
  private memo = new Map<string, string>();

  constructor(opts: BlueprintAgentOptions) {
    this.rules = opts.rules;
    this.source = opts.source;
    this.rng = opts.rng ?? Math.random;
    this.deterministic = !!opts.deterministicTranslation;
  }

  setRng(rng: () => number): void { this.rng = rng; }

  /** Abstract history for the real state (exposed for tests). */
  mapHistory(state: GameState): { ok: true; toks: string[]; abs: AbsState; real: RealReplay } | { ok: false; why: string } {
    const key = `${state.tableId}#${state.handNumber}`;
    if (key !== this.handKey) { this.handKey = key; this.memo.clear(); }
    if (state.players.length !== 2) return { ok: false, why: 'not heads-up' };
    const heroSeat = state.heroIndex === state.dealerIndex ? 0 : 1;
    const real = replayRealHand(state, heroSeat);
    if (!real.ok) return { ok: false, why: real.why ?? 'replay' };
    // Real starting stacks (behind + committed), for all-in detection.
    const start = [0, 1].map(seat => {
      const pi = seat === heroSeat ? state.heroIndex : 1 - state.heroIndex;
      return state.players[pi].stack + real.c[seat];
    });
    let abs = rootState(this.rules);
    const toks: string[] = [];
    const rc: [number, number] = [state.smallBlind, state.bigBlind];
    for (const ra of real.acts) {
      if (abs.type !== 'decision') return { ok: false, why: terminalReason(abs) };
      if (abs.street !== ra.street) return { ok: false, why: 'street mismatch' };
      if (abs.player !== ra.actor) return { ok: false, why: 'actor mismatch' };
      const legal = legalActions(this.rules, abs);
      const mkey = `${ra.street}:${ra.idx}`;
      let tok = this.memo.get(mkey);
      let act = tok !== undefined ? legal.find(x => x.tok === tok) : undefined;
      if (!act || tokClass(act.tok) !== ra.cls) {
        act = this.translate(legal, abs, ra, rc, start[ra.actor]);
        if (!act) return { ok: false, why: 'no abstract action for real action' };
        this.memo.set(mkey, act.tok);
      }
      tok = act.tok;
      toks.push(tok);
      abs = applyAction(this.rules, abs, act);
      rc[ra.actor] = ra.toTotal;
    }
    return { ok: true, toks, abs, real };
  }

  private translate(
    legal: AbsAction[], abs: AbsState, ra: RealAct, rc: [number, number], startStack: number,
  ): AbsAction | undefined {
    if (ra.cls === 'fold') return legal.find(x => x.kind === 'fold') ?? legal.find(x => x.kind === 'check');
    if (ra.cls === 'passive') return legal.find(x => x.kind === 'call' || x.kind === 'check');
    const raises = legal.filter(x => x.kind === 'bet' || x.kind === 'raise' || x.kind === 'allin');
    if (raises.length === 0) return undefined;
    this.stats.translations++;
    const allin = raises.find(x => x.kind === 'allin');
    if (ra.toTotal >= startStack && allin) return allin;  // a real shove is the abstract shove
    const x = potFraction(rc, ra.actor, ra.toTotal);
    const sizes = raises.map(a => potFraction(abs.c, abs.player, a.to));
    if (!sizes.some(s => Math.abs(s - x) < 1e-9)) this.stats.offTreeTranslations++;
    return raises[translateSize(sizes, x, this.rng, this.deterministic)];
  }

  private fallback(state: GameState, why: string): BlueprintDecision {
    this.stats.fallbacks++;
    this.stats.fallbackReasons[why] = (this.stats.fallbackReasons[why] ?? 0) + 1;
    const hero = state.players[state.heroIndex];
    const toCall = Math.max(0, state.currentBet - hero.currentBet);
    return { action: toCall > 0 ? 'call' : 'check', fallback: why };
  }

  async decide(state: GameState): Promise<BlueprintDecision> {
    this.stats.decisions++;
    if (!state.heroCards) return this.fallback(state, 'no hole cards');
    const m = this.mapHistory(state);
    if (!m.ok) return this.fallback(state, m.why);
    const heroSeat = state.heroIndex === state.dealerIndex ? 0 : 1;
    const curStreet = STREETS.indexOf(state.street);
    if (m.abs.type !== 'decision') return this.fallback(state, terminalReason(m.abs));
    if (m.abs.street !== curStreet) return this.fallback(state, 'street mismatch');
    if (m.abs.player !== heroSeat) return this.fallback(state, 'actor mismatch');
    const hero = state.players[state.heroIndex];
    const real = m.real;
    // Consistency with what the table shows for this street.
    if (real.c[heroSeat] - real.streetBase !== hero.currentBet) return this.fallback(state, 'commitment mismatch');

    const ans = await this.source.policy(m.toks, state.heroCards, state.communityCards);
    const legal = legalActions(this.rules, m.abs);
    if (ans.toks.length !== legal.length || ans.toks.some((t, i) => t !== legal[i].tok)) {
      return this.fallback(state, 'policy actions differ from the TS tree');
    }
    let r = this.rng(), pick = ans.probs.length - 1;
    for (let i = 0; i < ans.probs.length; i++) {
      r -= ans.probs[i];
      if (r < 0) { pick = i; break; }
    }
    const act = legal[pick];
    const street = STREETS[curStreet];
    this.memo.set(`${curStreet}:${(state.actionHistory[street] ?? []).length}`, act.tok);
    const out: BlueprintDecision = { action: 'check', token: act.tok, history: m.toks, probs: ans.probs, toks: ans.toks };

    const oppSeat = 1 - heroSeat;
    const mine = real.c[heroSeat], theirs = real.c[oppSeat], maxc = Math.max(mine, theirs);
    const toCall = maxc - mine;
    const pot = real.c[0] + real.c[1];
    const maxTo = hero.currentBet + hero.stack;  // street-level all-in
    const minTo = state.minRaise;                 // street-level raise-to floor
    if (act.kind === 'fold') { out.action = toCall > 0 ? 'fold' : 'check'; return out; }
    if (act.kind === 'check' || act.kind === 'call') { out.action = toCall > 0 ? 'call' : 'check'; return out; }
    if (maxTo <= maxc - real.streetBase) { out.action = toCall > 0 ? 'call' : 'check'; return out; }
    if (act.kind === 'allin') {
      out.action = 'allin';
      out.toAmount = maxTo;
      return out;
    }
    const f = fracOfToken(act.tok);
    if (f === null) { out.action = toCall > 0 ? 'call' : 'check'; return out; }
    let toTotal: number;
    if (toCall === 0) toTotal = mine + Math.max(state.bigBlind, Math.round(f * pot));
    else toTotal = maxc + Math.max(real.lastInc, Math.round(f * (pot + toCall)));
    let toStreet = toTotal - real.streetBase;
    if (toStreet < minTo) toStreet = minTo;
    if (toStreet >= maxTo) { out.action = 'allin'; out.toAmount = maxTo; return out; }
    out.action = 'raise';
    out.toAmount = toStreet;
    return out;
  }
}
