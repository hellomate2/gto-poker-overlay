# swarm/integrate: flag ablation

All six workstream branches (ws/harness, ws/ranges, ws/multiway, ws/defense,
ws/subgame, ws/blueprint) are merged. The engine wiring lives in
`src/core/engine.ts` behind the flags in `src/core/engine-flags.ts`. The
blueprint stays offline: `src/core/blueprint/loader.ts` and its tests are
present, nothing in the live engine calls it.

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
CIs are 95%. The fold columns read "base -> candidate". The runs used engine
commit 61bb8df, except MW2, FIXMW2, FIXRT, FIXRTMW, C1, C2, RTDEF and
FIX-s2, which used 479307a or later (the multiway range fix; it only changes
MULTIWAY_EQUITY behavior). r6-ALL was rerun on 479307a and reproduced
-473.39 +/- 262.63 exactly.

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

ON: FIX_LIVE_VILLAINS, RANGE_TRACKER, SUBGAME_SOLVER. OFF: DEFENSE,
MULTIWAY_EQUITY. The reasons are in the comment on `DEFAULT_ENGINE_FLAGS`.

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
