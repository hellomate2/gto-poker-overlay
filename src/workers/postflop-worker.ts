// ============================================================
// Heads-Up Postflop Solver Web Worker
// ------------------------------------------------------------
// Runs the WASM postflop CFR solve off the main thread so the UI stays
// responsive. Mirrors the worker pattern used by the wasm-postflop frontend,
// but uses a simple typed postMessage protocol instead of Comlink.
//
// The worker lazy-loads the solver adapter (which in turn lazy-loads the
// vendored WASM). If the WASM is not vendored, a `solve_error` is posted back
// with the actionable build instructions.
//
// Build with webpack as its own entry (e.g. add to webpack.config.js entries),
// or instantiate via `new Worker(new URL('./postflop-worker.ts', import.meta.url))`.
// ============================================================

import type {
  PostflopSpot,
  SolveOptions,
  SolveResult,
} from '../core/solver/postflop-solver';

// ------------------------------------------------------------
// Message protocol
// ------------------------------------------------------------

/** Request: run a solve. `opts.onProgress` cannot cross the worker boundary,
 *  so progress is streamed back as `solve_progress` messages instead. */
export interface PostflopSolveRequest {
  type: 'solve';
  /** Caller-supplied id echoed back on every response for this request. */
  id: string;
  spot: PostflopSpot;
  /** Solve options minus the non-serializable `onProgress` callback. */
  opts?: Omit<SolveOptions, 'onProgress'>;
}

export type PostflopWorkerRequest = PostflopSolveRequest;

export interface PostflopReadyMessage {
  type: 'ready';
}
export interface PostflopProgressMessage {
  type: 'solve_progress';
  id: string;
  iteration: number;
  exploitability: number;
}
export interface PostflopResultMessage {
  type: 'solve_result';
  id: string;
  result: SolveResult;
}
export interface PostflopErrorMessage {
  type: 'solve_error';
  id: string;
  error: string;
}

export type PostflopWorkerResponse =
  | PostflopReadyMessage
  | PostflopProgressMessage
  | PostflopResultMessage
  | PostflopErrorMessage;

// ------------------------------------------------------------
// Worker implementation
// ------------------------------------------------------------

// Cache the loaded solver across requests in this worker instance.
let solverPromise: Promise<import('../core/solver/postflop-solver').PostflopSolver> | null = null;

async function getSolver() {
  if (!solverPromise) {
    // Dynamic import keeps the (potentially large) solver + WASM out of the
    // worker's startup path until the first solve is requested.
    const mod = await import('../core/solver/postflop-solver');
    solverPromise = mod.PostflopSolver.load();
  }
  return solverPromise;
}

function post(msg: PostflopWorkerResponse) {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = async (event: MessageEvent<PostflopWorkerRequest>) => {
  const msg = event.data;
  if (msg.type !== 'solve') return;

  const { id, spot, opts } = msg;
  try {
    const solver = await getSolver();
    const result = await solver.solve(spot, {
      ...opts,
      onProgress: (iteration, exploitability) =>
        post({ type: 'solve_progress', id, iteration, exploitability }),
    });
    post({ type: 'solve_result', id, result });
  } catch (err) {
    post({
      type: 'solve_error',
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

// Signal the worker is up and listening.
post({ type: 'ready' });
