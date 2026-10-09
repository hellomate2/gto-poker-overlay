import './fake-idb';
import { it } from 'vitest';
import { DecisionEngine } from '../src/core/engine';
import { GameState, Player, Position, Street, Card, Rank, Suit, Action } from '../src/types/poker';
import { cardToId } from '../src/core/cfr/card-utils';
import { quickEquity } from '../src/core/equity/monte-carlo';
import { equityVsRange } from '../src/core/equity/range-equity';
import { evaluateHand } from '../src/core/equity/hand-eval';
import { villainContinuingRange } from '../src/core/postflop-strategy';
import { predictPostflop } from '../src/core/ml/policy';

// ============================================================
// FOLD-TO-RAISE PROBE (diagnostic, not a test of correctness).
//
// Human testers reported the bot "folds to raises far too often postflop". This
// probe feeds the REAL DecisionEngine.decide() a grid of postflop spots where
// HERO BET and VILLAIN RAISED, and records:
//   - the final action and fold frequency per hand class / street / raise size,
//   - which code path produced the final action (net, net anti-punt floor,
//     ranged heuristic, sanity un-fold, soundness veto),
//   - the pre-gate action (decidePostflop before sanity/soundness) so a fold can
//     be attributed to the layer that actually made it,
//   - the distilled net's raw call/fold/raise probabilities for the spot,
//   - hero equity vs villainContinuingRange({aggression:true}) (the range every
//     gate uses) and the pot odds it is compared with.
//
// Two table shapes are run per spot:
//   'hu'      2 seats: the engine routes to the distilled net (decidePostflopNet).
//   '6max'    6 seats, 4 of which FOLDED preflop. Player has no folded flag, so
//             the engine counts them as active villains and routes the heads-up
//             pot to the multiway ranged heuristic (diagnosis item 3).
//
// Run (about 1-3 minutes):
//   npx vitest run --config sim/vitest.probe.config.ts
// Output: a per-spot TSV-ish table and summary matrices on stdout.
// ============================================================

const BB = 20;
const START = 2000; // 100bb

function c(s: string): Card { return { rank: s[0] as Rank, suit: s[1] as Suit }; }

interface HandDef { label: string; cards: [string, string]; }
interface BoardDef { name: string; flop: [string, string, string]; turn: string; river: string; hands: HandDef[]; }

// Hands chosen so the flop class is unambiguous; turn/river cards are near-blank
// for these holdings (the actual made-hand category on each street is printed).
const BOARDS: BoardDef[] = [
  {
    name: 'Js9s4d', flop: ['Js', '9s', '4d'], turn: '2h', river: '2d',
    hands: [
      { label: 'TPGK', cards: ['Ah', 'Jd'] },
      { label: 'overpair', cards: ['Qh', 'Qd'] },
      { label: 'two pair', cards: ['Jh', '9d'] },
      { label: 'mid pair', cards: ['Ad', '9c'] },
      { label: 'flush draw', cards: ['As', '5s'] },
      { label: 'combo draw', cards: ['Ts', '8s'] },
      { label: 'air', cards: ['Kc', '6h'] },
    ],
  },
  {
    name: 'Th8h3c', flop: ['Th', '8h', '3c'], turn: '2d', river: '2s',
    hands: [
      { label: 'TPGK', cards: ['Ad', 'Ts'] },
      { label: 'overpair', cards: ['Qc', 'Qd'] },
      { label: 'two pair', cards: ['Td', '8s'] },
      { label: 'mid pair', cards: ['Ac', '8d'] },
      { label: 'flush draw', cards: ['Ah', '5h'] },
      { label: 'combo draw', cards: ['Jh', '9h'] },
      { label: 'air', cards: ['Kd', '4c'] },
    ],
  },
  {
    name: 'Kd7c2s', flop: ['Kd', '7c', '2s'], turn: '4h', river: '9d',
    hands: [
      { label: 'TPGK', cards: ['Kh', 'Qc'] },
      { label: 'overpair', cards: ['Ah', 'Ac'] },
      { label: 'two pair', cards: ['Kh', '7d'] },
      { label: 'mid pair', cards: ['Ah', '7s'] },
      { label: 'air', cards: ['Jh', '5h'] },
    ],
  },
];

