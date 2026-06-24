# Depth-Limited Postflop CFR Solver

`src/core/solver/postflop-cfr.ts` is a genuine, real-time counterfactual-regret-
minimization (CFR) solver for the current postflop decision. It runs on the main
thread under a hard time/iteration budget and is wired into the live decision
engine (`src/core/engine.ts`) with a graceful fallback to the existing heuristic.

It is distinct from `src/core/solver/postflop-solver.ts`, which is a WASM adapter
for an external (un-vendored) Rust solver. The module here is pure TypeScript and
always available.

## What it solves

The current decision is modelled as a two-player extensive-form **subgame**:
hero's range vs an estimated villain range on the **actual board**, given the
live pot and effective stack. We run regret-matching+ CFR over this subgame and
return the converged **average** strategy for hero's actual hand.

## Depth limit + leaf valuation (the key idea)

We build the betting tree for the **current street only**. Instead of recursing
into future board cards, every terminal of the betting line is valued with an
**exact equity computation** from the perfect-hash evaluator:

- **Fold leaf** — the non-folder wins the current pot.
- **Showdown leaf** (chips matched) — equity-weighted: hero's net is
  `equityShare * pot - heroCommitted`, summed over the villain range.

Showdown equity is computed:

- **River** (0 cards to come): exact comparison.
- **Turn** (1 to come): exact enumeration of all river cards.
- **Flop** (2 to come): deterministic seeded sampling (bounded) to stay in
  budget.

This equity-leaf, single-street approach is the standard tractable real-time
method (cf. Brown, Sandholm & Amos 2018, *Depth-Limited Solving for
Imperfect-Information Games*; Brown & Sandholm 2019, Pluribus). It is honest CFR
— regret matching over a real game tree — not heuristics.

## Action abstraction

Kept deliberately small for tractability: `fold / check / call / bet-or-raise`
at a small set of pot fractions (default **33%** and **75%** pot) plus an
**all-in** size. Raises are capped (one raise then call/all-in) to bound the
tree.

All-in is offered as a size **only when SPR ≤ 2.5** (or when the stack is too
shallow for any pot-fraction size). With deep stacks and cards still to come, a
single-street depth-limited leaf over-realizes shove equity, so unconditionally
offering all-in collapses the strategy onto shoving; the SPR gate keeps the
abstraction honest.

## Ranges

When explicit ranges are not passed in, a reasonable wide single-raised-pot
continuing range is generated (all pairs, suited broadways/connectors, strong
offsuit broadways) as concrete board-consistent combos. Hero's exact hand is
always included. Villain combos are filtered against the board and
deterministically capped (default 60) for speed.

## Budget

`solvePostflop(input)` takes both `maxIterations` (default 300) and
`timeBudgetMs` (default 200). The CFR loop stops at whichever limit is hit first
and returns the average strategy so far, so it can never hang the UI. The
seeded RNG (`src/solver/rng.ts`) makes every solve deterministic.

Measured: ~110–210 ms per decision at the default budget on a dry flop with the
default ranges (deep stack), well within a live time budget.

## Engine integration + fallback

`DecisionEngine.decidePostflop` calls `decidePostflopFromSolver` first. On
success it builds the `BotDecision` from the solved distribution — the solved
`mixedStrategy` is attached verbatim (so the executor samples the equilibrium
mix) and `action`/`amount` are the argmax for display. On **any** error,
timeout, or unsupported spot (e.g. a non-3-to-5-card board) it returns `null`
and the engine falls back to `decidePostflopHeuristic`, the original heuristic
logic, which is retained unchanged.

## Tests

`tests/solver/postflop-cfr.test.ts` (Vitest, deterministic via the seeded RNG):
valid distribution; nuts bet/raise at high frequency vs a capped range; air
mixes (not 100% bluff); monotonicity (stronger hand bets/raises more);
iteration- and time-budget respected; strong hand doesn't fold facing a bet;
determinism under a fixed seed.
