// ============================================================
// Oski bridge for the GTO Wizard Benchmark API (research evaluation only).
//
// Reads one JSON request per line on stdin: {"id": n, "state": <GameServiceResponse>}
// from the researcher-api-client, converts it to the engine's GameState, asks
// DecisionEngine for a move, and writes {"id": n, "action": "f|k|c|b", "amount"?: n,
// "reasoning": "..."} per line on stdout. Logs go to stderr.
//
// API conventions (models.py): heads-up, stacks reset each hand, action_history
// tokens 'f' 'c' 'k' 'bX' (X = cumulative bet on the round) and '_' (end of round).
// Preflop the SB (button) acts first; postflop the BB acts first.
// ============================================================

import '../fake-idb';
import * as readline from 'readline';
import { DecisionEngine } from '../../src/core/engine';
import { Action, Card, GameState, Player, Rank, Street, Suit } from '../../src/types/poker';

const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river'];

interface ApiPlayer { name: string; stack: number; position: string; hole_cards: string | null }
interface ApiState {
  hand_id: number;
  game: { starting_stack: number; blinds: number[] };
  game_state: {
    street: Street; common_pot: number; total_pot: number; board_cards: string;
    players: ApiPlayer[]; legal_actions: string[]; raise_range: { min: number; max: number } | null;
    action_history: string[];
  };
}

function cards(s: string | null): Card[] {
  const out: Card[] = [];
  const t = (s ?? '').replace(/[^2-9TJQKAtjqkashdc]/g, '');
  for (let i = 0; i + 1 < t.length; i += 2) {
    const r = t[i].toUpperCase() === '1' ? 'T' : t[i].toUpperCase();
    out.push({ rank: r as Rank, suit: t[i + 1].toLowerCase() as Suit });
  }
  return out;
}

function toGameState(req: ApiState): GameState {
  const gs = req.game_state;
  // The API lists blinds big-first ([100, 50]); take min/max instead of trusting order.
  const sb = Math.min(...req.game.blinds), bb = Math.max(...req.game.blinds);
  const heroIdx = gs.players.findIndex(p => !!p.hole_cards);
  const isSB = (p: ApiPlayer) => /sb|btn|button|dealer/i.test(p.position);
  let sbIdx = gs.players.findIndex(isSB);
  if (sbIdx < 0) sbIdx = gs.players.findIndex(p => !/bb/i.test(p.position));
  const bbIdx = 1 - sbIdx;

  // Replay the history to rebuild per-street actions and the current street's bets.
  const actionHistory: Record<Street, Action[]> = { preflop: [], flop: [], turn: [], river: [] };
  let street = 0;
  let toAct = sbIdx;                                   // preflop: SB first
  let streetBet = [0, 0];
  streetBet[sbIdx] = sb; streetBet[bbIdx] = bb;
  for (const tok of gs.action_history) {
    if (tok === '_') { street++; toAct = bbIdx; streetBet = [0, 0]; continue; }
    const name = gs.players[toAct].name;
    const st = STREETS[Math.min(street, 3)];
    if (tok === 'f') actionHistory[st].push({ type: 'fold', playerName: name });
    else if (tok === 'k') actionHistory[st].push({ type: 'check', playerName: name });
    else if (tok === 'c') { streetBet[toAct] = Math.max(...streetBet); actionHistory[st].push({ type: 'call', playerName: name }); }
    else if (tok.startsWith('b')) {
      const amt = Number(tok.slice(1));
      const facing = Math.max(...streetBet) > streetBet[toAct];
      streetBet[toAct] = amt;
      actionHistory[st].push({ type: facing || st === 'preflop' ? 'raise' : 'bet', amount: amt, playerName: name });
    }
    toAct = 1 - toAct;
  }

  const players: Player[] = gs.players.map((p, i) => ({
    name: p.name, stack: p.stack, position: i === sbIdx ? 'SB' : 'BB', isDealer: i === sbIdx,
    isSittingOut: false, seatIndex: i, isHero: i === heroIdx, currentBet: streetBet[i], hasActed: false,
  }));
  const hole = cards(gs.players[heroIdx].hole_cards);
  return {
    tableId: `gtow-${req.hand_id}`, handNumber: req.hand_id, street: gs.street, pot: gs.total_pot, sidePots: [],
    heroCards: [hole[0], hole[1]], communityCards: cards(gs.board_cards),
    players, heroIndex: heroIdx, dealerIndex: sbIdx, activePlayerIndex: heroIdx,
    currentBet: Math.max(...streetBet), minRaise: gs.raise_range?.min ?? 2 * bb,
    bigBlind: bb, smallBlind: sb, actionHistory, isOurTurn: true, timestamp: Date.now(),
  };
}

// One engine per hand: the benchmark plays many hands concurrently, and the engine
// keeps per-hand memory (preflop aggressor, street transitions), so a shared engine
// mixed hands together and misread spots.
const engines = new Map<number, DecisionEngine>();
function engineFor(handId: number): DecisionEngine {
  let e = engines.get(handId);
  if (!e) {
    e = new DecisionEngine();
    // No opponent tracking: play the engine's equilibrium-style defaults.
    (e as unknown as { tracker: { loadStats: () => Promise<void> } }).tracker.loadStats = async () => {};
    engines.set(handId, e);
    if (engines.size > 500) engines.delete(engines.keys().next().value as number);
  }
  return e;
}
console.log = (...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n');

async function handle(line: string): Promise<string> {
  const { id, state } = JSON.parse(line) as { id: number; state: ApiState };
  const legal = state.game_state.legal_actions;
  const rr = state.game_state.raise_range;
  try {
    const d = await engineFor(state.hand_id).decide(toGameState(state));
    let action = 'k', amount: number | undefined;
    if (d.action === 'fold') action = legal.includes('f') ? 'f' : 'k';
    else if (d.action === 'check') action = legal.includes('k') ? 'k' : (legal.includes('f') ? 'f' : 'c');
    else if (d.action === 'call') action = legal.includes('c') ? 'c' : 'k';
    else if (legal.includes('b') && rr) {
      action = 'b';
      amount = d.action === 'allin' ? rr.max : Math.round(Math.min(rr.max, Math.max(rr.min, d.amount ?? rr.min)));
    } else action = legal.includes('c') ? 'c' : 'k';
    return JSON.stringify({ id, action, amount, reasoning: d.reasoning });
  } catch (e) {
    const action = legal.includes('k') ? 'k' : 'f';
    return JSON.stringify({ id, action, reasoning: `bridge error, safe ${action}: ${String(e)}` });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async line => { if (line.trim()) process.stdout.write((await handle(line)) + '\n'); });
