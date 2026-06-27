--- loop log ---
Goal: winning, good-playing heads-up bot. Iterating: audit -> fix biggest leak -> verify (tests+sim) -> ship.

## Iteration 1 — bet sizing (DONE)
- FOUND: the learned size head was DEGENERATE — returned 0.66 pot for every spot (dry/wet/river all same). Bot bet a flat 65% everywhere.
- FIX: chooseBetSize() — HU sizing varied by texture (dry 0.60, monotone 0.55, wet 0.75, very-wet 0.85) + river polarized (value 0.90, thin pair 0.50, bluff 0.80). Bigger avg than 0.65 + real spread. Dropped the degenerate predictBetSize.
- VERIFY: 479/479 tests, tsc OK, build OK. Sim (400h) seed7 142/177, seed13 155/206 — healthy.
