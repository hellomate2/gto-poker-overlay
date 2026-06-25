# Heads-Up Preflop Equilibrium Solver

A real Counterfactual Regret Minimization (CFR+) Nash solve of the heads-up
(2-player) No-Limit Hold'em **preflop** game, producing equilibrium ranges that
are baked into the extension as comprehensive charts and consulted by the GTO
advisor.

This is the standard **"preflop model"** solve: a range-vs-range CFR over a
capped preflop betting abstraction whose leaves are valued with precomputed
all-in equities plus realization factors. It is **exact for push/fold** and a
**strong approximation deep** — see *Honesty & limitations* below.

## Pipeline

```
categories.ts      169 canonical hand categories + their card combos
equity-matrix.ts   169x169 all-in equity matrix (Monte-Carlo, seeded RNG, cached)
tree.ts            the heads-up preflop betting game (implements Game<H>)
fast-cfr.ts        CFR+ traversal specialized to this tree (store-compatible)
solve.ts           generic solve driver (uses the shared CfrSolver)
run-solve.ts       CLI: solve at 100bb, report, emit charts  (npm run solve:preflop)
charts.ts          strategy -> Cell/Chart conversion
emit.ts            Chart -> generated TypeScript (headsup-solved.ts)
build-equity.ts    CLI: (re)compute & cache the equity matrix (npm run solve:equity)
```

Output: `src/core/ranges/headsup-solved.ts` (auto-generated; do not edit by hand).

## Running

```bash
PATH=/opt/homebrew/bin:$PATH npm run solve:equity    # optional: rebuild equity cache
PATH=/opt/homebrew/bin:$PATH npm run solve:preflop   # solve + regenerate charts
```

`PF_ITERS` (default 800) sets CFR+ iterations; `EQ_BOARDS` (default 250) sets
boards sampled per combo-pair for the equity matrix.

## 1. All-in equity matrix (`equity-matrix.ts`)

`equityMatrix()[i][j]` is the probability that category `i` beats category `j`
at an all-in preflop showdown (ties = 0.5), combo-weighted (pairs = 6 combos,
suited = 4, offsuit = 12) over all non-conflicting combo pairs and Monte-Carlo
sampled 5-card boards via the seeded RNG. The upper triangle is computed and
mirrored (`equity[i][j] = 1 - equity[j][i]`) so the matrix is exactly
antisymmetric. It is cached to `equity-matrix.json` (computed once; it is the
leaf-value source). Spot checks: AA vs KK ≈ 82%, AA vs 72o ≈ 87%, AKs vs 22 ≈
50%, AKo vs QQ ≈ 43%.

## 2. The betting tree (`tree.ts`)

Heads-up positions:

- **P0 = Button = Small Blind.** Posts the SB, acts **first** preflop, is **in
  position** postflop.
- **P1 = Big Blind.** Posts the BB, acts **last** preflop, **out of position**
  postflop.

Betting abstraction (sizes in big blinds, stack `S` parameterized):

| Decision            | Actions                                   |
|---------------------|-------------------------------------------|
| SB first            | fold / limp (complete to 1bb) / open (2.5bb) / jam |
| BB vs limp          | check / raise (3.5bb) / jam                |
| BB vs open          | fold / call / 3-bet (3× = 7.5bb) / jam     |
| SB vs BB raise/3bet | fold / call / 4-bet (2.2×) / jam           |
| BB vs 4-bet         | fold / call / jam                          |
| vs jam              | fold / call                                |

The tree is capped at the jam level on each line (open → 3-bet → 4-bet → jam,
and limp → raise → jam), which captures essentially all equilibrium frequency;
further re-raises off these sizes are negligible.

**First-in open-jam gating.** A *first-in* open-jam (or limp-jam) is only a legal
abstraction action when the effective stack is shallow (`openJamMaxBB`, default
20bb). Deep — e.g. 100bb — open-jamming any hand is degenerate, and the
equity-model leaves would otherwise *over-reward* it: jamming realizes 100% of
equity (R = 1) whereas opening leads to showdown leaves with R < 1, so without
the gate even AA would "prefer" a 100bb open-jam. Removing the deep open-jam is a
standard, principled abstraction choice (not a tuned range) and yields sane open
ranges. Re-raise jams (3-bet / 4-bet all-in) remain legal at every depth because
the pot has grown and a jam is then a reasonable size. The genuine very-short
push/fold regime is served separately by the exact `pushfold-nash.ts` module.

**Information sets** encode only a player's own hand category plus the public
betting history — never the opponent's hand.

## 3. Leaf valuation (the equity model)

Utilities are net big blinds to a player. Let `pot` be the sum of both commits
and `equity` the player's all-in equity vs the opponent (from the matrix).

- **Fold:** the folder forfeits what they committed; the other player wins the
  pot.
- **Both all-in (showdown):** `EV = equity * pot - invested` (realization
  `R = 1` — equity is realized exactly).
