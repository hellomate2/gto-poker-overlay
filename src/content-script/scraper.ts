import {
  Card, Rank, Suit, GameState, Player, Position, Action, ActionType, Street,
} from '../types/poker';
import { detectStraddleFromLog, effectivePreflopBet, isPreActionLabel } from './safety';

// ============================================================
// PokerNow DOM Scraper
// Real selectors from verified PokerNow bot implementations
// ============================================================

type GameStateCallback = (state: GameState) => void;

const SEL = {
  // Turn detection
  actionSignal: '.action-signal',

  // Cards — PokerNow uses .card with .value and .suit children
  heroCards: '.you-player .card',
  communityCards: '.table-cards .card',
  cardValue: '.value',
  cardSuit: '.suit',

  // Players
  allPlayers: '.table-player',
  playerName: '.table-player-name',
  playerStack: '.table-player-stack',
  heroPlayer: '.table-player.you-player',
  dealerChip: '.dealer-button-ctn',

  // Pot
  potTotal: '.table-pot-size .add-on .chips-value',
  potMain: '.table-pot-size .main-value .chips-value',

  // Blinds
  blindValues: '.blind-value .chips-value',

  // Action buttons (PokerNow uses button.check, button.call, etc.)
  checkBtn: 'button.check',
  callBtn: 'button.call',
  foldBtn: 'button.fold',
  raiseBtn: 'button.raise',
  raiseSubmit: '.raise-controller-form input[type="submit"]',
  presetBetBtns: '.default-bet-buttons button',
  raiseInput: '.raise-controller-form input.value, .raise-controller-form input[type="number"]',

  // Hand rank
  handMessage: '.player-hand-message',

  // Game log
  logMessages: '.game-log-container .log-message',
};

function parseCardElement(el: Element): Card | null {
  const valueEl = el.querySelector(SEL.cardValue);
  const suitEl = el.querySelector(SEL.cardSuit);

  if (valueEl && suitEl) {
    const rankText = valueEl.textContent?.trim() || '';
    const suitText = suitEl.textContent?.trim() || '';
    if (rankText) {
      return { rank: normalizeRank(rankText), suit: normalizeSuit(suitText) };
    }
  }

  // Fallback: class-based
  for (const cls of Array.from(el.classList)) {
    const match = cls.match(/card-([2-9TJQKA])([hdcs])/i);
    if (match) return { rank: normalizeRank(match[1]), suit: normalizeSuit(match[2]) };
  }

  // Fallback: text content
  const text = el.textContent?.trim() || '';
  if (text.length >= 2) {
    return { rank: normalizeRank(text.slice(0, -1)), suit: normalizeSuit(text.slice(-1)) };
  }

  return null;
}

// Board-container selectors, tried in order. PokerNow has shipped a few of these
// across versions; the first that yields cards wins.
const BOARD_SELECTORS = [
  '.table-cards .card',
  '.community-cards .card',
  '.table-community-cards .card',
  '.board-cards .card',
  '.community .card',
];

/**
 * Collect the community (board) cards robustly. Tries each known board container;
 * if none match (PokerNow changed its markup), falls back to every `.card` that
 * is NOT inside a player seat — board cards live in the table center, hole cards
 * live inside `.table-player`. This stops a selector change from silently
 * blanking the board and making the bot think a postflop spot is preflop.
 */
function collectCommunityCards(): Card[] {
  let els: Element[] = [];
  for (const sel of BOARD_SELECTORS) {
    els = Array.from(document.querySelectorAll(sel));
    if (els.length > 0) break;
  }
  if (els.length === 0) {
    els = Array.from(document.querySelectorAll('.card')).filter(
      (c) => !c.closest('.table-player'),
    );
  }
  const cards: Card[] = [];
  for (const el of els) {
    const card = parseCardElement(el);
    if (card) cards.push(card);
  }
  return cards;
}

