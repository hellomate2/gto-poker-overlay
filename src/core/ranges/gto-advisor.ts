import { GameState, Position, Action as GameAction, Street } from '../../types/poker';
import { cardToId, handGroupName } from '../cfr/card-utils';
import { charts as greenlineCharts, Cell, Chart } from './greenline-gto';
import { charts as pekarstasCharts } from './pekarstas-gto';
import { charts as headsupCharts } from './headsup-gto';
import { charts as headsupSolvedCharts } from './headsup-solved';
import { shoveRange, callRange } from './pushfold-nash';
import { preflopChartAction, PreflopScenario as PFScenario } from './preflop-charts';
import { isHeadsUpTable, liveVillainIndexes } from './range-tracker';

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

/** Chips a player has IN THIS HAND: remaining stack + chips committed this street. */
function totalChips(p: { stack: number; currentBet: number }): number {
  return p.stack + (p.currentBet || 0);
}

/**
 * Hero effective stack in big blinds against the deepest LIVE opponent (not
 * folded, not sitting out), counting committed chips. Counting committed chips
 * is essential: when villain is all-in their remaining stack is 0, and ignoring
 * their committed bet would compute a 0bb effective stack and skip the
 * facing-a-jam logic entirely. Folded players are excluded: a deep stack that
 * already folded cannot win hero's chips (at a heads-up table nobody has folded
 * when hero acts preflop, so heads-up this is unchanged).
 */
function heroEffectiveStackBB(state: GameState, live: number[]): number {
  const hero = state.players[state.heroIndex];
  const bb = state.bigBlind || 1;
  const heroTotal = totalChips(hero);
  const oppTotals = live.map(i => totalChips(state.players[i]));
  const maxOpp = oppTotals.length ? Math.max(...oppTotals) : heroTotal;
  return Math.min(heroTotal, maxOpp) / bb;
}

/**
 * Effective stack in big blinds for a call-or-fold decision against a jam: the
 * chips hero can lose to the player(s) who made the current bet (live villains
 * whose committed bet is the table's current bet), capped by hero's stack. A
 * 100bb hero facing a 2bb jam is a 2bb decision. Measuring against the deepest
 * opponent at the table instead (a folded player or a blind still to act) made
 * that spot use the 50bb+ premium-only range. Heads-up the only villain is the
 * bettor, so this equals heroEffectiveStackBB there.
 */
