import { GameState, Position, Action as GameAction, Street } from '../../types/poker';
import { cardToId, handGroupName } from '../cfr/card-utils';
import { charts as greenlineCharts, Cell, Chart } from './greenline-gto';
import { charts as pekarstasCharts } from './pekarstas-gto';

function lookupChart(key: string): Chart | undefined {
  return greenlineCharts[key] || pekarstasCharts[key];
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

function detectScenario(state: GameState): ScenarioResult | null {
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

  if (raises === 0) {
    // Unopened — RFI
    if (heroPos === 'BB') return null; // BB checks, not RFI
    const key = `${heroPos}-RFI`;
    if (lookupChart(key)) {
      return { scenario: 'RFI', chartKey: key, label: `${heroPos} Open (RFI)` };
    }
    return null;
  }

  if (raises === 1 && lastRaiserPos) {
    // Facing a single open
    const key = `${heroPos}-vs-open-${lastRaiserPos}`;
    if (lookupChart(key)) {
      return { scenario: 'vs-open', chartKey: key, label: `${heroPos} vs ${lastRaiserPos} Open` };
    }
    // Try ISO (isolation) key
    const isoKey = `${heroPos}-ISO`;
    if (lookupChart(isoKey)) {
      return { scenario: 'vs-open', chartKey: isoKey, label: `${heroPos} ISO Raise` };
    }
    return null;
  }

  if (raises === 2 && lastRaiserPos) {
    // Hero opened, facing 3-bet
    const threeBetter = secondRaiserPos || lastRaiserPos;
    const key = `${heroPos}-vs-3bet-${threeBetter}`;
    if (lookupChart(key)) {
      return { scenario: 'vs-3bet', chartKey: key, label: `${heroPos} vs ${threeBetter} 3-Bet` };
    }
    return null;
  }

  if (raises >= 3) {
    // Facing 4-bet
    const key = `${heroPos}-vs-4bet-${lastRaiserPos}`;
    if (lookupChart(key)) {
      return { scenario: 'vs-4bet', chartKey: key, label: `${heroPos} vs ${lastRaiserPos} 4-Bet` };
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

  const scenarioResult = detectScenario(state);
  if (!scenarioResult) {
    return {
      scenario: 'No GTO chart for this spot',
      hand: handName,
      actions: [],
      inRange: false,
      rangeWeight: 0,
    };
  }

  const chart = lookupChart(scenarioResult.chartKey);
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
