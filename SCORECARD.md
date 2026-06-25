# Strength scorecard

A running, honest rating of how good this bot actually is, so you can watch it
improve release over release. Scale:

- **0** — unusable; doesn't work, nothing happens.
- **100** — Phil Ivey, heads-up. World-class.

> The bb/100 figures come from `npm run sim` — the real bot vs *scripted,
> deliberately-exploitable* opponents. A big number vs them is expected and is
> **not** proof it beats real humans. They track relative progress and leaks, not
> absolute skill. The rating is a judgment call, explained below.

## Current rating: **63 / 100**

A legitimately solid study bot: it works end-to-end on PokerNow, plays
near-equilibrium preflop, avoids the big postflop blunders, and clearly beats
weak-to-mediocre opposition. It is **not** GTO postflop — a strong reg or a
solver would out-play it on later streets — which is what keeps it out of the
70s+.

### Component breakdown

| Area | Score | Why |
|---|---:|---|
| Preflop | 85 | Real heads-up CFR-solved charts; push/fold is **exact** Nash. Measured open/defend frequencies match the solved targets (~81% / ~74%). |
| Postflop | 54 | Wider net (512×256) + richer features **+ betting-action context** (is hero the preflop aggressor / c-bettor, is it a raised pot, bets-this-street) → **84.48%** action accuracy. **+ a learned bet-SIZE head** at **92.4%** (vs 39% baseline), replacing the flat texture heuristic that under-bet (0.33–0.66 vs the solver's ~0.66–0.9+). **Plus a hard pot-odds floor facing a bet**: the net (84% acc) used to punt — calling river all-ins with king-high / calling OOP with no equity — so it now folds whenever equity vs villain's continuing range is below the pot odds (overriding the net). Still **not** a street-by-street solver, which is what keeps it here, but it no longer punts and sizes like the solver. |
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
| v0.1.30 | 2026-06-25 | 449 | **63** | + deep all-in call/fold (preflop punt fix) | **Critical preflop fix**: facing a ~48bb all-in 3-bet the bot CALLED OFF its stack with T9s — it read the jam as a normal 3-bet and used the chart's "call". Now facing a jam at any depth is call-or-fold: short (≤25bb) uses the wide Nash range, deep (>25bb) a tight premium stack-off range (T9s/KJo/76s fold, only TT+/AQ+ continue). Also fixed `heroEffectiveStackBB` to count committed chips (a villain all-in shows stack 0, which had computed 0bb and skipped the jam logic). Robust jam detection (all-in tag OR bet ≥60% of stack). Regression tests in tests/deep-jam-call.test.ts. |
| v0.1.29 | 2026-06-25 | 445 | **63** | + betting-action features → 84.48% | **More poker understanding**: fed the net the betting line — is hero the preflop aggressor / c-bettor, is it a raised pot, bets-this-street (37→48→**51 features**). Action accuracy 84.19% → **84.48%**, computed identically in prep (from the action sequence) and the engine (from actionHistory), with a parity test. Caught + fixed a train/serve fixture gap (holdout was missing the new fields — the accuracy test flagged it). |
| v0.1.28 | 2026-06-25 | 438 | **63** | + analysis engine; verified train↔serve | **Understanding layer**: `analyzeSpot()` reads any spot in plain English grounded in real math — names the made hand + draws, computes equity vs range and pot odds, and gives the call/fold/value read ("K-high, 0% vs range, need 50% → fold"). Also **verified the Chrome extension bundles the exact trained model** (dist W1 == model.ts byte-for-byte) and added `MODEL_SIGNATURE` so the live model is checkable. (Rating flat: this makes the brain legible/trustworthy, doesn't change its decisions.) |
| v0.1.27 | 2026-06-25 | 432 | **63** | + anti-punt pot-odds floor | **Stop punting (critical fix)**: the net was calling river all-ins with king-high and calling OOP with no equity. Added a hard guard — facing a bet, fold whenever equity vs villain's continuing range is below the pot odds, overriding the net. Regression tests pin king-high-folds-to-jam while the nuts still continues. |
| v0.1.26 | 2026-06-25 | 426 | **62** | + bet-size head **92.4%** | **Learned bet sizing**: added a second head predicting the solver's size bucket (small/⅔/¾–pot/overbet/all-in) from the same features — 92.4% val accuracy vs 39% baseline. Replaces the flat texture heuristic, which under-bet. The bot now chooses both the action and a solver-calibrated size. |
| v0.1.25 | 2026-06-25 | 421 | **60** | 512×256, 48 feat, **84.19%** | **Richer features**: added draw + pair-quality structure (flush/straight draws, overpair/top-pair/dominated-pair, kicker), 37 → 48 features; re-prepped 500k rows and retrained. Held-out 82.96% → **84.19%**, log-loss 0.40 → 0.37. Bigger gain than the width bump — features were the bottleneck. |
| v0.1.23 | 2026-06-25 | 416 | **59** | 512×256, 37 feat, 83.34% | Widened the postflop net (256/128 → 512/256, ~43k → ~150k params) and retrained on the 500k solver decisions: held-out accuracy 82.96% → **83.34%**, log-loss 0.40 → 0.39. TS↔numpy parity 7.6e-6. |
| v0.1.22 | 2026-06-25 | 416 | **58** | 256×128, 82.96% | Range-gated the −EV sanity overrides; exploit only fires on a real read (≥50 hands); fixed the never-bluff-a-station bug. Exploitation flipped net-negative → **net-positive**. |
| v0.1.21 | 2026-06-25 | ~408 | ~54 | 256×128, 82.96% | Baseline before the decision-quality fixes: sanity overrode on equity-vs-random; exploit adjuster lost money at scale; stations got barreled (bluff-reduction bug). |

> To refresh the row: `npm test` for the count, `npm run sim -- 10000 42` for the
> bb/100, then add a line above with the new version, numbers, and rating.
