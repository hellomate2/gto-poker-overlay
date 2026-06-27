import { describe, it, expect } from 'vitest';
import { PlayerProfiler } from '../src/core/exploit/profiler';
import { OpponentTracker } from '../src/core/exploit/tracker';
import { PlayerStats, PlayerType } from '../src/types/poker';

/**
 * Build a PlayerStats object that, via tracker.computeDisplayStats, produces
 * the target VPIP / PFR / AF over `hands` hands.
 *  - vpip% = vpipCount / hands
 *  - pfr%  = pfrCount  / hands
 *  - af    = (betCount + raiseCount) / callCount
 */
function statsFor(opts: {
  name: string;
  hands: number;
  vpipPct: number;
  pfrPct: number;
  af: number;
}): PlayerStats {
  const { name, hands, vpipPct, pfrPct, af } = opts;
  const callCount = 20;
  const aggressive = Math.round(af * callCount);
  return {
    playerName: name,
    handsPlayed: hands,
    vpipCount: Math.round((vpipPct / 100) * hands),
    pfrCount: Math.round((pfrPct / 100) * hands),
    threeBetCount: 0,
    threeBetOpportunity: 0,
    foldToThreeBetCount: 0,
    foldToThreeBetOpportunity: 0,
    coldCallCount: 0,
    coldCallOpportunity: 0,
    cbetFlopCount: 0,
    cbetFlopOpportunity: 0,
    cbetTurnCount: 0,
    cbetTurnOpportunity: 0,
    foldToCbetFlopCount: 0,
    foldToCbetFlopOpportunity: 0,
    foldToCbetTurnCount: 0,
    foldToCbetTurnOpportunity: 0,
    betCount: aggressive,
    raiseCount: 0,
    callCount,
    foldCount: 0,
    wentToShowdownCount: 0,
    wonAtShowdownCount: 0,
    showdownOpportunity: 0,
    lastSeen: Date.now(),
    firstSeen: Date.now(),
  };
}

/** Inject stats directly into a tracker's cache (computeDisplayStats reads cache only — no IndexedDB). */
function trackerWith(...stats: PlayerStats[]): OpponentTracker {
  const tracker = new OpponentTracker();
  const cache = tracker.getAllStats();
  for (const s of stats) cache.set(s.playerName, s);
  return tracker;
}

function classify(opts: { hands: number; vpipPct: number; pfrPct: number; af: number }): PlayerType {
  const s = statsFor({ name: 'P', ...opts });
  const profiler = new PlayerProfiler(trackerWith(s));
  return profiler.profile('P').type;
}

describe('PlayerProfiler classification', () => {
  it('classifies a 40/5 (loose, passive) player as a calling station', () => {
    expect(classify({ hands: 60, vpipPct: 40, pfrPct: 5, af: 0.8 })).toBe('calling_station');
  });

  it('classifies a 10/8 (very tight) player as a nit', () => {
    expect(classify({ hands: 60, vpipPct: 10, pfrPct: 8, af: 1 })).toBe('nit');
  });

  it('classifies a 22/19 aggressive player as a TAG', () => {
    expect(classify({ hands: 60, vpipPct: 22, pfrPct: 19, af: 2.5 })).toBe('tag');
  });

  it('classifies a 33/24 aggressive player as a LAG', () => {
    expect(classify({ hands: 60, vpipPct: 33, pfrPct: 24, af: 2.5 })).toBe('lag');
  });

  it('classifies a 50/40 hyper-aggressive player as a maniac', () => {
    expect(classify({ hands: 60, vpipPct: 50, pfrPct: 40, af: 4 })).toBe('maniac');
  });

  it('AF: a pure-aggression player (bets/raises, ZERO calls) is seen as aggressive, not passive', () => {
    // Regression: af used `callCount>0 ? ratio : 0`, so a maniac who never flat-calls
    // got AF=0 and was mislabeled a nit/station — flipping the exploit backwards.
    const aggressor: PlayerStats = {
      ...statsFor({ name: 'M', hands: 80, vpipPct: 55, pfrPct: 45, af: 0 }),
      betCount: 12, raiseCount: 8, callCount: 0, // bets/raises a ton, never flat-calls
    };
    const p = new PlayerProfiler(trackerWith(aggressor)).profile('M');
    expect(p.stats.aggressionFactor).toBeGreaterThan(5); // was 0 (looked maximally passive)
    expect(p.type).toBe('maniac'); // was mislabeled nit/calling_station
  });
});

