// ============================================================
// The C++ trainer's abstract betting tree, rebuilt lazily in TS.
//
// A line-for-line port of legal_actions() and Builder::expand() in
// blueprint/src/tree.cpp, so the BlueprintAgent can walk the abstract tree,
// see every abstract action's chip amount and translate off-tree bets
// without a round trip to `bp serve` per node. Parity with the C++ tree is
// checked node by node against `bp serve --tree-only` (sim/blueprint-parity.ts)
// and on known nodes in tests/blueprint-agent.test.ts.
//
// Units are tree chips (the C++ presets: SB 50, BB 100, stack 10,000).
// Player 0 is the small blind / button.
//
// Sizing (tree.cpp):
//   not facing a bet:  to = mine + max(min_bet, lround(f * pot))
//   facing a bet:      to = theirs + max(last_inc, lround(f * (pot + to_call)))
// f is a C++ float, so f * pot is a float32 product; Math.fround reproduces it.
// ============================================================

export interface StreetRules {
  betFracs: number[];
  raiseFracs: number[];
  allin: boolean;
  maxRaises: number;
  firstPlayer: number;
}

export interface TreeRules {
  name: string;
  nstreets: number;
  stack: number;
  blind: [number, number];
  minBet: number;
  street: StreetRules[];
}

/** Named presets, same values as holdem_config() in blueprint/src/tree.cpp. */
export function holdemRules(preset: 'tiny' | 'small' | 'medium'): TreeRules {
  const mk = (bet: number[], raise: number[], maxRaises: number, firstPlayer: number): StreetRules =>
    ({ betFracs: bet, raiseFracs: raise, allin: true, maxRaises, firstPlayer });
  const street: StreetRules[] = [];
  if (preset === 'tiny') {
    street.push(mk([1], [1], 3, 0));
    for (let s = 1; s < 4; s++) street.push(mk([0.75], [1], 2, 1));
  } else if (preset === 'small') {
    street.push(mk([0.5, 1], [0.5, 1], 3, 0));
    for (let s = 1; s < 4; s++) street.push(mk([0.5, 1], [1], 2, 1));
  } else if (preset === 'medium') {
    street.push(mk([0.5, 1, 2], [0.5, 1, 2], 4, 0));
    for (let s = 1; s < 4; s++) street.push(mk([0.33, 0.66, 1, 2], [0.66, 1, 2], 3, 1));
  } else {
    throw new Error(`unknown holdem preset ${preset as string}`);
  }
  return { name: `holdem-${preset}`, nstreets: 4, stack: 10000, blind: [50, 100], minBet: 100, street };
}

/**
 * Parse the tree description the C++ side prints (TreeConfig::describe(),
 * returned by `bp serve` "info"), so the TS tree is built from the exact
 * rules of the checkpoint being served.
 */
export function parseTreeDescription(desc: string): TreeRules {
  const parts = desc.split(';');
  const kv = new Map<string, string>();
  const streets: StreetRules[] = [];
  for (const p of parts) {
    const m = /^s(\d+):(.*)$/.exec(p);
    if (m) {
      const f = new Map<string, string>();
      for (const item of m[2].split(',')) {
        const eq = item.indexOf('=');
        if (eq > 0) f.set(item.slice(0, eq), item.slice(eq + 1));
      }
      if (f.has('limit')) throw new Error('limit trees are not supported by the BlueprintAgent');
      const fr = (s: string | undefined) => (s ? s.split('/').filter(Boolean).map(Number) : []);
      streets[Number(m[1])] = {
        betFracs: fr(f.get('bet')), raiseFracs: fr(f.get('raise')),
        allin: f.get('allin') === '1', maxRaises: Number(f.get('max_raises')), firstPlayer: Number(f.get('first')),
      };
      continue;
    }
    const eq = p.indexOf('=');
    if (eq > 0) kv.set(p.slice(0, eq), p.slice(eq + 1));
  }
  const blind = (kv.get('blind') ?? '').split(',').map(Number);
  const rules: TreeRules = {
    name: kv.get('name') ?? '', nstreets: Number(kv.get('streets')), stack: Number(kv.get('stack')),
    blind: [blind[0], blind[1]], minBet: Number(kv.get('min_bet')), street: streets,
  };
  if (!(rules.nstreets >= 1) || streets.length !== rules.nstreets || !(rules.stack > 0)) {
    throw new Error(`cannot parse tree description: ${desc}`);
  }
  return rules;
}

