import { describe, it, expect } from 'vitest';
import {
  chooseSafeAction,
  chooseFallbackAction,
  findPromptToDismiss,
  PROMPT_DEFAULTS,
  detectStraddleAmount,
  detectStraddleFromLog,
  resolveActivePositions,
  isActionableState,
  effectivePreflopBet,
  ScrapedButton,
} from '../src/content-script/safety';

// ============================================================
// Defensive-robustness pure logic. These mirror exactly what the live executor /
// scraper feed in, so a passing test here means the live safe path is correct.
// ============================================================

describe('chooseFallbackAction — never fold a hand we meant to play', () => {
  const none = { check: false, call: false, fold: false, raise: false, bet: false };

  it('a failed RAISE on a raise-or-fold spot (no check) CALLS, never folds', () => {
    // This is the exact bug from the bot-vs-bot log: SB intends to raise, the
    // raise fails, and with no Check available the old fallback folded — so the
    // bots just traded blinds. Now it must CALL.
    expect(chooseFallbackAction({ ...none, call: true, raise: true, fold: true }, 'raise')).toBe('call');
    expect(chooseFallbackAction({ ...none, call: true, fold: true }, 'bet')).toBe('call');
    expect(chooseFallbackAction({ ...none, call: true, fold: true }, 'allin')).toBe('call');
  });

  it('a failed aggressive action CHECKS for free only when there is NO bet (no call button)', () => {
    expect(chooseFallbackAction({ ...none, check: true }, 'raise')).toBe('check');
  });

  it('prefers CALL over CHECK when a call button exists (a check would be illegal facing a bet)', () => {
    // The SB-preflop freeze: a Check button may render but checking is illegal
    // when you owe the blind, so dead-checking froze the hand. Call instead.
    expect(chooseFallbackAction({ ...none, check: true, call: true }, 'raise')).toBe('call');
  });

  it('only folds an intended-aggressive action when neither check nor call exists', () => {
    expect(chooseFallbackAction({ ...none, fold: true }, 'raise')).toBe('fold');
  });

  it('intended check/fold stays conservative (check else fold, never call)', () => {
    expect(chooseFallbackAction({ ...none, call: true, fold: true }, 'fold')).toBe('fold');
    expect(chooseFallbackAction({ ...none, check: true, call: true }, 'check')).toBe('check');
    expect(chooseFallbackAction({ ...none, call: true }, 'fold')).toBe('none');
  });

  it('no intent (engine error) is conservative: check else fold, never call', () => {
    expect(chooseFallbackAction({ ...none, call: true, fold: true })).toBe('fold');
    expect(chooseFallbackAction({ ...none, call: true })).toBe('none');
  });
});

describe('chooseSafeAction — the safe legal action when uncertain', () => {
  const none = { check: false, call: false, fold: false, raise: false, bet: false };

  it('prefers CHECK when a check button is available (never risks chips)', () => {
    expect(chooseSafeAction({ ...none, check: true, fold: true })).toBe('check');
    expect(chooseSafeAction({ ...none, check: true, call: true, raise: true })).toBe('check');
  });

  it('FOLDS when no check is available but fold is', () => {
    expect(chooseSafeAction({ ...none, fold: true, call: true, raise: true })).toBe('fold');
  });

  it('NEVER chooses call or raise even when they are the only enabled buttons', () => {
    // Defensive: we would rather fold/none than risk chips on a misread.
    expect(chooseSafeAction({ ...none, call: true })).toBe('none');
    expect(chooseSafeAction({ ...none, raise: true, bet: true })).toBe('none');
  });

  it('returns none when no action area is present', () => {
    expect(chooseSafeAction(none)).toBe('none');
  });
});

describe('findPromptToDismiss — blocking modal default-button matching', () => {
  const btns = (...texts: string[]): ScrapedButton[] =>
    texts.map((t, i) => ({ text: t, ref: i }));

  it('run-it-twice -> clicks "Run it once" (decline)', () => {
    const r = findPromptToDismiss(
      'All in! Run it twice?',
      btns('Run it twice', 'Run it once'),
    );
    expect(r?.spec.id).toBe('run-it-twice');
    expect(r?.button?.text).toBe('Run it once');
  });

  it('run-it-twice with only yes/no -> clicks "No"', () => {
    const r = findPromptToDismiss('Run it twice?', btns('Yes', 'No'));
    expect(r?.spec.id).toBe('run-it-twice');
    expect(r?.button?.text).toBe('No');
  });

  it('showdown show/muck -> clicks Muck', () => {
    const r = findPromptToDismiss('Show or muck your hand?', btns('Show', 'Muck'));
    expect(r?.spec.id).toBe('show-muck');
    expect(r?.button?.text).toBe('Muck');
  });

  it('insurance offer -> declines', () => {
    const r = findPromptToDismiss('Buy insurance?', btns('Yes', 'No thanks'));
    expect(r?.spec.id).toBe('insurance');
    expect(r?.button?.text).toBe('No thanks');
  });

  it('away / still-there nudge -> confirms presence so seat is not sat out', () => {
    const r = findPromptToDismiss(
      'Are you still there?',
      btns("I'm back", 'Leave'),
    );
    expect(r?.spec.id).toBe('still-there');
    expect(r?.button?.text).toBe("I'm back");
  });

  it('returns null when no known prompt is present', () => {
    expect(findPromptToDismiss('It is your turn', btns('Check', 'Fold'))).toBeNull();
  });

  it('matches the prompt but reports null button when no safe text is found', () => {
    const r = findPromptToDismiss('Run it twice?', btns('Maybe later', 'Whatever'));
    expect(r?.spec.id).toBe('run-it-twice');
    expect(r?.button).toBeNull();
  });

  it('button text matching is whitespace/case tolerant', () => {
    // Matching is trim+case-insensitive; the returned ref/text is the raw button.
    const r = findPromptToDismiss('RUN IT TWICE', btns('  Run It Once  '));
    expect(r?.button).not.toBeNull();
    expect(r?.button?.ref).toBe(0);
  });

  it('every default spec has at least one safe button matcher', () => {
    for (const spec of PROMPT_DEFAULTS) {
      expect(spec.safeButtons.length).toBeGreaterThan(0);
    }
  });
});

