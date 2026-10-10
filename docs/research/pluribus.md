# Pluribus (Brown and Sandholm, Science 2019) and Modicum (NeurIPS 2018): implementation notes

Topic key: `pluribus`. Written 2026-10-09 for the gto-poker-overlay swarm.

Every number below carries the URL it came from. Where a figure is not in a primary source I say "unverified". Paraphrase throughout; no long quotes.

## Sources read in full

- [P] Main paper: N. Brown, T. Sandholm, "Superhuman AI for multiplayer poker", Science 365(6456):885-890, 2019, DOI 10.1126/science.aay2400. PDF: https://noambrown.com/papers/19-Science-Superhuman.pdf
- [S] Supplementary materials (10 pages, includes Algorithm 1 and Algorithm 2 pseudocode, Table S1): https://noambrown.com/papers/19-Science-Superhuman_Supp.pdf (the science.org copy at https://www.science.org/doi/suppl/10.1126/science.aay2400/suppl_file/aay2400-brown-sm.pdf returns 403 to scripts)
- [D] N. Brown, T. Sandholm, B. Amos, "Depth-Limited Solving for Imperfect-Information Games", NeurIPS 2018 (Modicum): https://arxiv.org/abs/1805.08195 (PDF https://arxiv.org/pdf/1805.08195)
- [H] S. Ganzfried, T. Sandholm, "Action Translation in Extensive-Form Games with Large Action Spaces: Axioms, Paradoxes, and the Pseudo-Harmonic Mapping", IJCAI 2013: https://www.ijcai.org/Proceedings/13/Papers/028.pdf
- [L] N. Brown, T. Sandholm, "Solving Imperfect-Information Games via Discounted Regret Minimization", AAAI 2019 (Linear CFR / DCFR): https://arxiv.org/pdf/1809.04040
- [A] N. Burch et al., "AIVAT: A New Variance Reduction Technique for Agent Evaluation in Imperfect Information Games": https://arxiv.org/abs/1612.06915
- [B] Meta AI blog post on Pluribus: https://ai.meta.com/blog/pluribus-first-ai-to-beat-pros-in-6-player-poker/ (secondary; used only to flag discrepancies)
- [K] PHH paper (hosts all 10,000 Pluribus hands in an open format): https://arxiv.org/abs/2312.11753 and https://github.com/uoftcprg/phh-std

Code was not released: the authors say releasing it carried too much risk because poker is played commercially, and they put pseudocode in the supplement instead [P, Acknowledgments section]. So everything below is reconstructed from the text plus pseudocode.

---

## 1. Game setup Pluribus used

- Six-player NLHE, each player starts every hand with $10,000, blinds $50/$100, so 100 BB deep, reset every hand so hands are i.i.d. samples [S, "Rules" section].
- Minimum opening raise $100; later raises at least the size of the previous raise increment [S].
- Seats rotate each hand [S].

These are the same chip units the local C++ trainer uses (BB = 100, 10,000 stacks), which matters because Pluribus's pruning constants are in these units (section 3).

---

## 2. Abstraction used for the blueprint

### Action abstraction

- Between 1 and 14 raise sizes depending on the decision point, all expressed as fractions of the pot [P p.2; S "Further details of the abstraction algorithm"].
- Sizes were picked by hand, by looking at which sizes earlier versions of Pluribus used with meaningful probability [S].
- Preflop is the finest, because Pluribus usually plays the blueprint directly there; flop is coarser [S].
- Turn and river: the first raise of the round may be 0.5x pot, 1x pot, or all-in (at most three options); any later raise in the round may only be 1x pot or all-in (at most two) [S].
- Fold and call are always included when legal [S].
- Total blueprint action sequences: 664,845,654, of which 413,507,309 were ever reached during training [S].
- The exact preflop size list is not published (unverified).

### Information (card) abstraction

- Preflop: lossless, 169 strategically distinct hands [S].
- Flop, turn, river: lossy, 200 buckets per round, built with k-means on domain-specific features, citing Johanson, Burch, Valenzano, Bowling AAMAS 2013 ("Evaluating state-space abstractions") [S, ref 26].
- For scale, lossless abstraction would need 169 / 1,286,792 / 55,190,538 / 2,428,287,420 classes on preflop / flop / turn / river [S].
- On the flop there are on average 6,434 real infosets per abstract bucket [S], which is the motivation for pruning as a quasi-refinement of abstraction (section 3).
- Imperfect recall: each round's bucket is computed independently (implied by "each information situation is put into one of 200 buckets" per round; the paper does not spell out recall, so treat "imperfect recall" as my reading, consistent with the cited Johanson 2013 work).

