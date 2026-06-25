# Bot simulation harness

A heads-up No-Limit Hold'em game engine that drives the **real** shipped bot
(`DecisionEngine.decide()`) against scripted opponent archetypes, so we can
measure the bot's actual win-rate (bb/100) and action frequencies and find
strategic leaks — instead of guessing.

## Run it

```bash
npm run sim:selftest          # validate the game engine (chip conservation, blinds, symmetry)
npm run sim                   # default: 100,000 hands per profile, seed 42
npm run sim -- 10000 42       # 10,000 hands per profile, seed 42
```

The report focuses on four profiles: **station / nit / maniac / tag**. (Two extra
archetypes — `lag`, `fish` — still exist in `agents.ts` for ad-hoc use.)

A run prints per-profile frequencies + flagged leaks and writes **`sim/REPORT.md`**.

Each opponent is played twice:

- **GTO** — the bot with no opponent read (pure equilibrium).
- **EXPL** — the bot tracking the opponent across the session (its profiler +
  exploit adjuster engage). The reported **lift** is the bb/100 gained from
  adapting. Both modes see the *same* deck sequence (paired comparison) so the
  difference is the strategy, not card luck.

## What it measures

This is a **measurement tool**, not a tuning tool. It reports the bot's behavior
as-is and flags leaks; it does NOT modify the bot or claim the bot is "good".

- **bb/100** win-rate vs each profile, with a 95% confidence half-width from
  per-hand variance (so "+50 ± 30" is honest about noise).
- Action frequencies by spot: VPIP, PFR, SB-open, BB-defend, 3bet, fold-to-3bet,
  flop cbet, fold-to-cbet, river-bet (bluff proxy), WTSD, W$SD, postflop AF.
- **Flagged leaks** per profile: deviations from exploitatively-correct play
  (e.g. "vs station: still betting rivers X% — bluffs are -EV"; "vs nit: folds to
  cbet only Y% — calling down too light"; "vs maniac: over-folds to cbet").
  If the bot is net-losing vs a profile, that is flagged loudly.
- SB-open / BB-defend are compared to solved-chart targets (≈81% / ≈74%).

> Caveat: the opponents are deliberately exploitable scripted heuristics, not
> thinking players. A big positive bb/100 vs them is expected and is NOT evidence
> the bot beats real opposition. The signal is *where the frequencies deviate
> from the exploit-max line per profile*.

## Correctness

`sim/holdem.ts` asserts **chip conservation** on every hand (the sum of stacks
is invariant) and runs a self-test that checks the blind/fold accounting
(always-jam vs always-fold = +0.75 bb/hand exactly) and positional symmetry
(mirror match nets ~0 bb/100). A buggy engine would produce meaningless strategy
numbers, so these guards run before any conclusion is drawn.

## Files

- `holdem.ts` — the HU NLHE engine (betting rounds, all-in, showdown, invariants).
- `agents.ts` — the real-bot wrapper and the opponent archetypes.
- `run.ts` — the driver, stats aggregation, and report.
- `fake-idb.ts` — in-memory IndexedDB shim so the bot's opponent tracking (and
  thus its exploit adjuster) works in Node.
