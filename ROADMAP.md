# Roadmap

Ordered by priority. Each item is done when its measurement says so, on at least two seeds or with a pre-registered sample size (see `sim/EVAL_PROTOCOL.md`). The full plan is in `docs/research/PLAN.md`.

## Measure search against Local Best Response
LBR beats the pure blueprint by about 1.33 big blinds per hand. Search is the expected fix, but it has only been measured head-to-head. Run LBR against the blueprint-plus-search agent on the same settings.

## Faster turn search
River solves take about 1.5 seconds; turn solves do not fit a 2.5 second budget. Options: float storage, suit isomorphism over the 48 river cards, and smaller combo caps. Then measure turn-plus-river search head-to-head.

## A larger blueprint
The first cloud run (medium tree, 64 cores) stopped early because of a run-length setting, and its checkpoint does not load locally yet. Fix both, then train the larger abstraction in `PLAN.md` and compare it to the overnight blueprint with LBR.

## External benchmarks
Slumbot and the GTO Wizard benchmark, with sample sizes set in advance and AIVAT where the protocol allows it.

## Search in the extension
The extension runs the blueprint without search. River search in the browser (or a local helper process) would bring the extension in line with the strongest agent.

## Retune or retire the hand-tuned modules
Range tracking lost the pre-registered heads-up test, multiway equity over-folds, and the defense module loses heads-up. Each stays off until a retuned version passes on two seeds.

## Verify the live action-log order
The engine replays PokerNow's action log. Confirm its order against real logs on every layout, with a regression fixture.

## Six-max blueprint
Extend the trainer to 3 to 6 players following the Pluribus recipe, starting with 3-handed.
