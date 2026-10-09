# Blueprint trainer (heads-up no-limit hold'em, Pluribus-style MCCFR)

Offline C++17 pipeline that trains a heads-up no-limit hold'em blueprint
strategy with external-sampling Monte Carlo CFR and the practical tricks
Pluribus used, then exports a compact policy file that the TypeScript engine
can read through `src/core/blueprint/loader.ts`.

No dependencies beyond a C++17 compiler and pthreads. It builds with the
Apple clang on this Mac and with any recent g++/clang++ on Linux, so the same
code can be moved to a rented many-core box unchanged.

## Changes on 2026-10-09 (PLAN.md M0, before the overnight run)

* All-in stays legal at every no-limit node where both players have chips
  behind, including nodes where the street's raise cap is reached; a capped
  node now offers fold, call, all-in. Limit games (Kuhn, Leduc) keep the hard
  cap. The tree description gains a `capped_allin=1` tag, so checkpoints from
  the older tree are refused on load. New sizes from `bp tree`: small has
  31,938 nodes (was 29,346), 623,940 infosets at 50 buckets and 2,465,340 at
  200; medium at 200 buckets has 32,033,708 infosets (1,019.8 MB of tables).
  The run numbers further down were measured on the older tree.
* Negative-regret pruning skips an action only if the current strategy gives
  it probability exactly 0. Before, a node whose regrets were all below the
  threshold (uniform play) could skip every action, return 0 and update
  nothing; now such a node is explored in full, and the max-regret action is
  never skipped. Test: `pruning keeps node value` (fails on the old rule).
* Checkpoints are fsynced before the rename. `train --resume` falls back from
  `ckpt.bin` to the newest loadable snapshot and refuses to start fresh when
  checkpoint files exist but none loads. `train --until-epoch T` stops at Unix
  time T, a deadline that survives restarts. Test: `checkpoint resume is
  exact` (an interrupted single-thread run, saved and resumed across the
  Linear-CFR schedule and the pruning start, ends bit-identical to an
  uninterrupted one).
* Gates after the change: Kuhn 0.000427 at 4M iterations (1 thread), Leduc
  0.008750 at 4M (4 threads); `make test` 2,374 checks, 0 failures; a
  `-fsanitize=address,undefined` build trained the small tree for 46 s on 2
  threads with pruning and discounting on, then resumed for 19 s, with no
  sanitizer report.

## Layout

| File | What it does |
| --- | --- |
| `src/eval.{h,cpp}` | 5 to 7 card hand evaluator (incremental, table driven) |
| `src/abstraction.{h,cpp}` | suit isomorphism, EHS features, k-means, bucket tables, cache files |
| `src/tree.{h,cpp}` | abstract betting tree for limit (Kuhn, Leduc) and no-limit rules |
| `src/games.h` | deal samplers: Kuhn, Leduc, hold'em (cards projected to buckets) |
| `src/mccfr.h` | the trainer (one template for every game) and the exact best response |
| `src/export.{h,cpp}` | policy export format |
| `src/aivat.h` | AIVAT estimator (generic), Kuhn/Leduc card models, exact-moment enumerator |
| `src/aivat_holdem.h` | hold'em card model for AIVAT, duplicate match loop, hand-log format |
| `src/main.cpp` | the `bp` CLI |
| `tests/test_main.cpp` | C++ tests (`make test`) |
| `tests/test_aivat.cpp` | AIVAT tests (`make test-aivat`) |
| `../src/core/blueprint/loader.ts` | TS reader for exported policies |
| `../tests/blueprint-loader.test.ts` | vitest suite for the loader, using real exports as fixtures |

Generated files stay out of git: `bin/`, `cache/` (abstraction tables),
`runs/` (checkpoints, logs, snapshots).

## Build and test

```bash
cd blueprint
make            # bin/bp
make test       # bin/bp_tests: evaluator counts, isomorphism counts, EHS vs brute force,
                # tree invariants, Kuhn/Leduc convergence, checkpoints, export
```

`make ARCH=` drops `-march=native` if the binary has to run on a different CPU
than the one that built it.

## Running it