### Why the blueprint is so coarse

The blueprint size was chosen so live play fits in a 128 GB machine with a compressed blueprint in memory [P p.3-4]. Postflop the blueprint is never played directly, only used for leaf values (section 5), so 200 buckets was enough for that job. This choice does not transfer to a heads-up bot that wants a strong blueprint on its own: Modicum used 30,000 postflop buckets for HUNL [D, Appendix A].

---

## 3. Blueprint training: Linear MCCFR with negative-regret pruning

Base algorithm: external-sampling MCCFR [S]. Traverser explores all its own actions, samples opponents' actions from current regret-matching strategy and samples chance [S Algorithm 1]. Traversal is depth-first [P Fig. 2 caption].

### Schedule (all wall-clock based on the 64-core box)

| Parameter | Pluribus value | Source |
| --- | --- | --- |
| Linear CFR period | first 400 minutes | [S] |
| Discount interval | every 10 minutes | [S] |
| Discount factor | multiply regrets and average-strategy counters by (T/10)/(T/10+1), T = minutes elapsed | [S] |
| Pruning starts | after 200 minutes | [S Alg. 1 comment] |
| Pruning probability | 95% of iterations pruned, 5% full | [S] |
| Prune threshold C | regret below -300,000,000 | [S Alg. 1] |
| Regret floor | -310,000,000 | [S] |
| Regret storage | 4-byte ints (not 8-byte doubles) | [S] |
| Strategy interval (preflop average update) | every 10,000 iterations | [S Alg. 1 comment] |
| Preflop average strategy stored | after the first 800 minutes | [S] |
| Postflop snapshots | current strategy saved every 200 minutes after minute 800, averaged offline | [S] |
| Total run | 8 days on 64 cores, 12,400 core hours | [P p.3] |
| Iteration count | not published (unverified) | |

Why discounting stops after 400 minutes: the multiply pass over the whole table costs more time than it saves later on [P p.3; S].

Linear CFR (from [L]): iteration t's regret and average-strategy contribution weighted by t; equivalently, multiply accumulated values by t/(t+1) each step. After T iterations, iteration 1 has weight 2/(T^2+T) instead of 1/T. [L] reports that the LCFR ideas carry over to MCCFR when applied in periods (they used periods of 10^7 nodes touched, multiplying by n/(n+1) after period n), while CFR+ ideas (regret floor at zero, linear averaging) do not help MCCFR. Pluribus authors estimate Linear MCCFR sped up convergence about 3x [S "Equilibrium finding"].

### Pruning details (the parts that are easy to get wrong)

- The prune/no-prune coin is flipped once per iteration, not per action. Cheaper because fewer RNG calls [S].
- In a pruned iteration, a traverser action is skipped when its regret is below C, except (a) actions on the final betting round and (b) actions that lead straight to a terminal node [S]. Rationale: on the river pruning gives no abstraction-refinement benefit, and terminal payoffs are cheap anyway [S].
- Skipped actions get no regret update in that iteration [S Alg. 1, TRAVERSE-MCCFR-P lines 21-25].
- The floor (-310M) sits only 10M below the threshold (-300M). An action that was pruned can climb back above C with a modest amount of positive regret gathered in the 5% unpruned iterations. The floor also prevents int32 overflow [S].
- Claimed effect of Pluribus's pruning changes vs. Libratus/BabyTartanian8 style pruning: about 2x speedup [S].
- The supplement argues pruning acts like finer abstraction: hands that would be folded get traversed only 5% as often, so a bucket's strategy is shaped mostly by the hands that actually reach it in good play [S]. In 6-max this matters more because most hands fold preflop [S].

### Pseudocode in my own words (Algorithm 1 restated)

