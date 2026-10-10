# Open-source code survey for a Pluribus-level NLHE bot

Topic key: `open-source`. Compiled 2026-10-09. Repo metadata (license, language, stars, last push) was pulled live from the GitHub API with `gh api repos/<owner>/<repo>` on that date. Anything not checked directly is marked "unverified".

Unit note used throughout: 1 bb/100 = 10 mbb/g (milli-big-blinds per game/hand).

---

## 1. Summary table

| Project | URL | License | Lang | Last push | What it really is | Verdict |
|---|---|---|---|---|---|---|
| OpenSpiel | https://github.com/google-deepmind/open_spiel | Apache-2.0 | C++/Python | 2026-08-31 (v2.0.2 on 2026-08-12) | General game library. CFR, CFR+, DCFR, ES/OS-MCCFR, exact best response and exploitability, Deep CFR (PyTorch and JAX), ESCHER, NFSP, plus `universal_poker` (ACPC game-def wrapper) | Adopt for correctness gates and Deep CFR baselines |
| slumbot2019 | https://github.com/ericgjackson/slumbot2019 | MIT | C++17 | 2023-09-18 | Eric Jackson's research code behind Slumbot: CFR+, external-sampling and targeted MCCFR, card and betting abstraction builders, real-game best response, head-to-head, endgame resolving, multiplayer MCCFR | Adopt as reference and as a local sparring partner |
| Slumbot API | https://www.slumbot.com/ (sample client: https://www.slumbot.com/sample_api.py) | No written terms found | HTTPS/JSON | Live (checked 2026-10-09) | Free online HUNL bot, 200 BB, 50/100 blinds | Adopt as the primary public benchmark |
| GTO Wizard Benchmark API | https://github.com/gtowizard-ai/researcher-api-client, paper https://arxiv.org/abs/2603.23660 | Client: no license file; API key by request | Python client, REST API | Client 2026-04-09 | Play HUNL 200 BB against GTO Wizard AI, AIVAT-scored, public leaderboard | Adopt as the second benchmark (stronger opponent, lower variance) |
| hand-isomorphism (Waugh) | https://github.com/kdub0/hand-isomorphism | Old-style BSD permissive (LICENSE.txt, with an unfilled `<organization>` placeholder) | C | 2014-08-01 | Exact suit-isomorphic hand indexing (Waugh 2013) | Adopt into the C++ trainer |
| robopoker | https://github.com/krukah/robopoker | MIT | Rust | 2026-09-10 (912 commits) | The most complete open Pluribus-style NLHE stack: evaluator, isomorphism, hierarchical k-means with EMD, MCCFR blueprint, depth-limited and safe subgame solving, AIVAT, Slumbot client | Read closely; use as a published baseline number |
| PokerHandEvaluator (phevaluator) | https://github.com/HenryRLee/PokerHandEvaluator | Apache-2.0 | C/C++/Python | 2026-09-14 | Perfect-hash 5 to 7 card evaluator, about 100 KB tables | Already the basis of the local evaluator; keep |
| OMPEval | https://github.com/zekyll/OMPEval | ISC | C++ | 2020-06-30 | Fast evaluator plus multithreaded equity calculator with range syntax | Optional, for equity features and testing |
| 2+2 evaluator | https://github.com/tangentforks/TwoPlusTwoHandEvaluator | Unclear (see below) | C | 2023-04-11 | 32,487,834-entry state-machine table | Skip |
| ACPC server | https://github.com/jblespiau/project_acpc_server (mirror of v1.0.42) | MIT-style (University of Alberta, 2011) | C | 2021-04-13 | Dealer, match protocol, game-definition files | Optional, for local bot-vs-bot matches in a standard protocol |
| PokerRL / Deep-CFR / DREAM | https://github.com/EricSteinberger/PokerRL , /Deep-CFR , /DREAM | MIT | Python | 2023-03-31 / 2020-05-06 / 2024-07-25 | Deep CFR, Single Deep CFR, DREAM, NFSP, LBR and RL-BR evaluation | Reference only (pinned to PyTorch 0.4.1, Python 3.6) |
| fedden/poker_ai (and fork keithlee96/pluribus-poker-AI) | https://github.com/fedden/poker_ai | GPL-3.0 (LICENSE file; GitHub shows NOASSERTION) | Python | 2023-04-03, archived | Pluribus-inspired MCCFR on a 20-card short deck only | Skip |
| b-inary/postflop-solver | https://github.com/b-inary/postflop-solver | AGPL-3.0 | Rust | 2024-07-09, development suspended Oct 2023 | Fast exact DCFR postflop solver, no abstraction | Use only as an external oracle; never link into MIT code |
| TexasSolver | https://github.com/bupticybee/TexasSolver | AGPL-3.0 (commercial license sold) | C++ | 2026-10-08 | Exact postflop solver with GUI | Same as above |
| noambrown/poker_solver | https://github.com/noambrown/poker_solver | MIT | Python/C++ | 2026-01-05 | River subgame solver (CFR, CFR+, DCFR, ES-MCCFR, FP) validated on Kuhn and Leduc | Useful MIT reference for river resolving |
| facebookresearch/rebel | https://github.com/facebookresearch/rebel | Apache-2.0 | C++/Python | 2024-03-20, archived | ReBeL for Liar's Dice only; no poker code | Reference only |
| DeepStack-Leduc / DeepHoldem | https://github.com/lifrordi/DeepStack-Leduc , https://github.com/happypepper/DeepHoldem | No license | Lua (Torch7) | 2018 | DeepStack on Leduc; community HUNL port | Skip (no license, dead stack) |
| conorarmstrong/noregrets | https://github.com/conorarmstrong/noregrets | MIT (12-month delayed release) | Rust | 2026-09-08 | Claims 2 to 6 player NLHE with postflop re-solving; blueprints commercial only | Watch; not usable for weights |
| dberweger2017/deepcfr-texas-no-limit-holdem-6-players | https://github.com/dberweger2017/deepcfr-texas-no-limit-holdem-6-players | MIT | Python (+ Rust `pokers` engine) | 2026-10-09 | Despite the name, now a heads-up 20 BB tabular CFR bot with careful LBR evaluation; roadmap lists 200 BB and Slumbot later | Methodology reference for paired evaluation |
| pokerkit | https://github.com/uoftcprg/pokerkit | MIT | Python | 2026-09-21 | Rules engine for many variants, evaluator, hand-history support | Use for a rules cross-check and PHH parsing |
| phh-dataset | https://github.com/uoftcprg/phh-dataset | MIT | data | 2025-09-18 | Includes all 10,000 Pluribus hands from the Science supplement, plus pointers to ACPC logs | Use for paper analysis and sanity checks |

