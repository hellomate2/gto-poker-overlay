// ============================================================
// Defensive-robustness helpers for the PokerNow content script.
//
// Governing principle: when anything is uncertain or broke, prefer a SAFE legal
// action over doing nothing or doing something illegal. The safe action is
// CHECK if a Check button is available, otherwise FOLD — never a blind call or
// raise that risks chips on a misread.
//
// Everything in this file is PURE (no DOM access) so it is unit-testable. The
// executor/scraper feed it data scraped from the live DOM and act on the result.
// ============================================================

import { Player, Position } from '../types/poker';

// ============================================================
// Turn detection
// ============================================================

/**
 * Whether a seat is genuinely IN THE CURRENT HAND (so it counts toward the active
 * player count that decides heads-up vs multiway charts). A seat counts if it's
 * the hero, has hole cards rendered, or has chips wagered. A dormant seat on a
 * rotating table (a name + stack but not dealt in) has none of these and must NOT
 * be counted — otherwise a 2-player game is misread as 3-handed and the bot uses
 * tight 6-max ranges that fold the button far too often. An explicit sitting-out
 * marker always wins. This is the single highest-EV correctness check, so it is
 * pure and unit-tested here rather than buried in the DOM scraper.
 */
export function seatInHand(opts: {
  isHero: boolean;
  cardCount: number;
  currentBet: number;
  sittingOutClass: boolean;
}): boolean {
  if (opts.sittingOutClass) return false;
  return opts.isHero || opts.cardCount > 0 || opts.currentBet > 0;
}

/**
 * True if a button label is one of PokerNow's PRE-ACTION (pre-select) controls,
 * which are shown and clickable ONLY while it is the OPPONENT's turn (you queue
 * an action in advance). Their presence is a definitive "NOT my turn" signal —
 * counting their enabled state as "my turn" made the bot decide/act out of turn.
 */
export function isPreActionLabel(text: string): boolean {
  return /check\s*(or|\/)\s*fold|fold\s*(to)?\s*any|call\s*any|call\s*all|fold\s*and|^check\/fold$/i
    .test((text || '').trim());
}

// ============================================================
// Safe-action selection
// ============================================================

/** Which live action buttons are present AND enabled, as scraped from the DOM. */
export interface AvailableButtons {
  check: boolean;
  call: boolean;
  fold: boolean;
  raise: boolean;
  bet: boolean;
}

export type SafeAction = 'check' | 'fold' | 'none';

/**
 * The safest legal action given the LIVE buttons:
 *   - CHECK when a Check button is available (never risks chips),
 *   - else FOLD when a Fold button is available,
 *   - else 'none' (no action area — not our turn / nothing to do).
 *
 * NEVER returns call/raise: those risk chips on a misread, which violates the
 * safety principle. This is the last-resort fallback when the engine throws,
 * returns nothing usable, or the executor exhausts its retries.
 */
export function chooseSafeAction(buttons: AvailableButtons): SafeAction {
  if (buttons.check) return 'check';
  if (buttons.fold) return 'fold';
  return 'none';
}

export type FallbackAction = 'call' | 'check' | 'fold' | 'none';

/**
 * The fallback action when the intended action could not be executed, made
 * AWARE of what the bot meant to do:
 *   - If it INTENDED to put chips in (raise/bet/call/all-in), folding throws away
 *     a hand it judged worth playing — so prefer CHECK (free) if available, else
 *     CALL, and only FOLD if neither. This fixes the disaster where a failed
 *     raise on a raise-or-fold spot (no check) silently became a fold, so two
 *     bots just traded blinds.
 *   - Otherwise (intended check/fold, or unknown/engine error), stay conservative:
 *     CHECK if free, else FOLD. Never call on a misread.
 */
export function chooseFallbackAction(
  buttons: AvailableButtons,
  intent?: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin',
): FallbackAction {
  const wantedToPlay = intent === 'raise' || intent === 'bet' || intent === 'call' || intent === 'allin';
  if (wantedToPlay) {
    // CALL before CHECK: a live Call button means there IS a bet to call, so a
    // Check would be ILLEGAL (e.g. the SB preflop owes the blind — dead-checking
    // there freezes the hand). Only when there's no bet (no call button) do we
    // check for free. We had a hand worth playing, so fold only as a last resort.
    if (buttons.call) return 'call';
    if (buttons.check) return 'check';
    if (buttons.fold) return 'fold';
    return 'none';
  }
  if (buttons.check) return 'check';
  if (buttons.fold) return 'fold';
  return 'none';
}

