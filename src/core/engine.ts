import {
  GameState, BotDecision, BotSettings, DEFAULT_SETTINGS,
  ActionType, StrategyDistribution, Street, Card,
} from '../types/poker';
import { cardToId, handGroupName, rankIndex } from './cfr/card-utils';
import { quickEquity } from './equity/monte-carlo';
import { RFI_RANGES, THREE_BET_RANGES, getHandFrequency } from './ranges/preflop';
import { getGTOAdvice } from './ranges/gto-advisor';
import { OpponentTracker } from './exploit/tracker';
import { PlayerProfiler } from './exploit/profiler';
import { ExploitAdjuster } from './exploit/adjuster';

// ============================================================
// GTO Decision Engine
// Based on solver heuristics: board texture sizing, geometric
// bets, SPR awareness, proper value/bluff ratios, position play
// ============================================================

type BoardTexture = 'dry' | 'semi_wet' | 'wet' | 'very_wet' | 'monotone' | 'paired_dry' | 'paired_wet';

interface BoardAnalysis {
  texture: BoardTexture;
  isMonotone: boolean;
  isTwoTone: boolean;
  isRainbow: boolean;
  isPaired: boolean;
  isConnected: boolean;
  highCard: number; // 0-12 (2=0, A=12)
  hasAce: boolean;
  numBroadway: number; // T,J,Q,K,A count
  flushDrawPossible: boolean;
  straightDrawPossible: boolean;
}

export class DecisionEngine {
  private tracker: OpponentTracker;
  private profiler: PlayerProfiler;
  private adjuster: ExploitAdjuster;
  private settings: BotSettings;

  constructor(settings: BotSettings = DEFAULT_SETTINGS) {
    this.settings = settings;
    this.tracker = new OpponentTracker();
    this.profiler = new PlayerProfiler(this.tracker);
    this.adjuster = new ExploitAdjuster({ exploitWeight: settings.exploitWeight });
  }

  async initialize(playerNames: string[]): Promise<void> {
    await this.tracker.loadStats(playerNames);
    console.log('[GTO Bot] Engine initialized with player data');
  }

  async decide(state: GameState): Promise<BotDecision> {
    if (!state.heroCards || !state.isOurTurn) {
      return this.defaultDecision('check');
    }

    const heroCardIds: [number, number] = [
      cardToId(state.heroCards[0]),
      cardToId(state.heroCards[1]),
    ];
    const boardIds = state.communityCards.map(c => cardToId(c));
    const handName = handGroupName(heroCardIds[0], heroCardIds[1]);

    console.log(`[GTO Bot] Deciding for ${handName} on ${state.street} (pot: ${state.pot})`);

    await this.tracker.loadStats(state.players.map(p => p.name));

    const equity = quickEquity(heroCardIds, boardIds);
    console.log(`[GTO Bot] Equity: ${(equity * 100).toFixed(1)}%`);

    let decision: BotDecision;

    if (state.street === 'preflop') {
      // Prefer the solved GTO ranges (6-max, heads-up, push/fold Nash): sample a
      // single action weighted by the equilibrium frequencies so the bot mixes
      // exactly like a solver. Fall back to the heuristic when no chart covers
      // the spot.
      decision = this.decidePreflopFromGTO(state) ?? this.decidePreflop(state, heroCardIds, equity);
    } else {
      decision = this.decidePostflop(state, heroCardIds, equity);
    }

    // Apply exploit adjustments postflop only; preflop stays pure GTO so the
    // sampled equilibrium action isn't overridden.
    const villain = state.street !== 'preflop' ? this.identifyVillain(state) : null;
    if (villain) {
      const villainProfile = this.profiler.profile(villain);
      if (villainProfile.confidence > 0.1) {
        console.log(`[GTO Bot] Villain ${villain}: ${villainProfile.type} (${(villainProfile.confidence * 100).toFixed(0)}%)`);
        decision.mixedStrategy = this.adjuster.adjust(
          decision.mixedStrategy, villainProfile, state,
        );
        decision.action = this.pickBestAction(decision.mixedStrategy);
        decision.amount = this.pickBetAmount(decision.mixedStrategy, state);
      }
    }

    // Sanity checks
    decision = this.sanityCheck(decision, state, equity);

    console.log(`[GTO Bot] => ${decision.action}${decision.amount ? ' $' + decision.amount : ''} | ${decision.reasoning}`);
    return decision;
  }