const STREETS: Exclude<Street, 'preflop'>[] = ['flop', 'turn', 'river'];
const BET_FRACS = [0.33, 0.66];
const RAISE_MULTS = [2.5, 3.5, 5]; // villain raises TO this multiple of hero's bet

function mkPlayer(name: string, position: Position, seat: number, isHero: boolean): Player {
  return { name, stack: START, position, isDealer: position === 'BTN', isSittingOut: false, seatIndex: seat, isHero, currentBet: 0, hasActed: false };
}

interface Spot { state: GameState; toCall: number; pot: number; raiseTo: number; heroBet: number; allIn: boolean; }

/**
 * Build a single-raised pot (hero BTN opened 2.5bb, BB called) where on `street`
 * hero bets betFrac*pot and villain raises to raiseMult x hero's bet (capped at
 * villain's stack). Earlier streets: hero bet 0.5 pot, villain called.
 */
function buildSpot(board: BoardDef, hand: HandDef, street: Exclude<Street, 'preflop'>, betFrac: number, raiseMult: number, table: 'hu' | '6max'): Spot {
  const hero = mkPlayer('Hero', 'BTN', 0, true);
  const vil = mkPlayer('Villain', 'BB', 1, false);
  const players: Player[] = [hero, vil];
  const preflop: Action[] = [];
  if (table === '6max') {
    // 4 more seats that FOLDED preflop (still not sitting out — no folded flag).
    const extra: Position[] = ['UTG', 'MP', 'CO', 'SB'];
    extra.forEach((p, i) => {
      players.push(mkPlayer(`P${i}`, p, i + 2, false));
    });
    for (const p of ['P0', 'P1', 'P2']) preflop.push({ type: 'fold', playerName: p });
  }
  preflop.push({ type: 'raise', amount: 50, playerName: 'Hero' });
  if (table === '6max') preflop.push({ type: 'fold', playerName: 'P3' });
  preflop.push({ type: 'call', amount: 50, playerName: 'Villain' });

  let pot = 2 * 50 + (table === '6max' ? 10 : 0); // SB dead money at 6-max
  let heroStack = START - 50;
  let vilStack = START - 50;
  if (table === '6max') players[5].stack = START - 10;
  const hist: Record<Street, Action[]> = { preflop, flop: [], turn: [], river: [] };
  const order: Exclude<Street, 'preflop'>[] = ['flop', 'turn', 'river'];
  for (const s of order) {
    if (s === street) break;
    // Villain checks, hero bets half pot, villain calls.
    const b = Math.round(pot * 0.5);
    hist[s].push({ type: 'check', playerName: 'Villain' }, { type: 'bet', amount: b, playerName: 'Hero' }, { type: 'call', amount: b, playerName: 'Villain' });
    pot += 2 * b; heroStack -= b; vilStack -= b;
  }
  const heroBet = Math.round(pot * betFrac);
  let raiseTo = Math.round(heroBet * raiseMult);
  let allIn = false;
  if (raiseTo >= vilStack) { raiseTo = vilStack; allIn = true; }
  hist[street].push({ type: 'check', playerName: 'Villain' }, { type: 'bet', amount: heroBet, playerName: 'Hero' }, { type: allIn ? 'allin' : 'raise', amount: raiseTo, playerName: 'Villain' });
  heroStack -= heroBet; vilStack -= raiseTo;
  hero.stack = heroStack; hero.currentBet = heroBet;
  vil.stack = vilStack; vil.currentBet = raiseTo;
  const potNow = pot + heroBet + raiseTo; // sim/holdem.ts semantics: pot includes this street's bets
  const nBoard = street === 'flop' ? 3 : street === 'turn' ? 4 : 5;
  const boardStrs = [...board.flop, board.turn, board.river].slice(0, nBoard);
  const all = [...boardStrs, ...hand.cards];
  if (new Set(all).size !== all.length) throw new Error(`card collision ${hand.cards} on ${boardStrs}`);
  const state: GameState = {
    tableId: 'probe', handNumber: 1, street, pot: potNow, sidePots: [],
    heroCards: [c(hand.cards[0]), c(hand.cards[1])],
    communityCards: boardStrs.map(c),
    players, heroIndex: 0, dealerIndex: 0, activePlayerIndex: 0,
    currentBet: raiseTo, minRaise: raiseTo + (raiseTo - heroBet), bigBlind: BB, smallBlind: BB / 2,
    actionHistory: hist, isOurTurn: true, timestamp: 1,
  };
  return { state, toCall: raiseTo - heroBet, pot: potNow, raiseTo, heroBet, allIn };
}

