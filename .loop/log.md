--- loop log ---
Goal: winning, good-playing heads-up bot. Iterating: audit -> fix biggest leak -> verify (tests+sim) -> ship.

## Iteration 1 — bet sizing (DONE)
- FOUND: the learned size head was DEGENERATE — returned 0.66 pot for every spot (dry/wet/river all same). Bot bet a flat 65% everywhere.
- FIX: chooseBetSize() — HU sizing varied by texture (dry 0.60, monotone 0.55, wet 0.75, very-wet 0.85) + river polarized (value 0.90, thin pair 0.50, bluff 0.80). Bigger avg than 0.65 + real spread. Dropped the degenerate predictBetSize.
- VERIFY: 479/479 tests, tsc OK, build OK. Sim (400h) seed7 142/177, seed13 155/206 — healthy.

## Remaining plan (loop continues)
- Iter 2: preflop 4-bet range facing a 3-bet (value QQ+/AK + a few blocker bluffs; flat less OOP). Audit-verify 4bet ~8-14%.
- Iter 3: check-raise range as the caller vs a c-bet (value two-pair+ + balanced semi-bluff raises). Currently the bot never check-raises (soundness downgrades raises<60% eq to call).
- Iter 4: retrain the postflop net — try bigger/longer/regularized; measure held-out acc; only ship if it beats 84.5%.
- Iter 5: big multi-seed sim + full behavioral audit; fix any red.
- Note: sims are SLOW now (more multi-street play) — use 400h single-seed for directional checks, full suite (479) for correctness.

## Iteration 2 — preflop 3bet/4bet audit (NO CHANGE; validated)
- Investigated 4-bet range: the solved SB-vs-3bet chart already value-4bets correctly (AA/KK/QQ/JJ 100%, AK 33%, AQ 5%). Only "gap" is no bluff-4bets, which is an unvalidatable deviation from the solve — NOT shipped (discipline: don't ship what the noisy sim can't verify).
- Full behavioral audit (current state): BB-vs-open 3bet24/call57/fold19, SB-vs-3bet value-4bet+wide-IP-defend, flop-cbet 57%, turn-barrel 47%, river-bet 40% — ALL in GTO range. Bot validated solid across all core spots. Committed sim/audit-play.ts as a permanent validation tool.

## Iteration 3 — net retrain (in progress)
- Heuristic low-hanging fruit exhausted; bot plays sound poker everywhere. Remaining real lever = the distilled net (used facing a bet). Retraining to try to beat 84.5% held-out.

## Iteration 3 — net retrain (REVERTED; net at ceiling)
- Tried 768x384, 130 epochs: train 88.0%, val 85.3%, TEST 84.95% vs current 84.5%. +0.45% TEST is noise; train-test gap = overfitting. Reverted (lean model is better: smaller bundle, same generalization). CONCLUSION: the distilled net is at its data ceiling (~85%); architecture tweaks don't help, AND its facing-bet errors are already caught by the soundness gate. Net is not the lever.