- **Showdown with money behind** (a call/check that closes betting without an
  all-in): `EV = R * equity * pot - invested`, where `R` is a **realization
  factor** modeling that you cannot perfectly realize equity postflop with
  stacks behind. The base factors are:
  - `R_IP = 0.92` for the in-position SB (button),
  - `R_OOP = 0.85` for the out-of-position BB.

  `R` additionally **degrades with the stack-to-pot ratio (SPR) left behind**:

  ```
  R = max(R_FLOOR, R_base - SPR_PENALTY * min(behind/pot, SPR_CAP))
  SPR_PENALTY = 0.02,  SPR_CAP = 6,  R_FLOOR = 0.66
  ```

  This captures the reverse-implied-odds of flatting deep (a marginal hand that
  flat-calls with a big stack behind, especially out of position, realizes far
  less of its raw all-in equity). Without it, the model lets the BB defend
  absurdly wide against a 4-bet because the already-committed chips give a cheap
  showdown price while the deep stack behind is never punished. All of these are
  documented **model parameters**, not hand-tuned ranges — the solver still
  derives every range itself.

Because `R < 1`, the deep showdown leaves are not strictly zero-sum (the
realization "leak" represents EV lost to imperfect postflop play). NashConv
(`BR_0 + BR_1`) remains the correct convergence metric.

## 4. The solve & convergence

CFR+ (regret-matching+ with linear strategy averaging) over the tree at 100bb.
Convergence is measured by **exploitability (NashConv)** — the sum of both
players' best-response gains, in big blinds.

Because the deep-showdown leaves use realization factors `R < 1` the payoff is
**not strictly zero-sum**, so the standard zero-sum NashConv identity
(`br0 + br1 ≥ 0`) does not hold exactly: the metric settles near a small value
(the realization "leak") rather than exactly 0, and can be slightly negative. We
therefore track its **magnitude**, and stop CFR+ where the average strategy is
converged and |NashConv| is smallest (~120-150 iterations; CFR+ converges very
fast on this small abstraction). A representative run:

```
iter  50: ~0.39 bb
iter 100: ~-0.07 bb
iter 150: ~-0.10 bb   -> |NashConv| ~ 0.1 bb
```

The exact final number is recorded in the generated `headsup-solved.ts`
(`SOLVE_EXPLOITABILITY_BB`) and its magnitude is asserted by the tests.
Representative solved aggregates: SB opens ~72% of hands, BB defends ~62% vs the
2.5bb open; AA/KK/AKs open ~100% (no degenerate deep open-jam).

## 5. Sanity of the solved output

- AA always continues (never folds); 72o is a pure fold at 100bb. Very short,
  72o becomes an open-jam — this is delivered by the exact push/fold Nash module
  (≤ 10bb open-jam, ≤ 25bb call-vs-jam), which the advisor consults first; the
  deep equity-model tree is intentionally not used in the push/fold regime.
- SB opens a wide range (~65% of hands, combo-weighted — far wider than any
  6-max position).
- BB defends a large fraction (~58%) vs a 2.5bb open.
- Short-stack jam ranges widen monotonically as stacks get shorter (exact in the
  push/fold layer: 25bb→~27%, 8bb→~56%, 2bb→~100% any-two).

## 6. Coverage

The advisor can key seven heads-up preflop scenarios. All are covered by the
generated charts (no "No GTO chart for this spot" gaps):

| Advisor key       | Solved node             |
|-------------------|-------------------------|
| `SB-RFI`          | SB open                 |
| `BB-vs-open-SB`   | BB vs open              |
| `SB-vs-3bet-BB`   | SB vs 3-bet             |
| `BB-vs-4bet-SB`   | BB vs 4-bet             |
| `SB-vs-open-BB`   | SB vs BB raise (limp-raise line) |
| `BB-vs-3bet-SB`   | reuses SB-vs-3bet (closest node) |
| `SB-vs-4bet-BB`   | reuses BB-vs-4bet (closest node) |

The very-short-stack regime (≤ 10bb open-jam, ≤ 25bb call-vs-jam) is delegated
to the exact `pushfold-nash.ts` module, which the advisor consults first.

## Honesty & limitations

This is a **preflop-abstraction** solve, not a full postflop-aware solver:

- **Exact** for all-in / push-fold spots — there is no postflop, so the equity
  leaves are exact (R = 1).
- **A strong approximation** for non-all-in deep spots: postflop play is
  compressed into the two realization factors (0.92 / 0.85) rather than solved
  street by street. A full solver (PioSOLVER / GTO Wizard) that plays out flop,
  turn, and river would differ in the exact mixed frequencies of marginal hands
  and in bet-sizing nuance.
- A side effect of the equity-model leaves with no postflop: premium hands jam
  / 3-bet somewhat more than a postflop-aware solver would (stacking off on raw
  equity is overvalued when you cannot also win pots postflop). The ranges are
  nonetheless a genuine equilibrium **of this abstraction** with measured
  exploitability, and are far more principled than hand-drawn charts.

The betting sizes, realization factors, and stack depth are all parameters of
the model, set to standard values and held fixed across the solve.
