# Changelog

All notable changes. Versions match the on-table overlay badge and GitHub releases.

## v0.2.3 (2026-10-12)
- The overlay and the extension manifest now show the real version: both come from package.json at build time (the overlay was hard-coded to v0.1.52 through every v0.2.x release).
- Docs refreshed: README, ROADMAP, CONTRIBUTING.

## v0.2.2 (2026-10-09)
- 6-max preflop: a pot that folds down to two players keeps the 6-max charts; short-stack all-ins are detected even when logged as a raise and are called on chip EV against the jammer's range with overcallers modelled; the button no longer uses the heads-up shove table with both blinds to act.
- Simulator: per-seat starting stacks (`--stacks`) so short-stack spots get tested.

## v0.2.1 (2026-10-09)
- The trained heads-up blueprint plays inside the extension (`BLUEPRINT`, on): compact assets, in-browser bucketing that matches the C++ trainer, about 0.14 ms per decision. Against the v0.1.52 engine: +26.7 and +25.8 bb/100 on two pre-registered seeds.
- `blueprint+search` agent for the simulator and play app: real-time river search on top of the blueprint.

## v0.2.0 (2026-10-09)
- Real-time subgame solver on by default for heads-up turns and rivers; its combo cap no longer drops the bluff part of a narrowed range.
- Folded players no longer count as live, so heads-up pots at a 6-max table use the heads-up postflop path.
- Exploit mode keeps the sampled action instead of the argmax, and the 10% bluff raise is sampled instead of always firing.
- Postflop net inputs now match the training encoding.
- New modules behind flags, off until measured: preflop-conditioned range tracking, multiway equity, minimum-defense logic.
- C++ blueprint pipeline: MCCFR trainer, `bp serve`, real-time search, LBR, AIVAT, abstraction tools, cloud scripts. Duplicate match harness for 2 to 6 seats and a local play app.

## v0.1.19 to v0.1.52
- See the [GitHub releases](https://github.com/hellomate2/gto-poker-overlay/releases) for these versions.

## v0.1.18
- Widened heads-up preflop to real GTO width: button opens ~81% (was ~66%), BB defends ~74%. J9o/53s/suited connectors now open; premiums still 3-bet/4-bet to a size (no jams); raise-or-fold deep.

## v0.1.17
- Fixed the bot freezing after one hand: the no-double-act spot signature now includes the hand number, so preflop spots no longer collide across hands.

## v0.1.16
- Real solved heads-up preflop: CFR equilibrium charts for every scenario; deep all-in restricted so premiums 3-bet/4-bet to a size instead of jamming; push/fold stays exact short.

## v0.1.15
- Robust betting-situation reads: infer preflop scenario from bet size (no more opening/3-betting trash like K6o); detect facing-a-bet via the missing Check button; equity-gate the preflop fallback.

## v0.1.14
- Bets round to natural increments (165, not 166), scaled to the stake.

## v0.1.13
- Fixed heads-up position (the button/SB is in position postflop; was backwards). Labeled the overlay as an approximation, not perfect GTO.

## v0.1.12
- Handle facing a bet correctly: never "bet" into a bet; raise to at least the legal minimum.

## v0.1.11
- Stake-aware sizing end to end, including decimal stakes ($0.25/$0.50); never round bet amounts to whole chips on decimal games.

## v0.1.10
- Bulletproof blind reading from the blind element (fixes false short-stack all-in jams).

## v0.1.6 – v0.1.9
- Postflop judged by equity vs villain's range (stops value-betting losing hands); bet/raise capped to stack; pot read fixed; one consolidated overlay panel; build-version badge; never open-shove deep.

## v0.1.1 – v0.1.5
- Auto-play that mixes GTO frequencies; depth-limited postflop CFR (later replaced by the distilled net); hardened clicking; preflop driven by solved ranges.

## v0.1.0
- Initial public toolkit: perfect-hash evaluator, CFR study core (Kuhn/Leduc), preflop charts, HUD overlay.
