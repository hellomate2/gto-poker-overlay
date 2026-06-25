import { ActionType, BotDecision, BotSettings, DEFAULT_SETTINGS, StrategyDistribution } from '../types/poker';
import { log } from '../core/logger';

// ============================================================
// Action Executor — Reliable PokerNow button clicking
// Fixes: React synthetic events, race conditions, selector
// mismatches, animation delays, form submission reliability
//
// Hardening (this file):
//  - TURN RE-CHECK before clicking (no acting on stale state)
//  - FRESH DOM LOOKUPS each attempt (no reused references)
//  - RAISE AMOUNT clamping + read-back verification
//  - CONFIRM the action registered, retry the whole action
//  - NO DOUBLE-ACTING on the same spot (signature dedupe)
// ============================================================

const SEL = {
  checkBtn: 'button.check',
  callBtn: 'button.call',
  foldBtn: 'button.fold',
  raiseBtn: 'button.raise',
  betBtn: 'button.bet',
  raiseForm: '.raise-controller-form',
  // Use both selectors — PokerNow may use input.value OR input[type="number"]
  raiseInput: '.raise-controller-form input.value, .raise-controller-form input[type="number"]',
  raiseSubmitBtn: '.raise-controller-form input[type="submit"], .raise-controller-form button[type="submit"]',
  presetBetBtns: '.default-bet-buttons button.default-bet-button, .default-bet-buttons button',
  // The game action area that contains all action buttons
  actionArea: '.game-decisions, .table-controls, .action-buttons',
  // Turn detection — mirror scraper.ts exactly (do NOT fork a second copy of logic)
  actionSignal: '.action-signal',
  decisionCurrentHero: '.decision-current.you-player',
  // Board cards (for spot signature — mirrors scraper.ts SEL.communityCards)
  communityCards: '.table-cards .card',
} as const;

// Any enabled action button — used both to detect "it's our turn" and to
// confirm the action area is still live.
const ANY_ENABLED_BUTTON =
  `${SEL.checkBtn}:not([disabled]), ${SEL.callBtn}:not([disabled]), ` +
  `${SEL.foldBtn}:not([disabled]), ${SEL.raiseBtn}:not([disabled]), ${SEL.betBtn}:not([disabled])`;

// Maximum time to wait for an element to appear in the DOM
const WAIT_TIMEOUT = 2500;
const WAIT_POLL_INTERVAL = 100;

// How long to wait after clicking before confirming the action registered.
const CONFIRM_TIMEOUT = 1500;
const CONFIRM_POLL_INTERVAL = 100;

// Bounded retries
const MAX_ACTION_ATTEMPTS = 3;   // whole-action retries (click + confirm)
const MAX_AMOUNT_ATTEMPTS = 3;   // raise amount enter + read-back retries

// Read-back tolerance: PokerNow rounds to whole chips, so anything within
// 1 chip of the intended (rounded) amount is considered a match.
const AMOUNT_TOLERANCE = 1;

// ============================================================
// Pure, testable helpers (no DOM) — exported for unit tests
// ============================================================

export interface RaiseBounds {
  min: number | null;
  max: number | null;
}

export interface ClampResult {
  /** The clamped amount, or null if the amount can't be made valid. */
  amount: number | null;
  /** True if we had to fall back (amount invalid / unusable). */
  invalid: boolean;
}

/**
 * Clamp a desired raise/bet amount into the table's allowed range.
 *
 * - Rounds to whole chips (PokerNow only accepts integer chip amounts).
 * - Clamps to [min, max] when those bounds are known.
 * - Returns invalid=true when the amount is not a usable positive number,
 *   so the caller can fall back to call/check rather than entering garbage.
 */
