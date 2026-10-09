# swarm/integrate: flag ablation

All six workstream branches (ws/harness, ws/ranges, ws/multiway, ws/defense,
ws/subgame, ws/blueprint) are merged. The engine wiring lives in
`src/core/engine.ts` behind the flags in `src/core/engine-flags.ts`. The
blueprint stays offline: `src/core/blueprint/loader.ts` and its tests are
present, nothing in the live engine calls it.

## What the evidence supports (updated 2026-10-09 05:15 PDT)

Read this section before quoting any number below. All CIs are 95%, and the
raw match outputs are in `sim/results/2026-10-09/` (integration runs in
`integrate/`, the held-out seed 101 reruns in `heldout-s101/`, the subgame cap
fix runs in `subgame-cap/`). The measurement rules going forward are in
`sim/EVAL_PROTOCOL.md`.

- No measured flag configuration has a significant heads-up gain over
  swarm/base. The integration-time default package C1 (FIX_LIVE_VILLAINS +
  RANGE_TRACKER + SUBGAME_SOLVER) scored -6.35 +/- 13.46 bb/100 for base on seed 1 and
  -5.83 +/- 14.13 on seed 101 (A's bb/100, so negative leans toward the
  candidate, but both CIs include 0). RANGE_TRACKER alone: +1.40 +/- 10.46.
- The defaults that ship on swarm/next (315dcdd) turn on FIX_LIVE_VILLAINS
  only. That flag does not change heads-up play (FIX+MW vs base, 500 deals:
  +0.00 +/- 0.00), so heads-up the shipped engine plays exactly like swarm/base.
- The 6-max field gains did not replicate on a fresh seed. Seed 1 (3000 deals)
  vs seed 101 (2000 deals), A - B bb/100: RANGE_TRACKER -159.11 +/- 137.99 vs
  -30.97 +/- 156.20; C1 -173.73 +/- 138.39 vs -37.25 +/- 156.32;
  SUBGAME_SOLVER -21.05 +/- 14.58 vs -9.68 +/- 11.31. Only the seed 1 runs
  exclude 0. The seed 101 runs had fewer deals, so this shows the seed 1 gains
  are not established; it does not show the effects are zero.
- The heads-up probe gains did replicate where they were rerun. Seed 1 vs
  seed 101 (3000 deals each): RANGE_TRACKER vs raiser -64.17 +/- 46.44 vs
  -66.60 +/- 50.22, RANGE_TRACKER vs tag -56.93 +/- 35.48 vs -47.26 +/- 34.63,
  C1 vs raiser -53.51 +/- 50.67 vs -87.32 +/- 57.25. All six exclude 0. The
  barreler and checkraiser probes were not rerun on seed 101. These are gains
  against scripted archetypes, not evidence of heads-up strength.
- DEFENSE shows why probes are not enough. It beats base against the raiser,
  barreler and checkraiser probes (each CI excludes 0; tag +2.49 +/- 43.38 is
  no difference), yet base beats it heads-up: +22.61 +/- 18.49 bb/100 for base
  on seed 1 (3000 deals, significant) and +16.59 +/- 18.45 on seed 101 (2000
  deals, not significant alone). An inverse-variance pool of the two seeds,
  computed from the two printed CIs, gives +19.59 +/- 13.06 for base.
- The subgame cap fix (673724d) is heads-up neutral and wins against the
  barreler probe on both seeds: hu -7.58 +/- 15.27 (seed 1) and
  +5.77 +/- 12.83 (seed 202); barreler -49.21 +/- 43.19 and -101.34 +/- 43.13.
  Details in "Subgame cap fix" below.
- The decisive heads-up test is pre-registered: 22,000 deals at seed 7, one
  run, and a gain counts only if its 95% CI excludes 0. See "Pre-registered
  heads-up test" at the end of this file.

## How the numbers were produced

Every run is `sim/match.ts` with A = the swarm/base checkout
(`/Users/rg/Downloads/gto-poker-overlay`, b39bc8b) and B = this tree, with the
candidate's flags set through the environment:

```
GPO_ENGINE_FLAGS=<spec> npx tsx sim/match.ts \
  --a /Users/rg/Downloads/gto-poker-overlay --b /Users/rg/Downloads/gpo-wt/integrate \
  <mode args> --seed 1
```

Mode args:

