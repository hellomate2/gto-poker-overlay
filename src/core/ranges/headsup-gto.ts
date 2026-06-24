// ============================================================
// Heads-Up (2-player) preflop GTO ranges for NLHE.
//
// These charts approximate solved heads-up NLHE equilibria for a
// ~100bb cash / deep-stacked match. They are intended as a practical,
// reasonable approximation of the published HU solver outputs (e.g.
// PioSOLVER / GTO Wizard HU solutions) rather than an exact import.
//
// IMPORTANT heads-up positional note:
//   In heads-up play the Button IS the Small Blind and acts FIRST
//   preflop. So 'SB-RFI' here is the HU Button open (very wide), and the
//   Big Blind acts last preflop facing that open ('BB-vs-open-SB').
//
// Cell format matches greenline-gto.ts:
//   'raise' | 'call' | 'fold' | 'allin'        — pure action (100%)
//   ['raise', 'fold']                          — 50/50 mixed strategy
//   { weight, actions: { raise, call, ... } }  — weighted mixed strategy
// ============================================================

import type { Cell, Chart } from './greenline-gto';

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;

/** All 169 canonical hand group names ('AA','AKs','AKo', ...). */
export function allHandNames(): string[] {
  const names: string[] = [];
  for (let i = RANKS.length - 1; i >= 0; i--) {
    for (let j = RANKS.length - 1; j >= 0; j--) {
      if (i === j) {
        names.push(`${RANKS[i]}${RANKS[j]}`); // pair
      } else if (i > j) {
        names.push(`${RANKS[i]}${RANKS[j]}s`); // suited
      } else {
        names.push(`${RANKS[j]}${RANKS[i]}o`); // offsuit
      }
    }
  }
  return names;
}

// --------------------------------------------------------------
// Helpers to build wide ranges concisely.
// --------------------------------------------------------------

/** Build a chart from a default action plus per-hand overrides. */
function buildChart(defaultCell: Cell, overrides: Record<string, Cell>): Chart {
  const chart: Chart = {};
  for (const h of allHandNames()) {
    chart[h] = overrides[h] ?? defaultCell;
  }
  return chart;
}

// ============================================================
// 1) HU BUTTON (=Small Blind) OPEN — RFI
// The HU button raises a very wide range (~84%). Only the very
// worst offsuit junk is folded. Sizing typically 2-2.5bb.
// ============================================================

// The few offsuit trash hands the HU button folds (~16% folded).
const HU_SB_FOLDS: Record<string, Cell> = {
  // Offsuit trash with no high-card/connector value.
  '72o': 'fold', '73o': 'fold', '74o': 'fold', '62o': 'fold', '63o': 'fold',
  '64o': 'fold', '52o': 'fold', '53o': 'fold', '42o': 'fold', '32o': 'fold',
  '82o': 'fold', '83o': 'fold', '92o': 'fold', '93o': 'fold',
  // Marginal offsuit hands raised only part of the time.
  '84o': ['raise', 'fold'], '85o': ['raise', 'fold'], '94o': ['raise', 'fold'],
  '95o': ['raise', 'fold'], 'T2o': ['raise', 'fold'], 'T3o': ['raise', 'fold'],
  'J2o': ['raise', 'fold'], 'J3o': ['raise', 'fold'], '54o': ['raise', 'fold'],
};

const SB_RFI: Chart = buildChart('raise', HU_SB_FOLDS);

// ============================================================
// 2) BIG BLIND DEFENSE vs the HU Button open.
// BB faces a wide open and defends very wide: a polarized mix of
// 3-bets (raise), flat calls, and folds. Premiums and some
// suited/Ax bluffs 3-bet; broadways/pairs/suited hands call; the
// worst offsuit hands fold.
// ============================================================