export function clampRaiseAmount(desired: number | undefined, bounds: RaiseBounds): ClampResult {
  if (desired === undefined || !Number.isFinite(desired) || desired <= 0) {
    return { amount: null, invalid: true };
  }

  // Round to cents, NOT whole chips — decimal stakes ($0.25/$0.50) are valid and
  // forcing integers would turn a $1.25 raise into $1. The engine already sized
  // in the table's chip units; we just clamp to the legal min/max.
  const round2 = (x: number) => Math.round(x * 100) / 100;
  let amount = round2(desired);

  const { min, max } = bounds;
  if (max !== null && Number.isFinite(max) && amount > max) amount = round2(max);
  if (min !== null && Number.isFinite(min) && amount < min) amount = round2(min);

  // After clamping, a min that exceeds max (or any non-positive result) is unusable.
  if (max !== null && Number.isFinite(max) && amount > max) return { amount: null, invalid: true };
  if (amount <= 0) return { amount: null, invalid: true };

  return { amount, invalid: false };
}

/**
 * True if the read-back input value matches the intended amount within tolerance.
 * Does NOT round the intended value to an integer — that broke decimal stakes
 * (e.g. a $1.25 intended would only match a read-back of 1). Callers pass a
 * stake-relative tolerance for cents games.
 */
export function amountMatches(intended: number, readBack: number, tolerance: number = AMOUNT_TOLERANCE): boolean {
  if (!Number.isFinite(readBack)) return false;
  return Math.abs(intended - readBack) <= tolerance;
}

