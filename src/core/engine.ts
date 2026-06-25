import {
  GameState, BotDecision, BotSettings, DEFAULT_SETTINGS,
  ActionType, StrategyDistribution, Street, Card,
} from '../types/poker';
import { cardToId, handGroupName, rankIndex } from './cfr/card-utils';
import { quickEquity } from './equity/monte-carlo';
import { equityVsRange } from './equity/range-equity';
import { evaluateHand, HAND_CATEGORY } from './equity/hand-eval';
import { villainContinuingRange } from './postflop-strategy';
import { RFI_RANGES, THREE_BET_RANGES, getHandFrequency } from './ranges/preflop';
import { getGTOAdvice } from './ranges/gto-advisor';
import { OpponentTracker } from './exploit/tracker';
import { PlayerProfiler } from './exploit/profiler';
import { ExploitAdjuster } from './exploit/adjuster';
import { predictPostflop } from './ml/policy';
import { Spot } from './ml/features';
// NOTE: solvePostflop (the depth-limited CFR study solver) is intentionally NOT
// imported on the live hot path anymore. It computed equity vs effectively a
// random/abstract opponent and value-bet dominated hands. Live postflop now uses
// decidePostflopRanged (range-aware heuristic). The solver module and its tests
// are left untouched for offline study.

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

    // Legalize sizing: never bet/raise more than you actually have.
    decision = this.legalizeDecision(decision, state);

    console.log(`[GTO Bot] => ${decision.action}${decision.amount ? ' $' + decision.amount : ''} | ${decision.reasoning}`);
    return decision;
  }

  /**
   * Clamp every bet/raise amount to what the hero can actually put in. A raise
   * "to" amount can never exceed hero stack + chips already in front; if it
   * would, the action becomes an all-in for exactly that maximum. Also clamps
   * the amounts inside mixedStrategy (the executor samples those). No-ops when
   * the stack can't be read, so a bad read can't freeze the bot at zero.
   */
  /**
   * Round a chip amount to the table's granularity. Whole-chip games (BB is an
   * integer >= 1) round to integers; decimal-stake games ($0.25/$0.50) round to
   * cents so a 2.5bb open stays $1.25 instead of collapsing to $1.
   */
  private roundToStake(amount: number, bb: number): number {
    if (Number.isInteger(bb) && bb >= 1) return Math.round(amount);
    return Math.round(amount * 100) / 100;
  }

  private legalizeDecision(decision: BotDecision, state: GameState): BotDecision {
    const hero = state.players[state.heroIndex];
    const heroStack = hero?.stack || 0;
    if (heroStack <= 0) return decision; // unknown stack — don't clamp to zero

    const heroBet = hero.currentBet || 0;
    const maxTo = heroStack + heroBet; // total chips committed if all-in
    const bb = state.bigBlind || 1;

    // Facing a bet: you cannot "bet", only raise/call/fold, and a raise must be
    // to at least the minimum (roughly double the bet). This prevents the bot
    // from trying to "bet 402" into a 300 lead — illegal; it must raise to >=600.
    const toCall = Math.max(0, (state.currentBet || 0) - heroBet);
    const facingBet = toCall > 0;
    const minRaiseTo = facingBet
      ? Math.max(state.minRaise || 0, (state.currentBet || 0) * 2)
      : 0;
    if (facingBet && decision.action === 'bet') decision.action = 'raise';

    // Bets at or above the all-in amount become Infinity so the executor clicks
    // the dedicated All-In button. Raises are floored at the legal minimum.
    const clampBet = (amt: number): number => {
      if (amt === Infinity) return Infinity;
      const floored = facingBet ? Math.max(amt, minRaiseTo) : amt;
      return floored >= maxTo ? Infinity : this.roundToStake(floored, bb);
    };

    if ((decision.action === 'raise' || decision.action === 'bet') && decision.amount) {
      let amt = decision.amount;
      if (facingBet) amt = Math.max(amt, minRaiseTo); // never below the min raise
      if (amt >= maxTo) {
        decision.action = 'allin';
        decision.amount = maxTo;
        decision.reasoning += ' (all-in: capped to stack)';
      } else {
        decision.amount = this.roundToStake(amt, bb);
      }
    } else if (decision.action === 'allin') {
      decision.amount = maxTo;
    }

    if (decision.mixedStrategy?.bets) {
      decision.mixedStrategy.bets = decision.mixedStrategy.bets.map(b => ({
        probability: b.probability,
        amount: clampBet(b.amount),
      }));
    }

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

  private getGTOBetSize(board: BoardAnalysis, pot: number, street: Street, bb: number = 1): { size: number; frequency: number } {
    // GTO sizing heuristics: board texture determines SIZE (as a pot fraction),
    // range/nut advantage determines FREQUENCY. Rounding is stake-aware so small
    // decimal pots (e.g. $1.50 * 0.33) don't collapse to 0.
    const sz = (frac: number) => this.roundToStake(pot * frac, bb);
    switch (board.texture) {
      case 'dry':
        if (board.hasAce) return { size: sz(0.33), frequency: 0.75 };
        return { size: sz(0.33), frequency: 0.65 };
      case 'paired_dry':
        return { size: sz(0.25), frequency: 0.72 };
      case 'paired_wet':
        return { size: sz(0.50), frequency: 0.50 };
      case 'semi_wet':
        return { size: sz(0.50), frequency: 0.55 };
      case 'wet':
        return { size: sz(0.67), frequency: 0.48 };
      case 'very_wet':
        return { size: sz(0.75), frequency: 0.35 };
      case 'monotone':
        return { size: sz(0.33), frequency: 0.38 };
      default:
        return { size: sz(0.50), frequency: 0.50 };
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

  /**
   * Postflop decision (LIVE).
   *
   * Uses the transparent range-aware heuristic (decidePostflopRanged). The
   * previous implementation called the depth-limited CFR solver, which judged
   * hands vs an effectively random/abstract opponent and therefore value-bet
   * hands that were crushed by villain's real continuing range (e.g. two pair on
   * a three-flush board). decidePostflopRanged measures hero's equity vs a
   * concrete continuing range and applies explicit anti-blunder guards.
   *
   * `equity` (vs random) is no longer used for the live decision; it stays in
   * the signature for logging/compatibility with the caller and sanityCheck.
   */
  private decidePostflop(state: GameState, heroCards: [number, number], _equityVsRandom: number): BotDecision {
    // Heads-up only: the distilled net was trained on heads-up PokerBench spots.
    // For multiway pots (or any net error) fall back to the range-aware heuristic.
    const activeVillains = state.players.filter(
      (p, i) => i !== state.heroIndex && !p.isSittingOut,
    ).length;
    if (activeVillains !== 1) {
      return this.decidePostflopRanged(state, heroCards);
    }
    try {
      const netDecision = this.decidePostflopNet(state, heroCards);
      if (netDecision) return netDecision;
    } catch (e) {
      console.warn('[GTO Bot] postflop net failed, using ranged fallback', e);
    }
    return this.decidePostflopRanged(state, heroCards);
  }

  /**
   * Distilled neural-net postflop decision.
   *
   * Builds a normalized `Spot` from GameState using the SAME encodeSpot feature
   * module the training data was prepped with (no train/inference mismatch),
   * runs predictPostflop (masked to legal actions), then:
   *   - returns the argmax action,
   *   - for bet/raise, sizes via the existing board-texture sizing
   *     (getGTOBetSize) — the net only decides the action class, not the size,
   *   - sets mixedStrategy from the net's masked probabilities so the overlay
   *     and executor reflect the equilibrium distribution.
   * legalizeDecision (called later) caps any size to the hero's stack.
   * Returns null if the spot can't be built (e.g. fewer than 3 board cards).
   */
  private decidePostflopNet(state: GameState, heroCards: [number, number]): BotDecision | null {
    const board = state.communityCards;
    if (board.length < 3) return null;
    const street = state.street;
    if (street !== 'flop' && street !== 'turn' && street !== 'river') return null;

    const hero = state.players[state.heroIndex];
    const heroBet = hero?.currentBet || 0;
    const toCall = Math.max(0, state.currentBet - heroBet);
    const facingBet = toCall > 0;
    const pot = Math.max(1, state.pot);
    const isIP = this.isInPosition(state);

    const spot: Spot = {
      holeCards: heroCards,
      board: board.map(c => cardToId(c)),
      street,
      heroPos: isIP ? 'IP' : 'OOP',
      facingBet,
      toCallFrac: toCall / pot,
      // Offered size proxy: facing a bet -> the bet we'd be raising over; else
      // a default value bet of ~2/3 pot. Sizing itself is decided below; this is
      // only a feature signal mirroring how the dataset's available_moves offered
      // a single Bet/Raise size.
      offeredSizeFrac: facingBet ? toCall / pot : 0.66,
      canCheck: !facingBet,
      canBet: !facingBet,
      canCall: facingBet,
      canRaise: facingBet,
      canFold: facingBet,
      threeBetPot: this.isThreeBetPot(state),
    };

    const pred = predictPostflop(spot);
    const probs = pred.probs;
    const action = pred.action;

    // Build a StrategyDistribution from the net's masked probabilities. Bet/raise
    // share the single chosen size from board-texture sizing.
    const boardAnalysis = this.analyzeBoard(board);
    const bb = state.bigBlind || 20;
    const { size: textureSize } = this.getGTOBetSize(boardAnalysis, pot, street, bb);
    const betSize = Math.max(bb, textureSize);
    const raiseSize = Math.max(this.roundToStake(state.currentBet * 2.5, bb), state.currentBet + betSize);

    const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
    const betProb = probs.bet + probs.raise;

    // Safety guard over the net: never bet/raise a hand that cannot beat a flush
    // into a monotone / 4-flush board where hero holds no flush. The net is
    // solver-trained, but this hard rule prevents the catastrophic
    // value-bet-into-an-obvious-flush blunder even if the net is wrong here.
    const heroCat = Math.floor(
      evaluateHand([heroCards[0], heroCards[1], ...board.map(c => cardToId(c))]) / 1_000_000,
    );
    const dangerousFlushBoard =
      (boardAnalysis.isMonotone || this.isFourFlushBoard(board)) &&
      !this.heroHoldsRelevantFlush(heroCards, board);
    let finalAction = action;
    if ((action === 'bet' || action === 'raise') && dangerousFlushBoard && heroCat < HAND_CATEGORY.FLUSH) {
      finalAction = facingBet ? 'call' : 'check';
    }

    const guarded = finalAction !== action;
    const sizeForBets = finalAction === 'raise' || facingBet ? raiseSize : betSize;
    const mixedStrategy: StrategyDistribution = guarded
      ? {
          fold: probs.fold,
          check: finalAction === 'check' ? probs.check + betProb : probs.check,
          call: finalAction === 'call' ? probs.call + betProb : probs.call,
          bets: [],
        }
      : {
          fold: probs.fold,
          check: probs.check,
          call: probs.call,
          bets: betProb > 0 ? [{ amount: sizeForBets, probability: betProb }] : [],
        };

    const reasoning = guarded
      ? `net ${action}->${finalAction} (behind range on flush board)`
      : `net ${action} (f${pct(probs.fold)} k${pct(probs.check)} ` +
        `c${pct(probs.call)} b${pct(probs.bet)} r${pct(probs.raise)})`;

    switch (finalAction) {
      case 'fold':
        return { action: 'fold', amount: undefined, confidence: probs.fold, reasoning, mixedStrategy };
      case 'check':
        return { action: 'check', amount: undefined, confidence: probs.check, reasoning, mixedStrategy };
      case 'call':
        return { action: 'call', amount: undefined, confidence: probs.call, reasoning, mixedStrategy };
      case 'bet':
        return { action: 'bet', amount: betSize, confidence: probs.bet, reasoning, mixedStrategy };
      case 'raise':
        return { action: 'raise', amount: raiseSize, confidence: probs.raise, reasoning, mixedStrategy };
      default:
        return null;
    }
  }

  /** True when the preflop action contains a 3-bet+ (>=2 raises). Used as a net feature. */
  private isThreeBetPot(state: GameState): boolean {
    let raises = 0;
    for (const a of state.actionHistory.preflop || []) {
      if (a.type === 'raise' || a.type === 'allin') raises++;
    }
    return raises >= 2;
  }

  // ============================================================
  // Range-aware postflop heuristic (the anti-blunder fix)
  // ============================================================

  /**
   * Live postflop decision based on hero equity vs villain's CONTINUING RANGE.
   *
   * Formulas used (all standard, commented inline):
   *   - pot odds to call: toCall / (pot + toCall)   == B / (P + 2B)
   *   - optimal bluff fraction alpha: bet / (bet + pot)
   *   - board-texture sizing: dry -> small (~33% pot), wet -> bigger (~66-75%)
   *
   * Anti-blunder guards:
   *   - never VALUE bet/raise when eqR < 0.55
   *   - on a monotone / 4-flush board where hero does NOT hold the flush, do not
   *     value-bet non-nut hands (check/call only)
   *   - on a paired board, downgrade two-pair-type hands (don't treat as nuts)
   *   - sizes are always fractions of pot; legalizeDecision caps to stack
   */
  private decidePostflopRanged(state: GameState, heroCards: [number, number]): BotDecision {
    const hero = state.players[state.heroIndex];
    const heroBet = hero?.currentBet || 0;
    const toCall = Math.max(0, state.currentBet - heroBet);
    const facingBet = toCall > 0;
    const pot = state.pot;
    const bb = state.bigBlind || 20;
    const board = this.analyzeBoard(state.communityCards);
    const boardIds = state.communityCards.map(c => cardToId(c));

    // --- Context for the continuing-range model ---
    const activeVillains = state.players.filter(
      (p, i) => i !== state.heroIndex && !p.isSittingOut,
    ).length;
    const multiway = activeVillains > 1;
    const aggression = facingBet; // someone has bet/raised into us this street

    // --- Equity vs the concrete continuing range (THE FIX) ---
    const range = villainContinuingRange(heroCards, boardIds, { aggression, multiway });
    const eqR = equityVsRange(heroCards, boardIds, range, 3000).equity;

    // --- Hero's made-hand category and board-danger flags ---
    const heroCat = boardIds.length >= 3
      ? Math.floor(evaluateHand([heroCards[0], heroCards[1], ...boardIds]) / 1_000_000)
      : HAND_CATEGORY.HIGH_CARD;
    const heroHoldsFlush = this.heroHoldsRelevantFlush(heroCards, state.communityCards);
    // Dangerous flush board: monotone (3+) or 4-flush and hero has no flush.
    const dangerousFlushBoard =
      (board.isMonotone || this.isFourFlushBoard(state.communityCards)) && !heroHoldsFlush;
    // Paired board: two-pair-type hands are downgraded (could be counterfeited /
    // beaten by trips/boats), so don't treat them as premium value.
    const pairedBoard = board.isPaired;
    const twoPairType = heroCat === HAND_CATEGORY.TWO_PAIR;

    console.log(
      `[GTO Bot] Ranged: eqR=${(eqR * 100).toFixed(0)}% cat=${heroCat} ` +
      `combos=${range.length} flushBoard=${dangerousFlushBoard} paired=${pairedBoard} ` +
      `facing=${facingBet ? toCall : 'no'}`,
    );

    // Is hero "obviously dominated by the board"? Used to suppress value raises.
    const dominatedByBoard = dangerousFlushBoard || (pairedBoard && twoPairType);

    if (facingBet) {
      return this.rangedFacingBet(state, eqR, toCall, board, dominatedByBoard, heroCat);
    }
    return this.rangedFirstToAct(state, eqR, board, pot, bb, dangerousFlushBoard, heroCat);
  }

  /** FACING A BET: pot-odds call, value raise only when very strong & not dominated. */
  private rangedFacingBet(
    state: GameState,
    eqR: number,
    toCall: number,
    board: BoardAnalysis,
    dominatedByBoard: boolean,
    heroCat: number,
  ): BotDecision {
    const pot = state.pot;
    const bb = state.bigBlind || 1;
    // pot odds: toCall / (pot + toCall) == B / (P + 2B)
    const callThreshold = toCall / (pot + toCall);
    const buffer = 0.02; // small cushion so marginal calls aren't -EV after rake/variance
    const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

    // VALUE RAISE: only with high equity vs range AND not dominated by the board.
    if (eqR >= 0.70 && !dominatedByBoard) {
      const raiseTo = this.roundToStake(state.currentBet * 2.5, bb);
      const raiseFreq = eqR >= 0.82 ? 0.8 : 0.6;
      return {
        action: 'raise', amount: raiseTo, confidence: eqR,
        reasoning: `value raise to ${raiseTo} (${pct(eqR)} vs range)`,
        mixedStrategy: { fold: 0, check: 0, call: 1 - raiseFreq, bets: [{ amount: raiseTo, probability: raiseFreq }] },
      };
    }

    // BLUFF RAISE (low frequency): low equity but good blockers/draws (use top-pair-
    // or-worse on non-paired boards as a proxy for "has some equity/blockers").
    if (
      eqR < callThreshold && eqR > 0.20 && state.street !== 'river' &&
      heroCat <= HAND_CATEGORY.PAIR && !dominatedByBoard
    ) {
      // Bluff at a low frequency only.
      const raiseTo = this.roundToStake(state.currentBet * 2.5, bb);
      const bluffFreq = 0.10;
      return {
        action: 'raise', amount: raiseTo, confidence: eqR,
        reasoning: `bluff raise to ${raiseTo} (${pct(eqR)} vs range, blockers/draw)`,
        mixedStrategy: { fold: 1 - bluffFreq, check: 0, call: 0, bets: [{ amount: raiseTo, probability: bluffFreq }] },
      };
    }

    // CALL: equity beats pot odds (+ buffer).
    if (eqR >= callThreshold + buffer) {
      return {
        action: 'call', confidence: eqR,
        reasoning: `call ${toCall} (${pct(eqR)} vs range > ${pct(callThreshold)} odds)`,
        mixedStrategy: { fold: 0, check: 0, call: 1, bets: [] },
      };
    }

    // Otherwise FOLD.
    return {
      action: 'fold', confidence: 1 - eqR,
      reasoning: `fold (${pct(eqR)} vs range < ${pct(callThreshold)} pot odds)`,
      mixedStrategy: { fold: 1, check: 0, call: 0, bets: [] },
    };
  }

  /** CHECKED TO / FIRST TO ACT: value-bet, check medium, or bluff with equity. */
  private rangedFirstToAct(
    state: GameState,
    eqR: number,
    board: BoardAnalysis,
    pot: number,
    bb: number,
    dangerousFlushBoard: boolean,
    heroCat: number,
  ): BotDecision {
    const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
    const check = (reason: string): BotDecision =>
      this.defaultDecision('check', reason);

    // Board-texture bet sizing: dry -> ~33% pot, wet/monotone -> ~66-75% pot.
    const wet = board.texture === 'wet' || board.texture === 'very_wet' ||
      board.texture === 'semi_wet' || board.isMonotone;
    const sizeFrac = wet ? 0.66 : 0.33;
    const betSize = Math.max(bb, this.roundToStake(pot * sizeFrac, bb));
    const sizeLabel = wet ? '2/3' : '1/3';

    // ANTI-BLUNDER: on a dangerous flush board without the flush, never value-bet
    // a non-nut made hand. Just check (and call later vs pot odds).
    if (dangerousFlushBoard && heroCat < HAND_CATEGORY.FLUSH) {
      return check(`check (behind range on flush board, ${pct(eqR)} vs range)`);
    }

    // VALUE BET: eqR >= ~0.62 vs range. The hard floor of 0.55 is enforced too,
    // so we never "value bet" a sub-coinflip-vs-range hand.
    if (eqR >= 0.62 && eqR >= 0.55) {
      return {
        action: 'bet', amount: betSize, confidence: eqR,
        reasoning: `value bet ${sizeLabel} (${pct(eqR)} vs range)`,
        mixedStrategy: { fold: 0, check: 0.1, call: 0, bets: [{ amount: betSize, probability: 0.9 }] },
      };
    }

    // BLUFF: with hands that have equity to improve (draws), at frequency
    // alpha = bet / (bet + pot). Never bluff a medium MADE hand into danger.
    const alpha = betSize / (betSize + pot); // optimal bluff fraction
    const hasDrawEquity = eqR >= 0.30 && eqR < 0.55 && heroCat <= HAND_CATEGORY.PAIR;
    if (hasDrawEquity && state.street !== 'river' && !dangerousFlushBoard) {
      if (Math.random() < alpha) {
        return {
          action: 'bet', amount: betSize, confidence: eqR,
          reasoning: `semi-bluff ${sizeLabel} (${pct(eqR)} vs range, draw, alpha=${pct(alpha)})`,
          mixedStrategy: { fold: 0, check: 1 - alpha, call: 0, bets: [{ amount: betSize, probability: alpha }] },
        };
      }
      return check(`check draw (${pct(eqR)} vs range)`);
    }

    // Everything else (medium made hands, no draw): check / pot control.
    return check(`check (${pct(eqR)} vs range, medium/no value)`);
  }

  /**
   * Does hero hold a card of the suit that makes a flush on the board?
   * True when the board has 3+ of one suit and hero holds at least one of that
   * suit (4-flush board) or two of that suit (3-flush board), i.e. hero actually
   * has a made flush. Used to decide whether the flush board is "dangerous".
   */
  private heroHoldsRelevantFlush(heroCards: [number, number], community: Card[]): boolean {
    const suitCount = [0, 0, 0, 0];
    for (const c of community) suitCount[cardToId(c) % 4]++;
    const flushSuit = suitCount.findIndex(n => n >= 3);
    if (flushSuit < 0) return false;
    const heroSuited = heroCards.filter(c => c % 4 === flushSuit).length;
    const onBoard = suitCount[flushSuit];
    // 5-card flush needs hero contributions: board 3 -> need 2; board 4 -> need 1.
    if (onBoard >= 5) return true; // flush plays off the board (very rare here)
    if (onBoard === 4) return heroSuited >= 1;
    return heroSuited >= 2; // onBoard === 3
  }

  /** True when any single suit has exactly 4 cards on the board (4-flush). */
  private isFourFlushBoard(community: Card[]): boolean {
    const suitCount = [0, 0, 0, 0];
    for (const c of community) suitCount[cardToId(c) % 4]++;
    return suitCount.some(n => n >= 4);
  }

  /**
   * Legacy equity-vs-random heuristic. Kept for reference/fallback but NO LONGER
   * called on the live path (decidePostflopRanged replaces it). It judged hands
   * vs a random opponent, which is exactly the blunder this change fixes.
   */
  private decidePostflopHeuristic(state: GameState, heroCards: [number, number], equity: number): BotDecision {
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
        const smallBet = Math.max(bb, this.roundToStake(pot * 0.33, bb));
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
    const bb = state.bigBlind || 1;
    const potOdds = toCall / (pot + toCall);
    const mdf = pot / (pot + toCall); // minimum defense frequency

    console.log(`[GTO Bot] Pot odds: ${(potOdds * 100).toFixed(0)}% | MDF: ${(mdf * 100).toFixed(0)}%`);

    // SPR adjustments — low SPR means we're more committed
    const commitThreshold = spr < 2 ? 0.35 : spr < 4 ? 0.42 : 0.50;

    if (equity >= 0.70) {
      // Strong hand facing bet — raise for value
      const raiseSize = this.roundToStake(state.currentBet * 2.5, bb);
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
      const raiseSize = this.roundToStake(state.currentBet * 2.5, bb);
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

    // Raise / 3-bet / 4-bet: size by tier, capped to the hero's stack. Rounding is
    // stake-aware (cents for $0.25/$0.50 games, whole chips otherwise).
    let size: number;
    if (facing3bet) size = this.roundToStake(state.currentBet * 2.3, bb);
    else if (facingRaise) size = this.roundToStake(state.currentBet * 3, bb);
    else size = this.roundToStake(bb * 2.5, bb);
    size = Math.min(size, hero.stack + (hero.currentBet || 0));

    // Safety: a first-in OPEN at a deep stack must never become an all-in. If the
    // computed size approaches the stack (e.g. from a misread blind), clamp it to
    // a small fraction so a bad read can't turn a 2.5bb open into a shove.
    const effBB = hero.stack / Math.max(bb, 1);
    if (!facingRaise && effBB > 20) {
      size = Math.min(size, this.roundToStake(hero.stack * 0.1, bb));
    }

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

  /**
   * Postflop position: the player on the BUTTON (dealer) acts last and is
   * therefore IN POSITION. Heads-up, the SB *is* the button, so position must be
   * read from the dealer flag — not from blind labels. (The old code treated the
   * HU button/SB as out of position, which is backwards and fed the solver model
   * the wrong position every hand.)
   */
  private isInPosition(state: GameState): boolean {
    const hero = state.players[state.heroIndex];
    if (state.players.some(p => p.isDealer)) return !!hero.isDealer;
    // Fallback when no dealer flag is scraped: the dealer seat acts last.
    return state.heroIndex === state.dealerIndex;
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
