import { GameState, Position, Action as GameAction, Street } from '../../types/poker';
import { cardToId, handGroupName, handGroupIndex } from '../cfr/card-utils';
import { charts as greenlineCharts, Cell, Chart } from './greenline-gto';
import { charts as pekarstasCharts } from './pekarstas-gto';
import { charts as headsupCharts } from './headsup-gto';
import { charts as headsupSolvedCharts } from './headsup-solved';
import { shoveRange, callRange } from './pushfold-nash';
import { preflopChartAction, PreflopScenario as PFScenario } from './preflop-charts';
import { isHeadsUpTable, liveVillainIndexes } from './range-tracker';
import { JAM_EQUITY, TOP_EQUITY, TOP_FRACTIONS } from './jam-equity';

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

/** Combos in hand class `idx` (handGroupIndex order: 13 pairs, 78 suited, 78 offsuit). */
function classCombos(idx: number): number {
  return idx < 13 ? 6 : idx < 91 ? 4 : 12;
}

/** Map 7+ handed position names onto the 6-max chart keys (as range-tracker chartPos does). */
function chartPos6(pos: Position | undefined | null): Position | null {
  if (!pos) return null;
  if (pos === 'UTG1') return 'UTG';
  if (pos === 'MP1') return 'MP';
  return pos;
}

/** Equity of hand class `idx` vs the top `frac` of combos (linear interpolation on TOP_FRACTIONS). */
function equityVsTop(idx: number, frac: number): number {
  const row = TOP_EQUITY[idx];
  const f = Math.min(1, Math.max(TOP_FRACTIONS[0], frac));
  let g = 0;
  while (g < TOP_FRACTIONS.length - 2 && TOP_FRACTIONS[g + 1] < f) g++;
  const lo = TOP_FRACTIONS[g], hi = TOP_FRACTIONS[g + 1];
  const t = hi > lo ? (f - lo) / (hi - lo) : 0;
  return (row[g] + t * (row[g + 1] - row[g])) / 1000;
}

const SIX_MAX_ORDER: Position[] = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];

/** Nearest positions first, as range-tracker openerFallbacks does for vs-open charts. */
function nearestPositions(p: Position): Position[] {
  const i = SIX_MAX_ORDER.indexOf(p);
  if (i < 0) return [p];
  const out: Position[] = [p];
  for (let d = 1; d < SIX_MAX_ORDER.length; d++) {
    if (i - d >= 0) out.push(SIX_MAX_ORDER[i - d]);
    if (i + d < SIX_MAX_ORDER.length) out.push(SIX_MAX_ORDER[i + d]);
  }
  return out;
}

/**
 * The jammer's estimated range, as a JAM_EQUITY key, from the preflop line.
 * A shove is logged as a raise by the scraper, so this reads the jammer's last
 * aggressive action and how many raises came before it:
 *   0 raises before  -> '<jammer>-RFI'                 (an open-jam)
 *   1 raise before   -> '<jammer>-vs-open-<opener>'    (a 3-bet jam; nearest
 *                       opener with a chart if the exact one is missing)
 *   2 raises before, jammer opened -> '<jammer>-vs-3bet-<3-bettor>' (a 4-bet jam)
 * When the jammer has no parsed aggressive action (the PokerNow log only shows
 * recent lines) it falls back to 'UTG-RFI', the tightest open range in the
 * pack, so a missing history makes hero call tighter, never looser. Returns
 * null when no table fits (a 5-bet jam, or a 4-bet jam by a cold 4-bettor).
 */
function jammerRangeKey(state: GameState, jammerIdx: number): string | null {
  const jammer = state.players[jammerIdx];
  const posOf = (name: string): Position | null =>
    chartPos6(state.players.find(p => p.name === name)?.position);
  const acts = state.actionHistory.preflop || [];
  let raises = 0;
  let openerName: string | null = null;
  let threeBettorName: string | null = null;
  let jamRaisesBefore = -1;
  for (const a of acts) {
    if (a.type !== 'raise' && a.type !== 'allin' && a.type !== 'bet') continue;
    if (a.playerName === jammer.name) jamRaisesBefore = raises;
    if (raises === 0) openerName = a.playerName;
    else if (raises === 1) threeBettorName = a.playerName;
    raises++;
  }
  const jp = chartPos6(jammer.position);
  if (jamRaisesBefore < 0 || !jp) return 'UTG-RFI';
  if (jamRaisesBefore === 0) {
    return JAM_EQUITY[`${jp}-RFI`] ? `${jp}-RFI` : 'UTG-RFI';
  }
  if (jamRaisesBefore === 1 && openerName) {
    const op = posOf(openerName);
    if (op) {
      for (const o of nearestPositions(op)) {
        if (o === jp) continue;
        const k = `${jp}-vs-open-${o}`;
        if (JAM_EQUITY[k]) return k;
      }
    }
    return null;
  }
  if (jamRaisesBefore === 2 && openerName === jammer.name && threeBettorName) {
    const tp = posOf(threeBettorName);
    const k = tp ? `${jp}-vs-3bet-${tp}` : '';
    return JAM_EQUITY[k] ? k : null;
  }
  return null;
}