  async processCompletedHand(state: GameState): Promise<void> {
    await this.tracker.processHand(state);
  }

  getPlayerProfiles() { return this.profiler.profileAll(); }
  getPlayerDisplayStats(name: string) { return this.tracker.computeDisplayStats(name); }

  // ============================================================
  // Board Texture Analysis
  // ============================================================

  private analyzeBoard(cards: Card[]): BoardAnalysis {
    if (cards.length === 0) {
      return {
        texture: 'dry', isMonotone: false, isTwoTone: false, isRainbow: true,
        isPaired: false, isConnected: false, highCard: 0, hasAce: false,
        numBroadway: 0, flushDrawPossible: false, straightDrawPossible: false,
      };
    }

    const suits = cards.map(c => c.suit);
    const ranks = cards.map(c => rankIndex(c.rank)); // 0=2, 12=A
    const rankSet = new Set(ranks);

    // Suit analysis
    const suitCounts: Record<string, number> = {};
    suits.forEach(s => { suitCounts[s] = (suitCounts[s] || 0) + 1; });
    const maxSuit = Math.max(...Object.values(suitCounts));
    const isMonotone = maxSuit >= 3;
    const isTwoTone = maxSuit === 2 && cards.length >= 3;
    const isRainbow = maxSuit === 1 || (cards.length === 3 && Object.keys(suitCounts).length === 3);

    // Pair analysis
    const isPaired = rankSet.size < cards.length;

    // Connectivity — count gaps between sorted ranks
    const sorted = [...ranks].sort((a, b) => a - b);
    let gaps = 0;
    let connected = 0;
    for (let i = 1; i < sorted.length; i++) {
      const diff = sorted[i] - sorted[i - 1];
      if (diff === 0) continue; // pair
      if (diff === 1) connected++;
      else if (diff === 2) gaps++;
      else gaps += 2;
    }
    const isConnected = connected >= 2;

    // High card analysis
    const highCard = Math.max(...ranks);
    const hasAce = ranks.includes(12);
    const numBroadway = ranks.filter(r => r >= 8).length; // T=8, J=9, Q=10, K=11, A=12

    // Draw possibilities
    const flushDrawPossible = isTwoTone || isMonotone;
    const straightDrawPossible = isConnected || gaps <= 1;

    // Classify texture
    let texture: BoardTexture;
    if (isMonotone) {
      texture = 'monotone';
    } else if (isPaired && !isConnected) {
      texture = 'paired_dry';
    } else if (isPaired && isConnected) {
      texture = 'paired_wet';
    } else if (isConnected && flushDrawPossible) {
      texture = 'very_wet';
    } else if (isConnected || flushDrawPossible) {
      texture = 'wet' ;
    } else if (gaps <= 1 || isTwoTone) {
      texture = 'semi_wet';
    } else {
      texture = 'dry';
    }

    return {
      texture, isMonotone, isTwoTone, isRainbow, isPaired, isConnected,
      highCard, hasAce, numBroadway, flushDrawPossible, straightDrawPossible,
    };
  }

  // ============================================================
  // GTO Bet Sizing by Board Texture
  // ============================================================