/** Parse the numeric value out of an input's string value (strips commas/$/spaces). */
export function parseInputAmount(raw: string | null | undefined): number {
  if (!raw) return NaN;
  const cleaned = raw.replace(/[$,\s]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * A signature uniquely identifying the current "spot" (decision point).
 * Two executions with the same signature are the same spot, so we must not
 * act twice. Derived from the things that change when a new decision is due:
 * whether it's our turn, the street (board length), and the bet to call.
 */
export interface SpotSignature {
  isOurTurn: boolean;
  boardLength: number;
  currentBet: number;
  handNumber: number; // distinguishes otherwise-identical spots across hands
}

/** Stable string form of a spot signature for cheap equality comparison. */
export function spotSignatureKey(sig: SpotSignature): string {
  return `${sig.handNumber}|${sig.isOurTurn ? 1 : 0}|${sig.boardLength}|${sig.currentBet}`;
}

/** True iff two spot signatures refer to the same decision point. */
export function sameSpot(a: SpotSignature | null, b: SpotSignature | null): boolean {
  if (!a || !b) return false;
  return spotSignatureKey(a) === spotSignatureKey(b);
}

/**
 * Sample a concrete action from a mixed strategy. Pure: the random source is
 * injected so it can be seeded in tests. `r` must be in [0, 1).
 * Mirrors the original sampling order: fold, check, call, then bets in order.
 */
export function sampleActionFromStrategy(
  strategy: StrategyDistribution,
  r: number,
  fallback: { action: ActionType; amount?: number },
): { type: ActionType; amount?: number } {
  let cumProb = 0;

  cumProb += strategy.fold;
  if (r < cumProb) return { type: 'fold' };
  cumProb += strategy.check;
  if (r < cumProb) return { type: 'check' };
  cumProb += strategy.call;
  if (r < cumProb) return { type: 'call' };

  for (const bet of strategy.bets) {
    cumProb += bet.probability;
    if (r < cumProb) {
      if (bet.amount === Infinity) return { type: 'allin' };
      return { type: 'raise', amount: bet.amount };
    }
  }
  return { type: fallback.action, amount: fallback.amount };
}

// ============================================================
// Executor
// ============================================================

export class ActionExecutor {
  private settings: BotSettings;
  private isExecuting: boolean = false;
  // Signature of the last spot we SUCCESSFULLY acted on — guards double-acting.
  private lastActedSignature: string | null = null;
  // Reliable hand number supplied by the content script (for the spot signature).
  private currentHandNumber: number = 0;

  constructor(settings: BotSettings = DEFAULT_SETTINGS) {
    this.settings = settings;
  }

  updateSettings(settings: Partial<BotSettings>): void {
    this.settings = { ...this.settings, ...settings };
  }

  async execute(decision: BotDecision, handNumber: number = 0): Promise<boolean> {
    // Prefer the scraper's reliable hand number for the spot signature so the
    // no-double-act guard distinguishes hands even if the log isn't parseable.
    this.currentHandNumber = handNumber;
    if (this.isExecuting) {
      log.debug('Already executing, skipping');
      return false;
    }
    if (!this.settings.autoPlay) return false;

    // NO DOUBLE-ACTING (guard #1): if the live spot matches the last spot we
    // already acted on, skip. Captured BEFORE the delay so a duplicate decision
    // for the same turn is rejected immediately.
    const entrySig = this.readSpotSignature();
    if (entrySig && sameSpot(entrySig, this.parseSignature(this.lastActedSignature))) {
      log.debug('Spot already acted on, skipping duplicate decision', this.lastActedSignature);
      return false;
    }

    this.isExecuting = true;
    try {
      const delay = this.settings.actionDelayMin +
        Math.random() * (this.settings.actionDelayMax - this.settings.actionDelayMin);
      await this.sleep(delay);

      // TURN RE-CHECK (#1): after the delay, the world may have moved on.
      if (!this.isHeroTurnLive()) {
        log.debug('No longer our turn after action delay — aborting');
        return false;
      }

      const action = this.sampleAction(decision);
      log.info(`Executing: ${action.type}${action.amount ? ` $${action.amount}` : ''}`);

      const success = await this.executeWithRetry(action.type, action.amount);
      if (success) {
        // Record the spot we just acted on so we never re-fire on it.
        const actedSig = this.readSpotSignature();
        if (actedSig) this.lastActedSignature = spotSignatureKey(actedSig);
      } else {
        log.warn('All action attempts failed');
      }
      return success;
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Force-reset the executing lock. Call this if state changes indicate
   * a new turn started and the previous execution may have stalled.
   */
  resetLock(): void {
    if (this.isExecuting) {
      log.debug('Force-resetting execution lock');
      this.isExecuting = false;
    }
  }

  private sampleAction(decision: BotDecision): { type: ActionType; amount?: number } {
    return sampleActionFromStrategy(
      decision.mixedStrategy,
      Math.random(),
      { action: decision.action, amount: decision.amount },
    );
  }

  // ============================================================
  // Turn detection — mirrors scraper.ts isMyTurn() exactly so the two never
  // disagree. Re-queries the live DOM every call (no cached references).
  // ============================================================

  private isHeroTurnLive(): boolean {
    // Primary: "Your Turn" action signal.
    if (document.querySelector(SEL.actionSignal)) return true;
    // Secondary: our seat is the current decision-maker.
    if (document.querySelector(SEL.decisionCurrentHero)) return true;
    // Tertiary: at least one action button is present AND enabled.
    return !!document.querySelector(ANY_ENABLED_BUTTON);
  }

  // ============================================================
  // Spot signature — derived from the live DOM
  // ============================================================

  private readSpotSignature(): SpotSignature | null {
    const boardLength = document.querySelectorAll(SEL.communityCards).length;
    const currentBet = this.readCurrentBet();
    return {
      isOurTurn: this.isHeroTurnLive(),
      boardLength,
      currentBet,
      handNumber: this.currentHandNumber || this.readHandNumber(),
    };
  }

  /**
   * Current hand number from the game log ("hand #N"). Without this, every
   * preflop spot looks identical across hands (same board length + bet) and the
   * no-double-act guard would skip every hand after the first.
   */
  private readHandNumber(): number {
    const entries = document.querySelectorAll('.messages .message, .log-message, .messages > *');
    for (const e of Array.from(entries)) {
      const m = (e.textContent || '').match(/hand #(\d+)/i);
      if (m) return parseInt(m[1], 10);
    }
    return 0;
  }

  /**
   * Read the highest bet currently on the table (the "to-call" reference for
   * the spot signature). Mirrors scraper.ts's per-player bet parsing.
   */
  private readCurrentBet(): number {
    let max = 0;
    const betEls = document.querySelectorAll(
      '.table-player-bet .chips-value, .table-player-bet-value .chips-value',
    );
    betEls.forEach((el) => {
      const v = parseInputAmount(el.textContent);
      if (Number.isFinite(v) && v > max) max = v;
    });
    return max;
  }

  private parseSignature(key: string | null): SpotSignature | null {
    if (!key) return null;
    const [hand, turn, board, bet] = key.split('|');
    return {
      handNumber: parseInt(hand, 10) || 0,
      isOurTurn: turn === '1',
      boardLength: parseInt(board, 10) || 0,
      currentBet: parseFloat(bet) || 0,
    };
  }

  // ============================================================
  // Retry logic — re-queries fresh each attempt; confirms registration
  // ============================================================

  private async executeWithRetry(action: ActionType, amount?: number): Promise<boolean> {
    // First, wait for ANY action button to be present and enabled.
    const buttonReady = await this.waitForElement(ANY_ENABLED_BUTTON, WAIT_TIMEOUT);
    if (!buttonReady) {
      log.warn('No action buttons found after waiting — may not be our turn');
      return false;
    }

    // Small extra delay for React to finish rendering all buttons.
    await this.sleep(50);

    for (let attempt = 0; attempt < MAX_ACTION_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        log.debug(`Retry attempt ${attempt + 1}...`);
        await this.sleep(300 + attempt * 200);
      }

      // TURN RE-CHECK (#2): re-verify on EVERY attempt, immediately before
      // clicking. Cheap insurance against the turn ending between retries.
      if (!this.isHeroTurnLive()) {
        log.debug('Not our turn at attempt start — aborting');
        return false;
      }

      const clicked = await this.clickAction(action, amount);
      if (!clicked) continue;

      // CONFIRM IT REGISTERED (#4): the action area should disappear / it
      // should no longer be our turn. If it didn't take, loop and retry.
      const registered = await this.confirmActionRegistered();
      if (registered) return true;

      log.debug('Action did not appear to register; will retry');
    }

    log.warn('Action failed to register after all attempts');
    return false;
  }

  private async clickAction(action: ActionType, amount?: number): Promise<boolean> {
    switch (action) {
      case 'fold':
        // If check is available, always check instead of folding.
        if (await this.reliableClick(SEL.checkBtn)) return true;
        if (await this.reliableClick(SEL.foldBtn)) return true;
        return false;

      case 'check':
        if (await this.reliableClick(SEL.checkBtn)) return true;
        if (await this.reliableClick(SEL.foldBtn)) return true;
        return false;

      case 'call':
        if (await this.reliableClick(SEL.callBtn)) return true;
        if (await this.reliableClick(SEL.checkBtn)) return true;
        return false;

      case 'bet':
      case 'raise':
        if (await this.executeRaise(amount)) return true;
        // Raise failed/disabled — try call, then check as fallback.
        if (await this.reliableClick(SEL.callBtn)) return true;
        if (await this.reliableClick(SEL.checkBtn)) return true;
        return false;

      case 'allin':
        if (await this.executeAllIn()) return true;
        if (await this.reliableClick(SEL.callBtn)) return true;
        if (await this.reliableClick(SEL.checkBtn)) return true;
        return false;

      default:
        log.warn(`Unknown action: ${action}`);
        return false;
    }
  }

  // ============================================================
  // Raise flow — click raise, wait for form, set+verify amount, submit
  // ============================================================

  private async executeRaise(amount?: number): Promise<boolean> {
    // FRESH LOOKUP: re-query the raise/bet button right here.
    const raiseClicked = await this.reliableClick(SEL.raiseBtn) || await this.reliableClick(SEL.betBtn);
    if (!raiseClicked) {
      log.debug('Raise/bet button not available');
      return false;
    }

    // Wait for the raise form to actually appear and be interactive.
    const form = await this.waitForElement(SEL.raiseForm, 1500);
    if (!form) {
      log.warn('Raise form did not appear after clicking raise');
      return false;
    }

    // Additional wait for form animations to complete.
    await this.sleep(150);

    // 1) Try the exact (clamped) amount via the input.
    if (amount !== undefined) {
      const bounds = this.readRaiseBounds();
      const clamped = clampRaiseAmount(amount, bounds);
      if (!clamped.invalid && clamped.amount !== null && await this.enterAndVerifyAmount(clamped.amount)) {
        await this.sleep(100);
        if (await this.submitRaiseForm()) return true;
      }
    }

    // 2) Exact entry failed (amount below the table min, bounds unreadable, or
    //    the input snapped). Fall back to a PRESET button — always a legal
    //    raise, picked closest to the intended size (else MIN RAISE). This is
    //    what stops the bot from getting stuck on an un-submittable amount.
    if (await this.clickClosestPreset(amount)) {
      await this.sleep(120);
      if (await this.submitRaiseForm()) return true;
    }

    // 3) Could not raise at all — CLOSE the form so it stops covering the
    //    Call/Check/Fold buttons, letting clickAction's fallback act (no freeze).
    await this.closeRaiseForm();
    return false;
  }

  /**
   * Click the preset bet button (MIN RAISE / 1/2 / 3/4 / POT) whose resulting
   * amount is closest to `amount`. Presets are always legal raises, so this is
   * the reliable fallback when typing an exact amount fails. With no target,
   * uses the first preset (MIN RAISE) — the legal floor. Excludes ALL IN.
   */
  private async clickClosestPreset(amount?: number): Promise<boolean> {
    const presets = (Array.from(document.querySelectorAll(SEL.presetBetBtns)) as HTMLElement[])
      .filter(b => b.offsetWidth > 0 && getComputedStyle(b).display !== 'none'
        && !/all\s*in/i.test(b.textContent || ''));
    if (presets.length === 0) return false;
    if (amount === undefined) { this.dispatchReactClick(presets[0]); return true; }

    let best = presets[0];
    let bestDiff = Infinity;
    for (const b of presets) {
      this.dispatchReactClick(b);
      await this.sleep(40);
      const v = parseInputAmount((document.querySelector(SEL.raiseInput) as HTMLInputElement | null)?.value);
      if (Number.isFinite(v)) {
        const d = Math.abs(v - amount);
        if (d < bestDiff) { bestDiff = d; best = b; }
      }
    }
    this.dispatchReactClick(best);
    await this.sleep(40);
    return true;
  }

  /** Close the raise form (BACK button or Escape) so it stops covering the action buttons. */
  private async closeRaiseForm(): Promise<void> {
    const back = (Array.from(document.querySelectorAll('button')) as HTMLElement[])
      .find(b => /^back$/i.test((b.textContent || '').trim()));
    if (back) { this.dispatchReactClick(back); await this.sleep(80); return; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    await this.sleep(80);
  }

  /**
   * Read the table's allowed raise range from the form's input (min/max attrs)
   * and/or any range slider. Returns nulls when the bound isn't discoverable.
   */
  private readRaiseBounds(): RaiseBounds {
    let min: number | null = null;
    let max: number | null = null;

    const input = document.querySelector(SEL.raiseInput) as HTMLInputElement | null;
    if (input) {
      const im = parseInputAmount(input.getAttribute('min'));
      const ix = parseInputAmount(input.getAttribute('max'));
      if (Number.isFinite(im)) min = im;
      if (Number.isFinite(ix)) max = ix;
    }

    // A range slider, if present, also carries the authoritative min/max.
    const slider = document.querySelector(`${SEL.raiseForm} input[type="range"]`) as HTMLInputElement | null;
    if (slider) {
      const sm = parseInputAmount(slider.getAttribute('min'));
      const sx = parseInputAmount(slider.getAttribute('max'));
      if (Number.isFinite(sm) && (min === null || sm > min)) min = sm;
      if (Number.isFinite(sx) && (max === null || sx < max)) max = sx;
    }

    return { min, max };
  }

  /**
   * Enter the amount into the (freshly re-queried) raise input, then read the
   * value back and confirm it matches. Retries a bounded number of times.
   */
  private async enterAndVerifyAmount(amount: number): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_AMOUNT_ATTEMPTS; attempt++) {
      // FRESH LOOKUP every attempt — React may have re-rendered the form.
      const input = document.querySelector(SEL.raiseInput) as HTMLInputElement | null;
      if (!input) {
        log.warn('Raise input not found');
        return false;
      }

      if (attempt > 0) {
        // Clear first so a stale value doesn't get appended to.
        await this.setInputValue(input, '');
        await this.sleep(60);
      }

      log.debug(`Setting raise amount to ${amount} (attempt ${attempt + 1})`);
      await this.setInputValue(input, String(amount));
      await this.sleep(120);

      // Read back from a FRESH query (the node may have been replaced).
      const after = document.querySelector(SEL.raiseInput) as HTMLInputElement | null;
      const readBack = parseInputAmount(after?.value);
      // Stake-relative tolerance: ~3% of the amount, min 1 cent. Handles both
      // whole-chip games and $0.25/$0.50 cents games.
      const tol = Math.max(0.01, Math.abs(amount) * 0.03);
      if (amountMatches(amount, readBack, tol)) {
        log.debug(`Raise amount verified: ${readBack}`);
        return true;
      }
      log.debug(`Raise amount mismatch (wanted ${amount}, got ${after?.value}); retrying`);
    }
    return false;
  }

  private async executeAllIn(): Promise<boolean> {
    const raiseClicked = await this.reliableClick(SEL.raiseBtn) || await this.reliableClick(SEL.betBtn);
    if (!raiseClicked) return false;

    const form = await this.waitForElement(SEL.raiseForm, 1500);
    if (!form) return false;
    await this.sleep(150);

    // Click the last preset button (usually "All In"). Re-query fresh.
    const presets = document.querySelectorAll(SEL.presetBetBtns);
    if (presets.length > 0) {
      const allInBtn = presets[presets.length - 1] as HTMLElement;
      log.debug(`Clicking preset: ${allInBtn.textContent?.trim()}`);
      this.dispatchReactClick(allInBtn);
      await this.sleep(300);
    }

    return this.submitRaiseForm();
  }

  private submitRaiseForm(): boolean {
    // Try 1: Click the submit button with React-compatible click (fresh query).
    const submitBtn = document.querySelector(SEL.raiseSubmitBtn) as HTMLElement | null;
    if (submitBtn && !(submitBtn as HTMLInputElement).disabled) {
      this.dispatchReactClick(submitBtn);
      log.debug('Clicked raise submit (dispatchEvent)');
      return true;
    }

    // Try 2: Submit the form element directly (fresh query).
    const form = document.querySelector(SEL.raiseForm) as HTMLFormElement | null;
    if (form) {
      try {
        form.requestSubmit();
        log.debug('Submitted form via requestSubmit()');
        return true;
      } catch {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        log.debug('Submitted form via submit event dispatch');
        return true;
      }
    }

    log.warn('Could not submit raise');
    return false;
  }

  // ============================================================
  // Confirm registration — the action area should be gone / not our turn
  // ============================================================

  /**
   * After clicking, verify the action actually took effect. We consider it
   * registered when EITHER the raise form is gone AND no enabled action
   * buttons remain, OR it's simply no longer our turn. Polls briefly.
   */
  private confirmActionRegistered(): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = (): boolean => {
        const formGone = !document.querySelector(SEL.raiseForm);
        const buttonsGone = !document.querySelector(ANY_ENABLED_BUTTON);
        const notOurTurn = !this.isHeroTurnLive();
        return notOurTurn || (formGone && buttonsGone);
      };

      if (check()) { resolve(true); return; }

      const interval = setInterval(() => {
        if (check()) {
          clearInterval(interval);
          resolve(true);
          return;
        }
        if (Date.now() - start >= CONFIRM_TIMEOUT) {
          clearInterval(interval);
          resolve(false);
        }
      }, CONFIRM_POLL_INTERVAL);
    });
  }

  // ============================================================
  // React-compatible click — the core fix
  // ============================================================

  /**
   * Performs a reliable click that works with React's synthetic event system.
   * PokerNow uses React, which intercepts events at the root via delegation.
   * A simple .click() may not propagate correctly through React's system.
   *
   * This dispatches a full mousedown -> mouseup -> click sequence with
   * proper bubbling, which React's event delegation will pick up.
   */
  private dispatchReactClick(el: HTMLElement): void {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const eventOpts: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 1,
    };

    // Full mouse event sequence — React listens for all of these.
    el.dispatchEvent(new PointerEvent('pointerdown', { ...eventOpts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', eventOpts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...eventOpts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mouseup', eventOpts));
    el.dispatchEvent(new MouseEvent('click', eventOpts));
  }

  /**
   * Try to click a button. Finds the element FRESH, checks it's enabled and
   * visible, then uses the React-compatible click method.
   */
  private async reliableClick(selector: string): Promise<boolean> {
    const btn = document.querySelector(selector) as HTMLButtonElement | null;
    if (!btn) return false;
    if (btn.disabled) return false;

    // Check visibility — button might exist but be hidden during transitions.
    const style = getComputedStyle(btn);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') {
      log.debug(`Button ${selector} exists but not interactive`);
      return false;
    }

    // Check the button has actual dimensions (not collapsed).
    if (btn.offsetWidth === 0 || btn.offsetHeight === 0) {
      log.debug(`Button ${selector} has zero dimensions`);
      return false;
    }

    this.dispatchReactClick(btn);
    log.debug(`Clicked: ${selector} ("${btn.textContent?.trim() || (btn as HTMLInputElement).value}")`);
    return true;
  }

  // ============================================================
  // Input value setting — React-compatible
  // ============================================================

  /**
   * Set an input value in a way React will recognize.
   * React tracks input values internally; we must use the native setter
   * to bypass React's controlled component, then fire events React listens for.
   */
  private async setInputValue(input: HTMLInputElement, value: string): Promise<void> {
    // Focus first.
    input.focus();
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));

    // Use the native setter to bypass React's controlled value tracking.
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value',
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(input, value);
    } else {
      input.value = value;
    }

    // Fire the full suite of events React may listen to.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // Also fire React 17+ compatible InputEvent.
    try {
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: value,
        inputType: 'insertText',
      }));
    } catch {
      // InputEvent constructor may not be available in all contexts.
    }
  }

  // ============================================================
  // Wait-for-element pattern — polls DOM until element appears
  // ============================================================

  /**
   * Waits for an element matching the selector to appear in the DOM.
   * Returns the element if found, or null if timeout.
   * This handles the case where buttons are being re-rendered by React
   * or are mid-CSS-animation after a state transition.
   */
  private waitForElement(selector: string, timeoutMs: number = WAIT_TIMEOUT): Promise<Element | null> {
    return new Promise((resolve) => {
      // Check immediately.
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }

      const startTime = Date.now();
      const interval = setInterval(() => {
        const el = document.querySelector(selector);
        if (el) {
          clearInterval(interval);
          resolve(el);
          return;
        }
        if (Date.now() - startTime >= timeoutMs) {
          clearInterval(interval);
          log.debug(`waitForElement timeout: ${selector} (${timeoutMs}ms)`);
          resolve(null);
        }
      }, WAIT_POLL_INTERVAL);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