```
init: regrets R[I][a] = 0 for every infoset (lazily allocated past preflop)
      phi[I][a] = 0 only for preflop infosets (action counters)
for t = 1..T:
  for each player i:
    if t % 10000 == 0: UPDATE_STRATEGY(root, i)          # preflop average only
    if t > PRUNE_START and rand() >= 0.05: TRAVERSE_PRUNED(root, i)
    else:                                  TRAVERSE(root, i)
  if t < LCFR_END and t % DISCOUNT_INTERVAL == 0:
    d = (t/DI) / (t/DI + 1); multiply every R and phi by d

UPDATE_STRATEGY(h, i):    # walks the tree, one sample per node
  stop at terminal, if i folded, or once past preflop
  chance: sample one outcome
  i acts: sigma = regret_match(R[I]); sample a ~ sigma; phi[I][a] += 1; recurse on a
  other player acts: recurse on EVERY action (so every preflop infoset of i is visited)

TRAVERSE(h, i):   # plain external sampling
  terminal -> payoff to i
  i not in hand -> skip ahead (other players' actions irrelevant to i)
  chance -> sample
  i acts: sigma = RM(R[I]); v_a = TRAVERSE(child a) for all a; v = sum sigma_a v_a
          R[I][a] += v_a - v; return v
  other acts: sample a ~ RM(R[I_other]); recurse

TRAVERSE_PRUNED(h, i): same, but at i's node skip any a with R[I][a] <= C
          unless a is on the last round or a ends the hand;
          only explored actions get a regret update
```

Note the average strategy in Pluribus is not the classic reach-weighted sum. It is a count of sampled actions, updated every 10,000 iterations by a dedicated pass that branches over all opponent actions and samples one action at each of the player's own infosets. Postflop there is no running average at all: the blueprint after preflop is the average of current-strategy snapshots taken every 200 minutes [S]. Snapshot averaging instead of an in-memory average cut memory by nearly half and also made each iteration cheaper [S]. The supplement points out that in 6-player games CFR's average has no convergence guarantee anyway, so there is no theoretical reason to prefer it over the current strategy [S].

### Memory layout

- Regrets: int32 [S].
- Lazy allocation: memory for an action sequence's regrets is created the first time the sequence is reached (preflop allocated up front). Cut memory by more than 2x [S].
- Blueprint training used under 0.5 TB of a 3 TB node [S "Hardware usage"]; main text says "less than 512 GB" [P p.3].
- Continuation strategies for search are stored compressed: one sampled action per abstract infoset, stored with the fewest bits that can index the action set [S "Leaf node values"]. Modicum did the same idea at one byte per action probability, and notes the ceil(log2|A|) bits option [D Appendix A].

### Pitfall I noticed in the pseudocode

If every action at a traverser node is below C (possible because only explored actions get updated), TRAVERSE_PRUNED returns v = 0 with nothing explored, and if all regrets are negative the regret-matching strategy is uniform, so pruned actions carry probability mass that is silently dropped from v. In exact CFR not all actions can drift that negative together, but with pruning plus sampling it can happen. Cheap guard: never prune the action with the highest regret at a node.

---

## 4. Compute and hardware

| Item | Value | Source |
| --- | --- | --- |
| Blueprint compute | 8 days, 64-core server, 12,400 core hours | [P p.3] |
| Blueprint hardware | one Bridges (PSC) large-memory node, 4 x 16-core Intel Xeon E5-8860 v3, 3 TB RAM available, < 0.5 TB used | [S] |
| Blueprint cost estimate | about $144 at 2019 cloud spot rates | [P p.3] |
| Same, blog wording | "less than $150" | [B] |
| Implied 2019 spot rate | 144 / 12,400 = about $0.0116 per core hour (my arithmetic from [P]) | [P] |
| Live play hardware | one node, 2 x 14-core Intel Haswell E5-2695 v3 (28 cores), 128 GB; Pluribus used < 128 GB | [P p.5; S] |
| GPUs | none, at any point | [S] |
| Search time per subgame | 1 to 33 seconds | [P p.5] |
| Average pace | about 20 s per hand in 6-player self-play, roughly twice as fast as human pros | [P p.5] |
| Current cloud prices for a rerun | unverified (not in any primary source I read) | |

For comparison numbers the papers give: Libratus used 100 CPUs in live play [P p.5]; AlphaGo used 1920 CPUs and 280 GPUs in the Lee Sedol match [P p.5]. Modicum (HUNL): 700 core hours and 16 GB RAM to build, plays in real time on a 4-core CPU at about 20 s per hand [D section 6.2]. Baby Tartanian8 about 2 million core hours and 18 TB RAM; Slumbot about 250,000 core hours and 2 TB [D section 6.2]. DeepStack over 1,000,000 core hours [D section 7].

---

## 5. Real-time search

