# TexasSolver adapter

Generates **real GTO postflop solutions** for the trainer using
[TexasSolver](https://github.com/bupticybee/TexasSolver) (an open-source CFR solver).

Preflop in the trainer is graded against charts (the charts *are* the GTO
solution, so no solver is needed). Postflop is a real solve — that's what this
adapter is for.

## 1. Get the solver binary

Download the **console** build for macOS from the
[TexasSolver releases](https://github.com/bupticybee/TexasSolver/releases)
(look for the `console_solver` binary). Make it executable:

```bash
chmod +x /path/to/console_solver
```

## 2. Describe a spot

Copy `example_spot.json` and edit the board, ranges, pot, stacks, and bet sizes.
Ranges use standard notation (`22+,A2s+,KTo+,...`).

## 3. Solve it

```bash
node solver/solve.mjs solver/example_spot.json --solver /path/to/console_solver
# or: export TEXAS_SOLVER=/path/to/console_solver && node solver/solve.mjs solver/example_spot.json
```

This writes `src/trainer/spots/<id>.json`. Rebuild the trainer (`npm run build`)
and the new spot is automatically included in Postflop mode.

## Notes
- Solving takes seconds to minutes depending on `accuracy` / `maxIteration` /
  ranges. Lower `accuracy` and `maxIteration` for faster (less exact) solves.
- TexasSolver's dump schema can vary slightly between builds. If the adapter
  can't find a strategy node, open the generated `solver/_out_<id>.json` and
  adjust `findStrategyNode()` in `solve.mjs`.
- The bundled sample spot in `src/trainer/spots.ts` is hand-tuned for demoing
  the UI — replace it with real solves for study.
