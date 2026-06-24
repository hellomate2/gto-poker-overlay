// ============================================================
// Short-stack heads-up Nash push/fold equilibrium ranges.
//
// When effective stacks are short (roughly <= 20-25bb), the
// game-theoretically optimal preflop strategy for the SB/Button
// collapses to a simple jam-or-fold decision, and the BB's reply
// collapses to call-or-fold. These ranges are the well-known Nash
// equilibrium jam/fold charts.
//
// References:
//   - Sklansky & Chubukov, "Sklansky-Chubukov rankings" (the
//     unexploitable open-jam ordering of hands by stack depth).
//   - The HeadsUp Push/Fold Nash equilibrium charts popularized by
//     HoldemResources / SnapShove (jam vs call equilibrium grids).
//
// The thresholds below are encoded as the maximum effective stack
// (in big blinds) at which a hand is still part of the range. A hand
// is in the SHOVE range at effStack S iff S <= shoveThreshold(hand).
// A hand is in the CALL range iff S <= callThreshold(hand). Premiums
// have very high thresholds (always jam/call); weak hands only enter
// the range as stacks get very short. This makes the ranges
// monotonic in stack depth: shorter stacks are supersets of deeper
// ones.
// ============================================================

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;

/** All 169 canonical hand group names. */
function allHandNames(): string[] {
  const names: string[] = [];
  for (let i = RANKS.length - 1; i >= 0; i--) {
    for (let j = RANKS.length - 1; j >= 0; j--) {
      if (i === j) names.push(`${RANKS[i]}${RANKS[j]}`);
      else if (i > j) names.push(`${RANKS[i]}${RANKS[j]}s`);
      else names.push(`${RANKS[j]}${RANKS[i]}o`);
    }
  }
  return names;
}

// Effective-stack range this table is defined for (big blinds).
export const MIN_PUSHFOLD_BB = 1;
export const MAX_PUSHFOLD_BB = 25;

// A threshold of Infinity means "always in range" (premiums).
const ALWAYS = Infinity;

// ============================================================
// SHOVE (SB/Button open-jam) thresholds.
// Max effective stack (bb) at which the hand is still a jam.
// Hands not listed are never open-jammed (threshold 0).
// Values reflect the standard HU Nash jam grid: AA/KK/etc jam at any
// depth; trash like 72o only enters around 2bb.
// ============================================================