function jamEffectiveStackBB(state: GameState, live: number[]): number {
  const cb = state.currentBet || 0;
  const bettors = live.filter(i => (state.players[i].currentBet || 0) >= cb && cb > 0);
  if (bettors.length === 0) return heroEffectiveStackBB(state, live);
  const hero = state.players[state.heroIndex];
  const bb = state.bigBlind || 1;
  const maxBettor = Math.max(...bettors.map(i => totalChips(state.players[i])));
  return Math.min(totalChips(hero), maxBettor) / bb;
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

/**
 * A solved cell is "noisy" when 3+ actions carry near-equal frequency (e.g.
 * call 33 / raise 33 / allin 33) — that's a non-converged / low-frequency node, not
 * a real mixed strategy. Sampling it produces random spew (3-betting / jamming trash
 * like 53o). Detect it so the caller can collapse it to a sound fold facing a raise.
 */
function isNoisyCell(cell: Cell): boolean {
  const freqs = Object.values(normalizeCell(cell).actions).filter(f => f > 5);
  if (freqs.length < 3) return false;
  return Math.max(...freqs) - Math.min(...freqs) < 15;
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

  // Heads-up means a heads-up TABLE (two players dealt in). A 6-max pot that
  // folds down to two players keeps the 6-max charts: the HU engine's SB open
  // and BB defense ranges are far wider than the 6-max charts for spots such as
  // BB vs a UTG open or SB first-in after four folds.
  const headsUp = isHeadsUpTable(state);
  const live = liveVillainIndexes(state);
  const effStackBB = heroEffectiveStackBB(state, live);

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
    const jamEffBB = jamEffectiveStackBB(state, live);
    const nearJam = facingAllIn || (curBetBB >= 0.6 * jamEffBB && curBetBB > 12);

    if (nearJam && jamEffBB > 0) {
      // <=25bb: exact Nash call range (calling wide is correct short).
      // 25-50bb: wider 4-bet-jam stack-off range (T9s folds, but TT/AQ/KQs call).
      // >50bb: premium core only — a 100bb preflop jam is a value-heavy spot and
      // TT/99/AQ/KQs are crushed (the deep call-off punt).
      const inCall = jamEffBB <= 25
        ? callRange(jamEffBB).has(handName)
        : jamEffBB <= 50
          ? DEEP_JAM_CALL.has(handName)
          : DEEP_JAM_CALL_50PLUS.has(handName);
      return {
        scenario: `Facing all-in — call/fold (${jamEffBB.toFixed(0)}bb eff)`,
        hand: handName,
        actions: inCall
          ? [{ action: 'All-In', frequency: 100 }]
          : [{ action: 'Fold', frequency: 100 }],
        inRange: inCall,
        rangeWeight: inCall ? 100 : 0,
      };
    }

    // The shove table is the heads-up SB-vs-BB equilibrium, so it only applies
    // when exactly one opponent is left to act: the SB folded to at a ring
    // table, or the SB/button at a heads-up table. A 6-max BTN open-jam with
    // both blinds behind faces two callers and needs a much tighter range.
    if (firstIn && live.length === 1 && effStackBB <= PUSHFOLD_MAX_BB && (hero.position === 'SB' || hero.position === 'BTN')) {
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

  // MULTIWAY (3+ players): the HU engine's ranges are far too wide for 6-max
  // positions (a 78% HU button open is spew from UTG). Consume the hand-tuned
  // 6-max chart packs (greenline/pekarstas — these never had the CFR degeneracy)
  // directly: cell weight scales in-range vs fold, noisy cells collapse to fold
  // facing a raise.
  if (!headsUp) {
    const chart = lookupChart(scenarioResult.chartKey, false);
    const cell = chart?.[handName];
    if (!cell) {
      return {
        scenario: scenarioResult.label, hand: handName,
        actions: [{ action: 'Fold', frequency: 100 }], inRange: false, rangeWeight: 0,
      };
    }
    if (isNoisyCell(cell) && scenarioResult.scenario !== 'RFI') {
      return {
        scenario: scenarioResult.label, hand: handName,
        actions: [{ action: 'Fold', frequency: 100 }], inRange: false, rangeWeight: 0,
      };
    }
    const norm = normalizeCell(cell);
    const w = norm.weight / 100;
    const acts = Object.entries(norm.actions)
      .map(([a, f]) => ({ action: a[0].toUpperCase() + a.slice(1), frequency: f * w }))
      .filter(a => a.frequency > 0);
    if (w < 1) acts.push({ action: 'Fold', frequency: (1 - w) * 100 });
    acts.sort((a, b) => b.frequency - a.frequency);
    return {
      scenario: scenarioResult.label, hand: handName,
      actions: acts, inRange: w > 0, rangeWeight: norm.weight,
    };
  }

  // HEADS-UP: DETERMINISTIC PREFLOP ENGINE. The action comes from clean, complete
  // HU GTO range charts (preflop-charts.ts) instead of the under-converged CFR
  // solve, whose ~33% degenerate "33/33/33" cells produced the 25/25/25/25 mush and
  // random trash 3-bets/jams. detectScenario still CLASSIFIES the spot (RFI /
  // vs-open / vs-3bet / vs-4bet) and labels it; we take the action from the engine.
  // Every hand resolves to one sane action — no noise, no missing cells.
  const eng = preflopChartAction(handName, scenarioResult.scenario as PFScenario);
  const label: Record<string, string> = {
    raise: scenarioResult.scenario === 'RFI' ? 'Raise' : scenarioResult.scenario === 'vs-open' ? '3-Bet' : '4-Bet',
    call: 'Call',
    allin: 'All-In',
    fold: 'Fold',
  };
  const inRange = eng.action !== 'fold';
  return {
    scenario: scenarioResult.label,
    hand: handName,
    actions: [{ action: label[eng.action], frequency: 100 }],
    inRange,
    rangeWeight: inRange ? 100 : 0,
  };
}
