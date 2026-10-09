import { describe, it, expect, vi } from 'vitest';

// The DecisionEngine reads opponent stats from IndexedDB, absent in node. Stub
// only the storage layer, as the other engine tests do.
vi.mock('../src/storage/db', async () => {
  const actual = await vi.importActual<typeof import('../src/storage/db')>('../src/storage/db');
  return { ...actual, getPlayerStats: async () => null, savePlayerStats: async () => {} };
});

import { getGTOAdvice, solvePushFold } from '../src/core/ranges/gto-advisor';
import { DecisionEngine } from '../src/core/engine';
import { GameState, Player, Position, Action } from '../src/types/poker';
import { card } from './helpers';

// ============================================================
// Regression tests for three audit findings in gto-advisor.ts (6-max preflop):
//   F1: a 6-max pot that got down to two live players was routed to the
//       heads-up preflop engine (HU charts are ~80% SB opens and a very wide
//       BB defense, far too loose for 6-max positions).
//   F2: facing a jam, the call/fold range ignored who jammed and how many
//       players were left to act. The effective stack was measured against the
//       deepest opponent at the table (so a 100bb hero facing a short jam used
//       the 50bb+ premium-only range), a shove logged as a raise (the scraper
//       never logs 'allin') under 12bb was not seen as a jam at all, and a
//       first fix fed the jammer's stack into the heads-up SB-vs-BB Nash call
//       table for every position, so MP called 33% of hands into four players.
//       Now: HU Nash only for the SB jamming into the BB; otherwise pot odds
//       against the jammer's chart range, tightened for players behind.
//   F3: the heads-up push/fold shove table was applied to the BTN first-in at a
//       6-max table with SB and BB still to act. Now the BTN jams or folds by
//       chip EV against both blinds (shortStackOpenJam); the first fix fell
//       through to the 2.5bb open chart instead.
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

/** A shove as the live scraper and sim/ring.ts log it: type 'raise', the jammer's stack 0. */
const shove = (name: string, amount: number): Action => ({ type: 'raise', playerName: name, amount });
const first = (s: GameState) => getGTOAdvice(s)!.actions[0].action;