  private getGTOBetSize(board: BoardAnalysis, pot: number, street: Street): { size: number; frequency: number } {
    // GTO sizing heuristics from solver research:
    // Board texture determines SIZE. Range/nut advantage determines FREQUENCY.
    switch (board.texture) {
      case 'dry':
        // Dry rainbow: small bet, high frequency
        if (board.hasAce) return { size: Math.round(pot * 0.33), frequency: 0.75 };
        return { size: Math.round(pot * 0.33), frequency: 0.65 };

      case 'paired_dry':
        // Paired boards: small bet, very high frequency
        return { size: Math.round(pot * 0.25), frequency: 0.72 };

      case 'paired_wet':
        return { size: Math.round(pot * 0.50), frequency: 0.50 };

      case 'semi_wet':
        return { size: Math.round(pot * 0.50), frequency: 0.55 };

      case 'wet':
        // Moderately wet: larger bet, medium frequency
        return { size: Math.round(pot * 0.67), frequency: 0.48 };

      case 'very_wet':
        // Very wet/connected: big polarized bet, low frequency
        return { size: Math.round(pot * 0.75), frequency: 0.35 };

      case 'monotone':
        // Monotone: small bet, low frequency (nut advantage diminished)
        return { size: Math.round(pot * 0.33), frequency: 0.38 };

      default:
        return { size: Math.round(pot * 0.50), frequency: 0.50 };
    }
  }

  // ============================================================
  // Geometric Bet Sizing
  // ============================================================

  private geometricBetSize(pot: number, stack: number, streetsRemaining: number): number {
    if (streetsRemaining <= 0) return Math.round(pot * 0.67);
    const growthFactor = (pot + 2 * stack) / pot;
    const betFraction = 0.5 * (Math.pow(growthFactor, 1 / streetsRemaining) - 1);
    // Cap between 25% and 150% pot
    const capped = Math.max(0.25, Math.min(1.5, betFraction));
    return Math.round(pot * capped);
  }

  private streetsRemaining(street: Street): number {
    switch (street) {
      case 'flop': return 3;
      case 'turn': return 2;
      case 'river': return 1;
      default: return 3;
    }
  }

  // ============================================================
  // SPR (Stack-to-Pot Ratio)
  // ============================================================

  private getSPR(state: GameState): number {
    const heroStack = state.players[state.heroIndex]?.stack || 100;
    return state.pot > 0 ? heroStack / state.pot : 10;
  }

  // ============================================================
  // Postflop GTO Decision
  // ============================================================

  private decidePostflop(state: GameState, heroCards: [number, number], equity: number): BotDecision {
    const hero = state.players[state.heroIndex];
    const heroBet = hero?.currentBet || 0;
    const toCall = state.currentBet - heroBet;
    const facingBet = toCall > 0;
    const spr = this.getSPR(state);
    const board = this.analyzeBoard(state.communityCards);
    const streets = this.streetsRemaining(state.street);
    const isIP = this.isInPosition(state);

    console.log(`[GTO Bot] Board: ${board.texture} | SPR: ${spr.toFixed(1)} | IP: ${isIP} | Facing: ${facingBet ? toCall : 'nothing'}`);

    if (!facingBet) {
      return this.decidePostflopNobet(state, equity, board, spr, streets, isIP);
    } else {
      return this.decidePostflopFacingBet(state, equity, board, spr, toCall);
    }
  }