// ============================================================
// Blocking-prompt / modal dismissal
// ============================================================

/**
 * A blocking prompt that can cover the action buttons and freeze the bot. Each
 * entry lists the SAFE default button to click. Matching is by button TEXT
 * (case-insensitive substring / regex) so it is resilient to class-name churn;
 * an optional `containerMatch` narrows which prompt we are looking at.
 *
 * This list is intentionally small, documented, and easy to extend: add a new
 * entry when PokerNow ships a new modal.
 */
export interface PromptSpec {
  /** Human label for logging. */
  id: string;
  /** Text that identifies the prompt is showing (matched against the modal/page text). */
  promptMatch: RegExp;
  /** Ordered list of button-text regexes for the SAFE default; first match wins. */
  safeButtons: RegExp[];
}

export const PROMPT_DEFAULTS: PromptSpec[] = [
  {
    // All-in run-it-twice: decline (run once). After all-in there are no more
    // decisions, so just clear the prompt with the safe, consistent default.
    id: 'run-it-twice',
    promptMatch: /run\s*it\s*twice/i,
    safeButtons: [/run\s*it\s*once/i, /^\s*no\s*$/i, /decline/i, /once/i],
  },
  {
    // Showdown show/muck: default to MUCK (EV-neutral, never reveals our range).
    id: 'show-muck',
    promptMatch: /muck|show\s*(cards|hand)?/i,
    safeButtons: [/muck/i, /don'?t\s*show/i, /^\s*no\s*$/i],
  },
  {
    // Insurance offer when all-in: decline.
    id: 'insurance',
    promptMatch: /insurance/i,
    safeButtons: [/^\s*no\s*$/i, /decline/i, /no\s*thanks/i, /skip/i],
  },
  {
    // Rabbit hunt: skip / no.
    id: 'rabbit-hunt',
    promptMatch: /rabbit/i,
    safeButtons: [/^\s*no\s*$/i, /skip/i, /cancel/i, /close/i],
  },
  {
    // "I'm back" / "are you still there" / away/idle nudge: confirm we are here
    // so the seat isn't sat out, which would otherwise stop the bot acting.
    id: 'still-there',
    promptMatch: /still\s*there|are\s*you\s*there|i'?m\s*back|come\s*back|sit\s*back|you'?re\s*away|inactive/i,
    safeButtons: [/i'?m\s*back/i, /still\s*here/i, /sit\s*back/i, /yes/i, /continue/i, /ok/i],
  },
  {
    // "Post big blind?" / "wait for big blind" prompt (appears after the button
    // rotates, a sit-out, or a rejoin). CHOOSE TO POST AND PLAY — picking "wait for
    // big blind" sits the bot out, and in heads-up that halts the table (no opponent
    // -> no more hands -> the bot appears to "stop after a few hands"). A self-play
    // bot must stay in the action, so post over wait.
    id: 'post-bb',
    promptMatch: /post\s*(big\s*blind|bb|blind)|wait\s*for\s*(the\s*)?big\s*blind/i,
    safeButtons: [/post/i, /^\s*yes\s*$/i, /sit\s*in/i, /confirm/i, /^\s*ok\s*$/i],
  },
];

/** A button as scraped from the DOM: its trimmed text plus a click handle index. */
export interface ScrapedButton {
  text: string;
  /** Opaque index/id the caller uses to click the right element. */
  ref: number;
}

export interface PromptMatchResult {
  spec: PromptSpec;
  /** The button to click (its ref), or null if the prompt shows but no safe button found. */
  button: ScrapedButton | null;
}

/**
 * Given the visible page/modal text and the list of currently-clickable buttons,
 * find the FIRST known prompt that is showing and the safe-default button to
 * click for it. Returns null when no known prompt is present.
 *
 * Pure: the caller scrapes `pageText` and `buttons` from the DOM and performs
 * the click on the returned ref.
 */
export function findPromptToDismiss(
  pageText: string,
  buttons: ScrapedButton[],
  specs: PromptSpec[] = PROMPT_DEFAULTS,
): PromptMatchResult | null {
  for (const spec of specs) {
    if (!spec.promptMatch.test(pageText)) continue;
    let chosen: ScrapedButton | null = null;
    outer: for (const re of spec.safeButtons) {
      for (const b of buttons) {
        if (re.test(b.text.trim())) { chosen = b; break outer; }
      }
    }
    return { spec, button: chosen };
  }
  return null;
}

// ============================================================
// Straddle detection
// ============================================================

/**
 * Detect a straddle (a 3rd forced bet) from a single game-log line, returning
 * the straddle amount or null. PokerNow logs straddles like:
 *   '"Player" posts a straddle of 40'
 *   '"Player" straddles 40'
 * A straddle inflates the preflop "current bet" beyond the big blind, so the
 * engine must know about it to size opens and classify the scenario correctly.
 */
export function detectStraddleAmount(logLine: string): number | null {
  const t = logLine.toLowerCase();
  if (!t.includes('straddle')) return null;
  // "...straddle of 40", "straddles 40", "straddle (40)", "straddle: 40"
  const m = t.match(/straddle[^0-9]*([\d][\d,]*\.?\d*)/);
  if (m) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/**
 * Scan recent game-log lines (newest-first or oldest-first, both fine) for the
 * largest straddle amount this hand. Returns 0 when there is no straddle.
 */
export function detectStraddleFromLog(logLines: string[]): number {
  let max = 0;
  for (const line of logLines) {
    const amt = detectStraddleAmount(line);
    if (amt !== null && amt > max) max = amt;
  }
  return max;
}

// ============================================================
// Seat / position resolution with sit-outs, joins, leaves
// ============================================================

/** Position template by number of ACTIVE (non-sitting-out) players. */
const POSITION_TEMPLATES: Record<number, Position[]> = {
  2: ['SB', 'BB'],
  3: ['BTN', 'SB', 'BB'],
  4: ['BTN', 'SB', 'BB', 'CO'],
  5: ['BTN', 'SB', 'BB', 'UTG', 'CO'],
  6: ['BTN', 'SB', 'BB', 'UTG', 'MP', 'CO'],
};

/**
 * Resolve positions for the ACTIVE players only (sit-outs / away seats are
 * excluded — they don't get a position and don't shift the others). Mirrors the
 * scraper's assignPositions but operates on the filtered active list so seats
 * shuffling, players sitting out, or joining mid-session never corrupt the
 * position read. Pure.
 */
export function resolveActivePositions(numActive: number, activeDealerIndex: number): Position[] {
  if (numActive < 2) return [];
  const template = POSITION_TEMPLATES[Math.min(numActive, 6)] || POSITION_TEMPLATES[6];
  const dealer = activeDealerIndex >= 0 && activeDealerIndex < numActive ? activeDealerIndex : 0;
  const positions: Position[] = [];
  for (let i = 0; i < numActive; i++) {
    const offset = (i - dealer + numActive) % numActive;
    positions.push(template[offset % template.length]);
  }
  return positions;
}

// ============================================================
// Clean-state guard — don't act until the table is cleanly parsed
// ============================================================

export interface CleanStateInput {
  heroIndex: number;
  heroCardCount: number;
  numPlayers: number;
  isOurTurn: boolean;
}

/**
 * True only when it is genuinely safe to make a decision: it's our turn, we have
 * a hero seat, exactly two hole cards are readable, and at least two players are
 * parsed. Any transient null (seat shuffle, between hands, sitting out, cards not
 * yet rendered) returns false so the bot does NOT act on a half-parsed table.
 */
export function isActionableState(s: CleanStateInput): boolean {
  if (!s.isOurTurn) return false;
  if (s.heroIndex < 0) return false;
  if (s.heroCardCount !== 2) return false;
  if (s.numPlayers < 2) return false;
  return true;
}

/**
 * Effective preflop "facing" amount accounting for a straddle. The straddle is
 * the new forced bet to match (it exceeds the big blind), so the amount-to-call
 * reference preflop is max(bigBlind, straddle) unless a raise already exceeds it.
 * Pure helper used to keep sizing/scenario detection sane under a straddle.
 */
export function effectivePreflopBet(bigBlind: number, straddle: number, highestBet: number): number {
  return Math.max(bigBlind, straddle, highestBet);
}
