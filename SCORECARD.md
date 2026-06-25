# Strength scorecard

A running, honest rating of how good this bot actually is, so you can watch it
improve release over release. Scale:

- **0** — unusable; doesn't work, nothing happens.
- **100** — Phil Ivey, heads-up. World-class.

> The bb/100 figures come from `npm run sim` — the real bot vs *scripted,
> deliberately-exploitable* opponents. A big number vs them is expected and is
> **not** proof it beats real humans. They track relative progress and leaks, not
> absolute skill. The rating is a judgment call, explained below.

## Current rating: **59 / 100**

A legitimately solid study bot: it works end-to-end on PokerNow, plays
near-equilibrium preflop, avoids the big postflop blunders, and clearly beats
weak-to-mediocre opposition. It is **not** GTO postflop — a strong reg or a
solver would out-play it on later streets — which is what keeps it out of the
70s+.

### Component breakdown

| Area | Score | Why |
|---|---:|---|
| Preflop | 85 | Real heads-up CFR-solved charts; push/fold is **exact** Nash. Measured open/defend frequencies match the solved targets (~81% / ~74%). |
| Postflop | 47 | Distilled net **widened to 37→512→256→5** (~150k params), retrained on the 500k solver decisions → **83.34%** held-out accuracy (was 82.96%). Still **not** a street-by-street solver and the 37-feature input is now the bottleneck (not net size); heuristic sizing remains. The main thing holding the score down. |
| Live execution | 70 | Functional MV3 extension: scrapes the table, acts, never-freeze fallback. Fragile to PokerNow DOM changes; that's the cap. |
| Exploitation | 55 | Tracks opponents and now adapts in the right direction with a real read (net-positive in sim). Still shallow vs a thinking player. |
| Correctness/tests | 80 | 416 tests, hand evaluator enumerated over all 2.6M five-card hands, CFR validated to the analytic Kuhn value, train/serve parity on the net, a chip-conserving HU simulator. |

### What would move the number
- **60s:** real multi-street postflop solving (or a stronger net) so it stops leaking on turn/river.
- **70s:** opponent-tuned sizing + a deeper, validated exploit model; remove the baseline station/maniac leaks.
- **80s+:** approaches solver-level postflop play and robust live reads. (90s+ is pro territory and not realistic for a heuristic+distilled-net bot.)

## History

| Version | Date | Tests | Rating | Postflop net (test acc) | Notable |
|---|---|---:|---:|---|---|
| v0.1.23 | 2026-06-25 | 416 | **59** | 512×256, **83.34%** | Widened the postflop net (256/128 → 512/256, ~43k → ~150k params) and retrained on the 500k solver decisions: held-out accuracy 82.96% → **83.34%**, log-loss 0.40 → 0.39. TS↔numpy parity 7.6e-6. |
| v0.1.22 | 2026-06-25 | 416 | **58** | 256×128, 82.96% | Range-gated the −EV sanity overrides; exploit only fires on a real read (≥50 hands); fixed the never-bluff-a-station bug. Exploitation flipped net-negative → **net-positive**. |
| v0.1.21 | 2026-06-25 | ~408 | ~54 | 256×128, 82.96% | Baseline before the decision-quality fixes: sanity overrode on equity-vs-random; exploit adjuster lost money at scale; stations got barreled (bluff-reduction bug). |

> To refresh the row: `npm test` for the count, `npm run sim -- 10000 42` for the
> bb/100, then add a line above with the new version, numbers, and rating.
