import { GameState, Position, Action as GameAction, Street } from '../../types/poker';
import { cardToId, handGroupName } from '../cfr/card-utils';
import { charts as greenlineCharts, Cell, Chart } from './greenline-gto';
import { charts as pekarstasCharts } from './pekarstas-gto';
import { charts as headsupCharts } from './headsup-gto';
import { shoveRange, callRange } from './pushfold-nash';

// Effective-stack threshold (in big blinds) at or below which the short-stack
// push/fold Nash recommendation is surfaced. Pure jam/fold is only correct very
// short; above ~10bb heads-up you have a raise/fold (and limp/3-bet) game, so we
// keep this conservative and defer to the open-raise charts above it. (At 18bb,
// for example, a hand like K6s is a small open, not a shove.)
const PUSHFOLD_MAX_BB = 10;

/**
 * Look up a preflop chart by key. When the table is heads-up (exactly
 * two active players) the heads-up charts are consulted first so HU
 * keys like 'SB-RFI'/'BB-vs-open-SB'/'SB-vs-3bet-BB' override the
 * multiway versions; otherwise the standard greenline/pekarstas charts
 * are used, preserving multiway behavior.
 */
function lookupChart(key: string, headsUp = false): Chart | undefined {
  if (headsUp && headsupCharts[key]) return headsupCharts[key];
  return greenlineCharts[key] || pekarstasCharts[key];
}

/** Count players still in the hand (not folded out / sitting out). */
function countActivePlayers(state: GameState): number {
  const foldedNames = new Set(
    (state.actionHistory.preflop || [])
      .filter(a => a.type === 'fold')
      .map(a => a.playerName)
  );
  return state.players.filter(
    p => !p.isSittingOut && !foldedNames.has(p.name)
  ).length;
}

/** Hero effective stack in big blinds (capped by the largest opponent). */
function heroEffectiveStackBB(state: GameState): number {
  const hero = state.players[state.heroIndex];
  const bb = state.bigBlind || 1;
  const opponentStacks = state.players
    .filter((p, i) => i !== state.heroIndex && !p.isSittingOut)
    .map(p => p.stack);
  const maxOpp = opponentStacks.length ? Math.max(...opponentStacks) : hero.stack;
  const eff = Math.min(hero.stack, maxOpp);
  return eff / bb;
}

export interface GTOAdvice {
  scenario: string;
  hand: string;
  actions: { action: string; frequency: number }[];
  inRange: boolean;
  rangeWeight: number;
}

type PreflopScenario = 'RFI' | 'vs-open' | 'vs-3bet' | 'vs-4bet';

interface ScenarioResult {
  scenario: PreflopScenario;
  chartKey: string;
  label: string;
}

function normalizeCell(cell: Cell): { weight: number; actions: Record<string, number> } {
  if (typeof cell === 'string') {
    return { weight: 100, actions: { [cell]: 100 } };
  }
  if (Array.isArray(cell)) {
    const [a, b] = cell;
    if (a === b) return { weight: 100, actions: { [a]: 100 } };
    return { weight: 100, actions: { [a]: 50, [b]: 50 } };
  }
  return { weight: cell.weight, actions: cell.actions as Record<string, number> };
}

const POSITION_ORDER: Position[] = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];

function posIndex(pos: Position): number {
  return POSITION_ORDER.indexOf(pos);
}

function detectScenario(state: GameState, headsUp: boolean): ScenarioResult | null {
  const hero = state.players[state.heroIndex];
  const heroPos = hero.position;
  const pfActions = state.actionHistory.preflop || [];

  let raises = 0;
  let lastRaiserPos: Position | null = null;
  let secondRaiserPos: Position | null = null;

  for (const a of pfActions) {
    if (a.type === 'raise' || a.type === 'allin') {
      raises++;
      if (raises === 1) {
        const p = state.players.find(p => p.name === a.playerName);
        lastRaiserPos = p?.position || null;
      } else if (raises === 2) {
        const p = state.players.find(p => p.name === a.playerName);
        secondRaiserPos = p?.position || null;
      }
    }
  }

  // The parsed action log is unreliable (PokerNow only shows recent lines), so
  // infer the raise count from the LIVE bet size when it implies more action than
  // we parsed. A current bet of ~2.5bb = an open, ~6bb = a 3-bet, ~13bb = a 4-bet.
  // Without this, a 3-bet with no parsed history looked like an unopened pot and
  // the bot "opened" trash like K6o.
  const bb = state.bigBlind || 1;
  const cb = state.currentBet || 0;
  let inferred = 0;
  if (cb > bb * 1.5) inferred = 1;
  if (cb >= bb * 4.5) inferred = 2;
  if (cb >= bb * 11) inferred = 3;
  if (inferred > raises) {
    // Fill the missing raiser position from the villain (heads-up: the other
    // player). vs-3bet keys on the 3-bettor, so set the second raiser too.
    const villain = state.players.find((p, i) => i !== state.heroIndex && !p.isSittingOut);
    const vpos = villain?.position || null;
    raises = inferred;
    if (!lastRaiserPos) lastRaiserPos = vpos;
    if (raises >= 2 && !secondRaiserPos) secondRaiserPos = vpos;
  }

  const huTag = headsUp ? 'HU ' : '';

  if (raises === 0) {
    // Unopened — RFI
    if (heroPos === 'BB') return null; // BB checks, not RFI
    const key = `${heroPos}-RFI`;
    if (lookupChart(key, headsUp)) {
      return { scenario: 'RFI', chartKey: key, label: `${huTag}${heroPos} Open (RFI)` };
    }
    return null;
  }

  if (raises === 1 && lastRaiserPos) {
    // Facing a single open
    const key = `${heroPos}-vs-open-${lastRaiserPos}`;
    if (lookupChart(key, headsUp)) {
      return { scenario: 'vs-open', chartKey: key, label: `${huTag}${heroPos} vs ${lastRaiserPos} Open` };
    }
    // Try ISO (isolation) key
    const isoKey = `${heroPos}-ISO`;
    if (lookupChart(isoKey, headsUp)) {
      return { scenario: 'vs-open', chartKey: isoKey, label: `${huTag}${heroPos} ISO Raise` };
    }
    return null;
  }

  if (raises === 2 && lastRaiserPos) {
    // Hero opened, facing 3-bet
    const threeBetter = secondRaiserPos || lastRaiserPos;
    const key = `${heroPos}-vs-3bet-${threeBetter}`;
    if (lookupChart(key, headsUp)) {
      return { scenario: 'vs-3bet', chartKey: key, label: `${huTag}${heroPos} vs ${threeBetter} 3-Bet` };
    }
    return null;
  }

  if (raises >= 3) {
    // Facing 4-bet
    const key = `${heroPos}-vs-4bet-${lastRaiserPos}`;
    if (lookupChart(key, headsUp)) {
      return { scenario: 'vs-4bet', chartKey: key, label: `${huTag}${heroPos} vs ${lastRaiserPos} 4-Bet` };
    }
    return null;
  }

  return null;
}