  private decidePostflopNobet(
    state: GameState, equity: number, board: BoardAnalysis,
    spr: number, streets: number, isIP: boolean,
  ): BotDecision {
    const pot = state.pot;
    const hero = state.players[state.heroIndex];
    const { size: textureBet, frequency: textureFreq } = this.getGTOBetSize(board, pot, state.street);
    const geoBet = this.geometricBetSize(pot, hero?.stack || 100, streets);
    const bb = state.bigBlind || 20;

    // Choose bet size: use texture-based for flop, geometric for later streets
    const betSize = Math.max(bb, state.street === 'flop' ? textureBet : geoBet);

    // GTO value/bluff ratio by street:
    // Flop: ~34% value, 66% bluffs. Turn: ~49% value. River: ~67% value.
    const valueThreshold = state.street === 'flop' ? 0.55 : state.street === 'turn' ? 0.60 : 0.65;
    const bluffThreshold = state.street === 'flop' ? 0.30 : state.street === 'turn' ? 0.35 : 0.40;

    // Low SPR = commit more easily
    const sprBoost = spr < 3 ? 0.10 : spr < 6 ? 0.05 : 0;

    if (equity >= valueThreshold - sprBoost) {
      // Value hand — bet at texture-appropriate frequency
      const betFreq = Math.min(0.95, textureFreq + (equity - valueThreshold) * 2);
      if (Math.random() < betFreq) {
        return {
          action: 'bet', amount: betSize, confidence: equity,
          reasoning: `Value bet ${betSize} (${board.texture}, ${(equity * 100).toFixed(0)}% eq)`,
          mixedStrategy: { fold: 0, check: 1 - betFreq, call: 0, bets: [{ amount: betSize, probability: betFreq }] },
        };
      }
      return this.defaultDecision('check', `Check strong for deception (${(equity * 100).toFixed(0)}% eq)`);
    }

    if (equity >= bluffThreshold && equity < valueThreshold - sprBoost) {
      // Medium strength — mostly check, pot control
      const checkFreq = 0.75;
      if (Math.random() > checkFreq) {
        const smallBet = Math.max(bb, Math.round(pot * 0.33));
        return {
          action: 'bet', amount: smallBet, confidence: equity,
          reasoning: `Thin bet ${smallBet} (${(equity * 100).toFixed(0)}% eq)`,
          mixedStrategy: { fold: 0, check: checkFreq, call: 0, bets: [{ amount: smallBet, probability: 1 - checkFreq }] },
        };
      }
      return this.defaultDecision('check', `Check medium (${(equity * 100).toFixed(0)}% eq)`);
    }

    // Weak hand — check, but sometimes bluff if we have blockers/equity
    if (equity > 0.20 && state.street !== 'river') {
      // Semi-bluff with some equity on non-river
      const bluffFreq = textureFreq * 0.3; // bluff at ~30% of normal frequency
      if (Math.random() < bluffFreq) {
        return {
          action: 'bet', amount: betSize, confidence: equity,
          reasoning: `Semi-bluff ${betSize} (${board.texture}, ${(equity * 100).toFixed(0)}% eq)`,
          mixedStrategy: { fold: 0, check: 1 - bluffFreq, call: 0, bets: [{ amount: betSize, probability: bluffFreq }] },
        };
      }
    }

    return this.defaultDecision('check', `Check weak (${(equity * 100).toFixed(0)}% eq)`);
  }

  private decidePostflopFacingBet(
    state: GameState, equity: number, board: BoardAnalysis,
    spr: number, toCall: number,
  ): BotDecision {
    const pot = state.pot;
    const potOdds = toCall / (pot + toCall);
    const mdf = pot / (pot + toCall); // minimum defense frequency

    console.log(`[GTO Bot] Pot odds: ${(potOdds * 100).toFixed(0)}% | MDF: ${(mdf * 100).toFixed(0)}%`);

    // SPR adjustments — low SPR means we're more committed
    const commitThreshold = spr < 2 ? 0.35 : spr < 4 ? 0.42 : 0.50;

    if (equity >= 0.70) {
      // Strong hand facing bet — raise for value
      const raiseSize = Math.round(state.currentBet * 2.5);
      const raiseFreq = equity > 0.80 ? 0.75 : 0.55;
      if (Math.random() < raiseFreq) {
        return {
          action: 'raise', amount: raiseSize, confidence: equity,
          reasoning: `Raise ${raiseSize} for value (${(equity * 100).toFixed(0)}% eq)`,
          mixedStrategy: { fold: 0, check: 0, call: 1 - raiseFreq, bets: [{ amount: raiseSize, probability: raiseFreq }] },
        };
      }
      return {
        action: 'call', confidence: equity,
        reasoning: `Slow-play call (${(equity * 100).toFixed(0)}% eq)`,
        mixedStrategy: { fold: 0, check: 0, call: 1, bets: [] },
      };
    }

    if (equity > potOdds + 0.05) {
      // Enough equity to call profitably
      return {
        action: 'call', confidence: equity,
        reasoning: `Call ${toCall} (${(equity * 100).toFixed(0)}% eq > ${(potOdds * 100).toFixed(0)}% odds)`,
        mixedStrategy: { fold: 0, check: 0, call: 1, bets: [] },
      };
    }

    if (equity > potOdds - 0.03) {
      // Borderline — randomize based on MDF
      if (Math.random() < 0.50) {
        return {
          action: 'call', confidence: equity,
          reasoning: `Borderline call ${toCall} (${(equity * 100).toFixed(0)}% eq, randomized)`,
          mixedStrategy: { fold: 0.5, check: 0, call: 0.5, bets: [] },
        };
      }
    }

    // Check if we have enough equity to semi-bluff raise
    if (equity > 0.25 && equity < 0.45 && state.street !== 'river' && Math.random() < 0.12) {
      const raiseSize = Math.round(state.currentBet * 2.5);
      return {
        action: 'raise', amount: raiseSize, confidence: equity,
        reasoning: `Check-raise bluff ${raiseSize} (${(equity * 100).toFixed(0)}% eq draw)`,
        mixedStrategy: { fold: 0.3, check: 0, call: 0.58, bets: [{ amount: raiseSize, probability: 0.12 }] },
      };
    }

    return this.defaultDecision('fold', `Fold (${(equity * 100).toFixed(0)}% eq < ${(potOdds * 100).toFixed(0)}% odds)`);
  }