const SHOVE_THRESHOLD: Record<string, number> = {
  // Pairs — all jam very deep.
  'AA': ALWAYS, 'KK': ALWAYS, 'QQ': ALWAYS, 'JJ': ALWAYS, 'TT': ALWAYS,
  '99': ALWAYS, '88': ALWAYS, '77': ALWAYS, '66': ALWAYS, '55': ALWAYS,
  '44': ALWAYS, '33': ALWAYS, '22': ALWAYS,

  // Ax suited — jam at any reasonable short-stack depth.
  'AKs': ALWAYS, 'AQs': ALWAYS, 'AJs': ALWAYS, 'ATs': ALWAYS, 'A9s': ALWAYS,
  'A8s': ALWAYS, 'A7s': ALWAYS, 'A6s': ALWAYS, 'A5s': ALWAYS, 'A4s': ALWAYS,
  'A3s': ALWAYS, 'A2s': ALWAYS,
  // Ax offsuit.
  'AKo': ALWAYS, 'AQo': ALWAYS, 'AJo': ALWAYS, 'ATo': ALWAYS, 'A9o': 25,
  'A8o': 25, 'A7o': 22, 'A6o': 19, 'A5o': 25, 'A4o': 22, 'A3o': 20, 'A2o': 19,

  // Kx suited.
  'KQs': ALWAYS, 'KJs': ALWAYS, 'KTs': ALWAYS, 'K9s': ALWAYS, 'K8s': 25,
  'K7s': 25, 'K6s': 25, 'K5s': 25, 'K4s': 24, 'K3s': 23, 'K2s': 22,
  // Kx offsuit.
  'KQo': ALWAYS, 'KJo': 25, 'KTo': 25, 'K9o': 22, 'K8o': 16, 'K7o': 14,
  'K6o': 12, 'K5o': 11, 'K4o': 10, 'K3o': 9, 'K2o': 9,

  // Qx suited.
  'QJs': ALWAYS, 'QTs': ALWAYS, 'Q9s': 25, 'Q8s': 25, 'Q7s': 18,
  'Q6s': 17, 'Q5s': 16, 'Q4s': 15, 'Q3s': 14, 'Q2s': 13,
  // Qx offsuit.
  'QJo': 25, 'QTo': 25, 'Q9o': 16, 'Q8o': 11, 'Q7o': 8, 'Q6o': 7,
  'Q5o': 6, 'Q4o': 5, 'Q3o': 4, 'Q2o': 4,

  // Jx suited.
  'JTs': ALWAYS, 'J9s': 25, 'J8s': 25, 'J7s': 18, 'J6s': 12,
  'J5s': 11, 'J4s': 10, 'J3s': 9, 'J2s': 8,
  // Jx offsuit.
  'JTo': 25, 'J9o': 15, 'J8o': 10, 'J7o': 7, 'J6o': 4,
  'J5o': 4, 'J4o': 3, 'J3o': 3, 'J2o': 3,

  // Tx suited.
  'T9s': 25, 'T8s': 25, 'T7s': 18, 'T6s': 13, 'T5s': 8,
  'T4s': 6, 'T3s': 5, 'T2s': 5,
  // Tx offsuit.
  'T9o': 15, 'T8o': 9, 'T7o': 6, 'T6o': 4, 'T5o': 3, 'T4o': 2, 'T3o': 2, 'T2o': 2,

  // 9x suited.
  '98s': 25, '97s': 20, '96s': 13, '95s': 8, '94s': 4, '93s': 3, '92s': 3,
  // 9x offsuit.
  '98o': 12, '97o': 7, '96o': 4, '95o': 3, '94o': 2, '93o': 2, '92o': 2,

  // 8x suited.
  '87s': 22, '86s': 16, '85s': 10, '84s': 5, '83s': 3, '82s': 2,
  // 8x offsuit.
  '87o': 9, '86o': 5, '85o': 3, '84o': 2, '83o': 2, '82o': 2,

  // 7x suited.
  '76s': 20, '75s': 14, '74s': 7, '73s': 4, '72s': 2,
  // 7x offsuit.
  '76o': 7, '75o': 4, '74o': 2, '73o': 2, '72o': 2,

  // 6x suited.
  '65s': 18, '64s': 11, '63s': 5, '62s': 3,
  // 6x offsuit.
  '65o': 5, '64o': 3, '63o': 2, '62o': 2,

  // 5x suited.
  '54s': 16, '53s': 9, '52s': 4,
  // 5x offsuit.
  '54o': 4, '53o': 2, '52o': 2,

  // 4x suited.
  '43s': 8, '42s': 4,
  '43o': 2, '42o': 2,

  // 3x.
  '32s': 3, '32o': 2,
};

// ============================================================
// CALL (BB call-vs-jam) thresholds.
// Max effective stack (bb) at which the hand still calls a SB jam.
// Calling ranges are tighter than shoving ranges at the same depth
// (you need a real hand to call off), but premiums always call and
// the range widens as stacks shrink.
// ============================================================