describe('PlayerProfiler confidence & sample size', () => {
  it('returns unknown with zero confidence for an untracked player', () => {
    const profiler = new PlayerProfiler(trackerWith());
    const p = profiler.profile('Ghost');
    expect(p.type).toBe('unknown');
    expect(p.confidence).toBe(0);
  });

  it('gives higher confidence with more hands', () => {
    const few = new PlayerProfiler(
      trackerWith(statsFor({ name: 'A', hands: 20, vpipPct: 40, pfrPct: 5, af: 0.8 })),
    ).profile('A');
    const many = new PlayerProfiler(
      trackerWith(statsFor({ name: 'B', hands: 100, vpipPct: 40, pfrPct: 5, af: 0.8 })),
    ).profile('B');
    expect(many.confidence).toBeGreaterThan(few.confidence);
    expect(many.confidence).toBeLessThanOrEqual(1);
  });

  it('pins the three confidence tiers exactly', () => {
    // hands<15:   hands/30 * 0.25   (e.g. 10 -> 0.0833)
    // 15<=hands<30: hands/30 * 0.5  (e.g. 20 -> 0.3333)
    // hands>=30:  min(1, hands/100) (e.g. 60 -> 0.6, 100 -> 1)
    const conf = (hands: number) =>
      new PlayerProfiler(trackerWith(statsFor({ name: 'X', hands, vpipPct: 40, pfrPct: 5, af: 0.8 }))).profile('X').confidence;
    expect(conf(10)).toBeCloseTo(10 / 30 * 0.25, 4); // ~0.0833
    expect(conf(20)).toBeCloseTo(20 / 30 * 0.5, 4);  // ~0.3333
    expect(conf(60)).toBeCloseTo(0.6, 4);
    expect(conf(100)).toBe(1);
    expect(conf(500)).toBe(1); // saturates
  });

  it('surfaces computed VPIP/PFR back through the profile stats', () => {
    const profiler = new PlayerProfiler(
      trackerWith(statsFor({ name: 'C', hands: 100, vpipPct: 25, pfrPct: 20, af: 2 })),
    );
    const p = profiler.profile('C');
    expect(p.stats.vpip).toBeCloseTo(25, 0);
    expect(p.stats.pfr).toBeCloseTo(20, 0);
    expect(p.stats.aggressionFactor).toBeCloseTo(2, 1);
  });

  it('profileAll returns a profile per tracked player', () => {
    const profiler = new PlayerProfiler(
      trackerWith(
        statsFor({ name: 'A', hands: 60, vpipPct: 40, pfrPct: 5, af: 0.8 }),
        statsFor({ name: 'B', hands: 60, vpipPct: 10, pfrPct: 8, af: 1 }),
      ),
    );
    const all = profiler.profileAll();
    expect(all.size).toBe(2);
    expect(all.get('A')!.type).toBe('calling_station');
    expect(all.get('B')!.type).toBe('nit');
  });
});

describe('PlayerProfiler static helpers', () => {
  it('maps EVERY type to its exact HUD label', () => {
    expect(PlayerProfiler.typeLabel('nit')).toBe('NIT');
    expect(PlayerProfiler.typeLabel('tag')).toBe('TAG');
    expect(PlayerProfiler.typeLabel('lag')).toBe('LAG');
    expect(PlayerProfiler.typeLabel('calling_station')).toBe('FISH');
    expect(PlayerProfiler.typeLabel('maniac')).toBe('MAN');
    expect(PlayerProfiler.typeLabel('unknown')).toBe('???');
  });

  it('maps EVERY type to its exact HUD color (incl. unknown gray)', () => {
    // Pin the hex values: a swap (nit<->tag) keeps colors distinct but is wrong.
    expect(PlayerProfiler.typeColor('nit')).toBe('#4a90d9');
    expect(PlayerProfiler.typeColor('tag')).toBe('#2ecc71');
    expect(PlayerProfiler.typeColor('lag')).toBe('#f39c12');
    expect(PlayerProfiler.typeColor('calling_station')).toBe('#e74c3c');
    expect(PlayerProfiler.typeColor('maniac')).toBe('#9b59b6');
    expect(PlayerProfiler.typeColor('unknown')).toBe('#95a5a6');
    // And all six are distinct.
    const all: PlayerType[] = ['nit', 'tag', 'lag', 'calling_station', 'maniac', 'unknown'];
    expect(new Set(all.map(t => PlayerProfiler.typeColor(t))).size).toBe(6);
  });

  it('describes each type with a DISCRIMINATING, non-empty string', () => {
    // A discriminating substring catches a swapped/placeholder description that a
    // bare length>0 check would miss.
    expect(PlayerProfiler.describeType('nit')).toMatch(/tight/i);
    expect(PlayerProfiler.describeType('tag')).toMatch(/tight-aggressive/i);
    expect(PlayerProfiler.describeType('lag')).toMatch(/loose-aggressive/i);
    expect(PlayerProfiler.describeType('calling_station')).toMatch(/passive|caller/i);
    expect(PlayerProfiler.describeType('maniac')).toMatch(/aggressive/i);
    expect(PlayerProfiler.describeType('unknown')).toMatch(/not enough data/i);
  });
});

