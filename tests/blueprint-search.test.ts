// ============================================================
// BlueprintAgent with real-time search (src/core/blueprint/agent.ts, option
// `search`). The C++ side (`bp serve` "search" equals `bp search`) is checked
// by sim/blueprint-search-parity.ts against the real binary; this file checks
// the TS side without it.
//
// Oracles:
//   - RuleSearchStub mirrors what `bp serve` accepts (search.cpp
//     parse_search_request, build_by_rules, token_action): the longest
//     on-tree prefix must reach the current round, every later token is
//     either in the tree rules' menu at that point or a b/r pot fraction whose
//     chip amount is legal, below the stack and not equal to a menu size. It
//     answers with the hero node's rule actions, so a history the C++ side
//     would reject fails here;
//   - round trip at tree-chip scale (SB 50, BB 100): every real action is an
//     abstract action, so the search history must equal the tokens both
//     agents actually played, with no off-tree insertions;
//   - legality: 1,000 hands at 10/20 against a random-size bettor and
//     scripted opponents with turn and river search; every action passes the
//     strict validator and no search falls back;
//   - fallbacks: an erroring, a hanging and an under-iterated search each
//     fall back to the blueprint policy and are counted by reason.
// ============================================================

import { describe, it, expect } from 'vitest';
import '../sim/fake-idb';
import {
  holdemRules, rootState, legalActions, applyAction, walkTokens, TreeRules, AbsState, AbsAction,
} from '../src/core/blueprint/abstract-tree';
import {
  BlueprintAgent, PolicySource, PolicyAnswer, SearchSource, SearchRequest, SearchAnswer, COMMITTED, SearchMode,
} from '../src/core/blueprint/agent';
import { decisionToAct } from '../sim/blueprint-serve';
import { playRingHand, SeatAgent, SeatView, ActResult, makeRng, mixSeed, shuffledDeck, validateAction, RingConfig } from '../sim/ring';
import { makeOpponent } from '../sim/agents';
import { Card } from '../src/types/poker';

const lround = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x));

class UniformSource implements PolicySource {
  constructor(private rules: TreeRules) {}
  async policy(history: readonly string[]): Promise<PolicyAnswer> {
    const s = walkTokens(this.rules, history);
    if (!s || s.type !== 'decision') throw new Error(`stub: history not at a decision: ${history.join(' ')}`);
    const toks = legalActions(this.rules, s).map(a => a.tok);
    return { toks, probs: toks.map(() => 1 / toks.length) };
  }
}

/** Accepts exactly the histories `bp serve` "search" accepts (see header). */
class RuleSearchStub implements SearchSource {
  requests: SearchRequest[] = [];
  offtreeInsertions = 0;
  constructor(private rules: TreeRules, private rng: () => number) {}
  async search(req: SearchRequest): Promise<SearchAnswer> {
    this.requests.push(req);
    const toks = req.history;
    // longest on-tree prefix
    let m = 0;
    let s: AbsState = rootState(this.rules);
    while (m < toks.length) {
      const a = s.type === 'decision' ? legalActions(this.rules, s).find(x => x.tok === toks[m]) : undefined;
      if (!a) break;
      s = applyAction(this.rules, s, a);
      m++;
    }
    const street = s.street;
    if (s.type !== 'decision') throw new Error(`stub: prefix ends at a terminal: ${toks.join(' ')}`);
    if (street < 2) throw new Error('stub: search below the turn');
    if (req.board.length !== [0, 3, 4, 5][street]) throw new Error('stub: board size');
    let offtree = false;
    for (let k = m; k < toks.length; k++) {
      if (s.type !== 'decision' || s.street !== street) throw new Error(`stub: off-tree line leaves the round: ${toks.join(' ')}`);
      const tok = toks[k];
      const legal = legalActions(this.rules, s);
      let a: AbsAction | undefined = legal.find(x => x.tok === tok);
      if (!a) {
        // search.cpp token_action, with a double fraction
        if (!/^[br][0-9.]+$/.test(tok)) throw new Error(`stub: token '${tok}' is not legal`);
        const f = Number(tok.slice(1));
        const p = s.player, mine = s.c[p], theirs = s.c[1 - p], maxc = Math.max(mine, theirs);
        const toCall = maxc - mine, pot = s.c[0] + s.c[1];
        if ((tok[0] === 'b') !== (toCall === 0)) throw new Error(`stub: '${tok}' has the wrong bet/raise kind`);
        if (!(theirs < this.rules.stack && mine + toCall < this.rules.stack)) throw new Error(`stub: '${tok}' with no chips behind`);
        const to = toCall === 0 ? mine + Math.max(this.rules.minBet, lround(f * pot)) : maxc + Math.max(s.lastInc, lround(f * (pot + toCall)));
        if (to >= this.rules.stack) throw new Error(`stub: '${tok}' is the all-in`);
        if (legal.some(x => (x.kind === 'bet' || x.kind === 'raise' || x.kind === 'allin') && x.to === to)) {
          throw new Error(`stub: '${tok}' duplicates an existing size`);
        }
        a = { kind: toCall === 0 ? 'bet' : 'raise', to, fracMilli: 0, tok };
        offtree = true;
        this.offtreeInsertions++;
      }
      s = applyAction(this.rules, s, a);
    }
    if (s.type !== 'decision' || s.street !== street) throw new Error('stub: history does not end at a decision');
    const labels = legalActions(this.rules, s).map(x => x.tok);
    const w = labels.map(() => this.rng() + 0.05);
    const z = w.reduce((x, y) => x + y, 0);
    return { labels, probs: w.map(x => x / z), iters: 500, complete: true, ms: 1, offtree };
  }
}

