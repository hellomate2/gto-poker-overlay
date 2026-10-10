# Evaluation, compute budget, and paper plan (topic key: eval-compute-paper)

Researcher notes for the open Pluribus-style NLHE project. Written 2026-10-09.
Every number has a source URL next to it. "Derived" means I computed it from sourced
numbers and the arithmetic is shown. "Unverified" means I could not find a source.

Primary sources read in full text for this note (PDF text extracted locally):

- Lisy and Bowling, "Equilibrium Approximation Quality of Current No-Limit Poker Bots" (LBR), AAAI-17 Workshop on Computer Poker and Imperfect Information Games. https://arxiv.org/abs/1612.07547
- Burch, Schmid, Moravcik, Bowling, "AIVAT" (arXiv v2; published at AAAI 2018 per Pluribus ref 44). https://arxiv.org/abs/1612.06915
- Brown and Sandholm, "Superhuman AI for multiplayer poker" (Pluribus), Science 2019, plus supplementary materials. https://www.science.org/doi/10.1126/science.aay2400
- Brown and Sandholm, "Superhuman AI for heads-up no-limit poker: Libratus beats top professionals", Science 2018. https://www.science.org/doi/10.1126/science.aao1733
- Brown and Sandholm, "Libratus: The Superhuman AI for No-Limit Poker", IJCAI-17 demo. https://www.ijcai.org/proceedings/2017/0772.pdf
- Moravcik et al., "DeepStack", Science 2017 (arXiv v3 with supplement). https://arxiv.org/abs/1701.01724
- Brown, Bakhtin, Lerer, Gong, "ReBeL", NeurIPS 2020. https://arxiv.org/abs/2007.13544
- Zarick, Pellegrino, Brown, Caspers, "Unlocking the Potential of Deep Counterfactual Value Networks" (Supremus). https://arxiv.org/abs/2007.10442
- Schmid et al., "Student of Games". https://arxiv.org/abs/2112.03178
- Zhao et al., "AlphaHoldem", AAAI-22. https://pi.cs.tsinghua.edu.cn/lab/people/jlxing/zh/publication/featured02-aaai-2022/
- Provost et al., "GTO Wizard Benchmark", arXiv March 2026. https://arxiv.org/abs/2603.23660
- Li et al., "OpenHoldem". https://arxiv.org/abs/2012.06168
- Johanson, Waugh, Bowling, Zinkevich, "Accelerating Best Response Calculation in Large Extensive Games", IJCAI 2011. https://www.cs.ualberta.ca/~games/poker/publications/ijcai2011_accelerated_best_response.pdf
- Slumbot API sample client (the documentation of the API). https://slumbot.com/sample_api.py
- Our trainer README: /Users/rg/Downloads/gpo-wt/blueprint/blueprint/README.md

---

## Part 1. Evaluation

### 1.1 What the published superhuman bots actually reported

| Agent | Opponent | Result | Hands | Variance reduction | Source |
| --- | --- | --- | --- | --- | --- |
| Pluribus (6-max) | 5 humans + 1 AI | +48 mbb/game, SE 25 (supplement: 47.7, SE 25.0, p = 0.028) | 10,000 | AIVAT (multi-player form) | https://www.science.org/doi/10.1126/science.aay2400 |
| Pluribus (6-max) | 1 human + 5 AI (Elias, Ferguson) | +32 mbb/game, SE 15 (supplement: 32.7, SE 14.9, p = 0.014) | 10,000 (5,000 each) | AIVAT | same |
| Libratus (HU, 200 BB) | 4 pros | +147 mbb/game, p = 0.0002 | 120,000 over 20 days | none stated for headline; hands treated as iid | https://www.science.org/doi/10.1126/science.aao1733 |
| Libratus | Baby Tartanian8 | +63 +/- 28 mbb/game (95% CI); blueprint alone -8 +/- 15 | not in excerpt | | same |
| DeepStack (HU) | 33 pros | +486 mbb/g (AIVAT), +492 raw chips | 44,852 | AIVAT | https://arxiv.org/abs/1701.01724 |
| DeepStack | LBR | LBR loses: DeepStack +428 +/- 87 (fc preflop/flop variant) | | | same, Table 3 |
| Modicum (depth-limited solving) | Slumbot | +11 +/- 5 | | | ReBeL Table 1, https://arxiv.org/abs/2007.13544 |
| ReBeL | Slumbot | +45 +/- 5 (one standard deviation per caption) | not stated in table | AIVAT used for human match | https://arxiv.org/abs/2007.13544 |
| ReBeL | BabyTartanian8 | +9 +/- 4 | | | same |
| ReBeL | LBR (call on rounds 1-2, fcpa on 3-4) | ReBeL +881 +/- 94 | | | same |
| ReBeL | Dong Kim (human) | +165 +/- 69 | 7,500 | AIVAT | same |
| Supremus | Slumbot | +176 +/- 44 (one SE), 2,637,277 chips | 150,000 | all-in EV only | https://arxiv.org/abs/2007.10442 |
| DeepStack reimplementation | Slumbot | -63 +/- 40 (one SE) | 150,000 | all-in EV only | same |
| Supremus | LBR | Supremus +951 +/- 96 | | | same |
| Student of Games | Slumbot | +7 +/- 3 (table says one SE, text says 95% CI) | 3.1M | AIVAT | https://arxiv.org/abs/2112.03178 |
| Student of Games | LBR (fc all rounds) | SoG +434 +/- 9 | | | same |
| AlphaHoldem | Slumbot | +111.56 +/- 16.06 mbb/h (95% CI) | 100,000 | not stated in table | AAAI-22 page above |
| AlphaHoldem | OpenStack (their DeepStack reimpl.) | +16.91 +/- 22.34 | 100,000 | | same |
| GTO Wizard AI | Slumbot | +19.4 +/- 4.1 bb/100 (= 194 mbb/h) | 150,000 | AIVAT | https://arxiv.org/abs/2603.23660 |
| robopoker (open Rust Pluribus clone) | Slumbot | -13.1 bb/100 +/- 14.0 (95%) best variant | 86,000 | none (raw chips) | https://github.com/krukah/robopoker |
| DecisionHoldem | Slumbot | "more than 730 mbb/h", no CI | about 20,000 | none stated | https://arxiv.org/abs/2201.11580 |

