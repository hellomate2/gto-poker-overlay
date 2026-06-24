// ============================================================
// Heads-Up Postflop Solver Adapter
// ------------------------------------------------------------
// Ergonomic, fully-typed TypeScript wrapper around the WebAssembly
// build of b-inary/postflop-solver (https://github.com/b-inary/postflop-solver,
// AGPL-3.0). The underlying solver runs a heads-up (2-player) postflop
// No-Limit Hold'em CFR solve entirely in the browser via WASM.
//
// The WASM artifact is NOT checked into this repository. It must be built
// locally with the Rust -> WASM toolchain and vendored into
//   vendor/postflop-solver/
// See docs/HEADS_UP_SOLVER.md for exact build commands.
//
// This module is written so that it always TYPE-CHECKS and COMPILES even
// when the vendored WASM is absent: the WASM is loaded lazily via a guarded
// dynamic import inside `load()`. If it is missing, `load()` throws a clear,
// actionable error telling the caller how to build it.
// ============================================================

/**
 * Path (relative to this file) of the vendored solver wasm-pack output shim.
 * `wasm-pack build --target web` produces a JS shim alongside the `.wasm`.
 *
 * We reference it through a runtime-computed specifier so webpack does not
 * try to resolve (and fail on) a not-yet-existing module at build time.
 *
 * NOTE: wasm-postflop builds the solver (`GameManager`) and the range parser
 * (`RangeManager`) as SEPARATE wasm-pack packages. The default expectation is
 * that you copy the solver-st shim here as `postflop_solver.js` and the range
 * shim as `range.js`. If you instead vendor a single combined module that
 * exports both classes, the range module load is simply skipped.
 */
const VENDOR_SOLVER_SPECIFIER = '../../../vendor/postflop-solver/postflop_solver.js';

/** Path of the vendored range-parser wasm-pack shim (optional / may be combined
 *  into the solver module). */
const VENDOR_RANGE_SPECIFIER = '../../../vendor/postflop-solver/range.js';

/**
 * `true` once a `PostflopSolver.load()` call has successfully imported and
 * initialized the WASM module in this runtime. Useful for feature-gating UI
 * (e.g. only show the "Run solve" button when the solver is available).
 *
 * This starts `false` and is flipped by `load()`. It is intentionally a
 * mutable module-level flag rather than a compile-time constant, because
 * availability can only be known at runtime (does the vendored file exist /
 * does the browser support WASM).
 */
export let WASM_AVAILABLE = false;

// ------------------------------------------------------------
// Public types
// ------------------------------------------------------------

/** Bet/raise sizing configuration. Each field is a comma-separated string of
 *  pot-relative percentages and/or absolute chip amounts, e.g. "33%,75%,150%".
 *  Mirrors the bet-size grammar accepted by postflop-solver's `init`. */
export interface BetSizeOptions {
  /** OOP flop bet sizes, e.g. "50%,100%". */
  oopFlopBet?: string;
  /** OOP flop raise sizes. */
  oopFlopRaise?: string;
  /** OOP turn bet sizes. */
  oopTurnBet?: string;
  /** OOP turn raise sizes. */
  oopTurnRaise?: string;
  /** OOP river bet sizes. */
  oopRiverBet?: string;
  /** OOP river raise sizes. */
  oopRiverRaise?: string;
  /** IP flop bet sizes. */
  ipFlopBet?: string;
  /** IP flop raise sizes. */
  ipFlopRaise?: string;
  /** IP turn bet sizes. */
  ipTurnBet?: string;
  /** IP turn raise sizes. */
  ipTurnRaise?: string;
  /** IP river bet sizes. */
  ipRiverBet?: string;
  /** IP river raise sizes. */
  ipRiverRaise?: string;
}

/** A heads-up postflop spot to solve. */
export interface PostflopSpot {
  /** Out-of-position player's range as a range string, e.g. "AA,KK,AKs,AKo:0.5". */
  oopRange: string;
  /** In-position player's range as a range string. */
  ipRange: string;
  /** Board as a card string of 3-5 cards, e.g. "Ah Kd 7c" / "AhKd7c" / "Ah,Kd,7c". */
  board: string;
  /** Starting pot size in chips at the start of the solved street. */
  startingPot: number;
  /** Effective (per-player) remaining stack in chips. */
  effectiveStack: number;
  /** Rake fraction of the pot (0 = no rake). Defaults to 0. */
  rakeRate?: number;
  /** Rake cap in chips. Defaults to 0. */
  rakeCap?: number;
  /** Bet-size configuration. Sensible defaults applied when omitted. */
  betSizes?: BetSizeOptions;
}

