// ============================================================
// Engine feature flags.
//
// Every engine improvement from the swarm workstreams is wired into
// src/core/engine.ts behind one of these flags, so each can be measured and
// toggled on its own. With every flag off the engine plays exactly like
// swarm/base (sim/match.ts against the base checkout scores +0.00 +/- 0.00).
//
//   FIX_LIVE_VILLAINS  Count only villains still in the hand (folded and
//                      sitting-out seats excluded) wherever the engine counts
//                      opponents, so a heads-up pot at a 6-max table goes to the
//                      heads-up net. Also: postflop position at a full table is
//                      "hero acts last among the live players" instead of the
//                      dealer flag, and effective stacks ignore folded seats.
//   RANGE_TRACKER      Villain ranges come from src/core/ranges/range-tracker.ts
//                      (preflop line + narrowing by each postflop action) instead
//                      of the static villainContinuingRange model.
//   MULTIWAY_EQUITY    With 2+ live villains, equity is hero's pot share against
//                      all of them at once (equity/multiway-equity.ts); the
//                      heads-up-tuned value thresholds compare against
//                      equity^(1/N) and pot-odds checks use the raw share.
//   DEFENSE            Facing a bet or raise postflop, fold/call/raise comes from
//                      src/core/defense.ts (pot odds + minimum defense frequency
//                      over hero's range, villain range with bluffs). The
//                      soundness gate no longer re-checks those calls against the
//                      bluff-free range, and the always-raise bluff branch is gone.
//   SUBGAME_SOLVER     Heads-up turn/river spots are solved in real time with the
//                      range-vs-range DCFR subgame solver (solver/subgame.ts) on
//                      tracker ranges; any ineligible spot, error or unconverged
//                      solve falls back to the normal path.
//
// Defaults are set from the sim/match.ts measurements recorded in
// sim/INTEGRATION.md (see the comment on DEFAULT_ENGINE_FLAGS). In Node the environment variable GPO_ENGINE_FLAGS
// overrides them (see applyFlagSpec); the browser build has no `process`, so the
// defaults apply there.
// ============================================================

export type EngineFlagName =
  | 'FIX_LIVE_VILLAINS'
  | 'RANGE_TRACKER'
  | 'MULTIWAY_EQUITY'
  | 'DEFENSE'
  | 'SUBGAME_SOLVER';

export type EngineFlags = Record<EngineFlagName, boolean>;

export const ENGINE_FLAG_NAMES: readonly EngineFlagName[] = [
  'FIX_LIVE_VILLAINS',
  'RANGE_TRACKER',
  'MULTIWAY_EQUITY',
  'DEFENSE',
  'SUBGAME_SOLVER',
];

// Defaults for main (2026-10-09, updated 05:15 PDT). Evidence in sim/INTEGRATION.md
// ("What the evidence supports") with raw outputs in sim/results/2026-10-09/; rules
// for new measurements in sim/EVAL_PROTOCOL.md. All CIs are 95%. Field-mode A-B < 0
// and hu "A vs B" < 0 mean the candidate beat swarm/base.
// No flag set here has a significant heads-up gain over swarm/base yet. The old default
// package FIX+RT+SG scored -6.35 +/- 13.46 (seed 1) and -5.83 +/- 14.13 (seed 101)
// bb/100 for base heads-up, and with only FIX_LIVE_VILLAINS on the engine plays
// heads-up exactly like base. The decisive heads-up test is pre-registered in
// sim/INTEGRATION.md: 22,000 deals at seed 7, a gain counts only if its CI excludes 0.
//   FIX_LIVE_VILLAINS ON: a correctness fix (folded players no longer count as live).
//     No heads-up effect (+0.00 +/- 0.00 with MULTIWAY_EQUITY, 500 deals); neutral
//     in the 6-max field (-3.43 +/- 6.49 bb/100, seed 2, 9000 deals).
//   RANGE_TRACKER OFF: heads-up vs base +1.40 +/- 10.46 (no difference). It beat base
//     against all four scripted probes on seed 1, and the two probes rerun on seed
//     101 replicated (raiser -66.60 +/- 50.22, tag -47.26 +/- 34.63). Its 6-max
//     field gain did not replicate (seed 1 -159.11 +/- 137.99, seed 101
//     -30.97 +/- 156.20). It also reads the scraped action log, and review found
//     that scraper.ts parseGameLog may walk the log newest-first; it stays off until
//     the live log order is verified.
//   SUBGAME_SOLVER ON (turned on 2026-10-09 09:45 PDT at Dev's request, "turn on
//     search"): the per-side combo cap that dropped the bluff part of narrowed
//     ranges is fixed (673724d). FIX+SG vs FIX: heads-up neutral (seed 1
//     -7.58 +/- 15.27, seed 202 +5.77 +/- 12.83) and beats the barreler probe on both
//     seeds (-49.21 +/- 43.19, -101.34 +/- 43.13). Overall decision p95 stayed under
//     0.6 s at load average 62. Two caveats remain: in live play its ranges come from
//     the scraped action log (scraper.ts parseGameLog order is unverified; the
//     engine-subgame guard skips the solve when the log does not explain the bet),
//     and solves can run to the 1500 ms budget under heavy load.
//   DEFENSE OFF: it beats base against three of four probes but loses heads-up:
//     +22.61 +/- 18.49 bb/100 for base on seed 1 and +16.59 +/- 18.45 on seed 101.
//   MULTIWAY_EQUITY OFF: over-folds multiway (+268.73 +/- 204.22 bb/100 for base).
export const DEFAULT_ENGINE_FLAGS: Readonly<EngineFlags> = Object.freeze({
  FIX_LIVE_VILLAINS: true,
  RANGE_TRACKER: false,
  MULTIWAY_EQUITY: false,
  DEFENSE: false,
  SUBGAME_SOLVER: true,
});
export const ENGINE_FLAGS: EngineFlags = { ...DEFAULT_ENGINE_FLAGS };

