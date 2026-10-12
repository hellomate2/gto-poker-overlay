# GTO Poker Overlay

An open-source No-Limit Hold'em engine and study toolkit. It has three parts:

1. **A Pluribus-style training pipeline in C++** (`blueprint/`): Monte Carlo CFR self-play that trains a heads-up "blueprint" strategy, real-time search on top of it, and evaluation tools (duplicate head-to-head, Local Best Response, AIVAT).
2. **A decision engine in TypeScript** (`src/core/`): solved preflop charts, the trained blueprint for heads-up pots, a real-time subgame solver, a distilled postflop net, and a hand evaluator with range-aware equity.
3. **A Chrome extension for [PokerNow](https://www.pokernow.club)** that reads the table and overlays the recommended play (action mix, equity, opponent stats), and can optionally play the seat it sits in.

It is a strong approximation, not a perfect solver. See [Honest status](#honest-status), and read the [Disclaimer](#disclaimer) before using it anywhere real.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Tests](https://img.shields.io/badge/tests-778%20passing-2ecc71)](#verification)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## Results

Heads-up duplicate matches (every deal played twice with seats swapped), 100 big blinds, 95% confidence intervals. "Original bot" is the engine as of v0.1.52. Raw outputs and commands are in [`docs/results/2026-10-09.md`](docs/results/2026-10-09.md).

| Matchup | Result |
|---|---|
| Trained blueprint vs original bot | **+21.5 +/- 11.6 bb/100** (8,000 deals, two seeds) |
| Extension engine with the blueprint vs original bot | +26.7 +/- 20.2 and +25.8 +/- 19.3 bb/100 (3,000 deals per seed) |
| Blueprint plus river search vs original bot | +22.0 +/- 13.6 bb/100 (6,000 deals) |
| Final blueprint vs its own 954M-iteration snapshot | +15.7 +/- 6.0 mbb/hand (4M deals) |
| Hand-tuned engine with range tracking vs original bot (pre-registered) | -8.55 +/- 5.56 bb/100 (22,000 deals), so range tracking is off |

## Install

### Download the built extension
1. Download `gto-poker-overlay.zip` from the [latest release](https://github.com/hellomate2/gto-poker-overlay/releases).
2. Unzip it (you get a folder with `manifest.json` inside).
3. Open `chrome://extensions` and turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the unzipped folder.
5. Open a table on `pokernow.club` or `pokernow.com`. The overlay appears on its own.

To update, remove the old extension and load the new folder (a plain reload keeps the old code).

### Build from source
```bash
git clone https://github.com/hellomate2/gto-poker-overlay.git
cd gto-poker-overlay
npm install
npm run build       # production build into dist/ (npm run dev for watch mode)
```
Then **Load unpacked** the `dist/` folder.

## Use it
- At a PokerNow table the overlay shows the action mix for your spot (for example `Raise 67% / Call 23% / Fold 10%`), your equity, and a per-opponent HUD (VPIP, PFR, 3-bet, AF) once it has a few hands on them.
- In a heads-up pot the reasoning line starts with `blueprint` when the trained strategy made the decision. If it does not, the blueprint assets did not load and the normal engine is playing.
- Auto-play is on by default (it decides and clicks, pausing about 2 seconds per action). Turn it off in the popup for advisory-only mode.
- Press **Alt+G** to toggle the overlay.

### Play against it locally (no poker site)
```bash
npm run play        # opens a heads-up table at http://localhost:8765
```
Pick the bot (engine, blueprint, or blueprint plus search), play hands, and the session panel shows your result with a confidence interval and an all-in-adjusted number. See [`sim/play/README.md`](sim/play/README.md).

## How it works

**Preflop.** Heads-up uses complete solved range charts (`src/core/ranges/preflop-charts.ts`), and short stacks use push/fold Nash. 6-max uses solved chart packs (Greenline, Pekarstas). Short-stack all-ins at 6-max are called on chip EV against the jammer's range with players behind modelled as overcallers (`src/core/ranges/gto-advisor.ts`).

**Heads-up postflop: the blueprint.** The blueprint is trained by external-sampling Monte Carlo CFR in C++: the bot plays itself billions of times and shifts toward the actions it regrets not taking. Training uses the Pluribus tricks (Linear CFR early, negative-regret pruning, integer regrets). The game is abstracted: 169 preflop hand classes, 200 buckets per postflop street (k-means on equity histograms), and a small set of bet sizes. Opponent bets that are not in the tree map to the nearest sizes by pseudo-harmonic translation (Ganzfried and Sandholm 2013). The shipped checkpoint ran 12.7 billion iterations at 100 big blinds. It runs in the browser from compact assets (`src/core/blueprint/`, about 7 MB) and matches the C++ policy on 41,000 sampled decisions.

**Real-time search.** `bp search` (`blueprint/src/search.cpp`) re-solves the current spot with range-vs-range DCFR, using both players' blueprint ranges along the actual line. On the flop it stops at a depth limit where each player chooses among four continuation strategies (blueprint, and fold-, call- and raise-biased versions), as in Pluribus. River solves take about 1.5 seconds; the turn is not fast enough yet, so the agent searches the river only. Search runs in the simulator and play app, not in the extension.

**Everything else.** Multiway pots and spots the blueprint cannot map use the TypeScript engine: a real-time subgame solver for heads-up turns and rivers (`src/core/solver/subgame.ts`), a postflop net distilled from [PokerBench](https://huggingface.co/datasets/RZ412/PokerBench) solver labels, and range-aware rules with anti-blunder checks. Equity comes from a perfect-hash 7-card evaluator (ported from [phevaluator](https://github.com/HenryRLee/PokerHandEvaluator), Apache-2.0).

## Engine flags
Engine features sit behind flags in `src/core/engine-flags.ts`, each default documented with the measurement behind it. In Node, `GPO_ENGINE_FLAGS` overrides them (for example `GPO_ENGINE_FLAGS=+BLUEPRINT` or `none`). The browser build always uses the compiled-in defaults.

| Flag | Default | What it does |
| --- | --- | --- |
| `BLUEPRINT` | on | heads-up decisions from the trained blueprint, run in the browser |
| `SUBGAME_SOLVER` | on | real-time range-vs-range solve on heads-up turns and rivers |
| `FIX_LIVE_VILLAINS` | on | counts only villains still in the hand |
| `RANGE_TRACKER` | off | villain ranges built from the preflop line and narrowed by each action (lost the pre-registered test) |
| `MULTIWAY_EQUITY` | off | equity against every live villain at once (over-folds multiway until retuned) |
| `DEFENSE` | off | minimum-defense fold/call/raise when facing a bet (beats exploit probes, loses heads-up) |

To ship a newer checkpoint: `blueprint/bin/bp export`, then `npx tsx blueprint/scripts/export-web.ts --policy <file.gpobp> --abs <cache>/abs-<id>.bin` rewrites `blueprint/web/`.

## Training and evaluation

Build the C++ tools with `make -C blueprint`; [`blueprint/README.md`](blueprint/README.md) documents every command. The main ones:

```bash
blueprint/bin/bp gate --game kuhn --iters 4000000   # correctness check: converges to the -1/18 game value
blueprint/bin/bp train ...                          # MCCFR blueprint training, checkpoint and resume
blueprint/bin/bp h2h --a A.bin --b B.bin ...        # duplicate head-to-head (add --aivat for variance reduction)
blueprint/bin/bp lbr --target A.bin ...             # Local Best Response, a full-game exploitability lower bound
blueprint/bin/bp search ...                         # real-time search on one spot
npx tsx sim/match.ts --a <dir> --b <dir> --mode hu  # duplicate match between two engines or agents
```

`blueprint/cloud/` holds scripts to run a larger training job on a rented machine (setup, bench, resumable training, fetch, cost estimate). The research behind the design and the build plan are in [`docs/research/`](docs/research/).

## Verification
The suite has 778 tests (`npm test`), plus about 2,400 C++ checks (`make -C blueprint test`). They include:
- the evaluator enumerated over all 2,598,960 five-card hands (category counts and 7,462 strength classes match exactly)
- CFR reaching the Kuhn game value of -1/18, and Leduc exploitability falling toward zero
- train/serve parity for the postflop net and for the in-browser blueprint
- preflop coverage of every hand in every heads-up scenario
- regression tests for each bug fixed in v0.2.x

Engine changes are judged with duplicate matches against real engines on at least two seeds. Scripted opponent results are used only as leak diagnostics, because those opponents reward counter-exploits. The rules are in [`sim/EVAL_PROTOCOL.md`](sim/EVAL_PROTOCOL.md).

## Honest status
- Local Best Response beats the pure blueprint by about 1.33 big blinds per hand. That is typical for a blueprint without search; search has not been measured against LBR yet.
- Search covers the river only, and the extension does not run search.
- The blueprint is heads-up only and assumes about 100 big blinds; other spots use the hand-tuned engine.
- The live engine replays the scraped action log, whose order has not been verified against every PokerNow layout. Replays that do not match the table fall back to the normal engine.
- No external benchmark (Slumbot, GTO Wizard) has been run yet.
- DOM selectors can break if PokerNow changes its markup.

## Project layout
```
blueprint/           C++ trainer, real-time search, LBR, AIVAT, cloud scripts, web export
  web/               compact blueprint assets shipped in the extension
src/
  core/
    blueprint/       in-browser blueprint, agent and action translation
    solver/          real-time subgame solver
    ranges/          preflop charts, push/fold, 6-max advisor, range tracker
    equity/          hand evaluator, range and multiway equity
    ml/              distilled postflop net
    exploit/         opponent tracker and adjuster
    engine.ts        the decision engine
    engine-flags.ts  feature flags and the evidence for each default
  content-script/    PokerNow scraper and action executor
  ui/                overlay and popup
  solver/            CFR on toy games, preflop solver
sim/                 duplicate match harness, 2 to 6 seat engine, local play app
docs/                research notes, build plan, results
tests/               778 tests
```

## Disclaimer
This is for studying game theory and for training against. Running a bot against
real opponents for money violates the terms of service of every poker site, can
get accounts banned, and may be illegal where you live. Use it on play money, in
study, or in games where everyone knows it's there.

## License
[MIT](LICENSE) © 2026 Dev Lakhani
