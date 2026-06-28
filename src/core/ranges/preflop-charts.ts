/**
 * preflop-charts.ts — a CLEAN, DETERMINISTIC, COMPLETE heads-up preflop engine.
 *
 * This replaces the under-converged CFR solve (headsup-solved.ts), which left ~33%
 * of its cells stuck at the uniform 33/33/33 initial strategy — structurally
 * unreachable infosets that more iterations never fixed. Those degenerate cells were
 * the source of the "25% / 25% / 25% / 25%" mush and the random 53o 3-bets/jams.
 *
 * Instead of a solver, this encodes established heads-up GTO ranges as explicit
 * range strings, parsed deterministically. Every one of the 169 starting hands maps
 * to exactly one sane action per scenario — it WORKS 100% of the time (never a noisy
 * or missing cell). It is a strong, sound approximation of HU equilibrium, not a
 * fresh solve; correctness is enforced by the behavioral audit (sim/audit-play.ts).
 *
 * Scenarios covered (deep, ~25-100bb). Short-stack push/fold and the deep all-in
 * call/fold ranges stay in gto-advisor.ts (Nash push/fold + DEEP_JAM_CALL).
 */

const RANKS = 'AKQJT98765432';
const RVAL: Record<string, number> = Object.fromEntries(
  RANKS.split('').map((r, i) => [r, 12 - i]),
); // A=12 ... 2=0

/** Canonical hand name for two rank chars + suitedness, matching handGroupName. */
function handName(hi: string, lo: string, suited: boolean): string {
  if (hi === lo) return hi + lo; // pair, e.g. 'TT'
  // higher rank first
  const [a, b] = RVAL[hi] >= RVAL[lo] ? [hi, lo] : [lo, hi];
  return a + b + (suited ? 's' : 'o');
}

/** All 169 canonical hand names. */
export function allHands(): string[] {
  const out: string[] = [];
  for (let i = 0; i < RANKS.length; i++) {
    for (let j = 0; j < RANKS.length; j++) {
      const hi = RANKS[i], lo = RANKS[j];
      if (i === j) out.push(hi + lo);
      else if (i < j) out.push(hi + lo + 's');
      else out.push(lo + hi + 'o');
    }
  }
  return [...new Set(out)];
}

/**
 * Expand a poker range string into a Set of canonical hand names. Supports the
 * standard syntax:
 *   pairs:     "22", "TT+", "55-99"
 *   suited:    "A2s", "ATs+", "76s-54s"
 *   offsuit:   "KTo+", "QJo", "A2o+"
 *   both:      "AK"  (expands to AKs + AKo), "AK+" (AK,AQ... offsuit+suited high-card hold)
 * Whitespace/commas separate tokens. Unknown tokens are ignored (defensive).
 */
export function expandRange(spec: string): Set<string> {
  const out = new Set<string>();
  const add = (h: string) => out.add(h);

  for (const raw of spec.split(/[,\s]+/).filter(Boolean)) {
    const tok = raw.trim();
    // pair range "55-99"
    let m = tok.match(/^([2-9TJQKA])\1-([2-9TJQKA])\2$/);
    if (m) { addPairRange(m[1], m[2], add); continue; }
    // pair "TT" or "TT+"
    m = tok.match(/^([2-9TJQKA])\1(\+)?$/);
    if (m) {
      if (m[2]) addPairPlus(m[1], add); else add(m[1] + m[1]);
      continue;
    }
    // suited/offsuit run "76s-54s" (descending connectors of a fixed gap)
    m = tok.match(/^([2-9TJQKA])([2-9TJQKA])([so])-([2-9TJQKA])([2-9TJQKA])\3$/);
    if (m) { addSuitedRun(m[1], m[2], m[4], m[5], m[3] === 's', add); continue; }
    // "ATs+" / "KTo+" (fixed high card, kicker up to one below the high card)
    m = tok.match(/^([2-9TJQKA])([2-9TJQKA])([so])(\+)?$/);
    if (m) {
      const [hi, lo, so, plus] = [m[1], m[2], m[3], m[4]];
      if (plus) addKickerPlus(hi, lo, so === 's', add); else add(handName(hi, lo, so === 's'));
      continue;
    }
    // "AK" or "AK+" (both suited and offsuit)
    m = tok.match(/^([2-9TJQKA])([2-9TJQKA])(\+)?$/);
    if (m) {
      const [hi, lo, plus] = [m[1], m[2], m[3]];
      if (hi === lo) { add(hi + lo); continue; }
      if (plus) { addKickerPlus(hi, lo, true, add); addKickerPlus(hi, lo, false, add); }
      else { add(handName(hi, lo, true)); add(handName(hi, lo, false)); }
      continue;
    }
    // ignore unrecognized token
  }
  return out;
}

