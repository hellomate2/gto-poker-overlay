# Changelog

All notable changes. Versions match the on-table overlay badge and GitHub releases.

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
