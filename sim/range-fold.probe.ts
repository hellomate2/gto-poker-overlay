import './fake-idb';
import { it } from 'vitest';
import { DecisionEngine } from '../src/core/engine';
import { installDefense } from './defense-shim';
import { GameState, Player, Position, Street, Card, Rank, Suit, Action, BotDecision } from '../src/types/poker';
import { cardToId, idToCard } from '../src/core/cfr/card-utils';
import { evaluateHand } from '../src/core/equity/hand-eval';

// ============================================================
// RANGE-LEVEL FOLD-TO-RAISE PROBE (diagnostic).
//
// The per-hand probe (fold-to-raise.probe.ts) shows WHICH hands fold. The
// number that decides exploitability is how often the bot folds its WHOLE betting
// range to a raise: if that exceeds the break-even fold rate of a pure bluff
// raise, a villain who raises any two cards prints money.
//
// For each board / street (heads-up, so the engine runs the distilled-net path):
//   1. Sample hero combos uniformly (seeded) from all live combos.
//   2. Checked to hero: ask decide() and read the lead-policy bet probability
//      pBet from its reasoning ("p63%"), so the betting range is weighted exactly
//      (no sampling noise from the bet/check coin flip).
//   3. For every combo with pBet > 0: hero bets the engine's own size, villain
//      raises to 3x; ask decide() again. Fold-to-raise = sum(pBet*fold)/sum(pBet).
//   4. Compare with 1 - MDF and with the break-even fold rate of a zero-equity
//      bluff raise: villain risks R (raise-to) to win P + b, so the bluff profits
//      when foldRate > R / (R + P + b).
// Turn/river hero combos are sampled uniformly, not conditioned on hero's earlier
// bets (a simplification; the per-street betting filter still applies).
//
// Run:  npx vitest run --config sim/vitest.probe.config.ts sim/range-fold
// ============================================================

const BB = 20;
const START = 2000;
const RAISE_MULT = 3;
const COMBOS_PER_SPOT = Number(process.env.PROBE_COMBOS || 120);

function c(s: string): Card { return { rank: s[0] as Rank, suit: s[1] as Suit }; }
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const BOARDS: { name: string; cards: string[] }[] = [
  { name: 'Js9s4d-2h-2d', cards: ['Js', '9s', '4d', '2h', '2d'] },
  { name: 'Th8h3c-2d-2s', cards: ['Th', '8h', '3c', '2d', '2s'] },
  { name: 'Kd7c2s-4h-9d', cards: ['Kd', '7c', '2s', '4h', '9d'] },
];
const STREETS: Exclude<Street, 'preflop'>[] = ['flop', 'turn', 'river'];

function mkPlayer(name: string, position: Position, seat: number, isHero: boolean): Player {
  return { name, stack: START, position, isDealer: position === 'BTN', isSittingOut: false, seatIndex: seat, isHero, currentBet: 0, hasActed: false };
}

/** SRP, hero BTN opened and bet-called half pot on earlier streets; checked to hero now. */
function baseState(boardStrs: string[], street: Exclude<Street, 'preflop'>, hole: [number, number]): { state: GameState; pot: number; heroStack: number; vilStack: number } {
  const hero = mkPlayer('Hero', 'BTN', 0, true);
  const vil = mkPlayer('Villain', 'BB', 1, false);
  const hist: Record<Street, Action[]> = {
    preflop: [{ type: 'raise', amount: 50, playerName: 'Hero' }, { type: 'call', amount: 50, playerName: 'Villain' }],
    flop: [], turn: [], river: [],
  };
  let pot = 100, heroStack = START - 50, vilStack = START - 50;
  for (const s of ['flop', 'turn', 'river'] as const) {
    if (s === street) break;
    const b = Math.round(pot * 0.5);
    hist[s].push({ type: 'check', playerName: 'Villain' }, { type: 'bet', amount: b, playerName: 'Hero' }, { type: 'call', amount: b, playerName: 'Villain' });
    pot += 2 * b; heroStack -= b; vilStack -= b;
  }
  hist[street].push({ type: 'check', playerName: 'Villain' });
  hero.stack = heroStack; vil.stack = vilStack;
  const n = street === 'flop' ? 3 : street === 'turn' ? 4 : 5;
  const state: GameState = {
    tableId: 'probe', handNumber: 1, street, pot, sidePots: [],
    heroCards: [idToCard(hole[0]), idToCard(hole[1])], communityCards: boardStrs.slice(0, n).map(c),
    players: [hero, vil], heroIndex: 0, dealerIndex: 0, activePlayerIndex: 0,
    currentBet: 0, minRaise: BB, bigBlind: BB, smallBlind: BB / 2,
    actionHistory: hist, isOurTurn: true, timestamp: 1,
  };
  return { state, pot, heroStack, vilStack };
}

interface EngineInternals {
  tracker: { loadStats: () => Promise<void> };
  analyzeBoard: (cards: Card[]) => unknown;
  chooseBetSize: (board: unknown, pot: number, street: Street, bb: number, heroCat: number) => number;
}

