# Bot simulation harness

A heads-up No-Limit Hold'em game engine that drives the **real** shipped bot
(`DecisionEngine.decide()`) against scripted opponent archetypes, so we can
measure the bot's actual win-rate (bb/100) and action frequencies and find
strategic leaks — instead of guessing.

## Run it

```bash
npm run sim:selftest          # validate the game engine (chip conservation, blinds, symmetry)
npm run sim                   # default: 2000 hands per opponent
npm run sim -- 10000 42       # 10,000 hands per opponent, seed 42
```

Each opponent is played twice:

- **GTO** — the bot with no opponent read (pure equilibrium).
- **EXPL** — the bot tracking the opponent across the session (its profiler +
  exploit adjuster engage). The reported **lift** is the bb/100 gained from
  adapting. Both modes see the *same* deck sequence (paired comparison) so the
  difference is the strategy, not card luck.

## What it measures

- **bb/100** win-rate vs each archetype (nit / TAG / LAG / fish / maniac).
- **SB open %** and **BB defend %** — compared to the solved-chart targets
  (SB-RFI ≈ 81%, BB-vs-open ≈ 74%).
- Postflop aggression factor and WTSD.

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