- hu: `--mode hu --deals 3000` (6000 hands, A vs B duplicate)
- probe P: `--mode field --seats 2 --field P --deals 3000`
- 6-max: `--mode field --seats 6 --deals 3000` (field tag,lag,nit,station,tag)

Sign convention (from the harness): in hu mode the number is A's bb/100, and in
field mode it is A minus B. **Negative means the candidate beat base.** All
CIs are 95%. The fold columns read "base -> candidate". Each output in
`sim/results/2026-10-09/integrate/` is named after its run (hu-C1.txt,
p-raiser-RT.txt, r6-C1.txt) and prints B's commit. 61bb8df with uncommitted
edits: hu-RT, the four RT probe runs, and the 6-max ALL, DEF, FIX, FIX+MW
(before fix), MW (before fix) and SG runs. 479307a with uncommitted edits: the
two guard runs, hu FIX+MW and the two RT rechecks. Every other run: 479307a
(the multiway range fix; it only changes MULTIWAY_EQUITY behavior). r6-ALL was
rerun on 479307a (r6-ALL2.txt) and reproduced -473.39 +/- 262.63 exactly.
Runs without `--workers` in their CMD line used 1 worker.

Config names: RT = RANGE_TRACKER, DEF = DEFENSE, SG = SUBGAME_SOLVER,
MW = MULTIWAY_EQUITY, FIX = FIX_LIVE_VILLAINS, C1 = FIX+RT+SG (the shipped
defaults), C2 = C1+DEF, ALL = every flag.

### Flags off reproduce base exactly

| run | result |
|---|---|
| hu, `none`, 1000 deals | +0.00 +/- 0.00 (sd 0.00) |
| 6-max, `none`, 600 deals | +0.00 +/- 0.00 (sd 0.00) |

FIX and MW together, heads-up, 500 deals: +0.00 +/- 0.00 (sd 0.00), so
neither flag changes heads-up play.

### Rechecks after the crash (03:00) on the current tree

The RT-alone runs above used 61bb8df with uncommitted edits. Rerun on the
current tree with `--workers 2`:

| run | first result | rerun |
|---|---|---|
| hu RT, 3000 deals | +1.40 +/- 10.46 | +1.40 +/- 10.46 (identical) |
| raiser probe RT, 3000 deals | -64.17 +/- 46.44 | -64.64 +/- 46.53 |

The raiser rerun moved base's own result too (+197.09 to +202.64 vs the
probe), so field mode is not worker-count invariant (hu mode is). The RT
conclusion does not change.

### Subgame solver log guard

