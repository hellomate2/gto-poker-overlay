# Heads-up predecessors: Libratus, DeepStack, Cepheus/CFR+, Slumbot (and Modicum as the cheap bridge)

Topic key: `libratus-deepstack`. Written 2026-10-09 for the gpo swarm (goal: open-source Pluribus-level NLHE bot plus paper, $500 to $1000 of compute).

Every figure below has a source link next to it. Where I could not find a primary source the text says "unverified". Dollar conversions of core-hours are deliberately left out: they need a current cloud price quote, which this note does not have.

## 0. Short version for the swarm

1. The cheapest proven recipe for beating a strong static HUNL bot is not DeepStack and not full Libratus. It is Modicum (Brown, Sandholm, Amos, NeurIPS 2018): a small MCCFR blueprint (700 core-hours, 16 GB RAM, about 5 GB strategy) plus real-time solving, which beat Slumbot by 11 ± 9 mbb/g and Baby Tartanian8 by 6 ± 5 mbb/g on a 4-core CPU at about 20 s per hand. [arXiv 1805.08195](https://arxiv.org/abs/1805.08195). Our C++ MCCFR trainer already covers the blueprint half of that.
2. The missing piece in our stack is a fast vectorized range-vs-range CFR+/DCFR subgame solver in C++ with (a) a Libratus-style safe gadget (Resolve/Reach with estimated alternative payoffs) and (b) nested re-solving after every opponent bet. That single component gives the largest measured gains in all four systems studied here (Libratus Table 3: blueprint -8 ± 15 vs Baby Tartanian8, nested solving +63 ± 28; Modicum Table 1: blueprint -11 ± 8 vs Slumbot, depth-limited solving +11 ± 9).
3. Action translation is the weakest link of an abstraction bot. In the NIPS 2017 experiment, randomized pseudo-harmonic mapping was exploitable for 1,465 mbb/h while nested Reach-Maxmargin solving cut that to 119.1 mbb/h. [arXiv 1705.02955, Table 4](https://arxiv.org/abs/1705.02955)
4. DeepStack-style value networks are expensive to train from scratch: the turn network alone used 10M solved turn situations and over 175 core-years on 6,144 cores. [arXiv 1701.01724 supplement](https://arxiv.org/abs/1701.01724). A faithful reimplementation lost to Slumbot by 63 ± 40 mbb/g; only after Supremus-level improvements (river net, 50M/20M/5M samples, DCFR+, all-GPU solver) did it beat Slumbot by 176 ± 44 mbb/g. [arXiv 2007.10442](https://arxiv.org/abs/2007.10442). Treat CFV nets as phase 2, not phase 1.
5. Evaluation stack we need: (a) Local Best Response (LBR) as the exploitability lower bound everyone reports, (b) head-to-head vs Slumbot (the de facto public benchmark used by Modicum, ReBeL, Supremus), (c) AIVAT or at least all-in EV and duplicate dealing for variance reduction.

## 1. Libratus (Brown and Sandholm, Science 2018; NIPS 2017 best paper)

Sources:
- Science paper (author copy): https://noambrown.github.io/papers/17-Science-Superhuman.pdf (Science 359, 418-424, 2018)
- IJCAI 2017 demo paper with compute breakdown: https://www.ijcai.org/proceedings/2017/0772.pdf
- Safe and Nested Subgame Solving (NIPS 2017): https://arxiv.org/abs/1705.02955

### 1.1 Architecture (three modules)

1. Blueprint: an abstraction of HUNL solved offline with MCCFR plus sampled regret-based pruning.
2. Nested safe subgame solving: real-time re-solving from the third betting round (turn) onward, and in response to every opponent bet after that, with no card abstraction in the subgame.
3. Self-improver: overnight, adds the opponents' most-used off-tree preflop/flop bet sizes into the blueprint and solves the new branches.

### 1.2 Blueprint details

- Game: 200 BB stacks ($20,000 with $50/$100 blinds), bets in $1 increments, 10^161 decision points. [Science paper; IJCAI demo](https://www.ijcai.org/proceedings/2017/0772.pdf)
- No card abstraction on preflop and flop. Turn: 55 million hand situations grouped into 2.5 million buckets. River: 2.4 billion situations grouped into 1.25 million buckets. [Science paper](https://noambrown.github.io/papers/17-Science-Superhuman.pdf)
- Abstraction shrinks the game from 10^161 to about 10^12 decision points. [IJCAI demo](https://www.ijcai.org/proceedings/2017/0772.pdf)
- Action abstraction: mostly pot fractions/multiples chosen by looking at what prior ACPC bots used; a few early sizes chosen by a parameter-optimization method (Brown and Sandholm, AAAI 2014 "Regret transfer and parameter optimization"). Asymmetric abstraction, more actions for the opponent than for itself, to reduce translation error (Bard et al. 2014). [Science; IJCAI demo]
- Solver: external-sampling MCCFR with sampled regret-based pruning. Pruning rule (Science note 39): an action whose regret is below a negative threshold C is sampled with probability K / (K + C - R(a)) for a positive constant K, with a floor on the probability; pruning is used only for about the last half of the run, the first half is plain external sampling. Reported speedup from pruning: about 3x. Pruning also reduces the "fighting" between infosets that share an imperfect-recall bucket, since unreachable ones stop updating. [Science paper](https://noambrown.github.io/papers/17-Science-Superhuman.pdf)
- Postprocessing: "eliminating low-probability actions" on rounds 3 and 4 raised blueprint-only play from -8 ± 15 to +18 ± 21 mbb/g vs Baby Tartanian8, but increases exploitability; the competition agent did not use it on rounds 3 and 4. [Science Table 3]

Comparison to our trainer (`/Users/rg/Downloads/gpo-wt/blueprint/blueprint`): ours uses a fixed 95% pruning probability below a threshold after `prune_after` iterations, Pluribus style. Libratus' version is a smooth probability K/(K+C-R) with a floor; both are valid. Ours is imperfect-recall with 50 to a few hundred buckets per street in presets, which is many orders of magnitude smaller than Libratus' 2.5M/1.25M; that is fine if the blueprint is only used up to the flop and for leaf values, which is exactly what Libratus and Modicum do.

### 1.3 Safe and nested subgame solving (the part to implement)

Definitions in my own words (from arXiv 1705.02955):

- Subgame: all game states consistent with the public information (board and betting so far). Every combination of private cards is a root.
- Unsafe solving: assume both players followed the blueprint to reach the subgame, compute each player's range by Bayes on the blueprint, solve the subgame with those fixed ranges. Simple, often strong, no guarantee. Can blow up: in Large flop hold'em with 30,000 buckets the trunk was exploitable for 41.41 mbb/h and Unsafe made it 396.8 mbb/h. [Table 2]
- Resolve (Burch et al. 2014 CFR-D gadget): build an augmented game. Chance deals the opponent (P1) a hand in proportion to our (P2) reach and chance. P1 then picks between "terminate" (gets a fixed alternative payoff equal to its counterfactual best-response value against our blueprint in this subgame) and "enter" (plays the subgame). Solve this game; our new subgame strategy can never be worse for us than the blueprint, for any P1 hand.
- Maxmargin (Moravcik et al. 2016): same alternative payoffs but maximize the smallest margin (alt payoff minus what P1 gets by entering) instead of only keeping margins non-negative.
- Reach-Resolve / Reach-Maxmargin (new in this paper): raise each P1 hand's alternative payoff by the "gift" that P1 already gave away on the path to the subgame, that is, how much worse the action P1 actually took was than its best alternative (they use a lower bound computed only from actions that lead immediately to terminal nodes, for example folding). Hands that only reach here by blundering need less defending, so we can concentrate defense on hands P1 really has. Gifts must not be double-spent across many sibling subgames; the safe split is conservative, scaling gifts up by the chance branching factor (1,755 flops in NLFH) usually helped, but scaling by 100,000 was worse than Maxmargin in one case; the best scaling in that case was about 1,000. [Appendix D]
- Estimate (Section 6): replace the conservative alternative payoff (best response to the blueprint in the full game) with an estimate of what P1 would get against an equilibrium. In practice: P1's counterfactual best-response value computed inside the abstraction, and they simply used the last CFR iterate of P1's blueprint as that best response. Loses the safety guarantee but bounded: exploitability at most exp(sigma*) + 2 Delta where Delta is the max error of the estimates (Theorem 2). Libratus calls this "Estimated-Maxmargin" in Science and states the same 2 Delta bound.
- Distributional (Appendix B.1/C): treat each alternative payoff as a normal random variable that P1 observes; reduces overfitting to bad estimates. They implement it with Hedge at the gadget nodes, eta_t = sqrt(ln|A|) / (3 sqrt(VAR) sqrt(t)), and CFR+ inside the subgame. Std dev heuristic used the gap between blueprint value and true unabstracted best-response value, which we would not have in HUNL; treat as optional.

Exploitability results (mbb/h, measured in the unabstracted game), arXiv 1705.02955:

| Game, buckets | Trunk (no solving) | Unsafe | Resolve | Maxmargin | Reach-Maxmargin | Estimate | Reach-Estimate + Distributional (not split) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Small flop HE, 200 | 88.69 | 14.68 | 60.16 | 30.05 | 29.88 | 11.66 | 9.560 |
| Small flop HE, 2,000 | 37.374 | 3.958 | 17.79 | 13.99 | 13.90 | 6.261 | 4.924 |
| Small flop HE, 30,000 | 9.128 | 0.5514 | 5.407 | 4.343 | 4.147 | 2.423 | 1.733 |
| Large flop HE, 200 | 283.7 | 65.59 | 179.6 | 134.7 | 134.0 | 52.62 | 49.13 |
| Large flop HE, 2,000 | 165.2 | 38.22 | 101.7 | 77.89 | 72.22 | 41.93 | 37.22 |
| Large flop HE, 30,000 | 41.41 | 396.8 | 23.11 | 19.50 | 18.80 | 30.09 | 8.777 |
| Turn HE, 200 | 684.6 | 130.4 | 454.9 | 427.6 | 424.4 | 120.6 | 113.3 |
| Turn HE, 2,000 | 465.1 | 85.95 | 321.5 | 299.6 | 298.3 | 89.43 | 83.24 |
| Turn HE, 20,000 | 345.5 | 79.34 | 251.8 | 234.4 | 233.5 | 76.44 | 70.68 |

Source: Tables 1 to 3 of https://arxiv.org/abs/1705.02955. Takeaway: estimated alternative payoffs matter more than the exact gadget; Unsafe is usually good but has rare catastrophic cases.

Nested solving for off-tree actions (Section 7), Table 4, NLFH with 3 bet sizes, one player's abstraction missing the 0.75 pot size:

| Method | Exploitability (mbb/h) |
| --- | --- |
| Randomized pseudo-harmonic action translation | 1,465 |
| Resolve | 150.2 |
| Reach-Maxmargin (expensive) | 149.2 |
| Unsafe (expensive) | 148.3 |
| Maxmargin | 122.0 |
| Reach-Maxmargin | 119.1 |

- "Inexpensive" nested method: when the opponent makes an off-tree action a, build a subgame rooted after a; alternative payoffs are P1's in-abstraction best-response values at the infoset before a (the best action it could have taken inside the abstraction). Solve, splice into the blueprint, repeat on the next off-tree action.
- "Expensive" method: re-solve from the node before a, including all sibling actions plus a. Needed if you want Unsafe solving (reach probability of an off-tree action is undefined).
- Theorem 1 (Reach-Maxmargin with lower-bound gifts is never worse than past safe methods) assumes perfect recall in the real game, not in the abstraction.

### 1.4 How Libratus actually used it at the table

- Rounds 1 and 2: plays the blueprint, with action translation for off-tree bets (dense abstraction there). [Science]
- First time round 3 (turn) is reached: Unsafe subgame solving once; all later subgames: safe solving. [Science note 45]
- Also starts solving earlier "when no additional bets or raises could be made". [note 44]
- Subgame solver: heavily optimized CFR+ that tracks all P1 hands at once (vector form), no card abstraction, dense action abstraction. [note 46]
- A new subgame is solved every time the opponent bets (in practice). [IJCAI demo]
- Randomized bet sizes: at the first subgame of a hand, all its bet sizes were scaled up or down by a uniform random 0 to 8% for that hand. [note 49]
- Subgame solver ran on 50 Bridges nodes per game. [IJCAI demo]

### 1.5 Self-improver

- Each day of the match, it looked at the opponents' aggregate preflop bet sizes, scored them by frequency and distance to the nearest in-abstraction size, picked k = 3 sizes, solved them overnight (k chosen so 3 holes could typically be fixed in 24 hours), and added those that converged by morning. [Science note 54]
- Two variants: add the new size together with a default sibling size during solving (conservative) or without it (more exploitative; only used when the opponent uses that size most of the time). [Science]
- For us: the cheap version is to run nightly "branch inserts" for the most common off-tree sizes from our logs (including vs Slumbot), solving each inserted branch with the subgame solver plus blueprint leaf values. This also fits the paper narrative.

### 1.6 Compute and results

- Total about 25 million core-hours: about 13M for exploratory experiments and evaluation, about 6M for abstraction plus equilibrium finding, about 3M for nested subgame solving, about 3M for self-improvement. 196 Bridges nodes for equilibrium finding and self-improvement, each node 128 GB RAM and 28 cores of which 14 were used. [IJCAI demo](https://www.ijcai.org/proceedings/2017/0772.pdf)
- vs Baby Tartanian8 (2016 ACPC winner), 95% CI: blueprint -8 ± 15; blueprint with postprocessing +18 ± 21; on-tree nested solving +59 ± 28; full nested solving +63 ± 28 mbb/g. [Science Table 3]
- Simpler-game table (Science Table 1, mbb/game): small two-round HE: none 91.3, unsafe 5.51, safe 22.6; large two-round HE: none 41.3, unsafe 397, safe 9.84; three-round HE: none 346, unsafe 79.3, safe 72.6.
- Nested solving vs translation (Science Table 2): no nested solving 1,465; nested unsafe 148; nested safe 119.
- Brains vs AI, January 2017: 120,000 hands over 20 days, beat four specialists by 147 mbb/game, 99.98% significance, p = 0.0002 (treating hands as i.i.d.), beat each individually. [Science]

## 2. DeepStack (Moravcik et al., Science 2017)

Source: https://arxiv.org/abs/1701.01724 (main paper plus supplement in the arXiv PDF). Open-source: https://github.com/lifrordi/DeepStack-Leduc (Lua/Torch, Leduc only).

### 2.1 Algorithm in my own words

Continual re-solving. The agent never stores a full-game strategy. It keeps two vectors: its own range (1,326 hand probabilities) and an upper-bound vector of opponent counterfactual values (one per opponent hand). Each time it must act:
1. Build a lookahead tree from the current public state: limited actions, limited depth.
2. Solve the augmented game with a CFR-D style gadget: the opponent may "terminate" and take its stored counterfactual value for each hand or "follow" into the tree.
3. At depth-limit leaves (end of the current round on preflop and flop), call a neural net that maps (pot, board, both ranges) to counterfactual value vectors for both players. Ranges change every CFR iteration so the net is queried every iteration.
4. Act by sampling the computed strategy for the actual hand; discard the strategy.
5. Updates: after its own action, replace opponent CFVs with the re-solve's values for the chosen action and Bayes-update its own range. After a chance card, take the CFVs computed for that card and zero impossible hands. After an opponent action, nothing changes. It never tracks the opponent range and never needs to translate an opponent bet, which is why off-tree bets are a non-issue.

Theorem 1: with value-function error below epsilon and T CFR iterations, exploitability is below k1 epsilon + k2 / sqrt(T). The sparse action set voids the guarantee in practice.

### 2.2 Hyperparameters

- Lookahead actions: fold, call, 2 or 3 bets, all-in. Re-solved trees are about 10^7 decision points and solve in under 5 s on one GTX 1080. [main text]
- Per-round settings (supplement Table 4):

| Round | CFR iters | Omitted (warmup) iters | First action | Second action | Remaining | Leaf eval |
| --- | --- | --- | --- | --- | --- | --- |
| Preflop | 1000 | 980 | F, C, 1/2P, P, A | F, C, 1/2P, P, 2P, A | F, C, P, A | Aux / flop net |
| Flop | 1000 | 500 | F, C, 1/2P, P, A | F, C, P, A | F, C, P, A | Turn net |
| Turn | 1000 | 500 | F, C, 1/2P, P, A | F, C, P, A | F, C, P, A | none (solves to end, river bucketed) |
| River | 2000 | 1000 | F, C, 1/2P, P, 2P, A | F, C, 1/2P, P, 2P, A | F, C, P, A | none |

(Column assignment reconstructed from the PDF text extraction; verify against the PDF table before quoting in our paper.)
- Solver: hybrid of vanilla CFR and CFR+: regret-matching+, uniform averaging, simultaneous updates, early iterations omitted from the average.
- Opponent range warm start: mix previous estimate (weight b = 0.9) with uniform. Second to act: conservative mixing; first to act: aggressive forced-follow variant. [supplement]
- Preflop: enumerating all 22,100 flops through the flop net is expensive, so an auxiliary net is used during the omitted iterations and full enumeration only during averaged ones; preflop solutions cached per betting sequence. [supplement]
- Network: 7 fully connected hidden layers of 500 units, PReLU, inputs are pot as a fraction of stacks plus both ranges mapped to 1,000 buckets (k-means with EMD over hand-strength features), outputs bucket CFVs as fractions of pot, then an outer zero-sum correction layer (subtract half the weighted sum of the two players' values). Huber loss, Adam, batch 1,000, lr 0.001 dropped to 0.0001 after 200 epochs, about 350 epochs over two days on one GPU. [supplement]
- Training data generation: random pot from a fixed interval distribution; ranges from a recursive generator R(S, p) that splits hands sorted by hand strength in half and assigns random mass to each half, which covers the range space instead of just equilibrium-looking ranges. Targets from 1,000 CFR+ iterations with only F, C, P, A and no card abstraction. [supplement]
- Turn net: 10M random turn situations, 6,144 CPU cores of Calcul Quebec MP2, over 175 core-years. Flop net: 1M flop situations solved with the depth-limited solver plus the turn net, 20 GPUs, about half a GPU-year. Aux net: 10M situations, targets by averaging the flop net over all 22,100 flops. [supplement]
- Losses (average Huber, fraction of pot): turn 0.016 train / 0.026 validation; flop 0.008 / 0.034; aux 0.000053 / 0.000055. [supplement]

### 2.3 Results

- 44,852 hands vs 33 IFP-recruited pros from 17 countries; won 492 mbb/g overall (486 mbb/g by AIVAT); 394 mbb/g vs the 11 who finished 3,000 hands, beating 10 of 11 individually with significance. These were not HUNL specialists, unlike Libratus' opponents. [arXiv 1701.01724; Libratus Science text]
- Thinking time median per action: preflop 0.04 s (cache), flop 5.9 s, turn 5.4 s, river 2.2 s. [supplement Table 7]
- LBR exploitability lower bounds (mbb/g, from supplement Table 3; four LBR settings: (1) F,C on all rounds; (2) C, C, then F,C,P,A on turn and river; (3) C, C, then 56 bet sizes on turn and river; (4) C, 56 bets on flop, then F,C on turn and river):

| Bot | Setting 1 | Setting 2 | Setting 3 | Setting 4 |
| --- | --- | --- | --- | --- |
| Hyperborean (2014) | 721 ± 56 | 3852 ± 141 | 4675 ± 152 | 983 ± 95 |
| Slumbot (2016) | 522 ± 50 | 4020 ± 115 | 3763 ± 104 | 1227 ± 79 |
| Act1 (2016) | 407 ± 47 | 2597 ± 140 | 3302 ± 122 | 847 ± 78 |
| Always Fold | 250 ± 0 | 750 ± 0 | 750 ± 0 | 750 ± 0 |
| Full Cards [100 BB] | -424 ± 37 | -536 ± 87 | 2403 ± 87 | 1008 ± 68 |
| DeepStack | -428 ± 87 | -383 ± 219 | -775 ± 255 | -602 ± 214 |

Mapping of settings to columns is my reconstruction of the PDF text; verify before quoting. Positive means LBR wins. "Full Cards" is a no-card-abstraction 100 BB strategy that took almost 2 TB of memory and about 14 CPU-years, yet LBR beats it by over 2,400 mbb/g once bet sizes outside its abstraction are used. [supplement]

### 2.4 Independent replications

- Supremus (Zarick, Pellegrini, Albert, Rowland, 2020): DeepStack reimplementation lost to Slumbot by 63 ± 40 mbb/g over 150,000 hands (± is one standard error, all-ins scored by EV), while winning 536 ± 68 vs LBR. Supremus fixes: river network too, data 50M river / 20M turn / 5M flop / 10M aux subgames, each solved with 4,000 DCFR+ iterations per player, finer action sets, all-CUDA solver (1,000 flop iterations in 0.8 s, over 6x faster than DeepStack), DCFR+ = DCFR with average weight max(0, t - d), d = 100, and simultaneous updates when CFV nets are at the leaves. Result: beat Slumbot by 176 ± 44 mbb/g over 150,000 hands. Validation Huber losses: river 0.015, turn 0.010, flop 0.011. Total compute for Supremus: unverified (not stated in the parts I read). [arXiv 2007.10442](https://arxiv.org/abs/2007.10442)
- DeepHoldem (open-source NLHE port of DeepStack-Leduc, Lua/Torch): reports 42 bb/100 vs Slumbot 2017 over 2,616 hands, which is far too few hands to mean anything; nets trained on 1M samples; tested on Tesla P100. [GitHub happypepper/DeepHoldem](https://github.com/happypepper/DeepHoldem)

## 3. Cepheus and CFR+ (Bowling et al., Science 2015; Tammelin et al., IJCAI 2015)

Sources: https://webdocs.cs.ualberta.ca/~bowling/papers/15science.pdf ; https://poker.cs.ualberta.ca/publications/2015-ijcai-cfrplus.pdf ; https://arxiv.org/abs/1407.5042

- Game: heads-up limit hold'em, 3.19 x 10^14 information sets, 1.38 x 10^13 after symmetries. Storing regrets plus strategy as 4-byte floats would need 262 TB. [Science 2015]
- CFR+ = four changes to CFR: (1) linear weighted average strategy, weight t (normalized by 2/(T^2+T)); (2) no sampling, full tree passes; (3) alternating updates; (4) regret-matching+, which clamps cumulative regret at zero after every update so a newly good action is played immediately. The current iterate of CFR+ was empirically near-equilibrium, so Cepheus skipped storing the average. [IJCAI 2015; Science 2015]
- Engineering: values stored as fixed-point integers (scale then truncate), sorted by board and hand to make neighbours similar, then compressed; compression ratios about 13:1 on regrets and 28:1 on strategy; under 11 TB for regrets and 6 TB for strategy, on local disks; disk overhead about 5% with precaching. Tree partitioned into 110,565 subgames by public actions and cards, split across 199 workers plus one parent. [Science 2015]
- Compute: 200 nodes, each 24 x 2.1 GHz AMD cores, 32 GB RAM, 1 TB disk; 61 min per iteration; 1,579 iterations, 68.5 days, 900 core-years, 10.9 TB disk. Final exploitability 0.986 mbb/g; game value for the dealer bounded between 87.7 and 89.7 mbb/g. Note 43: the 900 core-years includes computing an average strategy that was later discarded. [Science 2015]
- The 1 mbb/g "essentially solved" threshold comes from: with per-game std dev of about 5 bb/g, a human playing 200 games/h, 12 h/day, 365 days, 70 years could not distinguish it at 95% confidence. [Science 2015]

What we take from it: regret-matching+ plus linear averaging plus alternating updates is the default for any full-width (vector) subgame solver. Fixed-point regret storage is already in our trainer (int32). Distributed disk-backed CFR+ is not something we need at our budget.

## 4. Slumbot (Eric Jackson)

Sources: AAAI 2013 workshop paper https://cdn.aaai.org/ocs/ws/ws0979/7044-30516-1-PB.pdf ; code (MIT) https://github.com/ericgjackson/slumbot2017 and https://github.com/ericgjackson/slumbot2019 ; site https://www.slumbot.com/

### 4.1 Slumbot NL (2013 design)

- Distributed, disk-based CFR on commodity hardware. Tree split by preflop betting sequence (835 sequences) and 8 public-card partitions on the river, so 6,680 river tasks over 9 machines plus one central preflop task; task-to-machine assignment is fixed so data stays on local disk. Only opponent reach probabilities and flop-root CFVs cross the network.
- Sampling: a variant of Public Chance Sampling that samples many boards per iteration (1/50,000 of five-card boards, about 50 boards per iteration), with full-width private hands and O(n) showdown evaluation. Rule of thumb: sample enough boards that almost every bucket gets a regret update every iteration. Boards are drawn from a random permutation ("cycle") rather than with replacement, a quasi-Monte-Carlo trick to avoid short-run bias.
- Imperfect recall handled by aggregating card-level CFVs into bucket-level values at every street transition.
- Abstraction: 5.7 billion infosets, 14.5 billion infoset-action pairs, about 6 million betting sequences. Buckets: 169 preflop, 3,904 flop, 3,602 turn, 2,173 river (imperfect recall). Card abstraction is hierarchical: public board clusters first, then hand clusters within each; features are board "high-cardness" for boards and hand strength plus potential for hands, k-means.
- Bet sizes as pot fractions. Opening bet: 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8, 15, 25, 50. Raise: 0.5, 1, 2, 4, 8, 15, 25, 50. 3-bet: 0.5, 1, 2. 4-bet and later: pot only. All-in always allowed. Symmetric abstraction. Off-tree bets mapped with Ganzfried's pseudo-harmonic mapping.
- Design lesson stated by the author: spend capacity on betting abstraction over card abstraction, since a decent card abstraction needs relatively few buckets but bet-size understanding matters a lot.

### 4.2 Later Slumbot, compute, benchmark role

- The Slumbot played by Modicum used about 250,000 core-hours and 2 TB RAM; Baby Tartanian8 used about 2 million core-hours and 18 TB RAM. [arXiv 1805.08195](https://arxiv.org/abs/1805.08195)
- Slumbot won the 2018 ACPC. [arXiv 1805.08195; arXiv 2007.10442]
- Baby Tartanian8 beat Slumbot by 36 ± 12 mbb/g. [arXiv 1805.08195]
- slumbot2019 repo (MIT, C++17): CFR+ for small games, MCCFR including external sampling and "Targeted CFR", configurable card and betting abstractions, endgame re-solving and merging, head-to-head and real-game best response tools. [GitHub](https://github.com/ericgjackson/slumbot2019)
- Public play: slumbot.com hosts the bot and an HTTP API that other papers used for 150,000-hand matches (Supremus) and benchmarking (ReBeL, Modicum). The exact API request format is unverified here; a probe of `https://slumbot.com/api/new_hand` on 2026-10-09 returned HTTP 200, but I did not check what the payload looks like. Inspect the site before building a client.
- LBR vs Slumbot 2016: from 522 ± 50 up to 4020 ± 115 mbb/g depending on LBR settings (DeepStack supplement Table 3), so it is a strong but very exploitable static lookup-table bot.

## 5. Modicum: the bridge from these systems to our budget

Source: Brown, Sandholm, Amos, "Depth-Limited Solving for Imperfect-Information Games", NeurIPS 2018, https://arxiv.org/abs/1805.08195

- Key idea: at a depth limit, let the opponent choose among k continuation strategies (each a different policy for the rest of the game) instead of assuming one value per state. That stops the solver from being exploited at the leaf.
- Blueprint: 169 preflop classes, 30,000 buckets on later streets, MCCFR for 700 core-hours, strategy about 5 GB as 4-byte floats, 16 GB RAM total.
- Round 1 leaves: 10 values per state from the "self-generative" approach, stored in a 240 MB table. Round 2 leaves: 4 opponent continuation policies built by biasing the blueprint (as is; fold probabilities x10; toward check/call; toward bet/raise), evaluated by 3 rollouts per leaf in the blueprint. A DNN variant (34 input features, 2 hidden layers of 64, 4 outputs, 180M examples per player, Huber loss 0.03) was slightly worse (lost to Baby Tartanian8 by 11 ± 10).
- Real-time: nested unsafe solving on rounds 1 and 2 and the first round-3 subgame, then Reach safe solving with alternative payoffs from the previous solve. Rounds 3 and 4 solved to the end with modified CFR+ (first 50% of iterations dropped from the average; regrets discounted by sqrt(T)/(sqrt(T)+1) for the first 30 iterations, about 3x lower exploitability). Budgets: preflop MCCFR 30 s (cached), flop MCCFR 10 to 30 s, turn 150 to 1,000 CFR+ iterations, river 300 to 2,000.
- Preflop off-tree actions: add the new size to the preflop abstraction, re-solve the whole preflop, cache.
- Results (Table 1, mbb/g, 95% CI, AIVAT): vs Baby Tartanian8: blueprint -57 ± 13, naive depth-limited -10 ± 8, depth-limited +6 ± 5. vs Slumbot: blueprint -11 ± 8, naive -1 ± 15, depth-limited +11 ± 9. Average 20 s per hand on a 4-core CPU.
- Relevance to our TS engine: `/Users/rg/Downloads/gto-poker-overlay/src/core/solver/postflop-cfr.ts` values matched leaves by all-in equity of the surviving ranges. That is weaker than even Modicum's "naive" single-value leaf (it ignores future betting entirely), and Modicum's own table shows the naive leaf losing to Baby Tartanian8 by 10 ± 8. Replacing that leaf with blueprint-derived multi-valued leaves is a direct, measured improvement.

## 6. Action translation (needed as a fallback)

- Pseudo-harmonic mapping (Ganzfried and Sandholm, IJCAI 2013; https://cdn.aaai.org/ocs/ws/ws1109/7185-30512-1-PB.pdf): with in-abstraction bets A < x < B expressed as fractions of the pot, map x to A with probability f(x) = ((B - x)(1 + A)) / ((B - A)(1 + x)), else to B. Use randomized for play.
- Measured cost: 1,465 mbb/h exploitability vs about 119 to 150 for nested solving in the NIPS 2017 experiment (Table 4 above).
- For our bot: keep it only where real-time solving is too slow (for example preflop before the cache is warm), and for the blueprint's own self-play evaluation.

## 7. What we would need to implement, in order

Phase A (laptop, no rented compute, highest value per hour of work):
1. Vectorized public-tree CFR solver in C++ (new module next to the trainer). Ranges as 1,326-wide float vectors, card-removal-aware O(n log n) or O(n) showdown evaluation via sorting hands by strength (the Johanson et al. 2011 trick that Slumbot and Libratus use), fold nodes via inclusion-exclusion over blocked cards. Update rule: CFR+ (RM+, linear averaging, alternating) or DCFR(1.5, 0, 2); measure which converges faster on our river trees. Verify exactness against our existing Kuhn/Leduc `ExactEval`, then against a brute-force river solver.
2. Gadget layer: Unsafe, Resolve, Reach-Resolve, with alternative payoffs from (a) the blueprint's CBV, (b) "Estimate" via a CBR inside the abstraction, as in the paper using the last iterate. Unit test on the Coin Toss example from the paper (the paper gives the exact numbers: Maxmargin gives Heads 5/8, Tails 3/8; the better Reach answer is Heads 3/4, Tails 1/4).
3. Range tracking during play: our range by Bayes on our own strategy; opponent range from the blueprint for unsafe solving; CFV upper bounds from the last solve for safe solving (DeepStack update rules in 2.1).
4. Nested solving trigger: re-solve after every opponent bet from the turn onward; "inexpensive" method after off-tree bets; randomize our own subgame bet sizes per hand (Libratus used 0 to 8%).
5. Depth-limited leaves for flop solving: Modicum's k = 4 biased continuation policies with rollouts in our blueprint. This avoids training any network.
6. Evaluation: LBR in C++ using the vector solver's showdown code (settings matching DeepStack Table 3 so our numbers are comparable); duplicate h2h already exists in `bp h2h`; add all-in EV scoring and ideally AIVAT.

Phase B (rented CPU, within budget):
7. Larger blueprint (Modicum scale was 700 core-hours and 30,000 buckets per postflop street). Our trainer's pruning and LCFR already match the Pluribus recipe.
8. Self-improver: nightly branch insertion for the most frequent off-tree sizes from our logs.
9. 10,000s to 100,000s of hands vs Slumbot through its API (respecting the site's limits), AIVAT or all-in EV, report mbb/g with CIs like Modicum/ReBeL/Supremus.

Phase C (optional, GPU):
10. DeepStack/Supremus-style CFV nets. River net first, then turn, flop, preflop aux, each trained on subgames solved with the Phase A solver. Budget warning: DeepStack's turn data took over 175 core-years (about 1.53 million core-hours by arithmetic: 175 x 8,760). A GPU solver (Supremus) cuts that a lot, but Supremus' total cost is unverified. Only start this after Phase A shows the solver is fast.

## 8. Pitfalls collected from the sources

- Unsafe solving can be catastrophic in some games (41.41 to 396.8 mbb/h in Large NLFH). Use it at most once per hand at the first solve, as Libratus and Modicum did, and safe solving afterwards.
- Gifts scaled too aggressively can make Reach worse than Maxmargin (Appendix D).
- Safe gadgets with conservative (upper-bound) alternative payoffs are overly passive; use estimates. Maxmargin with estimates did worse than Resolve with estimates in practice.
- Imperfect-recall buckets "fight" over one strategy; pruning reduces this (Libratus).
- Postprocessing (dropping low-probability actions) raises h2h win rate vs static bots but raises exploitability; keep it out of the safe-solving layers.
- Strategy-only h2h can be misleading: Act1 and Slumbot were within 20 mbb/g of each other h2h but differed by about 1,300 mbb/g under LBR. [DeepStack supplement]
- Small samples: HUNL variance is huge. DeepHoldem's 2,616-hand result is noise; Supremus and the DeepStack reimplementation used 150,000 hands; Libratus used 120,000.
- Value-net replication risk: a faithful DeepStack copy lost to Slumbot. Errors at flop leaves matter most (LBR's flop-targeting setting).
- When CFV nets are at the leaves, Supremus found simultaneous updates converged faster than alternating, the opposite of the tabular case.

## 9. Usage note

Evaluate against Slumbot, LBR, self-play and consenting human testers. The existing TS project has an auto-play content script for PokerNow; running a solver-backed bot against people who do not know they face a bot is a fairness and terms-of-service problem, and a research paper should report only consented or bot-vs-bot results.

## 10. Link list

- Libratus Science (author PDF): https://noambrown.github.io/papers/17-Science-Superhuman.pdf
- Libratus IJCAI 2017 demo: https://www.ijcai.org/proceedings/2017/0772.pdf
- Safe and Nested Subgame Solving: https://arxiv.org/abs/1705.02955
- DeepStack: https://arxiv.org/abs/1701.01724
- DeepStack-Leduc code: https://github.com/lifrordi/DeepStack-Leduc
- DeepHoldem: https://github.com/happypepper/DeepHoldem
- Supremus: https://arxiv.org/abs/2007.10442
- Depth-limited solving (Modicum): https://arxiv.org/abs/1805.08195
- ReBeL (benchmark table incl. Slumbot and LBR): https://arxiv.org/abs/2007.13544
- LBR (Lisy and Bowling): https://arxiv.org/abs/1612.07547
- Cepheus Science 2015: https://webdocs.cs.ualberta.ca/~bowling/papers/15science.pdf
- CFR+ IJCAI 2015: https://poker.cs.ualberta.ca/publications/2015-ijcai-cfrplus.pdf
- CFR+ arXiv: https://arxiv.org/abs/1407.5042
- Slumbot NL (AAAI 2013 WS): https://cdn.aaai.org/ocs/ws/ws0979/7044-30516-1-PB.pdf
- Pseudo-harmonic mapping: https://cdn.aaai.org/ocs/ws/ws1109/7185-30512-1-PB.pdf
- slumbot2017 / slumbot2019 code (MIT): https://github.com/ericgjackson/slumbot2017 , https://github.com/ericgjackson/slumbot2019
