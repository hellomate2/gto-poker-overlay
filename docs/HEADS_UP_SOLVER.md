# Heads-Up Postflop Solver (WASM)

This project integrates a **real, open-source heads-up (2-player) postflop
No-Limit Hold'em CFR solver** rather than rolling its own. It reuses
[`b-inary/postflop-solver`](https://github.com/b-inary/postflop-solver) — "an
efficient open-source postflop solver library written in Rust" — together with
its web frontend [`b-inary/wasm-postflop`](https://github.com/b-inary/wasm-postflop),
which compiles the solver to WebAssembly so a full postflop CFR solve runs in
the browser.

## What it does

Given an out-of-position (OOP) range, an in-position (IP) range, a 3-5 card
board, a starting pot, and an effective stack, the solver runs
Counterfactual Regret Minimization (CFR) to approximate a Nash-equilibrium
(GTO) strategy for the heads-up subgame, then reports the range-weighted action
frequencies for the root decision. It is a genuine equilibrium solver, distinct
from this project's lightweight in-house `MCCFRSolver` (`src/core/cfr/`).

## License — IMPORTANT

`b-inary/postflop-solver` and `b-inary/wasm-postflop` are licensed under the
**GNU Affero General Public License v3.0 (AGPL-3.0)**.

The AGPL is a strong copyleft license with a **network clause**: if you run a
modified version of AGPL software and let users interact with it over a network,
you must offer those users the corresponding source code. Bundling its WASM into
a distributed application brings your distribution under AGPL obligations.

For this reason the compiled WASM is **NOT** checked into this repository. You
build it yourself and vendor it locally into `vendor/postflop-solver/`. Review
the AGPL terms and your own distribution model before shipping it.

> Status note: upstream `postflop-solver` development was suspended in October
> 2023, but the code still builds and runs.

## Is it prebuilt here?

**No.** As of this writing the Rust → WASM toolchain (`rustc`, `cargo`,
`wasm-pack`, `rustup`) is **not installed** in this environment, so the WASM was
**not** prebuilt. The `vendor/postflop-solver/` directory is a placeholder. The
TypeScript adapter (`src/core/solver/postflop-solver.ts`) is written so the
project still type-checks and `npm run build` still succeeds without the WASM;
it throws a clear, actionable error at `PostflopSolver.load()` time if the WASM
is missing.

## Build it yourself

### 1. Install the Rust toolchain

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup toolchain install nightly       # wasm-postflop builds with nightly
cargo install wasm-pack
```

### 2. Clone the web frontend (which wraps the solver in wasm crates)

```sh
git clone https://github.com/b-inary/wasm-postflop /tmp/wasm-postflop
cd /tmp/wasm-postflop
npm install
```

`wasm-postflop` wraps `postflop-solver` in small binding crates under `rust/`:
`rust/range` (exports `RangeManager`), `rust/tree`, `rust/solver-st`
(single-threaded, exports `GameManager`), and `rust/solver-mt` (multi-threaded).

### 3. Build the single-threaded solver + the range parser

We use the **single-threaded** (`solver-st`) target — it needs no
cross-origin-isolation / SharedArrayBuffer headers and is the simplest to embed
in a Chrome extension. The exact upstream commands (from wasm-postflop's
`package.json`) are:

```sh
# Range parser (provides RangeManager / from_string / raw_data)
rustup run nightly wasm-pack build --out-dir ../../pkg/range rust/range

# Single-threaded solver (provides GameManager)
rustup run nightly wasm-pack build --target web --out-dir ../../pkg/solver-st rust/solver-st
```

These produce, relative to the wasm-postflop repo root:

```
pkg/range/      -> range.js, range_bg.wasm, ...
pkg/solver-st/  -> solver_st.js (or similar), *_bg.wasm, ...
```

### 4. Vendor the artifacts into this project

Copy the two wasm-pack packages into `vendor/postflop-solver/`. The adapter
expects the solver shim at `postflop_solver.js` and the range shim at
`range.js`:

```sh
DEST=/Users/devlakhani/poker/vendor/postflop-solver
mkdir -p "$DEST"

# Solver (rename the shim/wasm to postflop_solver.*):
cp /tmp/wasm-postflop/pkg/solver-st/*.wasm "$DEST/postflop_solver_bg.wasm"
cp /tmp/wasm-postflop/pkg/solver-st/*.js   "$DEST/postflop_solver.js"

# Range parser:
cp /tmp/wasm-postflop/pkg/range/*          "$DEST/"
```

> If the wasm-pack shim's filenames differ, either rename them to
> `postflop_solver.js` / `range.js` or edit the `VENDOR_SOLVER_SPECIFIER` /
> `VENDOR_RANGE_SPECIFIER` constants at the top of
> `src/core/solver/postflop-solver.ts`. If you build a single combined module
> that exports both `GameManager` and `RangeManager`, only the solver shim is
> needed — the adapter skips the separate range import automatically.

After vendoring, `PostflopSolver.load()` will succeed and `WASM_AVAILABLE`
flips to `true`.

## Final destination

```
vendor/postflop-solver/
  postflop_solver.js        # solver shim (default init + GameManager)
  postflop_solver_bg.wasm   # compiled solver
  range.js                  # range-parser shim (RangeManager)
  range_bg.wasm             # compiled range parser
```

## TypeScript usage

### Direct (main thread)

```ts
import { PostflopSolver, WASM_AVAILABLE } from './core/solver/postflop-solver';

async function run() {
  // Throws PostflopSolverUnavailableError with build instructions if the
  // WASM isn't vendored yet.
  const solver = await PostflopSolver.load();
  console.log('WASM available:', WASM_AVAILABLE); // true

  const result = await solver.solve(
    {
      oopRange: 'AA,KK,QQ,AKs,AKo',
      ipRange: 'AA-22,AKs-A2s,KQs,AKo-AJo',
      board: 'Ah Kd 7c',          // also accepts "AhKd7c" or "Ah,Kd,7c"
      startingPot: 100,
      effectiveStack: 900,
      betSizes: { oopFlopBet: '33%,75%', ipFlopBet: '50%' },
    },
    {
      maxIterations: 500,
      targetExploitability: 0.005, // stop at 0.5% of the pot
      onProgress: (it, expl) => console.log(`iter ${it}, expl ${expl}`),
    },
  );

  console.log('exploitability (pot fraction):', result.exploitability);
  console.log('iterations:', result.iterations);
  for (const a of result.strategy.actions) {
    console.log(`${a.action}: ${(a.frequency * 100).toFixed(1)}%`);
  }
  // e.g. -> Check: 62.0%   Bet 33: 21.5%   Bet 75: 16.5%
}
```

### Off the main thread (Web Worker)

`src/workers/postflop-worker.ts` exposes the solver over a typed `postMessage`
protocol. It lazy-loads the adapter (and therefore the WASM) on the first
`solve` request.

```ts
import type {
  PostflopWorkerResponse,
} from './workers/postflop-worker';

const worker = new Worker(
  new URL('./workers/postflop-worker.ts', import.meta.url),
  { type: 'module' },
);

worker.onmessage = (e: MessageEvent<PostflopWorkerResponse>) => {
  const msg = e.data;
  if (msg.type === 'solve_progress') {
    console.log(`iter ${msg.iteration}, expl ${msg.exploitability}`);
  } else if (msg.type === 'solve_result') {
    console.log(msg.result.strategy.actions);
  } else if (msg.type === 'solve_error') {
    console.error(msg.error);
  }
};

worker.postMessage({
  type: 'solve',
  id: 'spot-1',
  spot: {
    oopRange: 'AA,KK,QQ',
    ipRange: 'AA-22,AKs-A2s',
    board: 'Ah Kd 7c',
    startingPot: 100,
    effectiveStack: 900,
  },
  opts: { maxIterations: 500, targetExploitability: 0.005 },
});
```

To bundle the worker as its own asset, add it to `webpack.config.js` `entry`
(e.g. `'postflop-worker': './src/workers/postflop-worker.ts'`) or rely on
webpack 5's `new Worker(new URL(...))` worker detection.

## Card / range / board encoding (reference)

- **Cards** encode as `4 * rank + suit`, with rank `0=2 .. 12=A` and suit
  `0=c, 1=d, 2=h, 3=s`. The adapter's `parseCard` / `parseBoard` helpers handle
  this; you pass human strings like `"Ah Kd 7c"`.
- **Ranges** are 1326-combo `f32` arrays. The adapter builds these from human
  range strings (`"AA,KK,AKs:0.5"`) via the WASM `RangeManager.from_string` →
  `raw_data()`.
- **Bet sizes** are comma-separated strings of pot-relative percentages and/or
  absolute amounts, e.g. `"33%,75%,150%"`.

> Note: this encoding (suit order `c,d,h,s`) differs from the project's own
> `CardId` encoding in `src/types/poker.ts` (suit order `h,d,c,s`). The adapter
> parses human strings directly into the solver's encoding, so you never need to
> convert `CardId`s by hand.