### When search runs

- Preflop: play the blueprint. Search only if an opponent's raise is more than $100 away from every blueprint size AND at most four players remain. Otherwise map the bet with the randomized pseudo-harmonic mapping and keep playing the blueprint as if the mapped size had been used [S "Further details of the real-time search algorithm"].
- Flop, turn, river: search always [S].

### Subgame construction

- Root: not a single node but a chance node over all histories in the root public state, each weighted by its normalized reach probability under the current profile sigma (blueprint if no search has happened yet this hand, otherwise the last search output) [S "Structure of imperfect-information subgames"; P Fig. 4 caption].
- Beliefs: for every player (Pluribus included) keep a distribution over the 1,326 hole-card pairs, starting uniform, updated with Bayes' rule using sigma [S].
- The root is always the start of the current betting round. It only moves when a new round starts [S].
- Depth limit [S]:
  - preflop search: to the end of preflop (leaves at the flop chance node)
  - flop search when more than two players started the round: leaves at the start of the turn or right after the second raise, whichever comes first
  - every other case (including any heads-up flop, and all turn/river spots): solve to the end of the game
- Information abstraction inside search: lossless on the current round; 500 buckets per later round, built per flop with a potential-aware, earth mover's distance clustering (Brown, Ganzfried, Sandholm AAMAS 2015 style) [S].
- Action abstraction inside search: 1 to 6 raise sizes [S abstraction section], "typically no more than five" [S off-tree section]; 100 to 2,000 player-action sequences per subgame [S].

### Leaf values: k = 4 continuation strategies

At each leaf, every player still in the hand picks (simultaneously, without seeing the others) one of 4 continuation strategies, or any mixture, and the pick must be the same across all leaves in the same infoset [S; P Fig. 4]. The pick is just one more action in the subgame and is solved by the same MCCFR. The four strategies [S]:

1. blueprint unchanged
2. blueprint with fold probability multiplied by 5, renormalized
3. blueprint with call probability multiplied by 5, renormalized
4. blueprint with every raise probability multiplied by 5, renormalized

Leaf value = Monte Carlo rollout of the rest of the hand with each player following its chosen continuation strategy [P Fig. 4 caption]. Number of rollouts per leaf in Pluribus: unverified (Modicum used 3 [D Appendix A]).

If a leaf's history is not in the blueprint tree (because an opponent made an off-tree bet earlier), the leaf is mapped to the nearest blueprint node using the deterministic pseudo-harmonic mapping [S].

Change from Modicum: in Modicum only the opponent chose among continuation strategies and the searcher was stuck with the blueprint. That is sound in two-player zero-sum games but makes the searcher too defensive. Pluribus lets the searcher choose too, which is still sound in 2p0s and was described as more effective and simpler than Modicum's opponent-penalty fix [S footnote 1; S "Depth-limited search"].

### Solver inside search

- Large subgames or early in the hand: Monte Carlo Linear CFR, same as blueprint [P p.5; S].
- Otherwise: vector-based Linear CFR that samples one set of public board cards per thread, citing Johanson, Waugh, Bowling, Zinkevich IJCAI 2011 [S, ref 42].
- Pluribus plays the final iteration's strategy, not the average, because the final iterate avoids residual weight on bad actions; the belief update (sigma) uses the weighted average [S].
- Iteration counts or time budget per search beyond the 1-33 s figure: unverified.

### Off-tree opponent actions and nested search (Algorithm 2)

My restatement:

```
root = start-of-hand public state; sigma = blueprint
on opponent action a at infoset I:
  if a not in current subgame abstraction:
     add a as a legal action at every node of I's public state
     sigma = SEARCH(root)                  # re-solve from start of round
  advance I; if new round: root = current public state; sigma = SEARCH(root)
on our turn:
  sample a ~ sigma(I); mark (I, a) frozen for our real hand only; advance
```

Freezing rule: only the action probabilities Pluribus already used with its actual hand are frozen when re-solving. Its probabilities for other hands are free, and opponent probabilities are never frozen, so the re-solve can assume opponents changed strategy anywhere earlier in the round [S]. Without freezing, a re-solve could put zero weight on the action Pluribus actually took and produce nonsense below it [S].

### Unsafe vs safe search: what they chose and why

