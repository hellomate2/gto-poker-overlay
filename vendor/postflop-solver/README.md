# vendor/postflop-solver

This directory is the drop-zone for the locally-built WebAssembly artifact of
[b-inary/postflop-solver](https://github.com/b-inary/postflop-solver) (AGPL-3.0),
built via its web frontend [b-inary/wasm-postflop](https://github.com/b-inary/wasm-postflop).

The WASM is **not** checked in (it is a large generated binary and is
license-encumbered). You build it yourself and copy the output here.

After building, this directory should contain at least:

```
vendor/postflop-solver/
  postflop_solver.js        # wasm-pack JS shim (default init + GameManager + ...)
  postflop_solver_bg.wasm   # the compiled solver
  ...                       # any other files wasm-pack emits
```

The TypeScript adapter at `src/core/solver/postflop-solver.ts` dynamically
imports `./postflop_solver.js` from here at runtime.

See `docs/HEADS_UP_SOLVER.md` for the exact build commands.
