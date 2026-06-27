import { describe, it, expect } from 'vitest';
import {
  parseChipValue,
  parseCallAmount,
  bigBlindFromChips,
  potFromValues,
  resolveCurrentBet,
  assignPositions,
  detectStreet,
  detectStreetFromLog,
  laterStreet,
  smallBlindPosterFromLog,
} from '../src/content-script/scraper';
import { card } from './helpers';

// ============================================================
// Street detection: board-count vs game-log cross-check. The bug this guards
// against: the board fails to scrape (0 cards) on a turn, street reads 'preflop',
// and the bot tries an "SB Open RFI raise $50" on a 4-card board.
// ============================================================

describe('detectStreetFromLog', () => {
  // PokerNow log lines are oldest-first; current hand is after the last marker.
  const hand = (...lines: string[]) => ['-- starting hand #42 --', ...lines];

  it('returns null when only preflop action exists', () => {
    expect(detectStreetFromLog(hand('"Dev" raises to 50', '"bot" calls 50'))).toBeNull();
  });
  it('detects flop / turn / river from the newest marker', () => {
    expect(detectStreetFromLog(hand('Flop:  [8d 4s 3d]'))).toBe('flop');
    expect(detectStreetFromLog(hand('Flop:  [8d 4s 3d]', 'Turn: [8d 4s 3d] [As]'))).toBe('turn');
    expect(detectStreetFromLog(hand('Flop: [..]', 'Turn: [..]', 'River: [..]'))).toBe('river');
  });
  it('ignores street markers from a PRIOR hand (stops at the start marker)', () => {
    const lines = ['River: [old board]', '-- starting hand #43 --', '"bot" raises to 50'];
    expect(detectStreetFromLog(lines)).toBeNull();
  });
  it('returns null for an empty log', () => {
    expect(detectStreetFromLog([])).toBeNull();
  });
  it('does NOT mis-street on chat or a player named Flop/Turn/River (only deal lines count)', () => {
    expect(detectStreetFromLog(hand('"River" raises to 50', 'nice turn buddy', '"Flop" calls 50'))).toBeNull();
    // a real deal line still wins over chatter
    expect(detectStreetFromLog(hand('"River" raises to 50', 'Flop:  [8d 4s 3d]'))).toBe('flop');
  });
});

describe('smallBlindPosterFromLog — the reliable position anchor (the SB = button HU)', () => {
  const hand = (...lines: string[]) => ['-- starting hand #5 --', ...lines];
  it('identifies the SB poster from the log', () => {
    expect(smallBlindPosterFromLog(hand('"dev" posts a small blind of 10', '"bot" posts a big blind of 20'))).toBe('dev');
  });
  it('still identifies the SB AFTER it open-raises (the bug the old bet-size heuristic had)', () => {
    // The SB now has the BIGGER bet (50 > 20), which fooled "smaller bet = SB".
    // The blind-post line is immune to later raises.
    expect(smallBlindPosterFromLog(hand(
      '"bot" posts a small blind of 10', '"dev" posts a big blind of 20',
      '"bot" raises to 50',
    ))).toBe('bot');
  });
  it('scopes to the current hand (ignores a prior hand\'s SB post)', () => {
    expect(smallBlindPosterFromLog([
      '"dev" posts a small blind of 10', '-- starting hand #6 --', '"bot" posts a small blind of 10',
    ])).toBe('bot');
  });
  it('returns null when no small-blind post is present', () => {
    expect(smallBlindPosterFromLog(['"dev" calls 50'])).toBeNull();
  });
});

describe('laterStreet (board vs log cross-check)', () => {
  it('takes the more-advanced street', () => {
    expect(laterStreet('preflop', 'turn')).toBe('turn'); // board blanked, log saved us
    expect(laterStreet('river', 'flop')).toBe('river');
    expect(laterStreet('flop', 'flop')).toBe('flop');
  });
});

// ============================================================
// Scraper parsing correctness — the table-reading the bot depends on.
// These exercise the REAL pure helpers extracted from scraper.ts (the scraper
// class now calls these same functions on the live DOM path, so a passing test
// here means the live read is correct). No DOM is stubbed; only pure parsing is
// tested, which is exactly the table-reading logic the engine consumes.
// ============================================================

describe('parseChipValue — chip-text normalization', () => {
  it('parses a plain integer string', () => {
    expect(parseChipValue('1000')).toBe(1000);
  });

  it('strips a leading $ (dollar-stake rooms)', () => {
    expect(parseChipValue('$50')).toBe(50);
  });

  it('parses a decimal (cents) stake like 0.50', () => {
    expect(parseChipValue('0.50')).toBe(0.5);
    expect(parseChipValue('$0.25')).toBe(0.25);
  });

  it('strips thousands commas: "1,000" -> 1000', () => {
    expect(parseChipValue('1,000')).toBe(1000);
    expect(parseChipValue('$1,250')).toBe(1250);
  });

  it('expands the k / m suffixes', () => {
    expect(parseChipValue('1.5k')).toBe(1500);
    expect(parseChipValue('2k')).toBe(2000);
    expect(parseChipValue('1m')).toBe(1_000_000);
  });

  it('returns 0 for empty / non-numeric text (safe default)', () => {
    expect(parseChipValue('')).toBe(0);
    expect(parseChipValue('—')).toBe(0);
    expect(parseChipValue('all in')).toBe(0);
  });
});