- Pluribus uses unsafe search: it assumes opponents played the strategy Pluribus computed for them [S].
- Unsafe search has no guarantee even in 2p0s, can be badly exploitable in some cases; safe alternatives (Burch et al. 2014, Moravcik et al. 2016, Brown and Sandholm 2017) exist but tend to lose head-to-head against careful unsafe search in practice [S].
- Speed: unsafe search can skip hands with zero reach. In 6-max most hands are folded at the first decision, so search is about 4x faster [S].
- Mitigation: always re-solve from the start of the betting round with a high-branching chance node at the root; prior 2p0s experiments (Brown and Sandholm NeurIPS 2017) show unsafe search with such roots usually has low exploitability [S].
- Modicum, by contrast, used unsafe nested solving for preflop, flop, and the first turn subgame, then safe Reach subgame solving after that [D Appendix A].

### Multiplayer handling

There is no special multiplayer theory. CFR has no Nash convergence guarantee with more than two players, and Pluribus just uses the same self-play plus search, judged empirically [P pp.1-3]. Specific choices for 6-max: lazy regret allocation for the many unreached sequences [S]; pruning matters more because most hands fold [S]; shorter flop depth limit when 3+ players are in [S]; unsafe search speedup from zero-reach hands [S]. Pluribus does not adapt to opponents and does not know who they are, so copies cannot collude [P p.5].

### Pseudo-harmonic mapping (needed for preflop off-tree bets and leaf mapping)

All sizes as pot fractions. For an opponent bet x between two abstract sizes A < x < B, the randomized mapping picks A with probability

    f(x) = ((B - x)(1 + A)) / ((B - A)(1 + x))

and B otherwise. The deterministic version maps to A when x is below the median x* = (A + B + 2AB) / (A + B + 2), else B [H section 5]. It comes from the analytic solution of a clairvoyance toy game where the caller calls a bet x with probability 1/(1+x) [H]. Pluribus calls the randomized version the lowest-exploitability action translation known [S].

---

## 6. Evaluation

### Metric and variance reduction

- mbb/game, one-tailed t-test at 95% confidence on whether Pluribus is profitable, hands treated as i.i.d. [P p.5; S "Statistical analysis"].
- AIVAT modified for more than two players. Unbiased; reduced variance by about 9x in this setting [S "Variance reduction via AIVAT"]. AIVAT paper abstract says it can cut the hands needed by more than 10x in no-limit poker [A].
- How the estimator works (my summary of [S]): at each Pluribus decision and each chance node, replace the realized value with (realized value - baseline for the action taken) + (strategy-weighted baseline over all actions). Since Pluribus knows its own full range strategy, it also averages over every hand it could hold. Human decision nodes cannot be corrected because the human's action distribution is unknown.
- 1H+5AI extra trick: replay each hand with a Pluribus "Control" copy in the human's seat and subtract the Control's result (zero in expectation). Hands where both human and Control fold preflop after an identical action sequence count as zero [S].
- Each Pluribus copy runs AIVAT on its own; human win rate is the negative of the average AI win rate [S].

### 5 humans + 1 AI

- 13 pros, each with more than $1M in poker winnings; 10,000 hands over 12 days; five players per day, chosen by availability [P p.5; S].
- Aliases kept fixed so players could track each other; humans could play 4 tables, later raised to 6; about 180 hands/hour at 4 tables; sessions 3-8 hours, typically 4 [S].
- $50,000 pool; pay per hand $(1 + 0.005X) where X is the player's variance-reduced mbb/game clipped to [-120, 120], so $0.40 to $1.60 per hand [S].
- Result: 47.7 mbb/game, standard error 25.0, p = 0.028 [S]; main text rounds to 48 and 25 [P p.5]. Including 13 extra hands: 50.9 mbb/game [S].
- The blog says p = 0.021 and "5 big blinds per 100 hands" [B]; the paper's own figure is p = 0.028. Cite the paper.
- Per-player results with only a modest variance reduction are in Table S1; standard errors from 85.8 to 515.4 mbb/game, so no individual conclusions are possible [S Table S1].

### 1 human + 5 AI

- Chris Ferguson and Darren Elias, 5,000 hands each, 10,000 total, played from home, up to 4 tables, no time limit [S].
- $2,000 each for participating plus $2,000 to whoever did better [P p.5].
- Aggregate: Pluribus +32.7 mbb/game, standard error 14.9, p = 0.014 [S]; main text rounds to 32 and 15 [P].
- Elias: -40.2 mbb/game, SE 21.9, p = 0.033. Ferguson: -25.2, SE 20.2, p = 0.106 [S] (main text says 0.107 [P]).
- The blog also lists Linus Loeliger at -0.5 bb/100 in this format [B]; he is not in the paper's 1H+5AI results. Treat as unverified relative to the paper.