/** Options controlling the CFR solve loop. */
export interface SolveOptions {
  /** Maximum number of CFR iterations. Default 1000. */
  maxIterations?: number;
  /** Stop early once exploitability (as a fraction of the pot) falls below
   *  this value. Default 0.005 (0.5% of the pot). */
  targetExploitability?: number;
  /** Use memory compression in the solver (smaller footprint, slightly
   *  slower). Default false. */
  compress?: boolean;
  /** Optional callback invoked roughly every `progressInterval` iterations
   *  with the current iteration count and exploitability. */
  onProgress?: (iteration: number, exploitability: number) => void;
  /** How often (in iterations) to evaluate exploitability / report progress.
   *  Default 10. */
  progressInterval?: number;
}

/** Per-action frequency + EV for the root decision. */
export interface ActionFrequency {
  /** Action label, e.g. "Check", "Bet 150", "Fold", "Call", "Raise 450". */
  action: string;
  /** Raw bet/raise amount in chips, when applicable (0 for Check/Fold/Call). */
  amount: number;
  /** Range-weighted average frequency this action is taken (0-1). */
  frequency: number;
}

/** Map of normalized action frequencies for the root node. */
export interface ActionFrequencies {
  /** Which player acts at the root: 'oop' or 'ip'. */
  player: 'oop' | 'ip';
  /** One entry per available action at the root. Frequencies sum to ~1. */
  actions: ActionFrequency[];
}

/** Result of a solve. */
export interface SolveResult {
  /** Final exploitability as a fraction of the pot (lower = more converged). */
  exploitability: number;
  /** Number of CFR iterations actually performed. */
  iterations: number;
  /** Root-decision strategy as range-weighted action frequencies. */
  strategy: ActionFrequencies;
}

// ------------------------------------------------------------
// Minimal structural types for the WASM exports.
// These describe only the surface we use. The real bindings come from the
// vendored wasm-pack output; we keep our own interface so this file compiles
// without that file present.
// ------------------------------------------------------------

interface WasmGameManager {
  init(
    oopRange: Float32Array,
    ipRange: Float32Array,
    board: Uint8Array,
    startingPot: number,
    effectiveStack: number,
    rakeRate: number,
    rakeCap: number,
    donkOption: boolean,
    oopFlopBet: string,
    oopFlopRaise: string,
    oopTurnBet: string,
    oopTurnRaise: string,
    oopRiverBet: string,
    oopRiverRaise: string,
    ipFlopBet: string,
    ipFlopRaise: string,
    ipTurnBet: string,
    ipTurnRaise: string,
    ipRiverBet: string,
    ipRiverRaise: string,
    addAllinThreshold: number,
    forceAllinThreshold: number,
    mergingThreshold: number,
    addedLines: string,
    removedLines: string,
  ): string | undefined;
  memory_usage(compress: boolean): bigint | number;
  allocate_memory(compress: boolean): void;
  solve_step(iteration: number): void;
  exploitability(): number;
  finalize(): void;
  apply_history(history: Uint32Array): void;
  current_player(): 'oop' | 'ip' | 'chance' | 'terminal';
  num_actions(): number;
  actions_after(append: Uint32Array): string;
  get_results(): Float64Array;
}

interface WasmRangeManager {
  from_string(range: string): string | undefined;
  raw_data(): Float32Array;
  free?(): void;
}

interface WasmSolverModule {
  default?: (input?: unknown) => Promise<unknown>;
  GameManager: { new (): WasmGameManager };
  /** Present when the solver module is a combined build that also exports the
   *  range parser. Otherwise the range parser comes from a separate module. */
  RangeManager?: { new (): WasmRangeManager };
}

interface WasmRangeModule {
  default?: (input?: unknown) => Promise<unknown>;
  RangeManager: { new (): WasmRangeManager };
}

// ------------------------------------------------------------
// Card / range / board parsing helpers
// ------------------------------------------------------------

const RANK_CHARS = '23456789TJQKA';
// postflop-solver suit order: 0=club, 1=diamond, 2=heart, 3=spade.
const SUIT_CHARS = 'cdhs';

/**
 * Parse a single card token like "Ah" or "Tc" into the solver's `4*rank+suit`
 * encoding (rank 0=2 .. 12=A; suit 0=c,1=d,2=h,3=s).
 * @throws if the token is not a valid 2-character card.
 */
