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
// sim/INTEGRATION.md. In Node the environment variable GPO_ENGINE_FLAGS
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

export const DEFAULT_ENGINE_FLAGS: Readonly<EngineFlags> = Object.freeze({
  FIX_LIVE_VILLAINS: false,
  RANGE_TRACKER: false,
  MULTIWAY_EQUITY: false,
  DEFENSE: false,
  SUBGAME_SOLVER: false,
});

/** The live flag object the engine reads on every decision. Mutate via setEngineFlags. */
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
