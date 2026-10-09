import { describe, it, expect } from 'vitest';
import { getGTOAdvice } from '../src/core/ranges/gto-advisor';
import { GameState, Player, Position, Action } from '../src/types/poker';
import { card } from './helpers';

// ============================================================
// Regression tests for three audit findings in gto-advisor.ts (6-max preflop):
//   F1: a 6-max pot that got down to two live players was routed to the
//       heads-up preflop engine (HU charts are ~80% SB opens and a very wide
//       BB defense, far too loose for 6-max positions).
//   F2: facing an all-in, the effective stack was measured against the biggest
//       opponent at the table (folded or still to act), not the jammer, so a
//       100bb hero facing a 2bb jam used the 50bb+ premium-only call range.
//   F3: the heads-up push/fold shove table was applied to the BTN first-in at a
//       6-max table with SB and BB still to act.
// ============================================================

const BB = 20;
const SEATS: Position[] = ['BTN', 'SB', 'BB', 'UTG', 'MP', 'CO'];

/**
 * A 6-max table in seat order BTN, SB, BB, UTG, MP, CO (the sim/scraper
 * template). `stacks`/`bets` override per position; blinds post by default.
 */
function sixMax(opts: {
  hero: Position;
  hole: [string, string];
  preflop: Action[];
  currentBet: number;
  stacks?: Partial<Record<Position, number>>;
  bets?: Partial<Record<Position, number>>;
}): GameState {
  const bets: Partial<Record<Position, number>> = { SB: BB / 2, BB, ...(opts.bets || {}) };
  const players: Player[] = SEATS.map((pos, i) => ({
    name: pos === opts.hero ? 'Hero' : pos,
    stack: (opts.stacks?.[pos] ?? 100 * BB) - (bets[pos] ?? 0),
    position: pos,
    isDealer: pos === 'BTN',
    isSittingOut: false,
    seatIndex: i,
    isHero: pos === opts.hero,
    currentBet: bets[pos] ?? 0,
    hasActed: false,
  }));
  const heroIndex = SEATS.indexOf(opts.hero);
  const pot = players.reduce((s, p) => s + p.currentBet, 0);
  return {
    tableId: 't', handNumber: 1, street: 'preflop', pot, sidePots: [],
    heroCards: [card(opts.hole[0]), card(opts.hole[1])], communityCards: [],
    players, heroIndex, dealerIndex: 0, activePlayerIndex: heroIndex,
    currentBet: opts.currentBet, minRaise: opts.currentBet * 2, bigBlind: BB, smallBlind: BB / 2,
    actionHistory: { preflop: opts.preflop, flop: [], turn: [], river: [] },
    isOurTurn: true, timestamp: 0,
  };
}

const fold = (name: string): Action => ({ type: 'fold', playerName: name });
const raise = (name: string, amount: number): Action => ({ type: 'raise', playerName: name, amount });

describe('F1: a 6-max pot down to two players keeps the 6-max charts', () => {
  it('BB vs a UTG open (folded around) uses the 6-max BB-vs-UTG chart, not HU BB defense', () => {
    for (const hole of [['Kh', '5c'], ['Qh', '7c'], ['Th', '7c'], ['7h', '2h']] as [string, string][]) {
      const s = sixMax({
        hero: 'BB', hole, currentBet: 50, bets: { UTG: 50 },
        preflop: [raise('UTG', 50), fold('MP'), fold('CO'), fold('BTN'), fold('SB')],
      });
      const a = getGTOAdvice(s)!;
      expect(a.scenario).not.toMatch(/^HU /);
      expect(a.scenario).toContain('BB vs UTG Open');
      expect(a.actions[0].action).toBe('Fold');
    }
  });

  it('SB first-in (folded to SB, 100bb) uses the 6-max SB-RFI chart, not the HU SB open', () => {
    for (const hole of [['Kh', '4c'], ['Qh', '6c'], ['7h', '2h'], ['8h', '6c']] as [string, string][]) {
      const s = sixMax({
        hero: 'SB', hole, currentBet: BB,
        preflop: [fold('UTG'), fold('MP'), fold('CO'), fold('BTN')],
      });
      const a = getGTOAdvice(s)!;
      expect(a.scenario).not.toMatch(/^HU /);
      expect(a.actions[0].action).toBe('Fold');
    }
  });

  it('CO facing a BTN 3-bet with the blinds folded uses the 6-max chart', () => {
    for (const hole of [['2h', '2c'], ['Kh', '5h'], ['Th', '7h'], ['Ah', '9c']] as [string, string][]) {
      const s = sixMax({
        hero: 'CO', hole, currentBet: 150, bets: { CO: 50, BTN: 150 },
        preflop: [fold('UTG'), fold('MP'), raise('Hero', 50), raise('BTN', 150), fold('SB'), fold('BB')],
      });
      const a = getGTOAdvice(s)!;
      expect(a.scenario).not.toMatch(/^HU /);
      expect(a.actions[0].action).toBe('Fold');
    }
  });

  it('a real heads-up table still uses the heads-up engine', () => {
    const players: Player[] = [
      { name: 'Hero', stack: 1990, position: 'SB', isDealer: true, isSittingOut: false, seatIndex: 0, isHero: true, currentBet: 10, hasActed: false },
      { name: 'V', stack: 1980, position: 'BB', isDealer: false, isSittingOut: false, seatIndex: 1, isHero: false, currentBet: 20, hasActed: false },
    ];
    const s: GameState = {
      tableId: 't', handNumber: 1, street: 'preflop', pot: 30, sidePots: [],
      heroCards: [card('Kh'), card('4c')], communityCards: [], players, heroIndex: 0, dealerIndex: 0,
      activePlayerIndex: 0, currentBet: 20, minRaise: 40, bigBlind: 20, smallBlind: 10,
      actionHistory: { preflop: [], flop: [], turn: [], river: [] }, isOurTurn: true, timestamp: 0,
    };
    const a = getGTOAdvice(s)!;
    expect(a.scenario).toMatch(/^HU SB Open/);
  });
});