  // ============================================================
  // Preflop Decision (fixed SB bug)
  // ============================================================

  /**
   * Build a preflop decision from the solved GTO ranges, sampling one action in
   * proportion to its equilibrium frequency (true mixed-strategy play). Returns
   * null when no chart covers the spot, so the caller can fall back to the
   * heuristic. The returned mixedStrategy is one-hot on the sampled action so
   * the executor clicks exactly what we sampled; the full distribution is shown
   * separately by the GTO overlay panel.
   */
  private decidePreflopFromGTO(state: GameState): BotDecision | null {
    const advice = getGTOAdvice(state);
    if (!advice || advice.actions.length === 0) return null;
    const total = advice.actions.reduce((s, a) => s + a.frequency, 0);
    if (total <= 0) return null;

    // Weighted sample over the equilibrium frequencies.
    let r = Math.random() * total;
    let chosen = advice.actions[0];
    for (const a of advice.actions) {
      r -= a.frequency;
      if (r <= 0) { chosen = a; break; }
    }

    const hero = state.players[state.heroIndex];
    const bb = state.bigBlind || 20;
    const facingRaise = state.currentBet > bb;
    const facing3bet = this.isFacing3Bet(state);
    const label = chosen.action;
    const freq = chosen.frequency / 100;
    const reasoning = `${advice.scenario}: ${advice.hand} ${label} (${Math.round(chosen.frequency)}% GTO)`;

    if (/fold/i.test(label)) {
      return { action: 'fold', confidence: freq, reasoning,
        mixedStrategy: { fold: 1, check: 0, call: 0, bets: [] } };
    }
    if (/call/i.test(label)) {
      return { action: 'call', confidence: freq, reasoning,
        mixedStrategy: { fold: 0, check: 0, call: 1, bets: [] } };
    }
    if (/all[- ]?in/i.test(label)) {
      return { action: 'allin', amount: hero.stack, confidence: freq, reasoning,
        mixedStrategy: { fold: 0, check: 0, call: 0, bets: [{ amount: Infinity, probability: 1 }] } };
    }

    // Raise / 3-bet / 4-bet: size by tier, capped to the hero's stack.
    let size: number;
    if (facing3bet) size = Math.round(state.currentBet * 2.3);
    else if (facingRaise) size = Math.round(state.currentBet * 3);
    else size = Math.round(bb * 2.5);
    size = Math.min(size, hero.stack + (hero.currentBet || 0));

    return { action: 'raise', amount: size, confidence: freq, reasoning,
      mixedStrategy: { fold: 0, check: 0, call: 0, bets: [{ amount: size, probability: 1 }] } };
  }