const CALL_THRESHOLD: Record<string, number> = {
  // Pairs.
  'AA': ALWAYS, 'KK': ALWAYS, 'QQ': ALWAYS, 'JJ': ALWAYS, 'TT': ALWAYS,
  '99': ALWAYS, '88': ALWAYS, '77': 25, '66': 25, '55': 25,
  '44': 22, '33': 20, '22': 18,

  // Ax suited.
  'AKs': ALWAYS, 'AQs': ALWAYS, 'AJs': ALWAYS, 'ATs': ALWAYS, 'A9s': 25,
  'A8s': 25, 'A7s': 25, 'A6s': 22, 'A5s': 25, 'A4s': 24, 'A3s': 23, 'A2s': 22,
  // Ax offsuit.
  'AKo': ALWAYS, 'AQo': ALWAYS, 'AJo': 25, 'ATo': 25, 'A9o': 22,
  'A8o': 18, 'A7o': 16, 'A6o': 13, 'A5o': 15, 'A4o': 13, 'A3o': 12, 'A2o': 11,

  // Kx suited.
  'KQs': ALWAYS, 'KJs': 25, 'KTs': 25, 'K9s': 22, 'K8s': 17,
  'K7s': 15, 'K6s': 13, 'K5s': 12, 'K4s': 11, 'K3s': 10, 'K2s': 10,
  // Kx offsuit.
  'KQo': 25, 'KJo': 22, 'KTo': 20, 'K9o': 14, 'K8o': 9, 'K7o': 7,
  'K6o': 5, 'K5o': 5, 'K4o': 4, 'K3o': 4, 'K2o': 3,

  // Qx suited.
  'QJs': 25, 'QTs': 25, 'Q9s': 18, 'Q8s': 13, 'Q7s': 9,
  'Q6s': 8, 'Q5s': 7, 'Q4s': 6, 'Q3s': 5, 'Q2s': 5,
  // Qx offsuit.
  'QJo': 18, 'QTo': 15, 'Q9o': 9, 'Q8o': 6, 'Q7o': 4, 'Q6o': 3,
  'Q5o': 3, 'Q4o': 2, 'Q3o': 2, 'Q2o': 2,

  // Jx suited.
  'JTs': 25, 'J9s': 18, 'J8s': 13, 'J7s': 9, 'J6s': 6,
  'J5s': 5, 'J4s': 4, 'J3s': 4, 'J2s': 3,
  // Jx offsuit.
  'JTo': 14, 'J9o': 8, 'J8o': 5, 'J7o': 3, 'J6o': 2,
  'J5o': 2, 'J4o': 2, 'J3o': 2, 'J2o': 2,

  // Tx suited.
  'T9s': 18, 'T8s': 13, 'T7s': 9, 'T6s': 6, 'T5s': 4, 'T4s': 3, 'T3s': 2, 'T2s': 2,
  // Tx offsuit.
  'T9o': 8, 'T8o': 5, 'T7o': 3, 'T6o': 2, 'T5o': 2, 'T4o': 2,

  // 9x suited.
  '98s': 13, '97s': 9, '96s': 6, '95s': 4, '94s': 2, '93s': 2,
  // 9x offsuit.
  '98o': 5, '97o': 3, '96o': 2, '95o': 2,

  // 8x suited.
  '87s': 11, '86s': 8, '85s': 5, '84s': 3, '83s': 2,
  // 8x offsuit.
  '87o': 4, '86o': 2, '85o': 2,

  // 7x suited.
  '76s': 9, '75s': 6, '74s': 3, '73s': 2,
  // 7x offsuit.
  '76o': 3, '75o': 2,

  // 6x suited.
  '65s': 8, '64s': 5, '63s': 2,
  '65o': 2,

  // 5x suited.
  '54s': 7, '53s': 3, '52s': 2,

  // 4x suited.
  '43s': 3, '42s': 2,

  // 3x.
  '32s': 2,
};

function clampStack(effStackBB: number): number {
  if (effStackBB < MIN_PUSHFOLD_BB) return MIN_PUSHFOLD_BB;
  if (effStackBB > MAX_PUSHFOLD_BB) return MAX_PUSHFOLD_BB;
  return effStackBB;
}

/**
 * The SB/Button open-jam (shove) range at the given effective stack.
 * Returns the set of canonical hand names (e.g. 'AA', 'A5s', '72o')
 * that should be jammed all-in. Shorter stacks yield supersets of
 * deeper-stack ranges (monotonic).
 */
export function shoveRange(effStackBB: number): Set<string> {
  const s = clampStack(effStackBB);
  const out = new Set<string>();
  for (const h of allHandNames()) {
    const t = SHOVE_THRESHOLD[h] ?? 0;
    if (s <= t) out.add(h);
  }
  return out;
}

/**
 * The BB call-vs-jam range at the given effective stack. Returns the
 * set of canonical hand names that should call off all-in facing the
 * SB/Button jam. Monotonic in stack depth.
 */
export function callRange(effStackBB: number): Set<string> {
  const s = clampStack(effStackBB);
  const out = new Set<string>();
  for (const h of allHandNames()) {
    const t = CALL_THRESHOLD[h] ?? 0;
    if (s <= t) out.add(h);
  }
  return out;
}

/** True if `hand` is an open-jam at the given effective stack. */
export function isShove(hand: string, effStackBB: number): boolean {
  const t = SHOVE_THRESHOLD[hand] ?? 0;
  return clampStack(effStackBB) <= t;
}

/** True if `hand` calls a jam at the given effective stack. */
export function isCall(hand: string, effStackBB: number): boolean {
  const t = CALL_THRESHOLD[hand] ?? 0;
  return clampStack(effStackBB) <= t;
}