function normalizeRank(r: string): Rank {
  const upper = r.toUpperCase().trim();
  if (upper === '10') return 'T';
  const first = upper[0];
  if ('23456789TJQKA'.includes(first)) return first as Rank;
  return '2';
}

function normalizeSuit(s: string): Suit {
  const lower = s.toLowerCase().trim();
  if (lower.includes('♥') || lower.includes('heart') || lower.includes('♡')) return 'h';
  if (lower.includes('♦') || lower.includes('diamond') || lower.includes('♢')) return 'd';
  if (lower.includes('♣') || lower.includes('club') || lower.includes('♧')) return 'c';
  if (lower.includes('♠') || lower.includes('spade') || lower.includes('♤')) return 's';
  if (lower[0] && 'hdcs'.includes(lower[0])) return lower[0] as Suit;
  return 'h';
}

export function parseChipValue(text: string): number {
  if (!text) return 0;
  const cleaned = text.replace(/[$,\s]/g, '').toLowerCase().trim();
  if (cleaned.endsWith('k')) return parseFloat(cleaned) * 1000;
  if (cleaned.endsWith('m')) return parseFloat(cleaned) * 1_000_000;
  return parseFloat(cleaned) || 0;
}

/**
 * Parse the "Call N" action-button text into the chip amount owed (0 when the
 * text is not a call). Tolerates a leading currency symbol ("Call $50"),
 * thousands separators ("Call 1,250"), and k/m suffixes ("Call 2k") — the amount
 * is handed to parseChipValue, which strips $ , and expands k/m.
 *
 * NOTE: the previous inline regex /call\s*([\d.,]+)/ failed to match dollar-stake
 * rooms ("Call $50") because the capture group excluded the '$' that sits between
 * "call " and the digits, so the bot read a faced bet as "no bet" and could check
 * into a wager it owed. The `call[^\d]*` prefix below skips any such separators.
 */
export function parseCallAmount(text: string): number {
  const t = (text || '').toLowerCase();
  if (!t.includes('call')) return 0;
  const m = t.match(/call[^\d]*([\d.,]+\s*[km]?)/);
  return m ? parseChipValue(m[1]) : 0;
}

/**
 * Pure big-blind selection from the two scraped blind-chip values: the big blind
 * is the LARGER of the two, accepted only if it's positive and not larger than
 * the biggest stack on the table (a sanity check — a "BB" bigger than every
 * stack is a misread of stray "x / y" text). Returns null when the blind chips
 * can't be trusted so the caller can fall back. Pure extraction of the logic in
 * PokerNowScraper.detectBigBlind (no behavior change).
 */
export function bigBlindFromChips(blindChips: number[], maxStack: number = Infinity): number | null {
  const valid = blindChips.filter(v => v > 0);
  if (valid.length >= 2) {
    const bb = Math.max(valid[0], valid[1]);
    if (bb > 0 && bb <= maxStack) return bb;
  }
  return null;
}

/**
 * Pure pot read: PokerNow's "total" (add-on) already INCLUDES the main pot, so
 * use the total when present and fall back to the main value — never add them
 * (that double-counted the pot). When neither is shown, fall back to the sum of
 * the chips currently in front of players. Pure extraction of scraper pot logic.
 */
export function potFromValues(potTotal: number, potMain: number, sumOfBets: number = 0): number {
  let pot = potTotal > 0 ? potTotal : potMain;
  if (pot === 0) pot = sumOfBets;
  return pot;
}

/**
 * Pure "facing a bet" / current-bet resolution. PokerNow never offers a Check
 * button when the hero owes chips, so on our turn with no Check available we ARE
 * facing a bet even if the bet chips / Call amount failed to scrape. Mirrors the
 * scraper's currentBet computation exactly (no behavior change).
 */
