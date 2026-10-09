# Real-time search (PLAN.md M4 and M5)

Status on 2026-10-09: the C++ subgame solver and a first depth-limited search
agent exist, are checked against exact references, and run on the overnight
checkpoint. Off-tree opponent bets are handled on the turn and river. Preflop
search, off-tree sizes on the flop and safe re-solving gadgets are not built
yet (see "Not done" below). The TS BlueprintAgent uses this search at its
river decisions through `bp serve` (seat `blueprint+search:<ckpt>`, play bot
`blueprint+search`); see README.md, "Blueprint plus real-time search in the
agent", for the protocol, the parity test and the match results.

## Files and commands

| File | What it does |
| --- | --- |
| `src/subgame.{h,cpp}` | vectorized range-vs-range solver: DCFR and CFR+, card removal, showdown sweeps, chance nodes, depth-limit leaves, frozen actions, exact best response; a port of the TS single-street tree builder |
| `src/search.{h,cpp}` | copies the blueprint's betting subtree into a subgame (or rebuilds a round by the tree rules with an off-tree size inserted), builds k = 4 continuation leaves, computes beliefs, and holds the `bp search`, `bp search-h2h` and `bp subgame` commands |
| `tests/test_rt.cpp` | `make test-rt` |
| `scripts/export-ts-spots.ts` | exports spots solved by `src/core/solver/postflop-cfr.ts` for `bp subgame` |

```bash
make bin/bp && make test-rt

# one search (tree and abstraction flags must match the checkpoint)
TREE="--preset small --flop 200 --turn 200 --river 200 --bins 50 --abs-seed 7 --cache CACHE_DIR"
bin/bp search $TREE --ckpt CKPT --board "Qs 7h 2d" --history "r1 c" --hand "Qh Jh" --budget-ms 2000 --threads 4
#   --k 4 --bias 5 --rollouts 24 --max-hands N --algo dcfr|cfr+ --max-iters N

# blueprint + search on one street vs blueprint (exact-EV estimator, see below)
bin/bp search-h2h $TREE --ckpt CKPT --hands 8000 --iters 100 --threads 4 --seed 11            # river
bin/bp search-h2h $TREE --ckpt CKPT --street 1 --k-list 1,4 --max-hands 80 --rollouts 16 \
    --iters 300 --hands 700 --threads 4 --seed 21                                         # flop, k=1 vs k=4

# TS cross-check
npx esbuild blueprint/scripts/export-ts-spots.ts --bundle --platform=node --outfile=/tmp/ets.js
node /tmp/ets.js /tmp/ts-spots.txt 10 10 300 200 12345
bin/bp subgame --spots /tmp/ts-spots.txt
```

## How it works

The subgame is a public tree whose infosets are (public node, own hand), so
cards are lossless inside it. Each iteration walks the tree once per player
with the opponent's reach as a vector over its hands (public-tree CFR, the
same scheme as the TS solver). Payoffs use the TS convention: net chips from
the subgame start with the starting pot up for grabs, so the two payoffs sum
to that pot and exploitability is (BR0 + BR1 - pot0) / 2.

Card removal is inclusion-exclusion over cards, O(n) per node. A river
showdown sorts both hand lists by strength once per board, then one
ascending and one descending sweep give each hand the compatible opponent
reach it beats and loses to (Johanson et al. 2011). Showdowns before the
river (all-in on the flop or turn) use an exact equity matrix per board.
A chance node deals one card; given both hands the card is uniform over the
cards left, so every child has weight 1 / (deck - board - 4).

`bp search` takes a spot as blueprint action tokens plus cards. It finds the
first node of the current round and builds the ranges there from the
blueprint: each combo's prior times its owner's blueprint probability of
every action on the line (unsafe search from the round start, as Pluribus
did). Ranges are capped to the heaviest combos (120 per side on the flop,
300 on the turn, all 1,081 on the river by default) and the hero's hand is
always kept. The searcher's own actions already taken this round are frozen
for its real hand. The tree is the blueprint's own subtree from the round
start, so the search uses the blueprint's bet sizes.

Off-tree bets. When the history contains a size the blueprint lacks (for
example `--history "r1 c k k k k k b0.8"` with a menu of 0.5 and 1 pot),
the blueprint is followed as far as it goes, the round is rebuilt from its
start by the tree's own betting rules (a port of tree.cpp legal_actions),
and the real size is inserted on the actual line with tree.cpp's sizing.
The round is then re-solved from its start, which is Pluribus Algorithm 2
in its unsafe form. Without extra sizes the rule builder reproduces the
blueprint copy node for node (tested on a turn and a river root of the
`tiny` tree). On a real spot (board Qs 7h 2d 9c 3s, line `r1 c k k k k k
b0.8`, 1,081 combos per side, 4 threads) the re-solve ran 1,334 iterations
in 1.5 s and reached 0.014% of the pot.