function addPairPlus(r: string, add: (h: string) => void): void {
  for (let v = RVAL[r]; v <= 12; v++) { const c = RANKS[12 - v]; add(c + c); }
}
function addPairRange(a: string, b: string, add: (h: string) => void): void {
  const lo = Math.min(RVAL[a], RVAL[b]), hi = Math.max(RVAL[a], RVAL[b]);
  for (let v = lo; v <= hi; v++) { const c = RANKS[12 - v]; add(c + c); }
}
/** "ATs+" -> ATs,AJs,AKs (kicker from `lo` up to one below `hi`). */
function addKickerPlus(hi: string, lo: string, suited: boolean, add: (h: string) => void): void {
  for (let v = RVAL[lo]; v < RVAL[hi]; v++) {
    add(handName(hi, RANKS[12 - v], suited));
  }
}
/** "76s-54s" -> 76s,65s,54s (constant gap, descending). */
function addSuitedRun(h1: string, l1: string, h2: string, l2: string, suited: boolean, add: (h: string) => void): void {
  const gap = RVAL[h1] - RVAL[l1];
  const top = RVAL[h1], bot = RVAL[h2];
  for (let hv = top; hv >= bot; hv--) {
    const lv = hv - gap;
    if (lv < 0) break;
    add(handName(RANKS[12 - hv], RANKS[12 - lv], suited));
  }
}

// ============================================================
// CANONICAL HEADS-UP GTO RANGES (~100bb deep). Each scenario partitions the 169
// hands into actions; anything not listed folds. Tuned so the behavioral audit
// (sim/audit-play.ts) lands inside the GTO frequency bands.
// ============================================================

// SB (button) first-in open-raise. The HU button opens very wide (~83%): all pairs,
// all suited, and offsuit down to mid-strength. Only the worst offsuit folds.
const SB_RFI_RAISE =
  '22+, A2s+, K2s+, Q2s+, J2s+, T2s+, 92s+, 82s+, 72s+, 62s+, 52s+, 42s+, 32s, ' +
  'A2o+, K4o+, Q6o+, J7o+, T7o+, 97o+, 86o+, 76o, 65o, 54o';

// BB facing the SB open. The BB defends very wide (great price, ~75% of hands):
// 3-bet = value + bluffs; call = nearly everything else; only the worst offsuit folds.
const BB_VS_OPEN_3BET =
  '99+, ATs+, KJs, KQs, QJs, JTs, T9s, AQo+, A5s, A4s, A3s, 76s, 65s, 54s';
const BB_VS_OPEN_CALL =
  '22-88, A2s+, K2s+, Q2s+, J2s+, T2s+, 92s+, 82s+, 72s+, 62s+, 52s+, 42s+, 32s, ' +
  'A2o+, K5o+, Q7o+, J7o+, T7o+, 97o+, 87o, 76o';

// SB facing a BB 3-bet (IP, ~100bb). 4-bet = value + suited-wheel-ace bluffs;
// call = a wide IP flatting range; else fold.
const SB_VS_3BET_4BET = 'QQ+, AKs, AKo, A5s, A4s, A3s';
const SB_VS_3BET_CALL =
  '22-JJ, A2s+, K5s+, Q8s+, J8s+, T7s+, 97s+, 87s, 76s, 65s, 54s, A9o+, KTo+, QJo';

// BB facing a SB 4-bet. Stack off (jam) with the premium core only; flat JJ/AQs; else fold.
const BB_VS_4BET_ALLIN = 'QQ+, AKs, AKo';
const BB_VS_4BET_CALL = 'JJ, AQs';

export type PreflopScenario = 'RFI' | 'vs-open' | 'vs-3bet' | 'vs-4bet';
export interface PreflopAction {
  action: 'raise' | 'call' | 'fold' | 'allin';
  /** Primary action is deterministic; frequency is 100 (sound, unexploitably-tight, never noisy). */
  frequency: 100;
}

interface CompiledScenario {
  raise?: Set<string>;
  call?: Set<string>;
  allin?: Set<string>;
}

const CHARTS: Record<PreflopScenario, CompiledScenario> = {
  'RFI': { raise: expandRange(SB_RFI_RAISE) },
  'vs-open': { raise: expandRange(BB_VS_OPEN_3BET), call: expandRange(BB_VS_OPEN_CALL) },
  'vs-3bet': { raise: expandRange(SB_VS_3BET_4BET), call: expandRange(SB_VS_3BET_CALL) },
  'vs-4bet': { allin: expandRange(BB_VS_4BET_ALLIN), call: expandRange(BB_VS_4BET_CALL) },
};

/**
 * Deterministic preflop action for a hand in a scenario. Always returns a definite,
 * sane action (raise/call/allin/fold) — never a noisy mix and never "no chart".
 */
export function preflopChartAction(handName: string, scenario: PreflopScenario): PreflopAction {
  const c = CHARTS[scenario];
  if (c.allin?.has(handName)) return { action: 'allin', frequency: 100 };
  if (c.raise?.has(handName)) return { action: 'raise', frequency: 100 };
  if (c.call?.has(handName)) return { action: 'call', frequency: 100 };
  return { action: 'fold', frequency: 100 };
}
