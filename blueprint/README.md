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
| `src/compact.h` | compact trainer (PLAN.md M3): preflop-only average, snapshot averaging, lazy arena regrets, `GPOCKPT2` checkpoints |
| `src/export.{h,cpp}` | policy export format |
| `src/main.cpp` | the `bp` CLI |
| `tests/test_main.cpp` | C++ tests (`make test`) |
| `tests/test_scale.cpp` | compact trainer tests (`make test-scale`; `make test` runs both) |
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
  save memory; `bp scale` does that (4 bytes per postflop slot, see "Compact
  trainer and scaling").
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
picks up after an interruption. For memory, `bp scale train` stores average
strategies only for preflop (as Pluribus did), which takes the cost per
postflop slot from 12 bytes to 4; see "Compact trainer and scaling" below.

## Compact trainer and scaling (PLAN.md M3, `bp scale`)

`src/compact.h` holds `CompactTrainer`, the same external-sampling MCCFR as
`Trainer` (same traversal, RNG stream, Linear-CFR discount, pruning rule and
regret floor) with the two Pluribus memory changes from
`gpo-research/pluribus.md` section 3:

* Running average only preflop. Flop, turn and river keep the int32 regret
  alone, 4 bytes per slot instead of 12. Their blueprint is a uniform average
  of current-strategy snapshots, which Pluribus took every 200 minutes and
  averaged offline. `bp scale train` adds each snapshot into a streaming
  on-disk sum (`snapavg.f32`, 4 bytes per slot, read and written one node at a
  time), so taking hundreds of snapshots costs neither memory nor one
  checkpoint file each.
* Lazy allocation. A node's regret block is created from a bump arena the
  first time a traverser writes to it; reads of a missing block see the
  uniform strategy, which is what an all-zero dense row gives.

Checkpoints are a new versioned format, `GPOCKPT2` (header, sorted list of
allocated blocks, preflop sums, end marker). The compact loader refuses a
dense `GPOCKPT1` file with a message naming the format, and the dense loader
refuses `GPOCKPT2` on its magic check, so old checkpoints never load into the
wrong trainer. `bp h2h` and `bp br` accept either: for a `GPOCKPT2` file they
use the snapshot average in `snapavg.f32` next to it.

```bash
./bin/bp scale gate --game leduc --iters 4000000 --threads 1   # dense vs snapshot averaging, exact exploitability
./bin/bp scale verify --preset small --iters 300000 ...         # dense == compact on hold'em, bit for bit
./bin/bp scale tree --preset medium --stack 20000 --probe-seconds 60 --threads 1
./bin/bp scale tree --preset small --flop 200 --turn 200 --river 200 --v1-ckpt <dense ckpt.bin>
./bin/bp scale bench --preset small --threads-list 1,2,4,8 --seconds 20 --max-load 14 --dense --csv bench.csv
./bin/bp scale train --preset small --threads 4 --minutes 25 --accum-from-iter N --accum-every-sec 60 --out runs/x
./bin/bp scale export --preset small --ckpt runs/x/ckpt.cbin --snap-accum runs/x/snapavg.f32 --out x.gpobp
```

### Correctness checks

* Equivalence with the dense trainer (`make test-scale`, `tests/test_scale.cpp`).
  Single-threaded with the same seed, the compact trainer with averages on
  every street ends with exactly the dense regrets and sums on Kuhn and Leduc
  (lazy and eager allocation); with the preflop-only average its regrets are
  still identical and its preflop sums equal the dense ones. On hold'em itself,
  `bp scale verify --preset small --iters 300000 --chunk 5000 --discount-every
  20000 --lcfr-until 100000 --prune-after 50000 --prune-threshold -3000
  --regret-floor -3100` printed 0 regret mismatches over 1,617,913 slots, 0
  preflop sum mismatches over 29,913, and equal visit (11,576,003) and pruned
  (1,545,632) counts.
* Lazy allocation: after one Leduc iteration 10 of 36 nodes are allocated, and
  every node the dense trainer wrote a nonzero regret to is among them; 20 runs
  of 8 threads racing on fresh tables allocate exactly one block per node. The
  test binary built with `-fsanitize=thread` and with
  `-fsanitize=address,undefined` ran the quick tests with no report.
* Checkpoints: round trip of a partly allocated table; a run saved and resumed
  across the discount and pruning start ends identical to an uninterrupted
  one; wrong fingerprint, wrong average-street setting, a `GPOCKPT1` file,
  trailing bytes and truncation are each refused. Snapshot sums from
  checkpoint files and from the on-disk accumulator equal the in-memory sums.

### Leduc gate with snapshot averaging

PLAN.md M3 asks for the Leduc exploitability with snapshot averaging to stay
within 2x of the dense average at 4M iterations. `bp scale gate --game leduc
--iters 4000000 --threads 1 --seed S --snap-start-frac A --snap-every-frac B`,
same schedule as `bp gate` (Linear CFR to 1M, pruning from 400k), dense
average vs preflop running average plus postflop snapshot average:

| seed | snapshots (start, spacing) | dense | snapshot average | ratio |
| ---: | --- | ---: | ---: | ---: |
| 1 | 55 (6.9%, every 1.74%: Pluribus's 800 and 200 of 11,520 minutes) | 0.008655 | 0.031924 | 3.69 |
| 2 | 55 (same) | 0.008967 | 0.034519 | 3.85 |
| 3 | 55 (same) | 0.008893 | 0.040244 | 4.53 |
| 1 | 151 (25%, every 0.5%) | 0.008655 | 0.016299 | 1.88 |
| 2 | 151 | 0.008967 | 0.018676 | 2.08 |
| 3 | 151 | 0.008893 | 0.014056 | 1.58 |
| 1 | 376 (25%, every 0.2%) | 0.008655 | 0.010614 | 1.23 |
| 2 | 376 | 0.008967 | 0.011209 | 1.25 |
| 3 | 376 | 0.008893 | 0.011212 | 1.26 |
| 1 | 751 (25%, every 0.1%; the default) | 0.008655 | 0.010086 | 1.17 |
| 2 | 751 | 0.008967 | 0.010901 | 1.22 |
| 3 | 751 | 0.008893 | 0.010721 | 1.21 |
| 1 | 3,751 (25%, every 0.02%) | 0.008655 | 0.012093 | 1.40 |
| 2 | 3,751 | 0.008967 | 0.010692 | 1.19 |
| 3 | 3,751 | 0.008893 | 0.010980 | 1.24 |

So the gate passes with a few hundred snapshots and fails with Pluribus's
count. The current strategy alone (no averaging after preflop) is at 0.33 to
0.42 in the same runs, so the snapshot average does most of the work. Whether
hold'em needs as many snapshots as Leduc is not measured; the accumulator
makes a high count cheap, so `bp scale train` defaults to one snapshot a
minute. The slow test `Leduc snapshot gate (4M)` reruns the 751-snapshot
setting (1 thread, seed 1, its own chunking): 0.00932 dense, 0.01009 snapshot.

On hold'em, at equal iterations: `bp train` and `bp scale train`, both with
`--preset small --threads 2 --seed 5 --iters 12000000 --discount-every 300000
--lcfr-until 3000000 --prune-after 1500000 --prune-threshold -3000000
--regret-floor -3100000`, the compact run with `--accum-every-sec 1
--accum-from-iter 3000000` (39 snapshots). `bp h2h --a <compact ckpt.cbin>
--b <dense ckpt.bin> --hands 1000000 --threads 2 --seed 12`: compact +5.9
mbb/hand (95% CI +/- 13.8, 2M hands); a 300,000-deal run with seed 11 gave
+20.8 +/- 25.2. No difference is detectable at this size. Two threads make
the runs nondeterministic, so their regrets differ slightly, not only their
averaging.

### Memory

`bp tree` now prints the compact layout next to the dense one. Measured with
`bp scale tree` on the current tree (after M0):

| tree | dense, 12 B/slot | compact, 12 B preflop + 4 B postflop | ratio |
| --- | ---: | ---: | ---: |
| small, 100 BB, 50 buckets | 19.4 MB | 6.7 MB + 0.51 MB index | 0.37 |
| small, 100 BB, 200 buckets (overnight run) | 76.6 MB | 25.8 MB + 0.51 MB index | 0.34 |
| medium, 200 BB, 200 buckets (R1) | 2,778.5 MB | 927.9 MB + 18.5 MB index | 0.34 |

`python3 cloud/cost.py memory` gives the same arithmetic for R2 (23.47 GB
dense, 7.84 GB compact) and R3 (94.88 GB, 31.65 GB).

Lazy allocation saves little heads-up, measured two ways. The overnight
run's checkpoint (dense, iteration 915,307,849, copied and read with `bp
scale tree --v1-ckpt`) has touched 100% of the node blocks on every street.
A fresh lazy run on the medium 200 BB tree (`--probe-seconds 60 --threads 1`,
772,500 iterations) had allocated every preflop and flop block, 64,047 of
64,060 turn blocks and 352,901 of 356,900 river blocks (98.9%): 250.4 MB of
tables against 696.6 MB dense, peak RSS 557 MB with the abstraction. External
sampling explores every traverser action, so nearly every node is reached
early. Pluribus reported more than 2x from lazy allocation in six-player
poker, where most action sequences are rare; that is where it should pay off
here too (M8). Plan heads-up RAM for every block.

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
