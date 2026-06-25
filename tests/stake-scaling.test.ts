import { describe, it, expect, vi } from 'vitest';

// Stub IndexedDB-backed storage so decide() runs in node.
vi.mock('../src/storage/db', async () => {
  const actual = await vi.importActual<typeof import('../src/storage/db')>('../src/storage/db');
  return { ...actual, getPlayerStats: async () => null, savePlayerStats: async () => {} };
});

import { DecisionEngine } from '../src/core/engine';
import { GameState, Player, Position } from '../src/types/poker';
import { card } from './helpers';
import { clampRaiseAmount, amountMatches } from '../src/content-script/executor';

// Build a heads-up PREFLOP, hero = SB (button, acts first), unopened pot, with
// arbitrary stake sizes so we can verify big-blind conversion and sizing scale
// correctly across whole-chip and decimal ($0.25/$0.50) games.
function preflopState(opts: {
  bb: number; sb: number; stack: number; heroCards: [string, string];
}): GameState {
  const { bb, sb, stack } = opts;
  const hero: Player = {
    name: 'Hero', stack, position: 'SB' as Position, isDealer: true,
    isSittingOut: false, seatIndex: 0, isHero: true, currentBet: sb, hasActed: false,
  };
  const villain: Player = {
    name: 'Villain', stack, position: 'BB' as Position, isDealer: false,
    isSittingOut: false, seatIndex: 1, isHero: false, currentBet: bb, hasActed: false,
  };
  return {
    tableId: 't', handNumber: 1, street: 'preflop', pot: sb + bb, sidePots: [],
    heroCards: [card(opts.heroCards[0]), card(opts.heroCards[1])],
    communityCards: [], players: [hero, villain], heroIndex: 0, dealerIndex: 0,
    activePlayerIndex: 0, currentBet: bb, minRaise: bb, bigBlind: bb, smallBlind: sb,
    actionHistory: { preflop: [], flop: [], turn: [], river: [] },
    isOurTurn: true, timestamp: Date.now(),
  };
}

describe('stake scaling — big-blind conversion is stake-independent', () => {
  it('opens ~2.5bb at WHOLE-CHIP stakes (10/20, 1000 = 50bb)', async () => {
    const d = await new DecisionEngine().decide(
      preflopState({ bb: 20, sb: 10, stack: 1000, heroCards: ['Ah', 'Ks'] }),
    );
    expect(d.action).toBe('raise');
    // 2.5bb of 20 = 50. Allow a band; must NOT be an all-in.
    expect(d.amount!).toBeGreaterThanOrEqual(40);
    expect(d.amount!).toBeLessThanOrEqual(60);
    expect(d.amount!).toBeLessThan(1000);
  });

  it('opens ~2.5bb at DECIMAL stakes ($0.25/$0.50, $50 = 100bb) without collapsing to a whole dollar', async () => {
    const d = await new DecisionEngine().decide(
      preflopState({ bb: 0.5, sb: 0.25, stack: 50, heroCards: ['Ah', 'Ks'] }),
    );
    expect(d.action).toBe('raise');
    // 2.5bb of 0.50 = $1.25. The OLD bug rounded this to $1 (or worse).
    expect(d.amount!).toBeGreaterThanOrEqual(1.0);
    expect(d.amount!).toBeLessThanOrEqual(1.5);
    expect(d.amount!).not.toBe(1);          // not integer-collapsed
    expect(d.amount!).toBeLessThan(50);     // not an all-in
  });

  it('treats a genuinely short DECIMAL stack as short (10bb) — push/fold jam, not a misread', async () => {
    // $5 at $0.25/$0.50 = 10bb. A wide button range jams here; AA certainly does.
    const d = await new DecisionEngine().decide(
      preflopState({ bb: 0.5, sb: 0.25, stack: 5, heroCards: ['Ah', 'Ad'] }),
    );
    expect(['allin', 'raise']).toContain(d.action);
    // If it jams, the all-in "to" is the whole stack plus chips already posted
    // (here $5 + $0.25 SB = $5.25), in dollars — not a misread.
    if (d.action === 'allin') {
      expect(d.amount!).toBeGreaterThanOrEqual(5);
      expect(d.amount!).toBeLessThanOrEqual(5.5);
    }
  });
});

describe('executor amount handling preserves decimal stakes', () => {
  it('clampRaiseAmount keeps cents instead of forcing whole chips', () => {
    expect(clampRaiseAmount(1.25, { min: 0.5, max: 50 }).amount).toBe(1.25);
    expect(clampRaiseAmount(0.755, { min: 0.5, max: 50 }).amount).toBe(0.76); // rounds to cents
    expect(clampRaiseAmount(50, { min: 40, max: 980 }).amount).toBe(50);      // whole-chip unchanged
  });

  it('clampRaiseAmount still clamps to legal min/max', () => {
    expect(clampRaiseAmount(0.1, { min: 0.5, max: 50 }).amount).toBe(0.5);
    expect(clampRaiseAmount(999, { min: 0.5, max: 50 }).amount).toBe(50);
  });

  it('amountMatches no longer treats $1.25 as equal to $1', () => {
    expect(amountMatches(1.25, 1, 0.04)).toBe(false); // the decimal-stakes bug, now fixed
    expect(amountMatches(1.25, 1.25, 0.04)).toBe(true);
    expect(amountMatches(50, 50, 1.5)).toBe(true);     // whole-chip still matches
  });
});