export function getGTOAdvice(state: GameState): GTOAdvice | null {
  if (state.street !== 'preflop' || !state.heroCards) return null;

  const c1 = cardToId(state.heroCards[0]);
  const c2 = cardToId(state.heroCards[1]);
  const handName = handGroupName(c1, c2);

  const headsUp = countActivePlayers(state) === 2;
  const effStackBB = heroEffectiveStackBB(state);

  // --- Short-stack push/fold Nash override ---------------------------------
  // Two distinct short-stack cases:
  //   1. Facing an all-in shove: it is purely call-or-fold no matter the exact
  //      depth (we apply it up to ~25bb), so use the Nash call range.
  //   2. Open-jamming first-in: only correct when very short (<= PUSHFOLD_MAX_BB,
  //      ~10bb). Above that you have a raise/fold game, so we fall through to the
  //      open-raise charts (e.g. K6s is a small open at 18bb, not a shove).
  if (effStackBB > 0) {
    const pfActions = state.actionHistory.preflop || [];
    const hero = state.players[state.heroIndex];
    const facingAllIn = pfActions.some(a => a.type === 'allin');
    const firstIn = !pfActions.some(a => a.type === 'allin' || a.type === 'raise');

    if (facingAllIn && effStackBB <= 25) {
      const inCall = callRange(effStackBB).has(handName);
      return {
        scenario: `Push/Fold Nash — Call vs Jam (${effStackBB.toFixed(0)}bb eff)`,
        hand: handName,
        actions: inCall
          ? [{ action: 'All-In', frequency: 100 }]
          : [{ action: 'Fold', frequency: 100 }],
        inRange: inCall,
        rangeWeight: inCall ? 100 : 0,
      };
    }

    if (firstIn && effStackBB <= PUSHFOLD_MAX_BB && (hero.position === 'SB' || hero.position === 'BTN')) {
      const inShove = shoveRange(effStackBB).has(handName);
      return {
        scenario: `Push/Fold Nash — Open Jam (${effStackBB.toFixed(0)}bb eff)`,
        hand: handName,
        actions: inShove
          ? [{ action: 'All-In', frequency: 100 }]
          : [{ action: 'Fold', frequency: 100 }],
        inRange: inShove,
        rangeWeight: inShove ? 100 : 0,
      };
    }
  }

  const scenarioResult = detectScenario(state, headsUp);
  if (!scenarioResult) {
    return {
      scenario: 'No GTO chart for this spot',
      hand: handName,
      actions: [],
      inRange: false,
      rangeWeight: 0,
    };
  }

  const chart = lookupChart(scenarioResult.chartKey, headsUp);
  if (!chart) return null;

  const cell = chart[handName];

  if (!cell) {
    // Not in chart = fold
    return {
      scenario: scenarioResult.label,
      hand: handName,
      actions: [{ action: 'Fold', frequency: 100 }],
      inRange: false,
      rangeWeight: 0,
    };
  }

  const normalized = normalizeCell(cell);
  const actions: { action: string; frequency: number }[] = [];

  const actionLabels: Record<string, string> = {
    raise: scenarioResult.scenario === 'RFI' ? 'Raise' : scenarioResult.scenario === 'vs-open' ? '3-Bet' : '4-Bet',
    call: 'Call',
    fold: 'Fold',
    allin: 'All-In',
  };

  // Add actions that have frequency > 0
  for (const [action, freq] of Object.entries(normalized.actions)) {
    if (freq && freq > 0) {
      actions.push({
        action: actionLabels[action] || action,
        frequency: freq,
      });
    }
  }

  // If weight < 100, add fold for the remaining portion
  if (normalized.weight < 100) {
    const foldFreq = 100 - normalized.weight;
    const existingFold = actions.find(a => a.action === 'Fold');
    if (existingFold) {
      existingFold.frequency += foldFreq;
    } else {
      actions.push({ action: 'Fold', frequency: foldFreq });
    }
    // Scale the non-fold actions
    for (const a of actions) {
      if (a.action !== 'Fold') {
        a.frequency = (a.frequency * normalized.weight) / 100;
      }
    }
  }

  // Sort by frequency descending
  actions.sort((a, b) => b.frequency - a.frequency);

  return {
    scenario: scenarioResult.label,
    hand: handName,
    actions,
    inRange: normalized.weight > 0,
    rangeWeight: normalized.weight,
  };
}
