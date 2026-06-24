import {
  Card, Rank, Suit, GameState, Player, Position, Action, ActionType, Street,
} from '../types/poker';

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

function parseChipValue(text: string): number {
  if (!text) return 0;
  const cleaned = text.replace(/[$,\s]/g, '').toLowerCase().trim();
  if (cleaned.endsWith('k')) return parseFloat(cleaned) * 1000;
  if (cleaned.endsWith('m')) return parseFloat(cleaned) * 1_000_000;
  return parseFloat(cleaned) || 0;
}

function assignPositions(numPlayers: number, dealerIndex: number): Position[] {
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

function detectStreet(communityCards: Card[]): Street {
  switch (communityCards.length) {
    case 0: return 'preflop';
    case 3: return 'flop';
    case 4: return 'turn';
    case 5: return 'river';
    default: return 'preflop';
  }
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
    // Primary: check for action signal text "Your Turn"
    const signal = document.querySelector(SEL.actionSignal);
    if (signal) return true;
    // Secondary: check if our player has the decision-current class
    const decisionPlayer = document.querySelector('.decision-current.you-player');
    if (decisionPlayer) return true;
    // Tertiary: check if action buttons are enabled
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

      // Community cards
      const communityCardEls = document.querySelectorAll(SEL.communityCards);
      const communityCards: Card[] = [];
      communityCardEls.forEach(el => {
        const card = parseCardElement(el);
        if (card) communityCards.push(card);
      });
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
      let pot = potTotal > 0 ? potTotal : potMain;
      if (pot === 0) pot = players.reduce((sum, p) => sum + p.currentBet, 0);

      const maxStack = Math.max(0, ...players.map(p => p.stack));
      const bigBlind = this.detectBigBlind(maxStack || Infinity);
      const currentBet = Math.max(0, ...players.map(p => p.currentBet));
      const isOurTurn = this.isMyTurn();
      const street = detectStreet(communityCards);
      const actionHistory = this.parseGameLog();

      return {
        tableId: window.location.pathname.split('/').pop() || 'unknown',
        handNumber: this.detectHandNumber(), street, pot, sidePots: [],
        heroCards: heroCards.length === 2 ? [heroCards[0], heroCards[1]] : null,
        communityCards, players, heroIndex, dealerIndex,
        activePlayerIndex: isOurTurn ? heroIndex : -1,
        currentBet, minRaise: bigBlind, bigBlind, smallBlind: bigBlind / 2,
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

  private detectBigBlind(maxStack: number = Infinity): number {
    // The stakes header ("NLH ~ 10 / 20") is the most reliable source. Take the
    // big blind from a "small / big" pair that is plausible given the stacks
    // (big >= small, and not larger than the biggest stack on the table).
    const body = document.body.textContent || '';
    for (const m of body.matchAll(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/g)) {
      const small = parseChipValue(m[1]);
      const big = parseChipValue(m[2]);
      if (big > 0 && big >= small && big <= maxStack) return big;
    }
    // Fall back to the blind chip elements, also sanity-checked.
    const blindEls = document.querySelectorAll(SEL.blindValues);
    if (blindEls.length >= 2) {
      const v = parseChipValue(blindEls[1].textContent || '0');
      if (v > 0 && v <= maxStack) return v;
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