export function resolveCurrentBet(args: {
  maxPlayerBet: number;
  heroBet: number;
  toCallBtn: number;
  isOurTurn: boolean;
  canCheck: boolean;
  bigBlind: number;
}): number {
  const { maxPlayerBet, heroBet, toCallBtn, isOurTurn, canCheck, bigBlind } = args;
  let currentBet = Math.max(0, maxPlayerBet);
  if (toCallBtn > 0) currentBet = Math.max(currentBet, heroBet + toCallBtn);
  if (isOurTurn && !canCheck) {
    const faced = toCallBtn > 0 ? toCallBtn : Math.max(currentBet - heroBet, bigBlind);
    currentBet = Math.max(currentBet, heroBet + faced);
  }
  return currentBet;
}

export function assignPositions(numPlayers: number, dealerIndex: number): Position[] {
  const templates: Record<number, Position[]> = {
    2: ['SB', 'BB'],
    3: ['BTN', 'SB', 'BB'],
    4: ['BTN', 'SB', 'BB', 'CO'],
    5: ['BTN', 'SB', 'BB', 'UTG', 'CO'],
    6: ['BTN', 'SB', 'BB', 'UTG', 'MP', 'CO'],
  };
  const template = templates[Math.min(numPlayers, 6)] || templates[6];
  const positions: Position[] = [];
  for (let i = 0; i < numPlayers; i++) {
    const offset = (i - dealerIndex + numPlayers) % numPlayers;
    positions.push(template[offset % template.length]);
  }
  return positions;
}

export function detectStreet(communityCards: Card[]): Street {
  switch (communityCards.length) {
    case 0: return 'preflop';
    case 3: return 'flop';
    case 4: return 'turn';
    case 5: return 'river';
    default: return 'preflop';
  }
}

const STREET_ORDER: Street[] = ['preflop', 'flop', 'turn', 'river'];

/** Return whichever street is further along. */
export function laterStreet(a: Street, b: Street): Street {
  return STREET_ORDER.indexOf(a) >= STREET_ORDER.indexOf(b) ? a : b;
}

/**
 * Derive the current street from PokerNow's game log as a cross-check for the
 * board-card count. Log lines are oldest-first; we walk newest->oldest within the
 * current hand (stopping at the "starting hand" marker) and return the newest
 * flop/turn/river marker seen. Returns null when no postflop marker exists for
 * this hand (i.e. genuinely preflop, or the log is unavailable). This is the
 * safety net: even if the board fails to scrape entirely, the log still tells us
 * we are postflop, so the bot never mistakes a turn for a fresh preflop open.
 */
export function detectStreetFromLog(logLines: string[]): Street | null {
  for (let i = logLines.length - 1; i >= 0; i--) {
    const t = (logLines[i] || '').toLowerCase();
    if (t.includes('starting hand') || t.includes('hand #')) break;
    if (t.includes('river')) return 'river';
    if (t.includes('turn')) return 'turn';
    if (t.includes('flop')) return 'flop';
  }
  return null;
}

export class PokerNowScraper {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private callbacks: GameStateCallback[] = [];
  private lastStateHash: string = '';
  private handCounter: number = 0;
  private lastHandMarker: string = '';

  start(): void {
    console.log('[GTO Bot] Scraper starting...');
    this.scrapeAndEmit();
    // Poll every 500ms — proven approach for PokerNow bots
    this.intervalId = setInterval(() => this.scrapeAndEmit(), 500);
    console.log('[GTO Bot] Scraper running (500ms polling)');
  }

  stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
    console.log('[GTO Bot] Scraper stopped');
  }

  onGameState(callback: GameStateCallback): void {
    this.callbacks.push(callback);
  }

  isMyTurn(): boolean {
    // NEGATIVE signal first: a live PRE-ACTION button ("Check or Fold", "Call
    // Any") only shows while it's the OPPONENT's turn. If one is present, it is
    // definitively NOT our turn — this stops the bot deciding/acting out of turn.
    const preAction = Array.from(document.querySelectorAll('button')).some(
      (b) => !(b as HTMLButtonElement).disabled && isPreActionLabel(b.textContent || ''),
    );
    if (preAction) return false;
    // Primary: the live "Your Turn" action signal/timer.
    if (document.querySelector(SEL.actionSignal)) return true;
    // Secondary: our seat is the current decision-maker.
    if (document.querySelector('.decision-current.you-player')) return true;
    // Tertiary: an actual action button is enabled (now safe — pre-action ruled out).
    const checkBtn = document.querySelector(SEL.checkBtn) as HTMLButtonElement;
    const foldBtn = document.querySelector(SEL.foldBtn) as HTMLButtonElement;
    const callBtn = document.querySelector(SEL.callBtn) as HTMLButtonElement;
    return !!(checkBtn && !checkBtn.disabled) || !!(foldBtn && !foldBtn.disabled) || !!(callBtn && !callBtn.disabled);
  }

  scrape(): GameState | null {
    try {
      // Hero cards
      const heroCardEls = document.querySelectorAll(SEL.heroCards);
      const heroCards: Card[] = [];
      heroCardEls.forEach(el => {
        const card = parseCardElement(el);
        if (card) heroCards.push(card);
      });

      // Community cards — robust to PokerNow markup changes.
      const communityCards: Card[] = collectCommunityCards();
      // Run-it-twice renders two boards (>5 cards). De-dupe and cap at 5 so
      // street detection and equity stay sane; we're all-in by then anyway.
      if (communityCards.length > 5) {
        const seen = new Set<string>();
        const single: Card[] = [];
        for (const c of communityCards) {
          const k = `${c.rank}${c.suit}`;
          if (!seen.has(k)) { seen.add(k); single.push(c); }
          if (single.length === 5) break;
        }
        communityCards.length = 0;
        communityCards.push(...single);
      }

      // Players
      const playerEls = document.querySelectorAll(SEL.allPlayers);
      const players: Player[] = [];
      let heroIndex = -1;
      let dealerIndex = -1;

      playerEls.forEach((el, idx) => {
        const nameEl = el.querySelector(SEL.playerName);
        const stackEl = el.querySelector(SEL.playerStack);
        const name = nameEl?.textContent?.trim();
        if (!name) return;

        const isHero = el.classList.contains('you-player');
        const isDealer = !!el.querySelector(SEL.dealerChip) || !!el.querySelector('.dealer-button');
        const isSittingOut = el.classList.contains('sitting-out') || el.classList.contains('empty');

        const stack = parseChipValue(stackEl?.textContent || '0');

        const betEl = el.querySelector('.table-player-bet .chips-value') ||
                      el.querySelector('.table-player-bet-value .chips-value');
        const currentBet = parseChipValue(betEl?.textContent || '0');

        if (isHero) heroIndex = players.length;
        if (isDealer) dealerIndex = players.length;

        players.push({
          name, stack, position: 'BTN', isDealer, isSittingOut,
          seatIndex: idx, isHero, currentBet, hasActed: false,
          holeCards: isHero && heroCards.length === 2 ? [heroCards[0], heroCards[1]] : undefined,
        });
      });

      if (players.length < 2 || heroIndex === -1) return null;

      // Positions
      if (dealerIndex === -1) dealerIndex = 0;
      const activePlayers = players.filter(p => !p.isSittingOut);
      const activeDealer = activePlayers.findIndex(p => p.isDealer);
      const positions = assignPositions(activePlayers.length, Math.max(0, activeDealer));
      activePlayers.forEach((p, i) => { p.position = positions[i]; });

      // Pot
      // PokerNow shows a "total" (add-on) that already includes the main pot, so
      // use the total when present and fall back to the main value — never add
      // them (that double-counted the pot).
      const potTotal = parseChipValue(document.querySelector(SEL.potTotal)?.textContent || '0');
      const potMain = parseChipValue(document.querySelector(SEL.potMain)?.textContent || '0');
      const pot = potFromValues(
        potTotal, potMain, players.reduce((sum, p) => sum + p.currentBet, 0),
      );

      const maxStack = Math.max(0, ...players.map(p => p.stack));
      const bigBlind = this.detectBigBlind(maxStack || Infinity);
      // Determine the amount to call. The "Call N" button is the most reliable
      // signal that the hero is facing a bet (the opponent's bet chips aren't
      // always scrapeable), so trust it over the bet-chip read.
      const heroBet = players[heroIndex]?.currentBet || 0;
      const toCallBtn = this.detectToCall();
      const isOurTurn = this.isMyTurn();
      // Bulletproof "facing a bet": PokerNow never offers a Check button when you
      // owe chips, so on our turn with no Check available we ARE facing a bet —
      // even if the bet chips and Call amount failed to scrape. This stops the
      // bot from trying to "bet" into a bet.
      const checkBtnEl = document.querySelector(SEL.checkBtn) as HTMLButtonElement | null;
      const canCheck = !!(checkBtnEl && !checkBtnEl.disabled);
      // STRADDLE: a 3rd forced bet that inflates the preflop "to match" amount
      // beyond the big blind. Read it from the game log so preflop sizing and
      // scenario detection use the real facing amount (max of BB / straddle /
      // highest live bet). Postflop it has folded into the pot already, so we
      // only fold it into the preflop facing reference.
      const street0 = detectStreet(communityCards);
      const logLines = Array.from(document.querySelectorAll(SEL.logMessages))
        .map(e => e.textContent || '');
      // Cross-check the board-card count against the game log. If the board failed
      // to scrape, the log's flop/turn/river markers still pin the real street, so
      // a postflop spot can never be misread as a fresh preflop open.
      const street = laterStreet(street0, detectStreetFromLog(logLines) || 'preflop');
      const straddle = street === 'preflop' ? detectStraddleFromLog(logLines) : 0;
      const maxPlayerBet = Math.max(0, ...players.map(p => p.currentBet));
      const facingPreflop = street === 'preflop'
        ? effectivePreflopBet(bigBlind, straddle, maxPlayerBet)
        : maxPlayerBet;
      const currentBet = resolveCurrentBet({
        maxPlayerBet: facingPreflop,
        heroBet, toCallBtn, isOurTurn, canCheck, bigBlind,
      });
      // Minimum raise-to: facing a bet you must raise to at least double it; when
      // unopened, at least 2bb.
      const minRaise = currentBet > 0 ? currentBet * 2 : bigBlind * 2;
      const actionHistory = this.parseGameLog();

      return {
        tableId: window.location.pathname.split('/').pop() || 'unknown',
        handNumber: this.detectHandNumber(), street, pot, sidePots: [],
        heroCards: heroCards.length === 2 ? [heroCards[0], heroCards[1]] : null,
        communityCards, players, heroIndex, dealerIndex,
        activePlayerIndex: isOurTurn ? heroIndex : -1,
        currentBet, minRaise, bigBlind, smallBlind: bigBlind / 2,
        actionHistory, isOurTurn, timestamp: Date.now(),
      };
    } catch (err) {
      console.error('[GTO Bot] Scraper error:', err);
      return null;
    }
  }

  private scrapeAndEmit(): void {
    const state = this.scrape();
    if (!state) return;

    const hash = `${state.handNumber}-${state.isOurTurn}-${state.street}-${state.pot}-${state.currentBet}-${JSON.stringify(state.heroCards)}-${state.communityCards.length}`;
    if (hash !== this.lastStateHash) {
      this.lastStateHash = hash;
      for (const cb of this.callbacks) {
        try { cb(state); } catch (e) { console.error('[GTO Bot] Callback error:', e); }
      }
    }
  }

  /**
   * Read the current hand number from PokerNow's game log. The log prints a
   * line like "-- starting hand #123 --" at the top of each hand. We parse that
   * number directly so hand-transition detection and session P/L stay accurate.
   * Falls back to a local counter that ticks once per newly-seen "starting hand"
   * line if the room is configured to hide hand numbers.
   */
  private detectHandNumber(): number {
    const logEntries = document.querySelectorAll(SEL.logMessages);
    for (const entry of Array.from(logEntries)) {
      const match = (entry.textContent || '').match(/hand #(\d+)/i);
      if (match) return parseInt(match[1], 10);
    }
    // No explicit number in the log — derive one from "starting hand" markers.
    const startMarker = Array.from(logEntries).find(e =>
      (e.textContent || '').toLowerCase().includes('starting hand'),
    );
    const marker = startMarker?.textContent || '';
    if (marker && marker !== this.lastHandMarker) {
      this.lastHandMarker = marker;
      this.handCounter++;
    }
    return this.handCounter;
  }

  /** Amount the hero must call, read from the "Call N" action button (0 if none). */
  private detectToCall(): number {
    const btn = document.querySelector(SEL.callBtn) as HTMLButtonElement | null;
    if (!btn || btn.disabled) return 0;
    return parseCallAmount(btn.textContent || '');
  }

  private detectBigBlind(maxStack: number = Infinity): number {
    // Most reliable: the dedicated blind element holds exactly the SB and BB
    // chips (e.g. ".blind-value .chips-value" -> [10, 20]). The big blind is the
    // larger of them. Scoping to this element avoids picking up stray "x / y"
    // text elsewhere on the page (which previously read the BB as far too large
    // and made the bot think it was short-stacked).
    const blindChips = Array.from(document.querySelectorAll(SEL.blindValues))
      .map(e => parseChipValue(e.textContent || '0'))
      .filter(v => v > 0);
    const bbFromChips = bigBlindFromChips(blindChips, maxStack);
    if (bbFromChips !== null) return bbFromChips;
    // Fallback: the stakes header "small / big", sanity-checked vs the stacks.
    const body = document.body.textContent || '';
    for (const m of body.matchAll(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/g)) {
      const small = parseChipValue(m[1]);
      const big = parseChipValue(m[2]);
      if (big > 0 && big >= small && big <= maxStack) return big;
    }
    return 20;
  }

  private parseGameLog(): Record<Street, Action[]> {
    const history: Record<Street, Action[]> = {
      preflop: [], flop: [], turn: [], river: [],
    };
    const logEntries = document.querySelectorAll(SEL.logMessages);
    let currentStreet: Street = 'preflop';

    for (const entry of Array.from(logEntries).reverse()) {
      const text = (entry.textContent || '').trim().toLowerCase();
      if (text.includes('starting hand') || text.includes('hand #')) break;
      if (text.includes('flop')) currentStreet = 'flop';
      else if (text.includes('turn')) currentStreet = 'turn';
      else if (text.includes('river')) currentStreet = 'river';

      const fold = text.match(/"(.+?)" folds/);
      if (fold) { history[currentStreet].push({ type: 'fold', playerName: fold[1] }); continue; }
      const check = text.match(/"(.+?)" checks/);
      if (check) { history[currentStreet].push({ type: 'check', playerName: check[1] }); continue; }
      const call = text.match(/"(.+?)" calls (\d[\d,]*)/);
      if (call) { history[currentStreet].push({ type: 'call', playerName: call[1], amount: parseChipValue(call[2]) }); continue; }
      const raise = text.match(/"(.+?)" raises to (\d[\d,]*)/);
      if (raise) { history[currentStreet].push({ type: 'raise', playerName: raise[1], amount: parseChipValue(raise[2]) }); continue; }
      const bet = text.match(/"(.+?)" bets (\d[\d,]*)/);
      if (bet) { history[currentStreet].push({ type: 'bet', playerName: bet[1], amount: parseChipValue(bet[2]) }); continue; }
    }
    return history;
  }
}