On the turn and river the subgame runs to the end of the game (turn: one
chance node per river card, then the river betting). On the flop it stops
at the end of the round. Each leaf is a choice for both players between
k = 4 continuation strategies for the rest of the game: the blueprint, and
the blueprint with the probability of folding, of check/calling, or of
betting/raising multiplied by 5 and renormalized at every later decision
of that player (Pluribus supplementary; both players choose, as in Pluribus,
where Modicum let only the opponent choose). The payoff of every (choice,
choice, hand, hand) is precomputed by walking the blueprint subtree for each
runout; the flop uses 24 sampled turn/river runouts by default, the tests use
exact enumeration.

## Validation (all numbers from `make test-rt` and the commands above)

Closed-form toy river game. A polarized bettor (nuts or air, equal weight)
bets s pot into a bluff catcher. After 3,000 DCFR iterations: s = 0.5 gives
bluff share 0.25000 (closed form s/(1+2s) = 0.25000) and call 0.66660
(1/(1+s) = 0.66667); s = 1 gives 0.33333 and 0.50000 exactly; s = 2 gives
0.40000 and 0.33340 (0.33333). CFR+ lands within 2e-4 of the same values.

Showdown code. The sweep, the equity matrix and an explicit chance node over
the 48 rivers all equal an O(n^2) brute force to 1e-9 on 3 random river and
3 random turn spots with overlapping ranges.

Leduc against the trainer's ExactEval (an independent best response that
enumerates deals). On a 20,000-iteration MCCFR strategy the vector best
responses equal ExactEval's to 1e-9 (BR0 0.002850089, BR1 0.187756562,
exploitability 0.095303). Solving all of Leduc as one subgame for 2,000
DCFR iterations gives ExactEval exploitability 1.98e-4 and value -0.085607
(the known game value is about -0.0856). Re-solving each of the 15 round-2
subgames from the equilibrium's beliefs reproduces the equilibrium's
subgame value within 1.45e-4.

TS solver, 20 spots (10 river, 10 turn; 40 to 120 combos per side; random
pot, stack, bet faced and position). The C++ best response scores the TS
average strategy within 1.14e-13 chips of the exploitability TS reports, and
the C++ DCFR run for the same number of iterations ends within 2.7e-6 chips
of TS's exploitability, so the two solvers follow the same iterates.

Hold'em blueprint copies. With a random policy on the `tiny` tree, the river
subgame, the turn subgame (chance node plus river betting, 7,953 nodes) and
the depth-limited flop subgame (k = 1 leaves, exact runouts) each evaluated
under the blueprint equal a brute-force walk over every hand pair and runout
to 1e-9 (263.689544061, 109.317317013, 25.682690021).

Depth-limited search (M5) on Leduc, leaves at the round-2 roots, exact leaf
values. With k = 1 and the equilibrium as the continuation, the
depth-limited game's value is -0.085625 against the full game's -0.085607.
Rollout leaf values converge at the Monte Carlo rate: RMS error 0.0728 chips
at 2,000 rollouts and 0.0242 at 20,000 (ratio 3.01; sqrt(10) is 3.16).

Exact exploitability of search on Leduc (chips per hand, ExactEval). The
search replaces round 1 only; round 2 is the blueprint, or every reached
round-2 subgame is re-solved unsafely from the composite's beliefs.

| blueprint | blueprint alone | round-1 search, k = 1 | k = 4 | k = 4 + round-2 re-solve |
| --- | ---: | ---: | ---: | ---: |
| MCCFR 2,000 iterations | 0.4478 | 0.5405 | 0.5086 | 0.5969 |
| MCCFR 20,000 iterations | 0.0819 | 0.2463 | 0.1373 | 0.5106 |

k = 4 is less exploitable than k = 1 in both rows, the direction Pluribus
and Brown, Sandholm and Amos (2018) report. Unsafe search is still more
exploitable than the blueprint it starts from in this small game. A control
makes the cause visible: the equilibrium itself (exploitability 1.98e-4)
with every round-2 subgame unsafely re-solved from its own beliefs goes to
0.0886, although each re-solved subgame keeps the equilibrium's value. That
is the known weakness of unsafe re-solving (Brown and Sandholm 2017), and it
is why PLAN.md 2.1 item 6 schedules safe re-solving after the first turn
subgame.

## Measurements on the overnight checkpoint

Checkpoint: a copy of `~/.gpo/overnight/ckpt.bin` at iteration 915,307,849
(small tree, 200/200/200 buckets). The Mac was shared with the training job
(6 threads) and other agents during every run below; `uptime` showed load
averages between 63 and 91 on 11 cores, so wall times are pessimistic.

Spot: board Qs 7h 2d (9c, 3s), line `r1 c` then checks, hero Qh Jh, DCFR
(1.5, 0.5, 2). Command: `bin/bp search ... --max-iters N --budget-ms 600000
--threads T`, run 04:43 to 04:44 PDT at load averages 39 to 69. CPU time is
summed over threads; exploitability is inside the subgame model.