export function parseCard(token: string): number {
  const t = token.trim();
  if (t.length !== 2) {
    throw new Error(`Invalid card token "${token}" (expected e.g. "Ah").`);
  }
  const rank = RANK_CHARS.indexOf(t[0].toUpperCase());
  const suit = SUIT_CHARS.indexOf(t[1].toLowerCase());
  if (rank < 0 || suit < 0) {
    throw new Error(`Invalid card token "${token}".`);
  }
  return 4 * rank + suit;
}

/**
 * Parse a board string ("Ah Kd 7c", "AhKd7c", or "Ah,Kd,7c") into a
 * `Uint8Array` of 3-5 card codes for the solver.
 * @throws if the board has the wrong number of cards or duplicate cards.
 */
export function parseBoard(board: string): Uint8Array {
  const cleaned = board.trim().replace(/[\s,]+/g, '');
  if (cleaned.length % 2 !== 0) {
    throw new Error(`Board "${board}" has an odd number of characters.`);
  }
  const tokens: string[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    tokens.push(cleaned.slice(i, i + 2));
  }
  if (tokens.length < 3 || tokens.length > 5) {
    throw new Error(`Board "${board}" must have 3-5 cards (got ${tokens.length}).`);
  }
  const cards = tokens.map(parseCard);
  if (new Set(cards).size !== cards.length) {
    throw new Error(`Board "${board}" contains duplicate cards.`);
  }
  return Uint8Array.from(cards);
}

// ------------------------------------------------------------
// Default bet sizing
// ------------------------------------------------------------

const DEFAULT_BET = '50%';
const DEFAULT_RAISE = '60%';

function resolveBetSizes(b?: BetSizeOptions): Required<BetSizeOptions> {
  return {
    oopFlopBet: b?.oopFlopBet ?? DEFAULT_BET,
    oopFlopRaise: b?.oopFlopRaise ?? DEFAULT_RAISE,
    oopTurnBet: b?.oopTurnBet ?? DEFAULT_BET,
    oopTurnRaise: b?.oopTurnRaise ?? DEFAULT_RAISE,
    oopRiverBet: b?.oopRiverBet ?? DEFAULT_BET,
    oopRiverRaise: b?.oopRiverRaise ?? DEFAULT_RAISE,
    ipFlopBet: b?.ipFlopBet ?? DEFAULT_BET,
    ipFlopRaise: b?.ipFlopRaise ?? DEFAULT_RAISE,
    ipTurnBet: b?.ipTurnBet ?? DEFAULT_BET,
    ipTurnRaise: b?.ipTurnRaise ?? DEFAULT_RAISE,
    ipRiverBet: b?.ipRiverBet ?? DEFAULT_BET,
    ipRiverRaise: b?.ipRiverRaise ?? DEFAULT_RAISE,
  };
}

// ------------------------------------------------------------
// Error thrown when the WASM artifact is not vendored.
// ------------------------------------------------------------

const BUILD_INSTRUCTIONS = [
  'The heads-up postflop solver WASM module is not vendored.',
  'Build it locally and place the wasm-pack output at vendor/postflop-solver/.',
  '',
  'Quick steps (see docs/HEADS_UP_SOLVER.md for full detail):',
  '  1. Install Rust:        curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh',
  '  2. rustup toolchain install nightly && cargo install wasm-pack',
  '  3. git clone https://github.com/b-inary/wasm-postflop /tmp/wasm-postflop',
  '  4. cd /tmp/wasm-postflop && npm install && npm run wasm:range && npm run wasm:solver-st',
  '  5. Copy pkg/solver-st/* AND pkg/range/* into <project>/vendor/postflop-solver/',
].join('\n');

export class PostflopSolverUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(BUILD_INSTRUCTIONS + (cause ? `\n\nUnderlying error: ${String(cause)}` : ''));
    this.name = 'PostflopSolverUnavailableError';
  }
}

// ------------------------------------------------------------
// PostflopSolver
// ------------------------------------------------------------

/**
 * High-level driver for the heads-up postflop CFR solver.
 *
 * Usage:
 * ```ts
 * const solver = await PostflopSolver.load();
 * const result = await solver.solve({
 *   oopRange: 'AA,KK,QQ,AKs',
 *   ipRange:  'AA-22,AKs-A2s,AKo-AJo',
 *   board:    'Ah Kd 7c',
 *   startingPot: 100,
 *   effectiveStack: 900,
 * }, { maxIterations: 500, targetExploitability: 0.005 });
 * console.log(result.strategy.actions);
 * ```
 */
export class PostflopSolver {
  private constructor(
    private readonly solverMod: WasmSolverModule,
    private readonly rangeCtor: { new (): WasmRangeManager },
  ) {}