The full test suite failed one test with the shipped defaults
(`tests/postflop-decision.test.ts`, "folds 7-high facing a big bet on a scary
river"): the subgame solver raised 72o. That test state has an empty action
log, so the range tracker never saw villain's river bet and handed the solver
an unnarrowed range; the solved mix was raise 97.0%, fold 3.0%. With a full log
for the same spot (hero raises preflop, villain calls, checks on flop and turn,
villain bets 50 on the river) the solve folds 99.9%.

`decidePostflopSubgame` now falls back to the default path when the preflop
log is empty or when hero faces a wager that no villain bet/raise in this
street's log explains. `tests/engine-subgame-guard.test.ts` covers both cases
(the first fails without the guard). In the sim the log is always complete, so
the guard never fires there: FIX+RT+SG, guard vs 479307a, seed 3, gave
+0.00 +/- 0.00 heads-up (300 deals) and +0.00 +/- 0.00 vs the barreler probe
(300 deals).

### Heads-up head-to-head vs base (3000 deals)

| config | A vs B bb/100 | fold-to-raise | fold-to-flop-bet | fold-to-turn-barrel | fold-to-river-bet |
|---|---|---|---|---|---|
| RT | +1.40 +/- 10.46 | 28.8% -> 12.0% | 78.7% -> 71.3% | 58.3% -> 47.5% | 73.2% -> 71.4% |
| DEF | +22.61 +/- 18.49 | 27.4% -> 4.4% | 78.4% -> 28.2% | 57.7% -> 23.9% | 69.4% -> 31.7% |
| SG | -8.24 +/- 10.44 | 18.9% -> 26.7% | 78.4% -> 78.4% | 60.0% -> 48.1% | 81.9% -> 70.8% |
| RT+DEF | +22.67 +/- 20.43 | 30.3% -> 10.6% | 78.7% -> 18.1% | 58.3% -> 26.7% | 70.8% -> 30.4% |
| C1 | -6.35 +/- 13.46 | 29.8% -> 25.0% | 78.7% -> 71.3% | 59.7% -> 57.4% | 79.7% -> 68.3% |
| C2 = ALL | -10.19 +/- 16.81 | 32.5% -> 31.6% | 78.7% -> 18.1% | 59.7% -> 83.5% | 78.7% -> 72.9% |

FIX and MW do not change heads-up play (one villain), so they were not run here.

### Heads-up exploit probes (field mode, 2 seats, 3000 deals)

A - B bb/100 (base and candidate absolute win rates vs the probe in brackets):

| config | raiser | barreler | checkraiser | tag |
|---|---|---|---|---|
| RT | -64.17 +/- 46.44 | -55.86 +/- 40.42 | -42.14 +/- 37.00 | -56.93 +/- 35.48 |
| DEF | -96.58 +/- 65.83 | -99.77 +/- 54.44 | -55.54 +/- 47.87 | +2.49 +/- 43.38 |
| SG | -11.79 +/- 34.80 | -3.75 +/- 26.87 | -12.64 +/- 38.05 | -20.69 +/- 29.85 |
| C1 | -53.51 +/- 50.67 | -39.26 +/- 42.54 | -22.37 +/- 49.67 | -49.91 +/- 39.99 |
| C2 = ALL | -30.56 +/- 54.10 | -28.97 +/- 45.70 | -10.70 +/- 49.18 | -32.71 +/- 40.85 |

Base vs the probes: raiser +197.09 +/- 66.2, barreler +73.87 +/- 50.9,
checkraiser +93.03 +/- 53.4, tag +110.65 +/- 50.1. C1 vs the probes: raiser
+250.60 +/- 77.4, barreler +113.12 +/- 60.0, checkraiser +115.39 +/- 68.5,
tag +160.56 +/- 61.2.

Fold-to-raise vs the probe (base -> candidate):

| config | raiser | barreler | checkraiser | tag |
|---|---|---|---|---|
| RT | 43.4% -> 30.4% | 26.7% -> 32.7% | 58.1% -> 36.8% | 29.6% -> 20.4% |
| DEF | 43.4% -> 12.6% | 26.7% -> 4.8% | 58.1% -> 19.6% | 29.6% -> 5.7% |
| SG | 43.4% -> 49.4% | 26.7% -> 36.0% | 58.1% -> 61.8% | 29.6% -> 34.6% |
| C1 | 43.4% -> 39.0% | 26.7% -> 21.6% | 58.1% -> 48.8% | 29.6% -> 25.6% |
| C2 = ALL | 43.4% -> 37.0% | 26.7% -> 28.6% | 58.1% -> 47.8% | 29.6% -> 23.3% |

Fold-to-turn-barrel vs barreler: base 59.1%, RT 40.5%, DEF 17.6%, SG 51.1%,
C1 54.0%, ALL 49.0%. Fold-to-river-bet vs barreler: base 37.3%, RT 48.2%,
DEF 17.2%, SG 46.8%, C1 48.2%, ALL 67.7%.

### 6-max field (3000 deals unless noted)

Base vs the field: +849.65 +/- 226.9 bb/100.

| config | A - B bb/100 | candidate vs field | fold-to-raise | fold-to-flop-bet |
|---|---|---|---|---|
| FIX | -8.57 +/- 9.13 | +858.22 | 19.4% -> 17.6% | 59.8% -> 60.1% |
| FIX, seed 2, 9000 deals, 4 workers | -3.43 +/- 6.49 | +550.27 (base +546.83) | 15.6% -> 15.4% | 61.0% -> 61.4% |
| RT | -159.11 +/- 137.99 | +1008.75 | 19.4% -> 18.8% | 59.8% -> 22.6% |
| MW (before fix) | +960.54 +/- 218.02 | -110.89 | 19.4% -> 76.0% | 59.8% -> 91.4% |
| MW | +268.73 +/- 204.22 | +580.92 | 19.4% -> 48.5% | 59.8% -> 84.4% |
| FIX+MW (before fix) | +475.19 +/- 200.82 | +374.45 | 19.4% -> 55.0% | 59.8% -> 85.9% |
| FIX+MW | +259.89 +/- 204.44 | +589.75 | 19.4% -> 48.1% | 59.8% -> 84.7% |
| FIX+RT | -156.69 +/- 138.11 | +1006.33 | 19.4% -> 17.8% | 59.8% -> 24.1% |
| FIX+RT+MW | +128.43 +/- 205.73 | +721.21 | 19.4% -> 46.1% | 59.8% -> 69.8% |
| DEF | -115.26 +/- 142.67 | +964.90 | 19.4% -> 1.8% | 59.8% -> 26.4% |
| SG | -21.05 +/- 14.58 | +870.69 | 19.4% -> 16.8% | 59.8% -> 59.8% |
| C1 | -173.73 +/- 138.39 | +1023.38 | 19.4% -> 18.1% | 59.8% -> 24.1% |
| C2 | -198.23 +/- 158.68 | +1047.87 | 19.4% -> 5.1% | 59.8% -> 22.0% |
| ALL | -473.39 +/- 262.63 | +1323.04 | 19.4% -> 9.8% | 59.8% -> 24.5% |

"Before fix" is commit 61bb8df, where MULTIWAY_EQUITY gave every villain the
bluff-free betting range and (with FIX off) counted folded seats. 479307a
fixed both; MW still loses.

The harness README warns that this scripted field rewards loose play, so a
6-max gain alone is not accepted. ALL's large field gain comes with
MULTIWAY_EQUITY, which loses on its own, and with DEFENSE, which loses heads-up
to base; it is not shipped.

### Held-out seed 101 reruns

After integration, a statistics reviewer reran the main claims on seed 101,
which no tuning had used. B = swarm/integrate fc10eaf, A = swarm/base b39bc8b,
default `--workers` (1) as in the seed 1 runs, so field results compare at
equal worker counts. Seed 1 B commits: the RT probe runs and 6-max SG used
61bb8df with uncommitted edits, every other seed 1 run in this table 479307a. Outputs: `sim/results/2026-10-09/heldout-s101/`.

| run | seed 1 | seed 101 | replicated |
|---|---|---|---|
| hu C1 (3000 / 3000 deals) | -6.35 +/- 13.46 | -5.83 +/- 14.13 | both no difference |
| hu DEF (3000 / 2000) | +22.61 +/- 18.49 | +16.59 +/- 18.45 | same sign; seed 101 alone not significant |
| hu ALL (3000 / 2000) | -10.19 +/- 16.81 | -6.00 +/- 20.37 | both no difference |
| raiser probe RT (3000 / 3000) | -64.17 +/- 46.44 | -66.60 +/- 50.22 | yes |
| tag probe RT (3000 / 3000) | -56.93 +/- 35.48 | -47.26 +/- 34.63 | yes |
| raiser probe C1 (3000 / 3000) | -53.51 +/- 50.67 | -87.32 +/- 57.25 | yes |
| 6-max RT (3000 / 2000) | -159.11 +/- 137.99 | -30.97 +/- 156.20 | no |
| 6-max C1 (3000 / 2000) | -173.73 +/- 138.39 | -37.25 +/- 156.32 | no |
| 6-max SG (3000 / 2000) | -21.05 +/- 14.58 | -9.68 +/- 11.31 | no |

Measured sd per deal pair (hu) or per deal (field), which sets the deal counts
in `sim/EVAL_PROTOCOL.md`: hu C1 7.52 and 7.90 bb, hu DEF 10.33 and 8.42, hu RT
5.85; raiser probe RT 12.98 and 14.03; tag probe RT 9.92 and 9.68; 6-max C1
38.67 and 35.67.

### Decision latency

`GPO_ENGINE_FLAGS=<spec> npx tsx sim/latency.ts 200 5 --seats 2 --field raiser`
and `... --seats 6`, run one after another with load average 6 to 9 (other
sims running). Whole-decision wall time:

| config | HU vs raiser p50 / p95 / max (ms) | 6-max p50 / p95 / max (ms) |
|---|---|---|
| none | 5.8 / 146.0 / 615.1 | 7.3 / 188.4 / 382.5 |
| RT | 4.9 / 111.3 / 126.1 | 5.9 / 357.9 / 509.3 |
| FIX+MW | 4.0 / 104.2 / 221.2 | 7.9 / 16.4 / 97.9 |
| DEF | 4.4 / 122.6 / 220.9 | 4.5 / 111.8 / 232.8 |
| SG | 4.5 / 186.1 / 538.1 | 4.5 / 165.6 / 312.5 |
| C1 (defaults) | 4.3 / 113.8 / 520.5 | 6.0 / 378.1 / 626.2 |
| ALL | 6.9 / 183.5 / 551.5 | 9.5 / 56.1 / 149.3 |

Subgame solves (C1, HU): p50 26.3 ms, p95 468.4 ms, max 520.5 ms. Every config
stays far under the 2.5 s p95 target.

## Defaults

swarm/integrate (fc10eaf) shipped C1: FIX_LIVE_VILLAINS, RANGE_TRACKER and
SUBGAME_SOLVER on. swarm/next (created 04:30 from fc10eaf, now 315dcdd) turns
on FIX_LIVE_VILLAINS only; RANGE_TRACKER and SUBGAME_SOLVER went off after
review found the subgame cap bug and the possible scraper log-order bug, and
DEFENSE and MULTIWAY_EQUITY stay off. The reasons, with numbers, are in the
comment on `DEFAULT_ENGINE_FLAGS`.

None of these defaults has a measured heads-up gain. C1 is -6.35 +/- 13.46
(seed 1) and -5.83 +/- 14.13 (seed 101) bb/100 for base, no significant
difference on either seed, and FIX_LIVE_VILLAINS alone plays heads-up exactly
like base. FIX_LIVE_VILLAINS is on because it is a correctness fix that is
neutral in the 6-max field (seed 2, 9000 deals: -3.43 +/- 6.49).

## Known issues found during integration

- DEFENSE loses to base heads-up even with tracker ranges, while it wins big
  against the probes. With DEFENSE the bot folds 18-28% to flop bets against
  base (78% at base), which looks like over-defense against a value-heavy
  bettor. Combined with SUBGAME_SOLVER (C2) it folds 83.5% (172/206) to turn
  barrels heads-up: defense calls the flop wide, then the turn solve, which
  uses the tracker's narrower hero range, gives up.
- MULTIWAY_EQUITY over-folds multiway even with tracker ranges (fold-to-flop-bet
  69.8% with FIX+RT+MW vs 24.1% with FIX+RT). The heads-up-tuned thresholds in
  decidePostflopRanged need re-tuning for N-way pot share.
- sim/agents.ts opponents and src/core/analysis.ts still use heads-up equity.
  They were left alone so the harness stays comparable with BASELINE.md.
- barrelGate (defense.ts) is not wired; its report asks for a sim/audit-play.ts
  pass first.
- Field-mode match results depend on the worker count (see the rechecks);
  hu mode does not. Compare field runs only at equal `--workers`.
- RANGE_TRACKER and SUBGAME_SOLVER read the scraped action log. The ranges
  report flagged a possible ordering bug in scraper.ts parseGameLog (it walks
  the log reversed). If live logs reach the engine newest-first, preflop lines
  will be misread. This needs checking against a real PokerNow log before
  trusting the defaults live.
- SUBGAME_SOLVER stops on a 1500 ms budget. Under heavy load a solve can stop
  on time instead of on the 0.3% target, so sim results with it can depend on
  machine load.

## Subgame cap fix (master/fix-subgame-cap, P0-CRIT-1)

`solveSubgame` used to keep the 200 highest-weight combos per side (120 on the
flop), which cut the bluffs out of narrowed tracker ranges. It now thins ranges
with `reduceRange` (threshold sampling stratified by hand strength; see
docs/POSTFLOP_CFR.md). Regression test: tests/solver/subgame-reduce.test.ts
(8 of its 10 tests fail on the old cap).

A = swarm/next 368b379 with its defaults (FIX_LIVE_VILLAINS only), B = this
branch with `--flags-b FIX_LIVE_VILLAINS,SUBGAME_SOLVER` (new `sim/match.ts`
option that sets one tree's flags), `--workers 1`, 2000 deals:

| run | seed 1 | seed 202 |
|---|---|---|
| hu, A's bb/100 vs B | -7.58 +/- 15.27 | +5.77 +/- 12.83 |
| barreler probe, A - B bb/100 | -49.21 +/- 43.19 | -101.34 +/- 43.13 |

Fold to turn barrel, hu: A 59.5% (22/37) vs B 8.3% (3/36) on seed 1, A 55.3%
(21/38) vs B 11.4% (4/35) on seed 202.

These runs measured the uncommitted branch on top of 368b379 (the outputs say
`368b379+dirty`); it was committed as 673724d and merged into swarm/next at
315dcdd. Raw outputs: `sim/results/2026-10-09/subgame-cap/`. What they show:
with the fix, SUBGAME_SOLVER is heads-up neutral on both seeds (the two point
estimates have opposite signs and both CIs include 0) and beats the barreler
probe on both seeds. The comparison is SUBGAME_SOLVER on vs off, not new cap vs
old cap. The large drop in fold-to-turn-barrel rests on 35 to 37 spots per run
and has not turned into a measured heads-up gain. SUBGAME_SOLVER stays off on
swarm/next until the scraper log order is checked and the latency budget is
settled (the slowest solve below, 1541.6 ms, ran past the 1500 ms budget).

Latency, `sim/latency.ts 200 5 --seats 2`, run at load average 62 to 66:

| config | vs raiser p50 / p95 / max (ms) | vs barreler p50 / p95 / max (ms) |
|---|---|---|
| FIX (swarm/next defaults) | 15.1 / 342.3 / 742.4 | 17.8 / 314.9 / 791.1 |
| FIX+SG (this branch) | 16.0 / 543.5 / 1541.6 | 14.7 / 314.8 / 580.9 |

Subgame path alone (FIX+SG): p95 1195.8 ms vs raiser (n 40), 561.9 ms vs
barreler (n 33). The slow solves are river spots that run to the 1500 ms
budget while closing in on the 0.3% target (0.29% to 0.36% at 270 to 350
iterations under that load).

## Pre-registered heads-up test (NOW-F)

Registered 2026-10-09 at about 05:15 PDT, before any `sim/match.ts` run used
seed 7 (none of the recorded match outputs from this session uses it). The
same text is in `/Users/rg/Downloads/gpo-master/LOG.md`, and the general rules
are in `sim/EVAL_PROTOCOL.md`.

Question: does the default package C1 with the subgame cap fix beat swarm/base
heads-up?

| item | value |
|---|---|
| A | swarm/base b39bc8b, the checkout at `/Users/rg/Downloads/gto-poker-overlay` (it has no engine flags) |
| B | a clean worktree of swarm/next 315dcdd, or of a later commit whose engine sources are unchanged; record the exact commit |
| B flags | `--flags-b FIX_LIVE_VILLAINS,RANGE_TRACKER,SUBGAME_SOLVER`, with `GPO_ENGINE_FLAGS` unset in the shell |
| mode | `--mode hu --deals 22000 --seed 7` |
| workers | any count (hu results do not depend on it; RT reran identically at `--workers 2`); record it |
| load | start only when the 1-minute load average is under 20, and record `uptime` before and after, because SUBGAME_SOLVER stops on a 1500 ms time budget |

Command, run from B's worktree:

```
npx tsx sim/match.ts --a /Users/rg/Downloads/gto-poker-overlay --b <B worktree> \
  --flags-b FIX_LIVE_VILLAINS,RANGE_TRACKER,SUBGAME_SOLVER \
  --mode hu --deals 22000 --seed 7 --workers <K> --out <file>
```

Expected precision: C1's measured sd per deal pair is 7.52 bb (seed 1) and
7.90 bb (seed 101), so 22,000 deals give a 95% half-width of about 4.97 to
5.22 bb/100 (half-width = 98 x sd / sqrt(deals)).

Decision rule, fixed now:

- One run. No re-rolls, no second seed, and no change to the deal count, seed,
  flags or commits after any part of the result is seen.
- A gain counts only if the 95% CI excludes 0 with A's bb/100 negative (B
  ahead). Then RANGE_TRACKER and SUBGAME_SOLVER have heads-up evidence; turning
  them on for live play still waits for the scraper log-order check.
- If the CI excludes 0 with A's bb/100 positive, C1 is a heads-up regression
  and stays off.
- Otherwise the result is "no significant heads-up difference", and it does
  not count as a gain.
- The number is reported whatever it is, with both commits, the worker count,
  the load averages and the wall time.

The same rule covers the other gains planned for today: a blueprint gain from
the overnight evaluation (NOW-E) or an engine gain (NOW-G) counts only if its
95% CI excludes 0 on a run whose seed and size were fixed before it started.
`bp h2h --seed 7` in NOW-E is a different program with its own RNG, so it
does not use up the `sim/match.ts` seed.