/**
 * Call-or-fold against a jam. Returns whether to continue and a short label
 * for the range that decided it.
 *
 *   - Heads-up TABLE, or a ring table where the SB open-jams into hero's BB
 *     (everyone else folded): the heads-up SB-vs-BB push/fold Nash call table
 *     (pushfold-nash.ts, the HoldemResources/SnapShove HU Nash grids) is the
 *     equilibrium for exactly this spot, so it is used up to 25bb.
 *   - Any other jam <= 25bb at a ring table: chip-EV pot odds against the
 *     jammer's chart range (jam-equity.ts: the 6-max chart range for the
 *     jammer's position and line, equity from the cached 169x169 all-in
 *     matrix). With k live players still to act behind hero, any of them can
 *     wake up and overcall or re-jam. A lower bound on calling EV that holds
 *     whatever they then do: if anyone behind continues, hero loses at most the
 *     call (folding to a re-jam, or losing a 3-way pot); otherwise hero has its
 *     heads-up equity e vs the jammer. So
 *         EV(call) >= P0 * (e * W - C) - (1 - P0) * C = P0 * e * W - C,
 *     and hero calls iff e >= C / (P0 * W), where C is the chips to call, W the
 *     pot hero can win once it calls, and P0 = prod_j (1 - c_j) the chance
 *     nobody behind continues. c_j is the share of combos with which player j
 *     would call the jam heads-up at j's own price (hero's call not counted).
 *     That is an estimate, not a bound: hero's call adds money for j, but j
 *     then has to beat two hands. Given P0, the inequality above is a true
 *     lower bound, so the rule only calls when calling is +EV even if every
 *     action behind costs hero its whole call.
 *   - Someone already called the jam: there is no 3-way equity table in the
 *     repo, so only the premium core continues (DEEP_JAM_CALL_50PLUS, the
 *     tightest stack-off set; what the baseline used for these spots).
 *   - 25-50bb: DEEP_JAM_CALL (the existing 25-50bb heads-up stack-off set) when
 *     nobody is behind and nobody has called; otherwise the 50bb+ premium core.
 *   - Over 50bb: DEEP_JAM_CALL_50PLUS, as before.
 */