// ============================================================
// classify() fallback branches — the brittle, overlapping later rules that the
// archetype tests above never reach. Uses hands=100 so the reverse-engineered
// vpip/pfr land on exact integers (no rounding ambiguity at the boundaries).
// ============================================================

describe('PlayerProfiler classify() fallback branches', () => {
  it('17/16 af=2.5 -> tag (the vpip<20 && pfr>15 && af>2 nuance rule)', () => {
    expect(classify({ hands: 100, vpipPct: 17, pfrPct: 16, af: 2.5 })).toBe('tag');
  });

  it('18/2 af=0.5 -> nit (the vpip<20 && af<1.5 nuance rule)', () => {
    expect(classify({ hands: 100, vpipPct: 18, pfrPct: 2, af: 0.5 })).toBe('nit');
  });

  it('40/16 af=0.8 -> calling_station (the vpip>35 && af<1 nuance rule)', () => {
    expect(classify({ hands: 100, vpipPct: 40, pfrPct: 16, af: 0.8 })).toBe('calling_station');
  });

  it('22/14 af=2.5 -> tag (default: af>2, vpip<=25)', () => {
    expect(classify({ hands: 100, vpipPct: 22, pfrPct: 14, af: 2.5 })).toBe('tag');
  });

  it('a tracked player matching no archetype returns unknown (NOT the null-stats path)', () => {
    // 22/14 af=1.6: too loose for nit, too tight/under-aggressive for tag/lag, not
    // passive-enough-and-loose for calling_station -> falls through to 'unknown'
    // even though hands>0 (confidence > 0). Distinct from the untracked case.
    const p = new PlayerProfiler(
      trackerWith(statsFor({ name: 'U', hands: 100, vpipPct: 22, pfrPct: 14, af: 1.6 })),
    ).profile('U');
    expect(p.type).toBe('unknown');
    expect(p.confidence).toBeGreaterThan(0);
  });

  it('DOCUMENTS a classify boundary quirk: 28/24 af=2.0 falls to unknown (strict af>2)', () => {
    // A clearly LAG-ish 28/24 player with af exactly 2.0 fails lag (needs af>2),
    // fails the default af>2 branch, and ends as 'unknown'. This locks in the
    // current (arguably-too-strict) boundary so an intentional fix is a conscious
    // change, not a silent drift. See profiler.ts classify() default branch.
    expect(classify({ hands: 100, vpipPct: 28, pfrPct: 24, af: 2.0 })).toBe('unknown');
  });
});

// ============================================================
// computeDisplayStats division-by-zero / empty guards — never exercised by the
// statsFor helper (which always uses callCount=20, handsPlayed>0).
// ============================================================

describe('computeDisplayStats guards (via profile)', () => {
  it('callCount=0 WITH aggression yields a HIGH (finite) aggressionFactor, not passive', () => {
    // bets 5x, never flat-calls -> maximally aggressive. The old code returned 0
    // here (no divide-by-zero, but it made a maniac look passive). Must be high+finite.
    const base = statsFor({ name: 'Z', hands: 60, vpipPct: 30, pfrPct: 10, af: 1 });
    const profiler = new PlayerProfiler(
      trackerWith({ ...base, callCount: 0, betCount: 5, raiseCount: 0 }),
    );
    const af = profiler.profile('Z').stats.aggressionFactor;
    expect(Number.isFinite(af)).toBe(true); // no divide-by-zero / Infinity
    expect(af).toBeGreaterThan(5);
  });

  it('callCount=0 with NO aggression (only posted/folded) stays 0', () => {
    const base = statsFor({ name: 'Z2', hands: 60, vpipPct: 30, pfrPct: 10, af: 1 });
    const profiler = new PlayerProfiler(
      trackerWith({ ...base, callCount: 0, betCount: 0, raiseCount: 0 }),
    );
    expect(profiler.profile('Z2').stats.aggressionFactor).toBe(0);
  });

  it('handsPlayed=0 is treated as untracked: unknown, confidence 0', () => {
    const base = statsFor({ name: 'Z0', hands: 0, vpipPct: 0, pfrPct: 0, af: 0 });
    const p = new PlayerProfiler(trackerWith({ ...base, handsPlayed: 0 })).profile('Z0');
    expect(p.type).toBe('unknown');
    expect(p.confidence).toBe(0);
  });
});
