# GTO Poker Overlay

An open-source poker game-theory toolkit. It has two halves:

1. A **study core**: a CFR solver (vanilla, CFR+, Linear, Discounted) that solves toy poker games to Nash equilibrium and measures its own exploitability, a perfect-hash hand evaluator, a Monte-Carlo equity engine, and GTO preflop ranges (6-max, heads-up, and short-stack push/fold Nash).
2. A **Chrome extension** for [PokerNow](https://www.pokernow.club) that reads the table and shows GTO preflop advice, live opponent stats, and your equity as an overlay while you play.

It is meant as a way to study game theory and as a training aid, not as a cheating tool. See [Honest status](#honest-status) and [Disclaimer](#disclaimer).

## Install

### Option A: download the built extension (fastest)

1. Go to the [Releases page](https://github.com/hellomate2/gto-poker-overlay/releases) and download `gto-poker-overlay.zip` from the latest release.
2. Unzip it. You'll get a folder with `manifest.json` inside.
3. Open Chrome and go to `chrome://extensions`.
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the unzipped folder.
6. Open a table on `pokernow.club`. The overlay appears automatically.

### Option B: build from source

```bash
git clone https://github.com/hellomate2/gto-poker-overlay.git
cd gto-poker-overlay
npm install
npm run build      # outputs the extension into dist/
```

Then load the `dist/` folder with **Load unpacked** as in steps 3 to 6 above. Use `npm run dev` for a watch build while developing.

## Use it

- Sit at any `pokernow.club` table. Preflop, the overlay shows the GTO action mix for your hand and spot (for example `3-Bet 67% / Call 23% / Fold 10%`), whether your hand is in range, and the scenario (such as `BTN vs SB 3-Bet`). Heads-up and short-stack spots use the right ranges automatically: at 20 big blinds or fewer it switches to unexploitable jam-or-fold Nash.
- A small HUD over each opponent tracks VPIP, PFR, 3-bet, and aggression once it has a few hands on them, and labels their type (nit, TAG, LAG, calling station, maniac).
- Press **Alt+G** to toggle the whole overlay.
- It is **advisory by default**: it shows recommendations and never acts for you. Auto-play exists but is off unless you turn it on in the popup.

## Study core

The solver and tooling are usable on their own, without the extension:

```bash
npm test            # 114 tests, including correctness proofs (below)
npm run solve:bench # CFR convergence on Kuhn and Leduc (exploitability vs iterations)
npm run eval:bench  # hand-evaluator throughput
```

Two results worth calling out, because they are verifiable rather than claimed:

- The hand evaluator is checked by enumerating **all 2,598,960 five-card hands** and asserting the category counts match the textbook distribution exactly (1,302,540 high card, 1,098,240 pairs, ... 40 straight flushes), and that there are exactly 7,462 distinct hand-strength classes.
- The CFR solver reaches the known Kuhn-poker game value of **-1/18** and drives exploitability toward zero on both Kuhn and Leduc.

## Honest status

I'd rather be straight about what this is than oversell it:

- **Preflop** uses solved range charts (6-max from public chart packs, plus heads-up and push/fold Nash). This is the strongest part.
- **Postflop in the live overlay is heuristic** (board texture, SPR, geometric sizing), not a full solve. A real heads-up postflop solver is wired in via an adapter to [b-inary/postflop-solver](https://github.com/b-inary/postflop-solver) (AGPL, so you build the WASM yourself, see [docs/HEADS_UP_SOLVER.md](docs/HEADS_UP_SOLVER.md)); it is not bundled.
- **CFR+ and DCFR converge correctly on Kuhn but not yet faster than vanilla on Leduc.** That is a known bug I'm fixing against reference implementations; it's marked with a TODO in the code and the tests assert only what's currently true.
- Tested on play-money PokerNow tables. DOM selectors can break if PokerNow changes their markup.

## Tech

TypeScript (strict), Chrome Manifest V3, Webpack 5, Vitest. The hand evaluator is a TypeScript port of the [phevaluator](https://github.com/HenryRLee/PokerHandEvaluator) perfect-hash algorithm (Apache-2.0).

## Project layout

```
src/
  solver/            CFR / CFR+ / Linear / DCFR + MCCFR, Kuhn & Leduc, exploitability
  core/
    equity/          perfect-hash 7-card evaluator + Monte-Carlo equity
    ranges/          preflop charts: 6-max, heads-up, push/fold Nash + advisor
    exploit/         opponent tracker, profiler, exploit adjuster
    solver/          heads-up postflop solver adapter (postflop-solver WASM)
  content-script/    PokerNow DOM scraper + advisory/auto executor
  ui/                overlay HUD + popup settings
  trainer/           standalone GTO trainer
tests/               114 tests (evaluator distribution proof, CFR convergence, ranges, ...)
```

## Disclaimer

This is for studying game theory and for training against. Running a bot against
real opponents for money violates the terms of service of every poker site, can
get accounts banned, and may be illegal where you live. Use it on play money, in
study, or in games where everyone knows it's there.

## License

[MIT](LICENSE) (c) 2026 Dev Lakhani
