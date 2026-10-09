# Baseline: swarm/base engine (b39bc8b)

Reference measurements of the engine on `swarm/base` (commit b39bc8b), taken with
the harness on branch `ws/harness`. The engine code under test is identical to
b39bc8b; the harness commits only touch `sim/`, `tests/` and `package.json`.

Every number below was printed by the command shown next to it. They were run on
the shared 11-core machine with other jobs holding the load average around 10 to 15,
so the timings are pessimistic.

Bots play without opponent tracking (the "GTO" mode, `--no-expl`), 100bb deep,
blinds 10/20. bb/100 is the bot's win-rate; the `±` is a 95% confidence half-width.

## Heads-up vs each archetype

```bash
npx tsx sim/run.ts 6000 42 --profiles station,nit,maniac --no-expl
npx tsx sim/run.ts 6000 42 --profiles tag,raiser --no-expl
npx tsx sim/run.ts 6000 42 --profiles barreler,checkraiser --no-expl
```

Each profile is seeded by its name, so splitting the profiles across processes
gives the same numbers as one `npx tsx sim/run.ts 6000 42 --no-expl` run.
6,000 hands per profile; wall time per profile 102 s (nit) to 451 s (station).

| profile | bb/100 | 95% CI | fold-to-raise | fold-to-turn-barrel | fold-to-river-bet | fold-to-flop-bet |
|---|---:|---:|---:|---:|---:|---:|
| station | +211.5 | ±33.8 | 23.7% (42/177) | 58.1% (43/74) | 73.1% (373/510) | 78.7% (485/616) |
| nit | +68.4 | ±17.4 | 25.9% (15/58) | 45.0% (18/40) | 65.6% (59/90) | 74.3% (188/253) |
| maniac | +103.6 | ±60.2 | 28.6% (74/259) | 50.9% (167/328) | 52.8% (112/212) | 79.1% (1867/2359) |
| tag | +60.1 | ±30.1 | 31.9% (58/182) | 53.5% (76/142) | 64.1% (230/359) | 78.1% (869/1113) |
| raiser | +183.6 | ±44.8 | 42.7% (353/826) | 46.8% (52/111) | 69.9% (204/292) | 77.0% (762/990) |
| barreler | +85.2 | ±36.0 | 34.3% (24/70) | 45.8% (190/415) | 39.9% (128/321) | 75.3% (1643/2181) |
| checkraiser | +96.7 | ±37.5 | 58.5% (479/819) | 63.3% (19/30) | 84.9% (180/212) | 84.5% (454/537) |

Barrel frequencies (the bot made the last wager of the previous street and bets
again when it can open the betting):

| profile | turn barrel | river barrel |
|---|---:|---:|
| station | 52.0% (715/1376) | 52.4% (554/1058) |
| nit | 54.8% (91/166) | 51.7% (74/143) |
| maniac | 43.7% (55/126) | 57.4% (39/68) |
| tag | 52.0% (182/350) | 54.6% (124/227) |
| raiser | 60.3% (91/151) | 62.4% (68/109) |
| barreler | 47.7% (113/237) | 64.0% (87/136) |
| checkraiser | 54.0% (202/374) | 53.1% (138/260) |

Other frequencies from the same runs:

| profile | VPIP | PFR | SB open | BB defend | flop cbet | fold-to-cbet | river bet | WTSD | W$SD | postflop AF |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| station | 44.0% | 44.0% | 68.3% | n/a | 55.3% | n/a | 27.0% | 67.7% | 60.4% | 9.85 |
| nit | 35.6% | 35.2% | 67.4% | 57.8% | 56.0% | 68.0% | 28.6% | 53.8% | 57.7% | 3.57 |
| maniac | 61.2% | 38.9% | 66.8% | 62.8% | 51.2% | 76.1% | 29.4% | 13.0% | 82.7% | 0.90 |
| tag | 39.1% | 38.2% | 65.9% | 58.8% | 54.4% | 75.0% | 27.0% | 29.4% | 66.8% | 2.24 |
| raiser | 39.1% | 38.2% | 67.3% | 53.9% | 54.4% | 67.6% | 27.5% | 26.2% | 72.7% | 1.96 |
| barreler | 38.4% | 37.5% | 64.9% | 62.5% | 51.3% | 71.6% | 35.6% | 12.1% | 82.1% | 0.87 |
| checkraiser | 38.3% | 37.6% | 66.1% | 49.5% | 54.9% | 66.7% | 27.1% | 38.9% | 57.2% | 4.41 |