describe('F2: facing a jam, the call range fits the jammer and the players behind', () => {
  // UTG shoves 10bb (logged as a raise), everyone else 100bb.
  const utgJam10 = (hero: Position, hole: [string, string], folds: string[]) => sixMax({
    hero, hole, currentBet: 200, stacks: { UTG: 200 }, bets: { UTG: 200 },
    preflop: [shove('UTG', 200), ...folds.map(fold)],
  });

  it('a 10bb shove logged as a raise is read as a jam (stack 0), not as an open', () => {
    const a = getGTOAdvice(utgJam10('BB', ['7h', '7c'], ['MP', 'CO', 'BTN', 'SB']))!;
    expect(a.scenario).toContain('Facing all-in');
    expect(a.scenario).toContain('(10bb eff)');
  });

  it('BB vs a UTG 10bb jam with nobody behind calls on pot odds vs the UTG range (77, ATo, KQs call; K9o, JTo fold)', () => {
    const s = (h: [string, string]) => utgJam10('BB', h, ['MP', 'CO', 'BTN', 'SB']);
    for (const h of [['7h', '7c'], ['Ah', 'Tc'], ['Kh', 'Qh']] as [string, string][]) expect(first(s(h))).toBe('Call');
    for (const h of [['Kh', '9c'], ['Jh', 'Tc'], ['Ah', '5c']] as [string, string][]) expect(first(s(h))).toBe('Fold');
  });

  it('MP vs a UTG 10bb jam with four deep players behind: K9o/Q9s/A5o/JTo fold, AA calls (never All-In)', () => {
    const s = (h: [string, string]) => utgJam10('MP', h, []);
    for (const h of [['Kh', '9c'], ['Qh', '9h'], ['Ah', '5c'], ['Jh', 'Tc']] as [string, string][]) {
      expect(first(s(h))).toBe('Fold');
    }
    expect(first(s(['Ah', 'Ad']))).toBe('Call');
  });

  it('players behind tighten the range: 77 calls from the BB but folds from MP', () => {
    expect(first(utgJam10('BB', ['7h', '7c'], ['MP', 'CO', 'BTN', 'SB']))).toBe('Call');
    expect(first(utgJam10('MP', ['7h', '7c'], []))).toBe('Fold');
  });

  it('the heads-up Nash call table is used for an SB jam into the BB (K9o calls 10bb)', () => {
    const s = sixMax({
      hero: 'BB', hole: ['Kh', '9c'], currentBet: 200, stacks: { SB: 200 }, bets: { SB: 200 },
      preflop: [fold('UTG'), fold('MP'), fold('CO'), fold('BTN'), shove('SB', 200)],
    });
    const a = getGTOAdvice(s)!;
    expect(a.scenario).toContain('HU Nash');
    expect(a.actions[0].action).toBe('Call');
  });

  it('a 2bb jam is a 2bb decision: TT and AQs continue against a UTG 2bb jam with the blinds behind', () => {
    for (const h of [['Th', 'Tc'], ['Ah', 'Qh']] as [string, string][]) {
      const s = sixMax({
        hero: 'BTN', hole: h, currentBet: 40, stacks: { UTG: 40 }, bets: { UTG: 40 },
        preflop: [{ type: 'allin', playerName: 'UTG', amount: 40 }, fold('MP'), fold('CO')],
      });
      const a = getGTOAdvice(s)!;
      expect(a.scenario).toContain('(2bb eff)');
      expect(a.actions[0].action).toBe('Call');
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

  it('engine: MP with AA calls a UTG 10bb jam with four behind (no 30bb isolation raise); K9o folds', async () => {
    const saved = Math.random;
    Math.random = () => 0.5;
    try {
      const eng = new DecisionEngine();
      const aa = await eng.decide(utgJam10('MP', ['Ah', 'Ad'], []));
      expect(aa.action).toBe('call');
      const k9 = await eng.decide(utgJam10('MP', ['Kh', '9c'], []));
      expect(k9.action).toBe('fold');
    } finally {
      Math.random = saved;
    }
  });
});

describe('F3: first-in push/fold only applies heads-up against the big blind', () => {
  // Folded to hero at 10bb with deep blinds behind.
  const btnShort = (hole: [string, string]) => sixMax({
    hero: 'BTN', hole, currentBet: BB, stacks: { BTN: 10 * BB },
    preflop: [fold('UTG'), fold('MP'), fold('CO')],
  });

  it('BTN at 10bb with SB and BB to act does not get the HU open-jam table (K5o, Q8o, J4s, T6s fold)', () => {
    for (const hole of [['Kh', '5c'], ['Qh', '8c'], ['Jh', '4h'], ['Th', '6h']] as [string, string][]) {
      const a = getGTOAdvice(btnShort(hole))!;
      expect(a.scenario).not.toContain('Push/Fold Nash');
      expect(a.actions[0].action).toBe('Fold');
    }
  });

  it('BTN at 10bb with both blinds behind is still jam-or-fold, not a 2.5bb chart open (AA, A9o, 55 jam)', () => {
    for (const hole of [['Ah', 'Ad'], ['Ah', '9c'], ['5h', '5c']] as [string, string][]) {
      const a = getGTOAdvice(btnShort(hole))!;
      expect(a.scenario).toContain('Short-stack open jam vs 2 behind');
      expect(a.actions[0].action).toBe('All-In');
    }
  });

  it('SB at 10bb behind a limper jams or folds (no HU table, no 2.5bb chart open)', () => {
    for (const hole of [['Ah', 'Ad'], ['7h', '2c']] as [string, string][]) {
      const s = sixMax({
        hero: 'SB', hole, currentBet: BB, stacks: { SB: 10 * BB }, bets: { CO: BB },
        preflop: [fold('UTG'), fold('MP'), { type: 'call', playerName: 'CO', amount: BB }, fold('BTN')],
      });
      const a = getGTOAdvice(s)!;
      expect(a.scenario).toContain('Short-stack open jam vs 2 behind');
      expect(a.actions[0].action).toBe(hole[0] === 'Ah' ? 'All-In' : 'Fold');
    }
  });

  it('the push/fold fixed point reproduces the heads-up tables roughly and tightens with players behind', () => {
    // Heads-up SB vs BB at 10bb: pushfold-nash.ts jams 49.6% and calls 33.3% of
    // combos; the threshold fixed point lands near that (it orders ranges by
    // PREFLOP_STRENGTH, not by exact best response).
    const hu = solvePushFold(BB / 2, 10 * BB, [{ bet: BB, total: 10 * BB }], 0);
    expect(hu.jamShare).toBeGreaterThan(0.45);
    expect(hu.jamShare).toBeLessThan(0.65);
    expect(hu.callShare[0]).toBeGreaterThan(0.28);
    expect(hu.callShare[0]).toBeLessThan(0.45);
    const btn = solvePushFold(0, 10 * BB, [{ bet: BB / 2, total: 100 * BB }, { bet: BB, total: 100 * BB }], 0);
    expect(btn.jamShare).toBeLessThan(hu.jamShare);
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