```bash
# 1. correctness gate: same MCCFR code on Kuhn and Leduc, exact exploitability
./bin/bp gate --game kuhn  --iters 2000000
./bin/bp gate --game leduc --iters 2000000 --threads 4

# 2. card abstraction (cached under cache/, reused by every later command)
./bin/bp abs --flop 50 --turn 50 --river 50 --bins 50 --threads 4

# 3. sizes and throughput
./bin/bp tree  --preset small --flop 50 --turn 50 --river 50
./bin/bp bench --preset small --seconds 8 --max-threads 4

# 4. train (time-bounded; resumable)
./bin/bp train --preset small --threads 4 --minutes 25 \
    --discount-every 2000000 --lcfr-until 80000000 \
    --prune-after 20000000 --prune-threshold -30000000 --regret-floor -31000000 \
    --out runs/hu-small-25min
./bin/bp train ... --resume          # continues from runs/.../ckpt.bin

# 5. evaluate
./bin/bp h2h --a runs/hu-small-25min/ckpt.bin --b checkcall --hands 500000
./bin/bp h2h --a runs/hu-small-25min/ckpt.bin --b random    --hands 500000
./bin/bp br  --target runs/hu-small-25min/ckpt.bin --minutes 3 --threads 4
./bin/bp show --ckpt runs/hu-small-25min/ckpt.bin            # preflop open grid

# 6. export for the TS engine
./bin/bp export --ckpt runs/hu-small-25min/ckpt.bin --out runs/hu-small-25min/blueprint.gpobp
```

Every hold'em command takes the same tree and abstraction flags
(`--preset`, `--flop/--turn/--river/--bins`, `--abs-seed`, and the optional
`--pre-fracs`, `--bet-fracs`, `--raise-fracs`, `--max-raises`,
`--pre-max-raises`, `--stack`). A fingerprint of the tree description plus
the abstraction id is stored in every checkpoint, and loading into a
different tree or abstraction is refused.

## Architecture

### Hand evaluator

Same split as the TS evaluator in `src/core/equity/eval-tables.ts`
(phevaluator's idea): flush hands go through a table keyed by the 13-bit rank
mask of the flush suit, everything else through a table keyed by the per-rank
count vector. The difference is the key: here the rank key is the sum of
`5^rank` over the cards. Every rank appears at most four times, so that sum
is the base-5 number whose digits are the count vector, which makes it unique
and additive. A board's key plus two hole-card keys is the 7-card key, so the
hot loops (EHS over 1,081 hands on a fixed board) cost one addition and one
hash probe per hand. Flushes are detected from four packed 4-bit suit
counters with a single mask test. Tables are generated at startup from a slow
reference 5-card scorer in about 50 ms.

Tests check the 7,462 equivalence classes and the published category counts
for all 2,598,960 five-card and all 133,784,560 seven-card hands.

### Card abstraction (imperfect recall, one bucket per street)

* Preflop: 169 lossless classes. Index `row * 13 + col` on the usual grid,
  ranks 0..12 = 2..A: pairs on the diagonal, suited `(high, low)`, offsuit
  `(low, high)`. `preflopClass()` in the TS loader is the same function.
* Flop and turn: for every (hole, board) the histogram of river EHS over all
  completions (1,081 turn+river runouts on the flop, 46 rivers on the turn),
  turned into a CDF and clustered with k-means under L2. L2 between CDFs is a
  smooth stand-in for the 1-D earth mover's distance (which is L1 between
  CDFs). This is the "distribution-aware" abstraction; the potential-aware
  variant (histograms over next-street clusters) is the natural next step and
  slots into `build_street()`.
* River: 1-D k-means on EHS, the probability of beating one uniformly random
  opponent hand (ties count half, card removal exact).
* Suit isomorphism: a board maps to the lexicographically smallest relabeling
  of its suits. Tables are dense `[canonical board][combo index of the
  relabeled hole]`, so lookups are a sort of 3 to 5 cards plus two array
  reads. There are 1,755 canonical flops, 16,432 turns and 134,459 rivers
  (asserted in the tests).
* Centers are fit on a sample of uniformly drawn boards (`--sample-flops`,
  `--sample-turns`, `--sample-rivers`), then every canonical board is
  bucketed. Flop and turn tables (`uint16`) and the river centers are saved
  under `cache/abs-<id>.bin`. The river table (one byte per entry, 178 MB) is
  rebuilt from the centers at load time because it takes seconds and would
  otherwise dominate the cache file. River buckets above 255 fall back to
  computing EHS per deal.

### Betting tree

One representation for every game: a node has a type (decision, fold,
showdown), the acting player, the street, the chips each player has
committed, and a contiguous block of children. A decision node owns
`buckets(street) * nact` regret slots laid out `[bucket][action]`. An
infoset is (node, bucket of the acting player), the usual imperfect-recall
blueprint layout.