  private decidePreflop(state: GameState, heroCards: [number, number], equity: number): BotDecision {
    const hero = state.players[state.heroIndex];
    const position = hero.position;
    const heroBet = hero.currentBet || 0;
    const toCall = state.currentBet - heroBet;
    const facingRaise = state.currentBet > state.bigBlind;
    const facingThreeBet = this.isFacing3Bet(state);
    const bb = state.bigBlind || 20;

    // SB ALWAYS has to act — can NEVER check preflop
    const canCheckForFree = position === 'BB' && !facingRaise;

    if (!facingRaise) {
      // Unopened pot
      const range = RFI_RANGES[position] || RFI_RANGES['CO'];
      const freq = getHandFrequency(range, heroCards[0], heroCards[1]);

      if (freq > 0 && Math.random() < freq) {
        const raiseSize = position === 'SB' ? bb * 3 : bb * 2.5;
        return {
          action: 'raise', amount: raiseSize, confidence: freq,
          reasoning: `RFI ${position} (${(freq * 100).toFixed(0)}%)`,
          mixedStrategy: { fold: 0, check: 0, call: 0, bets: [{ amount: raiseSize, probability: 1 }] },
        };
      }

      if (canCheckForFree) {
        return this.defaultDecision('check', `BB check`);
      }

      if (position === 'SB') {
        // SB not in raise range — complete with decent equity, fold trash
        if (equity >= 0.38) {
          return {
            action: 'call', confidence: equity,
            reasoning: `SB complete (${(equity * 100).toFixed(0)}% eq)`,
            mixedStrategy: { fold: 0, check: 0, call: 1, bets: [] },
          };
        }
        return this.defaultDecision('fold', `SB fold (${(equity * 100).toFixed(0)}% eq)`);
      }

      return this.defaultDecision('fold', `Fold ${position}`);
    }

    // Facing a raise
    if (!facingThreeBet) {
      const threeBetRange = this.getApplicable3BetRange(state);
      const threeBetFreq = threeBetRange ? getHandFrequency(threeBetRange, heroCards[0], heroCards[1]) : 0;

      if (threeBetFreq > 0 && Math.random() < threeBetFreq) {
        const size = state.currentBet * 3;
        return {
          action: 'raise', amount: size, confidence: threeBetFreq,
          reasoning: `3-bet ${position} (${(threeBetFreq * 100).toFixed(0)}%)`,
          mixedStrategy: { fold: 0, check: 0, call: 0.15, bets: [{ amount: size, probability: 0.85 }] },
        };
      }

      // Calling range
      const potOdds = toCall / (state.pot + toCall);
      if (equity > potOdds + 0.05 || equity > 0.45) {
        return {
          action: 'call', confidence: equity,
          reasoning: `Call ${toCall} (${(equity * 100).toFixed(0)}% eq)`,
          mixedStrategy: { fold: 0, check: 0, call: 1, bets: [] },
        };
      }

      // Borderline — randomize
      if (equity > potOdds - 0.04) {
        if (Math.random() < 0.45) {
          return {
            action: 'call', confidence: equity,
            reasoning: `Borderline call ${toCall} (randomized)`,
            mixedStrategy: { fold: 0.55, check: 0, call: 0.45, bets: [] },
          };
        }
      }

      return this.defaultDecision('fold', `Fold vs raise (${(equity * 100).toFixed(0)}% eq)`);
    }

    // Facing 3-bet+
    if (equity > 0.55) {
      const size = state.currentBet * 2.5;
      return {
        action: 'raise', amount: size, confidence: equity,
        reasoning: `4-bet (${(equity * 100).toFixed(0)}% eq)`,
        mixedStrategy: { fold: 0, check: 0, call: 0.2, bets: [{ amount: size, probability: 0.8 }] },
      };
    } else if (equity > 0.42) {
      return {
        action: 'call', confidence: equity,
        reasoning: `Call 3-bet (${(equity * 100).toFixed(0)}% eq)`,
        mixedStrategy: { fold: 0.2, check: 0, call: 0.8, bets: [] },
      };
    }

    return this.defaultDecision('fold', `Fold vs 3-bet (${(equity * 100).toFixed(0)}% eq)`);
  }

  // ============================================================
  // Sanity Checks
  // ============================================================

