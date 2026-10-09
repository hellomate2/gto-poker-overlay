# blueprint+search: pre-registered match results (2026-10-09)

Pre-registration: [PREREGISTRATION.md](PREREGISTRATION.md), committed in
f8742fe before the runs. Driver: [run-matches.sh](run-matches.sh); deal-level
JSON per shard and one JSON line per search in [raw/](raw/).

One deviation from the pre-registration: the runs used 3 shard processes
(`--shard k/3`) instead of `--workers 4`, to leave one of the 4 allowed
threads for tests. The runner seeds every deal on its own, so the shard
count does not change which cards or random streams a deal gets. The search
itself stops on wall time (1,500 ms), so its iteration count depends on
machine load; that is true for any shard count.

Code: detached worktree at 81b3077 (the agent and serve code of this
branch). Checkpoint /Users/rg/.gpo/eval/final.bin (12,749,175,749
iterations). Heads-up duplicate, 100 BB, blinds 10/20, 3,000 deals (6,000
hands) per seed. Positive = blueprint+search wins.

| match | seed | bb/100 | 95% CI | interval | sd per deal (bb) | wall |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| (a) vs pure blueprint (same checkpoint) | 7 | +10.40 | +/- 18.28 | [-7.88, 28.68] | 10.22 | 1,305 s |
| (a) vs pure blueprint | 101 | +8.85 | +/- 15.34 | [-6.49, 24.19] | 8.57 | 1,386 s |
| (a) pooled, 6,000 deals | both | +9.62 | +/- 11.93 | [-2.31, 21.56] | 9.43 | |
| (b) vs ORIGINAL bot (swarm/base b39bc8b DecisionEngine) | 7 | +19.88 | +/- 19.65 | [0.23, 39.52] | 10.98 | 841 s |
| (b) vs ORIGINAL bot | 101 | +24.08 | +/- 18.82 | [5.26, 42.90] | 10.52 | 767 s |
| (b) pooled, 6,000 deals | both | +21.98 | +/- 13.60 | [8.38, 35.58] | 10.75 | |

Per-seed rows: `npx tsx sim/match-combine.ts --mode hu raw/<run>-shard*.json`.
Pooled rows: `python3 pool.py raw/<a|b>-s*-shard*.json` (the same per-deal
statistic over both seeds; it reproduces the per-seed rows exactly).

Verdict under the pre-registered rule:

* (a) Not a counted gain. Both seeds and the pool point the same way
  (+9.62 bb/100 pooled) but every interval covers 0. For scale, the
  variance-reduced `bp search-h2h` measured +130.1 +/- 48.5 mbb/hand
  (+13.0 bb/100) for the same idea on an earlier checkpoint
  (blueprint/SEARCH.md). At the sd measured here (9.43 bb per deal), an
  interval that excludes 0 at the observed +9.62 bb/100 needs about
  (1.96 x 9.43 x 50 / 9.62)^2, about 9,230 deals, if the effect is as
  large as observed; that is about 3,230 more than were run.
* (b) A counted gain: +21.98 bb/100 pooled, interval [8.38, 35.58]; each
  seed's interval also excludes 0. This compares the whole
  blueprint+search agent with the original bot; it does not isolate what
  search adds over the pure blueprint against that bot.

Agent health over the 12,000 deals (24,000 hands):

| run | blueprint+search decisions | illegal | blueprint-path fallbacks | river searches | with an off-tree size | search fallbacks | round trip p50 / p95 / max (ms) | iterations p50 / p5 / min |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| a, seed 7 | 17,219 | 0 | 0 | 2,493 | 0 | 0 | 1,501 / 1,507 / 1,540 | 1,541 / 1,134 / 500 |
| a, seed 101 | 17,608 | 0 | 0 | 2,592 | 0 | 0 | 1,500 / 1,501 / 1,511 | 3,056 / 2,598 / 912 |
| b, seed 7 | 12,486 | 0 | 8 | 1,363 | 268 | 0 | 1,501 / 1,502 / 1,583 | 2,225 / 1,584 / 878 |
| b, seed 101 | 12,300 | 0 | 19 | 1,298 | 237 | 0 | 1,501 / 1,501 / 1,510 | 2,788 / 2,174 / 1,728 |
| all | 59,613 | 0 | 27 | 7,746 | 505 | 0 | 1,501 / 1,503 / 1,583 | 2,608 / 1,252 / 500 |

The blueprint-path fallbacks are all the known "committed" kind (an
off-tree raise translated to the abstract all-in and called; the agent then
checks and calls). Round trip is TS to `bp serve` and back
(`python3 timing.py raw/*-search.jsonl`). Every search ran at least 500
iterations, far above the 100-iteration floor, so none fell back. Load
averages at the start of each run are in raw/driver.log (4.79 to 13.87);
other agents' jobs shared the machine throughout.