No-limit sizing is pot-relative: a bet is `frac * pot`, a raise adds
`frac * (pot + to_call)` on top of the call (never less than the previous
raise increment), sizes that reach the stack collapse into the explicit
all-in, and duplicates merge. `max_raises` caps bets plus raises per street.
Units follow Pluribus: blinds 50/100, 10,000-chip (100 BB) stacks, so its
pruning constants are in the same units. Player 0 is the small blind and
button.

Presets (`--preset`): `tiny` (one size per street), `small` (preflop 0.5x and
1x pot raises with 3 raises; postflop bets 0.5x and 1x pot, raises 1x pot, 2
raises; all-in everywhere), `medium` (preflop 0.5/1/2 pot, 4 raises;
postflop bets 0.33/0.66/1/2, raises 0.66/1/2, 3 raises).

### MCCFR

`Trainer<Sampler>` in `src/mccfr.h` is used unchanged for Kuhn, Leduc and
hold'em. Per iteration and per player p, one deal is sampled, all of p's
actions are explored, and the opponent's actions are sampled from the
current strategy (external sampling). Then:

* Linear CFR, Pluribus style: while `iter < lcfr_until`, every
  `discount_every` iterations all regrets and strategy sums are multiplied by
  `d / (d + 1)` with `d = iter / discount_every`.
* Negative-regret pruning: after `prune_after` iterations, 95% of traversals
  skip any action whose regret is below `prune_threshold`, except actions
  that end the hand and nodes on the last street.
* Regrets are `int32`, rounded from `utility * regret_scale`, floored at
  `regret_floor` and saturated at `INT32_MAX`. Hold'em uses chips directly
  (scale 1). Kuhn and Leduc use scale 10,000 because their payoffs are a few
  chips.