Small or stub Pluribus reimplementations checked and rejected: whatsdis/pluribus (no license, WIP port aimed at a real-money site client, which also makes it unsuitable), zanussbaum/pluribus (no license, Kuhn and Leduc only), agnarbjoernstad/Pluribus (MIT, C++, Kuhn only per its own roadmap), yeeyangtee/pluribus and rockymartin0124/Pluribus-Poker-AI (forks of poker_ai lineage, 4 stars each).

---

## 2. Project-by-project notes

### 2.1 OpenSpiel (google-deepmind/open_spiel)

- Verified: Apache-2.0, C++ core with Python bindings, 5.5k stars, last push 2026-08-31, release v2.0.2 on 2026-08-12.
- C++ algorithms present in `open_spiel/algorithms/`: `cfr`, `cfr_br`, `external_sampling_mccfr` (with `AverageType::kSimple` and `kFull`), `outcome_sampling_mccfr`, `best_response`, `tabular_exploitability`, `oos`, `is_mcts`.
- Python: `cfr.py`, `discounted_cfr.py`, `external_sampling_mccfr.py`, `outcome_sampling_mccfr.py`, `exploitability.py`, `efr.py`, `mmd_dilated.py`, `sequence_form_lp.py`. Deep methods moved into `python/pytorch/` (`deep_cfr.py`, `escher.py`, `nfsp.py`, `rcfr.py`, `neurd.py`) and `python/jax/` (`deep_cfr.py`, `nfsp.py`, `cfr/`).
- `universal_poker`: wraps the ACPC game-definition code (originally from https://github.com/ethansbrown/acpc). It is an optional build dependency switched on with `OPEN_SPIEL_BUILD_WITH_ACPC=ON` (see `open_spiel/scripts/global_variables.sh`). Parameters include `numPlayers`, `betting` ("nolimit"), `stack`, `blind`, and `bettingAbstraction` with values `fc`, `fcpa` (fold, call, pot, all-in; the default), `fchpa` (adds half-pot) and `fullgame`. It also accepts `potSize`, `boardCards` and `handReaches` so a single river or turn subgame with given ranges can be instantiated. The README warns it "has not been extensively reviewed or tested" by the DeepMind team.
- What to use it for:
  1. Correctness gates. Run our C++ trainer and OpenSpiel's CFR or ES-MCCFR on Kuhn and Leduc and compare exploitability curves. Our trainer already has its own Kuhn and Leduc gate, so OpenSpiel is a second, independent oracle.
  2. A small no-limit sanity game. `universal_poker` with a tiny deck and `fcpa` gives a game where OpenSpiel's exact best response runs, so our no-limit tree code (side cases like all-in, min-raise) can be checked against an independent implementation.
  3. Deep CFR and ESCHER baselines in PyTorch if the paper wants a neural comparison.
- Pitfall: `universal_poker` with `fullgame` on real HUNL is far too large for OpenSpiel's tabular tools. Only use it on reduced games.

### 2.2 slumbot2019 (ericgjackson/slumbot2019)

- Verified: MIT, C++17, 178 stars, last push 2023-09-18. README says gcc 7.3 is known to work.
- What it implements (from the README): CFR+ and MCCFR (external sampling in `ecfr.cpp`, "targeted CFR" in `tcfr.cpp`), card abstraction builders (`build_null_buckets` for lossless isomorphism, `build_rollout_features`, `build_unique_buckets`, k-means buckets), betting abstraction builder with reentrant trees for multiplayer, real-game best response (`run_rgbr`), head-to-head (`head_to_head`, `play`), and subgame resolving (`solve_all_subgames`, `assemble_subgames`, and resolving inside `head_to_head`). Multiplayer is supported by MCCFR only; CFR+ and real-game best response are heads-up only.
- Parameter-file driven: separate files for game, card abstraction, betting abstraction and CFR settings.
- Why it matters for us:
  - It is the closest thing to "the code that produced the benchmark bot". The live Slumbot was built by the same author, so it is a good source of design decisions (tree shapes, bucket features, resolving variants). Whether the live bot was built from exactly this code is unverified.
  - `run_rgbr` (real-game best response against an abstracted strategy, heads-up) is something our trainer lacks for full hold'em. Reading it is a cheap way to add an exploitability metric for small abstractions.
  - We can train a local Slumbot-like sparring partner on a rented box and play unlimited local matches without hitting the public server.
- Pitfalls: several README sections are "TODO" (resolving methods, disk-based CFR+, asymmetric abstractions). Code assumes two hole cards and one-card turn and river. File paths are set in `Files::Init()`.

### 2.3 Slumbot public API (benchmark)

Verified from the slumbot.com page bundle and https://www.slumbot.com/sample_api.py, and by a live `curl` to `new_hand` on 2026-10-09 which returned a hand.

- Format: heads-up NLHE, blinds 50/100, stacks 200 BB (20,000 chips), stacks reset every hand. You start a session in the big blind; the site recommends playing an even number of hands so position balances.
- Endpoints (HTTPS POST, JSON body, `Content-Type: application/json`, host `slumbot.com`):
  - `/slumbot/api/login` with `{"username","password"}` (account must be registered on the website first; only needed if you want leaderboard placement).
  - `/slumbot/api/new_hand` with `{"token": ...}` (token optional on the very first call).
  - `/slumbot/api/act` with `{"token": ..., "incr": "c"}`.
- Response fields: `old_action`, `action`, `client_pos` (0 = big blind, acts second preflop and first postflop; 1 = small blind), `hole_cards`, `board`, `token`, and `winnings` when the hand ends; `error_msg` on failure. Always replace your token with any new one returned.
- Action string: `k` check, `c` call, `f` fold, `b<N>` bet or raise where N is the chips that player has put in on the current street only; streets separated by `/`. All-ins can leave empty streets, e.g. `b20000c///`.
- Timeout: five minutes per action (site news item, 2017).
- Terms: the page says the API exists so "researchers and hobbyists can test their bots". I did not find written terms of service, rate limits or a hand cap. Treat it as a shared free resource: run a modest number of concurrent sessions and identify yourself via a registered username. Rate limits: unverified.
- Site history: Feb 2017 release of the 2017 Slumbot; a later fix made it less weak-tight on the river; Dec 7 2022 backend reimplementation that the author says left play unchanged, with leaderboards cleared because of earlier exploits. Slumbot won the 2018 ACPC heads-up event (http://www.computerpokercompetition.org/).
- The site also shows a "baseline" statistic: Slumbot plays itself on the same cards and your result is compared against that, a duplicate-style luck control. Whether the API returns the baseline is unverified (the sample client only reads `winnings`).
- Existing clients: the official `sample_api.py`; robopoker's `spar` crate (Rust, MIT); salujajustin/slumbot_api (C++, no license, 1 star).

#### Reported results against Slumbot (all heads-up, 200 BB)

| Agent | Result vs Slumbot | Hands / method | Source |
|---|---|---|---|
| GTO Wizard AI | +19.4 ± 4.1 bb/100 (= +194 mbb/g) | 150,000 hands (2022 match, AIVAT per the benchmark paper's framing) | https://arxiv.org/abs/2603.23660 |
| Supremus (DeepStack-style with DCFR+ on GPU) | +176 ± 44 mbb/g | 150,000 hands; all-in EV used for variance reduction | https://arxiv.org/abs/2007.10442 |
| AlphaHoldem (end-to-end RL, 3 days on 8 GPUs + 64 cores) | +111.56 mbb/h (paper's table reports 95% CIs) | the abstract says 100,000 hands, the introduction says 200,000; unresolved | https://ojs.aaai.org/index.php/AAAI/article/view/20394 |
| OpenStack (AlphaHoldem authors' DeepStack reimplementation) | +103.08 mbb/h | 100,000 games | same AlphaHoldem paper |
| ReBeL (CFR-AVG) | +45 ± 5 mbb/g (± is one standard deviation) | AIVAT | https://arxiv.org/abs/2007.13544 (Table 1) |
| ReBeL (CFR-D variant) | +39 ± 6 mbb/g | AIVAT | same, appendix |
| Modicum (depth-limited solving, Brown/Sandholm/Amos 2018) | +11 ± 5 mbb/g | as cited in ReBeL Table 1 | https://arxiv.org/abs/2007.13544 |
| DeepStack reimplementation by Zarick et al. | -63 ± 40 mbb/g | 150,000 hands | https://arxiv.org/abs/2007.10442 |
| robopoker `world+dirac` (best variant) | -13.1 ± 14.0 bb/100 (95% CI) | 86.0K hands, live API | https://github.com/krukah/robopoker (README Table 1) |
| robopoker blueprint only (`base`) | -32.4 ± 6.1 bb/100 | 480K hands | same |

Caveats for the paper: these matches span 2018 to 2026 and the exact Slumbot build each faced is not documented, so cross-paper comparison is loose. The two DeepStack reimplementations disagree in sign (-63 vs +103), which shows how sensitive these numbers are to implementation detail. Report our own number with hand count, CI, and whether AIVAT or all-in EV was applied.

What "Pluribus level" means against Slumbot is not directly published: Pluribus never played Slumbot (Pluribus is 6-max). For heads-up, a reasonable target ladder is: beat Slumbot at all (Modicum level, +11 mbb/g), then ReBeL level (+45 mbb/g), then the DeepStack-family level (+100 to +190 mbb/g).

Hands needed (back-of-envelope): robopoker's numbers imply a raw per-hand std of roughly 14.0/1.96 × sqrt(86,000)/100 ≈ 21 bb per hand without AIVAT. At that std, a ±5 bb/100 95% CI needs about (1.96 × 21 / 0.05)² ≈ 680K hands raw. AIVAT's claimed 10x reduction would bring that to tens of thousands. This is my arithmetic from the cited figures, not a published number.

### 2.4 GTO Wizard Benchmark (gtowizard-ai/researcher-api-client)

- Paper: "GTO Wizard Benchmark", Provost, Ilenic, Solinas, Beardsell, arXiv 2603.23660, submitted 2026-03-24 (CC BY 4.0). https://arxiv.org/abs/2603.23660
- Game: HUNL, blinds 50/100, 200 BB stacks, reset every hand (same as Slumbot and the ACPC). Game name in the API is `HUNL 200BB`.
- AIVAT is built into scoring. The paper says AIVAT cut standard deviation about threefold, so roughly 10x fewer hands for the same confidence.
- Opponent strength: GTO Wizard AI beat Slumbot by 19.4 ± 4.1 bb/100 over 150,000 hands (paper).
- Access: request a key at https://benchmark.gtowizard.com/. The README says the API only allows playing hands and seeing results, gives no solver access, and keys can be revoked for misuse. Client needs Python 3.13+ and `uv`. Client repo has no license file (GitHub reports none).
- REST endpoints (from https://researcher.gtowizard.com/openapi.json, titled "Ruse AI Researcher API"): `POST /hands` (new hand), `POST /hands/{hand_id}/act`, `GET /hands/in-progress`, `GET /results`, `GET /leaderboard`, `GET /winnings`, `POST /users/request`. Action enum `f`, `k`, `c`, `b`. Result fields include `aivat_score_bb_per_100`, `aivat_std_bb_per_100`, `chance_correction_bb_per_100`, `action_correction_bb_per_100`, `all_hands_chips_bb_per_100`, `bb_per_100`.
- The leaderboard endpoint is public (no key). Snapshot pulled 2026-10-09 with `min_hands=1000`: best entry "Competitor" at -2.96 bb/100 AIVAT over 200,002 hands (std 0.46); "MikkaMakka" -3.18 over 179,028; "Marvel" (MIT) -4.57 over 124,029; a human professional entry at -3.91 over 2,958 hands; LLM entries around -5.4 to -8.8. Source: `GET https://researcher.gtowizard.com/leaderboard?game_name=HUNL%20200BB&limit=30`. Nobody on the board had a positive AIVAT score in that snapshot.
- LLM results in the paper: best model GPT-5.3 (Extra High reasoning) at -16 ± 3.0 bb/100 over 5,000 hands per model.
- Why use it: AIVAT is computed server-side by the side that knows its own strategy, which is exactly the setting where AIVAT is valid. It also gives a public, citable leaderboard position for the paper. Being close to zero against it is a strong claim.

### 2.5 hand-isomorphism (kdub0/hand-isomorphism)

- Verified: C, last push 2014-08-01, 73 stars. LICENSE.txt is an old BSD-style permissive notice (copyright Kevin Waugh 2013) with an unfilled `<organization>` placeholder; GitHub reports NOASSERTION. Redistribution with the notice preserved is allowed. Paper: K. Waugh, "A Fast and Optimal Hand Isomorphism Algorithm", AAAI 2013 Computer Poker workshop (cited in the README).
- API: `hand_indexer_init(rounds, cards_per_round, &indexer)`, `hand_indexer_size(&indexer, round)`, `hand_index_last`, `hand_index_all`, `hand_unindex`. Indices are dense and invertible.
- I built it on this Mac (Apple clang, `-std=gnu99`, compile `hand_index.c` plus `deck.c`) and measured:
  - Imperfect-recall per-street indexers: flop {2,3} = 1,286,792; turn {2,4} = 13,960,050; river {2,5} = 123,156,254. Preflop = 169.
  - Perfect-recall indexer {2,3,1,1}: 169 / 1,286,792 / 55,190,538 / 2,428,287,420.
  - Speed: 20M `hand_index_last` calls on river hands in 0.66 s single-threaded (about 30M/s), a rough microbenchmark.
- Comparison with the local trainer (`/Users/rg/Downloads/gpo-wt/blueprint/blueprint/src/abstraction.h`): it indexes tables as canonical board × 1,326 hole combos, i.e. 1,755 × 1,326 = 2,327,130 flop slots, 16,432 × 1,326 = 21,788,832 turn slots and 134,459 × 1,326 = 178,292,634 river slots (178 MB at one byte). Waugh indexing would shrink these to 1,286,792 / 13,960,050 / 123,156,254 (about 45%, 36% and 31% fewer), drop the impossible board-overlap slots, and cut feature-computation time for k-means by the same ratio. That headroom can go into more buckets.

### 2.6 robopoker (krukah/robopoker)

- Verified: MIT, Rust, 225 stars, 912 commits, last push 2026-09-10. Twelve crates published to crates.io.
- Components (README): `deuce` (cards, evaluator, isomorphism), `lloyd` (hierarchical k-means, k-means++ seeding, Elkan acceleration), `monge` (Sinkhorn/Greenkhorn optimal transport for EMD between next-street distributions), `mccfr` (game-agnostic external-sampling MCCFR with pluggable regret and policy rules), `nlhe` (discounted and linear regret, regret-based pruning, "Flagship" config), `subgame` (depth-limited and safe "multi-world" re-solving), `pokerkit` crate (action translation by pseudo-harmonic mapping), `arena` (AIVAT over hand histories), `spar` (Slumbot client), `litmus` (strategy sanity tests), PostgreSQL persistence (`daybook`).
- Results against Slumbot are in the table above; best -13.1 ± 14.0 bb/100. Their own analysis: switching from sampling the mixed strategy to playing the argmax ("dirac") helped most; search alone did not.
- The `litmus` idea is worth copying: a fast suite of assertions on the blueprint (suited/offsuit symmetry, monotone aggression with hand strength, BB defends, premium hands not collapsing to jam). Their table shows 34 pass / 6 fail at 151.7M epochs and 156K infosets, and attributes the failures to a flop k-means bucket merging AQo through A5o.
- AIVAT caveat (my reading of `crates/arena/src/aivat.rs`): it applies corrections at hero action nodes, villain action nodes ("negated hero-perspective correction") and chance nodes. AIVAT is only unbiased for action corrections at nodes where the true strategy of the acting player is known. If villain is Slumbot and the correction uses our blueprint's policy as a stand-in for Slumbot's, that term can introduce bias. Unverified whether robopoker actually does that; check before reusing the code or quoting its AIVAT numbers.
- Take from it: architecture reference for EMD-based abstraction and safe re-solving, a working Slumbot client, and a published baseline. Its PostgreSQL dependency makes it heavier than our self-contained C++ path.

### 2.7 Hand evaluators

- phevaluator (HenryRLee/PokerHandEvaluator): Apache-2.0, C/C++ with Python bindings, last push 2026-09-14. Perfect-hash approach, about 100 KB tables for 7-card evaluation (README). Supports 5 to 7 cards and PLO4/5/6. The local C++ trainer's `eval.h` says it follows the same flush-plus-quinary idea and builds its tables at startup; keep that and cite phevaluator in the paper.
- OMPEval (zekyll/OMPEval): ISC, C++, last push 2020-06-30. 16-bit rank output, about 200 KB tables, about 10 ms init, SSE2/SSE4. The README's single-thread benchmark on an Intel 3770k (64-bit TDM-GCC): sequential 775 Meval/s, random-order 272 Meval/s; the 2+2 evaluator scored 1,588 sequential but only 19 random-order on the same machine. It also ships a multithreaded equity calculator with EquiLab-style range strings, handy for building EHS and potential features or for unit tests.
- 2+2 evaluator (tangentforks/TwoPlusTwoHandEvaluator): C, last push 2023-04-11. `generate_table.cpp` declares `int HR[32487834]`, so the table is 32,487,834 × 4 bytes = 129,951,336 bytes (about 124 MiB). Very fast for sequential enumeration, very slow for random access (cache misses), per OMPEval's numbers. License is unclear: the original code says it is GPL "use it as you like", and parts derived from Cactus Kev and Paul Senzee carry no explicit license. Skip it.
- Others seen: ashelly/ACE_eval (MIT, tiny), b-inary/holdem-hand-evaluator (MIT, Rust), worldveil/deuces (pure Python, no license file), pokerkit (MIT, Python).

### 2.8 ACPC server and protocol

- Original: http://www.computerpokercompetition.org/downloads/code/competition_server/project_acpc_server_v1.0.42.tar.bz2 (still served, HTTP 200 on 2026-10-09). Mirror used by OpenSpiel: https://github.com/jblespiau/project_acpc_server (protocol PDF removed from the mirror). License: MIT-style, "Copyright (C) 2011 by the Computer Poker Research Group, University of Alberta".
- Contents: dealer, game-definition parser (`game.c`), network code, RNG, example players, and the standard `.game` files including heads-up no-limit with 20,000-chip stacks and 50/100 blinds.
- The competition itself ended after 2018 (site news: 2018 heads-up winner Slumbot, six-player winner PokerBot5). The GTO Wizard paper also states it was discontinued in 2018.
- Hand logs: `http://www.computerpokercompetition.org/downloads/competitions/2017/logs/` has `logs_2pn_2017.tar.bz2` (458 MB) and a processed version. phh-dataset lists the ACPC NLHE counts (for example 91,499,594 heads-up no-limit hands for 2017 including duplicates), with the full set on Zenodo (https://doi.org/10.5281/zenodo.10796885).
- Use: if we want two of our own bots (or our bot and a local slumbot2019 build) to play in a standard, reproducible protocol, the ACPC dealer gives seeded deals and duplicate matches for free. Optional; our own `bp h2h` may be enough.

### 2.9 Deep CFR family

- EricSteinberger/PokerRL (MIT, last push 2023-03-31): framework with distributed workers via ray, evaluation by exact BR (small games), LBR, RL-BR (DDQN) and head-to-head. Install instructions pin Python 3.6 and PyTorch 0.4.1. The LBR implementation is the useful part for us.
- EricSteinberger/Deep-CFR (MIT, 2020): Deep CFR and Single Deep CFR on top of PokerRL.
- EricSteinberger/DREAM (MIT, 2024 push): model-free deep regret minimization with outcome sampling.
- OpenSpiel `python/pytorch/deep_cfr.py`, `escher.py` and the JAX `deep_cfr.py`: maintained versions, the better starting point if the paper needs a neural baseline.
- trouverun/Holdem-DCRM (no license, 2021) and dberweger2017 repo (MIT; its older neural Deep CFR work is described by the author as not a complete Pluribus reproduction) were checked and are not worth adopting.

### 2.10 Exact postflop solvers (for subgame validation)

- b-inary/postflop-solver: AGPL-3.0, Rust, development suspended in October 2023 (author went commercial). DCFR with gamma 3.0 and strategy resets at powers of 4, no abstraction, isomorphic turn and river deals merged, 32-bit floats with optional 16-bit compression, supports bunching effect for up to four folded players. The project already uses its WASM build as an optional, user-built drop-in under `vendor/postflop-solver/` and does not check the binary in. Keep it that way: the main repo is MIT and AGPL code must not be linked into it or served over a network without AGPL compliance.
- TexasSolver: AGPL-3.0 with paid commercial licensing; the README says integrating source or providing it as a network service needs a commercial license. Its README benchmark claims parity with PioSolver 1.0 on one flop spot (0.275% vs 0.29% exploitability, 172 s vs 242 s on 6 threads). A GPU version is advertised separately.
- noambrown/poker_solver: MIT, Python reference plus optimized C++ river solver, JSON subgame format (board, pot, stack, bet sizes, two weighted ranges). A clean MIT reference for our river resolver and a cross-check target.
- Use for us: as an external oracle. Export a river or turn subgame from our search, solve with postflop-solver (as a separate process, not linked) or noambrown/poker_solver, and compare strategies and exploitability. This validates our real-time search without license entanglement.

### 2.11 Pluribus reimplementations

- fedden/poker_ai: GPL-3.0 per its LICENSE file (GitHub API shows NOASSERTION), Python, 1,587 stars, archived, last push 2023-04-03. README states only a 20-card short deck is supported for clustering. keithlee96/pluribus-poker-AI is a fork of it (confirmed via the GitHub API `parent` field) with the same README. Not useful beyond reading the pseudocode translation.
- robopoker: the only open project I found that implements the full pipeline at real 52-card scale and publishes live Slumbot numbers (see 2.6).
- conorarmstrong/noregrets: MIT but explicitly a 12-month delayed mirror of a private repo; trained blueprints only under a commercial license. Claims 2 to 6 players with postflop re-solving. Results and current code unverified.
- No open-source 6-max bot with published head-to-head results against a public benchmark was found.

### 2.12 AIVAT implementations

- No standalone, general-purpose open-source AIVAT library was found. A GitHub code search for "aivat" returned mostly README mentions.
- Implementations that exist: robopoker `crates/arena/src/aivat.rs` (MIT, Rust; see caveat in 2.6), and GTO Wizard's server-side implementation (closed, results exposed via API).
- Paper: Burch, Schmid, Moravčík, Bowling, https://arxiv.org/abs/1612.06915 (AAAI-17 workshop; later AAAI-18). Abstract: more than a factor of 10 fewer hands needed in no-limit poker; it uses the explicit strategy of a subset of the agents.
- Practical plan for us: implement AIVAT ourselves in the C++ evaluator for self-play and local matches where both strategies are known. Against Slumbot only our own action nodes and chance nodes can be corrected (Slumbot's strategy is unknown), which still helps. Against GTO Wizard the server does it.

### 2.13 Other public benchmarks

- Slumbot API (free, live): see 2.3.
- GTO Wizard Benchmark API (free on approval, AIVAT, public leaderboard): see 2.4.
- ACPC logs (offline): see 2.8. Good for parser and AIVAT testing, not for live play.
- Pluribus 10,000 hands (offline): in phh-dataset; also VitamintK/pluribus-hand-parser (84 stars, no license, 2019). Useful for the 6-max part of the paper (action frequencies, bet sizing comparison).
- PokerBench (Zhuang et al.), referenced by the GTO Wizard paper as a dataset of solved spots for LLMs; not a bot-vs-bot benchmark.
- No public 6-max bot-vs-bot benchmark exists that I could find. For 6-max we will need self-play against earlier checkpoints, LBR-style exploiters, and possibly a human study.

---

## 3. Recommendations (3 to 5 to adopt)

1. Slumbot API as the primary public benchmark. Free, live, same 200 BB format as the literature, and most published bots report against it. Write a small C++ or Python client (the official `sample_api.py` already parses the action string) that drives our exported policy, logs every hand, and reports bb/100 with a 95% CI. Run several hundred thousand hands over time. Effort: 1 to 2 days.
2. GTO Wizard Benchmark API as the second benchmark. Request a key now since approval is manual. AIVAT scoring gives tight CIs in tens of thousands of hands and a public leaderboard position. Effort: 1 day once a key arrives (reuse the Slumbot client's policy adapter).
3. Waugh's hand-isomorphism library inside the C++ trainer. Exact, permissive, tiny, fast, and it shrinks every bucket table by roughly a third to a half versus the current board-canonical × 1,326 layout. Effort: 1 to 2 days including tests that the old and new indexing agree on bucket assignments.
4. slumbot2019 as a design reference and local sparring partner. Read its real-game best response and resolving code before writing ours; build it on a rented box to get an unlimited local opponent and a sanity check for our h2h tooling. Effort: 2 to 4 days to get a trained local Slumbot-style bot.
5. OpenSpiel as an independent correctness oracle (Kuhn, Leduc, small `universal_poker` games with exact best response) and, if the paper needs one, a Deep CFR/ESCHER baseline. Effort: 1 day for the gates.

Secondary: read robopoker for the EMD abstraction, safe re-solving and `litmus` tests; use noambrown/poker_solver (MIT) and postflop-solver (AGPL, external process only) to validate river and turn re-solving; implement our own AIVAT.

## 4. Licensing checklist for the release

- MIT main repo can include: OpenSpiel (Apache-2.0, keep NOTICE), slumbot2019 (MIT), robopoker (MIT), phevaluator (Apache-2.0), OMPEval (ISC), hand-isomorphism (BSD-style, keep the notice), ACPC server (MIT-style), noambrown/poker_solver (MIT), PokerRL family (MIT), pokerkit (MIT).
- Must stay out of the MIT tree: postflop-solver and TexasSolver (AGPL-3.0), fedden/poker_ai (GPL-3.0), 2+2 evaluator (unclear), anything with no license (DeepStack-Leduc, DeepHoldem, whatsdis/pluribus, zanussbaum/pluribus, GTO Wizard client).

## 5. Links

- OpenSpiel: https://github.com/google-deepmind/open_spiel
- slumbot2019: https://github.com/ericgjackson/slumbot2019
- Slumbot: https://www.slumbot.com/ , https://www.slumbot.com/sample_api.py
- GTO Wizard Benchmark: https://arxiv.org/abs/2603.23660 , https://github.com/gtowizard-ai/researcher-api-client , https://researcher.gtowizard.com/openapi.json , https://benchmark.gtowizard.com/
- ReBeL paper: https://arxiv.org/abs/2007.13544 ; code (Liar's Dice only): https://github.com/facebookresearch/rebel
- Supremus paper: https://arxiv.org/abs/2007.10442
- AlphaHoldem paper: https://ojs.aaai.org/index.php/AAAI/article/view/20394
- AIVAT paper: https://arxiv.org/abs/1612.06915
- hand-isomorphism: https://github.com/kdub0/hand-isomorphism
- robopoker: https://github.com/krukah/robopoker
- phevaluator: https://github.com/HenryRLee/PokerHandEvaluator
- OMPEval: https://github.com/zekyll/OMPEval
- 2+2 evaluator: https://github.com/tangentforks/TwoPlusTwoHandEvaluator
- ACPC: http://www.computerpokercompetition.org/ ; mirror https://github.com/jblespiau/project_acpc_server
- PokerRL / Deep-CFR / DREAM: https://github.com/EricSteinberger/PokerRL , https://github.com/EricSteinberger/Deep-CFR , https://github.com/EricSteinberger/DREAM
- postflop-solver: https://github.com/b-inary/postflop-solver
- TexasSolver: https://github.com/bupticybee/TexasSolver
- noambrown/poker_solver: https://github.com/noambrown/poker_solver
- fedden/poker_ai: https://github.com/fedden/poker_ai
- noregrets: https://github.com/conorarmstrong/noregrets
- pokerkit / phh-dataset: https://github.com/uoftcprg/pokerkit , https://github.com/uoftcprg/phh-dataset