What the baseline says about the tester's complaints:

- The bot folds to a check-raise 58.5% of the time against an opponent who
  check-raises any two cards, and folds 42.7% to a raiser who raises 75% of bets
  with any two cards. The run.ts leak check flags the first (threshold 50%).
- It folds 74% to 85% of the time when an opponent makes the first flop wager,
  against every archetype, including 79.1% vs the maniac and 75.3% vs the barreler.
- River: it folds 84.9% of the time to river bets from the checkraiser, 73.1% from
  the station (whose river bets are value-heavy, so that one is fine) and 39.9%
  from the barreler.
- Barreling: after betting and getting called, it bets the next street about half
  the time against every profile (turn 43.7% to 60.3%), including 52.0% turn and
  52.4% river against a station that almost never folds. Barrel frequency barely
  responds to who the opponent is.
- Fold-to-cbet vs the maniac is 76.1% (HIGH leak flag), the same over-folding.

## 6-max ring

```bash
npx tsx sim/ring-run.ts 10000 42
```

Bot in seat 0, button rotating every hand, field `tag,lag,nit,station,tag` (the
default), 10,000 hands, 898 s wall (11.1 hands/s).

| metric | value |
|---|---|
| bb/100 | +671.3 (±117.8) |
| by position (bb/100) | UTG +463.5±206, MP +399.6±240, CO +843.9±313, BTN +556.5±297, SB +573.6±294, BB +1190.8±354 |
| VPIP / PFR | 28.0% / 26.9% |
| saw flop | 35.2% of hands |
| multiway share of the bot's flops | 92.6% (3,259 multiway, 259 heads-up) |
| net on hands where it saw a flop | heads-up +140.4±193, multiway +2132.8±356 (bb/100 of those hands) |
| WTSD / W$SD | 31.6% / 61.3% |
| fold-to-raise (postflop) | 13.0% (61/470) |
| fold-to-flop-bet | 59.9% (1487/2483) |
| fold-to-turn-barrel | 43.1% (199/462) |
| fold-to-river-bet | 52.4% (285/544) |
| turn barrel | 51.9% (162/312) |
| river barrel | 62.6% (117/187) |

The station and the LAG enter almost every pot, so nearly every flop the bot sees
is multiway. That makes this run exercise the multiway paths (one-villain equity,
folded players counted as live), but the absolute win-rate mostly reflects how
exploitable the scripted callers are. Use it as a reference for the same command on
a candidate, and use `match.ts --mode field --seats 6` for the paired comparison.
An earlier attempt at 20,000 hands was stopped after 28 minutes to stay inside the
20-minute bound; it produced no numbers.

## Harness validation and noise calibration

Two checks that the duplicate runner detects real differences, and the per-deal
noise used to size the comparison runs. Engine A in both was a scratch copy outside
the repo:

- `eng-f812efb`: `git archive f812efb src` (the engine before commit f2699ef, which
  switched 6-max preflop from the HU ranges to the 6-max charts and moved a river
  soundness threshold from 0.5 to 0.65).
- `eng-nonet`: `git archive HEAD src` with one line changed in `decidePostflop` so
  the distilled postflop net never runs (every postflop decision goes through
  `decidePostflopRanged`).