### Hand histories

Data File S1 in the Science supplement holds the hands [S cover page]. All 10,000 Pluribus hands are converted into the open PHH format in the uoftcprg dataset [K]. That gives us free, real 6-max data to sanity-check our engine's parser, replay logic, and AIVAT implementation.

### Strategy observations reported

Pluribus discarded limping except from the small blind, and donk-bets far more often than human pros [P p.5].

---

## 7. Ablation magnitudes the authors give (estimates, not experiments)

| Component | Claimed effect | Source |
| --- | --- | --- |
| Depth-limited search | cuts compute and memory by probably at least 5 orders of magnitude for 6-max | [S] |
| Linear MCCFR vs plain MCCFR | about 3x faster convergence | [S] |
| Pluribus-style pruning vs earlier pruning | about 2x speedup | [S] |
| Lazy regret allocation | more than 2x memory reduction | [S] |
| Snapshot averaging postflop | nearly halves memory | [S] |
| Unsafe vs safe search | about 4x faster | [S] |
| AIVAT | about 9x variance reduction | [S] |

---

## 8. Modicum / Depth-Limited Solving (NeurIPS 2018) in detail

### Core idea

In imperfect-information games a leaf has no single value because the opponent can adapt below it. Give the opponent (in Modicum, only the opponent) a final choice at each leaf infoset among N continuation strategies, each producing its own leaf value. The choice must be the same across states the opponent cannot tell apart. With enough strategies (all pure strategies) any subgame solution is part of a Nash equilibrium; with few, it is an approximation [D section 4, Proposition 1]. Because the choice is made per leaf infoset, 10 strategies across 100 leaf infosets already give the opponent 10^100 combinations [D section 4].

### Building the continuation set

- Bias approach: multiply the blueprint's fold (or call, or raise) probabilities by a factor and renormalize. Modicum used factor 10 on the flop with 4 strategies (blueprint, fold-biased, call/check-biased, bet/raise-biased) [D section 6.2]. Pluribus used factor 5 [S].
- Self-generative approach: start with the blueprint; solve the depth-limited subgame; compute an approximate opponent best response to that solution (an MDP, cheap); add it; repeat. Modicum used 10 strategies built this way at the end of preflop [D sections 4 and 6.2].
- Correction: if a generated strategy beats the blueprint's own value against the blueprint, shift its leaf values down by the gap so the searcher is not made overly cautious [D section 4].

### Leaf value storage

Table (preflop leaves: 240 MB for 10 values per state in Modicum), rollouts (flop leaves: sample rollouts of the stored biased strategies, 3 rollouts per leaf was best for their memory speed), or a small network. Their value net: 34-float input, 4-float output, 2 hidden layers of 64 units, trained on 180 million examples per player with Huber loss and Adam, Huber loss 0.03; using it instead of rollouts lost 11 +/- 10 mbb/g vs Baby Tartanian8 compared with +6 for rollouts [D section 6.2, Appendix A].

### Modicum build

- Blueprint: 169 preflop classes, 30,000 buckets per postflop round, strategy 5 GB as 4-byte floats, MCCFR for 700 core hours [D section 6.2, Appendix A].
- Search: depth-limited MCCFR on preflop and flop, each subgame to the end of the current round; from the turn on, solve to the end of the game with an improved CFR+ [D section 6.2].
- Preflop: any newly seen opponent size is added, whole preflop re-solved and cached; time spent is negligible on average [D Appendix A]. MCCFR budget 30 s for preflop subgames, 10-30 s on flop depending on pot [D Appendix A].
- CFR+ tweaks in turn/river solving: ignore first 50% of iterations in the average; discount regrets by sqrt(T)/(sqrt(T)+1) for the first 30 iterations, about 3x lower exploitability; 150-1,000 iterations on the turn, 300-2,000 on the river [D Appendix A].
- Nested solving: unsafe on preflop, flop, and first turn subgame; safe Reach subgame solving for later subgames, with alternative payoffs from the previously solved subgame [D Appendix A].

### Modicum results (AIVAT, 95% CI, mbb/g) [D Table 1]

