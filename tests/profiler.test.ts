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
  it('maps types to HUD labels', () => {
    expect(PlayerProfiler.typeLabel('calling_station')).toBe('FISH');
    expect(PlayerProfiler.typeLabel('maniac')).toBe('MAN');
    expect(PlayerProfiler.typeLabel('unknown')).toBe('???');
  });

  it('provides a distinct color per known type', () => {
    const types: PlayerType[] = ['nit', 'tag', 'lag', 'calling_station', 'maniac'];
    const colors = types.map(t => PlayerProfiler.typeColor(t));
    expect(new Set(colors).size).toBe(types.length);
  });

  it('describes each type with non-empty text', () => {
    for (const t of ['nit', 'tag', 'lag', 'calling_station', 'maniac', 'unknown'] as PlayerType[]) {
      expect(PlayerProfiler.describeType(t).length).toBeGreaterThan(0);
    }
  });
});
