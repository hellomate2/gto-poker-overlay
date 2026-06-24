// ============================================================
// Core Poker Types for PokerNow GTO Bot
// ============================================================

export type Suit = 'h' | 'd' | 'c' | 's';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  rank: Rank;
  suit: Suit;
}

/** Numeric encoding: rank 0-12 (2=0, A=12), suit 0-3 (h,d,c,s). Card id = rank * 4 + suit (0-51) */
export type CardId = number;

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

export type Position = 'SB' | 'BB' | 'UTG' | 'UTG1' | 'MP' | 'MP1' | 'CO' | 'BTN';

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

export interface Action {
  type: ActionType;
  amount?: number; // chip amount for bet/raise/allin
  playerName: string;
}

export interface Player {
  name: string;
  stack: number;
  position: Position;
  isDealer: boolean;
  isSittingOut: boolean;
  seatIndex: number;
  isHero: boolean; // is this us?
  currentBet: number; // amount bet in current street
  hasActed: boolean;
  holeCards?: [Card, Card]; // only known for hero or at showdown
}

export interface GameState {
  // Table info
  tableId: string;
  handNumber: number;
  street: Street;
  pot: number;
  sidePots: number[];

  // Cards
  heroCards: [Card, Card] | null;
  communityCards: Card[];

  // Players
  players: Player[];
  heroIndex: number;
  dealerIndex: number;
  activePlayerIndex: number; // whose turn it is

  // Betting
  currentBet: number; // highest bet on current street
  minRaise: number;
  bigBlind: number;
  smallBlind: number;

  // Actions this hand
  actionHistory: Record<Street, Action[]>;

  // Meta
  isOurTurn: boolean;
  timestamp: number;
}

export interface BotDecision {
  action: ActionType;
  amount?: number; // for bet/raise
  confidence: number; // 0-1
  reasoning: string;
  mixedStrategy: StrategyDistribution;
}

export interface StrategyDistribution {
  fold: number;
  check: number;
  call: number;
  bets: { amount: number; probability: number }[];
}

// ============================================================
// Opponent Tracking Types
// ============================================================

export interface PlayerStats {
  playerName: string;
  handsPlayed: number;

  // Preflop
  vpipCount: number; // voluntarily put $ in pot
  pfrCount: number; // preflop raise
  threeBetCount: number;
  threeBetOpportunity: number;
  foldToThreeBetCount: number;
  foldToThreeBetOpportunity: number;
  coldCallCount: number;
  coldCallOpportunity: number;

  // Postflop
  cbetFlopCount: number;
  cbetFlopOpportunity: number;
  cbetTurnCount: number;
  cbetTurnOpportunity: number;
  foldToCbetFlopCount: number;
  foldToCbetFlopOpportunity: number;
  foldToCbetTurnCount: number;
  foldToCbetTurnOpportunity: number;

  // Aggression
  betCount: number;
  raiseCount: number;
  callCount: number;
  foldCount: number;

  // Showdown
  wentToShowdownCount: number;
  wonAtShowdownCount: number;
  showdownOpportunity: number;

  // Timing
  lastSeen: number;
  firstSeen: number;
}

export type PlayerType = 'unknown' | 'nit' | 'tag' | 'lag' | 'calling_station' | 'maniac';

export interface PlayerProfile {
  playerName: string;
  type: PlayerType;
  confidence: number; // 0-1, based on sample size
  stats: {
    vpip: number;
    pfr: number;
    threeBet: number;
    foldToThreeBet: number;
    cbetFlop: number;
    foldToCbetFlop: number;
    aggressionFactor: number;
    wtsd: number;
    wsd: number;
  };
}

// ============================================================
// CFR Types
// ============================================================

export interface InfoSet {
  key: string; // unique identifier for this information set
  regretSum: Float64Array;
  strategySum: Float64Array;
  numActions: number;
}

export interface GameNode {
  type: 'chance' | 'player' | 'terminal';
  player?: number; // 0 or 1 for player nodes
  actions?: string[]; // available actions
  children?: Map<string, GameNode>;
  utility?: number; // for terminal nodes
}

export interface SolverResult {
  strategy: StrategyDistribution;
  ev: number; // expected value
  iterations: number;
  timeMs: number;
}

// ============================================================
// Settings Types
// ============================================================

export interface BotSettings {
  autoPlay: boolean;
  advisoryMode: boolean;
  actionDelayMin: number; // ms
  actionDelayMax: number; // ms
  exploitWeight: number; // 0-1, how much to deviate from GTO
  showHud: boolean;
  showEquity: boolean;
  confirmAllIn: boolean;
  cfrIterations: number;
  cfrTimeLimit: number; // ms
}

export const DEFAULT_SETTINGS: BotSettings = {
  // Auto-play on: the bot decides and clicks for the seat it is in, pausing
  // ~2s before each action so it plays at a human pace. Turn it off in the
  // popup for advisory-only (recommendations without clicking).
  autoPlay: true,
  advisoryMode: false,
  actionDelayMin: 1500,
  actionDelayMax: 2500,
  exploitWeight: 0.5,
  showHud: true,
  showEquity: true,
  confirmAllIn: false,
  cfrIterations: 10000,
  cfrTimeLimit: 1500,
};
