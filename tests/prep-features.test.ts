import { describe, it, expect } from 'vitest';
import { parseRow } from '../ml/prep';

// ============================================================
// Betting-action features (isPreflopAggressor / facedRaiseThisStreet /
// streetBetCount) are parsed from the data's postflop_action sequence in prep.ts
// and recomputed from GameState.actionHistory in the engine. Train/serve parity
// depends on both producing the same values, so we pin the TRAINING-side parse
// here against hand-built rows. (The engine mirrors this exact logic.)
// ============================================================

const HEADER: Record<string, number> = {
  '': 0, preflop_action: 1, board_flop: 2, board_turn: 3, board_river: 4,
  aggressor_position: 5, postflop_action: 6, evaluation_at: 7, available_moves: 8,
  pot_size: 9, hero_position: 10, holding: 11, correct_decision: 12,
};

function row(over: Partial<Record<keyof typeof HEADER, string>>): string[] {
  const c = new Array(13).fill('');
  c[1] = 'HJ/2.0bb/BB/call';
  c[2] = 'Kc7d2s';            // flop
  c[7] = 'Flop';
  c[8] = "['Check', 'Bet 5']";
  c[9] = '100';
  c[10] = 'IP';
  c[11] = 'AhKh';
  c[12] = 'Bet 5';
  c[5] = 'IP';
  c[6] = 'OOP_CHECK';
  for (const k of Object.keys(over)) c[HEADER[k as keyof typeof HEADER]] = over[k as keyof typeof HEADER]!;
  return c;
}

describe('prep action-context features (train side)', () => {
  it('flop checked to the preflop aggressor: PFA=true, no bets/raises this street', () => {
    const p = parseRow(row({ aggressor_position: 'IP', hero_position: 'IP', postflop_action: 'OOP_CHECK' }), HEADER)!;
    expect(p).not.toBeNull();
    expect(p.spot.isPreflopAggressor).toBe(true);
    expect(p.spot.streetBetCount).toBe(0);
    expect(p.spot.facedRaiseThisStreet).toBe(false);
  });

  it('turn, hero is NOT the preflop aggressor and faces a single bet', () => {
    const p = parseRow(row({
      aggressor_position: 'IP', hero_position: 'OOP',
      board_turn: 'Th', evaluation_at: 'Turn',
      postflop_action: 'OOP_CHECK/IP_BET_5/OOP_CALL/dealcards/Th/OOP_CHECK/IP_BET_10',
      available_moves: "['Fold', 'Call 10', 'Raise 30']", correct_decision: 'Call',
    }), HEADER)!;
    expect(p.spot.isPreflopAggressor).toBe(false);
    expect(p.spot.streetBetCount).toBe(1);   // only IP_BET_10 on the turn segment
    expect(p.spot.facedRaiseThisStreet).toBe(false);
  });

  it('river raised pot: two aggressive actions this street, facedRaise=true', () => {
    const p = parseRow(row({
      aggressor_position: 'OOP', hero_position: 'OOP',
      board_turn: 'Th', board_river: '2s', evaluation_at: 'River',
      postflop_action: 'OOP_CHECK/IP_CHECK/dealcards/Th/OOP_CHECK/IP_CHECK/dealcards/2s/OOP_BET_5/IP_RAISE_15',
      available_moves: "['Fold', 'Call 10', 'Raise 40']", correct_decision: 'Fold',
    }), HEADER)!;
    expect(p.spot.isPreflopAggressor).toBe(true);   // OOP === aggressor OOP
    expect(p.spot.streetBetCount).toBe(2);          // OOP_BET_5 + IP_RAISE_15
    expect(p.spot.facedRaiseThisStreet).toBe(true);
  });
});
