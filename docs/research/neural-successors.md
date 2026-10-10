# Neural successors to Pluribus: what beats it, what simplifies it, and what fits a $500-1000 budget

Topic key: `neural-successors`. Compiled 2026-10-09. Every number below has a source link next to it. Where a paper does not report a figure, the note says "unverified" or "not reported". Dollar figures marked "arithmetic" are my multiplication of a sourced quantity by a sourced price; they are estimates, not reported costs.

## 1. Bottom line

The best strength per dollar for this project is a Pluribus/Modicum-style system: the existing C++ MCCFR blueprint plus depth-limited real-time search with a small set of continuation strategies at the leaves. Then, if budget remains, add a DeepStack/Supremus-style river (and later turn) counterfactual value network trained on CPU-solved subgames. ReBeL and Student of Games are stronger on paper, but their published training runs used hundreds of GPUs or TPU fleets, and the one public small-budget ReBeL replication only reached +18 ± 16 mbb/hand against Slumbot, which is no better than Modicum's laptop-scale result. AlphaHoldem-style end-to-end PPO is the cheapest neural agent with a big Slumbot number (+111.56), but it has no search, no equilibrium guarantee, and its full training run costs about the whole budget. Deep CFR, SD-CFR, DREAM and ESCHER have no published heads-up no-limit results against Slumbot at all. LLM agents are an order of magnitude weaker and cost cents per hand.

Key reasons:

1. Modicum beat Slumbot (+11 ± 9 mbb/g, 95% CI) and BabyTartanian8 (+6 ± 5) with a blueprint computed in 700 core hours and play on a 4-core CPU with 16 GB RAM ([Brown, Sandholm, Amos 2018, arXiv 1805.08195](https://arxiv.org/abs/1805.08195), Table 1 and Section 6). The same blueprint without search lost to Slumbot by 11 ± 8. Search is the single largest lever.
2. Pluribus's 6-max blueprint took 12,400 core hours (8 days on a 64-core server, under 512 GB RAM), which the authors priced at about $144 at 2019 spot rates ([Brown & Sandholm, Science 2019](https://www.science.org/doi/10.1126/science.aay2400)). Our budget covers several blueprint runs of that size.
3. Neural successors (ReBeL, Student of Games) only have theory and results for two-player zero-sum games. For 6-max, the Pluribus recipe is still the only one with a published superhuman result.

## 2. Benchmarks and how to read them

Slumbot is the common yardstick. It won the 2018 ACPC, is an abstraction-based precomputed strategy, and used about 250,000 core hours and 2 TB of RAM to compute ([Modicum paper, arXiv 1805.08195](https://arxiv.org/abs/1805.08195), Section 6). It is public through an API at slumbot.com, which Eric Jackson opened in 2021 ([GTO Wizard Benchmark, arXiv 2603.23660](https://arxiv.org/abs/2603.23660), Section 2). Format: 200 big blind stacks, 50/100 blinds, stacks reset every hand (same paper, Section 3; also [RL-CFR, arXiv 2403.04344](https://arxiv.org/abs/2403.04344) Section 5).

Caveats that matter for the paper:

- Slumbot is exploitable. A local best response (LBR) beats it by 522 ± 50 mbb/h (Student of Games Table 2, citing Lisý & Bowling, [arXiv 2112.03178](https://arxiv.org/abs/2112.03178)). A simple rule-based bot in OpenHoldem beat Slumbot by 57 mbb/h over 100,000 AIVAT-evaluated hands ([OpenHoldem, arXiv 2012.06168](https://arxiv.org/abs/2012.06168), Table II). Beating Slumbot is necessary but far from sufficient for a "Pluribus-level" claim.
- The ± conventions differ across papers: ReBeL's table says one standard deviation, Student of Games says one standard error in the table but 95% CI in the text, Modicum and AlphaHoldem use 95% CI. Normalize before putting numbers in one table.
- GTO Wizard Benchmark (March 2026) is a second public opponent: a REST API against GTO Wizard AI with AIVAT built in, ACPC rules, 200 bb stacks. API keys are granted on request through benchmark.gtowizard.com, and the API only lets you play hands ([arXiv 2603.23660](https://arxiv.org/abs/2603.23660); [client repo README](https://github.com/gtowizard-ai/researcher-api-client)). GTO Wizard AI is the former Ruse AI, which beat Slumbot by 19.4 ± 4.1 bb/100 (194 mbb/hand) over 150,000 hands in 2022 (same paper, Section 3). The paper says AIVAT gives about a threefold reduction in standard deviation, equivalent to 10x fewer hands.
- LBR is the cheap exploitability proxy everyone reports. Implement it; it costs nothing but CPU.

### Master table: results against Slumbot and other references

| Agent (year) | vs Slumbot (mbb/hand) | Other results | Training compute | Source |
| --- | --- | --- | --- | --- |
| Pluribus (2019, 6-max) | not reported | beat pros in 6-max, see Science paper | 12,400 core h blueprint, ~$144 (2019 spot) | [Science](https://www.science.org/doi/10.1126/science.aay2400) |
| Modicum (2018) | +11 ± 9 (95% CI) | +6 ± 5 vs BabyTartanian8 | 700 core h, 16 GB RAM, 4-core CPU at play time | [arXiv 1805.08195](https://arxiv.org/abs/1805.08195) |
| BabyTartanian8 vs Slumbot | +36 ± 12 | ACPC 2016 winner | ~2M core h, 18 TB RAM | [arXiv 1805.08195](https://arxiv.org/abs/1805.08195) |
| DecisionHoldem (2022) | ">730" over ~20,000 hands, no CI given | ">700" vs OpenStack over ~2,000 hands | ~4,000 core h blueprint (48 cores, 3-4 days, ~200M iterations) | [arXiv 2201.11580](https://arxiv.org/abs/2201.11580) |
| ReBeL (2020) | +45 ± 5 | +9 ± 4 vs BabyTartanian8; Dong Kim lost 165 ± 69 (7,500 hands); LBR loses 881 ± 94 | 90 DGX-1 (8x V100 32GB each) for data generation, 1,750 epochs; wall clock not reported | [arXiv 2007.13544](https://arxiv.org/abs/2007.13544), Sec. 7-8, App. E |
| ReBeL replication (in RL-CFR, 2024) | +18 ± 16 | | one server, 8 GPUs + 80-core CPU; 60M PBS samples; wall clock not reported | [arXiv 2403.04344](https://arxiv.org/abs/2403.04344) |
| RL-CFR (ICML 2024) | +84 ± 17 (250k+ hands, AIVAT) | +64 ± 11 vs ReBeL replication (600k hands) | same 8-GPU server | [arXiv 2403.04344](https://arxiv.org/abs/2403.04344) |
| Student of Games (2023) | +7 ± 3 (3.1M hands, AIVAT) | LBR loses 434 ± 9 | 1.1M training steps; poker TPU count unverified (chess/Go used "similar" TPU resources to an AlphaZero run with 3,500 TPUv4 actors) | [arXiv 2112.03178](https://arxiv.org/abs/2112.03178) |
| Supremus (2020) | +176 ± 44 (150k hands) | LBR loses 951 ± 96 | value nets trained on 50M river, 20M turn, 5M flop, 10M preflop-aux subgames; GPU hours not reported | [arXiv 2007.10442](https://arxiv.org/abs/2007.10442) |
| DeepStack reimplementation (in Supremus paper) | -63 ± 40 | LBR loses 536 ± 68 | | [arXiv 2007.10442](https://arxiv.org/abs/2007.10442) |
| AlphaHoldem (AAAI 2022) | +111.56 ± 16.06 (100k hands, 95% CI) | +16.91 ± 22.34 vs OpenStack; +10.27 ± 65.13 vs 4 pros (10k hands, not significant) | 3 days on 1 server (8 TITAN V, 64 cores); Table 1: 4x10^3 CPU h + 580 GPU h | [AAAI paper](https://ojs.aaai.org/index.php/AAAI/article/view/20394) |
| OpenStack (DeepStack replica, 2020) | +103.08 (100k hands) | | 3 weeks on 120 GPUs for value-net data | [AlphaHoldem paper](https://ojs.aaai.org/index.php/AAAI/article/view/20394); [OpenHoldem](https://arxiv.org/abs/2012.06168) |
| GTO Wizard AI / Ruse (2022) | +194 ± 41 (150k hands) | public benchmark opponent | "hundreds of millions of hands" of self-play; compute not reported | [arXiv 2603.23660](https://arxiv.org/abs/2603.23660) |
| SpinGPT (Llama-3.1-8B, 2025) | +134 ± 129 (13.4 ± 12.9 bb/100, 30k hands, 95% CI) | 78% tolerant action match with solver | ~10 A100 h SFT + 10 A100 h RL | [arXiv 2509.22387](https://arxiv.org/abs/2509.22387) |
| PokerSkill + GPT-5.5 XHigh (2026) | not measured directly | -57 ± 21 vs GTO Wizard (Slumbot itself is -194 ± 41 vs GTO Wizard) | no training; ~$0.30/hand inference | [arXiv 2605.30094](https://arxiv.org/abs/2605.30094) |
| Best zero-shot LLM (GPT-5.3 XHigh, 2026) | not measured | -16 ± 3 bb/100 vs GTO Wizard | no training | [arXiv 2603.23660](https://arxiv.org/abs/2603.23660) |

Reference points for humans: Libratus beat BabyTartanian8 by 63 ± 14 and top humans by 147 ± 39 (ReBeL Table 1, [arXiv 2007.13544](https://arxiv.org/abs/2007.13544)). Libratus training cost is given as over 3x10^6 CPU hours in AlphaHoldem Table 1 and as over 15 million core hours in PokerSkill; the two sources disagree, so quote both or neither. DeepStack: 1.53x10^6 CPU hours and 1.31x10^4 GPU hours (AlphaHoldem Table 1).

## 3. Method by method

### 3.1 ReBeL (Brown, Bakhtin, Lerer, Gong; NeurIPS 2020)

Source: [arXiv 2007.13544](https://arxiv.org/abs/2007.13544). Code: poker code was not released; only Liar's Dice is open ([facebookresearch/rebel](https://github.com/facebookresearch/rebel), Apache-2.0, archived).

Idea. Convert the imperfect-information game into a continuous-state perfect-information game whose states are public belief states (PBS): the public history plus, for each player, a probability distribution over their private hands (1,326 combos in hold'em). Then run AlphaZero-style self-play: at each PBS, build a depth-limited subgame, solve it with CFR-D using a value network at the leaves, record the root PBS value as a training target, sample a leaf, and continue.

Key details, in my words:

- Subgames always end at the end of the current betting round (never the whole game), so the single value network must learn six "layers" of values. DeepStack needed three, with separate networks (App. D).
- CFR in subgames is alternating-update Linear CFR. The leaf PBS fed to the value net is the one reached by the policy on a randomly sampled CFR iteration, not the average policy; that is what makes the self-play sound. At test time the agent also stops on a random iteration, sampled with probability proportional to t (Algorithm in App. B, Theorem 3).
- Exploration: one agent takes a random action with probability 0.25 during self-play (App. D/E).
- Network: MLP, 6 hidden layers of width 1,536, GeLU, LayerNorm, card embeddings for the board; input = agent index + acting agent + pot + 5 board cards + 2 x 1,326 beliefs. Value loss is pointwise Huber; policy loss MSE over probabilities. A policy net warm-starts CFR (App. E).
- Training: replay buffer of 12M, uniform sampling; Adam, lr 3e-4 halved every 800 epochs; epoch = 2,560,000 examples; batch 1,024; reported after 1,750 epochs (about 4.5 billion examples, my arithmetic). Data generation on 90 DGX-1 machines with 8x V100 32GB each; training on one machine (App. E). Section 7 says "up to 128 machines with 8 GPUs each".
- Action abstraction: at most 8-9 bet sizes, hand-picked, perturbed by ±0.1 pot during training; stacks randomized between $5,000 and $50,000 during training (App. C/D). Off-tree actions are added to the subgame at test time.
- No card abstraction at all, and no precomputed all-in equity tables.
- Turn endgame hold'em (TEH): ReBeL reached exploitability equal to about 125 iterations of full-game tabular CFR; a value net trained on uniformly random PBSs "fails to learn anything valuable" (Section 8, Fig. 2). That last point is a pitfall: self-play distribution matters.

Results: +45 ± 5 vs Slumbot, +9 ± 4 vs BabyTartanian8, Dong Kim lost 165 ± 69 (one standard error) over 7,500 hands; LBR loses 881 ± 94 (Table 1, App. E.1).

Budget verdict. Not realistic to reproduce at full scale. 720 V100s for data generation; wall clock is not reported, but at Lambda's on-demand A100 40GB price of $1.99 per GPU hour ([lambda.ai/pricing](https://lambda.ai/pricing), read 2026-10-09) even one day of 720 GPUs would be about $34,000 (arithmetic, using A100 price as a stand-in since V100 is not listed). The RL-CFR authors' replication on a single 8-GPU server with 60M PBS samples only reached +18 ± 16 vs Slumbot ([arXiv 2403.04344](https://arxiv.org/abs/2403.04344), Table 1 and App. E), and they attribute the gap to fewer training samples.

What to borrow cheaply: the PBS-value-net formulation restricted to the river (or turn plus river) is small enough to train on a few GPUs, and the "sample a random CFR iteration for the leaf" trick is required for soundness if we ever do self-play value learning.

### 3.2 Student of Games / Player of Games (Schmid et al., Science Advances 2023)

Source: [arXiv 2112.03178](https://arxiv.org/abs/2112.03178) (v1 titled "Player of Games", Dec 2021; v2 Nov 2023; published as Sci. Adv. 9, eadg3256).

Idea. One algorithm for perfect and imperfect information games: growing-tree CFR (GT-CFR) search over public trees, expanding the tree with PUCT-like selection between CFR regret-update phases; a counterfactual value-and-policy network (CVPN); sound self-play that trains the CVPN on search results and on queries from inside the search. Re-solving uses DeepStack-style continual re-solving with a gadget game. Parameterized SoG(s, c): s total expansion simulations, c expansions per regret-update phase.

Poker setup: betting abstraction cut to fold, check/call, and one bet size drawn uniformly from 0.5 to 1.0 pot at the start of each hand; stacks randomized per round during training ("Poker Betting Abstraction" section). Trained up to 1.1M steps, evaluated as SoG(10, 0.01).

Results: +7 ± 3 mbb/hand vs Slumbot over 3.1M hands with AIVAT; LBR loses 434 ± 9 (Table 2). This is the weakest Slumbot margin among the search agents in the table, likely because of the very coarse single-bet-size abstraction (my reading; the paper does not attribute it).

Compute: the paper states chess/Go SoG used "a similar amount of TPU resources" as an AlphaZero run with 3,500 concurrent actors each on a single TPUv4 for 800k steps. Poker-specific TPU count and wall clock: unverified. Implemented in TensorFlow; code not released as far as I found.

Budget verdict: not realistic, and not worth it. Its poker result is weaker than ReBeL and Modicum. The appendix's RL baselines are a useful citation: A2C in Leduc converges to 78 mbb/h exploitability, DQN about 900 mbb/h, independent IS-MCTS no better than 465 mbb/h. This supports "search plus game theory beats plain RL" in our paper.

### 3.3 DeepStack-style value networks and Supremus (Zarick et al., 2020)

Source: [arXiv 2007.10442](https://arxiv.org/abs/2007.10442).

Not post-Pluribus in spirit (DeepStack is 2017), but Supremus is the strongest published academic HUNL bot against Slumbot (+176 ± 44 over 150,000 hands) and is the most directly implementable neural add-on for us.

Changes over DeepStack, in my words:

- DCFR+: Discounted CFR, but the average policy weights iteration t by max(0, t - d) with d = 100, linear rather than quadratic. Still O(1/sqrt(T)).
- With value nets at the leaves, simultaneous updates of both players converged faster than alternating updates (the opposite of the tabular result).
- All lookahead runs in custom CUDA on the GPU; 1,000 flop iterations in 0.8 s, over 6x faster than DeepStack; 3 mbb/g exploitability "over 5,000x faster on the same hardware".
- More data: river net 50M random subgames, turn 20M, flop 5M, preflop auxiliary 10M; each subgame solved with 4,000 DCFR+ iterations per player. DeepStack used 10M turn, 1M flop, 10M aux and no river net. Nets are trained bottom-up (river first; turn data uses the river net at its leaves).
- Wider action abstraction (first action: F, C, 0.33, 0.5, 0.75, 1.0, 1.25, 2.0 pot, A).

The DeepStack reimplementation lost to Slumbot by 63 ± 40; OpenHoldem's DeepStack-like agent trained with 3M flop samples beat Slumbot by 103 mbb/h while one with fewer samples lost 222, and 500 vs 1,000 re-solving iterations swung the result from -224 to +93 ([arXiv 2012.06168](https://arxiv.org/abs/2012.06168), Figs. 8-9). Data size and re-solve iterations dominate.

Compute: GPU hours not reported (unverified). The cost is in generating solved subgames. River subgames are cheap to solve on CPU (no chance nodes after the river), so the river net is the cheapest piece and the one that most shortens our search.

Budget verdict: a river value net is realistic. Full DeepStack-style flop/turn nets are borderline: the data generation for 20M turn subgames is where cost goes, and that cost must be measured on our own solver before committing. Do a timed pilot (for example 10,000 turn subgames) and extrapolate.

### 3.4 AlphaHoldem (Zhao et al., AAAI 2022)

Source: [AAAI 2022 paper](https://ojs.aaai.org/index.php/AAAI/article/view/20394).

Idea: no CFR, no search, no card abstraction. One forward pass of a network picks the action. Cards go in as a 6-channel 4x13 tensor; betting history as a 24-channel 4 x n_b tensor; a pseudo-siamese ConvNet processes cards and actions separately. Trained by PPO with "Trinal-Clip" loss: an extra clip δ1 = 3 on the policy ratio when the advantage is negative, and clipping the value target between -δ2 and δ3 set from chips in play. GAE λ = 0.95, γ = 0.999, Adam lr 3e-4. Self-play is "K-Best": the main agent trains against a pool of the best historical versions selected by ELO.

Scale: 8.6M parameters; 50,000 iterations of 8 MPI workers x 128 envs x 128 steps; 6.5 billion samples, about 2.7 billion hands; minibatch 2,048 per GPU, 16,384 total; one server with 8 TITAN V GPUs and a 64-core CPU for three days. Table 1 lists the GPU version at 4x10^3 CPU hours and 580 GPU hours. Inference 2.9 ms per decision on one GPU.

Results: +111.56 ± 16.06 vs Slumbot (100k hands, 95% CI), +16.91 ± 22.34 vs OpenStack (not significant at 95%), +10.27 ± 65.13 vs four pros over 10,000 hands (not significant). The OpenHoldem paper reports LBR loses to the same RL agent by 335.82 mbb/h over 40,000 hands ([arXiv 2012.06168](https://arxiv.org/abs/2012.06168)).

Code: not officially released as far as I found. [bupticybee/AlphaNLHoldem](https://github.com/bupticybee/AlphaNLHoldem) (AGPL-3.0) is an unofficial reproduction on RLCard's 50 bb environment, not ACPC 200 bb; its README says default training needs 1 GPU and 89 CPU workers, with a released agent trained "about a week".

Budget verdict: feasible but it eats the budget. 580 GPU hours at $1.99 is about $1,150 (arithmetic; a newer GPU than TITAN V would need fewer hours, unverified). Weaknesses for a "Pluribus-level" paper: no exploitability guarantee, no adaptation to off-tree bet sizes beyond what the network learned, and vs-human result not significant. Useful as a cheap ablation baseline or as a fast "fallback policy" for the search agent, not as the main architecture.

### 3.5 Deep CFR (Brown, Lerer, Gross, Sandholm; ICML 2019)

Source: [arXiv 1811.00164](https://arxiv.org/abs/1811.00164). Implementation: [EricSteinberger/Deep-CFR](https://github.com/EricSteinberger/Deep-CFR) (MIT), [PokerRL](https://github.com/EricSteinberger/PokerRL) (MIT), OpenSpiel `deep_cfr`.

Idea: replace the tabular regret table with a network. Each CFR iteration runs K external-sampling traversals per player; sampled instantaneous regrets go into a reservoir-sampled advantage buffer; a value (advantage) net is retrained from scratch each iteration to predict linearly weighted average regret; regret matching on its outputs gives the next policy. A separate average-strategy net is trained from a strategy buffer.

Hyperparameters (FHP/HULH): 7-layer net with 98,948 parameters; card embeddings (rank, suit, card) summed; buffers 40M infosets per player; 4,000 SGD steps, batch 10,000, Adam lr 1e-3, grad norm clip 1 for FHP; 32,000 steps and batch 20,000 for HULH; 10,000 traversals per step worked best per sample.

Results: FHP exploitability 37 mbb/g vs NFSP 47; competitive with a 3.6M-cluster abstraction while needing 2-3 orders of magnitude fewer samples than a lossless abstraction. In heads-up limit: beats NFSP by 43 ± 2, loses to a 3.3x10^8-bucket CFR abstraction by 11 ± 2 (Table 1). Pitfall: reservoir sampling is essential; a sliding window makes exploitability rise again.

No published HUNL result against Slumbot (searched; none found). Budget verdict: not the main path. Its niche for us is a possible neural blueprint for 6-max postflop where tabular memory blows up, but nobody has shown that at Pluribus quality.

### 3.6 Single Deep CFR (Steinberger, 2019)

Source: [arXiv 1901.07621](https://arxiv.org/abs/1901.07621). Drops the average-strategy network. Keeps every iteration's value network (under 100k parameters each, so a few hundred nets are small: 120 MB in their 5-FHP run) and reproduces the linear average policy exactly by sampling iteration t with weight proportional to t at the start of a hand (trajectory sampling), or by computing it explicitly. Beats Deep CFR head to head in 5-flop hold'em with 95% CIs of about ±5.4 to ±6.5 mbb/g over 3M hands per point; strategy buffer needed ~25 GB per player. Reservoir-sampling the stored nets causes plateaus. Relevance: if we ever train a neural blueprint, use SD-CFR averaging, not a separate average net.

### 3.7 DREAM (Steinberger, Lerer, Brown; 2020)

Source: [arXiv 2006.10410](https://arxiv.org/abs/2006.10410); code [EricSteinberger/DREAM](https://github.com/EricSteinberger/DREAM) (MIT). Model-free: outcome sampling (one trajectory, no simulator resets) plus a learned Q-network history baseline for variance reduction, SD-CFR-style averaging. Tested on Leduc and flop hold'em, state of the art among model-free methods there. No HUNL. Only matters if we lacked a simulator; we have one, so external sampling (Deep CFR / tabular MCCFR) is the better fit.

### 3.8 ESCHER (McAleer, Farina, Lanctot, Sandholm; ICLR 2023)

Source: [arXiv 2206.04122](https://arxiv.org/abs/2206.04122). Removes importance sampling from sampled CFR by using a fixed sampling policy and a learned history value function; reports orders of magnitude lower regret-estimate variance than DREAM and beats DREAM and NFSP in dark chess over 90% of the time. Tested on Leduc, battleship, phantom tic-tac-toe, dark hex, dark chess. No poker beyond Leduc. Not relevant for our budget path.

### 3.9 NFSP (Heinrich & Silver, 2016)

Source: [arXiv 1603.01121](https://arxiv.org/abs/1603.01121). Fictitious play approximated with a DQN best-response net plus a supervised average-policy net. In limit hold'em it lost to the top 2014 ACPC agents (escabeche -52.1 ± 8.5, SmooCT -17.4 ± 9.0, Hyperborean -13.6 ± 9.2 mbb/h). Deep CFR beats it by 43 ± 2 in HULH. Historical baseline only.

### 3.10 RL-CFR (Li, Fang, Huang; ICML 2024)

Source: [arXiv 2403.04344](https://arxiv.org/abs/2403.04344) / [PMLR v235](https://proceedings.mlr.press/v235/li24t.html).

Idea: keep the ReBeL search, but let a small actor-critic network choose the action abstraction at each PBS. MDP state = 64-dim public state; action = 6-dim vector mapping to up to K bet sizes; reward = PBS value under the chosen abstraction minus PBS value under the default abstraction, both solved by CFR. Action and critic nets: 3 layers, ~2x10^4 parameters, hidden 128 and 96; 2x10^6 epochs of ~10 samples each; lr 1e-5, batch 1,024. Subgame CFR: DCFR with T = 250 in training and evaluation. PBS value net: 6 layers, width 1,536, ~18M parameters, input 2,678, output 2,652; 6x10^7 PBS samples; lr 1e-5, batch 512. Hardware: one server with 8 NVIDIA PH402 SKU 200 GPUs and an 80-core Xeon. Wall clock not reported. Action/critic training cost about 30% of the value net's.

Results: +84 ± 17 vs Slumbot over 250k+ hands; +64 ± 11 vs the ReBeL replication over 600k hands; the replication itself +18 ± 16 vs Slumbot. A finer fixed abstraction (9 sizes) was 23 mbb/hand worse than RL-CFR at 1.5x runtime. River-subgame exploitability 17 vs 20 mbb/hand.

Takeaway for us: action abstraction is worth tens of mbb/hand. The cheap version for our engine is to give the real-time search a richer, state-dependent menu of bet sizes (Supremus's 8-size first-action menu is a good start), and leave the learned selector as a possible paper contribution.

### 3.11 DecisionHoldem (2022) and OpenHoldem (2020-2021)

DecisionHoldem ([arXiv 2201.11580](https://arxiv.org/abs/2201.11580); code [AI-Decision/DecisionHoldem](https://github.com/AI-Decision/DecisionHoldem), AGPL-3.0): a Libratus-like blueprint with 169 preflop, 50,000 flop, 5,000 turn and 1,000 river buckets, actions F, C, 0.5P, P, 2P, 4P, A for the first two actions; about 200M iterations on 48 cores for 3-4 days, about 4,000 core hours. Real-time search for off-tree nodes (6,000 iterations preflop/flop, 10,000 turn) and safe depth-limited solving on the river (10,000 iterations). Claims more than 730 mbb/h vs Slumbot over about 20,000 hands, with no confidence interval. The sample is small and the margin is far above every peer-reviewed result, so treat it as unverified for the paper. Its abstraction sizes and core-hour budget are still a realistic template for our blueprint.

OpenHoldem ([arXiv 2012.06168](https://arxiv.org/abs/2012.06168)): open benchmark with four baseline agents evaluated against Slumbot over 100,000 hands with AIVAT: rule-based +57, CFR-based -20, DeepStack-like +103, RL (AlphaHoldem-like) +111 mbb/h.

### 3.12 LLM and 2025-2026 work

- GTO Wizard Benchmark ([arXiv 2603.23660](https://arxiv.org/abs/2603.23660)): zero-shot LLMs over 5,000 hands each. Best: GPT-5.3 Extra High at -16 ± 3 bb/100; Claude Opus 4.6 -20.4 ± 8.6; Gemini 3.1 Pro -30.8 ± 4.5; always-fold baseline -64.6 ± 3.3. GPT-4 was -136.2 ± 25.6.
- PokerSkill ([arXiv 2605.30094](https://arxiv.org/abs/2605.30094); [code](https://github.com/lbn187/PokerSkill)): expert-written rule library retrieved into the LLM prompt. GPT-5.5 XHigh -57 ± 21 mbb/hand vs GTO Wizard, Claude Opus 4.6 -80 ± 29, Claude Opus 4.7 -87 ± 64; Slumbot's own score vs GTO Wizard is -194 ± 41, so these beat Slumbot only indirectly. Inference costs about $0.30/hand (GPT-5.5) and $0.07/hand (Claude). A 150k-hand Slumbot-style match at $0.07/hand would be about $10,500 (arithmetic). Not viable.
- SpinGPT ([arXiv 2509.22387](https://arxiv.org/abs/2509.22387)): Llama-3.1-8B, LoRA SFT on 320k expert decisions then RL on 270k solver hands, about 10 A100 hours each stage; 13.4 ± 12.9 bb/100 vs Slumbot heads-up over 30,000 hands with a deep-stack heuristic. Cheap, but the CI nearly touches zero and it depends on solver data.
- ISO ([arXiv 2602.08041](https://arxiv.org/abs/2602.08041)): LLM training framework with 6-player NLHE experiments against LLM/RL baselines, no Slumbot or GTO Wizard numbers. Not relevant to strength.
- AlphaExploitem ([arXiv 2605.09150](https://arxiv.org/abs/2605.09150)): AlphaHoldem plus transformer history encoder for opponent exploitation; experiments on Kuhn and Leduc only (single A40, 12 h per Leduc seed).
- LUGL ([arXiv 2609.03660](https://arxiv.org/abs/2609.03660)): Deep CFR with LightGBM instead of a neural net; beats SD-CFR by about 100 mbb/h in 5-flop hold'em. Small games only.
- Deep (Predictive) Discounted CFR ([arXiv 2511.08174](https://arxiv.org/abs/2511.08174)): neural DCFR/PDCFR variants; no HUNL Slumbot results found in the text.

No 2023-2026 paper I found reports a neural method that beats the search-based agents (ReBeL, Supremus, GTO Wizard AI) against Slumbot with less compute than Modicum. Searches: arXiv for "no-limit hold'em" 2024-2026, "Deep CFR heads-up no-limit Slumbot", "six-player no-limit deep reinforcement learning 2024".

## 4. Cost per architecture for this team

Prices: Lambda on-demand per GPU hour: H100 SXM $3.99-4.29, A100 80GB $2.79 (8x), A100 40GB $1.99, A10 $1.29 ([lambda.ai/pricing](https://lambda.ai/pricing), read 2026-10-09). CPU: Pluribus's own figure of about $144 for 12,400 core hours at 2019 spot rates is the only sourced CPU price I have; current CPU spot prices are unverified here.

| Architecture | Published compute | Rough cost for us | Expected vs Slumbot | Verdict |
| --- | --- | --- | --- | --- |
| MCCFR blueprint only | 700 core h (Modicum) | ~$8 at 2019 Pluribus rate (arithmetic) | -11 ± 8 (Modicum blueprint) | baseline only |
| Blueprint + depth-limited search (Modicum/Pluribus) | 700-12,400 core h | ~$8-144 (arithmetic, 2019 rate) | +11 ± 9 (Modicum) | must do first |
| + river/turn CFV nets (DeepStack/Supremus) | GPU hours not reported | measure with a pilot | -63 to +176 depending on data and search iterations | should, if pilot is cheap |
| AlphaHoldem PPO | 580 GPU h + 4,000 CPU h | ~$1,150 GPU (arithmetic) | +111.56 ± 16.06 | could, as ablation |
| ReBeL full | 720 V100s, duration unverified | far over budget | +45 ± 5 | no |
| ReBeL small replication | 1 server, 8 GPUs, 60M samples | duration unverified | +18 ± 16 | no |
| RL-CFR on top of ReBeL | same server | duration unverified | +84 ± 17 | idea only (action menu) |
| Student of Games | TPU fleet | far over budget | +7 ± 3 | no |
| Deep CFR / SD-CFR / DREAM / ESCHER | small games only | n/a | no HUNL result | no |
| LLM agents | inference $0.07-0.30/hand | thousands for a 150k match | about Slumbot level at best | no |

## 5. Recommendation and plan

Recommendation: spend almost nothing on neural self-play. Build the Pluribus/Modicum stack on the C++ trainer at `/Users/rg/Downloads/gpo-wt/blueprint/blueprint`, and use GPU money only for a value network that makes the search deeper or faster, after a timed pilot.

Ordered steps:

1. Blueprint at DecisionHoldem/Modicum scale (must). Potential-aware flop/turn buckets (the README notes this as the next step in `build_street()`), around 50k flop / 5k turn / 1k river buckets as DecisionHoldem used, 5-7 bet sizes, Linear CFR discounting plus negative-regret pruning as Pluribus did. Budget: a few thousand core hours.
2. Depth-limited subgame solving with continuation strategies (must). From Modicum: at the depth limit each player picks one of k strategies for the rest of the game; Modicum used k = 4: blueprint, blueprint biased toward folding (fold probability x10 then renormalize), toward calling, and toward raising. On the turn and river solve to the end of the game. Use safe/nested solving for off-tree opponent bets (add the actual bet to the subgame), so the agent never needs action translation after preflop. Modicum's leaf-value DNN alternative was tiny: 34 input features, 2 hidden layers of 64, 4 outputs, trained on 180M examples per player, Huber loss 0.03; it lost only a little (-11 ± 10 vs BabyTartanian8 instead of +6 ± 5) and runs on CPU.
3. Solver speed (must). Supremus-style DCFR+ (average weight max(0, t - 100)), and simultaneous updates when value nets sit at leaves. OpenHoldem shows 500 vs 1,000 re-solve iterations moved a DeepStack-like agent from -224 to +93 vs Slumbot, so iteration count per decision matters as much as the network.
4. Richer search-time action menu (should). Supremus's first-action menu (0.33, 0.5, 0.75, 1, 1.25, 2 pot, all-in) and RL-CFR's finding that state-dependent sizes are worth tens of mbb/hand.
5. River value net (should, GPU). Generate random river PBSs, solve exactly on CPU, train an MLP mapping (board, both ranges, pot/stack) to per-hand counterfactual values (ReBeL/RL-CFR shape: 6 x 1,536). Supremus used 50M river samples. Pilot 100k samples first, time it, and extrapolate before spending.
6. Evaluation (must). AIVAT; 150k+ hands vs the Slumbot API; request a GTO Wizard Benchmark key; LBR with fold/call actions as the exploitability proxy; self-play vs the blueprint. Report ± with one stated convention.
7. 6-max (later). Stay with Pluribus's recipe: blueprint MCCFR for 6 players, search only from the flop onward or after the first few actions, k = 4 continuation strategies. No neural successor has a 6-max result to copy.

## 6. Pitfalls collected from the sources

- Value nets trained on uniformly random beliefs fail (ReBeL TEH result); sample PBSs from play, or from DeepStack's hand-crafted range generator.
- Too few value-net training samples is the main failure mode of DeepStack replications (OpenHoldem Figs. 8-9; Supremus vs DeepStack reimplementation; ReBeL replication in RL-CFR).
- Deep CFR needs reservoir buffers; SD-CFR needs to keep all iteration nets.
- AlphaHoldem-style agents are cheap at inference but have no search and no guarantee; LBR is a weak test for them.
- Slumbot can be beaten by a rule-based bot (+57); do not oversell a Slumbot win.
- Student of Games' coarse single-bet-size abstraction is a likely reason its Slumbot margin is small (my inference, not the authors').
- Different papers use different ± conventions and different hand counts; DecisionHoldem's 730 mbb/h has no CI.

## 7. Links

Papers: [ReBeL](https://arxiv.org/abs/2007.13544) · [Student of Games](https://arxiv.org/abs/2112.03178) · [Supremus](https://arxiv.org/abs/2007.10442) · [AlphaHoldem](https://ojs.aaai.org/index.php/AAAI/article/view/20394) · [Deep CFR](https://arxiv.org/abs/1811.00164) · [SD-CFR](https://arxiv.org/abs/1901.07621) · [DREAM](https://arxiv.org/abs/2006.10410) · [ESCHER](https://arxiv.org/abs/2206.04122) · [NFSP](https://arxiv.org/abs/1603.01121) · [Modicum / depth-limited solving](https://arxiv.org/abs/1805.08195) · [RL-CFR](https://arxiv.org/abs/2403.04344) · [DecisionHoldem](https://arxiv.org/abs/2201.11580) · [OpenHoldem](https://arxiv.org/abs/2012.06168) · [GTO Wizard Benchmark](https://arxiv.org/abs/2603.23660) · [PokerSkill](https://arxiv.org/abs/2605.30094) · [SpinGPT](https://arxiv.org/abs/2509.22387) · [ISO](https://arxiv.org/abs/2602.08041) · [AlphaExploitem](https://arxiv.org/abs/2605.09150) · [LUGL](https://arxiv.org/abs/2609.03660) · [Deep PDCFR](https://arxiv.org/abs/2511.08174) · [Pluribus](https://www.science.org/doi/10.1126/science.aay2400)

Code: [facebookresearch/rebel](https://github.com/facebookresearch/rebel) (Liar's Dice only) · [PokerRL](https://github.com/EricSteinberger/PokerRL) · [Deep-CFR](https://github.com/EricSteinberger/Deep-CFR) · [DREAM](https://github.com/EricSteinberger/DREAM) · [OpenSpiel](https://github.com/google-deepmind/open_spiel) · [DecisionHoldem](https://github.com/AI-Decision/DecisionHoldem) · [AlphaNLHoldem](https://github.com/bupticybee/AlphaNLHoldem) · [slumbot2019](https://github.com/ericgjackson/slumbot2019) · [GTO Wizard researcher client](https://github.com/gtowizard-ai/researcher-api-client) · [TexasSolver](https://github.com/bupticybee/TexasSolver) · [postflop-solver](https://github.com/b-inary/postflop-solver) · [RLCard](https://github.com/datamllab/rlcard) · [PokerSkill](https://github.com/lbn187/PokerSkill)