function jamCallDecision(
  state: GameState, live: number[], c1: number, c2: number, handName: string,
  jamEffBB: number, headsUp: boolean,
): { inCall: boolean; basis: string } {
  const cb = state.currentBet || 0;
  const hero = state.players[state.heroIndex];

  if (headsUp) {
    // Heads-up table: unchanged (HU Nash call table short, stack-off sets deep).
    const inCall = jamEffBB <= 25
      ? callRange(jamEffBB).has(handName)
      : jamEffBB <= 50 ? DEEP_JAM_CALL.has(handName) : DEEP_JAM_CALL_50PLUS.has(handName);
    return { inCall, basis: jamEffBB <= 25 ? 'HU Nash' : 'stack-off set' };
  }

  // The jammer: the live villain with the biggest bet (ties: the last one to
  // act aggressively in the log). Players already all-in or matching the bet
  // are in the pot; the rest with chips left still act after hero.
  const bettors = live.filter(i => (state.players[i].currentBet || 0) >= cb && cb > 0);
  const acts = state.actionHistory.preflop || [];
  let jammerIdx = bettors.length ? bettors[0] : -1;
  for (const a of acts) {
    if (a.type !== 'raise' && a.type !== 'allin' && a.type !== 'bet') continue;
    const i = bettors.find(b => state.players[b].name === a.playerName);
    if (i !== undefined) jammerIdx = i;
  }
  const callers = live.filter(i => i !== jammerIdx && (
    (state.players[i].currentBet || 0) >= cb || ((state.players[i].stack || 0) <= 0 && (state.players[i].currentBet || 0) > 0)));
  const behind = live.filter(i => i !== jammerIdx && !callers.includes(i) && (state.players[i].stack || 0) > 0);

  if (jamEffBB > 25) {
    const alone = callers.length === 0 && behind.length === 0;
    return alone
      ? { inCall: DEEP_JAM_CALL.has(handName), basis: 'stack-off set' }
      : { inCall: DEEP_JAM_CALL_50PLUS.has(handName), basis: 'premium core, players behind' };
  }
  if (jammerIdx < 0 || callers.length > 0) {
    return { inCall: DEEP_JAM_CALL_50PLUS.has(handName), basis: 'premium core, multiway' };
  }

  const jammer = state.players[jammerIdx];
  const raisedBefore = acts.some(a =>
    (a.type === 'raise' || a.type === 'allin' || a.type === 'bet') && a.playerName !== jammer.name);
  if (chartPos6(jammer.position) === 'SB' && hero.position === 'BB' && behind.length === 0 && !raisedBefore) {
    return { inCall: callRange(jamEffBB).has(handName), basis: 'HU Nash SB vs BB' };
  }

  const key = jammerRangeKey(state, jammerIdx);
  const table = key ? JAM_EQUITY[key] : undefined;
  if (!table) return { inCall: DEEP_JAM_CALL_50PLUS.has(handName), basis: 'premium core, no range' };

  // Pot odds. C = chips hero adds; W = what hero can win once it calls: its own
  // capped total plus every other seat's bet up to that cap (folded blinds are
  // dead money). state.pot is not used: the scraper's pot may or may not
  // include this street's bets, and leaving it out only makes the price worse.
  const heroBet = hero.currentBet || 0;
  const cap = Math.min(totalChips(hero), cb);
  const toCall = Math.max(0, cap - heroBet);
  let win = cap;
  state.players.forEach((p, i) => { if (i !== state.heroIndex) win += Math.min(p.currentBet || 0, cap); });
  if (toCall <= 0 || win <= 0) return { inCall: true, basis: key! };

  // Players behind. Player j is modelled as continuing (overcalling) with the
  // hands that would call the jam heads-up at j's OWN price (hero's call not
  // yet in the pot), a share c_j of all combos, taken as the top c_j of hands.
  // If j continues, hero can win up to `extra` more chips from j.
  const heroIdx = handGroupIndex(c1, c2);
  const eqJam = table[heroIdx] / 1000;
  const others: { c: number; eqVs: number; extra: number }[] = [];
  for (const j of behind) {
    const pj = state.players[j];
    const capJ = Math.min(totalChips(pj), cb);
    const callJ = capJ - (pj.currentBet || 0);
    let winJ = capJ;
    state.players.forEach((p, i) => { if (i !== j) winJ += Math.min(p.currentBet || 0, capJ); });
    if (callJ <= 0 || winJ <= 0) continue;
    const needJ = callJ / winJ;
    let cont = 0;
    for (let i = 0; i < 169; i++) if (table[i] / 1000 >= needJ) cont += classCombos(i);
    const c = cont / 1326;
    if (c <= 0) continue;
    const extra = Math.max(0, Math.min(totalChips(pj), cap) - (pj.currentBet || 0));
    others.push({ c, eqVs: equityVsTop(heroIdx, c), extra });
  }

  // EV(call) over every subset S of players behind who continue:
  //   sum_S P(S) * eqJam * prod_{j in S} eqVs_j * (W + sum_{j in S} extra_j) - C.
  // Hero's share of a multiway pot is approximated by the product of its
  // heads-up equities (winning against each opponent is positively correlated
  // through hero's final hand, so the product tends to understate it), and
  // side pots are folded into the cap. With nobody behind this is plain pot
  // odds: eqJam * W >= C.
  let ev = 0;
  const k = others.length;
  for (let mask = 0; mask < (1 << k); mask++) {
    let prob = 1, eq = eqJam, pot = win;
    for (let j = 0; j < k; j++) {
      const o = others[j];
      if (mask & (1 << j)) { prob *= o.c; eq *= o.eqVs; pot += o.extra; }
      else prob *= 1 - o.c;
    }
    ev += prob * eq * pot;
  }
  const inCall = ev - toCall >= 0;
  return { inCall, basis: `${key} eq, ${behind.length} behind` };
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
    // match is a huge fraction of the effective stack. The live scraper never
    // logs type 'allin' (PokerNow prints a shove as "raises to X", see the
    // fidelity notes in sim/ring.ts), so a bettor left with a 0 stack is the
    // reliable all-in signal; without it a 10bb shove (below the 12bb floor of
    // the size test) was read as a normal open and played from the vs-open
    // chart. Calling here commits the stack, so it must use a jam-call range,
    // NOT the vs-3bet chart's "peel a small 3-bet" call.
    const bb = state.bigBlind || 1;
    const curBetBB = (state.currentBet || 0) / bb;
    const jamEffBB = jamEffectiveStackBB(state, live);
    const bettorAllIn = (state.currentBet || 0) > bb && live.some(i => {
      const p = state.players[i];
      return (p.currentBet || 0) >= state.currentBet && (p.stack || 0) <= 0;
    });
    const nearJam = facingAllIn || bettorAllIn || (curBetBB >= 0.6 * jamEffBB && curBetBB > 12);

    if (nearJam && jamEffBB > 0) {
      const { inCall, basis } = jamCallDecision(state, live, c1, c2, handName, jamEffBB, headsUp);
      // A call that does not put hero all-in is a CALL, not a jam: the engine
      // turns an advised 'All-In' into a 3x isolation raise whenever its own
      // effective stack (deepest live villain, players still to act included) is
      // over 25bb, which re-opened the pot to a 30bb raise against a 10bb shove.
      const cbNow = state.currentBet || 0;
      const jamTotals = live
        .filter(i => (state.players[i].currentBet || 0) >= cbNow)
        .map(i => totalChips(state.players[i]));
      const heroCovers = totalChips(hero) > Math.max(cbNow, ...jamTotals);
      return {
        scenario: `Facing all-in — call/fold (${jamEffBB.toFixed(0)}bb eff) [${basis}]`,
        hand: handName,
        actions: inCall
          ? [{ action: heroCovers ? 'Call' : 'All-In', frequency: 100 }]
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