const BB_VS_OPEN_SB: Chart = buildChart('call', {
  // --- Value 3-bets (premiums) ---
  'AA': 'raise', 'KK': 'raise', 'QQ': 'raise', 'JJ': 'raise',
  'AKs': 'raise', 'AKo': 'raise', 'AQs': 'raise', 'AQo': 'raise',
  'AJs': 'raise', 'ATs': 'raise', 'KQs': 'raise', 'TT': 'raise',
  // --- Mixed value/3-bet on strong-ish hands ---
  'AJo': ['raise', 'call'], 'KQo': ['raise', 'call'], 'KJs': ['raise', 'call'],
  '99': ['raise', 'call'], 'KTs': ['raise', 'call'], 'QJs': ['raise', 'call'],
  // --- 3-bet bluffs (suited wheel aces, suited connectors, suited Kx) ---
  'A5s': 'raise', 'A4s': 'raise', 'A3s': 'raise', 'A2s': 'raise',
  'K5s': 'raise', 'K4s': 'raise', 'K3s': 'raise', 'K2s': 'raise',
  '76s': ['raise', 'call'], '65s': ['raise', 'call'], '54s': ['raise', 'call'],
  // --- Folds: the worst offsuit junk (BB still folds bottom ~10%) ---
  '72o': 'fold', '73o': 'fold', '62o': 'fold', '63o': 'fold', '52o': 'fold',
  '42o': 'fold', '32o': 'fold', '82o': 'fold', '92o': 'fold', '83o': 'fold',
  '74o': ['call', 'fold'], '64o': ['call', 'fold'], '53o': ['call', 'fold'],
  '93o': ['call', 'fold'], 'J2o': ['call', 'fold'],
});

// ============================================================
// 3) HU BUTTON (=SB) facing a BB 3-bet.
// The original raiser now decides 4-bet / call / fold. Premiums
// 4-bet for value, some suited wheel aces 4-bet as bluffs, a wide
// band of broadways/pairs/suited hands flat call, the rest fold.
// ============================================================

const SB_VS_3BET_BB: Chart = buildChart('fold', {
  // --- Value 4-bets ---
  'AA': 'allin', 'KK': 'allin', 'QQ': 'raise', 'AKs': 'allin', 'AKo': 'raise',
  'JJ': 'raise', 'AQs': 'raise',
  // --- 4-bet bluffs (suited wheel aces) ---
  'A5s': 'raise', 'A4s': 'raise', 'A3s': ['raise', 'fold'],
  // --- Flat calls: broadways, pairs, suited connectors, suited Ax/Kx ---
  'AQo': 'call', 'AJs': 'call', 'AJo': 'call', 'ATs': 'call', 'ATo': 'call',
  'A9s': 'call', 'A8s': 'call', 'A7s': 'call', 'A6s': 'call', 'A2s': 'call',
  'KQs': 'call', 'KQo': 'call', 'KJs': 'call', 'KJo': 'call', 'KTs': 'call',
  'K9s': 'call', 'QJs': 'call', 'QJo': 'call', 'QTs': 'call', 'Q9s': 'call',
  'JTs': 'call', 'J9s': 'call', 'T9s': 'call', 'T8s': 'call', '98s': 'call',
  '87s': 'call', '76s': 'call', '65s': 'call', '54s': 'call',
  'TT': 'call', '99': 'call', '88': 'call', '77': 'call', '66': 'call',
  '55': 'call', '44': 'call', '33': 'call', '22': 'call',
  'KTo': 'call', 'QTo': 'call', 'JTo': 'call',
});

// ============================================================
// Exported charts. Keys follow gto-advisor.ts conventions:
//   <heroPos>-RFI, <heroPos>-vs-open-<villain>, <heroPos>-vs-3bet-<villain>
// In HU the Button = SB, so HU keys reuse the SB/BB labels.
// ============================================================

export const charts: Record<string, Chart> = {
  'SB-RFI': SB_RFI,
  'BB-vs-open-SB': BB_VS_OPEN_SB,
  'SB-vs-3bet-BB': SB_VS_3BET_BB,
};