/** Which layer produced the final action, read off the reasoning trail. */
function pathOf(reasoning: string): string {
  if (reasoning.includes('[soundness]')) return 'soundness';
  if (reasoning.includes('[too strong to fold]')) return 'sanity-unfold';
  if (reasoning.includes('[anti-punt]')) return 'net-antipunt';
  if (reasoning.startsWith('net ')) return 'net';
  if (reasoning.includes('vs range')) return 'ranged';
  return 'other';
}

const CAT = ['high', 'pair', '2pair', 'trips', 'straight', 'flush', 'boat', 'quads', 'sf'];

export interface ProbeRow {
  table: string; board: string; hand: string; cards: string; street: string; betFrac: number; raiseMult: number;
  allIn: boolean; cat: string; potOdds: number; eqAggRange: number; netFold: number; netCall: number; netRaise: number;
  preGate: string; final: string; path: string; reasoning: string;
}

export async function runProbe(): Promise<ProbeRow[]> {
  const engine = new DecisionEngine();
  // Pure baseline: no opponent stats (matches sim/agents.ts exploit:false).
  (engine as unknown as { tracker: { loadStats: () => Promise<void> } }).tracker.loadStats = async () => {};
  const rows: ProbeRow[] = [];
  for (const table of ['hu', '6max'] as const) {
    for (const board of BOARDS) for (const hand of board.hands) for (const street of STREETS) for (const bf of BET_FRACS) for (const rm of RAISE_MULTS) {
      const sp = buildSpot(board, hand, street, bf, rm, table);
      const st = sp.state;
      const heroIds: [number, number] = [cardToId(st.heroCards![0]), cardToId(st.heroCards![1])];
      const boardIds = st.communityCards.map(cardToId);
      const cat = CAT[Math.floor(evaluateHand([...heroIds, ...boardIds]) / 1_000_000)] ?? '?';
      const range = villainContinuingRange(heroIds, boardIds, { aggression: true, multiway: false });
      const eqAgg = equityVsRange(heroIds, boardIds, range, 1500).equity;
      const potOdds = sp.toCall / (sp.pot + sp.toCall);
      // The net's raw opinion (same features decidePostflopNet builds).
      const net = predictPostflop({
        holeCards: heroIds, board: boardIds, street, heroPos: 'IP', facingBet: true,
        isPreflopAggressor: true, facedRaiseThisStreet: true, streetBetCount: 2,
        toCallFrac: sp.toCall / st.pot, offeredSizeFrac: sp.toCall / st.pot,
        canCheck: false, canBet: false, canCall: true, canRaise: true, canFold: true, threeBetPot: false,
      });
      const eqRand = quickEquity(heroIds, boardIds);
      const pre = (engine as unknown as { decidePostflop: (s: GameState, h: [number, number], e: number) => { action: string } })
        .decidePostflop(structuredClone(st), heroIds, eqRand);
      const d = await engine.decide(structuredClone(st));
      rows.push({
        table, board: board.name, hand: hand.label, cards: hand.cards.join(''), street, betFrac: bf, raiseMult: rm, allIn: sp.allIn,
        cat, potOdds, eqAggRange: eqAgg, netFold: net.probs.fold, netCall: net.probs.call, netRaise: net.probs.raise,
        preGate: pre.action, final: d.action, path: pathOf(d.reasoning), reasoning: d.reasoning,
      });
    }
  }
  return rows;
}

