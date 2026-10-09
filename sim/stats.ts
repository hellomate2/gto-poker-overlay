// ============================================================
// Pressure / barrel metrics for one seat, computed from a hand's action log.
//
// These answer the human tester's two complaints directly:
//   1. "folds to raises far too often postflop"  -> fold-to-raise,
//      fold-to-turn-barrel, fold-to-river-bet (and fold-to-flop-bet for context)
//   2. "keeps barreling flop/turn/river without accounting for villain's
//      strength"                                  -> turn barrel %, river barrel %
//
// Works for any table size: "opponent" means any other seat. Every metric is
// count / opportunity, and a seat's RESPONSE to a wager is its next action on
// the same street after that wager (in multiway pots other players may act in
// between; the response is still to the wager it faced).
//
// Definitions (postflop only):
//   fold-to-raise      hero bet or raised on a street, an opponent raised over it,
//                      hero's next action was a fold. One opportunity per street.
//   fold-to-flop-bet   the first flop wager was an opponent's, hero acts after it.
//   fold-to-turn-barrel an opponent V wagered the flop and hero only called
//                      (hero made no flop bet/raise); the first turn wager is
//                      V's again; hero's response is a fold.
//   fold-to-river-bet  the first river wager was an opponent's; hero's response
//                      is a fold.
//   turn barrel        hero made the last flop wager and it was called; on the
//                      turn nobody wagered before hero's first action; hero
//                      bet. (river barrel: same, turn -> river.)
// ============================================================

import { Street } from '../src/types/poker';

/** The subset of a logged action these metrics need (ring and HU logs both fit). */
export interface MinimalAction {
  seat: number;
  street: Street;
  type: string;
  order: number;
}

export interface PressureStats {
  foldToRaiseOpp: number; foldToRaise: number;
  foldToFlopBetOpp: number; foldToFlopBet: number;
  foldToTurnBarrelOpp: number; foldToTurnBarrel: number;
  foldToRiverBetOpp: number; foldToRiverBet: number;
  turnBarrelOpp: number; turnBarrel: number;
  riverBarrelOpp: number; riverBarrel: number;
}

export function emptyPressure(): PressureStats {
  return {
    foldToRaiseOpp: 0, foldToRaise: 0,
    foldToFlopBetOpp: 0, foldToFlopBet: 0,
    foldToTurnBarrelOpp: 0, foldToTurnBarrel: 0,
    foldToRiverBetOpp: 0, foldToRiverBet: 0,
    turnBarrelOpp: 0, turnBarrel: 0,
    riverBarrelOpp: 0, riverBarrel: 0,
  };
}

export function addPressure(into: PressureStats, from: PressureStats): void {
  for (const k of Object.keys(into) as (keyof PressureStats)[]) into[k] += from[k];
}

const isWager = (t: string) => t === 'bet' || t === 'raise' || t === 'allin';

/** Hero's next action on `street` strictly after `order`, or undefined. */
function nextHeroAction(acts: MinimalAction[], hero: number, order: number): MinimalAction | undefined {
  let best: MinimalAction | undefined;
  for (const a of acts) {
    if (a.seat === hero && a.order > order && (!best || a.order < best.order)) best = a;
  }
  return best;
}

/** Accumulate pressure metrics for `hero` from one hand's actions. */
export function accumulatePressure(st: PressureStats, actions: MinimalAction[], hero: number): void {
  const byStreet = (s: Street) => actions.filter(a => a.street === s).sort((a, b) => a.order - b.order);
  const flop = byStreet('flop'), turn = byStreet('turn'), river = byStreet('river');

  // --- fold-to-raise (once per street) ---
  for (const acts of [flop, turn, river]) {
    for (const mine of acts.filter(a => a.seat === hero && isWager(a.type))) {
      const raiseOver = acts.find(a => a.seat !== hero && a.order > mine.order && isWager(a.type));
      if (!raiseOver) continue;
      const resp = nextHeroAction(acts, hero, raiseOver.order);
      if (!resp) continue;
      st.foldToRaiseOpp++;
      if (resp.type === 'fold') st.foldToRaise++;
      break;
    }
  }

  // --- facing the first wager of a street from an opponent ---
  const firstWager = (acts: MinimalAction[]) => acts.find(a => isWager(a.type));

  const fw = firstWager(flop);
  if (fw && fw.seat !== hero) {
    const resp = nextHeroAction(flop, hero, fw.order);
    if (resp) { st.foldToFlopBetOpp++; if (resp.type === 'fold') st.foldToFlopBet++; }
  }

  // Turn barrel faced: V wagered the flop, hero continued without wagering.
  const flopWagerers = new Set(flop.filter(a => isWager(a.type)).map(a => a.seat));
  const heroFlopWagered = flopWagerers.has(hero);
  const heroFlopCalled = flop.some(a => a.seat === hero && a.type === 'call');
  const tw = firstWager(turn);
  if (tw && tw.seat !== hero && flopWagerers.has(tw.seat) && !heroFlopWagered && heroFlopCalled) {
    const resp = nextHeroAction(turn, hero, tw.order);
    if (resp) { st.foldToTurnBarrelOpp++; if (resp.type === 'fold') st.foldToTurnBarrel++; }
  }

  const rw = firstWager(river);
  if (rw && rw.seat !== hero) {
    const resp = nextHeroAction(river, hero, rw.order);
    if (resp) { st.foldToRiverBetOpp++; if (resp.type === 'fold') st.foldToRiverBet++; }
  }

  // --- hero barrels: hero made the last wager of the previous street (called),
  // and gets to act on the next street before anyone wagers. ---
  const barrel = (prev: MinimalAction[], cur: MinimalAction[]): [boolean, boolean] => {
    const wagers = prev.filter(a => isWager(a.type));
    if (wagers.length === 0 || wagers[wagers.length - 1].seat !== hero) return [false, false];
    const heroFirst = cur.find(a => a.seat === hero);
    if (!heroFirst) return [false, false];
    const wagerBefore = cur.some(a => a.order < heroFirst.order && isWager(a.type));
    if (wagerBefore) return [false, false];
    return [true, isWager(heroFirst.type)];
  };
  const [tOpp, tBet] = barrel(flop, turn);
  if (tOpp) { st.turnBarrelOpp++; if (tBet) st.turnBarrel++; }
  const [rOpp, rBet] = barrel(turn, river);
  if (rOpp) { st.riverBarrelOpp++; if (rBet) st.riverBarrel++; }
}

