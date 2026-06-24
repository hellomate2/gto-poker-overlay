# GTO Trainer

A standalone study tool that drills you on game-theory-optimal poker decisions
and grades you against a real solver. **It's a trainer — it does not connect to
any poker site, give live in-game advice, or play for you.**

## What it does
- **Preflop · RFI** — deals you a hand and position; you open-raise or fold, and
  it grades you against the GTO opening charts (`src/core/ranges/preflop.ts`).
  Preflop isn't solved live — the charts *are* the GTO solution — so grading is exact.
- **Preflop · 3-Bet** — same idea for 3-bet/defend spots.
- **Postflop · Solver** — deals you a hand in a solved spot; you pick an action and
  it grades you against the **TexasSolver** mixed strategy and shows the full mix.
- Tracks your GTO score, streak, and recent leaks for the session, and shows the
  full range grid for every preflop spot with your hand highlighted.

## Run it
```bash
npm run build
# then open dist/trainer.html  (or serve dist/ and visit /trainer.html)
```

## Postflop = real solver output
The postflop mode ships with one **illustrative sample** spot so it's playable
immediately. To train on **real** solves, generate them with TexasSolver:

```bash
# 1. download the console binary from
#    https://github.com/bupticybee/TexasSolver/releases
# 2. describe a spot (copy solver/example_spot.json)
# 3. solve it:
node solver/solve.mjs solver/example_spot.json --solver /path/to/console_solver
# 4. rebuild — the new spot is auto-included
npm run build
```

See `solver/README.md` for details.

## Layout
- `src/trainer/` — the trainer app (preflop + postflop, UI, grading)
- `src/core/ranges/preflop.ts` — GTO preflop charts (reused from the engine)
- `solver/solve.mjs` — TexasSolver adapter (spot config → solved JSON)
- `src/trainer/spots/` — generated solves land here and are auto-loaded