  private sanityCheck(decision: BotDecision, state: GameState, equity: number): BotDecision {
    const heroBet = state.players[state.heroIndex]?.currentBet || 0;
    const toCall = state.currentBet - heroBet;
    const facingBet = toCall > 0;

    // Never fold when check is free
    if (decision.action === 'fold' && !facingBet) {
      decision.action = 'check';
      decision.reasoning += ' [free check]';
    }

    // Never check with 80%+ equity — always bet
    if (decision.action === 'check' && !facingBet && equity >= 0.80) {
      const betSize = Math.max(state.bigBlind, Math.round(state.pot * 0.67));
      decision.action = 'bet';
      decision.amount = betSize;
      decision.reasoning = `Must bet ${betSize} (${(equity * 100).toFixed(0)}% eq) [sanity]`;
      decision.mixedStrategy = { fold: 0, check: 0.05, call: 0, bets: [{ amount: betSize, probability: 0.95 }] };
    }

    // Never fold with 65%+ equity
    if (decision.action === 'fold' && equity >= 0.65) {
      decision.action = 'call';
      decision.reasoning += ' [too strong to fold]';
    }

    return decision;
  }

  // ============================================================
  // Helpers
  // ============================================================

  private isInPosition(state: GameState): boolean {
    const hero = state.players[state.heroIndex];
    const posOrder: Record<string, number> = { SB: 0, BB: 1, UTG: 2, MP: 3, CO: 4, BTN: 5 };
    const heroOrder = posOrder[hero.position] || 0;
    const villainOrders = state.players
      .filter((p, i) => i !== state.heroIndex && !p.isSittingOut)
      .map(p => posOrder[p.position] || 0);
    return villainOrders.every(v => heroOrder > v);
  }

  private defaultDecision(action: ActionType, reasoning: string = ''): BotDecision {
    return {
      action, confidence: 0.5,
      reasoning: reasoning || `Default ${action}`,
      mixedStrategy: {
        fold: action === 'fold' ? 1 : 0,
        check: action === 'check' ? 1 : 0,
        call: action === 'call' ? 1 : 0,
        bets: [],
      },
    };
  }

  private pickBestAction(strat: StrategyDistribution): ActionType {
    let best: ActionType = 'fold';
    let bestProb = strat.fold;
    if (strat.check > bestProb) { best = 'check'; bestProb = strat.check; }
    if (strat.call > bestProb) { best = 'call'; bestProb = strat.call; }
    const totalBet = strat.bets.reduce((s, b) => s + b.probability, 0);
    if (totalBet > bestProb) best = 'raise';
    return best;
  }

  private pickBetAmount(strat: StrategyDistribution, state: GameState): number | undefined {
    if (strat.bets.length === 0) return undefined;
    let best = strat.bets[0];
    for (const b of strat.bets) { if (b.probability > best.probability) best = b; }
    if (best.amount === Infinity) return state.players[state.heroIndex]?.stack || 0;
    return Math.round(best.amount);
  }

  private identifyVillain(state: GameState): string | null {
    const actions = state.actionHistory[state.street] || [];
    for (let i = actions.length - 1; i >= 0; i--) {
      if (actions[i].playerName !== state.players[state.heroIndex]?.name) {
        return actions[i].playerName;
      }
    }
    return state.players.find((p, i) => i !== state.heroIndex && !p.isSittingOut)?.name || null;
  }

  private isFacing3Bet(state: GameState): boolean {
    let raises = 0;
    for (const a of state.actionHistory.preflop) {
      if (a.type === 'raise' || a.type === 'allin') raises++;
    }
    return raises >= 2;
  }

  private getApplicable3BetRange(state: GameState) {
    const hero = state.players[state.heroIndex];
    const opener = state.actionHistory.preflop.find(a => a.type === 'raise');
    if (!opener) return null;
    const openerPlayer = state.players.find(p => p.name === opener.playerName);
    if (!openerPlayer) return null;
    const key = `${hero.position}_vs_${openerPlayer.position}`;
    return THREE_BET_RANGES[key] || THREE_BET_RANGES['BB_vs_BTN'];
  }

  updateSettings(settings: Partial<BotSettings>): void {
    this.settings = { ...this.settings, ...settings };
    if (settings.exploitWeight !== undefined) {
      this.adjuster.updateConfig({ exploitWeight: settings.exploitWeight });
    }
  }
}
