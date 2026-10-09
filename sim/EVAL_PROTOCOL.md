# Engine evaluation protocol

How engine changes are measured from 2026-10-09 on. It exists because the
integration round (sim/INTEGRATION.md) produced gains that did not hold up: the
6-max field gains for RANGE_TRACKER and the default package did not replicate on
a fresh seed, and DEFENSE won against scripted probes while losing heads-up to
the engine it was meant to improve. Every measured number quoted here is in a
match output under `sim/results/2026-10-09/`; derived numbers show their
formula.

## The comparison

Every measurement is a `sim/match.ts` duplicate match between a reference tree A
and a candidate tree B.

- Record both commits. The match output prints them; an output that says
  `+dirty` measured uncommitted code, so name the commit that code became.
- Set flags per tree with `--flags-a` / `--flags-b` and leave `GPO_ENGINE_FLAGS`
  unset, so each tree's config is explicit in the command.
- Sign convention: hu mode prints A's bb/100, field mode prints A - B. Negative
  means the candidate did better.
- Save the full output with `--out` and commit it under `sim/results/<date>/`.
  Scratchpad paths under /private/tmp do not survive.

## Which mode answers which question

| mode | what it measures | use for decisions |
|---|---|---|
| `--mode hu` | candidate vs reference heads-up, both seatings per deal | yes, this is the strength measurement |
| `--mode field --seats 2 --field <probe>` | candidate vs reference against one scripted archetype | only as "beats this scripted bot"; never as strength |
| `--mode field --seats 6` | candidate vs reference in a scripted 6-max field | frozen for decisions |

Probe and 6-max results are frozen as decision evidence for two measured
reasons. First, scripted opponents reward counter-exploits: DEFENSE beat base
against the raiser, barreler and checkraiser probes (-96.58 +/- 65.83,
-99.77 +/- 54.44 and -55.54 +/- 47.87, seed 1) but lost heads-up
(+22.61 +/- 18.49 for base, seed 1). Second, the 6-max gains did not replicate:
RANGE_TRACKER -159.11 +/- 137.99 on seed 1 and -30.97 +/- 156.20 on seed 101,
the default package -173.73 +/- 138.39 and -37.25 +/- 156.32. The sim README
also warns that the scripted field rewards loose play.

## Seeds

- Every engine-behavior change is measured on two seeds. The development seeds
  so far are 1 and 202 (and 2, 3 and 5 for small checks).
- Seed 101 served as the held-out seed for the integration claims. It has now
  been seen, so it counts as a development seed from here on.
- Held-out rule: a seed used while building or tuning a change cannot confirm
  that change. Confirmation needs a seed nobody looked at during development,
  chosen before the run.
- Seed 7 is reserved for the pre-registered heads-up test (NOW-F). No other
  `sim/match.ts` run may use it. The `bp` C++ tools have their own RNG, so
  `bp h2h --seed 7` does not touch this reservation.

## Equal workers

Heads-up results do not depend on `--workers`: RANGE_TRACKER heads-up gave
+1.40 +/- 10.46 at 1 and at 2 workers. Field results do: the raiser probe for
RANGE_TRACKER gave -64.17 +/- 46.44 at 1 worker and -64.64 +/- 46.53 at 2, and
base's own result against the probe moved from +197.09 to +202.64. Compare
field runs only at equal `--workers`. The match output does not print the
worker count, so write it next to every result.

On the shared Mac, run one sim at a time with `--workers 1`, and start only when
the 1-minute load average is under 20. SUBGAME_SOLVER stops on a 1500 ms time
budget, so heavy load can change its decisions; record `uptime` before and after
any run with that flag on.

## Deal counts from the measured spread

`sim/match.ts` takes one sample per deal and prints its sd. The 95% half-width
is then:

- hu mode (sd per deal pair, 2 hands per sample): H = 98 x sd / sqrt(D)
- field mode (sd per deal, 1 hand per sample): H = 196 x sd / sqrt(D)

so the deals needed for a target half-width are D = (98 x sd / H)^2 heads-up and
D = (196 x sd / H)^2 in field mode. Both formulas reproduce the printed CIs (hu
C1: 98 x 7.52 / sqrt(3000) = 13.45, printed 13.46).

Measured sds and the deals they imply:

| measurement | sd (bb) | source runs | deals for +/- 10 bb/100 | deals for +/- 5 bb/100 |
|---|---|---|---|---|
| hu, cap fix SG vs FIX | 5.85 to 6.97 | subgame-cap/hu-s202.md, hu-s1.md | 3,287 to 4,666 | 13,147 to 18,663 |
| hu, C1 vs base | 7.52 to 7.90 | integrate/hu-C1.txt, heldout-s101/hu-C1-s101.txt | 5,432 to 5,994 | 21,725 to 23,976 |
| hu, DEF vs base | 8.42 to 10.33 | heldout-s101/hu-DEF-s101.txt, integrate/hu-DEF.txt | 6,809 to 10,249 | 27,236 to 40,994 |

| measurement | sd (bb) | source runs | deals for +/- 50 bb/100 | deals for +/- 25 bb/100 |
|---|---|---|---|---|
| probe, RT and C1 | 9.68 to 16.00 | heldout-s101/p-tag-RT-s101.txt, p-raiser-C1-s101.txt | 1,440 to 3,934 | 5,760 to 15,736 |
| 6-max, C1 | 35.67 to 38.67 | heldout-s101/r6-C1-s101.txt, integrate/r6-C1.txt | 19,552 to 22,979 | 78,206 to 91,914 |

What this means in practice: the 2,000 to 3,000-deal heads-up runs so far have
half-widths of 10.44 to 20.43 bb/100 and cannot resolve effects of 5 to 10 bb/100.
Pick D from the sd of the closest earlier run before starting, and write it
down. If no comparable sd exists, run a small pilot only to measure sd, then
discard the pilot's bb/100.

## Decision rule

- A gain counts only if its 95% CI excludes 0 in the candidate's favor, on a run
  whose seed, deal count and configs were fixed before it started.
- One run per pre-registered test. No re-rolls with another seed, no extending
  the deal count after looking, no dropping a run that came out badly.
- A CI that includes 0 is reported as "no significant difference". It is not a
  gain and it is not proof of no effect; quote the half-width with it.
- "No regression" for a merge means the CI does not exclude 0 in the
  reference's favor. The heads-up half-widths so far run from 10.44 to 20.43
  bb/100, so this check is weak; say so when it is the only evidence.
- A gain that is significant on one seed and not on the other counts as not
  replicated. (DEFENSE's heads-up loss is in that state: significant on seed 1,
  same sign but not significant on seed 101.)
- Report every pre-registered result, with commits, flags, seed, deals,
  workers, load average and wall time, whatever the outcome.

## Current pre-registration

NOW-F, registered 2026-10-09 at about 05:15 PDT: C1 (FIX_LIVE_VILLAINS +
RANGE_TRACKER + SUBGAME_SOLVER) on swarm/next 315dcdd vs swarm/base b39bc8b,
`--mode hu --deals 22000 --seed 7`, one run, a gain counts only if the 95% CI
excludes 0. The full specification, including the command, is at the end of
sim/INTEGRATION.md.