describe('detectStraddleAmount — parse a straddle from one game-log line', () => {
  it('parses "posts a straddle of N"', () => {
    expect(detectStraddleAmount('"Dave" posts a straddle of 40')).toBe(40);
  });

  it('parses "straddles N"', () => {
    expect(detectStraddleAmount('"Sam" straddles 80')).toBe(80);
  });

  it('parses a decimal straddle', () => {
    expect(detectStraddleAmount('"Ann" posts a straddle of 1.00')).toBe(1);
  });

  it('parses a comma-separated amount', () => {
    expect(detectStraddleAmount('"Big" straddle of 1,200')).toBe(1200);
  });

  it('returns null for a non-straddle line', () => {
    expect(detectStraddleAmount('"Dave" posts a big blind of 20')).toBeNull();
    expect(detectStraddleAmount('"Sam" calls 40')).toBeNull();
  });
});

describe('detectStraddleFromLog — largest straddle across log lines', () => {
  it('returns 0 with no straddle', () => {
    expect(detectStraddleFromLog(['"A" calls 20', '"B" folds'])).toBe(0);
  });

  it('returns the largest straddle seen', () => {
    expect(detectStraddleFromLog([
      '"A" posts a straddle of 40',
      '"B" posts a straddle of 80', // double straddle
      '"C" calls 80',
    ])).toBe(80);
  });
});

describe('effectivePreflopBet — straddle inflates the facing amount', () => {
  it('uses the straddle when it exceeds the big blind', () => {
    expect(effectivePreflopBet(20, 40, 0)).toBe(40);
  });

  it('uses the big blind when there is no straddle', () => {
    expect(effectivePreflopBet(20, 0, 0)).toBe(20);
  });

  it('uses the highest live raise when it exceeds both', () => {
    expect(effectivePreflopBet(20, 40, 120)).toBe(120);
  });
});

describe('resolveActivePositions — seats with sit-outs / joins', () => {
  it('heads-up: button is SB, other is BB', () => {
    // dealer index 0 -> ['SB','BB']
    expect(resolveActivePositions(2, 0)).toEqual(['SB', 'BB']);
  });

  it('6-max standard ring positions from the button', () => {
    const pos = resolveActivePositions(6, 0);
    expect(pos[0]).toBe('BTN');
    expect(pos).toContain('SB');
    expect(pos).toContain('BB');
  });

  it('a sit-out reducing 6 active to 5 still yields a legal 5-handed layout', () => {
    const pos = resolveActivePositions(5, 0);
    expect(pos.length).toBe(5);
    expect(pos[0]).toBe('BTN');
    expect(pos).toContain('SB');
    expect(pos).toContain('BB');
  });

  it('fewer than 2 active players -> no positions (cannot form a hand)', () => {
    expect(resolveActivePositions(1, 0)).toEqual([]);
    expect(resolveActivePositions(0, 0)).toEqual([]);
  });

  it('out-of-range dealer index is clamped, not crashed', () => {
    const pos = resolveActivePositions(3, 99);
    expect(pos.length).toBe(3);
  });
});

describe('isActionableState — clean-state guard before acting', () => {
  const base = { heroIndex: 0, heroCardCount: 2, numPlayers: 2, isOurTurn: true };

  it('true only when our turn, hero seat, two cards, and >=2 players', () => {
    expect(isActionableState(base)).toBe(true);
  });

  it('false when it is not our turn', () => {
    expect(isActionableState({ ...base, isOurTurn: false })).toBe(false);
  });

  it('false with no hero seat (transient seat shuffle)', () => {
    expect(isActionableState({ ...base, heroIndex: -1 })).toBe(false);
  });

  it('false when hole cards are not yet readable', () => {
    expect(isActionableState({ ...base, heroCardCount: 0 })).toBe(false);
    expect(isActionableState({ ...base, heroCardCount: 1 })).toBe(false);
  });

  it('false when fewer than two players are parsed', () => {
    expect(isActionableState({ ...base, numPlayers: 1 })).toBe(false);
    expect(isActionableState({ ...base, numPlayers: 0 })).toBe(false);
  });
});
