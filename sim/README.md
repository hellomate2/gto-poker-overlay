# Bot simulation harness

A No-Limit Hold'em game engine (2 to 6 seats, side pots) that drives the **real**
shipped bot (`DecisionEngine.decide()`) against scripted opponents and against
another build of itself, so engine changes are judged by measured win-rate and
action frequencies instead of guesses.

## Run it

```bash
npm run sim:selftest                       # engine correctness: HU checks + ring chip conservation
npm run sim -- 6000 42 --no-expl           # bot vs every archetype heads-up (6,000 hands each)
npm run sim -- 6000 42 --profiles raiser,barreler --no-expl
npm run sim:ring -- 10000 42               # bot in a 6-max ring vs a scripted field
npm run sim:match -- --a /path/to/baseline --b /path/to/candidate --deals 2000
```

`sim/BASELINE.md` has the reference numbers for the swarm base commit and the exact
commands that produced them.

## The three drivers

### `run.ts`: bot vs one archetype, heads-up

Plays N hands per profile, button alternating, seeded. Each profile is played in two
modes: **GTO** (no opponent read) and **EXPL** (the bot tracks the opponent so its
profiler and exploit adjuster engage). `--no-expl` skips the second pass and halves
the runtime. Output goes to the console and to `sim/REPORT.md` (or `--out FILE`).

Default profiles: `station, nit, maniac, tag` (threshold players) and the exploit
probes `raiser, barreler, checkraiser`. `lag` and `fish` exist for ad-hoc runs.

### `ring-run.ts`: bot at a 3 to 6 seat table

The bot sits in seat 0, the button rotates every hand so it plays every position,
and the other seats are archetypes (`--field tag,lag,nit,station,tag` by default,
cycled if shorter than the table). Reports bb/100 with a 95% CI, bb/100 by position,
how often the bot's flops were multiway, its result in heads-up vs multiway flops,
and the pressure metrics below. `--exploit` turns opponent tracking on.

### `match.ts`: duplicate match, engine A vs engine B

Loads `DecisionEngine` from two source trees by dynamic import of
`<dir>/src/core/engine.ts`, so a candidate worktree is compared with the baseline
checkout in one process without merging anything. Each tree gets its own module
graph.

- `--mode hu` (default): A vs B heads-up. Every deal is played twice with the same
  cards and the same button seat, A in seat 0 then B in seat 0. A's result for the
  deal is its net over both games, so card luck cancels.
- `--mode field --seats N --field ...`: A and B each play every deal from seat 0
  against the same scripted field. The per-deal difference cancels card luck and
  position. `--seats 2 --field raiser` compares the two engines against one
  archetype; `--seats 6` is the multiway comparison.