it('probe: fold-to-raise over the bot\'s whole betting range (HU)', async () => {
  const log = console.log, warn = console.warn;
  const out = (...a: unknown[]) => process.stdout.write(a.join(' ') + '\n');
  console.log = () => {}; console.warn = () => {};
  const engine = new DecisionEngine();
  const internals = engine as unknown as EngineInternals;
  internals.tracker.loadStats = async () => {};
  // PROBE_DEFENSE=1: route facing-a-bet spots through src/core/defense.ts (sim/defense-shim.ts).
  if (process.env.PROBE_DEFENSE === '1') installDefense(engine);
  const rng = mulberry32(7);
  const t0 = Date.now();
  let decisions = 0;
  const lines: string[] = [];
  const foldPaths: Record<string, number> = {};
  try {
    for (const board of BOARDS) for (const street of STREETS) {
      const n = street === 'flop' ? 3 : street === 'turn' ? 4 : 5;
      const dead = new Set(board.cards.slice(0, n).map(s => cardToId(c(s))));
      const live: [number, number][] = [];
      for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) if (!dead.has(a) && !dead.has(b)) live.push([a, b]);
      // Seeded partial shuffle -> COMBOS_PER_SPOT uniform combos.
      for (let i = 0; i < COMBOS_PER_SPOT; i++) { const j = i + Math.floor(rng() * (live.length - i)); [live[i], live[j]] = [live[j], live[i]]; }
      let wBet = 0, wFold = 0, wTotal = 0;
      let raiseTo = 0, potBefore = 0, heroBetRef = 0;
      const foldByCat: Record<string, [number, number]> = {};
      for (const hole of live.slice(0, COMBOS_PER_SPOT)) {
        const base = baseState(board.cards, street, hole);
        const lead: BotDecision = await engine.decide(structuredClone(base.state)); decisions++;
        wTotal += 1;
        let pBet = 0;
        const m = /\bp(\d+)%/.exec(lead.reasoning);
        if (lead.reasoning.includes('[soundness]')) pBet = lead.action === 'bet' ? 1 : 0;
        else if (lead.reasoning.includes('[sanity]')) pBet = 1;
        else if (m && lead.reasoning.includes('[lead-policy]')) pBet = Number(m[1]) / 100;
        else pBet = lead.action === 'bet' ? 1 : 0;
        if (pBet <= 0) continue;
        const heroCat = Math.floor(evaluateHand([...hole, ...base.state.communityCards.map(cardToId)]) / 1_000_000);
        const betAmt = lead.action === 'bet' && lead.amount
          ? lead.amount
          : internals.chooseBetSize(internals.analyzeBoard(base.state.communityCards), base.pot, street, BB, heroCat);
        const heroBet = Math.min(betAmt, base.heroStack);
        let rTo = Math.round(heroBet * RAISE_MULT);
        const allIn = rTo >= base.vilStack;
        if (allIn) rTo = base.vilStack;
        // Facing-the-raise state.
        const st = base.state;
        st.actionHistory[street].push({ type: 'bet', amount: heroBet, playerName: 'Hero' }, { type: allIn ? 'allin' : 'raise', amount: rTo, playerName: 'Villain' });
        st.players[0].stack = base.heroStack - heroBet; st.players[0].currentBet = heroBet;
        st.players[1].stack = base.vilStack - rTo; st.players[1].currentBet = rTo;
        st.pot = base.pot + heroBet + rTo; st.currentBet = rTo; st.minRaise = rTo + (rTo - heroBet);
        const resp = await engine.decide(structuredClone(st)); decisions++;
        const folded = resp.action === 'fold' ? 1 : 0;
        if (folded) {
          const path = resp.reasoning.includes('[defense]') ? 'defense' : resp.reasoning.includes('[soundness]') ? 'soundness' : resp.reasoning.includes('[anti-punt]') ? 'net-antipunt' : resp.reasoning.startsWith('net ') ? 'net' : 'other';
          foldPaths[path] = (foldPaths[path] || 0) + pBet;
        }
        wBet += pBet; wFold += pBet * folded;
        const catName = ['high', 'pair', '2pair+'][Math.min(2, heroCat)];
        foldByCat[catName] = foldByCat[catName] || [0, 0];
        foldByCat[catName][0] += pBet * folded; foldByCat[catName][1] += pBet;
        raiseTo += rTo * pBet; potBefore += base.pot * pBet; heroBetRef += heroBet * pBet;
      }
      const R = raiseTo / wBet, P = potBefore / wBet, b = heroBetRef / wBet;
      const foldRate = wFold / wBet;
      const mdf = (P + b + R) / (P + b + R + (R - b)); // pot / (pot + toCall) with pot incl. the raise
      const breakEven = R / (R + P + b);                // zero-equity bluff raise break-even fold rate
      const cats = Object.entries(foldByCat).map(([k, [f, w]]) => `${k} ${Math.round(100 * f / w)}% (w${w.toFixed(1)})`).join(', ');
      lines.push(`${board.name}\t${street}\tbetFreq ${Math.round(100 * wBet / wTotal)}%\tfoldToRaise ${Math.round(100 * foldRate)}%\t1-MDF ${Math.round(100 * (1 - mdf))}%\tbluffBE ${Math.round(100 * breakEven)}%\t${foldRate > breakEven ? 'EXPLOITABLE' : 'ok'}\t${cats}`);
    }
  } finally { console.log = log; console.warn = warn; }
  out(`board\tstreet\tbet freq\tfold-to-3x-raise (betting range)\t1-MDF\tbluff-raise break-even\tverdict\tfold by hero class`);
  for (const l of lines) out(l);
  out(`folds (pBet-weighted) by deciding layer: ${Object.entries(foldPaths).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}`);
  out(`defense wired: ${process.env.PROBE_DEFENSE === '1'}`);
  out(`probe: ${decisions} decisions, ${COMBOS_PER_SPOT} combos/spot, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}, 3_600_000);