* Average strategy is accumulated in `double` at the opponent's nodes during
  the traversal (Lanctot's simple averaging for external sampling). Pluribus
  kept an average only for preflop and used the current strategy postflop to
  save memory; that would cut memory per slot from 12 to 4 bytes.
* Threads share the regret and average tables without locks, as Pluribus did.
  Every shared access is a relaxed atomic load or store (`common.h`), which is
  free on arm64 and x86-64 and keeps the program free of data races in the C++
  sense. Lost updates between threads are possible and tolerated.
* Checkpoints hold the iteration count, the effective (discounted) iteration
  weight, regrets and sums. They are written to a temp file and renamed.
  `train` writes `ckpt.bin` every `--ckpt-every-min` and a copy under
  `snapshots/` every `--snapshot-every-min`; `--resume` continues.

`ExactEval` computes exact best responses for small games by walking the
tree once with a vector over all deals. Exploitability is
`(BR_0 + BR_1) / 2`, zero exactly at equilibrium.

For hold'em, where an exact best response is out of reach, there are three
progress measures:

* `avg_pos_regret_mbb` in `log.csv`: the sum over all infosets of the largest
  positive cumulative regret, divided by the effective iteration count. It
  falls as CFR converges. With sampling and imperfect recall it is a trend
  indicator, not a bound.
* `bp br`: freezes the blueprint, trains an exploiter with the same MCCFR code
  where the blueprint's nodes always play the frozen policy, then scores the
  exploiter against it in duplicate. The result lower-bounds the blueprint's
  exploitability inside the abstraction.
* `bp h2h`: duplicate head-to-head (each deal played twice with seats
  swapped) against fixed agents (`checkcall`, `random`, `maniac`) or another
  checkpoint.

### Export format and TS loader

`bp export` writes:

```
bytes 0..7   "GPOBP001"
bytes 8..11  u32 header length H
bytes 12..   H bytes of JSON header
nodes        num_nodes x 28-byte records (type, player, street, nact,
             act_kind, raises, frac_milli, child, parent, strategy offset,
             contrib[0], contrib[1]); little endian; 8-byte aligned
strategy     one byte per (decision node, bucket, action): average strategy
             quantized to integers summing to 255 per infoset; all zeros =
             never reached in training (read as uniform)
```

The header carries the tree description, bucket counts, blinds, stack,
section offsets, iteration count and the abstraction id plus the river
bucket bounds (9 significant digits, so float32 values round-trip).

`src/core/blueprint/loader.ts`:

```ts
import { Blueprint, preflopClass, riverEhs } from './core/blueprint/loader';
const bp = Blueprint.parse(bytes);                       // Uint8Array or ArrayBuffer
bp.lookup({ history: [], bucket: preflopClass(c1, c2) }); // SB's opening strategy
bp.lookup({ history: ['r1', 'c', 'k'], bucket: b });       // flop, SB facing a check
bp.lookupKey('r1 c k|17');                                 // same, string key
bp.riverBucket(riverEhs([c1, c2], board));                 // river bucket in TS
```

Tokens: `f` fold, `k` check, `c` call, `b<frac>` bet, `r<frac>` raise,
`a` all-in (limit games use bare `b` and `r`). Flop and turn buckets need the
k-means tables from `cache/abs-*.bin`, which the loader does not read yet.

## Correctness gate (Kuhn and Leduc)

Same `Trainer` code, Linear CFR discounting on for the first quarter of the
run, pruning on after 10%. Exploitability is exact (`ExactEval`). CSVs are in
`results/gate-*.csv`.

`./bin/bp gate --game kuhn --iters 4000000 --threads 1 --csv results/gate-kuhn.csv`

| iterations | exploitability | value to player 0 |
| ---: | ---: | ---: |
| 1,000 | 0.01295 | -0.05267 |
| 16,000 | 0.00714 | -0.05577 |
| 256,000 | 0.00197 | -0.05552 |
| 4,000,000 | 0.00043 | -0.05556 |

The game value converges to -1/18 = -0.05556. The test binary also checks
the loaded strategy against Kuhn's closed-form equilibrium family (Queen
never opens, King opens at three times the Jack's bluff rate), with 1 and 4
threads.

`./bin/bp gate --game leduc --iters 4000000 --threads 4 --csv results/gate-leduc.csv`

| iterations | exploitability | value to player 0 |
| ---: | ---: | ---: |
| 1,000 | 0.5010 | -0.1453 |
| 16,000 | 0.1046 | -0.1052 |
| 256,000 | 0.0301 | -0.0887 |
| 4,000,000 | 0.0091 | -0.0868 |

The tree has the standard 288 Leduc information sets (asserted in the
tests). With `--no-lcfr --no-prune` the same 4M-iteration run ends at
0.0084, so on a game this small the Pluribus tricks neither help nor hurt
measurably; they exist for the large game, where pruning skips most of the
tree.

## Measured performance on this machine

Apple M3 Pro (11 cores, 18 GB), Apple clang 21, `-O3 -march=native`. Five
other agents were sharing the CPU, so throughput depended on load; the load
average is given with each measurement.

| What | Result | Command |
| --- | --- | --- |
| 7-card eval, random hands | 101 to 155 M/s, 1 thread | `bp bench --no-train` |
| river EHS for all 1,326 hands on a board | 11.7 to 18.8 us | `bp bench` |
| hold'em deal incl. 8 bucket lookups | 0.46 to 0.78 us | `bp bench` |
| abstraction build 50/50/50 | 37.0 s wall, 127 s CPU, 329 MB peak | `/usr/bin/time -l bp abs --threads 4` |
| abstraction build 200/200/200 | 51.1 s wall, 183 s CPU, 389 MB peak | same, `--flop 200 --turn 200 --river 200` |
| river table rebuild at load | 0.6 to 1.0 s isomorphism + 1.0 to 1.5 s EHS, 178 MB | printed by every hold'em command |

Training throughput, `bp bench --seconds 10 --max-threads 4` (iterations are
one traversal per player; an infoset visit is one regret-matching step):

| Tree, buckets | slots | threads | iterations/s | infoset visits/s | load avg |
| --- | ---: | ---: | ---: | ---: | ---: |
| small, 50/50/50 | 1.48 M | 1 | 85,673 | 11.0 M | 15.7 |
| small, 50/50/50 | 1.48 M | 4 | 196,749 | 30.3 M | 15.7 |
| small, 50/50/50 | 1.48 M | 1 | 184,499 | 30.4 M | 6.4 |
| small, 50/50/50 | 1.48 M | 4 | 642,532 | 129.4 M | 6.4 |
| medium, 50/50/50 | 20.5 M | 1 | 55,094 | 14.9 M | 6.5 |
| medium, 50/50/50 | 20.5 M | 4 | 180,432 | 56.0 M | 6.5 |
| medium, 200/200/200 | 81.5 M | 1 | 45,221 | 13.1 M | 6.4 |
| medium, 200/200/200 | 81.5 M | 4 | 166,468 | 46.2 M | 6.4 |

On the medium 200-bucket tree, going from 1 to 4 threads gave 3.5x the
visits per second. Scaling beyond 4 threads was not measured here (the
budget for this run was 4 threads).

Memory, from `bp tree`: 12 bytes per regret slot (int32 regret plus double
average), which is 30.7 bytes per infoset on the small tree (2.56 actions per
infoset on average) and 31.7 on the medium tree. The 25-minute run peaked at
286 MB RSS: 17.8 MB of training tables, the 178 MB river table, the 44 MB
turn table and the evaluator.

## The 25-minute heads-up run

```bash
./bin/bp train --preset small --threads 4 --minutes 25 --log-every-sec 30 \
  --discount-every 2000000 --lcfr-until 80000000 --prune-after 20000000 \
  --prune-threshold -30000000 --regret-floor -31000000 --seed 1 --out runs/hu-small-25min
```

Tree `small` with 50/50/50 buckets: 29,346 nodes, 578,836 infosets,
1,482,601 regret slots. The schedule copies Pluribus's shape at a smaller
scale: about 40 Linear CFR discounts over the first 80M iterations, pruning
from 20M. Pluribus's pruning threshold (-300M chips) would rarely trigger in
a run this short, so the threshold and floor were scaled down by 10x; the
log's `pruned_frac` column shows how many traverser actions were skipped.

Result: 596,538,478 iterations in 1,500 s (mean 61.8 M infoset visits/s,
9.27e10 visits in total, about 160,000 per infoset on average). The full
log is `results/hu-small-25min-log.csv`; selected rows:

| seconds | iterations | it/s (last 30 s) | sum of avg positive regret (mbb) | preflop L1 move | SB fold / limp / raise | pruned |
| ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 30 | 8.5 M | 282,543 | 13,382 | 0.920 | 0.081 / 0.286 / 0.634 | 0.000 |
| 184 | 50.0 M | 293,052 | 3,446 | 0.047 | 0.087 / 0.219 / 0.693 | 0.030 |
| 487 | 158.2 M | 412,909 | 1,305 | 0.013 | 0.096 / 0.181 / 0.723 | 0.110 |
| 791 | 283.0 M | 398,573 | 797 | 0.0042 | 0.098 / 0.162 / 0.740 | 0.152 |
| 1,095 | 429.5 M | 473,540 | 566 | 0.0037 | 0.100 / 0.155 / 0.745 | 0.176 |
| 1,500 | 596.5 M | 439,944 | 434 | 0.0007 | 0.101 / 0.149 / 0.750 | 0.195 |

"preflop L1 move" is the mean L1 distance between consecutive logged
average strategies over all preflop infosets, so it measures how much the
preflop strategy was still changing. Throughput rose during the run as
pruning skipped more of the tree and as other agents' load changed.

Small blind opening strategy at the end (fold, limp, raise 0.5 pot, raise 1
pot, all-in): AA 0 / 0.08 / 0.46 / 0.46 / 0; AKs 0 / 0 / 0.05 / 0.94 / 0;
T9s 0 / 0.03 / 0.57 / 0.39 / 0; A5o 0 / 0.07 / 0.93 / 0 / 0; 72o 1 / 0 / 0 /
0 / 0. `bp show --ckpt runs/hu-small-25min/ckpt.bin` prints the whole grid.

### Exploitability inside the abstraction

`bp br --target <ckpt> --minutes 3 --threads 4 --out <exploiter>`, then
`bp h2h --a <exploiter> --b <ckpt> --hands 2000000 --threads 4 --seed 123`:

| target | iterations | exploiter wins (mbb/hand, 95% CI) |
| --- | ---: | ---: |
| 1-minute run (`runs/sanity`, scored on 300k deals) | 13.2 M | +118.9 +/- 24.9 |
| 5-minute snapshot of the main run | 87.7 M | +48.9 +/- 9.5 |
| final checkpoint | 596.5 M | +20.5 +/- 9.0 |

These are lower bounds: the exploiter is itself a 3-minute sampled
approximation and only sees the same buckets as the blueprint. A full-game
best response would find more.

### Head-to-head (duplicate, `bp h2h --hands 500000 --threads 4`)

| blueprint | opponent | mbb/hand (95% CI) |
| --- | --- | ---: |
| final | check/call | +1,884.2 +/- 29.8 |
| final | uniform random over abstract actions | +1,863.3 +/- 45.2 |
| final | maniac (always the largest bet, all-in when offered) | +1,430.2 +/- 49.7 |
| final | its own 5-minute snapshot (1M deals) | +22.0 +/- 12.5 |
| final | the 1-minute run (1M deals) | +58.5 +/- 13.4 |

Against check/call, snapshots at 87.7M, 207.0M, 335.7M, 483.1M and 596.5M
iterations scored +1,954.6, +1,891.6, +1,888.8, +1,880.2 and +1,884.2
mbb/hand (each +/- about 30). The win rate against this one fixed agent
falls slightly as the strategy moves toward equilibrium, which does not
try to maximize winnings against any particular opponent. The exploiter and
self-play rows are the better measures of progress.

## Scaling up: an extrapolation from these measurements

Assumption, stated plainly: a larger abstraction reaches roughly the
quality we measured here once it gets the same average number of infoset
visits per infoset (about 160,000). That is a crude rule. It ignores that
visits are very uneven across infosets and that bigger abstractions may
need more or fewer visits, so treat the result as an order of magnitude.

Cost of one visit, from the medium 200-bucket bench: 46.2 M visits/s on 4
threads, about 11.5 M per thread-second.

| tree, buckets | infosets | tables | visits needed | thread-hours | wall-clock on 4 threads |
| --- | ---: | ---: | ---: | ---: | ---: |
| small, 50 (this run) | 578,836 | 17.8 MB | 9.27e10 (measured) | 1.7 (measured, 4 threads x 25 min) | 25 min |
| small, 200 | 2,293,036 | 70.4 MB | 3.67e11 | 8.8 | 2.2 h |
| medium, 200 | 30,864,836 | 978 MB | 4.94e12 | 119 | 30 h |
| medium, 1000 | 154,159,236 | 4.9 GB | 2.47e13 | 594 or more | 149 h |

The medium-1000 row uses the medium-200 per-visit cost, which is
optimistic: its 4.9 GB of tables fit in cache even less well, and river
buckets above 255 fall back to computing EHS per deal (about 5 us per deal
on random boards, see `bp bench`), so its real cost is higher. Thread-hours
divide across cores only to the extent the lock-free scheme keeps scaling,
which was measured only up to 4 threads (3.5x). For context, the Pluribus
paper (Brown and Sandholm, Science 2019) reports 8 days on a 64-core server
and under 512 GB of memory for its six-player blueprint; nothing here was
benchmarked against that.

Moving to a rented machine: `cloud/README.md` has the step-by-step package
(setup, bench gate, cost math, resumable training, fetch). By hand: copy `blueprint/`, `make`, run `bp abs` with the
target bucket counts (the abstraction build is multithreaded), then `bp train`
with `--threads` set to the core count and a long `--minutes`; `--resume`
picks up after an interruption. For memory, the first lever is storing
average strategies only for preflop (as Pluribus did), which takes the cost
per slot from 12 bytes to 4.

## AIVAT: variance-reduced match scoring (PLAN.md M1)

AIVAT (Burch, Schmid, Moravcik, Morrill, Bowling, AAAI 2018,
https://arxiv.org/abs/1612.06915) scores each hand as the chips won plus
zero-mean correction terms that remove luck the evaluator can explain:

* a chance term at every chance event (both hole pairs, flop, turn, river,
  and the run-out after an all-in): `E[V(after any card)] - V(after the dealt card)`;
* an action term at every decision of a player whose strategy is known:
  `sum_a sigma(a) V(after a) - V(after the action taken)`.

Each term has expectation zero, so the estimate is unbiased for any value
function V; V only decides how much variance goes away. Decisions of an
opponent whose strategy is unknown get no term.

### Commands

```bash
make test-aivat                          # exact-enumeration and brute-force checks
./bin/bp aivat --game leduc --hands 1000000           # Leduc, A = 1M MCCFR iterations, B = 10k
./bin/bp aivat --game leduc --b self --hands 1000000  # Leduc self-play
./bin/bp h2h --aivat --a X.bin --b Y.bin --hands 500000 [tree/abs flags]
./bin/bp h2h --aivat --aivat-known both ...           # also correct B's actions
./bin/bp h2h --aivat ... --aivat-log-out hands.log    # write every hand as a log line
./bin/bp aivat-log --a X.bin --log hands.log [tree/abs flags]   # score a logged match
```

`bp h2h --aivat` plays the usual duplicate match (each deal twice, seats
swapped) and prints, per duplicate deal and per hand, the plain and AIVAT
means with 95% CIs, the paired AIVAT-minus-plain difference (it must
contain 0), the mean chance and action terms and the SD reduction.
`--aivat-known a` (default) treats B as unknown: only A's actions and chance
are corrected, and inside V the opponent is modeled by A's strategy or by
`--aivat-model SPEC` (any agent spec). `--aivat-known both` also corrects
B's actions.

### The value function

`V(h)` is the expected result over the rest of the current street with both
players following the strategies the estimator knows (or models), cut off
where the street ends. A cut-off node is valued `pot * equity - committed`,
where equity is exact on the flop (all 990 turn and river runouts), turn and
river, and comes from a 169 x 169 class-vs-class table preflop (Monte Carlo
with a fixed seed, 2,000 samples per class pair by default; the table only
shapes V, so its sampling error cannot bias the estimate). Fold nodes and
river showdowns are exact. The expectation over the hole cards is exact (a
sum over class pairs weighted by their combo counts out of 1,326 x 1,225
ordered hole pairs). The expectation over the flop averages 32 flops drawn
from a separate random stream (`--aivat-flops`), which keeps it unbiased;
turn and river cards are enumerated.

Observed-path lookahead (`--aivat-lookahead S`, default 2; 4 turns it off):
in the walk along the observed path, which supplies the action corrections,
nodes where the flop or turn ends are valued by every next card and the next
street's betting instead of by equity. Chance terms keep the equity cut-off.
Each correction stays zero-mean on its own; the root expectation and every
chance term must use the same V, which the exact tests check (an earlier
draft that mixed the two V's for one chance term was biased, and the Leduc
enumeration test caught it). `--aivat-lookahead-full` uses the lookahead
everywhere (a consistent V; on hold'em 109 s instead of 3 s for 20,000
deals, see the ablations below).

Not implemented: the paper's "imaginary observations" (averaging over every
private hand A could hold, weighted by A's reach). It would need V walks for
about 1,000 hands per hand played.

### Validation against exact references

`make test-aivat` (387 checks, 0 failures). Kuhn and Leduc are enumerated
over every deal and every action path with its true probability:

* For two hashed mixed strategies, a 100k-iteration MCCFR strategy against
  uniform, and its self-play, the exact expectation of the AIVAT estimate
  equals `ExactEval`'s game value within 1e-9 for every set of known players
  (none, either, both), both positions, and all three value functions.
* Both strategies known with the exact V (`exact_depth`): every path scores
  the game value (spread under 1e-9).
* Hold'em equity: river equity equals the showdown result; turn equity
  equals the average over all 44 rivers; flop equity equals the average of
  turn equities over all 45 turns; equities of the two players sum to 1. For
  AhAd vs KcKs, exact enumeration over all 1,712,304 boards gives 0.81255;
  the test's class table (300 samples per pair) gives 0.83833 for AA vs KK.
* Sampled hold'em on the `tiny` tree with one postflop bucket and no card
  abstraction, 20,000 hands: the paired AIVAT-minus-plain mean is inside 4
  standard errors of 0 for A known and both known, with and without the
  lookahead.
* `bp aivat-log` replaying a 40,000-hand log written by `bp h2h --aivat`
  reproduces the same plain and AIVAT means and SDs.

Leduc, `./bin/bp aivat --game leduc --hands 1000000` (chips per duplicate
deal, A = 1M MCCFR iterations, B = 10k; exact expectation of A per deal
0.023884; plain +0.022594 +/- 0.002966, SD 1.51318):

| setting | AIVAT mean (95% CI) | SD | SD removed |
| --- | ---: | ---: | ---: |
| both known, exact V | +0.023884 +/- 3.7e-19 | 1.9e-16 | 100.0000% |
| both known, street V | +0.024142 +/- 0.000543 | 0.277169 | 81.68% |
| both known, street V + lookahead | +0.023829 +/- 0.000171 | 0.087166 | 94.24% |
| A known, street V | +0.023145 +/- 0.001703 | 0.868665 | 42.59% |
| A known, street V + lookahead | +0.023020 +/- 0.001690 | 0.861997 | 43.03% |

The PLAN.md M1 Leduc acceptance (both strategies known, at least 99% of the
SD removed, mean equal to the plain mean within CI) is met by the exact V.
The street V, which hold'em uses, removes 81.7% per deal here; for the
tests' 100k-iteration-vs-uniform pair the exact per-hand figure is 83.35%.

### Hold'em self-play, 1M hands

A copy of the overnight checkpoint (`~/.gpo/overnight/ckpt.bin` copied at
04:12 PDT, iteration 701,930,101; small tree, 200/200/200 buckets) against
itself, 500,000 duplicate deals = 1,000,000 hands, 4 threads:

```bash
./bin/bp h2h --aivat --aivat-known both --a ckpt.bin --b ckpt.bin --preset small \
  --flop 200 --turn 200 --river 200 --bins 50 --abs-seed 7 --threads 4 --hands 500000
```

mbb/hand; plain: per deal +4.9 +/- 17.0 (SD 6,144.5), per hand SD 13,044.4.

| setting | AIVAT per deal (95% CI) | AIVAT - plain, paired | SD per deal | SD per hand | SD ratio per deal | time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| both known, lookahead 2 (default) | -0.7 +/- 4.1 | -5.6 +/- 16.6 | 1,462.0 | 4,164.3 | 0.238 | 195 s |
| both known, no lookahead (`--aivat-lookahead 4`) | -0.2 +/- 5.2 | -5.1 +/- 16.6 | 1,886.4 | 4,498.3 | 0.307 | 61 s |
| A known, lookahead 2 (default) | +7.0 +/- 9.1 | +2.0 +/- 14.3 | 3,268.6 | 5,868.2 | 0.532 | 195 s |
| A known, no lookahead (`--aivat-lookahead 4`) | +7.1 +/- 9.4 | +2.1 +/- 14.3 | 3,373.9 | 5,987.6 | 0.549 | 55 s |

Times are wall-clock on a shared machine (load average between about 19
and 49 during these runs), so they compare only roughly. Every AIVAT
mean is within its CI of the plain mean and every paired difference contains
0. With both strategies known, the same CI needs (1 / 0.238)^2 = 17.7x fewer
deals; with only A known, 3.5x. For comparison, the AIVAT paper reports a
per-hand SD of 25.962 chips plain and 8.095 chips with AIVAT for HUNL
self-play at 100 BB (68.8% removed) with one strategy known; here the
per-hand figures are 68.1% (both known) and 55.0% (A
known).

Ablations on 20,000 duplicate deals, both known: `--aivat-flops` 8 / 32 /
128 gave per-deal SDs 2,000.0 / 1,889.2 / 1,853.1 (on 50,000 deals, before
the lookahead); `--aivat-lookahead` 4 / 3 / 2 gave 1,839.3 / 1,572.0 /
1,421.4 in 3 / 5 / 7 s; `--aivat-lookahead-full` from street 3 gave 1,294.9
in 109 s.

The opponent model matters when B is unknown. Against `checkcall`, 100,000
deals: plain +1,700.9 +/- 63.4 per deal (SD 10,234.0). With A known and the
opponent modeled by A's strategy, AIVAT gives +1,694.7 +/- 64.4 (SD 10,382.8,
no reduction per deal, 8.1% per hand). With `--aivat-model checkcall` (or
B known) it gives +1,706.7 +/- 32.2 (SD 5,192.7, 49.3% removed).

### Using it for the BlueprintAgent vs engine match

The TS `BlueprintAgent` (planned in `sim/play/bots.ts`) plays real bet sizes
against the engine, so its match runs outside `bp`. To score it with AIVAT:

1. For every hand, write one line in the `bp aivat-log` format:
   `id seatA holeA holeB board tokens resultA`, for example
   `10 0 9sTd KcJd 3s5dAdTh7h r0.5,c,k,b0.5,c,k,k,b1,c 1200`. `id` is a hand
   counter (it seeds the flop sampling, so ids must be unique; never derive
   them from the cards), `seatA` is the blueprint's position (0 = small blind
   and button), the board is all five cards (the local harness deals them, so
   they are known even when the hand ends early), `tokens` is the hand's path
   through the blueprint tree as the agent itself translated it (`bp
   aivat-log` refuses tokens that are not in the tree or a path that does not
   end at a terminal node), and `resultA` is the blueprint's real chip result
   (chips with 50/100 blinds, so off-tree bet sizes still count in real
   chips).