Observations that matter for us:

1. Pluribus never reported Slumbot, LBR, or any bot benchmark. Its only evidence is 2 x 10,000 hands against pros with AIVAT. Any "Pluribus-level" claim for 6-max has no public bot yardstick (see 1.7).
2. Against Slumbot, abstraction-only blueprints are roughly break-even (Libratus blueprint vs Baby Tartanian8 was -8 +/- 15; Modicum, a blueprint plus cheap depth-limited search, was +11 +/- 5). Search is what moves the number to +45 (ReBeL) and beyond.
3. Purification against a static bot inflates head-to-head numbers. Libratus notes that removing low-probability actions beat Baby Tartanian8 more but raised exploitability (Science 2018). robopoker's README shows the argmax ("dirac") variants beat every sampled variant against Slumbot. A paper must report both head-to-head and an exploitability proxy, or reviewers will read a Slumbot margin as overfitting to a static opponent.
4. DecisionHoldem's 730 mbb/h over about 20,000 hands without a CI is a cautionary example. With a plain-chips per-hand SD of about 21 BB (derived below), 20,000 hands gives a 95% half-width of roughly 1.96 x 21,000 / sqrt(20,000) = 291 mbb/h.

### 1.2 Local Best Response (LBR): method and how to implement it for our engine

Source: https://arxiv.org/abs/1612.07547 (Figure 1 pseudocode, Tables 2 and 3).

Idea in my words: LBR plays real hands against the target strategy with no card abstraction of its own. It keeps the exact Bayesian posterior over the target's 1,326 hole-card combos (its "range"), updated after each target action by multiplying each combo's weight by the target's probability of that action with that combo, then renormalizing. At its own decision it scores a fixed menu of actions with a one-step lookahead that assumes the hand will be checked or called down after its action unless the target folds immediately:

- call value = wp * pot - (1 - wp) * amount_to_call, where wp is LBR's showdown win probability against the current range, computed by enumerating every remaining board completion.
- for each candidate bet size a: fold probability fp = sum over combos of range(h) * P(target folds with h after the bet); the non-fold range is the range reweighted by (1 - fold prob) and renormalized; recompute wp against that range; value = fp * pot + (1 - fp) * (wp * (pot + a) - (1 - wp) * (to_call + a)).
- fold is worth 0. Pick the best action if positive, else fold.

Because LBR is a legal strategy, its average winnings are a valid lower bound on the target's exploitability (in expectation). Results are reported in mbb/hand with 95% CIs.

Settings used in the literature (Table 3 of the LBR paper; DeepStack Table 3):

- "fc": fold/call only. "fcpa": fold, call, pot, all-in. "56 bets": fold, call, all-in, and 55 pot fractions 0.05 * 1.15^k for k = 0..54; a non-applicable fraction becomes min-bet or all-in.
- "Rounds 1-4" vs "Rounds 3-4": in the latter LBR just checks/calls preflop and flop and only computes LBR on turn and river. Waiting matters because LBR is greedy; against always-call it gains about 33 BB/h when active on all rounds but almost the full 50 BB/h when restricted to later rounds.
- Every ACPC result averaged 2 x 50,000 duplicate hands. Duplicate plus "imaginary observations" over all opponent hands consistent with the line shrank CIs by roughly 20%.

