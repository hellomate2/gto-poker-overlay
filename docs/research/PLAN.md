# PLAN: an open Pluribus-style poker engine and paper on a $500 to $1,000 compute budget

Lead-architect synthesis, 2026-10-09. Inputs: the six research notes in this folder
(`pluribus.md`, `libratus-deepstack.md`, `neural-successors.md`, `abstraction.md`,
`open-source.md`, `eval-compute-paper.md`), the C++ trainer in
`/Users/rg/Downloads/gpo-wt/blueprint/blueprint`, the overlay docs in
`/Users/rg/Downloads/gto-poker-overlay/docs/`, and the worktrees in `/Users/rg/Downloads/gpo-wt/*`.

Conventions. Every number carries a source URL, a file path, or "measured" with the command
that produced it. "Derived" means arithmetic on sourced numbers, shown in place. "Estimate"
means my own assumption, with the reasoning. "Unverified" means no source was found. All
win rates are mbb/hand (1 bb/100 = 10 mbb/hand). Papers report the plus/minus under different
conventions (95% CI, one SE, one SD); I copy each paper's own convention and say which.

New measurement taken for this plan (read-only run of the existing binary):

```
cd /Users/rg/Downloads/gpo-wt/blueprint/blueprint
./bin/bp tree --preset {small,medium} --flop 200 --turn 200 --river 200 --stack {10000,20000}
```

| tree | stack | decision nodes pre / flop / turn / river | infosets | slots | tables at 12 B/slot |
| --- | --- | --- | ---: | ---: | ---: |
| small | 100 BB | 44 / 420 / 2,252 / 8,756 | 2,293,036 | 5,865,001 | 70.4 MB |
| medium | 100 BB | 244 / 3,642 / 25,922 / 124,554 | 30,864,836 | 81,479,601 | 977.8 MB |
| small | 200 BB | 44 / 460 / 3,108 / 14,588 | 3,638,636 | 9,473,001 | 113.7 MB |
| medium | 200 BB | 292 / 6,504 / 59,056 / 341,224 | 81,406,148 | 218,425,137 | 2,621.1 MB |