describe('parseCallAmount — read the "Call N" action button', () => {
  it('parses a plain call amount', () => {
    expect(parseCallAmount('Call 80')).toBe(80);
    expect(parseCallAmount('CALL 1,250')).toBe(1250);
  });

  it('parses a dollar-stake call ("Call $50") — the regression that read it as 0', () => {
    // The old /call\s*([\d.,]+)/ regex could not match because '$' sat between
    // "call " and the digits, so the bot mis-read a faced bet as no bet.
    expect(parseCallAmount('Call $50')).toBe(50);
    expect(parseCallAmount('Call $1,250')).toBe(1250);
    expect(parseCallAmount('Call $0.50')).toBe(0.5);
  });

  it('expands k/m suffixes on a call button', () => {
    expect(parseCallAmount('Call 2k')).toBe(2000);
  });

  it('returns 0 when the button is not a call (check/fold/empty)', () => {
    expect(parseCallAmount('Check')).toBe(0);
    expect(parseCallAmount('Fold')).toBe(0);
    expect(parseCallAmount('')).toBe(0);
  });
});

describe('bigBlindFromChips — pick the larger blind, sanity-check vs stacks', () => {
  it('picks the LARGER of the two blind chips as the big blind', () => {
    // [SB, BB] = [10, 20] -> BB is 20.
    expect(bigBlindFromChips([10, 20], 1000)).toBe(20);
    // Order-independent: even if scraped large-first.
    expect(bigBlindFromChips([20, 10], 1000)).toBe(20);
  });

  it('works for decimal stakes ($0.25 / $0.50)', () => {
    expect(bigBlindFromChips([0.25, 0.5], 50)).toBe(0.5);
  });

  it('rejects a "big blind" larger than every stack (stray "x / y" misread)', () => {
    // The historical bug: a giant stray number read as the BB made the bot think
    // it was always short-stacked. maxStack guard rejects it -> null (fall back).
    expect(bigBlindFromChips([10, 999999], 1000)).toBeNull();
  });

  it('returns null when fewer than two blind chips are present', () => {
    expect(bigBlindFromChips([20], 1000)).toBeNull();
    expect(bigBlindFromChips([], 1000)).toBeNull();
  });
});

describe('potFromValues — use the total, never total+main (no double-count)', () => {
  it('uses the total (add-on) when present and IGNORES the main', () => {
    // total already includes the main; adding them would double-count.
    expect(potFromValues(300, 200, 0)).toBe(300);
  });

  it('falls back to the main value when no total is shown', () => {
    expect(potFromValues(0, 200, 0)).toBe(200);
  });

  it('falls back to the sum of in-front bets when neither pot value is shown', () => {
    expect(potFromValues(0, 0, 75)).toBe(75);
  });

  it('never sums total + main (regression guard)', () => {
    // If it double-counted, this would be 500. It must be 300.
    expect(potFromValues(300, 200, 999)).not.toBe(500);
    expect(potFromValues(300, 200, 999)).toBe(300);
  });
});

describe('resolveCurrentBet — facing-a-bet derived from absence of Check', () => {
  it('on our turn with NO check button, we ARE facing a bet (>= bb) even if chips unscraped', () => {
    // Bet chips failed to scrape (maxPlayerBet 0), Call amount failed (0), but no
    // Check button is offered -> PokerNow only hides Check when we owe chips.
    const cb = resolveCurrentBet({
      maxPlayerBet: 0, heroBet: 0, toCallBtn: 0,
      isOurTurn: true, canCheck: false, bigBlind: 20,
    });
    expect(cb).toBeGreaterThanOrEqual(20); // at least one big blind owed
  });

  it('trusts the Call button amount over the bet-chip read', () => {
    const cb = resolveCurrentBet({
      maxPlayerBet: 0, heroBet: 0, toCallBtn: 120,
      isOurTurn: true, canCheck: false, bigBlind: 20,
    });
    expect(cb).toBe(120);
  });

  it('when a Check IS available, no extra bet is fabricated (not facing a bet)', () => {
    const cb = resolveCurrentBet({
      maxPlayerBet: 0, heroBet: 0, toCallBtn: 0,
      isOurTurn: true, canCheck: true, bigBlind: 20,
    });
    expect(cb).toBe(0);
  });

  it('adds heroBet to the Call amount to form the absolute current bet', () => {
    // Hero already has 40 in; Call says 80 more -> absolute current bet is 120.
    const cb = resolveCurrentBet({
      maxPlayerBet: 40, heroBet: 40, toCallBtn: 80,
      isOurTurn: true, canCheck: false, bigBlind: 20,
    });
    expect(cb).toBe(120);
  });
});

describe('assignPositions — seat-to-position mapping relative to dealer', () => {
  it('heads-up: dealer is SB, other is BB', () => {
    expect(assignPositions(2, 0)).toEqual(['SB', 'BB']);
    expect(assignPositions(2, 1)).toEqual(['BB', 'SB']);
  });

  it('6-max: dealer seat is BTN, next is SB then BB', () => {
    const pos = assignPositions(6, 0);
    expect(pos[0]).toBe('BTN');
    expect(pos[1]).toBe('SB');
    expect(pos[2]).toBe('BB');
  });
});

describe('detectStreet — board length -> street', () => {
  it('maps community-card count to the street', () => {
    expect(detectStreet([])).toBe('preflop');
    expect(detectStreet(['Ah', 'Kd', '2c'].map(card))).toBe('flop');
    expect(detectStreet(['Ah', 'Kd', '2c', '9s'].map(card))).toBe('turn');
    expect(detectStreet(['Ah', 'Kd', '2c', '9s', '3h'].map(card))).toBe('river');
  });
});