/** Override some flags (tests, sims). */
export function setEngineFlags(flags: Partial<EngineFlags>): void {
  for (const k of ENGINE_FLAG_NAMES) {
    if (flags[k] !== undefined) ENGINE_FLAGS[k] = !!flags[k];
  }
}

/** Restore the compiled-in defaults. */
export function resetEngineFlags(): void {
  Object.assign(ENGINE_FLAGS, DEFAULT_ENGINE_FLAGS);
}

/** Short label of the flags that are on, e.g. "DEFENSE+RANGE_TRACKER" or "none". */
export function describeEngineFlags(flags: EngineFlags = ENGINE_FLAGS): string {
  const on = ENGINE_FLAG_NAMES.filter(k => flags[k]);
  return on.length ? on.join('+') : 'none';
}

/**
 * Parse a flag spec and return the resulting flag set (starting from `base`).
 *   "none" | "off"          every flag off
 *   "all"  | "on"           every flag on
 *   "DEFENSE,RANGE_TRACKER" exactly these on, the rest off
 *   "+DEFENSE,-SUBGAME_SOLVER"  toggle relative to `base`
 * Unknown names throw, so a typo cannot silently run the wrong config.
 */
export function parseFlagSpec(spec: string, base: Readonly<EngineFlags> = DEFAULT_ENGINE_FLAGS): EngineFlags {
  const s = spec.trim();
  const out: EngineFlags = { ...base };
  if (s === '') return out;
  const lower = s.toLowerCase();
  if (lower === 'none' || lower === 'off') {
    for (const k of ENGINE_FLAG_NAMES) out[k] = false;
    return out;
  }
  if (lower === 'all' || lower === 'on') {
    for (const k of ENGINE_FLAG_NAMES) out[k] = true;
    return out;
  }
  const parts = s.split(/[\s,]+/).map(p => p.trim()).filter(Boolean);
  const relative = parts.every(p => p.startsWith('+') || p.startsWith('-'));
  if (!relative) for (const k of ENGINE_FLAG_NAMES) out[k] = false;
  for (const p of parts) {
    const sign = p.startsWith('-') ? false : true;
    const name = p.replace(/^[+-]/, '').toUpperCase() as EngineFlagName;
    if (!ENGINE_FLAG_NAMES.includes(name)) throw new Error(`unknown engine flag "${name}" in "${spec}"`);
    out[name] = sign;
  }
  return out;
}

/** Apply a flag spec to the live flags. */
export function applyFlagSpec(spec: string): void {
  setEngineFlags(parseFlagSpec(spec, ENGINE_FLAGS));
}

// Node-only override (sims, benches). The browser build has no `process`.
const envSpec = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  ?.GPO_ENGINE_FLAGS;
if (envSpec !== undefined) applyFlagSpec(envSpec);