  /**
   * Lazily import and initialize the vendored WASM module(s).
   * @throws {PostflopSolverUnavailableError} if the WASM is not vendored or
   *   fails to initialize.
   */
  static async load(): Promise<PostflopSolver> {
    let solverMod: WasmSolverModule;
    try {
      // The specifier is held in a variable + wrapped in webpackIgnore so the
      // bundler does NOT attempt to resolve the (possibly missing) vendor file
      // at build time. The import only happens at runtime inside load().
      solverMod = (await import(
        /* webpackIgnore: true */ VENDOR_SOLVER_SPECIFIER
      )) as unknown as WasmSolverModule;
    } catch (err) {
      throw new PostflopSolverUnavailableError(err);
    }

    try {
      // wasm-pack --target web exposes a default init() that must run before
      // the exported classes are usable.
      if (typeof solverMod.default === 'function') {
        await solverMod.default();
      }
      if (typeof solverMod.GameManager !== 'function') {
        throw new Error('GameManager export missing from solver WASM module.');
      }
    } catch (err) {
      throw new PostflopSolverUnavailableError(err);
    }

    // Resolve the RangeManager. Prefer a combined solver module; otherwise load
    // the separate range module that wasm-postflop produces.
    let rangeCtor = solverMod.RangeManager;
    if (typeof rangeCtor !== 'function') {
      try {
        const rangeMod = (await import(
          /* webpackIgnore: true */ VENDOR_RANGE_SPECIFIER
        )) as unknown as WasmRangeModule;
        if (typeof rangeMod.default === 'function') {
          await rangeMod.default();
        }
        rangeCtor = rangeMod.RangeManager;
      } catch (err) {
        throw new PostflopSolverUnavailableError(err);
      }
    }
    if (typeof rangeCtor !== 'function') {
      throw new PostflopSolverUnavailableError(
        new Error('RangeManager export missing from both solver and range modules.'),
      );
    }

    WASM_AVAILABLE = true;
    return new PostflopSolver(solverMod, rangeCtor);
  }

  /**
   * Convert a range string into the 1326-element f32 array the solver expects,
   * using the WASM RangeManager.
   * @throws if the range string is invalid.
   */
  private rangeToArray(range: string): Float32Array {
    const rm = new this.rangeCtor();
    try {
      const err = rm.from_string(range);
      if (err) {
        throw new Error(`Invalid range "${range}": ${err}`);
      }
      // Copy out of WASM memory before the manager is freed.
      return Float32Array.from(rm.raw_data());
    } finally {
      rm.free?.();
    }
  }

  /**
   * Solve a heads-up postflop spot and return the root-decision strategy.
   */
  async solve(spot: PostflopSpot, opts: SolveOptions = {}): Promise<SolveResult> {
    const maxIterations = opts.maxIterations ?? 1000;
    const targetExploitability = opts.targetExploitability ?? 0.005;
    const compress = opts.compress ?? false;
    const progressInterval = Math.max(1, opts.progressInterval ?? 10);

    const oopRange = this.rangeToArray(spot.oopRange);
    const ipRange = this.rangeToArray(spot.ipRange);
    const board = parseBoard(spot.board);
    const bets = resolveBetSizes(spot.betSizes);

    const gm = new this.solverMod.GameManager();

    const initErr = gm.init(
      oopRange,
      ipRange,
      board,
      spot.startingPot,
      spot.effectiveStack,
      spot.rakeRate ?? 0,
      spot.rakeCap ?? 0,
      /* donkOption */ false,
      bets.oopFlopBet,
      bets.oopFlopRaise,
      bets.oopTurnBet,
      bets.oopTurnRaise,
      bets.oopRiverBet,
      bets.oopRiverRaise,
      bets.ipFlopBet,
      bets.ipFlopRaise,
      bets.ipTurnBet,
      bets.ipTurnRaise,
      bets.ipRiverBet,
      bets.ipRiverRaise,
      /* addAllinThreshold   */ 1.5,
      /* forceAllinThreshold */ 0.15,
      /* mergingThreshold    */ 0.1,
      /* addedLines   */ '',
      /* removedLines */ '',
    );
    if (initErr) {
      throw new Error(`Solver init failed: ${initErr}`);
    }

    gm.allocate_memory(compress);

    // CFR solve loop with early-stop on convergence.
    let iteration = 0;
    let exploitability = Number.POSITIVE_INFINITY;
    for (; iteration < maxIterations; iteration++) {
      gm.solve_step(iteration);

      if (iteration % progressInterval === 0 || iteration === maxIterations - 1) {
        exploitability = gm.exploitability();
        opts.onProgress?.(iteration + 1, exploitability);
        // Exploitability is reported in chips; normalize by the pot.
        if (exploitability <= targetExploitability * spot.startingPot) {
          iteration++;
          break;
        }
      }
    }

    gm.finalize();
    exploitability = gm.exploitability();

    // Navigate to the root node and parse the root strategy.
    gm.apply_history(new Uint32Array([]));
    const strategy = this.parseRootStrategy(gm);

    return {
      exploitability: spot.startingPot > 0 ? exploitability / spot.startingPot : exploitability,
      iterations: iteration,
      strategy,
    };
  }

