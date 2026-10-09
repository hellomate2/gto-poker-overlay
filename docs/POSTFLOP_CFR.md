# Real-Time Postflop Subgame Solver

Two files:

- `src/core/solver/postflop-cfr.ts` holds the solver core: the betting-tree
  builder, the showdown equity matrix, and `RangeVsRangeCfr` (range-vs-range
  Discounted CFR with a best-response exploitability measure). It also keeps the
  older `solvePostflop()` entry point, now running on the new core.
- `src/core/solver/subgame.ts` holds `solveSubgame()`, the entry point for the
  live engine. It takes the shared `WeightedRange` type from
  `src/core/ranges/weighted-range.ts` for both players, solves under a wall-clock
  budget, and returns hero's strategy for the exact hand held, plus helpers to
  decide when to solve (`subgameEligibility`) and to pick an action
  (`pickSubgameAction`).

`src/core/solver/postflop-solver.ts` is unrelated: a WASM adapter for an
external solver that is not vendored.

## What it solves

The current street, heads-up, as a two-player game: hero's range vs villain's
range on the actual board, with the live pot, effective stack, position and any
bet hero is facing. The returned strategy is the converged average strategy for
the one combo hero holds.

## Why the old solver was disconnected, and what changed

The old solver value-bet hands like two pair on a flush-completing river. The
villain range it was fed was unrealistic, but the solver had its own defects
too, and those are fixed here:

1. Villain's information sets ignored villain's cards. Every villain combo shared
   one strategy, so villain could not fold its weak hands and continue with its
   strong ones. Now each combo of each player has its own regrets.
2. Card-conflicting matchups (hero and villain holding the same card) were scored
   as ties. They now get zero weight.
3. Position was ignored: hero always acted first, and a hero check always gave
   villain a turn to bet. Now hero in position with no bet to face means villain
   already checked, so a hero check ends the street.
4. Range weights only scaled villain's starting reach. Both ranges now enter as
   chance reach: the probability of the pair (i, j) is proportional to
   `w_hero[i] * w_villain[j]` when the combos share no card, and 0 otherwise.

## Algorithm

Vectorized CFR over the public betting tree. Each iteration traverses the tree
once per player (alternating updates). The traversal carries the opponent's
reach as a vector over the opponent's range and returns the traverser's
counterfactual values as a vector over its own range. Leaves cost one
matrix-vector product (showdown) or an O(N) card-removal sum (fold).

Updates follow Discounted CFR (Brown and Sandholm 2019) with alpha = 1.5,
beta = 0.5, gamma = 2.

Exploitability is measured by a best-response pass for each player against the
other's average strategy:
`NashConv = BR(hero) + BR(villain) - startingPot` (the game is constant-sum: the
two payoffs add up to the starting pot at every leaf), and the reported number is
`NashConv / 2` as a percentage of the pot. It measures distance from equilibrium
inside the abstraction, for the ranges given. It says nothing about whether those
ranges are right.

## Depth limit and leaf values

Only the current street's betting is modelled. When the street's betting ends
with chips matched, the leaf is an all-in equity showdown over the remaining
cards:

- River: one comparison per pair.
- Turn: exact average over every river card.
- Flop: average over sampled (turn, river) runouts (300 by default in
  `solveSubgame`; a flop has 1176).

Each runout evaluates every combo once, then compares all pairs, so the cost is
`runouts * (H + V)` evaluations.

The turn and flop leaves assume the hand checks down after this street, which
overstates how much equity a hand realizes, most of all with deep stacks. That is
why all-in is gated on SPR before the river, why the engine helper caps turn SPR,
and why flop solves are off unless the caller opts in.

## Action abstraction (defaults, per street)

