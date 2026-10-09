# Pre-registration: blueprint+search matches (2026-10-09)

Written and committed before any of the runs below started. The only runs
before this file were two smoke tests of 30 deals each (seeds 999 and 998)
that checked the code path; their numbers are not used.

## Agent under test

`blueprint+search:/Users/rg/.gpo/eval/final.bin` (sim/seat-agents.ts): the
BlueprintAgent on the final overnight checkpoint (12,749,175,749 iterations,
tree flags `--preset small --flop 200 --turn 200 --river 200 --bins 50
--abs-seed 7`), with real-time search at every one of its river decisions:
`bp serve` "search" (same code as `bp search`), DCFR (1.5, 0.5, 2), all
river combos, hard budget 1,500 ms, no iteration cap, at least 100
iterations or the decision falls back to the blueprint policy, 1 thread.
Off-tree opponent sizes in the river round are inserted at their real pot
fraction. Turn search is off (a turn solve does not converge in 2.5 s on 4
threads, see blueprint/SEARCH.md).

## Matches

All through `sim/match.ts`, heads-up duplicate, 100 BB, blinds 10/20,
3,000 deals (6,000 hands) per seed, seeds 7 and 101, `--workers 4`.

(a) A = blueprint+search, B = `blueprint:/Users/rg/.gpo/eval/final.bin`
    (the same checkpoint, no search).
(b) A = blueprint+search, B = the ORIGINAL bot: DecisionEngine from
    /Users/rg/Downloads/gto-poker-overlay (branch swarm/base, b39bc8b),
    default flags (GPO_ENGINE_FLAGS unset).

## Decision rule

Report bb/100 for A with the 95% CI from sim/match.ts per seed, and pooled
over both seeds (sim/match-combine.ts style: all 6,000 deal-level samples).
A gain counts only if the 95% CI excludes 0. Also reported: decisions
searched, search fallbacks with reasons, illegal actions, round-trip time
p50/p95 per searched decision, and wall time.