export function pct(n: number, d: number): number { return d > 0 ? 100 * n / d : NaN; }
export function fmtPct(n: number): string { return Number.isFinite(n) ? n.toFixed(1) + '%' : 'n/a'; }

/** One-line labeled metric map (value plus raw count) for reports. */
export function pressureLines(st: PressureStats): Record<string, string> {
  const f = (n: number, d: number) => `${fmtPct(pct(n, d))} (${n}/${d})`;
  return {
    'fold-to-raise (postflop)': f(st.foldToRaise, st.foldToRaiseOpp),
    'fold-to-flop-bet': f(st.foldToFlopBet, st.foldToFlopBetOpp),
    'fold-to-turn-barrel': f(st.foldToTurnBarrel, st.foldToTurnBarrelOpp),
    'fold-to-river-bet': f(st.foldToRiverBet, st.foldToRiverBetOpp),
    'turn barrel': f(st.turnBarrel, st.turnBarrelOpp),
    'river barrel': f(st.riverBarrel, st.riverBarrelOpp),
  };
}

/**
 * Difference of two frequencies (A - B, in percentage points) with a 95% CI from
 * the normal approximation to two independent proportions:
 *   se = sqrt(pA(1-pA)/nA + pB(1-pB)/nB).
 * Opportunities from the same hand are not strictly independent, so treat the
 * interval as approximate. NaN when either side has no opportunities.
 */
export function freqDiffCI(nA: number, dA: number, nB: number, dB: number): { diffPP: number; ci95PP: number } {
  if (dA === 0 || dB === 0) return { diffPP: NaN, ci95PP: NaN };
  const pA = nA / dA, pB = nB / dB;
  const se = Math.sqrt(pA * (1 - pA) / dA + pB * (1 - pB) / dB);
  return { diffPP: 100 * (pA - pB), ci95PP: 100 * 1.96 * se };
}

/** Per-metric A-B difference lines, keyed like pressureLines. */
export function pressureDiffLines(a: PressureStats, b: PressureStats): Record<string, string> {
  const f = (na: number, da: number, nb: number, db: number) => {
    const d = freqDiffCI(na, da, nb, db);
    return Number.isFinite(d.diffPP) ? `${d.diffPP >= 0 ? '+' : ''}${d.diffPP.toFixed(1)}pp ±${d.ci95PP.toFixed(1)}` : 'n/a';
  };
  return {
    'fold-to-raise (postflop)': f(a.foldToRaise, a.foldToRaiseOpp, b.foldToRaise, b.foldToRaiseOpp),
    'fold-to-flop-bet': f(a.foldToFlopBet, a.foldToFlopBetOpp, b.foldToFlopBet, b.foldToFlopBetOpp),
    'fold-to-turn-barrel': f(a.foldToTurnBarrel, a.foldToTurnBarrelOpp, b.foldToTurnBarrel, b.foldToTurnBarrelOpp),
    'fold-to-river-bet': f(a.foldToRiverBet, a.foldToRiverBetOpp, b.foldToRiverBet, b.foldToRiverBetOpp),
    'turn barrel': f(a.turnBarrel, a.turnBarrelOpp, b.turnBarrel, b.turnBarrelOpp),
    'river barrel': f(a.riverBarrel, a.riverBarrelOpp, b.riverBarrel, b.riverBarrelOpp),
  };
}

// ------------------------------------------------------------------
// Win-rate summary with a confidence interval.
// ------------------------------------------------------------------

/** Running mean / variance of a per-sample quantity (Welford). */
export class Running {
  n = 0; mean = 0; m2 = 0;
  push(x: number): void {
    this.n++;
    const d = x - this.mean;
    this.mean += d / this.n;
    this.m2 += d * (x - this.mean);
  }
  /** Sample variance (n-1). */
  variance(): number { return this.n > 1 ? this.m2 / (this.n - 1) : NaN; }
  /** Standard error of the mean. */
  se(): number { return this.n > 1 ? Math.sqrt(this.variance() / this.n) : NaN; }
}

/**
 * bb/100 and its 95% CI half-width from per-sample bb results. Each sample
 * covers `handsPerSample` hands (2 for a duplicate pair). The mean per hand is
 * mean/handsPerSample, so bb/100 = 100 * mean / handsPerSample and the SE scales
 * the same way. 1.96 is the normal quantile for a two-sided 95% interval (the
 * sample counts here are in the thousands, so the t correction is negligible).
 */
export function bb100WithCI(r: Running, handsPerSample: number): { bb100: number; ci95: number } {
  return {
    bb100: 100 * r.mean / handsPerSample,
    ci95: 1.96 * 100 * r.se() / handsPerSample,
  };
}