interface Probe { agent: BlueprintAgent; seat: SeatAgent; illegal: string[] }

function searchSeat(
  name: string, rules: TreeRules, seed: number, search: SearchMode, src: SearchSource,
  played?: string[], mismatches?: string[], extra: Partial<ConstructorParameters<typeof BlueprintAgent>[0]> = {},
): Probe {
  const agent = new BlueprintAgent({
    rules, source: new UniformSource(rules), rng: makeRng(seed), search, searchSource: src, ...extra,
  });
  const illegal: string[] = [];
  const seat: SeatAgent = {
    name,
    async act(view: SeatView): Promise<ActResult> {
      const d = await agent.decide(view.state);
      if (played && mismatches && d.history && d.history.join(' ') !== played.join(' ')) {
        mismatches.push(`saw '${d.history.join(' ')}' but played '${played.join(' ')}'`);
      }
      if (played && d.token) played.push(d.token);
      const act = decisionToAct(d, view);
      const v = validateAction(view, { action: act.action, amount: act.toAmount });
      if (!v.ok) illegal.push(`${v.error} (${JSON.stringify(act)})`);
      return act;
    },
  };
  return { agent, seat, illegal };
}

describe('BlueprintAgent search round trip at tree-chip scale', () => {
  it('sends exactly the tokens both agents played, with no off-tree insertions, over 1,000 hands', async () => {
    const rules = holdemRules('small');
    const played: string[] = [];
    const mismatches: string[] = [];
    const stub = new RuleSearchStub(rules, makeRng(77));
    const a = searchSeat('A', rules, 1, 'turn+river', stub, played, mismatches);
    const b = searchSeat('B', rules, 2, 'river', new RuleSearchStub(rules, makeRng(78)), played, mismatches);
    const cfg: RingConfig = { bb: 100, sb: 50, startStackBB: 100, rng: () => 0 };
    for (let h = 0; h < 1000; h++) {
      played.length = 0;
      const deck = shuffledDeck(makeRng(mixSeed(11, h)));
      await playRingHand(h % 2 ? [a.seat, b.seat] : [b.seat, a.seat], 0, cfg, h + 1, deck);
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(a.illegal).toEqual([]);
    expect(b.illegal).toEqual([]);
    expect(stub.offtreeInsertions).toBe(0);
    expect(a.agent.searchStats.searched).toBeGreaterThan(50);
    expect(a.agent.searchStats.fallbacks).toBe(0);
    expect(b.agent.searchStats.fallbacks).toBe(0);
    expect(a.agent.stats.fallbacks).toBe(0);
  }, 120_000);
});

/** Bets or raises a uniformly random legal amount half the time it can. */
function randomSizer(seed: number): SeatAgent {
  const rng = makeRng(seed);
  return {
    name: 'RND',
    act(v: SeatView): ActResult {
      const r = rng();
      if (v.canRaise && v.maxTo > v.state.currentBet && r < 0.5) {
        const lo = Math.min(v.minTo, v.maxTo);
        return { action: 'raise', toAmount: lo + Math.floor(rng() * (v.maxTo - lo + 1)) };
      }
      if (r < 0.65 && !v.canCheck) return { action: 'fold' };
      return { action: v.canCheck ? 'check' : 'call' };
    },
  };
}

describe('BlueprintAgent search legality', () => {
  it('returns only legal actions over 1,000 hands at 10/20 with turn and river search', async () => {
    const rules = holdemRules('small');
    const stub = new RuleSearchStub(rules, makeRng(5));
    const p = searchSeat('BP', rules, 3, 'turn+river', stub);
    const kinds = ['lag', 'maniac', 'raiser', 'station', 'checkraiser', 'barreler'];
    const opps: SeatAgent[] = [randomSizer(9), randomSizer(10), ...kinds.map((k, i) => makeOpponent(k, 100 + i, 50, `O_${k}`))];
    const cfg: RingConfig = { bb: 20, sb: 10, startStackBB: 100, rng: () => 0 };
    for (let h = 0; h < 1000; h++) {
      const opp = opps[h % opps.length];
      const deck = shuffledDeck(makeRng(mixSeed(6, h)));
      await playRingHand(h % 2 ? [p.seat, opp] : [opp, p.seat], (h >> 1) % 2, cfg, h + 1, deck);
    }
    const ss = p.agent.searchStats;
    expect(p.illegal).toEqual([]);
    expect(ss.fallbackReasons).toEqual({});
    expect(ss.searched).toBe(ss.attempts);
    expect(ss.searched).toBeGreaterThan(200);
    // The random sizer makes off-tree bets; they must reach the search as
    // real-size tokens, not as their translation.
    expect(ss.offTree).toBeGreaterThan(30);
    expect(stub.offtreeInsertions).toBeGreaterThan(30);
    expect(Object.keys(p.agent.stats.fallbackReasons).filter(k => k !== COMMITTED)).toEqual([]);
  }, 120_000);
});

class BadSearch implements SearchSource {
  constructor(private mode: 'error' | 'hang' | 'short', private rules: TreeRules) {}
  search(req: SearchRequest): Promise<SearchAnswer> {
    if (this.mode === 'error') return Promise.reject(new Error('bp serve search failed: boom'));
    if (this.mode === 'hang') return new Promise(() => { /* never answers */ });
    return new RuleSearchStub(this.rules, makeRng(1)).search(req).then(a => ({ ...a, iters: 3, complete: false }));
  }
}

describe('BlueprintAgent search fallbacks', () => {
  for (const mode of ['error', 'hang', 'short'] as const) {
    it(`plays the blueprint and counts a fallback when the search ${mode === 'short' ? 'is under-iterated' : mode === 'hang' ? 'misses the budget' : 'errors'}`, async () => {
      const rules = holdemRules('small');
      const p = searchSeat('BP', rules, 4, 'river', new BadSearch(mode, rules), undefined, undefined,
        { searchBudgetMs: 5, searchGraceMs: 5 });
      const opp = makeOpponent('station', 7, 50, 'S');
      const cfg: RingConfig = { bb: 20, sb: 10, startStackBB: 100, rng: () => 0 };
      for (let h = 0; h < 40; h++) {
        const deck = shuffledDeck(makeRng(mixSeed(8, h)));
        await playRingHand(h % 2 ? [p.seat, opp] : [opp, p.seat], 0, cfg, h + 1, deck);
      }
      const ss = p.agent.searchStats;
      const reason = mode === 'error' ? 'error' : mode === 'hang' ? 'timeout' : 'too few iterations';
      expect(ss.attempts).toBeGreaterThan(5);
      expect(ss.searched).toBe(0);
      expect(ss.fallbacks).toBe(ss.attempts);
      expect(ss.fallbackReasons).toEqual({ [reason]: ss.attempts });
      expect(p.illegal).toEqual([]);
    }, 60_000);
  }
});

describe('BlueprintAgent search line on a scripted off-tree river bet', () => {
  it('sends the real pot fraction of an off-tree bet and maps the searched raise back to real chips', async () => {
    const rules = holdemRules('small');
    const stub = new RuleSearchStub(rules, makeRng(2));
    // Always raise when the search offers r1.
    const pick: SearchSource = {
      async search(req) {
        const a = await stub.search(req);
        return { ...a, probs: a.labels.map(l => (l === 'r1' ? 1 : 0)) };
      },
    };
    const agent = new BlueprintAgent({ rules, source: new UniformSource(rules), rng: makeRng(1), search: 'river', searchSource: pick });
    const C = (s: string): Card => ({ rank: s[0] as Card['rank'], suit: s[1] as Card['suit'] });
    // 10/20 blinds, 2000 stacks. Hero is the big blind (seat 1). Preflop: SB
    // raises to 40 (on-tree r0.5: 20 + max(20, 0.5 * 40)), BB calls. Flop and
    // turn check through. River: BB checks, SB bets 64 into 80 (0.8 pot,
    // off-tree: the menu has 0.5 and 1).
    const state = {
      tableId: 't', handNumber: 1, street: 'river', heroIndex: 1, dealerIndex: 0,
      smallBlind: 10, bigBlind: 20, currentBet: 64, minRaise: 128, pot: 144,
      heroCards: [C('Qh'), C('Jh')], communityCards: [C('Qs'), C('7h'), C('2d'), C('9c'), C('3s')],
      players: [
        { name: 'V', stack: 2000 - 40 - 64, currentBet: 64 },
        { name: 'H', stack: 2000 - 40, currentBet: 0 },
      ],
      actionHistory: {
        preflop: [{ playerName: 'V', type: 'raise', amount: 40 }, { playerName: 'H', type: 'call', amount: 20 }],
        flop: [{ playerName: 'H', type: 'check' }, { playerName: 'V', type: 'check' }],
        turn: [{ playerName: 'H', type: 'check' }, { playerName: 'V', type: 'check' }],
        river: [{ playerName: 'H', type: 'check' }, { playerName: 'V', type: 'bet', amount: 64 }],
      },
    } as unknown as Parameters<BlueprintAgent['decide']>[0];
    const d = await agent.decide(state);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].history).toEqual(['r0.5', 'c', 'k', 'k', 'k', 'k', 'k', 'b0.8']);
    expect(d.searched?.offtree).toBe(true);
    expect(d.token).toBe('r1');
    // r1 facing 64 into 80: raise by max(lastInc 64, 1 * (144 + 64)) = 208
    // over 104 total, so 104 + 208 = 312 total, minus the 40 street base.
    expect(d.action).toBe('raise');
    expect(d.toAmount).toBe(312 - 40);
  });
});