| | River | Turn | Flop |
|---|---|---|---|
| Bet sizes (pot fraction) | 0.33, 0.75, 1.25 | 0.33, 0.75, 1.25 | 0.33, 0.75 |
| Raise size | call, then add 0.7 of the pot after the call | same | same |
| All-in offered when stack behind / pot after call is at most | 4 | 2.5 | 2.5 |
| Bets plus raises per street | 3 | 3 | 3 |

The third aggressive action (a re-raise) is all-in only. A size that would put in
80% or more of the remaining stack becomes all-in. Raises respect the no-limit
min-raise rule. All of it can be overridden through `abstraction`.

## Chip conventions for `solveSubgame`

- `pot`: every chip in the middle now, including all of this street's bets (so
  including the bet hero faces).
- `toCall`: chips hero must add to call.
- `effectiveStack`: chips hero can still add from now, capped by what villain can
  match: `min(heroStack, villainStack + toCall)`.
- `heroStreetCommitted`: chips hero already put in on this street. Used only to
  report `raiseTo` street totals, which is the convention of `BotDecision.amount`
  and `mixedStrategy.bets` in the engine.

Ranges: only the board is removed. Villain combos that share a card with hero's
actual hand stay in the solve, because villain's strategy has to be computed
against hero's whole range. The solver already gives conflicting pairs zero
weight, so hero's own hand is never valued against a combo it blocks. Each side
is capped at 200 combos (120 on the flop) by `reduceRange`, which thins the
range without changing its composition. It picks a threshold tau so that the
expected number of kept combos equals the cap. Combos at or above tau keep
their weight. A combo below tau is kept with probability weight / tau and then
weighs tau, so every combo's expected kept weight equals its original weight.
The small combos are drawn by systematic sampling (fixed offset, no RNG) along
an order sorted by made-hand strength on the board, so each strength band keeps
its share of the weight to within one combo of weight tau.

The cap used to keep the 200 highest weights. A tracker range narrowed by
villain's bets carries its value hands at high weight and its bluffs and draws
at low weight, so that cut removed the bluffs and the solver over-folded. On a
turn spot (Kd 7h 2s Qc, villain bets 150 into 240, 1128 tracked villain combos)
the old cap folded 99.8% of hero's range and A7 with a call EV of -93 chips.
With `reduceRange` the range folds 9.6% and A7 calls at +108, against 7.8% and
+109 for the same solve with no cap (tests/solver/subgame-reduce.test.ts).
If hero's exact hand is missing from hero's range it is added with a negligible
weight. A combo's regrets depend only on the opponent's reach, so its own weight
does not change its strategy.

## Budget and early stop

The default budget is 1500 ms, covering precompute, iterations and the final
exploitability pass. Exploitability is checked every 10 iterations and the solve
stops once it reaches `targetExploitabilityPct` (default 0.3% of the pot);
`converged` reports whether it got there. On the timing spots in
`tests/solver/subgame.test.ts`, early stopping kicks in well before the budget.
The test log prints the measured times.

## Tests

`tests/solver/subgame.test.ts`:

- The classic river toy game (polar nuts-plus-air range vs a pure bluff-catcher)
  at bet sizes 0.5, 1 and 2 pot reproduces the textbook equilibrium: bluffs are
  `s/(1+2s)` of the betting range (a bluff:value ratio of `s/(1+s)`), and the
  caller calls `1/(1+s)`. The derivation is in the test file.
- Exploitability falls with iterations (checked on a 40-point trace) and ends
  below 1% of the pot on river spots within the default budget.
- Top two pair on a flush-completing river against a flush-heavy range never
  value-bets (OOP, IP when checked to) and never raises facing a bet. A control
  on a brick river shows the same hand does bet there.
- Timing for turn and river with 100 and 200 combos per side.
- Tree semantics (position, sizes, min-raise, SPR gating), the street-total amount
  convention, card removal, exact turn equity, weight sensitivity, input
  validation, flop within budget, determinism, and the engine helpers.

`tests/solver/postflop-cfr.test.ts` covers the legacy `solvePostflop()` API.