Moving the medium tree from 100 BB to 200 BB multiplies its infosets by 2.64 (measured). Every
public benchmark is 200 BB (https://slumbot.com/sample_api.py, https://arxiv.org/abs/2603.23660),
so all compute arithmetic below starts from the 200 BB row.

---

## 1. Target: what "Pluribus-level" can honestly mean here

### 1.1 What Pluribus actually proved, and what it cost

- Pluribus is a 6-max no-limit agent. Its evidence is two human matches scored with AIVAT:
  5 humans + 1 AI, +47.7 mbb/game, SE 25.0, p = 0.028, 10,000 hands; 1 human + 5 AI,
  +32.7 mbb/game, SE 14.9, p = 0.014, 10,000 hands (https://noambrown.com/papers/19-Science-Superhuman_Supp.pdf).
  One-tailed test at 95% (same source).
- It never reported results against Slumbot, LBR or any bot
  (https://www.science.org/doi/10.1126/science.aay2400; `eval-compute-paper.md` 1.1).
- The human pool cost $50,000 for 5H+1AI, plus $2,000 per pro and a $2,000 bonus for 1H+5AI
  (https://noambrown.com/papers/19-Science-Superhuman_Supp.pdf).

Consequence: a strict replication (beat elite pros in 6-max with significance) is out of reach
on this budget, because the human pool alone was 50x to 100x our whole compute budget. We can
replicate the method, and we can prove strength in heads-up against public bots with the
same evidence standard the heads-up literature uses.

### 1.2 The claim we will make

Working claim for the paper: "an open, reproducible Pluribus-style system (MCCFR blueprint
plus depth-limited real-time search) that beats Slumbot and does not lose to LBR in heads-up,
with a 6-max extension built on the same recipe, for $X of compute." No "superhuman" claim
without a human study (`eval-compute-paper.md` 1.8).

### 1.3 Heads-up ladder (200 BB, ACPC rules, 50/100 blinds)

Each rung has a published anchor. All matches pre-register their hand count (no optional
stopping, `eval-compute-paper.md` 1.6) and report AIVAT where the opponent allows it.

| Rung | Test | Pass condition | Published anchor |
| --- | --- | --- | --- |
| H0 | Blueprint alone vs Slumbot | reported with 95% CI (expected to lose) | Modicum blueprint -11 +/- 8 (95% CI, https://arxiv.org/abs/1805.08195); robopoker blueprint -32.4 +/- 6.1 bb/100 (https://github.com/krukah/robopoker) |
| H1 | Search agent vs Slumbot | 95% lower bound > 0 | Modicum +11 +/- 9 (95% CI, https://arxiv.org/abs/1805.08195) |
| H2 | Search agent vs Slumbot | point estimate >= +45 with lower bound > 0 | ReBeL +45 +/- 5 (one SD, https://arxiv.org/abs/2007.13544) |
| H3 | LBR vs search agent, settings fc 1-4 and fcpa 3-4 (plus 56-bet 3-4 if search time allows) | LBR's 95% upper bound <= 0 in every setting run | DeepStack, ReBeL, Supremus and Student of Games all make LBR lose (https://arxiv.org/abs/1701.01724, https://arxiv.org/abs/2007.13544, https://arxiv.org/abs/2007.10442, https://arxiv.org/abs/2112.03178); Slumbot 2016 loses 522 to 4,020 to LBR (https://arxiv.org/abs/1612.07547) |
| H4 | GTO Wizard Benchmark (server AIVAT) | score reported with CI; stretch: at or above the best leaderboard entry | best entry -2.96 bb/100 over 200,002 hands, snapshot 2026-10-09 (https://researcher.gtowizard.com/leaderboard?game_name=HUNL%20200BB&limit=30) |

"Pluribus-level in heads-up" in the paper means H1 + H3 at minimum, and H2 for the headline.
Why H2 is the right bar: Modicum is the published heads-up version of the Pluribus search
recipe and sits at +11; ReBeL, the same group's later heads-up system, sits at +45. Slumbot
is a weak bar on its own (a rule-based bot beat it by +57 over 100,000 AIVAT hands,
https://arxiv.org/abs/2012.06168), which is why H3 is mandatory.

### 1.4 Six-max: what we can show

No public 6-max bot benchmark exists (`open-source.md` 2.13; `eval-compute-paper.md` 1.8).
Evidence we can produce:

1. 1 search agent + 5 blueprint copies, and 5 search + 1 blueprint, scored with multi-player
   AIVAT, seats rotated, pre-registered hand counts (the Pluribus 1H+5AI layout with bots).
2. A local exploiter (an MCCFR best-response run against the frozen blueprint in the 6-max tree,
   the existing `bp br` idea generalized) to show the blueprint is not trivially exploitable.
3. Descriptive comparison with the 10,000 Pluribus hands in PHH format
   (https://github.com/uoftcprg/phh-dataset): VPIP, PFR, limp rate, donk-bet rate. Pluribus
   limped only from the small blind and donk-bet more than pros
   (https://www.science.org/doi/10.1126/science.aay2400).
4. Optional consented human study, reported as underpowered. Derived from Pluribus's own
   numbers: SE 14.9 over 10,000 hands implies a per-hand SD of about 14.9 x sqrt(10,000) =
   1,490 mbb with AIVAT plus Control (derived from https://noambrown.com/papers/19-Science-Superhuman_Supp.pdf).
   A study of a few thousand hands would have an SE several times larger than any plausible edge.

The 6-max section of the paper will say "Pluribus recipe, reimplemented and self-evaluated",
not "Pluribus-level".

### 1.5 Sample sizes

Formula n = (z x sigma / h)^2 for a 95% two-sided half-width h, z = 1.96
(`eval-compute-paper.md` 1.6). Per-hand sigma, all 200 BB unless noted:

| sigma (mbb/hand) | Source | Half-width at 150,000 hands (derived) | Hands to show a true +45 > 0 (derived) |
| --- | --- | ---: | ---: |
| 20,946 raw chips vs Slumbot | derived from robopoker's 14.0 bb/100 half-width over 86k hands (https://github.com/krukah/robopoker) | 106 | 832,000 |
| 17,041 all-in EV vs Slumbot | derived from Supremus 44 x sqrt(150,000) (https://arxiv.org/abs/2007.10442) | 86 | 551,000 |
| 4,048 full AIVAT (100 BB self-play) | derived from 8.095 chips, BB = 2 (https://arxiv.org/abs/1612.06915) | 20.5 | 31,000 |

Against Slumbot only our own actions and chance can be AIVAT-corrected, because Slumbot's
strategy is unknown (`open-source.md` 2.12). The resulting sigma lies somewhere between the
first and third rows and must be measured. Protocol: a 10,000-hand pilot (excluded from the
headline) estimates sigma; then N is fixed in a committed pre-registration file before the
headline match, capped at 150,000 hands (the count Supremus and GTO Wizard used,
https://arxiv.org/abs/2007.10442, https://arxiv.org/abs/2603.23660). If the measured sigma
makes H2 unprovable within the cap, the paper reports the CI honestly and relies on the GTO
Wizard benchmark, whose server computes full AIVAT (https://arxiv.org/abs/2603.23660).

Whether Slumbot's API reveals its hole cards at showdown is unverified
(`eval-compute-paper.md` 1.4). Check on the first live hands.

---

## 2. Architecture

### 2.1 Heads-up agent (build first)

A Modicum-shaped system with the Pluribus refinements, on top of the existing C++ trainer.

1. Blueprint. External-sampling Linear MCCFR with negative-regret pruning, int32 regrets
   (already in `src/mccfr.h`, matching Pluribus Algorithm 1 per `pluribus.md` section 9).
   200 BB stacks. 169 lossless preflop classes; potential-aware flop buckets, distribution-aware
   turn buckets, OCHS river buckets (`abstraction.md` 10). Preflop-only running average plus
   postflop current-strategy snapshots (https://noambrown.com/papers/19-Science-Superhuman_Supp.pdf).
2. Preflop play. Blueprint strategy. Off-tree opponent raises: randomized pseudo-harmonic
   translation, f(x) = (B - x)(1 + A) / ((B - A)(1 + x)) (https://www.ijcai.org/Proceedings/13/Papers/028.pdf).
   Large deviations: add the size and re-solve the preflop round, cached per size, as Modicum did
   (https://arxiv.org/abs/1805.08195, Appendix A). Pluribus's rule for when to search preflop
   is "more than $100 off every blueprint size" (https://noambrown.com/papers/19-Science-Superhuman_Supp.pdf).
3. Flop. Depth-limited search to the end of the flop. At each leaf every player still in the
   hand chooses among k = 4 continuation strategies (blueprint; fold, call, raise probabilities
   multiplied by 5 and renormalized). Both players choose, as in Pluribus; Modicum let only the
   opponent choose and was too defensive (https://noambrown.com/papers/19-Science-Superhuman_Supp.pdf).
   Leaf values by rollouts in the blueprint (Modicum used 3 rollouts per leaf,
   https://arxiv.org/abs/1805.08195). Monte Carlo Linear CFR for this solve.
   Pluribus itself would solve a heads-up flop to the end of the game
   (https://noambrown.com/papers/19-Science-Superhuman_Supp.pdf), but it had 28 cores and 1 to
   33 s per subgame. Depth-limited flop is Modicum's 4-core choice; we start there and test
   end-of-game flop solving as an ablation once the solver's speed is measured.
4. Turn and river. Solve to the end of the game with a vectorized range-vs-range solver
   (CFR+ or DCFR, O(n) showdown by strength sort, card-removal-aware fold values), lossless
   cards on the current round (https://arxiv.org/abs/1705.02955; https://poker.cs.ualberta.ca/publications/2015-ijcai-cfrplus.pdf).
   Modicum's tweaks: drop the first 50% of iterations from the average, discount regrets by
   sqrt(T)/(sqrt(T)+1) for the first 30 iterations, about 3x lower exploitability
   (https://arxiv.org/abs/1805.08195, Appendix A). Supremus's DCFR+ (average weight
   max(0, t - 100)) as the alternative to test (https://arxiv.org/abs/2007.10442).
5. Nested re-solving. Re-solve from the start of the current betting round whenever the
   opponent bets off-tree, adding that size (Pluribus Algorithm 2). Freeze only our own
   already-taken actions for our real hand. Play the final iterate, update beliefs with the
   weighted average (https://noambrown.com/papers/19-Science-Superhuman_Supp.pdf).
6. Safety schedule. Unsafe solving for preflop, flop and the first turn subgame, then safe
   Resolve or Reach-Resolve with estimated alternative payoffs (Modicum and Libratus both did
   this, https://arxiv.org/abs/1805.08195, https://noambrown.github.io/papers/17-Science-Superhuman.pdf).
   Reason: unsafe solving can blow up (Large flop hold'em, 30k buckets: trunk 41.41 to 396.8
   mbb/h, https://arxiv.org/abs/1705.02955). Pluribus's always-unsafe variant is an ablation.
7. Own bet sizes randomized by 0 to 8% per hand in subgames (Libratus,
   https://noambrown.github.io/papers/17-Science-Superhuman.pdf), as a "could".

Why this design. Search is the largest single lever in every system studied: Modicum blueprint
-11 +/- 8 vs Slumbot, depth-limited search +11 +/- 9 (https://arxiv.org/abs/1805.08195);
Libratus blueprint -8 +/- 15 vs Baby Tartanian8, nested solving +63 +/- 28
(https://noambrown.github.io/papers/17-Science-Superhuman.pdf). Modicum did it with a 700
core-hour blueprint and a 4-core CPU at play time (https://arxiv.org/abs/1805.08195), which fits
our budget with room for a larger blueprint.

### 2.2 Six-max agent (build second)

Pluribus recipe as published, since it is still the only published superhuman 6-max method
(https://www.science.org/doi/10.1126/science.aay2400; `neural-successors.md` 1).

- Blueprint: N-player external-sampling Linear MCCFR with pruning; lazy allocation of regrets
  per action sequence (more than 2x memory saving in Pluribus); preflop average only; 200
  buckets per postflop round; 1 to 14 raise sizes per decision point
  (https://noambrown.com/papers/19-Science-Superhuman_Supp.pdf).
- Search: always on flop, turn and river. With more than 2 players at the start of the flop,
  leaves at the start of the turn or after the second raise; otherwise to the end of the game.
  Unsafe search from the start of the round, k = 4 continuation strategies with bias 5,
  500 buckets per later round in search (same source).
- Reuses the HU subgame solver, belief tracker, continuation strategies and AIVAT code.

### 2.3 Alternatives considered and rejected

| Alternative | Why rejected | Source |
| --- | --- | --- |
| ReBeL-style self-play value nets | data generation on 90 DGX-1 machines; a one-server replication reached only +18 +/- 16 vs Slumbot; theory only for two-player zero-sum | https://arxiv.org/abs/2007.13544 ; https://arxiv.org/abs/2403.04344 |
| Student of Games | TPU-fleet scale; poker result only +7 +/- 3 vs Slumbot | https://arxiv.org/abs/2112.03178 |
| DeepStack-style CFV nets as the main path | turn data alone took over 175 core-years; a faithful reimplementation lost to Slumbot by 63 +/- 40 | https://arxiv.org/abs/1701.01724 ; https://arxiv.org/abs/2007.10442 |
| AlphaHoldem PPO as the main agent | 580 GPU-h + 4,000 CPU-h, about $1,150 of GPU at $1.99/GPU-h (derived), no search, no guarantee, human result not significant | https://ojs.aaai.org/index.php/AAAI/article/view/20394 ; https://lambda.ai/pricing |
| Deep CFR / SD-CFR / DREAM / ESCHER | no published HUNL result vs Slumbot | https://arxiv.org/abs/1811.00164 ; `neural-successors.md` 3.5-3.8 |
| LLM agents | best LLM -16 +/- 3 bb/100 vs GTO Wizard; $0.07 to $0.30 per hand | https://arxiv.org/abs/2603.23660 ; https://arxiv.org/abs/2605.30094 |
| Forking robopoker (Rust, MIT) | best variant still loses to Slumbot, -13.1 +/- 14.0 bb/100; PostgreSQL dependency; our C++ trainer already matches Pluribus Algorithm 1 | https://github.com/krukah/robopoker ; `pluribus.md` 9 |
| Linking postflop-solver / TexasSolver / DecisionHoldem | AGPL-3.0; usable only as an external oracle process | `open-source.md` 4 |
| Keeping the TS equity-leaf solver as the search core | values leaves by all-in equity, weaker than Modicum's naive single-value leaf, which itself lost to BT8 by 10 +/- 8; TS is also slower than C++ for 1,326-wide vectors (estimate) | https://arxiv.org/abs/1805.08195 ; `/Users/rg/Downloads/gto-poker-overlay/docs/POSTFLOP_CFR.md` |

Kept as a phase-2 option: a river (then turn) counterfactual value network trained on
CPU-solved subgames, Supremus-style, only after a timed pilot of 10,000 to 100,000 solved
subgames shows the data cost (`neural-successors.md` 3.3). Supremus reached +176 +/- 44 vs
Slumbot with this approach (https://arxiv.org/abs/2007.10442); its total compute is unverified.

---

## 3. Gap analysis

Paths are relative to `/Users/rg/Downloads/gpo-wt/blueprint/blueprint` (BP) or
`/Users/rg/Downloads/gpo-wt/integrate` (INT) unless absolute. `INT/blueprint/src` is identical
to `BP/src` (checked with `diff -rq`).

| Component | Status | Evidence in our code | What to do |
| --- | --- | --- | --- |
| Hand evaluator | exists | `BP/src/eval.{h,cpp}`; tests check 7,462 classes and all 133,784,560 seven-card hands; 101 to 155 M evals/s per thread (`BP/README.md`) | Nothing. Cite phevaluator (https://github.com/HenryRLee/PokerHandEvaluator) as the idea's origin. |
| Suit isomorphism / indexing | partial | board-canonical x 1,326 tables: 2,327,130 / 21,788,832 / 178,292,634 slots (`BP/src/abstraction.h`; `open-source.md` 2.5) | Vendor Waugh's hand-isomorphism (1,286,792 / 13,960,050 / 123,156,254 entries, about 45% / 36% / 31% smaller, measured locally per `open-source.md` 2.5). Keep the BSD notice. |
| Card abstraction | partial | 169 lossless preflop; flop/turn 50-bin river-EHS histograms, k-means with squared L2 on CDFs; river 1-D EHS; one k-means run fit on 300 flops / 300 turns / 2,000 rivers; river table `uint8` (max 255 buckets) (`BP/src/abstraction.cpp`; `abstraction.md` 9) | L1-on-CDF assignment; full-population flop clustering with orbit weights and 10 to 25 k-means++ restarts; OCHS river (8 opponent clusters); potential-aware flop with EMD over turn clusters (GS14, with the pseudocode order fix); `uint16` river table. Per-flop 500-bucket search abstraction only if end-of-game flop search is adopted. |
| Action abstraction | partial, with a bug | presets `tiny`/`small`/`medium`, same menu at every raise depth, symmetric (`BP/src/tree.cpp:280-340`). Bug: `legal_actions` returns before adding all-in once `raises == max_raises` (`BP/src/tree.cpp:83-84`), so a shove after the cap has no abstract node. Default stack 10,000 = 100 BB (`BP/src/tree.h:59`). | All-in always legal; 200 BB preset; first-raise vs later-raise menus (Pluribus); opponent-side min-bet and overbets (BT8 asymmetry, LBR attack sizes); preflop menu wide (Pluribus: finest preflop). Prune unused sizes after a wide-menu run (Pluribus method). |
| Blueprint MCCFR | exists, needs changes | external sampling, LCFR periodic discount, 95% pruning with threshold and floor, int32 regrets, lock-free threads, checkpoint/resume (`BP/src/mccfr.h`). Gaps: double running average at every slot (12 B/slot); schedules counted in iterations, not minutes; all-actions-pruned case returns v with the pruned mass dropped (`mccfr.h` traverse; `pluribus.md` 3); two players hard-coded (`for (int p = 0; p < 2; p++)`); no lazy allocation; scaling measured only to 4 threads (3.5x) | Never prune the max-regret action; preflop-only average plus postflop snapshots (4 B/slot); arena or hash lazy allocation (needed for 6-max); N-player generalization; set schedules from the measured iterations per minute on the rented box. |
| Correctness gates | exists | Kuhn exploitability 0.00043 and Leduc 0.0091 at 4M iterations (`BP/results/gate-*.csv`); in-abstraction exploiter `bp br` (+20.5 +/- 9.0 vs the 25-min run, `BP/README.md`) | Add OpenSpiel cross-check on Kuhn/Leduc and 3-player Kuhn (https://github.com/google-deepmind/open_spiel); add litmus tests (suited/offsuit symmetry, monotone aggression, BB defense; idea from https://github.com/krukah/robopoker). |
| Preflop handling | partial | blueprint preflop strategy; the overlay uses separate CFR+ charts (`/Users/rg/Downloads/gto-poker-overlay/docs/PIPELINE.md`, `INT/src/core/ranges/headsup-solved.ts`) | Pseudo-harmonic translation for off-tree raises; preflop re-solve with the new size added, cached. |
| Real-time search | partial, TypeScript only | `INT/src/core/solver/postflop-cfr.ts` (range-vs-range DCFR, current street only, equity leaves) and `INT/src/core/solver/subgame.ts` (1,500 ms budget, behind the `SUBGAME_SOLVER` flag in `INT/src/core/engine-flags.ts`); range tracker `INT/src/core/ranges/range-tracker.ts` | New C++ module: vector CFR+/DCFR solver; Bayesian beliefs from the blueprint over 1,326 combos; k = 4 continuation-strategy leaves with rollouts; safe gadgets (Resolve, Reach, estimated alternative payoffs); nested re-solve with freezing. The TS solver stays as a test reference (its river toy-game test: bluff share s/(1+2s), call 1/(1+s)). |
| Action translation | missing | no translation in `INT/src/core/blueprint/loader.ts` (`BP/README.md` known limitations) | Randomized pseudo-harmonic for play, deterministic for mapping leaves to blueprint nodes (https://www.ijcai.org/Proceedings/13/Papers/028.pdf). |
| Export / loader | exists | `BP/src/export.cpp` (GPOBP001 format), `INT/src/core/blueprint/loader.ts`; loader does not read flop/turn tables | Only needed if the overlay ever consumes the agent; not on the research path. |
| Eval: head-to-head | partial | duplicate `bp h2h` samples actions (`BP/src/main.cpp:534`) | Exact-EV duplicate scoring (tree walk under both policies) for bot-vs-bot (`eval-compute-paper.md` 1.4, the author's own suggestion). |
| Eval: LBR | missing | none | C++ LBR with the published settings; Leduc test against `ExactEval`. |
| Eval: AIVAT | missing | none | HU AIVAT (chance + own actions + imaginary observations over our hands); multi-player version for 6-max; Leduc zero-variance test. |
| Eval: Slumbot / GTO Wizard clients | missing | none | Slumbot client (endpoints and action grammar in `open-source.md` 2.3); apply for a GTO Wizard key on day one (manual approval, https://github.com/gtowizard-ai/researcher-api-client). |
| Eval: full-card best response in our betting tree | missing | none | Optional. Johanson-style public-tree walk; about $24 for a HULHE-sized job, $245 for a 10x tree (derived in `eval-compute-paper.md` 1.3, unverified for HUNL). |
| Eval: overlay sim harness (branch `harness`) | exists, not for strength claims | `/Users/rg/Downloads/gpo-wt/harness/sim/` and `INT/sim/BASELINE.md` (heuristic engine vs archetypes, 100 BB) | Keep for the overlay; the research agent is scored only by the C++ tools above. |
| 6-max | missing in C++ | trainer is 2-player; the overlay has multiway equity (`/Users/rg/Downloads/gpo-wt/multiway`, commit 8e30479) and heuristic 6-max play | N-player tree and trainer, multi-player AIVAT, PHH replay of the 10,000 Pluribus hands. |
| Infra | partial | `make ARCH=` for portable builds; atomic checkpoints and `--resume` (`BP/README.md`) | Cloud bootstrap script, checkpoint sync to object storage, spot interruption handling, `bp bench --max-threads 192` on each candidate instance. |

---

## 4. Milestones, in build order

Effort figures are the researchers' estimates from the notes, not measurements. Thresholds
marked "(ours)" are acceptance targets I chose; everything else cites its anchor.

### M0. Harden the existing trainer (laptop, $0)

Work: all-in and call legal at every node regardless of `max_raises`; never prune the
max-regret action; 200 BB preset; `uint16` river table; exact-EV duplicate h2h; litmus suite.

Acceptance:
- `make test` passes, with new tests: a shove is a legal child of every capped node in every
  preset; a constructed all-negative-regret node returns the same value pruned and unpruned.
- No regression on the gates: Kuhn <= 0.00065 and Leduc <= 0.0137 at 4M iterations (ours:
  1.5x the README values 0.00043 and 0.0091).
- Exact-EV h2h of the final 25-minute checkpoint vs its 5-minute snapshot agrees with the
  sampled result (+22.0 +/- 12.5, `BP/README.md`) within CI, with a narrower CI on the same deals.
- `bp tree --stack 20000` reproduces the measured 200 BB sizes in the table at the top.

### M1. Evaluation stack v1 (laptop, $0)

Work: AIVAT (HU); LBR in C++ (fc 1-4, fc 3-4, fcpa 3-4, 56 bets 3-4 with 0.05 x 1.15^k
fractions, and ReBeL's "call rounds 1-2, fcpa rounds 3-4") per https://arxiv.org/abs/1612.07547;
Slumbot client with full hand logs; GTO Wizard key requested.

Acceptance:
- AIVAT on Leduc with both strategies known removes at least 99% of the SD (the paper reports
  a little under 99.9% in that setting, https://arxiv.org/abs/1612.06915); on 1M HUNL self-play
  hands its mean equals the plain mean within CI.
- LBR on Leduc never exceeds `ExactEval`'s best response; LBR vs always-fold returns 750 mbb/hand
  in the fcpa setting (the always-fold row in https://arxiv.org/abs/1701.01724, Table 3).
- LBR table for the medium blueprint at 200 BB, 2 x 50,000 duplicate hands per cell (the LBR
  paper's protocol).
- Slumbot client: 1,000 blueprint hands with zero protocol errors, and every hand's `winnings`
  reproduced by replaying the logged action string through our own rules engine.

### M2. Card abstraction upgrade (laptop, $0)

Work: Waugh indexing; L1-on-CDF; full-population flop clustering with restarts; OCHS river;
potential-aware flop.

Acceptance:
- New tables give the same bucket as the old tables for every (hole, flop) and for 10M sampled
  turn and river hands, before any feature change.
- Index sizes 169 / 1,286,792 / 13,960,050 / 123,156,254 asserted in tests (https://github.com/kdub0/hand-isomorphism).
- Each feature change is A/B tested on the small 200 BB tree at equal visits (exact-EV duplicate
  and `bp br`). A change ships only if it is not worse beyond the 95% CI (ours). Litmus suite passes.

### M3. Memory and scaling (first rented hours, $10 to $20)

Work: preflop-only average plus postflop snapshots (4 B/slot); arena allocation; cloud bootstrap;
`bp bench` on c7a.48xlarge and c8g.48xlarge.

Acceptance:
- `bp tree` reports 4 bytes per postflop slot.
- Leduc gate with snapshot averaging stays within 2x of the current 4M-iteration exploitability (ours).
- Measured on both boxes: per-core speed relative to the M3 thread (f) and 192-thread
  efficiency (e). If e < 0.5 (ours), fix contention (for example per-thread deal batching)
  before any long run.

### M4. C++ vector subgame solver (laptop)

Work: range-vs-range CFR+/DCFR with O(n) showdown and card-removal fold values; Modicum's CFR+
tweaks; DCFR+ variant. Research-note effort: 1 to 2 weeks (`libratus-deepstack.md` techniques).

Acceptance:
- Leduc subgames match `ExactEval`.
- River toy game matches the closed form (bluff share s/(1+2s), call 1/(1+s)).
- 50 exported river and 20 turn spots: exploitability within 0.1% of pot of the same spots solved
  by noambrown/poker_solver (MIT) or postflop-solver run as a separate process (ours).
- Timing table for river and turn solves on 4 and 8 cores (measured, feeds section 5).

### M5. Heads-up search agent (laptop)

Work: belief tracker, nested re-solve, freezing, safe gadgets, k = 4 continuation leaves,
preflop translation and re-solve cache. Research-note effort: 2 to 4 weeks
(`neural-successors.md` techniques).

Acceptance:
- Unit tests: beliefs sum to 1, blocked combos have zero weight; a re-solve never assigns zero
  probability to an action we already took with our real hand.
- Coin Toss gadget numbers from https://arxiv.org/abs/1705.02955 reproduced (Maxmargin: Heads 5/8,
  Tails 3/8; Reach: Heads 3/4, Tails 1/4, per `libratus-deepstack.md` 7).
- Off-tree test: an opponent that bets 0.1, 0.25, 0.4, 0.75, 1.5, 3 and 5 pot wins less against
  the search agent than against the translation-only blueprint (AIVAT, 95% CI) (ours).
- Local Modicum ladder reproduced: blueprint < single-value leaves < k = 4 leaves, each step's
  difference with 95% CI (shape from https://arxiv.org/abs/1805.08195, Table 1).
- LBR fc 1-4 against the search agent does not win (upper bound <= 0).
- Seconds per hand measured on the laptop; Modicum's reference is about 20 s on 4 cores
  (https://arxiv.org/abs/1805.08195).

### M6. Main heads-up blueprint (rented, about $54 to $183)

Work: 200 BB tree with the M0 menu changes and the M2 abstraction, sizes in section 5.

Acceptance:
- Gate decision before launch: medium 200 BB learning curve (R1 in section 5) shows exact-EV h2h
  and `bp br` still improving or flat as visits per infoset pass 160,000; this tests the
  README's crude rule before money goes into the large run.
- The large blueprint beats the medium one in exact-EV duplicate h2h (95% CI).
- The search agent on the large blueprint beats the search agent on the medium one (AIVAT, 95% CI).
- Litmus suite passes.

### M7. Heads-up evaluation campaign and ablations (rented, about $80 to $150)

Acceptance:
- Pre-registration file committed before headline hands: hand counts, test (two-sided 95%),
  sampled vs purified play, AIVAT terms used.
- Ladder H0 to H4 run as specified in section 1.3; ablations in section 6 run.

### M8. Six-max (rented, about $137 to $275)

Work: N-player tree and trainer, lazy allocation, Pluribus abstraction and search rules,
multi-player AIVAT, PHH replay.

Acceptance:
- 3-player Kuhn (and Leduc if available) agrees with OpenSpiel's CFR on game value within
  tolerance (ours: 0.005 chips).
- Our rules engine replays all 10,000 Pluribus PHH hands with only legal actions and matching
  chip results (https://github.com/uoftcprg/phh-dataset).
- 1 search + 5 blueprint copies: search seat's AIVAT win rate has a 95% lower bound > 0;
  5 search + 1 blueprint reported.

### M9. Paper and release

Acceptance: every table regenerates from a script and logged hands; checkpoints hashed; code
under MIT with third-party notices (hand-isomorphism BSD notice; no AGPL code linked).

Dependency order: M0 and M1 first (they change what every later number means), then M2 and M4
in parallel, M3, M5, M6, M7, M8, M9.

---

## 5. Compute plan for $500 to $1,000

### 5.1 Inputs

Measured (`BP/README.md`, Apple M3 Pro): 46.2M infoset visits/s on 4 threads for the medium
200-bucket tree, so 11.55M visits per thread-second; 3.5x speedup from 1 to 4 threads.
Crude quality rule from the same README: about 160,000 visits per infoset reached the quality of
the 25-minute small run (in-abstraction exploiter +20.5 +/- 9.0 mbb/hand).

Measured for this plan: the 200 BB tree sizes in the table at the top. Actions per slot by street
(derived from those slot counts): preflop 2.99, flop 2.87, turn 2.76, river 2.67.

Prices, AWS us-east-1, 2026-10-09 (`eval-compute-paper.md` 2.2): c7a.48xlarge 192 cores,
384 GiB, $3.414/h spot, $9.85344/h on demand (https://instances.vantage.sh/aws/ec2/c7a.48xlarge);
c8g.48xlarge 192 Graviton4 cores, 384 GiB, $2.576/h spot (https://instances.vantage.sh/aws/ec2/c8g.48xlarge);
r7a.48xlarge 192 cores, 1,536 GiB, $3.322/h spot (https://instances.vantage.sh/aws/ec2/r7a.48xlarge);
c7a.16xlarge 64 cores, $1.150/h spot (https://instances.vantage.sh/aws/ec2/c7a.16xlarge).

Assumptions to replace by measurement (estimates, from `eval-compute-paper.md` 2.5):
f = speed of one server core relative to one M3 thread (1.0 / 0.75 / 0.5), e = parallel
efficiency on 192 cores (0.85 / 0.7 / 0.5).

Arithmetic: visits = infosets x 160,000; M3 thread-hours = visits / (11.55e6 x 3,600);
core-hours = thread-hours / f; wall = core-hours / (192 x e); dollars = wall x hourly price.
Infosets = sum over streets of (decision nodes x buckets), using the measured 200 BB medium tree.
A new betting tree from M0 changes these counts; rerun `bp tree` and redo this arithmetic.

### 5.2 Blueprint runs (derived)

| Run | Buckets pre/flop/turn/river | Infosets | Tables 12 B/slot / 4 B/slot | M3 thread-h | Scenario | Core-h | Wall, 192 cores | c7a spot | c8g spot |
| --- | --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: |
| R1 medium | 169 / 200 / 200 / 200 | 81.4M | 2.6 GB / 0.87 GB | 313 | optimistic | 313 | 1.9 h | $7 | $5 |
| | | | | | middle | 418 | 3.1 h | $11 | $8 |
| | | | | | pessimistic | 627 | 6.5 h | $22 | $17 |
| R2 large (main) | 169 / 5,000 / 5,000 / 1,000 | 669M | 21.8 GB / 7.3 GB | 2,575 | optimistic | 2,575 | 15.8 h | $54 | $41 |
| | | | | | middle | 3,433 | 25.5 h | $87 | $66 |
| | | | | | pessimistic | 5,149 | 53.6 h | $183 | $138 |
| R3 extra-large (stretch) | 169 / 30,000 / 30,000 / 2,000 | 2.65B | 87.2 GB / 29.1 GB | 10,195 | optimistic | 10,195 | 62.5 h | $213 | $161 |
| | | | | | middle | 13,593 | 101 h | $345 | $261 |
| | | | | | pessimistic | 20,389 | 212 h | $725 | $547 |

Example check for R2: infosets = 292 x 169 + 6,504 x 5,000 + 59,056 x 5,000 + 341,224 x 1,000 =
669,073,348; visits = 1.071e14; thread-hours = 1.071e14 / 4.158e10 = 2,575.

Why R2 is the main run. Its bucket counts follow DecisionHoldem's template (50k flop / 5k turn /
1k river, about 4,000 core-hours, https://arxiv.org/abs/2201.11580) scaled down on the flop, and
its core-hours (2,575 to 5,149) sit between Modicum's 700 (https://arxiv.org/abs/1805.08195) and
Pluribus's 12,400 (https://www.science.org/doi/10.1126/science.aay2400). Pluribus's 200 buckets
was a 6-max memory compromise, and Modicum used 30,000 postflop buckets for heads-up
(`pluribus.md` 2). R3 (Modicum-scale buckets) runs only if R1 vs R2 shows that more buckets
still buy strength through search.

Two caveats. The per-visit cost was measured with 1 GB tables; R2's 7 to 22 GB tables will miss
cache more, so the pessimistic row is the safer budget line (estimate). And the 160,000-visit
rule is the README's own "crude" order-of-magnitude rule; M6's gate exists to test it.

### 5.3 Evaluation compute (derived)

- Slumbot headline, up to 150,000 hands. If our search costs what Modicum's did (about 20 s per
  hand on 4 cores = 80 core-seconds, https://arxiv.org/abs/1805.08195): 150,000 x 80 / 3,600 =
  3,333 core-hours, $59 on c7a spot ($3.414 / 192 = $0.0178 per core-hour). Wall time at 16
  concurrent sessions: 150,000 x 20 / 16 / 3,600 = 52 h. Slumbot's concurrency limits are
  unverified (`open-source.md` 2.3).
- GTO Wizard benchmark, 50,000 to 100,000 hands at the same cost per hand: $20 to $40.
- LBR against the search agent costs about (n + 1) searches per LBR decision for n bet sizes
  (https://arxiv.org/abs/1612.07547). fc and fcpa settings: 10,000 hands each, about 2 x 80 x
  10,000 / 3,600 = 444 core-hours, $8 per setting (derived). The 56-bet setting runs only
  against the blueprint, where queries are table lookups.
- Optional full-card in-tree best response: $24 to $245 (derived in `eval-compute-paper.md` 1.3).

### 5.4 Six-max blueprint (derived)

Pluribus's 12,400 core-hours on one 192-core box is 64.6 h; on r7a.48xlarge spot that is $215
(`eval-compute-paper.md` 2.3). Pluribus used under 512 GB (https://noambrown.com/papers/19-Science-Superhuman_Supp.pdf),
which r7a's 1,536 GiB covers; c7a/c8g (384 GiB) do not. A half-size run (6,200 core-hours) is
$107. Core-hours across CPU generations are not comparable units (unverified speedup), so the
actual tree size must be measured with the N-player `bp tree` before choosing.

### 5.5 Budget

| Line | Low | High | Notes |
| --- | ---: | ---: | --- |
| Bench boxes, abstraction builds | $10 | $20 | 1 to 2 h on each candidate instance |
| R1 medium 200 BB | $7 | $22 | also the ablation base |
| R2 large HU blueprint | $54 | $183 | c7a spot; c8g spot is cheaper if f on arm64 is close |
| Ablations at R1 size, about 6 runs | $40 | $130 | Vast.ai hosts ($0.483/h for 96 cores, reliability 0.933, `eval-compute-paper.md` 2.2) can cut this |
| HU evaluation (Slumbot, GTO Wizard, LBR) | $80 | $150 | section 5.3 |
| 6-max blueprint | $107 | $215 | half or full Pluribus core-hours, r7a spot |
| 6-max self-play evaluation | $30 | $60 | estimate: same per-hand search cost model, 6 seats |
| Subtotal | $328 | $780 | |
| Contingency 20% (spot interruptions, reruns) | $66 | $156 | estimate |
| Total | $394 | $936 | inside $500 to $1,000 at the high end |

R3 is not in the total. It replaces most of the contingency and the 6-max half-run if it is chosen.

### 5.6 Measure before spending

1. f and e for c7a and c8g with `bp bench --max-threads 192` (a few dollars).
2. Per-visit cost on a table of R2's size (7 to 22 GB), not on the 1 GB medium table.
3. Whether quality keeps rising past 160,000 visits per infoset (R1 learning curve).
4. Search seconds per hand on the target hardware (sets every evaluation line).
5. Slumbot API: hands per hour per session, concurrent-session tolerance, whether hole cards
   are revealed (sets the AIVAT terms and N).
6. GTO Wizard key approval and any rate limits (unverified).
7. The final 200 BB betting tree's node counts (`bp tree`) and the 6-max tree's size.
8. Spot interruption rate on the chosen instance over the first run.

Spend gates: no R2 before items 1 to 3; no headline evaluation before items 4 to 6; no 6-max
run before item 7.

---

## 6. Paper outline

Working title: "An Open, Low-Cost Reproduction of Pluribus-Style No-Limit Hold'em:
Blueprint, Depth-Limited Search, and a Reproducible Evaluation Protocol"
(`eval-compute-paper.md` 3.5).

1. Introduction. Pluribus released pseudocode, not code (https://noambrown.com/papers/19-Science-Superhuman.pdf).
   Contributions: open C++ trainer and search agent; HU results vs Slumbot and the GTO Wizard
   benchmark with AIVAT; LBR table; total cost in dollars; released checkpoints, logs, hands.
2. Background: CFR, MCCFR, Linear CFR, pruning, abstraction, safe and depth-limited search;
   prior systems' published numbers with their CI conventions normalized.
3. System: abstraction, betting tree, trainer (memory layout, lock-free threads, schedules),
   search agent (beliefs, continuation strategies, gadgets, nested re-solving), translation.
4. Correctness gates: Kuhn/Leduc exact exploitability, OpenSpiel cross-check, subgame oracle
   comparisons, evaluator and isomorphism counts.
5. Evaluation protocol: duplicate and exact-EV scoring, AIVAT and its Leduc validation, LBR
   settings, pre-registration, one- vs two-tailed tests.
6. Heads-up results: learning curves vs core-hours; ladder H0 to H4; comparison table with
   Modicum, ReBeL, Supremus, AlphaHoldem, Student of Games, robopoker, GTO Wizard AI.
7. Ablations (below).
8. Compute and cost: hardware, core-hours, dollars, memory; vs Pluribus 12,400 core-hours / $144,
   Modicum 700, DecisionHoldem about 4,000, Libratus about 25M.
9. Six-max: blueprint, search, self-play AIVAT tables, PHH comparison with Pluribus.
10. Limitations: no large human study; Slumbot is static and exploitable; LBR is a lower bound;
    card abstraction error; CPU-generation differences in core-hour comparisons.
11. Reproducibility statement.

Planned experiments and baselines:

- Opponents: Slumbot API; GTO Wizard benchmark; LBR in five settings; our own blueprint and
  checkpoints; check/call, random and maniac sanity agents (already in `bp h2h`); optionally a
  slumbot2019 agent trained by us at matched compute (https://github.com/ericgjackson/slumbot2019).
- Published rows quoted, not rerun: Modicum, ReBeL, Supremus, AlphaHoldem, Student of Games,
  DeepStack reimplementation, GTO Wizard AI, robopoker (sources in section 1 and
  `eval-compute-paper.md` 1.1).

Ablations, each at R1 size unless noted:

| Ablation | Arms | Metric |
| --- | --- | --- |
| Linear CFR discounting | on / off | exact-EV h2h, `bp br`, learning curve |
| Negative-regret pruning | on / off; threshold | same, plus iterations per second |
| Averaging | running average everywhere / preflop average + postflop snapshots | same, plus memory |
| Card abstraction | buckets 50 / 200 / 1,000; distribution- vs potential-aware flop; EHS vs OCHS river | h2h, `bp br`, LBR fcpa 3-4 |
| Betting abstraction | small / medium / large; symmetric vs asymmetric | h2h, LBR 56-bet 3-4 |
| Translation | none / deterministic / randomized pseudo-harmonic | LBR with off-tree sizes |
| Search | off / naive single-value leaves / k = 4 leaves (the Modicum ladder) | AIVAT self-play, Slumbot pilot |
| Leaf chooser | opponent only (Modicum) / both players (Pluribus) | AIVAT self-play, LBR |
| Safety | unsafe always (Pluribus) / unsafe-then-safe (Modicum, Libratus) | LBR, AIVAT self-play |
| Flop depth | end of flop / end of game | AIVAT self-play, seconds per hand |
| Play policy | sampled / purified | Slumbot pilot and LBR together (purification can inflate h2h while raising exploitability, https://www.science.org/doi/10.1126/science.aao1733) |
| Variance reduction | raw chips / all-in EV / AIVAT on the same hands | CI width |
| Compute scaling | R1 / R2 (/ R3) | strength vs core-hours |

Venues (dates from `eval-compute-paper.md` 3.1): arXiv as soon as results exist; TMLR
(rolling); IJCAI-27 around 15 January 2027 (third-party estimate, not official); NeurIPS 2027
Evaluations and Datasets track for the evaluation tools (2027 date unverified); AAAI-28
(date unverified). AAAI-27 and AAMAS-27 main deadlines have passed, and the AAMAS fast track is
only for AAAI-27 rejections.

---

## 7. Risks

1. Cost model error. Both scaling factors (f, e) and the 160,000-visit rule are unmeasured or
   crude, and per-visit cost was measured on a 1 GB table. Mitigation: section 5.6 gates; R1
   before R2; the pessimistic column as the budget line.
2. Search too slow. Evaluation cost scales linearly with seconds per hand; at Modicum's 20 s
   a 150,000-hand Slumbot match is 3,333 core-hours (derived). Mitigation: measure at M5; cap
   iterations per solve; flop depth limit at the end of the flop.
3. Statistical power. Against Slumbot only partial AIVAT is possible, and 150,000 raw-chip hands
   give a half-width of about 106 mbb/hand (derived, section 1.5), wider than the +45 target.
   Mitigation: pilot sigma first, all-in EV plus partial AIVAT, GTO Wizard's server AIVAT as the
   tight-CI benchmark.
4. External services. Slumbot terms, rate limits and uptime are undocumented (`open-source.md` 2.3);
   OpenHoldem's authors found the site unstable for long sessions (https://arxiv.org/abs/2012.06168).
   GTO Wizard keys are granted by hand. Mitigation: request the key on day one; a local
   slumbot2019 sparring bot for unlimited matches.
5. Unsafe-search blowups. Measured cases went from 41.41 to 396.8 mbb/h
   (https://arxiv.org/abs/1705.02955). Mitigation: unsafe only on the first solve, safe afterwards,
   and LBR on every agent variant.
6. Silent correctness bugs. A faithful DeepStack reimplementation lost to Slumbot by 63 +/- 40
   (https://arxiv.org/abs/2007.10442), and robopoker invalidated earlier Slumbot numbers after a
   showdown bug fix (`eval-compute-paper.md` 3.2). Mitigation: every module gated against an
   exact or external oracle (ExactEval, OpenSpiel, poker_solver, PHH replay) before it touches
   a headline number.
7. Overfitting to a static opponent. Purified play beats static bots more and raises
   exploitability (https://www.science.org/doi/10.1126/science.aao1733). Mitigation: report
   sampled and purified separately, always next to LBR.
8. Abstraction pathologies. Finer abstractions can be worse
   (http://poker.cs.ualberta.ca/publications/AAMAS09-abstraction.pdf), and imperfect recall voids
   CFR's guarantees (https://poker.cs.ualberta.ca/publications/AAMAS13-abstraction.pdf).
   Mitigation: A/B every abstraction change; never assume monotone gains.
9. Six-max memory and claims. The N-player tree may not fit a 384 GiB box (Pluribus needed up
   to 0.5 TB); no 6-max benchmark exists, so the strongest honest 6-max claim is self-evaluation.
   Mitigation: lazy allocation and 4 B slots; r7a-class box; scope the paper's 6-max claim.
10. Licensing. AGPL code (postflop-solver, TexasSolver, DecisionHoldem) must stay out of the MIT
    tree; hand-isomorphism needs its notice kept (`open-source.md` 4).
11. Use of the agent. The overlay project has an auto-play executor for PokerNow
    (`/Users/rg/Downloads/gto-poker-overlay/docs/ARCHITECTURE.md`). Research results must come
    only from bot matches and consenting players. Running a solver-backed bot against people who
    do not know they face one is a fairness and terms-of-service problem, and a paper cannot
    report such games (`libratus-deepstack.md` 9).
12. Scope. M4 and M5 carry most of the engineering risk (research-note estimates: 1 to 2 weeks
    for the solver, 2 to 4 weeks for search). If they slip, the fallback deliverable is a
    blueprint-only paper with the evaluation tools (LBR, AIVAT, exact-EV h2h), which fits the
    NeurIPS Evaluations and Datasets track.

## 8. Facts this plan relies on that are still open

- Pluribus's iteration count, rollouts per leaf and search iterations (unpublished,
  https://noambrown.com/papers/19-Science-Superhuman_Supp.pdf).
- Supremus's and ReBeL's wall-clock compute (unreported).
- Slumbot API limits, card reveal, and which Slumbot build each paper faced.
- Per-core speed of Haswell (Pluribus) vs Zen 4 / Graviton4 for this workload.
- DecisionHoldem's >730 mbb/h claim has no CI (https://arxiv.org/abs/2201.11580); not used as an anchor.
