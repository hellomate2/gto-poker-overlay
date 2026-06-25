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
  private initialized: boolean = false;
  private sessionHands: number = 0;
  private sessionProfit: number = 0;
  private sessionVpipCount: number = 0;
  private sessionVpipOpp: number = 0;
  private lastHeroStack: number = 0;
  private startTime: number = Date.now();
  private static readonly PROCESSING_TIMEOUT = 15000;

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
        if (this.lastHandNumber >= 0 && this.lastHeroStack > 0) {
          const delta = heroStack - this.lastHeroStack;
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
        try { this.executor.handleRebuy(); } catch (e) { console.warn('[GTO Bot] rebuy error', e); }
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
          const decision = await this.engine.decide(state);

          // Equity for display
          const heroCardIds: [number, number] = [
            cardToId(state.heroCards[0]),
            cardToId(state.heroCards[1]),
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
