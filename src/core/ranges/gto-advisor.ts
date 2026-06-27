import { GameState, Position, Action as GameAction, Street } from '../../types/poker';
import { cardToId, handGroupName } from '../cfr/card-utils';
import { charts as greenlineCharts, Cell, Chart } from './greenline-gto';
import { charts as pekarstasCharts } from './pekarstas-gto';
import { charts as headsupCharts } from './headsup-gto';
import { charts as headsupSolvedCharts } from './headsup-solved';
import { shoveRange, callRange } from './pushfold-nash';

// Effective-stack threshold (in big blinds) at or below which the short-stack
// push/fold Nash recommendation is surfaced. Pure jam/fold is only correct very
// short; above ~10bb heads-up you have a raise/fold (and limp/3-bet) game, so we
// keep this conservative and defer to the open-raise charts above it. (At 18bb,
// for example, a hand like K6s is a small open, not a shove.)
const PUSHFOLD_MAX_BB = 10;

// Hands strong enough to CALL OFF a deep (>25bb) preflop all-in. Stacking off
// ~30-100bb vs a 3-bet jam is a tight premium decision — NOT the wide "peel a
// small 3-bet" range from the vs-3bet chart. Without this, the bot read a 48bb
// jam as a normal 3-bet and "called" with hands like T9s — a stack-off punt.
export const DEEP_JAM_CALL = new Set([
  'AA', 'KK', 'QQ', 'JJ', 'TT', '99',
  'AKs', 'AKo', 'AQs', 'AQo', 'AJs', 'KQs',
]);

// VERY DEEP (50bb+) preflop all-in: stacking off 50-100bb is a premium-only
// decision. Nobody balanced open/4-bet jams 50bb+, so by default (no read) we
// assume a value-heavy jam and call only with the premium core. The wider
// DEEP_JAM_CALL above is correct for a 25-40bb 4-bet jam (where the jamming range
// is much wider), NOT for a 100bb stack-off where TT/99/AQ/KQs are crushed.
export const DEEP_JAM_CALL_50PLUS = new Set([
  'AA', 'KK', 'QQ', 'JJ', 'AKs', 'AKo',
]);

/**
 * Look up a preflop chart by key. When the table is heads-up (exactly two
 * active players) the SOLVED heads-up charts (headsup-solved.ts, a real CFR+
 * Nash solve over the HU preflop tree) are consulted FIRST so HU keys like
 * 'SB-RFI'/'BB-vs-open-SB'/'SB-vs-3bet-BB'/'BB-vs-4bet-SB' use the solved
 * equilibrium. The old hand-tuned headsup-gto.ts is kept only as a fallback for
 * any key the solver does not cover. Multiway behavior is unchanged.
 */
function lookupChart(key: string, headsUp = false): Chart | undefined {
  if (headsUp) {
    if (headsupSolvedCharts[key]) return headsupSolvedCharts[key];
    if (headsupCharts[key]) return headsupCharts[key];
  }
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

/**
 * Hero effective stack in big blinds = total chips each player has IN THIS HAND
 * (remaining stack + chips already committed this hand), capped by the largest
 * opponent. Counting committed chips is essential: when villain is all-in their
 * remaining stack is 0, and ignoring their committed bet would compute a 0bb
 * effective stack and skip the facing-a-jam logic entirely.
 */
function heroEffectiveStackBB(state: GameState): number {
  const hero = state.players[state.heroIndex];
  const bb = state.bigBlind || 1;
  const heroTotal = hero.stack + (hero.currentBet || 0);
  const oppTotals = state.players
    .filter((p, i) => i !== state.heroIndex && !p.isSittingOut)
    .map(p => p.stack + (p.currentBet || 0));
  const maxOpp = oppTotals.length ? Math.max(...oppTotals) : heroTotal;
  return Math.min(heroTotal, maxOpp) / bb;
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

    // Treat the spot as a JAM to call/fold if villain is all-in OR the bet to
    // match is a huge fraction of the effective stack (robust to the scraper not
    // tagging type 'allin'). Calling here commits the stack, so it must use a
    // jam-call range — NOT the vs-3bet chart's "peel a small 3-bet" call.
    const bb = state.bigBlind || 1;
    const curBetBB = (state.currentBet || 0) / bb;
    const nearJam = facingAllIn || (curBetBB >= 0.6 * effStackBB && curBetBB > 12);

    if (nearJam) {
      // <=25bb: exact Nash call range (calling wide is correct short).
      // 25-50bb: wider 4-bet-jam stack-off range (T9s folds, but TT/AQ/KQs call).
      // >50bb: premium core only — a 100bb preflop jam is a value-heavy spot and
      // TT/99/AQ/KQs are crushed (the deep call-off punt).
      const inCall = effStackBB <= 25
        ? callRange(effStackBB).has(handName)
        : effStackBB <= 50
          ? DEEP_JAM_CALL.has(handName)
          : DEEP_JAM_CALL_50PLUS.has(handName);
      return {
        scenario: `Facing all-in — call/fold (${effStackBB.toFixed(0)}bb eff)`,
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