/** C++ std::lround: round half away from zero. */
function lround(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

export type AbsKind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

export interface AbsAction {
  kind: AbsKind;
  /** Actor's total commitment after the action (tree chips). */
  to: number;
  fracMilli: number;
  /** Token as the C++ tree prints it: f k c b0.5 r1 a. */
  tok: string;
}

export interface AbsState {
  c: [number, number];
  street: number;
  player: number;
  raises: number;
  actions: number;
  lastInc: number;
  /** 'decision' while someone has to act; 'fold' / 'showdown' at terminals. */
  type: 'decision' | 'fold' | 'showdown';
  /** Folding player at a fold terminal. */
  folder?: number;
}

export function rootState(r: TreeRules): AbsState {
  return {
    c: [r.blind[0], r.blind[1]], street: 0, player: r.street[0].firstPlayer, raises: 0, actions: 0,
    lastInc: r.minBet, type: 'decision',
  };
}

function fracToken(kind: 'bet' | 'raise', fracMilli: number): string {
  return (kind === 'bet' ? 'b' : 'r') + String(fracMilli / 1000);
}

/** Legal abstract actions at a decision state (tree.cpp legal_actions). */
export function legalActions(r: TreeRules, s: AbsState): AbsAction[] {
  if (s.type !== 'decision') return [];
  const out: AbsAction[] = [];
  const rules = r.street[s.street];
  const p = s.player, o = 1 - p;
  const mine = s.c[p], theirs = s.c[o], maxc = Math.max(mine, theirs);
  const toCall = maxc - mine;
  const pot = s.c[0] + s.c[1];
  if (toCall > 0) {
    out.push({ kind: 'fold', to: mine, fracMilli: 0, tok: 'f' });
    out.push({ kind: 'call', to: Math.min(maxc, r.stack), fracMilli: 0, tok: 'c' });
  } else {
    out.push({ kind: 'check', to: mine, fracMilli: 0, tok: 'k' });
  }
  const chipsBehind = theirs < r.stack && mine + toCall < r.stack;
  if (!chipsBehind) return out;
  if (s.raises >= rules.maxRaises) {
    if (rules.allin) out.push({ kind: 'allin', to: r.stack, fracMilli: 0, tok: 'a' });
    return out;
  }
  const kind: 'bet' | 'raise' = toCall > 0 ? 'raise' : 'bet';
  const fr = toCall > 0 ? rules.raiseFracs : rules.betFracs;
  const seen: number[] = [];
  for (const f of fr) {
    const f32 = Math.fround(f);
    let to: number;
    if (toCall === 0) {
      to = mine + Math.max(r.minBet, lround(Math.fround(f32 * pot)));
    } else {
      const inc = Math.max(s.lastInc, lround(Math.fround(f32 * (pot + toCall))));
      to = maxc + inc;
    }
    if (to >= r.stack) {
      if (rules.allin) continue;
      to = r.stack;
    }
    if (seen.includes(to)) continue;
    seen.push(to);
    const fracMilli = lround(Math.fround(f32 * 1000));
    out.push({ kind, to, fracMilli, tok: fracToken(kind, fracMilli) });
  }
  if (rules.allin && !seen.includes(r.stack)) out.push({ kind: 'allin', to: r.stack, fracMilli: 0, tok: 'a' });
  return out;
}

/** State after taking `a` at `s` (tree.cpp Builder::expand). */
export function applyAction(r: TreeRules, s: AbsState, a: AbsAction): AbsState {
  const p = s.player, o = 1 - p;
  const t: AbsState = { ...s, c: [s.c[0], s.c[1]] };
  let toNext = false, showdown = false;
  if (a.kind === 'fold') {
    t.type = 'fold';
    t.folder = p;
    t.actions = s.actions + 1;
    return t;
  } else if (a.kind === 'check') {
    if (s.actions >= 1) toNext = true;
  } else if (a.kind === 'call') {
    t.c[p] = a.to;
    if (t.c[p] >= r.stack || t.c[o] >= r.stack) showdown = true;
    else if (s.actions >= 1) toNext = true;
  } else {
    const maxc = Math.max(s.c[0], s.c[1]);
    t.lastInc = Math.max(s.lastInc, a.to - maxc);
    t.c[p] = a.to;
    t.raises = s.raises + 1;
  }
  t.actions = s.actions + 1;
  t.player = o;
  if (toNext) {
    if (s.street + 1 >= r.nstreets) {
      showdown = true;
    } else {
      t.street = s.street + 1;
      t.raises = 0;
      t.actions = 0;
      t.lastInc = r.minBet;
      t.player = r.street[t.street].firstPlayer;
    }
  }
  if (showdown) t.type = 'showdown';
  return t;
}

/**
 * Size of an abstract bet/raise as a pot fraction in the state where it is
 * taken, measured the way tree.cpp defines "frac pot": (to - mine) / pot for
 * a bet, (to - maxc) / (pot + to_call) for a raise. All-ins are measured the
 * same way, so they take part in translation as the largest size.
 */
export function potFraction(c: readonly [number, number], player: number, to: number): number {
  const mine = c[player], theirs = c[1 - player], maxc = Math.max(mine, theirs);
  const toCall = maxc - mine;
  const pot = c[0] + c[1];
  return toCall === 0 ? (to - mine) / pot : (to - maxc) / (pot + toCall);
}

/** Follow tokens from the root; null when a token is not legal. */
export function walkTokens(r: TreeRules, toks: readonly string[]): AbsState | null {
  let s = rootState(r);
  for (const tk of toks) {
    if (s.type !== 'decision') return null;
    const a = legalActions(r, s).find(x => x.tok === tk);
    if (!a) return null;
    s = applyAction(r, s, a);
  }
  return s;
}
