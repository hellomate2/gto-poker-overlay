# Roadmap

This is where the project is headed. It is honest about what is solid today and
what is still rough. Items are roughly ordered by priority, not by difficulty.

## Postflop c-bet aggression

The live postflop path leans on a range-aware heuristic and a distilled policy
net, with hard guards against the obvious blunders. The continuation-bet logic is
the weakest spot: sizing and frequency are reasonable but not tuned against a
real opponent model across all board textures. The plan is to calibrate c-bet
frequency and sizing per texture and per position, and to mix small and large
sizings the way a solver does instead of picking a single size.

## CFR+ convergence validation

The heads-up preflop solver reports exploitability, but the convergence story
deserves more rigor. The realization-factor leaves make the abstraction slightly
non-zero-sum, which makes NashConv drift once you push past the convergence
point. We want a cleaner convergence metric, a documented stopping rule, and
regression tests that catch a chart that has quietly gotten worse.

## More sites via a pluggable scraper

Today the scraper is specific to pokernow.club, and its DOM selectors are the
most fragile part of the codebase. The goal is to pull the site-specific reading
behind a small interface so a new site is a new adapter rather than a rewrite of
the engine. That also makes the brittle selectors easier to test and update in
one place.

## Range heatmap in the overlay

The HUD shows the recommended action and the mixed strategy, but not the full
range. A 13x13 heatmap of the solved range for the current spot, shaded by action
frequency, would make the overlay far more useful for study. It reads from data
the engine already has.

## Hand-history review mode

Right now the tool only reacts to the live table. A review mode would let you
load a finished hand and walk it street by street, comparing what you did to what
the solver and the net recommend, with the equity and range context for each
decision. This turns the project from a live aid into a study tool.

## Continuous integration

The test suite is deterministic and ready for CI, and there is a workflow under
`.github/`. The next step is to make CI the source of truth: run lint, the full
test suite, and the production build on every push, and gate merges on green. A
follow-up is to verify the committed artifacts can still be regenerated, so the
pipeline does not silently rot.
