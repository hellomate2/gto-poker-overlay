import { ActionType, BotDecision, BotSettings, DEFAULT_SETTINGS } from '../types/poker';

// ============================================================
// Action Executor — Reliable PokerNow button clicking
// Fixes: React synthetic events, race conditions, selector
// mismatches, animation delays, form submission reliability
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
};

// Maximum time to wait for an element to appear in the DOM
const WAIT_TIMEOUT = 2500;
const WAIT_POLL_INTERVAL = 100;

export class ActionExecutor {
  private settings: BotSettings;
  private isExecuting: boolean = false;

  constructor(settings: BotSettings = DEFAULT_SETTINGS) {
    this.settings = settings;
  }

  updateSettings(settings: Partial<BotSettings>): void {
    this.settings = { ...this.settings, ...settings };
  }

  async execute(decision: BotDecision): Promise<boolean> {
    if (this.isExecuting) {
      console.log('[GTO Bot] Already executing, skipping');
      return false;
    }
    if (!this.settings.autoPlay) return false;

    this.isExecuting = true;
    try {
      const delay = this.settings.actionDelayMin +
        Math.random() * (this.settings.actionDelayMax - this.settings.actionDelayMin);
      await this.sleep(delay);

      const action = this.sampleAction(decision);
      console.log(`[GTO Bot] Executing: ${action.type}${action.amount ? ` $${action.amount}` : ''}`);

      const success = await this.executeWithRetry(action.type, action.amount);
      if (!success) {
        console.warn('[GTO Bot] All action attempts failed');
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
      console.log('[GTO Bot] Force-resetting execution lock');
      this.isExecuting = false;
    }
  }

  private sampleAction(decision: BotDecision): { type: ActionType; amount?: number } {
    const r = Math.random();
    let cumProb = 0;
    const s = decision.mixedStrategy;

    cumProb += s.fold;
    if (r < cumProb) return { type: 'fold' };
    cumProb += s.check;
    if (r < cumProb) return { type: 'check' };
    cumProb += s.call;
    if (r < cumProb) return { type: 'call' };

    for (const bet of s.bets) {
      cumProb += bet.probability;
      if (r < cumProb) {
        if (bet.amount === Infinity) return { type: 'allin' };
        return { type: 'raise', amount: bet.amount };
      }
    }
    return { type: decision.action, amount: decision.amount };
  }

  // ============================================================
  // Retry logic — waits for buttons to appear, not just blind retries
  // ============================================================

  private async executeWithRetry(action: ActionType, amount?: number): Promise<boolean> {
    // First, wait for ANY action button to be present and enabled
    const anyButtonSelector = `${SEL.checkBtn}:not([disabled]), ${SEL.callBtn}:not([disabled]), ${SEL.foldBtn}:not([disabled]), ${SEL.raiseBtn}:not([disabled]), ${SEL.betBtn}:not([disabled])`;

    const buttonReady = await this.waitForElement(anyButtonSelector, WAIT_TIMEOUT);
    if (!buttonReady) {
      console.warn('[GTO Bot] No action buttons found after waiting — may not be our turn');
      return false;
    }

    // Small extra delay for React to finish rendering all buttons
    await this.sleep(50);

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        console.log(`[GTO Bot] Retry attempt ${attempt + 1}...`);
        await this.sleep(300 + attempt * 200);
      }

      const result = await this.clickAction(action, amount);
      if (result) return true;
    }
    return false;
  }

  private async clickAction(action: ActionType, amount?: number): Promise<boolean> {
    switch (action) {
      case 'fold':
        // If check is available, always check instead of folding
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
        // Raise failed/disabled — try call, then check as fallback
        if (await this.reliableClick(SEL.callBtn)) return true;
        if (await this.reliableClick(SEL.checkBtn)) return true;
        return false;

      case 'allin':
        if (await this.executeAllIn()) return true;
        if (await this.reliableClick(SEL.callBtn)) return true;
        if (await this.reliableClick(SEL.checkBtn)) return true;
        return false;

      default:
        console.warn(`[GTO Bot] Unknown action: ${action}`);
        return false;
    }
  }

  // ============================================================
  // Raise flow — click raise, wait for form, set amount, submit
  // ============================================================

  private async executeRaise(amount?: number): Promise<boolean> {
    // Click the raise/bet button to open the raise form
    const raiseClicked = await this.reliableClick(SEL.raiseBtn) || await this.reliableClick(SEL.betBtn);
    if (!raiseClicked) {
      console.log('[GTO Bot] Raise/bet button not available');
      return false;
    }

    // Wait for the raise form to actually appear and be interactive
    const form = await this.waitForElement(SEL.raiseForm, 1500);
    if (!form) {
      console.warn('[GTO Bot] Raise form did not appear after clicking raise');
      return false;
    }

    // Additional wait for form animations to complete
    await this.sleep(150);

    if (amount) {
      const input = document.querySelector(SEL.raiseInput) as HTMLInputElement;
      if (input) {
        console.log(`[GTO Bot] Setting raise amount to ${Math.round(amount)}`);
        await this.setInputValue(input, String(Math.round(amount)));
        await this.sleep(150);
      } else {
        console.warn('[GTO Bot] Raise input not found, submitting with default amount');
      }
    }

    await this.sleep(100);
    return this.submitRaiseForm();
  }

  private async executeAllIn(): Promise<boolean> {
    const raiseClicked = await this.reliableClick(SEL.raiseBtn) || await this.reliableClick(SEL.betBtn);
    if (!raiseClicked) return false;

    const form = await this.waitForElement(SEL.raiseForm, 1500);
    if (!form) return false;
    await this.sleep(150);

    // Click the last preset button (usually "All In")
    const presets = document.querySelectorAll(SEL.presetBetBtns);
    if (presets.length > 0) {
      const allInBtn = presets[presets.length - 1] as HTMLElement;
      console.log(`[GTO Bot] Clicking preset: ${allInBtn.textContent?.trim()}`);
      this.dispatchReactClick(allInBtn);
      await this.sleep(300);
    }

    return this.submitRaiseForm();
  }

  private submitRaiseForm(): boolean {
    // Try 1: Click the submit button with React-compatible click
    const submitBtn = document.querySelector(SEL.raiseSubmitBtn) as HTMLElement;
    if (submitBtn && !(submitBtn as any).disabled) {
      this.dispatchReactClick(submitBtn);
      console.log('[GTO Bot] Clicked raise submit (dispatchEvent)');
      return true;
    }

    // Try 2: Submit the form element directly
    const form = document.querySelector(SEL.raiseForm) as HTMLFormElement;
    if (form) {
      // Try requestSubmit first (respects form validation + fires submit event)
      try {
        form.requestSubmit();
        console.log('[GTO Bot] Submitted form via requestSubmit()');
        return true;
      } catch {
        // requestSubmit may fail — fall back to dispatching submit event
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        console.log('[GTO Bot] Submitted form via submit event dispatch');
        return true;
      }
    }

    console.warn('[GTO Bot] Could not submit raise');
    return false;
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

    // Full mouse event sequence — React listens for all of these
    el.dispatchEvent(new PointerEvent('pointerdown', { ...eventOpts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', eventOpts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...eventOpts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mouseup', eventOpts));
    el.dispatchEvent(new MouseEvent('click', eventOpts));
  }

  /**
   * Try to click a button. Finds the element, checks it's enabled and visible,
   * then uses the React-compatible click method.
   */
  private async reliableClick(selector: string): Promise<boolean> {
    const btn = document.querySelector(selector) as HTMLButtonElement;
    if (!btn) return false;
    if (btn.disabled) return false;

    // Check visibility — button might exist but be hidden during transitions
    const style = getComputedStyle(btn);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') {
      console.log(`[GTO Bot] Button ${selector} exists but not interactive (display:${style.display}, visibility:${style.visibility}, pointer-events:${style.pointerEvents})`);
      return false;
    }

    // Check the button has actual dimensions (not collapsed)
    if (btn.offsetWidth === 0 || btn.offsetHeight === 0) {
      console.log(`[GTO Bot] Button ${selector} has zero dimensions`);
      return false;
    }

    this.dispatchReactClick(btn);
    console.log(`[GTO Bot] Clicked: ${selector} ("${btn.textContent?.trim() || (btn as any).value}")`);
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
    // Focus first
    input.focus();
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));

    // Use the native setter to bypass React's controlled value tracking
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value'
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(input, value);
    } else {
      input.value = value;
    }

    // Fire the full suite of events React may listen to
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // Also fire React 17+ compatible InputEvent
    try {
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: value,
        inputType: 'insertText',
      }));
    } catch {
      // InputEvent constructor may not be available in all contexts
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
      // Check immediately
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
          console.log(`[GTO Bot] waitForElement timeout: ${selector} (${timeoutMs}ms)`);
          resolve(null);
        }
      }, WAIT_POLL_INTERVAL);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
