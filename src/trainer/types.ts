// ============================================================
// Shared types for the GTO Trainer
// ============================================================

/** A postflop spot solved by TexasSolver (or an illustrative sample). */
export interface SolvedSpot {
  id: string;
  title: string;
  street: 'flop' | 'turn' | 'river';
  board: string[]; // e.g. ["Qs","Jh","2h"]
  pot: number; // in big blinds
  effectiveStack: number; // in big blinds
  toAct: 'ip' | 'oop'; // which player is making this decision
  actions: string[]; // action keys, e.g. ["check","bet_33","bet_75"]
  actionLabels?: Record<string, string>; // pretty labels for buttons
  hands: SolvedHand[];
  source: 'TexasSolver' | 'sample';
  note?: string;
}

export interface SolvedHand {
  hand: string; // combo, e.g. "AhKh"
  freqs: Record<string, number>; // action key -> frequency (0..1)
  ev?: Record<string, number>; // optional per-action EV
}

/** Running performance stats for a session. */
export interface TrainerStats {
  hands: number;
  scoreSum: number; // sum of per-decision GTO scores (0..1)
  streak: number;
  bestStreak: number;
  mistakes: { label: string; you: string; gto: string; score: number }[];
}