The reported bb/100 has a 95% CI from the per-deal variance (`1.96 * SE`). Positive
means A won. `--workers K` splits deals across K processes; results are identical to
one process because every random source is seeded per deal (deck, `Math.random`
before each game, and each scripted opponent's private RNG). `--out FILE` saves the
summary.

`sim/compare.sh BASELINE_DIR CANDIDATE_DIR [OUT_DIR] [WORKERS]` runs the standard
battery (heads-up A vs B, field runs vs the probe archetypes, 6-max field) with deal
counts sized from the measured noise in `sim/BASELINE.md`.

Sanity properties, pinned by `tests/sim-match.test.ts`: an engine against itself
scores exactly 0 with zero variance in both modes, and always-jam vs always-fold
scores exactly +75 bb/100.

Bots in a match run without opponent tracking, because the exploit adjuster keeps
state across hands and would break per-deal independence.

Seats other than DecisionEngine: `--a-agent SPEC` / `--b-agent SPEC` with
`SPEC` = `engine` (default) or `blueprint:<ckpt>`, the C++ blueprint played
through `bp serve` by the BlueprintAgent (`sim/seat-agents.ts`,
`sim/blueprint-serve.ts`; set `GPO_BP_FLAGS` to the checkpoint's tree and
abstraction flags, including `--cache DIR`). `--start-bb N` changes the
stack depth (the blueprint is trained at 100 BB). Shards run one at a time
with `--shard k/K` combine with `sim/match-combine.ts`. Exact-reference
checks for the bridge: `sim/blueprint-parity.ts`; a readable trace of its
decisions: `sim/blueprint-trace.ts`. Details and the first measurements are
in blueprint/README.md, "Serving the blueprint to the TS harness".

## Scripted opponents (`agents.ts`)

Threshold archetypes act on equity vs a random hand against fixed thresholds:
`nit`, `tag`, `lag`, `fish`, `station`, `maniac`.

Exploit probes play TAG preflop so they reach postflop with a normal range, then
each attacks one leak:

| probe | behavior | leak it punishes |
|---|---|---|
| `raiser` | raises 75% of postflop bets it faces with any two cards (always with value); folds to a re-raise without real equity | folding too often to raises |
| `barreler` | bets 2/3 pot every time it can open the betting on flop, turn and river | folding to turn and river barrels |
| `checkraiser` | checks whenever first to act, then check-raises 60% of bets with any two cards | auto-cbetting and stabbing |

Every scripted opponent draws all of its randomness (coin flips and its Monte-Carlo
equity samples) from a private seeded RNG, so its play does not depend on how many
random numbers the bot used.

## Metrics

Preflop and showdown: VPIP, PFR, SB open, BB defend, 3bet, fold-to-3bet, flop cbet,
fold-to-cbet, river bet, WTSD, W$SD, postflop AF.

Pressure metrics (`stats.ts`, any table size, postflop only; a response is the bot's
next action on the same street after the wager):

- `fold-to-raise`: the bot bet or raised, an opponent raised over it, the bot folded.
- `fold-to-flop-bet`: the first flop wager was an opponent's.
- `fold-to-turn-barrel`: an opponent wagered the flop, the bot only called, and the
  same opponent made the first turn wager.
- `fold-to-river-bet`: the first river wager was an opponent's.
- `turn barrel` and `river barrel`: the bot made the last wager of the previous street
  and bets again when it gets to act before anyone wagers.

## Fidelity to the live scraper

The bot reads `GameState`, so the sim builds it the way `src/content-script/scraper.ts`
does:

- `players[]` holds every dealt seat in seat order, positions from the same template
  as `assignPositions` (BTN, SB, BB, UTG, MP, CO; heads-up SB is the button).
- `actionHistory` uses the scraper's vocabulary: a first postflop wager is `bet`,
  anything over a live wager is `raise`, folds stay in the history, blind posts are
  not logged.
- `minRaise` is a raise-to amount.
- Folded players stay in `players[]` with `isSittingOut: false`, plus an extra
  `folded: true` field that the current engine ignores.

The heads-up engine before the ring rewrite logged postflop bets as `raise`, so the
distilled net saw "faced a raise" when facing a plain bet. Numbers from older
`REPORT.md` runs are not comparable with runs after this change.

## Correctness

`ring.ts` asserts on every hand that chips are conserved, that every pot layer is
paid out, and that no stack goes negative. `npm run sim:selftest` runs the heads-up
checks (always-jam vs always-fold is exactly +75 bb/100; a mirror match is near 0)
and 15,000 random hands at every table size from 2 to 6 with uneven stacks, so side
pots actually occur. `holdem.ts` is a 2-seat wrapper over `ring.ts`; on
archetype-vs-archetype runs it reproduces the old heads-up engine's chip results
exactly.

## Files

- `ring.ts`: the N-seat engine (betting rounds, incomplete-raise rule, side pots,
  showdown, invariants).
- `holdem.ts`: heads-up wrapper with the original `playHand` API.
- `agents.ts`: the real-bot wrapper (engine class injectable) and the archetypes.
- `stats.ts`: pressure metrics and the bb/100 confidence interval.
- `run.ts`, `ring-run.ts`, `match.ts`: the drivers above.
- `fake-idb.ts`: in-memory IndexedDB shim so the bot's opponent tracking works in Node.

- `defense-shim.ts`: patches an engine instance to route facing-a-bet spots
  through `src/core/defense.ts` (used by the probes below).

> Caveat: scripted opponents are deliberately exploitable heuristics. A big positive
> bb/100 against them says little about real opposition. Use them to find where the
> bot's frequencies are wrong, and use `match.ts` to decide whether a change helped.

## Diagnostic probes (`*.probe.ts`)

Slow, one-off measurements that are not part of `npx vitest run`. Run them with
the probe config:

```bash
npx vitest run --config sim/vitest.probe.config.ts sim/fold-to-raise   # per-hand fold-to-raise grid
npx vitest run --config sim/vitest.probe.config.ts sim/range-fold      # fold-to-raise over the whole betting range vs MDF
npx vitest run --config sim/vitest.probe.config.ts sim/barrel          # turn/river barrel frequency vs barrelGate
npx vitest run --config sim/vitest.probe.config.ts sim/defense-hu      # HU A/B with and without src/core/defense.ts
npx vitest run --config sim/vitest.probe.config.ts sim/defense-latency # cost of the defense pipeline per street
```

`PROBE_DEFENSE=1` routes facing-a-bet decisions in the first two probes through
`src/core/defense.ts` via `sim/defense-shim.ts` (which patches an engine
instance; `engine.ts` itself is untouched). `PROBE_COMBOS`, `PROBE_HANDS` and
`PROBE_OPPS` size the runs.