2. The estimate is unbiased only if the agent really sampled each abstract
   action from the strategy `bp aivat-log` assumes, at the same bucket. If
   the agent reads the exported `.gpobp` file, pass `--quantized` so the
   strategy is the exported one (bytes summing to 255, unvisited infosets
   uniform). Its flop and turn buckets must come from the same `cache/abs-*`
   tables (the TS loader does not load them yet). A purified (argmax) agent
   breaks this unless the log is scored against the purified strategy.
3. Run `./bin/bp aivat-log --a <ckpt> --log hands.log <tree/abs flags>
   [--quantized] [--out per-hand.csv]`. The engine's actions get no
   correction. Its strategy is unknown, so V models it by the blueprint
   unless `--aivat-model` names something closer; the checkcall result above
   shows a poor model can remove almost nothing per deal, so measure the SD
   on a pilot before fixing the hand count.

## Known limitations

* Flop and turn features are equity-distribution histograms. Potential-aware
  features (histograms over next-street clusters, earth mover's distance)
  are the standard upgrade and would plug into `build_street()`.
* The TS loader looks up (history, bucket). It computes preflop and river
  buckets itself but does not yet load the flop/turn k-means tables, and it
  has no action translation for real bet sizes that fall between the
  abstract sizes.
* The hold'em exploitability numbers are bounds measured inside the
  abstraction; there is no full-game best response.
* River tables support at most 255 river buckets; above that, river buckets
  are computed per deal.