| A | B (base) | mode | deals | result (A minus B) | sd per deal | wall |
|---|---|---|---:|---|---:|---:|
| eng-f812efb | b39bc8b | hu | 1000 | +0.00 bb/100 ±0.00 | 0.00 bb | 120 s, 2 workers |
| eng-f812efb | b39bc8b | field, 6 seats | 1500 | +389.83 bb/100 ±225.31 | 44.52 bb | 301 s, 2 workers |
| eng-nonet | b39bc8b | hu | 1500 | -48.32 bb/100 ±19.68 | 7.78 bb (per pair) | 194 s, 3 workers |
| eng-nonet | b39bc8b | field, 2 seats vs raiser | 1500 | +25.32 bb/100 ±60.17 | 11.89 bb | 115 s, 3 workers |

Commands (with `$S` the scratch directory holding the copies):

```bash
npx tsx sim/match.ts --a $S/eng-f812efb --b /Users/rg/Downloads/gto-poker-overlay --mode hu --deals 1000 --seed 1 --workers 2
npx tsx sim/match.ts --a $S/eng-f812efb --b /Users/rg/Downloads/gto-poker-overlay --mode field --seats 6 --deals 1500 --seed 1 --workers 2
npx tsx sim/match.ts --a $S/eng-nonet --b /Users/rg/Downloads/gto-poker-overlay --mode hu --deals 1500 --seed 1 --workers 3
npx tsx sim/match.ts --a $S/eng-nonet --b /Users/rg/Downloads/gto-poker-overlay --mode field --seats 2 --field raiser --deals 1500 --seed 1 --workers 3
```

Readings:

- Heads-up, f812efb and b39bc8b played all 2,000 games identically. The only
  heads-up difference between them is the river threshold window [0.5, 0.65), which
  never came up in those games. In 6-max the preflop change shows up clearly.
- The 6-max result favors the OLDER engine, whose 78%-wide HU ranges were used at
  every position. Against this scripted field (two TAGs, a LAG, a nit and a station)
  playing far too loose won. The likely reason is that the scripted players fold and
  call by fixed equity thresholds that loose play exploits, so a 6-max field number
  partly measures exploitation of these scripts. Read it together with the heads-up head-to-head result, and do not treat a
  6-max gain on its own as evidence of a better engine.
- Disabling the net costs 48 bb/100 head-to-head (CI excludes 0) while it lowers
  fold-to-raise vs the raiser from 43.7% to 13.5% (A vs B in the field run). The
  pressure metrics move long before bb/100 does.

Noise for sizing runs (95% CI half-width as a function of deals D, from the sd above):

- heads-up A vs B: 1.96 x 100 x 7.78 / 2 / sqrt(D), about 762 / sqrt(D) bb/100
  (5,000 deals: about ±10.8).
- field vs one archetype: about 2330 / sqrt(D) (6,000 deals: about ±30).
- 6-max field: about 8725 / sqrt(D) for engines whose preflop ranges differ
  (4,000 deals: about ±138). Changes that leave preflop alone diverge later in the
  hand and should be less noisy, but that was not measured.

## Harness self-checks

```bash
npx tsx sim/run.ts --selftest
npx tsx sim/ring-run.ts --selftest
npx tsx sim/match.ts --deals 40 --seed 3
npx tsx sim/match.ts --a /Users/rg/Downloads/gto-poker-overlay --b . --mode field --seats 6 --deals 60 --seed 5 --workers 3
```

- HU self-test: always-jam vs always-fold +75.0 bb/100 (exact), mirror TAG vs TAG
  over 3,000 hands +17.1 bb/100 (noise; no CI is printed for this check).
- Ring self-test: 15,000 random hands at table sizes 2 to 6 with uneven stacks,
  12,503 showdowns, 10,652 hands needing a side pot, chip conservation and full pot
  payout asserted on every hand.
- The engine against itself: exactly +0.00 bb/100 with sd 0.00, both from the same
  tree and across trees (main checkout vs this worktree).
- `--workers 3` and `--workers 1` produced byte-identical summaries for the same
  seed.