function pct(x: number): string { return `${Math.round(x * 100)}%`; }

// The engine logs every decision; write the probe's own output straight to stdout.
const out = (...a: unknown[]) => process.stdout.write(a.join(' ') + '\n');

function summarize(rows: ProbeRow[]): void {
  const fold = (rs: ProbeRow[]) => rs.length ? rs.filter(r => r.final === 'fold').length / rs.length : NaN;
  const hands = [...new Set(rows.map(r => r.hand))];
  for (const table of ['hu', '6max']) {
    const T = rows.filter(r => r.table === table);
    out(`\n=== FOLD-TO-RAISE  table=${table}  (n=${T.length}, overall fold ${pct(fold(T))}) ===`);
    out(['hand'.padEnd(11), 'flop', 'turn', 'river', '| x2.5', 'x3.5', 'x5', '| n'].join('\t'));
    for (const h of hands) {
      const H = T.filter(r => r.hand === h);
      const cells = [h.padEnd(11)];
      for (const s of STREETS) cells.push(pct(fold(H.filter(r => r.street === s))));
      cells[cells.length - 1] += '';
      cells.push('| ' + pct(fold(H.filter(r => r.raiseMult === 2.5))));
      cells.push(pct(fold(H.filter(r => r.raiseMult === 3.5))));
      cells.push(pct(fold(H.filter(r => r.raiseMult === 5))));
      cells.push('| ' + H.length);
      out(cells.join('\t'));
    }
    // Attribution: of the folds, which layer made them; of the pre-gate non-folds, how many were vetoed.
    const folds = T.filter(r => r.final === 'fold');
    const byPath: Record<string, number> = {};
    for (const r of folds) byPath[r.path] = (byPath[r.path] || 0) + 1;
    out(`folds by path: ${JSON.stringify(byPath)}`);
    const vetoed = T.filter(r => r.preGate !== 'fold' && r.final === 'fold').length;
    out(`pre-gate continue -> final fold (vetoed by sanity/soundness): ${vetoed}`);
    const netWanted = T.filter(r => r.netFold < Math.max(r.netCall, r.netRaise));
    out(`net argmax was call/raise in ${netWanted.length}/${T.length}; of those final fold: ${netWanted.filter(r => r.final === 'fold').length}`);
    const finals: Record<string, number> = {};
    for (const r of T) finals[r.final] = (finals[r.final] || 0) + 1;
    out(`final actions: ${JSON.stringify(finals)}`);
  }
}

it('probe: fold frequency when hero bets and gets raised', async () => {
  const t0 = Date.now();
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  let rows: ProbeRow[];
  try { rows = await runProbe(); } finally { console.log = log; console.warn = warn; }
  const secs = (Date.now() - t0) / 1000;
  out(['table', 'board', 'hand', 'cards', 'street', 'bet', 'xR', 'allin', 'cat', 'odds', 'eqAgg', 'netF/C/R', 'pre', 'final', 'path', 'reasoning'].join('\t'));
  for (const r of rows) {
    out([r.table, r.board, r.hand, r.cards, r.street, r.betFrac, r.raiseMult, r.allIn ? 'Y' : '', r.cat, pct(r.potOdds), pct(r.eqAggRange),
      `${pct(r.netFold)}/${pct(r.netCall)}/${pct(r.netRaise)}`, r.preGate, r.final, r.path, r.reasoning.slice(0, 140)].join('\t'));
  }
  summarize(rows);
  out(`\nprobe: ${rows.length} decisions in ${secs.toFixed(1)}s`);
}, 1_800_000);