| street | combos per side | subgame nodes | threads | iterations | setup s | solve s (wall) | CPU ms per iteration | exploitability, % of pot |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| river | 1,081 / 1,081 | 57 | 1 | 200 | 0.001 | 0.181 | 0.88 | 0.245 |
| river | 1,081 / 1,081 | 57 | 1 | 1,000 | 0.002 | 1.531 | 1.03 | 0.022 |
| turn to the end | 300 / 301 | 20,073 | 1 | 100 | 0.027 | 10.931 | 94.17 | 2.606 |
| turn to the end | 300 / 301 | 20,073 | 4 | 100 | 0.017 | 4.709 | 174.16 | 2.606 |
| flop, k = 4, 9 leaves, 24 rollouts | 120 / 121 | 57 | 1 | 500 | 3.339 | 0.811 | 1.33 | 0.026 |
| flop, k = 4, 9 leaves, 24 rollouts | 120 / 121 | 57 | 4 | 500 | 1.112 | 0.795 | 1.31 | 0.026 |

The flop's setup is the leaf-value computation, which runs one leaf per
thread. The turn's 48 river branches run on parallel threads, which cut
wall time 2.3x on 4 threads under this load. On the 20 TS spots the C++
solver took 76.5 ms in total for the 10 river spots and 60.7 ms for the 10
turn spots (`bp subgame`, 04:47 PDT); the TS solver took 770 ms and 435 ms
when the spots were exported (04:25 PDT, heavier load), so that ratio is
indicative only.

Algorithm choice on the same river spot (1,081 combos per side,
`bp search --max-iters N --algo ...`), exploitability as % of the pot:

| algorithm | 50 iterations | 200 | 1,000 |
| --- | ---: | ---: | ---: |
| DCFR alpha 1.5, beta 0.5, gamma 2 (default, the TS solver's) | 2.018 | 0.245 | 0.022 |
| DCFR alpha 1.5, beta 0, gamma 2 (the DCFR paper's) | 2.384 | 0.264 | 0.023 |
| CFR+, linear averaging from iteration 1 | 5.852 | 0.840 | 0.094 |

Head-to-head: blueprint plus search on one street against the pure
blueprint, duplicate deals (`bp search-h2h`). Both agents play the blueprint
before the searched street, so on a given deal and action-sample stream they
reach the same spot at its start. There the searcher solves the round from
its start and keeps that plan for the round; later streets are blueprint.
Each hand's value is the exact EV of the rest of the hand with the deal's
cards fixed, searcher's plan minus blueprint against blueprint from the same
spot, and 0 for hands that end earlier. Since blueprint against itself is
worth exactly 0 over both seats of a deal, this is an unbiased estimate of
the searcher's win rate with the action-sampling noise from that street on
removed. On the flop both k values run on the same deals, so their
difference is paired.

River search, 1,081 combos per side:

| run | DCFR iterations | duplicate deals | river searches | result, mbb/hand | 95% CI |
| --- | ---: | ---: | ---: | ---: | ---: |
| `--seed 11` | 100 | 8,000 | 5,737 | +119.0 | +/- 68.2 |
| `--seed 12` | 100 | 8,000 | 5,720 | +141.2 | +/- 68.9 |
| both seeds pooled (derived: mean of the two, CI sqrt(68.2^2 + 68.9^2) / 2) | 100 | 16,000 | 11,457 | +130.1 | +/- 48.5 |
| `--seed 11` (same deals as the first row) | 300 | 8,000 | 5,737 | +122.0 | +/- 72.4 |
| control, `--iters 1 --hands 1000 --seed 5` (one iteration, so the river is played uniformly) | 1 | 1,000 | 692 | -740.3 | +/- 387.3 |

Flop search (depth-limited, 80 combos per side, 16 rollouts per leaf, 300
DCFR iterations, `--seed 21`, 700 duplicate deals, 891 flop searches, 1.53 s
of thread time per search for both k values):

| leaves | result, mbb/hand | 95% CI |
| --- | ---: | ---: |
| k = 1 (blueprint continuation only) | -27.1 | +/- 346.5 |
| k = 4 (blueprint, fold, call and raise biased by 5) | -103.6 | +/- 349.8 |
| paired difference, k = 4 minus k = 1 | -76.5 | +/- 237.0 |

River search beats the blueprint at 95% confidence in both seeds; 300
iterations did not change the result measurably on the same deals. The flop
runs are too short to separate anything: every interval covers zero, and the
flop needs several thousand deals (hours of CPU at this speed) before the
Modicum ladder in PLAN.md M5 can be tested. All of this is against the
blueprint only. It says nothing about exploitability, which the Leduc table
shows unsafe search can raise.

## Not done

* The PLAN.md M4 comparison against noambrown/poker_solver or
  postflop-solver on 50 river and 20 turn spots, and timings on 8 cores.
* Off-tree sizes on the flop (the depth-limit leaves need a blueprint node
  after the action; translation to the nearest size is the usual fix) and
  in earlier rounds than the current one (beliefs need an on-tree history).
* The search uses the blueprint's own sizes for its own bets; Pluribus also
  adds sizes for the searcher.
* Preflop search and the preflop translation cache.
* Safe re-solving (Resolve, Reach-Resolve, the Coin Toss checks) and the
  Modicum CFR+ schedule tweaks.
* Turn solves at 300 combos per side converge slowly (see the timing
  table); the next speedups are float storage, reusing the sweep's totals,
  and suit isomorphism over the 48 river children.