describe('F2: facing an all-in, the effective stack is measured against the jammer', () => {
  // UTG jams 2bb (40 chips total), MP and CO fold, hero BTN has 100bb, blinds to act.
  const jam = (hole: [string, string]) => sixMax({
    hero: 'BTN', hole, currentBet: 40, stacks: { UTG: 40 }, bets: { UTG: 40 },
    preflop: [{ type: 'allin', playerName: 'UTG', amount: 40 }, fold('MP'), fold('CO')],
  });

  it('reports a 2bb effective stack, not 100bb', () => {
    const a = getGTOAdvice(jam(['Kh', 'Jc']))!;
    expect(a.scenario).toContain('(2bb eff)');
  });

  it('continues with KJo, A9s, KQo, 88, AQs and TT against a 2bb jam', () => {
    for (const hole of [['Kh', 'Jc'], ['Ah', '9h'], ['Kh', 'Qc'], ['8h', '8c'], ['Ah', 'Qh'], ['Th', 'Tc']] as [string, string][]) {
      const a = getGTOAdvice(jam(hole))!;
      expect(a.actions[0].action).not.toBe('Fold');
      expect(a.inRange).toBe(true);
    }
  });

  it('a deep jam from a deep stack still uses the deep premium-only range', () => {
    const s = sixMax({
      hero: 'BTN', hole: ['Th', 'Tc'], currentBet: 2000, bets: { UTG: 2000 },
      preflop: [{ type: 'allin', playerName: 'UTG', amount: 2000 }, fold('MP'), fold('CO')],
    });
    const a = getGTOAdvice(s)!;
    expect(a.scenario).toContain('(100bb eff)');
    expect(a.actions[0].action).toBe('Fold');
  });
});

describe('F3: first-in push/fold only applies heads-up against the big blind', () => {
  // Folded to hero at 10bb with deep blinds behind.
  const btnShort = (hole: [string, string]) => sixMax({
    hero: 'BTN', hole, currentBet: BB, stacks: { BTN: 10 * BB },
    preflop: [fold('UTG'), fold('MP'), fold('CO')],
  });

  it('BTN at 10bb with SB and BB to act does not get the HU open-jam table', () => {
    for (const hole of [['Kh', '5c'], ['Qh', '8c'], ['Jh', '4h'], ['Th', '6h']] as [string, string][]) {
      const a = getGTOAdvice(btnShort(hole))!;
      expect(a.scenario).not.toContain('Push/Fold');
      expect(a.actions[0].action).not.toBe('All-In');
    }
  });

  it('SB at 10bb folded to (only the BB behind) still uses the push/fold table', () => {
    const s = sixMax({
      hero: 'SB', hole: ['Kh', '5c'], currentBet: BB, stacks: { SB: 10 * BB },
      preflop: [fold('UTG'), fold('MP'), fold('CO'), fold('BTN')],
    });
    const a = getGTOAdvice(s)!;
    expect(a.scenario).toContain('Push/Fold');
  });

  it('effective stack for the SB push/fold spot is measured against the BB, not folded deep stacks', () => {
    const s = sixMax({
      hero: 'SB', hole: ['Kh', '5c'], currentBet: BB, stacks: { SB: 40 * BB, BB: 8 * BB },
      preflop: [fold('UTG'), fold('MP'), fold('CO'), fold('BTN')],
    });
    const a = getGTOAdvice(s)!;
    expect(a.scenario).toContain('Push/Fold');
    expect(a.scenario).toContain('(8bb eff)');
  });
});
