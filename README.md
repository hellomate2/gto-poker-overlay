# GTO Poker Overlay

An open-source poker game-theory toolkit for heads-up and 6-max No-Limit Hold'em. It has two halves:

1. A **solver/study core** (runs on its own, no extension needed): a real CFR engine that solves toy games (Kuhn/Leduc) to Nash and measures exploitability, deterministic heads-up preflop GTO range charts (plus exact short-stack push/fold Nash), a perfect-hash hand evaluator, a Monte-Carlo equity engine, and a neural-net postflop policy distilled from solver data.
2. A **Chrome extension** for [PokerNow](https://www.pokernow.club) that reads the table and overlays the recommended GTO play (preflop ranges, the action mix, your equity, live opponent stats), and can optionally auto-play the seat it's sitting in.

It's built as a study tool and a training opponent. It is a strong **approximation**, not a perfect solver — see [Honest status](#honest-status). Read the [Disclaimer](#disclaimer) before using it anywhere real.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Tests](https://img.shields.io/badge/tests-531%20passing-2ecc71)](#verification)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## Install

### Option A: download the built extension (fastest)
1. Download `gto-poker-overlay.zip` from the [latest release](https://github.com/hellomate2/gto-poker-overlay/releases).
2. Unzip it (you get a folder with `manifest.json` inside).
3. Open `chrome://extensions`, enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the unzipped folder.
5. Open a table on `pokernow.club` / `pokernow.com`. The overlay appears automatically. The panel footer shows the running version.

To update: download the new release zip, unzip to a fresh folder, **Remove** the old extension, then **Load unpacked** the new folder (a plain reload keeps the old code).

### Option B: build from source
```bash
git clone https://github.com/hellomate2/gto-poker-overlay.git
cd gto-poker-overlay
npm install
npm run build       # production build -> dist/   (npm run dev for watch mode)
```
Then **Load unpacked** the `dist/` folder.

## Use it
- At a `pokernow` table, the overlay shows the GTO **action mix** for your hand and spot (e.g. `Raise 67% / Call 23% / Fold 10%`), whether your hand is in range, your **equity**, and a per-opponent HUD (VPIP / PFR / 3-bet / AF) once it has a few hands on them.
- It plays the **seat the browser is logged into**. To play *against* it: run it on one device (it plays that seat) and join the other seat from another device.
- **Auto-play** is on by default (it decides and clicks, pausing ~2s per action). Turn it off in the popup for advisory-only.
- Press **Alt+G** to toggle the overlay. A live **bb/100** win-rate is shown in the session strip.

## How it works
- **Preflop, heads-up:** explicit, complete GTO range charts (`src/core/ranges/preflop-charts.ts`) covering every scenario (open / vs-open / vs-3-bet / vs-4-bet), built from standard solved heads-up ranges. Short stacks use exact push/fold Nash. (A CFR preflop solve lives in `src/solver/preflop/` for study, but the live charts are the deterministic ones — they're complete and converged where the raw solve wasn't.)
- **Preflop, 6-max:** solved chart packs (Greenline / Pekarstas).
- **Postflop:** a small neural-net policy distilled from the [PokerBench](https://huggingface.co/datasets/RZ412/PokerBench) dataset (~500k solver-labeled decisions), running a pure-TypeScript forward pass in the extension. A range-aware heuristic is the fallback for multiway and edge cases, with hard anti-blunder guards (e.g. never value-bet into a flush you can't beat). Bet sizes are stake-aware and rounded to natural increments.
- **Equity:** a perfect-hash 7-card evaluator (ported from [phevaluator](https://github.com/HenryRLee/PokerHandEvaluator), Apache-2.0) feeding a Monte-Carlo equity calculator.
- **Exploits:** per-opponent tracking and bounded exploitative adjustments (postflop).

## Engine flags
Optional engine features sit behind flags in `src/core/engine-flags.ts`. The defaults live in `DEFAULT_ENGINE_FLAGS` there, each with the measurement behind it. In Node (sims, benches, tests) the variable `GPO_ENGINE_FLAGS` overrides them, for example `GPO_ENGINE_FLAGS=+BLUEPRINT` (turn one on, keep the rest) or `GPO_ENGINE_FLAGS=none`. The browser build has no environment, so the extension always runs the compiled-in defaults.

| Flag | Default | What it does |
| --- | --- | --- |
| `FIX_LIVE_VILLAINS` | on | counts only villains still in the hand |
| `RANGE_TRACKER` | off | villain ranges narrowed by each action |
| `MULTIWAY_EQUITY` | off | multiway equity against all live villains at once |
| `DEFENSE` | off | pot-odds and minimum-defense fold/call/raise when facing a bet |
| `SUBGAME_SOLVER` | on | real-time range-vs-range solve on heads-up turn and river |
| `BLUEPRINT` | off | heads-up decisions from the trained C++ blueprint, run in the browser |

### Turning on the blueprint bot (`BLUEPRINT`)
1. In `src/core/engine-flags.ts`, set `BLUEPRINT: true` in `DEFAULT_ENGINE_FLAGS`.
2. Run `npm run build` and load `dist/` unpacked. The build copies the blueprint assets from `blueprint/web/` to `dist/blueprint/` (7.35 MB of gzipped files; about 31 MB once loaded).
3. At a heads-up table the engine plays the blueprint's average strategy and the decision's reasoning starts with `blueprint`. Multiway tables, effective stacks outside 50 to 200 big blinds, missing assets and any betting line the abstract tree cannot follow go to the normal engine path instead.

What the shipped blueprint is: the overnight checkpoint (12,749,175,749 MCCFR iterations, small betting tree, 200 flop, turn and river buckets, trained at 100 big blinds). Flop and turn buckets come from the trainer's own tables and river buckets are computed per decision with the trainer's exact arithmetic. Checks, all from 2026-10-09 (raw output in `sim/results/2026-10-09/bp-web/`):

- Parity with the C++ trainer: on 1,000 infosets from `bp serve --parity-dump` (the committed fixture) and on a further 40,000, every node, bucket and action list matched exactly and the largest probability difference was 0.0029, inside the export's 1/255 rounding. `npx tsx sim/blueprint-parity.ts web --fixture tests/fixtures/blueprint-web-parity.jsonl`
- Speed in Node: assets load in about 40 ms (zlib); decisions take 0.01 ms at the median and 0.14 ms at the 95th percentile (river decisions 0.13 ms and 0.21 ms, since they compute hand strength against all 990 opposing hands). `GPO_ENGINE_FLAGS=+BLUEPRINT npx tsx sim/latency.ts 1000 1 --seats 2 --field tag`
- Against the original bot (`swarm/base`), heads-up duplicate, 3,000 deals per seed, seeds fixed in advance: +26.74 bb/100 (95% CI +/- 20.20) on seed 7 and +25.79 bb/100 (+/- 19.29) on seed 101, with 0 illegal actions in 24,786 decisions. `npx tsx sim/match.ts --a . --flags-a +BLUEPRINT --b <original checkout> --mode hu --deals 3000 --seed 7 --workers 4`

To ship a newer checkpoint, export it with `blueprint/bin/bp export` and then run `npx tsx blueprint/scripts/export-web.ts --policy <file.gpobp> --abs <cache>/abs-<id>.bin`, which rewrites `blueprint/web/`.

## Verification
Correctness is checked by a test suite (531 tests, all passing), including:
- The hand evaluator enumerated over **all 2,598,960 five-card hands**, asserting the category counts match the textbook distribution exactly and that there are 7,462 distinct hand-strength classes.
- The CFR engine reaching the known Kuhn-poker game value of **-1/18** and driving exploitability toward zero.
- The distilled postflop net reproducing its **~84% held-out agreement** with the solver (above the published 8B-LLM benchmark).
- Preflop coverage: every hand × every heads-up scenario returns a defined, in-range action (no gaps).

```bash
npm test                # full suite (531 tests)
npm run solve:equity    # rebuild the 169×169 preflop all-in equity matrix
npm run ml:train        # retrain the distilled postflop policy net
npm run sim:selftest    # validate the simulation engine (chip conservation, blinds, symmetry)
npm run sim -- 10000 42 # play the real bot vs opponent archetypes, 10k hands each
```

### Simulation (empirical strategy check)
A heads-up NLHE harness (`sim/`) plays the **real** `DecisionEngine` against scripted
opponent archetypes and measures its actual win-rate and frequencies. Over 10,000
hands per opponent (100bb deep), the bot beats every archetype it was tested against
(nit / TAG / LAG / calling-station / maniac), and its measured preflop frequencies
match the charts — a wide button-opening range and wide BB defense — confirming the
ranges are realized in actual play, not just in the chart tables. The
engine self-test asserts chip conservation every hand and positional symmetry, so the
numbers are trustworthy.

## Honest status
- **Push/fold (short stacks) is exact** Nash — unexploitable.
- **Deep heads-up preflop** uses explicit standard GTO range charts — a **strong approximation** of full postflop-aware GTO, not a street-by-street solve. It won't be bit-for-bit identical to a commercial solver.
- **Postflop** is the distilled net (~84% solver-agreement) plus a sound lead/c-bet policy, texture-aware bet sizing, and a soundness gate that vetoes punts — strong, not perfect.
- Tested mainly on play-money PokerNow tables; DOM selectors can break if PokerNow changes their markup.

## Project layout
```
src/
  solver/            CFR engine; Kuhn/Leduc; preflop/ = heads-up preflop solver
  core/
    equity/          perfect-hash 7-card evaluator + Monte-Carlo equity
    ranges/          heads-up GTO charts, push/fold Nash, 6-max packs + advisor
    ml/              distilled postflop policy net (features, model, inference)
    exploit/         opponent tracker, profiler, exploit adjuster
    engine.ts        decision engine (preflop ranges + postflop net + sizing)
  content-script/    PokerNow scraper + action executor
  ui/                overlay HUD + popup
  trainer/           standalone GTO trainer
sim/                 heads-up NLHE bot-vs-archetype simulation harness
tests/               531 tests
```

## Disclaimer
This is for studying game theory and for training against. Running a bot against
real opponents for money violates the terms of service of every poker site, can
get accounts banned, and may be illegal where you live. Use it on play money, in
study, or in games where everyone knows it's there.

## License
[MIT](LICENSE) © 2026 Dev Lakhani
