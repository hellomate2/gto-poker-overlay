import { BotSettings, DEFAULT_SETTINGS, GameState } from '../types/poker';
import { PokerNowScraper } from './scraper';
import { ActionExecutor } from './executor';
import { DecisionEngine } from '../core/engine';
import { HUDOverlay } from '../ui/overlay';
import { quickEquity } from '../core/equity/monte-carlo';
import { cardToId } from '../core/cfr/card-utils';
import { getGTOAdvice } from '../core/ranges/gto-advisor';
import { log } from '../core/logger';
import { isActionableState } from './safety';

// ============================================================
// Content Script Entry Point
// ============================================================

class PokerBot {
  private scraper: PokerNowScraper;
  private executor: ActionExecutor;
  private engine: DecisionEngine;
  private hud: HUDOverlay;
  private settings: BotSettings;
  private isProcessing: boolean = false;
  private processingTimestamp: number = 0;
  private lastHandNumber: number = -1;
  private lastBustDumpHand: number = -2;
  private initialized: boolean = false;
  private sessionHands: number = 0;
  private sessionProfit: number = 0;
  private sessionVpipCount: number = 0;
  private sessionVpipOpp: number = 0;
  private lastHeroStack: number = 0;
  private startTime: number = Date.now();
  // Must exceed the executor's worst-case time (the multi-method raise retries
  // ~0.4s apart can take several seconds). If this fired mid-raise it would
  // reset the lock and let a second execute() run concurrently and corrupt state
  // — which is what made it break after a few hands. Only a true hang hits this.
  private static readonly PROCESSING_TIMEOUT = 12000;
  // Settle window: how long to let the table finish animating before we read the
  // spot for real, and the gap between stability re-reads. Deciding only on a
  // STABLE read (not the first half-rendered frame of our turn) is what keeps the
  // bot from "acting in half a second" on a misread board/bet.
  private static readonly SETTLE_MS = 650;
  private static readonly SETTLE_STABLE_GAP_MS = 250;
  private static readonly SETTLE_MAX_REREADS = 5;

  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.scraper = new PokerNowScraper();
    this.executor = new ActionExecutor(this.settings);
    this.engine = new DecisionEngine(this.settings);
    this.hud = new HUDOverlay();
  }

  async start(): Promise<void> {
    console.log('[GTO Bot] ===== PokerNow GTO Bot Starting =====');
    console.log('[GTO Bot] URL:', window.location.href);

    // Load settings from chrome storage
    await this.loadSettings();
    console.log('[GTO Bot] Settings loaded:', JSON.stringify(this.settings));

    // Initialize HUD overlay
    this.hud.initialize();
    console.log('[GTO Bot] HUD initialized');

    // Listen for messages from popup
    chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (resp?: any) => void) => {
      this.handleMessage(message, sendResponse);
      return true;
    });

    // Start scraping
    this.scraper.onGameState((state) => this.onGameStateUpdate(state));
    this.scraper.start();

    console.log('[GTO Bot] ===== Bot is LIVE =====');
  }

  /**
   * Wait for the table to finish animating, then re-scrape until the betting spot
   * is STABLE across two consecutive reads (or we run out of patience). Returns the
   * freshest stable GameState so the engine decides on a COMPLETE table read rather
   * than the first half-rendered frame of our turn. Bails early (returns the read)
   * if it's no longer our turn.
   */
  private async settleAndReread(): Promise<GameState | null> {
    await this.sleep(PokerBot.SETTLE_MS);
    let prev = this.scraper.scrape();
    for (let i = 0; i < PokerBot.SETTLE_MAX_REREADS; i++) {
      if (!prev || !prev.isOurTurn) return prev;           // turn ended — let the loop re-handle
      await this.sleep(PokerBot.SETTLE_STABLE_GAP_MS);
      const cur = this.scraper.scrape();
      if (!cur || !cur.isOurTurn) return cur;
      if (this.sameSpot(prev, cur)) return cur;            // two matching reads = settled
      prev = cur;                                          // still animating — keep reading
    }
    return prev;                                           // never fully stabilized; use the latest
  }

  /** Two reads describe the same betting spot (nothing animating between them). */
  private sameSpot(a: GameState, b: GameState): boolean {
    return a.street === b.street
      && a.communityCards.length === b.communityCards.length
      && Math.abs((a.currentBet || 0) - (b.currentBet || 0)) < 1
      && Math.abs((a.pot || 0) - (b.pot || 0)) < 1;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async onGameStateUpdate(state: GameState): Promise<void> {
    // Guard against stale isProcessing lock — if it's been stuck for too long,
    // force-reset it. This prevents the bot from permanently locking up after
    // an unhandled error or timeout in the decision/execution pipeline.
    if (this.isProcessing) {
      const elapsed = Date.now() - this.processingTimestamp;
      if (elapsed > PokerBot.PROCESSING_TIMEOUT) {
        console.warn(`[GTO Bot] Processing lock stuck for ${elapsed}ms — force-resetting`);
        this.isProcessing = false;
        this.executor.resetLock();
      } else {
        return;
      }
    }

    try {
      // One-time init with player names
      if (!this.initialized && state.players.length >= 2) {
        const names = state.players.map(p => p.name);
        await this.engine.initialize(names);
        this.initialized = true;
        console.log('[GTO Bot] Engine initialized for players:', names);
      }

      // Update HUD with opponent stats
      if (this.settings.showHud) {
        const profiles = this.engine.getPlayerProfiles();
        const displayStats = new Map<string, any>();
        for (const [name] of profiles) {
          const stats = this.engine.getPlayerDisplayStats(name);
          if (stats) displayStats.set(name, stats);
        }
        this.hud.updatePlayerStats(state, profiles, displayStats);
      }

      // Detect new hand — track P/L via stack changes
      if (state.handNumber !== this.lastHandNumber && state.street === 'preflop') {
        if (this.lastHandNumber >= 0) {
          await this.engine.processCompletedHand(state);
        }
        const heroStack = state.players[state.heroIndex]?.stack || 0;
        const delta = heroStack - this.lastHeroStack;
        // A rebuy / top-up adds chips that are NOT winnings. In heads-up you can win
        // at most what you had at risk, so a positive jump larger than the prior
        // stack is an auto-buy-back-in, not a hand result — exclude it from P/L so
        // session profit actually measures whether the bot is winning.
        const isRebuy = delta > this.lastHeroStack + (state.bigBlind || 20);
        if (this.lastHandNumber >= 0 && this.lastHeroStack > 0 && !isRebuy) {
          this.sessionProfit += delta;
          this.sessionHands++;
        }
        this.lastHeroStack = heroStack;
        this.lastHandNumber = state.handNumber;

        this.hud.updateSessionStats({
          hands: this.sessionHands,
          profit: this.sessionProfit,
          startTime: this.startTime,
          bigBlind: state.bigBlind || 0,
        });
      }

      // Show GTO preflop advice (Triton-style)
      if (state.heroCards && state.street === 'preflop') {
        const gtoAdvice = getGTOAdvice(state);
        if (gtoAdvice) {
          this.hud.showGTOAdvice(gtoAdvice);
        }
      } else {
        this.hud.clearGTOAdvice();
      }

      // Always clear any blocking prompt/modal (run-it-twice, show/muck,
      // insurance, away nudge, post-BB) — even when it is NOT our turn (e.g. a
      // showdown muck prompt or an all-in run-it-twice prompt after our last
      // decision) so the prompt never permanently covers the action area.
      if (this.settings.autoPlay) {
        try { this.executor.dismissBlockingPrompts(); } catch (e) { console.warn('[GTO Bot] prompt-dismiss error', e); }
        // Auto buy-back-in so unattended self-play keeps cycling after a bust.
        let rebought = false;
        try { rebought = this.executor.handleRebuy(); } catch (e) { console.warn('[GTO Bot] rebuy error', e); }
        // BUST DIAGNOSTIC: if the hero is busted (0 chips) and we could NOT find a
        // rebuy/sit-in control, the heads-up table will halt (no opponent). Dump the
        // visible controls + lobby markup ONCE so the exact rebuy DOM is recoverable
        // from the console and the rebuy can be matched precisely.
        const heroStack = state.players[state.heroIndex]?.stack;
        if (!rebought && heroStack === 0 && this.lastBustDumpHand !== state.handNumber) {
          this.lastBustDumpHand = state.handNumber;
          const controls = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="submit"], input[type="button"]'))
            .map(e => ((e.textContent || (e as HTMLInputElement).value) || '').trim())
            .filter(Boolean);
          console.log('[GTO Bot] BUSTED but no rebuy control matched. Visible controls:', JSON.stringify(controls));
          console.log('[GTO Bot] REBUY-AREA DOM:', (document.querySelector('.table-player.you-player, .you-player, body') as HTMLElement)?.outerHTML?.slice(0, 4000));
        }
      }

      // CLEAN-STATE GUARD: only act when the table is fully, sanely parsed —
      // our turn, a hero seat, exactly two hole cards, and >=2 players. Any
      // transient null (seat shuffle, between hands, sitting out, cards not yet
      // rendered) means we do NOT act on a half-parsed table.
      const actionable = isActionableState({
        heroIndex: state.heroIndex,
        heroCardCount: state.heroCards ? 2 : 0,
        numPlayers: state.players.length,
        isOurTurn: state.isOurTurn,
      });

      // Make decision if it's our turn
      if (actionable && state.heroCards) {
        this.isProcessing = true;
        this.processingTimestamp = Date.now();
        console.log(`[GTO Bot] OUR TURN — ${state.heroCards[0].rank}${state.heroCards[0].suit} ${state.heroCards[1].rank}${state.heroCards[1].suit} | Street: ${state.street} | Pot: ${state.pot}`);

        try {
          // SETTLE & RE-READ before deciding. When our turn first registers the
          // table is often still animating (villain's bet sliding in, cards dealing,
          // the pot/board updating). Deciding on that half-rendered snapshot is what
          // made the bot act wrong in ~0.5s. Pause, then re-scrape until the spot is
          // STABLE across two reads, and decide on THAT — read everything first.
          this.hud.showExecStatus('reading the table…');
          const settled = await this.settleAndReread();
          if (!settled || !settled.heroCards || !settled.isOurTurn) {
            // Turn ended or state vanished while settling — let the next poll handle it.
            this.isProcessing = false;
            return;
          }
          const heroCards = settled.heroCards; // narrowed non-null by the guard above
          state = settled;

          const decision = await this.engine.decide(state);

          // Equity for display
          const heroCardIds: [number, number] = [
            cardToId(heroCards[0]),
            cardToId(heroCards[1]),
          ];
          const boardIds = state.communityCards.map(c => cardToId(c));
          const equity = quickEquity(heroCardIds, boardIds);

          console.log(`[GTO Bot] DECISION: ${decision.action}${decision.amount ? ' $' + decision.amount : ''} | Equity: ${(equity * 100).toFixed(1)}% | ${decision.reasoning}`);

          // Show on HUD
          this.hud.showDecision(decision, equity);

          // Execute if auto-play is enabled
          if (this.settings.autoPlay) {
            if (!decision || !decision.action) {
              console.warn('[GTO Bot] Engine returned no usable decision — safe fallback');
              await this.executor.safeFallback();
            } else {
              console.log('[GTO Bot] Auto-play ON — executing action...');
              await this.executor.execute(decision, state.handNumber);
            }
            // Surface the executor's last step on the overlay so a stall is
            // diagnosable straight from a screenshot (no console needed).
            this.hud.showExecStatus(this.executor.getLastStatus());
          } else {
            console.log('[GTO Bot] Auto-play OFF — advisory only');
          }
        } catch (decideErr) {
          // The engine/executor threw — never sit frozen. Make the safest legal
          // move from the live buttons (check if possible, else fold).
          console.error('[GTO Bot] Decision/execution error — safe fallback:', decideErr);
          if (this.settings.autoPlay) {
            try { await this.executor.safeFallback(); } catch (fbErr) { console.error('[GTO Bot] Safe fallback error:', fbErr); }
          }
        }

        this.isProcessing = false;
      } else if (!state.isOurTurn) {
        this.hud.clearDecision();
        // Not our turn -> clear the acted marker so the NEXT turn (new street/hand)
        // is always a fresh decision, regardless of whether the hand number parsed.
        this.executor.clearActedSignature();
      }
    } catch (err) {
      console.error('[GTO Bot] Error:', err);
      this.isProcessing = false;
      // Last-ditch: if it's somehow our turn and auto-play is on, try a safe move.
      if (this.settings.autoPlay && state.isOurTurn) {
        try { await this.executor.safeFallback(); } catch { /* noop */ }
      }
    }
  }

  private handleMessage(message: any, sendResponse: (resp?: any) => void): void {
    switch (message.type) {
      case 'UPDATE_SETTINGS':
        this.settings = { ...this.settings, ...message.settings };
        this.executor.updateSettings(message.settings);
        this.engine.updateSettings(message.settings);
        console.log('[GTO Bot] Settings updated');
        sendResponse({ ok: true });
        break;

      case 'GET_SESSION_STATS':
        sendResponse({
          hands: this.sessionHands,
          profit: this.sessionProfit,
          vpip: this.sessionVpipOpp > 0 ? (this.sessionVpipCount / this.sessionVpipOpp) * 100 : 0,
          avgSolveTime: 0,
        });
        break;

      case 'RESET_ALL_STATS':
        indexedDB.deleteDatabase('pokernow-gto-bot');
        console.log('[GTO Bot] All stats reset');
        sendResponse({ ok: true });
        break;
    }
  }

  private async loadSettings(): Promise<void> {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('botSettings', (result: any) => {
          // Force auto-play on with a ~2s human-paced delay so the bot just
          // plays the seat it's in, regardless of any stale stored prefs.
          this.settings = {
            ...DEFAULT_SETTINGS,
            ...(result?.botSettings || {}),
            autoPlay: true,
            advisoryMode: false,
            actionDelayMin: 1500,
            actionDelayMax: 2500,
          };
          chrome.storage.local.set({ botSettings: this.settings });
          log.info('Settings loaded, autoPlay=' + this.settings.autoPlay);
          resolve();
        });
      } catch {
        console.log('[GTO Bot] Could not load settings, using defaults');
        resolve();
      }
    });
  }
}

// ============================================================
// Bootstrap — run on any pokernow page
// ============================================================

const host = window.location.hostname;
if (host.includes('pokernow')) {
  console.log('[GTO Bot] Detected PokerNow page, bootstrapping...');
  const bot = new PokerBot();
  bot.start().catch(err => console.error('[GTO Bot] Failed to start:', err));
} else {
  console.log('[GTO Bot] Not a PokerNow page, skipping. Host:', host);
}