Published LBR lower bounds (mbb/h, 200 BB ACPC format; https://arxiv.org/abs/1612.07547 Table 3):

| Betting / rounds | Hyperborean 2013 | Hyperborean 2014 | Slumbot 2016 | Act1 2016 | Full-cards fcpa bot (100 BB) |
| --- | --- | --- | --- | --- | --- |
| fc, 1-4 | 1048 +/- 68 | 721 +/- 56 | 522 +/- 50 | 407 +/- 47 | -424 +/- 37 |
| fc, 3-4 | 1006 +/- 76 | 608 +/- 61 | 496 +/- 55 | 390 +/- 55 | -819 +/- 52 |
| fcpa, 3-4 | 4040 +/- 147 | 3852 +/- 141 | 4020 +/- 115 | 2597 +/- 140 | -536 +/- 87 |
| on-tree, 3-4 | 4743 +/- 163 | 4789 +/- 156 | n/a | n/a | -536 +/- 87 |
| 56 bets, 1-4 | 619 +/- 117 | 574 +/- 125 | 763 +/- 84 | 2429 +/- 134 | 1607 +/- 76 |
| 56 bets, 3-4 | 5062 +/- 152 | 4675 +/- 152 | 3763 +/- 104 | 3302 +/- 122 | 2403 +/- 87 |

Reference: folding every hand loses 750 mbb/h. Every abstraction bot tested was at least 3,180 mbb/h exploitable with 97.5% confidence, more than four times folding. Most of the exploitation came from the single pot bet ("fcpa"), which is inside these bots' betting abstractions, so the paper attributes it to card abstraction. A no-card-abstraction bot with fcpa betting beat LBR inside its own action set but lost 2,403 mbb/h once LBR used off-tree bets with hard translation (1,981 +/- 224 with sampled soft translation).

Cost reported: 24-core AMD Opteron 6172 nodes, 10 to 20 LBR instances per node, 1,000-hand batches; one fc batch took under half an hour, one 56-bet batch up to 8 hours. The paper states an LBR hand costs at most (n|H| + 1) strategy queries for n bet sizes, or about (n + 1) times the cost of a hand when the bot's cost is dominated by a whole-range search.

How to implement LBR for our C++ trainer (`/Users/rg/Downloads/gpo-wt/blueprint/blueprint`):

1. Opponent policy query for all 1,326 combos at a public node: for each combo not blocked by board or LBR's cards, compute its street bucket (preflop class, flop/turn k-means tables, river EHS bucket), then read the blueprint row at (node, bucket). This is 1,326 table lookups plus bucket computation; the trainer already has every lookup.
2. Action translation: LBR bets that are not in the tree must be mapped into the tree to query the target. Run LBR first with only on-tree sizes (our `small` and `medium` presets include pot-sized bets and all-in postflop, so "fcpa" postflop is on-tree), which isolates card-abstraction error. Then add off-tree sizes with the translation the real-time engine will use (pseudo-harmonic mapping, Ganzfried and Sandholm IJCAI-13) to measure translation error. Report both, as the LBR paper did.
3. wp rollout: enumerate remaining boards against the weighted range using the 7-card evaluator (README: 101 to 155 M evals/s per thread). On the flop that is up to 1,081 runouts times about 1,000 live combos, around 1e6 evaluations, so tens of milliseconds per wp call per thread (derived from the README throughput; not measured). Cache wp per (board, range hash).
4. Variance: play duplicate (same deal, seats swapped), and score each hand by expectation over the target's range on that line (the imaginary observation trick). Run 2 x 50,000 duplicate hands per setting to match the literature.
5. Settings to report: fc 1-4, fc 3-4, fcpa 3-4, 56-bets 3-4, plus "call first two rounds, fcpa last two" (ReBeL's setting) and fc all rounds (SoG's setting) so our numbers line up with every published table.
6. Once real-time search exists, the target's strategy at a node comes from a search run that already outputs a strategy for all hands, so LBR needs one search per LBR decision per candidate action (the (n + 1) factor).
7. Unit test: on Leduc, LBR must never exceed the exact best response value that `ExactEval` already computes, and must be close to it for simple chumps (always call).

Pitfalls: LBR can lose to a decent agent (DeepStack, ReBeL, SoG all beat it), and the LBR paper notes LBR results do not predict head-to-head (Act1 lost to Slumbot in the ACPC but is 1,300 mbb/h less exploitable per DeepStack's supplement). A negative LBR number is evidence of no easy exploit, not of low exploitability.

### 1.3 A stronger, cheap check we can actually afford: full-card best response restricted to the blueprint's betting tree

Johanson et al. (IJCAI 2011) computed exact best responses in heads-up limit hold'em by walking the public tree with vectors over hands, doing O(n log n) showdown evaluation, and splitting at the flop into 7 preflop sequences x 1,755 canonical flops = 12,285 subgames per position (24,570 total). Each took about 4.5 minutes, 76 CPU-days in total, just over a day on 72 processors. https://www.cs.ualberta.ca/~games/poker/publications/ijcai2011_accelerated_best_response.pdf

For our blueprint, a best responder that sees real cards but is restricted to the blueprint's own betting tree measures card-abstraction error exactly (the gap the LBR paper says dominates). Its cost scales with (number of preflop sequences reaching the flop) x 1,755 x (postflop tree size relative to limit). I have no measured HUNL figure for this, so the cost is unverified; the arithmetic for budgeting: 76 CPU-days = 1,824 core-hours, which at AWS c8g.48xlarge spot ($2.576/h for 192 cores, see Part 2) is about $24 (derived: 1,824 / 192 x 2.576). A tree 10x larger would be about $245. This is cheaper than it sounds and it is a number reviewers trust more than our in-abstraction MCCFR exploiter (`bp br`), which only sees buckets.

### 1.4 AIVAT: method and how to implement it for heads-up play against Slumbot or GTO Wizard

Source: https://arxiv.org/abs/1612.06915

Idea in my words: start from the observed chip result, then add zero-mean control-variate terms that cancel the luck we can explain.

- Chance correction: at every chance event (hole cards, flop, turn, river) add E over possible outcomes of u(after) minus u(observed outcome). This is MIVAT.
- Action correction for players whose strategy we know (our own agent): at each of our decisions add sum over actions sigma(a) * u(a) minus u(observed action). Opponent actions get no correction since their strategy is unknown.
- Imaginary observations over our private hand: rather than evaluating only the hand we held, evaluate every hand we could hold that is consistent with the public line, weighted by our own reach probability of that line (we know our strategy). The base value is that reach-weighted average of terminal values; the correction terms are computed in the same reach-weighted way at each decision point, so terms do not double count.
- Unbiasedness proof: each correction has expectation zero because the expectation is taken with the true chance probabilities and our true strategy; the value function u can be anything, it only affects variance.

Inputs we need: (a) our exact strategy at every decision for every hand we could hold (the blueprint table, or the search output for all hands), (b) a value function u(public state, our hand, action). The AIVAT paper used values from a small abstraction with only 8 million infosets solved by MCCFR and still cut SD by about 68%; DeepStack used its own counterfactual value networks; we can use the blueprint's self-play expected values per (node, bucket) collected during or after training.

Published variance numbers (HUNL, 1 chip SB, 2 chip BB, 200 chips = 100 BB, 1 million games each; https://arxiv.org/abs/1612.06915 Figures 4 and 5):

| Estimator | SD self-play (chips/hand) | SD dissimilar agents (chips/hand) | SD in mbb/hand (derived, 1 BB = 2 chips) |
| --- | --- | --- | --- |
| Plain chips | 25.962 | 26.308 | about 12,981 / 13,154 |
| MIVAT | 21.293 | 21.546 | about 10,647 / 10,773 |
| MIVAT + imaginary obs. | 16.073 | 16.051 | about 8,037 / 8,026 |
| AIVAT (our strategy known) | 8.095 | 8.301 | about 4,048 / 4,151 |

That is about a 68% SD reduction, which the authors summarize as the same significance with ten times less data. Pluribus's supplement says AIVAT reduced variance "by about a factor of 9" in its matches. GTO Wizard's benchmark paper also describes a threefold SD reduction (https://arxiv.org/abs/2603.23660).

Implementation plan for us (heads-up):

1. Log every hand fully: our hole cards, board, action string, our strategy vector at each of our decisions for all 1,326 hands (or enough to recompute it deterministically from a seed), opponent hole cards when shown.
2. Precompute u: for each blueprint (node, our bucket) the expected self-play value of each action; map hands to buckets at evaluation time. Better u gives more reduction; the estimator stays unbiased regardless.
3. For each hand compute base value (reach-weighted over our possible hands for the observed public line; terminal payoff needs the opponent's cards at showdown, which only matter where the opponent's cards are revealed or the opponent folded) plus chance and action correction terms.
4. Opponent card visibility: Slumbot's sample client documents only our hole cards, the board, the action string and `winnings` (https://slumbot.com/sample_api.py). Whether the API reveals Slumbot's hole cards at showdown is unverified; check a live response before relying on full AIVAT. GTO Wizard's API returns AIVAT scores itself (https://arxiv.org/abs/2603.23660).
5. Validation: on Leduc with both strategies known, AIVAT should remove almost all variance (the paper reports a little under 99.9% SD reduction in self-play with both strategies known). Use this as a unit test, plus a test that the mean over many hands equals the plain mean within CI on HUNL self-play.
6. Cheap partial step if full AIVAT slips: all-in EV adjustment (score all-ins before the river by equity over remaining boards), which Supremus used for its 150,000-hand Slumbot match.

A second big win in our own bot-vs-bot testing (both strategies known, abstract game): score each duplicate deal by the exact expected value under both policies (a tree walk with reach probabilities) instead of sampling actions. This removes all action variance; only card variance remains, which duplicate already reduces. `play_h2h` in `src/main.cpp` currently samples actions; the tree walk costs one pass over the betting tree per deal (29,346 nodes for the `small` tree per the README), which is affordable. This is my suggestion, not a published method name.

### 1.5 Duplicate poker

Each deal is played twice with seats swapped so card luck mostly cancels (LBR paper; OpenHoldem notes duplicate and AIVAT can be combined, https://arxiv.org/abs/2012.06168). Our `bp h2h` already does duplicate with the seat-averaged deal as the sample unit. Duplicate is only available when we control both sides' deals: it works against our own checkpoints, LBR, and local bots, but not against the Slumbot or GTO Wizard web APIs, where the server deals.

### 1.6 Sample sizes for a given confidence

Formula: hands n = (z * sigma / h)^2 for a two-sided 95% half-width h (z = 1.96). Per-hand sigma estimates, all from primary sources:

| sigma (mbb/hand) | Where it comes from |
| --- | --- |
| about 21,000 | robopoker vs Slumbot, raw chips, 200 BB: 14.0 bb/100 half-width over 86,000 hands gives 140 / 1.96 x sqrt(86,000) = 20,946 (derived; https://github.com/krukah/robopoker) |
| about 17,041 | Supremus vs Slumbot, all-in EV adjusted, 200 BB: 44 x sqrt(150,000) (derived; one-SE convention stated in https://arxiv.org/abs/2007.10442) |
| about 12,981 | AIVAT paper, plain chips, 100 BB self-play (derived from 25.962 chips) |
| about 4,048 | AIVAT paper, AIVAT, 100 BB (derived from 8.095 chips) |
| 2,695 or 5,282 | Student of Games vs Slumbot with AIVAT: 3 mbb over 3.1M hands, depending on whether +/- 3 is a 95% CI (text) or one SE (table caption); ambiguous in https://arxiv.org/abs/2112.03178 |

Hands needed (derived with the formula):

| sigma | h = 10 mbb | h = 25 | h = 50 | h = 100 |
| --- | --- | --- | --- | --- |
| 21,000 (raw chips vs Slumbot) | about 16.9M | about 2.7M | about 678k | about 169k |
| 17,041 (all-in EV only) | 11.2M | 1.78M | 446k | 112k |
| 12,981 (plain, 100 BB) | 6.47M | 1.04M | 259k | 65k |
| 4,048 (AIVAT) | 629k | 101k | 25k | 6.3k |

Practical targets: to show "beats Slumbot by at least ReBeL's +45" with a lower 95% bound above 0, a true +45 needs h < 45. With raw chips that is about (1.96 x 21,000 / 45)^2 = 837k hands; with AIVAT about 31k (derived). This is why AIVAT is the first evaluation feature to build. Pluribus used a one-tailed t test at 95% (supplement), which needs z = 1.645 instead of 1.96 and is what Pluribus reported; state which one we use before running.

Do not stop a match early when the number looks good (optional stopping inflates false positives); fix the hand count in advance.

### 1.7 Slumbot and GTO Wizard as public opponents

Slumbot API (https://slumbot.com/sample_api.py): HTTP POST JSON to `/slumbot/api/new_hand` and `/slumbot/api/act` (plus `/slumbot/api/login` for registered users; anonymous play works with a token returned by `new_hand`). Blinds 50/100, 200 BB stacks (20,000 chips), stacks reset every hand. Action string uses k/c/f/b<chips>, bet sizes are chips put in on that street, "/" separates streets. `client_pos` 0 means we are the big blind. Responses carry `winnings` at hand end. Slumbot won the 2018 ACPC (Supremus, AlphaHoldem papers) and its 2019 code is open source under MIT (https://github.com/ericgjackson/slumbot2019). GTO Wizard's paper says Jackson opened the API in 2021 (https://arxiv.org/abs/2603.23660). OpenHoldem's authors reported the site was unstable for long browser-driven sessions (https://arxiv.org/abs/2012.06168). Throughput per connection: unverified.

Important mismatch: our trainer's default is 100 BB (10,000 chips, README). Slumbot, GTO Wizard Benchmark and the ACPC LBR numbers are 200 BB. We must train a 200 BB blueprint (`--stack 20000`) for those matches, or every number is off-format.

GTO Wizard Benchmark (https://arxiv.org/abs/2603.23660, client https://github.com/gtowizard-ai/researcher-api-client): public REST API, ACPC rules (50/100, 200 BB, stacks reset), returns AIVAT score, AIVAT SD, chips, and chance/action correction components. Access by application form; pricing and rate limits are not stated (unverified). GTO Wizard AI beat Slumbot by 19.4 +/- 4.1 bb/100 over 150,000 hands. Published scores so far are for LLMs (best -16.04 bb/100, always-fold -64.56) and baselines (check-call -241.01, random -284.85, all-in -380.57), each over 5,000 hands. It gives us a second, stronger, AIVAT-scored opponent.

### 1.8 What would credibly count as "Pluribus-level" for an open reimplementation

Pluribus's own claim rests on human play only, so we need a defensible proxy ladder. My proposal, with the published anchor for each rung:

Heads-up (200 BB, ACPC rules):

1. Blueprint parity: blueprint alone at least break-even with Slumbot (Libratus blueprint vs Baby Tartanian8 was -8 +/- 15; robopoker -13.1 +/- 14.0 bb/100).
2. Search parity: blueprint plus real-time search beats Slumbot with the 95% lower bound above zero, target at least +45 mbb/h (ReBeL), AIVAT-scored, hand count fixed in advance.
3. Exploitability proxies: LBR fails to win in every published setting (fc, fcpa 3-4, 56 bets 3-4, ReBeL's setting), like DeepStack, ReBeL and SoG; plus a full-card best response inside our betting tree (1.3) with its value reported.
4. Stronger-opponent check: GTO Wizard Benchmark AIVAT score reported with CI. No search-based bot has published a score there yet (as of the March 2026 paper), so any result is new information; losing to it is expected.
5. Ablations showing which component buys what (Part 3).

Six-max:

6. No public 6-max bot benchmark exists that I could find. Credible evidence options: (a) the 6-max agent with search beats its own blueprint and a field of open agents in long AIVAT-scored self-play tables; (b) a human study modeled on Pluribus's 1H+5AI format with AIVAT and a pre-registered 10,000-hand count. Pluribus paid $50,000 split across pros for the 5H+1AI match and $2,000 plus a $2,000 bonus per pro in 1H+5AI (Science 2019), far over our budget, so a human study would have to be smaller and the paper should say so.

Honest framing for the paper title and abstract: "an open, reproducible Pluribus-style system that beats Slumbot and resists LBR on a $X budget", not "superhuman". Reviewers will reject a superhuman claim without a human study.

---

## Part 2. Compute

### 2.1 What Pluribus and Libratus used

- Pluribus blueprint: 8 days on a 64-core server, 12,400 CPU core hours, under 512 GB of memory; "at current cloud computing spot instance rates, this would cost about $144" (Science 2019, https://www.science.org/doi/10.1126/science.aay2400). Implied 2019 rate: $144 / 12,400 = $0.0116 per core-hour (derived). Check: 8 x 24 x 64 = 12,288 core-hours, consistent with 12,400.
- Supplement: trained on one 64-core shared-memory node with four 16-core Intel Xeon "E5-8860 v3" CPUs (as printed) and 3 TB available, under 0.5 TB used. Live play on one 28-core, 128 GB node (two 14-core Xeon E5-2695 v3); search took 1 to 33 s per subgame, about 20 s per hand in self-play.
- Supplement, blueprint details: Linear CFR discounting every 10 minutes for the first 400 minutes; pruning after 200 minutes on 95% of iterations for actions with regret below -300,000,000 except on the last round or actions ending the hand; regret floor -310,000,000; 4-byte integer regrets; average strategy kept only for the first betting round after 800 minutes, later rounds use averaged snapshots of the current strategy taken every 200 minutes. 664,845,654 action sequences in the blueprint action abstraction, 413,507,309 ever encountered, memory allocated lazily on first visit (cut memory by more than 2x). Lossless preflop, 200 buckets per postflop round in the blueprint; 500 buckets per later round inside search; 1 to 14 raise sizes per decision.
- Libratus: about 25 million core hours in total, of which about 13M for experiments and evaluation, about 6M for the abstraction and equilibrium finding, 3M for nested subgame solving, 3M for self-improvement; 196 Bridges nodes (128 GB, 28 cores each, 14 used) (https://www.ijcai.org/proceedings/2017/0772.pdf). Card abstraction: 55M turn hands into 2.5M buckets, 2.4B river hands into 1.25M buckets (same source).
- DeepStack value nets: turn net training data from 10 million solved turn situations using over 175 core years; flop net data used a cluster of 20 GPUs and half a GPU-year; play ran on one GTX 1080 (https://arxiv.org/abs/1701.01724).
- ReBeL HUNL: 90 DGX-1 machines (8 x 32 GB V100 each) for data generation, results after 1,750 epochs (https://arxiv.org/abs/2007.13544). Out of our budget.
- AlphaHoldem: three days on one server with 8 GPUs and 64 CPU cores (AAAI-22 page above). OpenStack (their DeepStack reimplementation): three weeks on 120 GPUs (same).
- DecisionHoldem: about 200 million iterations, a 48-core workstation for 3 to 4 days, about 4,000 core hours (https://arxiv.org/abs/2201.11580).

### 2.2 Current prices (fetched 2026-10-09; spot prices move hourly)

AWS us-east-1, Linux (https://instances.vantage.sh pages; cores per AWS CPU options table https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/cpu-options-supported-instances-values.html):

| Instance | vCPU / physical cores | Memory | On-demand $/h | Spot $/h | Spot $/core-h (derived) | Source |
| --- | --- | --- | --- | --- | --- | --- |
| c7a.16xlarge | 64 / 64 | 128 GiB | 3.284 | 1.150 | 0.0180 | https://instances.vantage.sh/aws/ec2/c7a.16xlarge |
| c7a.48xlarge (Zen 4) | 192 / 192 | 384 GiB | 9.85344 | 3.414 | 0.0178 | https://instances.vantage.sh/aws/ec2/c7a.48xlarge |
| m7a.48xlarge | 192 / 192 | 768 GiB | 11.12832 | 3.627 | 0.0189 | https://instances.vantage.sh/aws/ec2/m7a.48xlarge |
| r7a.48xlarge | 192 / 192 | 1536 GiB | 14.6064 | 3.322 | 0.0173 | https://instances.vantage.sh/aws/ec2/r7a.48xlarge |
| c8g.48xlarge (Graviton4, arm64) | 192 / 192 | 384 GiB | 7.657 | 2.576 | 0.0134 | https://instances.vantage.sh/aws/ec2/c8g.48xlarge |
| r8g.48xlarge (Graviton4) | 192 / 192 | 1536 GiB | 11.31072 | 3.536 | 0.0184 | https://instances.vantage.sh/aws/ec2/r8g.48xlarge |
| c6a.48xlarge (Zen 3) | 192 / 96 | 384 GiB | 7.344 | 2.798 | 0.0291 per physical core | https://instances.vantage.sh/aws/ec2/c6a.48xlarge |

c7a/r7a/m7a and Graviton have one thread per core (no SMT); c6a has 2. Our trainer builds with any C++17 compiler and is fine on arm64 (README: Apple clang on arm64), so Graviton is a candidate.

GCP us-central1 (https://gcloud-compute.com):

| Machine | vCPU | Memory | On-demand $/h | Spot $/h | Source |
| --- | --- | --- | --- | --- | --- |
| c3d-highcpu-180 | 180 (SMT, so 90 cores) | 354 GB | 6.7228 | 1.6398 | https://gcloud-compute.com/c3d-highcpu-180.html |
| c3d-highmem-180 | 180 | 1440 GB | 11.0223 | 2.6888 | https://gcloud-compute.com/c3d-highmem-180.html |
| n2d-highmem-96 | 96 | 768 GB | 5.471 | 2.6659 | https://gcloud-compute.com/n2d-highmem-96.html |

That c3d is 2 threads per core is my understanding of GCP vCPUs, not re-verified on a Google page (unverified).

Azure (https://cloudprice.net): Standard_D96as_v5, 96 vCPU, 384 GiB, $4.128/h East US, $2.666/h cheapest (Central India); Standard_HB176rs_v4, 176 vCPU, 768 GiB, $7.20/h East US. Spot prices were behind a paywall on that site (unverified).

Hetzner dedicated (https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), new prices from 15 June 2026, excluding VAT: AX162-1 $722.10/month + $359 setup; AX162-2 $992.10 + $494; AX162-3 $1,897.10 + $949; AX102-1 $302.10 + $149. AX162 uses a 48-core AMD EPYC 9454P (https://www.hetzner.com/dedicated-rootserver/matrix-ax/). The RAM in each AX162 tier was not in the price table (unverified). Hetzner raised prices on 1 April 2026 and again 15 June 2026, citing RAM and SSD costs (https://heise.de/-11185981). It is no longer the cheap option for a one-off run.

Vast.ai marketplace (public offers API https://console.vast.ai/api/v0/bundles/, queried 2026-10-09, on-demand, cheapest first): machines with at least 64 CPU threads from $0.121/h (72 threads, 16 GB RAM); at least 96 threads and 250 GB RAM from $0.483/h (192 threads on 2 x 48-core EPYC 7K62, 252 GB, host reliability 0.933) and $0.966/h (112 of 224 threads, EPYC 7663, 315 GB, reliability 0.996). H100 SXM from $1.80/GPU-h. These are GPU hosts rented for their CPUs; hosts are third parties, RAM and uptime vary, and we should not put anything secret on them.

GPU clouds: RunPod H100 PCIe $2.89/h, H100 SXM $3.99/h, A100 80 GB $1.79/h, RTX 4090 $0.89/h, L40S $1.09/h (https://www.runpod.io/pricing); RunPod lists no CPU-only pods on that page. Lambda H100 SXM $3.99 to $4.29/GPU-h, A100 80 GB $2.79, GH200 $2.29 (https://lambda.ai/pricing). GPUs matter only if we train value networks (DeepStack/ReBeL style); MCCFR blueprints are CPU and memory-bandwidth work.

### 2.3 Cost to rerun Pluribus's 12,400 core-hours today (derived)

12,400 / 192 = 64.6 hours on one 192-core AWS box.

| Machine | Fits 512 GB? | Spot cost | On-demand cost |
| --- | --- | --- | --- |
| c8g.48xlarge | no (384 GiB) | 64.6 x 2.576 = $166 | 64.6 x 7.657 = $495 |
| c7a.48xlarge | no (384 GiB) | $220 | $636 |
| m7a.48xlarge | yes (768 GiB) | $234 | $719 |
| r7a.48xlarge | yes (1536 GiB) | $215 | $943 |
| r8g.48xlarge | yes (1536 GiB) | $228 | $731 |
| GCP c3d-highmem-180 (90 cores) | yes | 137.8 h x 2.6888 = $370 | $1,519 |
| Azure HB176rs_v4 (176 cores) | yes (768 GiB) | spot unverified | 70.5 h x 7.20 = $507 |
| Hetzner AX162-1 (48 cores) | RAM tier unverified | n/a | 258 h, about 10.8 days, inside one month: $722 + $359 setup = $1,081 |
| Vast 2 x EPYC 7K62, 96 cores, 252 GB | no | 129 h x 0.483 = $62 | |

Caveat: a 2015 Haswell core-hour and a 2023 Zen 4 or Graviton4 core-hour are not the same unit; per-core speedup for this workload is unverified, so these are rough. Pluribus's $144 at 2019 spot rates becomes roughly $166 to $234 today on AWS spot. Spot can be interrupted; our trainer checkpoints with temp-file-and-rename and resumes with `--resume` (README), which is what makes spot usable.

### 2.4 Memory for regret tables

From the README: 12 bytes per regret slot (int32 regret + double average), 2.56 to 2.64 actions per infoset, so about 31 bytes per infoset. Dropping postflop averages as Pluribus did (current-strategy snapshots instead) gives 4 bytes per slot, about 10.5 bytes per infoset. Pluribus used 4-byte integer regrets.

| Infosets | Slots (x 2.64) | 12 B/slot | 4 B/slot |
| --- | --- | --- | --- |
| 3.09e7 (medium tree, 200 buckets; README) | 8.15e7 | 1.0 GB | 0.33 GB |
| 1.54e8 (medium, 1000 buckets; README) | 4.07e8 | 4.9 GB | 1.6 GB |
| 1.5e9 (hypothetical large HU tree) | 3.96e9 | 47.5 GB | 15.8 GB |
| 1.0e10 (hypothetical) | 2.64e10 | 317 GB | 106 GB |

Fixed overheads (README): river bucket table 178 MB, turn table 44 MB. Lazy allocation on first visit (Pluribus: more than 2x saving) is the second memory lever after dropping averages. Memory bandwidth, not capacity, is likely the binding limit for large tables on 192 cores; scaling past 4 threads is unmeasured (README).

### 2.5 Wall clock and dollars for our trainer at three sizes (derived; assumptions stated)

Measured inputs (README, Apple M3 Pro, medium tree, 200 buckets): 46.2 M infoset visits/s on 4 threads, so 11.55 M visits per thread-second. Quality rule from the README: about 160,000 visits per infoset reached the quality of the 25-minute small run (exploiter +20.5 +/- 9.0 mbb/hand inside the abstraction). The README calls this rule crude.

Unmeasured assumptions I add: f = speed of one server core relative to one M3 Pro thread at this table size (1.0 / 0.75 / 0.5), and e = parallel efficiency on 192 cores (0.85 / 0.7 / 0.5).

Arithmetic: visits = infosets x 160,000; M3 thread-hours = visits / (11.55e6 x 3600); core-hours = that / f; wall = core-hours / (192 x e); dollars = wall x hourly price.

| Size | Visits | M3 thread-h | Scenario | Core-h | Wall on 192 cores | c8g spot ($2.576) | c7a spot ($3.414) | c7a on-demand ($9.85) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Medium, 200 buckets (3.09e7 infosets, 1.0 GB) | 4.94e12 | 119 | optimistic | 119 | 0.7 h | $2 | $2 | $7 |
| | | | middle | 158 | 1.2 h | $3 | $4 | $12 |
| | | | pessimistic | 238 | 2.5 h | $6 | $8 | $24 |
| Medium, 1000 buckets (1.54e8, 4.9 GB) | 2.47e13 | 593 | optimistic | 593 | 3.6 h | $9 | $12 | $36 |
| | | | middle | 791 | 5.9 h | $15 | $20 | $58 |
| | | | pessimistic | 1,186 | 12.4 h | $32 | $42 | $122 |
| Large, hypothetical 1.5e9 infosets (47.5 GB at 12 B/slot) | 2.4e14 | 5,772 | optimistic | 5,772 | 35 h | $91 | $121 | $348 |
| | | | middle | 7,696 | 57 h | $148 | $195 | $564 |
| | | | pessimistic | 11,544 | 120 h | $310 | $411 | $1,185 |

Notes: the 1000-bucket rows are optimistic because river buckets above 255 fall back to per-deal EHS (about 5 us per deal, README). The large row's infoset count is a design choice, not a measured tree. Even the pessimistic large run fits the $500 to $1,000 budget on spot, leaving room for 2 or 3 seeds or ablations at the medium size. Before renting, measure f and e directly: run `bp bench --max-threads 192` for 10 minutes on the target box (a few dollars) and replace the assumptions.

Suggested budget split (my proposal): about $50 for benchmarking instance types and a medium-200 run; about $150 to $400 for the main large heads-up blueprint on spot; about $100 for ablations at medium size; about $50 to $100 for evaluation compute (LBR batches, full-card in-tree best response); the rest held for a 6-max blueprint, which will need more memory (an r7a/r8g/m7a class box).

---

## Part 3. The paper

### 3.1 Venues (dates from official pages where I could fetch them)

- AAMAS 2027: main-track abstracts were due 1 October 2026 and papers 8 October 2026 (passed). There is an "AAAI fast track" for papers rejected from AAAI-27 whose reviewer scores were all 5 or higher, due 11 December 2026 (https://warwick.ac.uk/fac/sci/dcs/aamas2027/calls/call-for-aaai-fast-track/; main-track dates from https://warwick.ac.uk/fac/sci/dcs/aamas2027/calls/call-for-main-track/ via search snippet). Conference 3 to 7 May 2027, Hanoi.
- AAAI-27: full papers were due 28 July 2026 (passed) (https://aaai.org/conference/aaai/aaai-27/main-technical-track-call/). AAAI-28 would be the next cycle, roughly mid-2027 (unverified). Historically the home of computer-poker work and the old ACPC.
- IJCAI-ECAI 2027: deadline estimated around 15 January 2027 by a third-party tracker, not yet official (https://www.opencurious.com/ai-conference-deadlines/ijcai-2027). LBR-style evaluation and best-response papers have appeared at IJCAI (Johanson 2011; Timbers et al. 2022, https://www.ijcai.org/proceedings/2022/484).
- NeurIPS Evaluations and Datasets track (renamed from Datasets and Benchmarks in 2026): 2026 deadline was 3 August (passed); it asks submissions to state what evaluative claims they support and requires code (https://neurips.cc/Conferences/2026/CallForEvaluationsDatasets). An open evaluation harness (LBR + AIVAT + in-tree BR + Slumbot client) fits this track well in 2027.
- NeurIPS reproducibility track via TMLR: NeurIPS 2026 partnered with the ML Reproducibility Challenge; papers must first be accepted at TMLR, eligibility window 20 June 2025 to 30 September 2026, for work published from 2025 onward (https://neurips.cc/Conferences/2026/CallForReproducibility). Pluribus (2019) is outside that scope rule, so this track fits only if a future call widens it. TMLR itself takes rolling submissions.
- IEEE Transactions on Games and IEEE CoG: PokerKit appeared in IEEE ToG vol. 17 no. 1 (2025) per search results (https://arxiv.org/abs/2308.07327). CoG 2026 full papers were due 17 March 2026 (https://cog2026.fdi.ucm.es/cfp); CoG 2027 dates unverified.
- arXiv: post the preprint the moment results are in; GTO Wizard Benchmark, OpenHoldem, Supremus and DecisionHoldem all lived on arXiv.
- Competitions: the ACPC was discontinued after 2018 (https://arxiv.org/abs/2603.23660). I found no active successor competition; the de facto public benchmarks are the Slumbot API and the GTO Wizard Benchmark API.

### 3.2 What recent open or reproduction poker papers looked like

- Supremus (arXiv 2020): a careful DeepStack reimplementation first (showed it loses to Slumbot by 63 +/- 40 over 150,000 hands and beats LBR by 536 +/- 68), then each improvement added and measured. This "reproduce, find the gap, fix it" structure is the template closest to our project.
- OpenHoldem (arXiv 2020, journal format): evaluation protocol (duplicate, AIVAT, LBR), four public baseline agents (rule-based, CFR static, DeepStack-like, RL), an online platform, and ablations of their DeepStack-like agent's training data size.
- AlphaHoldem (AAAI-22): compute table comparing CPU-hours, GPU-hours, storage against DeepStack and Libratus; head-to-head vs Slumbot, a DeepStack reimplementation, and pros; ablations of each training trick; released hand histories.
- GTO Wizard Benchmark (arXiv 2026): API description, AIVAT protocol, per-agent tables with AIVAT score, SD, chips, chance and action corrections.
- DecisionHoldem (arXiv 2022): code and Slumbot tools released, but small samples and no CIs; reviewers would flag this.
- robopoker (GitHub, Rust): open Pluribus-parity attempt with a variant cube, 95% CIs, and a statement that earlier numbers became incomparable after a showdown bug fix. Good honest practice to copy.

### 3.3 Baselines reviewers will expect

1. Slumbot (API) with AIVAT, fixed hand count, 200 BB.
2. GTO Wizard Benchmark AIVAT score.
3. LBR in the standard settings (fc, fcpa 3-4, 56 bets 3-4, ReBeL setting, SoG setting) so rows align with published tables.
4. Full-card best response restricted to our betting tree (exact card-abstraction error) and our in-abstraction MCCFR exploiter.
5. Our own blueprint without search, and earlier checkpoints (learning curve in mbb/h vs core-hours).
6. Simple agents (always call, always raise, random) as sanity rows; GTO Wizard publishes these too.
7. An open-source comparator we can run locally: slumbot2019 trained by us at a matched budget, or robopoker. Matching compute is what makes this fair.
8. Published numbers for Libratus, DeepStack, ReBeL, Supremus, SoG, AlphaHoldem, Modicum vs Slumbot and LBR, quoted with their CI conventions (one SE vs 95%), since conventions differ.

### 3.4 Ablations reviewers will expect

- Linear CFR discounting on vs off; negative-regret pruning on vs off (with the threshold); regret floor.
- Average strategy vs current-strategy snapshots postflop (the Pluribus memory trick).
- Card abstraction: bucket counts (50 / 200 / 1000), distribution-aware vs potential-aware (EMD) features.
- Betting abstraction size (tiny / small / medium / large) and action translation method for off-tree bets.
- Search on vs off; search depth; number of continuation strategies at the leaves (Pluribus used 4: blueprint, fold-biased, call-biased, raise-biased); safe vs unsafe search.
- Sampling vs purification at play time (report the exploitability cost alongside the Slumbot gain).
- Compute scaling: quality vs core-hours on one curve, 2 to 3 seeds per point if the budget allows, with CIs.
- Evaluation method ablation: CI width from raw chips vs all-in EV vs AIVAT on the same hands.

### 3.5 Draft outline

Working title: "An Open, Low-Cost Reproduction of Pluribus-Style No-Limit Hold'em: Blueprint, Search, and a Reproducible Evaluation Protocol"

1. Introduction. Pluribus's closed code and pseudocode-only release (its paper says the code was not released because poker is played commercially). Our contributions: (a) open C++ trainer and TS runtime; (b) heads-up results vs Slumbot and GTO Wizard with AIVAT; (c) LBR and in-tree best response numbers; (d) total compute cost in dollars; (e) released checkpoints, logs, and hand histories.
2. Background. NLHE rules and formats (100 BB vs 200 BB); CFR, MCCFR, Linear CFR, pruning; abstraction; depth-limited search; prior systems and their evaluation numbers (table 1.1).
3. System. Card abstraction (suit isomorphism, EHS histograms, k-means, counts per street); betting abstraction; MCCFR with Pluribus schedule; memory layout; lock-free threading; export format; real-time search; action translation.
4. Correctness gates. Kuhn and Leduc exact exploitability curves (README already has them); evaluator tests; isomorphism counts.
5. Evaluation protocol. Duplicate, exact-EV bot-vs-bot scoring, AIVAT details and validation on Leduc, LBR settings, in-tree best response, pre-registered hand counts and test (one- vs two-tailed).
6. Heads-up results. Learning curves; Slumbot; GTO Wizard; LBR table; best response; comparison table with published systems.
7. Ablations (3.4).
8. Compute and cost. Hardware, core-hours, dollars, memory; comparison with Pluribus's 12,400 core-hours and $144, Libratus's 25M core-hours, DecisionHoldem's 4,000 core-hours.
9. Six-max extension. Blueprint, search, self-play tables with AIVAT; any human games with honest sample sizes.
10. Limitations. No large human study; Slumbot is static and beatable by exploitation; LBR is only a lower bound; card abstraction error; core-hour comparisons across CPU generations.
11. Reproducibility statement and release (code license, seeds, checkpoint hashes, scripts that rebuild every table).

---

## Implementation checklist for the evaluation work (priority order)

1. Add a `--stack 20000` 200 BB training preset and confirm all evaluation tools use 200 BB to match Slumbot, GTO Wizard and ACPC-era LBR numbers.
2. Exact-EV duplicate scoring in `play_h2h` (tree walk under both policies) for every bot-vs-bot comparison.
3. AIVAT for our agent in heads-up, with the Leduc both-strategies-known test and an unbiasedness test.
4. Slumbot API client that logs full hand records (C++ or TS), resumable, with a fixed pre-registered hand count.
5. LBR in C++ with the five standard settings; Leduc test against `ExactEval`.
6. Full-card best response inside the blueprint betting tree (Johanson-style public-tree walk, parallel over flop subgames).
7. GTO Wizard Benchmark application and client.
8. A `bench` run on the rented box before any long training run, to replace the f and e assumptions in 2.5.
