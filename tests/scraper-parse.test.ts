import { describe, it, expect } from 'vitest';
import {
  parseChipValue,
  bigBlindFromChips,
  potFromValues,
  resolveCurrentBet,
  assignPositions,
  detectStreet,
} from '../src/content-script/scraper';
import { card } from './helpers';

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