| Agent | vs Baby Tartanian8 | vs Slumbot |
| --- | --- | --- |
| Blueprint only | -57 +/- 13 | -11 +/- 8 |
| Naive depth-limited (single leaf value) | -10 +/- 8 | -1 +/- 15 |
| Depth-limited solving | +6 +/- 5 | +11 +/- 9 |

Reference points from the same paper: Baby Tartanian8 beat Slumbot by 36 +/- 12; Libratus beat Baby Tartanian8 by 63 +/- 28 and top humans by 147 +/- 77 [D section 6.2].

Exploitability experiment in no-limit flop hold'em: with only 1 leaf value, randomized pseudo-harmonic translation beats depth-limited solving; with more values DLS wins, and at 16 values it is close to having had the off-tree size in the abstraction [D section 6.1, Fig. 2]. Solving to the end of the game would have been about 10,000x larger [D section 6.1].

### Multi-valued states vs DeepStack-style belief values

Multi-valued leaves need one function call per leaf no matter how many solver iterations, and the value function input is tiny (34 floats) versus 2,000+ inputs and 1,000+ outputs for a belief-state value net in HUNL. The cost is a dependency on a decent blueprint, and solve cost grows linearly with the number of values per state [D section 7].

---

## 9. What this means for our heads-up-first build

Facts that change the plan:

1. In heads-up, Pluribus's own rules would solve flop, turn, and river subgames to the end of the game (the shortened flop depth limit only applies with 3+ players at the start of the flop) [S]. Only preflop is played from the blueprint, with search only for raises more than $100 off-tree. So a Pluribus-faithful HU bot needs an end-of-game solver from the flop down with a coarse future-round abstraction (Pluribus: 500 buckets per later round) running in tens of seconds on a 28-core box [S; P]. On a laptop that is likely too slow on the flop; Modicum's split (depth-limited flop to the end of the flop with 4 biased rollouts, then full solving turn/river) fits 4 cores [D].
2. Pluribus's 200-bucket blueprint is a 6-max memory compromise. For HU, Modicum's 30,000 postflop buckets in a 5 GB strategy after 700 core hours is the better reference [D]. The local trainer's 50-bucket "small" preset is far below both.
3. The training recipe in the local C++ trainer at /Users/rg/Downloads/gpo-wt/blueprint/blueprint/src/mccfr.h already matches Algorithm 1 on: external sampling, per-iteration prune coin with 95%, threshold and floor in the same chip units, no pruning on the last street or on actions ending the hand, int32 regrets, periodic multiply-by-d/(d+1) Linear CFR window. Differences from Pluribus worth knowing:
   - It keeps a double-precision reach-style running average at every infoset (12 bytes per slot). Pluribus kept an average only preflop (sampled-action counts every 10,000 iterations) and averaged current-strategy snapshots postflop, which nearly halves memory [S]. Doing the same lets the HU abstraction grow.
   - Schedules are in iterations, Pluribus's in minutes. Convert by measured iterations per minute on the rented box rather than copying "200 minutes".
   - All-actions-pruned edge case (section 3 pitfall) applies to it as well.
4. The 4 continuation strategies can be stored as one sampled action per abstract infoset [S], so they cost little memory once the blueprint exists. Build them straight from the exported blueprint.
5. Budget anchor: Pluribus's whole 6-max blueprint was 12,400 core hours [P]; Modicum's HU blueprint 700 core hours [D]. A $500-1000 budget is enough for several HU blueprint runs if current spot prices are anywhere near 2019's implied $0.0116 per core hour; current prices are unverified, so check before renting. Large-memory nodes (Pluribus needed up to 0.5 TB) price differently from compute nodes.
6. Evaluation without pros: AIVAT plus duplicate, and the Modicum-style ladder (blueprint only vs naive leaf values vs 4 continuation strategies) is a clean, cheap ablation for the paper [D Table 1]. The 10,000 Pluribus hands in PHH [K] are a free test corpus for 6-max parsing and AIVAT bookkeeping.

## 10. Open questions the sources do not answer

- Total iteration count of the blueprint run (unverified).
- Exact preflop and flop bet-size lists (unverified).
- Features used for the 200-bucket k-means (only "domain-specific features" with a citation) [S].
- Number of rollouts per leaf and CFR iterations per search in Pluribus (unverified).
- How the per-flop 500-bucket abstractions for search were stored or computed online (unverified).