  /**
   * Parse `get_results()` for the current (root) node into normalized,
   * range-weighted per-action frequencies.
   *
   * `get_results()` layout (see postflop-solver web frontend):
   *   [0] potOOP, [1] potIP, [2] isEmpty,
   *   then per-player blocks of weights / normalizers / equity / ev / eqr,
   *   then a strategy block of `numActions * numHands` floats laid out
   *   action-major: strategy[action * numHands + hand].
   *
   * We compute each action's range-weighted frequency using the acting
   * player's normalizer weights (so dead/blocked hands don't skew the mix).
   */
  private parseRootStrategy(gm: WasmGameManager): ActionFrequencies {
    const who = gm.current_player();
    if (who !== 'oop' && who !== 'ip') {
      // Root is a chance/terminal node (e.g. a fully specified river with no
      // remaining decision). Return an empty strategy rather than guessing.
      return { player: 'oop', actions: [] };
    }

    const numActions = gm.num_actions();
    const actionLabels = this.parseActionLabels(gm);
    const results = gm.get_results();

    // Derive numHands from the trailing strategy block. The strategy block is
    // the final numActions*numHands entries of get_results().
    // We recover numHands from the acting player's weight block, which the
    // frontend places right after the 3-element header. Each player has a
    // `numHands`-length weight array; we read the acting player's.
    // To stay robust against exact block offsets, derive numHands from the
    // total length: header(3) + perPlayerBlocks + strategy(numActions*numHands).
    // The simplest robust approach: numHands = strategyLen / numActions where
    // strategyLen is the last numActions*numHands floats. We solve for numHands
    // using the known per-player block structure below.
    const HEADER = 3;
    // Per player: weights + normalizers + equity + ev + eqr = 5 * numHands.
    // Two players => 10 * numHands. Plus strategy = numActions * numHands.
    // total = 3 + 10*numHands + numActions*numHands
    //       = 3 + numHands * (10 + numActions)
    const numHands = Math.round((results.length - HEADER) / (10 + numActions));
    if (numHands <= 0) {
      return { player: who, actions: [] };
    }

    // Acting player's normalizer weights live in the second of the player's
    // five blocks. Layout per the frontend: for each player p in [oop, ip]:
    //   weights[numHands], normalizers[numHands], equity[numHands],
    //   ev[numHands], eqr[numHands].
    const playerOffset = (who === 'oop' ? 0 : 5) * numHands;
    const normalizersStart = HEADER + playerOffset + numHands; // after weights
    const normalizers = results.subarray(normalizersStart, normalizersStart + numHands);

    const strategyStart = HEADER + 10 * numHands;

    // Total weight for normalization.
    let totalWeight = 0;
    for (let h = 0; h < numHands; h++) totalWeight += normalizers[h];

    const actions: ActionFrequency[] = [];
    for (let a = 0; a < numActions; a++) {
      let weighted = 0;
      const base = strategyStart + a * numHands;
      for (let h = 0; h < numHands; h++) {
        weighted += strategy(results, base + h) * normalizers[h];
      }
      const label = actionLabels[a] ?? `Action ${a}`;
      actions.push({
        action: label.name,
        amount: label.amount,
        frequency: totalWeight > 0 ? weighted / totalWeight : 0,
      });
    }

    return { player: who, actions };
  }

  /**
   * Parse the `actions_after("")` string ("Fold:0/Check:0/Bet:150/...") into
   * structured action labels.
   */
  private parseActionLabels(gm: WasmGameManager): Array<{ name: string; amount: number }> {
    const raw = gm.actions_after(new Uint32Array([]));
    return raw
      .split('/')
      .filter((s) => s.length > 0)
      .map((entry) => {
        const [kind, amtStr] = entry.split(':');
        const amount = Number(amtStr) || 0;
        const name = amount > 0 ? `${kind} ${amount}` : kind;
        return { name, amount };
      });
  }
}

/** Read one strategy entry from the flat results array. */
function strategy(results: Float64Array, index: number): number {
  return results[index] ?? 0;
}
